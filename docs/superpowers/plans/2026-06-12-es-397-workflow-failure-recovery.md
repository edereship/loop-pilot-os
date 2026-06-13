# ES-397: Workflow Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect LoopPilot workflow early failures via ⚠️ comment markers, auto-fix with AgentRunner, and re-trigger via `/restart-review`.

**Architecture:** New `workflow_failed` MonitorVerdict detected in `poll()` by scanning for ⚠️-prefixed comments from trusted authors. New `WorkflowRecovery` interface (types.ts) with `AgentWorkflowRecovery` implementation (workflow-recovery.ts) that runs an agent to fix, pushes, and posts `/restart-review`. Orchestrator calls recovery via interface; v2 swaps in CodexPlanner-guided implementation.

**Tech Stack:** TypeScript, vitest, gh CLI, existing CommandRunner/AgentRunner abstractions

**Spec:** `docs/superpowers/specs/2026-06-12-es-397-workflow-failure-recovery-design.md`

---

### Task 1: Types — `workflow_failed` verdict, `workflow_setup_failed` reason, `WorkflowRecovery` interface

**Files:**
- Modify: `src/types.ts`
- Modify: `tests/types.test.ts`

- [ ] **Step 1: Add `workflow_setup_failed` to `FailureReason` union in `src/types.ts`**

In `src/types.ts`, add `"workflow_setup_failed"` to the `FailureReason` union:

```typescript
export type FailureReason =
  | "agent_no_change"
  | "cost_exceeded"
  | "exception"
  | "monitor_never_engaged"
  | "looppilot_stopped"
  | "ci_failed"
  | "merge_conflict"
  | "pr_closed"
  | "claim_failed"
  | "handoff_failed"
  | "workflow_setup_failed";
```

- [ ] **Step 2: Add `workflow_failed` to `MonitorVerdict` union in `src/types.ts`**

Add the new variant after `pr_closed`:

```typescript
export type MonitorVerdict =
  | { kind: "merged" }
  | { kind: "done" }
  | { kind: "stopped"; stopReason: string | null }
  | { kind: "in_progress" }
  | { kind: "corrupted" }
  | { kind: "not_engaged" }
  | { kind: "pr_closed" }
  | { kind: "workflow_failed"; errorBody: string; errorCommentCount: number };
```

- [ ] **Step 3: Add `RecoveryContext`, `RecoveryOutcome`, `WorkflowRecovery` interface to `src/types.ts`**

Append before the `// ---- 文脈バンドル` section:

```typescript
// ---- ワークフロー回復（workflow-recovery.ts） ----
export interface RecoveryContext {
  worktreePath: string;
  branch: string;
  prNumber: number;
  errorBody: string;
  errorCommentCount: number;
  maxCostUsd: number;
}
export type RecoveryOutcome =
  | { kind: "restarted"; costUsd: number }
  | { kind: "exhausted"; costUsd: number }
  | { kind: "unrecoverable"; costUsd: number; message: string };
export interface WorkflowRecovery {
  attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome>;
}
```

- [ ] **Step 4: Update `FailureReason` exhaustive test in `tests/types.test.ts`**

In the `FailureReason` test, update the array and switch to include the new value (11 total):

```typescript
  it("FailureReason は仕様 §7 の 11 種の失敗理由を網羅する", () => {
    const all = [
      "agent_no_change",
      "cost_exceeded",
      "exception",
      "monitor_never_engaged",
      "looppilot_stopped",
      "ci_failed",
      "merge_conflict",
      "pr_closed",
      "claim_failed",
      "handoff_failed",
      "workflow_setup_failed",
    ] as const satisfies readonly FailureReason[];
    const ensureExhaustive = (r: FailureReason): (typeof all)[number] => {
      switch (r) {
        case "agent_no_change":
        case "cost_exceeded":
        case "exception":
        case "monitor_never_engaged":
        case "looppilot_stopped":
        case "ci_failed":
        case "merge_conflict":
        case "pr_closed":
        case "claim_failed":
        case "handoff_failed":
        case "workflow_setup_failed":
          return r;
        default: {
          const never: never = r;
          return never;
        }
      }
    };
    expect(all.map(ensureExhaustive).length).toBe(11);
  });
```

