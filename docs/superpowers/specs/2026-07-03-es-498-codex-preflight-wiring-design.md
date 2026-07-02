# ES-498: Codex CLI プリフライト検証の配線 — checkAvailability() を runPreflight に統合する

## 問題

`CodexPlanner.checkAvailability()`（`src/codex-planner.ts` — `codex --version` + `codex login status` + Linux bwrap probe を検証する完成済み・テスト済みメソッド）が、`runPreflight` のチェック一覧（`src/preflight.ts`）に含まれておらず、どこからも呼ばれていない。

その結果、Codex CLI が未インストール / 未認証でも `looppilot-os run` の起動時プリフライトを素通りし、実行時には:

- SELECT（A1 PM 選別）→ 決定的順序フォールバック
- DESIGN REVIEW → fail-open（approve 扱い）
- GROOM → スキップして SELECT へ
- VERIFY 判定 → fail-open pass

と、v2/v3/v3.5 の知能レイヤ全体が無通知で無効化されたまま無人走行し得る。プリフライトの fail-fast 思想（設計仕様 v1 §8 / カーネル §9）に反する。

## 対策（採用案: module-level 関数抽出）

`checkAvailability()` の本体を module-level 関数 `checkCodexAvailability(runner, extraArgs?)` として `src/codex-planner.ts` から export し、メソッドはそれへ委譲する。`runPreflight` に同関数を呼ぶ `checkCodex` を追加する。

採用理由:

- `runPreflight` は既に `runner` を持っており、`PreflightDeps` の拡張も `main.ts` の組み立て順変更も不要（preflight は codexPlanner 構築より前に走るが、`checkAvailability` が使うのは runner と extraArgs のみ）。
- 検証ロジックの単一ソースを維持できる。module 私有の `CODEX_COMMAND` / `codexChildEnv` / `isSandboxBypassed` を使うため、codex-planner.ts 内での関数化が唯一自然な置き場所。
- `checkClaude`（§9.8: `claude --version` + auth status）と対称の形になる。

### 検討した代替案

- **B: PreflightDeps に callback / インスタンス注入 + main.ts で CodexPlanner を preflight 前に構築**: `stopRequested` / `codexRateLimitOpts` の宣言巻き上げが必要で main.ts の再配線が発生し、preflight 全テストに fake の注入が必要になる。`checkAvailability` は runner しか使わないため、インスタンス経由にする利得が現状ない。
- **C: static メソッド化**: 呼び出し側に runner を渡す点は関数化と同等で、class 経由の冗長さだけが増える。module-level 関数が本ファイルの既存イディオム（多数の module-level ヘルパ）に合う。

### Codex を使わない構成の扱い（チケット修正方針 3）

**無条件でチェックする。** `main.ts` は `planner` / `designReviewer` / `recoveryTurn.planner` に常時 `codexPlanner` を配線しており（SELECT と DESIGN REVIEW は常に Codex 経路）、`groom.enabled` / `verify.enabled` は一部経路のゲートに過ぎない。Codex を一切使わない構成は現行 CLI に存在しないため、「Codex が実際に使われる場合のみ検証」は無条件検証に帰着する。将来 Codex 全無効の config が導入された場合は `checkCodex` 呼び出しをその config でゲートする。

## 変更箇所

### 1. src/codex-planner.ts

- `export async function checkCodexAvailability(runner: CommandRunner, extraArgs?: string[]): Promise<string>` を追加（本体は現 `checkAvailability` の移設。`this.runner` → `runner`、`this.opts.extraArgs` → `extraArgs`）。
- `CodexPlanner.checkAvailability()` は `return checkCodexAvailability(this.runner, this.opts.extraArgs);` へ委譲（既存テスト・呼び出し API は無傷）。
- 3 つの probe（`codex --version` / `codex login status` / `bwrap --version`）に `timeoutMs: 30_000` を付与する。`RealCommandRunner` は `timeoutMs` 未指定だと無期限待機のため、ハングした codex がプリフライトを固めるのを防ぐ（既存 preflight チェックの 30–60 秒タイムアウトと整合）。
- not-found 系メッセージに対処を追記する:
  - `--version` 非 0: `codex CLI not found or not available（Codex CLI をインストールし PATH を通してください）`
  - spawn 失敗: `codex CLI not found or not available: ${detail}（Codex CLI をインストールし PATH を通してください）`
  - 既存テストの正規表現（`/codex.*not found|not available/i`、`/ENOENT/`）は維持される。認証系メッセージ（`codex: 認証されていません（codex login を実行してください）` 等）は変更しない。

