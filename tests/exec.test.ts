import { describe, it, expect } from "vitest";
import { RealCommandRunner } from "../src/exec.js";
import { FakeCommandRunner, fixedClock, instantSleep } from "./fakes.js";

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

describe("FakeCommandRunner", () => {
  // 仕様(§6): [cmd, ...args] の前方一致で登録応答を返し、欠落フィールドは既定値で埋める
  it("前方一致で登録した応答を返し、欠落フィールドを既定値で埋める", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["gh", "pr", "view"], { stdout: '{"state":"OPEN"}' });

    const result = await fake.run(
      "gh",
      ["pr", "view", "42", "--json", "state"],
      { cwd: "/repo" },
    );
    expect(result).toEqual({ code: 0, stdout: '{"state":"OPEN"}', stderr: "" });
  });

  // 仕様(§6): 関数レスポンダは実引数と opts を受け取り Partial<CommandResult> を返す
  it("関数レスポンダに実引数と opts を渡す", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["git", "rev-list"], (args) => ({ stdout: String(args.length) }));

    const result = await fake.run(
      "git",
      ["rev-list", "--count", "origin/main..HEAD"],
      { cwd: "/repo" },
    );
    expect(result.stdout).toBe("3");
    expect(result.code).toBe(0);
  });

  // 仕様(§6): 全呼び出しを calls に記録する
  it("全呼び出しを calls に記録する", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["git"], { stdout: "ok" });

    await fake.run("git", ["status", "--porcelain"], { cwd: "/repo" });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      cmd: "git",
      args: ["status", "--porcelain"],
      opts: { cwd: "/repo" },
    });
  });

  // 仕様(§6): 未登録の呼び出しは throw する（テストが想定外コマンドに気づける）
  it("未登録の呼び出しは throw する", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["git"], { stdout: "ok" });

    await expect(
      fake.run("gh", ["pr", "view"], { cwd: "/repo" }),
    ).rejects.toThrow(/no FakeCommandRunner stub/);
  });

  // 仕様(§6): より長い前方一致が優先される（具体的な登録が一般的な登録を上書き）
  it("より長い前方一致を優先する", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["gh"], { stdout: "generic" });
    fake.on(["gh", "pr", "merge"], { stdout: "specific" });

    const result = await fake.run(
      "gh",
      ["pr", "merge", "42", "--squash"],
      { cwd: "/repo" },
    );
    expect(result.stdout).toBe("specific");
  });

  // 仕様(§6): onStdoutLine が設定されていれば stub の stdout を改行で分割して逐次供給する
  it("onStdoutLine に stub stdout の各行を供給する", async () => {
    const fake = new FakeCommandRunner();
    fake.on(["claude"], { stdout: '{"type":"system"}\n{"type":"result"}\n' });

    const lines: string[] = [];
    await fake.run("claude", ["-p", "hi"], {
      cwd: "/wt",
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
  });
});

describe("fixedClock", () => {
  // 仕様(§6): clock() は呼ぶ度に +1s 進んだ ISO 文字列を返す（決定的タイムスタンプ）
  it("連続呼び出しで 1 秒ずつ進む ISO 文字列を返す", () => {
    const clock = fixedClock("2026-06-06T00:00:00.000Z");
    expect(clock()).toBe("2026-06-06T00:00:00.000Z");
    expect(clock()).toBe("2026-06-06T00:00:01.000Z");
    expect(clock()).toBe("2026-06-06T00:00:02.000Z");
  });

  // 仕様(§6): start 引数で初回の基準時刻を指定できる
  it("start 引数で初回の基準時刻を指定できる", () => {
    const clock = fixedClock("2030-01-01T12:00:00.000Z");
    expect(clock()).toBe("2030-01-01T12:00:00.000Z");
    expect(clock()).toBe("2030-01-01T12:00:01.000Z");
  });

  // 仕様(§6): start 省略時も決定的な既定基準から +1s で進む
  it("start 省略時も決定的な既定基準から +1s で進む", () => {
    const clock = fixedClock();
    const first = clock();
    const second = clock();
    expect(Date.parse(second) - Date.parse(first)).toBe(1000);
  });
});

describe("instantSleep", () => {
  // 仕様(§6): sleep(ms) は即 resolve する（実時間待たない）
  it("即 resolve する（実時間を待たない）", async () => {
    const sleep = instantSleep();
    const before = Date.now();
    await sleep(60_000);
    expect(Date.now() - before).toBeLessThan(50);
  });

  // 仕様(§6): 呼び出された ms を calls に順に記録する
  it("呼び出された ms を calls に順に記録する", async () => {
    const sleep = instantSleep();
    await sleep(1000);
    await sleep(60_000);
    await sleep(300_000);
    expect(sleep.calls).toEqual([1000, 60_000, 300_000]);
  });
});
