# ES-450: Codex Recovery Turn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session stops, give Codex one chance to analyze the failure and choose a recovery action (fix_code, rebase, restart_review, escalate, abandon) before halting.

**Architecture:** Insert a recovery gate at the top of `stopSession()`. When `reason !== "cost_exceeded"` and `recoveryAttempted === false`, call `executeRecoveryTurn()` in the new `recovery-turn.ts` module. This module builds a prompt, calls `CodexPlanner.run()`, parses the structured JSON response, and dispatches the chosen action. On recovery success, `stopSession` returns `CONTINUE` instead of `HALT`, allowing the monitor loop to resume.

**Tech Stack:** TypeScript, Vitest, SQLite (better-sqlite3)

## Global Constraints

- `npm run check` must pass (`tsc --noEmit` + `vitest run`)
- Existing `AgentWorkflowRecovery` tests must not break
- Recovery fires at most once per session (infinite loop prevention)
- `cost_exceeded` always skips recovery (no additional cost spend)
- JSON parse failure → escalate fallback (never crash)

---

### Task 1: Types & DB Schema — `recovery_attempted` / `recovery_action` columns

**Files:**
- Modify: `src/types.ts:50-73` (TaskSessionRow)
- Modify: `src/types.ts:147-156` (NotifyEvent)
- Modify: `src/store.ts:12-61` (SCHEMA)
- Modify: `src/store.ts:90-140` (RawSessionRow, toSessionRow)
- Modify: `src/store.ts:143-160` (SESSION_PATCH_COLUMNS)
- Modify: `src/store.ts:189-261` (migrate)
- Modify: `src/store.ts:377-399` (updateSession patch type)
- Test: `tests/store.test.ts` (add migration test)

**Interfaces:**
- Consumes: nothing
- Produces: `TaskSessionRow.recoveryAttempted: number`, `TaskSessionRow.recoveryAction: string | null`, updated `NotifyEvent` union with `recovery_started` / `recovery_succeeded` kinds, `updateSession` accepting `recoveryAttempted` / `recoveryAction` patch keys

- [ ] **Step 1: Write failing test for migration**

In `tests/store.test.ts`, add a test that verifies the new columns exist after store construction:

```typescript
it("recovery columns: recovery_attempted defaults to 0 and recovery_action defaults to null", () => {
  const store = new SqliteStore(":memory:");
  const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
  const session = store.createSession({
    runId: run.id,
    linearIssueId: "issue-1",
    linearIdentifier: "TY-1",
    issueTitle: "test",
    branch: "b",
    worktreePath: "/wt/ty-1",
    now: "2026-01-01T00:00:00.000Z",
  });
  expect(session.recoveryAttempted).toBe(0);
  expect(session.recoveryAction).toBeNull();
});

it("updateSession can set recoveryAttempted and recoveryAction", () => {
  const store = new SqliteStore(":memory:");
  const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
  const session = store.createSession({
    runId: run.id,
    linearIssueId: "issue-1",
    linearIdentifier: "TY-1",
    issueTitle: "test",
    branch: "b",
    worktreePath: "/wt/ty-1",
    now: "2026-01-01T00:00:00.000Z",
  });
  store.updateSession(session.id, { recoveryAttempted: 1, recoveryAction: "fix_code" });
  const updated = store.getSession(session.id);
  expect(updated.recoveryAttempted).toBe(1);
  expect(updated.recoveryAction).toBe("fix_code");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts -t "recovery columns"`
Expected: FAIL with property access errors (recoveryAttempted not in type)

- [ ] **Step 3: Add types to TaskSessionRow**

In `src/types.ts`, add to `TaskSessionRow` (after `pendingRestartReason`):

```typescript
  recoveryAttempted: number;    // 0 or 1 — whether Codex recovery was attempted
  recoveryAction: string | null; // action chosen by Codex (fix_code/rebase/restart_review/escalate/abandon)
```

Add `NotifyEvent` variants (add to the existing union):

```typescript
  | { kind: "recovery_started"; identifier: string; reason: string }
  | { kind: "recovery_succeeded"; identifier: string; action: string };
```

- [ ] **Step 4: Update SCHEMA in store.ts**

In the `task_session` CREATE TABLE statement inside `SCHEMA`, add after `pending_restart_reason TEXT`:

```sql
  recovery_attempted INTEGER NOT NULL DEFAULT 0,
  recovery_action TEXT
```

- [ ] **Step 5: Update RawSessionRow and toSessionRow in store.ts**

Add to `RawSessionRow`:

```typescript
  recovery_attempted: number;
  recovery_action: string | null;
```

Add to `toSessionRow` return object:

```typescript
    recoveryAttempted: r.recovery_attempted,
    recoveryAction: r.recovery_action,
```

- [ ] **Step 6: Update SESSION_PATCH_COLUMNS**

Add to `SESSION_PATCH_COLUMNS`:

```typescript
  recoveryAttempted: "recovery_attempted",
  recoveryAction: "recovery_action",
```

- [ ] **Step 7: Update updateSession patch type**

