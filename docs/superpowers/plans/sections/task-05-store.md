## 目的と依存

State Store（SQLite）を実装する。カーネル §4 のスキーマ（一字一句）と `SqliteStore` の全公開メソッドを `src/store.ts` に持たせる。WAL 化（`:memory:` では失敗を無視）、`PRAGMA user_version=1`、状態遷移は単一 UPDATE 文＋`changes` 検証、`acquireRunLock` は注入された `isPidAlive` で生存 pid のロックは奪わず・死んだ pid のロックは奪取する。SQLite は真実の源（仕様 §4/§7）で、Run / TaskSession / 通知 intent / ランロックの全永続化を担う。

**依存タスク**: Task 2（`src/types.ts` の `RunRow`, `TaskSessionRow`, `RunState`, `SessionState`, `FailureReason`, `NotifyEvent` 等。本タスクはこれらを import するのみで再定義しない）。Task 1（`package.json` に `better-sqlite3` が実行時依存として追加済み・`tsconfig`×2・`vitest.config` の雛形があり `npm run check` が動くこと）。

**カーネル根拠**: §0（better-sqlite3 同期 API・テストは `:memory:`）、§4（SQL スキーマ全文＋`SqliteStore` メソッドシグネチャ・PRAGMA・WAL）、§2（`RunRow`/`TaskSessionRow`/`RunState`/`SessionState`/`FailureReason` 型）、§7（DI で `store` を渡す前提・`recentMergedSummaries` の利用）。

### このタスクで固定する事実（実環境で検証済み・better-sqlite3 12.10.0）

- `import Database from "better-sqlite3"` は **default import**（CommonJS の `module.exports = Database`）。NodeNext + `esModuleInterop` 前提。型は `@types/better-sqlite3@7.6.13`（別パッケージ、devDependency）。
- `db.pragma("journal_mode = WAL")` は `:memory:` では **throw せず** `journal_mode: "memory"` を返す（=実質 no-op）。ファイル DB では稀に失敗し得るため、カーネル §4「WAL（`:memory:` では失敗を無視）」に従い **try/catch で握り潰す**。
- `db.pragma("user_version = 1")` で書き込み、`db.pragma("user_version", { simple: true })` で `1`（数値）が読める。
- `stmt.run(...)` は `{ changes: number; lastInsertRowid: number | bigint }` を返す。`changes` は影響行数で、状態遷移の存在検証に使う。
- `stmt.run(undefined)` は **throw せず NULL** として扱われる（positional bind）。一方、名前付きパラメータでキー欠落は throw する。`updateSession` の部分更新は **patch に存在するキーだけ** SET 句に含め positional bind するため、`undefined` を一切 bind しない（NULL 上書き事故を防ぐ）。
- CHECK 制約違反・partial index（`WHERE state NOT IN (...)`）は通常どおり機能する。
- `lastInsertRowid` は number か bigint。`id` は `Number(...)` で正規化して `RunRow.id`（number）に入れる。

---

### Task 5: State Store（SQLite）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/store.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/store.test.ts`
- Modify: `/home/racoma-dev/loop-pilot-os/package.json`（`@types/better-sqlite3` を devDependencies に追加。Task 1 で未追加の場合のみ）

---

- [ ] **Step 1: `@types/better-sqlite3` が devDependency にあるか確認し、無ければ追加する**

  `better-sqlite3` は型を同梱しないため `@types/better-sqlite3` が必須。まず存在を確認する。

  コマンド:
  ```bash
  node -e "const p=require('/home/racoma-dev/loop-pilot-os/package.json'); process.stdout.write(String(p.devDependencies?.['@types/better-sqlite3'] ?? 'MISSING'))"
  ```

  出力が `MISSING` の場合のみ次を実行（既にバージョン文字列が出るならこのコマンドは省略する）:
  ```bash
  npm --prefix /home/racoma-dev/loop-pilot-os install --save-dev @types/better-sqlite3@7.6.13
  ```

  期待: `package.json` の `devDependencies` に `"@types/better-sqlite3": "^7.6.13"`（または Task 1 で既に入っているバージョン）が存在し、`node_modules/@types/better-sqlite3` が解決される。

---

