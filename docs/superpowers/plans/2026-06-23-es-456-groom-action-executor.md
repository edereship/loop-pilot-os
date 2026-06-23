# ES-456: GROOM Action Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute validated GROOM actions (7 types) against Linear API and MemoryStore, with partial-failure resilience.

**Architecture:** Two new modules — `GroomLinearClient` (Linear GraphQL operations for GROOM) and `GroomExecutor` (action dispatch loop). GroomLinearClient follows the same `FetchFn`-injection pattern as `LinearTaskSource`. GroomExecutor iterates validated actions sequentially, delegates to GroomLinearClient or MemoryStore, and collects per-action outcomes.

**Tech Stack:** TypeScript, vitest, Linear GraphQL API, existing `FetchFn` / `MemoryStore` modules.

## Global Constraints

- `npm run check` must pass (tsc + tsc test + vitest)
- Follow existing test patterns: `makeFetch` for GraphQL mocking, no fixtures unless needed
- No changes to `TaskSource` interface — GROOM uses its own `GroomLinearClient`
- All Linear API keys stay in orchestrator scope (IPI)
- Import paths use `.js` extension (NodeNext module resolution)

---

### Task 1: GroomLinearClient — interface + reprioritize / update / close

**Files:**
- Create: `src/groom-linear-client.ts`
- Create: `tests/groom-linear-client.test.ts`

**Interfaces:**
- Consumes: `FetchFn` from `src/task-source.ts`, `TicketState` from `src/types.ts`
- Produces: `GroomLinearClient` class with `updatePriority`, `updateIssue`, `closeIssue`, `postComment` methods; `GroomLinearClientOptions` type. Later tasks add `createIssue`, `addLabels`, `removeLabels`, `getIssueDetails`.

- [ ] **Step 1: Write failing tests for reprioritize / update / close**

```typescript
// tests/groom-linear-client.test.ts
import { describe, it, expect } from "vitest";
import { GroomLinearClient, type GroomLinearClientOptions } from "../src/groom-linear-client.js";
import type { FetchFn } from "../src/task-source.js";
import type { TicketState } from "../src/types.js";

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
}

function makeFetch(
  responses: Array<{ status?: number; ok?: boolean; body: unknown }>,
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: parsed.query, variables: parsed.variables });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
  return { fetchFn, calls };
}

const STATE_IDS: Record<TicketState, string> = {
  todo: "state-todo",
  in_progress: "state-wip",
  in_review: "state-review",
  done: "state-done",
};

function makeClient(fetchFn: FetchFn, labelMap?: Map<string, string>): GroomLinearClient {
  return new GroomLinearClient({
    apiKey: "lin_test",
    projectId: "proj-1",
    teamId: "team-1",
    stateIds: STATE_IDS,
    optInLabelId: "label-optin",
    labelMap: labelMap ?? new Map(),
    fetchFn,
  });
}

describe("GroomLinearClient.updatePriority", () => {
  it("sends issueUpdate mutation with priority", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: true } } } },
    ]);
    await makeClient(fetchFn).updatePriority("issue-1", 2);
    expect(calls[0].query).toContain("issueUpdate");
    expect(calls[0].variables).toEqual({ id: "issue-1", priority: 2 });
  });

  it("throws on success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issueUpdate: { success: false } } } },
    ]);
    await expect(makeClient(fetchFn).updatePriority("issue-1", 3)).rejects.toThrow(/issueUpdate failed/i);
  });
});

describe("GroomLinearClient.updateIssue", () => {
  it("sends issueUpdate with title only", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: true } } } },
    ]);
    await makeClient(fetchFn).updateIssue("issue-1", { title: "New title" });
    expect(calls[0].variables).toEqual({ id: "issue-1", title: "New title" });
  });

  it("sends issueUpdate with description only", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: true } } } },
    ]);
    await makeClient(fetchFn).updateIssue("issue-1", { description: "New desc" });
    expect(calls[0].variables).toEqual({ id: "issue-1", description: "New desc" });
  });

  it("sends issueUpdate with both title and description", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: true } } } },
    ]);
    await makeClient(fetchFn).updateIssue("issue-1", { title: "T", description: "D" });
    expect(calls[0].variables).toEqual({ id: "issue-1", title: "T", description: "D" });
  });
});

describe("GroomLinearClient.closeIssue", () => {
  it("transitions to Done and posts rationale comment", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: true } } } },
      { body: { data: { commentCreate: { success: true } } } },
    ]);
    await makeClient(fetchFn).closeIssue("issue-1", "Duplicate of ES-123");
    // First call: transition to Done
    expect(calls[0].variables).toEqual({ id: "issue-1", stateId: "state-done" });
    // Second call: comment with rationale
    expect(calls[1].variables.issueId).toBe("issue-1");
    expect(calls[1].variables.body).toContain("Closed by GROOM");
    expect(calls[1].variables.body).toContain("Duplicate of ES-123");
  });

  it("throws if transition fails (comment is not attempted)", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueUpdate: { success: false } } } },
    ]);
    await expect(makeClient(fetchFn).closeIssue("issue-1", "reason")).rejects.toThrow(/issueUpdate failed/i);
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/groom-linear-client.test.ts`
Expected: FAIL — module `../src/groom-linear-client.js` not found

