# LoopPilot OS v1（コアループ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LoopPilot の前後を回す自律開発オーケストレーター（ローカルCLI常駐ループ）を v1 コアループ仕様どおりに実装する — `SELECT(Linear) → CLAIM(worktree+branch) → IMPLEMENT(Claude Code headless) → HANDOFF(PR+loop-pilotラベル) → MONITOR → オーケがマージ → DONE → 次`。

**Architecture:** 疎結合・単一責任のモジュール群（Orchestrator Core / TaskSource(Linear) / Agent Runner(claude -p) / Git-PR Manager(git+gh) / LoopPilot Monitor / SQLite State Store / Notifier / Status CLI / Config）。Orchestrator Core がインターフェース越しに全フェーズを駆動し、失敗はすべて STOPPED→HALT で人間に上げる。状態の真実は SQLite。

**Tech Stack:** TypeScript strict / Node 24 / ESM / vitest / tsx / better-sqlite3 / smol-toml / zod。外部 CLI: git・gh・claude。TDD（モジュール境界は手書きフェイク、`vi.mock` 禁止）。

**正とする文書（優先順）:**
1. 設計仕様書: `docs/specs/design-spec-v1-core-loop.md`（Linear doc `b3057385-c2ca-480a-9c5c-d7bfefdf10cc` のスナップショット）
2. 本計画 Part 1 の共有カーネル（型・スキーマ・外部コマンド契約。タスク本文と矛盾したらカーネルが正）
3. 各タスク本文（Part 2）

**実装順:** Task 1→2→3→{4,5}→{6..11 順不同}→12→13→14→15→16→17。各タスク末尾で `npm run check` グリーン → コミット。

---

# Part 1: 共有カーネル（契約）

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
  - `checkMergeReadiness` の決定順（この順に評価し最初に成立したものを返す）: ① mergeable=="CONFLICTING" or mergeStateStatus=="DIRTY" → conflict ② statusCheckRollup に失敗（completed かつ conclusion ∉ {SUCCESS, NEUTRAL, SKIPPED}）→ ci_failed ③ 未完了チェックあり → ci_pending ④ 全チェック完了グリーン（空配列=チェック無し=グリーン扱い）かつ mergeStateStatus=="BLOCKED" → blocked（ブランチ保護/必須レビュー由来の恒久ブロック）⑤ mergeable=="MERGEABLE" → ready（headSha=headRefOid）⑥ それ以外 → unknown（見送り→次ポーリング）
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
- プリフライト解決: team key → team、project 名 → projectId、`team.states` から4状態の stateId、`team.labels`+workspace labels から opt_in_label の存在。

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

---

# Part 2: タスク詳細

### Task 1: リポ雛形 + CI + GitHub私有リポ

**目的**: LoopPilot OS v1 のリポジトリ雛形を作る。`package.json`（ESM・bin・LoopPilot同形 scripts・pin済み依存）、`tsconfig`×2（strict / NodeNext）、`vitest.config.ts`、`.gitignore`、CI 1本（`npm run check`）、`looppilot-os.example.toml`（カーネル§3完全転記）、README 骨子、空打ち回避の smoke テストを置き、`npm install` → `npm run check` グリーンを確認、git init → 初回コミット → `gh repo create` で私有リポ `loop-pilot-os` を作成・push する。

**依存タスク**: なし（最初のタスク）。本タスクは雛形のため TDD 例外（テスト先行なし）。ただし全ステップに検証コマンドと期待出力を付ける。

**カーネル参照**: §0（確定済み実装決定）、§1（ファイル構成）、§3（Config TOML 全文）。

**実検証済みの実物（2026-06-05）**:
- Node `v24.15.0` / gh `2.92.0` / claude `2.1.165`（いずれも認証済み）。
- 依存バージョン（`npm view <pkg> version` 当日実測。`^x.y.z` で pin）:
  - 実行時: `better-sqlite3@12.10.0`, `smol-toml@1.6.1`, `zod@4.4.3`
  - 開発: `typescript@6.0.3`, `vitest@4.1.8`, `tsx@4.22.4`, `@types/node@25.9.2`, `@types/better-sqlite3@7.6.13`
- LoopPilot 本体の慣習（踏襲元）: `tsconfig.json`（strict / outDir dist / rootDir src / `include:["src/**/*.ts"]`）、`tsconfig.test.json`（`extends:"./tsconfig.json"` / rootDir "." / noEmit / `include:["src/**/*.ts","tests/**/*.ts"]`）、`vitest.config.ts`（`include:["tests/**/*.test.ts"]`、`globals` オフ）、`ci.yml`（`actions/checkout@v5` + `actions/setup-node@v5` node 24 cache npm）、scripts `build/test/typecheck/typecheck:test/check`。
- 相違点メモ: LoopPilot は `module/moduleResolution: "Node16"` を使うが、カーネル§0 は明示的に **NodeNext** を要求するため本タスクでは `NodeNext` を採用する（NodeNext は Node16 の上位互換で `.js` 拡張子付き ESM 相対 import の挙動は同一）。

**作業ディレクトリ**: `/home/racoma-dev/loop-pilot-os`（`docs/` のみ存在。git 未初期化）。以降コマンドはすべて `git -C <abs>` 等の絶対パス指定で行い、`cd` を避ける。

#### Files

- Create: `/home/racoma-dev/loop-pilot-os/package.json`
- Create: `/home/racoma-dev/loop-pilot-os/tsconfig.json`
- Create: `/home/racoma-dev/loop-pilot-os/tsconfig.test.json`
- Create: `/home/racoma-dev/loop-pilot-os/vitest.config.ts`
- Create: `/home/racoma-dev/loop-pilot-os/.gitignore`
- Create: `/home/racoma-dev/loop-pilot-os/.github/workflows/ci.yml`
- Create: `/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml`
- Create: `/home/racoma-dev/loop-pilot-os/README.md`
- Create: `/home/racoma-dev/loop-pilot-os/src/main.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts`

---

- [ ] **Step 1: `package.json` を作成する**

`/home/racoma-dev/loop-pilot-os/package.json` を以下の完全な内容で作成する。`type:module`、bin `looppilot-os`→`dist/main.js`、scripts は LoopPilot 同形（`build`/`test`/`typecheck`/`typecheck:test`/`check`）。依存は当日実測値を `^` で pin。

```json
{
  "name": "loop-pilot-os",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "looppilot-os": "./dist/main.js"
  },
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "check": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json && vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "smol-toml": "^1.6.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^25.9.2",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: `tsconfig.json` を作成する**

`/home/racoma-dev/loop-pilot-os/tsconfig.json` を以下の完全な内容で作成する。strict、NodeNext（カーネル§0）、`outDir dist` / `rootDir src` / `include:["src/**/*.ts"]`。LoopPilot の慣習（`esModuleInterop`/`skipLibCheck`/`declaration`/`sourceMap` 等）を踏襲する。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: `tsconfig.test.json` を作成する**

`/home/racoma-dev/loop-pilot-os/tsconfig.test.json` を以下の完全な内容で作成する。LoopPilot 同形：base を extends し rootDir を `.` に広げ、`src` と `tests` を typecheck 対象にする（出力は出さない）。

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: `vitest.config.ts` を作成する**

`/home/racoma-dev/loop-pilot-os/vitest.config.ts` を以下の完全な内容で作成する。LoopPilot 同形：`globals` はオフ（各テストが `vitest` から明示 import する）、対象は `tests/**/*.test.ts`。

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストファイルは describe/it/expect/vi を "vitest" から明示 import するため
    // globals は付けない（グローバル名前空間の汚染回避。LoopPilot 同形）。
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: `.gitignore` を作成する**

`/home/racoma-dev/loop-pilot-os/.gitignore` を以下の完全な内容で作成する。カーネル§1 の指定どおり `node_modules` / `dist` / `*.db` / 実設定 `looppilot-os.toml` を除外する（`looppilot-os.example.toml` はコミットするので除外しない）。WAL 副生成物（`*.db-wal` / `*.db-shm`）も併せて無視する。

```gitignore
node_modules/
dist/

# SQLite 状態ストア（実 DB はコミットしない。WAL 副生成物含む）
*.db
*.db-wal
*.db-shm

# 実設定はコミットしない（example のみコミット）
looppilot-os.toml
```

- [ ] **Step 6: `.github/workflows/ci.yml` を作成する**

`/home/racoma-dev/loop-pilot-os/.github/workflows/ci.yml` を以下の完全な内容で作成する。push(main)/PR で発火し `npm ci && npm run check` を回す。actions のバージョンは LoopPilot の `ci.yml` に揃える（`actions/checkout@v5`、`actions/setup-node@v5`、node 24、`cache: npm`）。LoopPilot 固有の bundle/dist-drift ステップは LoopPilot OS には不要なので持たない。

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Check (typecheck src + tests + vitest)
        run: npm run check
```

- [ ] **Step 7: `looppilot-os.example.toml` を作成する**

`/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml` を以下の完全な内容で作成する。**カーネル§3 を一字一句完全転記**する（全キー・既定値・コメントを保持）。

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

- [ ] **Step 8: `README.md` 骨子を作成する**

`/home/racoma-dev/loop-pilot-os/README.md` を以下の完全な内容で作成する。プロジェクト1段落 + セットアップ手順の骨子。完成は Task 17（その旨を明記）。

```markdown
# LoopPilot OS

LoopPilot OS は、AIコーディングエージェント（Claude Code ヘッドレス）によるプロダクト開発ループを人間の都度指示なしで回すローカル CLI 常駐オーケストレーターです。Linear の適格チケットを選定し、worktree でエージェントを起動して実装・PR 作成まで行い、既存の [LoopPilot](https://github.com/) へ `loop-pilot` ラベルで受け渡し、クリーン到達（`looppilot-state` 隠しコメント）を検知して**オーケが**マージし、Linear チケットを Done にして次タスクへ進みます。キュー空 or タスク上限で通知して綺麗に停止します。状態はすべて SQLite に永続化され、再起動で「in_review + オープン PR」を照合して継続できます。

## 必要環境

- Node.js >= 24
- `git`
- `gh`（GitHub CLI、認証済み）
- `claude`（Claude Code CLI、認証済み）

## セットアップ（骨子。詳細は Task 17 で完成）

1. 依存をインストール: `npm install`
2. ビルド: `npm run build`
3. 設定ファイルを用意: `cp looppilot-os.example.toml looppilot-os.toml` し、各値を対象リポ/Linear に合わせて編集する。
4. シークレットを環境変数で渡す: `LINEAR_API_KEY`（必須）, `SLACK_WEBHOOK_URL`（任意・未設定ならコンソール通知のみ）。
5. 起動: `looppilot-os run --config ./looppilot-os.toml`
6. 状態確認: `looppilot-os status --config ./looppilot-os.toml`

## 開発

- 型チェック + テスト一括: `npm run check`
- テストのみ: `npm test`

> このセクションは骨子です。設定キーの詳細・プリフライト・手動 E2E 手順は Task 17 で記述します。
```

- [ ] **Step 9: `tests/smoke.test.ts` を作成する（空打ち回避）**

`/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts` を以下の完全な内容で作成する。Task 2 以降で実テストが入るまで vitest が「テスト 0 件」でエラーにならないようにするための一時ファイル。**Task 2 で削除する**旨をコメントに明記する。

```typescript
import { describe, it, expect } from "vitest";

// 雛形タスク用のプレースホルダ。Task 2（共有型 + 最初の実テスト）で削除する。
// vitest は対象テストが 0 件だと失敗するため、それを回避する空打ちだけを行う。
describe("smoke", () => {
  it("vitest が動作する", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 10: `src/main.ts` プレースホルダを作成する（tsc(src) の入力 0 件回避）**

`/home/racoma-dev/loop-pilot-os/src/main.ts` を以下の完全な内容で作成する。`tsconfig.json` の `include:["src/**/*.ts"]` が入力 0 件だと `tsc --noEmit` が `error TS18003: No inputs were found in config file` を出して exit 2 になり、`check`（`tsc --noEmit && ...`）が先頭で止まる（Step 12 の `npm run check` / Step 17 で検証する CI とも失敗）。これを回避するため `src/` 配下に最低 1 ファイルを置く。実 CLI エントリは Task 16 で本実装するため、ここでは ESM の空モジュールスタブにとどめる。

```typescript
// LoopPilot OS CLI エントリのプレースホルダ。
// tsconfig.json の include:["src/**/*.ts"] を入力 0 件にしないための雛形。
// 実装（run/status 分岐・config 読込・DI 組立）は Task 16 で本実装する。
export {};
```

検証: `ls /home/racoma-dev/loop-pilot-os/src/main.ts` がパスを返す。

- [ ] **Step 11: 依存をインストールする**

`/home/racoma-dev/loop-pilot-os` で依存をインストールする。

```bash
npm install --prefix /home/racoma-dev/loop-pilot-os
```

期待: `better-sqlite3`（ネイティブビルドあり）含め全依存が解決され、`added N packages` が出てエラーなく終了（exit 0）。`/home/racoma-dev/loop-pilot-os/node_modules` と `package-lock.json` が生成される。検証: `ls /home/racoma-dev/loop-pilot-os/package-lock.json` がパスを返す。

- [ ] **Step 12: `npm run check` グリーンを確認する**

型チェック（src + tests）と vitest を一括実行する。

```bash
npm run check --prefix /home/racoma-dev/loop-pilot-os
```

期待: `tsc --noEmit`（src。Step 10 の `src/main.ts` が入力 1 件として解決されるため TS18003 は出ない）と `tsc --noEmit -p tsconfig.test.json`（tests）がともにエラー 0 で通過し、vitest が smoke テスト 1 件を実行して成功する。出力末尾に概ね `Test Files  1 passed (1)` と `Tests  1 passed (1)` が表示され exit 0。失敗（型エラー or テスト失敗）なら該当ファイルを修正して再実行する。

- [ ] **Step 13: git リポジトリを初期化しデフォルトブランチを main にする**

`/home/racoma-dev/loop-pilot-os` を git リポジトリとして初期化する。

```bash
git -C /home/racoma-dev/loop-pilot-os init -b main
```

期待: `Initialized empty Git repository in /home/racoma-dev/loop-pilot-os/.git/` が出て exit 0。検証: `git -C /home/racoma-dev/loop-pilot-os rev-parse --abbrev-ref HEAD` が `main` を返す。

- [ ] **Step 14: 追跡対象を確認する（node_modules/dist が無視されること）**

`.gitignore` が効いて `node_modules` 等が追跡対象外であることを確認する。

```bash
git -C /home/racoma-dev/loop-pilot-os add -A && git -C /home/racoma-dev/loop-pilot-os status --short
```

期待: `??`/`A` 行に `node_modules/`・`dist/`・`*.db`・`looppilot-os.toml`・`package-lock.json` 以外…の確認。具体的には `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`, `looppilot-os.example.toml`, `README.md`, `src/main.ts`, `tests/smoke.test.ts`, `package-lock.json`, `docs/...` がステージされ、**`node_modules/` と `dist/` は出てこない**こと。もし `node_modules/` が現れたら `.gitignore` を見直す。

- [ ] **Step 15: 初回コミットを作成する**

雛形一式をコミットする。

```bash
git -C /home/racoma-dev/loop-pilot-os commit -m "chore: scaffold repo (package.json, tsconfig×2, vitest, ci, example config)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

期待: `[main (root-commit) <sha>] chore: scaffold repo ...` が出て exit 0。検証: `git -C /home/racoma-dev/loop-pilot-os log --oneline -1` が当該コミットを返す。

- [ ] **Step 16: GitHub 私有リポを作成して push する**

`gh` で私有リポ `loop-pilot-os` を作成し、`origin` を設定して push する。

```bash
gh repo create loop-pilot-os --private --source=/home/racoma-dev/loop-pilot-os --remote=origin --push
```

期待: `✓ Created repository <owner>/loop-pilot-os on GitHub`、`✓ Added remote ...`、`✓ Pushed commits to ...` が出て exit 0。前提として `gh auth status` が認証済み（実測: account `racoma-dev`）。

- [ ] **Step 17: リモート push と CI トリガを検証する**

リモートが設定され `main` が push 済みで、CI ワークフローが登録されていることを確認する。

```bash
git -C /home/racoma-dev/loop-pilot-os remote -v && git -C /home/racoma-dev/loop-pilot-os ls-remote --heads origin main && gh workflow list -R "$(gh repo view loop-pilot-os --json nameWithOwner -q .nameWithOwner)"
```

期待: `origin` が `*/loop-pilot-os` を指す（fetch/push の2行）、`ls-remote` が `main` の sha を1行返す、`gh workflow list` に `CI` が `active` で並ぶ。直近 run があれば `gh run list -R <owner>/loop-pilot-os -L 1` で確認できる（push 直後は queued/in_progress でよい）。これで Task 1 完了。


---

### Task 2: 共有型 types.ts

**目的**: カーネル §2 の TypeScript ブロックを `src/types.ts` として一字一句転記し、全後続タスク（3-17）が依存する共有ドメイン型・モジュールインターフェースの単一 source of truth を確定する。Task 1 が残した `tests/smoke.test.ts` を削除し、型が壊れたら `npm run check`（tsc）が失敗するよう、コンパイル時の型検証テスト（`satisfies` によるユニオン網羅・代入テスト・判別可能性）を `tests/types.test.ts` に置く。

**依存タスク**: Task 1（リポ雛形 + CI + tsconfig×2 + vitest.config + `tests/smoke.test.ts`）。本タスクはコード値を生成せず型のみを export するため、Task 3-17 はすべて本タスクの export に依存する（カーネル §10 の依存図 `1→2→3→...`）。

**Files:**

- Create: `/home/racoma-dev/loop-pilot-os/src/types.ts`
- Create: `/home/racoma-dev/loop-pilot-os/tests/types.test.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/types.test.ts`（型レベル検証。実行時アサーションは判別可能ユニオンの絞り込みのみ）
- Modify: なし（削除のみ。`/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts` を `git rm`）

すべての `git`/`npm` コマンドは `/home/racoma-dev/loop-pilot-os` をカレントとして実行する（Task 1 で `git init` 済み。`cd` を避けるため必要なら `git -C /home/racoma-dev/loop-pilot-os ...` / `npm --prefix /home/racoma-dev/loop-pilot-os run check` で代替してよい）。

#### ステップ

- [ ] **Step 1: `tests/smoke.test.ts` を削除する**

  Task 1 が CI を緑にするためだけに置いた仮テストを除去する。先に削除しておくことで、Step 4 で本タスクの型テストが「唯一の」テストとして失敗→成功する様子を観測できる。

  ```bash
  git rm tests/smoke.test.ts
  ```

  期待出力（ファイルが存在する場合）:
  ```
  rm 'tests/smoke.test.ts'
  ```

  もし Task 1 がスモークテストを別名で置いた、または置いていない場合は本ステップをスキップしてよい（その場合 `tests/` には本タスク後 `types.test.ts` のみが残る）。

- [ ] **Step 2: 失敗するテスト `tests/types.test.ts` を書く**

  `src/types.ts` がまだ存在しないため、import 解決に失敗してコンパイルエラー（= `npm run check` の tsc で失敗）になることを先に確認するためのテストを置く。テストは型レベル検証が中心で、`satisfies` でユニオンの網羅性を固定し、代入互換性で各インターフェースの構造を固定し、判別可能ユニオン（`AgentOutcome` / `MonitorVerdict` / `MergeReadiness` / `NotifyEvent`）の `kind`/`ready` による絞り込みを実行時にも 1 件アサートする。

  ファイル全文（`tests/types.test.ts`）:

  ```typescript
  import { describe, it, expect } from "vitest";
  import type {
    SessionState,
    RunState,
    FailureReason,
    EligibleIssue,
    TicketState,
    RunRow,
    TaskSessionRow,
    TaskSource,
    SessionContext,
    AgentOutcome,
    AgentRunner,
    ClaimResult,
    GitPrManager,
    MonitorVerdict,
    MergeReadiness,
    LoopPilotMonitor,
    NotifyEvent,
    Notifier,
    PromptArgs,
    CommandResult,
    RunOptions,
    CommandRunner,
  } from "../src/types.js";

  // 仕様 §7「状態語彙」: 各ユニオンのメンバを satisfies で固定する。
  // メンバの追加・削除・改名は satisfies の網羅で型エラーになり、tsc(npm run check)が落ちる。

  describe("状態語彙ユニオン（仕様 §7）", () => {
    it("SessionState は claimed/implementing/handing_off/in_review/merged/stopped の 6 値である", () => {
      const all = [
        "claimed",
        "implementing",
        "handing_off",
        "in_review",
        "merged",
        "stopped",
      ] as const satisfies readonly SessionState[];
      // 双方向固定: SessionState の各値が all に含まれることを exhaustive switch で保証する。
      const ensureExhaustive = (s: SessionState): (typeof all)[number] => {
        switch (s) {
          case "claimed":
          case "implementing":
          case "handing_off":
          case "in_review":
          case "merged":
          case "stopped":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(6);
    });

    it("RunState は running/idle/halted の 3 値である", () => {
      const all = ["running", "idle", "halted"] as const satisfies readonly RunState[];
      const ensureExhaustive = (s: RunState): (typeof all)[number] => {
        switch (s) {
          case "running":
          case "idle":
          case "halted":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(3);
    });

    it("FailureReason は仕様 §7 の 10 種の失敗理由を網羅する", () => {
      const all = [
        "agent_no_change",
        "cost_exceeded",
        "exception",
        "monitor_never_engaged",
        "looppilot_stopped",
        "ci_failed",
        "merge_conflict",
        "pr_closed",
        "claim_failed",
        "handoff_failed",
      ] as const satisfies readonly FailureReason[];
      // exhaustive switch で逆方向（FailureReason ⊆ all）も固定する。
      const ensureExhaustive = (r: FailureReason): (typeof all)[number] => {
        switch (r) {
          case "agent_no_change":
          case "cost_exceeded":
          case "exception":
          case "monitor_never_engaged":
          case "looppilot_stopped":
          case "ci_failed":
          case "merge_conflict":
          case "pr_closed":
          case "claim_failed":
          case "handoff_failed":
            return r;
          default: {
            const never: never = r;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(10);
    });

    it("TicketState は todo/in_progress/in_review/done の 4 値である", () => {
      const all = ["todo", "in_progress", "in_review", "done"] as const satisfies readonly TicketState[];
      const ensureExhaustive = (s: TicketState): (typeof all)[number] => {
        switch (s) {
          case "todo":
          case "in_progress":
          case "in_review":
          case "done":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(4);
    });
  });

  describe("ドメイン行型の構造（仕様 §7 データモデル / カーネル §4 スキーマ）", () => {
    it("EligibleIssue は Linear 由来の 7 フィールドを持つ", () => {
      const issue = {
        id: "11111111-2222-3333-4444-555555555555",
        identifier: "TY-123",
        title: "サンプル",
        description: "",
        priority: 2,
        sortOrder: 0.5,
        url: "https://linear.app/team-yubune/issue/TY-123",
      } satisfies EligibleIssue;
      expect(issue.identifier).toBe("TY-123");
    });

    it("RunRow は haltReason に null を許容する", () => {
      const row = {
        id: 1,
        startedAt: "2026-06-05T00:00:00.000Z",
        taskCap: 3,
        state: "running",
        haltReason: null,
      } satisfies RunRow;
      expect(row.haltReason).toBeNull();
    });

    it("TaskSessionRow は nullable 列（worktreePath/prNumber/costUsd/failureReason/stopDetail/agentSummary/monitorStartedAt/endedAt）を許容する", () => {
      const row = {
        id: 1,
        runId: 1,
        linearIssueId: "11111111-2222-3333-4444-555555555555",
        linearIdentifier: "TY-123",
        issueTitle: "サンプル",
        branch: "looppilot/ty-123-sample",
        worktreePath: null,
        prNumber: null,
        state: "claimed",
        costUsd: null,
        failureReason: null,
        stopDetail: null,
        agentSummary: null,
        startedAt: "2026-06-05T00:00:00.000Z",
        monitorStartedAt: null,
        endedAt: null,
      } satisfies TaskSessionRow;
      // 充填済みのバリアントも型を満たすこと（failureReason に FailureReason のメンバが入る）。
      const filled = {
        ...row,
        worktreePath: "/tmp/wt",
        prNumber: 42,
        state: "stopped" as const,
        costUsd: 1.5,
        failureReason: "cost_exceeded" as const,
        stopDetail: "budget",
        agentSummary: "did work",
        monitorStartedAt: "2026-06-05T00:01:00.000Z",
        endedAt: "2026-06-05T00:02:00.000Z",
      } satisfies TaskSessionRow;
      expect(filled.prNumber).toBe(42);
    });
  });

  describe("判別可能ユニオン（カーネル §2 / 仕様 §5-§6）", () => {
    it("AgentOutcome は kind で completed/cost_exceeded/error を判別できる", () => {
      const outcome: AgentOutcome = { kind: "completed", costUsd: 2, summary: "ok" };
      // 絞り込みで summary に到達できることを実行時にも確認する。
      const summary = outcome.kind === "completed" ? outcome.summary : null;
      expect(summary).toBe("ok");

      const variants = [
        { kind: "completed", costUsd: 2, summary: "ok" },
        { kind: "cost_exceeded", costUsd: 10 },
        { kind: "error", costUsd: 0, message: "boom" },
      ] as const satisfies readonly AgentOutcome[];
      expect(variants).toHaveLength(3);
    });

    it("MonitorVerdict は kind で 7 バリアントを判別でき、stopped は stopReason に null を保持できる（仕様 §6）", () => {
      // 列挙順は precedence ではない（カーネル §2 注記）。網羅性のみ固定する。
      const variants = [
        { kind: "merged" },
        { kind: "done" },
        { kind: "stopped", stopReason: null },
        { kind: "stopped", stopReason: "build failed" },
        { kind: "in_progress" },
        { kind: "corrupted" },
        { kind: "not_engaged" },
        { kind: "pr_closed" },
      ] as const satisfies readonly MonitorVerdict[];

      const describe = (v: MonitorVerdict): string => {
        switch (v.kind) {
          case "merged":
            return "merged";
          case "done":
            return "done";
          case "stopped":
            // stopReason は string | null（null をそのまま保持する）。
            return v.stopReason ?? "stopped(no reason)";
          case "in_progress":
            return "in_progress";
          case "corrupted":
            return "corrupted";
          case "not_engaged":
            return "not_engaged";
          case "pr_closed":
            return "pr_closed";
          default: {
            const never: never = v;
            return never;
          }
        }
      };
      expect(variants.map(describe)).toContain("stopped(no reason)");
    });

    it("MergeReadiness は ready の真偽で headSha 有無と reason を判別できる（カーネル §5.3）", () => {
      const ready: MergeReadiness = { ready: true, headSha: "abc123" };
      const headSha = ready.ready ? ready.headSha : null;
      expect(headSha).toBe("abc123");

      const reasons = [
        { ready: false, reason: "ci_pending" },
        { ready: false, reason: "ci_failed" },
        { ready: false, reason: "conflict" },
        { ready: false, reason: "blocked" },
        { ready: false, reason: "unknown" },
      ] as const satisfies readonly MergeReadiness[];
      expect(reasons).toHaveLength(5);
    });

    it("NotifyEvent は kind で halted/idle/run_started を判別できる（仕様 §10）", () => {
      const events = [
        { kind: "halted", reason: "task_cap", detail: "limit reached" },
        { kind: "idle", detail: "queue empty" },
        { kind: "run_started", detail: "started" },
      ] as const satisfies readonly NotifyEvent[];
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["halted", "idle", "run_started"]);
    });
  });

  describe("モジュールインターフェース（カーネル §2 / 仕様 §4）", () => {
    it("PromptArgs.digest は store.recentMergedSummaries の戻り型と同型である", () => {
      const args: PromptArgs = {
        goal: "ship it",
        issue: {
          id: "11111111-2222-3333-4444-555555555555",
          identifier: "TY-1",
          title: "t",
          description: "",
          priority: 0,
          sortOrder: 0,
          url: "https://x",
        },
        digest: [
          { linearIdentifier: "TY-0", issueTitle: "prev", agentSummary: "merged earlier" },
          { linearIdentifier: "TY-2", issueTitle: "prev2", agentSummary: null },
        ],
      };
      expect(args.digest).toHaveLength(2);
    });

    it("CommandResult / RunOptions / CommandRunner の構造を満たすフェイク実装が代入できる", () => {
      const result: CommandResult = { code: 0, stdout: "", stderr: "" };
      const opts: RunOptions = { cwd: "/repo" };
      const runner: CommandRunner = {
        run: async (_cmd: string, _args: string[], _opts: RunOptions): Promise<CommandResult> => result,
      };
      expect(opts.cwd).toBe("/repo");
      expect(runner.run).toBeTypeOf("function");
    });

    it("TaskSource / AgentRunner / GitPrManager / LoopPilotMonitor / Notifier はインターフェースを満たす実装に代入できる", () => {
      const eligible: EligibleIssue = {
        id: "11111111-2222-3333-4444-555555555555",
        identifier: "TY-1",
        title: "t",
        description: "",
        priority: 0,
        sortOrder: 0,
        url: "https://x",
      };
      const claim: ClaimResult = { branch: "looppilot/ty-1-t", worktreePath: "/tmp/wt" };
      const ctx: SessionContext = { worktreePath: "/tmp/wt", prompt: "p", maxCostUsd: 10 };
      const completed: AgentOutcome = { kind: "completed", costUsd: 1, summary: "ok" };
      const verdict: MonitorVerdict = { kind: "in_progress" };
      const readiness: MergeReadiness = { ready: false, reason: "ci_pending" };
      const event: NotifyEvent = { kind: "run_started", detail: "go" };

      const source: TaskSource = {
        getNextEligible: async (_excludeIds: string[]): Promise<EligibleIssue | null> => eligible,
        transition: async (_issueId: string, _state: TicketState): Promise<void> => {},
        findOrphanedInProgress: async (_knownIssueIds: string[]): Promise<EligibleIssue[]> => [],
      };
      const agent: AgentRunner = {
        runSession: async (_ctx: SessionContext): Promise<AgentOutcome> => completed,
      };
      const git: GitPrManager = {
        prepareWorktree: async (_issue: EligibleIssue): Promise<ClaimResult> => claim,
        hasCommitsWithDiff: async (_worktreePath: string): Promise<boolean> => true,
        hasUncommittedChanges: async (_worktreePath: string): Promise<boolean> => false,
        findOpenPrForBranch: async (_branch: string): Promise<number | null> => null,
        pushAndOpenPr: async (
          _branch: string,
          _worktreePath: string,
          _issue: EligibleIssue,
        ): Promise<number> => 1,
        addLabel: async (_prNumber: number, _label: string): Promise<void> => {},
        mergePr: async (_prNumber: number, _headSha: string): Promise<void> => {},
        discardWorktree: async (_branch: string, _worktreePath: string): Promise<void> => {},
      };
      const monitor: LoopPilotMonitor = {
        poll: async (_prNumber: number): Promise<MonitorVerdict> => verdict,
        checkMergeReadiness: async (_prNumber: number): Promise<MergeReadiness> => readiness,
      };
      const notifier: Notifier = {
        notify: async (_event: NotifyEvent): Promise<void> => {},
        probeReachability: async (): Promise<void> => {},
      };

      expect(ctx.maxCostUsd).toBe(10);
      expect(event.kind).toBe("run_started");
      expect(source.getNextEligible).toBeTypeOf("function");
      expect(agent.runSession).toBeTypeOf("function");
      expect(git.prepareWorktree).toBeTypeOf("function");
      expect(monitor.poll).toBeTypeOf("function");
      expect(notifier.notify).toBeTypeOf("function");
    });
  });
  ```

- [ ] **Step 3: テストを実行して失敗を確認する（red）**

  `src/types.ts` が未作成のため、tsconfig.test.json 経由の tsc が import 解決に失敗する。`npm run check` は「tsc(src) + tsc(tests) + vitest」（カーネル §0）なので、まず型チェックで落ちることを確認する。

  ```bash
  npm run check
  ```

  期待される失敗（いずれか／両方）:
  ```
  tests/types.test.ts(2,8): error TS2307: Cannot find module '../src/types.js' or its corresponding type declarations.
  ```
  （tsc が通った場合でも vitest 実行時に `Failed to resolve import "../src/types.js"` で失敗する。いずれにせよ `npm run check` は非 0 終了する。）

- [ ] **Step 4: `src/types.ts` を作成する（カーネル §2 を一字一句転記）**

  カーネル §2 の TypeScript ブロックをコメント込みで完全転記する。改名・引数追加・型変更は禁止（カーネルが正）。`StateStore` 注記（カーネル §2 末尾の散文）はコードブロック外なので転記しない。

  ファイル全文（`src/types.ts`）:

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

  注意（転記時の不変条件）:
  - 改行位置・コメント文言・記号（`∧`, `..`, 全角コロン等）まで一致させる。
  - これは型のみのモジュール（値の export ゼロ）。`isolatedModules`（NodeNext 既定で有効想定）下でも、本ファイルは型だけを export するため type-only re-export の問題は起きない。`tests/types.test.ts` 側の import は `import type { ... }` を使う。

- [ ] **Step 5: テストを実行して成功を確認する（green）**

  ```bash
  npm run check
  ```

  期待出力（tsc が src/tests とも 0 件エラー → vitest 緑）:
  ```
  Test Files  1 passed (1)
       Tests  N passed (N)
  ```
  （`N` は `tests/types.test.ts` 内の `it` 数。エラー 0・終了コード 0 であること。）

- [ ] **Step 6: コミットする（red→green 1 単位）**

  ```bash
  git add src/types.ts tests/types.test.ts
  git commit -m "feat: add shared domain types and module interfaces (types.ts)

  Transcribe kernel §2 verbatim into src/types.ts; replace smoke test with
  compile-time type checks (satisfies exhaustiveness, discriminated-union narrowing)."
  ```

  注: Step 1 の `git rm tests/smoke.test.ts` がまだステージされている場合は、本コミットに含めてよい（`git add -A` ではなく明示パスで `git add tests/smoke.test.ts` を加えるか、`git status` で削除がステージ済みであることを確認してからコミットする）。`npm run check` が緑であることを確認済みであること。


---

### Task 3: CommandRunner + FakeCommandRunner

**目的**: 全外部 CLI（git / gh / claude）呼び出しの唯一の土台となる `CommandRunner` を実装する。`node:child_process` の `spawn`（`shell: false`）で外部プロセスを起動し、stdout/stderr を蓄積、`onStdoutLine` でチャンク跨ぎの行バッファリングを伴う逐次行コールバックを供給し、`timeoutMs` 超過で kill→reject、終了コードは（非0でも）resolve する。あわせて以降の全タスクが DI に使うモジュール境界フェイク `FakeCommandRunner`、および Orchestrator 系タスク（最初の消費者は Task 6/12）が import する `fixedClock` / `instantSleep`（カーネル §6 シグネチャ）を `tests/fakes.ts` に新設する（§6 の他クラスは各タスクが追加）。

**依存タスク**: Task 1（リポ雛形・`npm run check`・vitest 設定・ESM/NodeNext）、Task 2（`src/types.ts` の `CommandResult` / `RunOptions` / `CommandRunner`）。

**カーネル契約（一字一句一致させる対象）**:
- `src/types.ts`（§2）:
  ```typescript
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
- `tests/fakes.ts`（§6）:
  ```typescript
  export class FakeCommandRunner implements CommandRunner {
    /** ルール: [cmd, ...args] の前方一致で応答を返す。未登録は throw */
    on(cmdPrefix: string[], result: Partial<CommandResult> | ((args: string[], opts: RunOptions) => Partial<CommandResult>)): void;
    calls: Array<{ cmd: string; args: string[]; opts: RunOptions }>;
    run(cmd, args, opts): Promise<CommandResult>;
  }
  ```

**設計メモ（検証済みの node:child_process 事実、v24.15.0）**:
- `spawn(cmd, args, { cwd, env, shell: false })` の `close` イベントは `(code: number | null, signal: NodeJS.Signals | null)` を渡す。正常終了は `code` が数値（非0でもそのまま resolve する）、シグナル kill 時は `code=null, signal="SIGKILL"`。
- 存在しないバイナリは `error` イベント（`code:"ENOENT"`）が先に発火し、その後 `close`（code=-2）も発火し得る。よって **`settled` フラグで二重 settle を防ぐ**。
- stdout はチャンク跨ぎで途中改行になり得る（例: `"line1\nli"`, `"ne2\nline3\n"`）。`onStdoutLine` は **完全な1行ごと**に呼ぶ必要があり、不完全な末尾はバッファに残す。close 時に残バッファ（非空）を最後の1行として flush する。
- `timeoutMs` は `setTimeout` で計測し、超過時 `child.kill("SIGKILL")` → reject。close での通常 settle は `settled` フラグで抑止。タイマは settle 時に必ず `clearTimeout` する。

---

#### サブタスク 3a: RealCommandRunner（正常系: 出力蓄積 + 終了コード resolve）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 1: 失敗するテストを書く（正常出力 + 非0コード）**
  `tests/exec.test.ts` を新規作成し、実プロセス（`node -e`）で stdout/stderr の蓄積と終了コードの resolve を検証する。

  `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts` を作成:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";

  describe("RealCommandRunner", () => {
    const runner = new RealCommandRunner();

    // 仕様: 外部プロセスの stdout/stderr を蓄積し、終了コードは resolve する（§5 外部コマンド契約の土台）
    it("正常終了で stdout/stderr を蓄積し code=0 で resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('out-data'); process.stderr.write('err-data')"],
        { cwd: process.cwd() },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("out-data");
      expect(result.stderr).toBe("err-data");
    });

    // 仕様: 非0終了コードでも reject せず、code を載せて resolve する（git diff --quiet 等の判定に必須）
    it("非0終了コードでも reject せず code を載せて resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('partial'); process.exit(3)"],
        { cwd: process.cwd() },
      );
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("partial");
      expect(result.stderr).toBe("");
    });
  });
  ```

- [ ] **Step 2: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `Failed to resolve import "../src/exec.js"`（`src/exec.ts` がまだ無いため import 解決エラー）。

- [ ] **Step 3: RealCommandRunner の最小実装を書く（正常系のみ）**
  `/home/racoma-dev/loop-pilot-os/src/exec.ts` を作成:
  ```typescript
  import { spawn } from "node:child_process";
  import type { CommandResult, CommandRunner, RunOptions } from "./types.js";

  export class RealCommandRunner implements CommandRunner {
    run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult> {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          shell: false,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (err: Error) => {
          settle(() => reject(err));
        });

        child.on("close", (code: number | null) => {
          settle(() => resolve({ code: code ?? -1, stdout, stderr }));
        });
      });
    }
  }
  ```

- [ ] **Step 4: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 2 tests passed（`正常終了で...` と `非0終了コードでも...`）。

- [ ] **Step 5: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: tsc（src）+ tsc（test）+ vitest が全てグリーン。

- [ ] **Step 6: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner accumulates output and resolves with exit code"`

---

#### サブタスク 3b: 行ストリーミング（onStdoutLine: チャンク跨ぎの行バッファリング）

**Files:**
- Modify: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 7: 失敗するテストを追加する（複数行 + チャンク分割 + 末尾 flush）**
  `tests/exec.test.ts` の `describe("RealCommandRunner", ...)` ブロック内、`非0終了コード...` の `it` の直後に以下 2 つの `it` を追加する。

  追加する `old_string`（直前の閉じ行を含めて一意に特定）:
  ```typescript
      expect(result.stderr).toBe("");
    });
  });
  ```
  を次に置換:
  ```typescript
      expect(result.stderr).toBe("");
    });

    // 仕様: stream-json 進捗用。完全な1行ごとに onStdoutLine を呼ぶ（複数行を順に供給）
    it("onStdoutLine に完全な行を順に供給する（複数行・全文も stdout に蓄積）", async () => {
      const lines: string[] = [];
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('a\\nb\\nc\\n')"],
        { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
      );
      expect(lines).toEqual(["a", "b", "c"]);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.code).toBe(0);
    });

    // 仕様: チャンク境界が行の途中に来てもバッファリングして1行に再構成する。
    // 末尾に改行が無い最終行は close 時に flush する。
    it("チャンク跨ぎの行を再構成し、改行無しの末尾も最終行として供給する", async () => {
      const lines: string[] = [];
      // 1チャンク目 'line1\nli' → 'line1' を供給し 'li' をバッファ
      // 2チャンク目（遅延）'ne2\nline3' → 'line2','line3' を供給（'line3' は close で flush）
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('line1\\nli'); setTimeout(() => process.stdout.write('ne2\\nline3'), 50)"],
        { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
      );
      expect(lines).toEqual(["line1", "line2", "line3"]);
      expect(result.stdout).toBe("line1\nline2\nline3");
    });
  });
  ```

- [ ] **Step 8: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: 新規 2 テストが失敗。`onStdoutLine` がまだ呼ばれないため `lines` が `[]` のままで `expected [] to deeply equal [ 'a', 'b', 'c' ]`（および2件目で `[ 'line1', 'line2', 'line3' ]`）の AssertionError。

- [ ] **Step 9: 行バッファリングを実装する**
  `src/exec.ts` の stdout `data` ハンドラを、行分割と flush を伴うものに差し替える。

  `old_string`:
  ```typescript
        let stdout = "";
        let stderr = "";
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (err: Error) => {
          settle(() => reject(err));
        });

        child.on("close", (code: number | null) => {
          settle(() => resolve({ code: code ?? -1, stdout, stderr }));
        });
  ```
  を次に置換:
  ```typescript
        let stdout = "";
        let stderr = "";
        let lineBuffer = "";
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        const emitLines = (): void => {
          if (!opts.onStdoutLine) return;
          let newlineIndex = lineBuffer.indexOf("\n");
          while (newlineIndex !== -1) {
            opts.onStdoutLine(lineBuffer.slice(0, newlineIndex));
            lineBuffer = lineBuffer.slice(newlineIndex + 1);
            newlineIndex = lineBuffer.indexOf("\n");
          }
        };

        const flushLines = (): void => {
          if (opts.onStdoutLine && lineBuffer.length > 0) {
            opts.onStdoutLine(lineBuffer);
            lineBuffer = "";
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          if (opts.onStdoutLine) {
            lineBuffer += text;
            emitLines();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (err: Error) => {
          settle(() => reject(err));
        });

        child.on("close", (code: number | null) => {
          flushLines();
          settle(() => resolve({ code: code ?? -1, stdout, stderr }));
        });
  ```

- [ ] **Step 10: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 4 tests passed（正常出力2件 + 行ストリーミング2件）。

- [ ] **Step 11: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: 全てグリーン。

- [ ] **Step 12: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner streams stdout lines with cross-chunk buffering"`

---

#### サブタスク 3c: timeoutMs 超過で kill→reject

**Files:**
- Modify: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 13: 失敗するテストを追加する（timeout kill）**
  `tests/exec.test.ts` の `describe("RealCommandRunner", ...)` ブロック末尾、最後の `it`（チャンク跨ぎ…）の閉じ `});` の直後・`describe` の閉じ `});` の直前に以下を追加する。

  `old_string`（最後の `it` の末尾と describe 閉じを含めて一意に特定）:
  ```typescript
      expect(result.stdout).toBe("line1\nline2\nline3");
    });
  });
  ```
  を次に置換:
  ```typescript
      expect(result.stdout).toBe("line1\nline2\nline3");
    });

    // 仕様: timeoutMs 超過時はプロセスを kill して reject する（claude/gh のハング対策）
    it("timeoutMs 超過時にプロセスを kill して reject する", async () => {
      await expect(
        runner.run(
          "node",
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 100 },
        ),
      ).rejects.toThrow(/timed out after 100ms/);
    });

    // 仕様: timeoutMs を設定しても、その範囲内に終わるプロセスは通常どおり resolve する
    it("timeoutMs 内に終わるプロセスは正常に resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('quick')"],
        { cwd: process.cwd(), timeoutMs: 5000 },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("quick");
    });
  });
  ```

- [ ] **Step 14: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `timeoutMs 超過時に...` が失敗。timeout 未実装のためプロセスは 10s 走り続け、vitest のテストタイムアウトで `Test timed out in 5000ms`（reject も `timed out after 100ms` の throw も起きない）。

- [ ] **Step 15: timeout（kill→reject）を実装する**
  `src/exec.ts` に timeout タイマを追加し、`settle` 時にタイマをクリアする。

  `old_string`:
  ```typescript
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
  ```
  を次に置換:
  ```typescript
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          fn();
        };

        if (opts.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            child.kill("SIGKILL");
            settle(() =>
              reject(
                new Error(
                  `command "${cmd}" timed out after ${String(opts.timeoutMs)}ms`,
                ),
              ),
            );
          }, opts.timeoutMs);
        }
  ```

  注: `setTimeout` のコールバックは `settle` を呼ぶが、`settle` 内で `clearTimeout(timeoutHandle)` を呼んでも既に発火済みのタイマには無害。`child.kill("SIGKILL")` 後の `close`（code=null, signal="SIGKILL"）は `settled=true` により無視される。

- [ ] **Step 16: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 6 tests passed（正常2 + 行ストリーミング2 + timeout2）。

- [ ] **Step 17: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: 全てグリーン。

- [ ] **Step 18: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner kills and rejects on timeoutMs"`

---

#### サブタスク 3d: FakeCommandRunner + fixedClock / instantSleep（tests/fakes.ts、カーネル §6 シグネチャ）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/tests/fakes.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

注: `tests/fakes.ts` は後続タスク（12/13/14 等）が他のフェイク（FakeTaskSource 等）を追記する共有ファイル。このタスクでは `FakeCommandRunner` と `fixedClock` / `instantSleep` を定義する（§6 の他クラスは各タスクが追加）。`fixedClock` / `instantSleep` は最初の消費者が Task 6（および Task 12）であり、ここで実装しておかないと import が解決できず red→green が成立しないため、本タスクで先取りして定義する。

- [ ] **Step 19: 失敗するテストを追加する（FakeCommandRunner の前方一致・未登録 throw・calls 記録・行供給）**
  `tests/exec.test.ts` の末尾（`describe("RealCommandRunner", ...)` の閉じ `});` の後、ファイル末尾）に新しい `describe` を追加する。import 行も先頭に追記する。

  まず import を更新する。`old_string`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";
  ```
  を次に置換:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";
  import { FakeCommandRunner, fixedClock, instantSleep } from "./fakes.js";
  ```

  次にファイル末尾（`RealCommandRunner` の `describe` 閉じ `});` の直後）に追加:
  ```typescript

  describe("FakeCommandRunner", () => {
    // 仕様(§6): [cmd, ...args] の前方一致で登録応答を返し、欠落フィールドは既定値で埋める
    it("前方一致で登録した応答を返し、欠落フィールドを既定値で埋める", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["gh", "pr", "view"], { stdout: '{"state":"OPEN"}' });

      const result = await fake.run(
        "gh",
        ["pr", "view", "42", "--json", "state"],
        { cwd: "/repo" },
      );
      expect(result).toEqual({ code: 0, stdout: '{"state":"OPEN"}', stderr: "" });
    });

    // 仕様(§6): 関数レスポンダは実引数と opts を受け取り Partial<CommandResult> を返す
    it("関数レスポンダに実引数と opts を渡す", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git", "rev-list"], (args) => ({ stdout: String(args.length) }));

      const result = await fake.run(
        "git",
        ["rev-list", "--count", "origin/main..HEAD"],
        { cwd: "/repo" },
      );
      expect(result.stdout).toBe("3");
      expect(result.code).toBe(0);
    });

    // 仕様(§6): 全呼び出しを calls に記録する
    it("全呼び出しを calls に記録する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git"], { stdout: "ok" });

      await fake.run("git", ["status", "--porcelain"], { cwd: "/repo" });

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toEqual({
        cmd: "git",
        args: ["status", "--porcelain"],
        opts: { cwd: "/repo" },
      });
    });

    // 仕様(§6): 未登録の呼び出しは throw する（テストが想定外コマンドに気づける）
    it("未登録の呼び出しは throw する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git"], { stdout: "ok" });

      await expect(
        fake.run("gh", ["pr", "view"], { cwd: "/repo" }),
      ).rejects.toThrow(/no FakeCommandRunner stub/);
    });

    // 仕様(§6): より長い前方一致が優先される（具体的な登録が一般的な登録を上書き）
    it("より長い前方一致を優先する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["gh"], { stdout: "generic" });
      fake.on(["gh", "pr", "merge"], { stdout: "specific" });

      const result = await fake.run(
        "gh",
        ["pr", "merge", "42", "--squash"],
        { cwd: "/repo" },
      );
      expect(result.stdout).toBe("specific");
    });

    // 仕様(§6): onStdoutLine が設定されていれば stub の stdout を改行で分割して逐次供給する
    it("onStdoutLine に stub stdout の各行を供給する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["claude"], { stdout: '{"type":"system"}\n{"type":"result"}\n' });

      const lines: string[] = [];
      await fake.run("claude", ["-p", "hi"], {
        cwd: "/wt",
        onStdoutLine: (line) => lines.push(line),
      });
      expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
    });
  });

  describe("fixedClock", () => {
    // 仕様(§6): clock() は呼ぶ度に +1s 進んだ ISO 文字列を返す（決定的タイムスタンプ）
    it("連続呼び出しで 1 秒ずつ進む ISO 文字列を返す", () => {
      const clock = fixedClock("2026-06-06T00:00:00.000Z");
      expect(clock()).toBe("2026-06-06T00:00:00.000Z");
      expect(clock()).toBe("2026-06-06T00:00:01.000Z");
      expect(clock()).toBe("2026-06-06T00:00:02.000Z");
    });

    // 仕様(§6): start 引数で初回の基準時刻を指定できる
    it("start 引数で初回の基準時刻を指定できる", () => {
      const clock = fixedClock("2030-01-01T12:00:00.000Z");
      expect(clock()).toBe("2030-01-01T12:00:00.000Z");
      expect(clock()).toBe("2030-01-01T12:00:01.000Z");
    });

    // 仕様(§6): start 省略時も決定的な既定基準から +1s で進む
    it("start 省略時も決定的な既定基準から +1s で進む", () => {
      const clock = fixedClock();
      const first = clock();
      const second = clock();
      expect(Date.parse(second) - Date.parse(first)).toBe(1000);
    });
  });

  describe("instantSleep", () => {
    // 仕様(§6): sleep(ms) は即 resolve する（実時間待たない）
    it("即 resolve する（実時間を待たない）", async () => {
      const sleep = instantSleep();
      const before = Date.now();
      await sleep(60_000);
      expect(Date.now() - before).toBeLessThan(50);
    });

    // 仕様(§6): 呼び出された ms を calls に順に記録する
    it("呼び出された ms を calls に順に記録する", async () => {
      const sleep = instantSleep();
      await sleep(1000);
      await sleep(60_000);
      await sleep(300_000);
      expect(sleep.calls).toEqual([1000, 60_000, 300_000]);
    });
  });
  ```

- [ ] **Step 20: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `Failed to resolve import "./fakes.js"`（`tests/fakes.ts` がまだ無く、`FakeCommandRunner` / `fixedClock` / `instantSleep` のいずれも解決できないため import 解決エラー）。

- [ ] **Step 21: FakeCommandRunner を実装する**
  `/home/racoma-dev/loop-pilot-os/tests/fakes.ts` を作成:
  ```typescript
  import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";

  type StubResponder =
    | Partial<CommandResult>
    | ((args: string[], opts: RunOptions) => Partial<CommandResult>);

  interface Stub {
    prefix: string[];
    responder: StubResponder;
  }

  export class FakeCommandRunner implements CommandRunner {
    private stubs: Stub[] = [];
    calls: Array<{ cmd: string; args: string[]; opts: RunOptions }> = [];

    /** ルール: [cmd, ...args] の前方一致で応答を返す。未登録は throw */
    on(cmdPrefix: string[], result: StubResponder): void {
      this.stubs.push({ prefix: cmdPrefix, responder: result });
    }

    run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult> {
      this.calls.push({ cmd, args, opts });
      const full = [cmd, ...args];

      let best: Stub | undefined;
      for (const stub of this.stubs) {
        if (!matchesPrefix(full, stub.prefix)) continue;
        if (best === undefined || stub.prefix.length > best.prefix.length) {
          best = stub;
        }
      }
      if (best === undefined) {
        return Promise.reject(
          new Error(`no FakeCommandRunner stub for: ${full.join(" ")}`),
        );
      }

      const partial =
        typeof best.responder === "function"
          ? best.responder(args, opts)
          : best.responder;
      const result: CommandResult = {
        code: partial.code ?? 0,
        stdout: partial.stdout ?? "",
        stderr: partial.stderr ?? "",
      };

      if (opts.onStdoutLine && result.stdout.length > 0) {
        const lines = result.stdout.split("\n");
        // 末尾が改行で終わる場合、split は末尾に空文字を生むので落とす
        if (lines[lines.length - 1] === "") lines.pop();
        for (const line of lines) opts.onStdoutLine(line);
      }

      return Promise.resolve(result);
    }
  }

  function matchesPrefix(full: string[], prefix: string[]): boolean {
    if (prefix.length > full.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (full[i] !== prefix[i]) return false;
    }
    return true;
  }

  /**
   * 決定的クロック（§6）。呼ぶ度に +1s 進んだ ISO 文字列を返す。
   * 初回は start（省略時は固定の既定基準）をそのまま返す。
   */
  export function fixedClock(start = "2026-01-01T00:00:00.000Z"): () => string {
    let next = Date.parse(start);
    return (): string => {
      const iso = new Date(next).toISOString();
      next += 1000;
      return iso;
    };
  }

  /**
   * 即 resolve する sleep（§6）。実時間を待たず、呼び出された ms を
   * 返り値関数の `.calls` 配列に順に記録する。
   */
  export function instantSleep(): ((ms: number) => Promise<void>) & {
    calls: number[];
  } {
    const calls: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      calls.push(ms);
      return Promise.resolve();
    };
    sleep.calls = calls;
    return sleep;
  }
  ```

- [ ] **Step 22: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 17 tests passed（RealCommandRunner 6 + FakeCommandRunner 6 + fixedClock 3 + instantSleep 2）。

- [ ] **Step 23: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: tsc（src）+ tsc（test、`tests/fakes.ts` を含む）+ vitest 全てグリーン。

- [ ] **Step 24: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add tests/fakes.ts tests/exec.test.ts && git commit -m "test: FakeCommandRunner with prefix-match stubbing plus fixedClock and instantSleep"`


---

### Task 4: Config（TOML + zod + env）

**目的**: `looppilot-os.toml`（snake_case）を読み込み、`smol-toml` でパース、`zod` で全キーを検証し、env からシークレットを注入して camelCase の `Config` を返す `loadConfig(path, env)` を実装する。`stateDbPath`/`worktreeRoot` の既定値を解決し、検証エラーは TOML/env を問わず全件を1つの `Error` message に集約する。
**依存タスク**: Task 1（リポ雛形・`package.json`・`tsconfig`×2・`vitest.config.ts` が存在し、`smol-toml`/`zod` が依存に入っていること）。Task 2/3 には依存しない（`Config` 型は本タスクが `config.ts` から独自に export し、`types.ts` には置かない — カーネル §3）。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/config.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/config.test.ts`
- Create: `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-valid.toml`
- Create: `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-minimal.toml`
- Create: `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-missing-required.toml`
- Create: `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-wrong-type.toml`

---

#### 設計メモ（このタスクで固定する事実・カーネル §3 と一字一句一致）

- パーサ: `import { parse as parseToml } from "smol-toml"`（smol-toml 1.6.1、`parse` を named export）。**検証済み**: `parseToml("[a]\ngoal=\"x\"\n")` → `{a:{goal:"x"}}`、空テーブル `[product]`（キーなし）→ `{product:{}}`。
- 検証: `import { z } from "zod"`（zod 4.4.3）。検証失敗時は `result.error.issues` を走査して全件集約する。**検証済み（zod 4.4.3 実測）**: 各 issue は `path: PropertyKey[]`（ネストキーは配列。例 `[product].goal` 欠落 → `["product","goal"]`、`[safety].max_tasks_per_run` 型不正 → `["safety","max_tasks_per_run"]`）と `message: string`（例 `"Invalid input: expected string, received undefined"`）を持つ。`safeParse` は成功時 `{success:true,data}`、失敗時 `{success:false,error}`。
- TOML は **snake_case**、`Config` は **camelCase**。snake_case のまま zod で検証 → camelCase へ手で写像する（zod の `.transform` は使わず、検証後に明示マッピング。エラー集約をシンプルに保つため）。
- env 注入: `LINEAR_API_KEY` は **必須**（欠落・空文字はエラー集約に含める）、`SLACK_WEBHOOK_URL` は **任意**（未設定・空文字なら `undefined`）。env はファイルに書かない（カーネル §3 の TOML には Linear APIキー / Slack Webhook のキーは存在しない）。
- `stateDbPath` = config ファイルと**同ディレクトリ**の `looppilot-os.db` = `path.join(path.dirname(configPath), "looppilot-os.db")`。
- `worktreeRoot` 既定（TOML `[repo].worktree_root` 省略時）= `path.join(os.homedir(), ".looppilot-os", "worktrees", path.basename(repo.path))`。`[repo].worktree_root` 指定時はそれを使う。
- `[repo].default_branch` は任意（既定 `"main"`）。`[safety].monitor_timeout_minutes` は**任意**（既定オフ＝省略時 `undefined`）。`[safety].not_engaged_guard_minutes` は既定 `30`。`[agent].extra_args` は任意（既定 `[]`）。`[notify]` はキー無しテーブル（任意）。
- 検証エラーは throw する `Error` の `message` に **全件**を改行区切りで列挙（最初の1件で止めない）。env 由来エラーと zod 由来エラーを同じ集約に混ぜる。
- **実行コマンド規約（Task 1 準拠）**: `cd` を避け `--prefix /home/racoma-dev/loop-pilot-os` を付ける。テスト単体は `npx --prefix /home/racoma-dev/loop-pilot-os vitest run tests/config.test.ts`、フルチェックは `npm run check --prefix /home/racoma-dev/loop-pilot-os`。

---

- [ ] **Step 1: 失敗するテスト本体と正常系/最小 fixture を作成する**

  `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-valid.toml` を作成する（カーネル §3 の `looppilot-os.example.toml` 相当の全キー版。任意キーも明示値で埋め、camelCase 写像と型解釈を網羅検証する）:

  ```toml
  [product]
  goal = "Build the best widget. Constraint: no breaking API changes."

  [repo]
  path = "/abs/path/to/target-repo"
  remote = "owner/name"
  default_branch = "main"
  worktree_root = "/custom/worktrees"

  [linear]
  team = "TY"
  project = "LoopPilot OS"
  opt_in_label = "ai-ok"
  [linear.states]
  todo = "Todo"
  in_progress = "In Progress"
  in_review = "In Review"
  done = "Done"

  [agent]
  model = "opus"
  allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"
  extra_args = ["--verbose"]

  [handoff]
  branch_prefix = "looppilot"
  pr_body_template = """
  Implements {identifier}: {title}

  {issue_url}

  Generated by LoopPilot OS
  """

  [looppilot]
  gate_label = "loop-pilot"
  state_comment_authors = ["github-actions[bot]"]

  [safety]
  max_tasks_per_run = 3
  max_cost_usd_per_session = 10.0
  monitor_timeout_minutes = 120
  not_engaged_guard_minutes = 30

  [loop]
  monitor_poll_seconds = 60
  idle_recheck_seconds = 300

  [digest]
  recent_merged_count = 5

  [notify]
  ```

  `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-minimal.toml` を作成する（既定値解決を検証する目的で、任意キー `worktree_root` / `default_branch` / `extra_args` / `monitor_timeout_minutes` / `not_engaged_guard_minutes` をすべて省略）:

  ```toml
  [product]
  goal = "Minimal goal."

  [repo]
  path = "/home/me/myrepo"
  remote = "owner/name"

  [linear]
  team = "TY"
  project = "LoopPilot OS"
  opt_in_label = "ai-ok"
  [linear.states]
  todo = "Todo"
  in_progress = "In Progress"
  in_review = "In Review"
  done = "Done"

  [agent]
  model = "opus"
  allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"

  [handoff]
  branch_prefix = "looppilot"
  pr_body_template = "Implements {identifier}: {title}\n\n{issue_url}\n"

  [looppilot]
  gate_label = "loop-pilot"
  state_comment_authors = ["github-actions[bot]"]

  [safety]
  max_tasks_per_run = 3
  max_cost_usd_per_session = 10.0

  [loop]
  monitor_poll_seconds = 60
  idle_recheck_seconds = 300

  [digest]
  recent_merged_count = 5

  [notify]
  ```

  `/home/racoma-dev/loop-pilot-os/tests/config.test.ts` を作成する（この時点では `src/config.js` が無いので import 自体が失敗する）:

  ```typescript
  import { describe, it, expect } from "vitest";
  import { fileURLToPath } from "node:url";
  import path from "node:path";
  import os from "node:os";
  import { loadConfig } from "../src/config.js";

  const fixturesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
  );
  const fixture = (name: string): string => path.join(fixturesDir, name);

  const fullEnv: NodeJS.ProcessEnv = {
    LINEAR_API_KEY: "lin_api_test_key",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
  };

  describe("loadConfig", () => {
    // 仕様 §8: product/repo/linear/agent/handoff/looppilot/safety/loop/digest を読み込み、
    // snake_case TOML を camelCase Config に写像する（カーネル §3）。
    it("loads a fully-specified config and maps snake_case TOML to camelCase Config", () => {
      const config = loadConfig(fixture("config-valid.toml"), fullEnv);

      expect(config.product.goal).toBe(
        "Build the best widget. Constraint: no breaking API changes.",
      );
      expect(config.repo.path).toBe("/abs/path/to/target-repo");
      expect(config.repo.remote).toBe("owner/name");
      expect(config.repo.defaultBranch).toBe("main");
      expect(config.repo.worktreeRoot).toBe("/custom/worktrees");

      expect(config.linear.team).toBe("TY");
      expect(config.linear.project).toBe("LoopPilot OS");
      expect(config.linear.optInLabel).toBe("ai-ok");
      expect(config.linear.states).toEqual({
        todo: "Todo",
        inProgress: "In Progress",
        inReview: "In Review",
        done: "Done",
      });
      expect(config.linearApiKey).toBe("lin_api_test_key");

      expect(config.agent.model).toBe("opus");
      expect(config.agent.allowedTools).toBe("Edit,Write,Read,Glob,Grep,Bash");
      expect(config.agent.extraArgs).toEqual(["--verbose"]);

      expect(config.handoff.branchPrefix).toBe("looppilot");
      expect(config.handoff.prBodyTemplate).toContain("{identifier}");

      expect(config.looppilot.gateLabel).toBe("loop-pilot");
      expect(config.looppilot.stateCommentAuthors).toEqual([
        "github-actions[bot]",
      ]);

      expect(config.safety.maxTasksPerRun).toBe(3);
      expect(config.safety.maxCostUsdPerSession).toBe(10.0);
      expect(config.safety.monitorTimeoutMinutes).toBe(120);
      expect(config.safety.notEngagedGuardMinutes).toBe(30);

      expect(config.loop.monitorPollSeconds).toBe(60);
      expect(config.loop.idleRecheckSeconds).toBe(300);

      expect(config.digest.recentMergedCount).toBe(5);

      expect(config.slackWebhookUrl).toBe(
        "https://hooks.slack.com/services/T/B/X",
      );
    });

    // 仕様 §8: stateDbPath = config と同ディレクトリの looppilot-os.db（カーネル §3）。
    it("resolves stateDbPath next to the config file", () => {
      const config = loadConfig(fixture("config-valid.toml"), fullEnv);
      expect(config.stateDbPath).toBe(path.join(fixturesDir, "looppilot-os.db"));
    });

    // カーネル §3: worktree_root 省略時 ~/.looppilot-os/worktrees/<repo basename>。
    it("defaults worktreeRoot under the home directory using the repo basename", () => {
      const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
      expect(config.repo.worktreeRoot).toBe(
        path.join(os.homedir(), ".looppilot-os", "worktrees", "myrepo"),
      );
    });

    // カーネル §3: 任意キーの既定値解決（default_branch=main, extra_args=[],
    // monitor_timeout_minutes=undefined, not_engaged_guard_minutes=30）。
    it("applies defaults for omitted optional keys", () => {
      const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
      expect(config.repo.defaultBranch).toBe("main");
      expect(config.agent.extraArgs).toEqual([]);
      expect(config.safety.monitorTimeoutMinutes).toBeUndefined();
      expect(config.safety.notEngagedGuardMinutes).toBe(30);
    });

    // カーネル §3: SLACK_WEBHOOK_URL 未設定なら undefined（コンソールのみ）。
    it("leaves slackWebhookUrl undefined when env var is absent", () => {
      const config = loadConfig(fixture("config-minimal.toml"), {
        LINEAR_API_KEY: "lin_api_test_key",
      });
      expect(config.slackWebhookUrl).toBeUndefined();
      expect(config.linearApiKey).toBe("lin_api_test_key");
    });

    // カーネル §3: LINEAR_API_KEY 必須（env 欠落はエラー集約に含める）。
    it("throws when LINEAR_API_KEY is missing from the environment", () => {
      expect(() =>
        loadConfig(fixture("config-valid.toml"), {
          SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
        }),
      ).toThrow(/LINEAR_API_KEY/);
    });

    // 仕様 §8: 必須キー欠落（[product].goal が無い）→ 該当パスを message に出す。
    it("throws listing the missing required key", () => {
      expect(() =>
        loadConfig(fixture("config-missing-required.toml"), fullEnv),
      ).toThrow(/product\.goal/);
    });

    // 型不正（max_tasks_per_run に文字列）→ 該当パスを message に出す。
    it("throws on a type mismatch with the offending path", () => {
      expect(() =>
        loadConfig(fixture("config-wrong-type.toml"), fullEnv),
      ).toThrow(/safety\.max_tasks_per_run/);
    });

    // カーネル §3: 検証エラーは全件集約して1つの Error message に（最初の1件で止めない）。
    it("aggregates every validation error into a single message", () => {
      let message = "";
      try {
        loadConfig(fixture("config-missing-required.toml"), {});
      } catch (err) {
        message = (err as Error).message;
      }
      // [product].goal 欠落（zod 由来）と LINEAR_API_KEY 欠落（env 由来）の両方が同じ message に出る。
      expect(message).toContain("product.goal");
      expect(message).toContain("LINEAR_API_KEY");
    });
  });
  ```

- [ ] **Step 2: テストを実行して失敗を確認する**

  コマンド: `npx --prefix /home/racoma-dev/loop-pilot-os vitest run tests/config.test.ts`
  期待される失敗: `src/config.js` が存在しないため、vitest が `Failed to resolve import "../src/config.js"`（または `Cannot find module`）でテストファイルの collection に失敗する。テストは 0 件成功・collection エラーで終了する（exit 1）。

- [ ] **Step 3: 残りの異常系 fixture を作成する**

  `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-missing-required.toml` を作成する（`[product].goal` を欠落させる。他は最小構成で valid）:

  ```toml
  [product]

  [repo]
  path = "/home/me/myrepo"
  remote = "owner/name"

  [linear]
  team = "TY"
  project = "LoopPilot OS"
  opt_in_label = "ai-ok"
  [linear.states]
  todo = "Todo"
  in_progress = "In Progress"
  in_review = "In Review"
  done = "Done"

  [agent]
  model = "opus"
  allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"

  [handoff]
  branch_prefix = "looppilot"
  pr_body_template = "Implements {identifier}: {title}\n"

  [looppilot]
  gate_label = "loop-pilot"
  state_comment_authors = ["github-actions[bot]"]

  [safety]
  max_tasks_per_run = 3
  max_cost_usd_per_session = 10.0

  [loop]
  monitor_poll_seconds = 60
  idle_recheck_seconds = 300

  [digest]
  recent_merged_count = 5

  [notify]
  ```

  `/home/racoma-dev/loop-pilot-os/tests/fixtures/config-wrong-type.toml` を作成する（`max_tasks_per_run` を文字列にする。他は最小構成で valid）:

  ```toml
  [product]
  goal = "Type mismatch fixture."

  [repo]
  path = "/home/me/myrepo"
  remote = "owner/name"

  [linear]
  team = "TY"
  project = "LoopPilot OS"
  opt_in_label = "ai-ok"
  [linear.states]
  todo = "Todo"
  in_progress = "In Progress"
  in_review = "In Review"
  done = "Done"

  [agent]
  model = "opus"
  allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"

  [handoff]
  branch_prefix = "looppilot"
  pr_body_template = "Implements {identifier}: {title}\n"

  [looppilot]
  gate_label = "loop-pilot"
  state_comment_authors = ["github-actions[bot]"]

  [safety]
  max_tasks_per_run = "three"
  max_cost_usd_per_session = 10.0

  [loop]
  monitor_poll_seconds = 60
  idle_recheck_seconds = 300

  [digest]
  recent_merged_count = 5

  [notify]
  ```

- [ ] **Step 4: `src/config.ts` を実装する（完全形）**

  `/home/racoma-dev/loop-pilot-os/src/config.ts` を作成する:

  ```typescript
  import { readFileSync } from "node:fs";
  import path from "node:path";
  import os from "node:os";
  import { parse as parseToml } from "smol-toml";
  import { z } from "zod";

  // ---- snake_case TOML スキーマ（カーネル §3 の全キー） ----
  const rawSchema = z.object({
    product: z.object({
      goal: z.string(),
    }),
    repo: z.object({
      path: z.string(),
      remote: z.string(),
      default_branch: z.string().default("main"),
      worktree_root: z.string().optional(),
    }),
    linear: z.object({
      team: z.string(),
      project: z.string(),
      opt_in_label: z.string(),
      states: z.object({
        todo: z.string(),
        in_progress: z.string(),
        in_review: z.string(),
        done: z.string(),
      }),
    }),
    agent: z.object({
      model: z.string(),
      allowed_tools: z.string(),
      extra_args: z.array(z.string()).default([]),
    }),
    handoff: z.object({
      branch_prefix: z.string(),
      pr_body_template: z.string(),
    }),
    looppilot: z.object({
      gate_label: z.string(),
      state_comment_authors: z.array(z.string()).min(1),
    }),
    safety: z.object({
      max_tasks_per_run: z.number().int().positive(),
      max_cost_usd_per_session: z.number().positive(),
      monitor_timeout_minutes: z.number().positive().optional(),
      not_engaged_guard_minutes: z.number().positive().default(30),
    }),
    loop: z.object({
      monitor_poll_seconds: z.number().int().positive(),
      idle_recheck_seconds: z.number().int().positive(),
    }),
    digest: z.object({
      recent_merged_count: z.number().int().positive(),
    }),
    notify: z.object({}).optional(),
  });

  type RawConfig = z.infer<typeof rawSchema>;

  // ---- camelCase Config（このモジュールが唯一の定義元・types.ts には置かない。カーネル §3） ----
  export interface Config {
    product: { goal: string };
    repo: {
      path: string;
      remote: string;
      defaultBranch: string;
      worktreeRoot: string;
    };
    linear: {
      team: string;
      project: string;
      optInLabel: string;
      states: {
        todo: string;
        inProgress: string;
        inReview: string;
        done: string;
      };
    };
    agent: {
      model: string;
      allowedTools: string;
      extraArgs: string[];
    };
    handoff: {
      branchPrefix: string;
      prBodyTemplate: string;
    };
    looppilot: {
      gateLabel: string;
      stateCommentAuthors: string[];
    };
    safety: {
      maxTasksPerRun: number;
      maxCostUsdPerSession: number;
      monitorTimeoutMinutes: number | undefined;
      notEngagedGuardMinutes: number;
    };
    loop: {
      monitorPollSeconds: number;
      idleRecheckSeconds: number;
    };
    digest: {
      recentMergedCount: number;
    };
    linearApiKey: string;
    slackWebhookUrl: string | undefined;
    stateDbPath: string;
  }

  function formatIssuePath(issuePath: PropertyKey[]): string {
    return issuePath.map((segment) => String(segment)).join(".");
  }

  export function loadConfig(
    configPath: string,
    env: NodeJS.ProcessEnv,
  ): Config {
    let rawText: string;
    try {
      rawText = readFileSync(configPath, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read config file at ${configPath}: ${(err as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseToml(rawText);
    } catch (err) {
      throw new Error(
        `Failed to parse TOML at ${configPath}: ${(err as Error).message}`,
      );
    }

    const errors: string[] = [];

    // env シークレット検証（zod エラーと同じ集約に混ぜる）。
    const linearApiKey = env.LINEAR_API_KEY;
    if (linearApiKey === undefined || linearApiKey === "") {
      errors.push("LINEAR_API_KEY: required environment variable is not set");
    }
    const slackWebhookUrl =
      env.SLACK_WEBHOOK_URL !== undefined && env.SLACK_WEBHOOK_URL !== ""
        ? env.SLACK_WEBHOOK_URL
        : undefined;

    const result = rawSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${formatIssuePath(issue.path)}: ${issue.message}`);
      }
    }

    if (!result.success || errors.length > 0) {
      throw new Error(
        `Invalid LoopPilot OS config (${configPath}):\n` +
          errors.map((line) => `  - ${line}`).join("\n"),
      );
    }

    const raw: RawConfig = result.data;

    const worktreeRoot =
      raw.repo.worktree_root ??
      path.join(
        os.homedir(),
        ".looppilot-os",
        "worktrees",
        path.basename(raw.repo.path),
      );
    const stateDbPath = path.join(path.dirname(configPath), "looppilot-os.db");

    return {
      product: { goal: raw.product.goal },
      repo: {
        path: raw.repo.path,
        remote: raw.repo.remote,
        defaultBranch: raw.repo.default_branch,
        worktreeRoot,
      },
      linear: {
        team: raw.linear.team,
        project: raw.linear.project,
        optInLabel: raw.linear.opt_in_label,
        states: {
          todo: raw.linear.states.todo,
          inProgress: raw.linear.states.in_progress,
          inReview: raw.linear.states.in_review,
          done: raw.linear.states.done,
        },
      },
      agent: {
        model: raw.agent.model,
        allowedTools: raw.agent.allowed_tools,
        extraArgs: raw.agent.extra_args,
      },
      handoff: {
        branchPrefix: raw.handoff.branch_prefix,
        prBodyTemplate: raw.handoff.pr_body_template,
      },
      looppilot: {
        gateLabel: raw.looppilot.gate_label,
        stateCommentAuthors: raw.looppilot.state_comment_authors,
      },
      safety: {
        maxTasksPerRun: raw.safety.max_tasks_per_run,
        maxCostUsdPerSession: raw.safety.max_cost_usd_per_session,
        monitorTimeoutMinutes: raw.safety.monitor_timeout_minutes,
        notEngagedGuardMinutes: raw.safety.not_engaged_guard_minutes,
      },
      loop: {
        monitorPollSeconds: raw.loop.monitor_poll_seconds,
        idleRecheckSeconds: raw.loop.idle_recheck_seconds,
      },
      digest: {
        recentMergedCount: raw.digest.recent_merged_count,
      },
      linearApiKey: linearApiKey as string,
      slackWebhookUrl,
      stateDbPath,
    };
  }
  ```

  実装メモ（実装者向け）:
  - env エラーを `errors` 配列へ先に積み、その後 zod の issue を積むことで、`config-missing-required.toml` + 空 env のとき message に `product.goal` と `LINEAR_API_KEY` の両方が並ぶ（テスト「aggregates every validation error」を満たす）。
  - `result.success` が false のとき `result.data` は存在しないので、throw のガード `!result.success || errors.length > 0` を通過した後でのみ `result.data` を読む（throw に到達したら必ず関数を抜けるため、その後の `raw` 参照は `result.success === true` が型的に保証される）。
  - `notify` は camelCase Config に持たない（カーネル §2 の Config 利用箇所・§3 の TOML いずれにも `notify` の中身は存在せず、Slack は env 由来の `slackWebhookUrl` で表現する）。zod では `[notify]` セクションの存在のみ任意に受理する。
  - `slackWebhookUrl` の判定で `env.SLACK_WEBHOOK_URL !== undefined && ... !== ""` と二段にするのは、`strict` 下で `string | undefined` を `string | undefined` に確定させ、空文字を `undefined` に正規化するため。

- [ ] **Step 5: テストを実行して成功を確認する**

  コマンド: `npx --prefix /home/racoma-dev/loop-pilot-os vitest run tests/config.test.ts`
  期待される成功: `tests/config.test.ts` の 9 件すべて pass（loads full / resolves stateDbPath / defaults worktreeRoot / applies defaults / leaves slackWebhookUrl undefined / throws on missing LINEAR_API_KEY / throws on missing required key / throws on type mismatch / aggregates every validation error）。出力末尾は概ね `Test Files  1 passed (1)` / `Tests  9 passed (9)` で exit 0。

- [ ] **Step 6: `npm run check` を実行してグリーンを確認する**

  コマンド: `npm run check --prefix /home/racoma-dev/loop-pilot-os`
  期待される成功: `tsc --noEmit`（src）と `tsc --noEmit -p tsconfig.test.json`（src+tests）が型エラー 0、続く vitest が全テスト pass で exit 0。`Config` が `config.ts` から export され、TOML snake_case と camelCase Config の写像が型整合する。

- [ ] **Step 7: red→green の単位でコミットする**

  コマンド:
  ```bash
  git -C /home/racoma-dev/loop-pilot-os add src/config.ts tests/config.test.ts tests/fixtures/config-valid.toml tests/fixtures/config-minimal.toml tests/fixtures/config-missing-required.toml tests/fixtures/config-wrong-type.toml
  git -C /home/racoma-dev/loop-pilot-os commit -m "feat: load+validate TOML config with zod and env secrets

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```
  期待: 6 ファイルがステージされ `[main <sha>] feat: load+validate TOML config ...` が出て exit 0。


---

## 目的と依存

State Store（SQLite）を実装する。カーネル §4 のスキーマ（一字一句）と `SqliteStore` の全公開メソッドを `src/store.ts` に持たせる。WAL 化（`:memory:` では失敗を無視）、`PRAGMA user_version=1`、状態遷移は単一 UPDATE 文＋`changes` 検証、`acquireRunLock` は注入された `isPidAlive` で生存 pid のロックは奪わず・死んだ pid のロックは奪取する。SQLite は真実の源（仕様 §4/§7）で、Run / TaskSession / 通知 intent / ランロックの全永続化を担う。

**依存タスク**: Task 2（`src/types.ts` の `RunRow`, `TaskSessionRow`, `RunState`, `SessionState`, `FailureReason`, `NotifyEvent` 等。本タスクはこれらを import するのみで再定義しない）。Task 1（`package.json` に `better-sqlite3` が実行時依存として追加済み・`tsconfig`×2・`vitest.config` の雛形があり `npm run check` が動くこと）。

**カーネル根拠**: §0（better-sqlite3 同期 API・テストは `:memory:`）、§4（SQL スキーマ全文＋`SqliteStore` メソッドシグネチャ・PRAGMA・WAL）、§2（`RunRow`/`TaskSessionRow`/`RunState`/`SessionState`/`FailureReason` 型）、§7（DI で `store` を渡す前提・`recentMergedSummaries` の利用）。

### このタスクで固定する事実（実環境で検証済み・better-sqlite3 12.10.0）

- `import Database from "better-sqlite3"` は **default import**（CommonJS の `module.exports = Database`）。NodeNext + `esModuleInterop` 前提。型は `@types/better-sqlite3@7.6.13`（別パッケージ、devDependency）。
- `db.pragma("journal_mode = WAL")` は `:memory:` では **throw せず** `journal_mode: "memory"` を返す（=実質 no-op）。ファイル DB では稀に失敗し得るため、カーネル §4「WAL（`:memory:` では失敗を無視）」に従い **try/catch で握り潰す**。
- `db.pragma("user_version = 1")` で書き込み、`db.pragma("user_version", { simple: true })` で `1`（数値）が読める。
- `stmt.run(...)` は `{ changes: number; lastInsertRowid: number | bigint }` を返す。`changes` は影響行数で、状態遷移の存在検証に使う。
- `stmt.run(undefined)` は **throw せず NULL** として扱われる（positional bind）。一方、名前付きパラメータでキー欠落は throw する。`updateSession` の部分更新は **patch に存在するキーだけ** SET 句に含め positional bind するため、`undefined` を一切 bind しない（NULL 上書き事故を防ぐ）。
- CHECK 制約違反・partial index（`WHERE state NOT IN (...)`）は通常どおり機能する。
- `lastInsertRowid` は number か bigint。`id` は `Number(...)` で正規化して `RunRow.id`（number）に入れる。

---

### Task 5: State Store（SQLite）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/store.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/store.test.ts`
- Modify: `/home/racoma-dev/loop-pilot-os/package.json`（`@types/better-sqlite3` を devDependencies に追加。Task 1 で未追加の場合のみ）

---

- [ ] **Step 1: `@types/better-sqlite3` が devDependency にあるか確認し、無ければ追加する**

  `better-sqlite3` は型を同梱しないため `@types/better-sqlite3` が必須。まず存在を確認する。

  コマンド:
  ```bash
  node -e "const p=require('/home/racoma-dev/loop-pilot-os/package.json'); process.stdout.write(String(p.devDependencies?.['@types/better-sqlite3'] ?? 'MISSING'))"
  ```

  出力が `MISSING` の場合のみ次を実行（既にバージョン文字列が出るならこのコマンドは省略する）:
  ```bash
  npm --prefix /home/racoma-dev/loop-pilot-os install --save-dev @types/better-sqlite3@7.6.13
  ```

  期待: `package.json` の `devDependencies` に `"@types/better-sqlite3": "^7.6.13"`（または Task 1 で既に入っているバージョン）が存在し、`node_modules/@types/better-sqlite3` が解決される。

---

- [ ] **Step 2: 失敗するテストの骨格を作成（import + run 作成/状態の最初の1ケースのみ）**

  この時点で `src/store.ts` は未作成なので import 解決に失敗させる。`/home/racoma-dev/loop-pilot-os/tests/store.test.ts` を作成（完全形・このステップではここまで）:

  ```typescript
  import { describe, it, expect, afterEach } from "vitest";
  import { SqliteStore } from "../src/store.js";
  import type { TaskSessionRow } from "../src/types.js";

  // テスト間で開いたストアを確実に閉じる（:memory: でもハンドルを解放する）
  let openStores: SqliteStore[] = [];
  function newStore(): SqliteStore {
    const s = new SqliteStore(":memory:");
    openStores.push(s);
    return s;
  }
  afterEach(() => {
    for (const s of openStores) s.close();
    openStores = [];
  });

  // ---- テスト用ヘルパ: 単調増加する ISO クロック（呼ぶ度 +1s） ----
  function makeClock(start = "2026-06-06T00:00:00.000Z"): () => string {
    let t = Date.parse(start);
    return () => {
      const iso = new Date(t).toISOString();
      t += 1000;
      return iso;
    };
  }

  // ---- セッションを CLAIM して任意状態まで進めるヘルパ ----
  function seedSession(
    store: SqliteStore,
    runId: number,
    now: string,
    overrides: Partial<{ linearIssueId: string; linearIdentifier: string; issueTitle: string; branch: string }> = {},
  ): TaskSessionRow {
    return store.createSession({
      runId,
      linearIssueId: overrides.linearIssueId ?? "issue-uuid-1",
      linearIdentifier: overrides.linearIdentifier ?? "TY-1",
      issueTitle: overrides.issueTitle ?? "First task",
      branch: overrides.branch ?? "looppilot/ty-1-first-task",
      worktreePath: "/wt/ty-1",
      now,
    });
  }

  describe("SqliteStore: run", () => {
    // 仕様§7: Run はループ起動ごとに1個。createRun で running 状態の行を作る
    it("createRun inserts a running run and returns the row with derived id", () => {
      const store = newStore();
      const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
      expect(run.id).toBe(1);
      expect(run.taskCap).toBe(3);
      expect(run.state).toBe("running");
      expect(run.haltReason).toBeNull();
      expect(run.startedAt).toBe("2026-06-06T00:00:00.000Z");
    });

    // getRun / latestRun が永続化された行を返す
    it("getRun and latestRun read back the persisted run", () => {
      const store = newStore();
      expect(store.latestRun()).toBeNull();
      const a = store.createRun(2, "2026-06-06T00:00:00.000Z");
      const b = store.createRun(5, "2026-06-06T01:00:00.000Z");
      expect(store.getRun(a.id).taskCap).toBe(2);
      expect(store.latestRun()?.id).toBe(b.id); // 最新 = id 最大
      expect(store.latestRun()?.taskCap).toBe(5);
    });
  });
  ```

- [ ] **Step 3: テストを実行して失敗を確認する**

  コマンド: `npm test -- store`
  期待される失敗: `src/store.js` が存在しないため、vitest が `Failed to resolve import "../src/store.js"`（または `Cannot find module`）で `tests/store.test.ts` の collection に失敗する。成功 0 件・collection エラーで終了。

- [ ] **Step 4: `src/store.ts` を最小実装する（スキーマ + run 系メソッドまで）**

  まずカーネル §4 のスキーマ全文・PRAGMA・WAL・行マッピング・run 系メソッドのみを実装し、Step 2 の 2 ケースを green にする。`/home/racoma-dev/loop-pilot-os/src/store.ts` を作成（完全形・このステップ時点）:

  ```typescript
  import Database from "better-sqlite3";
  import type {
    RunRow,
    RunState,
    TaskSessionRow,
  } from "./types.js";

  // ---- カーネル §4 のスキーマ（一字一句） ----
  const SCHEMA = `
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
    payload TEXT NOT NULL,
    delivered_console INTEGER NOT NULL DEFAULT 0,
    delivered_slack INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS run_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    acquired_at TEXT NOT NULL
  );
  `;

  // ---- DB の生 row（snake_case）→ ドメイン型（camelCase）マッピング ----
  interface RawRunRow {
    id: number;
    started_at: string;
    task_cap: number;
    state: string;
    halt_reason: string | null;
  }
  function toRunRow(r: RawRunRow): RunRow {
    return {
      id: r.id,
      startedAt: r.started_at,
      taskCap: r.task_cap,
      state: r.state as RunState,
      haltReason: r.halt_reason,
    };
  }

  export class SqliteStore {
    private readonly db: Database.Database;

    constructor(dbPath: string) {
      this.db = new Database(dbPath);
      // WAL 化。:memory: では no-op（journal_mode=memory が返る）。
      // ファイル DB で稀に失敗しても致命ではないので握り潰す（カーネル §4）。
      try {
        this.db.pragma("journal_mode = WAL");
      } catch {
        // ignore: WAL is a best-effort optimization
      }
      this.db.pragma("user_version = 1");
      this.db.exec(SCHEMA);
    }

    close(): void {
      this.db.close();
    }

    // ---- run ----
    createRun(taskCap: number, now: string): RunRow {
      const info = this.db
        .prepare(
          `INSERT INTO run (started_at, task_cap, state, halt_reason)
           VALUES (?, ?, 'running', NULL)`,
        )
        .run(now, taskCap);
      return this.getRun(Number(info.lastInsertRowid));
    }

    getRun(id: number): RunRow {
      const row = this.db
        .prepare(`SELECT * FROM run WHERE id = ?`)
        .get(id) as RawRunRow | undefined;
      if (row === undefined) {
        throw new Error(`run not found: id=${id}`);
      }
      return toRunRow(row);
    }

    latestRun(): RunRow | null {
      const row = this.db
        .prepare(`SELECT * FROM run ORDER BY id DESC LIMIT 1`)
        .get() as RawRunRow | undefined;
      return row === undefined ? null : toRunRow(row);
    }

    setRunState(id: number, state: RunState, haltReason?: string): void {
      const info = this.db
        .prepare(`UPDATE run SET state = ?, halt_reason = ? WHERE id = ?`)
        .run(state, haltReason ?? null, id);
      if (info.changes !== 1) {
        throw new Error(`setRunState affected ${info.changes} rows for run id=${id}`);
      }
    }

    countTasksStarted(runId: number): number {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM task_session WHERE run_id = ?`)
        .get(runId) as { c: number };
      return row.c;
    }

    countMerged(runId: number): number {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM task_session WHERE run_id = ? AND state = 'merged'`,
        )
        .get(runId) as { c: number };
      return row.c;
    }
  }
  ```

  注意（実装者向け）:
  - `createRun` は `started_at = now`（呼び出し側が渡す ISO）。`haltReason` は `NULL` 固定で挿入。
  - `setRunState` は UPDATE 1 文 + `changes === 1` 検証（カーネル「状態遷移は UPDATE 1文+changes 検証」）。`haltReason` 省略時は `NULL` を明示 bind し、以前の理由を残さない。
  - `countMerged` / `countTasksStarted` は導出（盲目的カウンタ更新はしない。仕様§7）。

- [ ] **Step 5: テストを実行して run 系 2 ケースが green になることを確認する**

  コマンド: `npm test -- store`
  期待される成功: `SqliteStore: run` の 2 ケース（createRun / getRun+latestRun）が pass。

- [ ] **Step 6: 失敗するテストを追加（setRunState とカウント導出）**

  `tests/store.test.ts` の `describe("SqliteStore: run", ...)` ブロックの末尾（最後の `it` の後、`});` の前）に次の `it` を追加する:

  ```typescript
    // 仕様§7: §5 STOPPED ⇒ Run=halted。setRunState は UPDATE 1文 + changes 検証
    it("setRunState updates state and halt reason, throwing for unknown ids", () => {
      const store = newStore();
      const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
      store.setRunState(run.id, "idle");
      expect(store.getRun(run.id).state).toBe("idle");
      expect(store.getRun(run.id).haltReason).toBeNull();
      store.setRunState(run.id, "halted", "task_cap reached");
      expect(store.getRun(run.id).state).toBe("halted");
      expect(store.getRun(run.id).haltReason).toBe("task_cap reached");
      // 存在しない run への遷移は changes=0 で throw
      expect(() => store.setRunState(999, "running")).toThrow();
    });

    // 仕様§7/§11: tasks_started = CLAIM 到達数（セッション行数）, merged = 導出実数
    it("countTasksStarted and countMerged derive counts from session rows", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      expect(store.countTasksStarted(run.id)).toBe(0);
      expect(store.countMerged(run.id)).toBe(0);

      const s1 = seedSession(store, run.id, clock(), { linearIssueId: "i1", linearIdentifier: "TY-1", branch: "b1" });
      const s2 = seedSession(store, run.id, clock(), { linearIssueId: "i2", linearIdentifier: "TY-2", branch: "b2" });
      seedSession(store, run.id, clock(), { linearIssueId: "i3", linearIdentifier: "TY-3", branch: "b3" });
      // 3 行 CLAIM 到達 → tasks_started = 3、merged はまだ 0
      expect(store.countTasksStarted(run.id)).toBe(3);
      expect(store.countMerged(run.id)).toBe(0);

      store.updateSession(s1.id, { state: "merged", endedAt: clock() });
      store.updateSession(s2.id, { state: "merged", endedAt: clock() });
      // merged は実数導出 = 2、tasks_started は変わらず 3
      expect(store.countMerged(run.id)).toBe(2);
      expect(store.countTasksStarted(run.id)).toBe(3);
    });
  ```

  コマンド: `npm test -- store`
  期待される失敗: 追加 2 ケースが失敗する。`setRunState` は実装済みだが、`createSession`/`updateSession`（`seedSession` が呼ぶ）が未実装なので、`store.createSession is not a function`（TypeError）で `countTasksStarted...` ケースが失敗し、`setRunState ...` ケースは pass する（このステップでは setRunState 単体は通る）。次ステップで session API の全ケースを先に red にしてから実装する。

- [ ] **Step 7: 失敗するテストを追加（session API 全体: 作成・状態・部分更新・active/known/recent/sessionsForRun）**

  session 系メソッドを実装する**前**に、その全公開挙動（`createSession`/`getSession` ラウンドトリップ、部分更新（`monitorStartedAt` 含む）、空 patch no-op、未知 id への `updateSession` throw、`activeSessions`/`activeIssueIds`/`knownIssueIds`、`recentMergedSummaries`、`sessionsForRun`/`recentSessions`）を網羅する describe ブロックを追加し、各挙動を実装前に red にする（red→green を session API 全体で踏む）。

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: session", () => {
    // 仕様§5: CLAIM で claimed セッションを記録（worktree 作成済み）
    it("createSession inserts a claimed session and round-trips via getSession", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = store.createSession({
        runId: run.id,
        linearIssueId: "uuid-1",
        linearIdentifier: "TY-7",
        issueTitle: "Add widget",
        branch: "looppilot/ty-7-add-widget",
        worktreePath: "/wt/ty-7",
        now: "2026-06-06T00:00:05.000Z",
      });
      expect(s.id).toBe(1);
      expect(s.runId).toBe(run.id);
      expect(s.state).toBe("claimed");
      expect(s.linearIssueId).toBe("uuid-1");
      expect(s.linearIdentifier).toBe("TY-7");
      expect(s.issueTitle).toBe("Add widget");
      expect(s.branch).toBe("looppilot/ty-7-add-widget");
      expect(s.worktreePath).toBe("/wt/ty-7");
      expect(s.prNumber).toBeNull();
      expect(s.costUsd).toBeNull();
      expect(s.failureReason).toBeNull();
      expect(s.stopDetail).toBeNull();
      expect(s.agentSummary).toBeNull();
      expect(s.monitorStartedAt).toBeNull();
      expect(s.endedAt).toBeNull();
      expect(s.startedAt).toBe("2026-06-06T00:00:05.000Z");
      expect(store.getSession(s.id)).toEqual(s);
    });

    // カーネル §4/§8: 部分更新は patch に存在する列だけを書き換え、他は保持する
    it("updateSession patches only the provided columns (including monitorStartedAt)", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = seedSession(store, run.id, clock());

      store.updateSession(s.id, { state: "implementing" });
      expect(store.getSession(s.id).state).toBe("implementing");

      // PR 番号を即時永続化（HANDOFF）
      store.updateSession(s.id, { prNumber: 42 });
      // in_review 入りで monitorStartedAt を起点として記録（同一/別 patch どちらでも保持される）
      store.updateSession(s.id, {
        state: "in_review",
        monitorStartedAt: "2026-06-06T00:10:00.000Z",
      });
      const after = store.getSession(s.id);
      expect(after.state).toBe("in_review");
      expect(after.prNumber).toBe(42);
      expect(after.monitorStartedAt).toBe("2026-06-06T00:10:00.000Z");
      // 触っていない列（branch / issueTitle / startedAt）は不変
      expect(after.branch).toBe(s.branch);
      expect(after.issueTitle).toBe(s.issueTitle);
      expect(after.startedAt).toBe(s.startedAt);

      // cost / summary / failure / endedAt の更新
      store.updateSession(s.id, {
        state: "merged",
        costUsd: 4.25,
        agentSummary: "implemented widget",
        endedAt: "2026-06-06T00:20:00.000Z",
      });
      const merged = store.getSession(s.id);
      expect(merged.state).toBe("merged");
      expect(merged.costUsd).toBe(4.25);
      expect(merged.agentSummary).toBe("implemented widget");
      expect(merged.endedAt).toBe("2026-06-06T00:20:00.000Z");
      // prNumber / monitorStartedAt は依然保持
      expect(merged.prNumber).toBe(42);
      expect(merged.monitorStartedAt).toBe("2026-06-06T00:10:00.000Z");
    });

    // 空 patch は no-op（throw しない・行を壊さない）
    it("updateSession with an empty patch is a no-op", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = seedSession(store, run.id, clock());
      expect(() => store.updateSession(s.id, {})).not.toThrow();
      expect(store.getSession(s.id)).toEqual(s);
    });

    // 存在しない session への更新は changes=0 で throw
    it("updateSession throws when no row matches the id", () => {
      const store = newStore();
      store.createRun(3, "2026-06-06T00:00:00.000Z");
      expect(() => store.updateSession(999, { state: "stopped" })).toThrow();
    });

    // カーネル §4/§8: activeSessions は merged/stopped 以外を全 run 横断で返す
    it("activeSessions returns sessions whose state is not merged or stopped, across runs", () => {
      const store = newStore();
      const clock = makeClock();
      const runA = store.createRun(3, clock());
      const runB = store.createRun(3, clock());

      const a = seedSession(store, runA.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a" });
      const b = seedSession(store, runA.id, clock(), { linearIssueId: "i-b", linearIdentifier: "TY-2", branch: "b-b" });
      const c = seedSession(store, runB.id, clock(), { linearIssueId: "i-c", linearIdentifier: "TY-3", branch: "b-c" });
      const d = seedSession(store, runB.id, clock(), { linearIssueId: "i-d", linearIdentifier: "TY-4", branch: "b-d" });

      store.updateSession(a.id, { state: "in_review" });   // active
      store.updateSession(b.id, { state: "merged" });       // 非アクティブ
      store.updateSession(c.id, { state: "stopped", failureReason: "exception" }); // 非アクティブ
      store.updateSession(d.id, { state: "implementing" }); // active（別 run）

      const active = store.activeSessions();
      expect(active.map((s) => s.id)).toEqual([a.id, d.id]); // id ASC・全 run 横断
      expect(active.map((s) => s.state)).toEqual(["in_review", "implementing"]);

      expect(store.activeIssueIds().sort()).toEqual(["i-a", "i-d"]);
      expect(store.knownIssueIds().sort()).toEqual(["i-a", "i-b", "i-c", "i-d"]);
    });

    // カーネル §2/§7: recentMergedSummaries は merged のみを ended_at 降順で n 件
    it("recentMergedSummaries returns only merged sessions, newest-ended first, limited to n", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(10, clock());

      const mk = (id: string, ident: string, title: string): TaskSessionRow =>
        seedSession(store, run.id, clock(), { linearIssueId: id, linearIdentifier: ident, issueTitle: title, branch: `b-${ident}` });

      const s1 = mk("i1", "TY-1", "first");
      const s2 = mk("i2", "TY-2", "second");
      const s3 = mk("i3", "TY-3", "third");
      const s4 = mk("i4", "TY-4", "fourth");
      const sActive = mk("i5", "TY-5", "active-not-merged");

      // merge 順を ended_at で制御（s2 → s1 → s3 → s4 の順にマージ）
      store.updateSession(s2.id, { state: "merged", agentSummary: "sum-2", endedAt: "2026-06-06T01:00:00.000Z" });
      store.updateSession(s1.id, { state: "merged", agentSummary: "sum-1", endedAt: "2026-06-06T02:00:00.000Z" });
      store.updateSession(s3.id, { state: "merged", agentSummary: "sum-3", endedAt: "2026-06-06T03:00:00.000Z" });
      store.updateSession(s4.id, { state: "merged", agentSummary: "sum-4", endedAt: "2026-06-06T04:00:00.000Z" });
      store.updateSession(sActive.id, { state: "in_review" }); // merged でない → 除外

      const top2 = store.recentMergedSummaries(2);
      expect(top2).toEqual([
        { linearIdentifier: "TY-4", issueTitle: "fourth", agentSummary: "sum-4" },
        { linearIdentifier: "TY-3", issueTitle: "third", agentSummary: "sum-3" },
      ]);

      const all = store.recentMergedSummaries(10);
      expect(all.map((r) => r.linearIdentifier)).toEqual([
        "TY-4",
        "TY-3",
        "TY-1",
        "TY-2",
      ]); // ended_at 降順、active は含まれない
    });

    // status CLI 用: sessionsForRun / recentSessions
    it("sessionsForRun and recentSessions return rows in expected order", () => {
      const store = newStore();
      const clock = makeClock();
      const runA = store.createRun(3, clock());
      const runB = store.createRun(3, clock());
      const a1 = seedSession(store, runA.id, clock(), { linearIssueId: "i1", linearIdentifier: "TY-1", branch: "b1" });
      const a2 = seedSession(store, runA.id, clock(), { linearIssueId: "i2", linearIdentifier: "TY-2", branch: "b2" });
      const b1 = seedSession(store, runB.id, clock(), { linearIssueId: "i3", linearIdentifier: "TY-3", branch: "b3" });

      expect(store.sessionsForRun(runA.id).map((s) => s.id)).toEqual([a1.id, a2.id]); // id ASC・runA のみ
      expect(store.sessionsForRun(runB.id).map((s) => s.id)).toEqual([b1.id]);

      // 最新順（id DESC）に n 件
      expect(store.recentSessions(2).map((s) => s.id)).toEqual([b1.id, a2.id]);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `SqliteStore: session` の各ケースが `TypeError`（`store.createSession is not a function` / `store.getSession is not a function` / `store.updateSession is not a function` / `store.activeSessions is not a function` / `store.activeIssueIds is not a function` / `store.knownIssueIds is not a function` / `store.recentMergedSummaries is not a function` / `store.sessionsForRun is not a function` / `store.recentSessions is not a function`）で全件失敗する。Step 6 の count 導出ケースも `createSession`/`updateSession` 未実装のため依然 red。session 系メソッドは次ステップで実装する。

- [ ] **Step 8: `src/store.ts` に session 系メソッドを実装する**

  `src/store.ts` の import に `SessionState`, `FailureReason` を追加し、`countMerged` メソッドの直後（`SqliteStore` クラス内）に session 系を追加する。

  まず import 行を差し替える:

  ```typescript
  import Database from "better-sqlite3";
  import type {
    RunRow,
    RunState,
    SessionState,
    FailureReason,
    TaskSessionRow,
  } from "./types.js";
  ```

  次に、`RawRunRow` / `toRunRow` の定義群の直後（`export class SqliteStore` の前）に、task_session の生 row 型とマッパを追加する:

  ```typescript
  interface RawSessionRow {
    id: number;
    run_id: number;
    linear_issue_id: string;
    linear_identifier: string;
    issue_title: string;
    branch: string;
    worktree_path: string | null;
    pr_number: number | null;
    state: string;
    cost_usd: number | null;
    failure_reason: string | null;
    stop_detail: string | null;
    agent_summary: string | null;
    started_at: string;
    monitor_started_at: string | null;
    ended_at: string | null;
  }
  function toSessionRow(r: RawSessionRow): TaskSessionRow {
    return {
      id: r.id,
      runId: r.run_id,
      linearIssueId: r.linear_issue_id,
      linearIdentifier: r.linear_identifier,
      issueTitle: r.issue_title,
      branch: r.branch,
      worktreePath: r.worktree_path,
      prNumber: r.pr_number,
      state: r.state as SessionState,
      costUsd: r.cost_usd,
      failureReason: r.failure_reason as FailureReason | null,
      stopDetail: r.stop_detail,
      agentSummary: r.agent_summary,
      startedAt: r.started_at,
      monitorStartedAt: r.monitor_started_at,
      endedAt: r.ended_at,
    };
  }

  // ---- updateSession の patch キー → DB 列名の対応（部分更新の SET 句生成に使う） ----
  const SESSION_PATCH_COLUMNS: Record<string, string> = {
    state: "state",
    worktreePath: "worktree_path",
    prNumber: "pr_number",
    costUsd: "cost_usd",
    failureReason: "failure_reason",
    stopDetail: "stop_detail",
    agentSummary: "agent_summary",
    monitorStartedAt: "monitor_started_at",
    endedAt: "ended_at",
    runId: "run_id",
  };
  ```

  そして `countMerged` メソッドの直後（クラス内）に session 系メソッドを追加する:

  ```typescript
    // ---- session ----
    createSession(s: {
      runId: number;
      linearIssueId: string;
      linearIdentifier: string;
      issueTitle: string;
      branch: string;
      worktreePath: string;
      now: string;
    }): TaskSessionRow {
      const info = this.db
        .prepare(
          `INSERT INTO task_session
             (run_id, linear_issue_id, linear_identifier, issue_title,
              branch, worktree_path, state, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?)`,
        )
        .run(
          s.runId,
          s.linearIssueId,
          s.linearIdentifier,
          s.issueTitle,
          s.branch,
          s.worktreePath,
          s.now,
        );
      return this.getSession(Number(info.lastInsertRowid));
    }

    getSession(id: number): TaskSessionRow {
      const row = this.db
        .prepare(`SELECT * FROM task_session WHERE id = ?`)
        .get(id) as RawSessionRow | undefined;
      if (row === undefined) {
        throw new Error(`task_session not found: id=${id}`);
      }
      return toSessionRow(row);
    }

    updateSession(
      id: number,
      patch: Partial<
        Pick<
          TaskSessionRow,
          | "state"
          | "worktreePath"
          | "prNumber"
          | "costUsd"
          | "failureReason"
          | "stopDetail"
          | "agentSummary"
          | "monitorStartedAt"
          | "endedAt"
          | "runId"
        >
      >,
    ): void {
      const setClauses: string[] = [];
      const values: Array<string | number | null> = [];
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        const column = SESSION_PATCH_COLUMNS[key as string];
        if (column === undefined) {
          throw new Error(`updateSession: unknown patch key "${String(key)}"`);
        }
        const raw = patch[key];
        // undefined はそもそも Object.keys に来ない想定だが、明示キー undefined は NULL 扱いにしない
        if (raw === undefined) continue;
        setClauses.push(`${column} = ?`);
        values.push(raw as string | number | null);
      }
      if (setClauses.length === 0) {
        return; // 空 patch は no-op
      }
      values.push(id);
      const info = this.db
        .prepare(`UPDATE task_session SET ${setClauses.join(", ")} WHERE id = ?`)
        .run(...values);
      if (info.changes !== 1) {
        throw new Error(
          `updateSession affected ${info.changes} rows for session id=${id}`,
        );
      }
    }

    activeSessions(): TaskSessionRow[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_session
           WHERE state NOT IN ('merged','stopped')
           ORDER BY id ASC`,
        )
        .all() as RawSessionRow[];
      return rows.map(toSessionRow);
    }

    activeIssueIds(): string[] {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT linear_issue_id AS id FROM task_session
           WHERE state NOT IN ('merged','stopped')`,
        )
        .all() as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    knownIssueIds(): string[] {
      const rows = this.db
        .prepare(`SELECT DISTINCT linear_issue_id AS id FROM task_session`)
        .all() as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    recentMergedSummaries(
      n: number,
    ): Array<
      Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">
    > {
      const rows = this.db
        .prepare(
          `SELECT linear_identifier, issue_title, agent_summary
           FROM task_session
           WHERE state = 'merged'
           ORDER BY ended_at DESC, id DESC
           LIMIT ?`,
        )
        .all(n) as Array<{
        linear_identifier: string;
        issue_title: string;
        agent_summary: string | null;
      }>;
      return rows.map((r) => ({
        linearIdentifier: r.linear_identifier,
        issueTitle: r.issue_title,
        agentSummary: r.agent_summary,
      }));
    }

    sessionsForRun(runId: number): TaskSessionRow[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_session WHERE run_id = ? ORDER BY id ASC`,
        )
        .all(runId) as RawSessionRow[];
      return rows.map(toSessionRow);
    }

    recentSessions(n: number): TaskSessionRow[] {
      const rows = this.db
        .prepare(`SELECT * FROM task_session ORDER BY id DESC LIMIT ?`)
        .all(n) as RawSessionRow[];
      return rows.map(toSessionRow);
    }
  ```

  注意（実装者向け）:
  - `createSession` は常に `state='claimed'` で挿入（CLAIM 到達の記録。仕様§5）。`worktree_path` は引数必須（CLAIM で worktree 作成済み）。
  - `updateSession` は **patch に存在するキーだけ** SET 句に入れて positional bind する。`runId` を含む全パッチ可能列をサポート（回復で runId 付替えに使う。カーネル §8）。`monitorStartedAt` も部分更新可能（in_review 入り・回復で起点を保持）。
  - `recentMergedSummaries` は `ended_at DESC, id DESC`（同一 ended_at の決定性のため id を tie-breaker）で merged のみ n 件。戻り値は `PromptArgs.digest` にそのまま渡せる形（カーネル §2/§7）。
  - `activeSessions` は **全 run 横断**で `merged`/`stopped` 以外（回復が全アクティブを見るため。カーネル §8）。`id ASC` で決定的順序。

- [ ] **Step 9: session 系テスト全件 green を確認しコミットする**

  Step 8 の実装で Step 6（count 導出）と Step 7（session API 全体）の red が一括で green になる。

  コマンド: `npm test -- store`
  期待される成功: `SqliteStore: run`（4 件: createRun / getRun+latestRun / setRunState / countTasksStarted+countMerged）+ `SqliteStore: session`（7 件: createSession ラウンドトリップ / 部分更新 / 空 patch no-op / 未知 id throw / activeSessions+active/known issue ids / recentMergedSummaries / sessionsForRun+recentSessions）が全て pass。

  この段で red→green 1 単位を締めてコミットする:
  ```bash
  git add src/store.ts tests/store.test.ts package.json
  git commit -m "feat: SqliteStore schema + run/session CRUD and derived counts"
  ```

- [ ] **Step 10: 失敗するテストを追加（通知 intent: 記録/配信マーク/未配信列挙）**

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: notification intents", () => {
    const payload = JSON.stringify({
      kind: "halted",
      reason: "task_cap",
      detail: "reached 3",
    });

    // 仕様§10/カーネル §4: Slack 設定時は delivered_slack=0 で記録、未配信に出る
    it("recordIntent (slack configured) lists the intent as undelivered until both channels marked", () => {
      const store = newStore();
      const id = store.recordIntent(payload, true, "2026-06-06T00:00:00.000Z");
      expect(id).toBe(1);

      let pending = store.undeliveredIntents();
      expect(pending).toEqual([{ id, payload, attempts: 0 }]);

      store.bumpAttempts(id);
      pending = store.undeliveredIntents();
      expect(pending).toEqual([{ id, payload, attempts: 1 }]);

      store.markDelivered(id, "console");
      // console 済みでも slack 未配信なら依然 undelivered
      expect(store.undeliveredIntents().map((i) => i.id)).toEqual([id]);

      store.markDelivered(id, "slack");
      // 両チャネル配信済み → undelivered から消える
      expect(store.undeliveredIntents()).toEqual([]);
    });

    // カーネル §4: Slack 未設定なら delivered_slack=1（=配信不要）で記録される
    it("recordIntent (slack NOT configured) marks slack as already-delivered", () => {
      const store = newStore();
      const id = store.recordIntent(payload, false, "2026-06-06T00:00:00.000Z");
      // slack は配信不要扱い。console を配信すれば undelivered から消える
      expect(store.undeliveredIntents().map((i) => i.id)).toEqual([id]);
      store.markDelivered(id, "console");
      expect(store.undeliveredIntents()).toEqual([]);
    });

    // 複数 intent は記録順（id 昇順）で未配信列挙される
    it("undeliveredIntents lists multiple pending intents in id order", () => {
      const store = newStore();
      const p1 = JSON.stringify({ kind: "idle", detail: "queue empty" });
      const p2 = JSON.stringify({ kind: "run_started", detail: "boot" });
      const id1 = store.recordIntent(p1, false, "2026-06-06T00:00:00.000Z");
      const id2 = store.recordIntent(p2, true, "2026-06-06T00:00:01.000Z");
      expect(store.undeliveredIntents()).toEqual([
        { id: id1, payload: p1, attempts: 0 },
        { id: id2, payload: p2, attempts: 0 },
      ]);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `store.recordIntent is not a function`（TypeError）等で `notification intents` の 3 ケースが失敗する（intent 系メソッドが未実装）。

- [ ] **Step 11: `src/store.ts` に通知 intent 系メソッドを実装する**

  `src/store.ts` の `recentSessions` メソッドの直後（クラス内）に追加する:

  ```typescript
    // ---- notification intents ----
    recordIntent(payload: string, slackConfigured: boolean, now: string): number {
      // Slack 未設定なら delivered_slack=1（=配信不要）で記録（カーネル §4）
      const deliveredSlack = slackConfigured ? 0 : 1;
      const info = this.db
        .prepare(
          `INSERT INTO notification_intent
             (created_at, payload, delivered_console, delivered_slack, attempts)
           VALUES (?, ?, 0, ?, 0)`,
        )
        .run(now, payload, deliveredSlack);
      return Number(info.lastInsertRowid);
    }

    markDelivered(id: number, channel: "console" | "slack"): void {
      const column =
        channel === "console" ? "delivered_console" : "delivered_slack";
      const info = this.db
        .prepare(`UPDATE notification_intent SET ${column} = 1 WHERE id = ?`)
        .run(id);
      if (info.changes !== 1) {
        throw new Error(
          `markDelivered affected ${info.changes} rows for intent id=${id}`,
        );
      }
    }

    bumpAttempts(id: number): void {
      const info = this.db
        .prepare(
          `UPDATE notification_intent SET attempts = attempts + 1 WHERE id = ?`,
        )
        .run(id);
      if (info.changes !== 1) {
        throw new Error(
          `bumpAttempts affected ${info.changes} rows for intent id=${id}`,
        );
      }
    }

    undeliveredIntents(): Array<{
      id: number;
      payload: string;
      attempts: number;
    }> {
      const rows = this.db
        .prepare(
          `SELECT id, payload, attempts FROM notification_intent
           WHERE delivered_console = 0 OR delivered_slack = 0
           ORDER BY id ASC`,
        )
        .all() as Array<{ id: number; payload: string; attempts: number }>;
      return rows;
    }
  ```

  注意（実装者向け）:
  - `recordIntent` の `slackConfigured=false` → `delivered_slack=1`（Slack 不要のときは Slack を配信済みとみなす。カーネル §4 コメント）。
  - `undeliveredIntents` は `delivered_console=0 OR delivered_slack=0`（いずれか未配信なら未配信扱い）。`id ASC` で記録順。

  コマンド: `npm test -- store`
  期待される成功: `notification intents` の 3 ケースが pass。

- [ ] **Step 12: red→green 単位でコミットする**

  ```bash
  git add src/store.ts tests/store.test.ts
  git commit -m "feat: persist notification intents with per-channel delivery"
  ```

- [ ] **Step 13: 失敗するテストを追加（ランロック: 取得/競合/死活奪取/解放）**

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: run lock", () => {
    const allAlive = () => true;
    const allDead = () => false;

    // カーネル §4: 空ロックなら取得成功し、自 pid のロック行が立つ
    it("acquireRunLock succeeds when no lock exists", () => {
      const store = newStore();
      const ok = store.acquireRunLock(1234, allDead, "2026-06-06T00:00:00.000Z");
      expect(ok).toBe(true);
      // 同 pid の再取得も冪等に成功する（自分のロックは奪える）
      const again = store.acquireRunLock(1234, allAlive, "2026-06-06T00:00:01.000Z");
      expect(again).toBe(true);
    });

    // 別プロセスが生存している間は奪取できない（単一インスタンス前提）
    it("acquireRunLock fails when another live pid holds the lock", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      // 2222 から見て 1111 は生存 → 奪取不可
      const isAlive = (pid: number): boolean => pid === 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:01.000Z")).toBe(false);
    });

    // 保持者が死んでいれば奪取できる（死活奪取）
    it("acquireRunLock steals the lock when the holding pid is dead", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      // 1111 は死亡、2222 が奪取
      const isAlive = (pid: number): boolean => pid !== 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:01.000Z")).toBe(true);
      // 以後 1111 は（生きていても）旧ロック行を持たない → 3333 から見て保持者は 2222
      const onlyActiveAlive = (pid: number): boolean => pid === 2222;
      expect(store.acquireRunLock(3333, onlyActiveAlive, "2026-06-06T00:00:02.000Z")).toBe(false);
    });

    // 解放後は別プロセスが取得できる
    it("releaseRunLock frees the lock for another pid", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      store.releaseRunLock(1111);
      // 解放後は 2222 が（1111 が生存していても）取得できる
      expect(store.acquireRunLock(2222, () => true, "2026-06-06T00:00:01.000Z")).toBe(true);
    });

    // 他 pid の releaseRunLock は自ロックを壊さない（自分のロックだけ解放）
    it("releaseRunLock by a non-holder does not drop the current lock", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      store.releaseRunLock(9999); // 保持者でない pid の解放は no-op
      // 1111 は依然保持者 → 2222（1111 生存）は取得不可
      const isAlive = (pid: number): boolean => pid === 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:02.000Z")).toBe(false);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `store.acquireRunLock is not a function`（TypeError）等で `run lock` の 5 ケースが失敗する（ロック系メソッドが未実装）。

- [ ] **Step 14: `src/store.ts` にランロック系メソッドを実装する**

  `src/store.ts` の `undeliveredIntents` メソッドの直後（クラス内）に追加する:

  ```typescript
    // ---- run lock（単一インスタンス）----
    acquireRunLock(
      pid: number,
      isPidAlive: (pid: number) => boolean,
      now: string,
    ): boolean {
      const existing = this.db
        .prepare(`SELECT pid FROM run_lock WHERE id = 1`)
        .get() as { pid: number } | undefined;

      if (existing !== undefined) {
        // 自 pid のロックは冪等に奪える。別 pid は生存中なら奪わない。
        if (existing.pid !== pid && isPidAlive(existing.pid)) {
          return false;
        }
      }

      // 空・自 pid・死んだ保持者 → 奪取（id=1 行を upsert）
      this.db
        .prepare(
          `INSERT INTO run_lock (id, pid, acquired_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at`,
        )
        .run(pid, now);
      return true;
    }

    releaseRunLock(pid: number): void {
      // 自分が保持しているロックだけ解放する（他 pid の解放は no-op）
      this.db
        .prepare(`DELETE FROM run_lock WHERE id = 1 AND pid = ?`)
        .run(pid);
    }
  ```

  注意（実装者向け）:
  - 保持者判定は `run_lock` の `id=1` 行のみ（CHECK で単一行を保証）。`existing.pid === pid` は冪等再取得（同一プロセスの再起動でなく同一実行中の再呼び出し）として許可。
  - 別 pid かつ `isPidAlive(existing.pid)` が true → `false`（奪取不可）。死んでいれば upsert で奪取。`isPidAlive` は注入（テストは決定的なフェイク、本番は `process.kill(pid, 0)` ラッパを Orchestrator/main 側で渡す。カーネル §4 のシグネチャに従い store はロジックを持たない）。
  - `releaseRunLock` は `pid` 一致時のみ DELETE（他プロセスが誤って奪取権のないロックを消さない）。

  コマンド: `npm test -- store`
  期待される成功: `run lock` の 5 ケース（取得/競合/死活奪取/解放/非保持者解放 no-op）が全て pass。

- [ ] **Step 15: `npm run check` を実行してグリーンを確認する**

  コマンド: `npm run check`
  期待される成功: `tsc`（src・`tsconfig.json`）と `tsc`（test・`tsconfig.test.json`）が型エラー 0、続く vitest が `tests/store.test.ts` 全件（run 4 + session 7 + notification intents 3 + run lock 5 = 19 ケース）+ 既存タスクのテストを含め全て pass で終了コード 0。`SqliteStore` の公開シグネチャがカーネル §4 と一字一句一致し、`RunRow`/`TaskSessionRow` 等を `types.js` から import している（再定義していない）こと。

- [ ] **Step 16: red→green 単位でコミットする**

  ```bash
  git add src/store.ts tests/store.test.ts
  git commit -m "feat: single-instance run lock with pid-liveness stealing"
  ```


---

### Task 6: Notifier（console + Slack + intent永続化）

**目的**: 人間の出番（HALT / IDLE / 起動）だけを通知する `ConsoleSlackNotifier` を実装する。通知の意図を先に Store へ記録し（`notification_intent`）、コンソールへは必ず整形出力（必達）、Slack Webhook が設定済みなら `{text}` を指数バックオフ付き 3 回までリトライして POST する。Slack 失敗はコンソールの成功を妨げず throw もしない（`bumpAttempts` のみ）。さらにプリフライト専用 `probeReachability()`（カーネル §9 step10）を提供する。仕様 §10（可観測性・通知）/ §4（Notifier）/ §6（コンソールは必ず成功）。

**依存タスク**: Task 2（`src/types.ts` の `Notifier` / `NotifyEvent` 型）、Task 5（`src/store.ts` の `SqliteStore` と `notification_intent` テーブル／`recordIntent`・`markDelivered`・`bumpAttempts`）。Task 3 の `fixedClock` / `instantSleep`（`tests/fakes.ts`）はこのタスクのテストで再利用する（既存定義。本タスクでは新規追加しない）。

カーネル参照: §2（`Notifier` / `NotifyEvent`）、§4（`notification_intent` スキーマと `SqliteStore` の intent メソッド）、§9 step10（probeReachability の throw 条件）、§10（タスク表 #6）。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/notifier.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/notifier.test.ts`

---

- [ ] **Step 1: 失敗するテストファイルを作成する（intent 記録 + console 必達 + Slack 成功）**

`/home/racoma-dev/loop-pilot-os/tests/notifier.test.ts` を新規作成する（この時点では `src/notifier.ts` が無いのでインポート解決に失敗 = red）。`fixedClock` は呼ぶ度に +1s の ISO を返す（カーネル §6）ため、`recordIntent` に渡る `now` は決定的。`SqliteStore` は `:memory:`。

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import { ConsoleSlackNotifier } from "../src/notifier.js";
import { fixedClock, instantSleep } from "./fakes.js";

// 注入する fetch のフェイク。応答は responses キューから順に取り出す。
// "throw" を積むとネットワークエラーを模す。
function makeFetch(responses: Array<{ ok: boolean; status: number } | "throw">) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("fetch called more times than configured");
    }
    if (next === "throw") {
      throw new TypeError("network down");
    }
    return new Response(null, { status: next.status }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("ConsoleSlackNotifier", () => {
  let store: SqliteStore;
  let logs: string[];
  const log = (s: string) => {
    logs.push(s);
  };

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    logs = [];
  });

  // 仕様 §10: 意図を Store へ先に記録し、ローカルチャネル(console)は必ず成功する。
  it("records the intent then logs to console and marks delivered_console=1 (no Slack configured)", async () => {
    const { fn, calls } = makeFetch([]);
    const notifier = new ConsoleSlackNotifier(
      store,
      null, // webhook 未設定
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "idle", detail: "queue empty" });

    // console へ整形出力された（絵文字付き日本語の文面・detail を含む）
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("queue empty");

    // intent は1件記録され、console 配信済み・Slack 不要(=配信済み扱い 1)
    const undelivered = store.undeliveredIntents();
    expect(undelivered.length).toBe(0); // console=1 ∧ slack=1 → 未配信なし

    // Slack 未設定なので fetch は呼ばれない
    expect(calls.length).toBe(0);
  });

  // Slack 設定時: {text} を POST し、2xx で delivered_slack=1。
  it("posts {text} to the webhook and marks delivered_slack=1 on 2xx", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "run_started", detail: "pid 42" });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.slack.test/abc");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("pid 42");

    // console + slack 両方配信済み → 未配信なし
    expect(store.undeliveredIntents().length).toBe(0);
    // console は必ず出る
    expect(logs.length).toBe(1);
  });
});
```

- [ ] **Step 2: red を確認する**

```
npx vitest run tests/notifier.test.ts
```

期待される失敗（src/notifier.ts 未作成のため import 解決エラー）:

```
Error: Failed to load url ../src/notifier.js (resolved id: .../src/notifier.ts) ... Does the file exist?
```

- [ ] **Step 3: `src/notifier.ts` を最小実装する（intent 記録 + console 必達 + Slack 単発 POST のみ）**

`/home/racoma-dev/loop-pilot-os/src/notifier.ts` を新規作成。カーネル §2 の `Notifier` / `NotifyEvent`、§4 の `SqliteStore` intent メソッドに一字一句一致させる。**この Step では Step 1 の2ケースだけを満たす最小実装に留める**：intent 記録 + console 必達 + （Slack 設定時は）`bumpAttempts` 1回 + **単発** POST し 2xx で `markDelivered(_, "slack")`。リトライ／指数バックオフは**まだ書かない**（Step 7 のテストに応じて追加する）。`probeReachability` は `Notifier` インターフェース充足のための**未実装スタブ**に留め、到達性検証ロジック（非2xx・network で throw、未設定で即 resolve・fetch 不呼出）は**まだ書かない**（Step 12 のテストに応じて追加する）。スタブは `Promise<void>` を即 resolve するだけで、POST もしないし throw もしない。これにより Step 12 の probe テストは genuine に red になる。

> TDD 上の意図（カーネル §0「全タスク red→green」・§11「テスト→失敗確認→実装→成功確認」）: バックオフループと probe ロジックは、**それを検証するテストが先に存在してから**書く。Step 3 ではそれらのテストはまだ無いので、対応コードも書かない。

```typescript
import type { SqliteStore } from "./store.js";
import type { Notifier, NotifyEvent } from "./types.js";

/**
 * NotifyEvent を「絵文字付き日本語」の1行テキストへ整形する。
 * console / Slack の双方で同じ文面を使う（仕様 §10）。
 */
export function formatNotifyEvent(event: NotifyEvent): string {
  switch (event.kind) {
    case "halted":
      return `🛑 LoopPilot OS 停止: ${event.reason} — ${event.detail}`;
    case "idle":
      return `💤 LoopPilot OS アイドル: 着手可能なタスクがありません — ${event.detail}`;
    case "run_started":
      return `🚀 LoopPilot OS 起動: ${event.detail}`;
  }
}

export class ConsoleSlackNotifier implements Notifier {
  private readonly store: SqliteStore;
  private readonly webhookUrl: string | null;
  private readonly log: (s: string) => void;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => string;

  constructor(
    store: SqliteStore,
    webhookUrl: string | null,
    log: (s: string) => void,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.webhookUrl = webhookUrl;
    this.log = log;
    this.fetchFn = fetchFn;
    this.sleep = sleep;
    this.clock = clock;
  }

  async notify(event: NotifyEvent): Promise<void> {
    const slackConfigured = this.webhookUrl !== null;
    // ① 意図を Store へ先に記録（payload = NotifyEvent の JSON）。
    //    Slack 未設定なら delivered_slack=1（=配信不要）で記録される（カーネル §4）。
    const intentId = this.store.recordIntent(
      JSON.stringify(event),
      slackConfigured,
      this.clock(),
    );

    // ② コンソールは必ず成功する（仕様 §6/§10）。整形して出力し delivered_console=1。
    const text = formatNotifyEvent(event);
    this.log(text);
    this.store.markDelivered(intentId, "console");

    // ③ Slack 設定時のみ POST。失敗しても throw しない（bumpAttempts のみ）。
    //    ※ この最小実装は「単発 POST」のみ。リトライ／指数バックオフは Step 7 のテストに応じて追加する。
    if (!slackConfigured) {
      return;
    }
    await this.deliverSlack(intentId, text);
  }

  /**
   * Slack へ {text} を **単発** POST する。2xx で delivered_slack=1。
   * 失敗しても throw しない（bumpAttempts のみ／人間の出番通知は console で既に届いている）。
   * ※ リトライ／指数バックオフは Step 7 のテスト追加時に実装する。
   */
  private async deliverSlack(intentId: number, text: string): Promise<void> {
    const url = this.webhookUrl as string;
    this.store.bumpAttempts(intentId);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        this.store.markDelivered(intentId, "slack");
      }
      // 非2xx は失敗扱い。undelivered のまま残す。
    } catch {
      // network エラーも失敗扱い。undelivered のまま残す。
    }
  }

  /**
   * プリフライト専用（カーネル §9 step10）。
   * ※ 未実装スタブ。到達性検証ロジック（未設定→即 resolve・fetch 不呼出／設定時は
   *   最小 POST し非2xx・network エラーで throw）は Step 12 のテスト追加時に実装する。
   *   現状は何もせず即 resolve するため、Step 12 の probe テストは genuine に red になる。
   */
  async probeReachability(): Promise<void> {
    return;
  }
}
```

- [ ] **Step 4: green を確認する**

```
npx vitest run tests/notifier.test.ts
```

期待: Step 1 の2ケースが pass（`2 passed`）。

- [ ] **Step 5: `npm run check` を通す**

```
npm run check
```

期待: tsc（src/test 双方）と vitest がグリーン（`0 errors` / 全テスト pass）。

- [ ] **Step 6: red-green の第1単位をコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier (intent record + console + Slack POST)"
```

---

- [ ] **Step 7: Slack リトライ／指数バックオフの失敗系テストを追加する（red）**

`tests/notifier.test.ts` の `describe` 末尾（最後の `it` の後）へ以下の3ケースを追記する。これらは Step 3 では**まだ実装していない** 3回リトライ＋指数バックオフ（1000ms→2000ms）の振る舞いを駆動するテストである。`instantSleep()` は呼び出しを記録するので、バックオフ呼び出し回数も検証する。Slack 全滅でも throw せず console は必達・intent は未配信(slack 未達)で `attempts=3` で残ることを確認する。

```typescript
  // 3回連続失敗(非2xx): throw せず、attempts=3、delivered_slack=0 のまま残る。
  it("retries 3 times on persistent non-2xx, never throws, leaves intent undelivered to Slack", async () => {
    const { fn, calls } = makeFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      sleep,
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    // throw しないこと
    await expect(
      notifier.notify({ kind: "halted", reason: "task_cap", detail: "3/3" }),
    ).resolves.toBeUndefined();

    // 3回 POST した
    expect(calls.length).toBe(3);
    // 指数バックオフ: 試行間の sleep は2回（1000ms, 2000ms）。最終失敗後は待たない。
    expect(sleeps).toEqual([1000, 2000]);

    // console は必達
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("3/3");

    // Slack 未達: undelivered に1件残り attempts=3
    const undelivered = store.undeliveredIntents();
    expect(undelivered.length).toBe(1);
    expect(undelivered[0].attempts).toBe(3);
    const event = JSON.parse(undelivered[0].payload);
    expect(event.kind).toBe("halted");
  });

  // network エラー(throw)が続いても notify は throw しない。
  it("swallows network errors across all attempts without throwing", async () => {
    const { fn, calls } = makeFetch(["throw", "throw", "throw"]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(
      notifier.notify({ kind: "idle", detail: "queue empty" }),
    ).resolves.toBeUndefined();

    expect(calls.length).toBe(3);
    expect(store.undeliveredIntents().length).toBe(1);
  });

  // 2回目で成功: それ以降リトライせず delivered_slack=1、attempts=2。
  it("succeeds on the second attempt and stops retrying", async () => {
    const { fn, calls } = makeFetch([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      sleep,
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "run_started", detail: "pid 7" });

    // 2回だけ POST（3回目はしない）
    expect(calls.length).toBe(2);
    // 1回目失敗後に1回だけ待つ
    expect(sleeps).toEqual([1000]);
    // 配信完了 → 未配信なし
    expect(store.undeliveredIntents().length).toBe(0);
  });
```

- [ ] **Step 8: red を確認する（genuine な失敗）**

```
npx vitest run tests/notifier.test.ts
```

期待: 追加3ケースは**必ず fail する**。Step 3 の `deliverSlack` は単発 POST のみ（リトライ無し）なので、3回 POST されず・バックオフ sleep も呼ばれず・`attempts` は 1 にしかならない。典型的な失敗:

```
FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > retries 3 times on persistent non-2xx, ...
AssertionError: expected 1 to be 3 // calls.length（1回しか POST していない）

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > succeeds on the second attempt and stops retrying
AssertionError: expected [] to deeply equal [ 1000 ] // sleeps（バックオフ未実装で sleep が呼ばれていない）
```

`makeFetch` は2件目以降を消費しないため、`succeeds on the second attempt` ケースでは1件目の 503 で諦め `undeliveredIntents().length` が 1 になり（期待 0）これも fail する。**いずれも「リトライ／バックオフ未実装」という予測どおりの失敗**であり、characterization ではない。

- [ ] **Step 9: 緑にするため Step 3 の `deliverSlack` をリトライ／指数バックオフ実装へ拡張する → green を確認する**

`src/notifier.ts` の `deliverSlack` を、Step 8 のテストを満たすよう **3回リトライ＋指数バックオフ** へ書き換える。あわせて定数を追加する（ファイル冒頭の import 直後）。

```typescript
/** Slack へ POST する最大試行回数（カーネル §10: リトライ3回）。 */
const SLACK_MAX_ATTEMPTS = 3;
/** 指数バックオフの基準ミリ秒（試行 n 回目失敗後に base * 2^(n-1) 待つ）。 */
const SLACK_BACKOFF_BASE_MS = 1000;
```

`deliverSlack` メソッド本体を以下へ差し替える:

```typescript
  /**
   * Slack へ {text} を POST する。2xx で delivered_slack=1。
   * 各試行で attempts を加算し、SLACK_MAX_ATTEMPTS まで指数バックオフでリトライ。
   * 全滅しても throw しない（人間の出番通知は console で既に届いている）。
   */
  private async deliverSlack(intentId: number, text: string): Promise<void> {
    const url = this.webhookUrl as string;
    for (let attempt = 1; attempt <= SLACK_MAX_ATTEMPTS; attempt++) {
      this.store.bumpAttempts(intentId);
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          this.store.markDelivered(intentId, "slack");
          return;
        }
        // 非2xx は失敗扱い。次の試行へ（最終試行なら諦める）。
      } catch {
        // network エラーも失敗扱い。次の試行へ。
      }
      if (attempt < SLACK_MAX_ATTEMPTS) {
        await this.sleep(SLACK_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
    // 全滅: throw せず undelivered のまま残す（status CLI で可視化）。
  }
```

再実行:

```
npx vitest run tests/notifier.test.ts
```

期待: 5ケース全て pass（`5 passed`）。最終失敗後は `attempt < SLACK_MAX_ATTEMPTS` ガードで待たないため `sleeps` は `[1000, 2000]` になる。

- [ ] **Step 10: `npm run check` を通す**

```
npm run check
```

期待: グリーン。

- [ ] **Step 11: リトライ／バックオフ実装＋失敗系テストをコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier Slack retry/backoff with failure-path tests"
```

---

- [ ] **Step 12: `probeReachability` のテストを追加する（red）**

`tests/notifier.test.ts` の `describe` 末尾へ追記。これらは Step 3 では**未実装スタブ**のままにした到達性検証の振る舞いを駆動するテストである。カーネル §9 step10: 未設定→即 resolve（fetch 不呼出）／設定→最小 POST、非2xx・network で throw。

```typescript
  // probe: webhook 未設定なら即 resolve、fetch を呼ばない。
  it("probeReachability resolves immediately without calling fetch when webhook is unset", async () => {
    const { fn, calls } = makeFetch([]);
    const notifier = new ConsoleSlackNotifier(
      store,
      null,
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });

  // probe: 2xx なら resolve。POST を1回だけ行う。
  it("probeReachability resolves on 2xx", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].init?.method).toBe("POST");
  });

  // probe: 非2xx なら throw（リトライしない・1回で判定）。
  it("probeReachability throws on non-2xx and does not retry", async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 404 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).rejects.toThrow(/404/);
    expect(calls.length).toBe(1);
  });

  // probe: network エラーは throw を伝播する。
  it("probeReachability propagates network errors", async () => {
    const { fn } = makeFetch(["throw"]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).rejects.toThrow(/network down/);
  });
```

- [ ] **Step 13: red を確認する（genuine な失敗）**

```
npx vitest run tests/notifier.test.ts
```

期待: 追加4ケースのうち**到達性検証を要する2ケースは必ず fail する**。Step 3 の `probeReachability` は何もせず即 resolve するだけのスタブなので:

```
FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability resolves on 2xx
AssertionError: expected 0 to be 1 // calls.length（POST していない）

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability throws on non-2xx and does not retry
AssertionError: expected promise to resolve but it resolved with undefined; expected rejection matching /404/

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability propagates network errors
AssertionError: expected promise to reject with error matching /network down/
```

（`resolves immediately without calling fetch when webhook is unset` ケースだけはスタブでも偶然 pass するが、設定時に POST・非2xx throw・network 伝播を要する3ケースは**スタブには未実装**なので予測どおり fail する。characterization ではない。）

- [ ] **Step 14: 緑にするため `probeReachability` を実装する → green を確認する**

`src/notifier.ts` の `probeReachability` スタブを、Step 12 のテストを満たす到達性検証実装へ差し替える（カーネル §9 step10）。

```typescript
  /**
   * プリフライト専用（カーネル §9 step10）。
   * Webhook 未設定なら即 resolve（fetch 不呼出）。設定時は最小 POST し、非2xx・network エラーで throw。
   * notify() と違い、ここでは到達性検証のため失敗を呼び出し元へ伝播する。
   */
  async probeReachability(): Promise<void> {
    if (this.webhookUrl === null) {
      return;
    }
    const res = await this.fetchFn(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "LoopPilot OS preflight reachability probe" }),
    });
    if (!res.ok) {
      throw new Error(
        `Slack webhook unreachable: POST returned HTTP ${res.status}`,
      );
    }
  }
```

再実行:

```
npx vitest run tests/notifier.test.ts
```

期待: 全9ケース pass（`9 passed`）。throw メッセージは `HTTP ${res.status}` を含むため `/404/` にマッチし、network エラーは throw がそのまま伝播するため `/network down/` にマッチする。

- [ ] **Step 15: `npm run check` を通す**

```
npm run check
```

期待: グリーン。

- [ ] **Step 16: probe 実装＋テストをコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier probeReachability with throw-condition tests"
```


---

### Task 7: TaskSource（Linear GraphQL）

**目的**: Linear GraphQL を `fetch` POST で叩く `LinearTaskSource`（カーネル §2 `TaskSource` 実装）と、プリフライト/main が使う `resolveLinearSetup`（team/project/4状態/ラベルの ID 解決）を実装する。SELECT の決定的順序（優先度の意味写像 → sortOrder → id）・除外・遷移・孤児検出を、フェイク `fetchFn` と fixture JSON で検証する。仕様 §5 SELECT / §6（検知の前段の冪等性）/ カーネル §5.5（GraphQL 契約）。

**依存タスク**: Task 2（`src/types.ts`: `TaskSource`, `EligibleIssue`, `TicketState`）。Task 3/4/5 には依存しない（このタスクは純粋に `fetchFn` 注入で完結する）。`better-sqlite3` 等の I/O は使わない。

**前提**:
- HTTP は Node 24 ネイティブ `fetch`。テストでは `fetchFn` を DI して実ネットワークを使わない。
- 注入する `fetchFn` の型は Web 標準 `fetch` のサブセット: `(url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>`。`src/task-source.ts` 内に `FetchFn` 型として定義し export する（Task 15/16 の本番配線が `globalThis.fetch` を渡せるように）。
- Linear API は GraphQL を 200 で返し、エラーは本文 `{ errors: [...] }` に入る（HTTP ステータスは 200 のことがある）。よって「`!ok`（HTTP 非2xx）」と「`body.errors` 非空」の両方を失敗として扱う。
- GraphQL クエリ・mutation 文字列はカーネル §5.5 と**一字一句一致**させる。

---

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/task-source.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/task-source.test.ts`
- Create (fixtures): `/home/racoma-dev/loop-pilot-os/tests/fixtures/linear-eligible.json`, `linear-eligible-priority.json`, `linear-eligible-empty.json`, `linear-errors.json`, `linear-orphans.json`, `linear-issue-update-success.json`, `linear-issue-update-fail.json`, `linear-resolve-setup.json`, `linear-resolve-setup-workspace-label.json`, `linear-resolve-setup-missing.json`

---

- [ ] **Step 1: fixture — 適格チケット（基本）を作成する**

  `tests/fixtures/linear-eligible.json` を作成（決定的順序の検証用。`priority` と `sortOrder` と `id` をわざと「ソート前の生順」に並べる。期待結果: 優先度写像 1→0(U), 2→1(H), 3→2(M), 4→3(L), 0→4(None) → sortOrder昇順 → id昇順）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-medium", "identifier": "TY-3", "title": "Medium task", "description": "m", "priority": 3, "sortOrder": 10, "url": "https://linear.app/ty/issue/TY-3" },
        { "id": "i-urgent", "identifier": "TY-1", "title": "Urgent task", "description": "u", "priority": 1, "sortOrder": 99, "url": "https://linear.app/ty/issue/TY-1" },
        { "id": "i-none", "identifier": "TY-5", "title": "No priority task", "description": "", "priority": 0, "sortOrder": 1, "url": "https://linear.app/ty/issue/TY-5" },
        { "id": "i-low", "identifier": "TY-4", "title": "Low task", "description": "l", "priority": 4, "sortOrder": 5, "url": "https://linear.app/ty/issue/TY-4" },
        { "id": "i-high", "identifier": "TY-2", "title": "High task", "description": "h", "priority": 2, "sortOrder": 50, "url": "https://linear.app/ty/issue/TY-2" }
      ]
    }
  }
}
```

- [ ] **Step 2: fixture — 同値タイブレーク（sortOrder 同値・優先度逆転）を作成する**

  `tests/fixtures/linear-eligible-priority.json` を作成（優先度が同じものは sortOrder で、sortOrder も同じなら id で決まることを示す。意味写像の検証として `priority:0`（None）が `priority:4`（Low）より後ろに来ることを含める）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-b", "identifier": "TY-20", "title": "High b", "description": "", "priority": 2, "sortOrder": 7, "url": "https://linear.app/ty/issue/TY-20" },
        { "id": "i-a", "identifier": "TY-21", "title": "High a", "description": "", "priority": 2, "sortOrder": 7, "url": "https://linear.app/ty/issue/TY-21" },
        { "id": "i-none1", "identifier": "TY-22", "title": "None", "description": "", "priority": 0, "sortOrder": 1, "url": "https://linear.app/ty/issue/TY-22" },
        { "id": "i-low1", "identifier": "TY-23", "title": "Low", "description": "", "priority": 4, "sortOrder": 999, "url": "https://linear.app/ty/issue/TY-23" }
      ]
    }
  }
}
```

- [ ] **Step 3: fixture — 空キュー / GraphQL エラー / 遷移 success・fail を作成する**

  4 ファイルを作成。

  `tests/fixtures/linear-eligible-empty.json`:

```json
{ "data": { "issues": { "nodes": [] } } }
```

  `tests/fixtures/linear-errors.json`（Linear の GraphQL エラー形。HTTP 200 でも `errors` が入る）:

```json
{
  "errors": [
    { "message": "Authentication required, not authenticated", "extensions": { "type": "authentication" } }
  ]
}
```

  `tests/fixtures/linear-issue-update-success.json`:

```json
{ "data": { "issueUpdate": { "success": true } } }
```

  `tests/fixtures/linear-issue-update-fail.json`:

```json
{ "data": { "issueUpdate": { "success": false } } }
```

- [ ] **Step 4: fixture — 孤児検出（In Progress）を作成する**

  `tests/fixtures/linear-orphans.json`（in_progress stateId で取得した issues。`knownIssueIds` 外のものが孤児）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-known", "identifier": "TY-100", "title": "Tracked WIP", "description": "", "priority": 2, "sortOrder": 3, "url": "https://linear.app/ty/issue/TY-100" },
        { "id": "i-orphan", "identifier": "TY-101", "title": "Orphan WIP", "description": "", "priority": 1, "sortOrder": 4, "url": "https://linear.app/ty/issue/TY-101" }
      ]
    }
  }
}
```

- [ ] **Step 5: fixture — resolveLinearSetup の解決成功 / 不在を作成する**

  `tests/fixtures/linear-resolve-setup.json`（viewer + teams(states) + projects + labels をまとめて返す 1 レスポンス）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" },
            { "id": "state-done", "name": "Done" }
          ] },
          "labels": { "nodes": [
            { "id": "label-aiok", "name": "ai-ok" }
          ] }
        },
        {
          "id": "team-uuid-2",
          "key": "OTHER",
          "states": { "nodes": [] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-1", "name": "LoopPilot OS" },
        { "id": "project-uuid-2", "name": "Other Project" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-bug", "name": "bug" }
    ] }
  }
}
```

  `tests/fixtures/linear-resolve-setup-workspace-label.json`（opt-in ラベルが team スコープには無く、ワークスペースラベルとしてのみ存在する。`team.labels`+workspace labels の和集合解決を固定する。team ラベルは空、`issueLabels` に `ai-ok` がある）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" },
            { "id": "state-done", "name": "Done" }
          ] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-1", "name": "LoopPilot OS" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-aiok-ws", "name": "ai-ok" }
    ] }
  }
}
```

  `tests/fixtures/linear-resolve-setup-missing.json`（team は在るが project / 状態 "Done" / ラベルが欠ける。複数欠落を 1 回でまとめて報告する検証用。`team.labels` も workspace `issueLabels` も `ai-ok` を含まない）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" }
          ] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-2", "name": "Other Project" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-bug", "name": "bug" }
    ] }
  }
}
```

- [ ] **Step 6: 失敗するテストを書く（task-source.test.ts 全体）**

  `tests/task-source.test.ts` を作成。`makeFetch` ヘルパで「呼ばれた body に応じて fixture を返す or 連続キューで返す」フェイク `fetchFn` を組む。実装は未作成なので import が解決できず全テストが失敗する。

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LinearTaskSource,
  resolveLinearSetup,
  type FetchFn,
} from "../src/task-source.js";
import type { TicketState } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

/**
 * フェイク fetchFn。responses を順に返す（HTTP 200/ok=true 既定）。
 * calls に request の body を記録する。各 response は { status?, ok?, body } で
 * HTTP レイヤの失敗も注入できる。
 */
function makeFetch(
  responses: Array<{ status?: number; ok?: boolean; body: unknown }>,
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    const parsed = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({
      url,
      headers: init.headers,
      query: parsed.query,
      variables: parsed.variables,
    });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  };
  return { fetchFn, calls };
}

const STATE_IDS: Record<TicketState, string> = {
  todo: "state-todo",
  in_progress: "state-wip",
  in_review: "state-review",
  done: "state-done",
};

function makeSource(fetchFn: FetchFn): LinearTaskSource {
  return new LinearTaskSource({
    apiKey: "lin_api_test",
    projectId: "project-uuid-1",
    stateIds: STATE_IDS,
    optInLabel: "ai-ok",
    fetchFn,
  });
}

describe("LinearTaskSource.getNextEligible", () => {
  // 仕様 §5 SELECT 決定的順序: ①意味的優先度 Urgent>High>Medium>Low>No priority
  // ②sortOrder 昇順 ③id 昇順。先頭(=Urgent)を返す。
  it("returns the urgent issue first regardless of fetch order", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([]);
    expect(result?.id).toBe("i-urgent");
    expect(result?.identifier).toBe("TY-1");
    // 適格クエリは projectId / todoStateId / label を variables で渡す（カーネル §5.5）
    expect(calls[0].variables).toEqual({
      projectId: "project-uuid-1",
      todoStateId: "state-todo",
      label: "ai-ok",
    });
    expect(calls[0].headers.Authorization).toBe("lin_api_test");
    expect(calls[0].url).toBe("https://api.linear.app/graphql");
  });

  // priority の意味写像: No priority(0) は最後、Low(4) より後ろに来る。
  // 同優先度は sortOrder、同 sortOrder は id で決まる。
  it("orders by mapped priority then sortOrder then id (None is last)", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-priority.json") },
    ]);
    // 先頭は High かつ sortOrder=7 同値 → id 昇順で "i-a" が先（"i-a" < "i-b"）。
    const first = await makeSource(fetchFn).getNextEligible([]);
    expect(first?.id).toBe("i-a");
  });

  // excludeIds（Store 由来の進行中 issue id）を除外して次点を返す。
  it("skips excluded ids and returns the next deterministic issue", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    // Urgent(i-urgent) を除外 → 次は High(i-high)。
    const result = await makeSource(fetchFn).getNextEligible(["i-urgent"]);
    expect(result?.id).toBe("i-high");
  });

  // 適格なし → null（仕様 §5: 適格なし → IDLE）。
  it("returns null when no eligible issues remain", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-empty.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([]);
    expect(result).toBeNull();
  });

  // 全件が excludeIds に含まれるなら null。
  it("returns null when every eligible issue is excluded", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([
      "i-urgent",
      "i-high",
      "i-medium",
      "i-low",
      "i-none",
    ]);
    expect(result).toBeNull();
  });

  // GraphQL errors は throw（HTTP 200 でも errors があれば失敗扱い）。
  it("throws when the GraphQL response carries errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(makeSource(fetchFn).getNextEligible([])).rejects.toThrow(
      /Linear GraphQL error/i,
    );
  });

  // HTTP 非2xx は throw。
  it("throws on a non-2xx HTTP response", async () => {
    const { fetchFn } = makeFetch([
      { ok: false, status: 500, body: {} },
    ]);
    await expect(makeSource(fetchFn).getNextEligible([])).rejects.toThrow(
      /Linear HTTP 500/i,
    );
  });
});

describe("LinearTaskSource.transition", () => {
  // 遷移は issueUpdate mutation（カーネル §5.5）。stateId を引く。
  it("calls issueUpdate with the mapped stateId", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-issue-update-success.json") },
    ]);
    await makeSource(fetchFn).transition("i-urgent", "in_progress");
    expect(calls[0].query).toContain("issueUpdate");
    expect(calls[0].variables).toEqual({
      id: "i-urgent",
      stateId: "state-wip",
    });
  });

  // success==false は throw。
  it("throws when issueUpdate returns success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-issue-update-fail.json") },
    ]);
    await expect(
      makeSource(fetchFn).transition("i-urgent", "done"),
    ).rejects.toThrow(/issueUpdate failed/i);
  });

  // GraphQL errors も throw。
  it("throws when issueUpdate response carries GraphQL errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(
      makeSource(fetchFn).transition("i-urgent", "todo"),
    ).rejects.toThrow(/Linear GraphQL error/i);
  });
});

describe("LinearTaskSource.findOrphanedInProgress", () => {
  // in_progress stateId でクエリし knownIssueIds 外を返す（CLAIM 途中クラッシュ孤児）。
  it("returns in-progress issues not in knownIssueIds", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-orphans.json") },
    ]);
    const orphans = await makeSource(fetchFn).findOrphanedInProgress([
      "i-known",
    ]);
    expect(orphans.map((o) => o.id)).toEqual(["i-orphan"]);
    expect(orphans[0].identifier).toBe("TY-101");
    // in_progress stateId でフィルタしている。
    expect(calls[0].variables).toEqual({
      projectId: "project-uuid-1",
      todoStateId: "state-wip",
      label: "ai-ok",
    });
  });

  // 全て既知なら空配列。
  it("returns an empty array when all in-progress issues are known", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-orphans.json") },
    ]);
    const orphans = await makeSource(fetchFn).findOrphanedInProgress([
      "i-known",
      "i-orphan",
    ]);
    expect(orphans).toEqual([]);
  });
});

describe("resolveLinearSetup", () => {
  // viewer 検証 + team/project/4状態/ラベルの ID 解決（カーネル §5.5 プリフライト解決）。
  it("resolves all ids when team/project/states/label exist", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-resolve-setup.json") },
    ]);
    const resolved = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    );
    expect(resolved).toEqual({
      viewerId: "user-1",
      teamId: "team-uuid-1",
      projectId: "project-uuid-1",
      stateIds: {
        todo: "state-todo",
        in_progress: "state-wip",
        in_review: "state-review",
        done: "state-done",
      },
      optInLabelId: "label-aiok",
    });
    expect(calls[0].headers.Authorization).toBe("lin_api_test");
  });

  // opt-in ラベルが team スコープに無くワークスペースラベルとしてのみ存在する場合でも
  // 解決できる（カーネル §5.5: `team.labels`+workspace labels の和集合）。
  it("resolves the opt-in label from workspace-level labels when absent on the team", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-resolve-setup-workspace-label.json") },
    ]);
    const resolved = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    );
    expect(resolved.optInLabelId).toBe("label-aiok-ws");
  });

  // 不在要素は名前を列挙して 1 回でまとめて throw。
  it("throws listing every missing element", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-resolve-setup-missing.json") },
    ]);
    const err = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // project "LoopPilot OS" 不在 / state "Done" 不在 / label "ai-ok" 不在 を全て含む。
    expect(err.message).toContain("LoopPilot OS");
    expect(err.message).toContain("Done");
    expect(err.message).toContain("ai-ok");
  });

  // team key が無ければ team 名で throw（後続の解決に進まない）。
  it("throws when the team key is not found", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-resolve-setup.json") },
    ]);
    await expect(
      resolveLinearSetup(
        "lin_api_test",
        {
          teamKey: "NOPE",
          projectName: "LoopPilot OS",
          stateNames: {
            todo: "Todo",
            in_progress: "In Progress",
            in_review: "In Review",
            done: "Done",
          },
          optInLabel: "ai-ok",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/NOPE/);
  });

  // GraphQL errors は throw。
  it("throws when the setup query returns GraphQL errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(
      resolveLinearSetup(
        "lin_api_test",
        {
          teamKey: "TY",
          projectName: "LoopPilot OS",
          stateNames: {
            todo: "Todo",
            in_progress: "In Progress",
            in_review: "In Review",
            done: "Done",
          },
          optInLabel: "ai-ok",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/Linear GraphQL error/i);
  });
});
```

- [ ] **Step 7: テストを実行して失敗を確認する**

  ```
  npx vitest run tests/task-source.test.ts
  ```

  期待される失敗: `Failed to resolve import "../src/task-source.js"`（モジュール未作成）。全 `describe` ブロックがロード時エラーで collect 失敗する。

- [ ] **Step 8: `src/task-source.ts` を実装する（最小・完全形）**

  `src/task-source.ts` を作成。GraphQL 文字列はカーネル §5.5 と一字一句一致。`EligibleIssue` / `TicketState` / `TaskSource` は Task 2 の `src/types.ts` から import。

```typescript
import type { EligibleIssue, TaskSource, TicketState } from "./types.js";

/** Web 標準 fetch のサブセット。本番は globalThis.fetch、テストはフェイクを注入する。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// カーネル §5.5: 適格チケット取得（1クエリ、client-side で決定的順序）。一字一句一致。
const ELIGIBLE_QUERY = `query Eligible($projectId: ID, $todoStateId: ID!, $label: String!) {
  issues(first: 50, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url } }
}`;

// カーネル §5.5: 遷移 mutation。一字一句一致。
const TRANSITION_MUTATION = `mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

// カーネル §5.5 プリフライト解決: viewer 検証 + team/project/states/labels。
// ラベルは team.labels + ワークスペース全体の issueLabels の和集合で解決する
// （opt_in_label がワークスペースラベルとして定義されているケースに対応）。
const SETUP_QUERY = `query Setup {
  viewer { id name }
  teams { nodes { id key states { nodes { id name } } labels { nodes { id name } } } }
  projects { nodes { id name } }
  issueLabels { nodes { id name } }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  sortOrder: number;
  url: string;
}

interface IssuesData {
  issues: { nodes: IssueNode[] };
}

/** 優先度の意味写像（カーネル §5.5 / 仕様 §5）: 1→0, 2→1, 3→2, 4→3, 0→4。 */
function priorityRank(priority: number): number {
  switch (priority) {
    case 1:
      return 0; // Urgent
    case 2:
      return 1; // High
    case 3:
      return 2; // Medium
    case 4:
      return 3; // Low
    default:
      return 4; // No priority (0)
  }
}

/** ①意味的優先度 ②sortOrder 昇順 ③id 昇順 の決定的比較。 */
function compareIssues(a: IssueNode, b: IssueNode): number {
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function toEligible(node: IssueNode): EligibleIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    priority: node.priority,
    sortOrder: node.sortOrder,
    url: node.url,
  };
}

async function graphql<T>(
  fetchFn: FetchFn,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear HTTP ${res.status}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear GraphQL error: ${msg}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL error: response had no data");
  }
  return body.data;
}

export interface LinearTaskSourceOptions {
  apiKey: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabel: string;
  fetchFn: FetchFn;
}

export class LinearTaskSource implements TaskSource {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly optInLabel: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: LinearTaskSourceOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.stateIds = opts.stateIds;
    this.optInLabel = opts.optInLabel;
    this.fetchFn = opts.fetchFn;
  }

  private async queryByState(stateId: string): Promise<IssueNode[]> {
    const data = await graphql<IssuesData>(
      this.fetchFn,
      this.apiKey,
      ELIGIBLE_QUERY,
      {
        projectId: this.projectId,
        todoStateId: stateId,
        label: this.optInLabel,
      },
    );
    return data.issues.nodes;
  }

  async getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null> {
    const exclude = new Set(excludeIds);
    const nodes = (await this.queryByState(this.stateIds.todo))
      .filter((n) => !exclude.has(n.id))
      .sort(compareIssues);
    const first = nodes[0];
    return first ? toEligible(first) : null;
  }

  async transition(issueId: string, state: TicketState): Promise<void> {
    const data = await graphql<{ issueUpdate: { success: boolean } }>(
      this.fetchFn,
      this.apiKey,
      TRANSITION_MUTATION,
      { id: issueId, stateId: this.stateIds[state] },
    );
    if (!data.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate failed for ${issueId} -> ${state}`,
      );
    }
  }

  async findOrphanedInProgress(
    knownIssueIds: string[],
  ): Promise<EligibleIssue[]> {
    const known = new Set(knownIssueIds);
    const nodes = await this.queryByState(this.stateIds.in_progress);
    return nodes.filter((n) => !known.has(n.id)).map(toEligible);
  }
}

// ---- プリフライト/main 用のセットアップ解決 ----

interface SetupData {
  viewer: { id: string; name: string };
  teams: {
    nodes: Array<{
      id: string;
      key: string;
      states: { nodes: Array<{ id: string; name: string }> };
      labels: { nodes: Array<{ id: string; name: string }> };
    }>;
  };
  projects: { nodes: Array<{ id: string; name: string }> };
  // ワークスペース全体のラベル（team スコープに無いラベルの解決に使う）。
  issueLabels: { nodes: Array<{ id: string; name: string }> };
}

export interface LinearSetupRequest {
  teamKey: string;
  projectName: string;
  stateNames: Record<TicketState, string>;
  optInLabel: string;
}

export interface ResolvedLinearSetup {
  viewerId: string;
  teamId: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabelId: string;
}

const TICKET_STATES: TicketState[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

/**
 * viewer を検証し、team key / project 名 / 4状態名 / opt-in ラベル名を ID に解決する。
 * 見つからない要素は名前を列挙して 1 回でまとめて throw（プリフライトの fail-fast 用）。
 */
export async function resolveLinearSetup(
  apiKey: string,
  req: LinearSetupRequest,
  fetchFn: FetchFn,
): Promise<ResolvedLinearSetup> {
  const data = await graphql<SetupData>(fetchFn, apiKey, SETUP_QUERY, {});

  const team = data.teams.nodes.find((t) => t.key === req.teamKey);
  if (!team) {
    throw new Error(`Linear team not found: key "${req.teamKey}"`);
  }

  const missing: string[] = [];

  const project = data.projects.nodes.find(
    (p) => p.name === req.projectName,
  );
  if (!project) {
    missing.push(`project "${req.projectName}"`);
  }

  const stateIds = {} as Record<TicketState, string>;
  for (const state of TICKET_STATES) {
    const wantedName = req.stateNames[state];
    const found = team.states.nodes.find((s) => s.name === wantedName);
    if (found) {
      stateIds[state] = found.id;
    } else {
      missing.push(`state "${wantedName}"`);
    }
  }

  // ラベルは team スコープ + ワークスペーススコープの和集合から解決する
  // （カーネル §5.5: `team.labels`+workspace labels）。team ラベルを優先。
  const label =
    team.labels.nodes.find((l) => l.name === req.optInLabel) ??
    data.issueLabels.nodes.find((l) => l.name === req.optInLabel);
  if (!label) {
    missing.push(`label "${req.optInLabel}"`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Linear setup resolution failed; not found: ${missing.join(", ")}`,
    );
  }

  return {
    viewerId: data.viewer.id,
    teamId: team.id,
    // project と label は missing.length===0 の時点で必ず解決済み。
    projectId: project!.id,
    stateIds,
    optInLabelId: label!.id,
  };
}
```

- [ ] **Step 9: テストを実行して成功を確認する**

  ```
  npx vitest run tests/task-source.test.ts
  ```

  期待: 全テストパス（`getNextEligible` 7件・`transition` 3件・`findOrphanedInProgress` 2件・`resolveLinearSetup` 5件 = 17 passed）。

- [ ] **Step 10: 型チェックを通す**

  ```
  npm run check
  ```

  期待: `tsc -p tsconfig.json`（src）と `tsc -p tsconfig.test.json`（tests 含む）と vitest が全てグリーン。`project!`/`label!` の non-null は `missing.length===0` 保証下でのみ使用しており strict 下でも型エラーなし。

- [ ] **Step 11: red→green をコミットする**

  ```
  git add src/task-source.ts tests/task-source.test.ts tests/fixtures/linear-eligible.json tests/fixtures/linear-eligible-priority.json tests/fixtures/linear-eligible-empty.json tests/fixtures/linear-errors.json tests/fixtures/linear-orphans.json tests/fixtures/linear-issue-update-success.json tests/fixtures/linear-issue-update-fail.json tests/fixtures/linear-resolve-setup.json tests/fixtures/linear-resolve-setup-workspace-label.json tests/fixtures/linear-resolve-setup-missing.json
  git commit -m "feat: LinearTaskSource + resolveLinearSetup (Linear GraphQL via fetch)"
  ```


---

### Task 8: Git/PR Manager

**目的**: 封筒（envelope）担当の `GitPrManager` を実装する。CLAIM フェーズの worktree/ブランチ作成、IMPLEMENT 後条件の実差分・未コミット検査、HANDOFF の push→PR作成→ラベル、DONE のマージ、cost_exceeded 時の破棄を、すべて `git`/`gh` CLI 呼び出しに翻訳する。コマンドの argv は本体を一切実行せず `CommandRunner` 抽象越しに発行し、テストは `FakeCommandRunner` で argv 完全一致（cwd 含む）を検証する。実 git/gh は使わない。

**依存タスク**: Task 2（`src/types.ts` の `GitPrManager`/`CommandRunner`/`EligibleIssue`/`ClaimResult`/`CommandResult`/`RunOptions` 型）、Task 3（`src/exec.ts` の実 `CommandRunner` と `tests/fakes.ts` の `FakeCommandRunner`/`FakeCommandRunner.on`）。本タスクはこれらの export を**消費する**だけで再定義しない。

**契約の出所**: 構築引数はカーネル §2 の `GitPrManager` インターフェース全メソッド + 本タスクスコープの opts。コマンド文字列はカーネル §5.2（git）/ §5.3（gh）と**一字一句一致**。slug 規則・衝突サフィックス・PR番号 parse は §5.2/§5.3 + 仕様 §5 CLAIM/HANDOFF。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/git-pr.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/git-pr.test.ts`

---

#### 設計メモ（実装前に固定する不変条件）

- 構築: `new GitPrManager(runner, opts)`。`runner: CommandRunner`、`opts: { repoPath: string; remote: string; defaultBranch: string; branchPrefix: string; worktreeRoot: string; prBodyTemplate: string; gateLabel: string }`。すべて Config 由来で解決済み（`worktreeRoot` は既定値解決済みの絶対パス）。
- `runner.run(cmd, args, opts)` の `opts.cwd` は **必ず明示**する。`git -C <path>` 形式で path を渡すコマンドでも cwd は `repoPath`（または worktree path）を渡す（§5.2 は `git -C` を使うが、CommandRunner は cwd 必須なので両方そろえる。テストは cwd を含めて検証する）。gh コマンドは `-R <remote>` でリポを指定するため cwd は `repoPath` を渡す。
- slug: `slugify(title)` = title を小文字化し `[^a-z0-9]+` を `-` に圧縮、先頭末尾の `-` を除去、30 文字に切詰め（切詰め後の末尾 `-` も除去）。identifier も小文字化。ブランチ名 = `<branchPrefix>/<identifier小文字>-<slug>`。
- fetch: `prepareWorktree` 先頭の `git fetch origin <defaultBranch>` は `code != 0`（ネットワーク断・remote 不達等）なら**即 throw**し、`worktree add` を一切呼ばない。陳腐化したローカル ref（古い `origin/<defaultBranch>`）の上で worktree を作る実害を防ぎ、カーネル §2『失敗は throw』契約と Orchestrator §7 step3『prepareWorktree 失敗 → HALT』安全弁を成立させる。
- 衝突: `git worktree add` が `code != 0` かつ stderr に `already exists` を含む場合のみ衝突とみなし、ブランチ名末尾に `-2`..`-5` を付けて再試行する。`-5` でも衝突したら throw。`already exists` 以外の失敗は即 throw（衝突ではない）。
- `hasCommitsWithDiff`: `rev-list --count origin/<defaultBranch>..HEAD` の stdout を整数 parse し `> 0`、**かつ** `diff --quiet origin/<defaultBranch>..HEAD` の `code != 0`（差分あり）。両方満たして true。
- `pushAndOpenPr`: push → `gh pr create`（`--body` は `prBodyTemplate` の `{identifier}`/`{title}`/`{issue_url}` を置換した完成本文を spawn 引数として直渡し。一時ファイル不要）→ stdout から `/pull/(\d+)` を抽出して number 化。マッチ無し/NaN は throw。
- `findOpenPrForBranch`: `gh pr list ... --json number` の stdout を `JSON.parse`（配列）。空配列 → `null`、先頭要素の `number` を返す。
- `discardWorktree`: `worktree remove --force` → `branch -D` の順（§5.2）。

---

- [ ] **Step 1: `prepareWorktree` の全挙動（正常系・衝突 -2・全滅・非衝突即throw・fetch失敗ガード・slug切詰め）を網羅する失敗テスト群を書く**

> このステップで `prepareWorktree` が満たすべき 6 挙動すべてを**実装より前に**赤にする。`src/git-pr.ts` が存在しないため、全テストが import 解決エラー（モジュール未作成）で一斉に赤になる。これにより各挙動が「テスト→失敗確認→実装→成功確認」（カーネル §11 line 521）の赤フェーズを必ず一度経る。挙動を後追いテストで「追加→即 green」する赤抜きステップは作らない。

`/home/racoma-dev/loop-pilot-os/tests/git-pr.test.ts` を新規作成:

```typescript
import { describe, it, expect } from "vitest";
import { GitPrManager } from "../src/git-pr.js";
import { FakeCommandRunner } from "./fakes.js";
import type { EligibleIssue } from "../src/types.js";

// 共通: 構築 opts（全テストで同一）
const OPTS = {
  repoPath: "/repo",
  remote: "owner/name",
  defaultBranch: "main",
  branchPrefix: "looppilot",
  worktreeRoot: "/wt",
  prBodyTemplate: "Implements {identifier}: {title}\n\n{issue_url}\n",
  gateLabel: "loop-pilot",
};

function issue(over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id: "uuid-1",
    identifier: "TY-123",
    title: "Add the login flow!",
    description: "",
    priority: 2,
    sortOrder: 1,
    url: "https://linear.app/team/issue/TY-123",
    ...over,
  };
}

describe("GitPrManager.prepareWorktree", () => {
  // 仕様 §5 CLAIM: デフォルトブランチからブランチ <prefix>/<id小文字>-<slug> + worktree
  // カーネル §5.2: fetch origin <defaultBranch> → worktree add -b <branch> <wtPath> origin/<defaultBranch>
  it("fetches default branch then adds a worktree from origin/<defaultBranch> with slugified branch", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    // slug: "add the login flow!" → "add-the-login-flow"（30字以内、末尾 ! は除去）
    const branch = "looppilot/ty-123-add-the-login-flow";
    const wtPath = "/wt/ty-123-add-the-login-flow";
    expect(result).toEqual({ branch, worktreePath: wtPath });

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "fetch", "origin", "main"],
      opts: { cwd: "/repo" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "add", "-b", branch, wtPath, "origin/main"],
      opts: { cwd: "/repo" },
    });
  });

  it("appends -2 on 'already exists' collision and adds the worktree on the retried branch", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    // 最初のブランチは衝突、-2 は成功（args[5] = -b の次 = branch 名で分岐）
    runner.on(["git", "-C", "/repo", "worktree", "add"], (args) => {
      const branch = args[5];
      if (branch === "looppilot/ty-123-add-the-login-flow") {
        return { code: 128, stdout: "", stderr: "fatal: a branch named 'x' already exists" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    expect(result).toEqual({
      branch: "looppilot/ty-123-add-the-login-flow-2",
      worktreePath: "/wt/ty-123-add-the-login-flow-2",
    });
    // fetch + 2 回の worktree add
    expect(runner.calls.map((c) => c.args[5]).filter(Boolean)).toEqual([
      "looppilot/ty-123-add-the-login-flow",
      "looppilot/ty-123-add-the-login-flow-2",
    ]);
  });

  it("throws when -2..-5 are all exhausted by collisions", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], {
      code: 128,
      stdout: "",
      stderr: "fatal: already exists",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/collision exhausted/);
    // base + -2 + -3 + -4 + -5 = 5 回の worktree add 試行
    const adds = runner.calls.filter((c) => c.args[3] === "add");
    expect(adds).toHaveLength(5);
  });

  it("throws immediately on a non-'already exists' worktree add failure", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], {
      code: 1,
      stdout: "",
      stderr: "fatal: permission denied",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/permission denied/);
    // 衝突ではないので 1 回だけ試行
    const adds = runner.calls.filter((c) => c.args[3] === "add");
    expect(adds).toHaveLength(1);
  });

  it("throws when 'git fetch' exits non-zero and never calls worktree add", async () => {
    const runner = new FakeCommandRunner();
    // fetch が非0（ネットワーク断・remote 不達等）。worktree add は登録するが呼ばれてはならない
    runner.on(["git", "-C", "/repo", "fetch"], {
      code: 128,
      stdout: "",
      stderr: "fatal: unable to access remote",
    });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    // 契約（カーネル §2）: prepareWorktree は失敗を throw。陳腐化した base 上で worktree を作らない
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/fetch origin main failed/);
    // fetch のみ実行し、worktree add は一切呼ばない（calls 長 1）
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
  });

  it("truncates the slug to 30 chars and strips a trailing hyphen", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    // title 38字。slug 部は title から生成し 30 字で切詰め、末尾ハイフン除去
    const result = await mgr.prepareWorktree(
      issue({ title: "Refactor the authentication module now" }),
    );
    // "refactor-the-authentication-module-now" → 先頭30字 "refactor-the-authentication-mo"
    expect(result.branch).toBe("looppilot/ty-123-refactor-the-authentication-mo");
  });
});
```

実行して **失敗** を確認（`src/git-pr.ts` が無いため import 解決エラーで全 6 テストが赤）:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `Failed to resolve import "../src/git-pr.js"` / `Cannot find module`（モジュール未作成）。この時点で 6 テストすべてが赤であることを確認する（衝突・全滅・非衝突即throw・fetch失敗ガード・slug切詰めの各挙動が一度ずつ赤フェーズを経る）。

- [ ] **Step 2: `src/git-pr.ts` に slug ヘルパと `prepareWorktree`（衝突対応・fetch失敗ガード込み）を実装し Step 1 の 6 テストを緑にする**

`/home/racoma-dev/loop-pilot-os/src/git-pr.ts` を新規作成:

```typescript
import type {
  CommandRunner,
  EligibleIssue,
  ClaimResult,
  GitPrManager as GitPrManagerInterface,
} from "./types.js";

export interface GitPrManagerOptions {
  repoPath: string;
  remote: string;
  defaultBranch: string;
  branchPrefix: string;
  worktreeRoot: string;
  prBodyTemplate: string;
  gateLabel: string;
}

/** title を小文字化し英数字以外を "-" に圧縮、先頭末尾 "-" 除去、30字に切詰め */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = base.slice(0, 30);
  return truncated.replace(/-+$/g, "");
}

export class GitPrManager implements GitPrManagerInterface {
  private readonly runner: CommandRunner;
  private readonly opts: GitPrManagerOptions;

  constructor(runner: CommandRunner, opts: GitPrManagerOptions) {
    this.runner = runner;
    this.opts = opts;
  }

  async prepareWorktree(issue: EligibleIssue): Promise<ClaimResult> {
    const { repoPath, defaultBranch, branchPrefix, worktreeRoot } = this.opts;
    const slug = `${issue.identifier.toLowerCase()}-${slugify(issue.title)}`;

    const fetch = await this.runner.run(
      "git",
      ["-C", repoPath, "fetch", "origin", defaultBranch],
      { cwd: repoPath },
    );
    if (fetch.code !== 0) {
      throw new Error(
        `git fetch origin ${defaultBranch} failed: ${fetch.stderr.trim() || `exit ${fetch.code}`}`,
      );
    }

    const suffixes = ["", "-2", "-3", "-4", "-5"];
    for (const suffix of suffixes) {
      const branch = `${branchPrefix}/${slug}${suffix}`;
      const worktreePath = `${worktreeRoot}/${slug}${suffix}`;
      const res = await this.runner.run(
        "git",
        [
          "-C",
          repoPath,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          `origin/${defaultBranch}`,
        ],
        { cwd: repoPath },
      );
      if (res.code === 0) {
        return { branch, worktreePath };
      }
      if (!res.stderr.includes("already exists")) {
        throw new Error(
          `git worktree add failed for ${branch}: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
    }
    throw new Error(
      `git worktree add failed: branch name collision exhausted for ${branchPrefix}/${slug}`,
    );
  }
}
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: 6 tests passed（prepareWorktree describe 全体: 正常系 + 衝突 -2 + 全滅 + 非衝突即throw + fetch失敗ガード + slug切詰め）。Step 1 で import 解決エラーにより赤だった 6 挙動が、この実装で一斉に緑になる（各挙動が red→green を一度ずつ経る）。

> fetch 失敗ガードの恒久検証: もし `git fetch` の `res.code` 検査を外し fetch 結果を破棄する実装に退行すると、`worktree add` が陳腐化した base 上で成功し `calls` 長が 2 になり、Step 1 の「fetch 非0で worktree add を呼ばない」テストが落ちて契約違反（カーネル §2『失敗は throw』）を検知する。

`npm run check` を実行（tsc×2 + vitest グリーン）。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.prepareWorktree with slug + worktree add + collision/fetch guard"`

- [ ] **Step 3: `hasCommitsWithDiff` / `hasUncommittedChanges` の失敗テストを書く**

`tests/git-pr.test.ts` に新しい describe を追記:

```typescript
describe("GitPrManager.hasCommitsWithDiff", () => {
  // カーネル §5.2: rev-list --count origin/<defaultBranch>..HEAD > 0
  //                AND diff --quiet origin/<defaultBranch>..HEAD が非0（差分あり）
  it("returns true when there are commits ahead and the diff is non-empty", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "2\n", stderr: "" });
    runner.on(["git", "-C", "/wt/x", "diff", "--quiet"], { code: 1, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(true);

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "rev-list", "--count", "origin/main..HEAD"],
      opts: { cwd: "/wt/x" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "diff", "--quiet", "origin/main..HEAD"],
      opts: { cwd: "/wt/x" },
    });
  });

  it("returns false when there are zero commits ahead (skips diff check)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "0\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(false);
    // count==0 で短絡し diff は呼ばない
    expect(runner.calls).toHaveLength(1);
  });

  it("returns false when commits exist but diff --quiet reports no diff (code 0)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "3\n", stderr: "" });
    runner.on(["git", "-C", "/wt/x", "diff", "--quiet"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(false);
  });
});

describe("GitPrManager.hasUncommittedChanges", () => {
  // カーネル §5.2: git status --porcelain 非空
  it("returns true when status --porcelain output is non-empty", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], {
      code: 0,
      stdout: " M src/a.ts\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasUncommittedChanges("/wt/x")).toBe(true);
    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "status", "--porcelain"],
      opts: { cwd: "/wt/x" },
    });
  });

  it("returns false when status --porcelain output is empty (whitespace only)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], { code: 0, stdout: "\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasUncommittedChanges("/wt/x")).toBe(false);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.hasCommitsWithDiff is not a function` / `mgr.hasUncommittedChanges is not a function`（メソッド未実装）。

- [ ] **Step 4: `hasCommitsWithDiff` / `hasUncommittedChanges` を最小実装**

`src/git-pr.ts` の `prepareWorktree` メソッドの直後（class 内）に追記:

```typescript
  async hasCommitsWithDiff(worktreePath: string): Promise<boolean> {
    const { defaultBranch } = this.opts;
    const range = `origin/${defaultBranch}..HEAD`;

    const count = await this.runner.run(
      "git",
      ["-C", worktreePath, "rev-list", "--count", range],
      { cwd: worktreePath },
    );
    const ahead = Number.parseInt(count.stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead <= 0) {
      return false;
    }

    const diff = await this.runner.run(
      "git",
      ["-C", worktreePath, "diff", "--quiet", range],
      { cwd: worktreePath },
    );
    // diff --quiet: 差分なし → code 0、差分あり → code 1（非0）
    return diff.code !== 0;
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const res = await this.runner.run(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { cwd: worktreePath },
    );
    return res.stdout.trim().length > 0;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: hasCommitsWithDiff の 3 件 + hasUncommittedChanges の 2 件を含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager diff/uncommitted change detection"`

- [ ] **Step 5: `findOpenPrForBranch` の失敗テストを書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
describe("GitPrManager.findOpenPrForBranch", () => {
  // カーネル §5.3: gh pr list -R <o/n> --head <branch> --state open --json number
  it("issues the exact gh pr list argv and parses the first PR number from JSON", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: '[{"number":42}]',
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const n = await mgr.findOpenPrForBranch("looppilot/ty-123-x");
    expect(n).toBe(42);

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: [
        "pr",
        "list",
        "-R",
        "owner/name",
        "--head",
        "looppilot/ty-123-x",
        "--state",
        "open",
        "--json",
        "number",
      ],
      opts: { cwd: "/repo" },
    });
  });

  it("returns null when the JSON array is empty (no open PR)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.findOpenPrForBranch("looppilot/ty-123-x")).toBe(null);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.findOpenPrForBranch is not a function`（未実装）。

- [ ] **Step 6: `findOpenPrForBranch` を最小実装**

`src/git-pr.ts` の class 内（`hasUncommittedChanges` の後）に追記:

```typescript
  async findOpenPrForBranch(branch: string): Promise<number | null> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "list", "-R", remote, "--head", branch, "--state", "open", "--json", "number"],
      { cwd: repoPath },
    );
    const rows = JSON.parse(res.stdout) as Array<{ number: number }>;
    if (rows.length === 0) {
      return null;
    }
    return rows[0].number;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: findOpenPrForBranch の 2 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.findOpenPrForBranch via gh pr list"`

- [ ] **Step 7: `pushAndOpenPr` の失敗テストを書く（push→create の argv + 本文置換 + PR番号 parse）**

`tests/git-pr.test.ts` に describe を追記:

```typescript
describe("GitPrManager.pushAndOpenPr", () => {
  // カーネル §5.2 push: git -C <wt> push -u origin <branch>
  // カーネル §5.3 create: gh pr create -R <o/n> --base <defaultBranch> --head <branch>
  //                       --title "<identifier>: <title>" --body <本文>
  // PR番号: stdout 末尾 URL の /pull/(\d+)
  it("pushes then creates the PR with template-substituted body and parses the PR number", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], {
      code: 0,
      stdout: "https://github.com/owner/name/pull/57\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const branch = "looppilot/ty-123-x";
    const n = await mgr.pushAndOpenPr(branch, "/wt/x", issue());
    expect(n).toBe(57);

    // push の argv（cwd=worktree）
    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "push", "-u", "origin", branch],
      opts: { cwd: "/wt/x" },
    });

    // gh pr create の argv。--body は template 置換済み完成本文を直渡し
    const expectedBody =
      "Implements TY-123: Add the login flow!\n\n" +
      "https://linear.app/team/issue/TY-123\n";
    expect(runner.calls[1]).toEqual({
      cmd: "gh",
      args: [
        "pr",
        "create",
        "-R",
        "owner/name",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        "TY-123: Add the login flow!",
        "--body",
        expectedBody,
      ],
      opts: { cwd: "/repo" },
    });
  });

  it("throws when the PR create stdout has no /pull/<n> URL", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], {
      code: 0,
      stdout: "https://github.com/owner/name/tree/looppilot\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(
      mgr.pushAndOpenPr("looppilot/ty-123-x", "/wt/x", issue()),
    ).rejects.toThrow(/PR number/);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.pushAndOpenPr is not a function`（未実装）。

- [ ] **Step 8: `pushAndOpenPr` を最小実装（テンプレ置換ヘルパ込み）**

`src/git-pr.ts` の `slugify` 関数の直後（class の外、トップレベル）にテンプレ置換ヘルパを追記:

```typescript
/** prBodyTemplate の {identifier}/{title}/{issue_url} を置換（全出現を置換） */
function renderPrBody(template: string, issue: EligibleIssue): string {
  return template
    .replaceAll("{identifier}", issue.identifier)
    .replaceAll("{title}", issue.title)
    .replaceAll("{issue_url}", issue.url);
}
```

`src/git-pr.ts` の class 内（`findOpenPrForBranch` の後）に追記:

```typescript
  async pushAndOpenPr(
    branch: string,
    worktreePath: string,
    issue: EligibleIssue,
  ): Promise<number> {
    const { repoPath, remote, defaultBranch } = this.opts;

    await this.runner.run("git", ["-C", worktreePath, "push", "-u", "origin", branch], {
      cwd: worktreePath,
    });

    const body = renderPrBody(this.opts.prBodyTemplate, issue);
    const title = `${issue.identifier}: ${issue.title}`;
    const res = await this.runner.run(
      "gh",
      [
        "pr",
        "create",
        "-R",
        remote,
        "--base",
        defaultBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repoPath },
    );

    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (match === null) {
      throw new Error(`could not parse PR number from gh pr create output: ${res.stdout.trim()}`);
    }
    const prNumber = Number.parseInt(match[1], 10);
    if (!Number.isFinite(prNumber)) {
      throw new Error(`could not parse PR number from gh pr create output: ${res.stdout.trim()}`);
    }
    return prNumber;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: pushAndOpenPr の 2 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.pushAndOpenPr push + gh pr create + number parse"`

- [ ] **Step 9: `addLabel` / `mergePr` の失敗テストを書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
describe("GitPrManager.addLabel", () => {
  // カーネル §5.3: gh pr edit <n> -R <o/n> --add-label <gate_label>
  it("issues the exact gh pr edit argv with the gate label", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "edit"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.addLabel(57, "loop-pilot");

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: ["pr", "edit", "57", "-R", "owner/name", "--add-label", "loop-pilot"],
      opts: { cwd: "/repo" },
    });
  });

  it("throws when gh pr edit exits non-zero", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "edit"], { code: 1, stdout: "", stderr: "label not found" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.addLabel(57, "loop-pilot")).rejects.toThrow(/label not found/);
  });
});

describe("GitPrManager.mergePr", () => {
  // カーネル §5.3: gh pr merge <n> -R <o/n> --squash --match-head-commit <headSha>
  it("issues the exact gh pr merge argv with squash and match-head-commit", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.mergePr(57, "deadbeef");

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: ["pr", "merge", "57", "-R", "owner/name", "--squash", "--match-head-commit", "deadbeef"],
      opts: { cwd: "/repo" },
    });
  });

  it("throws when gh pr merge exits non-zero (caller maps to ci_failed/conflict)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 1, stdout: "", stderr: "not mergeable" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.mergePr(57, "deadbeef")).rejects.toThrow(/not mergeable/);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.addLabel is not a function` / `mgr.mergePr is not a function`（未実装）。

- [ ] **Step 10: `addLabel` / `mergePr` を最小実装**

`src/git-pr.ts` の class 内（`pushAndOpenPr` の後）に追記:

```typescript
  async addLabel(prNumber: number, label: string): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "edit", String(prNumber), "-R", remote, "--add-label", label],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      throw new Error(
        `gh pr edit --add-label failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

  async mergePr(prNumber: number, headSha: string): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "merge", String(prNumber), "-R", remote, "--squash", "--match-head-commit", headSha],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      throw new Error(
        `gh pr merge failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: addLabel/mergePr の 4 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.addLabel + mergePr via gh"`

- [ ] **Step 11: `discardWorktree` の失敗テスト（順序検証）を書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
describe("GitPrManager.discardWorktree", () => {
  // カーネル §5.2: worktree remove --force <wt> → branch -D <branch>（この順）
  it("removes the worktree first then deletes the branch, in that order", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "worktree", "remove"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "branch", "-D"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.discardWorktree("looppilot/ty-123-x", "/wt/ty-123-x");

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "remove", "--force", "/wt/ty-123-x"],
      opts: { cwd: "/repo" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "branch", "-D", "looppilot/ty-123-x"],
      opts: { cwd: "/repo" },
    });
    expect(runner.calls).toHaveLength(2);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.discardWorktree is not a function`（未実装）。

- [ ] **Step 12: `discardWorktree` を最小実装**

`src/git-pr.ts` の class 内（`mergePr` の後、class の末尾）に追記:

```typescript
  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    const { repoPath } = this.opts;
    await this.runner.run(
      "git",
      ["-C", repoPath, "worktree", "remove", "--force", worktreePath],
      { cwd: repoPath },
    );
    await this.runner.run("git", ["-C", repoPath, "branch", "-D", branch], {
      cwd: repoPath,
    });
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: 全 describe 全テスト passed（prepareWorktree / hasCommitsWithDiff / hasUncommittedChanges / findOpenPrForBranch / pushAndOpenPr / addLabel / mergePr / discardWorktree）。

`npm run check` グリーン（tsc src + tsc test + vitest 全グリーン）。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.discardWorktree (worktree remove + branch -D)"`

---

#### 完了確認（このタスクの受け入れ条件）

- `GitPrManager` がカーネル §2 の `GitPrManager` インターフェース全メソッド（`prepareWorktree` / `hasCommitsWithDiff` / `hasUncommittedChanges` / `findOpenPrForBranch` / `pushAndOpenPr` / `addLabel` / `mergePr` / `discardWorktree`）を実装し、各メソッドの引数・戻り値型がインターフェースと一致。
- 全 git/gh コマンドの argv が §5.2/§5.3 と一字一句一致（テストで cwd を含め完全一致検証）。
- slug 規則・衝突 `-2..-5`・全滅 throw・PR番号 parse 失敗 throw が網羅されている。
- `prepareWorktree` の `git fetch` が非0終了したら throw し（カーネル §2『失敗は throw』）、`worktree add` を呼ばない（陳腐化 base での worktree 作成を防止）ことがテストで検証されている。
- 実 git/gh を一切起動していない（`FakeCommandRunner` のみ）。
- `npm run check` グリーン。


---

### Task 9: Agent Runner（claude headless）

**目的**: worktree 内で `claude -p`（headless / stream-json）をコスト上限付きで起動し、NDJSON 進捗を1行ずつ解釈して、最終 `result` 行を `AgentOutcome`（completed / cost_exceeded / error）へ写像する `ClaudeAgentRunner` を実装する。これは per-task ライフサイクルの IMPLEMENT フェーズ（仕様§5.3）の実体であり、コスト一本化（仕様§11）に従い timeout は持たない。

**依存タスク**:
- Task 2（`src/types.ts`）: `AgentRunner` / `AgentOutcome` / `SessionContext` / `CommandRunner` / `RunOptions` / `CommandResult` を消費。
- Task 3（`src/exec.ts` / `tests/fakes.ts`）: 本タスクのテストは `tests/fakes.ts` の `FakeCommandRunner`（`on` / `calls` を持つ）を消費する。

**カバーする仕様**: §5（IMPLEMENT）/ §11（安全弁・コスト一本化）/ カーネル §5.1（claude headless 契約）。

---

## 設計メモ（実装前の確定事項・カーネル §5.1 準拠）

- クラス: `ClaudeAgentRunner implements AgentRunner`（`src/types.ts` の `AgentRunner` を実装）。
- コンストラクタ: `constructor(runner: CommandRunner, opts: { model: string; allowedTools: string; extraArgs: string[]; log: (line: string) => void })`。
- メソッド: `runSession(ctx: SessionContext): Promise<AgentOutcome>`。
- argv（カーネル §5.1 と一字一句一致）。コマンドは `"claude"`、引数配列は順に:
  ```
  -p <ctx.prompt>
  --output-format stream-json
  --max-budget-usd <ctx.maxCostUsd.toFixed(2)>
  --permission-mode acceptEdits
  --allowedTools <opts.allowedTools>
  --model <opts.model>
  ...opts.extraArgs
  ```
- `runner.run("claude", argv, { cwd: ctx.worktreePath, onStdoutLine })` を呼ぶ。`timeoutMs` は**設定しない**（仕様§11: コスト上限へ一本化）。
- `onStdoutLine` は NDJSON を1行ずつ受け取り `JSON.parse`。**parse 失敗（壊れた行）は無視**して継続（throw しない）。
  - `type==="system"` ∧ `subtype==="init"` → 開始ログ（`opts.log`）。他の `system` subtype（`hook_started` 等）は無視。
  - `type==="assistant"` → 進捗ログ。`message.content` 配列から最初の `type==="text"` 要素の `text` を取り、先頭 80 字を `opts.log`（text が無ければログしない）。
  - `type==="result"` → その行オブジェクトを `resultLine` として保持（最後に到達したもの）。
- プロセス終了後（`runner.run` の解決後）に `resultLine` と `code` から `AgentOutcome` を確定（カーネル §5.1 写像）:
  - `resultLine.subtype==="success"` → `{ kind: "completed", costUsd, summary }`。`summary` = `result` を 2000 字に切詰め。
  - `resultLine.subtype==="error_max_budget"` → `{ kind: "cost_exceeded", costUsd }`。
  - それ以外の subtype / `is_error===true` / `code !== 0` / `resultLine` 欠落 → `{ kind: "error", costUsd, message }`。
- `costUsd` は `resultLine.total_cost_usd`（数値）を採用。`resultLine` 欠落時は `0`。
- `error` の `message`: result 行欠落時は `"no result line emitted"`、非0終了時は `"claude exited with code <n>"`、is_error 時は `result` 文字列（無ければ `"agent error"`）。

> 検証メモ（計画作成時、claude 2.1.165 実測）: stream-json は NDJSON で `{"type":"system","subtype":"init",...}` / `{"type":"assistant","message":{"content":[{"type":"thinking",...},{"type":"text","text":"..."}]}}` / 末尾 `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":<number>,"result":"...","session_id":"..."}` を出力する。`system` には `init` 以外の subtype（`hook_started`/`thinking_tokens` 等）も混ざるため `subtype==="init"` で選別する。assistant content には `thinking` ブロックが先行し得るため `type==="text"` を探索する。

---

### Files:

- **Create**: `/home/racoma-dev/loop-pilot-os/src/agent-runner.ts`
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/agent-runner.test.ts`

---

- [ ] **Step 1: 失敗するテストを書く（正常系・argv 検証・cost_exceeded・error 各系・破損行・result 欠落）**

  `/home/racoma-dev/loop-pilot-os/tests/agent-runner.test.ts` を新規作成し、以下を全文で書く。`FakeCommandRunner`（`tests/fakes.ts`、Task 3 で定義）を使い、`on("claude", ...)` で登録したハンドラ内で `opts.onStdoutLine` に fixture の NDJSON 行を1行ずつ流し、`{ code }` を返す。

  ```typescript
  import { describe, it, expect } from "vitest";
  import { ClaudeAgentRunner } from "../src/agent-runner.js";
  import { FakeCommandRunner } from "./fakes.js";
  import type { RunOptions, CommandResult, SessionContext } from "../src/types.js";

  // 仕様§5.3 / カーネル§5.1: claude headless の stream-json NDJSON 行（実出力スナップショット相当）
  const INIT_LINE =
    '{"type":"system","subtype":"init","cwd":"/wt","session_id":"s1","model":"claude-opus","permissionMode":"acceptEdits"}';
  const HOOK_LINE =
    '{"type":"system","subtype":"hook_started","hook_id":"h1","session_id":"s1"}';
  const ASSISTANT_THINK_LINE =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"planning the change"}]},"session_id":"s1"}';
  const ASSISTANT_TEXT_LINE =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"Editing src/foo.ts to add the requested function and a unit test for it right now"}]},"session_id":"s1"}';
  const RESULT_SUCCESS_LINE =
    '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":1.2345,"result":"Added function foo and a test.","session_id":"s1"}';
  const RESULT_BUDGET_LINE =
    '{"type":"result","subtype":"error_max_budget","is_error":true,"total_cost_usd":10,"result":"budget exhausted","session_id":"s1"}';
  const RESULT_GENERIC_ERROR_LINE =
    '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.5,"result":"something went wrong","session_id":"s1"}';
  const RESULT_IS_ERROR_SUCCESS_SUBTYPE_LINE =
    '{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0.7,"result":"partial failure","session_id":"s1"}';
  const BROKEN_LINE = '{"type":"assistant", THIS IS NOT JSON';
  const EMPTY_LINE = "";

  // 行配列を onStdoutLine へ順次流し、code を返すハンドラを登録するヘルパ
  function runnerEmitting(
    lines: string[],
    code = 0,
  ): { runner: FakeCommandRunner; emittedCwd: () => string | undefined } {
    const runner = new FakeCommandRunner();
    let seenCwd: string | undefined;
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      seenCwd = opts.cwd;
      for (const line of lines) {
        opts.onStdoutLine?.(line);
      }
      return { code, stdout: "", stderr: "" };
    });
    return { runner, emittedCwd: () => seenCwd };
  }

  function makeRunner(runner: FakeCommandRunner, logs: string[]): ClaudeAgentRunner {
    return new ClaudeAgentRunner(runner, {
      model: "opus",
      allowedTools: "Edit,Write,Read,Glob,Grep,Bash",
      extraArgs: [],
      log: (line: string) => logs.push(line),
    });
  }

  const ctx: SessionContext = {
    worktreePath: "/wt",
    prompt: "implement the feature",
    maxCostUsd: 10,
  };

  describe("ClaudeAgentRunner.runSession", () => {
    it("カーネル§5.1: argv を一字一句で組み立て cwd=worktreePath で claude を起動する", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession(ctx);

      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.cmd).toBe("claude");
      expect(call.args).toEqual([
        "-p",
        "implement the feature",
        "--output-format",
        "stream-json",
        "--max-budget-usd",
        "10.00",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Edit,Write,Read,Glob,Grep,Bash",
        "--model",
        "opus",
      ]);
      expect(call.opts.cwd).toBe("/wt");
      // 仕様§11: コスト一本化のため timeoutMs は設定しない
      expect(call.opts.timeoutMs).toBeUndefined();
    });

    it("カーネル§5.1: max-budget-usd は ctx.maxCostUsd を toFixed(2) で渡す", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession({ ...ctx, maxCostUsd: 7.5 });

      const args = runner.calls[0]!.args;
      const i = args.indexOf("--max-budget-usd");
      expect(args[i + 1]).toBe("7.50");
    });

    it("extra_args をモデル指定の後ろへ連結する", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const agent = new ClaudeAgentRunner(runner, {
        model: "opus",
        allowedTools: "Edit",
        extraArgs: ["--add-dir", "/extra"],
        log: () => {},
      });
      await agent.runSession(ctx);
      const args = runner.calls[0]!.args;
      expect(args.slice(-4)).toEqual(["--model", "opus", "--add-dir", "/extra"]);
    });

    it("subtype=success → completed{costUsd, summary=result}", async () => {
      const { runner } = runnerEmitting([INIT_LINE, ASSISTANT_TEXT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "completed",
        costUsd: 1.2345,
        summary: "Added function foo and a test.",
      });
    });

    it("completed の summary は 2000 字に切詰める", async () => {
      const big = "x".repeat(2500);
      const resultBig = `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":2,"result":"${big}","session_id":"s1"}`;
      const { runner } = runnerEmitting([INIT_LINE, resultBig]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") {
        expect(outcome.summary).toHaveLength(2000);
        expect(outcome.summary).toBe("x".repeat(2000));
      }
    });

    it("subtype=error_max_budget → cost_exceeded{costUsd}", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_BUDGET_LINE]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({ kind: "cost_exceeded", costUsd: 10 });
    });

    it("その他 subtype → error{costUsd, message}", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_GENERIC_ERROR_LINE]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "error",
        costUsd: 0.5,
        message: "something went wrong",
      });
    });

    it("subtype=success でも is_error=true なら error 扱い", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_IS_ERROR_SUCCESS_SUBTYPE_LINE]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "error",
        costUsd: 0.7,
        message: "partial failure",
      });
    });

    it("非0終了 → error（result が success でも exit code を優先）", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE], 1);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "error",
        costUsd: 1.2345,
        message: "claude exited with code 1",
      });
    });

    it("result 行欠落 → error{costUsd:0, message}", async () => {
      const { runner } = runnerEmitting([INIT_LINE, ASSISTANT_TEXT_LINE]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "error",
        costUsd: 0,
        message: "no result line emitted",
      });
    });

    it("破損行・空行は無視して最終 result まで到達する", async () => {
      const { runner } = runnerEmitting([
        EMPTY_LINE,
        BROKEN_LINE,
        INIT_LINE,
        BROKEN_LINE,
        ASSISTANT_TEXT_LINE,
        RESULT_SUCCESS_LINE,
      ]);
      const logs: string[] = [];
      const outcome = await makeRunner(runner, logs).runSession(ctx);
      expect(outcome).toEqual({
        kind: "completed",
        costUsd: 1.2345,
        summary: "Added function foo and a test.",
      });
    });

    it("system/init で開始ログ・assistant の text 先頭80字で進捗ログを出す", async () => {
      const { runner } = runnerEmitting([
        INIT_LINE,
        HOOK_LINE, // init 以外の system は無視
        ASSISTANT_THINK_LINE, // text を持たない assistant は進捗ログを出さない
        ASSISTANT_TEXT_LINE,
        RESULT_SUCCESS_LINE,
      ]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession(ctx);

      // 開始ログ1件 + text を持つ assistant 1件 = 2件
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("session");
      // text 先頭80字（80字に切詰め）
      const expectedText =
        "Editing src/foo.ts to add the requested function and a unit test for it right now".slice(
          0,
          80,
        );
      expect(logs[1]).toContain(expectedText);
      expect(logs[1]).not.toContain("right now"); // 81字目以降は落ちる
    });
  });
  ```

- [ ] **Step 2: テストを実行し、失敗を確認する（red）**

  実行コマンド:
  ```
  npx vitest run tests/agent-runner.test.ts
  ```
  期待される失敗: `src/agent-runner.js` が存在しないため、`ClaudeAgentRunner` の import 解決に失敗する（`Failed to resolve import "../src/agent-runner.js"` / `Cannot find module` 系のエラーで全 `it` が fail）。

- [ ] **Step 3: `src/agent-runner.ts` を実装する（最小・完全形）**

  `/home/racoma-dev/loop-pilot-os/src/agent-runner.ts` を新規作成し、以下を全文で書く。

  ```typescript
  import type {
    AgentOutcome,
    AgentRunner,
    CommandRunner,
    RunOptions,
    SessionContext,
  } from "./types.js";

  const SUMMARY_MAX = 2000;
  const PROGRESS_TEXT_MAX = 80;

  interface AgentRunnerOptions {
    model: string;
    allowedTools: string;
    extraArgs: string[];
    log: (line: string) => void;
  }

  // claude stream-json の result 行（カーネル §5.1）。未知フィールドは無視する。
  interface ResultLine {
    type: "result";
    subtype: string;
    is_error?: boolean;
    total_cost_usd?: number;
    result?: string;
    session_id?: string;
  }

  function isResultLine(value: unknown): value is ResultLine {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "result" &&
      typeof (value as { subtype?: unknown }).subtype === "string"
    );
  }

  // assistant メッセージ content から最初の text ブロックを取り出す。
  function firstTextBlock(parsed: unknown): string | null {
    const content = (parsed as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
    return null;
  }

  /**
   * Claude Code ヘッドレス（`claude -p --output-format stream-json`）を worktree 内で
   * コスト上限付きに起動する AgentRunner。仕様§5.3 IMPLEMENT / §11 コスト一本化。
   */
  export class ClaudeAgentRunner implements AgentRunner {
    constructor(
      private readonly runner: CommandRunner,
      private readonly opts: AgentRunnerOptions,
    ) {}

    async runSession(ctx: SessionContext): Promise<AgentOutcome> {
      // カーネル §5.1: argv は一字一句この順。max-budget-usd は toFixed(2)。
      const args: string[] = [
        "-p",
        ctx.prompt,
        "--output-format",
        "stream-json",
        "--max-budget-usd",
        ctx.maxCostUsd.toFixed(2),
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        this.opts.allowedTools,
        "--model",
        this.opts.model,
        ...this.opts.extraArgs,
      ];

      let resultLine: ResultLine | null = null;

      const onStdoutLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // 壊れた行は無視（仕様§5.3: 自己申告でなく差分が真実、進捗ログは best-effort）
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const type = (parsed as { type?: unknown }).type;

        if (type === "system") {
          if ((parsed as { subtype?: unknown }).subtype === "init") {
            const sessionId = (parsed as { session_id?: unknown }).session_id;
            this.opts.log(
              `agent session started${typeof sessionId === "string" ? ` (session ${sessionId})` : ""}`,
            );
          }
          return;
        }

        if (type === "assistant") {
          const text = firstTextBlock(parsed);
          if (text !== null) {
            this.opts.log(`agent: ${text.slice(0, PROGRESS_TEXT_MAX)}`);
          }
          return;
        }

        if (isResultLine(parsed)) {
          resultLine = parsed;
        }
      };

      // 仕様§11: timeoutMs は設定しない（コスト上限へ一本化）。
      const opts: RunOptions = { cwd: ctx.worktreePath, onStdoutLine };
      const cmdResult = await this.runner.run("claude", args, opts);

      return this.toOutcome(resultLine, cmdResult.code);
    }

    private toOutcome(resultLine: ResultLine | null, code: number): AgentOutcome {
      const costUsd =
        resultLine && typeof resultLine.total_cost_usd === "number"
          ? resultLine.total_cost_usd
          : 0;

      if (resultLine === null) {
        return { kind: "error", costUsd, message: "no result line emitted" };
      }
      if (code !== 0) {
        return { kind: "error", costUsd, message: `claude exited with code ${code}` };
      }
      if (resultLine.subtype === "error_max_budget") {
        return { kind: "cost_exceeded", costUsd };
      }
      if (resultLine.subtype === "success" && resultLine.is_error !== true) {
        const summary = (resultLine.result ?? "").slice(0, SUMMARY_MAX);
        return { kind: "completed", costUsd, summary };
      }
      return {
        kind: "error",
        costUsd,
        message: resultLine.result ?? "agent error",
      };
    }
  }
  ```

- [ ] **Step 4: テストを実行し、成功を確認する（green）**

  実行コマンド:
  ```
  npx vitest run tests/agent-runner.test.ts
  ```
  期待される成功: 全 `it`（argv 検証 / toFixed / extra_args / completed / 2000字切詰め / cost_exceeded / その他 subtype error / is_error success subtype error / 非0終了 error / result 欠落 error / 破損行無視 / ログ）が pass（緑）。

- [ ] **Step 5: 型チェック含む `npm run check` を実行する**

  実行コマンド:
  ```
  npm run check
  ```
  期待される成功: `tsc -p tsconfig.json --noEmit` と `tsc -p tsconfig.test.json --noEmit` が型エラーなしで通過し、`vitest run` 全体が緑。`AgentOutcome` の union（completed/cost_exceeded/error）と本実装の戻り値が一致していること（過不足プロパティで tsc が落ちないこと）を確認する。

- [ ] **Step 6: コミットする（red→green を1コミットに）**

  実行コマンド:
  ```
  git add src/agent-runner.ts tests/agent-runner.test.ts && git commit -m "feat: ClaudeAgentRunner (claude headless stream-json) per kernel §5.1"
  ```


---

### Task 10: LoopPilot Monitor

**目的**: PR の merged 状態と `looppilot-state` 隠しコメントを読み、カーネル §5.4 の単一検知式（`poll()`）と §5.3 のマージ可否判定（`checkMergeReadiness()`）を実装する `GhLoopPilotMonitor` を作る。コメントの特定・抽出は LoopPilot 実ソース（`/home/racoma-dev/loop-pilot/src/state-manager.ts`）の規則と一字一句一致させ、`merged | done | stopped(reason) | in_progress | corrupted | not_engaged | pr_closed` を決定的に返す。

**依存タスク**: Task 2（`src/types.ts` の `MonitorVerdict` / `MergeReadiness` / `LoopPilotMonitor` / `CommandRunner` / `CommandResult` / `RunOptions`）、Task 3（`tests/fakes.ts` の `FakeCommandRunner`）。本タスクは `src/monitor.ts` と `tests/monitor.test.ts` のみを新規作成する。`tests/fakes.ts` は Task 3 で既に `FakeCommandRunner`（`on(cmdPrefix, result)` 前方一致 + `calls` 記録）を export 済みである前提（本タスクでは変更しない）。

**カーネル契約の要点（このタスクが従う唯一の正）**:

- コンストラクタ（タスク指定）: `new GhLoopPilotMonitor(runner: CommandRunner, opts: { remote: string; trustedAuthors: string[] })`。`remote` は `"owner/name"` 形式。`trustedAuthors` は `config.looppilot.stateCommentAuthors`。Monitor の opts に repoPath は無い（カーネル §2 の `LoopPilotMonitor` は `poll`/`checkMergeReadiness` のみを規定し、gh は `-R <remote>` でリポを指定するため cwd は任意でよい。本実装は `process.cwd()` を渡す）。
- `poll(prNumber)` の決定順（§5.4。この順に評価し、最初に成立したものを返し以降を読まない）:
  1. `gh pr view <pr> -R <remote> --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed` を実行。`mergedAt != null` または `state === "MERGED"` → `{ kind: "merged" }`（**最優先**。コメントを取りに行く前に判定する）
  2. 未マージ ∧ `state === "CLOSED"` → `{ kind: "pr_closed" }`
  3. ここで初めてコメントを取得（`gh api ... comments --paginate --slurp`）。信頼 state コメント（特定規則）が存在しパース成功:
     - `status === "stopped"` → `{ kind: "stopped", stopReason }`（`stopReason` は文字列 or null。null はそのまま保持・変換しない）
     - `status === "done"` → `{ kind: "done" }`
     - `status ∈ {initialized, waiting_codex, fixing}` → `{ kind: "in_progress" }`
  4. 信頼著者コメントは存在するがパース不能/不正 status → `{ kind: "corrupted" }`
  5. 信頼コメント未出現 → `{ kind: "not_engaged" }`
- コメント特定の4規則（§5.4・`state-manager.ts` と同一）:
  1. `author.login` が `trustedAuthors` のいずれかに一致（`state-manager.ts` の `buildTrustedAuthorJqFilter`: `.user.login == "<author>"`）
  2. `body` が `LoopPilot state is stored in this comment.` で**始まる**（`startsWith`。`state-manager.ts` jq: `startswith(STATE_COMMENT_VISIBLE_TEXT)`）
  3. `body` が `<!-- looppilot-state` を**含む**（`includes`。`state-manager.ts` jq: `contains(STATE_COMMENT_OPEN)`）
  4. 複数該当時は**最後**のもの（gh は作成昇順で返すため配列末尾 = 最新。`state-manager.ts`: `lines[lines.length - 1]`）
- state 抽出 regex（一字一句、`state-manager.ts` `deserializeState` の `STATE_COMMENT_OPEN + "\\n([\\s\\S]*?)\\n" + STATE_COMMENT_CLOSE` と等価）: `/<!-- looppilot-state\n([\s\S]*?)\n-->/` の捕捉グループ1を `JSON.parse`。`status` ∈ {initialized, waiting_codex, fixing, done, stopped}（`state-manager.ts` `VALID_STATUSES`）。それ以外/`JSON.parse` 失敗/非オブジェクト/`status` 非文字列 → corrupted。
- corrupted の定義: 上記4規則を満たす信頼著者コメントが**存在する**が、(a) regex 不一致、(b) `JSON.parse` 失敗、(c) パース結果が非オブジェクト、(d) `status` が文字列でない、(e) `status` が上記5値以外、のいずれか。
- gh api comments は `gh api repos/<o>/<n>/issues/<pr>/comments --paginate --slurp` で取得。`--paginate --slurp` の出力は**ページ配列の配列** `[[...],[...]]`（カーネル §5.3 明記）なので flat 化してから走査する。
- `checkMergeReadiness(prNumber)` の決定順（§5.3 ①-⑥。この順に評価し最初に成立したものを返す）:
  - ① `mergeable === "CONFLICTING"` または `mergeStateStatus === "DIRTY"` → `{ ready:false, reason:"conflict" }`
  - ② `statusCheckRollup` に失敗（`status === "COMPLETED"` かつ `conclusion ∉ {SUCCESS, NEUTRAL, SKIPPED}`）が1つでも → `{ ready:false, reason:"ci_failed" }`
  - ③ 未完了チェックあり（`status !== "COMPLETED"` が1つでも）→ `{ ready:false, reason:"ci_pending" }`
  - ④ 全チェック完了グリーン（空配列=チェック無し=グリーン扱い）かつ `mergeStateStatus === "BLOCKED"` → `{ ready:false, reason:"blocked" }`
  - ⑤ `mergeable === "MERGEABLE"` → `{ ready:true, headSha: headRefOid }`
  - ⑥ それ以外 → `{ ready:false, reason:"unknown" }`

**LoopPilot serializeState 実形式（fixture を一致させる根拠、`state-manager.ts` 検証済み）**: `serializeState`（L283-329）は body を

```
LoopPilot state is stored in this comment.<\n><\n><!-- looppilot-state<\n>{JSON.stringify(state, null, 2)}<\n>-->
```

の連結で生成する（L286-294: `VISIBLE_TEXT + "\n\n" + "<!-- looppilot-state" + "\n" + json + "\n" + "-->"`）。`STATE_COMMENT_OPEN = "<!-- " + "looppilot-state"`（L20-21）。本タスクの fixture ヘルパ `stateCommentBody` はこの連結式を**一字一句**再現する。

---

#### Files

- **Create**: `/home/racoma-dev/loop-pilot-os/src/monitor.ts`
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/monitor.test.ts`
- **Test fixtures**: gh pr view JSON / comments slurp JSON は test 内のヘルパ（`prView` / `commentsSlurp` / `stateCommentBody`）で生成する。`tests/fixtures/` は使わず本タスクは上記2ファイルのみ作成する。

---

#### Steps

- [ ] **Step 1: 失敗するテストの足場を作る（import + fixture ヘルパ + 1ケースだけ）。** 新規ファイル `/home/racoma-dev/loop-pilot-os/tests/monitor.test.ts` を以下の完全な内容で作成する。この時点では `src/monitor.ts` が無いため import 解決で失敗する。

  ```typescript
  import { describe, it, expect } from "vitest";
  import { GhLoopPilotMonitor } from "../src/monitor.js";
  import { FakeCommandRunner } from "./fakes.js";
  import type { MonitorVerdict, MergeReadiness } from "../src/types.js";

  // ---- fixture helpers ----------------------------------------------------

  const REMOTE = "acme/widget";
  const TRUSTED = ["github-actions[bot]"];

  /** state-manager.ts STATE_COMMENT_VISIBLE_TEXT と同一（テスト内参照用） */
  const STATE_COMMENT_VISIBLE_TEXT_FOR_TEST =
    "LoopPilot state is stored in this comment.";

  /**
   * LoopPilot serializeState の実形式に正確に一致させる（state-manager.ts L286-294 検証済み）:
   * "LoopPilot state is stored in this comment.\n\n<!-- looppilot-state\n<json(2-space)>\n-->"
   */
  function stateCommentBody(state: Record<string, unknown>): string {
    const json = JSON.stringify(state, null, 2);
    return (
      STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
      "\n\n" +
      "<!-- looppilot-state" +
      "\n" +
      json +
      "\n" +
      "-->"
    );
  }

  /** gh pr view --json の戻り（必要フィールドのみ。未指定はグリーン/未マージの既定） */
  function prView(
    overrides: Partial<{
      state: string;
      mergedAt: string | null;
      mergeable: string;
      mergeStateStatus: string;
      headRefOid: string;
      statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
      closed: boolean;
    }> = {},
  ): string {
    return JSON.stringify({
      state: overrides.state ?? "OPEN",
      mergedAt: overrides.mergedAt ?? null,
      mergeable: overrides.mergeable ?? "MERGEABLE",
      mergeStateStatus: overrides.mergeStateStatus ?? "CLEAN",
      headRefOid: overrides.headRefOid ?? "deadbeefcafe",
      statusCheckRollup: overrides.statusCheckRollup ?? [],
      closed: overrides.closed ?? false,
    });
  }

  /** gh api ... comments --paginate --slurp の戻り（ページ配列の配列 [[...],[...]]） */
  function commentsSlurp(
    pages: Array<Array<{ author: string; body: string }>>,
  ): string {
    return JSON.stringify(
      pages.map((page) =>
        page.map((c) => ({ user: { login: c.author }, body: c.body })),
      ),
    );
  }

  /** runner を pr view / comments の応答で構成して Monitor を返す */
  function makeMonitor(opts: {
    view: string;
    comments?: string;
    trustedAuthors?: string[];
  }): { monitor: GhLoopPilotMonitor; runner: FakeCommandRunner } {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 0, stdout: opts.view, stderr: "" });
    if (opts.comments !== undefined) {
      runner.on(["gh", "api"], { code: 0, stdout: opts.comments, stderr: "" });
    }
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: REMOTE,
      trustedAuthors: opts.trustedAuthors ?? TRUSTED,
    });
    return { monitor, runner };
  }

  describe("GhLoopPilotMonitor.poll — verdict 決定順 (§5.4)", () => {
    it("mergedAt != null は最優先で merged を返し、コメントを取りに行かない (§5.4 規則1)", async () => {
      const { monitor, runner } = makeMonitor({
        view: prView({ mergedAt: "2026-06-05T00:00:00Z" }),
        // comments は登録しない: 呼ばれたら FakeCommandRunner が throw する
      });
      const verdict = await monitor.poll(42);
      expect(verdict).toEqual<MonitorVerdict>({ kind: "merged" });
      // コメント取得 (gh api) を一切呼ばないこと
      expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
    });
  });
  ```

- [ ] **Step 2: テストを実行して失敗を確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待される失敗: `Failed to resolve import "../src/monitor.js" from "tests/monitor.test.ts"`（`src/monitor.ts` 未作成）。

- [ ] **Step 3: Step 1 の merged ケースだけを通す最小実装を書く。** 新規ファイル `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を以下の完全な内容で作成する。この段階では Step 1 の `merged` ケースを green にするのに必要なものだけ（コンストラクタ + `fetchPrView` + `poll` の merged 判定）を実装し、それ以外の poll 分岐（pr_closed/done/stopped/in_progress/corrupted/not_engaged）と `checkMergeReadiness` は**未実装のまま明示 throw** にする。残り分岐の実装は Step 7b（poll）・Step 9b（readiness）の red→green サイクルで追加する。

  ```typescript
  import type {
    CommandRunner,
    LoopPilotMonitor,
    MergeReadiness,
    MonitorVerdict,
  } from "./types.js";

  // ---- gh pr view --json の型 ---------------------------------------------

  interface PrViewJson {
    state: string;
    mergedAt: string | null;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
    closed: boolean;
  }

  export interface GhLoopPilotMonitorOptions {
    remote: string; // "owner/name"
    trustedAuthors: string[];
  }

  export class GhLoopPilotMonitor implements LoopPilotMonitor {
    private readonly runner: CommandRunner;
    private readonly remote: string;
    private readonly trustedAuthors: string[];
    private readonly owner: string;
    private readonly name: string;

    constructor(runner: CommandRunner, opts: GhLoopPilotMonitorOptions) {
      this.runner = runner;
      this.remote = opts.remote;
      this.trustedAuthors = opts.trustedAuthors;
      const slash = opts.remote.indexOf("/");
      this.owner = opts.remote.slice(0, slash);
      this.name = opts.remote.slice(slash + 1);
    }

    async poll(prNumber: number): Promise<MonitorVerdict> {
      const pr = await this.fetchPrView(prNumber);

      // §5.4 規則1: merged が最優先（コメントを取りに行く前に判定）
      if (pr.mergedAt !== null || pr.state === "MERGED") {
        return { kind: "merged" };
      }

      // 残りの verdict 分岐は Step 7b の red→green で実装する（現時点は未実装）
      throw new Error("poll: non-merged verdicts not implemented yet");
    }

    async checkMergeReadiness(_prNumber: number): Promise<MergeReadiness> {
      // ①-⑥ は Step 9b の red→green で実装する（現時点は未実装）
      throw new Error("checkMergeReadiness not implemented yet");
    }

    // ---- 内部ヘルパ -------------------------------------------------------

    private async fetchPrView(prNumber: number): Promise<PrViewJson> {
      const result = await this.runner.run(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "-R",
          this.remote,
          "--json",
          "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
        ],
        { cwd: process.cwd() },
      );
      return JSON.parse(result.stdout) as PrViewJson;
    }
  }
  ```

  注: `owner`/`name`/`trustedAuthors` は Step 7b の `findTrustedStateComment` で初めて参照される。この最小実装の段階では private フィールドとして保持するだけにとどめ（`strict` の未使用ローカル検査はクラスフィールドには適用されないため `tsc` は通る）、Step 7b で消費する。`checkMergeReadiness` の引数は未使用のため `_prNumber`（先頭アンダースコアで未使用許容）とし、Step 9b で `prNumber` に戻して消費する。

- [ ] **Step 4: テストを実行して Step 1 のケースがグリーンになることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: `Tests  1 passed (1)`（merged ケース）。この時点では poll の他分岐と checkMergeReadiness は throw のままだが、それらに対応するテストはまだ追加していないため `failed 0`。

- [ ] **Step 5: `npm run check` を実行して型 + テスト全体がグリーンであることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`。期待: tsc（src）+ tsc（test）+ vitest がすべて成功（exit 0）。

- [ ] **Step 6: red-green の最初の単位をコミットする。** コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/monitor.ts tests/monitor.test.ts && git commit -m "feat: GhLoopPilotMonitor poll skeleton with merged-first verdict"`。

- [ ] **Step 7: poll の残り verdict 分岐の失敗するテストを追加する（red）。** `tests/monitor.test.ts` の `describe("GhLoopPilotMonitor.poll — verdict 決定順 (§5.4)", ...)` ブロック内（Step 1 で書いた `it("mergedAt != null ...")` の直後）に、以下の `it` 群を追加する。この時点で実装は Step 3 の最小形（merged 判定のみ、その他は throw）なので、これらは**失敗する**ことを期待する（次の Step 7b で実装を加えて green にする）。

  ```typescript
    it("state=='MERGED' でも merged を返す（mergedAt 経路と等価, §5.4 規則1）", async () => {
      const { monitor } = makeMonitor({ view: prView({ state: "MERGED" }) });
      expect(await monitor.poll(1)).toEqual<MonitorVerdict>({ kind: "merged" });
    });

    it("stopped(status) と merged が同時なら merged が勝つ（コメントを読まない, §5.4 規則1）", async () => {
      // stopped の state コメントが在っても、mergedAt があれば merged を優先
      const { monitor, runner } = makeMonitor({
        view: prView({ mergedAt: "2026-06-05T01:00:00Z" }),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({
                status: "stopped",
                stopReason: "max_iterations",
              }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(7)).toEqual<MonitorVerdict>({ kind: "merged" });
      // merged は最優先なのでコメント取得は呼ばれない
      expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
    });

    it("未マージ ∧ state=='CLOSED' → pr_closed（コメントを読まない, §5.4 規則2）", async () => {
      const { monitor, runner } = makeMonitor({
        view: prView({ state: "CLOSED", closed: true }),
      });
      expect(await monitor.poll(2)).toEqual<MonitorVerdict>({ kind: "pr_closed" });
      expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
    });

    it("信頼コメントが status=='done' → done（§5.4 規則3）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(3)).toEqual<MonitorVerdict>({ kind: "done" });
    });

    it("信頼コメントが status=='stopped' で stopReason を保持して返す（§5.4 規則3）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({
                status: "stopped",
                stopReason: "test_failure",
              }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(4)).toEqual<MonitorVerdict>({
        kind: "stopped",
        stopReason: "test_failure",
      });
    });

    it("status=='stopped' で stopReason==null を null のまま保持する（変換しない, §5.4）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status: "stopped", stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(5)).toEqual<MonitorVerdict>({
        kind: "stopped",
        stopReason: null,
      });
    });

    it.each(["initialized", "waiting_codex", "fixing"])(
      "status=='%s' → in_progress（§5.4 規則3）",
      async (status) => {
        const { monitor } = makeMonitor({
          view: prView(),
          comments: commentsSlurp([
            [
              {
                author: "github-actions[bot]",
                body: stateCommentBody({ status, stopReason: null }),
              },
            ],
          ]),
        });
        expect(await monitor.poll(6)).toEqual<MonitorVerdict>({
          kind: "in_progress",
        });
      },
    );

    it("偽装著者（信頼著者でない）の state コメントは無視し not_engaged（§5.4 規則1: author 一致）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "attacker", // 信頼著者でない
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(8)).toEqual<MonitorVerdict>({
        kind: "not_engaged",
      });
    });

    it("可視先頭テキストが一致しない（startsWith 不成立）コメントは無視し not_engaged（§5.4 規則2）", async () => {
      // 隠しマーカーは含むが、可視テキストで「始まらない」（前置あり）。
      // state-manager.ts の Linear linkback ケース（マーカーを引用するが先頭テキストで始まらない）に相当。
      const tampered =
        "FYI here is the state:\n\n" +
        stateCommentBody({ status: "done", stopReason: null });
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [{ author: "github-actions[bot]", body: tampered }],
        ]),
      });
      expect(await monitor.poll(9)).toEqual<MonitorVerdict>({
        kind: "not_engaged",
      });
    });

    it("可視テキストで始まるが隠しマーカーを含まない（contains 不成立）コメントは無視し not_engaged（§5.4 規則3）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              // 可視先頭テキストのみ。<!-- looppilot-state を含まない
              body: STATE_COMMENT_VISIBLE_TEXT_FOR_TEST + "\n\n(no hidden marker)",
            },
          ],
        ]),
      });
      expect(await monitor.poll(10)).toEqual<MonitorVerdict>({
        kind: "not_engaged",
      });
    });

    it("信頼 state コメントが複数あれば最後（最新）を採用する（§5.4 規則4・ページ跨ぎ flat 含む）", async () => {
      // ページ1=done, ページ2=stopped。flat 後の末尾 = stopped が勝つ
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({
                status: "stopped",
                stopReason: "loop_detected",
              }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(11)).toEqual<MonitorVerdict>({
        kind: "stopped",
        stopReason: "loop_detected",
      });
    });

    it("同一ページ内に信頼 state コメントが複数あれば末尾を採用する（§5.4 規則4）", async () => {
      // 末尾 = done が勝つ（in_progress を上書き）
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status: "fixing", stopReason: null }),
            },
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(17)).toEqual<MonitorVerdict>({ kind: "done" });
    });

    it("信頼著者コメントは在るが JSON 破損 → corrupted（§5.4 規則4: パース不能）", async () => {
      // 可視テキスト + マーカー + 前後改行は満たすが、内側 JSON が壊れている
      const broken =
        STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
        "\n\n<!-- looppilot-state\n{ not: valid json,, }\n-->";
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [{ author: "github-actions[bot]", body: broken }],
        ]),
      });
      expect(await monitor.poll(12)).toEqual<MonitorVerdict>({
        kind: "corrupted",
      });
    });

    it("信頼著者コメントは在るが内側が非オブジェクト JSON（bare string）→ corrupted（§5.4 規則4）", async () => {
      // JSON.parse は成功するが object でない（status を持てない）
      const bare =
        STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
        '\n\n<!-- looppilot-state\n"just a string"\n-->';
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [{ author: "github-actions[bot]", body: bare }],
        ]),
      });
      expect(await monitor.poll(18)).toEqual<MonitorVerdict>({
        kind: "corrupted",
      });
    });

    it("信頼著者コメントは在るが status が不正値 → corrupted（§5.4 規則4）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({
                status: "bogus_status",
                stopReason: null,
              }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(13)).toEqual<MonitorVerdict>({
        kind: "corrupted",
      });
    });

    it("信頼著者コメントは在るが抽出 regex に一致しない（マーカー前後の改行欠落）→ corrupted（§5.4 規則4）", async () => {
      // startsWith / includes は満たすが、`\n([\s\S]*?)\n` の前後改行を欠くため regex 不一致
      const noNewlines =
        STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
        '\n\n<!-- looppilot-state {"status":"done"} -->';
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [{ author: "github-actions[bot]", body: noNewlines }],
        ]),
      });
      expect(await monitor.poll(14)).toEqual<MonitorVerdict>({
        kind: "corrupted",
      });
    });

    it("コメントが1件も無い（空ページ）→ not_engaged（§5.4 規則5）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([[]]),
      });
      expect(await monitor.poll(15)).toEqual<MonitorVerdict>({
        kind: "not_engaged",
      });
    });

    it("信頼著者の corrupted コメントの後に偽装著者の正常 done があっても corrupted（信頼著者のみが対象, §5.4 規則1+4）", async () => {
      // 信頼著者の壊れた state（末尾の信頼コメント）が勝ち、偽装著者の done は無視される
      const broken =
        STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
        "\n\n<!-- looppilot-state\n{ broken }\n-->";
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            { author: "github-actions[bot]", body: broken },
            {
              author: "attacker",
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(19)).toEqual<MonitorVerdict>({
        kind: "corrupted",
      });
    });

    it("trustedAuthors に複数著者を設定でき、いずれか一致で採用する（§5.4 規則1）", async () => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "looppilot-app[bot]",
              body: stateCommentBody({ status: "done", stopReason: null }),
            },
          ],
        ]),
        trustedAuthors: ["github-actions[bot]", "looppilot-app[bot]"],
      });
      expect(await monitor.poll(16)).toEqual<MonitorVerdict>({ kind: "done" });
    });
  ```

- [ ] **Step 7a: テストを実行して poll 残り分岐の失敗を確認する（red 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: Step 1 の `merged` ケースは `passed` のまま、Step 7 で追加した各 it（pr_closed / done / stopped / in_progress / corrupted / not_engaged / 規則1-4 / flat 等）が `failed`。失敗理由は実装側の未実装分岐（`pr.state !== "MERGED"` の経路に到達して `poll: non-merged verdicts not implemented yet` を throw）であること。

- [ ] **Step 7b: poll の残り verdict 分岐を実装する（green）。** `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を以下の完全な内容で**全置換**する。(1) ファイル冒頭の型 import 群の直後に LoopPilot `state-manager.ts` と同一の定数群と `IssueComment` 型を追加、(2) `poll` の `throw` を pr_closed / コメント特定 / status 分岐の実装へ置換、(3) `findTrustedStateComment` と `extractStatus` の private ヘルパを追加する。`checkMergeReadiness` はまだ Step 9b で実装するため throw のまま据え置く。

  ```typescript
  import type {
    CommandRunner,
    LoopPilotMonitor,
    MergeReadiness,
    MonitorVerdict,
  } from "./types.js";

  // ---- LoopPilot state-manager.ts と同一の定数 -----------------------------

  /** 信頼 state コメントの可視先頭テキスト（state-manager.ts: STATE_COMMENT_VISIBLE_TEXT） */
  const STATE_COMMENT_VISIBLE_TEXT = "LoopPilot state is stored in this comment.";
  /** 隠しコメント開始マーカー（state-manager.ts: STATE_COMMENT_OPEN = "<!-- " + "looppilot-state"） */
  const STATE_COMMENT_OPEN = "<!-- looppilot-state";
  /** state 抽出 regex（state-manager.ts deserializeState と同一の捕捉式） */
  const STATE_EXTRACT_RE = /<!-- looppilot-state\n([\s\S]*?)\n-->/;
  /** LoopPilot VALID_STATUSES（state-manager.ts L33） */
  const VALID_STATUSES = new Set([
    "initialized",
    "waiting_codex",
    "fixing",
    "done",
    "stopped",
  ]);

  // ---- gh pr view --json の型 ---------------------------------------------

  interface PrViewJson {
    state: string;
    mergedAt: string | null;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
    closed: boolean;
  }

  /** gh api issue comments の1要素（必要フィールドのみ） */
  interface IssueComment {
    user: { login: string };
    body: string;
  }

  export interface GhLoopPilotMonitorOptions {
    remote: string; // "owner/name"
    trustedAuthors: string[];
  }

  export class GhLoopPilotMonitor implements LoopPilotMonitor {
    private readonly runner: CommandRunner;
    private readonly remote: string;
    private readonly trustedAuthors: string[];
    private readonly owner: string;
    private readonly name: string;

    constructor(runner: CommandRunner, opts: GhLoopPilotMonitorOptions) {
      this.runner = runner;
      this.remote = opts.remote;
      this.trustedAuthors = opts.trustedAuthors;
      const slash = opts.remote.indexOf("/");
      this.owner = opts.remote.slice(0, slash);
      this.name = opts.remote.slice(slash + 1);
    }

    async poll(prNumber: number): Promise<MonitorVerdict> {
      const pr = await this.fetchPrView(prNumber);

      // §5.4 規則1: merged が最優先（コメントを取りに行く前に判定）
      if (pr.mergedAt !== null || pr.state === "MERGED") {
        return { kind: "merged" };
      }
      // §5.4 規則2: 未マージ ∧ CLOSED → pr_closed
      if (pr.state === "CLOSED") {
        return { kind: "pr_closed" };
      }

      // §5.4 規則3-5: ここで初めてコメントを取得して信頼 state コメントを特定
      const trusted = await this.findTrustedStateComment(prNumber);
      if (trusted === null) {
        return { kind: "not_engaged" };
      }

      const status = this.extractStatus(trusted.body);
      if (status === null) {
        return { kind: "corrupted" };
      }
      if (status.status === "stopped") {
        return { kind: "stopped", stopReason: status.stopReason };
      }
      if (status.status === "done") {
        return { kind: "done" };
      }
      // initialized | waiting_codex | fixing
      return { kind: "in_progress" };
    }

    async checkMergeReadiness(_prNumber: number): Promise<MergeReadiness> {
      // ①-⑥ は Step 9b の red→green で実装する（現時点は未実装）
      throw new Error("checkMergeReadiness not implemented yet");
    }

    // ---- 内部ヘルパ -------------------------------------------------------

    private async fetchPrView(prNumber: number): Promise<PrViewJson> {
      const result = await this.runner.run(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "-R",
          this.remote,
          "--json",
          "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
        ],
        { cwd: process.cwd() },
      );
      return JSON.parse(result.stdout) as PrViewJson;
    }

    /**
     * §5.4 のコメント特定4規則を適用して信頼 state コメントを返す。
     * 該当無し → null。複数該当 → 最後のもの（gh は作成昇順、配列末尾 = 最新）。
     */
    private async findTrustedStateComment(
      prNumber: number,
    ): Promise<IssueComment | null> {
      const result = await this.runner.run(
        "gh",
        [
          "api",
          `repos/${this.owner}/${this.name}/issues/${prNumber}/comments`,
          "--paginate",
          "--slurp",
        ],
        { cwd: process.cwd() },
      );
      // --paginate --slurp は [[...page1...],[...page2...]] を返すので flat 化（§5.3）
      const pages = JSON.parse(result.stdout) as IssueComment[][];
      const comments: IssueComment[] = pages.flat();

      let found: IssueComment | null = null;
      for (const c of comments) {
        // 規則1: 信頼著者
        if (!this.trustedAuthors.includes(c.user.login)) continue;
        // 規則2: 可視テキストで始まる
        if (!c.body.startsWith(STATE_COMMENT_VISIBLE_TEXT)) continue;
        // 規則3: 隠しマーカーを含む
        if (!c.body.includes(STATE_COMMENT_OPEN)) continue;
        // 規則4: 最後優先（上書きし続けて末尾を残す）
        found = c;
      }
      return found;
    }

    /**
     * 信頼コメント body から status / stopReason を抽出。
     * regex 不一致 / JSON.parse 失敗 / 非オブジェクト / status 非文字列・不正値 → null（= corrupted の合図）。
     */
    private extractStatus(
      body: string,
    ): { status: string; stopReason: string | null } | null {
      const match = body.match(STATE_EXTRACT_RE);
      if (!match) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      const status = obj.status;
      if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        return null;
      }
      // stopReason は文字列 or null（null はそのまま保持・変換しない、§5.4）
      const rawReason = obj.stopReason;
      const stopReason = typeof rawReason === "string" ? rawReason : null;
      return { status, stopReason };
    }
  }
  ```

- [ ] **Step 8: テストを実行して poll の全分岐がグリーンになったことを確認する（green 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: Step 7 で追加した poll ケースを含め全 `passed`、`failed 0`（`checkMergeReadiness` のテストはまだ未追加）。

- [ ] **Step 9: `checkMergeReadiness` の6分岐を網羅する失敗テストを追加する（red）。** `tests/monitor.test.ts` の末尾（最後の `describe` の閉じ `});` の後、ファイル終端）に、以下の `describe` を追加する。この時点で `checkMergeReadiness` は Step 3/7b で throw のまま据え置かれているので、これらは**失敗する**ことを期待する（次の Step 9b で実装を加えて green にする）。

  ```typescript
  describe("GhLoopPilotMonitor.checkMergeReadiness — 決定順 ①-⑥ (§5.3)", () => {
    it("① mergeable=='CONFLICTING' → conflict（最優先）", async () => {
      // CONFLICTING かつ BLOCKED でも、conflict が先に成立する
      const { monitor } = makeMonitor({
        view: prView({ mergeable: "CONFLICTING", mergeStateStatus: "BLOCKED" }),
      });
      expect(await monitor.checkMergeReadiness(1)).toEqual<MergeReadiness>({
        ready: false,
        reason: "conflict",
      });
    });

    it("① mergeStateStatus=='DIRTY' → conflict（mergeable が MERGEABLE でも）", async () => {
      const { monitor } = makeMonitor({
        view: prView({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }),
      });
      expect(await monitor.checkMergeReadiness(2)).toEqual<MergeReadiness>({
        ready: false,
        reason: "conflict",
      });
    });

    it("② 完了かつ conclusion が失敗 → ci_failed（未完了チェックより先, conflict 不成立時）", async () => {
      // FAILURE は GREEN_CONCLUSIONS に無い。未完了チェックが在っても ② が先に成立する
      const { monitor } = makeMonitor({
        view: prView({
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { status: "COMPLETED", conclusion: "FAILURE" },
            { status: "IN_PROGRESS", conclusion: null },
          ],
        }),
      });
      expect(await monitor.checkMergeReadiness(3)).toEqual<MergeReadiness>({
        ready: false,
        reason: "ci_failed",
      });
    });

    it("② 完了かつ conclusion==null（TIMED_OUT 相当の欠落）も失敗扱い → ci_failed", async () => {
      // COMPLETED だが conclusion が null/未知 → グリーン集合に無いので失敗扱い
      const { monitor } = makeMonitor({
        view: prView({
          statusCheckRollup: [{ status: "COMPLETED", conclusion: null }],
        }),
      });
      expect(await monitor.checkMergeReadiness(10)).toEqual<MergeReadiness>({
        ready: false,
        reason: "ci_failed",
      });
    });

    it("② NEUTRAL / SKIPPED は失敗扱いしない（グリーン扱い）→ ready", async () => {
      // 全て completed かつ {SUCCESS,NEUTRAL,SKIPPED} のみ・MERGEABLE → ready
      const { monitor } = makeMonitor({
        view: prView({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          headRefOid: "feedface1234",
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { status: "COMPLETED", conclusion: "NEUTRAL" },
            { status: "COMPLETED", conclusion: "SKIPPED" },
          ],
        }),
      });
      expect(await monitor.checkMergeReadiness(4)).toEqual<MergeReadiness>({
        ready: true,
        headSha: "feedface1234",
      });
    });

    it("③ 未完了チェックあり（失敗は無い）→ ci_pending", async () => {
      const { monitor } = makeMonitor({
        view: prView({
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { status: "IN_PROGRESS", conclusion: null },
          ],
        }),
      });
      expect(await monitor.checkMergeReadiness(5)).toEqual<MergeReadiness>({
        ready: false,
        reason: "ci_pending",
      });
    });

    it("④ 全グリーン（チェックあり）かつ mergeStateStatus=='BLOCKED' → blocked", async () => {
      const { monitor } = makeMonitor({
        view: prView({
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      });
      expect(await monitor.checkMergeReadiness(6)).toEqual<MergeReadiness>({
        ready: false,
        reason: "blocked",
      });
    });

    it("④ チェック空配列（=チェック無し=グリーン扱い）かつ BLOCKED → blocked", async () => {
      const { monitor } = makeMonitor({
        view: prView({
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          statusCheckRollup: [],
        }),
      });
      expect(await monitor.checkMergeReadiness(7)).toEqual<MergeReadiness>({
        ready: false,
        reason: "blocked",
      });
    });

    it("⑤ 全グリーン（空配列含む）かつ MERGEABLE かつ非 BLOCKED → ready(headSha=headRefOid)", async () => {
      const { monitor } = makeMonitor({
        view: prView({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          headRefOid: "abc123sha",
          statusCheckRollup: [],
        }),
      });
      expect(await monitor.checkMergeReadiness(8)).toEqual<MergeReadiness>({
        ready: true,
        headSha: "abc123sha",
      });
    });

    it("⑥ いずれにも該当しない（mergeable=='UNKNOWN'・非BLOCKED・グリーン）→ unknown", async () => {
      const { monitor } = makeMonitor({
        view: prView({
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNSTABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      });
      expect(await monitor.checkMergeReadiness(9)).toEqual<MergeReadiness>({
        ready: false,
        reason: "unknown",
      });
    });
  });
  ```

- [ ] **Step 9a: テストを実行して readiness 6分岐の失敗を確認する（red 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: poll 系の全ケースは `passed` のまま、Step 9 で追加した `checkMergeReadiness` の各 it（①-⑥）が `failed`。失敗理由は実装側の未実装（`checkMergeReadiness not implemented yet` を throw）であること。

- [ ] **Step 9b: `checkMergeReadiness` の ①-⑥ を実装する（green）。** `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を編集する。(1) 冒頭の定数群（`VALID_STATUSES` の `]);` の直後）に GREEN_CONCLUSIONS を追加、(2) `checkMergeReadiness` メソッド全体を ①-⑥ の決定順実装へ置換し、未使用だった引数 `_prNumber` を `prNumber` に戻して消費する。

  まず定数を追加する（`VALID_STATUSES` の `]);` の直後に挿入）:

  ```typescript
  /** checkMergeReadiness ② の「失敗でない」conclusion 集合（§5.3） */
  const GREEN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  ```

  次に `checkMergeReadiness` メソッド全体を以下へ置換する:

  ```typescript
    async checkMergeReadiness(prNumber: number): Promise<MergeReadiness> {
      const pr = await this.fetchPrView(prNumber);
      const checks = pr.statusCheckRollup;

      // ① コンフリクト
      if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        return { ready: false, reason: "conflict" };
      }
      // ② 失敗チェックあり（completed かつ conclusion ∉ {SUCCESS,NEUTRAL,SKIPPED}）
      const hasFailed = checks.some(
        (c) =>
          c.status === "COMPLETED" && !GREEN_CONCLUSIONS.has(c.conclusion ?? ""),
      );
      if (hasFailed) {
        return { ready: false, reason: "ci_failed" };
      }
      // ③ 未完了チェックあり
      const hasPending = checks.some((c) => c.status !== "COMPLETED");
      if (hasPending) {
        return { ready: false, reason: "ci_pending" };
      }
      // ④ 全グリーン（空配列含む）かつ BLOCKED
      if (pr.mergeStateStatus === "BLOCKED") {
        return { ready: false, reason: "blocked" };
      }
      // ⑤ MERGEABLE
      if (pr.mergeable === "MERGEABLE") {
        return { ready: true, headSha: pr.headRefOid };
      }
      // ⑥ それ以外
      return { ready: false, reason: "unknown" };
    }
  ```

- [ ] **Step 10: テストを実行して readiness 6分岐がグリーンになったことを確認する（green 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: 全ケース `passed`、`failed 0`。

- [ ] **Step 11: `gh` 呼び出し形が契約どおりであることを検証するテストを追加する（red→green は同一サイクル: 実装は既に Step 7b で確定済みのため green になる）。** `tests/monitor.test.ts` の末尾（最後の `describe` の閉じ `});` の後）に、以下の `describe` を追加する。`gh pr view` の `--json` フィールド列・`-R <remote>` と、`gh api ... comments --paginate --slurp` の引数が §5.3 と一字一句一致することを固定する。

  ```typescript
  describe("GhLoopPilotMonitor — gh 呼び出し形の固定 (§5.3)", () => {
    it("poll は gh pr view を契約どおりの -R / --json フィールドで呼ぶ", async () => {
      const { monitor, runner } = makeMonitor({
        view: prView({ mergedAt: "2026-06-05T00:00:00Z" }),
      });
      await monitor.poll(123);
      const call = runner.calls.find(
        (c) => c.args[0] === "pr" && c.args[1] === "view",
      );
      expect(call).toBeDefined();
      expect(call!.cmd).toBe("gh");
      expect(call!.args).toEqual([
        "pr",
        "view",
        "123",
        "-R",
        REMOTE,
        "--json",
        "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
      ]);
    });

    it("poll は comments を gh api ... --paginate --slurp で owner/name 分解して呼ぶ", async () => {
      const { monitor, runner } = makeMonitor({
        view: prView(), // 未マージ・未クローズ → コメント取得まで進む
        comments: commentsSlurp([[]]),
      });
      await monitor.poll(77);
      const call = runner.calls.find((c) => c.args[0] === "api");
      expect(call).toBeDefined();
      expect(call!.cmd).toBe("gh");
      expect(call!.args).toEqual([
        "api",
        "repos/acme/widget/issues/77/comments",
        "--paginate",
        "--slurp",
      ]);
    });

    it("checkMergeReadiness は gh pr view を同一の -R / --json フィールドで呼ぶ", async () => {
      const { monitor, runner } = makeMonitor({
        view: prView({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      });
      await monitor.checkMergeReadiness(55);
      const call = runner.calls.find(
        (c) => c.args[0] === "pr" && c.args[1] === "view",
      );
      expect(call).toBeDefined();
      expect(call!.args).toEqual([
        "pr",
        "view",
        "55",
        "-R",
        REMOTE,
        "--json",
        "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
      ]);
    });
  });
  ```

- [ ] **Step 12: テストを実行して呼び出し形テストがグリーンであることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: 全ケース `passed`、`failed 0`。

- [ ] **Step 13: `npm run check` で型 + 全テストの最終グリーンを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`。期待: tsc（src）+ tsc（test）+ vitest すべて成功（exit 0）。

- [ ] **Step 14: green の単位をコミットする。** コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/monitor.ts tests/monitor.test.ts && git commit -m "test: cover GhLoopPilotMonitor verdict precedence, comment identification, readiness branches, and gh call shapes"`。


---

### Task 11: Context Bundle

**目的（2-3行）:** 毎セッションで claude に渡す決定的プロンプト文字列を組み立てる純粋関数 `buildPrompt(args: PromptArgs): string` を実装する。プロンプトは①product goal ②チケット ③作業規則 ④直近マージ済み digest の4ブロックから成り、同入力なら必ず同出力（副作用・時刻・乱数を含まない）。

> **設計ノート（仕様 §3 文脈5要素のトレーサビリティ）:** 仕様 §3 の文脈行「コード+チケット+ゴール+CLAUDE.md+直近N件のマージ済みセッション要約」のうち、**『コード』と『CLAUDE.md』は `buildPrompt` には注入しない**。これらは claude を worktree を cwd として起動する（Task 9 / カーネル §5.1：spawn の `cwd` = worktree）ことで暗黙に文脈へ入る — リポジトリのコードツリーと CLAUDE.md は worktree 内に物理的に存在し、claude が起動ディレクトリから読み取る。したがって `buildPrompt` が明示的に組み立てる責務は残りの3要素（ゴール / チケット / digest）＋作業規則に限られる。この分担により仕様 §3 の文脈5要素はすべてトレース可能になる（コード・CLAUDE.md=cwd 経由の暗黙注入、ゴール・チケット・digest=buildPrompt の明示注入）。

**依存タスク:** Task 2（`src/types.ts` の `PromptArgs` / `EligibleIssue` / `TaskSessionRow`）。`PromptArgs` は Orchestrator（Task 12）の IMPLEMENT フェーズが `store.recentMergedSummaries(config.digest.recentMergedCount)` の戻り値を `digest` にそのまま渡して呼ぶ（カーネル §7-4）。本タスクはその関数本体とテストのみを作る。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/context-bundle.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/context-bundle.test.ts`

> 契約（カーネル §2、一字一句）:
> ```typescript
> export interface PromptArgs {
>   goal: string;                                   // config.product.goal
>   issue: EligibleIssue;
>   digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
> }
> // context-bundle.ts は export function buildPrompt(args: PromptArgs): string を公開
> ```
> `EligibleIssue` は `{ id; identifier; title; description; priority; sortOrder; url }`。本タスクはこのうち `identifier`/`title`/`url`/`description` のみ使う（仕様 §8 文脈の「チケット」）。
> `digest` 各要素は `{ linearIdentifier; issueTitle; agentSummary }`。`agentSummary` は `string | null`（`TaskSessionRow.agentSummary` の型）。
> プロンプト本文は日本語混在可・決定的（同入力同出力）。

---

- [ ] **Step 1: 失敗するテストを書く（4ブロックの包含・digest 空/null・決定性）**

`/home/racoma-dev/loop-pilot-os/tests/context-bundle.test.ts` を新規作成（完全形）:

```typescript
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/context-bundle.js";
import type { PromptArgs } from "../src/types.js";

// 仕様 §8 文脈: コード+チケット+ゴール+CLAUDE.md+直近N件のマージ済みセッション要約。
// 本関数はそのうち「ゴール / チケット / 作業規則 / 直近マージ digest」を決定的文字列に組む。

const baseIssue: PromptArgs["issue"] = {
  id: "11111111-1111-1111-1111-111111111111",
  identifier: "TY-123",
  title: "ログイン画面のバリデーション追加",
  description: "メールアドレス形式とパスワード長を検証する。",
  priority: 2,
  sortOrder: 10.5,
  url: "https://linear.app/team-yubune/issue/TY-123",
};

function makeArgs(overrides: Partial<PromptArgs> = {}): PromptArgs {
  return {
    goal: "ユーザー認証基盤を堅牢にし、不正ログインを防ぐ。",
    issue: baseIssue,
    digest: [],
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("① product goal を含む（プロンプト冒頭の文脈・仕様 §8 product）", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("ユーザー認証基盤を堅牢にし、不正ログインを防ぐ。");
  });

  it("② チケットの identifier/title/url/description を含む（仕様 §8 チケット）", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("TY-123");
    expect(out).toContain("ログイン画面のバリデーション追加");
    expect(out).toContain("https://linear.app/team-yubune/issue/TY-123");
    expect(out).toContain("メールアドレス形式とパスワード長を検証する。");
  });

  it("② description が空文字でもクラッシュせず他要素は揃う（EligibleIssue.description は空あり得る）", () => {
    const out = buildPrompt(makeArgs({ issue: { ...baseIssue, description: "" } }));
    expect(out).toContain("TY-123");
    expect(out).toContain("https://linear.app/team-yubune/issue/TY-123");
    // 空 description はプレースホルダ文言に置換される（後述の実装と一致）
    expect(out).toContain("(説明なし)");
  });

  it("③ 作業規則を全て含む: 現在ブランチで実装 / 全変更コミット / 未コミット残骸は失敗 / push・PR禁止はオーケの責務 / CLAUDE.md・規約に従う / スコープはチケット内 / 最後に変更要約", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("このworktreeの現在ブランチで実装");
    expect(out).toContain("全ての変更をコミット");
    expect(out).toContain("未コミットの残骸は失敗として扱われる");
    expect(out).toContain("push および PR 作成は禁止");
    expect(out).toContain("オーケストレーターの責務");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("スコープはこのチケット内");
    expect(out).toContain("最後に変更内容の要約を出力");
  });

  it("④ digest が空のときは digest セクションを丸ごと省略する（仕様 §8: 直近N件・空なら無し）", () => {
    const out = buildPrompt(makeArgs({ digest: [] }));
    expect(out).not.toContain("直近マージ済みセッション");
  });

  it("④ digest が非空のとき `identifier: title — summary` を各1行で含む", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [
          { linearIdentifier: "TY-100", issueTitle: "DB接続プール導入", agentSummary: "プール上限を10に設定" },
          { linearIdentifier: "TY-101", issueTitle: "ログ整形", agentSummary: "JSON構造化ログへ移行" },
        ],
      }),
    );
    expect(out).toContain("直近マージ済みセッション");
    expect(out).toContain("TY-100: DB接続プール導入 — プール上限を10に設定");
    expect(out).toContain("TY-101: ログ整形 — JSON構造化ログへ移行");
  });

  it("④ agentSummary が null のエントリは summary 部を `(要約なし)` にして行を出す", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-102", issueTitle: "リファクタ", agentSummary: null }],
      }),
    );
    expect(out).toContain("TY-102: リファクタ — (要約なし)");
  });

  it("④ digest の行順は入力配列の順序を保つ（決定的・store.recentMergedSummaries の順をそのまま）", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [
          { linearIdentifier: "TY-200", issueTitle: "first", agentSummary: "a" },
          { linearIdentifier: "TY-201", issueTitle: "second", agentSummary: "b" },
          { linearIdentifier: "TY-202", issueTitle: "third", agentSummary: "c" },
        ],
      }),
    );
    const idxFirst = out.indexOf("TY-200: first — a");
    const idxSecond = out.indexOf("TY-201: second — b");
    const idxThird = out.indexOf("TY-202: third — c");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it("決定性: 同一入力なら完全一致の文字列を返す（時刻・乱数なし）", () => {
    const args = makeArgs({
      digest: [{ linearIdentifier: "TY-300", issueTitle: "t", agentSummary: "s" }],
    });
    expect(buildPrompt(args)).toBe(buildPrompt(args));
  });

  it("ブロック順序が決定的: goal → チケット → 作業規則 → digest", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-400", issueTitle: "t", agentSummary: "s" }],
      }),
    );
    const idxGoal = out.indexOf("プロダクトのゴール");
    const idxTicket = out.indexOf("担当チケット");
    const idxRules = out.indexOf("作業規則");
    const idxDigest = out.indexOf("直近マージ済みセッション");
    expect(idxGoal).toBeGreaterThanOrEqual(0);
    expect(idxGoal).toBeLessThan(idxTicket);
    expect(idxTicket).toBeLessThan(idxRules);
    expect(idxRules).toBeLessThan(idxDigest);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/context-bundle.test.ts`
Expected: FAIL — `src/context-bundle.ts` が存在しないため `Failed to resolve import "../src/context-bundle.js"`（モジュール解決エラー）。全テストが collect 段階で落ちる。

- [ ] **Step 3: 最小実装を書く（`src/context-bundle.ts`、完全形）**

`/home/racoma-dev/loop-pilot-os/src/context-bundle.ts` を新規作成:

```typescript
import type { PromptArgs } from "./types.js";

/**
 * セッションごとに claude へ渡す決定的プロンプトを組み立てる純粋関数。
 * 構成（この順序・仕様 §8 文脈）:
 *   ① プロダクトのゴール（config.product.goal）
 *   ② 担当チケット（identifier / title / url / description）
 *   ③ 作業規則（現在ブランチで実装・全変更コミット・push/PR禁止・規約遵守・スコープ・要約出力）
 *   ④ 直近マージ済みセッション digest（identifier: title — summary を各1行。空なら省略）
 * 副作用・時刻・乱数を含まないため、同入力 → 同出力。
 */
export function buildPrompt(args: PromptArgs): string {
  const { goal, issue, digest } = args;

  const description = issue.description.trim().length > 0 ? issue.description : "(説明なし)";

  const goalBlock = ["# プロダクトのゴール", "", goal].join("\n");

  const ticketBlock = [
    "# 担当チケット",
    "",
    `- identifier: ${issue.identifier}`,
    `- title: ${issue.title}`,
    `- url: ${issue.url}`,
    "",
    "## 説明",
    "",
    description,
  ].join("\n");

  const rulesBlock = [
    "# 作業規則",
    "",
    "- このworktreeの現在ブランチで実装すること（新しいブランチを切らない）。",
    "- 作業が終わったら、全ての変更をコミットすること。",
    "- 未コミットの残骸は失敗として扱われる（コミットし忘れに注意）。",
    "- push および PR 作成は禁止。これらはオーケストレーターの責務である。",
    "- 対象リポジトリの CLAUDE.md および既存の規約・コーディングスタイルに従うこと。",
    "- スコープはこのチケット内に限定し、無関係な変更を加えないこと。",
    "- 最後に変更内容の要約を出力すること。",
  ].join("\n");

  const blocks: string[] = [goalBlock, ticketBlock, rulesBlock];

  if (digest.length > 0) {
    const lines = digest.map(
      (d) => `- ${d.linearIdentifier}: ${d.issueTitle} — ${d.agentSummary ?? "(要約なし)"}`,
    );
    const digestBlock = ["# 直近マージ済みセッションの要約", "", ...lines].join("\n");
    blocks.push(digestBlock);
  }

  return blocks.join("\n\n");
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/context-bundle.test.ts`
Expected: PASS — 全 10 ケース green（`Test Files 1 passed`, `Tests 10 passed`、`failed 0`）。

- [ ] **Step 5: 型チェック含む全体検査を実行する**

Run: `cd /home/racoma-dev/loop-pilot-os && npm run check`
Expected: PASS — `tsc`（src）+ `tsc`（test 用 tsconfig）+ `vitest` が全て成功（exit 0）。新規 export `buildPrompt` と `PromptArgs` import が型整合。

- [ ] **Step 6: red-green の単位でコミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/context-bundle.ts tests/context-bundle.test.ts && git commit -m "feat: add buildPrompt context bundle (§3 文脈)"
```


---

### Task 12: Orchestrator 正常系

**目的**: `src/orchestrator.ts` の Orchestrator Core を新規実装する。カーネル §7 の DI とループ・状態機械の **正常フロー**（ランロック取得/解放、Run 作成、SELECT→CLAIM→IMPLEMENT→HANDOFF→MONITOR→DONE の完走、IDLE→復帰、タスク上限 HALT、run_started 通知）を TDD で組み立てる。`recoverPendingSessions()` は本タスクでは **空実装（活性セッション無し前提の素通し）として定義だけ置く**（中身は Task 14）。失敗系の分岐（cost_exceeded/exception/agent_no_change/handoff_failed/監視失敗/CLAIM 失敗）は §7 の遷移が **型上通る最小実装**（`stopSession` ヘルパ等）を含めるが、本タスクのテストは正常系のみ。失敗系の網羅テストは Task 13。

**依存タスク**:
- Task 2（`src/types.ts`：全ドメイン型・モジュールインターフェース）
- Task 3（`tests/fakes.ts` の `FakeCommandRunner`・`fixedClock`・`instantSleep` の一部。本タスクで残りのフェイクを同ファイルに追記）
- Task 5（`src/store.ts`：`SqliteStore`）
- Task 11（`src/context-bundle.ts`：`buildPrompt`。本タスクでは DI 経由でフェイク差し替え可能なため実体には依存しないが、既定値として import する）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/types.ts`: `SessionState`, `RunState`, `FailureReason`, `EligibleIssue`, `TicketState`, `RunRow`, `TaskSessionRow`, `TaskSource`, `SessionContext`, `AgentOutcome`, `AgentRunner`, `ClaimResult`, `GitPrManager`, `MonitorVerdict`, `MergeReadiness`, `LoopPilotMonitor`, `NotifyEvent`, `Notifier`, `PromptArgs`, `CommandRunner` 等（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/context-bundle.ts`: `buildPrompt(args: PromptArgs): string`（カーネル §2/§11）
- `tests/fakes.ts`: `FakeCommandRunner`, `fixedClock`, `instantSleep`（Task 3 で定義済み）

> 注: 本タスクが `Config` 型に依存する箇所は `config.product.goal`, `config.digest.recentMergedCount`, `config.safety.maxTasksPerRun`, `config.safety.maxCostUsdPerSession`, `config.safety.notEngagedGuardMinutes`, `config.safety.monitorTimeoutMinutes`（任意・既定 undefined）, `config.loop.monitorPollSeconds`, `config.loop.idleRecheckSeconds`, `config.looppilot.gateLabel`。Config の完全な zod スキーマは Task 4 の所掌。テストでは `Config` の必要フィールドだけを持つ最小オブジェクトを生成するヘルパ（`makeConfig`）を本タスクで用意する。`Config` 型は `src/config.ts` から import する（型のみ）。

---

#### このセクションが定義する Orchestrator の正常系の形（実装の正）

カーネル §7 を実装に落とすにあたり、本タスクで確定させる内部構造（後続タスクが追記する土台）:

- `Orchestrator` クラス。コンストラクタ引数は単一オブジェクト `OrchestratorDeps`。
- `run(): Promise<void>` がエントリ。`try { acquireRunLock; createRun; recoverPendingSessions; loop } finally { releaseRunLock }`。
- ループは `while (true)` で、各反復で「タスク上限チェック → SELECT → (IDLE なら sleep して continue) → CLAIM → IMPLEMENT → HANDOFF → MONITOR → DONE」を実行する。HALT に至ったら `return`（ループ脱出）。
- 各セッションのフェーズは private メソッドに分解する: `selectIssue`, `claim`, `implement`, `handoff`, `monitor`, `done`。
- 失敗時の共通終端は private `stopSession(session, reason, detail, extraPatch)`：updateSession(stopped 等) → notify(halted) → Run=halted。各フェーズは失敗時に `stopSession` を呼んでから「HALT したことを示す番兵」を返し、`run()` のループはそれを見て `return` する。番兵は `RunControl` 型（`"continue" | "halt"` の判別）で表す。
- IDLE は `selectIssue` の戻り値が `{ control: "idle" }` のとき `run()` 側で notify(idle)（初回のみ）→ sleep → 再 SELECT を行う。
- run_started 通知は createRun 直後・recover の前に 1 回送る。

これにより Task 13 は「各フェーズの失敗分岐を埋める＋安全弁テストを足す」だけになり、Task 14 は `recoverPendingSessions()` の中身を差し替えるだけになる。

---

#### Files

- **Create**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`
- **Modify**: `/home/racoma-dev/loop-pilot-os/tests/fakes.ts`（残りのフェイク `FakeTaskSource` / `FakeAgentRunner` / `FakeGitPr` / `FakeMonitor` / `FakeNotifier` を追記。`fixedClock` / `instantSleep` は Task 3 で定義済み前提）
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/orchestrator.test.ts`

---

#### Step-by-step（TDD）

- [ ] **Step 1: 残りのフェイクを `tests/fakes.ts` に追記する（テスト基盤）**

`tests/fakes.ts` の末尾に以下を追記する。既存の `FakeCommandRunner` / `fixedClock` / `instantSleep` と、先頭の import 群（`CommandRunner`, `CommandResult`, `RunOptions` 等）はそのまま残し、型 import に不足分を足す。先頭の import 行に以下のシンボルが含まれていなければ追加する（既に Task 3 が `from "../src/types.js"` で型を import している前提なので、不足分のみ列挙して足す）:

```typescript
import type {
  TaskSource,
  EligibleIssue,
  TicketState,
  AgentRunner,
  SessionContext,
  AgentOutcome,
  GitPrManager,
  ClaimResult,
  LoopPilotMonitor,
  MonitorVerdict,
  MergeReadiness,
  Notifier,
  NotifyEvent,
} from "../src/types.js";
```

ファイル末尾に以下のクラス群を追記する（完全形）:

```typescript
// ---- FakeTaskSource ----
export class FakeTaskSource implements TaskSource {
  /** getNextEligible が順に shift して返す。空なら null（IDLE） */
  queue: EligibleIssue[] = [];
  /** transition(issueId, state) の呼び出し記録 */
  transitions: Array<{ issueId: string; state: TicketState }> = [];
  /** getNextEligible(excludeIds) の excludeIds 記録 */
  eligibleCalls: string[][] = [];
  /** findOrphanedInProgress の戻り値 */
  orphans: EligibleIssue[] = [];
  /** メソッド名 → 次の1回だけ throw させるエラー */
  private failOnce = new Map<string, Error>();

  failNext(method: "getNextEligible" | "transition" | "findOrphanedInProgress", error?: Error): void {
    this.failOnce.set(method, error ?? new Error(`FakeTaskSource.${method} injected failure`));
  }

  private takeFailure(method: string): void {
    const err = this.failOnce.get(method);
    if (err) {
      this.failOnce.delete(method);
      throw err;
    }
  }

  async getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null> {
    this.eligibleCalls.push([...excludeIds]);
    this.takeFailure("getNextEligible");
    const next = this.queue.find((i) => !excludeIds.includes(i.id));
    if (!next) return null;
    this.queue = this.queue.filter((i) => i !== next);
    return next;
  }

  async transition(issueId: string, state: TicketState): Promise<void> {
    this.takeFailure("transition");
    this.transitions.push({ issueId, state });
  }

  async findOrphanedInProgress(_knownIssueIds: string[]): Promise<EligibleIssue[]> {
    this.takeFailure("findOrphanedInProgress");
    return this.orphans;
  }
}

// ---- FakeAgentRunner ----
export class FakeAgentRunner implements AgentRunner {
  /** runSession が順に shift して返す結果 */
  outcomes: AgentOutcome[] = [];
  /** 呼び出された SessionContext を記録 */
  contexts: SessionContext[] = [];

  async runSession(ctx: SessionContext): Promise<AgentOutcome> {
    this.contexts.push(ctx);
    const out = this.outcomes.shift();
    if (!out) throw new Error("FakeAgentRunner: no outcome queued");
    return out;
  }
}

// ---- FakeGitPr ----
export class FakeGitPr implements GitPrManager {
  /** prepareWorktree の戻り値（issue.identifier → ClaimResult）。未設定は決定的に生成 */
  claimResults = new Map<string, ClaimResult>();
  /** hasCommitsWithDiff の戻り値（worktreePath → boolean）。既定 true */
  commitsWithDiff = new Map<string, boolean>();
  /** hasUncommittedChanges の戻り値（worktreePath → boolean）。既定 false */
  uncommitted = new Map<string, boolean>();
  /** findOpenPrForBranch の戻り値（branch → number | null）。既定 null */
  openPrForBranch = new Map<string, number | null>();
  /** pushAndOpenPr の戻り値（branch → number）。既定は連番 */
  pushPrNumber = new Map<string, number>();
  private nextPr = 100;
  /** 呼び出し記録 */
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** メソッド名 → 次の1回だけ throw させるエラー */
  private failOnce = new Map<string, Error>();

  failNext(method: keyof GitPrManager, error?: Error): void {
    this.failOnce.set(method, error ?? new Error(`FakeGitPr.${method} injected failure`));
  }

  private takeFailure(method: string): void {
    const err = this.failOnce.get(method);
    if (err) {
      this.failOnce.delete(method);
      throw err;
    }
  }

  async prepareWorktree(issue: EligibleIssue): Promise<ClaimResult> {
    this.calls.push({ method: "prepareWorktree", args: [issue.id] });
    this.takeFailure("prepareWorktree");
    const preset = this.claimResults.get(issue.identifier);
    if (preset) return preset;
    const branch = `looppilot/${issue.identifier.toLowerCase()}-x`;
    return { branch, worktreePath: `/wt/${issue.identifier.toLowerCase()}` };
  }

  async hasCommitsWithDiff(worktreePath: string): Promise<boolean> {
    this.calls.push({ method: "hasCommitsWithDiff", args: [worktreePath] });
    this.takeFailure("hasCommitsWithDiff");
    return this.commitsWithDiff.get(worktreePath) ?? true;
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    this.calls.push({ method: "hasUncommittedChanges", args: [worktreePath] });
    this.takeFailure("hasUncommittedChanges");
    return this.uncommitted.get(worktreePath) ?? false;
  }

  async findOpenPrForBranch(branch: string): Promise<number | null> {
    this.calls.push({ method: "findOpenPrForBranch", args: [branch] });
    this.takeFailure("findOpenPrForBranch");
    return this.openPrForBranch.get(branch) ?? null;
  }

  async pushAndOpenPr(branch: string, worktreePath: string, issue: EligibleIssue): Promise<number> {
    this.calls.push({ method: "pushAndOpenPr", args: [branch, worktreePath, issue.id] });
    this.takeFailure("pushAndOpenPr");
    const preset = this.pushPrNumber.get(branch);
    if (preset !== undefined) return preset;
    return this.nextPr++;
  }

  async addLabel(prNumber: number, label: string): Promise<void> {
    this.calls.push({ method: "addLabel", args: [prNumber, label] });
    this.takeFailure("addLabel");
  }

  async mergePr(prNumber: number, headSha: string): Promise<void> {
    this.calls.push({ method: "mergePr", args: [prNumber, headSha] });
    this.takeFailure("mergePr");
  }

  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    this.calls.push({ method: "discardWorktree", args: [branch, worktreePath] });
    this.takeFailure("discardWorktree");
  }
}

// ---- FakeMonitor ----
export class FakeMonitor implements LoopPilotMonitor {
  /** poll(pr) が順に shift して返す verdict 列。尽きたら最後の verdict を維持して返す */
  verdicts: MonitorVerdict[] = [];
  /** checkMergeReadiness の戻り値（pr → MergeReadiness）。既定 ready */
  readiness = new Map<number, MergeReadiness>();
  /** poll の呼び出し記録（pr 番号） */
  pollCalls: number[] = [];
  /** checkMergeReadiness の呼び出し記録（pr 番号） */
  readinessCalls: number[] = [];

  async poll(prNumber: number): Promise<MonitorVerdict> {
    this.pollCalls.push(prNumber);
    if (this.verdicts.length > 1) {
      return this.verdicts.shift() as MonitorVerdict;
    }
    if (this.verdicts.length === 1) {
      return this.verdicts[0];
    }
    throw new Error("FakeMonitor: no verdict queued");
  }

  async checkMergeReadiness(prNumber: number): Promise<MergeReadiness> {
    this.readinessCalls.push(prNumber);
    return this.readiness.get(prNumber) ?? { ready: true, headSha: `sha-${prNumber}` };
  }
}

// ---- FakeNotifier ----
export class FakeNotifier implements Notifier {
  /** notify された NotifyEvent を蓄積 */
  events: NotifyEvent[] = [];

  async notify(event: NotifyEvent): Promise<void> {
    this.events.push(event);
  }

  async probeReachability(): Promise<void> {
    // テストではプリフライト専用。no-op。
  }
}
```

- [ ] **Step 2: `tests/orchestrator.test.ts` を作成し、最初の失敗するテスト（1チケット完走）を書く**

`tests/orchestrator.test.ts` を新規作成（この時点で `src/orchestrator.ts` は存在しないため import エラーで失敗する）:

```typescript
import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs } from "../src/types.js";

// ---- テストヘルパ ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number | undefined;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product" },
    digest: { recentMergedCount: over.recentMergedCount ?? 5 },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
  } as unknown as Config;
}

function issue(id: string, identifier: string, over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id,
    identifier,
    title: over.title ?? `Title for ${identifier}`,
    description: over.description ?? "",
    priority: over.priority ?? 2,
    sortOrder: over.sortOrder ?? 0,
    url: over.url ?? `https://linear.app/issue/${identifier}`,
  };
}

interface Harness {
  orch: Orchestrator;
  store: SqliteStore;
  source: FakeTaskSource;
  agent: FakeAgentRunner;
  git: FakeGitPr;
  monitor: FakeMonitor;
  notifier: FakeNotifier;
  sleepCalls: number[];
  logs: string[];
  promptArgs: PromptArgs[];
}

function makeHarness(config: Config): Harness {
  const store = new SqliteStore(":memory:");
  const source = new FakeTaskSource();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const monitor = new FakeMonitor();
  const notifier = new FakeNotifier();
  const sleepInner = instantSleep();
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    await sleepInner(ms);
  };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const promptArgs: PromptArgs[] = [];
  const buildPrompt = (args: PromptArgs): string => {
    promptArgs.push(args);
    return `PROMPT for ${args.issue.identifier}`;
  };
  const orch = new Orchestrator({
    config,
    source,
    agent,
    git,
    monitor,
    notifier,
    store,
    buildPrompt,
    clock: fixedClock("2026-06-05T00:00:00.000Z"),
    sleep,
    log,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs };
}

describe("Orchestrator 正常系 — 1チケット完走（仕様 §5 SELECT→CLAIM→IMPLEMENT→HANDOFF→MONITOR→DONE）", () => {
  it("単一チケットを選定→worktree→実装→PR→ラベル→監視→マージし、状態が merged になる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.5, summary: "did the work" }];
    // poll: done を返し → checkMergeReadiness(ready) → mergePr → 次 poll で merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // 仕様 §7: 完走後の終端状態は merged
    expect(s.state).toBe("merged");
    expect(s.linearIdentifier).toBe("TY-1");
    expect(s.prNumber).toBe(100);
    expect(s.costUsd).toBe(1.5);
    expect(s.agentSummary).toBe("did the work");
    expect(s.endedAt).not.toBeNull();
    // 仕様 §5.4: in_review 入り時刻が記録される
    expect(s.monitorStartedAt).not.toBeNull();
    // merge が呼ばれた
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(true);
  });
});
```

実行して **import 解決失敗で落ちる**ことを確認する:

```
npx vitest run tests/orchestrator.test.ts
```

期待される失敗: `Failed to resolve import "../src/orchestrator.js"`（モジュール未作成）。

- [ ] **Step 3: `src/orchestrator.ts` を最小実装し、1チケット完走テストを green にする**

`src/orchestrator.ts` を新規作成（完全形）。本タスクで §7 の正常フロー＋失敗終端ヘルパ（型上通る最小）を実装する:

```typescript
import type {
  TaskSource,
  AgentRunner,
  GitPrManager,
  LoopPilotMonitor,
  Notifier,
  EligibleIssue,
  TaskSessionRow,
  FailureReason,
  AgentOutcome,
  MonitorVerdict,
  PromptArgs,
} from "./types.js";
import type { SqliteStore } from "./store.js";
import type { Config } from "./config.js";

export interface OrchestratorDeps {
  config: Config;
  source: TaskSource;
  agent: AgentRunner;
  git: GitPrManager;
  monitor: LoopPilotMonitor;
  notifier: Notifier;
  store: SqliteStore;
  buildPrompt: (args: PromptArgs) => string;
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** フェーズの返り値: 続行か、HALT 済み（ループを脱出すべき）か */
type RunControl =
  | { control: "continue" }
  | { control: "halt" };

const CONTINUE: RunControl = { control: "continue" };
const HALT: RunControl = { control: "halt" };

export class Orchestrator {
  private readonly config: Config;
  private readonly source: TaskSource;
  private readonly agent: AgentRunner;
  private readonly git: GitPrManager;
  private readonly monitor: LoopPilotMonitor;
  private readonly notifier: Notifier;
  private readonly store: SqliteStore;
  private readonly buildPrompt: (args: PromptArgs) => string;
  private readonly clock: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  private runId = 0;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.source = deps.source;
    this.agent = deps.agent;
    this.git = deps.git;
    this.monitor = deps.monitor;
    this.notifier = deps.notifier;
    this.store = deps.store;
    this.buildPrompt = deps.buildPrompt;
    this.clock = deps.clock;
    this.sleep = deps.sleep;
    this.log = deps.log;
  }

  async run(): Promise<void> {
    const pid = process.pid;
    const acquired = this.store.acquireRunLock(pid, isPidAlive, this.clock());
    if (!acquired) {
      this.log("run lock held by another live process; aborting");
      return;
    }
    try {
      const taskCap = this.config.safety.maxTasksPerRun;
      const run = this.store.createRun(taskCap, this.clock());
      this.runId = run.id;
      await this.notifier.notify({
        kind: "run_started",
        detail: `run ${run.id} started (taskCap=${taskCap})`,
      });
      await this.recoverPendingSessions();
      await this.loop();
    } finally {
      this.store.releaseRunLock(pid);
    }
  }

  /**
   * 起動時回復（仕様 §9）。
   * 本タスク（Task 12）では活性セッション無しを前提に素通しする空実装。
   * 中身（in_review 再開 / crash 回復 / 孤児チケット復帰）は Task 14 で実装する。
   */
  private async recoverPendingSessions(): Promise<void> {
    // Task 14 で実装。現状は no-op（活性セッション無し前提）。
  }

  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
      if (started >= this.config.safety.maxTasksPerRun) {
        const detail = `task cap reached: ${started}/${this.config.safety.maxTasksPerRun}`;
        await this.notifier.notify({ kind: "halted", reason: "task_cap", detail });
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }

      // 2) SELECT（仕様 §5.1）
      const issue = await this.source.getNextEligible(this.store.activeIssueIds());
      if (issue === null) {
        // IDLE（キュー空 → 通知は初回のみ → 定期再確認）
        if (!idleNotified) {
          await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
          idleNotified = true;
        }
        this.store.setRunState(this.runId, "idle");
        await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
        continue;
      }
      // 復帰：idle から running へ
      idleNotified = false;
      this.store.setRunState(this.runId, "running");

      // 3) CLAIM
      const claim = await this.claim(issue);
      if (claim.control === "halt") return;
      const session = claim.session;

      // 4) IMPLEMENT
      const impl = await this.implement(session, issue);
      if (impl.control === "halt") return;

      // 5) HANDOFF
      const handoff = await this.handoff(session, issue);
      if (handoff.control === "halt") return;
      const prNumber = handoff.prNumber;

      // 6) MONITOR
      const mon = await this.monitorSession(session, prNumber);
      if (mon.control === "halt") return;

      // 7) DONE
      await this.done(session, issue);
      // ループ継続（SELECT へ）
    }
  }

  // ---- CLAIM（仕様 §5.2） ----
  private async claim(
    issue: EligibleIssue,
  ): Promise<{ control: "halt" } | { control: "continue"; session: TaskSessionRow }> {
    let claimResult;
    try {
      claimResult = await this.git.prepareWorktree(issue);
    } catch (err) {
      // ① prepareWorktree 失敗：セッション行なしで HALT（claim_failed を Run.halt_reason へ）
      const detail = `claim_failed: prepareWorktree for ${issue.identifier}: ${errMsg(err)}`;
      await this.notifier.notify({ kind: "halted", reason: "claim_failed", detail });
      this.store.setRunState(this.runId, "halted", detail);
      this.log(detail);
      return HALT;
    }
    const session = this.store.createSession({
      runId: this.runId,
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      issueTitle: issue.title,
      branch: claimResult.branch,
      worktreePath: claimResult.worktreePath,
      now: this.clock(),
    });
    try {
      await this.source.transition(issue.id, "in_progress");
    } catch (err) {
      // ② transition 失敗：discardWorktree + stopped(claim_failed) + ticket→Todo（best-effort）→ HALT
      await bestEffort(() => this.git.discardWorktree(claimResult.branch, claimResult.worktreePath));
      await bestEffort(() => this.source.transition(issue.id, "todo"));
      const ctrl = await this.stopSession(session, "claim_failed", `transition(in_progress) failed: ${errMsg(err)}`);
      return ctrl;
    }
    return { control: "continue", session };
  }

  // ---- IMPLEMENT（仕様 §5.3） ----
  private async implement(session: TaskSessionRow, issue: EligibleIssue): Promise<RunControl> {
    this.store.updateSession(session.id, { state: "implementing" });
    const digest = this.store.recentMergedSummaries(this.config.digest.recentMergedCount);
    const prompt = this.buildPrompt({ goal: this.config.product.goal, issue, digest });
    const worktreePath = session.worktreePath as string;
    let outcome: AgentOutcome;
    try {
      outcome = await this.agent.runSession({
        worktreePath,
        prompt,
        maxCostUsd: this.config.safety.maxCostUsdPerSession,
      });
    } catch (err) {
      return await this.stopSession(session, "exception", errMsg(err));
    }

    if (outcome.kind === "cost_exceeded") {
      this.store.updateSession(session.id, { costUsd: outcome.costUsd });
      await bestEffort(() => this.git.discardWorktree(session.branch, worktreePath));
      return await this.stopSession(session, "cost_exceeded", null, { costUsd: outcome.costUsd });
    }
    if (outcome.kind === "error") {
      this.store.updateSession(session.id, { costUsd: outcome.costUsd });
      return await this.stopSession(session, "exception", outcome.message, { costUsd: outcome.costUsd });
    }
    // completed: まず cost と summary を永続化（仕様 §7 IMPLEMENT 後条件）
    this.store.updateSession(session.id, { costUsd: outcome.costUsd, agentSummary: outcome.summary });
    if (await this.git.hasUncommittedChanges(worktreePath)) {
      return await this.stopSession(session, "agent_no_change", "uncommitted leftovers", { costUsd: outcome.costUsd });
    }
    if (!(await this.git.hasCommitsWithDiff(worktreePath))) {
      return await this.stopSession(session, "agent_no_change", null, { costUsd: outcome.costUsd });
    }
    return CONTINUE;
  }

  // ---- HANDOFF（仕様 §5.4） ----
  private async handoff(
    session: TaskSessionRow,
    issue: EligibleIssue,
  ): Promise<{ control: "halt" } | { control: "continue"; prNumber: number }> {
    this.store.updateSession(session.id, { state: "handing_off" });
    const worktreePath = session.worktreePath as string;
    let prNumber: number;
    try {
      const existing = await this.git.findOpenPrForBranch(session.branch);
      if (existing !== null) {
        prNumber = existing;
      } else {
        prNumber = await this.git.pushAndOpenPr(session.branch, worktreePath, issue);
      }
      // PR 番号を即時永続化（仕様 §5.4 ③）
      this.store.updateSession(session.id, { prNumber });
      await retry(3, () => this.git.addLabel(prNumber, this.config.looppilot.gateLabel));
      await retry(3, () => this.source.transition(issue.id, "in_review"));
    } catch (err) {
      const prText = describePr(this.store.getSession(session.id).prNumber);
      const ctrl = await this.stopSession(session, "handoff_failed", `handoff failed (${prText}): ${errMsg(err)}`);
      return ctrl;
    }
    // in_review 入りと監視起点を同一 patch で原子的に設定（仕様 §5.4 ⑤）
    this.store.updateSession(session.id, { state: "in_review", monitorStartedAt: this.clock() });
    return { control: "continue", prNumber };
  }

  // ---- MONITOR（仕様 §5.5 / §5.4 / §6） ----
  private async monitorSession(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    const pollIntervalMs = this.config.loop.monitorPollSeconds * 1000;
    let pollFailures = 0;
    let backoffMultiplier = 1;
    while (true) {
      await this.sleep(pollIntervalMs * backoffMultiplier);
      let verdict: MonitorVerdict;
      try {
        verdict = await this.monitor.poll(prNumber);
      } catch (err) {
        // poll throw → バックオフ（×2..×8）、5連続で stopped(exception)
        pollFailures += 1;
        if (pollFailures >= 5) {
          return await this.stopSession(session, "exception", `monitor poll failed 5x: ${errMsg(err)}`);
        }
        backoffMultiplier = Math.min(backoffMultiplier * 2, 8);
        continue;
      }
      pollFailures = 0;
      backoffMultiplier = 1;

      switch (verdict.kind) {
        case "merged":
          return CONTINUE; // DONE へ
        case "done": {
          const ctrl = await this.tryMerge(session, prNumber);
          if (ctrl === "merged") return CONTINUE;
          if (ctrl === "halt") return HALT;
          continue; // 続行（次ポーリング）
        }
        case "stopped":
          return await this.stopSession(
            session,
            "looppilot_stopped",
            verdict.stopReason ?? "looppilot stopped (no reason)",
          );
        case "pr_closed":
          return await this.stopSession(session, "pr_closed", null);
        case "corrupted":
          return await this.stopSession(
            session,
            "monitor_never_engaged",
            "looppilot-state comment present but corrupted",
          );
        case "not_engaged": {
          if (this.elapsedMinutesSinceMonitorStart(session.id) > this.config.safety.notEngagedGuardMinutes) {
            return await this.stopSession(session, "monitor_never_engaged", null);
          }
          continue;
        }
        case "in_progress": {
          const timeout = this.config.safety.monitorTimeoutMinutes;
          if (timeout !== undefined && this.elapsedMinutesSinceMonitorStart(session.id) > timeout) {
            return await this.stopSession(session, "exception", "monitor timeout");
          }
          continue;
        }
      }
    }
  }

  /** done verdict 時のマージ試行。"merged" | "continue" | "halt" を返す */
  private async tryMerge(session: TaskSessionRow, prNumber: number): Promise<"merged" | "continue" | "halt"> {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return "continue";
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return "halt";
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return "halt";
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return "halt";
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return "merged";
    } catch {
      // 次ポーリングで再評価（mergePr 連続失敗の fail-closed は Task 13 で精密化）
      return "continue";
    }
  }

  // ---- DONE（仕様 §5.6 / §7） ----
  private async done(session: TaskSessionRow, issue: EligibleIssue): Promise<void> {
    this.store.updateSession(session.id, { state: "merged", endedAt: this.clock() });
    try {
      await retry(3, () => this.source.transition(issue.id, "done"));
    } catch (err) {
      // best-effort：失敗してもコンソール警告のみで Run=running 維持（仕様 §5.6 注記）
      this.log(`warning: transition(done) failed for ${issue.identifier}: ${errMsg(err)}`);
    }
    const mergedCount = this.store.countMerged(this.runId);
    this.log(`merged ${issue.identifier} (merged_count=${mergedCount})`);
  }

  // ---- 共通の STOPPED 終端（仕様 §7） ----
  private async stopSession(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber">> = {},
  ): Promise<{ control: "halt" }> {
    this.store.updateSession(session.id, {
      state: "stopped",
      failureReason: reason,
      stopDetail: detail,
      endedAt: this.clock(),
      ...extraPatch,
    });
    const haltDetail = `${session.linearIdentifier} stopped (${reason})${detail ? `: ${detail}` : ""}`;
    await this.notifier.notify({ kind: "halted", reason, detail: haltDetail });
    this.store.setRunState(this.runId, "halted", haltDetail);
    this.log(haltDetail);
    return HALT;
  }

  private elapsedMinutesSinceMonitorStart(sessionId: number): number {
    const fresh = this.store.getSession(sessionId);
    if (fresh.monitorStartedAt === null) return 0;
    const startMs = Date.parse(fresh.monitorStartedAt);
    const nowMs = Date.parse(this.clock());
    return (nowMs - startMs) / 60000;
  }
}

// ---- module-private helpers ----
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describePr(prNumber: number | null): string {
  return prNumber === null ? "no PR created" : `PR #${prNumber}`;
}

async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // 破棄/復帰のベストエフォート。失敗は無視。
  }
}

async function retry(times: number, fn: () => Promise<void>): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < times; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts
```

期待: 1チケット完走テストが pass。

- [ ] **Step 4: `npm run check` で全体（tsc×2 + vitest）green を確認する**

```
npm run check
```

期待: 既存タスクのテスト含め全て pass、型エラーなし。失敗（例: `Config` の必須フィールドが makeConfig に不足）が出たら、`makeConfig` の `as unknown as Config` キャストでテスト型は通っているはずなので、`src/config.ts` の `Config` 型に存在するフィールド名と本実装の参照名（`safety.maxTasksPerRun` 等）が一致しているか確認する。不一致が **カーネル §3 と矛盾** していたら openQuestions に上げる（勝手に直さない）。

- [ ] **Step 5: red-green の単位でコミットする（フェイク＋正常系コア）**

```
git add src/orchestrator.ts tests/fakes.ts tests/orchestrator.test.ts
git commit -m "feat: Orchestrator core happy path (select→claim→implement→handoff→monitor→done)"
```

- [ ] **Step 6: 2チケット逐次のテストを追加（red）**

`tests/orchestrator.test.ts` に describe ブロックを追記する:

```typescript
describe("Orchestrator 正常系 — 2チケット逐次（仕様 §3 逐次・§5 ループ）", () => {
  it("2件を順に完走し、両方 merged・状態遷移の順序が記録される", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A done" },
      { kind: "completed", costUsd: 2, summary: "B done" },
    ];
    // 各セッション: done → merged
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.linearIdentifier)).toEqual(["TY-1", "TY-2"]);
    expect(sessions.every((s) => s.state === "merged")).toBe(true);
    expect(h.store.countMerged(runId)).toBe(2);

    // Linear への遷移列（仕様 §5）: 各チケット in_progress → in_review → done
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
      { issueId: "issue-B", state: "in_progress" },
      { issueId: "issue-B", state: "in_review" },
      { issueId: "issue-B", state: "done" },
    ]);

    // 2件目の SELECT 時、1件目はもう active ではない（merged）→ excludeIds は空のまま
    // （冪等性: 進行中セッションだけ除外。merged は除外対象外）
    expect(h.source.eligibleCalls.length).toBe(2); // A選定 / B選定（3反復目は taskCap 到達で SELECT 前に HALT）
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "2チケット逐次"
```

期待: 初回は green になるはず（コアは既に2件を回せる設計）。もし遷移列やカウントがずれて落ちたら、`done()` の transition 呼び出し位置・`loop()` のタスク上限チェック位置を仕様 §5 と突き合わせて調整する。green を確認する。

- [ ] **Step 7: 状態遷移列の検証テストを追加（TaskSession.state の軌跡）**

`tests/orchestrator.test.ts` に追記。SqliteStore は state を上書きするため軌跡を直接は持たないので、`buildPrompt` 呼び出し時点・各フェイク呼び出し順から軌跡を検証する形にする:

```typescript
describe("Orchestrator 正常系 — フェーズ順序（仕様 §5 状態機械の呼び出し列）", () => {
  it("1チケットで claim→implement→handoff→monitor→done の外部呼び出しが正しい順序で起きる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Git/PR 呼び出しの順序（封筒の操作列）
    const gitMethods = h.git.calls.map((c) => c.method);
    expect(gitMethods).toEqual([
      "prepareWorktree",    // CLAIM
      "hasUncommittedChanges", // IMPLEMENT 後条件（先に残骸チェック）
      "hasCommitsWithDiff",    // IMPLEMENT 後条件（次に実差分チェック）
      "findOpenPrForBranch",   // HANDOFF（既存PR確認）
      "pushAndOpenPr",         // HANDOFF（新規PR）
      "addLabel",              // HANDOFF（ゲートラベル）
      "mergePr",               // DONE経路（done verdict→ready→merge）
    ]);

    // run_started 通知が最初に 1 回だけ送られる（halted/idle は出ない）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started"]);

    // エージェントへ渡された prompt 引数（文脈バンドル）の検証
    expect(h.promptArgs).toHaveLength(1);
    expect(h.promptArgs[0].goal).toBe("ship the product");
    expect(h.promptArgs[0].issue.identifier).toBe("TY-1");
    expect(Array.isArray(h.promptArgs[0].digest)).toBe(true);

    // agent に渡された SessionContext
    expect(h.agent.contexts).toHaveLength(1);
    expect(h.agent.contexts[0].prompt).toBe("PROMPT for TY-1");
    expect(h.agent.contexts[0].maxCostUsd).toBe(10);
    expect(h.agent.contexts[0].worktreePath).toBe("/wt/ty-1");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "フェーズ順序"
```

期待: green。落ちたら IMPLEMENT 後条件の呼び出し順（仕様 §7: hasUncommittedChanges を先、hasCommitsWithDiff を後）と HANDOFF の findOpenPrForBranch→pushAndOpenPr 順を実装と突き合わせる。

- [ ] **Step 8: monitorStartedAt と transition 呼び出し列・通知列の単体検証を補強（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — 監視起点と Linear 遷移（仕様 §5.4 / §5.6）", () => {
  it("in_review 入りで monitorStartedAt が clock() の値で設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // fixedClock は呼ぶ度に +1s。monitorStartedAt は ISO 文字列で非 null。
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);

    // transition は in_progress → in_review → done の 3 回
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
    ]);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "監視起点と Linear 遷移"
```

期待: green。

- [ ] **Step 9: ここまでの正常系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator sequential, phase-order, and monitor-start coverage"
```

- [ ] **Step 10: タスク上限 HALT のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — タスク上限 HALT（仕様 §11 / §5.1）", () => {
  it("taskCap=1 でキューに2件あっても1件だけ完走し、上限到達で HALT 通知して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    // 1件だけ着手・完走
    expect(h.store.countTasksStarted(run.id)).toBe(1);
    expect(h.store.countMerged(run.id)).toBe(1);
    // 2件目は未着手のままキューに残る
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-2"]);

    // Run は halted・理由は task cap
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap reached");

    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    const halted = h.notifier.events.find((e) => e.kind === "halted");
    expect(halted).toMatchObject({ kind: "halted", reason: "task_cap" });
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "タスク上限 HALT"
```

期待: green。落ちたら `loop()` の上限チェックが「SELECT より前・各反復先頭」にあるか、`countTasksStarted` の比較が `>=` か（仕様 §11: 到達で HALT）を確認する。

- [ ] **Step 11: IDLE→復帰のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記。`FakeTaskSource.getNextEligible` を「最初は null、次は復帰した issue」と振る舞わせるため、フェイクの `queue` を空で開始し、`instantSleep`（sleep 呼び出し後に解決）後に手を入れる。フェイクは決定的に動かしたいので、`getNextEligible` を回数で出し分けるラッパを差し込む形にする（フェイク本体は改変しない）:

```typescript
describe("Orchestrator 正常系 — IDLE→復帰（仕様 §5.1 / §10）", () => {
  it("最初キュー空で IDLE 通知＋sleep、再確認で復帰して1件完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleRecheckSeconds: 300 });
    const h = makeHarness(config);

    // getNextEligible: 1回目 null（IDLE）、2回目以降は復帰した issue を返す
    let eligibleCall = 0;
    const recovered = issue("issue-A", "TY-1");
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall += 1;
      if (eligibleCall === 1) return null; // 初回 IDLE
      // 復帰後は1回だけ issue を流し、それ以降は queue 経由
      if (eligibleCall === 2) return recovered;
      return origGetNext(excludeIds);
    };

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    expect(h.store.countMerged(runId)).toBe(1);

    // IDLE 通知が初回のみ送られた（run_started → idle → halted(task_cap)）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "idle", "halted"]);

    // IDLE 中に idle_recheck_seconds*1000 で sleep した
    expect(h.sleepCalls).toContain(config.loop.idleRecheckSeconds * 1000);

    // 復帰後 Run は running を経て、最終的に halted（taskCap=1 到達）
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});
```

> 注: 上のテストはフェイクのメソッドを差し替える（フェイク本体は改変しない）。`origGetNext` 経由のフォールバックは安全網であり、taskCap=1 のため呼ばれない見込み。`sleepCalls` には MONITOR の poll 間隔 sleep も混ざるので `toContain` で IDLE の sleep だけを検証する。

実行:

```
npx vitest run tests/orchestrator.test.ts -t "IDLE"
```

期待: green。落ちたら IDLE 分岐で `setRunState(idle)` → `sleep(idleRecheckSeconds*1000)` → `continue` し、復帰時に `setRunState(running)` する流れと、`idle` 通知が初回のみ（`idleNotified` フラグ）であることを確認する。

- [ ] **Step 12: PR 再利用（findOpenPrForBranch ヒット）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — 既存PR再利用（仕様 §5.4 二重PR禁止）", () => {
  it("findOpenPrForBranch が既存PR番号を返したら pushAndOpenPr を呼ばずそのPRで監視する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // prepareWorktree が返すブランチを固定し、その branch に既存PR #777 をセット
    const branch = "looppilot/ty-1-x";
    h.git.claimResults.set("TY-1", { branch, worktreePath: "/wt/ty-1" });
    h.git.openPrForBranch.set(branch, 777);

    await h.orch.run();

    // pushAndOpenPr は呼ばれない
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // 既存 PR 番号で永続化・ラベル付与・マージ
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.prNumber).toBe(777);
    expect(h.git.calls).toContainEqual({ method: "addLabel", args: [777, "loop-pilot"] });
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [777, "sha-777"] });
    expect(s.state).toBe("merged");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "既存PR再利用"
```

期待: green。落ちたら HANDOFF の分岐（`findOpenPrForBranch !== null` で `pushAndOpenPr` をスキップ）を確認する。`mergePr` の headSha は `FakeMonitor.checkMergeReadiness` の既定 `sha-${prNumber}`。

- [ ] **Step 13: 正常系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator task-cap HALT, IDLE recovery, PR reuse"
```

- [ ] **Step 14: `npm run check` で最終 green を確認する**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。型・シグネチャがカーネル §2/§4/§6/§7 と一致していること。失敗が残る場合、カーネルとの矛盾が原因なら openQuestions に記録し、コードは勝手に改変しない。

- [ ] **Step 15: 仕上げコミット（必要なら）**

ここまでで `src/orchestrator.ts`（正常系コア＋失敗終端の型上最小実装）と `tests/fakes.ts`（残りフェイク）と `tests/orchestrator.test.ts`（正常系 6 シナリオ）が揃う。差分が未コミットなら:

```
git add src/orchestrator.ts tests/fakes.ts tests/orchestrator.test.ts
git commit -m "chore: finalize Orchestrator happy-path task"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` が `Orchestrator` クラスをエクスポートし、`run()` で ランロック取得→Run 作成→run_started 通知→`recoverPendingSessions()`（空実装）→ループ（SELECT/CLAIM/IMPLEMENT/HANDOFF/MONITOR/DONE）を回す。
- `tests/fakes.ts` に `FakeTaskSource` / `FakeAgentRunner` / `FakeGitPr` / `FakeMonitor` / `FakeNotifier` がカーネル §6 のシグネチャで追記されている。
- `tests/orchestrator.test.ts` の正常系 6 シナリオ（1チケット完走 / 2チケット逐次 / フェーズ順序 / 監視起点と遷移 / タスク上限 HALT / IDLE→復帰 / 既存PR再利用）が全て green。
- `recoverPendingSessions()` は本タスクでは no-op（Task 14 が中身を実装）。
- 失敗系の網羅テストは Task 13。本実装は失敗遷移が型上通る最小形（`stopSession` / `tryMerge` / `claim` の失敗分岐）を含むが、テストは正常系のみ。
- `npm run check` が green。


---

### Task 13: Orchestrator 失敗系 + 安全弁

**目的**: Task 12 が組んだ `src/orchestrator.ts` の正常フローに対し、カーネル §7 の**全失敗経路と安全弁**を確定させる。コード変更は最小限の 2 点（①`done` verdict での `mergePr` **2 連続 throw → fail-closed stopped(ci_failed)** をカーネル §7.6 の文言どおりに実装、②**SIGINT/停止要求フラグ**を注入可能な形で追加し「次の安全点で halt」を実現）に留め、残りは Task 12 が既に書いた失敗分岐（CLAIM ①/②・agent_no_change・cost_exceeded・exception・handoff_failed・各 verdict→stopped 写像・poll throw バックオフ・DONE transition 失敗継続）を **テストで固定**する。`fixedClock`/`instantSleep`＋テスト内の `monitorStartedAt` 上書きで時間を決定的にする。

**依存タスク**:
- Task 12（`src/orchestrator.ts` の `Orchestrator`・`OrchestratorDeps`・`loop`/`claim`/`implement`/`handoff`/`monitorSession`/`tryMerge`/`done`/`stopSession`、`tests/fakes.ts` の `FakeTaskSource`/`FakeAgentRunner`/`FakeGitPr`/`FakeMonitor`/`FakeNotifier`、`tests/orchestrator.test.ts` の `makeConfig`/`issue`/`makeHarness`/`Harness`）。本タスクは**これらを再定義せず Modify する**。
- Task 2（`src/types.ts`：`FailureReason`・`MonitorVerdict`・`MergeReadiness`・`TaskSessionRow` 等）
- Task 5（`src/store.ts`：`SqliteStore`。`updateSession`/`setRunState`/`countTasksStarted`/`countMerged`/`getSession`/`sessionsForRun`/`latestRun` を使用）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/orchestrator.ts`: `Orchestrator`, `OrchestratorDeps`（Task 12）
- `src/types.ts`: `FailureReason`, `MonitorVerdict`, `MergeReadiness`, `TaskSessionRow`, `AgentOutcome`, `EligibleIssue`, `NotifyEvent`（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/config.ts`: `Config`（型のみ。テストは `makeConfig` の `as unknown as Config` キャスト）
- `tests/fakes.ts`: `FakeTaskSource`, `FakeAgentRunner`, `FakeGitPr`, `FakeMonitor`, `FakeNotifier`, `fixedClock`, `instantSleep`（Task 3/12）
- `tests/orchestrator.test.ts`: `makeConfig`, `issue`, `makeHarness`, `Harness`（Task 12 で定義済み。本タスクは import せず**同ファイルに describe を追記**するだけ）

> 注: 本タスクが触る Config フィールドは Task 12 と同一（`safety.maxTasksPerRun`/`safety.maxCostUsdPerSession`/`safety.notEngagedGuardMinutes`/`safety.monitorTimeoutMinutes`/`loop.monitorPollSeconds`/`loop.idleRecheckSeconds`/`looppilot.gateLabel`/`product.goal`/`digest.recentMergedCount`）。新フィールドは追加しない。

---

#### このセクションが確定させる失敗系・安全弁の形（実装の正）

カーネル §7 の失敗経路を、Task 12 のコード構造（`RunControl` 番兵・`stopSession` 共通終端・各フェーズ private メソッド）の上で固定する。**Task 12 から変えるコードは 2 箇所だけ**:

1. **`mergePr` 2 連続 throw の fail-closed（カーネル §7.6）** — Task 12 の `tryMerge` は throw を握って常に `"continue"` を返す（連続回数を数えない）。これを「`ready` verdict のまま `mergePr` が **2 連続** throw → `stopped(ci_failed, stop_detail="merge call failed under ready verdict: <error>")`」に直す。実装は `monitorSession` 側に **連続マージ失敗カウンタ** `mergeFailures` を持たせ、`tryMerge` が throw を `{ kind:"merge_failed", error }`（判別共用体の第 4 メンバ）として返す形に変更する。`ready` 以外の readiness（ci_failed/conflict/blocked）由来の即 halt は Task 12 のまま。`continue`（ci_pending/unknown）が一度でも挟まれば `mergeFailures` をリセットする（「ready のまま 2 連続」を厳密に表す）。

2. **SIGINT / 停止要求フラグ（カーネル §7 末尾）** — `process.on("SIGINT")` を直接張ると `process.exit` が混ざりテスト不能になるため、注入可能にする。`Orchestrator` に public `requestStop(): void`（`interrupted=true` を立てるだけ）と private `interrupted=false` を追加し、**ループの安全点**（各反復先頭＝タスク上限チェックの直前）で `interrupted` を見て `haltForInterrupt()`（Run=halted(reason="user_interrupt") + notify(halted)・進行中セッションは stopped にしない）→ ループ脱出する。実 SIGINT ハンドラ（`process.on("SIGINT", () => orch.requestStop())` と最終 `process.exit`）の配線は Task 16（main）の所掌。ロック解放は Task 12 の `run()` の `finally` が担うため二重実装しない。

その他の失敗経路（CLAIM ①②、agent_no_change の 2 形、cost_exceeded、exception、handoff_failed の PR 番号明記、各 verdict→stopped 写像、not_engaged ガード、monitor_timeout、poll throw 5 連続、DONE transition 3 回失敗でも継続）は **Task 12 の実装が既に正しい**ので、コードは変えず **網羅テストだけを足す**。テストで挙動が仕様とズレた場合のみ、カーネルとの一致を確認し、矛盾は openQuestions に上げる（勝手に直さない）。

---

#### Files

- **Modify**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`（`tryMerge` の戻り値型と throw 扱い・`monitorSession` の連続マージ失敗カウント、`requestStop`/`interrupted`/安全点チェック/`haltForInterrupt` を追加）
- **Modify**: `/home/racoma-dev/loop-pilot-os/tests/orchestrator.test.ts`（失敗系・安全弁の describe を追記。`makeConfig`/`issue`/`makeHarness`/`Harness` は再定義しない）

---

#### Step-by-step（TDD）

- [ ] **Step 1: CLAIM ①（prepareWorktree 失敗→セッション行なし HALT）と ②（transition 失敗→discardWorktree+stopped(claim_failed)+todo 復帰→HALT）のテストを追加（red→green）**

`tests/orchestrator.test.ts` の末尾に describe を追記する（`makeConfig`/`issue`/`makeHarness` は Task 12 で定義済みのものを使う）:

```typescript
describe("Orchestrator 失敗系 — CLAIM（仕様 §5.2 / カーネル §7.3）", () => {
  it("① prepareWorktree が throw → セッション行を作らず Run=halted(claim_failed) で停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.failNext("prepareWorktree", new Error("worktree add: already exists"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    // セッション行は 1 つも作られない（CLAIM ① はセッション行なしで HALT）
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
    expect(h.store.countTasksStarted(run.id)).toBe(0);
    // Run は halted・理由に claim_failed
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("claim_failed");
    expect(run.haltReason).toContain("TY-1");
    // transition は一切呼ばれない（in_progress すら）
    expect(h.source.transitions).toEqual([]);
    // 通知列: run_started → halted(claim_failed)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });

  it("② transition(in_progress) が throw → discardWorktree + stopped(claim_failed) + ticket→Todo 復帰 → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    // prepareWorktree は成功・branch/worktree を固定
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // transition の最初の呼び出し（in_progress）で throw
    h.source.failNext("transition", new Error("Linear 5xx"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // セッション行は作られている（createSession は transition より前）
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("claim_failed");
    expect(s.stopDetail).toContain("transition(in_progress) failed");
    expect(s.endedAt).not.toBeNull();
    // discardWorktree がベストエフォートで呼ばれた
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // ticket→Todo 復帰がベストエフォートで呼ばれた（in_progress は throw したので記録されない）
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "todo" }]);
    // Run=halted・通知列 run_started → halted(claim_failed)
    expect(run.state).toBe("halted");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });
});
```

実行して green を確認する（コア実装は Task 12 が済ませているので初回 green の見込み）:

```
npx vitest run tests/orchestrator.test.ts -t "CLAIM"
```

期待: 両テスト green。落ちたら Task 12 の `claim()` 分岐（① はセッション作成前に HALT、② は `createSession` 後に `discardWorktree`→`transition(todo)`→`stopSession`）を仕様と突き合わせる。ズレがカーネル §7.3（カーネル §7 ステップ 3）と矛盾するなら openQuestions に記録（勝手に直さない）。

- [ ] **Step 2: IMPLEMENT 失敗系（agent_no_change 2 形 / cost_exceeded の discardWorktree 順 / exception）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記:

```typescript
describe("Orchestrator 失敗系 — IMPLEMENT（仕様 §5.3 / カーネル §7.4）", () => {
  it("agent_no_change【未コミット残骸】hasUncommittedChanges=true → stopped(agent_no_change, 'uncommitted leftovers')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 0.7, summary: "tried" }];
    // 残骸あり → hasCommitsWithDiff まで進まない
    h.git.uncommitted.set("/wt/ty-1", true);

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBe("uncommitted leftovers");
    // 仕様 §7: completed はまず cost と summary を永続化してから後条件を見る
    expect(s.costUsd).toBe(0.7);
    expect(s.agentSummary).toBe("tried");
    // hasUncommittedChanges を見たら true なので hasCommitsWithDiff は呼ばれない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // HANDOFF へ進んでいない
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("agent_no_change【無差分】hasUncommittedChanges=false ∧ hasCommitsWithDiff=false → stopped(agent_no_change, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.2, summary: "nothing useful" }];
    h.git.uncommitted.set("/wt/ty-1", false);
    h.git.commitsWithDiff.set("/wt/ty-1", false); // 実差分なし

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBeNull();
    expect(s.costUsd).toBe(1.2);
    expect(s.agentSummary).toBe("nothing useful");
    // 両後条件メソッドが呼ばれている（残骸→差分の順）
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).toContain("hasCommitsWithDiff");
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("cost_exceeded → updateSession(costUsd) → discardWorktree → stopped(cost_exceeded)。discard が後条件チェックより前に走り、後条件は走らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 5 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 5.0 }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(5.0);
    expect(s.endedAt).not.toBeNull();
    // discardWorktree が呼ばれた（部分作業破棄）
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // 後条件チェック（hasUncommittedChanges/hasCommitsWithDiff）は走らない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).not.toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // 通知列 run_started → halted(cost_exceeded)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
  });

  it("agent error outcome → updateSession(costUsd) → stopped(exception, stop_detail=message)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "error", costUsd: 0.3, message: "claude crashed: ENOSPC" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("claude crashed: ENOSPC");
    expect(s.costUsd).toBe(0.3);
  });

  it("agent.runSession 自体が throw → stopped(exception, stop_detail=エラーメッセージ)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    // outcomes を空にすると FakeAgentRunner.runSession が "no outcome queued" を throw する
    h.agent.outcomes = [];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("no outcome queued");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "IMPLEMENT"
```

期待: 全 green。落ちたら Task 12 の `implement()` の順序（cost_exceeded → updateSession(costUsd) → discardWorktree → stopSession / completed → updateSession(costUsd,summary) → hasUncommittedChanges → hasCommitsWithDiff）を仕様 §7.4（カーネル §7 ステップ 4）と突き合わせる。

- [ ] **Step 3: HANDOFF 失敗（handoff_failed の stop_detail に PR 番号明記）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記:

```typescript
describe("Orchestrator 失敗系 — HANDOFF（仕様 §5.4 / カーネル §7.5）", () => {
  it("addLabel が 3 連続 throw → stopped(handoff_failed)。PR は作成済みなので stop_detail に PR 番号を明記する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // pushAndOpenPr は #100 を返す。addLabel をずっと失敗させる（retry 3 回）
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    let addLabelCalls = 0;
    h.git.addLabel = async (prNumber: number, label: string) => {
      addLabelCalls += 1;
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      throw new Error("gh: label not found");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // PR 番号は即時永続化されている
    expect(s.prNumber).toBe(100);
    // stop_detail に PR #100 が明記される（仕様: 作成済みPRを通知に明記）
    expect(s.stopDetail).toContain("PR #100");
    // addLabel は retry で 3 回呼ばれた
    expect(addLabelCalls).toBe(3);
    // transition(in_review) は addLabel が先に死ぬので呼ばれていない
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "in_progress" }]);
    // 通知列 run_started → halted(handoff_failed)
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "handoff_failed" });
  });

  it("pushAndOpenPr 自体が throw → PR 未作成なので stop_detail は 'no PR created'", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.failNext("pushAndOpenPr", new Error("git push rejected"));

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    expect(s.prNumber).toBeNull();
    expect(s.stopDetail).toContain("no PR created");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "HANDOFF"
```

期待: green。落ちたら Task 12 の `handoff()` の `describePr(this.store.getSession(...).prNumber)` 経路（PR 即時永続化→addLabel/transition の retry→失敗で stopSession(handoff_failed)）を確認する。

> 注: addLabel を差し替えるテストでは `h.git.calls.push` を手動で行う。Task 12 の `FakeGitPr.addLabel` は `takeFailure` 前に calls へ push するが、メソッドごと差し替える本テストでは差し替え側で push を再現する（呼び出し記録の整合性のため）。

- [ ] **Step 4: ここまでの失敗系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator CLAIM/IMPLEMENT/HANDOFF failure paths"
```

- [ ] **Step 5: MONITOR の verdict→stopped 写像（looppilot_stopped の stopReason null 含む・pr_closed・corrupted 即停止）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`monitor.verdicts` の最初の要素を失敗 verdict にすれば、1 回目の poll で確定する（Task 12 の `FakeMonitor.poll` は要素 >1 で shift、=1 で同じものを返す）:

```typescript
describe("Orchestrator 失敗系 — MONITOR verdict 写像（仕様 §5.5 / §5.4 / カーネル §7.6）", () => {
  it("stopped(stopReason='codex gave up') → stopped(looppilot_stopped, stop_detail=stopReason)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
  });

  it("stopped(stopReason=null) → stopped(looppilot_stopped, stop_detail='looppilot stopped (no reason)')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.failureReason).toBe("looppilot_stopped");
    // null はそのまま保持せず既定文言へ（カーネル §7.6）
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });

  it("pr_closed → stopped(pr_closed, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.stopDetail).toBeNull();
  });

  it("corrupted → 即 stopped(monitor_never_engaged)。ガード経過を待たない（1 回目 poll で停止）", async () => {
    // ガードを 999 分にしても即停止することで「ガードを待たない」ことを確かめる
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // poll は 1 回だけ（即停止）
    expect(h.monitor.pollCalls).toHaveLength(1);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "MONITOR verdict 写像"
```

期待: 全 green。落ちたら Task 12 の `monitorSession()` の switch を仕様 §7.6（カーネル §7 ステップ 6）と突き合わせる（特に corrupted は `not_engaged` と違いガード経過を**見ずに**即 `stopSession`）。

- [ ] **Step 6: not_engaged ガード経過 / in_progress の monitor_timeout を、`monitorStartedAt` 上書きで決定的にテスト（red→green）**

`fixedClock` は呼ぶ度 +1s なので 30 分等の閾値超過を時刻進行だけでは作りにくい。そこで**テスト内で `monitorStartedAt` を直接過去へ上書き**し、`clock()` が返す時刻（基準 `2026-06-05T00:00:00.000Z` から +1s ずつ）との差を閾値超に仕立てる。Task 12 の `elapsedMinutesSinceMonitorStart` は毎回 `getSession(id).monitorStartedAt` を読み直す（store 由来）ので、poll をフックして poll 前に上書きすれば 1 ポーリングで閾値超過を作れる:

```typescript
describe("Orchestrator 失敗系 — not_engaged ガード / monitor_timeout（仕様 §5.5 / §11 / カーネル §7.6）", () => {
  it("not_engaged かつ経過 > not_engaged_guard_minutes → stopped(monitor_never_engaged, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // not_engaged を返し続ける（FakeMonitor は要素 1 のとき同じものを返す）
    h.monitor.verdicts = [{ kind: "not_engaged" }];

    // poll をフックして、poll の直前に monitorStartedAt を「現在 clock より 60 分前」へ上書きする。
    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T23:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBeNull();
    // 1 回目の poll で経過超過 → 即停止
    expect(h.monitor.pollCalls).toHaveLength(1);
  });

  it("not_engaged かつ経過 <= guard → 続行（停止しない）。経過が閾値内なら poll を繰り返す", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // 1 回目 not_engaged（ガード未経過で続行）→ 2 回目 done → merged で完走
    // monitorStartedAt は上書きしない（clock の進みは数秒なので 30 分閾値を超えない）
    h.monitor.verdicts = [{ kind: "not_engaged" }, { kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ガード内 not_engaged では停止せず、最終的に merged
    expect(s.state).toBe("merged");
    // 少なくとも 2 回 poll した（not_engaged 続行 → done）
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("in_progress かつ monitor_timeout_minutes 設定・total 経過超過 → stopped(exception, 'monitor timeout')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorTimeoutMinutes: 120 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "in_progress" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      // monitorStartedAt を 3 時間前へ（> 120 分）
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T21:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("monitor timeout");
  });

  it("in_progress かつ monitor_timeout 未設定（既定 undefined）→ timeout で止まらず続行する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorTimeoutMinutes: undefined });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // in_progress（経過いくら長くても止まらない）→ done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-01T00:00:00.000Z" }); // 何日も前
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // timeout 未設定なので in_progress では止まらず、done→merged で完走
    expect(s.state).toBe("merged");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "not_engaged ガード / monitor_timeout"
```

期待: 全 green。落ちたら `elapsedMinutesSinceMonitorStart` が `getSession(id).monitorStartedAt` を毎回読み直す（再起動でリセットしない＝store 由来）こと、`not_engaged` は `> guard`、`in_progress` は `timeout !== undefined && > timeout` の比較になっていることを確認する。

- [ ] **Step 7: poll() throw のバックオフ（5 連続失敗で stopped(exception)）と回復（4 回失敗後に成功で続行）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`h.sleepCalls` で poll 間隔のバックオフ（×2..×8 クランプ）も検証する:

```typescript
describe("Orchestrator 失敗系 — poll throw バックオフ（仕様 §5.5 / カーネル §7.6）", () => {
  it("poll が 5 連続で throw → stopped(exception, 'monitor poll failed 5x: ...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // verdicts は使わず poll を常に throw させる
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      throw new Error("gh api 502");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("monitor poll failed 5x");
    expect(s.stopDetail).toContain("gh api 502");
    // poll は 5 回呼ばれた
    expect(h.monitor.pollCalls).toHaveLength(5);
    // バックオフ: 1回目 sleep=60000、以降 ×2..×8 クランプ。MONITOR の sleep だけ抜き出す。
    // 各反復先頭で sleep(pollIntervalMs * backoffMultiplier)。
    // multiplier 列: 1,2,4,8,8 → sleep 列: 60000,120000,240000,480000,480000
    // （このテストは IDLE に入らない＝queue 1 件・taskCap 3 のため、MONITOR の sleep のみ）
    const base = config.loop.monitorPollSeconds * 1000;
    const monitorSleeps = h.sleepCalls.filter((ms) => ms % base === 0 && ms >= base);
    expect(monitorSleeps.slice(0, 5)).toEqual([
      base * 1,
      base * 2,
      base * 4,
      base * 8,
      base * 8, // ×8 でクランプ
    ]);
  });

  it("poll が 4 回 throw 後に成功（done→merged）→ 停止せず完走し、バックオフは成功でリセットされる", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];

    let n = 0;
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      n += 1;
      if (n <= 4) throw new Error("transient 503");
      if (n === 5) return { kind: "done" };
      return { kind: "merged" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 4 連続失敗（<5）なので停止せず、5 回目 done → 6 回目 merged で完走
    expect(s.state).toBe("merged");
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(6);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "poll throw バックオフ"
```

期待: green。落ちたら Task 12 の `monitorSession()` の `pollFailures`/`backoffMultiplier` 制御（`>= 5` で stopped・成功で両者リセット・`Math.min(backoffMultiplier*2, 8)`）を確認する。

- [ ] **Step 8: MONITOR/poll 失敗系テストをコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator monitor verdict mapping, guards, timeout, poll backoff"
```

- [ ] **Step 9: merge readiness 分岐（ci_failed / conflict / blocked / ci_pending 続行）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`done` verdict → `checkMergeReadiness` の readiness を `h.monitor.readiness` で差し替える:

```typescript
describe("Orchestrator 失敗系 — merge readiness 分岐（仕様 §5.5 / §5.4 readiness / カーネル §7.6）", () => {
  it("done → readiness ci_failed → stopped(ci_failed, detail=null)。mergePr は呼ばれない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "ci_failed" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBeNull();
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness conflict → stopped(merge_conflict)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "conflict" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_conflict");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness blocked → stopped(ci_failed, detail='merge blocked by branch protection...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "blocked" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // blocked は failureReason=ci_failed（カーネル §7.6）に写像
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toContain("merge blocked by branch protection");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness ci_pending を 1 回 → 次 poll で done→ready→merge し、停止せず完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged。readiness: 1回目 ci_pending、2回目 ready
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_pending" };
      return { ready: true, headSha: "sha-100" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ci_pending では止まらず、2 回目の done で ready→merge→次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "merge readiness 分岐"
```

期待: green。落ちたら Task 12 の `tryMerge()` の readiness switch（ci_pending/unknown→continue、ci_failed→stopped(ci_failed)、conflict→stopped(merge_conflict)、blocked→stopped(ci_failed, 既定文言)）を仕様 §7.6 と突き合わせる。

> 注: Step 10 で `tryMerge` の戻り値を判別共用体（`{ kind: ... }`）へ変える。本 Step のテストは `mergePr` 呼び出しの有無と最終 state を検証しているだけなので Step 10 後も不変（halt/continue 経路を引き続き通る）。

- [ ] **Step 10: 【コード変更】`tryMerge` を「throw を区別して返す」形に直し、`monitorSession` で mergePr 2 連続 throw を fail-closed にする（red→green）**

> **設計ノート（仕様 §6 「HEAD移動なら見送り（次ポーリング）」と mergePr fail-closed の対応）:** 仕様 §6 のマージ手順は `gh pr merge <pr> --squash --match-head-commit <sha>` であり、「HEAD移動・CI未完なら見送り（次ポーリング）」と規定する。実装上、**§6 の HEAD 移動見送りは `--match-head-commit` の失敗（HEAD が `<sha>` から動いたことで gh が非0終了）= `mergePr` の throw として現れる**。本セクションの fail-closed はこれと整合する: ready verdict 下で mergePr が **1 回目** throw したときは即停止せず次ポーリングで poll→done→`checkMergeReadiness` を再評価する（=§6 の「見送り」。HEAD が動いていれば readiness の headSha が更新され、CI 未完なら ci_pending で続行）。**ready のまま 2 連続** throw したときのみ fail-closed(ci_failed) する。すなわち「HEAD 移動 1 回 → 次ポーリング再評価 ready → mergePr 成功 → merged」が §6 の正常な回復経路であり、下の 3 つ目の it() がそれを固定する。

まず**失敗するテスト**を `tests/orchestrator.test.ts` に追記する（現状の Task 12 実装では `mergePr` throw を握って永遠に続行するため、2 連続でも停止せず別の停止理由で落ちる＝このテストは red）:

```typescript
describe("Orchestrator 失敗系 — mergePr 2 連続 throw fail-closed（カーネル §7.6）", () => {
  it("ready のまま mergePr が 2 連続 throw → stopped(ci_failed, 'merge call failed under ready verdict: <error>')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll は done を返し続ける（要素 1 → 同じ verdict を維持）。readiness は常に ready（既定）。
    h.monitor.verdicts = [{ kind: "done" }];
    // mergePr を毎回 throw させる
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      throw new Error("gh: merge failed 422");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // 2 連続失敗で fail-closed（既定理由 ci_failed）
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBe("merge call failed under ready verdict: gh: merge failed 422");
    // mergePr は ちょうど 2 回呼ばれて停止（1 回目は続行、2 回目で fail-closed）
    expect(mergeCalls).toBe(2);
  });

  it("mergePr が 1 回 throw → 次 poll(done→ready) で成功 → 完走する（カウンタは成功でリセット）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      if (mergeCalls === 1) throw new Error("transient 500");
      // 2 回目は成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回失敗 → 2 回目成功 → 次 poll merged で完走（2 連続には達しない）
    expect(s.state).toBe("merged");
    expect(mergeCalls).toBe(2);
  });

  it("§6 HEAD 移動見送り: --match-head-commit 失敗で 1 回 throw → 次ポーリングで readiness 再評価 ready → mergePr 成功 → merged", async () => {
    // 仕様 §6: HEAD 移動なら見送り（次ポーリング）。実装では --match-head-commit 失敗が mergePr の throw として現れ、
    // 1 回目は次ポーリングで done→checkMergeReadiness を再評価する（mergeFailures=1、2 連続未満なので fail-closed しない）。
    // 再評価で新しい headSha の ready が返り、その sha で mergePr が成功 → merged で回復する。
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done（1 回目 merge 試行）→ done（再評価して成功）→ merged（DONE へ）
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];

    // readiness は毎回 ready だが headSha が HEAD 移動で変わる: 1 回目 sha-stale → 2 回目 sha-fresh
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      return readinessCall === 1
        ? { ready: true, headSha: "sha-stale" }
        : { ready: true, headSha: "sha-fresh" };
    };

    // mergePr は --match-head-commit に相当: 渡された headSha が現在の HEAD（sha-fresh）と異なれば throw（HEAD 移動）。
    const mergeShas: string[] = [];
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      mergeShas.push(headSha);
      if (headSha !== "sha-fresh") {
        throw new Error("gh: head commit moved (--match-head-commit failed)");
      }
      // sha-fresh では成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回目 sha-stale で throw（見送り）→ 2 回目 sha-fresh で成功 → 次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    // mergePr は 2 回呼ばれ、stale→fresh の順。2 連続失敗には達しないので fail-closed しない。
    expect(mergeShas).toEqual(["sha-stale", "sha-fresh"]);
    // 成功した sha で DONE 経路に入る
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-fresh"] });
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/orchestrator.test.ts -t "mergePr 2 連続 throw fail-closed"
```

期待される失敗（3 ケース中 1 件目で red）: 1 件目のテストで `s.failureReason` が `ci_failed` にならず（Task 12 実装は throw を握って "continue" を返し続けるため）、別経路（poll の verdict 切れ等）で停止し `expect(s.failureReason).toBe("ci_failed")` が落ちる。2 件目（1 回失敗→成功）と 3 件目（§6 HEAD 移動見送り→回復）は Task 12 実装でも green になり得る（throw を握って続行するため結果的に回復する）が、1 件目が red であることを確認する。

次に **コードを直す**。`src/orchestrator.ts` の `monitorSession` の `case "done"` ブロックと `tryMerge` を以下のとおり置き換える。

(a) `monitorSession` 内ループ冒頭付近の Task 12 の宣言:

```typescript
    let pollFailures = 0;
    let backoffMultiplier = 1;
```

を次に置き換える（**マージ連続失敗カウンタ**を 1 つ足す）:

```typescript
    let pollFailures = 0;
    let backoffMultiplier = 1;
    let mergeFailures = 0; // ready verdict 下での mergePr 連続失敗（2 連続で fail-closed）
```

(b) Task 12 の `case "done"` ブロック:

```typescript
        case "done": {
          const ctrl = await this.tryMerge(session, prNumber);
          if (ctrl === "merged") return CONTINUE;
          if (ctrl === "halt") return HALT;
          continue; // 続行（次ポーリング）
        }
```

を次に置き換える:

```typescript
        case "done": {
          const outcome = await this.tryMerge(session, prNumber);
          if (outcome.kind === "merged") return CONTINUE;
          if (outcome.kind === "halt") return HALT;
          if (outcome.kind === "merge_failed") {
            // ready verdict のまま mergePr が throw。2 連続で fail-closed（カーネル §7.6）。
            mergeFailures += 1;
            if (mergeFailures >= 2) {
              return await this.stopSession(
                session,
                "ci_failed",
                `merge call failed under ready verdict: ${outcome.error}`,
              );
            }
            continue; // 1 回目は次ポーリングで再評価
          }
          // outcome.kind === "continue"（readiness が ci_pending/unknown 等）
          mergeFailures = 0; // ready 連続を断ち切る事象が起きたらリセット
          continue;
        }
```

(c) Task 12 の `tryMerge` 全体:

```typescript
  /** done verdict 時のマージ試行。"merged" | "continue" | "halt" を返す */
  private async tryMerge(session: TaskSessionRow, prNumber: number): Promise<"merged" | "continue" | "halt"> {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return "continue";
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return "halt";
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return "halt";
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return "halt";
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return "merged";
    } catch {
      // 次ポーリングで再評価（mergePr 連続失敗の fail-closed は Task 13 で精密化）
      return "continue";
    }
  }
```

を次に置き換える（戻り値を判別共用体にし、throw を `merge_failed` として上へ返す）:

```typescript
  /**
   * done verdict 時のマージ試行（カーネル §7.6）。
   * - readiness が ready でなければ reason ごとに分類（ci_pending/unknown→continue、その他は stopSession→halt）。
   * - ready なら mergePr。成功→merged。throw→merge_failed（連続回数の判定は monitorSession 側）。
   */
  private async tryMerge(
    session: TaskSessionRow,
    prNumber: number,
  ): Promise<
    | { kind: "merged" }
    | { kind: "continue" }
    | { kind: "halt" }
    | { kind: "merge_failed"; error: string }
  > {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return { kind: "continue" };
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return { kind: "halt" };
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return { kind: "halt" };
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return { kind: "halt" };
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return { kind: "merged" };
    } catch (err) {
      return { kind: "merge_failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
```

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts -t "mergePr 2 連続 throw fail-closed"
```

期待: 3 ケースとも green（fail-closed 2 連続停止 / 1 回失敗→回復 / §6 HEAD 移動見送り→回復）。§6 HEAD 移動見送りのケースは、1 回目 throw で `mergeFailures=1`（2 連続未満）→ `continue`（次ポーリング）→ 再 poll done で readiness 再評価 → 新 headSha(sha-fresh) で `mergePr` 成功 → merged、という回復経路をたどる。`tryMerge` の戻り値型変更は `monitorSession` の `case "done"` 以外から参照されないため他テストに波及しない（Step 9 の readiness 分岐テストも `outcome.kind === "halt"`/`"continue"` 経路を通り引き続き green）。

- [ ] **Step 11: `npm run check` で型・全テスト green を確認し、merge fail-closed をコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`tryMerge` の戻り値が判別共用体に変わったため、`monitorSession` の `case "done"` で `outcome.kind` を網羅していること（merged/halt/merge_failed/continue）を tsc が保証する。

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: fail-closed STOPPED(ci_failed) after two consecutive mergePr throws under ready verdict"
```

- [ ] **Step 12: DONE の transition 3 回失敗でも HALT せず継続（警告ログ・Run=running 維持）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`transition(done)` だけを失敗させたいので、`source.transition` をフックして state==="done" のときだけ throw させる:

```typescript
describe("Orchestrator 失敗系 — DONE transition 失敗でも継続（仕様 §5.6 / カーネル §7.7）", () => {
  it("transition(done) が 3 回失敗しても HALT せず警告ログのみ・merged は永続化・次 SELECT へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // transition(done) のみ常に throw（in_progress/in_review は通す）
    const orig = h.source.transition.bind(h.source);
    let doneAttempts = 0;
    h.source.transition = async (issueId: string, state) => {
      if (state === "done") {
        doneAttempts += 1;
        throw new Error("Linear timeout");
      }
      return orig(issueId, state);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // merged は永続化される（DONE は merged 先に永続化 → transition は best-effort）
    expect(s.state).toBe("merged");
    expect(s.endedAt).not.toBeNull();
    expect(h.store.countMerged(run.id)).toBe(1);
    // transition(done) は retry 3 回試みた
    expect(doneAttempts).toBe(3);
    // HALT していない：halted は taskCap 到達由来のみ（looppilot_stopped/exception ではない）
    expect(run.state).toBe("halted"); // taskCap=1 到達で最終的に halted
    expect(run.haltReason).toContain("task cap reached");
    // 通知列に「失敗由来の halted」は無い（run_started → halted(task_cap) のみ）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ reason: "task_cap" });
    // 警告ログが出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("transition(done) failed"))).toBe(true);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "DONE transition 失敗でも継続"
```

期待: green。落ちたら Task 12 の `done()` が `retry(3, transition(done))` を try で囲み catch で `log(warning)` のみ・`stopSession` を**呼ばない**（HALT しない）ことを確認する。最終 halted は taskCap=1 到達由来であって failure 由来ではない点に注意（カーネル §7 ステップ 7：DONE の transition 失敗は HALT しない）。

- [ ] **Step 13: STOPPED 共通処理（costUsd 保存・notify(halted)・Run=halted）の不変条件テストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。任意の停止経路（ここでは cost_exceeded）で「セッション=stopped＋failureReason＋endedAt」「Run=halted＋haltReason」「notify(halted) 1 回」が同時に成り立つことを固定する:

```typescript
describe("Orchestrator 失敗系 — STOPPED 共通処理の不変条件（仕様 §7 STOPPED⇒HALT 1:1 / カーネル §7 末尾）", () => {
  it("stopSession を通る経路では『session=stopped+costUsd 保存』『Run=halted』『notify(halted) 1 回』が同時に成立する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 8 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // cost_exceeded 経路（costUsd が判明している経路では併せて保存される）
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 8.0 }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // セッション側
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(8.0); // costUsd 併せて保存（カーネル §7 STOPPED 共通処理）
    expect(s.endedAt).not.toBeNull();
    // Run 側（TaskSession=stopped ⇒ Run=halted の 1:1）
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("cost_exceeded");
    expect(run.haltReason).toContain("TY-1");
    // notify(halted) はちょうど 1 回
    const haltedEvents = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltedEvents).toHaveLength(1);
    expect(haltedEvents[0]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
    // 失敗後はループを脱出し、次の SELECT を試みない（getNextEligible は 1 回だけ）
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("MONITOR 中（in_review→merged 完走）にオーケは PR/ブランチへ書き込まない（マージのみ例外・仕様 §5.5/§4）", async () => {
    // 仕様 §4/§5.5 の不変条件: MONITOR 中はオーケが PR/ブランチへ書き込まない（LoopPilot を唯一の書き手とし、mergePr のみ例外）。
    // 正常完走（done→merged）を回し、monitorSession 突入後の Git/PR 呼び出しが mergePr 以外の書き込み系を含まないことを固定する。
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");

    // 全 Git/PR 書き込み系メソッド（FakeGitPr.calls は { method, args } 形式）
    const writeMethods = ["pushAndOpenPr", "addLabel", "prepareWorktree", "discardWorktree"];
    // monitorSession 突入以降に書き込み系が一切呼ばれていないことを確認する。
    // CLAIM/HANDOFF で prepareWorktree/pushAndOpenPr/addLabel は MONITOR 突入「前」に呼ばれ済みなので、
    // 突入の境界＝最後の addLabel（HANDOFF 末尾の書き込み）以降のスライスを見る。
    const lastHandoffWriteIdx = h.git.calls.map((c) => c.method).lastIndexOf("addLabel");
    expect(lastHandoffWriteIdx).toBeGreaterThanOrEqual(0); // HANDOFF で addLabel は呼ばれている
    const afterMonitor = h.git.calls.slice(lastHandoffWriteIdx + 1);
    // MONITOR 中の書き込み系（pushAndOpenPr/addLabel/prepareWorktree/discardWorktree）は 0 件
    expect(afterMonitor.filter((c) => writeMethods.includes(c.method))).toEqual([]);
    // マージのみ例外として許される
    expect(afterMonitor.map((c) => c.method)).toContain("mergePr");

    // 念のため全期間でも: prepareWorktree/pushAndOpenPr/addLabel は各 1 回（CLAIM/HANDOFF のみ）、
    // discardWorktree は 0 回（正常完走では破棄しない）、mergePr は 1 回。
    const counts = (m: string): number => h.git.calls.filter((c) => c.method === m).length;
    expect(counts("prepareWorktree")).toBe(1);
    expect(counts("pushAndOpenPr")).toBe(1);
    expect(counts("addLabel")).toBe(1);
    expect(counts("discardWorktree")).toBe(0);
    expect(counts("mergePr")).toBe(1);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "STOPPED 共通処理の不変条件"
```

期待: 2 ケースとも green（STOPPED 共通不変条件 1 ケース + MONITOR 書き込み不変条件 1 ケース）。後者はコード変更なしの既 green 確認（Task 12 の monitorSession は `mergePr` 以外の書き込み系を呼ばない設計）。落ちたら Task 12 の `stopSession()`（updateSession(stopped, failureReason, stopDetail, endedAt, extraPatch.costUsd) → notify(halted) → setRunState(halted) → return HALT）と、`run()`/`loop()` が HALT で `return` してループを抜けること、および `monitorSession`/`tryMerge` が MONITOR 中に `pushAndOpenPr`/`addLabel`/`prepareWorktree`/`discardWorktree` を呼ばない（マージのみ例外）ことを仕様 §4/§5.5 と突き合わせる。MONITOR 中に書き込み系が呼ばれていたら仕様 §5.5 違反として openQuestions に上げる（勝手に直さない）。

- [ ] **Step 14: MONITOR/merge/DONE/STOPPED 系テストをコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator merge readiness, DONE best-effort, STOPPED invariants"
```

- [ ] **Step 15: 【コード変更】SIGINT/停止要求フラグを Orchestrator に追加（red→green）**

まず**失敗するテスト**を `tests/orchestrator.test.ts` に追記する（現状 `Orchestrator` に `requestStop` が無いため、tsc が型エラーで red）:

```typescript
describe("Orchestrator 安全弁 — SIGINT/停止要求フラグ（仕様 §11 / カーネル §7 末尾）", () => {
  it("requestStop() を実装フェーズで立てると、現フェーズ群完了後の次の安全点で Run=halted(user_interrupt) して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A ok" },
      { kind: "completed", costUsd: 1, summary: "B ok" },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    // 1 件目の IMPLEMENT 中に停止要求を立てる（次の安全点まで現フェーズ群は完了させる）
    const origRun = h.agent.runSession.bind(h.agent);
    let agentCalls = 0;
    h.agent.runSession = async (ctx) => {
      agentCalls += 1;
      if (agentCalls === 1) h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // 1 件目は現フェーズ群を完走して merged になる（安全点までは止めない）
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].state).toBe("merged");
    // 2 件目は着手しない（次反復先頭の安全点で停止）
    expect(h.agent.contexts).toHaveLength(1);
    // Run=halted、理由は user_interrupt
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    // 通知列: run_started → halted(user_interrupt)。失敗 stopped ではない（セッションは merged）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });

  it("requestStop() 後でも進行中セッションは stopped にならず merged のまま（クリーン停止）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const origRun = h.agent.runSession.bind(h.agent);
    h.agent.runSession = async (ctx) => {
      h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 現セッションは完走（merged）。stopped にしない。
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.store.latestRun()!.haltReason).toContain("user_interrupt");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/orchestrator.test.ts -t "SIGINT/停止要求フラグ"
```

期待される失敗: tsc が `Property 'requestStop' does not exist on type 'Orchestrator'` を報告（`npm run check` の tsc-test 段、または vitest 実行時に `h.orch.requestStop is not a function`）。

次に **コードを直す**。`src/orchestrator.ts` の `Orchestrator` クラスに以下を追加する。

(a) フィールド宣言。Task 12 の `private runId = 0;` の直後に 1 行足す:

```typescript
  private runId = 0;
  private interrupted = false; // SIGINT 等の停止要求（次の安全点で halt）
```

(b) public メソッド `requestStop` を追加する。`run()` メソッドの直前（コンストラクタの後）に挿入する:

```typescript
  /** 停止要求を立てる（SIGINT ハンドラ等から呼ぶ）。次の安全点でクリーン halt する。 */
  requestStop(): void {
    this.interrupted = true;
  }
```

(c) 安全点チェックを `loop()` に挿入する。Task 12 の `loop()` の while 冒頭、タスク上限チェックの**直前**に停止要求の確認を足す。Task 12 の:

```typescript
  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
```

を次に置き換える:

```typescript
  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 0) 停止要求の安全点（各反復先頭。現フェーズ群完了後にここへ戻る）
      if (this.interrupted) {
        this.haltForInterrupt();
        return;
      }

      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
```

(d) 停止要求の共通 halt ヘルパ `haltForInterrupt` を追加する。`stopSession` メソッドの直後に挿入する（クラス内・private）:

```typescript
  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。 */
  private haltForInterrupt(): void {
    const detail = "user_interrupt: stop requested; halting at safe point";
    this.store.setRunState(this.runId, "halted", detail);
    void this.notifier.notify({ kind: "halted", reason: "user_interrupt", detail });
    this.log(detail);
  }
```

> 設計注: `haltForInterrupt` は同期メソッドにして `loop()` から同期的に `return` させ、ロック解放（`run()` の finally）へ即進む。通知の確実性より「安全点での即時停止」を優先し、`notify` は fire-and-forget（`void`）とする。FakeNotifier は同期 push なのでテストでは確定的に記録される。Slack 配信の確実性は通知 intent（Store）側が担保する設計（カーネル §10 / §4 notification_intent）であり、ここで await しないことは仕様と矛盾しない。HALT 理由語彙は `Run.haltReason`（自由文字列。`FailureReason` enum とは別）なので `"user_interrupt"` の文字列を使うのは型上問題ない。

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts -t "SIGINT/停止要求フラグ"
```

期待: 両テスト green。1 件目は IMPLEMENT 中に `requestStop()` を立てても現セッションは MONITOR/DONE まで完走し（安全点は次反復の先頭）、2 件目着手前の安全点で `haltForInterrupt`→`return`。セッションは merged のまま・Run=halted(user_interrupt)。

- [ ] **Step 16: `npm run check` で型・全テスト green を確認し、SIGINT フラグをコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`requestStop`/`interrupted`/`haltForInterrupt` 追加で既存正常系テスト（Task 12）に波及しないこと（`interrupted` 既定 false なので安全点は素通し）を確認する。

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: SIGINT-driven clean halt at next safe point (requestStop)"
```

- [ ] **Step 17: 失敗系の網羅性を確認する最終 `npm run check` と仕上げコミット**

```
npm run check
```

期待: 全 green。本タスクで追加した失敗系 describe（CLAIM ①②／IMPLEMENT 5 ケース／HANDOFF 2 ケース／MONITOR verdict 写像 4 ケース／not_engaged・timeout 4 ケース／poll backoff 2 ケース／merge readiness 4 ケース／mergePr fail-closed 3 ケース［2 連続停止／1 回で回復／§6 HEAD 移動見送り→回復］／DONE 継続 1 ケース／STOPPED 不変条件 1 ケース＋MONITOR 書き込み不変条件 1 ケース／SIGINT 2 ケース）が全て pass。カーネル §7 の各失敗経路と仕様 §4/§5.5/§6 の不変条件が 1 つ以上のテストで固定されていること。

未コミット差分があれば:

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "chore: finalize Orchestrator failure-path and safety-valve coverage"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` の `tryMerge` が判別共用体（`merged`/`continue`/`halt`/`merge_failed`）を返し、`monitorSession` が `ready` verdict 下での `mergePr` **2 連続 throw** で `stopped(ci_failed, "merge call failed under ready verdict: <error>")` に fail-closed する（カーネル §7.6）。
- `src/orchestrator.ts` が public `requestStop()` を持ち、`interrupted` フラグを各反復先頭の安全点で見て `haltForInterrupt()`（Run=halted(user_interrupt)・notify(halted)・進行中セッションは stopped にしない）→ ループ脱出する（カーネル §7 末尾）。
- `tests/orchestrator.test.ts` がカーネル §7 の全失敗経路を固定する: CLAIM ①（セッション行なし HALT）／②（discardWorktree+stopped(claim_failed)+todo 復帰）、agent_no_change（未コミット残骸／無差分の 2 形）、cost_exceeded（discardWorktree 順）、exception（error outcome／runSession throw）、handoff_failed（PR 番号明記／PR 未作成）、looppilot_stopped（stopReason あり／null）、pr_closed、corrupted（即停止）、monitor_never_engaged（not_engaged ガード経過）、monitor timeout（設定時／未設定時）、poll throw バックオフ（5 連続停止／4 回後回復）、merge readiness（ci_failed／conflict／blocked／ci_pending 続行）、mergePr 2 連続 throw fail-closed（停止／1 回で回復／§6 HEAD 移動見送り→回復）、DONE transition 3 回失敗でも継続、STOPPED 共通不変条件、SIGINT 安全点停止。
- 仕様 §4/§5.5/§6 の不変条件をテストで固定する: MONITOR 中はオーケが PR/ブランチへ書き込まない（`mergePr` のみ例外。monitorSession 完走後の `FakeGitPr` コール記録が `pushAndOpenPr`/`addLabel`/`prepareWorktree`/`discardWorktree` を含まない）、および §6 HEAD 移動見送り（`--match-head-commit` 失敗の throw → 1 回目は次ポーリングで readiness 再評価 → ready なら新 headSha で `mergePr` 成功 → merged の回復経路）。
- 全テストは `fixedClock`/`instantSleep`＋テスト内の `monitorStartedAt` 上書きで時間決定的。`vi.mock` 不使用（フェイクのメソッド差し替えのみ）。
- `npm run check` が green。
- 既存シンボル（`Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness`/`Harness`）は再定義せず Modify した。


---

### Task 14: クラッシュ回復

**目的**: Task 12 が空実装（no-op）として置いた `Orchestrator.recoverPendingSessions()` の中身を実装し、カーネル §8（仕様 §9）の起動時クラッシュ回復を網羅する。再起動時に `store.activeSessions()`（merged/stopped 以外・全 run 横断）を走査し、`in_review`+PR は `monitor.poll` の verdict で分岐、`claimed`/`implementing`/`handing_off` は `findOpenPrForBranch` の有無で採用 or HALT、孤児チケットは Todo へベストエフォート復帰する。採用したセッションは新 Run へ runId を付替えて MONITOR→DONE を回し、tasks_started に数えられ上限と比較される。回復で HALT したらループに入らない。

**依存タスク**:
- Task 12（`src/orchestrator.ts` の `Orchestrator`・`OrchestratorDeps`・`loop`/`claim`/`implement`/`handoff`/`monitorSession`/`tryMerge`/`done`/`stopSession`/`elapsedMinutesSinceMonitorStart`、private `recoverPendingSessions()` の no-op 定義、module-private `errMsg`/`bestEffort`/`retry`、`RunControl`/`CONTINUE`/`HALT`。`tests/fakes.ts` の `FakeTaskSource`/`FakeAgentRunner`/`FakeGitPr`/`FakeMonitor`/`FakeNotifier`、`tests/orchestrator.test.ts` の `makeConfig`/`issue`/`makeHarness`/`Harness`）。本タスクは **`recoverPendingSessions()` を Modify（no-op → 実装）し、ヘルパを追記**する。`Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness` は再定義しない。
- Task 13（`src/orchestrator.ts` の `tryMerge` 判別共用体化・`mergeFailures` fail-closed・`requestStop`/`interrupted`/`haltForInterrupt`。本タスクは Task 12+13 適用後のコードを Modify する）。
- Task 2（`src/types.ts`：`MonitorVerdict`・`TaskSessionRow`・`EligibleIssue`・`FailureReason`・`NotifyEvent`）
- Task 5（`src/store.ts`：`SqliteStore`。`activeSessions`/`getSession`/`updateSession`（`runId`/`monitorStartedAt`/`prNumber`/`state` patch 可）/`knownIssueIds`/`createRun`/`createSession`/`sessionsForRun`/`countTasksStarted`/`countMerged`/`setRunState`）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/orchestrator.ts`: `Orchestrator`, `OrchestratorDeps`, private `monitorSession(session, prNumber)`, private `done(session, issue)`, private `stopSession(session, reason, detail, extraPatch)`, private `recoverPendingSessions()`（no-op）, 型 `RunControl`, 定数 `CONTINUE`/`HALT`, module-private `errMsg`（Task 12）
- `src/types.ts`: `MonitorVerdict`, `TaskSessionRow`, `EligibleIssue`, `FailureReason`, `NotifyEvent`（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/config.ts`: `Config`（型のみ。テストは `makeConfig` の `as unknown as Config` キャスト）
- `tests/fakes.ts`: `FakeTaskSource`（`orphans`/`transitions`/`failNext`）, `FakeGitPr`（`openPrForBranch`/`claimResults`/`calls`/`failNext`）, `FakeMonitor`（`verdicts`/`readiness`/`pollCalls`）, `FakeNotifier`（`events`）, `FakeAgentRunner`, `fixedClock`, `instantSleep`（Task 3/12）
- `tests/orchestrator.test.ts`: `makeConfig`, `issue`, `makeHarness`, `Harness`（Task 12）。本タスクのテストは新規ファイル `tests/recovery.test.ts` で、これらを **import せず再定義する**（独立ファイルのため。テスト用ヘルパの重複定義は許容）。

> 注: 本タスクが触る Config フィールドは Task 12/13 と同一（`safety.maxTasksPerRun`/`safety.maxCostUsdPerSession`/`safety.notEngagedGuardMinutes`/`safety.monitorTimeoutMinutes`/`loop.monitorPollSeconds`/`loop.idleRecheckSeconds`/`looppilot.gateLabel`/`product.goal`/`digest.recentMergedCount`）。新フィールドは追加しない。

---

#### このセクションが確定させる回復処理の形（実装の正・カーネル §8）

Task 12 の `run()` は `acquireRunLock → createRun → notify(run_started) → recoverPendingSessions() → loop()` の順で呼ぶ。本タスクは `recoverPendingSessions()` を実装し、**回復で HALT したら `loop()` を呼ばない**ように `run()` を 1 箇所だけ変更する。

`recoverPendingSessions()` の契約（戻り値 `RunControl`：`{control:"halt"}` なら `run()` はループを開始しない）:

1. **孤児チケット復帰を先に行う**（カーネル §8 末尾。セッション走査の前後どちらでもよいが、走査で HALT する前に孤児を Todo へ戻すと取りこぼしが無いので**先頭で実施**）: `source.findOrphanedInProgress(store.knownIssueIds())` → 各 issue を `source.transition(todo)` ベストエフォート + コンソール警告ログ。`findOrphanedInProgress` 自体の throw もベストエフォート（警告して継続）。

2. **`store.activeSessions()` を走査**（merged/stopped 以外・全 run 横断・id ASC）。各セッション `s` を state で分岐:

   - **`in_review` ∧ `prNumber != null`**: `monitor.poll(s.prNumber)` の verdict で分岐（生 gh は使わず注入済み monitor で照合）:
     - `merged` → **DONE 後段**（`s` の runId を新 Run へ付替え → `done(...)` 相当：`updateSession({state:"merged", endedAt})` → `transition(done)` best-effort）。カウンタは導出なので二重計上しない。**HALT しない**（merged は成功終端）。
     - `pr_closed` → `stopSession(s, "pr_closed", null)` → HALT。
     - `stopped` → `stopSession(s, "looppilot_stopped", stopReason ?? "looppilot stopped (no reason)")` → HALT。
     - **それ以外**（`done`/`in_progress`/`corrupted`/`not_engaged` = open 扱い）→ **採用**：runId を新 Run へ付替え（`updateSession(s.id, { runId: this.runId })`）→ `monitorSession(s, s.prNumber)` を即時実行（MONITOR 再開）。`monitor_started_at` は**上書きしない**（ガード/timeout の経過を継続）。MONITOR が halt を返したら回復全体を HALT。merged まで進んだら DONE 後段（`done`）を実行。
   - **`in_review` ∧ `prNumber == null`**（PR 永続化前に in_review にした異常／理論上起きにくい）: `claimed`/`implementing`/`handing_off` と同じ「open PR 探索」経路へフォールバック（後述）。
   - **`claimed` / `implementing` / `handing_off`**: `findOpenPrForBranch(s.branch)`:
     - ヒット（`prNumber != null`）→ `updateSession(s.id, { runId: this.runId, prNumber, state:"in_review", monitorStartedAt: s.monitorStartedAt ?? this.clock() })` → 採用・`monitorSession(...)`→merged で `done`。
     - ミス（`null`）→ `stopSession(s, "exception", "crash recovery: no open PR; manual cleanup: <branch>, <worktree>, <identifier>")` → notify(halted)（`stopSession` が出す）→ **HALT**（手動掃除を促す）。

3. **採用セッションは tasks_started に数えられる**：runId を新 Run に付替えるため `countTasksStarted(newRunId)` が +1 され、`loop()` のタスク上限チェックの比較対象になる。

4. **回復で 1 つでも HALT に至ったら `{control:"halt"}` を返す**（以降の active セッションは処理しない）。全て成功裏に採用/完走したら `{control:"continue"}`。

回復は `monitorSession`/`done`/`stopSession` を**再利用**する（重複実装しない）。`monitorSession`/`stopSession` は `session.id` で store を読み直す（`elapsedMinutesSinceMonitorStart` も `getSession(id)` 由来）ため、runId 付替え後の最新行で正しく動く。`done(session, issue)` は `issue.id`（transition）と `issue.identifier`（ログ）しか使わないので、回復ではセッション行から最小 `EligibleIssue` を再構成して渡す（`reconstructIssue(s)` ヘルパ）。

---

#### Files

- **Modify**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`（`recoverPendingSessions()` の no-op → 実装、private ヘルパ `recoverInReview`/`recoverByOpenPr`/`adoptAndMonitor`/`recoverDone`/`reconstructIssue` を追記、`run()` の `recoverPendingSessions()` 呼び出しを「halt なら return」に変更）
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/recovery.test.ts`（新規）

---

#### Step-by-step（TDD）

- [ ] **Step 1: `tests/recovery.test.ts` を新規作成し、最初の失敗するテスト（in_review+PR が merged → DONE 後段・二重計上なし）を書く**

`tests/recovery.test.ts` を新規作成する（この時点で `recoverPendingSessions()` は no-op なので、回復が何もせず active セッションを放置 → アサーションが落ちて red）。テスト用ヘルパ（`makeConfig`/`issue`/`makeHarness`）は独立ファイルのため本ファイル内に再定義する（完全形）:

```typescript
import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, TaskSessionRow } from "../src/types.js";

// ---- テストヘルパ（Task 12 の makeConfig/issue/makeHarness と同形・独立ファイルのため再定義） ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number | undefined;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product" },
    digest: { recentMergedCount: over.recentMergedCount ?? 5 },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
  } as unknown as Config;
}

function issue(id: string, identifier: string, over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id,
    identifier,
    title: over.title ?? `Title for ${identifier}`,
    description: over.description ?? "",
    priority: over.priority ?? 2,
    sortOrder: over.sortOrder ?? 0,
    url: over.url ?? `https://linear.app/issue/${identifier}`,
  };
}

interface Harness {
  orch: Orchestrator;
  store: SqliteStore;
  source: FakeTaskSource;
  agent: FakeAgentRunner;
  git: FakeGitPr;
  monitor: FakeMonitor;
  notifier: FakeNotifier;
  sleepCalls: number[];
  logs: string[];
  promptArgs: PromptArgs[];
}

function makeHarness(config: Config): Harness {
  const store = new SqliteStore(":memory:");
  const source = new FakeTaskSource();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const monitor = new FakeMonitor();
  const notifier = new FakeNotifier();
  const sleepInner = instantSleep();
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    await sleepInner(ms);
  };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const promptArgs: PromptArgs[] = [];
  const buildPrompt = (args: PromptArgs): string => {
    promptArgs.push(args);
    return `PROMPT for ${args.issue.identifier}`;
  };
  const orch = new Orchestrator({
    config,
    source,
    agent,
    git,
    monitor,
    notifier,
    store,
    buildPrompt,
    clock: fixedClock("2026-06-05T00:00:00.000Z"),
    sleep,
    log,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs };
}

/**
 * 前回 Run のクラッシュ状態を仕込むヘルパ。
 * 旧 Run を作り、その下に active セッション 1 行を作って指定 state へ進める。
 * 返り値は仕込んだセッション行（最新値）。
 */
function seedCrashedSession(
  store: SqliteStore,
  patch: Partial<TaskSessionRow> & { state: TaskSessionRow["state"] },
  over: Partial<{ linearIssueId: string; linearIdentifier: string; branch: string; worktreePath: string }> = {},
): TaskSessionRow {
  const oldRun = store.createRun(3, "2026-06-04T00:00:00.000Z");
  const s = store.createSession({
    runId: oldRun.id,
    linearIssueId: over.linearIssueId ?? "issue-A",
    linearIdentifier: over.linearIdentifier ?? "TY-1",
    issueTitle: "Crashed task",
    branch: over.branch ?? "looppilot/ty-1-x",
    worktreePath: over.worktreePath ?? "/wt/ty-1",
    now: "2026-06-04T00:00:01.000Z",
  });
  store.updateSession(s.id, patch);
  return store.getSession(s.id);
}

describe("回復 — in_review + PR が merged（仕様 §9 / カーネル §8: DONE 後段・二重計上なし）", () => {
  it("再起動時 in_review+PR で monitor.poll が merged → merged 永続化 + transition(done)・新 Run の merged_count=1", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 前回クラッシュ: in_review・PR #100・監視起点あり
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 起動後キューは空（回復のみで完結、その後 IDLE→…だが taskCap で止める設計確認のため queue 空）
    h.source.queue = [];
    // 回復で poll は 1 回呼ばれ merged を返す
    h.monitor.verdicts = [{ kind: "merged" }];
    // 回復後ループで getNextEligible は null → IDLE → だが taskCap=3 未到達で sleep ループに入る。
    // それを避けるため回復完了直後にループへ入らせない: queue 空 + idle を 1 回で抜けられないので、
    // ここでは「回復処理単体の効果」を検証するため、回復後ループに入る前提で merged を確認する。
    // ループ無限化を防ぐため getNextEligible を 1 回 null 後に requestStop で抜ける。
    let getCalls = 0;
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      getCalls += 1;
      h.orch.requestStop(); // 回復後ループの最初の安全点で停止
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 回復で採用された旧セッションは新 Run へ付替えられ merged になっている
    const adopted = h.store.getSession(crashed.id);
    expect(adopted.state).toBe("merged");
    expect(adopted.runId).toBe(newRun.id);
    expect(adopted.endedAt).not.toBeNull();
    // DONE 後段: transition(done) が呼ばれた
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // 二重計上なし: 新 Run の merged_count は導出で 1
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // tasks_started も 1（runId 付替えで新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // 回復で HALT していない（merged は成功終端）→ ループに入っている
    expect(getCalls).toBeGreaterThanOrEqual(1);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待される失敗: `recoverPendingSessions()` が no-op のため旧セッションが `in_review` のまま残り、`adopted.state` が `"in_review"`（≠ `"merged"`）/ `countMerged(newRun.id)` が `0` で落ちる。

- [ ] **Step 2: `recoverPendingSessions()` を「ディスパッチ骨格 + in_review merged 分岐のみ」実装して Step 1 を green にする（コード変更）**

> TDD 原則（カーネル §11: テスト→失敗確認→実装→成功確認）に従い、**Step 1 の red を倒すのに必要な分岐だけ**を実装する。他の分岐（pr_closed / stopped / open 採用 / open PR ヒット・ミス / 孤児復帰の追加挙動）はこの時点では実装せず、各々の **失敗テストを先に書いた後**（Step 5/6/8/9/11/12/13）で増分実装する。未実装分岐は明示的に throw させ、テスト不在のまま「動いてしまう」状態を作らない。

`src/orchestrator.ts` の Task 12 の no-op 実装:

```typescript
  /**
   * 起動時回復（仕様 §9）。
   * 本タスク（Task 12）では活性セッション無しを前提に素通しする空実装。
   * 中身（in_review 再開 / crash 回復 / 孤児チケット復帰）は Task 14 で実装する。
   */
  private async recoverPendingSessions(): Promise<void> {
    // Task 14 で実装。現状は no-op（活性セッション無し前提）。
  }
```

を次に置き換える（**この Step では in_review merged 分岐 + ディスパッチ骨格のみ**。他分岐は後続 Step で失敗テスト先行のうえ増分実装する）:

```typescript
  /**
   * 起動時回復（仕様 §9 / カーネル §8）。
   * 1) 孤児チケット（In Progress だがセッション行なし）を Todo へベストエフォート復帰。
   * 2) activeSessions()（merged/stopped 以外・全 run 横断）を走査し state ごとに分岐:
   *    - in_review+PR: monitor.poll の verdict で merged→DONE後段 / pr_closed・stopped→停止 / その他→採用しMONITOR再開。
   *    - claimed/implementing/handing_off: findOpenPrForBranch ヒット→採用、ミス→stopped(exception)+HALT。
   * いずれかの経路が HALT に至ったら { control: "halt" } を返し、run() はループを開始しない。
   * 採用セッションは runId を新 Run へ付替えるので countTasksStarted に数えられ、上限と比較される。
   *
   * 注: 本 Step では in_review merged 分岐のみ実装。他分岐は後続 Step で失敗テスト先行で増やす。
   */
  private async recoverPendingSessions(): Promise<RunControl> {
    // 1) 孤児チケット復帰: Step 11 で失敗テスト先行のうえ実装する。現状は何もしない。

    // 2) 活性セッションの照合・採用/停止
    for (const session of this.store.activeSessions()) {
      let ctrl: RunControl;
      if (session.state === "in_review" && session.prNumber !== null) {
        ctrl = await this.recoverInReview(session, session.prNumber);
      } else {
        ctrl = await this.recoverByOpenPr(session);
      }
      if (ctrl.control === "halt") return HALT;
    }
    return CONTINUE;
  }

  /** in_review + PR の回復（カーネル §8）。poll の verdict で分岐する。 */
  private async recoverInReview(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    const verdict: MonitorVerdict = await this.monitor.poll(prNumber);
    switch (verdict.kind) {
      case "merged":
        // DONE 後段（merged 永続化 → transition(done)）。二重計上なし（導出）。HALT しない。
        this.store.updateSession(session.id, { runId: this.runId });
        await this.recoverDone(session);
        return CONTINUE;
      default:
        // pr_closed / stopped / open 扱い（done・in_progress・corrupted・not_engaged）/ poll throw は
        // それぞれ Step 5/6 で失敗テスト先行のうえ実装する。未実装の今は明示的に未対応で停止させる。
        throw new Error(`recoverInReview: verdict "${verdict.kind}" not yet implemented`);
    }
  }

  /** claimed/implementing/handing_off（および PR 番号欠落 in_review）の回復（カーネル §8）。 */
  private async recoverByOpenPr(session: TaskSessionRow): Promise<RunControl> {
    // ヒット（採用）は Step 8、ミス（stopped(exception)+HALT）は Step 9 で失敗テスト先行で実装する。
    throw new Error(`recoverByOpenPr: not yet implemented (session ${session.id})`);
  }

  /** 回復経路の DONE 後段。セッション行から最小 issue を再構成して done() を再利用する。 */
  private async recoverDone(session: TaskSessionRow): Promise<void> {
    await this.done(session, reconstructIssue(session));
  }
```

> 補足: `recoverInReview` の `switch` はこの Step では `merged` と `default` のみ。MonitorVerdict の網羅（exhaustiveness）チェックは、後続 Step で全 kind の `case` を追加し `default` を削除した時点で tsc により保証される（Step 4 では `default` があるため網羅チェックは効かない）。`adoptAndMonitor` は Step 6 で初めて必要になるため、この Step では定義しない。

実行して Step 1 の green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待: green。落ちたら `recoverInReview` の `merged` 分岐（runId 付替え → `recoverDone` → `done` が `transition(done)` を呼ぶ）と `countMerged`/`countTasksStarted` が新 runId で導出されることを確認する。

加えて、`recoverInReview` が使う型 `MonitorVerdict` を import に追加する。Task 12 の import 文:

```typescript
import type {
  TaskSource,
  AgentRunner,
  GitPrManager,
  LoopPilotMonitor,
  Notifier,
  EligibleIssue,
  TaskSessionRow,
  FailureReason,
  AgentOutcome,
  MonitorVerdict,
  PromptArgs,
} from "./types.js";
```

には `MonitorVerdict` が既に含まれている（Task 12 で import 済み）。`EligibleIssue` も含まれている。**import の変更は不要**。

最後に module-private ヘルパ `reconstructIssue` を `src/orchestrator.ts` の末尾（他の module-private helper `errMsg`/`bestEffort`/`retry` の並び）に追記する:

```typescript
/**
 * 回復経路で done()/buildPrompt に渡す最小 EligibleIssue をセッション行から再構成する。
 * done() は issue.id（transition）と issue.identifier（ログ）しか使わないため、
 * title 等は記録済みの値で埋め、未保持フィールドは安全な既定で埋める。
 */
function reconstructIssue(session: TaskSessionRow): EligibleIssue {
  return {
    id: session.linearIssueId,
    identifier: session.linearIdentifier,
    title: session.issueTitle,
    description: "",
    priority: 0,
    sortOrder: 0,
    url: "",
  };
}
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待: green。落ちたら `recoverInReview` の `merged` 分岐（runId 付替え → `recoverDone` → `done` が `transition(done)` を呼ぶ）と `countMerged`/`countTasksStarted` が新 runId で導出されることを確認する。

- [ ] **Step 3: `run()` を「回復が halt なら loop に入らない」に変更する（コード変更）**

Task 12 の `run()` の本体:

```typescript
      await this.recoverPendingSessions();
      await this.loop();
```

を次に置き換える（回復で HALT したらループを開始しない。カーネル §8 末尾）:

```typescript
      const recovery = await this.recoverPendingSessions();
      if (recovery.control === "continue") {
        await this.loop();
      }
```

> 注: `recoverPendingSessions()` が HALT を返すと、`stopSession`/`stopForRecovery` 内で既に `setRunState(halted)` + `notify(halted)` 済み。`run()` の `finally` がロックを解放する。`loop()` を呼ばないので新規 SELECT/CLAIM は起きない。

実行して既存テストへ波及がないことを確認する:

```
npx vitest run tests/recovery.test.ts
```

期待: Step 1 のテストは引き続き green（merged は continue 経路なのでループに入る）。

- [ ] **Step 4: `npm run check`（型・全テスト）green を確認してコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`recoverPendingSessions()` の戻り値型が `Promise<RunControl>` に変わり、`run()` がそれを分岐するため tsc が網羅を保証する。

> 注: この時点では `recoverInReview` の switch は `merged` + `default` のみで、`MonitorVerdict` の全 kind 網羅（exhaustiveness）はまだ効いていない（`default` が残るため）。`pr_closed`/`stopped`/open 扱いの各 `case` は後続 Step（5/6）で失敗テスト先行で追加し、最終的に `default` を削除して tsc の exhaustiveness を効かせる（Step 14 の最終 `npm run check` で全 kind 網羅を保証）。`recoverByOpenPr` はまだ throw のみ（呼ばれる経路＝Step 8/9 の seed はこの時点では存在しないため Step 1 の green を妨げない）。

```
git add src/orchestrator.ts tests/recovery.test.ts
git commit -m "feat: crash recovery — in_review+PR merged branch (Task 14)"
```

- [ ] **Step 5: in_review+PR の pr_closed / stopped(stopReason) 分岐のテストを先に書いて red 確認 → 実装で green（テスト→失敗確認→実装→成功確認）**

まず失敗テストを追記する。この時点で `recoverInReview` は `merged` 分岐しか持たず、`pr_closed`/`stopped` verdict は `default` で `throw new Error('recoverInReview: verdict "pr_closed" not yet implemented')`（resp. `"stopped"`）になる。Step 3 の `run()` は recovery 呼び出しを try/catch で包まないので throw は伝播し `run()` が reject する（=テストの `await h.orch.run()` が reject して red）。仮に上位で握り潰す実装になっていても、各テストの「セッションが `in_review` のまま・`failureReason` が `null`・期待した `stopped` 状態に達していない」アサーションで必ず red になる。

`tests/recovery.test.ts` に describe を追記する:

```typescript
describe("回復 — in_review + PR が停止系 verdict（仕様 §9 / カーネル §8）", () => {
  it("poll が pr_closed → stopped(pr_closed) + Run=halted、ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Z", "TY-9")]; // 回復で HALT すれば SELECT には進まない
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.runId).toBe(newRun.id);
    // Run=halted・回復で停止したのでループに入らず getNextEligible は呼ばれない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "pr_closed" });
  });

  it("poll が stopped(stopReason='codex gave up') → stopped(looppilot_stopped, detail=stopReason) + HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });

  it("poll が stopped(stopReason=null) → detail は既定文言へ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が停止系 verdict"
```

期待される失敗: `recoverInReview` の `default` が `throw new Error('recoverInReview: verdict "pr_closed" not yet implemented')`（resp. `"stopped"`）を投げ、`run()` がそれを伝播して 3 ケースとも reject／または握り潰し設計なら「`s.state` が `in_review` のまま・`failureReason` が `null`・Run が `halted` でない」で落ちる。これで pr_closed/stopped の挙動が**未実装であること**を red で確認する。

次に `recoverInReview` の `switch` に `pr_closed` / `stopped` の `case` を追加する（`merged` と `default` の間に挿入。`default` はまだ残す＝open 扱いは Step 6 で実装する）:

```typescript
      case "pr_closed":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(session, "pr_closed", null);
      case "stopped":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が停止系 verdict"
```

期待: 全 green。落ちたら `pr_closed`/`stopped` 分岐が `stopSession`（HALT を返す）を呼ぶこと、`run()` が HALT で `loop()` を呼ばない（`eligibleCalls` 0）ことを確認する。

- [ ] **Step 6: in_review+PR が open 扱い（done/in_progress/corrupted/not_engaged）→ 採用して MONITOR 再開のテストを先に書いて red 確認 → 実装で green**

`tests/recovery.test.ts` に describe を追記。回復の poll が open verdict を返したら採用し、続く `monitorSession` のループ poll で完走する。`FakeMonitor` は要素 >1 で shift・=1 で同じものを返すので、verdict 列を `[done, merged]` 等で組む:

```typescript
describe("回復 — in_review + PR が open 扱い → 採用して MONITOR 再開（仕様 §9 / カーネル §8）", () => {
  it("poll が in_progress → done → merged で完走し、monitorStartedAt は上書きされない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:10:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: originalStart,
    });
    // 回復 poll(in_progress) で採用 → monitorSession の poll で done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];
    // 回復後ループに入るので 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // 採用 → MONITOR 再開 → merged
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(newRun.id);
    // 監視起点は上書きされない（ガード/timeout の経過継続。カーネル §8）
    expect(s.monitorStartedAt).toBe(originalStart);
    // DONE 後段 transition(done)
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // merge が呼ばれた（done→ready→merge）
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
    // tasks_started=1（採用で新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
  });

  it("poll が corrupted（open 扱いで採用）→ 続く poll が即 corrupted を維持 → MONITOR が即 stopped(monitor_never_engaged) で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 回復 poll(corrupted) で採用 → monitorSession の poll(corrupted) で即停止
    h.monitor.verdicts = [{ kind: "corrupted" }, { kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // 回復が HALT で終わったのでループに入らない
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open 扱い"
```

期待される失敗: open 扱いの verdict（in_progress/corrupted）は `recoverInReview` の `default` が `throw new Error('recoverInReview: verdict "in_progress" not yet implemented')`（resp. `"corrupted"`）を投げるため、`run()` が reject／または握り潰し設計なら「`s.state` が `merged`/`stopped` にならず `in_review` のまま」で 2 ケースとも落ちる。これで open 採用が**未実装であること**を red で確認する。

次に実装する。まず `adoptAndMonitor` private メソッドを `recoverDone` の隣（`recoverByOpenPr` と `recoverDone` の間）に追加する:

```typescript
  /**
   * 採用したセッションを MONITOR 再開し、merged まで進んだら DONE 後段を実行する。
   * monitorStartedAt は上書きしない（ガード/timeout の経過を継続。引数は記録用で再設定はしない）。
   */
  private async adoptAndMonitor(
    session: TaskSessionRow,
    prNumber: number,
    _monitorStartedAt: string | null,
  ): Promise<RunControl> {
    // runId 付替え（採用 → tasks_started に数えられる）。in_review 以外で来た場合も state は in_review にする。
    this.store.updateSession(session.id, { runId: this.runId, state: "in_review" });
    const fresh = this.store.getSession(session.id);
    const ctrl = await this.monitorSession(fresh, prNumber);
    if (ctrl.control === "halt") return HALT;
    // merged 到達 → DONE 後段
    await this.recoverDone(fresh);
    return CONTINUE;
  }
```

次に `recoverInReview` を更新する。(a) 冒頭の `const verdict = await this.monitor.poll(prNumber);` を try/catch にして poll throw 時は採用して通常 MONITOR ループへ委ねる、(b) `switch` の `default` を open 扱いの 4 `case` に置き換える:

```typescript
  /** in_review + PR の回復（カーネル §8）。poll の verdict で分岐する。 */
  private async recoverInReview(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    let verdict: MonitorVerdict;
    try {
      verdict = await this.monitor.poll(prNumber);
    } catch (err) {
      // poll が回復時に throw → 採用して通常 MONITOR ループに委ねる（バックオフ/5連続停止は monitorSession が担う）。
      this.log(`recovery: poll threw for PR #${prNumber}, resuming MONITOR: ${errMsg(err)}`);
      return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
    switch (verdict.kind) {
      case "merged":
        // DONE 後段（merged 永続化 → transition(done)）。二重計上なし（導出）。HALT しない。
        this.store.updateSession(session.id, { runId: this.runId });
        await this.recoverDone(session);
        return CONTINUE;
      case "pr_closed":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(session, "pr_closed", null);
      case "stopped":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
      // done / in_progress / corrupted / not_engaged = open 扱い → 採用して MONITOR 再開
      case "done":
      case "in_progress":
      case "corrupted":
      case "not_engaged":
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
  }
```

> `default` を削除し全 7 kind の `case` を明示したことで、以降は `MonitorVerdict` に kind が増えたら tsc の exhaustiveness（網羅）チェックが効く。

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open 扱い"
```

期待: 全 green。落ちたら `adoptAndMonitor` が `runId` 付替え後に `monitorSession` を呼び、その halt/continue を回復の HALT/CONTINUE に変換していること、`monitorStartedAt` を上書きしていないことを確認する。

> 注: 2 つ目のテストは「回復 poll で 1 回 corrupted を消費 → 採用 → monitorSession の最初の poll で 2 つ目の corrupted を消費して即停止」を表す。`FakeMonitor` は verdicts が 2 要素なので 1 回目で 1 つ目を shift、2 回目で残り 1 つを維持して返す。

- [ ] **Step 7: ここまでの in_review 回復テストをコミット**

```
git add tests/recovery.test.ts
git commit -m "test: recovery in_review verdict branches (closed/stopped/adopt-monitor)"
```

- [ ] **Step 8: claimed/implementing/handing_off で findOpenPrForBranch ヒット → 採用のテストを先に書いて red 確認 → 実装で green**

まず失敗テストを追記する。この時点で `recoverByOpenPr` は丸ごと `throw new Error('recoverByOpenPr: not yet implemented ...')` なので、claimed/implementing/handing_off の seed を入れて `run()` すると reject／または握り潰し設計なら「`s.state` が `merged` にならず元の state のまま・`prNumber` が `null`」で落ちる。これでヒット採用が**未実装であること**を red で確認する。

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — claimed/implementing/handing_off で open PR ヒット → 採用（仕様 §9 / カーネル §8）", () => {
  it("handing_off で findOpenPrForBranch が #555 を返す → state=in_review・PR永続化・monitorStartedAt は既存値 → MONITOR 完走", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:12:00.000Z";
    const crashed = seedCrashedSession(
      h.store,
      { state: "handing_off", monitorStartedAt: originalStart },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 既存オープン PR を発見
    h.git.openPrForBranch.set("looppilot/ty-1-x", 555);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(555);
    expect(s.runId).toBe(newRun.id);
    // monitorStartedAt は既存値（??  clock の右辺は使われない）
    expect(s.monitorStartedAt).toBe(originalStart);
    // 採用で tasks_started に数えられる
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [555, "sha-555"] });
  });

  it("implementing で monitorStartedAt=null・open PR ヒット → monitorStartedAt が clock() で新規設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing", monitorStartedAt: null },
      { branch: "looppilot/ty-2-x", worktreePath: "/wt/ty-2", linearIssueId: "issue-B", linearIdentifier: "TY-2" },
    );
    h.git.openPrForBranch.set("looppilot/ty-2-x", 666);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(666);
    // monitorStartedAt は null だったので clock() で設定（基準 2026-06-05... 始まり）
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open PR ヒット"
```

期待される失敗: `recoverByOpenPr` が `throw new Error('recoverByOpenPr: not yet implemented ...')` を投げるため、2 ケースとも `run()` reject／または握り潰し設計なら `s.state` が `merged` にならず（handing_off / implementing のまま）で落ちる。

次に `recoverByOpenPr` を「丸ごと throw」から「ヒット分岐を実装 + ミスはまだ throw（Step 9 で実装）」へ置き換える:

```typescript
  /** claimed/implementing/handing_off（および PR 番号欠落 in_review）の回復（カーネル §8）。 */
  private async recoverByOpenPr(session: TaskSessionRow): Promise<RunControl> {
    const prNumber = await this.git.findOpenPrForBranch(session.branch);
    if (prNumber !== null) {
      // 既存のオープン PR を採用。monitorStartedAt は既存値 ?? clock()。
      const monitorStartedAt = session.monitorStartedAt ?? this.clock();
      this.store.updateSession(session.id, {
        runId: this.runId,
        prNumber,
        state: "in_review",
        monitorStartedAt,
      });
      return await this.adoptAndMonitor(session, prNumber, monitorStartedAt);
    }
    // オープン PR なし（ミス）: stopped(exception)+HALT は Step 9 で失敗テスト先行で実装する。
    throw new Error(`recoverByOpenPr: open-PR-miss not yet implemented (session ${session.id})`);
  }
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open PR ヒット"
```

期待: 全 green。落ちたら `recoverByOpenPr` のヒット分岐（`updateSession({runId, prNumber, state:"in_review", monitorStartedAt: s.monitorStartedAt ?? clock()})` → `adoptAndMonitor`）を確認する。

- [ ] **Step 9: claimed/implementing/handing_off で open PR ミス → stopped(exception)+HALT のテストを先に書いて red 確認 → 実装で green**

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — open PR ミス → stopped(exception) + HALT（仕様 §9 / カーネル §8: 手動掃除）", () => {
  it("claimed で findOpenPrForBranch が null → stopped(exception, stop_detail に branch/worktree/identifier) + HALT・ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", monitorStartedAt: null },
      { branch: "looppilot/ty-7-x", worktreePath: "/wt/ty-7", linearIssueId: "issue-G", linearIdentifier: "TY-7" },
    );
    // open PR なし（既定 null）
    h.source.queue = [issue("issue-Z", "TY-9")];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    // stop_detail に branch / worktree / identifier を明記（手動掃除を促す。カーネル §8）
    expect(s.stopDetail).toContain("crash recovery: no open PR");
    expect(s.stopDetail).toContain("looppilot/ty-7-x");
    expect(s.stopDetail).toContain("/wt/ty-7");
    expect(s.stopDetail).toContain("TY-7");
    expect(s.runId).toBe(newRun.id);
    // HALT したのでループに入らない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
    // pushAndOpenPr / mergePr は呼ばれない（タスク内再開は v1 スコープ外）
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("worktreePath=null でも stop_detail にプレースホルダを出して HALT する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", worktreePath: null },
      { branch: "looppilot/ty-8-x", linearIssueId: "issue-H", linearIdentifier: "TY-8" },
    );

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("<no worktree>");
    expect(s.stopDetail).toContain("looppilot/ty-8-x");
    expect(s.stopDetail).toContain("TY-8");
  });
});
```

> 注: 2 つ目のテストは `worktreePath` を `null` で上書きする（`createSession` は worktreePath 必須だが、`seedCrashedSession` の patch で `updateSession(s.id, { worktreePath: null })` できる。カーネル §4 で `worktree_path` は nullable）。

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open PR ミス"
```

期待される失敗: `recoverByOpenPr` のミス側がまだ `throw new Error('recoverByOpenPr: open-PR-miss not yet implemented ...')` なので、2 ケースとも `run()` reject／または握り潰し設計なら「`s.state` が `stopped` にならず `claimed` のまま・`failureReason` が `null`・`stopDetail` が無い」で落ちる。

次に `recoverByOpenPr` のミス側の throw を本実装へ置き換える:

```typescript
    // オープン PR なし → 手動掃除を促して HALT（タスク内自動再開は v1 スコープ外）。
    this.store.updateSession(session.id, { runId: this.runId });
    const detail =
      `crash recovery: no open PR; manual cleanup: ` +
      `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
    return await this.stopSession(session, "exception", detail);
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open PR ミス"
```

期待: 全 green。落ちたら `recoverByOpenPr` のミス分岐（`stopSession(s, "exception", "crash recovery: no open PR; manual cleanup: ...")`）の文言・`run()` の HALT で `loop()` を呼ばないことを確認する。

- [ ] **Step 10: open PR ヒット/ミス系テストをコミット**

```
git add tests/recovery.test.ts
git commit -m "test: recovery by open PR — adopt on hit, stopped(exception)+HALT on miss"
```

- [ ] **Step 11: 孤児チケット復帰（findOrphanedInProgress → todo ベストエフォート+警告）のテストを先に書いて red 確認 → 実装で green**

孤児ブロックは Step 2 でコメントのみ（未実装）にしてあるので、以下の 3 ケースは red になる。まず失敗テストを追記する。

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — 孤児チケット（In Progress だがセッション行なし → Todo 復帰・ベストエフォート）（仕様 §9 / カーネル §8）", () => {
  it("findOrphanedInProgress が 2 件返す → 各々 transition(todo) + 警告ログ。HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 活性セッションは無し（孤児だけ）→ 回復は孤児復帰のみ。
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 回復後ループは 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 孤児 2 件が Todo へ戻された
    expect(h.source.transitions).toEqual([
      { issueId: "issue-O1", state: "todo" },
      { issueId: "issue-O2", state: "todo" },
    ]);
    // 警告ログが各孤児に出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-11"))).toBe(true);
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-12"))).toBe(true);
    // 孤児復帰は HALT しない → ループに入った（run_started のみ・halted なし）
    expect(h.store.latestRun()!.state).not.toBe("halted");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started"]);
  });

  it("transition(todo) が throw してもベストエフォート（HALT せず警告ログ）で次の孤児へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 最初の transition(todo) で 1 回だけ throw（FakeTaskSource.failNext は次の1回だけ throw）
    h.source.failNext("transition", new Error("Linear 5xx"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 1 件目の transition は throw（記録されない）、2 件目は成功して記録される
    expect(h.source.transitions).toEqual([{ issueId: "issue-O2", state: "todo" }]);
    // ベストエフォートなので HALT していない
    expect(h.store.latestRun()!.state).not.toBe("halted");
  });

  it("findOrphanedInProgress 自体が throw しても回復は HALT せず警告のみで継続する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.failNext("findOrphanedInProgress", new Error("Linear query failed"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    expect(h.logs.some((l) => l.includes("warning") && l.includes("findOrphanedInProgress failed"))).toBe(true);
    expect(h.store.latestRun()!.state).not.toBe("halted");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "孤児チケット"
```

期待される失敗: 孤児ブロックが未実装（Step 2 でコメントのみ）なので、1 件目は `h.source.transitions` が空配列のまま（`transition(todo)` が呼ばれない）で落ち、3 件目は `findOrphanedInProgress failed` の警告ログが出ず落ちる。これで孤児復帰が**未実装であること**を red で確認する。

次に `recoverPendingSessions()` の冒頭コメント `// 1) 孤児チケット復帰: Step 11 で...` を本実装に置き換える:

```typescript
    // 1) 孤児チケット復帰（ベストエフォート）
    try {
      const orphans = await this.source.findOrphanedInProgress(this.store.knownIssueIds());
      for (const orphan of orphans) {
        await bestEffort(() => this.source.transition(orphan.id, "todo"));
        this.log(
          `warning: recovered orphaned In Progress ticket ${orphan.identifier} -> Todo (no session row)`,
        );
      }
    } catch (err) {
      this.log(`warning: findOrphanedInProgress failed during recovery: ${errMsg(err)}`);
    }
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "孤児チケット"
```

期待: 全 green。落ちたら `recoverPendingSessions()` の孤児ブロック（`findOrphanedInProgress` を try で囲み、各 orphan を `bestEffort(transition todo)` + 警告ログ）を確認する。

- [ ] **Step 12: 採用セッションが tasks_started に数えられ上限と比較されるテストを先に書いて red 確認 → 既存実装で green**

採用したセッションが `countTasksStarted(newRunId)` に数えられ、`loop()` のタスク上限チェックの比較対象になることを固定する。`maxTasksPerRun=1` で「回復が 1 件採用して完走 → ループ先頭で `countTasksStarted(1) >= 1` 成立 → SELECT 前に task_cap HALT」を検証:

```typescript
describe("回復 — 採用セッションが tasks_started に数えられ上限と比較される（仕様 §11 / カーネル §8）", () => {
  it("maxTasksPerRun=1 で回復が 1 件採用→完走すると、ループ先頭で task cap 到達 → SELECT せず HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 残キューに 1 件あるが、採用 1 件で上限到達のため着手されない
    h.source.queue = [issue("issue-Q", "TY-99")];
    // 回復 poll が open → 採用して MONITOR、done→merged で完走
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 採用セッションは新 Run の tasks_started=1
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // 上限到達でループ先頭 HALT（SELECT に進まない → getNextEligible は呼ばれない）
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).toContain("task cap reached");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 残キューの TY-99 は未着手
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-99"]);
    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "task_cap" });
  });

  it("回復で HALT したら（in_review が stopped verdict）ループに一切入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Q", "TY-99")];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "gave up" }];

    await h.orch.run();

    // 回復で HALT → ループ(loop)に入らず SELECT は 0 回
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.agent.contexts).toHaveLength(0); // 実装フェーズにも入らない
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});
```

> 注（characterization の失敗確認）: このテストが固定する「採用→runId 付替え→tasks_started に数えられる」挙動は Step 6/8 の `adoptAndMonitor`（`updateSession({ runId: this.runId, ... })`）で既に実装済みのため、テスト追加だけでは red にならない。カーネル §11 の「テスト→失敗確認→実装→成功確認」を満たすため、**まず付替えを一時的に殺して red を観測**する: `adoptAndMonitor` の `this.store.updateSession(session.id, { runId: this.runId, state: "in_review" });` を一時的に `state` だけの patch（`{ state: "in_review" }`）に書き換えて実行 → 1 件目が「採用セッションが旧 Run のまま → 新 Run の `countTasksStarted(newRun.id)` が `0`、task_cap 未到達でループが SELECT に進み `eligibleCalls` が 0 でない」で落ちる（=この挙動が runId 付替えに依存していることを赤で確認）。確認後 `runId: this.runId` を**元に戻す**。

実行（まず付替えを殺して red、戻して green）:

```
npx vitest run tests/recovery.test.ts -t "tasks_started に数えられ"
```

期待: 付替えを殺すと 1 件目 red、戻すと全 green。落ちたら `adoptAndMonitor` が `updateSession(runId: this.runId)` で付替えていること、`loop()` の上限チェックが各反復先頭で `countTasksStarted(runId) >= maxTasksPerRun` を見ていること（Task 12）を確認する。1 件目は「回復後ループに入る（continue）が先頭で task_cap HALT」、2 件目は「回復で HALT（loop に入らない）」の差分を確認する。

- [ ] **Step 13: 複数 active セッション・最初の HALT で打ち切りのテストを書き、打ち切りを一時的に殺して red 確認 → 戻して green**

`activeSessions()` が複数返るとき、最初に HALT した時点で残りを処理しないことを固定する（id ASC 順・カーネル §8: 逐次で最初の stopped が Run=halted を確定）。この「最初の HALT で打ち切る」挙動は Step 2 で実装済みの `for` ループ内 `if (ctrl.control === "halt") return HALT;` に依存するため、テスト追加だけでは red にならない。**まず打ち切りを一時的に殺して red を観測**する手順を含める:

```typescript
describe("回復 — 複数 active セッションは id ASC・最初の HALT で打ち切り（仕様 §9 / カーネル §8）", () => {
  it("2 件 active（1 件目 in_review→merged、2 件目 claimed→open PR ミス）→ 1 件目採用後 2 件目で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 5 });
    const h = makeHarness(config);
    // 1 件目: in_review + PR #100（merged で完走）
    const s1 = seedCrashedSession(
      h.store,
      { state: "in_review", prNumber: 100, monitorStartedAt: "2026-06-04T00:10:00.000Z" },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 2 件目: claimed・open PR ミス → HALT（同じ store・別セッション）
    const s2RunSeed = h.store.createSession({
      runId: h.store.latestRun()!.id, // s1 の旧 Run と同じ旧 Run
      linearIssueId: "issue-B",
      linearIdentifier: "TY-2",
      issueTitle: "second crashed",
      branch: "looppilot/ty-2-x",
      worktreePath: "/wt/ty-2",
      now: "2026-06-04T00:00:02.000Z",
    });
    h.store.updateSession(s2RunSeed.id, { state: "claimed" });
    // 1 件目だけ open verdict→merged で完走。2 件目は open PR 無し（既定 null）で HALT。
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const r1 = h.store.getSession(s1.id);
    const r2 = h.store.getSession(s2RunSeed.id);
    // 1 件目は merged（採用・DONE 後段）
    expect(r1.state).toBe("merged");
    expect(r1.runId).toBe(newRun.id);
    // 2 件目は stopped(exception)（open PR ミス）→ HALT
    expect(r2.state).toBe("stopped");
    expect(r2.failureReason).toBe("exception");
    expect(r2.runId).toBe(newRun.id);
    // 回復で HALT → ループに入らない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});
```

実行（まず打ち切りを殺して red、戻して green）:

> 失敗確認手順: `recoverPendingSessions()` の `for` ループ内 `if (ctrl.control === "halt") return HALT;` を一時的に `if (ctrl.control === "halt") { /* keep going */ }`（早期 return を消す）へ書き換えて実行する。すると 1 件目（merged）処理後も 2 件目（open PR ミス→HALT）まで進み、最後に CONTINUE を返してループに入るため `eligibleCalls` が 0 でなくなる／`newRun.state` が `halted` でなくなる経路が生じ得る、または 2 件目の stopped 後に処理が継続して期待と食い違い red になる。これで「最初の HALT で打ち切る」挙動を赤で確認する。確認後 `return HALT;` を**元に戻す**。

```
npx vitest run tests/recovery.test.ts -t "複数 active セッション"
```

期待: 早期 return を消すと red、戻すと green。落ちたら `recoverPendingSessions()` の `for (const session of this.store.activeSessions())` ループが `ctrl.control === "halt"` で即 `return HALT` していること、`activeSessions()` が id ASC（Task 5）であることを確認する。

> 注: 1 件目の `monitor.verdicts=[{merged}]` は回復 poll が消費する（in_review+PR の merged 分岐は `monitorSession` を経由せず即 DONE 後段なので、verdict 1 個で足りる）。2 件目は monitor を呼ばず（claimed→`findOpenPrForBranch` 経路）HALT する。

- [ ] **Step 14: 残りのテストをコミットし、最終 `npm run check`**

```
git add tests/recovery.test.ts
git commit -m "test: recovery orphans, task-cap counting, multi-session halt cutoff"
```

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`recoverPendingSessions()` が `Promise<RunControl>` を返し、`recoverInReview` の switch が `MonitorVerdict` 全 kind を網羅、`run()` が回復の halt/continue を分岐する。失敗が残り、それがカーネル §8 と矛盾するなら openQuestions に記録し、コードは勝手に改変しない。

```
git add src/orchestrator.ts tests/recovery.test.ts
git commit -m "chore: finalize crash-recovery task (Task 14)"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` の `recoverPendingSessions()` が `Promise<RunControl>` を返し、カーネル §8 を実装する:
  - 孤児チケット（`findOrphanedInProgress(knownIssueIds())`）を Todo へベストエフォート復帰 + 警告ログ（`findOrphanedInProgress`/`transition` の throw もベストエフォート）。
  - `activeSessions()`（merged/stopped 以外・全 run 横断・id ASC）を走査し、`in_review`+PR は `monitor.poll` の verdict で分岐（merged→DONE 後段・二重計上なし／pr_closed→stopped(pr_closed)／stopped→stopped(looppilot_stopped, stopReason ?? 既定文言)／その他=open→採用・runId 付替え・`monitorStartedAt` 不変で MONITOR 再開）、`claimed`/`implementing`/`handing_off` は `findOpenPrForBranch` ヒット時に採用（`monitorStartedAt = 既存値 ?? clock()`）・ミス時に `stopped(exception, "crash recovery: no open PR; manual cleanup: <branch>, <worktree>, <identifier>")` + HALT。
- `run()` が回復の戻り値を見て、`halt` ならループ（`loop()`）を呼ばない。
- `tests/recovery.test.ts` が以下を固定する: in_review+PR の merged/pr_closed/stopped(stopReason あり・null)/open 採用（in_progress→done→merged・corrupted 採用→即停止）、open PR ヒット（monitorStartedAt 既存値 / null→clock）、open PR ミス（worktreePath あり/null で stop_detail 明記）、孤児復帰（2 件・transition throw・query throw のベストエフォート）、採用が tasks_started に数えられ task_cap と比較される、回復 HALT でループに入らない、複数 active で最初の HALT による打ち切り。
- 全テストは `fixedClock`/`instantSleep` + seed した `monitorStartedAt`/`requestStop()` で時間・ループを決定的に制御。`vi.mock` 不使用（フェイクのメソッド差し替え/プロパティ設定のみ）。
- `Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness` は再定義せず Modify（テストヘルパは独立ファイルのため再定義を許容）。`monitorSession`/`done`/`stopSession` を再利用し重複実装しない。
- `npm run check` が green。


---

### Task 15: プリフライト

**目的**: 起動時に「環境が安全にループを回せる状態か」を fail-fast で検証する。カーネル §9 の 10 項目を一字一句のコマンドで実行し、各違反を `string` メッセージとして**集約**（途中で throw せず全件実行）して返す `runPreflight(deps) => Promise<string[]>`（空配列=合格）を `src/preflight.ts` に実装する。Linear 解決は task-source.ts の `resolveLinearSetup`、Slack 到達確認は `notifier.probeReachability()` を利用する。著者整合は §9 step9 の R⊆C 規則。

**依存タスク**: Task 2（types.ts: `CommandRunner`, `CommandResult`, `RunOptions`, `Notifier`, `TicketState`）、Task 3（exec.ts + tests/fakes.ts の `FakeCommandRunner`）、Task 4（config.ts: `Config` 型 — `Config` は **config.ts** が唯一の定義元で types.ts には無い）、Task 6（notifier.ts: `Notifier.probeReachability`）、Task 7（task-source.ts: `resolveLinearSetup` / `FetchFn` / `LinearSetupRequest` / `ResolvedLinearSetup`）。本タスクは consumes のみで、これらの実装を変更しない。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/preflight.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/preflight.test.ts`

---

#### 契約の固定（実装前に確認・本タスクで新規定義する公開シンボル）

`src/preflight.ts` は以下のみを export する。

```typescript
export interface PreflightDeps {
  config: Config;
  runner: CommandRunner;
  notifier: Notifier;
  fetchFn: FetchFn;
}
export function runPreflight(deps: PreflightDeps): Promise<string[]>;
```

**consumes（他タスク定義物・改名禁止・本タスクで一字一句一致させる対象）**:
- `CommandRunner`, `CommandResult`, `RunOptions`, `Notifier`, `TicketState`（`../src/types.js` / Task 2、カーネル §2）
- `Config`（`../src/config.js` / Task 4。**types.ts ではなく config.ts が定義元**。形は下記 `makeConfig` のとおり camelCase）
- `resolveLinearSetup`, `FetchFn`, `LinearSetupRequest`, `ResolvedLinearSetup`（`../src/task-source.js` / Task 7）。確定シグネチャ（カーネル §5.5・Task 7 §で確認済み）:
  ```typescript
  // task-source.ts より（本タスクは import して呼ぶだけ・改変しない）
  export type FetchFn = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

  export interface LinearSetupRequest {
    teamKey: string;
    projectName: string;
    stateNames: Record<TicketState, string>;   // TicketState = "todo"|"in_progress"|"in_review"|"done"
    optInLabel: string;
  }
  export interface ResolvedLinearSetup {
    viewerId: string; teamId: string; projectId: string;
    stateIds: Record<TicketState, string>; optInLabelId: string;
  }
  export function resolveLinearSetup(
    apiKey: string,
    req: LinearSetupRequest,
    fetchFn: FetchFn,
  ): Promise<ResolvedLinearSetup>;   // 解決不能なら throw（fail-fast 用に欠落を 1 回でまとめて報告）
  ```
- `notifier.probeReachability(): Promise<void>`（notifier.ts / Task 6）。Slack 未設定なら即 resolve、設定済みで非2xx/network なら throw。

> **重要な契約注意（実装で踏むと壊れる）**:
> 1. `resolveLinearSetup` の引数は `(apiKey, req, fetchFn)` の **3 引数**。`{ config, fetchFn }` の 1 オブジェクトではない。
> 2. `fetchFn` の型は **`FetchFn`**（戻り値 `{ ok, status, json() }`）であり Web 標準 `typeof fetch` ではない。テストの fake fetch も `{ ok, status, json() }` を返すプレーンオブジェクトで作る（`new Response(...)` は使わない）。
> 3. `config.linear.states` のキーは camelCase（`todo/inProgress/inReview/done`）。一方 `LinearSetupRequest.stateNames` のキーは `TicketState`（`todo/in_progress/in_review/done`）。`checkLinear` で**明示的にキー写像**する。

---

#### Step 1: 失敗するテストファイルの骨組み（合格ヘルパ + 最初の NG テスト1件）を書く

- [ ] **Step 1: `tests/preflight.test.ts` を新規作成し、合格ヘルパ（`makeConfig`/`passingRunner`/`passingFetch`/`passingNotifier`）と「default_branch 以外で起動すると NG」テスト1件を書く（`runPreflight` 未実装なので失敗する）**

`/home/racoma-dev/loop-pilot-os/tests/preflight.test.ts` を作成:

```typescript
import { describe, it, expect } from "vitest";
import { runPreflight } from "../src/preflight.js";
import { FakeCommandRunner } from "./fakes.js";
import type { Notifier, NotifyEvent, TicketState } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FetchFn } from "../src/task-source.js";

// ---- テスト用の最小 Config（config.ts §の Config 形・camelCase は解決済みの形） ----
function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    product: { goal: "ship it" },
    repo: {
      path: "/abs/repo",
      remote: "owner/name",
      defaultBranch: "main",
      worktreeRoot: "/home/u/.looppilot-os/worktrees/repo",
    },
    linear: {
      team: "TY",
      project: "LoopPilot OS",
      optInLabel: "ai-ok",
      states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" },
    },
    agent: { model: "opus", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    handoff: { branchPrefix: "looppilot", prBodyTemplate: "Implements {identifier}" },
    looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]"] },
    safety: {
      maxTasksPerRun: 3,
      maxCostUsdPerSession: 10,
      monitorTimeoutMinutes: undefined,
      notEngagedGuardMinutes: 30,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    digest: { recentMergedCount: 5 },
    linearApiKey: "lin_api_test",
    slackWebhookUrl: undefined,
    stateDbPath: "/abs/repo/looppilot-os.db",
  };
  return { ...base, ...overrides };
}

// ---- すべて合格になるよう FakeCommandRunner を仕込むヘルパ（カーネル §9 の各コマンド） ----
function passingRunner(): FakeCommandRunner {
  const r = new FakeCommandRunner();
  // §9.2: クリーンな defaultBranch 上
  r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "main\n", stderr: "" });
  r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: "", stderr: "" });
  // §9.3: remote 到達
  r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 0, stdout: "deadbeef\tHEAD\n", stderr: "" });
  // §9.4: gh 認証
  r.on(["gh", "auth", "status"], { code: 0, stdout: "Logged in", stderr: "" });
  // §9.4: push 権限
  r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "true\n", stderr: "" });
  // §9.4: 認証ユーザー名（restrictions の許可リスト照合に使う）
  r.on(["gh", "api", "user", "--jq", ".login"], { code: 0, stdout: "the-bot\n", stderr: "" });
  // §9.4: ブランチ保護なし → 404
  r.on(["gh", "api", "repos/owner/name/branches/main/protection"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.4: rulesets 空配列（保護なし）
  r.on(["gh", "api", "repos/owner/name/rules/branches/main"], { code: 0, stdout: "[]\n", stderr: "" });
  // §9.5: gate_label がリポラベルに存在
  r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nloop-pilot\nai-ok\n", stderr: "" });
  // §9.6: AUTO_MERGE 未設定 → 404
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.9: STATE_COMMENT_AUTHORS 未設定 → 404（リポ既定 github-actions[bot]）
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.8: claude 起動可
  r.on(["claude", "--version"], { code: 0, stdout: "2.1.165 (Claude Code)\n", stderr: "" });
  return r;
}

// resolveLinearSetup は https://api.linear.app/graphql を `FetchFn` で叩く。
// 解決に必要な viewer/teams/projects/issueLabels を一括で返す合格応答（Task 7 SETUP_QUERY の shape）。
// FetchFn の戻り値は { ok, status, json() }。Web Response ではない。
function passingFetch(): FetchFn {
  const body = {
    data: {
      viewer: { id: "user-1", name: "Viewer" },
      teams: {
        nodes: [
          {
            id: "team-1",
            key: "TY",
            states: {
              nodes: [
                { id: "st-todo", name: "Todo" },
                { id: "st-prog", name: "In Progress" },
                { id: "st-rev", name: "In Review" },
                { id: "st-done", name: "Done" },
              ],
            },
            labels: { nodes: [{ id: "lb-1", name: "ai-ok" }] },
          },
        ],
      },
      projects: { nodes: [{ id: "proj-1", name: "LoopPilot OS" }] },
      issueLabels: { nodes: [] },
    },
  };
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

const passingNotifier: Notifier = {
  notify: async (_e: NotifyEvent) => {},
  probeReachability: async () => {},
};

describe("runPreflight", () => {
  // 仕様 §9.2 / §8: repo はクリーンな git で default_branch 上であること。
  it("default_branch 以外で起動すると NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "feature-x\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("feature-x") && e.includes("default_branch"))).toBe(true);
  });
});
```

> このステップでは `src/preflight.ts` がまだ無いため、`import { runPreflight }` の解決に失敗する。次ステップでその失敗を確認する。

---

#### Step 2: テストを実行して失敗を確認する

- [ ] **Step 2: `npx vitest run tests/preflight.test.ts` を実行し、`src/preflight.ts` 不在で import 解決に失敗することを確認する**

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される失敗: `Failed to resolve import "../src/preflight.js" from "tests/preflight.test.ts"`（モジュール未作成）。この赤を確認してから実装へ進む。

---

#### Step 3: `runPreflight` の骨格 + §9.2(checkGitClean) チェックを実装して**緑**にする

- [ ] **Step 3: `src/preflight.ts` を作成する。集約骨格（全チェックを順に呼び、各 `errors` を連結して返す）と `checkGitClean` を完全実装し、残りのチェック（remote/gh-auth/push を含む全て）は空関数にして、Step 1 のテストを green にする**

> この Step では「集約骨格」と最初の 1 チェック `checkGitClean` のみを**完全実装**する。残りのチェック（remote/gh-auth/push/保護/rulesets/gate_label/auto_merge/state_authors/linear/claude/slack）は、後続 Step でそれぞれ「先に赤テスト → 実装 → 緑」を踏んで追加するため、この時点では**空関数**にしておく。骨格は最初から全チェックを呼ぶが、各チェック関数の検知ロジック本体は対応する赤テストを確認した直後の Step でファイルに追記して配線する。
>
> ここでの green は inert スタブによる偽の green ではない。`checkGitClean` は実際の検知ロジックを持ち、Step 1 の「feature-x で NG」テストはその実装を genuine に検証する。残り全チェックは空関数なので Step 1 のテストには影響しない（赤を経て各 Step で実装される）。

`/home/racoma-dev/loop-pilot-os/src/preflight.ts` を作成:

```typescript
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

// ---- §9.3 remote 到達可（Step 4b で本体を追加） ----
async function checkRemote(
  _runner: CommandRunner, _repoPath: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

// ---- §9.4 gh 認証（Step 4b で本体を追加） ----
async function checkGhAuth(
  _runner: CommandRunner, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

// ---- §9.4 push 権限（Step 4b で本体を追加） ----
async function checkPushPermission(
  _runner: CommandRunner, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

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
```

> 設計判断（TDD 順序とビルド可能性の両立）: カーネル §0「全タスク red→green」を守りつつ、`runPreflight` の集約骨格を一度に書くために、まだ赤テストを書いていないチェック（`checkGitClean` 以外のすべて＝remote/gh-auth/push および保護以降）は**この時点で空関数**にしておく。各チェックの検知ロジック本体（`errors.push`）は、対応する不合格テストを**先に赤**で確認した直後の Step で初めて追加する。これにより「テストがその分岐を実際に検証できる」こと（red→green の検証単位を各チェックが持つこと）が各チェック単位で証明される。tsc は未使用 import (`resolveLinearSetup`/`FetchFn`/`LinearSetupRequest`/`TicketState`) を strict でもエラーにせず（カーネル §0「lint なし」）、Step 3 単独で型チェックが通る。

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
cd /home/racoma-dev/loop-pilot-os && npm run check
```

期待: Step 1 の「feature-x で NG」テストが pass（緑）。tsc（src + test）も通過。

- [ ] **Step 3b: ここまでをコミットする（red→green の単位）**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: runPreflight skeleton + git-clean check"
```

---

#### Step 4a: git ダーティ / remote / gh-auth / push の NG テストを追加して**赤**を確認する

- [ ] **Step 4a: `tests/preflight.test.ts` に §9.2 ダーティ / §9.3 remote 不可 / §9.4 push false の NG テストを追加し、赤を確認する**

> `checkRemote`/`checkGhAuth`/`checkPushPermission` は Step 3 で**空関数**なので、「remote 不可=NG」「gh 認証なし=NG」「push false=NG」を期待する 3 テストはこの時点で fail する（赤）。これにより各チェックが red→green の検証単位を持つ（カーネル §0/§11 の TDD 規約）。「ダーティ=NG」は `checkGitClean` が Step 3 で実装済みのため pass し、実装後の回帰ガードになる（このテストは保護以降の OK テストと同様、既実装分岐の回帰を守る）。remote/gh-auth/push は §9.3/§9.4 の同一グループなので、本 Step でまとめて赤を踏み Step 4b でまとめて実装する。

`describe("runPreflight", ...)` 内の最初のテストの**後**に追加:

```typescript
  it("作業ツリーがダーティなら NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M src/a.ts\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
  });

  it("remote 到達不可なら NG（仕様 §9.3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 128, stdout: "", stderr: "fatal: could not read from remote" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("到達できません"))).toBe(true);
  });

  it("gh 認証されていなければ NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "auth", "status"], { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("認証されていません"))).toBe(true);
  });

  it("push 権限が false なら NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「remote 不可=NG」「gh 認証なし=NG」「push false=NG」の 3 テストが fail（空関数が何も push しないため `AssertionError: expected false to be true`）。「ダーティ=NG」は pass（`checkGitClean` 実装済み）。この赤を確認してから Step 4b で実装する。

---

#### Step 4b: `checkRemote`/`checkGhAuth`/`checkPushPermission` の本体を実装して**緑**にする

- [ ] **Step 4b: `src/preflight.ts` の `checkRemote`/`checkGhAuth`/`checkPushPermission` の空関数本体を実装で置換し、Step 4a の 4 テストが green になることを確認する**

`src/preflight.ts` の 3 つの空関数を以下で置換する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 4a の「remote 不可=NG」「gh 認証なし=NG」「push false=NG」が pass へ転じ、「ダーティ=NG」も pass のまま（緑）。万一 fail する場合は `includes` キーワードを実装の文言に**一致**させる（実装文言は変更しない）。

- [ ] **Step 4c: ここまでをコミットする（red→green の単位）**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight remote/gh-auth/push checks"
```

---

#### Step 5: ブランチ保護の不合格テストを追加して**赤**を確認する（restrictions OK/NG を含む）

- [ ] **Step 5: `tests/preflight.test.ts` に §9.4 ブランチ保護テスト（404=OK / review>0=NG / restrictions に認証ユーザー含む=OK / 含まない=NG）を追加し、赤を確認する**

> `checkBranchProtection` は Step 3 で**空関数**。よって「review>0 で NG」「restrictions に認証ユーザー不在で NG」を期待する 2 テストはこの時点で fail する（赤）。「404=OK」「restrictions に認証ユーザーを含む=OK」の 2 テストは空関数でも偶然 pass しうるが、Step 6 実装後も pass し続けることで OK 分岐の回帰を守る（特に restrictions=含む→OK は、カーネル §9.4『含むときのみ OK』を直接検証する回帰テスト）。

Step 4a で追加した最後のテストの**後**に追加:

```typescript
  it("ブランチ保護なし（404）は OK 判定（仕様 §9.4）", async () => {
    // passingRunner はすでに protection=404, rulesets=[] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("必須承認レビュー") || e.includes("restrictions"))).toEqual([]);
  });

  it("required_approving_review_count>0 のブランチ保護は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("必須承認レビュー数") && e.includes("1"))).toBe(true);
  });

  it("restrictions に認証ユーザーが含まれていれば OK（仕様 §9.4・カーネル『含むときのみ OK』）", async () => {
    const r = passingRunner();
    // 認証ユーザーは the-bot（passingRunner の gh api user 応答）。restrictions.users に the-bot を含める。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "the-bot" }, { login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    // restrictions があっても認証ユーザーが許可リストに居る → ブランチ由来エラーなし。
    expect(errors.filter((e) => e.includes("restrictions") || e.includes("必須承認レビュー"))).toEqual([]);
  });

  it("restrictions に認証ユーザーが不在なら NG（仕様 §9.4・カーネル『不在のみ NG』）", async () => {
    const r = passingRunner();
    // 認証ユーザー the-bot が restrictions.users に居ない → NG。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("restrictions") && e.includes("the-bot"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「review>0=NG」と「restrictions 不在=NG」の 2 テストが fail（空関数が何も push しないため `AssertionError: expected false to be true`）。「404=OK」「restrictions 含む=OK」は pass。この赤を確認してから Step 6 で実装する。

---

#### Step 6: `checkBranchProtection` の本体を実装して**緑**にする

- [ ] **Step 6: `checkBranchProtection` の空関数本体を実装で置換し（`resolveAuthenticatedLogin` ヘルパを新規追加）、Step 5 の 4 テストが green になることを確認する**

`src/preflight.ts` の `checkBranchProtection` 空関数を以下で置換し、ファイル末尾に `resolveAuthenticatedLogin` を新規追加する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 5 の「review>0=NG」「restrictions 不在=NG」が pass へ転じ、「404=OK」「restrictions 含む=OK」も pass のまま（緑）。

> 設計判断: カーネル §9.4 の restrictions NG 条件は「認証ユーザーが許可リストに不在のときのみ」。`gh api user --jq .login` で認証ユーザー名を解決し、`restrictions.users[].login` に含まれていれば restrictions があっても OK、含まれていなければ NG とする（teams/apps による許可は users の allowlist を満たさないため、ユーザー本人が users に居ない限り保守的に NG とする＝最小権限で起動可否を確実に判定）。

- [ ] **Step 6b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight branch-protection check (review>0 / restrictions allowlist)"
```

---

#### Step 7: rulesets の不合格テストを追加して**赤**を確認する

- [ ] **Step 7: `tests/preflight.test.ts` に §9.4 rulesets テスト（404=OK / pull_request ルールで required_approving_review_count>0 は NG）を追加し、赤を確認する**

Step 5 で追加した最後のテストの**後**に追加:

```typescript
  it("rulesets が空配列なら OK（仕様 §9.4）", async () => {
    // passingRunner は rules/branches/main = [] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ルールセット"))).toEqual([]);
  });

  it("rulesets の pull_request ルールで required_approving_review_count>0 は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 2 } }]),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ルールセット") && e.includes("2"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「review>0=NG」テストが fail（`checkRulesets` 空関数は何も push しないため）。「空配列=OK」は pass。確認後に Step 8 で実装する。

---

#### Step 8: `checkRulesets` の本体を実装して**緑**にする

- [ ] **Step 8: `checkRulesets` の空関数本体を実装で置換し、Step 7 のテストが green になることを確認する**

`src/preflight.ts` の `checkRulesets` 空関数を以下で置換する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 7 の「review>0=NG」が pass へ転じ、「空配列=OK」も pass のまま（緑）。

---

#### Step 9: gate_label の不合格テストを追加して**赤**を確認する

- [ ] **Step 9: `tests/preflight.test.ts` に §9.5 gate_label テスト（不在=NG / 大小無視で一致=OK）を追加し、赤を確認する**

Step 7 で追加した最後のテストの**後**に追加:

```typescript
  it("gate_label がリポに無ければ NG（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ゲートラベル") && e.includes("loop-pilot"))).toBe(true);
  });

  it("gate_label は大小無視で照合する（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "Loop-Pilot\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ゲートラベル"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「不在=NG」テストが fail（`checkGateLabel` 空関数は何も push しないため）。「大小無視=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 10 で実装する。

---

#### Step 10: `checkGateLabel` の本体を実装して**緑**にする

- [ ] **Step 10: `checkGateLabel` の空関数本体を実装で置換し、Step 9 のテストが green になることを確認する**

`src/preflight.ts` の `checkGateLabel` 空関数を以下で置換する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 9 の「不在=NG」が pass へ転じ、「大小無視=OK」も pass のまま（緑）。

- [ ] **Step 10b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight rulesets + gate_label checks"
```

---

#### Step 11: LOOPPILOT_AUTO_MERGE の不合格テストを追加して**赤**を確認する

- [ ] **Step 11: `tests/preflight.test.ts` に §9.6 テスト（404=OK / "true"(大小無視)=NG）を追加し、赤を確認する**

Step 9 で追加した最後のテストの**後**に追加:

```typescript
  it("LOOPPILOT_AUTO_MERGE variable 404 は OK 判定（仕様 §9.6）", async () => {
    // passingRunner は variable=404 を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toEqual([]);
  });

  it("LOOPPILOT_AUTO_MERGE が 'true'（大小無視）なら NG（仕様 §9.6）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_AUTO_MERGE", value: "TRUE" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE") && e.includes("唯一のマージャー"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「'true'=NG」テストが fail（`checkAutoMerge` 空関数は何も push しないため）。「404=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 12 で実装する。

---

#### Step 12: `checkAutoMerge` の本体を実装して**緑**にする

- [ ] **Step 12: `checkAutoMerge` の空関数本体を実装で置換し、Step 11 のテストが green になることを確認する**

`src/preflight.ts` の `checkAutoMerge` 空関数を以下で置換する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 11 の「'true'=NG」が pass へ転じ、「404=OK」も pass のまま（緑）。

---

#### Step 13: state-comment 著者整合（R ⊆ C）の不合格テストを追加して**赤**を確認する

- [ ] **Step 13: `tests/preflight.test.ts` に §9.9 テスト（404 で config が既定 bot を含む=OK / R ⊄ C=NG / 余分な信頼著者があり R ⊆ C=OK）を追加し、赤を確認する**

Step 11 で追加した最後のテストの**後**に追加:

```typescript
  it("STATE_COMMENT_AUTHORS variable 404 で config が github-actions[bot] を含めば OK（仕様 §9.9）", async () => {
    // passingRunner は variable=404、config は ["github-actions[bot]"] → R ⊆ C 成立。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("state_comment_authors") || e.includes("monitor_never_engaged"))).toEqual([]);
  });

  it("R ⊄ C（リポ writer を config が包含しない）なら NG（仕様 §9.9）", async () => {
    const r = passingRunner();
    // リポは bot-machine も writer に使うが、config は github-actions[bot] のみ → 欠落。
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_STATE_COMMENT_AUTHORS", value: "github-actions[bot], bot-machine" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("bot-machine") && e.includes("monitor_never_engaged"))).toBe(true);
  });

  it("config が R を包含すれば余分な信頼著者があっても OK（R ⊆ C; 仕様 §9.9）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ value: "github-actions[bot]" }),
      stderr: "",
    });
    const cfg = makeConfig({
      looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]", "extra-bot"] },
    });
    const errors = await runPreflight({ config: cfg, runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("monitor_never_engaged"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「R ⊄ C=NG」テストが fail（`checkStateCommentAuthors` 空関数は何も push しないため）。「404 で OK」「R ⊆ C で OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 14 で実装する。

---

#### Step 14: `checkStateCommentAuthors` の本体を実装して**緑**にする

- [ ] **Step 14: `checkStateCommentAuthors` の空関数本体を実装で置換し、Step 13 のテストが green になることを確認する**

`src/preflight.ts` の `checkStateCommentAuthors` 空関数を以下で置換する:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 13 の「R ⊄ C=NG」が pass へ転じ、「404 OK」「R ⊆ C OK」も pass のまま（緑）。

- [ ] **Step 14b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight auto-merge off + state-comment author R⊆C checks"
```

---

#### Step 15: Linear 解決の不合格テストを追加して**赤**を確認する

- [ ] **Step 15: `tests/preflight.test.ts` に §9.7 テスト（resolveLinearSetup が throw → NG / 合格 fetch なら Linear 由来エラーなし）を追加し、赤を確認する**

Step 13 で追加した最後のテストの**後**に追加:

```typescript
  it("Linear 解決が失敗すると NG（仕様 §9.7）", async () => {
    // team が見つからない応答 → resolveLinearSetup は throw する契約（task-source.ts）。
    const failFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: "user-1", name: "Viewer" },
          teams: { nodes: [] },
          projects: { nodes: [] },
          issueLabels: { nodes: [] },
        },
      }),
    });
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: failFetch });
    expect(errors.some((e) => e.includes("Linear"))).toBe(true);
  });

  it("Linear 解決が成功すれば Linear 由来エラーなし（仕様 §9.7）", async () => {
    // passingFetch は viewer/team/project/states/label をすべて解決できる応答を返す。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Linear"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「Linear 解決失敗=NG」テストが fail（`checkLinear` 空関数は何も push しないため）。「解決成功=エラーなし」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 16 で実装する。

---

#### Step 16: `checkLinear` の本体を実装して**緑**にする

- [ ] **Step 16: `checkLinear` の空関数本体を実装で置換し、Step 15 のテストが green になることを確認する**

`src/preflight.ts` の `checkLinear` 空関数を以下で置換する。`resolveLinearSetup(apiKey, req, fetchFn)` の **3 引数**契約・`stateNames` のキー写像（config camelCase → TicketState snake）に注意:

```typescript
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
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過（`resolveLinearSetup`/`FetchFn`/`LinearSetupRequest`/`TicketState` の import がここで使用される）。Step 15 の「解決失敗=NG」が pass へ転じ、「解決成功=エラーなし」も pass のまま（緑）。

---

#### Step 17: claude/Slack の不合格テストを追加して**赤**を確認する

- [ ] **Step 17: `tests/preflight.test.ts` に §9.8 claude / §9.10 Slack テスト（claude 非0=NG / Slack 非2xx=NG / Slack 未設定=OK）を追加し、赤を確認する**

Step 15 で追加した最後のテストの**後**に追加:

```typescript
  it("claude が起動できないと NG（仕様 §9.8）", async () => {
    const r = passingRunner();
    r.on(["claude", "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude"))).toBe(true);
  });

  it("Slack Webhook が非2xxなら NG（仕様 §9.10）", async () => {
    const failingNotifier: Notifier = {
      notify: async () => {},
      probeReachability: async () => {
        throw new Error("HTTP 500 from webhook");
      },
    };
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: failingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("Slack") && e.includes("HTTP 500"))).toBe(true);
  });

  it("Slack 未設定（probeReachability 即 resolve）なら Slack 由来エラーなし（仕様 §9.10）", async () => {
    // passingNotifier.probeReachability は即 resolve（未設定相当）。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Slack"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「claude 非0=NG」「Slack 非2xx=NG」の 2 テストが fail（`checkClaude`/`checkSlack` 空関数は何も push しないため）。「Slack 未設定=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 18 で実装する。

---

#### Step 18: `checkClaude`/`checkSlack` の本体を実装して**緑**にする

- [ ] **Step 18: `checkClaude`/`checkSlack` の空関数本体を実装で置換し、Step 17 のテストが green になることを確認する**

`src/preflight.ts` の `checkClaude`/`checkSlack` 空関数を以下で置換する:

```typescript
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

async function checkSlack(deps: PreflightDeps, errors: string[]): Promise<void> {
  // 未設定なら probeReachability は即 resolve（notifier.ts / Task 6 契約）。設定済みで非2xx/network なら throw。
  try {
    await deps.notifier.probeReachability();
  } catch (e) {
    errors.push(`Slack: Webhook へ到達できません（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 17 の「claude 非0=NG」「Slack 非2xx=NG」が pass へ転じ、「Slack 未設定=OK」も pass のまま（緑）。

- [ ] **Step 18b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight Linear resolve + claude + Slack reachability checks"
```

---

#### Step 19: 全項目合格 → 空配列、を検証して**緑**を固める

- [ ] **Step 19: `tests/preflight.test.ts` に「全項目合格なら空配列」テストを追加し、green を確認する（全チェック実装済みなので追加実装なし）**

> この時点で全 12 チェックが実装済みなので、`passingRunner()`/`passingFetch()`/`passingNotifier` の全合格セットでは `runPreflight` が空配列を返すはず。これは inert スタブによる偽 green ではなく、全チェックの実装が同時に「合格判定」を返すことの統合検証。

Step 17 で追加した最後のテストの**後**に追加:

```typescript
  it("全項目合格なら空配列を返す（仕様 §9）", async () => {
    const errors = await runPreflight({
      config: makeConfig(),
      runner: passingRunner(),
      notifier: passingNotifier,
      fetchFn: passingFetch(),
    });
    expect(errors).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: 当該テストが pass（全チェック実装済み・統合 green）。万一 1 件でもエラーが出る場合は、`passingRunner`/`passingFetch` の合格応答と各チェックの判定条件の不一致を特定して修正する（テストの合格応答を実装の期待形に合わせる。実装の判定条件は変更しない）。

---

#### Step 20: 複数違反の同時報告（途中 throw せず全件集約）を検証する

- [ ] **Step 20: `tests/preflight.test.ts` に「複数違反を同時に報告する」テストを追加し、green を確認する**

> このテストは「個々のチェックが実装済み」かつ「`runPreflight` が途中 throw せず順次集約する」骨格（Step 3 で確定）の両方を同時に検証する。集約ループは Step 3 で完成しているため追加実装なしで pass する想定。もし fail するなら、それは集約骨格（早期 return / throw 漏れ）のバグであり `runPreflight` 側を修正して緑にする。

Step 19 で追加したテストの**後**に追加:

```typescript
  it("複数違反を同時に報告する（途中 throw せず全件集約; 仕様 §9）", async () => {
    const r = passingRunner();
    // §9.2 ダーティ + §9.4 push 不可 + §9.6 auto-merge true を同時に仕込む
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M x\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ value: "true" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: 当該テストが pass（集約骨格は Step 3 で完成済み）。万一 fail する場合は、`runPreflight` の集約ループに早期 return / 未捕捉 throw が混入していないか確認し修正する。

---

#### Step 21: 全テスト green と最終 typecheck を確認してコミットする

- [ ] **Step 21: `npm run check` で tsc(×2)+vitest 全 green を確認し、コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
```

期待: tsc（src）+ tsc（test）+ vitest 全グリーン。`tests/preflight.test.ts` のテスト件数の目安:
- §9.2: feature-x で NG / ダーティで NG（2）
- §9.3: remote 不可で NG（1）
- §9.4: gh 認証なしで NG / push false で NG（2）/ 保護 404 OK / review>0 NG / restrictions 含む OK / restrictions 不在 NG（4）/ rulesets 空 OK / rulesets review>0 NG（2）
- §9.5: gate_label 不在 NG / 大小無視 OK（2）
- §9.6: auto_merge 404 OK / "TRUE" NG（2）
- §9.9: state authors 404 OK / R⊄C NG / R⊆C OK（3）
- §9.7: Linear 失敗 NG / Linear 成功 OK（2）
- §9.8/§9.10: claude 非0 NG / Slack 非2xx NG / Slack 未設定 OK（3）
- 統合: 全合格 空配列（1）/ 複数違反同時報告（1）
= 計 **25 tests passed**。

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "test: preflight all-pass + multi-violation aggregation"
```

---

#### openQuestions（カーネル/他タスクとの照合で確認が必要な点）

1. **`resolveLinearSetup` の解決対象に project の team 帰属チェックは含むか**: カーネル §5.5 は「team key → team、project 名 → projectId」とだけ規定し、Task 7 の `resolveLinearSetup` は workspace 全体の `projects` から名前一致で projectId を解決する（team との帰属は検証しない）。同名 project が複数 team に存在する環境では誤った projectId を解決し得る。プリフライトとしてこの曖昧性を許容するか、Task 7 側で team スコープに絞るべきか要確認（本タスクは Task 7 の実装をそのまま使う前提）。
2. **`gh api .../rules/branches/<branch>` のレスポンス形**: 本計画は `[{ type, parameters }]` 配列を仮定（gh 2.92.0 で確認した一般形）。実環境で `parameters` のキー名（`required_approving_review_count`）が現行 GitHub API と一致するか、ルールセットの間接適用（ruleset 由来の集約レスポンス）で形が変わらないか、実リポでの一度の確認を推奨（カーネル §5.3 はこのキー名を明記しているため計画はそれに従う）。
3. **`config.notify` の型**: config.ts（Task 4）の zod `rawSchema` には `notify: z.object({}).optional()` があるが、camelCase の `Config` 型（task-04-config.md 441-489 行・唯一の定義元）には `notify` フィールドは**存在しない**（rawSchema から Config へは写像されない）。したがって `makeConfig` の base にも `notify` を置かない（置くと strict の excess property check で tsc(test) が赤になる）。本タスクは `notify` を一切参照しないため影響なし。将来 Slack 以外の通知キーが入り `Config` に `notify` が追加された場合のみ追従。


---

### Task 16: Status CLI + main 配線

**目的**: (1) `src/status.ts` の `renderStatus(store)` を実装し、最新 Run・活性セッション・直近 10 セッション・未配信通知を人間可読の1文字列に整形する（仕様 §10「status CLI で現在セッション・キュー・履歴・停止箇所を表示」）。(2) `src/main.ts` で CLI エントリ（`run`/`status` 分岐・config 読込・カーネル §7 の DI 組立）を配線し、`run` はプリフライト→orchestrator 起動（`run_started` 通知は orchestrator が内部送出）、`status` は `renderStatus` 出力に繋ぐ。`process.exitCode` 規約（正常0/プリフライト1/HALT 2）と SIGINT（`requestStop` 委譲）を実装する。

**依存タスク**: Task 2（`src/types.ts`: `RunRow` / `TaskSessionRow` / `RunState` / `SessionState` / `FailureReason` / `NotifyEvent`）, Task 3（`src/exec.ts`: `RealCommandRunner`）, Task 4（`src/config.ts`: `loadConfig` / `Config`）, Task 5（`src/store.ts`: `SqliteStore` 全メソッド）, Task 6（`src/notifier.ts`: `ConsoleSlackNotifier`）, Task 7（`src/task-source.ts`: `LinearTaskSource` / `resolveLinearSetup` / `LinearSetupRequest` / `ResolvedLinearSetup`）, Task 8（`src/git-pr.ts`: `GitPrManager`）, Task 9（`src/agent-runner.ts`: `ClaudeAgentRunner`）, Task 10（`src/monitor.ts`: `GhLoopPilotMonitor`）, Task 11（`src/context-bundle.ts`: `buildPrompt`）, Task 12-13（`src/orchestrator.ts`: `Orchestrator` + `requestStop`／回復処理は Task 12-13 に統合、Task 14 ファイルは存在しない）, Task 15（`src/preflight.ts`: `runPreflight` / `PreflightDeps`）。

> **注記（カーネル・依存タスクとの整合）**: 本タスクの単体テスト対象は `src/status.ts` のみ（`tests/status.test.ts`）。`src/main.ts` は配線のみで**単体テスト対象外**（手動 E2E 検証は Task 17）。`renderStatus(store: SqliteStore): string` のシグネチャはカーネル §1（`src/status.ts # renderStatus(store) → string`）と §10 に一致。
>
> `main.ts` が消費する具象構築シグネチャはカーネルが完全には固定していないため、**依存タスクの確定済み export に合わせて**配線する（カーネルに無い構築引数は依存タスクが source of truth）。本タスク執筆時点で各依存セクションから確認済みの実シグネチャ:
> - `loadConfig(configPath: string, env: NodeJS.ProcessEnv): Config`（Task 4）。`Config` は camelCase。`slackWebhookUrl: string | undefined`、`stateDbPath: string`。
> - `new RealCommandRunner()`（引数なし、Task 3）。
> - `new ConsoleSlackNotifier(store: SqliteStore, webhookUrl: string | null, log: (s: string) => void, fetchFn?, sleep?, clock?)`（Task 6）。第2引数は `string | null`（`config.slackWebhookUrl ?? null`）、第3引数は **log**（clock ではない）。
> - `resolveLinearSetup(apiKey: string, req: LinearSetupRequest, fetchFn: FetchFn): Promise<ResolvedLinearSetup>`（Task 7、**位置引数3つ**）。`ResolvedLinearSetup` = `{ viewerId, teamId, projectId, stateIds: Record<TicketState,string>, optInLabelId }`。解決失敗は throw。
> - `new LinearTaskSource({ apiKey, projectId, stateIds, optInLabel, fetchFn })`（Task 7、`LinearTaskSourceOptions`）。
> - `new GitPrManager(runner, { repoPath, remote, defaultBranch, branchPrefix, worktreeRoot, prBodyTemplate, gateLabel })`（Task 8）。
> - `new ClaudeAgentRunner(runner, { model, allowedTools, extraArgs, log })`（Task 9）。
> - `new GhLoopPilotMonitor(runner, { remote, trustedAuthors })`（Task 10）。
> - `new Orchestrator(deps: OrchestratorDeps)` + public `requestStop(): void`（Task 12-13）。`run()` は**内部で** `notifier.notify({ kind: "run_started", ... })` を送る（カーネル §7）ため、main.ts は run_started を**二重送信しない**。
> - `runPreflight(deps: PreflightDeps): Promise<string[]>`（Task 15）。`PreflightDeps = { config, runner, notifier, fetchFn: FetchFn }`（`FetchFn` は Task 7/15 と同一の narrow 型。`globalThis.fetch` は構造的に代入可能）。戻り値は**エラーメッセージ文字列の配列**（空配列=合格）。
>
> 依存タスク間に未解決の不整合（特に `resolveLinearSetup` の引数形と preflight が叩く Linear クエリ shape）があるため、固定できない点は openQuestions に列挙する（勝手に確定しない）。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/status.ts`
- Create: `/home/racoma-dev/loop-pilot-os/src/main.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/status.test.ts`

---

#### Part A — `src/status.ts`（renderStatus）: TDD

- [ ] **Step 1: 失敗するテストファイルを作成する（DB が空/Run 無しの文面）。** `tests/status.test.ts` を以下の内容で新規作成する。最初のテストだけ通る形にせず、`renderStatus` を import するため import エラーで全体が失敗する。

  ```typescript
  import { describe, it, expect } from "vitest";
  import { SqliteStore } from "../src/store.js";
  import { renderStatus } from "../src/status.js";

  // 仕様 §10: status CLI は Run + TaskSession から現在セッション・キュー・履歴・停止箇所を表示。
  // 状態の真実は SQLite。renderStatus は副作用なしで store を読み、人間可読の1文字列を返す。

  function makeStore(): SqliteStore {
    return new SqliteStore(":memory:");
  }

  describe("renderStatus", () => {
    it("Run が一度も作られていなければ no-run の案内を返す（DB はあるが Run 無し）", () => {
      const store = makeStore();
      try {
        const out = renderStatus(store);
        expect(out).toContain("LoopPilot OS status");
        expect(out).toContain("No run found");
        // Run が無いので活性セッション/履歴/通知のセクションは出さない
        expect(out).not.toContain("Active session");
      } finally {
        store.close();
      }
    });
  });
  ```

- [ ] **Step 2: 失敗を確認する。** 次を実行する。

  ```
  npx vitest run tests/status.test.ts
  ```

  期待される失敗: `Failed to resolve import "../src/status.js"`（`src/status.ts` 未作成のため import 解決エラーでスイート全体が fail）。

- [ ] **Step 3: 最小実装で no-run 文面だけ通す。** `src/status.ts` を新規作成し、最新 Run が無い場合の文面だけ返す最小実装を書く。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { RunRow, TaskSessionRow } from "./types.js";

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    return lines.join("\n");
  }
  ```

- [ ] **Step 4: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行し、Step 1 のテストが green になることを確認する（期待: 1 passed）。

- [ ] **Step 5: コミット（red→green の最初の単位）。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus no-run case"
  ```

  `npm run check` 期待出力: tsc×2 と vitest が全て成功（exit 0）。

- [ ] **Step 6: 失敗するテストを追加（最新 Run サマリ: running・上限 vs 着手数・merged 数）。** `tests/status.test.ts` の `describe("renderStatus", ...)` 内に次の `it` を追記する。

  ```typescript
    it("最新 Run の state・開始時刻・タスク上限 vs 着手数・merged 数を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        // 着手 2 件・うち 1 件 merged
        const s1 = store.createSession({
          runId: run.id, linearIssueId: "u1", linearIdentifier: "TY-1",
          issueTitle: "First", branch: "looppilot/ty-1-first",
          worktreePath: "/wt/1", now: "2026-06-05T10:01:00.000Z",
        });
        store.updateSession(s1.id, {
          state: "merged", costUsd: 2.5,
          agentSummary: "did first", endedAt: "2026-06-05T10:05:00.000Z",
        });
        store.createSession({
          runId: run.id, linearIssueId: "u2", linearIdentifier: "TY-2",
          issueTitle: "Second", branch: "looppilot/ty-2-second",
          worktreePath: "/wt/2", now: "2026-06-05T10:06:00.000Z",
        });

        const out = renderStatus(store);
        expect(out).toContain(`Run #${run.id}`);
        expect(out).toContain("state: running");
        expect(out).toContain("started: 2026-06-05T10:00:00.000Z");
        expect(out).toContain("tasks: 2/3 started");   // countTasksStarted / taskCap
        expect(out).toContain("merged: 1");            // countMerged
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 7: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "state: running"` 等。Step 3 実装は `Run #<id>` までしか出さない）。

- [ ] **Step 8: Run サマリを実装する。** `src/status.ts` の Run 表示部を拡張する。`run` が non-null の分岐を以下に置き換える。

  ```typescript
    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }
    return lines.join("\n");
  ```

- [ ] **Step 9: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行し、全テスト green（期待: 2 passed）。

- [ ] **Step 10: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus latest-run summary"
  ```

- [ ] **Step 11: 失敗するテストを追加（halted Run の halt 理由表示）。** `describe` 内に追記する。

  ```typescript
    it("Run が halted のときは halt 理由を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        store.setRunState(run.id, "halted", "task cap reached (3/3)");
        const out = renderStatus(store);
        expect(out).toContain("state: halted");
        expect(out).toContain("halt reason: task cap reached (3/3)");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 12: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（halt 分岐は Step 8 で実装済みのため即 pass。仕様の「停止箇所を表示」を回帰で固定）。一度でも red にしたい場合は Step 8 を分割していないため本ステップは回帰確認として扱い、red を経ずにコミットへ進む。

- [ ] **Step 13: コミット。**

  ```
  npm run check
  git add tests/status.test.ts
  git commit -m "test: renderStatus halt-reason regression"
  ```

- [ ] **Step 14: 失敗するテストを追加（活性セッション詳細: state/identifier/branch/PR/経過）。** `describe` 内に追記する。

  ```typescript
    it("活性セッション（merged/stopped 以外）の state・identifier・branch・PR・経過を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        const s = store.createSession({
          runId: run.id, linearIssueId: "u9", linearIdentifier: "TY-9",
          issueTitle: "Monitoring task", branch: "looppilot/ty-9-monitoring-task",
          worktreePath: "/wt/9", now: "2026-06-05T10:02:00.000Z",
        });
        store.updateSession(s.id, {
          state: "in_review", prNumber: 42,
          monitorStartedAt: "2026-06-05T10:03:00.000Z",
        });

        const out = renderStatus(store);
        expect(out).toContain("Active session");
        expect(out).toContain("TY-9");
        expect(out).toContain("state: in_review");
        expect(out).toContain("branch: looppilot/ty-9-monitoring-task");
        expect(out).toContain("PR #42");
        // 経過は monitorStartedAt があれば since 起点で表示
        expect(out).toContain("monitoring since 2026-06-05T10:03:00.000Z");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 15: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "Active session"`。未実装）。

- [ ] **Step 16: 活性セッションセクションを実装する。** `src/status.ts` の `return lines.join("\n");`（Run サマリ末尾の return）を削除し、Run サマリの後ろに活性セッションセクションを追加する。具体的には Step 8 で置換した分岐の末尾 `return lines.join("\n");` を、以下のヘルパ呼び出し＋最終 return に差し替える。まずファイル全体を次の完全形へ置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      // 重複可読化: ヘッダ外でも "PR #<n>" を含める（grep 容易化）
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 17: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（4 passed）。`PR #42` は header 行と `(tracking PR #42)` の両方に出るため `toContain("PR #42")` が満たされる。

- [ ] **Step 18: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus active-session detail"
  ```

- [ ] **Step 19: 失敗するテストを追加（直近 10 セッション表: identifier/state/failure_reason/cost）。** `describe` 内に追記する。

  ```typescript
    it("直近 10 セッションを identifier/state/failure_reason/cost の表で出す（新しい順、最大 10 件）", () => {
      const store = makeStore();
      try {
        const run = store.createRun(20, "2026-06-05T09:00:00.000Z");
        // 12 セッション作成。最古 (TY-100) は表から溢れる想定。
        for (let i = 0; i < 12; i++) {
          const n = 100 + i;
          const s = store.createSession({
            runId: run.id, linearIssueId: `u${n}`, linearIdentifier: `TY-${n}`,
            issueTitle: `Task ${n}`, branch: `looppilot/ty-${n}`,
            worktreePath: `/wt/${n}`,
            now: `2026-06-05T09:${String(10 + i).padStart(2, "0")}:00.000Z`,
          });
          if (i === 11) {
            // 最新: stopped(ci_failed) cost 付き
            store.updateSession(s.id, {
              state: "stopped", failureReason: "ci_failed", costUsd: 4.2,
              endedAt: "2026-06-05T09:30:00.000Z",
            });
          } else {
            store.updateSession(s.id, {
              state: "merged", costUsd: 1.0,
              endedAt: `2026-06-05T09:${String(15 + i).padStart(2, "0")}:00.000Z`,
            });
          }
        }

        const out = renderStatus(store);
        expect(out).toContain("Recent sessions");
        // 最新行: identifier / state / failure_reason / cost が全て出る
        expect(out).toContain("TY-111");
        expect(out).toContain("stopped");
        expect(out).toContain("ci_failed");
        expect(out).toContain("$4.20");
        // 11 件目以前 = 表は 10 件のみなので最古 TY-100 は出ない
        expect(out).not.toContain("TY-100");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 20: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "Recent sessions"`。未実装）。

- [ ] **Step 21: 直近セッション表を実装する。** `src/status.ts` の active セクションの後ろ（最終 `return lines.join("\n");` の直前）に、`store.recentSessions(10)` を使った表を追加する。ファイル全体を次の完全形へ置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  function recentRow(s: TaskSessionRow): string {
    const reason = s.failureReason ?? "-";
    return `  ${s.linearIdentifier.padEnd(10)} ${s.state.padEnd(12)} ${reason.padEnd(20)} ${fmtCost(s.costUsd)}`;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    lines.push("");
    const recent = store.recentSessions(10);
    lines.push("Recent sessions (latest 10)");
    if (recent.length === 0) {
      lines.push("  (none)");
    } else {
      lines.push(`  ${"id".padEnd(10)} ${"state".padEnd(12)} ${"failure_reason".padEnd(20)} cost`);
      for (const s of recent) {
        lines.push(recentRow(s));
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 22: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（5 passed）。`recentSessions(10)` が新しい順 10 件を返す前提（カーネル §4 `recentSessions(n)` は status CLI 用）なので `TY-100` は溢れる。

- [ ] **Step 23: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus recent-sessions table"
  ```

- [ ] **Step 24: 失敗するテストを追加（未配信通知の警告）。** `describe` 内に追記する。`recordIntent` の payload は `NotifyEvent` の JSON（カーネル §4 コメント）。

  ```typescript
    it("未配信の通知 intent があれば警告を出し、無ければ警告を出さない", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        void run;
        const payload = JSON.stringify({
          kind: "halted",
          reason: "looppilot_stopped",
          detail: "PR #42 stopped",
        });
        // Slack 設定済み (slackConfigured=true) → delivered_slack=0 のまま未配信
        const intentId = store.recordIntent(payload, true, "2026-06-05T10:10:00.000Z");
        void intentId;

        const out = renderStatus(store);
        expect(out).toContain("WARNING");
        expect(out).toContain("undelivered notification");

        // 配信済みにすると警告は消える
        store.markDelivered(intentId, "console");
        store.markDelivered(intentId, "slack");
        const out2 = renderStatus(store);
        expect(out2).not.toContain("undelivered notification");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 25: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "WARNING"`。未実装）。

- [ ] **Step 26: 未配信通知警告を実装する。** `src/status.ts` の最終 `return lines.join("\n");` の直前に未配信警告ブロックを追加する。`recentRow`/`activeDetail`/`fmtCost` は既存のまま、`renderStatus` 本体の recent セクションの後ろに次を挿入する形でファイル全体を次の完全形に置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  function recentRow(s: TaskSessionRow): string {
    const reason = s.failureReason ?? "-";
    return `  ${s.linearIdentifier.padEnd(10)} ${s.state.padEnd(12)} ${reason.padEnd(20)} ${fmtCost(s.costUsd)}`;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    lines.push("");
    const recent = store.recentSessions(10);
    lines.push("Recent sessions (latest 10)");
    if (recent.length === 0) {
      lines.push("  (none)");
    } else {
      lines.push(`  ${"id".padEnd(10)} ${"state".padEnd(12)} ${"failure_reason".padEnd(20)} cost`);
      for (const s of recent) {
        lines.push(recentRow(s));
      }
    }

    const undelivered = store.undeliveredIntents();
    if (undelivered.length > 0) {
      lines.push("");
      lines.push(`WARNING: ${undelivered.length} undelivered notification(s):`);
      for (const u of undelivered) {
        lines.push(`  intent #${u.id} (attempts: ${u.attempts}) ${u.payload}`);
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 27: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（6 passed）。

- [ ] **Step 28: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus undelivered-notification warning"
  ```

---

#### Part B — `src/main.ts`（CLI 配線・単体テスト対象外）

> 配線のみで単体テスト対象外（手動 E2E は Task 17）。したがって red→green のテスト駆動はせず、`npm run check`（tsc が `main.ts` を型検査する）を緑にしてコミットする。`main.ts` は `src/` 配下なので tsconfig（src のみ）の typecheck 対象になる。コードは完全形で示す。

- [ ] **Step 29: `src/main.ts` を完全形で作成する。** カーネル §1（CLI: `run`/`status`, `--config` 既定 `./looppilot-os.toml`, 引数解析 `node:util` `parseArgs`）, §7（DI: `new Orchestrator({ config, source, agent, git, monitor, notifier, store, buildPrompt, clock, sleep, log })`）, §9（プリフライト→違反列挙して exit 1）に従う。`process.exitCode` 規約: 正常 0 / プリフライト違反 1 / HALT 2。SIGINT は orchestrator の協調停止（`requestStop`）に委譲し、ハンドラ重複登録を防ぐ。

  **配線上の重要点（依存タスク確定シグネチャに一致）**:
  - 各具象は**位置 `runner` + options オブジェクト**で構築する（`GitPrManager` / `ClaudeAgentRunner` / `GhLoopPilotMonitor`）。`LinearTaskSource` は単一 options オブジェクト。
  - Linear 解決 `resolveLinearSetup(apiKey, req, fetchFn)` は**HTTP `fetch` を使う**（`CommandRunner` ではない）。Node 24 ネイティブ `globalThis.fetch` を渡す。
  - `ConsoleSlackNotifier(store, webhookUrl: string | null, log)` — 第2引数は `config.slackWebhookUrl ?? null`、第3引数は **log**（コンソール出力関数）。
  - `runPreflight({ config, runner, notifier, fetchFn })` は**文字列配列**を返す（空＝合格）。`fetchFn` は `globalThis.fetch`。
  - `run_started` 通知は **`orchestrator.run()` が内部で送る**（カーネル §7）。main.ts は二重送信**しない**。
  - `Config.linear.states` は camelCase（`todo`/`inProgress`/`inReview`/`done`）だが、`resolveLinearSetup` の `LinearSetupRequest.stateNames` と `LinearTaskSource` の `stateIds` は `TicketState`（`"todo" | "in_progress" | "in_review" | "done"`）キー。`config` 値から `TicketState` キーの `stateNames` を組み、解決結果 `ResolvedLinearSetup.stateIds`（既に `Record<TicketState,string>`）をそのまま `LinearTaskSource` へ渡す。

  ```typescript
  import { parseArgs } from "node:util";
  import process from "node:process";

  import type { TicketState } from "./types.js";
  import { loadConfig } from "./config.js";
  import { SqliteStore } from "./store.js";
  import { RealCommandRunner } from "./exec.js";
  import { ConsoleSlackNotifier } from "./notifier.js";
  import {
    LinearTaskSource,
    resolveLinearSetup,
    type LinearSetupRequest,
  } from "./task-source.js";
  import { GitPrManager } from "./git-pr.js";
  import { ClaudeAgentRunner } from "./agent-runner.js";
  import { GhLoopPilotMonitor } from "./monitor.js";
  import { buildPrompt } from "./context-bundle.js";
  import { Orchestrator } from "./orchestrator.js";
  import { runPreflight } from "./preflight.js";
  import { renderStatus } from "./status.js";

  const EXIT_OK = 0;
  const EXIT_PREFLIGHT = 1;
  const EXIT_HALTED = 2;

  function nowIso(): string {
    return new Date().toISOString();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function logLine(line: string): void {
    process.stdout.write(line + "\n");
  }

  function parseCli(argv: string[]): { command: string; configPath: string } {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", default: "./looppilot-os.toml" },
      },
    });
    const command = positionals[0] ?? "";
    return { command, configPath: values.config as string };
  }

  async function runStatus(configPath: string): Promise<number> {
    const config = loadConfig(configPath, process.env);
    const store = new SqliteStore(config.stateDbPath);
    try {
      process.stdout.write(renderStatus(store) + "\n");
      return EXIT_OK;
    } finally {
      store.close();
    }
  }

  async function runLoop(configPath: string): Promise<number> {
    const config = loadConfig(configPath, process.env);
    const store = new SqliteStore(config.stateDbPath);
    try {
      const runner = new RealCommandRunner();
      const notifier = new ConsoleSlackNotifier(
        store,
        config.slackWebhookUrl ?? null,
        logLine,
      );

      // プリフライト: 違反を全件収集 → 列挙して exit 1（仕様 §8 / カーネル §9）。
      // fetchFn は Node 24 ネイティブ fetch。Linear 解決もこの中で fetch を使う。
      const preflightErrors = await runPreflight({
        config,
        runner,
        notifier,
        fetchFn: globalThis.fetch,
      });
      if (preflightErrors.length > 0) {
        process.stderr.write("Preflight failed:\n");
        for (const message of preflightErrors) {
          process.stderr.write(`  - ${message}\n`);
        }
        return EXIT_PREFLIGHT;
      }

      // Linear の team/project/4状態/オプトインラベルを ID へ解決。
      // config の camelCase 状態名 → TicketState キーへ写像して渡す。
      const stateNames: Record<TicketState, string> = {
        todo: config.linear.states.todo,
        in_progress: config.linear.states.inProgress,
        in_review: config.linear.states.inReview,
        done: config.linear.states.done,
      };
      const setupRequest: LinearSetupRequest = {
        teamKey: config.linear.team,
        projectName: config.linear.project,
        stateNames,
        optInLabel: config.linear.optInLabel,
      };
      const linearSetup = await resolveLinearSetup(
        config.linearApiKey,
        setupRequest,
        globalThis.fetch,
      );

      const source = new LinearTaskSource({
        apiKey: config.linearApiKey,
        projectId: linearSetup.projectId,
        stateIds: linearSetup.stateIds,
        optInLabel: config.linear.optInLabel,
        fetchFn: globalThis.fetch,
      });
      const agent = new ClaudeAgentRunner(runner, {
        model: config.agent.model,
        allowedTools: config.agent.allowedTools,
        extraArgs: config.agent.extraArgs,
        log: logLine,
      });
      const git = new GitPrManager(runner, {
        repoPath: config.repo.path,
        remote: config.repo.remote,
        defaultBranch: config.repo.defaultBranch,
        branchPrefix: config.handoff.branchPrefix,
        worktreeRoot: config.repo.worktreeRoot,
        prBodyTemplate: config.handoff.prBodyTemplate,
        gateLabel: config.looppilot.gateLabel,
      });
      const monitor = new GhLoopPilotMonitor(runner, {
        remote: config.repo.remote,
        trustedAuthors: config.looppilot.stateCommentAuthors,
      });

      const orchestrator = new Orchestrator({
        config,
        source,
        agent,
        git,
        monitor,
        notifier,
        store,
        buildPrompt,
        clock: nowIso,
        sleep,
        log: logLine,
      });

      // SIGINT → orchestrator.requestStop()（次の安全点でクリーン halt）。
      // run_started 通知は orchestrator.run() が内部で送る（カーネル §7）。
      let interrupted = false;
      const onSigint = (): void => {
        if (interrupted) return;
        interrupted = true;
        process.stderr.write(
          "\nSIGINT received: stopping at next safe point...\n",
        );
        orchestrator.requestStop();
      };
      process.on("SIGINT", onSigint);

      try {
        await orchestrator.run();
      } finally {
        process.removeListener("SIGINT", onSigint);
      }

      // HALT 終端なら exit 2、それ以外（idle で綺麗に止まった等）は 0。
      const finalRun = store.latestRun();
      return finalRun !== null && finalRun.state === "halted"
        ? EXIT_HALTED
        : EXIT_OK;
    } finally {
      store.close();
    }
  }

  async function main(): Promise<void> {
    const { command, configPath } = parseCli(process.argv.slice(2));
    switch (command) {
      case "run":
        process.exitCode = await runLoop(configPath);
        return;
      case "status":
        process.exitCode = await runStatus(configPath);
        return;
      default:
        process.stderr.write(
          "Usage: looppilot-os <run|status> [--config <path>]\n",
        );
        process.exitCode = EXIT_PREFLIGHT;
    }
  }

  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exitCode = EXIT_PREFLIGHT;
  });
  ```

- [ ] **Step 30: 型検査を通す。** 次を実行する。

  ```
  npm run check
  ```

  期待出力: tsc（src）・tsc（tsconfig.test.json）・vitest が全て成功（exit 0）。本ステップのコードは執筆時点で確認済みの依存タスク export（Task 3/4/6/7/8/9/10/12-13/15）と一致させてある。**もし** `RealCommandRunner` / `resolveLinearSetup` / `LinearTaskSource` / `ConsoleSlackNotifier` / `GitPrManager` / `ClaudeAgentRunner` / `GhLoopPilotMonitor` / `runPreflight` / `requestStop` のいずれかが依存タスク実装と不一致で型エラーが出た場合は、ここで**勝手にシグネチャを変えず**、不一致内容を Task 16 の openQuestions として記録し、依存タスク側の確定 export に合わせて本ステップのコードのみを修正する（カーネルが固定していない構築シグネチャはカーネルではなく依存タスクの export が source of truth）。
  - 整合確認（解消済み）: Task 15（preflight）の `checkLinear`（task-15 Step 16）は `await resolveLinearSetup(config.linearApiKey, req, fetchFn)`（位置引数3つ）で呼んでおり、Task 7（task-source）の export `resolveLinearSetup(apiKey, req, fetchFn)` と整合している。本 main.ts も同じ **Task 7 の3引数形**に合わせており、Task 7・15・16 は同時にコンパイル可能（不整合なし）。

- [ ] **Step 31: コミット。**

  ```
  git add src/main.ts
  git commit -m "feat: main CLI wiring (run/status, DI, preflight, SIGINT)"
  ```

- [ ] **Step 32: 章全体の最終確認。** `npm run check` を最後にもう一度実行し、`src/status.ts` / `src/main.ts` / `tests/status.test.ts` 込みで全 green（exit 0）であることを確認する。`tests/status.test.ts` は 6 passed。`git status` がクリーンであることを確認する。


---

### Task 17: README + 手動E2E手順

**目的**: ユーザーが LoopPilot OS v1 をゼロから設定・起動・観測・トラブルシュートできるよう、Task 1 で骨子だけ置いた `README.md` を完成形に書き換える（Create ではなく **Modify**）。概要 / アーキテクチャ図 / セットアップ / `run`・`status` の使い方 / 失敗時の `failure_reason` 一覧表（カーネル §2 の10種）/ 回復の挙動 / 手動 E2E チェックリスト（仕様 §12 の完了定義どおり）を記述する。あわせて `looppilot-os.example.toml` が Task 1 でカーネル §3 と一字一句一致して作られていることを最終確認する（差分があれば openQuestions で報告し、自分では書き換えない）。

**依存タスク**: Task 1（`README.md` 骨子・`looppilot-os.example.toml` を作成済み）。内容の正確性は Task 16（`status` CLI 配線・`looppilot-os` bin）まで通った状態を前提に記述するが、本タスク自体はドキュメントのみで実コードに依存しない。これは **コード変更なしのドキュメントタスク**であり、計画フォーマットの TDD（red→green）は例外とする（カーネル §10 の TDD は「全タスク red→green」だが本タスクはテスト対象コードを持たない。各ステップに検証コマンドと期待出力を付けて担保する）。

**カーネル参照**: §0（CLI 契約: bin `looppilot-os` / サブコマンド `run`・`status` / `--config <path>` 既定 `./looppilot-os.toml`）、§2（`FailureReason` 10種・`NotifyEvent` 3種）、§3（Config TOML 全文 = example.toml の正）、§7（Orchestrator 規約）、§8（回復処理）、§9（プリフライト10項目）。仕様参照: §4（アーキテクチャ図 ASCII）、§8（設定・プリフライト）、§9（回復ルール）、§10（可観測性・通知）、§11（安全弁）、§12（v1 完了定義）。

**実検証済みの実物（2026-06-05）**:
- 外部 CLI: Node `v24.15.0` / `gh 2.92.0`（認証済み account `racoma-dev`）/ `claude 2.1.165`（認証済み）。
- LoopPilot 連携契約の裏取り（`/home/racoma-dev/loop-pilot` ソース）:
  - `src/state-manager.ts`: `STATE_MARKER="looppilot-state"`、可視テキスト `"LoopPilot state is stored in this comment."`、`VALID_STATUSES = {initialized, waiting_codex, fixing, done, stopped}`、`stopReason` は文字列 or `null`。
  - `.github/workflows/looppilot-init.yml`: トリガ `types: [opened, ready_for_review, labeled]`（= PR は ready-for-review で作成しラベルを後付けすれば Init が発火する。カーネル §5.3 の「draft にしない」と整合）。
- 既存ファイル: `README.md` と `looppilot-os.example.toml` は Task 1 が作成済み（本タスクは README を Modify、example.toml は読み取り確認のみ）。

**絶対規則の遵守**: 触ってよい実ファイルは `README.md` のみ。`looppilot-os.example.toml` は**読むだけ**（一致確認）で書き換えない。`docs/superpowers/plans/` 配下（本セクションファイル以外）・カーネル・仕様・`src/`・`tests/`・`package.json` 等は一切変更しない。

**作業ディレクトリ**: `/home/racoma-dev/loop-pilot-os`（Task 1〜16 完了済み・git 初期化済み・`origin` 設定済み）。コマンドは絶対パス（`git -C <abs>` 等）で行い `cd` を避ける。

#### Files

- Modify: `/home/racoma-dev/loop-pilot-os/README.md`
- Read-only（確認のみ・変更しない）: `/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml`

---

- [ ] **Step 1: `looppilot-os.example.toml` がカーネル §3 と一致することを最終確認する**

example.toml を読み、カーネル §3 の TOML 全文（`[product]` … `[notify]`、全キー・既定値・コメント）と**一字一句一致**することを確認する。本タスクは README からこのファイルを参照するため、ここでの一致が前提条件になる。

```bash
cat /home/racoma-dev/loop-pilot-os/looppilot-os.example.toml
```

期待: カーネル §3 と完全一致する以下のセクション/キーが揃っている — `[product].goal` / `[repo].path,remote,default_branch`（+ `worktree_root` 省略時コメント）/ `[linear].team,project,opt_in_label` と `[linear.states].todo,in_progress,in_review,done` / `[agent].model,allowed_tools`（+ `extra_args` コメント）/ `[handoff].branch_prefix,pr_body_template`（複数行 `"""..."""`、`{identifier}` `{title}` `{issue_url}` プレースホルダ）/ `[looppilot].gate_label,state_comment_authors` / `[safety].max_tasks_per_run,max_cost_usd_per_session`（+ `monitor_timeout_minutes` コメント）`,not_engaged_guard_minutes` / `[loop].monitor_poll_seconds,idle_recheck_seconds` / `[digest].recent_merged_count` / `[notify]`（Slack は env のコメントのみ）。

差分が一切なければ次ステップへ。**差分があった場合は example.toml を書き換えず、その差分内容を openQuestions に記録して報告する**（カーネル/設定の不整合は勝手に直さない）。

- [ ] **Step 2: 現在の `README.md`（Task 1 骨子）を読み、置換対象を把握する**

Task 1 が書いた骨子の全文を確認する。本タスクは「`## セットアップ（骨子。詳細は Task 17 で完成）`」以降を中心に完成形へ差し替えるため、現行テキストを正確に把握しておく。

```bash
cat /home/racoma-dev/loop-pilot-os/README.md
```

期待: Task 1 の骨子（タイトル + 概要1段落 + `## 必要環境` + `## セットアップ（骨子。詳細は Task 17 で完成）` + `## 開発` + 末尾の「> このセクションは骨子です…Task 17 で記述します。」引用）が表示される。以降のステップで Write により**ファイル全体を完成形へ置換**する。

- [ ] **Step 3: `README.md` を完成形に書き換える（Write でファイル全体を置換）**

`/home/racoma-dev/loop-pilot-os/README.md` を以下の完全な内容で**全置換**する。アーキテクチャ図は仕様 §4 の ASCII を流用、`failure_reason` 表はカーネル §2 の10種・意味（仕様 §7/§5 と整合）、回復の挙動はカーネル §8 / 仕様 §9、手動 E2E チェックリストは仕様 §12 の完了定義どおり。値・キー名はすべてカーネル §3 / §0 の確定値に一致させる。

````markdown
# LoopPilot OS

LoopPilot OS は、AIコーディングエージェント（Claude Code ヘッドレス）によるプロダクト開発ループを、人間の都度指示なしで回す**ローカル CLI 常駐オーケストレーター**です。Linear の適格チケットを選定し、git worktree でエージェントを起動して実装・PR 作成まで行い、既存の [LoopPilot](https://github.com/team-yubune/loop-pilot)（PR 上で codex レビュー → Claude 修正 → チェックを回す GitHub Actions システム）へ `loop-pilot` ラベルで受け渡します。LoopPilot がクリーン到達（PR 上の `looppilot-state` 隠しコメントが `done`）したことを検知すると、**オーケが**（LoopPilot ではなく）squash マージし、Linear チケットを Done にして次タスクへ進みます。キュー空 or タスク上限で**通知して綺麗に停止**します。

状態はすべて SQLite（`looppilot-os.db`）に永続化され、再起動時は「`in_review` + オープン PR」を照合して継続できます。1タスク = 1セッション = 1PR、逐次実行（並列なし）。失敗（CI 赤・コンフリクト・LoopPilot 停止・監視未起動など）は**人間に上げてループ全体を停止**します。

> **v1 スコープ**: 既存チケット駆動のコアループのみ。QA/バグ自動発見・チケット自動生成・タスク内セッション再開・横断メモリ・並列・複数リポ・Linear 以外のタスク源は v2 送りです。

## アーキテクチャ

疎結合・単一責任のモジュール群を Orchestrator Core が統括し、外部はインターフェース越しに呼びます（仕様 §4）。

```
                ┌─────────────────────────────────────────┐
                │           Orchestrator Core              │
                │  ループ駆動 / per-task状態機械 / 安全弁    │
                │  / 文脈バンドル組立 / プリフライト          │
                └──┬──────┬───────┬────────┬──────┬─────────┘
            TaskSource  Agent   Git/PR   LoopPilot  Notifier
            (Linear)    Runner  Manager  Monitor
                │        │        │         │         │
            Linear API  Claude  git/gh    GitHub API  Slack/console
                        headless          (PR + 隠しコメント)
                          └────── State Store (SQLite) ──────┘  ◄── Status CLI / Config
```

per-task ライフサイクル（状態機械、仕様 §5）:

```
SELECT ─→ CLAIM ─→ IMPLEMENT ─→ HANDOFF ─→ MONITOR ─→ DONE ─→ (次の SELECT)
  │         │          │           │          │
  │         │          │           │          └─ stopped/closed/CI赤/未起動 → STOPPED → HALT
  │         │          │           └─ push/ラベル/遷移 失敗 → STOPPED → HALT
  │         │          └─ 無変更/コスト超/例外 → STOPPED → HALT
  │         └─ worktree/遷移 失敗 → STOPPED → HALT
  └─ 適格なし → IDLE（通知 + 定期再確認） ／ タスク上限到達 → HALT（通知）
```

- **SELECT**: 指定 Team/PJ ∧ Todo ∧ オプトインラベルを決定的順序（意味的優先度 Urgent>High>Medium>Low>No → sortOrder 昇順 → issue id）で選ぶ。進行中セッションを持つチケットは除外。
- **CLAIM**: デフォルトブランチから `<prefix>/<identifier小文字>-<slug>` ブランチ + worktree を切り、Linear を In Progress に。
- **IMPLEMENT**: worktree 内で `claude -p` をコスト上限付き起動。**実差分**（`origin/<defaultBranch>..HEAD`）で後条件を判定（自己申告は信用しない）。
- **HANDOFF**: push → PR 作成（ready-for-review・**draft 不可**）→ PR 番号を即永続化 → `loop-pilot` ラベル付与 → Linear を In Review に。
- **MONITOR**: `looppilot-state` 隠しコメント + PR の merged を一定間隔でポーリング。監視中は PR/ブランチに書き込まない（マージを除く）。
- **DONE**: `merged` を先に永続化 → Linear を Done に（best-effort・既 Done 許容）→ 次の SELECT へ。

## 必要環境

- Node.js >= 24
- `git`
- `gh`（GitHub CLI、**認証済み** = `gh auth status` が通る。対象リポへの push 権限が必要）
- `claude`（Claude Code CLI、**認証済み** = `claude --version` が通る）
- 対象リポに [LoopPilot](https://github.com/team-yubune/loop-pilot) が導入済み（Init/Loop ワークフローが `loop-pilot` ラベルで発火する状態）

## セットアップ

設定は一度だけ。手順は以下の通りです。

### 1. インストールとビルド

依存をインストールし、`npm run build`（`tsc`）で TypeScript を `dist/` へコンパイルします。

```bash
npm install
npm run build
```

`looppilot-os` は `dist/main.js` を指します。`npm run build` で `dist/main.js` が生成されたら `npx looppilot-os ...`、またはグローバルリンク（`npm link`）して `looppilot-os ...` で起動できます。以降の例では `looppilot-os` と表記します。

### 2. 設定ファイルを用意する

example をコピーして実設定を作ります（実設定 `looppilot-os.toml` は `.gitignore` 済みでコミットされません）。

```bash
cp looppilot-os.example.toml looppilot-os.toml
```

`looppilot-os.toml` を対象リポ/Linear に合わせて編集します。主なキー（全キーは `looppilot-os.example.toml` のコメント参照）:

| セクション.キー | 意味 |
| -- | -- |
| `product.goal` | プロダクトのゴールと制約。毎セッションのプロンプト冒頭に入る |
| `repo.path` | 対象リポのローカル絶対パス（クリーンな git 作業ツリーで default_branch 上） |
| `repo.remote` | GitHub の `owner/name` |
| `repo.default_branch` | 基底ブランチ（`main` とは限らない） |
| `repo.worktree_root` | 省略時 `~/.looppilot-os/worktrees/<repoのdir名>` |
| `linear.team` | Linear の team key（例 `TY`） |
| `linear.project` | Project 名（プリフライトで ID 解決・検証） |
| `linear.opt_in_label` | AI 着手を許可するオプトインラベル名 |
| `linear.states.{todo,in_progress,in_review,done}` | 状態名 → プリフライトで stateId に解決 |
| `agent.model` | `claude --model` に渡すモデル（例 `opus`） |
| `agent.allowed_tools` | `claude --allowedTools`（例 `Edit,Write,Read,Glob,Grep,Bash`） |
| `agent.extra_args` | 任意の追加 claude フラグ（既定なし） |
| `handoff.branch_prefix` | ブランチ接頭辞（例 `looppilot`） |
| `handoff.pr_body_template` | PR 本文テンプレ。`{identifier}` `{title}` `{issue_url}` を置換 |
| `looppilot.gate_label` | 対象リポの `LOOPPILOT_LABEL` に一致させる（既定 `loop-pilot`・大小無視） |
| `looppilot.state_comment_authors` | LoopPilot の信頼著者（既定 `["github-actions[bot]"]`） |
| `safety.max_tasks_per_run` | 1 ラン中の着手上限（到達で HALT） |
| `safety.max_cost_usd_per_session` | 1 セッションのコスト上限（`claude --max-budget-usd`） |
| `safety.monitor_timeout_minutes` | 全体監視のタイムアウト（任意・既定オフ／コメントアウト） |
| `safety.not_engaged_guard_minutes` | LoopPilot 未起動ガード（常時オン） |
| `loop.monitor_poll_seconds` | MONITOR のポーリング間隔 |
| `loop.idle_recheck_seconds` | IDLE 時のキュー再確認間隔 |
| `digest.recent_merged_count` | プロンプトに含める直近マージ済みセッション要約の件数 |

状態 DB（`looppilot-os.db`）は `looppilot-os.toml` と同じディレクトリに作られます。

### 3. シークレットを環境変数で渡す

API キー・Webhook は**ファイルに書かず**環境変数で渡します。

```bash
export LINEAR_API_KEY="lin_api_..."      # 必須
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."  # 任意
```

`SLACK_WEBHOOK_URL` 未設定時は**コンソール通知のみ**（コンソールは常時オン）。設定時はプリフライトで Webhook へ直接 POST して到達性を検証します（非 2xx ならプリフライト失敗）。

### 4. プリフライト（起動時に自動実行）

`run` は実ループに入る前に以下を fail-fast で検証し、違反は**全件まとめて**報告して停止します（仕様 §8 / カーネル §9）:

1. `repo.path` がクリーンな git（`git status --porcelain` 空）で `default_branch` 上にある
2. remote 到達可（`git ls-remote origin HEAD`）
3. `gh auth status` 成功 ∧ リポへの push 権限あり ∧ **デフォルトブランチを単独マージ可能**（必須レビュー > 0 やマージ制限があると NG — ループに人間レビュアーが不在のため）
4. `gate_label`（`loop-pilot`）が対象リポのラベルに存在（大小無視）
5. Actions 変数 `LOOPPILOT_AUTO_MERGE` が未設定 or `false`（**オーケが唯一のマージャー**）
6. Linear: API キーで viewer 取得 ∧ team・project・4 状態・opt_in_label が解決できる
7. `claude --version` 成功
8. state-comment 著者の整合: リポの `LOOPPILOT_STATE_COMMENT_AUTHORS`（未設定なら既定 `github-actions[bot]`）が `looppilot.state_comment_authors` に包含される（不整合だと Monitor が信頼コメントを発見できず `monitor_never_engaged` で全停止するため）
9. Slack 設定時は Webhook へ直接 POST して到達性確認

### 5. 起動と観測

```bash
# ループ起動（既定の config は ./looppilot-os.toml）
looppilot-os run --config ./looppilot-os.toml

# 状態確認（別ターミナルから／停止後でも可）
looppilot-os status --config ./looppilot-os.toml
```

- `--config <path>` 省略時の既定は `./looppilot-os.toml`。
- **単一インスタンス前提**: `run` はランロック（PID）を取得します。既に生きたインスタンスがある場合は二重起動しません。
- 停止は `Ctrl-C`（SIGINT）。**次の安全点で**現フェーズを完了してから Run を `halted`（理由 `user_interrupt`）にしてロックを解放し終了します（フェーズ途中で中断しません）。

## `run` の使い方

`run` は以下を繰り返します（仕様 §5・カーネル §7）:

1. **回復処理**（起動直後・後述）
2. タスク上限チェック（`tasks_started >= max_tasks_per_run` → 通知して HALT）
3. **SELECT** → 適格チケットを 1 件取得。なければ **IDLE**（キュー空通知 + `idle_recheck_seconds` ごとに再確認、復帰すれば再開）
4. **CLAIM → IMPLEMENT → HANDOFF → MONITOR → DONE** を逐次実行
5. いずれかのセッションが STOPPED したら **HALT**（理由付きで通知してループ終了）

実行中はコンソールに進捗（claude の stream-json を短縮表示）と各フェーズのログが出ます。

## `status` の使い方

`status` は SQLite を真実の源として、Run + TaskSession から現在の状態を表示します（仕様 §10 / §12）。専用イベントログは持たず、すべて Run/TaskSession から導出します。表示内容:

- **現在の Run**: 状態（`running` / `idle` / `halted`）、開始時刻、タスク上限、`tasks_started`、マージ済み件数（`merged` セッションの実数から導出）、HALT 理由。
- **進行中セッション**: 現在のチケット（identifier / タイトル）、フェーズ（`claimed` / `implementing` / `handing_off` / `in_review`）、ブランチ、PR 番号、コスト。
- **履歴**: 直近の終了済みセッション（`merged` / `stopped` と `failure_reason`・`stop_detail`）。
- **停止箇所**: HALT 時はどのセッションがどの `failure_reason` で止まったか。
- **未配信通知**: Slack 配信に失敗して保留中の通知意図（`notification_intent`）があれば可視化。

## 失敗時の見方（`failure_reason` 一覧）

セッションが STOPPED するとループは HALT します（逐次のため TaskSession=stopped ⇒ Run=halted の 1:1）。`status` の `failure_reason` で原因が分かります。10 種すべて（カーネル §2 / 仕様 §7）:

| failure_reason | 意味（どのフェーズで・何が起きたか） | 主な人間の対処 |
| -- | -- | -- |
| `agent_no_change` | IMPLEMENT 後、実差分（`origin/<defaultBranch>..HEAD`）が無い／空コミット／未コミットの残骸（`stop_detail="uncommitted leftovers"` で区別）。自動コミットはしない | チケットの粒度・プロンプト・ゴールを見直す。残骸があれば worktree を手動掃除 |
| `cost_exceeded` | IMPLEMENT 中に `max_cost_usd_per_session` 到達。部分作業は破棄しブランチ削除済み | コスト上限を上げる／タスクを分割する |
| `exception` | 予期せぬ例外（`stop_detail` に message）。MONITOR のポーリングが 5 連続失敗、または監視タイムアウト（`monitor timeout`）、回復で対応 PR が見つからない（`crash recovery: ...`）等もここ | `stop_detail` を読んで原因に対処 |
| `monitor_never_engaged` | MONITOR で `not_engaged_guard_minutes` を超えても信頼 state コメントが出ない／コメントはあるが破損（`corrupted` は即時、`stop_detail="...comment present but corrupted"`） | LoopPilot が当該 PR で発火しているか（ラベル・ワークフロー・著者 identity）を確認 |
| `looppilot_stopped` | LoopPilot 自身が `stopped` 状態に到達。`stop_detail` に LoopPilot の `stopReason`（無い場合 `looppilot stopped (no reason)`） | LoopPilot 側のログ・stopReason を確認して PR を手当て |
| `ci_failed` | MONITOR で CI 必須チェックが失敗、またはブランチ保護/ルールセットでマージがブロック（`stop_detail="merge blocked by branch protection..."`）、ready 判定下で `mergePr` が 2 連続失敗（fail-closed） | CI を直す／ブランチ保護の必須レビューを外す／手動マージ |
| `merge_conflict` | MONITOR で PR がデフォルトブランチと衝突（`CONFLICTING` / `DIRTY`） | PR を rebase/解決する |
| `pr_closed` | PR がマージされずにクローズされた | 意図的なら無視、再開したいなら新チケットへ |
| `claim_failed` | CLAIM 失敗（worktree 作成 or Linear 遷移）。可能なら worktree 破棄・チケットを Todo へ復帰 | リポのクリーン状態・ブランチ衝突・Linear 権限を確認 |
| `handoff_failed` | HANDOFF 失敗（push / PR 作成 / ラベル / In Review 遷移）。`stop_detail` に作成済み PR 番号を明記 | 明記された PR を手当てし、必要なら手動でラベル/遷移 |

`stop_detail` 列に追加文脈（LoopPilot の stopReason、例外メッセージ、ブロック理由、回復時の手動掃除対象など）が入ります。

## 回復の挙動（再起動時）

`run` は起動直後に新しい Run を作り、`merged`/`stopped` でない**アクティブセッション**を SQLite と突き合わせて回復します（仕様 §9 / カーネル §8）。原則は「**`in_review` + オープン PR だけが MONITOR へ再開**。それ以外の中断は全て STOPPED」:

- **`in_review`（PR 番号あり）**: 注入済み Monitor で PR を再評価し、`merged` → DONE 後段から再開（カウンタ二重計上なし）／ `pr_closed` → `stopped(pr_closed)` ／ `stopped` → `stopped(looppilot_stopped)` ／ それ以外（done・in_progress・未起動など open 扱い）→ 新 Run に付け替えて **MONITOR 再開**（未起動ガード/監視タイムアウトの起点 `monitor_started_at` は**上書きしない**＝経過は継続）。
- **`claimed` / `implementing` / `handing_off`**: 決定的ブランチに一致するオープン PR があれば採用して MONITOR へ。無ければ `stopped(exception)`（`stop_detail` に手動掃除対象 — ブランチ・worktree・identifier）として **HALT** し、人間の掃除を促す（タスク内自動再開は v1 非スコープ）。
- **孤児チケット**（Linear が In Progress だがセッション行が無い = CLAIM 途中クラッシュ）: best-effort で Todo へ復帰し、コンソールに警告。

回復で HALT しなかった場合のみループに入ります。

## 動作確認（手動 E2E チェックリスト）

仕様 §12 の v1 完了定義を、実環境で測定可能に確認する手順です。**LoopPilot 導入済みのテストリポ**と **Linear テスト Project** を用意して実施します。

### 前提（準備）

- [ ] テストリポに LoopPilot が導入され、`loop-pilot` ラベルで Init/Loop ワークフローが発火する（`LOOPPILOT_AUTO_MERGE` は未設定 or `false`）。
- [ ] テストリポはクリーン（`git -C <repo> status --porcelain` が空）で default_branch 上。default_branch に**必須レビュー > 0 を課さない**（オーケが単独マージするため。プリフライト 3 で弾かれる）。
- [ ] Linear テスト Project に**適格チケットを 2 件**用意する: いずれも対象 Team/Project ∧ **Todo** ∧ オプトインラベル（`linear.opt_in_label`）付き。2 件は十分小さく、claude が `max_cost_usd_per_session` 内で完了でき差分を生む内容にする。
- [ ] `looppilot-os.toml` を当該リポ/Linear に合わせて設定し、`LINEAR_API_KEY`（必要なら `SLACK_WEBHOOK_URL`）を export 済み。

確認コマンド（前提）:

```bash
# リポがクリーンで default_branch 上か
git -C /abs/path/to/target-repo status --porcelain        # 出力が空であること
git -C /abs/path/to/target-repo rev-parse --abbrev-ref HEAD  # default_branch 名であること

# loop-pilot ラベルがリポに存在するか
gh api repos/<owner>/<name>/labels --paginate --jq '.[].name' | grep -i '^loop-pilot$'

# LOOPPILOT_AUTO_MERGE が未設定 or false か（404 = 未設定 = OK）
gh api repos/<owner>/<name>/actions/variables/LOOPPILOT_AUTO_MERGE --jq .value || echo "unset(=OK)"

# 適格チケットが 2 件見えるか（Linear UI でも可）
looppilot-os status --config ./looppilot-os.toml   # 起動前は履歴空・Run 無しを確認
```

### 実行（一度起動したら追加指示なし）

- [ ] **ループを起動**する（以後、人間の追加指示は一切与えない）:

```bash
looppilot-os run --config ./looppilot-os.toml
```

- [ ] プリフライトが全項目グリーンでループに入る（違反があれば全件まとまって表示され、ここで止まる = 正しい挙動）。
- [ ] コンソールに `run_started` 通知と SELECT → CLAIM → IMPLEMENT → HANDOFF → MONITOR の進行ログが出る。

### 検証（逐次 2 件処理 → 綺麗に停止）

別ターミナルから随時 `status` と `gh`/Linear で観測します。

- [ ] **1 件目**: ブランチ + worktree が切られ（`<prefix>/<identifier>-<slug>`）、Linear が **In Progress** に遷移し、claude が実装・コミットし、**PR が ready-for-review で作成**され `loop-pilot` ラベルが付き、Linear が **In Review** に遷移する。

```bash
# 進行中セッションとフェーズ
looppilot-os status --config ./looppilot-os.toml

# 作成された PR を確認（loop-pilot ラベル付き・open）
gh pr list -R <owner>/<name> --state open --json number,labels,title

# LoopPilot の state コメントが出ているか（信頼著者・looppilot-state）
gh api repos/<owner>/<name>/issues/<pr>/comments --paginate \
  --jq '.[] | select(.body | startswith("LoopPilot state is stored in this comment.")) | .body' | tail -1
```

- [ ] LoopPilot がレビュー/修正を回して `looppilot-state.status=="done"`（クリーン）に到達する。
- [ ] **オーケがマージ**する（LoopPilot ではない）。PR が squash マージされ、Linear が **Done** に遷移する。

```bash
gh pr view <pr> -R <owner>/<name> --json state,mergedAt,mergedBy   # MERGED / mergedAt!=null
```

- [ ] **2 件目**: 1 件目のマージ後、**追加指示なしで自動的に**次の適格チケットが SELECT され、同じ流れ（ブランチ → 実装 → PR → ラベル受け渡し → done 検知 → オーケがマージ → Done）が逐次で進む。
- [ ] **キュー空 → IDLE → 停止**: 2 件とも Done になり適格チケットが尽きると、`idle` 通知（キュー空）が出て Run が `idle` になり、`idle_recheck_seconds` ごとに再確認する（新チケットを入れれば再開する）。タスク上限（`max_tasks_per_run`）に先に達した場合は `halted`（タスク上限）通知で綺麗に停止する。

```bash
# 最終状態: Run=idle（または halted）、merged 件数=2、停止箇所/失敗理由なし
looppilot-os status --config ./looppilot-os.toml
```

### 期待される最終状態（合否判定）

- [ ] `status` で **2 件が `merged`** と表示され、各チケットが Linear で **Done**。
- [ ] Run の状態が `idle`（キュー空）または `halted`（タスク上限）で、**`failure_reason` を持つセッションが無い**。
- [ ] 通知（コンソール、Slack 設定時は Slack）に `run_started` と `idle`（または タスク上限の `halted`）が出ている。未配信通知が残っていない。
- [ ] **失敗系の確認**（任意）: わざと壊れたチケット（差分を生まない指示など）を 1 件投入すると、対応する `failure_reason`（例 `agent_no_change`）で 1 セッションが `stopped`、Run が `halted`、`halted` 通知が出てループが停止する。`status` に停止箇所と理由が表示される。
- [ ] **再起動回復の確認**（任意）: `in_review`（オープン PR あり）のセッションがある状態で `run` を再起動すると、その PR の MONITOR が継続（`monitor_started_at` は維持）され、マージ済みなら DONE 後段から再開してカウンタが二重計上されない。

これらが満たされれば、仕様 §12「一度起動したら人間の追加指示なしで、各チケットを 選定→ブランチ→Claude実装→PR→`loop-pilot` 受け渡し→LoopPilot がクリーン到達→**オーケがマージ**→ticket Done→次、と逐次処理し、キュー空 or タスク上限で**通知して綺麗に停止**する」を満たします。

## 開発

```bash
npm run check        # 型チェック（src + tests）+ vitest を一括
npm test             # vitest のみ
npm run typecheck    # src の型チェックのみ
```

CI（`.github/workflows/ci.yml`）は push(main)/PR で `npm ci && npm run check` を回します。

## 設計ドキュメント

- 設計仕様書（source of truth）: `docs/specs/design-spec-v1-core-loop.md`
- 実装計画（共有カーネル + 各タスク章）: `docs/superpowers/plans/`
````

期待: Write が成功し `README.md` が完成形に置換される。

- [ ] **Step 4: README が完成形に置換されたことを確認する**

骨子の名残（`（骨子。詳細は Task 17 で完成）` や末尾の「> このセクションは骨子です」）が消え、完成形の見出しが揃っていることを確認する。

```bash
grep -nE '^## ' /home/racoma-dev/loop-pilot-os/README.md && echo "---骨子の名残チェック（ヒット0が期待）---" && grep -nE '骨子。詳細は Task 17|このセクションは骨子です' /home/racoma-dev/loop-pilot-os/README.md || true
```

期待: 見出しに `## アーキテクチャ` `## 必要環境` `## セットアップ` `## \`run\` の使い方` `## \`status\` の使い方` `## 失敗時の見方（failure_reason 一覧）` `## 回復の挙動（再起動時）` `## 動作確認（手動 E2E チェックリスト）` `## 開発` `## 設計ドキュメント` が並ぶ。骨子の名残チェックは**ヒット 0**（何も表示されない）。

- [ ] **Step 5: `failure_reason` 10 種が README に過不足なく載っていることを確認する**

カーネル §2 の `FailureReason` 10 種が一覧表にすべて含まれることを機械的に確認する。

```bash
for r in agent_no_change cost_exceeded exception monitor_never_engaged looppilot_stopped ci_failed merge_conflict pr_closed claim_failed handoff_failed; do
  grep -q "\`$r\`" /home/racoma-dev/loop-pilot-os/README.md && echo "OK  $r" || echo "MISSING $r";
done
```

期待: 10 行すべて `OK  <reason>`。1 つでも `MISSING` が出たら、その reason を一覧表に追記して再確認する（カーネル §2 と過不足ゼロが必須）。

- [ ] **Step 6: `npm run check` がグリーンのままであることを確認する（ドキュメント変更の無影響確認）**

README はドキュメントのみだが、コミット前に既存のビルド/テストが壊れていないことを確認する。

```bash
npm run check --prefix /home/racoma-dev/loop-pilot-os
```

期待: `tsc --noEmit`（src）/ `tsc --noEmit -p tsconfig.test.json`（tests）/ vitest がすべてグリーン（exit 0）。README の変更はコードに影響しないため、Task 16 完了時点の結果と同一であること。失敗する場合は本タスクのスコープ外の不具合なので、README には手を入れず原因タスクへ差し戻す（README 変更で型/テストが壊れることはあり得ない）。

- [ ] **Step 7: README を `git add` してコミットする**

完成した README をコミットする（example.toml は Task 1 で既にコミット済みのため本タスクではステージしない。Step 1 で差分が無いことを確認済み）。

```bash
git -C /home/racoma-dev/loop-pilot-os add README.md && \
git -C /home/racoma-dev/loop-pilot-os commit -m "chore: complete README (setup, run/status, failure_reason table, recovery, manual E2E checklist)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

期待: `[main <sha>] chore: complete README ...` が出て exit 0、`1 file changed`（README.md のみ）。検証: `git -C /home/racoma-dev/loop-pilot-os log --oneline -1` が当該コミットを返し、`git -C /home/racoma-dev/loop-pilot-os status --short` が clean（ステージ残なし）。これで Task 17 完了 = v1 実装計画の全章完了。

---

