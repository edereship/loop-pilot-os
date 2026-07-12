import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";
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
  WorkflowRecovery,
  RecoveryContext,
  RecoveryOutcome,
  PlanRunner,
  PlanOutcome,
} from "../src/types.js";
import type { IGroomBoardFetcher, IGroomLinearClient } from "../src/orchestrator.js";

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
      // 最長プレフィックス優先。同長の場合は後登録（= 上書き）が勝つ。
      if (best === undefined || stub.prefix.length >= best.prefix.length) {
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
  /** postComment の呼び出し記録 */
  comments: Array<{ issueId: string; body: string }> = [];
  /** addLabel の呼び出し記録 */
  labelAdds: Array<{ issueId: string; labelName: string }> = [];
  /** メソッド名 → 次の1回だけ throw させるエラー */
  private failOnce = new Map<string, Error>();

  failNext(method: "getNextEligible" | "transition" | "findOrphanedInProgress" | "postComment" | "getAllEligible" | "addLabel", error?: Error): void {
    this.failOnce.set(method, error ?? new Error(`FakeTaskSource.${method} injected failure`));
  }

  private takeFailure(method: string): void {
    const err = this.failOnce.get(method);
    if (err) {
      this.failOnce.delete(method);
      throw err;
    }
  }

  async getNextEligible(hardExcludeIds: string[], abandonedExcludeIds: string[] = [], _legacyExcludeIds: string[] = [], _onLegacyLabelDetected?: (issueId: string) => void): Promise<EligibleIssue | null> {
    const allExcludeIds = [...hardExcludeIds, ...abandonedExcludeIds];
    this.eligibleCalls.push(allExcludeIds);
    this.takeFailure("getNextEligible");
    const labeled = new Set(this.labelAdds.map((l) => l.issueId));
    const next = this.queue.find((i) => !allExcludeIds.includes(i.id) && !labeled.has(i.id));
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

  async postComment(issueId: string, body: string): Promise<void> {
    this.takeFailure("postComment");
    this.comments.push({ issueId, body });
  }

  async addLabel(issueId: string, labelName: string): Promise<void> {
    this.takeFailure("addLabel");
    this.labelAdds.push({ issueId, labelName });
  }

  async getAllEligible(hardExcludeIds: string[], abandonedExcludeIds: string[] = [], _legacyExcludeIds: string[] = [], _onLegacyLabelDetected?: (issueId: string) => void): Promise<EligibleIssue[]> {
    const allExcludeIds = [...hardExcludeIds, ...abandonedExcludeIds];
    this.eligibleCalls.push(allExcludeIds);
    this.takeFailure("getAllEligible");
    const exclude = new Set(allExcludeIds);
    // Mimic real LinearTaskSource: only return issues in "todo" state.
    // Derive each issue's current state from the most recent transition.
    const lastTransition = new Map<string, TicketState>();
    for (const t of this.transitions) {
      lastTransition.set(t.issueId, t.state);
    }
    // ES-492: Mimic label-based exclusion — issues with addLabel records are filtered out.
    const labeled = new Set(this.labelAdds.map((l) => l.issueId));
    return this.queue.filter((i) => {
      if (exclude.has(i.id)) return false;
      if (labeled.has(i.id)) return false;
      const state = lastTransition.get(i.id);
      // No transition recorded = still in original todo state
      // Transitioned back to todo = eligible again (e.g. after claim rollback)
      // Any other state = not eligible
      return state === undefined || state === "todo";
    });
  }
}

// ---- FakeAgentRunner ----
export class FakeAgentRunner implements AgentRunner {
  /** runSession が順に shift して返す結果 */
  outcomes: AgentOutcome[] = [];
  /** 呼び出された SessionContext を記録 */
  contexts: SessionContext[] = [];
  /** Total number of runSession invocations */
  callCount = 0;

  async runSession(ctx: SessionContext): Promise<AgentOutcome> {
    this.callCount++;
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
  /** findOpenPrsForIssue の戻り値（issueIdentifier → number[]）。既定 [] */
  openPrsForIssue = new Map<string, number[]>();
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

  async discardUncommittedChanges(worktreePath: string): Promise<void> {
    this.calls.push({ method: "discardUncommittedChanges", args: [worktreePath] });
    this.takeFailure("discardUncommittedChanges");
  }

  async findOpenPrForBranch(branch: string): Promise<number | null> {
    this.calls.push({ method: "findOpenPrForBranch", args: [branch] });
    this.takeFailure("findOpenPrForBranch");
    return this.openPrForBranch.get(branch) ?? null;
  }

  async findOpenPrsForIssue(issueIdentifier: string): Promise<number[]> {
    this.calls.push({ method: "findOpenPrsForIssue", args: [issueIdentifier] });
    this.takeFailure("findOpenPrsForIssue");
    return this.openPrsForIssue.get(issueIdentifier) ?? [];
  }

  async closePr(prNumber: number): Promise<void> {
    this.calls.push({ method: "closePr", args: [prNumber] });
    this.takeFailure("closePr");
  }

  async closeStalePrsForIssue(issueIdentifier: string, exceptPrNumber: number): Promise<void> {
    this.calls.push({ method: "closeStalePrsForIssue", args: [issueIdentifier, exceptPrNumber] });
    this.takeFailure("closeStalePrsForIssue");
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

  async postComment(prNumber: number, body: string): Promise<void> {
    this.calls.push({ method: "postComment", args: [prNumber, body] });
    this.takeFailure("postComment");
  }

  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    this.calls.push({ method: "discardWorktree", args: [branch, worktreePath] });
    this.takeFailure("discardWorktree");
  }

  /** Optional side effect called after fetchDefaultBranch (e.g. delete files to simulate git reset --hard). */
  fetchDefaultBranchSideEffect?: () => void;

  async fetchDefaultBranch(): Promise<void> {
    this.calls.push({ method: "fetchDefaultBranch", args: [] });
    this.takeFailure("fetchDefaultBranch");
    this.fetchDefaultBranchSideEffect?.();
  }

  prDiffSummaries = new Map<number, import("../src/types.js").PrDiffSummary>();

  async getPrDiffSummary(prNumber: number, _maxDiffChars?: number): Promise<import("../src/types.js").PrDiffSummary> {
    this.calls.push({ method: "getPrDiffSummary", args: [prNumber] });
    this.takeFailure("getPrDiffSummary");
    const preset = this.prDiffSummaries.get(prNumber);
    if (preset) return preset;
    return { title: `PR #${prNumber}`, body: "", diff: "" };
  }

  /** fetchCiLogs の戻り値。既定 null */
  ciLogs: string | null = null;

  async fetchCiLogs(prNumber: number, branch: string, headSha?: string): Promise<string | null> {
    this.calls.push({ method: "fetchCiLogs", args: [prNumber, branch, headSha] });
    this.takeFailure("fetchCiLogs");
    return this.ciLogs;
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

// ---- FakeWorkflowRecovery ----
export class FakeWorkflowRecovery implements WorkflowRecovery {
  outcomes: RecoveryOutcome[] = [];
  recoveryCalls: RecoveryContext[] = [];

  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome> {
    this.recoveryCalls.push(ctx);
    if (this.outcomes.length > 1) {
      return this.outcomes.shift() as RecoveryOutcome;
    }
    if (this.outcomes.length === 1) {
      return this.outcomes[0];
    }
    throw new Error("FakeWorkflowRecovery: no outcome queued");
  }
}

// ---- FakePlanRunner ----
export class FakePlanRunner implements PlanRunner {
  outcomes: PlanOutcome[] = [];
  calls: Array<{ worktreePath: string; prompt: string; timeoutMs?: number; model?: string; effort?: string }> = [];
  contexts: Array<{ worktreePath: string; prompt: string; timeoutMs?: number; model?: string; effort?: string }> = [];

  async run(ctx: { worktreePath: string; prompt: string; timeoutMs?: number; model?: string; effort?: string }): Promise<PlanOutcome> {
    this.calls.push(ctx);
    this.contexts.push(ctx);
    const out = this.outcomes.shift();
    if (!out) throw new Error("FakePlanRunner: no outcome queued");
    return out;
  }
}

// ---- FakeGroomBoardFetcher ----
import type { BoardState } from "../src/types.js";

export class FakeGroomBoardFetcher implements IGroomBoardFetcher {
  boardState: BoardState = { eligible: [], inProgress: [], recentDone: [], blocked: [] };
  projectIssueIds: Set<string> = new Set();
  doneIssueIds: Set<string> = new Set();
  optInIssueIds: Set<string> = new Set();
  activeIssueIds: Set<string> = new Set();
  needsHumanIssueIds: Set<string> = new Set();
  calls: string[] = [];
  private _failNextMethods = new Map<string, Error>();

  /** Make the next call to `method` throw `error` (or a generic error). */
  failNext(method: "getBoardState" | "getProjectIssueIds" | "getDoneIssueIds" | "getOptInIssueIds" | "getActiveIssueIds" | "getNeedsHumanIssueIds" | "getIssuesByLabel", error?: Error): void {
    this._failNextMethods.set(method, error ?? new Error(`FakeGroomBoardFetcher.${method} forced failure`));
  }

  private _maybeThrow(method: string): void {
    const err = this._failNextMethods.get(method);
    if (err) {
      this._failNextMethods.delete(method);
      throw err;
    }
  }

  refresh(): void {
    this.calls.push("refresh");
  }

  async getBoardState(_prMap: Map<string, number | null>): Promise<BoardState> {
    this.calls.push("getBoardState");
    this._maybeThrow("getBoardState");
    return this.boardState;
  }
  async getProjectIssueIds(): Promise<Set<string>> {
    this.calls.push("getProjectIssueIds");
    this._maybeThrow("getProjectIssueIds");
    return this.projectIssueIds;
  }
  async getDoneIssueIds(): Promise<Set<string>> {
    this.calls.push("getDoneIssueIds");
    this._maybeThrow("getDoneIssueIds");
    return this.doneIssueIds;
  }
  async getOptInIssueIds(): Promise<Set<string>> {
    this.calls.push("getOptInIssueIds");
    this._maybeThrow("getOptInIssueIds");
    return this.optInIssueIds;
  }
  async getActiveIssueIds(): Promise<Set<string>> {
    this.calls.push("getActiveIssueIds");
    this._maybeThrow("getActiveIssueIds");
    return this.activeIssueIds;
  }

  async getNeedsHumanIssueIds(_needsHumanLabel: string): Promise<Set<string>> {
    this.calls.push("getNeedsHumanIssueIds");
    this._maybeThrow("getNeedsHumanIssueIds");
    return this.needsHumanIssueIds;
  }

  issuesByLabel = new Map<string, Array<{ identifier: string; title: string; labels: string[] }>>();

  async getIssuesByLabel(label: string): Promise<Array<{ identifier: string; title: string; labels: string[] }>> {
    this.calls.push(`getIssuesByLabel:${label}`);
    this._maybeThrow("getIssuesByLabel");
    return this.issuesByLabel.get(label) ?? [];
  }
}

// ---- FakeGroomLinearClient ----
export class FakeGroomLinearClient implements IGroomLinearClient {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async updatePriority(issueId: string, priority: number): Promise<void> {
    this.calls.push({ method: "updatePriority", args: [issueId, priority] });
  }
  async updateIssue(issueId: string, fields: { title?: string; description?: string }): Promise<void> {
    this.calls.push({ method: "updateIssue", args: [issueId, fields] });
  }
  async createIssue(fields: { title: string; description: string; priority: number; extraLabelIds?: string[]; includeOptIn?: boolean }): Promise<string> {
    this.calls.push({ method: "createIssue", args: [fields] });
    return "FAKE-NEW";
  }
  async closeIssue(issueId: string, rationale: string): Promise<void> {
    this.calls.push({ method: "closeIssue", args: [issueId, rationale] });
  }
  async addLabels(issueId: string, names: string[]): Promise<void> {
    this.calls.push({ method: "addLabels", args: [issueId, names] });
  }
  async removeLabels(issueId: string, names: string[]): Promise<void> {
    this.calls.push({ method: "removeLabels", args: [issueId, names] });
  }
  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }> {
    this.calls.push({ method: "getIssueDetails", args: [issueId] });
    return { priority: 3, labelIds: [], description: "" };
  }
  async postComment(issueId: string, body: string): Promise<void> {
    this.calls.push({ method: "postComment", args: [issueId, body] });
  }
}
