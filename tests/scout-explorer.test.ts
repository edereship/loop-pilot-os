import { describe, it, expect } from "vitest";
import {
  runScoutExploration,
  REFORMAT_TIMEOUT_MS,
  REFORMAT_MIN_BUDGET_USD,
  type ScoutExplorerDeps,
} from "../src/scout-explorer.js";
import { FakeAgentRunner, FakeCommandRunner } from "./fakes.js";
import type { AgentOutcome } from "../src/types.js";

const REPO = "/repo";
const VALID_JSON =
  '```json\n{"candidates":[{"title":"bug","description":"desc","evidence":"output","evidence_type":"objective","priority":2}]}\n```';

function completed(fullResult: string, costUsd = 0.5): AgentOutcome {
  return { kind: "completed", costUsd, summary: fullResult.slice(0, 100), fullResult };
}

function setup(outcomes: AgentOutcome[]): {
  deps: ScoutExplorerDeps;
  agent: FakeAgentRunner;
  runner: FakeCommandRunner;
  logs: string[];
} {
  const agent = new FakeAgentRunner();
  agent.outcomes = outcomes;
  const runner = new FakeCommandRunner();
  runner.on(["git", "rev-parse", "HEAD"], { stdout: "abc123\n" });
  runner.on(["git", "checkout"], {});
  runner.on(["git", "clean"], {});
  runner.on(["git", "reset"], {});
  const logs: string[] = [];
  const deps: ScoutExplorerDeps = {
    agent,
    runner,
    repoPath: REPO,
    prompt: "EXPLORE",
    maxCostUsd: 2,
    timeoutMs: 30 * 60_000,
    log: (l) => logs.push(l),
  };
  return { deps, agent, runner, logs };
}

function gitCalls(runner: FakeCommandRunner): string[][] {
  return runner.calls.filter((c) => c.cmd === "git").map((c) => c.args);
}

function expectCleanup(runner: FakeCommandRunner, withReset = true): void {
  const calls = gitCalls(runner);
  const tail = calls.slice(withReset ? -3 : -2);
  expect(tail[0]).toEqual(["checkout", "HEAD", "--", "."]);
  expect(tail[1]).toEqual(["clean", "-fd"]);
  if (withReset) expect(tail[2]).toEqual(["reset", "--hard", "abc123"]);
}

describe("runScoutExploration", () => {
  it("ok path: runs agent on the main checkout with budget/timeout, parses, cleans up", async () => {
    const { deps, agent, runner } = setup([completed(VALID_JSON)]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.costUsd).toBe(0.5);
    }
    expect(agent.contexts[0].worktreePath).toBe(REPO);
    expect(agent.contexts[0].maxCostUsd).toBe(2);
    expect(agent.contexts[0].hardTimeoutMs).toBe(30 * 60_000);
    expect(gitCalls(runner)[0]).toEqual(["rev-parse", "HEAD"]);
    expectCleanup(runner);
  });

  it("parse_error -> reformat retry succeeds; costs summed; retry ctx has remaining budget and REFORMAT_TIMEOUT_MS", async () => {
    const { deps, agent, runner } = setup([completed("no json here", 0.5), completed(VALID_JSON, 0.2)]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.costUsd).toBeCloseTo(0.7);
    expect(agent.callCount).toBe(2);
    expect(agent.contexts[1].prompt).toContain("could not be parsed");
    expect(agent.contexts[1].prompt).toContain("no json here");
    expect(agent.contexts[1].maxCostUsd).toBeCloseTo(1.5);
    expect(agent.contexts[1].hardTimeoutMs).toBe(REFORMAT_TIMEOUT_MS);
    expectCleanup(runner);
  });

  it("reformat retry also fails to parse -> error with raw preview; costs summed", async () => {
    const { deps } = setup([completed("no json here", 0.5), completed("still no json", 0.2)]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("parse failed");
      expect(result.costUsd).toBeCloseTo(0.7);
    }
  });

  it("skips reformat when raw is empty (known OAuth empty-response case)", async () => {
    const { deps, agent } = setup([completed("", 0.5)]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("empty raw");
    expect(agent.callCount).toBe(1);
  });

  it("skips reformat when remaining budget is below REFORMAT_MIN_BUDGET_USD", async () => {
    const { deps, agent } = setup([completed("no json here", 1.95)]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("remaining budget");
    expect(agent.callCount).toBe(1);
    expect(REFORMAT_MIN_BUDGET_USD).toBeGreaterThan(2 - 1.95 - 1e-9);
  });

  it("maps cost_exceeded to error; cleanup still runs", async () => {
    const { deps, runner } = setup([{ kind: "cost_exceeded", costUsd: 2 }]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    expectCleanup(runner);
  });

  it("maps agent error to error", async () => {
    const { deps } = setup([{ kind: "error", costUsd: 0.1, message: "boom" }]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("boom");
  });

  it("propagates interrupted from the exploration session; cleanup still runs", async () => {
    const { deps, runner } = setup([{ kind: "interrupted", costUsd: 0.3 }]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("interrupted");
    if (result.kind === "interrupted") expect(result.costUsd).toBe(0.3);
    expectCleanup(runner);
  });

  it("propagates interrupted from the reformat retry (does not degrade to error)", async () => {
    const { deps } = setup([completed("no json here", 0.5), { kind: "interrupted", costUsd: 0.1 }]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("interrupted");
    if (result.kind === "interrupted") expect(result.costUsd).toBeCloseTo(0.6);
  });

  it("maps a runSession throw to error (never propagates exceptions); cleanup still runs", async () => {
    const { deps, runner } = setup([]);
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("no outcome queued");
    expectCleanup(runner);
  });

  it("skips reset when rev-parse fails, but still runs checkout/clean", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["git", "rev-parse", "HEAD"], { code: 1, stderr: "fatal" });
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const calls = gitCalls(runner);
    expect(calls.some((a) => a[0] === "reset")).toBe(false);
    expectCleanup(runner, false);
  });
});
