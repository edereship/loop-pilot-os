### Task 14: クラッシュ回復

**目的**: Task 12 が空実装（no-op）として置いた `Orchestrator.recoverPendingSessions()` の中身を実装し、カーネル §8（仕様 §9）の起動時クラッシュ回復を網羅する。再起動時に `store.activeSessions()`（merged/stopped 以外・全 run 横断）を走査し、`in_review`+PR は `monitor.poll` の verdict で分岐、`claimed`/`implementing`/`handing_off` は `findOpenPrForBranch` の有無で採用 or HALT、孤児チケットは Todo へベストエフォート復帰する。採用したセッションは新 Run へ runId を付替えて MONITOR→DONE を回し、tasks_started に数えられ上限と比較される。回復で HALT したらループに入らない。

**依存タスク**:
- Task 12（`src/orchestrator.ts` の `Orchestrator`・`OrchestratorDeps`・`loop`/`claim`/`implement`/`handoff`/`monitorSession`/`tryMerge`/`done`/`stopSession`/`elapsedMinutesSinceMonitorStart`、private `recoverPendingSessions()` の no-op 定義、module-private `errMsg`/`bestEffort`/`retry`、`RunControl`/`CONTINUE`/`HALT`。`tests/fakes.ts` の `FakeTaskSource`/`FakeAgentRunner`/`FakeGitPr`/`FakeMonitor`/`FakeNotifier`、`tests/orchestrator.test.ts` の `makeConfig`/`issue`/`makeHarness`/`Harness`）。本タスクは **`recoverPendingSessions()` を Modify（no-op → 実装）し、ヘルパを追記**する。`Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness` は再定義しない。
- Task 13（`src/orchestrator.ts` の `tryMerge` 判別共用体化・`mergeFailures` fail-closed・`requestStop`/`interrupted`/`haltForInterrupt`。本タスクは Task 12+13 適用後のコードを Modify する）。
- Task 2（`src/types.ts`：`MonitorVerdict`・`TaskSessionRow`・`EligibleIssue`・`FailureReason`・`NotifyEvent`）
- Task 5（`src/store.ts`：`SqliteStore`。`activeSessions`/`getSession`/`updateSession`（`runId`/`monitorStartedAt`/`prNumber`/`state` patch 可）/`knownIssueIds`/`createRun`/`createSession`/`sessionsForRun`/`countTasksStarted`/`countMerged`/`setRunState`）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/orchestrator.ts`: `Orchestrator`, `OrchestratorDeps`, private `monitorSession(session, prNumber)`, private `done(session, issue)`, private `stopSession(session, reason, detail, extraPatch)`, private `recoverPendingSessions()`（no-op）, 型 `RunControl`, 定数 `CONTINUE`/`HALT`, module-private `errMsg`（Task 12）
- `src/types.ts`: `MonitorVerdict`, `TaskSessionRow`, `EligibleIssue`, `FailureReason`, `NotifyEvent`（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/config.ts`: `Config`（型のみ。テストは `makeConfig` の `as unknown as Config` キャスト）
- `tests/fakes.ts`: `FakeTaskSource`（`orphans`/`transitions`/`failNext`）, `FakeGitPr`（`openPrForBranch`/`claimResults`/`calls`/`failNext`）, `FakeMonitor`（`verdicts`/`readiness`/`pollCalls`）, `FakeNotifier`（`events`）, `FakeAgentRunner`, `fixedClock`, `instantSleep`（Task 3/12）
- `tests/orchestrator.test.ts`: `makeConfig`, `issue`, `makeHarness`, `Harness`（Task 12）。本タスクのテストは新規ファイル `tests/recovery.test.ts` で、これらを **import せず再定義する**（独立ファイルのため。テスト用ヘルパの重複定義は許容）。

> 注: 本タスクが触る Config フィールドは Task 12/13 と同一（`safety.maxTasksPerRun`/`safety.maxCostUsdPerSession`/`safety.notEngagedGuardMinutes`/`safety.monitorTimeoutMinutes`/`loop.monitorPollSeconds`/`loop.idleRecheckSeconds`/`looppilot.gateLabel`/`product.goal`/`digest.recentMergedCount`）。新フィールドは追加しない。

---

#### このセクションが確定させる回復処理の形（実装の正・カーネル §8）

Task 12 の `run()` は `acquireRunLock → createRun → notify(run_started) → recoverPendingSessions() → loop()` の順で呼ぶ。本タスクは `recoverPendingSessions()` を実装し、**回復で HALT したら `loop()` を呼ばない**ように `run()` を 1 箇所だけ変更する。

`recoverPendingSessions()` の契約（戻り値 `RunControl`：`{control:"halt"}` なら `run()` はループを開始しない）:

1. **孤児チケット復帰を先に行う**（カーネル §8 末尾。セッション走査の前後どちらでもよいが、走査で HALT する前に孤児を Todo へ戻すと取りこぼしが無いので**先頭で実施**）: `source.findOrphanedInProgress(store.knownIssueIds())` → 各 issue を `source.transition(todo)` ベストエフォート + コンソール警告ログ。`findOrphanedInProgress` 自体の throw もベストエフォート（警告して継続）。

2. **`store.activeSessions()` を走査**（merged/stopped 以外・全 run 横断・id ASC）。各セッション `s` を state で分岐:

   - **`in_review` ∧ `prNumber != null`**: `monitor.poll(s.prNumber)` の verdict で分岐（生 gh は使わず注入済み monitor で照合）:
     - `merged` → **DONE 後段**（`s` の runId を新 Run へ付替え → `done(...)` 相当：`updateSession({state:"merged", endedAt})` → `transition(done)` best-effort）。カウンタは導出なので二重計上しない。**HALT しない**（merged は成功終端）。
     - `pr_closed` → `stopSession(s, "pr_closed", null)` → HALT。
     - `stopped` → `stopSession(s, "looppilot_stopped", stopReason ?? "looppilot stopped (no reason)")` → HALT。
     - **それ以外**（`done`/`in_progress`/`corrupted`/`not_engaged` = open 扱い）→ **採用**：runId を新 Run へ付替え（`updateSession(s.id, { runId: this.runId })`）→ `monitorSession(s, s.prNumber)` を即時実行（MONITOR 再開）。`monitor_started_at` は**上書きしない**（ガード/timeout の経過を継続）。MONITOR が halt を返したら回復全体を HALT。merged まで進んだら DONE 後段（`done`）を実行。
   - **`in_review` ∧ `prNumber == null`**（PR 永続化前に in_review にした異常／理論上起きにくい）: `claimed`/`implementing`/`handing_off` と同じ「open PR 探索」経路へフォールバック（後述）。
   - **`claimed` / `implementing` / `handing_off`**: `findOpenPrForBranch(s.branch)`:
     - ヒット（`prNumber != null`）→ `updateSession(s.id, { runId: this.runId, prNumber, state:"in_review", monitorStartedAt: s.monitorStartedAt ?? this.clock() })` → 採用・`monitorSession(...)`→merged で `done`。
     - ミス（`null`）→ `stopSession(s, "exception", "crash recovery: no open PR; manual cleanup: <branch>, <worktree>, <identifier>")` → notify(halted)（`stopSession` が出す）→ **HALT**（手動掃除を促す）。

