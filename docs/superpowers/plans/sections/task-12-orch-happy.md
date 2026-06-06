### Task 12: Orchestrator 正常系

**目的**: `src/orchestrator.ts` の Orchestrator Core を新規実装する。カーネル §7 の DI とループ・状態機械の **正常フロー**（ランロック取得/解放、Run 作成、SELECT→CLAIM→IMPLEMENT→HANDOFF→MONITOR→DONE の完走、IDLE→復帰、タスク上限 HALT、run_started 通知）を TDD で組み立てる。`recoverPendingSessions()` は本タスクでは **空実装（活性セッション無し前提の素通し）として定義だけ置く**（中身は Task 14）。失敗系の分岐（cost_exceeded/exception/agent_no_change/handoff_failed/監視失敗/CLAIM 失敗）は §7 の遷移が **型上通る最小実装**（`stopSession` ヘルパ等）を含めるが、本タスクのテストは正常系のみ。失敗系の網羅テストは Task 13。

**依存タスク**:
- Task 2（`src/types.ts`：全ドメイン型・モジュールインターフェース）
- Task 3（`tests/fakes.ts` の `FakeCommandRunner`・`fixedClock`・`instantSleep` の一部。本タスクで残りのフェイクを同ファイルに追記）
- Task 5（`src/store.ts`：`SqliteStore`）
- Task 11（`src/context-bundle.ts`：`buildPrompt`。本タスクでは DI 経由でフェイク差し替え可能なため実体には依存しないが、既定値として import する）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/types.ts`: `SessionState`, `RunState`, `FailureReason`, `EligibleIssue`, `TicketState`, `RunRow`, `TaskSessionRow`, `TaskSource`, `SessionContext`, `AgentOutcome`, `AgentRunner`, `ClaimResult`, `GitPrManager`, `MonitorVerdict`, `MergeReadiness`, `LoopPilotMonitor`, `NotifyEvent`, `Notifier`, `PromptArgs`, `CommandRunner` 等（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/context-bundle.ts`: `buildPrompt(args: PromptArgs): string`（カーネル §2/§11）
- `tests/fakes.ts`: `FakeCommandRunner`, `fixedClock`, `instantSleep`（Task 3 で定義済み）

> 注: 本タスクが `Config` 型に依存する箇所は `config.product.goal`, `config.digest.recentMergedCount`, `config.safety.maxTasksPerRun`, `config.safety.maxCostUsdPerSession`, `config.safety.notEngagedGuardMinutes`, `config.safety.monitorTimeoutMinutes`（任意・既定 undefined）, `config.loop.monitorPollSeconds`, `config.loop.idleRecheckSeconds`, `config.looppilot.gateLabel`。Config の完全な zod スキーマは Task 4 の所掌。テストでは `Config` の必要フィールドだけを持つ最小オブジェクトを生成するヘルパ（`makeConfig`）を本タスクで用意する。`Config` 型は `src/config.ts` から import する（型のみ）。

---

#### このセクションが定義する Orchestrator の正常系の形（実装の正）

カーネル §7 を実装に落とすにあたり、本タスクで確定させる内部構造（後続タスクが追記する土台）:

- `Orchestrator` クラス。コンストラクタ引数は単一オブジェクト `OrchestratorDeps`。
- `run(): Promise<void>` がエントリ。`try { acquireRunLock; createRun; recoverPendingSessions; loop } finally { releaseRunLock }`。
- ループは `while (true)` で、各反復で「タスク上限チェック → SELECT → (IDLE なら sleep して continue) → CLAIM → IMPLEMENT → HANDOFF → MONITOR → DONE」を実行する。HALT に至ったら `return`（ループ脱出）。
- 各セッションのフェーズは private メソッドに分解する: `selectIssue`, `claim`, `implement`, `handoff`, `monitor`, `done`。
- 失敗時の共通終端は private `stopSession(session, reason, detail, extraPatch)`：updateSession(stopped 等) → notify(halted) → Run=halted。各フェーズは失敗時に `stopSession` を呼んでから「HALT したことを示す番兵」を返し、`run()` のループはそれを見て `return` する。番兵は `RunControl` 型（`"continue" | "halt"` の判別）で表す。
- IDLE は `selectIssue` の戻り値が `{ control: "idle" }` のとき `run()` 側で notify(idle)（初回のみ）→ sleep → 再 SELECT を行う。
- run_started 通知は createRun 直後・recover の前に 1 回送る。

これにより Task 13 は「各フェーズの失敗分岐を埋める＋安全弁テストを足す」だけになり、Task 14 は `recoverPendingSessions()` の中身を差し替えるだけになる。

---

#### Files

- **Create**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`
- **Modify**: `/home/racoma-dev/loop-pilot-os/tests/fakes.ts`（残りのフェイク `FakeTaskSource` / `FakeAgentRunner` / `FakeGitPr` / `FakeMonitor` / `FakeNotifier` を追記。`fixedClock` / `instantSleep` は Task 3 で定義済み前提）
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/orchestrator.test.ts`

---

#### Step-by-step（TDD）

- [ ] **Step 1: 残りのフェイクを `tests/fakes.ts` に追記する（テスト基盤）**

