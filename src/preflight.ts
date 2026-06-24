import type { CommandRunner, CommandResult, Notifier, TicketState } from "./types.js";
import type { Config } from "./config.js";
import type { FetchFn, LinearSetupRequest } from "./task-source.js";
import { resolveLinearSetup } from "./task-source.js";

export interface PreflightDeps {
  config: Config;
  runner: CommandRunner;
  notifier: Notifier;
  fetchFn: FetchFn;
  /** process.getuid の注入口。未提供（Windows/非 POSIX）時は root チェックをスキップする。 */
  getuid?: () => number;
}

// gh api は HTTP エラー時 code != 0 で終了し、stderr に "(HTTP 404)" 等を含む。
// 404 を「存在しない」シグナルとして識別する（branch protection / actions variable で必須）。
function isHttp404(r: CommandResult): boolean {
  return r.code !== 0 && /\(HTTP 404\)\s*$/.test(r.stderr);
}

// GitHub Free の private リポではブランチ保護/ルールセット API が
// "Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" を返す。
// 機能自体が利用不可 = 保護なしと同義なので安全にスキップする。
// 権限不足の 403（"Must have admin rights"）は別原因なのでスキップしない。
function isFeatureUnavailable403(r: CommandResult): boolean {
  return r.code !== 0 && /Upgrade to GitHub Pro.*\(HTTP 403\)\s*$/.test(r.stderr);
}

