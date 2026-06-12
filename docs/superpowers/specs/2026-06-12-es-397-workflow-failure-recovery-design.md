# ES-397: LoopPilot Loop workflow失敗時の自動検知・修正・レビュー再リクエスト

> ステータス: **設計承認済み**
> 日付: 2026-06-12
> Linear: [ES-397](https://linear.app/edereship/issue/ES-397)
> 関連: [ES-398](https://linear.app/edereship/issue/ES-398)（LoopPilot側⚠️プレフィックス統一）

## 1. 背景と課題

LoopPilotのLoop workflow（GitHub Actions）がセットアップステップで失敗した場合（例: `package-lock.json`不足で`actions/setup-node`が失敗）、PRに⚠️エラーコメントが投稿されるが、`looppilot-state`は`initialized`のまま変わらない。

現行のMONITORはstateコメント・merged・pr_closedのみ監視しているため、`not_engaged_guard_minutes`のタイムアウトまで無為に待ち続ける。

### 発生した具体例

- E2Eリポに`package-lock.json`がなく`actions/setup-node@v5`のnpmキャッシュステップが失敗
- PRコメント: `⚠️ **LoopPilot Workflow B failed before the auto-fix loop could start.**`
- `looppilot-state`は`initialized`のまま → MONITORは`in_progress`を返し続ける

## 2. 期待される挙動

1. MONITORがLoop workflowの早期失敗を検知する（PRコメントの⚠️マーカー）
2. 失敗原因が修正可能であればAgentRunner（Claude Code）で自動修正を試みる
3. 修正push後に`/restart-review`コメントを自動投稿してLoopPilotを再トリガーする
4. 修正不能な失敗、または試行上限（2回）到達で`stopped`（`workflow_setup_failed`）にしてHALTする

## 3. 検知方式

信頼著者（`config.looppilot.state_comment_authors`）からのPRコメントで、bodyが`⚠️`で始まるものをエラーシグナルとして検出する。

- LoopPilot側はES-398でエラーコメントの`⚠️`プレフィックスを統一する
- check run（statusCheckRollup）は使わない（CI全般が含まれLoopPilot固有の失敗と区別しづらい）
- stateコメントと同じ信頼著者フィルタを適用する

## 4. アーキテクチャ

### 4.1 変更対象モジュール

| モジュール | 変更内容 |
|---|---|
| `types.ts` | `MonitorVerdict`に`workflow_failed`追加、`FailureReason`に`workflow_setup_failed`追加、`WorkflowRecovery` interface追加 |
| `monitor.ts` | `poll()`に⚠️コメント検出ロジック追加 |
| `workflow-recovery.ts` | **新規**: `AgentWorkflowRecovery`クラス（修正実行・push・再トリガー） |
| `orchestrator.ts` | `monitorSession()`に`workflow_failed` verdict handling追加 |
| `config.ts` | `safety`に`max_workflow_fix_attempts`と`max_cost_usd_per_fix`追加 |
| `main.ts` | DI配線にWorkflowRecovery追加 |

### 4.2 v2接合点

`WorkflowRecovery` interfaceをtypes.tsで定義し、Orchestratorはinterface越しに呼ぶ。

- **v1**: `AgentWorkflowRecovery`（全エラーに対してAgentRunnerで修正を試みる）
- **v2**: `CodexGuidedWorkflowRecovery`（CodexPlannerがerrorBodyを分析して修正可能性を判断→AgentRunnerに修正指示を委譲）
  - ES-379（CodexPlanner基盤）完了後に差し替え可能

## 5. 詳細設計

### 5.1 Types（types.ts）

```typescript
// MonitorVerdict に追加
| { kind: "workflow_failed"; errorBody: string; errorCommentCount: number }

// FailureReason に追加
| "workflow_setup_failed"

// 新interface
export interface RecoveryContext {
  worktreePath: string;
  branch: string;
  prNumber: number;
  errorBody: string;
  errorCommentCount: number;
  maxCostUsd: number;
}

export type RecoveryOutcome =
  | { kind: "restarted"; costUsd: number }
  | { kind: "exhausted"; costUsd: number }
  | { kind: "unrecoverable"; costUsd: number; message: string };

export interface WorkflowRecovery {
  attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome>;
}
```

- `errorBody`: 最新の⚠️コメントのbody全文。修正エージェントへのプロンプトに含める
- `errorCommentCount`: 信頼著者の⚠️コメント総数。Orchestratorの既処理カウンタとの差分で「新しい失敗か」を判定
- `RecoveryOutcome.restarted(costUsd=0)`: 既処理のエラー（新しい失敗なし、再起動待ち）

### 5.2 Monitor（monitor.ts）

`poll()`の既存コメントスキャン（`findTrustedStateComment`）と同じAPIレスポンス内で⚠️コメントも同時検出する。追加のAPI呼び出しなし。

#### 判定ロジック（verdict決定順の拡張）

```
1. merged → { kind: "merged" }                           [既存・変更なし]
2. CLOSED → { kind: "pr_closed" }                        [既存・変更なし]
3. コメント取得 →
   a. 信頼stateコメント特定（既存ロジック）
   b. 信頼著者の⚠️先頭コメントをカウント + 最新body記録     [NEW]
4. stateコメント判定:
   - stopped → { kind: "stopped", ... }                  [既存・変更なし]
   - done → { kind: "done" }                             [既存・変更なし]
   - in_progress (initialized|waiting_codex|fixing):
     - errorCount > 0 → { kind: "workflow_failed", ... } [NEW]
     - errorCount == 0 → { kind: "in_progress" }         [既存]
   - corrupted → { kind: "corrupted" }                   [既存・変更なし]
   - not found (not_engaged):
     - errorCount > 0 → { kind: "workflow_failed", ... } [NEW]
     - errorCount == 0 → { kind: "not_engaged" }         [既存]
```

#### ⚠️コメント検出規則

1. コメントの`user.login`が`trustedAuthors`に含まれる
2. コメントの`body`が`⚠️`（U+26A0 U+FE0F）で始まる（`startsWith("⚠️")`）
3. stateコメント（`STATE_COMMENT_VISIBLE_TEXT`で始まるもの）は除外
4. カウント: 条件1-3を全て満たすコメントの総数
5. latestBody: 上記コメントのうち最後（配列末尾 = 最新）のbody

### 5.3 WorkflowRecovery（workflow-recovery.ts）

```typescript
export class AgentWorkflowRecovery implements WorkflowRecovery {
  private fixAttempts = 0;
  private totalCostUsd = 0;

  constructor(
    private readonly agent: AgentRunner,
    private readonly runner: CommandRunner,
    private readonly remote: string,
    private readonly maxAttempts: number,
    private readonly log: (line: string) => void,
  ) {}

  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryOutcome> {
    // 既処理: count <= fixAttempts → 修正済み（再起動を待機中）
    if (ctx.errorCommentCount <= this.fixAttempts) {
      return { kind: "restarted", costUsd: 0 };
    }

    // 試行上限到達
    if (this.fixAttempts >= this.maxAttempts) {
      return { kind: "exhausted", costUsd: this.totalCostUsd };
    }

    // 1. AgentRunnerで修正
    const outcome = await this.agent.runSession({
      worktreePath: ctx.worktreePath,
      prompt: buildFixPrompt(ctx.errorBody),
      maxCostUsd: ctx.maxCostUsd,
    });

    if (outcome.kind === "cost_exceeded") {
      this.totalCostUsd += outcome.costUsd;
      return { kind: "unrecoverable", costUsd: outcome.costUsd,
               message: "fix agent exceeded cost limit" };
    }
    if (outcome.kind === "error") {
      this.totalCostUsd += outcome.costUsd;
      return { kind: "unrecoverable", costUsd: outcome.costUsd,
               message: outcome.message };
    }

    this.totalCostUsd += outcome.costUsd;

    // 2. git push（PRブランチへ）
    await this.pushFix(ctx.branch, ctx.worktreePath);

    // 3. /restart-review コメント投稿
    await this.postRestartReview(ctx.prNumber);

    this.fixAttempts++;
    this.log(`workflow fix attempt ${this.fixAttempts}/${this.maxAttempts} ` +
             `for PR #${ctx.prNumber} (cost=$${outcome.costUsd.toFixed(2)})`);
    return { kind: "restarted", costUsd: outcome.costUsd };
  }
}
```

#### クラッシュ回復時の挙動

`fixAttempts`はインスタンス内メモリに保持する（DBに永続化しない）。Orchestratorが再起動（クラッシュ回復）した場合、fixAttemptsは0にリセットされるが、これは許容する。

- 前回のfixが既に適用済みなら、agentは変更なし→pushはno-op→`/restart-review`で再トリガー（冪等に近い）
- 前回のfix後に新たな問題が出ていれば、最新の⚠️コンテキストで再修正を試みる（正しい動作）
- 最悪ケース: 2回分の修正が既に完了した状態で再起動→再度2回修正を試みる（合計4回）。v1では許容する

#### 修正プロンプト（buildFixPrompt）

```
The LoopPilot review workflow failed with the following error:

