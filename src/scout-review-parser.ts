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
// 重複 index は reject が accept より優先される（フェイルクローズ）: accept の後に
// reject が来た場合は reject に差し替える。
function salvage(items: unknown[], candidateCount: number): ScoutReviewParseResult {
  const verdicts: ScoutReviewVerdict[] = [];
  const dropped: string[] = [];
  // Maps candidate index → { position in verdicts[], item-array index }
  const seen = new Map<number, { pos: number; itemIdx: number }>();
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
      const { pos, itemIdx: prevI } = seen.get(v.index)!;
      if (v.verdict === "reject" && verdicts[pos].verdict === "accept") {
        // Reject supersedes earlier accept: fail closed
        dropped.push(`verdict[${prevI}]: duplicate index ${v.index} (accept superseded by reject at verdict[${i}])`);
        verdicts[pos] = v;
        seen.set(v.index, { pos, itemIdx: i });
      } else {
        dropped.push(`verdict[${i}]: duplicate index ${v.index} (reject wins)`);
      }
      continue;
    }
    seen.set(v.index, { pos: verdicts.length, itemIdx: i });
    verdicts.push(v);
  }
  verdicts.sort((a, b) => a.index - b.index);
  return { kind: "ok", verdicts, dropped };
}

// merge-gate-parser の extractJsonCandidates を踏襲（compact 1 行フェンス対応 +
// スキーマ不適合でも素の JSON へフォールバック。design-review の早期 return は
// 踏襲しない）。
// セキュリティ方針: フェンスブロックはレスポンスの最終非空白コンテンツである場合のみ
// 受け入れる（引用された証拠例が最後のフェンスとして誤採用されるのを防ぐ）。素の JSON
// フォールバックも同様に最後の非空白行にあることを要求する。
function* extractJsonCandidates(text: string): Generator<string> {
  const lines = text.split("\n");

  // Find the last complete multiline ```json...``` block using line-by-line scanning.
  // A lazy regex stops early when the JSON content contains backtick runs (e.g. when the
  // judge quotes a code or spec passage inside a reason string), but the closing ``` is only
  // recognised here when it appears alone on a line, so embedded sequences are ignored.
  // Yields only when the closing fence is the final non-whitespace content.
  const openRe = /^[ \t]*```json[ \t]*$/;
  const closeRe = /^[ \t]*```[ \t]*$/;
  let lastFenceContent: string | null = null;
  let lastFenceEndIdx = -1;
  {
    let li = 0;
    while (li < lines.length) {
      if (openRe.test(lines[li])) {
        let found = false;
        for (let cl = li + 1; cl < lines.length; cl++) {
          if (closeRe.test(lines[cl])) {
            lastFenceContent = lines.slice(li + 1, cl).join("\n");
            lastFenceEndIdx = cl;
            li = cl + 1;
            found = true;
            break;
          }
        }
        if (!found) li++;
      } else {
        li++;
      }
    }
  }
  if (lastFenceContent !== null) {
    if (lines.slice(lastFenceEndIdx + 1).every((l) => l.trim().length === 0)) {
      yield lastFenceContent.trim();
    }
  }

  // Compact single-line fenced block fallback: handles ```json {...} ``` on one line.
  // Locates the outermost {} pair on the fence-opening line rather than relying on a regex,
  // so backtick runs inside the JSON do not confuse it.
  // Only yield when this compact fence is the final non-whitespace content (same guard as
  // the multiline path above and the bare-JSON paths below).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("```json")) {
      const afterMarker = line.slice("```json".length).trimStart();
      const jsonStart = afterMarker.indexOf("{");
      const jsonEnd = afterMarker.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        if (lines.slice(i + 1).every((l) => l.trim().length === 0)) {
          yield afterMarker.slice(jsonStart, jsonEnd + 1);
        }
      }
      break;
    }
  }

  // Bare JSON fallbacks: only accept if the JSON is the final non-whitespace content.
  // This prevents picking up quoted JSON that appears in prose before the model's conclusion.
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim().length === 0) lastNonEmpty--;

  if (lastNonEmpty >= 0) {
    const lastLine = lines[lastNonEmpty].trim();
    if (lastLine.startsWith("{") && lastLine.endsWith("}")) {
      yield lastLine;
    }
  }

  if (lastNonEmpty >= 0 && lines[lastNonEmpty].trimEnd().endsWith("}")) {
    for (let startLine = lastNonEmpty; startLine >= 0; startLine--) {
      if (lines[startLine].trimStart().startsWith("{")) {
        yield lines.slice(startLine, lastNonEmpty + 1).join("\n");
      }
    }
  }
}
