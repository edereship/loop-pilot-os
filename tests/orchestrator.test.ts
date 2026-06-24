import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Orchestrator, isPidAlive } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  FakeWorkflowRecovery,
  FakePlanRunner,
  FakeCommandRunner,
  FakeGroomBoardFetcher,
  FakeGroomLinearClient,
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
  monitorTimeoutMinutes: number;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
  notifyProgress: boolean;
  groomEnabled: boolean;
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
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
    notify: { progress: over.notifyProgress ?? false },
    groom: { enabled: over.groomEnabled ?? false },
    memory: { maxCharsPerFile: 8000, injectBudgetChars: 6000 },
    linear: { optInLabel: "looppilot-os", team: "ENG", project: "LoopPilot", states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" } },
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
  recoveryRunner: FakeCommandRunner;
  memoryRunner: FakeCommandRunner;
  groomBoardFetcher: FakeGroomBoardFetcher;
  groomLinearClient: FakeGroomLinearClient;
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
  const codebaseSummaryGenerator = async () => "3 files, 100 lines total\n\nsrc/a.ts (40L)\nsrc/b.ts (30L)\nsrc/c.ts (30L)";
  const recoveryRunner = new FakeCommandRunner();
  // Stub common git operations for recovery
  recoveryRunner.on(["git", "-C"], (_args, _opts) => {
    return { code: 0, stdout: "" };
  });
  recoveryRunner.on(["git", "push"], { code: 0 });
  recoveryRunner.on(["gh"], { code: 0 });
  const planner = opts?.planner ?? null;
  const memoryRunner = new FakeCommandRunner();
  memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
  memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
  memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
  memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
  // GROOM always resets the memory directory before executing actions (ES-457 Finding 1).
  memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "clean", "-fd", "--", "docs/memory/"], { code: 0 });
  // GROOM full-checkout reset after Codex runs (ES-457 Findings 3 + 4).
  memoryRunner.on(["git", "checkout", "HEAD", "--", "."], { code: 0 });
  memoryRunner.on(["git", "clean", "-fd"], { code: 0 });
  // GROOM startSha recording and HEAD reset before memory commit (ES-457 Finding 1).
  memoryRunner.on(["git", "rev-parse", "HEAD"], { code: 0, stdout: "abc1234\n" });
  memoryRunner.on(["git", "reset", "--hard"], { code: 0 });
  const groomBoardFetcher = new FakeGroomBoardFetcher();
  const groomLinearClient = new FakeGroomLinearClient();
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
    planner,
    codebaseSummaryGenerator,
    recoveryTurn: planner !== null ? {
      planner,
      agent,
      git,
      runner: recoveryRunner,
      source,
      config,
      log,
    } : null,
    runner: memoryRunner,
    groomDeps: (config.groom.enabled && planner !== null) ? {
      boardFetcher: groomBoardFetcher,
      linearClient: groomLinearClient,
      knownLabels: ["looppilot-os"],
    } : null,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs, recoveryRunner, memoryRunner, groomBoardFetcher, groomLinearClient };
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

    // 2件目の SELECT 時、1件目はもう in_progress 以降（merged）→ getAllEligible が除外
    // （FakeTaskSource は transition 済み issue を eligible から除外する）
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
    // getAllEligible はキューを変化させない（実 LinearTaskSource も再クエリするだけ）

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
  // getAllEligible が throw（Linear 一時障害等）→ 無人ループを Fatal 落ちさせず、
  // CLAIM① と同様に Run=halted(exception)+notify(halted) で人間に上げる。
  it("getAllEligible が throw → run() は throw せず Run=halted(exception)・notify(halted) する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.source.failNext("getAllEligible", new Error("Linear HTTP 503"));

    // run() 自体が reject しない（main().catch の Fatal 経路に到達しない）こと
    await expect(h.orch.run()).resolves.toBe("finished");

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // haltReason は記述的 detail（select_failed 接頭辞 + 原因）。notify の reason が exception。
    expect(run.haltReason).toContain("select_failed");
    expect(run.haltReason).toContain("getAllEligible");
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

    // getAllEligible: 1回目 []（IDLE）、2回目以降は復帰した issue を返す
    let eligibleCall = 0;
    const recovered = issue("issue-A", "TY-1");
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall += 1;
      if (eligibleCall === 1) return []; // 初回 IDLE
      // 復帰後は issue を返す（2回目以降）
      return [recovered];
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
    const inlineMemoryRunner1 = new FakeCommandRunner();
    inlineMemoryRunner1.on(["git", "fetch", "origin", "main"], { code: 0 });
    inlineMemoryRunner1.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    inlineMemoryRunner1.on(["git", "add", "docs/memory/"], { code: 0 });
    inlineMemoryRunner1.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
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
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: inlineMemoryRunner1,
      groomDeps: null,
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
    // quotaRetryAttempts は 6（最後に成功した post 時点の値。7回目は post 前に停止）
    expect(s.quotaRetryAttempts).toBe(6);
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
    // in_progress 復帰でリセットされた後、新エピソードの 1 回分のみ永続化
    expect(s.quotaRetryAttempts).toBe(1);
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
    // quotaRetryAttempts は 1（quota リトライ分のみ）
    expect(s.quotaRetryAttempts).toBe(1);
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

  it("no_findings の ci_failed リカバリ後に quotaRetryCount がリロードされ上限超過しない（ES-469 Finding）", async () => {
    // Scenario: quotaRetryCount reaches 6, then no_findings triggers tryMerge which sees
    // ci_failed readiness → stopSession(ci_failed) → recovery resets quotaRetryAttempts=0 in DB.
    // Without the fix, the local quotaRetryCount stays at 6 and the next codex_usage_limit
    // increments it to 7 (>6), triggering the cap and halting. With the fix, the reload
    // brings the local count to 0 so the next retry is treated as attempt #1.
    const planner = new FakePlanRunner();
    // Outcome 0: PLAN phase (valid brief so IMPLEMENT proceeds)
    // Outcome 1: RECOVERY phase (for ci_failed from tryMerge inside the no_findings handler)
    planner.outcomes = [
      {
        kind: "completed",
        text: [
          "## Goal", "Fix it.", "", "## Change Targets", "- file.ts", "",
          "## Implementation Steps", "1. Step one", "", "## Acceptance Criteria", "- Tests pass", "",
          "## Out of Scope", "- Nothing",
        ].join("\n"),
      },
      { kind: "completed", text: '{"action":"restart_review"}' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // Make tryMerge see ci_failed so recovery fires and resets quotaRetryAttempts in DB
    h.monitor.readiness.set(100, { ready: false, reason: "ci_failed" });
    h.monitor.verdicts = [
      // Accumulate quotaRetryCount=6 via 6 retries interleaved with not_engaged to clear pending
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 1
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 2
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 3
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 4
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 5
      { kind: "not_engaged" },
      { kind: "stopped", stopReason: "codex_usage_limit" }, // retry 6
      { kind: "not_engaged" },
      // quotaRetryCount=6 locally and in DB at this point
      { kind: "stopped", stopReason: "no_findings" },
      // → review_done path → tryMerge → ci_failed readiness
      // → stopSession(ci_failed) → recovery succeeds (restart_review)
      // → DB: quotaRetryAttempts=0, pendingRestartReason="ci_failed"
      // → tryMerge returns {kind:"continue"}
      // → review_done reload: pendingRestartReason="ci_failed", quotaRetryCount=0 (with fix)
      { kind: "done" },
      // → pendingRestartReason="ci_failed" consumed (grace), no tryMerge called
      { kind: "stopped", stopReason: "codex_usage_limit" },
      // → NOT stale (pendingRestartReason cleared above)
      // → WITH FIX: quotaRetryCount = 0+1 = 1, sleep+post, pendingRestartReason="codex_usage_limit"
      // → WITHOUT FIX: quotaRetryCount = 6+1 = 7 > 6 → HALT (cap exceeded)
      { kind: "stopped", stopReason: "codex_usage_limit" },
      // → STALE (pending="codex_usage_limit"), clear pending, continue
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // Without the fix the session would be stopped with "looppilot_stopped" (quota cap).
    // With the fix the quota count is reloaded to 0 and the session eventually merges.
    expect(s.state).toBe("merged");
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

  it("in_progress かつ monitor_timeout デフォルト（60）→ 経過超過で stopped(exception, 'monitor timeout')", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 }); // default monitorTimeoutMinutes=60
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "in_progress" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-01T00:00:00.000Z" }); // 何日も前 → 60分超過
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("monitor timeout");
  });

  it("clock backward (NTP skew): monitorStartedAt in future → elapsed clamped to 0, session completes normally", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorTimeoutMinutes: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      // monitorStartedAt を遥か未来へ（クロック後退シナリオ）
      h.store.updateSession(s.id, { monitorStartedAt: "2099-01-01T00:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // クロック後退でも正常にマージ完了（タイムアウトガードが誤発動しない）
    expect(s.state).toBe("merged");
  });

  it("clock backward (NTP skew): in_progress verdict + monitorStartedAt in future → elapsed clamped to 0, timeout guard not triggered", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, monitorTimeoutMinutes: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // First poll: in_progress — this drives elapsedMinutesSinceMonitorStart through the
    // in_progress branch.  With monitorStartedAt in the far future the raw elapsed is a
    // large negative number; the Math.max(0, …) clamp must prevent the 1-minute timeout
    // guard from misfiring.  Subsequent polls complete normally.
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2099-01-01T00:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // elapsed clamped to 0 ≤ 1 min → guard does NOT fire → session merges normally
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
  });

  it("clock backward (NTP skew): not_engaged verdict + monitorStartedAt in future → elapsed clamped to 0, not-engaged guard not triggered", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, notEngagedGuardMinutes: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // First poll: not_engaged — this drives elapsedMinutesSinceMonitorStart through the
    // not_engaged branch.  With monitorStartedAt in the far future the raw elapsed is a
    // large negative number; the Math.max(0, …) clamp must prevent the 1-minute guard
    // (notEngagedGuardMinutes) from misfiring.  Subsequent polls complete normally.
    h.monitor.verdicts = [{ kind: "not_engaged" }, { kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2099-01-01T00:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // elapsed clamped to 0 ≤ 1 min → guard does NOT fire → session merges normally
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
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

describe("Orchestrator HALT memory commit — ES-452 Task 3", () => {
  it("commits memory files on halt when changes exist", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Override memory runner to simulate changes (add already stubbed in harness)
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    // Call requestStop before run() so HALT fires at first safe point (loop entry),
    // no source/agent/git setup needed.
    h.orch.requestStop();
    await h.orch.run();

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("skips memory commit on halt when no changes", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Default stub returns code 0 (no changes) — already set in harness

    h.orch.requestStop();
    await h.orch.run();

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeUndefined();
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("skips memory commit and aborts rebase when rebase fails on halt (ES-452 Findings 3 & 4)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Override: rebase fails, simulating conflicts between local memory edits and remote
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });
    // Memory has changes, but commit must NOT be called because rebase failed
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });

    h.orch.requestStop();
    await h.orch.run();

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeUndefined();
    const abortCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "rebase" && c.args.includes("--abort"),
    );
    expect(abortCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("skips memory commit when autostash pop leaves conflicts after successful rebase (ES-452 Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase exits 0 (success), but autostash pop left unmerged files
    h.memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], {
      code: 0,
      stdout: "100644 abc123 1\tdocs/memory/pm-decisions.md\n",
    });
    h.memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
    // Even though diff shows changes, commit must NOT be called
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });

    h.orch.requestStop();
    await h.orch.run();

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeUndefined();
    const checkoutCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args.includes("HEAD"),
    );
    expect(checkoutCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("rolls back unpushed memory commit when push fails on halt (ES-452 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });
    h.memoryRunner.on(["git", "push", "origin", "HEAD:main"], { code: 1, stderr: "remote: Permission denied" });
    h.memoryRunner.on(["git", "reset", "--hard", "HEAD~1"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    const resetCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args.includes("HEAD~1"),
    );
    expect(resetCall).toBeDefined();
    expect(resetCall?.args).toContain("--hard");
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("Orchestrator bootstrap memory commit — ES-452 Finding 1", () => {
  it("uses --hard reset to roll back bootstrap commit when push fails", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Bootstrap sees changes (diff returns code 1)
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });
    h.memoryRunner.on(["git", "push", "origin", "HEAD:main"], { code: 1, stderr: "error: push rejected" });
    h.memoryRunner.on(["git", "reset", "--hard", "HEAD~1"], { code: 0 });

    // Stop immediately so the test does not need a full task queue
    h.orch.requestStop();
    await h.orch.run();

    const resetCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args.includes("HEAD~1"),
    );
    // At least one reset must have occurred (bootstrap path)
    expect(resetCalls.length).toBeGreaterThan(0);
    // Every reset to HEAD~1 must use --hard so the working tree is cleaned
    expect(resetCalls.every((c) => c.args.includes("--hard"))).toBe(true);
  });
});

describe("Orchestrator HALT memory commit — non-interrupt halt paths — ES-452 Finding 2", () => {
  it("commits memory on task_cap halt when changes exist", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    // Simulate memory file changes during the run
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    await h.orch.run(); // completes 1 task then hits task_cap → halts

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.store.latestRun()!.haltReason).toContain("task cap reached");
  });

  it("commits memory on select_failed halt when changes exist", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.failNext("getAllEligible", new Error("Linear HTTP 503"));
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    await h.orch.run();

    const commitCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.store.latestRun()!.haltReason).toContain("select_failed");
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
    const inlineMemoryRunner2 = new FakeCommandRunner();
    inlineMemoryRunner2.on(["git", "fetch", "origin", "main"], { code: 0 });
    inlineMemoryRunner2.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    inlineMemoryRunner2.on(["git", "add", "docs/memory/"], { code: 0 });
    inlineMemoryRunner2.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
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
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: inlineMemoryRunner2,
      groomDeps: null,
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

describe("Orchestrator PM 選別ターン（ES-382 A1）", () => {
  it("planner ありで eligible 複数 → Codex が選んだチケットを CLAIM する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    // 2 eligible: TY-1 (Urgent), TY-2 (Medium)
    const ty1 = issue("id-1", "TY-1", { priority: 1 });
    const ty2 = issue("id-2", "TY-2", { priority: 3 });
    h.source.queue = [ty1, ty2];

    // Planner outcomes: first call is SELECT, second is PLAN
    planner.outcomes = [
      // SELECT: Codex picks TY-2 (not the deterministic first)
      { kind: "completed", text: '```json\n{"identifier":"TY-2","rationale":"Continues recent work"}\n```' },
      // PLAN: brief for the selected ticket
      { kind: "completed", text: "## Goal\nFix the thing" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-2"); // PM picked TY-2, not deterministic TY-1
    expect(sessions[0].selectRationale).toBe("Continues recent work");
  });

  it("planner ありで Codex 失敗 → 決定的順序にフォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1", { priority: 1 }), issue("id-2", "TY-2", { priority: 3 })];

    planner.outcomes = [
      // SELECT: Codex error
      { kind: "error", message: "codex timeout" },
      // PLAN: runs for TY-1 (fallback pick)
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic fallback
    expect(sessions[0].selectRationale).toContain("deterministic fallback");
  });

  it("planner ありで Codex が無効な identifier → 決定的順序にフォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    // 2 eligible so PM selection is actually invoked (with 1 eligible it is skipped)
    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];

    planner.outcomes = [
      // SELECT: Codex returns non-existent identifier
      { kind: "completed", text: '```json\n{"identifier":"TY-999","rationale":"does not exist"}\n```' },
      // PLAN
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].selectRationale).toContain("deterministic fallback");
  });

  it("planner ありで eligible が 1 件 → PM 選別スキップ、planner を SELECT に消費しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1")];

    // Only PLAN outcome (no SELECT since only 1 eligible)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    // planner called only once (PLAN), not twice (SELECT + PLAN)
    expect(planner.calls).toHaveLength(1);
  });

  it("planner なし → 決定的順序のまま（既存動作不変）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // no planner

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic first
    expect(sessions[0].selectRationale).toBeNull();
  });

  it("planner.run() が例外を throw → 決定的フォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];

    // SELECT: planner throws (no outcomes queued → FakePlanRunner throws)
    // We need to re-queue a PLAN outcome after the throw
    planner.outcomes = []; // empty → throws on first call (SELECT)

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // Override planner to throw on first call, succeed on second
    let callCount = 0;
    const origRun = planner.run.bind(planner);
    planner.run = async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error("codex crashed");
      planner.outcomes = [{ kind: "completed", text: "## Goal\nPlan" }];
      return origRun(ctx);
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic fallback
    expect(sessions[0].selectRationale).toContain("deterministic fallback");
    expect(sessions[0].selectRationale).toContain("codex exception");
  });

  it("Codex が JSON を含まないテキストを返す → パース失敗で決定的フォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];

    planner.outcomes = [
      // SELECT: returns prose without JSON
      { kind: "completed", text: "I think TY-2 is the best choice because it continues the auth work." },
      // PLAN
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic fallback
    expect(sessions[0].selectRationale).toBe("deterministic fallback: parse failure");
    // Verify log contains raw output preview
    expect(h.logs.some((l) => l.includes("Raw output:"))).toBe(true);
  });

  it("Codex interrupted → HALT（安全停止）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];

    planner.outcomes = [
      { kind: "interrupted" },
    ];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // No sessions created (interrupted before CLAIM)
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
  });

  it("passes codebase summary to buildSelectPrompt", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '{"identifier":"TY-2","rationale":"has summary context"}' },
    ];
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("a", "TY-1"), issue("b", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // SELECT プロンプトにコードベースサマリが含まれることを確認
    const selectPrompt = planner.calls[0]?.prompt ?? "";
    expect(selectPrompt).toContain("Codebase Structure");
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

  it("returns HALT when interrupted mid-sleep (after some chunks complete)", async () => {
    const config = makeConfig();
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const agent = new FakeAgentRunner();
    const git = new FakeGitPr();
    const monitor = new FakeMonitor();
    const notifier = new FakeNotifier();
    const sleepCalls: number[] = [];
    const clock = fixedClock("2026-06-21T00:00:00.000Z");
    let orchRef: Orchestrator | null = null;
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      if (sleepCalls.length === 2 && orchRef) {
        orchRef.requestStop();
      }
    };
    const inlineMemoryRunner3 = new FakeCommandRunner();
    inlineMemoryRunner3.on(["git", "fetch", "origin", "main"], { code: 0 });
    inlineMemoryRunner3.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    inlineMemoryRunner3.on(["git", "add", "docs/memory/"], { code: 0 });
    inlineMemoryRunner3.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    const orch = new Orchestrator({
      config, source, agent, git, monitor, notifier, store,
      buildPrompt: () => "prompt", specLoader: null, clock, sleep,
      log: () => {}, recovery: new FakeWorkflowRecovery(), planner: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: inlineMemoryRunner3,
      groomDeps: null,
    });
    orchRef = orch;

    const run = store.createRun(5, clock());
    (orch as any).runId = run.id;

    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };

    const result = await orch.interruptablePause(meta, 60_000, 10_000);

    expect(result.control).toBe("halt");
    // Slept twice before interrupt was detected on 3rd iteration
    expect(sleepCalls).toEqual([10_000, 10_000]);

    const pausedEvents = notifier.events.filter((e) => e.kind === "paused");
    expect(pausedEvents).toHaveLength(1);
    const resumedEvents = notifier.events.filter((e) => e.kind === "resumed");
    expect(resumedEvents).toHaveLength(0);

    const halted = store.getRun(run.id);
    expect(halted.state).toBe("halted");
    expect(halted.pauseMeta).toBeNull();

    store.close();
  });
});