3. **採用セッションは tasks_started に数えられる**：runId を新 Run に付替えるため `countTasksStarted(newRunId)` が +1 され、`loop()` のタスク上限チェックの比較対象になる。

4. **回復で 1 つでも HALT に至ったら `{control:"halt"}` を返す**（以降の active セッションは処理しない）。全て成功裏に採用/完走したら `{control:"continue"}`。

回復は `monitorSession`/`done`/`stopSession` を**再利用**する（重複実装しない）。`monitorSession`/`stopSession` は `session.id` で store を読み直す（`elapsedMinutesSinceMonitorStart` も `getSession(id)` 由来）ため、runId 付替え後の最新行で正しく動く。`done(session, issue)` は `issue.id`（transition）と `issue.identifier`（ログ）しか使わないので、回復ではセッション行から最小 `EligibleIssue` を再構成して渡す（`reconstructIssue(s)` ヘルパ）。

---

#### Files

- **Modify**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`（`recoverPendingSessions()` の no-op → 実装、private ヘルパ `recoverInReview`/`recoverByOpenPr`/`adoptAndMonitor`/`recoverDone`/`reconstructIssue` を追記、`run()` の `recoverPendingSessions()` 呼び出しを「halt なら return」に変更）
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/recovery.test.ts`（新規）

---

#### Step-by-step（TDD）

- [ ] **Step 1: `tests/recovery.test.ts` を新規作成し、最初の失敗するテスト（in_review+PR が merged → DONE 後段・二重計上なし）を書く**

`tests/recovery.test.ts` を新規作成する（この時点で `recoverPendingSessions()` は no-op なので、回復が何もせず active セッションを放置 → アサーションが落ちて red）。テスト用ヘルパ（`makeConfig`/`issue`/`makeHarness`）は独立ファイルのため本ファイル内に再定義する（完全形）:

```typescript
import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, TaskSessionRow } from "../src/types.js";

// ---- テストヘルパ（Task 12 の makeConfig/issue/makeHarness と同形・独立ファイルのため再定義） ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number | undefined;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product" },
    digest: { recentMergedCount: over.recentMergedCount ?? 5 },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
  } as unknown as Config;
}

function issue(id: string, identifier: string, over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id,
    identifier,
    title: over.title ?? `Title for ${identifier}`,
    description: over.description ?? "",
    priority: over.priority ?? 2,
    sortOrder: over.sortOrder ?? 0,
    url: over.url ?? `https://linear.app/issue/${identifier}`,
  };
}

interface Harness {
  orch: Orchestrator;
  store: SqliteStore;
  source: FakeTaskSource;
  agent: FakeAgentRunner;
  git: FakeGitPr;
  monitor: FakeMonitor;
  notifier: FakeNotifier;
  sleepCalls: number[];
  logs: string[];
  promptArgs: PromptArgs[];
}

function makeHarness(config: Config): Harness {
  const store = new SqliteStore(":memory:");
  const source = new FakeTaskSource();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const monitor = new FakeMonitor();
  const notifier = new FakeNotifier();
  const sleepInner = instantSleep();
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    await sleepInner(ms);
  };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const promptArgs: PromptArgs[] = [];
  const buildPrompt = (args: PromptArgs): string => {
    promptArgs.push(args);
    return `PROMPT for ${args.issue.identifier}`;
  };
  const orch = new Orchestrator({
    config,
    source,
    agent,
    git,
    monitor,
    notifier,
    store,
    buildPrompt,
    clock: fixedClock("2026-06-05T00:00:00.000Z"),
    sleep,
    log,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs };
}

/**
 * 前回 Run のクラッシュ状態を仕込むヘルパ。
 * 旧 Run を作り、その下に active セッション 1 行を作って指定 state へ進める。
 * 返り値は仕込んだセッション行（最新値）。
 */
function seedCrashedSession(
  store: SqliteStore,
  patch: Partial<TaskSessionRow> & { state: TaskSessionRow["state"] },
  over: Partial<{ linearIssueId: string; linearIdentifier: string; branch: string; worktreePath: string }> = {},
): TaskSessionRow {
  const oldRun = store.createRun(3, "2026-06-04T00:00:00.000Z");
  const s = store.createSession({
    runId: oldRun.id,
    linearIssueId: over.linearIssueId ?? "issue-A",
    linearIdentifier: over.linearIdentifier ?? "TY-1",
    issueTitle: "Crashed task",
    branch: over.branch ?? "looppilot/ty-1-x",
    worktreePath: over.worktreePath ?? "/wt/ty-1",
    now: "2026-06-04T00:00:01.000Z",
  });
  store.updateSession(s.id, patch);
  return store.getSession(s.id);
}

