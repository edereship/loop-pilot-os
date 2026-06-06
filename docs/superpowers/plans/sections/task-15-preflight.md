### Task 15: プリフライト

**目的**: 起動時に「環境が安全にループを回せる状態か」を fail-fast で検証する。カーネル §9 の 10 項目を一字一句のコマンドで実行し、各違反を `string` メッセージとして**集約**（途中で throw せず全件実行）して返す `runPreflight(deps) => Promise<string[]>`（空配列=合格）を `src/preflight.ts` に実装する。Linear 解決は task-source.ts の `resolveLinearSetup`、Slack 到達確認は `notifier.probeReachability()` を利用する。著者整合は §9 step9 の R⊆C 規則。

**依存タスク**: Task 2（types.ts: `CommandRunner`, `CommandResult`, `RunOptions`, `Notifier`, `TicketState`）、Task 3（exec.ts + tests/fakes.ts の `FakeCommandRunner`）、Task 4（config.ts: `Config` 型 — `Config` は **config.ts** が唯一の定義元で types.ts には無い）、Task 6（notifier.ts: `Notifier.probeReachability`）、Task 7（task-source.ts: `resolveLinearSetup` / `FetchFn` / `LinearSetupRequest` / `ResolvedLinearSetup`）。本タスクは consumes のみで、これらの実装を変更しない。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/preflight.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/preflight.test.ts`

---

#### 契約の固定（実装前に確認・本タスクで新規定義する公開シンボル）

`src/preflight.ts` は以下のみを export する。

```typescript
export interface PreflightDeps {
  config: Config;
  runner: CommandRunner;
  notifier: Notifier;
  fetchFn: FetchFn;
}
export function runPreflight(deps: PreflightDeps): Promise<string[]>;
```

**consumes（他タスク定義物・改名禁止・本タスクで一字一句一致させる対象）**:
- `CommandRunner`, `CommandResult`, `RunOptions`, `Notifier`, `TicketState`（`../src/types.js` / Task 2、カーネル §2）
- `Config`（`../src/config.js` / Task 4。**types.ts ではなく config.ts が定義元**。形は下記 `makeConfig` のとおり camelCase）
- `resolveLinearSetup`, `FetchFn`, `LinearSetupRequest`, `ResolvedLinearSetup`（`../src/task-source.js` / Task 7）。確定シグネチャ（カーネル §5.5・Task 7 §で確認済み）:
  ```typescript
  // task-source.ts より（本タスクは import して呼ぶだけ・改変しない）
  export type FetchFn = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

  export interface LinearSetupRequest {
    teamKey: string;
    projectName: string;
    stateNames: Record<TicketState, string>;   // TicketState = "todo"|"in_progress"|"in_review"|"done"
    optInLabel: string;
  }
  export interface ResolvedLinearSetup {
    viewerId: string; teamId: string; projectId: string;
    stateIds: Record<TicketState, string>; optInLabelId: string;
  }
  export function resolveLinearSetup(
    apiKey: string,
    req: LinearSetupRequest,
    fetchFn: FetchFn,
  ): Promise<ResolvedLinearSetup>;   // 解決不能なら throw（fail-fast 用に欠落を 1 回でまとめて報告）
  ```
- `notifier.probeReachability(): Promise<void>`（notifier.ts / Task 6）。Slack 未設定なら即 resolve、設定済みで非2xx/network なら throw。

> **重要な契約注意（実装で踏むと壊れる）**:
> 1. `resolveLinearSetup` の引数は `(apiKey, req, fetchFn)` の **3 引数**。`{ config, fetchFn }` の 1 オブジェクトではない。
> 2. `fetchFn` の型は **`FetchFn`**（戻り値 `{ ok, status, json() }`）であり Web 標準 `typeof fetch` ではない。テストの fake fetch も `{ ok, status, json() }` を返すプレーンオブジェクトで作る（`new Response(...)` は使わない）。
> 3. `config.linear.states` のキーは camelCase（`todo/inProgress/inReview/done`）。一方 `LinearSetupRequest.stateNames` のキーは `TicketState`（`todo/in_progress/in_review/done`）。`checkLinear` で**明示的にキー写像**する。

---

#### Step 1: 失敗するテストファイルの骨組み（合格ヘルパ + 最初の NG テスト1件）を書く

- [ ] **Step 1: `tests/preflight.test.ts` を新規作成し、合格ヘルパ（`makeConfig`/`passingRunner`/`passingFetch`/`passingNotifier`）と「default_branch 以外で起動すると NG」テスト1件を書く（`runPreflight` 未実装なので失敗する）**

`/home/racoma-dev/loop-pilot-os/tests/preflight.test.ts` を作成:

```typescript
import { describe, it, expect } from "vitest";
import { runPreflight } from "../src/preflight.js";
import { FakeCommandRunner } from "./fakes.js";
import type { Notifier, NotifyEvent, TicketState } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FetchFn } from "../src/task-source.js";

// ---- テスト用の最小 Config（config.ts §の Config 形・camelCase は解決済みの形） ----
function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    product: { goal: "ship it" },
    repo: {
      path: "/abs/repo",
      remote: "owner/name",
      defaultBranch: "main",
      worktreeRoot: "/home/u/.looppilot-os/worktrees/repo",
    },
    linear: {
      team: "TY",
      project: "LoopPilot OS",
      optInLabel: "ai-ok",
      states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" },
    },
    agent: { model: "opus", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    handoff: { branchPrefix: "looppilot", prBodyTemplate: "Implements {identifier}" },
    looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]"] },
    safety: {
      maxTasksPerRun: 3,
      maxCostUsdPerSession: 10,
      monitorTimeoutMinutes: undefined,
      notEngagedGuardMinutes: 30,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    digest: { recentMergedCount: 5 },
    linearApiKey: "lin_api_test",
    slackWebhookUrl: undefined,
    stateDbPath: "/abs/repo/looppilot-os.db",
  };
  return { ...base, ...overrides };
}

