import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SpecContent } from "./types.js";

export function loadSpecContent(repoPath: string, specDir: string): SpecContent {
  const dir = path.resolve(repoPath, specDir);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `Failed to read spec directory "${dir}" (product.spec_dir = "${specDir}"): ${(err as Error).message}`,
    );
  }

  const requirementsPath = path.join(dir, "requirements.md");
  let requirements: string;
  try {
    requirements = readFileSync(requirementsPath, "utf-8");
  } catch (err) {
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
    const filePath = path.join(dir, f);
    try {
      return {
        name: f.replace(/\.md$/, ""),
        content: readFileSync(filePath, "utf-8"),
      };
    } catch (err) {
      throw new Error(
        `Failed to read domain spec "${filePath}": ${(err as Error).message}`,
      );
    }
  });

  return { requirements, domainSpecs };
}
