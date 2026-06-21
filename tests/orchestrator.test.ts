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
  FakePlanRunner,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, PlanRunner, PauseMeta } from "../src/types.js";

// ---- テストヘルパ ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number | undefined;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
  notifyProgress: boolean;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product", specDir: undefined },
    digest: { recentMergedCount: over.recentMergedCount ?? 5, enabled: true },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes,
      sessionHardTimeoutMinutes: 120,
      maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2,
      codexTimeoutMinutes: 30,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
    notify: { progress: over.notifyProgress ?? false },
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
  sleepCalls: number[];
  logs: string[];
  promptArgs: PromptArgs[];
}

function makeHarness(config: Config, opts?: { planner?: PlanRunner | null }): Harness {
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
    planner: opts?.planner ?? null,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs };
}

describe("Orchestrator 正常系 — 1チケット完走（仕様 §5 SELECT→CLAIM→IMPLEMENT→HANDOFF→MONITOR→DONE）", () => {
  it("単一チケットを選定→worktree→実装→PR→ラベル→監視→マージし、状態が merged になる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.5, summary: "did the work" }];
    // poll: done を返し → checkMergeReadiness(ready) → mergePr → 次 poll で merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // 仕様 §7: 完走後の終端状態は merged
    expect(s.state).toBe("merged");
    expect(s.linearIdentifier).toBe("TY-1");
    expect(s.prNumber).toBe(100);
    expect(s.costUsd).toBe(1.5);
    expect(s.agentSummary).toBe("did the work");
    expect(s.endedAt).not.toBeNull();
    // 仕様 §5.4: in_review 入り時刻が記録される
    expect(s.monitorStartedAt).not.toBeNull();
    // merge が呼ばれた
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(true);
  });
});

describe("Orchestrator 正常系 — 2チケット逐次（仕様 §3 逐次・§5 ループ）", () => {
  it("2件を順に完走し、両方 merged・状態遷移の順序が記録される", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A done" },
      { kind: "completed", costUsd: 2, summary: "B done" },
    ];
    // 各セッション: done → merged
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.linearIdentifier)).toEqual(["TY-1", "TY-2"]);
    expect(sessions.every((s) => s.state === "merged")).toBe(true);
    expect(h.store.countMerged(runId)).toBe(2);

    // Linear への遷移列（仕様 §5）: 各チケット in_progress → in_review → done
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
      { issueId: "issue-B", state: "in_progress" },
      { issueId: "issue-B", state: "in_review" },
      { issueId: "issue-B", state: "done" },
    ]);

    // 2件目の SELECT 時、1件目はもう active ではない（merged）→ excludeIds は空のまま
    // （冪等性: 進行中セッションだけ除外。merged は除外対象外）
    expect(h.source.eligibleCalls.length).toBe(2); // A選定 / B選定（3反復目は taskCap 到達で SELECT 前に HALT）
  });
});

describe("Orchestrator 正常系 — フェーズ順序（仕様 §5 状態機械の呼び出し列）", () => {
  it("1チケットで claim→implement→handoff→monitor→done の外部呼び出しが正しい順序で起きる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Git/PR 呼び出しの順序（封筒の操作列）
    const gitMethods = h.git.calls.map((c) => c.method);
    expect(gitMethods).toEqual([
      "prepareWorktree",    // CLAIM
      "hasUncommittedChanges", // IMPLEMENT 後条件（先に残骸チェック）
      "hasCommitsWithDiff",    // IMPLEMENT 後条件（次に実差分チェック）
      "findOpenPrForBranch",   // HANDOFF（既存PR確認）
      "pushAndOpenPr",         // HANDOFF（新規PR）
      "addLabel",              // HANDOFF（ゲートラベル）
      "mergePr",               // DONE経路（done verdict→ready→merge）
    ]);

    // run_started 通知が最初に送られ、taskCap=1 到達で halted も送られる
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);

    // エージェントへ渡された prompt 引数（文脈バンドル）の検証
    expect(h.promptArgs).toHaveLength(1);
    expect(h.promptArgs[0].goal).toBe("ship the product");
    expect(h.promptArgs[0].issue.identifier).toBe("TY-1");
    expect(Array.isArray(h.promptArgs[0].digest)).toBe(true);

    // agent に渡された SessionContext
    expect(h.agent.contexts).toHaveLength(1);
    expect(h.agent.contexts[0].prompt).toBe("PROMPT for TY-1");
    expect(h.agent.contexts[0].maxCostUsd).toBe(10);
    expect(h.agent.contexts[0].worktreePath).toBe("/wt/ty-1");
  });
});

describe("Orchestrator 正常系 — 監視起点と Linear 遷移（仕様 §5.4 / §5.6）", () => {
  it("in_review 入りで monitorStartedAt が clock() の値で設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // fixedClock は呼ぶ度に +1s。monitorStartedAt は ISO 文字列で非 null。
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);

    // transition は in_progress → in_review → done の 3 回
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
    ]);
  });
});

describe("Orchestrator 正常系 — タスク上限 HALT（仕様 §11 / §5.1）", () => {
  it("taskCap=1 でキューに2件あっても1件だけ完走し、上限到達で HALT 通知して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    // 1件だけ着手・完走
    expect(h.store.countTasksStarted(run.id)).toBe(1);
    expect(h.store.countMerged(run.id)).toBe(1);
    // 2件目は未着手のままキューに残る
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-2"]);

    // Run は halted・理由は task cap
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap reached");

    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    const halted = h.notifier.events.find((e) => e.kind === "halted");
    expect(halted).toMatchObject({ kind: "halted", reason: "task_cap" });
  });
});

describe("Orchestrator 失敗系 — SELECT の Linear 例外（仕様 §5.1 / 安全弁: 全失敗は HALT+通知）", () => {
  // getNextEligible が throw（Linear 一時障害等）→ 無人ループを Fatal 落ちさせず、
  // CLAIM① と同様に Run=halted(exception)+notify(halted) で人間に上げる。
  it("getNextEligible が throw → run() は throw せず Run=halted(exception)・notify(halted) する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.source.failNext("getNextEligible", new Error("Linear HTTP 503"));

    // run() 自体が reject しない（main().catch の Fatal 経路に到達しない）こと
    await expect(h.orch.run()).resolves.toBe("finished");

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // haltReason は記述的 detail（select_failed 接頭辞 + 原因）。notify の reason が exception。
    expect(run.haltReason).toContain("select_failed");
    expect(run.haltReason).toContain("Linear HTTP 503");
    // セッションは作られない（SELECT 段の失敗）
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
    // 通知列: run_started → halted(exception)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
  });
});

