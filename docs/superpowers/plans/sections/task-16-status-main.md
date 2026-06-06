### Task 16: Status CLI + main 配線

**目的**: (1) `src/status.ts` の `renderStatus(store)` を実装し、最新 Run・活性セッション・直近 10 セッション・未配信通知を人間可読の1文字列に整形する（仕様 §10「status CLI で現在セッション・キュー・履歴・停止箇所を表示」）。(2) `src/main.ts` で CLI エントリ（`run`/`status` 分岐・config 読込・カーネル §7 の DI 組立）を配線し、`run` はプリフライト→orchestrator 起動（`run_started` 通知は orchestrator が内部送出）、`status` は `renderStatus` 出力に繋ぐ。`process.exitCode` 規約（正常0/プリフライト1/HALT 2）と SIGINT（`requestStop` 委譲）を実装する。

**依存タスク**: Task 2（`src/types.ts`: `RunRow` / `TaskSessionRow` / `RunState` / `SessionState` / `FailureReason` / `NotifyEvent`）, Task 3（`src/exec.ts`: `RealCommandRunner`）, Task 4（`src/config.ts`: `loadConfig` / `Config`）, Task 5（`src/store.ts`: `SqliteStore` 全メソッド）, Task 6（`src/notifier.ts`: `ConsoleSlackNotifier`）, Task 7（`src/task-source.ts`: `LinearTaskSource` / `resolveLinearSetup` / `LinearSetupRequest` / `ResolvedLinearSetup`）, Task 8（`src/git-pr.ts`: `GitPrManager`）, Task 9（`src/agent-runner.ts`: `ClaudeAgentRunner`）, Task 10（`src/monitor.ts`: `GhLoopPilotMonitor`）, Task 11（`src/context-bundle.ts`: `buildPrompt`）, Task 12-13（`src/orchestrator.ts`: `Orchestrator` + `requestStop`／回復処理は Task 12-13 に統合、Task 14 ファイルは存在しない）, Task 15（`src/preflight.ts`: `runPreflight` / `PreflightDeps`）。

