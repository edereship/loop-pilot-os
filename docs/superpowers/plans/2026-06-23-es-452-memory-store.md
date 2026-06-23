# ES-452: Memory Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement cross-task memory storage layer (B2) so the PM can accumulate and reference knowledge across tasks via `docs/memory/` files.

**Architecture:** Pure-function module `src/memory-store.ts` handles filesystem I/O for three memory category files. A new `SqliteStore` method provides bootstrap data. The orchestrator commits memory files to git before halting. All git operations use the existing `CommandRunner` abstraction.

**Tech Stack:** Node.js `fs` (sync), `CommandRunner` for git, Vitest for tests, `better-sqlite3` via `SqliteStore`.

## Global Constraints

- `npm run check` must pass (typecheck + vitest) after each task
- Memory category files live at `docs/memory/{pm-decisions,impl-results,product-knowledge}.md`
- `MemoryCategory` type from `src/types.ts`: `"pm_decisions" | "impl_results" | "product_knowledge"`
- Size limit: `config.memory.maxCharsPerFile` (default 8000)
- Bootstrap count: `config.digest.recentMergedCount` (existing config)
- Git commits target `config.repo.path` (main repo), not a worktree

---

### Task 1: MemoryStore — readCategory / writeCategory / readAll

**Files:**
- Create: `src/memory-store.ts`
- Create: `tests/memory-store.test.ts`

**Interfaces:**
- Consumes: `MemoryCategory` from `src/types.ts`
- Produces:
  - `MEMORY_DIR` constant (`"docs/memory"`)
  - `CATEGORY_FILES` mapping (`Record<MemoryCategory, string>`)
  - `readCategory(repoPath: string, category: MemoryCategory): string | null`
  - `writeCategory(repoPath: string, category: MemoryCategory, content: string, maxChars: number): void`
  - `readAll(repoPath: string): { pmDecisions: string | null; implResults: string | null; productKnowledge: string | null }`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readCategory,
  writeCategory,
  readAll,
  MEMORY_DIR,
  CATEGORY_FILES,
} from "../src/memory-store.js";

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), "mem-test-"));
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("readCategory", () => {
  it("returns null when file does not exist", () => {
    expect(readCategory(tmpRepo, "pm_decisions")).toBeNull();
  });

  it("reads existing file content", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "# PM Decisions\n\nSome content");
    expect(readCategory(tmpRepo, "pm_decisions")).toBe("# PM Decisions\n\nSome content");
  });
});

describe("writeCategory", () => {
  it("writes content to the category file", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeCategory(tmpRepo, "impl_results", "result data", 8000);
    expect(readCategory(tmpRepo, "impl_results")).toBe("result data");
  });

  it("throws when content exceeds maxChars", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const huge = "x".repeat(101);
    expect(() => writeCategory(tmpRepo, "pm_decisions", huge, 100)).toThrow(
      /exceeds.*100/,
    );
  });

  it("allows content exactly at the limit", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const exact = "x".repeat(100);
    writeCategory(tmpRepo, "pm_decisions", exact, 100);
    expect(readCategory(tmpRepo, "pm_decisions")).toBe(exact);
  });
});

describe("readAll", () => {
  it("returns all nulls when no files exist", () => {
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: null,
      implResults: null,
      productKnowledge: null,
    });
  });

  it("reads all existing files", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "decisions");
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "results");
    writeFileSync(path.join(dir, CATEGORY_FILES.product_knowledge), "knowledge");
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: "decisions",
      implResults: "results",
      productKnowledge: "knowledge",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: FAIL — `Cannot find module '../src/memory-store.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/memory-store.ts
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MemoryCategory } from "./types.js";

export const MEMORY_DIR = "docs/memory";

export const CATEGORY_FILES: Record<MemoryCategory, string> = {
  pm_decisions: "pm-decisions.md",
  impl_results: "impl-results.md",
  product_knowledge: "product-knowledge.md",
};

export function readCategory(
  repoPath: string,
  category: MemoryCategory,
): string | null {
  const filePath = path.join(repoPath, MEMORY_DIR, CATEGORY_FILES[category]);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function writeCategory(
  repoPath: string,
  category: MemoryCategory,
  content: string,
  maxChars: number,
): void {
  if (content.length > maxChars) {
    throw new Error(
      `Memory content for ${category} (${content.length} chars) exceeds limit of ${maxChars}`,
    );
  }
  const filePath = path.join(repoPath, MEMORY_DIR, CATEGORY_FILES[category]);
  writeFileSync(filePath, content, "utf-8");
}

export function readAll(repoPath: string): {
  pmDecisions: string | null;
  implResults: string | null;
  productKnowledge: string | null;
} {
  return {
    pmDecisions: readCategory(repoPath, "pm_decisions"),
    implResults: readCategory(repoPath, "impl_results"),
    productKnowledge: readCategory(repoPath, "product_knowledge"),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory-store.ts tests/memory-store.test.ts
git commit -m "feat(ES-452): add readCategory / writeCategory / readAll"
```

