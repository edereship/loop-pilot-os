# ES-515: 客観シグナル抽出 breaking-signals.ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** マージゲート（v4-B）の一次フィルタとなる新モジュール `src/breaking-signals.ts` — 累積差分（base SHA〜head SHA）から破壊的変更の客観シグナルをコードで機械抽出する。

**Architecture:** `codebase-summary.ts` と同じ「純関数 + `CommandRunner` 注入」パターン。orchestrator には触れない（統合は ES-521）。git コマンドのみで抽出（言語非依存）し、対象リポが TS の場合のみ export 行 diff を上乗せする。TS export diff は **軽量パーサ（`export` 行の正規表現 diff）** を採用 — 依存ゼロで、最終判定は Codex（ES-517）が行うためシグナル精度はこれで十分（spec オープン項目の決定）。全抽出は best-effort: セクション単位で失敗を握り潰して `errors` に記録し、モジュールは決して throw しない（ゲート不成立にしない = フェイルオープン、spec §2）。

**Tech Stack:** TypeScript (ESM, import は `.js` 拡張子必須), Node >= 24, vitest, `tests/fakes.ts` の `FakeCommandRunner`

**Ticket:** [ES-515](https://linear.app/edereship/issue/ES-515) / **Spec:** `docs/superpowers/specs/2026-07-05-v4-merge-gate-design.md`（§2）

## Global Constraints

- 新規依存パッケージ追加禁止（AST パーサ等を入れない — 軽量パーサ採用の理由）
- コード内コメントは日本語（既存スタイル踏襲）
- コミットは明示パス指定（`git add -A` 禁止）
- `extractBreakingSignals` は**いかなる入力でも throw しない**（フェイルオープン契約）
- git 呼び出しは全て `--no-renames` 前提（rename を D+A に分解して削除検知を単純化）

## モジュール公開インターフェース（全タスク共通の前提）

```ts
// src/breaking-signals.ts
export interface ShrunkenTestFile {
  path: string;
  linesBefore: number;
  linesAfter: number;
  reductionRatio: number; // (before - after) / before
}
export interface RemovedExport {
  file: string;
  exportLine: string; // 正規化済み（連続空白を1つに）の export 宣言行
}
export interface BreakingSignals {
  deletedFiles: string[];          // 削除された全ファイル
  deletedTestFiles: string[];      // うちテストファイル
  shrunkenTestFiles: ShrunkenTestFile[]; // 30%以上縮小したテストファイル
  changedConfigFiles: string[];    // 設定/スキーマファイルの変更（A/M/D すべて）
  changedWorkflowFiles: string[];  // .github/workflows/ 配下の変更
  removedExports: RemovedExport[] | null; // null = TS リポでない（tsconfig.json 不在）
  errors: string[];                // best-effort 抽出の失敗記録（フェイルオープン）
}

export async function extractBreakingSignals(
  repoPath: string,
  cmd: CommandRunner,
  baseSha: string,
  headSha: string,
): Promise<BreakingSignals>;

export function formatBreakingSignals(signals: BreakingSignals): string; // Codex プロンプト注入用 Markdown
```

ES-517（プロンプト）と ES-521（オーケ統合）はこの 2 関数と型だけを consume する。

---

### Task 1: name-status パースとファイル分類の純関数

**Files:**
- Create: `src/breaking-signals.ts`
- Test: `tests/breaking-signals.test.ts`

**Interfaces:**
- Consumes: なし
- Produces（モジュール内部 + テスト用 export）:
  - `parseNameStatusZ(stdout: string): Array<{ status: string; path: string }>`
  - `isTestFile(path: string): boolean`
  - `isConfigFile(path: string): boolean`
  - `isWorkflowFile(path: string): boolean`

- [ ] **Step 1: Write the failing test**

`tests/breaking-signals.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import {
  parseNameStatusZ,
  isTestFile,
  isConfigFile,
  isWorkflowFile,
} from "../src/breaking-signals.js";

describe("parseNameStatusZ", () => {
  it("parses NUL-delimited status/path pairs", () => {
    // git diff --name-status -z --no-renames の出力形式: STATUS\0path\0STATUS\0path\0
    const stdout = "D\0src/old.ts\0M\0src/kept.ts\0A\0src/new.ts\0";
    expect(parseNameStatusZ(stdout)).toEqual([
      { status: "D", path: "src/old.ts" },
      { status: "M", path: "src/kept.ts" },
      { status: "A", path: "src/new.ts" },
    ]);
  });

  it("returns empty array for empty stdout", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("ignores a trailing incomplete record", () => {
    expect(parseNameStatusZ("D\0src/a.ts\0M\0")).toEqual([
      { status: "D", path: "src/a.ts" },
    ]);
  });
});

describe("isTestFile", () => {
  it.each([
    "tests/store.test.ts",
    "src/__tests__/foo.ts",
    "test/helper.js",
    "src/foo.test.ts",
    "src/foo.spec.tsx",
    "src/foo.test.mjs",
  ])("detects '%s' as test file", (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it.each(["src/store.ts", "src/testing-utils.ts", "docs/tests.md", "contest/entry.ts"])(
    "does not flag '%s'",
    (p) => {
      expect(isTestFile(p)).toBe(false);
    },
  );
});

describe("isConfigFile", () => {
  it.each([
    "vitest.config.ts",
    "packages/app/eslint.config.js",
    "schema.sql",
    "prisma/schema.prisma",
    ".env.example",
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])("detects '%s' as config file", (p) => {
    expect(isConfigFile(p)).toBe(true);
  });

  it.each(["src/config.ts", "docs/schema-notes.md", "package-lock.json"])(
    "does not flag '%s'",
    (p) => {
      expect(isConfigFile(p)).toBe(false);
    },
  );
});

describe("isWorkflowFile", () => {
  it("detects .github/workflows/ files", () => {
    expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowFile(".github/dependabot.yml")).toBe(false);
    expect(isWorkflowFile("src/workflows/x.ts")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: FAIL — モジュールが存在しない

- [ ] **Step 3: Write minimal implementation**

`src/breaking-signals.ts` を新規作成:

```ts
import type { CommandRunner } from "./types.js";

// ---- v4-B 破壊的変更の客観シグナル抽出（ES-515, spec §2） ----
// codebase-summary.ts と同じ「純関数 + CommandRunner 注入」パターン。
// 抽出は best-effort: 失敗はセクション単位で errors に記録し、決して throw しない
//（ゲート不成立にしない = フェイルオープン）。最終判定は Codex（ES-517）が行う。

/** テストファイル縮小の警告閾値（行数削減率）。spec オープン項目の決定値 */
const TEST_SHRINK_THRESHOLD = 0.3;

const CONFIG_FILE_PATTERNS: RegExp[] = [
  /(^|\/)[^/]*\.config\.[^/]+$/, // vitest.config.ts / eslint.config.js など
  /(^|\/)schema[^/]*\.[^/]+$/i,  // schema.sql / schema.prisma など
  /(^|\/)\.env\.example$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
];

export interface ShrunkenTestFile {
  path: string;
  linesBefore: number;
  linesAfter: number;
  reductionRatio: number; // (before - after) / before
}
export interface RemovedExport {
  file: string;
  exportLine: string;
}
export interface BreakingSignals {
  deletedFiles: string[];
  deletedTestFiles: string[];
  shrunkenTestFiles: ShrunkenTestFile[];
  changedConfigFiles: string[];
  changedWorkflowFiles: string[];
  removedExports: RemovedExport[] | null; // null = TS リポでない
  errors: string[];
}

/** git diff --name-status -z --no-renames の出力をパースする。
 *  形式: STATUS\0path\0STATUS\0path\0...（--no-renames なので path は常に1つ） */
export function parseNameStatusZ(stdout: string): Array<{ status: string; path: string }> {
  const tokens = stdout.split("\0");
  const out: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status.length === 0 || path.length === 0) continue;
    out.push({ status, path });
  }
  return out;
}