### 2. src/preflight.ts

- `import { checkCodexAvailability } from "./codex-planner.js";`（依存方向は preflight → codex-planner のみ。循環なし）
- `runPreflight` のチェック一覧の `checkClaude` 直後に `await checkCodex(runner, errors);` を追加（CLI 可用性チェックのグルーピング）。
- 新規チェック関数（他チェックと同じ「throw せず集約」契約）:

  ```ts
  // ---- ES-498: codex 起動可 + 認証確認 ----
  async function checkCodex(runner: CommandRunner, errors: string[]): Promise<void> {
    try {
      await checkCodexAvailability(runner);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  ```

  throw されるメッセージは自己記述的（`codex CLI not found...` / `codex: 認証されていません（codex login を実行してください）` / `codex: 認証状態を確認できません（...）`）なので加工せず push する（`codex: ` の二重前置を避ける）。

### 3. tests/preflight.test.ts

- `const CODEX_CMD = process.platform === "win32" ? "codex.cmd" : "codex";` を定義。
- `passingRunner()` に成功スタブを追加（既存全テストが新チェックを通過し続けるための前提変更）:
  - `[CODEX_CMD, "--version"]` → code 0, `codex-cli 0.137.0`
  - `[CODEX_CMD, "login", "status"]` → code 0
  - `["bwrap", "--version"]` → code 0（Linux probe の portable 化。codex-planner.test.ts と同じ扱い）
- 新 describe「ES-498: codex CLI 可用性」:
  1. 成功系: codex エラーなし + `--version` probe が `cwd: "."` / `timeoutMs: 30_000` で呼ばれる
  2. `--version` 非 0 → not-found + インストール対処を含むエラー
  3. `--version` spawn 失敗 → `ENOENT` を含む not-found エラー
  4. `login status` 非 0 → `認証されていません（codex login を実行してください）`
  5. `login status` spawn 失敗 → `認証状態を確認できません`
  6. (Linux ガード) bwrap probe が throw しても codex エラーなし（non-fatal 維持）
  7. 集約: codex 未認証 + claude 未認証 → 両エラーが同時に列挙される
- `tests/codex-planner.test.ts`: 既存テストは無変更のまま全パス維持（委譲の検証）。加えて `checkCodexAvailability` の契約を単体側で固定するため、成功系テストに probe の `timeoutMs: 30_000` アサーション、`--version` 非 0 テストにインストール対処文言のアサーションを追加する。

### 4. README.md

§4「プリフライト（起動時に自動実行）」の項目 7（`claude --version` 成功）の直後に追記し、以降の番号を繰り下げる:

> 8. `codex --version` 成功 ∧ `codex login status` 認証済み（PM 知能レイヤ = SELECT / GROOM / DESIGN REVIEW / VERIFY 判定が Codex を使うため。Linux の bwrap probe は失敗しても致命的にしない）

## 受け入れ条件（チケットより）

- Codex CLI 不在または未認証のとき、`looppilot-os run` がプリフライトで明確なエラーメッセージ（何が欠けているか＋対処）を列挙して exit 1 する（main.ts の既存経路: errors 非空 → `EXIT_PREFLIGHT = 1`。main.ts 変更なし）。
- Codex が正常なら従来どおり起動する。
- `tests/preflight.test.ts` のパターンに沿ったユニットテスト（成功 / `--version` 失敗 / `login status` 未認証 / probe 失敗）。
- `npm run check` 全パス。

## スコープ外

- 実行時（プリフライト通過後）に Codex が落ちた場合のフォールバック / fail-open 挙動の変更（現行設計を維持）。
- Codex 全無効 config の新設。
- README のプリフライト以外の節の整合性更新（ES-505 の範囲）。
