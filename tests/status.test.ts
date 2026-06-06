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
});
