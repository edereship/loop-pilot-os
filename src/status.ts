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
    // 重複可読化: ヘッダ外でも "PR #<n>" を含める（grep 容易化）
    out.push(`  (tracking PR #${s.prNumber})`);
  }
  if (s.monitorStartedAt !== null) {
    out.push(`  monitoring since ${s.monitorStartedAt}`);
  } else {
    out.push(`  started: ${s.startedAt}`);
  }
  return out;
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

  return lines.join("\n");
}
