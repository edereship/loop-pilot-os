# LoopPilot OS v1 — 実装計画 共有カーネル（契約書）

> この文書は実装計画の全タスクが従う**唯一の共有契約**。型・インターフェース・DBスキーマ・外部コマンド契約・タスク分割をここで固定する。
> 仕様の source of truth: `docs/specs/design-spec-v1-core-loop.md`（§n 参照はこのファイル）。
> 計画タスクの本文がこのカーネルと矛盾する場合、**カーネルが正**。

## 0. 確定済み実装決定（2026-06-05 ユーザー確認済み）

| 項目 | 決定 |
| -- | -- |
| スタック | TypeScript strict / Node 24 / ESM (`"type": "module"`) / vitest / tsx。LoopPilot 本体と同一慣習 |
| SQLite | better-sqlite3（同期API）。テストは `:memory:` |
| 設定 | TOML（パーサ: `smol-toml`）+ zod 検証。シークレットは環境変数（`LINEAR_API_KEY`, `SLACK_WEBHOOK_URL`） |
| claude 起動 | CLI サブプロセス `claude -p`（`--output-format stream-json`, `--max-budget-usd`）。cwd=worktree |
| TDD | 全タスク red→green。モジュール境界は手書きフェイク。`vi.mock` 禁止。アダプタは fixture 検証 |
| 雛形 | git init + GitHub 私有リポ + CI 1本（`npm run check` = tsc×2 + vitest）。lint なし（LoopPilot 慣習） |
| CLI | bin `looppilot-os`、サブコマンド `run` / `status`、`--config <path>`（既定 `./looppilot-os.toml`）。引数解析は `node:util` の `parseArgs`（依存追加なし） |
| 実行時依存 | `better-sqlite3`, `smol-toml`, `zod` のみ。HTTP は Node 24 ネイティブ `fetch` |
| 外部 CLI 前提 | `git`, `gh`(認証済み), `claude`(認証済み)。プリフライトで検証 |

## 1. ファイル構成（最終形）

```
loop-pilot-os/
├── package.json                  # type:module, bin: {"looppilot-os": "./dist/main.js"}
├── tsconfig.json                 # strict, NodeNext, outDir dist, src のみ
├── tsconfig.test.json            # tests を含む typecheck 用
├── vitest.config.ts
├── .gitignore                    # node_modules, dist, *.db, looppilot-os.toml（実設定はコミットしない）
├── .github/workflows/ci.yml     # push/PR → npm ci && npm run check
├── looppilot-os.example.toml
├── README.md
├── docs/
│   ├── specs/design-spec-v1-core-loop.md
│   └── superpowers/plans/...
├── src/
│   ├── main.ts                   # CLI エントリ（run/status 分岐・config 読込・DI 組立）
│   ├── types.ts                  # 共有ドメイン型 + 全モジュールインターフェース（§2 を一字一句）
│   ├── config.ts                 # TOML 読込 + zod + env シークレット → Config
│   ├── exec.ts                   # CommandRunner（spawn ラッパ）
│   ├── store.ts                  # SqliteStore（schema + CRUD + ランロック + 通知intent）
│   ├── notifier.ts               # ConsoleSlackNotifier
│   ├── task-source.ts            # LinearTaskSource（GraphQL via fetch）
│   ├── git-pr.ts                 # GitPrManager（git/gh CLI）
│   ├── agent-runner.ts           # ClaudeAgentRunner（claude -p stream-json）
│   ├── monitor.ts                # GhLoopPilotMonitor（PR状態 + looppilot-state コメント）
│   ├── context-bundle.ts         # buildPrompt(args: PromptArgs): string
│   ├── orchestrator.ts           # Orchestrator（ループ・状態機械・安全弁・回復）
│   ├── preflight.ts              # runPreflight(deps) → PreflightError[]
│   └── status.ts                 # renderStatus(store) → string
└── tests/
    ├── fakes.ts                  # 全フェイク（§6）
    ├── fixtures/                 # gh/Linear/claude の実出力スナップショット
    ├── config.test.ts / store.test.ts / exec.test.ts / notifier.test.ts
    ├── task-source.test.ts / git-pr.test.ts / agent-runner.test.ts / monitor.test.ts
    ├── context-bundle.test.ts / orchestrator.test.ts / recovery.test.ts
    ├── preflight.test.ts / status.test.ts
```

インポートは ESM 相対 `./types.js` 形式（NodeNext）。テストから src へは `../src/types.js`。

## 2. src/types.ts — 共有型とインターフェース（全文・これが正）