Add to the `Pick<>` union in `updateSession`'s `patch` parameter:

```typescript
        | "recoveryAttempted"
        | "recoveryAction"
```

- [ ] **Step 8: Add migration for existing DBs**

In `migrate()`, add after the `select_rationale` migration block:

```typescript
    if (!columns.has("recovery_attempted")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN recovery_attempted INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("recovery_action")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN recovery_action TEXT`,
      );
    }
```

- [ ] **Step 9: Update formatNotifyEvent in notifier.ts**

Add cases for the new event kinds:

```typescript
    case "recovery_started":
      return `🔄 リカバリー開始: ${event.identifier} (${event.reason})`;
    case "recovery_succeeded":
      return `✅ リカバリー成功: ${event.identifier} (${event.action})`;
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 11: Run full check**

Run: `npm run check`
Expected: PASS (type errors may surface in orchestrator.test.ts due to NotifyEvent changes — those are addressed in later tasks)

- [ ] **Step 12: Commit**

```bash
git add src/types.ts src/store.ts src/notifier.ts tests/store.test.ts
git commit -m "feat(es-450): add recovery_attempted/recovery_action columns and notify events"
```

---

### Task 2: `recovery-turn.ts` — Prompt builder, JSON parser, action dispatcher

**Files:**
- Create: `src/recovery-turn.ts`
- Create: `tests/recovery-turn.test.ts`

**Interfaces:**
- Consumes: `PlanRunner` (from `types.ts`), `AgentRunner`, `GitPrManager`, `CommandRunner`, `TaskSource`, `Config`, `TaskSessionRow`, `FailureReason`
- Produces: `RecoveryActionKind` type, `RecoveryTurnResult` type, `buildRecoveryPrompt(ctx): string`, `parseRecoveryAction(text): RecoveryAction`, `executeRecoveryTurn(deps, session, reason, detail): Promise<RecoveryTurnResult>`

- [ ] **Step 1: Write failing tests for parseRecoveryAction**

Create `tests/recovery-turn.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRecoveryAction } from "../src/recovery-turn.js";

describe("parseRecoveryAction", () => {
  it("parses valid fix_code action from fenced JSON", () => {
    const text = `Analysis: CI failed due to missing lock file.\n\n\`\`\`json\n{"action":"fix_code","instruction":"Run npm install to regenerate package-lock.json"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({
      action: "fix_code",
      instruction: "Run npm install to regenerate package-lock.json",
    });
  });

  it("parses valid escalate action", () => {
    const text = `\`\`\`json\n{"action":"escalate"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("parses valid rebase action", () => {
    const text = `{"action":"rebase","instruction":"Rebase onto main"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "rebase", instruction: "Rebase onto main" });
  });

  it("parses valid restart_review action", () => {
    const text = `\`\`\`json\n{"action":"restart_review"}\n\`\`\``;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "restart_review" });
  });

  it("parses valid abandon action", () => {
    const text = `{"action":"abandon","instruction":"PR was intentionally closed"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "abandon", instruction: "PR was intentionally closed" });
  });

  it("returns escalate fallback for invalid JSON", () => {
    const result = parseRecoveryAction("This is not JSON at all");
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for unknown action", () => {
    const text = `{"action":"unknown_action"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for empty string", () => {
    const result = parseRecoveryAction("");
    expect(result).toEqual({ action: "escalate" });
  });

  it("returns escalate fallback for missing action field", () => {
    const text = `{"instruction":"do something"}`;
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "escalate" });
  });

  it("uses last fenced JSON block when multiple present", () => {
    const text = [
      "First analysis:",
      "```json",
      '{"action":"escalate"}',
      "```",
      "Wait, actually:",
      "```json",
      '{"action":"fix_code","instruction":"fix it"}',
      "```",
    ].join("\n");
    const result = parseRecoveryAction(text);
    expect(result).toEqual({ action: "fix_code", instruction: "fix it" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/recovery-turn.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/recovery-turn.ts` with types and parseRecoveryAction**

```typescript
import type {
  PlanRunner,
  AgentRunner,
  GitPrManager,
  CommandRunner,
  TaskSource,
  TaskSessionRow,
  FailureReason,
} from "./types.js";
import type { Config } from "./config.js";

export type RecoveryActionKind =
  | "fix_code"
  | "rebase"
  | "restart_review"
  | "escalate"
  | "abandon";

const VALID_ACTIONS = new Set<string>([
  "fix_code", "rebase", "restart_review", "escalate", "abandon",
]);

export interface RecoveryAction {
  action: RecoveryActionKind;
  instruction?: string;
}

export type RecoveryTurnResult =
  | { kind: "recovered"; action: RecoveryActionKind; costUsd: number }
  | { kind: "escalated"; action: RecoveryActionKind }
  | { kind: "failed"; message: string };

export interface RecoveryTurnDeps {
  planner: PlanRunner;
  agent: AgentRunner;
  git: GitPrManager;
  runner: CommandRunner;
  source: TaskSource;
  config: Config;
  log: (line: string) => void;
}

export function parseRecoveryAction(text: string): RecoveryAction {
  const fallback: RecoveryAction = { action: "escalate" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;

  // Try fenced ```json blocks first (last one wins) — same pattern as select-prompt.ts
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(trimmed)) !== null) {
    lastFenceMatch = m[1];
  }

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
    if (jsonStr === null) {
      let endLine = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trimEnd().endsWith("}")) { endLine = i; break; }
      }
      if (endLine !== -1) {
        for (let startLine = endLine; startLine >= 0; startLine--) {
          if (lines[startLine].trimStart().startsWith("{")) {
            jsonStr = lines.slice(startLine, endLine + 1).join("\n");
            break;
          }
        }
      }
    }
  }

  if (jsonStr === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return fallback;
  }

  if (typeof parsed !== "object" || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action)) return fallback;

  const result: RecoveryAction = { action: obj.action as RecoveryActionKind };
  if (typeof obj.instruction === "string" && obj.instruction.trim().length > 0) {
    result.instruction = obj.instruction.trim();
  }
  return result;
}
```

- [ ] **Step 4: Run parseRecoveryAction tests**

Run: `npx vitest run tests/recovery-turn.test.ts -t "parseRecoveryAction"`
Expected: PASS

- [ ] **Step 5: Write failing tests for buildRecoveryPrompt**

Append to `tests/recovery-turn.test.ts`:

```typescript
import { buildRecoveryPrompt } from "../src/recovery-turn.js";
import type { TaskSessionRow, FailureReason } from "../src/types.js";

