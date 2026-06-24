import { describe, it, expect } from "vitest";
import { GroomBoardFetcher } from "../src/groom-board-fetcher.js";
import type { FetchFn } from "../src/task-source.js";

function makeFetch(data: unknown): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => ({ data }) });
}

function makeNode(id: string, identifier: string, stateId: string, opts: {
  priority?: number; title?: string; labels?: string[]; relations?: Array<{ type: string; relatedIssue: { identifier: string } }>;
} = {}) {
  return {
    id,
    identifier,
    title: opts.title ?? `Title ${identifier}`,
    priority: opts.priority ?? 3,
    sortOrder: 0,
    state: { id: stateId },
    labels: { nodes: (opts.labels ?? []).map((n) => ({ name: n })) },
    relations: { nodes: (opts.relations ?? []).map((r) => ({ type: r.type, relatedIssue: { identifier: r.relatedIssue.identifier } })) },
    completedAt: null,
  };
}

describe("GroomBoardFetcher", () => {
  const stateIds = { todo: "s-todo", in_progress: "s-ip", in_review: "s-ir", done: "s-done" };
  const BASE_OPTS = { apiKey: "key", projectId: "proj", stateIds, fetchFn: makeFetch({}) };

  it("getBoardState classifies tickets by state", async () => {
    const todoNode = makeNode("id-1", "ES-1", stateIds.todo);
    const ipNode = makeNode("id-2", "ES-2", stateIds.in_progress);
    const irNode = makeNode("id-3", "ES-3", stateIds.in_review);
    const doneNode = makeNode("id-4", "ES-4", stateIds.done);

    const fetcher = new GroomBoardFetcher({
      ...BASE_OPTS,
      fetchFn: makeFetch({
        issues: { nodes: [todoNode, ipNode, irNode, doneNode], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    });

    const board = await fetcher.getBoardState(new Map());
    expect(board.eligible.length).toBe(1);
    expect(board.eligible[0].identifier).toBe("ES-1");
    expect(board.inProgress.length).toBe(2); // in_progress + in_review
    expect(board.recentDone.length).toBe(1);
    expect(board.recentDone[0].identifier).toBe("ES-4");
  });

  it("getBoardState maps PR numbers from active sessions", async () => {
    const ipNode = makeNode("id-2", "ES-2", stateIds.in_progress);
    const fetcher = new GroomBoardFetcher({
      ...BASE_OPTS,
      fetchFn: makeFetch({
        issues: { nodes: [ipNode], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    });

    const prMap = new Map([["ES-2", 42]]);
    const board = await fetcher.getBoardState(prMap);
    expect(board.inProgress[0].prNumber).toBe(42);
  });

  it("getBoardState identifies blocked tickets", async () => {
    const blockedNode = makeNode("id-5", "ES-5", stateIds.todo, {
      relations: [{ type: "blocks", relatedIssue: { identifier: "ES-5" } }],
    });
    // Ticket ES-5 has a "blocks" relation pointing TO it (from another ticket).
    // The query fetches relations from the blocker's perspective:
    // blockerNode blocks ES-5.
    const blockerNode = makeNode("id-6", "ES-6", stateIds.in_progress, {
      relations: [{ type: "blocks", relatedIssue: { identifier: "ES-5" } }],
    });

    const fetcher = new GroomBoardFetcher({
      ...BASE_OPTS,
      fetchFn: makeFetch({
        issues: { nodes: [blockedNode, blockerNode], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    });

    const board = await fetcher.getBoardState(new Map());
    // ES-5 should appear in blocked (it's a todo blocked by ES-6)
    expect(board.blocked.some((b) => b.identifier === "ES-5")).toBe(true);
  });

  it("getProjectIssueIds returns all issue IDs", async () => {
    const fetcher = new GroomBoardFetcher({
      ...BASE_OPTS,
      fetchFn: makeFetch({
        issues: { nodes: [
          makeNode("id-1", "ES-1", stateIds.todo),
          makeNode("id-2", "ES-2", stateIds.done),
        ], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    });
    const ids = await fetcher.getProjectIssueIds();
    expect(ids.has("ES-1")).toBe(true);
    expect(ids.has("ES-2")).toBe(true);
  });

  it("getDoneIssueIds returns only done issue IDs", async () => {
    const fetcher = new GroomBoardFetcher({
      ...BASE_OPTS,
      fetchFn: makeFetch({
        issues: { nodes: [
          makeNode("id-1", "ES-1", stateIds.todo),
          makeNode("id-2", "ES-2", stateIds.done),
        ], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    });
    const ids = await fetcher.getDoneIssueIds();
    expect(ids.has("ES-1")).toBe(false);
    expect(ids.has("ES-2")).toBe(true);
  });

  it("caches results so the fetch function is called only once per cycle", async () => {
    let callCount = 0;
    const countingFetch: FetchFn = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                makeNode("id-1", "ES-1", stateIds.todo),
                makeNode("id-2", "ES-2", stateIds.done),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      };
    };

    const fetcher = new GroomBoardFetcher({ apiKey: "key", projectId: "proj", stateIds, fetchFn: countingFetch });

    await fetcher.getBoardState(new Map());
    await fetcher.getProjectIssueIds();
    await fetcher.getDoneIssueIds();

    expect(callCount).toBe(1);
  });

  it("refresh() invalidates the cache so the next call re-fetches", async () => {
    let nodeCount = 2;
    const dynamicFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          issues: {
            nodes: Array.from({ length: nodeCount }, (_, i) =>
              makeNode(`id-${i + 1}`, `ES-${i + 1}`, stateIds.todo),
            ),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    const fetcher = new GroomBoardFetcher({ apiKey: "key", projectId: "proj", stateIds, fetchFn: dynamicFetch });

    const board1 = await fetcher.getBoardState(new Map());
    expect(board1.eligible.length).toBe(2);

    // Invalidate cache and change the underlying data
    fetcher.refresh();
    nodeCount = 3;

    const board2 = await fetcher.getBoardState(new Map());
    expect(board2.eligible.length).toBe(3);
  });
});
