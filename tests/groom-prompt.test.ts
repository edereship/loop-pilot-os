import { describe, it, expect } from "vitest";
import { formatBoard, formatBoardWithBudget, buildGroomPrompt } from "../src/groom-prompt.js";
import type { BoardState, BoardTicket, InProgressTicket, DoneTicket, BlockedTicket, GroomPromptArgs } from "../src/types.js";

// ---- Test fixtures ----

function ticket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return { identifier: "ES-501", title: "Add auth", priority: 2, labels: [], ...overrides };
}

function inProgress(overrides: Partial<InProgressTicket> = {}): InProgressTicket {
  return { identifier: "ES-500", title: "Refactor DB", priority: 1, labels: [], status: "in_progress", prNumber: null, ...overrides };
}

function done(overrides: Partial<DoneTicket> = {}): DoneTicket {
  return { identifier: "ES-499", title: "Setup CI", mergedAt: "2026-06-22", ...overrides };
}

function blocked(overrides: Partial<BlockedTicket> = {}): BlockedTicket {
  return { identifier: "ES-498", title: "Deploy infra", blockedBy: "ES-497", ...overrides };
}

function emptyBoard(): BoardState {
  return { eligible: [], inProgress: [], recentDone: [], blocked: [] };
}

function fullBoard(): BoardState {
  return {
    eligible: [
      ticket({ identifier: "ES-501", title: "Add auth", priority: 2, labels: ["feature", "backend"] }),
      ticket({ identifier: "ES-502", title: "Fix bug", priority: 3, labels: [] }),
    ],
    inProgress: [
      inProgress({ identifier: "ES-500", title: "Refactor DB", priority: 1, status: "in_review", prNumber: 42 }),
    ],
    recentDone: [
      done({ identifier: "ES-499", title: "Setup CI", mergedAt: "2026-06-22" }),
    ],
    blocked: [
      blocked({ identifier: "ES-498", title: "Deploy infra", blockedBy: "ES-497" }),
    ],
  };
}

function makeGroomArgs(overrides: Partial<GroomPromptArgs> = {}): GroomPromptArgs {
  return {
    specContent: null,
    goal: "Build a great product",
    memory: { pmDecisions: null, implResults: null, productKnowledge: null },
    board: fullBoard(),
    boardBudgetChars: 10000,
    digest: [],
    codebaseSummary: null,
    optInLabel: "looppilot",
    maxMemoryChars: 8000,
    ...overrides,
  };
}

// ---- formatBoard ----

