# ES-514: v4-B Foundation（handoff_head_sha + merge_gate_log + park ポリシー + config）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v4-B（マージ直前 破壊的変更ゲート）の基盤層 — 型・DB・config を追加する。ロジック（ゲート本体）は ES-521 が実装する。

**Architecture:** 既存の増分パターンを完全踏襲する。FailureReason/FailurePolicy への値追加（stop-reason.ts の `satisfies` が網羅を強制）、`task_session` への冪等 ALTER TABLE カラム追加、`groom_log`/`verify_log` 同型の監査テーブル `merge_gate_log`、`safety.*` への zod キー追加。**orchestrator.ts には一切手を入れない**（`park` ポリシーは型として追加するだけ。`stopSession` は `if (policy === ...)` 比較なので値追加はコンパイル安全で、`merge_gate_failed` を set するコードは ES-521 まで存在しないため実行時にも到達しない）。

**Tech Stack:** TypeScript (ESM, import は `.js` 拡張子必須), Node >= 24, better-sqlite3, zod, vitest

**Ticket:** [ES-514](https://linear.app/edereship/issue/ES-514) / **Spec:** `docs/superpowers/specs/2026-07-05-v4-merge-gate-design.md`（§1, §5, §6）

## Global Constraints

- 新規依存パッケージ追加禁止
- コード内コメントは日本語（既存スタイル踏襲）
- コミットは明示パス指定（`git add -A` 禁止 — node_modules symlink 混入事故の前例あり）
- 各タスク完了時に `npx vitest run <対象テスト>` がグリーンであること
- 型チェック: `npx tsc --noEmit` がグリーンであること（Task 5 の最後で全体確認）

---

### Task 1: FailureReason `merge_gate_failed` + FailurePolicy `park`

**Files:**
- Modify: `src/types.ts:15-28`（FailureReason union）
- Modify: `src/stop-reason.ts:3-19`（FailurePolicy + FAILURE_POLICY）
- Test: `tests/stop-reason.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `FailureReason` に `"merge_gate_failed"`、`FailurePolicy` に `"park"`、`FAILURE_POLICY.merge_gate_failed === "park"`。ES-521 の `stopSession` 分岐がこれを消費する。

- [ ] **Step 1: Write the failing test**

`tests/stop-reason.test.ts` の末尾（`classifyStopReason` の describe の後）に追加:

```ts
describe("FAILURE_POLICY (ES-514)", () => {
  it("routes merge_gate_failed to park", () => {
    expect(FAILURE_POLICY.merge_gate_failed).toBe("park");
  });
});
```

（`FAILURE_POLICY` は既にファイル冒頭で import 済み: `import { classifyStopReason, FAILURE_POLICY } from "../src/stop-reason.js";`）

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stop-reason.test.ts`
Expected: FAIL — `merge_gate_failed` プロパティが存在しないため TS コンパイルエラー（または undefined !== "park"）

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` — FailureReason union の末尾 `| "verify_failed";` を次に変更:

```ts
  | "verify_failed"
  | "merge_gate_failed";  // マージゲート fix 上限超過 → park（PR保留・ES-514）
```

`src/stop-reason.ts:3` — FailurePolicy を変更:

```ts
export type FailurePolicy = "halt" | "recover" | "abandon" | "park";
```

`src/stop-reason.ts` — `FAILURE_POLICY` の `verify_failed: "abandon",` の直後に追加:

```ts
  merge_gate_failed: "park",
```

（`satisfies Record<FailureReason, FailurePolicy>` がエントリ漏れをコンパイルエラーにするので、types.ts への値追加と同時にここも必須）

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/stop-reason.test.ts && npx tsc --noEmit`
Expected: PASS / 型エラーなし（`stopSession` は `if (policy === "recover")` 等の比較なので `park` 追加でコンパイルは壊れない）

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/stop-reason.ts tests/stop-reason.test.ts
git commit -m "feat: FailureReason merge_gate_failed + FailurePolicy park を追加 (ES-514)"
```

---

### Task 2: NotifyEvent `merge_gate_parked` + notifier フォーマッタ

**Files:**
- Modify: `src/types.ts:170-182`（NotifyEvent union）
- Modify: `src/notifier.ts:14-41`（formatNotifyEvent の switch）
- Test: `tests/notifier.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `NotifyEvent` に `{ kind: "merge_gate_parked"; identifier: string; prNumber: number; detail: string }`。ES-521 のパーク経路が emit する。

- [ ] **Step 1: Write the failing test**

`tests/notifier.test.ts` に追加（`formatNotifyEvent` を import している describe 内、なければ import に追加して新 describe）:

```ts
describe("formatNotifyEvent merge_gate_parked (ES-514)", () => {
  it("formats merge_gate_parked with identifier, PR number and detail", () => {
    expect(
      formatNotifyEvent({
        kind: "merge_gate_parked",
        identifier: "ES-999",
        prNumber: 42,
        detail: "公開 export の削除を検出",
      }),
    ).toBe("🚧 マージ保留 (needs-human): ES-999 PR #42 — 公開 export の削除を検出");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notifier.test.ts`
Expected: FAIL — `"merge_gate_parked"` は NotifyEvent に無い（TS エラー）

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` — NotifyEvent union の最終行 `| { kind: "task_skipped"; ... };` の `;` を外して次を追加:

```ts
  | { kind: "task_skipped"; identifier: string; reason: string; detail: string }
  | { kind: "merge_gate_parked"; identifier: string; prNumber: number; detail: string }; // ES-514: マージゲート上限超過でPR保留
```

`src/notifier.ts` — `formatNotifyEvent` の switch、`case "task_skipped":` の return の後に追加:

```ts
    case "merge_gate_parked":
      return `🚧 マージ保留 (needs-human): ${event.identifier} PR #${event.prNumber} — ${event.detail}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/notifier.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/notifier.ts tests/notifier.test.ts
git commit -m "feat: NotifyEvent merge_gate_parked を追加 (ES-514)"
```

---

### Task 3: `task_session.handoff_head_sha` カラム

**Files:**
- Modify: `src/types.ts:53-87`（TaskSessionRow）
- Modify: `src/store.ts`（RawSessionRow :162-196 / toSessionRow :197-233 / SESSION_PATCH_COLUMNS :366-392 / migrate() :447-541 / updateSession の Pick リスト :727-）
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `TaskSessionRow.handoffHeadSha: string | null` と `store.updateSession(id, { handoffHeadSha })`。ES-521 が HANDOFF 直後に `git rev-parse HEAD` の結果を書き込み、ゲートが差分基点として読む。

- [ ] **Step 1: Write the failing test**

`tests/store.test.ts` に追加（既存の `newStore()` ヘルパを使う）:

```ts
describe("handoffHeadSha (ES-514)", () => {
  it("defaults to null and persists via updateSession", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "ES-1",
      issueTitle: "t",
      branch: "b",
      worktreePath: "/tmp/wt",
      now: clock(),
    });
    expect(session.handoffHeadSha).toBeNull();
    store.updateSession(session.id, { handoffHeadSha: "abc1234def" });
    expect(store.getSession(session.id).handoffHeadSha).toBe("abc1234def");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `handoffHeadSha` は TaskSessionRow に無い（TS エラー）

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` — TaskSessionRow の `recoveryTurnAttempts: number;` 行の直後に追加:

```ts
  handoffHeadSha: string | null; // HANDOFF 時の PR head SHA。マージゲートの累積差分基点（ES-514）
```

`src/store.ts` — 4 箇所:

1. `RawSessionRow` の `recovery_turn_attempts: number;` の直後:

```ts
  handoff_head_sha: string | null;
```

2. `toSessionRow` の `recoveryTurnAttempts: r.recovery_turn_attempts,` の直後:

```ts
    handoffHeadSha: r.handoff_head_sha,
```

3. `SESSION_PATCH_COLUMNS` の `recoveryTurnAttempts: "recovery_turn_attempts",` の直後:

```ts
  handoffHeadSha: "handoff_head_sha",
```

4. `migrate()` の task_session ブロック末尾、`if (!columns.has("issue_description")) { ... }` の直後:

```ts
    if (!columns.has("handoff_head_sha")) {
      this.db.exec(`ALTER TABLE task_session ADD COLUMN handoff_head_sha TEXT`);
    }
```

（SCHEMA の CREATE TABLE は変更しない — 新規 DB もコンストラクタが migrate() を通るため ALTER で列が入る。design_review_attempts 以降の列と同じ流儀）

5. `updateSession` の `Partial<Pick<TaskSessionRow, ...>>` union リストに `| "handoffHeadSha"` を追加（`| "recoveryTurnAttempts"` の直後）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts && npx tsc --noEmit`
Expected: PASS（既存テストも全て PASS のまま）

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts tests/store.test.ts
git commit -m "feat: task_session.handoff_head_sha カラムを追加 (ES-514)"
```

---

### Task 4: 監査テーブル `merge_gate_log`

**Files:**
- Modify: `src/types.ts`（GroomLogRow :320-333 の直後に MergeGateLogRow を追加）
- Modify: `src/store.ts`（SCHEMA :110-124 の verify_log の後 / Raw row + 変換関数 :235-353 付近 / PATCH_COLUMNS :409-418 の後 / insert/get/update メソッド :1112- の groom_log 群の後）
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: 以下の型とメソッド。ES-521 が全ゲート判定の監査記録に使う。
  - `MergeGateOutcome = "passed" | "fixed" | "parked" | "skipped" | "error"`
  - `MergeGateLogRow`（下記）
  - `store.insertMergeGateLog({ runId, sessionId, attempt, startedAt }): MergeGateLogRow`
  - `store.getMergeGateLog(id): MergeGateLogRow`
  - `store.updateMergeGateLog(id, patch)` — patch キー: endedAt / verdict / signals / violations / outcome / costUsd / errorDetail

- [ ] **Step 1: Write the failing test**

`tests/store.test.ts` に追加:

```ts
describe("merge_gate_log (ES-514)", () => {
  it("insert → update → get roundtrip", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "ES-1",
      issueTitle: "t",
      branch: "b",
      worktreePath: "/tmp/wt",
      now: clock(),
    });
    const log = store.insertMergeGateLog({
      runId: run.id,
      sessionId: session.id,
      attempt: 1,
      startedAt: clock(),
    });
    expect(log.verdict).toBeNull();
    expect(log.outcome).toBeNull();
    store.updateMergeGateLog(log.id, {
      endedAt: clock(),
      verdict: "fail",
      signals: JSON.stringify({ deletedFiles: ["a.ts"] }),
      violations: JSON.stringify(["public export removed"]),
      outcome: "parked",
      costUsd: 0.5,
    });
    const updated = store.getMergeGateLog(log.id);
    expect(updated.verdict).toBe("fail");
    expect(updated.outcome).toBe("parked");
    expect(updated.costUsd).toBe(0.5);
    expect(JSON.parse(updated.violations as string)).toEqual(["public export removed"]);
  });

  it("updateMergeGateLog rejects unknown patch keys at compile time and unknown ids at runtime", () => {
    const store = newStore();
    expect(() => store.getMergeGateLog(999)).toThrow("merge_gate_log not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `insertMergeGateLog` が存在しない

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` — GroomLogRow の閉じ `}` の後に追加:

```ts
// ---- MERGE GATE (ES-514) ----
export type MergeGateOutcome = "passed" | "fixed" | "parked" | "skipped" | "error";

export interface MergeGateLogRow {
  id: number;
  runId: number;
  sessionId: number;
  attempt: number;             // 1始まり。fix 後の再ゲートで +1
  startedAt: string;
  endedAt: string | null;
  verdict: "pass" | "fail" | null;
  signals: string | null;      // breaking-signals 抽出結果の JSON（ES-515）
  violations: string | null;   // fail 時の違反リスト JSON
  outcome: MergeGateOutcome | null;
  costUsd: number | null;      // fix ターン（Claude）の実測コスト。Codex 判定は計測不能（timeout ガードのみ）
  errorDetail: string | null;
}
```

`src/store.ts` — 4 箇所:

1. import に `MergeGateLogRow` と `MergeGateOutcome` を追加（既存の types import へ）。

2. SCHEMA 内、`CREATE TABLE IF NOT EXISTS run_lock` の前に追加:

```sql
CREATE TABLE IF NOT EXISTS merge_gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  session_id INTEGER NOT NULL REFERENCES task_session(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  verdict TEXT CHECK (verdict IN ('pass','fail')),
  signals TEXT,
  violations TEXT,
  outcome TEXT CHECK (outcome IN ('passed','fixed','parked','skipped','error')),
  cost_usd REAL,
  error_detail TEXT
);
```

3. `RawGroomLogRow`/`toGroomLogRow` の後に Raw 型と変換関数:

```ts
interface RawMergeGateLogRow {
  id: number;
  run_id: number;
  session_id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  signals: string | null;
  violations: string | null;
  outcome: string | null;
  cost_usd: number | null;
  error_detail: string | null;
}
function toMergeGateLogRow(r: RawMergeGateLogRow): MergeGateLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    verdict: r.verdict as "pass" | "fail" | null,
    signals: r.signals,
    violations: r.violations,
    outcome: r.outcome as MergeGateOutcome | null,
    costUsd: r.cost_usd,
    errorDetail: r.error_detail,
  };
}
```

4. `VERIFY_LOG_PATCH_COLUMNS` の後に:

```ts
const MERGE_GATE_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  verdict: "verdict",
  signals: "signals",
  violations: "violations",
  outcome: "outcome",
  costUsd: "cost_usd",
  errorDetail: "error_detail",
};
```

5. クラス内、groom_log メソッド群（`updateGroomLog` の後）に追加（`updateGroomLog` :1137-1170 と完全同型）:

```ts
  // ---- merge_gate_log (ES-514) ----
  insertMergeGateLog(s: {
    runId: number;
    sessionId: number;
    attempt: number;
    startedAt: string;
  }): MergeGateLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO merge_gate_log (run_id, session_id, attempt, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(s.runId, s.sessionId, s.attempt, s.startedAt);
    return this.getMergeGateLog(Number(info.lastInsertRowid));
  }

  getMergeGateLog(id: number): MergeGateLogRow {
    const row = this.db
      .prepare(`SELECT * FROM merge_gate_log WHERE id = ?`)
      .get(id) as RawMergeGateLogRow | undefined;
    if (row === undefined) {
      throw new Error(`merge_gate_log not found: id=${id}`);
    }
    return toMergeGateLogRow(row);
  }

  updateMergeGateLog(
    id: number,
    patch: Partial<Pick<MergeGateLogRow,
      | "endedAt"
      | "verdict"
      | "signals"
      | "violations"
      | "outcome"
      | "costUsd"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = MERGE_GATE_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateMergeGateLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE merge_gate_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateMergeGateLog affected ${info.changes} rows for id=${id}`);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts tests/store.test.ts