describe("Orchestrator — Codex Recovery Turn (ES-450)", () => {
  it("ci_failed triggers recovery -> fix_code -> session resumes monitoring and merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // Recovery fix agent outcome
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    // Monitor: done(ci_failed) triggers stopSession -> recovery succeeds -> back to monitoring
    // After recovery: done(ready) -> merged
    h.monitor.verdicts = [
      { kind: "done" },   // 1st poll: tryMerge -> ci_failed -> recovery gate
      { kind: "done" },   // 2nd poll: after recovery, tryMerge -> ready -> merged
    ];
    h.monitor.readiness = new Map();
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" };
      return { ready: true, headSha: `sha-${pr}` };
    };
    // Plan phase outcome (for initial PLAN)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nFix it" },
      // Recovery Codex outcome: fix_code
      { kind: "completed", text: '{"action":"fix_code","instruction":"Run npm install"}' },
    ];
    // Stub git operations for recovery (FakeCommandRunner for log specifically)
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("fix_code");
    expect(s.state).toBe("merged");
    // Cost includes recovery agent cost
    expect(s.costUsd).toBeCloseTo(1.5);
    // recovery_started and recovery_succeeded notifications
    const recoveryStarted = h.notifier.events.filter((e) => e.kind === "recovery_started");
    expect(recoveryStarted).toHaveLength(1);
    const recoverySucceeded = h.notifier.events.filter((e) => e.kind === "recovery_succeeded");
    expect(recoverySucceeded).toHaveLength(1);
  });

  it("cost_exceeded skips recovery entirely", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, maxCostUsdPerSession: 0.5 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // PLAN outcome
    planner.outcomes = [{ kind: "completed", text: "## Goal\nDo it" }];
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 0.6 }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.recoveryAttempted).toBe(0);
    // No recovery notifications
    const recoveryEvents = h.notifier.events.filter(
      (e) => e.kind === "recovery_started" || e.kind === "recovery_succeeded",
    );
    expect(recoveryEvents).toHaveLength(0);
  });

  it("recovery escalation -> no recovery, just halt", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    // Monitor: human_required stop (not auto_restart category) -> triggers stopSession
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: null },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery: codex says escalate
      { kind: "completed", text: '{"action":"escalate"}' },
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("escalate");
  });

  it("second stop after recovery attempted -> no recovery, just halt", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // Recovery fix agent outcome (for restart_review recovery)
    ];
    // Monitor: merge_conflict -> recovery succeeds with restart_review -> back to monitoring
    // Then: pr_closed -> stopSession again, but recoveryAttempted is already 1, so no second recovery
    h.monitor.verdicts = [
      { kind: "done" },     // 1st: tryMerge -> conflict -> recovery (restart_review)
      { kind: "pr_closed" }, // 2nd: stopSession -> recoveryAttempted=1, skip recovery -> halt
    ];
    h.monitor.readiness = new Map();
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "conflict" };
      return { ready: true, headSha: `sha-${pr}` };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery: restart_review (simple, no agent cost)
      { kind: "completed", text: '{"action":"restart_review"}' },
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Final state is stopped from pr_closed (second stop, no recovery)
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("restart_review");
  });

  it("recovery with no planner -> skips recovery entirely", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // no planner
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.recoveryAttempted).toBe(0);
    // No recovery notifications
    const recoveryEvents = h.notifier.events.filter(
      (e) => e.kind === "recovery_started" || e.kind === "recovery_succeeded",
    );
    expect(recoveryEvents).toHaveLength(0);
  });

  it("recovery codex exception -> falls through to normal stop", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery codex call: throws (no outcome queued -> FakePlanRunner throws)
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.recoveryAttempted).toBe(1);
    // Exception during recovery -> escalated action
    expect(s.recoveryAction).toBe("escalate");
    // Log contains recovery codex exception
    expect(h.logs.some((l) => l.includes("recovery: codex exception"))).toBe(true);
  });

  // Finding 1: an interrupt during recovery must not consume the recoveryAttempted flag
  it("recovery interrupted → recoveryAttempted stays 0, session stays in_review, run halted", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery Codex is interrupted before choosing an action
      { kind: "interrupted" },
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Interrupt must NOT consume the recovery gate — next run can retry
    expect(s.recoveryAttempted).toBe(0);
    // Session was not stopped (interrupt halts the run before stopSession completes)
    expect(s.state).toBe("in_review");
    // Run is halted
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  // ES-450 Finding 2: after auto-restart cap exceeded + recovery succeeds, pendingRestartReason
  // must be reloaded so the stale guard fires on the next poll instead of re-exhausting the counter.
  it("auto-restart limit exceeded + recovery fix_code → pendingRestartReason reloaded, stale guard fires next poll", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // Recovery fix agent: succeeds
      { kind: "completed", costUsd: 0.5, summary: "fixed" },
    ];
    // 4 consecutive stopped verdicts with DIFFERENT stop reasons bypass the stale guard,
    // hitting the auto-restart cap on poll 4. Recovery sets pendingRestartReason = "test_failure".
    // Poll 5: "test_failure" → stale guard fires (only with the fix; without fix the counter
    //         is re-incremented, recoveryAttempted blocks recovery, and the session stops).
    // Poll 6: merged.
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "workflow_crashed" },    // auto_restart #1
      { kind: "stopped", stopReason: "action_timeout" },      // auto_restart #2
      { kind: "stopped", stopReason: "max_turns_exceeded" },  // auto_restart #3
      { kind: "stopped", stopReason: "test_failure" },        // cap exceeded → recovery fires
      { kind: "stopped", stopReason: "test_failure" },        // stale guard (pendingRestartReason reloaded)
      { kind: "merged" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nDo it" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the test failure"}' },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Stale guard fires at poll 5, then merges at poll 6
    expect(s.state).toBe("merged");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("fix_code");
  });

  // Finding 2: after an abandon recovery the abandoned ticket must not be immediately reselected
  it("abandon recovery: abandoned ticket excluded from subsequent SELECT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    // Single issue so selectWithPm is skipped (eligible.length===1), keeping planner outcomes simple
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nDo the work" }, // PLAN phase
      { kind: "completed", text: '{"action":"abandon"}' },  // Recovery Codex chooses abandon
    ];
    // Stop after the second SELECT so the loop doesn't run indefinitely.
    // eligibleCalls is populated inside origGetAllEligible; we don't push here to avoid duplicates.
    let selectCount = 0;
    const origGetAllEligible = h.source.getAllEligible.bind(h.source);
    h.source.getAllEligible = async (excludeIds: string[]) => {
      selectCount += 1;
      if (selectCount >= 2) h.orch.requestStop();
      return origGetAllEligible(excludeIds);
    };

    await h.orch.run();

    // Second SELECT must include issue-A in the exclude list (abandoned ticket blocked)
    expect(h.source.eligibleCalls.length).toBeGreaterThanOrEqual(2);
    const secondSelectExcluded = h.source.eligibleCalls[1];
    expect(secondSelectExcluded).toContain("issue-A");
  });

  // ES-450 Finding (iteration 8): pr_closed is terminal — recovery must not run even when
  // recoveryTurn is configured and recoveryAttempted is still 0.
  it("pr_closed with planner configured → no recovery, stops with pr_closed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // Monitor: pr_closed immediately (before any recovery attempt)
    h.monitor.verdicts = [{ kind: "pr_closed" }];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // No second outcome queued — recovery must NOT call the planner
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    // Recovery must be skipped — recoveryAttempted stays 0 (the pr_closed gate fires first)
    expect(s.recoveryAttempted).toBe(0);
    // No recovery notifications
    const recoveryEvents = h.notifier.events.filter(
      (e) => e.kind === "recovery_started" || e.kind === "recovery_succeeded",
    );
    expect(recoveryEvents).toHaveLength(0);
  });

  // ES-450 Finding 1 (iteration 9): when handoff_failed recovery succeeds, addLabel and
  // transition(in_review) must be retried before flipping to in_review so the gate label is
  // present and LoopPilot can engage — without the retry the PR lacks the label and the run
  // later stops as monitor_never_engaged instead of recovering the transient handoff failure.
  it("handoff_failed recovery retries addLabel and transition(in_review) before flipping to in_review", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // Force PR creation to #100
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // addLabel fails for the initial handoff (3 retries) but succeeds on recovery retry.
    let addLabelCalls = 0;
    h.git.addLabel = async (prNumber: number, label: string): Promise<void> => {
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      addLabelCalls++;
      if (addLabelCalls <= 3) throw new Error("gh: label not found");
      // 4th+ call (from recovery retry) succeeds
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nDo the thing" },
      // Recovery codex chooses restart_review
      { kind: "completed", text: '{"action":"restart_review"}' },
    ];
    // After recovery flips to in_review, monitor immediately merges
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.recoveryAction).toBe("restart_review");
    // addLabel was retried in the recovery path (calls > 3 initial failures)
    expect(addLabelCalls).toBeGreaterThan(3);
    // transition(in_review) was retried during recovery before the session flipped
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "in_review" });
    // Session fully recovered and merged
    expect(s.state).toBe("merged");
  });

  // ES-450 Finding (iteration 8): failed abandon must not record recovery_action so
  // stoppedSessionsWithPr can pick the session up again on the next daemon start.
  // ES-450 Finding 2 (iteration 10): failed cleanup must also leave recoveryAttempted=0
  // so a future recovery path can retry the cleanup rather than skipping executeRecoveryTurn.
  it("failed abandon does not set recoveryAction or recoveryAttempted, allowing retry", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      { kind: "completed", text: '{"action":"abandon"}' },
    ];
    // Make gh pr close fail so abandon returns { kind: "failed" }
    h.recoveryRunner.on(["gh", "pr", "close"], { code: 1, stderr: "PR not found" });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    // recoveryAttempted must stay 0 for failed cleanup — the gate is not consumed so a
    // future recovery path can retry (ES-450 Finding 2).
    expect(s.recoveryAttempted).toBe(0);
    // recoveryAction must NOT be 'abandon' — the cleanup did not complete, so startup
    // recovery must be able to pick this session up via stoppedSessionsWithPr.
    expect(s.recoveryAction).toBeNull();
  });

  // ES-450 Finding 1 (iteration 10): stale guard must fire on the poll immediately
  // after done-path recovery so a stale ci_failed/merge_conflict verdict does not
  // trigger a second stopSession with recoveryAttempted already set.
  it("ci_failed recovery stale guard fires once then merge succeeds on next poll", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    // done verdict repeated — FakeMonitor keeps returning the last element
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness = new Map();
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      // Poll 1: ci_failed → recovery fires. Poll 2: stale guard skips tryMerge.
      // Poll 3: ready → merge.
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" };
      return { ready: true, headSha: `sha-${pr}` };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nFix it" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Run npm install"}' },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("merged");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("fix_code");
    // Readiness was called exactly twice: once for ci_failed (poll 1) and once for
    // ready (poll 3). The stale guard on poll 2 must skip tryMerge entirely.
    expect(h.monitor.readinessCalls).toHaveLength(2);
  });

  // ES-450 Finding 1 (iteration 10): same stale guard for merge_conflict + rebase.
  it("merge_conflict recovery stale guard fires once then merge succeeds", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness = new Map();
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "conflict" };
      return { ready: true, headSha: `sha-${pr}` };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nRebase" },
      { kind: "completed", text: '{"action":"rebase"}' },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("rebase")) return { code: 0 };
      return { code: 0 };
    });
    h.recoveryRunner.on(["git", "push"], { code: 0 });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("merged");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("rebase");
    // Stale guard must skip tryMerge on poll 2 — readiness called only twice.
    expect(h.monitor.readinessCalls).toHaveLength(2);
  });

  // ES-450 Finding 3 (iteration 10): when recovery fails after doing useful work,
  // stopDetail must carry the recovery failure message so operators can diagnose.
  it("failed fix_code recovery includes recovery failure message in stopDetail", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "completed", costUsd: 0.4, summary: "fixed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' },
    ];
    // Agent makes commits but push fails — recovery returns { kind: "failed", message: "recovery push failed: ..." }
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    h.recoveryRunner.on(["git", "push"], { code: 1, stderr: "rejected" });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    // stopDetail must include the recovery failure message (ES-450 Finding 3).
    expect(s.stopDetail).toContain("recovery failed:");
    expect(s.stopDetail).toContain("recovery push failed");
    // The halted notification detail must also carry the recovery failure message.
    const haltedEvent = h.notifier.events.find((e) => e.kind === "halted");
    expect(haltedEvent).toBeDefined();
    expect((haltedEvent as { kind: "halted"; reason: string; detail: string }).detail).toContain("recovery failed:");
  });
});