- [ ] **Step 5: Update `MonitorVerdict` exhaustive test in `tests/types.test.ts`**

Update the MonitorVerdict test to include `workflow_failed` (8 kinds, note `stopped` has two entries for `stopReason` null and string):

```typescript
  it("MonitorVerdict は kind で 8 バリアントを判別でき、stopped は stopReason に null を保持できる", () => {
    const variants = [
      { kind: "merged" },
      { kind: "done" },
      { kind: "stopped", stopReason: null },
      { kind: "stopped", stopReason: "build failed" },
      { kind: "in_progress" },
      { kind: "corrupted" },
      { kind: "not_engaged" },
      { kind: "pr_closed" },
      { kind: "workflow_failed", errorBody: "⚠️ failure", errorCommentCount: 1 },
    ] as const satisfies readonly MonitorVerdict[];

    const describe = (v: MonitorVerdict): string => {
      switch (v.kind) {
        case "merged":
          return "merged";
        case "done":
          return "done";
        case "stopped":
          return v.stopReason ?? "stopped(no reason)";
        case "in_progress":
          return "in_progress";
        case "corrupted":
          return "corrupted";
        case "not_engaged":
          return "not_engaged";
        case "pr_closed":
          return "pr_closed";
        case "workflow_failed":
          return `workflow_failed(${v.errorCommentCount})`;
        default: {
          const never: never = v;
          return never;
        }
      }
    };
    expect(variants.map(describe)).toContain("stopped(no reason)");
    expect(variants.map(describe)).toContain("workflow_failed(1)");
  });
```

- [ ] **Step 6: Add `WorkflowRecovery` interface assignability test in `tests/types.test.ts`**

In the `モジュールインターフェース` describe block, add a test that verifies the new types compile:

```typescript
  it("RecoveryContext / RecoveryOutcome / WorkflowRecovery はインターフェースを満たす実装に代入できる", () => {
    const ctx: RecoveryContext = {
      worktreePath: "/tmp/wt",
      branch: "looppilot/ty-1-fix",
      prNumber: 42,
      errorBody: "⚠️ workflow failed",
      errorCommentCount: 1,
      maxCostUsd: 2.0,
    };
    const outcomes = [
      { kind: "restarted", costUsd: 0.5 },
      { kind: "exhausted", costUsd: 1.5 },
      { kind: "unrecoverable", costUsd: 0.3, message: "agent error" },
    ] as const satisfies readonly RecoveryOutcome[];
    const recovery: WorkflowRecovery = {
      attemptRecovery: async (_ctx: RecoveryContext): Promise<RecoveryOutcome> =>
        outcomes[0],
    };
    expect(ctx.prNumber).toBe(42);
    expect(outcomes).toHaveLength(3);
    expect(recovery.attemptRecovery).toBeTypeOf("function");
  });
```

Add `RecoveryContext`, `RecoveryOutcome`, `WorkflowRecovery` to the import block at the top of the test file.

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/types.test.ts`
Expected: ALL PASS. Compile also succeeds: `npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add workflow_failed verdict, workflow_setup_failed reason, WorkflowRecovery interface (ES-397)"
```

---

### Task 2: Config — `max_workflow_fix_attempts` and `max_cost_usd_per_fix`

**Files:**
- Modify: `src/config.ts`
- Create: `tests/fixtures/config-valid.toml` (modify existing)
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Add zod fields to `rawSchema` in `src/config.ts`**

Inside the `safety` object of `rawSchema` (after `session_hard_timeout_minutes`), add:

```typescript
    max_workflow_fix_attempts: z.number().int().positive().default(2),
    max_cost_usd_per_fix: z.number().positive().default(2),
```

- [ ] **Step 2: Add camelCase fields to `Config` interface in `src/config.ts`**

Inside `safety` in the `Config` interface (after `sessionHardTimeoutMinutes`), add:

```typescript
    maxWorkflowFixAttempts: number;
    maxCostUsdPerFix: number;
