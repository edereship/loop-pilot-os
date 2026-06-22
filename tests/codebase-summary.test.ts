import { describe, it, expect } from "vitest";
import { generateCodebaseSummary } from "../src/codebase-summary.js";
import { FakeCommandRunner } from "./fakes.js";

// Produce NUL-delimited git ls-files -sz stage records for a list of regular files.
function makeGitLsOutput(filePaths: string[]): string {
  if (filePaths.length === 0) return "";
  return filePaths.map(f => `100644 0000000000000000000000000000000000000000 0\t${f}`).join("\0") + "\0";
}

function stubGitLsFiles(runner: FakeCommandRunner, filePaths: string[], code = 0): void {
  runner.on(["git", "-c", "core.quotePath=false", "ls-files"], { code, stdout: makeGitLsOutput(filePaths) });
}

function stubWcLines(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["wc", "-l"], { code, stdout });
}

describe("generateCodebaseSummary", () => {
  it("generates a summary with file paths and line counts sorted by line count descending", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, ["src/main.ts", "src/util.ts"]);
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
    stubGitLsFiles(runner, [], 128);

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("returns empty string when repo has no tracked files", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, []);

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("truncates when output exceeds budget and stays within budget", async () => {
    const runner = new FakeCommandRunner();
    const files = Array.from({ length: 100 }, (_, i) => `src/file${String(i).padStart(3, "0")}.ts`);
    stubGitLsFiles(runner, files);
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
    stubGitLsFiles(runner, ["src/a.ts", "src/b.ts"]);
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
    stubGitLsFiles(runner, ["a.ts"]);
    stubWcLines(runner, "  5 a.ts\n  5 total\n");

    await generateCodebaseSummary("/my/repo", runner, 5000);

    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.opts.cwd).toBe("/my/repo");
    const wcCall = runner.calls.find(c => c.cmd === "wc");
    expect(wcCall?.opts.cwd).toBe("/my/repo");
  });

  it("single file — no 'total' line from wc", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, ["readme.md"]);
    stubWcLines(runner, "  10 readme.md\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("1 file, 10 lines total");
    expect(result).toContain("readme.md (10L)");
  });

  it("filters wc 'total' summary line without excluding a file named 'total'", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, ["total", "src/app.ts"]);
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
    stubGitLsFiles(runner, ["src/テスト.ts"]);
    stubWcLines(runner, "  20 src/テスト.ts\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("src/テスト.ts (20L)");
    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.args).toContain("core.quotePath=false");
  });

  // Finding 1: symlink entries must not be passed to wc to avoid blocking on device/pipe targets
  it("skips symlinks during line counting to avoid blocking on device/pipe targets", async () => {
    const runner = new FakeCommandRunner();
    // Register a symlink (120000) alongside a regular file (100644)
    runner.on(
      ["git", "-c", "core.quotePath=false", "ls-files"],
      {
        code: 0,
        stdout: "120000 0000000000000000000000000000000000000000 0\tlink-to-dev\0" +
                "100644 0000000000000000000000000000000000000000 0\tsrc/real.ts\0",
      },
    );
    stubWcLines(runner, "  15 src/real.ts\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    // The symlink must not appear in the wc args
    const wcCall = runner.calls.find(c => c.cmd === "wc");
    expect(wcCall?.args).not.toContain("link-to-dev");

    // The regular file still appears with its line count
    expect(result).toContain("src/real.ts (15L)");
    // The symlink is excluded from the summary
    expect(result).not.toContain("link-to-dev");
  });

  // Finding 2: wc spawn failure must not suppress the summary entirely
  it("falls back to file list without line counts when wc spawn fails (command not found)", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, ["src/a.ts", "src/b.ts"]);
    // No wc stub registered — FakeCommandRunner rejects, simulating spawn failure

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files");
    expect(result).not.toContain("lines total");
    expect(result).not.toMatch(/\(\d+L\)/);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  // Finding 3: NUL-delimited git output handles filenames with spaces
  it("handles filenames with spaces correctly via NUL-delimited git output", async () => {
    const runner = new FakeCommandRunner();
    runner.on(
      ["git", "-c", "core.quotePath=false", "ls-files"],
      {
        code: 0,
        stdout: "100644 0000000000000000000000000000000000000000 0\tsrc/file with spaces.ts\0",
      },
    );
    stubWcLines(runner, "  8 src/file with spaces.ts\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("src/file with spaces.ts (8L)");
  });

  // Finding 4: partial wc output on nonzero exit must not discard valid counts
  it("uses partial wc output when one path in the batch causes a nonzero exit", async () => {
    const runner = new FakeCommandRunner();
    // submodule dir causes wc to exit nonzero, but a.ts and b.ts still get counted
    stubGitLsFiles(runner, ["src/a.ts", "sub/module", "src/b.ts"]);
    stubWcLines(runner, "  10 src/a.ts\n  20 src/b.ts\n", 1);

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("3 files");
    expect(result).toContain("src/a.ts (10L)");
    expect(result).toContain("src/b.ts (20L)");
    // The entry that caused the failure appears without a line count
    expect(result).toContain("sub/module");
    expect(result).not.toMatch(/sub\/module \(\d+L\)/);
  });
});
