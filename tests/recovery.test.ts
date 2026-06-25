import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  FakeWorkflowRecovery,
  FakeCommandRunner,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, TaskSessionRow, TicketState } from "../src/types.js";

// ---- テストヘルパ（Task 12 の makeConfig/issue/makeHarness と同形・独立ファイルのため再定義） ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product", specDir: undefined },
    repo: { path: "/repo", remote: "owner/name", defaultBranch: "main", worktreeRoot: "/wt" },
    digest: { recentMergedCount: over.recentMergedCount ?? 5, enabled: true },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes ?? 60,
      sessionHardTimeoutMinutes: 120,
      maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2,
      codexTimeoutMinutes: 30,
      selectDiffBudgetChars: 6000,
      selectCodebaseSummaryBudgetChars: 5000,
      groomTimeoutMinutes: 10,
      groomBoardBudgetChars: 10000,
      selfReviewTimeoutMinutes: 15,
      maxCostUsdPerSelfReview: 2,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
    notify: { progress: false },
    groom: { enabled: false },
    selfReview: { enabled: true },
    memory: { maxCharsPerFile: 8000, injectBudgetChars: 6000 },
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
  recovery: FakeWorkflowRecovery;
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
  const recovery = new FakeWorkflowRecovery();
  const memoryRunner = new FakeCommandRunner();
  memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
  const orch = new Orchestrator({
    config,
    source,
    agent,
    git,
    monitor,
    notifier,
    store,
    buildPrompt,
    specLoader: null,
    clock: fixedClock("2026-06-05T00:00:00.000Z"),
    sleep,
    log,
    recovery,
    planner: null,
    designer: null,
    codebaseSummaryGenerator: async () => "",
    recoveryTurn: null,
    runner: memoryRunner,
    designReviewer: null,
    groomDeps: null,
  });
  return { orch, store, source, agent, git, monitor, notifier, recovery, sleepCalls, logs, promptArgs };
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
    // Run=halted・回復で停止したのでループに入らず getAllEligible は呼ばれない
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
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
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

  it("in_review + quotaRetryAttempts=6 + pre-poll in_progress → quotaRetryAttempts reset to 0 so next episode starts fresh (ES-469 Finding 2)", async () => {
    // Scenario: process crashed with quotaRetryAttempts=6 and
    // pendingRestartReason="codex_usage_limit" in DB (a /restart-review was posted for
    // quota episode #6). On recovery the pre-poll sees in_progress (quota recovered).
    // Without the fix, monitorSession seeds quotaRetryCount=6 and pendingRestartReason=
    // "codex_usage_limit"; the first new stopped(codex_usage_limit) hits the stale
    // guard (pending matches), clears pending, and the SECOND one increments to 7>6 →
    // false HALT. With the fix quotaRetryAttempts=0 and pendingRestartReason=null so
    // the first stopped is a fresh episode (count=1) and the second is the stale grace.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
      quotaRetryAttempts: 6,
      pendingRestartReason: "codex_usage_limit",
    });
    h.monitor.verdicts = [
      { kind: "in_progress" },                              // recovery pre-poll: quota recovered
      // monitorSession polls:
      { kind: "stopped", stopReason: "codex_usage_limit" }, // WITH fix: not stale → count=1, sleep, post
                                                             // WITHOUT fix: stale → clears pending
      { kind: "stopped", stopReason: "codex_usage_limit" }, // WITH fix: stale → grace
                                                             // WITHOUT fix: not stale → count=7 > 6 → HALT
      { kind: "done" },                                     // WITH fix: tryMerge → merged
    ];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    // Without fix: quotaRetryCount=6+1=7>6 → HALT → state="stopped".
    // With fix: quotaRetryCount=0+1=1 → quota wait → /restart-review → merged.
    expect(s.state).toBe("merged");
    expect(s.quotaRetryAttempts).toBe(1);
    // /restart-review was posted exactly once (the fresh episode at count=1)
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(1);
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

