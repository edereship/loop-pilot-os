import type { CommandRunner } from "./types.js";

const BATCH_SIZE = 500;

interface FileEntry {
  path: string;
  lines: number | null;
}

function parseWcOutput(stdout: string, fileSet: Set<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of stdout.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    let path = match[2].trim();
    // Strip leading "./" normalization added when sanitizing "-"-prefixed filenames
    if (path.startsWith("./")) path = path.slice(2);
    if (fileSet.has(path) && !map.has(path)) {
      map.set(path, parseInt(match[1], 10));
    }
  }
  return map;
}

function formatSummary(entries: FileEntry[], budgetChars: number): string {
  const total = entries.reduce((sum, e) => sum + (e.lines ?? 0), 0);
  const hasLines = entries.some(e => e.lines !== null);
  const fileWord = entries.length === 1 ? "1 file" : `${entries.length} files`;
  const header = hasLines ? `${fileWord}, ${total} lines total` : `${fileWord}`;

  const omissionTemplate = `... (${entries.length} more files omitted)`;
  const omissionReserve = omissionTemplate.length + 1;

  const lines: string[] = [header, ""];
  let used = header.length + 1;
  let listed = 0;

  for (const entry of entries) {
    const line = entry.lines !== null
      ? `${entry.path} (${entry.lines}L)`
      : entry.path;
    if (used + line.length + 1 + omissionReserve > budgetChars) {
      const remaining = entries.length - listed;
      const fileWord = remaining === 1 ? "file" : "files";
      lines.push(`... (${remaining} more ${fileWord} omitted)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
    listed++;
  }

  const result = lines.join("\n");
  return result.length <= budgetChars ? result : result.slice(0, budgetChars);
}

export async function generateCodebaseSummary(
  repoPath: string,
  cmd: CommandRunner,
  budgetChars: number,
): Promise<string> {
  // Use -s (stage info for mode detection) and -z (NUL-delimited, safe for unusual filenames).
  const lsResult = await cmd.run(
    "git", ["-c", "core.quotePath=false", "ls-files", "-sz"],
    { cwd: repoPath },
  );
  if (lsResult.code !== 0) return "";

  // Parse NUL-delimited stage records: "<mode> <sha> <stage>\t<path>"
  const files: string[] = [];
  for (const record of lsResult.stdout.split("\0")) {
    if (record.length === 0) continue;
    const spaceIdx = record.indexOf(" ");
    const tabIdx = record.indexOf("\t");
    if (spaceIdx === -1 || tabIdx === -1) continue;
    const modeStr = record.slice(0, spaceIdx);
    // Skip symlinks (mode 120000): wc follows the symlink and blocks indefinitely
    // on device/pipe targets such as /dev/zero.
    if (modeStr === "120000") continue;
    const filePath = record.slice(tabIdx + 1);
    if (filePath.length > 0) files.push(filePath);
  }
  if (files.length === 0) return "";

  const lineCounts = new Map<string, number>();
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    // Prefix filenames starting with '-' with "./" to prevent wc from treating them
    // as options or as stdin (the special "-" filename).
    const sanitizedBatch = batch.map(f => f.startsWith("-") ? `./${f}` : f);
    const batchSet = new Set(batch);
    let wcStdout: string;
    try {
      const wcResult = await cmd.run("wc", ["-l", ...sanitizedBatch], { cwd: repoPath });
      wcStdout = wcResult.stdout;
    } catch {
      // wc binary not available (e.g. Windows minimal containers) — skip line counts
      // for this batch so the file-list fallback is still emitted.
      continue;
    }
    // Parse stdout regardless of exit code: GNU wc emits counts for successfully
    // read files even when it exits nonzero (e.g. a submodule directory in the
    // batch causes failure but the other files' counts are still valid).
    for (const [path, count] of parseWcOutput(wcStdout, batchSet)) {
      lineCounts.set(path, count);
    }
  }

  const entries: FileEntry[] = files.map(f => ({
    path: f,
    lines: lineCounts.get(f) ?? null,
  }));

  entries.sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));

  return formatSummary(entries, budgetChars);
}
