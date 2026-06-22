import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { CodexPlanner, classifyCodexError, type CodexRateLimitOpts } from "../src/codex-planner.js";
import { FakeCommandRunner } from "./fakes.js";
import type { RunOptions, CommandResult, PauseMeta } from "../src/types.js";

const STDERR_TAIL = "Error: something broke in codex";

// Mirror the production platform check so stubs match the actual command used.
const CODEX_CMD = process.platform === "win32" ? "codex.cmd" : "codex";

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

function makeRateLimitOpts(overrides: Partial<CodexRateLimitOpts> = {}): CodexRateLimitOpts {
  return {
    reprobeMinutes: 15,
    capHours: 6,
    codexPatterns: [],
    sleep: async () => {},
    clock: () => 0,
    ...overrides,
  };
}

function makePlannerWithRateLimit(
  runner: FakeCommandRunner,
  logs: string[],
  rlOpts: CodexRateLimitOpts,
): CodexPlanner {
  return new CodexPlanner(runner, {
    log: (line: string) => logs.push(line),
    rateLimit: rlOpts,
  });
}

function codexStub(
  runner: FakeCommandRunner,
  result: Partial<CommandResult> | ((args: string[], opts: RunOptions) => Partial<CommandResult>),
): void {
  runner.on([CODEX_CMD], result);
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
    expect(call.cmd).toBe(CODEX_CMD);
    expect(call.args).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--",
      "-",
    ]);
    expect(call.opts.cwd).toBe("/wt/issue-42");
    expect(call.opts.stdin).toBe("Pick the next task from the list.");
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
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--",
      "-",
    ]);
    expect(runner.calls[0]!.opts.stdin).toBe("Enrich this ticket.");
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

  it("codex exec はプロンプトを opts.stdin 経由で渡す（OS arg-length 制限回避）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "Do something.",
    });

    expect(runner.calls[0]!.opts.stdin).toBe("Do something.");
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
    runner.on([CODEX_CMD], () => {
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
    runner.on([CODEX_CMD], () => {
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
    runner.on([CODEX_CMD], () => {
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
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    // bubblewrap probe is performed on Linux; stub it so the test is portable.
    runner.on(["bwrap", "--version"], { code: 0, stdout: "bwrap 0.8.0\n", stderr: "" });
    const logs: string[] = [];
    const version = await makePlanner(runner, logs).checkAvailability();

    expect(version).toBe("codex-cli 0.137.0");
    expect(runner.calls[0]!.cmd).toBe(CODEX_CMD);
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
      runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
      runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
      // bubblewrap probe is performed on Linux; stub it so the test is portable.
      runner.on(["bwrap", "--version"], { code: 0, stdout: "bwrap 0.8.0\n", stderr: "" });
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
    runner.on([CODEX_CMD, "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /codex.*not found|not available/i,
    );
  });

  it("codex --version が spawn 失敗（ENOENT）→ 診断メッセージ付き throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], () => {
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
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /認証されていません|codex login/,
    );
  });

  it("codex login status が spawn 失敗 → 認証確認エラーで throw", async () => {
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).rejects.toThrow(
      /認証状態を確認できません/,
    );
  });

  it("Linux で bwrap がなくても checkAvailability は成功する（Codex が自前の sandbox helper にフォールバックするため）", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    // bwrap is intentionally not stubbed: if the code calls it, FakeCommandRunner throws.
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });

  it("Linux で bwrap が非0終了でも checkAvailability は成功する（Codex sandbox probe を呼ばないため）", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    // bwrap is intentionally not stubbed: if the code calls it, FakeCommandRunner throws.
    const logs: string[] = [];

    await expect(makePlanner(runner, logs).checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });
});

