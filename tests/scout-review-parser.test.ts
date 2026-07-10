import { describe, it, expect } from "vitest";
import { parseScoutReviewOutput } from "../src/scout-review-parser.js";

describe("parseScoutReviewOutput", () => {
  // ---- 抽出マトリクス（merge-gate-parser のテスト構成を踏襲） ----

  it("parses mixed accept/reject verdicts from a fenced JSON block and sorts by index", () => {
    const input = [
      "My analysis of the candidates:",
      "",
      "```json",
      '{"verdicts": [',
      '  {"index": 1, "verdict": "reject", "reasons": ["duplicate of ES-10"]},',
      '  {"index": 0, "verdict": "accept", "reasons": []}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 2);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [
        { index: 0, verdict: "accept", reasons: [] },
        { index: 1, verdict: "reject", reasons: ["duplicate of ES-10"] },
      ],
      dropped: [],
    });
  });

  it("uses the LAST fenced JSON block when several are present", () => {
    const input = [
      "```json",
      '{"verdicts": [{"index": 0, "verdict": "reject", "reasons": ["draft"]}]}',
      "```",
      "Wait, on closer inspection:",
      "```json",
      '{"verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]}',
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("parses a compact single-line fenced block", () => {
    const input = '```json {"verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]} ```';
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("parses a bare single-line JSON object without a fence", () => {
    const input = 'Verdict follows.\n{"verdicts": [{"index": 0, "verdict": "reject", "reasons": ["not reproducible"]}]}';
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "reject", reasons: ["not reproducible"] }],
      dropped: [],
    });
  });

  it("parses a bare multi-line JSON object at the end of prose", () => {
    const input = [
      "Judged all candidates.",
      "{",
      '  "verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]',
      "}",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("falls through to a bare JSON object when the fenced block does not match the schema", () => {
    // design-review-parser の「フェンスがあれば即 return」は踏襲しない（merge-gate と同流儀）
    const input = [
      "```json",
      '{"note": "this fence is not a verdict object"}',
      "```",
      '{"verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]}',
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("returns parse_error for empty input", () => {
    const result = parseScoutReviewOutput("", 2);
    expect(result).toEqual({ kind: "parse_error", raw: "" });
  });

  it("returns parse_error when no JSON is present", () => {
    const input = "I could not produce a structured verdict.";
    const result = parseScoutReviewOutput(input, 2);
    expect(result).toEqual({ kind: "parse_error", raw: input });
  });

  it("returns parse_error when verdicts is not an array", () => {
    const input = '{"verdicts": "accept all"}';
    const result = parseScoutReviewOutput(input, 2);
    expect(result).toEqual({ kind: "parse_error", raw: input });
  });

  // ---- バッチ固有系（サルベージ + index 突き合わせ） ----

  it("drops a reject entry with empty reasons and keeps the diagnostics", () => {
    const input = [
      "```json",
      '{"verdicts": [',
      '  {"index": 0, "verdict": "reject", "reasons": []},',
      '  {"index": 1, "verdict": "accept", "reasons": []}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 2);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([{ index: 1, verdict: "accept", reasons: [] }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("verdict[0]");
  });

  it("drops a reject entry whose reasons contain an empty string", () => {
    const input = '{"verdicts": [{"index": 0, "verdict": "reject", "reasons": [""]}]}';
    const result = parseScoutReviewOutput(input, 1);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops entries whose index is out of range", () => {
    const input = [
      "```json",
      '{"verdicts": [',
      '  {"index": 0, "verdict": "accept", "reasons": []},',
      '  {"index": 3, "verdict": "accept", "reasons": []}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 2);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([{ index: 0, verdict: "accept", reasons: [] }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("out of range");
  });

  it("keeps the first entry and drops later ones when an index is duplicated", () => {
    const input = [
      "```json",
      '{"verdicts": [',
      '  {"index": 0, "verdict": "reject", "reasons": ["dup of candidate 1"]},',
      '  {"index": 0, "verdict": "accept", "reasons": []}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([{ index: 0, verdict: "reject", reasons: ["dup of candidate 1"] }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("duplicate index 0");
  });

  it("prefers reject over accept when a duplicate index has accept first then reject (fail-closed)", () => {
    const input = [
      "```json",
      '{"verdicts": [',
      '  {"index": 0, "verdict": "accept", "reasons": []},',
      '  {"index": 0, "verdict": "reject", "reasons": ["reconsidered: not reproducible"]}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([{ index: 0, verdict: "reject", reasons: ["reconsidered: not reproducible"] }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("duplicate index 0");
  });

  it("tolerates missing indices (unverified candidates are the caller's concern)", () => {
    const input = '{"verdicts": [{"index": 2, "verdict": "accept", "reasons": []}]}';
    const result = parseScoutReviewOutput(input, 3);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 2, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("drops non-integer and negative indices", () => {
    const input = [
      "```json",
      '{"verdicts": [',
      '  {"index": 0.5, "verdict": "accept", "reasons": []},',
      '  {"index": -1, "verdict": "accept", "reasons": []}',
      "]}",
      "```",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 2);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([]);
    expect(result.dropped).toHaveLength(2);
  });

  it("returns ok with empty verdicts when every entry is invalid (caller skips all filing)", () => {
    const input = '{"verdicts": [{"verdict": "accept"}, {"index": 0}]}';
    const result = parseScoutReviewOutput(input, 2);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.verdicts).toEqual([]);
    expect(result.dropped).toHaveLength(2);
  });

  it("keeps extra reasons on an accept verdict", () => {
    const input = '{"verdicts": [{"index": 0, "verdict": "accept", "reasons": ["evidence verified locally"]}]}';
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: ["evidence verified locally"] }],
      dropped: [],
    });
  });

  it("accepts an empty verdicts array when candidateCount is 0", () => {
    const result = parseScoutReviewOutput('{"verdicts": []}', 0);
    expect(result).toEqual({ kind: "ok", verdicts: [], dropped: [] });
  });

  it("defaults missing reasons to [] on accept", () => {
    const input = '{"verdicts": [{"index": 0, "verdict": "accept"}]}';
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({
      kind: "ok",
      verdicts: [{ index: 0, verdict: "accept", reasons: [] }],
      dropped: [],
    });
  });

  it("returns parse_error when a bare JSON object is not the final non-whitespace content", () => {
    // The JSON appears before concluding prose; the model explained it could not judge.
    const input = [
      '{"verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]}',
      "",
      "I could not produce a structured verdict for all candidates.",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    expect(result).toEqual({ kind: "parse_error", raw: input });
  });

  it("returns parse_error when the last fenced block is not the final non-whitespace content", () => {
    // A quoted example follows the real verdict block; the quoted accept should not win.
    const input = [
      "```json",
      '{"verdicts": [{"index": 0, "verdict": "reject", "reasons": ["not reproducible"]}]}',
      "```",
      "",
      "For reference, an accepted candidate would look like:",
      "```json",
      '{"verdicts": [{"index": 0, "verdict": "accept", "reasons": []}]}',
      "```",
      "",
      "The above is just an example, not my verdict.",
    ].join("\n");
    const result = parseScoutReviewOutput(input, 1);
    // Neither fenced block is the final content; no bare JSON either → parse_error.
    expect(result).toEqual({ kind: "parse_error", raw: input });
  });
});
