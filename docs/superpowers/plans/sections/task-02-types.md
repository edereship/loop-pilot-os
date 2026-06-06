### Task 2: 共有型 types.ts

**目的**: カーネル §2 の TypeScript ブロックを `src/types.ts` として一字一句転記し、全後続タスク（3-17）が依存する共有ドメイン型・モジュールインターフェースの単一 source of truth を確定する。Task 1 が残した `tests/smoke.test.ts` を削除し、型が壊れたら `npm run check`（tsc）が失敗するよう、コンパイル時の型検証テスト（`satisfies` によるユニオン網羅・代入テスト・判別可能性）を `tests/types.test.ts` に置く。

**依存タスク**: Task 1（リポ雛形 + CI + tsconfig×2 + vitest.config + `tests/smoke.test.ts`）。本タスクはコード値を生成せず型のみを export するため、Task 3-17 はすべて本タスクの export に依存する（カーネル §10 の依存図 `1→2→3→...`）。

**Files:**

- Create: `/home/racoma-dev/loop-pilot-os/src/types.ts`
- Create: `/home/racoma-dev/loop-pilot-os/tests/types.test.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/types.test.ts`（型レベル検証。実行時アサーションは判別可能ユニオンの絞り込みのみ）
- Modify: なし（削除のみ。`/home/racoma-dev/loop-pilot-os/tests/smoke.test.ts` を `git rm`）

すべての `git`/`npm` コマンドは `/home/racoma-dev/loop-pilot-os` をカレントとして実行する（Task 1 で `git init` 済み。`cd` を避けるため必要なら `git -C /home/racoma-dev/loop-pilot-os ...` / `npm --prefix /home/racoma-dev/loop-pilot-os run check` で代替してよい）。

#### ステップ

- [ ] **Step 1: `tests/smoke.test.ts` を削除する**

  Task 1 が CI を緑にするためだけに置いた仮テストを除去する。先に削除しておくことで、Step 4 で本タスクの型テストが「唯一の」テストとして失敗→成功する様子を観測できる。

  ```bash
  git rm tests/smoke.test.ts
  ```

  期待出力（ファイルが存在する場合）:
  ```
  rm 'tests/smoke.test.ts'
  ```

  もし Task 1 がスモークテストを別名で置いた、または置いていない場合は本ステップをスキップしてよい（その場合 `tests/` には本タスク後 `types.test.ts` のみが残る）。

