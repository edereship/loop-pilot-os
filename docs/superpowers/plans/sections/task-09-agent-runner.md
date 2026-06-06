### Task 9: Agent Runner（claude headless）

**目的**: worktree 内で `claude -p`（headless / stream-json）をコスト上限付きで起動し、NDJSON 進捗を1行ずつ解釈して、最終 `result` 行を `AgentOutcome`（completed / cost_exceeded / error）へ写像する `ClaudeAgentRunner` を実装する。これは per-task ライフサイクルの IMPLEMENT フェーズ（仕様§5.3）の実体であり、コスト一本化（仕様§11）に従い timeout は持たない。

**依存タスク**:
- Task 2（`src/types.ts`）: `AgentRunner` / `AgentOutcome` / `SessionContext` / `CommandRunner` / `RunOptions` / `CommandResult` を消費。
- Task 3（`src/exec.ts` / `tests/fakes.ts`）: 本タスクのテストは `tests/fakes.ts` の `FakeCommandRunner`（`on` / `calls` を持つ）を消費する。

**カバーする仕様**: §5（IMPLEMENT）/ §11（安全弁・コスト一本化）/ カーネル §5.1（claude headless 契約）。

---

## 設計メモ（実装前の確定事項・カーネル §5.1 準拠）

- クラス: `ClaudeAgentRunner implements AgentRunner`（`src/types.ts` の `AgentRunner` を実装）。
- コンストラクタ: `constructor(runner: CommandRunner, opts: { model: string; allowedTools: string; extraArgs: string[]; log: (line: string) => void })`。
- メソッド: `runSession(ctx: SessionContext): Promise<AgentOutcome>`。
- argv（カーネル §5.1 と一字一句一致）。コマンドは `"claude"`、引数配列は順に:
  ```
  -p <ctx.prompt>
  --output-format stream-json
  --max-budget-usd <ctx.maxCostUsd.toFixed(2)>
  --permission-mode acceptEdits
  --allowedTools <opts.allowedTools>
  --model <opts.model>
  ...opts.extraArgs
  ```
- `runner.run("claude", argv, { cwd: ctx.worktreePath, onStdoutLine })` を呼ぶ。`timeoutMs` は**設定しない**（仕様§11: コスト上限へ一本化）。
- `onStdoutLine` は NDJSON を1行ずつ受け取り `JSON.parse`。**parse 失敗（壊れた行）は無視**して継続（throw しない）。
  - `type==="system"` ∧ `subtype==="init"` → 開始ログ（`opts.log`）。他の `system` subtype（`hook_started` 等）は無視。
  - `type==="assistant"` → 進捗ログ。`message.content` 配列から最初の `type==="text"` 要素の `text` を取り、先頭 80 字を `opts.log`（text が無ければログしない）。
  - `type==="result"` → その行オブジェクトを `resultLine` として保持（最後に到達したもの）。
- プロセス終了後（`runner.run` の解決後）に `resultLine` と `code` から `AgentOutcome` を確定（カーネル §5.1 写像）:
  - `resultLine.subtype==="success"` → `{ kind: "completed", costUsd, summary }`。`summary` = `result` を 2000 字に切詰め。
  - `resultLine.subtype==="error_max_budget"` → `{ kind: "cost_exceeded", costUsd }`。
  - それ以外の subtype / `is_error===true` / `code !== 0` / `resultLine` 欠落 → `{ kind: "error", costUsd, message }`。
- `costUsd` は `resultLine.total_cost_usd`（数値）を採用。`resultLine` 欠落時は `0`。
- `error` の `message`: result 行欠落時は `"no result line emitted"`、非0終了時は `"claude exited with code <n>"`、is_error 時は `result` 文字列（無ければ `"agent error"`）。

> 検証メモ（計画作成時、claude 2.1.165 実測）: stream-json は NDJSON で `{"type":"system","subtype":"init",...}` / `{"type":"assistant","message":{"content":[{"type":"thinking",...},{"type":"text","text":"..."}]}}` / 末尾 `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":<number>,"result":"...","session_id":"..."}` を出力する。`system` には `init` 以外の subtype（`hook_started`/`thinking_tokens` 等）も混ざるため `subtype==="init"` で選別する。assistant content には `thinking` ブロックが先行し得るため `type==="text"` を探索する。

