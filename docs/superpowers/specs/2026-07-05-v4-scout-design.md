# v4-A: SCOUT — 自律バグ発見・自動起票 — Design

**Date**: 2026-07-05
**Milestone**: [v4 自律品質レイヤ](https://linear.app/edereship/project/looppilot-os-7a8262819c6f)（A側）
**Status**: Draft (awaiting user review)

## 背景 / 問題

現状、適格チケットが尽きるとオーケは idle でただ待つ（`idle_timeout_minutes` 経過で自動停止）。この idle 時間を改善ソースに変える: Claude Code が対象リポでバグ・仕様不整合を**証拠付き**で探索し、Codex が「①実在するか ②要求/要件定義からズレていないか」を検証、通過したものだけ Linear に自動起票する。人間が起票しなくてもバックログが枯れない自律運用の入口。

マイルストーンで確定済みの前提: SCOUT は **GROOM 内アクションではなく独立フェーズ**（2026-06-27 確定）。起票配管のみ GROOM と共有。検証ゲートは DESIGN REVIEW 雛形を流用。

## 対話で確定した要件（2026-07-05）

**完全自走・エンドユーザー UX 最優先**を判断軸とした。

| # | 論点 | 決定 |
| -- | -- | -- |
| R1 | 発見チケットのトリアージ（G-A3） | **証拠タイプで分岐**: objective（コマンド出力で裏が取れる）→ 即適格＝完全自走 / spec_mismatch（解釈が絡む）→ `scout-triage` ラベルで人間待ち |
| R2 | 初期の探索入力範囲 | **ローカル客観シグナルのみ**（①）。②開放探索・OBSERVE 外部アダプタは拡張ポイントの設計だけ行い後続スコープ |
| R3 | 実行形態 | **ランレベルの活動（セッション外）**。GROOM と同じくセッションを作らない。監査は専用テーブル `scout_log` |
| R4 | idle 発火と ES-475 の整合 | idle 30 分連続 + 前回実行から 24h 経過で発火。SCOUT 実行時間は idle 経過に**不算入**。起票 0 件なら従来どおり idle_timeout で自動停止 |
| R5 | 暴走防止（G-A5） | 起票上限 3 件/回 + 24h インターバル + 重複起票防止 + 全件監査 |

## 検討したアプローチ（実行形態）

1. **ランレベルの活動（採用）** — 成果物は「Linear チケット」のみで PR を作らないためセッション概念が不要。クラッシュ時は単に次の idle で再探索すればよく、リカバリー経路に手を入れない。
2. 疑似セッション — 既存のコスト集計に自然に乗るが、「チケットなし・PR なし」の例外セッションが全リカバリー経路に漏れ出すリスク。
3. 別プロセス/サブコマンド — ループ本体との結合は最小だが、idle 検知・キャップ・監査の一貫性が別管理になり運用が複雑化。

## 設計

### 1. 発火条件（R4）

- SELECT が適格 0 件を返した時点で idle 判定開始。既存の idle タイマーは `run.idle_started_at`（単一タイムスタンプ）からの wall-clock 差分方式（store.ts / orchestrator.ts の loop 0 件ブランチ）— SCOUT のしきい値判定も同じタイムスタンプを流用する。
- `scout.idle_minutes`（既定 **30**）連続 idle、かつ前回 SCOUT 実行から `scout.min_interval_hours`（既定 **24**）経過で発火。前回実行時刻の永続化は現状存在しないため、**`scout_log.fired_at` の MAX を引く store クエリを新設**する。
- **挿入点**: `loop()` の適格 0 件ブランチ内・**idle_timeout HALT チェックより前**（GROOM のような毎反復先頭ではない — SCOUT は idle 時のみ）。
- **SCOUT 実行時間の idle 不算入**: 既存タイマーに一時停止プリミティブはない（`setIdleStartedAt` は NULL ガード付きで上書き不可、clear→再 set はゼロリセットになってしまう）。**`idle_started_at` を SCOUT 実行時間分だけ前方シフトする store メソッド（例 `advanceIdleStartedAt(runId, deltaMs)`）を新設**して実現する。
- **起票 0 件**: idle タイマーはそのまま進行 → 従来どおり `idle_timeout_minutes` で綺麗に自動停止（SCOUT 空振りでループが永遠に生き続けることはない）。
- **起票 >0 件**（objective 経路）: 次ループの SELECT で非 idle に復帰し実装へ。

### 2. 2 段パイプライン

**Stage 1: 探索 = Claude Code**（独立予算 `scout.max_cost_usd`）

- 対象リポで test / 型チェック / lint / `npm audit` を実行し、出力 + コード実読 + `docs/specs/` 照合（B1 グラウンディング経路 = `spec-reader.ts` 再利用）から候補を抽出。
- 探索対象（①ローカル客観シグナルのみ・R2）: 失敗/flaky テスト、型エラー、lint、依存 CVE、要求/要件定義との仕様不整合。
- 各候補に**証拠を必須添付**（コマンド出力・再現手順・該当 spec 引用）。証拠のない候補は出力させない（G-A1）。
- 出力: 構造化 JSON（title / description / evidence / evidence_type ∈ {objective, spec_mismatch} / priority 案）。
- worktree は不要（read-only 探索 + コマンド実行のみ。コミットしない）。`SessionContext.worktreePath` は単なる cwd なので main checkout（`config.repo.path`）で起動できる（GROOM の Codex 起動と同じ流儀）。ただし:
  - **SCOUT 専用の `AgentRunner` インスタンス**を main.ts で新設する（`allowedTools` / `permissionMode` は runner 構築時固定のため、read-only 寄りのツール制約と独立予算を持たせるには verify/implement 用と別インスタンスが必要）。
  - main checkout 上で実行するため、GROOM と同型の**実行後クリーンアップ**（開始 SHA 記録 → `git checkout HEAD -- .` / `git clean` / `reset --hard`）を必須とする（test/lint 実行による作業ツリー汚染対策）。

**Stage 2: 検証 = Codex**（DESIGN REVIEW 雛形流用: `scout-review-prompt.ts` / `scout-review-parser.ts`）

- 各候補を「①実在するか ②要求/要件定義からズレていないか」（G-A2: specs を明示注入）でブロッキング裁定。
- reject された候補は起票しない（rationale を `scout_log` に記録）。

### 3. 起票 — GROOM 配管の共有範囲と必要な API 変更

検証の結果、「GROOM の create 経路をそのまま流用」は成立しない。共有するのは **`groom-linear-client.ts`（Linear API ラッパー）と監査・キャップの思想**であり、executor / validator は SCOUT 自前とする:

- **opt-in 省略フラグの追加（API 変更・必須）**: 現行 `GroomLinearClient.createIssue` は opt-in ラベルを**無条件で強制付与**する（`labelIds = [this.optInLabelId, ...]`）。spec_mismatch の「opt-in なし起票」を実現するため、`createIssue` に `includeOptIn: boolean`（既定 true = GROOM の既存挙動不変）を追加する。
- **SCOUT は client を直接呼ぶ**: `GroomAction` の create 型にはラベルフィールドがなく、`groom-executor` も `extraLabelIds` を渡していない。SCOUT は executor を経由せず `createIssue({ title, description, priority, extraLabelIds, includeOptIn })` を直接呼ぶ。
- **ラベル ID 解決**: `scout` / `scout-triage` ラベルは `resolveLinearSetup`（task-source.ts）に needs-human と同型の解決を追加し、起動時 preflight で存在確認する。
- 全 SCOUT 起票チケットに `scout` ラベルを付与（出所の可視化 + 重複防止の参照キー）。
- **evidence_type 分岐（R1）**:
  - `objective` → Todo + opt-in ラベル + `scout` ラベル = 即適格・完全自走
  - `spec_mismatch` → `scout` + `scout-triage` ラベルのみ（`includeOptIn: false`）= 人間がラベルを付け替えたら適格化
- 起票上限 `scout.max_issues_per_scout`（既定 **3**）は **SCOUT 自前のカウンタ**で強制する。GROOM の create 上限 5/総数 20 は `groom-validator.ts` のモジュール定数で、`validateGroomActions` を流用すると 5 固定になり 3 に絞れないため使わない（自然に独立カウントになる）。

### 4. 重複起票防止

- SCOUT プロンプトに「`scout` ラベル付きの未消化チケット一覧」と「needs-human / scout-triage 保留中チケット一覧」を注入し、同一事象の再起票を禁止。
- **注入用の新規 getter が必要**: 既存 `getBoardState` は opt-in ラベル必須フィルタのため **scout-triage（非 opt-in）チケットが盤面から欠落**する。`getNeedsHumanIssueIds` は任意ラベルで引ける汎用実装だが識別子集合のみでタイトルがない。`groom-board-fetcher` に `getIssuesByLabel(label): { identifier, title, labels }[]` を新設する（`cachedNodes` は title/labels を保持済みなので追加は小さい）。
- Codex 検証ゲートでも同じ一覧と突き合わせて重複を reject。

### 5. フェイルセーフ・監査

- 探索・検証・起票のどの段階で失敗してもループは HALT しない。警告ログ + スキップで通常の idle 処理へ戻る（GROOM の D-13 と同思想）。
- 専用テーブル `scout_log`（run_id, fired_at, candidates JSON, verdicts, created_issue_ids, outcome, cost_usd）に全件記録。
- 実行と結果は Slack 通知（例: 「SCOUT: 3 件起票（objective 2 / triage 1）」。0 件時は通知しない = ノイズ抑制）。

### 6. 拡張ポイント（後続スコープ・設計のみ）

- **②開放探索**: Stage 1 のプロンプトモードとして追加予定（`scout.mode`）。②発の起票は全件 scout-triage 行きにする前提で解禁ラインを別途設計。
- **OBSERVE 外部シグナル**: Stage 1 の入力ソースをアダプタ interface（例 `ScoutSignalSource`）で抽象化しておき、CI flake 履歴・本番エラートラッカーを後続で追加。v3.5 VERIFY の受け入れ失敗シグナルも同 interface で取り込む。

## UX 保証

- 人間の関与は「scout-triage / needs-human チケットの非同期レビュー」のみ。objective 起票 → 実装 → PR → マージまで完全無人。
- 暴走防止 3 重（上限 3 件/回・24h 間隔・重複禁止）により「自己発明タスクで二度と idle に戻らない」事態を構造的に排除。
- SCOUT が何も見つけない場合の挙動は現状と完全に同一（idle_timeout で停止・通知）。

## 実装順

v4 内では **B（マージゲート）→ A（本 spec）** の順（マイルストーン推奨どおり）。

## オープン項目（実装計画時に確定）

- Stage 1 の実行コマンドセットを config で持つか（`scout.commands`）リポの CLAUDE.md / スキル参照にするか
- flaky テスト判定の方式（リトライ実行するか、単発失敗を flaky 候補としてマークするだけか）
- `scout.max_cost_usd` の既定値（config キーは既存流儀に合わせ `safety.max_cost_usd_per_scout` とするかも含め）
- SCOUT 専用 `AgentRunner` の `allowedTools` / `permissionMode` の具体値（read-only 寄りにどこまで絞るか — test/lint 実行には Bash が要る）
- scout_log の status CLI 表示形式
