# ES-504: abandon 経路 transient リトライ + haltIfRevertFailed 削除

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply ES-488's transient retry (`retryTransient`) to all abandon-path Linear/GitHub operations and remove the dead `haltIfRevertFailed` parameter.

**Architecture:** Wrap each abandon-path API call in `retryTransient` (same contract as ES-488: err.cause priority, config-driven retry count, deterministic errors throw immediately). `executeAbandon` (recovery-turn.ts) wraps PR close, branch delete, and ticket revert step-by-step. `stopSession` (orchestrator.ts) wraps the pre-PR todo revert. `applyNeedsHumanTriage` wraps addLabel and postComment (best-effort, no control-flow impact).

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- ES-488 contract: transient判定は `err.cause` 優先、リトライ回数は `config.safety.transientRetryAttempts`（デフォルト2）、決定的エラーは即 throw
- `retryTransient` / `isTransientError` の実装は変更しない
- 既存の ES-488 / ES-490 / ES-492 テストを壊さない

---

### Task 1: Remove `haltIfRevertFailed` dead parameter

**Files:**
- Modify: `src/orchestrator.ts:4279` (opts type), `:1178`, `:1206` (call sites)

**Interfaces:**
- Consumes: none
- Produces: cleaned `stopSession` signature (no `opts` parameter)

- [ ] **Step 1: Remove opts from stopSession signature**

In `src/orchestrator.ts`, change line 4279 from:

```typescript
    opts: { haltIfRevertFailed?: boolean } = {},
```

to delete the entire parameter. The signature becomes:

```typescript
  private async stopSession(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber" | "workflowHandledErrorCount">> = {},
  ): Promise<RunControl> {
```

- [ ] **Step 2: Remove `{ haltIfRevertFailed: true }` from call sites**

Line 1178 — change:
```typescript
              { haltIfRevertFailed: true },
```
to remove the argument entirely. The call becomes:
```typescript
            const ctrl = await this.stopSession(
              session, "design_rejected",
              baseDetailA,
              {},
            );
```

Line 1206 — change:
```typescript
            const ctrl = await this.stopSession(session, "design_rejected", detail, {}, { haltIfRevertFailed: true });
```
to:
```typescript
            const ctrl = await this.stopSession(session, "design_rejected", detail, {});
```

