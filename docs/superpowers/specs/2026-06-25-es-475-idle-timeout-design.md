# ES-475: アイドルタイムアウトでループ自動停止

> ステータス: **設計レビュー中**
> 日付: 2026-06-25
> Linear: [ES-475](https://linear.app/edereship/issue/ES-475)

## 1. 背景と課題

適格チケットがない状態では `idle_recheck_seconds`（既定5分）ごとに無限ループし続ける。毎ループで GROOM（Codex 起動）が走るため、長時間放置すると Codex のコスト空振りが積み上がる。

アイドル状態が一定時間続いた場合にループを自動停止（HALT）する機能を追加する。

## 2. 期待される挙動

1. チケットが見つからずアイドル状態に入る → `idle_started_at` を DB に記録
2. 毎ループ先頭でアイドル経過時間をチェック
3. `idle_timeout_minutes` を超過 → HALT + Slack 通知（`reason: "idle_timeout"`）
4. チケットが見つかり running に復帰 → `idle_started_at` クリア（タイマーリセット）
5. プロセス再起動 → DB から `idle_started_at` を読み出し、経過時間を引き継ぐ
6. `idle_timeout_minutes = 0` → タイムアウト無効（現行動作と同じ無限ループ）

## 3. 詳細設計

### 3.1 Config（config.ts）

`[loop]` セクションの Zod スキーマに `idle_timeout_minutes` を追加:

```typescript
loop: z.object({
  monitor_poll_seconds: z.number().int().positive(),
  idle_recheck_seconds: z.number().int().positive(),
  idle_timeout_minutes: z.number().int().nonnegative().default(120),
}).strict(),
```

Config interface に対応フィールドを追加:

```typescript
loop: {
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  idleTimeoutMinutes: number;  // 0 = disabled
};
```

`loadConfig` の return 文に `idleTimeoutMinutes: raw.loop.idle_timeout_minutes` を追加。

### 3.2 Types（types.ts）

`RunRow` に `idleStartedAt` を追加:

```typescript
export interface RunRow {
  id: number;
  startedAt: string;
  taskCap: number;
  state: RunState;
  haltReason: string | null;
  pauseMeta: PauseMeta | null;
  idleStartedAt: string | null;
}
```

`NotifyEvent` の変更は不要。既存の `{ kind: "halted"; reason: string; detail: string }` を `reason: "idle_timeout"` で再利用する。

### 3.3 Store（store.ts）

#### DB スキーマ

`run` テーブルに `idle_started_at TEXT` カラムを追加。

#### マイグレーション

`migrate()` に既存パターンで追加:

```typescript
if (!runColumns.has("idle_started_at")) {
  this.db.exec(`ALTER TABLE run ADD COLUMN idle_started_at TEXT`);
}
```

`pause_meta` マイグレーション（テーブル再作成）より後に配置する。`pause_meta` が存在しない古い DB ではテーブル再作成が先に走り、その後に `idle_started_at` が追加される。`pause_meta` が既にある DB では `ALTER TABLE ADD COLUMN` のみ。

#### RawRunRow / toRunRow

`RawRunRow` に `idle_started_at: string | null` を追加し、`toRunRow()` で `idleStartedAt` にマッピング。

#### 新メソッド

```typescript
setIdleStartedAt(id: number, isoTimestamp: string): void {
  this.db.prepare(
    `UPDATE run SET idle_started_at = ? WHERE id = ? AND idle_started_at IS NULL`
  ).run(isoTimestamp, id);
}

clearIdleStartedAt(id: number): void {
  this.db.prepare(
    `UPDATE run SET idle_started_at = NULL WHERE id = ?`
  ).run(id);
}
```

`setIdleStartedAt` は `WHERE idle_started_at IS NULL` で冪等。既にセット済みなら no-op。`changes` チェックは行わない（0 rows affected が正常ケース）。

`clearIdleStartedAt` も `changes` チェックは不要（running 状態で呼ばれた場合に既に NULL でも問題ない）。

### 3.4 Orchestrator（orchestrator.ts）

#### A. ループ頭にアイドルタイムアウトチェック

task cap チェック（L682-688）の直後に配置:

```typescript
// 1.5) アイドルタイムアウトチェック
const idleTimeoutMin = this.config.loop.idleTimeoutMinutes;
if (idleTimeoutMin > 0) {
  const run = this.store.getRun(this.runId);
  if (run.idleStartedAt !== null) {
    const elapsedMs = Date.parse(this.clock()) - Date.parse(run.idleStartedAt);
    if (elapsedMs >= idleTimeoutMin * 60_000) {
      const detail = `idle timeout: no eligible tickets for ${idleTimeoutMin} minutes`;
      await this.notifier.notify({ kind: "halted", reason: "idle_timeout", detail });
      await this.commitMemoryBeforeHalt();
      this.store.setRunState(this.runId, "halted", detail);
      this.log(detail);
      return;
    }
  }
}
```

既存の task_cap HALT パターン（notify → commitMemory → setRunState → log → return）に完全準拠。

#### B. idle ブロックで idle_started_at をセット

`eligible.length === 0` ブロック（L730-738）に1行追加:

```typescript
if (eligible.length === 0) {
  if (!idleNotified) {
    await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
    idleNotified = true;
  }
  this.store.setIdleStartedAt(this.runId, this.clock());  // NEW
  this.store.setRunState(this.runId, "idle");
  await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
  continue;
}
```

`setIdleStartedAt` は冪等（NULL 時のみ書込み）なので、毎ループ安全に呼べる。

#### C. running 復帰時に idle_started_at をクリア

eligible 発見後の復帰ブロック（L740-742）に1行追加:

```typescript
idleNotified = false;
this.store.clearIdleStartedAt(this.runId);  // NEW
this.store.setRunState(this.runId, "running");
```

### 3.5 Status（status.ts）

`renderStatus` で idle 状態時に `idle since:` を表示:

```typescript
if (run.state === "idle" && run.idleStartedAt !== null) {
  lines.push(`  idle since: ${run.idleStartedAt}`);
}
```

halted 状態で `idle_timeout` の場合は既存の `halt reason:` 行でカバーされる。

### 3.6 Example TOML（looppilot-os.example.toml）

`[loop]` セクションにコメント付きで追加:

```toml
[loop]
monitor_poll_seconds = 60
idle_recheck_seconds = 300
# idle_timeout_minutes = 120  # 適格チケット不在でのアイドル時間上限（既定120分）。0 = 無効
```

## 4. 終了コード

`EXIT_HALTED (2)` を使用。idle timeout は自動停止だが、ループが HALT した事実に変わりない。`main.ts` の既存マッピング `run.state === "halted" → EXIT_HALTED` がそのまま適用される。変更不要。

## 5. テスト方針

`tests/orchestrator.test.ts` に以下のケースを追加:

| # | ケース | 検証内容 |
|---|--------|----------|
| 1 | タイムアウト発動 | idle 経過 >= `idleTimeoutMinutes` → HALT + 通知 `reason: "idle_timeout"` + `halt_reason` に detail |
| 2 | タイムアウト未到達 | idle 経過 < `idleTimeoutMinutes` → HALT しない、sleep + recheck 継続 |
| 3 | running 復帰でリセット | idle → チケット発見 → `idle_started_at` クリア → 再度 idle → タイマー 0 から再開 |
| 4 | 無効化 | `idle_timeout_minutes = 0` → idle が無限に継続、HALT しない |
| 5 | DB 永続性 | DB に `idle_started_at` が残った状態で `getRun()` → 経過時間を引き継いでタイムアウト判定 |

## 6. 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `src/config.ts` | Zod スキーマ + Config interface + loadConfig |
| `src/types.ts` | `RunRow.idleStartedAt` 追加 |
| `src/store.ts` | `idle_started_at` カラム + migrate + `setIdleStartedAt()` / `clearIdleStartedAt()` + RawRunRow / toRunRow |
| `src/orchestrator.ts` | タイムアウトチェック + idle_started_at セット + クリア |
| `src/status.ts` | idle 状態表示に `idle since:` 追加 |
| `looppilot-os.example.toml` | `idle_timeout_minutes` コメント追加 |
| `tests/orchestrator.test.ts` | 5 テストケース追加 |
