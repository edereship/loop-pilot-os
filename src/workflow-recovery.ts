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
  // In-memory cost accumulator for reporting in the `exhausted` outcome only.
  // Not persisted; resets on process restart. The orchestrator independently
  // persists individual fix costs on the session row via RecoveryOutcome.costUsd.
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
    const totalCostUsd = this.totalCostUsdByPr.get(prNumber) ?? 0;

    // Guard: all existing errors were addressed by a previous fix run (Finding 5).
    // Compare against handledErrorCount (the errorCommentCount at the last fix) rather
    // than fixAttempts, so a backlog of N pre-existing comments is handled atomically.
    if (ctx.errorCommentCount <= ctx.handledErrorCount) {
      return { kind: "restarted", costUsd: 0, newFix: false };
    }

    // Budget: max fix-agent runs exhausted (Finding 2 — fixAttempts is durable, not in-memory).
    if (ctx.fixAttempts >= this.maxAttempts) {
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

    // Verify the fix agent actually committed its changes before pushing (Finding 3).
    const statusResult = await this.runner.run(
      "git",
      ["-C", ctx.worktreePath, "status", "--porcelain"],
      { cwd: ctx.worktreePath },
    );
    if (statusResult.stdout.trim() !== "") {
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: "fix agent left uncommitted changes",
      };
    }
    const logResult = await this.runner.run(
      "git",
      ["-C", ctx.worktreePath, "log", `origin/${ctx.branch}..HEAD`, "--oneline"],
      { cwd: ctx.worktreePath },
    );
    if (logResult.stdout.trim() === "") {
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: "fix agent made no commits",
      };
    }

    // Push the fix and post /restart-review. Return unrecoverable (with cost) on
    // side-effect failures rather than throwing, so the orchestrator can persist
    // the spend before stopping the session (Finding 4).
    try {
      await this.pushFix(ctx.branch, ctx.worktreePath);
    } catch (err) {
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: `git push failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await this.postRestartReview(ctx.prNumber);
    } catch (err) {
      return {
        kind: "unrecoverable",
        costUsd: outcome.costUsd,
        message: `restart review failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.log(
      `workflow fix attempt ${ctx.fixAttempts + 1}/${this.maxAttempts} ` +
        `for PR #${ctx.prNumber} (cost=$${outcome.costUsd.toFixed(2)})`,
    );
    return { kind: "restarted", costUsd: outcome.costUsd, newFix: true };
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
