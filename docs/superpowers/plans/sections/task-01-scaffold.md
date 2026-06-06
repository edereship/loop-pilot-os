### Task 1: リポ雛形 + CI + GitHub私有リポ

**目的**: LoopPilot OS v1 のリポジトリ雛形を作る。`package.json`（ESM・bin・LoopPilot同形 scripts・pin済み依存）、`tsconfig`×2（strict / NodeNext）、`vitest.config.ts`、`.gitignore`、CI 1本（`npm run check`）、`looppilot-os.example.toml`（カーネル§3完全転記）、README 骨子、空打ち回避の smoke テストを置き、`npm install` → `npm run check` グリーンを確認、git init → 初回コミット → `gh repo create` で私有リポ `loop-pilot-os` を作成・push する。

**依存タスク**: なし（最初のタスク）。本タスクは雛形のため TDD 例外（テスト先行なし）。ただし全ステップに検証コマンドと期待出力を付ける。

**カーネル参照**: §0（確定済み実装決定）、§1（ファイル構成）、§3（Config TOML 全文）。

**実検証済みの実物（2026-06-05）**:
- Node `v24.15.0` / gh `2.92.0` / claude `2.1.165`（いずれも認証済み）。
- 依存バージョン（`npm view <pkg> version` 当日実測。`^x.y.z` で pin）:
  - 実行時: `better-sqlite3@12.10.0`, `smol-toml@1.6.1`, `zod@4.4.3`
  - 開発: `typescript@6.0.3`, `vitest@4.1.8`, `tsx@4.22.4`, `@types/node@25.9.2`, `@types/better-sqlite3@7.6.13`
- LoopPilot 本体の慣習（踏襲元）: `tsconfig.json`（strict / outDir dist / rootDir src / `include:["src/**/*.ts"]`）、`tsconfig.test.json`（`extends:"./tsconfig.json"` / rootDir "." / noEmit / `include:["src/**/*.ts","tests/**/*.ts"]`）、`vitest.config.ts`（`include:["tests/**/*.test.ts"]`、`globals` オフ）、`ci.yml`（`actions/checkout@v5` + `actions/setup-node@v5` node 24 cache npm）、scripts `build/test/typecheck/typecheck:test/check`。
- 相違点メモ: LoopPilot は `module/moduleResolution: "Node16"` を使うが、カーネル§0 は明示的に **NodeNext** を要求するため本タスクでは `NodeNext` を採用する（NodeNext は Node16 の上位互換で `.js` 拡張子付き ESM 相対 import の挙動は同一）。

**作業ディレクトリ**: `/home/racoma-dev/loop-pilot-os`（`docs/` のみ存在。git 未初期化）。以降コマンドはすべて `git -C <abs>` 等の絶対パス指定で行い、`cd` を避ける。

#### Files

- Create: `/home/racoma-dev/loop-pilot-os/package.json`
- Create: `/home/racoma-dev/loop-pilot-os/tsconfig.json`
- Create: `/home/racoma-dev/loop-pilot-os/tsconfig.test.json`
- Create: `/home/racoma-dev/loop-pilot-os/vitest.config.ts`
- Create: `/home/racoma-dev/loop-pilot-os/.gitignore`
- Create: `/home/racoma-dev/loop-pilot-os/.github/workflows/ci.yml`
- Create: `/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml`
- Create: `/home/racoma-dev/loop-pilot-os/README.md`
- Create: `/home/racoma-dev/loop-pilot-os/src/main.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts`

---

- [ ] **Step 1: `package.json` を作成する**

`/home/racoma-dev/loop-pilot-os/package.json` を以下の完全な内容で作成する。`type:module`、bin `looppilot-os`→`dist/main.js`、scripts は LoopPilot 同形（`build`/`test`/`typecheck`/`typecheck:test`/`check`）。依存は当日実測値を `^` で pin。

