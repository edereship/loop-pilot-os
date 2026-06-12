import { describe, it, expect } from "vitest";
import { AgentWorkflowRecovery } from "../src/workflow-recovery.js";
import { FakeAgentRunner, FakeCommandRunner } from "./fakes.js";
import type { RecoveryContext, RecoveryOutcome } from "../src/types.js";

const REMOTE = "acme/widget";

function makeRecovery(opts: {
  maxAttempts?: number;
} = {}): {
  recovery: AgentWorkflowRecovery;
  agent: FakeAgentRunner;
  runner: FakeCommandRunner;
  logs: string[];
} {
  const agent = new FakeAgentRunner();
  const runner = new FakeCommandRunner();
  const logs: string[] = [];
  const recovery = new AgentWorkflowRecovery(
    agent,
    runner,
    REMOTE,
    opts.maxAttempts ?? 2,
    (line) => logs.push(line),
  );
  return { recovery, agent, runner, logs };
}

function ctx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    worktreePath: "/wt/ty-1",
    branch: "looppilot/ty-1-fix",
    prNumber: 42,
    errorBody: "⚠️ workflow failed",
    errorCommentCount: overrides.errorCommentCount ?? 1,
    fixAttempts: overrides.fixAttempts ?? 0,
    handledErrorCount: overrides.handledErrorCount ?? 0,
    maxCostUsd: 2.0,
    ...overrides,
  };
}

/** Register git -C stubs for status (clean) and log (non-empty) checks. */
function stubGitChecks(runner: FakeCommandRunner): void {
  runner.on(["git", "-C"], (args) => {
    if (args.includes("status")) return { code: 0, stdout: "" };
    if (args.includes("log")) return { code: 0, stdout: "deadbeef fix commit\n" };
    return { code: 0 };
  });
}