describe("CodexPlanner proxy credential scrubbing (Finding 1)", () => {
  it("HTTPS_PROXY に認証情報が含まれる場合はそれを除去してから転送する", async () => {
    const proxyWithCreds = "https://user:secret@proxy.example.com:8080";
    const saved = { ...process.env };
    process.env.HTTPS_PROXY = proxyWithCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["HTTPS_PROXY"]).toBeDefined();
      expect(env["HTTPS_PROXY"]).not.toContain("user");
      expect(env["HTTPS_PROXY"]).not.toContain("secret");
      expect(env["HTTPS_PROXY"]).toMatch(/^https:\/\/proxy\.example\.com:8080/);
    } finally {
      if (saved["HTTPS_PROXY"] === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved["HTTPS_PROXY"];
    }
  });

  it("HTTP_PROXY の小文字バリアント（http_proxy）も認証情報を除去する", async () => {
    const proxyWithCreds = "http://admin:pass@corp-proxy.internal:3128";
    const saved = { ...process.env };
    process.env.http_proxy = proxyWithCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["http_proxy"]).toBeDefined();
      expect(env["http_proxy"]).not.toContain("admin");
      expect(env["http_proxy"]).not.toContain("pass");
      expect(env["http_proxy"]).toMatch(/^http:\/\/corp-proxy\.internal:3128/);
    } finally {
      if (saved["http_proxy"] === undefined) delete process.env.http_proxy;
      else process.env.http_proxy = saved["http_proxy"];
    }
  });

  it("認証情報がない proxy URL はそのまま転送する", async () => {
    const proxyNoCreds = "http://proxy.example.com:8080";
    const saved = { ...process.env };
    process.env.HTTP_PROXY = proxyNoCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["HTTP_PROXY"]).toBe(proxyNoCreds);
    } finally {
      if (saved["HTTP_PROXY"] === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved["HTTP_PROXY"];
    }
  });
});

describe("CodexPlanner flag alias detection (Finding 3)", () => {
  it("-s 短縮エイリアスで sandbox が指定された場合はデフォルトの --sandbox danger-full-access を追加しない", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "done\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs, ["-s", "workspace-write"]).run({
      worktreePath: "/wt",
      prompt: "task",
    });

    const args = runner.calls[0]!.args;
    // Default --sandbox danger-full-access must not be prepended
    const sandboxDefaultIdx = args.indexOf("--sandbox");
    expect(sandboxDefaultIdx).toBe(-1);
    expect(args).toContain("-s");
    expect(args).toContain("workspace-write");
  });

  it("--sandbox=value 形式で sandbox が指定された場合はデフォルトの --sandbox danger-full-access を追加しない", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "done\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs, ["--sandbox=workspace-write"]).run({
      worktreePath: "/wt",
      prompt: "task",
    });

    const args = runner.calls[0]!.args;
    expect(args).not.toContain("--sandbox");
    expect(args).toContain("--sandbox=workspace-write");
  });

  it("-a エイリアスが extraArgs にある場合もそのまま透過される", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "done\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs, ["-a", "on-request"]).run({
      worktreePath: "/wt",
      prompt: "task",
    });

    const args = runner.calls[0]!.args;
    expect(args).toContain("-a");
    expect(args).toContain("on-request");
  });
});

describe("CodexPlanner scheme-less proxy scrubbing (Finding 1 extension)", () => {
  it("スキームなし proxy に '@' が含まれる（認証情報あり）場合は env 変数を除去する", async () => {
    const schemelessWithCreds = "user:pass@proxy.internal:8080";
    const saved = { ...process.env };
    process.env.HTTP_PROXY = schemelessWithCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["HTTP_PROXY"]).toBeUndefined();
    } finally {
      if (saved["HTTP_PROXY"] === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved["HTTP_PROXY"];
    }
  });

  it("スキームなし proxy に '@' がない（認証情報なし）場合はそのまま転送する", async () => {
    const schemelessNoCreds = "proxy.internal:8080";
    const saved = { ...process.env };
    process.env.HTTP_PROXY = schemelessNoCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["HTTP_PROXY"]).toBe(schemelessNoCreds);
    } finally {
      if (saved["HTTP_PROXY"] === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved["HTTP_PROXY"];
    }
  });
});

