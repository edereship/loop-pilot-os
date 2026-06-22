import { describe, it, expect } from "vitest";
import { generateCodebaseSummary } from "../src/codebase-summary.js";
import { FakeCommandRunner } from "./fakes.js";

function stubGitLsFiles(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["git", "-c", "core.quotePath=false", "ls-files"], { code, stdout });
}

function stubWcLines(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["wc", "-l"], { code, stdout });
}

describe("generateCodebaseSummary", () => {
  it("generates a summary with file paths and line counts sorted by line count descending", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/main.ts\nsrc/util.ts\n");
    stubWcLines(runner, "  42 src/main.ts\n  18 src/util.ts\n  60 total\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files, 60 lines total");
    expect(result).toContain("src/main.ts (42L)");
    expect(result).toContain("src/util.ts (18L)");
    const mainIdx = result.indexOf("src/main.ts");
    const utilIdx = result.indexOf("src/util.ts");
    expect(mainIdx).toBeLessThan(utilIdx);
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

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("truncates when output exceeds budget and stays within budget", async () => {
    const runner = new FakeCommandRunner();
    const files = Array.from({ length: 100 }, (_, i) => `src/file${String(i).padStart(3, "0")}.ts`);
    stubGitLsFiles(runner, files.join("\n") + "\n");
    const wcLines = files.map((f, i) => `  ${i + 10} ${f}`).join("\n") + `\n  ${files.length * 50} total\n`;
    stubWcLines(runner, wcLines);

    const result = await generateCodebaseSummary("/repo", runner, 500);

    expect(result).toContain("100 files,");
    expect(result).toContain("lines total");
    expect(result).toContain("more files omitted");
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("handles wc -l failure gracefully — falls back to file list without line counts", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/a.ts\nsrc/b.ts\n");
    stubWcLines(runner, "", 1);

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files");
    expect(result).not.toContain("lines total");
    expect(result).not.toMatch(/\(\d+L\)/);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("passes repo path as cwd to both git ls-files and wc", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "a.ts\n");
    stubWcLines(runner, "  5 a.ts\n  5 total\n");

    await generateCodebaseSummary("/my/repo", runner, 5000);

    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.opts.cwd).toBe("/my/repo");
    const wcCall = runner.calls.find(c => c.cmd === "wc");
    expect(wcCall?.opts.cwd).toBe("/my/repo");
  });

  it("single file — no 'total' line from wc", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "readme.md\n");
    stubWcLines(runner, "  10 readme.md\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("1 file, 10 lines total");
    expect(result).toContain("readme.md (10L)");
  });

  it("filters wc 'total' summary line without excluding a file named 'total'", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "total\nsrc/app.ts\n");
    // wc outputs: file "total" (50 lines), file "src/app.ts" (30 lines), summary "total" (80)
    // parseWcOutput keeps first occurrence per path, so file "total" gets 50 (not the summary 80)
    stubWcLines(runner, "  50 total\n  30 src/app.ts\n  80 total\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("total (50L)");
    expect(result).toContain("src/app.ts (30L)");
    expect(result).toContain("2 files, 80 lines total");
  });

  it("uses core.quotePath=false to get unquoted paths", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/テスト.ts\n");
    stubWcLines(runner, "  20 src/テスト.ts\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("src/テスト.ts (20L)");
    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.args).toContain("core.quotePath=false");
  });
});