---

### Task 2: MemoryStore — initialize with bootstrap

**Files:**
- Modify: `src/store.ts` (add `recentSessionSummaries` method)
- Modify: `src/memory-store.ts` (add `initialize` function)
- Modify: `tests/memory-store.test.ts` (add initialize tests)
- Modify: `tests/store.test.ts` (add recentSessionSummaries test)

**Interfaces:**
- Consumes:
  - `SqliteStore` from `src/store.ts`
  - `MEMORY_DIR`, `CATEGORY_FILES` from Task 1
- Produces:
  - `SqliteStore.recentSessionSummaries(n: number): Array<{ linearIdentifier: string; issueTitle: string; state: "merged" | "stopped"; costUsd: number | null }>`
  - `initialize(repoPath: string, store: SqliteStore, recentCount: number): void`

- [ ] **Step 1: Write the failing test for recentSessionSummaries**

Append to `tests/store.test.ts`:

```typescript
describe("recentSessionSummaries", () => {
  it("returns merged and stopped sessions ordered by ended_at DESC", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(clock(), 10).id;

    // Create 3 sessions: merged, stopped, implementing (active)
    const s1 = seedSession(store, runId, clock(), { linearIdentifier: "ES-1", issueTitle: "Task 1" });
    store.updateSession(s1.id, { state: "merged", costUsd: 1.5, endedAt: clock() });

    const s2 = seedSession(store, runId, clock(), { linearIdentifier: "ES-2", issueTitle: "Task 2" });
    store.updateSession(s2.id, { state: "stopped", costUsd: 0.8, failureReason: "exception", endedAt: clock() });

    const s3 = seedSession(store, runId, clock(), { linearIdentifier: "ES-3", issueTitle: "Task 3" });
    store.updateSession(s3.id, { state: "implementing" });

    const result = store.recentSessionSummaries(10);
    expect(result).toHaveLength(2);
    // Most recent first (s2 ended after s1)
    expect(result[0]).toEqual({ linearIdentifier: "ES-2", issueTitle: "Task 2", state: "stopped", costUsd: 0.8 });
    expect(result[1]).toEqual({ linearIdentifier: "ES-1", issueTitle: "Task 1", state: "merged", costUsd: 1.5 });
  });

  it("respects the limit", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(clock(), 10).id;
    for (let i = 0; i < 5; i++) {
      const s = seedSession(store, runId, clock(), { linearIdentifier: `ES-${i}` });
      store.updateSession(s.id, { state: "merged", costUsd: i * 0.5, endedAt: clock() });
    }
    expect(store.recentSessionSummaries(3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts -t "recentSessionSummaries"`
Expected: FAIL — `store.recentSessionSummaries is not a function`

- [ ] **Step 3: Implement recentSessionSummaries in SqliteStore**

Add to `src/store.ts` after the `recentMergedSummaries` method (~line 607):

