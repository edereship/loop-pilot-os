import type { EligibleIssue, PlanBrief, SpecContent } from "./types.js";
import { buildMemoryBlock } from "./memory-inject.js";

export interface SelfReviewPromptArgs {
  issue: EligibleIssue;
  brief: PlanBrief | null;
  specContent: SpecContent | null;
  defaultBranch: string;
  specDir?: string;
  memory?: {
    implResults?: string;
    productKnowledge?: string;
  } | null;
  memoryBudgetChars?: number;
}

export function buildSelfReviewPrompt(args: SelfReviewPromptArgs): string {
  const { issue, brief, specContent, defaultBranch, specDir, memory, memoryBudgetChars } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are performing a self-review of a recent implementation.",
      "A separate session implemented the ticket below. Your job is to review the changes",
      "already committed in this worktree against the original requirements.",
      "",
      "Review the implementation from these four perspectives:",
      "1. **Requirements alignment**: Do the changes satisfy every acceptance criterion in the ticket?",
      "2. **Brief alignment**: Do the changes follow the implementation brief's approach and steps?",
      `3. **Spec alignment**: Do the changes comply with the product specifications in \`${specDir ?? "docs/specs/"}\`?`,
      "4. **Completeness**: Is anything missing? Are there any gaps in completeness?",
      "",
      "Do NOT review code quality, style, performance, or security — those are handled by the PR reviewer.",
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

  if (memory) {
    const entries = [
      ...(memory.implResults ? [{ label: "Implementation Results", content: memory.implResults }] : []),
      ...(memory.productKnowledge ? [{ label: "Product Knowledge", content: memory.productKnowledge }] : []),
    ];
    const block = buildMemoryBlock(entries, memoryBudgetChars ?? 6000);
    if (block.length > 0) blocks.push(block);
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

  if (brief && brief.raw.length > 0) {
    blocks.push(["# Implementation Brief", "", brief.raw].join("\n"));
  }

  blocks.push(
    [
      "# Instructions",
      "",
      `1. Read the git diff (\`git diff origin/${defaultBranch}...HEAD\`) to understand what was implemented.`,
      "2. Compare the implementation against the ticket, brief, and specs.",
      "3. If you find issues (missing features, incorrect behavior, spec violations),",
      "   fix them directly in the code and commit your changes.",
      "4. Output your verdict as a JSON object in a fenced ```json block.",
      "",
      "# Output Format",
      "",
      "```json",
      "{",
      '  "verdict": "pass",',
      '  "issues": [],',
      '  "summary": "All acceptance criteria met."',
      "}",
      "```",
      "",
      "- `verdict`: `\"pass\"` if the implementation meets all requirements (possibly after your fixes),",
      "  `\"fail\"` if there are issues you could not fix.",
      "- `issues`: List of issues found. Each is a string describing what was wrong and what you did",
      "  (e.g. `\"Missing validation for empty input — added check in handler.ts\"`).",
      "  Empty array if no issues found.",
      "- `summary`: One-sentence summary of the review outcome.",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
