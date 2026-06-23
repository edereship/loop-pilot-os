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
  RecoveryContext,
  RecoveryOutcome,
  WorkflowRecovery,
  PauseTarget,
  PauseMeta,
  GroomAction,
  GroomOutput,
  MemoryCategory,
  GroomLogRow,
  GroomOutcome,
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

  it("RunState は running/idle/halted/paused の 4 値である", () => {
    const all = ["running", "idle", "halted", "paused"] as const satisfies readonly RunState[];
    const ensureExhaustive = (s: RunState): (typeof all)[number] => {
      switch (s) {
        case "running":
        case "idle":
        case "halted":
        case "paused":
          return s;
        default: {
          const never: never = s;
          return never;
        }
      }
    };
    expect(all.map(ensureExhaustive).length).toBe(4);
  });

  it("FailureReason は仕様 §7 の 11 種の失敗理由を網羅する", () => {
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
      "workflow_setup_failed",
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
        case "workflow_setup_failed":
          return r;
        default: {
          const never: never = r;
          return never;
        }
      }
    };
    expect(all.map(ensureExhaustive).length).toBe(11);
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
      pauseMeta: null,
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
      planBrief: null,
      selectRationale: null,
      startedAt: "2026-06-05T00:00:00.000Z",
      monitorStartedAt: null,
      endedAt: null,
      workflowFixAttempts: 0,
      workflowHandledErrorCount: 0,
      autoRestartAttempts: 0,
      pendingRestartReason: null,
      recoveryAttempted: 0,
      recoveryAction: null,
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

  it("MonitorVerdict は kind で 8 バリアントを判別でき、stopped は stopReason に null を保持できる（仕様 §6）", () => {
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
      { kind: "workflow_failed", errorBody: "⚠️ failure", errorCommentCount: 1, hasStateComment: false },
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
        case "workflow_failed":
          return `workflow_failed(${v.errorCommentCount})`;
        default: {
          const never: never = v;
          return never;
        }
      }
    };
    expect(variants.map(describe)).toContain("stopped(no reason)");
    expect(variants.map(describe)).toContain("workflow_failed(1)");
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

  it("NotifyEvent は kind で 9 バリアント（halted/idle/run_started/task_started/task_merged/quota_waiting/quota_resumed/paused/resumed）を判別できる（仕様 §10）", () => {
    const events = [
      { kind: "halted", reason: "task_cap", detail: "limit reached" },
      { kind: "idle", detail: "queue empty" },
      { kind: "run_started", detail: "started" },
      { kind: "task_started", identifier: "TY-1", title: "t" },
      { kind: "task_merged", identifier: "TY-1", title: "t", mergedCount: 1 },
      { kind: "quota_waiting", detail: "d" },
      { kind: "quota_resumed", detail: "d" },
      { kind: "paused", target: "claude", detail: "d" },
      { kind: "resumed", target: "codex", detail: "d" },
    ] as const satisfies readonly NotifyEvent[];
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["halted", "idle", "run_started", "task_started", "task_merged", "quota_waiting", "quota_resumed", "paused", "resumed"]);
    expect(kinds).toHaveLength(9);
  });
});

