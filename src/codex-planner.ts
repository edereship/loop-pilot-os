import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { CommandRunner, PauseMeta, RunOptions } from "./types.js";
import { parseResetsTime } from "./agent-runner.js";

const STDERR_TAIL_MAX = 1000;
const RATE_LIMIT_MIN_WAIT_MS = 30_000;
const RATE_LIMIT_BUFFER_MS = 60_000;

// On Windows, npm-installed CLI tools are wrapped in .cmd shims that cannot
// be resolved by Node's spawn() with shell:false. Use the explicit .cmd form.
const CODEX_COMMAND = process.platform === "win32" ? "codex.cmd" : "codex";

// Allowlist of environment variables forwarded to the Codex child process.
// An allowlist (rather than a denylist) is used because Codex exec can run
// arbitrary shell commands inside its sandbox, so any credential present in
// the environment can be exfiltrated. Only variables that Codex legitimately
// needs are permitted; everything else — including AWS_SECRET_ACCESS_KEY,
// NPM_TOKEN, and other CI secrets — is excluded automatically.
//
// Auth credentials (CODEX_API_KEY, CODEX_ACCESS_TOKEN, OPENAI_API_KEY) are
// intentionally absent: Codex is authenticated via its auth cache directory
// ($CODEX_HOME, defaulting to ~/.codex). CODEX_HOME is exported explicitly
// by codexChildEnv() so Codex locates auth without relying on $HOME/.codex.
// Keeping auth outside HOME reduces automatic discovery via HOME traversal;
// the path is still readable via the environment in full-access sandbox
// modes, but that is equivalent to $HOME/.codex being shell-readable.
//
// XDG base dirs (XDG_CONFIG_HOME etc.) are excluded: since HOME is redirected
// to a fresh private temp dir, Codex will derive isolated XDG paths from that
// HOME. Forwarding the host XDG paths would undo the HOME isolation and expose
// config files such as gh/hosts.yml to prompts running in shell-capable modes.
//
// SSH_AUTH_SOCK / SSH_AGENT_PID are excluded: a prompt running in a
// shell-capable sandbox could use the host SSH agent socket to authenticate to
// GitHub or other private hosts even though GH_TOKEN was scrubbed.
const CODEX_CHILD_ENV_ALLOWLIST = new Set([
  // Shell essentials
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // Temporary directory
  "TMPDIR",
  "TMP",
  "TEMP",
  // Terminal and locale (output formatting)
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "NO_COLOR",
  "FORCE_COLOR",
  // HTTP proxy (Codex needs to reach the OpenAI API)
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  // Custom OpenAI API base URL (not a credential)
  "OPENAI_BASE_URL",
  // TLS certificate bundles (for corporate/private CA environments)
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  // Git identity (for commits made within the Codex sandbox)
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

// Windows-only supplemental keys not present in the POSIX allowlist above.
// Windows exposes PATHEXT and COMSPEC for executable/shim resolution (codex.cmd),
// SystemRoot and SystemDrive for system binary paths.
// USERPROFILE is intentionally absent: like HOME it is overridden with the
// private per-run directory at the end of codexChildEnv() so that tools
// expanding %USERPROFILE% see the isolated directory, not the operator's profile.
const CODEX_CHILD_ENV_WINDOWS_SUPPLEMENT = new Set([
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "SystemDrive",
]);

// Env keys whose values are URLs that may carry embedded credentials
// (user:pass@host). Includes OPENAI_BASE_URL because an operator may point
// Codex at a basic-auth gateway (https://user:pass@proxy/v1). Checked
// case-insensitively so both HTTPS_PROXY and https_proxy are covered.
// NO_PROXY/no_proxy hold host lists, not URLs, so they need no scrubbing.
const CREDENTIAL_URL_KEYS_UPPER = new Set(["HTTPS_PROXY", "HTTP_PROXY", "OPENAI_BASE_URL"]);

// Env keys whose values are filesystem paths that must be resolved to absolute
// before being forwarded. This prevents cwd-relative paths from resolving to
// different locations when the auth check (cwd=".") and exec (cwd=worktreePath)
// run from different directories.
const PATH_ENV_KEYS_UPPER = new Set(["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"]);

// Removes relative entries from a PATH-style string. Prevents a checked-out
// repository from shadowing the Codex binary via entries like "." or
// "node_modules/.bin" when cwd changes to the worktree.
function sanitizePath(pathStr: string): string {
  return pathStr
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .join(path.delimiter);
}

// Returns the scrubbed proxy URL, or undefined if the value should be dropped.
// Only attempt URL parsing for http/https-schemed values: the WHATWG URL parser
// accepts scheme-less strings like "user:pass@host:8080" as valid opaque URLs
// (treating "user" as the scheme), so parsed .username/.password are always
// empty and credentials would pass through undetected.
// For non-http/https or scheme-less values, rely on '@' as a credential signal.
function scrubProxyUrl(rawUrl: string): string | undefined {
  const lower = rawUrl.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      const u = new URL(rawUrl);
      if (u.username || u.password) {
        u.username = "";
        u.password = "";
        return u.toString();
      }
    } catch {
      // A value starting with http/https that still fails to parse — drop if
      // it contains '@' (embedded credentials), otherwise forward as-is.
      if (rawUrl.includes("@")) return undefined;
    }
    return rawUrl;
  }
  // Scheme-less or non-HTTP scheme: '@' indicates embedded credentials — drop.
  if (rawUrl.includes("@")) return undefined;
  return rawUrl;
}

