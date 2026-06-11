# ES-385 実装プラン

## Step 1: config.ts — rawSchema + Config interface に permission_mode 追加

### テスト (config.test.ts)
- 既存 fixture (`config-valid.toml`) に `permission_mode = "acceptEdits"` 追加 → 既存テスト通過確認
- `config-minimal.toml` で permission_mode 省略時 → 既定 `"acceptEdits"` を検証
- 不正値 (`permission_mode = "invalid"`) の fixture → throw 検証
- `config-bypass.toml` で `permission_mode = "bypassPermissions"` → 正常に読める検証

### 実装
- `rawSchema.agent` に `permission_mode: z.enum([...]).default("acceptEdits")` 追加
- `Config.agent` に `permissionMode: string` 追加
- `loadConfig` の return 文で `permissionMode: raw.agent.permission_mode` を設定

## Step 2: agent-runner.ts — permissionMode を argv へ反映

### テスト (agent-runner.test.ts)
- 既存テスト `argv を一字一句で組み立て` を更新: `--permission-mode acceptEdits` が config 値由来であることを確認
- `permissionMode = "bypassPermissions"` で `--permission-mode bypassPermissions` が argv に含まれることを検証

### 実装
- `AgentRunnerOptions` に `permissionMode: string` 追加
- argv 組立の `"acceptEdits"` 固定を `this.opts.permissionMode` に置換

## Step 3: main.ts — config.agent.permissionMode を渡す

### 実装
- `ClaudeAgentRunner` コンストラクタに `permissionMode: config.agent.permissionMode` を追加

## Step 4: preflight.ts — 非 root チェック (bypassPermissions 時)

### テスト (preflight.test.ts)
- `checkNonRoot` 相当: bypassPermissions + uid 0 → エラー文字列を返す
- bypassPermissions + uid 非 0 → エラーなし
- acceptEdits + uid 0 → エラーなし（bypassPermissions 以外はチェックしない）

### 実装
- `runPreflight` に `checkNonRoot(config, errors)` を追加
- `config.agent.permissionMode === "bypassPermissions"` かつ `process.getuid?.() === 0` のときエラー

## Step 5: ドキュメント更新

- `looppilot-os.example.toml`: `[agent]` セクションに `permission_mode` 追加
- `README.md`: config テーブル + セキュリティモデルセクション
