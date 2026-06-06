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
