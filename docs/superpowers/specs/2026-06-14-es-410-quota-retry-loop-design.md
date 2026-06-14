# ES-410: Codex quota リトライループ

> ステータス: **設計レビュー中**
> 日付: 2026-06-14
> Linear: [ES-410](https://linear.app/edereship/issue/ES-410)
> 依存: [ES-409](https://linear.app/edereship/issue/ES-409)（stopReason 分類関数 + postComment）

## 1. 背景と課題

MONITOR フェーズで LoopPilot が `codex_usage_limit`（Codex quota exhausted）で停止した場合、現行の実装は `quota_wait` カテゴリを `human_required` と同じく即 HALT する。

Codex の quota は時間経過で回復するため、人間の介入なしに自動リトライが可能。1時間間隔で最大6回（計6時間）リトライし、回復しなければ諦める。

### なぜ6時間か

Codex には5時間の日次制限に加えて週次制限も存在する可能性があるため、5時間制限の回復だけでなく週次リセットも考慮して6時間を上限とする。

## 2. 期待される挙動

1. `codex_usage_limit` 検知 → 初回のみ Slack 通知（quota_waiting）
2. 1時間 sleep（割り込み対応: 10秒チャンク）
3. `/restart-review` を PR に投稿
4. ポーリング続行
5. `in_progress` 検知で quota 回復を確認 → Slack 通知（quota_resumed）+ カウンタリセット
6. 6回リトライ超過 → HALT + Slack 通知（既存の halted イベント）

## 3. 詳細設計

### 3.1 Types（types.ts）

`NotifyEvent` に2種追加:

```typescript
export type NotifyEvent =
  | { kind: "halted"; reason: string; detail: string }
  | { kind: "idle"; detail: string }
  | { kind: "run_started"; detail: string }
  | { kind: "task_started"; identifier: string; title: string }
  | { kind: "task_merged"; identifier: string; title: string; mergedCount: number }
  | { kind: "quota_waiting"; detail: string }   // 新規
  | { kind: "quota_resumed"; detail: string };   // 新規
```

### 3.2 Notifier（notifier.ts）

`formatNotifyEvent` に2分岐を追加:

```typescript
case "quota_waiting":
  return `⏳ Codex quota 待機中: ${event.detail}`;
case "quota_resumed":
  return `🔄 Codex quota 回復: ${event.detail}`;
```

6時間諦めは既存の `halted`（🛑）イベントを再利用する。

### 3.3 Orchestrator（orchestrator.ts）

#### quota リトライループ

`monitorSession` の `stopped` 分岐内、`quota_wait` カテゴリの処理を変更:

```
現行: quota_wait → 即 HALT（human_required と同じフォールスルー）
変更後:
  quota_wait →
    quotaRetryCount++
    quotaRetryCount > 6 → stopSession → HALT + Slack 通知（諦め）
    quotaRetryCount <= 6 →
      quotaRetryCount === 1 → Slack 通知（初回 quota_waiting）
      1時間 sleep（割り込み対応）
      postComment(prNumber, "/restart-review")
      continue（ポーリング続行）
```

- `quotaRetryCount` は `monitorSession` のローカル変数（`autoRestartCount` とは独立）
- `autoRestartCount` との相互作用: quota リトライ中に `auto_restart` カテゴリの停止が来ることは想定しない（`codex_usage_limit` は quota 回復まで同じ理由で停止し続ける）

#### quota 回復検知

`in_progress` verdict 受信時、`quotaRetryCount > 0` であれば:
- `quota_resumed` 通知を送信
- `quotaRetryCount` を `0` にリセット

#### 割り込み対応 sleep

1時間 sleep を10秒チャンクのループに分割:

```typescript
const QUOTA_WAIT_MS = 60 * 60 * 1000; // 1時間
const QUOTA_SLEEP_CHUNK_MS = 10_000;   // 10秒
for (let elapsed = 0; elapsed < QUOTA_WAIT_MS; elapsed += QUOTA_SLEEP_CHUNK_MS) {
  if (this.interrupted) {
    await this.haltForInterrupt();
    return HALT;
  }
  await this.sleep(QUOTA_SLEEP_CHUNK_MS);
}
```

既存の poll 境界の割り込みチェックパターンと一貫性あり。

### 3.4 設計上の不変条件

- リトライ中も既存のシーケンシャル動作を維持（他タスクに進まない）
- `quotaRetryCount` は `autoRestartCount` と完全に独立（相互にリセットしない）
- `quotaRetryCount` は永続化しない（ローカル変数）。プロセス再起動時はリカバリ経路で `monitorSession` に再突入し、カウンタは0から再開する。6時間制限は最悪ケースで延長されるが、quota 回復済みなら次の poll で `in_progress` が返り即再開するため実害なし
- Slack 通知の初回限定は `quotaRetryCount === 1` で判定（2回目以降のリトライでは通知しない）

## 4. テスト方針

| テストケース | 検証内容 |
|---|---|
| quota 検知 → 1時間待機 → /restart-review 投稿 | sleep 時間、postComment 呼び出し |
| リトライ6回超 → HALT | stopSession(looppilot_stopped) + 通知 |
| quota 回復（in_progress 検知）→ 再開通知 + カウンタリセット | quota_resumed 通知、quotaRetryCount リセット確認 |
| 初回通知 / 再開通知 / 諦め通知の内容確認 | NotifyEvent の kind と detail |
| autoRestartCount との独立性確認 | quota リトライが autoRestartCount に影響しない |
| 割り込み（requestStop）時の sleep 中断 | HALT + in_review のまま（クリーン停止） |
| formatNotifyEvent の新規分岐 | ⏳ / 🔄 の整形確認 |

## 5. 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/types.ts` | `NotifyEvent` に `quota_waiting` / `quota_resumed` 追加 |
| `src/notifier.ts` | `formatNotifyEvent` に2分岐追加 |
| `src/orchestrator.ts` | `monitorSession` の `quota_wait` 処理をリトライループに変更、`in_progress` に回復検知追加 |
| `tests/orchestrator.test.ts` | quota リトライの各テストケース追加 |
| `tests/notifier.test.ts` | `formatNotifyEvent` の新規分岐テスト追加 |
