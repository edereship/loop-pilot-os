# ES-407: Run.state paused + status CLI + 通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the infrastructure for rate-limit pause visibility — the `paused` Run state, its DB persistence, status CLI display, and notification events — so that R1-claude (ES-383) and R1-codex (ES-408) can use this foundation to report their pause/resume transitions.

**Architecture:** Add `"paused"` to the `RunState` union and a `PauseMeta` interface (reason, target, timestamps). Store metadata as a single JSON TEXT column (`pause_meta`) on the `run` table, exposed via `setPauseMeta` / `clearPauseMeta` on `SqliteStore`. Extend `NotifyEvent` with `paused` and `resumed` kinds (coexisting with existing `quota_waiting` / `quota_resumed`). Extend `renderStatus` and `formatNotifyEvent` for the new states. Add an `interruptableSleep` helper on the orchestrator that R1-claude/R1-codex will call when entering pause state.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest

## Global Constraints

- `npm run check` must pass (tsc + vitest)
- TDD: write failing test first, then implement
- Existing `quota_waiting` / `quota_resumed` events stay unchanged — new events coexist
- Detection/classification of rate limits is OUT OF SCOPE (ES-383 / ES-408)
- SQLite CHECK constraints: cannot be modified in-place; new DBs get the expanded constraint, old DBs rely on migration adding the column (CHECK on existing columns remains unchanged and we accept the risk since only our code writes this column)

---

### Task 1: Types — `PauseMeta`, `RunState`, `RunRow`, `NotifyEvent`

**Files:**
- Modify: `src/types.ts:4` (RunState), `src/types.ts:31-37` (RunRow), `src/types.ts:130-137` (NotifyEvent)
- Test: `tests/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PauseTarget` type: `"claude" | "codex"`
  - `PauseMeta` interface: `{ reason: "rate_limit"; target: PauseTarget; pausedAt: string; nextReprobeAt: string; capDeadlineAt: string }`
  - `RunState` extended with `"paused"`
  - `RunRow.pauseMeta: PauseMeta | null`
  - `NotifyEvent` extended with `{ kind: "paused"; target: PauseTarget; detail: string }` and `{ kind: "resumed"; target: PauseTarget; detail: string }`

- [ ] **Step 1: Write the failing test**

In `tests/types.test.ts`, add compile-time assignability checks:

```typescript
import { describe, it, expect } from "vitest";
import type { RunState, PauseMeta, PauseTarget, RunRow, NotifyEvent } from "../src/types.js";

describe("PauseMeta / RunState / NotifyEvent type extensions", () => {
  it("PauseMeta round-trips correctly", () => {
    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };
    expect(meta.reason).toBe("rate_limit");
    expect(meta.target).toBe("claude");
  });

  it("RunState accepts 'paused'", () => {
    const state: RunState = "paused";
    expect(state).toBe("paused");
  });

  it("RunRow includes pauseMeta", () => {
    const row: RunRow = {
      id: 1,
      startedAt: "2026-06-21T00:00:00.000Z",
      taskCap: 5,
      state: "paused",
      haltReason: null,
      pauseMeta: {
        reason: "rate_limit",
        target: "codex",
        pausedAt: "2026-06-21T00:00:00.000Z",
        nextReprobeAt: "2026-06-21T00:10:00.000Z",
        capDeadlineAt: "2026-06-21T01:00:00.000Z",
      },
    };
    expect(row.pauseMeta?.target).toBe("codex");
  });

  it("NotifyEvent accepts paused and resumed kinds", () => {
    const paused: NotifyEvent = {
      kind: "paused",
      target: "claude",
      detail: "rate limited for 1h",
    };
    const resumed: NotifyEvent = {
      kind: "resumed",
      target: "claude",
      detail: "rate limit cleared",
    };
    expect(paused.kind).toBe("paused");
    expect(resumed.kind).toBe("resumed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — `PauseMeta`, `PauseTarget` not exported; `RunState` does not include `"paused"`; `RunRow` has no `pauseMeta`.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, apply these changes:

1. After line 3 (after `SessionState`), before `RunState`:

```typescript
export type PauseTarget = "claude" | "codex";
export interface PauseMeta {
  reason: "rate_limit";
  target: PauseTarget;
  pausedAt: string;        // ISO-8601 UTC
  nextReprobeAt: string;   // ISO-8601 UTC
  capDeadlineAt: string;   // ISO-8601 UTC
}
```

2. Line 4 — change `RunState`:

```typescript
export type RunState = "running" | "idle" | "halted" | "paused";
```

3. In the `RunRow` interface (after `haltReason`), add:

```typescript
  pauseMeta: PauseMeta | null;
