import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/context-bundle.js";
import type { PromptArgs } from "../src/types.js";

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
    specContent: null,
    issue: baseIssue,
    digest: [],
    ...overrides,
  };
}

// ---- v1 フォールバック（goal のみ・spec_dir 未設定） ----

describe("buildPrompt — v1 フォールバック（goal のみ）", () => {
  it("① product goal を含む（プロンプト冒頭の文脈）", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("ユーザー認証基盤を堅牢にし、不正ログインを防ぐ。");
    expect(out).toContain("# プロダクトのゴール");
  });

  it("② チケットの identifier/title/url/description を含む", () => {
    const out = buildPrompt(makeArgs());
    expect(out).toContain("TY-123");
    expect(out).toContain("ログイン画面のバリデーション追加");
    expect(out).toContain("https://linear.app/team-yubune/issue/TY-123");
    expect(out).toContain("メールアドレス形式とパスワード長を検証する。");
  });

  it("② description が空文字でもクラッシュせず他要素は揃う", () => {
    const out = buildPrompt(makeArgs({ issue: { ...baseIssue, description: "" } }));
    expect(out).toContain("TY-123");
    expect(out).toContain("(説明なし)");
  });

  it("③ 作業規則を全て含む", () => {
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

  it("④ digest が空のときは digest セクションを丸ごと省略する", () => {
    const out = buildPrompt(makeArgs({ digest: [] }));
    expect(out).not.toContain("直近の変更");
  });

  it("④ digest が非空のとき各1行で含む", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [
          { linearIdentifier: "TY-100", issueTitle: "DB接続プール導入", agentSummary: "プール上限を10に設定" },
          { linearIdentifier: "TY-101", issueTitle: "ログ整形", agentSummary: "JSON構造化ログへ移行" },
        ],
      }),
    );
    expect(out).toContain("直近の変更");
    expect(out).toContain("TY-100: DB接続プール導入 — プール上限を10に設定");
    expect(out).toContain("TY-101: ログ整形 — JSON構造化ログへ移行");
  });

  it("決定性: 同一入力なら完全一致の文字列を返す", () => {
    const args = makeArgs({
      digest: [{ linearIdentifier: "TY-300", issueTitle: "t", agentSummary: "s" }],
    });
    expect(buildPrompt(args)).toBe(buildPrompt(args));
  });

  it("v1 ブロック順序: goal → チケット → 作業規則 → digest", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-400", issueTitle: "t", agentSummary: "s" }],
      }),
    );
    const idxGoal = out.indexOf("プロダクトのゴール");
    const idxTicket = out.indexOf("担当チケット");
    const idxRules = out.indexOf("作業規則");
    const idxDigest = out.indexOf("直近の変更");
    expect(idxGoal).toBeGreaterThanOrEqual(0);
    expect(idxGoal).toBeLessThan(idxTicket);
    expect(idxTicket).toBeLessThan(idxRules);
    expect(idxRules).toBeLessThan(idxDigest);
  });
});

// ---- v2 注入レイアウト（spec_dir 設定時 / B1 グラウンディング） ----

const sampleSpecContent: PromptArgs["specContent"] = {
  requirements: "## 要求仕様\n\nプロダクトの要求全文がここに入る。",
  domainSpecs: [
    { name: "core-loop", content: "コアループの要件定義。SELECT→IMPLEMENT→DONE。" },
    { name: "grounding", content: "B1 グラウンディングの要件定義。" },
  ],
};

function makeV2Args(overrides: Partial<PromptArgs> = {}): PromptArgs {
  return {
    goal: null,
    specContent: sampleSpecContent,
    issue: baseIssue,
    digest: [],
    ...overrides,
  };
}

