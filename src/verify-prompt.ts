import type { EligibleIssue, PlanBrief, SpecContent } from "./types.js";

export interface VerifyEvidencePromptArgs {
  issue: EligibleIssue;
  brief: PlanBrief | null;
  specContent: SpecContent | null;
  defaultBranch: string;
  specDir?: string;
}

export function buildVerifyEvidencePrompt(args: VerifyEvidencePromptArgs): string {
  const { issue, brief, specContent, defaultBranch, specDir } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are performing an acceptance verification of a recent implementation.",
      "A separate session implemented the ticket below. Your job is to collect evidence",
      "by running objective checks and comparing the changes against acceptance criteria.",
      "",
      "IMPORTANT: Do NOT fix, modify, change, or edit any code. You are a verifier, not an implementer.",
      "Your sole job is to run checks, observe results, and report evidence.",
    ].join("\n"),
  );

  const acceptance = brief?.sections?.acceptance ?? null;
  if (acceptance) {
    blocks.push(["# Acceptance Criteria", "", acceptance].join("\n"));
  }

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

  if (brief && brief.raw.length > 0) {
    blocks.push(["# Implementation Brief", "", brief.raw].join("\n"));
  }

  blocks.push(
    [
      "# Instructions",
      "",
      `1. Read the git diff (\`git diff origin/${defaultBranch}...HEAD\`) to understand what was implemented.`,
      "2. Run the following objective checks and record their full output:",
      "   - **Build**: Run the project build command.",
      "   - **Test**: Run the test suite.",
      "   - **Type check**: Run the type checker (e.g. `tsc --noEmit`).",
      "   - **Lint**: Run the linter.",
      "3. Compare the implementation against the acceptance criteria above.",
      `4. If relevant, read the product specifications in \`${specDir ?? "docs/specs/"}\`.`,
      "5. Do NOT fix, modify, or change any code — only observe and report.",
      "6. Do NOT push commits, open pull requests, or create branches.",
      "",
      "# Output",
      "",
      "Report your findings as structured text with the following sections:",
      "",
      "## Build",
      "[paste full build output or summary]",
      "",
      "## Test",
      "[paste full test output or summary]",
      "",
      "## Type Check",
      "[paste full type check output or summary]",
      "",
      "## Lint",
      "[paste full lint output or summary]",
      "",
      ...(acceptance
        ? [
            "## Acceptance Criteria Assessment",
            "[For each criterion, state whether it is met and why]",
          ]
        : []),
    ].join("\n"),
  );

  return blocks.join("\n\n");
}

export interface VerifyJudgmentPromptArgs {
  acceptance: string | null;
  diff: string;
  evidence: string;
}

export function buildVerifyJudgmentPrompt(args: VerifyJudgmentPromptArgs): string {
  const { acceptance, diff, evidence } = args;
  const blocks: string[] = [];

  blocks.push(
    [
      "You are an objective judge determining whether an implementation passes acceptance verification.",
      "You will be given acceptance criteria, the actual code diff, and evidence collected by a separate verifier.",
      "",
      "Your judgment must follow these rules:",
      "1. If ANY objective oracle (build, test, type check, lint) shows a failure, the verdict is **fail**.",
      "2. If all objective oracles pass, judge whether the acceptance criteria are satisfied by the diff.",
      "3. Both conditions must hold for a **pass** verdict.",
    ].join("\n"),
  );

  if (acceptance) {
    blocks.push(["# Acceptance Criteria", "", acceptance].join("\n"));
  } else {
    blocks.push("# Acceptance Criteria\n\n(No explicit acceptance criteria provided. Judge based on objective oracles only.)");
  }

  blocks.push(["# Code Diff", "", "```", diff, "```"].join("\n"));

  blocks.push(["# Verification Evidence", "", evidence].join("\n"));

  blocks.push(
    [
      "# Output Format",
      "",
      "Respond with a JSON object in a fenced ```json block:",
      "",
      "```json",
      "{",
      '  "verdict": "pass",',
      '  "reasons": []',
      "}",
      "```",
      "",
      '- `"verdict"`: `"pass"` if all oracles are green AND acceptance criteria are met, `"fail"` otherwise.',
      '- `"reasons"`: If `"fail"`, list every reason (at least one). If `"pass"`, use an empty array.',
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
