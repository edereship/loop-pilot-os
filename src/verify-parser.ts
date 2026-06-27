import { z } from "zod";
import type { VerifyVerdict } from "./types.js";

const verifyVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reasons: z.array(z.string()),
}).refine(
  (v) => v.verdict !== "fail" || (v.reasons.length > 0 && v.reasons.every((r) => r.length > 0)),
);

export type VerifyParseResult =
  | { kind: "ok"; value: VerifyVerdict }
  | { kind: "parse_error"; raw: string };

export function parseVerifyOutput(text: string): VerifyParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const candidate of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = verifyVerdictSchema.safeParse(parsed);
    if (result.success) return { kind: "ok", value: result.data as VerifyVerdict };
  }

  return { kind: "parse_error", raw: text };
}

function* extractJsonCandidates(text: string): Generator<string> {
  // Accept both multiline and compact single-line fenced blocks:
  //   ```json\n{...}\n```   (standard)
  //   ```json {...} ```     (compact — produced by some judge responses)
  const fencePattern = /```json[ \t]*([\s\S]*?)[ \t]*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) { yield lastFenceMatch.trim(); return; }

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
