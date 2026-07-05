/**
 * v3.5 Integration E2E Tests (ES-495)
 *
 * Combined scenarios that exercise multiple v3.5 features together:
 * VERIFY gate, failure policy routing, needs-human triage, CI log recovery,
 * transient retry (N1), and cross-task continuation.
 */
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
  FakeCommandRunner,
  FakeGroomBoardFetcher,
  FakeGroomLinearClient,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, PlanRunner } from "../src/types.js";

function makeConfig(over: Partial<{
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  maxVerifyAttempts: number;
  maxRecoveryAttempts: number;
  transientRetryAttempts: number;
  groomEnabled: boolean;
}> = {}): Config {
  return {
    product: { goal: "ship the product", specDir: undefined },
    repo: { path: "/repo", remote: "owner/name", defaultBranch: "main", worktreeRoot: "/wt" },
    digest: { recentMergedCount: 5, enabled: true },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: 30,
      monitorTimeoutMinutes: 60,
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
      maxVerifyAttempts: over.maxVerifyAttempts ?? 2,
      maxCostUsdPerVerify: 2,
      verifyTimeoutMinutes: 15,
      maxRecoveryAttempts: over.maxRecoveryAttempts ?? 2,
      transientRetryAttempts: over.transientRetryAttempts ?? 2,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300, idleTimeoutMinutes: 120 },
    looppilot: { gateLabel: "loop-pilot" },
    notify: { progress: false },
    groom: { enabled: over.groomEnabled ?? false },
    selfReview: { enabled: true },
    verify: { enabled: true, runRecipe: "" },
    memory: { maxCharsPerFile: 8000, injectBudgetChars: 6000 },
    linear: { optInLabel: "looppilot-os", needsHumanLabel: "needs-human", team: "ENG", project: "LoopPilot", states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" } },
    pm: undefined,
  } as unknown as Config;
}

