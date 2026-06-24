import type { FetchFn } from "./task-source.js";
import type { TicketState } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $priority: Int, $title: String, $description: String, $stateId: String, $projectId: String, $teamId: String, $labelIds: [String!]) {
  issueUpdate(id: $id, input: { priority: $priority, title: $title, description: $description, stateId: $stateId, projectId: $projectId, teamId: $teamId, labelIds: $labelIds }) { success }
}`;

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
  issue(id: $id) { priority description labels { nodes { id } } }
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
  labelMap: Map<string, string>; // name → id
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
    try {
      await this.postComment(issueId, `🧹 Closed by GROOM\n\n**Reason**: ${rationale}`);
    } catch (err) {
      throw new Error(
        `closeIssue ${issueId}: state changed to Done but rationale comment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveLabelId(name: string): string {
    const id = this.labelMap.get(name);
    if (!id) throw new Error(`Label "${name}" not found in cache`);
    return id;
  }

  async createIssue(fields: { title: string; description: string; priority: number; extraLabelIds?: string[] }): Promise<string> {
    const { extraLabelIds, ...rest } = fields;
    const dedupedExtras = (extraLabelIds ?? []).filter((id) => id !== this.optInLabelId);
    const labelIds = [this.optInLabelId, ...dedupedExtras];
    const data = await graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } }>(
      this.fetchFn, this.apiKey, ISSUE_CREATE_MUTATION, {
        ...rest,
        projectId: this.projectId,
        teamId: this.teamId,
        stateId: this.stateIds.todo,
        labelIds,
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("issueCreate failed");
    return data.issueCreate.issue.identifier;
  }

  async addLabels(issueId: string, names: string[]): Promise<void> {
    const added: string[] = [];
    for (const name of names) {
      try {
        const labelId = this.resolveLabelId(name);
        const data = await graphql<{ issueAddLabel: { success: boolean } }>(
          this.fetchFn, this.apiKey, ISSUE_ADD_LABEL_MUTATION, { id: issueId, labelId },
        );
        if (!data.issueAddLabel.success) throw new Error(`issueAddLabel failed for ${issueId} label ${name}`);
        added.push(name);
      } catch (err) {
        if (added.length > 0) {
          throw new Error(
            `addLabels partially failed for ${issueId} at "${name}" (already added: ${added.join(", ")}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
  }

  async removeLabels(issueId: string, names: string[]): Promise<void> {
    const removed: string[] = [];
    for (const name of names) {
      try {
        const labelId = this.resolveLabelId(name);
        const data = await graphql<{ issueRemoveLabel: { success: boolean } }>(
          this.fetchFn, this.apiKey, ISSUE_REMOVE_LABEL_MUTATION, { id: issueId, labelId },
        );
        if (!data.issueRemoveLabel.success) throw new Error(`issueRemoveLabel failed for ${issueId} label ${name}`);
        removed.push(name);
      } catch (err) {
        if (removed.length > 0) {
          throw new Error(
            `removeLabels partially failed for ${issueId} at "${name}" (already removed: ${removed.join(", ")}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
  }

  async getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }> {
    const data = await graphql<{ issue: { priority: number; description: string | null; labels: { nodes: Array<{ id: string }> } } }>(
      this.fetchFn, this.apiKey, ISSUE_DETAILS_QUERY, { id: issueId },
    );
    return {
      priority: data.issue.priority,
      labelIds: data.issue.labels.nodes.map((n) => n.id),
      description: data.issue.description ?? "",
    };
  }
}
