import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
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
import type { EligibleIssue, PromptArgs, PlanRunner, PauseMeta, MergeReadiness } from "../src/types.js";

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
  idleTimeoutMinutes: number;
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
      designTimeoutMinutes: 15,
      maxCostUsdPerDesign: 2,
      designReviewTimeoutMinutes: 15,
      maxDesignReviewAttempts: 2,
      selectDiffBudgetChars: 6000,
      selectCodebaseSummaryBudgetChars: 5000,
      groomTimeoutMinutes: 10,
      groomBoardBudgetChars: 10000,
      selfReviewTimeoutMinutes: 15,
      maxCostUsdPerSelfReview: 2,
      maxVerifyAttempts: 2,
      maxCostUsdPerVerify: 2,
      verifyTimeoutMinutes: 15,
      maxRecoveryAttempts: 2,
      transientRetryAttempts: 2,
      mergeGateTimeoutMinutes: 15,
      maxMergeGateFixAttempts: 2,
      maxCostUsdPerMergeGateFix: 2,
      maxCostUsdPerScout: 2,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
      idleTimeoutMinutes: over.idleTimeoutMinutes ?? 120,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
    notify: { progress: over.notifyProgress ?? false },
    groom: { enabled: over.groomEnabled ?? false },
    mergeGate: { enabled: true },
    selfReview: { enabled: true },
    verify: { enabled: true, runRecipe: "" },
    scout: { enabled: false, idleMinutes: 30, minIntervalHours: 24, maxIssuesPerScout: 3 },
    memory: { maxCharsPerFile: 8000, injectBudgetChars: 6000 },
    linear: { optInLabel: "looppilot-os", needsHumanLabel: "needs-human", scoutLabel: "scout", scoutTriageLabel: "scout-triage", team: "ENG", project: "LoopPilot", states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" } },
    pm: undefined,
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
  verifyAgent: FakeAgentRunner;
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

function makeHarness(config: Config, opts?: { planner?: PlanRunner | null; designer?: PlanRunner | null; designReviewer?: PlanRunner | null; mergeGateJudge?: PlanRunner | null; selfReviewAgent?: FakeAgentRunner; verifyAgent?: FakeAgentRunner; getDescendantPids?: (rootPid: number) => Set<number> | null; getReparentedPids?: (pids: number[]) => Set<number>; checkPidAlive?: (pid: number) => boolean; store?: SqliteStore }): Harness {
  const store = opts?.store ?? new SqliteStore(":memory:");
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
  const designer = opts?.designer ?? null;
  const designReviewer = opts?.designReviewer ?? null;
  const mergeGateJudge = opts?.mergeGateJudge ?? null;
  const memoryRunner = new FakeCommandRunner();
  memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
  memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
  memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
  memoryRunner.on(["git", "add", "-f", "--"], { code: 0 });
  memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
  // GROOM always resets the memory directory before executing actions (ES-457 Finding 1).
  memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "clean", "-fdx", "--", "docs/memory/"], { code: 0 });
  // GROOM full-checkout reset after Codex runs (ES-457 Findings 3 + 4).
  // -fd (not -fdx) for the full tree; -fdx -- docs/memory/ separately (ES-503 Finding 1).
  memoryRunner.on(["git", "checkout", "HEAD", "--", "."], { code: 0 });
  memoryRunner.on(["git", "clean", "-fd"], { code: 0 });
  memoryRunner.on(["git", "clean", "-fdx"], { code: 0 });
  // Design reviewer branch restore — git checkout <session.branch> (ES-477 Finding 4).
  memoryRunner.on(["git", "checkout"], { code: 0 });
  // GROOM startSha recording and HEAD reset before memory commit (ES-457 Finding 1).
  memoryRunner.on(["git", "rev-parse", "HEAD"], { code: 0, stdout: "abc1234\n" });
  memoryRunner.on(["git", "reset", "--hard"], { code: 0 });
  // ES-470 fallback: unstage staged memory files when commitIfChanged throws.
  memoryRunner.on(["git", "reset", "HEAD", "--", "docs/memory/"], { code: 0 });
  // Halt-path local-only commit check (ES-503 Finding 4): default to not ahead.
  memoryRunner.on(["git", "rev-list", "--count"], { code: 0, stdout: "0\n" });
  // Self-review branch verification (Finding 4): git -C <worktreePath> rev-parse / checkout
  memoryRunner.on(["git", "-C"], (args, _opts) => {
    if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
      const cIdx = args.indexOf("-C");
      const wtPath = cIdx >= 0 && cIdx + 1 < args.length ? args[cIdx + 1] : "";
      const slug = wtPath.replace(/^\/wt\//, "");
      return { code: 0, stdout: `looppilot/${slug}-x\n` };
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return { code: 0, stdout: "abc1234\n" };
    }
    return { code: 0, stdout: "" };
  });
  // Process cleanup stubs for VERIFY (ES-494)
  memoryRunner.on(["lsof", "+D"], { code: 1, stdout: "" });
  memoryRunner.on(["kill", "-TERM"], { code: 0 });
  memoryRunner.on(["kill", "-KILL"], { code: 0 });
  const groomBoardFetcher = new FakeGroomBoardFetcher();
  const groomLinearClient = new FakeGroomLinearClient();
  const selfReviewAgent = opts?.selfReviewAgent ?? agent;
  const verifyAgent = opts?.verifyAgent ?? new FakeAgentRunner();
  const orch = new Orchestrator({
    config,
    source,
    agent,
    selfReviewAgent,
    verifyAgent,
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
    designer,
    designReviewer,
    mergeGateJudge,
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
    getDescendantPids: opts?.getDescendantPids,
    getReparentedPids: opts?.getReparentedPids,
    checkPidAlive: opts?.checkPidAlive,
  });
  return { orch, store, source, agent, verifyAgent, git, monitor, notifier, sleepCalls, logs, promptArgs, recoveryRunner, memoryRunner, groomBoardFetcher, groomLinearClient };
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

  it("HANDOFF 完了時に worktree HEAD が handoffHeadSha として記録される（ES-521）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // memoryRunner の rev-parse HEAD スタブは "abc1234" を返す（L165/L179-181）
    expect(s.handoffHeadSha).toBe("abc1234");
  });

  it("rev-parse HEAD が失敗しても HANDOFF は成功し handoffHeadSha は NULL のまま（フェイルオープン）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    // 汎用 ["git","-C"] ハンドラより長いプレフィックスで rev-parse を失敗させる。
    // worktree パスは FakeGitPr.prepareWorktree の既定生成（identifier.toLowerCase()）に合わせる。
    // 汎用 ["git","-C"] ハンドラより長いこのプレフィックスは、SELF-REVIEW の pre-review
    // SHA 取得・VERIFY の pre-verify SHA 取得（いずれもフェイルクローズ/フェイルオープンの
    // ガードで先行実行される、プレーンな `rev-parse HEAD`）にも一致する。この2回は
    // 成功させ、3回目（HANDOFF 本体）だけ失敗させて対象を狙い撃つ。
    let revParseHeadCalls = 0;
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD"], () => {
      revParseHeadCalls++;
      if (revParseHeadCalls <= 2) return { code: 0, stdout: "abc1234\n" };
      return { code: 128, stderr: "boom" };
    });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged"); // HANDOFF は失敗していない
    expect(s.handoffHeadSha).toBeNull();
  });
});

describe("Orchestrator 正常系 — 2チケット逐次（仕様 §3 逐次・§5 ループ）", () => {
  it("2件を順に完走し、両方 merged・状態遷移の順序が記録される", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A done" },
      // SELF-REVIEW for A (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 2, summary: "B done" },
      // SELF-REVIEW for B (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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
      "discardUncommittedChanges", // SELF-REVIEW exception cleanup (no outcome queued → non-fatal)
      "discardUncommittedChanges", // VERIFY cleanupVerifierWorktree (no outcome queued → fail-open)
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

    // agent に渡された SessionContext（IMPLEMENT + SELF-REVIEW）
    expect(h.agent.contexts).toHaveLength(2);
    expect(h.agent.contexts[0].prompt).toBe("PROMPT for TY-1");
    expect(h.agent.contexts[0].maxCostUsd).toBe(10);
    expect(h.agent.contexts[0].worktreePath).toBe("/wt/ty-1");
    // 2nd context is the self-review call (non-fatal exception: no outcome queued)
    expect(h.agent.contexts[1].prompt).toContain("self-review");
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
    const config = makeConfig({ maxTasksPerRun: 1 });
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
    const config = makeConfig({ maxTasksPerRun: 1 });
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
    inlineMemoryRunner1.on(["git", "add", "-f", "--"], { code: 0 });
    inlineMemoryRunner1.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent,
      selfReviewAgent: agent,
      verifyAgent: new FakeAgentRunner(),
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
      designer: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: inlineMemoryRunner1,
      designReviewer: null,
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
  it("addLabel が決定的エラーで throw → リトライせず即 stopped(handoff_failed)。PR は作成済みなので stop_detail に PR 番号を明記する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
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
    expect(s.prNumber).toBe(100);
    expect(s.stopDetail).toContain("PR #100");
    // deterministic error → retryTransient throws immediately (no retry)
    expect(addLabelCalls).toBe(1);
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "in_progress" }]);
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

describe("N1 ネットワーク瞬断リトライ — CLAIM transition (ES-488)", () => {
  it("transient エラー → リトライ → 成功", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "merged" }];
    // transition を1回 ECONNRESET で失敗させ、2回目で成功させる
    let transitionCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      transitionCalls++;
      if (transitionCalls === 1) throw new Error("ECONNRESET");
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // transition was called: 1st ECONNRESET (retried) + 2nd in_progress (success) + in_review + done
    expect(transitionCalls).toBeGreaterThanOrEqual(2);
  });

  it("transient エラー使い切り → claim_failed → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    let claimTransitionCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "in_progress") {
        claimTransitionCalls++;
        throw new Error("ECONNRESET");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("claim_failed");
    expect(s.stopDetail).toContain("ECONNRESET");
    // 1 initial + 2 retries = 3 total (in_progress only)
    expect(claimTransitionCalls).toBe(3);
  });

  it("決定的エラー → リトライせず即 claim_failed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    let claimTransitionCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "in_progress") {
        claimTransitionCalls++;
        throw new Error("HTTP 403 Forbidden");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("claim_failed");
    // deterministic → no retry (in_progress only)
    expect(claimTransitionCalls).toBe(1);
  });
});

describe("N1 ネットワーク瞬断リトライ — HANDOFF operations (ES-488)", () => {
  it("findOpenPrForBranch transient → リトライ → 成功", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "merged" }];
    let findCalls = 0;
    const origFind = h.git.findOpenPrForBranch.bind(h.git);
    h.git.findOpenPrForBranch = async (branch: string) => {
      findCalls++;
      if (findCalls === 1) throw new Error("ECONNRESET");
      return origFind(branch);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(findCalls).toBe(2);
  });

  it("pushAndOpenPr transient → リトライ → 成功", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "merged" }];
    // pushAndOpenPr を1回 transient で失敗させる
    let pushCalls = 0;
    const origPush = h.git.pushAndOpenPr.bind(h.git);
    h.git.pushAndOpenPr = async (branch: string, wt: string, iss: any) => {
      pushCalls++;
      if (pushCalls === 1) throw new Error("ECONNRESET");
      return origPush(branch, wt, iss);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(pushCalls).toBe(2);
  });

  it("addLabel transient → リトライ → 成功", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "merged" }];
    let labelCalls = 0;
    const origLabel = h.git.addLabel.bind(h.git);
    h.git.addLabel = async (pr: number, label: string) => {
      labelCalls++;
      if (labelCalls === 1) throw new Error("ETIMEDOUT");
      return origLabel(pr, label);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(labelCalls).toBe(2);
  });

  it("addLabel transient 使い切り → handoff_failed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.pushPrNumber.set("looppilot/ty-1-x", 200);
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    let labelCalls = 0;
    h.git.addLabel = async (pr: number, label: string) => {
      labelCalls++;
      h.git.calls.push({ method: "addLabel", args: [pr, label] });
      throw new Error("ECONNRESET");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // 1 initial + 2 retries = 3 total
    expect(labelCalls).toBe(3);
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
    const h = makeHarness(config, { planner, designer: planner });
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
  it("requestStop() を実装フェーズで立てると、SELF-REVIEW 完了後の安全点で Run=halted(user_interrupt) して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A ok" },
      // Self-review runs (safe stop deferred past the review gate, ES-473 Finding 2)
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    // 1 件目の IMPLEMENT 中に停止要求を立てる
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
    // ES-473: SELF-REVIEW 後の安全点で HALT（HANDOFF は実行されない）
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].state).toBe("implementing");
    // IMPLEMENT + SELF-REVIEW の 2 回実行（安全点は SELF-REVIEW 後）
    expect(h.agent.contexts).toHaveLength(2);
    // Run=halted、理由は user_interrupt
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });

  it("requestStop() 後でも進行中セッションは implementing のまま（SELF-REVIEW 前の安全点でクリーン停止）", async () => {
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
    // ES-473: IMPLEMENT 後の安全点で HALT。セッションは implementing のまま（次回起動で回復可能）
    expect(s.state).toBe("implementing");
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

  it("skips memory push and aborts rebase when rebase fails on halt (ES-452 Findings 3 & 4)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Override: rebase fails, simulating conflicts between local memory edits and remote
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });
    // Memory has changes
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // Bootstrap path may commit locally (ES-503), but push must NOT happen
    const pushCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "push",
    );
    expect(pushCall).toBeUndefined();
    const abortCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "rebase" && c.args.includes("--abort"),
    );
    expect(abortCall).toBeDefined();
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("skips memory push when autostash pop leaves conflicts after successful rebase (ES-452 Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase exits 0 (success), but autostash pop left unmerged files
    h.memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], {
      code: 0,
      stdout: "100644 abc123 1\tdocs/memory/pm-decisions.md\n",
    });
    h.memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
    // Memory has changes
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // Bootstrap path may commit locally (ES-503), but push must NOT happen
    const pushCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "push",
    );
    expect(pushCall).toBeUndefined();
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

