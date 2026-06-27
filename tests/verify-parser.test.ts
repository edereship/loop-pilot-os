import { describe, it, expect } from "vitest";
import { parseVerifyOutput } from "../src/verify-parser.js";

describe("parseVerifyOutput", () => {
  it("parses pass verdict from fenced JSON block", () => {
    const input = `Here is my judgment:\n\n\`\`\`json\n{"verdict":"pass","reasons":[]}\n\`\`\``;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass", reasons: [] } });
  });

  it("parses fail verdict with reasons", () => {
    const input = `\`\`\`json\n{"verdict":"fail","reasons":["Tests failing","Missing validation"]}\n\`\`\``;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "fail", reasons: ["Tests failing", "Missing validation"] },
    });
  });

  it("parses single-line raw JSON", () => {
    const input = `{"verdict":"pass","reasons":[]}`;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass", reasons: [] } });
  });

  it("parses multi-line unfenced JSON", () => {
    const input = `Judgment complete.\n{\n  "verdict": "fail",\n  "reasons": ["Build red"]\n}`;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "fail", reasons: ["Build red"] } });
  });

  it("returns parse_error for empty input", () => {
    expect(parseVerifyOutput("")).toEqual({ kind: "parse_error", raw: "" });
  });

  it("returns parse_error for invalid verdict value", () => {
    const input = `{"verdict":"maybe","reasons":[]}`;
    const result = parseVerifyOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for missing reasons field", () => {
    const input = `{"verdict":"pass"}`;
    const result = parseVerifyOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for fail verdict with empty reasons array", () => {
    const input = `{"verdict":"fail","reasons":[]}`;
    const result = parseVerifyOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for fail verdict with all-empty reason strings", () => {
    const input = `{"verdict":"fail","reasons":[""]}`;
    const result = parseVerifyOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("accepts pass verdict with empty reasons array", () => {
    const input = `{"verdict":"pass","reasons":[]}`;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass", reasons: [] } });
  });

  it("prefers last fenced block when multiple exist", () => {
    const input = [
      "```json",
      '{"verdict":"fail","reasons":["old"]}',
      "```",
      "Actually:",
      "```json",
      '{"verdict":"pass","reasons":[]}',
      "```",
    ].join("\n");
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass", reasons: [] } });
  });

  it("accepts pass verdict with non-empty reasons (lenient)", () => {
    const input = `{"verdict":"pass","reasons":["FYI: minor warning"]}`;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "pass", reasons: ["FYI: minor warning"] },
    });
  });

  it("ignores extra fields in the JSON", () => {
    const input = `{"verdict":"pass","reasons":[],"confidence":0.95}`;
    const result = parseVerifyOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass", reasons: [] } });
  });

  it("parses compact single-line fenced JSON (no newline after json tag)", () => {
    const input = '```json {"verdict":"fail","reasons":["tests fail"]} ```';
    const result = parseVerifyOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "fail", reasons: ["tests fail"] },
    });
  });

  it("falls back to brace extraction when fenced reasons contain triple backticks", () => {
    // The ``` inside reasons causes the fence regex to close early on that sequence;
    // brace-based extraction should recover the full valid JSON line.
    const input = [
      "```json",
      '{"verdict":"fail","reasons":["see ``` fence in diff"]}',
      "```",
    ].join("\n");
    const result = parseVerifyOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "fail", reasons: ["see ``` fence in diff"] },
    });
  });
});
