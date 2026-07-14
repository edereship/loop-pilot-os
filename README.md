# LoopPilot OS

LoopPilot OS は、AIコーディングエージェント（Claude Code ヘッドレス）によるプロダクト開発ループを、人間の都度指示なしで回す**ローカル CLI 常駐オーケストレーター**です。Linear の適格チケットを選定し、git worktree でエージェントを起動して実装・PR 作成まで行い、既存の [LoopPilot](https://github.com/edereship/loop-pilot)（PR 上で codex レビュー → Claude 修正 → チェックを回す GitHub Actions システム）へ `loop-pilot` ラベルで受け渡します。LoopPilot がクリーン到達（PR 上の `looppilot-state` 隠しコメントが `done`）したことを検知すると、**オーケが**（LoopPilot ではなく）squash マージし、Linear チケットを Done にして次タスクへ進みます。キュー空 or タスク上限で**通知して綺麗に停止**します。

状態はすべて SQLite（`looppilot-os.db`）に永続化され、再起動時は「`in_review` + オープン PR」を照合して継続できます。1タスク = 1セッション = 1PR、逐次実行（並列なし）。失敗時は**種類に応じてポリシーを振り分け**ます: インフラ系は **halt**（人間へ）、CI 赤・コンフリクトは **recover**（自動修正、上限付き）、設計拒否・検証不合格・無変更は **abandon**（`needs-human` ラベル付与 → 次タスクへ継続）。

> **v3.5 時点のスコープ**: 既存チケット駆動のコアループ + PM 自律化（GROOM フェーズ・横断メモリ）+ 設計品質ゲート（DESIGN REVIEW・セルフレビュー）+ 受け入れ検証ゲート（VERIFY）+ 失敗時ポリシー振り分け（halt / recover / abandon）+ needs-human トリアージ + ネットワーク瞬断リトライ。GROOM フェーズは PM（Codex）によるチケット作成（`create` アクション）を含みます。QA/バグ自動発見・QA起点のチケット自動生成・マルチ実行者ルーティング・並列・複数リポ・Linear 以外のタスク源は v4 以降です。

## アーキテクチャ

疎結合・単一責任のモジュール群を Orchestrator Core が統括し、外部はインターフェース越しに呼びます（仕様 §4）。

```
                ┌──────────────────────────────────────────────────────┐
                │                 Orchestrator Core                    │
                │  ループ駆動 / per-task状態機械 / 安全弁 / GROOM統合   │
                │  / 文脈バンドル組立 / プリフライト / メモリ管理        │
                └─┬───────┬───────┬────────┬──────┬───────┬──────┬─────┘
            TaskSource  Agent   Git/PR  LoopPilot Notifier GROOM  Memory
            (Linear)    Runner  Manager  Monitor           Engine  Store
                │        │        │        │        │        │       │
            Linear API  Claude  git/gh  GitHub   Slack/  Codex  docs/memory/
                        headless         API    console  (PM)   (対象リポ)
                          └────── State Store (SQLite) ──────┘  ◄── Status CLI / Config
```

per-task ライフサイクル（状態機械、仕様 §5）:

```
GROOM ─→ SELECT ─→ CLAIM ─→ DESIGN ─→ DESIGN REVIEW ─→ IMPLEMENT ─→ SELF-REVIEW ─→ VERIFY ─→ HANDOFF ─→ MONITOR ─→ DONE
  │         │         │         │            │               │              │             │          │          │
  │         │         │         │            │               │              │             │          │          ├─ merge gate（マージ直前・v4-B）: 累積ドリフトを Codex 判定
  │         │         │         │            │               │              │             │          │          │    skip（ドリフトなし）／ fail → fix ループ（上限 max_merge_gate_fix_attempts）
  │         │         │         │            │               │              │             │          │          │      └─ 超過 → STOPPED(merge_gate_failed) → park（PR保持・needs-human・ループ継続）
  │         │         │         │            │               │              │             │          │          └─ stopped/closed → ポリシー振り分け
  │         │         │         │            │               │              │             │          │               halt / recover / abandon
  │         │         │         │            │               │              │             │          └─ push/ラベル/遷移 失敗 → STOPPED → HALT
  │         │         │         │            │               │              │             └─ fail → reasons注入 → IMPLEMENT へ戻る
  │         │         │         │            │               │              │                  └─ fail × N超 → STOPPED(verify_failed) → abandon
  │         │         │         │            │               │              └─ fail → STOPPED → HALT（自動リトライなし）
  │         │         │         │            │               └─ 無変更 → abandon ／ コスト超/例外 → HALT
  │         │         │         │            └─ reject × N超 → STOPPED(design_rejected) → abandon
  │         │         │         │                 └─ reject → reasons注入 → DESIGN へ戻る
  │         │         └─ worktree/遷移 失敗 → STOPPED → HALT
  │         └─ 適格なし → IDLE（定期再確認） ／ idle_timeout超過 or タスク上限到達 → HALT（通知）
  │              └─ SCOUT（idle中・v4-A）: idle 30分継続 + 前回から24h → 探索（Claude・証拠必須）→ 検証（Codex）→ 自動起票（上限3件/回・重複禁止）
  │                   objective（コマンド出力で裏が取れる）→ opt-in付き＝次ループで即着手 ／ spec_mismatch → scout-triage（人間トリアージ待ち）
  └─ Codex失敗/タイムアウト → スキップして SELECT へ（HALT しない）
```

- **GROOM**（v3）: SELECT の前に毎ループ実行。Codex（PM）に Linear 盤面全体 + 横断メモリ + 要求/要件定義を見せ、アクション列（reprioritize / create / update / split / close / label / update_memory）を JSON で出力させ、オーケストレーターが検証・代理実行する。失敗時はスキップして SELECT へ（HALT しない）。`groom.enabled = false` で無効化可能。
- **SELECT**: Codex（PM）が盤面 + 直前差分 + メモリを見て「次の 1 件 + 一行根拠」を出す意味的選別。Codex 障害時は決定的順序（Urgent>High>Medium>Low>No → sortOrder → id）にフォールバック。進行中セッション・放棄済みチケットは除外。
- **SCOUT**（v4-A）: 適格チケットが尽きて idle が `scout.idle_minutes`（既定 30 分）続き、前回実行から `scout.min_interval_hours`（既定 24h）経過すると発火する自律バグ発見フェーズ。**2 段パイプライン**: 探索 = Claude Code（read-only 寄りツールで test/型/lint 実行 + spec 照合、全候補に証拠必須）→ 検証 = Codex（①実在するか ②要求/要件定義からズレていないかのブロッキング裁定）。通過した候補のみ Linear に自動起票し、`objective`（コマンド出力で再現可能）は opt-in ラベル付きで即適格＝完全自走、`spec_mismatch`（解釈が絡む）は `scout-triage` ラベルで人間の判断待ち。暴走防止 3 重（起票上限 `scout.max_issues_per_scout`・24h 間隔・既存チケット注入による重複起票禁止）。SCOUT 実行時間は idle 経過に不算入。起票 0 件なら従来どおり idle_timeout で自動停止する。全実行は `scout_log` に監査記録。`scout.enabled = false`（既定）で無効。`ANTHROPIC_API_KEY` 必須（`--bare` モードのため OAuth 不可）。
- **CLAIM**: デフォルトブランチから `<prefix>/<identifier小文字>-<slug>` ブランチ + worktree を切り、Linear を In Progress に。
- **DESIGN**（v3）: Claude Code が read-only セッションで設計 brief（Goal / Change Targets / Implementation Steps / Acceptance Criteria / Out of Scope）を生成。spec・横断メモリを注入し、brief をチケットにコメント書き戻し。
- **DESIGN REVIEW**（v3）: Codex が brief を要求適合・スコープ逸脱・抜け漏れ・リスクの 4 観点でレビュー。**明示的な reject 判定のみ**が DESIGN へ戻す（fail-open: レビュアー例外・コスト超・出力パースエラーは approve 扱いで IMPLEMENT へ進む）。reject 時は reasons を添えて DESIGN へ戻る（最大 `max_design_review_attempts` 回、既定 2）。超過で `design_rejected` HALT。
- **IMPLEMENT**: worktree 内で `claude -p` をコスト上限付き起動。DESIGN の brief を入力として渡す。**実差分**（`origin/<defaultBranch>..HEAD`）で後条件を判定（自己申告は信用しない）。
- **SELF-REVIEW**（v3）: IMPLEMENT 後に**別セッション**の Claude Code がセルフレビュー。要求/brief/spec との整合性・網羅性を検証し、問題があれば自動修正を試みる。**明示的な `fail` 判定のみ**が HANDOFF をブロックする（best-effort: コスト超・エラー・出力パースエラーは non-fatal として HANDOFF へ進む）。Codex レビュー（LoopPilot 経由）と観点を分担し補完関係にする。`self_review.enabled = false` で無効化可能。
- **VERIFY**（v3.5）: SELF-REVIEW 後・HANDOFF 前の受け入れ検証ゲート。**2 アクター構造**で自己採点を避ける: **証拠収集 = Claude（IMPLEMENT とは別セッション）**が build/test/型/lint を実行し結果を収集、**合否判定 = Codex（ブロッキング裁定）**が客観オラクル ＋ acceptance 基準への適合を判定。両方 OK で pass。fail 時は reasons を添えて IMPLEMENT へ差し戻し（fix ループ、最大 `max_verify_attempts` 回、既定 2）。尽きたら `verify_failed` → abandon。fail-open: 検証器の例外・コスト超・パース失敗は pass 扱い（検証器の不調でループを止めない）。`verify.enabled = false` で無効化可能。`verify.run_recipe` を設定するとアプリ実起動まで拡張（未設定時は軽量モードに縮退）。
- **HANDOFF**: push → PR 作成（ready-for-review・**draft 不可**）→ PR 番号を即永続化 → `loop-pilot` ラベル付与 → Linear を In Review に。一時的ネットワークエラーは操作ごとに `transient_retry_attempts` 回リトライ（既定 2 回＝計 3 試行）。
- **MONITOR**: `looppilot-state` 隠しコメント + PR の merged を一定間隔でポーリング。監視中は PR/ブランチに書き込まない（マージを除く）。
- **MERGE GATE**（v4-B）: マージ直前（readiness ready 後・mergePr 直前）に、HANDOFF 時点〜マージ候補 head の累積 diff を Codex が原仕様（handoff 時点の trusted ref から読む）と照合。LoopPilot 中コミットが無ければスキップ（クリーン PR の所要時間は不変）。fail 時は violations を注入した fix_code 固定の自動修正 → CI 再通過 → 再ゲート（上限 `max_merge_gate_fix_attempts`、既定 2。attempt は merge_gate_log の fail 行数で耐久カウント）。超過で park。検証器の不調（fetch/Codex/パース失敗）は pass 扱い + 警告ログ（フェイルオープン）。`merge_gate.enabled = false` で無効化可能。
- **DONE**: `merged` を先に永続化 → Linear を Done に（best-effort・既 Done 許容）→ 次の SELECT へ。

## 必要環境

- Node.js >= 24
- `git`
- `gh`（GitHub CLI、**認証済み** = `gh auth status` が通る。対象リポへの push 権限が必要）
- `claude`（Claude Code CLI、**認証済み** = `claude auth status` で認証確認する）
- 対象リポに [LoopPilot](https://github.com/edereship/loop-pilot) が導入済み（Init/Loop ワークフローが `loop-pilot` ラベルで発火する状態）

## セットアップ

設定は一度だけ。手順は以下の通りです。

### 1. インストールとビルド

依存をインストールし、`npm run build`（`tsc`）で TypeScript を `dist/` へコンパイルします。

```bash
npm install
npm run build
```

`looppilot-os` は `dist/main.js` を指します。`npm run build` で `dist/main.js` が生成されたら `npx looppilot-os ...`、またはグローバルリンク（`npm link`）して `looppilot-os ...` で起動できます。以降の例では `looppilot-os` と表記します。

### 2. 設定ファイルを用意する

example をコピーして実設定を作ります（実設定 `looppilot-os.toml` は `.gitignore` 済みでコミットされません）。

```bash
cp looppilot-os.example.toml looppilot-os.toml
```

`looppilot-os.toml` を対象リポ/Linear に合わせて編集します。主なキー（全キーは `looppilot-os.example.toml` のコメント参照）:

| セクション.キー | 意味 |
| -- | -- |
| `product.goal` | プロダクトのゴールと制約。毎セッションのプロンプト冒頭に入る |
| `repo.path` | 対象リポのローカル絶対パス（クリーンな git 作業ツリーで default_branch 上） |
| `repo.remote` | GitHub の `owner/name` |
| `repo.default_branch` | 基底ブランチ（`main` とは限らない） |
| `repo.worktree_root` | 省略時 `~/.looppilot-os/worktrees/<repoのdir名>` |
| `linear.team` | Linear の team key |
| `linear.project` | Project 名（プリフライトで ID 解決・検証） |
| `linear.opt_in_label` | AI 着手を許可するオプトインラベル名 |
| `linear.states.{todo,in_progress,in_review,done}` | 状態名 → プリフライトで stateId に解決 |
| `agent.model` | `claude --model` に渡すモデル（出荷既定 `claude-opus-4-8[1m]`） |
| `agent.effort` | `claude --effort` に渡す思考レベル（`low\|medium\|high\|xhigh\|max\|auto`・既定 `xhigh`。`auto` はモデル既定にリセット＝effort 非対応モデル向け） |
| `agent.allowed_tools` | `claude --allowedTools`（例 `Edit,Write,Read,Glob,Grep,Bash`） |
| `agent.permission_mode` | `claude --permission-mode` に渡す権限モード（既定 `acceptEdits`）。隔離コンテナでは `bypassPermissions` を選択（下記セキュリティモデル参照） |
| `agent.extra_args` | 任意の追加 claude フラグ（既定なし） |
| `agent.{design,implement,self_review,recovery,verify}.{model,effort}` | フェーズ別オーバーライド（ES-486）。未設定フェーズは `[agent]` を継承。出荷既定（example.toml）: implement = Opus 4.8\[1m\]/xhigh、design・recovery = Opus 4.8/high、self_review = Sonnet 4.6/high、verify = Sonnet 4.6/medium |
| `handoff.branch_prefix` | ブランチ接頭辞（例 `looppilot`） |
| `handoff.pr_body_template` | PR 本文テンプレ。`{identifier}` `{title}` `{issue_url}` を置換 |
| `looppilot.gate_label` | 対象リポの `LOOPPILOT_LABEL` に一致させる（既定 `loop-pilot`・大小無視） |
| `looppilot.state_comment_authors` | LoopPilot の信頼著者（既定 `["github-actions[bot]"]`） |
| `safety.max_tasks_per_run` | 1 ラン中の着手上限（到達で HALT） |
| `safety.max_cost_usd_per_session` | 1 セッションのコスト上限（`claude --max-budget-usd`） |
| `safety.monitor_timeout_minutes` | 全体監視のタイムアウト（任意・既定60分） |
| `safety.not_engaged_guard_minutes` | LoopPilot 未起動ガード（常時オン） |
| `safety.session_hard_timeout_minutes` | hung（無進捗・無支出）claude を切る hard backstop（任意・既定120分。コスト一本化を維持しつつ無人ループの永久ハングを防ぐ） |
| `safety.groom_timeout_minutes` | GROOM フェーズの Codex 起動タイムアウト（既定 10 分） |
| `safety.groom_board_budget_chars` | GROOM 盤面の文字数バジェット（既定 10000） |
| `safety.max_design_review_attempts` | DESIGN REVIEW の最大再設計回数（既定 2。超過で `design_rejected` → abandon） |
| `safety.self_review_timeout_minutes` | セルフレビューセッションのタイムアウト（既定 15 分） |
| `safety.max_cost_usd_per_self_review` | セルフレビューのコスト上限（既定 $2） |
| `safety.max_verify_attempts` | VERIFY 不合格→再実装の上限（既定 2。超過で `verify_failed` → abandon） |
| `safety.max_cost_usd_per_verify` | VERIFY（Claude 証拠収集）セッションのコスト上限（既定 $2） |
| `safety.verify_timeout_minutes` | VERIFY セッションのタイムアウト（既定 15 分） |
| `safety.max_recovery_attempts` | ci_failed/merge_conflict の自動修正上限（既定 2。尽きたら abandon） |
| `safety.max_abandons_per_run` | 1 ラン中の abandon 上限（既定 3。到達で halt — 系統的な問題の早期検知） |
| `safety.transient_retry_attempts` | ネットワーク瞬断の操作リトライ回数（既定 2＝計 3 試行。0 で無効） |
| `verify.enabled` | VERIFY ゲートの有効/無効（既定 `true`） |
| `verify.run_recipe` | アプリ起動/受け入れテストコマンド（未設定なら軽量モードに縮退） |
| `linear.needs_human_label` | abandon 時に付与するトリアージ用ラベル名（既定 `needs-human`。SELECT 除外） |
| `loop.monitor_poll_seconds` | MONITOR のポーリング間隔 |
| `loop.idle_recheck_seconds` | IDLE 時のキュー再確認間隔 |
| `loop.idle_timeout_minutes` | アイドルタイムアウト（既定 120 分。0 で無効化。適格チケットなしが継続し GROOM の空振りコストを防止） |
| `groom.enabled` | GROOM フェーズの有効/無効（既定 `true`。`false` で GROOM フェーズのみ無効化。DESIGN・DESIGN REVIEW・SELF-REVIEW・VERIFY は引き続き実行される） |
| `safety.merge_gate_timeout_minutes` | マージゲート Codex 判定のタイムアウト（既定 15 分） |
| `safety.max_merge_gate_fix_attempts` | ゲート fail 時の自動修正上限（既定 2。尽きたら park） |
| `safety.max_cost_usd_per_merge_gate_fix` | ゲート修正ターン（Claude）のコスト上限（既定 $2） |
| `merge_gate.enabled` | マージ直前 破壊的変更ゲートの有効/無効（既定 `true`） |
| `self_review.enabled` | セルフレビューステップの有効/無効（既定 `true`） |
| `memory.max_chars_per_file` | 横断メモリ 1 ファイルあたりの最大文字数（既定 8000。超過は reject） |
| `memory.inject_budget_chars` | プロンプト注入時のメモリバジェット（既定 6000。カテゴリ均等配分でトランケーション） |
| `digest.recent_merged_count` | プロンプトに含める直近マージ済みセッション要約の件数 |
| `notify.progress` | `true` で各チケットの着手/完了を Slack にも通知（既定 `false`・コンソールログは常時出力） |
| `scout.enabled` | idle 時の自律バグ発見・自動起票（SCOUT・v4-A）の有効/無効（既定 `false`。有効化には Linear に scout / scout-triage ラベルの作成が必要） |
| `scout.idle_minutes` | SCOUT 発火に必要な連続 idle 時間（既定 30 分） |
| `scout.min_interval_hours` | 前回 SCOUT 実行からの最小間隔（既定 24 時間） |
| `scout.max_issues_per_scout` | 1 回の SCOUT で起票できる上限（既定 3 件） |
| `linear.scout_label` | SCOUT 起票チケットに付与する出所ラベル名（既定 `scout`） |
| `linear.scout_triage_label` | spec_mismatch 候補の人間トリアージ用ラベル名（既定 `scout-triage`・SELECT 対象外） |
| `safety.max_cost_usd_per_scout` | SCOUT 探索（Claude）のコスト上限（既定 $2） |
| `safety.scout_timeout_minutes` | SCOUT 探索セッションのタイムアウト（既定 30 分） |
| `safety.scout_review_timeout_minutes` | SCOUT 検証（Codex）のタイムアウト（既定 15 分） |
| `agent.scout.{model,effort,allowed_tools}` | SCOUT 探索のオーバーライド。allowed_tools 未設定時は read-only 既定 `Read,Grep,Glob,Bash(git status)`（テスト実行で objective 証拠を取らせるには Bash の明示追加が必要） |

#### model × effort 対応表

| model | 使える effort |
| -- | -- |
| **Opus 4.8 / 4.7**（出荷既定 `claude-opus-4-8[1m]`） | low / medium / high / **xhigh** / max |
| Opus 4.6 | low / medium / high / max（xhigh 非対応） |
| Sonnet 4.6 | low / medium / high / max（xhigh 非対応） |
| Haiku 4.5 / Sonnet 4.5 | **effort 非対応**（`auto` 以外はエラー。`auto` = `--effort` フラグ自体を省略してモデル既定にリセット） |

* `xhigh` は Opus 4.7+/Fable 5 専用。`max` は Opus 4.6 以降・Sonnet 4.6 で可。
* Haiku 4.5 / Sonnet 4.5 では `agent.effort = "auto"` を指定すると `--effort` フラグを渡さず起動する（effort 非対応モデルを使う場合の逃げ道）。
* 不正な model×effort 組合せは起動前の設定検証（`loadConfig`）で fatal エラーとして報告される（セッションは開始しない）。

状態 DB（`looppilot-os.db`）は `looppilot-os.toml` と同じディレクトリに作られます。

> **⚠️ Linear の PR 自動ステータスについて**: LoopPilot OS は**唯一のステータス管理者**です。Linear の GitHub 連携が PR イベントでチケットステータスを自動変更する設定になっていると、LoopPilot OS の遷移と競合（綱引き）します。**Linear の PR 自動ステータス変更はオフにするか、LoopPilot OS の `[linear.states]` と同じ状態名に揃えてください。**

### 3. シークレットを環境変数で渡す

API キー・Webhook は**ファイルに書かず**環境変数で渡します。

```bash
export LINEAR_API_KEY="lin_api_..."      # 必須（書き込み可能なキー）
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."  # 任意
```

> **注意**: `LINEAR_API_KEY` にはチケットの状態遷移（In Progress / In Review / Done）を行うため**書き込み可能な API キー**が必要です。Linear の個人 API キーはユーザー権限を継承するため通常は問題ありませんが、OAuth トークンで read-only スコープに絞っている場合は状態遷移時に失敗します。

`SLACK_WEBHOOK_URL` 未設定時は**コンソール通知のみ**（コンソールは常時オン）。設定時はプリフライトで Webhook へ直接 POST して到達性を検証します（非 2xx ならプリフライト失敗）。

### 4. プリフライト（起動時に自動実行）

`run` は実ループに入る前に以下を fail-fast で検証し、違反は**全件まとめて**報告して停止します（仕様 §8 / カーネル §9）:

1. `repo.path` がクリーンな git（`git status --porcelain` 空）で `default_branch` 上にある
2. remote 到達可（`git ls-remote origin HEAD`）
3. `gh auth status` 成功 ∧ リポへの push 権限あり ∧ **デフォルトブランチを単独マージ可能**（必須レビュー > 0 やマージ制限があると NG — ループに人間レビュアーが不在のため）
4. `gate_label`（`loop-pilot`）が対象リポのラベルに存在（大小無視）
5. Actions 変数 `LOOPPILOT_AUTO_MERGE` が未設定 or `false`（**オーケが唯一のマージャー**）
6. Linear: API キーで viewer 取得 ∧ team・project・4 状態・opt_in_label が解決できる（※ read クエリのみで検証。書き込み権限の有無は検証しません — 無副作用で照会する手段が Linear API に存在しないため）
7. `claude --version` 成功
8. `codex --version` 成功 ∧ `codex login status` 認証済み（PM 知能レイヤ = SELECT / GROOM / DESIGN REVIEW / VERIFY 判定が Codex を使うため。Linux の bwrap probe は失敗しても致命的にしない）
9. state-comment 著者の整合: リポの `LOOPPILOT_STATE_COMMENT_AUTHORS`（未設定なら既定 `github-actions[bot]`）が `looppilot.state_comment_authors` に包含される（不整合だと Monitor が信頼コメントを発見できず `monitor_never_engaged` で全停止するため）
10. Slack 設定時は Webhook へ直接 POST して到達性確認

### 5. 起動と観測

```bash
# ループ起動（既定の config は ./looppilot-os.toml）
looppilot-os run --config ./looppilot-os.toml

# 状態確認（別ターミナルから／停止後でも可）
looppilot-os status --config ./looppilot-os.toml
```

- `--config <path>` 省略時の既定は `./looppilot-os.toml`。
- **単一インスタンス前提**: `run` はランロック（PID）を取得します。既に生きたインスタンスがある場合は二重起動しません。
- 停止は `Ctrl-C`（SIGINT）。常駐運用向けに **SIGTERM / SIGHUP**（systemd・コンテナ停止・端末切断）も同様に捕捉します。**次の安全点で** Run を `halted`（理由 `user_interrupt`）にしてロックを解放し終了します。安全点は各タスク境界に加え **MONITOR の poll 境界**（数時間に及ぶ監視待機中でも停止可能。セッションは `in_review` のまま残り再起動で回復）。**2 回目**の停止シグナルは即時強制終了（exit 130）。

## 横断メモリ（B2）

PM（Codex）がタスクをまたいで知識を蓄積・参照する仕組みです。対象リポの `docs/memory/` にマークダウンファイルとして正本化されます。

```
docs/memory/
  pm-decisions.md        # PM 判断履歴（優先度変更の根拠、split/close の理由など）
  impl-results.md        # 実装結果（各チケットの成否・学び・注意点）
  product-knowledge.md   # プロダクト知識（アーキテクチャ特性・制約・パターン）
```

- **更新**: GROOM フェーズの `update_memory` アクション経由でオーケストレーターが代理書き込み（カテゴリ単位の全文置換）。1 ファイル最大 `memory.max_chars_per_file`（既定 8000）文字。
- **参照**: フェーズ別にカテゴリを分けて注入（GROOM = 全カテゴリ、SELECT = pm-decisions + impl-results、DESIGN = impl-results + product-knowledge）。注入バジェット `memory.inject_budget_chars`（既定 6000）でトランケーション。
- **永続化**: `update_memory` アクションが実行されると**その GROOM フェーズ中に即座**に `docs/memory/` を git commit + push（`origin/<defaultBranch>` へ直接反映）。また起動時の初回 GROOM で空ファイル生成 + DB から impl-results を自動 bootstrap し、変更があれば即座に commit + push する。HALT 時にも未反映の変更があれば commit + push する。

## `run` の使い方

`run` は以下を繰り返します（仕様 §5・カーネル §7）:

1. **回復処理**（起動直後・後述）
2. タスク上限チェック（`tasks_started >= max_tasks_per_run` → 通知して HALT）
3. **GROOM** → Codex（PM）が盤面整理（`groom.enabled = false` でスキップ）
4. **SELECT** → 適格チケットを 1 件取得。なければ **IDLE**（`idle_recheck_seconds` ごとに再確認、`idle_timeout_minutes` 超過で HALT）
5. **CLAIM → DESIGN → DESIGN REVIEW → IMPLEMENT → SELF-REVIEW → VERIFY → HANDOFF → MONITOR → DONE** を逐次実行
6. いずれかのセッションが STOPPED したら**失敗ポリシー**に応じて **halt**（通知してループ終了）/ **recover**（自動修正を試行）/ **abandon**（`needs-human` ラベル付与し次タスクへ継続）

実行中はコンソールに進捗（claude の stream-json を短縮表示）と各フェーズのログが出ます。

## `status` の使い方

`status` は SQLite を真実の源として、Run + TaskSession から現在の状態を表示します（仕様 §10 / §12）。専用イベントログは持たず、すべて Run/TaskSession から導出します。表示内容:

- **現在の Run**: 状態（`running` / `idle` / `halted`）、開始時刻、タスク上限、`tasks_started`、マージ済み件数（`merged` セッションの実数から導出）、HALT 理由。
- **進行中セッション**: 現在のチケット（identifier / タイトル）、フェーズ（`claimed` / `implementing` / `handing_off` / `in_review`）、ブランチ、PR 番号、コスト。
- **履歴**: 直近の終了済みセッション（`merged` / `stopped` と `failure_reason`・`stop_detail`）。
- **停止箇所**: HALT 時はどのセッションがどの `failure_reason` で止まったか。
- **未配信通知**: Slack 配信に失敗して保留中の通知意図（`notification_intent`）があれば可視化。

> **注意**: `status` も `LINEAR_API_KEY` の export が必要です（設定読込が env シークレットを検証するため）。

## 失敗時の見方（`failure_reason` 一覧）

セッションが STOPPED すると、**失敗ポリシー**に応じて halt / recover / abandon / park に振り分けられます。`status` の `failure_reason` で原因が分かります。14 種すべて（カーネル §2 / 仕様 §7）:

| failure_reason | 意味（どのフェーズで・何が起きたか） | ポリシー | 主な人間の対処 |
| -- | -- | -- | -- |
| `agent_no_change` | IMPLEMENT 後、実差分（`origin/<defaultBranch>..HEAD`）が無い／空コミット／未コミットの残骸（`stop_detail="uncommitted leftovers"` で区別）。自動コミットはしない | **abandon** | `needs-human` ラベルを外すと再投入。チケットの粒度・ゴールを見直す |
| `cost_exceeded` | IMPLEMENT 中に `max_cost_usd_per_session` 到達。部分作業は破棄しブランチ削除済み | **halt** | コスト上限を上げる／タスクを分割する |
| `exception` | 予期せぬ例外（`stop_detail` に message）。MONITOR のポーリングが 5 連続失敗、監視タイムアウト（`monitor timeout`）、回復で対応 PR が見つからない（`crash recovery: ...`）等もここ | **halt** | `stop_detail` を読んで原因に対処 |
| `monitor_never_engaged` | MONITOR で `not_engaged_guard_minutes` を超えても信頼 state コメントが出ない／コメントはあるが破損（`corrupted` は即時） | **halt** | LoopPilot が当該 PR で発火しているか確認 |
| `looppilot_stopped` | LoopPilot 自身が `stopped` 状態に到達。`stop_detail` に LoopPilot の `stopReason`（無い場合 `looppilot stopped (no reason)`） | **recover** | LoopPilot 側のログ・stopReason を確認して PR を手当て |
| `ci_failed` | MONITOR で CI 必須チェックが失敗、またはブランチ保護でマージがブロック | **recover**※ | 自動修正を上限付きで試行。尽きたら abandon（`needs-human`）。ブランチ保護の場合は即 halt |
| `merge_conflict` | MONITOR で PR がデフォルトブランチと衝突（`CONFLICTING` / `DIRTY`） | **recover** | 自動修正を上限付きで試行。尽きたら abandon（`needs-human`） |
| `pr_closed` | PR がマージされずにクローズされた | **halt** | 意図的なら無視、再開したいなら新チケットへ |
| `claim_failed` | CLAIM 失敗（worktree 作成 or Linear 遷移） | **halt** | リポのクリーン状態・ブランチ衝突・Linear 権限を確認 |
| `handoff_failed` | HANDOFF 失敗（push / PR 作成 / ラベル / In Review 遷移） | **halt** | PR があれば手当て、無ければブランチを確認して再実行か破棄 |
| `workflow_setup_failed` | MONITOR 中のワークフロー回復が例外・上限到達・回復不能で失敗 | **halt** | ワークフロー回復ログ・fix-agent の出力を確認 |
| `design_rejected` | DESIGN REVIEW で `max_design_review_attempts` 回の再設計後も Codex が approve しなかった | **abandon** | `needs-human` ラベルを外すと再投入。チケットの曖昧さ・スコープを見直す |
| `verify_failed` | VERIFY ゲートで `max_verify_attempts` 回の再実装後も合格しなかった。`stop_detail` に最後の fail reasons | **abandon** | `needs-human` ラベルを外すと再投入。実装方針・acceptance 基準を見直す |
| `merge_gate_failed` | MONITOR のマージ直前ゲートで違反検出が `max_merge_gate_fix_attempts` 回の自動修正後も解消しなかった。`stop_detail` に violations（`merge_gate:` プレフィックス） | **park** | PR はオープンのまま保持。PR/Linear の理由コメントを確認し、手動マージするか修正を指示。再投入（needs-human 除去 + Todo 戻し）は新規ブランチ・新規 PR で走る点に注意 |

※ `ci_failed` かつ `stop_detail` が `"merge blocked by branch protection"` で始まる場合は **halt**（CI コードに修正対象がなく、ブランチ保護ルールの変更が必要）。

`stop_detail` 列に追加文脈（LoopPilot の stopReason、例外メッセージ、ブロック理由、回復時の手動掃除対象など）が入ります。

### 失敗ポリシー表（v4）

| ポリシー | 動き |
| -- | -- |
| **halt** | ループを停止し人間に通知。インフラ異常や復旧不能な問題に対応 |
| **recover** | CI ログを取得し Codex 分析 → Claude 自動修正を `max_recovery_attempts`（既定 2）回まで試行。尽きたら abandon |
| **abandon** | worktree 破棄・チケットを Todo に復帰（PR 前）、または PR クローズ・ブランチ削除（PR 後）。`needs-human` ラベル＋理由コメントを付与し SELECT から除外。ラベルを外すと再投入される。ループは次タスクへ継続 |
| **park** | PR・ブランチを**保持したまま**セッションを終端し `needs-human` ラベル＋理由コメント（Linear/PR 両方）を付与、`merge_gate_parked` を通知。ループは次タスクへ継続。レビュー済み成果物を捨てない（abandon との違い） |

## 回復の挙動（再起動時）

`run` は起動直後に新しい Run を作り、`merged`/`stopped` でない**アクティブセッション**を SQLite と突き合わせて回復します（仕様 §9 / カーネル §8）。原則は「**`in_review` + オープン PR だけが MONITOR へ再開**。それ以外の中断は全て STOPPED」:

- **`in_review`（PR 番号あり）**: 注入済み Monitor で PR を再評価し、`merged` → DONE 後段から再開（カウンタ二重計上なし）／ `pr_closed` → `stopped(pr_closed)` ／ `stopped` → `stopped(looppilot_stopped)` ／ それ以外（done・in_progress・未起動など open 扱い）→ 新 Run に付け替えて **MONITOR 再開**（未起動ガード/監視タイムアウトの起点 `monitor_started_at` は**上書きしない**＝経過は継続）。
- **`claimed` / `implementing` / `handing_off`**: 決定的ブランチに一致するオープン PR があれば採用して MONITOR へ。無ければ `stopped(exception)`（`stop_detail` に手動掃除対象 — ブランチ・worktree・identifier）として **HALT** し、人間の掃除を促す（タスク内自動再開は v1 非スコープ）。
- **孤児チケット**（Linear が In Progress だがセッション行が無い = CLAIM 途中クラッシュ）: best-effort で Todo へ復帰し、コンソールに警告。

回復で HALT しなかった場合のみループに入ります。

## 動作確認（手動 E2E チェックリスト）

仕様 §12 の v1 完了定義を、実環境で測定可能に確認する手順です。**LoopPilot 導入済みのテストリポ**と **Linear テスト Project** を用意して実施します。

### 前提（準備）

- [ ] テストリポに LoopPilot が導入され、`loop-pilot` ラベルで Init/Loop ワークフローが発火する（`LOOPPILOT_AUTO_MERGE` は未設定 or `false`）。
- [ ] テストリポはクリーン（`git -C <repo> status --porcelain` が空）で default_branch 上。default_branch に**必須レビュー > 0 を課さない**（オーケが単独マージするため。プリフライト 3 で弾かれる）。
- [ ] Linear テスト Project に**適格チケットを 2 件**用意する: いずれも対象 Team/Project ∧ **Todo** ∧ オプトインラベル（`linear.opt_in_label`）付き。2 件は十分小さく、claude が `max_cost_usd_per_session` 内で完了でき差分を生む内容にする。
- [ ] `looppilot-os.toml` を当該リポ/Linear に合わせて設定し、`LINEAR_API_KEY`（必要なら `SLACK_WEBHOOK_URL`）を export 済み。

確認コマンド（前提）:

```bash
# リポがクリーンで default_branch 上か
git -C /abs/path/to/target-repo status --porcelain        # 出力が空であること
git -C /abs/path/to/target-repo rev-parse --abbrev-ref HEAD  # default_branch 名であること

# loop-pilot ラベルがリポに存在するか
gh api repos/<owner>/<name>/labels --paginate --jq '.[].name' | grep -i '^loop-pilot$'

# LOOPPILOT_AUTO_MERGE が未設定 or false か（404 = 未設定 = OK）
gh api repos/<owner>/<name>/actions/variables/LOOPPILOT_AUTO_MERGE --jq .value || echo "unset(=OK)"

# 適格チケットが 2 件見えるか（Linear UI でも可）
looppilot-os status --config ./looppilot-os.toml   # 起動前は履歴空・Run 無しを確認
```

### 実行（一度起動したら追加指示なし）

- [ ] **ループを起動**する（以後、人間の追加指示は一切与えない）:

```bash
looppilot-os run --config ./looppilot-os.toml
```

- [ ] プリフライトが全項目グリーンでループに入る（違反があれば全件まとまって表示され、ここで止まる = 正しい挙動）。
- [ ] コンソールに `run_started` 通知と SELECT → CLAIM → IMPLEMENT → HANDOFF → MONITOR の進行ログが出る。

### 検証（逐次 2 件処理 → 綺麗に停止）

別ターミナルから随時 `status` と `gh`/Linear で観測します。

- [ ] **1 件目**: ブランチ + worktree が切られ（`<prefix>/<identifier>-<slug>`）、Linear が **In Progress** に遷移し、claude が実装・コミットし、**PR が ready-for-review で作成**され `loop-pilot` ラベルが付き、Linear が **In Review** に遷移する。

```bash
# 進行中セッションとフェーズ
looppilot-os status --config ./looppilot-os.toml

# 作成された PR を確認（loop-pilot ラベル付き・open）
gh pr list -R <owner>/<name> --state open --json number,labels,title

# LoopPilot の state コメントが出ているか（信頼著者・looppilot-state）
gh api repos/<owner>/<name>/issues/<pr>/comments --paginate \
  --jq '.[] | select(.body | startswith("LoopPilot state is stored in this comment.")) | .body' | tail -1
```

- [ ] LoopPilot がレビュー/修正を回して `looppilot-state.status=="done"`（クリーン）に到達する。
- [ ] **オーケがマージ**する（LoopPilot ではない）。PR が squash マージされ、Linear が **Done** に遷移する。

```bash
gh pr view <pr> -R <owner>/<name> --json state,mergedAt,mergedBy   # MERGED / mergedAt!=null
```

- [ ] **2 件目**: 1 件目のマージ後、**追加指示なしで自動的に**次の適格チケットが SELECT され、同じ流れ（ブランチ → 実装 → PR → ラベル受け渡し → done 検知 → オーケがマージ → Done）が逐次で進む。
- [ ] **キュー空 → IDLE → 停止**: 2 件とも Done になり適格チケットが尽きると、`idle` 通知（キュー空）が出て Run が `idle` になり、`idle_recheck_seconds` ごとに再確認する（新チケットを入れれば再開する）。タスク上限（`max_tasks_per_run`）に先に達した場合は `halted`（タスク上限）通知で綺麗に停止する。

```bash
# 最終状態: Run=idle（または halted）、merged 件数=2、停止箇所/失敗理由なし
looppilot-os status --config ./looppilot-os.toml
```

### 期待される最終状態（合否判定）

- [ ] `status` で **2 件が `merged`** と表示され、各チケットが Linear で **Done**。
- [ ] Run の状態が `idle`（キュー空）または `halted`（タスク上限）で、**`failure_reason` を持つセッションが無い**。
- [ ] 通知（コンソール、Slack 設定時は Slack）に `run_started` と `idle`（または タスク上限の `halted`）が出ている。未配信通知が残っていない。
- [ ] **失敗系の確認**（任意）: わざと壊れたチケット（差分を生まない指示など）を 1 件投入すると、対応する `failure_reason`（例 `agent_no_change`）で 1 セッションが `stopped`（`recoveryAction=abandon`）、`needs-human` ラベルが付与されてループは継続（`task_skipped` 通知）、Run は `halted` にならず次タスクへ進む（キュー空なら `idle`）。`status` に停止箇所・理由・`recoveryAction` が表示される。
- [ ] **再起動回復の確認**（任意）: `in_review`（オープン PR あり）のセッションがある状態で `run` を再起動すると、その PR の MONITOR が継続（`monitor_started_at` は維持）され、マージ済みなら DONE 後段から再開してカウンタが二重計上されない。

これらが満たされれば、仕様 §12「一度起動したら人間の追加指示なしで、各チケットを 選定→ブランチ→Claude実装→PR→`loop-pilot` 受け渡し→LoopPilot がクリーン到達→**オーケがマージ**→ticket Done→次、と逐次処理し、キュー空 or タスク上限で**通知して綺麗に停止**する」を満たします。

## 開発

```bash
npm run check        # 型チェック（src + tests）+ vitest を一括
npm test             # vitest のみ
npm run typecheck    # src の型チェックのみ
```

CI（`.github/workflows/ci.yml`）は push(main)/PR で `npm ci && npm run check` を回します。

## セキュリティモデル（`bypassPermissions` 使用時）

`agent.permission_mode = "bypassPermissions"` は Claude Code の全権限チェックを迂回し、agent がツール呼出でブロックされなくなります。**使い捨て隔離コンテナ/VM でのみ使用してください。** 以下の補償条件がすべて必要です。

### 1. 資格情報分離（不変条件: agent は push/merge できない）

- **env スクラブ**: agent 子プロセスには `GH_TOKEN` / `GITHUB_TOKEN` / `LINEAR_API_KEY` / `SLACK_WEBHOOK_URL` 等の機密 env を渡しません（`agent-runner.ts` で除去済み）。
- **ambient 認証の隔離**: `gh auth login`（`~/.config/gh/hosts.yml`）が agent から読める場合、env 除外だけでは Bash 経由の `gh pr merge` / `git push` を防げません。以下のいずれかで対処してください:
  - agent を別ユーザー/別 HOME で実行（`useradd agent-user && su - agent-user`）
  - コンテナに `gh` をインストールしない（agent の作業に gh CLI は不要 — push/PR はオーケ側 `GitPrManager` が行う）
  - `GH_CONFIG_DIR` を空ディレクトリに向ける

### 2. Egress 制限

コンテナ/サンドボックスで以下のみ許可し、資格情報の外部 exfiltrate を遮断してください:

- LLM エンドポイント（`api.anthropic.com` 等）
- パッケージレジストリ（`registry.npmjs.org` 等 — 必要な場合）
- GitHub API（オーケストレーター用 — agent からは不要）

**実装方法**: コンテナ FW（iptables/nftables）が確実です。Claude Code の `network_allowlist`（sandbox 設定）は Claude 自身のネットワークのみを制限し、Bash からの `curl` は制限外です。

### 3. 非 root 実行

`bypassPermissions` モードでは root（UID 0）での実行をプリフライトで拒否します。コンテナを非 root ユーザーで起動してください。

```dockerfile
RUN useradd -m agent
USER agent
```

## 設計ドキュメント

- 設計仕様書 v1（コアループ）: `docs/specs/design-spec-v1-core-loop.md`
- 設計仕様書 v3（PM 自律化）: `docs/superpowers/specs/2026-06-22-v3-pm-autonomy-design.md`
- 設計仕様書 v3.5（自走堅牢化）: `docs/superpowers/specs/2026-06-27-v35-self-driving-hardening-design.md`
- 実装計画（共有カーネル + 各タスク章）: `docs/superpowers/plans/`
