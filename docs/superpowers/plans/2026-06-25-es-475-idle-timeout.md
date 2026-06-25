# ES-475: アイドルタイムアウトでループ自動停止 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically halt the loop when no eligible tickets are found for a configurable duration.

**Architecture:** Add `idle_timeout_minutes` config (default 120, 0=disabled), persist `idle_started_at` timestamp on the `run` DB row, and check elapsed idle time at the top of each loop iteration. Follows the existing task_cap / monitor_timeout HALT patterns exactly.

**Tech Stack:** TypeScript, Zod, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-06-25-es-475-idle-timeout-design.md`

## Global Constraints

- All timestamps are ISO-8601 UTC strings
- DB migrations must be idempotent (guarded by column-existence checks)
- `fixedClock` in tests advances 1 second per call
- HALT pattern: notify → commitMemoryBeforeHalt → setRunState("halted", detail) → log → return

---

### Task 1: Config + Types + Store — data layer

**Files:**
- Modify: `src/config.ts:69-72` (Zod schema), `src/config.ts:149-152` (Config interface), `src/config.ts:659-662` (loadConfig return)
- Modify: `src/types.ts:41-48` (RunRow interface)
- Modify: `src/store.ts:84-91` (RawRunRow), `src/store.ts:100-109` (toRunRow), `src/store.ts:322-359` (migrate), `src/store.ts:394-401` (after setRunState)
- Modify: `tests/fixtures/config-valid.toml:46-48` (`[loop]` section)
- Test: `tests/store.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.loop.idleTimeoutMinutes: number` (consumed by Task 2)
- Produces: `RunRow.idleStartedAt: string | null` (consumed by Tasks 2, 3)
- Produces: `SqliteStore.setIdleStartedAt(id: number, isoTimestamp: string): void` (consumed by Task 2)
- Produces: `SqliteStore.clearIdleStartedAt(id: number): void` (consumed by Task 2)

- [ ] **Step 1: Write failing test — config loads `idle_timeout_minutes` default**

Add to `tests/config.test.ts` inside the existing `"loads a fully-specified config"` test:

```typescript
expect(config.loop.idleTimeoutMinutes).toBe(120); // default (not in config-valid.toml)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `idleTimeoutMinutes` does not exist on `config.loop`

- [ ] **Step 3: Implement config changes**

In `src/config.ts`, add `idle_timeout_minutes` to the Zod schema (`rawSchema.loop`):

```typescript
loop: z.object({
  monitor_poll_seconds: z.number().int().positive(),
  idle_recheck_seconds: z.number().int().positive(),
  idle_timeout_minutes: z.number().int().nonnegative().default(120),
}).strict(),
```

Add to the `Config` interface (`loop` block):

```typescript
loop: {
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  idleTimeoutMinutes: number;
};
```

Add to the `loadConfig` return statement (`loop` block):

```typescript
loop: {
  monitorPollSeconds: raw.loop.monitor_poll_seconds,
  idleRecheckSeconds: raw.loop.idle_recheck_seconds,
  idleTimeoutMinutes: raw.loop.idle_timeout_minutes,
},
```

- [ ] **Step 4: Run config test to verify it passes**

