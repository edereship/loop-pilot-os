import type { EligibleIssue, TaskSource, TicketState } from "./types.js";

/** Web 標準 fetch のサブセット。本番は globalThis.fetch、テストはフェイクを注入する。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// カーネル §5.5: 適格チケット取得（1クエリ、client-side で決定的順序）。一字一句一致。
const ELIGIBLE_QUERY = `query Eligible($projectId: ID, $todoStateId: ID!, $label: String!) {
  issues(first: 50, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url } }
}`;

const ELIGIBLE_QUERY_PAGINATED = `query EligiblePaginated($projectId: ID, $todoStateId: ID!, $label: String!, $after: String) {
  issues(first: 50, after: $after, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url } pageInfo { hasNextPage endCursor } }
}`;

// カーネル §5.5: 遷移 mutation。一字一句一致。
const TRANSITION_MUTATION = `mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

// §1.6: brief 書き戻し用 commentCreate mutation。
const COMMENT_CREATE_MUTATION = `mutation CommentCreate($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

// カーネル §5.5 プリフライト解決: viewer 検証 + team/project/states/labels。
// project は team.projects から解決する（ワークスペース横断の名前解決は、同名 project が
// 他チームにある場合に誤った projectId へ解決し得るため。仕様 §5.1「指定Team/PJ」）。
// ラベルは team.labels + ワークスペース全体の issueLabels の和集合で解決する
// （opt_in_label がワークスペースラベルとして定義されているケースに対応）。
const SETUP_QUERY = `query Setup {
  viewer { id name }
  teams { nodes { id key states { nodes { id name } } labels { nodes { id name } } projects { nodes { id name } } } }
  issueLabels { nodes { id name } }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  sortOrder: number;
  url: string;
}

interface IssuesData {
  issues: { nodes: IssueNode[] };
}

interface IssuesPaginatedData {
  issues: {
    nodes: IssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** 優先度の意味写像（カーネル §5.5 / 仕様 §5）: 1→0, 2→1, 3→2, 4→3, 0→4。 */
function priorityRank(priority: number): number {
  switch (priority) {
    case 1:
      return 0; // Urgent
    case 2:
      return 1; // High
    case 3:
      return 2; // Medium
    case 4:
      return 3; // Low
    default:
      return 4; // No priority (0)
  }
}

/** ①意味的優先度 ②sortOrder 昇順 ③id 昇順 の決定的比較。 */
function compareIssues(a: IssueNode, b: IssueNode): number {
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function toEligible(node: IssueNode): EligibleIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    priority: node.priority,
    sortOrder: node.sortOrder,
    url: node.url,
  };
}

async function graphql<T>(
  fetchFn: FetchFn,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear HTTP ${res.status}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear GraphQL error: ${msg}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL error: response had no data");
  }
  return body.data;
}

export interface LinearTaskSourceOptions {
  apiKey: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabel: string;
  fetchFn: FetchFn;
}

