import type { EligibleIssue, TaskSource, TicketState } from "./types.js";
import type { Config } from "./config.js";

/** Web 標準 fetch のサブセット。本番は globalThis.fetch、テストはフェイクを注入する。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// カーネル §5.5: 適格チケット取得（1クエリ、client-side で決定的順序）。一字一句一致。
const ELIGIBLE_QUERY = `query Eligible($projectId: ID, $todoStateId: ID!, $label: String!) {
  issues(first: 50, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url labels(first: 250) { nodes { name } } } }
}`;

const ELIGIBLE_QUERY_PAGINATED = `query EligiblePaginated($projectId: ID, $todoStateId: ID!, $label: String!, $after: String) {
  issues(first: 50, after: $after, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url labels(first: 250) { nodes { name } } } pageInfo { hasNextPage endCursor } }
}`;

// ES-492: needs-human ラベル付与 mutation。
const ISSUE_ADD_LABEL_MUTATION = `mutation IssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

// カーネル §5.5: 遷移 mutation。一字一句一致。
const TRANSITION_MUTATION = `mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

// §1.6: brief 書き戻し用 commentCreate mutation。
const COMMENT_CREATE_MUTATION = `mutation CommentCreate($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

// カーネル §5.5 プリフライト解決: viewer 検証 + team/project/states/labels。
// 2段階に分割: (1) viewer + team keys (2) 対象 team の詳細 + workspace labels。
// 全チームの nested resources を一括取得すると Linear の query complexity 上限に抵触するため。
const SETUP_VIEWER_QUERY = `query SetupViewer {
  viewer { id name }
  teams { nodes { id key } }
}`;

const SETUP_TEAM_QUERY = `query SetupTeam($teamId: String!) {
  team(id: $teamId) { id key states { nodes { id name } } labels(first: 250) { nodes { id name } pageInfo { hasNextPage endCursor } } projects { nodes { id name } } }
  issueLabels(first: 250) { nodes { id name } pageInfo { hasNextPage endCursor } }
}`;

const TEAM_LABELS_QUERY = `query TeamLabels($teamId: String!, $after: String) {
  team(id: $teamId) {
    labels(first: 250, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
  }
}`;

const WORKSPACE_LABELS_QUERY = `query WorkspaceLabels($after: String) {
  issueLabels(first: 250, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
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
  labels: { nodes: Array<{ name: string }> };
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
  needsHumanLabel: string;
  needsHumanLabelId: string;
  fetchFn: FetchFn;
}

export class LinearTaskSource implements TaskSource {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly optInLabel: string;
  private readonly needsHumanLabel: string;
  private readonly needsHumanLabelId: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: LinearTaskSourceOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.stateIds = opts.stateIds;
    this.optInLabel = opts.optInLabel;
    this.needsHumanLabel = opts.needsHumanLabel;
    this.needsHumanLabelId = opts.needsHumanLabelId;
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
    const MAX_PAGES = 50;
    const all: IssueNode[] = [];
    let after: string | null = null;
    let hasNext = true;
    let page = 0;
    while (hasNext) {
      if (++page > MAX_PAGES) {
        throw new Error(`queryAllByState exceeded ${MAX_PAGES} pages (${all.length} issues fetched); possible infinite pagination`);
      }
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

  private isEligible(
    node: IssueNode,
    hardExclude: Set<string>,
    softExclude: Set<string>,
    legacyExclude: Set<string>,
    onLegacyLabelDetected?: (issueId: string) => void,
  ): boolean {
    // Hard exclusions (active issues being worked on) always apply.
    if (hardExclude.has(node.id)) return false;
    // Current-run DB guard: defense-in-depth when addLabel fails transiently (ES-492 Finding 2).
    // Only applies when needs_human_label_added=0. Checked before label so that within-run
    // re-selection is blocked even before the label propagates to Linear.
    if (softExclude.has(node.id)) return false;
    // The needs-human label is the cross-run authority: if present, triage is required.
    const hasNeedsHumanLabel = node.labels.nodes.some((l) => l.name === this.needsHumanLabel);
    if (hasNeedsHumanLabel) {
      // Operator manually added the label to a legacy-excluded issue. Flip the DB bit so
      // that a subsequent label removal re-enables the ticket (ES-492 Finding 3).
      if (legacyExclude.has(node.id)) {
        onLegacyLabelDetected?.(node.id);
      }
      return false;
    }
    // Cross-run legacy guard: checked AFTER the label so that manual label-add is detectable
    // (ES-492 Finding 3). Issues here have needs_human_label_added=0 and no label in Linear;
    // they stay excluded until the operator adds the label (triggering the callback above) and
    // then removes it, or until a newer session supersedes the stopped one.
    if (legacyExclude.has(node.id)) return false;
    return true;
  }

  async getNextEligible(hardExcludeIds: string[], abandonedExcludeIds: string[] = [], legacyExcludeIds: string[] = [], onLegacyLabelDetected?: (issueId: string) => void): Promise<EligibleIssue | null> {
    const hard = new Set(hardExcludeIds);
    const soft = new Set(abandonedExcludeIds);
    const legacy = new Set(legacyExcludeIds);
    const nodes = (await this.queryByState(this.stateIds.todo))
      .filter((n) => this.isEligible(n, hard, soft, legacy, onLegacyLabelDetected))
      .sort(compareIssues);
    const first = nodes[0];
    return first ? toEligible(first) : null;
  }

  async getAllEligible(hardExcludeIds: string[], abandonedExcludeIds: string[] = [], legacyExcludeIds: string[] = [], onLegacyLabelDetected?: (issueId: string) => void): Promise<EligibleIssue[]> {
    const hard = new Set(hardExcludeIds);
    const soft = new Set(abandonedExcludeIds);
    const legacy = new Set(legacyExcludeIds);
    return (await this.queryAllByState(this.stateIds.todo))
      .filter((n) => this.isEligible(n, hard, soft, legacy, onLegacyLabelDetected))
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

  async addLabel(issueId: string, labelName: string): Promise<void> {
    if (labelName !== this.needsHumanLabel) {
      throw new Error(`addLabel only supports needs-human label, got "${labelName}"`);
    }
    const data = await graphql<{ issueAddLabel: { success: boolean } }>(
      this.fetchFn,
      this.apiKey,
      ISSUE_ADD_LABEL_MUTATION,
      { id: issueId, labelId: this.needsHumanLabelId },
    );
    if (!data.issueAddLabel.success) {
      throw new Error(`issueAddLabel failed for ${issueId}`);
    }
  }
}

// ---- プリフライト/main 用のセットアップ解決 ----

interface LabelNode { id: string; name: string; }
interface LabelPage {
  nodes: LabelNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface SetupViewerData {
  viewer: { id: string; name: string };
  teams: { nodes: Array<{ id: string; key: string }> };
}

interface SetupTeamData {
  team: {
    id: string;
    key: string;
    states: { nodes: Array<{ id: string; name: string }> };
    labels: LabelPage;
    projects: { nodes: Array<{ id: string; name: string }> };
  };
  issueLabels: LabelPage;
}

async function fetchAllTeamLabels(
  fetchFn: FetchFn,
  apiKey: string,
  teamId: string,
  initial: LabelPage,
): Promise<LabelNode[]> {
  const MAX_PAGES = 50;
  const all = [...initial.nodes];
  let { hasNextPage, endCursor } = initial.pageInfo;
  let page = 0;
  while (hasNextPage) {
    if (++page > MAX_PAGES) {
      throw new Error(`fetchAllTeamLabels exceeded ${MAX_PAGES} pages (${all.length} labels fetched); possible infinite pagination`);
    }
    const data = await graphql<{ team: { labels: LabelPage } }>(
      fetchFn, apiKey, TEAM_LABELS_QUERY, { teamId, after: endCursor },
    );
    all.push(...data.team.labels.nodes);
    ({ hasNextPage, endCursor } = data.team.labels.pageInfo);
  }
  return all;
}

async function fetchAllWorkspaceLabels(
  fetchFn: FetchFn,
  apiKey: string,
  initial: LabelPage,
): Promise<LabelNode[]> {
  const MAX_PAGES = 50;
  const all = [...initial.nodes];
  let { hasNextPage, endCursor } = initial.pageInfo;
  let page = 0;
  while (hasNextPage) {
    if (++page > MAX_PAGES) {
      throw new Error(`fetchAllWorkspaceLabels exceeded ${MAX_PAGES} pages (${all.length} labels fetched); possible infinite pagination`);
    }
    const data = await graphql<{ issueLabels: LabelPage }>(
      fetchFn, apiKey, WORKSPACE_LABELS_QUERY, { after: endCursor },
    );
    all.push(...data.issueLabels.nodes);
    ({ hasNextPage, endCursor } = data.issueLabels.pageInfo);
  }
  return all;
}

export interface LinearSetupRequest {
  teamKey: string;
  projectName: string;
  stateNames: Record<TicketState, string>;
  optInLabel: string;
  needsHumanLabel: string;
  // SCOUT ラベル（ES-516）。undefined = SCOUT 無効・解決をスキップする。
  scoutLabel?: string;
  scoutTriageLabel?: string;
}

export interface ResolvedLinearSetup {
  viewerId: string;
  teamId: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabelId: string;
  needsHumanLabelId: string;
  scoutLabelId: string | null;        // req.scoutLabel 未指定時は null
  scoutTriageLabelId: string | null;  // req.scoutTriageLabel 未指定時は null
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
  // 同名ラベルは fail-fast で拒否する（ES-492 Finding 3 / ES-516）。
  // 例: opt_in == needs_human は SELECT が永遠に空になる。
  //     scout_triage == opt_in は triage チケットが即適格になり人間ゲートが消える。
  const labelEntries: Array<[string, string]> = [
    ["opt_in_label", req.optInLabel],
    ["needs_human_label", req.needsHumanLabel],
  ];
  if (req.scoutLabel !== undefined) {
    labelEntries.push(["scout_label", req.scoutLabel]);
  }
  if (req.scoutTriageLabel !== undefined) {
    labelEntries.push(["scout_triage_label", req.scoutTriageLabel]);
  }
  const conflicts: string[] = [];
  for (let i = 0; i < labelEntries.length; i++) {
    for (let j = i + 1; j < labelEntries.length; j++) {
      if (labelEntries[i][1] === labelEntries[j][1]) {
        conflicts.push(
          `${labelEntries[i][0]} and ${labelEntries[j][0]} must be different (both are "${labelEntries[i][1]}")`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`Linear setup: ${conflicts.join("; ")}`);
  }

  // Phase 1: viewer + team keys のみ（軽量クエリ）
  const viewerData = await graphql<SetupViewerData>(fetchFn, apiKey, SETUP_VIEWER_QUERY, {});

  const teamEntry = viewerData.teams.nodes.find((t) => t.key === req.teamKey);
  if (!teamEntry) {
    throw new Error(`Linear team not found: key "${req.teamKey}"`);
  }

  // Phase 2: 対象 team の詳細 + workspace labels
  const data = await graphql<SetupTeamData>(fetchFn, apiKey, SETUP_TEAM_QUERY, { teamId: teamEntry.id });
  const team = data.team;

  const missing: string[] = [];

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
  const [teamLabels, wsLabels] = await Promise.all([
    fetchAllTeamLabels(fetchFn, apiKey, team.id, team.labels),
    fetchAllWorkspaceLabels(fetchFn, apiKey, data.issueLabels),
  ]);

  // ラベル名 → エントリ解決（team スコープ優先、次に workspace スコープ）。4 ラベル共通。
  const findLabel = (name: string) =>
    teamLabels.find((l) => l.name === name) ?? wsLabels.find((l) => l.name === name);

  const label = findLabel(req.optInLabel);
  if (!label) {
    missing.push(`label "${req.optInLabel}"`);
  }

  const needsHumanLabelEntry = findLabel(req.needsHumanLabel);
  if (!needsHumanLabelEntry) {
    missing.push(`label "${req.needsHumanLabel}"`);
  }

  // SCOUT ラベル解決（ES-516・needs-human と同型）。未指定 = SCOUT 無効で null。
  let scoutLabelId: string | null = null;
  if (req.scoutLabel !== undefined) {
    const entry = findLabel(req.scoutLabel);
    if (entry) {
      scoutLabelId = entry.id;
    } else {
      missing.push(`label "${req.scoutLabel}"`);
    }
  }
  let scoutTriageLabelId: string | null = null;
  if (req.scoutTriageLabel !== undefined) {
    const entry = findLabel(req.scoutTriageLabel);
    if (entry) {
      scoutTriageLabelId = entry.id;
    } else {
      missing.push(`label "${req.scoutTriageLabel}"`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Linear setup resolution failed; not found: ${missing.join(", ")}`,
    );
  }

  const labelMap = new Map<string, string>();
  for (const l of wsLabels) {
    labelMap.set(l.name, l.id);
  }
  for (const l of teamLabels) {
    labelMap.set(l.name, l.id);
  }
  const knownLabels = [...new Set([
    ...teamLabels.map((l) => l.name),
    ...wsLabels.map((l) => l.name),
  ])].sort();

  return {
    viewerId: viewerData.viewer.id,
    teamId: team.id,
    // project と label は missing.length===0 の時点で必ず解決済み。
    projectId: project!.id,
    stateIds,
    optInLabelId: label!.id,
    needsHumanLabelId: needsHumanLabelEntry!.id,
    scoutLabelId,
    scoutTriageLabelId,
    labelMap,
    knownLabels,
  };
}

/**
 * Config から LinearSetupRequest を組み立てる（main / preflight で共有・ES-516）。
 * config.linear.states は camelCase、stateNames は TicketState キーのため明示写像する。
 * SCOUT ラベルは scout.enabled のときのみ解決対象に含める
 * （無効ユーザーに Linear ラベル作成を強制しない）。
 *
 * scoutEffectivelyEnabled が指定された場合、config.scout.enabled の代わりにその値を使う。
 * これにより ANTHROPIC_API_KEY 未設定時（実行時 SCOUT 無効）の scout ラベル解決を省略できる
 * （ES-535: API キー不在時に scout ラベルが Linear にないと preflight が失敗する問題の修正）。
 */
export function buildLinearSetupRequest(config: Config, scoutEffectivelyEnabled?: boolean): LinearSetupRequest {
  const includeScout = scoutEffectivelyEnabled ?? config.scout.enabled;
  const stateNames: Record<TicketState, string> = {
    todo: config.linear.states.todo,
    in_progress: config.linear.states.inProgress,
    in_review: config.linear.states.inReview,
    done: config.linear.states.done,
  };
  return {
    teamKey: config.linear.team,
    projectName: config.linear.project,
    stateNames,
    optInLabel: config.linear.optInLabel,
    needsHumanLabel: config.linear.needsHumanLabel,
    ...(includeScout
      ? {
          scoutLabel: config.linear.scoutLabel,
          scoutTriageLabel: config.linear.scoutTriageLabel,
        }
      : {}),
  };
}