---
{errorBody}
---

Fix the issue in this repository so the workflow can succeed.
Common infrastructure fixes include:
- Generate missing package-lock.json (run `npm install`)
- Fix dependency version mismatches
- Fix configuration files required by CI

Commit your changes with a clear message describing the fix.
Do NOT push — the orchestrator handles pushing.
```

#### pushFixとpostRestartReview

```typescript
private async pushFix(branch: string, worktreePath: string): Promise<void> {
  const result = await this.runner.run(
    "git", ["push", "origin", branch],
    { cwd: worktreePath },
  );
  if (result.code !== 0) {
    throw new Error(`git push failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

private async postRestartReview(prNumber: number): Promise<void> {
  const result = await this.runner.run(
    "gh", ["pr", "comment", String(prNumber), "-R", this.remote, "-b", "/restart-review"],
    { cwd: process.cwd() },
  );
  if (result.code !== 0) {
    throw new Error(`gh pr comment failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}
```

### 5.4 Orchestrator（orchestrator.ts）

#### monitorSession()のswitch拡張

```typescript
case "workflow_failed": {
  const recoveryCtx: RecoveryContext = {
    worktreePath: session.worktreePath as string,
    branch: session.branch,
    prNumber,
    errorBody: verdict.errorBody,
    errorCommentCount: verdict.errorCommentCount,
    maxCostUsd: this.config.safety.maxCostUsdPerFix,
  };
  let result: RecoveryOutcome;
  try {
    result = await this.recovery.attemptRecovery(recoveryCtx);
  } catch (err) {
    return await this.stopSession(
      session, "workflow_setup_failed",
      `workflow recovery error: ${errMsg(err)}`,
    );
  }
  if (result.kind === "restarted") {
    if (result.costUsd > 0) {
      // 修正コストをセッションに加算
      const current = this.store.getSession(session.id);
      const newCost = (current.costUsd ?? 0) + result.costUsd;
      this.store.updateSession(session.id, { costUsd: newCost });
    }
    continue; // polling続行
  }
  // exhausted / unrecoverable → HALT
  const detail = result.kind === "exhausted"
    ? `workflow fix attempts exhausted (${this.config.safety.maxWorkflowFixAttempts}x)`
    : `workflow fix failed: ${(result as { message: string }).message}`;
  return await this.stopSession(session, "workflow_setup_failed", detail);
}
```

#### OrchestratorDeps拡張

```typescript
export interface OrchestratorDeps {
  // ... 既存
  recovery: WorkflowRecovery;  // NEW
}
```

#### 回復経路（recoverInReview）

`workflow_failed` verdictは既存の回復ロジックでは `in_progress`/`not_engaged` と同じ扱い（採用してMONITOR再開）。monitorSession()内で自然にworkflow_failedを処理する。

### 5.5 Config（config.ts）

```toml
[safety]
# 既存キー
max_tasks_per_run = 10
max_cost_usd_per_session = 5.0
not_engaged_guard_minutes = 30
session_hard_timeout_minutes = 120
# 新規キー
max_workflow_fix_attempts = 2        # workflow失敗時の修正試行上限（default 2）
max_cost_usd_per_fix = 2.0           # 1回の修正セッションのコスト上限（default 2.0）
```

zodスキーマ:
```typescript
max_workflow_fix_attempts: z.number().int().positive().default(2),
max_cost_usd_per_fix: z.number().positive().default(2),
```

### 5.6 DI配線（main.ts）

```typescript
const recovery = new AgentWorkflowRecovery(
  agent,
  runner,
  config.repo.remote,
  config.safety.maxWorkflowFixAttempts,
  log,
);
const orch = new Orchestrator({ ...deps, recovery });
```

## 6. エラーハンドリング

| 障害 | 処理 |
|---|---|
| AgentRunnerが修正に失敗（error/cost_exceeded） | `unrecoverable` → `stopSession(workflow_setup_failed)` |
| git pushが失敗 | `attemptRecovery`がthrow → Orchestratorが`stopSession(workflow_setup_failed)` |
| gh pr commentが失敗 | 同上 |
| 試行上限到達（2回修正しても再度失敗） | `exhausted` → `stopSession(workflow_setup_failed)` |
| エージェントがコミットしない（修正できなかった） | AgentRunnerが`completed`を返すがpush時に差分なし → 次のpoll cycleで再度`workflow_failed`検出 → 再試行 or 上限到達 |

## 7. シナリオトレース

### 7.1 単一失敗→修正成功

```
[poll] state=initialized, ⚠️=1 → workflow_failed(count=1)
[recovery] 1 > 0 (fixAttempts=0) → agent fix → push → /restart-review → fixAttempts=1
[poll] state=initialized, ⚠️=1 → workflow_failed(count=1)
[recovery] 1 <= 1 → restarted(cost=0) → continue
[poll] state=fixing, ⚠️=1 → workflow_failed(count=1)
[recovery] 1 <= 1 → restarted(cost=0) → continue
[poll] state=done, ⚠️=1 → done (stateがdone→⚠️チェックより先に成立)
[merge] → merged
```

### 7.2 2回失敗→2回目で修正成功

```
[poll] ⚠️=1 → workflow_failed(count=1) → fix #1 → fixAttempts=1
[poll] ⚠️=1 → recovery(1<=1) → continue
[poll] ⚠️=2 → workflow_failed(count=2) → 2 > 1 → fix #2 → fixAttempts=2
[poll] ⚠️=2 → recovery(2<=2) → continue
[poll] done → merge
```

### 7.3 3回失敗→HALT

```
[poll] ⚠️=1 → fix #1 → fixAttempts=1
[poll] ⚠️=2 → fix #2 → fixAttempts=2
[poll] ⚠️=3 → workflow_failed(count=3) → 3 > 2, fixAttempts(2) >= max(2) → exhausted
→ stopSession(workflow_setup_failed, "workflow fix attempts exhausted (2x)")
```

## 8. テスト戦略

### 8.1 monitor.test.ts

- ⚠️コメント1件 + state=initialized → `workflow_failed(count=1, body=...)`
- ⚠️コメント2件 + state=not_engaged → `workflow_failed(count=2, body=最新)`
- ⚠️コメント0件 + state=initialized → `in_progress`（既存動作不変）
- ⚠️コメント0件 + stateコメントなし → `not_engaged`（既存動作不変）
- ⚠️コメント1件 + state=done → `done`（done/stoppedが優先）
- ⚠️コメント1件 + state=stopped → `stopped`（done/stoppedが優先）
- 偽装著者の⚠️は無視
- stateコメント（`STATE_COMMENT_VISIBLE_TEXT`先頭）は⚠️カウントに含めない
- ⚠️が複数ページに跨ぐ場合の正確なカウント

### 8.2 workflow-recovery.test.ts

- 正常修正: agent完了 → push成功 → comment成功 → `restarted(costUsd=X)`
- 既処理: errorCommentCount <= fixAttempts → `restarted(costUsd=0)`
- 上限到達: fixAttempts >= maxAttempts → `exhausted`
- agent失敗(error): → `unrecoverable`
- agent失敗(cost_exceeded): → `unrecoverable`
- push失敗: → throw
- comment失敗: → throw
- 連続修正: 2回成功でfixAttempts正確にインクリメント

### 8.3 orchestrator.test.ts

- FakeWorkflowRecovery + workflow_failed verdict → restarted → polling続行
- FakeWorkflowRecovery → exhausted → stopSession(workflow_setup_failed)
- FakeWorkflowRecovery → unrecoverable → stopSession(workflow_setup_failed)
- recovery throw → stopSession(workflow_setup_failed)
- 修正コスト加算: restarted(cost>0) → session.costUsd更新
- 回復経路: in_review + workflow_failed verdict → 採用してMONITOR再開

### 8.4 config.test.ts

- `max_workflow_fix_attempts`のデフォルト（2）
- `max_cost_usd_per_fix`のデフォルト（2.0）
- 不正値（0、負数）の拒否

## 9. 関連チケット

- **ES-398**: LoopPilot側のエラーコメント⚠️プレフィックス統一（LoopPilotプロジェクト）
  - ES-397の検知方式の前提。LoopPilot側で全エラーコメントを⚠️で始める規約を入れる
  - 現時点で既に主要なエラー（Workflow B早期失敗）は⚠️で始まっているため、ES-397はES-398完了前でも動作する
