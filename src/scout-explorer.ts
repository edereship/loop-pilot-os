import process from "node:process";
import { readdirSync, readlinkSync } from "node:fs";
import type { AgentRunner, CommandRunner } from "./types.js";
import { parseScoutOutput, type ScoutCandidate, MAX_CANDIDATES } from "./scout-parser.js";
import { buildScoutReformatPrompt } from "./scout-prompt.js";
import { readAll as readMemoryAll, writeCategory, commitIfChanged } from "./memory-store.js";

/** Read /proc/<pid>/cwd on Linux to find PIDs whose cwd is inside dir. */
function readProcCwdPids(dir: string): number[] {
  try {
    const entries = readdirSync("/proc");
    const result: number[] = [];
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (isNaN(pid) || pid <= 1) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === dir || cwd.startsWith(dir + "/")) result.push(pid);
      } catch { /* process may have exited or /proc entry inaccessible */ }
    }
    return result;
  } catch {
    return [];
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function msDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const REFORMAT_TIMEOUT_MS = 5 * 60_000;
export const REFORMAT_MIN_BUDGET_USD = 0.1;
export const REFORMAT_RAW_TAIL_CHARS = 20_000;

const RAW_PREVIEW_CHARS = 200;
const GIT_TIMEOUT_MS = 60_000;

export interface ScoutExplorerDeps {
  agent: AgentRunner;
  runner: CommandRunner;
  repoPath: string;
  /**
   * Pre-built prompt string, or a builder called after any git reset so spec content reflects
   * the freshly-checked-out commit rather than the pre-reset working tree (Finding 3 — ES-519).
   */
  prompt: string | (() => string);
  maxCostUsd: number;
  timeoutMs: number;
  log: (line: string) => void;
  /**
   * When true (or a function that returns true), the reformat prompt and candidate filter forbid
   * spec_mismatch. Accepts a function so the caller can resolve this after the prompt builder
   * runs and captures the actual spec-loading outcome (Finding 2 — ES-519).
   */
  objectiveOnly?: boolean | (() => boolean);
  /** When provided, fetch and reset to origin/<defaultBranch> before running the agent. */
  defaultBranch?: string;
  /**
   * Resolve the set of process-tree descendants of rootPid (Linux: reads /proc).
   * Returns null on non-Linux or when /proc is unreadable. When provided, SCOUT
   * cleanup only kills processes descended from this orchestrator or reparented to
   * init (Finding 2 — ES-519). When absent, the basic PID filter is used as fallback.
   */
  getDescendantPids?: (rootPid: number) => Set<number> | null;
  /**
   * Given a list of PIDs, return those whose PPID is 1 (reparented to init).
   * Only consulted when getDescendantPids is provided (Finding 2 — ES-519).
   */
  getReparentedPids?: (pids: number[]) => Set<number>;
  /**
   * Maximum number of candidates the parser is allowed to return. When absent,
   * defaults to MAX_CANDIDATES from scout-parser. Pass the operator-configured
   * max_issues_per_scout so the cap in the parser matches the configured value.
   */
  maxCandidates?: number;
  /**
   * Check if a process with the given PID is still alive. Defaults to process.kill(pid, 0).
   * Injectable for testing to prevent non-deterministic interaction with the real process table.
   */
  checkPidAlive?: (pid: number) => boolean;
  /**
   * Sleep for the given number of milliseconds. Defaults to a setTimeout-based delay.
   * Injectable for testing.
   */
  sleep?: (ms: number) => Promise<void>;
}

export type ScoutExplorationResult =
  | { kind: "ok"; candidates: ScoutCandidate[]; dropped: string[]; costUsd: number }
  | { kind: "error"; message: string; costUsd: number }
  | { kind: "interrupted"; costUsd: number };

export async function runScoutExploration(deps: ScoutExplorerDeps): Promise<ScoutExplorationResult> {
  const { agent, runner, repoPath, maxCostUsd, timeoutMs, log } = deps;
  const effectiveMaxCandidates = deps.maxCandidates ?? MAX_CANDIDATES;

  // Hoisted so the finally block can re-apply these after git clean removes untracked files
  // (Finding 2 — ES-519: restored memory must survive the cleanup git clean -fd).
  let preResetMem: ReturnType<typeof readMemoryAll> | undefined;

  // Refresh to the latest upstream state so SCOUT does not file tickets for bugs already fixed.
  if (deps.defaultBranch) {
    // Preserve local memory content before the hard reset: a local-only bootstrap commit
    // in docs/memory (created when startup rebase fails) is discarded by the reset and
    // would permanently lose pm_decisions / product_knowledge (Finding 6 — ES-519).
    preResetMem = readMemoryAll(repoPath);
    const fetchRes = await runner.run("git", ["fetch", "origin", deps.defaultBranch], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    }).catch(() => null);
    if (fetchRes === null || fetchRes.code !== 0) {
      log(`scout: warning: git fetch origin ${deps.defaultBranch} failed; running on current HEAD`);
    } else {
      const resetRes = await runner.run("git", ["reset", "--hard", `origin/${deps.defaultBranch}`], {
        cwd: repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
      }).catch(() => null);
      if (resetRes === null || resetRes.code !== 0) {
        log(`scout: warning: git reset --hard origin/${deps.defaultBranch} failed; running on current HEAD`);
      } else {
        // Reset succeeded: restore categories that had local content but are now absent
        // (e.g. local-only bootstrap commit removed by the reset). Only fill gaps — do
        // NOT overwrite categories that upstream already provides, which would revert
        // newer content that arrived via the fetch+reset (Finding 1 — Codex review).
        const postResetMem = readMemoryAll(repoPath);
        const NO_LIMIT = Number.MAX_SAFE_INTEGER;
        if (preResetMem.pmDecisions !== null && postResetMem.pmDecisions === null) {
          try { writeCategory(repoPath, "pm_decisions", preResetMem.pmDecisions, NO_LIMIT); } catch { /* best-effort */ }
        }
        if (preResetMem.implResults !== null && postResetMem.implResults === null) {
          try { writeCategory(repoPath, "impl_results", preResetMem.implResults, NO_LIMIT); } catch { /* best-effort */ }
        }
        if (preResetMem.productKnowledge !== null && postResetMem.productKnowledge === null) {
          try { writeCategory(repoPath, "product_knowledge", preResetMem.productKnowledge, NO_LIMIT); } catch { /* best-effort */ }
        }
      }
    }
  }

  // Resolve the prompt after any git reset so a builder receives fresh file contents (Finding 3).
  const prompt = typeof deps.prompt === "function" ? deps.prompt() : deps.prompt;
  // Resolve objectiveOnly AFTER the prompt builder so dynamic callers (e.g. the orchestrator)
  // can capture the actual spec-loading outcome from inside the builder (Finding 2 — ES-519).
  const effectiveObjectiveOnly = typeof deps.objectiveOnly === "function"
    ? deps.objectiveOnly()
    : (deps.objectiveOnly ?? false);

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

  // Snapshot PIDs with files open in repoPath before SCOUT starts.  Cleanup uses this
  // to exclude pre-existing processes (editors, daemons, LSPs) that happened to have
  // PPID=1 but were not spawned by SCOUT — only PIDs that appear NEW after the agent
  // runs are treated as reparented SCOUT orphans (Finding 3 — Codex review, iteration 14).
  const preScanPids = new Set<number>();
  try {
    const preScan = await runner.run("lsof", ["+D", repoPath, "-t"], {
      cwd: repoPath,
      timeoutMs: 10_000,
    });
    preScan.stdout.trim().split("\n").filter(Boolean).forEach(p => {
      const n = parseInt(p, 10);
      if (!isNaN(n)) preScanPids.add(n);
    });
  } catch { /* lsof unavailable — preScanPids stays empty; cleanup falls back to ancestry alone */ }

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
    const parsed = parseScoutOutput(raw, effectiveMaxCandidates);
    if (parsed.kind === "ok") {
      const filtered = applyObjectiveOnlyFilter(parsed, effectiveObjectiveOnly);
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
      prompt: buildScoutReformatPrompt(raw.slice(-REFORMAT_RAW_TAIL_CHARS), effectiveObjectiveOnly),
      maxCostUsd: remaining,
      hardTimeoutMs: REFORMAT_TIMEOUT_MS,
    });
    costUsd += retry.costUsd;
    if (retry.kind === "interrupted") return { kind: "interrupted", costUsd };
    if (retry.kind !== "completed") {
      const detail = retry.kind === "error" ? retry.message : retry.kind;
      return { kind: "error", message: `parse failed (reformat ${detail})`, costUsd };
    }
    const retryParsed = parseScoutOutput(retry.fullResult ?? retry.summary, effectiveMaxCandidates);
    if (retryParsed.kind === "ok") {
      const filtered = applyObjectiveOnlyFilter(retryParsed, effectiveObjectiveOnly);
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
    // Kill background processes started by the agent (e.g. dev servers launched via test commands)
    // before restoring git state so they cannot hold locks on repo files (Finding 5 — ES-519).
    await cleanupProcesses();
    await cleanupStep(["checkout", "HEAD", "--", "."]);
    // Use -fd (not -fdx) to avoid deleting ignored files such as .env, *.db, and node_modules
    // that the running process depends on (ES-519 Finding 3).
    await cleanupStep(["clean", "-fd"]);
    // Restore the original branch before resetting; only reset if the restore succeeds so we
    // don't rewind a different branch when the original was removed during exploration.
    if (startBranch) {
      const restored = await cleanupStep(["checkout", startBranch]);
      if (restored && startSha) await cleanupStep(["reset", "--hard", startSha]);
    } else if (startSha) {
      // Detached HEAD: use "checkout --detach" to return to the original commit instead
      // of "reset --hard", which would reset whichever branch the agent may have checked
      // out during exploration rather than restoring the detached HEAD position.
      await cleanupStep(["checkout", "--detach", startSha]);
    }
    // Re-apply memory content after git clean -fd so a local-only bootstrap commit in
    // docs/memory is not permanently lost (Finding 2 — ES-519): git clean deletes the
    // untracked files we wrote back after git reset --hard.
    // Only restore categories that are absent after cleanup; preserve upstream content
    // that the post-cleanup git state already provides (Finding 1 — Codex review).
    if (preResetMem !== undefined) {
      const NO_LIMIT = Number.MAX_SAFE_INTEGER;
      let wroteMemory = false;
      const postCleanupMem = readMemoryAll(repoPath);
      if (preResetMem.pmDecisions !== null && postCleanupMem.pmDecisions === null) {
        try { writeCategory(repoPath, "pm_decisions", preResetMem.pmDecisions, NO_LIMIT); wroteMemory = true; } catch { /* best-effort */ }
      }
      if (preResetMem.implResults !== null && postCleanupMem.implResults === null) {
        try { writeCategory(repoPath, "impl_results", preResetMem.implResults, NO_LIMIT); wroteMemory = true; } catch { /* best-effort */ }
      }
      if (preResetMem.productKnowledge !== null && postCleanupMem.productKnowledge === null) {
        try { writeCategory(repoPath, "product_knowledge", preResetMem.productKnowledge, NO_LIMIT); wroteMemory = true; } catch { /* best-effort */ }
      }
      // Commit any restored files so the next runPreflight's clean-worktree check does not
      // see uncommitted changes and strand the daemon (Finding 2 — ES-519).
      if (wroteMemory) {
        try { await commitIfChanged(runner, repoPath, "chore: restore scout memory after cleanup"); } catch { /* best-effort */ }
      }
    }
  }

  async function cleanupProcesses(): Promise<void> {
    const effectiveCheckPidAlive = deps.checkPidAlive ?? pidIsAlive;
    const effectiveSleep = deps.sleep ?? msDelay;
    const KILL_POLL_INTERVAL_MS = 200;
    const KILL_MAX_POLLS = 15; // up to ~3 s of waiting

    // Send SIGTERM then poll; escalate to SIGKILL for survivors (Finding 3 — Codex review).
    async function termEscalate(pids: string[]): Promise<void> {
      await runner.run("kill", ["-TERM", ...pids], { cwd: repoPath, timeoutMs: 5_000 }).catch(() => null);
      let remaining = pids.filter(p => effectiveCheckPidAlive(parseInt(p, 10)));
      for (let poll = 0; poll < KILL_MAX_POLLS && remaining.length > 0; poll++) {
        await effectiveSleep(KILL_POLL_INTERVAL_MS);
        remaining = remaining.filter(p => effectiveCheckPidAlive(parseInt(p, 10)));
      }
      if (remaining.length > 0) {
        log(`scout: ${remaining.length} process(es) still alive after SIGTERM; escalating to SIGKILL: ${remaining.join(",")}`);
        await runner.run("kill", ["-KILL", ...remaining], { cwd: repoPath, timeoutMs: 5_000 }).catch(() => null);
      }
    }

    try {
      let rawPids: string[];
      try {
        const lsofResult = await runner.run("lsof", ["+D", repoPath, "-t"], {
          cwd: repoPath,
          timeoutMs: 10_000,
        });
        rawPids = lsofResult.stdout.trim().split("\n").filter(Boolean);
      } catch {
        // lsof unavailable or failed — use /proc cwd scan (catches reparented processes that
        // ancestry misses) combined with ancestry scan (catches descendants whose cwd changed).
        // (Finding 3 — ES-519: reparented PIDs are no longer descendants of process.pid.)
        const myPid = process.pid;
        const cwdPids = readProcCwdPids(repoPath).filter(p => p !== myPid);

        let pidsToKill: number[];
        if (deps.getDescendantPids) {
          const descendants = deps.getDescendantPids(myPid) ?? new Set<number>();
          // Union cwd-scan and descendant-scan results, then apply the same guard used in
          // the lsof path: only kill PIDs that are confirmed descendants, reparented to init,
          // or descendants of a reparented PID.  Unrelated editors/watchers/test runners
          // whose cwd happens to be inside repoPath are NOT killed (Finding 3 — ES-519).
          const allCandidates = [...new Set([...cwdPids, ...descendants])].filter(p => p !== myPid);
          const reparented = deps.getReparentedPids
            ? new Set([...deps.getReparentedPids(allCandidates)].filter(p => !preScanPids.has(p)))
            : new Set<number>();
          const reparentedDescendants = new Set<number>();
          for (const rp of reparented) {
            const rpDescs = deps.getDescendantPids(rp);
            if (rpDescs) for (const d of rpDescs) reparentedDescendants.add(d);
          }
          pidsToKill = allCandidates.filter(p =>
            descendants.has(p) || reparented.has(p) || reparentedDescendants.has(p)
          );
        } else {
          // No ancestry guard available; kill all cwd-scan candidates as before.
          pidsToKill = cwdPids;
        }

        if (pidsToKill.length > 0) {
          const pids = pidsToKill.map(String);
          log(`scout: (lsof unavailable) killing ${pids.length} process(es) in repo: ${pids.join(",")}`);
          await termEscalate(pids);
        }
        return;
      }
      const myPid = String(process.pid);
      const basicFiltered = rawPids.filter(p => /^\d+$/.test(p) && p !== "0" && p !== "1" && p !== myPid);
      if (basicFiltered.length === 0) return;

      // Use the descendant/reparented guard when available so unrelated processes that happen
      // to have files open in repoPath (editors, watchers, other test commands) are not killed
      // (Finding 2 — ES-519). Falls back to basic filtering when ancestry is unavailable.
      let pids: string[];
      if (deps.getDescendantPids) {
        const descendants = deps.getDescendantPids(process.pid);
        if (descendants !== null) {
          const candidateNums = basicFiltered.map(p => parseInt(p, 10));
          const reparented = deps.getReparentedPids
            ? new Set([...deps.getReparentedPids(candidateNums)].filter(p => !preScanPids.has(p)))
            : new Set<number>();
          const reparentedDescendants = new Set<number>();
          for (const rp of reparented) {
            const rpDescs = deps.getDescendantPids(rp);
            if (rpDescs) for (const d of rpDescs) reparentedDescendants.add(d);
          }
          pids = basicFiltered.filter(p => {
            const pid = parseInt(p, 10);
            return descendants.has(pid) || reparented.has(pid) || reparentedDescendants.has(pid);
          });
        } else {
          // Ancestry cannot be determined (non-Linux host); skip the kill entirely to avoid
          // terminating unrelated editors/watchers that happen to have files open in repoPath
          // but were not spawned by SCOUT (Finding 3 — Codex review).
          pids = [];
        }
      } else {
        pids = basicFiltered;
      }

      if (pids.length === 0) return;
      log(`scout: killing ${pids.length} orphaned process(es): ${pids.join(",")}`);
      await termEscalate(pids);
    } catch {
      // best-effort: process cleanup must not abort git cleanup
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