- [ ] **Step 2: 失敗するテストの骨格を作成（import + run 作成/状態の最初の1ケースのみ）**

  この時点で `src/store.ts` は未作成なので import 解決に失敗させる。`/home/racoma-dev/loop-pilot-os/tests/store.test.ts` を作成（完全形・このステップではここまで）:

  ```typescript
  import { describe, it, expect, afterEach } from "vitest";
  import { SqliteStore } from "../src/store.js";
  import type { TaskSessionRow } from "../src/types.js";

  // テスト間で開いたストアを確実に閉じる（:memory: でもハンドルを解放する）
  let openStores: SqliteStore[] = [];
  function newStore(): SqliteStore {
    const s = new SqliteStore(":memory:");
    openStores.push(s);
    return s;
  }
  afterEach(() => {
    for (const s of openStores) s.close();
    openStores = [];
  });

  // ---- テスト用ヘルパ: 単調増加する ISO クロック（呼ぶ度 +1s） ----
  function makeClock(start = "2026-06-06T00:00:00.000Z"): () => string {
    let t = Date.parse(start);
    return () => {
      const iso = new Date(t).toISOString();
      t += 1000;
      return iso;
    };
  }

  // ---- セッションを CLAIM して任意状態まで進めるヘルパ ----
  function seedSession(
    store: SqliteStore,
    runId: number,
    now: string,
    overrides: Partial<{ linearIssueId: string; linearIdentifier: string; issueTitle: string; branch: string }> = {},
  ): TaskSessionRow {
    return store.createSession({
      runId,
      linearIssueId: overrides.linearIssueId ?? "issue-uuid-1",
      linearIdentifier: overrides.linearIdentifier ?? "TY-1",
      issueTitle: overrides.issueTitle ?? "First task",
      branch: overrides.branch ?? "looppilot/ty-1-first-task",
      worktreePath: "/wt/ty-1",
      now,
    });
  }

  describe("SqliteStore: run", () => {
    // 仕様§7: Run はループ起動ごとに1個。createRun で running 状態の行を作る
    it("createRun inserts a running run and returns the row with derived id", () => {
      const store = newStore();
      const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
      expect(run.id).toBe(1);
      expect(run.taskCap).toBe(3);
      expect(run.state).toBe("running");
      expect(run.haltReason).toBeNull();
      expect(run.startedAt).toBe("2026-06-06T00:00:00.000Z");
    });

    // getRun / latestRun が永続化された行を返す
    it("getRun and latestRun read back the persisted run", () => {
      const store = newStore();
      expect(store.latestRun()).toBeNull();
      const a = store.createRun(2, "2026-06-06T00:00:00.000Z");
      const b = store.createRun(5, "2026-06-06T01:00:00.000Z");
      expect(store.getRun(a.id).taskCap).toBe(2);
      expect(store.latestRun()?.id).toBe(b.id); // 最新 = id 最大
      expect(store.latestRun()?.taskCap).toBe(5);
    });
  });
  ```

- [ ] **Step 3: テストを実行して失敗を確認する**

  コマンド: `npm test -- store`
  期待される失敗: `src/store.js` が存在しないため、vitest が `Failed to resolve import "../src/store.js"`（または `Cannot find module`）で `tests/store.test.ts` の collection に失敗する。成功 0 件・collection エラーで終了。

