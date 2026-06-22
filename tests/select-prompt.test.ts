import { describe, it, expect } from "vitest";
import { parseSelection, buildSelectPrompt, computeDiffStat, formatDiffContext } from "../src/select-prompt.js";
import type { SelectPromptArgs, PrDiffSummary } from "../src/types.js";

describe("parseSelection", () => {
  it("extracts identifier and rationale from a valid JSON block", () => {
    const output = 'Some reasoning text\n```json\n{"identifier":"TY-5","rationale":"Continues auth work"}\n```\n';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-5", rationale: "Continues auth work" });
  });

  it("uses the LAST json block when multiple are present", () => {
    const output = [
      '```json\n{"identifier":"TY-1","rationale":"first"}\n```',
      "More reasoning...",
      '```json\n{"identifier":"TY-9","rationale":"final pick"}\n```',
    ].join("\n");
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-9", rationale: "final pick" });
  });

  it("returns null for empty output", () => {
    expect(parseSelection("")).toBeNull();
  });

  it("returns null when no json block is present", () => {
    expect(parseSelection("Just some text without JSON")).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parseSelection('```json\n{bad json}\n```')).toBeNull();
  });

  it("returns null when identifier is missing", () => {
    expect(parseSelection('```json\n{"rationale":"no id"}\n```')).toBeNull();
  });

  it("returns null when identifier is not a string", () => {
    expect(parseSelection('```json\n{"identifier":123,"rationale":"num"}\n```')).toBeNull();
  });

  it("handles json block without backtick fence (raw JSON line)", () => {
    const output = 'Analysis...\n{"identifier":"TY-3","rationale":"best next"}\n';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-3", rationale: "best next" });
  });

  it("trims whitespace from identifier", () => {
    const output = '```json\n{"identifier":" TY-7 ","rationale":"trimmed"}\n```';
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-7", rationale: "trimmed" });
  });

  it("handles multi-line unfenced JSON object", () => {
    const output = [
      "Some analysis here.",
      "{",
      '  "identifier": "TY-5",',
      '  "rationale": "Best next pick"',
      "}",
    ].join("\n");
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-5", rationale: "Best next pick" });
  });

  it("prefers the last fenced block over an unfenced multi-line JSON", () => {
    const output = [
      "{",
      '  "identifier": "TY-1",',
      '  "rationale": "unfenced"',
      "}",
      "More reasoning...",
      '```json',
      '{"identifier":"TY-9","rationale":"fenced wins"}',
      "```",
    ].join("\n");
    const result = parseSelection(output);
    expect(result).toEqual({ identifier: "TY-9", rationale: "fenced wins" });
  });
});

describe("computeDiffStat", () => {
  it("computes per-file insertions and deletions", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "-removed",
      "+added1",
      "+added2",
    ].join("\n");
    const stat = computeDiffStat(diff);
    expect(stat).toContain("src/foo.ts");
    expect(stat).toContain("2 insertion");
    expect(stat).toContain("1 deletion");
  });

  it("handles multiple files", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      " x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,2 +1 @@",
      " x",
      "-y",
    ].join("\n");
    const stat = computeDiffStat(diff);
    expect(stat).toContain("a.ts");
    expect(stat).toContain("b.ts");
    expect(stat).toContain("2 files changed");
  });

  it("returns empty string for empty diff", () => {
    expect(computeDiffStat("")).toBe("");
  });
});

