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

  // 仕様: stream-json 進捗用。完全な1行ごとに onStdoutLine を呼ぶ（複数行を順に供給）
  it("onStdoutLine に完全な行を順に供給する（複数行・全文も stdout に蓄積）", async () => {
    const lines: string[] = [];
    const result = await runner.run(
      "node",
      ["-e", "process.stdout.write('a\\nb\\nc\\n')"],
      { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["a", "b", "c"]);
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.code).toBe(0);
  });

  // 仕様: チャンク境界が行の途中に来てもバッファリングして1行に再構成する。
  // 末尾に改行が無い最終行は close 時に flush する。
  it("チャンク跨ぎの行を再構成し、改行無しの末尾も最終行として供給する", async () => {
    const lines: string[] = [];
    // 1チャンク目 'line1\nli' → 'line1' を供給し 'li' をバッファ
    // 2チャンク目（遅延）'ne2\nline3' → 'line2','line3' を供給（'line3' は close で flush）
    const result = await runner.run(
      "node",
      ["-e", "process.stdout.write('line1\\nli'); setTimeout(() => process.stdout.write('ne2\\nline3'), 50)"],
      { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["line1", "line2", "line3"]);
    expect(result.stdout).toBe("line1\nline2\nline3");
  });

  // 仕様: timeoutMs 超過時はプロセスを kill して reject する（claude/gh のハング対策）
  it("timeoutMs 超過時にプロセスを kill して reject する", async () => {
    await expect(
      runner.run(
        "node",
        ["-e", "setTimeout(() => {}, 10000)"],
        { cwd: process.cwd(), timeoutMs: 100 },
      ),
    ).rejects.toThrow(/timed out after 100ms/);
  });

  // 仕様: timeoutMs を設定しても、その範囲内に終わるプロセスは通常どおり resolve する
  it("timeoutMs 内に終わるプロセスは正常に resolve する", async () => {
    const result = await runner.run(
      "node",
      ["-e", "process.stdout.write('quick')"],
      { cwd: process.cwd(), timeoutMs: 5000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("quick");
  });
});