function resolveCodexAuthDir(): string {
  const parentCodexHome = process.env["CODEX_HOME"];
  return parentCodexHome
    ? (path.isAbsolute(parentCodexHome) ? parentCodexHome : path.resolve(parentCodexHome))
    : path.join(os.homedir(), ".codex");
}

function codexChildEnv(homeDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const isWindows = process.platform === "win32";
  // On Windows, env keys are case-insensitive (e.g. "Path" instead of "PATH").
  // Build uppercase lookup sets so allowlist matching works regardless of casing.
  const allowlistUppercase = isWindows
    ? new Set([...CODEX_CHILD_ENV_ALLOWLIST].map((k) => k.toUpperCase()))
    : null;
  const windowsSupplementUpper = isWindows
    ? new Set([...CODEX_CHILD_ENV_WINDOWS_SUPPLEMENT].map((k) => k.toUpperCase()))
    : null;

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const isAllowed = isWindows
      ? (allowlistUppercase!.has(key.toUpperCase()) || windowsSupplementUpper!.has(key.toUpperCase()))
      : CODEX_CHILD_ENV_ALLOWLIST.has(key);
    if (!isAllowed) continue;

    const keyUpper = key.toUpperCase();
    // Strip embedded credentials from proxy URL values before forwarding.
    if (CREDENTIAL_URL_KEYS_UPPER.has(keyUpper)) {
      const scrubbed = scrubProxyUrl(value);
      if (scrubbed !== undefined) {
        out[key] = scrubbed;
      }
    } else if (PATH_ENV_KEYS_UPPER.has(keyUpper) && !path.isAbsolute(value)) {
      // Resolve relative paths to absolute so the same directory is used
      // regardless of which cwd the child process inherits.
      out[key] = path.resolve(value);
    } else if (keyUpper === "PATH") {
      // Remove relative entries (e.g. "." or "node_modules/.bin") so a
      // repo checked out at worktreePath cannot shadow the Codex binary.
      const sanitized = sanitizePath(value);
      if (sanitized.length > 0) out[key] = sanitized;
    } else {
      out[key] = value;
    }
  }

  // CODEX_HOME is exported explicitly so Codex locates auth without relying
  // on $HOME/.codex. Keeping auth outside HOME reduces discovery via HOME
  // traversal; in full-access sandbox mode the path remains readable via the
  // environment, but that is equivalent to $HOME/.codex being shell-readable.
  // Project-level .codex inside the worktree is NOT removed; --ignore-rules
  // and --ignore-user-config prevent hooks and project config from running.
  //
  // Replace HOME and USERPROFILE with the caller-supplied private per-run
  // directory so that prompts cannot reach host dotfiles via "~" or
  // %USERPROFILE%. XDG paths (XDG_CONFIG_HOME etc.) are not forwarded;
  // Codex derives them from this isolated HOME.
  //
  // CODEX_SQLITE_HOME is set to homeDir (the private per-run directory) so
  // that writable Codex state (SQLite databases, session files) is isolated
  // per-run. Without this override CODEX_SQLITE_HOME defaults to CODEX_HOME,
  // meaning concurrent planner runs share and can lock or corrupt the same
  // database even though HOME was made per-run.
  out["CODEX_HOME"] = resolveCodexAuthDir();
  out["CODEX_SQLITE_HOME"] = homeDir;
  out["HOME"] = homeDir;
  out["USERPROFILE"] = homeDir;

  return out;
}

