import type { GroomAction } from "./types.js";

export interface ValidationContext {
  projectIssueIds: Set<string>;
  allIssueIds: Set<string>;
  optInLabel: string;
  optInIssueIds: Set<string>;
  doneIssueIds: Set<string>;
  /** Identifiers currently in in_progress or in_review state (ES-457 Finding 2). */
  activeIssueIds: Set<string>;
  /** Identifiers carrying the needs-human label; GROOM must not modify these (ES-492). */
  needsHumanIssueIds: Set<string>;
  maxCharsPerFile: number;
  knownLabels: string[];
}

export interface ValidationResult {
  action: GroomAction;
  result: "valid" | "rejected";
  reason?: string;
}

type ActionWithIssueId = Extract<GroomAction, { issueId: string }>;

function hasIssueId(a: GroomAction): a is ActionWithIssueId {
  return "issueId" in a;
}

const MAX_CREATES = 5;
const MAX_TOTAL = 20;

export function validateGroomActions(
  actions: GroomAction[],
  ctx: ValidationContext,
): ValidationResult[] {
  let createCount = 0;
  let totalAccepted = 0;
  // Track issues closed or split during this validation pass so subsequent
  // actions on the same issue are treated as targeting a Done issue (Finding 4).
  const virtuallyClosedIds = new Set<string>();

  return actions.map((a): ValidationResult => {
    // Rule 6: total action limit (checked first so counter stays accurate)
    if (totalAccepted >= MAX_TOTAL) {
      return { action: a, result: "rejected", reason: "Exceeds total action limit (20)" };
    }

    // Rule 5: create limit — counts all create *attempts*, not just accepted ones.
    // A rejected-for-other-reasons create still consumes a slot (stricter, prevents
    // padding empty creates to sneak more through). Contrast with Rule 6 which
    // counts accepted actions only.
    if (a.type === "create") {
      createCount++;
      if (createCount > MAX_CREATES) {
        return { action: a, result: "rejected", reason: "Exceeds create action limit (5)" };
      }
    }

    // Rule 7: empty fields (create/update) — .trim() is intentionally stricter than
    // bare empty-string check; whitespace-only titles are effectively empty.
    if (a.type === "create") {
      if (a.title.trim() === "") return { action: a, result: "rejected", reason: "empty title" };
      if (a.description.trim() === "") return { action: a, result: "rejected", reason: "empty description" };
    }
    if (a.type === "update") {
      if (a.title !== undefined && a.title.trim() === "") return { action: a, result: "rejected", reason: "empty title" };
      if (a.description !== undefined && a.description.trim() === "") return { action: a, result: "rejected", reason: "empty description" };
    }

    // At-least-one-field check for update/label/split (types.ts:268 contract)
    if (a.type === "update" && a.title === undefined && a.description === undefined) {
      return { action: a, result: "rejected", reason: "update must set at least title or description" };
    }
    if (a.type === "label") {
      if (!a.add?.length && !a.remove?.length) {
        return { action: a, result: "rejected", reason: "label must have at least one add or remove" };
      }
      if (a.add?.some((l) => l.trim() === "")) return { action: a, result: "rejected", reason: "empty label name" };
      if (a.remove?.some((l) => l.trim() === "")) return { action: a, result: "rejected", reason: "empty label name" };
      // Rule 9: unknown label names — reject before execution so no partial apply occurs.
      const knownSet = new Set(ctx.knownLabels);
      const unknownAdd = a.add?.filter((l) => !knownSet.has(l)) ?? [];
      const unknownRemove = a.remove?.filter((l) => !knownSet.has(l)) ?? [];
      const allUnknown = [...unknownAdd, ...unknownRemove];
      if (allUnknown.length > 0) {
        return { action: a, result: "rejected", reason: `Unknown label name(s): ${allUnknown.join(", ")}` };
      }
    }
    if (a.type === "split") {
      if (a.subtasks.length === 0) {
        return { action: a, result: "rejected", reason: "split must have at least one subtask" };
      }
      for (const subtask of a.subtasks) {
        if (subtask.title.trim() === "") return { action: a, result: "rejected", reason: "empty subtask title" };
        if (subtask.description.trim() === "") return { action: a, result: "rejected", reason: "empty subtask description" };
      }
      // Each subtask creates one Linear issue; count against the same budget
      // as explicit create actions so a split with many subtasks cannot bypass
      // MAX_CREATES or flood Linear in one loop (ES-457 Finding 2).
      createCount += a.subtasks.length;
      if (createCount > MAX_CREATES) {
        return { action: a, result: "rejected", reason: `Exceeds create action limit (${MAX_CREATES})` };
      }
    }

    // Rule 8: memory content validity
    if (a.type === "update_memory") {
      if (a.content.trim() === "") {
        return { action: a, result: "rejected", reason: "empty memory content" };
      }
      if (a.content.length > ctx.maxCharsPerFile) {
        return { action: a, result: "rejected", reason: `memory content exceeds ${ctx.maxCharsPerFile} chars` };
      }
    }

    // Issue-scoped rules (1-4) only apply to actions with issueId
    if (hasIssueId(a)) {
      const { issueId } = a;

      // Rule 2: existence (checked before scope, since non-existent implies out-of-scope)
      if (!ctx.allIssueIds.has(issueId)) {
        return { action: a, result: "rejected", reason: `Issue ${issueId} does not exist` };
      }

      // Rule 1: project scope
      if (!ctx.projectIssueIds.has(issueId)) {
        return { action: a, result: "rejected", reason: `Issue ${issueId} is out of project scope` };
      }

      // Rule 1b: opt-in label required — GROOM may only act on opted-in issues
      if (!ctx.optInIssueIds.has(issueId)) {
        return { action: a, result: "rejected", reason: `Issue ${issueId} does not have the opt-in label` };
      }

      // Rule: needs-human issue protection — GROOM must not modify triage-pending issues
      if (ctx.needsHumanIssueIds.has(issueId)) {
        return { action: a, result: "rejected", reason: `Issue ${issueId} has needs-human label; human triage required` };
      }

      // Rule 4: done issue protection (close is exempt).
      // Also checks virtuallyClosedIds so a close/split earlier in the same action
      // list makes subsequent mutating actions on the same issue ineligible (Finding 4).
      if ((ctx.doneIssueIds.has(issueId) || virtuallyClosedIds.has(issueId)) && a.type !== "close") {
        return { action: a, result: "rejected", reason: `Issue ${issueId} is Done; only close is allowed` };
      }

      // Rule 4b: active issue protection — reject destructive actions on in-progress or
      // in-review tickets to prevent Linear state mutation while an implementation
      // session is still running (ES-457 Finding 2).
      if ((a.type === "close" || a.type === "split") && ctx.activeIssueIds.has(issueId)) {
        return { action: a, result: "rejected", reason: `Issue ${issueId} is actively in progress; close and split are not allowed` };
      }

      // Rule 3: opt-in label removal
      if (a.type === "label" && a.remove?.includes(ctx.optInLabel)) {
        return { action: a, result: "rejected", reason: `Cannot remove opt-in label "${ctx.optInLabel}"` };
      }
    }

    totalAccepted++;
    // Track close/split so subsequent actions on the same issue see it as Done (Finding 4).
    if (hasIssueId(a) && (a.type === "close" || a.type === "split")) {
      virtuallyClosedIds.add(a.issueId);
    }
    return { action: a, result: "valid" };
  });
}