describe("Orchestrator bootstrap memory — rebase failure local commit (ES-503)", () => {
  it("commits bootstrap memory locally when rebase fails so GROOM cleanup cannot remove it", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase fails during bootstrap
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });
    // commitIfChanged: git add succeeds, diff shows staged changes, commit succeeds
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // A local commit must have been created with the bootstrap-specific message
    const commitCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls[0].args).toContain("chore: bootstrap memory (rebase skipped)");
    // Push must NOT be attempted (rebase failed → push would be non-fast-forward)
    const pushCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "push",
    );
    expect(pushCalls.length).toBe(0);
  });

  it("commits bootstrap memory locally when autostash pop leaves conflicts (ES-503)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase succeeds but autostash pop leaves conflicts
    h.memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], {
      code: 0,
      stdout: "100644 abc123 1\tdocs/memory/pm-decisions.md\n",
    });
    h.memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
    // commitIfChanged: git add succeeds, diff shows staged changes, commit succeeds
    h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    const commitCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls[0].args).toContain("chore: bootstrap memory (autostash conflict)");
  });

  it("degrades gracefully when bootstrap local commit fails (ES-503)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase fails during bootstrap
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });
    // commitIfChanged fails (git add returns error)
    h.memoryRunner.on(["git", "add", "-f", "--"], { code: 1, stderr: "fatal: index.lock" });

    h.orch.requestStop();
    await h.orch.run();

    // Run must still complete (halted), not crash
    expect(h.store.latestRun()!.state).toBe("halted");
    // Warning must be logged
    expect(h.logs.some((l) => l.includes("bootstrap memory commit failed"))).toBe(true);
  });

  it("reverts tracked memory files when initializeMemory fails in rebase-skip bootstrap path (ES-503 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // initializeMemory (beforeCommit) always throws in tests because /repo doesn't exist.
    // The catch block must call git checkout HEAD -- docs/memory/ to revert any tracked
    // modifications BEFORE git clean, so commitIfChanged cannot stage partial state
    // (ES-503 Finding 3). Expected: >=3 checkout calls (pre-seed cleanup + catch + halt path).
    // Without the fix only 2 calls would occur (pre-seed cleanup + halt path).
    const checkoutCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "checkout" &&
             c.args.includes("HEAD") && c.args.includes("docs/memory/"),
    );
    expect(checkoutCalls.length).toBeGreaterThanOrEqual(3);
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("reverts tracked memory files when initializeMemory fails in autostash-conflict bootstrap path (ES-503 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], {
      code: 0,
      stdout: "100644 abc123 1\tdocs/memory/pm-decisions.md\n",
    });
    h.memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // initializeMemory (beforeCommit) always throws in tests because /repo doesn't exist.
    // The catch block must call git checkout HEAD to revert tracked modifications before
    // git clean (ES-503 Finding 3). Expected: >=3 checkout calls (line-5049 bootstrap +
    // catch + line-5049 halt). Without the fix only 2 calls occur.
    const checkoutCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "checkout" &&
             c.args.includes("HEAD") && c.args.includes("docs/memory/"),
    );
    expect(checkoutCalls.length).toBeGreaterThanOrEqual(3);
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("Orchestrator memory re-seed after fetchDefaultBranch (ES-503 Codex Finding 1)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("groom reads store-seeded memory after fetchDefaultBranch discards local-only bootstrap commit", async () => {
    const tmpRepo = mkdtempSync(path.join(tmpdir(), "groom-es503-cf1-"));
    tmpDirs.push(tmpRepo);

    const planner = new FakePlanRunner();
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"actions":[],"summary":"no changes"}\n```',
    });
    // SELECT outcome (2 issues → selectWithPm calls the planner)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    const config = {
      ...makeConfig({ maxTasksPerRun: 1, groomEnabled: true }),
      repo: { ...makeConfig().repo, path: tmpRepo },
    } as Config;
    const h = makeHarness(config, { planner });

    // Pre-create a completed session so initializeMemory writes meaningful impl-results content
    const prevRun = h.store.createRun(5, "2024-01-01T00:00:00Z");
    const prevSession = h.store.createSession({
      runId: prevRun.id,
      linearIssueId: "prev-x",
      linearIdentifier: "TY-0",
      issueTitle: "Previous task",
      issueUrl: "https://linear.app/prev",
      branch: "looppilot/ty-0",
      worktreePath: "/wt/ty-0",
      now: "2024-01-01T00:00:00Z",
    });
    h.store.updateSession(prevSession.id, { state: "merged", endedAt: "2024-01-01T01:00:00Z" });

    // Simulate fetchDefaultBranch's git reset --hard discarding the local-only bootstrap commit
    h.git.fetchDefaultBranchSideEffect = () => {
      rmSync(path.join(tmpRepo, "docs", "memory"), { recursive: true, force: true });
    };

    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The groom prompt (planner call 0) must include TY-0 from the re-seeded impl-results
    const groomPrompt = planner.calls[0]!.prompt;
    expect(groomPrompt).toContain("TY-0");
    expect(groomPrompt).toContain("Previous task");
  });

  it("select reads store-seeded memory after fetchDefaultBranch discards local-only bootstrap commit", async () => {
    const tmpRepo = mkdtempSync(path.join(tmpdir(), "select-es503-cf1-"));
    tmpDirs.push(tmpRepo);

    const planner = new FakePlanRunner();
    // SELECT outcome (2 issues → selectWithPm calls the planner)
    planner.outcomes.push({
      kind: "completed",
      text: '```json\n{"identifier":"TY-1","rationale":"pick"}\n```',
    });

    const config = {
      ...makeConfig({ maxTasksPerRun: 1 }),
      repo: { ...makeConfig().repo, path: tmpRepo },
    } as Config;
    const h = makeHarness(config, { planner });

    // Pre-create a completed session so initializeMemory writes meaningful impl-results content
    const prevRun = h.store.createRun(5, "2024-01-01T00:00:00Z");
    const prevSession = h.store.createSession({
      runId: prevRun.id,
      linearIssueId: "prev-x",
      linearIdentifier: "TY-0",
      issueTitle: "Previous task",
      issueUrl: "https://linear.app/prev",
      branch: "looppilot/ty-0",
      worktreePath: "/wt/ty-0",
      now: "2024-01-01T00:00:00Z",
    });
    h.store.updateSession(prevSession.id, { state: "merged", endedAt: "2024-01-01T01:00:00Z" });

    // Simulate fetchDefaultBranch's git reset --hard discarding the local-only bootstrap commit
    h.git.fetchDefaultBranchSideEffect = () => {
      rmSync(path.join(tmpRepo, "docs", "memory"), { recursive: true, force: true });
    };

    // 2 issues are needed to trigger selectWithPm (single issue short-circuits)
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The select prompt (planner call 0) must include TY-0 from the re-seeded impl-results
    const selectPrompt = planner.calls[0]!.prompt;
    expect(selectPrompt).toContain("TY-0");
    expect(selectPrompt).toContain("Previous task");
  });

  it("claim seeds memory files in new worktree from store so implement can read it", async () => {
    const tmpWorktree = mkdtempSync(path.join(tmpdir(), "wt-es503-cf1-"));
    tmpDirs.push(tmpWorktree);

    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);

    // Pre-create a completed session so initializeMemory writes meaningful impl-results content
    const prevRun = h.store.createRun(5, "2024-01-01T00:00:00Z");
    const prevSession = h.store.createSession({
      runId: prevRun.id,
      linearIssueId: "prev-x",
      linearIdentifier: "TY-0",
      issueTitle: "Previous task",
      issueUrl: "https://linear.app/prev",
      branch: "looppilot/ty-0",
      worktreePath: "/wt/ty-0",
      now: "2024-01-01T00:00:00Z",
    });
    h.store.updateSession(prevSession.id, { state: "merged", endedAt: "2024-01-01T01:00:00Z" });

    // Point the worktree for TY-1 at the real tmpdir so initializeMemory can write there
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: tmpWorktree });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // impl-results.md must exist in the worktree and contain the pre-seeded session data
    const implResultsPath = path.join(tmpWorktree, "docs", "memory", "impl-results.md");
    expect(existsSync(implResultsPath)).toBe(true);
    const content = readFileSync(implResultsPath, "utf-8");
    expect(content).toContain("TY-0");
    expect(content).toContain("Previous task");
  });

  it("does not stage memory files in the feature worktree during claim (ES-503 Finding 1 fix)", async () => {
    // Regression: the old code called commitIfChanged(runner, worktreePath) in claim(),
    // which staged docs/memory/ files on the feature branch. This made hasCommitsWithDiff()
    // return true even when the agent produced no real diff, and caused HANDOFF to open PRs
    // containing only bootstrap memory files (ES-503 Codex Finding 1).
    // The fix: seed files via initializeMemory + write to info/exclude instead of committing.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // git add targeting docs/memory/ (any form) must NOT be called with the feature
    // worktree as cwd: that was the mechanism by which memory files were staged on the
    // feature branch.
    const worktreeAddCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "add" &&
        c.args.some(a => a === "docs/memory/" || a.startsWith("docs/memory/")) &&
        c.opts.cwd === "/wt/ty-1",
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it("uses --git-common-dir (not --git-dir) and reverts tracked memory files after CLAIM (ES-503 Finding 1 fix)", async () => {
    const tmpWorktree = mkdtempSync(path.join(tmpdir(), "wt-es503-f12-"));
    tmpDirs.push(tmpWorktree);

    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: tmpWorktree });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // After initializeMemory, git checkout HEAD -- docs/memory/ must be called to
    // revert any tracked file modifications so the worktree stays clean (ES-503 Finding 1).
    const checkoutCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "-C" && c.args[1] === tmpWorktree &&
             c.args.includes("checkout") && c.args.includes("HEAD"),
    );
    expect(checkoutCalls.length).toBeGreaterThan(0);

    // --git-common-dir must be used: Git reads info/exclude from the common git dir,
    // not from the worktree-specific .git/worktrees/<name> path (ES-503 Finding 1 fix).
    // gitignore rules only affect untracked files, so tracked memory files in the
    // default checkout remain addable/committable by commitIfChanged.
    const commonDirCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "-C" && c.args[1] === tmpWorktree &&
             c.args.includes("--git-common-dir"),
    );
    expect(commonDirCalls.length).toBeGreaterThan(0);

    const gitDirOnlyCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "-C" && c.args[1] === tmpWorktree &&
             c.args.includes("rev-parse") && c.args.includes("--git-dir") &&
             !c.args.includes("--git-common-dir"),
    );
    expect(gitDirOnlyCalls).toHaveLength(0);
  });
});

describe("Orchestrator HALT memory commit — Codex Findings 1 & 2", () => {
  it("cleans up dirty memory files when halt-path rebase fails (Codex Finding 1)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Both bootstrap and halt rebase calls fail; the bootstrap initializeMemory
    // may create dirty docs/memory/ files that the halt path must clean up.
    h.memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 1, stderr: "CONFLICT" });
    h.memoryRunner.on(["git", "rebase", "--abort"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // The halt path (beforeCommit === undefined) must restore and clean the memory dir
    // so the next startup's clean-worktree preflight does not fail.
    const checkoutCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args[3] === "docs/memory/",
    );
    expect(checkoutCalls.length).toBeGreaterThan(0);
    const cleanCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "clean" && c.args[2] === "--" && c.args[3] === "docs/memory/",
    );
    expect(cleanCalls.length).toBeGreaterThan(0);
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  it("logs commitIfChanged errors instead of silently swallowing them on halt (Codex Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Simulate a commitIfChanged failure (e.g. index lock) in the halt path.
    h.memoryRunner.on(["git", "add", "-f", "--"], { code: 1, stderr: "fatal: Unable to create index.lock" });

    h.orch.requestStop();
    await h.orch.run();

    // Run must still halt despite the failure.
    expect(h.store.latestRun()!.state).toBe("halted");
    // The error must be logged as a warning, not silently swallowed.
    expect(h.logs.some((l) => l.includes("warning") && l.includes("commit memory on halt"))).toBe(true);
  });

  it("cleans up dirty memory files when halt-path autostash conflict is detected (Codex Finding 1)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // Rebase exits 0 but autostash pop left unmerged files; halt path must also
    // remove untracked files left by the bootstrap initializeMemory.
    h.memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], {
      code: 0,
      stdout: "100644 abc123 1\tdocs/memory/pm-decisions.md\n",
    });
    h.memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });

    h.orch.requestStop();
    await h.orch.run();

    // git clean -fdx -- docs/memory/ must run in the halt path to remove untracked files.
    const cleanCalls = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "clean" && c.args[2] === "--" && c.args[3] === "docs/memory/",
    );
    expect(cleanCalls.length).toBeGreaterThan(0);
    expect(h.store.latestRun()!.state).toBe("halted");
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
      // SELF-REVIEW for A (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 2, summary: "B" },
      // SELF-REVIEW for B (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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

describe("Orchestrator DESIGN phase (ES-476)", () => {
  it("generates brief via planner, persists to DB, and proceeds to IMPLEMENT", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo the thing.\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer: planner });
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
    const h = makeHarness(config, { designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Still completed — fallback worked
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("agent failed") && l.includes("codex crashed"))).toBe(true);
  });

  it("falls back to null brief when planner throws", async () => {
    const planner = new FakePlanRunner();
    // No outcomes queued → FakePlanRunner throws
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("agent exception"))).toBe(true);
  });

  it("skips DESIGN entirely when designer is null", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // designer defaults to null
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    // No design-related log lines
    expect(h.logs.some((l) => l.includes("design:"))).toBe(false);
  });

  it("falls back when spec loading fails during DESIGN (IMPLEMENT also stops)", async () => {
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
    inlineMemoryRunner2.on(["git", "add", "-f", "--"], { code: 0 });
    inlineMemoryRunner2.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    const orch = new Orchestrator({
      mergeGateJudge: null,
      config: specConfig,
      source,
      agent,
      selfReviewAgent: agent,
      verifyAgent: new FakeAgentRunner(),
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
      planner: null,
      designer: planner,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      designReviewer: null,
      runner: inlineMemoryRunner2,
      groomDeps: null,
    });

    source.queue = [issue("issue-A", "TY-1")];
    agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    monitor.verdicts = [{ kind: "merged" }];

    await orch.run();

    // DESIGN fell back gracefully (did not halt the loop)
    expect(planner.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("design: spec loading failed"))).toBe(true);
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
    const h = makeHarness(config, { designer: planner });
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

  it("passes null brief to buildPrompt when designer is absent", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // designer defaults to null
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
    const h = makeHarness(config, { designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("agent returned empty output"))).toBe(true);
  });

  it("passes designTimeoutMinutes as timeoutMs to the designer", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nDone." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // designTimeoutMinutes=15 → 15 * 60_000 = 900_000 ms
    expect(planner.calls[0]!.timeoutMs).toBe(15 * 60_000);
  });

  it("requestStop() during DESIGN halts before IMPLEMENT starts — session stays in claimed (Finding 1)", async () => {
    // DESIGN is read-only. If SIGINT arrives during DESIGN, the safe point between
    // DESIGN and IMPLEMENT must honor the stop request so IMPLEMENT (the mutating
    // phase) never launches.
    const config = makeConfig({ maxTasksPerRun: 3 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { designer: planner });
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

describe("Orchestrator DESIGN cost accounting (ES-499)", () => {
  it("adds design cost to session cost_usd on completed outcome", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N", costUsd: 0.25 },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.costUsd).toBeCloseTo(1.25); // 0.25 design + 1.0 implement
  });

  it("accumulates design costs across a redesign loop", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N", costUsd: 0.3 },
      { kind: "completed", text: "## Goal\nV2\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N", costUsd: 0.5 },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Missing error handling"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.costUsd).toBeCloseTo(1.8); // 0.3 + 0.5 design + 1.0 implement
  });

  it("keeps spent design cost when the design agent errors", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [{ kind: "error", message: "agent crashed", costUsd: 0.4 }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged"); // error はフォールバック（brief なしで IMPLEMENT へ）
    expect(s.planBrief).toBeNull();
    expect(s.costUsd).toBeCloseTo(1.4); // 0.4 design (error) + 1.0 implement
  });

  it("records design cost before halting on interrupted outcome", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [{ kind: "interrupted", costUsd: 0.2 }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    const s = h.store.sessionsForRun(run.id)[0];
    expect(s.costUsd).toBeCloseTo(0.2); // halt 前に計上済み
  });

  it("leaves cost_usd untouched when designer reports no cost (Codex-style undefined)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.costUsd).toBeCloseTo(1.0); // implement のみ。undefined は加算スキップ
  });

  it("design cost counts against the per-session IMPLEMENT budget", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N", costUsd: 0.25 },
    ];
    const config = makeConfig({ maxTasksPerRun: 1, maxCostUsdPerSession: 10 });
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // IMPLEMENT's budget is the per-session cap minus what DESIGN already spent.
    expect(h.agent.contexts[0]!.maxCostUsd).toBeCloseTo(9.75);
  });
});

describe("Orchestrator DESIGN brief writeback (ES-406)", () => {
  it("writes back the brief as a Linear comment after successful generation", async () => {
    const briefText = "## Goal\nDo the thing.\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing";
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: briefText }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer: planner });
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
    const h = makeHarness(config, { designer: planner });
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
    const h = makeHarness(config, { designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.source.comments).toHaveLength(0);
  });

  it("does not write back when designer is absent", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // designer defaults to null
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
    const h = makeHarness(config, { designer: planner });
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
    const h = makeHarness(config, { planner, designer: planner });

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
    const h = makeHarness(config, { planner, designer: planner });

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
    const h = makeHarness(config, { planner, designer: planner });

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
    const h = makeHarness(config, { planner, designer: planner });

    h.source.queue = [issue("id-1", "TY-1")];

    // Only DESIGN outcome (no SELECT since only 1 eligible)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    // planner called only once (DESIGN), not twice (SELECT + DESIGN)
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
    const h = makeHarness(config, { planner, designer: planner });

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
    const h = makeHarness(config, { planner, designer: planner });

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
    const h = makeHarness(config, { planner, designer: planner });

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
      // DESIGN: no outcome queued → falls back to null brief gracefully
    ];
    const h = makeHarness(config, { planner, designer: planner });
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
    inlineMemoryRunner3.on(["git", "add", "-f", "--"], { code: 0 });
    inlineMemoryRunner3.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    const orch = new Orchestrator({
      mergeGateJudge: null,
      config, source, agent, selfReviewAgent: agent, verifyAgent: new FakeAgentRunner(), git, monitor, notifier, store,
      buildPrompt: () => "prompt", specLoader: null, clock, sleep,
      log: () => {}, recovery: new FakeWorkflowRecovery(), planner: null, designer: null,
      codebaseSummaryGenerator: async () => "",
      designReviewer: null,
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
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // SELF-REVIEW outcome (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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
    expect(s.recoveryTurnAttempts).toBe(1); // counter-based (ES-493)
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
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // DESIGN outcome
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
    const h = makeHarness(config, { planner, designer: planner });
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
    const h = makeHarness(config, { planner, designer: planner });
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
    expect(s.recoveryTurnAttempts).toBe(1); // counter-based (ES-493): merge_conflict increments counter not recoveryAttempted
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
    const h = makeHarness(config, { planner, designer: planner });
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
    const h = makeHarness(config, { planner, designer: planner });
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
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // SELF-REVIEW outcome (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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
    const h = makeHarness(config, { planner, designer: planner });
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

    // ES-492: Label-based exclusion — addLabel is called on abandon so SELECT filters the ticket.
    expect(h.source.labelAdds).toContainEqual({ issueId: "issue-A", labelName: "needs-human" });
    // A second SELECT was triggered (the loop continued after abandon).
    expect(h.source.eligibleCalls.length).toBeGreaterThanOrEqual(2);
  });

  // ES-450 Finding (iteration 8): pr_closed is terminal — recovery must not run even when
  // recoveryTurn is configured and recoveryAttempted is still 0.
  it("pr_closed with planner configured → no recovery, stops with pr_closed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
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

  // ES-490: handoff_failed → policy=halt. Even when a planner is configured (recovery
  // capability is available), halt policy overrides and no recovery turn is attempted.
  it("handoff_failed with planner → policy=halt, no recovery (ES-490)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // Force PR creation to #100
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // addLabel always fails → handoff_failed
    h.git.addLabel = async (prNumber: number, label: string): Promise<void> => {
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      throw new Error("gh: label not found");
    };
    // PLAN outcome only — no recovery outcome because halt policy means recovery is never attempted
    planner.outcomes = [
      { kind: "completed", text: "## Plan\nDo the thing" },
    ];
    // No h.monitor.verdicts — session won't reach monitor

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // Run halted due to halt policy
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // No recovery notifications
    const recoveryEvents = h.notifier.events.filter(
      (e) => e.kind === "recovery_started" || e.kind === "recovery_succeeded",
    );
    expect(recoveryEvents).toHaveLength(0);
    // Recovery was not attempted
    expect(s.recoveryAttempted).toBe(0);
  });

  // ES-450 Finding (iteration 8): failed abandon must not record recovery_action so
  // stoppedSessionsWithPr can pick the session up again on the next daemon start.
  // ES-450 Finding 2 (iteration 10): failed cleanup must also leave recoveryAttempted=0
  // so a future recovery path can retry the cleanup rather than skipping executeRecoveryTurn.
  it("failed abandon does not set recoveryAction or recoveryAttempted, allowing retry", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
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
    // ES-492 Finding 1: when recovery chose abandon but executeAbandon failed, the halt path
    // must still apply the needs-human label so SELECT filters the ticket.
    expect(h.source.labelAdds).toContainEqual({ issueId: "issue-A", labelName: "needs-human" });
    // A retryable failed recovery (no preserveWorktree/nonRetryable) must still count toward
    // the attempt cap so repeated failures eventually reach maxRecoveryAttempts (ES-493).
    expect(s.recoveryTurnAttempts).toBe(1);
  });

  // ES-450 Finding 1 (iteration 10): stale guard must fire on the poll immediately
  // after done-path recovery so a stale ci_failed/merge_conflict verdict does not
  // trigger a second stopSession with recoveryAttempted already set.
  it("ci_failed recovery stale guard fires once then merge succeeds on next poll", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // SELF-REVIEW outcome (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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
    expect(s.recoveryTurnAttempts).toBe(1); // counter-based (ES-493)
    expect(s.recoveryAction).toBe("fix_code");
    // Readiness was called exactly twice: once for ci_failed (poll 1) and once for
    // ready (poll 3). The stale guard on poll 2 must skip tryMerge entirely.
    expect(h.monitor.readinessCalls).toHaveLength(2);
  });

  // ES-450 Finding 1 (iteration 10): same stale guard for merge_conflict + rebase.
  it("merge_conflict recovery stale guard fires once then merge succeeds", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
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
    expect(s.recoveryTurnAttempts).toBe(1); // counter-based (ES-493)
    expect(s.recoveryAction).toBe("rebase");
    // Stale guard must skip tryMerge on poll 2 — readiness called only twice.
    expect(h.monitor.readinessCalls).toHaveLength(2);
  });

  // ES-450 Finding 3 (iteration 10): when recovery fails after doing useful work,
  // stopDetail must carry the recovery failure message so operators can diagnose.
  it("failed fix_code recovery includes recovery failure message in stopDetail", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // SELF-REVIEW outcome (non-fatal error → proceeds to HANDOFF)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
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
    // push-after-commit failure has preserveWorktree=true → existing code forces counter to
    // maxRecoveryAttempts (2) so the session is not retried with stale commits on disk.
    expect(s.recoveryTurnAttempts).toBe(2);
  });

  it("ci_failed recovers up to max_recovery_attempts, then abandons (ES-493)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // Set CI logs on FakeGitPr so they flow into recovery prompt
    h.git.ciLogs = "Error: npm test failed\n  FAIL src/app.test.ts\n  expect(true).toBe(false)";
    // Agent outcomes: IMPLEMENT, SELF-REVIEW (error→skip), recovery-fix-1, recovery-fix-2
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "fixed CI attempt 1" },
      { kind: "completed", costUsd: 0.5, summary: "fixed CI attempt 2" },
    ];
    // Planner outcomes: PLAN, recovery-codex-1 (fix_code), recovery-codex-2 (fix_code)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nFix it" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the failing test"}' },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the failing test again"}' },
    ];
    // Monitor: 3 "done" verdicts — each triggers tryMerge
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
      { kind: "done" },
    ];
    // checkMergeReadiness always returns ci_failed
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    // Stub git operations for recovery
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Counter exhausted after 2 recoveries → abandon on 3rd ci_failed
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.recoveryAction).toBe("abandon");
    expect(s.recoveryTurnAttempts).toBe(2);
    // needs-human triage applied on abandon
    expect(s.needsHumanLabelAdded).toBe(1);
    // Ticket reverted to Todo
    const todoTransitions = h.source.transitions.filter((t) => t.state === "todo");
    expect(todoTransitions.length).toBeGreaterThanOrEqual(1);
    // 2 recovery_started + 2 recovery_succeeded + 1 task_skipped
    const recoveryStarted = h.notifier.events.filter((e) => e.kind === "recovery_started");
    expect(recoveryStarted).toHaveLength(2);
    const recoverySucceeded = h.notifier.events.filter((e) => e.kind === "recovery_succeeded");
    expect(recoverySucceeded).toHaveLength(2);
    const taskSkipped = h.notifier.events.filter((e) => e.kind === "task_skipped");
    expect(taskSkipped).toHaveLength(1);
  });

  it("ci_failed recovery prompt includes CI logs (ES-493)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.ciLogs = "FAIL src/math.test.ts > sum > adds numbers\nExpected: 6\nReceived: 5";
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "fixed" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix sum"}' },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
    ];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    // The Codex recovery prompt (2nd planner call) must contain CI logs
    expect(planner.calls.length).toBeGreaterThanOrEqual(2);
    const recoveryPrompt = planner.calls[1].prompt;
    expect(recoveryPrompt).toContain("FAIL src/math.test.ts");
    expect(recoveryPrompt).toContain("Expected: 6");
    // fetchCiLogs was called with the PR number and branch
    const fetchCalls = h.git.calls.filter((c) => c.method === "fetchCiLogs");
    expect(fetchCalls).toHaveLength(1);
  });

  it("recoveryTurnAttempts survives restart (ES-493)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "fixed" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix"}' },
    ];
    let readinessCall = 0;
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
    ];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    // After one recovery: counter is 1 and persisted in DB
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].recoveryTurnAttempts).toBe(1);
    expect(sessions[0].state).toBe("merged");

    // Verify the counter is in the raw DB (survives process restart)
    const raw = h.store.getSession(sessions[0].id);
    expect(raw.recoveryTurnAttempts).toBe(1);
  });

  it("merge_conflict uses recovery counter (ES-493)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
      { kind: "completed", text: '{"action":"rebase","instruction":"rebase onto main"}' },
    ];
    let readinessCall = 0;
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
    ];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "conflict" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc\n" };
      if (args.includes("rebase")) return { code: 0, stdout: "" };
      return { code: 0, stdout: "" };
    });
    h.recoveryRunner.on(["git", "push"], { code: 0 });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.recoveryTurnAttempts).toBe(1);
    expect(s.recoveryAction).toBe("rebase");
    expect(s.state).toBe("merged");
  });

  it("merge_conflict counter exhaustion → abandon (ES-493)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "rebased 1" },
      { kind: "completed", costUsd: 0.5, summary: "rebased 2" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
      { kind: "completed", text: '{"action":"rebase","instruction":"rebase onto main"}' },
      { kind: "completed", text: '{"action":"rebase","instruction":"rebase onto main again"}' },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "done" },
      { kind: "done" },
    ];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "conflict" as const };
    };
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc\n" };
      if (args.includes("rebase")) return { code: 0, stdout: "" };
      return { code: 0, stdout: "" };
    });
    h.recoveryRunner.on(["git", "push"], { code: 0 });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_conflict");
    expect(s.recoveryAction).toBe("abandon");
    expect(s.recoveryTurnAttempts).toBe(2);
    expect(s.needsHumanLabelAdded).toBe(1);
  });

  // ES-493 Iteration 8 Finding 3: CI diagnostics must be preserved in the compound
  // stop_detail so the next recovery retry receives the CI log output. The ci_log:
  // prefix survives via "ci_log:<logs> (recovery failed: <msg>)" and stripRecoveryFailedSuffix
  // uses lastIndexOf so it strips the actual suffix even when CI output contains the pattern.
  it("ci_failed recovery failure preserves ci_log content in compound stop_detail (ES-493 Iteration 8 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // CI output contains text that resembles a recovery-failure sentinel — lastIndexOf in
    // stripRecoveryFailedSuffix ensures the actual appended suffix is stripped correctly.
    h.git.ciLogs = "Error: (recovery failed: some previous test harness log line)";
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      { kind: "completed", text: '{"action":"restart_review"}' },
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    // Make restart-review comment posting fail (no preserveWorktree → retryable).
    h.git.failNext("postComment");

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    // CI logs must be preserved in the compound form so the next retry has the diagnostics.
    expect(s.stopDetail).toMatch(/^ci_log:/);
    // The recovery failure marker must still be present so the session can be retried.
    expect(s.stopDetail).toContain("(recovery failed:");
  });

  // ES-493 Finding 3: when the fix_pushed_restart_pending shortcut retries only the
  // /restart-review comment (no code fix), a successful comment post must NOT increment
  // recoveryTurnAttempts — the budget must be preserved for actual code-fix attempts.
  it("fix_pushed_restart_pending success: recoveryTurnAttempts not incremented (ES-493 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a stopped session with the fix_pushed_restart_pending sentinel and counter=1.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix failing test",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "stopped",
      failureReason: "ci_failed",
      prNumber: 100,
      stopDetail: "fix_pushed_restart_pending (recovery failed: recovery restart-review failed: timeout)",
      recoveryTurnAttempts: 1,
      endedAt: "2026-06-04T00:01:00.000Z",
    });
    // Source queue is empty — startup recovery handles the seeded session only.
    h.source.queue = [];
    // Stale guard fires once (pendingRestartReason="ci_failed"), then merge succeeds.
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }];

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("merged");
    expect(s.recoveryAction).toBe("restart_review");
    // The comment-only retry must NOT count against the recovery budget.
    expect(s.recoveryTurnAttempts).toBe(1);
    // /restart-review comment was posted to the PR.
    const commentCalls = h.git.calls.filter(
      (c) => c.method === "postComment" && c.args[1] === "/restart-review",
    );
    expect(commentCalls).toHaveLength(1);
  });

  // ES-493 Finding 3 (failure path): when the fix_pushed_restart_pending shortcut
  // fails to post the /restart-review comment, recoveryTurnAttempts must NOT be
  // incremented — only the comment is missing, not a code fix.
  it("fix_pushed_restart_pending failure: recoveryTurnAttempts not incremented (ES-493 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a stopped session with fix_pushed_restart_pending and counter at 1.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix failing test",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "stopped",
      failureReason: "ci_failed",
      prNumber: 100,
      stopDetail: "fix_pushed_restart_pending (recovery failed: recovery restart-review failed: timeout)",
      recoveryTurnAttempts: 1,
      endedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Make postComment fail again — the shortcut path retries only the comment.
    h.git.failNext("postComment");

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    // Counter must remain at 1 — the comment-only failure must not consume code-fix budget.
    expect(s.recoveryTurnAttempts).toBe(1);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    // Sentinel re-encoded so next startup picks it up again.
    expect(s.stopDetail).toContain("fix_pushed_restart_pending");
  });

  // ES-493 Finding 1: a legacy session (recoveryAttempted=1, recoveryTurnAttempts=0) must
  // have the prior attempt counted so it cannot receive a full fresh budget after an upgrade.
  it("legacy recoveryAttempted=1 counts against new counter budget (ES-493 Finding 1)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed an in_review session in legacy state: recoveryAttempted=1, recoveryTurnAttempts=0.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix failing test",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 1,    // set by old code after a ci_failed recovery
      recoveryTurnAttempts: 0, // not yet migrated
      // recoveryAction must identify a counter-based CI recovery so the legacy shim fires.
      // Old code that wrote recoveryAttempted=1 for looppilot_stopped/handoff_failed used
      // restart_review, which is excluded from the shim (Codex Finding 2).
      recoveryAction: "fix_code",
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Recovery planner: fix_code (used on the first ci_failed).
    planner.outcomes = [
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the test"}' },
    ];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" }, // recovery fix agent
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    // Monitor: two "done" verdicts, both ci_failed on readiness.
    // First: triggers recovery (fix_code), counter → effectiveRecoveryAttempts+1 = 2.
    // Second: counter=2=max → abandon (no second recovery).
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    // Budget was already 1 (legacy), so only ONE recovery ran before abandon.
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.recoveryAction).toBe("abandon");
    // Counter = effectiveRecoveryAttempts(1) + 1 = 2 (max), proving the prior attempt was counted.
    expect(s.recoveryTurnAttempts).toBe(2);
    // Exactly one recovery_started event — the legacy attempt consumed one slot.
    const recoveryStarted = h.notifier.events.filter((e) => e.kind === "recovery_started");
    expect(recoveryStarted).toHaveLength(1);
  });

  // ES-493 Finding 2: a ci_failed recovery that escalates must set recoveryAttempted=1 so
  // stoppedSessionsWithFailedRecovery cannot re-queue the session, overriding the escalation.
  it("ci_failed escalation sets recoveryAttempted=1 to block stoppedSessionsWithFailedRecovery (ES-493 Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // CI log contains "(recovery failed:" pattern — without the fix, the stored stop_detail
    // would have ci_log:...(recovery failed:... and match stoppedSessionsWithFailedRecovery.
    h.git.ciLogs = "Error: (recovery failed: some test harness log line)";
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery planner: escalate
      { kind: "completed", text: '{"action":"escalate"}' },
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("escalate");
    // Must be set so stoppedSessionsWithFailedRecovery (which requires recovery_attempted=0) skips it.
    expect(s.recoveryAttempted).toBe(1);
    // Confirm the session is not re-queued by stoppedSessionsWithFailedRecovery.
    expect(h.store.stoppedSessionsWithFailedRecovery()).toHaveLength(0);
  });

  // ES-493 Iteration 7 Finding 2: a prior non-counter recovery (e.g. looppilot_stopped or
  // handoff_failed) sets recoveryAttempted=1 with the new recoveryTurnAttempts=-1 sentinel.
  // A later ci_failed stop must NOT fire the legacy shim and must give a full CI/merge budget.
  it("non-counter recovery sentinel (recoveryTurnAttempts=-1) does not consume CI/merge budget", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a session with the new non-counter recovery sentinel written by the fixed code:
    // recoveryAttempted=1 (non-counter recovery ran) + recoveryTurnAttempts=-1 (sentinel).
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 1,       // non-counter recovery ran (e.g. looppilot_stopped)
      recoveryTurnAttempts: -1,   // sentinel: non-counter, not a legacy CI/merge attempt
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Recovery planner: fix_code for the first ci_failed.
    planner.outcomes = [
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the CI"}' },
    ];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    // Monitor: done → ci_failed → recovery succeeds → merged.
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("merged");
    // Sentinel -1 normalized to 0: counter goes 0→1.
    // This proves the legacy shim did NOT fire (which would have given effectiveRecoveryAttempts=1
    // and incremented to 2, consuming the full budget on the first recovery).
    // With the Iteration 8 fix the -1 is now normalized before incrementing, so the result
    // is 1 rather than 0 (ES-493 Iteration 8 Finding 2).
    expect(s.recoveryTurnAttempts).toBe(1);
  });

  // ES-493 Iteration 9 Finding 2: a non-counter recovery (e.g. looppilot_stopped) must not
  // overwrite a positive recoveryTurnAttempts set by prior counter-based (ci_failed) recovery.
  // Without the fix, restart_review for looppilot_stopped writes recoveryTurnAttempts=-1,
  // erasing the counter so the session receives a fresh full budget on the next ci_failed stop.
  it("non-counter recovery (looppilot_stopped) preserves positive recoveryTurnAttempts from prior counter recovery", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a session that already consumed 1 counter attempt from a prior ci_failed recovery.
    // It is currently in_review with recoveryAttempted=0 (non-counter recovery not yet attempted).
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,     // non-counter recovery has NOT run yet
      recoveryTurnAttempts: 1,  // one ci_failed counter budget already consumed
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Recovery planner: restart_review for the looppilot_stopped stop.
    planner.outcomes = [
      { kind: "completed", text: '{"action":"restart_review"}' },
    ];
    // Monitor: startup recovery poll returns stopped (looppilot_stopped) → recovery runs
    // → restart_review re-activates the session → second poll returns merged.
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "codex timed out" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("merged");
    // recoveryTurnAttempts must still be 1. The non-counter restart_review must NOT write
    // -1 over the existing counter — that would reset the budget and allow a fresh full
    // max_recovery_attempts on the next ci_failed stop (ES-493 Iteration 9 Finding 2).
    expect(s.recoveryTurnAttempts).toBe(1);
    expect(s.recoveryAttempted).toBe(1);
  });

  // ES-493 Iteration 7 Finding 3: when fix_code/rebase pushes a fix but /restart-review
  // fails for the FIRST time (isRestartCommentPending=false), the push must be counted
  // against the recovery budget — not just comment-only retries.
  it("initial fix_push with failed restart-review comment counts against recovery budget", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // Recovery fix agent: pushes a fix
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nFix it" },
      // Recovery Codex: fix_code
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the failing test"}' },
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    // The fix is pushed successfully but the /restart-review comment fails.
    // This is the INITIAL push (isRestartCommentPending=false), so the counter must increment.
    h.git.failNext("postComment");

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    // fix_pushed_restart_pending sentinel must be set.
    expect(s.stopDetail).toContain("fix_pushed_restart_pending");
    // The initial code fix must be charged: counter incremented from 0 to 1.
    expect(s.recoveryTurnAttempts).toBe(1);
  });

  // ES-493 Iteration 8 Finding 4: when the LAST allowed attempt pushes a fix but the
  // /restart-review comment fails, the session must NOT be abandoned immediately. The
  // fix_pushed_restart_pending sentinel lets the next daemon start retry only the comment
  // via the isRestartCommentPending bypass, preserving the already-pushed fix.
  it("last-allowed fix_push with failed restart-review comment preserves sentinel instead of abandoning", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a stopped session that already used one recovery attempt (counter=1 of max=2).
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix failing test",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryTurnAttempts: 1,  // one slot used; next attempt is the last (cap=2)
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Recovery planner: fix_code on the last allowed attempt
    planner.outcomes = [
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the failing test"}' },
    ];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    // Fix is pushed but /restart-review comment fails — this is the last allowed attempt.
    h.git.failNext("postComment");

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    // Must NOT be abandoned: fix is already in the PR, only the comment failed.
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).not.toBe("abandon");
    // fix_pushed_restart_pending sentinel must be set so the next start retries the comment.
    expect(s.stopDetail).toContain("fix_pushed_restart_pending");
    // Counter reaches the cap (1→2) but does not trigger abandon.
    expect(s.recoveryTurnAttempts).toBe(2);
  });

  // ES-493 Iteration 10 Finding 1: raw CI log payloads must not be rendered verbatim in
  // user-facing surfaces (Linear comments, notifications). When the recovery counter exhausts
  // and the session is abandoned, the needs-human triage comment must show a concise "CI failure"
  // label rather than the raw log body. stopDetail preserves the full "ci_log:<content>" form
  // so recovery agents still receive CI diagnostics on the next daemon start.
  it("ci_log payload stripped from triage comment on abandon; stopDetail preserves raw log", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed an in_review session that already used all recovery attempts (counter at cap).
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryTurnAttempts: 2,  // already at cap (maxRecoveryAttempts=2) → immediate abandon
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // CI log includes raw diagnostic output that must not leak into Linear comments.
    h.git.ciLogs = "FATAL: npm test failed\n  AssertionError: expected 1 to equal 2\n  at src/math.test.ts:5:3";
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    planner.outcomes = [];  // no recovery runs (counter exhausted → immediate abandon)

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.recoveryAction).toBe("abandon");
    // DB must retain the raw CI log for diagnostic use.
    expect(s.stopDetail).toMatch(/^ci_log:/);
    expect(s.stopDetail).toContain("npm test failed");
    // Triage comment must NOT contain the raw log — only "CI failure" as the concise label.
    const triageComment = h.source.comments.find(
      (c) => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)"),
    );
    expect(triageComment).toBeDefined();
    expect(triageComment!.body).not.toContain("npm test failed");
    expect(triageComment!.body).toContain("CI failure");
    // task_skipped notification must also not contain the raw log.
    const skippedEvent = h.notifier.events.find((e) => e.kind === "task_skipped");
    expect(skippedEvent).toBeDefined();
    expect((skippedEvent as { detail?: string }).detail).not.toContain("npm test failed");
    expect((skippedEvent as { detail?: string }).detail).toContain("CI failure");
  });

  // ES-493 Iteration 10 Finding 2: when a prior non-counter recovery (e.g. looppilot_stopped)
  // left recoveryAttempted=1 and the -1 sentinel, a subsequent counter-based (ci_failed) recovery
  // that fails transiently must clear the stale flag back to 0. Without the fix,
  // stoppedSessionsWithFailedRecovery (which requires recovery_attempted=0) cannot pick up the
  // session on the next daemon start, silently blocking all further retries.
  it("counter-based retry clears stale recoveryAttempted so stoppedSessionsWithFailedRecovery can retry", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a session with a stale recoveryAttempted=1 from a prior non-counter recovery.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 1,       // stale flag from a prior looppilot_stopped recovery
      recoveryTurnAttempts: -1,   // sentinel: -1 means non-counter set the flag
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.git.ciLogs = "test failure output";
    // Recovery planner: fix_code for the ci_failed stop.
    planner.outcomes = [
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the test"}' },
    ];
    h.agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "applied fix" }];
    // Provide a commit so the fix is considered pushed (not the "no commits" path).
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc123 fix the failing test\n" };
      return { code: 0, stdout: "" };
    });
    // Make the /restart-review comment fail → result.kind="failed", restartCommentOnly=true,
    // no preserveWorktree/nonRetryable → counter increment path fires.
    h.git.failNext("postComment");
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    // Counter was -1 (normalized to 0) → incremented to 1; cap is 2, so not yet abandoned.
    expect(s.state).toBe("stopped");
    expect(s.recoveryTurnAttempts).toBe(1);
    // The stale flag must be cleared so the daemon can retry on the next start.
    expect(s.recoveryAttempted).toBe(0);
    // stoppedSessionsWithFailedRecovery must now be able to find the session.
    expect(h.store.stoppedSessionsWithFailedRecovery()).toHaveLength(1);
    expect(h.store.stoppedSessionsWithFailedRecovery()[0].id).toBe(seeded.id);
  });

  // ES-493 Iteration 12 Finding 2: when counter exhaustion sets policy=abandon directly
  // (bypassing executeRecoveryTurn) and the session has a stale recoveryAttempted=1 from
  // a prior non-counter recovery, executeAbandon failing must not leave recovery_attempted=1.
  // stoppedSessionsWithFailedRecovery requires recovery_attempted=0 to retry the cleanup.
  it("cap-abandon: stale recoveryAttempted cleared before executeAbandon so failed cleanup is retryable", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed an in_review session with a stale recoveryAttempted=1 from a prior non-counter
    // recovery AND a counter already at cap, so the next ci_failed triggers immediate abandon.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 1,       // stale flag from a prior looppilot_stopped recovery
      recoveryTurnAttempts: 2,    // already at cap (maxRecoveryAttempts=2) → immediate abandon
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    planner.outcomes = [];  // no recovery runs (counter exhausted → immediate abandon)
    // Make gh pr close fail so executeAbandon returns { kind: "failed" }.
    h.recoveryRunner.on(["gh", "pr", "close"], { code: 1, stderr: "PR not found" });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    // The stale flag must be cleared so stoppedSessionsWithFailedRecovery can retry.
    expect(s.recoveryAttempted).toBe(0);
    // stop_detail must match abandon_in_progress% for stoppedSessionsWithFailedRecovery.
    expect(s.stopDetail).toMatch(/^abandon_in_progress/);
    // stoppedSessionsWithFailedRecovery must now find this session.
    expect(h.store.stoppedSessionsWithFailedRecovery()).toHaveLength(1);
    expect(h.store.stoppedSessionsWithFailedRecovery()[0].id).toBe(seeded.id);
  });

  // Codex Finding 2: a legacy looppilot_stopped/handoff_failed recovery that left
  // recoveryAttempted=1/recoveryTurnAttempts=0/recoveryAction=restart_review must NOT
  // trigger the legacy shim and must not consume a CI/merge budget slot.
  it("legacy non-counter recovery (recoveryAction=restart_review) does not consume CI/merge budget (Codex Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    // Pre-seed a session in legacy state from a prior looppilot_stopped recovery:
    // recoveryAttempted=1, recoveryTurnAttempts=0, recoveryAction=restart_review.
    // The new code's -1 sentinel was not available when this row was written.
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix CI",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 1,        // set by old code for a looppilot_stopped recovery
      recoveryTurnAttempts: 0,     // pre-migration (no counter written)
      recoveryAction: "restart_review", // looppilot_stopped recovery used restart_review
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    // Recovery planner: fix_code for the ci_failed stop.
    planner.outcomes = [
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the CI"}' },
    ];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    // Monitor: done → ci_failed → recovery succeeds → merged.
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("merged");
    // The shim must NOT have fired (restart_review is not a counter-based action).
    // effectiveRecoveryAttempts was 0 (not 1), so counter goes 0→1 on the single recovery.
    expect(s.recoveryTurnAttempts).toBe(1);
    // Exactly one recovery ran (full budget was available — the looppilot_stopped prior did not consume a slot).
    const recoveryStarted = h.notifier.events.filter((e) => e.kind === "recovery_started");
    expect(recoveryStarted).toHaveLength(1);
  });

  // Codex Finding 3: an interrupted ci_failed/merge_conflict recovery must roll back the
  // pre-persisted counter increment so repeated SIGINT interruptions do not exhaust the
  // maxRecoveryAttempts budget without any completed recovery.
  it("counter-based recovery interrupted → recoveryTurnAttempts rolled back (Codex Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery Codex is interrupted before choosing an action.
      { kind: "interrupted" },
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // The pre-persisted increment must be rolled back: counter stays at 0 (no slot consumed).
    expect(s.recoveryTurnAttempts).toBe(0);
    // recoveryAttempted must stay 0 so the next daemon can retry recovery.
    expect(s.recoveryAttempted).toBe(0);
    // Session remains in_review and run is halted.
    expect(s.state).toBe("in_review");
    expect(h.store.latestRun()!.state).toBe("halted");
  });

  // Codex Finding 3: when fix_code is interrupted AFTER commits are pushed to the remote
  // branch, the pre-persisted counter must NOT be rolled back — the slot is consumed even
  // if the daemon is restarted, preventing repeated interrupted-after-push runs from
  // bypassing the durable cap.
  it("fix_code interrupted after push → counter NOT rolled back (Codex Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },      // implement
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },  // self-review (no queue)
      { kind: "interrupted", costUsd: 0.2 },                            // recovery fix_code agent interrupted
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "ci_failed" as const };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery Codex chooses fix_code.
      { kind: "completed", text: '{"action":"fix_code","instruction":"fix the CI failure"}' },
    ];
    // Override the recovery runner's git -C handler so the log command reports commits
    // ahead of origin (hasPushableCommits → true), which triggers the push path in
    // executeFixCode and causes the interrupted result to carry hadSideEffects=true.
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix-attempt\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // The counter must NOT be rolled back: the push side effect occurred (hadSideEffects=true),
    // so the slot is consumed and recoveryTurnAttempts stays at 1.
    expect(s.recoveryTurnAttempts).toBe(1);
    // Session remains in_review and run is halted.
    expect(s.state).toBe("in_review");
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("Orchestrator — Failure Policy Routing (ES-490)", () => {
  // --- abandon policy tests ---
  it("agent_no_change → policy=abandon → pre-PR path → continues to next task", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },         // TY-1 implement
      { kind: "completed", costUsd: 1.0, summary: "done" },         // TY-2 implement
      { kind: "error", costUsd: 0.0, message: "self-review skipped" }, // TY-2 self-review
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    // Policy=abandon: session stopped, run continues to next task
    const sB = sessions.find((s) => s.linearIdentifier === "TY-2");
    expect(sB).toBeDefined();
    // task_skipped notification emitted for abandon
    const skipped = h.notifier.events.filter((e) => e.kind === "task_skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    // ES-492: needs-human label was added
    expect(h.source.labelAdds).toContainEqual({ issueId: "issue-A", labelName: "needs-human" });
    // ES-492: reason comment was posted (filter for the triage comment, not the design brief)
    const comment = h.source.comments.find(
      (c) => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)"),
    );
    expect(comment).toBeDefined();
    expect(comment!.body).toContain("agent_no_change");
    // ES-492: When addLabel succeeds (needs_human_label_added=1), the label is the cross-run
    // authority — the current-run DB guard does not apply (ES-492 Finding 2). Issue-A is still
    // excluded from the eligible list because the FakeTaskSource label simulation blocks it.
    const secondExcludes = h.source.eligibleCalls[1];
    expect(secondExcludes).toBeDefined();
    expect(secondExcludes).not.toContain("issue-A");
  });

  it("abandon attaches needs-human label and posts reason comment (pre-PR)", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false); // agent_no_change → abandon
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // needs-human label was added
    expect(h.source.labelAdds).toContainEqual({
      issueId: "issue-A",
      labelName: "needs-human",
    });
    // Reason comment was posted (filter for the triage comment, not the design brief)
    const comment = h.source.comments.find(
      (c) => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)"),
    );
    expect(comment).toBeDefined();
    expect(comment!.body).toContain("agent_no_change");
    expect(comment!.body).toContain("ラベルを外すと再投入されます");
    // task_skipped notification was emitted
    const skipped = h.notifier.events.filter(
      (e) => e.kind === "task_skipped" && e.identifier === "TY-1",
    );
    expect(skipped.length).toBe(1);
  });

  it("abandon continues even if addLabel fails", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];
    h.source.failNext("addLabel");

    await h.orch.run();

    // Run continued despite addLabel failure
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // Comment reflects the label failure
    const triageComment = h.source.comments.find(
      (c) => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)"),
    );
    expect(triageComment).toBeDefined();
    expect(triageComment!.body).toContain("ラベルの付与に失敗しました");
  });

  it("design_rejected → policy=abandon → continues (not HALT)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV2\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV3\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    // Issue B needs its own designer/agent outcomes
    designer.outcomes.push({ kind: "completed", text: "## Goal\nB\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" });
    reviewer.outcomes.push({ kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("design_rejected");
    // Run did NOT halt on design_rejected — continued to TY-2
    const sB = sessions.find((s) => s.linearIdentifier === "TY-2");
    expect(sB).toBeDefined();
  });

  it("abandon-policy reasons continue the run (agent_no_change proxy)", async () => {
    // Verify that reasons with policy=abandon (e.g. agent_no_change) continue the run.
    // Full verify_failed integration is tested in ES-491; here we use
    // agent_no_change as a proxy since it shares the same abandon policy.
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    expect(h.store.sessionsForRun(h.store.latestRun()!.id).length).toBeGreaterThanOrEqual(1);
  });

  // --- halt policy tests ---
  it("handoff_failed → policy=halt → stops run (ES-490)", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // Force addLabel to fail 3 times → handoff_failed
    h.git.addLabel = async (prNumber: number, label: string): Promise<void> => {
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      throw new Error("label API down");
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // halt policy → run halted without attempting recovery
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // TY-2 was never started
    expect(sessions.find((ss) => ss.linearIdentifier === "TY-2")).toBeUndefined();
  });

  // --- recover policy with ci_failed branch protection override ---
  it("ci_failed with branch protection detail → policy overridden to halt", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      // Self-review (non-fatal error → skipped)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      // No recovery outcome — should not reach Codex
    ];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "blocked" };
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toContain("merge blocked by branch protection");
    // Policy override: halt, not recover
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // No recovery attempted
    expect(s.recoveryAttempted).toBe(0);
  });

  // --- pre-PR abandon ---
  it("pre-PR abandon does not call executeAbandon (no gh pr close)", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    expect(sA.prNumber).toBeNull();
    // gh pr close was never called (no PR to close)
    const ghCalls = h.recoveryRunner.calls.filter((c) => c.cmd === "gh" && c.args.includes("pr"));
    expect(ghCalls).toHaveLength(0);
    // Run continued to TY-2
    expect(sessions.find((s) => s.linearIdentifier === "TY-2")).toBeDefined();
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
      h.memoryRunner.on(["git", "add", "-f", "--"], { code: 1, stderr: "fatal: index.lock exists" });

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

      // ES-470: catch block must clean up dirty memory files so they don't leak into SELECT.
      // bootstrap internal: 1 pair, GROOM commitIfChanged internal: 1 pair, catch block: 1 pair → total >= 3.
      // >= 2 would pass even without the catch block, so the stricter >= 3 is required.
      const checkoutMemCalls = h.memoryRunner.calls.filter(
        c => c.cmd === "git" && c.args[0] === "checkout" && c.args[3] === "docs/memory/",
      );
      expect(checkoutMemCalls.length).toBeGreaterThanOrEqual(3);
      const cleanMemCalls = h.memoryRunner.calls.filter(
        c => c.cmd === "git" && c.args[0] === "clean" && c.args[2] === "--" && c.args[3] === "docs/memory/",
      );
      expect(cleanMemCalls.length).toBeGreaterThanOrEqual(3);
      // git reset HEAD -- docs/memory/ is issued only by the catch-block fallback (the add-failure
      // internal path skips it); exactly 1 call proves the catch block actually ran its cleanup.
      const resetMemCalls = h.memoryRunner.calls.filter(
        c => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "HEAD" && c.args[3] === "docs/memory/",
      );
      expect(resetMemCalls.length).toBeGreaterThanOrEqual(1);

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
    // ES-503 Finding 1: full-tree clean uses -fd (not -fdx) to preserve ignored files at the
    // repo root; ignored memory files are cleaned separately with -fdx -- docs/memory/.
    const cleanCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "clean" && c.args[1] === "-fd" && !c.args.includes("docs/memory/"),
    );
    expect(cleanCall).toBeDefined();
    const cleanMemCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "clean" && c.args.includes("-fdx") && c.args.includes("docs/memory/"),
    );
    expect(cleanMemCall).toBeDefined();
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

describe("Orchestrator — アイドルタイムアウト（ES-475）", () => {
  it("idle 状態が idleTimeoutMinutes を超えると HALT する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, idleTimeoutMinutes: 60 });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const sleepCalls: number[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "-f", "--"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    // Clock: returns T=0, T+1s, T+2s, ... but after call #2
    // (which sets idle_started_at) jumps forward by 61 minutes.
    let clockCall = 0;
    let clockTime = Date.parse("2026-06-05T00:00:00.000Z");
    const clock = (): string => {
      clockCall++;
      const iso = new Date(clockTime).toISOString();
      // After call #2 (setIdleStartedAt), jump 61 minutes so the
      // timeout check in the next iteration sees elapsed > 60 min.
      if (clockCall === 2) {
        clockTime += 61 * 60_000;
      } else {
        clockTime += 1000;
      }
      return iso;
    };

    source.getAllEligible = async () => [];

    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent: new FakeAgentRunner(),
      selfReviewAgent: new FakeAgentRunner(),
      verifyAgent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor: new FakeMonitor(),
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async (ms) => { sleepCalls.push(ms); },
      log: (line) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner: null,
      designer: null,
      designReviewer: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: null,
    });

    await orch.run();

    const run = store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("idle timeout");
    expect(run.haltReason).toContain("60 minutes");

    const haltEvents = notifier.events.filter(
      (e) => e.kind === "halted" && (e as { reason: string }).reason === "idle_timeout",
    );
    expect(haltEvents).toHaveLength(1);

    store.close();
  });

  it("idle 時間が閾値以内なら HALT しない（recheck 継続）", async () => {
    // idleTimeoutMinutes=60, but clock only advances 1s per call
    // → timeout never fires. Loop exits because 2nd getAllEligible
    // returns a ticket, then task_cap=1 halts.
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 60 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall === 1) return [];
      return [issue("issue-A", "TY-1")];
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    // Halted by task_cap, NOT idle_timeout
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");

    h.store.close();
  });

  it("running 復帰で idle_started_at がクリアされ、再度 idle で再カウント", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 120 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall === 1) return []; // idle
      return [issue("issue-A", "TY-1")]; // recover
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // After recovery, idle_started_at should be cleared
    const run = h.store.latestRun()!;
    expect(run.idleStartedAt).toBeNull();

    h.store.close();
  });

  it("idleTimeoutMinutes=0 では idle が無限に続き HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 0 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall <= 3) return []; // 3 rounds of idle
      return [issue("issue-A", "TY-1")]; // then recover
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Halted by task_cap, NOT idle_timeout. idle ran 3 rounds without halt.
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");
    expect(h.sleepCalls.filter((ms) => ms === config.loop.idleRecheckSeconds * 1000)).toHaveLength(3);

    h.store.close();
  });

  it("DB に idle_started_at が残った状態で再チェック → 経過時間を引き継ぐ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, idleTimeoutMinutes: 60 });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "-f", "--"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    // Pre-create a run with idle_started_at already set 61 minutes ago
    const run = store.createRun(3, "2026-06-04T22:00:00.000Z");
    store.setRunState(run.id, "idle");
    store.setIdleStartedAt(run.id, "2026-06-04T22:00:00.000Z");

    // Clock starts at 61 minutes after idle_started_at
    const clock = fixedClock("2026-06-04T23:01:00.000Z");

    source.getAllEligible = async () => [];

    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent: new FakeAgentRunner(),
      selfReviewAgent: new FakeAgentRunner(),
      verifyAgent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor: new FakeMonitor(),
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async () => {},
      log: (line) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner: null,
      designReviewer: null,
      designer: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: null,
    });

    // run() creates a NEW run (not reusing the old one), so we need
    // to test via the store methods directly instead.
    // Verify the store layer correctly reads back the persisted value.
    const persisted = store.getRun(run.id);
    expect(persisted.idleStartedAt).toBe("2026-06-04T22:00:00.000Z");

    // Verify elapsed calculation works
    const now = Date.parse("2026-06-04T23:01:00.000Z");
    const elapsed = now - Date.parse(persisted.idleStartedAt!);
    expect(elapsed).toBeGreaterThanOrEqual(60 * 60_000);

    store.close();
  });

  it("前の run が halted なら idle_started_at を引き継がない（ES-475 Finding 1）", async () => {
    // Regression: a halted previous run must NOT propagate its stale idle_started_at to the
    // new run; otherwise the new run would time out immediately instead of starting fresh.
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 60 });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "-f", "--"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    // Self-review pre/post-review branch verification: rev-parse --abbrev-ref returns the
    // expected branch for the worktree so the guard passes without stopping the session.
    memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        const cIdx = args.indexOf("-C");
        const wtPath = cIdx >= 0 && cIdx + 1 < args.length ? args[cIdx + 1] : "";
        const slug = wtPath.replace(/^\/wt\//, "");
        return { code: 0, stdout: `looppilot/${slug}-x\n` };
      }
      if (args.includes("rev-parse") && args.includes("HEAD")) {
        return { code: 0, stdout: "abc1234\n" };
      }
      return { code: 0, stdout: "" };
    });

    // Previous run was halted while idle — stale idle_started_at is 2 hours in the past.
    const prevRun = store.createRun(3, "2026-06-05T00:00:00.000Z");
    store.setIdleStartedAt(prevRun.id, "2026-06-05T00:00:00.000Z");
    store.setRunState(prevRun.id, "halted", "idle_timeout");

    // Clock starts 2 hours after the stale idle_started_at, so inheriting it would
    // exceed the 60-minute threshold and cause an immediate halt.
    const clock = fixedClock("2026-06-05T02:01:00.000Z");

    // First eligible call returns nothing (goes idle); second returns a ticket so the run
    // exits cleanly via task_cap rather than idle_timeout.
    let eligibleCall = 0;
    source.getAllEligible = async () => {
      eligibleCall++;
      if (eligibleCall === 1) return [];
      return [issue("issue-A", "TY-1")];
    };

    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    const monitor = new FakeMonitor();
    monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent,
      selfReviewAgent: agent,
      verifyAgent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor,
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async () => {},
      log: (line) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      designReviewer: null,
      planner: null,
      designer: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: null,
    });

    await orch.run();

    const newRun = store.latestRun()!;
    // The run must NOT have halted with idle_timeout — the stale timer was not inherited.
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).not.toContain("idle timeout");
    expect(newRun.haltReason).toContain("task cap");

    store.close();
  });

  it("アイドルタイムアウト経過後は GROOM をスキップして HALT する（ES-475 Finding 2）", async () => {
    // Regression: when an already-idle run wakes up after the timeout threshold, GROOM must
    // NOT be invoked before halting. Previously the run paid for a full GROOM pass even
    // though it was going to halt anyway.
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 3, idleTimeoutMinutes: 60, groomEnabled: true });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "-f", "--"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    // Previous run was idle with idle_started_at 61 minutes in the past.
    const prevRun = store.createRun(3, "2026-06-05T00:00:00.000Z");
    store.setRunState(prevRun.id, "idle");
    store.setIdleStartedAt(prevRun.id, "2026-06-05T00:00:00.000Z");

    // Clock starts 61+ minutes after idle_started_at so the threshold is already exceeded.
    const clock = fixedClock("2026-06-05T01:01:00.000Z");

    source.getAllEligible = async () => [];

    const groomBoardFetcher = new FakeGroomBoardFetcher();
    const groomLinearClient = new FakeGroomLinearClient();

    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent: new FakeAgentRunner(),
      selfReviewAgent: new FakeAgentRunner(),
      verifyAgent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor: new FakeMonitor(),
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async () => {},
      log: (line) => { logs.push(line); },
      designReviewer: null,
      recovery: new FakeWorkflowRecovery(),
      planner,
      designer: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: {
        boardFetcher: groomBoardFetcher,
        linearClient: groomLinearClient,
        knownLabels: ["looppilot-os"],
      },
    });

    await orch.run();

    const newRun = store.latestRun()!;
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).toContain("idle timeout");

    // GROOM must NOT have been invoked — no board fetch, no groom_log entry.
    expect(groomBoardFetcher.calls).toHaveLength(0);
    expect(() => store.getGroomLog(1)).toThrow();

    store.close();
  });

  it("アイドルタイムアウト経過後に eligible チケットあり → blocked ID を取得して blocked チケットをフィルタリングする（ES-475）", async () => {
    // Regression: when idle has elapsed but SELECT returns tickets, fetchBlockedIds() must
    // still run so dependency-blocked tickets are not claimed (ES-475 Codex finding).
    const planner = new FakePlanRunner();
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 60, groomEnabled: true });
    const h = makeHarness(config, { planner });

    // Create a previous idle run with idle_started_at 61 minutes before the harness clock
    // (makeHarness clock is fixed at 2026-06-05T00:00:00.000Z).
    const prevRun = h.store.createRun(3, "2026-06-04T22:59:00.000Z");
    h.store.setRunState(prevRun.id, "idle");
    h.store.setIdleStartedAt(prevRun.id, "2026-06-04T22:59:00.000Z");

    // Board state: TY-1 is blocked, TY-2 is not blocked.
    h.groomBoardFetcher.boardState = {
      eligible: [{ identifier: "TY-2", title: "Title for TY-2", priority: 2, labels: [] }],
      inProgress: [],
      recentDone: [],
      blocked: [{ identifier: "TY-1", title: "Title for TY-1", priority: 2, labels: [], blockedBy: "ES-99" }],
    };

    // SELECT returns both TY-1 (blocked) and TY-2 (not blocked).
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // TY-1 (blocked) must NOT have been claimed; TY-2 must be claimed.
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.linearIdentifier).toBe("TY-2");
    expect(h.source.transitions.some((t) => t.issueId === "issue-A" && t.state === "in_progress")).toBe(false);

    // fetchBlockedIds must have called getBoardState, but full GROOM must NOT have run.
    expect(h.groomBoardFetcher.calls).toContain("getBoardState");
    // No groom_log entry means the full GROOM phase (planner) was never invoked.
    expect(() => h.store.getGroomLog(1)).toThrow();

    h.store.close();
  });
});

describe("Orchestrator DESIGN REVIEW gate (ES-477)", () => {
  it("approve → proceeds to IMPLEMENT", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.designReviewAttempts).toBe(0);
    expect(reviewer.calls).toHaveLength(1);
    // Brief posted to Linear exactly once (after approval, not during review)
    expect(h.source.comments.filter((c) => c.body.includes("## Goal"))).toHaveLength(1);
  });

  it("reject → redesign → approve → IMPLEMENT", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X v1\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nDo X v2\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Missing error handling"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.designReviewAttempts).toBe(1);
    expect(designer.calls).toHaveLength(2);
    expect(reviewer.calls).toHaveLength(2);
    // Second design prompt should contain the rejection reason
    expect(designer.calls[1]!.prompt).toContain("Missing error handling");
    // Brief posted to Linear only once (final approved brief, not the rejected draft)
    expect(h.source.comments.filter((c) => c.body.includes("## Goal"))).toHaveLength(1);
    expect(h.source.comments[0]!.body).toContain("v2");
  });

  it("reject N times → design_rejected session, run continues to task_cap", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV2\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV3\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 1"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 2"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 3"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("design_rejected");
    expect(s.stopDetail).toContain("Bad 3");
    // 1 initial design + 2 redesigns = 3 designer calls; 3 review calls
    expect(designer.calls).toHaveLength(3);
    expect(reviewer.calls).toHaveLength(3);
    // design_rejected is ticket-level: run halts via task_cap (not design_rejected)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");
    expect(s.designReviewAttempts).toBe(3);
    // No brief posted to Linear (all were rejected)
    expect(h.source.comments.filter((c) => c.body.includes("## Goal"))).toHaveLength(0);
  });

  it("skips DESIGN REVIEW when designReviewer is null", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer }); // no designReviewer
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.logs.some((l) => l.includes("designReview:"))).toBe(false);
  });

  it("review parse error → treat as approve (fallback)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: "I think this looks great, no issues!" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.logs.some((l) => l.includes("parse error"))).toBe(true);
  });

  it("logs review verdicts to design_review_log table", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV2\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Fix A"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const session = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    const log1 = h.store.getDesignReviewLog(1);
    expect(log1.sessionId).toBe(session.id);
    expect(log1.attempt).toBe(1);
    expect(log1.verdict).toBe("reject");
    expect(log1.outcome).toBe("rejected");

    const log2 = h.store.getDesignReviewLog(2);
    expect(log2.attempt).toBe(2);
    expect(log2.verdict).toBe("approve");
    expect(log2.outcome).toBe("approved");
  });

  it("SIGINT during review halts cleanly without proceeding to IMPLEMENT", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [{ kind: "interrupted" }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // Agent was never called (IMPLEMENT never ran)
    expect(h.agent.contexts).toHaveLength(0);
  });

  it("reviewer error → treat as approve (fail-open)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [{ kind: "error", message: "codex crashed" }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(h.logs.some((l) => l.includes("reviewer failed") && l.includes("codex crashed"))).toBe(true);
  });

  it("designer failure on redesign → design_rejected session, run continues to task_cap", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "error", message: "agent crashed on redesign" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Fix X"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("design_rejected");
    expect(s.stopDetail).toContain("redesign agent failed");
    // Run halts via task_cap (not design_rejected)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");
    // IMPLEMENT never ran
    expect(h.agent.contexts).toHaveLength(0);
  });

  it("discards uncommitted reviewer changes after each review turn", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // discardUncommittedChanges must have been called on the reviewer worktree
    expect(h.git.calls.some((c) => c.method === "discardUncommittedChanges" && c.args[0] === "/wt/ty-1")).toBe(true);
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
  });

  it("discards uncommitted reviewer changes even when reviewer throws exception", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    // No outcomes queued → FakePlanRunner throws
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Exception path must also clean up the worktree
    expect(h.git.calls.some((c) => c.method === "discardUncommittedChanges" && c.args[0] === "/wt/ty-1")).toBe(true);
    // Treated as approve → session proceeds
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
  });

  it("resets worktree to startSha after reviewer runs to undo any reviewer-created commits (ES-477 Finding 3)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // git reset --hard <startSha> must be called on the worktree path (not repoPath)
    const resetOnWorktree = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard" && c.args[2] === "abc1234" && c.opts.cwd === "/wt/ty-1",
    );
    expect(resetOnWorktree.length).toBeGreaterThan(0);
  });

  it("resets worktree to startSha even when reviewer throws exception (ES-477 Finding 3)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    // No outcomes queued → FakePlanRunner throws
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Exception path must also reset to startSha on the worktree path
    const resetOnWorktree = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard" && c.args[2] === "abc1234" && c.opts.cwd === "/wt/ty-1",
    );
    expect(resetOnWorktree.length).toBeGreaterThan(0);
  });

  it("captures Linear transition failure in stop detail when max redesigns exceeded and halts run (ES-477 Finding 2, ES-458)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV2\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      { kind: "completed", text: "## Goal\nV3\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 1"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 2"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad 3"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    // Override transition to succeed for "in_progress" (CLAIM) but fail for "todo" (design rejection revert)
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (...args: Parameters<typeof h.source.transition>): Promise<void> => {
      if (args[1] === "todo") throw new Error("Linear outage");
      return origTransition(...args);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("design_rejected");
    // Stop detail must include both the rejection reason and the transition failure
    expect(s.stopDetail).toContain("Bad 3");
    expect(s.stopDetail).toContain("todo revert failed");
    expect(s.stopDetail).toContain("Linear outage");
    expect(h.logs.some((l) => l.includes("todo revert failed") && l.includes("Linear outage"))).toBe(true);
    // When todo revert fails the ticket is stuck In Progress — the run must halt so
    // operators can intervene rather than continuing and leaving the ticket orphaned (ES-458).
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("design_rejected");
    expect(run.haltReason).toContain("todo revert failed");
    // A halted notification must be emitted so operators see the halt in Slack/console (ES-458).
    const haltNotifications = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltNotifications.length).toBeGreaterThanOrEqual(1);
    expect((haltNotifications[0] as { reason: string }).reason).toBe("design_rejected");
  });

  it("captures Linear transition failure in stop detail when redesign agent returns null brief and halts run (ES-477 Finding 2, ES-458)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nV1\n\n## Change Targets\n- f\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
      // Second design agent errors out, causing brief: null
      { kind: "error", message: "agent crashed on redesign" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Needs work"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    // Override transition to succeed for "in_progress" (CLAIM) but fail for "todo" (design rejection revert)
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (...args: Parameters<typeof h.source.transition>): Promise<void> => {
      if (args[1] === "todo") throw new Error("Linear outage");
      return origTransition(...args);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("design_rejected");
    expect(s.stopDetail).toContain("redesign agent failed");
    expect(s.stopDetail).toContain("todo revert failed");
    expect(s.stopDetail).toContain("Linear outage");
    // When todo revert fails the ticket is stuck In Progress — the run must halt (ES-458).
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("design_rejected");
    expect(run.haltReason).toContain("todo revert failed");
    // A halted notification must be emitted so operators see the halt in Slack/console (ES-458).
    const haltNotifications = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltNotifications.length).toBeGreaterThanOrEqual(1);
    expect((haltNotifications[0] as { reason: string }).reason).toBe("design_rejected");
  });

  it("requestStop() during reviewer run → HALT without redesign when reviewer rejects (ES-477 Finding 1)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["Bad design"]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];

    // Trigger interrupt during the reviewer run so it fires after reviewer returns reject
    const origRun = reviewer.run.bind(reviewer);
    reviewer.run = async (ctx: { worktreePath: string; prompt: string; timeoutMs?: number }) => {
      h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    // IMPLEMENT never ran (no redesign attempted after interrupt)
    expect(h.agent.contexts).toHaveLength(0);
    // Designer was called exactly once (no redesign)
    expect(designer.calls).toHaveLength(1);
  });

  it("checkouts the claimed branch before resetting to startSha after reviewer runs (ES-477 Finding 4)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // git checkout <session.branch> must be called on the worktree path before the reset
    const checkoutOnWorktree = h.memoryRunner.calls.filter(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args[1] === "looppilot/ty-1-x" && c.opts.cwd === "/wt/ty-1",
    );
    expect(checkoutOnWorktree.length).toBeGreaterThan(0);

    // The checkout must precede the reset --hard in the call sequence
    const checkoutIdx = h.memoryRunner.calls.findIndex(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args[1] === "looppilot/ty-1-x" && c.opts.cwd === "/wt/ty-1",
    );
    const resetIdx = h.memoryRunner.calls.findIndex(
      (c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard" && c.opts.cwd === "/wt/ty-1",
    );
    expect(checkoutIdx).toBeLessThan(resetIdx);
  });

  it("halts without running IMPLEMENT when branch restore fails after reviewer runs (ES-477 Finding 4)", async () => {
    const designer = new FakePlanRunner();
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo X\n\n## Change Targets\n- f.ts\n\n## Implementation Steps\n1. S\n\n## Acceptance Criteria\n- P\n\n## Out of Scope\n- N" },
    ];
    const reviewer = new FakePlanRunner();
    reviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { designer, designReviewer: reviewer });
    h.source.queue = [issue("issue-A", "TY-1")];

    // Make the session-branch checkout fail (longest prefix wins over the 2-element default stub).
    h.memoryRunner.on(["git", "checkout", "looppilot/ty-1-x"], { code: 1, stderr: "error: pathspec 'looppilot/ty-1-x' did not match any file(s) known to git" });

    await h.orch.run();

    // IMPLEMENT must never have run.
    expect(h.agent.contexts).toHaveLength(0);
    // A log message explaining the halt must be emitted.
    expect(h.logs.some((l) => l.includes("branch restore failed"))).toBe(true);
  });
});

describe("Self-Review (ES-473)", () => {
  it("self-review session runs after IMPLEMENT and before HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    // IMPLEMENT outcome + SELF-REVIEW outcome
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "did the work" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Two agent sessions were run (IMPLEMENT + SELF-REVIEW)
    expect(h.agent.contexts).toHaveLength(2);
    // The second prompt should contain self-review markers
    expect(h.agent.contexts[1].prompt).toContain("self-review");
    // Session should have completed
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    // Self-review cost is tracked
    expect(sessions[0].selfReviewCostUsd).toBe(0.3);
  });

  it("self-review fixes issues and proceeds to HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.5, summary: '```json\n{"verdict":"pass","issues":["Fixed missing validation"],"summary":"Fixed 1 issue."}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // Self-review claims to have fixed issues (issues.length > 0), so HEAD must move
    // to satisfy the SHA consistency guard. Use a counter so the second rev-parse HEAD
    // call (post-review) returns a different SHA than the first (pre-review).
    let headCallCount = 0;
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "looppilot/ty-1-x\n" };
      }
      if (args.includes("rev-parse") && args.includes("HEAD")) {
        headCallCount++;
        return { code: 0, stdout: headCallCount <= 1 ? "sha-before\n" : "sha-after\n" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].selfReviewCostUsd).toBe(0.5);
  });

  it("self-review agent error -> logs warning, proceeds to HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.1, message: "agent crashed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(h.logs.some((l) => l.includes("selfReview") && l.includes("agent crashed"))).toBe(true);
  });

  it("self-review agent interrupted -> HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "interrupted", costUsd: 0.1 },
    ];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
  });

  it("requestStop() before self-review -> deferred to post-review safe point (ES-473 Finding 2)", async () => {
    // The safe point is deferred until AFTER self-review so the session always
    // has a self_review_log entry, making it recoverable on the next startup.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      // Self-review runs even when stop was requested before it started
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    // Request stop after IMPLEMENT completes (before self-review)
    const origRunSession = h.agent.runSession.bind(h.agent);
    let callCount = 0;
    h.agent.runSession = async (ctx) => {
      callCount++;
      if (callCount === 1) {
        const result = await origRunSession(ctx);
        h.orch.requestStop();
        return result;
      }
      return origRunSession(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // Self-review MUST have run (safe stop deferred past review gate)
    expect(callCount).toBe(2);
    // No PR should have been opened (stop was honored after self-review)
    const sessions = h.store.sessionsForRun(run.id);
    expect(sessions[0].prNumber).toBeNull();
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // A self-review log must be present (enables recovery)
    const srLog = h.store.getSelfReviewLogsForSession(sessions[0].id);
    expect(srLog).toHaveLength(1);
    expect(srLog[0].outcome).toBe("passed");
  });

  it("self-review parse error -> logs warning, proceeds to HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.2, summary: "no json output" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(h.logs.some((l) => l.includes("selfReview") && l.includes("parse"))).toBe(true);
  });

  it("self-review execution is logged to self_review_log table", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"OK"}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const log = h.store.getSelfReviewLogsForSession(sessions[0].id);
    expect(log).toHaveLength(1);
    expect(log[0].verdict).toBe("pass");
    expect(log[0].outcome).toBe("passed");
    expect(log[0].costUsd).toBe(0.3);
  });

  it("selfReview.enabled=false skips self-review entirely", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as { selfReview: { enabled: boolean } }).selfReview.enabled = false;
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    // Only 1 agent outcome needed (IMPLEMENT only, no self-review)
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "did the work" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Only 1 agent session ran (IMPLEMENT, no self-review)
    expect(h.agent.contexts).toHaveLength(1);
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    // No self-review log created
    const log = h.store.getSelfReviewLogsForSession(sessions[0].id);
    expect(log).toHaveLength(0);
    // selfReviewCostUsd stays null
    expect(sessions[0].selfReviewCostUsd).toBeNull();
  });

  it("self-review verdict=fail → session stopped, no PR opened (ES-473 Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.4, summary: '```json\n{"verdict":"fail","issues":["Missing required feature X"],"summary":"Feature X not implemented."}\n```' },
    ];

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // Session must be stopped — not allowed to proceed to HANDOFF
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("exception");
    expect(sessions[0].stopDetail).toContain("self-review verdict=fail");
    // No PR should have been opened
    expect(sessions[0].prNumber).toBeNull();
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // Run should be halted
    expect(run.state).toBe("halted");
    // The self-review log must still record the verdict
    const log = h.store.getSelfReviewLogsForSession(sessions[0].id);
    expect(log[0].verdict).toBe("fail");
    expect(log[0].outcome).toBe("failed");
  });

  it("self-review leaves uncommitted changes → session stopped, no PR opened (ES-473 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.4, summary: '```json\n{"verdict":"pass","issues":["Fixed validation"],"summary":"Fixed 1 issue."}\n```' },
    ];
    // IMPLEMENT check returns false (clean commit), self-review check returns true (dirty)
    let uncommittedCallCount = 0;
    const origHasUncommitted = h.git.hasUncommittedChanges.bind(h.git);
    h.git.hasUncommittedChanges = async (worktreePath: string): Promise<boolean> => {
      uncommittedCallCount++;
      if (uncommittedCallCount <= 1) return false; // post-IMPLEMENT: clean
      return origHasUncommitted(worktreePath); // post-self-review: delegate to map
    };
    h.git.uncommitted.set("/wt/ty-1", true); // reviewer left uncommitted changes

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // Session must be stopped — uncommitted self-review changes must not be silently dropped
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("agent_no_change");
    expect(sessions[0].stopDetail).toContain("self-review left uncommitted changes");
    // No PR should have been opened
    expect(sessions[0].prNumber).toBeNull();
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // Run should be halted
    expect(run.state).toBe("halted");
  });

  it("requestStop() during self-review agent → HALT before HANDOFF (Codex Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      // Self-review agent returns a normal result even though requestStop was called
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    // Request stop during the self-review agent run (2nd agent call)
    const origRunSession = h.agent.runSession.bind(h.agent);
    let callCount = 0;
    h.agent.runSession = async (ctx) => {
      callCount++;
      if (callCount === 2) {
        // requestStop() fires while self-review is running
        h.orch.requestStop();
      }
      return origRunSession(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    // Must HALT — not proceed to HANDOFF
    expect(run.state).toBe("halted");
    // No PR should have been opened
    const sessions = h.store.sessionsForRun(run.id);
    expect(sessions[0].prNumber).toBeNull();
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("self-review cost_exceeded discards uncommitted changes before HANDOFF (Codex Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "cost_exceeded", costUsd: 2.0 },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    // Should proceed to HANDOFF (cost_exceeded is non-fatal)
    expect(sessions[0].state).toBe("merged");
    // discardUncommittedChanges must have been called to clean up
    expect(h.git.calls.some((c) => c.method === "discardUncommittedChanges")).toBe(true);
  });

  it("self-review cost_exceeded resets any pre-review commits (ES-473 Finding 2)", async () => {
    // If the self-review agent committed partial fixes and then hit cost_exceeded,
    // those commits must be reset to preReviewSha so they don't silently end up in the PR.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "cost_exceeded", costUsd: 2.0 },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    // Return a real SHA for rev-parse HEAD so the reset target is known
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "preReviewSha111\n" };
      }
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "looppilot/ty-1-x\n" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    // git reset --hard <preReviewSha> must have been issued to undo any commits
    const resetCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args.includes("reset") && c.args.includes("--hard") && c.args.includes("preReviewSha111"),
    );
    expect(resetCall).toBeDefined();
  });

  it("self-review cost adds to session costUsd total (ES-473 Finding 3)", async () => {
    // selfReviewCostUsd must be included in the reported session cost, not tracked
    // only in a separate column that consumers don't read.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    // Total cost = IMPLEMENT + SELF-REVIEW
    expect(sessions[0].costUsd).toBeCloseTo(1.8);
    expect(sessions[0].selfReviewCostUsd).toBe(0.3);
  });

  it("self-review error cost adds to session costUsd total (ES-473 Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.1, message: "agent crashed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    // Non-fatal self-review error: session proceeds to HANDOFF but cost is included
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].costUsd).toBeCloseTo(1.6);
    expect(sessions[0].selfReviewCostUsd).toBe(0.1);
  });

  it("self-review agent on wrong branch → session stopped (ES-473 Finding 4)", async () => {
    // If the agent checked out a different branch and committed there, restoring the
    // session branch silently drops those commits from the PR. Stop unconditionally
    // so human review can recover or cherry-pick the off-branch commits.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    // Override the memoryRunner to report the wrong branch
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "some-other-branch\n" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // Session must be stopped — off-branch commits would be silently dropped if we restored
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("exception");
    expect(sessions[0].stopDetail).toContain("wrong branch");
    expect(sessions[0].stopDetail).toContain("some-other-branch");
    expect(sessions[0].prNumber).toBeNull();
    expect(h.logs.some((l) => l.includes("selfReview") && l.includes("wrong branch"))).toBe(true);
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("self-review agent on wrong branch (detached HEAD) → session stopped (ES-473 Finding 4)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    // Override the memoryRunner: detached HEAD
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "HEAD\n" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("exception");
    expect(sessions[0].stopDetail).toContain("wrong branch");
    expect(sessions[0].prNumber).toBeNull();
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("self-review cost_exceeded: cleanup reset failure → session stopped (ES-473 Finding 3)", async () => {
    // If git reset --hard fails during nonfatal cleanup, we must stop rather than
    // letting unreviewed partial commits reach HANDOFF.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "cost_exceeded", costUsd: 2.0 },
    ];
    // Return a real SHA so preReviewSha is captured, then make reset fail
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "looppilot/ty-1-x\n" };
      }
      if (args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "abc1234\n" };
      }
      if (args.includes("reset") && args.includes("--hard")) {
        return { code: 128, stdout: "", stderr: "fatal: could not reset" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("exception");
    expect(sessions[0].stopDetail).toContain("cleanup reset failed");
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("self-review pass with no issues but HEAD moved → session stopped (ES-473 Finding 4)", async () => {
    // A reviewer that accidentally commits changes but reports no issues should be
    // detected: those unreported commits must not silently reach the PR.
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 0.3, summary: '```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```' },
    ];
    let headCallIndex = 0;
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "looppilot/ty-1-x\n" };
      }
      if (args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
        headCallIndex++;
        // First call: capture preReviewSha. Second call: return a different SHA (HEAD moved).
        return { code: 0, stdout: headCallIndex === 1 ? "sha-before\n" : "sha-after\n" };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].failureReason).toBe("exception");
    expect(sessions[0].stopDetail).toContain("unreported commits");
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("self-review uses selfReviewAgent, not the implement agent", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { selfReviewAgent });
    h.source.queue = [issue("issue-A", "TY-1")];
    // IMPLEMENT outcome on the main agent
    h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
    // SELF-REVIEW outcome on the dedicated selfReviewAgent
    selfReviewAgent.outcomes.push({
      kind: "completed", costUsd: 0.5, summary: '```json\n{"verdict":"pass","issues":[],"summary":"LGTM"}\n```',
    });
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The implement agent should have 1 call (IMPLEMENT), selfReviewAgent should have 1 call (SELF-REVIEW)
    expect(h.agent.callCount).toBe(1);
    expect(selfReviewAgent.callCount).toBe(1);
    // selfReviewAgent received the self-review prompt
    expect(selfReviewAgent.contexts[0].prompt).toContain("self-review");
    // Session completed successfully
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].selfReviewCostUsd).toBe(0.5);
  });
});

