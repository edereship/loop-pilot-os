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
  MergeReadiness,
  MonitorVerdict,
  PromptArgs,
  SpecContent,
  RecoveryContext,
  RecoveryOutcome,
  WorkflowRecovery,
  PlanRunner,
  PlanBrief,
  PlanOutcome,
  PauseMeta,
  PrDiffSummary,
  CommandRunner,
  GroomAction,
  BoardState,
} from "./types.js";
import { classifyStopReason, FAILURE_POLICY } from "./stop-reason.js";
import { buildPlanPrompt, parseBrief } from "./plan-brief.js";
import { parseDesignReviewOutput } from "./design-review-parser.js";
import { buildDesignReviewPrompt } from "./design-review-prompt.js";
import { buildSelfReviewPrompt } from "./self-review-prompt.js";
import { parseSelfReviewOutput } from "./self-review-parser.js";
import { buildSelectPrompt, parseSelection } from "./select-prompt.js";
import { executeRecoveryTurn, executeAbandon } from "./recovery-turn.js";
import type { RecoveryTurnDeps } from "./recovery-turn.js";
import type { SqliteStore } from "./store.js";
import type { Config } from "./config.js";
import { commitIfChanged, initialize as initializeMemory, readAll as readMemoryAll, MEMORY_DIR } from "./memory-store.js";
import { buildGroomPrompt } from "./groom-prompt.js";
import { parseGroomOutput } from "./groom-parser.js";
import { validateGroomActions, type ValidationContext } from "./groom-validator.js";
import { executeGroomActions, type ExecutionResult, type ExecutorContext, type IExecutorLinearClient } from "./groom-executor.js";
export interface IGroomBoardFetcher {
  getBoardState(prMap: Map<string, number | null>): Promise<BoardState>;
  getProjectIssueIds(): Promise<Set<string>>;
  getDoneIssueIds(): Promise<Set<string>>;
  getOptInIssueIds(): Promise<Set<string>>;
  /** Returns identifiers of issues currently in in_progress or in_review state. */
  getActiveIssueIds(): Promise<Set<string>>;
  /** Returns identifiers of issues carrying the needs-human label (ES-492). */
  getNeedsHumanIssueIds(needsHumanLabel: string): Promise<Set<string>>;
  /** Clear any per-cycle cache so fresh data is fetched in the next call. */
  refresh(): void;
}

export interface IGroomLinearClient extends IExecutorLinearClient {
  postComment(issueId: string, body: string): Promise<void>;
}

export interface GroomDeps {
  boardFetcher: IGroomBoardFetcher;
  linearClient: IGroomLinearClient;
  knownLabels: string[];
}

export type RunOutcome = "finished" | "lock_rejected";

export interface OrchestratorDeps {
  config: Config;
  source: TaskSource;
  agent: AgentRunner;
  selfReviewAgent: AgentRunner;
  git: GitPrManager;
  monitor: LoopPilotMonitor;
  notifier: Notifier;
  store: SqliteStore;
  buildPrompt: (args: PromptArgs) => string;
  /** Called per-session with the worktree path (post-fetch) and specDir. Null when spec_dir is unset. */
  specLoader: ((repoPath: string, specDir: string) => SpecContent) | null;
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  recovery: WorkflowRecovery;
  planner: PlanRunner | null;
  designer: PlanRunner | null;
  designReviewer: PlanRunner | null;
  codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
  recoveryTurn: RecoveryTurnDeps | null;
  runner: CommandRunner;
  groomDeps: GroomDeps | null;
}

/** フェーズの返り値: 続行か、HALT 済み（ループを脱出すべき）か */
type RunControl =
  | { control: "continue" }
  | { control: "halt" };

const CONTINUE: { control: "continue" } = { control: "continue" };
const HALT: { control: "halt" } = { control: "halt" };

export class Orchestrator {
  private readonly config: Config;
  private readonly source: TaskSource;
  private readonly agent: AgentRunner;
  private readonly selfReviewAgent: AgentRunner;
  private readonly git: GitPrManager;
  private readonly monitor: LoopPilotMonitor;
  private readonly notifier: Notifier;
  private readonly store: SqliteStore;
  private readonly buildPrompt: (args: PromptArgs) => string;
  private readonly specLoader: ((repoPath: string, specDir: string) => SpecContent) | null;
  private readonly clock: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly recovery: WorkflowRecovery;
  private readonly planner: PlanRunner | null;
  private readonly designer: PlanRunner | null;
  private readonly designReviewer: PlanRunner | null;
  private readonly codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
  private readonly recoveryTurn: RecoveryTurnDeps | null;
  private readonly runner: CommandRunner;
  private readonly groomDeps: GroomDeps | null;