describe("buildPrompt — v2 注入レイアウト（B1 グラウンディング）", () => {
  it("① 要求（requirements.md 全文）を注入する", () => {
    const out = buildPrompt(makeV2Args());
    expect(out).toContain("# 要求（プロダクト要求）");
    expect(out).toContain("プロダクトの要求全文がここに入る。");
  });

  it("① specContent がある場合はゴールブロックを出さない", () => {
    const out = buildPrompt(makeV2Args({ goal: "旧ゴール" }));
    expect(out).not.toContain("プロダクトのゴール");
    expect(out).not.toContain("旧ゴール");
  });

  it("② 要件定義の全領域ファイルを注入する（B1-a: 選別ゼロ）", () => {
    const out = buildPrompt(makeV2Args());
    expect(out).toContain("# 要件定義");
    expect(out).toContain("## core-loop");
    expect(out).toContain("コアループの要件定義。");
    expect(out).toContain("## grounding");
    expect(out).toContain("B1 グラウンディングの要件定義。");
  });

  it("② 要件定義が空のときはセクション自体を省略する", () => {
    const out = buildPrompt(makeV2Args({
      specContent: { requirements: "要求のみ", domainSpecs: [] },
    }));
    expect(out).not.toContain("# 要件定義");
  });

  it("v2 ブロック順序: 要求 → 要件定義 → チケット → 作業規則 → digest", () => {
    const out = buildPrompt(
      makeV2Args({
        digest: [{ linearIdentifier: "TY-500", issueTitle: "t", agentSummary: "s" }],
      }),
    );
    const idxReq = out.indexOf("要求（プロダクト要求）");
    const idxSpec = out.indexOf("# 要件定義");
    const idxTicket = out.indexOf("担当チケット");
    const idxRules = out.indexOf("作業規則");
    const idxDigest = out.indexOf("直近の変更");
    expect(idxReq).toBeGreaterThanOrEqual(0);
    expect(idxReq).toBeLessThan(idxSpec);
    expect(idxSpec).toBeLessThan(idxTicket);
    expect(idxTicket).toBeLessThan(idxRules);
    expect(idxRules).toBeLessThan(idxDigest);
  });
});

// ---- グラウンディングなし（goal=null, specContent=null） ----

describe("buildPrompt — グラウンディングなし", () => {
  it("goal も specContent も無い場合はチケット・規則のみ出力する", () => {
    const out = buildPrompt(makeArgs({ goal: null, specContent: null }));
    expect(out).not.toContain("プロダクトのゴール");
    expect(out).not.toContain("要求（プロダクト要求）");
    expect(out).toContain("担当チケット");
    expect(out).toContain("作業規則");
  });
});

// ---- B1-b: digest 格下げ ----

describe("buildPrompt — B1-b digest 格下げ", () => {
  it("digest の見出しが de-emphasize されている（「軽い手がかり / 任意」）", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-600", issueTitle: "t", agentSummary: "s" }],
      }),
    );
    expect(out).toContain("直近の変更（軽い手がかり / 任意）");
  });

  it("agentSummary が null のエントリは summary 部を (要約なし) にする", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-102", issueTitle: "リファクタ", agentSummary: null }],
      }),
    );
    expect(out).toContain("TY-102: リファクタ — (要約なし)");
  });

  it("agentSummary が複数行の場合は最初の行のみ（1行 truncate）", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{
          linearIdentifier: "TY-700",
          issueTitle: "大改修",
          agentSummary: "1行目の要約\n2行目の詳細\n3行目の補足",
        }],
      }),
    );
    expect(out).toContain("TY-700: 大改修 — 1行目の要約");
    expect(out).not.toContain("2行目の詳細");
    expect(out).not.toContain("3行目の補足");
  });

  it("agentSummary が改行のみの場合は (要約なし) にフォールバック", () => {
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-701", issueTitle: "t", agentSummary: "\n\n" }],
      }),
    );
    expect(out).toContain("TY-701: t — (要約なし)");
  });

  it("agentSummary が 200 文字を超える場合は 200 文字 + 省略記号で切る", () => {
    const longSummary = "あ".repeat(300);
    const out = buildPrompt(
      makeArgs({
        digest: [{ linearIdentifier: "TY-702", issueTitle: "t", agentSummary: longSummary }],
      }),
    );
    expect(out).toContain("あ".repeat(200) + "…");
    expect(out).not.toContain("あ".repeat(201));
  });

  it("digest が空配列なら省略（digest.enabled=false 時は呼び出し側が空配列を渡す）", () => {
    const out = buildPrompt(makeArgs({ digest: [] }));
    expect(out).not.toContain("直近の変更");
  });

  it("digest の行順は入力配列の順序を保つ（決定的）", () => {
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
});
