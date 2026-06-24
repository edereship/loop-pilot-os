import { describe, it, expect } from "vitest";
import { buildMemoryBlock } from "../src/memory-inject.js";

describe("buildMemoryBlock", () => {
  it("returns empty string when no entries", () => {
    expect(buildMemoryBlock([], 6000)).toBe("");
  });

  it("returns empty string when all entries have empty content", () => {
    expect(
      buildMemoryBlock(
        [
          { label: "A", content: "" },
          { label: "B", content: "" },
        ],
        6000,
      ),
    ).toBe("");
  });

  it("builds a single-category block without truncation", () => {
    const result = buildMemoryBlock(
      [{ label: "Implementation Results", content: "task A done" }],
      6000,
    );
    expect(result).toContain("# 横断メモリ");
    expect(result).toContain("## Implementation Results");
    expect(result).toContain("task A done");
    expect(result).not.toContain("省略");
  });

  it("builds a two-category block without truncation", () => {
    const result = buildMemoryBlock(
      [
        { label: "Implementation Results", content: "task A done" },
        { label: "Product Knowledge", content: "domain info" },
      ],
      6000,
    );
    expect(result).toContain("## Implementation Results");
    expect(result).toContain("task A done");
    expect(result).toContain("## Product Knowledge");
    expect(result).toContain("domain info");
  });

  it("truncates each category equally when total exceeds budget", () => {
    const longA = "a".repeat(4000);
    const longB = "b".repeat(4000);
    const result = buildMemoryBlock(
      [
        { label: "A", content: longA },
        { label: "B", content: longB },
      ],
      6000,
    );
    // Structural overhead for two 1-char labels: mainHeader(11) + sep(2) + catHeaders(12) + markers(22) = 47
    // Content budget = 6000 - 47 = 5953; per-category = floor(5953/2) = 2976
    expect(result).toContain("a".repeat(2976));
    expect(result).not.toContain("a".repeat(2977));
    expect(result).toContain("b".repeat(2976));
    expect(result).not.toContain("b".repeat(2977));
    expect(result).toContain("[...省略...]");
    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it("gives full budget to single active category", () => {
    const longContent = "x".repeat(5000);
    const result = buildMemoryBlock(
      [{ label: "A", content: longContent }],
      6000,
    );
    // Structural overhead for one 1-char label: mainHeader(11) + catHeader(6) + marker(11) = 28
    // Content budget = 6000 - 28 = 5972; 5000 fits without truncation
    expect(result).toContain(longContent);
    expect(result).not.toContain("省略");
  });

  it("truncates single category when it exceeds full budget", () => {
    const longContent = "x".repeat(8000);
    const result = buildMemoryBlock(
      [{ label: "A", content: longContent }],
      6000,
    );
    // Structural overhead: mainHeader(11) + catHeader(6) + marker(11) = 28
    // Content budget = 6000 - 28 = 5972
    expect(result).toContain("x".repeat(5972));
    expect(result).not.toContain("x".repeat(5973));
    expect(result).toContain("[...省略...]");
    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it("skips empty entries and distributes budget among active ones", () => {
    const longContent = "y".repeat(5000);
    const result = buildMemoryBlock(
      [
        { label: "A", content: "" },
        { label: "B", content: longContent },
      ],
      6000,
    );
    // Only 1 active category "B" → content budget = 6000 - 28 = 5972 → 5000 fits
    expect(result).not.toContain("## A");
    expect(result).toContain("## B");
    expect(result).toContain(longContent);
    expect(result).not.toContain("省略");
  });

  it("does not truncate when uneven categories together fit within budget (ES-454 Finding 1)", () => {
    const result = buildMemoryBlock(
      [
        { label: "A", content: "a" },
        { label: "B", content: "b".repeat(5900) },
      ],
      6000,
    );
    // overheadWithoutMarkers = mainHeader(11) + sep(2) + catHeaders(12) = 25
    // totalContent = 1 + 5900 = 5901; 25 + 5901 = 5926 ≤ 6000 → no truncation
    expect(result).toContain("a");
    expect(result).toContain("b".repeat(5900));
    expect(result).not.toContain("省略");
    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it("returns empty string when budget is smaller than structural overhead (ES-454 Finding 1)", () => {
    // overhead for two full category labels: mainHeader(11) + sep(2) + catHeaders(27+22) + markers(22) = 84
    // budget of 50 < 84, so the block must be omitted entirely
    const result = buildMemoryBlock(
      [
        { label: "Implementation Results", content: "x" },
        { label: "Product Knowledge", content: "y" },
      ],
      50,
    );
    expect(result).toBe("");
  });

  it("returns empty string when budget exactly equals structural overhead (ES-454 Finding 1)", () => {
    // For one 1-char label: overhead = mainHeader(11) + catHeader(6) + marker(11) = 28
    // With 50 chars of content, the no-truncation path is bypassed (17+50=67 > 28),
    // so we enter the truncation path where contentBudget = 28-28 = 0 → omit block.
    const result = buildMemoryBlock([{ label: "A", content: "x".repeat(50) }], 28);
    expect(result).toBe("");
  });

  it("is deterministic — same inputs produce same output", () => {
    const entries = [
      { label: "A", content: "content-a" },
      { label: "B", content: "content-b" },
    ];
    expect(buildMemoryBlock(entries, 6000)).toBe(buildMemoryBlock(entries, 6000));
  });
});