> 修正 2026-06-06: 実CLIプローブにより --verbose 必須・subtype "error_max_budget_usd"・予算超過時 exit 1 を確認し、契約を実挙動へ修正（ユーザー承認済み）。

---

### Files:

- **Create**: `/home/racoma-dev/loop-pilot-os/src/agent-runner.ts`
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/agent-runner.test.ts`

---

- [ ] **Step 1: 失敗するテストを書く（正常系・argv 検証・cost_exceeded・error 各系・破損行・result 欠落）**

  `/home/racoma-dev/loop-pilot-os/tests/agent-runner.test.ts` を新規作成し、以下を全文で書く。`FakeCommandRunner`（`tests/fakes.ts`、Task 3 で定義）を使い、`on("claude", ...)` で登録したハンドラ内で `opts.onStdoutLine` に fixture の NDJSON 行を1行ずつ流し、`{ code }` を返す。

  ```typescript
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
    '{"type":"result","subtype":"error_max_budget","is_error":true,"total_cost_usd":10,"result":"budget exhausted","session_id":"s1"}';
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
        "--max-budget-usd",
        "10.00",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Edit,Write,Read,Glob,Grep,Bash",
        "--model",
        "opus",
      ]);
      expect(call.opts.cwd).toBe("/wt");
      // 仕様§11: コスト一本化のため timeoutMs は設定しない
      expect(call.opts.timeoutMs).toBeUndefined();
    });

    it("カーネル§5.1: max-budget-usd は ctx.maxCostUsd を toFixed(2) で渡す", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const logs: string[] = [];
      await makeRunner(runner, logs).runSession({ ...ctx, maxCostUsd: 7.5 });

      const args = runner.calls[0]!.args;
      const i = args.indexOf("--max-budget-usd");
      expect(args[i + 1]).toBe("7.50");
    });

    it("extra_args をモデル指定の後ろへ連結する", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_SUCCESS_LINE]);
      const agent = new ClaudeAgentRunner(runner, {
        model: "opus",
        allowedTools: "Edit",
        extraArgs: ["--add-dir", "/extra"],
        log: () => {},
      });
      await agent.runSession(ctx);
      const args = runner.calls[0]!.args;
      expect(args.slice(-4)).toEqual(["--model", "opus", "--add-dir", "/extra"]);
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

    it("subtype=error_max_budget → cost_exceeded{costUsd}", async () => {
      const { runner } = runnerEmitting([INIT_LINE, RESULT_BUDGET_LINE]);
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
  ```

- [ ] **Step 2: テストを実行し、失敗を確認する（red）**

  実行コマンド:
  ```
  npx vitest run tests/agent-runner.test.ts
  ```
  期待される失敗: `src/agent-runner.js` が存在しないため、`ClaudeAgentRunner` の import 解決に失敗する（`Failed to resolve import "../src/agent-runner.js"` / `Cannot find module` 系のエラーで全 `it` が fail）。

- [ ] **Step 3: `src/agent-runner.ts` を実装する（最小・完全形）**

  `/home/racoma-dev/loop-pilot-os/src/agent-runner.ts` を新規作成し、以下を全文で書く。

  ```typescript
  import type {
    AgentOutcome,
    AgentRunner,
    CommandRunner,
    RunOptions,
    SessionContext,
  } from "./types.js";

  const SUMMARY_MAX = 2000;
  const PROGRESS_TEXT_MAX = 80;

  interface AgentRunnerOptions {
    model: string;
    allowedTools: string;
    extraArgs: string[];
    log: (line: string) => void;
  }

  // claude stream-json の result 行（カーネル §5.1）。未知フィールドは無視する。
  interface ResultLine {
    type: "result";
    subtype: string;
    is_error?: boolean;
    total_cost_usd?: number;
    result?: string;
    session_id?: string;
  }

  function isResultLine(value: unknown): value is ResultLine {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "result" &&
      typeof (value as { subtype?: unknown }).subtype === "string"
    );
  }

  // assistant メッセージ content から最初の text ブロックを取り出す。
  function firstTextBlock(parsed: unknown): string | null {
    const content = (parsed as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
    return null;
  }

  /**
   * Claude Code ヘッドレス（`claude -p --output-format stream-json`）を worktree 内で
   * コスト上限付きに起動する AgentRunner。仕様§5.3 IMPLEMENT / §11 コスト一本化。
   */
  export class ClaudeAgentRunner implements AgentRunner {
    constructor(
      private readonly runner: CommandRunner,
      private readonly opts: AgentRunnerOptions,
    ) {}

    async runSession(ctx: SessionContext): Promise<AgentOutcome> {
      // カーネル §5.1: argv は一字一句この順。max-budget-usd は toFixed(2)。
      const args: string[] = [
        "-p",
        ctx.prompt,
        "--output-format",
        "stream-json",
        "--max-budget-usd",
        ctx.maxCostUsd.toFixed(2),
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        this.opts.allowedTools,
        "--model",
        this.opts.model,
        ...this.opts.extraArgs,
      ];

      let resultLine: ResultLine | null = null;

      const onStdoutLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // 壊れた行は無視（仕様§5.3: 自己申告でなく差分が真実、進捗ログは best-effort）
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const type = (parsed as { type?: unknown }).type;

        if (type === "system") {
          if ((parsed as { subtype?: unknown }).subtype === "init") {
            const sessionId = (parsed as { session_id?: unknown }).session_id;
            this.opts.log(
              `agent session started${typeof sessionId === "string" ? ` (session ${sessionId})` : ""}`,
            );
          }
          return;
        }

        if (type === "assistant") {
          const text = firstTextBlock(parsed);
          if (text !== null) {
            this.opts.log(`agent: ${text.slice(0, PROGRESS_TEXT_MAX)}`);
          }
          return;
        }

        if (isResultLine(parsed)) {
          resultLine = parsed;
        }
      };

      // 仕様§11: timeoutMs は設定しない（コスト上限へ一本化）。
      const opts: RunOptions = { cwd: ctx.worktreePath, onStdoutLine };
      const cmdResult = await this.runner.run("claude", args, opts);

      return this.toOutcome(resultLine, cmdResult.code);
    }

    private toOutcome(resultLine: ResultLine | null, code: number): AgentOutcome {
      const costUsd =
        resultLine && typeof resultLine.total_cost_usd === "number"
          ? resultLine.total_cost_usd
          : 0;

      if (resultLine === null) {
        return { kind: "error", costUsd, message: "no result line emitted" };
      }
      if (code !== 0) {
        return { kind: "error", costUsd, message: `claude exited with code ${code}` };
      }
      if (resultLine.subtype === "error_max_budget") {
        return { kind: "cost_exceeded", costUsd };
      }
      if (resultLine.subtype === "success" && resultLine.is_error !== true) {
        const summary = (resultLine.result ?? "").slice(0, SUMMARY_MAX);
        return { kind: "completed", costUsd, summary };
      }
      return {
        kind: "error",
        costUsd,
        message: resultLine.result ?? "agent error",
      };
    }
  }
  ```

- [ ] **Step 4: テストを実行し、成功を確認する（green）**

  実行コマンド:
  ```
  npx vitest run tests/agent-runner.test.ts
  ```
  期待される成功: 全 `it`（argv 検証 / toFixed / extra_args / completed / 2000字切詰め / cost_exceeded / その他 subtype error / is_error success subtype error / 非0終了 error / result 欠落 error / 破損行無視 / ログ）が pass（緑）。

- [ ] **Step 5: 型チェック含む `npm run check` を実行する**

  実行コマンド:
  ```
  npm run check
  ```
  期待される成功: `tsc -p tsconfig.json --noEmit` と `tsc -p tsconfig.test.json --noEmit` が型エラーなしで通過し、`vitest run` 全体が緑。`AgentOutcome` の union（completed/cost_exceeded/error）と本実装の戻り値が一致していること（過不足プロパティで tsc が落ちないこと）を確認する。

- [ ] **Step 6: コミットする（red→green を1コミットに）**

  実行コマンド:
  ```
  git add src/agent-runner.ts tests/agent-runner.test.ts && git commit -m "feat: ClaudeAgentRunner (claude headless stream-json) per kernel §5.1"
  ```
