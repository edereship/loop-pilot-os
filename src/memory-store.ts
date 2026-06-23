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

  const implPath = path.join(dir, CATEGORY_FILES.impl_results);
  const implExists = existsSync(implPath);
  // A header-only file means the first run had no sessions yet; treat it as
  // un-bootstrapped so DB sessions from a completed run can still populate it
  // on the next startup (ES-452 Finding 3).
  const implIsHeaderOnly = implExists &&
    readFileSync(implPath, "utf-8") === CATEGORY_HEADERS.impl_results;
  const implNeedsBootstrap = !implExists || implIsHeaderOnly;

  for (const cat of Object.keys(CATEGORY_FILES) as MemoryCategory[]) {
    const filePath = path.join(dir, CATEGORY_FILES[cat]);
    if (existsSync(filePath) && !(cat === "impl_results" && implIsHeaderOnly)) continue;
    if (cat === "impl_results" && implNeedsBootstrap) {
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
    if (!existsSync(filePath)) {
      writeFileSync(filePath, CATEGORY_HEADERS[cat], "utf-8");
    }
  }
}

export async function commitIfChanged(
  runner: CommandRunner,
  repoPath: string,
): Promise<boolean> {
  const add = await runner.run("git", ["add", MEMORY_DIR + "/"], { cwd: repoPath });
  if (add.code !== 0) {
    // Remove newly created untracked files so the clean-worktree preflight on the
    // next startup does not fail due to leftover bootstrap files (ES-452 Finding 1).
    await runner.run("git", ["clean", "-fd", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
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
    // Unstage changes so the index stays clean.
    await runner.run("git", ["reset", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
    // Restore tracked files to HEAD and remove newly created untracked files so the
    // working tree stays clean and the next startup's clean-worktree preflight does
    // not fail (ES-452 Finding 4). Both steps are best-effort.
    await runner.run("git", ["checkout", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
    await runner.run("git", ["clean", "-fd", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
    throw new Error(`git commit failed (code ${commit.code}): ${commit.stderr}`);
  }
  return true;
}
