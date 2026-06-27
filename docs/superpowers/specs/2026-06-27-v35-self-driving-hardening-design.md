# v3.5 設計仕様: 自走堅牢化（受け入れ検証ゲート・自己回復）

> ステータス: **ドラフト（スコープ・主要設計合意済み・実装詳細は各チケットで詰める）**
> 作成: 2026-06-27
> マイルストーン: [v3.5 自走堅牢化（受け入れ検証ゲート・自己回復）](https://linear.app/edereship/project/looppilot-os-7a8262819c6f)
> 関連: v3 設計仕様（`docs/superpowers/specs/2026-06-22-v3-pm-autonomy-design.md`）/ 要求仕様書（`docs/specs/requirements.md`）

## 0. 背景と目的

現状の正しさ担保は DESIGN REVIEW（コード前）＋ 外部 LoopPilot のレビュー ＋ CI グリーンまで。「チケットの意図どおりに**実際に動くか**」を行動レベルで確認するゲートが無く、IMPLEMENT の後条件も「実差分が存在するか」止まり（振る舞いを見ていない）。また失敗の多くが**ループ全体を HALT して人間に上げる**設計のため、無人運用が 1 件の詰まりで止まる。

v3.5 の目的は、**完全自走（一度起動したら人間の追加指示なしで回り続ける）** に向けて、現状で人間 HALT に依存している箇所を **AI ゲート／自己回復** に置き換えること。設計方針の核は「**新しい仕組みをゼロから作らず、既存パターン（DESIGN REVIEW / SELF-REVIEW / recovery-turn / executeAbandon）を複製・拡張する**」。

## 1. スコープ（4 要求）

- **C1. VERIFY フェーズ（受け入れ検証ゲート・軽量モード）** — IMPLEMENT 直後・HANDOFF 前のローカルゲート。build/test/型/lint の客観オラクル ＋ DESIGN が書いた acceptance 基準への適合を確認する。
- **C2. HALT → 自己回復／放棄継続ポリシー層** — FailureReason ごとに halt / recover / abandon を切り替える方針テーブルを導入。ci_failed / merge_conflict は CI ログを見て自動修正を上限付きで回す。
- **C3. VERIFY 行動検証モード** — C1 をアプリ実起動（`verify.run_recipe`）まで拡張。未設定時は C1 へ自動縮退。
- **N1. ネットワーク瞬断の 1 回リトライ（対話で追加）** — ループ全体を止めうるネットワーク操作のうち未リトライ箇所に、一時的エラー限定の 1 回リトライを足す。

実装順: **C1 → C2 → C3**（N1 は独立・並行可）。

## 2. 確定した設計決定（2026-06-27 ブレストで確定）

### I. 失敗時の方針（C2 の背骨）
- **D-01** 失敗は種類で振り分ける（halt / recover / abandon）。完全自走の核。
- **D-02** abandon（諦めて次へ）したチケットは `needs-human` ラベル＋理由コメント＋通知で見える化。SELECT は当該ラベル付きを除外（無限リトライ防止）。GROOM も当該ラベルには手を出さない。opt-in ラベルは残す。人間が `needs-human` を外すと再投入される。

### II. VERIFY（C1）
- **D-03** 2 アクター構造: **実行・証拠収集 = Claude（IMPLEMENT とは別セッション）／ 合否判定 = Codex（ブロッキング裁定）**。自己採点を避ける。
- **D-04** 合否基準: **客観オラクル（build / test / 型 / lint）を必須の土台**にしつつ、その上で Codex が **acceptance 基準を満たすか**も判定。両方 OK で pass。
- **D-05** acceptance の出所: DESIGN が brief に書いた `## Acceptance Criteria`（`BriefSections.acceptance`）を回収・照合。新概念を増やさない。
- **D-06** 不合格時: **IMPLEMENT へ差し戻して reasons 注入で作り直す** fix ループ。上限 `max_verify_attempts`（既定 2）。尽きたら `verify_failed` → abandon（D-02）。
- **D-07** フェイルセーフ: **fail-open**（verifier 例外・コスト超・パース失敗は pass 扱い＝検証器の不調でループを止めない）。
- **D-08** 出力スキーマ: 合否 JSON は最小限 `{ verdict: "pass" | "fail", reasons: string[] }`。証拠（build/test/型/lint の結果）は Claude が収集 → Codex に渡し、**`verify_log` 監査テーブル**に保存（`status` で後追い可）。
- **D-09** SessionState は足さず `implementing` のサブステップとして回す（クラッシュ回復は recoverByOpenPr の implementing 経路に自然に落ちる）。**配置順は IMPLEMENT → SELF-REVIEW → VERIFY(↔fix) → HANDOFF**（self-review が安価な自己改善、VERIFY が独立ゲート。VERIFY fix ループは IMPLEMENT 差し戻し）。⚠️ **クラッシュ回復の注意点**: 現状の crash recovery（`orchestrator.ts:493-524`）は「self-review 完了済み → HANDOFF」を判定するが、SELF-REVIEW 後・VERIFY 前後のクラッシュに対応していない。T4 実装時は `self_review_log` チェックの直後に `verify_log` の完了チェックを追加すること（`verdict="pass"` の最終エントリが存在する → HANDOFF へ; VERIFY 未完了 → VERIFY から再開）。`verify_log` チェックなしで HANDOFF へジャンプすると、受け入れゲートが未実施のまま PR が作成される。

### III. C2 自己回復
- **D-10** ci_failed / merge_conflict は **CIログを見て N 回（既定 `max_recovery_attempts=2`）自動修正、尽きたら abandon**。ただし `ci_failed` で `stop_detail` が `"merge blocked by branch protection"` で始まる場合（`orchestrator.ts:3101-3106`）は CI コードに修正対象がないため **recover ループに入らず halt** とする（D-12 の静的 halt として分類）。T3/T6 実装時は `stop_detail` を検査してこのケースを除外すること。
- **D-11** **CI 失敗ログを `gh` で取得し、Codex 分析＋Claude 修正に注入**する（現状は detail=null で盲目的なため必須改善）。
- **D-12** abandon 種（agent_no_change / design_rejected / verify_failed）は **policy で静的に abandon** へ（Codex recovery turn を経由しない）。PR 有無で abandon 方式を切替（PR 後=executeAbandon / PR 前=discardWorktree+Todo 復帰）。

### IV. C3 / N1
- **D-13** C3 起動方法: config キー `verify.run_recipe`。未設定なら C1 へ自動縮退。重い「起動スキル参照」方式は将来拡張。
- **D-14** N1: **一時的(transient: ネットワーク/タイムアウト/5xx/接続リセット)エラーのみ 1 回リトライ**。決定的(リポ汚染/ブランチ既存/認証/cost_exceeded)はリトライせず即 HALT。設定キー `safety.transient_retry_attempts`（既定 1、0 で無効）。

### V. 数値の既定
- **D-15** `max_verify_attempts=2` / `max_cost_usd_per_verify=2` / `verify_timeout_minutes=15`（既存 DESIGN REVIEW=2回・self-review=$2・15分に整合）/ `max_recovery_attempts=2` / `transient_retry_attempts=1`。

## 3. 既存コードの接続点（seam map・実装者向け）

> 以下はコード精査で得た正確な接続点。各チケットの雛形・参照に使う。

### C1 VERIFY の雛形
- **DESIGN REVIEW ゲート**（`approve/reject` 版の雛形）: `src/design-review-prompt.ts` / `src/design-review-parser.ts`、ゲート本体 `src/orchestrator.ts:1143-1294`、reviewer は `PlanRunner|null`（deps `orchestrator.ts:84` / main 配線 `main.ts:265`）。**worktree 汚染ガード**（精査の要）: 開始SHA `git rev-parse HEAD` を**実行前**に記録 → 実行後に `bestEffort(discardUncommittedChanges)` → `git checkout <branch>`（失敗で halt）→ `git reset --hard <startSha>`（失敗で halt）（`orchestrator.ts:1183-1244`）。fail-open（null/例外/error/parse_error→approve）。
- **SELF-REVIEW**（IMPLEMENT→HANDOFF の同位置・別 Claude セッションの雛形）: `src/self-review-prompt.ts` / `src/self-review-parser.ts`、配置 `orchestrator.ts:977-995`、別エージェント `selfReviewAgent`（`main.ts:184-185`）、`self_review_log` テーブル（`store.ts:93-105`）、config `self_review.enabled` / `self_review_timeout_minutes` / `max_cost_usd_per_self_review`（`config.ts:104-105,122-124,878-880`）、per-phase override `agent.self_review.{model,effort}`（`config.ts:55-58,817-819`）。
- **⚠️ VERIFY 特有の最重要差分**: SELF-REVIEW は単一アクター（Claude が実行＋合否を 1 JSON で出す）。VERIFY は **実行=Claude / 合否=Codex** に分割する。さらに **worktree 保護の reset 先は「IMPLEMENT 後の HEAD」**（DESIGN REVIEW のように pre-work SHA に戻すと実装そのものを消す）。検証器の汚染だけ除去し、実装は残す。
- **acceptance / brief**: `BriefSections`（goal/changeTargets/steps/acceptance/outOfScope の 5 string、`types.ts:241-247`）、`parseBrief`（`plan-brief.ts:107-155`）。in-memory `planBrief` は IMPLEMENT/SELF-REVIEW へ既にスレッドされている（`orchestrator.ts:974-980`）ので VERIFY は `planBrief.sections?.acceptance` を**無償で**読める。プロセス再起動時は永続化された `task_session.plan_brief`（raw）を `parseBrief` で再解析（`sections===null` なら ticket 説明へフォールバック）。実差分は `origin/<defaultBranch>..HEAD`（`git-pr.ts:94-120`）。

### C2 ポリシー / 回復の雛形
- **静的方針テーブルの前例**: `src/stop-reason.ts:7-21`（`AUTO_RESTART` Set + `classifyStopReason`）。`FAILURE_POLICY: Record<FailureReason,'halt'|'recover'|'abandon'>` を同型で新設。
- **唯一の分岐点**: `Orchestrator.stopSession`（`orchestrator.ts:3146`）。recover ゲート（`:3164-3192`）と terminal 分岐（`:3440-3456`、現状 design_rejected のみ CONTINUE）をポリシー駆動に置換。
- **FailureReason**: 12 メンバ（`types.ts:15-27`）。`verify_failed` を追加。
- **abandon 機構（実装済み）**: post-PR=`executeAbandon`（PR close + worktree破棄 + remote branch削除 + Todo復帰、`recovery-turn.ts:529-600`）。pre-PR=design_rejected 流の `discardWorktree`+Todo復帰（`orchestrator.ts:929-945`）。**現状 abandon は Codex recovery turn 経由でしか到達しない**ため、policy から直接呼べるようにする。
- **SELECT 除外（実装済み・要統一）**: `abandonedIssueIds`（recovery_action='abandon'、`store.ts:754-762`）/ `designRejectedIssueIds`（failure_reason、`store.ts:764-772`）。`needs-human` 除外を含め統一クエリへ。
- **回復ループ（ci_failed/merge_conflict）**: 現状は一発限り boolean `recoveryAttempted`（`orchestrator.ts:3192`, `types.ts:77`）。耐久カウンタ＋`max_recovery_attempts` に置換し、尽きたら `executeAbandon`。雛形は `AgentWorkflowRecovery` の N 回ループ（`workflow-recovery.ts:40-54`, config `maxWorkflowFixAttempts`）と autoRestart cap（`orchestrator.ts:2727-2744`）。ci_failed/merge_conflict 検出は `monitor.ts:156-177` → `tryMerge`（`orchestrator.ts:3087-3108`）で detail=null のため**ログ注入が必要**。

### N1 遷移リトライ／冪等性
- 遷移は `issueUpdate(input:{stateId})` の**絶対セット**（`task-source.ts:231-243`, MUTATION `:29`）。同状態の再セットは success（Linear 自動遷移とバッティングしても失敗判定にならない）。`success:false`（本物のエラー）か例外時のみ throw。
- 現状リトライ被覆: CLAIM `in_progress`（`orchestrator.ts:1052`）は**素**＝瞬断で claim_failed→HALT。HANDOFF `in_review`（`:2485`）と DONE `done`（`:3126`）は既に `retry(3)`（`orchestrator.ts:3642`）。→ N1 は CLAIM 遷移と HANDOFF の git/gh 操作（push/PR作成/ラベル）の未リトライ箇所に限定。**PR 作成は非冪等**なので「既存 PR 検出＝成功扱い」の冪等化を併設。
- **N1 の保証スコープ外（明示的除外）**: 以下の `source.transition` 呼び出しは既に halt/exception 経路上にあるため N1 のリトライ対象から除外する（失敗してもチケット stuck リスクは残るが halt は確定しており、リトライで halt を回避できない）: ① DESIGN REVIEW max 超過後の Todo 復帰（`orchestrator.ts:934`）— 失敗時は `haltIfRevertFailed=true` で stopSession が halt する; ② クラッシュ回復の clean-implementing exception 経路（`orchestrator.ts:480`）— 失敗時も同様に `stopSession(session, "exception")` で halt する。これらの Todo 復帰に瞬断リトライを追加しても halt は変わらず、チケットが stuck になりにくくなる程度の改善のため、v3.5 の N1 では対象外とする（将来の「Todo stuck 救済チケット」で対応可）。

## 4. 失敗ポリシー表（最終形）

| FailureReason | policy | 動き |
| -- | -- | -- |
| `claim_failed` / `exception` / `monitor_never_engaged` / `workflow_setup_failed` / `cost_exceeded` | **halt** | インフラ異常・継続は危険。人間へ（現状維持） |
| `agent_no_change` / `design_rejected` / `verify_failed`(新) | **abandon** | `needs-human` ラベル＋理由コメント＋通知 → SELECT 除外 → 次へ |
| `ci_failed` / `merge_conflict` | **recover→abandon** | CI ログを見て N(=2) 回自動修正、尽きたら abandon。ただし `ci_failed` かつ `stop_detail` が `"merge blocked by branch protection"` で始まる場合は **halt**（CI ログに修正対象なし・ブランチ保護ルール変更が必要） |
| `handoff_failed` / `looppilot_stopped` | **recover** | Codex recovery turn で復旧（handoff 再試行 / LoopPilot 自動再起動）。尽きたら halt |
| `pr_closed` | **halt** | PR が消失 — 復旧不能のため halt（部分 abandon クリーンアップ中を除く） |

## 5. Config 追加キー

新規テーブルとして config ファイル末尾に追記するキー群:

```toml
[verify]
enabled = true            # VERIFY ゲートの有効/無効
run_recipe = ""           # C3: アプリ起動/受け入れテストコマンド。未設定なら C1 軽量モードに縮退

[agent.verify]            # 任意・per-phase override（未指定は agent.model/effort 継承）
# model = "..."
# effort = "..."

[safety]
max_verify_attempts = 2          # VERIFY 不合格→再実装の上限
max_cost_usd_per_verify = 2      # VERIFY（Claude 実行）セッションのコスト上限
verify_timeout_minutes = 15      # VERIFY セッションのタイムアウト
max_recovery_attempts = 2        # ci_failed/merge_conflict の自動修正上限（尽きたら abandon）
transient_retry_attempts = 1     # N1: 一時的エラーのリトライ回数（0 で無効）

[pm.effort]
verify = "high"           # Codex 合否判定の effort（既存 pm.effort.* と同列）
```

**`needs_human_label` は既存の `[linear]` ブロック内に挿入する**（`[linear.states]` より前）。`[linear]` を末尾に再宣言すると TOML パーサが重複テーブルエラーを返すため、新たな `[linear]` ヘッダを追記せず、既存の `[linear]` セクション内に直接 1 行追加すること:

```toml
# 既存 [linear] ブロック内の [linear.states] より前に挿入
[linear]                          # ← これは既存ヘッダ（追加しない）
needs_human_label = "needs-human" # abandon 時に付与するトリアージ用ラベル名
# [linear.states] ...             # ← 既存
```

## 6. 実装チケット（9 件・依存順）

```
Phase 1:           T1/ES-487 Foundation ∥ T9/ES-488 瞬断リトライ（独立）
Phase 2 (parallel): T2/ES-489 VERIFY prompt+parser ∥ T3/ES-490 失敗ポリシー表
Phase 3 (parallel): T4/ES-491 VERIFY 統合 ∥ T5/ES-492 needs-human ∥ T6/ES-493 回復ループ拡張
Phase 4:           T7/ES-494 VERIFY 行動検証モード (C3)
Phase 5:           T8/ES-495 E2E + ドキュメント
```

- **T1** Foundation — 型（`verify_failed` / VerifyVerdict / VerifyLogRow / policy 型）＋ config 全キー（§5）＋ DB マイグレーション（`verify_log` テーブル・recovery カウンタ列）＋ example.toml。
- **T2** VERIFY prompt + parser — Claude 実行プロンプト（証拠収集）＋ Codex 判定プロンプト ＋ `{verdict,reasons[]}` パーサ（design-review を雛形）。
- **T3** 失敗ポリシー表 — `FAILURE_POLICY` を `stopSession` の 1 箇所に配線。静的 abandon・PR 前/後 abandon 切替・SELECT 除外統一。
- **T4** VERIFY 統合（最重量）— 2 アクターゲートを IMPLEMENT→HANDOFF 間に。worktree 保護（**IMPLEMENT 後 SHA**）＋ fix ループ（不合格→IMPLEMENT 差し戻し・上限2）＋ `verify_log` 監査 ＋ クラッシュ回復。
- **T5** needs-human トリアージ — abandon 時に `needs-human` 付与＋理由コメント＋通知、SELECT 除外、GROOM 不干渉。v4-A トリアージ共通基盤。
- **T6** 回復ループ拡張 — 一発 boolean を耐久カウンタ＋`max_recovery_attempts` に。尽きたら `executeAbandon`。**CI 失敗ログ取得→Codex/Claude 注入**。
- **T7** VERIFY 行動検証モード（C3）— `verify.run_recipe` で実起動・受け入れテスト、未設定で C1 縮退。
- **T8** E2E + ドキュメント — 統合検証 ＋ README ＋ example.toml ＋ マイルストーン更新 ＋ **Linear 自動ステータスとの綱引き注意書き**（オーケが唯一のステータス管理者）。
- **T9** ネットワーク瞬断の 1 回リトライ（独立）— transient 限定リトライを CLAIM 遷移 / HANDOFF git・gh 操作の未リトライ箇所に。PR 作成は冪等化。

## 7. オープン項目の解決（マイルストーン記載 6 項目）

| マイルストーンのオープン項目 | 解決（2026-06-27） |
| -- | -- |
| VERIFY 出力スキーマの具体フィールド | `{verdict,reasons[]}` 最小 ＋ 証拠は `verify_log`（D-08） |
| acceptance 照合の合否判定基準 | 客観オラクル必須 ＋ Codex acceptance 判定、両方 OK で pass（D-04） |
| max_verify_attempts / max_cost_usd_per_verify 既定 | 2 / $2（D-15） |
| C2 policy テーブルの最終形 | §4 の表。ci/conflict は recover×2→abandon、CI ログ注入（D-10/11） |
| C3 run_recipe の表現と縮退 | config キー `verify.run_recipe`、未設定で C1 縮退（D-13） |
| needs-human ラベル・トリアージ設計（v4-A と共通化） | `needs-human` ラベル方式（新ステート不要）＋ SELECT 除外。v4-A トリアージと共通（D-02） |

## 8. 設計上のガード（チケット化時に厳守）
- VERIFY は「実装した Claude 自身に合格判定させない」二重独立（実行=別 Claude / 判定=Codex）を必須とする。
- 合否は客観オラクル（テスト/型/lint、C3 では実起動結果）に最大限接地し、acceptance は brief / `docs/specs` から明示注入する（基準なしの LLM judgment にしない）。
- abandon 継続は暴走防止のため 1 ラン起票/放棄の上限・監査記録を伴う（GROOM の既存キャップ思想を流用）。
- fix ループ・recovery ループは無限ループ防止に上限（既存 auto-restart limit=3 と同思想）。
- N1 のリトライは**冪等な操作のみ無条件**、非冪等操作（PR 作成）は冪等化を併設。決定的エラーはリトライしない。
