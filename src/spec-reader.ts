import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { SpecContent } from "./types.js";

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
