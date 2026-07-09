import type { AgentRunner, CommandRunner } from "./types.js";
import { parseScoutOutput, type ScoutCandidate } from "./scout-parser.js";
import { buildScoutReformatPrompt } from "./scout-prompt.js";

export const REFORMAT_TIMEOUT_MS = 5 * 60_000;
export const REFORMAT_MIN_BUDGET_USD = 0.1;
export const REFORMAT_RAW_TAIL_CHARS = 20_000;

const RAW_PREVIEW_CHARS = 200;
const GIT_TIMEOUT_MS = 60_000;

export interface ScoutExplorerDeps {
  agent: AgentRunner;
  runner: CommandRunner;
  repoPath: string;
  prompt: string;
  maxCostUsd: number;
  timeoutMs: number;
  log: (line: string) => void;
}

export type ScoutExplorationResult =
  | { kind: "ok"; candidates: ScoutCandidate[]; dropped: string[]; costUsd: number }
  | { kind: "error"; message: string; costUsd: number }
  | { kind: "interrupted"; costUsd: number };

export async function runScoutExploration(deps: ScoutExplorerDeps): Promise<ScoutExplorationResult> {
  const { agent, runner, repoPath, prompt, maxCostUsd, timeoutMs, log } = deps;

  const startSha = await runner
    .run("git", ["rev-parse", "HEAD"], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS })
    .then((r) => (r.code === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (startSha === null) {
    log("scout: warning: could not capture startSha (git rev-parse HEAD failed); reset --hard will be skipped in cleanup");
  }

  let costUsd = 0;
  try {
    const outcome = await agent.runSession({
      worktreePath: repoPath,
      prompt,
      maxCostUsd,
      hardTimeoutMs: timeoutMs,
    });
    costUsd += outcome.costUsd;
    if (outcome.kind === "interrupted") return { kind: "interrupted", costUsd };
    if (outcome.kind === "cost_exceeded") {
      return { kind: "error", message: `scout agent cost exceeded ($${costUsd.toFixed(2)})`, costUsd };
    }
    if (outcome.kind === "error") {
      return { kind: "error", message: outcome.message, costUsd };
    }

    const raw = outcome.fullResult ?? outcome.summary;
    const parsed = parseScoutOutput(raw);
    if (parsed.kind === "ok") {
      return { kind: "ok", candidates: parsed.candidates, dropped: parsed.dropped, costUsd };
    }

    log(`scout: parse failed, raw preview: ${parsed.raw.slice(0, RAW_PREVIEW_CHARS)}`);
    if (raw.trim().length === 0) {
      return { kind: "error", message: "parse failed (reformat skipped: empty raw)", costUsd };
    }
    const remaining = maxCostUsd - costUsd;
    if (remaining < REFORMAT_MIN_BUDGET_USD) {
      return {
        kind: "error",
        message: `parse failed (reformat skipped: remaining budget $${remaining.toFixed(2)})`,
        costUsd,
      };
    }
    log("scout: retrying with reformat prompt");
    const retry = await agent.runSession({
      worktreePath: repoPath,
      prompt: buildScoutReformatPrompt(raw.slice(-REFORMAT_RAW_TAIL_CHARS)),
      maxCostUsd: remaining,
      hardTimeoutMs: REFORMAT_TIMEOUT_MS,
    });
    costUsd += retry.costUsd;
    if (retry.kind === "interrupted") return { kind: "interrupted", costUsd };
    if (retry.kind !== "completed") {
      const detail = retry.kind === "error" ? retry.message : retry.kind;
      return { kind: "error", message: `parse failed (reformat ${detail})`, costUsd };
    }
    const retryParsed = parseScoutOutput(retry.fullResult ?? retry.summary);
    if (retryParsed.kind === "ok") {
      return { kind: "ok", candidates: retryParsed.candidates, dropped: retryParsed.dropped, costUsd };
    }
    return {
      kind: "error",
      message: `parse failed: ${retryParsed.raw.slice(0, RAW_PREVIEW_CHARS)}`,
      costUsd,
    };
  } catch (err) {
    return {
      kind: "error",
      message: `scout exploration exception: ${err instanceof Error ? err.message : String(err)}`,
      costUsd,
    };
  } finally {
    await cleanupStep(["checkout", "HEAD", "--", "."]);
    await cleanupStep(["clean", "-fd"]);
    if (startSha) await cleanupStep(["reset", "--hard", startSha]);
  }

  async function cleanupStep(args: string[]): Promise<void> {
    try {
      const res = await runner.run("git", args, { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
      if (res.code !== 0) log(`scout: cleanup "git ${args.join(" ")}" exited ${res.code}`);
    } catch (err) {
      log(`scout: cleanup "git ${args.join(" ")}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
