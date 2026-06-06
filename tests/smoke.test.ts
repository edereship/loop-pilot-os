import { describe, it, expect } from "vitest";

// 雛形タスク用のプレースホルダ。Task 2（共有型 + 最初の実テスト）で削除する。
// vitest は対象テストが 0 件だと失敗するため、それを回避する空打ちだけを行う。
describe("smoke", () => {
  it("vitest が動作する", () => {
    expect(true).toBe(true);
  });
});
