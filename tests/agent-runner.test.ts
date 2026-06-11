import { describe, it, expect } from "vitest";
import { ClaudeAgentRunner } from "../src/agent-runner.js";
import { FakeCommandRunner } from "./fakes.js";
import type { RunOptions, CommandResult, SessionContext } from "../src/types.js";

// 仕様§5.3 / カーネル§5.1: claude headless の stream-json NDJSON 行（実出力スナップショット相当）
const INIT_LINE =
  '{"type":"system","subtype":"init","cwd":"/wt","session_id":"s1","model":"claude-opus","permissionMode":"acceptEdits"}';
const HOOK_LINE =
  '{"type":"system","subtype":"hook_started","hook_id":"h1","session_id":"s1"}';
const ASSISTANT_THINK_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"planning the change"}]},"session_id":"s1"}';
const ASSISTANT_TEXT_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"Editing src/foo.ts to add the requested function and a unit test for it right now"}]},"session_id":"s1"}';
const RESULT_SUCCESS_LINE =
  '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":1.2345,"result":"Added function foo and a test.","session_id":"s1"}';
const RESULT_BUDGET_LINE =
  '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.0153253,"session_id":"s1"}';
const RESULT_GENERIC_ERROR_LINE =
  '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.5,"result":"something went wrong","session_id":"s1"}';
const RESULT_IS_ERROR_SUCCESS_SUBTYPE_LINE =
  '{"type":"result","subtype":"success","is_error":true,"total_cost_usd":0.7,"result":"partial failure","session_id":"s1"}';
const BROKEN_LINE = '{"type":"assistant", THIS IS NOT JSON';
const EMPTY_LINE = "";

// 行配列を onStdoutLine へ順次流し、code を返すハンドラを登録するヘルパ
function runnerEmitting(
  lines: string[],
  code = 0,
): { runner: FakeCommandRunner; emittedCwd: () => string | undefined } {
  const runner = new FakeCommandRunner();
  let seenCwd: string | undefined;
  runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
    seenCwd = opts.cwd;
    for (const line of lines) {
      opts.onStdoutLine?.(line);
    }
    return { code, stdout: "", stderr: "" };
  });
  return { runner, emittedCwd: () => seenCwd };
}

function makeRunner(runner: FakeCommandRunner, logs: string[]): ClaudeAgentRunner {
  return new ClaudeAgentRunner(runner, {
    model: "opus",
    effort: "max",
    allowedTools: "Edit,Write,Read,Glob,Grep,Bash",
    extraArgs: [],
    log: (line: string) => logs.push(line),
  });
}

const ctx: SessionContext = {
  worktreePath: "/wt",
  prompt: "implement the feature",
  maxCostUsd: 10,
};