describe("回復 — in_review + PR が merged（仕様 §9 / カーネル §8: DONE 後段・二重計上なし）", () => {
  it("再起動時 in_review+PR で monitor.poll が merged → merged 永続化 + transition(done)・新 Run の merged_count=1", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 前回クラッシュ: in_review・PR #100・監視起点あり
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 起動後キューは空（回復のみで完結、その後 IDLE→…だが taskCap で止める設計確認のため queue 空）
    h.source.queue = [];
    // 回復で poll は 1 回呼ばれ merged を返す
    h.monitor.verdicts = [{ kind: "merged" }];
    // 回復後ループで getNextEligible は null → IDLE → だが taskCap=3 未到達で sleep ループに入る。
    // それを避けるため回復完了直後にループへ入らせない: queue 空 + idle を 1 回で抜けられないので、
    // ここでは「回復処理単体の効果」を検証するため、回復後ループに入る前提で merged を確認する。
    // ループ無限化を防ぐため getNextEligible を 1 回 null 後に requestStop で抜ける。
    let getCalls = 0;
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      getCalls += 1;
      h.orch.requestStop(); // 回復後ループの最初の安全点で停止
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 回復で採用された旧セッションは新 Run へ付替えられ merged になっている
    const adopted = h.store.getSession(crashed.id);
    expect(adopted.state).toBe("merged");
    expect(adopted.runId).toBe(newRun.id);
    expect(adopted.endedAt).not.toBeNull();
    // DONE 後段: transition(done) が呼ばれた
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // 二重計上なし: 新 Run の merged_count は導出で 1
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // tasks_started も 1（runId 付替えで新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // 回復で HALT していない（merged は成功終端）→ ループに入っている
    expect(getCalls).toBeGreaterThanOrEqual(1);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待される失敗: `recoverPendingSessions()` が no-op のため旧セッションが `in_review` のまま残り、`adopted.state` が `"in_review"`（≠ `"merged"`）/ `countMerged(newRun.id)` が `0` で落ちる。

- [ ] **Step 2: `recoverPendingSessions()` を「ディスパッチ骨格 + in_review merged 分岐のみ」実装して Step 1 を green にする（コード変更）**

> TDD 原則（カーネル §11: テスト→失敗確認→実装→成功確認）に従い、**Step 1 の red を倒すのに必要な分岐だけ**を実装する。他の分岐（pr_closed / stopped / open 採用 / open PR ヒット・ミス / 孤児復帰の追加挙動）はこの時点では実装せず、各々の **失敗テストを先に書いた後**（Step 5/6/8/9/11/12/13）で増分実装する。未実装分岐は明示的に throw させ、テスト不在のまま「動いてしまう」状態を作らない。

`src/orchestrator.ts` の Task 12 の no-op 実装:

```typescript
  /**
   * 起動時回復（仕様 §9）。
   * 本タスク（Task 12）では活性セッション無しを前提に素通しする空実装。
   * 中身（in_review 再開 / crash 回復 / 孤児チケット復帰）は Task 14 で実装する。
   */
  private async recoverPendingSessions(): Promise<void> {
    // Task 14 で実装。現状は no-op（活性セッション無し前提）。
  }
```

を次に置き換える（**この Step では in_review merged 分岐 + ディスパッチ骨格のみ**。他分岐は後続 Step で失敗テスト先行のうえ増分実装する）:

```typescript
  /**
   * 起動時回復（仕様 §9 / カーネル §8）。
   * 1) 孤児チケット（In Progress だがセッション行なし）を Todo へベストエフォート復帰。
   * 2) activeSessions()（merged/stopped 以外・全 run 横断）を走査し state ごとに分岐:
   *    - in_review+PR: monitor.poll の verdict で merged→DONE後段 / pr_closed・stopped→停止 / その他→採用しMONITOR再開。
   *    - claimed/implementing/handing_off: findOpenPrForBranch ヒット→採用、ミス→stopped(exception)+HALT。
   * いずれかの経路が HALT に至ったら { control: "halt" } を返し、run() はループを開始しない。
   * 採用セッションは runId を新 Run へ付替えるので countTasksStarted に数えられ、上限と比較される。
   *
   * 注: 本 Step では in_review merged 分岐のみ実装。他分岐は後続 Step で失敗テスト先行で増やす。
   */
  private async recoverPendingSessions(): Promise<RunControl> {
    // 1) 孤児チケット復帰: Step 11 で失敗テスト先行のうえ実装する。現状は何もしない。

    // 2) 活性セッションの照合・採用/停止
    for (const session of this.store.activeSessions()) {
      let ctrl: RunControl;
      if (session.state === "in_review" && session.prNumber !== null) {
        ctrl = await this.recoverInReview(session, session.prNumber);
      } else {
        ctrl = await this.recoverByOpenPr(session);
      }
      if (ctrl.control === "halt") return HALT;
    }
    return CONTINUE;
  }

  /** in_review + PR の回復（カーネル §8）。poll の verdict で分岐する。 */
  private async recoverInReview(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    const verdict: MonitorVerdict = await this.monitor.poll(prNumber);
    switch (verdict.kind) {
      case "merged":
        // DONE 後段（merged 永続化 → transition(done)）。二重計上なし（導出）。HALT しない。
        this.store.updateSession(session.id, { runId: this.runId });
        await this.recoverDone(session);
        return CONTINUE;
      default:
        // pr_closed / stopped / open 扱い（done・in_progress・corrupted・not_engaged）/ poll throw は
        // それぞれ Step 5/6 で失敗テスト先行のうえ実装する。未実装の今は明示的に未対応で停止させる。
        throw new Error(`recoverInReview: verdict "${verdict.kind}" not yet implemented`);
    }
  }

  /** claimed/implementing/handing_off（および PR 番号欠落 in_review）の回復（カーネル §8）。 */
  private async recoverByOpenPr(session: TaskSessionRow): Promise<RunControl> {
    // ヒット（採用）は Step 8、ミス（stopped(exception)+HALT）は Step 9 で失敗テスト先行で実装する。
    throw new Error(`recoverByOpenPr: not yet implemented (session ${session.id})`);
  }

  /** 回復経路の DONE 後段。セッション行から最小 issue を再構成して done() を再利用する。 */
  private async recoverDone(session: TaskSessionRow): Promise<void> {
    await this.done(session, reconstructIssue(session));
  }
```

> 補足: `recoverInReview` の `switch` はこの Step では `merged` と `default` のみ。MonitorVerdict の網羅（exhaustiveness）チェックは、後続 Step で全 kind の `case` を追加し `default` を削除した時点で tsc により保証される（Step 4 では `default` があるため網羅チェックは効かない）。`adoptAndMonitor` は Step 6 で初めて必要になるため、この Step では定義しない。

実行して Step 1 の green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待: green。落ちたら `recoverInReview` の `merged` 分岐（runId 付替え → `recoverDone` → `done` が `transition(done)` を呼ぶ）と `countMerged`/`countTasksStarted` が新 runId で導出されることを確認する。

加えて、`recoverInReview` が使う型 `MonitorVerdict` を import に追加する。Task 12 の import 文:

```typescript
import type {
  TaskSource,
  AgentRunner,
  GitPrManager,
  LoopPilotMonitor,
  Notifier,
  EligibleIssue,
  TaskSessionRow,
  FailureReason,
  AgentOutcome,
  MonitorVerdict,
  PromptArgs,
} from "./types.js";
```

には `MonitorVerdict` が既に含まれている（Task 12 で import 済み）。`EligibleIssue` も含まれている。**import の変更は不要**。

最後に module-private ヘルパ `reconstructIssue` を `src/orchestrator.ts` の末尾（他の module-private helper `errMsg`/`bestEffort`/`retry` の並び）に追記する:

```typescript
/**
 * 回復経路で done()/buildPrompt に渡す最小 EligibleIssue をセッション行から再構成する。
 * done() は issue.id（transition）と issue.identifier（ログ）しか使わないため、
 * title 等は記録済みの値で埋め、未保持フィールドは安全な既定で埋める。
 */
function reconstructIssue(session: TaskSessionRow): EligibleIssue {
  return {
    id: session.linearIssueId,
    identifier: session.linearIdentifier,
    title: session.issueTitle,
    description: "",
    priority: 0,
    sortOrder: 0,
    url: "",
  };
}
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が merged"
```

期待: green。落ちたら `recoverInReview` の `merged` 分岐（runId 付替え → `recoverDone` → `done` が `transition(done)` を呼ぶ）と `countMerged`/`countTasksStarted` が新 runId で導出されることを確認する。

- [ ] **Step 3: `run()` を「回復が halt なら loop に入らない」に変更する（コード変更）**

Task 12 の `run()` の本体:

```typescript
      await this.recoverPendingSessions();
      await this.loop();
```

を次に置き換える（回復で HALT したらループを開始しない。カーネル §8 末尾）:

```typescript
      const recovery = await this.recoverPendingSessions();
      if (recovery.control === "continue") {
        await this.loop();
      }
```

> 注: `recoverPendingSessions()` が HALT を返すと、`stopSession`/`stopForRecovery` 内で既に `setRunState(halted)` + `notify(halted)` 済み。`run()` の `finally` がロックを解放する。`loop()` を呼ばないので新規 SELECT/CLAIM は起きない。

実行して既存テストへ波及がないことを確認する:

```
npx vitest run tests/recovery.test.ts
```

期待: Step 1 のテストは引き続き green（merged は continue 経路なのでループに入る）。

- [ ] **Step 4: `npm run check`（型・全テスト）green を確認してコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`recoverPendingSessions()` の戻り値型が `Promise<RunControl>` に変わり、`run()` がそれを分岐するため tsc が網羅を保証する。

> 注: この時点では `recoverInReview` の switch は `merged` + `default` のみで、`MonitorVerdict` の全 kind 網羅（exhaustiveness）はまだ効いていない（`default` が残るため）。`pr_closed`/`stopped`/open 扱いの各 `case` は後続 Step（5/6）で失敗テスト先行で追加し、最終的に `default` を削除して tsc の exhaustiveness を効かせる（Step 14 の最終 `npm run check` で全 kind 網羅を保証）。`recoverByOpenPr` はまだ throw のみ（呼ばれる経路＝Step 8/9 の seed はこの時点では存在しないため Step 1 の green を妨げない）。

```
git add src/orchestrator.ts tests/recovery.test.ts
git commit -m "feat: crash recovery — in_review+PR merged branch (Task 14)"
```

- [ ] **Step 5: in_review+PR の pr_closed / stopped(stopReason) 分岐のテストを先に書いて red 確認 → 実装で green（テスト→失敗確認→実装→成功確認）**

まず失敗テストを追記する。この時点で `recoverInReview` は `merged` 分岐しか持たず、`pr_closed`/`stopped` verdict は `default` で `throw new Error('recoverInReview: verdict "pr_closed" not yet implemented')`（resp. `"stopped"`）になる。Step 3 の `run()` は recovery 呼び出しを try/catch で包まないので throw は伝播し `run()` が reject する（=テストの `await h.orch.run()` が reject して red）。仮に上位で握り潰す実装になっていても、各テストの「セッションが `in_review` のまま・`failureReason` が `null`・期待した `stopped` 状態に達していない」アサーションで必ず red になる。

`tests/recovery.test.ts` に describe を追記する:

```typescript
describe("回復 — in_review + PR が停止系 verdict（仕様 §9 / カーネル §8）", () => {
  it("poll が pr_closed → stopped(pr_closed) + Run=halted、ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Z", "TY-9")]; // 回復で HALT すれば SELECT には進まない
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.runId).toBe(newRun.id);
    // Run=halted・回復で停止したのでループに入らず getNextEligible は呼ばれない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "pr_closed" });
  });

  it("poll が stopped(stopReason='codex gave up') → stopped(looppilot_stopped, detail=stopReason) + HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });

  it("poll が stopped(stopReason=null) → detail は既定文言へ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が停止系 verdict"
```

期待される失敗: `recoverInReview` の `default` が `throw new Error('recoverInReview: verdict "pr_closed" not yet implemented')`（resp. `"stopped"`）を投げ、`run()` がそれを伝播して 3 ケースとも reject／または握り潰し設計なら「`s.state` が `in_review` のまま・`failureReason` が `null`・Run が `halted` でない」で落ちる。これで pr_closed/stopped の挙動が**未実装であること**を red で確認する。

次に `recoverInReview` の `switch` に `pr_closed` / `stopped` の `case` を追加する（`merged` と `default` の間に挿入。`default` はまだ残す＝open 扱いは Step 6 で実装する）:

```typescript
      case "pr_closed":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(session, "pr_closed", null);
      case "stopped":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "in_review \+ PR が停止系 verdict"
```

期待: 全 green。落ちたら `pr_closed`/`stopped` 分岐が `stopSession`（HALT を返す）を呼ぶこと、`run()` が HALT で `loop()` を呼ばない（`eligibleCalls` 0）ことを確認する。

- [ ] **Step 6: in_review+PR が open 扱い（done/in_progress/corrupted/not_engaged）→ 採用して MONITOR 再開のテストを先に書いて red 確認 → 実装で green**

`tests/recovery.test.ts` に describe を追記。回復の poll が open verdict を返したら採用し、続く `monitorSession` のループ poll で完走する。`FakeMonitor` は要素 >1 で shift・=1 で同じものを返すので、verdict 列を `[done, merged]` 等で組む:

```typescript
describe("回復 — in_review + PR が open 扱い → 採用して MONITOR 再開（仕様 §9 / カーネル §8）", () => {
  it("poll が in_progress → done → merged で完走し、monitorStartedAt は上書きされない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:10:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: originalStart,
    });
    // 回復 poll(in_progress) で採用 → monitorSession の poll で done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];
    // 回復後ループに入るので 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // 採用 → MONITOR 再開 → merged
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(newRun.id);
    // 監視起点は上書きされない（ガード/timeout の経過継続。カーネル §8）
    expect(s.monitorStartedAt).toBe(originalStart);
    // DONE 後段 transition(done)
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // merge が呼ばれた（done→ready→merge）
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
    // tasks_started=1（採用で新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
  });

  it("poll が corrupted（open 扱いで採用）→ 続く poll が即 corrupted を維持 → MONITOR が即 stopped(monitor_never_engaged) で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 回復 poll(corrupted) で採用 → monitorSession の poll(corrupted) で即停止
    h.monitor.verdicts = [{ kind: "corrupted" }, { kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // 回復が HALT で終わったのでループに入らない
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open 扱い"
```

期待される失敗: open 扱いの verdict（in_progress/corrupted）は `recoverInReview` の `default` が `throw new Error('recoverInReview: verdict "in_progress" not yet implemented')`（resp. `"corrupted"`）を投げるため、`run()` が reject／または握り潰し設計なら「`s.state` が `merged`/`stopped` にならず `in_review` のまま」で 2 ケースとも落ちる。これで open 採用が**未実装であること**を red で確認する。

次に実装する。まず `adoptAndMonitor` private メソッドを `recoverDone` の隣（`recoverByOpenPr` と `recoverDone` の間）に追加する:

```typescript
  /**
   * 採用したセッションを MONITOR 再開し、merged まで進んだら DONE 後段を実行する。
   * monitorStartedAt は上書きしない（ガード/timeout の経過を継続。引数は記録用で再設定はしない）。
   */
  private async adoptAndMonitor(
    session: TaskSessionRow,
    prNumber: number,
    _monitorStartedAt: string | null,
  ): Promise<RunControl> {
    // runId 付替え（採用 → tasks_started に数えられる）。in_review 以外で来た場合も state は in_review にする。
    this.store.updateSession(session.id, { runId: this.runId, state: "in_review" });
    const fresh = this.store.getSession(session.id);
    const ctrl = await this.monitorSession(fresh, prNumber);
    if (ctrl.control === "halt") return HALT;
    // merged 到達 → DONE 後段
    await this.recoverDone(fresh);
    return CONTINUE;
  }
```

次に `recoverInReview` を更新する。(a) 冒頭の `const verdict = await this.monitor.poll(prNumber);` を try/catch にして poll throw 時は採用して通常 MONITOR ループへ委ねる、(b) `switch` の `default` を open 扱いの 4 `case` に置き換える:

```typescript
  /** in_review + PR の回復（カーネル §8）。poll の verdict で分岐する。 */
  private async recoverInReview(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    let verdict: MonitorVerdict;
    try {
      verdict = await this.monitor.poll(prNumber);
    } catch (err) {
      // poll が回復時に throw → 採用して通常 MONITOR ループに委ねる（バックオフ/5連続停止は monitorSession が担う）。
      this.log(`recovery: poll threw for PR #${prNumber}, resuming MONITOR: ${errMsg(err)}`);
      return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
    switch (verdict.kind) {
      case "merged":
        // DONE 後段（merged 永続化 → transition(done)）。二重計上なし（導出）。HALT しない。
        this.store.updateSession(session.id, { runId: this.runId });
        await this.recoverDone(session);
        return CONTINUE;
      case "pr_closed":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(session, "pr_closed", null);
      case "stopped":
        this.store.updateSession(session.id, { runId: this.runId });
        return await this.stopSession(
          session,
          "looppilot_stopped",
          verdict.stopReason ?? "looppilot stopped (no reason)",
        );
      // done / in_progress / corrupted / not_engaged = open 扱い → 採用して MONITOR 再開
      case "done":
      case "in_progress":
      case "corrupted":
      case "not_engaged":
        return await this.adoptAndMonitor(session, prNumber, session.monitorStartedAt);
    }
  }
```

> `default` を削除し全 7 kind の `case` を明示したことで、以降は `MonitorVerdict` に kind が増えたら tsc の exhaustiveness（網羅）チェックが効く。

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open 扱い"
```

期待: 全 green。落ちたら `adoptAndMonitor` が `runId` 付替え後に `monitorSession` を呼び、その halt/continue を回復の HALT/CONTINUE に変換していること、`monitorStartedAt` を上書きしていないことを確認する。

> 注: 2 つ目のテストは「回復 poll で 1 回 corrupted を消費 → 採用 → monitorSession の最初の poll で 2 つ目の corrupted を消費して即停止」を表す。`FakeMonitor` は verdicts が 2 要素なので 1 回目で 1 つ目を shift、2 回目で残り 1 つを維持して返す。

- [ ] **Step 7: ここまでの in_review 回復テストをコミット**

```
git add tests/recovery.test.ts
git commit -m "test: recovery in_review verdict branches (closed/stopped/adopt-monitor)"
```

- [ ] **Step 8: claimed/implementing/handing_off で findOpenPrForBranch ヒット → 採用のテストを先に書いて red 確認 → 実装で green**

まず失敗テストを追記する。この時点で `recoverByOpenPr` は丸ごと `throw new Error('recoverByOpenPr: not yet implemented ...')` なので、claimed/implementing/handing_off の seed を入れて `run()` すると reject／または握り潰し設計なら「`s.state` が `merged` にならず元の state のまま・`prNumber` が `null`」で落ちる。これでヒット採用が**未実装であること**を red で確認する。

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — claimed/implementing/handing_off で open PR ヒット → 採用（仕様 §9 / カーネル §8）", () => {
  it("handing_off で findOpenPrForBranch が #555 を返す → state=in_review・PR永続化・monitorStartedAt は既存値 → MONITOR 完走", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:12:00.000Z";
    const crashed = seedCrashedSession(
      h.store,
      { state: "handing_off", monitorStartedAt: originalStart },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 既存オープン PR を発見
    h.git.openPrForBranch.set("looppilot/ty-1-x", 555);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(555);
    expect(s.runId).toBe(newRun.id);
    // monitorStartedAt は既存値（??  clock の右辺は使われない）
    expect(s.monitorStartedAt).toBe(originalStart);
    // 採用で tasks_started に数えられる
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [555, "sha-555"] });
  });

  it("implementing で monitorStartedAt=null・open PR ヒット → monitorStartedAt が clock() で新規設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing", monitorStartedAt: null },
      { branch: "looppilot/ty-2-x", worktreePath: "/wt/ty-2", linearIssueId: "issue-B", linearIdentifier: "TY-2" },
    );
    h.git.openPrForBranch.set("looppilot/ty-2-x", 666);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(666);
    // monitorStartedAt は null だったので clock() で設定（基準 2026-06-05... 始まり）
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open PR ヒット"
```

期待される失敗: `recoverByOpenPr` が `throw new Error('recoverByOpenPr: not yet implemented ...')` を投げるため、2 ケースとも `run()` reject／または握り潰し設計なら `s.state` が `merged` にならず（handing_off / implementing のまま）で落ちる。

次に `recoverByOpenPr` を「丸ごと throw」から「ヒット分岐を実装 + ミスはまだ throw（Step 9 で実装）」へ置き換える:

```typescript
  /** claimed/implementing/handing_off（および PR 番号欠落 in_review）の回復（カーネル §8）。 */
  private async recoverByOpenPr(session: TaskSessionRow): Promise<RunControl> {
    const prNumber = await this.git.findOpenPrForBranch(session.branch);
    if (prNumber !== null) {
      // 既存のオープン PR を採用。monitorStartedAt は既存値 ?? clock()。
      const monitorStartedAt = session.monitorStartedAt ?? this.clock();
      this.store.updateSession(session.id, {
        runId: this.runId,
        prNumber,
        state: "in_review",
        monitorStartedAt,
      });
      return await this.adoptAndMonitor(session, prNumber, monitorStartedAt);
    }
    // オープン PR なし（ミス）: stopped(exception)+HALT は Step 9 で失敗テスト先行で実装する。
    throw new Error(`recoverByOpenPr: open-PR-miss not yet implemented (session ${session.id})`);
  }
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open PR ヒット"
```

期待: 全 green。落ちたら `recoverByOpenPr` のヒット分岐（`updateSession({runId, prNumber, state:"in_review", monitorStartedAt: s.monitorStartedAt ?? clock()})` → `adoptAndMonitor`）を確認する。

- [ ] **Step 9: claimed/implementing/handing_off で open PR ミス → stopped(exception)+HALT のテストを先に書いて red 確認 → 実装で green**

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — open PR ミス → stopped(exception) + HALT（仕様 §9 / カーネル §8: 手動掃除）", () => {
  it("claimed で findOpenPrForBranch が null → stopped(exception, stop_detail に branch/worktree/identifier) + HALT・ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", monitorStartedAt: null },
      { branch: "looppilot/ty-7-x", worktreePath: "/wt/ty-7", linearIssueId: "issue-G", linearIdentifier: "TY-7" },
    );
    // open PR なし（既定 null）
    h.source.queue = [issue("issue-Z", "TY-9")];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    // stop_detail に branch / worktree / identifier を明記（手動掃除を促す。カーネル §8）
    expect(s.stopDetail).toContain("crash recovery: no open PR");
    expect(s.stopDetail).toContain("looppilot/ty-7-x");
    expect(s.stopDetail).toContain("/wt/ty-7");
    expect(s.stopDetail).toContain("TY-7");
    expect(s.runId).toBe(newRun.id);
    // HALT したのでループに入らない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
    // pushAndOpenPr / mergePr は呼ばれない（タスク内再開は v1 スコープ外）
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("worktreePath=null でも stop_detail にプレースホルダを出して HALT する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", worktreePath: null },
      { branch: "looppilot/ty-8-x", linearIssueId: "issue-H", linearIdentifier: "TY-8" },
    );

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("<no worktree>");
    expect(s.stopDetail).toContain("looppilot/ty-8-x");
    expect(s.stopDetail).toContain("TY-8");
  });
});
```

