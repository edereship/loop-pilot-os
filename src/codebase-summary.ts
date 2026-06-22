import type { CommandRunner } from "./types.js";

const BATCH_SIZE = 500;

interface FileEntry {
  path: string;
  lines: number | null;
}

function parseWcOutput(stdout: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of stdout.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && match[2] !== "total") {
      map.set(match[2], parseInt(match[1], 10));
    }
  }
  return map;
}

function formatSummary(entries: FileEntry[], budgetChars: number): string {
  const total = entries.reduce((sum, e) => sum + (e.lines ?? 0), 0);
  const hasLines = entries.some(e => e.lines !== null);
  const fileWord = entries.length === 1 ? "1 file" : `${entries.length} files`;
  const header = hasLines ? `${fileWord}, ${total} lines total` : `${fileWord}`;

  const lines: string[] = [header, ""];
  let used = header.length + 1;
  let listed = 0;

  for (const entry of entries) {
    const line = entry.lines !== null
      ? `${entry.path} (${entry.lines}L)`
      : entry.path;
    if (used + line.length + 1 > budgetChars) {
      const remaining = entries.length - listed;
      lines.push(`... (${remaining} more files omitted)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
    listed++;
  }

  return lines.join("\n");
}

export async function generateCodebaseSummary(
  repoPath: string,
  cmd: CommandRunner,
  budgetChars: number,
): Promise<string> {
  const lsResult = await cmd.run("git", ["ls-files"], { cwd: repoPath });
  if (lsResult.code !== 0) return "";

  const files = lsResult.stdout.trim().split("\n").filter(f => f.length > 0);
  if (files.length === 0) return "";

  const lineCounts = new Map<string, number>();
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const wcResult = await cmd.run("wc", ["-l", ...batch], { cwd: repoPath });
    if (wcResult.code === 0) {
      for (const [path, count] of parseWcOutput(wcResult.stdout)) {
        lineCounts.set(path, count);
      }
    }
  }

  const entries: FileEntry[] = files.map(f => ({
    path: f,
    lines: lineCounts.get(f) ?? null,
  }));

  return formatSummary(entries, budgetChars);
}
