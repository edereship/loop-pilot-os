import { z } from "zod";

export const TITLE_MAX = 255;
export const MAX_CANDIDATES = 10;

export interface ScoutCandidate {
  title: string;
  description: string;
  evidence: string;
  evidence_type: "objective" | "spec_mismatch";
  priority: number;
}

const scoutCandidateSchema = z.object({
  title: z.string().trim().min(1).refine(s => s !== "...", { message: "placeholder value" }),
  description: z.string().trim().min(1).refine(s => s !== "...", { message: "placeholder value" }),
  evidence: z.string().trim().min(1).refine(s => s !== "...", { message: "placeholder value" }),
  evidence_type: z.enum(["objective", "spec_mismatch"]),
  priority: z.number().int().min(1).max(4),
});

const scoutOutputSchema = z.object({
  candidates: z.array(z.unknown()),
});

export type ScoutParseResult =
  | { kind: "ok"; candidates: ScoutCandidate[]; dropped: string[] }
  | { kind: "parse_error"; raw: string };

export function parseScoutOutput(text: string): ScoutParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const jsonText of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }
    const top = scoutOutputSchema.safeParse(parsed);
    if (!top.success) continue;
    return salvage(top.data.candidates);
  }

  return { kind: "parse_error", raw: text };
}

function salvage(items: unknown[]): ScoutParseResult {
  const candidates: ScoutCandidate[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const res = scoutCandidateSchema.safeParse(items[i]);
    if (!res.success) {
      const reasons = res.error.issues
        .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
        .join("; ");
      dropped.push(`candidate[${i}]: ${reasons}`);
      continue;
    }
    const c = res.data;
    candidates.push({ ...c, title: c.title.slice(0, TITLE_MAX) });
  }
  if (candidates.length > MAX_CANDIDATES) {
    dropped.push(
      `${candidates.length - MAX_CANDIDATES} valid candidate(s) beyond MAX_CANDIDATES=${MAX_CANDIDATES} truncated`,
    );
    candidates.length = MAX_CANDIDATES;
  }
  return { kind: "ok", candidates, dropped };
}

function* extractJsonCandidates(text: string): Generator<string> {
  const fencePattern = /```json[ \t]*([\s\S]*?)[ \t]*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) { yield lastFenceMatch.trim(); }

  const lines = text.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("```json")) {
      const afterMarker = line.slice("```json".length).trimStart();
      const jsonStart = afterMarker.indexOf("{");
      const jsonEnd = afterMarker.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        yield afterMarker.slice(jsonStart, jsonEnd + 1);
      }
      break;
    }
  }

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
