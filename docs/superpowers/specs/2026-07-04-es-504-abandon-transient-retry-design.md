# ES-504: abandon 経路の transient リトライ適用 + haltIfRevertFailed 削除

**Date:** 2026-07-04
**Status:** Draft
**Ticket:** ES-504

## Background

ES-488 (N1) は transient リトライを CLAIM/HANDOFF 操作に限定した。abandon 経路は意図的にスコープ外とされたが、再評価の結果 N1 の次の増分として実施する。

abandon が C2 の核心（1件の詰まりで全停止しない）であるにもかかわらず、Linear/GitHub API の瞬断 1 回で halt に転化するのは C2 の自走目標に反する。

## Scope

### In

- abandon 経路の Linear transition / gh 呼び出しに `retryTransient` を適用
- `haltIfRevertFailed` デッドパラメータの削除
- ユニットテスト

### Out

- リトライ回数・バックオフの拡張（N1 の「1 回」を維持）
- MONITOR ポーリングの既存バックオフ再試行

## Contract

ES-488 の契約を変えない:

- transient 判定は `err.cause` 優先（`isTransientError` そのまま）
- リトライは `config.safety.transientRetryAttempts` 回（デフォルト 2 = 最大 3 試行）
- 決定的エラーは即 throw（リトライしない）

## Design

### 1. `executeAbandon` (recovery-turn.ts) — ステップ単位ラップ

3 ステップそれぞれを `retryTransient` でラップする。

#### PR close

`runner.run("gh", ["pr", "close", ...])` は exit code ベース。retryTransient のコールバック内で:

1. 非ゼロ exit code を検査
2. benign パターン (`already closed`) → throw しない（正常完了）
3. 非 benign → `throw new Error(msg, { cause: stderr })` で throw
4. `isTransientError` が `err.cause`（= stderr）を判定

```typescript
try {
  await retryTransient(config.safety.transientRetryAttempts, async () => {
    const closeResult = await runner.run("gh", ["pr", "close", ...], ...);
    if (closeResult.code !== 0) {
      const msg = closeResult.stderr.trim() || `exit ${closeResult.code}`;
      if (!/already\s*closed/i.test(msg)) {
        throw new Error(`PR close failed: ${msg}`, { cause: msg });
      }
      log(`recovery: abandon PR already closed, proceeding with cleanup`);
    }
  }, { onRetry: (n, e) => log(`transient retry ${n}: PR close: ${errMsg(e)}`) });
} catch (err) {
  log(`recovery: abandon PR close failed: ${errMsg(err)}`);
  return { kind: "failed", action: "abandon", message: `PR close failed: ${errMsg(err)}` };
}
```

#### Branch delete

同パターン。benign = `remote ref does not exist`。`runner.run` が throw するケース（spawn 失敗等）も retryTransient が分類。

```typescript
try {
  await retryTransient(config.safety.transientRetryAttempts, async () => {
    const deleteResult = await runner.run("git", ["push", "origin", "--delete", session.branch], ...);
    if (deleteResult.code !== 0) {
      const stderr = deleteResult.stderr.trim();
      if (!/remote ref does not exist/i.test(stderr)) {
        throw new Error(`remote branch delete failed: ${stderr}`, { cause: stderr });
      }
      log(`recovery: abandon remote branch already deleted`);
    }
  }, { onRetry: (n, e) => log(`transient retry ${n}: branch delete: ${errMsg(e)}`) });
} catch (err) {
  log(`recovery: abandon remote branch delete failed: ${errMsg(err)}`);
  return { kind: "failed", action: "abandon", message: `remote branch delete failed: ${errMsg(err)}` };
}
```

#### Ticket revert (Todo transition)

`source.transition` は既に throws。直接ラップ。

```typescript
try {
  await retryTransient(config.safety.transientRetryAttempts, () =>
    source.transition(session.linearIssueId, "todo"),
    { onRetry: (n, e) => log(`transient retry ${n}: ticket revert: ${errMsg(e)}`) },
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log(`recovery: abandon ticket revert failed: ${msg}`);
  return { kind: "failed", action: "abandon", message: `ticket revert to Todo failed: ${msg}` };
}
```

