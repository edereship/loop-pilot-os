import path from "node:path";
import process from "node:process";
import type { CommandRunner, RunOptions } from "./types.js";

const STDERR_TAIL_MAX = 1000;

// Allowlist of environment variables forwarded to the Codex child process.
// An allowlist (rather than a denylist) is used because Codex exec can run
// arbitrary shell commands inside its sandbox, so any credential present in
// the environment can be exfiltrated. Only variables that Codex legitimately
// needs are permitted; everything else — including AWS_SECRET_ACCESS_KEY,
// NPM_TOKEN, and other CI secrets — is excluded automatically.
//
// Auth credentials (CODEX_API_KEY, CODEX_ACCESS_TOKEN, OPENAI_API_KEY) are
// intentionally absent: the only supported authentication method is a cached
// auth file (~/.codex/auth.json), which checkAvailability() verifies under
// the same filtered environment before any exec run.
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
  // Codex home directory (overrides default ~/.codex for config and auth state)
  "CODEX_HOME",
  // TLS certificate bundles (for corporate/private CA environments)
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  // XDG base directories (for Codex config and cache)
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // SSH agent (for git operations inside the Codex sandbox)
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
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
const PATH_ENV_KEYS_UPPER = new Set(["CODEX_HOME"]);

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

function codexChildEnv(): Record<string, string> {
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
    } else {
      out[key] = value;
    }
  }
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
    const runOpts: RunOptions = {
      cwd: ctx.worktreePath,
      env: codexChildEnv(),
      stdin: "ignore",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };

    this.opts.log("codex session started");

    let result;
    try {
      result = await this.runner.run("codex", args, runOpts);
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
  }

  async checkAvailability(): Promise<string> {
    let result;
    try {
      result = await this.runner.run("codex", ["--version"], { cwd: "." });
    } catch (err) {
      throw new Error(
        `codex CLI not found or not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (result.code !== 0) {
      throw new Error("codex CLI not found or not available");
    }
    const version = result.stdout.trim();

    let authResult;
    try {
      // Run the auth check with the same filtered environment as run() so that
      // environments relying on env-var-only auth (CODEX_API_KEY / CODEX_ACCESS_TOKEN)
      // fail here at preflight rather than silently at exec time.
      authResult = await this.runner.run("codex", ["login", "status"], { cwd: ".", env: codexChildEnv() });
    } catch (err) {
      throw new Error(
        `codex: 認証状態を確認できません（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (authResult.code !== 0) {
      throw new Error("codex: 認証されていません（codex login を実行してください）");
    }

    return version;
  }
}