> **注記（カーネル・依存タスクとの整合）**: 本タスクの単体テスト対象は `src/status.ts` のみ（`tests/status.test.ts`）。`src/main.ts` は配線のみで**単体テスト対象外**（手動 E2E 検証は Task 17）。`renderStatus(store: SqliteStore): string` のシグネチャはカーネル §1（`src/status.ts # renderStatus(store) → string`）と §10 に一致。
>
> `main.ts` が消費する具象構築シグネチャはカーネルが完全には固定していないため、**依存タスクの確定済み export に合わせて**配線する（カーネルに無い構築引数は依存タスクが source of truth）。本タスク執筆時点で各依存セクションから確認済みの実シグネチャ:
> - `loadConfig(configPath: string, env: NodeJS.ProcessEnv): Config`（Task 4）。`Config` は camelCase。`slackWebhookUrl: string | undefined`、`stateDbPath: string`。
> - `new RealCommandRunner()`（引数なし、Task 3）。
> - `new ConsoleSlackNotifier(store: SqliteStore, webhookUrl: string | null, log: (s: string) => void, fetchFn?, sleep?, clock?)`（Task 6）。第2引数は `string | null`（`config.slackWebhookUrl ?? null`）、第3引数は **log**（clock ではない）。
> - `resolveLinearSetup(apiKey: string, req: LinearSetupRequest, fetchFn: FetchFn): Promise<ResolvedLinearSetup>`（Task 7、**位置引数3つ**）。`ResolvedLinearSetup` = `{ viewerId, teamId, projectId, stateIds: Record<TicketState,string>, optInLabelId }`。解決失敗は throw。
> - `new LinearTaskSource({ apiKey, projectId, stateIds, optInLabel, fetchFn })`（Task 7、`LinearTaskSourceOptions`）。
> - `new GitPrManager(runner, { repoPath, remote, defaultBranch, branchPrefix, worktreeRoot, prBodyTemplate, gateLabel })`（Task 8）。
> - `new ClaudeAgentRunner(runner, { model, allowedTools, extraArgs, log })`（Task 9）。
> - `new GhLoopPilotMonitor(runner, { remote, trustedAuthors })`（Task 10）。
> - `new Orchestrator(deps: OrchestratorDeps)` + public `requestStop(): void`（Task 12-13）。`run()` は**内部で** `notifier.notify({ kind: "run_started", ... })` を送る（カーネル §7）ため、main.ts は run_started を**二重送信しない**。
> - `runPreflight(deps: PreflightDeps): Promise<string[]>`（Task 15）。`PreflightDeps = { config, runner, notifier, fetchFn: FetchFn }`（`FetchFn` は Task 7/15 と同一の narrow 型。`globalThis.fetch` は構造的に代入可能）。戻り値は**エラーメッセージ文字列の配列**（空配列=合格）。
>
> 依存タスク間に未解決の不整合（特に `resolveLinearSetup` の引数形と preflight が叩く Linear クエリ shape）があるため、固定できない点は openQuestions に列挙する（勝手に確定しない）。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/status.ts`
- Create: `/home/racoma-dev/loop-pilot-os/src/main.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/status.test.ts`

---

#### Part A — `src/status.ts`（renderStatus）: TDD

- [ ] **Step 1: 失敗するテストファイルを作成する（DB が空/Run 無しの文面）。** `tests/status.test.ts` を以下の内容で新規作成する。最初のテストだけ通る形にせず、`renderStatus` を import するため import エラーで全体が失敗する。

  ```typescript
  import { describe, it, expect } from "vitest";
  import { SqliteStore } from "../src/store.js";
  import { renderStatus } from "../src/status.js";

  // 仕様 §10: status CLI は Run + TaskSession から現在セッション・キュー・履歴・停止箇所を表示。
  // 状態の真実は SQLite。renderStatus は副作用なしで store を読み、人間可読の1文字列を返す。

  function makeStore(): SqliteStore {
    return new SqliteStore(":memory:");
  }

  describe("renderStatus", () => {
    it("Run が一度も作られていなければ no-run の案内を返す（DB はあるが Run 無し）", () => {
      const store = makeStore();
      try {
        const out = renderStatus(store);
        expect(out).toContain("LoopPilot OS status");
        expect(out).toContain("No run found");
        // Run が無いので活性セッション/履歴/通知のセクションは出さない
        expect(out).not.toContain("Active session");
      } finally {
        store.close();
      }
    });
  });
  ```

- [ ] **Step 2: 失敗を確認する。** 次を実行する。

  ```
  npx vitest run tests/status.test.ts
  ```

  期待される失敗: `Failed to resolve import "../src/status.js"`（`src/status.ts` 未作成のため import 解決エラーでスイート全体が fail）。

- [ ] **Step 3: 最小実装で no-run 文面だけ通す。** `src/status.ts` を新規作成し、最新 Run が無い場合の文面だけ返す最小実装を書く。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { RunRow, TaskSessionRow } from "./types.js";

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    return lines.join("\n");
  }
  ```

- [ ] **Step 4: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行し、Step 1 のテストが green になることを確認する（期待: 1 passed）。

