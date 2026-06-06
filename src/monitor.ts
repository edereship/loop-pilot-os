import type {
  CommandRunner,
  LoopPilotMonitor,
  MergeReadiness,
  MonitorVerdict,
} from "./types.js";

// ---- gh pr view --json の型 ---------------------------------------------

interface PrViewJson {
  state: string;
  mergedAt: string | null;
  mergeable: string;
  mergeStateStatus: string;
  headRefOid: string;
  statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
  closed: boolean;
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

    // 残りの verdict 分岐は Step 7b の red→green で実装する（現時点は未実装）
    throw new Error("poll: non-merged verdicts not implemented yet");
  }

  async checkMergeReadiness(_prNumber: number): Promise<MergeReadiness> {
    // ①-⑥ は Step 9b の red→green で実装する（現時点は未実装）
    throw new Error("checkMergeReadiness not implemented yet");
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
    return JSON.parse(result.stdout) as PrViewJson;
  }
}