export interface CodexPlannerContext {
  worktreePath: string;
  prompt: string;
  timeoutMs?: number;
}

export type CodexOutcome =
  | { kind: "completed"; text: string }
  | { kind: "error"; message: string }
  | { kind: "interrupted" };

export interface CodexRateLimitOpts {
  reprobeMinutes: number;
  capHours: number;
  codexPatterns: string[];
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  isInterrupted?: () => boolean;
  wait?: (meta: PauseMeta, waitMs: number) => Promise<"interrupted" | "complete">;
}

export interface CodexRateLimitClassification {
  isRateLimit: boolean;
  resetsAtMs: number | null;
}

const DEFAULT_CODEX_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\bHTTP[/ ]\s*429\b|\bstatus\s*(?:code\s*)?:?\s*429\b|\(429\)/i,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /quota.?exceed/i,
];

export function classifyCodexError(
  message: string,
  configPatterns: string[],
  nowMs: number,
): CodexRateLimitClassification {
  const patterns =
    configPatterns.length > 0
      ? configPatterns.map((p) => new RegExp(p, "i"))
      : DEFAULT_CODEX_RATE_LIMIT_PATTERNS;
  const isRateLimit = patterns.some((p) => p.test(message));
  if (!isRateLimit) return { isRateLimit: false, resetsAtMs: null };
  return {
    isRateLimit: true,
    resetsAtMs: parseResetsTime(message, nowMs),
  };
}

export interface CodexPlannerOptions {
  log: (line: string) => void;
  extraArgs?: string[];
  /** Fallback timeout for run() when ctx.timeoutMs is not set (e.g. config.safety.codexTimeoutMinutes * 60_000). */
  defaultTimeoutMs?: number;
  rateLimit?: CodexRateLimitOpts;
}

// Detect a flag by its long form, short alias, or --flag=value / -f=value forms.
// Used to avoid prepending defaults when the caller has already supplied the flag.
function hasFlagOrAlias(args: string[], longFlag: string, shortAlias: string): boolean {
  return args.some(
    (a) =>
      a === longFlag ||
      a === shortAlias ||
      a.startsWith(`${longFlag}=`) ||
      a.startsWith(`${shortAlias}=`),
  );
}

// Returns true when extraArgs opt out of the default bwrap-backed sandbox,
// meaning bwrap availability is not a prerequisite for Codex to succeed.
function isSandboxBypassed(extraArgs: string[]): boolean {
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i]!;
    if (a === "--yolo" || a === "--dangerously-bypass-approvals-and-sandbox") return true;
    if (a === "--sandbox=danger-full-access") return true;
    if (a === "--sandbox" && extraArgs[i + 1] === "danger-full-access") return true;
  }
  return false;
}