- [ ] **Step 5: コミット（red→green の最初の単位）。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus no-run case"
  ```

  `npm run check` 期待出力: tsc×2 と vitest が全て成功（exit 0）。

- [ ] **Step 6: 失敗するテストを追加（最新 Run サマリ: running・上限 vs 着手数・merged 数）。** `tests/status.test.ts` の `describe("renderStatus", ...)` 内に次の `it` を追記する。

  ```typescript
    it("最新 Run の state・開始時刻・タスク上限 vs 着手数・merged 数を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        // 着手 2 件・うち 1 件 merged
        const s1 = store.createSession({
          runId: run.id, linearIssueId: "u1", linearIdentifier: "TY-1",
          issueTitle: "First", branch: "looppilot/ty-1-first",
          worktreePath: "/wt/1", now: "2026-06-05T10:01:00.000Z",
        });
        store.updateSession(s1.id, {
          state: "merged", costUsd: 2.5,
          agentSummary: "did first", endedAt: "2026-06-05T10:05:00.000Z",
        });
        store.createSession({
          runId: run.id, linearIssueId: "u2", linearIdentifier: "TY-2",
          issueTitle: "Second", branch: "looppilot/ty-2-second",
          worktreePath: "/wt/2", now: "2026-06-05T10:06:00.000Z",
        });

        const out = renderStatus(store);
        expect(out).toContain(`Run #${run.id}`);
        expect(out).toContain("state: running");
        expect(out).toContain("started: 2026-06-05T10:00:00.000Z");
        expect(out).toContain("tasks: 2/3 started");   // countTasksStarted / taskCap
        expect(out).toContain("merged: 1");            // countMerged
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 7: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "state: running"` 等。Step 3 実装は `Run #<id>` までしか出さない）。

- [ ] **Step 8: Run サマリを実装する。** `src/status.ts` の Run 表示部を拡張する。`run` が non-null の分岐を以下に置き換える。

  ```typescript
    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }
    return lines.join("\n");
  ```

- [ ] **Step 9: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行し、全テスト green（期待: 2 passed）。

- [ ] **Step 10: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus latest-run summary"
  ```

- [ ] **Step 11: 失敗するテストを追加（halted Run の halt 理由表示）。** `describe` 内に追記する。

  ```typescript
    it("Run が halted のときは halt 理由を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        store.setRunState(run.id, "halted", "task cap reached (3/3)");
        const out = renderStatus(store);
        expect(out).toContain("state: halted");
        expect(out).toContain("halt reason: task cap reached (3/3)");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 12: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（halt 分岐は Step 8 で実装済みのため即 pass。仕様の「停止箇所を表示」を回帰で固定）。一度でも red にしたい場合は Step 8 を分割していないため本ステップは回帰確認として扱い、red を経ずにコミットへ進む。

- [ ] **Step 13: コミット。**

  ```
  npm run check
  git add tests/status.test.ts
  git commit -m "test: renderStatus halt-reason regression"
  ```

- [ ] **Step 14: 失敗するテストを追加（活性セッション詳細: state/identifier/branch/PR/経過）。** `describe` 内に追記する。

  ```typescript
    it("活性セッション（merged/stopped 以外）の state・identifier・branch・PR・経過を表示する", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        const s = store.createSession({
          runId: run.id, linearIssueId: "u9", linearIdentifier: "TY-9",
          issueTitle: "Monitoring task", branch: "looppilot/ty-9-monitoring-task",
          worktreePath: "/wt/9", now: "2026-06-05T10:02:00.000Z",
        });
        store.updateSession(s.id, {
          state: "in_review", prNumber: 42,
          monitorStartedAt: "2026-06-05T10:03:00.000Z",
        });

        const out = renderStatus(store);
        expect(out).toContain("Active session");
        expect(out).toContain("TY-9");
        expect(out).toContain("state: in_review");
        expect(out).toContain("branch: looppilot/ty-9-monitoring-task");
        expect(out).toContain("PR #42");
        // 経過は monitorStartedAt があれば since 起点で表示
        expect(out).toContain("monitoring since 2026-06-05T10:03:00.000Z");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 15: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "Active session"`。未実装）。

- [ ] **Step 16: 活性セッションセクションを実装する。** `src/status.ts` の `return lines.join("\n");`（Run サマリ末尾の return）を削除し、Run サマリの後ろに活性セッションセクションを追加する。具体的には Step 8 で置換した分岐の末尾 `return lines.join("\n");` を、以下のヘルパ呼び出し＋最終 return に差し替える。まずファイル全体を次の完全形へ置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      // 重複可読化: ヘッダ外でも "PR #<n>" を含める（grep 容易化）
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 17: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（4 passed）。`PR #42` は header 行と `(tracking PR #42)` の両方に出るため `toContain("PR #42")` が満たされる。

- [ ] **Step 18: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus active-session detail"
  ```

- [ ] **Step 19: 失敗するテストを追加（直近 10 セッション表: identifier/state/failure_reason/cost）。** `describe` 内に追記する。

  ```typescript
    it("直近 10 セッションを identifier/state/failure_reason/cost の表で出す（新しい順、最大 10 件）", () => {
      const store = makeStore();
      try {
        const run = store.createRun(20, "2026-06-05T09:00:00.000Z");
        // 12 セッション作成。最古 (TY-100) は表から溢れる想定。
        for (let i = 0; i < 12; i++) {
          const n = 100 + i;
          const s = store.createSession({
            runId: run.id, linearIssueId: `u${n}`, linearIdentifier: `TY-${n}`,
            issueTitle: `Task ${n}`, branch: `looppilot/ty-${n}`,
            worktreePath: `/wt/${n}`,
            now: `2026-06-05T09:${String(10 + i).padStart(2, "0")}:00.000Z`,
          });
          if (i === 11) {
            // 最新: stopped(ci_failed) cost 付き
            store.updateSession(s.id, {
              state: "stopped", failureReason: "ci_failed", costUsd: 4.2,
              endedAt: "2026-06-05T09:30:00.000Z",
            });
          } else {
            store.updateSession(s.id, {
              state: "merged", costUsd: 1.0,
              endedAt: `2026-06-05T09:${String(15 + i).padStart(2, "0")}:00.000Z`,
            });
          }
        }

        const out = renderStatus(store);
        expect(out).toContain("Recent sessions");
        // 最新行: identifier / state / failure_reason / cost が全て出る
        expect(out).toContain("TY-111");
        expect(out).toContain("stopped");
        expect(out).toContain("ci_failed");
        expect(out).toContain("$4.20");
        // 11 件目以前 = 表は 10 件のみなので最古 TY-100 は出ない
        expect(out).not.toContain("TY-100");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 20: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "Recent sessions"`。未実装）。

- [ ] **Step 21: 直近セッション表を実装する。** `src/status.ts` の active セクションの後ろ（最終 `return lines.join("\n");` の直前）に、`store.recentSessions(10)` を使った表を追加する。ファイル全体を次の完全形へ置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  function recentRow(s: TaskSessionRow): string {
    const reason = s.failureReason ?? "-";
    return `  ${s.linearIdentifier.padEnd(10)} ${s.state.padEnd(12)} ${reason.padEnd(20)} ${fmtCost(s.costUsd)}`;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    lines.push("");
    const recent = store.recentSessions(10);
    lines.push("Recent sessions (latest 10)");
    if (recent.length === 0) {
      lines.push("  (none)");
    } else {
      lines.push(`  ${"id".padEnd(10)} ${"state".padEnd(12)} ${"failure_reason".padEnd(20)} cost`);
      for (const s of recent) {
        lines.push(recentRow(s));
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 22: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（5 passed）。`recentSessions(10)` が新しい順 10 件を返す前提（カーネル §4 `recentSessions(n)` は status CLI 用）なので `TY-100` は溢れる。

- [ ] **Step 23: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus recent-sessions table"
  ```

- [ ] **Step 24: 失敗するテストを追加（未配信通知の警告）。** `describe` 内に追記する。`recordIntent` の payload は `NotifyEvent` の JSON（カーネル §4 コメント）。

  ```typescript
    it("未配信の通知 intent があれば警告を出し、無ければ警告を出さない", () => {
      const store = makeStore();
      try {
        const run = store.createRun(3, "2026-06-05T10:00:00.000Z");
        void run;
        const payload = JSON.stringify({
          kind: "halted",
          reason: "looppilot_stopped",
          detail: "PR #42 stopped",
        });
        // Slack 設定済み (slackConfigured=true) → delivered_slack=0 のまま未配信
        const intentId = store.recordIntent(payload, true, "2026-06-05T10:10:00.000Z");
        void intentId;

        const out = renderStatus(store);
        expect(out).toContain("WARNING");
        expect(out).toContain("undelivered notification");

        // 配信済みにすると警告は消える
        store.markDelivered(intentId, "console");
        store.markDelivered(intentId, "slack");
        const out2 = renderStatus(store);
        expect(out2).not.toContain("undelivered notification");
      } finally {
        store.close();
      }
    });
  ```

- [ ] **Step 25: 失敗を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待される失敗: 新規 `it` が fail（`expected ... to contain "WARNING"`。未実装）。

- [ ] **Step 26: 未配信通知警告を実装する。** `src/status.ts` の最終 `return lines.join("\n");` の直前に未配信警告ブロックを追加する。`recentRow`/`activeDetail`/`fmtCost` は既存のまま、`renderStatus` 本体の recent セクションの後ろに次を挿入する形でファイル全体を次の完全形に置き換える。

  ```typescript
  import type { SqliteStore } from "./store.js";
  import type { TaskSessionRow } from "./types.js";

  function fmtCost(costUsd: number | null): string {
    return costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`;
  }

  function activeDetail(s: TaskSessionRow): string[] {
    const out: string[] = [];
    out.push(`Active session: ${s.linearIdentifier} — ${s.issueTitle}`);
    out.push(`  state: ${s.state}`);
    out.push(`  branch: ${s.branch}`);
    out.push(`  PR: ${s.prNumber === null ? "(none)" : `#${s.prNumber}`}`);
    if (s.prNumber !== null) {
      out.push(`  (tracking PR #${s.prNumber})`);
    }
    if (s.monitorStartedAt !== null) {
      out.push(`  monitoring since ${s.monitorStartedAt}`);
    } else {
      out.push(`  started: ${s.startedAt}`);
    }
    return out;
  }

  function recentRow(s: TaskSessionRow): string {
    const reason = s.failureReason ?? "-";
    return `  ${s.linearIdentifier.padEnd(10)} ${s.state.padEnd(12)} ${reason.padEnd(20)} ${fmtCost(s.costUsd)}`;
  }

  export function renderStatus(store: SqliteStore): string {
    const lines: string[] = [];
    lines.push("LoopPilot OS status");
    lines.push("===================");

    const run = store.latestRun();
    if (run === null) {
      lines.push("");
      lines.push("No run found. Start the loop with: looppilot-os run");
      return lines.join("\n");
    }

    lines.push("");
    lines.push(`Run #${run.id}`);
    lines.push(`  state: ${run.state}`);
    lines.push(`  started: ${run.startedAt}`);
    lines.push(`  tasks: ${store.countTasksStarted(run.id)}/${run.taskCap} started`);
    lines.push(`  merged: ${store.countMerged(run.id)}`);
    if (run.state === "halted") {
      lines.push(`  halt reason: ${run.haltReason ?? "(none)"}`);
    }

    lines.push("");
    const active = store.activeSessions();
    if (active.length === 0) {
      lines.push("Active session: (none)");
    } else {
      for (const s of active) {
        lines.push(...activeDetail(s));
      }
    }

    lines.push("");
    const recent = store.recentSessions(10);
    lines.push("Recent sessions (latest 10)");
    if (recent.length === 0) {
      lines.push("  (none)");
    } else {
      lines.push(`  ${"id".padEnd(10)} ${"state".padEnd(12)} ${"failure_reason".padEnd(20)} cost`);
      for (const s of recent) {
        lines.push(recentRow(s));
      }
    }

    const undelivered = store.undeliveredIntents();
    if (undelivered.length > 0) {
      lines.push("");
      lines.push(`WARNING: ${undelivered.length} undelivered notification(s):`);
      for (const u of undelivered) {
        lines.push(`  intent #${u.id} (attempts: ${u.attempts}) ${u.payload}`);
      }
    }

    return lines.join("\n");
  }
  ```

- [ ] **Step 27: 成功を確認する。** `npx vitest run tests/status.test.ts` を実行する。期待: green（6 passed）。

- [ ] **Step 28: コミット。**

  ```
  npm run check
  git add src/status.ts tests/status.test.ts
  git commit -m "feat: renderStatus undelivered-notification warning"
  ```

---

#### Part B — `src/main.ts`（CLI 配線・単体テスト対象外）

> 配線のみで単体テスト対象外（手動 E2E は Task 17）。したがって red→green のテスト駆動はせず、`npm run check`（tsc が `main.ts` を型検査する）を緑にしてコミットする。`main.ts` は `src/` 配下なので tsconfig（src のみ）の typecheck 対象になる。コードは完全形で示す。

- [ ] **Step 29: `src/main.ts` を完全形で作成する。** カーネル §1（CLI: `run`/`status`, `--config` 既定 `./looppilot-os.toml`, 引数解析 `node:util` `parseArgs`）, §7（DI: `new Orchestrator({ config, source, agent, git, monitor, notifier, store, buildPrompt, clock, sleep, log })`）, §9（プリフライト→違反列挙して exit 1）に従う。`process.exitCode` 規約: 正常 0 / プリフライト違反 1 / HALT 2。SIGINT は orchestrator の協調停止（`requestStop`）に委譲し、ハンドラ重複登録を防ぐ。

  **配線上の重要点（依存タスク確定シグネチャに一致）**:
  - 各具象は**位置 `runner` + options オブジェクト**で構築する（`GitPrManager` / `ClaudeAgentRunner` / `GhLoopPilotMonitor`）。`LinearTaskSource` は単一 options オブジェクト。
  - Linear 解決 `resolveLinearSetup(apiKey, req, fetchFn)` は**HTTP `fetch` を使う**（`CommandRunner` ではない）。Node 24 ネイティブ `globalThis.fetch` を渡す。
  - `ConsoleSlackNotifier(store, webhookUrl: string | null, log)` — 第2引数は `config.slackWebhookUrl ?? null`、第3引数は **log**（コンソール出力関数）。
  - `runPreflight({ config, runner, notifier, fetchFn })` は**文字列配列**を返す（空＝合格）。`fetchFn` は `globalThis.fetch`。
  - `run_started` 通知は **`orchestrator.run()` が内部で送る**（カーネル §7）。main.ts は二重送信**しない**。
  - `Config.linear.states` は camelCase（`todo`/`inProgress`/`inReview`/`done`）だが、`resolveLinearSetup` の `LinearSetupRequest.stateNames` と `LinearTaskSource` の `stateIds` は `TicketState`（`"todo" | "in_progress" | "in_review" | "done"`）キー。`config` 値から `TicketState` キーの `stateNames` を組み、解決結果 `ResolvedLinearSetup.stateIds`（既に `Record<TicketState,string>`）をそのまま `LinearTaskSource` へ渡す。

  ```typescript
  import { parseArgs } from "node:util";
  import process from "node:process";

  import type { TicketState } from "./types.js";
  import { loadConfig } from "./config.js";
  import { SqliteStore } from "./store.js";
  import { RealCommandRunner } from "./exec.js";
  import { ConsoleSlackNotifier } from "./notifier.js";
  import {
    LinearTaskSource,
    resolveLinearSetup,
    type LinearSetupRequest,
  } from "./task-source.js";
  import { GitPrManager } from "./git-pr.js";
  import { ClaudeAgentRunner } from "./agent-runner.js";
  import { GhLoopPilotMonitor } from "./monitor.js";
  import { buildPrompt } from "./context-bundle.js";
  import { Orchestrator } from "./orchestrator.js";
  import { runPreflight } from "./preflight.js";
  import { renderStatus } from "./status.js";

  const EXIT_OK = 0;
  const EXIT_PREFLIGHT = 1;
  const EXIT_HALTED = 2;

  function nowIso(): string {
    return new Date().toISOString();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function logLine(line: string): void {
    process.stdout.write(line + "\n");
  }

  function parseCli(argv: string[]): { command: string; configPath: string } {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", default: "./looppilot-os.toml" },
      },
    });
    const command = positionals[0] ?? "";
    return { command, configPath: values.config as string };
  }

  async function runStatus(configPath: string): Promise<number> {
    const config = loadConfig(configPath, process.env);
    const store = new SqliteStore(config.stateDbPath);
    try {
      process.stdout.write(renderStatus(store) + "\n");
      return EXIT_OK;
    } finally {
      store.close();
    }
  }

  async function runLoop(configPath: string): Promise<number> {
    const config = loadConfig(configPath, process.env);
    const store = new SqliteStore(config.stateDbPath);
    try {
      const runner = new RealCommandRunner();
      const notifier = new ConsoleSlackNotifier(
        store,
        config.slackWebhookUrl ?? null,
        logLine,
      );

      // プリフライト: 違反を全件収集 → 列挙して exit 1（仕様 §8 / カーネル §9）。
      // fetchFn は Node 24 ネイティブ fetch。Linear 解決もこの中で fetch を使う。
      const preflightErrors = await runPreflight({
        config,
        runner,
        notifier,
        fetchFn: globalThis.fetch,
      });
      if (preflightErrors.length > 0) {
        process.stderr.write("Preflight failed:\n");
        for (const message of preflightErrors) {
          process.stderr.write(`  - ${message}\n`);
        }
        return EXIT_PREFLIGHT;
      }

      // Linear の team/project/4状態/オプトインラベルを ID へ解決。
      // config の camelCase 状態名 → TicketState キーへ写像して渡す。
      const stateNames: Record<TicketState, string> = {
        todo: config.linear.states.todo,
        in_progress: config.linear.states.inProgress,
        in_review: config.linear.states.inReview,
        done: config.linear.states.done,
      };
      const setupRequest: LinearSetupRequest = {
        teamKey: config.linear.team,
        projectName: config.linear.project,
        stateNames,
        optInLabel: config.linear.optInLabel,
      };
      const linearSetup = await resolveLinearSetup(
        config.linearApiKey,
        setupRequest,
        globalThis.fetch,
      );

      const source = new LinearTaskSource({
        apiKey: config.linearApiKey,
        projectId: linearSetup.projectId,
        stateIds: linearSetup.stateIds,
        optInLabel: config.linear.optInLabel,
        fetchFn: globalThis.fetch,
      });
      const agent = new ClaudeAgentRunner(runner, {
        model: config.agent.model,
        allowedTools: config.agent.allowedTools,
        extraArgs: config.agent.extraArgs,
        log: logLine,
      });
      const git = new GitPrManager(runner, {
        repoPath: config.repo.path,
        remote: config.repo.remote,
        defaultBranch: config.repo.defaultBranch,
        branchPrefix: config.handoff.branchPrefix,
        worktreeRoot: config.repo.worktreeRoot,
        prBodyTemplate: config.handoff.prBodyTemplate,
        gateLabel: config.looppilot.gateLabel,
      });
      const monitor = new GhLoopPilotMonitor(runner, {
        remote: config.repo.remote,
        trustedAuthors: config.looppilot.stateCommentAuthors,
      });

      const orchestrator = new Orchestrator({
        config,
        source,
        agent,
        git,
        monitor,
        notifier,
        store,
        buildPrompt,
        clock: nowIso,
        sleep,
        log: logLine,
      });

      // SIGINT → orchestrator.requestStop()（次の安全点でクリーン halt）。
      // run_started 通知は orchestrator.run() が内部で送る（カーネル §7）。
      let interrupted = false;
      const onSigint = (): void => {
        if (interrupted) return;
        interrupted = true;
        process.stderr.write(
          "\nSIGINT received: stopping at next safe point...\n",
        );
        orchestrator.requestStop();
      };
      process.on("SIGINT", onSigint);

      try {
        await orchestrator.run();
      } finally {
        process.removeListener("SIGINT", onSigint);
      }

      // HALT 終端なら exit 2、それ以外（idle で綺麗に止まった等）は 0。
      const finalRun = store.latestRun();
      return finalRun !== null && finalRun.state === "halted"
        ? EXIT_HALTED
        : EXIT_OK;
    } finally {
      store.close();
    }
  }

  async function main(): Promise<void> {
    const { command, configPath } = parseCli(process.argv.slice(2));
    switch (command) {
      case "run":
        process.exitCode = await runLoop(configPath);
        return;
      case "status":
        process.exitCode = await runStatus(configPath);
        return;
      default:
        process.stderr.write(
          "Usage: looppilot-os <run|status> [--config <path>]\n",
        );
        process.exitCode = EXIT_PREFLIGHT;
    }
  }

  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exitCode = EXIT_PREFLIGHT;
  });
  ```

- [ ] **Step 30: 型検査を通す。** 次を実行する。

  ```
  npm run check
  ```

  期待出力: tsc（src）・tsc（tsconfig.test.json）・vitest が全て成功（exit 0）。本ステップのコードは執筆時点で確認済みの依存タスク export（Task 3/4/6/7/8/9/10/12-13/15）と一致させてある。**もし** `RealCommandRunner` / `resolveLinearSetup` / `LinearTaskSource` / `ConsoleSlackNotifier` / `GitPrManager` / `ClaudeAgentRunner` / `GhLoopPilotMonitor` / `runPreflight` / `requestStop` のいずれかが依存タスク実装と不一致で型エラーが出た場合は、ここで**勝手にシグネチャを変えず**、不一致内容を Task 16 の openQuestions として記録し、依存タスク側の確定 export に合わせて本ステップのコードのみを修正する（カーネルが固定していない構築シグネチャはカーネルではなく依存タスクの export が source of truth）。
  - 整合確認（解消済み）: Task 15（preflight）の `checkLinear`（task-15 Step 16）は `await resolveLinearSetup(config.linearApiKey, req, fetchFn)`（位置引数3つ）で呼んでおり、Task 7（task-source）の export `resolveLinearSetup(apiKey, req, fetchFn)` と整合している。本 main.ts も同じ **Task 7 の3引数形**に合わせており、Task 7・15・16 は同時にコンパイル可能（不整合なし）。

- [ ] **Step 31: コミット。**

  ```
  git add src/main.ts
  git commit -m "feat: main CLI wiring (run/status, DI, preflight, SIGINT)"
  ```

- [ ] **Step 32: 章全体の最終確認。** `npm run check` を最後にもう一度実行し、`src/status.ts` / `src/main.ts` / `tests/status.test.ts` 込みで全 green（exit 0）であることを確認する。`tests/status.test.ts` は 6 passed。`git status` がクリーンであることを確認する。
