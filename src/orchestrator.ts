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
  RecoveryContext,
  RecoveryOutcome,
  WorkflowRecovery,
} from "./types.js";
import { classifyStopReason } from "./stop-reason.js";
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
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  recovery: WorkflowRecovery;
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
  private readonly clock: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly recovery: WorkflowRecovery;

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
    this.clock = deps.clock;
    this.sleep = deps.sleep;
    this.log = deps.log;
    this.recovery = deps.recovery;
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
          // If the prior stop was a terminal counter exhaustion, do not revive.
          // resetAndAdopt would zero autoRestartAttempts/pendingRestartReason, letting
          // each daemon restart post another full round of /restart-review comments
          // instead of honouring the terminal HALT (ES-411).
          if (
            (recoveryCategory === "auto_restart" &&
              session.stopDetail?.startsWith("auto-restart limit exceeded")) ||
            (recoveryCategory === "quota_wait" &&
              session.stopDetail?.startsWith("quota retry limit exceeded"))
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
      workflowFixAttempts: 0,
      workflowHandledErrorCount: 0,
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

      // 2) SELECT（仕様 §5.1）
      // getNextEligible の失敗（Linear 一時障害等）は CLAIM① と同様にセッション無しで
      // HALT+通知して人間に上げる（無人ループを無通知の Fatal 落ちさせない）。
      let issue: EligibleIssue | null;
      try {
        issue = await this.source.getNextEligible(this.store.activeIssueIds());
      } catch (err) {
        const detail = `select_failed: getNextEligible: ${errMsg(err)}`;
        await this.notifier.notify({ kind: "halted", reason: "exception", detail });
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }
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
    if (this.config.notify.progress) {
      await this.notifier.notify({
        kind: "task_started",
        identifier: issue.identifier,
        title: issue.title,
      });
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
        hardTimeoutMs: this.config.safety.sessionHardTimeoutMinutes * 60_000,
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
          return await this.stopSession(session, "exception", `monitor poll failed 5x: ${errMsg(err)}`);
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
              return await this.stopSession(
                session,
                "exception",
                `merge readiness check failed 5x: ${outcome.error}`,
              );
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
                return await this.stopSession(
                  session,
                  "exception",
                  `merge readiness check failed 5x: ${outcome.error}`,
                );
              }
              backoffMultiplier = Math.min(2 ** readinessFailures, 8);
              continue;
            }
            readinessFailures = 0;
            if (outcome.kind === "merge_failed") {
              mergeFailures += 1;
              if (mergeFailures >= 2) {
                return await this.stopSession(
                  session,
                  "ci_failed",
                  `merge call failed under ready verdict: ${outcome.error}`,
                );
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
                return await this.stopSession(session, "exception", "monitor timeout");
              }
              continue;
            }
            autoRestartCount += 1;
            if (autoRestartCount > 3) {
              return await this.stopSession(
                session,
                "looppilot_stopped",
                `auto-restart limit exceeded (${autoRestartCount}x): ${verdict.stopReason}`,
              );
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
              return await this.stopSession(
                session,
                "exception",
                `/restart-review comment failed: ${errMsg(err)}`,
              );
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
                return await this.stopSession(session, "exception", "monitor timeout");
              }
              continue;
            }
            quotaRetryCount += 1;
            quotaResumedNotified = false;
            if (quotaRetryCount > 6) {
              return await this.stopSession(
                session,
                "looppilot_stopped",
                `quota retry limit exceeded (${quotaRetryCount}x): ${verdict.stopReason}`,
              );
            }
            if (quotaRetryCount === 1) {
              await this.notifier.notify({
                kind: "quota_waiting",
                detail: `${session.linearIdentifier} ${verdict.stopReason}`,
              });
            }
            const QUOTA_WAIT_MS = 60 * 60 * 1000;
            const QUOTA_SLEEP_CHUNK_MS = 10_000;
            for (let elapsed = 0; elapsed < QUOTA_WAIT_MS; elapsed += QUOTA_SLEEP_CHUNK_MS) {
              if (this.interrupted) {
                await this.haltForInterrupt();
                return HALT;
              }
              await this.sleep(QUOTA_SLEEP_CHUNK_MS);
            }
            // Finding 3: re-check after the loop so a stop requested during
            // the final sleep chunk halts before posting to the PR.
            if (this.interrupted) {
              await this.haltForInterrupt();
              return HALT;
            }
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
              return await this.stopSession(
                session,
                "exception",
                `/restart-review comment failed: ${errMsg(err)}`,
              );
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
          return await this.stopSession(
            session,
            "looppilot_stopped",
            verdict.stopReason ?? "looppilot stopped (no reason)",
          );
        }
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
            return await this.stopSession(session, "exception", "monitor timeout");
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
            return await this.stopSession(
              session,
              "workflow_setup_failed",
              `workflow recovery error: ${errMsg(err)}`,
            );
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
                return await this.stopSession(session, "exception", "monitor timeout");
              }
              // Only fall back to the not-engaged guard while no live state comment
              // exists, so an ignored /restart-review cannot poll forever — but a
              // restarted review whose state moved to fixing/waiting_codex is treated
              // as in-progress and never killed by the guard.
              if (
                !verdict.hasStateComment &&
                this.elapsedMinutesSinceMonitorStart(session.id) > this.config.safety.notEngagedGuardMinutes
              ) {
                return await this.stopSession(session, "monitor_never_engaged", null);
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
          return await this.stopSession(
            session,
            "workflow_setup_failed",
            detail,
          );
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

  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。 */
  private async haltForInterrupt(): Promise<void> {
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