describe("Orchestrator per-phase model/effort config (ES-486 Task 4)", () => {
  it("GROOM passes pm.model and pm.effort.groom to the planner context", async () => {
    const config = makeConfig({ groomEnabled: true });
    (config as any).pm = { model: "gpt-5.5", effort: { groom: "medium", select: "low", designReview: "high", recovery: "high" } };
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: new FakePlanRunner() });
    h.source.queue = [issue("A", "TY-1")];
    // GROOM outcome
    planner.outcomes.push({ kind: "completed", text: '{"actions":[],"summary":"all good","blocked_issues":[]}' });
    // SELECT outcome
    planner.outcomes.push({ kind: "completed", text: '{"identifier":"TY-1"}' });
    // DESIGN outcome
    (h as any).orch["designer"]?.outcomes.push({ kind: "completed", text: "brief" });
    h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
    h.monitor.verdicts.push({ kind: "merged" });
    await h.orch.run();

    // Check that the first planner call (GROOM) had model/effort
    const groomCtx = planner.contexts[0];
    expect(groomCtx.model).toBe("gpt-5.5");
    expect(groomCtx.effort).toBe("medium");
  });

  it("SELECT passes pm.model and pm.effort.select to the planner context", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).pm = { model: "gpt-5.5", effort: { groom: "medium", select: "low", designReview: "high", recovery: "high" } };
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: new FakePlanRunner() });
    h.source.queue = [issue("A", "TY-1"), issue("B", "TY-2")];
    // SELECT outcome
    planner.outcomes.push({ kind: "completed", text: '{"identifier":"TY-1"}' });
    (h as any).orch["designer"]?.outcomes.push({ kind: "completed", text: "brief" });
    h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
    h.monitor.verdicts.push({ kind: "merged" });
    await h.orch.run();
    // First planner call is SELECT (groom disabled by default)
    const selectCtx = planner.contexts[0];
    expect(selectCtx.model).toBe("gpt-5.5");
    expect(selectCtx.effort).toBe("low");
  });

  it("DESIGN REVIEW passes pm.model and pm.effort.designReview", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).pm = { model: "gpt-5.5", effort: { groom: "medium", select: "low", designReview: "high", recovery: "high" } };
    const selectPlanner = new FakePlanRunner();
    const reviewPlanner = new FakePlanRunner();
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { planner: selectPlanner, designer, designReviewer: reviewPlanner });
    h.source.queue = [issue("A", "TY-1")];
    selectPlanner.outcomes.push({ kind: "completed", text: '{"identifier":"TY-1"}' });
    designer.outcomes.push({ kind: "completed", text: "## Goal\ngoal\n## Change Targets\ntargets\n## Steps\nsteps\n## Acceptance Criteria\nac\n## Out of Scope\noos" });
    reviewPlanner.outcomes.push({ kind: "completed", text: '{"verdict":"approve"}' });
    h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
    h.monitor.verdicts.push({ kind: "merged" });
    await h.orch.run();
    const reviewCtx = reviewPlanner.contexts[0];
    expect(reviewCtx.model).toBe("gpt-5.5");
    expect(reviewCtx.effort).toBe("high");
  });
});