### 2. Pre-PR abandon (orchestrator.ts:4795) — Todo revert ラップ

`stopSession` 内の pre-PR abandon パス。CLAIM transition の ES-488 パターンと同じ形。

```typescript
try {
  await retryTransient(this.config.safety.transientRetryAttempts, () =>
    this.source.transition(session.linearIssueId, "todo"),
    { onRetry: (n, e) => this.log(`transient retry ${n}: todo revert for ${session.linearIdentifier}: ${errMsg(e)}`) },
  );
} catch (err) {
  todoRevertErr = errMsg(err);
  this.log(`policy-abandon: todo revert failed (ticket may be stuck): ${todoRevertErr}`);
  effectiveDetail = effectiveDetail
    ? `${effectiveDetail}; todo revert failed: ${todoRevertErr}`
    : `todo revert failed: ${todoRevertErr}`;
}
```

リトライ枯渇 or deterministic → catch → 従来どおり HALT。

### 3. `applyNeedsHumanTriage` (orchestrator.ts:4906, 4924) — best-effort リトライ

`addLabel` と `postComment` をそれぞれ `retryTransient` でラップ。best-effort 性は維持。

```typescript
try {
  await retryTransient(this.config.safety.transientRetryAttempts, () =>
    this.source.addLabel(session.linearIssueId, label),
    { onRetry: (n, e) => this.log(`transient retry ${n}: addLabel for ${session.linearIdentifier}: ${errMsg(e)}`) },
  );
  labelApplied = true;
  this.store.markNeedsHumanLabelAdded(session.id);
} catch (err) {
  this.log(`needs-human: addLabel failed for ${session.linearIdentifier} (non-fatal): ${errMsg(err)}`);
}
```

`postComment` も同様。

### 4. `haltIfRevertFailed` デッドパラメータ削除

- `stopSession` の `opts` 型から `haltIfRevertFailed` を削除
- 呼び出し側 2 箇所（line 1178, 1206）の `{ haltIfRevertFailed: true }` 引数を削除
- 挙動変更なし — 「pre-PR abandon の revert 失敗は常に halt」は `todoRevertErr !== null` → HALT の制御フローで既に自明

## Tests

ES-488 のテストパターン（makeHarness + monkey-patch + 呼び出し回数検証）に従う。

### テストケース

| # | 対象 | シナリオ | 検証 |
|---|------|----------|------|
| 1 | pre-PR abandon todo revert | transient → リトライ → 成功 | session stopped + recoveryAction=abandon + run 継続 |
| 2 | pre-PR abandon todo revert | deterministic → リトライなし | HALT + 呼び出し回数=1 |
| 3 | executeAbandon PR close | transient → リトライ → 成功 | abandon 完遂 + run 継続 |
| 4 | executeAbandon branch delete | transient → リトライ → 成功 | abandon 完遂 + run 継続 |
| 5 | executeAbandon ticket revert | transient → リトライ → 成功 | abandon 完遂 + run 継続 |
| 6 | executeAbandon PR close | deterministic → リトライなし | HALT + 呼び出し回数=1 |

### テスト対象外

- `applyNeedsHumanTriage` のリトライ — best-effort で制御フローに影響なし。`retryTransient` 自体のユニットテスト（既存）でカバー済み。

## Acceptance Criteria

- [ ] Todo 復帰 / PR close が 1 回目 transient → 2 回目成功のとき、abandon 完遂・Run 継続（ユニットテスト、呼び出し回数検証）
- [ ] 決定的エラー（4xx 系）は即 halt（リトライしない）のテスト
- [ ] `haltIfRevertFailed` が型・呼び出しから消え、`npm run check` 全パス
- [ ] 既存の ES-488 / ES-490 / ES-492 系テストが緑のまま
