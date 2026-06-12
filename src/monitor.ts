import type {
  CommandRunner,
  LoopPilotMonitor,
  MergeReadiness,
  MonitorVerdict,
} from "./types.js";

// ---- LoopPilot state-manager.ts と同一の定数 -----------------------------

/** 信頼 state コメントの可視先頭テキスト（state-manager.ts: STATE_COMMENT_VISIBLE_TEXT） */
const STATE_COMMENT_VISIBLE_TEXT = "LoopPilot state is stored in this comment.";
/** 隠しコメント開始マーカー（state-manager.ts: STATE_COMMENT_OPEN = "<!-- " + "looppilot-state"） */
const STATE_COMMENT_OPEN = "<!-- looppilot-state";
/** state 抽出 regex（state-manager.ts deserializeState と同一の捕捉式） */
const STATE_EXTRACT_RE = /<!-- looppilot-state\n([\s\S]*?)\n-->/;
/** LoopPilot VALID_STATUSES（state-manager.ts L33） */
const VALID_STATUSES = new Set([
  "initialized",
  "waiting_codex",
  "fixing",
  "done",
  "stopped",
]);
/** checkMergeReadiness ② の「失敗でない」conclusion 集合（§5.3） */
const GREEN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// ---- gh pr view --json の型 ---------------------------------------------

/**
 * statusCheckRollup の要素は2系統が混在する（gh pr view --json statusCheckRollup）:
 * - CheckRun: status(QUEUED/IN_PROGRESS/COMPLETED) + conclusion(SUCCESS/FAILURE/...)
 * - StatusContext（legacy commit status）: status/conclusion を持たず state(SUCCESS/PENDING/FAILURE/ERROR/EXPECTED)
 */
interface RollupCheck {
  status?: string;
  conclusion?: string | null;
  state?: string;
}

interface PrViewJson {
  state: string;
  mergedAt: string | null;
  mergeable: string;
  mergeStateStatus: string;
  headRefOid: string;
  statusCheckRollup?: Array<RollupCheck> | null;
  closed: boolean;
}

/** 1 チェックを green/failed/pending に分類（CheckRun と StatusContext の両形に対応）。 */
function classifyCheck(c: RollupCheck): "green" | "failed" | "pending" {
  // CheckRun（status フィールドを持つ）
  if (typeof c.status === "string") {
    if (c.status !== "COMPLETED") return "pending";
    return GREEN_CONCLUSIONS.has(c.conclusion ?? "") ? "green" : "failed";
  }
  // StatusContext（state フィールドを持つ）
  if (typeof c.state === "string") {
    const s = c.state.toUpperCase();
    if (s === "SUCCESS") return "green";
    if (s === "PENDING" || s === "EXPECTED") return "pending";
    return "failed"; // FAILURE / ERROR / その他
  }
  // 未知の形は fail-closed（マージせず ci_failed→HALT で人間に上げる。無限 pending を避ける）
  return "failed";
}

/** gh api issue comments の1要素（必要フィールドのみ）。user は削除/ghost で null になり得る。 */
interface IssueComment {
  user: { login: string } | null;
  body: string;
}

export interface GhLoopPilotMonitorOptions {
  remote: string; // "owner/name"
  trustedAuthors: string[];
}

export class GhLoopPilotMonitor implements LoopPilotMonitor {
  private readonly runner: CommandRunner;
  private readonly remote: string;
  private readonly trustedAuthors: string[];
  private readonly owner: string;
  private readonly name: string;

  constructor(runner: CommandRunner, opts: GhLoopPilotMonitorOptions) {
    this.runner = runner;
    this.remote = opts.remote;
    this.trustedAuthors = opts.trustedAuthors;
    const slash = opts.remote.indexOf("/");
    this.owner = opts.remote.slice(0, slash);
    this.name = opts.remote.slice(slash + 1);
  }

