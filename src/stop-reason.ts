export type StopReasonCategory =
  | "auto_restart"
  | "quota_wait"
  | "human_required"
  | "review_done";

const AUTO_RESTART = new Set([
  "workflow_crashed",
  "action_timeout",
  "state_conflict",
  "max_turns_exceeded",
  "test_failure",
]);

export function classifyStopReason(reason: string | null): StopReasonCategory {
  if (reason === null) return "human_required";
  if (AUTO_RESTART.has(reason)) return "auto_restart";
  if (reason === "codex_usage_limit") return "quota_wait";
  if (reason === "no_findings") return "review_done";
  return "human_required";
}