`tests/fakes.ts` の末尾に以下を追記する。既存の `FakeCommandRunner` / `fixedClock` / `instantSleep` と、先頭の import 群（`CommandRunner`, `CommandResult`, `RunOptions` 等）はそのまま残し、型 import に不足分を足す。先頭の import 行に以下のシンボルが含まれていなければ追加する（既に Task 3 が `from "../src/types.js"` で型を import している前提なので、不足分のみ列挙して足す）:

```typescript
import type {
  TaskSource,
  EligibleIssue,
  TicketState,
  AgentRunner,
  SessionContext,
  AgentOutcome,
  GitPrManager,
  ClaimResult,
  LoopPilotMonitor,
  MonitorVerdict,
  MergeReadiness,
  Notifier,
  NotifyEvent,
} from "../src/types.js";
```

ファイル末尾に以下のクラス群を追記する（完全形）:

```typescript
// ---- FakeTaskSource ----
export class FakeTaskSource implements TaskSource {
  /** getNextEligible が順に shift して返す。空なら null（IDLE） */
  queue: EligibleIssue[] = [];
  /** transition(issueId, state) の呼び出し記録 */
  transitions: Array<{ issueId: string; state: TicketState }> = [];
  /** getNextEligible(excludeIds) の excludeIds 記録 */
  eligibleCalls: string[][] = [];
  /** findOrphanedInProgress の戻り値 */
  orphans: EligibleIssue[] = [];
  /** メソッド名 → 次の1回だけ throw させるエラー */
  private failOnce = new Map<string, Error>();

  failNext(method: "getNextEligible" | "transition" | "findOrphanedInProgress", error?: Error): void {
    this.failOnce.set(method, error ?? new Error(`FakeTaskSource.${method} injected failure`));
  }

  private takeFailure(method: string): void {
    const err = this.failOnce.get(method);
    if (err) {
      this.failOnce.delete(method);
      throw err;
    }
  }

  async getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null> {
    this.eligibleCalls.push([...excludeIds]);
    this.takeFailure("getNextEligible");
    const next = this.queue.find((i) => !excludeIds.includes(i.id));
    if (!next) return null;
    this.queue = this.queue.filter((i) => i !== next);
    return next;
  }

  async transition(issueId: string, state: TicketState): Promise<void> {
    this.takeFailure("transition");
    this.transitions.push({ issueId, state });
  }

  async findOrphanedInProgress(_knownIssueIds: string[]): Promise<EligibleIssue[]> {
    this.takeFailure("findOrphanedInProgress");
    return this.orphans;
  }
}

// ---- FakeAgentRunner ----
export class FakeAgentRunner implements AgentRunner {
  /** runSession が順に shift して返す結果 */
  outcomes: AgentOutcome[] = [];
  /** 呼び出された SessionContext を記録 */
  contexts: SessionContext[] = [];

  async runSession(ctx: SessionContext): Promise<AgentOutcome> {
    this.contexts.push(ctx);
    const out = this.outcomes.shift();
    if (!out) throw new Error("FakeAgentRunner: no outcome queued");
    return out;
  }
}

// ---- FakeGitPr ----
export class FakeGitPr implements GitPrManager {
  /** prepareWorktree の戻り値（issue.identifier → ClaimResult）。未設定は決定的に生成 */
  claimResults = new Map<string, ClaimResult>();
  /** hasCommitsWithDiff の戻り値（worktreePath → boolean）。既定 true */
  commitsWithDiff = new Map<string, boolean>();
  /** hasUncommittedChanges の戻り値（worktreePath → boolean）。既定 false */
  uncommitted = new Map<string, boolean>();
  /** findOpenPrForBranch の戻り値（branch → number | null）。既定 null */
  openPrForBranch = new Map<string, number | null>();
  /** pushAndOpenPr の戻り値（branch → number）。既定は連番 */
  pushPrNumber = new Map<string, number>();
  private nextPr = 100;
  /** 呼び出し記録 */
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** メソッド名 → 次の1回だけ throw させるエラー */
  private failOnce = new Map<string, Error>();

  failNext(method: keyof GitPrManager, error?: Error): void {
    this.failOnce.set(method, error ?? new Error(`FakeGitPr.${method} injected failure`));
  }

  private takeFailure(method: string): void {
    const err = this.failOnce.get(method);
    if (err) {
      this.failOnce.delete(method);
      throw err;
    }
  }

  async prepareWorktree(issue: EligibleIssue): Promise<ClaimResult> {
    this.calls.push({ method: "prepareWorktree", args: [issue.id] });
    this.takeFailure("prepareWorktree");
    const preset = this.claimResults.get(issue.identifier);
    if (preset) return preset;
    const branch = `looppilot/${issue.identifier.toLowerCase()}-x`;
    return { branch, worktreePath: `/wt/${issue.identifier.toLowerCase()}` };
  }

  async hasCommitsWithDiff(worktreePath: string): Promise<boolean> {
    this.calls.push({ method: "hasCommitsWithDiff", args: [worktreePath] });
    this.takeFailure("hasCommitsWithDiff");
    return this.commitsWithDiff.get(worktreePath) ?? true;
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    this.calls.push({ method: "hasUncommittedChanges", args: [worktreePath] });
    this.takeFailure("hasUncommittedChanges");
    return this.uncommitted.get(worktreePath) ?? false;
  }

  async findOpenPrForBranch(branch: string): Promise<number | null> {
    this.calls.push({ method: "findOpenPrForBranch", args: [branch] });
    this.takeFailure("findOpenPrForBranch");
    return this.openPrForBranch.get(branch) ?? null;
  }

  async pushAndOpenPr(branch: string, worktreePath: string, issue: EligibleIssue): Promise<number> {
    this.calls.push({ method: "pushAndOpenPr", args: [branch, worktreePath, issue.id] });
    this.takeFailure("pushAndOpenPr");
    const preset = this.pushPrNumber.get(branch);
    if (preset !== undefined) return preset;
    return this.nextPr++;
  }

  async addLabel(prNumber: number, label: string): Promise<void> {
    this.calls.push({ method: "addLabel", args: [prNumber, label] });
    this.takeFailure("addLabel");
  }

  async mergePr(prNumber: number, headSha: string): Promise<void> {
    this.calls.push({ method: "mergePr", args: [prNumber, headSha] });
    this.takeFailure("mergePr");
  }

  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    this.calls.push({ method: "discardWorktree", args: [branch, worktreePath] });
    this.takeFailure("discardWorktree");
  }
}

// ---- FakeMonitor ----
export class FakeMonitor implements LoopPilotMonitor {
  /** poll(pr) が順に shift して返す verdict 列。尽きたら最後の verdict を維持して返す */
  verdicts: MonitorVerdict[] = [];
  /** checkMergeReadiness の戻り値（pr → MergeReadiness）。既定 ready */
  readiness = new Map<number, MergeReadiness>();
  /** poll の呼び出し記録（pr 番号） */
  pollCalls: number[] = [];
  /** checkMergeReadiness の呼び出し記録（pr 番号） */
  readinessCalls: number[] = [];

  async poll(prNumber: number): Promise<MonitorVerdict> {
    this.pollCalls.push(prNumber);
    if (this.verdicts.length > 1) {
      return this.verdicts.shift() as MonitorVerdict;
    }
    if (this.verdicts.length === 1) {
      return this.verdicts[0];
    }
    throw new Error("FakeMonitor: no verdict queued");
  }

  async checkMergeReadiness(prNumber: number): Promise<MergeReadiness> {
    this.readinessCalls.push(prNumber);
    return this.readiness.get(prNumber) ?? { ready: true, headSha: `sha-${prNumber}` };
  }
}

// ---- FakeNotifier ----
export class FakeNotifier implements Notifier {
  /** notify された NotifyEvent を蓄積 */
  events: NotifyEvent[] = [];

  async notify(event: NotifyEvent): Promise<void> {
    this.events.push(event);
  }

  async probeReachability(): Promise<void> {
    // テストではプリフライト専用。no-op。
  }
}
```

