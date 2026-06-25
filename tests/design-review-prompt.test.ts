import { describe, it, expect } from "vitest";
import { buildDesignReviewPrompt } from "../src/design-review-prompt.js";
import type { EligibleIssue, PlanBrief, SpecContent } from "../src/types.js";

const testIssue: EligibleIssue = {
  id: "uuid-1",
  identifier: "TY-1",
  title: "Add feature X",
  description: "Build feature X per spec",
  priority: 2,
  sortOrder: 0,
  url: "https://linear.app/issue/TY-1",
};

const testBrief: PlanBrief = {
  raw: "## Goal\nDo X\n\n## Change Targets\n- file.ts\n\n## Implementation Steps\n1. Step\n\n## Acceptance Criteria\n- Pass\n\n## Out of Scope\n- Nothing",
  sections: { goal: "Do X", changeTargets: "- file.ts", steps: "1. Step", acceptance: "- Pass", outOfScope: "- Nothing" },
};

describe("buildDesignReviewPrompt", () => {
  it("includes the design brief and ticket info", () => {
    const prompt = buildDesignReviewPrompt({ issue: testIssue, brief: testBrief, specContent: null });
    expect(prompt).toContain("TY-1");
    expect(prompt).toContain("Do X");
    expect(prompt).toContain("approve");
    expect(prompt).toContain("reject");
  });

  it("includes spec content when provided", () => {
    const spec: SpecContent = {
      requirements: "Must do Y",
      domainSpecs: [{ name: "auth", content: "Auth spec" }],
    };
    const prompt = buildDesignReviewPrompt({ issue: testIssue, brief: testBrief, specContent: spec });
    expect(prompt).toContain("Must do Y");
    expect(prompt).toContain("Auth spec");
  });

  it("includes prior rejection reasons when provided", () => {
    const prompt = buildDesignReviewPrompt({
      issue: testIssue,
      brief: testBrief,
      specContent: null,
      priorRejectReasons: ["Missing error handling", "Scope too broad"],
    });
    expect(prompt).toContain("Missing error handling");
    expect(prompt).toContain("Scope too broad");
  });

  it("specifies JSON output format", () => {
    const prompt = buildDesignReviewPrompt({ issue: testIssue, brief: testBrief, specContent: null });
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"reasons"');
  });

  it("example JSON block in output format is valid JSON", () => {
    const prompt = buildDesignReviewPrompt({ issue: testIssue, brief: testBrief, specContent: null });
    const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![1]!)).not.toThrow();
  });
});