describe("formatDiffContext", () => {
  const baseDiff: PrDiffSummary = {
    title: "TY-3: Refactor auth",
    body: "Refactored the auth module.",
    diff: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added",
      "-removed",
    ].join("\n"),
  };

  it("includes PR title, body, stat, and full diff when under budget", () => {
    const result = formatDiffContext("TY-3", baseDiff, 10000);
    expect(result).toContain("TY-3: Refactor auth");
    expect(result).toContain("Refactored the auth module.");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("diff --git");
  });

  it("truncates full diff when over budget, keeps stat", () => {
    const longDiff = "diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n" +
      Array.from({ length: 500 }, (_, i) => `+line${i}`).join("\n");
    const summary: PrDiffSummary = { title: "Big PR", body: "lots of changes", diff: longDiff };
    const result = formatDiffContext("TY-4", summary, 200);
    expect(result).toContain("Big PR");
    expect(result).toContain("big.ts");
    expect(result).toContain("(truncated)");
    expect(result.length).toBeLessThan(longDiff.length);
  });

  it("omits full diff section entirely when stat alone exceeds budget", () => {
    const summary: PrDiffSummary = { title: "T", body: "B", diff: "diff --git a/x.ts b/x.ts\n+a" };
    const result = formatDiffContext("TY-5", summary, 5);
    expect(result).toContain("T");
    // At minimum, title and body are always included
  });
});

describe("buildSelectPrompt", () => {
  const baseArgs: SelectPromptArgs = {
    goal: null,
    specContent: null,
    eligible: [
      { id: "a", identifier: "TY-1", title: "Add auth", description: "Auth feature", priority: 1, sortOrder: 100, url: "u1" },
      { id: "b", identifier: "TY-2", title: "Fix bug", description: "Bug fix", priority: 2, sortOrder: 200, url: "u2" },
    ],
    inProgress: [],
    recentMerged: [],
    lastPrDiff: null,
    diffBudgetChars: 6000,
    codebaseSummary: null,
  };

  it("includes system instruction and eligible candidates", () => {
    const prompt = buildSelectPrompt(baseArgs);
    expect(prompt).toContain("TY-1");
    expect(prompt).toContain("TY-2");
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain('"identifier"');
    expect(prompt).toContain('"rationale"');
  });

  it("includes spec content when provided", () => {
    const args = {
      ...baseArgs,
      specContent: {
        requirements: "Build a great product",
        domainSpecs: [{ name: "auth", content: "Auth spec here" }],
      },
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("Build a great product");
    expect(prompt).toContain("Auth spec here");
  });

  it("includes in-progress and recently merged context", () => {
    const args = {
      ...baseArgs,
      inProgress: [{ linearIdentifier: "TY-5", issueTitle: "Ongoing work" }],
      recentMerged: [{ linearIdentifier: "TY-3", issueTitle: "Done task", agentSummary: "Completed the thing" }],
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("TY-5");
    expect(prompt).toContain("Ongoing work");
    expect(prompt).toContain("TY-3");
    expect(prompt).toContain("Done task");
  });

  it("includes last PR diff when provided", () => {
    const args = {
      ...baseArgs,
      lastPrDiff: {
        identifier: "TY-3",
        summary: { title: "TY-3: Done", body: "Did stuff", diff: "diff --git a/x.ts b/x.ts\n+line" },
      },
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("TY-3: Done");
    expect(prompt).toContain("Did stuff");
  });

  it("is deterministic — same inputs produce same output", () => {
    const p1 = buildSelectPrompt(baseArgs);
    const p2 = buildSelectPrompt(baseArgs);
    expect(p1).toBe(p2);
  });

  it("includes issue descriptions in eligible section", () => {
    const prompt = buildSelectPrompt(baseArgs);
    expect(prompt).toContain("Auth feature");
    expect(prompt).toContain("Bug fix");
  });

  it("includes codebase summary when provided", () => {
    const args: SelectPromptArgs = {
      ...baseArgs,
      codebaseSummary: "3 files, 500 lines total\n\nsrc/main.ts (200L)\nsrc/util.ts (180L)\nsrc/config.ts (120L)",
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("# Codebase Structure");
    expect(prompt).toContain("3 files, 500 lines total");
    expect(prompt).toContain("src/main.ts (200L)");
  });

  it("omits codebase summary section when null", () => {
    const args: SelectPromptArgs = {
      ...baseArgs,
      codebaseSummary: null,
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).not.toContain("Codebase Structure");
  });
});
