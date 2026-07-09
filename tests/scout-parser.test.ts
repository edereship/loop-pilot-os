import { describe, it, expect } from "vitest";
import { parseScoutOutput, TITLE_MAX, MAX_CANDIDATES } from "../src/scout-parser.js";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "sum() returns NaN for empty array",
    description: "src/math.js sum([]) returns NaN but spec requires 0.",
    evidence: "npm test output:\nFAIL sum > empty array\nExpected: 0, Received: NaN",
    evidence_type: "objective",
    priority: 2,
    ...overrides,
  };
}

function fenced(candidates: unknown[]): string {
  return "Exploration done.\n\n```json\n" + JSON.stringify({ candidates }) + "\n```";
}

describe("parseScoutOutput", () => {
  it("parses a fenced json block with one valid candidate", () => {
    const result = parseScoutOutput(fenced([candidate()]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].evidence_type).toBe("objective");
      expect(result.dropped).toEqual([]);
    }
  });

  it("parses bare JSON on the last line", () => {
    const text = "done\n" + JSON.stringify({ candidates: [candidate()] });
    const result = parseScoutOutput(text);
    expect(result.kind).toBe("ok");
  });

  it("accepts an empty candidates array", () => {
    const result = parseScoutOutput(fenced([]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.candidates).toEqual([]);
  });

  it("drops a candidate with empty evidence but keeps valid ones (G-A1)", () => {
    const result = parseScoutOutput(fenced([candidate({ evidence: "  " }), candidate()]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0]).toContain("candidate[0]");
      expect(result.dropped[0]).toContain("evidence");
    }
  });

  it("drops candidates with out-of-range or non-integer priority", () => {
    const result = parseScoutOutput(
      fenced([candidate({ priority: 0 }), candidate({ priority: 5 }), candidate({ priority: 2.5 }), candidate()]),
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.dropped).toHaveLength(3);
    }
  });

  it("drops a candidate with an unknown evidence_type", () => {
    const result = parseScoutOutput(fenced([candidate({ evidence_type: "hunch" })]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toEqual([]);
      expect(result.dropped).toHaveLength(1);
    }
  });

  it("truncates an over-long title instead of dropping the candidate", () => {
    const longTitle = "x".repeat(TITLE_MAX + 100);
    const result = parseScoutOutput(fenced([candidate({ title: longTitle })]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].title).toHaveLength(TITLE_MAX);
    }
  });

  it("caps at MAX_CANDIDATES applied to VALID candidates (invalid ones do not consume slots)", () => {
    const items = [candidate({ evidence: "" }), ...Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => candidate({ title: `bug ${i}` }))];
    const result = parseScoutOutput(fenced(items));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(MAX_CANDIDATES);
      expect(result.candidates[0].title).toBe("bug 0");
      expect(result.dropped.some((d) => d.includes("MAX_CANDIDATES"))).toBe(true);
    }
  });

  it("returns parse_error for empty text", () => {
    expect(parseScoutOutput("").kind).toBe("parse_error");
    expect(parseScoutOutput("   \n ").kind).toBe("parse_error");
  });

  it("returns parse_error when no JSON is present", () => {
    const result = parseScoutOutput("I explored the repo and found nothing interesting.");
    expect(result.kind).toBe("parse_error");
    if (result.kind === "parse_error") expect(result.raw).toContain("explored");
  });

  it("returns parse_error when top-level lacks a candidates array", () => {
    expect(parseScoutOutput('```json\n{"findings": []}\n```').kind).toBe("parse_error");
  });

  it("parses a compact single-line fenced block (no newline after opening fence)", () => {
    const text = '```json {"candidates":[' + JSON.stringify(candidate()) + "]} ```";
    const result = parseScoutOutput(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].title).toBe("sum() returns NaN for empty array");
    }
  });

  it("drops a candidate whose title is the placeholder '...' from the schema example", () => {
    const result = parseScoutOutput(fenced([candidate({ title: "..." }), candidate()]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0]).toContain("candidate[0]");
    }
  });

  it("drops candidates whose description or evidence is the placeholder '...'", () => {
    const result = parseScoutOutput(fenced([
      candidate({ description: "..." }),
      candidate({ evidence: "..." }),
      candidate(),
    ]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.candidates).toHaveLength(1);
      expect(result.dropped).toHaveLength(2);
    }
  });
});
