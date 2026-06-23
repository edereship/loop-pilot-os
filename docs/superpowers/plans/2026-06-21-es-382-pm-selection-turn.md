# ES-382: PM Selection Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static priority-based task selection with a PM selection turn where CodexPlanner evaluates the full board state and picks the most valuable next task, with deterministic fallback.

**Architecture:** In the orchestrator's SELECT phase, fetch all eligible tickets via `source.getAllEligible()`, build a PM prompt with the product anchor (requirements/specs), full board state (eligible + in-progress + recently completed), and last merged PR diff context. Run CodexPlanner with this prompt, parse the `{"identifier":"XX-123","rationale":"..."}` JSON output, match against the eligible set, and proceed to CLAIM. On any failure (Codex error, invalid identifier, parse failure), fall back to deterministic order (`eligible[0]`). Record the selection rationale in the task session.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Codex CLI (via existing CodexPlanner/PlanRunner), Linear GraphQL API, `gh` CLI

## Global Constraints

- `npm run check` must remain green at each commit
- Don't break idempotency/recovery invariants (SELECT is stateless — no session exists yet)
- ELIGIBLE_QUERY in task-source.ts is spec-locked ("一字一句一致") — do NOT modify it
- No LLM summarization for diffs (YAGNI) — mechanical truncation only
- No caching of selection results (YAGNI — input changes every boundary)
- Codex is invoked via the existing PlanRunner interface (CodexPlanner)

---

### Task 1: Foundation — Types, Config, Store

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/store.ts`
- Modify: `looppilot-os.example.toml`
- Test: `tests/config.test.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: nothing (foundation layer)
- Produces:
  - `PrDiffSummary` type: `{ title: string; body: string; diff: string }`
  - `SelectPromptArgs` type: `{ specContent, eligible, inProgress, recentMerged, lastPrDiff, diffBudgetChars }`
  - `ParsedSelection` type: `{ identifier: string; rationale: string }`
  - `TaskSource.getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]>` — new interface method
  - `GitPrManager.getPrDiffSummary(prNumber: number): Promise<PrDiffSummary>` — new interface method
  - `TaskSessionRow.selectRationale: string | null` — new field
  - `Config.safety.selectDiffBudgetChars: number` — new config key (default 6000)
  - `SqliteStore.lastMergedWithPr(): TaskSessionRow | null` — new query method

- [ ] **Step 1: Add new types to `src/types.ts`**

After the `PlanBrief` interface block (around line 228), add:

```typescript
// ---- PM 選別ターン（A1: select-prompt.ts） ----

export interface PrDiffSummary {
  title: string;
  body: string;
  diff: string;
}

export interface SelectPromptArgs {
  specContent: SpecContent | null;
  eligible: EligibleIssue[];
  inProgress: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle">>;
  recentMerged: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
  lastPrDiff: { identifier: string; summary: PrDiffSummary } | null;
  diffBudgetChars: number;
}

export interface ParsedSelection {
  identifier: string;
  rationale: string;
}
```

Add `getAllEligible` to the `TaskSource` interface (after `getNextEligible`):

```typescript
export interface TaskSource {
  getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null>;
  getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]>;
  transition(issueId: string, state: TicketState): Promise<void>;
  findOrphanedInProgress(knownIssueIds: string[]): Promise<EligibleIssue[]>;
  postComment(issueId: string, body: string): Promise<void>;
}
```

Add `getPrDiffSummary` to the `GitPrManager` interface (after `postComment`):

```typescript
export interface GitPrManager {
  // ... existing methods ...
  getPrDiffSummary(prNumber: number): Promise<PrDiffSummary>;
}
```

Add `selectRationale` to `TaskSessionRow` (after `planBrief`):

```typescript
export interface TaskSessionRow {
  // ... existing fields ...
  planBrief: string | null;
  selectRationale: string | null;
  // ... remaining fields ...
}
```

- [ ] **Step 2: Add `select_diff_budget_chars` to `src/config.ts`**

In the `rawSchema.safety` object (around line 63, after `codex_timeout_minutes`):

```typescript
select_diff_budget_chars: z.number().int().positive().default(6000),
```

In the `Config.safety` interface (around line 132, after `codexTimeoutMinutes`):

```typescript
selectDiffBudgetChars: number;
```

In the `loadConfig` return object, `safety` block (around line 632, after `codexTimeoutMinutes`):

```typescript
selectDiffBudgetChars: raw.safety.select_diff_budget_chars,
```

- [ ] **Step 3: Add config to `looppilot-os.example.toml`**

In the `[safety]` section (after `session_hard_timeout_minutes`):

```toml
# select_diff_budget_chars = 6000  # PM選別ターンに渡す直前PRの full diff 予算（文字数）。超過時は per-file head で機械 truncate
```

- [ ] **Step 4: Add `select_rationale` column + migration + `lastMergedWithPr` to `src/store.ts`**

In the SCHEMA string, `task_session` table (after `plan_brief TEXT`):

```sql
  select_rationale TEXT,
```

In the `RawSessionRow` interface (after `plan_brief`):

```typescript
  select_rationale: string | null;
```

In `toSessionRow` (after `planBrief`):

```typescript
  selectRationale: r.select_rationale,
```

In `SESSION_PATCH_COLUMNS` (after `planBrief`):

```typescript
  selectRationale: "select_rationale",
```