describe("回復 — in_review + poll throw → 採用して MONITOR 再開（仕様 §9 / カーネル §8: 再起動直後 API 不調）", () => {
  // 回復時の poll throw は最頻の実障害（再起動直後の API 不調）。採用して MONITOR 再開することをピン留めする（この分岐を消すと red になる）
  it("poll が 1 回目 throw → 採用・MONITOR 再開 → 2 回目 merged → 完走し runId が新 Run に付替えられログに recovery: poll threw が含まれる", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 2 回目以降の poll は merged を返す（FakeMonitor の verdicts キュー）
    h.monitor.verdicts = [{ kind: "merged" }];
    // 1 回目の poll だけ throw、以降は元の FakeMonitor.poll に委譲
    const origPoll = h.monitor.poll.bind(h.monitor);
    let thrown = false;
    h.monitor.poll = async (pr: number) => {
      if (!thrown) {
        thrown = true;
        throw new Error("gh 502");
      }
      return origPoll(pr);
    };
    // 回復後ループで無限化しないよう getAllEligible の最初の呼び出しで停止させる
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // 採用 → MONITOR 再開 → merged
    expect(s.state).toBe("merged");
    // runId が新 Run へ付替えられている
    expect(s.runId).toBe(newRun.id);
    // DONE 後段: transition(done) が呼ばれた
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // ログに recovery: poll threw が含まれる
    expect(h.logs.some((l) => l.includes("recovery: poll threw"))).toBe(true);
  });
});

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
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
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
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
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

describe("回復 — open PR ミス → stopped(exception) + HALT（仕様 §9 / カーネル §8）", () => {
  it("claimed + no PR → auto-cleanup: discardWorktree + ticket→Todo + stopped(exception) + HALT (Finding 2)", async () => {
    // PLAN is read-only — a claimed session with no open PR can never have agent
    // commits. Recovery auto-reverts it (discard worktree + Todo) instead of
    // halting for manual cleanup.
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
    // stop_detail に PLAN phase auto-cleanup の識別子と branch/worktree/identifier
    expect(s.stopDetail).toContain("crash recovery: no open PR (PLAN phase)");
    expect(s.stopDetail).toContain("ticket reverted to Todo");
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
    // worktree が破棄され、チケットが Todo へ戻された
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-7-x", "/wt/ty-7"],
    });
    expect(h.source.transitions).toContainEqual({ issueId: "issue-G", state: "todo" });
    // pushAndOpenPr / mergePr は呼ばれない
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("claimed + no PR + worktreePath=null → ticket→Todo + stop_detail にプレースホルダ (Finding 2)", async () => {
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
    expect(s.stopDetail).toContain("crash recovery: no open PR (PLAN phase)");
    expect(s.stopDetail).toContain("ticket reverted to Todo");
    expect(s.stopDetail).toContain("<no worktree>");
    expect(s.stopDetail).toContain("looppilot/ty-8-x");
    expect(s.stopDetail).toContain("TY-8");
    // worktreePath が null なので discardWorktree は呼ばれない
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(false);
    // チケットは Todo へ戻される
    expect(h.source.transitions).toContainEqual({ issueId: "issue-H", state: "todo" });
  });

  it("claimed + no PR + transition(todo) fails → detail says revert FAILED (Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed" },
      { branch: "looppilot/ty-9c-x", worktreePath: "/wt/ty-9c", linearIssueId: "issue-9C", linearIdentifier: "TY-9C" },
    );
    h.source.failNext("transition", new Error("Linear 5xx"));

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("ticket revert to Todo FAILED");
    expect(s.stopDetail).toContain("may be stuck In Progress");
    expect(s.stopDetail).toContain("TY-9C");
    // Worktree was still discarded (best-effort, before transition)
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(true);
  });

  // findOpenPrForBranch が throw（gh 一時障害）→ Fatal 落ち・無通知ではなく
  // stopped(exception)+HALT+通知で人間に上げる（回復経路でも「失敗は HALT で surface」）。
  it("handing_off で findOpenPrForBranch が throw → run() は throw せず stopped(exception)+HALT+通知", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "handing_off", monitorStartedAt: null },
      { branch: "looppilot/ty-11-x", worktreePath: "/wt/ty-11", linearIssueId: "issue-K", linearIdentifier: "TY-11" },
    );
    h.git.failNext("findOpenPrForBranch", new Error("gh pr list failed: API rate limit"));

    // run() は Fatal 経路へ伝播せず正常終了する
    await expect(h.orch.run()).resolves.toBe("finished");

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("API rate limit");
    expect(newRun.state).toBe("halted");
    // ループに入らない・通知される
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
  });
});

