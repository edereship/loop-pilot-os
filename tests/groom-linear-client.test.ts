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