- [ ] **Step 2: 失敗するテスト `tests/types.test.ts` を書く**

  `src/types.ts` がまだ存在しないため、import 解決に失敗してコンパイルエラー（= `npm run check` の tsc で失敗）になることを先に確認するためのテストを置く。テストは型レベル検証が中心で、`satisfies` でユニオンの網羅性を固定し、代入互換性で各インターフェースの構造を固定し、判別可能ユニオン（`AgentOutcome` / `MonitorVerdict` / `MergeReadiness` / `NotifyEvent`）の `kind`/`ready` による絞り込みを実行時にも 1 件アサートする。

  ファイル全文（`tests/types.test.ts`）:

  ```typescript
  import { describe, it, expect } from "vitest";
  import type {
    SessionState,
    RunState,
    FailureReason,
    EligibleIssue,
    TicketState,
    RunRow,
    TaskSessionRow,
    TaskSource,
    SessionContext,
    AgentOutcome,
    AgentRunner,
    ClaimResult,
    GitPrManager,
    MonitorVerdict,
    MergeReadiness,
    LoopPilotMonitor,
    NotifyEvent,
    Notifier,
    PromptArgs,
    CommandResult,
    RunOptions,
    CommandRunner,
  } from "../src/types.js";

  // 仕様 §7「状態語彙」: 各ユニオンのメンバを satisfies で固定する。
  // メンバの追加・削除・改名は satisfies の網羅で型エラーになり、tsc(npm run check)が落ちる。

  describe("状態語彙ユニオン（仕様 §7）", () => {
    it("SessionState は claimed/implementing/handing_off/in_review/merged/stopped の 6 値である", () => {
      const all = [
        "claimed",
        "implementing",
        "handing_off",
        "in_review",
        "merged",
        "stopped",
      ] as const satisfies readonly SessionState[];
      // 双方向固定: SessionState の各値が all に含まれることを exhaustive switch で保証する。
      const ensureExhaustive = (s: SessionState): (typeof all)[number] => {
        switch (s) {
          case "claimed":
          case "implementing":
          case "handing_off":
          case "in_review":
          case "merged":
          case "stopped":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(6);
    });

    it("RunState は running/idle/halted の 3 値である", () => {
      const all = ["running", "idle", "halted"] as const satisfies readonly RunState[];
      const ensureExhaustive = (s: RunState): (typeof all)[number] => {
        switch (s) {
          case "running":
          case "idle":
          case "halted":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(3);
    });

    it("FailureReason は仕様 §7 の 10 種の失敗理由を網羅する", () => {
      const all = [
        "agent_no_change",
        "cost_exceeded",
        "exception",
        "monitor_never_engaged",
        "looppilot_stopped",
        "ci_failed",
        "merge_conflict",
        "pr_closed",
        "claim_failed",
        "handoff_failed",
      ] as const satisfies readonly FailureReason[];
      // exhaustive switch で逆方向（FailureReason ⊆ all）も固定する。
      const ensureExhaustive = (r: FailureReason): (typeof all)[number] => {
        switch (r) {
          case "agent_no_change":
          case "cost_exceeded":
          case "exception":
          case "monitor_never_engaged":
          case "looppilot_stopped":
          case "ci_failed":
          case "merge_conflict":
          case "pr_closed":
          case "claim_failed":
          case "handoff_failed":
            return r;
          default: {
            const never: never = r;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(10);
    });

    it("TicketState は todo/in_progress/in_review/done の 4 値である", () => {
      const all = ["todo", "in_progress", "in_review", "done"] as const satisfies readonly TicketState[];
      const ensureExhaustive = (s: TicketState): (typeof all)[number] => {
        switch (s) {
          case "todo":
          case "in_progress":
          case "in_review":
          case "done":
            return s;
          default: {
            const never: never = s;
            return never;
          }
        }
      };
      expect(all.map(ensureExhaustive).length).toBe(4);
    });
  });

  describe("ドメイン行型の構造（仕様 §7 データモデル / カーネル §4 スキーマ）", () => {
    it("EligibleIssue は Linear 由来の 7 フィールドを持つ", () => {
      const issue = {
        id: "11111111-2222-3333-4444-555555555555",
        identifier: "TY-123",
        title: "サンプル",
        description: "",
        priority: 2,
        sortOrder: 0.5,
        url: "https://linear.app/team-yubune/issue/TY-123",
      } satisfies EligibleIssue;
      expect(issue.identifier).toBe("TY-123");
    });

    it("RunRow は haltReason に null を許容する", () => {
      const row = {
        id: 1,
        startedAt: "2026-06-05T00:00:00.000Z",
        taskCap: 3,
        state: "running",
        haltReason: null,
      } satisfies RunRow;
      expect(row.haltReason).toBeNull();
    });

    it("TaskSessionRow は nullable 列（worktreePath/prNumber/costUsd/failureReason/stopDetail/agentSummary/monitorStartedAt/endedAt）を許容する", () => {
      const row = {
        id: 1,
        runId: 1,
        linearIssueId: "11111111-2222-3333-4444-555555555555",
        linearIdentifier: "TY-123",
        issueTitle: "サンプル",
        branch: "looppilot/ty-123-sample",
        worktreePath: null,
        prNumber: null,
        state: "claimed",
        costUsd: null,
        failureReason: null,
        stopDetail: null,
        agentSummary: null,
        startedAt: "2026-06-05T00:00:00.000Z",
        monitorStartedAt: null,
        endedAt: null,
      } satisfies TaskSessionRow;
      // 充填済みのバリアントも型を満たすこと（failureReason に FailureReason のメンバが入る）。
      const filled = {
        ...row,
        worktreePath: "/tmp/wt",
        prNumber: 42,
        state: "stopped" as const,
        costUsd: 1.5,
        failureReason: "cost_exceeded" as const,
        stopDetail: "budget",
        agentSummary: "did work",
        monitorStartedAt: "2026-06-05T00:01:00.000Z",
        endedAt: "2026-06-05T00:02:00.000Z",
      } satisfies TaskSessionRow;
      expect(filled.prNumber).toBe(42);
    });
  });

  describe("判別可能ユニオン（カーネル §2 / 仕様 §5-§6）", () => {
    it("AgentOutcome は kind で completed/cost_exceeded/error を判別できる", () => {
      const outcome: AgentOutcome = { kind: "completed", costUsd: 2, summary: "ok" };
      // 絞り込みで summary に到達できることを実行時にも確認する。
      const summary = outcome.kind === "completed" ? outcome.summary : null;
      expect(summary).toBe("ok");

      const variants = [
        { kind: "completed", costUsd: 2, summary: "ok" },
        { kind: "cost_exceeded", costUsd: 10 },
        { kind: "error", costUsd: 0, message: "boom" },
      ] as const satisfies readonly AgentOutcome[];
      expect(variants).toHaveLength(3);
    });

    it("MonitorVerdict は kind で 7 バリアントを判別でき、stopped は stopReason に null を保持できる（仕様 §6）", () => {
      // 列挙順は precedence ではない（カーネル §2 注記）。網羅性のみ固定する。
      const variants = [
        { kind: "merged" },
        { kind: "done" },
        { kind: "stopped", stopReason: null },
        { kind: "stopped", stopReason: "build failed" },
        { kind: "in_progress" },
        { kind: "corrupted" },
        { kind: "not_engaged" },
        { kind: "pr_closed" },
      ] as const satisfies readonly MonitorVerdict[];

      const describe = (v: MonitorVerdict): string => {
        switch (v.kind) {
          case "merged":
            return "merged";
          case "done":
            return "done";
          case "stopped":
            // stopReason は string | null（null をそのまま保持する）。
            return v.stopReason ?? "stopped(no reason)";
          case "in_progress":
            return "in_progress";
          case "corrupted":
            return "corrupted";
          case "not_engaged":
            return "not_engaged";
          case "pr_closed":
            return "pr_closed";
          default: {
            const never: never = v;
            return never;
          }
        }
      };
      expect(variants.map(describe)).toContain("stopped(no reason)");
    });

    it("MergeReadiness は ready の真偽で headSha 有無と reason を判別できる（カーネル §5.3）", () => {
      const ready: MergeReadiness = { ready: true, headSha: "abc123" };
      const headSha = ready.ready ? ready.headSha : null;
      expect(headSha).toBe("abc123");

      const reasons = [
        { ready: false, reason: "ci_pending" },
        { ready: false, reason: "ci_failed" },
        { ready: false, reason: "conflict" },
        { ready: false, reason: "blocked" },
        { ready: false, reason: "unknown" },
      ] as const satisfies readonly MergeReadiness[];
      expect(reasons).toHaveLength(5);
    });

    it("NotifyEvent は kind で halted/idle/run_started を判別できる（仕様 §10）", () => {
      const events = [
        { kind: "halted", reason: "task_cap", detail: "limit reached" },
        { kind: "idle", detail: "queue empty" },
        { kind: "run_started", detail: "started" },
      ] as const satisfies readonly NotifyEvent[];
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["halted", "idle", "run_started"]);
    });
  });

  describe("モジュールインターフェース（カーネル §2 / 仕様 §4）", () => {
    it("PromptArgs.digest は store.recentMergedSummaries の戻り型と同型である", () => {
      const args: PromptArgs = {
        goal: "ship it",
        issue: {
          id: "11111111-2222-3333-4444-555555555555",
          identifier: "TY-1",
          title: "t",
          description: "",
          priority: 0,
          sortOrder: 0,
          url: "https://x",
        },
        digest: [
          { linearIdentifier: "TY-0", issueTitle: "prev", agentSummary: "merged earlier" },
          { linearIdentifier: "TY-2", issueTitle: "prev2", agentSummary: null },
        ],
      };
      expect(args.digest).toHaveLength(2);
    });

    it("CommandResult / RunOptions / CommandRunner の構造を満たすフェイク実装が代入できる", () => {
      const result: CommandResult = { code: 0, stdout: "", stderr: "" };
      const opts: RunOptions = { cwd: "/repo" };
      const runner: CommandRunner = {
        run: async (_cmd: string, _args: string[], _opts: RunOptions): Promise<CommandResult> => result,
      };
      expect(opts.cwd).toBe("/repo");
      expect(runner.run).toBeTypeOf("function");
    });

    it("TaskSource / AgentRunner / GitPrManager / LoopPilotMonitor / Notifier はインターフェースを満たす実装に代入できる", () => {
      const eligible: EligibleIssue = {
        id: "11111111-2222-3333-4444-555555555555",
        identifier: "TY-1",
        title: "t",
        description: "",
        priority: 0,
        sortOrder: 0,
        url: "https://x",
      };
      const claim: ClaimResult = { branch: "looppilot/ty-1-t", worktreePath: "/tmp/wt" };
      const ctx: SessionContext = { worktreePath: "/tmp/wt", prompt: "p", maxCostUsd: 10 };
      const completed: AgentOutcome = { kind: "completed", costUsd: 1, summary: "ok" };
      const verdict: MonitorVerdict = { kind: "in_progress" };
      const readiness: MergeReadiness = { ready: false, reason: "ci_pending" };
      const event: NotifyEvent = { kind: "run_started", detail: "go" };

      const source: TaskSource = {
        getNextEligible: async (_excludeIds: string[]): Promise<EligibleIssue | null> => eligible,
        transition: async (_issueId: string, _state: TicketState): Promise<void> => {},
        findOrphanedInProgress: async (_knownIssueIds: string[]): Promise<EligibleIssue[]> => [],
      };
      const agent: AgentRunner = {
        runSession: async (_ctx: SessionContext): Promise<AgentOutcome> => completed,
      };
      const git: GitPrManager = {
        prepareWorktree: async (_issue: EligibleIssue): Promise<ClaimResult> => claim,
        hasCommitsWithDiff: async (_worktreePath: string): Promise<boolean> => true,
        hasUncommittedChanges: async (_worktreePath: string): Promise<boolean> => false,
        findOpenPrForBranch: async (_branch: string): Promise<number | null> => null,
        pushAndOpenPr: async (
          _branch: string,
          _worktreePath: string,
          _issue: EligibleIssue,
        ): Promise<number> => 1,
        addLabel: async (_prNumber: number, _label: string): Promise<void> => {},
        mergePr: async (_prNumber: number, _headSha: string): Promise<void> => {},
        discardWorktree: async (_branch: string, _worktreePath: string): Promise<void> => {},
      };
      const monitor: LoopPilotMonitor = {
        poll: async (_prNumber: number): Promise<MonitorVerdict> => verdict,
        checkMergeReadiness: async (_prNumber: number): Promise<MergeReadiness> => readiness,
      };
      const notifier: Notifier = {
        notify: async (_event: NotifyEvent): Promise<void> => {},
        probeReachability: async (): Promise<void> => {},
      };

      expect(ctx.maxCostUsd).toBe(10);
      expect(event.kind).toBe("run_started");
      expect(source.getNextEligible).toBeTypeOf("function");
      expect(agent.runSession).toBeTypeOf("function");
      expect(git.prepareWorktree).toBeTypeOf("function");
      expect(monitor.poll).toBeTypeOf("function");
      expect(notifier.notify).toBeTypeOf("function");
    });
  });
  ```