In `updateSession`'s `Partial<Pick<...>>` type (after `"planBrief"`):

```typescript
  | "selectRationale"
```

In the `migrate()` method (after the `plan_brief` migration):

```typescript
if (!columns.has("select_rationale")) {
  this.db.exec(`ALTER TABLE task_session ADD COLUMN select_rationale TEXT`);
}
```

Add the `lastMergedWithPr` method (after `recentMergedSummaries`):

```typescript
lastMergedWithPr(): TaskSessionRow | null {
  const row = this.db
    .prepare(
      `SELECT * FROM task_session
       WHERE state = 'merged' AND pr_number IS NOT NULL
       ORDER BY ended_at DESC, id DESC
       LIMIT 1`,
    )
    .get() as RawSessionRow | undefined;
  return row === undefined ? null : toSessionRow(row);
}
```

- [ ] **Step 5: Write tests for config validation**

In `tests/config.test.ts`, add a test that verifies `select_diff_budget_chars` defaults to 6000 and is respected when set:

```typescript
it("select_diff_budget_chars defaults to 6000", () => {
  const config = loadConfig(writeConfig(minimalToml()), env());
  expect(config.safety.selectDiffBudgetChars).toBe(6000);
});

it("select_diff_budget_chars is configurable", () => {
  const toml = minimalToml();
  toml.safety.select_diff_budget_chars = 10000;
  const config = loadConfig(writeConfig(toml), env());
  expect(config.safety.selectDiffBudgetChars).toBe(10000);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts -t "select_diff_budget_chars"`
Expected: PASS

- [ ] **Step 7: Write tests for store migration + lastMergedWithPr**

In `tests/store.test.ts`, add:

```typescript
describe("select_rationale column", () => {
  it("updateSession sets and reads select_rationale", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "id-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "b",
      worktreePath: "/wt",
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(session.selectRationale).toBeNull();

    store.updateSession(session.id, { selectRationale: "highest priority after auth refactor" });
    const updated = store.getSession(session.id);
    expect(updated.selectRationale).toBe("highest priority after auth refactor");
  });
});

describe("lastMergedWithPr", () => {
  it("returns null when no merged sessions", () => {
    const store = new SqliteStore(":memory:");
    expect(store.lastMergedWithPr()).toBeNull();
  });

  it("returns the most recently merged session with a PR", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run.id, linearIssueId: "id-1", linearIdentifier: "TY-1",
      issueTitle: "First", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "merged", prNumber: 10, endedAt: "2026-01-01T00:01:00.000Z" });
    const s2 = store.createSession({
      runId: run.id, linearIssueId: "id-2", linearIdentifier: "TY-2",
      issueTitle: "Second", branch: "b2", worktreePath: "/wt2",
      now: "2026-01-01T00:00:02.000Z",
    });
    store.updateSession(s2.id, { state: "merged", prNumber: 11, endedAt: "2026-01-01T00:02:00.000Z" });

    const last = store.lastMergedWithPr();
    expect(last).not.toBeNull();
    expect(last!.linearIdentifier).toBe("TY-2");
    expect(last!.prNumber).toBe(11);
  });

  it("skips merged sessions without pr_number", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run.id, linearIssueId: "id-1", linearIdentifier: "TY-1",
      issueTitle: "NoPr", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "merged", endedAt: "2026-01-01T00:01:00.000Z" });

    expect(store.lastMergedWithPr()).toBeNull();
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/store.test.ts -t "select_rationale|lastMergedWithPr"`
Expected: PASS

- [ ] **Step 9: Run full check**