- [ ] **Step 3: Verify type check passes**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts
git commit -m "refactor: remove haltIfRevertFailed dead parameter from stopSession (ES-504)"
```

---

### Task 2: Apply transient retry to `executeAbandon` + tests

**Files:**
- Modify: `src/recovery-turn.ts:1` (import), `:561-632` (executeAbandon body)
- Modify: `tests/orchestrator.test.ts` (add test describe block)

**Interfaces:**
- Consumes: `retryTransient` from `src/transient-retry.ts`, `config.safety.transientRetryAttempts` from deps
- Produces: `executeAbandon` now retries transient errors per-step (same return type, same contract on deterministic failure)

- [ ] **Step 1: Write failing tests**

Add a new describe block at the end of `tests/orchestrator.test.ts` (before the final `});`), inside the top-level describe. Add it after the last existing test (around line 9122):

```typescript
describe("ES-504 abandon transient retry — executeAbandon", () => {
  it("PR close transient → リトライ → abandon 完遂 → CONTINUE", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // PR close: 1st call → transient (ECONNRESET), 2nd call → success
    let prCloseCalls = 0;
    h.recoveryRunner.on(["gh", "pr", "close"], () => {
      prCloseCalls++;
      if (prCloseCalls === 1) return { code: 1, stderr: "ECONNRESET" };
      return { code: 0 };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    // Run did NOT halt — abandon completed after retry
    const run = h.store.latestRun()!;
    expect(run.state).not.toBe("halted");
    // PR close was called twice (1st transient + 2nd success)
    expect(prCloseCalls).toBe(2);
    // Retry was logged
    expect(h.logs.some((l) => l.includes("transient retry") && l.includes("PR close"))).toBe(true);
  });

  it("branch delete transient → リトライ → abandon 完遂", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // Branch delete: 1st call → transient, 2nd → success
    let branchDeleteCalls = 0;
    h.recoveryRunner.on(["git", "push", "origin", "--delete"], () => {
      branchDeleteCalls++;
      if (branchDeleteCalls === 1) return { code: 1, stderr: "Connection reset by peer" };
      return { code: 0 };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    const run = h.store.latestRun()!;
    expect(run.state).not.toBe("halted");
    expect(branchDeleteCalls).toBe(2);
  });

  it("ticket revert transient → リトライ → abandon 完遂", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // Ticket revert (transition to todo): 1st call → transient, 2nd → success
    let todoTransitionCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoTransitionCalls++;
        if (todoTransitionCalls === 1) throw new Error("ECONNRESET");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    expect(s.recoveryAction).toBe("abandon");
    const run = h.store.latestRun()!;
    expect(run.state).not.toBe("halted");
    // transition(todo) called twice: 1st ECONNRESET + 2nd success
    expect(todoTransitionCalls).toBe(2);
  });

  it("PR close deterministic エラー → リトライなし → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner, designer: planner });
    const oldRun = h.store.createRun(1, "2026-06-04T00:00:00.000Z");
    const seeded = h.store.createSession({
      runId: oldRun.id,
      linearIssueId: "issue-A",
      linearIdentifier: "TY-1",
      issueTitle: "Fix bug",
      branch: "looppilot/ty-1-fix",
      worktreePath: "/wt/ty-1",
      now: "2026-06-04T00:00:00.000Z",
    });
    h.store.updateSession(seeded.id, {
      state: "in_review",
      prNumber: 100,
      recoveryAttempted: 0,
      recoveryTurnAttempts: 2,
      monitorStartedAt: "2026-06-04T00:01:00.000Z",
    });
    h.source.queue = [];
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.checkMergeReadiness = async () => ({ ready: false, reason: "ci_failed" as const });
    planner.outcomes = [];
    // PR close: deterministic error (not transient)
    let prCloseCalls = 0;
    h.recoveryRunner.on(["gh", "pr", "close"], () => {
      prCloseCalls++;
      return { code: 1, stderr: "HTTP 404 Not Found" };
    });

    await h.orch.run();

    const s = h.store.getSession(seeded.id);
    expect(s.state).toBe("stopped");
    // Deterministic → no retry
    expect(prCloseCalls).toBe(1);
    // Run halted because abandon failed
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "ES-504 abandon transient retry — executeAbandon"`
Expected: Tests fail (transient errors are not retried yet)

- [ ] **Step 3: Add `retryTransient` import to recovery-turn.ts**

In `src/recovery-turn.ts`, add after line 10 (`import type { Config } from "./config.js";`):

```typescript
import { retryTransient } from "./transient-retry.js";
```

- [ ] **Step 4: Wrap PR close in retryTransient**

Replace the PR close block in `executeAbandon` (lines 577-590) with:

```typescript
  if (session.prNumber !== null) {
    try {
      await retryTransient(config.safety.transientRetryAttempts, async () => {
        const closeResult = await runner.run(
          "gh", ["pr", "close", String(session.prNumber), "-R", config.repo.remote],
          { cwd: config.repo.path },
        );
        if (closeResult.code !== 0) {
          const msg = closeResult.stderr.trim() || `exit ${closeResult.code}`;
          if (!/already\s*closed/i.test(msg)) {
            throw new Error(msg, { cause: msg });
          }
          log(`recovery: abandon PR already closed, proceeding with cleanup`);
        }
      }, { onRetry: (n, e) => log(`transient retry ${n}: abandon PR close: ${e instanceof Error ? e.message : e}`) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`recovery: abandon PR close failed: ${msg}`);
      return { kind: "failed", action: "abandon", message: `PR close failed: ${msg}` };
    }
  }
```

- [ ] **Step 5: Wrap branch delete in retryTransient**

Replace the branch delete block (lines 599-620) with:

```typescript
  try {
    await retryTransient(config.safety.transientRetryAttempts, async () => {
      const deleteResult = await runner.run(
        "git", ["push", "origin", "--delete", session.branch],
        { cwd: config.repo.path },
      );
      if (deleteResult.code !== 0) {
        const stderr = deleteResult.stderr.trim();
        if (!/remote ref does not exist/i.test(stderr)) {
          throw new Error(stderr, { cause: stderr });
        }
        log(`recovery: abandon remote branch already deleted`);
      }
    }, { onRetry: (n, e) => log(`transient retry ${n}: abandon branch delete: ${e instanceof Error ? e.message : e}`) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`recovery: abandon remote branch delete failed: ${msg}`);
    return { kind: "failed", action: "abandon", message: `remote branch delete failed: ${msg}` };
  }
```

- [ ] **Step 6: Wrap ticket revert in retryTransient**

Replace the ticket revert block (lines 621-630) with:

```typescript
  try {
    await retryTransient(config.safety.transientRetryAttempts, () =>
      source.transition(session.linearIssueId, "todo"),
      { onRetry: (n, e) => log(`transient retry ${n}: abandon ticket revert: ${e instanceof Error ? e.message : e}`) },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`recovery: abandon ticket revert failed: ${msg}`);
    return { kind: "failed", action: "abandon", message: `ticket revert to Todo failed: ${msg}` };
  }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/orchestrator.test.ts -t "ES-504 abandon transient retry — executeAbandon"`
Expected: All 4 tests pass

- [ ] **Step 8: Run existing ES-488 / abandon tests to verify no regressions**

Run: `npx vitest run tests/orchestrator.test.ts -t "N1 ネットワーク瞬断"`
Run: `npx vitest run tests/orchestrator.test.ts -t "abandon"`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/recovery-turn.ts tests/orchestrator.test.ts
git commit -m "feat: apply transient retry to executeAbandon steps (ES-504)"
```

---

### Task 3: Apply transient retry to pre-PR abandon + `applyNeedsHumanTriage` + tests

**Files:**
- Modify: `src/orchestrator.ts:4795-4802` (pre-PR todo revert), `:4906`, `:4924` (applyNeedsHumanTriage)
- Modify: `tests/orchestrator.test.ts` (add test describe block)

**Interfaces:**
- Consumes: `retryTransient` (already imported in orchestrator.ts at line 45)
- Produces: pre-PR abandon and applyNeedsHumanTriage retry transient errors (same control flow on final failure)

- [ ] **Step 1: Write failing tests**

Add a new describe block at the end of `tests/orchestrator.test.ts`:

```typescript
describe("ES-504 abandon transient retry — pre-PR abandon", () => {
  it("todo revert transient → リトライ → 成功 → CONTINUE", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "completed", costUsd: 1.0, summary: "done" },
      { kind: "error", costUsd: 0.0, message: "self-review skipped" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
      { kind: "completed", text: "## Goal\nB" },
    ];
    h.monitor.verdicts = [{ kind: "merged" }];
    // todo revert: 1st call → transient, 2nd → success
    let todoRevertCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoRevertCalls++;
        if (todoRevertCalls === 1) throw new Error("ECONNRESET");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    // Run continued to TY-2 (not halted)
    expect(sessions.find((s) => s.linearIdentifier === "TY-2")).toBeDefined();
    const run = h.store.latestRun()!;
    expect(run.state).not.toBe("halted");
    // transition(todo) retried
    expect(todoRevertCalls).toBe(2);
    expect(h.logs.some((l) => l.includes("transient retry") && l.includes("todo revert"))).toBe(true);
  });

  it("todo revert deterministic → リトライなし → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const designer = new FakePlanRunner();
    const h = makeHarness(config, { designer });
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "done" },
    ];
    h.git.commitsWithDiff.set("/wt/ty-1", false);
    designer.outcomes = [
      { kind: "completed", text: "## Goal\nA" },
    ];
    // todo revert: deterministic error
    let todoRevertCalls = 0;
    const origTransition = h.source.transition.bind(h.source);
    h.source.transition = async (id: string, state: string) => {
      if (state === "todo" && id === "issue-A") {
        todoRevertCalls++;
        throw new Error("HTTP 403 Forbidden");
      }
      return origTransition(id, state as any);
    };

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    const sA = sessions.find((s) => s.linearIdentifier === "TY-1")!;
    expect(sA.state).toBe("stopped");
    expect(sA.failureReason).toBe("agent_no_change");
    // Deterministic → no retry
    expect(todoRevertCalls).toBe(1);
    // Run halted (ticket stuck In Progress)
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // TY-2 was not started
    expect(sessions.find((s) => s.linearIdentifier === "TY-2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "ES-504 abandon transient retry — pre-PR abandon"`
Expected: Tests fail (transient errors are not retried yet)

- [ ] **Step 3: Wrap pre-PR todo revert in retryTransient**

In `src/orchestrator.ts`, replace lines 4795-4802 (the todo revert try/catch inside pre-PR abandon):

From:
```typescript
        try {
          await this.source.transition(session.linearIssueId, "todo");
        } catch (err) {
          todoRevertErr = errMsg(err);
          this.log(`policy-abandon: todo revert failed (ticket may be stuck): ${todoRevertErr}`);
          effectiveDetail = effectiveDetail
            ? `${effectiveDetail}; todo revert failed: ${todoRevertErr}`
            : `todo revert failed: ${todoRevertErr}`;
        }
```

To:
```typescript
        try {
          await retryTransient(this.config.safety.transientRetryAttempts, () =>
            this.source.transition(session.linearIssueId, "todo"),
            { onRetry: (n, e) => this.log(`transient retry ${n}: todo revert for ${session.linearIdentifier}: ${errMsg(e)}`) },
          );
        } catch (err) {
          todoRevertErr = errMsg(err);
          this.log(`policy-abandon: todo revert failed (ticket may be stuck): ${todoRevertErr}`);
          effectiveDetail = effectiveDetail
            ? `${effectiveDetail}; todo revert failed: ${todoRevertErr}`
            : `todo revert failed: ${todoRevertErr}`;
        }
```

- [ ] **Step 4: Wrap applyNeedsHumanTriage addLabel in retryTransient**

In `src/orchestrator.ts`, replace the addLabel try/catch in `applyNeedsHumanTriage` (lines 4905-4911):

From:
```typescript
    try {
      await this.source.addLabel(session.linearIssueId, label);
      labelApplied = true;
      this.store.markNeedsHumanLabelAdded(session.id);
    } catch (err) {
      this.log(`needs-human: addLabel failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
```

To:
```typescript
    try {
      await retryTransient(this.config.safety.transientRetryAttempts, () =>
        this.source.addLabel(session.linearIssueId, label),
        { onRetry: (n, e) => this.log(`transient retry ${n}: addLabel for ${session.linearIdentifier}: ${errMsg(e)}`) },
      );
      labelApplied = true;
      this.store.markNeedsHumanLabelAdded(session.id);
    } catch (err) {
      this.log(`needs-human: addLabel failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
```

- [ ] **Step 5: Wrap applyNeedsHumanTriage postComment in retryTransient**

In `src/orchestrator.ts`, replace the postComment try/catch (lines 4923-4927):

From:
```typescript
    try {
      await this.source.postComment(session.linearIssueId, commentBody);
    } catch (err) {
      this.log(`needs-human: postComment failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
```

To:
```typescript
    try {
      await retryTransient(this.config.safety.transientRetryAttempts, () =>
        this.source.postComment(session.linearIssueId, commentBody),
        { onRetry: (n, e) => this.log(`transient retry ${n}: postComment for ${session.linearIdentifier}: ${errMsg(e)}`) },
      );
    } catch (err) {
      this.log(`needs-human: postComment failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
    }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/orchestrator.test.ts -t "ES-504 abandon transient retry — pre-PR abandon"`
Expected: Both tests pass

- [ ] **Step 7: Run full regression suite**

Run: `npx vitest run tests/orchestrator.test.ts`
Run: `npx vitest run tests/transient-retry.test.ts`
Run: `npx tsc --noEmit`
Expected: All pass, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: apply transient retry to pre-PR abandon + applyNeedsHumanTriage (ES-504)"
```

---

### Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify acceptance criteria**

Checklist:
- [ ] Todo 復帰 / PR close が 1 回目 transient → 2 回目成功のとき、abandon 完遂・Run 継続（テスト名で確認）
- [ ] 決定的エラー（4xx 系）は即 halt（リトライしない）のテスト（テスト名で確認）
- [ ] `haltIfRevertFailed` が型・呼び出しから消えている（`grep -rn haltIfRevertFailed src/` が空）
- [ ] 既存の ES-488 / ES-490 / ES-492 系テストが緑

Run: `grep -rn haltIfRevertFailed src/`
Expected: no output