```

4. In `NotifyEvent` (after the `quota_resumed` line), add:

```typescript
  | { kind: "paused"; target: PauseTarget; detail: string }
  | { kind: "resumed"; target: PauseTarget; detail: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add PauseMeta, RunState 'paused', and paused/resumed NotifyEvent (ES-407)"
```

---

### Task 2: Store — schema, migration, `setPauseMeta` / `clearPauseMeta`

**Files:**
- Modify: `src/store.ts:11-58` (SCHEMA), `src/store.ts:60-76` (RawRunRow/toRunRow), `src/store.ts:173-204` (migrate), `src/store.ts:238-245` (setRunState)
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `PauseMeta` from `src/types.ts`
- Produces:
  - `SqliteStore.setPauseMeta(runId: number, meta: PauseMeta): void` — writes `pause_meta` JSON + sets `state = 'paused'`
  - `SqliteStore.clearPauseMeta(runId: number): void` — sets `pause_meta = NULL` + sets `state = 'running'`
  - Schema: `pause_meta TEXT` column on `run` table
  - `RunRow.pauseMeta` returned from all run queries (JSON.parse or null)

- [ ] **Step 1: Write failing tests**

Add to `tests/store.test.ts` inside the existing `describe("SqliteStore: run", ...)` block:

```typescript
  it("setPauseMeta transitions to paused and persists PauseMeta as JSON", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    expect(run.pauseMeta).toBeNull();

    const meta = {
      reason: "rate_limit" as const,
      target: "claude" as const,
      pausedAt: "2026-06-06T01:00:00.000Z",
      nextReprobeAt: "2026-06-06T01:10:00.000Z",
      capDeadlineAt: "2026-06-06T02:00:00.000Z",
    };
    store.setPauseMeta(run.id, meta);

    const updated = store.getRun(run.id);
    expect(updated.state).toBe("paused");
    expect(updated.pauseMeta).toEqual(meta);
    expect(updated.haltReason).toBeNull();
  });

  it("clearPauseMeta transitions back to running and clears pause_meta", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setPauseMeta(run.id, {
      reason: "rate_limit",
      target: "codex",
      pausedAt: "2026-06-06T01:00:00.000Z",
      nextReprobeAt: "2026-06-06T01:10:00.000Z",
      capDeadlineAt: "2026-06-06T02:00:00.000Z",
    });
    expect(store.getRun(run.id).state).toBe("paused");

    store.clearPauseMeta(run.id);
    const cleared = store.getRun(run.id);
    expect(cleared.state).toBe("running");
    expect(cleared.pauseMeta).toBeNull();
  });

  it("setPauseMeta and clearPauseMeta throw for nonexistent run id", () => {
    const store = newStore();
    expect(() =>
      store.setPauseMeta(999, {
        reason: "rate_limit",
        target: "claude",
        pausedAt: "2026-06-06T01:00:00.000Z",
        nextReprobeAt: "2026-06-06T01:10:00.000Z",
        capDeadlineAt: "2026-06-06T02:00:00.000Z",
      }),
    ).toThrow();
    expect(() => store.clearPauseMeta(999)).toThrow();
  });