```typescript
// ---- 状態語彙（仕様 §7） ----
export type SessionState =
  | "claimed" | "implementing" | "handing_off" | "in_review" | "merged" | "stopped";
export type RunState = "running" | "idle" | "halted";
export type FailureReason =
  | "agent_no_change"        // コミット無し/空差分/未コミット残骸（stop_detail で区別）
  | "cost_exceeded"
  | "exception"
  | "monitor_never_engaged"
  | "looppilot_stopped"      // stop_detail に LoopPilot の stopReason
  | "ci_failed"
  | "merge_conflict"
  | "pr_closed"
  | "claim_failed"
  | "handoff_failed";

// ---- ドメイン ----
export interface EligibleIssue {
  id: string;          // Linear UUID
  identifier: string;  // "TY-123"
  title: string;
  description: string; // markdown（空文字あり得る）
  priority: number;    // Linear生値: 0=None,1=Urgent,2=High,3=Medium,4=Low
  sortOrder: number;
  url: string;
}

export type TicketState = "todo" | "in_progress" | "in_review" | "done";

export interface RunRow {
  id: number;
  startedAt: string;        // ISO-8601 UTC
  taskCap: number;
  state: RunState;
  haltReason: string | null;
}

export interface TaskSessionRow {
  id: number;
  runId: number;
  linearIssueId: string;
  linearIdentifier: string;
  issueTitle: string;
  branch: string;
  worktreePath: string | null;
  prNumber: number | null;
  state: SessionState;
  costUsd: number | null;
  failureReason: FailureReason | null;
  stopDetail: string | null;     // looppilot stopReason / 例外メッセージ等
  agentSummary: string | null;
  startedAt: string;
  monitorStartedAt: string | null; // in_review 入り時刻。未起動ガード/監視timeoutの起点（再起動でリセットしない）
  endedAt: string | null;
}

// ---- モジュールインターフェース（仕様 §4） ----
export interface TaskSource {
  /** 適格(Team/PJ ∧ Todo ∧ オプトインラベル)を決定的順序で。excludeIds は Store 由来 */
  getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null>;
  transition(issueId: string, state: TicketState): Promise<void>;
  /** In Progress なのに渡された issueIds に無いチケット（CLAIM途中クラッシュ孤児）を返す */
  findOrphanedInProgress(knownIssueIds: string[]): Promise<EligibleIssue[]>;
}

export interface SessionContext {
  worktreePath: string;
  prompt: string;
  maxCostUsd: number;
}
export type AgentOutcome =
  | { kind: "completed"; costUsd: number; summary: string }
  | { kind: "cost_exceeded"; costUsd: number }
  | { kind: "error"; costUsd: number; message: string };
export interface AgentRunner {
  runSession(ctx: SessionContext): Promise<AgentOutcome>;
}

export interface ClaimResult { branch: string; worktreePath: string; }
export interface GitPrManager {
  prepareWorktree(issue: EligibleIssue): Promise<ClaimResult>;   // 失敗は throw
  hasCommitsWithDiff(worktreePath: string): Promise<boolean>;    // origin/<defaultBranch>..HEAD の実差分
  hasUncommittedChanges(worktreePath: string): Promise<boolean>; // git status --porcelain
  findOpenPrForBranch(branch: string): Promise<number | null>;
  pushAndOpenPr(branch: string, worktreePath: string, issue: EligibleIssue): Promise<number>;
  addLabel(prNumber: number, label: string): Promise<void>;
  mergePr(prNumber: number, headSha: string): Promise<void>;     // squash --match-head-commit
  discardWorktree(branch: string, worktreePath: string): Promise<void>; // cost_exceeded 時の破棄
}

/** 列挙順は precedence ではない。poll() の決定順は §5.4（merged 最優先）が正 */
export type MonitorVerdict =
  | { kind: "merged" }
  | { kind: "done" }            // looppilot-state.status=="done"（マージ可否は別判定）
  | { kind: "stopped"; stopReason: string | null }  // LoopPilot は stopped でも stopReason=null があり得る
  | { kind: "in_progress" }     // state コメントあり・進行中（initialized|waiting_codex|fixing）
  | { kind: "corrupted" }       // 信頼著者の state コメントは在るが JSON 破損/不正 status
  | { kind: "not_engaged" }     // 信頼できる state コメント未出現
  | { kind: "pr_closed" };      // マージ無しクローズ
export type MergeReadiness =
  | { ready: true; headSha: string }
  | { ready: false; reason: "ci_pending" | "ci_failed" | "conflict" | "blocked" | "unknown" };
export interface LoopPilotMonitor {
  poll(prNumber: number): Promise<MonitorVerdict>;
  checkMergeReadiness(prNumber: number): Promise<MergeReadiness>;
}

export type NotifyEvent =
  | { kind: "halted"; reason: string; detail: string }   // STOPPED→HALT / タスク上限
  | { kind: "idle"; detail: string }                      // キュー空
  | { kind: "run_started"; detail: string };              // 起動時
export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;  // コンソールは必ず成功。Slack失敗でも throw しない
  /** プリフライト専用: Slack設定時は Webhook へ直接POSTし非2xxで throw。未設定なら即resolve */
  probeReachability(): Promise<void>;
}

// ---- 文脈バンドル（context-bundle.ts） ----
export interface PromptArgs {
  goal: string;                                   // config.product.goal
  issue: EligibleIssue;
  digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
  // digest は store.recentMergedSummaries(config.digest.recentMergedCount) の戻り値そのまま
}
// context-bundle.ts は export function buildPrompt(args: PromptArgs): string を公開

// ---- 実行コマンド抽象（git/gh/claude 共通） ----
export interface CommandResult { code: number; stdout: string; stderr: string; }
export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  onStdoutLine?: (line: string) => void;  // stream-json 進捗用
  timeoutMs?: number;                      // 超過時 kill して reject
}
export interface CommandRunner {
  run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult>;
}
```

