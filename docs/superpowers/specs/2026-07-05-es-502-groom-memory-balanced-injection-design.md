# ES-502: GROOM プロンプトの横断メモリ注入をカテゴリ均等配分にする

## 背景

SELECT / PLAN / DESIGN(context-bundle) / SELF-REVIEW のメモリ注入は `buildMemoryBlock()`（`src/memory-inject.ts`）を使い、予算超過時にカテゴリ均等配分で切り詰める。GROOM だけが `buildGroomPrompt` 内で独自に結合後ブロックの `slice(0, memoryBudgetChars)` を行っており、結合順で後ろにある Product Knowledge カテゴリが丸ごと欠落し得る。

D-23 は GROOM を「全 3 カテゴリを見るフェーズ」と定めており、予算超過時に特定カテゴリが消える挙動は D-23 の意図に反する。v4-A（OBSERVE）でメモリ成長が見込まれるため、今のうちにフェーズ間で一貫した劣化挙動に揃える。

## 設計

### 変更: `src/groom-prompt.ts`

`buildGroomPrompt` のメモリブロック組立（205-222 行）を、他フェーズと同じ `buildMemoryBlock()` 呼び出しに差し替える。

現行:
```typescript
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
  let memoryBlock = ["# 横断メモリ", "", ...memoryParts].join("\n\n");
  if (memoryBlock.length > memoryBudgetChars) {
    memoryBlock = memoryBlock.slice(0, memoryBudgetChars) + "\n[...省略...]";
  }
  blocks.push(memoryBlock);
}
```

変更後:
```typescript
import { buildMemoryBlock } from "./memory-inject.js";

const entries = [
  ...(memory.pmDecisions ? [{ label: "PM Decisions", content: memory.pmDecisions }] : []),
  ...(memory.implResults ? [{ label: "Implementation Results", content: memory.implResults }] : []),
  ...(memory.productKnowledge ? [{ label: "Product Knowledge", content: memory.productKnowledge }] : []),
];
const block = buildMemoryBlock(entries, memoryBudgetChars);
if (block.length > 0) blocks.push(block);
```

`buildMemoryBlock` は既に N カテゴリ対応（1〜N）で、`# 横断メモリ` ヘッダ + `## label` サブヘッダ + 均等配分切り詰め + `[...省略...]` マーカーを全て処理する。GROOM 側の組立・切り詰めロジックは不要になる。

### 変更: `tests/groom-prompt.test.ts`

1. 既存「truncates memory block when total size exceeds memoryBudgetChars」テスト: 均等配分後は 3 カテゴリ全てが残ることを検証に更新。
2. 既存「includes memory verbatim」テスト: 予算内なので変更なし。
3. 新規テスト追加: 「予算超過時に 3 カテゴリ全てがプロンプトに残る」ことを明示的に検証。

### 変更しないもの

- `src/memory-inject.ts` — 既に N カテゴリ対応済みで変更不要。
- `tests/memory-inject.test.ts` — 既存 12 件そのまま。
- SELECT / PLAN / context-bundle / self-review — 一切触らない。
- 予算既定値（`memory.inject_budget_chars` 6000）や D-23 のカテゴリ割当。

## 受け入れ条件

- 予算超過時に 3 カテゴリすべてが（切り詰められつつ）プロンプトに残る（テストで検証）。
- 予算内なら従来と同一出力（既存テストが緑）。
- SELECT / DESIGN 側の注入挙動は不変（`tests/memory-inject.test.ts` 既存 12 件が緑）。
- `npm run check` 全パス。
