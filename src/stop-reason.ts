import type { FailureReason } from "./types.js";

export type FailurePolicy = "halt" | "recover" | "abandon" | "park";

export const FAILURE_POLICY = {
  claim_failed: "halt",
  handoff_failed: "halt",
  exception: "halt",
  monitor_never_engaged: "halt",
  workflow_setup_failed: "halt",
  cost_exceeded: "halt",
  pr_closed: "halt",
  agent_no_change: "abandon",
  design_rejected: "abandon",
  verify_failed: "abandon",
  merge_gate_failed: "park",
  ci_failed: "recover",
  merge_conflict: "recover",
  looppilot_stopped: "recover",
} as const satisfies Record<FailureReason, FailurePolicy>;

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
