import type { AgentRunner, PlanOutcome, PlanRunner, SessionContext } from "./types.js";

export interface ClaudePlanRunnerOptions {
  maxCostUsd: number;
}

export class ClaudePlanRunner implements PlanRunner {
  constructor(
    private readonly agent: AgentRunner,
    private readonly opts: ClaudePlanRunnerOptions,
  ) {}

  async run(ctx: { worktreePath: string; prompt: string; timeoutMs?: number; model?: string; effort?: string }): Promise<PlanOutcome> {
    const sessionCtx: SessionContext = {
      worktreePath: ctx.worktreePath,
      prompt: ctx.prompt,
      maxCostUsd: this.opts.maxCostUsd,
      hardTimeoutMs: ctx.timeoutMs,
    };
    const outcome = await this.agent.runSession(sessionCtx);
    switch (outcome.kind) {
      case "completed":
        return { kind: "completed", text: outcome.fullResult ?? outcome.summary, costUsd: outcome.costUsd };
      case "interrupted":
        return { kind: "interrupted", costUsd: outcome.costUsd };
      case "cost_exceeded":
        return { kind: "error", message: "design budget exceeded", costUsd: outcome.costUsd };
      case "error":
        return { kind: "error", message: outcome.message, costUsd: outcome.costUsd };
    }
  }
}
