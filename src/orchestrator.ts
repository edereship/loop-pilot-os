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
  }

  /** 停止要求を立てる（SIGINT ハンドラ等から呼ぶ）。次の安全点でクリーン halt する。 */
  requestStop(): void {
    this.interrupted = true;
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
      // 0) 停止要求の安全点（各反復先頭。現フェーズ群完了後にここへ戻る）
      if (this.interrupted) {
        this.haltForInterrupt();
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
    let mergeFailures = 0; // ready verdict 下での mergePr 連続失敗（2 連続で fail-closed）
    while (true) {
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
      // カーネル§7: 「ready のまま 2連続 throw」— done+ready 以外の評価を挟んだらストリークは断絶する
      if (verdict.kind !== "done") mergeFailures = 0;

      switch (verdict.kind) {
        case "merged":
          return CONTINUE; // DONE へ
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

  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。 */
  private haltForInterrupt(): void {
    const detail = "user_interrupt: stop requested; halting at safe point";
    this.store.setRunState(this.runId, "halted", detail);
    void this.notifier.notify({ kind: "halted", reason: "user_interrupt", detail });
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
