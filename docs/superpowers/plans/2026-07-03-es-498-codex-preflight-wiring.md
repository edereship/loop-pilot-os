# ES-498: Codex CLI プリフライト検証の配線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `CodexPlanner.checkAvailability()` 相当の検証を `runPreflight` に組み込み、Codex CLI 不在/未認証で `looppilot-os run` が起動時に fail-fast するようにする。

**Architecture:** `checkAvailability()` の本体を module-level 関数 `checkCodexAvailability(runner, extraArgs?)` として `src/codex-planner.ts` から export し、メソッドは委譲に変える。`runPreflight` は `checkClaude` 直後に新チェック `checkCodex` を追加し、throw をエラー集約形式へ変換する（他チェックと同じ「途中 throw しない」契約）。チェックは無条件（main.ts が SELECT / DESIGN REVIEW に常時 codexPlanner を配線するため、Codex を使わない構成は存在しない）。

**Tech Stack:** TypeScript (ESM, `.js` 拡張子 import) / vitest / FakeCommandRunner（tests/fakes.ts、未スタブコマンドは reject・同一プレフィックスは後登録が勝つ）

**Spec:** `docs/superpowers/specs/2026-07-03-es-498-codex-preflight-wiring-design.md`

## Global Constraints

- 既存の `tests/codex-planner.test.ts` の既存テストは修正・削除しない（追加アサーションのみ可）
- `main.ts` / `config.ts` は変更しない
- エラーメッセージは既存正規表現（`/codex.*not found|not available/i`、`/ENOENT/`）を満たし続けること
- 認証系メッセージ `codex: 認証されていません（codex login を実行してください）` / `codex: 認証状態を確認できません（...）` は文言変更しない
- 検証コマンドは `npm run check`（= `tsc --noEmit && tsc --noEmit -p tsconfig.test.json && vitest run`）
- コミットは feature ブランチ `es-498-codex-preflight-wiring` 上で行う

---

### Task 1: `checkCodexAvailability` 関数抽出（timeout 付与 + not-found メッセージに対処追記）

**Files:**
- Modify: `src/codex-planner.ts:468-533`（`checkAvailability` メソッド本体を module-level 関数へ移設）
- Test: `tests/codex-planner.test.ts`（既存 describe `CodexPlanner.checkAvailability` 内に追加アサーション）

**Interfaces:**
- Consumes: `CommandRunner`（`src/types.ts`）、module 私有の `CODEX_COMMAND` / `codexChildEnv` / `isSandboxBypassed`（同ファイル内）
- Produces: `export async function checkCodexAvailability(runner: CommandRunner, extraArgs?: string[]): Promise<string>` — 成功時は version 文字列を返し、不在/未認証時は自己記述的メッセージの `Error` を throw。Task 2 が import する。

- [ ] **Step 1: 失敗するアサーションを追加**

`tests/codex-planner.test.ts` の既存成功系テスト（`it("codex --version が成功かつ認証済み → バージョン文字列を返す", ...)`）の `expect(runner.calls[0]!.opts.cwd).toBe(".");` の直後に追加:

```ts
    // ES-498: probe は 30s タイムアウト付き（RealCommandRunner は timeoutMs 未指定だと無期限待機）
    expect(runner.calls[0]!.opts.timeoutMs).toBe(30_000);
    expect(runner.calls[1]!.opts.timeoutMs).toBe(30_000);
```

同ファイルの `it("codex --version が非0終了 → throw", ...)` の既存 `await expect(...).rejects.toThrow(/codex.*not found|not available/i);` の直後に追加:

```ts
    // ES-498: プリフライトで列挙されるため対処（インストール）を含むこと
    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(/インストール/);
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run tests/codex-planner.test.ts`
Expected: FAIL — `opts.timeoutMs` が `undefined`（成功系）、`/インストール/` に不一致（非0系）。他は PASS。

- [ ] **Step 3: 関数抽出を実装**

