# v4-B: マージ直前 破壊的変更ゲート — Design

**Date**: 2026-07-05
**Milestone**: [v4 自律品質レイヤ](https://linear.app/edereship/project/looppilot-os-7a8262819c6f)（B側）
**Status**: Draft (awaiting user review)

## 背景 / 問題

LoopPilot（外部 PR レビューループ）の codex 修正サイクルは CI グリーンを追う過程で実装が原仕様からドリフトしうる。LoopPilot のレビューは per-PR-comment 単位のため「原仕様への累積適合」を見落としやすい。唯一のマージャーであるオーケのマージ直前（`checkMergeReadiness` → `tryMerge`）に 1 枚ゲートを足し、破壊的変更（公開 API 削除・テスト削除・設定スキーマ変更・仕様違反）が入ったままのマージを止める。

## 対話で確定した要件（2026-07-05）

マイルストーン記載のオープン項目・ガード（G-B1〜B5）に対する確定。**完全自走・エンドユーザー UX 最優先**を判断軸とした。

| # | 論点 | 決定 |
| -- | -- | -- |
| R1 | 検知時挙動（G-B3 の HALT-to-human を置換） | **自動修正 → CI + 再ゲート → 上限で「パーク」**。HALT しない。ループは次タスクへ継続 |
| R2 | 判定方式（G-B1） | **客観シグナル抽出をコードで実装** + Codex 最終判定の 2 段構え |
| R3 | 修正後の再検証範囲（G-B2） | **CI 再通過 + B ゲート再判定のみ**。LoopPilot フルレビューは再実行しない |
| R4 | 言語対応範囲 | **言語非依存シグナルをベース + 対象リポが TS の場合のみ export diff を上乗せ** |
| R5 | 配置 | **MONITOR 内サブステップ**。新 SessionState は追加しない（v3.5 VERIFY が implementing のサブステップにしたのと同思想） |
| R6 | 上限超過時の後始末 | **既存 `executeAbandon` は流用禁止**（PR クローズ + ブランチ削除でレビュー済み成果物を捨ててしまう）。専用の「パーク」経路を新設 |

## 検討したアプローチ

1. **MONITOR 内サブステップ（採用）** — `tryMerge`（orchestrator.ts）の内部、`checkMergeReadiness` が ready を返した後・`git.mergePr` を呼ぶ直前に実行。`tryMerge` は LoopPilot verdict が `done` の経路と `stopped(review_done)` の経路の 2 箇所から呼ばれるため、`tryMerge` 内に置くことで両経路を自動的にカバーする。クラッシュ時、in_review + PR ありのセッションは既存 `recoverInReview` → `monitorSession` 再入で `tryMerge` が再実行され、ゲートも自然に再評価される（回復ロジックを増やさない）。
2. 独立フェーズ（新 SessionState `MERGE_GATE`）— 状態は明示的になるがリカバリー経路への手入れが必要で実装面積が増える。
3. `checkMergeReadiness` に内包 — 変更最小だが「マージ可否確認」と「仕様適合審査 + 修正ループ」の別責任が 1 関数に混ざる。

## 設計

### 1. 検査対象と発火条件

- HANDOFF 完了時に PR head SHA をセッションへ記録する（`task_session` テーブルに `handoff_head_sha` カラム追加。store.ts の冪等 `ALTER TABLE` マイグレーション流儀に従う）。
  - 既存に PR head SHA 相当の記録はない（`verify_log.verified_head_sha` は VERIFY 時点の worktree HEAD であり別物）。`pushAndOpenPr`（git-pr.ts）は PR 番号のみを返し SHA を返さないため、HANDOFF 直後に worktree で `git rev-parse HEAD` を叩く等の取得手段を追加する。
- ゲートの検査対象 = `handoff_head_sha`〜マージ候補 head（`checkMergeReadiness` が返す `MergeReadiness.headSha`）の**累積差分**（LoopPilot 稼働中に積まれたコミットのみ）。
- **LoopPilot 稼働中のコミットがゼロ（`handoff_head_sha` == readiness.headSha）ならゲートをスキップ**する（検査すべきドリフトが存在しない。クリーン PR のマージ所要時間は現状と不変 = UX 劣化ゼロ）。
- 旧セッション（カラム追加前）は `handoff_head_sha` が NULL — この場合もゲートをスキップする（フェイルオープン。移行期の 1〜2 件のみ）。

### 2. 客観シグナル抽出 — 新モジュール `src/breaking-signals.ts`

コードで機械抽出し、結果を構造化して Codex プロンプトに注入する。

**言語非依存（常時）**:
- 削除されたファイル一覧（`git diff --diff-filter=D --name-only`）
- テストファイルの削除・大幅縮小（テスト認識パターン + 行数削減率）
- 設定ファイル・スキーマ変更（既知パターンマッチ: `*.config.*` / `schema*` / `.env.example` 等）
- CI ワークフロー変更（`.github/workflows/` 配下）

**TS 上乗せ（対象リポに `tsconfig.json` がある場合のみ）**:
- 公開 export の削除・シグネチャ変更の diff

抽出は best-effort。抽出失敗はシグナル空として続行し、Codex 判定単独にフォールバックする（ゲート不成立にはしない）。

### 3. Codex 最終判定 — `src/merge-gate-prompt.ts` / `src/merge-gate-parser.ts`

DESIGN REVIEW（`design-review-prompt.ts` / `design-review-parser.ts`・Codex ブロッキング裁定）を雛形に流用。

- **入力**: 累積 diff + 抽出シグナル + 原仕様（brief の acceptance + `docs/specs/` 抜粋。B1 グラウンディング経路 = `spec-reader.ts` / `context-bundle.ts` を再利用）
- **出力**: `{ verdict: "pass" } | { verdict: "fail"; violations: string[] }`
- **役割限定（G-B5)**: 判定基準は「原仕様への累積適合」のみ。コードスタイル・一般的な品質指摘は LoopPilot の領分であり本ゲートでは指摘させない（プロンプトで明示）。
- **フェイルセーフ**: Codex 例外・パース失敗は **pass 扱い + 警告ログ**（既存 designReview / verify と同じ「検証器の不調でループを止めない」思想）。

