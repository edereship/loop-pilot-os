import type { EligibleIssue, PlanBrief, SpecContent } from "./types.js";

export interface DesignReviewPromptArgs {
  issue: EligibleIssue;
  brief: PlanBrief;
  specContent: SpecContent | null;
  priorRejectReasons?: string[];
}

export function buildDesignReviewPrompt(args: DesignReviewPromptArgs): string {
  const { issue, brief, specContent, priorRejectReasons } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are an independent design reviewer.",
      "Your role is to verify that the proposed implementation design satisfies the ticket requirements.",
      "",
      "Review the design brief below against the original ticket.",
      "Focus ONLY on these dimensions:",
      "- **Requirements alignment**: Does the design address all requirements in the ticket?",
      "- **Scope deviation**: Does the design add anything not requested or miss something required?",
      "- **Gaps and omissions**: Are there missing steps, unhandled cases, or incomplete coverage?",
      "- **Risk**: Are there architectural risks, performance concerns, or safety issues?",
      "",
      "Do NOT review code quality, style, or implementation details — those are handled later.",
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

  blocks.push(["# Design Brief Under Review", "", brief.raw].join("\n"));

  if (priorRejectReasons && priorRejectReasons.length > 0) {
    blocks.push(
      [
        "# Prior Rejection Feedback",
        "",
        "This design was previously rejected. The following issues were raised.",
        "Verify whether each has been addressed in the current revision:",
        "",
        ...priorRejectReasons.map((r, i) => `${i + 1}. ${r}`),
      ].join("\n"),
    );
  }

  blocks.push(
    [
      "# Output Format",
      "",
      "Respond with a single JSON object in a fenced ```json block:",
      "",
      "```json",
      "{",
      '  "verdict": "approve",',
      '  "reasons": []',
      "}",
      "```",
      "",
      "- `verdict`: `\"approve\"` if the design adequately addresses the ticket, `\"reject\"` otherwise.",
      "- `reasons`: When rejecting, list specific, actionable issues. When approving, this array should be empty.",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
