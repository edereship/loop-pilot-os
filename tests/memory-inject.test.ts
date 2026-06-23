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
    // Per-category budget = 3000. Both should be truncated.
    expect(result).toContain("a".repeat(3000));
    expect(result).not.toContain("a".repeat(3001));
    expect(result).toContain("b".repeat(3000));
    expect(result).not.toContain("b".repeat(3001));
    expect(result).toContain("[...省略...]");
  });

  it("gives full budget to single active category", () => {
    const longContent = "x".repeat(5000);
    const result = buildMemoryBlock(
      [{ label: "A", content: longContent }],
      6000,
    );
    // Single category gets entire 6000 budget — 5000 fits without truncation
    expect(result).toContain(longContent);
    expect(result).not.toContain("省略");
  });

  it("truncates single category when it exceeds full budget", () => {
    const longContent = "x".repeat(8000);
    const result = buildMemoryBlock(
      [{ label: "A", content: longContent }],
      6000,
    );
    expect(result).toContain("x".repeat(6000));
    expect(result).not.toContain("x".repeat(6001));
    expect(result).toContain("[...省略...]");
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
    // Only 1 active category → gets full 6000 budget → 5000 fits
    expect(result).not.toContain("## A");
    expect(result).toContain("## B");
    expect(result).toContain(longContent);
    expect(result).not.toContain("省略");
  });

  it("is deterministic — same inputs produce same output", () => {
    const entries = [
      { label: "A", content: "content-a" },
      { label: "B", content: "content-b" },
    ];
    expect(buildMemoryBlock(entries, 6000)).toBe(buildMemoryBlock(entries, 6000));
  });
});
