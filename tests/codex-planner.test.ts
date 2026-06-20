import { describe, it, expect } from "vitest";
import process from "node:process";
import { CodexPlanner } from "../src/codex-planner.js";
import { FakeCommandRunner } from "./fakes.js";
import type { RunOptions, CommandResult } from "../src/types.js";

const STDERR_TAIL = "Error: something broke in codex";

function makePlanner(
  runner: FakeCommandRunner,
  logs: string[],
  extraArgs?: string[],
): CodexPlanner {
  return new CodexPlanner(runner, {
    log: (line: string) => logs.push(line),
    extraArgs,
  });
}

function codexStub(
  runner: FakeCommandRunner,
  result: Partial<CommandResult> | ((args: string[], opts: RunOptions) => Partial<CommandResult>),
): void {
  runner.on(["codex"], result);
}

describe("CodexPlanner.run", () => {
  it("codex exec を --ephemeral 付きで起動し cwd=worktreePath を設定する", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "picked TY-42\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt/issue-42",
      prompt: "Pick the next task from the list.",
    });

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.cmd).toBe("codex");
    expect(call.args).toEqual([
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "Pick the next task from the list.",
    ]);
    expect(call.opts.cwd).toBe("/wt/issue-42");
  });

  it("extraArgs がある場合はプロンプトの前に挿入される", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "done\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs, ["--sandbox", "read-only"]).run({
      worktreePath: "/wt",
      prompt: "Enrich this ticket.",
    });

    expect(runner.calls[0]!.args).toEqual([
      "exec",
      "--ephemeral",
      "--ask-for-approval",
      "never",
      "--sandbox",
      "read-only",
      "Enrich this ticket.",
    ]);
  });

  it("timeoutMs 指定時は opts.timeoutMs に渡す（hung codex の hard backstop）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "Do something.",
      timeoutMs: 1_800_000,
    });

    expect(runner.calls[0]!.opts.timeoutMs).toBe(1_800_000);
  });

  it("timeoutMs 未指定時は opts.timeoutMs を設定しない", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "Do something.",
    });

    expect(runner.calls[0]!.opts.timeoutMs).toBeUndefined();
  });

  it("opts.defaultTimeoutMs を ctx.timeoutMs のフォールバックとして使う（config タイムアウトの配線）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    const planner = new CodexPlanner(runner, {
      log: (line: string) => logs.push(line),
      defaultTimeoutMs: 1_800_000,
    });
    await planner.run({ worktreePath: "/wt", prompt: "Do something." });

    expect(runner.calls[0]!.opts.timeoutMs).toBe(1_800_000);
  });

  it("ctx.timeoutMs は opts.defaultTimeoutMs より優先される", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    const planner = new CodexPlanner(runner, {
      log: (line: string) => logs.push(line),
      defaultTimeoutMs: 1_800_000,
    });
    await planner.run({ worktreePath: "/wt", prompt: "Do something.", timeoutMs: 600_000 });

    expect(runner.calls[0]!.opts.timeoutMs).toBe(600_000);
  });

  it("codex exec は opts.stdin を 'ignore' に設定して起動する（stdin ハング防止）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "Do something.",
    });

    expect(runner.calls[0]!.opts.stdin).toBe("ignore");
  });

  it("codex 子プロセスに機密 env を渡さない（IPI 漏えい防止）", async () => {
    const SECRETS = {
      LINEAR_API_KEY: "lin_xxx",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/xxx",
      GH_TOKEN: "ghp_xxx",
      GITHUB_TOKEN: "gho_xxx",
      GH_ENTERPRISE_TOKEN: "ghp_ent",
      GITHUB_ENTERPRISE_TOKEN: "gho_ent",
      CODEX_API_KEY: "cdx_xxx",
      OPENAI_API_KEY: "sk-xxx",
      CODEX_ACCESS_TOKEN: "cat_xxx",
    };
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({
        worktreePath: "/wt",
        prompt: "task",
      });

      const env = runner.calls[0]!.opts.env!;
      for (const key of Object.keys(SECRETS)) {
        expect(env).not.toHaveProperty(key);
      }
      expect(env).toHaveProperty("PATH");
    } finally {
      for (const key of Object.keys(SECRETS)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("allowlist 外の env 変数（AWS_SECRET_ACCESS_KEY 等）を渡さない（最小権限）", async () => {
    const NON_ALLOWLISTED = {
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      NPM_TOKEN: "npm_token_xxx",
      DATABASE_URL: "postgres://user:pass@host/db",
      MY_CUSTOM_SECRET: "s3cr3t",
    };
    const saved = { ...process.env };
    Object.assign(process.env, NON_ALLOWLISTED);
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({
        worktreePath: "/wt",
        prompt: "task",
      });

      const env = runner.calls[0]!.opts.env!;
      for (const key of Object.keys(NON_ALLOWLISTED)) {
        expect(env).not.toHaveProperty(key);
      }
    } finally {
      for (const key of Object.keys(NON_ALLOWLISTED)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("exit 0 → kind=completed、stdout を text として返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "  picked TY-42  \n", stderr: "" });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(outcome).toEqual({ kind: "completed", text: "picked TY-42" });
  });

  it("exit 0 で stdout が空 → kind=completed、text は空文字", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "", stderr: "" });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(outcome).toEqual({ kind: "completed", text: "" });
  });

  it("非0終了 → kind=error、stderr 末尾を含むメッセージ", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: STDERR_TAIL });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toContain("code 1");
    expect((outcome as { kind: "error"; message: string }).message).toContain(STDERR_TAIL);
  });

  it("非0終了 + 空 stderr → コロン付加なしのメッセージ", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 2, stdout: "", stderr: "" });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(outcome).toEqual({
      kind: "error",
      message: "codex exited with code 2",
    });
  });

  it("非0終了 + 長い stderr → 末尾 1000 文字に切り詰める", async () => {
    const runner = new FakeCommandRunner();
    const longStderr = "A".repeat(500) + "B".repeat(1500);
    codexStub(runner, { code: 1, stdout: "", stderr: longStderr });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    const msg = (outcome as { kind: "error"; message: string }).message;
    expect(msg).toContain("code 1");
    expect(msg).not.toContain("A".repeat(500));
    expect(msg).toContain("B".repeat(1000));
  });

  it("タイムアウト（CommandRunner が reject）→ kind=error", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex"], () => {
      throw new Error('command "codex" timed out after 1800000ms');
    });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
      timeoutMs: 1_800_000,
    });

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toContain("timed out");
  });

  it("CommandRunner が非 Error 値で reject → String(err) にフォールバック", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex"], () => {
      throw "connection reset";  // eslint-disable-line no-throw-literal
    });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(outcome).toEqual({
      kind: "error",
      message: "connection reset",
    });
  });

  it("成功時に started + completed ログを出力する", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "result text\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(logs[0]).toContain("codex session started");
    expect(logs[1]).toContain("codex session completed");
  });

  it("失敗時に started + error ログを出力する", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "fail" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(logs[0]).toContain("codex session started");
    expect(logs[1]).toContain("codex session error");
  });

  it("タイムアウト時に started + failed ログを出力する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex"], () => {
      throw new Error("timed out");
    });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "pick task",
    });

    expect(logs[0]).toContain("codex session started");
    expect(logs[1]).toContain("codex session failed");
  });
});

