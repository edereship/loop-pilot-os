import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { MemoryCategory, CommandRunner } from "./types.js";
import type { SqliteStore } from "./store.js";

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

const CATEGORY_HEADERS: Record<MemoryCategory, string> = {
  pm_decisions: "# PM Decisions\n",
  impl_results: "# Implementation Results\n",
  product_knowledge: "# Product Knowledge\n",
};

export function initialize(
  repoPath: string,
  store: SqliteStore,
  recentCount: number,
): void {
  const dir = path.join(repoPath, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });

  const implAlreadyExists = existsSync(
    path.join(dir, CATEGORY_FILES.impl_results),
  );

  for (const cat of Object.keys(CATEGORY_FILES) as MemoryCategory[]) {
    const filePath = path.join(dir, CATEGORY_FILES[cat]);
    if (existsSync(filePath)) continue;
    if (cat === "impl_results" && !implAlreadyExists) {
      const sessions = store.recentSessionSummaries(recentCount);
      if (sessions.length > 0) {
        const lines = sessions.map((s) => {
          const cost = s.costUsd !== null ? `$${s.costUsd.toFixed(2)}` : "n/a";
          return `- ${s.linearIdentifier}: ${s.issueTitle} — ${s.state} (${cost})`;
        });
        writeFileSync(filePath, `# Implementation Results\n\n${lines.join("\n")}\n`, "utf-8");
        continue;
      }
    }
    writeFileSync(filePath, CATEGORY_HEADERS[cat], "utf-8");
  }
}

export async function commitIfChanged(
  runner: CommandRunner,
  repoPath: string,
): Promise<boolean> {
  const add = await runner.run("git", ["add", MEMORY_DIR + "/"], { cwd: repoPath });
  if (add.code !== 0) {
    throw new Error(`git add failed (code ${add.code}): ${add.stderr}`);
  }
  const diff = await runner.run(
    "git",
    ["diff", "--cached", "--quiet", "--", MEMORY_DIR + "/"],
    { cwd: repoPath },
  );
  if (diff.code === 0) return false;

  const commit = await runner.run(
    "git",
    ["commit", "-m", "chore: persist cross-task memory on halt", "--", MEMORY_DIR + "/"],
    { cwd: repoPath },
  );
  if (commit.code !== 0) {
    throw new Error(`git commit failed (code ${commit.code}): ${commit.stderr}`);
  }
  return true;
}