describe("回復 — implementing + no PR: commit-aware cleanup (Finding 3)", () => {
  it("implementing + no PR + no commits → discard worktree + ticket reverted to Todo + HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing" },
      { branch: "looppilot/ty-rl-x", worktreePath: "/wt/ty-rl", linearIssueId: "issue-RL", linearIdentifier: "TY-RL" },
    );
    // Explicitly mark no committed work (e.g. SIGINT during rate-limit sleep before first commit)
    h.git.commitsWithDiff.set("/wt/ty-rl", false);

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("ticket reverted to Todo");
    expect(s.stopDetail).toContain("looppilot/ty-rl-x");
    expect(s.stopDetail).toContain("TY-RL");
    expect(s.runId).toBe(newRun.id);
    // Worktree discarded and ticket reverted
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(true);
    expect(h.source.transitions).toContainEqual({ issueId: "issue-RL", state: "todo" });
    // HALT — loop not entered
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });

  it("implementing + no PR + clean commits + selfReview.enabled → halts (ES-473 Finding 1)", async () => {
    // When selfReview is enabled, recovery cannot run the gate because the ticket
    // description is unavailable. Proceeding to HANDOFF would bypass the required
    // self-review. The safe action is to halt for human review.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing" },
      { branch: "looppilot/ty-wk-x", worktreePath: "/wt/ty-wk", linearIssueId: "issue-WK", linearIdentifier: "TY-WK" },
    );
    // Agent committed clean work but orchestrator crashed before handoff
    h.git.commitsWithDiff.set("/wt/ty-wk", true);

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // Recovery must halt — self-review cannot run without ticket context
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("self-review required");
    expect(s.stopDetail).toContain("ticket description unavailable");
    expect(s.stopDetail).toContain("TY-WK");
    expect(h.logs.some((l) => l.includes("recovery") && l.includes("halting"))).toBe(true);
    expect(newRun.state).toBe("halted");
    // Committed work must NOT be destroyed (leave it for human recovery)
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(false);
    expect(h.source.transitions.some((t) => t.state === "todo")).toBe(false);
    // HANDOFF must not be attempted
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("implementing + no PR + clean commits + selfReview.disabled → skips self-review, resumes HANDOFF (ES-473 Finding 1)", async () => {
    // When selfReview is disabled, recovery can safely proceed to HANDOFF.
    const config = makeConfig({ maxTasksPerRun: 3 });
    (config as { selfReview: { enabled: boolean } }).selfReview.enabled = false;
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing" },
      { branch: "looppilot/ty-wk2-x", worktreePath: "/wt/ty-wk2", linearIssueId: "issue-WK2", linearIdentifier: "TY-WK2" },
    );
    h.git.commitsWithDiff.set("/wt/ty-wk2", true);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).not.toBeNull();
    // Committed work must NOT be destroyed
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(false);
    expect(h.source.transitions.some((t) => t.state === "todo")).toBe(false);
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("implementing + no PR + no commits + transition(todo) fails → detail says revert FAILED (Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing" },
      { branch: "looppilot/ty-rf-x", worktreePath: "/wt/ty-rf", linearIssueId: "issue-RF", linearIdentifier: "TY-RF" },
    );
    h.git.commitsWithDiff.set("/wt/ty-rf", false);
    // Make the Todo transition fail
    h.source.failNext("transition", new Error("Linear 5xx"));

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("ticket revert to Todo FAILED");
    expect(s.stopDetail).toContain("may be stuck In Progress");
    expect(s.stopDetail).toContain("TY-RF");
    // Worktree was still discarded (best-effort, before transition)
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(true);
  });

  it("implementing + no PR + dirty worktree (uncommitted edits) → manual cleanup, not discarded (Finding 4)", async () => {
    // Scenario: SIGINT fires during the rate-limit sleep after Claude has edited files
    // but before the final commit.  hasCommitsWithDiff returns false, but the worktree
    // is dirty.  The recovery path must treat dirty files as work and fall through to
    // manual cleanup rather than destroying the partial implementation.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing" },
      { branch: "looppilot/ty-dt-x", worktreePath: "/wt/ty-dt", linearIssueId: "issue-DT", linearIdentifier: "TY-DT" },
    );
    h.git.commitsWithDiff.set("/wt/ty-dt", false);  // no committed work yet
    h.git.uncommitted.set("/wt/ty-dt", true);        // but there are edited files

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("manual cleanup");
    expect(s.stopDetail).toContain("looppilot/ty-dt-x");
    expect(s.stopDetail).toContain("TY-DT");
    // Dirty worktree must NOT be discarded; partial edits must survive
    expect(h.git.calls.some((c) => c.method === "discardWorktree")).toBe(false);
    expect(h.source.transitions.some((t) => t.state === "todo")).toBe(false);
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("回復 — 孤児チケット（In Progress だがセッション行なし → Todo 復帰・ベストエフォート）（仕様 §9 / カーネル §8）", () => {
  it("findOrphanedInProgress が 2 件返す → 各々 transition(todo) + 警告ログ。HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 活性セッションは無し（孤児だけ）→ 回復は孤児復帰のみ。
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 回復後ループは 1 回の SELECT で停止させる
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
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
    // 孤児復帰は HALT しない → ループに入った（getAllEligible が呼ばれている）
    // 注: requestStop() → haltForInterrupt() により run.state は halted になるが、
    // これは recovery の HALT ではなく user_interrupt による正常終了である。
    // recovery が HALT していないことは eligibleCalls >= 1（ループに入った）で確認する。
    expect(h.source.eligibleCalls).toHaveLength(1);
    // 通知列には run_started が含まれる（recovery-HALT なら run_started のみ + halted(from recovery)）
    expect(h.notifier.events.some((e) => e.kind === "run_started")).toBe(true);
  });

  it("transition(todo) が throw してもベストエフォート（HALT せず警告ログ）で次の孤児へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 最初の transition(todo) で 1 回だけ throw（FakeTaskSource.failNext は次の1回だけ throw）
    h.source.failNext("transition", new Error("Linear 5xx"));
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // 1 件目の transition は throw（記録されない）、2 件目は成功して記録される
    expect(h.source.transitions).toEqual([{ issueId: "issue-O2", state: "todo" }]);
    // ベストエフォートなので recovery は HALT していない → ループに入った
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("findOrphanedInProgress 自体が throw しても回復は HALT せず警告のみで継続する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.failNext("findOrphanedInProgress", new Error("Linear query failed"));
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    expect(h.logs.some((l) => l.includes("warning") && l.includes("findOrphanedInProgress failed"))).toBe(true);
    // findOrphanedInProgress の throw は recovery HALT しない → ループに入った
    expect(h.source.eligibleCalls).toHaveLength(1);
  });
});

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
    // 上限到達でループ先頭 HALT（SELECT に進まない → getAllEligible は呼ばれない）
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

