import type { BoardState, BoardTicket, InProgressTicket, DoneTicket, BlockedTicket, GroomPromptArgs } from "./types.js";

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Urgent";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return "None";
  }
}

function formatEligibleLine(t: BoardTicket): string {
  const labelPart = t.labels.length > 0 ? ` [labels: ${t.labels.join(", ")}]` : "";
  return `- ${t.identifier} [${priorityLabel(t.priority)}] ${t.title}${labelPart}`;
}

function formatInProgressLine(t: InProgressTicket): string {
  const prPart = t.prNumber !== null ? `, PR #${t.prNumber}` : "";
  return `- ${t.identifier} [${priorityLabel(t.priority)}] ${t.title} (${t.status}${prPart})`;
}

function formatDoneLine(t: DoneTicket): string {
  return `- ${t.identifier} ${t.title} (merged, ${t.mergedAt})`;
}

function formatBlockedLine(t: BlockedTicket): string {
  const labelPart = t.labels.length > 0 ? ` [labels: ${t.labels.join(", ")}]` : "";
  return `- ${t.identifier} [${priorityLabel(t.priority)}] ${t.title} (blocked by ${t.blockedBy})${labelPart}`;
}

export function formatBoard(board: BoardState): string {
  const sections: string[] = [];

  if (board.eligible.length > 0) {
    const lines = board.eligible.map(formatEligibleLine);
    sections.push(["## 適格（Todo + opt-in）", "", ...lines].join("\n"));
  }

  if (board.inProgress.length > 0) {
    const lines = board.inProgress.map(formatInProgressLine);
    sections.push(["## 進行中", "", ...lines].join("\n"));
  }

  if (board.recentDone.length > 0) {
    const lines = board.recentDone.map(formatDoneLine);
    sections.push(["## 直近完了", "", ...lines].join("\n"));
  }

  if (board.blocked.length > 0) {
    const lines = board.blocked.map(formatBlockedLine);
    sections.push(["## Blocked", "", ...lines].join("\n"));
  }

  return sections.join("\n\n");
}

export function formatBoardWithBudget(board: BoardState, budgetChars: number): string {
  let formatted = formatBoard(board);
  if (formatted.length <= budgetChars) return formatted;

  const done = [...board.recentDone];
  const blocked = [...board.blocked];
  const eligible = [...board.eligible];
  const current = (): BoardState => ({
    eligible,
    inProgress: board.inProgress,
    recentDone: done,
    blocked,
  });

  while (done.length > 0) {
    done.pop();
    formatted = formatBoard(current());
    if (formatted.length <= budgetChars) return formatted;
  }

  while (blocked.length > 0) {
    blocked.pop();
    formatted = formatBoard(current());
    if (formatted.length <= budgetChars) return formatted;
  }

  while (eligible.length > 0) {
    eligible.pop();
    formatted = formatBoard(current());
    if (formatted.length <= budgetChars) return formatted;
  }

  return formatted;
}

const MAX_SUMMARY_LEN = 200;

function truncateToOneLine(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length === 0) return "(要約なし)";
  return firstLine.length > MAX_SUMMARY_LEN
    ? firstLine.slice(0, MAX_SUMMARY_LEN) + "…"
    : firstLine;
}