`src/codex-planner.ts` の `isSandboxBypassed`（~line 312）と `export class CodexPlanner`（line 314）の間に挿入:

```ts
// ES-498: preflight（runPreflight）から CodexPlanner のインスタンス化なしに呼べるよう
// module-level 関数として公開する。CodexPlanner.checkAvailability() はここへ委譲する。
// 各 probe に timeoutMs を付ける: RealCommandRunner は timeoutMs 未指定だと無期限待機のため、
// ハングした codex がプリフライトを固めるのを防ぐ（preflight の他チェックの 30–60s と整合）。
const AVAILABILITY_PROBE_TIMEOUT_MS = 30_000;

export async function checkCodexAvailability(
  runner: CommandRunner,
  extraArgs?: string[],
): Promise<string> {
  // Create the private home early so the same sanitized env (including the
  // PATH-stripped version) is used for both the --version probe and the auth
  // check. This prevents a false-positive availability report when Codex is
  // reachable only via a relative PATH entry (e.g. node_modules/.bin) that
  // codexChildEnv strips before runtime.
  const privateHome = mkdtempSync(path.join(os.tmpdir(), "codex-planner-"));
  if (process.platform !== "win32") chmodSync(privateHome, 0o700);
  try {
    let result;
    try {
      result = await runner.run(CODEX_COMMAND, ["--version"], {
        cwd: ".",
        env: codexChildEnv(privateHome),
        timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(
        `codex CLI not found or not available: ${err instanceof Error ? err.message : String(err)}` +
          "（Codex CLI をインストールし PATH を通してください）",
      );
    }
    if (result.code !== 0) {
      throw new Error(
        "codex CLI not found or not available（Codex CLI をインストールし PATH を通してください）",
      );
    }
    const version = result.stdout.trim();

    // Run the auth check with the same filtered environment as run() so that
    // environments relying on env-var-only auth (CODEX_API_KEY / CODEX_ACCESS_TOKEN)
    // fail here at preflight rather than silently at exec time.
    let authResult;
    try {
      authResult = await runner.run(CODEX_COMMAND, ["login", "status"], {
        cwd: ".",
        env: codexChildEnv(privateHome),
        timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(
        `codex: 認証状態を確認できません（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (authResult.code !== 0) {
      throw new Error("codex: 認証されていません（codex login を実行してください）");
    }

    // On Linux, Codex uses bwrap + seccomp for sandboxing. Probe bwrap so
    // preflight can surface a missing helper early rather than at exec time.
    // Skip the probe when extraArgs bypass sandboxing (e.g. --yolo), and
    // treat a missing or failing bwrap as a non-fatal warning: Codex may
    // fall back to its own sandbox helper on some configurations.
    if (process.platform === "linux" && !isSandboxBypassed(extraArgs ?? [])) {
      try {
        // Use the same sanitized env as all other child invocations so that
        // relative PATH entries (e.g. "." or "node_modules/.bin") cannot
        // shadow the system bwrap binary when LoopPilot is started from a
        // repository or config directory.
        await runner.run("bwrap", ["--version"], {
          cwd: ".",
          env: codexChildEnv(privateHome),
          timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS,
        });
      } catch {
        // bwrap unavailable; Codex may use a fallback — proceed and let
        // runtime surface the failure if sandboxing truly cannot start.
      }
    }

    return version;
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
}
```

`CodexPlanner.checkAvailability()`（line 468-533）のメソッド全体を委譲へ置換:

```ts
  async checkAvailability(): Promise<string> {
    return checkCodexAvailability(this.runner, this.opts.extraArgs);
  }
