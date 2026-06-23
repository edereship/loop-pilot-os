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
  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }> {
    this.record("getIssueDetails", [issueId]);
    return { priority: 2, labelIds: ["l-parent-1"], description: "Original description" };
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

    // description must contain both the original text and the split note
    const updateCall = client.calls.find((c) => c.method === "updateIssue");
    expect((updateCall?.args[1] as { description: string }).description).toContain("Original description");
    expect((updateCall?.args[1] as { description: string }).description).toContain("→ split into");
  });

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
});

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
