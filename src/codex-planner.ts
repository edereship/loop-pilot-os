import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { CommandRunner, RunOptions } from "./types.js";

const STDERR_TAIL_MAX = 1000;

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
// ($CODEX_HOME, defaulting to ~/.codex). codexChildEnv() always injects an
// explicit CODEX_HOME so the Codex binary can locate its auth even after HOME
// has been replaced with a private per-run temp directory (see below).
//
// CODEX_HOME is intentionally absent from this allowlist: it is injected
// explicitly at the end of codexChildEnv() so the absolute value derived from
// the parent environment (or the default) is always used, bypassing the loop.
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
// SystemRoot and SystemDrive for system binary paths, and USERPROFILE as the
// Windows equivalent of HOME. These are safe system keys, not credentials.
const CODEX_CHILD_ENV_WINDOWS_SUPPLEMENT = new Set([
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "SystemDrive",
  "USERPROFILE",
]);

// Proxy env keys that may carry embedded URL credentials (user:pass@host).
// Checked case-insensitively so both HTTPS_PROXY and https_proxy are covered.
// NO_PROXY/no_proxy hold host lists, not URLs, so they need no scrubbing.
const PROXY_CREDENTIAL_KEYS_UPPER = new Set(["HTTPS_PROXY", "HTTP_PROXY"]);

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

function codexChildEnv(homeDir: string): Record<string, string> {
  // Resolve the auth cache directory from the *parent* environment before we
  // build the sanitised child env. We need this to inject CODEX_HOME into the
  // child so the Codex binary can authenticate even after we redirect HOME.
  const parentCodexHome = process.env["CODEX_HOME"];
  const realCodexHome = parentCodexHome
    ? (path.isAbsolute(parentCodexHome) ? parentCodexHome : path.resolve(parentCodexHome))
    : path.join(os.homedir(), ".codex");

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
    if (PROXY_CREDENTIAL_KEYS_UPPER.has(keyUpper)) {
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

  // Always inject CODEX_HOME (absolute) so the Codex binary can locate its
  // auth cache regardless of the HOME override below. CODEX_HOME is not in
  // the allowlist above; it is injected here so the resolved absolute value
  // from the parent environment (or the ~/.codex default) is always used.
  out["CODEX_HOME"] = realCodexHome;
  // Replace HOME with a caller-supplied private per-run directory so that a
  // malicious planning prompt cannot reach ~/.codex/auth.json via "~". Codex
  // authenticates via the explicit CODEX_HOME set above, not via HOME.
  // XDG paths (XDG_CONFIG_HOME etc.) are not forwarded; Codex will derive
  // them from this isolated HOME, keeping all per-run state within homeDir.
  out["HOME"] = homeDir;

  return out;
}

export interface CodexPlannerContext {
  worktreePath: string;
  prompt: string;
  timeoutMs?: number;
}

export type CodexOutcome =
  | { kind: "completed"; text: string }
  | { kind: "error"; message: string };

export interface CodexPlannerOptions {
  log: (line: string) => void;
  extraArgs?: string[];
  /** Fallback timeout for run() when ctx.timeoutMs is not set (e.g. config.safety.codexTimeoutMinutes * 60_000). */
  defaultTimeoutMs?: number;
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

export class CodexPlanner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: CodexPlannerOptions,
  ) {}

  async run(ctx: CodexPlannerContext): Promise<CodexOutcome> {
    // A lone "-" is Codex's stdin sentinel: even after "--", Codex interprets
    // "-" as "read prompt from stdin". Since stdin is always "ignore", the
    // invocation would silently receive an empty prompt instead of the dash.
    if (ctx.prompt === "-") {
      return {
        kind: "error",
        message: 'invalid prompt: a lone "-" would switch Codex to stdin mode',
      };
    }

    // Default to read-only sandbox so planning prompts (which only need to
    // read the worktree) cannot mutate files before implementation starts.
    // Callers that need write access must pass "--sandbox"/"-s" in extraArgs.
    const hasCustomSandbox = hasFlagOrAlias(this.opts.extraArgs ?? [], "--sandbox", "-s");
    // stdin is always "ignore" so there is no user path to approve commands;
    // add --ask-for-approval never unless the caller already specified it.
    const hasCustomApproval = hasFlagOrAlias(this.opts.extraArgs ?? [], "--ask-for-approval", "-a");
    const args: string[] = [
      "exec",
      "--ephemeral",
      ...(hasCustomSandbox ? [] : ["--sandbox", "read-only"]),
      ...(hasCustomApproval ? [] : ["--ask-for-approval", "never"]),
      ...(this.opts.extraArgs ?? []),
      // Terminate options before the prompt so that a prompt starting with '-'
      // (including the literal '-' which codex reads as stdin) is never
      // misinterpreted as a CLI flag.
      "--",
      ctx.prompt,
    ];

    const timeoutMs = ctx.timeoutMs ?? this.opts.defaultTimeoutMs;

    // Create a private per-run home directory so concurrent planner runs don't
    // share state and so dotfiles in the global temp root cannot affect the run.
    const privateHome = mkdtempSync(path.join(os.tmpdir(), "codex-planner-"));
    if (process.platform !== "win32") chmodSync(privateHome, 0o700);

    const runOpts: RunOptions = {
      cwd: ctx.worktreePath,
      env: codexChildEnv(privateHome),
      stdin: "ignore",
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
    let result;
    try {
      result = await this.runner.run(CODEX_COMMAND, ["--version"], { cwd: "." });
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
    const privateHome = mkdtempSync(path.join(os.tmpdir(), "codex-planner-"));
    if (process.platform !== "win32") chmodSync(privateHome, 0o700);
    try {
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
      return version;
    } finally {
      rmSync(privateHome, { recursive: true, force: true });
    }
  }
}
