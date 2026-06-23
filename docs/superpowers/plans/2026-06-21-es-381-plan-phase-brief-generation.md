# ES-381: PLAN Phase & Brief Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a PLAN phase between CLAIM and IMPLEMENT in the orchestrator. Codex CLI generates an implementation brief from the ticket + repo context + requirements/specs. On Codex failure, fall back to raw ticket (no brief).

**Architecture:** New pure-function module `src/plan-brief.ts` handles prompt construction and brief parsing. The orchestrator gains a `PlanRunner` dependency (structurally implemented by `CodexPlanner`) and a `plan()` method inserted between `claim()` and `implement()`. The brief is persisted in the `task_session.plan_brief` column. Brief injection into `buildPrompt` is deferred to ES-405.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, CodexPlanner (ES-379)

## Global Constraints

- `npm run check` must pass (typecheck + lint + test)
- SessionState does NOT gain a `"planning"` value — PLAN is an internal step within `"claimed"` state
- Brief output format: English Markdown with `## Goal` / `## Change Targets` / `## Implementation Steps` / `## Acceptance Criteria` / `## Out of Scope` headings
- Brief DB column stores `raw` text (full Codex output); structured parsing is in-memory only
- Codex failure always falls back (never halts the loop)
- Out of scope: `buildPrompt` injection (ES-405), Linear write-back (ES-406)

---

### Task 1: Types + plan-brief module

**Files:**
- Modify: `src/types.ts` — add PlanOutcome, PlanRunner, BriefSections, PlanBrief types + planBrief field on TaskSessionRow
- Create: `src/plan-brief.ts` — buildPlanPrompt + parseBrief pure functions
- Create: `tests/plan-brief.test.ts` — unit tests

**Interfaces:**
- Consumes: `EligibleIssue`, `SpecContent` from `src/types.ts`
- Produces: `PlanOutcome`, `PlanRunner`, `BriefSections`, `PlanBrief` types; `buildPlanPrompt(args: PlanPromptArgs): string`; `parseBrief(codexOutput: string): PlanBrief`

- [ ] **Step 1: Add types to `src/types.ts`**

Append before the `// ---- 実行コマンド抽象` comment block at line 189:

```typescript
// ---- チケット濃化（A2: PLAN フェーズ） ----

export type PlanOutcome =
  | { kind: "completed"; text: string }
  | { kind: "error"; message: string };

export interface PlanRunner {
  run(ctx: { worktreePath: string; prompt: string; timeoutMs?: number }): Promise<PlanOutcome>;
}

export interface BriefSections {
  goal: string;
  changeTargets: string;
  steps: string;
  acceptance: string;
  outOfScope: string;
}

export interface PlanBrief {
  raw: string;
  sections: BriefSections | null;
}
```

Add `planBrief` to `TaskSessionRow` after the `agentSummary` field (line 52):

```typescript
  planBrief: string | null;
```

- [ ] **Step 2: Write failing tests for `parseBrief`**