describe("CodexPlanner OPENAI_BASE_URL credential scrubbing (Finding 4)", () => {
  it("OPENAI_BASE_URL に認証情報が含まれる場合はそれを除去してから転送する", async () => {
    const urlWithCreds = "https://user:pass@proxy.example.com/v1";
    const saved = { ...process.env };
    process.env.OPENAI_BASE_URL = urlWithCreds;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["OPENAI_BASE_URL"]).toBeDefined();
      expect(env["OPENAI_BASE_URL"]).not.toContain("user");
      expect(env["OPENAI_BASE_URL"]).not.toContain("pass");
      expect(env["OPENAI_BASE_URL"]).toMatch(/^https:\/\/proxy\.example\.com\/v1/);
    } finally {
      if (saved["OPENAI_BASE_URL"] === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = saved["OPENAI_BASE_URL"];
    }
  });

  it("認証情報がない OPENAI_BASE_URL はそのまま転送する", async () => {
    const url = "https://api.openai.com/v1";
    const saved = { ...process.env };
    process.env.OPENAI_BASE_URL = url;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["OPENAI_BASE_URL"]).toBe(url);
    } finally {
      if (saved["OPENAI_BASE_URL"] === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = saved["OPENAI_BASE_URL"];
    }
  });
});

describe("CodexPlanner bwrap sandbox bypass (Finding 3)", () => {
  it("Linux で extraArgs に --sandbox danger-full-access がある場合は bubblewrap チェックをスキップする", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    // bwrap is intentionally NOT stubbed: if the code calls it, FakeCommandRunner throws.
    const planner = new CodexPlanner(runner, {
      log: () => {},
      extraArgs: ["--sandbox", "danger-full-access"],
    });

    await expect(planner.checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });

  it("Linux で extraArgs に --sandbox=danger-full-access がある場合は bubblewrap チェックをスキップする", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    const planner = new CodexPlanner(runner, {
      log: () => {},
      extraArgs: ["--sandbox=danger-full-access"],
    });

    await expect(planner.checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });

  it("Linux で extraArgs に --yolo がある場合は bubblewrap チェックをスキップする", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    const planner = new CodexPlanner(runner, {
      log: () => {},
      extraArgs: ["--yolo"],
    });

    await expect(planner.checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });

  it("Linux で extraArgs に --dangerously-bypass-approvals-and-sandbox がある場合は bubblewrap チェックをスキップする", async () => {
    if (process.platform !== "linux") return;
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    const planner = new CodexPlanner(runner, {
      log: () => {},
      extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    });

    await expect(planner.checkAvailability()).resolves.toBe("codex-cli 0.137.0");
  });
});

describe("CodexPlanner Windows supplement key casing (Finding 4)", () => {
  it("Windows で大文字小文字が異なる補助キー（ComSpec）も子 env に含める", async () => {
    if (process.platform !== "win32") return;
    const saved = { ...process.env };
    // Simulate Windows reporting supplement key with non-canonical casing.
    process.env["ComSpec"] = "C:\\Windows\\System32\\cmd.exe";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["ComSpec"]).toBe("C:\\Windows\\System32\\cmd.exe");
    } finally {
      if (saved["ComSpec"] === undefined) delete process.env["ComSpec"];
      else process.env["ComSpec"] = saved["ComSpec"];
    }
  });
});

