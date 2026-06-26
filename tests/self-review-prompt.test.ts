import { describe, it, expect } from "vitest";
import { buildSelfReviewPrompt } from "../src/self-review-prompt.js";
import type { EligibleIssue, PlanBrief, SpecContent } from "../src/types.js";

describe("buildSelfReviewPrompt", () => {
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
      acceptance: "Widget renders",
      outOfScope: "Styling",
    },
  };

  const specContent: SpecContent = {
    requirements: "The system must support widgets.",
    domainSpecs: [{ name: "ui", content: "Widgets must be accessible." }],
  };

  it("includes system role, ticket, brief, specs, and output format", () => {
    const result = buildSelfReviewPrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("self-review");
    expect(result).toContain("TY-1");
    expect(result).toContain("Add widget");
    expect(result).toContain("Add a widget");
    expect(result).toContain("The system must support widgets.");
    expect(result).toContain("Widgets must be accessible.");
    expect(result).toContain('"verdict"');
    expect(result).toContain('"issues"');
  });

  it("includes all four review perspectives", () => {
    const result = buildSelfReviewPrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("requirements");
    expect(result).toContain("brief");
    expect(result).toContain("spec");
    expect(result).toContain("completeness");
  });

  it("works without specContent", () => {
    const result = buildSelfReviewPrompt({ issue, brief, specContent: null, defaultBranch: "main" });
    expect(result).toContain("TY-1");
    expect(result).not.toContain("Product Requirements");
  });

  it("works without brief", () => {
    const result = buildSelfReviewPrompt({ issue, brief: null, specContent: null, defaultBranch: "main" });
    expect(result).toContain("TY-1");
    expect(result).not.toContain("Implementation Brief");
  });

  it("interpolates defaultBranch into git diff command", () => {
    const result = buildSelfReviewPrompt({ issue, brief, specContent: null, defaultBranch: "master" });
    expect(result).toContain("origin/master...HEAD");
    expect(result).not.toContain("origin/main");
  });

  it("includes memory when provided", () => {
    const result = buildSelfReviewPrompt({
      issue,
      brief,
      specContent: null,
      defaultBranch: "main",
      memory: { implResults: "Previous: fixed auth bug" },
      memoryBudgetChars: 6000,
    });
    expect(result).toContain("Previous: fixed auth bug");
  });

  it("instructs agent to fix issues and commit", () => {
    const result = buildSelfReviewPrompt({ issue, brief, specContent, defaultBranch: "main" });
    expect(result).toContain("fix");
    expect(result).toContain("commit");
  });
});
