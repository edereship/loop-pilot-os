import { describe, it, expect } from "vitest";
import { ClaudeAgentRunner, classifyClaudeError, parseResetsTime } from "../src/agent-runner.js";
import { FakeCommandRunner, instantSleep } from "./fakes.js";
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

function makeRunner(runner: FakeCommandRunner, logs: string[], overrides?: Partial<{ permissionMode: string }>): ClaudeAgentRunner {
  return new ClaudeAgentRunner(runner, {
    model: "opus",
    effort: "max",
    effortEnvOverride: "max",
    permissionMode: overrides?.permissionMode ?? "acceptEdits",
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
      permissionMode: "acceptEdits",
      allowedTools: "Edit",
      extraArgs: [],
      log: () => {},
    });
    await agent.runSession(ctx);
    expect(runner.calls[0]!.args).not.toContain("--effort");
  });

  it("effortEnvOverride 指定時、子プロセス env の CLAUDE_CODE_EFFORT_LEVEL をその値で上書きする（親 env / Claude settings.json 由来の値を無視させる）", async () => {
    const prev = process.env["CLAUDE_CODE_EFFORT_LEVEL"];
    process.env["CLAUDE_CODE_EFFORT_LEVEL"] = "low";
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession(ctx); // effort="max", effortEnvOverride="max"
      expect(runner.calls[0]!.opts.env!["CLAUDE_CODE_EFFORT_LEVEL"]).toBe("max");
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
        permissionMode: "acceptEdits",
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

  it("effortEnvOverride='auto' のとき --effort フラグを出さず CLAUDE_CODE_EFFORT_LEVEL を 'auto' に設定する（agent.effort='auto' ケース）", async () => {
    const prev = process.env["CLAUDE_CODE_EFFORT_LEVEL"];
    process.env["CLAUDE_CODE_EFFORT_LEVEL"] = "low";
    try {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const agent = new ClaudeAgentRunner(runner, {
        model: "opus",
        effort: undefined,
        effortEnvOverride: "auto",
        permissionMode: "acceptEdits",
        allowedTools: "Edit",
        extraArgs: [],
        log: () => {},
      });
      await agent.runSession(ctx);
      expect(runner.calls[0]!.args).not.toContain("--effort");
      expect(runner.calls[0]!.opts.env!["CLAUDE_CODE_EFFORT_LEVEL"]).toBe("auto");
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_CODE_EFFORT_LEVEL"];
      else process.env["CLAUDE_CODE_EFFORT_LEVEL"] = prev;
    }
  });

  it("ES-385: permissionMode を --permission-mode 引数に反映する（bypassPermissions）", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const logs: string[] = [];
    await makeRunner(runner, logs, { permissionMode: "bypassPermissions" }).runSession(ctx);
    const args = runner.calls[0]!.args;
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("bypassPermissions");
  });

  it("extra_args をモデル指定の後ろへ連結する", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
    const agent = new ClaudeAgentRunner(runner, {
      model: "opus",
      effort: "max",
      permissionMode: "acceptEdits",
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
      fullResult: "Added function foo and a test.",
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

  it("completed includes fullResult with untruncated text", async () => {
    const big = "x".repeat(2500);
    const resultBig = `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":2,"result":"${big}","session_id":"s1"}`;
    const { runner } = runnerEmitting([INIT_LINE, resultBig]);
    const logs: string[] = [];
    const outcome = await makeRunner(runner, logs).runSession(ctx);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.fullResult).toBe(big);
      expect(outcome.fullResult).toHaveLength(2500);
      expect(outcome.summary).toHaveLength(2000);
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
      fullResult: "Added function foo and a test.",
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

describe("classifyClaudeError", () => {
  const NOW = Date.parse("2026-06-20T10:00:00.000Z");

  it("detects 429 in error message as rate limit", () => {
    const result = classifyClaudeError(
      "claude exited with code 1: 429 Too Many Requests",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'rate limit' (case-insensitive) as rate limit", () => {
    const result = classifyClaudeError(
      "Rate Limit exceeded",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'usage limit' in stderr as rate limit", () => {
    const result = classifyClaudeError(
      "claude exited with code 1",
      "Error: usage limit reached for this billing period",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'too many requests' as rate limit", () => {
    const result = classifyClaudeError(
      "too many requests, please slow down",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'overloaded' as rate limit", () => {
    const result = classifyClaudeError(
      "API is overloaded",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("does NOT classify non-rate-limit errors", () => {
    const result = classifyClaudeError(
      "claude exited with code 1: Error: credentials expired; run /login",
      "fatal: authentication failed",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(false);
  });

  it("detects 'hit your session limit' as rate limit (Finding 1 — documented Claude quota string)", () => {
    const result = classifyClaudeError(
      "You've hit your session limit",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'hit your weekly limit' in stderr as rate limit (Finding 1 — documented Claude quota string)", () => {
    const result = classifyClaudeError(
      "claude exited with code 1",
      "You've hit your weekly limit. Resets Mon 12:00am",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("detects 'temporarily limiting requests' as rate limit (Finding 1 — documented Claude quota string)", () => {
    const result = classifyClaudeError(
      "Server is temporarily limiting requests",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("does NOT match partial '429' inside longer numbers", () => {
    const result = classifyClaudeError(
      "processed 14290 tokens",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(false);
  });

  it("detects parenthesized '(429)' in stderr as rate limit (Finding 1 — Claude CLI 'Request rejected (429)' form)", () => {
    const result = classifyClaudeError(
      "claude exited with code 1",
      "Request rejected (429)",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("does NOT match '429' in ticket-like identifiers (e.g. TY-429) without HTTP context", () => {
    const result = classifyClaudeError(
      "claude exited with code 1: TY-429 is stuck in review",
      "",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(false);
  });

  it("uses config patterns instead of defaults when provided", () => {
    const result = classifyClaudeError(
      "CUSTOM_QUOTA_HIT",
      "",
      ["CUSTOM_QUOTA"],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("config patterns replace defaults (default '429' no longer matches)", () => {
    const result = classifyClaudeError(
      "429 Too Many Requests",
      "",
      ["CUSTOM_ONLY"],
      NOW,
    );
    expect(result.isRateLimit).toBe(false);
  });

  it("parses 'resets HH:MM' from stderr and returns resetsAtMs", () => {
    const result = classifyClaudeError(
      "429 rate limit",
      "Your limit resets 14:30",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
    expect(result.resetsAtMs).toBe(Date.parse("2026-06-20T14:30:00.000Z"));
  });

  it("returns resetsAtMs=null when no resets time is found", () => {
    const result = classifyClaudeError(
      "429 rate limit",
      "some other error details",
      [],
      NOW,
    );
    expect(result.isRateLimit).toBe(true);
    expect(result.resetsAtMs).toBeNull();
  });
});

describe("parseResetsTime", () => {
  const NOW = Date.parse("2026-06-20T10:00:00.000Z");

  it("parses 'resets HH:MM' and returns epoch ms for same-day future time", () => {
    const result = parseResetsTime("Your limit resets 14:30", NOW);
    expect(result).toBe(Date.parse("2026-06-20T14:30:00.000Z"));
  });

  it("wraps to next day when parsed time is in the past", () => {
    const result = parseResetsTime("resets 08:00", NOW);
    expect(result).toBe(Date.parse("2026-06-21T08:00:00.000Z"));
  });

  it("returns null when no resets pattern is found", () => {
    const result = parseResetsTime("no reset info here", NOW);
    expect(result).toBeNull();
  });

  it("returns null for invalid hours (>23)", () => {
    const result = parseResetsTime("resets 25:00", NOW);
    expect(result).toBeNull();
  });

  it("returns null for invalid minutes (>59)", () => {
    const result = parseResetsTime("resets 14:61", NOW);
    expect(result).toBeNull();
  });

  it("handles 'reset' (singular) variant", () => {
    const result = parseResetsTime("limit reset 14:30 UTC", NOW);
    expect(result).toBe(Date.parse("2026-06-20T14:30:00.000Z"));
  });

  it("treats near-past time (within same minute) as current, not tomorrow", () => {
    const nowSameMinute = Date.parse("2026-06-20T14:30:05.000Z");
    const result = parseResetsTime("resets 14:30", nowSameMinute);
    expect(result).toBe(Date.parse("2026-06-20T14:30:00.000Z"));
  });

  it("still wraps to next day when parsed time is more than 60s in the past", () => {
    const nowLater = Date.parse("2026-06-20T14:32:00.000Z");
    const result = parseResetsTime("resets 14:30", nowLater);
    expect(result).toBe(Date.parse("2026-06-21T14:30:00.000Z"));
  });

  // Finding 3 (Codex): real CLI emits "reset at 7am (Asia/Singapore)" / "5pm (Europe/Kyiv)"
  // Asia/Singapore is always UTC+8 (no DST), making assertions deterministic.
  it("parses 'reset at Xam (Timezone)' form — future same-day in that TZ (Finding 3)", () => {
    // NOW = 2026-06-20T10:00:00Z = 18:00 SGT (6pm). Next 7am SGT = 2026-06-20T23:00:00Z.
    const result = parseResetsTime("Your limit will reset at 7am (Asia/Singapore)", NOW);
    expect(result).toBe(Date.parse("2026-06-20T23:00:00.000Z"));
  });

  it("parses 'reset at Xpm (Timezone)' form — future same-day in that TZ (Finding 3)", () => {
    // NOW = 2026-06-20T10:00:00Z = 18:00 SGT. 7pm SGT = 19:00 SGT = 11:00 UTC same day.
    const result = parseResetsTime("Your limit will reset at 7pm (Asia/Singapore)", NOW);
    expect(result).toBe(Date.parse("2026-06-20T11:00:00.000Z"));
  });

  it("falls back to am/pm parser when HH:MM pattern is absent (Finding 3)", () => {
    // Confirm that "reset at" without colon-time goes to the am/pm branch, not null.
    const result = parseResetsTime("reset at 12pm (Asia/Singapore)", NOW);
    // 12pm SGT = noon SGT = 04:00 UTC (still future from 10:00 UTC? no — 04:00 is past)
    // noon SGT on 2026-06-20 = 2026-06-20T04:00Z — that's in the past vs NOW(10:00Z)
    // so wrap to next day: 2026-06-21T04:00Z
    expect(result).toBe(Date.parse("2026-06-21T04:00:00.000Z"));
  });

  it("returns null for unknown timezone in am/pm pattern (Finding 3)", () => {
    const result = parseResetsTime("reset at 7am (Invalid/Zone)", NOW);
    expect(result).toBeNull();
  });

  it("parses 'resets H:MMpm (Timezone)' with minutes and no 'at' (Finding 2)", () => {
    // NOW = 2026-06-20T10:00:00Z = 18:00 SGT (+8). 6:40pm SGT = 10:40 UTC same day.
    const result = parseResetsTime("resets 6:40pm (Asia/Singapore)", NOW);
    expect(result).toBe(Date.parse("2026-06-20T10:40:00.000Z"));
  });

  it("parses 'resets H:MMam (Timezone)' with minutes that wraps to next day (Finding 2)", () => {
    // NOW = 2026-06-20T10:00:00Z = 18:00 SGT (+8). 6:40am SGT = 22:40 UTC previous day
    // → wraps to 2026-06-20T22:40:00Z (next occurrence, i.e. tonight SGT).
    const result = parseResetsTime("resets 6:40am (Asia/Singapore)", NOW);
    expect(result).toBe(Date.parse("2026-06-20T22:40:00.000Z"));
  });

  it("zero-padded 12-hour time with am/pm+tz is parsed as local, not bare UTC (Finding 1)", () => {
    // "resets 06:40pm (Asia/Singapore)" must be parsed as 6:40pm SGT, not 06:40 UTC.
    // 6:40pm SGT = 18:40 SGT = 10:40 UTC.
    // NOW = 2026-06-20T10:00:00Z = 18:00 SGT.
    const result = parseResetsTime("resets 06:40pm (Asia/Singapore)", NOW);
    expect(result).toBe(Date.parse("2026-06-20T10:40:00.000Z"));
  });

  it("parses 'resets 3:45pm' without timezone as UTC future time (Finding 2 — documented no-timezone form)", () => {
    // NOW = 2026-06-20T10:00:00Z. 3:45pm UTC = 15:45 UTC (future on same day).
    const result = parseResetsTime("resets 3:45pm", NOW);
    expect(result).toBe(Date.parse("2026-06-20T15:45:00.000Z"));
  });

  it("parses 'resets 12:00am' without timezone and wraps to next day when past (Finding 2)", () => {
    // NOW = 2026-06-20T10:00:00Z. midnight UTC = 00:00 UTC = past → next day.
    const result = parseResetsTime("resets 12:00am", NOW);
    expect(result).toBe(Date.parse("2026-06-21T00:00:00.000Z"));
  });

  it("parses 'resets Mon 12:00am' weekday form as next Monday midnight UTC (Finding 2 — documented weekly-limit form)", () => {
    // NOW = 2026-06-20T10:00:00Z = Saturday. Next Monday = June 22 at 00:00 UTC.
    const result = parseResetsTime("resets Mon 12:00am", NOW);
    expect(result).toBe(Date.parse("2026-06-22T00:00:00.000Z"));
  });

  it("parses 'resets Mon 3:45pm' weekday form with non-midnight time (Finding 2)", () => {
    // NOW = 2026-06-20T10:00:00Z = Saturday. Next Monday June 22 at 15:45 UTC.
    const result = parseResetsTime("resets Mon 3:45pm", NOW);
    expect(result).toBe(Date.parse("2026-06-22T15:45:00.000Z"));
  });

  it("weekday form wraps to next week when same weekday's time has already passed (Finding 2)", () => {
    // NOW = 2026-06-20T10:00:00Z = Saturday. resets Sat 09:00am = today at 09:00 UTC — past.
    // → wrap to next Saturday June 27 at 09:00 UTC.
    const result = parseResetsTime("resets Sat 9:00am", NOW);
    expect(result).toBe(Date.parse("2026-06-27T09:00:00.000Z"));
  });
});

// --- Rate limit retry loop tests ---

const RESULT_429_LINE =
  '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"result":"429 Too Many Requests","session_id":"s1"}';

function makeRunnerWithRateLimit(
  runner: FakeCommandRunner,
  logs: string[],
  overrides?: {
    reprobeMinutes?: number;
    capHours?: number;
    claudePatterns?: string[];
    clockMs?: number[];
  },
): { agent: ClaudeAgentRunner; sleep: ReturnType<typeof instantSleep>; } {
  const sleep = instantSleep();
  let clockIndex = 0;
  const clockValues = overrides?.clockMs ?? [0];
  const clock = (): number => {
    const v = clockValues[Math.min(clockIndex, clockValues.length - 1)]!;
    clockIndex++;
    return v;
  };
  const agent = new ClaudeAgentRunner(runner, {
    model: "opus",
    effort: "max",
    effortEnvOverride: "max",
    permissionMode: "acceptEdits",
    allowedTools: "Edit,Write,Read,Glob,Grep,Bash",
    extraArgs: [],
    log: (line: string) => logs.push(line),
    rateLimit: {
      reprobeMinutes: overrides?.reprobeMinutes ?? 15,
      capHours: overrides?.capHours ?? 6,
      claudePatterns: overrides?.claudePatterns ?? [],
      sleep,
      clock,
    },
  });
  return { agent, sleep };
}

describe("ClaudeAgentRunner rate limit retry loop", () => {
  it("retries on rate-limit error and succeeds on second attempt", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
    expect(sleep.calls).toHaveLength(1);
    expect(sleep.calls[0]).toBe(15 * 60_000);
  });

  it("accumulates cost across retries", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.costUsd).toBeCloseTo(0.01 + 1.2345);
    }
  });

  it("does NOT retry non-rate-limit errors", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_GENERIC_ERROR_LINE]);
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("error");
    expect(runner.calls).toHaveLength(1);
  });

  it("does NOT retry cost_exceeded", async () => {
    const { runner } = runnerEmitting([INIT_LINE, RESULT_BUDGET_LINE], 1);
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("cost_exceeded");
    expect(runner.calls).toHaveLength(1);
  });

  it("reduces --max-budget-usd on retries by accumulated cost", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    await agent.runSession(ctx);

    const firstBudget = runner.calls[0]!.args[runner.calls[0]!.args.indexOf("--max-budget-usd") + 1];
    const secondBudget = runner.calls[1]!.args[runner.calls[1]!.args.indexOf("--max-budget-usd") + 1];
    expect(firstBudget).toBe("10.00");
    expect(secondBudget).toBe("9.99");
  });

  it("returns cost_exceeded when retry budget is exhausted", async () => {
    const RESULT_EXPENSIVE_429 =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":10.00,"result":"429 Too Many Requests","session_id":"s1"}';
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_EXPENSIVE_429);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("cost_exceeded");
    expect(outcome.costUsd).toBe(10);
    expect(runner.calls).toHaveLength(1);
  });

  it("HALTs when cap is exceeded", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_429_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const capMs = 1 * 3_600_000;
    const { agent } = makeRunnerWithRateLimit(runner, logs, {
      capHours: 1,
      clockMs: [0, 0, capMs + 1],
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("rate limit cap exceeded");
    }
  });

  it("uses resets time when available in stderr (waits until reset + 1min buffer)", async () => {
    let callCount = 0;
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const RESET_TARGET = Date.parse("2026-06-20T14:30:00.000Z");
    const BUFFER = 60_000;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "Your limit resets 14:30" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs, {
      clockMs: [NOW, NOW, NOW, NOW],
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(sleep.calls[0]).toBe(RESET_TARGET - NOW + BUFFER);
  });

  it("clamps wait time to remaining cap", async () => {
    let callCount = 0;
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "Your limit resets 14:30" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const capHours = 1;
    const capMs = capHours * 3_600_000;
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs, {
      capHours,
      clockMs: [NOW, NOW, NOW, NOW],
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(sleep.calls[0]).toBe(capMs);
  });

  it("logs rate-limit detection with wait time", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    await agent.runSession(ctx);

    expect(logs.some((l) => l.includes("rate limit detected"))).toBe(true);
  });

  it("returns completed when a successful run costs exactly the remaining budget (not cost_exceeded)", async () => {
    const RESULT_SUCCESS_FULL_BUDGET =
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":10.00,"result":"Completed the task","session_id":"s1"}';
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_FULL_BUDGET);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx); // ctx.maxCostUsd = 10

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.costUsd).toBeCloseTo(10.0);
      expect(outcome.summary).toBe("Completed the task");
    }
  });

  it("does not sleep when rate-limit attempt exhausts the budget (Finding 2)", async () => {
    const RESULT_EXPENSIVE_429 =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":10.00,"result":"429 Too Many Requests","session_id":"s1"}';
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_EXPENSIVE_429);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("cost_exceeded");
    expect(outcome.costUsd).toBe(10);
    expect(runner.calls).toHaveLength(1);
    expect(sleep.calls).toHaveLength(0);
  });

  it("retries nonzero exit with rate-limit text in result (Finding 3)", async () => {
    const RESULT_429_NONZERO =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"result":"429 Too Many Requests","session_id":"s1"}';
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_429_NONZERO);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("classifyClaudeError detects rate limit from resultText (Finding 3)", () => {
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const result = classifyClaudeError(
      "claude exited with code 1",
      "",
      [],
      NOW,
      "429 Too Many Requests",
    );
    expect(result.isRateLimit).toBe(true);
  });

  it("classifyClaudeError parses resets time from resultText when not in stderr (Finding 3)", () => {
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const result = classifyClaudeError(
      "429 rate limit",
      "",
      [],
      NOW,
      "Your limit resets 14:30",
    );
    expect(result.isRateLimit).toBe(true);
    expect(result.resetsAtMs).toBe(Date.parse("2026-06-20T14:30:00.000Z"));
  });

  it("retries when result line has api_error_status:429 but empty result text (Finding 2)", async () => {
    // Real quota rejections can arrive as a result line with api_error_status:429 and no
    // result text.  The classifier must detect this even when stderr is also empty.
    const RESULT_API_ERROR_429 =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"api_error_status":429,"session_id":"s1"}';
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_API_ERROR_429);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("retry uses -p 'Continue.' --resume <sessionId> to maintain print mode (Finding 1)", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE); // session_id "s1"
        opts.onStdoutLine?.(RESULT_429_LINE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    await agent.runSession(ctx);

    expect(runner.calls).toHaveLength(2);
    // First call must use -p <prompt> (normal headless invocation)
    expect(runner.calls[0]!.args[0]).toBe("-p");
    expect(runner.calls[0]!.args[1]).toBe(ctx.prompt);
    // Second call must have -p "Continue." then --resume <sessionId> to stay in print mode.
    // A bare -p "" with --resume can hang with "No messages returned" (upstream #15918).
    const secondArgs = runner.calls[1]!.args;
    const resumeIdx = secondArgs.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(secondArgs[resumeIdx - 2]).toBe("-p");
    expect(secondArgs[resumeIdx - 1]).toBe("Continue.");
    expect(secondArgs[resumeIdx + 1]).toBe("s1");
  });

  it("does NOT retry when agent result text says 'rate limit' without HTTP 429 (Finding 2)", async () => {
    const RESULT_GITHUB_RATE_LIMIT =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"result":"GitHub API rate limit exceeded","session_id":"s1"}';
    const { runner } = runnerEmitting([INIT_LINE, RESULT_GITHUB_RATE_LIMIT], 0);
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    // Must NOT retry — this is not Claude quota, it is an agent-reported product error
    expect(outcome.kind).toBe("error");
    expect(runner.calls).toHaveLength(1);
  });

  it("classifyClaudeError with empty message does NOT classify 'rate limit' result text (Finding 2)", () => {
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    // runSession passes "" for message when exitCode=0 (agent result text goes via resultText only)
    const result = classifyClaudeError(
      "",
      "",
      [],
      NOW,
      "GitHub API rate limit exceeded",
    );
    expect(result.isRateLimit).toBe(false);
  });

  it("uses reset hint from assistant event text when not in stderr or result (Finding 2)", async () => {
    // The result line has api_error_status:429 and no resets hint; the reset
    // time appears only in an assistant text event emitted before the result.
    const RESULT_API_ERROR_429_NO_RESET =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"api_error_status":429,"session_id":"s1"}';
    const ASSISTANT_RESETS_LINE =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Claude usage limit reached. Your quota resets 6:40pm (Asia/Singapore)"}]},"session_id":"s1"}';
    // Asia/Singapore = UTC+8 (no DST). 6:40pm SGT = 10:40 UTC.
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const RESET_TARGET = Date.parse("2026-06-20T10:40:00.000Z");
    const BUFFER = 60_000;
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(ASSISTANT_RESETS_LINE);
        opts.onStdoutLine?.(RESULT_API_ERROR_429_NO_RESET);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs, {
      clockMs: [NOW, NOW, NOW, NOW],
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
    // Wait must be derived from the assistant-event reset hint, not the reprobe interval.
    expect(sleep.calls[0]).toBe(RESET_TARGET - NOW + BUFFER);
  });

  it("retries when api_error_status:429 with non-empty result text like 'Claude usage limit reached' (Finding 3)", async () => {
    // Claude can emit api_error_status:429 together with a human-readable message.
    // The rate-limit classifier must detect this even when the result text does not
    // contain a literal HTTP/429 token.
    const RESULT_API_ERROR_429_WITH_TEXT =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"api_error_status":429,"result":"Claude usage limit reached for this billing period","session_id":"s1"}';
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_API_ERROR_429_WITH_TEXT);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("retries nonzero exit where result text matches broad pattern 'overloaded' (Finding 3 — broad patterns for API-level errors)", async () => {
    const RESULT_OVERLOADED =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"result":"API is overloaded, please try again later","session_id":"s1"}';
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_OVERLOADED);
        return { code: 1, stdout: "", stderr: "" }; // nonzero exit — API-level rejection
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("does NOT retry zero-exit result text with broad patterns — only narrow 429 applies to agent output (Finding 3)", async () => {
    const RESULT_OVERLOADED_ZERO =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"result":"API is overloaded, please try again later","session_id":"s1"}';
    const { runner } = runnerEmitting([INIT_LINE, RESULT_OVERLOADED_ZERO], 0); // exit code 0
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    // Must NOT retry — zero exit means agent output, not an API-level rejection.
    expect(outcome.kind).toBe("error");
    expect(runner.calls).toHaveLength(1);
  });

  it("uses resets_at from rate_limit_event frame when present (Finding 1 — structured reset timestamp)", async () => {
    // rate_limit_event with status:"rejected" and a structured resets_at ISO timestamp
    // must be captured and used for the wait calculation, not the reprobe interval.
    const RATE_LIMIT_EVENT_LINE =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resets_at":"2026-06-20T14:30:00.000Z"}}';
    const RESULT_API_ERROR_429_NO_RESET =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"api_error_status":429,"session_id":"s1"}';
    const NOW = Date.parse("2026-06-20T10:00:00.000Z");
    const RESET_TARGET = Date.parse("2026-06-20T14:30:00.000Z");
    const BUFFER = 60_000;
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RATE_LIMIT_EVENT_LINE);
        opts.onStdoutLine?.(RESULT_API_ERROR_429_NO_RESET);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent, sleep } = makeRunnerWithRateLimit(runner, logs, {
      clockMs: [NOW, NOW, NOW, NOW],
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
    // Wait must be derived from the structured rate_limit_event resets_at, not reprobe interval.
    expect(sleep.calls[0]).toBe(RESET_TARGET - NOW + BUFFER);
  });

  it("retries when api_error_status:529 (overloaded) with empty result text (Finding 2 — structured overload)", async () => {
    const RESULT_API_ERROR_529 =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.01,"api_error_status":529,"session_id":"s1"}';
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      if (callCount === 1) {
        opts.onStdoutLine?.(INIT_LINE);
        opts.onStdoutLine?.(RESULT_API_ERROR_529);
        return { code: 1, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_SUCCESS_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const { agent } = makeRunnerWithRateLimit(runner, logs);
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("interrupts rate-limit sleep when isInterrupted fires (Finding 4)", async () => {
    let callCount = 0;
    const runner = new FakeCommandRunner();
    runner.on(["claude"], (_args: string[], opts: RunOptions): Partial<CommandResult> => {
      callCount++;
      opts.onStdoutLine?.(INIT_LINE);
      opts.onStdoutLine?.(RESULT_429_LINE);
      return { code: 0, stdout: "", stderr: "" };
    });
    const logs: string[] = [];
    const sleep = instantSleep();
    let interrupted = false;
    let clockIndex = 0;
    const clockValues = [0, 0, 0];
    const clock = (): number => {
      const v = clockValues[Math.min(clockIndex, clockValues.length - 1)]!;
      clockIndex++;
      return v;
    };
    const agent = new ClaudeAgentRunner(runner, {
      model: "opus",
      effort: "max",
      effortEnvOverride: "max",
      permissionMode: "acceptEdits",
      allowedTools: "Edit,Write,Read,Glob,Grep,Bash",
      extraArgs: [],
      log: (line: string) => logs.push(line),
      rateLimit: {
        reprobeMinutes: 15,
        capHours: 6,
        claudePatterns: [],
        sleep: (ms: number) => {
          interrupted = true;
          return sleep(ms);
        },
        clock,
        isInterrupted: () => interrupted,
      },
    });
    const outcome = await agent.runSession(ctx);

    expect(outcome.kind).toBe("interrupted");
    expect(runner.calls).toHaveLength(1);
  });
});