- [ ] **Step 4: `src/store.ts` を最小実装する（スキーマ + run 系メソッドまで）**

  まずカーネル §4 のスキーマ全文・PRAGMA・WAL・行マッピング・run 系メソッドのみを実装し、Step 2 の 2 ケースを green にする。`/home/racoma-dev/loop-pilot-os/src/store.ts` を作成（完全形・このステップ時点）:

  ```typescript
  import Database from "better-sqlite3";
  import type {
    RunRow,
    RunState,
    TaskSessionRow,
  } from "./types.js";

  // ---- カーネル §4 のスキーマ（一字一句） ----
  const SCHEMA = `
  CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    task_cap INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running','idle','halted')),
    halt_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS task_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES run(id),
    linear_issue_id TEXT NOT NULL,
    linear_identifier TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    branch TEXT NOT NULL,
    worktree_path TEXT,
    pr_number INTEGER,
    state TEXT NOT NULL CHECK (state IN
      ('claimed','implementing','handing_off','in_review','merged','stopped')),
    cost_usd REAL,
    failure_reason TEXT,
    stop_detail TEXT,
    agent_summary TEXT,
    started_at TEXT NOT NULL,
    monitor_started_at TEXT,
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_active ON task_session(state)
    WHERE state NOT IN ('merged','stopped');
  CREATE TABLE IF NOT EXISTS notification_intent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    delivered_console INTEGER NOT NULL DEFAULT 0,
    delivered_slack INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS run_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    acquired_at TEXT NOT NULL
  );
  `;

  // ---- DB の生 row（snake_case）→ ドメイン型（camelCase）マッピング ----
  interface RawRunRow {
    id: number;
    started_at: string;
    task_cap: number;
    state: string;
    halt_reason: string | null;
  }
  function toRunRow(r: RawRunRow): RunRow {
    return {
      id: r.id,
      startedAt: r.started_at,
      taskCap: r.task_cap,
      state: r.state as RunState,
      haltReason: r.halt_reason,
    };
  }

  export class SqliteStore {
    private readonly db: Database.Database;

    constructor(dbPath: string) {
      this.db = new Database(dbPath);
      // WAL 化。:memory: では no-op（journal_mode=memory が返る）。
      // ファイル DB で稀に失敗しても致命ではないので握り潰す（カーネル §4）。
      try {
        this.db.pragma("journal_mode = WAL");
      } catch {
        // ignore: WAL is a best-effort optimization
      }
      this.db.pragma("user_version = 1");
      this.db.exec(SCHEMA);
    }

    close(): void {
      this.db.close();
    }

    // ---- run ----
    createRun(taskCap: number, now: string): RunRow {
      const info = this.db
        .prepare(
          `INSERT INTO run (started_at, task_cap, state, halt_reason)
           VALUES (?, ?, 'running', NULL)`,
        )
        .run(now, taskCap);
      return this.getRun(Number(info.lastInsertRowid));
    }

    getRun(id: number): RunRow {
      const row = this.db
        .prepare(`SELECT * FROM run WHERE id = ?`)
        .get(id) as RawRunRow | undefined;
      if (row === undefined) {
        throw new Error(`run not found: id=${id}`);
      }
      return toRunRow(row);
    }

    latestRun(): RunRow | null {
      const row = this.db
        .prepare(`SELECT * FROM run ORDER BY id DESC LIMIT 1`)
        .get() as RawRunRow | undefined;
      return row === undefined ? null : toRunRow(row);
    }

    setRunState(id: number, state: RunState, haltReason?: string): void {
      const info = this.db
        .prepare(`UPDATE run SET state = ?, halt_reason = ? WHERE id = ?`)
        .run(state, haltReason ?? null, id);
      if (info.changes !== 1) {
        throw new Error(`setRunState affected ${info.changes} rows for run id=${id}`);
      }
    }

    countTasksStarted(runId: number): number {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM task_session WHERE run_id = ?`)
        .get(runId) as { c: number };
      return row.c;
    }

    countMerged(runId: number): number {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM task_session WHERE run_id = ? AND state = 'merged'`,
        )
        .get(runId) as { c: number };
      return row.c;
    }
  }
  ```

  注意（実装者向け）:
  - `createRun` は `started_at = now`（呼び出し側が渡す ISO）。`haltReason` は `NULL` 固定で挿入。
  - `setRunState` は UPDATE 1 文 + `changes === 1` 検証（カーネル「状態遷移は UPDATE 1文+changes 検証」）。`haltReason` 省略時は `NULL` を明示 bind し、以前の理由を残さない。
  - `countMerged` / `countTasksStarted` は導出（盲目的カウンタ更新はしない。仕様§7）。

- [ ] **Step 5: テストを実行して run 系 2 ケースが green になることを確認する**

  コマンド: `npm test -- store`
  期待される成功: `SqliteStore: run` の 2 ケース（createRun / getRun+latestRun）が pass。

- [ ] **Step 6: 失敗するテストを追加（setRunState とカウント導出）**

  `tests/store.test.ts` の `describe("SqliteStore: run", ...)` ブロックの末尾（最後の `it` の後、`});` の前）に次の `it` を追加する:

  ```typescript
    // 仕様§7: §5 STOPPED ⇒ Run=halted。setRunState は UPDATE 1文 + changes 検証
    it("setRunState updates state and halt reason, throwing for unknown ids", () => {
      const store = newStore();
      const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
      store.setRunState(run.id, "idle");
      expect(store.getRun(run.id).state).toBe("idle");
      expect(store.getRun(run.id).haltReason).toBeNull();
      store.setRunState(run.id, "halted", "task_cap reached");
      expect(store.getRun(run.id).state).toBe("halted");
      expect(store.getRun(run.id).haltReason).toBe("task_cap reached");
      // 存在しない run への遷移は changes=0 で throw
      expect(() => store.setRunState(999, "running")).toThrow();
    });

    // 仕様§7/§11: tasks_started = CLAIM 到達数（セッション行数）, merged = 導出実数
    it("countTasksStarted and countMerged derive counts from session rows", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      expect(store.countTasksStarted(run.id)).toBe(0);
      expect(store.countMerged(run.id)).toBe(0);

      const s1 = seedSession(store, run.id, clock(), { linearIssueId: "i1", linearIdentifier: "TY-1", branch: "b1" });
      const s2 = seedSession(store, run.id, clock(), { linearIssueId: "i2", linearIdentifier: "TY-2", branch: "b2" });
      seedSession(store, run.id, clock(), { linearIssueId: "i3", linearIdentifier: "TY-3", branch: "b3" });
      // 3 行 CLAIM 到達 → tasks_started = 3、merged はまだ 0
      expect(store.countTasksStarted(run.id)).toBe(3);
      expect(store.countMerged(run.id)).toBe(0);

      store.updateSession(s1.id, { state: "merged", endedAt: clock() });
      store.updateSession(s2.id, { state: "merged", endedAt: clock() });
      // merged は実数導出 = 2、tasks_started は変わらず 3
      expect(store.countMerged(run.id)).toBe(2);
      expect(store.countTasksStarted(run.id)).toBe(3);
    });
  ```

  コマンド: `npm test -- store`
  期待される失敗: 追加 2 ケースが失敗する。`setRunState` は実装済みだが、`createSession`/`updateSession`（`seedSession` が呼ぶ）が未実装なので、`store.createSession is not a function`（TypeError）で `countTasksStarted...` ケースが失敗し、`setRunState ...` ケースは pass する（このステップでは setRunState 単体は通る）。次ステップで session API の全ケースを先に red にしてから実装する。

- [ ] **Step 7: 失敗するテストを追加（session API 全体: 作成・状態・部分更新・active/known/recent/sessionsForRun）**

  session 系メソッドを実装する**前**に、その全公開挙動（`createSession`/`getSession` ラウンドトリップ、部分更新（`monitorStartedAt` 含む）、空 patch no-op、未知 id への `updateSession` throw、`activeSessions`/`activeIssueIds`/`knownIssueIds`、`recentMergedSummaries`、`sessionsForRun`/`recentSessions`）を網羅する describe ブロックを追加し、各挙動を実装前に red にする（red→green を session API 全体で踏む）。

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: session", () => {
    // 仕様§5: CLAIM で claimed セッションを記録（worktree 作成済み）
    it("createSession inserts a claimed session and round-trips via getSession", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = store.createSession({
        runId: run.id,
        linearIssueId: "uuid-1",
        linearIdentifier: "TY-7",
        issueTitle: "Add widget",
        branch: "looppilot/ty-7-add-widget",
        worktreePath: "/wt/ty-7",
        now: "2026-06-06T00:00:05.000Z",
      });
      expect(s.id).toBe(1);
      expect(s.runId).toBe(run.id);
      expect(s.state).toBe("claimed");
      expect(s.linearIssueId).toBe("uuid-1");
      expect(s.linearIdentifier).toBe("TY-7");
      expect(s.issueTitle).toBe("Add widget");
      expect(s.branch).toBe("looppilot/ty-7-add-widget");
      expect(s.worktreePath).toBe("/wt/ty-7");
      expect(s.prNumber).toBeNull();
      expect(s.costUsd).toBeNull();
      expect(s.failureReason).toBeNull();
      expect(s.stopDetail).toBeNull();
      expect(s.agentSummary).toBeNull();
      expect(s.monitorStartedAt).toBeNull();
      expect(s.endedAt).toBeNull();
      expect(s.startedAt).toBe("2026-06-06T00:00:05.000Z");
      expect(store.getSession(s.id)).toEqual(s);
    });

    // カーネル §4/§8: 部分更新は patch に存在する列だけを書き換え、他は保持する
    it("updateSession patches only the provided columns (including monitorStartedAt)", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = seedSession(store, run.id, clock());

      store.updateSession(s.id, { state: "implementing" });
      expect(store.getSession(s.id).state).toBe("implementing");

      // PR 番号を即時永続化（HANDOFF）
      store.updateSession(s.id, { prNumber: 42 });
      // in_review 入りで monitorStartedAt を起点として記録（同一/別 patch どちらでも保持される）
      store.updateSession(s.id, {
        state: "in_review",
        monitorStartedAt: "2026-06-06T00:10:00.000Z",
      });
      const after = store.getSession(s.id);
      expect(after.state).toBe("in_review");
      expect(after.prNumber).toBe(42);
      expect(after.monitorStartedAt).toBe("2026-06-06T00:10:00.000Z");
      // 触っていない列（branch / issueTitle / startedAt）は不変
      expect(after.branch).toBe(s.branch);
      expect(after.issueTitle).toBe(s.issueTitle);
      expect(after.startedAt).toBe(s.startedAt);

      // cost / summary / failure / endedAt の更新
      store.updateSession(s.id, {
        state: "merged",
        costUsd: 4.25,
        agentSummary: "implemented widget",
        endedAt: "2026-06-06T00:20:00.000Z",
      });
      const merged = store.getSession(s.id);
      expect(merged.state).toBe("merged");
      expect(merged.costUsd).toBe(4.25);
      expect(merged.agentSummary).toBe("implemented widget");
      expect(merged.endedAt).toBe("2026-06-06T00:20:00.000Z");
      // prNumber / monitorStartedAt は依然保持
      expect(merged.prNumber).toBe(42);
      expect(merged.monitorStartedAt).toBe("2026-06-06T00:10:00.000Z");
    });

    // 空 patch は no-op（throw しない・行を壊さない）
    it("updateSession with an empty patch is a no-op", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(3, clock());
      const s = seedSession(store, run.id, clock());
      expect(() => store.updateSession(s.id, {})).not.toThrow();
      expect(store.getSession(s.id)).toEqual(s);
    });

    // 存在しない session への更新は changes=0 で throw
    it("updateSession throws when no row matches the id", () => {
      const store = newStore();
      store.createRun(3, "2026-06-06T00:00:00.000Z");
      expect(() => store.updateSession(999, { state: "stopped" })).toThrow();
    });

    // カーネル §4/§8: activeSessions は merged/stopped 以外を全 run 横断で返す
    it("activeSessions returns sessions whose state is not merged or stopped, across runs", () => {
      const store = newStore();
      const clock = makeClock();
      const runA = store.createRun(3, clock());
      const runB = store.createRun(3, clock());

      const a = seedSession(store, runA.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a" });
      const b = seedSession(store, runA.id, clock(), { linearIssueId: "i-b", linearIdentifier: "TY-2", branch: "b-b" });
      const c = seedSession(store, runB.id, clock(), { linearIssueId: "i-c", linearIdentifier: "TY-3", branch: "b-c" });
      const d = seedSession(store, runB.id, clock(), { linearIssueId: "i-d", linearIdentifier: "TY-4", branch: "b-d" });

      store.updateSession(a.id, { state: "in_review" });   // active
      store.updateSession(b.id, { state: "merged" });       // 非アクティブ
      store.updateSession(c.id, { state: "stopped", failureReason: "exception" }); // 非アクティブ
      store.updateSession(d.id, { state: "implementing" }); // active（別 run）

      const active = store.activeSessions();
      expect(active.map((s) => s.id)).toEqual([a.id, d.id]); // id ASC・全 run 横断
      expect(active.map((s) => s.state)).toEqual(["in_review", "implementing"]);

      expect(store.activeIssueIds().sort()).toEqual(["i-a", "i-d"]);
      expect(store.knownIssueIds().sort()).toEqual(["i-a", "i-b", "i-c", "i-d"]);
    });

    // カーネル §2/§7: recentMergedSummaries は merged のみを ended_at 降順で n 件
    it("recentMergedSummaries returns only merged sessions, newest-ended first, limited to n", () => {
      const store = newStore();
      const clock = makeClock();
      const run = store.createRun(10, clock());

      const mk = (id: string, ident: string, title: string): TaskSessionRow =>
        seedSession(store, run.id, clock(), { linearIssueId: id, linearIdentifier: ident, issueTitle: title, branch: `b-${ident}` });

      const s1 = mk("i1", "TY-1", "first");
      const s2 = mk("i2", "TY-2", "second");
      const s3 = mk("i3", "TY-3", "third");
      const s4 = mk("i4", "TY-4", "fourth");
      const sActive = mk("i5", "TY-5", "active-not-merged");

      // merge 順を ended_at で制御（s2 → s1 → s3 → s4 の順にマージ）
      store.updateSession(s2.id, { state: "merged", agentSummary: "sum-2", endedAt: "2026-06-06T01:00:00.000Z" });
      store.updateSession(s1.id, { state: "merged", agentSummary: "sum-1", endedAt: "2026-06-06T02:00:00.000Z" });
      store.updateSession(s3.id, { state: "merged", agentSummary: "sum-3", endedAt: "2026-06-06T03:00:00.000Z" });
      store.updateSession(s4.id, { state: "merged", agentSummary: "sum-4", endedAt: "2026-06-06T04:00:00.000Z" });
      store.updateSession(sActive.id, { state: "in_review" }); // merged でない → 除外

      const top2 = store.recentMergedSummaries(2);
      expect(top2).toEqual([
        { linearIdentifier: "TY-4", issueTitle: "fourth", agentSummary: "sum-4" },
        { linearIdentifier: "TY-3", issueTitle: "third", agentSummary: "sum-3" },
      ]);

      const all = store.recentMergedSummaries(10);
      expect(all.map((r) => r.linearIdentifier)).toEqual([
        "TY-4",
        "TY-3",
        "TY-1",
        "TY-2",
      ]); // ended_at 降順、active は含まれない
    });

    // status CLI 用: sessionsForRun / recentSessions
    it("sessionsForRun and recentSessions return rows in expected order", () => {
      const store = newStore();
      const clock = makeClock();
      const runA = store.createRun(3, clock());
      const runB = store.createRun(3, clock());
      const a1 = seedSession(store, runA.id, clock(), { linearIssueId: "i1", linearIdentifier: "TY-1", branch: "b1" });
      const a2 = seedSession(store, runA.id, clock(), { linearIssueId: "i2", linearIdentifier: "TY-2", branch: "b2" });
      const b1 = seedSession(store, runB.id, clock(), { linearIssueId: "i3", linearIdentifier: "TY-3", branch: "b3" });

      expect(store.sessionsForRun(runA.id).map((s) => s.id)).toEqual([a1.id, a2.id]); // id ASC・runA のみ
      expect(store.sessionsForRun(runB.id).map((s) => s.id)).toEqual([b1.id]);

      // 最新順（id DESC）に n 件
      expect(store.recentSessions(2).map((s) => s.id)).toEqual([b1.id, a2.id]);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `SqliteStore: session` の各ケースが `TypeError`（`store.createSession is not a function` / `store.getSession is not a function` / `store.updateSession is not a function` / `store.activeSessions is not a function` / `store.activeIssueIds is not a function` / `store.knownIssueIds is not a function` / `store.recentMergedSummaries is not a function` / `store.sessionsForRun is not a function` / `store.recentSessions is not a function`）で全件失敗する。Step 6 の count 導出ケースも `createSession`/`updateSession` 未実装のため依然 red。session 系メソッドは次ステップで実装する。

- [ ] **Step 8: `src/store.ts` に session 系メソッドを実装する**

  `src/store.ts` の import に `SessionState`, `FailureReason` を追加し、`countMerged` メソッドの直後（`SqliteStore` クラス内）に session 系を追加する。

  まず import 行を差し替える:

  ```typescript
  import Database from "better-sqlite3";
  import type {
    RunRow,
    RunState,
    SessionState,
    FailureReason,
    TaskSessionRow,
  } from "./types.js";
  ```

  次に、`RawRunRow` / `toRunRow` の定義群の直後（`export class SqliteStore` の前）に、task_session の生 row 型とマッパを追加する:

  ```typescript
  interface RawSessionRow {
    id: number;
    run_id: number;
    linear_issue_id: string;
    linear_identifier: string;
    issue_title: string;
    branch: string;
    worktree_path: string | null;
    pr_number: number | null;
    state: string;
    cost_usd: number | null;
    failure_reason: string | null;
    stop_detail: string | null;
    agent_summary: string | null;
    started_at: string;
    monitor_started_at: string | null;
    ended_at: string | null;
  }
  function toSessionRow(r: RawSessionRow): TaskSessionRow {
    return {
      id: r.id,
      runId: r.run_id,
      linearIssueId: r.linear_issue_id,
      linearIdentifier: r.linear_identifier,
      issueTitle: r.issue_title,
      branch: r.branch,
      worktreePath: r.worktree_path,
      prNumber: r.pr_number,
      state: r.state as SessionState,
      costUsd: r.cost_usd,
      failureReason: r.failure_reason as FailureReason | null,
      stopDetail: r.stop_detail,
      agentSummary: r.agent_summary,
      startedAt: r.started_at,
      monitorStartedAt: r.monitor_started_at,
      endedAt: r.ended_at,
    };
  }

  // ---- updateSession の patch キー → DB 列名の対応（部分更新の SET 句生成に使う） ----
  const SESSION_PATCH_COLUMNS: Record<string, string> = {
    state: "state",
    worktreePath: "worktree_path",
    prNumber: "pr_number",
    costUsd: "cost_usd",
    failureReason: "failure_reason",
    stopDetail: "stop_detail",
    agentSummary: "agent_summary",
    monitorStartedAt: "monitor_started_at",
    endedAt: "ended_at",
    runId: "run_id",
  };
  ```

  そして `countMerged` メソッドの直後（クラス内）に session 系メソッドを追加する:

  ```typescript
    // ---- session ----
    createSession(s: {
      runId: number;
      linearIssueId: string;
      linearIdentifier: string;
      issueTitle: string;
      branch: string;
      worktreePath: string;
      now: string;
    }): TaskSessionRow {
      const info = this.db
        .prepare(
          `INSERT INTO task_session
             (run_id, linear_issue_id, linear_identifier, issue_title,
              branch, worktree_path, state, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?)`,
        )
        .run(
          s.runId,
          s.linearIssueId,
          s.linearIdentifier,
          s.issueTitle,
          s.branch,
          s.worktreePath,
          s.now,
        );
      return this.getSession(Number(info.lastInsertRowid));
    }

    getSession(id: number): TaskSessionRow {
      const row = this.db
        .prepare(`SELECT * FROM task_session WHERE id = ?`)
        .get(id) as RawSessionRow | undefined;
      if (row === undefined) {
        throw new Error(`task_session not found: id=${id}`);
      }
      return toSessionRow(row);
    }

    updateSession(
      id: number,
      patch: Partial<
        Pick<
          TaskSessionRow,
          | "state"
          | "worktreePath"
          | "prNumber"
          | "costUsd"
          | "failureReason"
          | "stopDetail"
          | "agentSummary"
          | "monitorStartedAt"
          | "endedAt"
          | "runId"
        >
      >,
    ): void {
      const setClauses: string[] = [];
      const values: Array<string | number | null> = [];
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        const column = SESSION_PATCH_COLUMNS[key as string];
        if (column === undefined) {
          throw new Error(`updateSession: unknown patch key "${String(key)}"`);
        }
        const raw = patch[key];
        // undefined はそもそも Object.keys に来ない想定だが、明示キー undefined は NULL 扱いにしない
        if (raw === undefined) continue;
        setClauses.push(`${column} = ?`);
        values.push(raw as string | number | null);
      }
      if (setClauses.length === 0) {
        return; // 空 patch は no-op
      }
      values.push(id);
      const info = this.db
        .prepare(`UPDATE task_session SET ${setClauses.join(", ")} WHERE id = ?`)
        .run(...values);
      if (info.changes !== 1) {
        throw new Error(
          `updateSession affected ${info.changes} rows for session id=${id}`,
        );
      }
    }

    activeSessions(): TaskSessionRow[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_session
           WHERE state NOT IN ('merged','stopped')
           ORDER BY id ASC`,
        )
        .all() as RawSessionRow[];
      return rows.map(toSessionRow);
    }

    activeIssueIds(): string[] {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT linear_issue_id AS id FROM task_session
           WHERE state NOT IN ('merged','stopped')`,
        )
        .all() as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    knownIssueIds(): string[] {
      const rows = this.db
        .prepare(`SELECT DISTINCT linear_issue_id AS id FROM task_session`)
        .all() as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    recentMergedSummaries(
      n: number,
    ): Array<
      Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">
    > {
      const rows = this.db
        .prepare(
          `SELECT linear_identifier, issue_title, agent_summary
           FROM task_session
           WHERE state = 'merged'
           ORDER BY ended_at DESC, id DESC
           LIMIT ?`,
        )
        .all(n) as Array<{
        linear_identifier: string;
        issue_title: string;
        agent_summary: string | null;
      }>;
      return rows.map((r) => ({
        linearIdentifier: r.linear_identifier,
        issueTitle: r.issue_title,
        agentSummary: r.agent_summary,
      }));
    }

    sessionsForRun(runId: number): TaskSessionRow[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM task_session WHERE run_id = ? ORDER BY id ASC`,
        )
        .all(runId) as RawSessionRow[];
      return rows.map(toSessionRow);
    }

    recentSessions(n: number): TaskSessionRow[] {
      const rows = this.db
        .prepare(`SELECT * FROM task_session ORDER BY id DESC LIMIT ?`)
        .all(n) as RawSessionRow[];
      return rows.map(toSessionRow);
    }
  ```

  注意（実装者向け）:
  - `createSession` は常に `state='claimed'` で挿入（CLAIM 到達の記録。仕様§5）。`worktree_path` は引数必須（CLAIM で worktree 作成済み）。
  - `updateSession` は **patch に存在するキーだけ** SET 句に入れて positional bind する。`runId` を含む全パッチ可能列をサポート（回復で runId 付替えに使う。カーネル §8）。`monitorStartedAt` も部分更新可能（in_review 入り・回復で起点を保持）。
  - `recentMergedSummaries` は `ended_at DESC, id DESC`（同一 ended_at の決定性のため id を tie-breaker）で merged のみ n 件。戻り値は `PromptArgs.digest` にそのまま渡せる形（カーネル §2/§7）。
  - `activeSessions` は **全 run 横断**で `merged`/`stopped` 以外（回復が全アクティブを見るため。カーネル §8）。`id ASC` で決定的順序。

- [ ] **Step 9: session 系テスト全件 green を確認しコミットする**

  Step 8 の実装で Step 6（count 導出）と Step 7（session API 全体）の red が一括で green になる。

  コマンド: `npm test -- store`
  期待される成功: `SqliteStore: run`（4 件: createRun / getRun+latestRun / setRunState / countTasksStarted+countMerged）+ `SqliteStore: session`（7 件: createSession ラウンドトリップ / 部分更新 / 空 patch no-op / 未知 id throw / activeSessions+active/known issue ids / recentMergedSummaries / sessionsForRun+recentSessions）が全て pass。

  この段で red→green 1 単位を締めてコミットする:
  ```bash
  git add src/store.ts tests/store.test.ts package.json
  git commit -m "feat: SqliteStore schema + run/session CRUD and derived counts"
  ```

- [ ] **Step 10: 失敗するテストを追加（通知 intent: 記録/配信マーク/未配信列挙）**

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: notification intents", () => {
    const payload = JSON.stringify({
      kind: "halted",
      reason: "task_cap",
      detail: "reached 3",
    });

    // 仕様§10/カーネル §4: Slack 設定時は delivered_slack=0 で記録、未配信に出る
    it("recordIntent (slack configured) lists the intent as undelivered until both channels marked", () => {
      const store = newStore();
      const id = store.recordIntent(payload, true, "2026-06-06T00:00:00.000Z");
      expect(id).toBe(1);

      let pending = store.undeliveredIntents();
      expect(pending).toEqual([{ id, payload, attempts: 0 }]);

      store.bumpAttempts(id);
      pending = store.undeliveredIntents();
      expect(pending).toEqual([{ id, payload, attempts: 1 }]);

      store.markDelivered(id, "console");
      // console 済みでも slack 未配信なら依然 undelivered
      expect(store.undeliveredIntents().map((i) => i.id)).toEqual([id]);

      store.markDelivered(id, "slack");
      // 両チャネル配信済み → undelivered から消える
      expect(store.undeliveredIntents()).toEqual([]);
    });

    // カーネル §4: Slack 未設定なら delivered_slack=1（=配信不要）で記録される
    it("recordIntent (slack NOT configured) marks slack as already-delivered", () => {
      const store = newStore();
      const id = store.recordIntent(payload, false, "2026-06-06T00:00:00.000Z");
      // slack は配信不要扱い。console を配信すれば undelivered から消える
      expect(store.undeliveredIntents().map((i) => i.id)).toEqual([id]);
      store.markDelivered(id, "console");
      expect(store.undeliveredIntents()).toEqual([]);
    });

    // 複数 intent は記録順（id 昇順）で未配信列挙される
    it("undeliveredIntents lists multiple pending intents in id order", () => {
      const store = newStore();
      const p1 = JSON.stringify({ kind: "idle", detail: "queue empty" });
      const p2 = JSON.stringify({ kind: "run_started", detail: "boot" });
      const id1 = store.recordIntent(p1, false, "2026-06-06T00:00:00.000Z");
      const id2 = store.recordIntent(p2, true, "2026-06-06T00:00:01.000Z");
      expect(store.undeliveredIntents()).toEqual([
        { id: id1, payload: p1, attempts: 0 },
        { id: id2, payload: p2, attempts: 0 },
      ]);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `store.recordIntent is not a function`（TypeError）等で `notification intents` の 3 ケースが失敗する（intent 系メソッドが未実装）。

- [ ] **Step 11: `src/store.ts` に通知 intent 系メソッドを実装する**

  `src/store.ts` の `recentSessions` メソッドの直後（クラス内）に追加する:

  ```typescript
    // ---- notification intents ----
    recordIntent(payload: string, slackConfigured: boolean, now: string): number {
      // Slack 未設定なら delivered_slack=1（=配信不要）で記録（カーネル §4）
      const deliveredSlack = slackConfigured ? 0 : 1;
      const info = this.db
        .prepare(
          `INSERT INTO notification_intent
             (created_at, payload, delivered_console, delivered_slack, attempts)
           VALUES (?, ?, 0, ?, 0)`,
        )
        .run(now, payload, deliveredSlack);
      return Number(info.lastInsertRowid);
    }

    markDelivered(id: number, channel: "console" | "slack"): void {
      const column =
        channel === "console" ? "delivered_console" : "delivered_slack";
      const info = this.db
        .prepare(`UPDATE notification_intent SET ${column} = 1 WHERE id = ?`)
        .run(id);
      if (info.changes !== 1) {
        throw new Error(
          `markDelivered affected ${info.changes} rows for intent id=${id}`,
        );
      }
    }

    bumpAttempts(id: number): void {
      const info = this.db
        .prepare(
          `UPDATE notification_intent SET attempts = attempts + 1 WHERE id = ?`,
        )
        .run(id);
      if (info.changes !== 1) {
        throw new Error(
          `bumpAttempts affected ${info.changes} rows for intent id=${id}`,
        );
      }
    }

    undeliveredIntents(): Array<{
      id: number;
      payload: string;
      attempts: number;
    }> {
      const rows = this.db
        .prepare(
          `SELECT id, payload, attempts FROM notification_intent
           WHERE delivered_console = 0 OR delivered_slack = 0
           ORDER BY id ASC`,
        )
        .all() as Array<{ id: number; payload: string; attempts: number }>;
      return rows;
    }
  ```

  注意（実装者向け）:
  - `recordIntent` の `slackConfigured=false` → `delivered_slack=1`（Slack 不要のときは Slack を配信済みとみなす。カーネル §4 コメント）。
  - `undeliveredIntents` は `delivered_console=0 OR delivered_slack=0`（いずれか未配信なら未配信扱い）。`id ASC` で記録順。

  コマンド: `npm test -- store`
  期待される成功: `notification intents` の 3 ケースが pass。

- [ ] **Step 12: red→green 単位でコミットする**

  ```bash
  git add src/store.ts tests/store.test.ts
  git commit -m "feat: persist notification intents with per-channel delivery"
  ```

- [ ] **Step 13: 失敗するテストを追加（ランロック: 取得/競合/死活奪取/解放）**

  `tests/store.test.ts` の末尾（最後の `});` の後）に新しい describe ブロックを追加する:

  ```typescript
  describe("SqliteStore: run lock", () => {
    const allAlive = () => true;
    const allDead = () => false;

    // カーネル §4: 空ロックなら取得成功し、自 pid のロック行が立つ
    it("acquireRunLock succeeds when no lock exists", () => {
      const store = newStore();
      const ok = store.acquireRunLock(1234, allDead, "2026-06-06T00:00:00.000Z");
      expect(ok).toBe(true);
      // 同 pid の再取得も冪等に成功する（自分のロックは奪える）
      const again = store.acquireRunLock(1234, allAlive, "2026-06-06T00:00:01.000Z");
      expect(again).toBe(true);
    });

    // 別プロセスが生存している間は奪取できない（単一インスタンス前提）
    it("acquireRunLock fails when another live pid holds the lock", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      // 2222 から見て 1111 は生存 → 奪取不可
      const isAlive = (pid: number): boolean => pid === 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:01.000Z")).toBe(false);
    });

    // 保持者が死んでいれば奪取できる（死活奪取）
    it("acquireRunLock steals the lock when the holding pid is dead", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      // 1111 は死亡、2222 が奪取
      const isAlive = (pid: number): boolean => pid !== 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:01.000Z")).toBe(true);
      // 以後 1111 は（生きていても）旧ロック行を持たない → 3333 から見て保持者は 2222
      const onlyActiveAlive = (pid: number): boolean => pid === 2222;
      expect(store.acquireRunLock(3333, onlyActiveAlive, "2026-06-06T00:00:02.000Z")).toBe(false);
    });

    // 解放後は別プロセスが取得できる
    it("releaseRunLock frees the lock for another pid", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      store.releaseRunLock(1111);
      // 解放後は 2222 が（1111 が生存していても）取得できる
      expect(store.acquireRunLock(2222, () => true, "2026-06-06T00:00:01.000Z")).toBe(true);
    });

    // 他 pid の releaseRunLock は自ロックを壊さない（自分のロックだけ解放）
    it("releaseRunLock by a non-holder does not drop the current lock", () => {
      const store = newStore();
      expect(store.acquireRunLock(1111, () => false, "2026-06-06T00:00:00.000Z")).toBe(true);
      store.releaseRunLock(9999); // 保持者でない pid の解放は no-op
      // 1111 は依然保持者 → 2222（1111 生存）は取得不可
      const isAlive = (pid: number): boolean => pid === 1111;
      expect(store.acquireRunLock(2222, isAlive, "2026-06-06T00:00:02.000Z")).toBe(false);
    });
  });
  ```

  コマンド: `npm test -- store`
  期待される失敗: `store.acquireRunLock is not a function`（TypeError）等で `run lock` の 5 ケースが失敗する（ロック系メソッドが未実装）。

- [ ] **Step 14: `src/store.ts` にランロック系メソッドを実装する**

  `src/store.ts` の `undeliveredIntents` メソッドの直後（クラス内）に追加する:

  ```typescript
    // ---- run lock（単一インスタンス）----
    acquireRunLock(
      pid: number,
      isPidAlive: (pid: number) => boolean,
      now: string,
    ): boolean {
      const existing = this.db
        .prepare(`SELECT pid FROM run_lock WHERE id = 1`)
        .get() as { pid: number } | undefined;

      if (existing !== undefined) {
        // 自 pid のロックは冪等に奪える。別 pid は生存中なら奪わない。
        if (existing.pid !== pid && isPidAlive(existing.pid)) {
          return false;
        }
      }

      // 空・自 pid・死んだ保持者 → 奪取（id=1 行を upsert）
      this.db
        .prepare(
          `INSERT INTO run_lock (id, pid, acquired_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at`,
        )
        .run(pid, now);
      return true;
    }

    releaseRunLock(pid: number): void {
      // 自分が保持しているロックだけ解放する（他 pid の解放は no-op）
      this.db
        .prepare(`DELETE FROM run_lock WHERE id = 1 AND pid = ?`)
        .run(pid);
    }
  ```

  注意（実装者向け）:
  - 保持者判定は `run_lock` の `id=1` 行のみ（CHECK で単一行を保証）。`existing.pid === pid` は冪等再取得（同一プロセスの再起動でなく同一実行中の再呼び出し）として許可。
  - 別 pid かつ `isPidAlive(existing.pid)` が true → `false`（奪取不可）。死んでいれば upsert で奪取。`isPidAlive` は注入（テストは決定的なフェイク、本番は `process.kill(pid, 0)` ラッパを Orchestrator/main 側で渡す。カーネル §4 のシグネチャに従い store はロジックを持たない）。
  - `releaseRunLock` は `pid` 一致時のみ DELETE（他プロセスが誤って奪取権のないロックを消さない）。

  コマンド: `npm test -- store`
  期待される成功: `run lock` の 5 ケース（取得/競合/死活奪取/解放/非保持者解放 no-op）が全て pass。

- [ ] **Step 15: `npm run check` を実行してグリーンを確認する**

  コマンド: `npm run check`
  期待される成功: `tsc`（src・`tsconfig.json`）と `tsc`（test・`tsconfig.test.json`）が型エラー 0、続く vitest が `tests/store.test.ts` 全件（run 4 + session 7 + notification intents 3 + run lock 5 = 19 ケース）+ 既存タスクのテストを含め全て pass で終了コード 0。`SqliteStore` の公開シグネチャがカーネル §4 と一字一句一致し、`RunRow`/`TaskSessionRow` 等を `types.js` から import している（再定義していない）こと。

- [ ] **Step 16: red→green 単位でコミットする**

  ```bash
  git add src/store.ts tests/store.test.ts
  git commit -m "feat: single-instance run lock with pid-liveness stealing"
  ```
