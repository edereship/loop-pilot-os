import { describe, it, expect } from "vitest";
import { parseRecoveryAction } from "../src/recovery-turn.js";

describe("parseRecoveryAction", () => {
  it("parses valid fix_code action from fenced JSON", () => {
    const text = `Analysis: CI failed due to missing lock file.\n\n\`\`\`json\n{"action":"fix_code","instruction":"Run npm install to regenerate package-lock.json"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({
      action: "fix_code",
      instruction: "Run npm install to regenerate package-lock.json",
    });
  });

  it("parses valid escalate action", () => {
    const text = `\`\`\`json\n{"action":"escalate"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("parses valid rebase action", () => {
    const text = `{"action":"rebase","instruction":"Rebase onto main"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "rebase", instruction: "Rebase onto main" });
  });

  it("parses valid restart_review action", () => {
    const text = `\`\`\`json\n{"action":"restart_review"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "restart_review" });
  });

  it("parses valid abandon action", () => {
    const text = `{"action":"abandon","instruction":"PR was intentionally closed"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "abandon", instruction: "PR was intentionally closed" });
  });

  it("returns escalate fallback for invalid JSON", () => {
    const result = parseRecoveryAction("This is not JSON at all");
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for unknown action", () => {
    const text = `{"action":"unknown_action"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for empty string", () => {
    const result = parseRecoveryAction("");
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for missing action field", () => {
    const text = `{"instruction":"do something"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("uses last fenced JSON block when multiple present", () => {
    const text = [
      "First analysis:",
      "```json",
      '{"action":"escalate"}',
      "```",
      "Wait, actually:",
      "```json",
      '{"action":"fix_code","instruction":"fix it"}',
      "```",
    ].join("\n");
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "fix_code", instruction: "fix it" });
  });
});

import { buildRecoveryPrompt } from "../src/recovery-turn.js";
import type { TaskSessionRow, FailureReason } from "../src/types.js";

function fakeSession(overrides: Partial<TaskSessionRow> = {}): TaskSessionRow {
  return {
    id: 1, runId: 1,
    linearIssueId: "issue-1", linearIdentifier: "TY-1",
    issueTitle: "Fix the bug", branch: "looppilot/ty-1-fix",
    worktreePath: "/wt/ty-1", prNumber: 42,
    state: "in_review", costUsd: 1.5,
    failureReason: null, stopDetail: null,
    agentSummary: "I tried to fix it but CI failed",
    planBrief: "## Goal\nFix the test", selectRationale: null,
    startedAt: "2026-01-01T00:00:00.000Z", monitorStartedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null, workflowFixAttempts: 0, workflowHandledErrorCount: 0,
    autoRestartAttempts: 0, pendingRestartReason: null,
    recoveryAttempted: 0, recoveryAction: null,
    ...overrides,
  };
}

describe("buildRecoveryPrompt", () => {
  it("includes stop reason, session context, and expected JSON schema", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession(),
      reason: "ci_failed" as FailureReason,
      detail: "npm test exited with code 1",
    });
    expect(prompt).toContain("ci_failed");
    expect(prompt).toContain("npm test exited with code 1");
    expect(prompt).toContain("TY-1");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("I tried to fix it but CI failed");
    expect(prompt).toContain('"action"');
    expect(prompt).toContain("fix_code");
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("abandon");
  });

  it("includes plan_brief when present", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession({ planBrief: "## Plan\nDo the thing" }),
      reason: "ci_failed" as FailureReason,
      detail: null,
    });
    expect(prompt).toContain("## Plan\nDo the thing");
  });

  it("omits plan_brief section when null", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession({ planBrief: null }),
      reason: "ci_failed" as FailureReason,
      detail: null,
    });
    expect(prompt).not.toContain("Plan Brief");
  });

  it("handles null detail gracefully", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession(),
      reason: "agent_no_change" as FailureReason,
      detail: null,
    });
    expect(prompt).toContain("agent_no_change");
  });
});

import { executeRecoveryTurn } from "../src/recovery-turn.js";
import type { RecoveryTurnDeps, RecoveryTurnResult } from "../src/recovery-turn.js";
import {
  FakeAgentRunner,
  FakeCommandRunner,
  FakeGitPr,
  FakePlanRunner,
  FakeTaskSource,
} from "./fakes.js";
import type { Config } from "../src/config.js";