// LOOPPILOT_STATE_COMMENT_AUTHORS の値を LoopPilot と同一パースする
// （カンマ区切り → trim → 空除去）。state-manager.ts の getTrustedStateCommentAuthors と同規則。
function parseAuthors(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export async function runPreflight(deps: PreflightDeps): Promise<string[]> {
  const { config, runner } = deps;
  const errors: string[] = [];
  const repoPath = config.repo.path;
  const repoSlug = config.repo.remote;
  const branch = config.repo.defaultBranch;
  const opts = { cwd: repoPath, timeoutMs: 30_000 };

  // カーネル §9: 全項目を実行して集約。各 check 内で try/catch し、途中 throw しない。
  await checkGitClean(runner, repoPath, branch, opts, errors);          // §9.2
  await checkOriginMatchesRemote(runner, repoPath, repoSlug, opts, errors); // ES-415
  await checkRemote(runner, repoPath, opts, errors);                   // §9.3（Step 4b で追加）
  await checkGhAuth(runner, opts, errors);                             // §9.4 認証（Step 4b で追加）
  await checkPushPermission(runner, repoSlug, opts, errors);           // §9.4 push 権限（Step 4b で追加）
  await checkBranchProtection(runner, repoSlug, branch, opts, errors); // §9.4 保護（Step 5 で追加）
  await checkRulesets(runner, repoSlug, branch, opts, errors);         // §9.4 rulesets（Step 7 で追加）
  await checkGateLabel(runner, config, repoSlug, opts, errors);        // §9.5（Step 9 で追加）
  await checkAutoMerge(runner, repoSlug, opts, errors);               // §9.6（Step 11 で追加）
  await checkStateCommentAuthors(runner, config, repoSlug, opts, errors); // §9.9（Step 13 で追加）
  await checkLinear(deps, errors);                                     // §9.7（Step 15 で追加）
  await checkClaude(runner, opts, errors);                             // §9.8（Step 17 で追加）
  await checkSlack(deps, errors);                                      // §9.10（Step 17 で追加）
  checkNonRoot(deps, errors);                                          // ES-385: bypassPermissions + root 拒否

  return errors;
}

// ---- §9.2 repo がクリーンな git で default_branch 上 ----
async function checkGitClean(
  runner: CommandRunner,
  repoPath: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const head = await runner.run("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], opts);
    const current = head.stdout.trim();
    if (head.code !== 0) {
      errors.push(`git: HEAD ブランチを取得できません（${head.stderr.trim()}）`);
    } else if (current !== branch) {
      errors.push(`git: 現在のブランチが '${current}' です。default_branch '${branch}' 上で起動してください`);
    }
    const status = await runner.run("git", ["-C", repoPath, "status", "--porcelain"], opts);
    if (status.code !== 0) {
      errors.push(`git: 作業ツリーの状態を取得できません（${status.stderr.trim()}）`);
    } else if (status.stdout.trim() !== "") {
      errors.push("git: 作業ツリーがクリーンではありません。未コミットの変更を解消してください");
    }
  } catch (e) {
    errors.push(`git: 状態確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.3 remote 到達可 ----
async function checkRemote(
  runner: CommandRunner,
  repoPath: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const ls = await runner.run("git", ["-C", repoPath, "ls-remote", "origin", "HEAD"], { ...opts, timeoutMs: 60_000 });
    if (ls.code !== 0) {
      errors.push(`git: remote 'origin' に到達できません（${ls.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`git: remote 到達確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- ES-415: origin URL と repo.remote の一致検証 ----

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);

// Git remote URL を owner/name に正規化する。
// GitHub 以外のホスト、パース不能な URL は null を返す。
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim();
  // SSH SCP: [user@]github.com:path — user@ is optional (SSH config may supply User git).
  // Absolute-path SCP (git@github.com:/owner/name) has a leading slash which we strip.
  // Guard path not starting with '//' to avoid matching scheme-based URLs (https://...).
  const sshColon = trimmed.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
  if (sshColon && !sshColon[3].startsWith("//")) {
    const user = sshColon[1];
    const host = sshColon[2];
    const rawPath = sshColon[3];
    if (!GITHUB_HOSTS.has(host.toLowerCase())) return null;
    // ssh.github.com is only valid as SSH-over-HTTPS at port 443 (ssh://...); SCP-style
    // URLs cannot express a port, so reject ssh.github.com in this context.
    if (host.toLowerCase() === "ssh.github.com") return null;
    // GitHub SSH requires the exact 'git' user (case-sensitive); reject any other username.
    if (user !== undefined && user !== "git") return null;
    const path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
    return path.length > 0 ? path.toLowerCase() : null;
  }
  // SSH URL: ssh://git@github.com/owner/name.git
  // SSH-over-HTTPS: ssh://git@ssh.github.com:443/owner/name.git
  // HTTPS: https://github.com/owner/name(.git)
  try {
    const parsed = new URL(trimmed);
    // Only accept transport protocols GitHub actually uses; reject file://, git://, etc.
    if (!["https:", "ssh:"].includes(parsed.protocol)) return null;
    if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    // Reject URLs with query strings or fragments — never valid for git push.
    if (parsed.search !== "" || parsed.hash !== "") return null;
    // ssh.github.com requires port 443 explicitly for SSH-over-HTTPS; without it SSH
    // defaults to port 22, which ssh.github.com does not accept for git operations.
    if (parsed.protocol === "ssh:" && parsed.hostname.toLowerCase() === "ssh.github.com" && parsed.port === "") {
      return null;
    }
    // Reject non-standard ports. Accepted explicit ports: ssh.github.com:443 (SSH-over-HTTPS)
    // and ssh:22 (standard SSH port not normalized by URL parser for the ssh: scheme).
    // ssh.github.com on port 22 is explicitly rejected — that host only accepts SSH-over-HTTPS at 443.
    if (parsed.port !== "") {
      const isSshOverHttps =
        parsed.protocol === "ssh:" &&
        parsed.hostname.toLowerCase() === "ssh.github.com" &&
        parsed.port === "443";
      const isDefaultSshPort =
        parsed.protocol === "ssh:" &&
        parsed.port === "22" &&
        parsed.hostname.toLowerCase() !== "ssh.github.com";
      const isGitHubSshOverHttpsRemapPort =
        parsed.protocol === "ssh:" &&
        parsed.hostname.toLowerCase() === "github.com" &&
        parsed.port === "443";
      if (!isSshOverHttps && !isDefaultSshPort && !isGitHubSshOverHttpsRemapPort) return null;
    }
    // ssh.github.com is only valid with the ssh: protocol (SSH-over-HTTPS at port 443);
    // https://ssh.github.com/... is not a valid Git transport endpoint.
    if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "ssh.github.com") return null;
    // For SSH protocol, GitHub only accepts the exact 'git' user (case-sensitive).
    if (parsed.protocol === "ssh:" && parsed.username !== "" && parsed.username !== "git") {
      return null;
    }
    // Reject SSH URLs with a password — embedded passwords in git remote URLs are never valid credentials.
    if (parsed.protocol === "ssh:" && parsed.password !== "") {
      return null;
    }
    const path = parsed.pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.git$/i, "");
    return path.length > 0 ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    // Strip query string and fragment — git remote URLs never use them,
    // but a misconfigured URL could carry a token there (e.g. ?token=ghp_...).
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // SCP-format SSH URLs (git@host:path) use 'git' as the conventional username — not a
    // secret token — so they are safe to display. Strip query string and fragment first:
    // they carry no semantic meaning for git remotes but could carry tokens
    // (e.g. git@github.com:owner/name.git?token=ghp_...).
    // Other unparseable strings may carry credentials, so emit a safe placeholder.
    if (/^git@[^:]+:.+$/.test(url.trim())) {
      return url.trim().replace(/[?#].*$/, "");
    }
    return "[unparseable URL]";
  }
}

// TLDs that are reserved for private/internal networks and are never registered in the IANA
// root zone as public domains. Hosts under these TLDs are almost certainly SSH config aliases
// (e.g. github.internal, repo.corp) and must not be rejected by isLikelyRealDomain so that
// ssh -G alias resolution can verify them. See RFC 2606 (.test/.example/.invalid/.localhost),
// RFC 6762 (.local), and common private-network conventions (.internal/.corp/.private/.lan).
const PRIVATE_TLDS = new Set([
  "internal", "local", "corp", "private", "lan", "intranet", "home",
  "test", "example", "invalid", "localhost",
]);

// Returns true when the hostname looks like a real domain (e.g. "gitlab.com") rather than
// an SSH config alias (e.g. "github.com-work", "github-work"). Real-domain TLDs are
// letters-only and not in PRIVATE_TLDS; alias suffixes like "com-work" contain hyphens or
// digits. Trailing dots (FQDN absolute notation, e.g. "gitlab.com.") are stripped first.
function isLikelyRealDomain(host: string): boolean {
  const stripped = host.replace(/\.+$/, "");
  const lastDot = stripped.lastIndexOf(".");
  if (lastDot === -1) return false;
  const tld = stripped.slice(lastDot + 1).toLowerCase();
  if (PRIVATE_TLDS.has(tld)) return false; // private-network TLD — treat as SSH config alias
  return /^[a-z]{2,}$/i.test(tld);
}

// Returns true for bare IPv4 addresses (e.g. "192.168.1.10"). These are never GitHub
// hosts and must not be accepted as SSH config aliases.
function isIPv4Address(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function mergeEnvAssignments(
  opts: { cwd: string },
  envAssignments: Record<string, string>,
): { cwd: string; env?: Record<string, string> } {
  if (Object.keys(envAssignments).length === 0) return opts;
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  return { ...opts, env: { ...baseEnv, ...envAssignments } };
}

// Sentinel used inside splitShellArgs to protect dollar signs that appeared inside
// single-quoted segments from variable expansion in expandShellWord. Single-quoted
// strings in shell never undergo $VAR substitution; this sentinel lets expandEnvVars
// skip them while expandShellWord restores the literal '$' afterward.
const SINGLE_QUOTE_DOLLAR = "\x01";

// Tokenize a shell command string, respecting single- and double-quoted segments.
// Double-quoted segments support backslash-escape for the next character; single-quoted do not.
// Used to parse GIT_SSH_COMMAND / core.sshCommand so that paths with spaces survive the split.
// Dollar signs inside single-quoted segments are replaced with SINGLE_QUOTE_DOLLAR so that
// subsequent expandShellWord calls do not expand them.
function splitShellArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else if (c === "$") current += SINGLE_QUOTE_DOLLAR; // single quotes suppress $VAR expansion
      else current += c;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && i + 1 < cmd.length) { i++; current += cmd[i]; }
      else current += c;
    } else {
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === "\\" && i + 1 < cmd.length) { i++; current += cmd[i]; }
      else if (/\s/.test(c)) {
        if (current.length > 0) { args.push(current); current = ""; }
      } else current += c;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

// Expand bare $VAR and ${VAR} references using process.env. Unrecognised names are left
// as-is so that a missing variable causes an ssh invocation error (handled by callers) rather
// than silently producing an empty path. Shell features beyond simple variable substitution
// (backticks, $(...), arithmetic expansion) are intentionally not handled.
function expandEnvVars(s: string): string {
  return s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, simple: string | undefined) => {
      const name = braced ?? simple ?? "";
      const val = process.env[name];
      return val !== undefined ? val : match;
    },
  );
}

// Expand a single shell word: leading ~ / ~/ to HOME, then $VAR / ${VAR} references.
// Git runs GIT_SSH_COMMAND and core.sshCommand through the shell, so both tilde and
// variable expansion happen before the command reaches the SSH binary.
// SINGLE_QUOTE_DOLLAR sentinels (written by splitShellArgs for '$' inside single-quoted
// segments) survive expandEnvVars unchanged and are restored to '$' here so callers
// receive the correct literal value without variable substitution.
function expandShellWord(s: string): string {
  const home = process.env.HOME;
  let result = s;
  if (home) {
    if (result === "~") result = home;
    else if (result.startsWith("~/")) result = home + result.slice(1);
  }
  result = expandEnvVars(result);
  return result.replace(/\x01/g, "$");
}

// Returns the SSH binary and extra args to pass when resolving aliases via ssh -G.
// Git's SSH command selection order: GIT_SSH_COMMAND env var > core.sshCommand git config > GIT_SSH env var.
// GIT_SSH names only a binary (no extra args); it is used as the SSH executable so that wrapper
// scripts which exec OpenSSH with custom options honour those options during alias resolution.
async function getGitSshConfig(
  runner: CommandRunner,
  repoPath: string,
  opts: { cwd: string },
): Promise<{ sshBin: string; extraArgs: string[]; envAssignments: Record<string, string> }> {
  // GIT_SSH_COMMAND takes precedence over core.sshCommand.
  const envCmd = process.env.GIT_SSH_COMMAND;
  if (envCmd && envCmd.trim()) {
    const parts = splitShellArgs(envCmd.trim());
    // Git runs GIT_SSH_COMMAND through the shell, so ~ and $VAR in the executable path and
    // arguments are expanded before the command runs. Replicate that here.
    // Capture leading KEY=VALUE shell environment assignments — the shell sets them before
    // exec, so we pass them as env vars when invoking the SSH probe.
    let binIdx = 0;
    const envAssignments: Record<string, string> = {};
    while (binIdx < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[binIdx])) {
      const eqIdx = parts[binIdx].indexOf("=");
      envAssignments[parts[binIdx].slice(0, eqIdx)] = expandShellWord(parts[binIdx].slice(eqIdx + 1));
      binIdx++;
    }
    if (binIdx < parts.length) {
      const bin = expandShellWord(parts[binIdx]);
      return { sshBin: bin, extraArgs: parts.slice(binIdx + 1).map(expandShellWord), envAssignments };
    }
  }
  try {
    const r = await runner.run("git", ["-C", repoPath, "config", "--get", "core.sshCommand"], opts);
    if (r.code === 0 && r.stdout.trim()) {
      const parts = splitShellArgs(r.stdout.trim());
      // Git runs core.sshCommand through the shell, so ~ and $VAR in the executable path and
      // arguments are expanded before the command runs. Replicate that here.
      // Capture leading KEY=VALUE shell environment assignments (same reasoning as above).
      let binIdx = 0;
      const envAssignments: Record<string, string> = {};
      while (binIdx < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[binIdx])) {
        const eqIdx = parts[binIdx].indexOf("=");
        envAssignments[parts[binIdx].slice(0, eqIdx)] = expandShellWord(parts[binIdx].slice(eqIdx + 1));
        binIdx++;
      }
      if (binIdx < parts.length) {
        const bin = expandShellWord(parts[binIdx]);
        return { sshBin: bin, extraArgs: parts.slice(binIdx + 1).map(expandShellWord), envAssignments };
      }
    }
  } catch {
    // Fall through to GIT_SSH check.
  }
  // GIT_SSH names a binary with no extra args. Use it directly so that simple wrappers that
  // exec OpenSSH (e.g. exec ssh -F /custom/config "$@") pass those options to ssh -G.
  const gitSshEnv = process.env.GIT_SSH;
  if (gitSshEnv && gitSshEnv.trim()) {
    return { sshBin: gitSshEnv.trim(), extraArgs: [], envAssignments: {} };
  }
  return { sshBin: "ssh", extraArgs: [], envAssignments: {} };
}

// For SCP-format (e.g. git@github.com:path) or ssh:// URLs that name a GitHub host directly,
// return the ssh -G target string, expected hostname, and the URL's explicit port (if any)
// so callers can verify SSH config hasn't redirected the host to a different server.
// Returns null for HTTPS or non-GitHub hosts.
function extractDirectGitHubSshTarget(
  trimmed: string,
): { target: string; expectedHost: string; explicitPort: string | null } | null {
  // SCP format: [user@]host:path — ssh.github.com cannot be expressed without a port in SCP so reject it.
  const scpM = trimmed.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
  if (scpM && !scpM[3].startsWith("//")) {
    const user = scpM[1];
    const rawHost = scpM[2]; // preserve original case for ssh -G target (OpenSSH Host matching is case-sensitive)
    const host = rawHost.toLowerCase();
    if (GITHUB_HOSTS.has(host) && host !== "ssh.github.com") {
      return { target: user ? `${user}@${rawHost}` : rawHost, expectedHost: host, explicitPort: null };
    }
    return null;
  }
  // ssh:// URL
  try {
    const p = new URL(trimmed);
    if (p.protocol === "ssh:" && GITHUB_HOSTS.has(p.hostname.toLowerCase())) {
      const rawHost = p.hostname; // preserve original case for ssh -G target
      const host = rawHost.toLowerCase();
      // Pass the URL's explicit port via -p to ssh -G so that the correct Host block is selected
      // (ssh -G without -p selects the default-port block, which may differ from the URL port).
      return { target: p.username ? `${p.username}@${rawHost}` : rawHost, expectedHost: host, explicitPort: p.port || null };
    }
  } catch {
    // ignore
  }
  return null;
}

async function checkOriginMatchesRemote(
  runner: CommandRunner,
  repoPath: string,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const expected = repoSlug.toLowerCase();
    const gitSshCfg = await getGitSshConfig(runner, repoPath, opts);
    const isCustomSsh = gitSshCfg.sshBin !== "ssh" || gitSshCfg.extraArgs.length > 0;
    const sshRunOpts = mergeEnvAssignments(opts, gitSshCfg.envAssignments);

    const fetchR = await runner.run("git", ["-C", repoPath, "remote", "get-url", "origin"], opts);
    if (fetchR.code !== 0) {
      errors.push(`git: origin の URL を取得できません（${fetchR.stderr.trim()}）`);
      return;
    }
    const fetchUrl = fetchR.stdout.trim();
    const normalizedFetch = normalizeRemote(fetchUrl);
    if (normalizedFetch !== null) {
      if (normalizedFetch !== expected) {
        errors.push(
          `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
        );
      } else {
        // Finding 3 / Finding 4: for SSH/SCP URLs that name a GitHub host directly, verify SSH
        // config hasn't redirected the host via HostName to a different server, remapped it to a
        // non-standard port, or overridden the user to a non-git account. Fail-open if ssh is
        // unavailable.
        const directSsh = extractDirectGitHubSshTarget(fetchUrl.trim());
        if (directSsh !== null) {
          try {
            // Pass the URL's explicit port to ssh -G so it selects the Host block that Git will
            // actually use. Without -p, ssh -G uses the default-port block, which may differ when
            // the URL carries an explicit non-default port.
            const portArgs3 = directSsh.explicitPort ? ["-p", directSsh.explicitPort] : [];
            const sshG3 = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, ...portArgs3, "-G", directSsh.target], sshRunOpts);
            if (sshG3.code === 0) {
              const lines3 = sshG3.stdout.split("\n");
              const hl3 = lines3.find((l) => l.toLowerCase().startsWith("hostname "));
              const resolvedHost3 = hl3 ? hl3.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
              const pl3 = lines3.find((l) => l.toLowerCase().startsWith("port "));
              const resolvedPort3 = pl3 ? pl3.slice("port ".length).trim() : null;
              const ul3 = lines3.find((l) => l.toLowerCase().startsWith("user "));
              const resolvedUser3 = ul3 ? ul3.slice("user ".length).trim() : null;
              if (resolvedHost3 !== null && resolvedHost3 !== directSsh.expectedHost) {
                // Allow the documented GitHub SSH-over-HTTPS setup where github.com is mapped
                // to ssh.github.com at port 443 via SSH config HostName/Port directives.
                const isGitHubSshOverHttpsRemap =
                  resolvedHost3 === "ssh.github.com" &&
                  directSsh.expectedHost === "github.com" &&
                  resolvedPort3 === "443";
                if (!isGitHubSshOverHttpsRemap) {
                  errors.push(
                    `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                  );
                }
              } else if (resolvedHost3 !== null && resolvedPort3 !== null) {
                // github.com accepts only port 22; ssh.github.com accepts only port 443 (SSH-over-HTTPS).
                // ssh -G was invoked with the URL's explicit port (if any), so resolvedPort3 already
                // reflects the effective port — no need to override it with the URL port separately.
                const expectedPort3 = directSsh.expectedHost === "ssh.github.com" ? "443" : "22";
                if (resolvedPort3 !== expectedPort3) {
                  errors.push(
                    `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                  );
                }
              }
              // Finding 4: SSH command options (e.g. GIT_SSH_COMMAND='ssh -l alice') can override
              // the user in the URL target. GitHub only accepts user 'git'; reject any other.
              if (resolvedUser3 !== null && resolvedUser3 !== "git") {
                errors.push(
                  `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              }
              if (isCustomSsh && (resolvedHost3 === null || resolvedUser3 === null)) {
                errors.push(
                  `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              }
            } else if (isCustomSsh) {
              errors.push(
                `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            }
          } catch {
            if (isCustomSsh) {
              errors.push(
                `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            }
          }
        }
      }
    } else {
      // normalizeRemote returned null — classify to determine the right action.
      const trimmedFetch = fetchUrl.trim();
      // SCP format: [user@]host:path — user is optional (SSH config may specify User git).
      // Guard path against '//' to avoid matching scheme-based URLs (https://...).
      // Absolute-path SCP (git@alias:/owner/name) has a leading slash which we strip.
      const _fScpRaw = trimmedFetch.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
      const fetchScpMatch = _fScpRaw && !_fScpRaw[3].startsWith("//") ? _fScpRaw : null;
      if (fetchScpMatch) {
        const fetchUser = fetchScpMatch[1];
        const rawFetchHost = fetchScpMatch[2]; // preserve original case for ssh -G (OpenSSH Host matching is case-sensitive)
        const fetchHost = rawFetchHost.toLowerCase();
        const rawFetchPath = fetchScpMatch[3];
        if (isIPv4Address(fetchHost)) {
          errors.push(
            `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
          );
        } else if (isLikelyRealDomain(fetchHost)) {
          // Real non-GitHub domain (e.g. gitlab.com) — reject outright without ssh -G alias
          // resolution; only alias-style hostnames (no letters-only TLD) qualify for lookup.
          errors.push(
            `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
          );
        } else {
          if (fetchUser !== undefined && fetchUser.toLowerCase() !== "git") {
            errors.push(
              `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
            );
          } else {
            let fetchAliasToGitHub = false;
            try {
              const sshTarget = fetchUser ? `${fetchUser}@${rawFetchHost}` : rawFetchHost;
              const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, "-G", sshTarget], sshRunOpts);
              if (sshG.code === 0) {
                const sshGLines = sshG.stdout.split("\n");
                const hl = sshGLines.find((l) => l.toLowerCase().startsWith("hostname "));
                const resolvedHost = hl ? hl.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
                const pl = sshGLines.find((l) => l.toLowerCase().startsWith("port "));
                const resolvedPort = pl ? pl.slice("port ".length).trim() : null;
                const ul = sshGLines.find((l) => l.toLowerCase().startsWith("user "));
                const resolvedUser = ul ? ul.slice("user ".length).trim() : null;
                // GitHub SSH only accepts user 'git'; reject aliases resolving to any other user.
                const userOk = resolvedUser === "git";
                // Accept github.com on port 22 (standard SSH) or ssh.github.com on port 443
                // (SSH-over-HTTPS). Any other host, port, or non-git user is rejected.
                if (resolvedHost === "github.com") {
                  fetchAliasToGitHub = (resolvedPort === "22" || resolvedPort === null) && userOk;
                } else if (resolvedHost === "ssh.github.com") {
                  fetchAliasToGitHub = resolvedPort === "443" && userOk;
                }
              }
            } catch {
              // ssh not available or failed — conservatively reject.
            }
            if (!fetchAliasToGitHub) {
              errors.push(
                `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            } else {
              const aliasPath = rawFetchPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
              if (aliasPath !== expected) {
                errors.push(
                  `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              }
            }
          }
        }
      } else if (!trimmedFetch.includes("://")) {
        // No URL scheme and not SCP-format — local path or bare remote name — reject (ES-415 Finding 2).
        errors.push(
          `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
        );
      } else {
        // Scheme-based URL — check parseability to detect non-GitHub host mismatch.
        try {
          const parsedFetch = new URL(trimmedFetch);
          if (
            parsedFetch.protocol === "ssh:" &&
            !GITHUB_HOSTS.has(parsedFetch.hostname.toLowerCase()) &&
            parsedFetch.hostname !== "" &&
            !isIPv4Address(parsedFetch.hostname) &&
            !isLikelyRealDomain(parsedFetch.hostname)
          ) {
            // ssh:// URL with a non-GitHub, non-IP, alias-style hostname — may be an SSH config alias.
            // Real domains (e.g. gitlab.com with a letters-only TLD) are rejected above by the else branch.
            const urlUser = parsedFetch.username;
            if (urlUser !== "" && urlUser.toLowerCase() !== "git") {
              // Explicit non-git user — reject outright.
              errors.push(
                `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            } else if (parsedFetch.password !== "" || parsedFetch.search !== "" || parsedFetch.hash !== "") {
              // Extra URL components (password, query string, fragment) are not valid for SSH alias
              // fetch URLs. Git never uses them for remote access, but they could carry credentials.
              errors.push(
                `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            } else {
              let fetchAliasToGitHub = false;
              try {
                const sshAlias = parsedFetch.hostname; // preserve case for OpenSSH Host matching
                const sshTarget = urlUser ? `${urlUser}@${sshAlias}` : sshAlias;
                // Mirror Git's argument order: URL port (-p) is appended after the configured SSH
                // command args, so OpenSSH reports the first -p as effective. Passing it here lets
                // ssh -G select the correct Host block and report the true effective port.
                const portArgsFetch = parsedFetch.port !== "" ? ["-p", parsedFetch.port] : [];
                const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, ...portArgsFetch, "-G", sshTarget], sshRunOpts);
                if (sshG.code === 0) {
                  const sshGLines = sshG.stdout.split("\n");
                  const hl = sshGLines.find((l) => l.toLowerCase().startsWith("hostname "));
                  const resolvedHost = hl ? hl.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
                  const pl = sshGLines.find((l) => l.toLowerCase().startsWith("port "));
                  const resolvedPort = pl ? pl.slice("port ".length).trim() : null;
                  const ul = sshGLines.find((l) => l.toLowerCase().startsWith("user "));
                  const resolvedUser = ul ? ul.slice("user ".length).trim() : null;
                  const userOk = resolvedUser === "git";
                  // Trust the port reported by ssh -G; the URL port was already passed via -p so
                  // ssh selects the correct Host block and reports the effective port directly.
                  if (resolvedHost === "github.com") {
                    fetchAliasToGitHub = (resolvedPort === "22" || resolvedPort === null) && userOk;
                  } else if (resolvedHost === "ssh.github.com") {
                    fetchAliasToGitHub = resolvedPort === "443" && userOk;
                  }
                }
              } catch {
                // ssh not available or failed — conservatively reject.
              }
              if (!fetchAliasToGitHub) {
                errors.push(
                  `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              } else {
                const aliasPath = parsedFetch.pathname
                  .replace(/^\//, "")
                  .replace(/\/+$/, "")
                  .replace(/\.git$/i, "")
                  .toLowerCase();
                if (aliasPath !== expected) {
                  errors.push(
                    `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                  );
                }
              }
            }
          } else {
            // Parseable but normalizeRemote returned null → non-GitHub host or invalid config → reject.
            errors.push(
              `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
            );
          }
        } catch {
          // Malformed scheme URL (e.g., non-numeric port with embedded credentials) — the URL
          // is unusable and the origin is not verified; emit a redacted mismatch error so that
          // a valid push URL cannot mask an unverifiable fetch URL.
          errors.push(
            `git: ローカルリポの origin (${redactUrl(fetchUrl)}) が repo.remote (${repoSlug}) と一致しません`,
          );
        }
      }
    }

    // push URL が fetch URL と異なる場合（remote.origin.pushurl 設定時）を検証
    const pushR = await runner.run("git", ["-C", repoPath, "remote", "get-url", "--push", "--all", "origin"], opts);
    if (pushR.code === 0) {
      // Split on newlines without pre-trimming so that empty pushurl entries are preserved.
      // Git always appends a trailing newline; strip only that final empty element.
      const rawPushLines = pushR.stdout.split("\n");
      const pushLines =
        rawPushLines[rawPushLines.length - 1] === "" ? rawPushLines.slice(0, -1) : rawPushLines;
      const hasEmptyPushUrl = pushLines.some((u) => u.length === 0);
      const pushUrls = pushLines.filter((u) => u.length > 0);
      if (hasEmptyPushUrl || pushUrls.length === 0) {
        // remote.origin.pushurl が空文字に設定されていると exit 0 で URL なしになる。
        // この状態では git push が "no path specified" で失敗するため事前に拒否する。
        errors.push("git: origin に有効な push URL がありません（remote.origin.pushurl が空に設定されています）");
      } else {
        for (const pushUrl of pushUrls) {
          if (pushUrl === fetchUrl) continue;
          // A push URL with leading or trailing whitespace would cause `git push` to fail
          // even though normalizeRemote's internal trim() would otherwise report a match.
          if (pushUrl !== pushUrl.trim()) {
            errors.push(
              `git: origin の push URL に先頭または末尾の空白があります。git push はこの URL で失敗します（remote.origin.pushurl を確認してください）`,
            );
            continue;
          }
          const normalized = normalizeRemote(pushUrl);
          if (normalized !== null) {
            if (normalized !== expected) {
              errors.push(
                `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            } else {
              // Path matches — verify SSH push URLs carry an explicit 'git' user (Finding 2).
              // An empty SSH username causes git push to connect as the OS user, which GitHub rejects.
              try {
                const pp = new URL(pushUrl.trim());
                if (pp.protocol === "ssh:" && pp.username === "" && GITHUB_HOSTS.has(pp.hostname.toLowerCase())) {
                  let sshUserOk = false;
                  try {
                    const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, "-G", pp.hostname], sshRunOpts);
                    if (sshG.code === 0) {
                      const ul = sshG.stdout.split("\n").find((l) => l.toLowerCase().startsWith("user "));
                      sshUserOk = ul ? ul.slice("user ".length).trim() === "git" : false;
                    }
                  } catch {
                    // ssh not available — fall through to reject.
                  }
                  if (!sshUserOk) {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) は SSH ユーザーが指定されていません。` +
                        "GitHub SSH は 'git' ユーザーを要求します（ssh://git@github.com/... 形式を使用するか、SSH config に 'User git' を設定してください）",
                    );
                  }
                }
              } catch {
                // Not a parseable scheme URL — normalizeRemote accepted it via another branch.
              }
              // Finding 3: userless SCP push URL directly naming a GitHub host (e.g. github.com:owner/name.git).
              // new URL() does not parse it as an ssh: URL, so the block above does not apply.
              // OpenSSH defaults to the OS user when no User is specified; verify via ssh -G.
              const _pUlScpRaw = pushUrl.trim().match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
              if (_pUlScpRaw && !_pUlScpRaw[3].startsWith("//")) {
                const _pUlUser = _pUlScpRaw[1];
                const _pUlHost = _pUlScpRaw[2].toLowerCase();
                if (_pUlUser === undefined && GITHUB_HOSTS.has(_pUlHost) && _pUlHost !== "ssh.github.com") {
                  let sshUserOk = false;
                  try {
                    const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, "-G", _pUlHost], sshRunOpts);
                    if (sshG.code === 0) {
                      const ul = sshG.stdout.split("\n").find((l) => l.toLowerCase().startsWith("user "));
                      sshUserOk = ul ? ul.slice("user ".length).trim() === "git" : false;
                    }
                  } catch {
                    // ssh unavailable — conservatively reject.
                  }
                  if (!sshUserOk) {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) は SSH ユーザーが指定されていません。` +
                        "GitHub SSH は 'git' ユーザーを要求します（git@github.com:... 形式を使用するか、SSH config に 'User git' を設定してください）",
                    );
                  }
                }
              }
              // Finding 3 / Finding 4: verify direct GitHub SSH push URLs haven't been
              // HostName-redirected by SSH config, remapped to a non-standard port, or had their
              // user overridden to a non-git account by SSH command options.
              const directPushSsh = extractDirectGitHubSshTarget(pushUrl.trim());
              if (directPushSsh !== null) {
                try {
                  // Pass the URL's explicit port to ssh -G so the correct Host block is selected.
                  const portArgs3p = directPushSsh.explicitPort ? ["-p", directPushSsh.explicitPort] : [];
                  const sshG3p = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, ...portArgs3p, "-G", directPushSsh.target], sshRunOpts);
                  if (sshG3p.code === 0) {
                    const lines3p = sshG3p.stdout.split("\n");
                    const hl3p = lines3p.find((l) => l.toLowerCase().startsWith("hostname "));
                    const resolvedHost3p = hl3p ? hl3p.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
                    const pl3p = lines3p.find((l) => l.toLowerCase().startsWith("port "));
                    const resolvedPort3p = pl3p ? pl3p.slice("port ".length).trim() : null;
                    const ul3p = lines3p.find((l) => l.toLowerCase().startsWith("user "));
                    const resolvedUser3p = ul3p ? ul3p.slice("user ".length).trim() : null;
                    if (resolvedHost3p !== null && resolvedHost3p !== directPushSsh.expectedHost) {
                      // Allow the documented GitHub SSH-over-HTTPS setup where github.com is mapped
                      // to ssh.github.com at port 443 via SSH config HostName/Port directives.
                      const isGitHubSshOverHttpsRemapP =
                        resolvedHost3p === "ssh.github.com" &&
                        directPushSsh.expectedHost === "github.com" &&
                        resolvedPort3p === "443";
                      if (!isGitHubSshOverHttpsRemapP) {
                        errors.push(
                          `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                        );
                      }
                    } else if (resolvedHost3p !== null && resolvedPort3p !== null) {
                      // github.com accepts only port 22; ssh.github.com accepts only port 443.
                      // ssh -G was called with the URL's explicit port, so resolvedPort3p already
                      // reflects the effective port.
                      const expectedPort3p = directPushSsh.expectedHost === "ssh.github.com" ? "443" : "22";
                      if (resolvedPort3p !== expectedPort3p) {
                        errors.push(
                          `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                        );
                      }
                    }
                    // Finding 4: SSH command options can override the push URL user; GitHub only
                    // accepts user 'git'.
                    if (resolvedUser3p !== null && resolvedUser3p !== "git") {
                      errors.push(
                        `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                      );
                    }
                    if (isCustomSsh && (resolvedHost3p === null || resolvedUser3p === null)) {
                      errors.push(
                        `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                      );
                    }
                  } else if (isCustomSsh) {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                    );
                  }
                } catch {
                  if (isCustomSsh) {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                    );
                  }
                }
              }
            }
          } else {
            const trimmedPush = pushUrl.trim();
            // SCP format: [user@]host:path — user is optional (SSH config may specify User git).
            // Guard path against '//' to avoid matching scheme-based URLs.
            // Absolute-path SCP (git@alias:/owner/name) has a leading slash which we strip.
            const _pScpRaw = trimmedPush.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
            const pushScpMatch = _pScpRaw && !_pScpRaw[3].startsWith("//") ? _pScpRaw : null;
            if (pushScpMatch) {
              const pushUser = pushScpMatch[1];
              const rawPushHost = pushScpMatch[2]; // preserve original case for ssh -G (OpenSSH Host matching is case-sensitive)
              const pushHost = rawPushHost.toLowerCase();
              const rawPushPath = pushScpMatch[3];
              if (isIPv4Address(pushHost)) {
                errors.push(
                  `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              } else if (isLikelyRealDomain(pushHost)) {
                // Real non-GitHub domain — reject outright without ssh -G alias resolution.
                errors.push(
                  `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              } else {
                if (pushUser !== undefined && pushUser.toLowerCase() !== "git") {
                  errors.push(
                    `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                  );
                } else {
                  let pushAliasToGitHub = false;
                  try {
                    const sshTarget = pushUser ? `${pushUser}@${rawPushHost}` : rawPushHost;
                    const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, "-G", sshTarget], sshRunOpts);
                    if (sshG.code === 0) {
                      const sshGLines = sshG.stdout.split("\n");
                      const hl = sshGLines.find((l) => l.toLowerCase().startsWith("hostname "));
                      const resolvedHost = hl ? hl.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
                      const pl = sshGLines.find((l) => l.toLowerCase().startsWith("port "));
                      const resolvedPort = pl ? pl.slice("port ".length).trim() : null;
                      const ul = sshGLines.find((l) => l.toLowerCase().startsWith("user "));
                      const resolvedUser = ul ? ul.slice("user ".length).trim() : null;
                      // GitHub SSH only accepts user 'git'; reject aliases resolving to any other user.
                      const userOk = resolvedUser === "git";
                      // Accept github.com on port 22 (standard SSH) or ssh.github.com on port 443
                      // (SSH-over-HTTPS). Any other host, port, or non-git user is rejected.
                      if (resolvedHost === "github.com") {
                        pushAliasToGitHub = (resolvedPort === "22" || resolvedPort === null) && userOk;
                      } else if (resolvedHost === "ssh.github.com") {
                        pushAliasToGitHub = resolvedPort === "443" && userOk;
                      }
                    }
                  } catch {
                    // ssh not available or failed — conservatively reject.
                  }
                  if (!pushAliasToGitHub) {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                    );
                  } else {
                    const aliasPath = rawPushPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
                    if (aliasPath !== expected) {
                      errors.push(
                        `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                      );
                    }
                  }
                }
              }
            } else if (!trimmedPush.includes("://")) {
              // Local path — reject.
              errors.push(
                `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
              );
            } else {
              try {
                const parsedPush = new URL(trimmedPush);
                if (
                  parsedPush.protocol === "ssh:" &&
                  !GITHUB_HOSTS.has(parsedPush.hostname.toLowerCase()) &&
                  parsedPush.hostname !== "" &&
                  !isIPv4Address(parsedPush.hostname) &&
                  !isLikelyRealDomain(parsedPush.hostname)
                ) {
                  // ssh:// URL with a non-GitHub, non-IP, alias-style hostname — may be an SSH config alias.
                  // Real domains (e.g. gitlab.com) are rejected above by the else branch.
                  const purlUser = parsedPush.username;
                  if (purlUser !== "" && purlUser.toLowerCase() !== "git") {
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                    );
                  } else if (parsedPush.password !== "" || parsedPush.search !== "" || parsedPush.hash !== "") {
                    // Extra URL components (password, query string, fragment) are not valid for SSH alias
                    // push URLs. Git never uses them for remote access, but they could carry credentials.
                    errors.push(
                      `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                    );
                  } else {
                    let pushAliasToGitHub = false;
                    try {
                      const sshAlias = parsedPush.hostname; // preserve case for OpenSSH Host matching
                      const sshTarget = purlUser ? `${purlUser}@${sshAlias}` : sshAlias;
                      // Mirror Git's argument order: URL port (-p) is appended after the configured SSH
                      // command args, so OpenSSH reports the first -p as effective.
                      const portArgsPush = parsedPush.port !== "" ? ["-p", parsedPush.port] : [];
                      const sshG = await runner.run(gitSshCfg.sshBin, [...gitSshCfg.extraArgs, ...portArgsPush, "-G", sshTarget], sshRunOpts);
                      if (sshG.code === 0) {
                        const sshGLines = sshG.stdout.split("\n");
                        const hl = sshGLines.find((l) => l.toLowerCase().startsWith("hostname "));
                        const resolvedHost = hl ? hl.slice("hostname ".length).trim().replace(/\.+$/, "").toLowerCase() : null;
                        const pl = sshGLines.find((l) => l.toLowerCase().startsWith("port "));
                        const resolvedPort = pl ? pl.slice("port ".length).trim() : null;
                        const ul = sshGLines.find((l) => l.toLowerCase().startsWith("user "));
                        const resolvedUser = ul ? ul.slice("user ".length).trim() : null;
                        const userOk = resolvedUser === "git";
                        // Trust the port reported by ssh -G; the URL port was already passed via -p.
                        if (resolvedHost === "github.com") {
                          pushAliasToGitHub = (resolvedPort === "22" || resolvedPort === null) && userOk;
                        } else if (resolvedHost === "ssh.github.com") {
                          pushAliasToGitHub = resolvedPort === "443" && userOk;
                        }
                      }
                    } catch {
                      // ssh not available or failed — conservatively reject.
                    }
                    if (!pushAliasToGitHub) {
                      errors.push(
                        `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                      );
                    } else {
                      const aliasPath = parsedPush.pathname
                        .replace(/^\//, "")
                        .replace(/\/+$/, "")
                        .replace(/\.git$/i, "")
                        .toLowerCase();
                      if (aliasPath !== expected) {
                        errors.push(
                          `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                        );
                      }
                    }
                  }
                } else {
                  // Parseable but normalizeRemote returned null → non-GitHub host or invalid config → reject.
                  errors.push(
                    `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                  );
                }
              } catch {
                // Malformed scheme URL — report error without exposing raw URL (Finding 3).
                errors.push(
                  `git: origin の push URL (${redactUrl(pushUrl)}) が repo.remote (${repoSlug}) と一致しません`,
                );
              }
            }
          }
        }
      }
    } else {
      errors.push(`git: origin の push URL を取得できません（${pushR.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`git: origin 一致確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 gh 認証 ----
async function checkGhAuth(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const auth = await runner.run("gh", ["auth", "status"], { ...opts, timeoutMs: 60_000 });
    if (auth.code !== 0) {
      errors.push(`gh: 認証されていません（gh auth login を実行してください: ${auth.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`gh: 認証確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 push 権限 ----
async function checkPushPermission(
  runner: CommandRunner,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const push = await runner.run("gh", ["api", `repos/${repoSlug}`, "--jq", ".permissions.push"], { ...opts, timeoutMs: 60_000 });
    if (push.code !== 0) {
      errors.push(`gh: リポジトリ ${repoSlug} の権限を取得できません（${push.stderr.trim()}）`);
    } else if (push.stdout.trim() !== "true") {
      errors.push(`gh: リポジトリ ${repoSlug} への push 権限がありません`);
    }
  } catch (e) {
    errors.push(`gh: push 権限確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 ブランチ保護 ----
async function checkBranchProtection(
  runner: CommandRunner,
  repoSlug: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/branches/${branch}/protection`], { ...opts, timeoutMs: 60_000 });
    if (isHttp404(r)) return; // 保護なし = OK
    if (isFeatureUnavailable403(r)) return; // Free plan private リポ: 機能未提供 = 保護なし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチ保護を取得できません（${r.stderr.trim()}）`);
      return;
    }
    let parsed: {
      required_pull_request_reviews?: {
        required_approving_review_count?: number;
        bypass_pull_request_allowances?: {
          users?: Array<{ login: string }>;
          teams?: Array<{ slug: string }>;
          apps?: Array<{ slug: string }>;
        };
      };
      required_status_checks?: {
        contexts?: string[];
        checks?: Array<{ context: string }>;
      } | null;
      restrictions?: {
        users?: Array<{ login: string }>;
        teams?: Array<{ slug: string }>;
        apps?: Array<{ slug: string }>;
      } | null;
    };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: ブランチ保護のJSONを解析できません");
      return;
    }
    const reviewCount = parsed.required_pull_request_reviews?.required_approving_review_count ?? 0;
    if (reviewCount > 0) {
      errors.push(
        `gh: ブランチ '${branch}' は必須承認レビュー数が ${reviewCount} です。` +
          "ループに人間レビュアーが不在のためマージ不能になります（required_approving_review_count を 0 にしてください）",
      );
    }
    // When required_pull_request_reviews is set and restrictions == null, every actor
    // must go through a PR — UNLESS they appear in bypass_pull_request_allowances.users.
    // Team and app entries in bypass_pull_request_allowances cannot be verified at preflight
    // time (membership is not queryable), so we fail closed: only an explicit user entry for
    // the authenticated actor counts as a bypass (ES-452 Finding 2).
    if (parsed.required_pull_request_reviews != null && parsed.restrictions == null) {
      const allowances = parsed.required_pull_request_reviews.bypass_pull_request_allowances;
      const bypassUsers = (allowances?.users ?? []).map((u) => u.login);
      const login = await resolveAuthenticatedLogin(runner, opts);
      if (login == null || !bypassUsers.includes(login)) {
        errors.push(
          `gh: ブランチ '${branch}' は pull request を必須としています（required_pull_request_reviews）が、` +
            "push 制限（restrictions）がないため直接プッシュできません。" +
            "メモリコミットが永続化されないため、restrictions に認証ユーザーを追加するか " +
            "required_pull_request_reviews を無効にしてください",
        );
      }
    }
    // restrictions が設定されている場合、push/merge できる identity が allowlist に限定される。
    // カーネル §9.4 の NG 条件は「restrictions に認証ユーザー不在」。
    // 認証ユーザー（=push 権限保持者）が許可リストに含まれていれば restrictions があっても OK。
    // 含まれていない場合のみ、その identity からはマージできないため NG。
    if (parsed.restrictions != null) {
      const login = await resolveAuthenticatedLogin(runner, opts);
      if (login == null) {
        errors.push(
          `gh: ブランチ '${branch}' に push 制限（restrictions）がありますが、` +
            "認証ユーザー名を解決できず許可リストとの照合ができません（gh api user --jq .login を確認してください）",
        );
      } else {
        // When required_pull_request_reviews is also set, direct push is only allowed if
        // the user is in bypass_pull_request_allowances — restrictions alone is not enough
        // (ES-452 Finding 4).
        if (parsed.required_pull_request_reviews != null) {
          const bypassUsers = (
            parsed.required_pull_request_reviews.bypass_pull_request_allowances?.users ?? []
          ).map((u) => u.login);
          if (!bypassUsers.includes(login)) {
            errors.push(
              `gh: ブランチ '${branch}' は required_pull_request_reviews が設定されていますが、` +
                `認証ユーザー '${login}' が bypass_pull_request_allowances に含まれていないため直接プッシュできません。` +
                `bypass_pull_request_allowances に '${login}' を追加するか、required_pull_request_reviews を無効にしてください`,
            );
          }
        }
        const allowedUsers = (parsed.restrictions.users ?? []).map((u) => u.login);
        if (!allowedUsers.includes(login)) {
          errors.push(
            `gh: ブランチ '${branch}' の push 制限（restrictions）の許可リストに認証ユーザー '${login}' が含まれていません。` +
              "この identity からはマージできません。restrictions.users に '" + login + "' を追加してください",
          );
        }
      }
    }
    // required_status_checks blocks direct pushes because the memory commit has no CI
    // status attached (ES-452 Finding 5).
    if (parsed.required_status_checks != null) {
      const contexts = parsed.required_status_checks.contexts ?? [];
      const checks = parsed.required_status_checks.checks ?? [];
      if (contexts.length > 0 || checks.length > 0) {
        errors.push(
          `gh: ブランチ '${branch}' は必須ステータスチェックが設定されています（required_status_checks）。` +
            "メモリコミットは CI を経由しないため直接プッシュがブロックされます。" +
            "required_status_checks を無効にしてください",
        );
      }
    }
    // required_signatures requires all commits to be signed; the memory commit is unsigned
    // so the push would be rejected. GitHub exposes this setting through a separate endpoint
    // — it is NOT included in the GET /branches/{branch}/protection response (ES-452 Finding 3).
    const sigRes = await runner.run(
      "gh",
      ["api", `repos/${repoSlug}/branches/${branch}/protection/required_signatures`],
      { ...opts, timeoutMs: 60_000 },
    );
    if (!isHttp404(sigRes) && !isFeatureUnavailable403(sigRes) && sigRes.code === 0) {
      let sigData: { enabled?: boolean };
      try {
        sigData = JSON.parse(sigRes.stdout);
      } catch {
        sigData = {};
      }
      if (sigData.enabled) {
        errors.push(
          `gh: ブランチ '${branch}' はコミット署名必須が設定されています（required_signatures）。` +
            "メモリコミットは署名されないため直接プッシュがブロックされます。" +
            "required_signatures を無効にしてください",
        );
      }
    }
  } catch (e) {
    errors.push(`gh: ブランチ保護確認に失敗しました（${(e as Error).message}）`);
  }
}