describe("VERIFY (ES-491)", () => {
  it("verify pass → proceeds to HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Test\n5 passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].verifyAttempts).toBe(1);

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].verdict).toBe("pass");
    expect(verifyLogs[0].outcome).toBe("passed");
  });

  it("verify evidence agent exception → fail-open pass", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // verifyAgent has no outcomes queued → FakeAgentRunner throws
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].errorDetail).toContain("fail-open");
  });

  it("verify judge parse error → fail-open pass", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    // Judge returns unparseable text
    planner.outcomes = [
      { kind: "completed", text: "I cannot determine the verdict sorry" },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].errorDetail).toContain("fail-open: parse error");
  });

  it("verify with no planner → fail-open pass", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    // No planner
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].errorDetail).toContain("fail-open: no planner");
  });

  it("verify fail → re-implement with reasons → verify pass", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    // 1st judgment: fail, 2nd judgment: pass
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["test suite has 2 failures"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    // 1 issue → SELECT skipped (eligible.length === 1), planner consumed only by VERIFY
    h.source.queue = [issue("issue-A", "TY-1")];
    // 1st IMPLEMENT + 1st SELF-REVIEW (error=fail-open) + 2nd IMPLEMENT (fix) + 2nd SELF-REVIEW (error=fail-open)
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 1.0, summary: "fixed based on verify feedback" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // 1st evidence (fail attempt) + 2nd evidence (pass attempt)
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Test\n2 failures" },
      { kind: "completed", costUsd: 0.4, summary: "## Test\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].verifyAttempts).toBe(2);

    // Second IMPLEMENT prompt should contain verify failure reasons
    // h.agent.contexts holds all runSession calls (both IMPLEMENT and SELF-REVIEW)
    // IMPLEMENT prompts do not include "self-review"; SR prompts do
    const implPrompts = h.agent.contexts.filter(c => !c.prompt.includes("self-review"));
    expect(implPrompts[1].prompt).toContain("test suite has 2 failures");

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(2);
    expect(verifyLogs[0].verdict).toBe("fail");
    expect(verifyLogs[1].verdict).toBe("pass");
  });

  it("max_verify_attempts exceeded → verify_failed → abandon → loop continues", async () => {
    // maxTasksPerRun: 2 so the loop can process TY-2 after TY-1 is abandoned
    const config = makeConfig({ maxTasksPerRun: 2 });
    const planner = new FakePlanRunner();
    // 3 outcomes:
    //   [0] SELECT: 2 eligible → selectWithPm called; non-identifier JSON → falls back to TY-1
    //   [1] VERIFY attempt 1 for TY-1: fail
    //   [2] VERIFY attempt 2 for TY-1: fail → max attempts (2) → verify_failed
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["tests fail"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["tests fail"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["still failing"]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    // TY-1: IMPL1 + SR1(fail-open) + IMPL2(fix) + SR2(fail-open)
    // TY-2: IMPL + SR(fail-open)
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 1.0, summary: "fixed" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // TY-2
      { kind: "completed", costUsd: 1.0, summary: "B done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // Evidence for TY-1's 2 verify attempts; TY-2's verifyAgent throws (empty) → fail-open
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "evidence 1" },
      { kind: "completed", costUsd: 0.4, summary: "evidence 2" },
    ];
    // TY-2 monitor (TY-1 never reaches HANDOFF/MONITOR)
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);

    // TY-1: abandoned after verify_failed at max attempts
    const ty1 = sessions.find(s => s.linearIdentifier === "TY-1")!;
    expect(ty1.state).toBe("stopped");
    expect(ty1.failureReason).toBe("verify_failed");
    expect(ty1.verifyAttempts).toBe(2);

    // TY-2: proceeds normally; verifyAgent throws (no evidence queued) → fail-open → merged
    const ty2 = sessions.find(s => s.linearIdentifier === "TY-2")!;
    expect(ty2.state).toBe("merged");
  });

  it("worktree protection resets to post-IMPLEMENT SHA (preserves impl commits)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    // Provide a real SHA for the post-IMPLEMENT capture: git -C /wt/ty-1 rev-parse HEAD.
    // The default [-C] handler returns "" for this variant, so we register a more specific stub.
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD"], { code: 0, stdout: "abc1234\n" });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "evidence collected" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // cleanupVerifierWorktree must have called git reset --hard <postImplSha>.
    // Calls are { cmd, args, opts }; the reset is: git -C /wt/ty-1 reset --hard abc1234.
    const resetCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "git" && c.args.includes("reset") && c.args.includes("--hard"),
    );
    expect(resetCalls.length).toBeGreaterThanOrEqual(1);
    const resetWithSha = resetCalls.find(c => c.args.includes("abc1234"));
    expect(resetWithSha).toBeDefined();
  });

  it("crash recovery: verify passed → resumes HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    // Simulate a prior run that crashed after VERIFY passed but before HANDOFF.
    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    // Self-review passed.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Verify passed.
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, { endedAt: "2026-06-05T00:02:00.000Z", outcome: "passed", verdict: "pass" });

    // FakeGitPr defaults: hasCommitsWithDiff → true, hasUncommittedChanges → false.
    // Crash recovery path requires commits and a clean worktree to resume HANDOFF.

    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Recovery must have handed off: pushAndOpenPr should have been called.
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("crash recovery: verify error (fail-open) → resumes HANDOFF", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    // Simulate a prior run that crashed after VERIFY error (fail-open) but before HANDOFF.
    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    // Self-review passed.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Verify error (fail-open).
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, { endedAt: "2026-06-05T00:02:00.000Z", outcome: "error", errorDetail: "fail-open: evidence cost exceeded" });

    // FakeGitPr defaults: hasCommitsWithDiff → true, hasUncommittedChanges → false.
    // Crash recovery path requires commits and a clean worktree to resume HANDOFF.

    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Recovery must have handed off: pushAndOpenPr should have been called.
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("crash recovery: verify not completed → resumes VERIFY (with acceptance criteria)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    // Store a plan brief with acceptance criteria so VERIFY can be resumed.
    h.store.updateSession(session.id, { planBrief: "## Acceptance Criteria\nThe feature works." });
    // Self-review passed but NO verify_log entries — crashed before VERIFY started.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Allow recovery to proceed: verifyAgent throws (no outcome queued → fail-open pass),
    // then HANDOFF creates a PR, and MONITOR resolves merged.
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Recovery resumed VERIFY instead of halting for manual review.
    expect(h.logs.some(l => l.includes("resuming VERIFY"))).toBe(true);
    // Verify ran and logged a fail-open pass (verifyAgent had no outcome queued → threw).
    const verifyLogs = h.store.getVerifyLogsForSession(session.id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].errorDetail).toContain("fail-open");
  });

  it("crash recovery: verify not completed, no acceptance criteria → halts for human review", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    // No planBrief set — acceptance criteria unavailable.
    // Self-review passed but NO verify_log entries — crashed before VERIFY started.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });

    await h.orch.run();

    // Recovery must halt because there are no acceptance criteria for VERIFY.
    expect(h.logs.some(l => l.includes("no acceptance criteria for VERIFY"))).toBe(true);
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions.some(s => s.state === "stopped")).toBe(true);
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("crash recovery: verify failed → resumes IMPLEMENT before re-running VERIFY", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    // Use a dedicated selfReviewAgent so h.agent counts only IMPLEMENT calls.
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing", verifyAttempts: 1 });
    h.store.updateSession(session.id, { planBrief: "## Acceptance Criteria\nThe feature works." });
    // Self-review log passed before the crash.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Prior VERIFY attempt failed — crashed before IMPLEMENT fix could run.
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, {
      endedAt: "2026-06-05T00:02:00.000Z", outcome: "failed",
      verdict: "fail", reasonCount: 1,
    });
    // IMPLEMENT fix succeeds; selfReviewAgent has no outcomes → throws (non-fatal) → proceed;
    // then verifyAgent has no outcomes → throws → fail-open pass → HANDOFF → MONITOR merged.
    h.agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fixed the verify failure" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Recovery must have logged "resuming IMPLEMENT then VERIFY", not "resuming VERIFY".
    expect(h.logs.some(l => l.includes("prior verify failed") && l.includes("resuming IMPLEMENT"))).toBe(true);
    // IMPLEMENT must have run (h.agent was called exactly once for the fix).
    expect(h.agent.callCount).toBe(1);
    // Verify ran again after the fix and logged a fail-open pass (verifyAgent had no outcomes).
    const allVrLogs = h.store.getVerifyLogsForSession(session.id);
    expect(allVrLogs.length).toBeGreaterThanOrEqual(2);
    expect(allVrLogs[allVrLogs.length - 1]!.outcome).toBe("passed");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("crash recovery: verify failed but fix commit already landed → resumes VERIFY, not IMPLEMENT (ES-491 F2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing", verifyAttempts: 1 });
    h.store.updateSession(session.id, { planBrief: "## Acceptance Criteria\nThe feature works." });
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Prior VERIFY attempt failed and recorded the HEAD it judged. The verify-fix IMPLEMENT then
    // committed a fix (HEAD advanced to the harness default "abc1234") before the crash.
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, {
      endedAt: "2026-06-05T00:02:00.000Z", outcome: "failed",
      verdict: "fail", reasonCount: 1, verifiedHeadSha: "oldsha000-pre-fix",
    });
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // A fix commit landed since the failed verify → recovery resumes VERIFY (judges the landed
    // fix) rather than re-running IMPLEMENT, which would no-op and trip the no-change guard.
    expect(h.logs.some(l => l.includes("verify-fix commit already landed") && l.includes("resuming VERIFY"))).toBe(true);
    expect(h.logs.some(l => l.includes("resuming IMPLEMENT"))).toBe(false);
    // IMPLEMENT must NOT have run.
    expect(h.agent.callCount).toBe(0);
    // VERIFY ran (verifyAgent had no outcomes → fail-open pass) → HANDOFF.
    const allVrLogs = h.store.getVerifyLogsForSession(session.id);
    expect(allVrLogs.length).toBeGreaterThanOrEqual(2);
    expect(allVrLogs[allVrLogs.length - 1]!.outcome).toBe("passed");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("crash recovery: verify not completed, no brief but ticket description present → resumes VERIFY (ES-491 F4)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      // No plan brief, but the ticket description carries the acceptance criteria (e.g. DESIGN
      // disabled). Recovery must use the persisted description rather than halting.
      issueDescription: "## Acceptance Criteria\nThe feature works end to end.",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    // No planBrief set — acceptance criteria live only in the persisted ticket description.
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Recovery resumed VERIFY using the ticket description as acceptance fallback.
    expect(h.logs.some(l => l.includes("resuming VERIFY"))).toBe(true);
    expect(h.logs.some(l => l.includes("no acceptance criteria for VERIFY"))).toBe(false);
    const verifyLogs = h.store.getVerifyLogsForSession(session.id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  it("verify: untracked artifacts from checks are not contamination → passes (ES-491 F1)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Test\n5 passed" },
    ];
    // The verifier's build/test left untracked artifacts (coverage, junit). These do not change
    // the tree being judged and are cleaned by git clean — they must NOT taint the evidence.
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "status", "--porcelain"], { code: 0, stdout: "?? coverage/lcov.info\n?? junit.xml\n" });
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    // Untracked artifacts did not taint evidence: VERIFY judged and passed, session merged.
    expect(sessions[0].state).toBe("merged");
    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].verdict).toBe("pass");
    expect(verifyLogs[0].errorDetail ?? "").not.toContain("tainted");
  });

  it("verify-fix retry that rewrites history (fewer commits, changed tree) is not a no-op (ES-491 F3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    // 1st judgment fail → re-implement; 2nd judgment pass.
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["criterion not met"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 1.0, summary: "fixed — squashed into one commit" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Test\n1 failure" },
      { kind: "completed", costUsd: 0.4, summary: "## Test\nall pass" },
    ];
    // The verify-fix retry rewrites history into FEWER commits but a DIFFERENT tree. The
    // no-change guard must compare the tree hash (changed → real fix), not the commit count.
    let treeCalls = 0;
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD^{tree}"], () => {
      treeCalls += 1;
      return { code: 0, stdout: treeCalls === 1 ? "tree-before-fix\n" : "tree-after-fix\n" };
    });
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    // The retry was recognized as a real change → VERIFY re-ran and passed → merged.
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].stopDetail ?? "").not.toContain("made no changes");
    expect(sessions[0].verifyAttempts).toBe(2);
  });

  it("verify-fix retry with identical tree is flagged as no-op (ES-491 F3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["criterion not met"]}\n```' },
    ];
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 1.0, summary: "claims a fix but changed nothing" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Test\n1 failure" },
    ];
    // The retry left the tree identical to before → genuine no-op → must stop.
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD^{tree}"], { code: 0, stdout: "tree-unchanged\n" });
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].stopDetail ?? "").toContain("verify-fix retry made no changes");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(false);
  });

  it("verify-fix IMPLEMENT cost_exceeded → preserves worktree (prior commits not discarded)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const selfReviewAgent = new FakeAgentRunner(); // separate so h.agent only counts IMPLEMENT calls
    const verifyAgent = new FakeAgentRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent, verifyAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "desc" })];
    // Iteration 1: IMPLEMENT succeeds; VERIFY fails (planner returns fail verdict).
    // Iteration 2: IMPLEMENT (fix) hits cost_exceeded.
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "cost_exceeded", costUsd: 0.5 },
    ];
    // selfReviewAgent: no outcomes → throws on each call → non-fatal, CONTINUE
    // verifyAgent: evidence collection succeeds on iteration 1
    verifyAgent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "evidence gathered" }];
    // planner: fail verdict on first judgment → reasons injected into 2nd IMPLEMENT
    planner.outcomes = [{ kind: "completed", text: '{"verdict":"fail","reasons":["criterion not met"]}' }];

    await h.orch.run();

    // Session stopped due to cost_exceeded.
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0]!.state).toBe("stopped");
    expect(sessions[0]!.failureReason).toBe("cost_exceeded");
    // discardWorktree must NOT have been called: the verify-fix retry preserves prior commits.
    expect(h.git.calls.filter(c => c.method === "discardWorktree")).toHaveLength(0);
  });

  it("verify judge error during interrupt → logs error/interrupted, not passed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const selfReviewAgent = new FakeAgentRunner(); // separate so selfReview doesn't drain h.agent
    const verifyAgent = new FakeAgentRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent, verifyAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "desc" })];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // selfReviewAgent: no outcomes → throws → non-fatal, CONTINUE
    // verifyAgent: evidence collection succeeds
    verifyAgent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "evidence gathered" }];
    // Override planner.run: set interrupted=true and return a judge error, simulating an
    // interrupt that raced with the Codex child process surfacing as kind:"error".
    planner.run = async (_ctx) => {
      (h.orch as any).interrupted = true;
      return { kind: "error", message: "judge process killed" };
    };

    await h.orch.run();

    // The run must be halted (haltForInterrupt was called).
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // The verify log must record error/interrupted, NOT a fail-open pass.
    const sessions = h.store.sessionsForRun(run.id);
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0]!.id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0]!.outcome).toBe("error");
    expect(vrLogs[0]!.errorDetail).toBe("interrupted");
  });

  it("verify judge exception (throw) during interrupt → logs error/interrupted, not passed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const selfReviewAgent = new FakeAgentRunner();
    const verifyAgent = new FakeAgentRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent, verifyAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "desc" })];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "implemented" }];
    // selfReviewAgent: no outcomes → throws → non-fatal, CONTINUE
    // verifyAgent: evidence collection succeeds
    verifyAgent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "evidence gathered" }];
    // Override planner.run: set interrupted=true then throw, simulating a SIGINT that caused
    // the Codex child process to raise an exception rather than returning kind:"interrupted".
    planner.run = async (_ctx) => {
      (h.orch as any).interrupted = true;
      throw new Error("judge process killed by SIGINT");
    };

    await h.orch.run();

    // The run must be halted (haltForInterrupt was called).
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // The verify log must record error/interrupted, NOT a fail-open pass.
    const sessions = h.store.sessionsForRun(run.id);
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0]!.id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0]!.outcome).toBe("error");
    expect(vrLogs[0]!.errorDetail).toBe("interrupted");
    // verifyAttempts must not be incremented (no verdict was produced).
    expect(sessions[0]!.verifyAttempts).toBe(0);
  });

  it("verify.enabled = false → skips verify, no verify_log entries", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: false, runRecipe: "" };
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[0].verifyAttempts).toBe(0);

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(0);
  });

  it("verify evidence agent interrupted → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [{ kind: "interrupted", costUsd: 0.1 }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");

    const sessions = h.store.sessionsForRun(run.id);
    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("error");
    expect(verifyLogs[0].errorDetail).toBe("interrupted");
  });

  it("verify evidence agent exception during interrupt → HALT, does not consume retry slot", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { selfReviewAgent });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.5, summary: "implemented" }];
    // selfReviewAgent: no outcomes → throws → non-fatal, CONTINUE
    // verifyAgent: no outcomes queued → throws exception while interrupted
    let verifyCallCount = 0;
    h.verifyAgent.runSession = async (_ctx) => {
      verifyCallCount++;
      (h.orch as any).interrupted = true;
      throw new Error("evidence agent killed by SIGINT");
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    const sessions = h.store.sessionsForRun(run.id);
    // Verify log must record error/interrupted, not a fail-open pass.
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0]!.id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0]!.outcome).toBe("error");
    expect(vrLogs[0]!.errorDetail).toBe("interrupted");
    // verifyAttempts must not be incremented (no verdict was produced).
    expect(sessions[0]!.verifyAttempts).toBe(0);
    expect(verifyCallCount).toBe(1);
  });

  it("verify judge interrupted → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "interrupted" }];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Test\n5 passed" },
    ];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");

    const sessions = h.store.sessionsForRun(run.id);
    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("error");
    expect(verifyLogs[0].errorDetail).toBe("interrupted");
  });

  it("verify evidence agent cost_exceeded → fail-open pass", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [{ kind: "cost_exceeded", costUsd: 2.0 }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    const verifyLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].outcome).toBe("passed");
    expect(verifyLogs[0].errorDetail).toContain("fail-open");
  });

  // Finding 1 (ES-491): Recovery must honor the attempt cap — crash between verifyAttempts
  // DB write and stopSession("verify_failed") must not grant a free IMPLEMENT→VERIFY cycle.
  it("recovery: verifyAttempts at cap + failed log → verify_failed, no extra cycle", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);

    // Seed a crashed session: implementing state, 2 verify attempts already used (= cap).
    const oldRun = h.store.createRun(3, "2026-06-04T00:00:00.000Z");
    const s = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-VF",
      issueTitle: "Crashed at cap",
      branch: "looppilot/ty-vf-x",
      worktreePath: "/wt/ty-vf",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(s.id, {
      state: "implementing",
      verifyAttempts: 2,
      // planBrief with acceptance so the recovery code (if it reaches that point) wouldn't
      // fail closed on missing criteria. With our fix it never should reach that point.
      planBrief: "## Acceptance Criteria\n- it works",
    });
    // Self-review gate satisfied
    const srLog = h.store.insertSelfReviewLog({ runId: oldRun.id, sessionId: s.id, startedAt: "2026-06-04T00:01:00.000Z" });
    h.store.updateSelfReviewLog(srLog.id, { endedAt: "2026-06-04T00:02:00.000Z", outcome: "passed" });
    // Verify log with failed outcome (crash window: after verifyAttempts was written, before stopSession)
    const vrLog = h.store.insertVerifyLog({ runId: oldRun.id, sessionId: s.id, attempt: 2, startedAt: "2026-06-04T00:03:00.000Z" });
    h.store.updateVerifyLog(vrLog.id, { endedAt: "2026-06-04T00:04:00.000Z", outcome: "failed" });
    // Worktree has commits (so recovery enters the "implementing + clean commits" path)
    h.git.commitsWithDiff.set("/wt/ty-vf", true);
    // Stop the loop after recovery so we don't need a second issue
    h.source.getAllEligible = async (_excludeIds) => { h.orch.requestStop(); return []; };

    await h.orch.run();

    // The session must be abandoned with verify_failed — NOT given another IMPLEMENT cycle.
    const recovered = h.store.getSession(s.id);
    expect(recovered.state).toBe("stopped");
    expect(recovered.failureReason).toBe("verify_failed");
    // No additional IMPLEMENT or VERIFY calls should have occurred.
    expect(h.agent.callCount).toBe(0);
    expect(h.verifyAgent.callCount).toBe(0);
  });

  // Finding 2 (ES-491): Retry implementation receives remaining session budget, not the full cap.
  it("verify fail → retry implement receives remaining budget (not full cap)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, maxCostUsdPerSession: 10 });
    const planner = new FakePlanRunner();
    // 1st judgment: fail → triggers re-implement; 2nd judgment: pass
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["tests fail"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // 1st IMPLEMENT ($1.5) + self-review (error=skip) + 2nd IMPLEMENT ($1.0) + self-review (error=skip)
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      { kind: "completed", costUsd: 1.0, summary: "fixed" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // 1st evidence ($0.4 — fails) + 2nd evidence ($0.4 — passes)
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "2 test failures" },
      { kind: "completed", costUsd: 0.4, summary: "all pass" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // First IMPLEMENT: prior cost = 0, so budget = 10 - 0 = 10
    // Second IMPLEMENT: prior cost = 1.5 (IMPL1) + 0.4 (VERIFY evidence) = 1.9, so budget = 10 - 1.9 = 8.1
    const implContexts = h.agent.contexts.filter(c => !c.prompt.includes("self-review"));
    expect(implContexts).toHaveLength(2);
    expect(implContexts[0]!.maxCostUsd).toBeCloseTo(10, 5);
    expect(implContexts[1]!.maxCostUsd).toBeCloseTo(8.1, 5);
  });

  // Finding 3 (ES-491): Evidence agent error during interrupt must not write a fail-open pass.
  it("verify evidence agent error during interrupt → logs error/interrupted, not passed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const verifyAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, verifyAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "desc" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // Override verifyAgent.runSession to set interrupted=true and return kind:"error",
    // simulating an interrupt that raced with the evidence child process.
    verifyAgent.runSession = async (_ctx) => {
      (h.orch as any).interrupted = true;
      return { kind: "error" as const, costUsd: 0.05, message: "evidence process killed" };
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    const sessions = h.store.sessionsForRun(run.id);
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0]!.id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0]!.outcome).toBe("error");
    expect(vrLogs[0]!.errorDetail).toBe("interrupted");
  });

  // Codex Finding 2 (ES-491): cost_exceeded during an interrupt must not write a fail-open pass.
  it("verify evidence agent cost_exceeded during interrupt → logs error/interrupted, not passed", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const verifyAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, verifyAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "desc" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // Simulate a stop request that races with the evidence agent and causes it to
    // return cost_exceeded (budget hit after SIGTERM) instead of kind:"interrupted".
    verifyAgent.runSession = async (_ctx) => {
      (h.orch as any).interrupted = true;
      return { kind: "cost_exceeded" as const, costUsd: 2.0 };
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    const sessions = h.store.sessionsForRun(run.id);
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0]!.id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0]!.outcome).toBe("error");
    expect(vrLogs[0]!.errorDetail).toBe("interrupted");
  });

  // Finding 4 (ES-491): Ticket description is used as fallback acceptance context when planBrief is null.
  it("verify with null planBrief uses issue description as acceptance fallback", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    // No designer → planBrief is null; planner is only used for judgment
    const h = makeHarness(config, { planner, designReviewer: planner });
    const desc = "## Acceptance Criteria\n- the feature works end-to-end";
    h.source.queue = [issue("issue-A", "TY-1", { description: desc })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The judgment prompt sent to the planner must include the issue description as acceptance.
    // planner.calls includes SELECT (2 eligible would trigger it) but here only 1 issue so
    // planner is only called for VERIFY judgment.
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]!.prompt).toContain(desc);

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
  });

  // Codex Finding 4 (ES-491): Empty brief acceptance section falls back to issue description.
  it("verify with empty brief acceptance section uses issue description as fallback", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const designer = new FakePlanRunner();
    // Designer returns a brief whose Acceptance Criteria section is empty (parseable but blank).
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nDo the thing.\n\n## Change Targets\n- src/foo.ts\n\n## Implementation Steps\n1. Add it\n\n## Acceptance Criteria\n\n## Out of Scope\n- nothing" },
    ];
    const h = makeHarness(config, { planner, designer, designReviewer: planner });
    const desc = "The feature must pass the end-to-end acceptance test";
    h.source.queue = [issue("issue-A", "TY-1", { description: desc })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // The judgment prompt must fall back to the issue description because the brief
    // acceptance section is empty.
    const judgmentCall = planner.calls.find((c) => c.prompt.includes("Code Diff") || c.prompt.includes("Verification Evidence"));
    expect(judgmentCall).toBeDefined();
    expect(judgmentCall!.prompt).toContain(desc);

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
  });

  // Codex VERIFY Finding 1: resume_verify must self-review fix commits before VERIFY.
  it("crash recovery: resume_verify runs self-review on landed fix commits before VERIFY", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing", verifyAttempts: 1 });
    h.store.updateSession(session.id, { planBrief: "## Acceptance Criteria\nThe feature works." });
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Prior VERIFY failed; fix commit already landed (HEAD differs from verifiedHeadSha).
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, {
      endedAt: "2026-06-05T00:02:00.000Z", outcome: "failed",
      verdict: "fail", reasonCount: 1, verifiedHeadSha: "oldsha000-pre-fix",
    });
    // selfReviewAgent returns a pass (non-fatal error would also work).
    selfReviewAgent.outcomes = [
      { kind: "completed", costUsd: 0.1, summary: '{"issues":[],"verdict":"pass"}' },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Self-review must have been called for the landed fix commits.
    expect(selfReviewAgent.callCount).toBe(1);
    // Recovery resumed VERIFY (not IMPLEMENT) because fix commits were already landed.
    expect(h.logs.some(l => l.includes("verify-fix commit already landed") && l.includes("resuming VERIFY"))).toBe(true);
    expect(h.agent.callCount).toBe(0);
  });

  // Codex VERIFY Finding 2: Interrupted verify log → resume VERIFY, not permanent stop.
  it("crash recovery: interrupted verify log → resumes VERIFY instead of stopping", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    const priorRun = h.store.createRun(1, "2026-06-05T00:00:00.000Z");
    h.store.setRunState(priorRun.id, "halted", "daemon crashed");
    const session = h.store.createSession({
      runId: priorRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Title for TY-1",
      issueUrl: "https://linear.app/issue/TY-1",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-05T00:00:00.000Z",
    });
    h.store.updateSession(session.id, { state: "implementing" });
    h.store.updateSession(session.id, { planBrief: "## Acceptance Criteria\nThe feature works." });
    h.store.insertSelfReviewLog({ runId: priorRun.id, sessionId: session.id, startedAt: "2026-06-05T00:00:00.000Z" });
    const srLogs = h.store.getSelfReviewLogsForSession(session.id);
    h.store.updateSelfReviewLog(srLogs[0].id, { endedAt: "2026-06-05T00:01:00.000Z", outcome: "passed" });
    // Verify log recorded as error with "interrupted" — graceful SIGINT during VERIFY.
    h.store.insertVerifyLog({ runId: priorRun.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-05T00:01:00.000Z" });
    const vrLogs = h.store.getVerifyLogsForSession(session.id);
    h.store.updateVerifyLog(vrLogs[0].id, {
      endedAt: "2026-06-05T00:02:00.000Z", outcome: "error",
      errorDetail: "interrupted",
    });
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Recovery must resume VERIFY, not stop with "verifier pollution".
    expect(h.logs.some(l => l.includes("verify interrupted (graceful)") && l.includes("resuming VERIFY"))).toBe(true);
    expect(h.logs.some(l => l.includes("verifier pollution"))).toBe(false);
    // VERIFY re-ran (verifyAgent had no outcomes → threw → fail-open pass) → HANDOFF.
    const allVrLogs = h.store.getVerifyLogsForSession(session.id);
    expect(allVrLogs.length).toBeGreaterThanOrEqual(2);
    expect(allVrLogs[allVrLogs.length - 1]!.outcome).toBe("passed");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(true);
  });

  // Codex VERIFY Finding 3: verify-fix retry that removes all implementation changes → stops.
  it("verify-fix retry that removes all implementation changes is rejected", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["criterion not met"]}\n```' },
    ];
    const selfReviewAgent = new FakeAgentRunner();
    const h = makeHarness(config, { planner, designReviewer: planner, selfReviewAgent });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "completed", costUsd: 1.0, summary: "fixed by removing everything" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Test\n1 failure" },
    ];
    // Tree hash changes (retry DID modify code), but the diff vs base is empty.
    let treeCalls = 0;
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD^{tree}"], () => {
      treeCalls += 1;
      return { code: 0, stdout: treeCalls === 1 ? "tree-before-fix\n" : "tree-after-fix-empty\n" };
    });
    // hasCommitsWithDiff must return true for the first IMPLEMENT (so it passes the initial
    // no-change guard) but false for the verify-fix retry (branch has no diff against base).
    let diffCalls = 0;
    const origHasCommitsWithDiff = h.git.hasCommitsWithDiff.bind(h.git);
    h.git.hasCommitsWithDiff = async (worktreePath: string) => {
      diffCalls += 1;
      if (diffCalls === 1) return origHasCommitsWithDiff(worktreePath);
      return false;
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].stopDetail ?? "").toContain("verify-fix retry removed all implementation changes");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(false);
  });

  // Codex VERIFY Finding 4: Judge that modifies worktree → verdict rejected.
  it("verify judge that modifies HEAD → verdict is tainted and rejected", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Test\n5 passed" },
    ];
    // After evidence collection, the first HEAD check returns the same SHA (no evidence
    // contamination). After judgment, the HEAD check returns a different SHA (judge committed).
    // Call sequence for rev-parse HEAD (excluding --abbrev-ref):
    //   1: self-review pre-review SHA capture
    //   2: verify preVerifySha capture
    //   3: evidence contamination HEAD check → must match preVerifySha
    //   4: judge contamination HEAD check → different SHA (judge committed)
    let headCallsInWorktree = 0;
    h.memoryRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("HEAD") && !args.includes("--abbrev-ref") && !args.includes("HEAD^{tree}")) {
        headCallsInWorktree += 1;
        if (headCallsInWorktree <= 3) return { code: 0, stdout: "abc1234\n" };
        return { code: 0, stdout: "judge-modified-sha\n" };
      }
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        const cIdx = args.indexOf("-C");
        const wtPath = cIdx >= 0 && cIdx + 1 < args.length ? args[cIdx + 1] : "";
        const slug = wtPath.replace(/^\/wt\//, "");
        return { code: 0, stdout: `looppilot/${slug}-x\n` };
      }
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("stopped");
    expect(sessions[0].stopDetail ?? "").toContain("judge modified worktree");
    const vrLogs = h.store.getVerifyLogsForSession(sessions[0].id);
    expect(vrLogs).toHaveLength(1);
    expect(vrLogs[0].outcome).toBe("error");
    expect(vrLogs[0].errorDetail).toContain("judge contaminated");
    expect(h.git.calls.some(c => c.method === "pushAndOpenPr")).toBe(false);
  });

  // ---- ES-494: VERIFY run_recipe (C3) / C1 degradation / process cleanup ----

  it("verify: kills orphaned processes found by lsof in worktree", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      // Treat lsof PIDs as verified descendants so the descendant filter passes them through
      getDescendantPids: () => new Set([12345, 67890]),
      checkPidAlive: () => false, // processes exit immediately after SIGTERM
    });
    // Override lsof stub to return PIDs
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: "12345\n67890\n" });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(killCalls[0].args).toContain("12345");
    expect(killCalls[0].args).toContain("67890");
  });

  it("verify: process cleanup filters out PID 0, PID 1, self-PID, and non-numeric values", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const safePid = String(process.pid + 1000);
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      // safePid is the only descendant so the descendant filter passes it through;
      // the other entries (0, 1, self-PID, non-numeric) are caught by the basic filter.
      getDescendantPids: () => new Set([parseInt(safePid, 10)]),
      checkPidAlive: () => false,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `0\n1\n${process.pid}\nerror-msg\n${safePid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(killCalls[0].args).toEqual(["-TERM", safePid]);
  });

  it("verify: process cleanup is best-effort — lsof failure does not halt verify", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const lsofRunner = new FakeCommandRunner();
    lsofRunner.on(["git", "-C"], (args, _opts) => {
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        const cIdx = args.indexOf("-C");
        const wtPath = cIdx >= 0 && cIdx + 1 < args.length ? args[cIdx + 1] : "";
        const slug = wtPath.replace(/^\/wt\//, "");
        return { code: 0, stdout: `looppilot/${slug}-x\n` };
      }
      if (args.includes("rev-parse") && args.includes("HEAD")) {
        return { code: 0, stdout: "abc1234\n" };
      }
      return { code: 0, stdout: "" };
    });
    lsofRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    lsofRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    lsofRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    lsofRunner.on(["git", "add", "-f", "--"], { code: 0 });
    lsofRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
    lsofRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
    lsofRunner.on(["git", "clean", "-fdx", "--", "docs/memory/"], { code: 0 });
    lsofRunner.on(["git", "checkout", "HEAD", "--", "."], { code: 0 });
    lsofRunner.on(["git", "clean", "-fd"], { code: 0 });
    lsofRunner.on(["git", "clean", "-fdx"], { code: 0 });
    lsofRunner.on(["git", "checkout"], { code: 0 });
    lsofRunner.on(["git", "rev-parse", "HEAD"], { code: 0, stdout: "abc1234\n" });
    lsofRunner.on(["git", "reset", "--hard"], { code: 0 });
    lsofRunner.on(["git", "reset", "HEAD", "--", "docs/memory/"], { code: 0 });
    // lsof throws to simulate command not found / failure
    lsofRunner.on(["lsof", "+D"], (_args, _opts) => {
      throw new Error("lsof: command not found");
    });
    lsofRunner.on(["kill", "-TERM"], { code: 0 });

    // Build harness with custom runner that makes lsof throw
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const agent = new FakeAgentRunner();
    const git = new FakeGitPr();
    const monitor = new FakeMonitor();
    const notifier = new FakeNotifier();
    const verifyAgent = new FakeAgentRunner();
    source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const orch = new Orchestrator({
      mergeGateJudge: null,
      config,
      source,
      agent,
      selfReviewAgent: agent,
      verifyAgent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt: () => "PROMPT",
      specLoader: null,
      clock: fixedClock("2026-06-05T00:00:00.000Z"),
      sleep: instantSleep(),
      log: () => {},
      recovery: new FakeWorkflowRecovery(),
      planner,
      designer: null,
      designReviewer: planner,
      codebaseSummaryGenerator: async () => "summary",
      recoveryTurn: null,
      runner: lsofRunner,
      groomDeps: null,
    });

    await orch.run();

    const sessions = store.sessionsForRun(store.latestRun()!.id);
    // Verify still completes despite lsof failure
    expect(sessions[0].state).toBe("merged");
  });

  it("verify: process cleanup does not kill non-descendant PIDs (Finding 2)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const descendantPid = "11111";
    const nonDescendantPid = "22222";
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      // Only descendantPid is in the tree; nonDescendantPid must not be signalled.
      getDescendantPids: () => new Set([11111]),
      checkPidAlive: () => false,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `${descendantPid}\n${nonDescendantPid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(killCalls[0].args).toContain(descendantPid);
    expect(killCalls[0].args).not.toContain(nonDescendantPid);
  });

  it("verify: process cleanup kills reparented (orphaned) background servers not in descendant tree", async () => {
    // Background servers started by run_recipe get reparented to init (PID 1)
    // when the verifier agent process exits before cleanup. The descendant filter
    // alone would drop these — the reparented filter must include them.
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const reparentedPid = "33333"; // background dev server, reparented to init
    const unrelatedPid = "44444";  // unrelated editor — not a descendant, not reparented
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      // No descendants — the spawning process exited before cleanup ran
      getDescendantPids: () => new Set<number>(),
      // Only reparentedPid has PPID=1; unrelatedPid has a living parent
      getReparentedPids: (pids) => new Set(pids.filter(p => p === 33333)),
      checkPidAlive: () => false,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `${reparentedPid}\n${unrelatedPid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    // Reparented server must be killed
    expect(killCalls[0].args).toContain(reparentedPid);
    // Unrelated editor (not reparented, not descendant) must be spared
    expect(killCalls[0].args).not.toContain(unrelatedPid);
  });

  it("verify: process cleanup kills children of reparented wrapper processes (ES-494 Finding 1)", async () => {
    // Scenario: run_recipe starts 'npm run dev &'. The npm wrapper (wrapperPid) gets
    // reparented to init (PPID=1) when the shell exits. The actual dev server (serverPid)
    // is a child of npm — lsof finds it, but it is neither a direct orchestrator
    // descendant nor PPID=1 itself, so the old filter would drop it. Fix: also include
    // descendants of reparented wrappers.
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const wrapperPid = 77777; // npm wrapper, reparented to init
    const serverPid  = "88888"; // actual dev server, child of npm wrapper
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      // Orchestrator has no direct descendants; wrapperPid is reparented;
      // serverPid is a descendant of wrapperPid.
      getDescendantPids: (rootPid) =>
        rootPid === wrapperPid ? new Set([88888]) : new Set<number>(),
      getReparentedPids: (pids) => new Set(pids.filter(p => p === wrapperPid)),
      checkPidAlive: () => false,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `${wrapperPid}\n${serverPid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    // Both the reparented wrapper and its child (the actual dev server) must be killed.
    expect(killCalls[0].args).toContain(String(wrapperPid));
    expect(killCalls[0].args).toContain(serverPid);
    // Session completes successfully
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
  });

  it("verify: process cleanup falls back to lsof hits when ancestry unavailable (non-Linux, ES-494 Finding 2)", async () => {
    // On macOS (and any env without /proc), getDescendantPids returns null.
    // Previously the cleanup was a no-op in this case. Now it must still kill
    // the basic-filtered lsof hits so orphaned servers are cleaned up.
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const orphanedPid = "99999";
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      getDescendantPids: () => null, // simulate non-Linux / /proc unavailable
      checkPidAlive: () => false,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `${orphanedPid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const killCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-TERM"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    // The lsof-found orphaned process must be killed even without ancestry info
    expect(killCalls[0].args).toContain(orphanedPid);
    // Session completes — cleanup is best-effort, non-fatal
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
  });

  it("verify: process cleanup escalates to SIGKILL when SIGTERM-ed process lingers (Finding 3)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const stubbornPid = "55555";
    const h = makeHarness(config, {
      planner,
      designReviewer: planner,
      getDescendantPids: () => new Set([55555]),
      // Simulate a process that never exits voluntarily after SIGTERM.
      checkPidAlive: (pid) => pid === 55555,
    });
    h.memoryRunner.on(["lsof", "+D"], { code: 0, stdout: `${stubbornPid}\n` });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sigkillCalls = h.memoryRunner.calls.filter(
      c => c.cmd === "kill" && c.args.includes("-KILL"),
    );
    expect(sigkillCalls.length).toBeGreaterThanOrEqual(1);
    expect(sigkillCalls[0].args).toContain(stubbornPid);

    // Verify completes successfully despite the escalation
    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].state).toBe("merged");
  });

  it("verify: runRecipe set → evidence prompt includes acceptance check command", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    expect(h.verifyAgent.contexts).toHaveLength(1);
    expect(h.verifyAgent.contexts[0].prompt).toContain("npm run e2e");
    expect(h.verifyAgent.contexts[0].prompt).toContain("Acceptance check");
  });

  it("verify: runRecipe empty → evidence prompt omits acceptance check (C1 degradation)", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    expect(h.verifyAgent.contexts).toHaveLength(1);
    expect(h.verifyAgent.contexts[0].prompt).not.toContain("Acceptance check");
    expect(h.verifyAgent.contexts[0].prompt).not.toContain("## Acceptance Check");
  });

  it("verify: runRecipe set → judgment includes acceptance check in oracle list", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: true, runRecipe: "npm run e2e" };
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    const h = makeHarness(config, { planner, designReviewer: planner });
    h.source.queue = [issue("issue-A", "TY-1", { description: "## Acceptance Criteria\n- it works" })];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "## Build\nOK\n## Acceptance Check\nAll passed" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    expect(planner.contexts).toHaveLength(1);
    expect(planner.contexts[0].prompt).toContain("acceptance check");
  });
});