describe("Orchestrator 正常系 — IDLE→復帰（仕様 §5.1 / §10）", () => {
  it("最初キュー空で IDLE 通知＋sleep、再確認で復帰して1件完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleRecheckSeconds: 300 });
    const h = makeHarness(config);

    // getNextEligible: 1回目 null（IDLE）、2回目以降は復帰した issue を返す
    let eligibleCall = 0;
    const recovered = issue("issue-A", "TY-1");
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall += 1;
      if (eligibleCall === 1) return null; // 初回 IDLE
      // 復帰後は1回だけ issue を流し、それ以降は queue 経由
      if (eligibleCall === 2) return recovered;
      return origGetNext(excludeIds);
    };

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    expect(h.store.countMerged(runId)).toBe(1);

    // IDLE 通知が初回のみ送られた（run_started → idle → halted(task_cap)）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "idle", "halted"]);

    // IDLE 中に idle_recheck_seconds*1000 で sleep した
    expect(h.sleepCalls).toContain(config.loop.idleRecheckSeconds * 1000);

    // 復帰後 Run は running を経て、最終的に halted（taskCap=1 到達）
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("Orchestrator 正常系 — 既存PR再利用（仕様 §5.4 二重PR禁止）", () => {
  it("findOpenPrForBranch が既存PR番号を返したら pushAndOpenPr を呼ばずそのPRで監視する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // prepareWorktree が返すブランチを固定し、その branch に既存PR #777 をセット
    const branch = "looppilot/ty-1-x";
    h.git.claimResults.set("TY-1", { branch, worktreePath: "/wt/ty-1" });
    h.git.openPrForBranch.set(branch, 777);

    await h.orch.run();

    // pushAndOpenPr は呼ばれない
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // 既存 PR 番号で永続化・ラベル付与・マージ
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.prNumber).toBe(777);
    expect(h.git.calls).toContainEqual({ method: "addLabel", args: [777, "loop-pilot"] });
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [777, "sha-777"] });
    expect(s.state).toBe("merged");
  });
});

describe("Orchestrator 失敗系 — CLAIM（仕様 §5.2 / カーネル §7.3）", () => {
  it("① prepareWorktree が throw → セッション行を作らず Run=halted(claim_failed) で停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.failNext("prepareWorktree", new Error("worktree add: already exists"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    // セッション行は 1 つも作られない（CLAIM ① はセッション行なしで HALT）
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
    expect(h.store.countTasksStarted(run.id)).toBe(0);
    // Run は halted・理由に claim_failed
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("claim_failed");
    expect(run.haltReason).toContain("TY-1");
    // transition は一切呼ばれない（in_progress すら）
    expect(h.source.transitions).toEqual([]);
    // 通知列: run_started → halted(claim_failed)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });

  it("② transition(in_progress) が throw → discardWorktree + stopped(claim_failed) + ticket→Todo 復帰 → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    // prepareWorktree は成功・branch/worktree を固定
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // transition の最初の呼び出し（in_progress）で throw
    h.source.failNext("transition", new Error("Linear 5xx"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // セッション行は作られている（createSession は transition より前）
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("claim_failed");
    expect(s.stopDetail).toContain("transition(in_progress) failed");
    expect(s.endedAt).not.toBeNull();
    // discardWorktree がベストエフォートで呼ばれた
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // ticket→Todo 復帰がベストエフォートで呼ばれた（in_progress は throw したので記録されない）
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "todo" }]);
    // Run=halted・通知列 run_started → halted(claim_failed)
    expect(run.state).toBe("halted");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });
});

describe("Orchestrator 失敗系 — IMPLEMENT（仕様 §5.3 / カーネル §7.4）", () => {
  it("agent_no_change【未コミット残骸】hasUncommittedChanges=true → stopped(agent_no_change, 'uncommitted leftovers')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 0.7, summary: "tried" }];
    // 残骸あり → hasCommitsWithDiff まで進まない
    h.git.uncommitted.set("/wt/ty-1", true);

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBe("uncommitted leftovers");
    // 仕様 §7: completed はまず cost と summary を永続化してから後条件を見る
    expect(s.costUsd).toBe(0.7);
    expect(s.agentSummary).toBe("tried");
    // hasUncommittedChanges を見たら true なので hasCommitsWithDiff は呼ばれない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // HANDOFF へ進んでいない
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("agent_no_change【無差分】hasUncommittedChanges=false ∧ hasCommitsWithDiff=false → stopped(agent_no_change, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.2, summary: "nothing useful" }];
    h.git.uncommitted.set("/wt/ty-1", false);
    h.git.commitsWithDiff.set("/wt/ty-1", false); // 実差分なし

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBeNull();
    expect(s.costUsd).toBe(1.2);
    expect(s.agentSummary).toBe("nothing useful");
    // 両後条件メソッドが呼ばれている（残骸→差分の順）
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).toContain("hasCommitsWithDiff");
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("cost_exceeded → updateSession(costUsd) → discardWorktree → stopped(cost_exceeded)。discard が後条件チェックより前に走り、後条件は走らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 5 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 5.0 }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(5.0);
    expect(s.endedAt).not.toBeNull();
    // discardWorktree が呼ばれた（部分作業破棄）
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // 後条件チェック（hasUncommittedChanges/hasCommitsWithDiff）は走らない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).not.toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // 通知列 run_started → halted(cost_exceeded)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
  });

  it("agent error outcome → updateSession(costUsd) → stopped(exception, stop_detail=message)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "error", costUsd: 0.3, message: "claude crashed: ENOSPC" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("claude crashed: ENOSPC");
    expect(s.costUsd).toBe(0.3);
  });

  it("agent.runSession 自体が throw → stopped(exception, stop_detail=エラーメッセージ)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    // outcomes を空にすると FakeAgentRunner.runSession が "no outcome queued" を throw する
    h.agent.outcomes = [];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("no outcome queued");
  });

  it("hasUncommittedChanges throws after completed outcome → stopped(exception) with cost, not daemon crash", async () => {
    // If git status fails after the agent completes (e.g. worktree disappeared or index
    // lock), the throw must be caught so the daemon can record stopSession(exception)
    // and send a halt notification, rather than crashing with the session stuck in
    // "implementing".
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "done" }];
    h.git.failNext("hasUncommittedChanges", new Error("git status failed: index lock"));

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("git status failed");
    expect(s.costUsd).toBe(0.5);
  });

  it("agent interrupted outcome → haltForInterrupt (session stays in implementing, run halts as user_interrupt)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "interrupted", costUsd: 0.5 }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // Session must NOT be marked stopped(exception) — it stays in implementing so
    // a process restart can recover it via recoverByOpenPr.
    expect(sessions[0]?.state).toBe("implementing");
    expect(sessions[0]?.failureReason).toBeNull();
    // Cost is recorded before halting.
    expect(sessions[0]?.costUsd).toBeCloseTo(0.5);
    // Run halts cleanly as user_interrupt, not exception.
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });
});

