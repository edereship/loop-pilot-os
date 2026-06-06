import type { SqliteStore } from "./store.js";
import type { TaskSessionRow } from "./types.js";

function fmtCost(costUsd: number | null): string {
  return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
}

function activeDetail(s: TaskSessionRow): string[] {
  const out: string[] = [];
  out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
  out.push(`  state: ${s.state}`);
  out.push(`  branch: ${s.branch}`);
  out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
  if (s.prNumber !== null) {
    out.push(`  (tracking PR #${s.prNumber})`);
  }
  if (s.monitorStartedAt !== null) {
    out.push(`  monitoring since ${s.monitorStartedAt}`);
  } else {
    out.push(`  started: ${s.startedAt}`);
  }
  return out;
}

function recentRow(s: TaskSessionRow): string {
  const reason = s.failureReason ?? "-";
  return `  ${s.linearIdentifier.padEnd(10)} ${s.state.padEnd(12)} ${reason.padEnd(20)} ${fmtCost(s.costUsd)}`;
}

export function renderStatus(store: SqliteStore): string {
  const lines: string[] = [];
  lines.push("LoopPilot OS status");
  lines.push("===================");

  const run = store.latestRun();
  if (run === null) {
    lines.push("");
    lines.push("No run found. Start the loop with: looppilot-os run");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Run #${run.id}`);
  lines.push(`  state: ${run.state}`);
  lines.push(`  started: ${run.startedAt}`);
  lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
  lines.push(`  merged: ${store.countMerged(run.id)}`);
  if (run.state === "halted") {
    lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
  }

  lines.push("");
  const active = store.activeSessions();
  if (active.length === 0) {
    lines.push("Active session: (none)");
  } else {
    for (const s of active) {
      lines.push(...activeDetail(s));
    }
  }

  lines.push("");
  const recent = store.recentSessions(10);
  lines.push("Recent sessions (latest 10)");
  if (recent.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(`  ${"id".padEnd(10)} ${"state".padEnd(12)} ${"failure_reason".padEnd(20)} cost`);
    for (const s of recent) {
      lines.push(recentRow(s));
    }
  }

  return lines.join("\n");
}