> 注: 2 つ目のテストは `worktreePath` を `null` で上書きする（`createSession` は worktreePath 必須だが、`seedCrashedSession` の patch で `updateSession(s.id, { worktreePath: null })` できる。カーネル §4 で `worktree_path` は nullable）。

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "open PR ミス"
```

期待される失敗: `recoverByOpenPr` のミス側がまだ `throw new Error('recoverByOpenPr: open-PR-miss not yet implemented ...')` なので、2 ケースとも `run()` reject／または握り潰し設計なら「`s.state` が `stopped` にならず `claimed` のまま・`failureReason` が `null`・`stopDetail` が無い」で落ちる。

次に `recoverByOpenPr` のミス側の throw を本実装へ置き換える:

```typescript
    // オープン PR なし → 手動掃除を促して HALT（タスク内自動再開は v1 スコープ外）。
    this.store.updateSession(session.id, { runId: this.runId });
    const detail =
      `crash recovery: no open PR; manual cleanup: ` +
      `${session.branch}, ${session.worktreePath ?? "<no worktree>"}, ${session.linearIdentifier}`;
    return await this.stopSession(session, "exception", detail);
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "open PR ミス"
```

期待: 全 green。落ちたら `recoverByOpenPr` のミス分岐（`stopSession(s, "exception", "crash recovery: no open PR; manual cleanup: ...")`）の文言・`run()` の HALT で `loop()` を呼ばないことを確認する。

- [ ] **Step 10: open PR ヒット/ミス系テストをコミット**

```
git add tests/recovery.test.ts
git commit -m "test: recovery by open PR — adopt on hit, stopped(exception)+HALT on miss"
```

- [ ] **Step 11: 孤児チケット復帰（findOrphanedInProgress → todo ベストエフォート+警告）のテストを先に書いて red 確認 → 実装で green**

孤児ブロックは Step 2 でコメントのみ（未実装）にしてあるので、以下の 3 ケースは red になる。まず失敗テストを追記する。

`tests/recovery.test.ts` に describe を追記:

```typescript
describe("回復 — 孤児チケット（In Progress だがセッション行なし → Todo 復帰・ベストエフォート）（仕様 §9 / カーネル §8）", () => {
  it("findOrphanedInProgress が 2 件返す → 各々 transition(todo) + 警告ログ。HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 活性セッションは無し（孤児だけ）→ 回復は孤児復帰のみ。
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 回復後ループは 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 孤児 2 件が Todo へ戻された
    expect(h.source.transitions).toEqual([
      { issueId: "issue-O1", state: "todo" },
      { issueId: "issue-O2", state: "todo" },
    ]);
    // 警告ログが各孤児に出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-11"))).toBe(true);
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-12"))).toBe(true);
    // 孤児復帰は HALT しない → ループに入った（run_started のみ・halted なし）
    expect(h.store.latestRun()!.state).not.toBe("halted");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started"]);
  });

  it("transition(todo) が throw してもベストエフォート（HALT せず警告ログ）で次の孤児へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 最初の transition(todo) で 1 回だけ throw（FakeTaskSource.failNext は次の1回だけ throw）
    h.source.failNext("transition", new Error("Linear 5xx"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 1 件目の transition は throw（記録されない）、2 件目は成功して記録される
    expect(h.source.transitions).toEqual([{ issueId: "issue-O2", state: "todo" }]);
    // ベストエフォートなので HALT していない
    expect(h.store.latestRun()!.state).not.toBe("halted");
  });

  it("findOrphanedInProgress 自体が throw しても回復は HALT せず警告のみで継続する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.failNext("findOrphanedInProgress", new Error("Linear query failed"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    expect(h.logs.some((l) => l.includes("warning") && l.includes("findOrphanedInProgress failed"))).toBe(true);
    expect(h.store.latestRun()!.state).not.toBe("halted");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/recovery.test.ts -t "孤児チケット"
```

期待される失敗: 孤児ブロックが未実装（Step 2 でコメントのみ）なので、1 件目は `h.source.transitions` が空配列のまま（`transition(todo)` が呼ばれない）で落ち、3 件目は `findOrphanedInProgress failed` の警告ログが出ず落ちる。これで孤児復帰が**未実装であること**を red で確認する。

次に `recoverPendingSessions()` の冒頭コメント `// 1) 孤児チケット復帰: Step 11 で...` を本実装に置き換える:

```typescript
    // 1) 孤児チケット復帰（ベストエフォート）
    try {
      const orphans = await this.source.findOrphanedInProgress(this.store.knownIssueIds());
      for (const orphan of orphans) {
        await bestEffort(() => this.source.transition(orphan.id, "todo"));
        this.log(
          `warning: recovered orphaned In Progress ticket ${orphan.identifier} -> Todo (no session row)`,
        );
      }
    } catch (err) {
      this.log(`warning: findOrphanedInProgress failed during recovery: ${errMsg(err)}`);
    }
```

実行して green を確認する:

```
npx vitest run tests/recovery.test.ts -t "孤児チケット"
```

期待: 全 green。落ちたら `recoverPendingSessions()` の孤児ブロック（`findOrphanedInProgress` を try で囲み、各 orphan を `bestEffort(transition todo)` + 警告ログ）を確認する。

- [ ] **Step 12: 採用セッションが tasks_started に数えられ上限と比較されるテストを先に書いて red 確認 → 既存実装で green**

採用したセッションが `countTasksStarted(newRunId)` に数えられ、`loop()` のタスク上限チェックの比較対象になることを固定する。`maxTasksPerRun=1` で「回復が 1 件採用して完走 → ループ先頭で `countTasksStarted(1) >= 1` 成立 → SELECT 前に task_cap HALT」を検証:

```typescript
describe("回復 — 採用セッションが tasks_started に数えられ上限と比較される（仕様 §11 / カーネル §8）", () => {
  it("maxTasksPerRun=1 で回復が 1 件採用→完走すると、ループ先頭で task cap 到達 → SELECT せず HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 残キューに 1 件あるが、採用 1 件で上限到達のため着手されない
    h.source.queue = [issue("issue-Q", "TY-99")];
    // 回復 poll が open → 採用して MONITOR、done→merged で完走
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 採用セッションは新 Run の tasks_started=1
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // 上限到達でループ先頭 HALT（SELECT に進まない → getNextEligible は呼ばれない）
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).toContain("task cap reached");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 残キューの TY-99 は未着手
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-99"]);
    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "task_cap" });
  });

  it("回復で HALT したら（in_review が stopped verdict）ループに一切入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Q", "TY-99")];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "gave up" }];

    await h.orch.run();

    // 回復で HALT → ループ(loop)に入らず SELECT は 0 回
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.agent.contexts).toHaveLength(0); // 実装フェーズにも入らない
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});
```

> 注（characterization の失敗確認）: このテストが固定する「採用→runId 付替え→tasks_started に数えられる」挙動は Step 6/8 の `adoptAndMonitor`（`updateSession({ runId: this.runId, ... })`）で既に実装済みのため、テスト追加だけでは red にならない。カーネル §11 の「テスト→失敗確認→実装→成功確認」を満たすため、**まず付替えを一時的に殺して red を観測**する: `adoptAndMonitor` の `this.store.updateSession(session.id, { runId: this.runId, state: "in_review" });` を一時的に `state` だけの patch（`{ state: "in_review" }`）に書き換えて実行 → 1 件目が「採用セッションが旧 Run のまま → 新 Run の `countTasksStarted(newRun.id)` が `0`、task_cap 未到達でループが SELECT に進み `eligibleCalls` が 0 でない」で落ちる（=この挙動が runId 付替えに依存していることを赤で確認）。確認後 `runId: this.runId` を**元に戻す**。

実行（まず付替えを殺して red、戻して green）:

```
npx vitest run tests/recovery.test.ts -t "tasks_started に数えられ"
```

期待: 付替えを殺すと 1 件目 red、戻すと全 green。落ちたら `adoptAndMonitor` が `updateSession(runId: this.runId)` で付替えていること、`loop()` の上限チェックが各反復先頭で `countTasksStarted(runId) >= maxTasksPerRun` を見ていること（Task 12）を確認する。1 件目は「回復後ループに入る（continue）が先頭で task_cap HALT」、2 件目は「回復で HALT（loop に入らない）」の差分を確認する。

- [ ] **Step 13: 複数 active セッション・最初の HALT で打ち切りのテストを書き、打ち切りを一時的に殺して red 確認 → 戻して green**

`activeSessions()` が複数返るとき、最初に HALT した時点で残りを処理しないことを固定する（id ASC 順・カーネル §8: 逐次で最初の stopped が Run=halted を確定）。この「最初の HALT で打ち切る」挙動は Step 2 で実装済みの `for` ループ内 `if (ctrl.control === "halt") return HALT;` に依存するため、テスト追加だけでは red にならない。**まず打ち切りを一時的に殺して red を観測**する手順を含める:

```typescript
describe("回復 — 複数 active セッションは id ASC・最初の HALT で打ち切り（仕様 §9 / カーネル §8）", () => {
  it("2 件 active（1 件目 in_review→merged、2 件目 claimed→open PR ミス）→ 1 件目採用後 2 件目で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 5 });
    const h = makeHarness(config);
    // 1 件目: in_review + PR #100（merged で完走）
    const s1 = seedCrashedSession(
      h.store,
      { state: "in_review", prNumber: 100, monitorStartedAt: "2026-06-04T00:10:00.000Z" },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 2 件目: claimed・open PR ミス → HALT（同じ store・別セッション）
    const s2RunSeed = h.store.createSession({
      runId: h.store.latestRun()!.id, // s1 の旧 Run と同じ旧 Run
      linearIssueId: "issue-B",
      linearIdentifier: "TY-2",
      issueTitle: "second crashed",
      branch: "looppilot/ty-2-x",
      worktreePath: "/wt/ty-2",
      now: "2026-06-04T00:00:02.000Z",
    });
    h.store.updateSession(s2RunSeed.id, { state: "claimed" });
    // 1 件目だけ open verdict→merged で完走。2 件目は open PR 無し（既定 null）で HALT。
    h.monitor.verdicts = [{ kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const r1 = h.store.getSession(s1.id);
    const r2 = h.store.getSession(s2RunSeed.id);
    // 1 件目は merged（採用・DONE 後段）
    expect(r1.state).toBe("merged");
    expect(r1.runId).toBe(newRun.id);
    // 2 件目は stopped(exception)（open PR ミス）→ HALT
    expect(r2.state).toBe("stopped");
    expect(r2.failureReason).toBe("exception");
    expect(r2.runId).toBe(newRun.id);
    // 回復で HALT → ループに入らない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});
```

実行（まず打ち切りを殺して red、戻して green）:

> 失敗確認手順: `recoverPendingSessions()` の `for` ループ内 `if (ctrl.control === "halt") return HALT;` を一時的に `if (ctrl.control === "halt") { /* keep going */ }`（早期 return を消す）へ書き換えて実行する。すると 1 件目（merged）処理後も 2 件目（open PR ミス→HALT）まで進み、最後に CONTINUE を返してループに入るため `eligibleCalls` が 0 でなくなる／`newRun.state` が `halted` でなくなる経路が生じ得る、または 2 件目の stopped 後に処理が継続して期待と食い違い red になる。これで「最初の HALT で打ち切る」挙動を赤で確認する。確認後 `return HALT;` を**元に戻す**。

```
npx vitest run tests/recovery.test.ts -t "複数 active セッション"
```

期待: 早期 return を消すと red、戻すと green。落ちたら `recoverPendingSessions()` の `for (const session of this.store.activeSessions())` ループが `ctrl.control === "halt"` で即 `return HALT` していること、`activeSessions()` が id ASC（Task 5）であることを確認する。

> 注: 1 件目の `monitor.verdicts=[{merged}]` は回復 poll が消費する（in_review+PR の merged 分岐は `monitorSession` を経由せず即 DONE 後段なので、verdict 1 個で足りる）。2 件目は monitor を呼ばず（claimed→`findOpenPrForBranch` 経路）HALT する。

- [ ] **Step 14: 残りのテストをコミットし、最終 `npm run check`**

```
git add tests/recovery.test.ts
git commit -m "test: recovery orphans, task-cap counting, multi-session halt cutoff"
```

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`recoverPendingSessions()` が `Promise<RunControl>` を返し、`recoverInReview` の switch が `MonitorVerdict` 全 kind を網羅、`run()` が回復の halt/continue を分岐する。失敗が残り、それがカーネル §8 と矛盾するなら openQuestions に記録し、コードは勝手に改変しない。

```
git add src/orchestrator.ts tests/recovery.test.ts
git commit -m "chore: finalize crash-recovery task (Task 14)"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` の `recoverPendingSessions()` が `Promise<RunControl>` を返し、カーネル §8 を実装する:
  - 孤児チケット（`findOrphanedInProgress(knownIssueIds())`）を Todo へベストエフォート復帰 + 警告ログ（`findOrphanedInProgress`/`transition` の throw もベストエフォート）。
  - `activeSessions()`（merged/stopped 以外・全 run 横断・id ASC）を走査し、`in_review`+PR は `monitor.poll` の verdict で分岐（merged→DONE 後段・二重計上なし／pr_closed→stopped(pr_closed)／stopped→stopped(looppilot_stopped, stopReason ?? 既定文言)／その他=open→採用・runId 付替え・`monitorStartedAt` 不変で MONITOR 再開）、`claimed`/`implementing`/`handing_off` は `findOpenPrForBranch` ヒット時に採用（`monitorStartedAt = 既存値 ?? clock()`）・ミス時に `stopped(exception, "crash recovery: no open PR; manual cleanup: <branch>, <worktree>, <identifier>")` + HALT。
- `run()` が回復の戻り値を見て、`halt` ならループ（`loop()`）を呼ばない。
- `tests/recovery.test.ts` が以下を固定する: in_review+PR の merged/pr_closed/stopped(stopReason あり・null)/open 採用（in_progress→done→merged・corrupted 採用→即停止）、open PR ヒット（monitorStartedAt 既存値 / null→clock）、open PR ミス（worktreePath あり/null で stop_detail 明記）、孤児復帰（2 件・transition throw・query throw のベストエフォート）、採用が tasks_started に数えられ task_cap と比較される、回復 HALT でループに入らない、複数 active で最初の HALT による打ち切り。
- 全テストは `fixedClock`/`instantSleep` + seed した `monitorStartedAt`/`requestStop()` で時間・ループを決定的に制御。`vi.mock` 不使用（フェイクのメソッド差し替え/プロパティ設定のみ）。
- `Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness` は再定義せず Modify（テストヘルパは独立ファイルのため再定義を許容）。`monitorSession`/`done`/`stopSession` を再利用し重複実装しない。
- `npm run check` が green。
