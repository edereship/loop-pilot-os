import type {
  PlanRunner,
  AgentRunner,
  GitPrManager,
  CommandRunner,
  TaskSource,
  TaskSessionRow,
  FailureReason,
} from "./types.js";
import type { Config } from "./config.js";

export type RecoveryActionKind =
  | "fix_code"
  | "rebase"
  | "restart_review"
  | "escalate"
  | "abandon";

const VALID_ACTIONS = new Set<string>([
  "fix_code", "rebase", "restart_review", "escalate", "abandon",
]);

export interface RecoveryAction {
  action: RecoveryActionKind;
  instruction?: string;
}

export type RecoveryTurnResult =
  | { kind: "recovered"; action: RecoveryActionKind; costUsd: number }
  | { kind: "escalated"; action: RecoveryActionKind }
  | { kind: "failed"; action: RecoveryActionKind; message: string; costUsd?: number }
  | { kind: "interrupted"; costUsd?: number }
  | { kind: "continued"; action: RecoveryActionKind };

export interface RecoveryTurnDeps {
  planner: PlanRunner;
  agent: AgentRunner;
  git: GitPrManager;
  runner: CommandRunner;
  source: TaskSource;
  config: Config;
  log: (line: string) => void;
}

export function parseRecoveryAction(text: string): RecoveryAction {
  const fallback: RecoveryAction = { action: "escalate" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;

  // Try fenced ```json blocks first (last one wins) — same pattern as select-prompt.ts
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let lastFenceMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(trimmed)) !== null) {
    lastFenceMatch = m[1];
  }

  let jsonStr = lastFenceMatch;
  if (jsonStr === null) {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        jsonStr = line;
        break;
      }
    }
    if (jsonStr === null) {
      let endLine = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trimEnd().endsWith("}")) { endLine = i; break; }
      }
      if (endLine !== -1) {
        for (let startLine = endLine; startLine >= 0; startLine--) {
          if (lines[startLine].trimStart().startsWith("{")) {
            jsonStr = lines.slice(startLine, endLine + 1).join("\n");
            break;
          }
        }
      }
    }
  }

  if (jsonStr === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return fallback;
  }

  if (typeof parsed !== "object" || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action)) return fallback;

  const result: RecoveryAction = { action: obj.action as RecoveryActionKind };
  if (typeof obj.instruction === "string" && obj.instruction.trim().length > 0) {
    result.instruction = obj.instruction.trim();
  }
  return result;
}

export interface RecoveryPromptContext {
  session: TaskSessionRow;
  reason: FailureReason;
  detail: string | null;
}

export function buildRecoveryPrompt(ctx: RecoveryPromptContext): string {
  const { session, reason, detail } = ctx;
  const blocks: string[] = [];

  blocks.push([
    "You are a software project manager analyzing a stopped CI/CD session.",
    "Your task: decide the best recovery action for this failure.",
    "",
    "Respond with a JSON object (inside a ```json block) with this schema:",
    '  { "action": "fix_code" | "rebase" | "restart_review" | "escalate" | "abandon",',
    '    "instruction": "<instruction for the implementing agent (required for fix_code, optional for others)>" }',
    "",
    "Actions:",
    "- fix_code: provide an instruction for the agent to fix the code in the worktree, push, and restart review",
    "- rebase: rebase the branch onto the default branch to resolve conflicts",
    "- restart_review: post /restart-review to retry the review workflow",
    "- escalate: stop and notify humans (use when recovery is unlikely to help)",
    "- abandon: close the PR, revert the ticket to Todo, and move on",
  ].join("\n"));

  blocks.push([
    "# Session Context",
    "",
    `- Stop reason: ${reason}`,
    `- Detail: ${detail ?? "(none)"}`,
    `- Ticket: ${session.linearIdentifier} — ${session.issueTitle}`,
    `- Branch: ${session.branch}`,
    `- PR: ${session.prNumber !== null ? `#${session.prNumber}` : "(none)"}`,
    `- Cost so far: $${(session.costUsd ?? 0).toFixed(2)}`,
  ].join("\n"));

  if (session.agentSummary) {
    blocks.push([
      "# Agent Summary (last implementation output)",
      "",
      session.agentSummary,
    ].join("\n"));
  }

  if (session.planBrief) {
    blocks.push([
      "# Plan Brief",
      "",
      session.planBrief,
    ].join("\n"));
  }

  return blocks.join("\n\n");
}

