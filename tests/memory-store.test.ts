import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readCategory,
  writeCategory,
  readAll,
  MEMORY_DIR,
  CATEGORY_FILES,
} from "../src/memory-store.js";

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), "mem-test-"));
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("readCategory", () => {
  it("returns null when file does not exist", () => {
    expect(readCategory(tmpRepo, "pm_decisions")).toBeNull();
  });

  it("reads existing file content", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "# PM Decisions\n\nSome content");
    expect(readCategory(tmpRepo, "pm_decisions")).toBe("# PM Decisions\n\nSome content");
  });
});

describe("writeCategory", () => {
  it("writes content to the category file", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeCategory(tmpRepo, "impl_results", "result data", 8000);
    expect(readCategory(tmpRepo, "impl_results")).toBe("result data");
  });

  it("throws when content exceeds maxChars", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const huge = "x".repeat(101);
    expect(() => writeCategory(tmpRepo, "pm_decisions", huge, 100)).toThrow(
      /exceeds.*100/,
    );
  });

  it("allows content exactly at the limit", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const exact = "x".repeat(100);
    writeCategory(tmpRepo, "pm_decisions", exact, 100);
    expect(readCategory(tmpRepo, "pm_decisions")).toBe(exact);
  });
});

describe("readAll", () => {
  it("returns all nulls when no files exist", () => {
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: null,
      implResults: null,
      productKnowledge: null,
    });
  });

  it("reads all existing files", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "decisions");
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "results");
    writeFileSync(path.join(dir, CATEGORY_FILES.product_knowledge), "knowledge");
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: "decisions",
      implResults: "results",
      productKnowledge: "knowledge",
    });
  });
});
