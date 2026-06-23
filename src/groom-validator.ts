import type { GroomAction } from "./types.js";

export interface ValidationContext {
  projectIssueIds: Set<string>;
  allIssueIds: Set<string>;
  optInLabel: string;
  doneIssueIds: Set<string>;
  maxCharsPerFile: number;
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
    if (a.type === "label" && !a.add?.length && !a.remove?.length) {
      return { action: a, result: "rejected", reason: "label must have at least one add or remove" };
    }
    if (a.type === "split" && a.subtasks.length === 0) {
      return { action: a, result: "rejected", reason: "split must have at least one subtask" };
    }

    // Rule 8: memory size limit
    if (a.type === "update_memory") {
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

      // Rule 4: done issue protection (close is exempt)
      if (ctx.doneIssueIds.has(issueId) && a.type !== "close") {
        return { action: a, result: "rejected", reason: `Issue ${issueId} is Done; only close is allowed` };
      }

      // Rule 3: opt-in label removal
      if (a.type === "label" && a.remove?.includes(ctx.optInLabel)) {
        return { action: a, result: "rejected", reason: `Cannot remove opt-in label "${ctx.optInLabel}"` };
      }
    }

    totalAccepted++;
    return { action: a, result: "valid" };
  });
}