export function isTestFile(path: string): boolean {
  if (/(^|\/)(tests?|__tests__)\//.test(path)) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function isConfigFile(path: string): boolean {
  return CONFIG_FILE_PATTERNS.some((re) => re.test(path));
}

export function isWorkflowFile(path: string): boolean {
  return path.startsWith(".github/workflows/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/breaking-signals.ts tests/breaking-signals.test.ts
git commit -m "feat: breaking-signals のファイル分類純関数を追加 (ES-515)"
```

---

### Task 2: `extractBreakingSignals` — 削除ファイル・設定・ワークフロー検知

**Files:**
- Modify: `src/breaking-signals.ts`
- Test: `tests/breaking-signals.test.ts`

**Interfaces:**
- Consumes: Task 1 の純関数、`FakeCommandRunner`（tests/fakes.ts: `on([cmd, ...argsPrefix], {code, stdout, stderr})` で前方一致スタブ）
- Produces: `extractBreakingSignals(repoPath, cmd, baseSha, headSha): Promise<BreakingSignals>`（shrunken/removedExports はこのタスクでは常に空/null — Task 3, 4 で埋める）

- [ ] **Step 1: Write the failing test**

`tests/breaking-signals.test.ts` に追加:

```ts
import { FakeCommandRunner } from "./fakes.js";
import { extractBreakingSignals } from "../src/breaking-signals.js";

function stubNameStatus(runner: FakeCommandRunner, stdout: string): void {
  runner.on(["git", "diff", "--name-status"], { code: 0, stdout });
}
function stubNotTsRepo(runner: FakeCommandRunner): void {
  runner.on(["git", "cat-file", "-e"], { code: 1 });
}

describe("extractBreakingSignals: deleted/config/workflow (ES-515 Task 2)", () => {
  it("classifies deleted files, config changes and workflow changes", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(
      runner,
      "D\0src/api.ts\0D\0tests/api.test.ts\0M\0vitest.config.ts\0M\0.github/workflows/ci.yml\0A\0src/new.ts\0",
    );
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.deletedFiles).toEqual(["src/api.ts", "tests/api.test.ts"]);
    expect(signals.deletedTestFiles).toEqual(["tests/api.test.ts"]);
    expect(signals.changedConfigFiles).toEqual(["vitest.config.ts"]);
    expect(signals.changedWorkflowFiles).toEqual([".github/workflows/ci.yml"]);
    expect(signals.removedExports).toBeNull();
    expect(signals.errors).toEqual([]);
  });

  it("passes base..head range and --no-renames to git diff", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "");
    stubNotTsRepo(runner);
    await extractBreakingSignals("/repo", runner, "base123", "head456");
    const diffCall = runner.calls.find((c) => c.cmd === "git" && c.args[0] === "diff");
    expect(diffCall).toBeDefined();
    expect(diffCall!.args).toEqual([
      "diff", "--name-status", "-z", "--no-renames", "base123", "head456",
    ]);
    expect(diffCall!.opts.cwd).toBe("/repo");
  });

  it("records an error and returns empty signals when git diff fails (fail-open)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "diff", "--name-status"], { code: 128, stderr: "bad revision" });
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.deletedFiles).toEqual([]);
    expect(signals.errors.length).toBe(1);
    expect(signals.errors[0]).toContain("name-status");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: FAIL — `extractBreakingSignals` が存在しない

- [ ] **Step 3: Write minimal implementation**

`src/breaking-signals.ts` に追加（TS リポ判定と export diff は Task 4 で実装する。このタスクでは `removedExports` は常に初期値 `null` のまま — Task 2 のテストは cat-file スタブを登録するが、未使用スタブは FakeCommandRunner では無害）:

```ts
export async function extractBreakingSignals(
  repoPath: string,
  cmd: CommandRunner,
  baseSha: string,
  headSha: string,
): Promise<BreakingSignals> {
  const signals: BreakingSignals = {
    deletedFiles: [],
    deletedTestFiles: [],
    shrunkenTestFiles: [],
    changedConfigFiles: [],
    changedWorkflowFiles: [],
    removedExports: null,
    errors: [],
  };

  // ① 状態別ファイル一覧（--no-renames で rename を D+A に分解し削除検知を単純化）
  let entries: Array<{ status: string; path: string }> = [];
  try {
    const res = await cmd.run(
      "git",
      ["diff", "--name-status", "-z", "--no-renames", baseSha, headSha],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      signals.errors.push(`name-status failed (code ${res.code}): ${res.stderr.slice(0, 200)}`);
      return signals;
    }
    entries = parseNameStatusZ(res.stdout);
  } catch (err) {
    signals.errors.push(`name-status threw: ${err instanceof Error ? err.message : String(err)}`);
    return signals;
  }

  for (const { status, path } of entries) {
    if (status === "D") {
      signals.deletedFiles.push(path);
      if (isTestFile(path)) signals.deletedTestFiles.push(path);
    }
    if (isConfigFile(path)) signals.changedConfigFiles.push(path);
    if (isWorkflowFile(path)) signals.changedWorkflowFiles.push(path);
  }

  return signals;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/breaking-signals.ts tests/breaking-signals.test.ts
git commit -m "feat: extractBreakingSignals の削除/設定/CI 検知を実装 (ES-515)"
```

---

### Task 3: テストファイルの大幅縮小検知

**Files:**
- Modify: `src/breaking-signals.ts`
- Test: `tests/breaking-signals.test.ts`

**Interfaces:**
- Consumes: Task 2 の `extractBreakingSignals` 骨格
- Produces: `signals.shrunkenTestFiles` — M ステータスのテストファイルで行数が `TEST_SHRINK_THRESHOLD`（30%）以上減ったもの

- [ ] **Step 1: Write the failing test**

`tests/breaking-signals.test.ts` に追加:

```ts
describe("extractBreakingSignals: shrunken test files (ES-515 Task 3)", () => {
  it("flags a modified test file that lost >=30% of its lines", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/store.test.ts\0M\0src/store.ts\0");
    stubNotTsRepo(runner);
    // git show <sha>:<path> で before/after の中身を返す
    runner.on(["git", "show", "base123:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
    });
    runner.on(["git", "show", "head456:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n"),
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([
      { path: "tests/store.test.ts", linesBefore: 100, linesAfter: 60, reductionRatio: 0.4 },
    ]);
  });

  it("does not flag a test file below the 30% threshold", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/store.test.ts\0");
    stubNotTsRepo(runner);
    runner.on(["git", "show", "base123:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
    });
    runner.on(["git", "show", "head456:tests/store.test.ts"], {
      code: 0,
      stdout: Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n"),
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([]);
  });

  it("records an error but continues when git show fails for one file", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0tests/a.test.ts\0D\0src/gone.ts\0");
    stubNotTsRepo(runner);
    runner.on(["git", "show", "base123:tests/a.test.ts"], { code: 128, stderr: "not found" });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.shrunkenTestFiles).toEqual([]);
    expect(signals.deletedFiles).toEqual(["src/gone.ts"]); // 他セクションは生きている
    expect(signals.errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: FAIL — shrunkenTestFiles が常に `[]`

- [ ] **Step 3: Write minimal implementation**

`src/breaking-signals.ts` に追加。まずヘルパ:

```ts
function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length;
}

