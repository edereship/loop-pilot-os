export interface MemoryEntry {
  label: string;
  content: string;
}

export function buildMemoryBlock(
  entries: MemoryEntry[],
  budgetChars: number,
): string {
  const active = entries.filter((e) => e.content.length > 0);
  if (active.length === 0) return "";

  const perCategory = Math.floor(budgetChars / active.length);

  const parts = active.map((e) => {
    const truncated =
      e.content.length > perCategory
        ? e.content.slice(0, perCategory) + "\n[...省略...]"
        : e.content;
    return [`## ${e.label}`, "", truncated].join("\n");
  });

  return ["# 横断メモリ", "", ...parts].join("\n\n");
}
