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
  mkdirSync(path.join(repoPath, MEMORY_DIR), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

export function readAll(repoPath: string): {
  pmDecisions: string | null;
  implResults: string | null;
  productKnowledge: string | null;
  readErrors?: string[];
} {
  const readErrors: string[] = [];
  const get = (cat: MemoryCategory): string | null => {
    try {
      const content = readCategory(repoPath, cat);
      if (content === null) return null;
      // Treat only the known seeded header as "empty". Any other content — including
      // heading-only markdown like "# Decision\n## Prefer X" — is real memory that
      // GROOM wrote and should be injected into prompts.
      // Normalize CRLF and missing trailing newline before comparing so files checked
      // out with core.autocrlf or saved without a final newline still match.
      const normalized = content.replace(/\r\n?/g, "\n").trimEnd() + "\n";
      if (normalized === CATEGORY_HEADERS[cat]) return null;
      return content;
    } catch (err) {
      readErrors.push(err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  return {
    pmDecisions: get("pm_decisions"),
    implResults: get("impl_results"),
    productKnowledge: get("product_knowledge"),
    ...(readErrors.length > 0 && { readErrors }),
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
  message = "chore: persist cross-task memory on halt",
): Promise<boolean> {
  const add = await runner.run("git", ["add", "-f", MEMORY_DIR + "/"], { cwd: repoPath });
  if (add.code !== 0) {
    // Restore tracked files to HEAD so the clean-worktree preflight on the next
    // startup does not fail due to dirty memory files (ES-452 Finding 1).
    await runner.run("git", ["checkout", "HEAD", "--", MEMORY_DIR + "/"], { cwd: repoPath }).catch(() => {});
    // Remove any newly created untracked files (e.g. leftover bootstrap files).
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
    ["commit", "-m", message, "--", MEMORY_DIR + "/"],
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