/** git show <sha>:<path> の中身を返す。失敗時は null（呼び出し側が errors に積む） */
async function showFile(
  repoPath: string,
  cmd: CommandRunner,
  sha: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await cmd.run("git", ["show", `${sha}:${path}`], { cwd: repoPath });
    return res.code === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}
```

`extractBreakingSignals` の分類 for ループの後・`return signals;` の前に追加:

```ts
  // ② M ステータスのテストファイルの大幅縮小検知（閾値 TEST_SHRINK_THRESHOLD）
  const modifiedTestFiles = entries
    .filter((e) => e.status === "M" && isTestFile(e.path))
    .map((e) => e.path);
  for (const path of modifiedTestFiles) {
    const before = await showFile(repoPath, cmd, baseSha, path);
    const after = before === null ? null : await showFile(repoPath, cmd, headSha, path);
    if (before === null || after === null) {
      signals.errors.push(`shrink check failed for ${path}`);
      continue;
    }
    const linesBefore = countLines(before);
    const linesAfter = countLines(after);
    if (linesBefore === 0) continue;
    const reductionRatio = (linesBefore - linesAfter) / linesBefore;
    if (reductionRatio >= TEST_SHRINK_THRESHOLD) {
      signals.shrunkenTestFiles.push({ path, linesBefore, linesAfter, reductionRatio });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/breaking-signals.ts tests/breaking-signals.test.ts
git commit -m "feat: テストファイル大幅縮小の検知を実装 (ES-515)"
```

---

### Task 4: TS export 行 diff（軽量パーサ）

**Files:**
- Modify: `src/breaking-signals.ts`
- Test: `tests/breaking-signals.test.ts`

**Interfaces:**
- Consumes: Task 3 の `showFile(repoPath, cmd, sha, path): Promise<string | null>`
- Produces: `signals.removedExports: RemovedExport[] | null`、`extractExportLines(source): Set<string>`（テスト用 export）、モジュール内部の `isTsRepo`

- [ ] **Step 1: Write the failing test**

`tests/breaking-signals.test.ts` に追加:

```ts
import { extractExportLines } from "../src/breaking-signals.js";

function stubTsRepo(runner: FakeCommandRunner): void {
  runner.on(["git", "cat-file", "-e"], { code: 0 });
}

describe("extractExportLines", () => {
  it("collects normalized export declaration lines", () => {
    const src = [
      "import x from './x.js';",
      "export function foo(a: number): string {",
      "  return String(a);",
      "}",
      "export   const  BAR = 1;",
      "const internal = 2;",
      "export type Baz = { a: number };",
    ].join("\n");
    expect([...extractExportLines(src)]).toEqual([
      "export function foo(a: number): string {",
      "export const BAR = 1;",
      "export type Baz = { a: number };",
    ]);
  });
});

describe("extractBreakingSignals: removed exports (ES-515 Task 4)", () => {
  it("reports exports removed from a modified .ts file and all exports of a deleted .ts file", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0src/api.ts\0D\0src/gone.ts\0M\0src/style.css\0");
    stubTsRepo(runner);
    runner.on(["git", "show", "base123:src/api.ts"], {
      code: 0,
      stdout: "export function keep(): void {}\nexport function removed(): void {}\n",
    });
    runner.on(["git", "show", "head456:src/api.ts"], {
      code: 0,
      stdout: "export function keep(): void {}\n",
    });
    runner.on(["git", "show", "base123:src/gone.ts"], {
      code: 0,
      stdout: "export const GONE = 1;\n",
    });
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.removedExports).toEqual([
      { file: "src/api.ts", exportLine: "export function removed(): void {}" },
      { file: "src/gone.ts", exportLine: "export const GONE = 1;" },
    ]);
  });

  it("skips test files and returns null for non-TS repos", async () => {
    const runner = new FakeCommandRunner();
    stubNameStatus(runner, "M\0src/api.test.ts\0");
    stubNotTsRepo(runner);
    const signals = await extractBreakingSignals("/repo", runner, "base123", "head456");
    expect(signals.removedExports).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: FAIL — `extractExportLines` が存在しない

- [ ] **Step 3: Write minimal implementation**

`src/breaking-signals.ts` に追加:

```ts
/** export 宣言行を抽出して正規化（連続空白→1つ）した Set を返す。
 *  軽量パーサ: 宣言の先頭行のみを見る（複数行シグネチャは先頭行で代表）。
 *  網羅性より依存ゼロを優先 — 取りこぼしは Codex の diff 読解（ES-517）が補完する。 */
export function extractExportLines(source: string): Set<string> {
  const out = new Set<string>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (/^export\s/.test(trimmed)) {
      out.add(trimmed.replace(/\s+/g, " "));
    }
  }
  return out;
}

function isTsSourceFile(path: string): boolean {
  return /\.[cm]?tsx?$/.test(path) && !path.endsWith(".d.ts") && !isTestFile(path);
}

/** head 時点の tsconfig.json 存在で TS リポかを判定（best-effort。失敗は非TS扱い） */
async function isTsRepo(
  repoPath: string,
  cmd: CommandRunner,
  headSha: string,
): Promise<boolean> {
  try {
    const res = await cmd.run("git", ["cat-file", "-e", `${headSha}:tsconfig.json`], {
      cwd: repoPath,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}
```

`extractBreakingSignals` の末尾 `return signals;` の直前（Task 3 の縮小検知ブロックの後）に追加:

```ts
  // ④ TS リポなら export 行 diff（軽量パーサ。最終判定は Codex）
  if (await isTsRepo(repoPath, cmd, headSha)) {
    signals.removedExports = [];
    const tsTargets = entries.filter(
      (e) => (e.status === "M" || e.status === "D") && isTsSourceFile(e.path),
    );
    for (const { status, path } of tsTargets) {
      const before = await showFile(repoPath, cmd, baseSha, path);
      if (before === null) {
        signals.errors.push(`export diff failed for ${path} (base)`);
        continue;
      }
      const baseExports = extractExportLines(before);
      let headExports = new Set<string>();
      if (status === "M") {
        const after = await showFile(repoPath, cmd, headSha, path);
        if (after === null) {
          signals.errors.push(`export diff failed for ${path} (head)`);
          continue;
        }
        headExports = extractExportLines(after);
      }
      for (const line of baseExports) {
        if (!headExports.has(line)) {
          signals.removedExports.push({ file: path, exportLine: line });
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/breaking-signals.ts tests/breaking-signals.test.ts
git commit -m "feat: TS export 行 diff（軽量パーサ）を実装 (ES-515)"
```

---

### Task 5: `formatBreakingSignals`（プロンプト注入用整形）

**Files:**
- Modify: `src/breaking-signals.ts`
- Test: `tests/breaking-signals.test.ts`

**Interfaces:**
- Consumes: `BreakingSignals`
- Produces: `formatBreakingSignals(signals): string` — ES-517 の `buildMergeGatePrompt` がそのまま埋め込む Markdown

- [ ] **Step 1: Write the failing test**

`tests/breaking-signals.test.ts` に追加:

```ts
import { formatBreakingSignals } from "../src/breaking-signals.js";
import type { BreakingSignals } from "../src/breaking-signals.js";

function emptySignals(): BreakingSignals {
  return {
    deletedFiles: [],
    deletedTestFiles: [],
    shrunkenTestFiles: [],
    changedConfigFiles: [],
    changedWorkflowFiles: [],
    removedExports: null,
    errors: [],
  };
}

describe("formatBreakingSignals", () => {
  it("renders each section with items", () => {
    const text = formatBreakingSignals({
      deletedFiles: ["src/gone.ts"],
      deletedTestFiles: ["tests/gone.test.ts"],
      shrunkenTestFiles: [
        { path: "tests/big.test.ts", linesBefore: 100, linesAfter: 40, reductionRatio: 0.6 },
      ],
      changedConfigFiles: ["package.json"],
      changedWorkflowFiles: [".github/workflows/ci.yml"],
      removedExports: [{ file: "src/api.ts", exportLine: "export const X = 1;" }],
      errors: ["export diff failed for src/x.ts (base)"],
    });
    expect(text).toContain("## 機械抽出シグナル（breaking-signals）");
    expect(text).toContain("- src/gone.ts");
    expect(text).toContain("- tests/big.test.ts (100L → 40L, -60%)");
    expect(text).toContain("- src/api.ts: `export const X = 1;`");
    expect(text).toContain("### 抽出エラー");
  });

  it("marks empty sections and omits TS section for non-TS repos", () => {
    const text = formatBreakingSignals(emptySignals());
    expect(text).toContain("（該当なし）");
    expect(text).not.toContain("公開 export");
    expect(text).not.toContain("### 抽出エラー"); // errors 空ならセクション自体を出さない
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/breaking-signals.test.ts`
Expected: FAIL — `formatBreakingSignals` が存在しない

- [ ] **Step 3: Write minimal implementation**

`src/breaking-signals.ts` に追加:

```ts
function section(title: string, items: string[]): string[] {
  const lines = [`### ${title}`];
  if (items.length === 0) {
    lines.push("（該当なし）");
  } else {
    for (const item of items) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines;
}

/** Codex プロンプト注入用の Markdown 整形（ES-517 が消費）。 */
export function formatBreakingSignals(signals: BreakingSignals): string {
  const lines: string[] = ["## 機械抽出シグナル（breaking-signals）", ""];
  lines.push(...section("削除されたファイル", signals.deletedFiles));
  lines.push(...section("削除されたテストファイル", signals.deletedTestFiles));
  lines.push(
    ...section(
      `大幅縮小したテストファイル（${Math.round(TEST_SHRINK_THRESHOLD * 100)}%以上）`,
      signals.shrunkenTestFiles.map(
        (s) =>
          `${s.path} (${s.linesBefore}L → ${s.linesAfter}L, -${Math.round(s.reductionRatio * 100)}%)`,
      ),
    ),
  );
  lines.push(...section("変更された設定ファイル", signals.changedConfigFiles));
  lines.push(...section("変更された CI ワークフロー", signals.changedWorkflowFiles));
  if (signals.removedExports !== null) {
    lines.push(
      ...section(
        "削除・変更された公開 export（TS）",
        signals.removedExports.map((e) => `${e.file}: \`${e.exportLine}\``),
      ),
    );
  }
  if (signals.errors.length > 0) {
    lines.push(...section("抽出エラー", signals.errors));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/breaking-signals.test.ts && npx tsc --noEmit && npx vitest run`
Expected: 全 PASS（全体回帰なし確認）

- [ ] **Step 5: Commit**

```bash
git add src/breaking-signals.ts tests/breaking-signals.test.ts
git commit -m "feat: formatBreakingSignals を実装し breaking-signals を完成 (ES-515)"
```

---

## 完了条件（チケットの Done 定義）

- `npx vitest run` 全テストグリーン + `npx tsc --noEmit` エラーなし
- orchestrator.ts への変更ゼロ（統合は ES-521）
- `extractBreakingSignals` がどの失敗経路でも throw しない（Task 2/3/4 のエラーテストが担保）