describe("モジュールインターフェース（カーネル §2 / 仕様 §4）", () => {
  it("PromptArgs.digest は store.recentMergedSummaries の戻り型と同型である", () => {
    const args: PromptArgs = {
      goal: "ship it",
      specContent: null,
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
      getAllEligible: async (_excludeIds: string[]): Promise<EligibleIssue[]> => [eligible],
      transition: async (_issueId: string, _state: TicketState): Promise<void> => {},
      findOrphanedInProgress: async (_knownIssueIds: string[]): Promise<EligibleIssue[]> => [],
      postComment: async (_issueId: string, _body: string): Promise<void> => {},
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
      postComment: async (_prNumber: number, _body: string): Promise<void> => {},
      discardWorktree: async (_branch: string, _worktreePath: string): Promise<void> => {},
      getPrDiffSummary: async (_prNumber: number) => ({ title: "", body: "", diff: "" }),
      fetchDefaultBranch: async (): Promise<void> => {},
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

  it("RecoveryContext / RecoveryOutcome / WorkflowRecovery はインターフェースを満たす実装に代入できる", () => {
    const ctx: RecoveryContext = {
      worktreePath: "/tmp/wt",
      branch: "looppilot/ty-1-fix",
      prNumber: 42,
      errorBody: "⚠️ workflow failed",
      errorCommentCount: 1,
      fixAttempts: 0,
      handledErrorCount: 0,
      maxCostUsd: 2.0,
    };
    const outcomes = [
      { kind: "restarted", costUsd: 0.5, newFix: true },
      { kind: "exhausted", costUsd: 1.5 },
      { kind: "unrecoverable", costUsd: 0.3, message: "agent error" },
    ] as const satisfies readonly RecoveryOutcome[];
    const recovery: WorkflowRecovery = {
      attemptRecovery: async (_ctx: RecoveryContext): Promise<RecoveryOutcome> =>
        outcomes[0],
    };
    expect(ctx.prNumber).toBe(42);
    expect(outcomes).toHaveLength(3);
    expect(recovery.attemptRecovery).toBeTypeOf("function");
  });
});

describe("PauseMeta / RunState / NotifyEvent type extensions", () => {
  it("PauseMeta round-trips correctly", () => {
    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };
    expect(meta.reason).toBe("rate_limit");
    expect(meta.target).toBe("claude");
  });

  it("RunState accepts 'paused'", () => {
    const state: RunState = "paused";
    expect(state).toBe("paused");
  });

  it("RunRow includes pauseMeta", () => {
    const row: RunRow = {
      id: 1,
      startedAt: "2026-06-21T00:00:00.000Z",
      taskCap: 5,
      state: "paused",
      haltReason: null,
      pauseMeta: {
        reason: "rate_limit",
        target: "codex",
        pausedAt: "2026-06-21T00:00:00.000Z",
        nextReprobeAt: "2026-06-21T00:10:00.000Z",
        capDeadlineAt: "2026-06-21T01:00:00.000Z",
      },
    };
    expect(row.pauseMeta?.target).toBe("codex");
  });

  it("NotifyEvent accepts paused and resumed kinds", () => {
    const paused: NotifyEvent = {
      kind: "paused",
      target: "claude",
      detail: "rate limited for 1h",
    };
    const resumed: NotifyEvent = {
      kind: "resumed",
      target: "claude",
      detail: "rate limit cleared",
    };
    expect(paused.kind).toBe("paused");
    expect(resumed.kind).toBe("resumed");
  });
});

describe("v3 GROOM 型（A3 / B2）", () => {
  it("GroomAction は type で 7 バリアントを判別できる", () => {
    const actions = [
      { type: "reprioritize", issueId: "ES-1", priority: 2 as const, rationale: "urgent" },
      { type: "update", issueId: "ES-2", title: "new title", rationale: "clarify" },
      { type: "create", title: "new task", description: "details", priority: 3 as const, rationale: "gap" },
      { type: "split", issueId: "ES-3", subtasks: [{ title: "sub1", description: "d1" }], rationale: "too big" },
      { type: "close", issueId: "ES-4", rationale: "duplicate" },
      { type: "label", issueId: "ES-5", add: ["bug"], remove: ["feature"], rationale: "reclassify" },
      { type: "update_memory", category: "pm_decisions" as const, content: "decided X", rationale: "record" },
    ] as const satisfies readonly GroomAction[];

    const ensureExhaustive = (a: GroomAction): string => {
      switch (a.type) {
        case "reprioritize": return `reprioritize:${a.priority}`;
        case "update": return `update:${a.issueId}`;
        case "create": return `create:${a.title}`;
        case "split": return `split:${a.subtasks.length}`;
        case "close": return `close:${a.issueId}`;
        case "label": return `label:${a.issueId}`;
        case "update_memory": return `memory:${a.category}`;
        default: { const never: never = a; return never; }
      }
    };
    expect(actions.map(ensureExhaustive)).toHaveLength(7);
  });

  it("GroomAction.update は title/description をオプショナルで持つ", () => {
    const titleOnly: GroomAction = { type: "update", issueId: "ES-1", title: "t", rationale: "r" };
    const descOnly: GroomAction = { type: "update", issueId: "ES-1", description: "d", rationale: "r" };
    expect(titleOnly.type).toBe("update");
    expect(descOnly.type).toBe("update");
  });

  it("GroomAction.label は add/remove をオプショナルで持つ", () => {
    const addOnly: GroomAction = { type: "label", issueId: "ES-1", add: ["bug"], rationale: "r" };
    const removeOnly: GroomAction = { type: "label", issueId: "ES-1", remove: ["wip"], rationale: "r" };
    expect(addOnly.type).toBe("label");
    expect(removeOnly.type).toBe("label");
  });

  it("GroomOutput は actions 配列 + summary を持つ", () => {
    const output: GroomOutput = {
      actions: [
        { type: "close", issueId: "ES-1", rationale: "done" },
      ],
      summary: "Closed 1 duplicate",
    };
    expect(output.actions).toHaveLength(1);
    expect(output.summary).toBe("Closed 1 duplicate");
  });

  it("MemoryCategory は pm_decisions/impl_results/product_knowledge の 3 値である", () => {
    const all = [
      "pm_decisions",
      "impl_results",
      "product_knowledge",
    ] as const satisfies readonly MemoryCategory[];
    const ensureExhaustive = (c: MemoryCategory): string => {
      switch (c) {
        case "pm_decisions": return c;
        case "impl_results": return c;
        case "product_knowledge": return c;
        default: { const never: never = c; return never; }
      }
    };
    expect(all.map(ensureExhaustive)).toHaveLength(3);
  });

  it("GroomOutcome は completed/skipped/error の 3 値である", () => {
    const all = [
      "completed", "skipped", "error",
    ] as const satisfies readonly GroomOutcome[];
    const ensureExhaustive = (o: GroomOutcome): string => {
      switch (o) {
        case "completed": return o;
        case "skipped": return o;
        case "error": return o;
        default: { const never: never = o; return never; }
      }
    };
    expect(all.map(ensureExhaustive)).toHaveLength(3);
  });

  it("GroomLogRow は groom_log テーブルの全カラムに対応する", () => {
    const row: GroomLogRow = {
      id: 1,
      runId: 1,
      loopIndex: 0,
      startedAt: "2026-06-23T00:00:00.000Z",
      endedAt: "2026-06-23T00:01:00.000Z",
      summary: "Reprioritized 2 tickets",
      actionsRequested: 3,
      actionsExecuted: 2,
      actionsRejected: 1,
      actionDetails: '[{"type":"reprioritize","issueId":"ES-1","priority":2,"rationale":"urgent"}]',
      outcome: "completed",
      errorDetail: null,
    };
    expect(row.outcome).toBe("completed");
    expect(row.errorDetail).toBeNull();

    const minimal: GroomLogRow = {
      id: 2,
      runId: 1,
      loopIndex: 1,
      startedAt: "2026-06-23T00:02:00.000Z",
      endedAt: null,
      summary: null,
      actionsRequested: 0,
      actionsExecuted: 0,
      actionsRejected: 0,
      actionDetails: null,
      outcome: "skipped",
      errorDetail: null,
    };
    expect(minimal.endedAt).toBeNull();
  });
});