- [ ] **Step 2: `tests/orchestrator.test.ts` を作成し、最初の失敗するテスト（1チケット完走）を書く**

`tests/orchestrator.test.ts` を新規作成（この時点で `src/orchestrator.ts` は存在しないため import エラーで失敗する）:

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
import type { EligibleIssue, PromptArgs } from "../src/types.js";

// ---- テストヘルパ ----
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

describe("Orchestrator 正常系 — 1チケット完走（仕様 §5 SELECT→CLAIM→IMPLEMENT→HANDOFF→MONITOR→DONE）", () => {
  it("単一チケットを選定→worktree→実装→PR→ラベル→監視→マージし、状態が merged になる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.5, summary: "did the work" }];
    // poll: done を返し → checkMergeReadiness(ready) → mergePr → 次 poll で merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const sessions = h.store.sessionsForRun(h.store.latestRun()!.id);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // 仕様 §7: 完走後の終端状態は merged
    expect(s.state).toBe("merged");
    expect(s.linearIdentifier).toBe("TY-1");
    expect(s.prNumber).toBe(100);
    expect(s.costUsd).toBe(1.5);
    expect(s.agentSummary).toBe("did the work");
    expect(s.endedAt).not.toBeNull();
    // 仕様 §5.4: in_review 入り時刻が記録される
    expect(s.monitorStartedAt).not.toBeNull();
    // merge が呼ばれた
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(true);
  });
});
```

実行して **import 解決失敗で落ちる**ことを確認する:

```
npx vitest run tests/orchestrator.test.ts
```

期待される失敗: `Failed to resolve import "../src/orchestrator.js"`（モジュール未作成）。

- [ ] **Step 3: `src/orchestrator.ts` を最小実装し、1チケット完走テストを green にする**

`src/orchestrator.ts` を新規作成（完全形）。本タスクで §7 の正常フロー＋失敗終端ヘルパ（型上通る最小）を実装する:

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
import type { SqliteStore } from "./store.js";
import type { Config } from "./config.js";

export interface OrchestratorDeps {
  config: Config;
  source: TaskSource;
  agent: AgentRunner;
  git: GitPrManager;
  monitor: LoopPilotMonitor;
  notifier: Notifier;
  store: SqliteStore;
  buildPrompt: (args: PromptArgs) => string;
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** フェーズの返り値: 続行か、HALT 済み（ループを脱出すべき）か */
type RunControl =
  | { control: "continue" }
  | { control: "halt" };

const CONTINUE: RunControl = { control: "continue" };
const HALT: RunControl = { control: "halt" };

export class Orchestrator {
  private readonly config: Config;
  private readonly source: TaskSource;
  private readonly agent: AgentRunner;
  private readonly git: GitPrManager;
  private readonly monitor: LoopPilotMonitor;
  private readonly notifier: Notifier;
  private readonly store: SqliteStore;
  private readonly buildPrompt: (args: PromptArgs) => string;
  private readonly clock: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  private runId = 0;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.source = deps.source;
    this.agent = deps.agent;
    this.git = deps.git;
    this.monitor = deps.monitor;
    this.notifier = deps.notifier;
    this.store = deps.store;
    this.buildPrompt = deps.buildPrompt;
    this.clock = deps.clock;
    this.sleep = deps.sleep;
    this.log = deps.log;
  }

  async run(): Promise<void> {
    const pid = process.pid;
    const acquired = this.store.acquireRunLock(pid, isPidAlive, this.clock());
    if (!acquired) {
      this.log("run lock held by another live process; aborting");
      return;
    }
    try {
      const taskCap = this.config.safety.maxTasksPerRun;
      const run = this.store.createRun(taskCap, this.clock());
      this.runId = run.id;
      await this.notifier.notify({
        kind: "run_started",
        detail: `run ${run.id} started (taskCap=${taskCap})`,
      });
      await this.recoverPendingSessions();
      await this.loop();
    } finally {
      this.store.releaseRunLock(pid);
    }
  }

  /**
   * 起動時回復（仕様 §9）。
   * 本タスク（Task 12）では活性セッション無しを前提に素通しする空実装。
   * 中身（in_review 再開 / crash 回復 / 孤児チケット復帰）は Task 14 で実装する。
   */
  private async recoverPendingSessions(): Promise<void> {
    // Task 14 で実装。現状は no-op（活性セッション無し前提）。
  }

  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
      if (started >= this.config.safety.maxTasksPerRun) {
        const detail = `task cap reached: ${started}/${this.config.safety.maxTasksPerRun}`;
        await this.notifier.notify({ kind: "halted", reason: "task_cap", detail });
        this.store.setRunState(this.runId, "halted", detail);
        this.log(detail);
        return;
      }

      // 2) SELECT（仕様 §5.1）
      const issue = await this.source.getNextEligible(this.store.activeIssueIds());
      if (issue === null) {
        // IDLE（キュー空 → 通知は初回のみ → 定期再確認）
        if (!idleNotified) {
          await this.notifier.notify({ kind: "idle", detail: "no eligible tickets" });
          idleNotified = true;
        }
        this.store.setRunState(this.runId, "idle");
        await this.sleep(this.config.loop.idleRecheckSeconds * 1000);
        continue;
      }
      // 復帰：idle から running へ
      idleNotified = false;
      this.store.setRunState(this.runId, "running");

      // 3) CLAIM
      const claim = await this.claim(issue);
      if (claim.control === "halt") return;
      const session = claim.session;

      // 4) IMPLEMENT
      const impl = await this.implement(session, issue);
      if (impl.control === "halt") return;

      // 5) HANDOFF
      const handoff = await this.handoff(session, issue);
      if (handoff.control === "halt") return;
      const prNumber = handoff.prNumber;

      // 6) MONITOR
      const mon = await this.monitorSession(session, prNumber);
      if (mon.control === "halt") return;

      // 7) DONE
      await this.done(session, issue);
      // ループ継続（SELECT へ）
    }
  }

  // ---- CLAIM（仕様 §5.2） ----
  private async claim(
    issue: EligibleIssue,
  ): Promise<{ control: "halt" } | { control: "continue"; session: TaskSessionRow }> {
    let claimResult;
    try {
      claimResult = await this.git.prepareWorktree(issue);
    } catch (err) {
      // ① prepareWorktree 失敗：セッション行なしで HALT（claim_failed を Run.halt_reason へ）
      const detail = `claim_failed: prepareWorktree for ${issue.identifier}: ${errMsg(err)}`;
      await this.notifier.notify({ kind: "halted", reason: "claim_failed", detail });
      this.store.setRunState(this.runId, "halted", detail);
      this.log(detail);
      return HALT;
    }
    const session = this.store.createSession({
      runId: this.runId,
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      issueTitle: issue.title,
      branch: claimResult.branch,
      worktreePath: claimResult.worktreePath,
      now: this.clock(),
    });
    try {
      await this.source.transition(issue.id, "in_progress");
    } catch (err) {
      // ② transition 失敗：discardWorktree + stopped(claim_failed) + ticket→Todo（best-effort）→ HALT
      await bestEffort(() => this.git.discardWorktree(claimResult.branch, claimResult.worktreePath));
      await bestEffort(() => this.source.transition(issue.id, "todo"));
      const ctrl = await this.stopSession(session, "claim_failed", `transition(in_progress) failed: ${errMsg(err)}`);
      return ctrl;
    }
    return { control: "continue", session };
  }

  // ---- IMPLEMENT（仕様 §5.3） ----
  private async implement(session: TaskSessionRow, issue: EligibleIssue): Promise<RunControl> {
    this.store.updateSession(session.id, { state: "implementing" });
    const digest = this.store.recentMergedSummaries(this.config.digest.recentMergedCount);
    const prompt = this.buildPrompt({ goal: this.config.product.goal, issue, digest });
    const worktreePath = session.worktreePath as string;
    let outcome: AgentOutcome;
    try {
      outcome = await this.agent.runSession({
        worktreePath,
        prompt,
        maxCostUsd: this.config.safety.maxCostUsdPerSession,
      });
    } catch (err) {
      return await this.stopSession(session, "exception", errMsg(err));
    }

    if (outcome.kind === "cost_exceeded") {
      this.store.updateSession(session.id, { costUsd: outcome.costUsd });
      await bestEffort(() => this.git.discardWorktree(session.branch, worktreePath));
      return await this.stopSession(session, "cost_exceeded", null, { costUsd: outcome.costUsd });
    }
    if (outcome.kind === "error") {
      this.store.updateSession(session.id, { costUsd: outcome.costUsd });
      return await this.stopSession(session, "exception", outcome.message, { costUsd: outcome.costUsd });
    }
    // completed: まず cost と summary を永続化（仕様 §7 IMPLEMENT 後条件）
    this.store.updateSession(session.id, { costUsd: outcome.costUsd, agentSummary: outcome.summary });
    if (await this.git.hasUncommittedChanges(worktreePath)) {
      return await this.stopSession(session, "agent_no_change", "uncommitted leftovers", { costUsd: outcome.costUsd });
    }
    if (!(await this.git.hasCommitsWithDiff(worktreePath))) {
      return await this.stopSession(session, "agent_no_change", null, { costUsd: outcome.costUsd });
    }
    return CONTINUE;
  }

  // ---- HANDOFF（仕様 §5.4） ----
  private async handoff(
    session: TaskSessionRow,
    issue: EligibleIssue,
  ): Promise<{ control: "halt" } | { control: "continue"; prNumber: number }> {
    this.store.updateSession(session.id, { state: "handing_off" });
    const worktreePath = session.worktreePath as string;
    let prNumber: number;
    try {
      const existing = await this.git.findOpenPrForBranch(session.branch);
      if (existing !== null) {
        prNumber = existing;
      } else {
        prNumber = await this.git.pushAndOpenPr(session.branch, worktreePath, issue);
      }
      // PR 番号を即時永続化（仕様 §5.4 ③）
      this.store.updateSession(session.id, { prNumber });
      await retry(3, () => this.git.addLabel(prNumber, this.config.looppilot.gateLabel));
      await retry(3, () => this.source.transition(issue.id, "in_review"));
    } catch (err) {
      const prText = describePr(this.store.getSession(session.id).prNumber);
      const ctrl = await this.stopSession(session, "handoff_failed", `handoff failed (${prText}): ${errMsg(err)}`);
      return ctrl;
    }
    // in_review 入りと監視起点を同一 patch で原子的に設定（仕様 §5.4 ⑤）
    this.store.updateSession(session.id, { state: "in_review", monitorStartedAt: this.clock() });
    return { control: "continue", prNumber };
  }

  // ---- MONITOR（仕様 §5.5 / §5.4 / §6） ----
  private async monitorSession(session: TaskSessionRow, prNumber: number): Promise<RunControl> {
    const pollIntervalMs = this.config.loop.monitorPollSeconds * 1000;
    let pollFailures = 0;
    let backoffMultiplier = 1;
    while (true) {
      await this.sleep(pollIntervalMs * backoffMultiplier);
      let verdict: MonitorVerdict;
      try {
        verdict = await this.monitor.poll(prNumber);
      } catch (err) {
        // poll throw → バックオフ（×2..×8）、5連続で stopped(exception)
        pollFailures += 1;
        if (pollFailures >= 5) {
          return await this.stopSession(session, "exception", `monitor poll failed 5x: ${errMsg(err)}`);
        }
        backoffMultiplier = Math.min(backoffMultiplier * 2, 8);
        continue;
      }
      pollFailures = 0;
      backoffMultiplier = 1;

      switch (verdict.kind) {
        case "merged":
          return CONTINUE; // DONE へ
        case "done": {
          const ctrl = await this.tryMerge(session, prNumber);
          if (ctrl === "merged") return CONTINUE;
          if (ctrl === "halt") return HALT;
          continue; // 続行（次ポーリング）
        }
        case "stopped":
          return await this.stopSession(
            session,
            "looppilot_stopped",
            verdict.stopReason ?? "looppilot stopped (no reason)",
          );
        case "pr_closed":
          return await this.stopSession(session, "pr_closed", null);
        case "corrupted":
          return await this.stopSession(
            session,
            "monitor_never_engaged",
            "looppilot-state comment present but corrupted",
          );
        case "not_engaged": {
          if (this.elapsedMinutesSinceMonitorStart(session.id) > this.config.safety.notEngagedGuardMinutes) {
            return await this.stopSession(session, "monitor_never_engaged", null);
          }
          continue;
        }
        case "in_progress": {
          const timeout = this.config.safety.monitorTimeoutMinutes;
          if (timeout !== undefined && this.elapsedMinutesSinceMonitorStart(session.id) > timeout) {
            return await this.stopSession(session, "exception", "monitor timeout");
          }
          continue;
        }
      }
    }
  }

  /** done verdict 時のマージ試行。"merged" | "continue" | "halt" を返す */
  private async tryMerge(session: TaskSessionRow, prNumber: number): Promise<"merged" | "continue" | "halt"> {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return "continue";
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return "halt";
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return "halt";
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return "halt";
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return "merged";
    } catch {
      // 次ポーリングで再評価（mergePr 連続失敗の fail-closed は Task 13 で精密化）
      return "continue";
    }
  }

  // ---- DONE（仕様 §5.6 / §7） ----
  private async done(session: TaskSessionRow, issue: EligibleIssue): Promise<void> {
    this.store.updateSession(session.id, { state: "merged", endedAt: this.clock() });
    try {
      await retry(3, () => this.source.transition(issue.id, "done"));
    } catch (err) {
      // best-effort：失敗してもコンソール警告のみで Run=running 維持（仕様 §5.6 注記）
      this.log(`warning: transition(done) failed for ${issue.identifier}: ${errMsg(err)}`);
    }
    const mergedCount = this.store.countMerged(this.runId);
    this.log(`merged ${issue.identifier} (merged_count=${mergedCount})`);
  }

  // ---- 共通の STOPPED 終端（仕様 §7） ----
  private async stopSession(
    session: TaskSessionRow,
    reason: FailureReason,
    detail: string | null,
    extraPatch: Partial<Pick<TaskSessionRow, "costUsd" | "prNumber">> = {},
  ): Promise<{ control: "halt" }> {
    this.store.updateSession(session.id, {
      state: "stopped",
      failureReason: reason,
      stopDetail: detail,
      endedAt: this.clock(),
      ...extraPatch,
    });
    const haltDetail = `${session.linearIdentifier} stopped (${reason})${detail ? `: ${detail}` : ""}`;
    await this.notifier.notify({ kind: "halted", reason, detail: haltDetail });
    this.store.setRunState(this.runId, "halted", haltDetail);
    this.log(haltDetail);
    return HALT;
  }

  private elapsedMinutesSinceMonitorStart(sessionId: number): number {
    const fresh = this.store.getSession(sessionId);
    if (fresh.monitorStartedAt === null) return 0;
    const startMs = Date.parse(fresh.monitorStartedAt);
    const nowMs = Date.parse(this.clock());
    return (nowMs - startMs) / 60000;
  }
}

// ---- module-private helpers ----
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describePr(prNumber: number | null): string {
  return prNumber === null ? "no PR created" : `PR #${prNumber}`;
}

