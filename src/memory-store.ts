import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MemoryCategory } from "./types.js";

export const MEMORY_DIR = "docs/memory";

export const CATEGORY_FILES: Record<MemoryCategory, string> = {
  pm_decisions: "pm-decisions.md",
  impl_results: "impl-results.md",
  product_knowledge: "product-knowledge.md",
};

export function readCategory(
  repoPath: string,
  category: MemoryCategory,
): string | null {
  const filePath = path.join(repoPath, MEMORY_DIR, CATEGORY_FILES[category]);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function writeCategory(
  repoPath: string,
  category: MemoryCategory,
  content: string,
  maxChars: number,
): void {
  if (content.length > maxChars) {
    throw new Error(
      `Memory content for ${category} (${content.length} chars) exceeds limit of ${maxChars}`,
    );
  }
  const filePath = path.join(repoPath, MEMORY_DIR, CATEGORY_FILES[category]);
  writeFileSync(filePath, content, "utf-8");
}

export function readAll(repoPath: string): {
  pmDecisions: string | null;
  implResults: string | null;
  productKnowledge: string | null;
} {
  return {
    pmDecisions: readCategory(repoPath, "pm_decisions"),
    implResults: readCategory(repoPath, "impl_results"),
    productKnowledge: readCategory(repoPath, "product_knowledge"),
  };
}