// ---- すべて合格になるよう FakeCommandRunner を仕込むヘルパ（カーネル §9 の各コマンド） ----
function passingRunner(): FakeCommandRunner {
  const r = new FakeCommandRunner();
  // §9.2: クリーンな defaultBranch 上
  r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "main\n", stderr: "" });
  r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: "", stderr: "" });
  // §9.3: remote 到達
  r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 0, stdout: "deadbeef\tHEAD\n", stderr: "" });
  // §9.4: gh 認証
  r.on(["gh", "auth", "status"], { code: 0, stdout: "Logged in", stderr: "" });
  // §9.4: push 権限
  r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "true\n", stderr: "" });
  // §9.4: 認証ユーザー名（restrictions の許可リスト照合に使う）
  r.on(["gh", "api", "user", "--jq", ".login"], { code: 0, stdout: "the-bot\n", stderr: "" });
  // §9.4: ブランチ保護なし → 404
  r.on(["gh", "api", "repos/owner/name/branches/main/protection"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.4: rulesets 空配列（保護なし）
  r.on(["gh", "api", "repos/owner/name/rules/branches/main"], { code: 0, stdout: "[]\n", stderr: "" });
  // §9.5: gate_label がリポラベルに存在
  r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nloop-pilot\nai-ok\n", stderr: "" });
  // §9.6: AUTO_MERGE 未設定 → 404
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.9: STATE_COMMENT_AUTHORS 未設定 → 404（リポ既定 github-actions[bot]）
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.8: claude 起動可
  r.on(["claude", "--version"], { code: 0, stdout: "2.1.165 (Claude Code)\n", stderr: "" });
  return r;
}

// resolveLinearSetup は https://api.linear.app/graphql を `FetchFn` で叩く。
// 解決に必要な viewer/teams/projects/issueLabels を一括で返す合格応答（Task 7 SETUP_QUERY の shape）。
// FetchFn の戻り値は { ok, status, json() }。Web Response ではない。
function passingFetch(): FetchFn {
  const body = {
    data: {
      viewer: { id: "user-1", name: "Viewer" },
      teams: {
        nodes: [
          {
            id: "team-1",
            key: "TY",
            states: {
              nodes: [
                { id: "st-todo", name: "Todo" },
                { id: "st-prog", name: "In Progress" },
                { id: "st-rev", name: "In Review" },
                { id: "st-done", name: "Done" },
              ],
            },
            labels: { nodes: [{ id: "lb-1", name: "ai-ok" }] },
          },
        ],
      },
      projects: { nodes: [{ id: "proj-1", name: "LoopPilot OS" }] },
      issueLabels: { nodes: [] },
    },
  };
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

const passingNotifier: Notifier = {
  notify: async (_e: NotifyEvent) => {},
  probeReachability: async () => {},
};

describe("runPreflight", () => {
  // 仕様 §9.2 / §8: repo はクリーンな git で default_branch 上であること。
  it("default_branch 以外で起動すると NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "feature-x\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("feature-x") && e.includes("default_branch"))).toBe(true);
  });
});
```

> このステップでは `src/preflight.ts` がまだ無いため、`import { runPreflight }` の解決に失敗する。次ステップでその失敗を確認する。

---

#### Step 2: テストを実行して失敗を確認する

- [ ] **Step 2: `npx vitest run tests/preflight.test.ts` を実行し、`src/preflight.ts` 不在で import 解決に失敗することを確認する**

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される失敗: `Failed to resolve import "../src/preflight.js" from "tests/preflight.test.ts"`（モジュール未作成）。この赤を確認してから実装へ進む。

---

#### Step 3: `runPreflight` の骨格 + §9.2(checkGitClean) チェックを実装して**緑**にする

- [ ] **Step 3: `src/preflight.ts` を作成する。集約骨格（全チェックを順に呼び、各 `errors` を連結して返す）と `checkGitClean` を完全実装し、残りのチェック（remote/gh-auth/push を含む全て）は空関数にして、Step 1 のテストを green にする**

> この Step では「集約骨格」と最初の 1 チェック `checkGitClean` のみを**完全実装**する。残りのチェック（remote/gh-auth/push/保護/rulesets/gate_label/auto_merge/state_authors/linear/claude/slack）は、後続 Step でそれぞれ「先に赤テスト → 実装 → 緑」を踏んで追加するため、この時点では**空関数**にしておく。骨格は最初から全チェックを呼ぶが、各チェック関数の検知ロジック本体は対応する赤テストを確認した直後の Step でファイルに追記して配線する。
>
> ここでの green は inert スタブによる偽の green ではない。`checkGitClean` は実際の検知ロジックを持ち、Step 1 の「feature-x で NG」テストはその実装を genuine に検証する。残り全チェックは空関数なので Step 1 のテストには影響しない（赤を経て各 Step で実装される）。

`/home/racoma-dev/loop-pilot-os/src/preflight.ts` を作成:

```typescript
import type { CommandRunner, CommandResult, Notifier, TicketState } from "./types.js";
import type { Config } from "./config.js";
import type { FetchFn, LinearSetupRequest } from "./task-source.js";
import { resolveLinearSetup } from "./task-source.js";

export interface PreflightDeps {
  config: Config;
  runner: CommandRunner;
  notifier: Notifier;
  fetchFn: FetchFn;
}

// gh api は HTTP エラー時 code != 0 で終了し、stderr に "(HTTP 404)" 等を含む。
// 404 を「存在しない」シグナルとして識別する（branch protection / actions variable で必須）。
function isHttp404(r: CommandResult): boolean {
  return r.code !== 0 && /\(HTTP 404\)/.test(r.stderr);
}

