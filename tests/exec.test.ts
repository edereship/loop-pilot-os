import { describe, it, expect } from "vitest";
import { RealCommandRunner } from "../src/exec.js";

describe("RealCommandRunner", () => {
  const runner = new RealCommandRunner();

  // 仕様: 外部プロセスの stdout/stderr を蓄積し、終了コードは resolve する（§5 外部コマンド契約の土台）
  it("正常終了で stdout/stderr を蓄積し code=0 で resolve する", async () => {
    const result = await runner.run(
      "node",
      ["-e", "process.stdout.write('out-data'); process.stderr.write('err-data')"],
      { cwd: process.cwd() },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out-data");
    expect(result.stderr).toBe("err-data");
  });

  // 仕様: 非0終了コードでも reject せず、code を載せて resolve する（git diff --quiet 等の判定に必須）
  it("非0終了コードでも reject せず code を載せて resolve する", async () => {
    const result = await runner.run(
      "node",
      ["-e", "process.stdout.write('partial'); process.exit(3)"],
      { cwd: process.cwd() },
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toBe("");
  });
});
