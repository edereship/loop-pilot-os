import { z } from "zod";
import type { MergeGateVerdict } from "./types.js";

// v4-B Codex 最終判定の出力パーサ（ES-517, spec §3）。
// design-review-parser / verify-parser の雛形を流用: zod verdict スキーマ +
// fenced JSON 抽出 + parse_error フェイルセーフ。
//
// 役割分担: parser は parse_error を返すだけ。パース失敗を pass 扱いにする
// フェイルセーフ解釈は呼び出し側（B4/ES-521）の責務（design review と同じ）。
//
// pass 側の余分な violations キーは zod が黙って落とす（返り値は常に
// { verdict: "pass" }）。fail は非空の violations（各要素も非空）を要求する。
const mergeGateVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("pass") }),
  z.object({
    verdict: z.literal("fail"),
    violations: z.array(z.string().min(1)).min(1),
  }),
]);

export type MergeGateParseResult =
  | { kind: "ok"; value: MergeGateVerdict }
  | { kind: "parse_error"; raw: string };

export function parseMergeGateOutput(text: string): MergeGateParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const candidate of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = mergeGateVerdictSchema.safeParse(parsed);
    if (result.success) return { kind: "ok", value: result.data as MergeGateVerdict };
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