describe("CodexPlanner auth file isolation (Finding 1)", () => {
  it("子プロセスの HOME はシステム一時ディレクトリ配下の専用ディレクトリに差し替えられる（~/.codex auth ファイルを sandbox から隠す）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

    const env = runner.calls[0]!.opts.env!;
    // HOME must be a private per-run subdirectory under os.tmpdir(), not the
    // shared temp root itself, to prevent concurrent runs from sharing state.
    expect(env["HOME"]).toContain("codex-planner-");
    expect(path.dirname(env["HOME"]!)).toBe(os.tmpdir());
  });

  it("CODEX_HOME 未設定時はデフォルト (~/.codex) を CODEX_HOME として子 env に設定する（auth を HOME の外に置く）", async () => {
    const saved = { ...process.env };
    delete process.env["CODEX_HOME"];
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      // CODEX_HOME must be set so Codex locates auth without relying on
      // $HOME/.codex; auth is kept outside HOME to reduce discovery via
      // automatic HOME traversal.
      expect(env["CODEX_HOME"]).toBeDefined();
      expect(env["CODEX_HOME"]).toContain(".codex");
      // HOME is still the private per-run directory for dotfile isolation.
      expect(env["HOME"]).toContain("codex-planner-");
      expect(path.dirname(env["HOME"]!)).toBe(os.tmpdir());
    } finally {
      if (saved["CODEX_HOME"] === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = saved["CODEX_HOME"];
    }
  });

  it("CODEX_HOME が親 env に設定されている場合はその値を子 env の CODEX_HOME として転送する", async () => {
    const saved = { ...process.env };
    process.env["CODEX_HOME"] = "/custom/codex/home";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["CODEX_HOME"]).toBe("/custom/codex/home");
    } finally {
      if (saved["CODEX_HOME"] === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = saved["CODEX_HOME"];
    }
  });

  it("checkAvailability の auth 確認でも HOME は専用の一時ディレクトリに差し替えられる", async () => {
    const runner = new FakeCommandRunner();
    runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
    runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).checkAvailability();

    // The auth check (calls[1]) must use the isolated env.
    const authEnv = runner.calls[1]!.opts.env!;
    expect(authEnv["HOME"]).toContain("codex-planner-");
    expect(path.dirname(authEnv["HOME"]!)).toBe(os.tmpdir());
    // CODEX_HOME must be set in the child env so Codex locates auth
    // without relying on $HOME/.codex.
    expect(authEnv["CODEX_HOME"]).toBeDefined();
  });
});

describe("CodexPlanner Windows .cmd shim (Finding 2)", () => {
  it("Windows では codex.cmd として起動される（npm shim は shell:false では直接実行できないため）", async () => {
    if (process.platform !== "win32") return;
    const runner = new FakeCommandRunner();
    runner.on(["codex.cmd"], { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

    expect(runner.calls[0]!.cmd).toBe("codex.cmd");
  });

  it("Windows 以外では codex として起動される", async () => {
    if (process.platform === "win32") return;
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

    expect(runner.calls[0]!.cmd).toBe("codex");
  });
});

describe("CodexPlanner Windows stdin prompt passthrough (Finding 3)", () => {
  it("Windows ではプロンプトを stdin 経由で渡し、args の最終要素は '-' になる（cmd.exe コマンドライン長制限回避）", async () => {
    if (process.platform !== "win32") return;
    const runner = new FakeCommandRunner();
    runner.on(["codex.cmd"], { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    const prompt = "Do something important.";
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt });

    const call = runner.calls[0]!;
    // The last positional arg must be the stdin sentinel, not the prompt text.
    expect(call.args[call.args.length - 1]).toBe("-");
    // The actual prompt must be piped via stdin.
    expect(call.opts.stdin).toBe(prompt);
  });

  it("Windows では大きなプロンプトも stdin 経由で渡す（8191 文字 cmd.exe 制限を超えても失敗しない）", async () => {
    if (process.platform !== "win32") return;
    const runner = new FakeCommandRunner();
    runner.on(["codex.cmd"], { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    const largePrompt = "A".repeat(9000);
    const outcome = await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: largePrompt });

    expect(outcome.kind).toBe("completed");
    expect(runner.calls[0]!.opts.stdin).toBe(largePrompt);
    expect(runner.calls[0]!.args[runner.calls[0]!.args.length - 1]).toBe("-");
  });
});

describe("CodexPlanner lone-dash prompt guard (Finding 3)", () => {
  it('prompt が "-" 単独の場合は kind=error を即返しサブプロセスを起動しない', async () => {
    const runner = new FakeCommandRunner();
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "-",
    });

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toMatch(/stdin/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('prompt が "-" で始まるが単独でない場合は通常通り起動する（"--help" 等）', async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "--help",
    });

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(1);
  });
});

