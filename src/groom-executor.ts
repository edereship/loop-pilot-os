import type { GroomAction } from "./types.js";
import { writeCategory } from "./memory-store.js";

/** Structural interface for the Linear client used during action execution. */
export interface IExecutorLinearClient {
  updatePriority(issueId: string, priority: number): Promise<void>;
  updateIssue(issueId: string, fields: { title?: string; description?: string }): Promise<void>;
  createIssue(fields: { title: string; description: string; priority: number; extraLabelIds?: string[] }): Promise<string>;
  closeIssue(issueId: string, rationale: string): Promise<void>;
  addLabels(issueId: string, names: string[]): Promise<void>;
  removeLabels(issueId: string, names: string[]): Promise<void>;
  getIssueDetails(issueId: string): Promise<{ priority: number; labelIds: string[]; description: string }>;
}

export interface ExecutionResult {
  action: GroomAction;
  outcome: "executed" | "failed";
  error?: string;
}

export interface ExecutorContext {
  linearClient: IExecutorLinearClient;
  repoPath: string;
  maxCharsPerFile: number;
  optInLabel: string;
}

async function executeOne(action: GroomAction, ctx: ExecutorContext): Promise<void> {
  const { linearClient } = ctx;
  switch (action.type) {
    case "reprioritize":
      await linearClient.updatePriority(action.issueId, action.priority);
      break;
    case "update":
      await linearClient.updateIssue(action.issueId, {
        ...(action.title !== undefined && { title: action.title }),
        ...(action.description !== undefined && { description: action.description }),
      });
      break;
    case "create":
      await linearClient.createIssue({
        title: action.title,
        description: action.description,
        priority: action.priority,
      });
      break;
    case "split": {
      const parent = await linearClient.getIssueDetails(action.issueId);
      const childIds: string[] = [];
      try {
        for (const sub of action.subtasks) {
          const id = await linearClient.createIssue({
            title: sub.title,
            description: sub.description,
            priority: parent.priority,
            extraLabelIds: parent.labelIds,
          });
          childIds.push(id);
        }
      } catch (err) {
        // At least one child was created before the failure: record the partial split on
        // the parent description and remove the opt-in label so the parent no longer appears
        // on the GROOM board (descriptions aren't in the board context, but label changes are),
        // preventing duplicate subtask creation on the next GROOM run (Finding 1).
        if (childIds.length > 0) {
          const partialNote = `→ partial split (creation failed after ${childIds.join(", ")}): manual review needed`;
          await linearClient.updateIssue(action.issueId, {
            description: parent.description ? `${parent.description}\n\n${partialNote}` : partialNote,
          }).catch(() => {});
          // Surface label-removal failure: if removeLabels also fails the parent stays opt-in
          // and the next GROOM run will re-split it, duplicating the already-created children.
          // Capture the error and include it in the thrown message so it appears in groom_log.
          let labelRemoveErr: string | null = null;
          await linearClient.removeLabels(action.issueId, [ctx.optInLabel]).catch((e: unknown) => {
            labelRemoveErr = e instanceof Error ? e.message : String(e);
          });
          const baseMsg = err instanceof Error ? err.message : String(err);
          throw new Error(
            labelRemoveErr != null
              ? `${baseMsg}; opt-in label removal also failed (parent may be re-split): ${labelRemoveErr}`
              : baseMsg,
          );
        }
        throw err;
      }
      const splitNote = `→ split into ${childIds.join(", ")}`;
      await linearClient.updateIssue(action.issueId, {
        description: parent.description ? `${parent.description}\n\n${splitNote}` : splitNote,
      });
      await linearClient.closeIssue(action.issueId, action.rationale);
      break;
    }
    case "close":
      await linearClient.closeIssue(action.issueId, action.rationale);
      break;
    case "label":
      if (action.add?.length) await linearClient.addLabels(action.issueId, action.add);
      if (action.remove?.length) await linearClient.removeLabels(action.issueId, action.remove);
      break;
    case "update_memory":
      writeCategory(ctx.repoPath, action.category, action.content, ctx.maxCharsPerFile);
      break;
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown groom action type: ${(_exhaustive as GroomAction).type}`);
    }
  }
}

export async function executeGroomActions(
  actions: GroomAction[],
  ctx: ExecutorContext,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const action of actions) {
    try {
      await executeOne(action, ctx);
      results.push({ action, outcome: "executed" });
    } catch (err) {
      results.push({ action, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
