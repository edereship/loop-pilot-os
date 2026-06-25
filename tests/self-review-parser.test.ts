import { describe, it, expect } from "vitest";
import { parseSelfReviewOutput } from "../src/self-review-parser.js";

describe("parseSelfReviewOutput", () => {
  it("parses a pass verdict from a fenced json block", () => {
    const text = 'Some analysis\n\n```json\n{"verdict":"pass","issues":[],"summary":"All good."}\n```';
    const result = parseSelfReviewOutput(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.verdict).toBe("pass");
      expect(result.value.issues).toEqual([]);
      expect(result.value.summary).toBe("All good.");
    }
  });

  it("parses a fail verdict with issues", () => {
    const text = '```json\n{"verdict":"fail","issues":["Missing test for edge case"],"summary":"Incomplete."}\n```';
    const result = parseSelfReviewOutput(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.verdict).toBe("fail");
      expect(result.value.issues).toEqual(["Missing test for edge case"]);
    }
  });

  it("returns parse_error for empty text", () => {
    expect(parseSelfReviewOutput("").kind).toBe("parse_error");
  });

  it("returns parse_error for invalid JSON", () => {
    expect(parseSelfReviewOutput("no json here").kind).toBe("parse_error");
  });

  it("returns parse_error for wrong schema (missing verdict)", () => {
    const text = '```json\n{"issues":[]}\n```';
    expect(parseSelfReviewOutput(text).kind).toBe("parse_error");
  });

  it("parses bare JSON on the last line", () => {
    const text = 'Analysis done.\n{"verdict":"pass","issues":[],"summary":"OK."}';
    const result = parseSelfReviewOutput(text);
    expect(result.kind).toBe("ok");
  });

  it("uses the last fenced block when multiple exist", () => {
    const text = '```json\n{"verdict":"fail","issues":["x"],"summary":"bad"}\n```\n\nRevised:\n```json\n{"verdict":"pass","issues":[],"summary":"fixed"}\n```';
    const result = parseSelfReviewOutput(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.verdict).toBe("pass");
    }
  });
});
