// ---- 状態語彙（仕様 §7） ----
export type SessionState =
  | "claimed" | "implementing" | "handing_off" | "in_review" | "merged" | "stopped";

export type PauseTarget = "claude" | "codex";
export interface PauseMeta {
  reason: "rate_limit";
  target: PauseTarget;
  pausedAt: string;        // ISO-8601 UTC
  nextReprobeAt: string;   // ISO-8601 UTC
  capDeadlineAt: string;   // ISO-8601 UTC
}

export type RunState = "running" | "idle" | "halted" | "paused";
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
  | "handoff_failed"
  | "workflow_setup_failed";

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
  pauseMeta: PauseMeta | null;
  idleStartedAt: string | null;
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
  planBrief: string | null;
  selectRationale: string | null;
  startedAt: string;
  monitorStartedAt: string | null; // in_review 入り時刻。未起動ガード/監視timeoutの起点（再起動でリセットしない）
  endedAt: string | null;
  workflowFixAttempts: number;       // number of fix-agent runs for this session (budget counter)
  workflowHandledErrorCount: number; // errorCommentCount at the time of the last successful fix (guard counter)
  autoRestartAttempts: number;       // number of /restart-review comments posted (durable cap counter)
  quotaRetryAttempts: number;        // number of quota-wait retries in the current episode (durable cap counter)
  pendingRestartReason: string | null; // stopReason for which the last /restart-review was posted, or null if none pending
  recoveryAttempted: number;    // 0 or 1 — whether Codex recovery was attempted
  recoveryAction: string | null; // action chosen by Codex (fix_code/rebase/restart_review/escalate/abandon)
  doneTransitionPending: number; // 0 or 1 — whether transition(done) is still pending (ES-462)
}

// ---- モジュールインターフェース（仕様 §4） ----
export interface TaskSource {
  /** 適格(Team/PJ ∧ Todo ∧ オプトインラベル)を決定的順序で。excludeIds は Store 由来 */
  getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null>;
  /** 適格チケットを全件返す（PM 選別ターン用）。excludeIds は Store 由来 */
  getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]>;
  transition(issueId: string, state: TicketState): Promise<void>;
  /** In Progress なのに渡された issueIds に無いチケット（CLAIM途中クラッシュ孤児）を返す */
  findOrphanedInProgress(knownIssueIds: string[]): Promise<EligibleIssue[]>;
  /** チケットに Markdown コメントを投稿する（§1.6 監査書き戻し） */
  postComment(issueId: string, body: string): Promise<void>;
}

export interface SessionContext {
  worktreePath: string;
  prompt: string;
  maxCostUsd: number;
  /** hung（無進捗・無支出）claude を切る hard backstop（ms）。未指定なら timeout なし。 */
  hardTimeoutMs?: number;
}
export type AgentOutcome =
  | { kind: "completed"; costUsd: number; summary: string; fullResult?: string }
  | { kind: "cost_exceeded"; costUsd: number }
  | { kind: "interrupted"; costUsd: number }
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
  postComment(prNumber: number, body: string): Promise<void>;
  discardWorktree(branch: string, worktreePath: string): Promise<void>; // cost_exceeded 時の破棄
  getPrDiffSummary(prNumber: number, maxDiffChars?: number): Promise<PrDiffSummary>;
  /** Fetch the default branch from origin and reset the working tree to match it. */
  fetchDefaultBranch(): Promise<void>;
}