describe("Orchestrator memory read non-fatal (ES-454 Finding 4)", () => {
  const tmpRepos: string[] = [];
  afterEach(() => {
    for (const d of tmpRepos.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeBadMemoryRepo(): string {
    const repoPath = mkdtempSync(path.join(tmpdir(), "orch-mem-test-"));
    tmpRepos.push(repoPath);
    // Create the memory directory and make one file a directory so readFileSync throws EISDIR
    const memDir = path.join(repoPath, "docs", "memory");
    mkdirSync(memDir, { recursive: true });
    // pm-decisions.md is a directory → readFileSync will throw EISDIR
    mkdirSync(path.join(memDir, "pm-decisions.md"));
    return repoPath;
  }

  it("SELECT proceeds when readMemoryAll throws (ES-454 Finding 4)", async () => {
    const repoPath = makeBadMemoryRepo();
    const planner = new FakePlanRunner();
    planner.outcomes = [
      // SELECT call
      { kind: "completed" as const, text: '```json\n{"identifier":"TY-1","rationale":"ok"}\n```' },
    ];
    const config = { ...makeConfig({ maxTasksPerRun: 1 }), repo: { ...makeConfig().repo, path: repoPath } } as Config;
    const h = makeHarness(config, { planner });
    h.source.queue = [
      issue("issue-A", "TY-1"),
      issue("issue-B", "TY-2"),
    ];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Run completed normally despite memory read failure
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s).toBeDefined();
    expect(["merged", "stopped"]).toContain(s!.state);
    expect(h.logs.some((l) => l.includes("memory read failed"))).toBe(true);
  });

  it("IMPLEMENT proceeds when readMemoryAll throws (ES-454 Finding 4)", async () => {
    // IMPLEMENT now reads memory from worktreePath, so bad memory must be there.
    const badWorktreePath = mkdtempSync(path.join(tmpdir(), "orch-mem-wt-test-"));
    tmpRepos.push(badWorktreePath);
    const wtMemDir = path.join(badWorktreePath, "docs", "memory");
    mkdirSync(wtMemDir, { recursive: true });
    // pm-decisions.md is a directory → readFileSync will throw EISDIR
    mkdirSync(path.join(wtMemDir, "pm-decisions.md"));

    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: badWorktreePath });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s).toBeDefined();
    expect(["merged", "stopped"]).toContain(s!.state);
    expect(h.logs.some((l) => l.includes("memory read failed"))).toBe(true);
  });
});

