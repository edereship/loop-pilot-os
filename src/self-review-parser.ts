import { z } from "zod";

export interface SelfReviewVerdict {
  verdict: "pass" | "fail";
  issues: string[];
  summary: string;
}

const selfReviewVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  issues: z.array(z.string()),
  summary: z.string(),
});

export type SelfReviewParseResult =
  | { kind: "ok"; value: SelfReviewVerdict }
  | { kind: "parse_error"; raw: string };

export function parseSelfReviewOutput(text: string): SelfReviewParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const candidate of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = selfReviewVerdictSchema.safeParse(parsed);
    if (result.success) return { kind: "ok", value: result.data };
  }

  return { kind: "parse_error", raw: text };
}

function* extractJsonCandidates(text: string): Generator<string> {
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) { yield lastFenceMatch; return; }

  const lines = text.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      yield line;
      break;
    }
  }

  let endLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimEnd().endsWith("}")) { endLine = i; break; }
  }
  if (endLine !== -1) {
    for (let startLine = endLine; startLine >= 0; startLine--) {
      if (lines[startLine].trimStart().startsWith("{")) {
        yield lines.slice(startLine, endLine + 1).join("\n");
      }
    }
  }
}