// LOOPPILOT_STATE_COMMENT_AUTHORS の値を LoopPilot と同一パースする
// （カンマ区切り → trim → 空除去）。state-manager.ts の getTrustedStateCommentAuthors と同規則。
function parseAuthors(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export async function runPreflight(deps: PreflightDeps): Promise<string[]> {
  const { config, runner } = deps;
  const errors: string[] = [];
  const repoPath = config.repo.path;
  const repoSlug = config.repo.remote;
  const branch = config.repo.defaultBranch;
  const opts = { cwd: repoPath };

  // カーネル §9: 全項目を実行して集約。各 check 内で try/catch し、途中 throw しない。
  await checkGitClean(runner, repoPath, branch, opts, errors);          // §9.2
  await checkRemote(runner, repoPath, opts, errors);                   // §9.3（Step 4b で追加）
  await checkGhAuth(runner, opts, errors);                             // §9.4 認証（Step 4b で追加）
  await checkPushPermission(runner, repoSlug, opts, errors);           // §9.4 push 権限（Step 4b で追加）
  await checkBranchProtection(runner, repoSlug, branch, opts, errors); // §9.4 保護（Step 5 で追加）
  await checkRulesets(runner, repoSlug, branch, opts, errors);         // §9.4 rulesets（Step 7 で追加）
  await checkGateLabel(runner, config, repoSlug, opts, errors);        // §9.5（Step 9 で追加）
  await checkAutoMerge(runner, repoSlug, opts, errors);               // §9.6（Step 11 で追加）
  await checkStateCommentAuthors(runner, config, repoSlug, opts, errors); // §9.9（Step 13 で追加）
  await checkLinear(deps, errors);                                     // §9.7（Step 15 で追加）
  await checkClaude(runner, opts, errors);                             // §9.8（Step 17 で追加）
  await checkSlack(deps, errors);                                      // §9.10（Step 17 で追加）

  return errors;
}

// ---- §9.2 repo がクリーンな git で default_branch 上 ----
async function checkGitClean(
  runner: CommandRunner,
  repoPath: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const head = await runner.run("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], opts);
    const current = head.stdout.trim();
    if (head.code !== 0) {
      errors.push(`git: HEAD ブランチを取得できません（${head.stderr.trim()}）`);
    } else if (current !== branch) {
      errors.push(`git: 現在のブランチが '${current}' です。default_branch '${branch}' 上で起動してください`);
    }
    const status = await runner.run("git", ["-C", repoPath, "status", "--porcelain"], opts);
    if (status.code !== 0) {
      errors.push(`git: 作業ツリーの状態を取得できません（${status.stderr.trim()}）`);
    } else if (status.stdout.trim() !== "") {
      errors.push("git: 作業ツリーがクリーンではありません。未コミットの変更を解消してください");
    }
  } catch (e) {
    errors.push(`git: 状態確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.3 remote 到達可（Step 4b で本体を追加） ----
async function checkRemote(
  _runner: CommandRunner, _repoPath: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

// ---- §9.4 gh 認証（Step 4b で本体を追加） ----
async function checkGhAuth(
  _runner: CommandRunner, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

// ---- §9.4 push 権限（Step 4b で本体を追加） ----
async function checkPushPermission(
  _runner: CommandRunner, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 4b で実装（先に Step 4a で赤テストを書く） */ }

// ---- §9.4 ブランチ保護（Step 6 で本体を追加） ----
async function checkBranchProtection(
  _runner: CommandRunner, _repoSlug: string, _branch: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 6 で実装（先に Step 5 で赤テストを書く） */ }

// ---- §9.4 rulesets（Step 8 で本体を追加） ----
async function checkRulesets(
  _runner: CommandRunner, _repoSlug: string, _branch: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 8 で実装（先に Step 7 で赤テストを書く） */ }

// ---- §9.5 gate_label（Step 10 で本体を追加） ----
async function checkGateLabel(
  _runner: CommandRunner, _config: Config, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 10 で実装（先に Step 9 で赤テストを書く） */ }

// ---- §9.6 LOOPPILOT_AUTO_MERGE（Step 12 で本体を追加） ----
async function checkAutoMerge(
  _runner: CommandRunner, _repoSlug: string, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 12 で実装（先に Step 11 で赤テストを書く） */ }

// ---- §9.9 state-comment 著者整合 R⊆C（Step 14 で本体を追加） ----
async function checkStateCommentAuthors(
  _runner: CommandRunner, _config: Config, _repoSlug: string,
  _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 14 で実装（先に Step 13 で赤テストを書く） */ }

// ---- §9.7 Linear 解決（Step 16 で本体を追加） ----
async function checkLinear(_deps: PreflightDeps, _errors: string[]): Promise<void> {
  /* 本体は Step 16 で実装（先に Step 15 で赤テストを書く） */
}

// ---- §9.8 claude 起動可（Step 18 で本体を追加） ----
async function checkClaude(
  _runner: CommandRunner, _opts: { cwd: string }, _errors: string[],
): Promise<void> { /* 本体は Step 18 で実装（先に Step 17 で赤テストを書く） */ }

// ---- §9.10 Slack 到達可（Step 18 で本体を追加） ----
async function checkSlack(_deps: PreflightDeps, _errors: string[]): Promise<void> {
  /* 本体は Step 18 で実装（先に Step 17 で赤テストを書く） */
}
```

> 設計判断（TDD 順序とビルド可能性の両立）: カーネル §0「全タスク red→green」を守りつつ、`runPreflight` の集約骨格を一度に書くために、まだ赤テストを書いていないチェック（`checkGitClean` 以外のすべて＝remote/gh-auth/push および保護以降）は**この時点で空関数**にしておく。各チェックの検知ロジック本体（`errors.push`）は、対応する不合格テストを**先に赤**で確認した直後の Step で初めて追加する。これにより「テストがその分岐を実際に検証できる」こと（red→green の検証単位を各チェックが持つこと）が各チェック単位で証明される。tsc は未使用 import (`resolveLinearSetup`/`FetchFn`/`LinearSetupRequest`/`TicketState`) を strict でもエラーにせず（カーネル §0「lint なし」）、Step 3 単独で型チェックが通る。

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
cd /home/racoma-dev/loop-pilot-os && npm run check
```

期待: Step 1 の「feature-x で NG」テストが pass（緑）。tsc（src + test）も通過。

- [ ] **Step 3b: ここまでをコミットする（red→green の単位）**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: runPreflight skeleton + git-clean check"
```

---

#### Step 4a: git ダーティ / remote / gh-auth / push の NG テストを追加して**赤**を確認する

- [ ] **Step 4a: `tests/preflight.test.ts` に §9.2 ダーティ / §9.3 remote 不可 / §9.4 push false の NG テストを追加し、赤を確認する**

> `checkRemote`/`checkGhAuth`/`checkPushPermission` は Step 3 で**空関数**なので、「remote 不可=NG」「gh 認証なし=NG」「push false=NG」を期待する 3 テストはこの時点で fail する（赤）。これにより各チェックが red→green の検証単位を持つ（カーネル §0/§11 の TDD 規約）。「ダーティ=NG」は `checkGitClean` が Step 3 で実装済みのため pass し、実装後の回帰ガードになる（このテストは保護以降の OK テストと同様、既実装分岐の回帰を守る）。remote/gh-auth/push は §9.3/§9.4 の同一グループなので、本 Step でまとめて赤を踏み Step 4b でまとめて実装する。

`describe("runPreflight", ...)` 内の最初のテストの**後**に追加:

```typescript
  it("作業ツリーがダーティなら NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M src/a.ts\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
  });

  it("remote 到達不可なら NG（仕様 §9.3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 128, stdout: "", stderr: "fatal: could not read from remote" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("到達できません"))).toBe(true);
  });

  it("gh 認証されていなければ NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "auth", "status"], { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("認証されていません"))).toBe(true);
  });

  it("push 権限が false なら NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「remote 不可=NG」「gh 認証なし=NG」「push false=NG」の 3 テストが fail（空関数が何も push しないため `AssertionError: expected false to be true`）。「ダーティ=NG」は pass（`checkGitClean` 実装済み）。この赤を確認してから Step 4b で実装する。

---

#### Step 4b: `checkRemote`/`checkGhAuth`/`checkPushPermission` の本体を実装して**緑**にする

- [ ] **Step 4b: `src/preflight.ts` の `checkRemote`/`checkGhAuth`/`checkPushPermission` の空関数本体を実装で置換し、Step 4a の 4 テストが green になることを確認する**

`src/preflight.ts` の 3 つの空関数を以下で置換する:

```typescript
// ---- §9.3 remote 到達可 ----
async function checkRemote(
  runner: CommandRunner,
  repoPath: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const ls = await runner.run("git", ["-C", repoPath, "ls-remote", "origin", "HEAD"], opts);
    if (ls.code !== 0) {
      errors.push(`git: remote 'origin' に到達できません（${ls.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`git: remote 到達確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 gh 認証 ----
async function checkGhAuth(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const auth = await runner.run("gh", ["auth", "status"], opts);
    if (auth.code !== 0) {
      errors.push(`gh: 認証されていません（gh auth login を実行してください: ${auth.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`gh: 認証確認に失敗しました（${(e as Error).message}）`);
  }
}

// ---- §9.4 push 権限 ----
async function checkPushPermission(
  runner: CommandRunner,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const push = await runner.run("gh", ["api", `repos/${repoSlug}`, "--jq", ".permissions.push"], opts);
    if (push.code !== 0) {
      errors.push(`gh: リポジトリ ${repoSlug} の権限を取得できません（${push.stderr.trim()}）`);
    } else if (push.stdout.trim() !== "true") {
      errors.push(`gh: リポジトリ ${repoSlug} への push 権限がありません`);
    }
  } catch (e) {
    errors.push(`gh: push 権限確認に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 4a の「remote 不可=NG」「gh 認証なし=NG」「push false=NG」が pass へ転じ、「ダーティ=NG」も pass のまま（緑）。万一 fail する場合は `includes` キーワードを実装の文言に**一致**させる（実装文言は変更しない）。

- [ ] **Step 4c: ここまでをコミットする（red→green の単位）**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight remote/gh-auth/push checks"
```

---

#### Step 5: ブランチ保護の不合格テストを追加して**赤**を確認する（restrictions OK/NG を含む）

- [ ] **Step 5: `tests/preflight.test.ts` に §9.4 ブランチ保護テスト（404=OK / review>0=NG / restrictions に認証ユーザー含む=OK / 含まない=NG）を追加し、赤を確認する**

> `checkBranchProtection` は Step 3 で**空関数**。よって「review>0 で NG」「restrictions に認証ユーザー不在で NG」を期待する 2 テストはこの時点で fail する（赤）。「404=OK」「restrictions に認証ユーザーを含む=OK」の 2 テストは空関数でも偶然 pass しうるが、Step 6 実装後も pass し続けることで OK 分岐の回帰を守る（特に restrictions=含む→OK は、カーネル §9.4『含むときのみ OK』を直接検証する回帰テスト）。

Step 4a で追加した最後のテストの**後**に追加:

```typescript
  it("ブランチ保護なし（404）は OK 判定（仕様 §9.4）", async () => {
    // passingRunner はすでに protection=404, rulesets=[] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("必須承認レビュー") || e.includes("restrictions"))).toEqual([]);
  });

  it("required_approving_review_count>0 のブランチ保護は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("必須承認レビュー数") && e.includes("1"))).toBe(true);
  });

  it("restrictions に認証ユーザーが含まれていれば OK（仕様 §9.4・カーネル『含むときのみ OK』）", async () => {
    const r = passingRunner();
    // 認証ユーザーは the-bot（passingRunner の gh api user 応答）。restrictions.users に the-bot を含める。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "the-bot" }, { login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    // restrictions があっても認証ユーザーが許可リストに居る → ブランチ由来エラーなし。
    expect(errors.filter((e) => e.includes("restrictions") || e.includes("必須承認レビュー"))).toEqual([]);
  });

  it("restrictions に認証ユーザーが不在なら NG（仕様 §9.4・カーネル『不在のみ NG』）", async () => {
    const r = passingRunner();
    // 認証ユーザー the-bot が restrictions.users に居ない → NG。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("restrictions") && e.includes("the-bot"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「review>0=NG」と「restrictions 不在=NG」の 2 テストが fail（空関数が何も push しないため `AssertionError: expected false to be true`）。「404=OK」「restrictions 含む=OK」は pass。この赤を確認してから Step 6 で実装する。

---

#### Step 6: `checkBranchProtection` の本体を実装して**緑**にする

- [ ] **Step 6: `checkBranchProtection` の空関数本体を実装で置換し（`resolveAuthenticatedLogin` ヘルパを新規追加）、Step 5 の 4 テストが green になることを確認する**

`src/preflight.ts` の `checkBranchProtection` 空関数を以下で置換し、ファイル末尾に `resolveAuthenticatedLogin` を新規追加する:

```typescript
async function checkBranchProtection(
  runner: CommandRunner,
  repoSlug: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/branches/${branch}/protection`], opts);
    if (isHttp404(r)) return; // 保護なし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチ保護を取得できません（${r.stderr.trim()}）`);
      return;
    }
    let parsed: {
      required_pull_request_reviews?: { required_approving_review_count?: number };
      restrictions?: {
        users?: Array<{ login: string }>;
        teams?: Array<{ slug: string }>;
        apps?: Array<{ slug: string }>;
      } | null;
    };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: ブランチ保護のJSONを解析できません");
      return;
    }
    const reviewCount = parsed.required_pull_request_reviews?.required_approving_review_count ?? 0;
    if (reviewCount > 0) {
      errors.push(
        `gh: ブランチ '${branch}' は必須承認レビュー数が ${reviewCount} です。` +
          "ループに人間レビュアーが不在のためマージ不能になります（required_approving_review_count を 0 にしてください）",
      );
    }
    // restrictions が設定されている場合、push/merge できる identity が allowlist に限定される。
    // カーネル §9.4 の NG 条件は「restrictions に認証ユーザー不在」。
    // 認証ユーザー（=push 権限保持者）が許可リストに含まれていれば restrictions があっても OK。
    // 含まれていない場合のみ、その identity からはマージできないため NG。
    if (parsed.restrictions != null) {
      const login = await resolveAuthenticatedLogin(runner, opts);
      if (login == null) {
        errors.push(
          `gh: ブランチ '${branch}' に push 制限（restrictions）がありますが、` +
            "認証ユーザー名を解決できず許可リストとの照合ができません（gh api user --jq .login を確認してください）",
        );
      } else {
        const allowedUsers = (parsed.restrictions.users ?? []).map((u) => u.login);
        if (!allowedUsers.includes(login)) {
          errors.push(
            `gh: ブランチ '${branch}' の push 制限（restrictions）の許可リストに認証ユーザー '${login}' が含まれていません。` +
              "この identity からはマージできません。restrictions.users に '" + login + "' を追加してください",
          );
        }
      }
    }
  } catch (e) {
    errors.push(`gh: ブランチ保護確認に失敗しました（${(e as Error).message}）`);
  }
}

// 認証ユーザーのログイン名を解決する（restrictions の許可リスト照合に使う）。
// 失敗時は null を返し、呼び出し側で照合不能として扱う。
async function resolveAuthenticatedLogin(
  runner: CommandRunner,
  opts: { cwd: string },
): Promise<string | null> {
  try {
    const r = await runner.run("gh", ["api", "user", "--jq", ".login"], opts);
    if (r.code !== 0) return null;
    const login = r.stdout.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 5 の「review>0=NG」「restrictions 不在=NG」が pass へ転じ、「404=OK」「restrictions 含む=OK」も pass のまま（緑）。

> 設計判断: カーネル §9.4 の restrictions NG 条件は「認証ユーザーが許可リストに不在のときのみ」。`gh api user --jq .login` で認証ユーザー名を解決し、`restrictions.users[].login` に含まれていれば restrictions があっても OK、含まれていなければ NG とする（teams/apps による許可は users の allowlist を満たさないため、ユーザー本人が users に居ない限り保守的に NG とする＝最小権限で起動可否を確実に判定）。

- [ ] **Step 6b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight branch-protection check (review>0 / restrictions allowlist)"
```

---

#### Step 7: rulesets の不合格テストを追加して**赤**を確認する

- [ ] **Step 7: `tests/preflight.test.ts` に §9.4 rulesets テスト（404=OK / pull_request ルールで required_approving_review_count>0 は NG）を追加し、赤を確認する**

Step 5 で追加した最後のテストの**後**に追加:

```typescript
  it("rulesets が空配列なら OK（仕様 §9.4）", async () => {
    // passingRunner は rules/branches/main = [] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ルールセット"))).toEqual([]);
  });

  it("rulesets の pull_request ルールで required_approving_review_count>0 は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 2 } }]),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ルールセット") && e.includes("2"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「review>0=NG」テストが fail（`checkRulesets` 空関数は何も push しないため）。「空配列=OK」は pass。確認後に Step 8 で実装する。

---

#### Step 8: `checkRulesets` の本体を実装して**緑**にする

- [ ] **Step 8: `checkRulesets` の空関数本体を実装で置換し、Step 7 のテストが green になることを確認する**

`src/preflight.ts` の `checkRulesets` 空関数を以下で置換する:

```typescript
async function checkRulesets(
  runner: CommandRunner,
  repoSlug: string,
  branch: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/rules/branches/${branch}`], opts);
    if (isHttp404(r)) return; // ルールセットなし = OK
    if (r.code !== 0) {
      errors.push(`gh: ブランチルールセットを取得できません（${r.stderr.trim()}）`);
      return;
    }
    let rules: Array<{ type?: string; parameters?: { required_approving_review_count?: number } }>;
    try {
      rules = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: ブランチルールセットのJSONを解析できません");
      return;
    }
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      if (rule.type === "pull_request") {
        const count = rule.parameters?.required_approving_review_count ?? 0;
        if (count > 0) {
          errors.push(
            `gh: ブランチ '${branch}' のルールセット pull_request ルールが必須承認レビュー数 ${count} を要求しています。` +
              "ループに人間レビュアーが不在のためマージ不能になります",
          );
        }
      }
    }
  } catch (e) {
    errors.push(`gh: ブランチルールセット確認に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 7 の「review>0=NG」が pass へ転じ、「空配列=OK」も pass のまま（緑）。

---

#### Step 9: gate_label の不合格テストを追加して**赤**を確認する

- [ ] **Step 9: `tests/preflight.test.ts` に §9.5 gate_label テスト（不在=NG / 大小無視で一致=OK）を追加し、赤を確認する**

Step 7 で追加した最後のテストの**後**に追加:

```typescript
  it("gate_label がリポに無ければ NG（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ゲートラベル") && e.includes("loop-pilot"))).toBe(true);
  });

  it("gate_label は大小無視で照合する（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "Loop-Pilot\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ゲートラベル"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「不在=NG」テストが fail（`checkGateLabel` 空関数は何も push しないため）。「大小無視=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 10 で実装する。

---

#### Step 10: `checkGateLabel` の本体を実装して**緑**にする

- [ ] **Step 10: `checkGateLabel` の空関数本体を実装で置換し、Step 9 のテストが green になることを確認する**

`src/preflight.ts` の `checkGateLabel` 空関数を以下で置換する:

```typescript
async function checkGateLabel(
  runner: CommandRunner,
  config: Config,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    // gh label list は既定 limit 30 のため使わない。labels API を --paginate で全件取得し大小無視で照合（カーネル §5.3）。
    const r = await runner.run("gh", ["api", `repos/${repoSlug}/labels`, "--paginate", "--jq", ".[].name"], opts);
    if (r.code !== 0) {
      errors.push(`gh: リポジトリ ${repoSlug} のラベル一覧を取得できません（${r.stderr.trim()}）`);
      return;
    }
    const names = r.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .map((n) => n.toLowerCase());
    const gate = config.looppilot.gateLabel.toLowerCase();
    if (!names.includes(gate)) {
      errors.push(
        `gh: ゲートラベル '${config.looppilot.gateLabel}' がリポジトリ ${repoSlug} に存在しません。` +
          "LoopPilot を発火させるため、対象リポにこのラベルを作成してください",
      );
    }
  } catch (e) {
    errors.push(`gh: ゲートラベル確認に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 9 の「不在=NG」が pass へ転じ、「大小無視=OK」も pass のまま（緑）。

- [ ] **Step 10b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight rulesets + gate_label checks"
```

---

#### Step 11: LOOPPILOT_AUTO_MERGE の不合格テストを追加して**赤**を確認する

- [ ] **Step 11: `tests/preflight.test.ts` に §9.6 テスト（404=OK / "true"(大小無視)=NG）を追加し、赤を確認する**

Step 9 で追加した最後のテストの**後**に追加:

```typescript
  it("LOOPPILOT_AUTO_MERGE variable 404 は OK 判定（仕様 §9.6）", async () => {
    // passingRunner は variable=404 を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toEqual([]);
  });

  it("LOOPPILOT_AUTO_MERGE が 'true'（大小無視）なら NG（仕様 §9.6）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_AUTO_MERGE", value: "TRUE" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE") && e.includes("唯一のマージャー"))).toBe(true);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「'true'=NG」テストが fail（`checkAutoMerge` 空関数は何も push しないため）。「404=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 12 で実装する。

---

#### Step 12: `checkAutoMerge` の本体を実装して**緑**にする

- [ ] **Step 12: `checkAutoMerge` の空関数本体を実装で置換し、Step 11 のテストが green になることを確認する**

`src/preflight.ts` の `checkAutoMerge` 空関数を以下で置換する:

```typescript
async function checkAutoMerge(
  runner: CommandRunner,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const r = await runner.run(
      "gh",
      ["api", `repos/${repoSlug}/actions/variables/LOOPPILOT_AUTO_MERGE`],
      opts,
    );
    if (isHttp404(r)) return; // 未設定 = false = OK
    if (r.code !== 0) {
      errors.push(`gh: Actions 変数 LOOPPILOT_AUTO_MERGE を取得できません（${r.stderr.trim()}）`);
      return;
    }
    let parsed: { value?: string };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      errors.push("gh: LOOPPILOT_AUTO_MERGE のJSONを解析できません");
      return;
    }
    const value = (parsed.value ?? "").trim().toLowerCase();
    if (value === "true") {
      errors.push(
        "gh: Actions 変数 LOOPPILOT_AUTO_MERGE が 'true' です。" +
          "LoopPilot OS が唯一のマージャーであるため false（または未設定）にしてください",
      );
    }
  } catch (e) {
    errors.push(`gh: LOOPPILOT_AUTO_MERGE 確認に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 11 の「'true'=NG」が pass へ転じ、「404=OK」も pass のまま（緑）。

---

#### Step 13: state-comment 著者整合（R ⊆ C）の不合格テストを追加して**赤**を確認する

- [ ] **Step 13: `tests/preflight.test.ts` に §9.9 テスト（404 で config が既定 bot を含む=OK / R ⊄ C=NG / 余分な信頼著者があり R ⊆ C=OK）を追加し、赤を確認する**

Step 11 で追加した最後のテストの**後**に追加:

```typescript
  it("STATE_COMMENT_AUTHORS variable 404 で config が github-actions[bot] を含めば OK（仕様 §9.9）", async () => {
    // passingRunner は variable=404、config は ["github-actions[bot]"] → R ⊆ C 成立。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("state_comment_authors") || e.includes("monitor_never_engaged"))).toEqual([]);
  });

  it("R ⊄ C（リポ writer を config が包含しない）なら NG（仕様 §9.9）", async () => {
    const r = passingRunner();
    // リポは bot-machine も writer に使うが、config は github-actions[bot] のみ → 欠落。
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_STATE_COMMENT_AUTHORS", value: "github-actions[bot], bot-machine" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("bot-machine") && e.includes("monitor_never_engaged"))).toBe(true);
  });

  it("config が R を包含すれば余分な信頼著者があっても OK（R ⊆ C; 仕様 §9.9）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ value: "github-actions[bot]" }),
      stderr: "",
    });
    const cfg = makeConfig({
      looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]", "extra-bot"] },
    });
    const errors = await runPreflight({ config: cfg, runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("monitor_never_engaged"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「R ⊄ C=NG」テストが fail（`checkStateCommentAuthors` 空関数は何も push しないため）。「404 で OK」「R ⊆ C で OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 14 で実装する。

---

#### Step 14: `checkStateCommentAuthors` の本体を実装して**緑**にする

- [ ] **Step 14: `checkStateCommentAuthors` の空関数本体を実装で置換し、Step 13 のテストが green になることを確認する**

`src/preflight.ts` の `checkStateCommentAuthors` 空関数を以下で置換する:

```typescript
async function checkStateCommentAuthors(
  runner: CommandRunner,
  config: Config,
  repoSlug: string,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  const C = config.looppilot.stateCommentAuthors;
  try {
    const r = await runner.run(
      "gh",
      ["api", `repos/${repoSlug}/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS`],
      opts,
    );

    // R = リポが実際に書き手として使う著者集合（= LoopPilot が信頼コメントの著者に使う集合）
    let R: string[];
    if (isHttp404(r)) {
      // 未設定 → リポ既定 writer は github-actions[bot]（state-manager.ts の DEFAULT_TRUSTED_STATE_AUTHOR）
      R = ["github-actions[bot]"];
    } else if (r.code !== 0) {
      errors.push(`gh: Actions 変数 LOOPPILOT_STATE_COMMENT_AUTHORS を取得できません（${r.stderr.trim()}）`);
      return;
    } else {
      let parsed: { value?: string };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        errors.push("gh: LOOPPILOT_STATE_COMMENT_AUTHORS のJSONを解析できません");
        return;
      }
      // LoopPilot と同一パース（カンマ区切り → trim → 空除去）。空なら既定にフォールバック。
      const fromVar = parseAuthors(parsed.value ?? "");
      R = fromVar.length > 0 ? fromVar : ["github-actions[bot]"];
    }

    // R ⊆ C を要求（リポの全 writer を config の信頼集合 C が包含）。
    // 1つでも欠ければ Monitor が信頼コメントを発見できず monitor_never_engaged で全停止する。
    const missing = R.filter((author) => !C.includes(author));
    if (missing.length > 0) {
      errors.push(
        `設定不整合: config.looppilot.state_comment_authors が リポジトリの state-comment 著者 [${missing.join(", ")}] を含みません。` +
          "Monitor が信頼コメントを発見できず monitor_never_engaged で全停止します。" +
          `config.looppilot.state_comment_authors に [${R.join(", ")}] を含めてください`,
      );
    }
  } catch (e) {
    errors.push(`gh: state-comment 著者整合の確認に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 13 の「R ⊄ C=NG」が pass へ転じ、「404 OK」「R ⊆ C OK」も pass のまま（緑）。

- [ ] **Step 14b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight auto-merge off + state-comment author R⊆C checks"
```

---

#### Step 15: Linear 解決の不合格テストを追加して**赤**を確認する

- [ ] **Step 15: `tests/preflight.test.ts` に §9.7 テスト（resolveLinearSetup が throw → NG / 合格 fetch なら Linear 由来エラーなし）を追加し、赤を確認する**

Step 13 で追加した最後のテストの**後**に追加:

```typescript
  it("Linear 解決が失敗すると NG（仕様 §9.7）", async () => {
    // team が見つからない応答 → resolveLinearSetup は throw する契約（task-source.ts）。
    const failFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: "user-1", name: "Viewer" },
          teams: { nodes: [] },
          projects: { nodes: [] },
          issueLabels: { nodes: [] },
        },
      }),
    });
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: failFetch });
    expect(errors.some((e) => e.includes("Linear"))).toBe(true);
  });

  it("Linear 解決が成功すれば Linear 由来エラーなし（仕様 §9.7）", async () => {
    // passingFetch は viewer/team/project/states/label をすべて解決できる応答を返す。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Linear"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「Linear 解決失敗=NG」テストが fail（`checkLinear` 空関数は何も push しないため）。「解決成功=エラーなし」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 16 で実装する。

---

#### Step 16: `checkLinear` の本体を実装して**緑**にする

- [ ] **Step 16: `checkLinear` の空関数本体を実装で置換し、Step 15 のテストが green になることを確認する**

`src/preflight.ts` の `checkLinear` 空関数を以下で置換する。`resolveLinearSetup(apiKey, req, fetchFn)` の **3 引数**契約・`stateNames` のキー写像（config camelCase → TicketState snake）に注意:

```typescript
async function checkLinear(deps: PreflightDeps, errors: string[]): Promise<void> {
  const { config, fetchFn } = deps;
  // config.linear.states は camelCase。resolveLinearSetup の stateNames は TicketState キー。明示写像する。
  const stateNames: Record<TicketState, string> = {
    todo: config.linear.states.todo,
    in_progress: config.linear.states.inProgress,
    in_review: config.linear.states.inReview,
    done: config.linear.states.done,
  };
  const req: LinearSetupRequest = {
    teamKey: config.linear.team,
    projectName: config.linear.project,
    stateNames,
    optInLabel: config.linear.optInLabel,
  };
  try {
    // resolveLinearSetup: viewer 取得（APIキー検証）/ team・project・4状態・opt_in_label の解決。
    // いずれか解決不能なら欠落を 1 回でまとめて throw する契約（task-source.ts）。
    await resolveLinearSetup(config.linearApiKey, req, fetchFn);
  } catch (e) {
    errors.push(`Linear: セットアップ解決に失敗しました（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過（`resolveLinearSetup`/`FetchFn`/`LinearSetupRequest`/`TicketState` の import がここで使用される）。Step 15 の「解決失敗=NG」が pass へ転じ、「解決成功=エラーなし」も pass のまま（緑）。

---

#### Step 17: claude/Slack の不合格テストを追加して**赤**を確認する

- [ ] **Step 17: `tests/preflight.test.ts` に §9.8 claude / §9.10 Slack テスト（claude 非0=NG / Slack 非2xx=NG / Slack 未設定=OK）を追加し、赤を確認する**

Step 15 で追加した最後のテストの**後**に追加:

```typescript
  it("claude が起動できないと NG（仕様 §9.8）", async () => {
    const r = passingRunner();
    r.on(["claude", "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude"))).toBe(true);
  });

  it("Slack Webhook が非2xxなら NG（仕様 §9.10）", async () => {
    const failingNotifier: Notifier = {
      notify: async () => {},
      probeReachability: async () => {
        throw new Error("HTTP 500 from webhook");
      },
    };
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: failingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("Slack") && e.includes("HTTP 500"))).toBe(true);
  });

  it("Slack 未設定（probeReachability 即 resolve）なら Slack 由来エラーなし（仕様 §9.10）", async () => {
    // passingNotifier.probeReachability は即 resolve（未設定相当）。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Slack"))).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待される**赤**: 「claude 非0=NG」「Slack 非2xx=NG」の 2 テストが fail（`checkClaude`/`checkSlack` 空関数は何も push しないため）。「Slack 未設定=OK」は空関数でも pass し、実装後の回帰ガードになる。確認後に Step 18 で実装する。

---

#### Step 18: `checkClaude`/`checkSlack` の本体を実装して**緑**にする

- [ ] **Step 18: `checkClaude`/`checkSlack` の空関数本体を実装で置換し、Step 17 のテストが green になることを確認する**

`src/preflight.ts` の `checkClaude`/`checkSlack` 空関数を以下で置換する:

```typescript
async function checkClaude(
  runner: CommandRunner,
  opts: { cwd: string },
  errors: string[],
): Promise<void> {
  try {
    const ver = await runner.run("claude", ["--version"], opts);
    if (ver.code !== 0) {
      errors.push(`claude: 起動できません（claude にログインしているか確認してください: ${ver.stderr.trim()}）`);
    }
  } catch (e) {
    errors.push(`claude: バージョン確認に失敗しました（${(e as Error).message}）`);
  }
}

async function checkSlack(deps: PreflightDeps, errors: string[]): Promise<void> {
  // 未設定なら probeReachability は即 resolve（notifier.ts / Task 6 契約）。設定済みで非2xx/network なら throw。
  try {
    await deps.notifier.probeReachability();
  } catch (e) {
    errors.push(`Slack: Webhook へ到達できません（${(e as Error).message}）`);
  }
}
```

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: tsc 通過。Step 17 の「claude 非0=NG」「Slack 非2xx=NG」が pass へ転じ、「Slack 未設定=OK」も pass のまま（緑）。

- [ ] **Step 18b: コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "feat: preflight Linear resolve + claude + Slack reachability checks"
```

---

#### Step 19: 全項目合格 → 空配列、を検証して**緑**を固める

- [ ] **Step 19: `tests/preflight.test.ts` に「全項目合格なら空配列」テストを追加し、green を確認する（全チェック実装済みなので追加実装なし）**

> この時点で全 12 チェックが実装済みなので、`passingRunner()`/`passingFetch()`/`passingNotifier` の全合格セットでは `runPreflight` が空配列を返すはず。これは inert スタブによる偽 green ではなく、全チェックの実装が同時に「合格判定」を返すことの統合検証。

Step 17 で追加した最後のテストの**後**に追加:

```typescript
  it("全項目合格なら空配列を返す（仕様 §9）", async () => {
    const errors = await runPreflight({
      config: makeConfig(),
      runner: passingRunner(),
      notifier: passingNotifier,
      fetchFn: passingFetch(),
    });
    expect(errors).toEqual([]);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: 当該テストが pass（全チェック実装済み・統合 green）。万一 1 件でもエラーが出る場合は、`passingRunner`/`passingFetch` の合格応答と各チェックの判定条件の不一致を特定して修正する（テストの合格応答を実装の期待形に合わせる。実装の判定条件は変更しない）。

---

#### Step 20: 複数違反の同時報告（途中 throw せず全件集約）を検証する

- [ ] **Step 20: `tests/preflight.test.ts` に「複数違反を同時に報告する」テストを追加し、green を確認する**

> このテストは「個々のチェックが実装済み」かつ「`runPreflight` が途中 throw せず順次集約する」骨格（Step 3 で確定）の両方を同時に検証する。集約ループは Step 3 で完成しているため追加実装なしで pass する想定。もし fail するなら、それは集約骨格（早期 return / throw 漏れ）のバグであり `runPreflight` 側を修正して緑にする。

Step 19 で追加したテストの**後**に追加:

```typescript
  it("複数違反を同時に報告する（途中 throw せず全件集約; 仕様 §9）", async () => {
    const r = passingRunner();
    // §9.2 ダーティ + §9.4 push 不可 + §9.6 auto-merge true を同時に仕込む
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M x\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ value: "true" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
```

```bash
cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/preflight.test.ts
```

期待: 当該テストが pass（集約骨格は Step 3 で完成済み）。万一 fail する場合は、`runPreflight` の集約ループに早期 return / 未捕捉 throw が混入していないか確認し修正する。

---

#### Step 21: 全テスト green と最終 typecheck を確認してコミットする

- [ ] **Step 21: `npm run check` で tsc(×2)+vitest 全 green を確認し、コミットする**

```bash
cd /home/racoma-dev/loop-pilot-os && npm run check
```

期待: tsc（src）+ tsc（test）+ vitest 全グリーン。`tests/preflight.test.ts` のテスト件数の目安:
- §9.2: feature-x で NG / ダーティで NG（2）
- §9.3: remote 不可で NG（1）
- §9.4: gh 認証なしで NG / push false で NG（2）/ 保護 404 OK / review>0 NG / restrictions 含む OK / restrictions 不在 NG（4）/ rulesets 空 OK / rulesets review>0 NG（2）
- §9.5: gate_label 不在 NG / 大小無視 OK（2）
- §9.6: auto_merge 404 OK / "TRUE" NG（2）
- §9.9: state authors 404 OK / R⊄C NG / R⊆C OK（3）
- §9.7: Linear 失敗 NG / Linear 成功 OK（2）
- §9.8/§9.10: claude 非0 NG / Slack 非2xx NG / Slack 未設定 OK（3）
- 統合: 全合格 空配列（1）/ 複数違反同時報告（1）
= 計 **25 tests passed**。

```bash
cd /home/racoma-dev/loop-pilot-os && git add src/preflight.ts tests/preflight.test.ts && git commit -m "test: preflight all-pass + multi-violation aggregation"
```

---

#### openQuestions（カーネル/他タスクとの照合で確認が必要な点）

1. **`resolveLinearSetup` の解決対象に project の team 帰属チェックは含むか**: カーネル §5.5 は「team key → team、project 名 → projectId」とだけ規定し、Task 7 の `resolveLinearSetup` は workspace 全体の `projects` から名前一致で projectId を解決する（team との帰属は検証しない）。同名 project が複数 team に存在する環境では誤った projectId を解決し得る。プリフライトとしてこの曖昧性を許容するか、Task 7 側で team スコープに絞るべきか要確認（本タスクは Task 7 の実装をそのまま使う前提）。
2. **`gh api .../rules/branches/<branch>` のレスポンス形**: 本計画は `[{ type, parameters }]` 配列を仮定（gh 2.92.0 で確認した一般形）。実環境で `parameters` のキー名（`required_approving_review_count`）が現行 GitHub API と一致するか、ルールセットの間接適用（ruleset 由来の集約レスポンス）で形が変わらないか、実リポでの一度の確認を推奨（カーネル §5.3 はこのキー名を明記しているため計画はそれに従う）。
3. **`config.notify` の型**: config.ts（Task 4）の zod `rawSchema` には `notify: z.object({}).optional()` があるが、camelCase の `Config` 型（task-04-config.md 441-489 行・唯一の定義元）には `notify` フィールドは**存在しない**（rawSchema から Config へは写像されない）。したがって `makeConfig` の base にも `notify` を置かない（置くと strict の excess property check で tsc(test) が赤になる）。本タスクは `notify` を一切参照しないため影響なし。将来 Slack 以外の通知キーが入り `Config` に `notify` が追加された場合のみ追従。