Create `tests/plan-brief.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildPlanPrompt, parseBrief } from "../src/plan-brief.js";
import type { EligibleIssue, SpecContent } from "../src/types.js";

function issue(over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id: "uuid-1",
    identifier: "ES-381",
    title: "Add PLAN phase",
    description: "Implement the PLAN phase in the orchestrator.",
    priority: 2,
    sortOrder: 0,
    url: "https://linear.app/issue/ES-381",
    ...over,
  };
}

describe("parseBrief", () => {
  it("parses all 5 sections from well-formed markdown", () => {
    const output = [
      "## Goal",
      "Implement the PLAN phase.",
      "",
      "## Change Targets",
      "- src/orchestrator.ts: add PLAN phase",
      "- src/plan-brief.ts: new module",
      "",
      "## Implementation Steps",
      "1. Add types to types.ts",
      "2. Create plan-brief.ts",
      "",
      "## Acceptance Criteria",
      "- npm run check passes",
      "",
      "## Out of Scope",
      "- buildPrompt injection (ES-405)",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.raw).toBe(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Implement the PLAN phase.");
    expect(brief.sections!.changeTargets).toContain("src/orchestrator.ts");
    expect(brief.sections!.steps).toContain("1. Add types");
    expect(brief.sections!.acceptance).toContain("npm run check");
    expect(brief.sections!.outOfScope).toContain("ES-405");
  });

  it("returns sections: null for empty output", () => {
    const brief = parseBrief("");
    expect(brief.raw).toBe("");
    expect(brief.sections).toBeNull();
  });

  it("returns sections: null when no recognized headings are found", () => {
    const brief = parseBrief("Just some plain text without any headings.");
    expect(brief.sections).toBeNull();
    expect(brief.raw).toBe("Just some plain text without any headings.");
  });

  it("fills missing sections with empty string", () => {
    const output = [
      "## Goal",
      "Do the thing.",
      "",
      "## Implementation Steps",
      "1. Do it",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Do the thing.");
    expect(brief.sections!.changeTargets).toBe("");
    expect(brief.sections!.steps).toBe("1. Do it");
    expect(brief.sections!.acceptance).toBe("");
    expect(brief.sections!.outOfScope).toBe("");
  });

  it("handles case-insensitive heading matching", () => {
    const output = "## goal\nSome goal.\n\n## CHANGE TARGETS\n- file.ts";
    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Some goal.");
    expect(brief.sections!.changeTargets).toBe("- file.ts");
  });

  it("handles preamble text before the first heading", () => {
    const output = [
      "Here is my analysis of the ticket.",
      "",
      "## Goal",
      "The goal is X.",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("The goal is X.");
  });
});

describe("buildPlanPrompt", () => {
  it("includes ticket identifier, title, and output format headings", () => {
    const prompt = buildPlanPrompt({ issue: issue(), specContent: null });
    expect(prompt).toContain("ES-381");
    expect(prompt).toContain("Add PLAN phase");
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Change Targets");
    expect(prompt).toContain("## Implementation Steps");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("## Out of Scope");
  });

  it("includes requirements and domain specs when specContent is provided", () => {
    const specContent: SpecContent = {
      requirements: "Build a great product.",
      domainSpecs: [{ name: "auth", content: "Auth spec details." }],
    };
    const prompt = buildPlanPrompt({ issue: issue(), specContent });
    expect(prompt).toContain("Build a great product.");
    expect(prompt).toContain("Auth spec details.");
  });

  it("omits spec sections when specContent is null", () => {
    const prompt = buildPlanPrompt({ issue: issue(), specContent: null });
    expect(prompt).not.toContain("Product Requirements");
    expect(prompt).not.toContain("Domain Specifications");
  });

  it("shows (no description) for empty description", () => {
    const prompt = buildPlanPrompt({ issue: issue({ description: "" }), specContent: null });
    expect(prompt).toContain("(no description)");
  });

  it("includes the ticket description verbatim", () => {
    const prompt = buildPlanPrompt({
      issue: issue({ description: "Fix the bug in auth module." }),
      specContent: null,
    });
    expect(prompt).toContain("Fix the bug in auth module.");
  });

  it("is deterministic — same input produces same output", () => {
    const args = { issue: issue(), specContent: null };
    expect(buildPlanPrompt(args)).toBe(buildPlanPrompt(args));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/plan-brief.test.ts`
Expected: FAIL — module `../src/plan-brief.js` does not exist

- [ ] **Step 4: Implement `src/plan-brief.ts`**

