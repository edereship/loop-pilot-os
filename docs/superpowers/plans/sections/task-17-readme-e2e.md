### Task 17: README + 手動E2E手順

**目的**: ユーザーが LoopPilot OS v1 をゼロから設定・起動・観測・トラブルシュートできるよう、Task 1 で骨子だけ置いた `README.md` を完成形に書き換える（Create ではなく **Modify**）。概要 / アーキテクチャ図 / セットアップ / `run`・`status` の使い方 / 失敗時の `failure_reason` 一覧表（カーネル §2 の10種）/ 回復の挙動 / 手動 E2E チェックリスト（仕様 §12 の完了定義どおり）を記述する。あわせて `looppilot-os.example.toml` が Task 1 でカーネル §3 と一字一句一致して作られていることを最終確認する（差分があれば openQuestions で報告し、自分では書き換えない）。

**依存タスク**: Task 1（`README.md` 骨子・`looppilot-os.example.toml` を作成済み）。内容の正確性は Task 16（`status` CLI 配線・`looppilot-os` bin）まで通った状態を前提に記述するが、本タスク自体はドキュメントのみで実コードに依存しない。これは **コード変更なしのドキュメントタスク**であり、計画フォーマットの TDD（red→green）は例外とする（カーネル §10 の TDD は「全タスク red→green」だが本タスクはテスト対象コードを持たない。各ステップに検証コマンドと期待出力を付けて担保する）。

**カーネル参照**: §0（CLI 契約: bin `looppilot-os` / サブコマンド `run`・`status` / `--config <path>` 既定 `./looppilot-os.toml`）、§2（`FailureReason` 10種・`NotifyEvent` 3種）、§3（Config TOML 全文 = example.toml の正）、§7（Orchestrator 規約）、§8（回復処理）、§9（プリフライト10項目）。仕様参照: §4（アーキテクチャ図 ASCII）、§8（設定・プリフライト）、§9（回復ルール）、§10（可観測性・通知）、§11（安全弁）、§12（v1 完了定義）。

**実検証済みの実物（2026-06-05）**:
- 外部 CLI: Node `v24.15.0` / `gh 2.92.0`（認証済み account `racoma-dev`）/ `claude 2.1.165`（認証済み）。
- LoopPilot 連携契約の裏取り（`/home/racoma-dev/loop-pilot` ソース）:
  - `src/state-manager.ts`: `STATE_MARKER="looppilot-state"`、可視テキスト `"LoopPilot state is stored in this comment."`、`VALID_STATUSES = {initialized, waiting_codex, fixing, done, stopped}`、`stopReason` は文字列 or `null`。
  - `.github/workflows/looppilot-init.yml`: トリガ `types: [opened, ready_for_review, labeled]`（= PR は ready-for-review で作成しラベルを後付けすれば Init が発火する。カーネル §5.3 の「draft にしない」と整合）。
- 既存ファイル: `README.md` と `looppilot-os.example.toml` は Task 1 が作成済み（本タスクは README を Modify、example.toml は読み取り確認のみ）。

**絶対規則の遵守**: 触ってよい実ファイルは `README.md` のみ。`looppilot-os.example.toml` は**読むだけ**（一致確認）で書き換えない。`docs/superpowers/plans/` 配下（本セクションファイル以外）・カーネル・仕様・`src/`・`tests/`・`package.json` 等は一切変更しない。

**作業ディレクトリ**: `/home/racoma-dev/loop-pilot-os`（Task 1〜16 完了済み・git 初期化済み・`origin` 設定済み）。コマンドは絶対パス（`git -C <abs>` 等）で行い `cd` を避ける。

#### Files

- Modify: `/home/racoma-dev/loop-pilot-os/README.md`
- Read-only（確認のみ・変更しない）: `/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml`

---

- [ ] **Step 1: `looppilot-os.example.toml` がカーネル §3 と一致することを最終確認する**

example.toml を読み、カーネル §3 の TOML 全文（`[product]` … `[notify]`、全キー・既定値・コメント）と**一字一句一致**することを確認する。本タスクは README からこのファイルを参照するため、ここでの一致が前提条件になる。