Run: `npm run check`
Expected: All green (types compile, existing tests pass)

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/config.ts src/store.ts looppilot-os.example.toml tests/config.test.ts tests/store.test.ts
git commit -m "feat(es-382): add types, config, store foundation for PM selection turn"
```

---

### Task 2: Data Providers — TaskSource.getAllEligible + GitPrManager.getPrDiffSummary

**Files:**
- Modify: `src/task-source.ts`
- Modify: `src/git-pr.ts`
- Modify: `tests/fakes.ts`
- Test: `tests/task-source.test.ts`
- Test: `tests/git-pr.test.ts`

**Interfaces:**
- Consumes: `EligibleIssue`, `PrDiffSummary` from types.ts; `TaskSource`, `GitPrManager` interfaces
- Produces:
  - `LinearTaskSource.getAllEligible(excludeIds)` — returns all eligible issues in deterministic order (filtered by blocked-by relations)
  - `GitPrManager.getPrDiffSummary(prNumber)` — returns PR title, body, and full unified diff
  - `FakeTaskSource.getAllEligible` — fake for tests
  - `FakeGitPr.getPrDiffSummary` — fake for tests

- [ ] **Step 1: Write failing test for `getAllEligible` in `tests/task-source.test.ts`**

Add a new describe block. Find how the existing tests set up FakeCommandRunner stubs for the Linear GraphQL API and follow the same pattern. The test should verify that `getAllEligible` returns all eligible issues (not just the first) in deterministic order, excluding `excludeIds`.

```typescript
describe("getAllEligible", () => {
  it("returns all eligible issues sorted by priority→sortOrder→id, excluding excludeIds", async () => {
    // Stub the graphql response with 3 issues
    const nodes = [
      { id: "c", identifier: "TY-3", title: "C", description: "", priority: 3, sortOrder: 100, url: "u3" },
      { id: "a", identifier: "TY-1", title: "A", description: "", priority: 1, sortOrder: 100, url: "u1" },
      { id: "b", identifier: "TY-2", title: "B", description: "", priority: 2, sortOrder: 100, url: "u2" },
    ];
    // Set up FakeCommandRunner to return these nodes for the eligible query
    // ... (follow existing test patterns for graphql stubs)

    const result = await source.getAllEligible(["b"]); // exclude TY-2
    expect(result).toHaveLength(2);
    expect(result[0].identifier).toBe("TY-1"); // Urgent first
    expect(result[1].identifier).toBe("TY-3"); // Medium second
  });

  it("returns empty array when no eligible tickets", async () => {
    // Stub empty response
    const result = await source.getAllEligible([]);
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/task-source.test.ts -t "getAllEligible"`
Expected: FAIL (method does not exist)

- [ ] **Step 3: Implement `getAllEligible` in `src/task-source.ts`**

In `LinearTaskSource`, after `getNextEligible`:

```typescript
async getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]> {
  const exclude = new Set(excludeIds);
  const nodes = (await this.queryByState(this.stateIds.todo))
    .filter((n) => !exclude.has(n.id))
    .sort(compareIssues);
  return nodes.map(toEligible);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/task-source.test.ts -t "getAllEligible"`
Expected: PASS

- [ ] **Step 5: Update `FakeTaskSource` in `tests/fakes.ts`**

In `FakeTaskSource`, add the `getAllEligible` method:

```typescript
async getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]> {
  this.eligibleCalls.push([...excludeIds]);
  this.takeFailure("getAllEligible");
  return this.queue.filter((i) => !excludeIds.includes(i.id));
}
```

Update the `failNext` type to include `"getAllEligible"`.

- [ ] **Step 6: Write failing test for `getPrDiffSummary` in `tests/git-pr.test.ts`**

```typescript
describe("getPrDiffSummary", () => {
  it("returns title, body, and diff from gh commands", async () => {
    const runner = new FakeCommandRunner();
    const git = new GitPrManager(runner, defaultOpts);

    // Stub: gh pr view --json title,body
    runner.on(["gh", "pr", "view", "42"], (args) => {
      if (args.includes("--json")) {
        return { stdout: JSON.stringify({ title: "TY-1: Fix bug", body: "Fixes the login bug" }) };
      }
      return {};
    });
    // Stub: gh pr diff
    runner.on(["gh", "pr", "diff", "42"], {
      stdout: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1,2 @@\n line\n+added\n",
    });

    const result = await git.getPrDiffSummary(42);
    expect(result.title).toBe("TY-1: Fix bug");
    expect(result.body).toBe("Fixes the login bug");
    expect(result.diff).toContain("diff --git");
  });

  it("throws when gh pr view fails", async () => {
    const runner = new FakeCommandRunner();
    const git = new GitPrManager(runner, defaultOpts);
    runner.on(["gh", "pr", "view", "99"], { code: 1, stderr: "not found" });

    await expect(git.getPrDiffSummary(99)).rejects.toThrow("gh pr view failed");
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/git-pr.test.ts -t "getPrDiffSummary"`
Expected: FAIL (method does not exist)

- [ ] **Step 8: Implement `getPrDiffSummary` in `src/git-pr.ts`**

Import `PrDiffSummary` from types. Add method to `GitPrManager`:

```typescript
async getPrDiffSummary(prNumber: number): Promise<PrDiffSummary> {
  const { repoPath, remote } = this.opts;

  const viewRes = await this.runner.run(
    "gh",
    ["pr", "view", String(prNumber), "-R", remote, "--json", "title,body"],
    { cwd: repoPath },
  );
  if (viewRes.code !== 0) {
    throw new Error(
      `gh pr view failed for PR #${prNumber}: ${viewRes.stderr.trim() || `exit ${viewRes.code}`}`,
    );
  }
  const { title, body } = JSON.parse(viewRes.stdout) as { title: string; body: string };

  const diffRes = await this.runner.run(
    "gh",
    ["pr", "diff", String(prNumber), "-R", remote],
    { cwd: repoPath },
  );
  if (diffRes.code !== 0) {
    throw new Error(
      `gh pr diff failed for PR #${prNumber}: ${diffRes.stderr.trim() || `exit ${diffRes.code}`}`,
    );
  }

  return { title, body, diff: diffRes.stdout };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run tests/git-pr.test.ts -t "getPrDiffSummary"`
Expected: PASS

- [ ] **Step 10: Update `FakeGitPr` in `tests/fakes.ts`**

Add to `FakeGitPr`:

```typescript
prDiffSummaries = new Map<number, PrDiffSummary>();

async getPrDiffSummary(prNumber: number): Promise<PrDiffSummary> {
  this.calls.push({ method: "getPrDiffSummary", args: [prNumber] });
  this.takeFailure("getPrDiffSummary");
  const preset = this.prDiffSummaries.get(prNumber);
  if (preset) return preset;
  return { title: `PR #${prNumber}`, body: "", diff: "" };
}
```

Import `PrDiffSummary` at the top of fakes.ts.

- [ ] **Step 11: Run full check**

Run: `npm run check`
Expected: All green

- [ ] **Step 12: Commit**

```bash
git add src/task-source.ts src/git-pr.ts tests/fakes.ts tests/task-source.test.ts tests/git-pr.test.ts
git commit -m "feat(es-382): add getAllEligible + getPrDiffSummary data providers"
```

---

### Task 3: Select Prompt Module — `src/select-prompt.ts`

**Files:**
- Create: `src/select-prompt.ts`
- Test: `tests/select-prompt.test.ts`

**Interfaces:**
- Consumes: `SelectPromptArgs`, `ParsedSelection`, `EligibleIssue`, `PrDiffSummary`, `SpecContent`, `TaskSessionRow` from types.ts
- Produces:
  - `buildSelectPrompt(args: SelectPromptArgs): string` — deterministic prompt assembly
  - `parseSelection(codexOutput: string): ParsedSelection | null` — extract last JSON block, validate
  - `computeDiffStat(unifiedDiff: string): string` — parse unified diff into stat-style summary
  - `formatDiffContext(identifier: string, summary: PrDiffSummary, budgetChars: number): string` — format PR diff with stat + truncated patch

- [ ] **Step 1: Write failing tests for `parseSelection` in `tests/select-prompt.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseSelection, buildSelectPrompt, computeDiffStat, formatDiffContext } from "../src/select-prompt.js";
import type { SelectPromptArgs, PrDiffSummary } from "../src/types.js";

describe("parseSelection", () => {
  it("extracts identifier and rationale from a valid JSON block", () => {
    const output = 'Some reasoning text\n```json\n{"identifier":"TY-5","rationale":"Continues auth work"}\n```\n';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-5", rationale: "Continues auth work" });
  });

  it("uses the LAST json block when multiple are present", () => {
    const output = [
      '```json\n{"identifier":"TY-1","rationale":"first"}\n```',
      "More reasoning...",
      '```json\n{"identifier":"TY-9","rationale":"final pick"}\n```',
    ].join("\n");
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-9", rationale: "final pick" });
  });

  it("returns null for empty output", () => {
    expect(parseSelection("")).toBeNull();
  });

  it("returns null when no json block is present", () => {
    expect(parseSelection("Just some text without JSON")).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parseSelection('```json\n{bad json}\n```')).toBeNull();
  });

  it("returns null when identifier is missing", () => {
    expect(parseSelection('```json\n{"rationale":"no id"}\n```')).toBeNull();
  });

  it("returns null when identifier is not a string", () => {
    expect(parseSelection('```json\n{"identifier":123,"rationale":"num"}\n```')).toBeNull();
  });

  it("handles json block without backtick fence (raw JSON line)", () => {
    const output = 'Analysis...\n{"identifier":"TY-3","rationale":"best next"}\n';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-3", rationale: "best next" });
  });

  it("trims whitespace from identifier", () => {
    const output = '```json\n{"identifier":" TY-7 ","rationale":"trimmed"}\n```';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-7", rationale: "trimmed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/select-prompt.test.ts -t "parseSelection"`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement `parseSelection` in `src/select-prompt.ts`**

```typescript
import type { SelectPromptArgs, ParsedSelection, PrDiffSummary } from "./types.js";

export function parseSelection(codexOutput: string): ParsedSelection | null {
  const trimmed = codexOutput.trim();
  if (trimmed.length === 0) return null;

  // Try fenced ```json blocks first (last one wins)
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(trimmed)) !== null) {
    lastFenceMatch = m[1];
  }

  // Fallback: try to find a raw JSON object on a line by itself
  let jsonStr = lastFenceMatch;
  if (jsonStr === null) {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        jsonStr = line;
        break;
      }
    }
  }

  if (jsonStr === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.identifier !== "string") return null;

  const identifier = obj.identifier.trim();
  if (identifier.length === 0) return null;

  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";

  return { identifier, rationale };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/select-prompt.test.ts -t "parseSelection"`
Expected: PASS

- [ ] **Step 5: Write failing tests for `computeDiffStat`**

```typescript
describe("computeDiffStat", () => {
  it("computes per-file insertions and deletions", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "-removed",
      "+added1",
      "+added2",
    ].join("\n");
    const stat = computeDiffStat(diff);
    expect(stat).toContain("src/foo.ts");
    expect(stat).toContain("2 insertion");
    expect(stat).toContain("1 deletion");
  });

  it("handles multiple files", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      " x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,2 +1 @@",
      " x",
      "-y",
    ].join("\n");
    const stat = computeDiffStat(diff);
    expect(stat).toContain("a.ts");
    expect(stat).toContain("b.ts");
    expect(stat).toContain("2 files changed");
  });

  it("returns empty string for empty diff", () => {
    expect(computeDiffStat("")).toBe("");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/select-prompt.test.ts -t "computeDiffStat"`
Expected: FAIL

- [ ] **Step 7: Implement `computeDiffStat`**

```typescript
export function computeDiffStat(unifiedDiff: string): string {
  if (unifiedDiff.trim().length === 0) return "";

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let current: { path: string; insertions: number; deletions: number } | null = null;

  for (const line of unifiedDiff.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\//.exec(line);
    if (fileMatch) {
      if (current) files.push(current);
      current = { path: fileMatch[1], insertions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) current.insertions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  if (current) files.push(current);

  if (files.length === 0) return "";

  const lines = files.map((f) => {
    const total = f.insertions + f.deletions;
    const bar = "+".repeat(f.insertions) + "-".repeat(f.deletions);
    return ` ${f.path} | ${total} ${bar}`;
  });

  const totalInsertions = files.reduce((s, f) => s + f.insertions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const filesWord = files.length === 1 ? "1 file changed" : `${files.length} files changed`;
  const parts = [filesWord];
  if (totalInsertions > 0) parts.push(`${totalInsertions} insertion${totalInsertions === 1 ? "" : "s"}(+)`);
  if (totalDeletions > 0) parts.push(`${totalDeletions} deletion${totalDeletions === 1 ? "" : "s"}(-)`);

  lines.push(` ${parts.join(", ")}`);
  return lines.join("\n");
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/select-prompt.test.ts -t "computeDiffStat"`
Expected: PASS

- [ ] **Step 9: Write failing tests for `formatDiffContext`**

```typescript
describe("formatDiffContext", () => {
  const baseDiff: PrDiffSummary = {
    title: "TY-3: Refactor auth",
    body: "Refactored the auth module.",
    diff: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added",
      "-removed",
    ].join("\n"),
  };

  it("includes PR title, body, stat, and full diff when under budget", () => {
    const result = formatDiffContext("TY-3", baseDiff, 10000);
    expect(result).toContain("TY-3: Refactor auth");
    expect(result).toContain("Refactored the auth module.");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("diff --git");
  });

  it("truncates full diff when over budget, keeps stat", () => {
    const longDiff = "diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n" +
      Array.from({ length: 500 }, (_, i) => `+line${i}`).join("\n");
    const summary: PrDiffSummary = { title: "Big PR", body: "lots of changes", diff: longDiff };
    const result = formatDiffContext("TY-4", summary, 200);
    expect(result).toContain("Big PR");
    expect(result).toContain("big.ts");
    expect(result).toContain("(truncated)");
    expect(result.length).toBeLessThan(longDiff.length);
  });

  it("omits full diff section entirely when stat alone exceeds budget", () => {
    const summary: PrDiffSummary = { title: "T", body: "B", diff: "diff --git a/x.ts b/x.ts\n+a" };
    const result = formatDiffContext("TY-5", summary, 5);
    expect(result).toContain("T");
    // At minimum, title and body are always included
  });
});
```

- [ ] **Step 10: Implement `formatDiffContext`**

```typescript
export function formatDiffContext(
  identifier: string,
  summary: PrDiffSummary,
  budgetChars: number,
): string {
  const blocks: string[] = [];

  blocks.push(`PR: ${summary.title}`);
  if (summary.body.trim().length > 0) {
    blocks.push(summary.body.trim());
  }

  const stat = computeDiffStat(summary.diff);
  if (stat.length > 0) {
    blocks.push(`Diff stat:\n${stat}`);
  }

  const baseLength = blocks.join("\n\n").length;
  const remaining = budgetChars - baseLength;

  if (remaining > 100 && summary.diff.trim().length > 0) {
    if (summary.diff.length <= remaining) {
      blocks.push(`Full diff:\n${summary.diff}`);
    } else {
      const truncated = truncateDiffPerFile(summary.diff, remaining);
      blocks.push(`Diff (truncated):\n${truncated}`);
    }
  }

  return blocks.join("\n\n");
}

function truncateDiffPerFile(unifiedDiff: string, budget: number): string {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  const result: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used + chunk.length + 1 <= budget) {
      result.push(chunk);
      used += chunk.length + 1;
    } else {
      const remaining = budget - used;
      if (remaining > 50) {
        const header = chunk.split("\n").slice(0, 4).join("\n");
        result.push(header + "\n... (file truncated)");
      }
      break;
    }
  }
  return result.join("\n");
}
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `npx vitest run tests/select-prompt.test.ts -t "formatDiffContext"`
Expected: PASS

- [ ] **Step 12: Write failing tests for `buildSelectPrompt`**

```typescript
describe("buildSelectPrompt", () => {
  const baseArgs: SelectPromptArgs = {
    specContent: null,
    eligible: [
      { id: "a", identifier: "TY-1", title: "Add auth", description: "Auth feature", priority: 1, sortOrder: 100, url: "u1" },
      { id: "b", identifier: "TY-2", title: "Fix bug", description: "Bug fix", priority: 2, sortOrder: 200, url: "u2" },
    ],
    inProgress: [],
    recentMerged: [],
    lastPrDiff: null,
    diffBudgetChars: 6000,
  };

  it("includes system instruction and eligible candidates", () => {
    const prompt = buildSelectPrompt(baseArgs);
    expect(prompt).toContain("TY-1");
    expect(prompt).toContain("TY-2");
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain('"identifier"');
    expect(prompt).toContain('"rationale"');
  });

  it("includes spec content when provided", () => {
    const args = {
      ...baseArgs,
      specContent: {
        requirements: "Build a great product",
        domainSpecs: [{ name: "auth", content: "Auth spec here" }],
      },
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("Build a great product");
    expect(prompt).toContain("Auth spec here");
  });

  it("includes in-progress and recently merged context", () => {
    const args = {
      ...baseArgs,
      inProgress: [{ linearIdentifier: "TY-5", issueTitle: "Ongoing work" }],
      recentMerged: [{ linearIdentifier: "TY-3", issueTitle: "Done task", agentSummary: "Completed the thing" }],
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("TY-5");
    expect(prompt).toContain("Ongoing work");
    expect(prompt).toContain("TY-3");
    expect(prompt).toContain("Done task");
  });

  it("includes last PR diff when provided", () => {
    const args = {
      ...baseArgs,
      lastPrDiff: {
        identifier: "TY-3",
        summary: { title: "TY-3: Done", body: "Did stuff", diff: "diff --git a/x.ts b/x.ts\n+line" },
      },
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("TY-3: Done");
    expect(prompt).toContain("Did stuff");
  });

  it("is deterministic — same inputs produce same output", () => {
    const p1 = buildSelectPrompt(baseArgs);
    const p2 = buildSelectPrompt(baseArgs);
    expect(p1).toBe(p2);
  });

  it("includes issue descriptions in eligible section", () => {
    const prompt = buildSelectPrompt(baseArgs);
    expect(prompt).toContain("Auth feature");
    expect(prompt).toContain("Bug fix");
  });
});
```

- [ ] **Step 13: Implement `buildSelectPrompt`**

```typescript
export function buildSelectPrompt(args: SelectPromptArgs): string {
  const { specContent, eligible, inProgress, recentMerged, lastPrDiff, diffBudgetChars } = args;

  const blocks: string[] = [];

  // System instruction
  blocks.push([
    "You are a project manager selecting the next task for the development team.",
    "Given the product context, current board state, and recent work, select the single most valuable next task.",
    "",
    "Consider:",
    "- Alignment with product requirements (the anchor)",
    "- Strategic sequencing (does recent work create momentum for a specific next task?)",
    "- Priority and urgency",
    "- Dependencies and risk",
  ].join("\n"));

  // ① Requirements / specs (anchor)
  if (specContent) {
    blocks.push(["# Product Requirements", "", specContent.requirements].join("\n"));
    if (specContent.domainSpecs.length > 0) {
      const sections = specContent.domainSpecs.map(
        (s) => [`## ${s.name}`, "", s.content].join("\n"),
      );
      blocks.push(["# Domain Specifications", "", ...sections].join("\n\n"));
    }
  }

  // ② Board state: in-progress
  if (inProgress.length > 0) {
    const lines = inProgress.map(
      (s) => `- ${s.linearIdentifier}: ${s.issueTitle}`,
    );
    blocks.push(["# Currently In Progress", "", ...lines].join("\n"));
  }

  // ② Board state: recently completed
  if (recentMerged.length > 0) {
    const lines = recentMerged.map((s) => {
      const summary = s.agentSummary ? ` — ${s.agentSummary.split("\n")[0].trim()}` : "";
      return `- ${s.linearIdentifier}: ${s.issueTitle}${summary}`;
    });
    blocks.push(["# Recently Completed", "", ...lines].join("\n"));
  }

  // ③ Last merged PR diff
  if (lastPrDiff) {
    const diffContext = formatDiffContext(
      lastPrDiff.identifier,
      lastPrDiff.summary,
      diffBudgetChars,
    );
    blocks.push(["# Previous Task Diff", "", diffContext].join("\n"));
  }

  // ④ Eligible candidates
  const candidateLines = eligible.map((e, i) => {
    const desc = e.description.trim().length > 0
      ? e.description.trim().split("\n").slice(0, 3).join("\n  ")
      : "(no description)";
    return `${i + 1}. ${e.identifier} [Priority: ${priorityLabel(e.priority)}]: ${e.title}\n  ${desc}`;
  });
  blocks.push(["# Eligible Candidates", "", "Select ONE from the following:", "", ...candidateLines].join("\n"));

  // Output format instruction
  blocks.push([
    "# Output",
    "",
    "Respond with a JSON block containing your selection:",
    "",
    "```json",
    '{"identifier":"XX-123","rationale":"one line explaining why this task is the best next pick"}',
    "```",
    "",
    "The identifier MUST exactly match one of the eligible candidates above.",
  ].join("\n"));

  return blocks.join("\n\n");
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Urgent";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return "None";
  }
}
```

- [ ] **Step 14: Run all select-prompt tests**

Run: `npx vitest run tests/select-prompt.test.ts`
Expected: PASS

- [ ] **Step 15: Run full check**

Run: `npm run check`
Expected: All green

- [ ] **Step 16: Commit**

```bash
git add src/select-prompt.ts tests/select-prompt.test.ts
git commit -m "feat(es-382): add select-prompt module with buildSelectPrompt + parseSelection + diff formatting"
```

---

### Task 4: Orchestrator SELECT Integration + Main Wiring

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/main.ts` (no change needed — planner is already wired)
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `TaskSource.getAllEligible`, `GitPrManager.getPrDiffSummary`, `SqliteStore.lastMergedWithPr`, `PlanRunner.run`, `buildSelectPrompt`, `parseSelection`, `Config.safety.selectDiffBudgetChars`, `Config.safety.codexTimeoutMinutes`
- Produces: Modified SELECT phase in the orchestrator loop that uses PM selection with deterministic fallback

- [ ] **Step 1: Write failing test for PM selection happy path in `tests/orchestrator.test.ts`**

```typescript
describe("Orchestrator PM 選別ターン（ES-382 A1）", () => {
  it("planner ありで eligible 複数 → Codex が選んだチケットを CLAIM する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    // 2 eligible: TY-1 (Urgent), TY-2 (Medium)
    const ty1 = issue("id-1", "TY-1", { priority: 1 });
    const ty2 = issue("id-2", "TY-2", { priority: 3 });
    h.source.queue = [ty1, ty2];

    // Planner outcomes: first call is SELECT, second is PLAN
    planner.outcomes = [
      // SELECT: Codex picks TY-2 (not the deterministic first)
      { kind: "completed", text: '```json\n{"identifier":"TY-2","rationale":"Continues recent work"}\n```' },
      // PLAN: brief for the selected ticket
      { kind: "completed", text: "## Goal\nFix the thing" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-2"); // PM picked TY-2, not deterministic TY-1
    expect(sessions[0].selectRationale).toBe("Continues recent work");
  });

  it("planner ありで Codex 失敗 → 決定的順序にフォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1", { priority: 1 }), issue("id-2", "TY-2", { priority: 3 })];

    planner.outcomes = [
      // SELECT: Codex error
      { kind: "error", message: "codex timeout" },
      // PLAN: runs for TY-1 (fallback pick)
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic fallback
    expect(sessions[0].selectRationale).toContain("deterministic fallback");
  });

  it("planner ありで Codex が無効な identifier → 決定的順序にフォールバック", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1")];

    planner.outcomes = [
      // SELECT: Codex returns non-existent identifier
      { kind: "completed", text: '```json\n{"identifier":"TY-999","rationale":"does not exist"}\n```' },
      // PLAN
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].selectRationale).toContain("deterministic fallback");
  });

  it("planner ありで eligible が 1 件 → PM 選別スキップ、planner を SELECT に消費しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1")];

    // Only PLAN outcome (no SELECT since only 1 eligible)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nPlan" },
    ];

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    // planner called only once (PLAN), not twice (SELECT + PLAN)
    expect(planner.calls).toHaveLength(1);
  });

  it("planner なし → 決定的順序のまま（既存動作不変）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // no planner

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions[0].linearIdentifier).toBe("TY-1"); // deterministic first
    expect(sessions[0].selectRationale).toBeNull();
  });

  it("Codex interrupted → HALT（安全停止）", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });

    h.source.queue = [issue("id-1", "TY-1"), issue("id-2", "TY-2")];

    planner.outcomes = [
      { kind: "interrupted" },
    ];

    await h.orch.run();

    const run = h.store.latestRun()!;
    expect(run.state).toBe("halted");
    // No sessions created (interrupted before CLAIM)
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "PM 選別ターン"`
Expected: FAIL

- [ ] **Step 3: Add imports to orchestrator.ts**

At the top of `src/orchestrator.ts`, add:

```typescript
import { buildSelectPrompt, parseSelection } from "./select-prompt.js";
```

- [ ] **Step 4: Add the `select` method to the `Orchestrator` class**

After the `plan()` method (around line 617), add:

```typescript
// ---- SELECT PM（スコープ doc A1 / §1.4 / §1.5） ----
private async selectWithPm(
  eligible: EligibleIssue[],
): Promise<
  | { control: "continue"; issue: EligibleIssue; rationale: string | null }
  | { control: "halt" }
> {
  // Only 1 eligible → no point asking PM, skip to avoid wasting a Codex call
  if (eligible.length <= 1) {
    return { control: "continue", issue: eligible[0], rationale: null };
  }

  // Build PM selection context
  const inProgress = this.store.activeSessions().map((s) => ({
    linearIdentifier: s.linearIdentifier,
    issueTitle: s.issueTitle,
  }));

  const recentMerged = this.config.digest.enabled
    ? this.store.recentMergedSummaries(this.config.digest.recentMergedCount)
    : [];

  // Load spec content for the anchor
  let specContent: SpecContent | null = null;
  const specDir = this.config.product.specDir;
  if (specDir !== undefined && this.specLoader !== null) {
    try {
      specContent = this.specLoader(this.config.repo.path, specDir);
    } catch (err) {
      this.log(`select: spec loading failed (non-fatal): ${errMsg(err)}`);
    }
  }

  // Get last merged PR diff context
  let lastPrDiff: { identifier: string; summary: PrDiffSummary } | null = null;
  const lastMerged = this.store.lastMergedWithPr();
  if (lastMerged !== null && lastMerged.prNumber !== null) {
    try {
      const summary = await this.git.getPrDiffSummary(lastMerged.prNumber);
      lastPrDiff = { identifier: lastMerged.linearIdentifier, summary };
    } catch (err) {
      this.log(`select: PR diff retrieval failed (non-fatal): ${errMsg(err)}`);
    }
  }

  const prompt = buildSelectPrompt({
    specContent,
    eligible,
    inProgress,
    recentMerged,
    lastPrDiff,
    diffBudgetChars: this.config.safety.selectDiffBudgetChars,
  });

  let outcome: PlanOutcome;
  try {
    outcome = await this.planner!.run({
      worktreePath: this.config.repo.path,
      prompt,
      timeoutMs: this.config.safety.codexTimeoutMinutes * 60_000,
    });
  } catch (err) {
    this.log(`select: codex exception, deterministic fallback: ${errMsg(err)}`);
    return {
      control: "continue",
      issue: eligible[0],
      rationale: `deterministic fallback: codex exception: ${errMsg(err)}`,
    };
  }

  if (outcome.kind === "interrupted") {
    await this.haltForInterrupt();
    return { control: "halt" };
  }

  if (outcome.kind === "error") {
    this.log(`select: codex failed, deterministic fallback: ${outcome.message}`);
    return {
      control: "continue",
      issue: eligible[0],
      rationale: `deterministic fallback: codex error: ${outcome.message}`,
    };
  }

  // Parse Codex output
  const parsed = parseSelection(outcome.text);
  if (parsed === null) {
    this.log("select: failed to parse codex output, deterministic fallback");
    return {
      control: "continue",
      issue: eligible[0],
      rationale: "deterministic fallback: parse failure",
    };
  }

  // Match identifier against eligible set
  const matched = eligible.find((e) => e.identifier === parsed.identifier);
  if (matched === undefined) {
    this.log(`select: identifier "${parsed.identifier}" not in eligible set, deterministic fallback`);
    return {
      control: "continue",
      issue: eligible[0],
      rationale: `deterministic fallback: identifier "${parsed.identifier}" not in eligible set`,
    };
  }

  this.log(`select: PM picked ${matched.identifier}: ${parsed.rationale}`);
  return { control: "continue", issue: matched, rationale: parsed.rationale };
}
```

- [ ] **Step 5: Modify the `loop()` method to use PM selection**

Replace the SELECT section (lines ~447-472) in `loop()`. The current code is:

```typescript
// 2) SELECT（仕様 §5.1）
let issue: EligibleIssue | null;
try {
  issue = await this.source.getNextEligible(this.store.activeIssueIds());
} catch (err) {
  const detail = `select_failed: getNextEligible: ${errMsg(err)}`;
  await this.notifier.notify({ kind: "halted", reason: "exception", detail });
  this.store.setRunState(this.runId, "halted", detail);
  this.log(detail);
  return;
}
if (issue === null) {
  if (!idleNotified) {
    await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
    idleNotified = true;
  }
  this.store.setRunState(this.runId, "idle");
  await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
  continue;
}
idleNotified = false;
this.store.setRunState(this.runId, "running");
```

Replace with:

```typescript
// 2) SELECT（仕様 §5.1 + A1 PM 選別ターン）
let eligible: EligibleIssue[];
try {
  eligible = await this.source.getAllEligible(this.store.activeIssueIds());
} catch (err) {
  const detail = `select_failed: getAllEligible: ${errMsg(err)}`;
  await this.notifier.notify({ kind: "halted", reason: "exception", detail });
  this.store.setRunState(this.runId, "halted", detail);
  this.log(detail);
  return;
}
if (eligible.length === 0) {
  if (!idleNotified) {
    await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
    idleNotified = true;
  }
  this.store.setRunState(this.runId, "idle");
  await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
  continue;
}
idleNotified = false;
this.store.setRunState(this.runId, "running");

let issue: EligibleIssue;
let selectRationale: string | null = null;
if (this.planner !== null) {
  const sel = await this.selectWithPm(eligible);
  if (sel.control === "halt") return;
  issue = sel.issue;
  selectRationale = sel.rationale;
} else {
  issue = eligible[0];
}
```

Then, after session creation in `claim()` (where `return { control: "continue", session }`), record the rationale. In `loop()`, after the claim call succeeds, add:

```typescript
// 3) CLAIM
const claim = await this.claim(issue);
if (claim.control === "halt") return;
const session = claim.session;

// Record PM selection rationale (§1.6)
if (selectRationale !== null) {
  this.store.updateSession(session.id, { selectRationale });
}
```

- [ ] **Step 6: Add `PrDiffSummary` import to orchestrator.ts**

Update the import from types.ts to include `PrDiffSummary`:

```typescript
import type {
  // ... existing imports ...
  PrDiffSummary,
} from "./types.js";
```

- [ ] **Step 7: Update `makeConfig` helper in tests/orchestrator.test.ts**

In the `makeConfig` function, add `selectDiffBudgetChars` to the safety block:

```typescript
safety: {
  // ... existing fields ...
  selectDiffBudgetChars: 6000,
},
```

- [ ] **Step 8: Update `makeHarness` to support `getAllEligible`**

The `FakeTaskSource` already has `getAllEligible` from Task 2 Step 5. Verify the harness wiring works by running the tests.

- [ ] **Step 9: Run tests to verify PM selection**

Run: `npx vitest run tests/orchestrator.test.ts -t "PM 選別ターン"`
Expected: PASS

- [ ] **Step 10: Verify existing tests still pass**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: All PASS (PM selection is opt-in via planner !== null; existing tests pass planner: null)

- [ ] **Step 11: Run full check**

Run: `npm run check`
Expected: All green

- [ ] **Step 12: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(es-382): integrate PM selection turn into orchestrator SELECT phase"
```

---

## Acceptance Criteria Checklist

| Criterion | Covered in |
|-----------|-----------|
| `npm run check` green | Each task ends with `npm run check` |
| identifier-JSON parsing tested | Task 3: `parseSelection` tests (valid, malformed, missing, raw JSON, multiple blocks) |
| Eligible set matching tested | Task 4: "Codex が選んだチケットを CLAIM" + "無効な identifier → fallback" |
| Invalid/failure → deterministic fallback tested | Task 4: error, invalid identifier, parse failure, interrupt tests |
| Diff stat + truncate tested | Task 3: `computeDiffStat` + `formatDiffContext` tests |
| Decision recording tested | Task 4: `selectRationale` field verified in PM selection tests |
| Idempotency/recovery invariants preserved | SELECT is stateless (no session before CLAIM); PM selection adds no new crash-recovery surface |