describe("Orchestrator 失敗系 — spec loading failure undoes claim", () => {
  it("spec loading failure discards worktree and transitions issue back to todo", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    (config.product as { goal: string | undefined; specDir: string | undefined }).specDir = "docs/specs";
    (config.product as { goal: string | undefined; specDir: string | undefined }).goal = undefined;
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const agent = new FakeAgentRunner();
    const git = new FakeGitPr();
    const monitor = new FakeMonitor();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const promptArgs: PromptArgs[] = [];
    const buildPrompt = (args: PromptArgs): string => {
      promptArgs.push(args);
      return `PROMPT for ${args.issue.identifier}`;
    };
    const recovery = new FakeWorkflowRecovery();
    const orch = new Orchestrator({
      config,
      source,
      agent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt,
      specLoader: () => { throw new Error("requirements.md not found"); },
      clock: fixedClock("2026-06-05T00:00:00.000Z"),
      sleep: instantSleep(),
      log: (line: string) => { logs.push(line); },
      recovery,
      planner: null,
    });
    source.queue = [issue("issue-A", "TY-1")];
    git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });

    await orch.run();

    const s = store.sessionsForRun(store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("spec loading failed");
    expect(git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    expect(source.transitions).toContainEqual({ issueId: "issue-A", state: "todo" });
  });
});

describe("Orchestrator 失敗系 — HANDOFF（仕様 §5.4 / カーネル §7.5）", () => {
  it("addLabel が 3 連続 throw → stopped(handoff_failed)。PR は作成済みなので stop_detail に PR 番号を明記する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // pushAndOpenPr は #100 を返す。addLabel をずっと失敗させる（retry 3 回）
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    let addLabelCalls = 0;
    h.git.addLabel = async (prNumber: number, label: string) => {
      addLabelCalls += 1;
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      throw new Error("gh: label not found");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // PR 番号は即時永続化されている
    expect(s.prNumber).toBe(100);
    // stop_detail に PR #100 が明記される（仕様: 作成済みPRを通知に明記）
    expect(s.stopDetail).toContain("PR #100");
    // addLabel は retry で 3 回呼ばれた
    expect(addLabelCalls).toBe(3);
    // transition(in_review) は addLabel が先に死ぬので呼ばれていない
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "in_progress" }]);
    // 通知列 run_started → halted(handoff_failed)
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "handoff_failed" });
  });

  it("pushAndOpenPr 自体が throw → PR 未作成なので stop_detail は 'no PR created'", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.failNext("pushAndOpenPr", new Error("git push rejected"));

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    expect(s.prNumber).toBeNull();
    expect(s.stopDetail).toContain("no PR created");
  });
});

describe("Orchestrator 失敗系 — MONITOR verdict 写像（仕様 §5.5 / §5.4 / カーネル §7.6）", () => {
  it("stopped(stopReason='codex gave up') → stopped(looppilot_stopped, stop_detail=stopReason)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
  });

  it("stopped(stopReason=null) → stopped(looppilot_stopped, stop_detail='looppilot stopped (no reason)')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.failureReason).toBe("looppilot_stopped");
    // null はそのまま保持せず既定文言へ（カーネル §7.6）
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });

  it("pr_closed → stopped(pr_closed, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.stopDetail).toBeNull();
  });

  it("corrupted → 即 stopped(monitor_never_engaged)。ガード経過を待たない（1 回目 poll で停止）", async () => {
    // ガードを 999 分にしても即停止することで「ガードを待たない」ことを確かめる
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // poll は 1 回だけ（即停止）
    expect(h.monitor.pollCalls).toHaveLength(1);
  });
});

