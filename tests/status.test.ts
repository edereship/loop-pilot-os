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