// 認証ユーザーのログイン名を解決する（restrictions の許可リスト照合に使う）。
// 失敗時は null を返し、呼び出し側で照合不能として扱う。
async function resolveAuthenticatedLogin(
  runner: CommandRunner,
  opts: { cwd: string },
): Promise<string | null> {
  try {
    const r = await runner.run("gh", ["api", "user", "--jq", ".login"], { ...opts, timeoutMs: 60_000 });
    if (r.code !== 0) return null;
    const login = r.stdout.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

// 認証ユーザーの数値 ID を解決する（ruleset bypass_actors の actor_id 照合に使う）。
// 失敗時は null を返す。
async function resolveAuthenticatedId(
  runner: CommandRunner,
  opts: { cwd: string },
): Promise<number | null> {
  try {
    const r = await runner.run("gh", ["api", "user", "--jq", ".id"], { ...opts, timeoutMs: 60_000 });
    if (r.code !== 0) return null;
    const id = parseInt(r.stdout.trim(), 10);
    return isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

// ---- §9.4 rulesets ----
async function checkRulesets(
  runner: CommandRunner,
  repoSlug: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/rules/branches/${branch}`], { ...opts, timeoutMs: 60_000 });
    if (isHttp404(r)) return; // ルールセットなし = OK
    if (isFeatureUnavailable403(r)) return; // Free plan private リポ: 機能未提供 = ルールセットなし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチルールセットを取得できません（${r.stderr.trim()}）`);
      return;
    }
    let rules: Array<{
      type?: string;
      ruleset_id?: number;
      parameters?: { required_approving_review_count?: number };
    }>;
    try {
      rules = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: ブランチルールセットのJSONを解析できません");
      return;
    }
    if (!Array.isArray(rules)) return;
    // Lazy-resolve the authenticated user's numeric ID — at most one API call per
    // checkRulesets invocation (ES-452 Finding 6).
    let resolvedUserId: number | null | undefined = undefined;
    const getUserId = async (): Promise<number | null> => {
      if (resolvedUserId !== undefined) return resolvedUserId;
      resolvedUserId = await resolveAuthenticatedId(runner, opts);
      return resolvedUserId;
    };
    for (const rule of rules) {
      if (rule.type === "pull_request") {
        const count = rule.parameters?.required_approving_review_count ?? 0;
        if (count > 0) {
          errors.push(
            `gh: ブランチ '${branch}' のルールセット pull_request ルールが必須承認レビュー数 ${count} を要求しています。` +
              "ループに人間レビュアーが不在のためマージ不能になります",
          );
        } else {
          // The pull_request rule blocks direct push even with 0 required approvals.
          // Check if the authenticated user is in the ruleset's bypass_actors with
          // bypass_mode "always" — if so, direct push is permitted (ES-452 Finding 6).
          let hasBypass = false;
          if (rule.ruleset_id != null) {
            const userId = await getUserId();
            hasBypass = await checkRulesetBypassActors(runner, repoSlug, rule.ruleset_id, userId, opts);
          }
          if (!hasBypass) {
            errors.push(
              `gh: ブランチ '${branch}' のルールセット pull_request ルールが設定されています。` +
                "必須承認レビュー数が 0 であっても直接プッシュはブロックされるためメモリコミットが永続化されません。" +
                "このルールを削除するか、bypass list を設定して直接プッシュを許可してください",
            );
          }
        }
      } else if (rule.type === "required_status_checks") {
        // required_status_checks blocks direct pushes — no CI status is attached to the
        // memory commit (ES-452 Finding 3). Check bypass_actors first.
        let hasBypass = false;
        if (rule.ruleset_id != null) {
          const userId = await getUserId();
          hasBypass = await checkRulesetBypassActors(runner, repoSlug, rule.ruleset_id, userId, opts);
        }
        if (!hasBypass) {
          errors.push(
            `gh: ブランチ '${branch}' のルールセット required_status_checks ルールが設定されています。` +
              "メモリコミットは CI を経由しないため直接プッシュがブロックされます。" +
              "このルールを削除するか、bypass list を設定して直接プッシュを許可してください",
          );
        }
      } else if (rule.type === "required_signatures") {
        // required_signatures ruleset requires commits to be signed; the unsigned memory
        // commit would be rejected on push (ES-452 Finding 4). Check bypass_actors first.
        let hasBypass = false;
        if (rule.ruleset_id != null) {
          const userId = await getUserId();
          hasBypass = await checkRulesetBypassActors(runner, repoSlug, rule.ruleset_id, userId, opts);
        }
        if (!hasBypass) {
          errors.push(
            `gh: ブランチ '${branch}' のルールセット required_signatures ルールが設定されています。` +
              "メモリコミットは署名されないため直接プッシュがブロックされます。" +
              "このルールを削除するか、bypass list を設定して直接プッシュを許可してください",
          );
        }
      }
    }
  } catch (e) {
    errors.push(`gh: ブランチルールセット確認に失敗しました（${(e as Error).message}）`);
  }
}

// ルールセットの bypass_actors に有効なバイパス主体が含まれるか確認する。
// User タイプは actor_id === userId で照合し、それ以外のタイプ（Integration、OrganizationAdmin、
// RepositoryRole、Team、DeployKey）はプリフライト時に所属確認できないため存在すれば許可とみなす。
// bypass_mode は "always" と "exempt" の両方を受け付ける（ES-452 Finding 4）。
// 失敗時は false を返す（フェイルクローズ）。
async function checkRulesetBypassActors(
  runner: CommandRunner,
  repoSlug: string,
  rulesetId: number,
  userId: number | null,
  opts: { cwd: string },
): Promise<boolean> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/rulesets/${rulesetId}`], { ...opts, timeoutMs: 60_000 });
    if (r.code !== 0) return false;
    const ruleset: {
      bypass_actors?: Array<{ actor_id?: number; actor_type?: string; bypass_mode?: string }>;
    } = JSON.parse(r.stdout);
    const validModes = new Set(["always", "exempt"]);
    return (ruleset.bypass_actors ?? []).some((a) => {
      if (!validModes.has(a.bypass_mode ?? "")) return false;
      if (a.actor_type === "User") {
        return userId != null && a.actor_id === userId;
      }
      // Non-User actor types (Integration, OrganizationAdmin, RepositoryRole, Team, DeployKey):
      // membership cannot be verified at preflight time — fail closed (ES-452 Finding 5).
      return false;
    });
  } catch {
    return false;
  }
}

// ---- §9.5 gate_label ----
async function checkGateLabel(
  runner: CommandRunner,
  config: Config,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    // gh label list は既定 limit 30 のため使わない。labels API を --paginate で全件取得し大小無視で照合（カーネル §5.3）。
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/labels`, "--paginate", "--jq", ".[].name"], { ...opts, timeoutMs: 60_000 });
    if (r.code !== 0) {
      errors.push(`gh: リポジトリ ${repoSlug} のラベル一覧を取得できません（${r.stderr.trim()}）`);
      return;
    }
    const names = r.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .map((n) => n.toLowerCase());
    const gate = config.looppilot.gateLabel.toLowerCase();
    if (!names.includes(gate)) {
      errors.push(
        `gh: ゲートラベル '${config.looppilot.gateLabel}' がリポジトリ ${repoSlug} に存在しません。` +
          "LoopPilot を発火させるため、対象リポにこのラベルを作成してください",
      );
    }
  } catch (e) {
    errors.push(`gh: ゲートラベル確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.6 LOOPPILOT_AUTO_MERGE ----
async function checkAutoMerge(
  runner: CommandRunner,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run(
      "gh",
      ["api", `repos/${repoSlug}/actions/variables/LOOPPILOT_AUTO_MERGE`],
      { ...opts, timeoutMs: 60_000 },
    );
    if (isHttp404(r)) return; // 未設定 = false = OK
    if (r.code !== 0) {
      errors.push(`gh: Actions 変数 LOOPPILOT_AUTO_MERGE を取得できません（${r.stderr.trim()}）`);
      return;
    }
    let parsed: { value?: string };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: LOOPPILOT_AUTO_MERGE のJSONを解析できません");
      return;
    }
    const value = (parsed.value ?? "").trim().toLowerCase();
    if (value === "true") {
      errors.push(
        "gh: Actions 変数 LOOPPILOT_AUTO_MERGE が 'true' です。" +
          "LoopPilot OS が唯一のマージャーであるため false（または未設定）にしてください",
      );
    }
  } catch (e) {
    errors.push(`gh: LOOPPILOT_AUTO_MERGE 確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.9 state-comment 著者整合 R⊆C ----
async function checkStateCommentAuthors(
  runner: CommandRunner,
  config: Config,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  const C = config.looppilot.stateCommentAuthors;
  try {
    const r = await runner.run(
      "gh",
      ["api", `repos/${repoSlug}/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS`],
      { ...opts, timeoutMs: 60_000 },
    );

    // R = リポが実際に書き手として使う著者集合（= LoopPilot が信頼コメントの著者に使う集合）
    let R: string[];
    if (isHttp404(r)) {
      // 未設定 → リポ既定 writer は github-actions[bot]（state-manager.ts の DEFAULT_TRUSTED_STATE_AUTHOR）
      R = ["github-actions[bot]"];
    } else if (r.code !== 0) {
      errors.push(`gh: Actions 変数 LOOPPILOT_STATE_COMMENT_AUTHORS を取得できません（${r.stderr.trim()}）`);
      return;
    } else {
      let parsed: { value?: string };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        errors.push("gh: LOOPPILOT_STATE_COMMENT_AUTHORS のJSONを解析できません");
        return;
      }
      // LoopPilot と同一パース（カンマ区切り → trim → 空除去）。空なら既定にフォールバック。
      const fromVar = parseAuthors(parsed.value ?? "");
      R = fromVar.length > 0 ? fromVar : ["github-actions[bot]"];
    }

    // R ⊆ C を要求（リポの全 writer を config の信頼集合 C が包含）。
    // 1つでも欠ければ Monitor が信頼コメントを発見できず monitor_never_engaged で全停止する。
    const missing = R.filter((author) => !C.includes(author));
    if (missing.length > 0) {
      errors.push(
        `設定不整合: config.looppilot.state_comment_authors が リポジトリの state-comment 著者 [${missing.join(", ")}] を含みません。` +
          "Monitor が信頼コメントを発見できず monitor_never_engaged で全停止します。" +
          `config.looppilot.state_comment_authors に [${R.join(", ")}] を含めてください`,
      );
    }
  } catch (e) {
    errors.push(`gh: state-comment 著者整合の確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.7 Linear 解決 ----
async function checkLinear(deps: PreflightDeps, errors: string[]): Promise<void> {
  const { config, fetchFn } = deps;
  // config.linear.states は camelCase。resolveLinearSetup の stateNames は TicketState キー。明示写像する。
  const stateNames: Record<TicketState, string> = {
    todo: config.linear.states.todo,
    in_progress: config.linear.states.inProgress,
    in_review: config.linear.states.inReview,
    done: config.linear.states.done,
  };
  const req: LinearSetupRequest = {
    teamKey: config.linear.team,
    projectName: config.linear.project,
    stateNames,
    optInLabel: config.linear.optInLabel,
  };
  try {
    // resolveLinearSetup: viewer 取得（APIキー検証）/ team・project・4状態・opt_in_label の解決。
    // いずれか解決不能なら欠落を 1 回でまとめて throw する契約（task-source.ts）。
    await resolveLinearSetup(config.linearApiKey, req, fetchFn);
  } catch (e) {
    errors.push(`Linear: セットアップ解決に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.8 claude 起動可 + 認証確認 ----
async function checkClaude(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const ver = await runner.run("claude", ["--version"], opts);
    if (ver.code !== 0) {
      errors.push(`claude: 起動できません（${ver.stderr.trim()}）`);
      return;
    }
    const auth = await runner.run("claude", ["auth", "status", "--json"], opts);
    // ログアウト時は exit code 1（公式リファレンス）かつ stdout は {"loggedIn":false} を返す。
    // exit code で早期 return すると本来の remediation（claude auth login）に到達できないため、
    // 先に stdout の JSON をパースし loggedIn フィールドで判定する（ES-416 の設計契約）。
    let parsed: { loggedIn?: boolean };
    try {
      parsed = JSON.parse(auth.stdout);
    } catch {
      // JSON が得られない場合のみ、コマンド失敗（非ゼロ exit）を実行失敗として扱う。
      if (auth.code !== 0) {
        errors.push(`claude: 認証状態を取得できません（${auth.stderr.trim()}）`);
      } else {
        errors.push(`claude: 認証状態を判定できません（claude auth status の出力をパースできません: ${auth.stdout.trim()}）`);
      }
      return;
    }
    if (parsed.loggedIn !== true) {
      errors.push("claude: 認証されていません（claude auth login を実行してください）");
    }
  } catch (e) {
    errors.push(`claude: 認証確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- ES-385: bypassPermissions 時の非 root チェック ----
function checkNonRoot(deps: PreflightDeps, errors: string[]): void {
  if (deps.config.agent.permissionMode !== "bypassPermissions") return;
  const uid = deps.getuid?.();
  if (uid === undefined) return;
  if (uid === 0) {
    errors.push(
      "security: bypassPermissions モードでの root 実行は禁止されています。" +
        "非 root ユーザーでコンテナ/VM を実行してください",
    );
  }
}

// ---- §9.10 Slack 到達可 ----
async function checkSlack(deps: PreflightDeps, errors: string[]): Promise<void> {
  // 未設定なら probeReachability は即 resolve（notifier.ts / Task 6 契約）。設定済みで非2xx/network なら throw。
  try {
    await deps.notifier.probeReachability();
  } catch (e) {
    errors.push(`Slack: Webhook へ到達できません（${(e as Error).message}）`);
  }
}
