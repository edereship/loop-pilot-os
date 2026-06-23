import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readCategory,
  writeCategory,
  readAll,
  initialize,
  commitIfChanged,
  MEMORY_DIR,
  CATEGORY_FILES,
} from "../src/memory-store.js";
import { SqliteStore } from "../src/store.js";
import { FakeCommandRunner } from "./fakes.js";

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(path.join(tmpdir(), "mem-test-"));
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

// Store helpers for initialize tests
let openStores: SqliteStore[] = [];
afterEach(() => {
  for (const s of openStores) s.close();
  openStores = [];
});
function newStore(): SqliteStore {
  const s = new SqliteStore(":memory:");
  openStores.push(s);
  return s;
}
function makeClock(start = "2026-06-06T00:00:00.000Z"): () => string {
  let t = Date.parse(start);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}

describe("readCategory", () => {
  it("returns null when file does not exist", () => {
    expect(readCategory(tmpRepo, "pm_decisions")).toBeNull();
  });

  it("reads existing file content", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "# PM Decisions\n\nSome content");
    expect(readCategory(tmpRepo, "pm_decisions")).toBe("# PM Decisions\n\nSome content");
  });
});

describe("writeCategory", () => {
  it("writes content to the category file", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeCategory(tmpRepo, "impl_results", "result data", 8000);
    expect(readCategory(tmpRepo, "impl_results")).toBe("result data");
  });

  it("throws when content exceeds maxChars", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const huge = "x".repeat(101);
    expect(() => writeCategory(tmpRepo, "pm_decisions", huge, 100)).toThrow(
      /exceeds.*100/,
    );
  });

  it("allows content exactly at the limit", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const exact = "x".repeat(100);
    writeCategory(tmpRepo, "pm_decisions", exact, 100);
    expect(readCategory(tmpRepo, "pm_decisions")).toBe(exact);
  });
});

describe("readAll", () => {
  it("returns all nulls when no files exist", () => {
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: null,
      implResults: null,
      productKnowledge: null,
    });
  });

  it("reads all existing files", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "decisions");
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "results");
    writeFileSync(path.join(dir, CATEGORY_FILES.product_knowledge), "knowledge");
    expect(readAll(tmpRepo)).toEqual({
      pmDecisions: "decisions",
      implResults: "results",
      productKnowledge: "knowledge",
    });
  });
});

describe("initialize", () => {
  it("creates docs/memory/ and empty header files", () => {
    const store = newStore();
    store.createRun(10, "2026-01-01T00:00:00.000Z");
    initialize(tmpRepo, store, 5);

    const pm = readCategory(tmpRepo, "pm_decisions");
    const impl = readCategory(tmpRepo, "impl_results");
    const prod = readCategory(tmpRepo, "product_knowledge");
    expect(pm).toBe("# PM Decisions\n");
    expect(impl).toBe("# Implementation Results\n");
    expect(prod).toBe("# Product Knowledge\n");
  });

  it("does not overwrite existing files", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.pm_decisions), "existing content");

    const store = newStore();
    store.createRun(10, "2026-01-01T00:00:00.000Z");
    initialize(tmpRepo, store, 5);

    expect(readCategory(tmpRepo, "pm_decisions")).toBe("existing content");
  });

  it("bootstraps impl-results from DB when file is new", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(10, clock()).id;

    const s1 = store.createSession({
      runId, linearIssueId: "uuid-1", linearIdentifier: "ES-100",
      issueTitle: "Add auth", branch: "b1", worktreePath: "/w1", now: clock(),
    });
    store.updateSession(s1.id, { state: "merged", costUsd: 2.5, endedAt: clock() });

    const s2 = store.createSession({
      runId, linearIssueId: "uuid-2", linearIdentifier: "ES-101",
      issueTitle: "Fix bug", branch: "b2", worktreePath: "/w2", now: clock(),
    });
    store.updateSession(s2.id, { state: "stopped", costUsd: 0.3, failureReason: "exception", endedAt: clock() });

    initialize(tmpRepo, store, 10);

    const content = readCategory(tmpRepo, "impl_results")!;
    expect(content).toContain("ES-101");
    expect(content).toContain("Fix bug");
    expect(content).toContain("stopped");
    expect(content).toContain("ES-100");
    expect(content).toContain("merged");
    // Most recent (ES-101, ended later) must appear before older (ES-100)
    expect(content.indexOf("ES-101")).toBeLessThan(content.indexOf("ES-100"));
  });

  it("does not bootstrap impl-results when file already exists", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "manual content");

    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(10, clock()).id;
    const s = store.createSession({
      runId, linearIssueId: "uuid-1", linearIdentifier: "ES-999",
      issueTitle: "Some task", branch: "b1", worktreePath: "/w1", now: clock(),
    });
    store.updateSession(s.id, { state: "merged", costUsd: 1.0, endedAt: clock() });

    initialize(tmpRepo, store, 10);

    expect(readCategory(tmpRepo, "impl_results")).toBe("manual content");
  });

  it("bootstraps impl-results from DB when file exists with header only (ES-452 Finding 3)", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    // Simulate a first run that created the header file but had no sessions to populate it.
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "# Implementation Results\n");

    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(10, clock()).id;
    const s = store.createSession({
      runId, linearIssueId: "uuid-1", linearIdentifier: "ES-200",
      issueTitle: "Header test task", branch: "b1", worktreePath: "/w1", now: clock(),
    });
    store.updateSession(s.id, { state: "merged", costUsd: 1.5, endedAt: clock() });

    initialize(tmpRepo, store, 10);

    const content = readCategory(tmpRepo, "impl_results")!;
    expect(content).toContain("ES-200");
    expect(content).toContain("Header test task");
    expect(content).toContain("merged");
  });

  it("leaves header-only impl-results unchanged when DB has no sessions (ES-452 Finding 3)", () => {
    const dir = path.join(tmpRepo, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CATEGORY_FILES.impl_results), "# Implementation Results\n");

    const store = newStore();
    store.createRun(10, "2026-01-01T00:00:00.000Z");

    initialize(tmpRepo, store, 5);

    // No sessions in DB — header-only file should remain unchanged.
    expect(readCategory(tmpRepo, "impl_results")).toBe("# Implementation Results\n");
  });
});

