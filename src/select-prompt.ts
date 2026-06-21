import type { SelectPromptArgs, ParsedSelection, PrDiffSummary } from "./types.js";

export function parseSelection(codexOutput: string): ParsedSelection | null {
  const trimmed = codexOutput.trim();
  if (trimmed.length === 0) return null;

  // Try fenced ```json blocks first (last one wins)
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(trimmed)) !== null) {
    lastFenceMatch = m[1];
  }

  // Fallback: try to find a raw JSON object on a line by itself
  let jsonStr = lastFenceMatch;
  if (jsonStr === null) {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        jsonStr = line;
        break;
      }
    }
  }

  if (jsonStr === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.identifier !== "string") return null;

  const identifier = obj.identifier.trim();
  if (identifier.length === 0) return null;

  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";

  return { identifier, rationale };
}

export function computeDiffStat(unifiedDiff: string): string {
  if (unifiedDiff.trim().length === 0) return "";

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let current: { path: string; insertions: number; deletions: number } | null = null;

  for (const line of unifiedDiff.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\//.exec(line);
    if (fileMatch) {
      if (current) files.push(current);
      current = { path: fileMatch[1], insertions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) current.insertions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  if (current) files.push(current);

  if (files.length === 0) return "";

  const MAX_BAR = 50;
  const lines = files.map((f) => {
    const total = f.insertions + f.deletions;
    let plusCount = f.insertions;
    let minusCount = f.deletions;
    if (total > MAX_BAR) {
      plusCount = Math.round((f.insertions / total) * MAX_BAR);
      minusCount = MAX_BAR - plusCount;
    }
    const bar = "+".repeat(plusCount) + "-".repeat(minusCount);
    return ` ${f.path} | ${total} ${bar}`;
  });

  const totalInsertions = files.reduce((s, f) => s + f.insertions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const filesWord = files.length === 1 ? "1 file changed" : `${files.length} files changed`;
  const parts = [filesWord];
  if (totalInsertions > 0) parts.push(`${totalInsertions} insertion${totalInsertions === 1 ? "" : "s"}(+)`);
  if (totalDeletions > 0) parts.push(`${totalDeletions} deletion${totalDeletions === 1 ? "" : "s"}(-)`);

  lines.push(` ${parts.join(", ")}`);
  return lines.join("\n");
}

export function formatDiffContext(
  identifier: string,
  summary: PrDiffSummary,
  budgetChars: number,
): string {
  const blocks: string[] = [];

  blocks.push(`PR (${identifier}): ${summary.title}`);
  if (summary.body.trim().length > 0) {
    blocks.push(summary.body.trim());
  }

  const stat = computeDiffStat(summary.diff);
  if (stat.length > 0) {
    blocks.push(`Diff stat:\n${stat}`);
  }

  const baseLength = blocks.join("\n\n").length;
  const remaining = budgetChars - baseLength;

  if (summary.diff.trim().length > 0) {
    if (remaining > 100 && summary.diff.length <= remaining) {
      blocks.push(`Full diff:\n${summary.diff}`);
    } else if (summary.diff.length > 0) {
      // Either over budget or tight — always show a truncated snippet so "(truncated)" is visible
      const truncated = remaining > 50 ? truncateDiffPerFile(summary.diff, Math.max(remaining, 0)) : "";
      if (truncated.length > 0) {
        blocks.push(`Diff (truncated):\n${truncated}`);
      } else {
        blocks.push(`Diff (truncated):\n${summary.diff.split("\n").slice(0, 4).join("\n")}\n... (truncated)`);
      }
    }
  }

  return blocks.join("\n\n");
}

function truncateDiffPerFile(unifiedDiff: string, budget: number): string {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  const result: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used + chunk.length + 1 <= budget) {
      result.push(chunk);
      used += chunk.length + 1;
    } else {
      const remaining = budget - used;
      if (remaining > 50) {
        const header = chunk.split("\n").slice(0, 4).join("\n");
        result.push(header + "\n... (file truncated)");
      }
      break;
    }
  }
  return result.join("\n");
}

export function buildSelectPrompt(args: SelectPromptArgs): string {
  const { goal, specContent, eligible, inProgress, recentMerged, lastPrDiff, diffBudgetChars } = args;

  const blocks: string[] = [];

  // System instruction
  blocks.push([
    "You are a project manager selecting the next task for the development team.",
    "Given the product context, current board state, and recent work, select the single most valuable next task.",
    "",
    "Consider:",
    "- Alignment with product requirements (the anchor)",
    "- Strategic sequencing (does recent work create momentum for a specific next task?)",
    "- Priority and urgency",
    "- Dependencies and risk",
  ].join("\n"));

  // Requirements / specs (anchor)
  if (specContent) {
    blocks.push(["# Product Requirements", "", specContent.requirements].join("\n"));
    if (specContent.domainSpecs.length > 0) {
      const sections = specContent.domainSpecs.map(
        (s) => [`## ${s.name}`, "", s.content].join("\n"),
      );
      blocks.push(["# Domain Specifications", "", ...sections].join("\n\n"));
    }
  } else if (goal) {
    blocks.push(["# Product Goal", "", goal].join("\n"));
  }

  // Board state: in-progress
  if (inProgress.length > 0) {
    const lines = inProgress.map(
      (s) => `- ${s.linearIdentifier}: ${s.issueTitle}`,
    );
    blocks.push(["# Currently In Progress", "", ...lines].join("\n"));
  }

  // Board state: recently completed
  if (recentMerged.length > 0) {
    const lines = recentMerged.map((s) => {
      const summary = s.agentSummary ? ` — ${s.agentSummary.split("\n")[0].trim()}` : "";
      return `- ${s.linearIdentifier}: ${s.issueTitle}${summary}`;
    });
    blocks.push(["# Recently Completed", "", ...lines].join("\n"));
  }

  // Last merged PR diff
  if (lastPrDiff) {
    const diffContext = formatDiffContext(
      lastPrDiff.identifier,
      lastPrDiff.summary,
      diffBudgetChars,
    );
    blocks.push(["# Previous Task Diff", "", diffContext].join("\n"));
  }

  // Eligible candidates
  const candidateLines = eligible.map((e, i) => {
    const desc = e.description.trim().length > 0
      ? e.description.trim().split("\n").slice(0, 3).join("\n  ")
      : "(no description)";
    return `${i + 1}. ${e.identifier} [Priority: ${priorityLabel(e.priority)}]: ${e.title}\n  ${desc}`;
  });
  blocks.push(["# Eligible Candidates", "", "Select ONE from the following:", "", ...candidateLines].join("\n"));

  // Output format instruction
  blocks.push([
    "# Output",
    "",
    "Respond with a JSON block containing your selection:",
    "",
    "```json",
    '{"identifier":"XX-123","rationale":"one line explaining why this task is the best next pick"}',
    "```",
    "",
    "The identifier MUST exactly match one of the eligible candidates above.",
  ].join("\n"));

  return blocks.join("\n\n");
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Urgent";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return "None";
  }
}
