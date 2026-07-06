import type { CommandRunner } from "./types.js";

// ---- v4-B 破壊的変更の客観シグナル抽出（ES-515, spec §2） ----
// codebase-summary.ts と同じ「純関数 + CommandRunner 注入」パターン。
// 抽出は best-effort: 失敗はセクション単位で errors に記録し、決して throw しない
//（ゲート不成立にしない = フェイルオープン）。最終判定は Codex（ES-517）が行う。

/** テストファイル縮小の警告閾値（行数削減率）。spec オープン項目の決定値 */
const TEST_SHRINK_THRESHOLD = 0.3;

const CONFIG_FILE_PATTERNS: RegExp[] = [
  /(^|\/)[^/]*\.config\.[^/]+$/, // vitest.config.ts / eslint.config.js など
  /(^|\/)schema[^/]*\.(sql|prisma|graphql|gql|ya?ml|json)$/i, // schema.sql / schema.prisma など（.md 等のドキュメントは除外）
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