注: `StateStore` は具象 `SqliteStore`（§4）を直接使う（差し替え不要・テストは `:memory:`）。

## 3. Config（TOML スキーマ + zod）

`looppilot-os.example.toml`（全キー・既定値はコメントで明示）:

```toml
[product]
goal = "プロダクトのゴールと制約。毎セッションのプロンプト冒頭に入る"

[repo]
path = "/abs/path/to/target-repo"
remote = "owner/name"
default_branch = "main"
# worktree_root 省略時: ~/.looppilot-os/worktrees/<repoのdir名>

[linear]
# APIキーは環境変数 LINEAR_API_KEY（ファイルに書かない）
team = "TY"                     # team key
project = "LoopPilot OS"        # project 名（プリフライトで ID 解決・検証）
opt_in_label = "ai-ok"          # オプトインラベル名
[linear.states]                 # 状態名 → プリフライトで ID 解決
todo = "Todo"
in_progress = "In Progress"
in_review = "In Review"
done = "Done"

[agent]
model = "opus"                  # claude --model に渡す
allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"   # --allowedTools
# extra_args = []               # 任意の追加 claude フラグ（既定なし）

[handoff]
branch_prefix = "looppilot"
pr_body_template = """
Implements {identifier}: {title}

{issue_url}

🤖 Generated by LoopPilot OS
"""

[looppilot]
gate_label = "loop-pilot"                       # 対象リポの LOOPPILOT_LABEL に一致させる
state_comment_authors = ["github-actions[bot]"] # 信頼著者

[safety]
max_tasks_per_run = 3
max_cost_usd_per_session = 10.0
# monitor_timeout_minutes = 120  # 任意。既定オフ（コメントアウト）
not_engaged_guard_minutes = 30   # 常時オン

[loop]
monitor_poll_seconds = 60
idle_recheck_seconds = 300

[digest]
recent_merged_count = 5

[notify]
# Slack Webhook は環境変数 SLACK_WEBHOOK_URL（未設定ならコンソールのみ）
```

`loadConfig(path, env)` → zod 検証 → `Config` 型（camelCase、`linearApiKey`/`slackWebhookUrl` を env から注入、`stateDbPath` = config と同じディレクトリの `looppilot-os.db`、`worktreeRoot` 既定値解決済み）。検証エラーは全件まとめて throw。

## 4. SQLite スキーマ（store.ts、PRAGMA user_version=1, WAL）

```sql
CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  task_cap INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','idle','halted')),
  halt_reason TEXT
);
CREATE TABLE IF NOT EXISTS task_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  linear_issue_id TEXT NOT NULL,
  linear_identifier TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT,
  pr_number INTEGER,
  state TEXT NOT NULL CHECK (state IN
    ('claimed','implementing','handing_off','in_review','merged','stopped')),
  cost_usd REAL,
  failure_reason TEXT,
  stop_detail TEXT,
  agent_summary TEXT,
  started_at TEXT NOT NULL,
  monitor_started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_active ON task_session(state)
  WHERE state NOT IN ('merged','stopped');
CREATE TABLE IF NOT EXISTS notification_intent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,              -- NotifyEvent の JSON
  delivered_console INTEGER NOT NULL DEFAULT 0,
  delivered_slack INTEGER NOT NULL DEFAULT 0,  -- Slack未設定時は 1（=配信不要）
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);
```

`SqliteStore` 公開メソッド（同期、better-sqlite3）:

```typescript
class SqliteStore {
  constructor(dbPath: string);                       // ":memory:" 可
  close(): void;
  // run
  createRun(taskCap: number, now: string): RunRow;
  getRun(id: number): RunRow;
  latestRun(): RunRow | null;
  setRunState(id: number, state: RunState, haltReason?: string): void;
  countTasksStarted(runId: number): number;          // セッション行数 = CLAIM到達数
  countMerged(runId: number): number;                // state='merged' の実数（導出）
  // session
  createSession(s: { runId: number; linearIssueId: string; linearIdentifier: string;
    issueTitle: string; branch: string; worktreePath: string; now: string }): TaskSessionRow;
  getSession(id: number): TaskSessionRow;
  updateSession(id: number, patch: Partial<Pick<TaskSessionRow,
    "state" | "worktreePath" | "prNumber" | "costUsd" | "failureReason"
    | "stopDetail" | "agentSummary" | "monitorStartedAt" | "endedAt" | "runId">>): void;
  activeSessions(): TaskSessionRow[];                // state ∉ {merged,stopped}（全 run 横断）
  activeIssueIds(): string[];
  knownIssueIds(): string[];                         // 全セッションの issue id（孤児検出用）
  recentMergedSummaries(n: number): Array<Pick<TaskSessionRow,
    "linearIdentifier" | "issueTitle" | "agentSummary">>;
  sessionsForRun(runId: number): TaskSessionRow[];
  recentSessions(n: number): TaskSessionRow[];       // status CLI 用
  // notification intents
  recordIntent(payload: string, slackConfigured: boolean, now: string): number;
  markDelivered(id: number, channel: "console" | "slack"): void;
  bumpAttempts(id: number): void;
  undeliveredIntents(): Array<{ id: number; payload: string; attempts: number }>;
  // run lock（単一インスタンス）
  acquireRunLock(pid: number, isPidAlive: (pid: number) => boolean, now: string): boolean;
  releaseRunLock(pid: number): void;
}
```

## 5. 外部コマンド契約（実検証済みの呼び出し形・パース規則）

### 5.1 claude headless（agent-runner.ts）— v2.1.167 検証済み

```
claude -p <prompt>
  --output-format stream-json
  --verbose
  --max-budget-usd <safety.max_cost_usd_per_session>
  --permission-mode acceptEdits
  --allowedTools <agent.allowed_tools>
  --model <agent.model>
  (+ agent.extra_args)
```
spawn の `cwd` = worktree。stdout は NDJSON 1行1イベント:
- `{"type":"system","subtype":"init",...}` → セッション開始ログ
- `{"type":"assistant",...}` → コンソール進捗（短縮表示）
- 最終行 `{"type":"result","subtype":"success"|"error_max_budget"|...,"is_error":bool,"total_cost_usd":number,"result":"...","session_id":"..."}`

マッピング: `subtype=="success"` → completed（summary=result、2000字に切詰め）。`subtype が "error_max_budget" で始まる（実CLI v2.1.167 は "error_max_budget_usd"、exit code 1。予算判定は非0終了判定より先に評価する）` → cost_exceeded。その他/`is_error`/非0終了/result行欠落 → error。

> 修正 2026-06-06: 実CLIプローブにより --verbose 必須・subtype "error_max_budget_usd"・予算超過時 exit 1 を確認し、契約を実挙動へ修正（ユーザー承認済み）。

### 5.2 git（git-pr.ts）

- worktree作成: `git -C <repoPath> fetch origin <defaultBranch>` → `git -C <repoPath> worktree add -b <branch> <worktreePath> origin/<defaultBranch>`
- ブランチ名: `<prefix>/<identifier小文字>-<slug(title,30字)>`。slug = 英数字以外をハイフン圧縮。衝突（`git worktree add` 失敗 with "already exists"）→ `-2`..`-5` サフィックス、全滅で throw
- 実差分: `git -C <wt> rev-list --count origin/<defaultBranch>..HEAD` > 0 かつ `git -C <wt> diff --quiet origin/<defaultBranch>..HEAD` が非0（差分あり）
- 未コミット: `git -C <wt> status --porcelain` 非空
- push: `git -C <wt> push -u origin <branch>`
- 破棄: `git -C <repoPath> worktree remove --force <wt>` → `git -C <repoPath> branch -D <branch>`

### 5.3 gh（git-pr.ts / monitor.ts / preflight.ts）— gh 2.92.0

