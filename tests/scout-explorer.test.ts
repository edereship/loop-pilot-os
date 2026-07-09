import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runScoutExploration,
  REFORMAT_TIMEOUT_MS,
  REFORMAT_MIN_BUDGET_USD,
  type ScoutExplorerDeps,
} from "../src/scout-explorer.js";
import { FakeAgentRunner, FakeCommandRunner } from "./fakes.js";
import type { AgentOutcome } from "../src/types.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs.length = 0;
});

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "scout-test-"));
  tmpDirs.push(d);
  return d;
}

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
  runner.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "main\n" });
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
  // Cleanup sequence: checkout HEAD -- . → clean -fd → checkout <startBranch> → [reset --hard <sha>]
  const count = withReset ? 4 : 3;
  const tail = calls.slice(-count);
  expect(tail[0]).toEqual(["checkout", "HEAD", "--", "."]);
  expect(tail[1]).toEqual(["clean", "-fd"]);
  expect(tail[2]).toEqual(["checkout", "main"]);
  if (withReset) expect(tail[3]).toEqual(["reset", "--hard", "abc123"]);
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

  it("skips reset when rev-parse fails, but still runs checkout/clean/branch-restore; logs warning", async () => {
    const { deps, runner, logs } = setup([completed(VALID_JSON)]);
    runner.on(["git", "rev-parse", "HEAD"], { code: 1, stderr: "fatal" });
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const calls = gitCalls(runner);
    expect(calls.some((a) => a[0] === "reset")).toBe(false);
    expectCleanup(runner, false);
    expect(logs.some((l) => l.includes("warning") && l.includes("startSha"))).toBe(true);
  });

  it("skips branch checkout when abbrev-ref rev-parse returns HEAD (detached HEAD state)", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "HEAD\n" });
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const calls = gitCalls(runner);
    // In detached HEAD state there is no branch to restore; cleanup omits the branch checkout
    // but still resets to the starting SHA.
    const checkoutCalls = calls.filter((a) => a[0] === "checkout");
    // Only the "checkout HEAD -- ." cleanup call; no branch restore
    expect(checkoutCalls.every((a) => a.includes("."))).toBe(true);
    expect(calls.some((a) => a[0] === "reset")).toBe(true);
  });

  it("with objectiveOnly=true, reformat prompt forbids spec_mismatch", async () => {
    const { deps, agent } = setup([completed("no json here", 0.5), completed(VALID_JSON, 0.2)]);
    deps.objectiveOnly = true;
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    expect(agent.callCount).toBe(2);
    // Reformat prompt must not present spec_mismatch as a valid evidence_type
    expect(agent.contexts[1].prompt).not.toContain('"spec_mismatch"');
    expect(agent.contexts[1].prompt).toContain("spec_mismatch is forbidden");
  });

  it("with objectiveOnly=false (default), reformat prompt allows spec_mismatch", async () => {
    const { deps, agent } = setup([completed("no json here", 0.5), completed(VALID_JSON, 0.2)]);
    // objectiveOnly omitted → defaults to false
    await runScoutExploration(deps);
    expect(agent.contexts[1].prompt).toContain('"spec_mismatch"');
  });

  it("with defaultBranch: fetches and resets before recording startSha, then cleans up to refreshed state", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["git", "fetch"], {});
    runner.on(["git", "reset", "--hard", "origin/main"], { stdout: "HEAD is now at abc123\n" });
    deps.defaultBranch = "main";
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const calls = gitCalls(runner);
    // fetch and reset must come before rev-parse
    const fetchIdx = calls.findIndex(a => a[0] === "fetch");
    const revParseIdx = calls.findIndex(a => a[0] === "rev-parse");
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(revParseIdx);
    expect(calls[fetchIdx]).toEqual(["fetch", "origin", "main"]);
    const resetBeforeAgent = calls.slice(0, revParseIdx).find(a => a[0] === "reset" && a.includes("origin/main"));
    expect(resetBeforeAgent).toBeDefined();
  });

  it("with defaultBranch: logs a warning and continues when fetch fails", async () => {
    const { deps, runner, logs } = setup([completed(VALID_JSON)]);
    runner.on(["git", "fetch"], { code: 1, stderr: "fatal: unable to connect" });
    deps.defaultBranch = "main";
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    expect(logs.some(l => l.includes("warning") && l.includes("fetch"))).toBe(true);
  });

  // Finding 3 — ES-519: prompt builder called after git reset so spec content is fresh
  it("with prompt builder and defaultBranch: builder is called after the git reset", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["git", "fetch"], {});
    const callOrder: string[] = [];
    runner.on(["git", "reset", "--hard", "origin/main"], () => {
      callOrder.push("reset");
      return { stdout: "HEAD is now at abc123\n" };
    });
    deps.defaultBranch = "main";
    deps.prompt = () => {
      callOrder.push("builder");
      return "EXPLORE";
    };
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    expect(callOrder.indexOf("reset")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("builder")).toBeGreaterThan(callOrder.indexOf("reset"));
  });

  it("with prompt builder (no defaultBranch): builder is called before the agent", async () => {
    const { deps, agent } = setup([completed(VALID_JSON)]);
    let builderCalled = false;
    deps.prompt = () => {
      builderCalled = true;
      return "EXPLORE_FRESH";
    };
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    expect(builderCalled).toBe(true);
    expect(agent.contexts[0].prompt).toBe("EXPLORE_FRESH");
  });

  // Finding 5 — ES-519: process cleanup runs before git cleanup
  it("runs lsof process cleanup in finally before git cleanup; kills discovered PIDs", async () => {
    const { deps, runner, logs } = setup([completed(VALID_JSON)]);
    runner.on(["lsof", "+D", REPO, "-t"], { stdout: "1234\n5678\n" });
    runner.on(["kill"], {});
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // lsof must be called
    expect(runner.calls.some(c => c.cmd === "lsof")).toBe(true);
    // kill -TERM must be called with the discovered PIDs
    const killCall = runner.calls.find(c => c.cmd === "kill" && c.args[0] === "-TERM");
    expect(killCall).toBeDefined();
    expect(killCall!.args).toContain("1234");
    expect(killCall!.args).toContain("5678");
    // log message expected
    expect(logs.some(l => l.includes("orphaned") && l.includes("1234"))).toBe(true);
    // process cleanup must precede git cleanup: kill call before first git-checkout call
    const killIdx = runner.calls.findIndex(c => c.cmd === "kill");
    const checkoutIdx = runner.calls.findIndex(c => c.cmd === "git" && c.args[0] === "checkout");
    expect(killIdx).toBeLessThan(checkoutIdx);
  });

  it("skips process cleanup gracefully when lsof returns no PIDs", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["lsof", "+D", REPO, "-t"], { stdout: "\n" });
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // kill must NOT be called when there are no PIDs
    expect(runner.calls.some(c => c.cmd === "kill")).toBe(false);
  });

  it("skips process cleanup gracefully when lsof is unavailable (no stub = throws)", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    // lsof intentionally not stubbed → FakeCommandRunner throws → caught internally
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // git cleanup must still run
    expectCleanup(runner);
  });

  // Finding 2 — ES-519: descendant/reparented guard prevents killing unrelated processes
  it("with getDescendantPids: only kills descendant PIDs, spares unrelated processes", async () => {
    const { deps, runner, logs } = setup([completed(VALID_JSON)]);
    const descendantPid = "1234";
    const unrelatedPid = "5678";
    runner.on(["lsof", "+D", REPO, "-t"], { stdout: `${descendantPid}\n${unrelatedPid}\n` });
    runner.on(["kill"], {});
    deps.getDescendantPids = (rootPid) => {
      // Simulate that 1234 is a descendant of our process, 5678 is not
      void rootPid;
      return new Set([parseInt(descendantPid, 10)]);
    };
    deps.getReparentedPids = () => new Set<number>();
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const killCall = runner.calls.find(c => c.cmd === "kill" && c.args[0] === "-TERM");
    expect(killCall).toBeDefined();
    expect(killCall!.args).toContain(descendantPid);
    expect(killCall!.args).not.toContain(unrelatedPid);
    expect(logs.some(l => l.includes("orphaned") && l.includes(descendantPid))).toBe(true);
  });

  it("with getDescendantPids returning null (non-Linux): falls back to basic filtering", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    runner.on(["lsof", "+D", REPO, "-t"], { stdout: "1234\n5678\n" });
    runner.on(["kill"], {});
    deps.getDescendantPids = () => null; // /proc unavailable
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // With null ancestry, falls back to basic-filtered list: both PIDs are killed
    const killCall = runner.calls.find(c => c.cmd === "kill" && c.args[0] === "-TERM");
    expect(killCall).toBeDefined();
    expect(killCall!.args).toContain("1234");
    expect(killCall!.args).toContain("5678");
  });

  it("with getDescendantPids and getReparentedPids: kills reparented PIDs too", async () => {
    const { deps, runner } = setup([completed(VALID_JSON)]);
    const reparentedPid = "3333";
    const unrelatedPid = "4444";
    runner.on(["lsof", "+D", REPO, "-t"], { stdout: `${reparentedPid}\n${unrelatedPid}\n` });
    runner.on(["kill"], {});
    deps.getDescendantPids = () => new Set<number>(); // no direct descendants
    deps.getReparentedPids = (pids) => new Set(pids.filter(p => p === parseInt(reparentedPid, 10)));
    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    const killCall = runner.calls.find(c => c.cmd === "kill" && c.args[0] === "-TERM");
    expect(killCall).toBeDefined();
    expect(killCall!.args).toContain(reparentedPid);
    expect(killCall!.args).not.toContain(unrelatedPid);
  });

  // Finding 6 — ES-519: preserve memory content across git reset --hard
  it("with defaultBranch: restores memory categories that had content before the reset", async () => {
    const tmpDir = makeTmpDir();
    const memoryDir = path.join(tmpDir, "docs", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const pmDecisionsPath = path.join(memoryDir, "pm-decisions.md");
    const memContent = "# PM Decisions\n\nUse snake_case for all identifiers.\n";
    writeFileSync(pmDecisionsPath, memContent, "utf-8");

    const agent = new FakeAgentRunner();
    agent.outcomes = [completed(VALID_JSON)];
    const runner = new FakeCommandRunner();
    runner.on(["git", "rev-parse", "HEAD"], { stdout: "abc123\n" });
    runner.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "main\n" });
    runner.on(["git", "fetch", "origin", "main"], {});
    // Simulate git reset --hard by deleting the memory file
    runner.on(["git", "reset", "--hard", "origin/main"], (_args, _opts) => {
      try { rmSync(pmDecisionsPath); } catch { /* file may not exist */ }
      return { stdout: "HEAD is now at abc123\n", code: 0 };
    });
    runner.on(["git", "checkout"], {});
    runner.on(["git", "clean"], {});
    runner.on(["git", "reset"], {});
    const logs: string[] = [];
    const deps: ScoutExplorerDeps = {
      agent,
      runner,
      repoPath: tmpDir,
      prompt: "EXPLORE",
      maxCostUsd: 2,
      timeoutMs: 30 * 60_000,
      log: (l) => logs.push(l),
      defaultBranch: "main",
    };

    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // Memory file must be restored after the reset
    expect(existsSync(pmDecisionsPath)).toBe(true);
    expect(readFileSync(pmDecisionsPath, "utf-8")).toBe(memContent);
  });

  // Finding 2 — ES-519: memory must survive the cleanup git clean -fd that runs after SCOUT
  it("with defaultBranch: memory survives git clean -fd in cleanup (post-cleanup re-apply)", async () => {
    const tmpDir = makeTmpDir();
    const memoryDir = path.join(tmpDir, "docs", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const pmDecisionsPath = path.join(memoryDir, "pm-decisions.md");
    const memContent = "# PM Decisions\n\nUse snake_case for all identifiers.\n";
    writeFileSync(pmDecisionsPath, memContent, "utf-8");

    const agent = new FakeAgentRunner();
    agent.outcomes = [completed(VALID_JSON)];
    const runner = new FakeCommandRunner();
    runner.on(["git", "rev-parse", "HEAD"], { stdout: "abc123\n" });
    runner.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "main\n" });
    runner.on(["git", "fetch", "origin", "main"], {});
    runner.on(["git", "reset", "--hard", "origin/main"], (_args, _opts) => {
      try { rmSync(pmDecisionsPath); } catch { /* file may not exist */ }
      return { stdout: "HEAD is now at abc123\n", code: 0 };
    });
    runner.on(["git", "checkout"], {});
    // Simulate git clean -fd removing the restored memory file (the real bug scenario)
    runner.on(["git", "clean", "-fd"], (_args, _opts) => {
      try { rmSync(pmDecisionsPath); } catch { /* file may not exist */ }
      return { stdout: "", code: 0 };
    });
    runner.on(["git", "reset"], {});
    const deps: ScoutExplorerDeps = {
      agent,
      runner,
      repoPath: tmpDir,
      prompt: "EXPLORE",
      maxCostUsd: 2,
      timeoutMs: 30 * 60_000,
      log: () => {},
      defaultBranch: "main",
    };

    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // Memory file must be restored even after git clean -fd deleted it during cleanup
    expect(existsSync(pmDecisionsPath)).toBe(true);
    expect(readFileSync(pmDecisionsPath, "utf-8")).toBe(memContent);
  });

  it("with defaultBranch and no local memory: does not create memory files after reset", async () => {
    const tmpDir = makeTmpDir();
    // No memory directory created — files don't exist

    const agent = new FakeAgentRunner();
    agent.outcomes = [completed(VALID_JSON)];
    const runner = new FakeCommandRunner();
    runner.on(["git", "rev-parse", "HEAD"], { stdout: "abc123\n" });
    runner.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "main\n" });
    runner.on(["git", "fetch", "origin", "main"], {});
    runner.on(["git", "reset", "--hard", "origin/main"], { stdout: "HEAD is now at abc123\n" });
    runner.on(["git", "checkout"], {});
    runner.on(["git", "clean"], {});
    runner.on(["git", "reset"], {});
    const deps: ScoutExplorerDeps = {
      agent,
      runner,
      repoPath: tmpDir,
      prompt: "EXPLORE",
      maxCostUsd: 2,
      timeoutMs: 30 * 60_000,
      log: () => {},
      defaultBranch: "main",
    };

    const result = await runScoutExploration(deps);
    expect(result.kind).toBe("ok");
    // No memory directory should be created when there was nothing to restore
    const memoryDir = path.join(tmpDir, "docs", "memory");
    const pmPath = path.join(memoryDir, "pm-decisions.md");
    expect(existsSync(pmPath)).toBe(false);
  });
});