```json
{
  "name": "loop-pilot-os",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "looppilot-os": "./dist/main.js"
  },
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "check": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json && vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "smol-toml": "^1.6.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^25.9.2",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: `tsconfig.json` を作成する**

`/home/racoma-dev/loop-pilot-os/tsconfig.json` を以下の完全な内容で作成する。strict、NodeNext（カーネル§0）、`outDir dist` / `rootDir src` / `include:["src/**/*.ts"]`。LoopPilot の慣習（`esModuleInterop`/`skipLibCheck`/`declaration`/`sourceMap` 等）を踏襲する。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: `tsconfig.test.json` を作成する**

`/home/racoma-dev/loop-pilot-os/tsconfig.test.json` を以下の完全な内容で作成する。LoopPilot 同形：base を extends し rootDir を `.` に広げ、`src` と `tests` を typecheck 対象にする（出力は出さない）。

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: `vitest.config.ts` を作成する**

`/home/racoma-dev/loop-pilot-os/vitest.config.ts` を以下の完全な内容で作成する。LoopPilot 同形：`globals` はオフ（各テストが `vitest` から明示 import する）、対象は `tests/**/*.test.ts`。

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストファイルは describe/it/expect/vi を "vitest" から明示 import するため
    // globals は付けない（グローバル名前空間の汚染回避。LoopPilot 同形）。
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: `.gitignore` を作成する**

`/home/racoma-dev/loop-pilot-os/.gitignore` を以下の完全な内容で作成する。カーネル§1 の指定どおり `node_modules` / `dist` / `*.db` / 実設定 `looppilot-os.toml` を除外する（`looppilot-os.example.toml` はコミットするので除外しない）。WAL 副生成物（`*.db-wal` / `*.db-shm`）も併せて無視する。

```gitignore
node_modules/
dist/

# SQLite 状態ストア（実 DB はコミットしない。WAL 副生成物含む）
*.db
*.db-wal
*.db-shm

# 実設定はコミットしない（example のみコミット）
looppilot-os.toml
```

- [ ] **Step 6: `.github/workflows/ci.yml` を作成する**

`/home/racoma-dev/loop-pilot-os/.github/workflows/ci.yml` を以下の完全な内容で作成する。push(main)/PR で発火し `npm ci && npm run check` を回す。actions のバージョンは LoopPilot の `ci.yml` に揃える（`actions/checkout@v5`、`actions/setup-node@v5`、node 24、`cache: npm`）。LoopPilot 固有の bundle/dist-drift ステップは LoopPilot OS には不要なので持たない。

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Check (typecheck src + tests + vitest)
        run: npm run check
```

- [ ] **Step 7: `looppilot-os.example.toml` を作成する**

`/home/racoma-dev/loop-pilot-os/looppilot-os.example.toml` を以下の完全な内容で作成する。**カーネル§3 を一字一句完全転記**する（全キー・既定値・コメントを保持）。

```toml
[product]
goal = "プロダクトのゴールと制約。毎セッションのプロンプト冒頭に入る"

[repo]
path = "/abs/path/to/target-repo"
remote = "owner/name"
default_branch = "main"
# worktree_root 省略時: ~/.looppilot-os/worktrees/<repoのdir名>

[linear]
# APIキーは環境変数 LINEAR_API_KEY（ファイルに書かない）
team = "TY"                     # team key
project = "LoopPilot OS"        # project 名（プリフライトで ID 解決・検証）
opt_in_label = "ai-ok"          # オプトインラベル名
[linear.states]                 # 状態名 → プリフライトで ID 解決
todo = "Todo"
in_progress = "In Progress"
in_review = "In Review"
done = "Done"

[agent]
model = "opus"                  # claude --model に渡す
allowed_tools = "Edit,Write,Read,Glob,Grep,Bash"   # --allowedTools
# extra_args = []               # 任意の追加 claude フラグ（既定なし）

[handoff]
branch_prefix = "looppilot"
pr_body_template = """
Implements {identifier}: {title}

{issue_url}

🤖 Generated by LoopPilot OS
"""

[looppilot]
gate_label = "loop-pilot"                       # 対象リポの LOOPPILOT_LABEL に一致させる
state_comment_authors = ["github-actions[bot]"] # 信頼著者

[safety]
max_tasks_per_run = 3
max_cost_usd_per_session = 10.0
# monitor_timeout_minutes = 120  # 任意。既定オフ（コメントアウト）
not_engaged_guard_minutes = 30   # 常時オン

[loop]
monitor_poll_seconds = 60
idle_recheck_seconds = 300

[digest]
recent_merged_count = 5

[notify]
# Slack Webhook は環境変数 SLACK_WEBHOOK_URL（未設定ならコンソールのみ）
```