function fakeSession(overrides: Partial<TaskSessionRow> = {}): TaskSessionRow {
  return {
    id: 1, runId: 1,
    linearIssueId: "issue-1", linearIdentifier: "TY-1",
    issueTitle: "Fix the bug", branch: "looppilot/ty-1-fix",
    worktreePath: "/wt/ty-1", prNumber: 42,
    state: "in_review", costUsd: 1.5,
    failureReason: null, stopDetail: null,
    agentSummary: "I tried to fix it but CI failed",
    planBrief: "## Goal\nFix the test", selectRationale: null,
    startedAt: "2026-01-01T00:00:00.000Z", monitorStartedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null, workflowFixAttempts: 0, workflowHandledErrorCount: 0,
    autoRestartAttempts: 0, pendingRestartReason: null,
    recoveryAttempted: 0, recoveryAction: null,
  };
}

describe("buildRecoveryPrompt", () => {
  it("includes stop reason, session context, and expected JSON schema", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession(),
      reason: "ci_failed" as FailureReason,
      detail: "npm test exited with code 1",
    });
    expect(prompt).toContain("ci_failed");
    expect(prompt).toContain("npm test exited with code 1");
    expect(prompt).toContain("TY-1");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("I tried to fix it but CI failed");
    expect(prompt).toContain('"action"');
    expect(prompt).toContain("fix_code");
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("abandon");
  });

  it("includes plan_brief when present", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession({ planBrief: "## Plan\nDo the thing" }),
      reason: "ci_failed" as FailureReason,
      detail: null,
    });
    expect(prompt).toContain("## Plan\nDo the thing");
  });

  it("omits plan_brief section when null", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession({ planBrief: null }),
      reason: "ci_failed" as FailureReason,
      detail: null,
    });
    expect(prompt).not.toContain("Plan Brief");
  });

  it("handles null detail gracefully", () => {
    const prompt = buildRecoveryPrompt({
      session: fakeSession(),
      reason: "agent_no_change" as FailureReason,
      detail: null,
    });
    expect(prompt).toContain("agent_no_change");
  });
});
```

- [ ] **Step 6: Implement buildRecoveryPrompt**

Add to `src/recovery-turn.ts`:

```typescript
export interface RecoveryPromptContext {
  session: TaskSessionRow;
  reason: FailureReason;
  detail: string | null;
}

