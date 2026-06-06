import type { CommandRunner, CommandResult, Notifier, TicketState } from "./types.js";
import type { Config } from "./config.js";
import type { FetchFn, LinearSetupRequest } from "./task-source.js";
import { resolveLinearSetup } from "./task-source.js";

export interface PreflightDeps {
  config: Config;
  runner: CommandRunner;
  notifier: Notifier;
  fetchFn: FetchFn;
}

// gh api は HTTP エラー時 code != 0 で終了し、stderr に "(HTTP 404)" 等を含む。
// 404 を「存在しない」シグナルとして識別する（branch protection / actions variable で必須）。
function isHttp404(r: CommandResult): boolean {
  return r.code !== 0 && /\(HTTP 404\)/.test(r.stderr);
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
  const opts = { cwd: repoPath };

  // カーネル §9: 全項目を実行して集約。各 check 内で try/catch し、途中 throw しない。
  await checkGitClean(runner, repoPath, branch, opts, errors);          // §9.2
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
    const ls = await runner.run("git", ["-C", repoPath, "ls-remote", "origin", "HEAD"], opts);
    if (ls.code !== 0) {
      errors.push(`git: remote 'origin' に到達できません（${ls.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`git: remote 到達確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 gh 認証 ----
async function checkGhAuth(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const auth = await runner.run("gh", ["auth", "status"], opts);
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
    const push = await runner.run("gh", ["api", `repos/${repoSlug}`, "--jq", ".permissions.push"], opts);
    if (push.code !== 0) {
      errors.push(`gh: リポジトリ ${repoSlug} の権限を取得できません（${push.stderr.trim()}）`);
    } else if (push.stdout.trim() !== "true") {
      errors.push(`gh: リポジトリ ${repoSlug} への push 権限がありません`);
    }
  } catch (e) {
    errors.push(`gh: push 権限確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 ブランチ保護（Step 6 で本体を追加） ----
async function checkBranchProtection(
  _runner: CommandRunner, _repoSlug: string, _branch: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 6 で実装（先に Step 5 で赤テストを書く） */ }

// ---- §9.4 rulesets（Step 8 で本体を追加） ----
async function checkRulesets(
  _runner: CommandRunner, _repoSlug: string, _branch: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 8 で実装（先に Step 7 で赤テストを書く） */ }

// ---- §9.5 gate_label（Step 10 で本体を追加） ----
async function checkGateLabel(
  _runner: CommandRunner, _config: Config, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 10 で実装（先に Step 9 で赤テストを書く） */ }

// ---- §9.6 LOOPPILOT_AUTO_MERGE（Step 12 で本体を追加） ----
async function checkAutoMerge(
  _runner: CommandRunner, _repoSlug: string, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 12 で実装（先に Step 11 で赤テストを書く） */ }

// ---- §9.9 state-comment 著者整合 R⊆C（Step 14 で本体を追加） ----
async function checkStateCommentAuthors(
  _runner: CommandRunner, _config: Config, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 14 で実装（先に Step 13 で赤テストを書く） */ }

// ---- §9.7 Linear 解決（Step 16 で本体を追加） ----
async function checkLinear(_deps: PreflightDeps, _errors: string[]): Promise<void> {
  /* 本体は Step 16 で実装（先に Step 15 で赤テストを書く） */
}

// ---- §9.8 claude 起動可（Step 18 で本体を追加） ----
async function checkClaude(
  _runner: CommandRunner, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 18 で実装（先に Step 17 で赤テストを書く） */ }

// ---- §9.10 Slack 到達可（Step 18 で本体を追加） ----
async function checkSlack(_deps: PreflightDeps, _errors: string[]): Promise<void> {
  /* 本体は Step 18 で実装（先に Step 17 で赤テストを書く） */
}
