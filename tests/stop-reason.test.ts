import { describe, it, expect } from "vitest";
import { classifyStopReason, FAILURE_POLICY } from "../src/stop-reason.js";
import type { FailureReason } from "../src/types.js";

describe("classifyStopReason", () => {
  it.each([
    "workflow_crashed",
    "action_timeout",
    "state_conflict",
    "max_turns_exceeded",
    "test_failure",
  ])("classifies '%s' as auto_restart", (reason) => {
    expect(classifyStopReason(reason)).toBe("auto_restart");
  });

  it("classifies 'codex_usage_limit' as quota_wait", () => {
    expect(classifyStopReason("codex_usage_limit")).toBe("quota_wait");
  });

  it.each([
    "loop_detected",
    "action_failure",
    "scope_violation",
    "state_corrupted",
    "codex_request_failed",
    "secret_leak_suspected",
    "action_no_op",
    "max_iterations",
  ])("classifies '%s' as human_required", (reason) => {
    expect(classifyStopReason(reason)).toBe("human_required");
  });

  it("classifies 'no_findings' as review_done", () => {
    expect(classifyStopReason("no_findings")).toBe("review_done");
  });

  it("falls back to human_required for unknown stopReason", () => {
    expect(classifyStopReason("some_future_reason")).toBe("human_required");
  });

  it("falls back to human_required for null stopReason", () => {
    expect(classifyStopReason(null)).toBe("human_required");
  });
});

describe("FAILURE_POLICY", () => {
  const ALL_FAILURE_REASONS: FailureReason[] = [
    "agent_no_change",
    "cost_exceeded",
    "exception",
    "monitor_never_engaged",
    "looppilot_stopped",
    "ci_failed",
    "merge_conflict",
    "pr_closed",
    "claim_failed",
    "handoff_failed",
    "workflow_setup_failed",
    "design_rejected",
    "verify_failed",
  ];

  it("covers every FailureReason member", () => {
    for (const reason of ALL_FAILURE_REASONS) {
      expect(FAILURE_POLICY[reason]).toBeDefined();
    }
  });

  it("maps halt reasons correctly", () => {
    const haltReasons: FailureReason[] = [
      "claim_failed", "handoff_failed", "exception",
      "monitor_never_engaged", "workflow_setup_failed",
      "cost_exceeded", "pr_closed",
    ];
    for (const r of haltReasons) {
      expect(FAILURE_POLICY[r]).toBe("halt");
    }
  });

  it("maps abandon reasons correctly", () => {
    const abandonReasons: FailureReason[] = [
      "agent_no_change", "design_rejected", "verify_failed",
    ];
    for (const r of abandonReasons) {
      expect(FAILURE_POLICY[r]).toBe("abandon");
    }
  });

  it("maps recover reasons correctly", () => {
    const recoverReasons: FailureReason[] = [
      "ci_failed", "merge_conflict", "looppilot_stopped",
    ];
    for (const r of recoverReasons) {
      expect(FAILURE_POLICY[r]).toBe("recover");
    }
  });
});

describe("FAILURE_POLICY (ES-514)", () => {
  it("routes merge_gate_failed to park", () => {
    expect(FAILURE_POLICY.merge_gate_failed).toBe("park");
  });
});
