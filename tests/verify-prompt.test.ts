import { describe, it, expect } from "vitest";
import { buildVerifyEvidencePrompt, buildVerifyJudgmentPrompt } from "../src/verify-prompt.js";
import type { EligibleIssue, PlanBrief, SpecContent } from "../src/types.js";

describe("buildVerifyEvidencePrompt", () => {
  const issue: EligibleIssue = {
    id: "id-1",
    identifier: "TY-1",
    title: "Add widget",
    description: "## Acceptance Criteria\n- Widget renders\n- Widget saves",
    priority: 2,
    sortOrder: 0,
    url: "https://linear.app/issue/TY-1",
  };

  const brief: PlanBrief = {
    raw: "## Goal\nAdd a widget\n\n## Implementation Steps\n1. Create widget.ts",
    sections: {
      goal: "Add a widget",
      changeTargets: "src/widget.ts",
      steps: "1. Create widget.ts",
      acceptance: "- Widget renders\n- Widget saves",
      outOfScope: "Styling",
    },
  };

  const specContent: SpecContent = {
    requirements: "The system must support widgets.",
    domainSpecs: [{ name: "ui", content: "Widgets must be accessible." }],
  };

  it("includes acceptance criteria from brief", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("Widget renders");
    expect(result).toContain("Widget saves");
  });

  it("interpolates defaultBranch into git diff command", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent: null, defaultBranch: "master" });
    expect(result).toContain("origin/master...HEAD");
    expect(result).not.toContain("origin/main");
  });

  it("includes spec content when provided", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("The system must support widgets.");
    expect(result).toContain("Widgets must be accessible.");
  });

  it("works without specContent", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent: null, defaultBranch: "main" });
    expect(result).toContain("TY-1");
    expect(result).not.toContain("Product Requirements");
  });

  it("works without brief sections (falls back to issue description)", () => {
    const noBrief: PlanBrief = { raw: "", sections: null };
    const result = buildVerifyEvidencePrompt({ issue, brief: noBrief, specContent: null, defaultBranch: "main" });
    expect(result).toContain("TY-1");
    expect(result).toContain("Add widget");
    expect(result).not.toMatch(/^# Acceptance Criteria$/m);
  });

  it("works with null brief", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief: null, specContent: null, defaultBranch: "main" });
    expect(result).toContain("TY-1");
  });

  it("instructs Claude NOT to fix code", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toMatch(/do\s+not\s+(fix|modify|change|edit)/i);
  });

  it("instructs to run build, test, type check, and lint", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent, defaultBranch: "main" });
    const lower = result.toLowerCase();
    expect(lower).toContain("build");
    expect(lower).toContain("test");
    expect(lower).toMatch(/type|tsc/);
    expect(lower).toContain("lint");
  });

  it("includes ticket identifier and title", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("TY-1");
    expect(result).toContain("Add widget");
  });

  it("shows placeholder when issue description is empty", () => {
    const emptyDescIssue: EligibleIssue = { ...issue, description: "" };
    const result = buildVerifyEvidencePrompt({
      issue: emptyDescIssue, brief, specContent: null, defaultBranch: "main",
    });
    expect(result).toContain("(no description)");
  });

  it("uses custom specDir when provided", () => {
    const result = buildVerifyEvidencePrompt({
      issue, brief, specContent, defaultBranch: "main", specDir: "custom/specs/",
    });
    expect(result).toContain("custom/specs/");
  });

  it("includes acceptance criteria assessment instruction when brief sections are null (fallback to description)", () => {
    const noBrief: PlanBrief = { raw: "", sections: null };
    const result = buildVerifyEvidencePrompt({ issue, brief: noBrief, specContent: null, defaultBranch: "main" });
    // No dedicated # Acceptance Criteria block (criteria live in the ticket description already)
    expect(result).not.toMatch(/^# Acceptance Criteria$/m);
    // But the assessment instruction must still appear so the verifier checks the ticket description
    expect(result).toContain("## Acceptance Criteria Assessment");
  });

  it("omits acceptance criteria assessment instruction when brief is null", () => {
    const result = buildVerifyEvidencePrompt({ issue, brief: null, specContent: null, defaultBranch: "main" });
    expect(result).not.toContain("## Acceptance Criteria Assessment");
  });
});

describe("buildVerifyJudgmentPrompt", () => {
  it("includes acceptance criteria", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: "- Widget renders\n- Widget saves",
      diff: "diff --git a/src/widget.ts",
      evidence: "Build: OK\nTests: 5 passed",
    });
    expect(result).toContain("Widget renders");
    expect(result).toContain("Widget saves");
  });

  it("includes the diff", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: "Criteria",
      diff: "diff --git a/src/widget.ts b/src/widget.ts\n+export function widget() {}",
      evidence: "All green",
    });
    expect(result).toContain("diff --git a/src/widget.ts");
  });

  it("includes the evidence from Claude", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: "Criteria",
      diff: "some diff",
      evidence: "Build: FAIL\nError: Cannot find module './missing'",
    });
    expect(result).toContain("Cannot find module './missing'");
  });

  it("specifies pass/fail verdict output format", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: "Criteria",
      diff: "diff",
      evidence: "evidence",
    });
    expect(result).toContain('"verdict"');
    expect(result).toContain('"pass"');
    expect(result).toContain('"fail"');
    expect(result).toContain('"reasons"');
  });

  it("instructs that objective oracle failures mean fail", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: "Criteria",
      diff: "diff",
      evidence: "evidence",
    });
    const lower = result.toLowerCase();
    expect(lower).toMatch(/build|test|type|lint/);
    expect(lower).toMatch(/fail/);
  });

  it("handles null acceptance gracefully", () => {
    const result = buildVerifyJudgmentPrompt({
      acceptance: null,
      diff: "diff",
      evidence: "evidence",
    });
    expect(result).toContain('"verdict"');
    expect(result).toContain("No explicit acceptance criteria provided");
  });

  it("wraps diff in a 4-backtick fence so embedded ``` lines cannot close it", () => {
    const diffWithFence = "context line\n ``` embedded fence\nmore context";
    const result = buildVerifyJudgmentPrompt({
      acceptance: "Criteria",
      diff: diffWithFence,
      evidence: "evidence",
    });
    expect(result).toContain("embedded fence");
    // The outer fence must use 4+ backticks so a 3-backtick sequence in the diff is safe
    expect(result).toMatch(/````/);
  });
});
