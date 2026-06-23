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

  // Assembly: MAIN_HEADER + "\n\n" + "" + "\n\n" + parts.join("\n\n")
  // Each part: "## label\n\n" + content [+ MARKER if truncated]
  const mainHeaderLen = MAIN_HEADER.length + 4; // 4 = "\n\n" (empty element) + "\n\n"
  const separatorLen = (active.length - 1) * 2; // "\n\n" between parts
  const entryHeadersLen = active.reduce((s, e) => s + 3 + e.label.length + 2, 0); // "## " + label + "\n\n"
  const overheadWithoutMarkers = mainHeaderLen + separatorLen + entryHeadersLen;

  const totalContentLen = active.reduce((s, e) => s + e.content.length, 0);

  // If the complete untruncated block fits within the budget, return it as-is.
  // This prevents per-category caps from truncating valid content when one category
  // is short and another is long but the total still fits.
  if (overheadWithoutMarkers + totalContentLen <= budgetChars) {
    const parts = active.map((e) => [`## ${e.label}`, "", e.content].join("\n"));
    return [MAIN_HEADER, "", ...parts].join("\n\n");
  }

  // Need to truncate. Compute content budget accounting for ALL markers (worst case),
  // so the final block never exceeds budgetChars.
  const markersLen = active.length * MARKER.length;
  const overhead = overheadWithoutMarkers + markersLen;
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