describe("Orchestrator MONITOR — stopReason 自動対処（ES-409）", () => {
  it("auto_restart (workflow_crashed) → postComment('/restart-review') して続行し、最終的に merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.git.calls).toContainEqual({
      method: "postComment",
      args: [100, "/restart-review"],
    });
    // auto_restart 投稿時の Slack 通知は不要
    const haltEvents = h.notifier.events.filter(
      (e) => e.kind === "halted" && (e as { reason: string }).reason === "looppilot_stopped",
    );
    expect(haltEvents).toHaveLength(0);
  });

  it.each([
    "workflow_crashed",
    "action_timeout",
    "state_conflict",
    "max_turns_exceeded",
    "test_failure",
  ])("auto_restart (%s) → postComment + polling 続行", async (reason) => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: reason },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(true);
  });

  it("auto_restart 3回超 → HALT + Slack 通知", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // 4 consecutive auto_restart stopReasons (exceeds limit of 3)
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },
      { kind: "stopped", stopReason: "action_timeout" },
      { kind: "stopped", stopReason: "max_turns_exceeded" },
      { kind: "stopped", stopReason: "test_failure" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toContain("auto-restart limit");
    // postComment は 3 回呼ばれた（4回目は上限超過で HALT）
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(3);
    // HALT 通知が送られた
    const haltEvents = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("state_conflict → 30 秒 sleep を挟んでから postComment", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "state_conflict" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    // 30 秒 sleep が挟まれている
    expect(h.sleepCalls).toContain(30_000);
    expect(h.git.calls).toContainEqual({
      method: "postComment",
      args: [100, "/restart-review"],
    });
  });

  it("no_findings → done と同等にマージ試行", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "no_findings" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(true);
    // postComment は呼ばれない（auto_restart ではない）
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
  });

  it("no_findings + ci_failed → stopped(ci_failed)（tryMerge の既存挙動を維持）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "no_findings" }];
    h.monitor.readiness.set(100, { ready: false, reason: "ci_failed" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
  });

  it("human_required (loop_detected) → 既存 HALT 動作", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "loop_detected" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("loop_detected");
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
  });

  it("quota_wait (codex_usage_limit) → 1時間待機 → /restart-review 投稿して続行し、最終的に merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "codex_usage_limit" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.git.calls).toContainEqual({
      method: "postComment",
      args: [100, "/restart-review"],
    });
    // 1時間 sleep（10秒 × 360チャンク）が含まれる
    const tenSecSleeps = h.sleepCalls.filter((ms) => ms === 10_000);
    expect(tenSecSleeps.length).toBe(360);
    // 初回 quota_waiting 通知が送られた
    const quotaEvents = h.notifier.events.filter((e) => e.kind === "quota_waiting");
    expect(quotaEvents).toHaveLength(1);
  });

  it("quota_wait リトライ6回超 → HALT + Slack 通知", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // not_engaged を挟むと pending が解除されて次の codex_usage_limit が fresh failure に
    // なる。quotaRetryCount はリセットされないため、7回で上限超過。
    // （同じ reason が連続する場合は 1 ポーリング分の stale ガード後に fresh 扱いになる —
    // stale ガードの動作は別テスト "stale quota poll" で検証する。）
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #1
      { kind: "not_engaged" },                              // pending を解除
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #2
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #3
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #4
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #5
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #6
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry #7 → 上限超過 → HALT
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toContain("quota retry limit");
    // postComment は6回呼ばれた（7回目は上限超過で HALT、post しない）
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(6);
    // HALT 通知が送られた
    const haltEvents = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltEvents.length).toBeGreaterThanOrEqual(1);
    // quota_waiting 通知は初回のみ（1回）
    const quotaWaiting = h.notifier.events.filter((e) => e.kind === "quota_waiting");
    expect(quotaWaiting).toHaveLength(1);
  });

  it("stale quota poll は 1 時間 sleep と postComment を再実行しない（ES-410）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // /restart-review 投稿後に GHA がキュー待ちのまま同じ stopped が続いても、
    // 1 ポーリング分の stale ガードにより追加 sleep・追加 post は発生しない。
    // （2 回目の stale は pending を解除して次を fresh 扱いにする — Finding 1 修正後の動作）
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "codex_usage_limit" }, // fresh → 1hr sleep + post
      { kind: "stopped", stopReason: "codex_usage_limit" }, // stale → no sleep, no post (clears pending)
      { kind: "in_progress" },                              // /restart-review 消費を確認
      { kind: "done" },                                     // → tryMerge → merged
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // 重複 post なし（1 回のみ）
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(1);
    // 1 時間分（360 チャンク）のみ sleep
    const tenSecSleeps = h.sleepCalls.filter((ms) => ms === 10_000);
    expect(tenSecSleeps.length).toBe(360);
    // quota_waiting 通知は 1 回のみ
    const quotaEvents = h.notifier.events.filter((e) => e.kind === "quota_waiting");
    expect(quotaEvents).toHaveLength(1);
  });

  it("quota 回復（in_progress 検知）→ quota_resumed 通知・カウンタリセット → 再度 quota で新エピソード開始", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "codex_usage_limit" }, // quota retry #1 → count=1
      { kind: "in_progress" },                               // 回復 → quota_resumed 通知、count リセット=0
      { kind: "stopped", stopReason: "codex_usage_limit" }, // 新エピソード retry #1 → count=1
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // quota_resumed 通知が送られた
    const resumed = h.notifier.events.filter((e) => e.kind === "quota_resumed");
    expect(resumed).toHaveLength(1);
    // quota_waiting 通知は各エピソードの初回（count===1）に送られるため2回
    const waiting = h.notifier.events.filter((e) => e.kind === "quota_waiting");
    expect(waiting).toHaveLength(2);
    // postComment は2回（各サイクル1回ずつ）
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(2);
  });

  it("quota リトライと autoRestartCount は独立（quota リトライが autoRestartCount に影響しない）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },   // auto_restart #1
      { kind: "stopped", stopReason: "codex_usage_limit" },  // quota retry #1
      // stale ガード: pendingRestartReason="workflow_crashed" が残っているので
      // 異なる reason を使って stale と一致させない
      { kind: "stopped", stopReason: "action_timeout" },     // auto_restart #2
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // autoRestartAttempts は 2（quota リトライは含まない）
    expect(s.autoRestartAttempts).toBe(2);
  });

  it("quota sleep 中に requestStop() → sleep を中断して HALT（セッションは in_review のまま）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex_usage_limit" }];

    // 10秒チャンクの3回目で requestStop() を呼ぶ
    let tenSecChunks = 0;
    const origSleepImpl = async (ms: number): Promise<void> => {
      h.sleepCalls.push(ms);
      if (ms === 10_000) {
        tenSecChunks += 1;
        if (tenSecChunks === 3) {
          h.orch.requestStop();
        }
      }
    };
    // DI の sleep を差し替え
    (h.orch as unknown as { sleep: (ms: number) => Promise<void> }).sleep = origSleepImpl;

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // セッションは in_review のまま（クリーン停止）
    expect(s.state).toBe("in_review");
    expect(s.failureReason).toBeNull();
    // Run は halted(user_interrupt)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    // 360チャンク全部は走っていない（途中で中断）
    expect(tenSecChunks).toBeLessThan(360);
    // postComment は呼ばれていない（sleep 中断で /restart-review 投稿前に停止）
    expect(h.git.calls.some((c) => c.method === "postComment")).toBe(false);
  });

  it("auto_restart 2 回で成功（上限 3 内）→ merged", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },
      { kind: "stopped", stopReason: "action_timeout" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(2);
  });

  it("同じ stopReason が連続しても 2 回目以降の restart を抑制しない（stale は 1 poll だけ待つ）", async () => {
    // Scenario: workflow_crashed → restart posted → workflow restarts and crashes again with the
    // same reason before the next poll. The stale guard should give one poll grace, then allow
    // the next restart attempt rather than suppressing indefinitely.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 1: restart #1 posted
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 2: stale grace period
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 3: restart #2 posted
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    // Two restarts posted despite same stop reason appearing consecutively
    expect(postComments).toHaveLength(2);
    expect(s.autoRestartAttempts).toBe(2);
  });

  it("同じ stopReason が 7 連続 → 3 回リスタートして上限超過で HALT", async () => {
    // Each restart consumes 2 polls (one to post, one stale grace). After 3 restarts (6 polls)
    // the 7th poll triggers a 4th attempt which exceeds the cap.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 1: restart #1
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 2: stale grace
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 3: restart #2
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 4: stale grace
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 5: restart #3
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 6: stale grace
      { kind: "stopped", stopReason: "workflow_crashed" }, // poll 7: attempt #4 → cap exceeded → HALT
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toContain("auto-restart limit");
    const postComments = h.git.calls.filter((c) => c.method === "postComment");
    expect(postComments).toHaveLength(3);
  });
});

describe("Orchestrator 失敗系 — not_engaged ガード / monitor_timeout（仕様 §5.5 / §11 / カーネル §7.6）", () => {
  it("not_engaged かつ経過 > not_engaged_guard_minutes → stopped(monitor_never_engaged, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // not_engaged を返し続ける（FakeMonitor は要素 1 のとき同じものを返す）
    h.monitor.verdicts = [{ kind: "not_engaged" }];

    // poll をフックして、poll の直前に monitorStartedAt を「現在 clock より 60 分前」へ上書きする。
    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T23:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBeNull();
    // 1 回目の poll で経過超過 → 即停止
    expect(h.monitor.pollCalls).toHaveLength(1);
  });

  it("not_engaged かつ経過 <= guard → 続行（停止しない）。経過が閾値内なら poll を繰り返す", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, notEngagedGuardMinutes: 30 }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // 1 回目 not_engaged（ガード未経過で続行）→ 2 回目 done → merged で完走
    // monitorStartedAt は上書きしない（clock の進みは数秒なので 30 分閾値を超えない）
    h.monitor.verdicts = [{ kind: "not_engaged" }, { kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ガード内 not_engaged では停止せず、最終的に merged
    expect(s.state).toBe("merged");
    // 少なくとも 2 回 poll した（not_engaged 続行 → done）
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("in_progress かつ monitor_timeout_minutes 設定・total 経過超過 → stopped(exception, 'monitor timeout')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorTimeoutMinutes: 120 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "in_progress" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      // monitorStartedAt を 3 時間前へ（> 120 分）
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T21:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("monitor timeout");
  });

  it("in_progress かつ monitor_timeout 未設定（既定 undefined）→ timeout で止まらず続行する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorTimeoutMinutes: undefined }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // in_progress（経過いくら長くても止まらない）→ done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-01T00:00:00.000Z" }); // 何日も前
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // timeout 未設定なので in_progress では止まらず、done→merged で完走
    expect(s.state).toBe("merged");
  });
});