describe("commitIfChanged", () => {
  it("commits when staged diff detects changes", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    // git diff --cached --quiet exits 1 when there are staged changes
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    runner.on(["git", "commit", "-m"], { code: 0 });

    const result = await commitIfChanged(runner, "/repo");
    expect(result).toBe(true);

    const commitCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    expect(commitCall!.args).toContain("chore: persist cross-task memory on halt");
    expect(commitCall!.opts.cwd).toBe("/repo");
  });

  it("throws when git add fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 128, stderr: "fatal: pathspec error" });

    await expect(commitIfChanged(runner, "/repo")).rejects.toThrow(/git add failed/);
  });

  it("throws when git commit fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    runner.on(["git", "commit", "-m"], { code: 1, stderr: "error: author identity unknown" });

    await expect(commitIfChanged(runner, "/repo")).rejects.toThrow(/git commit failed/);
  });

  it("unstages staged changes when git commit fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    runner.on(["git", "commit", "-m"], { code: 1, stderr: "error: author identity unknown" });
    runner.on(["git", "reset", "HEAD", "--", "docs/memory/"], { code: 0 });

    await expect(commitIfChanged(runner, "/repo")).rejects.toThrow(/git commit failed/);

    const resetCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "reset",
    );
    expect(resetCall).toBeDefined();
    expect(resetCall!.args).toContain("docs/memory/");
  });

  it("restores working tree after git commit fails (ES-452 Finding 4)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 1 });
    runner.on(["git", "commit", "-m"], { code: 1, stderr: "error: author identity unknown" });
    runner.on(["git", "reset", "HEAD", "--", "docs/memory/"], { code: 0 });
    runner.on(["git", "checkout", "HEAD", "--", "docs/memory/"], { code: 0 });
    runner.on(["git", "clean", "-fd", "--", "docs/memory/"], { code: 0 });

    await expect(commitIfChanged(runner, "/repo")).rejects.toThrow(/git commit failed/);

    const checkoutCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "checkout" && c.args.includes("HEAD"),
    );
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args).toContain("docs/memory/");

    const cleanCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "clean",
    );
    expect(cleanCall).toBeDefined();
    expect(cleanCall!.args).toContain("docs/memory/");
  });

  it("skips commit when no changes", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "add", "docs/memory/"], { code: 0 });
    // git diff --cached --quiet exits 0 when no staged changes
    runner.on(["git", "diff", "--cached", "--quiet", "--", "docs/memory/"], { code: 0 });

    const result = await commitIfChanged(runner, "/repo");
    expect(result).toBe(false);

    const commitCall = runner.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "commit",
    );
    expect(commitCall).toBeUndefined();
  });
});
