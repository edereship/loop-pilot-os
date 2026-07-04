# ES-502: GROOM メモリ注入をカテゴリ均等配分に統一 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GROOM プロンプトのメモリ注入を `buildMemoryBlock()` 経由に差し替え、予算超過時に全カテゴリが均等に切り詰められるようにする。

**Architecture:** `groom-prompt.ts` の手動メモリ組立+単純 slice を、他4フェーズ（SELECT/PLAN/context-bundle/self-review）と同じ `buildMemoryBlock()` 呼び出しに置換する。`buildMemoryBlock` は既に N カテゴリ均等配分対応済みなので変更不要。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- `src/memory-inject.ts` は変更しない（既に N カテゴリ対応済み）。
- `tests/memory-inject.test.ts` 既存 12 件は緑のまま。
- SELECT / PLAN / context-bundle / self-review の注入挙動は不変。
- `npm run check` 全パス。

---

### Task 1: GROOM メモリ注入を buildMemoryBlock に差し替え + テスト更新

**Files:**
- Modify: `src/groom-prompt.ts:1` (import 追加)
- Modify: `src/groom-prompt.ts:205-222` (メモリブロック組立を差し替え)
- Modify: `tests/groom-prompt.test.ts:512-533` (truncation テスト更新)
- Modify: `tests/groom-prompt.test.ts` (新規テスト追加)

**Interfaces:**
- Consumes: `buildMemoryBlock(entries: MemoryEntry[], budgetChars: number): string` from `src/memory-inject.ts`
- Produces: 変更なし（`buildGroomPrompt` の公開シグネチャは不変）

- [ ] **Step 1: 新規テストを追加 — 予算超過時に 3 カテゴリ全てが残ることを検証**

`tests/groom-prompt.test.ts` の `describe("buildGroomPrompt — memory injection budget")` ブロック末尾（545 行目の `});` の前）に追加:

```typescript
  it("preserves all three categories under budget pressure with balanced allocation (ES-502)", () => {
    const args = makeGroomArgs({
      memory: {
        pmDecisions: "D".repeat(3000),
        implResults: "I".repeat(3000),
        productKnowledge: "K".repeat(3000),
      },
      memoryBudgetChars: 500,
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("## PM Decisions");
    expect(out).toContain("## Implementation Results");
    expect(out).toContain("## Product Knowledge");
    // Each category has some content (not entirely eliminated)
    expect(out).toContain("DDD");
    expect(out).toContain("III");
    expect(out).toContain("KKK");
    // Truncation markers present
    expect(out).toContain("[...省略...]");
  });
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run tests/groom-prompt.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: 新規テスト "preserves all three categories under budget pressure with balanced allocation (ES-502)" が FAIL。現行の単純 slice では Product Knowledge が丸ごと欠落するため `## Product Knowledge` が見つからない。

- [ ] **Step 3: `groom-prompt.ts` に import を追加**

`src/groom-prompt.ts` 1 行目の後に追加:

```typescript
import { buildMemoryBlock } from "./memory-inject.js";
```

- [ ] **Step 4: メモリブロック組立を `buildMemoryBlock` 呼び出しに差し替え**

`src/groom-prompt.ts` 205-222 行目を以下に置換:

```typescript
  // 3. Cross-task memory (all 3 categories: D-23)
  const memoryEntries = [
    ...(memory.pmDecisions ? [{ label: "PM Decisions", content: memory.pmDecisions }] : []),
    ...(memory.implResults ? [{ label: "Implementation Results", content: memory.implResults }] : []),
    ...(memory.productKnowledge ? [{ label: "Product Knowledge", content: memory.productKnowledge }] : []),
  ];
  const memoryBlock = buildMemoryBlock(memoryEntries, memoryBudgetChars);
  if (memoryBlock.length > 0) blocks.push(memoryBlock);
```

- [ ] **Step 5: 既存の truncation テストを更新**

`tests/groom-prompt.test.ts` 512-533 行目の `it("truncates memory block when total size exceeds memoryBudgetChars", ...)` を以下に置換:

```typescript
  it("truncates memory block when total size exceeds memoryBudgetChars", () => {
    const longText = "x".repeat(3000);
    const args = makeGroomArgs({
      memory: {
        pmDecisions: longText,
        implResults: longText,
        productKnowledge: longText,
      },
      memoryBudgetChars: 200,
    });
    const out = buildGroomPrompt(args);
    expect(out).toContain("# 横断メモリ");
    expect(out).toContain("[...省略...]");
    // With balanced allocation, all 3 categories survive truncation
    expect(out).toContain("## PM Decisions");
    expect(out).toContain("## Implementation Results");
    expect(out).toContain("## Product Knowledge");
  });
```

- [ ] **Step 6: 全テストを実行して緑を確認**

Run: `npx vitest run tests/groom-prompt.test.ts tests/memory-inject.test.ts --reporter=verbose 2>&1 | tail -40`

Expected: groom-prompt テスト全件 PASS（新規テスト含む）、memory-inject テスト 12 件 PASS。

- [ ] **Step 7: `npm run check` を実行して全パスを確認**

Run: `npm run check 2>&1 | tail -20`

Expected: 型チェック・lint・全テスト PASS。

- [ ] **Step 8: コミット**

```bash
git add src/groom-prompt.ts tests/groom-prompt.test.ts
git commit -m "feat: use buildMemoryBlock for GROOM memory injection (ES-502)

Replace manual memory block assembly + naive slice with shared
buildMemoryBlock(), ensuring all 3 categories survive budget
truncation via balanced per-category allocation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