- PR作成: `gh pr create -R <owner/name> --base <defaultBranch> --head <branch> --title "<identifier>: <title>" --body <本文>`（spawn の引数配列で渡すためエスケープ不要・一時ファイル不要）→ stdout 末尾の URL から `/pull/(\d+)` でPR番号。draft にしない（Loop は labeled で発火しないため ready-for-review 必須）
- 既存PR検索: `gh pr list -R <o/n> --head <branch> --state open --json number`
- ラベル: `gh pr edit <n> -R <o/n> --add-label <gate_label>`
- PR状態: `gh pr view <n> -R <o/n> --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed`
  - merged: `mergedAt != null`（または state=="MERGED"）
  - closed未マージ: state=="CLOSED"
  - `checkMergeReadiness` の決定順（この順に評価し最初に成立したものを返す）: ① mergeable=="CONFLICTING" or mergeStateStatus=="DIRTY" → conflict ② statusCheckRollup に失敗 → ci_failed ③ 未完了チェックあり → ci_pending ④ 全チェック完了グリーン（空配列=チェック無し=グリーン扱い）かつ mergeStateStatus=="BLOCKED" → blocked（ブランチ保護/必須レビュー由来の恒久ブロック）⑤ mergeable=="MERGEABLE" → ready（headSha=headRefOid）⑥ それ以外 → unknown（見送り→次ポーリング）
    - statusCheckRollup は2形式が混在する（2026-06-07 是正）: **CheckRun**（`status`(QUEUED/IN_PROGRESS/COMPLETED)+`conclusion`）と **StatusContext**（legacy commit status。`status`/`conclusion` を持たず `state`(SUCCESS/PENDING/FAILURE/ERROR/EXPECTED)）。各チェックを green/failed/pending へ分類する: CheckRun は completed かつ conclusion ∉ {SUCCESS,NEUTRAL,SKIPPED} を failed・未 completed を pending; StatusContext は state を SUCCESS=green / PENDING・EXPECTED=pending / それ以外=failed。`status` のみで判定すると StatusContext を常に pending 扱いし、失敗見逃し＋恒久 ci_pending（done パスは timeout 無しで無限ハング）になる。
- コメント: `gh api repos/<o>/<n>/issues/<pr>/comments --paginate`（JSON配列、ページ連結に注意: `--paginate` は配列を連続出力するため `--slurp` を付け `[[...],[...]]` を flat する）
- マージ: `gh pr merge <n> -R <o/n> --squash --match-head-commit <headSha>`
- プリフライト: `gh auth status` / `gh api repos/<o>/<n>/labels --paginate --jq '.[].name'`（全ラベル取得し gate_label を大小無視で照合。`gh label list` は既定 limit 30 のため使わない）/ `gh api repos/<o>/<n>/actions/variables/LOOPPILOT_AUTO_MERGE`（404=未設定=false=OK、値が "true"（大小無視）なら NG）/ `gh api repos/<o>/<n>/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS`（404=未設定→リポ既定 `github-actions[bot]` を想定。値あり→LoopPilot と同一パース: カンマ区切り→trim→空除去）/ `gh api repos/<o>/<n> --jq .permissions.push`（true 必須）/ `gh api repos/<o>/<n>/branches/<default_branch>/protection`（404=保護なし=OK。200 で `required_pull_request_reviews.required_approving_review_count` > 0 は NG、`restrictions` に認証ユーザー不在も NG）/ `gh api repos/<o>/<n>/rules/branches/<default_branch>`（rulesets の pull_request ルールで required_approving_review_count > 0 も NG）

### 5.4 looppilot-state コメント（monitor.ts）— LoopPilot v1.5.1 ソース検証済み

信頼コメントの特定（`/home/racoma-dev/loop-pilot/src/state-manager.ts` と同一規則）:
1. author.login が `looppilot.state_comment_authors` のいずれかに一致
2. body が `LoopPilot state is stored in this comment.` で始まる
3. body が `<!-- looppilot-state` を含む
4. 複数あれば**最後**のもの（作成昇順の最後 = 最新）

state 抽出: 正規表現 `<!-- looppilot-state\n([\s\S]*?)\n-->` の捕捉グループを `JSON.parse`。`status` ∈ {initialized, waiting_codex, fixing, done, stopped}。`stopped` 時は `stopReason`（文字列 or null。null はそのまま verdict に保持し、変換しない）。

**poll() の verdict 決定順（唯一の検知式。この順に評価し、最初に成立したものを以降を読まず返す）**:
1. `gh pr view` で mergedAt != null（または state=="MERGED"）→ `{kind:"merged"}`（**最優先**。state コメントより先に判定する。stopped 後に人間/オーケがマージしたPRを誤って STOPPED にしない）
2. 未マージ ∧ state=="CLOSED" → `{kind:"pr_closed"}`
3. 信頼 state コメント（上記特定規則）が存在しパース成功:
   - status=="stopped" → `{kind:"stopped", stopReason}`
   - status=="done" → `{kind:"done"}`
   - status ∈ {initialized, waiting_codex, fixing} → `{kind:"in_progress"}`
