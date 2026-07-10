import { z } from "zod";

// v4-A Stage 2 Codex 検証の出力パーサ（ES-520, spec 2026-07-10 §2）。
// merge-gate-parser（verify-parser 系の堅牢 JSON 抽出）+ scout-parser（候補単位
// サルベージ）の雛形を流用。
//
// バッチ裁定: 全候補を 1 回の Codex 呼び出しで裁定し、verdicts[] の index で候補と
// 突き合わせる。欠落 index はエラーにしない — verdict が得られなかった候補は
// 呼び出し側（ES-522）が「未検証 = 起票しない」と扱う（候補単位フェイルクローズ）。
// 全体がパース不能なら parse_error — 呼び出し側は起票を全スキップする（spec D3）。
// したがって accept の取り逃しは安全側（起票されないだけ）、偽 accept のみが
// 自走キュー汚染につながる。スキーマは positive accept を明示要求する。

export interface ScoutReviewVerdict {
  index: number;                 // 候補配列の添字（0 始まり）
  verdict: "accept" | "reject";
  reasons: string[];             // reject 時は非空（各要素も非空）。accept は任意
}

const verdictEntrySchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(["accept", "reject"]),
  reasons: z.array(z.string()).default([]),
}).refine(
  (v) => v.verdict !== "reject" || (v.reasons.length > 0 && v.reasons.every((r) => r.length > 0)),
  { message: "reject requires non-empty reasons" },
);

const reviewOutputSchema = z.object({
  verdicts: z.array(z.unknown()),
});

export type ScoutReviewParseResult =
  | { kind: "ok"; verdicts: ScoutReviewVerdict[]; dropped: string[] }
  | { kind: "parse_error"; raw: string };

export function parseScoutReviewOutput(text: string, candidateCount: number): ScoutReviewParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "parse_error", raw: text };

  for (const jsonText of extractJsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }
    const top = reviewOutputSchema.safeParse(parsed);
    if (!top.success) continue;
    return salvage(top.data.verdicts, candidateCount);
  }

  return { kind: "parse_error", raw: text };
}

// scout-parser の salvage と同流儀: エントリ単位で検証し、不正なものは dropped に
// 診断を残して除外する。1 エントリの不備で他候補の verdict まで失わない。
function salvage(items: unknown[], candidateCount: number): ScoutReviewParseResult {
  const verdicts: ScoutReviewVerdict[] = [];
  const dropped: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const res = verdictEntrySchema.safeParse(items[i]);
    if (!res.success) {
      const reasons = res.error.issues
        .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
        .join("; ");
      dropped.push(`verdict[${i}]: ${reasons}`);
      continue;
    }
    const v = res.data;
    if (v.index >= candidateCount) {
      dropped.push(`verdict[${i}]: index ${v.index} out of range (candidateCount=${candidateCount})`);
      continue;
    }
    if (seen.has(v.index)) {
      dropped.push(`verdict[${i}]: duplicate index ${v.index} (first occurrence wins)`);
      continue;
    }
    seen.add(v.index);
    verdicts.push(v);
  }
  verdicts.sort((a, b) => a.index - b.index);
  return { kind: "ok", verdicts, dropped };
}

// merge-gate-parser の extractJsonCandidates を踏襲（compact 1 行フェンス対応 +
// スキーマ不適合でも素の JSON へフォールバック。design-review の早期 return は
// 踏襲しない）。
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