  async poll(prNumber: number): Promise<MonitorVerdict> {
    const pr = await this.fetchPrView(prNumber);

    // §5.4 規則1: merged が最優先（コメントを取りに行く前に判定）
    if (pr.mergedAt !== null || pr.state === "MERGED") {
      return { kind: "merged" };
    }
    // §5.4 規則2: 未マージ ∧ CLOSED → pr_closed
    if (pr.state === "CLOSED") {
      return { kind: "pr_closed" };
    }

    // §5.4 規則3-5: ここで初めてコメントを取得して信頼 state コメントを特定
    const { stateComment, errorCommentCount, latestErrorBody } =
      await this.scanTrustedComments(prNumber);

    if (stateComment === null) {
      if (errorCommentCount > 0) {
        return {
          kind: "workflow_failed",
          errorBody: latestErrorBody!,
          errorCommentCount,
          hasStateComment: false,
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
        hasStateComment: true,
      };
    }
    return { kind: "in_progress" };
  }

  async checkMergeReadiness(prNumber: number): Promise<MergeReadiness> {
    const pr = await this.fetchPrView(prNumber);
    const checks = pr.statusCheckRollup ?? [];

    // ① コンフリクト
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
      return { ready: false, reason: "conflict" };
    }
    const classes = checks.map(classifyCheck);
    // ② 失敗チェックあり（CheckRun: completed かつ conclusion ∉ {SUCCESS,NEUTRAL,SKIPPED} / StatusContext: FAILURE,ERROR）
    if (classes.includes("failed")) {
      return { ready: false, reason: "ci_failed" };
    }
    // ③ 未完了チェックあり
    if (classes.includes("pending")) {
      return { ready: false, reason: "ci_pending" };
    }
    // ④ 全グリーン（空配列含む）かつ BLOCKED
    if (pr.mergeStateStatus === "BLOCKED") {
      return { ready: false, reason: "blocked" };
    }
    // ⑤ MERGEABLE
    if (pr.mergeable === "MERGEABLE") {
      return { ready: true, headSha: pr.headRefOid };
    }
    // ⑥ それ以外
    return { ready: false, reason: "unknown" };
  }

  // ---- 内部ヘルパ -------------------------------------------------------

  private async fetchPrView(prNumber: number): Promise<PrViewJson> {
    const result = await this.runner.run(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "-R",
        this.remote,
        "--json",
        "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
      ],
      { cwd: process.cwd() },
    );
    // 非0終了は失敗として throw（poll の backoff/5連続停止に委ねる）。
    // stdout に部分 JSON が載っていても「成功」と誤採用しない。
    if (result.code !== 0) {
      throw new Error(
        `gh pr view failed for PR #${prNumber}: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return JSON.parse(result.stdout) as PrViewJson;
  }

  /**
   * §5.4 のコメント特定4規則を適用して信頼 state コメントを返す。
   * 該当無し → null。複数該当 → 最後のもの（gh は作成昇順、配列末尾 = 最新）。
   * また ⚠️ で始まる信頼著者コメント（state コメント以外）を集計する。
   */
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
    // --paginate --slurp は [[...page1...],[...page2...]] を返すので flat 化（§5.3）
    const pages = JSON.parse(result.stdout) as IssueComment[][];
    const comments: IssueComment[] = pages.flat();

    let stateComment: IssueComment | null = null;
    let errorCommentCount = 0;
    let latestErrorBody: string | null = null;

    for (const c of comments) {
      // 規則1: 信頼著者（user は削除/ghost で null になり得る → スキップ）
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

  /**
   * 信頼コメント body から status / stopReason を抽出。
   * regex 不一致 / JSON.parse 失敗 / 非オブジェクト / status 非文字列・不正値 → null（= corrupted の合図）。
   */
  private extractStatus(
    body: string,
  ): { status: string; stopReason: string | null } | null {
    const match = body.match(STATE_EXTRACT_RE);
    if (!match) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const status = obj.status;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
      return null;
    }
    // stopReason は文字列 or null（null はそのまま保持・変換しない、§5.4）
    const rawReason = obj.stopReason;
    const stopReason = typeof rawReason === "string" ? rawReason : null;
    return { status, stopReason };
  }
}