4. 信頼著者コメントは存在するがパース不能/不正 status → `{kind:"corrupted"}`（未起動ガードを待たず即 STOPPED の対象）
5. 信頼コメント未出現 → `{kind:"not_engaged"}`（未起動ガードの対象）

### 5.5 Linear GraphQL（task-source.ts）— `https://api.linear.app/graphql`, header `Authorization: <LINEAR_API_KEY>`

- 適格チケット取得（1クエリ、client-side で決定的順序）:
```graphql
query Eligible($projectId: ID, $todoStateId: ID!, $label: String!) {
  issues(first: 50, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url } }
}
```
- 順序: priority を意味順位へ写像（1→0, 2→1, 3→2, 4→3, 0→4）昇順 → sortOrder 昇順 → id 昇順。excludeIds を除外して先頭。
- 遷移: `mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`
- 孤児検出: state=in_progress の issues を同フィルタ（label付き）で取得し knownIssueIds に無いもの。
- プリフライト解決: team key → team、`team.projects` から project 名 → projectId（ワークスペース横断の名前解決は同名 project が他チームにある場合に誤解決するため team スコープで解決。2026-06-06 是正）、`team.states` から4状態の stateId、`team.labels`+workspace labels から opt_in_label の存在。

## 6. tests/fakes.ts — フェイク契約（シグネチャ固定）

```typescript
export class FakeCommandRunner implements CommandRunner {
  /** ルール: [cmd, ...args] の前方一致で応答を返す。未登録は throw */
  on(cmdPrefix: string[], result: Partial<CommandResult> | ((args: string[], opts: RunOptions) => Partial<CommandResult>)): void;
  calls: Array<{ cmd: string; args: string[]; opts: RunOptions }>;
  run(cmd, args, opts): Promise<CommandResult>;
}
export class FakeTaskSource implements TaskSource { /* queue: EligibleIssue[], transitions 記録, 失敗注入 failNext(method) */ }
export class FakeAgentRunner implements AgentRunner { /* outcomes キュー, 呼び出し ctx 記録 */ }
export class FakeGitPr implements GitPrManager { /* 各メソッドの戻り値/例外を設定可, 呼び出し記録 */ }
export class FakeMonitor implements LoopPilotMonitor { /* poll() が verdicts 配列を順に返す, readiness 設定可 */ }
export class FakeNotifier implements Notifier { /* events: NotifyEvent[] に蓄積 */ }
export function fixedClock(start?: string): () => string; // 呼ぶ度 +1s の ISO 文字列
export function instantSleep(): (ms: number) => Promise<void>; // 即 resolve・呼び出し記録
```

## 7. Orchestrator Core 規約

