import process from "node:process";
import type {
  AgentOutcome,
  AgentRunner,
  CommandRunner,
  RunOptions,
  SessionContext,
} from "./types.js";

const SUMMARY_MAX = 2000;
const PROGRESS_TEXT_MAX = 80;
const STDERR_TAIL_MAX = 1000;

// claude 子プロセスへ渡さない機密環境変数（IPI でチケット由来プロンプトに操作された
// agent が Bash 等で読み出し外部送信・権限昇格するのを防ぐ防御の多層化）。
// - LINEAR_API_KEY / SLACK_WEBHOOK_URL: 親プロセス（task-source fetch / Slack）専用、agent に不要。
// - GH/GITHUB トークン: env 認証の gh/git 資格情報。agent に渡すと `gh pr merge` /
//   `git push origin HEAD:main` で Codex レビュー+ブランチ保護を迂回し誤マージし得る。
// 注（残存リスク）: gh が `gh auth login`（~/.config/gh/hosts.yml）で認証済みかつ agent に
//   Bash を許可している場合、env 除外だけでは ambient 認証経由の濫用は防げない。運用側で
//   agent.allowed_tools を最小化（Bash/ネットワークを絞る）こと。
const SENSITIVE_ENV_KEYS = [
  "LINEAR_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** process.env から機密キーを除いた env を作る（undefined 値も除去して型を満たす）。 */
function agentChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

interface AgentRunnerOptions {
  model: string;
  effort: string;
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
      "--verbose",
      "--max-budget-usd",
      ctx.maxCostUsd.toFixed(2),
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      this.opts.allowedTools,
      "--model",
      this.opts.model,
      "--effort",
      this.opts.effort,
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

    // 仕様§11: 基本はコスト一本化。ただし hung（無進捗・無支出）claude を切る hard backstop
    // として hardTimeoutMs があれば timeoutMs に渡す（超過時 exec が kill→reject→implement で
    // stopped(exception)+通知に写像される）。
    // env: 機密キーを除いた親環境を明示的に渡す（claude へのシークレット継承を断つ）。
    const opts: RunOptions = {
      cwd: ctx.worktreePath,
      env: agentChildEnv(),
      onStdoutLine,
      ...(ctx.hardTimeoutMs !== undefined ? { timeoutMs: ctx.hardTimeoutMs } : {}),
    };
    const cmdResult = await this.runner.run("claude", args, opts);

    return this.toOutcome(resultLine, cmdResult.code, cmdResult.stderr);
  }

  private toOutcome(
    resultLine: ResultLine | null,
    code: number,
    stderr: string,
  ): AgentOutcome {
    const costUsd =
      resultLine && typeof resultLine.total_cost_usd === "number"
        ? resultLine.total_cost_usd
        : 0;
    // 失敗時の診断のため stderr 末尾を付す（無人運用での人間トリアージを可能にする）。
    const tail = stderr.trim().slice(-STDERR_TAIL_MAX);
    const withStderr = (msg: string): string => (tail ? `${msg}: ${tail}` : msg);

    if (resultLine === null) {
      return { kind: "error", costUsd, message: withStderr("no result line emitted") };
    }
    // 予算超過判定は非0終了判定より先（実 CLI v2.1.167 は budget 超過時 exit 1 で終了する）
    if (typeof resultLine.subtype === "string" && resultLine.subtype.startsWith("error_max_budget")) {
      return { kind: "cost_exceeded", costUsd };
    }
    if (code !== 0) {
      return { kind: "error", costUsd, message: withStderr(`claude exited with code ${code}`) };
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
