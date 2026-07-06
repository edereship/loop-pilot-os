import { describe, it, expect } from "vitest";
import {
  parseNameStatusZ,
  isTestFile,
  isConfigFile,
  isWorkflowFile,
} from "../src/breaking-signals.js";

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
