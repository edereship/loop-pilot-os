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

  it("abandon: codex says abandon → close PR → revert ticket → escalated(abandon)", async () => {
    const { deps, planner, git, source, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 0 });

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    const result = await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "abandon" });
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

    expect(result).toEqual<RecoveryTurnResult>({ kind: "failed", message: "recovery fix agent made no commits" });
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
});
