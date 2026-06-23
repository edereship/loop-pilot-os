export interface MemoryEntry {
  label: string;
  content: string;
}

const MARKER = "\n[...省略...]";
const MAIN_HEADER = "# 横断メモリ";

export function buildMemoryBlock(
  entries: MemoryEntry[],
  budgetChars: number,
): string {
  const active = entries.filter((e) => e.content.length > 0);
  if (active.length === 0) return "";

  // Compute structural overhead assuming all entries are truncated, so the
  // final block never exceeds budgetChars.
  // Assembly: MAIN_HEADER + "\n\n" + "" + "\n\n" + parts.join("\n\n")
  // Each part: "## label\n\n" + content [+ MARKER if truncated]
  const mainHeaderLen = MAIN_HEADER.length + 4; // 4 = "\n\n" (empty element) + "\n\n"
  const separatorLen = (active.length - 1) * 2; // "\n\n" between parts
  const entryHeadersLen = active.reduce((s, e) => s + 3 + e.label.length + 2, 0); // "## " + label + "\n\n"
  const markersLen = active.length * MARKER.length;
  const overhead = mainHeaderLen + separatorLen + entryHeadersLen + markersLen;

  const contentBudget = Math.max(0, budgetChars - overhead);
  const perCategory = Math.floor(contentBudget / active.length);

  const parts = active.map((e) => {
    const truncated =
      e.content.length > perCategory
        ? e.content.slice(0, perCategory) + MARKER
        : e.content;
    return [`## ${e.label}`, "", truncated].join("\n");
  });

  return [MAIN_HEADER, "", ...parts].join("\n\n");
}