git commit -m "feat: 監査テーブル merge_gate_log を追加 (ES-514)"
```

---

### Task 5: config — safety 3 キー + `[merge_gate]` セクション + ドキュメント

**Files:**
- Modify: `src/config.ts`（zod schema :91-117 / Config interface :208-232 / loadConfig マッピング :877-901, :914-927 付近）
- Modify: `looppilot-os.example.toml`（[safety] :83-97 / [groom] :112 付近）
- Modify: `README.md`（config 表 :132 付近）
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: ES-521 が読む config 値:
  - `config.safety.mergeGateTimeoutMinutes: number`（既定 15）— Codex 判定の timeout
  - `config.safety.maxMergeGateFixAttempts: number`（既定 2）
  - `config.safety.maxCostUsdPerMergeGateFix: number`（既定 2）— fix ターン（Claude）のコスト上限
  - `config.mergeGate.enabled: boolean`（既定 true）— ゲート全体のトグル（verify/groom と同流儀）

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts` に追加（既存の defaults 検証テスト群（:61-64 の `maxWorkflowFixAttempts` 等）と同じ流儀 — `loadConfig(fixture("config-minimal.toml"), fullEnv)` を使う。`fixture` / `fullEnv` はファイル内定義済み）:

```ts
describe("merge gate config (ES-514)", () => {
  it("applies defaults when keys are omitted", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.mergeGateTimeoutMinutes).toBe(15);
    expect(config.safety.maxMergeGateFixAttempts).toBe(2);
    expect(config.safety.maxCostUsdPerMergeGateFix).toBe(2);
    expect(config.mergeGate.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `mergeGateTimeoutMinutes` が Config に無い

- [ ] **Step 3: Write minimal implementation**

`src/config.ts` — 4 箇所:

1. zod schema の `safety` オブジェクト内、`transient_retry_attempts: ...` の直後に追加:

```ts
    merge_gate_timeout_minutes: z.number().positive().default(15),
    max_merge_gate_fix_attempts: z.number().int().positive().default(2),
    max_cost_usd_per_merge_gate_fix: z.number().positive().default(2),