describe("回復 — updateSession({runId}) による再ペアレント確認（Task 5 carry-over）", () => {
  it("再ペアレントで countTasksStarted が旧 Run から新 Run へ移行し monitorStartedAt は保持される", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:15:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 200,
      monitorStartedAt: originalStart,
    });
    // 旧 Run の countTasksStarted を確認（セッション 1 件が旧 Run に属している）
    const oldRunId = crashed.runId;
    expect(h.store.countTasksStarted(oldRunId)).toBe(1);

    // 回復: poll=merged → runId を新 Run へ付替え
    h.monitor.verdicts = [{ kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const adopted = h.store.getSession(crashed.id);

    // 旧 Run の countTasksStarted は 0 に減少（セッションが新 Run へ移動）
    expect(h.store.countTasksStarted(oldRunId)).toBe(0);
    // 新 Run の countTasksStarted は 1 に増加
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // monitorStartedAt は再ペアレント後も保持されている（上書きされない）
    expect(adopted.monitorStartedAt).toBe(originalStart);
  });
});

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
    // 回復で HALT したらループに入らないことを assertion で保証する。
    // カットオフが退行した場合、ここで requestStop() せず [] を返し続けると CI がハングするため、
    // getAllEligible を hook して requestStop() + [] を返す（ハング→アサーション失敗に変換）。
    // 正常動作では回復 HALT → ループに入らない → このフックは呼ばれず eligibleCalls.length===0。
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      h.orch.requestStop();
      return [];
    };

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
    // 回復で HALT → ループに入らない（cutoff 退行なら getAllEligible が呼ばれ eligibleCalls.length>0 になる）
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});

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
    // 回復後ループで getAllEligible は [] → IDLE → だが taskCap=3 未到達で sleep ループに入る。
    // それを避けるため回復完了直後にループへ入らせない: queue 空 + idle を 1 回で抜けられないので、
    // ここでは「回復処理単体の効果」を検証するため、回復後ループに入る前提で merged を確認する。
    // ループ無限化を防ぐため getAllEligible を 1 回 [] 後に requestStop で抜ける。
    let getCalls = 0;
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      getCalls += 1;
      h.orch.requestStop(); // 回復後ループの最初の安全点で停止
      return origGetAllEligible(excludeIds);
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