describe("ES-504 abandon transient retry — executeAbandon", () => {
  it("PR close transient → リトライ → abandon 完遂 → CONTINUE", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // PR close: 1st call → transient (ECONNRESET), 2nd call → success
    let prCloseCalls = 0;
    h.recoveryRunner.on(["gh", "pr", "close"], () => {
      prCloseCalls++;
      if (prCloseCalls === 1) return { code: 1, stderr: "ECONNRESET" };
      return { code: 0 };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    // Run halts because maxTasksPerRun=1 is reached (the abandoned session still counts as
    // a started task), not because abandon failed — same pattern as the existing
    // "transition(done) failed" test (line ~2100): halted-by-cap is a normal outcome here.
    const run = h.store.latestRun()!;
    expect(run.haltReason).toContain("task cap reached");
    // PR close was called twice (1st transient + 2nd success)
    expect(prCloseCalls).toBe(2);
    // Retry was logged
    expect(h.logs.some((l) => l.includes("transient retry") && l.includes("PR close"))).toBe(true);
  });

  it("branch delete transient → リトライ → abandon 完遂", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // Branch delete: 1st call → transient, 2nd → success
    let branchDeleteCalls = 0;
    h.recoveryRunner.on(["git", "push", "origin", "--delete"], () => {
      branchDeleteCalls++;
      if (branchDeleteCalls === 1) return { code: 1, stderr: "Connection reset by peer" };
      return { code: 0 };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    // Run halts because maxTasksPerRun=1 is reached, not because abandon failed.
    const run = h.store.latestRun()!;
    expect(run.haltReason).toContain("task cap reached");
    expect(branchDeleteCalls).toBe(2);
  });

  it("ticket revert transient → リトライ → abandon 完遂", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // Ticket revert (transition to todo): 1st call → transient, 2nd → success
    let todoTransitionCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoTransitionCalls++;
        if (todoTransitionCalls === 1) throw new Error("ECONNRESET");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    // Run halts because maxTasksPerRun=1 is reached, not because abandon failed.
    const run = h.store.latestRun()!;
    expect(run.haltReason).toContain("task cap reached");
    // transition(todo) called twice: 1st ECONNRESET + 2nd success
    expect(todoTransitionCalls).toBe(2);
  });

  it("PR close deterministic エラー → リトライなし → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // PR close: deterministic error (not transient)
    let prCloseCalls = 0;
    h.recoveryRunner.on(["gh", "pr", "close"], () => {
      prCloseCalls++;
      return { code: 1, stderr: "HTTP 404 Not Found" };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    // Deterministic → no retry
    expect(prCloseCalls).toBe(1);
    // Run halted because abandon failed
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
  });
});

describe("ES-504 abandon transient retry — pre-PR abandon", () => {
  it("todo revert transient → リトライ → 成功 → CONTINUE", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];
    // todo revert: 1st call → transient, 2nd → success
    let todoRevertCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoRevertCalls++;
        if (todoRevertCalls === 1) throw new Error("ECONNRESET");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    // Retry succeeded silently — no "todo revert failed" text leaked into stopDetail.
    expect(sA.stopDetail).toBeNull();
    // Run continued past TY-1's abandon to TY-2, which completed normally (not an
    // immediate halt via the todoRevertErr branch).
    const sB = sessions.find((s) => s.linearIdentifier === "TY-2");
    expect(sB).toBeDefined();
    expect(sB!.state).toBe("merged");
    // With maxTasksPerRun=2, countTasksStarted (TY-1 abandoned + TY-2 merged = 2) reaches the
    // cap once TY-2 finishes, so the run halts on the *next* loop iteration via the unrelated
    // task_cap check — not because the abandon/retry failed. Same pattern as Task 2's
    // "PR close transient" test above: halted-by-cap is a normal, orthogonal outcome here.
    const run = h.store.latestRun()!;
    expect(run.haltReason).toContain("task cap reached");
    // transition(todo) retried
    expect(todoRevertCalls).toBe(2);
    expect(h.logs.some((l) => l.includes("transient retry") && l.includes("todo revert"))).toBe(true);
  });

  it("todo revert deterministic → リトライなし → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
    ];
    // todo revert: deterministic error
    let todoRevertCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoRevertCalls++;
        throw new Error("HTTP 403 Forbidden");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    // Deterministic → no retry
    expect(todoRevertCalls).toBe(1);
    // Run halted (ticket stuck In Progress)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // TY-2 was not started
    expect(sessions.find((s) => s.linearIdentifier === "TY-2")).toBeUndefined();
  });
});

