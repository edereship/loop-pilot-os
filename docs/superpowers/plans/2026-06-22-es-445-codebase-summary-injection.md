# ES-445: SELECT プロンプトにコードベースサマリを注入 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PM(Codex) が SELECT 判断時にコードベースの構造・規模感を把握できるよう、ファイルツリー + 行数のサマリをプロンプトに注入する。

**Architecture:** 新モジュール `codebase-summary.ts` が `git ls-files` + `wc -l` でサマリ文字列を生成。orchestrator が毎 SELECT 時にこれを呼び出し、`buildSelectPrompt()` に渡す。config の `select_codebase_summary_budget_chars` で予算上限を制御し、大規模リポではトランケーションする。

**Tech Stack:** TypeScript, vitest, git CLI, wc CLI

## Global Constraints

- TDD: テスト先行、実装は最小限
- `CommandRunner` インターフェース経由でコマンド実行（テスタビリティ）
- サマリ生成失敗は non-fatal（specContent, lastPrDiff と同じパターン）
- export 関数リストは含めない（ファイルツリー + 行数のみ）

## File Structure

| File | Responsibility |
|------|----------------|
| Create: `src/codebase-summary.ts` | `git ls-files` + `wc -l` でサマリ文字列を生成する純粋モジュール |
| Create: `tests/codebase-summary.test.ts` | codebase-summary.ts の単体テスト |
| Modify: `src/config.ts` | `select_codebase_summary_budget_chars` config key 追加 |
| Modify: `src/types.ts` | `SelectPromptArgs` に `codebaseSummary` フィールド追加 |
| Modify: `src/select-prompt.ts` | `buildSelectPrompt()` にコードベースサマリブロック追加 |
| Modify: `src/orchestrator.ts` | `OrchestratorDeps` + `selectWithPm()` にサマリ生成を組み込み |
| Modify: `src/main.ts` | サマリ生成関数の配線 |
| Modify: `tests/config.test.ts` | 新 config key のテスト追加 |
| Modify: `tests/select-prompt.test.ts` | サマリ注入のテスト追加 |
| Modify: `tests/orchestrator.test.ts` | selectWithPm のサマリ注入統合テスト |
| Modify: `tests/fixtures/config-valid.toml` | 新 config key のフィクスチャ |

---

### Task 1: `codebase-summary.ts` — コードベースサマリ生成モジュール

**Files:**
- Create: `src/codebase-summary.ts`
- Create: `tests/codebase-summary.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` from `src/types.ts`
- Produces: `generateCodebaseSummary(repoPath: string, cmd: CommandRunner, budgetChars: number): Promise<string>` — 後続タスクが orchestrator から呼び出す

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/codebase-summary.test.ts
import { describe, it, expect } from "vitest";
import { generateCodebaseSummary } from "../src/codebase-summary.js";
import { FakeCommandRunner } from "./fakes.js";

function stubGitLsFiles(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["git", "ls-files"], { code, stdout });
}

function stubWcLines(runner: FakeCommandRunner, stdout: string, code = 0): void {
  runner.on(["wc", "-l"], { code, stdout });
}