describe("CodexPlanner certificate path absolutization (Finding 3)", () => {
  it("CODEX_CA_CERTIFICATE が相対パスの場合は絶対パスに解決して転送する", async () => {
    const saved = { ...process.env };
    process.env.CODEX_CA_CERTIFICATE = "certs/ca.pem";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["CODEX_CA_CERTIFICATE"]).toBeDefined();
      expect(path.isAbsolute(env["CODEX_CA_CERTIFICATE"]!)).toBe(true);
    } finally {
      if (saved["CODEX_CA_CERTIFICATE"] === undefined) delete process.env.CODEX_CA_CERTIFICATE;
      else process.env.CODEX_CA_CERTIFICATE = saved["CODEX_CA_CERTIFICATE"];
    }
  });

  it("SSL_CERT_FILE が相対パスの場合は絶対パスに解決して転送する", async () => {
    const saved = { ...process.env };
    process.env.SSL_CERT_FILE = "certs/bundle.pem";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["SSL_CERT_FILE"]).toBeDefined();
      expect(path.isAbsolute(env["SSL_CERT_FILE"]!)).toBe(true);
    } finally {
      if (saved["SSL_CERT_FILE"] === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = saved["SSL_CERT_FILE"];
    }
  });

  it("CODEX_CA_CERTIFICATE が絶対パスの場合はそのまま転送する", async () => {
    const saved = { ...process.env };
    process.env.CODEX_CA_CERTIFICATE = "/etc/ssl/certs/ca.pem";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["CODEX_CA_CERTIFICATE"]).toBe("/etc/ssl/certs/ca.pem");
    } finally {
      if (saved["CODEX_CA_CERTIFICATE"] === undefined) delete process.env.CODEX_CA_CERTIFICATE;
      else process.env.CODEX_CA_CERTIFICATE = saved["CODEX_CA_CERTIFICATE"];
    }
  });
});

describe("CodexPlanner XDG isolation (Finding 4)", () => {
  it("XDG_CONFIG_HOME はホスト値を転送しない（HOME 隔離を無効化するため）", async () => {
    const saved = { ...process.env };
    process.env.XDG_CONFIG_HOME = "/home/user/.config";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["XDG_CONFIG_HOME"]).toBeUndefined();
    } finally {
      if (saved["XDG_CONFIG_HOME"] === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved["XDG_CONFIG_HOME"];
    }
  });

  it("XDG_DATA_HOME と XDG_CACHE_HOME もホスト値を転送しない", async () => {
    const saved = { ...process.env };
    process.env.XDG_DATA_HOME = "/home/user/.local/share";
    process.env.XDG_CACHE_HOME = "/home/user/.cache";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["XDG_DATA_HOME"]).toBeUndefined();
      expect(env["XDG_CACHE_HOME"]).toBeUndefined();
    } finally {
      if (saved["XDG_DATA_HOME"] === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved["XDG_DATA_HOME"];
      if (saved["XDG_CACHE_HOME"] === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved["XDG_CACHE_HOME"];
    }
  });
});

describe("CodexPlanner CODEX_SQLITE_HOME isolation (Finding 6)", () => {
  it("CODEX_SQLITE_HOME はプライベート一時ディレクトリに設定される（並行実行の SQLite ロック競合を防ぐ）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

    const env = runner.calls[0]!.opts.env!;
    // CODEX_SQLITE_HOME must be the per-run private directory, not the shared CODEX_HOME.
    expect(env["CODEX_SQLITE_HOME"]).toBeDefined();
    expect(env["CODEX_SQLITE_HOME"]).toContain("codex-planner-");
    expect(path.dirname(env["CODEX_SQLITE_HOME"]!)).toBe(os.tmpdir());
    // It must be co-located with HOME so all per-run state lives in one place.
    expect(env["CODEX_SQLITE_HOME"]).toBe(env["HOME"]);
  });

  it("CODEX_SQLITE_HOME は CODEX_HOME（共有 auth ディレクトリ）と異なる", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
    const logs: string[] = [];
    await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

    const env = runner.calls[0]!.opts.env!;
    expect(env["CODEX_SQLITE_HOME"]).not.toBe(env["CODEX_HOME"]);
  });
});