export class CodexPlanner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: CodexPlannerOptions,
  ) {}

  async run(ctx: CodexPlannerContext): Promise<CodexOutcome> {
    if (!this.opts.rateLimit) {
      return this.runOnce(ctx);
    }

    const rl = this.opts.rateLimit;
    const capMs = rl.capHours * 3_600_000;
    const reprobeMs = rl.reprobeMinutes * 60_000;
    const startMs = rl.clock();

    while (true) {
      const outcome = await this.runOnce(ctx);
      if (outcome.kind !== "error") return outcome;

      const nowMs = rl.clock();
      const classification = classifyCodexError(outcome.message, rl.codexPatterns, nowMs);
      if (!classification.isRateLimit) return outcome;

      const elapsed = nowMs - startMs;
      if (elapsed >= capMs) {
        this.opts.log(`rate limit cap exceeded (${rl.capHours}h); falling back`);
        return { kind: "error", message: `rate limit cap exceeded (${rl.capHours}h): ${outcome.message}` };
      }

      let waitMs: number;
      if (classification.resetsAtMs !== null) {
        waitMs = Math.max(0, classification.resetsAtMs - nowMs + RATE_LIMIT_BUFFER_MS);
      } else {
        waitMs = reprobeMs;
      }
      waitMs = Math.max(waitMs, RATE_LIMIT_MIN_WAIT_MS);
      const remainingMs = capMs - elapsed;
      waitMs = Math.min(waitMs, remainingMs);

      this.opts.log(
        `rate limit detected; waiting ${Math.ceil(waitMs / 60_000)}m before re-probe`,
      );

      if (rl.wait) {
        const meta: PauseMeta = {
          reason: "rate_limit",
          target: "codex",
          pausedAt: new Date(nowMs).toISOString(),
          nextReprobeAt: new Date(nowMs + waitMs).toISOString(),
          capDeadlineAt: new Date(startMs + capMs).toISOString(),
        };
        const waitResult = await rl.wait(meta, waitMs);
        if (waitResult === "interrupted") {
          return { kind: "interrupted" };
        }
      } else if (rl.isInterrupted) {
        const SLEEP_CHUNK_MS = 10_000;
        for (let slept = 0; slept < waitMs; slept += SLEEP_CHUNK_MS) {
          if (rl.isInterrupted()) {
            return { kind: "interrupted" };
          }
          await rl.sleep(Math.min(SLEEP_CHUNK_MS, waitMs - slept));
        }
        if (rl.isInterrupted()) {
          return { kind: "interrupted" };
        }
      } else {
        await rl.sleep(waitMs);
      }

      const postSleepElapsed = rl.clock() - startMs;
      if (postSleepElapsed >= capMs) {
        this.opts.log(`rate limit cap exceeded (${rl.capHours}h); falling back`);
        return { kind: "error", message: `rate limit cap exceeded (${rl.capHours}h): ${outcome.message}` };
      }
    }
  }

  private async runOnce(ctx: CodexPlannerContext): Promise<CodexOutcome> {
    if (ctx.prompt === "-") {
      return {
        kind: "error",
        message: 'invalid prompt: a lone "-" would switch Codex to stdin mode',
      };
    }

    const hasCustomSandbox = hasFlagOrAlias(this.opts.extraArgs ?? [], "--sandbox", "-s");
    const hasCustomApproval = hasFlagOrAlias(this.opts.extraArgs ?? [], "--ask-for-approval", "-a");
    const hasIgnoreUserConfig = (this.opts.extraArgs ?? []).some(
      (a) => a === "--ignore-user-config" || a.startsWith("--ignore-user-config="),
    );
    const hasIgnoreRules = (this.opts.extraArgs ?? []).some(
      (a) => a === "--ignore-rules" || a.startsWith("--ignore-rules="),
    );
    const promptArg = "-";

    const args: string[] = [
      "exec",
      "--ephemeral",
      ...(hasCustomSandbox ? [] : ["--sandbox", "read-only"]),
      ...(hasCustomApproval ? [] : ["--ask-for-approval", "never"]),
      ...(hasIgnoreUserConfig ? [] : ["--ignore-user-config"]),
      ...(hasIgnoreRules ? [] : ["--ignore-rules"]),
      ...(this.opts.extraArgs ?? []),
      "--",
      promptArg,
    ];

    const timeoutMs = ctx.timeoutMs ?? this.opts.defaultTimeoutMs;

    const privateHome = mkdtempSync(path.join(os.tmpdir(), "codex-planner-"));
    if (process.platform !== "win32") chmodSync(privateHome, 0o700);

    const runOpts: RunOptions = {
      cwd: ctx.worktreePath,
      env: codexChildEnv(privateHome),
      stdin: ctx.prompt,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

    this.opts.log("codex session started");

    try {
      let result;
      try {
        result = await this.runner.run(CODEX_COMMAND, args, runOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.opts.log(`codex session failed: ${message}`);
        return { kind: "error", message };
      }

      if (result.code !== 0) {
        const tail = result.stderr.trim().slice(-STDERR_TAIL_MAX);
        const msg = `codex exited with code ${result.code}`;
        this.opts.log(`codex session error: ${msg}`);
        return { kind: "error", message: tail ? `${msg}: ${tail}` : msg };
      }

      this.opts.log("codex session completed");
      return { kind: "completed", text: result.stdout.trim() };
    } finally {
      rmSync(privateHome, { recursive: true, force: true });
    }
  }

  async checkAvailability(): Promise<string> {
    // Create the private home early so the same sanitized env (including the
    // PATH-stripped version) is used for both the --version probe and the auth
    // check. This prevents a false-positive availability report when Codex is
    // reachable only via a relative PATH entry (e.g. node_modules/.bin) that
    // codexChildEnv strips before runtime.
    const privateHome = mkdtempSync(path.join(os.tmpdir(), "codex-planner-"));
    if (process.platform !== "win32") chmodSync(privateHome, 0o700);
    try {
      let result;
      try {
        result = await this.runner.run(CODEX_COMMAND, ["--version"], {
          cwd: ".",
          env: codexChildEnv(privateHome),
        });
      } catch (err) {
        throw new Error(
          `codex CLI not found or not available: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (result.code !== 0) {
        throw new Error("codex CLI not found or not available");
      }
      const version = result.stdout.trim();

      // Run the auth check with the same filtered environment as run() so that
      // environments relying on env-var-only auth (CODEX_API_KEY / CODEX_ACCESS_TOKEN)
      // fail here at preflight rather than silently at exec time.
      let authResult;
      try {
        authResult = await this.runner.run(CODEX_COMMAND, ["login", "status"], {
          cwd: ".",
          env: codexChildEnv(privateHome),
        });
      } catch (err) {
        throw new Error(
          `codex: 認証状態を確認できません（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
      if (authResult.code !== 0) {
        throw new Error("codex: 認証されていません（codex login を実行してください）");
      }

      // On Linux, Codex uses bwrap + seccomp for sandboxing. Probe bwrap so
      // preflight can surface a missing helper early rather than at exec time.
      // Skip the probe when extraArgs bypass sandboxing (e.g. --yolo), and
      // treat a missing or failing bwrap as a non-fatal warning: Codex may
      // fall back to its own sandbox helper on some configurations.
      if (process.platform === "linux" && !isSandboxBypassed(this.opts.extraArgs ?? [])) {
        try {
          // Use the same sanitized env as all other child invocations so that
          // relative PATH entries (e.g. "." or "node_modules/.bin") cannot
          // shadow the system bwrap binary when LoopPilot is started from a
          // repository or config directory.
          await this.runner.run("bwrap", ["--version"], { cwd: ".", env: codexChildEnv(privateHome) });
        } catch {
          // bwrap unavailable; Codex may use a fallback — proceed and let
          // runtime surface the failure if sandboxing truly cannot start.
        }
      }

      return version;
    } finally {
      rmSync(privateHome, { recursive: true, force: true });
    }
  }
}