export async function executeRecoveryTurn(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
  reason: FailureReason,
  detail: string | null,
): Promise<RecoveryTurnResult> {
  const { planner, agent, git, runner, source, config, log } = deps;

  // 1. Call Codex to analyze the situation
  const prompt = buildRecoveryPrompt({ session, reason, detail });
  let codexText: string;
  try {
    const outcome = await planner.run({
      worktreePath: session.worktreePath ?? config.repo.path,
      prompt,
      timeoutMs: config.safety.codexTimeoutMinutes * 60_000,
    });
    if (outcome.kind === "error") {
      log(`recovery: codex error: ${outcome.message}`);
      return { kind: "escalated", action: "escalate" };
    }
    if (outcome.kind === "interrupted") {
      return { kind: "interrupted" };
    }
    codexText = outcome.text;
  } catch (err) {
    log(`recovery: codex exception: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "escalated", action: "escalate" };
  }

  // 2. Parse the action
  const parsed = parseRecoveryAction(codexText);
  log(`recovery: codex chose action=${parsed.action}`);

  // 3. Dispatch
  switch (parsed.action) {
    case "escalate":
      return { kind: "escalated", action: "escalate" };

    case "abandon":
      return await executeAbandon(deps, session);

    case "restart_review":
      return await executeRestartReview(deps, session);

    case "rebase":
      return await executeRebase(deps, session);

    case "fix_code":
      return await executeFixCode(deps, session, parsed.instruction ?? "Fix the issue that caused the session to stop.");
  }
}

async function executeFixCode(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
  instruction: string,
): Promise<RecoveryTurnResult> {
  const { agent, runner, git, config, log } = deps;
  const worktreePath = session.worktreePath ?? config.repo.path;
  const branch = session.branch;

  // Sync to origin before fixing
  const fetchResult = await runner.run("git", ["-C", worktreePath, "fetch", "origin", branch], { cwd: worktreePath });
  if (fetchResult.code !== 0) {
    return { kind: "failed", action: "fix_code", message: `recovery fetch failed: ${fetchResult.stderr.trim() || `exit ${fetchResult.code}`}` };
  }
  const resetResult = await runner.run("git", ["-C", worktreePath, "reset", "--hard", `origin/${branch}`], { cwd: worktreePath });
  if (resetResult.code !== 0) {
    return { kind: "failed", action: "fix_code", message: `recovery reset failed: ${resetResult.stderr.trim() || `exit ${resetResult.code}`}` };
  }

  // Run agent with instruction
  const outcome = await agent.runSession({
    worktreePath,
    prompt: instruction,
    maxCostUsd: config.safety.maxCostUsdPerFix,
    hardTimeoutMs: config.safety.sessionHardTimeoutMinutes * 60_000,
  });

  if (outcome.kind !== "completed") {
    log(`recovery: fix agent outcome=${outcome.kind}`);
    if (outcome.kind === "interrupted") {
      // Push any commits or dirty edits the agent made before the interrupt so they survive a
      // later worktree reset to origin/<branch>. Without this, uncommitted changes would be
      // silently discarded on the next recovery attempt (recoveryAttempted is not set for
      // interrupted outcomes, so the next run resets the worktree and retries from scratch).
      try {
        const statusResult = await runner.run(
          "git", ["-C", worktreePath, "status", "--porcelain"],
          { cwd: worktreePath },
        );
        if (statusResult.code === 0 && statusResult.stdout.trim() !== "") {
          // Uncommitted edits: wrap them in a WIP commit so the next reset preserves them.
          await runner.run("git", ["-C", worktreePath, "add", "-A"], { cwd: worktreePath });
          await runner.run(
            "git", ["-C", worktreePath, "commit", "-m", "wip: interrupted recovery"],
            { cwd: worktreePath },
          );
        }
        const logResult = await runner.run(
          "git", ["-C", worktreePath, "log", `origin/${branch}..HEAD`, "--oneline"],
          { cwd: worktreePath },
        );
        if (logResult.code === 0 && logResult.stdout.trim() !== "") {
          await runner.run("git", ["push", "origin", `HEAD:${branch}`], { cwd: worktreePath });
        }
      } catch {
        // Best-effort: ignore errors, session will be halted
      }
      return { kind: "interrupted", costUsd: outcome.costUsd };
    }
    return { kind: "failed", action: "fix_code", message: `recovery fix agent: ${outcome.kind}`, costUsd: outcome.costUsd };
  }

  // Verify commits
  const statusResult = await runner.run("git", ["-C", worktreePath, "status", "--porcelain"], { cwd: worktreePath });
  if (statusResult.code !== 0) {
    return { kind: "failed", action: "fix_code", message: `git status exited ${statusResult.code}`, costUsd: outcome.costUsd };
  }
  if (statusResult.stdout.trim() !== "") {
    return { kind: "failed", action: "fix_code", message: "recovery fix agent left uncommitted changes", costUsd: outcome.costUsd };
  }
  const logResult = await runner.run("git", ["-C", worktreePath, "log", `origin/${branch}..HEAD`, "--oneline"], { cwd: worktreePath });
  if (logResult.stdout.trim() === "") {
    return { kind: "failed", action: "fix_code", message: "recovery fix agent made no commits", costUsd: outcome.costUsd };
  }

  // Push
  const pushResult = await runner.run("git", ["push", "origin", `HEAD:${branch}`], { cwd: worktreePath });
  if (pushResult.code !== 0) {
    return { kind: "failed", action: "fix_code", message: `recovery push failed: ${pushResult.stderr.trim() || `exit ${pushResult.code}`}`, costUsd: outcome.costUsd };
  }

  // Post /restart-review if PR exists
  if (session.prNumber !== null) {
    try {
      await git.postComment(session.prNumber, "/restart-review");
    } catch (err) {
      return { kind: "failed", action: "fix_code", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { kind: "recovered", action: "fix_code", costUsd: outcome.costUsd };
}

async function executeRebase(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<RecoveryTurnResult> {
  const { runner, git, config, log } = deps;
  const worktreePath = session.worktreePath ?? config.repo.path;
  const defaultBranch = config.repo.defaultBranch;
  const branch = session.branch;

  const fetchResult = await runner.run(
    "git", ["-C", worktreePath, "fetch", "origin", defaultBranch],
    { cwd: worktreePath },
  );
  if (fetchResult.code !== 0) {
    return { kind: "failed", action: "rebase", message: `recovery rebase fetch failed: ${fetchResult.stderr.trim() || `exit ${fetchResult.code}`}` };
  }

  const rebaseResult = await runner.run(
    "git", ["-C", worktreePath, "rebase", `origin/${defaultBranch}`],
    { cwd: worktreePath },
  );
  if (rebaseResult.code !== 0) {
    // Abort the failed rebase
    await runner.run("git", ["-C", worktreePath, "rebase", "--abort"], { cwd: worktreePath });
    return { kind: "failed", action: "rebase", message: `recovery rebase failed: ${rebaseResult.stderr.trim() || `exit ${rebaseResult.code}`}` };
  }

  // Force push with lease
  const pushResult = await runner.run(
    "git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`],
    { cwd: worktreePath },
  );
  if (pushResult.code !== 0) {
    return { kind: "failed", action: "rebase", message: `recovery rebase push failed: ${pushResult.stderr.trim() || `exit ${pushResult.code}`}` };
  }

  if (session.prNumber !== null) {
    try {
      await git.postComment(session.prNumber, "/restart-review");
    } catch (err) {
      return { kind: "failed", action: "rebase", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  log(`recovery: rebase onto ${defaultBranch} succeeded`);
  return { kind: "recovered", action: "rebase", costUsd: 0 };
}

async function executeRestartReview(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<RecoveryTurnResult> {
  if (session.prNumber === null) {
    return { kind: "failed", action: "restart_review", message: "recovery restart_review: no PR to comment on" };
  }
  try {
    await deps.git.postComment(session.prNumber, "/restart-review");
  } catch (err) {
    return { kind: "failed", action: "restart_review", message: `recovery restart-review failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { kind: "recovered", action: "restart_review", costUsd: 0 };
}

async function executeAbandon(
  deps: RecoveryTurnDeps,
  session: TaskSessionRow,
): Promise<RecoveryTurnResult> {
  const { runner, source, git, config, log } = deps;
  // Close PR — a non-zero exit means the PR may remain open; fail before reverting the ticket.
  if (session.prNumber !== null) {
    const closeResult = await runner.run(
      "gh", ["pr", "close", String(session.prNumber), "--delete-branch", "-R", config.repo.remote],
      { cwd: config.repo.path },
    );
    if (closeResult.code !== 0) {
      const msg = closeResult.stderr.trim() || `exit ${closeResult.code}`;
      log(`recovery: abandon PR close failed: ${msg}`);
      return { kind: "failed", action: "abandon", message: `PR close failed: ${msg}` };
    }
  }
  // Revert ticket to Todo — a failure leaves the ticket stuck In Progress/In Review with no active session.
  try {
    await source.transition(session.linearIssueId, "todo");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`recovery: abandon ticket revert failed: ${msg}`);
    return { kind: "failed", action: "abandon", message: `ticket revert to Todo failed: ${msg}` };
  }
  // Discard worktree (best-effort)
  if (session.worktreePath) {
    try {
      await git.discardWorktree(session.branch, session.worktreePath);
    } catch {
      log("recovery: abandon worktree discard failed (best-effort)");
    }
  }
  return { kind: "continued", action: "abandon" };
}