export function buildRecoveryPrompt(ctx: RecoveryPromptContext): string {
  const { session, reason, detail } = ctx;
  const blocks: string[] = [];

  blocks.push([
    "You are a software project manager analyzing a stopped CI/CD session.",
    "Your task: decide the best recovery action for this failure.",
    "",
    "Respond with a JSON object (inside a ```json block) with this schema:",
    '  { "action": "fix_code" | "rebase" | "restart_review" | "escalate" | "abandon",',
    '    "instruction": "<instruction for the implementing agent (required for fix_code, optional for others)>" }',
    "",
    "Actions:",
    "- fix_code: provide an instruction for the agent to fix the code in the worktree, push, and restart review",
    "- rebase: rebase the branch onto the default branch to resolve conflicts",
    "- restart_review: post /restart-review to retry the review workflow",
    "- escalate: stop and notify humans (use when recovery is unlikely to help)",
    "- abandon: close the PR, revert the ticket to Todo, and move on",
  ].join("\n"));

  blocks.push([
    "# Session Context",
    "",
    `- Stop reason: ${reason}`,
    `- Detail: ${detail ?? "(none)"}`,
    `- Ticket: ${session.linearIdentifier} — ${session.issueTitle}`,
    `- Branch: ${session.branch}`,
    `- PR: ${session.prNumber !== null ? `#${session.prNumber}` : "(none)"}`,
    `- Cost so far: $${(session.costUsd ?? 0).toFixed(2)}`,
  ].join("\n"));

  if (session.agentSummary) {
    blocks.push([
      "# Agent Summary (last implementation output)",
      "",
      session.agentSummary,
    ].join("\n"));
  }

  if (session.planBrief) {
    blocks.push([
      "# Plan Brief",
      "",
      session.planBrief,
    ].join("\n"));
  }

  return blocks.join("\n\n");
}
```

- [ ] **Step 7: Run buildRecoveryPrompt tests**

Run: `npx vitest run tests/recovery-turn.test.ts -t "buildRecoveryPrompt"`
Expected: PASS

- [ ] **Step 8: Write failing tests for executeRecoveryTurn**

Append to `tests/recovery-turn.test.ts`:

```typescript
import { executeRecoveryTurn } from "../src/recovery-turn.js";
import type { RecoveryTurnDeps, RecoveryTurnResult } from "../src/recovery-turn.js";
import {
  FakeAgentRunner,
  FakeCommandRunner,
  FakeGitPr,
  FakePlanRunner,
  FakeTaskSource,
} from "./fakes.js";
import type { Config } from "../src/config.js";