```typescript
recentSessionSummaries(
  n: number,
): Array<{
  linearIdentifier: string;
  issueTitle: string;
  state: "merged" | "stopped";
  costUsd: number | null;
}> {
  const rows = this.db
    .prepare(
      `SELECT linear_identifier, issue_title, state, cost_usd
       FROM task_session
       WHERE state IN ('merged', 'stopped')
       ORDER BY ended_at DESC, id DESC
       LIMIT ?`,
    )
    .all(n) as Array<{
    linear_identifier: string;
    issue_title: string;
    state: "merged" | "stopped";
    cost_usd: number | null;
  }>;
  return rows.map((r) => ({
    linearIdentifier: r.linear_identifier,
    issueTitle: r.issue_title,
    state: r.state,
    costUsd: r.cost_usd,
  }));
}
```

- [ ] **Step 4: Run store test to verify it passes**

Run: `npx vitest run tests/store.test.ts -t "recentSessionSummaries"`
Expected: PASS

- [ ] **Step 5: Write the failing tests for initialize**

Append to `tests/memory-store.test.ts`:

```typescript
import { initialize } from "../src/memory-store.js";
import { SqliteStore } from "../src/store.js";

// Add these afterEach hooks for store cleanup:
let openStores: SqliteStore[] = [];
afterEach(() => {
  for (const s of openStores) s.close();
  openStores = [];
});
function newStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  openStores.push(s);
  return s;
}
function makeClock(start = "2026-06-06T00:00:00.000Z"): () => string {
  let t = Date.parse(start);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}

describe("initialize", () => {
  it("creates docs/memory/ and empty header files", () => {
    const store = newStore();
    store.createRun("2026-01-01T00:00:00.000Z", 10);
    initialize(tmpRepo, store, 5);

    const pm = readCategory(tmpRepo, "pm_decisions");
    const impl = readCategory(tmpRepo, "impl_results");
    const prod = readCategory(tmpRepo, "product_knowledge");
    expect(pm).toBe("# PM Decisions\n");
    expect(impl).toBe("# Implementation Results\n");
    expect(prod).toBe("# Product Knowledge\n");
  });

  it("does not overwrite existing files", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "existing content");

    const store = newStore();
    store.createRun("2026-01-01T00:00:00.000Z", 10);
    initialize(tmpRepo, store, 5);

    expect(readCategory(tmpRepo, "pm_decisions")).toBe("existing content");
  });

  it("bootstraps impl-results from DB when file is new", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(clock(), 10).id;

    const s1 = store.createSession({
      runId, linearIssueId: "uuid-1", linearIdentifier: "ES-100",
      issueTitle: "Add auth", branch: "b1", worktreePath: "/w1", now: clock(),
    });
    store.updateSession(s1.id, { state: "merged", costUsd: 2.5, endedAt: clock() });

    const s2 = store.createSession({
      runId, linearIssueId: "uuid-2", linearIdentifier: "ES-101",
      issueTitle: "Fix bug", branch: "b2", worktreePath: "/w2", now: clock(),
    });
    store.updateSession(s2.id, { state: "stopped", costUsd: 0.3, failureReason: "exception", endedAt: clock() });

    initialize(tmpRepo, store, 10);

    const content = readCategory(tmpRepo, "impl_results")!;
    expect(content).toContain("ES-101");
    expect(content).toContain("Fix bug");
    expect(content).toContain("stopped");
    expect(content).toContain("ES-100");
    expect(content).toContain("merged");
  });

  it("does not bootstrap impl-results when file already exists", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "manual content");

    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(clock(), 10).id;
    const s = store.createSession({
      runId, linearIssueId: "uuid-1", linearIdentifier: "ES-999",
      issueTitle: "Some task", branch: "b1", worktreePath: "/w1", now: clock(),
    });
    store.updateSession(s.id, { state: "merged", costUsd: 1.0, endedAt: clock() });

    initialize(tmpRepo, store, 10);

    expect(readCategory(tmpRepo, "impl_results")).toBe("manual content");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/memory-store.test.ts -t "initialize"`
Expected: FAIL — `initialize is not a function` (or similar import error)

- [ ] **Step 7: Implement initialize**

Add to `src/memory-store.ts`:

```typescript
import { mkdirSync } from "node:fs";
import type { SqliteStore } from "./store.js";

const CATEGORY_HEADERS: Record<MemoryCategory, string> = {
  pm_decisions: "# PM Decisions\n",
  impl_results: "# Implementation Results\n",
  product_knowledge: "# Product Knowledge\n",
};

export function initialize(
  repoPath: string,
  store: SqliteStore,
  recentCount: number,
): void {
  const dir = path.join(repoPath, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });

  const categories: MemoryCategory[] = [
    "pm_decisions",
    "impl_results",
    "product_knowledge",
  ];

  const implAlreadyExists = existsSync(
    path.join(dir, CATEGORY_FILES.impl_results),
  );

  for (const cat of categories) {
    const filePath = path.join(dir, CATEGORY_FILES[cat]);
    if (existsSync(filePath)) continue;
    writeFileSync(filePath, CATEGORY_HEADERS[cat], "utf-8");
  }

  if (!implAlreadyExists) {
    const sessions = store.recentSessionSummaries(recentCount);
    if (sessions.length > 0) {
      const lines = sessions.map((s) => {
        const cost = s.costUsd !== null ? `$${s.costUsd.toFixed(2)}` : "n/a";
        return `- ${s.linearIdentifier}: ${s.issueTitle} — ${s.state} (${cost})`;
      });
      const content = `# Implementation Results\n\n${lines.join("\n")}\n`;
      writeFileSync(
        path.join(dir, CATEGORY_FILES.impl_results),
        content,
        "utf-8",
      );
    }
  }
}
```

- [ ] **Step 8: Run all memory-store tests**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Run full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/memory-store.ts src/store.ts tests/memory-store.test.ts tests/store.test.ts
git commit -m "feat(ES-452): add initialize with DB bootstrap + recentSessionSummaries"
```

---

### Task 3: HALT 時 git commit

**Files:**
- Modify: `src/memory-store.ts` (add `commitIfChanged` function)
- Modify: `src/orchestrator.ts` (add `runner` to deps, call `commitIfChanged` in `haltForInterrupt`)
- Modify: `tests/memory-store.test.ts` (add commitIfChanged tests)
- Modify: `tests/orchestrator.test.ts` (add HALT commit integration test)
- Modify: `tests/fakes.ts` (if needed for FakeCommandRunner in harness)

**Interfaces:**
- Consumes:
  - `CommandRunner`, `RunOptions` from `src/types.ts`
  - `MEMORY_DIR` from Task 1
- Produces:
  - `commitIfChanged(runner: CommandRunner, repoPath: string): Promise<boolean>` — returns `true` if a commit was made
  - `OrchestratorDeps.runner: CommandRunner` — new dependency

- [ ] **Step 1: Write the failing test for commitIfChanged**

Append to `tests/memory-store.test.ts`:

```typescript
import { commitIfChanged } from "../src/memory-store.js";
import { FakeCommandRunner } from "./fakes.js";

describe("commitIfChanged", () => {
  it("commits when staged diff detects changes", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    // git diff --cached --quiet exits 1 when there are staged changes
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    runner.on(["git", "commit", "-m"], { code: 0 });

    const result = await commitIfChanged(runner, "/repo");
    expect(result).toBe(true);

    const commitCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    expect(commitCall!.args).toContain("chore: persist cross-task memory on halt");
    expect(commitCall!.opts.cwd).toBe("/repo");
  });

  it("skips commit when no changes", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    // git diff --cached --quiet exits 0 when no staged changes
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    const result = await commitIfChanged(runner, "/repo");
    expect(result).toBe(false);

    const commitCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memory-store.test.ts -t "commitIfChanged"`
Expected: FAIL — `commitIfChanged is not a function`

- [ ] **Step 3: Implement commitIfChanged**

Add to `src/memory-store.ts`:

```typescript
import type { CommandRunner } from "./types.js";

export async function commitIfChanged(
  runner: CommandRunner,
  repoPath: string,
): Promise<boolean> {
  // Stage first so untracked files (from initialize) are included
  await runner.run("git", ["add", MEMORY_DIR + "/"], { cwd: repoPath });
  const diff = await runner.run(
    "git",
    ["diff", "--cached", "--quiet", "--", MEMORY_DIR + "/"],
    { cwd: repoPath },
  );
  if (diff.code === 0) return false;

  await runner.run(
    "git",
    ["commit", "-m", "chore: persist cross-task memory on halt"],
    { cwd: repoPath },
  );
  return true;
}
```

