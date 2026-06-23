import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストファイルは describe/it/expect/vi を "vitest" から明示 import するため
    // globals は付けない（グローバル名前空間の汚染回避。LoopPilot 同形）。
    include: ["tests/**/*.test.ts"],
    env: {
      TZ: "UTC",
    },
  },
});