- [ ] **Step 8: `README.md` 骨子を作成する**

`/home/racoma-dev/loop-pilot-os/README.md` を以下の完全な内容で作成する。プロジェクト1段落 + セットアップ手順の骨子。完成は Task 17（その旨を明記）。

```markdown
# LoopPilot OS

LoopPilot OS は、AIコーディングエージェント（Claude Code ヘッドレス）によるプロダクト開発ループを人間の都度指示なしで回すローカル CLI 常駐オーケストレーターです。Linear の適格チケットを選定し、worktree でエージェントを起動して実装・PR 作成まで行い、既存の [LoopPilot](https://github.com/) へ `loop-pilot` ラベルで受け渡し、クリーン到達（`looppilot-state` 隠しコメント）を検知して**オーケが**マージし、Linear チケットを Done にして次タスクへ進みます。キュー空 or タスク上限で通知して綺麗に停止します。状態はすべて SQLite に永続化され、再起動で「in_review + オープン PR」を照合して継続できます。

## 必要環境

- Node.js >= 24
- `git`
- `gh`（GitHub CLI、認証済み）
- `claude`（Claude Code CLI、認証済み）

## セットアップ（骨子。詳細は Task 17 で完成）

1. 依存をインストール: `npm install`
2. ビルド: `npm run build`
3. 設定ファイルを用意: `cp looppilot-os.example.toml looppilot-os.toml` し、各値を対象リポ/Linear に合わせて編集する。
4. シークレットを環境変数で渡す: `LINEAR_API_KEY`（必須）, `SLACK_WEBHOOK_URL`（任意・未設定ならコンソール通知のみ）。
5. 起動: `looppilot-os run --config ./looppilot-os.toml`
6. 状態確認: `looppilot-os status --config ./looppilot-os.toml`

## 開発

- 型チェック + テスト一括: `npm run check`
- テストのみ: `npm test`

> このセクションは骨子です。設定キーの詳細・プリフライト・手動 E2E 手順は Task 17 で記述します。
```

- [ ] **Step 9: `tests/smoke.test.ts` を作成する（空打ち回避）**

`/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts` を以下の完全な内容で作成する。Task 2 以降で実テストが入るまで vitest が「テスト 0 件」でエラーにならないようにするための一時ファイル。**Task 2 で削除する**旨をコメントに明記する。

