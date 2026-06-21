import { describe, it, expect } from "vitest";
import { buildPlanPrompt, parseBrief } from "../src/plan-brief.js";
import type { EligibleIssue, SpecContent } from "../src/types.js";

function issue(over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id: "uuid-1",
    identifier: "ES-381",
    title: "Add PLAN phase",
    description: "Implement the PLAN phase in the orchestrator.",
    priority: 2,
    sortOrder: 0,
    url: "https://linear.app/issue/ES-381",
    ...over,
  };
}

describe("parseBrief", () => {
  it("parses all 5 sections from well-formed markdown", () => {
    const output = [
      "## Goal",
      "Implement the PLAN phase.",
      "",
      "## Change Targets",
      "- src/orchestrator.ts: add PLAN phase",
      "- src/plan-brief.ts: new module",
      "",
      "## Implementation Steps",
      "1. Add types to types.ts",
      "2. Create plan-brief.ts",
      "",
      "## Acceptance Criteria",
      "- npm run check passes",
      "",
      "## Out of Scope",
      "- buildPrompt injection (ES-405)",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.raw).toBe(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Implement the PLAN phase.");
    expect(brief.sections!.changeTargets).toContain("src/orchestrator.ts");
    expect(brief.sections!.steps).toContain("1. Add types");
    expect(brief.sections!.acceptance).toContain("npm run check");
    expect(brief.sections!.outOfScope).toContain("ES-405");
  });

  it("returns sections: null for empty output", () => {
    const brief = parseBrief("");
    expect(brief.raw).toBe("");
    expect(brief.sections).toBeNull();
  });

  it("returns sections: null for whitespace-only output", () => {
    const brief = parseBrief("   \n  \n  ");
    expect(brief.raw).toBe("");
    expect(brief.sections).toBeNull();
  });

  it("returns sections: null when no recognized headings are found", () => {
    const brief = parseBrief("Just some plain text without any headings.");
    expect(brief.sections).toBeNull();
    expect(brief.raw).toBe("Just some plain text without any headings.");
  });

  it("fills missing sections with empty string", () => {
    const output = [
      "## Goal",
      "Do the thing.",
      "",
      "## Implementation Steps",
      "1. Do it",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Do the thing.");
    expect(brief.sections!.changeTargets).toBe("");
    expect(brief.sections!.steps).toBe("1. Do it");
    expect(brief.sections!.acceptance).toBe("");
    expect(brief.sections!.outOfScope).toBe("");
  });

  it("handles case-insensitive heading matching", () => {
    const output = "## goal\nSome goal.\n\n## CHANGE TARGETS\n- file.ts";
    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("Some goal.");
    expect(brief.sections!.changeTargets).toBe("- file.ts");
  });

  it("handles preamble text before the first heading", () => {
    const output = [
      "Here is my analysis of the ticket.",
      "",
      "## Goal",
      "The goal is X.",
    ].join("\n");

    const brief = parseBrief(output);
    expect(brief.sections).not.toBeNull();
    expect(brief.sections!.goal).toBe("The goal is X.");
  });
});

describe("buildPlanPrompt", () => {
  it("includes ticket identifier, title, and output format headings", () => {
    const prompt = buildPlanPrompt({ issue: issue(), specContent: null });
    expect(prompt).toContain("ES-381");
    expect(prompt).toContain("Add PLAN phase");
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Change Targets");
    expect(prompt).toContain("## Implementation Steps");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("## Out of Scope");
  });

  it("includes requirements and domain specs when specContent is provided", () => {
    const specContent: SpecContent = {
      requirements: "Build a great product.",
      domainSpecs: [{ name: "auth", content: "Auth spec details." }],
    };
    const prompt = buildPlanPrompt({ issue: issue(), specContent });
    expect(prompt).toContain("Build a great product.");
    expect(prompt).toContain("Auth spec details.");
  });

  it("omits spec sections when specContent is null", () => {
    const prompt = buildPlanPrompt({ issue: issue(), specContent: null });
    expect(prompt).not.toContain("Product Requirements");
    expect(prompt).not.toContain("Domain Specifications");
  });

  it("includes requirements but omits domain specs heading when domainSpecs is empty", () => {
    const specContent: SpecContent = {
      requirements: "Build a great product.",
      domainSpecs: [],
    };
    const prompt = buildPlanPrompt({ issue: issue(), specContent });
    expect(prompt).toContain("Build a great product.");
    expect(prompt).not.toContain("Domain Specifications");
  });

  it("shows (no description) for empty description", () => {
    const prompt = buildPlanPrompt({ issue: issue({ description: "" }), specContent: null });
    expect(prompt).toContain("(no description)");
  });

  it("includes the ticket description verbatim", () => {
    const prompt = buildPlanPrompt({
      issue: issue({ description: "Fix the bug in auth module." }),
      specContent: null,
    });
    expect(prompt).toContain("Fix the bug in auth module.");
  });
});