describe("GROOM Orchestrator Integration (ES-457)", () => {
  it("GROOM → SELECT → CLAIM → IMPLEMENT → HANDOFF → MONITOR → DONE flow", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM Codex output: one reprioritize action
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":2,"rationale":"urgent"}],"summary":"Reprioritized ES-1"}\n```',
    });
    // Make ES-1 a known opted-in project issue for validation
    h.groomBoardFetcher.projectIssueIds = new Set(["ES-1"]);
    h.groomBoardFetcher.optInIssueIds = new Set(["ES-1"]);

    // SELECT Codex output — need 2 eligible issues so selectWithPm calls planner
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"only candidate"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Verify GROOM ran: board was fetched and a groom_log entry exists
    expect(h.groomBoardFetcher.calls).toContain("getBoardState");
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("completed");
    expect(groomLog.summary).toBe("Reprioritized ES-1");
    // Verify the reprioritize action was executed on the linear client
    expect(h.groomLinearClient.calls.some(c => c.method === "updatePriority")).toBe(true);
    // Verify session completed
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");
  });

  it("groom.enabled=false skips GROOM", async () => {
    const planner = new FakePlanRunner();
    const config = { ...makeConfig({ maxTasksPerRun: 1 }), groom: { enabled: false } } as unknown as Config;
    const h = makeHarness(config, { planner });

    // Need 2 issues to trigger SELECT planner call; queue SELECT + PLAN outcomes
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });
    // PLAN outcome (so it doesn't throw/fall back)
    planner.outcomes.push({ kind: "error", message: "no brief needed" });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Board fetcher was never called (GROOM never ran)
    expect(h.groomBoardFetcher.calls).toHaveLength(0);
    // No groom log created (GROOM skipped entirely)
    expect(() => h.store.getGroomLog(1)).toThrow();
    // Session still completed
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");
  });

  it("Codex failure skips GROOM and proceeds to SELECT", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM Codex fails
    planner.outcomes.push({ kind: "error", message: "codex crashed" });
    // SELECT succeeds (2 issues needed to trigger SELECT planner call)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });
    // PLAN falls back gracefully (no outcome queued, throws → caught by plan())

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Session still completed despite GROOM failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");
    // groom_log records the error
    expect(h.logs.some((l) => l.includes("groom: codex failed, skipping"))).toBe(true);
    // groom_log outcome is "error"
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("error");
  });

  it("GROOM summary is included in SELECT context", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM succeeds with summary
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[],"summary":"Board looks good, no changes needed."}\n```',
    });
    // SELECT — capture the prompt to verify GROOM summary injection
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    // Need 2 issues so selectWithPm actually calls the planner
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The SELECT prompt (2nd planner call) should contain the GROOM summary
    const selectPrompt = planner.calls[1]!.prompt;
    expect(selectPrompt).toContain("Recent GROOM Results");
    expect(selectPrompt).toContain("Board looks good");
  });

  it("groom_log is recorded correctly", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":1,"rationale":"urgent"}],"summary":"Bumped ES-1"}\n```',
    });
    h.groomBoardFetcher.projectIssueIds = new Set(["ES-1"]);
    h.groomBoardFetcher.optInIssueIds = new Set(["ES-1"]);

    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Verify groom_log was recorded
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.runId).toBe(h.store.latestRun()!.id);
    expect(groomLog.loopIndex).toBe(1);
    expect(groomLog.outcome).toBe("completed");
    expect(groomLog.summary).toBe("Bumped ES-1");
    expect(groomLog.actionsRequested).toBe(1);
    expect(groomLog.actionsExecuted).toBe(1);
    expect(groomLog.actionsRejected).toBe(0);
    expect(groomLog.actionDetails).not.toBeNull();
  });

  it("SIGINT interrupts GROOM during action execution", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM output with 2 actions — we'll interrupt after the first
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":1,"rationale":"a"},{"type":"reprioritize","issueId":"ES-2","priority":2,"rationale":"b"}],"summary":"Two changes"}\n```',
    });
    h.groomBoardFetcher.projectIssueIds = new Set(["ES-1", "ES-2"]);
    h.groomBoardFetcher.optInIssueIds = new Set(["ES-1", "ES-2"]);

    // After first action executes, request stop
    let callCount = 0;
    const originalCalls = h.groomLinearClient.calls;
    // Override updatePriority to trigger interrupt after 1st call.
    (h.groomLinearClient as unknown as Record<string, unknown>).updatePriority = async (issueId: string, priority: number) => {
      originalCalls.push({ method: "updatePriority", args: [issueId, priority] });
      callCount++;
      if (callCount >= 1) {
        h.orch.requestStop();
      }
    };

    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    // Run should halt (not continue to SELECT)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");

    // groom_log records partial execution
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("skipped");
    expect(groomLog.errorDetail).toContain("interrupted");
  });

  it("Codex exception (thrown) skips GROOM and proceeds to SELECT", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // Override planner.run to throw on first call (GROOM), succeed on second call (SELECT)
    let callCount = 0;
    const origRun = planner.run.bind(planner);
    planner.run = async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error("codex process crashed");
      return origRun(ctx);
    };

    // SELECT outcome
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("error");
    expect(groomLog.errorDetail).toContain("codex exception");
  });

  it("GROOM parse failure records error in groom_log and skips to SELECT", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM returns unparseable output
    planner.outcomes.push({ kind: "completed", text: "not json at all" });
    // SELECT succeeds
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("error");
    expect(groomLog.errorDetail).toContain("parse failed");
  });

  it("SIGINT during GROOM Codex run halts cleanly", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    planner.outcomes.push({ kind: "interrupted" });

    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("skipped");
    expect(groomLog.errorDetail).toContain("interrupted");
  });

  it("SIGINT during GROOM Codex reported as error (not interrupted) still halts before SELECT", async () => {
    // Finding 2: CodexPlanner can surface a killed child as kind:"error" rather than
    // kind:"interrupted". Verify that the interrupted flag check after groom() returns
    // prevents the loop from continuing into SELECT.
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    let callCount = 0;
    const origRun = planner.run.bind(planner);
    planner.run = async (ctx) => {
      callCount++;
      if (callCount === 1) {
        // Simulate: SIGINT caused Codex to exit with non-zero code, but
        // CodexPlanner reports it as 'error' rather than 'interrupted'.
        h.orch.requestStop();
        return { kind: "error", message: "Codex exited with code 130" };
      }
      return origRun(ctx);
    };

    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    // Loop must halt, not proceed to SELECT (no sessions created).
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
    // GROOM log records the error (not interrupted, since that's what CodexPlanner reported)
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("error");
  });

  it("board fetch failure skips GROOM and session still completes", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // Make getBoardState throw
    h.groomBoardFetcher.failNext("getBoardState", new Error("network timeout"));

    // SELECT succeeds (2 issues needed to trigger planner call)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Session should still complete despite GROOM board fetch failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");

    // groom_log records a skip with the board fetch error detail
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("skipped");
    expect(groomLog.errorDetail).toContain("board fetch failed");
  });

  it("validation context fetch failure skips GROOM execution and session still completes", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM parse succeeds, but getProjectIssueIds throws during validation context fetch
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":2,"rationale":"urgent"}],"summary":"Reprioritized ES-1"}\n```',
    });
    h.groomBoardFetcher.failNext("getProjectIssueIds", new Error("db locked"));

    // SELECT succeeds
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Session should still complete despite GROOM validation context failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");

    // groom_log records error with validation context fetch error detail
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("error");
    expect(groomLog.errorDetail).toContain("validation context fetch failed");
  });

  it("individual action failure continues to next action", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM output with 2 reprioritize actions
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":1,"rationale":"a"},{"type":"reprioritize","issueId":"ES-2","priority":2,"rationale":"b"}],"summary":"Two changes"}\n```',
    });
    h.groomBoardFetcher.projectIssueIds = new Set(["ES-1", "ES-2"]);
    h.groomBoardFetcher.optInIssueIds = new Set(["ES-1", "ES-2"]);

    // Make first action fail, second succeed
    let callCount = 0;
    (h.groomLinearClient as any).updatePriority = async (issueId: string, priority: number) => {
      h.groomLinearClient.calls.push({ method: "updatePriority", args: [issueId, priority] });
      callCount++;
      if (callCount === 1) throw new Error("Linear API timeout");
    };

    // SELECT outcome
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Session completes despite action failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    // Both actions attempted: first failed, second succeeded
    expect(h.groomLinearClient.calls.filter(c => c.method === "updatePriority")).toHaveLength(2);

    // groom_log records 1 executed (second succeeded), 0 rejected
    const groomLog = h.store.getGroomLog(1);
    expect(groomLog.outcome).toBe("completed");
    expect(groomLog.actionsRequested).toBe(2);
    expect(groomLog.actionsExecuted).toBe(1);

    // Log should contain failure message
    expect(h.logs.some(l => l.includes("action failed") && l.includes("Linear API timeout"))).toBe(true);
  });

  it("marks update_memory result as failed when git commit fails during GROOM (Finding 2)", async () => {
    // Use a real tmpdir so writeCategory can write the memory file before commitIfChanged is called.
    const tmpRepo = mkdtempSync(path.join(tmpdir(), "groom-commit-fail-"));
    try {
      mkdirSync(path.join(tmpRepo, "docs", "memory"), { recursive: true });

      const planner = new FakePlanRunner();
      const config = {
        ...makeConfig({ maxTasksPerRun: 1, groomEnabled: true }),
        repo: { ...makeConfig().repo, path: tmpRepo },
      } as Config;
      const h = makeHarness(config, { planner });

      // GROOM Codex output: one update_memory action (writeCategory will succeed to the tmpdir)
      planner.outcomes.push({
        kind: "completed",
        text: '```json\n{"actions":[{"type":"update_memory","category":"pm_decisions","content":"Test decision","rationale":"update"}],"summary":"Updated memory"}\n```',
      });
      // Make git add fail so commitIfChanged throws; the catch block should mark the action as failed.
      h.memoryRunner.on(["git", "add", "docs/memory/"], { code: 1, stderr: "fatal: index.lock exists" });

      // SELECT outcome (2 issues needed to trigger the planner)
      planner.outcomes.push({
        kind: "completed",
        text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
      });
      h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
      h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
      h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

      await h.orch.run();

      // groom_log must show 0 executed: the update_memory action was retroactively marked failed
      const groomLog = h.store.getGroomLog(1);
      expect(groomLog.outcome).toBe("completed");
      expect(groomLog.actionsRequested).toBe(1);
      expect(groomLog.actionsExecuted).toBe(0);

      // actionDetails must record the action as failed with the commit error message
      const details = JSON.parse(groomLog.actionDetails!) as Array<{ type: string; result: string; reason?: string }>;
      expect(details[0].result).toBe("failed");
      expect(details[0].reason).toContain("memory commit failed");

      // Log must mention the commit failure
      expect(h.logs.some(l => l.includes("memory commit failed"))).toBe(true);

      // summaryForSelect should be annotated with the execution shortfall
      const selectPrompt = planner.calls[1]!.prompt;
      expect(selectPrompt).toContain("Updated memory [0/1 executed]");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("memory directory is reset even when no update_memory actions are present (ES-457 Finding 1)", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM output with no update_memory actions — only a reprioritize
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[{"type":"reprioritize","issueId":"ES-1","priority":2,"rationale":"urgent"}],"summary":"Reprioritized"}\n```',
    });
    h.groomBoardFetcher.projectIssueIds = new Set(["ES-1"]);
    h.groomBoardFetcher.optInIssueIds = new Set(["ES-1"]);

    // SELECT outcome
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The full-checkout reset commands must have run even though no update_memory actions exist.
    // Finding 3: reset uses "." (full tree), not "docs/memory/" (memory-only).
    const checkoutCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args.includes("HEAD") && c.args.includes("."),
    );
    expect(checkoutCall).toBeDefined();
    const cleanCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "clean" && c.args.includes("-fd") && !c.args.includes("docs/memory/"),
    );
    expect(cleanCall).toBeDefined();
  });

  it("codex error cleanup resets to startSha to undo any Codex-created commits (ES-457 Finding 1)", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM Codex returns error (simulating Codex creating a commit and then erroring)
    planner.outcomes.push({ kind: "error", message: "codex crashed mid-groom" });

    // SELECT outcome (2 issues needed to trigger the planner)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // git reset --hard <startSha> must have been called during the codex-error cleanup
    const resetCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard" && c.args[2] === "abc1234",
    );
    expect(resetCalls.length).toBeGreaterThan(0);
    // Session still completed despite GROOM failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");
  });

  it("parse failure cleanup resets to startSha to undo any Codex-created commits (ES-457 Finding 1)", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM returns unparseable output
    planner.outcomes.push({ kind: "completed", text: "not valid json at all" });

    // SELECT outcome (2 issues needed to trigger the planner)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // git reset --hard <startSha> must have been called during the parse-failure cleanup
    const resetCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard" && c.args[2] === "abc1234",
    );
    expect(resetCalls.length).toBeGreaterThan(0);
    // Session still completed despite GROOM failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("merged");
  });

  it("GROOM-blocked issues are excluded from SELECT eligible list (ES-457 Finding 2)", async () => {
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // GROOM output: no actions, summary only
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[],"summary":"TY-1 blocked by ES-99, skipping"}\n```',
    });

    // GROOM board state: TY-1 is blocked, TY-2 is eligible
    h.groomBoardFetcher.boardState = {
      eligible: [{ identifier: "TY-2", title: "Title for TY-2", priority: 2, labels: [] }],
      inProgress: [],
      recentDone: [],
      blocked: [{ identifier: "TY-1", title: "Title for TY-1", priority: 2, labels: [], blockedBy: "ES-99" }],
    };

    // Both issues are in the task source queue
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Only TY-2 should have been claimed; TY-1 must not appear in any session
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.linearIdentifier).toBe("TY-2");
    // TY-1 must never have been transitioned to in_progress
    expect(h.source.transitions.some((t) => t.issueId === "issue-A" && t.state === "in_progress")).toBe(false);
  });
});

describe("isPidAlive — EPERM handling (ES-464)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when process.kill succeeds (process alive, same user)", () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(isPidAlive(1234)).toBe(true);
  });

  it("returns false when process.kill throws ESRCH (process does not exist)", () => {
    const err = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    vi.spyOn(process, "kill").mockImplementation(() => { throw err; });
    expect(isPidAlive(99999)).toBe(false);
  });

  it("returns true when process.kill throws EPERM (process exists, no permission)", () => {
    const err = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => { throw err; });
    expect(isPidAlive(1)).toBe(true);
  });
});
