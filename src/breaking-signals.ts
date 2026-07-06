import type { CommandRunner } from "./types.js";

// ---- v4-B 破壊的変更の客観シグナル抽出（ES-515, spec §2） ----
// codebase-summary.ts と同じ「純関数 + CommandRunner 注入」パターン。
// 抽出は best-effort: 失敗はセクション単位で errors に記録し、決して throw しない
//（ゲート不成立にしない = フェイルオープン）。最終判定は Codex（ES-517）が行う。

/** テストファイル縮小の警告閾値（行数削減率）。spec オープン項目の決定値 */
const TEST_SHRINK_THRESHOLD = 0.3;

const CONFIG_FILE_PATTERNS: RegExp[] = [
  /(^|\/)[^/]*\.config\.[^/]+$/, // vitest.config.ts / eslint.config.js など
  /(^|\/)schema[^/]*\.(?!(?:md|markdown|txt|rst)$)[^/]+$/i, // schema.sql / schema.prisma / schema.rb など（.md 等のドキュメントは除外）
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

function countLines(source: string): number {
  if (source.length === 0) return 0;
  // git show 出力は末尾改行で終わるため、そのまま split すると空要素で1行過大になる。
  // 末尾の改行1つを落としてから数える（縮小率が閾値付近で保守側に歪むのを防ぐ）。
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (body.length === 0) return 0;
  return body.split("\n").length;
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

  return signals;
}

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
