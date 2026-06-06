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