```

- [ ] **Step 4: テストを実行して合格を確認**

Run: `npx vitest run tests/codex-planner.test.ts`
Expected: PASS（既存 + 追加アサーション全件）

- [ ] **Step 5: コミット**

```bash
git add src/codex-planner.ts tests/codex-planner.test.ts
git commit -m "refactor: checkAvailability を checkCodexAvailability 関数へ抽出 + 30s timeout（ES-498）"
```

---

### Task 2: `runPreflight` への配線（checkCodex）

**Files:**
- Modify: `src/preflight.ts`（import 追加、チェック一覧に 1 行、`checkCodex` 関数追加）
- Test: `tests/preflight.test.ts`（`passingRunner()` に codex スタブ、新 describe 追加）

**Interfaces:**
- Consumes: `checkCodexAvailability(runner)`（Task 1。extraArgs は渡さない — main.ts の CodexPlanner 構築も extraArgs を渡していないため同一挙動）
- Produces: `runPreflight` の返す `errors: string[]` に codex 検証結果が含まれる（main.ts は無変更で exit 1 経路が機能する）

- [ ] **Step 1: 失敗するテストを追加**

`tests/preflight.test.ts` の import 群の直後（`const passingNotifier` より前のトップレベル）に追加:

```ts
// Windows では npm CLI が .cmd shim 経由になる（codex-planner.ts の CODEX_COMMAND と同一規則）
const CODEX_CMD = process.platform === "win32" ? "codex.cmd" : "codex";
```

`passingRunner()` 内の claude スタブ 2 行（`r.on(["claude", "auth", "status", "--json"], ...)`）の直後・`return r;` の前に追加:

```ts
  // ES-498: codex 起動可 + 認証済み（Linux の bwrap probe も portable にスタブ）
  r.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
  r.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
  r.on(["bwrap", "--version"], { code: 0, stdout: "bwrap 0.8.0\n", stderr: "" });