describe("ClaudeAgentRunner.runSession", () => {
  it("カーネル§5.1: argv を一字一句で組み立て cwd=worktreePath で claude を起動する", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const logs: string[] = [];
    await makeRunner(runner, logs).runSession(ctx);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.cmd).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "implement the feature",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      "10.00",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit,Write,Read,Glob,Grep,Bash",
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
    expect(call.opts.cwd).toBe("/wt");
    // 仕様§11: コスト一本化が基本。hardTimeoutMs 未指定なら timeoutMs は設定しない
    expect(call.opts.timeoutMs).toBeUndefined();
  });

  it("hardTimeoutMs 指定時は opts.timeoutMs に渡す（hung claude の hard backstop・仕様§11 維持の最終手段）", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const logs: string[] = [];
    await makeRunner(runner, logs).runSession({ ...ctx, hardTimeoutMs: 7_200_000 });
    expect(runner.calls[0]!.opts.timeoutMs).toBe(7_200_000);
  });

  it("claude 子プロセスに機密 env（Linear/Slack/GitHub トークン）を渡さない（IPI 漏えい・権限昇格防止）", async () => {
    const SECRETS = {
      LINEAR_API_KEY: "lin_secret_should_not_leak",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/secret",
      GH_TOKEN: "gho_should_not_leak",
      GITHUB_TOKEN: "ghs_should_not_leak",
      GH_ENTERPRISE_TOKEN: "ghe_should_not_leak",
      GITHUB_ENTERPRISE_TOKEN: "ghe2_should_not_leak",
    };
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(SECRETS)) prev[k] = process.env[k];
    Object.assign(process.env, SECRETS);
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession(ctx);

      const call = runner.calls[0]!;
      // 子プロセスへ明示 env を渡し、機密キーは一切含めない
      expect(call.opts.env).toBeDefined();
      for (const k of Object.keys(SECRETS)) {
        expect(call.opts.env![k]).toBeUndefined();
      }
      // 通常の環境（PATH 等）は引き継ぐ（空 env で claude を壊さない）
      expect(call.opts.env!.PATH).toBe(process.env.PATH);
    } finally {
      for (const k of Object.keys(SECRETS)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("claude 失敗（非0終了・result 行欠落）時に stderr を error message に含める（トリアージ可能化）", async () => {
    // result 行を出さず exit 1・stderr にエラー。診断情報を捨てない。
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      opts.onStdoutLine?.(INIT_LINE);
      return { code: 1, stdout: "", stderr: "Error: credentials expired; run /login" };
    });
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("credentials expired");
    }
  });

  it("カーネル§5.1: max-budget-usd は ctx.maxCostUsd を toFixed(2) で渡す", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const logs: string[] = [];
    await makeRunner(runner, logs).runSession({ ...ctx, maxCostUsd: 7.5 });

    const args = runner.calls[0]!.args;
    const i = args.indexOf("--max-budget-usd");
    expect(args[i + 1]).toBe("7.50");
  });

  it("effort が undefined のとき --effort フラグを args に含めない（effort 非対応モデル向け）", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const agent = new ClaudeAgentRunner(runner, {
      model: "haiku",
      effort: undefined,
      allowedTools: "Edit",
      extraArgs: [],
      log: () => {},
    });
    await agent.runSession(ctx);
    expect(runner.calls[0]!.args).not.toContain("--effort");
  });

  it("effort を明示指定した場合、子プロセス env から CLAUDE_CODE_EFFORT_LEVEL を除去する（env 変数優先による config 無視を防ぐ）", async () => {
    const prev = process.env["CLAUDE_CODE_EFFORT_LEVEL"];
    process.env["CLAUDE_CODE_EFFORT_LEVEL"] = "low";
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession(ctx); // effort="max"
      expect(runner.calls[0]!.opts.env!["CLAUDE_CODE_EFFORT_LEVEL"]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_CODE_EFFORT_LEVEL"];
      else process.env["CLAUDE_CODE_EFFORT_LEVEL"] = prev;
    }
  });

  it("effort が undefined のとき CLAUDE_CODE_EFFORT_LEVEL を子プロセス env へ引き継ぐ（env 変数による制御を尊重する）", async () => {
    const prev = process.env["CLAUDE_CODE_EFFORT_LEVEL"];
    process.env["CLAUDE_CODE_EFFORT_LEVEL"] = "low";
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const agent = new ClaudeAgentRunner(runner, {
        model: "haiku",
        effort: undefined,
        allowedTools: "Edit",
        extraArgs: [],
        log: () => {},
      });
      await agent.runSession(ctx);
      expect(runner.calls[0]!.opts.env!["CLAUDE_CODE_EFFORT_LEVEL"]).toBe("low");
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_CODE_EFFORT_LEVEL"];
      else process.env["CLAUDE_CODE_EFFORT_LEVEL"] = prev;
    }
  });

  it("effort=undefined かつ stripEffortEnv=true のとき CLAUDE_CODE_EFFORT_LEVEL を除去する（agent.effort='auto' ケース）", async () => {
    const prev = process.env["CLAUDE_CODE_EFFORT_LEVEL"];
    process.env["CLAUDE_CODE_EFFORT_LEVEL"] = "low";
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const agent = new ClaudeAgentRunner(runner, {
        model: "haiku",
        effort: undefined,
        stripEffortEnv: true,
        allowedTools: "Edit",
        extraArgs: [],
        log: () => {},
      });
      await agent.runSession(ctx);
      expect(runner.calls[0]!.args).not.toContain("--effort");
      expect(runner.calls[0]!.opts.env!["CLAUDE_CODE_EFFORT_LEVEL"]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_CODE_EFFORT_LEVEL"];
      else process.env["CLAUDE_CODE_EFFORT_LEVEL"] = prev;
    }
  });

  it("extra_args をモデル指定の後ろへ連結する", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const agent = new ClaudeAgentRunner(runner, {
      model: "opus",
      effort: "max",
      allowedTools: "Edit",
      extraArgs: ["--add-dir", "/extra"],
      log: () => {},
    });
    await agent.runSession(ctx);
    const args = runner.calls[0]!.args;
    expect(args.slice(-6)).toEqual(["--model", "opus", "--effort", "max", "--add-dir", "/extra"]);
  });

  it("subtype=success → completed{costUsd, summary=result}", async () => {
    const { runner } = runnerEmitting([INIT_LINE, ASSISTANT_TEXT_LINE, RESULT_SUCCESS_LINE]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "completed",
      costUsd: 1.2345,
      summary: "Added function foo and a test.",
    });
  });

  it("completed の summary は 2000 字に切詰める", async () => {
    const big = "x".repeat(2500);
    const resultBig = `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":2,"result":"${big}","session_id":"s1"}`;
    const { runner } = runnerEmitting([INIT_LINE, resultBig]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.summary).toHaveLength(2000);
      expect(outcome.summary).toBe("x".repeat(2000));
    }
  });

  it("subtype=error_max_budget_usd (exit 1) → cost_exceeded{costUsd}（実 CLI v2.1.167 の予算超過は exit 1）", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_BUDGET_LINE], 1);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({ kind: "cost_exceeded", costUsd: 0.0153253 });
  });

  // 後方互換: レガシーリテラル "error_max_budget"（exit 0）も cost_exceeded にマップする（startsWith 耐障害性）
  it("subtype=error_max_budget (legacy, exit 0) も cost_exceeded にマップする", async () => {
    const legacyBudgetLine =
      '{"type":"result","subtype":"error_max_budget","is_error":true,"total_cost_usd":10,"result":"budget exhausted","session_id":"s1"}';
    const { runner } = runnerEmitting([INIT_LINE, legacyBudgetLine], 0);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({ kind: "cost_exceeded", costUsd: 10 });
  });

  it("その他 subtype → error{costUsd, message}", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_GENERIC_ERROR_LINE]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "error",
      costUsd: 0.5,
      message: "something went wrong",
    });
  });

  it("subtype=success でも is_error=true なら error 扱い", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_IS_ERROR_SUCCESS_SUBTYPE_LINE]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "error",
      costUsd: 0.7,
      message: "partial failure",
    });
  });

  it("非0終了 → error（result が success でも exit code を優先）", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE], 1);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "error",
      costUsd: 1.2345,
      message: "claude exited with code 1",
    });
  });

  it("result 行欠落 → error{costUsd:0, message}", async () => {
    const { runner } = runnerEmitting([INIT_LINE, ASSISTANT_TEXT_LINE]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "error",
      costUsd: 0,
      message: "no result line emitted",
    });
  });

  it("破損行・空行は無視して最終 result まで到達する", async () => {
    const { runner } = runnerEmitting([
      EMPTY_LINE,
      BROKEN_LINE,
      INIT_LINE,
      BROKEN_LINE,
      ASSISTANT_TEXT_LINE,
      RESULT_SUCCESS_LINE,
    ]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome).toEqual({
      kind: "completed",
      costUsd: 1.2345,
      summary: "Added function foo and a test.",
    });
  });

  it("system/init で開始ログ・assistant の text 先頭80字で進捗ログを出す", async () => {
    const { runner } = runnerEmitting([
      INIT_LINE,
      HOOK_LINE, // init 以外の system は無視
      ASSISTANT_THINK_LINE, // text を持たない assistant は進捗ログを出さない
      ASSISTANT_TEXT_LINE,
      RESULT_SUCCESS_LINE,
    ]);
    const logs: string[] = [];
    await makeRunner(runner, logs).runSession(ctx);

    // 開始ログ1件 + text を持つ assistant 1件 = 2件
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("session");
    // text 先頭80字（80字に切詰め）
    const expectedText =
      "Editing src/foo.ts to add the requested function and a unit test for it right now".slice(
        0,
        80,
      );
    expect(logs[1]).toContain(expectedText);
    expect(logs[1]).not.toContain("right now"); // 81字目以降は落ちる
  });
});
