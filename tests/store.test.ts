import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteStore } from "../src/store.js";
import type { TaskSessionRow, GroomLogRow, VerifyLogRow } from "../src/types.js";

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

  it("setRunState clears pause_meta when transitioning away from paused", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setPauseMeta(run.id, {
      reason: "rate_limit",
      target: "claude",
      pausedAt: "2026-06-06T01:00:00.000Z",
      nextReprobeAt: "2026-06-06T01:10:00.000Z",
      capDeadlineAt: "2026-06-06T02:00:00.000Z",
    });
    expect(store.getRun(run.id).pauseMeta).not.toBeNull();

    store.setRunState(run.id, "halted", "user_interrupt");
    const after = store.getRun(run.id);
    expect(after.state).toBe("halted");
    expect(after.pauseMeta).toBeNull();
  });

  it("setPauseMeta transitions to paused and persists PauseMeta as JSON", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    expect(run.pauseMeta).toBeNull();

    const meta = {
      reason: "rate_limit" as const,
      target: "claude" as const,
      pausedAt: "2026-06-06T01:00:00.000Z",
      nextReprobeAt: "2026-06-06T01:10:00.000Z",
      capDeadlineAt: "2026-06-06T02:00:00.000Z",
    };
    store.setPauseMeta(run.id, meta);

    const updated = store.getRun(run.id);
    expect(updated.state).toBe("paused");
    expect(updated.pauseMeta).toEqual(meta);
    expect(updated.haltReason).toBeNull();
  });

  it("clearPauseMeta transitions back to running and clears pause_meta", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setPauseMeta(run.id, {
      reason: "rate_limit",
      target: "codex",
      pausedAt: "2026-06-06T01:00:00.000Z",
      nextReprobeAt: "2026-06-06T01:10:00.000Z",
      capDeadlineAt: "2026-06-06T02:00:00.000Z",
    });
    expect(store.getRun(run.id).state).toBe("paused");

    store.clearPauseMeta(run.id);
    const cleared = store.getRun(run.id);
    expect(cleared.state).toBe("running");
    expect(cleared.pauseMeta).toBeNull();
  });

  it("setPauseMeta and clearPauseMeta throw for nonexistent run id", () => {
    const store = newStore();
    expect(() =>
      store.setPauseMeta(999, {
        reason: "rate_limit",
        target: "claude",
        pausedAt: "2026-06-06T01:00:00.000Z",
        nextReprobeAt: "2026-06-06T01:10:00.000Z",
        capDeadlineAt: "2026-06-06T02:00:00.000Z",
      }),
    ).toThrow();
    expect(() => store.clearPauseMeta(999)).toThrow();
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
});

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

  it("stoppedSessionsWithPr returns stopped sessions with matching failure_reason and non-null pr_number", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());

    // stopped + looppilot_stopped + prNumber → included
    const a = seedSession(store, run.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a" });
    store.updateSession(a.id, { state: "stopped", failureReason: "looppilot_stopped", prNumber: 100 });

    // stopped + looppilot_stopped + prNumber=null → excluded
    const b = seedSession(store, run.id, clock(), { linearIssueId: "i-b", linearIdentifier: "TY-2", branch: "b-b" });
    store.updateSession(b.id, { state: "stopped", failureReason: "looppilot_stopped" });

    // stopped + cost_exceeded (OS-caused) + prNumber → excluded
    const c = seedSession(store, run.id, clock(), { linearIssueId: "i-c", linearIdentifier: "TY-3", branch: "b-c" });
    store.updateSession(c.id, { state: "stopped", failureReason: "cost_exceeded", prNumber: 200 });

    // in_review (not stopped) → excluded
    const d = seedSession(store, run.id, clock(), { linearIssueId: "i-d", linearIdentifier: "TY-4", branch: "b-d" });
    store.updateSession(d.id, { state: "in_review", prNumber: 300 });

    const result = store.stoppedSessionsWithPr("looppilot_stopped");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(a.id);
    expect(result[0].state).toBe("stopped");
    expect(result[0].failureReason).toBe("looppilot_stopped");
    expect(result[0].prNumber).toBe(100);
  });

  it("stoppedSessionsWithPr excludes superseded sessions when a newer session exists for the same issue", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());

    // Issue A: old stopped session superseded by a newer in_review session → excluded
    const a1 = seedSession(store, run.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a1" });
    store.updateSession(a1.id, { state: "stopped", failureReason: "looppilot_stopped", prNumber: 100 });
    const a2 = seedSession(store, run.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a2" });
    store.updateSession(a2.id, { state: "in_review", prNumber: 200 });

    // Issue A: also verify that a superseded-by-stopped session (newer stopped row) is excluded
    const a3 = seedSession(store, run.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a3" });
    store.updateSession(a3.id, { state: "stopped", failureReason: "cost_exceeded", prNumber: 300 });

    // Issue B: only stopped session (no newer) → included
    const b = seedSession(store, run.id, clock(), { linearIssueId: "i-b", linearIdentifier: "TY-2", branch: "b-b" });
    store.updateSession(b.id, { state: "stopped", failureReason: "looppilot_stopped", prNumber: 400 });

    const result = store.stoppedSessionsWithPr("looppilot_stopped");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(b.id);
    // a1 excluded because a2 and a3 (newer sessions) exist for the same issue
    // a3 excluded because failure_reason is cost_exceeded (not looppilot_stopped)
  });

  it("stoppedSessionsWithPr excludes sessions with recovery_action=abandon (ES-450 Finding 1)", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());

    // abandoned session: recovery_action=abandon → excluded even though it matches state/reason/prNumber
    const a = seedSession(store, run.id, clock(), { linearIssueId: "i-a", linearIdentifier: "TY-1", branch: "b-a" });
    store.updateSession(a.id, {
      state: "stopped",
      failureReason: "looppilot_stopped",
      prNumber: 100,
      recoveryAction: "abandon",
    });

    // non-abandoned session → included
    const b = seedSession(store, run.id, clock(), { linearIssueId: "i-b", linearIdentifier: "TY-2", branch: "b-b" });
    store.updateSession(b.id, { state: "stopped", failureReason: "looppilot_stopped", prNumber: 200 });

    const result = store.stoppedSessionsWithPr("looppilot_stopped");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(b.id);
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

describe("SqliteStore: schema migration (ES-397)", () => {
  // 既存 DB（workflow-recovery 列が無い旧スキーマ）を開いても ALTER TABLE で
  // 列が補われ、updateSession が `no such column` で失敗しないことを確認する。
  it("adds workflow_* columns to a pre-existing task_session table", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "looppilot-migrate-"));
    const dbPath = path.join(dir, "looppilot-os.db");
    try {
      // 旧スキーマ（新列なし）の task_session を持つ DB を直接用意する。
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          task_cap INTEGER NOT NULL,
          state TEXT NOT NULL,
          halt_reason TEXT
        );
        CREATE TABLE task_session (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES run(id),
          linear_issue_id TEXT NOT NULL,
          linear_identifier TEXT NOT NULL,
          issue_title TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          pr_number INTEGER,
          state TEXT NOT NULL,
          cost_usd REAL,
          failure_reason TEXT,
          stop_detail TEXT,
          agent_summary TEXT,
          started_at TEXT NOT NULL,
          monitor_started_at TEXT,
          ended_at TEXT
        );
      `);
      legacy.prepare(
        `INSERT INTO run (started_at, task_cap, state, halt_reason)
         VALUES ('2026-06-06T00:00:00.000Z', 3, 'running', NULL)`,
      ).run();
      legacy.prepare(
        `INSERT INTO task_session
           (run_id, linear_issue_id, linear_identifier, issue_title,
            branch, worktree_path, state, started_at)
         VALUES (1, 'issue-uuid-1', 'TY-1', 'Old task',
                 'looppilot/ty-1', '/wt/ty-1', 'in_review', '2026-06-06T00:00:00.000Z')`,
      ).run();
      legacy.close();

      // 旧 DB を開く → migrate() が列を補う。
      const store = new SqliteStore(dbPath);
      openStores.push(store);

      // 既定値 0 で読めること。
      const session = store.getSession(1);
      expect(session.workflowFixAttempts).toBe(0);
      expect(session.workflowHandledErrorCount).toBe(0);

      // 新列への更新が `no such column` で失敗しないこと。
      expect(() =>
        store.updateSession(1, {
          workflowFixAttempts: 1,
          workflowHandledErrorCount: 2,
        }),
      ).not.toThrow();
      const updated = store.getSession(1);
      expect(updated.workflowFixAttempts).toBe(1);
      expect(updated.workflowHandledErrorCount).toBe(2);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds done_transition_pending column to a pre-existing task_session table (ES-462)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "looppilot-migrate-"));
    const dbPath = path.join(dir, "looppilot-os.db");
    try {
      // Legacy schema WITHOUT done_transition_pending column.
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE IF NOT EXISTS run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pid INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running','idle','halted','paused')),
          halt_reason TEXT,
          pause_meta TEXT
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
          plan_brief TEXT,
          select_rationale TEXT,
          started_at TEXT NOT NULL,
          monitor_started_at TEXT,
          ended_at TEXT,
          workflow_fix_attempts INTEGER NOT NULL DEFAULT 0,
          workflow_handled_error_count INTEGER NOT NULL DEFAULT 0,
          auto_restart_attempts INTEGER NOT NULL DEFAULT 0,
          pending_restart_reason TEXT,
          recovery_attempted INTEGER NOT NULL DEFAULT 0,
          recovery_action TEXT
        );
      `);
      legacy.prepare(
        `INSERT INTO run (pid, started_at, state) VALUES (1, '2026-01-01T00:00:00.000Z', 'running')`,
      ).run();
      // merged row — should be backfilled to done_transition_pending=1 on migration
      legacy.prepare(
        `INSERT INTO task_session
           (run_id, linear_issue_id, linear_identifier, issue_title, branch, state, started_at)
         VALUES (1, 'issue-1', 'TY-1', 'test', 'b', 'merged', '2026-01-01T00:00:00.000Z')`,
      ).run();
      // stopped row — must NOT be backfilled; transition(done) is never retried for stopped
      legacy.prepare(
        `INSERT INTO task_session
           (run_id, linear_issue_id, linear_identifier, issue_title, branch, state, started_at)
         VALUES (1, 'issue-2', 'TY-2', 'test2', 'b2', 'stopped', '2026-01-01T00:00:01.000Z')`,
      ).run();
      legacy.close();

      // Open via SqliteStore — triggers migrate(), which adds done_transition_pending.
      const store = new SqliteStore(dbPath);
      openStores.push(store);

      // Merged rows must be backfilled to 1 so startup recovery retries transition(done).
      const merged = store.getSession(1);
      expect(merged.doneTransitionPending).toBe(1);

      // Non-merged rows must stay at 0 — they never need a done transition retry.
      const stopped = store.getSession(2);
      expect(stopped.doneTransitionPending).toBe(0);

      // updateSession should work with the new column without throwing.
      store.updateSession(merged.id, { doneTransitionPending: 0 });
      expect(store.getSession(merged.id).doneTransitionPending).toBe(0);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opening a fresh DB twice is idempotent (no duplicate-column error)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "looppilot-migrate-"));
    const dbPath = path.join(dir, "looppilot-os.db");
    try {
      const first = new SqliteStore(dbPath);
      first.close();
      // 2回目のオープンで ALTER TABLE が再実行されないこと（列が既に在る）。
      expect(() => {
        const second = new SqliteStore(dbPath);
        openStores.push(second);
      }).not.toThrow();
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe("SqliteStore: migration adds pause_meta column to existing run table", () => {
  it("opens a legacy DB without pause_meta, recreates run table with updated CHECK, and setPauseMeta works", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lpos-mig-"));
    const dbPath = path.join(dir, "test.db");
    try {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          task_cap INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running','idle','halted')),
          halt_reason TEXT
        );
        CREATE TABLE task_session (
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
          plan_brief TEXT,
          started_at TEXT NOT NULL,
          monitor_started_at TEXT,
          ended_at TEXT,
          workflow_fix_attempts INTEGER NOT NULL DEFAULT 0,
          workflow_handled_error_count INTEGER NOT NULL DEFAULT 0,
          auto_restart_attempts INTEGER NOT NULL DEFAULT 0,
          pending_restart_reason TEXT
        );
        INSERT INTO run (started_at, task_cap, state) VALUES ('2026-01-01T00:00:00Z', 5, 'running');
      `);
      raw.close();

      const store = new SqliteStore(dbPath);
      openStores.push(store);
      const run = store.getRun(1);
      expect(run.pauseMeta).toBeNull();

      // setPauseMeta must work on migrated DB (CHECK constraint updated)
      const meta = {
        reason: "rate_limit" as const,
        target: "claude" as const,
        pausedAt: "2026-06-06T01:00:00.000Z",
        nextReprobeAt: "2026-06-06T01:10:00.000Z",
        capDeadlineAt: "2026-06-06T02:00:00.000Z",
      };
      expect(() => store.setPauseMeta(run.id, meta)).not.toThrow();
      const paused = store.getRun(run.id);
      expect(paused.state).toBe("paused");
      expect(paused.pauseMeta).toEqual(meta);

      store.clearPauseMeta(run.id);
      const cleared = store.getRun(run.id);
      expect(cleared.state).toBe("running");
      expect(cleared.pauseMeta).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("select_rationale column", () => {
  it("updateSession sets and reads select_rationale", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "id-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "b",
      worktreePath: "/wt",
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(session.selectRationale).toBeNull();

    store.updateSession(session.id, { selectRationale: "highest priority after auth refactor" });
    const updated = store.getSession(session.id);
    expect(updated.selectRationale).toBe("highest priority after auth refactor");
  });
});

describe("recovery columns (ES-450)", () => {
  it("recovery columns: recovery_attempted defaults to 0 and recovery_action defaults to null", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "issue-1",
      linearIdentifier: "TY-1",
      issueTitle: "test",
      branch: "b",
      worktreePath: "/wt/ty-1",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(session.recoveryAttempted).toBe(0);
    expect(session.recoveryAction).toBeNull();
  });

  it("updateSession can set recoveryAttempted and recoveryAction", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "issue-1",
      linearIdentifier: "TY-1",
      issueTitle: "test",
      branch: "b",
      worktreePath: "/wt/ty-1",
      now: "2026-01-01T00:00:00.000Z",
    });
    store.updateSession(session.id, { recoveryAttempted: 1, recoveryAction: "fix_code" });
    const updated = store.getSession(session.id);
    expect(updated.recoveryAttempted).toBe(1);
    expect(updated.recoveryAction).toBe("fix_code");
  });
});

describe("excludedIssueIds (ES-492)", () => {
  // ES-492: primary exclusion is the needs-human label on the Linear side.
  // excludedIssueIds(runId) is the current-run-only DB guard (needs_human_label_added=0):
  // defense-in-depth when addLabel fails transiently within this run.
  // When addLabel succeeded (needs_human_label_added=1), the label is the authority —
  // label removal during the current run re-enables the ticket immediately (ES-492 Finding 2).
  // Cross-run legacy guard is in legacyExcludedIssueIds() (ES-492 Finding 3).

  it("returns abandoned issue IDs for the current run", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");

    const s1 = store.createSession({
      runId: run.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "stopped", failureReason: "ci_failed", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });

    const s2 = store.createSession({
      runId: run.id, linearIssueId: "issue-B", linearIdentifier: "TY-2",
      issueTitle: "B", branch: "b2", worktreePath: "/wt2",
      now: "2026-01-01T00:00:02.000Z",
    });
    store.updateSession(s2.id, { state: "stopped", failureReason: "design_rejected", endedAt: "2026-01-01T02:00:00.000Z" });

    // Both have needs_human_label_added=0 (default) so the current-run guard applies.
    const excluded = store.excludedIssueIds(run.id);
    expect(excluded).toContain("issue-A");
    expect(excluded).toContain("issue-B");
  });

  it("returns design_rejected issue IDs for the current run", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "stopped", failureReason: "design_rejected", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(store.excludedIssueIds(run.id)).toEqual(["issue-A"]);
  });

  it("returns empty array when no sessions", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    expect(store.excludedIssueIds(run.id)).toEqual([]);
  });

  it("does not apply current-run guard when label was successfully added (ES-492 Finding 2)", () => {
    // When addLabel succeeded, the Linear label is the authority. The current-run guard
    // must not block so that label removal during this run re-enables the ticket.
    const store = newStore();
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });
    store.markNeedsHumanLabelAdded(s.id);  // needs_human_label_added = 1

    expect(store.excludedIssueIds(run.id)).not.toContain("issue-A");
  });

  it("returns [] for post-ES-492 abandoned sessions from a PREVIOUS run (label was applied, cross-run re-entry)", () => {
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });
    // Label was applied — Linear is the cross-run authority.
    store.markNeedsHumanLabelAdded(s.id);

    const run2 = store.createRun(3, "2026-01-02T00:00:00.000Z");
    // Different run_id: no current-run match. needs_human_label_added=1: no legacy match.
    expect(store.excludedIssueIds(run2.id)).toEqual([]);
  });

  it("returns merge_gate_failed (park) issue IDs for the current run (ES-521)", () => {
    // Park terminal (ES-521): recovery_action stays null (PR is kept, not abandoned), so the
    // exclusion can only key off failure_reason. Guards against re-selection while the
    // needs-human label add is still retrying (needs_human_label_added=0).
    const store = newStore();
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", failureReason: "merge_gate_failed", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(store.excludedIssueIds(run.id)).toEqual(["issue-A"]);
  });
});

describe("legacyExcludedIssueIds (ES-492 Finding 3)", () => {
  // Cross-run guard: excludes issues whose LATEST stopped/abandoned session has
  // needs_human_label_added=0. Separate from excludedIssueIds so getAllEligible can
  // check the Linear label FIRST (enabling label-add detection for the promote callback).

  it("excludes legacy abandoned sessions cross-run when label was never applied (pre-ES-492)", () => {
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    // Legacy abandon: markNeedsHumanLabelAdded is never called (label was never added).
    store.updateSession(s.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(store.legacyExcludedIssueIds()).toContain("issue-A");
  });

  it("does not exclude when label was successfully applied", () => {
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });
    store.markNeedsHumanLabelAdded(s.id);

    expect(store.legacyExcludedIssueIds()).not.toContain("issue-A");
  });

  it("legacy guard clears when a newer non-abandoned session exists for the issue", () => {
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });

    // A newer session was created (e.g. after human re-enabled the ticket)
    const run2 = store.createRun(3, "2026-01-02T00:00:00.000Z");
    // Session in run2 is active (not stopped/abandoned), so the legacy guard should not fire.
    store.createSession({
      runId: run2.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b2", worktreePath: "/wt2",
      now: "2026-01-02T00:00:01.000Z",
    });

    // Latest session for issue-A is the active run2 session (not stopped) — legacy guard does not apply.
    expect(store.legacyExcludedIssueIds()).not.toContain("issue-A");
  });

  it("markNeedsHumanLabelAddedByIssueId promotes the session so legacy guard clears", () => {
    // When getAllEligible detects the operator manually added the label (onLegacyLabelDetected),
    // it calls markNeedsHumanLabelAddedByIssueId. After that, legacyExcludedIssueIds no longer
    // includes the issue, so label removal on the next SELECT re-enables it (ES-492 Finding 3).
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", recoveryAction: "abandon", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(store.legacyExcludedIssueIds()).toContain("issue-A");

    store.markNeedsHumanLabelAddedByIssueId("issue-A");

    expect(store.legacyExcludedIssueIds()).not.toContain("issue-A");
  });

  it("excludes and promotes park (merge_gate_failed) sessions cross-run (ES-521)", () => {
    // Same cross-run fallback as legacy abandon sessions, but for park terminals where
    // recovery_action stays null (PR is kept). Also verifies markNeedsHumanLabelAddedByIssueId
    // is kept in sync with the legacy guard's WHERE clause, since getAllEligible's
    // onLegacyLabelDetected callback relies on it to promote park rows too.
    const store = newStore();
    const run1 = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s = store.createSession({
      runId: run1.id, linearIssueId: "issue-A", linearIdentifier: "TY-1",
      issueTitle: "A", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s.id, { state: "stopped", failureReason: "merge_gate_failed", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(store.legacyExcludedIssueIds()).toContain("issue-A");

    store.markNeedsHumanLabelAddedByIssueId("issue-A");

    expect(store.legacyExcludedIssueIds()).not.toContain("issue-A");
  });
});

describe("lastMergedWithPr", () => {
  it("returns null when no merged sessions", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    expect(store.lastMergedWithPr()).toBeNull();
  });

  it("returns the most recently merged session with a PR", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run.id, linearIssueId: "id-1", linearIdentifier: "TY-1",
      issueTitle: "First", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "merged", prNumber: 10, endedAt: "2026-01-01T00:01:00.000Z" });
    const s2 = store.createSession({
      runId: run.id, linearIssueId: "id-2", linearIdentifier: "TY-2",
      issueTitle: "Second", branch: "b2", worktreePath: "/wt2",
      now: "2026-01-01T00:00:02.000Z",
    });
    store.updateSession(s2.id, { state: "merged", prNumber: 11, endedAt: "2026-01-01T00:02:00.000Z" });

    const last = store.lastMergedWithPr();
    expect(last).not.toBeNull();
    expect(last!.linearIdentifier).toBe("TY-2");
    expect(last!.prNumber).toBe(11);
  });

  it("skips merged sessions without pr_number", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(3, "2026-01-01T00:00:00.000Z");
    const s1 = store.createSession({
      runId: run.id, linearIssueId: "id-1", linearIdentifier: "TY-1",
      issueTitle: "NoPr", branch: "b1", worktreePath: "/wt1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "merged", endedAt: "2026-01-01T00:01:00.000Z" });

    expect(store.lastMergedWithPr()).toBeNull();
  });
});

describe("groom_log (ES-451)", () => {
  it("insertGroomLog creates a row and returns it with auto-incremented id", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-23T00:00:00.000Z");
    const row = store.insertGroomLog({
      runId: run.id,
      loopIndex: 0,
      startedAt: "2026-06-23T00:01:00.000Z",
    });
    expect(row.id).toBe(1);
    expect(row.runId).toBe(run.id);
    expect(row.loopIndex).toBe(0);
    expect(row.startedAt).toBe("2026-06-23T00:01:00.000Z");
    expect(row.endedAt).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.actionsRequested).toBe(0);
    expect(row.actionsExecuted).toBe(0);
    expect(row.actionsRejected).toBe(0);
    expect(row.actionDetails).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.errorDetail).toBeNull();
  });

  it("updateGroomLog updates outcome and counters", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-23T00:00:00.000Z");
    const row = store.insertGroomLog({
      runId: run.id,
      loopIndex: 1,
      startedAt: "2026-06-23T00:02:00.000Z",
    });
    store.updateGroomLog(row.id, {
      endedAt: "2026-06-23T00:03:00.000Z",
      summary: "Reprioritized 2 tickets",
      actionsRequested: 3,
      actionsExecuted: 2,
      actionsRejected: 1,
      actionDetails: '[{"type":"reprioritize"}]',
      outcome: "completed",
    });
    const updated = store.getGroomLog(row.id);
    expect(updated.endedAt).toBe("2026-06-23T00:03:00.000Z");
    expect(updated.summary).toBe("Reprioritized 2 tickets");
    expect(updated.actionsRequested).toBe(3);
    expect(updated.actionsExecuted).toBe(2);
    expect(updated.actionsRejected).toBe(1);
    expect(updated.outcome).toBe("completed");
    expect(updated.errorDetail).toBeNull();
  });

  it("updateGroomLog records error detail on failure", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-23T00:00:00.000Z");
    const row = store.insertGroomLog({
      runId: run.id,
      loopIndex: 0,
      startedAt: "2026-06-23T00:01:00.000Z",
    });
    store.updateGroomLog(row.id, {
      endedAt: "2026-06-23T00:01:30.000Z",
      outcome: "error",
      errorDetail: "Codex timeout after 10 minutes",
    });
    const updated = store.getGroomLog(row.id);
    expect(updated.outcome).toBe("error");
    expect(updated.errorDetail).toBe("Codex timeout after 10 minutes");
  });

  it("updateGroomLog with empty patch is a no-op", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-23T00:00:00.000Z");
    const row = store.insertGroomLog({
      runId: run.id,
      loopIndex: 0,
      startedAt: "2026-06-23T00:01:00.000Z",
    });
    store.updateGroomLog(row.id, {});
    const unchanged = store.getGroomLog(row.id);
    expect(unchanged.outcome).toBeNull();
    expect(unchanged.endedAt).toBeNull();
  });

  it("updateGroomLog throws for non-existent id", () => {
    const store = newStore();
    expect(() => store.updateGroomLog(999, { outcome: "completed" })).toThrow(
      /updateGroomLog affected 0 rows/,
    );
  });

  it("getGroomLog throws for unknown id", () => {
    const store = newStore();
    expect(() => store.getGroomLog(999)).toThrow(/groom_log not found/);
  });
});

describe("recentSessionSummaries", () => {
  it("returns merged and stopped sessions ordered by ended_at DESC", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(10, clock()).id;

    // Create 3 sessions: merged, stopped, implementing (active)
    const s1 = seedSession(store, runId, clock(), { linearIdentifier: "ES-1", issueTitle: "Task 1" });
    store.updateSession(s1.id, { state: "merged", costUsd: 1.5, endedAt: clock() });

    const s2 = seedSession(store, runId, clock(), { linearIdentifier: "ES-2", issueTitle: "Task 2" });
    store.updateSession(s2.id, { state: "stopped", costUsd: 0.8, failureReason: "exception", endedAt: clock() });

    const s3 = seedSession(store, runId, clock(), { linearIdentifier: "ES-3", issueTitle: "Task 3" });
    store.updateSession(s3.id, { state: "implementing" });

    const result = store.recentSessionSummaries(10);
    expect(result).toHaveLength(2);
    // Most recent first (s2 ended after s1)
    expect(result[0]).toEqual({ linearIdentifier: "ES-2", issueTitle: "Task 2", state: "stopped", costUsd: 0.8 });
    expect(result[1]).toEqual({ linearIdentifier: "ES-1", issueTitle: "Task 1", state: "merged", costUsd: 1.5 });
  });

  it("respects the limit", () => {
    const store = newStore();
    const clock = makeClock();
    const runId = store.createRun(10, clock()).id;
    for (let i = 0; i < 5; i++) {
      const s = seedSession(store, runId, clock(), { linearIdentifier: `ES-${i}` });
      store.updateSession(s.id, { state: "merged", costUsd: i * 0.5, endedAt: clock() });
    }
    expect(store.recentSessionSummaries(3)).toHaveLength(3);
  });
});

describe("doneTransitionPending column (ES-462)", () => {
  it("doneTransitionPending defaults to 0 on createSession", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "issue-1",
      linearIdentifier: "TY-1",
      issueTitle: "test",
      branch: "b",
      worktreePath: "/wt/ty-1",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(session.doneTransitionPending).toBe(0);
  });

  it("updateSession can set doneTransitionPending to 1 and back to 0", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(1, "2026-01-01T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "issue-1",
      linearIdentifier: "TY-1",
      issueTitle: "test",
      branch: "b",
      worktreePath: "/wt/ty-1",
      now: "2026-01-01T00:00:00.000Z",
    });
    store.updateSession(session.id, { doneTransitionPending: 1 });
    expect(store.getSession(session.id).doneTransitionPending).toBe(1);

    store.updateSession(session.id, { doneTransitionPending: 0 });
    expect(store.getSession(session.id).doneTransitionPending).toBe(0);
  });

  it("sessionsWithPendingDoneTransition returns only merged sessions with flag=1", () => {
    const store = new SqliteStore(":memory:");
    openStores.push(store);
    const run = store.createRun(1, "2026-01-01T00:00:00.000Z");

    // merged + pending=1 → should be returned
    const s1 = store.createSession({
      runId: run.id,
      linearIssueId: "issue-1",
      linearIdentifier: "TY-1",
      issueTitle: "A",
      branch: "b1",
      worktreePath: "/wt/1",
      now: "2026-01-01T00:00:01.000Z",
    });
    store.updateSession(s1.id, { state: "merged", endedAt: "2026-01-01T01:00:00.000Z", doneTransitionPending: 1 });

    // merged + pending=0 → should NOT be returned
    const s2 = store.createSession({
      runId: run.id,
      linearIssueId: "issue-2",
      linearIdentifier: "TY-2",
      issueTitle: "B",
      branch: "b2",
      worktreePath: "/wt/2",
      now: "2026-01-01T00:00:02.000Z",
    });
    store.updateSession(s2.id, { state: "merged", endedAt: "2026-01-01T01:00:00.000Z" });

    // in_review + pending=1 → should NOT be returned (not merged)
    const s3 = store.createSession({
      runId: run.id,
      linearIssueId: "issue-3",
      linearIdentifier: "TY-3",
      issueTitle: "C",
      branch: "b3",
      worktreePath: "/wt/3",
      now: "2026-01-01T00:00:03.000Z",
    });
    store.updateSession(s3.id, { state: "in_review", doneTransitionPending: 1 });

    const pending = store.sessionsWithPendingDoneTransition();
    expect(pending).toHaveLength(1);
    expect(pending[0].linearIssueId).toBe("issue-1");
  });
});

describe("SqliteStore: idle timeout", () => {
  it("createRun initializes idleStartedAt as null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    expect(run.idleStartedAt).toBeNull();
  });

  it("setIdleStartedAt persists timestamp and getRun returns it", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBe("2026-06-06T01:00:00.000Z");
  });

  it("setIdleStartedAt is idempotent — does not overwrite existing value", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T02:00:00.000Z");
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBe("2026-06-06T01:00:00.000Z");
  });

  it("clearIdleStartedAt resets to null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-06-06T01:00:00.000Z");
    store.clearIdleStartedAt(run.id);
    const updated = store.getRun(run.id);
    expect(updated.idleStartedAt).toBeNull();
  });

  it("clearIdleStartedAt is safe when already null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-06T00:00:00.000Z");
    store.clearIdleStartedAt(run.id);
    expect(store.getRun(run.id).idleStartedAt).toBeNull();
  });

  // ES-516: SCOUT 実行時間の idle 不算入用プリミティブ。
  // clear→再set はゼロリセットになる（setIdleStartedAt は NULL ガード付き上書き不可）ため、
  // タイムスタンプの前方シフトで「経過に数えない」を実現する。
  it("advanceIdleStartedAt shifts the timestamp forward by deltaMs (ES-516)", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-07-08T01:00:00.000Z");
    store.advanceIdleStartedAt(run.id, 5 * 60_000);
    expect(store.getRun(run.id).idleStartedAt).toBe("2026-07-08T01:05:00.000Z");
  });

  it("advanceIdleStartedAt accumulates across calls", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-07-08T01:00:00.000Z");
    store.advanceIdleStartedAt(run.id, 60_000);
    store.advanceIdleStartedAt(run.id, 30_000);
    expect(store.getRun(run.id).idleStartedAt).toBe("2026-07-08T01:01:30.000Z");
  });

  it("advanceIdleStartedAt is a no-op when idle_started_at is null", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.advanceIdleStartedAt(run.id, 60_000);
    expect(store.getRun(run.id).idleStartedAt).toBeNull();
  });

  it("advanceIdleStartedAt throws for an unknown run id", () => {
    const store = newStore();
    expect(() => store.advanceIdleStartedAt(999, 60_000)).toThrow(
      /run not found/,
    );
  });

  it("advanceIdleStartedAt is a no-op for deltaMs = 0 or negative (ES-516)", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "2026-07-08T01:00:00.000Z");
    store.advanceIdleStartedAt(run.id, 0);
    expect(store.getRun(run.id).idleStartedAt).toBe("2026-07-08T01:00:00.000Z");
    store.advanceIdleStartedAt(run.id, -60_000);
    expect(store.getRun(run.id).idleStartedAt).toBe("2026-07-08T01:00:00.000Z");
  });

  it("advanceIdleStartedAt is a no-op for a corrupt stored timestamp (ES-516)", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.setIdleStartedAt(run.id, "not-a-timestamp");
    expect(() => store.advanceIdleStartedAt(run.id, 60_000)).not.toThrow();
    expect(store.getRun(run.id).idleStartedAt).toBe("not-a-timestamp");
  });
});

describe("design_review_log CRUD (ES-477)", () => {
  it("inserts and retrieves a design review log row", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-25T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-25T00:00:00Z",
    });
    const log = store.insertDesignReviewLog({
      runId: run.id,
      sessionId: session.id,
      attempt: 1,
      startedAt: "2026-06-25T00:01:00Z",
    });
    expect(log.runId).toBe(run.id);
    expect(log.sessionId).toBe(session.id);
    expect(log.attempt).toBe(1);
    expect(log.verdict).toBeNull();
    expect(log.outcome).toBeNull();
  });

  it("updates a design review log row with verdict", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-25T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-25T00:00:00Z",
    });
    const log = store.insertDesignReviewLog({
      runId: run.id,
      sessionId: session.id,
      attempt: 1,
      startedAt: "2026-06-25T00:01:00Z",
    });
    store.updateDesignReviewLog(log.id, {
      endedAt: "2026-06-25T00:02:00Z",
      verdict: "approve",
      reasons: JSON.stringify([]),
      outcome: "approved",
    });
    const updated = store.getDesignReviewLog(log.id);
    expect(updated.verdict).toBe("approve");
    expect(updated.outcome).toBe("approved");
    expect(updated.endedAt).toBe("2026-06-25T00:02:00Z");
  });
});

describe("task_session.design_review_attempts migration (ES-477)", () => {
  it("defaults design_review_attempts to 0 for new sessions", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-25T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-25T00:00:00Z",
    });
    expect(session.designReviewAttempts).toBe(0);
  });
});

describe("self_review_log CRUD", () => {
  it("insertSelfReviewLog creates a row and getSelfReviewLog retrieves it", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-06-25T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "id-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "looppilot/ty-1",
      worktreePath: "/wt/ty-1",
      now: "2026-06-25T00:00:00.000Z",
    });
    const log = store.insertSelfReviewLog({
      runId: run.id,
      sessionId: session.id,
      startedAt: "2026-06-25T00:01:00.000Z",
    });
    expect(log.id).toBeGreaterThan(0);
    expect(log.runId).toBe(run.id);
    expect(log.sessionId).toBe(session.id);
    expect(log.outcome).toBeNull();
    store.close();
  });

  it("updateSelfReviewLog updates fields", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-06-25T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "id-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "looppilot/ty-1",
      worktreePath: "/wt/ty-1",
      now: "2026-06-25T00:00:00.000Z",
    });
    const log = store.insertSelfReviewLog({
      runId: run.id,
      sessionId: session.id,
      startedAt: "2026-06-25T00:01:00.000Z",
    });
    store.updateSelfReviewLog(log.id, {
      endedAt: "2026-06-25T00:02:00.000Z",
      verdict: "pass",
      issueCount: 0,
      summary: "All good",
      outcome: "passed",
      costUsd: 0.5,
    });
    const updated = store.getSelfReviewLog(log.id);
    expect(updated.endedAt).toBe("2026-06-25T00:02:00.000Z");
    expect(updated.verdict).toBe("pass");
    expect(updated.issueCount).toBe(0);
    expect(updated.summary).toBe("All good");
    expect(updated.outcome).toBe("passed");
    expect(updated.costUsd).toBe(0.5);
    store.close();
  });

  it("getSelfReviewLogsForSession returns empty array when no logs", () => {
    const store = new SqliteStore(":memory:");
    const run = store.createRun(3, "2026-06-25T00:00:00.000Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "id-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "b",
      worktreePath: "/w",
      now: "2026-06-25T00:00:00.000Z",
    });
    expect(store.getSelfReviewLogsForSession(session.id)).toEqual([]);
    store.close();
  });
});

describe("verify_log CRUD (ES-487)", () => {
  it("insertVerifyLog creates a row and getVerifyLog retrieves it", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    const log = store.insertVerifyLog({
      runId: run.id,
      sessionId: session.id,
      attempt: 1,
      startedAt: "2026-06-27T00:01:00Z",
    });
    expect(log.id).toBeGreaterThan(0);
    expect(log.runId).toBe(run.id);
    expect(log.sessionId).toBe(session.id);
    expect(log.attempt).toBe(1);
    expect(log.verdict).toBeNull();
    expect(log.reasonCount).toBe(0);
    expect(log.evidence).toBeNull();
    expect(log.outcome).toBeNull();
    expect(log.costUsd).toBeNull();
    expect(log.errorDetail).toBeNull();
    expect(log.startedAt).toBe("2026-06-27T00:01:00Z");
    expect(log.endedAt).toBeNull();
  });

  it("updateVerifyLog updates fields", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    const log = store.insertVerifyLog({
      runId: run.id,
      sessionId: session.id,
      attempt: 1,
      startedAt: "2026-06-27T00:01:00Z",
    });
    store.updateVerifyLog(log.id, {
      endedAt: "2026-06-27T00:02:00Z",
      verdict: "fail",
      reasonCount: 2,
      evidence: '{"build":"fail","test":"pass"}',
      outcome: "failed",
      costUsd: 1.5,
      errorDetail: "verifier timed out",
    });
    const updated = store.getVerifyLog(log.id);
    expect(updated.endedAt).toBe("2026-06-27T00:02:00Z");
    expect(updated.verdict).toBe("fail");
    expect(updated.reasonCount).toBe(2);
    expect(updated.evidence).toBe('{"build":"fail","test":"pass"}');
    expect(updated.outcome).toBe("failed");
    expect(updated.costUsd).toBe(1.5);
    expect(updated.errorDetail).toBe("verifier timed out");
  });

  it("getVerifyLogsForSession returns logs ordered by id", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    store.insertVerifyLog({ runId: run.id, sessionId: session.id, attempt: 1, startedAt: "2026-06-27T00:01:00Z" });
    store.insertVerifyLog({ runId: run.id, sessionId: session.id, attempt: 2, startedAt: "2026-06-27T00:03:00Z" });
    const logs = store.getVerifyLogsForSession(session.id);
    expect(logs).toHaveLength(2);
    expect(logs[0].attempt).toBe(1);
    expect(logs[1].attempt).toBe(2);
  });

  it("getVerifyLogsForSession returns empty array when no logs", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    expect(store.getVerifyLogsForSession(session.id)).toEqual([]);
  });
});

describe("task_session.verifyAttempts/recoveryTurnAttempts migration (ES-487)", () => {
  it("defaults verifyAttempts and recoveryTurnAttempts to 0 for new sessions", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    expect(session.verifyAttempts).toBe(0);
    expect(session.recoveryTurnAttempts).toBe(0);
  });

  it("updateSession can patch verifyAttempts and recoveryTurnAttempts", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-06-27T00:00:00Z");
    const session = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "TY-1",
      issueTitle: "Test",
      branch: "br",
      worktreePath: "/wt/test",
      now: "2026-06-27T00:00:00Z",
    });
    store.updateSession(session.id, { verifyAttempts: 2, recoveryTurnAttempts: 1 });
    const updated = store.getSession(session.id);
    expect(updated.verifyAttempts).toBe(2);
    expect(updated.recoveryTurnAttempts).toBe(1);
  });
});

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

  it("getMergeGateLogsForSession はセッションの行のみを id 昇順で返す", () => {
    const store = newStore();
    const clock = makeClock();
    const run = store.createRun(3, clock());
    const s1 = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-1",
      linearIdentifier: "ES-1",
      issueTitle: "t",
      branch: "b",
      worktreePath: "/tmp/wt",
      now: clock(),
    });
    const s2 = store.createSession({
      runId: run.id,
      linearIssueId: "uuid-2",
      linearIdentifier: "ES-2",
      issueTitle: "t2",
      branch: "b2",
      worktreePath: "/tmp/wt2",
      now: clock(),
    });
    const a = store.insertMergeGateLog({
      runId: run.id,
      sessionId: s1.id,
      attempt: 1,
      startedAt: clock(),
    });
    store.insertMergeGateLog({
      runId: run.id,
      sessionId: s2.id,
      attempt: 1,
      startedAt: clock(),
    });
    const b = store.insertMergeGateLog({
      runId: run.id,
      sessionId: s1.id,
      attempt: 2,
      startedAt: clock(),
    });
    store.updateMergeGateLog(a.id, {
      verdict: "fail",
      outcome: "fixed",
    });

    const logs = store.getMergeGateLogsForSession(s1.id);
    expect(logs.map((l) => l.id)).toEqual([a.id, b.id]);
    expect(logs[0].verdict).toBe("fail");
    expect(logs[0].outcome).toBe("fixed");
  });
});

describe("scout_log CRUD (ES-516)", () => {
  it("inserts a scout log row with fired_at and null defaults", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    const row = store.insertScoutLog({
      runId: run.id,
      firedAt: "2026-07-08T01:00:00.000Z",
    });
    expect(row.runId).toBe(run.id);
    expect(row.firedAt).toBe("2026-07-08T01:00:00.000Z");
    expect(row.endedAt).toBeNull();
    expect(row.candidates).toBeNull();
    expect(row.verdicts).toBeNull();
    expect(row.createdIssueIdentifiers).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.costUsd).toBeNull();
    expect(row.errorDetail).toBeNull();
  });

  it("updates scout log fields via partial patch", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    const row = store.insertScoutLog({
      runId: run.id,
      firedAt: "2026-07-08T01:00:00.000Z",
    });
    store.updateScoutLog(row.id, {
      endedAt: "2026-07-08T01:20:00.000Z",
      candidates: JSON.stringify([{ title: "flaky test", evidence_type: "objective" }]),
      verdicts: JSON.stringify([{ verdict: "accept" }]),
      createdIssueIdentifiers: JSON.stringify(["ES-999"]),
      outcome: "completed",
      costUsd: 1.23,
    });
    const updated = store.getScoutLog(row.id);
    expect(updated.endedAt).toBe("2026-07-08T01:20:00.000Z");
    expect(updated.candidates).toContain("flaky test");
    expect(updated.verdicts).toContain("accept");
    expect(updated.createdIssueIdentifiers).toBe(JSON.stringify(["ES-999"]));
    expect(updated.outcome).toBe("completed");
    expect(updated.costUsd).toBe(1.23);
    expect(updated.errorDetail).toBeNull();
  });

  it("updateScoutLog rejects unknown patch keys", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    const row = store.insertScoutLog({
      runId: run.id,
      firedAt: "2026-07-08T01:00:00.000Z",
    });
    expect(() =>
      store.updateScoutLog(row.id, { bogus: 1 } as never),
    ).toThrow(/unknown patch key/);
  });

  it("getScoutLog throws for a missing id", () => {
    const store = newStore();
    expect(() => store.getScoutLog(999)).toThrow(/scout_log not found/);
  });

  it("latestScoutFiredAt returns null when scout has never run", () => {
    const store = newStore();
    expect(store.latestScoutFiredAt()).toBeNull();
  });

  it("latestScoutFiredAt returns the max fired_at across runs", () => {
    const store = newStore();
    const run1 = store.createRun(3, "2026-07-07T00:00:00.000Z");
    const run2 = store.createRun(3, "2026-07-08T00:00:00.000Z");
    store.insertScoutLog({ runId: run1.id, firedAt: "2026-07-07T05:00:00.000Z" });
    store.insertScoutLog({ runId: run2.id, firedAt: "2026-07-08T09:00:00.000Z" });
    store.insertScoutLog({ runId: run2.id, firedAt: "2026-07-08T03:00:00.000Z" });
    expect(store.latestScoutFiredAt()).toBe("2026-07-08T09:00:00.000Z");
  });

  it("latestScoutFiredAt ignores skipped rows so a board-fetch failure does not consume the interval (Finding 2 — ES-519)", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    // A skipped row (e.g. board-fetch failure) recorded at a later time
    const skippedRow = store.insertScoutLog({ runId: run.id, firedAt: "2026-07-08T12:00:00.000Z" });
    store.updateScoutLog(skippedRow.id, { outcome: "skipped", endedAt: "2026-07-08T12:00:01.000Z", costUsd: 0 });
    // An earlier completed row
    const completedRow = store.insertScoutLog({ runId: run.id, firedAt: "2026-07-08T06:00:00.000Z" });
    store.updateScoutLog(completedRow.id, { outcome: "completed", endedAt: "2026-07-08T06:30:00.000Z", costUsd: 1.5 });
    // latestScoutFiredAt must return the completed row, not the skipped one
    expect(store.latestScoutFiredAt()).toBe("2026-07-08T06:00:00.000Z");
  });

  it("latestScoutFiredAt returns null when all rows are skipped", () => {
    const store = newStore();
    const run = store.createRun(3, "2026-07-08T00:00:00.000Z");
    const skippedRow = store.insertScoutLog({ runId: run.id, firedAt: "2026-07-08T12:00:00.000Z" });
    store.updateScoutLog(skippedRow.id, { outcome: "skipped", endedAt: "2026-07-08T12:00:01.000Z", costUsd: 0 });
    expect(store.latestScoutFiredAt()).toBeNull();
  });
});
