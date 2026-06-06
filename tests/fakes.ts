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
} from "../src/types.js";

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