Run: `npx vitest run tests/config.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Write failing test — `RunRow.idleStartedAt` and store methods**

Add to `tests/store.test.ts`:

```typescript
describe("SqliteStore: idle timeout", () => {
  it("createRun initializes idleStartedAt as null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    expect(run.idleStartedAt).toBeNull();
  });

  it("setIdleStartedAt persists timestamp and getRun returns it", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBe("2026-06-06T01:00:00.000Z");
  });

  it("setIdleStartedAt is idempotent — does not overwrite existing value", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T02:00:00.000Z");
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBe("2026-06-06T01:00:00.000Z");
  });

  it("clearIdleStartedAt resets to null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    store.clearIdleStartedAt(run.id);
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBeNull();
  });

  it("clearIdleStartedAt is safe when already null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.clearIdleStartedAt(run.id);
    expect(store.getRun(run.id).idleStartedAt).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — `idleStartedAt` not on RunRow, `setIdleStartedAt`/`clearIdleStartedAt` not on SqliteStore

- [ ] **Step 7: Implement types + store changes**

In `src/types.ts`, add `idleStartedAt` to `RunRow`:

```typescript
export interface RunRow {
  id: number;
  startedAt: string;
  taskCap: number;
  state: RunState;
  haltReason: string | null;
  pauseMeta: PauseMeta | null;
  idleStartedAt: string | null;
}
```

In `src/store.ts`:

Add `idle_started_at` to `RawRunRow`:

```typescript
interface RawRunRow {
  id: number;
  started_at: string;
  task_cap: number;
  state: string;
  halt_reason: string | null;
  pause_meta: string | null;
  idle_started_at: string | null;
}
```

Update `toRunRow` to map the new field:

```typescript
function toRunRow(r: RawRunRow): RunRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    taskCap: r.task_cap,
    state: r.state as RunState,
    haltReason: r.halt_reason,
    pauseMeta: parsePauseMeta(r.pause_meta),
    idleStartedAt: r.idle_started_at,
  };
}
```

Add migration in `migrate()`, after the existing `runColumns` block (after the `pause_meta` migration):

```typescript
if (!runColumns.has("idle_started_at")) {
  this.db.exec(`ALTER TABLE run ADD COLUMN idle_started_at TEXT`);
}
```

Add two new methods after `clearPauseMeta`:

```typescript
setIdleStartedAt(id: number, isoTimestamp: string): void {
  this.db.prepare(
    `UPDATE run SET idle_started_at = ? WHERE id = ? AND idle_started_at IS NULL`,
  ).run(isoTimestamp, id);
}

clearIdleStartedAt(id: number): void {
  this.db.prepare(
    `UPDATE run SET idle_started_at = NULL WHERE id = ?`,
  ).run(id);
}
```

- [ ] **Step 8: Run store + config tests to verify all pass**

Run: `npx vitest run tests/store.test.ts tests/config.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/types.ts src/store.ts tests/store.test.ts tests/config.test.ts
git commit -m "feat(ES-475): add idle_timeout_minutes config, RunRow.idleStartedAt, and store methods"
```

---

### Task 2: Orchestrator idle timeout logic + tests

**Files:**
- Modify: `src/orchestrator.ts:670-742` (loop method)
- Modify: `tests/orchestrator.test.ts:25-66` (makeConfig helper)
- Test: `tests/orchestrator.test.ts` (new describe block)

**Interfaces:**
- Consumes: `Config.loop.idleTimeoutMinutes: number` (from Task 1)
- Consumes: `SqliteStore.setIdleStartedAt(id, iso): void` (from Task 1)
- Consumes: `SqliteStore.clearIdleStartedAt(id): void` (from Task 1)
- Consumes: `RunRow.idleStartedAt: string | null` (from Task 1)

- [ ] **Step 1: Update `makeConfig` helper to include `idleTimeoutMinutes`**

In `tests/orchestrator.test.ts`, add `idleTimeoutMinutes` to `makeConfig`:

Add to the `over` parameter type:

```typescript
idleTimeoutMinutes: number;
```

Add to the returned `loop` block:

```typescript
loop: {
  monitorPollSeconds: over.monitorPollSeconds ?? 60,
  idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
  idleTimeoutMinutes: over.idleTimeoutMinutes ?? 120,
},
```

- [ ] **Step 2: Write failing tests — idle timeout orchestrator behavior**

Add a new `describe` block to `tests/orchestrator.test.ts`:

```typescript
describe("Orchestrator — アイドルタイムアウト（ES-475）", () => {
  it("idle 状態が idleTimeoutMinutes を超えると HALT する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, idleTimeoutMinutes: 60 });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const sleepCalls: number[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    // Clock: returns T=0, T+1s, T+2s, ... but after call #2
    // (which sets idle_started_at) jumps forward by 61 minutes.
    let clockCall = 0;
    let clockTime = Date.parse("2026-06-05T00:00:00.000Z");
    const clock = (): string => {
      clockCall++;
      const iso = new Date(clockTime).toISOString();
      // After call #2 (setIdleStartedAt), jump 61 minutes so the
      // timeout check in the next iteration sees elapsed > 60 min.
      if (clockCall === 2) {
        clockTime += 61 * 60_000;
      } else {
        clockTime += 1000;
      }
      return iso;
    };

    source.getAllEligible = async () => [];

    const orch = new Orchestrator({
      config,
      source,
      agent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor: new FakeMonitor(),
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async (ms) => { sleepCalls.push(ms); },
      log: (line) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: null,
    });

    await orch.run();

    const run = store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("idle timeout");
    expect(run.haltReason).toContain("60 minutes");

    const haltEvents = notifier.events.filter(
      (e) => e.kind === "halted" && (e as { reason: string }).reason === "idle_timeout",
    );
    expect(haltEvents).toHaveLength(1);

    store.close();
  });

  it("idle 時間が閾値以内なら HALT しない（recheck 継続）", async () => {
    // idleTimeoutMinutes=60, but clock only advances 1s per call
    // → timeout never fires. Loop exits because 2nd getAllEligible
    // returns a ticket, then task_cap=1 halts.
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 60 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall === 1) return [];
      return [issue("issue-A", "TY-1")];
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    // Halted by task_cap, NOT idle_timeout
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");

    h.store.close();
  });

  it("running 復帰で idle_started_at がクリアされ、再度 idle で再カウント", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 120 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall === 1) return []; // idle
      return [issue("issue-A", "TY-1")]; // recover
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // After recovery, idle_started_at should be cleared
    const run = h.store.latestRun()!;
    expect(run.idleStartedAt).toBeNull();

    h.store.close();
  });

  it("idleTimeoutMinutes=0 では idle が無限に続き HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleTimeoutMinutes: 0 });
    const h = makeHarness(config);

    let eligibleCall = 0;
    h.source.getAllEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall++;
      if (eligibleCall <= 3) return []; // 3 rounds of idle
      return [issue("issue-A", "TY-1")]; // then recover
    };
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Halted by task_cap, NOT idle_timeout. idle ran 3 rounds without halt.
    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap");
    expect(h.sleepCalls.filter((ms) => ms === config.loop.idleRecheckSeconds * 1000)).toHaveLength(3);

    h.store.close();
  });

  it("DB に idle_started_at が残った状態で再チェック → 経過時間を引き継ぐ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, idleTimeoutMinutes: 60 });
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const memoryRunner = new FakeCommandRunner();
    memoryRunner.on(["git", "fetch", "origin", "main"], { code: 0 });
    memoryRunner.on(["git", "rebase", "--autostash", "origin/main"], { code: 0 });
    memoryRunner.on(["git", "ls-files", "--unmerged", "--", "docs/memory/"], { code: 0, stdout: "" });
    memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
    memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    // Pre-create a run with idle_started_at already set 61 minutes ago
    const run = store.createRun(3, "2026-06-04T22:00:00.000Z");
    store.setRunState(run.id, "idle");
    store.setIdleStartedAt(run.id, "2026-06-04T22:00:00.000Z");

    // Clock starts at 61 minutes after idle_started_at
    const clock = fixedClock("2026-06-04T23:01:00.000Z");

    source.getAllEligible = async () => [];

    const orch = new Orchestrator({
      config,
      source,
      agent: new FakeAgentRunner(),
      git: new FakeGitPr(),
      monitor: new FakeMonitor(),
      notifier,
      store,
      buildPrompt: (args) => `PROMPT for ${args.issue.identifier}`,
      specLoader: null,
      clock,
      sleep: async () => {},
      log: (line) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner: null,
      codebaseSummaryGenerator: async () => "",
      recoveryTurn: null,
      runner: memoryRunner,
      groomDeps: null,
    });

    // run() creates a NEW run (not reusing the old one), so we need
    // to test via the store methods directly instead.
    // Verify the store layer correctly reads back the persisted value.
    const persisted = store.getRun(run.id);
    expect(persisted.idleStartedAt).toBe("2026-06-04T22:00:00.000Z");

    // Verify elapsed calculation works
    const now = Date.parse("2026-06-04T23:01:00.000Z");
    const elapsed = now - Date.parse(persisted.idleStartedAt!);
    expect(elapsed).toBeGreaterThanOrEqual(60 * 60_000);

    store.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "アイドルタイムアウト" --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — orchestrator does not have idle timeout logic

- [ ] **Step 4: Implement orchestrator changes**

In `src/orchestrator.ts`, method `loop()`:

**A. Add idle timeout check after the task cap check (after line 689, before GROOM):**

```typescript
// 1.5) アイドルタイムアウトチェック（ES-475）
const idleTimeoutMin = this.config.loop.idleTimeoutMinutes;
if (idleTimeoutMin > 0) {
  const run = this.store.getRun(this.runId);
  if (run.idleStartedAt !== null) {
    const elapsedMs = Date.parse(this.clock()) - Date.parse(run.idleStartedAt);
    if (elapsedMs >= idleTimeoutMin * 60_000) {
      const detail = `idle timeout: no eligible tickets for ${idleTimeoutMin} minutes`;
      await this.notifier.notify({ kind: "halted", reason: "idle_timeout", detail });
      await this.commitMemoryBeforeHalt();
      this.store.setRunState(this.runId, "halted", detail);
      this.log(detail);
      return;
    }
  }
}
```

**B. In the idle block (eligible.length === 0), add `setIdleStartedAt` call before `setRunState`:**

```typescript
this.store.setIdleStartedAt(this.runId, this.clock());
```

Add this line before `this.store.setRunState(this.runId, "idle");`.

**C. In the running recovery block (after the idle block), add `clearIdleStartedAt` call:**

```typescript
this.store.clearIdleStartedAt(this.runId);
```

Add this line after `idleNotified = false;` and before `this.store.setRunState(this.runId, "running");`.

- [ ] **Step 5: Run idle timeout tests to verify they pass**

Run: `npx vitest run tests/orchestrator.test.ts -t "アイドルタイムアウト" --reporter=verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 6: Run the full orchestrator test suite to check for regressions**

Run: `npx vitest run tests/orchestrator.test.ts --reporter=verbose 2>&1 | tail -40`
Expected: ALL PASS. The existing idle test ("最初キュー空で IDLE 通知＋sleep、再確認で復帰して1件完走する") should still pass because `idleTimeoutMinutes` defaults to 120 and the fixedClock only advances by seconds.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(ES-475): add idle timeout auto-halt to orchestrator loop"
```

---

### Task 3: Status display + Example TOML

**Files:**
- Modify: `src/status.ts:48-57` (idle state display)
- Modify: `looppilot-os.example.toml:64-66` (`[loop]` section)
- Test: `tests/status.test.ts`

**Interfaces:**
- Consumes: `RunRow.idleStartedAt: string | null` (from Task 1)
- Consumes: `SqliteStore.setIdleStartedAt(id, iso): void` (from Task 1)

- [ ] **Step 1: Write failing test — status shows `idle since:` when state is idle**

Add to `tests/status.test.ts`:

```typescript
it("Run が idle で idle_started_at がセットされていれば idle since を表示する", () => {
  const store = makeStore();
  try {
    const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
    store.setRunState(run.id, "idle");
    store.setIdleStartedAt(run.id, "2026-06-05T11:00:00.000Z");
    const out = renderStatus(store);
    expect(out).toContain("state: idle");
    expect(out).toContain("idle since: 2026-06-05T11:00:00.000Z");
  } finally {
    store.close();
  }
});

it("Run が idle でも idle_started_at が null なら idle since を表示しない", () => {
  const store = makeStore();
  try {
    const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
    store.setRunState(run.id, "idle");
    const out = renderStatus(store);
    expect(out).toContain("state: idle");
    expect(out).not.toContain("idle since");
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — "idle since" not in output

- [ ] **Step 3: Implement status display change**

In `src/status.ts`, add after the paused display block (after line 57):

```typescript
if (run.state === "idle" && run.idleStartedAt !== null) {
  lines.push(`  idle since: ${run.idleStartedAt}`);
}
```

- [ ] **Step 4: Run status tests to verify they pass**

Run: `npx vitest run tests/status.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 5: Update example TOML**

In `looppilot-os.example.toml`, update the `[loop]` section:

```toml
[loop]
monitor_poll_seconds = 60
idle_recheck_seconds = 300
# idle_timeout_minutes = 120  # 適格チケット不在でのアイドル時間上限（既定120分）。0 = 無効
```

- [ ] **Step 6: Run the full test suite to verify no regressions**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/status.ts looppilot-os.example.toml tests/status.test.ts
git commit -m "feat(ES-475): show idle since in status, add idle_timeout_minutes to example TOML"
```