export class LinearTaskSource implements TaskSource {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly optInLabel: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: LinearTaskSourceOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.stateIds = opts.stateIds;
    this.optInLabel = opts.optInLabel;
    this.fetchFn = opts.fetchFn;
  }

  private async queryByState(stateId: string): Promise<IssueNode[]> {
    const data = await graphql<IssuesData>(
      this.fetchFn,
      this.apiKey,
      ELIGIBLE_QUERY,
      {
        projectId: this.projectId,
        todoStateId: stateId,
        label: this.optInLabel,
      },
    );
    return data.issues.nodes;
  }

  private async queryAllByState(stateId: string): Promise<IssueNode[]> {
    const all: IssueNode[] = [];
    let after: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const data: IssuesPaginatedData = await graphql<IssuesPaginatedData>(
        this.fetchFn,
        this.apiKey,
        ELIGIBLE_QUERY_PAGINATED,
        {
          projectId: this.projectId,
          todoStateId: stateId,
          label: this.optInLabel,
          after,
        },
      );
      all.push(...data.issues.nodes);
      hasNext = data.issues.pageInfo.hasNextPage;
      after = data.issues.pageInfo.endCursor;
    }
    return all;
  }

  async getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null> {
    const exclude = new Set(excludeIds);
    const nodes = (await this.queryByState(this.stateIds.todo))
      .filter((n) => !exclude.has(n.id))
      .sort(compareIssues);
    const first = nodes[0];
    return first ? toEligible(first) : null;
  }

  async getAllEligible(excludeIds: string[]): Promise<EligibleIssue[]> {
    const exclude = new Set(excludeIds);
    return (await this.queryAllByState(this.stateIds.todo))
      .filter((n) => !exclude.has(n.id))
      .sort(compareIssues)
      .map(toEligible);
  }

  async transition(issueId: string, state: TicketState): Promise<void> {
    const data = await graphql<{ issueUpdate: { success: boolean } }>(
      this.fetchFn,
      this.apiKey,
      TRANSITION_MUTATION,
      { id: issueId, stateId: this.stateIds[state] },
    );
    if (!data.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate failed for ${issueId} -> ${state}`,
      );
    }
  }

  async findOrphanedInProgress(
    knownIssueIds: string[],
  ): Promise<EligibleIssue[]> {
    const known = new Set(knownIssueIds);
    const nodes = await this.queryByState(this.stateIds.in_progress);
    return nodes.filter((n) => !known.has(n.id)).map(toEligible);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const data = await graphql<{ commentCreate: { success: boolean } }>(
      this.fetchFn,
      this.apiKey,
      COMMENT_CREATE_MUTATION,
      { issueId, body },
    );
    if (!data.commentCreate.success) {
      throw new Error(`Linear commentCreate failed for ${issueId}`);
    }
  }
}

// ---- プリフライト/main 用のセットアップ解決 ----

interface SetupData {
  viewer: { id: string; name: string };
  teams: {
    nodes: Array<{
      id: string;
      key: string;
      states: { nodes: Array<{ id: string; name: string }> };
      labels: { nodes: Array<{ id: string; name: string }> };
      projects: { nodes: Array<{ id: string; name: string }> };
    }>;
  };
  // ワークスペース全体のラベル（team スコープに無いラベルの解決に使う）。
  issueLabels: { nodes: Array<{ id: string; name: string }> };
}

export interface LinearSetupRequest {
  teamKey: string;
  projectName: string;
  stateNames: Record<TicketState, string>;
  optInLabel: string;
}

export interface ResolvedLinearSetup {
  viewerId: string;
  teamId: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabelId: string;
  labelMap: Map<string, string>;   // label name → id (team + workspace)
  knownLabels: string[];           // known label names for GROOM prompt
}

const TICKET_STATES: TicketState[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

/**
 * viewer を検証し、team key / project 名 / 4状態名 / opt-in ラベル名を ID に解決する。
 * 見つからない要素は名前を列挙して 1 回でまとめて throw（プリフライトの fail-fast 用）。
 */
export async function resolveLinearSetup(
  apiKey: string,
  req: LinearSetupRequest,
  fetchFn: FetchFn,
): Promise<ResolvedLinearSetup> {
  const data = await graphql<SetupData>(fetchFn, apiKey, SETUP_QUERY, {});

  const team = data.teams.nodes.find((t) => t.key === req.teamKey);
  if (!team) {
    throw new Error(`Linear team not found: key "${req.teamKey}"`);
  }

  const missing: string[] = [];

  // project は指定 team 配下から解決（他チームの同名 project に誤解決しない）。
  const project = team.projects.nodes.find(
    (p) => p.name === req.projectName,
  );
  if (!project) {
    missing.push(`project "${req.projectName}"`);
  }

  const stateIds = {} as Record<TicketState, string>;
  for (const state of TICKET_STATES) {
    const wantedName = req.stateNames[state];
    const found = team.states.nodes.find((s) => s.name === wantedName);
    if (found) {
      stateIds[state] = found.id;
    } else {
      missing.push(`state "${wantedName}"`);
    }
  }

  // ラベルは team スコープ + ワークスペーススコープの和集合から解決する
  // （カーネル §5.5: `team.labels`+workspace labels）。team ラベルを優先。
  const label =
    team.labels.nodes.find((l) => l.name === req.optInLabel) ??
    data.issueLabels.nodes.find((l) => l.name === req.optInLabel);
  if (!label) {
    missing.push(`label "${req.optInLabel}"`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Linear setup resolution failed; not found: ${missing.join(", ")}`,
    );
  }

  // Build full label map: team labels (priority) + workspace labels
  const labelMap = new Map<string, string>();
  for (const l of data.issueLabels.nodes) {
    labelMap.set(l.name, l.id);
  }
  for (const l of team.labels.nodes) {
    labelMap.set(l.name, l.id); // team labels override workspace on conflict
  }
  const knownLabels = [...new Set([
    ...team.labels.nodes.map((l) => l.name),
    ...data.issueLabels.nodes.map((l) => l.name),
  ])].sort();

  return {
    viewerId: data.viewer.id,
    teamId: team.id,
    // project と label は missing.length===0 の時点で必ず解決済み。
    projectId: project!.id,
    stateIds,
    optInLabelId: label!.id,
    labelMap,
    knownLabels,
  };
}