```

2. zod schema の `groom: z.object({...}).strict().optional(),` の直後に追加:

```ts
  merge_gate: z.object({
    enabled: z.boolean().default(true),
  }).strict().optional(),
```

3. `Config` interface の `safety` ブロック内 `transientRetryAttempts: number;` の直後に:

```ts
    mergeGateTimeoutMinutes: number;
    maxMergeGateFixAttempts: number;
    maxCostUsdPerMergeGateFix: number;
```

さらに `groom: { enabled: boolean };` 相当の並びに（`groom` フィールドの直後）:

```ts
  mergeGate: { enabled: boolean };
```

4. `loadConfig` のマッピング — `safety` ブロック内 `transientRetryAttempts: raw.safety.transient_retry_attempts,` の直後に:

```ts
      mergeGateTimeoutMinutes: raw.safety.merge_gate_timeout_minutes,
      maxMergeGateFixAttempts: raw.safety.max_merge_gate_fix_attempts,
      maxCostUsdPerMergeGateFix: raw.safety.max_cost_usd_per_merge_gate_fix,
```

`groom: { enabled: raw.groom?.enabled ?? true },` の直後に:

```ts
    mergeGate: {
      enabled: raw.merge_gate?.enabled ?? true,
    },
```

`looppilot-os.example.toml` — `[safety]` セクション末尾（`# transient_retry_attempts = 2` 行の後）に:

```toml
# merge_gate_timeout_minutes = 15       # マージゲート Codex 判定のタイムアウト（既定15分。Codexはコスト計測不能のためtimeoutのみ）
# max_merge_gate_fix_attempts = 2       # ゲート fail 時の自動修正上限（尽きたら park、既定2）
# max_cost_usd_per_merge_gate_fix = 2   # ゲート修正ターン（Claude）のコスト上限（既定$2）
```

`[groom]` セクションの後に:

```toml
[merge_gate]
# enabled = true                # false にするとマージ直前の破壊的変更ゲートをスキップ（既定 true）
```

`README.md` — config 表（`groom.enabled` の行がある表）に以下の行を追加（表の既存フォーマットに厳密に合わせる）:

- `safety.merge_gate_timeout_minutes` — マージゲート Codex 判定のタイムアウト（既定 15 分）
- `safety.max_merge_gate_fix_attempts` — ゲート fail 時の自動修正上限（既定 2）
- `safety.max_cost_usd_per_merge_gate_fix` — ゲート修正ターンのコスト上限（既定 $2）
- `merge_gate.enabled` — マージ直前 破壊的変更ゲートのトグル（既定 true）

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts && npx tsc --noEmit && npx vitest run`
Expected: 全 PASS（最後の全体実行で回帰なし確認）

- [ ] **Step 5: Commit**

```bash
git add src/config.ts looppilot-os.example.toml README.md tests/config.test.ts
git commit -m "feat: merge gate の safety キーと [merge_gate] セクションを追加 (ES-514)"
```

---

## 完了条件（チケットの Done 定義）

- `npx vitest run` 全テストグリーン + `npx tsc --noEmit` エラーなし
- orchestrator.ts への変更ゼロ（`git diff main -- src/orchestrator.ts` が空）
- 既存 DB（v3.5 で作られた looppilot-os.db）を開いても migrate が冪等に通る（store.test.ts の既存 migration テストが担保）
