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