describe("Orchestrator 失敗系 — poll throw バックオフ（仕様 §5.5 / カーネル §7.6）", () => {
  it("poll が 5 連続で throw → stopped(exception, 'monitor poll failed 5x: ...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // verdicts は使わず poll を常に throw させる
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      throw new Error("gh api 502");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("monitor poll failed 5x");
    expect(s.stopDetail).toContain("gh api 502");
    // poll は 5 回呼ばれた
    expect(h.monitor.pollCalls).toHaveLength(5);
    // バックオフ: 1回目 sleep=60000、以降 ×2..×8 クランプ。MONITOR の sleep だけ抜き出す。
    // 各反復先頭で sleep(pollIntervalMs * backoffMultiplier)。
    // multiplier 列: 1,2,4,8,8 → sleep 列: 60000,120000,240000,480000,480000
    // （このテストは IDLE に入らない＝queue 1 件・taskCap 3 のため、MONITOR の sleep のみ）
    const base = config.loop.monitorPollSeconds * 1000;
    const monitorSleeps = h.sleepCalls.filter((ms) => ms % base === 0 && ms >= base);
    expect(monitorSleeps.slice(0, 5)).toEqual([
      base * 1,
      base * 2,
      base * 4,
      base * 8,
      base * 8, // ×8 でクランプ
    ]);
  });

  it("poll が 4 回 throw 後に成功（done→merged）→ 停止せず完走し、バックオフは成功でリセットされる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorPollSeconds: 60 }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];

    let n = 0;
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      n += 1;
      if (n <= 4) throw new Error("transient 503");
      if (n === 5) return { kind: "done" };
      return { kind: "merged" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 4 連続失敗（<5）なので停止せず、5 回目 done → tryMerge(ready)→merge 成功 → 完走
    // done verdict で tryMerge が即座に merged を返すため、merged verdict の poll は不要（計 5 回）
    expect(s.state).toBe("merged");
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(5); // 4 throws + 1 done（plan defect: was 6）
  });
});

describe("Orchestrator 失敗系 — checkMergeReadiness throw バックオフ（仕様 §5.5 一時エラー / カーネル §7.6）", () => {
  // gh pr view の一時障害でループ全体が Fatal 落ちしてはならない。
  // poll throw と同じ一時障害扱い: バックオフ再試行、5 連続で stopped(exception)。
  it("checkMergeReadiness が 5 連続で throw → stopped(exception, 'merge readiness check failed 5x: ...')・mergePr は呼ばれない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }]; // 常に done → 毎回 readiness 評価へ
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      throw new Error("gh pr view 502");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("merge readiness check failed 5x");
    expect(s.stopDetail).toContain("gh pr view 502");
    expect(h.monitor.readinessCalls).toHaveLength(5);
    expect(h.git.calls.filter((c) => c.method === "mergePr")).toHaveLength(0);
    // バックオフ: 反復先頭の sleep が ×1,×2,×4,×8,×8 とエスカレートする
    const base = config.loop.monitorPollSeconds * 1000;
    const monitorSleeps = h.sleepCalls.filter((ms) => ms % base === 0 && ms >= base);
    expect(monitorSleeps.slice(0, 5)).toEqual([
      base * 1,
      base * 2,
      base * 4,
      base * 8,
      base * 8, // ×8 でクランプ
    ]);
  });

  it("checkMergeReadiness が 2 回 throw 後に成功（ready）→ merged で完走（カウンタは成功でリセット）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorPollSeconds: 60 }); // 完走後 HALT（IDLE 回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }];
    let n = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      n += 1;
      if (n <= 2) throw new Error("transient 503");
      return { ready: true, headSha: "sha-101" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.monitor.readinessCalls).toHaveLength(3);
    expect(h.git.calls.filter((c) => c.method === "mergePr")).toHaveLength(1);
  });
});

describe("Orchestrator 失敗系 — merge readiness 分岐（仕様 §5.5 / §5.4 readiness / カーネル §7.6）", () => {
  it("done → readiness ci_failed → stopped(ci_failed, detail=null)。mergePr は呼ばれない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "ci_failed" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBeNull();
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness conflict → stopped(merge_conflict)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "conflict" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_conflict");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness blocked → stopped(ci_failed, detail='merge blocked by branch protection...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "blocked" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // blocked は failureReason=ci_failed（カーネル §7.6）に写像
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toContain("merge blocked by branch protection");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness ci_pending を 1 回 → 次 poll で done→ready→merge し、停止せず完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged。readiness: 1回目 ci_pending、2回目 ready
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_pending" };
      return { ready: true, headSha: "sha-100" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ci_pending では止まらず、2 回目の done で ready→merge→次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
  });
});

describe("Orchestrator 失敗系 — mergePr 2 連続 throw fail-closed（カーネル §7.6）", () => {
  it("ready のまま mergePr が 2 連続 throw → stopped(ci_failed, 'merge call failed under ready verdict: <error>')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll は done を返し続ける（要素 1 → 同じ verdict を維持）。readiness は常に ready（既定）。
    h.monitor.verdicts = [{ kind: "done" }];
    // mergePr を毎回 throw させる
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      throw new Error("gh: merge failed 422");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // 2 連続失敗で fail-closed（既定理由 ci_failed）
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBe("merge call failed under ready verdict: gh: merge failed 422");
    // mergePr は ちょうど 2 回呼ばれて停止（1 回目は続行、2 回目で fail-closed）
    expect(mergeCalls).toBe(2);
  });

  it("mergePr が 1 回 throw → 次 poll(done→ready) で成功 → 完走する（カウンタは成功でリセット）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      if (mergeCalls === 1) throw new Error("transient 500");
      // 2 回目は成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回失敗 → 2 回目成功 → 次 poll merged で完走（2 連続には達しない）
    expect(s.state).toBe("merged");
    expect(mergeCalls).toBe(2);
  });

  it("§6 HEAD 移動見送り: --match-head-commit 失敗で 1 回 throw → 次ポーリングで readiness 再評価 ready → mergePr 成功 → merged", async () => {
    // 仕様 §6: HEAD 移動なら見送り（次ポーリング）。実装では --match-head-commit 失敗が mergePr の throw として現れ、
    // 1 回目は次ポーリングで done→checkMergeReadiness を再評価する（mergeFailures=1、2 連続未満なので fail-closed しない）。
    // 再評価で新しい headSha の ready が返り、その sha で mergePr が成功 → merged で回復する。
    const config = makeConfig({ maxTasksPerRun: 1 }); // taskCap=1: 完走後 HALT（IDLE ループ回避）
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done（1 回目 merge 試行）→ done（再評価して成功）→ merged（DONE へ）
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];

    // readiness は毎回 ready だが headSha が HEAD 移動で変わる: 1 回目 sha-stale → 2 回目 sha-fresh
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      return readinessCall === 1
        ? { ready: true, headSha: "sha-stale" }
        : { ready: true, headSha: "sha-fresh" };
    };

    // mergePr は --match-head-commit に相当: 渡された headSha が現在の HEAD（sha-fresh）と異なれば throw（HEAD 移動）。
    const mergeShas: string[] = [];
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      mergeShas.push(headSha);
      if (headSha !== "sha-fresh") {
        throw new Error("gh: head commit moved (--match-head-commit failed)");
      }
      // sha-fresh では成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回目 sha-stale で throw（見送り）→ 2 回目 sha-fresh で成功 → 次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    // mergePr は 2 回呼ばれ、stale→fresh の順。2 連続失敗には達しないので fail-closed しない。
    expect(mergeShas).toEqual(["sha-stale", "sha-fresh"]);
    // 成功した sha で DONE 経路に入る
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-fresh"] });
  });
});