```

- [ ] **Step 3: Map in the return object of `loadConfig` in `src/config.ts`**

In the `safety` object of the return statement (after `sessionHardTimeoutMinutes`), add:

```typescript
      maxWorkflowFixAttempts: raw.safety.max_workflow_fix_attempts,
      maxCostUsdPerFix: raw.safety.max_cost_usd_per_fix,
```

- [ ] **Step 4: Write the failing test for defaults in `tests/config.test.ts`**

Add a test verifying defaults load from `config-minimal.toml` (which has no `max_workflow_fix_attempts` or `max_cost_usd_per_fix`):

```typescript
  it("max_workflow_fix_attempts and max_cost_usd_per_fix default to 2 and 2.0", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.maxWorkflowFixAttempts).toBe(2);
    expect(config.safety.maxCostUsdPerFix).toBe(2);
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts -t "max_workflow_fix_attempts"`
Expected: PASS (defaults applied from zod `.default()`)

- [ ] **Step 6: Update the full-load test assertion in `tests/config.test.ts`**

In the existing `"loads a fully-specified config"` test, add assertions after the existing `sessionHardTimeoutMinutes` check:

```typescript
    expect(config.safety.maxWorkflowFixAttempts).toBe(2); // default (not in config-valid.toml)
    expect(config.safety.maxCostUsdPerFix).toBe(2); // default (not in config-valid.toml)
```

- [ ] **Step 7: Run full config tests**

Run: `npx vitest run tests/config.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add max_workflow_fix_attempts and max_cost_usd_per_fix safety keys (ES-397)"
```

---

### Task 3: Monitor — detect ⚠️ error comments in `poll()`

**Files:**
- Modify: `src/monitor.ts`
- Modify: `tests/monitor.test.ts`

- [ ] **Step 1: Write the failing test — ⚠️ + state=initialized → workflow_failed**

In `tests/monitor.test.ts`, add a new `describe` block after the existing ones:

```typescript
describe("GhLoopPilotMonitor.poll — ⚠️ error comment detection (ES-397)", () => {
  it("⚠️コメント1件 + state=initialized → workflow_failed(count=1, body=⚠️コメント)", async () => {
    const errorBody = "⚠️ **LoopPilot Workflow B failed before the auto-fix loop could start.**";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
          {
            author: "github-actions[bot]",
            body: errorBody,
          },
        ],
      ]),
    });
    expect(await monitor.poll(50)).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody,
      errorCommentCount: 1,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/monitor.test.ts -t "⚠️コメント1件"`
Expected: FAIL — currently returns `{ kind: "in_progress" }`

- [ ] **Step 3: Refactor `findTrustedStateComment` to also count ⚠️ comments**

In `src/monitor.ts`, replace the current `findTrustedStateComment` method and extract a combined scanner. Replace the `poll()` method body after the merged/closed checks:

Replace the block starting at `const trusted = await this.findTrustedStateComment(prNumber);` through the end of the method with:

```typescript
    const { stateComment, errorCommentCount, latestErrorBody } =
      await this.scanTrustedComments(prNumber);

    if (stateComment === null) {
      if (errorCommentCount > 0) {
        return {
          kind: "workflow_failed",
          errorBody: latestErrorBody!,
          errorCommentCount,
        };
      }
      return { kind: "not_engaged" };
    }

    const status = this.extractStatus(stateComment.body);
    if (status === null) {
      return { kind: "corrupted" };
    }
    if (status.status === "stopped") {
      return { kind: "stopped", stopReason: status.stopReason };
    }
    if (status.status === "done") {
      return { kind: "done" };
    }
    // initialized | waiting_codex | fixing
    if (errorCommentCount > 0) {
      return {
        kind: "workflow_failed",
        errorBody: latestErrorBody!,
        errorCommentCount,
      };
    }
    return { kind: "in_progress" };