function issue(id: string, identifier: string, over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id,
    identifier,
    title: over.title ?? `Title for ${identifier}`,
    description: over.description ?? "## Acceptance Criteria\n- Feature works correctly",
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

function makeHarness(config: Config, opts?: {
  planner?: PlanRunner | null;
  designer?: PlanRunner | null;
  designReviewer?: PlanRunner | null;
  selfReviewAgent?: FakeAgentRunner;
  verifyAgent?: FakeAgentRunner;
}): Harness {
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
  const log = (line: string): void => { logs.push(line); };
  const promptArgs: PromptArgs[] = [];
  const buildPrompt = (args: PromptArgs): string => {
    promptArgs.push(args);
    return `PROMPT for ${args.issue.identifier}`;
  };
  const recovery = new FakeWorkflowRecovery();
  const codebaseSummaryGenerator = async () => "3 files, 100 lines";
  const recoveryRunner = new FakeCommandRunner();
  recoveryRunner.on(["git", "-C"], (_args) => ({ code: 0, stdout: "" }));
  recoveryRunner.on(["git", "push"], { code: 0 });
  recoveryRunner.on(["gh"], { code: 0 });
  const planner = opts?.planner ?? null;
  const designer = opts?.designer ?? null;
  const designReviewer = opts?.designReviewer ?? null;
  const memoryRunner = new FakeCommandRunner();
  memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
  memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
  memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
  memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "clean", "-fd", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "checkout", "HEAD", "--", "."], { code: 0 });
  memoryRunner.on(["git", "clean", "-fd"], { code: 0 });
  memoryRunner.on(["git", "checkout"], { code: 0 });
  memoryRunner.on(["git", "rev-parse", "HEAD"], { code: 0, stdout: "abc1234\n" });
  memoryRunner.on(["git", "reset", "--hard"], { code: 0 });
  memoryRunner.on(["git", "reset", "HEAD", "--", "docs/memory/"], { code: 0 });
  memoryRunner.on(["git", "rev-list", "--count"], { code: 0, stdout: "0\n" });
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
    if (args.includes("diff") && args.includes("--quiet")) {
      return { code: 0, stdout: "" };
    }
    if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: "" };
  });
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
  return { orch, store, source, agent, verifyAgent, git, monitor, notifier, sleepCalls, logs, promptArgs, recoveryRunner, memoryRunner, groomBoardFetcher, groomLinearClient };
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1: Full v3.5 lifecycle — DESIGN → DESIGN REVIEW → IMPLEMENT →
//             SELF-REVIEW → VERIFY(pass) → HANDOFF → MONITOR → DONE
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: full lifecycle with VERIFY pass", () => {
  it("all v3.5 gates fire in sequence and session merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const designer = new FakePlanRunner();
    const designReviewer = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer, designReviewer });

    h.source.queue = [issue("issue-A", "TY-1")];
    // DESIGN
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nBuild feature\n## Change Targets\nsrc/a.ts\n## Implementation Steps\n1. Do it\n## Acceptance Criteria\n- it works\n## Out of Scope\nnothing" },
    ];
    // DESIGN REVIEW → approve
    designReviewer.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    // IMPLEMENT
    h.agent.outcomes = [
      { kind: "completed", costUsd: 2.0, summary: "implemented the feature" },
      // SELF-REVIEW (non-fatal error → proceeds)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // VERIFY evidence (verifyAgent)
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "## Build\nOK\n## Tests\nAll pass", fullResult: "Build: OK\nTests: 15/15 pass\nLint: 0 errors" },
    ];
    // VERIFY judgment (planner/Codex)
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    // MONITOR → merge
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(s.verifyAttempts).toBe(1);
    expect(s.costUsd).toBeCloseTo(2.5);

    // VERIFY log recorded as passed
    const verifyLogs = h.store.getVerifyLogsForSession(s.id);
    expect(verifyLogs).toHaveLength(1);
    expect(verifyLogs[0].verdict).toBe("pass");
    expect(verifyLogs[0].outcome).toBe("passed");

    // Linear transitions: in_progress → in_review → done
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
    ]);

    // No needs-human label on successful sessions
    expect(h.source.labelAdds).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2: VERIFY fail → IMPLEMENT fix → VERIFY pass → merge
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: VERIFY fix loop", () => {
  it("verify fail → re-implement with reasons → verify pass → merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, maxVerifyAttempts: 2 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      // 1st IMPLEMENT
      { kind: "completed", costUsd: 1.5, summary: "first attempt" },
      // 1st SELF-REVIEW (non-fatal)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // 2nd IMPLEMENT (retry after verify fail)
      { kind: "completed", costUsd: 1.0, summary: "fixed per verify feedback" },
      // 2nd SELF-REVIEW (non-fatal)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // VERIFY evidence: 2 attempts
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "Tests fail", fullResult: "Build: OK\nTests: 3 failures" },
      { kind: "completed", costUsd: 0.3, summary: "All good", fullResult: "Build: OK\nTests: 15/15 pass" },
    ];
    // VERIFY judgment: fail then pass
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["3 test failures in auth module","Missing error handling"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.verifyAttempts).toBe(2);

    // Verify reasons were injected into the 2nd IMPLEMENT prompt
    expect(h.agent.contexts.length).toBe(4); // 2×IMPLEMENT + 2×SELF-REVIEW
    const secondImplPrompt = h.agent.contexts[2].prompt;
    expect(secondImplPrompt).toContain("VERIFY Feedback");
    expect(secondImplPrompt).toContain("3 test failures in auth module");

    // 2 verify log entries
    const verifyLogs = h.store.getVerifyLogsForSession(s.id);
    expect(verifyLogs).toHaveLength(2);
    expect(verifyLogs[0].verdict).toBe("fail");
    expect(verifyLogs[1].verdict).toBe("pass");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3: VERIFY × max → abandon(verify_failed) → needs-human →