### 4. fail 時の自動修正ループ（R1/R3）

```
fail → Claude 修正ターン（violations 注入・worktree で修正 → push）
     → CI 再通過待ち → B ゲート再判定（シグナル再抽出込み）
     → pass ならマージ / fail なら再試行
```

- 上限 `safety.max_merge_gate_fix_attempts`（既定 **2**）。
- **コスト予算の適用範囲**: Codex CLI はコストを報告しない（`CodexOutcome` に costUsd なし）ため、Codex 判定部は既存流儀どおり **timeout のみ**でガードする。コスト上限が効くのは修正ターンの Claude セッションのみ — `safety.max_cost_usd_per_merge_gate_fix`（既存の `safety.max_cost_usd_per_*` 流儀に合わせる。既定値は実装計画時に確定）。
- 修正ターンは既存 `executeFixCode`（recovery-turn.ts: fetch → reset --hard origin/branch → Claude 起動 → push）と同型。ただし既存 recovery の前段にある「Codex による action 選択」はスキップし、violations を指示文に整形して **fix_code 固定**で直接呼ぶ。
- 再ゲートは修正コミットを含む累積差分全体を再検査する（修正自体のドリフトも捕捉 = G-B2 対応）。
- worktree は MONITOR 期間中保持されている（正常マージ後も含め、現状 worktree を掃除する経路は存在しない — 既存挙動）ため、修正ターンの worktree 前提は成立する。
- **修正 push 後の done 再待機**: オーケ側に looppilot-state をリセットする機構はなく、monitor.ts は state コメントを read-only で観測するだけ。修正 push が LoopPilot を再トリガーする場合は `monitorSession` のポーリングで done 再取得を待つ（`pendingRestartReason` の 1-poll grace 機構が既存前例）。

### 5. パーク経路（R6・新設）

上限超過時、レビュー済み成果物を捨てずに保留する:

1. PR は**オープンのまま**（ブランチも削除しない）
2. Linear チケットに needs-human ラベル + 理由コメント（ES-492 の `applyNeedsHumanTriage` 配管を再利用）。PR には理由コメントを投稿（`git.postComment` 既存ラッパー）。PR 側ラベルは付けない — GitHub リポジトリに同名ラベルが存在する保証がないため、PR の可視化はコメントのみとする
3. セッションは DB 上で終了状態にする — 新 FailureReason `merge_gate_failed` を追加。`FAILURE_POLICY`（stop-reason.ts）は `satisfies Record<FailureReason, FailurePolicy>` のため対応エントリ追加が型で強制される。**既存 3 policy（halt / recover / abandon）はどれも「PR を残す」要件を満たさない**（abandon は `executeAbandon` = PR クローズ + ブランチ削除）ため、第 4 の policy 値 `park` を追加し `stopSession` に専用分岐を実装する。`recoverInReview` / `recoverByOpenPr` が park 済みセッションを再採用しないことを確認する
4. 専用 NotifyEvent（例 `merge_gate_parked`: identifier / PR 番号 / violations 要約）で Slack 通知（types.ts の union + notifier.ts の formatter の 2 箇所）
5. ループは次タスクへ継続（HALT しない）

人間の対応は「理由コメントを読んで手動マージ or 修正指示」の 2 択に収まる。

### 6. 監査・可観測性

- 専用テーブル `merge_gate_log`（run_id, session_id, attempt, signals JSON, verdict, violations, outcome, cost_usd）— `groom_log` / `verify_log` と同型。
- status CLI にゲート実行結果を露出（実装計画時に詳細確定)。

## UX 保証（再点検で確認済み）

- クリーン PR（LoopPilot 中コミットなし）のマージ時間は不変（ゲートスキップ)。
- パーク時は必ず Slack/コンソール通知が飛ぶ（既存 Notifier 配管あり)。
- needs-human チケットは SELECT で除外済み（ES-492 実装確認済み）— 保留チケットの掴み直し事故なし。
- ループは 1 件のドリフトでは止まらない（halt は既存のインフラ異常系のみ）。

## 実装順

v4 内では **B（本 spec）→ A（SCOUT）** の順（マイルストーン推奨どおり。単一チョークポイントで表面積が小さく確度が高い）。

## オープン項目（実装計画時に確定）

- **修正 push と外部 LoopPilot の相互作用**: B ゲートの修正コミット push が LoopPilot ワークフローを再トリガーし `looppilot-state` が done から巻き戻る場合の扱い。オーケ側に state リセット機構はない（monitor.ts は read-only 観測のみ）ため、再トリガーされる場合は done 再待機に乗せる方向（§4 参照）。実装計画時に LoopPilot 側のトリガー条件を確認して確定する
- **再ゲート待ち中間状態の耐久マーカー**: 「修正 push 済み・CI/再ゲート待ち」の途中でクラッシュした場合、マーカーなしでは再起動時にゲート判定からやり直しになる（判定は冪等なので安全側だが、fix attempt カウントが揮発すると上限 2 回を超えて修正しうる）。attempt カウントの永続化要否を確定する
- テストファイル「大幅縮小」の閾値（行数削減率）と、テスト認識パターンの具体形
- 設定ファイル既知パターンの一覧と config での上書き可否
- TS export diff の実装方式（tsc API / 軽量パーサ）
- `safety.max_cost_usd_per_merge_gate_fix` の既定値
- status CLI での表示形式
