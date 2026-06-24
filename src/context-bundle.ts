import type { PromptArgs } from "./types.js";
import { buildMemoryBlock } from "./memory-inject.js";

/**
 * セッションごとに claude へ渡す決定的プロンプトを組み立てる純粋関数。
 *
 * v2 注入レイアウト（spec_dir 設定時 / scope doc B1）:
 *   ① 要求（requirements.md 全文 — 不変の錨・必須）
 *   ② 要件定義（領域ファイル群 — 該当分。B1-a では全領域注入）
 *   ③ 横断メモリ（impl-results + product-knowledge — B2 / D-23）
 *   ④ 担当チケット（identifier / title / url / description）
 *   ⑤ 実装ブリーフ + ガードレール（PLAN フェーズ生成・存在時のみ）
 *   ⑥ 作業規則
 *   ⑦ 直近の変更アウェアネス（digest — 軽い手がかり・任意。空配列で省略）
 *
 * v1 フォールバック（spec_dir 未設定・goal のみ）:
 *   ① プロダクトのゴール（config.product.goal）
 *   ② 横断メモリ（存在時のみ）
 *   ③ 担当チケット
 *   ④ 実装ブリーフ + ガードレール（存在時のみ）
 *   ⑤ 作業規則
 *   ⑥ digest
 *
 * 副作用・時刻・乱数を含まないため、同入力 → 同出力。
 */
export function buildPrompt(args: PromptArgs): string {
  const { specContent, goal, issue, digest, planBrief, memory, memoryBudgetChars } = args;

  const description = issue.description.trim().length > 0 ? issue.description : "(説明なし)";

  const blocks: string[] = [];

  // ---- ① 要求 or ゴール ----
  if (specContent) {
    blocks.push(["# 要求（プロダクト要求）", "", specContent.requirements].join("\n"));
  } else if (goal) {
    blocks.push(["# プロダクトのゴール", "", goal].join("\n"));
  }

  // ---- ② 要件定義（v2 のみ） ----
  if (specContent && specContent.domainSpecs.length > 0) {
    const specSections = specContent.domainSpecs.map(
      (s) => [`## ${s.name}`, "", s.content].join("\n"),
    );
    blocks.push(["# 要件定義", "", ...specSections].join("\n\n"));
  }

  // ---- ③ 横断メモリ（B2: impl-results + product-knowledge / D-23） ----
  if (memory) {
    const entries = [
      ...(memory.implResults ? [{ label: "Implementation Results", content: memory.implResults }] : []),
      ...(memory.productKnowledge ? [{ label: "Product Knowledge", content: memory.productKnowledge }] : []),
    ];
    const block = buildMemoryBlock(entries, memoryBudgetChars ?? 6000);
    if (block.length > 0) blocks.push(block);
  }

  // ---- ④ チケット ----
  blocks.push(
    [
      "# 担当チケット",
      "",
      `- identifier: ${issue.identifier}`,
      `- title: ${issue.title}`,
      `- url: ${issue.url}`,
      "",
      "## 説明",
      "",
      description,
    ].join("\n"),
  );

  // ---- ⑤ 実装ブリーフ + ガードレール（PLAN フェーズ生成・存在時のみ） ----
  if (planBrief && planBrief.raw.length > 0) {
    blocks.push(
      [
        "# 実装ブリーフ",
        "",
        planBrief.raw,
        "",
        "> **注意**: 上記ブリーフの実装手順（HOW）は拘束ではなく強い出発仮説である。",
        "> コードの実態と食い違う場合は、コードの現実を優先し逸脱してよい。",
      ].join("\n"),
    );
  }

  // ---- ⑥ 作業規則 ----
  blocks.push(
    [
      "# 作業規則",
      "",
      "- このworktreeの現在ブランチで実装すること（新しいブランチを切らない）。",
      "- 作業が終わったら、全ての変更をコミットすること。",
      "- 未コミットの残骸は失敗として扱われる（コミットし忘れに注意）。",
      "- push および PR 作成は禁止。これらはオーケストレーターの責務である。",
      "- 対象リポジトリの CLAUDE.md および既存の規約・コーディングスタイルに従うこと。",
      "- スコープはこのチケット内に限定し、無関係な変更を加えないこと。",
      "- 最後に変更内容の要約を出力すること。",
    ].join("\n"),
  );

  // ---- ⑦ digest（B1-b: 格下げ・最小化。digest.enabled=false 時は呼び出し側が空配列を渡す） ----
  if (digest.length > 0) {
    const lines = digest.map((d) => {
      const summary = truncateToOneLine(d.agentSummary ?? "(要約なし)");
      return `- ${d.linearIdentifier}: ${d.issueTitle} — ${summary}`;
    });
    blocks.push(
      ["# 直近の変更（軽い手がかり / 任意）", "", ...lines].join("\n"),
    );
  }

  return blocks.join("\n\n");
}

const MAX_SUMMARY_LEN = 200;

function truncateToOneLine(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length === 0) return "(要約なし)";
  return firstLine.length > MAX_SUMMARY_LEN
    ? firstLine.slice(0, MAX_SUMMARY_LEN) + "…"
    : firstLine;
}