describe("MONITOR — workflow_failed verdict (ES-397)", () => {
  it("workflow_failed → restarted(cost>0) → costUsd updated, polling continues to merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const iss = issue("id-wf", "TY-WF1");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
      { kind: "merged" },
    ];
    h.recovery.outcomes = [{ kind: "restarted", costUsd: 0.5, newFix: true }];

    await h.orch.run();

    expect(h.recovery.recoveryCalls).toHaveLength(1);
    expect(h.recovery.recoveryCalls[0].errorBody).toBe("⚠️ failed");
    const session = h.store.getSession(1);
    expect(session.costUsd).toBe(1.5);
    expect(session.state).toBe("merged");
  });

  it("workflow_failed → exhausted → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf2", "TY-WF2");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 3, hasStateComment: false },
    ];
    h.recovery.outcomes = [{ kind: "exhausted", costUsd: 1.0 }];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("exhausted");
  });

  it("workflow_failed → unrecoverable → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf3", "TY-WF3");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ err", errorCommentCount: 1, hasStateComment: false },
    ];
    h.recovery.outcomes = [{ kind: "unrecoverable", costUsd: 0.1, message: "agent crashed" }];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("agent crashed");
  });

  it("recovery throws → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf4", "TY-WF4");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ err", errorCommentCount: 1, hasStateComment: false },
    ];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("workflow recovery error");
  });

  // Finding 2: a fix-agent run that legitimately reports costUsd:0 must still count as a
  // completed attempt (increment workflowFixAttempts / record handled count), keyed on
  // `newFix` rather than cost > 0.
  it("workflow_failed → restarted(newFix, cost=0) → attempt counters still advance", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const iss = issue("id-wfz", "TY-WFZ");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
      { kind: "merged" },
    ];
    h.recovery.outcomes = [{ kind: "restarted", costUsd: 0, newFix: true }];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("merged");
    // Counters advanced even though the fix run cost $0 (Finding 2).
    expect(session.workflowFixAttempts).toBe(1);
    expect(session.workflowHandledErrorCount).toBe(1);
    // Only the implementation cost was added; the zero-cost fix added nothing.
    expect(session.costUsd).toBe(1.0);
  });

  // Finding 3: after a handled failure, the stale ⚠️ comment keeps poll() returning
  // workflow_failed even once the looppilot-state moved to fixing/waiting_codex. A live
  // (hasStateComment) restarted review must NOT be killed by the not-engaged guard.
  // The first verdict is consumed by crash-recovery adoption; the second drives the
  // pending-restart branch inside monitorSession.
  it("workflow_failed pending restart with live state comment → guard does not stop the review", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorTimeoutMinutes: 99999 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z", // elapsed >> notEngagedGuardMinutes (30)
    });
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: true },
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: true },
      { kind: "merged" },
    ];
    h.recovery.outcomes = [{ kind: "restarted", costUsd: 0, newFix: false }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged"); // guard skipped because a live state comment is present
    expect(s.failureReason).toBeNull();
  });

  // Finding 2 (review): after a new fix is pushed (`newFix: true`), the engagement
  // timer must reset — otherwise a crash-recovery / slow-failure session whose
  // original monitorStartedAt is already past notEngagedGuardMinutes would be
  // killed on the very next poll before the restarted workflow has any chance to
  // advance the state comment.
  it("workflow_failed → restarted(newFix) resets monitorStartedAt so guard does not fire next poll", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      // Old start: elapsed >> notEngagedGuardMinutes. If we don't reset on newFix,
      // the *very next poll* in the pending-restart branch kills the session.
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [
      // Poll 1 (adoption + first MONITOR iteration): a new fix is required.
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
      // Poll 2 (after fix pushed, restart pending — state hasn't advanced yet):
      // hasStateComment is false because the workflow hasn't picked up the restart.
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
      // Poll 3: workflow finished re-review and merged.
      { kind: "merged" },
    ];
    h.recovery.outcomes = [
      { kind: "restarted", costUsd: 0.2, newFix: true },  // first call: new fix pushed
      { kind: "restarted", costUsd: 0, newFix: false },   // second call: handled count matches → pending
    ];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    // Without the Finding 2 reset, the pending-restart guard would fire at poll 2
    // (elapsed since the original start >> 30 min) and stopSession with
    // monitor_never_engaged before the workflow finished. With the reset, the
    // session reaches merged.
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    // monitorStartedAt is now anchored to the recovery clock (well after the
    // original 2026-06-04 timestamp).
    expect(s.monitorStartedAt!.startsWith("2026-06-05")).toBe(true);
  });

  // Counterpart to Finding 3: when the restart never engaged (no state comment), the
  // always-on not-engaged guard still backstops indefinite polling.
  it("workflow_failed pending restart without state comment → not-engaged guard stops it", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorTimeoutMinutes: 99999 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z", // elapsed >> notEngagedGuardMinutes (30)
    });
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1, hasStateComment: false },
    ];
    h.recovery.outcomes = [{ kind: "restarted", costUsd: 0, newFix: false }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
  });
});

