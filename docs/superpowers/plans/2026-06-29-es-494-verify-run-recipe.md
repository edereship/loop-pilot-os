# ES-494: VERIFY 行動検証モード (run_recipe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the VERIFY phase with explicit process cleanup after `run_recipe` execution, and add comprehensive tests proving C3 (run_recipe mode) and C1 (degradation when unset) behaviors.

**Architecture:** Most of the prompt/config/orchestrator wiring for `run_recipe` is already implemented (ES-491). This ticket fills the gaps: (1) a `killWorktreeProcesses` safety-net that kills orphaned processes in the worktree after the verify agent finishes, (2) unit tests for the prompt layer's run_recipe branches, and (3) orchestrator integration tests proving the config-to-prompt-to-judgment pipeline works end-to-end with `runRecipe` set vs empty.

**Tech Stack:** TypeScript, Vitest, Node.js `child_process`

## Global Constraints

- `npm run check` must pass (build + typecheck + lint + test)
- All verify tests use the existing `FakeCommandRunner` / `FakeAgentRunner` / `FakePlanRunner` test patterns
- Process kill is best-effort (errors don't halt the verify flow)
- `cleanupVerifierWorktree` signature is unchanged; process kill is called separately after it

---

### Task 1: Process cleanup utility + orchestrator integration

**Files:**
- Modify: `src/orchestrator.ts` — add `killWorktreeProcesses` private method and call it from `cleanupVerifierWorktree`
- Test: `tests/orchestrator.test.ts` — add process cleanup integration test

**Interfaces:**
- Consumes: `CommandRunner.run()` from `types.ts:455-456`
- Produces: `killWorktreeProcesses(worktreePath: string): Promise<void>` (private method, best-effort, no return value)

- [ ] **Step 1: Write failing test — process cleanup is called after verify pass**

Add to `tests/orchestrator.test.ts` after the existing verify tests (around line 8507):

```typescript
it("verify: kills orphaned processes in worktree after evidence collection", async () => {
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

  const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
  expect(sessions[0].state).toBe("merged");

  // Verify that a process-kill command was issued targeting the worktree
  const killCalls = h.memoryRunner.calls.filter(
    c => c.cmd === "pkill" || (c.cmd === "sh" && c.args.some(a => a.includes("lsof"))),
  );
  expect(killCalls.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "kills orphaned processes"`
Expected: FAIL — no pkill/lsof calls recorded

- [ ] **Step 3: Implement `killWorktreeProcesses` and integrate**

In `src/orchestrator.ts`, add the private method after `cleanupVerifierWorktree` (after line 2842):

```typescript
private async killWorktreeProcesses(worktreePath: string): Promise<void> {
  try {
    const result = await this.runner.run(
      "sh", ["-c", `lsof +D ${JSON.stringify(worktreePath)} -t 2>/dev/null || true`],
      { cwd: worktreePath, timeoutMs: 10_000 },
    );
    const pids = result.stdout.trim().split("\n").filter(Boolean);
    if (pids.length === 0) return;
    this.log(`verify: killing ${pids.length} orphaned process(es) in worktree`);
    await this.runner.run(
      "kill", ["-TERM", ...pids],
      { cwd: worktreePath, timeoutMs: 5_000 },
    );
  } catch {
    // best-effort: process cleanup failure must not halt verify flow
  }
}
```

Then call it in the `verify` method. Find the main evidence-collection cleanup site (line 3110 `const cleanupOk = await this.cleanupVerifierWorktree(...)`) and add after line 3110:

```typescript
await this.killWorktreeProcesses(worktreePath);
```

Also add the call after every other `cleanupVerifierWorktree` call in the `verify` method where evidence collection completed (i.e. where `cleanupOk` is checked). There are two main sites:
1. After line 3110 (normal path after evidence collection)
2. After line 3300 (after judgment cleanup)

For the early-exit paths (error/interrupted before evidence completes), process cleanup is not needed because the agent session was killed or errored.

- [ ] **Step 4: Update FakeCommandRunner stubs**

In `tests/orchestrator.test.ts`, add stubs to `memoryRunner` in `makeHarness` (around line 167, after existing git stubs):

```typescript
// Process cleanup stubs for VERIFY (ES-494)
memoryRunner.on(["sh", "-c"], { code: 0, stdout: "" });
memoryRunner.on(["kill", "-TERM"], { code: 0 });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator.test.ts -t "kills orphaned processes"`
Expected: PASS

- [ ] **Step 6: Run full check**

Run: `npm run check`
Expected: All green

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(verify): kill orphaned processes in worktree after evidence collection (ES-494)"
```

---

### Task 2: Verify-prompt unit tests for runRecipe

**Files:**
- Modify: `tests/verify-prompt.test.ts` — add 5 tests for runRecipe evidence/judgment prompt behavior

**Interfaces:**
- Consumes: `buildVerifyEvidencePrompt` and `buildVerifyJudgmentPrompt` from `src/verify-prompt.ts`
- Produces: Test coverage for C3 (runRecipe set) and C1 degradation (runRecipe unset)

- [ ] **Step 1: Write tests for evidence prompt with runRecipe**

Add to `tests/verify-prompt.test.ts` inside the `buildVerifyEvidencePrompt` describe block (after line 144):

```typescript
it("includes acceptance check instruction when runRecipe is set", () => {
  const result = buildVerifyEvidencePrompt({
    issue, brief, specContent: null, defaultBranch: "main", runRecipe: "npm run e2e",
  });
  expect(result).toContain("Acceptance check");
  expect(result).toContain("npm run e2e");
  expect(result).toContain("## Acceptance Check");
});

it("omits acceptance check instruction when runRecipe is empty (C1 degradation)", () => {
  const result = buildVerifyEvidencePrompt({
    issue, brief, specContent: null, defaultBranch: "main", runRecipe: "",
  });
  expect(result).not.toContain("Acceptance check");
  expect(result).not.toContain("## Acceptance Check");
});

it("omits acceptance check instruction when runRecipe is undefined (C1 degradation)", () => {
  const result = buildVerifyEvidencePrompt({
    issue, brief, specContent: null, defaultBranch: "main",
  });
  expect(result).not.toContain("Acceptance check");
  expect(result).not.toContain("## Acceptance Check");
});
```

- [ ] **Step 2: Write tests for judgment prompt with hasRunRecipe**

Add to `tests/verify-prompt.test.ts` inside the `buildVerifyJudgmentPrompt` describe block (after line 258):

```typescript
it("includes acceptance check in oracle list when hasRunRecipe is true", () => {
  const result = buildVerifyJudgmentPrompt({
    acceptance: "Criteria",
    diff: "diff",
    evidence: "evidence",
    hasRunRecipe: true,
  });
  expect(result).toContain("acceptance check");
});

it("omits acceptance check from oracle list when hasRunRecipe is false", () => {
  const result = buildVerifyJudgmentPrompt({
    acceptance: "Criteria",
    diff: "diff",
    evidence: "evidence",
    hasRunRecipe: false,
  });
  const oracleLine = result.split("\n").find(l => l.includes("objective oracle"));
  expect(oracleLine).toBeDefined();
  expect(oracleLine).not.toContain("acceptance check");
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/verify-prompt.test.ts`
Expected: All PASS (these test existing behavior that already works)

- [ ] **Step 4: Commit**

```bash
git add tests/verify-prompt.test.ts
git commit -m "test(verify): add runRecipe prompt tests for C3/C1 degradation (ES-494)"
```

---

### Task 3: Orchestrator integration tests for runRecipe end-to-end

**Files:**
- Modify: `tests/orchestrator.test.ts` — add integration tests proving runRecipe flows through to verifyAgent prompt and judgment

**Interfaces:**
- Consumes: `FakeAgentRunner.contexts[]` for prompt assertions, `FakePlanRunner.contexts[]` for judgment assertions, `makeConfig`/`makeHarness`/`issue` helpers
- Produces: Integration test coverage for run_recipe config → prompt → judgment pipeline

- [ ] **Step 1: Write test — runRecipe set flows to verifyAgent prompt**

Add to `tests/orchestrator.test.ts` after the existing verify tests (around line 8507):

```typescript
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

  // Evidence prompt sent to verifyAgent must include the run_recipe command
  expect(h.verifyAgent.contexts).toHaveLength(1);
  expect(h.verifyAgent.contexts[0].prompt).toContain("npm run e2e");
  expect(h.verifyAgent.contexts[0].prompt).toContain("Acceptance check");
});
```

- [ ] **Step 2: Write test — runRecipe empty → C1 degradation (no acceptance check in prompt)**

```typescript
it("verify: runRecipe empty → evidence prompt omits acceptance check (C1 degradation)", async () => {
  const config = makeConfig({ maxTasksPerRun: 1 });
  // Default config already has runRecipe: ""
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

  // Evidence prompt must NOT include acceptance check when runRecipe is empty
  expect(h.verifyAgent.contexts).toHaveLength(1);
  expect(h.verifyAgent.contexts[0].prompt).not.toContain("Acceptance check");
  expect(h.verifyAgent.contexts[0].prompt).not.toContain("## Acceptance Check");
});
```

- [ ] **Step 3: Write test — runRecipe set → judgment prompt includes hasRunRecipe flag**

```typescript
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

  // Judgment prompt sent to planner must mention "acceptance check" in oracle list
  expect(planner.contexts).toHaveLength(1);
  expect(planner.contexts[0].prompt).toContain("acceptance check");
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator.test.ts -t "runRecipe"`
Expected: All PASS

- [ ] **Step 5: Run full check**

Run: `npm run check`
Expected: All green

- [ ] **Step 6: Commit**

```bash
git add tests/orchestrator.test.ts
git commit -m "test(verify): add runRecipe integration tests for C3 and C1 degradation (ES-494)"
```