describe("formatBoard", () => {
  it("formats eligible tickets with identifier, priority, title, labels", () => {
    const board = emptyBoard();
    board.eligible = [
      ticket({ identifier: "ES-501", title: "Add auth", priority: 2, labels: ["feature", "backend"] }),
    ];
    const out = formatBoard(board);
    expect(out).toContain("## 適格（Todo + opt-in）");
    expect(out).toContain("- ES-501 [High] Add auth [labels: feature, backend]");
  });

  it("omits labels bracket when labels array is empty", () => {
    const board = emptyBoard();
    board.eligible = [ticket({ identifier: "ES-502", title: "Fix bug", priority: 3, labels: [] })];
    const out = formatBoard(board);
    expect(out).toContain("- ES-502 [Medium] Fix bug");
    expect(out).not.toContain("[labels:");
  });

  it("formats in-progress tickets with status and PR number", () => {
    const board = emptyBoard();
    board.inProgress = [
      inProgress({ identifier: "ES-500", title: "Refactor DB", priority: 1, status: "in_review", prNumber: 42 }),
    ];
    const out = formatBoard(board);
    expect(out).toContain("## 進行中");
    expect(out).toContain("- ES-500 [Urgent] Refactor DB (in_review, PR #42)");
  });

  it("omits PR part when prNumber is null", () => {
    const board = emptyBoard();
    board.inProgress = [
      inProgress({ identifier: "ES-510", title: "WIP", priority: 2, status: "in_progress", prNumber: null }),
    ];
    const out = formatBoard(board);
    expect(out).toContain("- ES-510 [High] WIP (in_progress)");
    expect(out).not.toContain("PR #");
  });

  it("formats done tickets with merged date", () => {
    const board = emptyBoard();
    board.recentDone = [done({ identifier: "ES-499", title: "Setup CI", mergedAt: "2026-06-22" })];
    const out = formatBoard(board);
    expect(out).toContain("## 直近完了");
    expect(out).toContain("- ES-499 Setup CI (merged, 2026-06-22)");
  });

  it("formats blocked tickets with blocker identifier", () => {
    const board = emptyBoard();
    board.blocked = [blocked({ identifier: "ES-498", title: "Deploy infra", blockedBy: "ES-497" })];
    const out = formatBoard(board);
    expect(out).toContain("## Blocked");
    expect(out).toContain("- ES-498 Deploy infra (blocked by ES-497)");
  });

  it("omits empty sections entirely", () => {
    const board = emptyBoard();
    board.eligible = [ticket()];
    const out = formatBoard(board);
    expect(out).toContain("適格");
    expect(out).not.toContain("進行中");
    expect(out).not.toContain("直近完了");
    expect(out).not.toContain("Blocked");
  });

  it("returns empty string for fully empty board", () => {
    expect(formatBoard(emptyBoard())).toBe("");
  });

  it("formats all four sections in order: eligible → in-progress → done → blocked", () => {
    const out = formatBoard(fullBoard());
    const idxEligible = out.indexOf("適格");
    const idxInProgress = out.indexOf("進行中");
    const idxDone = out.indexOf("直近完了");
    const idxBlocked = out.indexOf("Blocked");
    expect(idxEligible).toBeGreaterThanOrEqual(0);
    expect(idxEligible).toBeLessThan(idxInProgress);
    expect(idxInProgress).toBeLessThan(idxDone);
    expect(idxDone).toBeLessThan(idxBlocked);
  });

  it("is deterministic — same input produces same output", () => {
    const board = fullBoard();
    expect(formatBoard(board)).toBe(formatBoard(board));
  });
});

// ---- formatBoardWithBudget (truncation) ----

describe("formatBoardWithBudget", () => {
  it("returns full board when under budget", () => {
    const board = fullBoard();
    const full = formatBoard(board);
    const result = formatBoardWithBudget(board, full.length + 100);
    expect(result).toBe(full);
  });

  it("truncates done tickets first (oldest first = removed from end)", () => {
    const board: BoardState = {
      eligible: [ticket({ identifier: "ES-1" })],
      inProgress: [],
      recentDone: [
        done({ identifier: "ES-10", title: "Newest", mergedAt: "2026-06-22" }),
        done({ identifier: "ES-11", title: "Middle", mergedAt: "2026-06-21" }),
        done({ identifier: "ES-12", title: "Oldest", mergedAt: "2026-06-20" }),
      ],
      blocked: [blocked({ identifier: "ES-20" })],
    };
    const full = formatBoard(board);
    // Budget that requires removing at least one done
    const tightBudget = full.length - 10;
    const result = formatBoardWithBudget(board, tightBudget);
    // Oldest should be removed first
    expect(result).not.toContain("ES-12");
    // Eligible and blocked should survive
    expect(result).toContain("ES-1");
    expect(result).toContain("ES-20");
  });

  it("truncates blocked after done is exhausted", () => {
    const board: BoardState = {
      eligible: [ticket({ identifier: "ES-1", title: "A", labels: [] })],
      inProgress: [],
      recentDone: [],
      blocked: [
        blocked({ identifier: "ES-20", title: "B1", blockedBy: "ES-19" }),
        blocked({ identifier: "ES-21", title: "B2", blockedBy: "ES-18" }),
      ],
    };
    const full = formatBoard(board);
    const tightBudget = full.length - 10;
    const result = formatBoardWithBudget(board, tightBudget);
    // At least one blocked removed
    expect(result).toContain("ES-1");
    expect(result.length).toBeLessThanOrEqual(tightBudget);
  });

  it("truncates eligible after blocked is exhausted", () => {
    const board: BoardState = {
      eligible: [
        ticket({ identifier: "ES-1", title: "First eligible" }),
        ticket({ identifier: "ES-2", title: "Second eligible" }),
        ticket({ identifier: "ES-3", title: "Third eligible" }),
      ],
      inProgress: [],
      recentDone: [],
      blocked: [],
    };
    const full = formatBoard(board);
    const tightBudget = full.length - 10;
    const result = formatBoardWithBudget(board, tightBudget);
    expect(result.length).toBeLessThanOrEqual(tightBudget);
    // At least one eligible removed from end
    expect(result).not.toContain("ES-3");
  });

  it("never truncates in-progress tickets", () => {
    const board: BoardState = {
      eligible: [],
      inProgress: [
        inProgress({ identifier: "ES-100", title: "Active work A" }),
        inProgress({ identifier: "ES-101", title: "Active work B" }),
      ],
      recentDone: [],
      blocked: [],
    };
    // Very tight budget — but in-progress must survive
    const result = formatBoardWithBudget(board, 10);
    expect(result).toContain("ES-100");
    expect(result).toContain("ES-101");
  });

  it("returns empty string when board is empty regardless of budget", () => {
    expect(formatBoardWithBudget(emptyBoard(), 0)).toBe("");
  });
});