```typescript
import { describe, it, expect } from "vitest";

// 雛形タスク用のプレースホルダ。Task 2（共有型 + 最初の実テスト）で削除する。
// vitest は対象テストが 0 件だと失敗するため、それを回避する空打ちだけを行う。
describe("smoke", () => {
  it("vitest が動作する", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 10: `src/main.ts` プレースホルダを作成する（tsc(src) の入力 0 件回避）**

`/home/racoma-dev/loop-pilot-os/src/main.ts` を以下の完全な内容で作成する。`tsconfig.json` の `include:["src/**/*.ts"]` が入力 0 件だと `tsc --noEmit` が `error TS18003: No inputs were found in config file` を出して exit 2 になり、`check`（`tsc --noEmit && ...`）が先頭で止まる（Step 12 の `npm run check` / Step 17 で検証する CI とも失敗）。これを回避するため `src/` 配下に最低 1 ファイルを置く。実 CLI エントリは Task 16 で本実装するため、ここでは ESM の空モジュールスタブにとどめる。

```typescript
// LoopPilot OS CLI エントリのプレースホルダ。
// tsconfig.json の include:["src/**/*.ts"] を入力 0 件にしないための雛形。
// 実装（run/status 分岐・config 読込・DI 組立）は Task 16 で本実装する。
export {};
```

検証: `ls /home/racoma-dev/loop-pilot-os/src/main.ts` がパスを返す。

- [ ] **Step 11: 依存をインストールする**

`/home/racoma-dev/loop-pilot-os` で依存をインストールする。

```bash
npm install --prefix /home/racoma-dev/loop-pilot-os
```

期待: `better-sqlite3`（ネイティブビルドあり）含め全依存が解決され、`added N packages` が出てエラーなく終了（exit 0）。`/home/racoma-dev/loop-pilot-os/node_modules` と `package-lock.json` が生成される。検証: `ls /home/racoma-dev/loop-pilot-os/package-lock.json` がパスを返す。

- [ ] **Step 12: `npm run check` グリーンを確認する**

型チェック（src + tests）と vitest を一括実行する。

```bash
npm run check --prefix /home/racoma-dev/loop-pilot-os
```

期待: `tsc --noEmit`（src。Step 10 の `src/main.ts` が入力 1 件として解決されるため TS18003 は出ない）と `tsc --noEmit -p tsconfig.test.json`（tests）がともにエラー 0 で通過し、vitest が smoke テスト 1 件を実行して成功する。出力末尾に概ね `Test Files  1 passed (1)` と `Tests  1 passed (1)` が表示され exit 0。失敗（型エラー or テスト失敗）なら該当ファイルを修正して再実行する。

- [ ] **Step 13: git リポジトリを初期化しデフォルトブランチを main にする**

`/home/racoma-dev/loop-pilot-os` を git リポジトリとして初期化する。

```bash
git -C /home/racoma-dev/loop-pilot-os init -b main
```

期待: `Initialized empty Git repository in /home/racoma-dev/loop-pilot-os/.git/` が出て exit 0。検証: `git -C /home/racoma-dev/loop-pilot-os rev-parse --abbrev-ref HEAD` が `main` を返す。

- [ ] **Step 14: 追跡対象を確認する（node_modules/dist が無視されること）**

`.gitignore` が効いて `node_modules` 等が追跡対象外であることを確認する。

```bash
git -C /home/racoma-dev/loop-pilot-os add -A && git -C /home/racoma-dev/loop-pilot-os status --short
```

期待: `??`/`A` 行に `node_modules/`・`dist/`・`*.db`・`looppilot-os.toml`・`package-lock.json` 以外…の確認。具体的には `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`, `looppilot-os.example.toml`, `README.md`, `src/main.ts`, `tests/smoke.test.ts`, `package-lock.json`, `docs/...` がステージされ、**`node_modules/` と `dist/` は出てこない**こと。もし `node_modules/` が現れたら `.gitignore` を見直す。

- [ ] **Step 15: 初回コミットを作成する**

雛形一式をコミットする。

```bash
git -C /home/racoma-dev/loop-pilot-os commit -m "chore: scaffold repo (package.json, tsconfig×2, vitest, ci, example config)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

期待: `[main (root-commit) <sha>] chore: scaffold repo ...` が出て exit 0。検証: `git -C /home/racoma-dev/loop-pilot-os log --oneline -1` が当該コミットを返す。

- [ ] **Step 16: GitHub 私有リポを作成して push する**

`gh` で私有リポ `loop-pilot-os` を作成し、`origin` を設定して push する。

```bash
gh repo create loop-pilot-os --private --source=/home/racoma-dev/loop-pilot-os --remote=origin --push
```

期待: `✓ Created repository <owner>/loop-pilot-os on GitHub`、`✓ Added remote ...`、`✓ Pushed commits to ...` が出て exit 0。前提として `gh auth status` が認証済み（実測: account `racoma-dev`）。

- [ ] **Step 17: リモート push と CI トリガを検証する**

リモートが設定され `main` が push 済みで、CI ワークフローが登録されていることを確認する。

```bash
git -C /home/racoma-dev/loop-pilot-os remote -v && git -C /home/racoma-dev/loop-pilot-os ls-remote --heads origin main && gh workflow list -R "$(gh repo view loop-pilot-os --json nameWithOwner -q .nameWithOwner)"
```

期待: `origin` が `*/loop-pilot-os` を指す（fetch/push の2行）、`ls-remote` が `main` の sha を1行返す、`gh workflow list` に `CI` が `active` で並ぶ。直近 run があれば `gh run list -R <owner>/loop-pilot-os -L 1` で確認できる（push 直後は queued/in_progress でよい）。これで Task 1 完了。
