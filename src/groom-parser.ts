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

  for (const candidate of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = groomOutputSchema.safeParse(parsed);
    if (result.success) return { kind: "ok", value: result.data as GroomOutput };
  }

  return { kind: "parse_error", raw: codexOutput };
}

// Yields JSON string candidates in priority order. parseGroomOutput tries each
// in sequence and stops at the first that parses and validates against the schema.
function* extractJsonCandidates(text: string): Generator<string> {
  // Tier 1: fenced ```json blocks (last one wins); no further tiers tried.
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) { yield lastFenceMatch; return; }

  const lines = text.split("\n");

  // Tier 2: single-line raw JSON object (last one wins).
  // Yields a candidate but does NOT stop — a nested action line also matches
  // this pattern, so we fall through to Tier 3 when schema validation fails.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      yield line;
      break;
    }
  }

  // Tier 3: multi-line unfenced JSON object.
  // Scan forward for the outermost '{' so nested action objects don't shadow it.
  let endLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimEnd().endsWith("}")) { endLine = i; break; }
  }
  if (endLine !== -1) {
    for (let startLine = 0; startLine <= endLine; startLine++) {
      if (lines[startLine].trimStart().startsWith("{")) {
        yield lines.slice(startLine, endLine + 1).join("\n");
        break;
      }
    }
  }
}
