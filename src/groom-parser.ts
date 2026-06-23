import { z } from "zod";
import type { GroomOutput } from "./types.js";

const prioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const memoryCategorySchema = z.enum(["pm_decisions", "impl_results", "product_knowledge"]);

const groomActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reprioritize"), issueId: z.string(), priority: prioritySchema, rationale: z.string() }),
  z.object({ type: z.literal("update"), issueId: z.string(), title: z.string().optional(), description: z.string().optional(), rationale: z.string() }),
  z.object({ type: z.literal("create"), title: z.string(), description: z.string(), priority: prioritySchema, rationale: z.string() }),
  z.object({ type: z.literal("split"), issueId: z.string(), subtasks: z.array(z.object({ title: z.string(), description: z.string() })), rationale: z.string() }),
  z.object({ type: z.literal("close"), issueId: z.string(), rationale: z.string() }),
  z.object({ type: z.literal("label"), issueId: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), rationale: z.string() }),
  z.object({ type: z.literal("update_memory"), category: memoryCategorySchema, content: z.string(), rationale: z.string() }),
]);

const groomOutputSchema = z.object({
  actions: z.array(groomActionSchema),
  summary: z.string(),
});

export type GroomParseResult =
  | { kind: "ok"; value: GroomOutput }
  | { kind: "parse_error"; raw: string };

export function parseGroomOutput(codexOutput: string): GroomParseResult {
  const trimmed = codexOutput.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: codexOutput };

  const jsonStr = extractJson(trimmed);
  if (jsonStr === null) return { kind: "parse_error", raw: codexOutput };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { kind: "parse_error", raw: codexOutput };
  }

  const result = groomOutputSchema.safeParse(parsed);
  if (!result.success) return { kind: "parse_error", raw: codexOutput };

  return { kind: "ok", value: result.data as GroomOutput };
}

function extractJson(text: string): string | null {
  // Tier 1: fenced ```json blocks (last one wins)
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) return lastFenceMatch;

  // Tier 2: single-line raw JSON object (last one wins)
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      return line;
    }
  }

  // Tier 3: multi-line unfenced JSON object
  let endLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimEnd().endsWith("}")) { endLine = i; break; }
  }
  if (endLine !== -1) {
    for (let startLine = endLine; startLine >= 0; startLine--) {
      if (lines[startLine].trimStart().startsWith("{")) {
        return lines.slice(startLine, endLine + 1).join("\n");
      }
    }
  }

  return null;
}