  private runId = 0;
  private interrupted = false; // SIGINT 等の停止要求（次の安全点で halt）
  private groomLoopIndex = 0;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.source = deps.source;
    this.agent = deps.agent;
    this.selfReviewAgent = deps.selfReviewAgent;
    this.git = deps.git;
    this.monitor = deps.monitor;
    this.notifier = deps.notifier;
    this.store = deps.store;
    this.buildPrompt = deps.buildPrompt;
    this.specLoader = deps.specLoader;
    this.clock = deps.clock;
    this.sleep = deps.sleep;
    this.log = deps.log;
    this.recovery = deps.recovery;
    this.planner = deps.planner;
    this.designer = deps.designer;
    this.designReviewer = deps.designReviewer;
    this.codebaseSummaryGenerator = deps.codebaseSummaryGenerator;
    this.recoveryTurn = deps.recoveryTurn;
    this.runner = deps.runner;
    this.groomDeps = deps.groomDeps;
  }

  /** 停止要求を立てる（SIGINT ハンドラ等から呼ぶ）。次の安全点でクリーン halt する。 */
  requestStop(): void {
    this.interrupted = true;
  }

  async run(): Promise<RunOutcome> {
    const pid = process.pid;
    const acquired = this.store.acquireRunLock(pid, isPidAlive, this.clock());
    if (!acquired) {
      this.log("run lock held by another live process; aborting");
      return "lock_rejected";
    }
    try {
      // Initialize memory store under the run lock so that a concurrent rejected run
      // cannot race on the shared git index. Fetch and rebase before creating the bootstrap
      // commit so the push is fast-forward and not discarded by fetchDefaultBranch's
      // git reset --hard on the next PM-select phase (ES-452 Finding 2). All steps are
      // best-effort; failures are warned and skipped.
      try {
        // Seed/initialize the local memory files for this run inside the rebase guard so
        // the bootstrap commit follows the same conflict-marker protection as the halt
        // commit (ES-452 Findings 2/3/4). initializeMemory always runs (even when the
        // commit is skipped) so the run has memory available regardless.
        await this.rebaseGuardAndCommitMemory(() =>
          initializeMemory(
            this.config.repo.path,
            this.store,
            this.config.digest.recentMergedCount,
          ),
        );
      } catch (err: unknown) {
        this.log(`warning: failed to initialize memory: ${err instanceof Error ? err.message : String(err)}`);
      }

      const taskCap = this.config.safety.maxTasksPerRun;
      // Carry idle_started_at forward only when the previous run is still idle
      // (crash/restart while idle). Halted runs retain the column but their timer is stale;
      // inheriting it would cause the new run to time-out immediately (ES-475).
      const previousRun = this.store.latestRun();
      const previousIdleStartedAt =
        previousRun?.state === "idle" ? (previousRun.idleStartedAt ?? null) : null;
      const run = this.store.createRun(taskCap, this.clock());
      this.runId = run.id;
      if (previousIdleStartedAt !== null) {
        this.store.setIdleStartedAt(this.runId, previousIdleStartedAt);
      }
      await this.notifier.notify({
        kind: "run_started",
        detail: `run ${run.id} started (taskCap=${taskCap})`,
      });
      const recovery = await this.recoverPendingSessions();
      if (recovery.control === "continue") {
        await this.loop();
      }
    } finally {
      this.store.releaseRunLock(pid);
    }
    return "finished";
  }

  /**
   * 起動時回復（仕様 §9 / カーネル §8）。
   * 1) 孤児チケット（In Progress だがセッション行なし）を Todo へベストエフォート復帰。
   * 2) activeSessions()（merged/stopped 以外・全 run 横断）を走査し state ごとに分岐:
   *    - in_review+PR: monitor.poll の verdict で merged→DONE後段 / pr_closed・stopped→停止 / その他→採用しMONITOR再開。
   *    - claimed/implementing/handing_off: findOpenPrForBranch ヒット→採用、ミス→stopped(exception)+HALT。
   * いずれかの経路が HALT に至ったら { control: "halt" } を返し、run() はループを開始しない。
   * 採用セッションは runId を新 Run へ付替えるので countTasksStarted に数えられ、上限と比較される。
   * 注: SIGINT(requestStop) は回復処理の完了後（loop 冒頭の安全点）まで効かない。回復は v1 では逐次・有限（monitor タイムアウト/HALT で抜ける）。
   */
  private async recoverPendingSessions(): Promise<RunControl> {
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

    // 2) 活性セッションの照合・採用/停止
    for (const session of this.store.activeSessions()) {
      let ctrl: RunControl;
      if (session.state === "in_review" && session.prNumber !== null) {
        ctrl = await this.recoverInReview(session, session.prNumber);
      } else {
        ctrl = await this.recoverByOpenPr(session);
      }
      if (ctrl.control === "halt") return HALT;
      // If recovery re-activated the session to in_review, resume monitoring so
      // it doesn't sit idle until the next daemon restart (ES-450 Finding 4).
      const refreshed = this.store.getSession(session.id);
      if (refreshed.state === "in_review" && refreshed.prNumber !== null) {
        const monCtrl = await this.adoptAndMonitor(refreshed, refreshed.prNumber, refreshed.monitorStartedAt);
        if (monCtrl.control === "halt") return HALT;
      }
    }

    // 3) stopped(looppilot_stopped) + PR ありのセッション回復（ES-411）
    for (const session of this.store.stoppedSessionsWithPr("looppilot_stopped")) {
      const ctrl = await this.recoverStoppedByLooppilot(session, session.prNumber as number);
      if (ctrl.control === "halt") return HALT;
    }

    // 4) Stopped sessions where Codex recovery ran but its action failed (e.g. transient
    // /restart-review post failure). recovery_attempted=0 means recovery was not completed
    // successfully — retry it now so the PR is not left unmonitored (ES-450 Finding 3).
    for (const session of this.store.stoppedSessionsWithFailedRecovery()) {
      this.store.updateSession(session.id, { runId: this.runId });
      // Strip the "(recovery failed: ...)" suffix stopSession appended so the re-entered
      // recovery prompt sees the original detail rather than the accumulated failure chain.
      const ctrl = await this.stopSession(
        session,
        session.failureReason as FailureReason,
        stripRecoveryFailedSuffix(session.stopDetail),
      );
      if (ctrl.control === "halt") return HALT;
      // If recovery re-activated the session to in_review, resume monitoring it.
      // Without this, the session would sit idle until the next daemon restart
      // because the active-session pass (step 2) already ran (ES-450 Finding 1).
      const refreshed = this.store.getSession(session.id);
      if (refreshed.state === "in_review" && refreshed.prNumber !== null) {
        const monCtrl = await this.adoptAndMonitor(refreshed, refreshed.prNumber, refreshed.monitorStartedAt);
        if (monCtrl.control === "halt") return HALT;
      }
    }

    // 5) merged だが Linear 遷移が未完了のセッションをリトライ（ES-462）
    for (const session of this.store.sessionsWithPendingDoneTransition()) {
      try {
        await retry(3, () => this.source.transition(session.linearIssueId, "done"));
        this.store.updateSession(session.id, { doneTransitionPending: 0 });
        this.log(
          `recovered: transitioned ${session.linearIdentifier} to Done (was pending since merge)`,
        );
      } catch (err) {
        this.log(
          `warning: recovery transition(done) still failing for ${session.linearIdentifier}: ${errMsg(err)} — will retry on next startup`,
        );
      }
    }

    return CONTINUE;
  }

  /** in_review + PR の回復（カーネル §8）。poll の verdict で分岐する。 */
  private async recoverInReview(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    // If the process crashed mid-abandon (after the marker was written but before gh pr close
    // ran), the session is still in_review. Skip the poll and force the abandon cleanup path
    // regardless of the PR's current open/closed state (ES-450 Finding 1).
    if (session.stopDetail !== null && session.stopDetail.startsWith("abandon_in_progress")) {
      this.store.updateSession(session.id, { runId: this.runId });
      return await this.stopSession(session, "pr_closed", null);
    }
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
      case "stopped": {
        const recoveryCategory = classifyStopReason(verdict.stopReason);
        if (
          recoveryCategory === "review_done" ||
          recoveryCategory === "auto_restart" ||
          recoveryCategory === "quota_wait"
        ) {
          // Resume MONITOR so monitorSession handles no_findings merge,
          // auto_restart posting, or quota retry (ES-410 Finding 2) — without
          // adoption the documented quota retry loop halts immediately after a
          // process restart instead of waiting an hour and retrying.
          return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
        }
        this.store.updateSession(session.id, { runId: this.runId });
        const stopCtrl = await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
        if (stopCtrl.control === "halt") return HALT;
        // If recovery re-activated the session to in_review, resume monitoring it.
        const refreshed = this.store.getSession(session.id);
        if (refreshed.state === "in_review" && refreshed.prNumber !== null) {
          return await this.adoptAndMonitor(refreshed, refreshed.prNumber, refreshed.monitorStartedAt);
        }
        return stopCtrl;
      }
      // done / in_progress / corrupted / not_engaged = open 扱い → 採用して MONITOR 再開
      case "done":
      case "in_progress": {
        // ES-469 Finding 2: a non-stopped verdict confirms the quota episode has recovered.
        // Reset the durable count and non-done-path pending reason before adopting so
        // monitorSession does not carry stale quotaRetryAttempts (e.g. 6) into the next
        // quota episode if its first poll never observes an in_progress verdict.
        const clearPendingReason = session.pendingRestartReason !== null &&
            session.pendingRestartReason !== "ci_failed" &&
            session.pendingRestartReason !== "merge_conflict";
        if (session.quotaRetryAttempts > 0 || clearPendingReason) {
          this.store.updateSession(session.id, {
            quotaRetryAttempts: 0,
            ...(clearPendingReason ? { pendingRestartReason: null } : {}),
          });
        }
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
      }
      case "corrupted":
      case "not_engaged":
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
      // workflow_failed: ワークフロー回復は別モジュール（workflow-recovery.ts）で担う（ES-397）
      case "workflow_failed":
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
  }

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
    // merged 到達 → DONE 後段（abandon で stopped になった場合はスキップ）
    if (this.store.getSession(fresh.id).state !== "stopped") {
      await this.recoverDone(fresh);
    }
    return CONTINUE;
  }

  /** claimed/implementing/handing_off（および PR 番号欠落 in_review）の回復（カーネル §8）。 */
  private async recoverByOpenPr(session: TaskSessionRow): Promise<RunControl> {
    let prNumber: number | null;
    try {
      prNumber = await this.git.findOpenPrForBranch(session.branch);
    } catch (err) {
      // gh 一時障害等で PR 状態が判定不能 → Fatal 落ち（無通知）にせず HALT+通知で人間に上げる。
      this.store.updateSession(session.id, { runId: this.runId });
      return await this.stopSession(
        session,
        "exception",
        `crash recovery: findOpenPrForBranch failed for ${session.branch}: ${errMsg(err)}`,
      );
    }
    if (prNumber !== null) {
      // If the session's stop_detail marks an abandon in progress (onAbandonStarting wrote
      // it before the crash), force the abandon cleanup path regardless of the open PR state.
      // Without this, recoverByOpenPr would adopt the PR into monitoring, bypassing the
      // chosen abandon and letting LoopPilot re-engage on a ticket that was being abandoned
      // (ES-450 Finding 3).
      if (session.stopDetail !== null && session.stopDetail.startsWith("abandon_in_progress")) {
        this.store.updateSession(session.id, { runId: this.runId, prNumber });
        return await this.stopSession(session, "pr_closed", null);
      }
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
    // PLAN is read-only: a claimed session can never have agent implementation
    // commits. Any worktree changes are Codex analysis artifacts — always safe
    // to discard and revert to Todo so the next run can retry the full cycle.
    if (session.state === "claimed") {
      if (session.worktreePath) {
        await bestEffort(() => this.git.discardWorktree(session.branch, session.worktreePath!));
      }
      let revertedToTodo = true;
      try {
        await this.source.transition(session.linearIssueId, "todo");
      } catch {
        revertedToTodo = false;
      }
      this.store.updateSession(session.id, { runId: this.runId });
      const revertStatus = revertedToTodo
        ? "ticket reverted to Todo"
        : "ticket revert to Todo FAILED — may be stuck In Progress";
      const detail =
        `crash recovery: no open PR (PLAN phase); ${revertStatus}: ` +
        `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
      return await this.stopSession(session, "exception", detail);
    }
    // IMPLEMENT interrupted before PR creation (e.g. SIGINT during rate-limit sleep):
    // revert the ticket to Todo and discard the worktree only when no committed work
    // exists yet. If the agent already committed changes and the worktree is clean,
    // resume from SELF-REVIEW → HANDOFF (ES-473: the safe point between IMPLEMENT and
    // HANDOFF may leave "implementing" with committed work but no PR on a clean interrupt).
    // Fall through to manual cleanup for dirty worktrees to avoid destroying partial work.
    if (session.state === "implementing") {
      let hasCommits = false;
      let hasDirtyFiles = false;
      let checkFailed = false;
      if (session.worktreePath) {
        try {
          hasCommits = await this.git.hasCommitsWithDiff(session.worktreePath);
          hasDirtyFiles = await this.git.hasUncommittedChanges(session.worktreePath);
        } catch {
          checkFailed = true; // assume work exists if check fails; prefer manual cleanup
        }
      }
      if (!hasCommits && !hasDirtyFiles && !checkFailed) {
        if (session.worktreePath) {
          await bestEffort(() => this.git.discardWorktree(session.branch, session.worktreePath!));
        }
        let revertedToTodo = true;
        try {
          await this.source.transition(session.linearIssueId, "todo");
        } catch {
          revertedToTodo = false;
        }
        this.store.updateSession(session.id, { runId: this.runId });
        const revertStatus = revertedToTodo
          ? "ticket reverted to Todo"
          : "ticket revert to Todo FAILED — may be stuck In Progress";
        const detail =
          `crash recovery: no open PR; ${revertStatus}: ` +
          `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
        return await this.stopSession(session, "exception", detail);
      }
      if (hasCommits && !hasDirtyFiles && !checkFailed) {
        this.store.updateSession(session.id, { runId: this.runId });
        if (this.config.selfReview.enabled) {
          // Check if a successful self-review already completed before the daemon stopped.
          // If so, the review gate is already satisfied and we can skip to HANDOFF.
          const srLogs = this.store.getSelfReviewLogsForSession(session.id);
          const lastSrLog = srLogs.at(-1);
          if (lastSrLog?.outcome === "passed" || lastSrLog?.outcome === "fixed" ||
              (lastSrLog?.outcome === "error" &&
               lastSrLog.errorDetail != null &&
               lastSrLog.errorDetail !== "interrupted" &&
               !lastSrLog.errorDetail.startsWith("guard:"))) {
            // passed/fixed: gate satisfied.
            // error with non-null, non-"interrupted", non-"guard:" errorDetail: cleanup-complete
            // nonfatal outcome (cost cap, agent exception, parse error); the main flow returns
            // CONTINUE and proceeds to HANDOFF, so recovery must do the same.
            // excluded: interrupted (outcome written before haltForInterrupt(), cleanup may not
            // have run); null errorDetail (fatal guard path with no detail); "guard:"-prefixed
            // errorDetail (fatal guard paths that called stopSession() — branch wrong before/after
            // review, SHA unreadable, uncommitted changes, no diff remaining, etc.).
            this.log(`recovery: self-review completed (${lastSrLog.outcome}); resuming HANDOFF (${session.linearIdentifier})`);
            const recoveredIssue: EligibleIssue = {
              id: session.linearIssueId,
              identifier: session.linearIdentifier,
              title: session.issueTitle,
              description: "",
              priority: 0,
              sortOrder: 0,
              url: session.issueUrl,
            };
            const handoffResult = await this.handoff(session, recoveredIssue);
            if ("prNumber" in handoffResult) return CONTINUE;
            return handoffResult;
          }
          // Self-review has not completed (crash before self-review started).
          // The recovery context has no ticket description, so we cannot run the gate.
          // Halt for human review.
          const detail =
            `crash recovery: self-review required but ticket description unavailable; ` +
            `manual review and handoff needed: ` +
            `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
          this.log(`recovery: halting — self-review required but ticket context unavailable (${session.linearIdentifier})`);
          return await this.stopSession(session, "exception", detail);
        }
        // Clean committed work, no open PR: resume from HANDOFF.
        // Self-review is disabled, so proceed directly.
        const recoveredIssue: EligibleIssue = {
          id: session.linearIssueId,
          identifier: session.linearIdentifier,
          title: session.issueTitle,
          description: "",
          priority: 0,
          sortOrder: 0,
          url: session.issueUrl,
        };
        const handoffResult = await this.handoff(session, recoveredIssue);
        if ("prNumber" in handoffResult) {
          return CONTINUE;
        }
        return handoffResult;
      }
      // Has dirty files or check failed → fall through to manual cleanup below
    }
    // オープン PR なし → 手動掃除を促して HALT（タスク内自動再開は v1 スコープ外）。
    this.store.updateSession(session.id, { runId: this.runId });
    const detail =
      `crash recovery: no open PR; manual cleanup: ` +
      `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
    return await this.stopSession(session, "exception", detail);
  }

  /**
   * stopped(looppilot_stopped) + PR ありのセッション回復（ES-411）。
   * 採用時は state を in_review へ原子的に遷移させる（resetAndAdopt）ことで、
   * 遷移途中のクラッシュでも activeSessions() から回復可能な状態を維持する。
   */
  private async recoverStoppedByLooppilot(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    let verdict: MonitorVerdict;
    try {
      verdict = await this.monitor.poll(prNumber);
    } catch (err) {
      this.log(`recovery: poll threw for stopped session PR #${prNumber}, resuming MONITOR: ${errMsg(err)}`);
      // A transient poll error means we have no verdict to compare against the exhaustion
      // detail. If the session's stopDetail indicates a terminal counter exhaustion, do not
      // revive it — we cannot confirm the stop reason changed, so preserve the terminal HALT.
      // extractInnerStopDetail unwraps "abandon_in_progress:<original>" so that a failed
      // abandon over an exhausted session still triggers the exhaustion guard (ES-450 Finding 4).
      if (session.stopDetail !== null) {
        const innerDetailForPollError = extractInnerStopDetail(
          stripRecoveryFailedSuffix(session.stopDetail) ?? "",
        );
        if (
          innerDetailForPollError.startsWith("auto-restart limit exceeded") ||
          innerDetailForPollError.startsWith("quota retry limit exceeded")
        ) {
          this.log(
            `recovery: skipping exhausted stopped session PR #${prNumber} (poll error): ${session.stopDetail}`,
          );
          return CONTINUE;
        }
      }
      this.resetAndAdopt(session.id);
      return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
    switch (verdict.kind) {
      case "stopped": {
        const recoveryCategory = classifyStopReason(verdict.stopReason);
        if (
          recoveryCategory === "review_done" ||
          recoveryCategory === "auto_restart" ||
          recoveryCategory === "quota_wait"
        ) {
          // If the prior stop was a terminal counter exhaustion for the SAME reason,
          // do not revive. resetAndAdopt would zero autoRestartAttempts/pendingRestartReason,
          // letting each daemon restart post another full round of /restart-review comments
          // instead of honouring the terminal HALT (ES-411).
          // Compare against the current verdict.stopReason so that a different new stop
          // reason (e.g. test_failure after workflow_crashed was exhausted) gets a fresh
          // restart budget rather than being silently skipped.
          // extractInnerStopDetail unwraps "abandon_in_progress:<original>" so that a failed
          // abandon over an exhausted session still honours the cap (ES-450 Finding 4).
          const rawDetailForExhaustion = extractInnerStopDetail(
            stripRecoveryFailedSuffix(session.stopDetail) ?? "",
          );
          if (
            (recoveryCategory === "auto_restart" &&
              session.stopDetail !== null &&
              rawDetailForExhaustion.startsWith("auto-restart limit exceeded") &&
              extractExhaustedStopReason(rawDetailForExhaustion) === verdict.stopReason) ||
            (recoveryCategory === "quota_wait" &&
              session.stopDetail !== null &&
              rawDetailForExhaustion.startsWith("quota retry limit exceeded") &&
              extractExhaustedStopReason(rawDetailForExhaustion) === verdict.stopReason)
          ) {
            // Before skipping, retry if a prior Codex recovery failed (e.g. transient
            // /restart-review post failure). Without this the failed recovery is never
            // retried: this guard returns before the retry block below and
            // stoppedSessionsWithFailedRecovery excludes looppilot_stopped (ES-450 Finding 2).
            if (
              !session.recoveryAttempted &&
              session.stopDetail !== null &&
              session.stopDetail.includes("(recovery failed:")
            ) {
              this.store.updateSession(session.id, { runId: this.runId });
              const retryCtrl = await this.stopSession(
                session,
                session.failureReason as FailureReason,
                stripRecoveryFailedSuffix(session.stopDetail),
              );
              if (retryCtrl.control === "halt") return HALT;
              const retried = this.store.getSession(session.id);
              if (retried.state === "in_review" && retried.prNumber !== null) {
                return await this.adoptAndMonitor(retried, retried.prNumber, retried.monitorStartedAt);
              }
              return retryCtrl;
            }
            this.log(
              `recovery: skipping exhausted stopped session PR #${prNumber}: ${session.stopDetail}`,
            );
            return CONTINUE;
          }
          this.resetAndAdopt(session.id);
          return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
        }
        // human_required / null → LoopPilot has not yet restarted.
        // If a prior Codex recovery action failed (indicated by the
        // "(recovery failed: ...)" suffix in stopDetail and recovery_attempted=0),
        // retry the recovery by re-entering stopSession so transient failures
        // (e.g. failed push or /restart-review post) don't leave the PR
        // stopped and unmonitored across daemon restarts (ES-450 Finding 5).
        if (
          !session.recoveryAttempted &&
          session.stopDetail !== null &&
          session.stopDetail.includes("(recovery failed:")
        ) {
          this.store.updateSession(session.id, { runId: this.runId });
          const retryCtrl = await this.stopSession(
            session,
            session.failureReason as FailureReason,
            stripRecoveryFailedSuffix(session.stopDetail),
          );
          if (retryCtrl.control === "halt") return HALT;
          const retried = this.store.getSession(session.id);
          if (retried.state === "in_review" && retried.prNumber !== null) {
            return await this.adoptAndMonitor(retried, retried.prNumber, retried.monitorStartedAt);
          }
          return retryCtrl;
        }
        return CONTINUE;
      }
      case "pr_closed": {
        // If a prior abandon recovery closed the PR but failed at branch cleanup or ticket
        // revert, retry the full abandon cleanup. isPartialAbandon in stopSession detects
        // the abandon_in_progress sentinel or recovery-failed marker and re-enters executeAbandon,
        // which tolerates "already closed" / "already deleted" gracefully (ES-450 Finding 1).
        if (
          !session.recoveryAttempted &&
          session.stopDetail !== null &&
          (session.stopDetail.startsWith("abandon_in_progress") ||
            session.stopDetail.startsWith("recovery failed: ") ||
            session.stopDetail.includes(" (recovery failed: "))
        ) {
          this.store.updateSession(session.id, { runId: this.runId });
          const retryCtrl = await this.stopSession(session, "pr_closed", null);
          if (retryCtrl.control === "halt") return HALT;
          return retryCtrl;
        }
        return CONTINUE;
      }
      case "merged":
        this.resetAndAdopt(session.id);
        await this.recoverDone(session);
        return CONTINUE;
      case "done":
      case "in_progress":
      case "corrupted":
      case "not_engaged":
      case "workflow_failed":
        this.resetAndAdopt(session.id);
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
  }

  private resetAndAdopt(sessionId: number): void {
    this.store.updateSession(sessionId, {
      state: "in_review",
      runId: this.runId,
      failureReason: null,
      stopDetail: null,
      endedAt: null,
      autoRestartAttempts: 0,
      quotaRetryAttempts: 0,
      pendingRestartReason: null,
      monitorStartedAt: this.clock(),
    });
  }

  /** 回復経路の DONE 後段。セッション行から最小 issue を再構成して done() を再利用する。 */
  private async recoverDone(session: TaskSessionRow): Promise<void> {
    await this.done(session, reconstructIssue(session));
  }

  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 0) 停止要求の安全点（各反復先頭。現フェーズ群完了後にここへ戻る）
      if (this.interrupted) {
        await this.haltForInterrupt();
        return;
      }

      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      // Checked before GROOM so a cap-reached run does not mutate the board before halting.
      const started = this.store.countTasksStarted(this.runId);
      if (started >= this.config.safety.maxTasksPerRun) {
        const detail = `task cap reached: ${started}/${this.config.safety.maxTasksPerRun}`;
        await this.notifier.notify({ kind: "halted", reason: "task_cap", detail });
        await this.commitMemoryBeforeHalt();
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }

      const idleTimeoutMin = this.config.loop.idleTimeoutMinutes;

      // 0.5) GROOM（D-13: failure → skip to SELECT）
      // Skip when the idle timeout has already elapsed so we don't pay for a GROOM pass
      // on a run that is about to halt. SELECT still runs after this so any tickets that
      // arrived during the idle sleep are claimed rather than dropped (ES-475).
      let groomSummary: string | null = null;
      let groomBlockedIds: Set<string> = new Set();
      const idleAlreadyElapsed = (() => {
        if (idleTimeoutMin <= 0) return false;
        const snap = this.store.getRun(this.runId);
        if (snap.idleStartedAt === null) return false;
        return Date.parse(this.clock()) - Date.parse(snap.idleStartedAt) >= idleTimeoutMin * 60_000;
      })();
      if (!idleAlreadyElapsed) {
        const groomResult = await this.groom();
        if (groomResult.control === "halt") return;
        // SIGINT can cause the Codex child to exit non-zero; CodexPlanner surfaces that
        // as kind:"error" rather than kind:"interrupted", so groom() returns "continue".
        // Check the flag here so a stop requested during GROOM always halts before SELECT.
        if (this.interrupted) {
          await this.haltForInterrupt();
          return;
        }
        groomSummary = groomResult.summary;
        groomBlockedIds = groomResult.blockedIds;
      }

      // 2) SELECT（仕様 §5.1 + A1 PM 選別ターン）
      // getAllEligible の失敗（Linear 一時障害等）は CLAIM① と同様にセッション無しで
      // HALT+通知して人間に上げる（無人ループを無通知の Fatal 落ちさせない）。
      let eligible: EligibleIssue[];
      try {
        eligible = await this.source.getAllEligible(this.store.activeIssueIds());
      } catch (err) {
        const detail = `select_failed: getAllEligible: ${errMsg(err)}`;
        await this.notifier.notify({ kind: "halted", reason: "exception", detail });
        await this.commitMemoryBeforeHalt();
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }
      // When GROOM was skipped due to idle timeout but SELECT found eligible tickets,
      // fetch blocked IDs now so dependency-blocked work is not claimed (ES-475).
      if (idleAlreadyElapsed && eligible.length > 0) {
        groomBlockedIds = await this.fetchBlockedIds();
      }
      // Filter out GROOM-identified blocked issues so dependency-blocked work is not started
      // (ES-457 Finding 2).
      if (groomBlockedIds.size > 0) {
        eligible = eligible.filter((i) => !groomBlockedIds.has(i.identifier));
      }
      if (eligible.length === 0) {
        // 1.5) アイドルタイムアウトチェック（ES-475）
        // Checked after SELECT so that work that became eligible during the previous
        // idle sleep is claimed before the timeout fires (ES-475 Finding 1).
        if (idleTimeoutMin > 0) {
          const run = this.store.getRun(this.runId);
          if (run.idleStartedAt !== null) {
            const elapsedMs = Date.parse(this.clock()) - Date.parse(run.idleStartedAt);
            if (elapsedMs >= idleTimeoutMin * 60_000) {
              const detail = `idle timeout: no eligible tickets for ${idleTimeoutMin} minutes`;
              await this.notifier.notify({ kind: "halted", reason: "idle_timeout", detail });
              await this.commitMemoryBeforeHalt();
              this.store.setRunState(this.runId, "halted", detail);
              this.log(detail);
              return;
            }
          }
        }

        // IDLE（キュー空 → 通知は初回のみ → 定期再確認）
        if (!idleNotified) {
          await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
          idleNotified = true;
        }
        this.store.setIdleStartedAt(this.runId, this.clock());
        this.store.setRunState(this.runId, "idle");
        await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
        continue;
      }
      // 復帰：idle から running へ
      idleNotified = false;
      this.store.clearIdleStartedAt(this.runId);
      this.store.setRunState(this.runId, "running");

      let issue: EligibleIssue;
      let selectRationale: string | null = null;
      if (this.planner !== null) {
        const sel = await this.selectWithPm(eligible, groomSummary);
        if (sel.control === "halt") return;
        issue = sel.issue;
        selectRationale = sel.rationale;
      } else {
        issue = eligible[0];
      }

      // Safe point: honor a stop request after SELECT, before the mutating CLAIM phase.
      if (this.interrupted) {
        await this.haltForInterrupt();
        return;
      }

      // 3) CLAIM
      const claim = await this.claim(issue);
      if (!("session" in claim)) {
        if (claim.control === "halt") return;
        continue; // recovery CONTINUE → retry from SELECT
      }
      const session = claim.session;

      // Record PM selection rationale (§1.6)
      if (selectRationale !== null) {
        this.store.updateSession(session.id, { selectRationale });
      }

      // 4) DESIGN + DESIGN REVIEW loop (ES-476 + ES-477)
      let planBrief: PlanBrief | null = null;
      let designReviewReasons: string[] | undefined;
      let designRejected = false;
      {
        let designAttempt = 0;
        const maxRedesigns = this.config.safety.maxDesignReviewAttempts;
        while (true) {
          const design = await this.design(session, issue, designReviewReasons);
          if (design.control === "halt") return;
          planBrief = design.brief;

          // On a redesign iteration, a null/empty brief means the agent could not
          // address the rejection — halt with design_rejected rather than silently
          // proceeding to IMPLEMENT without an approved design.
          if (designReviewReasons !== undefined && (planBrief === null || planBrief.raw.length === 0)) {
            const baseDetailA = `redesign agent failed to produce a brief after rejection: ${designReviewReasons.join("; ")}`;
            const ctrl = await this.stopSession(
              session, "design_rejected",
              baseDetailA,
              {},
              { haltIfRevertFailed: true },
            );
            if (ctrl.control === "halt") return;
            designRejected = true;
            break;
          }

          if (planBrief === null || planBrief.raw.length === 0 || this.designReviewer === null) break;

          if (this.interrupted) {
            await this.haltForInterrupt();
            return;
          }

          const review = await this.designReview(session, issue, planBrief, designReviewReasons);
          if (review.control === "halt") return;

          if (review.verdict === "approve") break;

          if (this.interrupted) {
            await this.haltForInterrupt();
            return;
          }

          designAttempt++;
          if (designAttempt > maxRedesigns) {
            const lastReasons = review.reasons.length > 0 ? review.reasons.join("; ") : "(no reasons provided)";
            const detail = `design review rejected after ${maxRedesigns} redesign attempts: ${lastReasons}`;
            const ctrl = await this.stopSession(session, "design_rejected", detail, {}, { haltIfRevertFailed: true });
            if (ctrl.control === "halt") return;
            designRejected = true;
            break;
          }

          designReviewReasons = review.reasons;
        }

        if (designRejected) continue;
      }

      // Post the final (approved or unreviewed) brief to Linear — only once,
      // not on every redesign iteration.
      if (planBrief !== null && planBrief.raw.length > 0 && !this.interrupted) {
        try {
          await this.source.postComment(issue.id, planBrief.raw);
        } catch (err) {
          this.log(`design: brief writeback failed (non-fatal): ${errMsg(err)}`);
        }
      }

      // Safe point: honor a stop request before the mutating IMPLEMENT phase.
      // DESIGN is read-only, so stopping here leaves the session in "claimed" —
      // recoverByOpenPr auto-reverts claimed sessions with no open PR on the
      // next startup rather than halting for manual cleanup.
      if (this.interrupted) {
        await this.haltForInterrupt();
        return;
      }

      // 5) IMPLEMENT (was 4)
      const impl = await this.implement(session, issue, planBrief);
      if (impl.control === "halt") return;
      // Policy-driven abandon: session stopped, skip remaining phases (ES-490)
      if (this.store.getSession(session.id).state === "stopped") continue;

      // 5.5) SELF-REVIEW (ES-473)
      if (this.config.selfReview.enabled) {
        const sr = await this.selfReview(session, issue, planBrief);
        if (sr.control === "halt") return;
        // Policy-driven abandon: session stopped, skip remaining phases (ES-490)
        if (this.store.getSession(session.id).state === "stopped") continue;
      }

      // Safe point: honor a stop request that arrived before or during self-review.
      // selfReview() may return CONTINUE even if requestStop() was called
      // while the agent was running (the agent returned a normal outcome).
      // Deferring to this point (rather than checking before self-review) ensures
      // the session always has a self_review_log entry on graceful stop, making it
      // recoverable on the next startup (ES-473 Finding 2).
      if (this.interrupted) {
        await this.haltForInterrupt();
        return;
      }

      // 6) HANDOFF (was 5)
      const handoff = await this.handoff(session, issue);
      if (!("prNumber" in handoff)) {
        if (handoff.control === "halt") return;
        // Recovery CONTINUE: if the session was recovered to in_review (e.g. handoff_failed
        // after a PR was already created), resume MONITOR with the recovered PR number.
        const recoveredSession = this.store.getSession(session.id);
        if (recoveredSession.state === "in_review" && recoveredSession.prNumber !== null) {
          const mon = await this.monitorSession(recoveredSession, recoveredSession.prNumber);
          if (mon.control === "halt") return;
          // Skip done() if abandon recovery stopped the session during monitor
          if (this.store.getSession(recoveredSession.id).state !== "stopped") {
            await this.done(recoveredSession, issue);
          }
        }
        continue; // recovery CONTINUE → retry from SELECT
      }
      const prNumber = handoff.prNumber;

      // 7) MONITOR (was 6)
      const mon = await this.monitorSession(session, prNumber);
      if (mon.control === "halt") return;

      // 8) DONE (was 7): skip if abandon recovery stopped the session during monitor
      if (this.store.getSession(session.id).state !== "stopped") {
        await this.done(session, issue);
      }
      // ループ継続（SELECT へ）
    }
  }

  // ---- CLAIM（仕様 §5.2） ----
  private async claim(
    issue: EligibleIssue,
  ): Promise<RunControl | { control: "continue"; session: TaskSessionRow }> {
    let claimResult;
    try {
      claimResult = await this.git.prepareWorktree(issue);
    } catch (err) {
      // ① prepareWorktree 失敗：セッション行なしで HALT（claim_failed を Run.halt_reason へ）
      const detail = `claim_failed: prepareWorktree for ${issue.identifier}: ${errMsg(err)}`;
      await this.notifier.notify({ kind: "halted", reason: "claim_failed", detail });
      await this.commitMemoryBeforeHalt();
      this.store.setRunState(this.runId, "halted", detail);
      this.log(detail);
      return HALT;
    }
    const session = this.store.createSession({
      runId: this.runId,
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueUrl: issue.url,
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
      return await this.stopSession(session, "claim_failed", `transition(in_progress) failed: ${errMsg(err)}`);

    }
    if (this.config.notify.progress) {
      await this.notifier.notify({
        kind: "task_started",
        identifier: issue.identifier,
        title: issue.title,
      });
    }
    return { control: "continue", session };
  }

  // ---- DESIGN（設計 brief 生成: Claude Code, ES-476） ----
  private async design(
    session: TaskSessionRow,
    issue: EligibleIssue,
    designReviewReasons?: string[],
  ): Promise<{ control: "continue"; brief: PlanBrief | null } | { control: "halt" }> {
    if (this.designer === null) {
      return { control: "continue", brief: null };
    }

    const worktreePath = session.worktreePath as string;

    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch (err) {
        this.log(`design: spec loading failed, falling back to raw ticket: ${errMsg(err)}`);
        return { control: "continue", brief: null };
      }
    }

    const planMem = readMemoryAll(worktreePath);
    if (planMem.readErrors) {
      this.log(`design: memory read failed (non-fatal): ${planMem.readErrors.join("; ")}`);
    }

    const prompt = buildPlanPrompt({
      issue,
      specContent,
      memory: {
        implResults: planMem.implResults ?? undefined,
        productKnowledge: planMem.productKnowledge ?? undefined,
      },
      memoryBudgetChars: this.config.memory.injectBudgetChars,
      designReviewReasons,
    });

    let outcome: PlanOutcome;
    try {
      outcome = await this.designer.run({
        worktreePath,
        prompt,
        timeoutMs: this.config.safety.designTimeoutMinutes * 60_000,
      });
    } catch (err) {
      this.log(`design: agent exception, falling back to raw ticket: ${errMsg(err)}`);
      return { control: "continue", brief: null };
    }

    if (outcome.kind === "interrupted") {
      await this.haltForInterrupt();
      return { control: "halt" };
    }

    if (outcome.kind === "error") {
      this.log(`design: agent failed, falling back to raw ticket: ${outcome.message}`);
      return { control: "continue", brief: null };
    }

    const brief = parseBrief(outcome.text);
    if (brief.raw.length > 0) {
      this.log(`design: brief generated (sections=${brief.sections !== null ? "parsed" : "raw-only"})`);
      this.store.updateSession(session.id, { planBrief: brief.raw });
    } else {
      this.log("design: agent returned empty output, falling back to raw ticket");
    }

    return { control: "continue", brief };
  }

  // ---- DESIGN REVIEW（ES-477: Codex ブロッキングレビュー） ----
  private async designReview(
    session: TaskSessionRow,
    issue: EligibleIssue,
    brief: PlanBrief,
    priorRejectReasons?: string[],
  ): Promise<
    | { control: "continue"; verdict: "approve" }
    | { control: "continue"; verdict: "reject"; reasons: string[] }
    | { control: "halt" }
  > {
    if (this.designReviewer === null) {
      return { control: "continue", verdict: "approve" };
    }

    const worktreePath = session.worktreePath as string;

    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch {
        // spec load failure is non-fatal for review; proceed without spec context
      }
    }

    // Read fresh session to get up-to-date designReviewAttempts (may have been updated by a prior rejection).
    const freshSession = this.store.getSession(session.id);
    const attempt = freshSession.designReviewAttempts + 1;
    const logRow = this.store.insertDesignReviewLog({
      runId: this.runId,
      sessionId: session.id,
      attempt,
      startedAt: this.clock(),
    });

    const prompt = buildDesignReviewPrompt({ issue, brief, specContent, priorRejectReasons });

    // Record the starting SHA so any commits the reviewer creates can be undone before
    // the IMPLEMENT phase runs (ES-477 Finding 3).
    const reviewStartSha = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: worktreePath })
      .then((r) => (r.code === 0 ? r.stdout.trim() : null))
      .catch(() => null);

    let outcome: PlanOutcome;
    try {
      outcome = await this.designReviewer.run({
        worktreePath,
        prompt,
        timeoutMs: this.config.safety.designReviewTimeoutMinutes * 60_000,
        model: this.config.pm?.model,
        effort: this.config.pm?.effort.designReview,
      });
    } catch (err) {
      this.log(`designReview: reviewer exception, treating as approve: ${errMsg(err)}`);
      this.store.updateDesignReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: errMsg(err),
      });
      await bestEffort(() => this.git.discardUncommittedChanges(worktreePath));
      // Restore the claimed branch in case the reviewer switched branches, then reset.
      const catchCheckoutRes = await this.runner.run("git", ["checkout", session.branch], { cwd: worktreePath }).catch(() => ({ code: 1, stdout: "", stderr: "checkout threw" }));
      if (catchCheckoutRes.code !== 0) {
        const haltDetail = `designReview: branch restore failed in error path for ${session.branch} (exit ${catchCheckoutRes.code}); halting to avoid IMPLEMENT on wrong branch`;
        this.log(haltDetail);
        await this.stopSession(session, "exception", haltDetail);
        return { control: "halt" };
      }
      if (reviewStartSha) {
        const catchResetRes = await this.runner.run("git", ["reset", "--hard", reviewStartSha], { cwd: worktreePath }).catch(() => ({ code: 1, stdout: "", stderr: "reset threw" }));
        if (catchResetRes.code !== 0) {
          const haltDetail = `designReview: reviewer reset to ${reviewStartSha} failed in error path; halting to prevent reviewer-authored commits from reaching IMPLEMENT`;
          this.log(haltDetail);
          await this.stopSession(session, "exception", haltDetail);
          return { control: "halt" };
        }
      }
      return { control: "continue", verdict: "approve" };
    }

    // Discard any uncommitted changes the reviewer may have left in the worktree
    // before the implementation phase runs.
    await bestEffort(() => this.git.discardUncommittedChanges(worktreePath));
    // Restore the claimed branch in case the reviewer switched branches, then reset.
    const checkoutRes = await this.runner.run("git", ["checkout", session.branch], { cwd: worktreePath }).catch(() => ({ code: 1, stdout: "", stderr: "checkout threw" }));
    if (checkoutRes.code !== 0) {
      const haltDetail = `designReview: branch restore failed for ${session.branch} (exit ${checkoutRes.code}); halting to avoid IMPLEMENT on wrong branch`;
      this.log(haltDetail);
      await this.stopSession(session, "exception", haltDetail);
      return { control: "halt" };
    }
    // Reset to the pre-review SHA to undo any commits the reviewer created.
    if (reviewStartSha) {
      const resetRes = await this.runner.run("git", ["reset", "--hard", reviewStartSha], { cwd: worktreePath }).catch(() => ({ code: 1, stdout: "", stderr: "reset threw" }));
      if (resetRes.code !== 0) {
        const haltDetail = `designReview: reviewer reset to ${reviewStartSha} failed; halting to prevent reviewer-authored commits from reaching IMPLEMENT`;
        this.log(haltDetail);
        await this.stopSession(session, "exception", haltDetail);
        return { control: "halt" };
      }
    }

    if (outcome.kind === "interrupted") {
      this.store.updateDesignReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: "interrupted",
      });
      await this.haltForInterrupt();
      return { control: "halt" };
    }

    if (outcome.kind === "error") {
      this.log(`designReview: reviewer failed, treating as approve: ${outcome.message}`);
      this.store.updateDesignReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: outcome.message,
      });
      return { control: "continue", verdict: "approve" };
    }

    const parsed = parseDesignReviewOutput(outcome.text);

    if (parsed.kind === "parse_error") {
      this.log("designReview: parse error, treating as approve");
      this.store.updateDesignReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: `parse error: ${parsed.raw.slice(0, 200)}`,
      });
      return { control: "continue", verdict: "approve" };
    }

    const { verdict, reasons } = parsed.value;
    this.store.updateDesignReviewLog(logRow.id, {
      endedAt: this.clock(),
      verdict,
      reasons: JSON.stringify(reasons),
      outcome: verdict === "approve" ? "approved" : "rejected",
    });

    this.log(`designReview: attempt ${attempt} → ${verdict}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`);

    if (verdict === "approve") {
      return { control: "continue", verdict: "approve" };
    }

    this.store.updateSession(session.id, { designReviewAttempts: attempt });
    return { control: "continue", verdict: "reject", reasons };
  }

  // ---- fetchBlockedIds（lightweight board fetch, no planner） ----
  // Used when GROOM is skipped (idle timeout elapsed) but SELECT found eligible tickets,
  // so that dependency-blocked work is still filtered before claiming (ES-475).
  private async fetchBlockedIds(): Promise<Set<string>> {
    if (!this.config.groom.enabled || this.groomDeps === null) {
      return new Set<string>();
    }
    try {
      this.groomDeps.boardFetcher.refresh();
      const activeSessionPrNumbers = new Map<string, number | null>();
      for (const s of this.store.activeSessions()) {
        activeSessionPrNumbers.set(s.linearIdentifier, s.prNumber);
      }
      const boardState = await this.groomDeps.boardFetcher.getBoardState(activeSessionPrNumbers);
      return new Set<string>(boardState.blocked.map((b) => b.identifier));
    } catch (err) {
      this.log(`fetchBlockedIds: board fetch failed, skipping: ${errMsg(err)}`);
      return new Set<string>();
    }
  }

  // ---- GROOM（ES-457: Board Grooming Phase） ----
  private async groom(): Promise<{ control: "continue"; summary: string | null; blockedIds: Set<string> } | { control: "halt" }> {
    if (!this.config.groom.enabled || this.groomDeps === null || this.planner === null) {
      return { control: "continue", summary: null, blockedIds: new Set<string>() };
    }

    this.groomLoopIndex++;
    let groomLogRow: { id: number };
    try {
      groomLogRow = this.store.insertGroomLog({
        runId: this.runId,
        loopIndex: this.groomLoopIndex,
        startedAt: this.clock(),
      });
    } catch (err) {
      this.log(`groom: failed to insert groom_log, skipping: ${errMsg(err)}`);
      return { control: "continue", summary: null, blockedIds: new Set<string>() };
    }

    try {
      // 1. Fetch board state
      this.groomDeps.boardFetcher.refresh();
      const activeSessionPrNumbers = new Map<string, number | null>();
      for (const s of this.store.activeSessions()) {
        activeSessionPrNumbers.set(s.linearIdentifier, s.prNumber);
      }

      let boardState: BoardState;
      try {
        boardState = await this.groomDeps.boardFetcher.getBoardState(activeSessionPrNumbers);
      } catch (err) {
        this.log(`groom: board fetch failed, skipping: ${errMsg(err)}`);
        try {
          this.store.updateGroomLog(groomLogRow.id, {
            endedAt: this.clock(),
            outcome: "skipped",
            errorDetail: `board fetch failed: ${errMsg(err)}`,
          });
        } catch (logErr) {
          this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
        }
        return { control: "continue", summary: null, blockedIds: new Set<string>() };
      }
      // Build blocked identifier set for SELECT-time filtering (ES-457 Finding 2).
      const blockedIds = new Set<string>(boardState.blocked.map((b) => b.identifier));

      // 2. Fetch default branch so memory/spec/codebase reads see the current state of main
      // rather than a stale local checkout from a previous merge iteration (ES-457 Finding 3).
      try {
        await this.git.fetchDefaultBranch();
      } catch (err) {
        this.log(`groom: fetch failed (non-fatal): ${errMsg(err)}`);
      }

      // 3. Assemble prompt
      const repoPath = this.config.repo.path;
      const groomMem = readMemoryAll(repoPath);
      if (groomMem.readErrors) {
        this.log(`groom: memory read failed (non-fatal): ${groomMem.readErrors.join("; ")}`);
      }

      let specContent: SpecContent | null = null;
      const specDir = this.config.product.specDir;
      if (specDir !== undefined && this.specLoader !== null) {
        try {
          specContent = this.specLoader(repoPath, specDir);
        } catch (err) {
          this.log(`groom: spec loading failed (non-fatal): ${errMsg(err)}`);
        }
      }

      const digest = this.config.digest.enabled
        ? this.store.recentMergedSummaries(this.config.digest.recentMergedCount)
        : [];

      let codebaseSummary: string | null = null;
      try {
        const summary = await this.codebaseSummaryGenerator(repoPath);
        if (summary.length > 0) codebaseSummary = summary;
      } catch (err) {
        this.log(`groom: codebase summary failed (non-fatal): ${errMsg(err)}`);
      }

      const prompt = buildGroomPrompt({
        specContent,
        goal: this.config.product.goal ?? null,
        memory: {
          pmDecisions: groomMem.pmDecisions ?? null,
          implResults: groomMem.implResults ?? null,
          productKnowledge: groomMem.productKnowledge ?? null,
        },
        board: boardState,
        boardBudgetChars: this.config.safety.groomBoardBudgetChars,
        memoryBudgetChars: this.config.memory.injectBudgetChars,
        digest,
        codebaseSummary,
        optInLabel: this.config.linear.optInLabel,
        maxMemoryChars: this.config.memory.maxCharsPerFile,
        knownLabels: this.groomDeps.knownLabels,
      });

      // Record the starting SHA before Codex runs so any commits Codex creates can be
      // undone before the memory commit is pushed (ES-457 Finding 1).
      const startSha = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: repoPath })
        .then((r) => (r.code === 0 ? r.stdout.trim() : null))
        .catch(() => null);

      // 3. Run Codex
      let codexOutput: string;
      try {
        const outcome = await this.planner.run({
          worktreePath: repoPath,
          prompt,
          timeoutMs: this.config.safety.groomTimeoutMinutes * 60_000,
          model: this.config.pm?.model,
          effort: this.config.pm?.effort.groom,
        });
        if (outcome.kind === "interrupted") {
          try {
            this.store.updateGroomLog(groomLogRow.id, {
              endedAt: this.clock(),
              outcome: "skipped",
              errorDetail: "interrupted",
            });
          } catch (logErr) {
            this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
          }
          // Reset the full checkout so any files Codex wrote are discarded before
          // haltForInterrupt() calls commitMemoryBeforeHalt() (Finding 3 + 4).
          await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
          await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
          // Reset to startSha so any commits Codex created are undone (ES-457 Finding 1).
          if (startSha) {
            await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
          }
          await this.haltForInterrupt();
          return { control: "halt" };
        }
        if (outcome.kind === "error") {
          this.log(`groom: codex failed, skipping: ${outcome.message}`);
          try {
            this.store.updateGroomLog(groomLogRow.id, {
              endedAt: this.clock(),
              outcome: "error",
              errorDetail: `codex error: ${outcome.message}`,
            });
          } catch (logErr) {
            this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
          }
          // Reset checkout so any files Codex may have written are discarded (Finding 3 + 4).
          await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
          await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
          // Reset to startSha so any commits Codex created are undone (ES-457 Finding 1).
          if (startSha) {
            await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
          }
          return { control: "continue", summary: null, blockedIds };
        }
        codexOutput = outcome.text;
      } catch (err) {
        this.log(`groom: codex exception, skipping: ${errMsg(err)}`);
        try {
          this.store.updateGroomLog(groomLogRow.id, {
            endedAt: this.clock(),
            outcome: "error",
            errorDetail: `codex exception: ${errMsg(err)}`,
          });
        } catch (logErr) {
          this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
        }
        // Reset checkout so any files Codex may have written are discarded (Finding 3 + 4).
        await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
        await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
        // Reset to startSha so any commits Codex created are undone (ES-457 Finding 1).
        if (startSha) {
          await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
        }
        return { control: "continue", summary: null, blockedIds };
      }

      // 4. Parse
      const parseResult = parseGroomOutput(codexOutput);
      if (parseResult.kind === "parse_error") {
        const preview = parseResult.raw.slice(0, 200);
        this.log(`groom: parse failed, skipping. Raw: ${preview}`);
        try {
          this.store.updateGroomLog(groomLogRow.id, {
            endedAt: this.clock(),
            outcome: "error",
            errorDetail: `parse failed: ${preview}`,
          });
        } catch (logErr) {
          this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
        }
        // Reset checkout so any files Codex wrote are discarded (Finding 3 + 4).
        await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
        await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
        // Reset to startSha so any commits Codex created are undone (ES-457 Finding 1).
        if (startSha) {
          await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
        }
        return { control: "continue", summary: null, blockedIds };
      }

      const groomOutput = parseResult.value;
      const allActions = groomOutput.actions;

      // 5. Validate
      // Refresh the board cache so the validation reads don't use the pre-Codex snapshot
      // (Finding 4): a ticket may have been completed or lost its opt-in label while GROOM ran.
      this.groomDeps.boardFetcher.refresh();
      let validationCtx: ValidationContext;
      try {
        // Fetch sequentially: the first call re-populates the cache; the subsequent
        // calls hit the cache and are effectively free.
        const projectIds = await this.groomDeps.boardFetcher.getProjectIssueIds();
        const doneIds = await this.groomDeps.boardFetcher.getDoneIssueIds();
        const optInIds = await this.groomDeps.boardFetcher.getOptInIssueIds();
        const activeIds = await this.groomDeps.boardFetcher.getActiveIssueIds();
        const needsHumanIds = await this.groomDeps.boardFetcher.getNeedsHumanIssueIds(this.config.linear.needsHumanLabel);
        validationCtx = {
          projectIssueIds: projectIds,
          allIssueIds: projectIds,
          optInLabel: this.config.linear.optInLabel,
          optInIssueIds: optInIds,
          doneIssueIds: doneIds,
          activeIssueIds: activeIds,
          needsHumanIssueIds: needsHumanIds,
          maxCharsPerFile: this.config.memory.maxCharsPerFile,
          knownLabels: this.groomDeps.knownLabels,
        };
      } catch (err) {
        this.log(`groom: validation context fetch failed, skipping: ${errMsg(err)}`);
        try {
          this.store.updateGroomLog(groomLogRow.id, {
            endedAt: this.clock(),
            outcome: "error",
            errorDetail: `validation context fetch failed: ${errMsg(err)}`,
            actionsRequested: allActions.length,
            summary: groomOutput.summary,
          });
        } catch (logErr) {
          this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
        }
        // Reset checkout so any files Codex wrote are discarded (Finding 3 + 4).
        await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
        await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
        // Reset to startSha so any commits Codex created are undone (ES-457 Finding 1).
        if (startSha) {
          await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
        }
        return { control: "continue", summary: null, blockedIds };
      }

      const validationResults = validateGroomActions(allActions, validationCtx);
      const validActions = validationResults
        .filter((r) => r.result === "valid")
        .map((r) => r.action);
      const rejectedCount = validationResults.filter((r) => r.result === "rejected").length;

      // Reset the full checkout so any files the Codex process may have written are
      // discarded before validated update_memory actions write fresh content.
      // Using the full tree (not just docs/memory/) prevents tracked or untracked
      // files outside memory from persisting into the next SELECT preflight (Finding 3).
      await this.runner.run("git", ["checkout", "HEAD", "--", "."], { cwd: repoPath }).catch(() => {});
      await this.runner.run("git", ["clean", "-fd"], { cwd: repoPath }).catch(() => {});
      // If Codex created commits and advanced HEAD, reset back to the recorded starting
      // SHA so only the memory commit is pushed (ES-457 Finding 1).
      if (startSha) {
        await this.runner.run("git", ["reset", "--hard", startSha], { cwd: repoPath }).catch(() => {});
      }

      // 6. Execute one action at a time with SIGINT check per action (D-14)
      const executorCtx: ExecutorContext = {
        linearClient: this.groomDeps.linearClient,
        repoPath,
        maxCharsPerFile: this.config.memory.maxCharsPerFile,
        optInLabel: this.config.linear.optInLabel,
      };

      const executionResults: ExecutionResult[] = [];

      // Shared helper: record partial results and halt (used at both pre- and post-action
      // interrupt checks so neither can be skipped when SIGINT arrives during the last action).
      const haltGroomWithPartialResults = async (): Promise<{ control: "halt" }> => {
        const executed = executionResults.filter((r) => r.outcome === "executed").length;
        try {
          this.store.updateGroomLog(groomLogRow.id, {
            endedAt: this.clock(),
            summary: groomOutput.summary,
            actionsRequested: allActions.length,
            actionsExecuted: executed,
            actionsRejected: rejectedCount,
            actionDetails: JSON.stringify(
              validationResults.map((vr) => {
                const execResult = executionResults.find((er) => er.action === vr.action);
                return {
                  type: vr.action.type,
                  payload: vr.action,
                  result: vr.result === "rejected" ? "rejected" : (execResult?.outcome ?? "skipped"),
                  reason: vr.reason ?? execResult?.error,
                };
              }),
            ),
            outcome: "skipped",
            errorDetail: "interrupted during execution",
          });
        } catch (logErr) {
          this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
        }
        await this.haltForInterrupt();
        return { control: "halt" };
      };

      for (const action of validActions) {
        if (this.interrupted) {
          return await haltGroomWithPartialResults();
        }

        try {
          const [result] = await executeGroomActions([action], executorCtx);
          if (result.outcome === "failed") {
            this.log(`groom: action failed (type=${action.type}, target=${"issueId" in action ? action.issueId : "n/a"}): ${result.error ?? "unknown"}`);
          }
          executionResults.push(result);
        } catch (err) {
          this.log(`groom: action exception (type=${action.type}, target=${"issueId" in action ? action.issueId : "n/a"}): ${errMsg(err)}`);
          executionResults.push({ action, outcome: "failed", error: errMsg(err) });
        }

        // Safe-point check after each action so an interrupt arriving during the last
        // action halts cleanly instead of falling through to SELECT (ES-457 Finding 5).
        if (this.interrupted) {
          return await haltGroomWithPartialResults();
        }
      }

      // If any update_memory actions executed, commit and push memory changes so they
      // survive the git reset --hard in fetchDefaultBranch during SELECT (ES-457 Finding 2).
      const memoryUpdated = executionResults.some(
        (r) => r.outcome === "executed" && r.action.type === "update_memory",
      );
      if (memoryUpdated) {
        try {
          const committed = await commitIfChanged(this.runner, repoPath);
          if (committed) {
            const defaultBranch = this.config.repo.defaultBranch;
            const pushRes = await this.runner.run(
              "git",
              ["push", "origin", `HEAD:${defaultBranch}`],
              { cwd: repoPath },
            ).catch((_e: unknown) => ({ code: 1, stdout: "", stderr: "push runner error" }));
            if (pushRes.code !== 0) {
              await this.runner.run("git", ["reset", "--hard", "HEAD~1"], { cwd: repoPath }).catch(() => {});
              const pushErr = pushRes.stderr.trim();
              this.log(`groom: memory push failed (rolled back): ${pushErr}`);
              // The commit was rolled back, so mark update_memory results as failed so the
              // groom_log and summaryForSelect reflect the actual outcome.
              for (const r of executionResults) {
                if (r.outcome === "executed" && r.action.type === "update_memory") {
                  r.outcome = "failed";
                  r.error = `memory push failed; commit rolled back: ${pushErr}`;
                }
              }
            }
          }
        } catch (err) {
          const commitErr = errMsg(err);
          this.log(`groom: memory commit failed (non-fatal): ${commitErr}`);
          // ES-470: clean up dirty memory files so they don't leak into SELECT.
          // commitIfChanged already attempts internal cleanup, but if that also fails,
          // dirty files would survive until fetchDefaultBranch() destroys them silently.
          // Unstage first: if git add succeeded before the failure, newly staged files
          // are not untracked and git clean would skip them without this reset.
          await this.runner.run("git", ["reset", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
          await this.runner.run("git", ["checkout", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
          await this.runner.run("git", ["clean", "-fd", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
          // The commit (or git add) failed so the memory changes were not persisted.
          // Mark the corresponding update_memory results as failed so groom_log and
          // summaryForSelect reflect the actual outcome (Finding 2).
          for (const r of executionResults) {
            if (r.outcome === "executed" && r.action.type === "update_memory") {
              r.outcome = "failed";
              r.error = `memory commit failed: ${commitErr}`;
            }
          }
        }
      }

      // Safe-point after memory git operations: if SIGINT arrived during the commit/push
      // the last per-action check has already passed; halt here before launching SELECT
      // (Finding 5).
      if (this.interrupted) {
        return await haltGroomWithPartialResults();
      }

      // 7. Record groom_log
      const executedCount = executionResults.filter((r) => r.outcome === "executed").length;
      const actionDetailsList = validationResults.map((vr) => {
        const execResult = executionResults.find(
          (er) => er.action === vr.action,
        );
        return {
          type: vr.action.type,
          payload: vr.action,
          result: vr.result === "rejected" ? "rejected" : (execResult?.outcome ?? "skipped"),
          reason: vr.reason ?? execResult?.error,
        };
      });

      try {
        this.store.updateGroomLog(groomLogRow.id, {
          endedAt: this.clock(),
          summary: groomOutput.summary,
          actionsRequested: allActions.length,
          actionsExecuted: executedCount,
          actionsRejected: rejectedCount,
          actionDetails: JSON.stringify(actionDetailsList),
          outcome: "completed",
        });
      } catch (logErr) {
        this.log(`groom: failed to update groom_log: ${errMsg(logErr)}`);
      }

      this.log(
        `groom: completed (requested=${allActions.length}, executed=${executedCount}, rejected=${rejectedCount}): ${groomOutput.summary}`,
      );

      // Only relay the model's raw summary to SELECT if all accepted actions executed.
      // If any failed or were rejected, the summary may describe effects that never happened;
      // annotate it so SELECT sees the discrepancy (ES-457 Finding 6).
      const failedExecutions = validActions.length - executedCount;
      const summaryForSelect = (rejectedCount === 0 && failedExecutions === 0)
        ? groomOutput.summary
        : `${groomOutput.summary} [${executedCount}/${allActions.length} executed]`;
      return { control: "continue", summary: summaryForSelect, blockedIds };
    } catch (err) {
      this.log(`groom: unexpected error, skipping: ${errMsg(err)}`);
      try {
        this.store.updateGroomLog(groomLogRow.id, {
          endedAt: this.clock(),
          outcome: "error",
          errorDetail: `unexpected: ${errMsg(err)}`,
        });
      } catch (logErr) {
        this.log(`groom: failed to update groom_log in error handler: ${errMsg(logErr)}`);
      }
      return { control: "continue", summary: null, blockedIds: new Set<string>() };
    }
  }

  // ---- SELECT PM（スコープ doc A1 / §1.4 / §1.5） ----
  private async selectWithPm(
    eligible: EligibleIssue[],
    groomSummary: string | null = null,
  ): Promise<
    | { control: "continue"; issue: EligibleIssue; rationale: string | null }
    | { control: "halt" }
  > {
    if (eligible.length === 0) {
      throw new Error("selectWithPm called with empty eligible list");
    }
    // Only 1 eligible → no point asking PM, skip to avoid wasting a Codex call
    if (eligible.length === 1) {
      return { control: "continue", issue: eligible[0], rationale: null };
    }

    // Ensure the repo checkout is up-to-date before reading specs or running Codex.
    try {
      await this.git.fetchDefaultBranch();
    } catch (err) {
      this.log(`select: fetch failed (non-fatal): ${errMsg(err)}`);
    }

    // Build PM selection context
    const inProgress = this.store.activeSessions().map((s) => ({
      linearIdentifier: s.linearIdentifier,
      issueTitle: s.issueTitle,
    }));

    const recentMerged = this.config.digest.enabled
      ? this.store.recentMergedSummaries(this.config.digest.recentMergedCount)
      : [];

    // Load spec content for the anchor
    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(this.config.repo.path, specDir);
      } catch (err) {
        this.log(`select: spec loading failed (non-fatal): ${errMsg(err)}`);
      }
    }

    // Get last merged PR diff context
    let lastPrDiff: { identifier: string; summary: PrDiffSummary } | null = null;
    const lastMerged = this.store.lastMergedWithPr();
    if (lastMerged !== null && lastMerged.prNumber !== null) {
      try {
        const summary = await this.git.getPrDiffSummary(lastMerged.prNumber, this.config.safety.selectDiffBudgetChars);
        lastPrDiff = { identifier: lastMerged.linearIdentifier, summary };
      } catch (err) {
        this.log(`select: PR diff retrieval failed (non-fatal): ${errMsg(err)}`);
      }
    }

    // コードベースサマリ生成（ES-445）
    let codebaseSummary: string | null = null;
    try {
      const summary = await this.codebaseSummaryGenerator(this.config.repo.path);
      if (summary.length > 0) codebaseSummary = summary;
    } catch (err) {
      this.log(`select: codebase summary generation failed (non-fatal): ${errMsg(err)}`);
    }

    const selectMem = readMemoryAll(this.config.repo.path);
    if (selectMem.readErrors) {
      this.log(`select: memory read failed (non-fatal): ${selectMem.readErrors.join("; ")}`);
    }

    const prompt = buildSelectPrompt({
      goal: this.config.product.goal ?? null,
      specContent,
      eligible,
      inProgress,
      recentMerged,
      lastPrDiff,
      diffBudgetChars: this.config.safety.selectDiffBudgetChars,
      codebaseSummary,
      memory: {
        pmDecisions: selectMem.pmDecisions ?? undefined,
        implResults: selectMem.implResults ?? undefined,
      },
      memoryBudgetChars: this.config.memory.injectBudgetChars,
      groomSummary,
    });

    let outcome: PlanOutcome;
    // SELECT runs before CLAIM so no worktree exists yet; use the repo root.
    const repoPath = this.config.repo.path;
    try {
      outcome = await this.planner!.run({
        worktreePath: repoPath,
        prompt,
        timeoutMs: this.config.safety.codexTimeoutMinutes * 60_000,
        model: this.config.pm?.model,
        effort: this.config.pm?.effort.select,
      });
    } catch (err) {
      this.log(`select: codex exception, deterministic fallback: ${errMsg(err)}`);
      return {
        control: "continue",
        issue: eligible[0],
        rationale: `deterministic fallback: codex exception: ${errMsg(err)}`,
      };
    }

    if (outcome.kind === "interrupted") {
      await this.haltForInterrupt();
      return { control: "halt" };
    }

    if (outcome.kind === "error") {
      this.log(`select: codex failed, deterministic fallback: ${outcome.message}`);
      return {
        control: "continue",
        issue: eligible[0],
        rationale: `deterministic fallback: codex error: ${outcome.message}`,
      };
    }

    // Parse Codex output
    const parsed = parseSelection(outcome.text);
    if (parsed === null) {
      const preview = outcome.text.slice(0, 300);
      this.log(`select: failed to parse codex output, deterministic fallback. Raw output: ${preview}`);
      return {
        control: "continue",
        issue: eligible[0],
        rationale: "deterministic fallback: parse failure",
      };
    }

    // Match identifier against eligible set
    const matched = eligible.find((e) => e.identifier === parsed.identifier);
    if (matched === undefined) {
      this.log(`select: identifier "${parsed.identifier}" not in eligible set, deterministic fallback`);
      return {
        control: "continue",
        issue: eligible[0],
        rationale: `deterministic fallback: identifier "${parsed.identifier}" not in eligible set`,
      };
    }

    this.log(`select: PM picked ${matched.identifier}: ${parsed.rationale}`);
    return { control: "continue", issue: matched, rationale: parsed.rationale };
  }

  // ---- IMPLEMENT（仕様 §5.3） ----
  private async implement(session: TaskSessionRow, issue: EligibleIssue, planBrief: PlanBrief | null = null): Promise<RunControl> {
    this.store.updateSession(session.id, { state: "implementing" });
    const digest = this.config.digest.enabled
      ? this.store.recentMergedSummaries(this.config.digest.recentMergedCount)
      : [];
    const worktreePath = session.worktreePath as string;
    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch (err) {
        await bestEffort(() => this.git.discardWorktree(session.branch, worktreePath));
        await bestEffort(() => this.source.transition(issue.id, "todo"));
        return await this.stopSession(session, "exception", `spec loading failed: ${errMsg(err)}`);
      }
    }
    const mem = readMemoryAll(worktreePath);
    if (mem.readErrors) {
      this.log(`implement: memory read failed (non-fatal): ${mem.readErrors.join("; ")}`);
    }

    const prompt = this.buildPrompt({
      goal: this.config.product.goal ?? null,
      specContent,
      issue,
      digest,
      planBrief,
      memory: {
        implResults: mem.implResults ?? undefined,
        productKnowledge: mem.productKnowledge ?? undefined,
      },
      memoryBudgetChars: this.config.memory.injectBudgetChars,
    });
    let outcome: AgentOutcome;
    try {
      outcome = await this.agent.runSession({
        worktreePath,
        prompt,
        maxCostUsd: this.config.safety.maxCostUsdPerSession,
        hardTimeoutMs: this.config.safety.sessionHardTimeoutMinutes * 60_000,
      });
    } catch (err) {
      return await this.stopSession(session, "exception", errMsg(err));
    }

    if (outcome.kind === "interrupted") {
      this.store.updateSession(session.id, { costUsd: outcome.costUsd });
      await this.haltForInterrupt();
      return HALT;
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
    // Wrap post-agent git checks: if git status/log fails (e.g. worktree disappeared or
    // index lock), the throw must not escape uncaught — it would crash the daemon without
    // calling stopSession and leave the session stuck in "implementing".
    try {
      if (await this.git.hasUncommittedChanges(worktreePath)) {
        return await this.stopSession(session, "agent_no_change", "uncommitted leftovers", { costUsd: outcome.costUsd });
      }
      if (!(await this.git.hasCommitsWithDiff(worktreePath))) {
        return await this.stopSession(session, "agent_no_change", null, { costUsd: outcome.costUsd });
      }
    } catch (err) {
      return await this.stopSession(session, "exception", errMsg(err), { costUsd: outcome.costUsd });
    }
    return CONTINUE;
  }

  // ---- SELF-REVIEW (ES-473) ----
  private async selfReview(
    session: TaskSessionRow,
    issue: EligibleIssue,
    planBrief: PlanBrief | null,
  ): Promise<RunControl> {
    const worktreePath = session.worktreePath as string;

    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch (err) {
        // specDir is configured, so spec content is required for the review gate.
        // Without it the reviewer cannot check spec alignment and must not proceed.
        this.log(`selfReview: spec loading failed: ${errMsg(err)}`);
        return await this.stopSession(
          session,
          "exception",
          `self-review: spec loading failed: ${errMsg(err)}`,
        );
      }
    }

    const mem = readMemoryAll(worktreePath);
    if (mem.readErrors) {
      this.log(`selfReview: memory read failed (non-fatal): ${mem.readErrors.join("; ")}`);
    }

    const prompt = buildSelfReviewPrompt({
      issue,
      brief: planBrief,
      specContent,
      defaultBranch: this.config.repo.defaultBranch,
      specDir: this.config.product.specDir,
      memory: {
        implResults: mem.implResults ?? undefined,
        productKnowledge: mem.productKnowledge ?? undefined,
      },
      memoryBudgetChars: this.config.memory.injectBudgetChars,
    });

    const logRow = this.store.insertSelfReviewLog({
      runId: this.runId,
      sessionId: session.id,
      startedAt: this.clock(),
    });

    // Verify the worktree is on session.branch before capturing the pre-review SHA.
    // If IMPLEMENT left the worktree on a different branch, the SHA captured below
    // belongs to that other branch; the nonfatal cleanup path would then reset
    // session.branch to an off-branch commit (ES-473 Codex Finding 2).
    try {
      const preBranchRes = await this.runner.run(
        "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: worktreePath, timeoutMs: 30_000 },
      );
      const preBranch = preBranchRes.code === 0 ? preBranchRes.stdout.trim() : null;
      if (preBranch !== session.branch) {
        this.log(`selfReview: worktree on wrong branch "${preBranch ?? "unknown"}" before review (expected "${session.branch}"); stopping`);
        this.store.updateSelfReviewLog(logRow.id, {
          endedAt: this.clock(),
          outcome: "error",
          errorDetail: `guard:pre-review branch: on "${preBranch ?? "unknown"}" (expected "${session.branch}")`,
        });
        return await this.stopSession(
          session,
          "exception",
          `self-review: worktree on wrong branch "${preBranch ?? "unknown"}" before review (expected "${session.branch}")`,
        );
      }
    } catch (preBranchErr) {
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: `guard:pre-review branch check failed: ${errMsg(preBranchErr)}`,
      });
      return await this.stopSession(
        session,
        "exception",
        `self-review: branch check failed before review: ${errMsg(preBranchErr)}`,
      );
    }

    // Capture HEAD before the review agent runs so we can reset any commits it
    // makes on failure paths (cost_exceeded / error / parse_error / exception).
    // A failure to capture this SHA is fatal: without it, commit-consistency and
    // reset-on-failure guards are both disabled, so partial reviewer commits could
    // reach HANDOFF undetected (ES-473 Finding 3).
    let preReviewSha: string | null = null;
    try {
      const shaRes = await this.runner.run(
        "git", ["-C", worktreePath, "rev-parse", "HEAD"],
        { cwd: worktreePath, timeoutMs: 30_000 },
      );
      if (shaRes.code !== 0) {
        this.store.updateSelfReviewLog(logRow.id, {
          endedAt: this.clock(),
          outcome: "error",
          errorDetail: `guard:pre-review SHA: git exit ${shaRes.code}`,
        });
        return await this.stopSession(
          session,
          "exception",
          `self-review: could not capture pre-review HEAD SHA (exit ${shaRes.code})`,
        );
      }
      if (shaRes.stdout.trim()) {
        preReviewSha = shaRes.stdout.trim();
      }
    } catch (shaErr) {
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: `guard:pre-review SHA: ${errMsg(shaErr)}`,
      });
      return await this.stopSession(
        session,
        "exception",
        `self-review: could not capture pre-review HEAD SHA: ${errMsg(shaErr)}`,
      );
    }

    let outcome: AgentOutcome;
    try {
      outcome = await this.selfReviewAgent.runSession({
        worktreePath,
        prompt,
        maxCostUsd: this.config.safety.maxCostUsdPerSelfReview,
        hardTimeoutMs: this.config.safety.selfReviewTimeoutMinutes * 60_000,
      });
    } catch (err) {
      const agentErrDetail = errMsg(err);
      this.log(`selfReview: agent exception (non-fatal): ${agentErrDetail}`);
      await bestEffort(() => this.git.discardUncommittedChanges(worktreePath));
      if (preReviewSha !== null) {
        try {
          const branchRes = await this.runner.run(
            "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (branchRes.code === 0 && branchRes.stdout.trim() !== session.branch) {
            const checkoutRes = await this.runner.run(
              "git", ["-C", worktreePath, "checkout", session.branch],
              { cwd: worktreePath, timeoutMs: 30_000 },
            );
            if (checkoutRes.code !== 0) {
              return await this.stopSession(
                session,
                "exception",
                `self-review: cleanup checkout failed (exit ${checkoutRes.code})`,
              );
            }
          }
          const resetRes = await this.runner.run(
            "git", ["-C", worktreePath, "reset", "--hard", preReviewSha],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (resetRes.code !== 0) {
            return await this.stopSession(
              session,
              "exception",
              `self-review: cleanup reset failed (exit ${resetRes.code})`,
            );
          }
        } catch (cleanupErr) {
          return await this.stopSession(
            session,
            "exception",
            `self-review: cleanup reset failed: ${errMsg(cleanupErr)}`,
          );
        }
      }
      // Write outcome only after cleanup succeeds so crash-recovery cannot mistake a
      // mid-cleanup crash for a handoff-eligible completed error (ES-473 Finding 1).
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        errorDetail: agentErrDetail,
      });
      return CONTINUE;
    }

    if (outcome.kind === "interrupted") {
      const interruptedSession = this.store.getSession(session.id);
      this.store.updateSession(session.id, {
        selfReviewCostUsd: outcome.costUsd,
        costUsd: (interruptedSession.costUsd ?? 0) + (outcome.costUsd ?? 0),
      });
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        costUsd: outcome.costUsd,
        errorDetail: "interrupted",
      });
      await this.haltForInterrupt();
      return HALT;
    }

    if (outcome.kind === "cost_exceeded" || outcome.kind === "error") {
      const errDetail = outcome.kind === "error" ? outcome.message : "cost exceeded";
      this.log(`selfReview: agent ${outcome.kind} (non-fatal): ${errDetail}`);
      const failedSession = this.store.getSession(session.id);
      this.store.updateSession(session.id, {
        selfReviewCostUsd: outcome.costUsd,
        costUsd: (failedSession.costUsd ?? 0) + (outcome.costUsd ?? 0),
      });
      await bestEffort(() => this.git.discardUncommittedChanges(worktreePath));
      if (preReviewSha !== null) {
        try {
          const branchRes = await this.runner.run(
            "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (branchRes.code === 0 && branchRes.stdout.trim() !== session.branch) {
            const checkoutRes = await this.runner.run(
              "git", ["-C", worktreePath, "checkout", session.branch],
              { cwd: worktreePath, timeoutMs: 30_000 },
            );
            if (checkoutRes.code !== 0) {
              return await this.stopSession(
                session,
                "exception",
                `self-review: cleanup checkout failed (exit ${checkoutRes.code})`,
              );
            }
          }
          const resetRes = await this.runner.run(
            "git", ["-C", worktreePath, "reset", "--hard", preReviewSha],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (resetRes.code !== 0) {
            return await this.stopSession(
              session,
              "exception",
              `self-review: cleanup reset failed (exit ${resetRes.code})`,
            );
          }
        } catch (cleanupErr) {
          return await this.stopSession(
            session,
            "exception",
            `self-review: cleanup reset failed: ${errMsg(cleanupErr)}`,
          );
        }
      }
      // Write outcome only after cleanup succeeds so crash-recovery cannot mistake a
      // mid-cleanup crash for a handoff-eligible completed error (ES-473 Finding 1).
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        costUsd: outcome.costUsd,
        errorDetail: errDetail,
      });
      return CONTINUE;
    }

    // completed
    const completedSession = this.store.getSession(session.id);
    this.store.updateSession(session.id, {
      selfReviewCostUsd: outcome.costUsd,
      costUsd: (completedSession.costUsd ?? 0) + (outcome.costUsd ?? 0),
    });

    const parsed = parseSelfReviewOutput(outcome.fullResult ?? outcome.summary);
    if (parsed.kind === "parse_error") {
      this.log("selfReview: parse error (non-fatal), proceeding to HANDOFF");
      const parseErrDetail = `parse error: ${parsed.raw.slice(0, 200)}`;
      await bestEffort(() => this.git.discardUncommittedChanges(worktreePath));
      if (preReviewSha !== null) {
        try {
          const branchRes = await this.runner.run(
            "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (branchRes.code === 0 && branchRes.stdout.trim() !== session.branch) {
            const checkoutRes = await this.runner.run(
              "git", ["-C", worktreePath, "checkout", session.branch],
              { cwd: worktreePath, timeoutMs: 30_000 },
            );
            if (checkoutRes.code !== 0) {
              return await this.stopSession(
                session,
                "exception",
                `self-review: cleanup checkout failed (exit ${checkoutRes.code})`,
              );
            }
          }
          const resetRes = await this.runner.run(
            "git", ["-C", worktreePath, "reset", "--hard", preReviewSha],
            { cwd: worktreePath, timeoutMs: 30_000 },
          );
          if (resetRes.code !== 0) {
            return await this.stopSession(
              session,
              "exception",
              `self-review: cleanup reset failed (exit ${resetRes.code})`,
            );
          }
        } catch (cleanupErr) {
          return await this.stopSession(
            session,
            "exception",
            `self-review: cleanup reset failed: ${errMsg(cleanupErr)}`,
          );
        }
      }
      // Write outcome only after cleanup succeeds so crash-recovery cannot mistake a
      // mid-cleanup crash for a handoff-eligible completed error (ES-473 Finding 1).
      this.store.updateSelfReviewLog(logRow.id, {
        endedAt: this.clock(),
        outcome: "error",
        costUsd: outcome.costUsd,
        errorDetail: parseErrDetail,
      });
      return CONTINUE;
    }

    const { verdict, issues, summary } = parsed.value;
    const reviewOutcome: "passed" | "fixed" | "failed" =
      verdict === "pass"
        ? (issues.length > 0 ? "fixed" : "passed")
        : "failed";

    // Record verdict/issues/summary/cost now; defer outcome and endedAt until all
    // guards pass so a stop on a guard path does not falsely record passed/fixed.
    this.store.updateSelfReviewLog(logRow.id, {
      verdict,
      issueCount: issues.length,
      summary,
      costUsd: outcome.costUsd,
    });

    this.log(
      `selfReview: ${verdict} (issues=${issues.length}): ${summary}`,
    );

    // Finding 2: a fail verdict means the reviewer could not resolve spec/requirement
    // issues — opening a PR for known-incomplete work is incorrect.
    if (verdict === "fail") {
      this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "failed" });
      return await this.stopSession(
        session,
        "exception",
        `self-review verdict=fail: ${summary}`,
      );
    }

    // Finding 3: if the reviewer fixed files but did not commit them, pushAndOpenPr
    // only pushes HEAD and the PR omits the self-review fixes while the log records
    // "fixed". Treat uncommitted leftovers the same way IMPLEMENT does.
    try {
      if (await this.git.hasUncommittedChanges(worktreePath)) {
        this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: "guard:uncommitted changes after review" });
        return await this.stopSession(
          session,
          "agent_no_change",
          "self-review left uncommitted changes",
        );
      }
    } catch (err) {
      this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:git status check failed: ${errMsg(err)}` });
      return await this.stopSession(
        session,
        "exception",
        `self-review: git status check failed: ${errMsg(err)}`,
      );
    }

    // Verify the worktree is still on the expected branch. If the self-review
    // agent checked out a different branch or detached HEAD, any commits made
    // there are not on session.branch and would be absent from the PR even
    // though the review log records them as applied. Stop unconditionally
    // so human review can recover or cherry-pick the commits.
    try {
      const headRes = await this.runner.run(
        "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: worktreePath, timeoutMs: 30_000 },
      );
      const currentBranch = headRes.code === 0 ? headRes.stdout.trim() : null;
      if (currentBranch !== session.branch) {
        this.log(
          `selfReview: worktree on wrong branch "${currentBranch ?? "unknown"}" (expected "${session.branch}"); stopping`,
        );
        this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:wrong branch after review: "${currentBranch ?? "unknown"}" (expected "${session.branch}")` });
        return await this.stopSession(
          session,
          "exception",
          `self-review: worktree on wrong branch "${currentBranch ?? "unknown"}" (expected "${session.branch}"); fixes may be on off-branch commits`,
        );
      }
    } catch (err) {
      this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:branch verification failed: ${errMsg(err)}` });
      return await this.stopSession(
        session,
        "exception",
        `self-review: branch verification failed: ${errMsg(err)}`,
      );
    }

    // Verify the reviewer's commits are consistent with the reported issues.
    // - issues > 0 but HEAD unchanged: reviewer claimed fixes but made no commits.
    // - issues = 0 but HEAD moved: reviewer made unreported commits on a pass verdict
    //   (ES-473 Finding 4 — hidden commits would slip into the PR with a clean log).
    if (preReviewSha !== null) {
      try {
        const currentShaRes = await this.runner.run(
          "git", ["-C", worktreePath, "rev-parse", "HEAD"],
          { cwd: worktreePath, timeoutMs: 30_000 },
        );
        if (currentShaRes.code !== 0) {
          // A non-zero exit means the post-review HEAD is unreadable. Both consistency
          // checks depend on this value; skipping them would allow hidden or missing
          // commits to reach HANDOFF undetected (ES-473 Codex Finding 3).
          this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:post-review SHA: git exit ${currentShaRes.code}` });
          return await this.stopSession(
            session,
            "exception",
            `self-review: post-review HEAD SHA unreadable (git exit ${currentShaRes.code})`,
          );
        }
        const currentSha = currentShaRes.stdout.trim();
        if (issues.length > 0 && currentSha === preReviewSha) {
          this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: "guard:fixes claimed but HEAD unchanged" });
          return await this.stopSession(
            session,
            "agent_no_change",
            "self-review reported fixes but made no commits",
          );
        }
        if (issues.length === 0 && currentSha !== preReviewSha) {
          this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: "guard:unreported commits on pass verdict" });
          return await this.stopSession(
            session,
            "exception",
            "self-review made unreported commits on a pass verdict",
          );
        }
      } catch (err) {
        this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:post-review SHA check failed: ${errMsg(err)}` });
        return await this.stopSession(
          session,
          "exception",
          `self-review: commit verification failed: ${errMsg(err)}`,
        );
      }
    }

    // Finding 4: the self-review agent may have reset session.branch back to origin/main
    // while leaving a clean worktree. Re-verify the branch still carries an implementation diff.
    try {
      if (!(await this.git.hasCommitsWithDiff(worktreePath))) {
        this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: "guard:no diff remains after review" });
        return await this.stopSession(
          session,
          "agent_no_change",
          "self-review reset the implementation: no diff remains",
        );
      }
    } catch (err) {
      this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: "error", errorDetail: `guard:diff check failed: ${errMsg(err)}` });
      return await this.stopSession(
        session,
        "exception",
        `self-review: diff check failed: ${errMsg(err)}`,
      );
    }

    // All guards passed: finalize the log with the correct outcome.
    this.store.updateSelfReviewLog(logRow.id, { endedAt: this.clock(), outcome: reviewOutcome });
    return CONTINUE;
  }

  // ---- HANDOFF（仕様 §5.4） ----
  private async handoff(
    session: TaskSessionRow,
    issue: EligibleIssue,
  ): Promise<RunControl | { control: "continue"; prNumber: number }> {
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
    let mergeFailures = 0; // ready verdict 下での mergePr 連続失敗（2 連続で fail-closed）
    let readinessFailures = 0; // checkMergeReadiness の連続 throw（poll throw と同じ一時障害扱い）
    // 停止要求の安全点（カーネル §7）。MONITOR は最長フェーズのため poll 境界でも検査する。
    // 入場直後の 1 回目だけは見送り、即マージ可能なタスク（done→merged）には1ポーリングの
    // 猶予を与える（「現フェーズ群を完了してから停止」の従来契約を維持）。以降の poll 境界は
    // 無書込みの安全点なので、現 PR の解決を待たずクリーン HALT する（セッションは in_review の
    // まま＝再起動で回復可能）。
    // Finding 1: initialize from DB so the cap survives process restarts.
    let autoRestartCount = session.autoRestartAttempts;
    // ES-409 Finding 2/3: initialize from the durable pending-reason record (null = no pending
    // restart). This replaces the old requireNonStoppedBeforeRestart guard which derived stale
    // state from autoRestartAttempts > 0 — that was too broad (blocked even different-reason
    // stops on recovery) and was set before posting (so a pre-post crash left a false block).
    let pendingRestartReason: string | undefined = session.pendingRestartReason ?? undefined;
    let quotaRetryCount = session.quotaRetryAttempts;
    let quotaResumedNotified = false;
    let firstPoll = true;
    while (true) {
      // ES-450 Finding 2: if recovery abandoned the session, exit the monitor loop so the
      // outer loop can proceed to SELECT the next task instead of continuing to poll a
      // closed PR and eventually halting the run.
      if (this.store.getSession(session.id).state === "stopped") return CONTINUE;
      if (!firstPoll && this.interrupted) {
        await this.haltForInterrupt();
        return HALT;
      }
      firstPoll = false;
      await this.sleep(pollIntervalMs * backoffMultiplier);
      let verdict: MonitorVerdict;
      try {
        verdict = await this.monitor.poll(prNumber);
      } catch (err) {
        // poll throw → バックオフ（×2..×8）、5連続で stopped(exception)
        // カーネル§7: 「ready のまま 2連続 throw」— done+ready 以外の評価を挟んだらストリークは断絶する
        pollFailures += 1;
        mergeFailures = 0;
        if (pollFailures >= 5) {
          const ctrl = await this.stopSession(session, "exception", `monitor poll failed 5x: ${errMsg(err)}`);
          if (ctrl.control === "halt") return HALT;
          // ES-450 Finding 1: reset streak so recovery gets a full fresh window.
          pollFailures = 0;
          backoffMultiplier = 1;
          continue;
        }
        backoffMultiplier = Math.min(backoffMultiplier * 2, 8);
        continue;
      }
      pollFailures = 0;
      backoffMultiplier = 1;
      // Clear the pending-restart record when LoopPilot transitions away from stopped — that
      // confirms the /restart-review was consumed and the restart is no longer in flight.
      // Exception: "ci_failed" and "merge_conflict" are done-path recovery markers, not
      // LoopPilot stop reasons. LoopPilot never emits these as stopReason, so they must
      // survive until the done-case stale guard consumes them (ES-450 Finding 1).
      // Exception: "workflow_failed" preserves pendingRestartReason so the workflow_failed
      // case below can give a one-poll grace period for stale error comments after a
      // Codex-recovery /restart-review (ES-450 Finding 4).
      if (verdict.kind !== "stopped" && verdict.kind !== "workflow_failed") {
        if (pendingRestartReason !== undefined &&
            pendingRestartReason !== "ci_failed" &&
            pendingRestartReason !== "merge_conflict") {
          pendingRestartReason = undefined;
          this.store.updateSession(session.id, { pendingRestartReason: null });
        }
      }
      // カーネル§7: reset merge-failure streak unless verdict is in a merge-ready path
      // Finding 3: stopped(no_findings) shares the done-path streak, so exclude it from the reset
      if (verdict.kind !== "done" &&
          !(verdict.kind === "stopped" && classifyStopReason(verdict.stopReason) === "review_done")) {
        mergeFailures = 0;
      }

      switch (verdict.kind) {
        case "merged":
          return CONTINUE; // DONE へ
        case "done": {
          // Stale guard: if done-path recovery just posted /restart-review for a
          // merge-readiness failure, give one poll of grace before re-attempting
          // the merge so the fix can propagate (ES-450 Finding 1).
          if (pendingRestartReason !== undefined) {
            pendingRestartReason = undefined;
            this.store.updateSession(session.id, { pendingRestartReason: null });
            continue;
          }
          const outcome = await this.tryMerge(session, prNumber);
          if (outcome.kind === "merged") return CONTINUE;
          if (outcome.kind === "halt") return HALT;
          if (outcome.kind === "readiness_failed") {
            // checkMergeReadiness が throw → poll throw と同じ一時障害扱い（仕様 §5.5）。
            // バックオフ再試行、5 連続で stopped(exception)。カウンタは readiness 評価成功でリセット。
            readinessFailures += 1;
            mergeFailures = 0; // done+ready 以外の評価 → ready ストリーク断絶
            if (readinessFailures >= 5) {
              const ctrl = await this.stopSession(
                session,
                "exception",
                `merge readiness check failed 5x: ${outcome.error}`,
              );
              if (ctrl.control === "halt") return HALT;
              readinessFailures = 0; // ES-450 Finding 1: reset after recovery
              continue;
            }
            // 直前の poll 成功で backoffMultiplier は 1 に戻っているため、連続失敗数から導出（×2..×8）。
            backoffMultiplier = Math.min(2 ** readinessFailures, 8);
            continue;
          }
          readinessFailures = 0; // readiness 評価成功（merge_failed/continue いずれも評価自体は成功）
          if (outcome.kind === "merge_failed") {
            // ready verdict のまま mergePr が throw。2 連続で fail-closed（カーネル §7.6）。
            mergeFailures += 1;
            if (mergeFailures >= 2) {
              const ctrl = await this.stopSession(
                session,
                "ci_failed",
                `merge call failed under ready verdict: ${outcome.error}`,
              );
              if (ctrl.control === "halt") return HALT;
              mergeFailures = 0; // ES-450 Finding 1: reset after recovery
              continue;
            }
            continue; // 1 回目は次ポーリングで再評価
          }
          // outcome.kind === "continue"（readiness が ci_pending/unknown 等）
          mergeFailures = 0; // ready 連続を断ち切る事象が起きたらリセット
          // Reload pendingRestartReason so the stale guard fires on the next poll if
          // done-path recovery was applied (ES-450 Finding 1).
          // Also reload autoRestartCount: recovery resets autoRestartAttempts in the DB
          // but the local counter would otherwise retain its pre-recovery value, causing
          // the cap to trip on the next auto-restartable stop (ES-450 Finding 3).
          {
            const recoveredForPending = this.store.getSession(session.id);
            pendingRestartReason = recoveredForPending.pendingRestartReason ?? undefined;
            autoRestartCount = recoveredForPending.autoRestartAttempts;
            quotaRetryCount = recoveredForPending.quotaRetryAttempts;
          }
          continue;
        }
        case "stopped": {
          const category = classifyStopReason(verdict.stopReason);
          if (category === "review_done") {
            // Workflow completed (no_findings) — treat same as done for merge streak.
            // Also clear any pending restart since LoopPilot completed successfully.
            if (pendingRestartReason !== undefined) {
              const prr = pendingRestartReason;
              pendingRestartReason = undefined;
              this.store.updateSession(session.id, { pendingRestartReason: null });
              // Stale guard: if done-path recovery set this marker, give one grace poll
              // before re-attempting the merge so the fix can propagate (ES-450 Finding 1).
              if (prr === "ci_failed" || prr === "merge_conflict") {
                continue;
              }
            }
            const outcome = await this.tryMerge(session, prNumber);
            if (outcome.kind === "merged") return CONTINUE;
            if (outcome.kind === "halt") return HALT;
            if (outcome.kind === "readiness_failed") {
              readinessFailures += 1;
              mergeFailures = 0;
              if (readinessFailures >= 5) {
                const ctrl = await this.stopSession(
                  session,
                  "exception",
                  `merge readiness check failed 5x: ${outcome.error}`,
                );
                if (ctrl.control === "halt") return HALT;
                readinessFailures = 0; // ES-450 Finding 1: reset after recovery
                continue;
              }
              backoffMultiplier = Math.min(2 ** readinessFailures, 8);
              continue;
            }
            readinessFailures = 0;
            if (outcome.kind === "merge_failed") {
              mergeFailures += 1;
              if (mergeFailures >= 2) {
                const ctrl = await this.stopSession(
                  session,
                  "ci_failed",
                  `merge call failed under ready verdict: ${outcome.error}`,
                );
                if (ctrl.control === "halt") return HALT;
                mergeFailures = 0; // ES-450 Finding 1: reset after recovery
                continue;
              }
              continue;
            }
            mergeFailures = 0;
            // Reload pendingRestartReason so the stale guard fires on the next poll if
            // done-path recovery was applied (ES-450 Finding 1).
            // Also reload quotaRetryCount: recovery resets quotaRetryAttempts in the DB
            // but the local counter would otherwise retain its pre-recovery value, causing
            // the cap to trip on the next codex_usage_limit stop (ES-469 Finding).
            {
              const recoveredForPending = this.store.getSession(session.id);
              pendingRestartReason = recoveredForPending.pendingRestartReason ?? undefined;
              quotaRetryCount = recoveredForPending.quotaRetryAttempts;
            }
            continue;
          }
          if (category === "auto_restart") {
            // Stale: we already have a pending /restart-review for this exact stop reason.
            // Grant one poll grace period in case the restart hasn't been consumed yet,
            // then clear the pending state so subsequent polls with the same reason can
            // trigger another restart attempt (the workflow may have consumed the first
            // restart and crashed again with the same reason before the next poll).
            // The pending record is stored durably in DB so it survives process restarts
            // (fixes ES-409 Findings 1, 2, 3).
            const stale =
              pendingRestartReason !== undefined && pendingRestartReason === verdict.stopReason;
            if (stale) {
              // Clear now so the NEXT poll re-evaluates freshly. If the workflow consumed
              // the restart and stopped again with the same reason, that next poll will
              // treat it as a new stop and allow another restart (up to the cap).
              pendingRestartReason = undefined;
              this.store.updateSession(session.id, { pendingRestartReason: null });
              const timeout = this.config.safety.monitorTimeoutMinutes;
              if (
                timeout !== undefined &&
                this.elapsedMinutesSinceMonitorStart(session.id) > timeout
              ) {
                const ctrl = await this.stopSession(session, "exception", "monitor timeout");
                if (ctrl.control === "halt") return HALT;
                continue;
              }
              continue;
            }
            autoRestartCount += 1;
            if (autoRestartCount > 3) {
              const ctrl = await this.stopSession(
                session,
                "looppilot_stopped",
                `auto-restart limit exceeded (${autoRestartCount}x): ${verdict.stopReason}`,
              );
              if (ctrl.control === "halt") return HALT;
              // Reload so the stale guard fires on the next poll if recovery posted /restart-review.
              // Also reload autoRestartCount: recovery may have reset it in the DB (Finding 2b).
              {
                const recoveredState = this.store.getSession(session.id);
                pendingRestartReason = recoveredState.pendingRestartReason ?? undefined;
                autoRestartCount = recoveredState.autoRestartAttempts;
                quotaRetryCount = recoveredState.quotaRetryAttempts;
              }
              continue;
            }
            // A real restart event breaks any prior readiness-failure streak: errors before
            // and after the restarted review are not consecutive within the new attempt.
            readinessFailures = 0;
            // Reset monitorStartedAt before posting so the timeout/not-engaged guards
            // measure from the restart point regardless of post outcome.
            this.store.updateSession(session.id, {
              monitorStartedAt: this.clock(),
            });
            if (verdict.stopReason === "state_conflict") {
              await this.sleep(30_000);
            }
            try {
              await this.git.postComment(prNumber, "/restart-review");
            } catch (err) {
              const ctrl = await this.stopSession(
                session,
                "exception",
                `/restart-review comment failed: ${errMsg(err)}`,
              );
              if (ctrl.control === "halt") return HALT;
              continue;
            }
            // ES-409 Finding 3: persist attempt count and pending reason AFTER a confirmed
            // post. A pre-post crash leaves autoRestartAttempts unchanged and
            // pendingRestartReason null, so the next startup retries the post rather than
            // stalling forever waiting for a non-stopped verdict.
            pendingRestartReason = verdict.stopReason ?? undefined;
            this.store.updateSession(session.id, {
              autoRestartAttempts: autoRestartCount,
              pendingRestartReason: verdict.stopReason,
            });
            continue;
          }
          if (category === "quota_wait") {
            const stale =
              pendingRestartReason !== undefined && pendingRestartReason === verdict.stopReason;
            if (stale) {
              // Grant one poll grace period then clear, matching the auto_restart stale
              // pattern. Without this, the loop stalls indefinitely when the restarted
              // workflow hits quota again before any non-stopped verdict is observed
              // (ES-410 Finding 1).
              pendingRestartReason = undefined;
              this.store.updateSession(session.id, { pendingRestartReason: null });
              const timeout = this.config.safety.monitorTimeoutMinutes;
              if (
                timeout !== undefined &&
                this.elapsedMinutesSinceMonitorStart(session.id) > timeout
              ) {
                const ctrl = await this.stopSession(session, "exception", "monitor timeout");
                if (ctrl.control === "halt") return HALT;
                continue;
              }
              continue;
            }
            quotaRetryCount += 1;
            quotaResumedNotified = false;
            if (quotaRetryCount > 6) {
              const ctrl = await this.stopSession(
                session,
                "looppilot_stopped",
                `quota retry limit exceeded (${quotaRetryCount}x): ${verdict.stopReason}`,
              );
              if (ctrl.control === "halt") return HALT;
              // Reload so the stale guard fires on the next poll if recovery posted /restart-review.
              // Also reload autoRestartCount: recovery resets autoRestartAttempts in the DB
              // but the local counter would otherwise retain its pre-recovery value (ES-450 Finding 3).
              {
                const quotaRecoveredState = this.store.getSession(session.id);
                pendingRestartReason = quotaRecoveredState.pendingRestartReason ?? undefined;
                autoRestartCount = quotaRecoveredState.autoRestartAttempts;
                quotaRetryCount = quotaRecoveredState.quotaRetryAttempts;
              }
              continue;
            }
            if (quotaRetryCount === 1) {
              await this.notifier.notify({
                kind: "quota_waiting",
                detail: `${session.linearIdentifier} ${verdict.stopReason}`,
              });
            }
            const QUOTA_WAIT_MS = 60 * 60 * 1000;
            const QUOTA_SLEEP_CHUNK_MS = 10_000;
            const quotaNowStr = this.clock();
            const quotaNowMs = Date.parse(quotaNowStr);
            const remainingRetries = 7 - quotaRetryCount;
            const quotaPauseMeta: PauseMeta = {
              reason: "rate_limit",
              target: "codex",
              pausedAt: quotaNowStr,
              nextReprobeAt: new Date(quotaNowMs + QUOTA_WAIT_MS).toISOString(),
              capDeadlineAt: new Date(quotaNowMs + remainingRetries * QUOTA_WAIT_MS).toISOString(),
            };
            const pauseCtrl = await this.interruptablePause(
              quotaPauseMeta,
              QUOTA_WAIT_MS,
              QUOTA_SLEEP_CHUNK_MS,
            );
            if (pauseCtrl.control === "halt") return HALT;
            // Finding 1: a quota restart is a real restart boundary — clear any
            // prior readiness-failure streak so errors before and after the
            // hour-long wait are not treated as consecutive.
            readinessFailures = 0;
            // Finding 5: refresh monitor start so monitor_timeout_minutes and
            // not-engaged guards measure from the restart, not from before the
            // quota wait — otherwise the restarted workflow can be killed as
            // "monitor timeout" before it has a chance to run.
            this.store.updateSession(session.id, {
              monitorStartedAt: this.clock(),
            });
            try {
              await this.git.postComment(prNumber, "/restart-review");
            } catch (err) {
              const ctrl = await this.stopSession(
                session,
                "exception",
                `/restart-review comment failed: ${errMsg(err)}`,
              );
              if (ctrl.control === "halt") return HALT;
              continue;
            }
            // Finding 4: persist the pending reason after a confirmed post so
            // the next poll (and any process-restart recovery) recognises the
            // restart is in flight and applies the stale guard above.
            pendingRestartReason = verdict.stopReason ?? undefined;
            this.store.updateSession(session.id, {
              quotaRetryAttempts: quotaRetryCount,
              pendingRestartReason: verdict.stopReason,
            });
            continue;
          }
          // human_required / null → HALT
          // Stale check: if ES-450 recovery already posted /restart-review for this exact
          // stop reason, give one poll of grace before the restart is consumed (Finding 6).
          if (pendingRestartReason !== undefined &&
              pendingRestartReason === (verdict.stopReason ?? "looppilot stopped (no reason)")) {
            pendingRestartReason = undefined;
            this.store.updateSession(session.id, { pendingRestartReason: null });
            continue;
          }
          {
            const ctrl = await this.stopSession(
              session,
              "looppilot_stopped",
              verdict.stopReason ?? "looppilot stopped (no reason)",
            );
            if (ctrl.control === "halt") return HALT;
            // Recovery succeeded: reload pendingRestartReason so next poll gives grace.
            // Also reload autoRestartCount: recovery resets autoRestartAttempts in the DB
            // but the local counter would otherwise retain its pre-recovery value (ES-450 Finding 3).
            const recoveredState = this.store.getSession(session.id);
            pendingRestartReason = recoveredState.pendingRestartReason ?? undefined;
            autoRestartCount = recoveredState.autoRestartAttempts;
            quotaRetryCount = recoveredState.quotaRetryAttempts;
            continue;
          }
        }
        case "pr_closed": {
          const ctrl = await this.stopSession(session, "pr_closed", null);
          if (ctrl.control === "halt") return HALT;
          continue;
        }
        case "corrupted": {
          // Stale guard: if recovery already posted /restart-review, give one poll grace
          // before treating a transient corrupted read as a hard stop (Finding 3).
          if (pendingRestartReason !== undefined) {
            pendingRestartReason = undefined;
            this.store.updateSession(session.id, { pendingRestartReason: null });
            continue;
          }
          const ctrl = await this.stopSession(
            session,
            "monitor_never_engaged",
            "looppilot-state comment present but corrupted",
          );
          if (ctrl.control === "halt") return HALT;
          continue;
        }
        case "not_engaged": {
          if (this.elapsedMinutesSinceMonitorStart(session.id) > this.config.safety.notEngagedGuardMinutes) {
            const ctrl = await this.stopSession(session, "monitor_never_engaged", null);
            if (ctrl.control === "halt") return HALT;
            continue;
          }
          continue;
        }
        case "in_progress": {
          if (quotaRetryCount > 0 && !quotaResumedNotified) {
            await this.notifier.notify({
              kind: "quota_resumed",
              detail: `${session.linearIdentifier} quota recovered after ${quotaRetryCount} retries`,
            });
            // Reset counter so a new quota outage window starts fresh. The 6-attempt
            // cap applies per outage episode; after a confirmed recovery the next
            // exhaustion begins at count=1 again (ES-410 Finding 4).
            quotaRetryCount = 0;
            this.store.updateSession(session.id, { quotaRetryAttempts: 0 });
            quotaResumedNotified = true;
          }
          const timeout = this.config.safety.monitorTimeoutMinutes;
          if (timeout !== undefined && this.elapsedMinutesSinceMonitorStart(session.id) > timeout) {
            const ctrl = await this.stopSession(session, "exception", "monitor timeout");
            if (ctrl.control === "halt") return HALT;
            continue;
          }
          continue;
        }
        case "workflow_failed": {
          // Stale-error grace: if a /restart-review was posted in the previous recovery
          // turn (by Codex recovery or auto_restart), skip one poll so LoopPilot has a
          // chance to process the restart before AgentWorkflowRecovery sees the still-
          // visible workflow_failed comment and triggers another fix agent. Without this,
          // recoveryAttempted=1 causes the session to halt immediately after a successful
          // /restart-review on a workflow_setup_failed recovery (ES-450 Finding 4).
          if (pendingRestartReason !== undefined) {
            pendingRestartReason = undefined;
            this.store.updateSession(session.id, { pendingRestartReason: null });
            continue;
          }
          const current = this.store.getSession(session.id);
          const recoveryCtx: RecoveryContext = {
            worktreePath: session.worktreePath as string,
            branch: session.branch,
            prNumber,
            errorBody: verdict.errorBody,
            errorCommentCount: verdict.errorCommentCount,
            // Pass durable counts so budget/guard survive process restarts (Finding 2).
            fixAttempts: current.workflowFixAttempts,
            handledErrorCount: current.workflowHandledErrorCount,
            maxCostUsd: this.config.safety.maxCostUsdPerFix,
            hardTimeoutMs: this.config.safety.sessionHardTimeoutMinutes * 60_000,
          };
          let recoveryResult: RecoveryOutcome;
          try {
            recoveryResult = await this.recovery.attemptRecovery(recoveryCtx);
          } catch (err) {
            const ctrl = await this.stopSession(
              session,
              "workflow_setup_failed",
              `workflow recovery error: ${errMsg(err)}`,
              { workflowHandledErrorCount: verdict.errorCommentCount },
            );
            if (ctrl.control === "halt") return HALT;
            continue;
          }
          if (recoveryResult.kind === "interrupted") {
            if (recoveryResult.costUsd > 0) {
              const refreshed = this.store.getSession(session.id);
              this.store.updateSession(session.id, {
                costUsd: (refreshed.costUsd ?? 0) + recoveryResult.costUsd,
              });
            }
            await this.haltForInterrupt();
            return HALT;
          }
          if (recoveryResult.kind === "restarted") {
            if (recoveryResult.newFix) {
              // A new fix was pushed this poll: persist cost, increment the budget
              // counter, and record the handled error count so a backlog of pre-existing
              // comments isn't re-triggered on the next poll. Keyed on `newFix` rather
              // than cost so a legitimately zero-cost fix run still counts (Finding 2).
              // Also reset monitorStartedAt so the not-engaged guard measures from the
              // restart request — otherwise a crash-recovery or slow-failure session that
              // already exceeded notEngagedGuardMinutes would be killed on the next poll
              // before the restarted workflow has any chance to advance the state comment.
              const refreshed = this.store.getSession(session.id);
              this.store.updateSession(session.id, {
                costUsd: (refreshed.costUsd ?? 0) + recoveryResult.costUsd,
                workflowFixAttempts: refreshed.workflowFixAttempts + 1,
                workflowHandledErrorCount: verdict.errorCommentCount,
                monitorStartedAt: this.clock(),
              });
            } else {
              // Pending restart: the fix was already pushed and we're waiting for the
              // workflow to pick it up. The old ⚠️ comment still masks the live
              // looppilot-state, so distinguish an actively-progressing review from one
              // that never re-engaged (Finding 3):
              const timeout = this.config.safety.monitorTimeoutMinutes;
              if (timeout !== undefined && this.elapsedMinutesSinceMonitorStart(session.id) > timeout) {
                const ctrl = await this.stopSession(session, "exception", "monitor timeout");
                if (ctrl.control === "halt") return HALT;
                continue;
              }
              // Only fall back to the not-engaged guard while no live state comment
              // exists, so an ignored /restart-review cannot poll forever — but a
              // restarted review whose state moved to fixing/waiting_codex is treated
              // as in-progress and never killed by the guard.
              if (
                !verdict.hasStateComment &&
                this.elapsedMinutesSinceMonitorStart(session.id) > this.config.safety.notEngagedGuardMinutes
              ) {
                const ctrl = await this.stopSession(session, "monitor_never_engaged", null);
                if (ctrl.control === "halt") return HALT;
                continue;
              }
            }
            continue;
          }
          const detail =
            recoveryResult.kind === "exhausted"
              ? `workflow fix attempts exhausted (${this.config.safety.maxWorkflowFixAttempts}x)`
              : `workflow fix failed: ${recoveryResult.message}`;
          if (recoveryResult.kind === "unrecoverable" && recoveryResult.costUsd > 0) {
            const refreshed = this.store.getSession(session.id);
            this.store.updateSession(session.id, { costUsd: (refreshed.costUsd ?? 0) + recoveryResult.costUsd });
          }
          {
            const ctrl = await this.stopSession(
              session,
              "workflow_setup_failed",
              detail,
              { workflowHandledErrorCount: verdict.errorCommentCount },
            );
            if (ctrl.control === "halt") return HALT;
            continue;
          }
        }
      }
    }
  }

  /**
   * done verdict 時のマージ試行（カーネル §7.6）。
   * - checkMergeReadiness が throw → readiness_failed（一時障害。バックオフ/5連続停止は monitorSession 側）。
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
    | { kind: "readiness_failed"; error: string }
  > {
    let readiness: MergeReadiness;
    try {
      readiness = await this.monitor.checkMergeReadiness(prNumber);
    } catch (err) {
      return { kind: "readiness_failed", error: errMsg(err) };
    }
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return { kind: "continue" };
        case "ci_failed": {
          const ctrl = await this.stopSession(session, "ci_failed", null);
          return ctrl.control === "halt" ? { kind: "halt" } : { kind: "continue" };
        }
        case "conflict": {
          const ctrl = await this.stopSession(session, "merge_conflict", null);
          return ctrl.control === "halt" ? { kind: "halt" } : { kind: "continue" };
        }
        case "blocked": {
          const ctrl = await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return ctrl.control === "halt" ? { kind: "halt" } : { kind: "continue" };
        }
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return { kind: "merged" };
    } catch (err) {
      return { kind: "merge_failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- DONE（仕様 §5.6 / §7） ----
  private async done(session: TaskSessionRow, issue: EligibleIssue): Promise<void> {
    this.store.updateSession(session.id, {
      state: "merged",
      endedAt: this.clock(),
      doneTransitionPending: 1,
    });
    try {
      await retry(3, () => this.source.transition(issue.id, "done"));
      this.store.updateSession(session.id, { doneTransitionPending: 0 });
    } catch (err) {
      this.log(
        `warning: transition(done) failed for ${issue.identifier}: ${errMsg(err)} — will retry on next startup`,
      );
    }
    const mergedCount = this.store.countMerged(this.runId);
    this.log(`merged ${issue.identifier} (merged_count=${mergedCount})`);
    if (this.config.notify.progress) {
      await this.notifier.notify({
        kind: "task_merged",
        identifier: issue.identifier,
        title: issue.title,
        mergedCount,
      });
    }
  }

  // ---- 共通の STOPPED 終端（仕様 §7） ----
  private async stopSession(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber" | "workflowHandledErrorCount">> = {},
    opts: { haltIfRevertFailed?: boolean } = {},
  ): Promise<RunControl> {
    let patch = extraPatch;
    // Effective stop detail — may be augmented with recovery failure message (Finding 3).
    let effectiveDetail = detail;
    // --- Resolve effective policy (ES-490) ---
    let policy = FAILURE_POLICY[reason];
    // Override: ci_failed with branch protection detail → halt (spec D-10)
    if (reason === "ci_failed" && detail !== null && detail.startsWith("merge blocked by branch protection")) {
      policy = "halt";
    }
    // Override: pr_closed with partial abandon markers → recover
    // pr_closed is normally terminal (no PR to push to), but a partial abandon
    // (crash mid-abandon or failed cleanup) left the ticket dirty — recovery
    // can complete the cleanup (ES-450 Finding 4).
    if (reason === "pr_closed") {
      const freshForOverride = this.store.getSession(session.id);
      if ((freshForOverride.stopDetail !== null && freshForOverride.stopDetail.startsWith("abandon_in_progress")) ||
          (freshForOverride.stopDetail !== null &&
           (freshForOverride.stopDetail.startsWith("recovery failed: ") ||
            freshForOverride.stopDetail.includes(" (recovery failed: ")))) {
        policy = "recover";
      }
    }
    // Override: handoff_failed with retryable sentinel → recover
    // handoff_failed is normally halt, but stoppedSessionsWithFailedRecovery feeds back
    // sessions whose prior recovery partially succeeded. All three sentinel prefixes reach
    // executeRecoveryTurn's deterministic shortcut paths:
    //   - handoff_transition_pending: → skip Codex, retry Linear in_review transition
    //   - fix_pushed_restart_pending  → skip Codex, retry /restart-review comment only
    //   - abandon_in_progress         → skip Codex, resume cleanup (branch delete / ticket)
    // Without this extension only handoff_transition_pending: re-enters recovery; the other
    // two keep the default halt policy and never retry (ES-490 Finding 1).
    if (reason === "handoff_failed") {
      const freshForHandoff = this.store.getSession(session.id);
      if (freshForHandoff.stopDetail !== null && (
          freshForHandoff.stopDetail.startsWith("handoff_transition_pending:") ||
          freshForHandoff.stopDetail.startsWith("fix_pushed_restart_pending") ||
          freshForHandoff.stopDetail.startsWith("abandon_in_progress")
      )) {
        policy = "recover";
      }
    }
    // --- workflow_setup_failed cost exhaustion marker (pre-existing) ---
    const isWorkflowCostExhaustion =
      reason === "workflow_setup_failed" &&
      detail !== null &&
      detail.includes("fix agent exceeded cost limit");
    // Mark terminal conditions so stoppedSessionsWithFailedRecovery does not pick
    // them up on every daemon start (ES-450 Finding 4).
    if (isWorkflowCostExhaustion) {
      this.store.updateSession(session.id, { recoveryAttempted: 1 });
    }
    if (policy === "recover" && this.recoveryTurn !== null && this.planner !== null) {
      const fresh = this.store.getSession(session.id);
      // pr_closed is normally terminal (no PR to push to / restart). Exception: a partial
      // abandon (crash mid-abandon with stopDetail="abandon_in_progress") left the ticket
      // in a dirty state — recovery can complete the cleanup (ES-450 Finding 4).
      const isPartialAbandon = reason === "pr_closed" && (
        // startsWith covers both the plain "abandon_in_progress" sentinel and the compound
        // "abandon_in_progress:<original>" form used when a failed abandon preserves the
        // original exhaustion detail (ES-450 Finding 4).
        (fresh.stopDetail !== null && fresh.stopDetail.startsWith("abandon_in_progress")) ||
        // A prior recovery attempt ran but failed mid-abandon (e.g. ticket revert failed after
        // the PR and branch were already cleaned up). For pr_closed sessions the only path where
        // recovery can run is via isPartialAbandon itself, so a "recovery failed:" marker in
        // stop_detail safely identifies retryable failed abandon cleanups. These sessions are
        // fed back here by stoppedSessionsWithFailedRecovery (ES-450 Finding 3).
        (fresh.stopDetail !== null &&
         (fresh.stopDetail.startsWith("recovery failed: ") ||
          fresh.stopDetail.includes(" (recovery failed: ")))
      );
      if ((reason !== "pr_closed" || isPartialAbandon) && !fresh.recoveryAttempted && fresh.prNumber !== null) {
        await this.notifier.notify({
          kind: "recovery_started",
          identifier: session.linearIdentifier,
          reason,
        });
        // Persist crash-recovery marker before the PR close step inside executeAbandon so
        // a mid-abandon crash is detectable on the next daemon start (ES-450 Finding 4).
        // Capture the current effectiveDetail so we can embed an exhaustion detail in the
        // compound marker — without this, the next recoverStoppedByLooppilot startup would
        // not recognise the terminal cap and would reset/adopt the session (ES-450 Finding 4).
        const capturedDetailForMarker = effectiveDetail;
        const onAbandonStarting = () => {
          const innerForMarker = extractInnerStopDetail(capturedDetailForMarker ?? "");
          const isExhaustedDetail =
            innerForMarker.startsWith("auto-restart limit exceeded") ||
            innerForMarker.startsWith("quota retry limit exceeded");
          this.store.updateSession(session.id, {
            stopDetail: isExhaustedDetail
              ? `abandon_in_progress:${innerForMarker}`
              : "abandon_in_progress",
          });
        };
        // Gate label handling for handoff_failed is now inside executeRecoveryTurn (after
        // parseRecoveryAction), so abandon/escalate can proceed even when the label API is
        // broken (ES-450 Finding 5).
        let result;
        try {
          result = await executeRecoveryTurn(
            this.recoveryTurn,
            fresh,
            reason,
            detail,
            onAbandonStarting,
          );
        } catch (err) {
          this.log(`recovery: exception: ${err instanceof Error ? err.message : String(err)}`);
          result = { kind: "escalated" as const, action: "escalate" as const };
        }
        // Operator interrupted during recovery analysis: propagate like other interrupts.
        // recoveryAttempted is NOT marked so the next run can retry recovery.
        if (result.kind === "interrupted") {
          if (result.costUsd !== undefined && result.costUsd > 0) {
            const freshened = this.store.getSession(session.id);
            this.store.updateSession(session.id, { costUsd: (freshened.costUsd ?? 0) + result.costUsd });
          }
          await this.haltForInterrupt();
          return HALT;
        }
        // Mark recovery attempted for all non-interrupted, non-failed outcomes.
        // For 'failed', the cleanup did not complete — leave recoveryAttempted=0 so a
        // future recovery path can retry the cleanup (ES-450 Finding 2).
        // For 'recovered', defer the write to recoveryUpdate so the gate is consumed
        // atomically with the state→in_review transition — a crash between this write
        // and that update would leave the row stopped with recoveryAttempted=1 and
        // no active session (ES-450 Finding 2).
        if (result.kind !== "failed" && result.kind !== "recovered") {
          this.store.updateSession(session.id, { recoveryAttempted: 1 });
        }
        // Abandon completed cleanup and wants the loop to continue to next task.
        if (result.kind === "continued") {
          this.store.updateSession(session.id, {
            recoveryAction: result.action,
            state: "stopped",
            failureReason: reason,
            stopDetail: detail,
            endedAt: this.clock(),
          });
          // ES-492: Add needs-human label + reason comment so SELECT filters this ticket out until a human reviews.
          await this.applyNeedsHumanTriage(session, reason, detail);
          return CONTINUE;
        }
        // Only record the recovery action for non-failed outcomes. A failed abandon must
        // not write recovery_action='abandon' — that would cause stoppedSessionsWithPr to
        // exclude the session on the next daemon start, leaving an un-abandoned PR/ticket
        // with no active session and no way to retry cleanup.
        if (result.kind !== "failed") {
          this.store.updateSession(session.id, { recoveryAction: result.action });
        }
        if (result.kind === "recovered") {
          // For handoff_failed: the recovery action (label add + restart-review comment)
          // already completed in a prior attempt. Now retry the Linear in_review transition
          // that originally failed. If it still fails, re-encode the sentinel so the next
          // daemon start retries via stoppedSessionsWithFailedRecovery without halting now
          // (ES-490 Finding 1).
          if (reason === "handoff_failed") {
            let handoffTransitionErr: string | null = null;
            try {
              await retry(3, () => this.source.transition(session.linearIssueId, "in_review"));
            } catch (err) {
              handoffTransitionErr = errMsg(err);
            }
            if (handoffTransitionErr !== null) {
              effectiveDetail = `handoff_transition_pending:${result.action}`;
              effectiveDetail = `${effectiveDetail} (recovery failed: ${handoffTransitionErr})`;
              this.store.updateSession(session.id, {
                state: "stopped",
                failureReason: reason,
                stopDetail: effectiveDetail,
                endedAt: this.clock(),
                ...patch,
              });
              // The PR is live in GitHub but the Linear ticket is stuck in handoff_failed.
              // Silently continuing leaves the PR unmonitored with no operator signal.
              // Halt so the next daemon startup runs stoppedSessionsWithFailedRecovery and
              // retries the transition via the handoff_transition_pending: sentinel
              // (ES-490 Finding 2).
              this.log(`${session.linearIdentifier} handoff in_review transition still failing — halting: ${effectiveDetail}`);
              await this.notifier.notify({ kind: "halted", reason, detail: effectiveDetail });
              await this.commitMemoryBeforeHalt();
              this.store.setRunState(this.runId, "halted", effectiveDetail);
              return HALT;
            }
          }
          const recoveryCost = result.costUsd;
          const refreshed = this.store.getSession(session.id);
          // recoveryAttempted is included here (not in the earlier gate) so a crash between
          // the recovery action and this atomic update cannot leave the row stopped with
          // recoveryAttempted=1 and no active session (ES-450 Finding 2).
          const recoveryUpdate: Partial<TaskSessionRow> = {
            state: "in_review",
            monitorStartedAt: this.clock(),
            failureReason: null,
            stopDetail: null,
            endedAt: null,
            autoRestartAttempts: 0,
            quotaRetryAttempts: 0,
            recoveryAttempted: 1,
          };
          if (recoveryCost > 0) {
            recoveryUpdate.costUsd = (refreshed.costUsd ?? 0) + recoveryCost;
          }
          // Only carry workflowHandledErrorCount for actions that actually changed the branch.
          // restart_review does not fix the error, so the same workflow_failed comment stays;
          // carrying the count would cause AgentWorkflowRecovery to see errorCommentCount <=
          // handledErrorCount and skip the fix on the next poll, masking the setup failure.
          if (patch.workflowHandledErrorCount !== undefined &&
              (result.action === "fix_code" || result.action === "rebase")) {
            recoveryUpdate.workflowHandledErrorCount = patch.workflowHandledErrorCount;
          }
          // Track restart_review, fix_code, and rebase as pending so monitor gives grace on
          // the next stale stop before the /restart-review comment is consumed (ES-450 Finding 3).
          // pendingRestartReason must match the raw verdict.stopReason used by the stale guard;
          // for exhaustion details like "auto-restart limit exceeded (4x): workflow_crashed" we
          // extract just the trailing stop reason rather than storing the full synthesized message.
          // For done-path stops (ci_failed, merge_conflict) detail is null — fall back to reason
          // so the done-case stale guard can detect and consume it (ES-450 Finding 1).
          if (result.action === "restart_review" || result.action === "fix_code" || result.action === "rebase") {
            let pendingReason: string;
            if (reason === "ci_failed" || reason === "merge_conflict") {
              // Done-path stops: always use reason so the monitor's preservation
              // logic (which keeps exact "ci_failed"/"merge_conflict" markers
              // through non-stopped verdicts) works correctly even when detail
              // carries extra context like branch-protection details (ES-450 Finding 3).
              pendingReason = reason;
            } else if (detail !== null && (
              detail.startsWith("auto-restart limit exceeded") ||
              detail.startsWith("quota retry limit exceeded")
            )) {
              pendingReason = extractExhaustedStopReason(detail);
            } else {
              pendingReason = detail ?? reason;
            }
            recoveryUpdate.pendingRestartReason = pendingReason;
          }
          this.store.updateSession(session.id, recoveryUpdate);
          await this.notifier.notify({
            kind: "recovery_succeeded",
            identifier: session.linearIdentifier,
            action: result.action,
          });
          return CONTINUE;
        }
        // failed: preserve any recovery agent cost and carry the failure message forward so
        // operators see what the recovery attempt tried and why it failed (ES-450 Finding 3).
        if (result.kind === "failed") {
          if (result.costUsd !== undefined && result.costUsd > 0) {
            const freshened = this.store.getSession(session.id);
            patch = { ...patch, costUsd: (freshened.costUsd ?? 0) + result.costUsd };
          }
          // When the fix was pushed but /restart-review failed, encode a sentinel so the
          // next recovery turn can detect that only the comment remains and bypass Codex
          // (ES-450 Finding 5). Set this before the message append so the compound detail
          // becomes "fix_pushed_restart_pending (recovery failed: ...)", which survives
          // stripRecoveryFailedSuffix and is still matched by stoppedSessionsWithFailedRecovery.
          if (result.restartCommentOnly) {
            effectiveDetail = "fix_pushed_restart_pending";
          }
          // For failed abandons, preserve the abandon_in_progress sentinel so the next
          // recovery detects it and resumes only cleanup (branch delete / ticket revert)
          // rather than re-entering Codex and potentially choosing fix_code or
          // restart_review against an already-closed PR (ES-450 Finding 2).
          // Embed the original exhaustion detail in the compound marker so the exhaustion
          // cap in recoverStoppedByLooppilot is still honoured on the next daemon start —
          // without this the cap is lost and the session gets a fresh restart budget
          // (ES-450 Finding 4).
          if (result.action === "abandon") {
            const innerForFailed = extractInnerStopDetail(effectiveDetail ?? "");
            const isExhaustedFailed =
              innerForFailed.startsWith("auto-restart limit exceeded") ||
              innerForFailed.startsWith("quota retry limit exceeded");
            effectiveDetail = isExhaustedFailed
              ? `abandon_in_progress:${innerForFailed}`
              : "abandon_in_progress";
          }
          if (result.message) {
            effectiveDetail = effectiveDetail
              ? `${effectiveDetail} (recovery failed: ${result.message})`
              : `recovery failed: ${result.message}`;
          }
          // When local work exists that would be destroyed by a retry, or when the
          // failure is substantively non-retryable (cost cap, no commits, rebase
          // conflict), mark recovery as attempted so stoppedSessionsWithFailedRecovery
          // does not queue it again (ES-450 Finding 1/3).
          if (result.preserveWorktree || result.nonRetryable) {
            this.store.updateSession(session.id, { recoveryAttempted: 1 });
          }
          // Do not persist workflowHandledErrorCount in the stopped row when recovery
          // fails — except when the fix was already pushed (restartCommentOnly). In that
          // case only the /restart-review comment failed; the error is handled and keeping
          // the count prevents AgentWorkflowRecovery from running another fix agent on top
          // of the already-pushed change (ES-450 Finding 2).
          if (!result.restartCommentOnly) {
            const { workflowHandledErrorCount: _omit, ...patchWithoutCount } = patch;
            patch = patchWithoutCount;
          }
        }
        // escalated / failed → fall through to normal stop
      }
    }
    // --- Policy: "abandon" (ES-490) ---
    if (policy === "abandon") {
      const freshAbandon = this.store.getSession(session.id);
      // Forward-looking: no current abandon-policy reason reaches here (all are
      // pre-HANDOFF, so prNumber is always null). Will be exercised when recovery
      // loop exhaustion falls back to abandon (ES-493).
      if (freshAbandon.prNumber !== null && this.recoveryTurn !== null) {
        // Post-PR abandon: use executeAbandon (closes PR, deletes branch, reverts ticket)
        const capturedDetail = effectiveDetail;
        const onAbandonStarting = () => {
          const inner = extractInnerStopDetail(capturedDetail ?? "");
          const isExhausted =
            inner.startsWith("auto-restart limit exceeded") ||
            inner.startsWith("quota retry limit exceeded");
          this.store.updateSession(session.id, {
            stopDetail: isExhausted ? `abandon_in_progress:${inner}` : "abandon_in_progress",
          });
        };
        const result = await executeAbandon(this.recoveryTurn, freshAbandon, onAbandonStarting);
        if (result.kind === "continued") {
          this.store.updateSession(session.id, {
            recoveryAction: "abandon",
            state: "stopped",
            failureReason: reason,
            stopDetail: effectiveDetail,
            endedAt: this.clock(),
            ...patch,
          });
          const skipDetail = `${session.linearIdentifier} stopped (${reason})${effectiveDetail ? `: ${effectiveDetail}` : ""}`;
          // ES-492: Add needs-human label + reason comment so SELECT filters this ticket out until a human reviews.
          await this.applyNeedsHumanTriage(freshAbandon, reason, effectiveDetail);
          await this.notifier.notify({ kind: "task_skipped", identifier: session.linearIdentifier, reason, detail: skipDetail });
          this.log(skipDetail);
          return CONTINUE;
        }
        // executeAbandon failed — fall through to halt with failure info.
        // Reconstruct the abandon_in_progress sentinel (same logic as onAbandonStarting)
        // so the halt path persists it to stop_detail. Without this, effectiveDetail still
        // holds the original pre-abandon detail, overwriting the sentinel that onAbandonStarting
        // already wrote to the DB. stoppedSessionsWithFailedRecovery matches on
        // LIKE 'abandon_in_progress%' and will retry cleanup on the next daemon start
        // (ES-490 Finding 3).
        if (result.kind === "failed" && result.message) {
          const innerFailed = extractInnerStopDetail(capturedDetail ?? "");
          const isExhaustedFailed =
            innerFailed.startsWith("auto-restart limit exceeded") ||
            innerFailed.startsWith("quota retry limit exceeded");
          const abandonSentinel = isExhaustedFailed
            ? `abandon_in_progress:${innerFailed}`
            : "abandon_in_progress";
          effectiveDetail = `${abandonSentinel} (abandon failed: ${result.message})`;
        }
        // Fall through to halt (abandon cleanup failed)
      } else {
        // Pre-PR abandon: discard worktree + revert ticket to Todo
        if (session.worktreePath) {
          await bestEffort(() => this.git.discardWorktree(session.branch, session.worktreePath!));
        }
        let todoRevertErr: string | null = null;
        try {
          await this.source.transition(session.linearIssueId, "todo");
        } catch (err) {
          todoRevertErr = errMsg(err);
          this.log(`policy-abandon: todo revert failed (ticket may be stuck): ${todoRevertErr}`);
          effectiveDetail = effectiveDetail
            ? `${effectiveDetail}; todo revert failed: ${todoRevertErr}`
            : `todo revert failed: ${todoRevertErr}`;
        }
        this.store.updateSession(session.id, {
          state: "stopped",
          failureReason: reason,
          stopDetail: effectiveDetail,
          endedAt: this.clock(),
          recoveryAction: "abandon",
          ...patch,
        });
        const skipDetail = `${session.linearIdentifier} stopped (${reason})${effectiveDetail ? `: ${effectiveDetail}` : ""}`;
        await this.notifier.notify({ kind: "task_skipped", identifier: session.linearIdentifier, reason, detail: skipDetail });
        this.log(skipDetail);
        if (todoRevertErr !== null) {
          // Ticket is stuck In Progress with no active session — halt so operators can
          // intervene rather than leaving orphaned work invisible to SELECT (ES-490 Finding 2).
          await this.notifier.notify({ kind: "halted", reason, detail: skipDetail });
          await this.commitMemoryBeforeHalt();
          this.store.setRunState(this.runId, "halted", skipDetail);
          return HALT;
        }
        // ES-492: Add needs-human label + reason comment so SELECT filters this ticket out until a human reviews.
        await this.applyNeedsHumanTriage(session, reason, effectiveDetail);
        return CONTINUE;
      }
    }
    // --- Policy: "halt" (default fall-through) ---
    this.store.updateSession(session.id, {
      state: "stopped",
      failureReason: reason,
      stopDetail: effectiveDetail,
      endedAt: this.clock(),
      ...patch,
    });
    const haltDetail = `${session.linearIdentifier} stopped (${reason})${effectiveDetail ? `: ${effectiveDetail}` : ""}`;
    await this.notifier.notify({ kind: "halted", reason, detail: haltDetail });
    await this.commitMemoryBeforeHalt();
    this.store.setRunState(this.runId, "halted", haltDetail);
    this.log(haltDetail);
    return HALT;
  }

  /** 停止要求チェックつきの安全点待機。rate-limit 等で呼ぶ。中断時は HALT、完了時は CONTINUE を返す。 */
  public async interruptablePause(
    meta: PauseMeta,
    waitMs: number,
    chunkMs: number = 10_000,
  ): Promise<RunControl> {
    this.store.setPauseMeta(this.runId, meta);
    await this.notifier.notify({
      kind: "paused",
      target: meta.target,
      detail: `${meta.reason}: waiting until ${meta.nextReprobeAt}`,
    });

    for (let elapsed = 0; elapsed < waitMs; elapsed += chunkMs) {
      if (this.interrupted) {
        await this.haltForInterrupt();
        return HALT;
      }
      await this.sleep(Math.min(chunkMs, waitMs - elapsed));
    }
    if (this.interrupted) {
      await this.haltForInterrupt();
      return HALT;
    }

    this.store.clearPauseMeta(this.runId);
    await this.notifier.notify({
      kind: "resumed",
      target: meta.target,
      detail: `${meta.reason}: resumed after ${waitMs / 1000}s wait`,
    });
    if (this.interrupted) {
      await this.haltForInterrupt();
      return HALT;
    }
    return CONTINUE;
  }

  /**
   * ES-492: On abandon, add the needs-human label and post a reason comment.
   * Both operations are best-effort — failures are logged but do not affect the abandon flow.
   */
  private async applyNeedsHumanTriage(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
  ): Promise<void> {
    const label = this.config.linear.needsHumanLabel;
    try {
      await this.source.addLabel(session.linearIssueId, label);
    } catch (err) {
      this.log(`needs-human: addLabel failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
    const commentBody = [
      `## 🛑 LoopPilot OS — abandon (needs-human)`,
      "",
      `**Reason:** \`${reason}\``,
      detail ? `**Detail:** ${detail}` : "",
      "",
      `このチケットは \`${label}\` ラベルが付与されました。人間の確認が必要です。`,
      `ラベルを外すと再投入されます。`,
    ].filter(Boolean).join("\n");
    try {
      await this.source.postComment(session.linearIssueId, commentBody);
    } catch (err) {
      this.log(`needs-human: postComment failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
  }

  /** 全 HALT 経路で共有されるメモリコミットヘルパー。失敗は警告のみ（halt を妨げない）。 */
  private async commitMemoryBeforeHalt(): Promise<void> {
    try {
      await this.rebaseGuardAndCommitMemory();
    } catch (err) {
      this.log(`warning: failed to commit memory on halt: ${errMsg(err)}`);
    }
  }

  /**
   * Rebase onto origin/<defaultBranch> with --autostash, then commit + push docs/memory/.
   * Shared by the startup bootstrap path and commitMemoryBeforeHalt so both apply the same
   * conflict-marker guards (ES-452 Findings 2/3/4): skip the commit when the rebase fails
   * (aborting it) or when the autostash pop leaves unmerged files. `beforeCommit` runs after
   * the rebase guard in every branch — including the skip branches — so the bootstrap path
   * can seed/initialize memory locally for the run even when the commit itself is skipped.
   * All steps are best-effort.
   */
  private async rebaseGuardAndCommitMemory(beforeCommit?: () => void): Promise<void> {
    const repoPath = this.config.repo.path;
    const defaultBranch = this.config.repo.defaultBranch;
    await this.runner.run("git", ["fetch", "origin", defaultBranch], { cwd: repoPath }).catch(() => {});
    // Use --autostash so that dirty docs/memory files are stashed before rebasing
    // (ES-452 Finding 4). If the rebase fails despite that, abort immediately to
    // prevent staging conflict markers in the memory commit (ES-452 Finding 3).
    const rebaseRes = await this.runner.run(
      "git",
      ["rebase", "--autostash", `origin/${defaultBranch}`],
      { cwd: repoPath },
    ).catch((_e: unknown) => ({ code: 1, stdout: "", stderr: "rebase runner error" }));
    if (rebaseRes.code !== 0) {
      await this.runner.run("git", ["rebase", "--abort"], { cwd: repoPath }).catch(() => {});
      this.log("warning: rebase failed before memory commit; skipping to avoid conflict markers");
      beforeCommit?.();
      // Halt-path only: restore any dirty docs/memory files so the clean-worktree
      // preflight on the next startup does not fail (ES-452 Finding 1). The bootstrap
      // path (beforeCommit defined) intentionally leaves files dirty for the current run.
      if (beforeCommit === undefined) {
        await this.runner.run("git", ["checkout", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
        await this.runner.run("git", ["clean", "-fd", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
      }
      return;
    }
    // Even when rebase exits 0, the autostash pop may leave conflict markers in the
    // working tree. Detect unmerged files, restore them to HEAD, and skip the commit to
    // avoid staging conflict markers as memory content (ES-452 Finding 2).
    const unmergedRes = await this.runner.run(
      "git", ["ls-files", "--unmerged", "--", MEMORY_DIR + "/"],
      { cwd: repoPath },
    ).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    if (unmergedRes.stdout.trim().length > 0) {
      await this.runner.run("git", ["checkout", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
      this.log("warning: autostash pop left conflicts in memory directory; skipping memory commit");
      beforeCommit?.();
      // Halt-path only: also remove any untracked files created by the bootstrap path's
      // initializeMemory so the next startup's clean-worktree preflight does not fail.
      if (beforeCommit === undefined) {
        await this.runner.run("git", ["clean", "-fd", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
      }
      return;
    }
    beforeCommit?.();
    // Do not swallow commitIfChanged errors: let them propagate so the outer catch in
    // commitMemoryBeforeHalt (or the bootstrap try/catch) logs a warning (ES-452 Finding 2).
    const committed = await commitIfChanged(this.runner, repoPath);
    if (committed) {
      // Push the memory commit so it survives the git reset --hard in fetchDefaultBranch
      // on the next run's PM-select phase (ES-452 Finding 1). Best-effort: warn on failure.
      const pushRes = await this.runner.run(
        "git",
        ["push", "origin", `HEAD:${defaultBranch}`],
        { cwd: repoPath },
      ).catch((_e: unknown) => ({ code: 1, stdout: "", stderr: "push runner error" }));
      if (pushRes.code !== 0) {
        // Roll back the local commit so the branch does not stay ahead of origin;
        // fetchDefaultBranch's git reset --hard would silently discard it (ES-452 Finding 3).
        // Use --hard to also clean the worktree; --mixed (the default) would leave the
        // memory files modified, causing the next startup's clean-worktree preflight to fail.
        await this.runner.run("git", ["reset", "--hard", "HEAD~1"], { cwd: repoPath }).catch(() => {});
        this.log(`warning: failed to push memory commit (rolled back): ${pushRes.stderr.trim()}`);
      }
    }
  }

  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。
   *  Idempotent: if the run is already halted (e.g. interruptablePause already
   *  called this), the second call is a no-op — no duplicate notification. */
  private async haltForInterrupt(): Promise<void> {
    const run = this.store.getRun(this.runId);
    if (run.state === "halted") return;
    await this.commitMemoryBeforeHalt();
    const detail = "user_interrupt: stop requested; halting at safe point";
    this.store.setRunState(this.runId, "halted", detail);
    // 他の全 stopSession 経路と同様に await（通知を main の store.close() 前に確実に配信し、
    // 閉じた DB へ触れる未捕捉 Promise 拒否を避ける）。notify はコントラクト上 throw しない。
    await this.notifier.notify({ kind: "halted", reason: "user_interrupt", detail });
    this.log(detail);
  }

  private elapsedMinutesSinceMonitorStart(sessionId: number): number {
    const fresh = this.store.getSession(sessionId);
    if (fresh.monitorStartedAt === null) return 0;
    const now = this.clock();
    const nowMs = Date.parse(now);
    const startMs = Date.parse(fresh.monitorStartedAt);
    if (startMs > nowMs) {
      // monitorStartedAt is in the future (transient NTP skew or bad persisted timestamp).
      // Return 0 without overwriting the stored start: persisting the stale wall-clock
      // value here would cause the next poll (after NTP corrects the clock) to measure
      // the skew delta as elapsed monitoring time and fire guards prematurely.
      return 0;
    }
    return (nowMs - startMs) / 60000;
  }
}

// ---- module-private helpers ----
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EPERM") {
      return true;
    }
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

/**
 * 回復経路で done()/buildPrompt に渡す最小 EligibleIssue をセッション行から再構成する。
 * done() は issue.id（transition）と issue.identifier（ログ）しか使わないため、
 * title 等は記録済みの値で埋め、未保持フィールドは安全な既定で埋める。
 */
/** Extracts the stop reason embedded after the last ": " in an exhaustion detail string. */
function extractExhaustedStopReason(stopDetail: string): string {
  const idx = stopDetail.lastIndexOf(": ");
  return idx === -1 ? "" : stopDetail.slice(idx + 2);
}

/**
 * Extracts the embedded original stop detail from a compound abandon_in_progress marker.
 * "abandon_in_progress:<original>" → "<original>", any other value → unchanged.
 * Used to recover the exhaustion detail for the restart-cap guard when a failed abandon
 * encoded the terminal stop reason inside the in-progress sentinel (ES-450 Finding 4).
 */
function extractInnerStopDetail(s: string): string {
  const PREFIX = "abandon_in_progress:";
  return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
}

/**
 * Removes the " (recovery failed: ...)" suffix appended by stopSession's failed path so
 * that a re-entered recovery attempt receives the original stop detail rather than the
 * accumulated failure chain (ES-450 Finding 3).
 */
function stripRecoveryFailedSuffix(detail: string | null): string | null {
  if (detail === null) return null;
  const idx = detail.lastIndexOf(" (recovery failed: ");
  if (idx >= 0) return detail.slice(0, idx) || null;
  if (detail.startsWith("recovery failed: ")) return null;
  return detail;
}

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