- DI: `new Orchestrator({ config, source, agent, git, monitor, notifier, store, buildPrompt, clock, sleep, log })`。`buildPrompt: (args: PromptArgs) => string`（既定 context-bundle.ts の実装）, `clock: () => string`(ISO), `sleep: (ms) => Promise<void>`, `log: (line: string) => void`（既定 console.log）。
- `run()`: ランロック取得 → 新 Run 作成 → **回復処理（§9）** → ループ:
  1. タスク上限チェック（`countTasksStarted >= taskCap` → notify(halted/task_cap) → Run=halted → 終了）
  2. SELECT: `getNextEligible(activeIssueIds)`。null → notify(idle)（初回のみ）→ Run=idle → `sleep(idle_recheck_seconds*1000)` → 再確認（復帰したら Run=running）
  3. CLAIM: `prepareWorktree` → createSession(claimed) → `transition(in_progress)`。①失敗 → セッション行なしで notify+HALT（claim_failed 相当を Run.halt_reason へ）/ ②失敗 → discardWorktree + セッション stopped(claim_failed) + transition(todo) ベストエフォート → HALT
  4. IMPLEMENT: updateSession(implementing) → `store.recentMergedSummaries(config.digest.recentMergedCount)` → `buildPrompt({ goal: config.product.goal, issue, digest })` → `agent.runSession({ worktreePath, prompt, maxCostUsd: config.safety.maxCostUsdPerSession })`。後条件: cost_exceeded → updateSession({costUsd}) → discardWorktree → stopped(cost_exceeded) → HALT。error → updateSession({costUsd}) → stopped(exception, stop_detail=message) → HALT。completed → **まず updateSession({ costUsd, agentSummary: summary }) を永続化** → `hasUncommittedChanges` true → stopped(agent_no_change, stop_detail="uncommitted leftovers") → HALT。`hasCommitsWithDiff` false → stopped(agent_no_change) → HALT。両方パス → HANDOFF へ
  5. HANDOFF: updateSession(handing_off) → `findOpenPrForBranch`（あれば再利用）→ なければ `pushAndOpenPr` → **updateSession(prNumber) を即時** → `addLabel`（リトライ3回）→ `transition(in_review)`（リトライ3回）→ updateSession({ state: "in_review", monitorStartedAt: clock() })（同一 patch で原子的に。monitorStartedAt が未起動ガード/監視timeoutの起点）。途中失敗 → stopped(handoff_failed, stop_detail にPR番号明記) → HALT
  6. MONITOR: poll() は §5.4 の決定順で単一 verdict を確定済み（以下はその verdict への遷移であり再評価しない）。経過時間はすべて `clock() - monitorStartedAt` で算出（プロセス再起動でリセットしない）。ループ `sleep(monitor_poll_seconds*1000)` → `poll(pr)`:
     - merged → DONE へ
     - done → `checkMergeReadiness`: ready → `mergePr(pr, headSha)`。mergePr throw 時は次ポーリングで poll→done→checkMergeReadiness を再評価し、その reason で分類（conflict→stopped(merge_conflict) / ci_failed→stopped(ci_failed) / blocked→stopped(ci_failed, stop_detail="merge blocked by branch protection") / ci_pending・unknown→続行）。ready のまま mergePr が**2連続** throw → stopped(ci_failed, stop_detail="merge call failed under ready verdict: <error>")［fail-closed・既定理由を1つに固定］
       readiness が ci_pending・unknown → 続行 / ci_failed → stopped(ci_failed) / conflict → stopped(merge_conflict) / blocked → stopped(ci_failed, stop_detail="merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)")
     - stopped → stopped(looppilot_stopped, stop_detail=stopReason ?? "looppilot stopped (no reason)")
     - pr_closed → stopped(pr_closed)
     - corrupted → **即** stopped(monitor_never_engaged, stop_detail="looppilot-state comment present but corrupted")（ガード経過を待たない）
     - not_engaged → 経過 > not_engaged_guard_minutes → stopped(monitor_never_engaged)
     - in_progress → 続行（monitor_timeout_minutes 設定時は total 経過で stopped(exception, stop_detail="monitor timeout")）
     - poll() throw → バックオフ（poll間隔×2..×8）、5連続失敗 → stopped(exception)
  7. DONE: updateSession(merged, endedAt) → `transition(done)`（**best-effort** リトライ3回・既Done許容）。3回失敗してもコンソール警告のみで Run=running を維持し SELECT(1) へ進む（merged は永続化済みで二重マージは起きない。HALT しない — 仕様§5.6 に失敗遷移は無く、§7 の「stopped⇒halted 1:1」を保つ）。成功時はログに merged_count → 1 へ
- STOPPED の共通処理: updateSession(stopped, failureReason, stopDetail, endedAt［costUsd が判明している経路では併せて保存］) → notify(halted) → Run=halted → ループ終了。
- SIGINT: ハンドラで「次の安全点で停止」フラグ → 現フェーズ完了後 Run=halted(reason="user_interrupt") → ロック解放 → exit。

## 8. 回復処理（起動時、仕様 §9）

新 Run 作成後、`activeSessions()` を走査（外部状態の照合は**注入済み** `monitor.poll(prNumber)` で行う。生の gh コマンドは使わない）:
- `in_review` ∧ prNumber あり: `monitor.poll(prNumber)` の verdict で分岐 — merged → DONE 後段（merged 永続化 → transition(done)。カウンタは導出なので二重計上なし）/ pr_closed → stopped(pr_closed) / stopped → stopped(looppilot_stopped, stop_detail=stopReason) / それ以外（done・in_progress・corrupted・not_engaged = open 扱い）→ **runId を新Runへ付替えて MONITOR 再開**（採用。tasks_started に数える。monitor_started_at は**上書きしない**＝ガード・timeoutの経過は継続）。
- `claimed`/`implementing`/`handing_off`: `findOpenPrForBranch(branch)` で発見 → updateSession({ prNumber, state: "in_review", monitorStartedAt: 既存値 ?? clock() }) → 採用・MONITOR。なければ stopped(exception, stop_detail="crash recovery: no open PR; manual cleanup: <branch>, <worktree>, <identifier>") + notify(halted) → **HALT**（手動掃除を促す）。
- 孤児チケット: `findOrphanedInProgress(knownIssueIds())` → 各 issue を `transition(todo)` ベストエフォート + コンソール警告。
- 回復で HALT しなかった場合のみループ開始。

## 9. プリフライト（仕様 §8、fail-fast・全件収集して一括報告）

