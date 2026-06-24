import { describe, it, expect } from "vitest";
import { validateGroomActions } from "../src/groom-validator.js";
import type { GroomAction } from "../src/types.js";
import type { ValidationContext } from "../src/groom-validator.js";

function makeCtx(overrides?: Partial<ValidationContext>): ValidationContext {
  return {
    projectIssueIds: new Set(["ES-1", "ES-2", "ES-3", "ES-4", "ES-5"]),
    allIssueIds: new Set(["ES-1", "ES-2", "ES-3", "ES-4", "ES-5", "OTHER-1"]),
    optInLabel: "looppilot",
    optInIssueIds: new Set(["ES-1", "ES-2", "ES-3", "ES-4", "ES-5"]),
    doneIssueIds: new Set(["ES-5"]),
    maxCharsPerFile: 8000,
    knownLabels: ["bug", "urgent", "looppilot"],
    ...overrides,
  };
}

function action(type: string, extra: Record<string, unknown> = {}): GroomAction {
  const base = { rationale: "test" };
  switch (type) {
    case "reprioritize":
      return { type: "reprioritize", issueId: "ES-1", priority: 2, ...base, ...extra } as GroomAction;
    case "update":
      return { type: "update", issueId: "ES-1", title: "Updated", ...base, ...extra } as GroomAction;
    case "create":
      return { type: "create", title: "New", description: "desc", priority: 3, ...base, ...extra } as GroomAction;
    case "split":
      return { type: "split", issueId: "ES-1", subtasks: [{ title: "a", description: "b" }], ...base, ...extra } as GroomAction;
    case "close":
      return { type: "close", issueId: "ES-1", ...base, ...extra } as GroomAction;
    case "label":
      return { type: "label", issueId: "ES-1", add: ["bug"], ...base, ...extra } as GroomAction;
    case "update_memory":
      return { type: "update_memory", category: "pm_decisions", content: "note", ...base, ...extra } as GroomAction;
    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

describe("validateGroomActions", () => {
  // ---- Rule 1: scope check ----
  describe("Rule 1: out-of-scope issue", () => {
    it("rejects action on issue not in project scope", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "OTHER-1" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("scope");
    });

    it("accepts action on in-scope issue", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "ES-1" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });
  });

  // ---- Rule 2: existence check ----
  describe("Rule 2: non-existent issue", () => {
    it("rejects action on unknown issue ID", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "FAKE-99" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("exist");
    });
  });

  // ---- Rule 1b: opt-in label required ----
  describe("Rule 1b: opt-in label required for issue-scoped actions", () => {
    it("rejects action on in-scope issue without opt-in label", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "ES-1" })],
        makeCtx({ optInIssueIds: new Set() }),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("opt-in");
    });

    it("accepts action on in-scope issue with opt-in label", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "ES-1" })],
        makeCtx({ optInIssueIds: new Set(["ES-1"]) }),
      );
      expect(results[0].result).toBe("valid");
    });

    it("create and update_memory skip opt-in check (no issueId)", () => {
      const results = validateGroomActions(
        [action("create"), action("update_memory")],
        makeCtx({ optInIssueIds: new Set() }),
      );
      expect(results.every((r) => r.result === "valid")).toBe(true);
    });
  });

  // ---- Rule 3: opt-in label removal ----
  describe("Rule 3: opt-in label removal forbidden", () => {
    it("rejects label action that removes the opt-in label", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", remove: ["looppilot"], add: [] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("opt-in");
    });

    it("accepts label action that removes a different (known) label", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", remove: ["urgent"], add: [] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("accepts label action with no remove field", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", add: ["urgent"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("rejects label with add=undefined that removes only the opt-in label", () => {
      const results = validateGroomActions(
        [{ type: "label" as const, issueId: "ES-1", remove: ["looppilot"], rationale: "test" }],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("opt-in");
    });
  });

  // ---- Rule 4: done issue protection ----
  describe("Rule 4: done issue protection", () => {
    it("rejects non-close action on done issue", () => {
      const results = validateGroomActions(
        [action("reprioritize", { issueId: "ES-5" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("Done");
    });

    it("rejects split on done issue", () => {
      const results = validateGroomActions(
        [action("split", { issueId: "ES-5" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("Done");
    });

    it("allows close action on done issue", () => {
      const results = validateGroomActions(
        [action("close", { issueId: "ES-5" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });
  });

  // ---- Rule 5: create limit ----
  describe("Rule 5: create limit (max 5)", () => {
    it("accepts up to 5 create actions", () => {
      const actions = Array.from({ length: 5 }, () => action("create"));
      const results = validateGroomActions(actions, makeCtx());
      expect(results.every((r) => r.result === "valid")).toBe(true);
    });

    it("rejects create actions beyond the 5th", () => {
      const actions = Array.from({ length: 7 }, () => action("create"));
      const results = validateGroomActions(actions, makeCtx());
      expect(results.filter((r) => r.result === "valid")).toHaveLength(5);
      expect(results.filter((r) => r.result === "rejected")).toHaveLength(2);
      // First 5 valid, last 2 rejected
      expect(results[4].result).toBe("valid");
      expect(results[5].result).toBe("rejected");
      expect(results[5].reason).toContain("create");
    });

    it("a Rule-7 rejected create still consumes a create slot", () => {
      // 4 valid creates, then 1 empty-title create (rejected by Rule 7 but
      // consumes slot 5), then 1 valid create (rejected by Rule 5 as slot 6).
      const actions = [
        ...Array.from({ length: 4 }, () => action("create")),
        action("create", { title: "" }),  // slot 5: rejected by Rule 7
        action("create"),                  // slot 6: rejected by Rule 5
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results.slice(0, 4).every((r) => r.result === "valid")).toBe(true);
      expect(results[4].result).toBe("rejected");
      expect(results[4].reason).toContain("empty");
      expect(results[5].result).toBe("rejected");
      expect(results[5].reason).toContain("create");
    });

    it("split with 6 subtasks is rejected because it exceeds MAX_CREATES (ES-457 Finding 2)", () => {
      const subtasks = Array.from({ length: 6 }, (_, i) => ({ title: `Sub ${i}`, description: `Desc ${i}` }));
      const results = validateGroomActions(
        [action("split", { subtasks })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("create");
    });

    it("split with 3 subtasks is accepted when no prior creates have run", () => {
      const subtasks = Array.from({ length: 3 }, (_, i) => ({ title: `Sub ${i}`, description: `Desc ${i}` }));
      const results = validateGroomActions(
        [action("split", { subtasks })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("split subtasks count against the shared create budget with explicit creates", () => {
      // 3 creates (slots 1-3), then a split with 3 subtasks (slots 4-6) → over limit at slot 6
      const subtasks = Array.from({ length: 3 }, (_, i) => ({ title: `Sub ${i}`, description: `Desc ${i}` }));
      const actions = [
        ...Array.from({ length: 3 }, () => action("create")),
        action("split", { subtasks }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results.slice(0, 3).every((r) => r.result === "valid")).toBe(true);
      expect(results[3].result).toBe("rejected");
      expect(results[3].reason).toContain("create");
    });
  });

  // ---- Rule 6: total action limit ----
  describe("Rule 6: total action limit (max 20)", () => {
    it("accepts up to 20 actions", () => {
      const actions = Array.from({ length: 20 }, () => action("reprioritize"));
      const results = validateGroomActions(actions, makeCtx());
      expect(results.filter((r) => r.result === "valid")).toHaveLength(20);
    });

    it("rejects actions beyond the 20th", () => {
      const actions = Array.from({ length: 22 }, () => action("reprioritize"));
      const results = validateGroomActions(actions, makeCtx());
      expect(results.filter((r) => r.result === "valid")).toHaveLength(20);
      expect(results.filter((r) => r.result === "rejected")).toHaveLength(2);
      expect(results[19].result).toBe("valid");
      expect(results[20].result).toBe("rejected");
      expect(results[20].reason).toContain("total");
    });
  });

  // ---- Rule 7: empty fields ----
  describe("Rule 7: empty fields", () => {
    it("rejects create with empty title", () => {
      const results = validateGroomActions(
        [action("create", { title: "" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects create with empty description", () => {
      const results = validateGroomActions(
        [action("create", { description: "" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects update with empty title", () => {
      const results = validateGroomActions(
        [action("update", { title: "" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects update with empty description", () => {
      const results = validateGroomActions(
        [action("update", { title: undefined, description: "" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("accepts update with non-empty title and no description", () => {
      const results = validateGroomActions(
        [action("update", { title: "Valid", description: undefined })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });
  });

  // ---- At-least-one-field checks (types.ts:268 contract) ----
  describe("at-least-one-field checks", () => {
    it("rejects update with neither title nor description", () => {
      const results = validateGroomActions(
        [action("update", { title: undefined, description: undefined })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("at least");
    });

    it("rejects label with neither add nor remove", () => {
      const results = validateGroomActions(
        [{ type: "label" as const, issueId: "ES-1", rationale: "test" }],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("at least");
    });

    it("rejects label with empty add and empty remove arrays", () => {
      const results = validateGroomActions(
        [action("label", { add: [], remove: [] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("at least");
    });

    it("rejects split with empty subtasks array", () => {
      const results = validateGroomActions(
        [action("split", { subtasks: [] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("at least");
    });

    it("accepts split with non-empty subtasks", () => {
      const results = validateGroomActions(
        [action("split")],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("rejects split with a blank subtask title", () => {
      const results = validateGroomActions(
        [action("split", { subtasks: [{ title: "", description: "desc" }] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects split with a whitespace-only subtask title", () => {
      const results = validateGroomActions(
        [action("split", { subtasks: [{ title: "  ", description: "desc" }] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects split with a blank subtask description", () => {
      const results = validateGroomActions(
        [action("split", { subtasks: [{ title: "Sub", description: "" }] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects label with a blank entry in add array", () => {
      const results = validateGroomActions(
        [action("label", { add: [""] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects label with a whitespace-only entry in add array", () => {
      const results = validateGroomActions(
        [action("label", { add: ["  "] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects label with a blank entry in remove array", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", remove: [""] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });
  });

  // ---- Rule 9: unknown label names (Finding 3) ----
  describe("Rule 9: unknown label names", () => {
    it("rejects label action with unknown add label", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", add: ["bug", "typo"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("typo");
    });

    it("rejects label action with unknown remove label", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", remove: ["nonexistent"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("nonexistent");
    });

    it("accepts label action with all known add labels", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", add: ["bug"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("accepts label action when add and remove are all known", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", add: ["bug"], remove: ["urgent"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("valid");
    });

    it("rejects label action when add has one unknown among known labels", () => {
      const results = validateGroomActions(
        [action("label", { issueId: "ES-1", add: ["bug", "unknown-label"] })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("unknown-label");
    });
  });

  // ---- Finding 4: virtual close/split tracking ----
  describe("Finding 4: revalidate issue state between actions", () => {
    it("rejects reprioritize on issue already closed by earlier action in same batch", () => {
      const actions: GroomAction[] = [
        action("close", { issueId: "ES-1" }),
        action("reprioritize", { issueId: "ES-1" }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].result).toBe("valid");
      expect(results[1].result).toBe("rejected");
      expect(results[1].reason).toContain("Done");
    });

    it("rejects update on issue split by earlier action in same batch", () => {
      const actions: GroomAction[] = [
        action("split", { issueId: "ES-1" }),
        action("update", { issueId: "ES-1", title: "New title" }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].result).toBe("valid");
      expect(results[1].result).toBe("rejected");
      expect(results[1].reason).toContain("Done");
    });

    it("allows close on issue that was already closed (close is exempt from done protection)", () => {
      const actions: GroomAction[] = [
        action("close", { issueId: "ES-1" }),
        action("close", { issueId: "ES-1" }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].result).toBe("valid");
      expect(results[1].result).toBe("valid");
    });

    it("rejects label action on issue closed by earlier action in same batch", () => {
      const actions: GroomAction[] = [
        action("close", { issueId: "ES-2" }),
        action("label", { issueId: "ES-2", add: ["bug"] }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].result).toBe("valid");
      expect(results[1].result).toBe("rejected");
    });

    it("does not affect actions on different issues", () => {
      const actions: GroomAction[] = [
        action("close", { issueId: "ES-1" }),
        action("reprioritize", { issueId: "ES-2" }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].result).toBe("valid");
      expect(results[1].result).toBe("valid");
    });
  });

  // ---- Rule 8: memory content validity ----
  describe("Rule 8: memory content validity", () => {
    it("rejects update_memory when content exceeds maxCharsPerFile", () => {
      const results = validateGroomActions(
        [action("update_memory", { content: "x".repeat(8001) })],
        makeCtx({ maxCharsPerFile: 8000 }),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("memory");
    });

    it("accepts update_memory at exactly maxCharsPerFile", () => {
      const results = validateGroomActions(
        [action("update_memory", { content: "x".repeat(8000) })],
        makeCtx({ maxCharsPerFile: 8000 }),
      );
      expect(results[0].result).toBe("valid");
    });

    it("rejects update_memory with empty content", () => {
      const results = validateGroomActions(
        [action("update_memory", { content: "" })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });

    it("rejects update_memory with whitespace-only content", () => {
      const results = validateGroomActions(
        [action("update_memory", { content: "   \n\t  " })],
        makeCtx(),
      );
      expect(results[0].result).toBe("rejected");
      expect(results[0].reason).toContain("empty");
    });
  });

  // ---- Cross-cutting: all actions validated, no early stop ----
  describe("cross-cutting behavior", () => {
    it("validates all actions even when some are rejected", () => {
      const actions: GroomAction[] = [
        action("reprioritize", { issueId: "FAKE-99" }), // Rule 2: reject
        action("reprioritize", { issueId: "ES-1" }),     // valid
        action("close", { issueId: "ES-5" }),             // valid (done but close is OK)
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results).toHaveLength(3);
      expect(results[0].result).toBe("rejected");
      expect(results[1].result).toBe("valid");
      expect(results[2].result).toBe("valid");
    });

    it("returns actions in original order", () => {
      const actions: GroomAction[] = [
        action("reprioritize", { issueId: "ES-1" }),
        action("close", { issueId: "ES-2" }),
      ];
      const results = validateGroomActions(actions, makeCtx());
      expect(results[0].action).toBe(actions[0]);
      expect(results[1].action).toBe(actions[1]);
    });

    it("create and update_memory skip issue-scoped rules (1-4)", () => {
      const results = validateGroomActions(
        [
          action("create"),
          action("update_memory"),
        ],
        makeCtx(),
      );
      expect(results.every((r) => r.result === "valid")).toBe(true);
    });
  });
});
