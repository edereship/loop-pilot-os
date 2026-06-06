import type { PromptArgs } from "./types.js";

/**
 * セッションごとに claude へ渡す決定的プロンプトを組み立てる純粋関数。
 * 構成（この順序・仕様 §8 文脈）:
 *   ① プロダクトのゴール（config.product.goal）
 *   ② 担当チケット（identifier / title / url / description）
 *   ③ 作業規則（現在ブランチで実装・全変更コミット・push/PR禁止・規約遵守・スコープ・要約出力）
 *   ④ 直近マージ済みセッション digest（identifier: title — summary を各1行。空なら省略）
 * 副作用・時刻・乱数を含まないため、同入力 → 同出力。
 */
export function buildPrompt(args: PromptArgs): string {
  const { goal, issue, digest } = args;

  const description = issue.description.trim().length > 0 ? issue.description : "(説明なし)";

  const goalBlock = ["# プロダクトのゴール", "", goal].join("\n");

  const ticketBlock = [
    "# 担当チケット",
    "",
    `- identifier: ${issue.identifier}`,
    `- title: ${issue.title}`,
    `- url: ${issue.url}`,
    "",
    "## 説明",
    "",
    description,
  ].join("\n");

  const rulesBlock = [
    "# 作業規則",
    "",
    "- このworktreeの現在ブランチで実装すること（新しいブランチを切らない）。",
    "- 作業が終わったら、全ての変更をコミットすること。",
    "- 未コミットの残骸は失敗として扱われる（コミットし忘れに注意）。",
    "- push および PR 作成は禁止。これらはオーケストレーターの責務である。",
    "- 対象リポジトリの CLAUDE.md および既存の規約・コーディングスタイルに従うこと。",
    "- スコープはこのチケット内に限定し、無関係な変更を加えないこと。",
    "- 最後に変更内容の要約を出力すること。",
  ].join("\n");

  const blocks: string[] = [goalBlock, ticketBlock, rulesBlock];

  if (digest.length > 0) {
    const lines = digest.map(
      (d) => `- ${d.linearIdentifier}: ${d.issueTitle} — ${d.agentSummary ?? "(要約なし)"}`,
    );
    const digestBlock = ["# 直近マージ済みセッションの要約", "", ...lines].join("\n");
    blocks.push(digestBlock);
  }

  return blocks.join("\n\n");
}