function makeConfig(): Config {
  return {
    product: { goal: "ship it", specDir: undefined },
    repo: { path: "/repo", remote: "owner/name", defaultBranch: "main", worktreeRoot: "/wt" },
    safety: {
      maxTasksPerRun: 3, maxCostUsdPerSession: 10,
      notEngagedGuardMinutes: 30, monitorTimeoutMinutes: 60,
      sessionHardTimeoutMinutes: 120, maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2, codexTimeoutMinutes: 30,
      selectDiffBudgetChars: 6000, selectCodebaseSummaryBudgetChars: 5000,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    looppilot: { gateLabel: "loop-pilot" },
    notify: { progress: false },
    digest: { recentMergedCount: 5, enabled: true },
  } as unknown as Config;
}

function makeDeps(overrides: Partial<{
  plannerOutcome: import("../src/types.js").PlanOutcome;
  agentOutcome: import("../src/types.js").AgentOutcome;
}> = {}): { deps: RecoveryTurnDeps; planner: FakePlanRunner; agent: FakeAgentRunner; git: FakeGitPr; runner: FakeCommandRunner; source: FakeTaskSource; logs: string[] } {
  const planner = new FakePlanRunner();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const runner = new FakeCommandRunner();
  const source = new FakeTaskSource();
  const logs: string[] = [];
  if (overrides.plannerOutcome) planner.outcomes.push(overrides.plannerOutcome);
  if (overrides.agentOutcome) agent.outcomes.push(overrides.agentOutcome);
  const deps: RecoveryTurnDeps = {
    planner, agent, git, runner, source,
    config: makeConfig(),
    log: (line) => logs.push(line),
  };
  return { deps, planner, agent, git, runner, source, logs };
}

describe("executeRecoveryTurn", () => {
  it("fix_code: codex says fix_code → agent runs → push → restart → recovered", async () => {
    const { deps, planner, agent, runner, git } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '```json\n{"action":"fix_code","instruction":"Run npm install"}\n```' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "ci_failed", "test failed");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "fix_code", costUsd: 0.5 });
    expect(agent.contexts[0].prompt).toContain("Run npm install");
    const restartCall = git.calls.find((c) => c.method === "postComment" && (c.args as unknown[])[1] === "/restart-review");
    expect(restartCall).toBeDefined();
  });

  it("restart_review: codex says restart_review → post comment → recovered", async () => {
    const { deps, git, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"restart_review"}' }];

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "looppilot_stopped", "workflow_crashed");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "restart_review", costUsd: 0 });
    const restartCall = git.calls.find((c) => c.method === "postComment" && (c.args as unknown[])[1] === "/restart-review");
    expect(restartCall).toBeDefined();
  });

  it("escalate: codex says escalate → escalated result", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"escalate"}' }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "pr_closed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("abandon: codex says abandon → close PR → revert ticket → continued(abandon)", async () => {
    const { deps, planner, git, source, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 0 });

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    const result = await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "continued", action: "abandon" });
    const closeCall = runner.calls.find((c) => c.cmd === "gh" && c.args.includes("close"));
    expect(closeCall).toBeDefined();
    expect(source.transitions).toContainEqual({ issueId: "issue-1", state: "todo" });
    const discardCall = git.calls.find((c) => c.method === "discardWorktree");
    expect(discardCall).toBeDefined();
  });

  it("codex error → escalated fallback", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "error", message: "codex crashed" }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "exception", "something broke");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("codex returns unparseable JSON → escalated fallback", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: "I have no idea what to do" }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "exception", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("fix_code: agent makes no commits → failed", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "done" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "failed", action: "fix_code", message: "recovery fix agent made no commits", costUsd: 0.3 });
  });

  it("rebase: successful rebase → push → restart → recovered", async () => {
    const { deps, planner, git, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"rebase"}' }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("rebase")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "merge_conflict", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "rebase", costUsd: 0 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toContain("--force-with-lease");
    const restartCall = git.calls.find((c) => c.method === "postComment");
    expect(restartCall).toBeDefined();
  });

  it("no PR number: fix_code actions that need PR → failed", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "done" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: null });
    const result = await executeRecoveryTurn(deps, session, "agent_no_change", null);

    // fix_code without PR: push succeeds but no /restart-review (no PR to comment on)
    // Still recovered — the session can be picked up later
    expect(result.kind).toBe("recovered");
  });

  // Finding 3: interrupted fix agent with ahead commits → push before halting
  it("fix_code: agent interrupted with commits ahead → push attempted before returning interrupted", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.2 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" }; // commits ahead
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 0 });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "interrupted", costUsd: 0.2 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
  });

  // ES-450 Finding 1: interrupted fix agent with dirty (uncommitted) changes → create WIP commit and push
  it("fix_code: agent interrupted with dirty changes and no commits ahead → creates WIP commit and pushes", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.15 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: " M src/foo.ts\n" }; // dirty file
      if (args.includes("add")) return { code: 0 };
      if (args.includes("commit")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "abc wip\n" }; // WIP commit shows up
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 0 });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "interrupted", costUsd: 0.15 });
    const addCall = runner.calls.find((c) => c.cmd === "git" && c.args.includes("add"));
    expect(addCall).toBeDefined();
    const commitCall = runner.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
    expect(commitCall).toBeDefined();
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
  });

  // ES-450 Finding 2: git add fails during WIP commit → failed result (not interrupted)
  it("fix_code: agent interrupted with dirty changes and git add fails → failed result (not interrupted)", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.15 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: " M src/foo.ts\n" }; // dirty file
      if (args.includes("add")) return { code: 1, stderr: "index lock error" };
      return { code: 0, stdout: "" };
    });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("WIP commit failed"),
      costUsd: 0.15,
    });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  // ES-450 Finding 2: git commit fails during WIP commit → failed result (not interrupted)
  it("fix_code: agent interrupted with dirty changes and git commit fails → failed result (not interrupted)", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.12 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: " M src/foo.ts\n" }; // dirty file
      if (args.includes("add")) return { code: 0 };
      if (args.includes("commit")) return { code: 1, stderr: "pre-commit hook rejected" };
      return { code: 0, stdout: "" };
    });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("WIP commit failed"),
      costUsd: 0.12,
    });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  // ES-450 Finding (iteration 8): git status exits non-zero during interrupted recovery → failed
  it("fix_code: agent interrupted and git status fails → failed result (not interrupted)", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.18 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 128, stderr: "fatal: index file open failed" };
      return { code: 0, stdout: "" };
    });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("git status failed"),
      costUsd: 0.18,
    });
    // No push should happen after a status failure
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  // Finding 3: interrupted fix agent with no ahead commits → no push
  it("fix_code: agent interrupted with no commits ahead → returns interrupted without push", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.1 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "" }; // no commits ahead
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 0 });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "interrupted", costUsd: 0.1 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  // Finding 4: push failure after fix agent → failed result must include costUsd
  it("fix_code: push fails after fix agent → failed result includes costUsd", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.4, summary: "fixed" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 1, stderr: "rejected" });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("recovery push failed"),
      costUsd: 0.4,
    });
  });

  // Finding 5: gh pr close exits non-zero → failed before reverting ticket
  it("abandon: gh pr close fails → failed(abandon) without ticket revert", async () => {
    const { deps, planner, runner, source } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 1, stderr: "not found" });

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    const result = await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    expect(result).toMatchObject<Partial<RecoveryTurnResult>>({ kind: "failed", action: "abandon" });
    // Ticket must NOT be reverted — PR may still be open
    expect(source.transitions).toHaveLength(0);
  });

  // Finding 6: ticket revert throws → failed(abandon) without discarding worktree
  it("abandon: ticket revert fails → failed(abandon) without worktree discard", async () => {
    const { deps, planner, runner, source, git } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 0 });
    source.failNext("transition", new Error("Linear 5xx"));

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    const result = await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    expect(result).toMatchObject<Partial<RecoveryTurnResult>>({ kind: "failed", action: "abandon" });
    // Worktree must NOT be discarded — the session is unresolved
    const discardCall = git.calls.find((c) => c.method === "discardWorktree");
    expect(discardCall).toBeUndefined();
  });

  // Finding 1: buildRecoveryPrompt does not tell the fix agent to push or restart review
  it("buildRecoveryPrompt: fix_code description instructs agent to commit only, not push", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession(),
      reason: "ci_failed" as FailureReason,
      detail: null,
    });
    expect(prompt).toContain("fix_code");
    expect(prompt).not.toContain("push, and restart review");
    expect(prompt).toContain("commit only");
  });

  // Finding 2: interrupted push fails → failed result with costUsd (not interrupted)
  it("fix_code: agent interrupted with ahead commits and push fails → failed with costUsd", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.2 }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" }; // commits ahead
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 1, stderr: "rejected by remote" });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("interrupted recovery push failed"),
      costUsd: 0.2,
    });
  });

  // Finding 3: abandon close does not pass --delete-branch
  it("abandon: gh pr close is called without --delete-branch", async () => {
    const { deps, planner, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 0 });

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    const closeCall = runner.calls.find((c) => c.cmd === "gh" && c.args.includes("close"));
    expect(closeCall).toBeDefined();
    expect(closeCall!.args).not.toContain("--delete-branch");
  });

  // Finding 4: restart-review failure after successful push → failed with costUsd
  it("fix_code: restart-review fails after successful push → failed result includes costUsd", async () => {
    const { deps, planner, agent, runner, git } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      return { code: 0, stdout: "" };
    });
    runner.on(["git", "push"], { code: 0 });
    git.failNext("postComment");

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({
      kind: "failed",
      action: "fix_code",
      message: expect.stringContaining("restart-review"),
      costUsd: 0.5,
    });
  });
});