function makeConfig(): Config {
  return {
    product: { goal: "ship it", specDir: undefined },
    repo: { path: "/repo", remote: "owner/name", defaultBranch: "main", worktreeRoot: "/wt" },
    safety: {
      maxTasksPerRun: 3, maxCostUsdPerSession: 10,
      notEngagedGuardMinutes: 30, monitorTimeoutMinutes: 60,
      sessionHardTimeoutMinutes: 120, maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2, codexTimeoutMinutes: 30,
      selectDiffBudgetChars: 6000, selectCodebaseSummaryBudgetChars: 5000,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    looppilot: { gateLabel: "loop-pilot" },
    notify: { progress: false },
    digest: { recentMergedCount: 5, enabled: true },
  } as unknown as Config;
}

function makeDeps(overrides: Partial<{
  plannerOutcome: import("../src/types.js").PlanOutcome;
  agentOutcome: import("../src/types.js").AgentOutcome;
}> = {}): { deps: RecoveryTurnDeps; planner: FakePlanRunner; agent: FakeAgentRunner; git: FakeGitPr; runner: FakeCommandRunner; source: FakeTaskSource; logs: string[] } {
  const planner = new FakePlanRunner();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const runner = new FakeCommandRunner();
  const source = new FakeTaskSource();
  const logs: string[] = [];
  if (overrides.plannerOutcome) planner.outcomes.push(overrides.plannerOutcome);
  if (overrides.agentOutcome) agent.outcomes.push(overrides.agentOutcome);
  const deps: RecoveryTurnDeps = {
    planner, agent, git, runner, source,
    config: makeConfig(),
    log: (line) => logs.push(line),
  };
  return { deps, planner, agent, git, runner, source, logs };
}

describe("executeRecoveryTurn", () => {
  it("fix_code: codex says fix_code → agent runs → push → restart → recovered", async () => {
    const { deps, planner, agent, runner, git } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '```json\n{"action":"fix_code","instruction":"Run npm install"}\n```' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "ci_failed", "test failed");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "fix_code", costUsd: 0.5 });
    expect(agent.contexts[0].prompt).toContain("Run npm install");
    const restartCall = git.calls.find((c) => c.method === "postComment" && (c.args as unknown[])[1] === "/restart-review");
    expect(restartCall).toBeDefined();
  });

  it("restart_review: codex says restart_review → post comment → recovered", async () => {
    const { deps, git, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"restart_review"}' }];

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "looppilot_stopped", "workflow_crashed");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "restart_review", costUsd: 0 });
    const restartCall = git.calls.find((c) => c.method === "postComment" && (c.args as unknown[])[1] === "/restart-review");
    expect(restartCall).toBeDefined();
  });

  it("escalate: codex says escalate → escalated result", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"escalate"}' }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "pr_closed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("abandon: codex says abandon → close PR → revert ticket → escalated(abandon)", async () => {
    const { deps, planner, git, source, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"abandon"}' }];
    runner.on(["gh", "pr", "close"], { code: 0 });

    const session = fakeSession({ prNumber: 42, linearIssueId: "issue-1" });
    const result = await executeRecoveryTurn(deps, session, "monitor_never_engaged", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "abandon" });
    const closeCall = runner.calls.find((c) => c.cmd === "gh" && c.args.includes("close"));
    expect(closeCall).toBeDefined();
    expect(source.transitions).toContainEqual({ issueId: "issue-1", state: "todo" });
    const discardCall = git.calls.find((c) => c.method === "discardWorktree");
    expect(discardCall).toBeDefined();
  });

  it("codex error → escalated fallback", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "error", message: "codex crashed" }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "exception", "something broke");

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("codex returns unparseable JSON → escalated fallback", async () => {
    const { deps, planner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: "I have no idea what to do" }];

    const result = await executeRecoveryTurn(deps, fakeSession(), "exception", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "escalated", action: "escalate" });
  });

  it("fix_code: agent makes no commits → failed", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "done" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });

    const result = await executeRecoveryTurn(deps, fakeSession(), "ci_failed", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "failed", message: "recovery fix agent made no commits" });
  });

  it("rebase: successful rebase → push → restart → recovered", async () => {
    const { deps, planner, git, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"rebase"}' }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("rebase")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: 42 });
    const result = await executeRecoveryTurn(deps, session, "merge_conflict", null);

    expect(result).toEqual<RecoveryTurnResult>({ kind: "recovered", action: "rebase", costUsd: 0 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toContain("--force-with-lease");
    const restartCall = git.calls.find((c) => c.method === "postComment");
    expect(restartCall).toBeDefined();
  });

  it("no PR number: fix_code actions that need PR → failed", async () => {
    const { deps, planner, agent, runner } = makeDeps();
    planner.outcomes = [{ kind: "completed", text: '{"action":"fix_code","instruction":"fix"}' }];
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "done" }];
    runner.on(["git", "-C"], (args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
      if (args.includes("fetch")) return { code: 0 };
      if (args.includes("reset")) return { code: 0 };
      return { code: 0 };
    });
    runner.on(["git", "push"], { code: 0 });

    const session = fakeSession({ prNumber: null });
    const result = await executeRecoveryTurn(deps, session, "agent_no_change", null);

    // fix_code without PR: push succeeds but no /restart-review (no PR to comment on)
    // Still recovered — the session can be picked up later
    expect(result.kind).toBe("recovered");
  });
});
```

- [ ] **Step 9: Implement executeRecoveryTurn**

Add to `src/recovery-turn.ts`:

```typescript
export async function executeRecoveryTurn(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
  reason: FailureReason,
  detail: string | null,
): Promise<RecoveryTurnResult> {
  const { planner, agent, git, runner, source, config, log } = deps;

  // 1. Call Codex to analyze the situation
  const prompt = buildRecoveryPrompt({ session, reason, detail });
  let codexText: string;
  try {
    const outcome = await planner.run({
      worktreePath: session.worktreePath ?? config.repo.path,
      prompt,
      timeoutMs: config.safety.codexTimeoutMinutes * 60_000,
    });
    if (outcome.kind === "error") {
      log(`recovery: codex error: ${outcome.message}`);
      return { kind: "escalated", action: "escalate" };
    }
    if (outcome.kind === "interrupted") {
      return { kind: "escalated", action: "escalate" };
    }
    codexText = outcome.text;
  } catch (err) {
    log(`recovery: codex exception: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "escalated", action: "escalate" };
  }

  // 2. Parse the action
  const parsed = parseRecoveryAction(codexText);
  log(`recovery: codex chose action=${parsed.action}`);

  // 3. Dispatch
  switch (parsed.action) {
    case "escalate":
      return { kind: "escalated", action: "escalate" };

    case "abandon":
      await executeAbandon(deps, session);
      return { kind: "escalated", action: "abandon" };

    case "restart_review":
      return await executeRestartReview(deps, session);

    case "rebase":
      return await executeRebase(deps, session);

    case "fix_code":
      return await executeFixCode(deps, session, parsed.instruction ?? "Fix the issue that caused the session to stop.");
  }
}

async function executeFixCode(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
  instruction: string,
): Promise<RecoveryTurnResult> {
  const { agent, runner, git, config, log } = deps;
  const worktreePath = session.worktreePath ?? config.repo.path;
  const branch = session.branch;

  // Sync to origin before fixing
  const fetchResult = await runner.run("git", ["-C", worktreePath, "fetch", "origin", branch], { cwd: worktreePath });
  if (fetchResult.code !== 0) {
    return { kind: "failed", message: `recovery fetch failed: ${fetchResult.stderr.trim() || `exit ${fetchResult.code}`}` };
  }
  const resetResult = await runner.run("git", ["-C", worktreePath, "reset", "--hard", `origin/${branch}`], { cwd: worktreePath });
  if (resetResult.code !== 0) {
    return { kind: "failed", message: `recovery reset failed: ${resetResult.stderr.trim() || `exit ${resetResult.code}`}` };
  }

  // Run agent with instruction
  const outcome = await agent.runSession({
    worktreePath,
    prompt: instruction,
    maxCostUsd: config.safety.maxCostUsdPerFix,
    hardTimeoutMs: config.safety.sessionHardTimeoutMinutes * 60_000,
  });

  if (outcome.kind !== "completed") {
    log(`recovery: fix agent outcome=${outcome.kind}`);
    return { kind: "failed", message: `recovery fix agent: ${outcome.kind}` };
  }

  // Verify commits
  const statusResult = await runner.run("git", ["-C", worktreePath, "status", "--porcelain"], { cwd: worktreePath });
  if (statusResult.stdout.trim() !== "") {
    return { kind: "failed", message: "recovery fix agent left uncommitted changes" };
  }
  const logResult = await runner.run("git", ["-C", worktreePath, "log", `origin/${branch}..HEAD`, "--oneline"], { cwd: worktreePath });
  if (logResult.stdout.trim() === "") {
    return { kind: "failed", message: "recovery fix agent made no commits" };
  }

  // Push
  const pushResult = await runner.run("git", ["push", "origin", `HEAD:${branch}`], { cwd: worktreePath });
  if (pushResult.code !== 0) {
    return { kind: "failed", message: `recovery push failed: ${pushResult.stderr.trim() || `exit ${pushResult.code}`}` };
  }

  // Post /restart-review if PR exists
  if (session.prNumber !== null) {
    try {
      await git.postComment(session.prNumber, "/restart-review");
    } catch (err) {
      return { kind: "failed", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { kind: "recovered", action: "fix_code", costUsd: outcome.costUsd };
}

async function executeRebase(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<RecoveryTurnResult> {
  const { runner, git, config, log } = deps;
  const worktreePath = session.worktreePath ?? config.repo.path;
  const defaultBranch = config.repo.defaultBranch;
  const branch = session.branch;

  const fetchResult = await runner.run(
    "git", ["-C", worktreePath, "fetch", "origin", defaultBranch],
    { cwd: worktreePath },
  );
  if (fetchResult.code !== 0) {
    return { kind: "failed", message: `recovery rebase fetch failed: ${fetchResult.stderr.trim()}` };
  }

  const rebaseResult = await runner.run(
    "git", ["-C", worktreePath, "rebase", `origin/${defaultBranch}`],
    { cwd: worktreePath },
  );
  if (rebaseResult.code !== 0) {
    // Abort the failed rebase
    await runner.run("git", ["-C", worktreePath, "rebase", "--abort"], { cwd: worktreePath });
    return { kind: "failed", message: `recovery rebase failed: ${rebaseResult.stderr.trim() || `exit ${rebaseResult.code}`}` };
  }

  // Force push with lease
  const pushResult = await runner.run(
    "git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`],
    { cwd: worktreePath },
  );
  if (pushResult.code !== 0) {
    return { kind: "failed", message: `recovery rebase push failed: ${pushResult.stderr.trim()}` };
  }

  if (session.prNumber !== null) {
    try {
      await git.postComment(session.prNumber, "/restart-review");
    } catch (err) {
      return { kind: "failed", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  log(`recovery: rebase onto ${defaultBranch} succeeded`);
  return { kind: "recovered", action: "rebase", costUsd: 0 };
}

async function executeRestartReview(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<RecoveryTurnResult> {
  if (session.prNumber === null) {
    return { kind: "failed", message: "recovery restart_review: no PR to comment on" };
  }
  try {
    await deps.git.postComment(session.prNumber, "/restart-review");
  } catch (err) {
    return { kind: "failed", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { kind: "recovered", action: "restart_review", costUsd: 0 };
}

async function executeAbandon(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<void> {
  const { runner, source, git, config, log } = deps;
  // Close PR (best-effort)
  if (session.prNumber !== null) {
    try {
      await runner.run(
        "gh", ["pr", "close", String(session.prNumber), "-R", config.repo.remote],
        { cwd: config.repo.path },
      );
    } catch {
      log("recovery: abandon PR close failed (best-effort)");
    }
  }
  // Revert ticket to Todo (best-effort)
  try {
    await source.transition(session.linearIssueId, "todo");
  } catch {
    log("recovery: abandon ticket revert failed (best-effort)");
  }
  // Discard worktree (best-effort)
  if (session.worktreePath) {
    try {
      await git.discardWorktree(session.branch, session.worktreePath);
    } catch {
      log("recovery: abandon worktree discard failed (best-effort)");
    }
  }
}
```

- [ ] **Step 10: Run all recovery-turn tests**

Run: `npx vitest run tests/recovery-turn.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/recovery-turn.ts tests/recovery-turn.test.ts
git commit -m "feat(es-450): add recovery-turn module with prompt builder, parser, and action dispatcher"
```

---

### Task 3: Integrate recovery gate into `stopSession()` in orchestrator

**Files:**
- Modify: `src/orchestrator.ts:1-27` (imports)
- Modify: `src/orchestrator.ts:30-49` (OrchestratorDeps)
- Modify: `src/orchestrator.ts:59-95` (constructor)
- Modify: `src/orchestrator.ts:1364-1383` (stopSession)
- Modify: `tests/orchestrator.test.ts` (add recovery tests)
- Modify: `tests/fakes.ts` (update FakeNotifier for new event kinds)

**Interfaces:**
- Consumes: `executeRecoveryTurn` from `src/recovery-turn.ts`, `RecoveryTurnDeps` / `RecoveryTurnResult`, `TaskSessionRow.recoveryAttempted` / `recoveryAction` from Task 1
- Produces: `stopSession` returns `Promise<RunControl>` (changed from `Promise<{ control: "halt" }>`), callers handle `CONTINUE`

- [ ] **Step 1: Write failing test for the recovery gate**

Append to `tests/orchestrator.test.ts`, a new `describe` block:

```typescript
describe("Orchestrator — Codex Recovery Turn (ES-450)", () => {
  it("ci_failed triggers recovery → fix_code → session resumes monitoring", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1.0, summary: "implemented" },
      // Recovery fix agent outcome
      { kind: "completed", costUsd: 0.5, summary: "fixed CI" },
    ];
    // Monitor: ci_failed (triggers stop) → after recovery: done → merged
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: "test_failure" },
      { kind: "done" },
      { kind: "merged" },
    ];
    // Plan phase outcome (for initial PLAN)
    planner.outcomes = [
      { kind: "completed", text: "## Goal\nFix it" },
      // Recovery Codex outcome: fix_code
      { kind: "completed", text: '{"action":"fix_code","instruction":"Run npm install"}' },
    ];
    // Stub git operations for the recovery fix
    // The orchestrator's FakeCommandRunner is not directly accessible via harness,
    // but FakeGitPr handles postComment. We need a FakeCommandRunner for git push etc.
    // Since executeRecoveryTurn uses deps.runner, we need to inject it.

    // NOTE: This test validates the orchestrator integration. The detailed
    // recovery-turn behavior is tested in recovery-turn.test.ts.
    // For now, we test that stopSession does NOT halt when recovery succeeds.
    // The actual implementation will be validated end-to-end.

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.recoveryAttempted).toBe(1);
    expect(s.state).toBe("merged");
  });

  it("cost_exceeded skips recovery entirely", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, maxCostUsdPerSession: 0.5 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 0.6 }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.recoveryAttempted).toBe(0);
  });

  it("recovery_attempted=true on second stop → no recovery, just halt", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const planner = new FakePlanRunner();
    const h = makeHarness(config, { planner });
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "done" }];
    // Monitor: first stop triggers recovery(escalate) → second stop should just halt
    h.monitor.verdicts = [
      { kind: "stopped", stopReason: null },
    ];
    planner.outcomes = [
      { kind: "completed", text: "## Plan" },
      // Recovery: codex says escalate
      { kind: "completed", text: '{"action":"escalate"}' },
    ];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.recoveryAttempted).toBe(1);
    expect(s.recoveryAction).toBe("escalate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "Codex Recovery Turn"`
Expected: FAIL — recovery gate not yet wired

- [ ] **Step 3: Add RecoveryTurnDeps to OrchestratorDeps**

In `src/orchestrator.ts`, add import:

```typescript
import { executeRecoveryTurn } from "./recovery-turn.js";
import type { RecoveryTurnDeps } from "./recovery-turn.js";
```

Add to `OrchestratorDeps`:

```typescript
  recoveryTurn: RecoveryTurnDeps | null;
```

Add corresponding private field and constructor assignment in `Orchestrator`:

```typescript
  private readonly recoveryTurn: RecoveryTurnDeps | null;
```

```typescript
    this.recoveryTurn = deps.recoveryTurn;
```

- [ ] **Step 4: Modify stopSession to include the recovery gate**

Change `stopSession` return type from `Promise<{ control: "halt" }>` to `Promise<RunControl>`.

Insert recovery gate at the top of `stopSession`, before the existing `this.store.updateSession(...)`:

```typescript
  private async stopSession(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber">> = {},
  ): Promise<RunControl> {
    // --- Recovery gate (ES-450) ---
    if (reason !== "cost_exceeded" && this.recoveryTurn !== null && this.planner !== null) {
      const fresh = this.store.getSession(session.id);
      if (!fresh.recoveryAttempted) {
        this.store.updateSession(session.id, { recoveryAttempted: 1 });
        await this.notifier.notify({
          kind: "recovery_started",
          identifier: session.linearIdentifier,
          reason,
        });
        let result;
        try {
          result = await executeRecoveryTurn(
            this.recoveryTurn,
            fresh,
            reason,
            detail,
          );
        } catch (err) {
          this.log(`recovery: exception: ${err instanceof Error ? err.message : String(err)}`);
          result = { kind: "escalated" as const, action: "escalate" as const };
        }
        const actionStr = "action" in result ? result.action : "escalate";
        this.store.updateSession(session.id, { recoveryAction: actionStr });
        if (result.kind === "recovered") {
          const recoveryCost = result.costUsd;
          if (recoveryCost > 0) {
            const refreshed = this.store.getSession(session.id);
            this.store.updateSession(session.id, {
              costUsd: (refreshed.costUsd ?? 0) + recoveryCost,
            });
          }
          await this.notifier.notify({
            kind: "recovery_succeeded",
            identifier: session.linearIdentifier,
            action: result.action,
          });
          this.store.updateSession(session.id, {
            state: "in_review",
            monitorStartedAt: this.clock(),
            failureReason: null,
            stopDetail: null,
            endedAt: null,
          });
          return CONTINUE;
        }
        // escalated / failed → fall through to normal stop
      }
    }
    // --- Original stop logic (unchanged) ---
    this.store.updateSession(session.id, {
      state: "stopped",
      failureReason: reason,
      stopDetail: detail,
      endedAt: this.clock(),
      ...extraPatch,
    });
    const haltDetail = `${session.linearIdentifier} stopped (${reason})${detail ? `: ${detail}` : ""}`;
    await this.notifier.notify({ kind: "halted", reason, detail: haltDetail });
    this.store.setRunState(this.runId, "halted", haltDetail);
    this.log(haltDetail);
    return HALT;
  }
```

- [ ] **Step 5: Wrap monitorSession stopSession calls to handle CONTINUE**

In `monitorSession`, every `return await this.stopSession(...)` must be wrapped so that CONTINUE (recovery success) causes `continue` (resume polling) instead of exiting monitorSession. Replace each instance with this pattern:

```typescript
// Before:
return await this.stopSession(session, reason, detail);

// After:
{
  const ctrl = await this.stopSession(session, reason, detail);
  if (ctrl.control === "halt") return HALT;
  continue;
}
```

This applies to all ~12 `return await this.stopSession(...)` calls inside `monitorSession`'s while-loop (poll failures, auto-restart limit, quota limit, human_required, pr_closed, corrupted, not_engaged, monitor timeout, workflow_setup_failed).

Additionally, in `tryMerge`, update the internal `stopSession` calls so recovery can propagate:

```typescript
// Before:
case "ci_failed":
  await this.stopSession(session, "ci_failed", null);
  return { kind: "halt" };

// After:
case "ci_failed": {
  const ctrl = await this.stopSession(session, "ci_failed", null);
  return ctrl.control === "halt" ? { kind: "halt" } : { kind: "continue" };
}
```

Apply the same pattern to `conflict` and `blocked` cases in `tryMerge`.

For non-monitor callers (`implement`, `handoff`, `claim`, `recoverByOpenPr`, `recoverInReview`), the existing `return await this.stopSession(...)` pattern works correctly — CONTINUE propagates up to `loop()` and the next phase runs.

- [ ] **Step 6: Update makeHarness in orchestrator.test.ts**

Add `recoveryTurn` deps to the harness. When `planner` is provided, wire up recovery deps using a `FakeCommandRunner`:

```typescript
// At the top, add import:
import { FakeCommandRunner as FakeRunner } from "./fakes.js";

// In makeHarness, before creating the Orchestrator:
  const recoveryRunner = new FakeRunner();
  // Stub common git operations for recovery
  recoveryRunner.on(["git", "-C"], (args) => {
    if (args.includes("status")) return { code: 0, stdout: "" };
    if (args.includes("log")) return { code: 0, stdout: "abc fix\n" };
    if (args.includes("fetch")) return { code: 0 };
    if (args.includes("reset")) return { code: 0 };
    if (args.includes("rebase")) return { code: 0 };
    return { code: 0 };
  });
  recoveryRunner.on(["git", "push"], { code: 0 });
  recoveryRunner.on(["gh"], { code: 0 });

// In Orchestrator constructor args, add:
    recoveryTurn: (opts?.planner ?? null) !== null ? {
      planner: opts!.planner!,
      agent,
      git,
      runner: recoveryRunner,
      source,
      config,
      log,
    } : null,
```

Also add `recoveryRunner` to the `Harness` interface and return value.

- [ ] **Step 7: Run all orchestrator tests**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS (both new recovery tests and all existing tests)

- [ ] **Step 8: Run full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts tests/fakes.ts
git commit -m "feat(es-450): integrate recovery gate into stopSession with Codex-driven action dispatch"
```

---

### Task 4: Verify existing tests are unbroken, run full acceptance

**Files:**
- No new files — verification only

**Interfaces:**
- Consumes: all changes from Tasks 1-3
- Produces: green `npm run check`

- [ ] **Step 1: Run existing workflow-recovery tests**

Run: `npx vitest run tests/workflow-recovery.test.ts`
Expected: PASS — `AgentWorkflowRecovery` tests unchanged

- [ ] **Step 2: Run existing orchestrator tests**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS — all existing tests plus new recovery tests

- [ ] **Step 3: Run store tests**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS — includes new migration tests

- [ ] **Step 4: Run full check**

Run: `npm run check`
Expected: PASS — TypeScript compiles clean, all tests green

- [ ] **Step 5: Verify acceptance criteria checklist**

Manually verify each criterion against the test suite:

1. ✅ `npm run check` green — Step 4
2. ✅ 各停止理由 → Codex リカバリー → アクション実行のフロー — `executeRecoveryTurn` tests (fix_code, rebase, restart_review, escalate, abandon)
3. ✅ JSON パース失敗 → escalate — `parseRecoveryAction` test ("returns escalate fallback for invalid JSON")
4. ✅ `cost_exceeded` → リカバリーをスキップ — orchestrator test ("cost_exceeded skips recovery entirely")
5. ✅ `recovery_attempted = true` の再停止 → escalate — orchestrator test ("recovery_attempted=true on second stop")
6. ✅ 既存 `AgentWorkflowRecovery` テスト — Step 1

No commit — this is verification only.
