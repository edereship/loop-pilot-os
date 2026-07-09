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
  /** When true, the reformat prompt forbids spec_mismatch candidates (no specs were provided). */
  objectiveOnly?: boolean;
}

export type ScoutExplorationResult =
  | { kind: "ok"; candidates: ScoutCandidate[]; dropped: string[]; costUsd: number }
  | { kind: "error"; message: string; costUsd: number }
  | { kind: "interrupted"; costUsd: number };

export async function runScoutExploration(deps: ScoutExplorerDeps): Promise<ScoutExplorationResult> {
  const { agent, runner, repoPath, prompt, maxCostUsd, timeoutMs, log } = deps;

  const startSha = await runner
    .run("git", ["rev-parse", "HEAD"], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS })
    .then((r) => (r.code === 0 ? r.stdout.trim() || null : null))
    .catch(() => null);
  if (startSha === null) {
    log("scout: warning: could not capture startSha (git rev-parse HEAD failed); reset --hard will be skipped in cleanup");
  }

  // Capture the branch name so cleanup can restore it if SCOUT checks out another branch.
  // "HEAD" indicates a detached HEAD state; treat that as null (no branch to restore).
  const startBranch = await runner
    .run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS })
    .then((r) => {
      const b = r.code === 0 ? r.stdout.trim() : "";
      return b && b !== "HEAD" ? b : null;
    })
    .catch(() => null);

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
      const filtered = applyObjectiveOnlyFilter(parsed, deps.objectiveOnly ?? false);
      return { kind: "ok", candidates: filtered.candidates, dropped: filtered.dropped, costUsd };
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
      prompt: buildScoutReformatPrompt(raw.slice(-REFORMAT_RAW_TAIL_CHARS), deps.objectiveOnly ?? false),
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
      const filtered = applyObjectiveOnlyFilter(retryParsed, deps.objectiveOnly ?? false);
      return { kind: "ok", candidates: filtered.candidates, dropped: filtered.dropped, costUsd };
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
    // -fdx removes ignored files (build caches, coverage, etc.) that -fd would leave behind
    // and that could affect later loop iterations while git status remains clean.
    await cleanupStep(["clean", "-fdx"]);
    // Restore the original branch before resetting; only reset if the restore succeeds so we
    // don't rewind a different branch when the original was removed during exploration.
    if (startBranch) {
      const restored = await cleanupStep(["checkout", startBranch]);
      if (restored && startSha) await cleanupStep(["reset", "--hard", startSha]);
    } else if (startSha) {
      await cleanupStep(["reset", "--hard", startSha]);
    }
  }

  async function cleanupStep(args: string[]): Promise<boolean> {
    try {
      const res = await runner.run("git", args, { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
      if (res.code !== 0) {
        log(`scout: cleanup "git ${args.join(" ")}" exited ${res.code}`);
        return false;
      }
      return true;
    } catch (err) {
      log(`scout: cleanup "git ${args.join(" ")}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

function applyObjectiveOnlyFilter(
  result: { candidates: ScoutCandidate[]; dropped: string[] },
  objectiveOnly: boolean,
): { candidates: ScoutCandidate[]; dropped: string[] } {
  if (!objectiveOnly) return result;
  const dropped = [...result.dropped];
  const candidates = result.candidates.filter((c) => {
    if (c.evidence_type === "spec_mismatch") {
      dropped.push(`candidate dropped (objectiveOnly): "${c.title}"`);
      return false;
    }
    return true;
  });
  return { candidates, dropped };
}