/** 列挙順は precedence ではない。poll() の決定順は §5.4（merged 最優先）が正 */
export type MonitorVerdict =
  | { kind: "merged" }
  | { kind: "done" }            // looppilot-state.status=="done"（マージ可否は別判定）
  | { kind: "stopped"; stopReason: string | null }  // LoopPilot は stopped でも stopReason=null があり得る
  | { kind: "in_progress" }     // state コメントあり・進行中（initialized|waiting_codex|fixing）
  | { kind: "corrupted" }       // 信頼著者の state コメントは在るが JSON 破損/不正 status
  | { kind: "not_engaged" }     // 信頼できる state コメント未出現
  | { kind: "pr_closed" }       // マージ無しクローズ
  // hasStateComment: a live (non-stopped/non-done) looppilot-state comment is present
  // alongside the ⚠️ error comment. The orchestrator uses this to tell an actively
  // restarted review (state comment moved to fixing/waiting_codex) from one that never
  // engaged, so the not-engaged guard does not kill a live review.
  | {
      kind: "workflow_failed";
      errorBody: string;
      errorCommentCount: number;
      hasStateComment: boolean;
    };
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
  | { kind: "run_started"; detail: string }               // 起動時
  | { kind: "task_started"; identifier: string; title: string }  // CLAIM 成功（opt-in）
  | { kind: "task_merged"; identifier: string; title: string; mergedCount: number } // DONE 完了（opt-in）
  | { kind: "quota_waiting"; detail: string }             // 初回 Codex quota exhausted
  | { kind: "quota_resumed"; detail: string }             // Codex quota 回復
  | { kind: "paused"; target: PauseTarget; detail: string }
  | { kind: "resumed"; target: PauseTarget; detail: string }
  | { kind: "recovery_started"; identifier: string; reason: string }
  | { kind: "recovery_succeeded"; identifier: string; action: string };
export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;  // コンソールは必ず成功。Slack失敗でも throw しない
  /** プリフライト専用: Slack設定時は Webhook へ直接POSTし非2xxで throw。未設定なら即resolve */
  probeReachability(): Promise<void>;
}

// ---- ワークフロー回復（workflow-recovery.ts） ----
export interface RecoveryContext {
  worktreePath: string;
  branch: string;
  prNumber: number;
  errorBody: string;
  errorCommentCount: number;
  /** Durable count of fix-agent runs already completed for this session (budget counter). */
  fixAttempts: number;
  /** The errorCommentCount at the time of the last successful fix (guard counter). */
  handledErrorCount: number;
  maxCostUsd: number;
  /** Forwarded to the fix agent as a hard timeout backstop (ms). */
  hardTimeoutMs?: number;
}
export type RecoveryOutcome =
  // `newFix` distinguishes "a new fix was pushed this poll" (increment the budget
  // counter / record the handled error count) from "already handled, just waiting
  // for the restarted workflow". Cost cannot be used for this because a fix-agent
  // run may legitimately report costUsd: 0.
  | { kind: "restarted"; costUsd: number; newFix: boolean }
  | { kind: "exhausted"; costUsd: number }
  | { kind: "interrupted"; costUsd: number }
  | { kind: "unrecoverable"; costUsd: number; message: string };
export interface WorkflowRecovery {
  attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome>;
}

// ---- 文脈バンドル（context-bundle.ts） ----

export interface SpecFile {
  name: string;     // ファイル名（拡張子なし）
  content: string;  // ファイル内容
}

export interface SpecContent {
  requirements: string;    // requirements.md 全文
  domainSpecs: SpecFile[]; // 領域別要件定義ファイル群（アルファベット順）
}

export interface PromptArgs {
  goal: string | null;                            // config.product.goal（v1 フォールバック用）
  specContent: SpecContent | null;                // spec_dir から読み込んだ仕様（v2）
  issue: EligibleIssue;
  digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
  planBrief?: PlanBrief | null;                   // PLAN フェーズで生成した実装ブリーフ（任意）
  memory?: {                                      // B2 横断メモリ（PLAN 注入: impl-results + product-knowledge）
    implResults?: string;
    productKnowledge?: string;
  } | null;
  memoryBudgetChars?: number;                     // memory.inject_budget_chars（既定 6000）
}
// context-bundle.ts は export function buildPrompt(args: PromptArgs): string を公開

// ---- チケット濃化（A2: PLAN フェーズ） ----

export type PlanOutcome =
  | { kind: "completed"; text: string }
  | { kind: "error"; message: string }
  | { kind: "interrupted" };

export interface PlanRunner {
  run(ctx: { worktreePath: string; prompt: string; timeoutMs?: number }): Promise<PlanOutcome>;
}

