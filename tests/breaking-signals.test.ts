import { describe, it, expect } from "vitest";
import {
  parseNameStatusZ,
  isTestFile,
  isConfigFile,
  isWorkflowFile,
  extractBreakingSignals,
  extractExportLines,
} from "../src/breaking-signals.js";
import { FakeCommandRunner } from "./fakes.js";

function stubNameStatus(runner: FakeCommandRunner, stdout: string): void {
  runner.on(["git", "diff", "--name-status"], { code: 0, stdout });
}
function stubNotTsRepo(runner: FakeCommandRunner): void {
  runner.on(["git", "cat-file", "-e"], { code: 1 });
}
function stubTsRepo(runner: FakeCommandRunner): void {
  runner.on(["git", "cat-file", "-e"], { code: 0 });
}

describe("parseNameStatusZ", () => {
  it("parses NUL-delimited status/path pairs", () => {
    // git diff --name-status -z --no-renames の出力形式: STATUS\0path\0STATUS\0path\0
    const stdout = "D\0src/old.ts\0M\0src/kept.ts\0A\0src/new.ts\0";
    expect(parseNameStatusZ(stdout)).toEqual([
      { status: "D", path: "src/old.ts" },
      { status: "M", path: "src/kept.ts" },
      { status: "A", path: "src/new.ts" },
    ]);
  });

  it("returns empty array for empty stdout", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("ignores a trailing incomplete record", () => {
    expect(parseNameStatusZ("D\0src/a.ts\0M\0")).toEqual([
      { status: "D", path: "src/a.ts" },
    ]);
  });
});

describe("isTestFile", () => {
  it.each([
    "tests/store.test.ts",
    "src/__tests__/foo.ts",
    "test/helper.js",
    "src/foo.test.ts",
    "src/foo.spec.tsx",
    "src/foo.test.mjs",
  ])("detects '%s' as test file", (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it.each(["src/store.ts", "src/testing-utils.ts", "docs/tests.md", "contest/entry.ts"])(
    "does not flag '%s'",
    (p) => {
      expect(isTestFile(p)).toBe(false);
    },
  );
});

describe("isConfigFile", () => {
  it.each([
    "vitest.config.ts",
    "packages/app/eslint.config.js",
    "schema.sql",
    "prisma/schema.prisma",
    ".env.example",
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])("detects '%s' as config file", (p) => {
    expect(isConfigFile(p)).toBe(true);
  });

  it.each(["src/config.ts", "docs/schema-notes.md", "package-lock.json"])(
    "does not flag '%s'",
    (p) => {
      expect(isConfigFile(p)).toBe(false);
    },
  );
});

describe("isWorkflowFile", () => {
  it("detects .github/workflows/ files", () => {
    expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowFile(".github/dependabot.yml")).toBe(false);
    expect(isWorkflowFile("src/workflows/x.ts")).toBe(false);
  });
});

describe("extractBreakingSignals: deleted/config/workflow (ES-515 Task 2)", () => {
  it("classifies deleted files, config changes and workflow changes", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(
      runner,
      "D\0src/api.ts\0D\0tests/api.test.ts\0M\0vitest.config.ts\0M\0.github/workflows/ci.yml\0A\0src/new.ts\0",
    );
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.deletedFiles).toEqual(["src/api.ts", "tests/api.test.ts"]);
    expect(signals.deletedTestFiles).toEqual(["tests/api.test.ts"]);
    expect(signals.changedConfigFiles).toEqual(["vitest.config.ts"]);
    expect(signals.changedWorkflowFiles).toEqual([".github/workflows/ci.yml"]);
    expect(signals.removedExports).toBeNull();
    expect(signals.errors).toEqual([]);
  });

  it("passes base..head range and --no-renames to git diff", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "");
    stubNotTsRepo(runner);
    await extractBreakingSignals("/repo", runner, "base123", "head456");
    const diffCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "diff");
    expect(diffCall).toBeDefined();
    expect(diffCall!.args).toEqual([
      "diff", "--name-status", "-z", "--no-renames", "base123", "head456",
    ]);
    expect(diffCall!.opts.cwd).toBe("/repo");
  });

  it("records an error and returns empty signals when git diff fails (fail-open)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "diff", "--name-status"], { code: 128, stderr: "bad revision" });
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.deletedFiles).toEqual([]);
    expect(signals.errors.length).toBe(1);
    expect(signals.errors[0]).toContain("name-status");
  });
});

describe("extractBreakingSignals: shrunken test files (ES-515 Task 3)", () => {
  it("flags a modified test file that lost >=30% of its lines", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/store.test.ts\0M\0src/store.ts\0");
    stubNotTsRepo(runner);
    // git show <sha>:<path> で before/after の中身を返す
    runner.on(["git", "show", "base123:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
    });
    runner.on(["git", "show", "head456:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n"),
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([
      { path: "tests/store.test.ts", linesBefore: 100, linesAfter: 60, reductionRatio: 0.4 },
    ]);
  });

  it("does not flag a test file below the 30% threshold", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/store.test.ts\0");
    stubNotTsRepo(runner);
    runner.on(["git", "show", "base123:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
    });
    runner.on(["git", "show", "head456:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n"),
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([]);
  });

  it("records an error but continues when git show fails for one file", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/a.test.ts\0D\0src/gone.ts\0");
    stubNotTsRepo(runner);
    runner.on(["git", "show", "base123:tests/a.test.ts"], { code: 128, stderr: "not found" });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([]);
    expect(signals.deletedFiles).toEqual(["src/gone.ts"]); // 他セクションは生きている
    expect(signals.errors.length).toBe(1);
  });
});

describe("extractExportLines", () => {
  it("collects normalized export declaration lines", () => {
    const src = [
      "import x from './x.js';",
      "export function foo(a: number): string {",
      "  return String(a);",
      "}",
      "export   const  BAR = 1;",
      "const internal = 2;",
      "export type Baz = { a: number };",
    ].join("\n");
    expect([...extractExportLines(src)]).toEqual([
      "export function foo(a: number): string {",
      "export const BAR = 1;",
      "export type Baz = { a: number };",
    ]);
  });
});

describe("extractBreakingSignals: removed exports (ES-515 Task 4)", () => {
  it("reports exports removed from a modified .ts file and all exports of a deleted .ts file", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0src/api.ts\0D\0src/gone.ts\0M\0src/style.css\0");
    stubTsRepo(runner);
    runner.on(["git", "show", "base123:src/api.ts"], {
      code: 0,
      stdout: "export function keep(): void {}\nexport function removed(): void {}\n",
    });
    runner.on(["git", "show", "head456:src/api.ts"], {
      code: 0,
      stdout: "export function keep(): void {}\n",
    });
    runner.on(["git", "show", "base123:src/gone.ts"], {
      code: 0,
      stdout: "export const GONE = 1;\n",
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.removedExports).toEqual([
      { file: "src/api.ts", exportLine: "export function removed(): void {}" },
      { file: "src/gone.ts", exportLine: "export const GONE = 1;" },
    ]);
  });

  it("skips test files and returns null for non-TS repos", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0src/api.test.ts\0");
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.removedExports).toBeNull();
  });
});