```

ファイル末尾（最後の describe の閉じ括弧の後）に新 describe を追加:

```ts
// ---- ES-498: codex CLI 可用性（checkCodexAvailability の runPreflight 配線） ----
describe("runPreflight: codex CLI 可用性（ES-498）", () => {
  it("codex が正常（--version 成功 + 認証済み）なら codex 系エラーなし・probe は cwd '.' / 30s timeout", async () => {
    const r = passingRunner();
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.toLowerCase().includes("codex"))).toEqual([]);
    const versionCall = r.calls.find((c) => c.cmd === CODEX_CMD && c.args[0] === "--version");
    expect(versionCall).toBeDefined();
    expect(versionCall!.opts.cwd).toBe(".");
    expect(versionCall!.opts.timeoutMs).toBe(30_000);
  });

  it("codex --version が非0終了なら not-found + インストール対処を列挙（修正方針 1）", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex CLI not found or not available") && e.includes("インストール"))).toBe(true);
  });

  it("codex --version が spawn 失敗（ENOENT）なら診断付き not-found を列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "--version"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex CLI not found or not available") && e.includes("ENOENT"))).toBe(true);
  });

  it("codex login status が非0（未認証）なら codex login の対処を列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 認証されていません") && e.includes("codex login"))).toBe(true);
  });

  it("codex login status が spawn 失敗なら認証確認エラーを列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 認証状態を確認できません"))).toBe(true);
  });

  it("Linux: bwrap probe が失敗しても codex チェックは合格のまま（non-fatal probe 維持）", async () => {
    if (process.platform !== "linux") return;
    const r = passingRunner();
    // FakeCommandRunner は同一プレフィックスなら後登録が勝つ — bwrap probe を spawn 失敗に上書き。
    r.on(["bwrap", "--version"], () => {
      throw new Error("spawn bwrap ENOENT");
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors).toEqual([]);
  });

  it("codex 未認証 + claude 未認証は両方同時に列挙される（途中 throw せず集約; 仕様 §9）", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    r.on(["claude", "auth", "status", "--json"], { code: 0, stdout: '{"loggedIn":false}\n', stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 認証されていません"))).toBe(true);
    expect(errors.some((e) => e.includes("claude: 認証されていません"))).toBe(true);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run tests/preflight.test.ts`
Expected: FAIL — 新 describe の 5 件（非0 / spawn失敗 ×2 / 未認証 / 集約）が「エラーが列挙されない」で失敗し、成功系 1 件目も `versionCall` が `undefined` で失敗（checkCodex 未配線のため codex probe が呼ばれない）。既存テストは全 PASS のまま。

- [ ] **Step 3: `src/preflight.ts` に checkCodex を実装**

import 追加（`import { resolveLinearSetup } from "./task-source.js";` の直後）:

```ts
import { checkCodexAvailability } from "./codex-planner.js";
```

`runPreflight` のチェック一覧、`await checkClaude(runner, opts, errors);` の直後に追加:

```ts
  await checkCodex(runner, errors);                                    // ES-498: codex 可用性
```

`checkClaude` 関数定義の直後に追加:

```ts
// ---- ES-498: codex 起動可 + 認証確認 ----
// v2/v3 知能レイヤ（SELECT / DESIGN REVIEW / GROOM / VERIFY 判定）は main.ts で常時
// codexPlanner を配線するため、Codex を使わない構成は現行 CLI に存在しない — 無条件で検証する。
// 検証ロジックは codex-planner.ts の checkCodexAvailability（CodexPlanner.checkAvailability と
// 同一実体）を再利用し、throw をエラー集約形式へ変換する。throw されるメッセージは自己記述的
//（"codex CLI not found..." / "codex: 認証されていません（codex login を実行してください）"）
// なので加工せず push する（"codex: " の二重前置を避ける）。
async function checkCodex(runner: CommandRunner, errors: string[]): Promise<void> {
  try {
    await checkCodexAvailability(runner);
  } catch (e) {
    errors.push((e as Error).message);
  }
}
```

- [ ] **Step 4: テストを実行して合格を確認**

Run: `npx vitest run tests/preflight.test.ts tests/codex-planner.test.ts`
Expected: PASS（既存 + 新規全件。既存の「全項目合格なら空配列」テストも passingRunner の codex スタブで PASS）

- [ ] **Step 5: コミット**

```bash
git add src/preflight.ts tests/preflight.test.ts
git commit -m "feat: runPreflight に Codex CLI 可用性チェックを配線（ES-498）"
```

---

### Task 3: README プリフライト項目一覧に追記 + 全体検証

**Files:**
- Modify: `README.md`（§4「プリフライト（起動時に自動実行）」の番号付きリスト）

**Interfaces:**
- Consumes: Task 2 の実装済みチェック順（checkClaude の直後に checkCodex）
- Produces: なし（ドキュメントのみ）

- [ ] **Step 1: README §4 リストを更新**

変更前（項目 7〜9）:

```markdown
7. `claude --version` 成功
8. state-comment 著者の整合: リポの `LOOPPILOT_STATE_COMMENT_AUTHORS`（未設定なら既定 `github-actions[bot]`）が `looppilot.state_comment_authors` に包含される（不整合だと Monitor が信頼コメントを発見できず `monitor_never_engaged` で全停止するため）
9. Slack 設定時は Webhook へ直接 POST して到達性確認
```

変更後:

```markdown
7. `claude --version` 成功
8. `codex --version` 成功 ∧ `codex login status` 認証済み（PM 知能レイヤ = SELECT / GROOM / DESIGN REVIEW / VERIFY 判定が Codex を使うため。Linux の bwrap probe は失敗しても致命的にしない）
9. state-comment 著者の整合: リポの `LOOPPILOT_STATE_COMMENT_AUTHORS`（未設定なら既定 `github-actions[bot]`）が `looppilot.state_comment_authors` に包含される（不整合だと Monitor が信頼コメントを発見できず `monitor_never_engaged` で全停止するため）
10. Slack 設定時は Webhook へ直接 POST して到達性確認
```

- [ ] **Step 2: 全体検証**

Run: `npm run check`
Expected: `tsc --noEmit`（src / test 両 tsconfig）エラーなし、vitest 全スイート PASS（1742+ 件）

- [ ] **Step 3: コミット**

```bash
git add README.md
git commit -m "docs: README プリフライト一覧に Codex CLI チェックを追記（ES-498）"
```