```

Then rename `findTrustedStateComment` to `scanTrustedComments` and change its return type:

```typescript
  private async scanTrustedComments(
    prNumber: number,
  ): Promise<{
    stateComment: IssueComment | null;
    errorCommentCount: number;
    latestErrorBody: string | null;
  }> {
    const result = await this.runner.run(
      "gh",
      [
        "api",
        `repos/${this.owner}/${this.name}/issues/${prNumber}/comments`,
        "--paginate",
        "--slurp",
      ],
      { cwd: process.cwd() },
    );
    if (result.code !== 0) {
      throw new Error(
        `gh api comments failed for PR #${prNumber}: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    const pages = JSON.parse(result.stdout) as IssueComment[][];
    const comments: IssueComment[] = pages.flat();

    let stateComment: IssueComment | null = null;
    let errorCommentCount = 0;
    let latestErrorBody: string | null = null;

    for (const c of comments) {
      if (!c.user || !this.trustedAuthors.includes(c.user.login)) continue;

      // State comment check (existing rules 2-4)
      if (
        c.body.startsWith(STATE_COMMENT_VISIBLE_TEXT) &&
        c.body.includes(STATE_COMMENT_OPEN)
      ) {
        stateComment = c;
        continue;
      }

      // ⚠️ error comment check
      if (c.body.startsWith("⚠️")) {
        errorCommentCount++;
        latestErrorBody = c.body;
      }
    }

    return { stateComment, errorCommentCount, latestErrorBody };
  }
```

- [ ] **Step 4: Run the first test to verify it passes**

Run: `npx vitest run tests/monitor.test.ts -t "⚠️コメント1件"`
Expected: PASS

- [ ] **Step 5: Write remaining ⚠️ detection tests**

Add the following tests in the same `describe` block:

```typescript
  it("⚠️コメント2件 + stateコメントなし → workflow_failed(count=2, body=最新)", async () => {
    const error1 = "⚠️ first failure";
    const error2 = "⚠️ second failure";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          { author: "github-actions[bot]", body: error1 },
          { author: "github-actions[bot]", body: error2 },
        ],
      ]),
    });
    const verdict = await monitor.poll(51);
    expect(verdict).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody: error2,
      errorCommentCount: 2,
    });
  });

  it("⚠️コメント0件 + state=initialized → in_progress（既存動作不変）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(52)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("⚠️コメント0件 + stateコメントなし → not_engaged（既存動作不変）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([[]]),
    });
    expect(await monitor.poll(53)).toEqual<MonitorVerdict>({ kind: "not_engaged" });
  });

  it("⚠️コメント1件 + state=done → done（done が優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
          { author: "github-actions[bot]", body: "⚠️ old failure" },
        ],
      ]),
    });
    expect(await monitor.poll(54)).toEqual<MonitorVerdict>({ kind: "done" });
  });

  it("⚠️コメント1件 + state=stopped → stopped（stopped が優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "stopped", stopReason: "max_iterations" }),
          },
          { author: "github-actions[bot]", body: "⚠️ old failure" },
        ],
      ]),
    });
    expect(await monitor.poll(55)).toEqual<MonitorVerdict>({
      kind: "stopped",
      stopReason: "max_iterations",
    });
  });

  it("偽装著者の⚠️は無視し、信頼著者の⚠️のみカウントする", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          { author: "attacker", body: "⚠️ fake error" },
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(56)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("stateコメントは⚠️カウントに含めない（STATE_COMMENT_VISIBLE_TEXT先頭はstate優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(57)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("⚠️が複数ページに跨ぐ場合でもカウントが正確", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "waiting_codex", stopReason: null }),
          },
          { author: "github-actions[bot]", body: "⚠️ page 1 error" },
        ],
        [
          { author: "github-actions[bot]", body: "⚠️ page 2 error" },
        ],
      ]),
    });
    const verdict = await monitor.poll(58);
    expect(verdict).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody: "⚠️ page 2 error",
      errorCommentCount: 2,
    });
  });
```

- [ ] **Step 6: Run all monitor tests**

Run: `npx vitest run tests/monitor.test.ts`
Expected: ALL PASS (existing + new tests)

- [ ] **Step 7: Commit**

```bash
git add src/monitor.ts tests/monitor.test.ts
git commit -m "feat(monitor): detect ⚠️ error comments and return workflow_failed verdict (ES-397)"
```

---

### Task 4: WorkflowRecovery module — `AgentWorkflowRecovery`

**Files:**
- Create: `src/workflow-recovery.ts`
- Create: `tests/workflow-recovery.test.ts`

- [ ] **Step 1: Write the failing test — successful fix attempt**

Create `tests/workflow-recovery.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AgentWorkflowRecovery } from "../src/workflow-recovery.js";
import { FakeAgentRunner, FakeCommandRunner } from "./fakes.js";
import type { RecoveryContext, RecoveryOutcome } from "../src/types.js";

const REMOTE = "acme/widget";

function makeRecovery(opts: {
  maxAttempts?: number;
} = {}): {
  recovery: AgentWorkflowRecovery;
  agent: FakeAgentRunner;
  runner: FakeCommandRunner;
  logs: string[];
} {
  const agent = new FakeAgentRunner();
  const runner = new FakeCommandRunner();
  const logs: string[] = [];
  const recovery = new AgentWorkflowRecovery(
    agent,
    runner,
    REMOTE,
    opts.maxAttempts ?? 2,
    (line) => logs.push(line),
  );
  return { recovery, agent, runner, logs };
}

function ctx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    worktreePath: "/wt/ty-1",
    branch: "looppilot/ty-1-fix",
    prNumber: 42,
    errorBody: "⚠️ workflow failed",
    errorCommentCount: overrides.errorCommentCount ?? 1,
    maxCostUsd: 2.0,
    ...overrides,
  };
}

describe("AgentWorkflowRecovery", () => {
  it("successful fix: agent completes → push → /restart-review → restarted", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.5, summary: "fixed lock file" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.5 });
    const pushCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toEqual(["push", "origin", "looppilot/ty-1-fix"]);
    expect(pushCall!.opts.cwd).toBe("/wt/ty-1");
    const commentCall = runner.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr");
    expect(commentCall).toBeDefined();
    expect(commentCall!.args).toEqual(["pr", "comment", "42", "-R", REMOTE, "-b", "/restart-review"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workflow-recovery.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `AgentWorkflowRecovery` in `src/workflow-recovery.ts`**

Create `src/workflow-recovery.ts`:

```typescript
import type {
  AgentRunner,
  CommandRunner,
  RecoveryContext,
  RecoveryOutcome,
  WorkflowRecovery,
} from "./types.js";

export function buildFixPrompt(errorBody: string): string {
  return `The LoopPilot review workflow failed with the following error:

---
${errorBody}
---

Fix the issue in this repository so the workflow can succeed.
Common infrastructure fixes include:
- Generate missing package-lock.json (run \`npm install\`)
- Fix dependency version mismatches
- Fix configuration files required by CI

Commit your changes with a clear message describing the fix.
Do NOT push — the orchestrator handles pushing.`;
}

export class AgentWorkflowRecovery implements WorkflowRecovery {
  private fixAttempts = 0;
  private totalCostUsd = 0;

  constructor(
    private readonly agent: AgentRunner,
    private readonly runner: CommandRunner,
    private readonly remote: string,
    private readonly maxAttempts: number,
    private readonly log: (line: string) => void,
  ) {}

  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome> {
    if (ctx.errorCommentCount <= this.fixAttempts) {
      return { kind: "restarted", costUsd: 0 };
    }

    if (this.fixAttempts >= this.maxAttempts) {
      return { kind: "exhausted", costUsd: this.totalCostUsd };
    }

    const outcome = await this.agent.runSession({
      worktreePath: ctx.worktreePath,
      prompt: buildFixPrompt(ctx.errorBody),
      maxCostUsd: ctx.maxCostUsd,
    });

    if (outcome.kind === "cost_exceeded") {
      this.totalCostUsd += outcome.costUsd;
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: "fix agent exceeded cost limit",
      };
    }
    if (outcome.kind === "error") {
      this.totalCostUsd += outcome.costUsd;
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: outcome.message,
      };
    }

    this.totalCostUsd += outcome.costUsd;

    await this.pushFix(ctx.branch, ctx.worktreePath);
    await this.postRestartReview(ctx.prNumber);

    this.fixAttempts++;
    this.log(
      `workflow fix attempt ${this.fixAttempts}/${this.maxAttempts} ` +
        `for PR #${ctx.prNumber} (cost=$${outcome.costUsd.toFixed(2)})`,
    );
    return { kind: "restarted", costUsd: outcome.costUsd };
  }

  private async pushFix(
    branch: string,
    worktreePath: string,
  ): Promise<void> {
    const result = await this.runner.run(
      "git",
      ["push", "origin", branch],
      { cwd: worktreePath },
    );
    if (result.code !== 0) {
      throw new Error(
        `git push failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
  }

  private async postRestartReview(prNumber: number): Promise<void> {
    const result = await this.runner.run(
      "gh",
      [
        "pr",
        "comment",
        String(prNumber),
        "-R",
        this.remote,
        "-b",
        "/restart-review",
      ],
      { cwd: process.cwd() },
    );
    if (result.code !== 0) {
      throw new Error(
        `gh pr comment failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run the first test to verify it passes**

Run: `npx vitest run tests/workflow-recovery.test.ts -t "successful fix"`
Expected: PASS

- [ ] **Step 5: Write remaining tests**

Add these tests in the same `describe` block in `tests/workflow-recovery.test.ts`:

```typescript
  it("already handled: errorCommentCount <= fixAttempts → restarted(costUsd=0)", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.3, summary: "fix" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    const result = await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));

    expect(result).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0 });
  });

  it("exhausted: fixAttempts >= maxAttempts → exhausted", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 1 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.5, summary: "fix1" },
    ];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    const result = await recovery.attemptRecovery(ctx({ errorCommentCount: 2 }));

    expect(result).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.5 });
  });

  it("agent error → unrecoverable", async () => {
    const { recovery, agent } = makeRecovery();
    agent.outcomes = [{ kind: "error", costUsd: 0.1, message: "agent crashed" }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 0.1,
      message: "agent crashed",
    });
  });

  it("agent cost_exceeded → unrecoverable", async () => {
    const { recovery, agent } = makeRecovery();
    agent.outcomes = [{ kind: "cost_exceeded", costUsd: 2.0 }];

    const result = await recovery.attemptRecovery(ctx());

    expect(result).toEqual<RecoveryOutcome>({
      kind: "unrecoverable",
      costUsd: 2.0,
      message: "fix agent exceeded cost limit",
    });
  });

  it("git push failure → throws", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    runner.on(["git", "push"], { code: 1, stderr: "rejected" });

    await expect(recovery.attemptRecovery(ctx())).rejects.toThrow(/git push failed/);
  });

  it("gh pr comment failure → throws", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.2, summary: "fix" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 1, stderr: "not found" });

    await expect(recovery.attemptRecovery(ctx())).rejects.toThrow(/gh pr comment failed/);
  });

  it("two successful fixes increment fixAttempts correctly", async () => {
    const { recovery, agent, runner } = makeRecovery({ maxAttempts: 2 });
    agent.outcomes = [
      { kind: "completed", costUsd: 0.3, summary: "fix1" },
      { kind: "completed", costUsd: 0.4, summary: "fix2" },
    ];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    const r1 = await recovery.attemptRecovery(ctx({ errorCommentCount: 1 }));
    expect(r1).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.3 });

    const r2 = await recovery.attemptRecovery(ctx({ errorCommentCount: 2 }));
    expect(r2).toEqual<RecoveryOutcome>({ kind: "restarted", costUsd: 0.4 });

    const r3 = await recovery.attemptRecovery(ctx({ errorCommentCount: 3 }));
    expect(r3).toEqual<RecoveryOutcome>({ kind: "exhausted", costUsd: 0.7 });
  });

  it("buildFixPrompt includes the error body", async () => {
    const { recovery, agent, runner } = makeRecovery();
    agent.outcomes = [{ kind: "completed", costUsd: 0.1, summary: "ok" }];
    runner.on(["git", "push"], { code: 0 });
    runner.on(["gh", "pr", "comment"], { code: 0 });

    await recovery.attemptRecovery(ctx({ errorBody: "⚠️ CUSTOM ERROR" }));

    expect(agent.contexts[0].prompt).toContain("⚠️ CUSTOM ERROR");
    expect(agent.contexts[0].worktreePath).toBe("/wt/ty-1");
    expect(agent.contexts[0].maxCostUsd).toBe(2.0);
  });
```

- [ ] **Step 6: Run all workflow-recovery tests**

Run: `npx vitest run tests/workflow-recovery.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/workflow-recovery.ts tests/workflow-recovery.test.ts
git commit -m "feat(workflow-recovery): add AgentWorkflowRecovery for auto-fixing workflow failures (ES-397)"
```

---

### Task 5: Orchestrator — handle `workflow_failed` verdict in `monitorSession()`

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `tests/fakes.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Add `FakeWorkflowRecovery` to `tests/fakes.ts`**

Append to `tests/fakes.ts`:

```typescript
// ---- FakeWorkflowRecovery ----
export class FakeWorkflowRecovery implements WorkflowRecovery {
  /** attemptRecovery が順に shift して返す結果。尽きたら最後を返し続ける */
  outcomes: RecoveryOutcome[] = [];
  /** 呼び出し記録 */
  recoveryCalls: RecoveryContext[] = [];

  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome> {
    this.recoveryCalls.push(ctx);
    if (this.outcomes.length > 1) {
      return this.outcomes.shift() as RecoveryOutcome;
    }
    if (this.outcomes.length === 1) {
      return this.outcomes[0];
    }
    throw new Error("FakeWorkflowRecovery: no outcome queued");
  }
}
```

Add `WorkflowRecovery`, `RecoveryContext`, `RecoveryOutcome` to the imports at the top of `tests/fakes.ts`.

- [ ] **Step 2: Add `recovery` to `OrchestratorDeps` in `src/orchestrator.ts`**

In the import block at the top, add `RecoveryContext`, `RecoveryOutcome`, `WorkflowRecovery` to the imports from `./types.js`.

In `OrchestratorDeps`, add after `log`:

```typescript
  recovery: WorkflowRecovery;
```

In the `Orchestrator` class, add a private field after `log`:

```typescript
  private readonly recovery: WorkflowRecovery;
```

In the constructor, add after `this.log = deps.log;`:

```typescript
    this.recovery = deps.recovery;
```

- [ ] **Step 3: Add `workflow_failed` case to `monitorSession()` switch**

In `monitorSession()`, add a new case after the `case "in_progress"` block (before the closing `}` of the switch):

```typescript
        case "workflow_failed": {
          const recoveryCtx: RecoveryContext = {
            worktreePath: session.worktreePath as string,
            branch: session.branch,
            prNumber,
            errorBody: verdict.errorBody,
            errorCommentCount: verdict.errorCommentCount,
            maxCostUsd: this.config.safety.maxCostUsdPerFix,
          };
          let recoveryResult: RecoveryOutcome;
          try {
            recoveryResult = await this.recovery.attemptRecovery(recoveryCtx);
          } catch (err) {
            return await this.stopSession(
              session,
              "workflow_setup_failed",
              `workflow recovery error: ${errMsg(err)}`,
            );
          }
          if (recoveryResult.kind === "restarted") {
            if (recoveryResult.costUsd > 0) {
              const current = this.store.getSession(session.id);
              const newCost = (current.costUsd ?? 0) + recoveryResult.costUsd;
              this.store.updateSession(session.id, { costUsd: newCost });
            }
            continue;
          }
          const detail =
            recoveryResult.kind === "exhausted"
              ? `workflow fix attempts exhausted (${this.config.safety.maxWorkflowFixAttempts}x)`
              : `workflow fix failed: ${recoveryResult.message}`;
          return await this.stopSession(
            session,
            "workflow_setup_failed",
            detail,
          );
        }
```

- [ ] **Step 4: Update `makeHarness` in `tests/orchestrator.test.ts`**

Import `FakeWorkflowRecovery` from `./fakes.js`. In the `Harness` interface, add:

```typescript
  recovery: FakeWorkflowRecovery;
```

In `makeHarness()`, create the fake and wire it:

```typescript
  const recovery = new FakeWorkflowRecovery();
```

Add `recovery` to the `Orchestrator` constructor deps and to the returned harness object.

Also update `makeConfig` to include the new safety fields with defaults:

```typescript
  maxWorkflowFixAttempts: number;
  maxCostUsdPerFix: number;
```

And in the Config return add (inside the `safety` block):

```typescript
      maxWorkflowFixAttempts: over.maxWorkflowFixAttempts ?? 2,
      maxCostUsdPerFix: over.maxCostUsdPerFix ?? 2,
```

- [ ] **Step 5: Write the failing test — workflow_failed → restarted → polling continues**

Add a new `describe` block in `tests/orchestrator.test.ts`:

```typescript
describe("MONITOR — workflow_failed verdict (ES-397)", () => {
  it("workflow_failed → restarted(cost>0) → costUsd updated, polling continues to merged", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf", "TY-WF1");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 1 },
      { kind: "merged" },
    ];
    h.recovery.outcomes = [{ kind: "restarted", costUsd: 0.5 }];

    await h.orch.run();

    expect(h.recovery.recoveryCalls).toHaveLength(1);
    expect(h.recovery.recoveryCalls[0].errorBody).toBe("⚠️ failed");
    const session = h.store.activeSessions().length === 0
      ? h.store.getSession(1)
      : h.store.activeSessions()[0];
    expect(session.costUsd).toBe(1.5);
    expect(session.state).toBe("merged");
  });

  it("workflow_failed → exhausted → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf2", "TY-WF2");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ failed", errorCommentCount: 3 },
    ];
    h.recovery.outcomes = [{ kind: "exhausted", costUsd: 1.0 }];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("exhausted");
  });

  it("workflow_failed → unrecoverable → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf3", "TY-WF3");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ err", errorCommentCount: 1 },
    ];
    h.recovery.outcomes = [{ kind: "unrecoverable", costUsd: 0.1, message: "agent crashed" }];

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("agent crashed");
  });

  it("recovery throws → stopSession(workflow_setup_failed)", async () => {
    const config = makeConfig();
    const h = makeHarness(config);
    const iss = issue("id-wf4", "TY-WF4");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.0, summary: "impl" }];
    h.monitor.verdicts = [
      { kind: "workflow_failed", errorBody: "⚠️ err", errorCommentCount: 1 },
    ];
    // FakeWorkflowRecovery with no outcomes queued → throws

    await h.orch.run();

    const session = h.store.getSession(1);
    expect(session.state).toBe("stopped");
    expect(session.failureReason).toBe("workflow_setup_failed");
    expect(session.stopDetail).toContain("workflow recovery error");
  });
});
```

- [ ] **Step 6: Run orchestrator tests**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: ALL PASS (existing + new tests)

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts tests/fakes.ts tests/orchestrator.test.ts
git commit -m "feat(orchestrator): handle workflow_failed verdict with recovery loop (ES-397)"
```