- [ ] **Step 4: Run commitIfChanged tests**

Run: `npx vitest run tests/memory-store.test.ts -t "commitIfChanged"`
Expected: PASS

- [ ] **Step 5: Add `runner` to OrchestratorDeps and wire into haltForInterrupt**

In `src/orchestrator.ts`, add `runner` to `OrchestratorDeps`:

```typescript
// In the import block at the top, add:
import { commitIfChanged } from "./memory-store.js";

// In OrchestratorDeps interface, add after recoveryTurn:
runner: CommandRunner;

// In Orchestrator class private fields, add:
private readonly runner: CommandRunner;

// In the constructor body, add:
this.runner = deps.runner;
```

In `haltForInterrupt()`, add the memory commit call before setting halt state. The method becomes:

```typescript
private async haltForInterrupt(): Promise<void> {
  const run = this.store.getRun(this.runId);
  if (run.state === "halted") return;
  try {
    await commitIfChanged(this.runner, this.config.repo.path);
  } catch {
    this.log("warning: failed to commit memory on halt");
  }
  const detail = "user_interrupt: stop requested; halting at safe point";
  this.store.setRunState(this.runId, "halted", detail);
  await this.notifier.notify({ kind: "halted", reason: "user_interrupt", detail });
  this.log(detail);
}
```

- [ ] **Step 6: Update test harness to provide runner**

In `tests/orchestrator.test.ts`, in `makeHarness()`:

```typescript
// Add a runner to the harness — stub git add + cached diff to "no changes" by default
// (so HALT tests that don't care about memory commit just work)
const memoryRunner = new FakeCommandRunner();
memoryRunner.on(["git", "add", "docs/memory/"], { code: 0 });
memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

// In the Orchestrator constructor deps, add:
runner: memoryRunner,

// In the Harness interface, add:
memoryRunner: FakeCommandRunner;

// Return memoryRunner in the harness object
```

- [ ] **Step 7: Write HALT memory commit integration test**

Add to the HALT test section in `tests/orchestrator.test.ts`:

```typescript
it("commits memory files on halt when changes exist", async () => {
  const h = makeHarness(baseConfig);
  // Override memory runner to simulate changes (add already stubbed in harness)
  h.memoryRunner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
  h.memoryRunner.on(["git", "commit", "-m"], { code: 0 });

  h.source.queue.push(makeIssue("TY-1"));
  h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
  h.git.openPrs.set("looppilot/TY-1-title-for-ty-1", 100);
  h.monitor.verdicts.push({ kind: "in_progress" });

  h.orch.requestStop();
  await h.orch.run();

  const commitCall = h.memoryRunner.calls.find(
    (c) => c.cmd === "git" && c.args[0] === "commit",
  );
  expect(commitCall).toBeDefined();
});

it("skips memory commit on halt when no changes", async () => {
  const h = makeHarness(baseConfig);
  // Default stub returns code 0 (no changes) — already set in harness

  h.source.queue.push(makeIssue("TY-1"));
  h.agent.outcomes.push({ kind: "completed", costUsd: 1, summary: "done" });
  h.git.openPrs.set("looppilot/TY-1-title-for-ty-1", 100);
  h.monitor.verdicts.push({ kind: "in_progress" });

  h.orch.requestStop();
  await h.orch.run();

  const commitCall = h.memoryRunner.calls.find(
    (c) => c.cmd === "git" && c.args[0] === "commit",
  );
  expect(commitCall).toBeUndefined();
});
```

- [ ] **Step 8: Run all tests**

Run: `npm run check`
Expected: PASS — typecheck and all tests green

- [ ] **Step 9: Commit**

```bash
git add src/memory-store.ts src/orchestrator.ts tests/memory-store.test.ts tests/orchestrator.test.ts tests/fakes.ts
git commit -m "feat(ES-452): HALT-time git commit for docs/memory/"
```
