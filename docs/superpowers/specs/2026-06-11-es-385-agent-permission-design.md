# ES-385: エージェント権限 config 化 + 資格情報分離・egress 制限

## 背景

無人完全自走では agent がツール呼出でブロックされないことが必要。デプロイ形態は使い捨て隔離コンテナ/VM 前提のため `--permission-mode bypassPermissions` を採用するが、filesystem 隔離だけでは資格情報・network 境界は守れない。

現状 `agent-runner.ts` は `--permission-mode acceptEdits` をハードコードしている。これを config で切替可能にし、`bypassPermissions` 選択時の補償（資格情報分離・egress 制限・非 root 実行）を整備する。

## スコープ

### 1. `agent.permission_mode` config 化

**変更ファイル**: `config.ts`, `agent-runner.ts`, `main.ts`, `types.ts` (Config interface のみ config.ts 内)

- `rawSchema.agent` に `permission_mode` を追加
  - 型: `z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])`
  - 既定: `"acceptEdits"`（dev 機/共有環境でも安全）
- `Config.agent` に `permissionMode: string` を追加
- `AgentRunnerOptions` に `permissionMode: string` を追加
- `agent-runner.ts` の argv 組立で `"acceptEdits"` 固定を `this.opts.permissionMode` に置換
- `main.ts` で `config.agent.permissionMode` を `ClaudeAgentRunner` に渡す

### 2. 資格情報分離（維持 + 文書化）

コード変更なし。既存の env スクラブ（`SENSITIVE_ENV_KEYS`）を維持。

README に以下を文書化:
- **不変条件**: agent は push/merge できない（env スクラブ + agent は commit のみ、push/PR/merge はオーケ側 GitPrManager）
- **残存リスク**: ambient `gh auth login`（`~/.config/gh/hosts.yml`）が agent から読める場合、env 除外だけでは防げない
- **運用緩和策**: agent を別ユーザ/別 HOME で実行、gh config を隠す、コンテナで gh 未インストール

### 3. Egress allowlist（文書化のみ）

コード変更なし。README に以下を文書化:
- **目的**: LLM エンドポイント + パッケージレジストリ + GitHub のみ許可し任意 exfil を遮断
- **選択肢**: Claude Code sandbox `network_allowlist` / コンテナ FW（iptables/nftables）
- **推奨**: 隔離コンテナでは FW が確実（Claude sandbox は Claude 自身のみ制限、Bash からの curl は制限外）

### 4. 非 root 実行 preflight

**変更ファイル**: `preflight.ts`

- `permission_mode === "bypassPermissions"` かつ `process.getuid?.() === 0` のとき preflight エラー
- `bypassPermissions` 以外では root チェックしない（通常の権限チェックが機能する）
- Windows/非 POSIX 環境では `getuid` が undefined → チェックスキップ（false negative は許容）

### 5. ドキュメント

- `looppilot-os.example.toml`: `[agent]` に `permission_mode` 追加（コメント付き）
- README: config テーブルに行追加 + セキュリティモデルセクション新設

## 受け入れ条件

- `agent.permission_mode` で権限モードを切替可能。既定 `acceptEdits`
- `bypassPermissions` 選択時、agent が full access でツールのサイレント拒否が起きない
- agent から push/merge・secret 読取ができないことを確認（資格情報分離・env スクラブ）
- 非 root preflight が `bypassPermissions` + root で発火する
- `npm run check` グリーン

## スコープ外

- Codex(PM) への同等適用（v2 scope doc S1.10）
- egress のコード実装（運用判断で文書化のみ）
- agent の Bash/network ツール制限の自動化