describe("AgentWorkflowRecovery", () => {
  it("successful fix: agent completes → push → /restart-review → restarted", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed lock file" }];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.5, newFix: true });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    // Push the verified HEAD as <branch>, not the named local ref — guards against the
    // fix agent leaving the worktree on a detached HEAD / temporary branch (Finding 4).
    expect(pushCall!.args).toEqual(["push", "origin", "HEAD:looppilot/ty-1-fix"]);
    expect(pushCall!.opts.cwd).toBe("/wt/ty-1");
    // The branch was synced before the fix agent ran (Finding 3 review): fetch then reset.
    const gitCMinusC = runner.calls.filter((c) => c.cmd === "git" && c.args[0] === "-C");
    const fetchCall = gitCMinusC.find((c) => c.args.includes("fetch"));
    const resetCall = gitCMinusC.find((c) => c.args.includes("reset"));
    expect(fetchCall).toBeDefined();
    expect(fetchCall!.args).toEqual(["-C", "/wt/ty-1", "fetch", "origin", "looppilot/ty-1-fix"]);
    expect(resetCall).toBeDefined();
    expect(resetCall!.args).toEqual([
      "-C",
      "/wt/ty-1",
      "reset",
      "--hard",
      "origin/looppilot/ty-1-fix",
    ]);
    const commentCall = runner.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr");
    expect(commentCall).toBeDefined();
    expect(commentCall!.args).toEqual(["pr", "comment", "42", "-R", REMOTE, "-b", "/restart-review"]);
  });

  it("already handled: errorCommentCount <= handledErrorCount → restarted(costUsd=0)", async () => {
    const { recovery } = makeRecovery();
    // Simulate the state after a previous fix run: handledErrorCount=1, fixAttempts=1.
    const result = await recovery.attemptRecovery(ctx({
      errorCommentCount: 1,
      fixAttempts: 1,
      handledErrorCount: 1,
    }));
    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0, newFix: false });
  });

  it("backlog of pre-existing errors handled atomically: errorCommentCount=2, one fix covers both", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 2 });
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "fix" }];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    // First call: 2 pre-existing errors, no prior fix → runs fix, returns restarted.
    const r1 = await recovery.attemptRecovery(ctx({
      errorCommentCount: 2,
      fixAttempts: 0,
      handledErrorCount: 0,
    }));
    expect(r1).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.3, newFix: true });

    // Caller persists: workflowFixAttempts=1, workflowHandledErrorCount=2.
    // Second call: same 2 errors, handledErrorCount=2 → already handled, no new fix.
    const r2 = await recovery.attemptRecovery(ctx({
      errorCommentCount: 2,
      fixAttempts: 1,
      handledErrorCount: 2,
    }));
    expect(r2).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0, newFix: false });
  });

  it("exhausted: fixAttempts >= maxAttempts → exhausted", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 1 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fix1" },
    ];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    // First fix attempt (fixAttempts=0, new error).
    await recovery.attemptRecovery(ctx({ errorCommentCount: 1, fixAttempts: 0, handledErrorCount: 0 }));
    // Second call: caller has persisted fixAttempts=1, handledErrorCount=1; new error appears.
    const result = await recovery.attemptRecovery(ctx({
      errorCommentCount: 2,
      fixAttempts: 1,
      handledErrorCount: 1,
    }));

    expect(result).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.5 });
  });

  it("agent error → unrecoverable", async () => {
    const { recovery, agent, runner } = makeRecovery();
    // Sync runs before the agent (Finding 3 review); stub fetch/reset to succeed
    // so the agent failure is what surfaces.
    runner.on(["git", "-C"], { code: 0 });
    agent.outcomes = [{ kind: "error", costUsd: 0.1, message: "agent crashed" }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 0.1,
      message: "agent crashed",
    });
  });

  it("agent cost_exceeded → unrecoverable", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], { code: 0 });
    agent.outcomes = [{ kind: "cost_exceeded", costUsd: 2.0 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 2.0,
      message: "fix agent exceeded cost limit",
    });
  });

  it("git fetch failure during sync → unrecoverable, fix agent does not run (Finding 3 review)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    // First sync command (fetch) fails; reset would succeed but never runs.
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 1, stderr: "fatal: could not read from remote" };
      return { code: 0 };
    });
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "should not run" }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toMatchObject<Partial<RecoveryOutcome>>({
      kind: "unrecoverable",
      costUsd: 0,
    });
    expect((result as { kind: "unrecoverable"; message: string }).message).toContain("git fetch failed");
    // Fix agent was never invoked because sync failed first.
    expect(agent.contexts).toHaveLength(0);
  });

  it("git reset failure during sync → unrecoverable, fix agent does not run (Finding 3 review)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 1, stderr: "fatal: not a git repository" };
      return { code: 0 };
    });
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "should not run" }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toMatchObject<Partial<RecoveryOutcome>>({
      kind: "unrecoverable",
      costUsd: 0,
    });
    expect((result as { kind: "unrecoverable"; message: string }).message).toContain("git reset --hard origin/");
    expect(agent.contexts).toHaveLength(0);
  });

  it("git push failure → unrecoverable with agent cost (Finding 4)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 1, stderr: "rejected" });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toMatchObject<Partial<RecoveryOutcome>>({
      kind: "unrecoverable",
      costUsd: 0.2,
    });
    expect((result as { kind: "unrecoverable"; message: string }).message).toContain("git push failed");
  });

  it("gh pr comment failure → unrecoverable with agent cost (Finding 4)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 1, stderr: "not found" });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toMatchObject<Partial<RecoveryOutcome>>({
      kind: "unrecoverable",
      costUsd: 0.2,
    });
    expect((result as { kind: "unrecoverable"; message: string }).message).toContain("restart review failed");
  });

  it("uncommitted changes after agent completes → unrecoverable (Finding 3)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "partial fix" }];
    // status reports dirty working tree
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "M package-lock.json\n" };
      if (args.includes("log")) return { code: 0, stdout: "deadbeef fix\n" };
      return { code: 0 };
    });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 0.3,
      message: "fix agent left uncommitted changes",
    });
  });

  it("no commits after agent completes → unrecoverable (Finding 3)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "no commit" }];
    // status clean but log empty (no new commits)
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "" };
      return { code: 0 };
    });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 0.3,
      message: "fix agent made no commits",
    });
  });

  it("two successful fixes increment fixAttempts correctly", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 2 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "fix1" },
      { kind: "completed", costUsd: 0.4, summary: "fix2" },
    ];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const r1 = await recovery.attemptRecovery(ctx({ errorCommentCount: 1, fixAttempts: 0, handledErrorCount: 0 }));
    expect(r1).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.3, newFix: true });

    // Caller persists fixAttempts=1, handledErrorCount=1, new error appears.
    const r2 = await recovery.attemptRecovery(ctx({ errorCommentCount: 2, fixAttempts: 1, handledErrorCount: 1 }));
    expect(r2).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.4, newFix: true });

    // Caller persists fixAttempts=2, handledErrorCount=2, another new error.
    const r3 = await recovery.attemptRecovery(ctx({ errorCommentCount: 3, fixAttempts: 2, handledErrorCount: 2 }));
    expect(r3).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.7 });
  });

  it("buildFixPrompt includes the error body", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "ok" }];
    stubGitChecks(runner);
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorBody: "⚠️ CUSTOM ERROR" }));

    expect(agent.contexts[0].prompt).toContain("⚠️ CUSTOM ERROR");
    expect(agent.contexts[0].worktreePath).toBe("/wt/ty-1");
    expect(agent.contexts[0].maxCostUsd).toBe(2.0);
  });
});