//             loop continues with next task (SELECT exclusion verified)
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: VERIFY exhaust → abandon → needs-human → next task", () => {
  it("verify_failed triggers abandon, needs-human triage, and loop continues to next task", async () => {
    const config = makeConfig({ maxTasksPerRun: 2, maxVerifyAttempts: 2 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    h.source.queue = [
      issue("issue-A", "TY-1"),
      issue("issue-B", "TY-2"),
    ];
    h.agent.outcomes = [
      // TY-1: 1st IMPLEMENT
      { kind: "completed", costUsd: 1.5, summary: "attempt 1" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // TY-1: 2nd IMPLEMENT (after verify fail #1)
      { kind: "completed", costUsd: 1.0, summary: "attempt 2" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // TY-2: IMPLEMENT
      { kind: "completed", costUsd: 2.0, summary: "TY-2 done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // VERIFY evidence
    h.verifyAgent.outcomes = [
      // TY-1 attempt 1
      { kind: "completed", costUsd: 0.3, summary: "Tests fail" },
      // TY-1 attempt 2
      { kind: "completed", costUsd: 0.3, summary: "Tests still fail" },
      // TY-2 attempt 1
      { kind: "completed", costUsd: 0.3, summary: "All pass" },
    ];
    // Planner is shared by SELECT PM + VERIFY judgment.
    // SELECT for TY-1 fires with 2 eligible → consumes a PM outcome.
    // SELECT for TY-2 fires with 1 eligible → skips PM.
    planner.outcomes = [
      // SELECT PM for TY-1 (eligible=2)
      { kind: "completed", text: '{"identifier":"TY-1","rationale":"higher priority"}' },
      // TY-1 verify #1: fail
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["tests fail"]}\n```' },
      // TY-1 verify #2: fail → verify_failed → abandon
      { kind: "completed", text: '```json\n{"verdict":"fail","reasons":["still failing"]}\n```' },
      // TY-2 verify: pass (no SELECT PM consumed — eligible=1)
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    // TY-2 monitor → merge
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);

    // TY-1: abandoned after verify_failed
    const ty1 = sessions.find(s => s.linearIdentifier === "TY-1")!;
    expect(ty1.state).toBe("stopped");
    expect(ty1.failureReason).toBe("verify_failed");
    expect(ty1.recoveryAction).toBe("abandon");
    expect(ty1.verifyAttempts).toBe(2);

    // TY-2: merged successfully
    const ty2 = sessions.find(s => s.linearIdentifier === "TY-2")!;
    expect(ty2.state).toBe("merged");
    expect(ty2.verifyAttempts).toBe(1);

    // needs-human label was applied to TY-1
    expect(h.source.labelAdds).toContainEqual({
      issueId: "issue-A",
      labelName: "needs-human",
    });
    // Reason comment was posted to TY-1
    expect(h.source.comments.some(
      c => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)") && c.body.includes("verify_failed"),
    )).toBe(true);

    // TY-1 ticket was reverted to Todo (pre-PR abandon)
    expect(h.source.transitions).toContainEqual({
      issueId: "issue-A",
      state: "todo",
    });
    // Worktree was discarded for TY-1
    expect(h.git.calls.some(c => c.method === "discardWorktree")).toBe(true);

    // task_skipped notification for TY-1
    expect(h.notifier.events.some(
      e => e.kind === "task_skipped" && "identifier" in e && e.identifier === "TY-1",
    )).toBe(true);

    // Run is halted (taskCap reached after 2nd task) — not from failure
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 4: CI failed → recovery with CI log injection → fix → merge
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: CI recovery with log injection", () => {
  it("ci_failed → fetchCiLogs → recovery fix_code with injected logs → merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // Recovery fix agent
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    // CI logs available
    h.git.ciLogs = "Error: Cannot find module './missing-dep'\n    at require (node:module:123)\nnpm ERR! Test failed.";

    // Monitor: done → ci_failed → recovery → done → merged
    h.monitor.verdicts = [
      { kind: "done" },  // tryMerge → ci_failed → recovery
      { kind: "done" },  // tryMerge → ready → merge
    ];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_failed" };
      return { ready: true, headSha: `sha-${pr}` };
    };
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
      // Recovery Codex: fix_code with CI log context
      { kind: "completed", text: '{"action":"fix_code","instruction":"Fix the missing dependency"}' },
    ];
    h.recoveryRunner.on(["git", "-C"], (args) => {
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.recoveryAction).toBe("fix_code");
    expect(s.recoveryTurnAttempts).toBe(1);

    // CI logs were fetched
    expect(h.git.calls.some(c => c.method === "fetchCiLogs")).toBe(true);

    // CI log text was injected into the recovery planner prompt
    expect(planner.contexts[1].prompt).toContain("missing-dep");

    // Recovery notifications
    expect(h.notifier.events.some(e => e.kind === "recovery_started")).toBe(true);
    expect(h.notifier.events.some(e => e.kind === "recovery_succeeded")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 5: CI recovery exhaustion → abandon → needs-human → next task
// Pre-seeds a session at recovery counter cap, then verifies abandon + continuation.
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: CI recovery exhaustion → abandon → next task", () => {
  it("counter-exhausted ci_failed → abandon with needs-human → next task with VERIFY merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxRecoveryAttempts: 2 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    // Pre-seed a session that's already in_review with recovery counter at cap.
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
      recoveryTurnAttempts: 2, // at cap → immediate abandon
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.git.ciLogs = "npm ERR! test failed";

    // TY-2 is the next task after TY-1 is abandoned
    h.source.queue = [issue("issue-B", "TY-2")];

    // Recovery poll for TY-1: ci_failed → counter exhausted → abandon
    // TY-2: done → merged
    h.monitor.verdicts = [
      { kind: "done" },     // TY-1: recoverInReview() adopts PR, polls → done
      { kind: "done" },     // TY-1: monitorSession → ci_failed → counter exhausted → abandon
      { kind: "done" },     // TY-2: checkMergeReadiness → ready → mergePr
      { kind: "merged" },
    ];
    let readinessCallForPr = new Map<number, number>();
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      const count = (readinessCallForPr.get(pr) ?? 0) + 1;
      readinessCallForPr.set(pr, count);
      if (pr === 100) return { ready: false, reason: "ci_failed" as const };
      return { ready: true, headSha: `sha-${pr}` };
    };
    // Give TY-2 a distinct PR number (101) so checkMergeReadiness(101) returns
    // ready and mergePr is called, exercising the full done-path for TY-2.
    h.git.pushPrNumber.set("looppilot/ty-2-x", 101);
    h.agent.outcomes = [
      // TY-2: IMPLEMENT + SELF-REVIEW
      { kind: "completed", costUsd: 2.0, summary: "TY-2 done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "All pass" },
    ];
    planner.outcomes = [
      // No recovery (counter exhausted → immediate abandon)
      // TY-2 VERIFY judgment: pass
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];

    await h.orch.run();

    // TY-1: abandoned after counter exhaustion
    const ty1 = h.store.getSession(seeded.id);
    expect(ty1.state).toBe("stopped");
    expect(ty1.failureReason).toBe("ci_failed");
    expect(ty1.recoveryAction).toBe("abandon");

    // TY-2: merged with VERIFY pass via the full done-path (checkMergeReadiness → mergePr)
    const runId = h.store.latestRun()!.id;
    const newSessions = h.store.sessionsForRun(runId).filter(s => s.linearIdentifier === "TY-2");
    expect(newSessions).toHaveLength(1);
    expect(newSessions[0].state).toBe("merged");
    expect(newSessions[0].verifyAttempts).toBe(1);
    // Verify TY-2 exercised checkMergeReadiness and mergePr (done-path, not merged-verdict shortcut)
    expect(h.monitor.readinessCalls).toContain(101);
    expect(h.git.calls.some(c => c.method === "mergePr" && (c.args as number[])[0] === 101)).toBe(true);

    // needs-human label applied to TY-1
    expect(h.source.labelAdds.some(
      l => l.issueId === "issue-A" && l.labelName === "needs-human",
    )).toBe(true);

    // needs-human comment posted to TY-1
    expect(h.source.comments.some(
      c => c.issueId === "issue-A" && c.body.includes("abandon (needs-human)"),
    )).toBe(true);

    // task_skipped notification for TY-1
    expect(h.notifier.events.some(
      e => e.kind === "task_skipped" && "identifier" in e && e.identifier === "TY-1",
    )).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 6: agent_no_change(pre-PR) → abandon → needs-human → next task
//             with full VERIFY gate
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: agent_no_change abandon → next task with VERIFY", () => {
  it("first task abandoned (no changes), next task passes verify and merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    h.source.queue = [
      issue("issue-A", "TY-1"),
      issue("issue-B", "TY-2"),
    ];
    // TY-1: IMPLEMENT produces no diff
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    h.agent.outcomes = [
      // TY-1: IMPLEMENT (no diff → agent_no_change)
      { kind: "completed", costUsd: 1.0, summary: "no changes needed" },
      // TY-2: IMPLEMENT
      { kind: "completed", costUsd: 2.0, summary: "TY-2 done" },
      // TY-2: SELF-REVIEW (non-fatal)
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // TY-2 VERIFY evidence
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.4, summary: "All tests pass" },
    ];
    // Planner: SELECT PM for TY-1 (eligible=2), then VERIFY judgment for TY-2 (eligible=1 → no PM)
    planner.outcomes = [
      // SELECT PM for TY-1 (eligible=2)
      { kind: "completed", text: '{"identifier":"TY-1","rationale":"try it first"}' },
      // TY-2 VERIFY judgment: pass (no SELECT PM — eligible=1)
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    // TY-2 monitor
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);

    // TY-1: abandoned (pre-PR, agent_no_change)
    const ty1 = sessions.find(s => s.linearIdentifier === "TY-1")!;
    expect(ty1.state).toBe("stopped");
    expect(ty1.failureReason).toBe("agent_no_change");
    expect(ty1.recoveryAction).toBe("abandon");
    expect(ty1.prNumber).toBeNull();

    // TY-2: merged with VERIFY pass
    const ty2 = sessions.find(s => s.linearIdentifier === "TY-2")!;
    expect(ty2.state).toBe("merged");
    expect(ty2.verifyAttempts).toBe(1);

    // needs-human on TY-1
    expect(h.source.labelAdds).toContainEqual({
      issueId: "issue-A",
      labelName: "needs-human",
    });

    // TY-1 reverted to Todo
    expect(h.source.transitions).toContainEqual({
      issueId: "issue-A",
      state: "todo",
    });
    // TY-2 went through full lifecycle
    expect(h.source.transitions).toContainEqual({
      issueId: "issue-B",
      state: "done",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 7: Transient retry on CLAIM + VERIFY pass → merge
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: N1 transient retry + VERIFY", () => {
  it("CLAIM transition retries on transient error, then VERIFY passes and session merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, transientRetryAttempts: 2 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    h.source.queue = [issue("issue-A", "TY-1")];

    // transition(in_progress) fails once transiently, then succeeds
    let transitionCallCount = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (issueId: string, state: any) => {
      transitionCallCount += 1;
      if (transitionCallCount === 1) {
        throw new Error("network timeout");
      }
      return origTransition(issueId, state);
    };

    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "All pass" },
    ];
    planner.outcomes = [
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.verifyAttempts).toBe(1);

    // Transient retry was logged
    expect(h.logs.some(l => l.includes("transient retry 1"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 8: ci_failed + branch protection → halt (override, not recover)
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: ci_failed with branch protection → halt", () => {
  it("ci_failed with branch_protection detail halts instead of recovering", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];

    // Monitor: done → ci_failed with branch protection
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      return { ready: false, reason: "blocked" as const };
    };

    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo it" },
    ];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");

    // No recovery was attempted — halted directly
    expect(h.notifier.events.some(e => e.kind === "recovery_started")).toBe(false);
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 9: Two tasks in sequence, both with VERIFY pass
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: two tasks sequentially with VERIFY", () => {
  it("both tasks pass VERIFY and merge in sequence", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designReviewer: planner });

    h.source.queue = [
      issue("issue-A", "TY-1"),
      issue("issue-B", "TY-2"),
    ];
    h.agent.outcomes = [
      // TY-1: IMPLEMENT + SELF-REVIEW
      { kind: "completed", costUsd: 1.5, summary: "TY-1 done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
      // TY-2: IMPLEMENT + SELF-REVIEW
      { kind: "completed", costUsd: 2.0, summary: "TY-2 done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    // VERIFY evidence for both
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "TY-1 tests pass" },
      { kind: "completed", costUsd: 0.3, summary: "TY-2 tests pass" },
    ];
    // Planner: SELECT PM (eligible=2) + TY-1 VERIFY judgment + TY-2 VERIFY judgment (eligible=1 → no PM)
    planner.outcomes = [
      // SELECT PM for TY-1 (eligible=2)
      { kind: "completed", text: '{"identifier":"TY-1","rationale":"first"}' },
      // TY-1 VERIFY judgment: pass
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
      // TY-2 VERIFY judgment: pass (no SELECT PM — eligible=1)
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    // Monitor for both
    h.monitor.verdicts = [
      { kind: "done" }, { kind: "merged" },
      { kind: "done" }, { kind: "merged" },
    ];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].state).toBe("merged");
    expect(sessions[1].state).toBe("merged");
    expect(sessions[0].verifyAttempts).toBe(1);
    expect(sessions[1].verifyAttempts).toBe(1);
    expect(h.store.countMerged(runId)).toBe(2);

    // Both had VERIFY logs
    expect(h.store.getVerifyLogsForSession(sessions[0].id)).toHaveLength(1);
    expect(h.store.getVerifyLogsForSession(sessions[1].id)).toHaveLength(1);

    // Linear transitions: each went through in_progress → in_review → done
    const transitions = h.source.transitions;
    expect(transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
      { issueId: "issue-B", state: "in_progress" },
      { issueId: "issue-B", state: "in_review" },
      { issueId: "issue-B", state: "done" },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 10: design_rejected(pre-PR) → abandon → needs-human →
//              loop continues with next task + VERIFY
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: design_rejected abandon → next task with VERIFY", () => {
  it("design_rejected triggers abandon, next task passes verify and merges", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const designer = new FakePlanRunner();
    const designReviewer = new FakePlanRunner();
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer, designReviewer });

    h.source.queue = [
      issue("issue-A", "TY-1"),
      issue("issue-B", "TY-2"),
    ];
    // TY-1: DESIGN succeeds but DESIGN REVIEW rejects × max (initial + 2 redesigns = 3 designs, 3 reviews)
    // Flow: design #1 → review reject #1 → design #2 → review reject #2 → design #3 → review reject #3 → design_rejected (attempt > maxRedesigns=2)
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nBad design\n## Change Targets\nsrc/a.ts\n## Implementation Steps\n1. Do it\n## Acceptance Criteria\n- works\n## Out of Scope\nnothing" },
      { kind: "completed", text: "## Goal\nBad design v2\n## Change Targets\nsrc/a.ts\n## Implementation Steps\n1. Do it\n## Acceptance Criteria\n- works\n## Out of Scope\nnothing" },
      { kind: "completed", text: "## Goal\nBad design v3\n## Change Targets\nsrc/a.ts\n## Implementation Steps\n1. Do it\n## Acceptance Criteria\n- works\n## Out of Scope\nnothing" },
      // TY-2: DESIGN
      { kind: "completed", text: "## Goal\nGood design\n## Change Targets\nsrc/b.ts\n## Implementation Steps\n1. Do it\n## Acceptance Criteria\n- works\n## Out of Scope\nnothing" },
    ];
    designReviewer.outcomes = [
      // TY-1: reject × 3 (initial review + 2 redesign reviews; designAttempt exceeds maxRedesigns=2 after 3rd reject)
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["poor design"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["still poor"]}\n```' },
      { kind: "completed", text: '```json\n{"verdict":"reject","reasons":["still bad"]}\n```' },
      // TY-2: approve
      { kind: "completed", text: '```json\n{"verdict":"approve","reasons":[]}\n```' },
    ];
    h.agent.outcomes = [
      // TY-2: IMPLEMENT + SELF-REVIEW
      { kind: "completed", costUsd: 2.0, summary: "TY-2 done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.verifyAgent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "All pass" },
    ];
    // Planner: SELECT PM (eligible=2) + TY-2 VERIFY (eligible=1 → no PM)
    planner.outcomes = [
      { kind: "completed", text: '{"identifier":"TY-1","rationale":"try first"}' },
      { kind: "completed", text: '```json\n{"verdict":"pass","reasons":[]}\n```' },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(2);

    // TY-1: abandoned (design_rejected)
    const ty1 = sessions.find(s => s.linearIdentifier === "TY-1")!;
    expect(ty1.state).toBe("stopped");
    expect(ty1.failureReason).toBe("design_rejected");
    expect(ty1.recoveryAction).toBe("abandon");

    // TY-2: merged with VERIFY pass
    const ty2 = sessions.find(s => s.linearIdentifier === "TY-2")!;
    expect(ty2.state).toBe("merged");
    expect(ty2.verifyAttempts).toBe(1);

    // needs-human on TY-1
    expect(h.source.labelAdds).toContainEqual({
      issueId: "issue-A",
      labelName: "needs-human",
    });

    // task_skipped for TY-1
    expect(h.notifier.events.some(
      e => e.kind === "task_skipped" && "identifier" in e && e.identifier === "TY-1",
    )).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 11: VERIFY disabled → skip gate, go straight to HANDOFF
// ────────────────────────────────────────────────────────────────────────────
describe("v3.5 E2E: VERIFY disabled", () => {
  it("verify.enabled=false skips VERIFY gate entirely", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    (config as any).verify = { enabled: false, runRecipe: "" };
    const h = makeHarness(config);

    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.5, summary: "done" },
    ];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.verifyAttempts).toBe(0);

    // No verify logs
    expect(h.store.getVerifyLogsForSession(s.id)).toHaveLength(0);

    // verifyAgent was never called
    expect(h.verifyAgent.callCount).toBe(0);
  });
});
