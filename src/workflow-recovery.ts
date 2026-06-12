import type {
  AgentRunner,
  CommandRunner,
  RecoveryContext,
  RecoveryOutcome,
  WorkflowRecovery,
} from "./types.js";

export function buildFixPrompt(errorBody: string): string {
  return `The LoopPilot review workflow failed with the following error:

---
${errorBody}
---

Fix the issue in this repository so the workflow can succeed.
Common infrastructure fixes include:
- Generate missing package-lock.json (run \`npm install\`)
- Fix dependency version mismatches
- Fix configuration files required by CI

Commit your changes with a clear message describing the fix.
Do NOT push — the orchestrator handles pushing.`;
}

export class AgentWorkflowRecovery implements WorkflowRecovery {
  private fixAttemptsByPr = new Map<number, number>();
  private totalCostUsdByPr = new Map<number, number>();

  constructor(
    private readonly agent: AgentRunner,
    private readonly runner: CommandRunner,
    private readonly remote: string,
    private readonly maxAttempts: number,
    private readonly log: (line: string) => void,
  ) {}

  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome> {
    const { prNumber } = ctx;
    const fixAttempts = this.fixAttemptsByPr.get(prNumber) ?? 0;
    const totalCostUsd = this.totalCostUsdByPr.get(prNumber) ?? 0;

    if (ctx.errorCommentCount <= fixAttempts) {
      return { kind: "restarted", costUsd: 0 };
    }

    if (fixAttempts >= this.maxAttempts) {
      return { kind: "exhausted", costUsd: totalCostUsd };
    }

    const outcome = await this.agent.runSession({
      worktreePath: ctx.worktreePath,
      prompt: buildFixPrompt(ctx.errorBody),
      maxCostUsd: ctx.maxCostUsd,
      ...(ctx.hardTimeoutMs !== undefined ? { hardTimeoutMs: ctx.hardTimeoutMs } : {}),
    });

    if (outcome.kind === "cost_exceeded") {
      this.totalCostUsdByPr.set(prNumber, totalCostUsd + outcome.costUsd);
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: "fix agent exceeded cost limit",
      };
    }
    if (outcome.kind === "error") {
      this.totalCostUsdByPr.set(prNumber, totalCostUsd + outcome.costUsd);
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: outcome.message,
      };
    }

    this.totalCostUsdByPr.set(prNumber, totalCostUsd + outcome.costUsd);

    await this.pushFix(ctx.branch, ctx.worktreePath);
    await this.postRestartReview(ctx.prNumber);

    const newAttempts = fixAttempts + 1;
    this.fixAttemptsByPr.set(prNumber, newAttempts);
    this.log(
      `workflow fix attempt ${newAttempts}/${this.maxAttempts} ` +
        `for PR #${ctx.prNumber} (cost=$${outcome.costUsd.toFixed(2)})`,
    );
    return { kind: "restarted", costUsd: outcome.costUsd };
  }

  private async pushFix(
    branch: string,
    worktreePath: string,
  ): Promise<void> {
    const result = await this.runner.run(
      "git",
      ["push", "origin", branch],
      { cwd: worktreePath },
    );
    if (result.code !== 0) {
      throw new Error(
        `git push failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
  }

  private async postRestartReview(prNumber: number): Promise<void> {
    const result = await this.runner.run(
      "gh",
      [
        "pr",
        "comment",
        String(prNumber),
        "-R",
        this.remote,
        "-b",
        "/restart-review",
      ],
      { cwd: process.cwd() },
    );
    if (result.code !== 0) {
      throw new Error(
        `gh pr comment failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
  }
}