function buildGroomInstructions(optInLabel: string, maxMemoryChars: number, knownLabels: string[]): string {
  const knownLabelLine = knownLabels.length > 0
    ? `   - add/remove に使えるラベルは既知ラベルのみ: ${knownLabels.map((l) => `"${l}"`).join(", ")}`
    : "   - 現在利用可能なラベルは存在しないため label アクションは使用不可";
  return [
    "# GROOM 指示",
    "",
    "あなたはプロジェクトマネージャーとしてチケット盤面の整理を行います。",
    "以下のアクション種別を使って、盤面を最適な状態に整理してください。",
    "",
    "## アクション種別",
    "",
    "1. **reprioritize** — チケットの優先度を変更する",
    "   - issueId: 対象チケットID",
    "   - priority: 1(Urgent) | 2(High) | 3(Medium) | 4(Low)",
    "   - rationale: 変更理由",
    "",
    "2. **update** — チケットのタイトルまたは説明を更新する",
    "   - issueId: 対象チケットID",
    "   - title?: 新しいタイトル（省略可）",
    "   - description?: 新しい説明（省略可）",
    "   - rationale: 変更理由",
    "   - ※ title または description の少なくとも一方は必須",
    "",
    "3. **create** — 新しいチケットを作成する",
    "   - title: タイトル",
    "   - description: 説明",
    "   - priority: 1(Urgent) | 2(High) | 3(Medium) | 4(Low)",
    "   - rationale: 作成理由",
    "",
    "4. **split** — チケットをサブタスクに分割する",
    "   - issueId: 分割元チケットID",
    "   - subtasks: [{title, description}, ...]",
    "   - rationale: 分割理由",
    "",
    "5. **close** — チケットをクローズする",
    "   - issueId: 対象チケットID",
    "   - rationale: クローズ理由",
    "",
    "6. **label** — チケットのラベルを追加/削除する",
    "   - issueId: 対象チケットID",
    "   - add?: 追加するラベル名の配列",
    "   - remove?: 削除するラベル名の配列",
    "   - rationale: 変更理由",
    "   - ※ add または remove の少なくとも一方は必須",
    knownLabelLine,
    "",
    "7. **update_memory** — 横断メモリを更新する",
    "   - category: \"pm_decisions\" | \"impl_results\" | \"product_knowledge\"",
    `   - content: 対象カテゴリの内容をまるごと置き換える完全な文字列（既存の内容はすべて上書きされます。保持したい情報はすべて含めてください。${maxMemoryChars} 文字以内）`,
    "   - rationale: 更新理由",
    "",
    "## 制約",
    "",
    "- アクション総数: 最大 20 件",
    "- create: 最大 5 件",
    `- opt-in ラベル "${optInLabel}" の remove は禁止`,
    `- update_memory の content は ${maxMemoryChars} 文字以内`,
    "",
    "## 出力形式",
    "",
    "以下の JSON スキーマに従って ```json ブロックで出力してください:",
    "",
    "```json",
    "{",
    '  "actions": [',
    '    { "type": "reprioritize", "issueId": "ES-xxx", "priority": 2, "rationale": "..." },',
    '    { "type": "create", "title": "...", "description": "...", "priority": 3, "rationale": "..." }',
    "  ],",
    '  "summary": "整理内容の要約（1-2文）"',
    "}",
    "```",
    "",
    "アクションが不要な場合は空配列で返してください:",
    "",
    "```json",
    '{"actions": [], "summary": "盤面は整理済み。変更不要。"}',
    "```",
  ].join("\n");
}

export function buildGroomPrompt(args: GroomPromptArgs): string {
  const { specContent, goal, memory, board, boardBudgetChars, digest, codebaseSummary, optInLabel, maxMemoryChars, knownLabels } = args;

  const blocks: string[] = [];

  // 1. Requirements or goal
  if (specContent) {
    blocks.push(["# 要求（プロダクト要求）", "", specContent.requirements].join("\n"));
  } else if (goal) {
    blocks.push(["# プロダクトのゴール", "", goal].join("\n"));
  }

  // 2. Domain specs
  if (specContent && specContent.domainSpecs.length > 0) {
    const specSections = specContent.domainSpecs.map(
      (s) => [`## ${s.name}`, "", s.content].join("\n"),
    );
    blocks.push(["# 要件定義", "", ...specSections].join("\n\n"));
  }

  // 3. Cross-task memory (all 3 categories: D-23)
  const memoryParts: string[] = [];
  if (memory.pmDecisions) {
    memoryParts.push(["## PM Decisions", "", memory.pmDecisions].join("\n"));
  }
  if (memory.implResults) {
    memoryParts.push(["## Implementation Results", "", memory.implResults].join("\n"));
  }
  if (memory.productKnowledge) {
    memoryParts.push(["## Product Knowledge", "", memory.productKnowledge].join("\n"));
  }
  if (memoryParts.length > 0) {
    blocks.push(["# 横断メモリ", "", ...memoryParts].join("\n\n"));
  }

  // 4. Ticket board
  const boardText = formatBoardWithBudget(board, boardBudgetChars);
  if (boardText.length > 0) {
    blocks.push(["# チケット盤面", "", boardText].join("\n"));
  }

  // 5. Digest
  if (digest.length > 0) {
    const digestLines = digest.map((d) => {
      const summary = truncateToOneLine(d.agentSummary ?? "(要約なし)");
      return `- ${d.linearIdentifier}: ${d.issueTitle} — ${summary}`;
    });
    blocks.push(["# 直近の実装結果", "", ...digestLines].join("\n"));
  }

  // 6. Codebase summary
  if (codebaseSummary) {
    blocks.push(["# コードベースサマリ", "", codebaseSummary].join("\n"));
  }

  // 7. GROOM instructions
  blocks.push(buildGroomInstructions(optInLabel, maxMemoryChars, knownLabels));

  return blocks.join("\n\n");
}