```bash
cat /home/racoma-dev/loop-pilot-os/looppilot-os.example.toml
```

期待: カーネル §3 と完全一致する以下のセクション/キーが揃っている — `[product].goal` / `[repo].path,remote,default_branch`（+ `worktree_root` 省略時コメント）/ `[linear].team,project,opt_in_label` と `[linear.states].todo,in_progress,in_review,done` / `[agent].model,allowed_tools`（+ `extra_args` コメント）/ `[handoff].branch_prefix,pr_body_template`（複数行 `"""..."""`、`{identifier}` `{title}` `{issue_url}` プレースホルダ）/ `[looppilot].gate_label,state_comment_authors` / `[safety].max_tasks_per_run,max_cost_usd_per_session`（+ `monitor_timeout_minutes` コメント）`,not_engaged_guard_minutes` / `[loop].monitor_poll_seconds,idle_recheck_seconds` / `[digest].recent_merged_count` / `[notify]`（Slack は env のコメントのみ）。

差分が一切なければ次ステップへ。**差分があった場合は example.toml を書き換えず、その差分内容を openQuestions に記録して報告する**（カーネル/設定の不整合は勝手に直さない）。

- [ ] **Step 2: 現在の `README.md`（Task 1 骨子）を読み、置換対象を把握する**

Task 1 が書いた骨子の全文を確認する。本タスクは「`## セットアップ（骨子。詳細は Task 17 で完成）`」以降を中心に完成形へ差し替えるため、現行テキストを正確に把握しておく。

```bash
cat /home/racoma-dev/loop-pilot-os/README.md
```

期待: Task 1 の骨子（タイトル + 概要1段落 + `## 必要環境` + `## セットアップ（骨子。詳細は Task 17 で完成）` + `## 開発` + 末尾の「> このセクションは骨子です…Task 17 で記述します。」引用）が表示される。以降のステップで Write により**ファイル全体を完成形へ置換**する。

- [ ] **Step 3: `README.md` を完成形に書き換える（Write でファイル全体を置換）**

`/home/racoma-dev/loop-pilot-os/README.md` を以下の完全な内容で**全置換**する。アーキテクチャ図は仕様 §4 の ASCII を流用、`failure_reason` 表はカーネル §2 の10種・意味（仕様 §7/§5 と整合）、回復の挙動はカーネル §8 / 仕様 §9、手動 E2E チェックリストは仕様 §12 の完了定義どおり。値・キー名はすべてカーネル §3 / §0 の確定値に一致させる。

````markdown
# LoopPilot OS