- [ ] **Step 3: テストを実行して失敗を確認する（red）**

  `src/types.ts` が未作成のため、tsconfig.test.json 経由の tsc が import 解決に失敗する。`npm run check` は「tsc(src) + tsc(tests) + vitest」（カーネル §0）なので、まず型チェックで落ちることを確認する。

  ```bash
  npm run check
  ```

  期待される失敗（いずれか／両方）:
  ```
  tests/types.test.ts(2,8): error TS2307: Cannot find module '../src/types.js' or its corresponding type declarations.
  ```
  （tsc が通った場合でも vitest 実行時に `Failed to resolve import "../src/types.js"` で失敗する。いずれにせよ `npm run check` は非 0 終了する。）

- [ ] **Step 4: `src/types.ts` を作成する（カーネル §2 を一字一句転記）**

  カーネル §2 の TypeScript ブロックをコメント込みで完全転記する。改名・引数追加・型変更は禁止（カーネルが正）。`StateStore` 注記（カーネル §2 末尾の散文）はコードブロック外なので転記しない。

  ファイル全文（`src/types.ts`）:

  ```typescript
  // ---- 状態語彙（仕様 §7） ----
  export type SessionState =
    | "claimed" | "implementing" | "handing_off" | "in_review" | "merged" | "stopped";
  export type RunState = "running" | "idle" | "halted";
  export type FailureReason =
    | "agent_no_change"        // コミット無し/空差分/未コミット残骸（stop_detail で区別）
    | "cost_exceeded"
    | "exception"
    | "monitor_never_engaged"
    | "looppilot_stopped"      // stop_detail に LoopPilot の stopReason
    | "ci_failed"
    | "merge_conflict"
    | "pr_closed"
    | "claim_failed"
    | "handoff_failed";

  // ---- ドメイン ----
  export interface EligibleIssue {
    id: string;          // Linear UUID
    identifier: string;  // "TY-123"
    title: string;
    description: string; // markdown（空文字あり得る）
    priority: number;    // Linear生値: 0=None,1=Urgent,2=High,3=Medium,4=Low
    sortOrder: number;
    url: string;
  }

  export type TicketState = "todo" | "in_progress" | "in_review" | "done";

  export interface RunRow {
    id: number;
    startedAt: string;        // ISO-8601 UTC
    taskCap: number;
    state: RunState;
    haltReason: string | null;
  }

  export interface TaskSessionRow {
    id: number;
    runId: number;
    linearIssueId: string;
    linearIdentifier: string;
    issueTitle: string;
    branch: string;
    worktreePath: string | null;
    prNumber: number | null;
    state: SessionState;
    costUsd: number | null;
    failureReason: FailureReason | null;
    stopDetail: string | null;     // looppilot stopReason / 例外メッセージ等
    agentSummary: string | null;
    startedAt: string;
    monitorStartedAt: string | null; // in_review 入り時刻。未起動ガード/監視timeoutの起点（再起動でリセットしない）
    endedAt: string | null;
  }

  // ---- モジュールインターフェース（仕様 §4） ----
  export interface TaskSource {
    /** 適格(Team/PJ ∧ Todo ∧ オプトインラベル)を決定的順序で。excludeIds は Store 由来 */
    getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null>;
    transition(issueId: string, state: TicketState): Promise<void>;
    /** In Progress なのに渡された issueIds に無いチケット（CLAIM途中クラッシュ孤児）を返す */
    findOrphanedInProgress(knownIssueIds: string[]): Promise<EligibleIssue[]>;
  }

  export interface SessionContext {
    worktreePath: string;
    prompt: string;
    maxCostUsd: number;
  }
  export type AgentOutcome =
    | { kind: "completed"; costUsd: number; summary: string }
    | { kind: "cost_exceeded"; costUsd: number }
    | { kind: "error"; costUsd: number; message: string };
  export interface AgentRunner {
    runSession(ctx: SessionContext): Promise<AgentOutcome>;
  }

  export interface ClaimResult { branch: string; worktreePath: string; }
  export interface GitPrManager {
    prepareWorktree(issue: EligibleIssue): Promise<ClaimResult>;   // 失敗は throw
    hasCommitsWithDiff(worktreePath: string): Promise<boolean>;    // origin/<defaultBranch>..HEAD の実差分
    hasUncommittedChanges(worktreePath: string): Promise<boolean>; // git status --porcelain
    findOpenPrForBranch(branch: string): Promise<number | null>;
    pushAndOpenPr(branch: string, worktreePath: string, issue: EligibleIssue): Promise<number>;
    addLabel(prNumber: number, label: string): Promise<void>;
    mergePr(prNumber: number, headSha: string): Promise<void>;     // squash --match-head-commit
    discardWorktree(branch: string, worktreePath: string): Promise<void>; // cost_exceeded 時の破棄
  }

  /** 列挙順は precedence ではない。poll() の決定順は §5.4（merged 最優先）が正 */
  export type MonitorVerdict =
    | { kind: "merged" }
    | { kind: "done" }            // looppilot-state.status=="done"（マージ可否は別判定）
    | { kind: "stopped"; stopReason: string | null }  // LoopPilot は stopped でも stopReason=null があり得る
    | { kind: "in_progress" }     // state コメントあり・進行中（initialized|waiting_codex|fixing）
    | { kind: "corrupted" }       // 信頼著者の state コメントは在るが JSON 破損/不正 status
    | { kind: "not_engaged" }     // 信頼できる state コメント未出現
    | { kind: "pr_closed" };      // マージ無しクローズ
  export type MergeReadiness =
    | { ready: true; headSha: string }
    | { ready: false; reason: "ci_pending" | "ci_failed" | "conflict" | "blocked" | "unknown" };
  export interface LoopPilotMonitor {
    poll(prNumber: number): Promise<MonitorVerdict>;
    checkMergeReadiness(prNumber: number): Promise<MergeReadiness>;
  }

  export type NotifyEvent =
    | { kind: "halted"; reason: string; detail: string }   // STOPPED→HALT / タスク上限
    | { kind: "idle"; detail: string }                      // キュー空
    | { kind: "run_started"; detail: string };              // 起動時
  export interface Notifier {
    notify(event: NotifyEvent): Promise<void>;  // コンソールは必ず成功。Slack失敗でも throw しない
    /** プリフライト専用: Slack設定時は Webhook へ直接POSTし非2xxで throw。未設定なら即resolve */
    probeReachability(): Promise<void>;
  }

  // ---- 文脈バンドル（context-bundle.ts） ----
  export interface PromptArgs {
    goal: string;                                   // config.product.goal
    issue: EligibleIssue;
    digest: Array<Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">>;
    // digest は store.recentMergedSummaries(config.digest.recentMergedCount) の戻り値そのまま
  }
  // context-bundle.ts は export function buildPrompt(args: PromptArgs): string を公開

  // ---- 実行コマンド抽象（git/gh/claude 共通） ----
  export interface CommandResult { code: number; stdout: string; stderr: string; }
  export interface RunOptions {
    cwd: string;
    env?: Record<string, string>;
    onStdoutLine?: (line: string) => void;  // stream-json 進捗用
    timeoutMs?: number;                      // 超過時 kill して reject
  }
  export interface CommandRunner {
    run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult>;
  }
  ```

  注意（転記時の不変条件）:
  - 改行位置・コメント文言・記号（`∧`, `..`, 全角コロン等）まで一致させる。
  - これは型のみのモジュール（値の export ゼロ）。`isolatedModules`（NodeNext 既定で有効想定）下でも、本ファイルは型だけを export するため type-only re-export の問題は起きない。`tests/types.test.ts` 側の import は `import type { ... }` を使う。

- [ ] **Step 5: テストを実行して成功を確認する（green）**

  ```bash
  npm run check
  ```

  期待出力（tsc が src/tests とも 0 件エラー → vitest 緑）:
  ```
  Test Files  1 passed (1)
       Tests  N passed (N)
  ```
  （`N` は `tests/types.test.ts` 内の `it` 数。エラー 0・終了コード 0 であること。）

- [ ] **Step 6: コミットする（red→green 1 単位）**

  ```bash
  git add src/types.ts tests/types.test.ts
  git commit -m "feat: add shared domain types and module interfaces (types.ts)

  Transcribe kernel §2 verbatim into src/types.ts; replace smoke test with
  compile-time type checks (satisfies exhaustiveness, discriminated-union narrowing)."
  ```

  注: Step 1 の `git rm tests/smoke.test.ts` がまだステージされている場合は、本コミットに含めてよい（`git add -A` ではなく明示パスで `git add tests/smoke.test.ts` を加えるか、`git status` で削除がステージ済みであることを確認してからコミットする）。`npm run check` が緑であることを確認済みであること。
