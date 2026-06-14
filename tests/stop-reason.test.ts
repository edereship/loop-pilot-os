import { describe, it, expect } from "vitest";
import { classifyStopReason } from "../src/stop-reason.js";

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
