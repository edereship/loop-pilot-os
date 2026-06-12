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

// ---- §9.4 ブランチ保護 ----
async function checkBranchProtection(
  runner: CommandRunner,
  repoSlug: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/branches/${branch}/protection`], opts);
    if (isHttp404(r)) return; // 保護なし = OK
    if (isFeatureUnavailable403(r)) return; // Free plan private リポ: 機能未提供 = 保護なし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチ保護を取得できません（${r.stderr.trim()}）`);
      return;
    }
    let parsed: {
      required_pull_request_reviews?: { required_approving_review_count?: number };
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
        const allowedUsers = (parsed.restrictions.users ?? []).map((u) => u.login);
        if (!allowedUsers.includes(login)) {
          errors.push(
            `gh: ブランチ '${branch}' の push 制限（restrictions）の許可リストに認証ユーザー '${login}' が含まれていません。` +
              "この identity からはマージできません。restrictions.users に '" + login + "' を追加してください",
          );
        }
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
    const r = await runner.run("gh", ["api", "user", "--jq", ".login"], opts);
    if (r.code !== 0) return null;
    const login = r.stdout.trim();
    return login.length > 0 ? login : null;
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
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/rules/branches/${branch}`], opts);
    if (isHttp404(r)) return; // ルールセットなし = OK
    if (isFeatureUnavailable403(r)) return; // Free plan private リポ: 機能未提供 = ルールセットなし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチルールセットを取得できません（${r.stderr.trim()}）`);
      return;
    }
    let rules: Array<{ type?: string; parameters?: { required_approving_review_count?: number } }>;
    try {
      rules = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: ブランチルールセットのJSONを解析できません");
      return;
    }
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      if (rule.type === "pull_request") {
        const count = rule.parameters?.required_approving_review_count ?? 0;
        if (count > 0) {
          errors.push(
            `gh: ブランチ '${branch}' のルールセット pull_request ルールが必須承認レビュー数 ${count} を要求しています。` +
              "ループに人間レビュアーが不在のためマージ不能になります",
          );
        }
      }
    }
  } catch (e) {
    errors.push(`gh: ブランチルールセット確認に失敗しました（${(e as Error).message}）`);
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
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/labels`, "--paginate", "--jq", ".[].name"], opts);
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
      opts,
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
      opts,
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

// ---- §9.8 claude 起動可 ----
async function checkClaude(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const ver = await runner.run("claude", ["--version"], opts);
    if (ver.code !== 0) {
      errors.push(`claude: 起動できません（claude にログインしているか確認してください: ${ver.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`claude: バージョン確認に失敗しました（${(e as Error).message}）`);
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