// ---- v4-B マージゲート（ES-521） ----
function passJson(): string {
  return '```json\n{ "verdict": "pass" }\n```';
}
function failJson(violations: string[]): string {
  return "```json\n" + JSON.stringify({ verdict: "fail", violations }) + "\n```";
}

describe("v4-B マージゲート（ES-521 / spec §1・§3・§5）— 評価・スキップ・フェイルセーフ・park", () => {
  function gateHarness(over: Parameters<typeof makeConfig>[0] = {}) {
    const config = makeConfig({ maxTasksPerRun: 1, ...over });
    const judge = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    // breaking-signals は cmd.run("git",["diff",...],{cwd}) を -C なしで呼ぶ（best-effort、
    // 未スタブだと errors に落ちるだけだが、判定を安定させるため空 diff を返しておく）
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    return { h, judge, config };
  }

  it("handoffHeadSha == readiness.headSha ならゲートをスキップしてマージ（クリーン PR・judge 不呼び出し・outcome=skipped）", async () => {
    const { h, judge } = gateHarness();
    // handoff 記録は abc1234（memoryRunner）。readiness も abc1234 に合わせる
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "abc1234" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(0);
    const logs = h.store.getMergeGateLogsForSession(s.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe("skipped");
  });

  it("handoffHeadSha が NULL（移行期の旧セッション）ならフェイルオープンでスキップしてマージ", async () => {
    const { h, judge } = gateHarness();
    // rev-parse を失敗させて handoffHeadSha を NULL にする（Task 2 と同じ長プレフィックス上書き。
    // FakeGitPr.prepareWorktree は worktreePath を issue.identifier.toLowerCase() で生成する）。
    // 汎用 ["git","-C"] ハンドラより長いこのプレフィックスは SELF-REVIEW / VERIFY の pre-check
    // rev-parse HEAD にも一致するため、その2回は成功させ、3回目（HANDOFF 本体）だけ失敗させる。
    let revParseHeadCalls = 0;
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "rev-parse", "HEAD"], () => {
      revParseHeadCalls++;
      if (revParseHeadCalls <= 2) return { code: 0, stdout: "abc1234\n" };
      return { code: 128, stderr: "boom" };
    });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(0);
    expect(h.store.getMergeGateLogsForSession(s.id)[0].outcome).toBe("skipped");
  });

  it("merge_gate.enabled=false ならログ行も残さず素通し", async () => {
    const { h, judge, config } = gateHarness();
    config.mergeGate.enabled = false;
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(0);
    expect(h.store.getMergeGateLogsForSession(s.id)).toHaveLength(0);
  });

  it("LoopPilot 中コミットあり + judge pass → verdict/signals を記録してマージ", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(1);
    // ゲートは timeout/effort を config から渡す
    expect(judge.calls[0].timeoutMs).toBe(15 * 60_000);
    const log = h.store.getMergeGateLogsForSession(s.id)[0];
    expect(log.verdict).toBe("pass");
    expect(log.outcome).toBe("passed");
    expect(log.signals).not.toBeNull();
  });

  it("累積 diff が上限を超えるとき head+tail に切り詰めてプロンプトへ注入する（レビュー所見#5）", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];
    const hugeDiff = "x".repeat(250_000);
    // 汎用 ["git","-C"] より長いプレフィックスで diff を巨大化させる
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "diff"], { code: 0, stdout: hugeDiff });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged"); // pass のままマージまで進む
    expect(judge.calls).toHaveLength(1);
    const prompt = judge.calls[0].prompt;
    expect(prompt).toContain("diff truncated");
    expect(prompt.length).toBeLessThan(hugeDiff.length); // 元 diff より十分小さい
    // マーカー挿入後の合計が MERGE_GATE_DIFF_MAX_CHARS（src/orchestrator.ts 内の定数、200_000）を
    // 超えないことを確認する（レビュー所見 G2: tail 長がマーカー長を考慮せず算出されていた regression）。
    const truncatedLine = h.logs.find((l) => l.includes("diff truncated for"));
    expect(truncatedLine).toBeDefined();
    const match = truncatedLine!.match(/-> (\d+) chars\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(200_000);
  });

  it("judge 前に worktree を headSha へ同期し、finally でブランチ復帰する（ES-521 所見#2,14）", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // 判定前に評価対象 head へ detach 同期する
    const detachCall = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args.join(" ") === "-C /wt/ty-1 checkout --detach drift1",
    );
    expect(detachCall).toBeDefined();
    // finally でブランチ（FakeGitPr 実値 looppilot/ty-1-x）へ復帰する
    const branchRestore = h.memoryRunner.calls.find(
      (c) => c.cmd === "git" && c.args.join(" ") === "-C /wt/ty-1 checkout looppilot/ty-1-x",
    );
    expect(branchRestore).toBeDefined();
  });

  it("judge 前の checkout --detach が失敗しても judge は呼ばれ pass でマージされる（フェイルオープン・ES-521 所見#2）", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];
    // 汎用 ["git","-C"] より長いプレフィックスで detach を code 1 に上書き
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "checkout", "--detach", "drift1"], { code: 1, stderr: "boom" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(1);
    expect(h.store.getMergeGateLogsForSession(s.id)[0].outcome).toBe("passed");
  });

  it("ゲートの fetch は一時障害を retryTransient で再試行し、fail-open せず judge まで到達する（ES-521 所見#9）", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];
    // fetch: 1 回目は一時エラー（stderr が transient 判定にマッチ）→ 2 回目成功
    let fetchCalls = 0;
    h.memoryRunner.on(["git", "-C", "/wt/ty-1", "fetch", "origin", "looppilot/ty-1-x"], () => {
      fetchCalls++;
      if (fetchCalls === 1) return { code: 1, stderr: "fatal: unable to access: connection reset by peer" };
      return { code: 0 };
    });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(fetchCalls).toBe(2); // 再試行が行われた
    expect(s.state).toBe("merged");
    expect(judge.calls).toHaveLength(1); // fail-open せず判定に到達
    expect(h.store.getMergeGateLogsForSession(s.id)[0].outcome).toBe("passed");
  });

  it("pass 済み head は mergePr 失敗後の再ポーリングで再判定しない（Codex 二重判定防止・ES-521 所見#11）", async () => {
    const { h, judge } = gateHarness();
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: passJson() }];
    // poll1: done → gate pass → mergePr 1 回目 throw（merge_failed）→ continue
    // poll2: done → gate は同一 head で pass メモ化 → mergePr 2 回目成功 → merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }];
    h.git.failNext("mergePr"); // 1 回目だけ throw

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // judge は 1 回のみ（2 回目のポーリングでは pass メモ化により呼ばれない）
    expect(judge.calls).toHaveLength(1);
    // merge_gate_log 行も 1 行のまま（メモ化ヒットはログを作らない）
    expect(h.store.getMergeGateLogsForSession(s.id)).toHaveLength(1);
    expect(h.store.getMergeGateLogsForSession(s.id)[0].outcome).toBe("passed");
    // mergePr は 2 回呼ばれた（1 回目 throw → 2 回目成功）
    expect(h.git.calls.filter((c) => c.method === "mergePr")).toHaveLength(2);
  });

  it("judge 例外 / error / パース不能 → pass 扱い + outcome=error（フェイルセーフ・マージは通る）", async () => {
    for (const outcome of [
      { kind: "error" as const, message: "codex down" },
      { kind: "completed" as const, text: "こわれた出力" },
    ]) {
      const { h, judge } = gateHarness();
      h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
      judge.outcomes = [outcome];

      await h.orch.run();

      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      expect(s.state).toBe("merged"); // ゲート不調でループを止めない
      expect(h.store.getMergeGateLogsForSession(s.id)[0].outcome).toBe("error");
    }
  });

  it("judge fail + fix 手段なし（recoveryTurn 未配線）→ park: PR保持・needs-human・PRコメント・通知・次タスク継続", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const judge = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge }); // planner 未指定 → recoveryTurn null
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A" },
      // SELF-REVIEW for A (non-fatal error → proceeds to HANDOFF; shared FakeAgentRunner
      // with IMPLEMENT so B's implement outcome is not accidentally consumed here)
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "completed", costUsd: 1, summary: "B" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
    ];
    // FakeMonitor.poll shifts while >1 queued, then keeps returning the last entry once
    // length===1 — so A (parked after 1 poll) and B (must also see "done" to reach
    // runMergeGate) each need a "done" in the shared queue; the trailing "merged" is
    // consumed if B's tryMerge needs another poll (it won't here, but keeps the fake safe).
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [
      { kind: "completed", text: failJson(["public export removed", "test gutted"]) },
      { kind: "completed", text: passJson() }, // 2 タスク目はクリーンに通す
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const a = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    const b = sessions.find((s) => s.linearIdentifier === "TY-2")!;
    // park 終端
    expect(a.state).toBe("stopped");
    expect(a.failureReason).toBe("merge_gate_failed");
    expect(a.stopDetail).toContain("public export removed");
    expect(a.recoveryAttempted).toBe(1);
    // PR は閉じない・ブランチも消さない（GitPrManager に closePr は存在せず discardWorktree も呼ばれない）
    expect(h.git.calls.filter((c) => c.method === "closePr")).toHaveLength(0);
    expect(h.git.calls.filter((c) => c.method === "discardWorktree")).toHaveLength(0);
    // Linear needs-human ラベル + コメント（park 見出し）
    expect(h.source.labelAdds.some((l) => l.issueId === "issue-A" && l.labelName === config.linear.needsHumanLabel)).toBe(true);
    expect(h.source.comments.some((c) => c.issueId === "issue-A" && c.body.includes("merge-gate park"))).toBe(true);
    // PR 理由コメント
    expect(h.git.calls.some((c) => c.method === "postComment" && String(c.args[1]).includes("merge gate parked"))).toBe(true);
    // 通知
    expect(h.notifier.events.some((e) => e.kind === "merge_gate_parked")).toBe(true);
    // ログ行 outcome=parked
    expect(h.store.getMergeGateLogsForSession(a.id).at(-1)!.outcome).toBe("parked");
    // ループは HALT せず次タスクを完走
    expect(b.state).toBe("merged");
  });

  it("HANDOFF 途中クラッシュ回復（recoverByOpenPr 採用）で handoffHeadSha を worktree HEAD からバックフィル（ES-521 所見#1）", async () => {
    // HANDOFF の rev-parse HEAD 記録前にクラッシュしたセッションを模す:
    // state='handing_off'・prNumber あり・handoffHeadSha NULL。2 回目 run の startup recovery で
    // recoverByOpenPr が findOpenPrForBranch ヒット→採用し、その patch で handoffHeadSha を埋める。
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "handoff crash",
      branch: "looppilot/ty-1-x",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:01.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "handing_off",
      prNumber: 100,
      // handoffHeadSha は NULL のまま（クラッシュで未記録）
    });
    // recoverByOpenPr は findOpenPrForBranch で PR を採用する
    h.git.openPrForBranch.set("looppilot/ty-1-x", 100);
    h.source.queue = [];
    // 採用後の monitor: readiness.headSha を backfill 値(abc1234)に合わせてゲートをスキップ→マージ
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "abc1234" });
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    // rev-parse HEAD スタブ値でバックフィルされる（memoryRunner の ["git","-C"] handler → abc1234）
    expect(s.handoffHeadSha).toBe("abc1234");
    expect(s.state).toBe("merged");
    // handoffHeadSha == readiness.headSha なのでゲートはスキップ（judge 不呼び出し）
    expect(judge.calls).toHaveLength(0);
  });

  it("park 済みセッションは再起動時に再採用されない（recoverInReview / stoppedSessions* 経路）", async () => {
    // 上の park テストと同じ手順で TY-1 を park させたあと、同じ store で 2 回目の run を実行。
    // 2 回目: queue は空。park セッションが adopt されないこと =
    // monitor.poll が一度も呼ばれず、セッション state が stopped のまま変わらないことを確認する。
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "A" }];
    h.monitor.verdicts = [{ kind: "done" }];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    judge.outcomes = [{ kind: "completed", text: failJson(["v1"]) }];
    await h.orch.run();
    const parked = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(parked.failureReason).toBe("merge_gate_failed");

    // 2 回目の run: 同一 store を注入した新規 Orchestrator で「daemon 再起動」を模す。
    const h2 = makeHarness(config, { mergeGateJudge: judge, store: h.store });
    h2.source.queue = [];
    await h2.orch.run();

    const after = h.store.getSession(parked.id);
    expect(after.state).toBe("stopped");
    expect(after.failureReason).toBe("merge_gate_failed");
    expect(h2.monitor.pollCalls).toHaveLength(0);
  });
});

