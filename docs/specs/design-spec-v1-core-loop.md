# 設計仕様書 v1（コアループ）

> ステータス: **設計合意済み（敵対的レビュー反映済み）**
> 日付: 2026-06-03 ／ 関連: [要求仕様書](https://linear.app/edereship/document/要求仕様書-88a47519ecd8)
> Source of truth: https://linear.app/edereship/document/設計仕様書-v1コアループ-7a35a12d1af8 （doc id `b3057385-c2ca-480a-9c5c-d7bfefdf10cc`）
> このファイルは Linear ドキュメントのスナップショット（2026-06-05 取得）。

> **⚠️ 後続マイルストーンでの変更（本文は歴史的スナップショットとして維持）**
>
> 以下の点は v1 以降のマイルストーンで変更されています:
>
> 1. **監視 timeout の既定値**: 本文（§3 確定事項・§8・§11）では「既定オフ」だが、現行は**既定 60 分**（ES-449: `monitor_timeout_minutes` default 60）。
> 2. **失敗時のポリシー**: 本文（§5・§9）では「全失敗 → STOPPED → HALT（人間に上げる）」だが、現行は failure_reason ごとに **halt / recover / abandon の 3 ポリシー routing**（ES-490: `FAILURE_POLICY` テーブル）。詳細は README の failure_reason 一覧を参照。
> 3. **MONITOR 中の書き込み制約**: 本文（§5）では「監視中は PR/ブランチへ書き込まない」だが、現行は /restart-review 自動投稿・workflow fix agent 等で正当に緩和（ES-397 / ES-409 / ES-450）。
> 4. **status CLI のキュー表示**: 本文（§5・§10・§12）では status CLI でキューを表示する想定だが、実装では Linear 側の適格一覧は Store から導出不能のため省略。

# 1\. 目的と v1 スコープ

AIコーディングエージェントによる継続的なプロダクト開発ループを、人間の都度指示なしで回す。LoopPilot（PRレビュー・修正を担う既存システム）の「前後」をオーケストレーションする。

**v1 スコープ（既存チケット駆動のコアループ）**:
`タスク選定 → AIエージェント起動 → 実装・PR作成 → LoopPilotへ受け渡し → クリーン到達を検知 → マージ → 次タスク選定 → 次セッション開始` を、人の都度指示なしで継続的に回す。

# 2\. 用語

* **オーケストレーター（オーケ）**: 本プロダクト（LoopPilot OS）のループ駆動本体。
* **セッション**: 1チケットに対する1回のエージェント作業。**1タスク = 1セッション = 1PR**。
* **LoopPilot**: PR上で codex レビュー → Claude修正 → チェックを回す既存のGitHub Actionsシステム。状態を `looppilot-state` 隠しコメントに記録する。
* **適格チケット**: AIが着手してよいと判定されたLinearチケット。
* **デフォルトブランチ**: 対象リポジトリの基底ブランチ（`config.repo.defaultBranch`。`main` とは限らない）。

# 3\. 確定事項サマリ

| \# | 決定 |
| -- | -- |
| スコープ | v1=コアループ（QA/バグ発見/自動起票はv2） |
| 引き継ぎ | タスク間連鎖のみ。1タスク=1セッション=1PR。失敗時は人間に上げる（タスク内再開・横断メモリはv2） |
| 形態 | ローカルCLI常駐ループ。GitHub連携境界は疎に（将来サーバレス化可能） |
| タスク源 | Linear（薄いTaskSource抽象の背後。Linearに特化、他源への一般化はしない） |
| エージェント | Claude Code ヘッドレス（Agent抽象の背後） |
| PR責任 | オーケが封筒（ブランチ/push/PR/ラベル/Linear紐付け/**マージ**）、エージェントが中身（コード+コミット） |
| **マージ** | **オーケが常にマージ**。LoopPilot の auto-merge は **off 固定**（唯一のマージャー） |
| 完了検知 | merge = GitHub PRの merged フラグ。done/stopped = `looppilot-state` 隠しコメント(プレーンJSON)のstatus |
| stopped時 | ループ全体停止（HALT）+ 通知 |
| 選定 | 指定Team/PJ ∧ Todo ∧ オプトインラベル。決定的順序（後述）。状態遷移はLinear APIで明示駆動 |
| 並行/空 | 逐次。キュー空はアイドル+定期再確認+通知 |
| 安全弁 | 1ランのタスク上限（着手数） + セッションのコスト上限。監視timeoutは既定オフ+未起動ガード常時オン |
| 文脈 | コード+チケット+ゴール+CLAUDE.md+直近N件のマージ済みセッション要約 |
| 観測 | SQLite状態ストア + status CLI + コンソール。人間の出番だけ Slack 通知（コンソールは常時） |

# 4\. アーキテクチャ

疎結合・単一責任・独立テスト可能なモジュール群。Orchestrator Core が全フェーズをオーケストレーションし、他はインターフェース越しに呼ぶ。

```
                ┌─────────────────────────────────────────┐
                │           Orchestrator Core              │
                │  ループ駆動 / per-task状態機械 / 安全弁    │
                │  / 文脈バンドル組立 / プリフライト          │
                └──┬──────┬───────┬────────┬──────┬─────────┘
            TaskSource  Agent   Git/PR   LoopPilot  Notifier
            (Linear)    Runner  Manager  Monitor
                │        │        │         │         │
            Linear API  Claude  git/gh    GitHub API  Slack/console
                        headless          (PR + 隠しコメント)
                          └────── State Store (SQLite) ──────┘  ◄── Status CLI / Config
```

**モジュールと公開インターフェース**:

* **Orchestrator Core** — `run(config)`。ループ・状態機械・安全弁・停止判断・文脈バンドル組立・起動時プリフライト。
* **TaskSource（Linear adapter）** — `getNextEligible()`, `transition(issue, state)`。Linearに特化（薄い抽象だが他源への一般化はしない）。
* **Agent Runner（Claude Code headless）** — `runSession(ctx)`。worktree内で claude をコスト上限付き起動。コミットまでが責務。
* **Git/PR Manager（封筒）** — `prepareWorktree()`（CLAIM: デフォルトブランチからブランチ+worktree）、`pushAndOpenPr()`（HANDOFF: push + PR作成 + ラベル）、`mergePr()`（DONE経路: squashマージ）。決定的。
* **LoopPilot Monitor** — `poll(pr)`。PRの merged 状態＋`looppilot-state` 隠しコメントを読み、`merged | done | stopped(reason) | in_progress | not_engaged` を返す。**監視中はPR/ブランチへ書き込まない**（マージ操作を除く）。
* **State Store（SQLite）** — `save/load/query`。状態キー検索とトランザクション更新で冪等化・回復を支える。真実の源。
* **Notifier** — `notify(event)`。配信前に意図をStoreへ記録、再試行、未配信を status CLI で可視化。コンソール/ローカルは必ず成功。
* **Status CLI** — `status`。Run + TaskSession から現在セッション・キュー・履歴・停止箇所を表示。
* **Config** — セットアップ時の全設定。

# 5\. per-task ライフサイクル（状態機械）

各フェーズに「呼ぶモジュール」と「失敗遷移」を明記する。Orchestrator Core が全体を統括。

1. **SELECT** — `TaskSource.getNextEligible()`。適格チケット = 指定Team/PJ ∧ Todo(未着手) ∧ オプトインラベル。**決定的順序**: ①意味的優先度 Urgent>High>Medium>Low>No priority（No priorityは最後） ②Linearボード順(sortOrder)昇順 ③issue id。**冪等性**: Storeに進行中セッションを持つチケットは除外。**単一インスタンス前提**＋ランロック。適格なし → **IDLE**（キュー空通知+定期再確認）。タスク上限到達 → **HALT**。
2. **CLAIM** — 副作用は**可逆な順**で。①`Git.prepareWorktree()`（デフォルトブランチからブランチ `<prefix>/<issue-id>-<slug>` + worktree。ブランチ名衝突 → サフィックス付与、不能なら STOPPED） → ②`TaskSource.transition(In Progress)`。**いずれか失敗 → STOPPED**（理由記録、可能ならticket→Todoへ復帰）。Storeに `claimed` 記録。
3. **IMPLEMENT** — `Agent.runSession(ctx)` をコスト上限付きで。**後条件はCoreが判定**: `git diff <defaultBranch>..HEAD` で実差分を確認（エージェントの自己申告でなく差分が真実）。コミット無し or 空差分 → **STOPPED(agent_no_change)**。未コミットの残骸 → STOPPED（自動コミットしない）。コスト上限到達 → **部分作業を破棄しブランチ削除 → STOPPED(cost_exceeded)**。例外 → STOPPED(exception)。Storeは `implementing`。
4. **HANDOFF** — `Git.pushAndOpenPr()`: ①push → ②`openPr(base=<defaultBranch>, 本文に ENG-123 参照, ready-for-review（draft不可）)` → ③**PR番号を即時Store永続化** → ④`loop-pilot` ラベル付与（**PR作成後**。ラベルは Init ワークフローのトリガ） → ⑤`TaskSource.transition(In Review)`。**openPr前に既存オープンPRを確認し再利用**（二重PR作成を絶対にしない）。④⑤は再試行可能、不能なら STOPPED（作成済みPRを通知に明記）。Storeは `handing_off`→`in_review`。
5. **MONITOR** — `LoopPilot.poll(pr)` を一定間隔で。**Coreはこの間PR/ブランチへ書き込まない**（マージを除き、LoopPilotを唯一の書き手とする）。判定の優先順位と遷移は §6 の検知契約に従う。
   * `merged==true` → **DONE**。
   * `looppilot-state.status=="done"`（クリーン） → **CIグリーン＋mergeable を確認 →** `Git.mergePr()`**（squash, match-head-commit）** → 成功で DONE / CI赤・コンフリクト・不能なら STOPPED(ci_failed / merge_conflict)。
   * `looppilot-state.status=="stopped"` → **STOPPED(looppilot_stopped, stopReason付き)**。
   * PRがマージ無しでclose → STOPPED(pr_closed)。
   * 一時的なAPIエラー → バックオフ再試行、規定回数超で STOPPED。
   * state コメント未出現/不正 → 未起動ガードのbounded時間まで in_progress 扱い、超過で **STOPPED(monitor_never_engaged)**。
6. **DONE** — ①`merged` をStoreへ先に永続化 → ②`TaskSource.transition(Done)`（再試行可、既Done許容） → ③`Run.merged_count` をマージ済みセッションの実数から導出 → SELECT へ。
7. **HALT** — 逐次なので、いずれかのセッションが STOPPED → Run を `halted` にし停止＋通知。

# 6\. LoopPilot 連携契約（検知の正確仕様）

LoopPilot 実コード（`/home/racoma-dev/loop-pilot`）に基づく。**唯一の検知式を §4/§5/§6 で共有する**。

* **マージ検知**: GitHub PR オブジェクトの `merged`/`merged_at`（= 唯一確実なマージ信号）。
* **done/stopped 検知**: **隠しコメント** `looppilot-state`**（プレーンJSON）** の `status` を読む（`state-manager.ts`）。`VALID_STATUSES = {initialized, waiting_codex, fixing, done, stopped}`。**base64 の** `looppilot-status` **コメントは履歴用で merged/done を持たないため使わない。**
* **コメントの著者同定**: LoopPilot は信頼著者フィルタ越しに自コメントを書く（既定 `github-actions[bot]`、`LOOPPILOT_STATE_COMMENT_AUTHORS` で上書き可）。Monitor は **LoopPilot書き手identityでコメントを特定**する（偽装・別identity運用への耐性）。設定項目化しプリフライトで検証。
* **優先順位**: `merged==true ⇒ DONE`（最優先）。else `status=="stopped" ⇒ STOPPED(stopReason)`。else（コメント未出現含む）⇒ in_progress。
* **マージ手順（オーケ）**: `status=="done"` 検知時、CIの必須チェックが全てグリーン＋PRが mergeable を確認し、`gh pr merge <pr> --squash --match-head-commit <sha>`。HEAD移動・CI未完なら見送り（次ポーリング）/赤なら STOPPED。
* **ラベル/トリガ注意**: ゲートラベルは対象リポジトリの `LOOPPILOT_LABEL`（既定 `loop-pilot`、**大小無視**一致）。オーケのラベル名はこれに一致させる。Init ワークフローは `opened/labeled` で発火、**Loop ワークフローは** `labeled` **で発火しない**ため、PRは ready-for-review で作成しラベルはPR作成後に付ける。`LOOPPILOT_FULL_AUTO=true` 運用ではラベル不要（noop）。
* **前提**: `LOOPPILOT_AUTO_MERGE=false`（既定）＝オーケが唯一のマージャー。

# 7\. 状態語彙とデータモデル（SQLite）

**語彙の正規化**（§5の各ノードを永続値に対応させる）:

* `TaskSession.state ∈ {claimed, implementing, handing_off, in_review, merged, stopped}`
* `Run.state ∈ {running, idle, halted}`
* §5 HALT = Run レベル。§5 STOPPED = TaskSession レベルの終端失敗。逐次のため **TaskSession=stopped ⇒ Run=halted（1:1）**。
* `merged` = マージ完了 / `DONE` = マージ後の ticket→Done + カウンタ確定。

**データモデル**:

* **Run**: id, 開始時刻, タスク上限, 状態(running/idle/halted), 停止理由。**ループ起動ごとに1個**。`merged_count` はマージ済みセッションの実数から導出（盲目的++はしない）。`tasks_started`（CLAIM到達数）= タスク上限の比較対象。
* **TaskSession**: id, run_id, linear_issue_id, ブランチ, PR番号, 状態, **cost**, 開始/終了時刻, **failure_reason** ∈ {agent_no_change, cost_exceeded, exception, monitor_never_engaged, looppilot_stopped, ci_failed, merge_conflict, pr_closed, claim_failed, handoff_failed}（+ looppilot_stopped は LoopPilot の stopReason を保持）, エージェント要約。

# 8\. 設定・セットアップ・プリフライト

**設定（一度だけ）**:

* product: ゴール/制約テキスト（毎回エージェントへ）
* repo: ローカルパス, remote(owner/name), **defaultBranch**
* linear: APIキー, Team, Project, オプトインラベル名, 状態IDマッピング（Todo/In Progress/In Review/Done）
* agent: claude起動オプション, 許可ツール/MCP, モデル
* handoff: ブランチprefix, PRテンプレ
* **looppilot**: ゲートラベル名（=リポジトリの LOOPPILOT_LABEL）, state-comment 著者identity
* safety: ランのタスク上限（着手数）, セッションのコスト上限, 監視timeout（任意/既定なし）, 未起動ガード時間
* digest: 直近マージ件数 N
* notify: Slack Webhook（コンソールは常時オン）

**起動時プリフライト（fail-fast）**: repoがクリーンなgitでdefaultBranch上 / remote到達可 / Linear状態IDマッピング解決可 / オプトインラベルと loop-pilot ラベルがリポジトリに存在 / `LOOPPILOT_AUTO_MERGE=false` / マージ権限（ブランチ保護の必須レビュー等を満たす）/ Notifier到達可 / state-comment著者identity設定済み。違反なら明確なエラーでループに入らない。

# 9\. エラー処理・クラッシュ回復

**失敗の写像**: エージェント無変更/コスト超/例外、CLAIM/HANDOFF失敗、PRクローズ、CI赤/コンフリクト、監視未起動超過、LoopPilotの stopped → すべて **STOPPED（人間に上げて HALT）**。

**状態↔回復ルール（起動時にStoreと突合）**:

* `in_review` で開いたPRあり → **MONITOR 再開**。そのPRが既に merged なら **DONEの後段から再開**（カウンタ二重計上を避ける）。
* `claimed` / `implementing` / `handing_off` で**対応するオープンPRが無い** → タスク内自動再開はv1スコープ外 → **STOPPED**（作成済みのworktree/ブランチ・In Progressチケットを通知に明記し手動掃除を促す）。
* `handing_off`/`implementing` でも、**決定的ブランチに一致するオープンPRがあれば採用**して MONITOR へ。
* `In Progress だがセッション行が無い`（CLAIM途中クラッシュ） → ticket→Todo へ復帰 or STOPPED で明示。
* 一般則: **「in_review＋オープンPR」だけが MONITOR へ。それ以外の中断は全て STOPPED。**

# 10\. 可観測性・通知

* 状態の真実 = SQLite。`status` CLI で現在セッション・キュー・履歴・停止箇所を表示（Run + TaskSession から導出。専用EventLogはv1では持たない）。実行中はコンソールに進捗。
* Notifier は **stopped / タスク上限到達(HALT) / キュー空(IDLE)** のときだけ通知。Slack Webhook ＋ コンソール常時。配信失敗対策: 意図をStoreへ先に記録し再試行、未配信を status CLI で可視化、ローカルチャネルは必ず成功。

# 11\. 安全弁

* **1ランのタスク上限**: `Run.tasks_started`（CLAIM到達数）で比較。到達で HALT し人間に継続確認。
* **セッションのコスト上限**: claude headless にハード制限として渡す。到達で **部分作業破棄＋ブランチ削除＋STOPPED**。
* **監視タイムアウト**: 全体監視は既定オフ（任意設定、total経過時間。status変化でリセットしない）。**「LoopPilot未起動」ガード（state comment/codex review が bounded 時間内に出ない → STOPPED）は常時オン。**
* セッションtimeout・トークン上限はv1では持たない（コスト上限に一本化）。

# 12\. v1 完了定義（成功条件・測定可能）

* 適格チケットが2件以上あるとき、**一度起動したら人間の追加指示なしで**、各チケットを 選定→ブランチ→Claude実装→PR→`loop-pilot`受け渡し→LoopPilotがクリーン到達→**オーケがマージ**→ticket Done→次、と逐次処理し、キュー空 or タスク上限で**通知して綺麗に停止**する。
* `status` CLI で進行中セッション・キュー・履歴・停止箇所が分かる。
* stopped（理由付き）/ CI赤 / 未起動 など失敗時はループが停止し理由付きで通知。
* 全状態がSQLiteに永続化され、再起動で「in_review＋オープンPR」を照合して継続できる。

# 13\. 非スコープ（v2送り）

QA/バグ自動発見・チケット自動生成 ／ タスク内セッション再開・横断メモリ ／ 並列実行 ／ サーバレス(Actions)形態 ／ Webダッシュボード ／ 複数リポジトリ ／ Linear以外のタスク源。

# 14\. 改訂履歴（敵対的レビューでの主な修正）

* **\[ブロッカー\]** done/stopped 検知先を base64 `looppilot-status` から、正しい隠しコメント `looppilot-state`（プレーンJSON）＋著者同定へ修正（§6）。
* **\[ブロッカー\]** LoopPilot auto-merge はオプトイン（既定false）と判明 → **マージ戦略を「オーケが常にマージ」に確定**、完了定義を修正（§3/§5/§6/§12）。
* 状態語彙を正規化し `failure_reason` を導入（§7）。
* CLAIM/IMPLEMENT/HANDOFF/MONITOR/DONE に失敗遷移・冪等性・回復ルールを追加（§5/§9）。
* ハードコードの `main` を `defaultBranch` 化、コスト/トークンをコスト一本化、session-timeoutフック・EventLog・GitHub Issues汎用化を v1 から除去。