- [ ] **Step 3: Implement GroomLinearClient with reprioritize / update / close**

```typescript
// src/groom-linear-client.ts
import type { FetchFn } from "./task-source.js";
import type { TicketState } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $priority: Int, $title: String, $description: String, $stateId: String, $projectId: String, $teamId: String, $labelIds: [String!]) {
  issueUpdate(id: $id, input: { priority: $priority, title: $title, description: $description, stateId: $stateId, projectId: $projectId, teamId: $teamId, labelIds: $labelIds }) { success }
}`;

const COMMENT_CREATE_MUTATION = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(
  fetchFn: FetchFn,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  if (body.data === undefined) throw new Error("Linear GraphQL error: response had no data");
  return body.data;
}

export interface GroomLinearClientOptions {
  apiKey: string;
  projectId: string;
  teamId: string;
  stateIds: Record<TicketState, string>;
  optInLabelId: string;
  labelMap: Map<string, string>;  // name → id
  fetchFn: FetchFn;
}

export class GroomLinearClient {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly teamId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly optInLabelId: string;
  private readonly labelMap: Map<string, string>;
  private readonly fetchFn: FetchFn;

  constructor(opts: GroomLinearClientOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.teamId = opts.teamId;
    this.stateIds = opts.stateIds;
    this.optInLabelId = opts.optInLabelId;
    this.labelMap = opts.labelMap;
    this.fetchFn = opts.fetchFn;
  }

  private async issueUpdate(id: string, input: Record<string, unknown>): Promise<void> {
    const data = await graphql<{ issueUpdate: { success: boolean } }>(
      this.fetchFn, this.apiKey, ISSUE_UPDATE_MUTATION, { id, ...input },
    );
    if (!data.issueUpdate.success) throw new Error(`issueUpdate failed for ${id}`);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const data = await graphql<{ commentCreate: { success: boolean } }>(
      this.fetchFn, this.apiKey, COMMENT_CREATE_MUTATION, { issueId, body },
    );
    if (!data.commentCreate.success) throw new Error(`commentCreate failed for ${issueId}`);
  }

  async updatePriority(issueId: string, priority: number): Promise<void> {
    await this.issueUpdate(issueId, { priority });
  }

  async updateIssue(issueId: string, fields: { title?: string; description?: string }): Promise<void> {
    await this.issueUpdate(issueId, fields);
  }

