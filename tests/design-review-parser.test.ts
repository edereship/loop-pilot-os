import { describe, it, expect } from "vitest";
import { parseDesignReviewOutput } from "../src/design-review-parser.js";

describe("parseDesignReviewOutput", () => {
  it("parses approve verdict from fenced JSON block", () => {
    const input = `Here is my review:\n\n\`\`\`json\n{"verdict":"approve","reasons":[]}\n\`\`\``;
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "approve", reasons: [] } });
  });

  it("parses reject verdict with reasons", () => {
    const input = `\`\`\`json\n{"verdict":"reject","reasons":["Missing error handling","Scope too broad"]}\n\`\`\``;
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({
      kind: "ok",
      value: { verdict: "reject", reasons: ["Missing error handling", "Scope too broad"] },
    });
  });

  it("parses single-line raw JSON", () => {
    const input = `{"verdict":"approve","reasons":[]}`;
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "approve", reasons: [] } });
  });

  it("parses multi-line unfenced JSON", () => {
    const input = `Review complete.\n{\n  "verdict": "reject",\n  "reasons": ["Bad"]\n}`;
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "reject", reasons: ["Bad"] } });
  });

  it("returns parse_error for empty input", () => {
    expect(parseDesignReviewOutput("")).toEqual({ kind: "parse_error", raw: "" });
  });

  it("returns parse_error for invalid verdict value", () => {
    const input = `{"verdict":"maybe","reasons":[]}`;
    const result = parseDesignReviewOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for missing reasons field", () => {
    const input = `{"verdict":"approve"}`;
    const result = parseDesignReviewOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for reject verdict with empty reasons array", () => {
    const input = `{"verdict":"reject","reasons":[]}`;
    const result = parseDesignReviewOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for reject verdict with all-empty reason strings", () => {
    const input = `{"verdict":"reject","reasons":[""]}`;
    const result = parseDesignReviewOutput(input);
    expect(result.kind).toBe("parse_error");
  });

  it("still accepts approve verdict with empty reasons array", () => {
    const input = `{"verdict":"approve","reasons":[]}`;
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "approve", reasons: [] } });
  });

  it("prefers last fenced block when multiple exist", () => {
    const input = [
      "```json",
      '{"verdict":"reject","reasons":["old"]}',
      "```",
      "Actually:",
      "```json",
      '{"verdict":"approve","reasons":[]}',
      "```",
    ].join("\n");
    const result = parseDesignReviewOutput(input);
    expect(result).toEqual({ kind: "ok", value: { verdict: "approve", reasons: [] } });
  });
});
