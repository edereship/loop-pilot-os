import type { EligibleIssue, SpecContent, PlanBrief, BriefSections } from "./types.js";

export interface PlanPromptArgs {
  issue: EligibleIssue;
  specContent: SpecContent | null;
}

export function buildPlanPrompt(args: PlanPromptArgs): string {
  const { issue, specContent } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are a software implementation planner.",
      "Given the ticket below, produce an implementation brief.",
      "",
      "The brief must help the implementing engineer understand:",
      "- WHAT: the ticket's goal (restate, do NOT invent new goals)",
      "- HOW: concrete implementation steps grounded in the codebase",
      "",
      "You have read-only access to the repository.",
      "Explore the code to ground your plan in the actual file structure and patterns.",
    ].join("\n"),
  );

  if (specContent) {
    blocks.push(["# Product Requirements", "", specContent.requirements].join("\n"));
    if (specContent.domainSpecs.length > 0) {
      const sections = specContent.domainSpecs.map(
        (s) => [`## ${s.name}`, "", s.content].join("\n"),
      );
      blocks.push(["# Domain Specifications", "", ...sections].join("\n\n"));
    }
  }

  const description = issue.description.trim().length > 0 ? issue.description : "(no description)";
  blocks.push(
    [
      "# Ticket",
      "",
      `- identifier: ${issue.identifier}`,
      `- title: ${issue.title}`,
      `- url: ${issue.url}`,
      "",
      "## Description",
      "",
      description,
    ].join("\n"),
  );

  blocks.push(
    [
      "# Output Format",
      "",
      "Produce the brief using EXACTLY these markdown headings (in this order).",
      "Each section must start with the heading on its own line.",
      "",
      "## Goal",
      "(Restate the ticket's objective. Align with the product requirements. Do NOT invent new goals.)",
      "",
      "## Change Targets",
      "(List the files and modules that need to change, with a one-line rationale for each.)",
      "",
      "## Implementation Steps",
      "(Numbered steps. Be specific — reference actual functions, types, and patterns in the codebase.)",
      "",
      "## Acceptance Criteria",
      "(How to verify the implementation is correct.)",
      "",
      "## Out of Scope",
      "(What this ticket explicitly does NOT cover.)",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}

const SECTION_HEADINGS: Array<{ key: keyof BriefSections; pattern: RegExp }> = [
  { key: "goal", pattern: /^##\s+goal\b/i },
  { key: "changeTargets", pattern: /^##\s+change\s+targets?\b/i },
  { key: "steps", pattern: /^##\s+implementation\s+steps?\b/i },
  { key: "acceptance", pattern: /^##\s+acceptance\s+criteria?\b/i },
  { key: "outOfScope", pattern: /^##\s+out\s+of\s+scope\b/i },
];

export function parseBrief(codexOutput: string): PlanBrief {
  const raw = codexOutput.trim();
  if (raw.length === 0) {
    return { raw, sections: null };
  }

  const lines = raw.split("\n");
  const found: Array<{ key: keyof BriefSections; start: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const heading of SECTION_HEADINGS) {
      if (heading.pattern.test(line)) {
        found.push({ key: heading.key, start: i });
        break;
      }
    }
  }

  if (found.length === 0) {
    return { raw, sections: null };
  }

  const partial: Partial<BriefSections> = {};
  for (let i = 0; i < found.length; i++) {
    const { key, start } = found[i]!;
    const end = i + 1 < found.length ? found[i + 1]!.start : lines.length;
    partial[key] = lines.slice(start + 1, end).join("\n").trim();
  }

  return {
    raw,
    sections: {
      goal: partial.goal ?? "",
      changeTargets: partial.changeTargets ?? "",
      steps: partial.steps ?? "",
      acceptance: partial.acceptance ?? "",
      outOfScope: partial.outOfScope ?? "",
    },
  };
}
