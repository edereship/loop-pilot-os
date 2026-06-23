# ES-450: セッション停止時の Codex リカバリーターン

## 目的

セッションが停止した場合、人間の手動介入の前に Codex（PM）に停止状況を分析させ、1回のリカバリーを試行する。

## アーキテクチャ

```
stopSession()
  → recovery gate (cost_exceeded 除外, recovery_attempted==false)
    → RecoveryTurn.attempt()
      → CodexPlanner.run() でリカバリープロンプト送信
      → JSON パース（失敗時 → escalate フォールバック）
      → アクションディスパッチ
    → 成功 (fix_code/rebase/restart_review): CONTINUE → モニタリング復帰
    → escalate/abandon/失敗: 通常停止フローへ
```

## 発火条件

`stopSession()` の冒頭でチェック:

1. `reason !== "cost_exceeded"` — 予算超過は追加コスト投入NG
2. `session.recoveryAttempted === false` — 1回制限（無限ループ防止）

全停止理由が対象。Codex に判断を委ね、リカバリー不要なケース（pr_closed で人間が意図的に閉じた等）は Codex 自身が `escalate` / `abandon` を選択する。

## 既存 AgentWorkflowRecovery との関係

既存の `workflow_failed` → `AgentWorkflowRecovery` パスはそのまま残す。既存回復が上限に達して `stopSession` が呼ばれた場合に、追加で Codex リカバリーターンが発火する。二段構え。

## Codex 出力スキーマ

```json
{
  "action": "fix_code" | "rebase" | "restart_review" | "escalate" | "abandon",
  "instruction": "<Claude Code への指示テキスト（fix_code 時は必須、他は任意）>"
}
```

## アクション実行

### fix_code
1. Codex の `instruction` を Claude Code に渡して `AgentRunner.runSession()` で worktree 修正
2. コミット確認（uncommitted changes / no commits → escalate）
3. `git push origin HEAD:<branch>`
4. `/restart-review` コメント投稿
5. セッション state を `in_review` に戻し、`monitorStartedAt` をリセット

### rebase
1. `git fetch origin <default-branch>`
2. `git rebase origin/<default-branch>`
3. コンフリクト発生時: AgentRunner に解消を委託
4. `git push --force-with-lease origin HEAD:<branch>`
5. `/restart-review` コメント投稿
6. セッション state を `in_review` に戻し、`monitorStartedAt` をリセット

### restart_review
1. `git.postComment(prNumber, "/restart-review")`
2. セッション state を `in_review` に戻し、`monitorStartedAt` をリセット

### escalate
何もせず、通常の停止フローへ（現状と同じ動作）。

### abandon
1. PR クローズ（`gh pr close`）
2. Linear チケットを Todo に戻す（`source.transition(issueId, "todo")`）
3. worktree 破棄
4. 通常の停止フローへ（ただし通知はabandon用）

## Codex 入力コンテキスト

- 停止理由（stop reason string）
- セッション状態（state, pr_number, branch, cost_usd, failure_reason, stop_detail）
- agent_summary（直近のエージェント出力）
- plan_brief（生成済みの場合）
- Linear チケット情報（identifier, title）
- CI ログ（`gh run list` + `gh run view --log-failed` で取得、best-effort）

## DB 変更

`task_session` に2カラム追加:

```sql
ALTER TABLE task_session ADD COLUMN recovery_attempted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_session ADD COLUMN recovery_action TEXT;
```

`migrate()` で冪等に追加。`SESSION_PATCH_COLUMNS`、`RawSessionRow`、`toSessionRow` を更新。

## stopSession 変更

戻り値を `Promise<{ control: "halt" }>` から `Promise<RunControl>` に変更。

```typescript
private async stopSession(
  session: TaskSessionRow,
  reason: FailureReason,
  detail: string | null,
  extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber">> = {},
): Promise<RunControl> {
  // --- Recovery gate ---
  if (reason !== "cost_exceeded") {
    const fresh = this.store.getSession(session.id);
    if (!fresh.recoveryAttempted) {
      this.store.updateSession(session.id, { recoveryAttempted: 1 });
      const result = await this.recoveryTurn.attempt({
        session: fresh, reason, detail,
        planner: this.planner, agent: this.agent, git: this.git,
        source: this.source, config: this.config, ...
      });
      this.store.updateSession(session.id, {
        recoveryAction: result.action,
      });
      if (result.kind === "recovered") {
        // Notify recovery success
        await this.notifier.notify({ kind: "recovery_succeeded", ... });
        this.store.updateSession(session.id, {
          state: "in_review",
          monitorStartedAt: this.clock(),
          failureReason: null, stopDetail: null, endedAt: null,
        });
        return CONTINUE;
      }
      // escalated / abandoned / failed → fall through to normal stop
    }
  }
  // --- Original stop logic (unchanged) ---
  this.store.updateSession(session.id, { state: "stopped", ... });
  await this.notifier.notify({ kind: "halted", ... });
  this.store.setRunState(this.runId, "halted", ...);
  return HALT;
}
```

呼び出し元は既に `if (ctrl.control === "halt") return HALT` パターン。`CONTINUE` が返ると:
- `monitorSession` 内: `continue` でモニタリングループ再開
- `implement` / `handoff` 内: `CONTINUE` で次フェーズへ進行

## コスト制約

`config.safety.maxCostUsdPerFix` (デフォルト2) を流用。Codex 呼び出し + Claude Code 実行の合計。

## 通知

- リカバリー試行開始: `{ kind: "recovery_started", identifier, reason }`
- リカバリー成功: `{ kind: "recovery_succeeded", identifier, action }`
- escalate/abandon: 既存の halted 通知に recovery_action を含める

`NotifyEvent` ユニオンに `recovery_started` / `recovery_succeeded` を追加。

## モジュール構成

### `src/recovery-turn.ts` (新規)

```typescript
export type RecoveryActionKind = "fix_code" | "rebase" | "restart_review" | "escalate" | "abandon";

export interface RecoveryAction {
  action: RecoveryActionKind;
  instruction?: string;
}

export type RecoveryTurnResult =
  | { kind: "recovered"; action: RecoveryActionKind; costUsd: number }
  | { kind: "escalated"; action: "escalate" | "abandon" }
  | { kind: "failed"; message: string };

export interface RecoveryTurnDeps {
  planner: PlanRunner;
  agent: AgentRunner;
  git: GitPrManager;
  runner: CommandRunner;
  source: TaskSource;
  config: Config;
  log: (line: string) => void;
}

export function buildRecoveryPrompt(ctx: RecoveryPromptContext): string;
export function parseRecoveryAction(text: string): RecoveryAction;
export async function executeRecoveryTurn(
  deps: RecoveryTurnDeps, session: TaskSessionRow,
  reason: FailureReason, detail: string | null,
): Promise<RecoveryTurnResult>;
```

### `src/types.ts` 変更

- `TaskSessionRow` に `recoveryAttempted: number` と `recoveryAction: string | null` 追加
- `NotifyEvent` に `recovery_started` / `recovery_succeeded` 追加

## 受け入れ条件

- `npm run check` グリーン
- 各停止理由 → Codex リカバリー → アクション実行のフローがテストで固定
- JSON パース失敗 → escalate フォールバックのテスト
- `cost_exceeded` → リカバリーをスキップするテスト
- `recovery_attempted = true` の再停止 → escalate（1回制限）のテスト
- 既存 `AgentWorkflowRecovery` のテストが壊れないこと