describe("generateCodebaseSummary", () => {
  it("generates a summary with file paths and line counts", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/main.ts\nsrc/util.ts\n");
    stubWcLines(runner, "  42 src/main.ts\n  18 src/util.ts\n  60 total\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files, 60 lines total");
    expect(result).toContain("src/main.ts (42L)");
    expect(result).toContain("src/util.ts (18L)");
  });

  it("returns empty string when git ls-files fails", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "", 128);

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("returns empty string when repo has no tracked files", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "\n");
    // wc -l won't be called when there are no files

    const result = await generateCodebaseSummary("/repo", runner, 5000);
    expect(result).toBe("");
  });

  it("truncates when output exceeds budget", async () => {
    const runner = new FakeCommandRunner();
    const files = Array.from({ length: 100 }, (_, i) => `src/file${String(i).padStart(3, "0")}.ts`);
    stubGitLsFiles(runner, files.join("\n") + "\n");
    const wcLines = files.map((f, i) => `  ${i + 10} ${f}`).join("\n") + `\n  ${files.length * 50} total\n`;
    stubWcLines(runner, wcLines);

    const result = await generateCodebaseSummary("/repo", runner, 200);

    expect(result).toContain("100 files,");
    expect(result).toContain("lines total");
    expect(result).toContain("more files omitted");
    expect(result.length).toBeLessThanOrEqual(250); // some slack for the omission line
  });

  it("handles wc -l failure gracefully — falls back to file list without line counts", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "src/a.ts\nsrc/b.ts\n");
    stubWcLines(runner, "", 1);

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("2 files");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("passes repo path as cwd to git ls-files", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "a.ts\n");
    stubWcLines(runner, "  5 a.ts\n  5 total\n");

    await generateCodebaseSummary("/my/repo", runner, 5000);

    const gitCall = runner.calls.find(c => c.cmd === "git");
    expect(gitCall?.opts.cwd).toBe("/my/repo");
  });

  it("single file — no 'total' line from wc", async () => {
    const runner = new FakeCommandRunner();
    stubGitLsFiles(runner, "readme.md\n");
    stubWcLines(runner, "  10 readme.md\n");

    const result = await generateCodebaseSummary("/repo", runner, 5000);

    expect(result).toContain("1 file, 10 lines total");
    expect(result).toContain("readme.md (10L)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/codebase-summary.test.ts`
Expected: FAIL — module `../src/codebase-summary.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/codebase-summary.ts
import type { CommandRunner } from "./types.js";

const BATCH_SIZE = 500;

interface FileEntry {
  path: string;
  lines: number | null;
}

function parseWcOutput(stdout: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of stdout.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && match[2] !== "total") {
      map.set(match[2], parseInt(match[1], 10));
    }
  }
  return map;
}

function formatSummary(entries: FileEntry[], budgetChars: number): string {
  const total = entries.reduce((sum, e) => sum + (e.lines ?? 0), 0);
  const hasLines = entries.some(e => e.lines !== null);
  const fileWord = entries.length === 1 ? "1 file" : `${entries.length} files`;
  const header = hasLines ? `${fileWord}, ${total} lines total` : `${fileWord}`;

  const lines: string[] = [header, ""];
  let used = header.length + 1;
  let listed = 0;

  for (const entry of entries) {
    const line = entry.lines !== null
      ? `${entry.path} (${entry.lines}L)`
      : entry.path;
    if (used + line.length + 1 > budgetChars) {
      const remaining = entries.length - listed;
      lines.push(`... (${remaining} more files omitted)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
    listed++;
  }

  return lines.join("\n");
}

export async function generateCodebaseSummary(
  repoPath: string,
  cmd: CommandRunner,
  budgetChars: number,
): Promise<string> {
  const lsResult = await cmd.run("git", ["ls-files"], { cwd: repoPath });
  if (lsResult.code !== 0) return "";

  const files = lsResult.stdout.trim().split("\n").filter(f => f.length > 0);
  if (files.length === 0) return "";

  const lineCounts = new Map<string, number>();
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const wcResult = await cmd.run("wc", ["-l", ...batch], { cwd: repoPath });
    if (wcResult.code === 0) {
      for (const [path, count] of parseWcOutput(wcResult.stdout)) {
        lineCounts.set(path, count);
      }
    }
  }

  const entries: FileEntry[] = files.map(f => ({
    path: f,
    lines: lineCounts.get(f) ?? null,
  }));

  return formatSummary(entries, budgetChars);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/codebase-summary.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/codebase-summary.ts tests/codebase-summary.test.ts
git commit -m "feat(ES-445): add codebase summary generator module

git ls-files + wc -l でファイルツリー + 行数サマリを生成。
予算超過時はトランケーション。wc 失敗時はパスのみにフォールバック。"
```

---

### Task 2: Config — `select_codebase_summary_budget_chars` 追加

**Files:**
- Modify: `src/config.ts:64` (TOML schema, `safety` section)
- Modify: `src/config.ts:134` (camelCase Config interface, `safety` section)
- Modify: `src/config.ts:634` (config mapping, `safety` section)
- Modify: `tests/config.test.ts`
- Modify: `tests/fixtures/config-valid.toml`

**Interfaces:**
- Consumes: なし
- Produces: `Config.safety.selectCodebaseSummaryBudgetChars: number` — Task 4 で orchestrator が参照

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts` の既存 `"loads a fully-specified config"` テストに assertion を追加:

```typescript
// tests/config.test.ts — 既存テスト内に追加
expect(config.safety.selectCodebaseSummaryBudgetChars).toBe(5000); // default value
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "loads a fully-specified config"`
Expected: FAIL — `selectCodebaseSummaryBudgetChars` does not exist on type

- [ ] **Step 3: Add the config key to TOML schema**

`src/config.ts` の `rawSchema` 内、`safety` セクション（`select_diff_budget_chars` の直後）に追加:

```typescript
    select_codebase_summary_budget_chars: z.number().int().positive().default(5000),
```

- [ ] **Step 4: Add to camelCase Config interface**

`src/config.ts` の `Config.safety` 内（`selectDiffBudgetChars` の直後）に追加:

```typescript
    selectCodebaseSummaryBudgetChars: number;
```

- [ ] **Step 5: Add to config mapping**

`src/config.ts` の safety mapping（`selectDiffBudgetChars` の直後）に追加:

```typescript
      selectCodebaseSummaryBudgetChars: raw.safety.select_codebase_summary_budget_chars,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(ES-445): add select_codebase_summary_budget_chars config key

safety セクションにデフォルト 5000 文字のコードベースサマリ予算を追加。"
```

---

### Task 3: `SelectPromptArgs` + `buildSelectPrompt()` — サマリ注入

**Files:**
- Modify: `src/types.ts:244-252` (`SelectPromptArgs`)
- Modify: `src/select-prompt.ts:179-259` (`buildSelectPrompt()`)
- Modify: `tests/select-prompt.test.ts`

**Interfaces:**
- Consumes: `SelectPromptArgs.codebaseSummary` (新フィールド)
- Produces: 更新された `buildSelectPrompt()` — Task 4 で orchestrator が呼び出し

- [ ] **Step 1: Write the failing tests**

`tests/select-prompt.test.ts` の `describe("buildSelectPrompt")` 内に追加:

```typescript
  it("includes codebase summary when provided", () => {
    const args: SelectPromptArgs = {
      ...baseArgs,
      codebaseSummary: "3 files, 500 lines total\n\nsrc/main.ts (200L)\nsrc/util.ts (180L)\nsrc/config.ts (120L)",
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).toContain("# Codebase Structure");
    expect(prompt).toContain("3 files, 500 lines total");
    expect(prompt).toContain("src/main.ts (200L)");
  });

  it("omits codebase summary section when null", () => {
    const args: SelectPromptArgs = {
      ...baseArgs,
      codebaseSummary: null,
    };
    const prompt = buildSelectPrompt(args);
    expect(prompt).not.toContain("Codebase Structure");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/select-prompt.test.ts`
Expected: FAIL — type error (`codebaseSummary` does not exist on `SelectPromptArgs`)

- [ ] **Step 3: Add `codebaseSummary` to `SelectPromptArgs`**

`src/types.ts` の `SelectPromptArgs` インターフェース（`diffBudgetChars` の後）に追加:

```typescript
  codebaseSummary: string | null;
```

- [ ] **Step 4: Update `buildSelectPrompt()` to include the summary**

`src/select-prompt.ts` の `buildSelectPrompt()` 内、分割引数に `codebaseSummary` を追加し、Product Requirements/Goal ブロックの直後にサマリブロックを挿入:

引数の分割:
```typescript
  const { goal, specContent, eligible, inProgress, recentMerged, lastPrDiff, diffBudgetChars, codebaseSummary } = args;
```

Product Requirements / Goal ブロック（行 207）の直後、Board state: in-progress（行 210）の直前に追加:

```typescript
  // Codebase structure
  if (codebaseSummary !== null && codebaseSummary.length > 0) {
    blocks.push(["# Codebase Structure", "", codebaseSummary].join("\n"));
  }
```

System instruction の Consider リスト（行 193）にコードベース構造の判断軸を追加:

```typescript
    "- Codebase structure (what exists, what's unimplemented, module sizes)",
```

- [ ] **Step 5: Fix existing tests — add `codebaseSummary: null` to `baseArgs`**

`tests/select-prompt.test.ts` の `baseArgs` に追加:

```typescript
  const baseArgs: SelectPromptArgs = {
    goal: null,
    specContent: null,
    eligible: [
      { id: "a", identifier: "TY-1", title: "Add auth", description: "Auth feature", priority: 1, sortOrder: 100, url: "u1" },
      { id: "b", identifier: "TY-2", title: "Fix bug", description: "Bug fix", priority: 2, sortOrder: 200, url: "u2" },
    ],
    inProgress: [],
    recentMerged: [],
    lastPrDiff: null,
    diffBudgetChars: 6000,
    codebaseSummary: null,
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/select-prompt.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/select-prompt.ts tests/select-prompt.test.ts
git commit -m "feat(ES-445): inject codebase summary into SELECT prompt

SelectPromptArgs に codebaseSummary フィールドを追加。
buildSelectPrompt() で Product Requirements の直後に Codebase Structure セクションとして注入。"
```

---

### Task 4: Orchestrator + main.ts — サマリ生成の配線

**Files:**
- Modify: `src/orchestrator.ts:32-48` (`OrchestratorDeps`)
- Modify: `src/orchestrator.ts:644-765` (`selectWithPm()`)
- Modify: `src/main.ts`
- Modify: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `generateCodebaseSummary()` from `src/codebase-summary.ts`, `Config.safety.selectCodebaseSummaryBudgetChars`
- Produces: 統合済みの SELECT フロー

- [ ] **Step 1: Write the failing orchestrator test**

`tests/orchestrator.test.ts` に SELECT PM サマリ注入のテストを追加。まず `makeHarness` の型を更新し、テストを追加:

```typescript
// describe("PM 選別ターン") 内に追加
it("passes codebase summary to buildSelectPrompt", async () => {
  const config = makeConfig({ maxTasksPerRun: 1 });
  const planner = new FakePlanRunner();
  planner.outcomes = [
    { kind: "completed", text: '{"identifier":"TY-2","rationale":"has summary context"}' },
  ];
  const h = makeHarness(config, { planner });
  h.source.queue = [issue("a", "TY-1"), issue("b", "TY-2")];
  h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
  h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

  await h.orch.run();

  // planner was called with a prompt containing codebase summary
  const selectPrompt = planner.calls[0]?.prompt ?? "";
  expect(selectPrompt).toContain("Codebase Structure");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "passes codebase summary"`
Expected: FAIL — `codebaseSummary` not in `buildSelectPrompt` call args (or type error)

- [ ] **Step 3: Add `codebaseSummaryGenerator` to `OrchestratorDeps`**

`src/orchestrator.ts` の `OrchestratorDeps` インターフェースに追加:

```typescript
  codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
```

Orchestrator のコンストラクタ（`private` フィールド）に保存:

```typescript
  private codebaseSummaryGenerator: (repoPath: string) => Promise<string>;
```

コンストラクタ内で代入:

```typescript
  this.codebaseSummaryGenerator = deps.codebaseSummaryGenerator;
```

- [ ] **Step 4: Call the generator in `selectWithPm()`**

`src/orchestrator.ts` の `selectWithPm()` 内、spec loading（行 684）の直後、`buildSelectPrompt` 呼び出し（行 698）の直前に追加:

```typescript
    // Generate codebase summary
    let codebaseSummary: string | null = null;
    try {
      const summary = await this.codebaseSummaryGenerator(this.config.repo.path);
      if (summary.length > 0) codebaseSummary = summary;
    } catch (err) {
      this.log(`select: codebase summary generation failed (non-fatal): ${errMsg(err)}`);
    }
```

`buildSelectPrompt` の呼び出しに `codebaseSummary` を追加:

```typescript
    const prompt = buildSelectPrompt({
      goal: this.config.product.goal ?? null,
      specContent,
      eligible,
      inProgress,
      recentMerged,
      lastPrDiff,
      diffBudgetChars: this.config.safety.selectDiffBudgetChars,
      codebaseSummary,
    });
```

- [ ] **Step 5: Wire in `main.ts`**

`src/main.ts` にインポートを追加:

```typescript
import { generateCodebaseSummary } from "./codebase-summary.js";
```

Orchestrator 構築の直前にジェネレータ関数を作成:

```typescript
    const codebaseSummaryGenerator = (repoPath: string) =>
      generateCodebaseSummary(repoPath, runner, config.safety.selectCodebaseSummaryBudgetChars);
```

Orchestrator コンストラクタに渡す:

```typescript
    const orchestrator = new Orchestrator({
      // ...existing deps...
      codebaseSummaryGenerator,
    });
```

- [ ] **Step 6: Update test harness `makeHarness`**

`tests/orchestrator.test.ts` の `makeHarness` で `codebaseSummaryGenerator` を渡す:

```typescript
  const codebaseSummaryGenerator = async () => "3 files, 100 lines total\n\nsrc/a.ts (40L)\nsrc/b.ts (30L)\nsrc/c.ts (30L)";
  const orch = new Orchestrator({
    // ...existing deps...
    codebaseSummaryGenerator,
  });
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/main.ts tests/orchestrator.test.ts
git commit -m "feat(ES-445): wire codebase summary into SELECT flow

OrchestratorDeps に codebaseSummaryGenerator を追加。
selectWithPm() で毎回再生成し、buildSelectPrompt() に渡す。
生成失敗は non-fatal（ログのみ）。"
```

---

### Task 5: TOML example + 全テスト最終確認

**Files:**
- Modify: `looppilot-os.example.toml`

**Interfaces:**
- Consumes: なし
- Produces: なし（ドキュメント更新のみ）

- [ ] **Step 1: Update example TOML**

`looppilot-os.example.toml` の `[safety]` セクションに追加:

```toml
# Max chars for the codebase file-tree summary injected into the SELECT prompt.
# Repos with many files will be truncated to this budget. Default: 5000.
# select_codebase_summary_budget_chars = 5000
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add looppilot-os.example.toml
git commit -m "docs(ES-445): add select_codebase_summary_budget_chars to example config"
```
