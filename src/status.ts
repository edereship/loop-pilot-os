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
  return lines.join("\n");
}