describe("回復 — stopped(looppilot_stopped) + PR ありのセッション回復（ES-411）", () => {
  it("LoopPilot が in_progress（waiting_codex）→ 採用して MONITOR 再開、merged まで完走", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:10:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: originalStart,
      autoRestartAttempts: 2,
      quotaRetryAttempts: 3,
      pendingRestartReason: "workflow_crashed",
      workflowFixAttempts: 1,
      workflowHandledErrorCount: 1,
    });
    // poll 1 (recovery): in_progress → adopt
    // poll 2 (monitorSession): done → merge
    // poll 3 (monitorSession): merged → CONTINUE
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(newRun.id);
    // monitorStartedAt is refreshed at adoption to start a fresh monitoring window
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);
    expect(s.monitorStartedAt).not.toBe(originalStart);
    // Adoption-reset fields cleared
    expect(s.failureReason).toBeNull();
    expect(s.stopDetail).toBeNull();
    expect(s.endedAt).not.toBeNull(); // re-set by done()
    expect(s.autoRestartAttempts).toBe(0);
    expect(s.quotaRetryAttempts).toBe(0);
    expect(s.pendingRestartReason).toBeNull();
    // Workflow recovery counters are preserved across recovery (Finding 2)
    expect(s.workflowFixAttempts).toBe(1);
    expect(s.workflowHandledErrorCount).toBe(1);
    // DONE 後段
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
  });

  it("LoopPilot がまだ stopped → スキップし、ループに入る（SELECT → idle）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // LoopPilot is still stopped
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "human_required" }];
    // Loop enters SELECT → idle → requestStop
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Session unchanged (still stopped) — not adopted into new run
    const s = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(s).toHaveLength(0);
    // Loop was entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("PR がクローズ済み（pr_closed verdict）→ スキップ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "pr_closed" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Session not adopted — skipped
    const s = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(s).toHaveLength(0);
    // Loop was entered
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("PR がマージ済み（merged verdict）→ recoverDone → merged 永続化 + transition(done)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
      autoRestartAttempts: 1,
      quotaRetryAttempts: 2,
      workflowFixAttempts: 2,
      workflowHandledErrorCount: 3,
    });
    h.monitor.verdicts = [{ kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(newRun.id);
    // Adoption-reset fields cleared
    expect(s.failureReason).toBeNull();
    expect(s.stopDetail).toBeNull();
    expect(s.autoRestartAttempts).toBe(0);
    expect(s.quotaRetryAttempts).toBe(0);
    expect(s.pendingRestartReason).toBeNull();
    // Workflow recovery counters are preserved across recovery (Finding 2)
    expect(s.workflowFixAttempts).toBe(2);
    expect(s.workflowHandledErrorCount).toBe(3);
    // DONE 後段
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    expect(h.store.countMerged(newRun.id)).toBe(1);
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // Loop entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("OS 起因の停止（cost_exceeded）→ stoppedSessionsWithPr に含まれず回復対象外", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "cost_exceeded",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // monitor.poll was never called (session not queried)
    expect(h.monitor.pollCalls).toHaveLength(0);
    // Loop was entered
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("stopped + looppilot_stopped + prNumber=null → 回復対象外", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      // prNumber not set (null)
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // monitor.poll was never called
    expect(h.monitor.pollCalls).toHaveLength(0);
    // Loop was entered
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("採用セッションが taskCap にカウントされ、ループ先頭で cap 到達 → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Q", "TY-99")];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // taskCap=1 reached → HALT at loop start, TY-99 not started
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).toContain("task cap reached");
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-99"]);
  });

  it("poll が throw → 採用して MONITOR 再開、monitorSession に委ねる", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // First poll throws (recovery), second returns merged (monitorSession)
    h.monitor.verdicts = [{ kind: "merged" }];
    const origPoll = h.monitor.poll.bind(h.monitor);
    let thrown = false;
    h.monitor.poll = async (pr: number) => {
      if (!thrown) {
        thrown = true;
        throw new Error("API 502");
      }
      return origPoll(pr);
    };
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(h.store.latestRun()!.id);
    expect(s.failureReason).toBeNull();
    // Log contains recovery message
    expect(h.logs.some((l) => l.includes("recovery: poll threw for stopped session"))).toBe(true);
  });

  it("no_findings（review_done）→ resetAndAdopt + adoptAndMonitor → monitorSession が tryMerge → merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // poll 1 (recovery): no_findings → adopt
    // poll 2 (monitorSession): no_findings → tryMerge → merged (checkMergeReadiness default ready)
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "no_findings" },
      { kind: "stopped", stopReason: "no_findings" },
    ];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(h.store.latestRun()!.id);
    // tryMerge called during monitorSession
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(true);
    // monitorStartedAt refreshed at adoption
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);
    expect(s.monitorStartedAt).not.toBe("2026-06-04T00:10:00.000Z");
    // DONE 後段
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
  });

  it("auto_restart (workflow_crashed) → resetAndAdopt + adoptAndMonitor → monitorSession が postComment → merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "human_required",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // poll 1 (recovery): workflow_crashed → adopt
    // poll 2 (monitorSession): workflow_crashed → postComment(/restart-review)
    // poll 3 (monitorSession): merged
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },
      { kind: "stopped", stopReason: "workflow_crashed" },
      { kind: "merged" },
    ];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    // postComment was called by monitorSession's auto_restart handler
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(true);
  });

  it("auto-restart limit exhausted → PR still shows workflow_crashed → session stays stopped, loop enters", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      // stopDetail written by monitorSession when autoRestartCount > 3
      stopDetail: "auto-restart limit exceeded (4x): workflow_crashed",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
      autoRestartAttempts: 3,
    });
    // PR still shows the same stop reason that exhausted the counter
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "workflow_crashed" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Session must NOT be adopted — counters must stay intact
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.autoRestartAttempts).toBe(3);
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("auto-restart limit exceeded (4x): workflow_crashed");
    // No /restart-review posted, no PR adoption
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
    // Loop was entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
    // Log contains skip message
    expect(h.logs.some((l) => l.includes("skipping exhausted stopped session"))).toBe(true);
  });

  it("auto-restart limit exhausted + poll が throw → 採用せず stopped のまま（Finding 1）", async () => {
    // Regression: a transient poll error in the catch path bypassed the exhaustion guard
    // (which only fires inside the switch on a successful verdict), causing resetAndAdopt()
    // to clear stopDetail/autoRestartAttempts and revive a terminal session.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      stopDetail: "auto-restart limit exceeded (4x): workflow_crashed",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
      autoRestartAttempts: 3,
    });
    // Poll throws a transient error — no verdict is available
    h.monitor.poll = async () => {
      throw new Error("API 502");
    };
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Session must NOT be adopted — terminal HALT must be preserved
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.stopDetail).toBe("auto-restart limit exceeded (4x): workflow_crashed");
    expect(s.autoRestartAttempts).toBe(3);
    // No /restart-review posted, no PR adoption
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
    // Loop was entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
    // Log contains skip message
    expect(h.logs.some((l) => l.includes("skipping exhausted stopped session"))).toBe(true);
  });

  it("auto-restart limit exhausted for reason A, PR now shows reason B → session recovered with fresh counter", async () => {
    // Regression: the prefix-only check ("auto-restart limit exceeded") fired even when the
    // current stop reason differed from the one that exhausted the counter, silently skipping
    // recovery for a new failure type. The fix compares the embedded reason in stopDetail
    // against the current verdict.stopReason before suppressing recovery.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      // Exhausted for workflow_crashed
      stopDetail: "auto-restart limit exceeded (4x): workflow_crashed",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
      autoRestartAttempts: 3,
    });
    // PR now shows a DIFFERENT auto-restart reason (test_failure)
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "test_failure" }, // poll 1 (recovery): adopt
      { kind: "stopped", stopReason: "test_failure" }, // poll 2 (monitorSession): postComment
      { kind: "merged" },                               // poll 3 (monitorSession): done
    ];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    // Session MUST be adopted and recovered, not skipped
    expect(s.state).toBe("merged");
    // autoRestartAttempts was reset to 0 at adoption, then incremented to 1 for test_failure
    expect(s.autoRestartAttempts).toBe(1);
    // /restart-review was posted for the new reason
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(true);
    // Loop was entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
    // Skip log must NOT be present (it was not skipped)
    expect(h.logs.some((l) => l.includes("skipping exhausted stopped session"))).toBe(false);
  });

  it("quota retry limit exhausted → PR still shows codex_usage_limit → session stays stopped, loop enters", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      // stopDetail written by monitorSession when quotaRetryCount > 6
      stopDetail: "quota retry limit exceeded (7x): codex_usage_limit",
      endedAt: "2026-06-04T01:00:00.000Z",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // PR still shows the quota-exhausted stop reason
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex_usage_limit" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Session must NOT be adopted
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("quota retry limit exceeded (7x): codex_usage_limit");
    // No /restart-review posted
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
    // Loop was entered (recovery did not HALT)
    expect(h.source.eligibleCalls).toHaveLength(1);
    // Log contains skip message
    expect(h.logs.some((l) => l.includes("skipping exhausted stopped session"))).toBe(true);
  });

  it("superseded stopped session (newer session for same issue exists) → not recovered", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Old stopped session for issue-A
    const oldRun = h.store.createRun(3, "2026-06-03T00:00:00.000Z");
    const oldSession = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Old attempt",
      branch: "looppilot/ty-1-old",
      worktreePath: "/wt/ty-1-old",
      now: "2026-06-03T00:00:01.000Z",
    });
    h.store.updateSession(oldSession.id, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      prNumber: 100,
      endedAt: "2026-06-03T01:00:00.000Z",
    });
    // Newer session for the same issue (in_review) — supersedes the old stopped session
    const newSession = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Retry attempt",
      branch: "looppilot/ty-1-retry",
      worktreePath: "/wt/ty-1-retry",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(newSession.id, { state: "in_review", prNumber: 200 });
    // The in_review session will be processed by activeSessions recovery; configure its poll
    h.monitor.verdicts = [{ kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Old stopped session was NOT adopted (not in stoppedSessionsWithPr because superseded)
    const old = h.store.getSession(oldSession.id);
    expect(old.state).toBe("stopped"); // unchanged
    expect(old.runId).toBe(oldRun.id); // not re-parented
  });
});

