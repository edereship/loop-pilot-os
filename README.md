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
| `agent.model` | `claude --model` に渡すモデル（出荷既定 `claude-opus-4-6[1m]`） |
| `agent.effort` | `claude --effort` に渡す思考レベル（`low\|medium\|high\|xhigh\|max`・既定 `max`） |
| `agent.allowed_tools` | `claude --allowedTools`（例 `Edit,Write,Read,Glob,Grep,Bash`） |
| `agent.permission_mode` | `claude --permission-mode` に渡す権限モード（既定 `acceptEdits`）。隔離コンテナでは `bypassPermissions` を選択（下記セキュリティモデル参照） |
| `agent.extra_args` | 任意の追加 claude フラグ（既定なし） |
| `handoff.branch_prefix` | ブランチ接頭辞（例 `looppilot`） |
| `handoff.pr_body_template` | PR 本文テンプレ。`{identifier}` `{title}` `{issue_url}` を置換 |
| `looppilot.gate_label` | 対象リポの `LOOPPILOT_LABEL` に一致させる（既定 `loop-pilot`・大小無視） |
| `looppilot.state_comment_authors` | LoopPilot の信頼著者（既定 `["github-actions[bot]"]`） |
| `safety.max_tasks_per_run` | 1 ラン中の着手上限（到達で HALT） |
| `safety.max_cost_usd_per_session` | 1 セッションのコスト上限（`claude --max-budget-usd`） |
| `safety.monitor_timeout_minutes` | 全体監視のタイムアウト（任意・既定オフ／コメントアウト） |
| `safety.not_engaged_guard_minutes` | LoopPilot 未起動ガード（常時オン） |
| `safety.session_hard_timeout_minutes` | hung（無進捗・無支出）claude を切る hard backstop（任意・既定120分。コスト一本化を維持しつつ無人ループの永久ハングを防ぐ） |
| `loop.monitor_poll_seconds` | MONITOR のポーリング間隔 |
| `loop.idle_recheck_seconds` | IDLE 時のキュー再確認間隔 |
| `digest.recent_merged_count` | プロンプトに含める直近マージ済みセッション要約の件数 |
| `notify.progress` | `true` で各チケットの着手/完了を Slack にも通知（既定 `false`・コンソールログは常時出力） |

#### model × effort 対応表

| model | 使える effort |
| -- | -- |
| Opus 4.8 / 4.7 | low / medium / high / xhigh / max |
| **Opus 4.6**（出荷既定 `claude-opus-4-6[1m]`） | low / medium / high / **max**（xhigh 非対応） |
| Sonnet 4.6 | low / medium / high / max（xhigh 非対応） |
| Haiku 4.5 / Sonnet 4.5 | **effort 非対応**（どの値もエラー） |

* `xhigh` は Opus 4.7+/Fable 5 専用。`max` は Opus 4.6 以降・Sonnet 4.6 で可。
* 不正な model×effort 組合せは起動前の設定検証（`loadConfig`）で fatal エラーとして報告される（セッションは開始しない）。

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
- 停止は `Ctrl-C`（SIGINT）。常駐運用向けに **SIGTERM / SIGHUP**（systemd・コンテナ停止・端末切断）も同様に捕捉します。**次の安全点で** Run を `halted`（理由 `user_interrupt`）にしてロックを解放し終了します。安全点は各タスク境界に加え **MONITOR の poll 境界**（数時間に及ぶ監視待機中でも停止可能。セッションは `in_review` のまま残り再起動で回復）。**2 回目**の停止シグナルは即時強制終了（exit 130）。

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

> **注意**: `status` も `LINEAR_API_KEY` の export が必要です（設定読込が env シークレットを検証するため）。

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
| `handoff_failed` | HANDOFF 失敗（push / PR 作成 / ラベル / In Review 遷移）。`stop_detail` に PR 作成済みなら番号を、未作成なら `no PR created` を明記 | PR があれば手当てし（必要なら手動でラベル/遷移）、無ければブランチを確認して再実行か破棄 |

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

- 設計仕様書（source of truth）: `docs/specs/design-spec-v1-core-loop.md`
- 実装計画（共有カーネル + 各タスク章）: `docs/superpowers/plans/`