export interface BriefSections {
  goal: string;
  changeTargets: string;
  steps: string;
  acceptance: string;
  outOfScope: string;
}

export interface PlanBrief {
  raw: string;
  sections: BriefSections | null;
}

// ---- PM 選別ターン（A1: select-prompt.ts） ----

export interface PrDiffSummary {
  title: string;
  body: string;
  diff: string;
}

export interface SelectPromptArgs {
  goal: string | null;
  specContent: SpecContent | null;
  eligible: EligibleIssue[];
  inProgress: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle">>;
  recentMerged: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
  lastPrDiff: { identifier: string; summary: PrDiffSummary } | null;
  diffBudgetChars: number;
  codebaseSummary: string | null;
  memory?: {                                      // B2 横断メモリ（SELECT 注入: pm-decisions + impl-results）
    pmDecisions?: string;
    implResults?: string;
  } | null;
  memoryBudgetChars?: number;                     // memory.inject_budget_chars（既定 6000）
  groomSummary: string | null;                    // D-28: GROOM summary for context
}

export interface ParsedSelection {
  identifier: string;
  rationale: string;
}

// ---- v3 GROOM フェーズ + 横断メモリ（A3 / B2） ----

export type MemoryCategory = "pm_decisions" | "impl_results" | "product_knowledge";

// update/label/split の「少なくとも1フィールド必須」はランタイム検証で担保（ES-453 Validator）
export type GroomAction =
  | { type: "reprioritize"; issueId: string; priority: 1 | 2 | 3 | 4; rationale: string }
  | { type: "update"; issueId: string; title?: string; description?: string; rationale: string }
  | { type: "create"; title: string; description: string; priority: 1 | 2 | 3 | 4; rationale: string }
  | { type: "split"; issueId: string; subtasks: { title: string; description: string }[]; rationale: string }
  | { type: "close"; issueId: string; rationale: string }
  | { type: "label"; issueId: string; add?: string[]; remove?: string[]; rationale: string }
  | { type: "update_memory"; category: MemoryCategory; content: string; rationale: string };

export interface GroomOutput {
  actions: GroomAction[];
  summary: string;
}

export type GroomOutcome = "completed" | "skipped" | "error";

export interface GroomLogRow {
  id: number;
  runId: number;
  loopIndex: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  actionsRequested: number;
  actionsExecuted: number;
  actionsRejected: number;
  actionDetails: string | null;
  outcome: GroomOutcome | null;
  errorDetail: string | null;
}

// ---- GROOM Prompt Builder（ES-455: Board Formatter + Prompt Builder） ----

export interface BoardTicket {
  identifier: string;
  title: string;
  priority: number;
  labels: string[];
}

export interface InProgressTicket extends BoardTicket {
  status: "in_progress" | "in_review";
  prNumber: number | null;
}

export interface DoneTicket {
  identifier: string;
  title: string;
  mergedAt: string;
}

export interface BlockedTicket extends BoardTicket {
  blockedBy: string;
}

export interface BoardState {
  eligible: BoardTicket[];
  inProgress: InProgressTicket[];
  recentDone: DoneTicket[];
  blocked: BlockedTicket[];
}

export interface GroomPromptArgs {
  specContent: SpecContent | null;
  goal: string | null;
  memory: {
    pmDecisions: string | null;
    implResults: string | null;
    productKnowledge: string | null;
  };
  board: BoardState;
  boardBudgetChars: number;
  /** Max chars for the combined memory block injected into the prompt (memory.inject_budget_chars). */
  memoryBudgetChars: number;
  digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
  codebaseSummary: string | null;
  optInLabel: string;
  maxMemoryChars: number;
  knownLabels: string[];
}

// ---- 実行コマンド抽象（git/gh/claude 共通） ----
export interface CommandResult { code: number; stdout: string; stderr: string; }
export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  onStdoutLine?: (line: string) => void;  // stream-json 進捗用
  timeoutMs?: number;                      // 超過時 kill して reject
  stdin?: string;                           // pipe this content then EOF
  closeStdin?: boolean;                    // if true, close stdin immediately without writing
}
export interface CommandRunner {
  run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult>;
}