describe("Orchestrator 失敗系 — mergePr throw ストリーク断絶（カーネル §7.6）", () => {
  it("mergePr throw → in_progress を挟んで再度 throw ではフェイルクローズしない（ready ストリーク断絶）", async () => {
    // カーネル §7: 「ready のまま 2連続 throw」—  in_progress が間に入ったら 2連続にカウントしない。
    // 期待: done(throw), in_progress, done(throw), done(success) → merged（stopped にならない）
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → in_progress → done → done → merged
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "in_progress" },
      { kind: "done" },
      { kind: "done" },
      { kind: "merged" },
    ];
    // mergePr: 1回目 throw, 2回目 throw, 3回目 成功
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      if (mergeCalls <= 2) throw new Error("gh: transient 422");
      // 3回目は成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // in_progress を挟んでいるのでストリーク断絶 → fail-closed せず最終的に merged
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(mergeCalls).toBe(3);
  });

  it("poll throw を挟んだ mergePr throw もストリークを断絶する", async () => {
    // カーネル §7: 「ready のまま 2連続 throw」— poll throw が間に入ったら 2連続にカウントしない。
    // 期待: done(throw), poll-throw, done(throw), done(success) → merged（stopped にならない）
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);

    // poll: done → throw → done → done → merged（throw は2回目のpollだけ）
    let pollCalls = 0;
    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
      { kind: "done" },
      { kind: "merged" },
    ];
    h.monitor.poll = async (pr: number) => {
      pollCalls += 1;
      h.monitor.pollCalls.push(pr);
      if (pollCalls === 2) throw new Error("gh api 503 transient");
      return origPoll(pr);
    };

    // mergePr: 1回目 throw, 2回目 throw, 3回目 成功
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      if (mergeCalls <= 2) throw new Error("gh: transient 422");
      // 3回目は成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // poll throw を挟んでいるのでストリーク断絶 → fail-closed せず最終的に merged
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(mergeCalls).toBe(3);
  });
});

describe("Orchestrator 失敗系 — DONE transition 失敗でも継続（仕様 §5.6 / カーネル §7.7）", () => {
  it("transition(done) が 3 回失敗しても HALT せず警告ログのみ・merged は永続化・次 SELECT へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // transition(done) のみ常に throw（in_progress/in_review は通す）
    const orig = h.source.transition.bind(h.source);
    let doneAttempts = 0;
    h.source.transition = async (issueId: string, state) => {
      if (state === "done") {
        doneAttempts += 1;
        throw new Error("Linear timeout");
      }
      return orig(issueId, state);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // merged は永続化される（DONE は merged 先に永続化 → transition は best-effort）
    expect(s.state).toBe("merged");
    expect(s.endedAt).not.toBeNull();
    expect(h.store.countMerged(run.id)).toBe(1);
    // transition(done) は retry 3 回試みた
    expect(doneAttempts).toBe(3);
    // HALT していない：halted は taskCap 到達由来のみ（looppilot_stopped/exception ではない）
    expect(run.state).toBe("halted"); // taskCap=1 到達で最終的に halted
    expect(run.haltReason).toContain("task cap reached");
    // 通知列に「失敗由来の halted」は無い（run_started → halted(task_cap) のみ）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ reason: "task_cap" });
    // 警告ログが出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("transition(done) failed"))).toBe(true);
  });
});

describe("Orchestrator 失敗系 — STOPPED 共通処理の不変条件（仕様 §7 STOPPED⇒HALT 1:1 / カーネル §7 末尾）", () => {
  it("stopSession を通る経路では『session=stopped+costUsd 保存』『Run=halted』『notify(halted) 1 回』が同時に成立する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 8 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // cost_exceeded 経路（costUsd が判明している経路では併せて保存される）
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 8.0 }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // セッション側
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(8.0); // costUsd 併せて保存（カーネル §7 STOPPED 共通処理）
    expect(s.endedAt).not.toBeNull();
    // Run 側（TaskSession=stopped ⇒ Run=halted の 1:1）
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("cost_exceeded");
    expect(run.haltReason).toContain("TY-1");
    // notify(halted) はちょうど 1 回
    const haltedEvents = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltedEvents).toHaveLength(1);
    expect(haltedEvents[0]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
    // 失敗後はループを脱出し、次の SELECT を試みない（getNextEligible は 1 回だけ）
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("MONITOR 中（in_review→merged 完走）にオーケは PR/ブランチへ書き込まない（マージのみ例外・仕様 §5.5/§4）", async () => {
    // 仕様 §4/§5.5 の不変条件: MONITOR 中はオーケが PR/ブランチへ書き込まない（LoopPilot を唯一の書き手とし、mergePr のみ例外）。
    // 正常完走（done→merged）を回し、monitorSession 突入後の Git/PR 呼び出しが mergePr 以外の書き込み系を含まないことを固定する。
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");

    // 全 Git/PR 書き込み系メソッド（FakeGitPr.calls は { method, args } 形式）
    const writeMethods = ["pushAndOpenPr", "addLabel", "prepareWorktree", "discardWorktree"];
    // monitorSession 突入以降に書き込み系が一切呼ばれていないことを確認する。
    // CLAIM/HANDOFF で prepareWorktree/pushAndOpenPr/addLabel は MONITOR 突入「前」に呼ばれ済みなので、
    // 突入の境界＝最後の addLabel（HANDOFF 末尾の書き込み）以降のスライスを見る。
    const lastHandoffWriteIdx = h.git.calls.map((c) => c.method).lastIndexOf("addLabel");
    expect(lastHandoffWriteIdx).toBeGreaterThanOrEqual(0); // HANDOFF で addLabel は呼ばれている
    const afterMonitor = h.git.calls.slice(lastHandoffWriteIdx + 1);
    // MONITOR 中の書き込み系（pushAndOpenPr/addLabel/prepareWorktree/discardWorktree）は 0 件
    expect(afterMonitor.filter((c) => writeMethods.includes(c.method))).toEqual([]);
    // マージのみ例外として許される
    expect(afterMonitor.map((c) => c.method)).toContain("mergePr");

    // 念のため全期間でも: prepareWorktree/pushAndOpenPr/addLabel は各 1 回（CLAIM/HANDOFF のみ）、
    // discardWorktree は 0 回（正常完走では破棄しない）、mergePr は 1 回。
    const counts = (m: string): number => h.git.calls.filter((c) => c.method === m).length;
    expect(counts("prepareWorktree")).toBe(1);
    expect(counts("pushAndOpenPr")).toBe(1);
    expect(counts("addLabel")).toBe(1);
    expect(counts("discardWorktree")).toBe(0);
    expect(counts("mergePr")).toBe(1);
  });
});