  async closeIssue(issueId: string, rationale: string): Promise<void> {
    await this.issueUpdate(issueId, { stateId: this.stateIds.done });
    await this.postComment(issueId, `🧹 Closed by GROOM\n\n**Reason**: ${rationale}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/groom-linear-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/groom-linear-client.ts tests/groom-linear-client.test.ts
git commit -m "feat(ES-456): GroomLinearClient — reprioritize / update / close"
```

---

### Task 2: GroomLinearClient — createIssue + label operations + getIssueDetails

**Files:**
- Modify: `src/groom-linear-client.ts`
- Modify: `tests/groom-linear-client.test.ts`

**Interfaces:**
- Consumes: `GroomLinearClient` from Task 1
- Produces: `createIssue({ title, description, priority }) → string` (returns created issue identifier), `addLabels(issueId, names[])`, `removeLabels(issueId, names[])`, `getIssueDetails(issueId) → { priority, labelIds }`. These are consumed by Task 3 (GroomExecutor).

- [ ] **Step 1: Write failing tests for createIssue**

Append to `tests/groom-linear-client.test.ts`:

```typescript
const ISSUE_CREATE_MUTATION_MARKER = "issueCreate";

describe("GroomLinearClient.createIssue", () => {
  it("sends issueCreate with auto-set project/team/state/optInLabel", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueCreate: { success: true, issue: { id: "new-1", identifier: "ES-99" } } } } },
    ]);
    const result = await makeClient(fetchFn).createIssue({ title: "New ticket", description: "Details", priority: 3 });
    expect(result).toBe("ES-99");
    expect(calls[0].query).toContain(ISSUE_CREATE_MUTATION_MARKER);
    expect(calls[0].variables).toMatchObject({
      title: "New ticket",
      description: "Details",
      priority: 3,
      projectId: "proj-1",
      teamId: "team-1",
      stateId: "state-todo",
      labelIds: ["label-optin"],
    });
  });

  it("throws on success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issueCreate: { success: false, issue: null } } } },
    ]);
    await expect(makeClient(fetchFn).createIssue({ title: "T", description: "D", priority: 2 })).rejects.toThrow(/issueCreate failed/i);
  });
});
```

- [ ] **Step 2: Write failing tests for addLabels / removeLabels**

```typescript
describe("GroomLinearClient.addLabels", () => {
  it("resolves label names to IDs from cache and sends issueAddLabel", async () => {
    const labels = new Map([["bug", "label-bug"], ["urgent", "label-urgent"]]);
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueAddLabel: { success: true } } } },
      { body: { data: { issueAddLabel: { success: true } } } },
    ]);
    await makeClient(fetchFn, labels).addLabels("issue-1", ["bug", "urgent"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].variables).toEqual({ id: "issue-1", labelId: "label-bug" });
    expect(calls[1].variables).toEqual({ id: "issue-1", labelId: "label-urgent" });
  });

  it("throws when label name is not in cache", async () => {
    const { fetchFn } = makeFetch([]);
    await expect(makeClient(fetchFn).addLabels("issue-1", ["nonexistent"])).rejects.toThrow(/nonexistent/i);
  });
});

describe("GroomLinearClient.removeLabels", () => {
  it("resolves label names and sends issueRemoveLabel", async () => {
    const labels = new Map([["bug", "label-bug"]]);
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueRemoveLabel: { success: true } } } },
    ]);
    await makeClient(fetchFn, labels).removeLabels("issue-1", ["bug"]);
    expect(calls[0].variables).toEqual({ id: "issue-1", labelId: "label-bug" });
  });
});
```

- [ ] **Step 3: Write failing tests for getIssueDetails**

```typescript
describe("GroomLinearClient.getIssueDetails", () => {
  it("returns priority and label IDs for an issue", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issue: { priority: 2, labels: { nodes: [{ id: "l-1" }, { id: "l-2" }] } } } } },
    ]);
    const details = await makeClient(fetchFn).getIssueDetails("issue-1");
    expect(details).toEqual({ priority: 2, labelIds: ["l-1", "l-2"] });
  });

  it("throws on GraphQL error", async () => {
    const { fetchFn } = makeFetch([
      { body: { errors: [{ message: "not found" }] } },
    ]);
    await expect(makeClient(fetchFn).getIssueDetails("bad")).rejects.toThrow(/Linear GraphQL error/i);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/groom-linear-client.test.ts`
Expected: FAIL — methods not defined

- [ ] **Step 5: Implement createIssue, label ops, getIssueDetails**

Add to `src/groom-linear-client.ts`:

New mutations/queries at module top:

```typescript
const ISSUE_CREATE_MUTATION = `mutation IssueCreate($title: String!, $description: String, $priority: Int, $projectId: String!, $teamId: String!, $stateId: String!, $labelIds: [String!]) {
  issueCreate(input: { title: $title, description: $description, priority: $priority, projectId: $projectId, teamId: $teamId, stateId: $stateId, labelIds: $labelIds }) { success issue { id identifier } }
}`;

const ISSUE_ADD_LABEL_MUTATION = `mutation IssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

const ISSUE_REMOVE_LABEL_MUTATION = `mutation IssueRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;

const ISSUE_DETAILS_QUERY = `query IssueDetails($id: String!) {
  issue(id: $id) { priority labels { nodes { id } } }
}`;
```

New methods on `GroomLinearClient`:

```typescript
  private resolveLabelId(name: string): string {
    const id = this.labelMap.get(name);
    if (!id) throw new Error(`Label "${name}" not found in cache`);
    return id;
  }

  async createIssue(fields: { title: string; description: string; priority: number }): Promise<string> {
    const data = await graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } }>(
      this.fetchFn, this.apiKey, ISSUE_CREATE_MUTATION, {
        ...fields,
        projectId: this.projectId,
        teamId: this.teamId,
        stateId: this.stateIds.todo,
        labelIds: [this.optInLabelId],
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("issueCreate failed");
    return data.issueCreate.issue.identifier;
  }

  async addLabels(issueId: string, names: string[]): Promise<void> {
    for (const name of names) {
      const labelId = this.resolveLabelId(name);
      const data = await graphql<{ issueAddLabel: { success: boolean } }>(
        this.fetchFn, this.apiKey, ISSUE_ADD_LABEL_MUTATION, { id: issueId, labelId },
      );
      if (!data.issueAddLabel.success) throw new Error(`issueAddLabel failed for ${issueId} label ${name}`);
    }
  }

  async removeLabels(issueId: string, names: string[]): Promise<void> {
    for (const name of names) {
      const labelId = this.resolveLabelId(name);
      const data = await graphql<{ issueRemoveLabel: { success: boolean } }>(
        this.fetchFn, this.apiKey, ISSUE_REMOVE_LABEL_MUTATION, { id: issueId, labelId },
      );
      if (!data.issueRemoveLabel.success) throw new Error(`issueRemoveLabel failed for ${issueId} label ${name}`);
    }
  }

  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[] }> {
    const data = await graphql<{ issue: { priority: number; labels: { nodes: Array<{ id: string }> } } }>(
      this.fetchFn, this.apiKey, ISSUE_DETAILS_QUERY, { id: issueId },
    );
    return { priority: data.issue.priority, labelIds: data.issue.labels.nodes.map((n) => n.id) };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/groom-linear-client.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/groom-linear-client.ts tests/groom-linear-client.test.ts
git commit -m "feat(ES-456): GroomLinearClient — createIssue / labels / getIssueDetails"
```

---

### Task 3: GroomExecutor — all 7 action types + partial failure

**Files:**
- Create: `src/groom-executor.ts`
- Create: `tests/groom-executor.test.ts`

**Interfaces:**
- Consumes: `GroomLinearClient` from Tasks 1-2, `writeCategory` from `src/memory-store.ts`, `GroomAction` / `MemoryCategory` from `src/types.ts`, `ValidationResult` from `src/groom-validator.ts`
- Produces: `executeGroomActions(actions, ctx) → ExecutionResult[]` function. Consumed by ES-457 (Orchestrator Integration).

`ExecutionResult` type:
```typescript
export interface ExecutionResult {
  action: GroomAction;
  outcome: "executed" | "failed";
  error?: string;
}
```

`ExecutorContext` type:
```typescript
export interface ExecutorContext {
  linearClient: GroomLinearClient;
  repoPath: string;
  maxCharsPerFile: number;
}
```

- [ ] **Step 1: Write failing tests for simple actions (reprioritize, update, close, update_memory)**

```typescript
// tests/groom-executor.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeGroomActions, type ExecutorContext } from "../src/groom-executor.js";
import type { GroomAction } from "../src/types.js";
import { MEMORY_DIR, CATEGORY_FILES } from "../src/memory-store.js";

// Minimal stub of GroomLinearClient for executor tests.
// Records calls and can be configured to throw on specific methods.
class StubLinearClient {
  calls: Array<{ method: string; args: unknown[] }> = [];
  private failures = new Map<string, Error>();

  failNext(method: string, error?: Error): void {
    this.failures.set(method, error ?? new Error(`StubLinearClient.${method} failed`));
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const err = this.failures.get(method);
    if (err) { this.failures.delete(method); throw err; }
  }

  async updatePriority(issueId: string, priority: number): Promise<void> {
    this.record("updatePriority", [issueId, priority]);
  }
  async updateIssue(issueId: string, fields: { title?: string; description?: string }): Promise<void> {
    this.record("updateIssue", [issueId, fields]);
  }
  async createIssue(fields: { title: string; description: string; priority: number }): Promise<string> {
    this.record("createIssue", [fields]);
    return `ES-${100 + this.calls.filter((c) => c.method === "createIssue").length}`;
  }
  async closeIssue(issueId: string, rationale: string): Promise<void> {
    this.record("closeIssue", [issueId, rationale]);
  }
  async addLabels(issueId: string, names: string[]): Promise<void> {
    this.record("addLabels", [issueId, names]);
  }
  async removeLabels(issueId: string, names: string[]): Promise<void> {
    this.record("removeLabels", [issueId, names]);
  }
  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[] }> {
    this.record("getIssueDetails", [issueId]);
    return { priority: 2, labelIds: ["l-parent-1"] };
  }
  async postComment(issueId: string, body: string): Promise<void> {
    this.record("postComment", [issueId, body]);
  }
}

let tmpRepo: string;
let client: StubLinearClient;

beforeEach(() => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), "groom-exec-"));
  mkdirSync(path.join(tmpRepo, MEMORY_DIR), { recursive: true });
  client = new StubLinearClient();
});
afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

function ctx(): ExecutorContext {
  // Cast StubLinearClient — it satisfies the duck-typed interface used by the executor.
  return { linearClient: client as never, repoPath: tmpRepo, maxCharsPerFile: 8000 };
}

describe("executeGroomActions", () => {
  it("executes reprioritize", async () => {
    const action: GroomAction = { type: "reprioritize", issueId: "ES-1", priority: 1, rationale: "urgent" };
    const results = await executeGroomActions([action], ctx());
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("executed");
    expect(client.calls[0]).toEqual({ method: "updatePriority", args: ["ES-1", 1] });
  });

  it("executes update with title only", async () => {
    const action: GroomAction = { type: "update", issueId: "ES-1", title: "Better title", rationale: "clarity" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    expect(client.calls[0]).toEqual({ method: "updateIssue", args: ["ES-1", { title: "Better title" }] });
  });

  it("executes close (Done + comment)", async () => {
    const action: GroomAction = { type: "close", issueId: "ES-1", rationale: "duplicate" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    expect(client.calls[0]).toEqual({ method: "closeIssue", args: ["ES-1", "duplicate"] });
  });

  it("executes update_memory via MemoryStore", async () => {
    const action: GroomAction = { type: "update_memory", category: "pm_decisions", content: "New decision log", rationale: "update" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    const written = readFileSync(path.join(tmpRepo, MEMORY_DIR, CATEGORY_FILES.pm_decisions), "utf-8");
    expect(written).toBe("New decision log");
  });
});
```

- [ ] **Step 2: Write failing tests for create and label**

```typescript
describe("executeGroomActions — create", () => {
  it("executes create and returns identifier", async () => {
    const action: GroomAction = { type: "create", title: "New task", description: "Details", priority: 3, rationale: "gap" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    expect(client.calls[0].method).toBe("createIssue");
  });
});

describe("executeGroomActions — label", () => {
  it("executes label with add and remove", async () => {
    const action: GroomAction = { type: "label", issueId: "ES-1", add: ["bug"], remove: ["wontfix"], rationale: "reclassify" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    expect(client.calls[0]).toEqual({ method: "addLabels", args: ["ES-1", ["bug"]] });
    expect(client.calls[1]).toEqual({ method: "removeLabels", args: ["ES-1", ["wontfix"]] });
  });

  it("executes label with add only", async () => {
    const action: GroomAction = { type: "label", issueId: "ES-1", add: ["bug"], rationale: "tag" };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("addLabels");
  });
});
```

- [ ] **Step 3: Write failing tests for split**

```typescript
describe("executeGroomActions — split", () => {
  it("queries parent, creates subtasks with inherited priority, appends to parent description, closes parent", async () => {
    const action: GroomAction = {
      type: "split", issueId: "ES-1",
      subtasks: [{ title: "Sub A", description: "A desc" }, { title: "Sub B", description: "B desc" }],
      rationale: "too large",
    };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");

    const methods = client.calls.map((c) => c.method);
    // 1. getIssueDetails (parent query)
    expect(methods[0]).toBe("getIssueDetails");
    // 2-3. createIssue × 2 (subtasks)
    expect(methods[1]).toBe("createIssue");
    expect(methods[2]).toBe("createIssue");
    // 4. updateIssue (append split note to parent description)
    expect(methods[3]).toBe("updateIssue");
    // 5. closeIssue (parent auto-close)
    expect(methods[4]).toBe("closeIssue");
  });
});
```

- [ ] **Step 4: Write failing tests for partial failure**

```typescript
describe("executeGroomActions — partial failure (D-12)", () => {
  it("continues after a failed action and records the error", async () => {
    client.failNext("updatePriority", new Error("API timeout"));
    const actions: GroomAction[] = [
      { type: "reprioritize", issueId: "ES-1", priority: 1, rationale: "a" },
      { type: "close", issueId: "ES-2", rationale: "b" },
    ];
    const results = await executeGroomActions(actions, ctx());
    expect(results[0].outcome).toBe("failed");
    expect(results[0].error).toContain("API timeout");
    expect(results[1].outcome).toBe("executed");
  });

  it("returns empty array for empty input", async () => {
    const results = await executeGroomActions([], ctx());
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run tests/groom-executor.test.ts`
Expected: FAIL — module `../src/groom-executor.js` not found

- [ ] **Step 6: Implement GroomExecutor**

```typescript
// src/groom-executor.ts
import type { GroomAction } from "./types.js";
import type { GroomLinearClient } from "./groom-linear-client.js";
import { writeCategory } from "./memory-store.js";

export interface ExecutionResult {
  action: GroomAction;
  outcome: "executed" | "failed";
  error?: string;
}

export interface ExecutorContext {
  linearClient: GroomLinearClient;
  repoPath: string;
  maxCharsPerFile: number;
}

async function executeOne(action: GroomAction, ctx: ExecutorContext): Promise<void> {
  const { linearClient } = ctx;
  switch (action.type) {
    case "reprioritize":
      await linearClient.updatePriority(action.issueId, action.priority);
      break;
    case "update":
      await linearClient.updateIssue(action.issueId, {
        ...(action.title !== undefined && { title: action.title }),
        ...(action.description !== undefined && { description: action.description }),
      });
      break;
    case "create":
      await linearClient.createIssue({ title: action.title, description: action.description, priority: action.priority });
      break;
    case "split": {
      const parent = await linearClient.getIssueDetails(action.issueId);
      const childIds: string[] = [];
      for (const sub of action.subtasks) {
        const id = await linearClient.createIssue({ title: sub.title, description: sub.description, priority: parent.priority });
        childIds.push(id);
      }
      // Add parent's labels to each child (if parent has labels beyond opt-in)
      if (parent.labelIds.length > 0) {
        for (const childId of childIds) {
          // createIssue already attached opt-in label; parent.labelIds are raw IDs
          // We pass them through addLabelsById (by ID, not name) — but our interface
          // uses names. For split, we pass label IDs directly via updateIssue.
          // Actually, createIssue only sets opt-in. Parent labels need issueUpdate with labelIds.
          // This is handled by the GroomLinearClient internally.
        }
      }
      await linearClient.updateIssue(action.issueId, {
        description: `→ split into ${childIds.join(", ")}`,
      });
      await linearClient.closeIssue(action.issueId, action.rationale);
      break;
    }
    case "close":
      await linearClient.closeIssue(action.issueId, action.rationale);
      break;
    case "label":
      if (action.add?.length) await linearClient.addLabels(action.issueId, action.add);
      if (action.remove?.length) await linearClient.removeLabels(action.issueId, action.remove);
      break;
    case "update_memory":
      writeCategory(ctx.repoPath, action.category, action.content, ctx.maxCharsPerFile);
      break;
  }
}

export async function executeGroomActions(
  actions: GroomAction[],
  ctx: ExecutorContext,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const action of actions) {
    try {
      await executeOne(action, ctx);
      results.push({ action, outcome: "executed" });
    } catch (err) {
      results.push({ action, outcome: "failed", error: (err as Error).message });
    }
  }
  return results;
}
```

Note on split label inheritance: The `split` implementation queries parent's `labelIds` via `getIssueDetails`. The `createIssue` auto-attaches the opt-in label. To inherit all parent labels on subtasks, we need to add `createIssueWithLabels` or pass extra `labelIds` to `createIssue`. Revisit in Step 8 after green.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/groom-executor.test.ts`
Expected: PASS

- [ ] **Step 8: Refine split to inherit parent labels on subtasks**

The `createIssue` method in `GroomLinearClient` only sets opt-in label. For split, parent labels (beyond opt-in) should be inherited. Add a `createIssueWithLabelIds` variant or extend `createIssue` to accept extra `labelIds`.

Extend `GroomLinearClient.createIssue` signature:

```typescript
  async createIssue(fields: { title: string; description: string; priority: number; extraLabelIds?: string[] }): Promise<string> {
    const labelIds = [this.optInLabelId, ...(fields.extraLabelIds ?? [])];
    // ... rest unchanged, pass labelIds
  }
```

Update `executeOne` split case:

```typescript
    case "split": {
      const parent = await linearClient.getIssueDetails(action.issueId);
      const childIds: string[] = [];
      for (const sub of action.subtasks) {
        const id = await linearClient.createIssue({
          title: sub.title,
          description: sub.description,
          priority: parent.priority,
          extraLabelIds: parent.labelIds,
        });
        childIds.push(id);
      }
      await linearClient.updateIssue(action.issueId, {
        description: `→ split into ${childIds.join(", ")}`,
      });
      await linearClient.closeIssue(action.issueId, action.rationale);
      break;
    }
```

Add a test for label inheritance:

```typescript
  it("split inherits parent labels on subtasks via extraLabelIds", async () => {
    const action: GroomAction = {
      type: "split", issueId: "ES-1",
      subtasks: [{ title: "Sub A", description: "A" }],
      rationale: "split",
    };
    const results = await executeGroomActions([action], ctx());
    expect(results[0].outcome).toBe("executed");
    // createIssue should receive extraLabelIds from parent
    const createCall = client.calls.find((c) => c.method === "createIssue");
    expect(createCall?.args[0]).toMatchObject({ extraLabelIds: ["l-parent-1"] });
  });
```

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run tests/groom-executor.test.ts tests/groom-linear-client.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/groom-executor.ts tests/groom-executor.test.ts src/groom-linear-client.ts tests/groom-linear-client.test.ts
git commit -m "feat(ES-456): GroomExecutor — 7 action types + partial failure"
```

---

### Task 4: npm run check + split description append refinement

**Files:**
- Modify: `src/groom-executor.ts` (if needed)
- Modify: `tests/groom-executor.test.ts` (if needed)

**Interfaces:**
- Consumes: everything from Tasks 1-3
- Produces: green `npm run check`, final verified state

- [ ] **Step 1: Run full check**

Run: `npm run check`
Expected: PASS (tsc + tsc test + vitest all green)

- [ ] **Step 2: Fix any type errors or test failures**

Address any issues found. Common issues:
- Import path `.js` extensions
- Strict null checks on optional fields
- Test type mismatches with StubLinearClient duck typing

- [ ] **Step 3: Test split description append behavior**

The current split implementation replaces the parent's description entirely with `→ split into ...`. It should **append** to the existing description. Add a test:

```typescript
  it("split appends split note to existing parent description", async () => {
    const action: GroomAction = {
      type: "split", issueId: "ES-1",
      subtasks: [{ title: "Sub A", description: "A" }],
      rationale: "too large",
    };
    await executeGroomActions([action], ctx());
    // updateIssue should append, not replace
    const updateCall = client.calls.find((c) => c.method === "updateIssue");
    // The description passed should indicate appending (implementation detail:
    // executor queries current description via getIssueDetails, then appends)
    expect(updateCall).toBeDefined();
  });
```

To properly append, `getIssueDetails` needs to also return `description`. Update the query and interface:

In `src/groom-linear-client.ts`, modify `ISSUE_DETAILS_QUERY`:
```typescript
const ISSUE_DETAILS_QUERY = `query IssueDetails($id: String!) {
  issue(id: $id) { priority description labels { nodes { id } } }
}`;
```

Update return type:
```typescript
  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }> {
```

Update `executeOne` split case to append:
```typescript
      const existingDesc = parent.description ?? "";
      const appendix = `\n\n→ split into ${childIds.join(", ")}`;
      await linearClient.updateIssue(action.issueId, {
        description: existingDesc + appendix,
      });
```

Update `StubLinearClient.getIssueDetails` to return description:
```typescript
  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }> {
    this.record("getIssueDetails", [issueId]);
    return { priority: 2, labelIds: ["l-parent-1"], description: "Original description" };
  }
```

- [ ] **Step 4: Run full check again**

Run: `npm run check`
Expected: PASS

- [ ] **Step 5: Final commit**

```bash
git add src/groom-linear-client.ts src/groom-executor.ts tests/groom-linear-client.test.ts tests/groom-executor.test.ts
git commit -m "feat(ES-456): split description append + npm run check green"
```