describe("CodexPlanner.checkAvailability", () => {
  it("codex --version が成功かつ認証済み → バージョン文字列を返す", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex", "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on(["codex", "login", "status"], { code: 0, stdout: "", stderr: "" });
    const logs: string[] = [];
    const version = await makePlanner(runner, logs).checkAvailability();

    expect(version).toBe("codex-cli 0.137.0");
    expect(runner.calls[0]!.cmd).toBe("codex");
    expect(runner.calls[0]!.args).toEqual(["--version"]);
    expect(runner.calls[0]!.opts.cwd).toBe(".");
    expect(runner.calls[1]!.args).toEqual(["login", "status"]);
  });

  it("checkAvailability の認証確認は run() と同じフィルタ済み env を使う（env-only 認証の早期検出）", async () => {
    const SECRETS = {
      CODEX_API_KEY: "cdx_xxx",
      CODEX_ACCESS_TOKEN: "cat_xxx",
      OPENAI_API_KEY: "sk-xxx",
      GH_TOKEN: "ghp_xxx",
    };
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      const runner = new FakeCommandRunner();
      runner.on(["codex", "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
      runner.on(["codex", "login", "status"], { code: 0, stdout: "", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).checkAvailability();

      // login status (calls[1]) must use the filtered env — not the parent env — so that
      // hosts relying on env-var-only auth fail here at preflight rather than silently during run().
      const authEnv = runner.calls[1]!.opts.env;
      expect(authEnv).toBeDefined();
      for (const key of Object.keys(SECRETS)) {
        expect(authEnv).not.toHaveProperty(key);
      }
      expect(authEnv).toHaveProperty("HOME");
    } finally {
      for (const key of Object.keys(SECRETS)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("codex --version が非0終了 → throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex", "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /codex.*not found|not available/i,
    );
  });

  it("codex --version が spawn 失敗（ENOENT）→ 診断メッセージ付き throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex", "--version"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /not found|not available/i,
    );
    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("codex login status が非0終了（未認証）→ 認証エラーで throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex", "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on(["codex", "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /認証されていません|codex login/,
    );
  });

  it("codex login status が spawn 失敗 → 認証確認エラーで throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["codex", "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on(["codex", "login", "status"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /認証状態を確認できません/,
    );
  });
});