describe("v4-B マージゲート fix ループ（ES-521 Task 8）— fix成功→再ゲート・上限park・fix失敗の有界収束・interrupted→HALT・staleガード", () => {
  it("fail → fix_code 固定修正（restart-review なし・ゲート専用コスト上限）→ CI 再待機 → 再ゲート pass → マージ", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    config.safety.maxCostUsdPerMergeGateFix = 7; // 判別用：汎用上限(maxCostUsdPerFix=2)と異なる値
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner(); // recoveryTurn を配線するために必要（makeHarness 仕様。planner.run() 自体は呼ばれない）
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    // IMPLEMENT → SELF-REVIEW (h.agent と同一インスタンス。error は非致命的 fail-open — 既存の
    // 「judge fail + fix 手段なし」テストと同じプレースホルダ) → fix ターンの 3 回分。
    // fix ターンの agent は recoveryTurn.agent === h.agent（makeHarness L218-220）。
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "gate fix" },
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    // fix ターン（recoveryRunner 経由）: status クリーン + push 対象コミットあり。
    // worktree パスは FakeGitPr.prepareWorktree の既定生成（identifier.toLowerCase()）= /wt/ty-1。
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status"], { code: 0, stdout: "" });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "log"], { code: 0, stdout: "fix123 gate fix\n" });
    // readiness: fail 判定(drift1) → fix push 後の stale(drift1) → 新 head(drift2)
    const readiness: MergeReadiness[] = [
      { ready: true, headSha: "drift1" },
      { ready: true, headSha: "drift1" }, // stale — judge を呼ばず continue すべき
      { ready: true, headSha: "drift2" },
    ];
    h.monitor.checkMergeReadiness = async () => readiness.shift() ?? { ready: true, headSha: "drift2" };
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "done" }, { kind: "merged" }];
    judge.outcomes = [
      { kind: "completed", text: failJson(["export X removed"]) },
      { kind: "completed", text: passJson() },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // judge は 2 回だけ（stale readiness では呼ばれない）
    expect(judge.calls).toHaveLength(2);
    // fix ターンは /restart-review を投稿しない（R3）
    expect(h.git.calls.filter((c) => c.method === "postComment")).toHaveLength(0);
    // fix ターンの Claude はゲート専用コスト上限で起動される（FakeAgentRunner.contexts[2] =
    // 3 回目の runSession 呼び出し = IMPLEMENT(0), SELF-REVIEW(1) に続く fix ターン）
    expect(h.agent.contexts[2].maxCostUsd).toBe(7); // ゲート専用予算(7)が使用されたことを確認（汎用maxCostUsdPerFix=2と異なる）
    // fix コストがセッションに加算される
    expect(s.costUsd).toBe(1.5);
    // ログ: fixed → passed
    const logs = h.store.getMergeGateLogsForSession(s.id);
    expect(logs.map((l) => l.outcome)).toEqual(["fixed", "passed"]);
    expect(logs[0].costUsd).toBe(0.5);
  });

  it("fail が max_merge_gate_fix_attempts+1 回目に達したら park（fix は上限回数だけ実行）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    // 既定 maxMergeGateFixAttempts=2 → fail 3 回目で park
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "fix1" },
      { kind: "completed", costUsd: 0.5, summary: "fix2" },
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status"], { code: 0, stdout: "" });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "log"], { code: 0, stdout: "fix123 f\n" });
    const readiness: MergeReadiness[] = [
      { ready: true, headSha: "drift1" }, // fail#1 → fix1
      { ready: true, headSha: "drift2" }, // fail#2 → fix2
      { ready: true, headSha: "drift3" }, // fail#3 → park
    ];
    h.monitor.checkMergeReadiness = async () => readiness.shift() ?? { ready: true, headSha: "drift3" };
    h.monitor.verdicts = [{ kind: "done" }];
    judge.outcomes = [
      { kind: "completed", text: failJson(["v1"]) },
      { kind: "completed", text: failJson(["v2"]) },
      { kind: "completed", text: failJson(["v3"]) },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_gate_failed");
    const logs = h.store.getMergeGateLogsForSession(s.id);
    expect(logs.map((l) => l.outcome)).toEqual(["fixed", "fixed", "parked"]);
    expect(logs.map((l) => l.attempt)).toEqual([1, 2, 3]);
    // 再ゲートは修正込みの累積差分全体を再検査している（= 各回 baseSha は handoff のまま abc1234）
    const diffCalls = h.memoryRunner.calls.filter((c) =>
      c.args.includes("diff") && c.args.some((a) => a.startsWith("abc1234..")));
    expect(diffCalls.map((c) => c.args.at(-1))).toEqual(["abc1234..drift1", "abc1234..drift2", "abc1234..drift3"]);
    expect(h.notifier.events.some((e) => e.kind === "merge_gate_parked")).toBe(true);
  });

  it("fix ターンが失敗しても HALT せず、fail 行の蓄積で park に有界収束する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "error", message: "fix agent down", costUsd: 0 }, // fix#1 失敗
      { kind: "error", message: "fix agent down", costUsd: 0 }, // fix#2 失敗
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status"], { code: 0, stdout: "" });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "log"], { code: 0, stdout: "" });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    h.monitor.verdicts = [{ kind: "done" }];
    judge.outcomes = [
      { kind: "completed", text: failJson(["v1"]) },
      { kind: "completed", text: failJson(["v1"]) },
      { kind: "completed", text: failJson(["v1"]) },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_gate_failed");
    const logs = h.store.getMergeGateLogsForSession(s.id);
    // fail#1(fix失敗=error) → fail#2(fix失敗=error) → fail#3(park)
    expect(logs.map((l) => l.outcome)).toEqual(["error", "error", "parked"]);
  });

  it("violations が 10 件超・長い要素を含むとき fix instruction を件数/長さ cap + 省略付記 + data-only 注記に正規化する（レビュー所見#6）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "completed", costUsd: 0.5, summary: "gate fix" },
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status"], { code: 0, stdout: "" });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "log"], { code: 0, stdout: "fix123 gate fix\n" });
    // readiness: fail 判定(drift1) → fix push 後の stale(drift1) → 新 head(drift2)
    const readiness: MergeReadiness[] = [
      { ready: true, headSha: "drift1" },
      { ready: true, headSha: "drift1" }, // stale — judge を呼ばず continue すべき
      { ready: true, headSha: "drift2" },
    ];
    h.monitor.checkMergeReadiness = async () => readiness.shift() ?? { ready: true, headSha: "drift2" };
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "done" }, { kind: "merged" }];
    // 12 件（うち 5 番目が 600 字）。cap は先頭 10 件のみ・各 500 字まで。
    const shortViolations = Array.from({ length: 11 }, (_, i) => `short-violation-${i + 1}`);
    const longViolation = "L".repeat(600);
    const violations = [...shortViolations.slice(0, 4), longViolation, ...shortViolations.slice(4)];
    judge.outcomes = [
      { kind: "completed", text: failJson(violations) },
      { kind: "completed", text: passJson() },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    // fix ターンのプロンプト = IMPLEMENT(0), SELF-REVIEW(1) に続く 3 回目の runSession 呼び出し
    const prompt = h.agent.contexts[2].prompt;
    for (let i = 1; i <= 9; i++) expect(prompt).toContain(`short-violation-${i}`);
    expect(prompt).not.toContain("short-violation-10");
    expect(prompt).not.toContain("short-violation-11");
    expect(prompt).toContain("…[truncated]");
    expect(prompt).not.toContain(longViolation); // 600 字全体は含まれない
    expect(prompt).toContain("（他 2 件省略）");
    expect(prompt).toContain("untrusted diff content");
    // merge_gate_log にも正規化済み配列が書き込まれる
    const log = h.store.getMergeGateLogsForSession(s.id)[0];
    const storedViolations = JSON.parse(log.violations!);
    expect(storedViolations).toHaveLength(10);
  });

  it("fix ターンが preserveWorktree=true で失敗したとき再ゲートせず即座に park する（ワークツリー保護）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "error", message: "fix agent error", costUsd: 0.1 }, // fix 失敗 → dirty ワークツリー
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    // git status が汚い → executeFixCode が preserveWorktree=true を返す
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status", "--porcelain"], { code: 0, stdout: "M dirty.ts\n" });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    h.monitor.verdicts = [{ kind: "done" }];
    judge.outcomes = [{ kind: "completed", text: failJson(["violation-1"]) }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_gate_failed");
    const logs = h.store.getMergeGateLogsForSession(s.id);
    // preserveWorktree: 再ゲートなし → ログは 1 行のみ（outcome=error）
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe("error");
    expect(h.notifier.events.some((e) => e.kind === "merge_gate_parked")).toBe(true);
  });

  it("fix ターンが interrupted なら HALT する（割り込みの既存契約を維持）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const judge = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { mergeGateJudge: judge, planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "impl" },
      { kind: "error", costUsd: 0, message: "self-review skipped" },
      { kind: "interrupted", costUsd: 0.2 },
    ];
    h.memoryRunner.on(["git", "diff"], { code: 0, stdout: "" });
    h.memoryRunner.on(["git", "cat-file"], { code: 1 });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "status"], { code: 0, stdout: "" });
    h.recoveryRunner.on(["git", "-C", "/wt/ty-1", "log"], { code: 0, stdout: "" });
    h.monitor.checkMergeReadiness = async () => ({ ready: true, headSha: "drift1" });
    h.monitor.verdicts = [{ kind: "done" }];
    judge.outcomes = [{ kind: "completed", text: failJson(["v1"]) }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    const s = h.store.sessionsForRun(run.id)[0];
    expect(s.costUsd).toBe(1.2); // interrupted でも fix コストは加算
  });
});