LoopPilot OS は、AIコーディングエージェント（Claude Code ヘッドレス）によるプロダクト開発ループを、人間の都度指示なしで回す**ローカル CLI 常駐オーケストレーター**です。Linear の適格チケットを選定し、git worktree でエージェントを起動して実装・PR 作成まで行い、既存の [LoopPilot](https://github.com/team-yubune/loop-pilot)（PR 上で codex レビュー → Claude 修正 → チェックを回す GitHub Actions システム）へ `loop-pilot` ラベルで受け渡します。LoopPilot がクリーン到達（PR 上の `looppilot-state` 隠しコメントが `done`）したことを検知すると、**オーケが**（LoopPilot ではなく）squash マージし、Linear チケットを Done にして次タスクへ進みます。キュー空 or タスク上限で**通知して綺麗に停止**します。

状態はすべて SQLite（`looppilot-os.db`）に永続化され、再起動時は「`in_review` + オープン PR」を照合して継続できます。1タスク = 1セッション = 1PR、逐次実行（並列なし）。失敗（CI 赤・コンフリクト・LoopPilot 停止・監視未起動など）は**人間に上げてループ全体を停止**します。

> **v1 スコープ**: 既存チケット駆動のコアループのみ。QA/バグ自動発見・チケット自動生成・タスク内セッション再開・横断メモリ・並列・複数リポ・Linear 以外のタスク源は v2 送りです。

## アーキテクチャ

疎結合・単一責任のモジュール群を Orchestrator Core が統括し、外部はインターフェース越しに呼びます（仕様 §4）。

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

per-task ライフサイクル（状態機械、仕様 §5）:

```
SELECT ─→ CLAIM ─→ IMPLEMENT ─→ HANDOFF ─→ MONITOR ─→ DONE ─→ (次の SELECT)
  │         │          │           │          │
  │         │          │           │          └─ stopped/closed/CI赤/未起動 → STOPPED → HALT
  │         │          │           └─ push/ラベル/遷移 失敗 → STOPPED → HALT
  │         │          └─ 無変更/コスト超/例外 → STOPPED → HALT
  │         └─ worktree/遷移 失敗 → STOPPED → HALT
  └─ 適格なし → IDLE（通知 + 定期再確認） ／ タスク上限到達 → HALT（通知）
```

- **SELECT**: 指定 Team/PJ ∧ Todo ∧ オプトインラベルを決定的順序（意味的優先度 Urgent>High>Medium>Low>No → sortOrder 昇順 → issue id）で選ぶ。進行中セッションを持つチケットは除外。
- **CLAIM**: デフォルトブランチから `<prefix>/<identifier小文字>-<slug>` ブランチ + worktree を切り、Linear を In Progress に。
- **IMPLEMENT**: worktree 内で `claude -p` をコスト上限付き起動。**実差分**（`origin/<defaultBranch>..HEAD`）で後条件を判定（自己申告は信用しない）。
- **HANDOFF**: push → PR 作成（ready-for-review・**draft 不可**）→ PR 番号を即永続化 → `loop-pilot` ラベル付与 → Linear を In Review に。
- **MONITOR**: `looppilot-state` 隠しコメント + PR の merged を一定間隔でポーリング。監視中は PR/ブランチに書き込まない（マージを除く）。
- **DONE**: `merged` を先に永続化 → Linear を Done に（best-effort・既 Done 許容）→ 次の SELECT へ。

## 必要環境

- Node.js >= 24
- `git`
- `gh`（GitHub CLI、**認証済み** = `gh auth status` が通る。対象リポへの push 権限が必要）
- `claude`（Claude Code CLI、**認証済み** = `claude --version` が通る）
- 対象リポに [LoopPilot](https://github.com/team-yubune/loop-pilot) が導入済み（Init/Loop ワークフローが `loop-pilot` ラベルで発火する状態）

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
| `linear.team` | Linear の team key（例 `TY`） |
| `linear.project` | Project 名（プリフライトで ID 解決・検証） |
| `linear.opt_in_label` | AI 着手を許可するオプトインラベル名 |
| `linear.states.{todo,in_progress,in_review,done}` | 状態名 → プリフライトで stateId に解決 |
| `agent.model` | `claude --model` に渡すモデル（例 `opus`） |
| `agent.allowed_tools` | `claude --allowedTools`（例 `Edit,Write,Read,Glob,Grep,Bash`） |
| `agent.extra_args` | 任意の追加 claude フラグ（既定なし） |
| `handoff.branch_prefix` | ブランチ接頭辞（例 `looppilot`） |
| `handoff.pr_body_template` | PR 本文テンプレ。`{identifier}` `{title}` `{issue_url}` を置換 |
| `looppilot.gate_label` | 対象リポの `LOOPPILOT_LABEL` に一致させる（既定 `loop-pilot`・大小無視） |
| `looppilot.state_comment_authors` | LoopPilot の信頼著者（既定 `["github-actions[bot]"]`） |
| `safety.max_tasks_per_run` | 1 ラン中の着手上限（到達で HALT） |
| `safety.max_cost_usd_per_session` | 1 セッションのコスト上限（`claude --max-budget-usd`） |
| `safety.monitor_timeout_minutes` | 全体監視のタイムアウト（任意・既定オフ／コメントアウト） |
| `safety.not_engaged_guard_minutes` | LoopPilot 未起動ガード（常時オン） |
| `loop.monitor_poll_seconds` | MONITOR のポーリング間隔 |
| `loop.idle_recheck_seconds` | IDLE 時のキュー再確認間隔 |
| `digest.recent_merged_count` | プロンプトに含める直近マージ済みセッション要約の件数 |

状態 DB（`looppilot-os.db`）は `looppilot-os.toml` と同じディレクトリに作られます。

### 3. シークレットを環境変数で渡す

API キー・Webhook は**ファイルに書かず**環境変数で渡します。

```bash
export LINEAR_API_KEY="lin_api_..."      # 必須
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."  # 任意
```

`SLACK_WEBHOOK_URL` 未設定時は**コンソール通知のみ**（コンソールは常時オン）。設定時はプリフライトで Webhook へ直接 POST して到達性を検証します（非 2xx ならプリフライト失敗）。

### 4. プリフライト（起動時に自動実行）

`run` は実ループに入る前に以下を fail-fast で検証し、違反は**全件まとめて**報告して停止します（仕様 §8 / カーネル §9）:

1. `repo.path` がクリーンな git（`git status --porcelain` 空）で `default_branch` 上にある
2. remote 到達可（`git ls-remote origin HEAD`）
3. `gh auth status` 成功 ∧ リポへの push 権限あり ∧ **デフォルトブランチを単独マージ可能**（必須レビュー > 0 やマージ制限があると NG — ループに人間レビュアーが不在のため）
4. `gate_label`（`loop-pilot`）が対象リポのラベルに存在（大小無視）
5. Actions 変数 `LOOPPILOT_AUTO_MERGE` が未設定 or `false`（**オーケが唯一のマージャー**）
6. Linear: API キーで viewer 取得 ∧ team・project・4 状態・opt_in_label が解決できる
7. `claude --version` 成功
8. state-comment 著者の整合: リポの `LOOPPILOT_STATE_COMMENT_AUTHORS`（未設定なら既定 `github-actions[bot]`）が `looppilot.state_comment_authors` に包含される（不整合だと Monitor が信頼コメントを発見できず `monitor_never_engaged` で全停止するため）
9. Slack 設定時は Webhook へ直接 POST して到達性確認

### 5. 起動と観測

```bash
# ループ起動（既定の config は ./looppilot-os.toml）
looppilot-os run --config ./looppilot-os.toml

# 状態確認（別ターミナルから／停止後でも可）
looppilot-os status --config ./looppilot-os.toml
```

- `--config <path>` 省略時の既定は `./looppilot-os.toml`。
- **単一インスタンス前提**: `run` はランロック（PID）を取得します。既に生きたインスタンスがある場合は二重起動しません。
- 停止は `Ctrl-C`（SIGINT）。**次の安全点で**現フェーズを完了してから Run を `halted`（理由 `user_interrupt`）にしてロックを解放し終了します（フェーズ途中で中断しません）。

## `run` の使い方

`run` は以下を繰り返します（仕様 §5・カーネル §7）:

1. **回復処理**（起動直後・後述）
2. タスク上限チェック（`tasks_started >= max_tasks_per_run` → 通知して HALT）
3. **SELECT** → 適格チケットを 1 件取得。なければ **IDLE**（キュー空通知 + `idle_recheck_seconds` ごとに再確認、復帰すれば再開）
4. **CLAIM → IMPLEMENT → HANDOFF → MONITOR → DONE** を逐次実行
5. いずれかのセッションが STOPPED したら **HALT**（理由付きで通知してループ終了）

実行中はコンソールに進捗（claude の stream-json を短縮表示）と各フェーズのログが出ます。

## `status` の使い方

`status` は SQLite を真実の源として、Run + TaskSession から現在の状態を表示します（仕様 §10 / §12）。専用イベントログは持たず、すべて Run/TaskSession から導出します。表示内容:

- **現在の Run**: 状態（`running` / `idle` / `halted`）、開始時刻、タスク上限、`tasks_started`、マージ済み件数（`merged` セッションの実数から導出）、HALT 理由。
- **進行中セッション**: 現在のチケット（identifier / タイトル）、フェーズ（`claimed` / `implementing` / `handing_off` / `in_review`）、ブランチ、PR 番号、コスト。
- **履歴**: 直近の終了済みセッション（`merged` / `stopped` と `failure_reason`・`stop_detail`）。
- **停止箇所**: HALT 時はどのセッションがどの `failure_reason` で止まったか。
- **未配信通知**: Slack 配信に失敗して保留中の通知意図（`notification_intent`）があれば可視化。

## 失敗時の見方（`failure_reason` 一覧）

セッションが STOPPED するとループは HALT します（逐次のため TaskSession=stopped ⇒ Run=halted の 1:1）。`status` の `failure_reason` で原因が分かります。10 種すべて（カーネル §2 / 仕様 §7）:

| failure_reason | 意味（どのフェーズで・何が起きたか） | 主な人間の対処 |
| -- | -- | -- |
| `agent_no_change` | IMPLEMENT 後、実差分（`origin/<defaultBranch>..HEAD`）が無い／空コミット／未コミットの残骸（`stop_detail="uncommitted leftovers"` で区別）。自動コミットはしない | チケットの粒度・プロンプト・ゴールを見直す。残骸があれば worktree を手動掃除 |
| `cost_exceeded` | IMPLEMENT 中に `max_cost_usd_per_session` 到達。部分作業は破棄しブランチ削除済み | コスト上限を上げる／タスクを分割する |
| `exception` | 予期せぬ例外（`stop_detail` に message）。MONITOR のポーリングが 5 連続失敗、または監視タイムアウト（`monitor timeout`）、回復で対応 PR が見つからない（`crash recovery: ...`）等もここ | `stop_detail` を読んで原因に対処 |
| `monitor_never_engaged` | MONITOR で `not_engaged_guard_minutes` を超えても信頼 state コメントが出ない／コメントはあるが破損（`corrupted` は即時、`stop_detail="...comment present but corrupted"`） | LoopPilot が当該 PR で発火しているか（ラベル・ワークフロー・著者 identity）を確認 |
| `looppilot_stopped` | LoopPilot 自身が `stopped` 状態に到達。`stop_detail` に LoopPilot の `stopReason`（無い場合 `looppilot stopped (no reason)`） | LoopPilot 側のログ・stopReason を確認して PR を手当て |
| `ci_failed` | MONITOR で CI 必須チェックが失敗、またはブランチ保護/ルールセットでマージがブロック（`stop_detail="merge blocked by branch protection..."`）、ready 判定下で `mergePr` が 2 連続失敗（fail-closed） | CI を直す／ブランチ保護の必須レビューを外す／手動マージ |
| `merge_conflict` | MONITOR で PR がデフォルトブランチと衝突（`CONFLICTING` / `DIRTY`） | PR を rebase/解決する |
| `pr_closed` | PR がマージされずにクローズされた | 意図的なら無視、再開したいなら新チケットへ |
| `claim_failed` | CLAIM 失敗（worktree 作成 or Linear 遷移）。可能なら worktree 破棄・チケットを Todo へ復帰 | リポのクリーン状態・ブランチ衝突・Linear 権限を確認 |
| `handoff_failed` | HANDOFF 失敗（push / PR 作成 / ラベル / In Review 遷移）。`stop_detail` に作成済み PR 番号を明記 | 明記された PR を手当てし、必要なら手動でラベル/遷移 |

`stop_detail` 列に追加文脈（LoopPilot の stopReason、例外メッセージ、ブロック理由、回復時の手動掃除対象など）が入ります。

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
- [ ] **失敗系の確認**（任意）: わざと壊れたチケット（差分を生まない指示など）を 1 件投入すると、対応する `failure_reason`（例 `agent_no_change`）で 1 セッションが `stopped`、Run が `halted`、`halted` 通知が出てループが停止する。`status` に停止箇所と理由が表示される。
- [ ] **再起動回復の確認**（任意）: `in_review`（オープン PR あり）のセッションがある状態で `run` を再起動すると、その PR の MONITOR が継続（`monitor_started_at` は維持）され、マージ済みなら DONE 後段から再開してカウンタが二重計上されない。

これらが満たされれば、仕様 §12「一度起動したら人間の追加指示なしで、各チケットを 選定→ブランチ→Claude実装→PR→`loop-pilot` 受け渡し→LoopPilot がクリーン到達→**オーケがマージ**→ticket Done→次、と逐次処理し、キュー空 or タスク上限で**通知して綺麗に停止**する」を満たします。

## 開発

```bash
npm run check        # 型チェック（src + tests）+ vitest を一括
npm test             # vitest のみ
npm run typecheck    # src の型チェックのみ
```

CI（`.github/workflows/ci.yml`）は push(main)/PR で `npm ci && npm run check` を回します。

## 設計ドキュメント

- 設計仕様書（source of truth）: `docs/specs/design-spec-v1-core-loop.md`
- 実装計画（共有カーネル + 各タスク章）: `docs/superpowers/plans/`
````

期待: Write が成功し `README.md` が完成形に置換される。

- [ ] **Step 4: README が完成形に置換されたことを確認する**

骨子の名残（`（骨子。詳細は Task 17 で完成）` や末尾の「> このセクションは骨子です」）が消え、完成形の見出しが揃っていることを確認する。

```bash
grep -nE '^## ' /home/racoma-dev/loop-pilot-os/README.md && echo "---骨子の名残チェック（ヒット0が期待）---" && grep -nE '骨子。詳細は Task 17|このセクションは骨子です' /home/racoma-dev/loop-pilot-os/README.md || true
```

期待: 見出しに `## アーキテクチャ` `## 必要環境` `## セットアップ` `## \`run\` の使い方` `## \`status\` の使い方` `## 失敗時の見方（failure_reason 一覧）` `## 回復の挙動（再起動時）` `## 動作確認（手動 E2E チェックリスト）` `## 開発` `## 設計ドキュメント` が並ぶ。骨子の名残チェックは**ヒット 0**（何も表示されない）。

- [ ] **Step 5: `failure_reason` 10 種が README に過不足なく載っていることを確認する**

カーネル §2 の `FailureReason` 10 種が一覧表にすべて含まれることを機械的に確認する。

```bash
for r in agent_no_change cost_exceeded exception monitor_never_engaged looppilot_stopped ci_failed merge_conflict pr_closed claim_failed handoff_failed; do
  grep -q "\`$r\`" /home/racoma-dev/loop-pilot-os/README.md && echo "OK  $r" || echo "MISSING $r";
done
```

期待: 10 行すべて `OK  <reason>`。1 つでも `MISSING` が出たら、その reason を一覧表に追記して再確認する（カーネル §2 と過不足ゼロが必須）。

- [ ] **Step 6: `npm run check` がグリーンのままであることを確認する（ドキュメント変更の無影響確認）**

README はドキュメントのみだが、コミット前に既存のビルド/テストが壊れていないことを確認する。

```bash
npm run check --prefix /home/racoma-dev/loop-pilot-os
```

期待: `tsc --noEmit`（src）/ `tsc --noEmit -p tsconfig.test.json`（tests）/ vitest がすべてグリーン（exit 0）。README の変更はコードに影響しないため、Task 16 完了時点の結果と同一であること。失敗する場合は本タスクのスコープ外の不具合なので、README には手を入れず原因タスクへ差し戻す（README 変更で型/テストが壊れることはあり得ない）。

- [ ] **Step 7: README を `git add` してコミットする**

完成した README をコミットする（example.toml は Task 1 で既にコミット済みのため本タスクではステージしない。Step 1 で差分が無いことを確認済み）。

```bash
git -C /home/racoma-dev/loop-pilot-os add README.md && \
git -C /home/racoma-dev/loop-pilot-os commit -m "chore: complete README (setup, run/status, failure_reason table, recovery, manual E2E checklist)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

期待: `[main <sha>] chore: complete README ...` が出て exit 0、`1 file changed`（README.md のみ）。検証: `git -C /home/racoma-dev/loop-pilot-os log --oneline -1` が当該コミットを返し、`git -C /home/racoma-dev/loop-pilot-os status --short` が clean（ステージ残なし）。これで Task 17 完了 = v1 実装計画の全章完了。