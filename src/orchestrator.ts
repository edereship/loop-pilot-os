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
} from "./types.js";
import { classifyStopReason } from "./stop-reason.js";
import { buildPlanPrompt, parseBrief } from "./plan-brief.js";
import { buildSelectPrompt, parseSelection } from "./select-prompt.js";
import { executeRecoveryTurn } from "./recovery-turn.js";
import type { RecoveryTurnDeps } from "./recovery-turn.js";
import type { SqliteStore } from "./store.js";
import type { Config } from "./config.js";

export type RunOutcome = "finished" | "lock_rejected";

export interface OrchestratorDeps {
  config: Config;
  source: TaskSource;
  agent: AgentRunner;
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
  codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
  recoveryTurn: RecoveryTurnDeps | null;
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
  private readonly codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
  private readonly recoveryTurn: RecoveryTurnDeps | null;

  private runId = 0;
  private interrupted = false; // SIGINT 等の停止要求（次の安全点で halt）

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.source = deps.source;
    this.agent = deps.agent;
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
    this.codebaseSummaryGenerator = deps.codebaseSummaryGenerator;
    this.recoveryTurn = deps.recoveryTurn;
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
      const taskCap = this.config.safety.maxTasksPerRun;
      const run = this.store.createRun(taskCap, this.clock());
      this.runId = run.id;
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
    }

    // 3) stopped(looppilot_stopped) + PR ありのセッション回復（ES-411）
    for (const session of this.store.stoppedSessionsWithPr("looppilot_stopped")) {
      const ctrl = await this.recoverStoppedByLooppilot(session, session.prNumber as number);
      if (ctrl.control === "halt") return HALT;
    }

    return CONTINUE;
  }

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
        return await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
      }
      // done / in_progress / corrupted / not_engaged = open 扱い → 採用して MONITOR 再開
      case "done":
      case "in_progress":
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
    // merged 到達 → DONE 後段
    await this.recoverDone(fresh);
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
    // exists yet. If the agent already committed changes (crash between runSession
    // completing and handoff() recording "handing_off"), fall through to manual cleanup
    // to avoid destroying committed implementation work.
    // Also treat uncommitted file edits as "work" — if SIGINT fires during the
    // rate-limit sleep after Claude has edited files but before it commits, the
    // worktree is dirty but hasCommitsWithDiff returns false.  Discarding that
    // worktree would silently destroy the partial implementation.
    if (session.state === "implementing") {
      let hasWork = false;
      if (session.worktreePath) {
        try {
          hasWork = await this.git.hasCommitsWithDiff(session.worktreePath) ||
            await this.git.hasUncommittedChanges(session.worktreePath);
        } catch {
          hasWork = true; // assume work exists if check fails; prefer manual cleanup
        }
      }
      if (!hasWork) {
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
      // Has committed work → fall through to manual cleanup below
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
      if (
        session.stopDetail !== null &&
        (session.stopDetail.startsWith("auto-restart limit exceeded") ||
          session.stopDetail.startsWith("quota retry limit exceeded"))
      ) {
        this.log(
          `recovery: skipping exhausted stopped session PR #${prNumber} (poll error): ${session.stopDetail}`,
        );
        return CONTINUE;
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
          if (
            (recoveryCategory === "auto_restart" &&
              session.stopDetail !== null &&
              session.stopDetail.startsWith("auto-restart limit exceeded") &&
              extractExhaustedStopReason(session.stopDetail) === verdict.stopReason) ||
            (recoveryCategory === "quota_wait" &&
              session.stopDetail !== null &&
              session.stopDetail.startsWith("quota retry limit exceeded") &&
              extractExhaustedStopReason(session.stopDetail) === verdict.stopReason)
          ) {
            this.log(
              `recovery: skipping exhausted stopped session PR #${prNumber}: ${session.stopDetail}`,
            );
            return CONTINUE;
          }
          this.resetAndAdopt(session.id);
          return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
        }
        // human_required / null → LoopPilot has not yet restarted; skip
        return CONTINUE;
      }
      case "pr_closed":
        return CONTINUE;
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
      const started = this.store.countTasksStarted(this.runId);
      if (started >= this.config.safety.maxTasksPerRun) {
        const detail = `task cap reached: ${started}/${this.config.safety.maxTasksPerRun}`;
        await this.notifier.notify({ kind: "halted", reason: "task_cap", detail });
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
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
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }
      if (eligible.length === 0) {
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

      let issue: EligibleIssue;
      let selectRationale: string | null = null;
      if (this.planner !== null) {
        const sel = await this.selectWithPm(eligible);
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

      // 4) PLAN
      const plan = await this.plan(session, issue);
      if (plan.control === "halt") return;
      const planBrief = plan.brief;

      // Safe point: honor a stop request before the mutating IMPLEMENT phase.
      // PLAN is read-only, so stopping here leaves the session in "claimed" —
      // recoverByOpenPr auto-reverts claimed sessions with no open PR on the
      // next startup rather than halting for manual cleanup.
      if (this.interrupted) {
        await this.haltForInterrupt();
        return;
      }

      // 5) IMPLEMENT (was 4)
      const impl = await this.implement(session, issue, planBrief);
      if (impl.control === "halt") return;

      // 6) HANDOFF (was 5)
      const handoff = await this.handoff(session, issue);
      if (!("prNumber" in handoff)) {
        if (handoff.control === "halt") return;
        continue; // recovery CONTINUE → retry from SELECT
      }
      const prNumber = handoff.prNumber;

      // 7) MONITOR (was 6)
      const mon = await this.monitorSession(session, prNumber);
      if (mon.control === "halt") return;

      // 8) DONE (was 7)
      await this.done(session, issue);
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

  // ---- PLAN（スコープ doc A2 / §1.1 / §1.5） ----
  private async plan(
    session: TaskSessionRow,
    issue: EligibleIssue,
  ): Promise<{ control: "continue"; brief: PlanBrief | null } | { control: "halt" }> {
    if (this.planner === null) {
      return { control: "continue", brief: null };
    }

    const worktreePath = session.worktreePath as string;

    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch (err) {
        this.log(`plan: spec loading failed, falling back to raw ticket: ${errMsg(err)}`);
        return { control: "continue", brief: null };
      }
    }

    const prompt = buildPlanPrompt({ issue, specContent });

    let outcome: PlanOutcome;
    try {
      outcome = await this.planner.run({
        worktreePath,
        prompt,
        timeoutMs: this.config.safety.codexTimeoutMinutes * 60_000,
      });
    } catch (err) {
      this.log(`plan: codex exception, falling back to raw ticket: ${errMsg(err)}`);
      return { control: "continue", brief: null };
    }

    if (outcome.kind === "interrupted") {
      await this.haltForInterrupt();
      return { control: "halt" };
    }

    if (outcome.kind === "error") {
      this.log(`plan: codex failed, falling back to raw ticket: ${outcome.message}`);
      return { control: "continue", brief: null };
    }

    const brief = parseBrief(outcome.text);
    if (brief.raw.length > 0) {
      this.log(`plan: brief generated (sections=${brief.sections !== null ? "parsed" : "raw-only"})`);
      this.store.updateSession(session.id, { planBrief: brief.raw });
      if (!this.interrupted) {
        try {
          await this.source.postComment(issue.id, brief.raw);
        } catch (err) {
          this.log(`plan: brief writeback failed (non-fatal): ${errMsg(err)}`);
        }
      }
    } else {
      this.log("plan: codex returned empty output, falling back to raw ticket");
    }

    return { control: "continue", brief };
  }

  // ---- SELECT PM（スコープ doc A1 / §1.4 / §1.5） ----
  private async selectWithPm(
    eligible: EligibleIssue[],
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

    const prompt = buildSelectPrompt({
      goal: this.config.product.goal ?? null,
      specContent,
      eligible,
      inProgress,
      recentMerged,
      lastPrDiff,
      diffBudgetChars: this.config.safety.selectDiffBudgetChars,
      codebaseSummary,
    });

    let outcome: PlanOutcome;
    // SELECT runs before CLAIM so no worktree exists yet; use the repo root.
    const repoPath = this.config.repo.path;
    try {
      outcome = await this.planner!.run({
        worktreePath: repoPath,
        prompt,
        timeoutMs: this.config.safety.codexTimeoutMinutes * 60_000,
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
    const prompt = this.buildPrompt({
      goal: this.config.product.goal ?? null,
      specContent,
      issue,
      digest,
      planBrief,
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
    let quotaRetryCount = 0;
    let quotaResumedNotified = false;
    let firstPoll = true;
    while (true) {
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
          continue;
        }
        backoffMultiplier = Math.min(backoffMultiplier * 2, 8);
        continue;
      }
      pollFailures = 0;
      backoffMultiplier = 1;
      // Clear the pending-restart record when LoopPilot transitions away from stopped — that
      // confirms the /restart-review was consumed and the restart is no longer in flight.
      if (verdict.kind !== "stopped") {
        if (pendingRestartReason !== undefined) {
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
              continue;
            }
            continue; // 1 回目は次ポーリングで再評価
          }
          // outcome.kind === "continue"（readiness が ci_pending/unknown 等）
          mergeFailures = 0; // ready 連続を断ち切る事象が起きたらリセット
          continue;
        }
        case "stopped": {
          const category = classifyStopReason(verdict.stopReason);
          if (category === "review_done") {
            // Workflow completed (no_findings) — treat same as done for merge streak.
            // Also clear any pending restart since LoopPilot completed successfully.
            if (pendingRestartReason !== undefined) {
              pendingRestartReason = undefined;
              this.store.updateSession(session.id, { pendingRestartReason: null });
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
                continue;
              }
              continue;
            }
            mergeFailures = 0;
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
              pendingRestartReason: verdict.stopReason,
            });
            continue;
          }
          // human_required / null → HALT
          {
            const ctrl = await this.stopSession(
              session,
              "looppilot_stopped",
              verdict.stopReason ?? "looppilot stopped (no reason)",
            );
            if (ctrl.control === "halt") return HALT;
            continue;
          }
        }
        case "pr_closed": {
          const ctrl = await this.stopSession(session, "pr_closed", null);
          if (ctrl.control === "halt") return HALT;
          continue;
        }
        case "corrupted": {
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
    this.store.updateSession(session.id, { state: "merged", endedAt: this.clock() });
    try {
      await retry(3, () => this.source.transition(issue.id, "done"));
    } catch (err) {
      // best-effort：失敗してもコンソール警告のみで Run=running 維持（仕様 §5.6 注記）
      this.log(`warning: transition(done) failed for ${issue.identifier}: ${errMsg(err)}`);
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
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber">> = {},
  ): Promise<RunControl> {
    // --- Recovery gate (ES-450) ---
    if (reason !== "cost_exceeded" && this.recoveryTurn !== null && this.planner !== null) {
      const fresh = this.store.getSession(session.id);
      if (!fresh.recoveryAttempted) {
        this.store.updateSession(session.id, { recoveryAttempted: 1 });
        await this.notifier.notify({
          kind: "recovery_started",
          identifier: session.linearIdentifier,
          reason,
        });
        let result;
        try {
          result = await executeRecoveryTurn(
            this.recoveryTurn,
            fresh,
            reason,
            detail,
          );
        } catch (err) {
          this.log(`recovery: exception: ${err instanceof Error ? err.message : String(err)}`);
          result = { kind: "escalated" as const, action: "escalate" as const };
        }
        const actionStr = "action" in result ? result.action : "escalate";
        this.store.updateSession(session.id, { recoveryAction: actionStr });
        if (result.kind === "recovered") {
          const recoveryCost = result.costUsd;
          if (recoveryCost > 0) {
            const refreshed = this.store.getSession(session.id);
            this.store.updateSession(session.id, {
              costUsd: (refreshed.costUsd ?? 0) + recoveryCost,
            });
          }
          await this.notifier.notify({
            kind: "recovery_succeeded",
            identifier: session.linearIdentifier,
            action: result.action,
          });
          this.store.updateSession(session.id, {
            state: "in_review",
            monitorStartedAt: this.clock(),
            failureReason: null,
            stopDetail: null,
            endedAt: null,
          });
          return CONTINUE;
        }
        // escalated / failed → fall through to normal stop
      }
    }
    // --- Original stop logic (unchanged) ---
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

  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。
   *  Idempotent: if the run is already halted (e.g. interruptablePause already
   *  called this), the second call is a no-op — no duplicate notification. */
  private async haltForInterrupt(): Promise<void> {
    const run = this.store.getRun(this.runId);
    if (run.state === "halted") return;
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
