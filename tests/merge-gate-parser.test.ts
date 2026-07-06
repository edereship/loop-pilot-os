import { describe, it, expect } from "vitest";
import { parseMergeGateOutput } from "../src/merge-gate-parser.js";

describe("parseMergeGateOutput", () => {
  it("parses pass verdict from fenced JSON block", () => {
    const input = `Here is my judgment:\n\n\`\`\`json\n{"verdict":"pass","violations":[]}\n\`\`\``;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });

  it("parses pass verdict with the violations key absent", () => {
    const input = `\`\`\`json\n{"verdict":"pass"}\n\`\`\``;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });

  it("strips a stray violations array from a pass verdict", () => {
    // A pass verdict should never carry violations in the returned value.
    const input = `{"verdict":"pass","violations":["ignored"]}`;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });

  it("parses fail verdict with violations", () => {
    const input = `\`\`\`json\n{"verdict":"fail","violations":["Deleted public export foo()","Removed acceptance test"]}\n\`\`\``;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: {
        verdict: "fail",
        violations: ["Deleted public export foo()", "Removed acceptance test"],
      },
    });
  });

  it("parses single-line raw JSON", () => {
    const input = `{"verdict":"pass","violations":[]}`;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });

  it("parses multi-line unfenced JSON", () => {
    const input = `Done.\n{\n  "verdict": "fail",\n  "violations": ["Config schema changed without spec support"]\n}`;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "fail", violations: ["Config schema changed without spec support"] },
    });
  });

  it("returns parse_error for empty input", () => {
    expect(parseMergeGateOutput("")).toEqual({ kind: "parse_error", raw: "" });
  });

  it("returns parse_error for whitespace-only input", () => {
    expect(parseMergeGateOutput("   \n\t ")).toEqual({ kind: "parse_error", raw: "   \n\t " });
  });

  it("returns parse_error for invalid verdict value", () => {
    const result = parseMergeGateOutput(`{"verdict":"maybe","violations":[]}`);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for missing verdict field", () => {
    const result = parseMergeGateOutput(`{"violations":[]}`);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for fail verdict with empty violations array", () => {
    const result = parseMergeGateOutput(`{"verdict":"fail","violations":[]}`);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for fail verdict with missing violations field", () => {
    const result = parseMergeGateOutput(`{"verdict":"fail"}`);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for fail verdict with all-empty violation strings", () => {
    const result = parseMergeGateOutput(`{"verdict":"fail","violations":[""]}`);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for non-JSON prose", () => {
    const result = parseMergeGateOutput("The diff looks fine to me, no issues.");
    expect(result.kind).toBe("parse_error");
  });

  it("parses a compact single-line fenced block (Codex judge form)", () => {
    // Codex sometimes emits the JSON on the same line as the ```json marker.
    // The un-hardened design-review extraction would miss this → parse_error →
    // caller fail-opens → a real fail silently merges. Must be recovered.
    const input = `\`\`\`json {"verdict":"fail","violations":["Removed public export"]}\`\`\``;
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "fail", violations: ["Removed public export"] },
    });
  });

  it("falls through to a valid bare object when the last fenced block is schema-invalid", () => {
    // No early return: a fenced block that fails schema validation must not
    // suppress a valid trailing bare object.
    const input = [
      "```json",
      '{"verdict":"fail","violations":[]}',
      "```",
      "Correction:",
      '{"verdict":"pass"}',
    ].join("\n");
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });

  it("prefers the last fenced block when multiple exist", () => {
    const input = [
      "```json",
      '{"verdict":"fail","violations":["old"]}',
      "```",
      "On reflection:",
      "```json",
      '{"verdict":"pass","violations":[]}',
      "```",
    ].join("\n");
    const result = parseMergeGateOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "pass" } });
  });
});
