import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/context-bundle.js";
import type { PromptArgs } from "../src/types.js";

// 仕様 §8 文脈: コード+チケット+ゴール+CLAUDE.md+直近N件のマージ済みセッション要約。
// 本関数はそのうち「ゴール / チケット / 作業規則 / 直近マージ digest」を決定的文字列に組む。

const baseIssue: PromptArgs["issue"] = {
  id: "11111111-1111-1111-1111-111111111111",
  identifier: "TY-123",
  title: "ログイン画面のバリデーション追加",
  description: "メールアドレス形式とパスワード長を検証する。",
  priority: 2,
  sortOrder: 10.5,
  url: "https://linear.app/team-yubune/issue/TY-123",
};

function makeArgs(overrides: Partial<PromptArgs> = {}): PromptArgs {
  return {
    goal: "ユーザー認証基盤を堅牢にし、不正ログインを防ぐ。",
    issue: baseIssue,
    digest: [],
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("① product goal を含む（プロンプト冒頭の文脈・仕様 §8 product）", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("ユーザー認証基盤を堅牢にし、不正ログインを防ぐ。");
  });

  it("② チケットの identifier/title/url/description を含む（仕様 §8 チケット）", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("TY-123");
    expect(out).toContain("ログイン画面のバリデーション追加");
    expect(out).toContain("https://linear.app/team-yubune/issue/TY-123");
    expect(out).toContain("メールアドレス形式とパスワード長を検証する。");
  });

  it("② description が空文字でもクラッシュせず他要素は揃う（EligibleIssue.description は空あり得る）", () => {
    const out = buildPrompt(makeArgs({ issue: { ...baseIssue, description: "" } }));
    expect(out).toContain("TY-123");
    expect(out).toContain("https://linear.app/team-yubune/issue/TY-123");
    // 空 description はプレースホルダ文言に置換される（後述の実装と一致）
    expect(out).toContain("(説明なし)");
  });

  it("③ 作業規則を全て含む: 現在ブランチで実装 / 全変更コミット / 未コミット残骸は失敗 / push・PR禁止はオーケの責務 / CLAUDE.md・規約に従う / スコープはチケット内 / 最後に変更要約", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("このworktreeの現在ブランチで実装");
    expect(out).toContain("全ての変更をコミット");
    expect(out).toContain("未コミットの残骸は失敗として扱われる");
    expect(out).toContain("push および PR 作成は禁止");
    expect(out).toContain("オーケストレーターの責務");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("スコープはこのチケット内");
    expect(out).toContain("最後に変更内容の要約を出力");
  });

  it("④ digest が空のときは digest セクションを丸ごと省略する（仕様 §8: 直近N件・空なら無し）", () => {
    const out = buildPrompt(makeArgs({ digest: [] }));
    expect(out).not.toContain("直近マージ済みセッション");
  });

  it("④ digest が非空のとき `identifier: title — summary` を各1行で含む", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [
          { linearIdentifier: "TY-100", issueTitle: "DB接続プール導入", agentSummary: "プール上限を10に設定" },
          { linearIdentifier: "TY-101", issueTitle: "ログ整形", agentSummary: "JSON構造化ログへ移行" },
        ],
      }),
    );
    expect(out).toContain("直近マージ済みセッション");
    expect(out).toContain("TY-100: DB接続プール導入 — プール上限を10に設定");
    expect(out).toContain("TY-101: ログ整形 — JSON構造化ログへ移行");
  });

  it("④ agentSummary が null のエントリは summary 部を `(要約なし)` にして行を出す", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-102", issueTitle: "リファクタ", agentSummary: null }],
      }),
    );
    expect(out).toContain("TY-102: リファクタ — (要約なし)");
  });

  it("④ digest の行順は入力配列の順序を保つ（決定的・store.recentMergedSummaries の順をそのまま）", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [
          { linearIdentifier: "TY-200", issueTitle: "first", agentSummary: "a" },
          { linearIdentifier: "TY-201", issueTitle: "second", agentSummary: "b" },
          { linearIdentifier: "TY-202", issueTitle: "third", agentSummary: "c" },
        ],
      }),
    );
    const idxFirst = out.indexOf("TY-200: first — a");
    const idxSecond = out.indexOf("TY-201: second — b");
    const idxThird = out.indexOf("TY-202: third — c");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it("決定性: 同一入力なら完全一致の文字列を返す（時刻・乱数なし）", () => {
    const args = makeArgs({
      digest: [{ linearIdentifier: "TY-300", issueTitle: "t", agentSummary: "s" }],
    });
    expect(buildPrompt(args)).toBe(buildPrompt(args));
  });

  it("ブロック順序が決定的: goal → チケット → 作業規則 → digest", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-400", issueTitle: "t", agentSummary: "s" }],
      }),
    );
    const idxGoal = out.indexOf("プロダクトのゴール");
    const idxTicket = out.indexOf("担当チケット");
    const idxRules = out.indexOf("作業規則");
    const idxDigest = out.indexOf("直近マージ済みセッション");
    expect(idxGoal).toBeGreaterThanOrEqual(0);
    expect(idxGoal).toBeLessThan(idxTicket);
    expect(idxTicket).toBeLessThan(idxRules);
    expect(idxRules).toBeLessThan(idxDigest);
  });
});
