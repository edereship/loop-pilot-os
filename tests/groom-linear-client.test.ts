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

  it("includes extraLabelIds merged with optInLabel", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: { data: { issueCreate: { success: true, issue: { id: "new-2", identifier: "ES-100" } } } } },
    ]);
    await makeClient(fetchFn).createIssue({ title: "T", description: "D", priority: 2, extraLabelIds: ["label-extra"] });
    expect(calls[0].variables).toMatchObject({
      labelIds: ["label-optin", "label-extra"],
    });
  });

  it("throws on success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issueCreate: { success: false, issue: null } } } },
    ]);
    await expect(makeClient(fetchFn).createIssue({ title: "T", description: "D", priority: 2 })).rejects.toThrow(/issueCreate failed/i);
  });
});

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

describe("GroomLinearClient.getIssueDetails", () => {
  it("returns priority, label IDs, and description for an issue", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issue: { priority: 2, description: "Some desc", labels: { nodes: [{ id: "l-1" }, { id: "l-2" }] } } } } },
    ]);
    const details = await makeClient(fetchFn).getIssueDetails("issue-1");
    expect(details).toEqual({ priority: 2, labelIds: ["l-1", "l-2"], description: "Some desc" });
  });

  it("normalizes null description to empty string", async () => {
    const { fetchFn } = makeFetch([
      { body: { data: { issue: { priority: 3, description: null, labels: { nodes: [] } } } } },
    ]);
    const details = await makeClient(fetchFn).getIssueDetails("issue-1");
    expect(details.description).toBe("");
  });

  it("throws on GraphQL error", async () => {
    const { fetchFn } = makeFetch([
      { body: { errors: [{ message: "not found" }] } },
    ]);
    await expect(makeClient(fetchFn).getIssueDetails("bad")).rejects.toThrow(/Linear GraphQL error/i);
  });
});
