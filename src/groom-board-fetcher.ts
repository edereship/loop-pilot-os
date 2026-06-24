import type { BoardState, BoardTicket, InProgressTicket, DoneTicket, BlockedTicket, TicketState } from "./types.js";
import type { FetchFn } from "./task-source.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const BOARD_QUERY = `query BoardState($projectId: ID!, $after: String) {
  issues(first: 100, after: $after, filter: { project: { id: { eq: $projectId } } }) {
    nodes {
      id identifier title priority sortOrder
      state { id }
      labels { nodes { name } }
      relations { nodes { type relatedIssue { identifier } } }
      completedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface BoardIssueNode {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  sortOrder: number;
  state: { id: string };
  labels: { nodes: Array<{ name: string }> };
  relations: { nodes: Array<{ type: string; relatedIssue: { identifier: string } }> };
  completedAt: string | null;
}

interface BoardQueryData {
  issues: {
    nodes: BoardIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface GroomBoardFetcherOptions {
  apiKey: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  fetchFn: FetchFn;
}

export class GroomBoardFetcher {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly fetchFn: FetchFn;
  private cachedNodes: BoardIssueNode[] | null = null;

  constructor(opts: GroomBoardFetcherOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.stateIds = opts.stateIds;
    this.fetchFn = opts.fetchFn;
  }

  /** Clear the cached nodes so the next call re-fetches from the API. */
  refresh(): void {
    this.cachedNodes = null;
  }

  private async ensureFetched(): Promise<BoardIssueNode[]> {
    if (this.cachedNodes === null) {
      this.cachedNodes = await this.fetchAll();
    }
    return this.cachedNodes;
  }

  private async fetchAll(): Promise<BoardIssueNode[]> {
    const MAX_PAGES = 50;
    const all: BoardIssueNode[] = [];
    let after: string | null = null;
    let hasNext = true;
    let page = 0;
    while (hasNext) {
      if (++page > MAX_PAGES) {
        throw new Error(`fetchAll exceeded ${MAX_PAGES} pages (${all.length} issues fetched); possible infinite pagination`);
      }
      const res = await this.fetchFn(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.apiKey },
        body: JSON.stringify({ query: BOARD_QUERY, variables: { projectId: this.projectId, after } }),
      });
      if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
      const body = (await res.json()) as GraphQLResponse<BoardQueryData>;
      if (body.errors?.length) throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
      if (!body.data) throw new Error("Linear GraphQL: no data");
      all.push(...body.data.issues.nodes);
      hasNext = body.data.issues.pageInfo.hasNextPage;
      after = body.data.issues.pageInfo.endCursor;
    }
    return all;
  }

  async getBoardState(activeSessionPrNumbers: Map<string, number | null>): Promise<BoardState> {
    const nodes = await this.ensureFetched();
    const { todo, in_progress, in_review, done } = this.stateIds;

    // Build a set of identifiers that are blocked by another issue in this project.
    // A "blocks" relation on issue A with relatedIssue B means A blocks B.
    const blockedByMap = new Map<string, string[]>(); // identifier → [blockerIdentifier, ...]
    for (const n of nodes) {
      for (const rel of n.relations.nodes) {
        if (rel.type === "blocks") {
          const existing = blockedByMap.get(rel.relatedIssue.identifier) ?? [];
          existing.push(n.identifier);
          blockedByMap.set(rel.relatedIssue.identifier, existing);
        }
      }
    }

    const eligible: BoardTicket[] = [];
    const inProgress: InProgressTicket[] = [];
    const recentDone: DoneTicket[] = [];
    const blocked: BlockedTicket[] = [];

    for (const n of nodes) {
      const labels = n.labels.nodes.map((l) => l.name);
      const stateId = n.state.id;

      if (stateId === todo) {
        const blockers = blockedByMap.get(n.identifier);
        if (blockers && blockers.length > 0) {
          blocked.push({
            identifier: n.identifier,
            title: n.title,
            priority: n.priority,
            labels,
            blockedBy: blockers.join(", "),
          });
        } else {
          eligible.push({ identifier: n.identifier, title: n.title, priority: n.priority, labels });
        }
      } else if (stateId === in_progress || stateId === in_review) {
        const status: "in_progress" | "in_review" = stateId === in_progress ? "in_progress" : "in_review";
        inProgress.push({
          identifier: n.identifier,
          title: n.title,
          priority: n.priority,
          labels,
          status,
          prNumber: activeSessionPrNumbers.get(n.identifier) ?? null,
        });
      } else if (stateId === done) {
        recentDone.push({
          identifier: n.identifier,
          title: n.title,
          mergedAt: n.completedAt ?? "",
        });
      }
    }

    return { eligible, inProgress, recentDone, blocked };
  }

  async getProjectIssueIds(): Promise<Set<string>> {
    const nodes = await this.ensureFetched();
    return new Set(nodes.map((n) => n.identifier));
  }

  async getDoneIssueIds(): Promise<Set<string>> {
    const nodes = await this.ensureFetched();
    return new Set(nodes.filter((n) => n.state.id === this.stateIds.done).map((n) => n.identifier));
  }
}