async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // 破棄/復帰のベストエフォート。失敗は無視。
  }
}

async function retry(times: number, fn: () => Promise<void>): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < times; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts
```

期待: 1チケット完走テストが pass。

- [ ] **Step 4: `npm run check` で全体（tsc×2 + vitest）green を確認する**

```
npm run check
```

期待: 既存タスクのテスト含め全て pass、型エラーなし。失敗（例: `Config` の必須フィールドが makeConfig に不足）が出たら、`makeConfig` の `as unknown as Config` キャストでテスト型は通っているはずなので、`src/config.ts` の `Config` 型に存在するフィールド名と本実装の参照名（`safety.maxTasksPerRun` 等）が一致しているか確認する。不一致が **カーネル §3 と矛盾** していたら openQuestions に上げる（勝手に直さない）。

- [ ] **Step 5: red-green の単位でコミットする（フェイク＋正常系コア）**

```
git add src/orchestrator.ts tests/fakes.ts tests/orchestrator.test.ts
git commit -m "feat: Orchestrator core happy path (select→claim→implement→handoff→monitor→done)"
```

- [ ] **Step 6: 2チケット逐次のテストを追加（red）**

`tests/orchestrator.test.ts` に describe ブロックを追記する:

```typescript
describe("Orchestrator 正常系 — 2チケット逐次（仕様 §3 逐次・§5 ループ）", () => {
  it("2件を順に完走し、両方 merged・状態遷移の順序が記録される", async () => {
    const config = makeConfig({ maxTasksPerRun: 2 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A done" },
      { kind: "completed", costUsd: 2, summary: "B done" },
    ];
    // 各セッション: done → merged
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    const sessions = h.store.sessionsForRun(runId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.linearIdentifier)).toEqual(["TY-1", "TY-2"]);
    expect(sessions.every((s) => s.state === "merged")).toBe(true);
    expect(h.store.countMerged(runId)).toBe(2);

    // Linear への遷移列（仕様 §5）: 各チケット in_progress → in_review → done
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
      { issueId: "issue-B", state: "in_progress" },
      { issueId: "issue-B", state: "in_review" },
      { issueId: "issue-B", state: "done" },
    ]);

    // 2件目の SELECT 時、1件目はもう active ではない（merged）→ excludeIds は空のまま
    // （冪等性: 進行中セッションだけ除外。merged は除外対象外）
    expect(h.source.eligibleCalls.length).toBe(2); // A選定 / B選定（3反復目は taskCap 到達で SELECT 前に HALT）
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "2チケット逐次"
```

期待: 初回は green になるはず（コアは既に2件を回せる設計）。もし遷移列やカウントがずれて落ちたら、`done()` の transition 呼び出し位置・`loop()` のタスク上限チェック位置を仕様 §5 と突き合わせて調整する。green を確認する。

- [ ] **Step 7: 状態遷移列の検証テストを追加（TaskSession.state の軌跡）**

`tests/orchestrator.test.ts` に追記。SqliteStore は state を上書きするため軌跡を直接は持たないので、`buildPrompt` 呼び出し時点・各フェイク呼び出し順から軌跡を検証する形にする:

```typescript
describe("Orchestrator 正常系 — フェーズ順序（仕様 §5 状態機械の呼び出し列）", () => {
  it("1チケットで claim→implement→handoff→monitor→done の外部呼び出しが正しい順序で起きる", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    // Git/PR 呼び出しの順序（封筒の操作列）
    const gitMethods = h.git.calls.map((c) => c.method);
    expect(gitMethods).toEqual([
      "prepareWorktree",    // CLAIM
      "hasUncommittedChanges", // IMPLEMENT 後条件（先に残骸チェック）
      "hasCommitsWithDiff",    // IMPLEMENT 後条件（次に実差分チェック）
      "findOpenPrForBranch",   // HANDOFF（既存PR確認）
      "pushAndOpenPr",         // HANDOFF（新規PR）
      "addLabel",              // HANDOFF（ゲートラベル）
      "mergePr",               // DONE経路（done verdict→ready→merge）
    ]);

    // run_started 通知が最初に 1 回だけ送られる（halted/idle は出ない）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started"]);

    // エージェントへ渡された prompt 引数（文脈バンドル）の検証
    expect(h.promptArgs).toHaveLength(1);
    expect(h.promptArgs[0].goal).toBe("ship the product");
    expect(h.promptArgs[0].issue.identifier).toBe("TY-1");
    expect(Array.isArray(h.promptArgs[0].digest)).toBe(true);

    // agent に渡された SessionContext
    expect(h.agent.contexts).toHaveLength(1);
    expect(h.agent.contexts[0].prompt).toBe("PROMPT for TY-1");
    expect(h.agent.contexts[0].maxCostUsd).toBe(10);
    expect(h.agent.contexts[0].worktreePath).toBe("/wt/ty-1");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "フェーズ順序"
```

期待: green。落ちたら IMPLEMENT 後条件の呼び出し順（仕様 §7: hasUncommittedChanges を先、hasCommitsWithDiff を後）と HANDOFF の findOpenPrForBranch→pushAndOpenPr 順を実装と突き合わせる。

- [ ] **Step 8: monitorStartedAt と transition 呼び出し列・通知列の単体検証を補強（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — 監視起点と Linear 遷移（仕様 §5.4 / §5.6）", () => {
  it("in_review 入りで monitorStartedAt が clock() の値で設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // fixedClock は呼ぶ度に +1s。monitorStartedAt は ISO 文字列で非 null。
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);

    // transition は in_progress → in_review → done の 3 回
    expect(h.source.transitions).toEqual([
      { issueId: "issue-A", state: "in_progress" },
      { issueId: "issue-A", state: "in_review" },
      { issueId: "issue-A", state: "done" },
    ]);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "監視起点と Linear 遷移"
```

期待: green。

- [ ] **Step 9: ここまでの正常系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator sequential, phase-order, and monitor-start coverage"
```

- [ ] **Step 10: タスク上限 HALT のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — タスク上限 HALT（仕様 §11 / §5.1）", () => {
  it("taskCap=1 でキューに2件あっても1件だけ完走し、上限到達で HALT 通知して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    // 1件だけ着手・完走
    expect(h.store.countTasksStarted(run.id)).toBe(1);
    expect(h.store.countMerged(run.id)).toBe(1);
    // 2件目は未着手のままキューに残る
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-2"]);

    // Run は halted・理由は task cap
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("task cap reached");

    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    const halted = h.notifier.events.find((e) => e.kind === "halted");
    expect(halted).toMatchObject({ kind: "halted", reason: "task_cap" });
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "タスク上限 HALT"
```

期待: green。落ちたら `loop()` の上限チェックが「SELECT より前・各反復先頭」にあるか、`countTasksStarted` の比較が `>=` か（仕様 §11: 到達で HALT）を確認する。

- [ ] **Step 11: IDLE→復帰のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記。`FakeTaskSource.getNextEligible` を「最初は null、次は復帰した issue」と振る舞わせるため、フェイクの `queue` を空で開始し、`instantSleep`（sleep 呼び出し後に解決）後に手を入れる。フェイクは決定的に動かしたいので、`getNextEligible` を回数で出し分けるラッパを差し込む形にする（フェイク本体は改変しない）:

```typescript
describe("Orchestrator 正常系 — IDLE→復帰（仕様 §5.1 / §10）", () => {
  it("最初キュー空で IDLE 通知＋sleep、再確認で復帰して1件完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1, idleRecheckSeconds: 300 });
    const h = makeHarness(config);

    // getNextEligible: 1回目 null（IDLE）、2回目以降は復帰した issue を返す
    let eligibleCall = 0;
    const recovered = issue("issue-A", "TY-1");
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      eligibleCall += 1;
      if (eligibleCall === 1) return null; // 初回 IDLE
      // 復帰後は1回だけ issue を流し、それ以降は queue 経由
      if (eligibleCall === 2) return recovered;
      return origGetNext(excludeIds);
    };

    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const runId = h.store.latestRun()!.id;
    expect(h.store.countMerged(runId)).toBe(1);

    // IDLE 通知が初回のみ送られた（run_started → idle → halted(task_cap)）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "idle", "halted"]);

    // IDLE 中に idle_recheck_seconds*1000 で sleep した
    expect(h.sleepCalls).toContain(config.loop.idleRecheckSeconds * 1000);

    // 復帰後 Run は running を経て、最終的に halted（taskCap=1 到達）
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});
```

> 注: 上のテストはフェイクのメソッドを差し替える（フェイク本体は改変しない）。`origGetNext` 経由のフォールバックは安全網であり、taskCap=1 のため呼ばれない見込み。`sleepCalls` には MONITOR の poll 間隔 sleep も混ざるので `toContain` で IDLE の sleep だけを検証する。

実行:

```
npx vitest run tests/orchestrator.test.ts -t "IDLE"
```

期待: green。落ちたら IDLE 分岐で `setRunState(idle)` → `sleep(idleRecheckSeconds*1000)` → `continue` し、復帰時に `setRunState(running)` する流れと、`idle` 通知が初回のみ（`idleNotified` フラグ）であることを確認する。

- [ ] **Step 12: PR 再利用（findOpenPrForBranch ヒット）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に追記:

```typescript
describe("Orchestrator 正常系 — 既存PR再利用（仕様 §5.4 二重PR禁止）", () => {
  it("findOpenPrForBranch が既存PR番号を返したら pushAndOpenPr を呼ばずそのPRで監視する", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // prepareWorktree が返すブランチを固定し、その branch に既存PR #777 をセット
    const branch = "looppilot/ty-1-x";
    h.git.claimResults.set("TY-1", { branch, worktreePath: "/wt/ty-1" });
    h.git.openPrForBranch.set(branch, 777);

    await h.orch.run();

    // pushAndOpenPr は呼ばれない
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    // 既存 PR 番号で永続化・ラベル付与・マージ
    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.prNumber).toBe(777);
    expect(h.git.calls).toContainEqual({ method: "addLabel", args: [777, "loop-pilot"] });
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [777, "sha-777"] });
    expect(s.state).toBe("merged");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "既存PR再利用"
```

期待: green。落ちたら HANDOFF の分岐（`findOpenPrForBranch !== null` で `pushAndOpenPr` をスキップ）を確認する。`mergePr` の headSha は `FakeMonitor.checkMergeReadiness` の既定 `sha-${prNumber}`。

- [ ] **Step 13: 正常系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator task-cap HALT, IDLE recovery, PR reuse"
```

- [ ] **Step 14: `npm run check` で最終 green を確認する**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。型・シグネチャがカーネル §2/§4/§6/§7 と一致していること。失敗が残る場合、カーネルとの矛盾が原因なら openQuestions に記録し、コードは勝手に改変しない。

- [ ] **Step 15: 仕上げコミット（必要なら）**

ここまでで `src/orchestrator.ts`（正常系コア＋失敗終端の型上最小実装）と `tests/fakes.ts`（残りフェイク）と `tests/orchestrator.test.ts`（正常系 6 シナリオ）が揃う。差分が未コミットなら:

```
git add src/orchestrator.ts tests/fakes.ts tests/orchestrator.test.ts
git commit -m "chore: finalize Orchestrator happy-path task"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` が `Orchestrator` クラスをエクスポートし、`run()` で ランロック取得→Run 作成→run_started 通知→`recoverPendingSessions()`（空実装）→ループ（SELECT/CLAIM/IMPLEMENT/HANDOFF/MONITOR/DONE）を回す。
- `tests/fakes.ts` に `FakeTaskSource` / `FakeAgentRunner` / `FakeGitPr` / `FakeMonitor` / `FakeNotifier` がカーネル §6 のシグネチャで追記されている。
- `tests/orchestrator.test.ts` の正常系 6 シナリオ（1チケット完走 / 2チケット逐次 / フェーズ順序 / 監視起点と遷移 / タスク上限 HALT / IDLE→復帰 / 既存PR再利用）が全て green。
- `recoverPendingSessions()` は本タスクでは no-op（Task 14 が中身を実装）。
- 失敗系の網羅テストは Task 13。本実装は失敗遷移が型上通る最小形（`stopSession` / `tryMerge` / `claim` の失敗分岐）を含むが、テストは正常系のみ。
- `npm run check` が green。