```

Add a migration test in a new `describe` block:

```typescript
describe("SqliteStore: migration adds pause_meta column to existing run table", () => {
  it("opens a legacy DB without pause_meta and auto-adds the column", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lpos-mig-"));
    const dbPath = path.join(dir, "test.db");
    try {
      // Create a DB with old schema (no pause_meta on run)
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          task_cap INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running','idle','halted')),
          halt_reason TEXT
        );
        CREATE TABLE task_session (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES run(id),
          linear_issue_id TEXT NOT NULL,
          linear_identifier TEXT NOT NULL,
          issue_title TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          pr_number INTEGER,
          state TEXT NOT NULL CHECK (state IN
            ('claimed','implementing','handing_off','in_review','merged','stopped')),
          cost_usd REAL,
          failure_reason TEXT,
          stop_detail TEXT,
          agent_summary TEXT,
          plan_brief TEXT,
          started_at TEXT NOT NULL,
          monitor_started_at TEXT,
          ended_at TEXT,
          workflow_fix_attempts INTEGER NOT NULL DEFAULT 0,
          workflow_handled_error_count INTEGER NOT NULL DEFAULT 0,
          auto_restart_attempts INTEGER NOT NULL DEFAULT 0,
          pending_restart_reason TEXT
        );
        INSERT INTO run (started_at, task_cap, state) VALUES ('2026-01-01T00:00:00Z', 5, 'running');
      `);
      raw.close();

      // Re-open via SqliteStore — migration should add pause_meta
      const store = new SqliteStore(dbPath);
      openStores.push(store);
      const run = store.getRun(1);
      expect(run.pauseMeta).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `setPauseMeta` / `clearPauseMeta` not defined; `pauseMeta` not on `RunRow`.

- [ ] **Step 3: Write minimal implementation**

In `src/store.ts`:

1. Add `PauseMeta` to imports:

```typescript
import type {
  RunRow,
  RunState,
  SessionState,
  FailureReason,
  TaskSessionRow,
  PauseMeta,
} from "./types.js";
```

2. Update SCHEMA — add `pause_meta TEXT` to the `run` table definition (after `halt_reason TEXT`):

```sql
  pause_meta TEXT
```

3. Update `RawRunRow` — add:

```typescript
  pause_meta: string | null;
```

4. Update `toRunRow` — add parsing:

```typescript
    pauseMeta: r.pause_meta === null ? null : JSON.parse(r.pause_meta) as PauseMeta,
```

5. In `migrate()`, add column detection for run table (after existing task_session migrations):

```typescript
    const runColumns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(run)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!runColumns.has("pause_meta")) {
      this.db.exec(`ALTER TABLE run ADD COLUMN pause_meta TEXT`);
    }
```

6. Add `setPauseMeta` method (after `setRunState`):

```typescript
  setPauseMeta(id: number, meta: PauseMeta): void {
    const info = this.db
      .prepare(`UPDATE run SET state = 'paused', pause_meta = ? WHERE id = ?`)
      .run(JSON.stringify(meta), id);
    if (info.changes !== 1) {
      throw new Error(`setPauseMeta affected ${info.changes} rows for run id=${id}`);
    }
  }

  clearPauseMeta(id: number): void {
    const info = this.db
      .prepare(`UPDATE run SET state = 'running', pause_meta = NULL WHERE id = ?`)
      .run(id);
    if (info.changes !== 1) {
      throw new Error(`clearPauseMeta affected ${info.changes} rows for run id=${id}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 5: Run full type check**

Run: `npx tsc --noEmit`
Expected: PASS (or errors related to other files expecting `pauseMeta` on `RunRow` — fix those in this step)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store.ts tests/store.test.ts
git commit -m "feat(store): add pause_meta column, setPauseMeta/clearPauseMeta methods (ES-407)"
```

---

### Task 3: Notifier — `formatNotifyEvent` for `paused` / `resumed`

**Files:**
- Modify: `src/notifier.ts:13-30` (formatNotifyEvent switch)
- Test: `tests/notifier.test.ts`

**Interfaces:**
- Consumes: `NotifyEvent` with new `paused` / `resumed` kinds from `src/types.ts`
- Produces: `formatNotifyEvent` handles all NotifyEvent kinds including new ones

- [ ] **Step 1: Write failing tests**

Add to `tests/notifier.test.ts` inside the existing `describe("formatNotifyEvent", ...)` block:

```typescript
  it("formats paused with pause emoji, target and detail", () => {
    const text = formatNotifyEvent({
      kind: "paused",
      target: "claude",
      detail: "rate limited until 02:00 UTC",
    });
    expect(text).toBe("⏸️ LoopPilot OS 一時停止 (claude): rate limited until 02:00 UTC");
  });

  it("formats resumed with play emoji, target and detail", () => {
    const text = formatNotifyEvent({
      kind: "resumed",
      target: "codex",
      detail: "rate limit cleared",
    });
    expect(text).toBe("▶️ LoopPilot OS 再開 (codex): rate limit cleared");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notifier.test.ts`
Expected: FAIL — `formatNotifyEvent` does not handle `paused` / `resumed` kinds (TypeScript exhaustive switch will error at compile time; at runtime, it would fall through).

- [ ] **Step 3: Write minimal implementation**

In `src/notifier.ts`, add two cases to the `formatNotifyEvent` switch (before the closing `}`):

```typescript
    case "paused":
      return `⏸️ LoopPilot OS 一時停止 (${event.target}): ${event.detail}`;
    case "resumed":
      return `▶️ LoopPilot OS 再開 (${event.target}): ${event.detail}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/notifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat(notifier): format paused/resumed events with emoji and target (ES-407)"
```

---

### Task 4: Status CLI — display `paused` state with metadata

**Files:**
- Modify: `src/status.ts:48-50` (halted display block)
- Test: `tests/status.test.ts`

**Interfaces:**
- Consumes: `RunRow.pauseMeta` (PauseMeta | null), `RunRow.state` includes `"paused"`
- Produces: `renderStatus` shows paused details (reason, target, next re-probe, cap deadline)

- [ ] **Step 1: Write failing test**

Add to `tests/status.test.ts` inside the existing `describe("renderStatus", ...)` block:

```typescript
  it("Run が paused のときは pause 理由・対象・次 re-probe・cap 期限を表示する", () => {
    const store = makeStore();
    try {
      const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
      store.setPauseMeta(run.id, {
        reason: "rate_limit",
        target: "claude",
        pausedAt: "2026-06-05T11:00:00.000Z",
        nextReprobeAt: "2026-06-05T11:10:00.000Z",
        capDeadlineAt: "2026-06-05T12:00:00.000Z",
      });
      const out = renderStatus(store);
      expect(out).toContain("state: paused");
      expect(out).toContain("pause reason: rate_limit");
      expect(out).toContain("pause target: claude");
      expect(out).toContain("next re-probe: 2026-06-05T11:10:00.000Z");
      expect(out).toContain("cap deadline: 2026-06-05T12:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("Run が paused でも pauseMeta が null なら paused のみ表示する", () => {
    const store = makeStore();
    try {
      const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
      store.setRunState(run.id, "paused");
      const out = renderStatus(store);
      expect(out).toContain("state: paused");
      expect(out).not.toContain("pause reason");
    } finally {
      store.close();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL — `renderStatus` does not handle `paused` state or display metadata.

- [ ] **Step 3: Write minimal implementation**

In `src/status.ts`, add `PauseMeta` to the import and extend the halted block:

1. Update import:

```typescript
import type { TaskSessionRow, PauseMeta } from "./types.js";
```

2. After the existing halted block (line 49-50), add the paused block:

```typescript
  if (run.state === "paused" && run.pauseMeta !== null) {
    const pm = run.pauseMeta;
    lines.push(`  pause reason: ${pm.reason}`);
    lines.push(`  pause target: ${pm.target}`);
    lines.push(`  next re-probe: ${pm.nextReprobeAt}`);
    lines.push(`  cap deadline: ${pm.capDeadlineAt}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status.ts tests/status.test.ts
git commit -m "feat(status): display paused state with PauseMeta details (ES-407)"
```

---

### Task 5: Orchestrator — `interruptablePause` helper for safe-point-aware waiting

**Files:**
- Modify: `src/orchestrator.ts` (add public helper method)
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `SqliteStore.setPauseMeta`, `SqliteStore.clearPauseMeta`, `Notifier.notify` with `paused` / `resumed` events, `PauseMeta` from `src/types.ts`
- Produces:
  - `Orchestrator.interruptablePause(meta: PauseMeta, waitMs: number, chunkMs?: number): Promise<RunControl>` — sets Run to paused, notifies once, sleeps in chunks with SIGINT check, on resume clears pause and notifies. Returns `HALT` if interrupted, `CONTINUE` if wait completed.

- [ ] **Step 1: Write failing tests**

Add a new `describe` block in `tests/orchestrator.test.ts`. Use the existing `makeHarness` helper. Since `interruptablePause` requires `runId` to be set (normally set by `run()`), set it via `(orch as any).runId`.

Add `PauseMeta` to the imports at the top of the file:

```typescript
import type { EligibleIssue, PromptArgs, PlanRunner, PauseMeta } from "../src/types.js";
```

Then add the test block:

```typescript
describe("Orchestrator.interruptablePause", () => {
  it("sets paused state, notifies once, sleeps in chunks, then resumes with notification", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const run = h.store.createRun(5, "2026-06-21T00:00:00.000Z");
    (h.orch as any).runId = run.id;

    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };

    const result = await h.orch.interruptablePause(meta, 30_000, 10_000);

    expect(result.control).toBe("continue");

    const updated = h.store.getRun(run.id);
    expect(updated.state).toBe("running");
    expect(updated.pauseMeta).toBeNull();

    const pausedEvents = h.notifier.events.filter((e) => e.kind === "paused");
    const resumedEvents = h.notifier.events.filter((e) => e.kind === "resumed");
    expect(pausedEvents).toHaveLength(1);
    expect(resumedEvents).toHaveLength(1);
    expect(pausedEvents[0]).toEqual({
      kind: "paused",
      target: "claude",
      detail: expect.stringContaining("rate_limit"),
    });

    // 30s / 10s chunks = 3 sleep calls
    expect(h.sleepCalls).toEqual([10_000, 10_000, 10_000]);

    h.store.close();
  });

  it("returns HALT and does not notify 'resumed' when interrupted during pause", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const run = h.store.createRun(5, "2026-06-21T00:00:00.000Z");
    (h.orch as any).runId = run.id;

    h.orch.requestStop();

    const meta: PauseMeta = {
      reason: "rate_limit",
      target: "codex",
      pausedAt: "2026-06-21T00:00:00.000Z",
      nextReprobeAt: "2026-06-21T00:10:00.000Z",
      capDeadlineAt: "2026-06-21T01:00:00.000Z",
    };

    const result = await h.orch.interruptablePause(meta, 60_000, 10_000);

    expect(result.control).toBe("halt");

    const pausedEvents = h.notifier.events.filter((e) => e.kind === "paused");
    expect(pausedEvents).toHaveLength(1);

    const resumedEvents = h.notifier.events.filter((e) => e.kind === "resumed");
    expect(resumedEvents).toHaveLength(0);

    expect(h.store.getRun(run.id).state).toBe("halted");

    // Sleep was never called (interrupted before first chunk)
    expect(h.sleepCalls).toHaveLength(0);

    h.store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "interruptablePause"`
Expected: FAIL — `interruptablePause` does not exist on Orchestrator.

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator.ts`:

1. Add `PauseMeta` to the type imports:

```typescript
import type {
  // ... existing imports ...
  PauseMeta,
} from "./types.js";
```

2. Add the public method to `Orchestrator` class (after `requestStop()`):

```typescript
  async interruptablePause(
    meta: PauseMeta,
    waitMs: number,
    chunkMs: number = 10_000,
  ): Promise<RunControl> {
    this.store.setPauseMeta(this.runId, meta);
    await this.notifier.notify({
      kind: "paused",
      target: meta.target,
      detail: `${meta.reason}: waiting until ${meta.capDeadlineAt}`,
    });

    for (let elapsed = 0; elapsed < waitMs; elapsed += chunkMs) {
      if (this.interrupted) {
        await this.haltForInterrupt();
        return HALT;
      }
      await this.sleep(chunkMs);
    }
    if (this.interrupted) {
      await this.haltForInterrupt();
      return HALT;
    }

    this.store.clearPauseMeta(this.runId);
    await this.notifier.notify({
      kind: "resumed",
      target: meta.target,
      detail: `${meta.reason}: resumed after ${waitMs / 1000}s wait`,
    });
    return CONTINUE;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator.test.ts -t "interruptablePause"`
Expected: PASS

- [ ] **Step 5: Run full check**

Run: `npm run check`
Expected: PASS — tsc + all vitest tests green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(orchestrator): add interruptablePause for safe-point-aware rate-limit waiting (ES-407)"
```

---

### Task 6: Final verification and integration consistency

**Files:**
- None created; validation only

**Interfaces:**
- Consumes: all prior tasks
- Produces: green `npm run check`

- [ ] **Step 1: Run full check suite**

Run: `npm run check`
Expected: All type checks and tests pass.

- [ ] **Step 2: Verify no regressions in existing tests**

Run: `npx vitest run tests/orchestrator.test.ts tests/store.test.ts tests/notifier.test.ts tests/status.test.ts`
Expected: All existing tests still pass alongside new tests.

- [ ] **Step 3: Final commit (if any fixups needed)**

Only if Step 1 or 2 revealed issues that needed fixing.
