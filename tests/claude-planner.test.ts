import { describe, it, expect } from "vitest";
import { ClaudePlanRunner } from "../src/claude-planner.js";
import { FakeAgentRunner } from "./fakes.js";

describe("ClaudePlanRunner", () => {
  it("maps completed AgentOutcome to PlanOutcome with full text", async () => {
    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "truncated", fullResult: "full design brief text" }];
    const runner = new ClaudePlanRunner(agent, { maxCostUsd: 2 });

    const result = await runner.run({ worktreePath: "/wt", prompt: "design it" });

    expect(result).toEqual({ kind: "completed", text: "full design brief text" });
    expect(agent.contexts[0]!.worktreePath).toBe("/wt");
    expect(agent.contexts[0]!.prompt).toBe("design it");
    expect(agent.contexts[0]!.maxCostUsd).toBe(2);
  });

  it("passes timeoutMs as hardTimeoutMs to agent", async () => {
    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "completed", costUsd: 0, summary: "", fullResult: "" }];
    const runner = new ClaudePlanRunner(agent, { maxCostUsd: 2 });

    await runner.run({ worktreePath: "/wt", prompt: "p", timeoutMs: 900_000 });

    expect(agent.contexts[0]!.hardTimeoutMs).toBe(900_000);
  });

  it("maps interrupted AgentOutcome to PlanOutcome interrupted", async () => {
    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "interrupted", costUsd: 0.1 }];
    const runner = new ClaudePlanRunner(agent, { maxCostUsd: 2 });

    const result = await runner.run({ worktreePath: "/wt", prompt: "p" });

    expect(result).toEqual({ kind: "interrupted" });
  });

  it("maps cost_exceeded AgentOutcome to PlanOutcome error", async () => {
    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "cost_exceeded", costUsd: 2 }];
    const runner = new ClaudePlanRunner(agent, { maxCostUsd: 2 });

    const result = await runner.run({ worktreePath: "/wt", prompt: "p" });

    expect(result).toEqual({ kind: "error", message: "design budget exceeded" });
  });

  it("maps error AgentOutcome to PlanOutcome error", async () => {
    const agent = new FakeAgentRunner();
    agent.outcomes = [{ kind: "error", costUsd: 0, message: "agent crashed" }];
    const runner = new ClaudePlanRunner(agent, { maxCostUsd: 2 });

    const result = await runner.run({ worktreePath: "/wt", prompt: "p" });

    expect(result).toEqual({ kind: "error", message: "agent crashed" });
  });
});