describe("done() transition(done) pending recovery (ES-462)", () => {
  it("done() sets doneTransitionPending=1 before transition and clears to 0 on success", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // poll → merged → done() path
    h.monitor.verdicts = [{ kind: "merged" }];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.doneTransitionPending).toBe(0);
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
  });

  it("done() leaves doneTransitionPending=1 when transition(done) fails and logs retry message", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "merged" }];
    // Make transition(done) always fail — failNext only fails once,
    // but retry(3) calls it 3 times. We need all 3 to fail.
    // Override transition to throw for "done" state specifically.
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (issueId: string, state: TicketState) => {
      if (state === "done") throw new Error("Linear API timeout");
      return origTransition(issueId, state);
    };
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.doneTransitionPending).toBe(1);
    expect(h.logs.some((l) => l.includes("will retry on next startup"))).toBe(true);
  });

  it("recoverPendingSessions retries transition(done) for merged sessions with pending flag", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);

    // Seed a merged session with doneTransitionPending=1 (simulating previous failed transition)
    const oldRun = h.store.createRun(3, "2026-06-04T00:00:00.000Z");
    const s = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Done but stuck",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(s.id, {
      state: "merged",
      endedAt: "2026-06-04T01:00:00.000Z",
      doneTransitionPending: 1,
    });

    // No eligible issues — just run recovery and idle
    h.source.queue = [];
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // transition(done) should have been called
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // Flag should be cleared
    const updated = h.store.getSession(s.id);
    expect(updated.doneTransitionPending).toBe(0);
    // Log should confirm recovery
    expect(h.logs.some((l) => l.includes("recovered:") && l.includes("TY-1") && l.includes("Done"))).toBe(true);
  });

  it("recoverPendingSessions leaves flag=1 and logs warning when retry also fails", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);

    // Seed a merged session with doneTransitionPending=1
    const oldRun = h.store.createRun(3, "2026-06-04T00:00:00.000Z");
    const s = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Done but stuck",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(s.id, {
      state: "merged",
      endedAt: "2026-06-04T01:00:00.000Z",
      doneTransitionPending: 1,
    });

    // Make transition always fail
    h.source.transition = async () => {
      throw new Error("Linear still down");
    };
    h.source.queue = [];
    h.source.getAllEligible = async (_excludeIds: string[]) => {
      h.orch.requestStop();
      return [];
    };

    await h.orch.run();

    // Flag should remain 1
    const updated = h.store.getSession(s.id);
    expect(updated.doneTransitionPending).toBe(1);
    // Warning log present
    expect(h.logs.some((l) => l.includes("recovery transition(done) still failing") && l.includes("TY-1"))).toBe(true);
  });
});
