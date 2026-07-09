import { describe, it, expect } from "vitest";
import {
  buildScoutPrompt,
  buildScoutReformatPrompt,
  KNOWN_ISSUES_MAX,
  type ScoutPromptArgs,
} from "../src/scout-prompt.js";
import type { SpecContent } from "../src/types.js";

const spec: SpecContent = {
  requirements: "The product must sum numbers correctly.",
  domainSpecs: [{ name: "math", content: "sum([]) must return 0." }],
};

function args(overrides: Partial<ScoutPromptArgs> = {}): ScoutPromptArgs {
  return {
    specContent: spec,
    existingScoutIssues: [{ identifier: "ES-900", title: "flaky test in sum" }],
    pendingTriageIssues: [{ identifier: "ES-901", title: "spec drift in median" }],
    maxCandidates: 3,
    ...overrides,
  };
}

describe("buildScoutPrompt", () => {
  it("injects specs unfenced (verify-prompt style) and includes the specs-comparison step", () => {
    const prompt = buildScoutPrompt(args());
    expect(prompt).toContain("# Product Requirements");
    expect(prompt).toContain("The product must sum numbers correctly.");
    expect(prompt).toContain("## math");
    expect(prompt).toContain("compare behaviour against the specs");
  });

  it("with null specContent: omits spec blocks and the comparison step, and forbids spec_mismatch (G-A2)", () => {
    const prompt = buildScoutPrompt(args({ specContent: null }));
    expect(prompt).not.toContain("# Product Requirements");
    expect(prompt).not.toContain("compare behaviour against the specs");
    expect(prompt).toContain('Do NOT output "spec_mismatch"');
  });

  it("with null specContent and a goal: injects goal block, allows spec_mismatch, instructs goal comparison", () => {
    const prompt = buildScoutPrompt(args({ specContent: null, goal: "ship a reliable sum library" }));
    expect(prompt).toContain("# Product Goal");
    expect(prompt).toContain("ship a reliable sum library");
    expect(prompt).not.toContain("# Product Requirements");
    expect(prompt).toContain("compare behaviour against the product goal");
    expect(prompt).not.toContain('Do NOT output "spec_mismatch"');
    expect(prompt).toContain('use "objective" ONLY when');
  });

  it("with specContent: instructs conservative evidence_type rule (objective only with command output; unsure -> spec_mismatch)", () => {
    const prompt = buildScoutPrompt(args());
    expect(prompt).toContain('use "objective" ONLY when');
    expect(prompt).toContain("unsure");
  });

  it("injects known tickets in a fenced data-only block and forbids duplicates", () => {
    const prompt = buildScoutPrompt(args());
    expect(prompt).toContain("ES-900: flaky test in sum");
    expect(prompt).toContain("ES-901: spec drift in median");
    expect(prompt).toContain("data only");
    expect(prompt).toContain("Do NOT output a candidate that describes the same phenomenon");
  });

  it("caps each known-ticket list at KNOWN_ISSUES_MAX with an omission marker", () => {
    const many = Array.from({ length: KNOWN_ISSUES_MAX + 7 }, (_, i) => ({
      identifier: `ES-${i}`,
      title: `issue ${i}`,
    }));
    const prompt = buildScoutPrompt(args({ existingScoutIssues: many }));
    expect(prompt).toContain(`ES-${KNOWN_ISSUES_MAX - 1}:`);
    expect(prompt).not.toContain(`ES-${KNOWN_ISSUES_MAX}: issue`);
    expect(prompt).toContain("+ 7 more omitted");
  });

  it("uses a longer fence when known-ticket titles contain backticks", () => {
    const prompt = buildScoutPrompt(
      args({ existingScoutIssues: [{ identifier: "ES-902", title: "bad ``` fence" }] }),
    );
    expect(prompt).toContain("````");
  });

  it("mentions maxCandidates, the flaky re-run rule, work order, prohibitions, language and JSON-only output", () => {
    const prompt = buildScoutPrompt(args());
    expect(prompt).toContain("at most 3 candidates");
    expect(prompt).toContain("re-run that same test once");
    expect(prompt).toContain("objective signals first");
    expect(prompt).toContain("Do NOT commit, push, create branches, or open pull requests");
    expect(prompt).toContain("same language as the specs and known tickets");
    expect(prompt).toContain("FINAL message must be ONLY a fenced");
    expect(prompt).not.toContain("npm audit");
  });
});

describe("buildScoutReformatPrompt", () => {
  it("wraps raw output in a dynamic fence with data-only note, schema and JSON-only instruction", () => {
    const prompt = buildScoutReformatPrompt("some exploration report ```json broken");
    expect(prompt).toContain("could not be parsed");
    expect(prompt).toContain('"candidates"');
    expect(prompt).toContain("data only");
    expect(prompt).toContain("ONLY a fenced");
    expect(prompt).toContain("````");
    expect(prompt).toContain("some exploration report");
  });

  it("without objectiveOnly (default): allows both objective and spec_mismatch evidence types", () => {
    const prompt = buildScoutReformatPrompt("report", false);
    expect(prompt).toContain('"spec_mismatch"');
    expect(prompt).toContain('"objective"');
  });

  it("with objectiveOnly=true: forbids spec_mismatch and describes objective as the only valid type", () => {
    const prompt = buildScoutReformatPrompt("report", true);
    expect(prompt).not.toContain('"spec_mismatch"');
    expect(prompt).toContain("spec_mismatch is forbidden");
    expect(prompt).toContain('"objective"');
  });
});