describe("Orchestrator 安全弁 — SIGINT/停止要求フラグ（仕様 §11 / カーネル §7 末尾）", () => {
  it("requestStop() を実装フェーズで立てると、現フェーズ群完了後の次の安全点で Run=halted(user_interrupt) して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A ok" },
      { kind: "completed", costUsd: 1, summary: "B ok" },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    // 1 件目の IMPLEMENT 中に停止要求を立てる（次の安全点まで現フェーズ群は完了させる）
    const origRun = h.agent.runSession.bind(h.agent);
    let agentCalls = 0;
    h.agent.runSession = async (ctx) => {
      agentCalls += 1;
      if (agentCalls === 1) h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // 1 件目は現フェーズ群を完走して merged になる（安全点までは止めない）
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].state).toBe("merged");
    // 2 件目は着手しない（次反復先頭の安全点で停止）
    expect(h.agent.contexts).toHaveLength(1);
    // Run=halted、理由は user_interrupt
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    // 通知列: run_started → halted(user_interrupt)。失敗 stopped ではない（セッションは merged）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });

  it("requestStop() 後でも進行中セッションは stopped にならず merged のまま（クリーン停止）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const origRun = h.agent.runSession.bind(h.agent);
    h.agent.runSession = async (ctx) => {
      h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 現セッションは完走（merged）。stopped にしない。
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.store.latestRun()!.haltReason).toContain("user_interrupt");
  });

  it("MONITOR 中（支配的フェーズ）の停止要求は poll 境界の安全点でクリーン HALT し、セッションは in_review のまま", async () => {
    // MONITOR は最長フェーズ。poll 境界（無書込みの安全点）で interrupted を検査し、
    // 現 PR の解決を待たずにクリーン停止できること（カーネル §7 安全点の精緻化）。
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // poll は常に in_progress（merge/stop へ進まない＝支配的 MONITOR を模す）。1 回目で停止要求。
    let polls = 0;
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      polls += 1;
      if (polls === 1) h.orch.requestStop();
      return { kind: "in_progress" };
    };

    await expect(h.orch.run()).resolves.toBe("finished");

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // クリーン停止: セッションは stopped にせず in_review のまま（再起動で回復可能）
    expect(s.state).toBe("in_review");
    expect(s.failureReason).toBeNull();
    // Run=halted(user_interrupt)・通知される
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events.at(-1)).toMatchObject({ kind: "halted", reason: "user_interrupt" });
    // 無限に poll し続けず、安全点で止まる（数回以内）
    expect(h.monitor.pollCalls.length).toBeLessThanOrEqual(2);
  });

  it("user_interrupt の halt 通知は await される（run() は通知完了まで resolve しない）", async () => {
    // 通知を fire-and-forget にすると、main の store.close() 後に通知の非同期が走り
    // 閉じた DB を触る未捕捉拒否や通知欠落を招く。run() は halt 通知の完了を待つこと。
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 起動直後の安全点（loop 冒頭）で停止 → haltForInterrupt 経路
    h.orch.requestStop();

    // user_interrupt 通知だけゲートして、await されているかを観測する
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const orig = h.notifier.notify.bind(h.notifier);
    h.notifier.notify = async (e) => {
      await orig(e);
      if (e.kind === "halted" && e.reason === "user_interrupt") await gate;
    };

    let resolved = false;
    const p = h.orch.run().then((v) => {
      resolved = true;
      return v;
    });
    // ゲート解放前: await されていれば run() は未完了
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    release();
    await p;
    expect(resolved).toBe(true);
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

// 二重起動: ロック拒否は戻り値で通知し、main が古い Run の状態から誤った exit code を導かないようにする
describe("Orchestrator 二重起動 — run lock 拒否（Fix 1）", () => {
  it("別の生存プロセスがロックを保持しているとき run() は 'lock_rejected' を返し、Run 行を作らず通知も送らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);

    // 別の「実在し生存している」pid がロックを保持中。orchestrator の run() は
    // 実 isPidAlive（process.kill(pid, 0)）で死活判定するため、固定 pid（例: 99999）だと
    // 実在しない環境でロックが奪取されて IDLE 無限ループになる。テストランナーの
    // 親プロセス pid（process.ppid）は同一ユーザーで必ず生存しており、process.pid とも異なる。
    const foreignPid = process.ppid;
    h.store.acquireRunLock(foreignPid, () => true, "2026-06-05T00:00:00.000Z");

    const outcome = await h.orch.run();

    // 戻り値が "lock_rejected" であること
    expect(outcome).toBe("lock_rejected");

    // Run 行は一切作られていない
    expect(h.store.latestRun()).toBeNull();

    // 通知は一切送られていない
    expect(h.notifier.events).toHaveLength(0);
  });
});

describe("Orchestrator 進捗通知 — notify.progress opt-in（ES-378）", () => {
  it("progress=true: CLAIM 成功後に task_started、DONE 後に task_merged が通知される", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, notifyProgress: true });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const started = h.notifier.events.filter((e) => e.kind === "task_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      kind: "task_started",
      identifier: "TY-1",
      title: "Title for TY-1",
    });

    const merged = h.notifier.events.filter((e) => e.kind === "task_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      kind: "task_merged",
      identifier: "TY-1",
      title: "Title for TY-1",
      mergedCount: 1,
    });
  });

  it("progress=false（既定）: task_started / task_merged は通知されない", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const progress = h.notifier.events.filter(
      (e) => e.kind === "task_started" || e.kind === "task_merged",
    );
    expect(progress).toHaveLength(0);

    // 従来どおり run_started と halted(task_cap) は出る
    expect(h.notifier.events.some((e) => e.kind === "run_started")).toBe(true);
  });

  it("progress=true: 2チケット逐次で各着手/完了が通知され mergedCount が正しい", async () => {
    const config = makeConfig({ maxTasksPerRun: 2, notifyProgress: true });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A" },
      { kind: "completed", costUsd: 2, summary: "B" },
    ];
    h.monitor.verdicts = [
      { kind: "done" }, { kind: "merged" },
      { kind: "done" }, { kind: "merged" },
    ];

    await h.orch.run();

    const started = h.notifier.events.filter((e) => e.kind === "task_started");
    expect(started).toHaveLength(2);
    expect(started.map((e) => (e as { identifier: string }).identifier)).toEqual(["TY-1", "TY-2"]);

    const merged = h.notifier.events.filter((e) => e.kind === "task_merged");
    expect(merged).toHaveLength(2);
    expect((merged[0] as { mergedCount: number }).mergedCount).toBe(1);
    expect((merged[1] as { mergedCount: number }).mergedCount).toBe(2);
  });
});