describe("CodexPlanner bwrap probe sanitized env (Finding 7a)", () => {
  it("Linux で bwrap プローブはサニタイズ済み env を使う（相対 PATH による shadowing を防ぐ）", async () => {
    if (process.platform !== "linux") return;
    const SECRETS = {
      LINEAR_API_KEY: "lin_xxx",
      GH_TOKEN: "ghp_xxx",
    };
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      const runner = new FakeCommandRunner();
      runner.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
      runner.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
      runner.on(["bwrap", "--version"], { code: 0, stdout: "bwrap 0.8.0\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).checkAvailability();

      const bwrapCall = runner.calls.find((c) => c.cmd === "bwrap");
      expect(bwrapCall).toBeDefined();
      const env = bwrapCall!.opts.env!;
      expect(env).toBeDefined();
      for (const key of Object.keys(SECRETS)) {
        expect(env).not.toHaveProperty(key);
      }
    } finally {
      for (const key of Object.keys(SECRETS)) {
        if (saved[key] === undefined) delete process.env[key as keyof typeof process.env];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("CodexPlanner SSH agent exclusion (Finding 5)", () => {
  it("SSH_AUTH_SOCK は転送しない（shell-capable モードで SSH agent 経由の認証を防ぐ）", async () => {
    const saved = { ...process.env };
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-XXXX/agent.123";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    } finally {
      if (saved["SSH_AUTH_SOCK"] === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved["SSH_AUTH_SOCK"];
    }
  });

  it("SSH_AGENT_PID は転送しない", async () => {
    const saved = { ...process.env };
    process.env.SSH_AGENT_PID = "12345";
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      expect(env["SSH_AGENT_PID"]).toBeUndefined();
    } finally {
      if (saved["SSH_AGENT_PID"] === undefined) delete process.env.SSH_AGENT_PID;
      else process.env.SSH_AGENT_PID = saved["SSH_AGENT_PID"];
    }
  });
});

describe("CodexPlanner PATH sanitization (Finding 7)", () => {
  it("PATH の相対エントリ（'.'）を除去してバイナリ shadowing を防ぐ", async () => {
    const saved = { ...process.env };
    process.env.PATH = `.${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin`;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      const entries = (env["PATH"] ?? "").split(path.delimiter);
      expect(entries).not.toContain(".");
      expect(entries).toContain("/usr/local/bin");
      expect(entries).toContain("/usr/bin");
    } finally {
      if (saved["PATH"] === undefined) delete process.env.PATH;
      else process.env.PATH = saved["PATH"];
    }
  });

  it("PATH の相対エントリ（'node_modules/.bin'）を除去する", async () => {
    const saved = { ...process.env };
    process.env.PATH = `node_modules/.bin${path.delimiter}/usr/bin`;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      const entries = (env["PATH"] ?? "").split(path.delimiter);
      expect(entries).not.toContain("node_modules/.bin");
      expect(entries).toContain("/usr/bin");
    } finally {
      if (saved["PATH"] === undefined) delete process.env.PATH;
      else process.env.PATH = saved["PATH"];
    }
  });

  it("PATH の絶対エントリはそのまま保持する", async () => {
    const saved = { ...process.env };
    process.env.PATH = `/usr/local/bin${path.delimiter}/usr/bin`;
    try {
      const runner = new FakeCommandRunner();
      codexStub(runner, { code: 0, stdout: "ok\n", stderr: "" });
      const logs: string[] = [];
      await makePlanner(runner, logs).run({ worktreePath: "/wt", prompt: "task" });

      const env = runner.calls[0]!.opts.env!;
      const entries = (env["PATH"] ?? "").split(path.delimiter);
      expect(entries).toContain("/usr/local/bin");
      expect(entries).toContain("/usr/bin");
    } finally {
      if (saved["PATH"] === undefined) delete process.env.PATH;
      else process.env.PATH = saved["PATH"];
    }
  });
});

// ---- ES-408: Codex レートリミット検出・待機・再開 ----

describe("classifyCodexError", () => {
  it("デフォルトパターンで rate limit メッセージを検出する", () => {
    const cases = [
      "codex exited with code 1: HTTP 429 Too Many Requests",
      "codex exited with code 1: rate limit exceeded",
      "codex exited with code 1: Rate-limit hit",
      "codex exited with code 1: too many requests, please slow down",
      "codex exited with code 1: server overloaded",
      "codex exited with code 1: quota exceeded for this account",
    ];
    for (const msg of cases) {
      expect(classifyCodexError(msg, [], 0).isRateLimit).toBe(true);
    }
  });

  it("usage limit 表現をデフォルトパターンで検出する（Finding 1）", () => {
    const cases = [
      "codex exited with code 1: usage limit reached",
      "codex exited with code 1: You've hit your usage limit for this period",
      "codex exited with code 1: usage-limit exceeded",
    ];
    for (const msg of cases) {
      expect(classifyCodexError(msg, [], 0).isRateLimit).toBe(true);
    }
  });

  it("非レートリミットエラーは検出しない", () => {
    const cases = [
      "codex exited with code 1: ENOENT spawn codex",
      "codex exited with code 1: permission denied",
      "codex exited with code 1: network error",
      "codex exited with code 2: invalid prompt",
    ];
    for (const msg of cases) {
      expect(classifyCodexError(msg, [], 0).isRateLimit).toBe(false);
    }
  });

  it("config パターンが指定されたらデフォルトを上書きする", () => {
    expect(
      classifyCodexError("custom_pattern_match", ["custom_pattern"], 0).isRateLimit,
    ).toBe(true);
    expect(
      classifyCodexError("rate limit exceeded", ["custom_pattern"], 0).isRateLimit,
    ).toBe(false);
  });

  it("ベストエフォルトで resets 時刻を解析する", () => {
    const nowMs = new Date("2026-06-21T10:00:00Z").getTime();
    const result = classifyCodexError(
      "rate limit exceeded, resets 11:00 utc",
      [],
      nowMs,
    );
    expect(result.isRateLimit).toBe(true);
    expect(result.resetsAtMs).not.toBeNull();
    expect(result.resetsAtMs!).toBeGreaterThan(nowMs);
  });

  it("resets 時刻がなければ resetsAtMs=null", () => {
    const result = classifyCodexError("rate limit exceeded", [], 0);
    expect(result.isRateLimit).toBe(true);
    expect(result.resetsAtMs).toBeNull();
  });
});

describe("CodexPlanner rate-limit retry loop", () => {
  it("レートリミットエラー後に再試行し成功すれば completed を返す", async () => {
    const runner = new FakeCommandRunner();
    let callCount = 0;
    runner.on([CODEX_CMD], () => {
      callCount++;
      if (callCount === 1) {
        return { code: 1, stdout: "", stderr: "rate limit exceeded" };
      }
      return { code: 0, stdout: "plan output\n", stderr: "" };
    });
    const logs: string[] = [];
    const rlOpts = makeRateLimitOpts({ clock: () => 0 });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(callCount).toBe(2);
    expect(outcome).toEqual({ kind: "completed", text: "plan output" });
    expect(logs.some((l) => l.includes("rate limit detected"))).toBe(true);
  });

  it("非レートリミットエラーは再試行せず即返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "permission denied" });
    const logs: string[] = [];
    const rlOpts = makeRateLimitOpts();
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome.kind).toBe("error");
    expect(runner.calls).toHaveLength(1);
    expect(logs.some((l) => l.includes("rate limit detected"))).toBe(false);
  });

  it("cap 超過でエラーを返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "rate limit exceeded" });
    const logs: string[] = [];
    const capMs = 2 * 3_600_000;
    let clockCall = 0;
    const rlOpts = makeRateLimitOpts({
      capHours: 2,
      clock: () => {
        clockCall++;
        return clockCall === 1 ? 0 : capMs;
      },
    });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toContain("rate limit cap exceeded");
    expect(logs.some((l) => l.includes("cap exceeded"))).toBe(true);
  });

  it("wait コールバックが interrupted を返したら interrupted を返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "rate limit exceeded" });
    const logs: string[] = [];
    const capturedMeta: PauseMeta[] = [];
    const rlOpts = makeRateLimitOpts({
      wait: async (meta) => {
        capturedMeta.push(meta);
        return "interrupted";
      },
    });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(capturedMeta).toHaveLength(1);
    expect(capturedMeta[0]!.target).toBe("codex");
    expect(capturedMeta[0]!.reason).toBe("rate_limit");
  });

  it("isInterrupted が true を返したら interrupted を返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "rate limit exceeded" });
    const logs: string[] = [];
    const rlOpts = makeRateLimitOpts({
      isInterrupted: () => true,
    });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome).toEqual({ kind: "interrupted" });
  });

  it("sleep 後に cap 超過していたらエラーを返す", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "rate limit exceeded" });
    const logs: string[] = [];
    const capMs = 6 * 3_600_000;
    let clockValue = 0;
    const rlOpts = makeRateLimitOpts({
      capHours: 6,
      clock: () => clockValue,
      sleep: async () => {
        clockValue = capMs;
      },
    });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; message: string }).message).toContain("rate limit cap exceeded");
  });

  it("reprobe 間隔を sleep に渡す（resets 時刻なし→固定間隔）", async () => {
    const runner = new FakeCommandRunner();
    let callCount = 0;
    runner.on([CODEX_CMD], () => {
      callCount++;
      if (callCount === 1) {
        return { code: 1, stdout: "", stderr: "rate limit exceeded" };
      }
      return { code: 0, stdout: "ok\n", stderr: "" };
    });
    const logs: string[] = [];
    let totalSleptMs = 0;
    const rlOpts = makeRateLimitOpts({
      reprobeMinutes: 10,
      sleep: async (ms) => { totalSleptMs += ms; },
    });
    await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(totalSleptMs).toBe(10 * 60_000);
  });

  it("rate limit マーカーが stderr 末尾 1000 文字より前にある場合でも全 stderr で検出する（Finding 2）", async () => {
    const runner = new FakeCommandRunner();
    // Rate-limit marker at the start, followed by >1000 chars of diagnostics.
    // The tail-only message would not contain the marker; the full stderr must be used.
    const rateLimitPrefix = "HTTP 429 Too Many Requests";
    const laterDiagnostics = "D".repeat(1500);
    const fullStderr = `${rateLimitPrefix}\n${laterDiagnostics}`;
    let callCount = 0;
    runner.on([CODEX_CMD], () => {
      callCount++;
      if (callCount === 1) {
        return { code: 1, stdout: "", stderr: fullStderr };
      }
      return { code: 0, stdout: "ok\n", stderr: "" };
    });
    const logs: string[] = [];
    const rlOpts = makeRateLimitOpts({ clock: () => 0 });
    const outcome = await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(callCount).toBe(2);
    expect(outcome).toEqual({ kind: "completed", text: "ok" });
    expect(logs.some((l) => l.includes("rate limit detected"))).toBe(true);
  });

  it("rateLimit 未設定時は再試行なしで動作する（既存動作）", async () => {
    const runner = new FakeCommandRunner();
    codexStub(runner, { code: 1, stdout: "", stderr: "rate limit exceeded" });
    const logs: string[] = [];
    const outcome = await makePlanner(runner, logs).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(outcome.kind).toBe("error");
    expect(runner.calls).toHaveLength(1);
  });

  it("wait コールバックに PauseMeta が正しく渡される", async () => {
    const runner = new FakeCommandRunner();
    let callCount = 0;
    runner.on([CODEX_CMD], () => {
      callCount++;
      if (callCount === 1) {
        return { code: 1, stdout: "", stderr: "rate limit exceeded" };
      }
      return { code: 0, stdout: "ok\n", stderr: "" };
    });
    const logs: string[] = [];
    const capturedMeta: PauseMeta[] = [];
    const capturedWaitMs: number[] = [];
    const BASE_MS = new Date("2026-06-21T10:00:00Z").getTime();
    const rlOpts = makeRateLimitOpts({
      reprobeMinutes: 15,
      capHours: 6,
      clock: () => BASE_MS,
      wait: async (meta, waitMs) => {
        capturedMeta.push(meta);
        capturedWaitMs.push(waitMs);
        return "complete";
      },
    });
    await makePlannerWithRateLimit(runner, logs, rlOpts).run({
      worktreePath: "/wt",
      prompt: "plan task",
    });

    expect(capturedMeta).toHaveLength(1);
    const meta = capturedMeta[0]!;
    expect(meta.reason).toBe("rate_limit");
    expect(meta.target).toBe("codex");
    expect(meta.pausedAt).toBe(new Date(BASE_MS).toISOString());
    expect(capturedWaitMs[0]).toBe(15 * 60_000);
  });
});
