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
    maxCostUsd: 2.0,
    ...overrides,
  };
}

describe("AgentWorkflowRecovery", () => {
  it("successful fix: agent completes → push → /restart-review → restarted", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed lock file" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.5 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toEqual(["push", "origin", "looppilot/ty-1-fix"]);
    expect(pushCall!.opts.cwd).toBe("/wt/ty-1");
    const commentCall = runner.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr");
    expect(commentCall).toBeDefined();
    expect(commentCall!.args).toEqual(["pr", "comment", "42", "-R", REMOTE, "-b", "/restart-review"]);
  });

  it("already handled: errorCommentCount <= fixAttempts → restarted(costUsd=0)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "fix" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    const result = await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0 });
  });

  it("exhausted: fixAttempts >= maxAttempts → exhausted", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 1 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fix1" },
    ];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    const result = await recovery.attemptRecovery(ctx({ errorCommentCount: 2 }));

    expect(result).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.5 });
  });

  it("agent error → unrecoverable", async () => {
    const { recovery, agent } = makeRecovery();
    agent.outcomes = [{ kind: "error", costUsd: 0.1, message: "agent crashed" }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 0.1,
      message: "agent crashed",
    });
  });

  it("agent cost_exceeded → unrecoverable", async () => {
    const { recovery, agent } = makeRecovery();
    agent.outcomes = [{ kind: "cost_exceeded", costUsd: 2.0 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 2.0,
      message: "fix agent exceeded cost limit",
    });
  });

  it("git push failure → throws", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    runner.on(["git", "push"], { code: 1, stderr: "rejected" });

    await expect(recovery.attemptRecovery(ctx())).rejects.toThrow(/git push failed/);
  });

  it("gh pr comment failure → throws", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 1, stderr: "not found" });

    await expect(recovery.attemptRecovery(ctx())).rejects.toThrow(/gh pr comment failed/);
  });

  it("two successful fixes increment fixAttempts correctly", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 2 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "fix1" },
      { kind: "completed", costUsd: 0.4, summary: "fix2" },
    ];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const r1 = await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    expect(r1).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.3 });

    const r2 = await recovery.attemptRecovery(ctx({ errorCommentCount: 2 }));
    expect(r2).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.4 });

    const r3 = await recovery.attemptRecovery(ctx({ errorCommentCount: 3 }));
    expect(r3).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.7 });
  });

  it("buildFixPrompt includes the error body", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "ok" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorBody: "⚠️ CUSTOM ERROR" }));

    expect(agent.contexts[0].prompt).toContain("⚠️ CUSTOM ERROR");
    expect(agent.contexts[0].worktreePath).toBe("/wt/ty-1");
    expect(agent.contexts[0].maxCostUsd).toBe(2.0);
  });
});
