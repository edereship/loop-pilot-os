import { z } from "zod";
import type { DesignReviewVerdict } from "./types.js";

const designReviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  reasons: z.array(z.string()),
});

export type DesignReviewParseResult =
  | { kind: "ok"; value: DesignReviewVerdict }
  | { kind: "parse_error"; raw: string };

export function parseDesignReviewOutput(text: string): DesignReviewParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const candidate of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = designReviewVerdictSchema.safeParse(parsed);
    if (result.success) return { kind: "ok", value: result.data as DesignReviewVerdict };
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
