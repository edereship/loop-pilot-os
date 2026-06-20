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

    // Sync the local PR branch to origin before running the fix agent. MONITOR
    // never fetches, so if LoopPilot has pushed review-fix commits since this
    // worktree was created the local checkout is behind — the fix agent would
    // edit a stale base and the later `git push` would be rejected as non-fast-
    // forward, surfacing as `workflow_setup_failed` instead of recovering
    // (Finding 3).
    const syncError = await this.syncBranchToOrigin(ctx.branch, ctx.worktreePath);
    if (syncError !== null) {
      return { kind: "unrecoverable", costUsd: 0, message: syncError };
    }

    const outcome = await this.agent.runSession({
      worktreePath: ctx.worktreePath,
      prompt: buildFixPrompt(ctx.errorBody),
      maxCostUsd: ctx.maxCostUsd,
      ...(ctx.hardTimeoutMs !== undefined ? { hardTimeoutMs: ctx.hardTimeoutMs } : {}),
    });

    if (outcome.kind === "interrupted") {
      this.totalCostUsdByPr.set(prNumber, totalCostUsd + outcome.costUsd);
      // If the fix agent left uncommitted edits (e.g. SIGINT during rate-limit
      // sleep after editing files but before committing), commit them as a WIP
      // so that the next attemptRecovery's syncBranchToOrigin (`git reset --hard`)
      // doesn't silently destroy the partial work.
      const statusResult = await this.runner.run(
        "git",
        ["-C", ctx.worktreePath, "status", "--porcelain"],
        { cwd: ctx.worktreePath },
      );
      if (statusResult.stdout.trim() !== "") {
        const addResult = await this.runner.run(
          "git",
          ["-C", ctx.worktreePath, "add", "-A"],
          { cwd: ctx.worktreePath },
        );
        if (addResult.code === 0) {
          await this.runner.run(
            "git",
            ["-C", ctx.worktreePath, "commit", "-m", "WIP: interrupted fix-agent edits"],
            { cwd: ctx.worktreePath },
          );
          // If commit fails (code !== 0), edits stay uncommitted; nothing more we can do.
        }
      }
      // If the fix agent committed work before being interrupted (e.g. during a
      // rate-limit sleep), push those commits now. Without this, the next call to
      // attemptRecovery would run syncBranchToOrigin which does
      // `git reset --hard origin/<branch>` and silently discards the local commits.
      const logResult = await this.runner.run(
        "git",
        ["-C", ctx.worktreePath, "log", `origin/${ctx.branch}..HEAD`, "--oneline"],
        { cwd: ctx.worktreePath },
      );
      if (logResult.stdout.trim() !== "") {
        try {
          await this.pushFix(ctx.branch, ctx.worktreePath);
          // The LoopPilot workflow only fires on issue_comment / pull_request_review,
          // not on push/synchronize. Post /restart-review so the pushed fix is
          // reviewed without waiting for a human comment.
          try {
            await this.postRestartReview(ctx.prNumber);
          } catch {
            // best-effort; push succeeded — a human can /restart-review manually
          }
          // Push succeeded: return restarted so the orchestrator increments
          // workflowFixAttempts, records workflowHandledErrorCount, and resets
          // monitorStartedAt — preventing duplicate fix runs and false not-engaged
          // guard triggers on the next poll.
          return { kind: "restarted", costUsd: outcome.costUsd, newFix: true };
        } catch {
          // Push failed — commits stay local-only. Nothing more we can do; the
          // interrupted outcome is still returned so the caller can stop the session.
        }
      }
      return { kind: "interrupted", costUsd: outcome.costUsd };
    }
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
    // Push the verified HEAD as `<branch>`, not the local ref named `<branch>`.
    // The verification above (status clean + commits ahead of origin/<branch>) is
    // measured against HEAD, but if the fix agent leaves the worktree on a
    // temporary branch or detached HEAD, `git push origin <branch>` would push
    // the unchanged PR branch — verification would succeed yet the restart would
    // be sent without the fix (Finding 4).
    const result = await this.runner.run(
      "git",
      ["push", "origin", `HEAD:${branch}`],
      { cwd: worktreePath },
    );
    if (result.code !== 0) {
      throw new Error(
        `git push failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
  }

  /**
   * Fast-forward the local checkout to `origin/<branch>` before running the fix.
   * Returns an error message string on failure (so the caller can return
   * `unrecoverable`), or null on success. We intentionally use `reset --hard`
   * rather than `pull --ff-only`: the worktree is LoopPilot-owned for this
   * session, no human edits ever land in it, and any local divergence would be
   * stale state from a previous fix attempt that should be discarded.
   */
  private async syncBranchToOrigin(
    branch: string,
    worktreePath: string,
  ): Promise<string | null> {
    const fetchResult = await this.runner.run(
      "git",
      ["-C", worktreePath, "fetch", "origin", branch],
      { cwd: worktreePath },
    );
    if (fetchResult.code !== 0) {
      return `git fetch failed: ${fetchResult.stderr.trim() || `exit ${fetchResult.code}`}`;
    }
    const resetResult = await this.runner.run(
      "git",
      ["-C", worktreePath, "reset", "--hard", `origin/${branch}`],
      { cwd: worktreePath },
    );
    if (resetResult.code !== 0) {
      return `git reset --hard origin/${branch} failed: ${resetResult.stderr.trim() || `exit ${resetResult.code}`}`;
    }
    return null;
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
