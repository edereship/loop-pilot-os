### Task 11: Context Bundle

**目的（2-3行）:** 毎セッションで claude に渡す決定的プロンプト文字列を組み立てる純粋関数 `buildPrompt(args: PromptArgs): string` を実装する。プロンプトは①product goal ②チケット ③作業規則 ④直近マージ済み digest の4ブロックから成り、同入力なら必ず同出力（副作用・時刻・乱数を含まない）。

> **設計ノート（仕様 §3 文脈5要素のトレーサビリティ）:** 仕様 §3 の文脈行「コード+チケット+ゴール+CLAUDE.md+直近N件のマージ済みセッション要約」のうち、**『コード』と『CLAUDE.md』は `buildPrompt` には注入しない**。これらは claude を worktree を cwd として起動する（Task 9 / カーネル §5.1：spawn の `cwd` = worktree）ことで暗黙に文脈へ入る — リポジトリのコードツリーと CLAUDE.md は worktree 内に物理的に存在し、claude が起動ディレクトリから読み取る。したがって `buildPrompt` が明示的に組み立てる責務は残りの3要素（ゴール / チケット / digest）＋作業規則に限られる。この分担により仕様 §3 の文脈5要素はすべてトレース可能になる（コード・CLAUDE.md=cwd 経由の暗黙注入、ゴール・チケット・digest=buildPrompt の明示注入）。

**依存タスク:** Task 2（`src/types.ts` の `PromptArgs` / `EligibleIssue` / `TaskSessionRow`）。`PromptArgs` は Orchestrator（Task 12）の IMPLEMENT フェーズが `store.recentMergedSummaries(config.digest.recentMergedCount)` の戻り値を `digest` にそのまま渡して呼ぶ（カーネル §7-4）。本タスクはその関数本体とテストのみを作る。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/context-bundle.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/context-bundle.test.ts`

> 契約（カーネル §2、一字一句）:
> ```typescript
> export interface PromptArgs {
>   goal: string;                                   // config.product.goal
>   issue: EligibleIssue;
>   digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
> }
> // context-bundle.ts は export function buildPrompt(args: PromptArgs): string を公開
> ```
> `EligibleIssue` は `{ id; identifier; title; description; priority; sortOrder; url }`。本タスクはこのうち `identifier`/`title`/`url`/`description` のみ使う（仕様 §8 文脈の「チケット」）。
> `digest` 各要素は `{ linearIdentifier; issueTitle; agentSummary }`。`agentSummary` は `string | null`（`TaskSessionRow.agentSummary` の型）。
> プロンプト本文は日本語混在可・決定的（同入力同出力）。

---

- [ ] **Step 1: 失敗するテストを書く（4ブロックの包含・digest 空/null・決定性）**

`/home/racoma-dev/loop-pilot-os/tests/context-bundle.test.ts` を新規作成（完全形）:

```typescript
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/context-bundle.test.ts`
Expected: FAIL — `src/context-bundle.ts` が存在しないため `Failed to resolve import "../src/context-bundle.js"`（モジュール解決エラー）。全テストが collect 段階で落ちる。

- [ ] **Step 3: 最小実装を書く（`src/context-bundle.ts`、完全形）**

`/home/racoma-dev/loop-pilot-os/src/context-bundle.ts` を新規作成:

```typescript
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
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/context-bundle.test.ts`
Expected: PASS — 全 10 ケース green（`Test Files 1 passed`, `Tests 10 passed`、`failed 0`）。

- [ ] **Step 5: 型チェック含む全体検査を実行する**

Run: `cd /home/racoma-dev/loop-pilot-os && npm run check`
Expected: PASS — `tsc`（src）+ `tsc`（test 用 tsconfig）+ `vitest` が全て成功（exit 0）。新規 export `buildPrompt` と `PromptArgs` import が型整合。

- [ ] **Step 6: red-green の単位でコミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/context-bundle.ts tests/context-bundle.test.ts && git commit -m "feat: add buildPrompt context bundle (§3 文脈)"
```