// ---- buildGroomPrompt ----

describe("buildGroomPrompt — all sections", () => {
  it("includes requirements when specContent is provided", () => {
    const args = makeGroomArgs({
      specContent: { requirements: "Build the best product", domainSpecs: [] },
      goal: null,
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("要求（プロダクト要求）");
    expect(out).toContain("Build the best product");
  });

  it("includes goal fallback when specContent is null", () => {
    const args = makeGroomArgs({ specContent: null, goal: "Ship fast" });
    const out = buildGroomPrompt(args);
    expect(out).toContain("プロダクトのゴール");
    expect(out).toContain("Ship fast");
  });

  it("includes domain specs when provided", () => {
    const args = makeGroomArgs({
      specContent: {
        requirements: "Reqs",
        domainSpecs: [{ name: "auth", content: "Auth spec content" }],
      },
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("要件定義");
    expect(out).toContain("## auth");
    expect(out).toContain("Auth spec content");
  });

  it("includes all three memory categories (D-23)", () => {
    const args = makeGroomArgs({
      memory: {
        pmDecisions: "Decision: use Postgres",
        implResults: "Result: auth module done",
        productKnowledge: "Knowledge: users prefer dark mode",
      },
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("横断メモリ");
    expect(out).toContain("PM Decisions");
    expect(out).toContain("Decision: use Postgres");
    expect(out).toContain("Implementation Results");
    expect(out).toContain("Result: auth module done");
    expect(out).toContain("Product Knowledge");
    expect(out).toContain("Knowledge: users prefer dark mode");
  });

  it("includes ticket board section", () => {
    const out = buildGroomPrompt(makeGroomArgs());
    expect(out).toContain("チケット盤面");
    expect(out).toContain("ES-501");
    expect(out).toContain("ES-500");
  });

  it("includes digest when non-empty", () => {
    const args = makeGroomArgs({
      digest: [
        { linearIdentifier: "ES-400", issueTitle: "Done task", agentSummary: "Completed auth" },
      ],
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("直近の実装結果");
    expect(out).toContain("ES-400: Done task — Completed auth");
  });

  it("omits digest section when empty", () => {
    const args = makeGroomArgs({ digest: [] });
    const out = buildGroomPrompt(args);
    expect(out).not.toContain("直近の実装結果");
  });

  it("includes codebase summary when provided", () => {
    const args = makeGroomArgs({ codebaseSummary: "10 files, 2000 lines total" });
    const out = buildGroomPrompt(args);
    expect(out).toContain("コードベースサマリ");
    expect(out).toContain("10 files, 2000 lines total");
  });

  it("omits codebase summary when null", () => {
    const args = makeGroomArgs({ codebaseSummary: null });
    const out = buildGroomPrompt(args);
    expect(out).not.toContain("コードベースサマリ");
  });

  it("includes GROOM instructions with all 7 action types", () => {
    const out = buildGroomPrompt(makeGroomArgs());
    expect(out).toContain("GROOM 指示");
    expect(out).toContain("reprioritize");
    expect(out).toContain("update");
    expect(out).toContain("create");
    expect(out).toContain("split");
    expect(out).toContain("close");
    expect(out).toContain("label");
    expect(out).toContain("update_memory");
  });

  it("includes constraints in GROOM instructions", () => {
    const args = makeGroomArgs({ optInLabel: "looppilot", maxMemoryChars: 8000 });
    const out = buildGroomPrompt(args);
    expect(out).toContain("20");
    expect(out).toContain("5");
    expect(out).toContain('"looppilot"');
    expect(out).toContain("8000");
  });

  it("includes JSON output schema example", () => {
    const out = buildGroomPrompt(makeGroomArgs());
    expect(out).toContain('"actions"');
    expect(out).toContain('"summary"');
    expect(out).toContain("```json");
  });
});

describe("buildGroomPrompt — section order", () => {
  it("sections appear in specified order: requirements → specs → memory → board → digest → codebase → instructions", () => {
    const args = makeGroomArgs({
      specContent: {
        requirements: "REQUIREMENTS_MARKER",
        domainSpecs: [{ name: "spec", content: "SPEC_MARKER" }],
      },
      memory: {
        pmDecisions: "PM_MARKER",
        implResults: "IMPL_MARKER",
        productKnowledge: "KNOWLEDGE_MARKER",
      },
      digest: [{ linearIdentifier: "ES-D", issueTitle: "DIGEST_MARKER", agentSummary: "summary" }],
      codebaseSummary: "CODEBASE_MARKER",
    });
    const out = buildGroomPrompt(args);

    const indices = [
      out.indexOf("REQUIREMENTS_MARKER"),
      out.indexOf("SPEC_MARKER"),
      out.indexOf("PM_MARKER"),
      out.indexOf("チケット盤面"),
      out.indexOf("DIGEST_MARKER"),
      out.indexOf("CODEBASE_MARKER"),
      out.indexOf("GROOM 指示"),
    ];
    for (let i = 0; i < indices.length - 1; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(0);
      expect(indices[i]).toBeLessThan(indices[i + 1]);
    }
  });
});

describe("buildGroomPrompt — empty memory", () => {
  it("assembles prompt even when all memory categories are null", () => {
    const args = makeGroomArgs({
      memory: { pmDecisions: null, implResults: null, productKnowledge: null },
    });
    const out = buildGroomPrompt(args);
    expect(out).not.toContain("# 横断メモリ");
    // Other sections still present
    expect(out).toContain("# チケット盤面");
    expect(out).toContain("GROOM 指示");
  });

  it("includes only populated memory categories", () => {
    const args = makeGroomArgs({
      memory: { pmDecisions: "Some decisions", implResults: null, productKnowledge: null },
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("横断メモリ");
    expect(out).toContain("PM Decisions");
    expect(out).toContain("Some decisions");
    expect(out).not.toContain("Implementation Results");
    expect(out).not.toContain("Product Knowledge");
  });
});

describe("buildGroomPrompt — determinism", () => {
  it("same inputs produce same output", () => {
    const args = makeGroomArgs({
      specContent: { requirements: "R", domainSpecs: [{ name: "s", content: "C" }] },
      memory: { pmDecisions: "D", implResults: "I", productKnowledge: "K" },
      digest: [{ linearIdentifier: "ES-1", issueTitle: "T", agentSummary: "S" }],
      codebaseSummary: "summary",
    });
    expect(buildGroomPrompt(args)).toBe(buildGroomPrompt(args));
  });
});

describe("buildGroomPrompt — edge cases", () => {
  it("works with empty board", () => {
    const args = makeGroomArgs({ board: emptyBoard() });
    const out = buildGroomPrompt(args);
    expect(out).not.toContain("# チケット盤面");
    expect(out).toContain("GROOM 指示");
  });

  it("works with no goal and no specContent", () => {
    const args = makeGroomArgs({ goal: null, specContent: null });
    const out = buildGroomPrompt(args);
    expect(out).not.toContain("要求");
    expect(out).not.toContain("プロダクトのゴール");
    expect(out).toContain("GROOM 指示");
  });
});
