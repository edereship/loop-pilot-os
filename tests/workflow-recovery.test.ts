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

  it("agent interrupted: pushes local commits and returns restarted when push succeeds (Finding 4)", async () => {
    // If the fix agent made commits then was interrupted (e.g. during rate-limit sleep),
    // those commits must be pushed immediately. Otherwise, the next attemptRecovery call
    // starts with syncBranchToOrigin which does `git reset --hard origin/<branch>` and
    // silently discards the local-only commits. After a successful push the outcome must
    // be restarted(newFix: true) so the orchestrator increments workflowFixAttempts,
    // records workflowHandledErrorCount, and resets monitorStartedAt — preventing duplicate
    // fix runs and false not-engaged guard triggers on the next poll.
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "deadbeef fix commit\n" };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.05 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.05, newFix: true });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toEqual(["push", "origin", "HEAD:looppilot/ty-1-fix"]);
    // After pushing interrupted commits, /restart-review must be posted so
    // LoopPilot re-runs (the workflow triggers only on issue_comment, not push).
    const commentCall = runner.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr");
    expect(commentCall).toBeDefined();
    expect(commentCall!.args).toEqual(["pr", "comment", "42", "-R", REMOTE, "-b", "/restart-review"]);
  });

  it("agent interrupted with no local commits: does not push (Finding 4)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "" }; // no commits ahead
      return { code: 0 };
    });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.0 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "interrupted", costUsd: 0.0 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  it("agent interrupted with dirty worktree: commits WIP then pushes and returns restarted (Finding 3)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: "M src/fix.ts\n" };
      if (args.includes("add")) return { code: 0 };
      if (args.includes("commit")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "deadbeef WIP commit\n" };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.05 }];

    const result = await recovery.attemptRecovery(ctx());

    // Push succeeded after the WIP commit, so return restarted(newFix: true) to keep
    // orchestrator bookkeeping (workflowFixAttempts, monitorStartedAt) in sync.
    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.05, newFix: true });
    // WIP commit was created: git add -A and git commit were called
    const addCall = runner.calls.find((c) =>
      c.cmd === "git" && c.args.includes("-C") && c.args.includes("add"),
    );
    expect(addCall).toBeDefined();
    const commitCall = runner.calls.find((c) =>
      c.cmd === "git" && c.args.includes("-C") && c.args.includes("commit"),
    );
    expect(commitCall).toBeDefined();
    expect(commitCall!.args).toContain("WIP: interrupted fix-agent edits");
    // Push happened after the WIP commit
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
  });

  it("agent interrupted with dirty worktree but commit fails: still returns interrupted (Finding 3)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("status")) return { code: 0, stdout: "M src/fix.ts\n" };
      if (args.includes("add")) return { code: 0 };
      if (args.includes("commit")) return { code: 1, stderr: "nothing to commit" };
      if (args.includes("log")) return { code: 0, stdout: "" };
      return { code: 0 };
    });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.02 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "interrupted", costUsd: 0.02 });
    // No push because commit failed and log shows no commits ahead
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeUndefined();
  });

  it("agent interrupted: restart-review comment failure after successful push → unrecoverable (Finding 4)", async () => {
    // Push succeeds but /restart-review comment fails. The old code swallowed the
    // comment failure and returned restarted(newFix:true), causing the orchestrator
    // to record workflowHandledErrorCount even though the workflow was never restarted.
    // The fix propagates the failure so the orchestrator surfaces it immediately.
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "deadbeef fix commit\n" };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 1, stderr: "not found" });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.05 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toMatchObject<Partial<RecoveryOutcome>>({
      kind: "unrecoverable",
      costUsd: 0.05,
    });
    expect((result as { kind: "unrecoverable"; message: string }).message).toContain(
      "restart review failed",
    );
  });

  it("agent interrupted: push failure is silently swallowed, interrupted still returned (Finding 4)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      if (args.includes("log")) return { code: 0, stdout: "deadbeef fix commit\n" };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 1, stderr: "rejected: not fast-forward" });
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.05 }];

    const result = await recovery.attemptRecovery(ctx());

    // Push failed, but we still return interrupted (not unrecoverable) — best-effort.
    expect(result).toEqual<RecoveryOutcome>({ kind: "interrupted", costUsd: 0.05 });
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
