import type { SqliteStore } from "./store.js";
import type { RunRow, TaskSessionRow } from "./types.js";

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
  return lines.join("\n");
}
