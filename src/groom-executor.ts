import type { GroomAction } from "./types.js";
import type { GroomLinearClient } from "./groom-linear-client.js";
import { writeCategory } from "./memory-store.js";

export interface ExecutionResult {
  action: GroomAction;
  outcome: "executed" | "failed";
  error?: string;
}

export interface ExecutorContext {
  linearClient: GroomLinearClient;
  repoPath: string;
  maxCharsPerFile: number;
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
      for (const sub of action.subtasks) {
        const id = await linearClient.createIssue({
          title: sub.title,
          description: sub.description,
          priority: parent.priority,
          extraLabelIds: parent.labelIds,
        });
        childIds.push(id);
      }
      await linearClient.updateIssue(action.issueId, {
        description: `→ split into ${childIds.join(", ")}`,
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
      results.push({ action, outcome: "failed", error: (err as Error).message });
    }
  }
  return results;
}
