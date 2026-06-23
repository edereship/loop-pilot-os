import { describe, it, expect } from "vitest";
import { parseGroomOutput } from "../src/groom-parser.js";

describe("parseGroomOutput", () => {
  // ---- parse success ----

  it("extracts GroomOutput from a fenced json block", () => {
    const output = [
      "Here is my analysis.",
      "```json",
      JSON.stringify({
        actions: [
          { type: "reprioritize", issueId: "ES-1", priority: 2, rationale: "urgent" },
        ],
        summary: "Reprioritized ES-1",
      }),
      "```",
    ].join("\n");
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.actions).toHaveLength(1);
    expect(result.value.actions[0].type).toBe("reprioritize");
    expect(result.value.summary).toBe("Reprioritized ES-1");
  });

  it("uses the LAST fenced json block when multiple are present", () => {
    const output = [
      '```json\n{"actions":[],"summary":"first"}\n```',
      "More reasoning...",
      '```json\n{"actions":[],"summary":"final"}\n```',
    ].join("\n");
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.summary).toBe("final");
  });

  it("falls back to a single-line raw JSON object", () => {
    const json = JSON.stringify({
      actions: [{ type: "close", issueId: "ES-5", rationale: "done" }],
      summary: "Closed ES-5",
    });
    const output = `Analysis complete.\n${json}\n`;
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.summary).toBe("Closed ES-5");
  });

  it("falls back to a multi-line unfenced JSON object", () => {
    const output = [
      "Some analysis.",
      "{",
      '  "actions": [],',
      '  "summary": "No changes needed"',
      "}",
    ].join("\n");
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.summary).toBe("No changes needed");
  });

  it("falls back to a multi-line unfenced JSON object with nested action objects", () => {
    const output = [
      "Some analysis.",
      "{",
      '  "actions": [',
      '    { "type": "close", "issueId": "ES-1", "rationale": "done" }',
      '  ],',
      '  "summary": "Closed ES-1"',
      "}",
    ].join("\n");
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.summary).toBe("Closed ES-1");
    expect(result.value.actions).toHaveLength(1);
    expect(result.value.actions[0].type).toBe("close");
  });

  it("parses all 7 action types correctly", () => {
    const actions = [
      { type: "reprioritize", issueId: "ES-1", priority: 1, rationale: "r" },
      { type: "update", issueId: "ES-2", title: "New title", rationale: "r" },
      { type: "create", title: "New issue", description: "desc", priority: 3, rationale: "r" },
      { type: "split", issueId: "ES-4", subtasks: [{ title: "a", description: "b" }], rationale: "r" },
      { type: "close", issueId: "ES-5", rationale: "r" },
      { type: "label", issueId: "ES-6", add: ["bug"], rationale: "r" },
      { type: "update_memory", category: "pm_decisions", content: "note", rationale: "r" },
    ];
    const output = "```json\n" + JSON.stringify({ actions, summary: "all types" }) + "\n```";
    const result = parseGroomOutput(output);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.actions).toHaveLength(7);
  });

  // ---- parse failure ----

  it("returns parse_error for empty output", () => {
    const result = parseGroomOutput("");
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for whitespace-only output", () => {
    const result = parseGroomOutput("   \n  \t  \n  ");
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when no JSON is found", () => {
    const result = parseGroomOutput("Just some text without any JSON");
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for malformed JSON", () => {
    const result = parseGroomOutput("```json\n{bad json}\n```");
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when actions field is missing", () => {
    const result = parseGroomOutput('```json\n{"summary":"no actions"}\n```');
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when summary field is missing", () => {
    const result = parseGroomOutput('```json\n{"actions":[]}\n```');
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when actions is not an array", () => {
    const result = parseGroomOutput('```json\n{"actions":"nope","summary":"s"}\n```');
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error for unknown action type", () => {
    const json = JSON.stringify({
      actions: [{ type: "destroy", issueId: "ES-1", rationale: "r" }],
      summary: "s",
    });
    const result = parseGroomOutput(`\`\`\`json\n${json}\n\`\`\``);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when required action field is missing (e.g. create without title)", () => {
    const json = JSON.stringify({
      actions: [{ type: "create", description: "d", priority: 1, rationale: "r" }],
      summary: "s",
    });
    const result = parseGroomOutput(`\`\`\`json\n${json}\n\`\`\``);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when priority is out of range", () => {
    const json = JSON.stringify({
      actions: [{ type: "reprioritize", issueId: "ES-1", priority: 5, rationale: "r" }],
      summary: "s",
    });
    const result = parseGroomOutput(`\`\`\`json\n${json}\n\`\`\``);
    expect(result.kind).toBe("parse_error");
  });

  it("returns parse_error when memory category is invalid", () => {
    const json = JSON.stringify({
      actions: [{ type: "update_memory", category: "secrets", content: "x", rationale: "r" }],
      summary: "s",
    });
    const result = parseGroomOutput(`\`\`\`json\n${json}\n\`\`\``);
    expect(result.kind).toBe("parse_error");
  });

  it("preserves raw text in parse_error result", () => {
    const raw = "totally not json at all";
    const result = parseGroomOutput(raw);
    expect(result.kind).toBe("parse_error");
    if (result.kind !== "parse_error") throw new Error("unreachable");
    expect(result.raw).toBe(raw);
  });
});
