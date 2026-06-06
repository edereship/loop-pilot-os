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
});
