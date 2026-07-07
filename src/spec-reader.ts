import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { SpecContent, CommandRunner, SpecFile } from "./types.js";

function assertInsideRepo(realPath: string, repoReal: string, label: string): void {
  if (realPath !== repoReal && !realPath.startsWith(repoReal + path.sep)) {
    throw new Error(`${label} resolves outside the repository (symlink escape)`);
  }
}

export function loadSpecContent(repoPath: string, specDir: string): SpecContent {
  if (path.isAbsolute(specDir)) {
    throw new Error(
      `product.spec_dir must be a relative path, got "${specDir}"`,
    );
  }
  const repoReal = realpathSync(path.resolve(repoPath));
  const dirLogical = path.resolve(repoReal, specDir);
  if (dirLogical !== repoReal && !dirLogical.startsWith(repoReal + path.sep)) {
    throw new Error(
      `product.spec_dir "${specDir}" resolves outside the repository at "${repoPath}"`,
    );
  }

  let dirReal: string;
  try {
    dirReal = realpathSync(dirLogical);
  } catch (err) {
    throw new Error(
      `Failed to read spec directory "${dirLogical}" (product.spec_dir = "${specDir}"): ${(err as Error).message}`,
    );
  }
  assertInsideRepo(dirReal, repoReal, `product.spec_dir "${specDir}"`);

  let entries: string[];
  try {
    entries = readdirSync(dirReal);
  } catch (err) {
    throw new Error(
      `Failed to read spec directory "${dirReal}" (product.spec_dir = "${specDir}"): ${(err as Error).message}`,
    );
  }

  const requirementsPath = path.join(dirReal, "requirements.md");
  let requirements: string;
  try {
    const requirementsReal = realpathSync(requirementsPath);
    assertInsideRepo(requirementsReal, repoReal, `requirements.md`);
    requirements = readFileSync(requirementsReal, "utf-8");
  } catch (err) {
    if (err instanceof Error && err.message.includes("symlink escape")) throw err;
    throw new Error(
      `Failed to read "${requirementsPath}": ${(err as Error).message}. ` +
      `When product.spec_dir is set, requirements.md is mandatory.`,
    );
  }

  if (requirements.trim().length === 0) {
    throw new Error(
      `requirements.md at "${requirementsPath}" is empty. ` +
      `When product.spec_dir is set, requirements.md must contain the product requirements.`,
    );
  }

  const mdFiles = entries
    .filter((f) => f.endsWith(".md") && f !== "requirements.md" && f !== "README.md")
    .sort();

  const domainSpecs = mdFiles.map((f) => {
    const filePath = path.join(dirReal, f);
    let fileReal: string;
    try {
      fileReal = realpathSync(filePath);
    } catch (err) {
      throw new Error(
        `Failed to read domain spec "${filePath}": ${(err as Error).message}`,
      );
    }
    assertInsideRepo(fileReal, repoReal, `domain spec "${f}"`);
    try {
      return {
        name: f.replace(/\.md$/, ""),
        content: readFileSync(fileReal, "utf-8"),
      };
    } catch (err) {
      throw new Error(
        `Failed to read domain spec "${filePath}": ${(err as Error).message}`,
      );
    }
  });

  return { requirements, domainSpecs };
}

/**
 * ES-521: SpecContent を working tree ではなく指定 SHA（handoff_head_sha）の git object から読む。
 * マージゲートの原仕様グラウンディング用 — LoopPilot のドリフトコミットが docs/specs を
 * 書き換えていても、handoff 時点の trusted な仕様で判定できる。
 * best-effort: git 失敗・requirements.md 不在は null（呼び出し側が spec なしで判定続行）。
 * specDir は loadSpecContent と同じく repo 相対パス前提（ref 読みなので symlink escape は生じない）。
 */
export async function loadSpecContentAtRef(
  worktreePath: string,
  specDir: string,
  sha: string,
  runner: CommandRunner,
): Promise<SpecContent | null> {
  const dir = specDir.replace(/\/+$/, "");
  let fileList: string[];
  try {
    const res = await runner.run(
      "git", ["-C", worktreePath, "ls-tree", "-r", "--name-only", sha, "--", dir],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    if (res.code !== 0) return null;
    fileList = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  } catch {
    return null;
  }
  const mdFiles = fileList.filter((p) => p.endsWith(".md"));
  const requirementsPath = `${dir}/requirements.md`;
  if (!mdFiles.includes(requirementsPath)) return null;

  const show = async (p: string): Promise<string | null> => {
    try {
      const res = await runner.run(
        "git", ["-C", worktreePath, "show", `${sha}:${p}`],
        { cwd: worktreePath, timeoutMs: 30_000 },
      );
      return res.code === 0 ? res.stdout : null;
    } catch {
      return null;
    }
  };

  const requirements = await show(requirementsPath);
  if (requirements === null) return null;

  const domainSpecs: SpecFile[] = [];
  const domainPaths = mdFiles.filter((p) => p !== requirementsPath).sort();
  for (const p of domainPaths) {
    const content = await show(p);
    if (content === null) return null;
    domainSpecs.push({ name: path.basename(p, ".md"), content });
  }
  return { requirements, domainSpecs };
}