---

### Task 6: DI wiring in `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add import for `AgentWorkflowRecovery`**

Add to the imports at the top of `src/main.ts`:

```typescript
import { AgentWorkflowRecovery } from "./workflow-recovery.js";
```

- [ ] **Step 2: Create recovery instance and wire into Orchestrator**

In `runLoop()`, after the `monitor` creation (line ~154) and before the `orchestrator` creation, add:

```typescript
    const recovery = new AgentWorkflowRecovery(
      agent,
      runner,
      config.repo.remote,
      config.safety.maxWorkflowFixAttempts,
      logLine,
    );
```

Then add `recovery` to the Orchestrator constructor deps object:

```typescript
    const orchestrator = new Orchestrator({
      config,
      source,
      agent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt,
      clock: nowIso,
      sleep,
      log: logLine,
      recovery,
    });
```

- [ ] **Step 3: Run full test suite**

Run: `npm run check`
Expected: ALL PASS (compile + lint + all tests)

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire AgentWorkflowRecovery into Orchestrator DI (ES-397)"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm run check`
Expected: ALL PASS

- [ ] **Step 2: Verify no regressions in existing tests**

Run: `npx vitest run`
Expected: ALL existing tests still pass, plus new tests for workflow recovery

- [ ] **Step 3: Verify type consistency with tsc**

Run: `npx tsc --noEmit`
Expected: No type errors
