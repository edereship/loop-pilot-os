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
  /** hung（無進捗・無支出）claude を切る hard backstop（ms）。未指定なら timeout なし。 */
  hardTimeoutMs?: number;
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
