import { z } from "zod";
import type { MergeGateVerdict } from "./types.js";

// v4-B Codex 最終判定の出力パーサ（ES-517, spec §3）。
// design-review-parser / verify-parser の雛形を流用: zod verdict スキーマ +
// fenced JSON 抽出 + parse_error フェイルセーフ。
//
// 抽出ロジックは verify-parser（同じ Codex 裁定器向けに堅牢化済み）を踏襲する。
// マージゲートは唯一かつ不可逆のチョークポイントで、parse_error は呼び出し側で
// pass にフェイルオープンされる（§3）。したがって Codex が実際に fail を返した
// のに抽出漏れで parse_error になると、破壊的変更がそのままマージされてしまう。
// compact な1行 ```json {…}``` や、末尾フェンスがスキーマ不適合でも後続の素の
// JSON を拾える（design-review の早期 return は踏襲しない）ことが要件。
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
  // Accept both multiline and compact single-line fenced blocks:
  //   ```json\n{...}\n```   (standard)
  //   ```json {...} ```     (compact — produced by some judge responses)
  // 末尾の ```json ブロックを最優先で試すが、それがスキーマ不適合でも return せず
  // 後続の素の JSON フォールバックへ落ちる（verify-parser と同流儀）。
  const fencePattern = /```json[ \t]*([\s\S]*?)[ \t]*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastFenceMatch = m[1];
  }
  if (lastFenceMatch !== null) { yield lastFenceMatch.trim(); }

  const lines = text.split("\n");

  // Compact single-line fenced block fallback: when JSON content contains backtick runs the
  // lazy fence regex above terminates early, yielding truncated invalid JSON.  Recover by
  // locating the outermost {} pair on the fence-opening line instead.
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