1. config 読込/zod（main で実施済み前提）
2. `git -C repo.path rev-parse --abbrev-ref HEAD` == default_branch ∧ `git status --porcelain` 空
3. `git -C repo.path ls-remote origin HEAD` 成功
4. `gh auth status` 成功 ∧ `.permissions.push` == true ∧ **デフォルトブランチを単独マージ可能**: `gh api repos/<o>/<n>/branches/<default_branch>/protection` が 404（保護なし）= OK / 200 で `required_pull_request_reviews.required_approving_review_count` > 0 は NG（ループに人間レビュアー不在のためマージ不能）、`restrictions` に認証ユーザー不在も NG。`gh api repos/<o>/<n>/rules/branches/<default_branch>` の pull_request ルールも同様に検査
5. GitHub: gate_label がリポラベルに存在（`gh api .../labels --paginate` で全件取得し大小無視照合）
6. GitHub: Actions variable `LOOPPILOT_AUTO_MERGE` 未設定 or "false"
7. Linear: viewer 取得成功（APIキー）/ team・project・4状態・opt_in_label 解決
8. `claude --version` 成功
9. state-comment 著者の整合: Actions variable `LOOPPILOT_STATE_COMMENT_AUTHORS` を取得し（404=未設定→リポは既定 writer `github-actions[bot]`）、未設定なら config.looppilot.state_comment_authors が `github-actions[bot]` を含むこと / 設定済みなら R ⊆ C（リポの全 writer 集合 R を config の信頼集合 C が包含）を要求。差分があれば「Monitor が信頼コメントを発見できず monitor_never_engaged で全停止する」旨の PreflightError
10. Slack: `SLACK_WEBHOOK_URL` 設定時は `notifier.probeReachability()`（Webhook へ直接POST、非2xxで PreflightError）。未設定ならコンソールのみで OK。run_started 通知の送信成功には依存しない

## 10. タスク分割（実装順・各タスクが計画の1章）

| # | タスク | 主ファイル | 仕様カバー |
| -- | -- | -- | -- |
| 1 | リポ雛形 + CI + GitHub私有リポ | package.json, tsconfig×2, vitest.config, ci.yml, .gitignore, example.toml(空殻), README(殻) | §0決定 |
| 2 | 共有型 types.ts | src/types.ts | §4/§7 語彙 |
| 3 | CommandRunner + Fake | src/exec.ts, tests/fakes.ts(一部), tests/exec.test.ts | 基盤 |
| 4 | Config | src/config.ts, tests/config.test.ts | §8設定 |
| 5 | State Store | src/store.ts, tests/store.test.ts | §7 |
| 6 | Notifier | src/notifier.ts, tests/notifier.test.ts | §10 |
| 7 | TaskSource (Linear) | src/task-source.ts, tests/task-source.test.ts | §5 SELECT/§6 |
| 8 | Git/PR Manager | src/git-pr.ts, tests/git-pr.test.ts | §5 CLAIM/HANDOFF |
| 9 | Agent Runner | src/agent-runner.ts, tests/agent-runner.test.ts | §5 IMPLEMENT/§11 |
| 10 | LoopPilot Monitor | src/monitor.ts, tests/monitor.test.ts | §6 |
| 11 | Context Bundle | src/context-bundle.ts, tests/context-bundle.test.ts | §3文脈 |
| 12 | Orchestrator: 正常系 | src/orchestrator.ts, tests/orchestrator.test.ts, tests/fakes.ts(残り) | §5 |
| 13 | Orchestrator: 失敗系+安全弁 | 同上に追記 | §5/§11 |
| 14 | 回復処理 | src/orchestrator.ts 追記, tests/recovery.test.ts | §9 |
| 15 | プリフライト | src/preflight.ts, tests/preflight.test.ts | §8 |
| 16 | Status CLI + main 配線 | src/status.ts, src/main.ts, tests/status.test.ts | §10/§12 |
| 17 | README + 手動E2E手順 | README.md, example.toml 完成 | §12 |

依存: 1→2→3→{4,5}→{6..11(順不同、各々 2/3/4/5 に依存)}→12→13→14→15→16→17。
各タスク末尾で `npm run check` グリーン → `git commit`。

## 11. 計画書フォーマット規約（writing-plans 準拠）

- 各ステップは 2-5 分粒度・チェックボックス。テスト→失敗確認→実装→成功確認→コミット。
- **コードは完全形**（プレースホルダ・「同様に」禁止）。コマンドは期待出力付き。
- ファイルパスは正確に。型・シグネチャは本カーネル §2/§4/§6 と一字一句一致。
- コミットメッセージは `feat:`/`test:`/`chore:` prefix。
