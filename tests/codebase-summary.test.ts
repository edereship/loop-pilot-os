import { describe, it, expect } from "vitest";
import { generateCodebaseSummary } from "../src/codebase-summary.js";
import { FakeCommandRunner } from "./fakes.js";

function stubGitLsFiles(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["git", "ls-files"], { code, stdout });
}

function stubWcLines(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["wc", "-l"], { code, stdout });
}

describe("generateCodebaseSummary", () => {
  it("generates a summary with file paths and line counts", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/main.ts\nsrc/util.ts\n");
    stubWcLines(runner, "  42 src/main.ts\n  18 src/util.ts\n  60 total\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files, 60 lines total");
    expect(result).toContain("src/main.ts (42L)");
    expect(result).toContain("src/util.ts (18L)");
  });

  it("returns empty string when git ls-files fails", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "", 128);

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("returns empty string when repo has no tracked files", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "\n");
    // wc -l won't be called when there are no files

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("truncates when output exceeds budget", async () => {
    const runner = new FakeCommandRunner();
    const files = Array.from({ length: 100 }, (_, i) => `src/file${String(i).padStart(3, "0")}.ts`);
    stubGitLsFiles(runner, files.join("\n") + "\n");
    const wcLines = files.map((f, i) => `  ${i + 10} ${f}`).join("\n") + `\n  ${files.length * 50} total\n`;
    stubWcLines(runner, wcLines);

    const result = await generateCodebaseSummary("/repo", runner, 200);

    expect(result).toContain("100 files,");
    expect(result).toContain("lines total");
    expect(result).toContain("more files omitted");
    expect(result.length).toBeLessThanOrEqual(250); // some slack for the omission line
  });

  it("handles wc -l failure gracefully — falls back to file list without line counts", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/a.ts\nsrc/b.ts\n");
    stubWcLines(runner, "", 1);

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("passes repo path as cwd to git ls-files", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "a.ts\n");
    stubWcLines(runner, "  5 a.ts\n  5 total\n");

    await generateCodebaseSummary("/my/repo", runner, 5000);

    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.opts.cwd).toBe("/my/repo");
  });

  it("single file — no 'total' line from wc", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "readme.md\n");
    stubWcLines(runner, "  10 readme.md\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("1 file, 10 lines total");
    expect(result).toContain("readme.md (10L)");
  });
});
