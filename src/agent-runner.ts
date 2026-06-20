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
const RATE_LIMIT_MIN_WAIT_MS = 30_000;
const RATE_LIMIT_BUFFER_MS = 60_000;

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

/** process.env から機密キーを除いた env を作る（undefined 値も除去して型を満たす）。
 * effortEnvOverride が指定されたとき、親プロセスの CLAUDE_CODE_EFFORT_LEVEL を除いて
 * effortEnvOverride の値を設定する。Claude Code は settings.json の env セクション経由でも
 * CLAUDE_CODE_EFFORT_LEVEL を注入し得るが、子プロセス起動時点で明示的に設定することで
 * settings 由来の値より env が優先され TOML の agent.effort が無視されるのを防ぐ。
 * "auto" を渡すと Claude がモデルデフォルトにリセットする（configured level を上書き）。
 * undefined のときは CLAUDE_CODE_EFFORT_LEVEL を除去せず親プロセス env をそのまま引き継ぐ。*/
function agentChildEnv(effortEnvOverride: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_KEYS.includes(key)) continue;
    if (effortEnvOverride !== undefined && key === "CLAUDE_CODE_EFFORT_LEVEL") continue;
    out[key] = value;
  }
  if (effortEnvOverride !== undefined) {
    out["CLAUDE_CODE_EFFORT_LEVEL"] = effortEnvOverride;
  }
  return out;
}

export interface RateLimitOpts {
  reprobeMinutes: number;
  capHours: number;
  claudePatterns: string[];
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

interface AgentRunnerOptions {
  model: string;
  /** undefined → omit --effort flag */
  effort: string | undefined;
  /** Value to inject as CLAUDE_CODE_EFFORT_LEVEL in the child env, overriding both the parent env
   *  and any value Claude Code's settings.json would inject via its env section.
   *  Pass "auto" to reset to the model default, overriding any configured effort level.
   *  Omit (undefined) to leave CLAUDE_CODE_EFFORT_LEVEL unmodified (inherit from parent env). */
  effortEnvOverride?: string;
  /** Claude Code の --permission-mode に渡す権限モード。
   *  隔離コンテナでは "bypassPermissions" を選択する。既定は "acceptEdits"。 */
  permissionMode: string;
  allowedTools: string;
  extraArgs: string[];
  log: (line: string) => void;
  rateLimit?: RateLimitOpts;
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

const DEFAULT_CLAUDE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /overloaded/i,
];

const RESETS_PATTERN = /resets?\s+(\d{2}):(\d{2})/i;

export interface RateLimitClassification {
  isRateLimit: boolean;
  resetsAtMs: number | null;
}

export function parseResetsTime(stderr: string, nowMs: number): number | null {
  const match = RESETS_PATTERN.exec(stderr);
  if (!match) return null;
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  if (hours > 23 || minutes > 59) return null;
  const target = new Date(nowMs);
  target.setUTCHours(hours, minutes, 0, 0);
  if (target.getTime() <= nowMs) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime();
}

export function classifyClaudeError(
  message: string,
  stderr: string,
  configPatterns: string[],
  nowMs: number,
): RateLimitClassification {
  const patterns =
    configPatterns.length > 0
      ? configPatterns.map((p) => new RegExp(p, "i"))
      : DEFAULT_CLAUDE_RATE_LIMIT_PATTERNS;
  const combined = `${message}\n${stderr}`;
  const isRateLimit = patterns.some((p) => p.test(combined));
  if (!isRateLimit) return { isRateLimit: false, resetsAtMs: null };
  return { isRateLimit: true, resetsAtMs: parseResetsTime(stderr, nowMs) };
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

  private async runOnce(
    ctx: SessionContext,
  ): Promise<{ outcome: AgentOutcome; stderr: string }> {
    // カーネル §5.1: argv は一字一句この順。max-budget-usd は toFixed(2)。
    // effort が undefined（config で "auto" 指定 or 非対応モデル向け）のとき --effort を省く。
    const args: string[] = [
      "-p",
      ctx.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      ctx.maxCostUsd.toFixed(2),
      "--permission-mode",
      this.opts.permissionMode,
      "--allowedTools",
      this.opts.allowedTools,
      "--model",
      this.opts.model,
      ...(this.opts.effort !== undefined ? ["--effort", this.opts.effort] : []),
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
      env: agentChildEnv(this.opts.effortEnvOverride),
      onStdoutLine,
      ...(ctx.hardTimeoutMs !== undefined ? { timeoutMs: ctx.hardTimeoutMs } : {}),
    };
    const cmdResult = await this.runner.run("claude", args, opts);
    const outcome = this.toOutcome(resultLine, cmdResult.code, cmdResult.stderr);
    return { outcome, stderr: cmdResult.stderr };
  }

  async runSession(ctx: SessionContext): Promise<AgentOutcome> {
    if (!this.opts.rateLimit) {
      const { outcome } = await this.runOnce(ctx);
      return outcome;
    }

    const rl = this.opts.rateLimit;
    const capMs = rl.capHours * 3_600_000;
    const reprobeMs = rl.reprobeMinutes * 60_000;
    const startMs = rl.clock();
    let totalCost = 0;

    while (true) {
      const remainingBudget = ctx.maxCostUsd - totalCost;
      if (remainingBudget <= 0) {
        return { kind: "cost_exceeded", costUsd: totalCost };
      }
      const { outcome, stderr } = await this.runOnce(
        { ...ctx, maxCostUsd: remainingBudget },
      );
      totalCost += outcome.costUsd;

      if (outcome.kind !== "error") {
        return { ...outcome, costUsd: totalCost };
      }

      const nowMs = rl.clock();
      const classification = classifyClaudeError(
        outcome.message,
        stderr,
        rl.claudePatterns,
        nowMs,
      );
      if (!classification.isRateLimit) {
        return { ...outcome, costUsd: totalCost };
      }

      const elapsed = nowMs - startMs;
      if (elapsed >= capMs) {
        this.opts.log(`rate limit cap exceeded (${rl.capHours}h); halting`);
        return {
          kind: "error",
          costUsd: totalCost,
          message: `rate limit cap exceeded (${rl.capHours}h): ${outcome.message}`,
        };
      }

      let waitMs: number;
      if (classification.resetsAtMs !== null) {
        waitMs = Math.max(0, classification.resetsAtMs - nowMs + RATE_LIMIT_BUFFER_MS);
      } else {
        waitMs = reprobeMs;
      }

      waitMs = Math.max(waitMs, RATE_LIMIT_MIN_WAIT_MS);

      const remainingMs = capMs - elapsed;
      waitMs = Math.min(waitMs, remainingMs);

      this.opts.log(
        `rate limit detected; waiting ${Math.ceil(waitMs / 60_000)}m before re-probe`,
      );
      await rl.sleep(waitMs);
    }
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