describe("Orchestrator PLAN phase (ES-381)", () => {
  it("generates brief via planner, persists to DB, and proceeds to IMPLEMENT", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo the thing.\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Planner was called
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]!.worktreePath).toBe("/wt/ty-1");
    expect(planner.calls[0]!.prompt).toContain("TY-1");

    // Brief persisted in DB
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toContain("## Goal");
    expect(s.planBrief).toContain("Do the thing.");
  });

  it("falls back to null brief when planner returns error", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "error", message: "codex crashed" }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Still completed — fallback worked
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("codex failed") && l.includes("codex crashed"))).toBe(true);
  });

  it("falls back to null brief when planner throws", async () => {
    const planner = new FakePlanRunner();
    // No outcomes queued → FakePlanRunner throws
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("codex exception"))).toBe(true);
  });

  it("skips PLAN entirely when planner is null", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // planner defaults to null
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    // No plan-related log lines
    expect(h.logs.some((l) => l.includes("plan:"))).toBe(false);
  });

  it("falls back when spec loading fails during PLAN (IMPLEMENT also stops)", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nShould not reach." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const specConfig = { ...config, product: { ...config.product, specDir: "docs/specs" } } as Config;
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const agent = new FakeAgentRunner();
    const git = new FakeGitPr();
    const monitor = new FakeMonitor();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const orch = new Orchestrator({
      config: specConfig,
      source,
      agent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt: (args: PromptArgs) => `PROMPT for ${args.issue.identifier}`,
      specLoader: () => { throw new Error("requirements.md not found"); },
      clock: fixedClock("2026-06-05T00:00:00.000Z"),
      sleep: instantSleep(),
      log: (line: string) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner,
    });

    source.queue = [issue("issue-A", "TY-1")];
    agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    monitor.verdicts = [{ kind: "merged" }];

    await orch.run();

    // PLAN fell back gracefully (did not halt the loop)
    expect(planner.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("plan: spec loading failed"))).toBe(true);
    // IMPLEMENT independently also fails on spec loading → session stopped
    const s = store.sessionsForRun(store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.planBrief).toBeNull();
  });

  it("passes plan brief to buildPrompt so the implementation agent receives it", async () => {
    const briefText = "## Goal\nDo the thing.\n\n## Change Targets\n- src/foo.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing";
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: briefText }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // buildPrompt must have been called with the plan brief
    expect(h.promptArgs).toHaveLength(1);
    expect(h.promptArgs[0]!.planBrief).not.toBeNull();
    expect(h.promptArgs[0]!.planBrief?.raw).toContain("## Goal");
    expect(h.promptArgs[0]!.planBrief?.raw).toContain("Do the thing.");
  });

  it("passes null brief to buildPrompt when planner is absent", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // planner defaults to null
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.promptArgs).toHaveLength(1);
    expect(h.promptArgs[0]!.planBrief ?? null).toBeNull();
  });

  it("stores null (not empty string) when planner returns whitespace-only output", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed" as const, text: "   \n  \n  " }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("codex returned empty output"))).toBe(true);
  });

  it("passes codexTimeoutMinutes as timeoutMs to the planner", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nDone." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // codexTimeoutMinutes=30 → 30 * 60_000 = 1_800_000 ms
    expect(planner.calls[0]!.timeoutMs).toBe(30 * 60_000);
  });

  it("requestStop() during PLAN halts before IMPLEMENT starts — session stays in claimed (Finding 1)", async () => {
    // PLAN is read-only. If SIGINT arrives during PLAN, the safe point between
    // PLAN and IMPLEMENT must honor the stop request so IMPLEMENT (the mutating
    // phase) never launches.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];

    // Planner calls requestStop when invoked, simulating SIGINT during PLAN
    const origPlannerRun = planner.run.bind(planner);
    planner.run = async (ctx) => {
      h.orch.requestStop();
      planner.outcomes = [{ kind: "completed", text: "## Goal\nBrief." }];
      return origPlannerRun(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Session stays in "claimed" — IMPLEMENT never ran
    expect(s.state).toBe("claimed");
    expect(s.failureReason).toBeNull();
    // IMPLEMENT was not invoked
    expect(h.agent.contexts).toHaveLength(0);
    // postComment must not have been called — the brief writeback is an external
    // Linear mutation and must be skipped when a stop is pending
    expect(h.source.comments).toHaveLength(0);
    // Run halts cleanly as user_interrupt
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });
});

describe("Orchestrator PLAN brief writeback (ES-406)", () => {
  it("writes back the brief as a Linear comment after successful generation", async () => {
    const briefText = "## Goal\nDo the thing.\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing";
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: briefText }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.source.comments).toHaveLength(1);
    expect(h.source.comments[0]).toEqual({
      issueId: "issue-A",
      body: briefText,
    });
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
  });

  it("continues the loop when brief writeback fails (non-fatal)", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nDo it." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];
    h.source.failNext("postComment", new Error("Linear API 503"));

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toContain("## Goal");
    expect(h.logs.some((l) => l.includes("brief writeback failed") && l.includes("Linear API 503"))).toBe(true);
  });

  it("does not write back when planner returns empty output", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "   \n  \n  " }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.source.comments).toHaveLength(0);
  });

  it("does not write back when planner is absent", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // planner defaults to null
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.source.comments).toHaveLength(0);
  });

  it("does not write back when planner returns error (fallback to raw ticket)", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "error", message: "codex crashed" }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.source.comments).toHaveLength(0);
  });
});

describe("Orchestrator.interruptablePause", () => {
  it("sets paused state, notifies once, sleeps in chunks, then resumes with notification", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const run = h.store.createRun(5, "2026-06-21T00:00:00.000Z");
    (h.orch as any).runId = run.id;

    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };

    const result = await h.orch.interruptablePause(meta, 30_000, 10_000);

    expect(result.control).toBe("continue");

    const updated = h.store.getRun(run.id);
    expect(updated.state).toBe("running");
    expect(updated.pauseMeta).toBeNull();

    const pausedEvents = h.notifier.events.filter((e) => e.kind === "paused");
    const resumedEvents = h.notifier.events.filter((e) => e.kind === "resumed");
    expect(pausedEvents).toHaveLength(1);
    expect(resumedEvents).toHaveLength(1);
    expect(pausedEvents[0]).toEqual({
      kind: "paused",
      target: "claude",
      detail: expect.stringContaining("rate_limit"),
    });

    // 30s / 10s chunks = 3 sleep calls
    expect(h.sleepCalls).toEqual([10_000, 10_000, 10_000]);

    h.store.close();
  });

  it("returns HALT and does not notify 'resumed' when interrupted during pause", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const run = h.store.createRun(5, "2026-06-21T00:00:00.000Z");
    (h.orch as any).runId = run.id;

    h.orch.requestStop();

    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "codex",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };

    const result = await h.orch.interruptablePause(meta, 60_000, 10_000);

    expect(result.control).toBe("halt");

    const pausedEvents = h.notifier.events.filter((e) => e.kind === "paused");
    expect(pausedEvents).toHaveLength(1);

    const resumedEvents = h.notifier.events.filter((e) => e.kind === "resumed");
    expect(resumedEvents).toHaveLength(0);

    const halted = h.store.getRun(run.id);
    expect(halted.state).toBe("halted");
    expect(halted.pauseMeta).toBeNull();

    // Sleep was never called (interrupted before first chunk)
    expect(h.sleepCalls).toHaveLength(0);

    h.store.close();
  });
});