```typescript
import type { EligibleIssue, SpecContent, PlanBrief, BriefSections } from "./types.js";

export interface PlanPromptArgs {
  issue: EligibleIssue;
  specContent: SpecContent | null;
}

export function buildPlanPrompt(args: PlanPromptArgs): string {
  const { issue, specContent } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are a software implementation planner.",
      "Given the ticket below, produce an implementation brief.",
      "",
      "The brief must help the implementing engineer understand:",
      "- WHAT: the ticket's goal (restate, do NOT invent new goals)",
      "- HOW: concrete implementation steps grounded in the codebase",
      "",
      "You have read-only access to the repository.",
      "Explore the code to ground your plan in the actual file structure and patterns.",
    ].join("\n"),
  );

  if (specContent) {
    blocks.push(["# Product Requirements", "", specContent.requirements].join("\n"));
    if (specContent.domainSpecs.length > 0) {
      const sections = specContent.domainSpecs.map(
        (s) => [`## ${s.name}`, "", s.content].join("\n"),
      );
      blocks.push(["# Domain Specifications", "", ...sections].join("\n\n"));
    }
  }

  const description = issue.description.trim().length > 0 ? issue.description : "(no description)";
  blocks.push(
    [
      "# Ticket",
      "",
      `- identifier: ${issue.identifier}`,
      `- title: ${issue.title}`,
      `- url: ${issue.url}`,
      "",
      "## Description",
      "",
      description,
    ].join("\n"),
  );

  blocks.push(
    [
      "# Output Format",
      "",
      "Produce the brief using EXACTLY these markdown headings (in this order).",
      "Each section must start with the heading on its own line.",
      "",
      "## Goal",
      "(Restate the ticket's objective. Align with the product requirements. Do NOT invent new goals.)",
      "",
      "## Change Targets",
      "(List the files and modules that need to change, with a one-line rationale for each.)",
      "",
      "## Implementation Steps",
      "(Numbered steps. Be specific — reference actual functions, types, and patterns in the codebase.)",
      "",
      "## Acceptance Criteria",
      "(How to verify the implementation is correct.)",
      "",
      "## Out of Scope",
      "(What this ticket explicitly does NOT cover.)",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}

const SECTION_HEADINGS: Array<{ key: keyof BriefSections; pattern: RegExp }> = [
  { key: "goal", pattern: /^##\s+goal\b/i },
  { key: "changeTargets", pattern: /^##\s+change\s+targets?\b/i },
  { key: "steps", pattern: /^##\s+implementation\s+steps?\b/i },
  { key: "acceptance", pattern: /^##\s+acceptance\s+criteria?\b/i },
  { key: "outOfScope", pattern: /^##\s+out\s+of\s+scope\b/i },
];

export function parseBrief(codexOutput: string): PlanBrief {
  const raw = codexOutput.trim();
  if (raw.length === 0) {
    return { raw, sections: null };
  }

  const lines = raw.split("\n");
  const found: Array<{ key: keyof BriefSections; start: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const heading of SECTION_HEADINGS) {
      if (heading.pattern.test(line)) {
        found.push({ key: heading.key, start: i });
        break;
      }
    }
  }

  if (found.length === 0) {
    return { raw, sections: null };
  }

  const partial: Partial<BriefSections> = {};
  for (let i = 0; i < found.length; i++) {
    const { key, start } = found[i]!;
    const end = i + 1 < found.length ? found[i + 1]!.start : lines.length;
    partial[key] = lines.slice(start + 1, end).join("\n").trim();
  }

  return {
    raw,
    sections: {
      goal: partial.goal ?? "",
      changeTargets: partial.changeTargets ?? "",
      steps: partial.steps ?? "",
      acceptance: partial.acceptance ?? "",
      outOfScope: partial.outOfScope ?? "",
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/plan-brief.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Run full check**

Run: `npm run check`
Expected: PASS (types.ts changes add unused types for now — no lint error since they're exported)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/plan-brief.ts tests/plan-brief.test.ts
git commit -m "feat(plan): add PlanBrief types, buildPlanPrompt, and parseBrief (ES-381)"
```

---

### Task 2: Store schema — plan_brief column

**Files:**
- Modify: `src/store.ts` — add plan_brief column to schema, RawSessionRow, toSessionRow, SESSION_PATCH_COLUMNS, updateSession Pick, migrate()
- Test: existing `tests/orchestrator.test.ts` and `tests/recovery.test.ts` (implicit; they use `:memory:` DB with the new schema)

**Interfaces:**
- Consumes: `TaskSessionRow.planBrief` from Task 1
- Produces: persistent storage of `planBrief` via `updateSession(id, { planBrief: "..." })`

- [ ] **Step 1: Add `plan_brief` to the SCHEMA string**

In `src/store.ts`, inside the `SCHEMA` constant, add `plan_brief TEXT,` after the `agent_summary TEXT,` line (line 34):

```sql
  agent_summary TEXT,
  plan_brief TEXT,
```

- [ ] **Step 2: Add `plan_brief` to `RawSessionRow`**

After `agent_summary: string | null;` (line 90):

```typescript
  plan_brief: string | null;
```

- [ ] **Step 3: Add mapping in `toSessionRow`**

After `agentSummary: r.agent_summary,` (line 111):

```typescript
    planBrief: r.plan_brief,
```

- [ ] **Step 4: Add `planBrief` to `SESSION_PATCH_COLUMNS`**

After `agentSummary: "agent_summary",` (line 134):

```typescript
  planBrief: "plan_brief",
```

- [ ] **Step 5: Add `planBrief` to `updateSession`'s `Pick` type**

In the `updateSession` method's `patch` parameter type (around line 300), add `"planBrief"` to the Pick union:

```typescript
      | "agentSummary"
      | "planBrief"
      | "monitorStartedAt"
```

- [ ] **Step 6: Add migration for existing DBs**

In the `migrate()` method, add after the `pending_restart_reason` migration block:

```typescript
    if (!columns.has("plan_brief")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN plan_brief TEXT`,
      );
    }
```

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS. The `planBrief` field is on `TaskSessionRow` (from Task 1) and the store handles it. Existing tests use `:memory:` DBs which get the new schema from `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 8: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): add plan_brief column to task_session (ES-381)"
```

---

### Task 3: Orchestrator PLAN phase + fakes + main.ts wiring

**Files:**
- Modify: `tests/fakes.ts` — add FakePlanRunner
- Modify: `src/orchestrator.ts` — add planner dep, plan() method, insert into loop()
- Modify: `src/main.ts` — create CodexPlanner, pass to Orchestrator
- Modify: `tests/orchestrator.test.ts` — add `planner: null` to makeHarness, add PLAN tests
- Modify: `tests/recovery.test.ts` — add `planner: null` to makeHarness

**Interfaces:**
- Consumes: `PlanRunner`, `PlanBrief` from Task 1; `plan_brief` column from Task 2; `CodexPlanner` from `src/codex-planner.ts`; `buildPlanPrompt`, `parseBrief` from `src/plan-brief.ts`
- Produces: PLAN phase in orchestrator loop; brief stored in DB

- [ ] **Step 1: Add `FakePlanRunner` to `tests/fakes.ts`**

Add imports at the top of `tests/fakes.ts`:

```typescript
import type { PlanRunner, PlanOutcome } from "../src/types.js";
```

Append the class at the end:

```typescript
// ---- FakePlanRunner ----
export class FakePlanRunner implements PlanRunner {
  outcomes: PlanOutcome[] = [];
  calls: Array<{ worktreePath: string; prompt: string; timeoutMs?: number }> = [];

  async run(ctx: { worktreePath: string; prompt: string; timeoutMs?: number }): Promise<PlanOutcome> {
    this.calls.push(ctx);
    const out = this.outcomes.shift();
    if (!out) throw new Error("FakePlanRunner: no outcome queued");
    return out;
  }
}
```

- [ ] **Step 2: Write failing orchestrator PLAN tests**

Add the following test block to `tests/orchestrator.test.ts`. First, add imports for the new types:

```typescript
import { FakePlanRunner } from "./fakes.js";
import type { PlanRunner } from "../src/types.js";
```

Modify `makeHarness` to accept an optional planner via second arg and wire it into the Orchestrator:

```typescript
function makeHarness(config: Config, opts?: { planner?: PlanRunner | null }): Harness {
```

Add `planner` to the Orchestrator constructor args inside `makeHarness`:

```typescript
  const orch = new Orchestrator({
    // ... existing deps ...
    planner: opts?.planner ?? null,
  });
```

The `Harness` interface and return object are unchanged — PLAN tests hold the `FakePlanRunner` ref directly.

Then add the test block:

```typescript
describe("Orchestrator PLAN phase (ES-381)", () => {
  it("generates brief via planner, persists to DB, and proceeds to IMPLEMENT", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nDo the thing.\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step one\n\n## Acceptance Criteria\n- Tests pass\n\n## Out of Scope\n- Nothing" },
    ];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Planner was called
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]!.worktreePath).toBe("/wt/ty-1");
    expect(planner.calls[0]!.prompt).toContain("TY-1");

    // Brief persisted in DB
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toContain("## Goal");
    expect(s.planBrief).toContain("Do the thing.");
  });

  it("falls back to null brief when planner returns error", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "error", message: "codex crashed" }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // Still completed — fallback worked
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("codex failed") && l.includes("codex crashed"))).toBe(true);
  });

  it("falls back to null brief when planner throws", async () => {
    const planner = new FakePlanRunner();
    // No outcomes queued → FakePlanRunner throws
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    expect(h.logs.some((l) => l.includes("codex exception"))).toBe(true);
  });

  it("skips PLAN entirely when planner is null", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config); // planner defaults to null
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");
    expect(s.planBrief).toBeNull();
    // No plan-related log lines
    expect(h.logs.some((l) => l.includes("plan:"))).toBe(false);
  });

  it("falls back when spec loading fails during PLAN (IMPLEMENT also stops)", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nShould not reach." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const specConfig = { ...config, product: { ...config.product, specDir: "docs/specs" } } as Config;
    const store = new SqliteStore(":memory:");
    const source = new FakeTaskSource();
    const agent = new FakeAgentRunner();
    const git = new FakeGitPr();
    const monitor = new FakeMonitor();
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    const orch = new Orchestrator({
      config: specConfig,
      source,
      agent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt: (args: PromptArgs) => `PROMPT for ${args.issue.identifier}`,
      specLoader: () => { throw new Error("requirements.md not found"); },
      clock: fixedClock("2026-06-05T00:00:00.000Z"),
      sleep: instantSleep(),
      log: (line: string) => { logs.push(line); },
      recovery: new FakeWorkflowRecovery(),
      planner,
    });

    source.queue = [issue("issue-A", "TY-1")];
    agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    monitor.verdicts = [{ kind: "merged" }];

    await orch.run();

    // PLAN fell back gracefully (did not halt the loop)
    expect(planner.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("plan: spec loading failed"))).toBe(true);
    // IMPLEMENT independently also fails on spec loading → session stopped
    const s = store.sessionsForRun(store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.planBrief).toBeNull();
  });

  it("passes codexTimeoutMinutes as timeoutMs to the planner", async () => {
    const planner = new FakePlanRunner();
    planner.outcomes = [{ kind: "completed", text: "## Goal\nDone." }];
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "done" }];
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    // codexTimeoutMinutes=30 → 30 * 60_000 = 1_800_000 ms
    expect(planner.calls[0]!.timeoutMs).toBe(30 * 60_000);
  });
});
```

- [ ] **Step 3: Run PLAN tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "PLAN phase"`
Expected: FAIL — Orchestrator does not accept `planner` property

- [ ] **Step 4: Add `planner` to `OrchestratorDeps` and update the orchestrator constructor**

In `src/orchestrator.ts`, add to imports:

```typescript
import type { PlanRunner, PlanBrief, PlanOutcome, SpecContent } from "./types.js";
```

Update the existing import to include `PlanRunner` (or just add to the import list — `SpecContent` is already imported).

Add to `OrchestratorDeps` interface:

```typescript
  planner: PlanRunner | null;
```

Add to the class fields (after `private readonly recovery`):

```typescript
  private readonly planner: PlanRunner | null;
```

Add to the constructor body:

```typescript
    this.planner = deps.planner;
```

Add the import of `buildPlanPrompt` and `parseBrief` at the top of the file:

```typescript
import { buildPlanPrompt, parseBrief } from "./plan-brief.js";
```

- [ ] **Step 5: Add the `plan()` method to the Orchestrator class**

Add after the `claim()` method (around line 509):

```typescript
  // ---- PLAN（スコープ doc A2 / §1.1 / §1.5） ----
  private async plan(
    session: TaskSessionRow,
    issue: EligibleIssue,
  ): Promise<{ control: "continue"; brief: PlanBrief | null } | { control: "halt" }> {
    if (this.planner === null) {
      return { control: "continue", brief: null };
    }

    const worktreePath = session.worktreePath as string;

    let specContent: SpecContent | null = null;
    const specDir = this.config.product.specDir;
    if (specDir !== undefined && this.specLoader !== null) {
      try {
        specContent = this.specLoader(worktreePath, specDir);
      } catch (err) {
        this.log(`plan: spec loading failed, falling back to raw ticket: ${errMsg(err)}`);
        return { control: "continue", brief: null };
      }
    }

    const prompt = buildPlanPrompt({ issue, specContent });

    let outcome: PlanOutcome;
    try {
      outcome = await this.planner.run({
        worktreePath,
        prompt,
        timeoutMs: this.config.safety.codexTimeoutMinutes * 60_000,
      });
    } catch (err) {
      this.log(`plan: codex exception, falling back to raw ticket: ${errMsg(err)}`);
      return { control: "continue", brief: null };
    }

    if (outcome.kind === "error") {
      this.log(`plan: codex failed, falling back to raw ticket: ${outcome.message}`);
      return { control: "continue", brief: null };
    }

    const brief = parseBrief(outcome.text);
    this.log(`plan: brief generated (sections=${brief.sections !== null ? "parsed" : "raw-only"})`);
    this.store.updateSession(session.id, { planBrief: brief.raw });

    return { control: "continue", brief };
  }
```

- [ ] **Step 6: Insert PLAN into `loop()`**

In the `loop()` method, between CLAIM and IMPLEMENT (after line 447 `const session = claim.session;`), insert:

```typescript
      // 4) PLAN
      const plan = await this.plan(session, issue);
      if (plan.control === "halt") return;
```

Then renumber the existing comments:

```typescript
      // 5) IMPLEMENT (was 4)
      // 6) HANDOFF (was 5)
      // 7) MONITOR (was 6)
      // 8) DONE (was 7)
```

- [ ] **Step 7: Update all existing Orchestrator instantiation sites**

Add `planner: null,` to every existing `new Orchestrator({...})` call:

1. `tests/orchestrator.test.ts` line 100 (in `makeHarness`):
   ```typescript
   planner: opts?.planner ?? null,
   ```

2. `tests/orchestrator.test.ts` line 599 (inline spec-loading test):
   ```typescript
   planner: null,
   ```

3. `tests/recovery.test.ts` line 100 (in `makeHarness`):
   ```typescript
   planner: null,
   ```

4. `src/main.ts` line 191 — see next step.

- [ ] **Step 8: Wire CodexPlanner in `src/main.ts`**

Add import:

```typescript
import { CodexPlanner } from "./codex-planner.js";
```

Before the `new Orchestrator(...)` call (around line 190), create the CodexPlanner:

```typescript
    const codexPlanner = new CodexPlanner(runner, {
      log: logLine,
      defaultTimeoutMs: config.safety.codexTimeoutMinutes * 60_000,
    });
```

Add `planner: codexPlanner,` to the Orchestrator constructor args:

```typescript
    const orchestrator = new Orchestrator({
      // ... existing deps ...
      planner: codexPlanner,
    });
```

- [ ] **Step 9: Run the PLAN tests to verify they pass**

Run: `npx vitest run tests/orchestrator.test.ts -t "PLAN phase"`
Expected: all PLAN phase tests PASS

- [ ] **Step 10: Run full check**

Run: `npm run check`
Expected: PASS — typecheck, lint, and all tests green

- [ ] **Step 11: Commit**

```bash
git add src/orchestrator.ts src/main.ts tests/fakes.ts tests/orchestrator.test.ts tests/recovery.test.ts
git commit -m "feat(orchestrator): add PLAN phase with CodexPlanner brief generation (ES-381)"
```
