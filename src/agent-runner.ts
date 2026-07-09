import process from "node:process";
import type {
  AgentOutcome,
  AgentRunner,
  CommandRunner,
  RunOptions,
  SessionContext,
  PauseMeta,
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
// codex-planner.ts uses an allowlist instead of this denylist; the two are intentionally different
// (Codex exec can run arbitrary shell commands, so a stricter allowlist is warranted there).
const SENSITIVE_ENV_KEYS = [
  "LINEAR_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // Codex/OpenAI auth credentials: must not be exposed to the claude child process
  // because ticket-derived prompts run inside it and could exfiltrate them via Bash.
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN",
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
  isInterrupted?: () => boolean;
  // When provided, replaces the built-in sleep for rate-limit waits and handles
  // run-state tracking (paused/running) and pause/resume notifications. The
  // callback is responsible for the full wait; the caller must not also sleep.
  // Returns "interrupted" if a stop was requested, "complete" otherwise.
  wait?: (meta: PauseMeta, waitMs: number) => Promise<"interrupted" | "complete">;
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
  /** --allowedTools: tools that auto-execute without a permission prompt. */
  allowedTools: string;
  /**
   * --tools: restricts the set of tools the CLI loads at all. When set, tools not in this
   * list are unavailable regardless of settings.json or other flags (Finding 1 — ES-519).
   * Omit for non-SCOUT agents where all tools should remain available.
   */
  tools?: string;
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
  // Structured HTTP error status emitted when quota is rejected at the API layer
  // with no accompanying result text (e.g. stream-json rate_limit_event scenario).
  api_error_status?: number;
}

function isResultLine(value: unknown): value is ResultLine {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "result" &&
    typeof (value as { subtype?: unknown }).subtype === "string"
  );
}

// rate_limit_event frame emitted by the Claude Code SDK when a request is
// rejected at the API quota layer. The resets_at field carries the structured
// reset timestamp (ISO-8601 string) that is more reliable than parsing prose.
interface RateLimitEventLine {
  type: "rate_limit_event";
  rate_limit_info?: {
    status?: string;
    resets_at?: string;
  };
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
  /\bHTTP[/ ]\s*429\b|\bstatus\s*(?:code\s*)?:?\s*429\b|\(429\)/i,
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /\bhit your (session|weekly) limit\b/i,
  /temporarily limiting\b/i,
];

// Narrower pattern used only against resultText (agent output) to avoid
// misclassifying product-level rate-limit text (e.g. GitHub API limits)
// as Claude quota exhaustion. Matches HTTP 429 and HTTP 529 indicators
// injected by the api_error_status handler below.
const RESULT_TEXT_API_RATE_LIMIT_PATTERN =
  /\bHTTP[/ ]\s*(?:429|529)\b|\bstatus\s*(?:code\s*)?:?\s*(?:429|529)\b|\b429\b.*Too Many Requests|\b529\b.*Overloaded/i;

const RESETS_PATTERN = /resets?\s+(\d{2}):(\d{2})(?:\s*(utc))?/i;
// Matches timezone-qualified AM/PM resets ("resets 6:40pm (America/New_York)") and
// bare no-timezone forms ("resets 3:45pm") — documented Claude quota message shapes.
// Groups: (hour)(optional-minutes)(am|pm)(optional-timezone)
const RESETS_AT_AMPM_PATTERN =
  /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(am|pm)(?:\s*\(([^)]+)\))?/i;

// Weekday names indexed by JS Date.getUTCDay() (0=Sun … 6=Sat).
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Matches "resets Mon 12:00am" / "resets Sat 3:45pm" — documented weekly-limit form.
const RESETS_WEEKDAY_PATTERN =
  /resets?\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})(?::(\d{2}))?(am|pm)/i;

export interface RateLimitClassification {
  isRateLimit: boolean;
  resetsAtMs: number | null;
}

function parseResetsAtAmPm(text: string, nowMs: number): number | null {
  const match = RESETS_AT_AMPM_PATTERN.exec(text);
  if (!match) return null;
  // Groups: (hour)(optional-minutes)(am|pm)(optional-timezone)
  let targetHour = parseInt(match[1]!, 10);
  const targetMinutes = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const ampm = match[3]!.toLowerCase();
  const tz = match[4]; // undefined when no parenthesized timezone
  if (targetHour < 1 || targetHour > 12) return null;
  if (targetMinutes > 59) return null;
  if (ampm === "am") {
    if (targetHour === 12) targetHour = 0;
  } else {
    if (targetHour !== 12) targetHour += 12;
  }
  if (tz !== undefined) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date(nowMs));
      const hourPart = parts.find((p) => p.type === "hour");
      const minutePart = parts.find((p) => p.type === "minute");
      if (!hourPart || !minutePart) return null;
      // hour12:false can yield "24" for midnight in some environments; normalise to 0-23.
      const currentHour = parseInt(hourPart.value, 10) % 24;
      const currentMinute = parseInt(minutePart.value, 10);
      let deltaMs = (targetHour - currentHour) * 3_600_000 + (targetMinutes - currentMinute) * 60_000;
      // Only wrap to next day if the target is more than 60s in the past (same
      // semantics as the HH:MM parser: a near-past value means the reset is now).
      if (deltaMs < -60_000) deltaMs += 24 * 3_600_000;
      return nowMs + deltaMs;
    } catch {
      return null; // invalid timezone name
    }
  }
  // No timezone: treat as process-local time so "resets 7pm" is interpreted in
  // the same timezone as the host running the agent (Claude displays times in the
  // user's local TZ).  Using setUTCHours on a non-UTC host would shift the target
  // by the UTC offset and could cause the runner to wait an extra day.
  const target = new Date(nowMs);
  target.setHours(targetHour, targetMinutes, 0, 0);
  if (target.getTime() < nowMs - 60_000) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function parseResetsWeekday(text: string, nowMs: number): number | null {
  const match = RESETS_WEEKDAY_PATTERN.exec(text);
  if (!match) return null;
  const weekdayName = match[1]!.toLowerCase();
  let targetHour = parseInt(match[2]!, 10);
  const targetMinutes = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const ampm = match[4]!.toLowerCase();
  if (targetHour < 1 || targetHour > 12) return null;
  if (targetMinutes > 59) return null;
  if (ampm === "am") {
    if (targetHour === 12) targetHour = 0;
  } else {
    if (targetHour !== 12) targetHour += 12;
  }
  const targetDay = WEEKDAY_NAMES.indexOf(weekdayName);
  // Use local time to match the process-local interpretation used by the other
  // no-timezone parsers (RESETS_PATTERN and the no-tz branch of RESETS_AT_AMPM_PATTERN).
  // Claude displays weekday reset times in the user's local timezone; using UTC methods
  // on a non-UTC host shifts the target by the UTC offset.
  const currentDay = new Date(nowMs).getDay();
  const daysAhead = (targetDay - currentDay + 7) % 7;
  const target = new Date(nowMs);
  target.setDate(target.getDate() + daysAhead);
  target.setHours(targetHour, targetMinutes, 0, 0);
  // Same-weekday case: if target time has already passed (>60s ago), next week.
  if (target.getTime() < nowMs - 60_000) {
    target.setDate(target.getDate() + 7);
  }
  return target.getTime();
}

export function parseResetsTime(text: string, nowMs: number): number | null {
  // Try weekday form first — "resets Mon 12:00am" must not fall into the AM/PM
  // branch which expects a digit immediately after "resets ".
  const weekdayResult = parseResetsWeekday(text, nowMs);
  if (weekdayResult !== null) return weekdayResult;
  // Try AM/PM format next — a zero-padded 12-hour time like
  // "resets 06:40pm (Asia/Singapore)" would otherwise match the bare HH:MM
  // pattern and be misinterpreted as 06:40 UTC.
  const ampmResult = parseResetsAtAmPm(text, nowMs);
  if (ampmResult !== null) return ampmResult;

  const match = RESETS_PATTERN.exec(text);
  if (match) {
    const hours = parseInt(match[1]!, 10);
    const minutes = parseInt(match[2]!, 10);
    const isUtc = match[3] !== undefined;
    if (hours <= 23 && minutes <= 59) {
      const target = new Date(nowMs);
      if (isUtc) {
        target.setUTCHours(hours, minutes, 0, 0);
        if (target.getTime() < nowMs - 60_000) {
          target.setUTCDate(target.getUTCDate() + 1);
        }
      } else {
        target.setHours(hours, minutes, 0, 0);
        // Only wrap to next day if the parsed time is more than 60s in the past.
        // The reset time has minute precision; a near-past value (within the same
        // minute) means the reset is happening now, not tomorrow.
        if (target.getTime() < nowMs - 60_000) {
          target.setDate(target.getDate() + 1);
        }
      }
      return target.getTime();
    }
  }
  return null;
}

export function classifyClaudeError(
  message: string,
  stderr: string,
  configPatterns: string[],
  nowMs: number,
  resultText = "",
): RateLimitClassification {
  const patterns =
    configPatterns.length > 0
      ? configPatterns.map((p) => new RegExp(p, "i"))
      : DEFAULT_CLAUDE_RATE_LIMIT_PATTERNS;
  let isRateLimit: boolean;
  if (configPatterns.length > 0) {
    const combined = `${message}\n${stderr}\n${resultText}`;
    isRateLimit = patterns.some((p) => p.test(combined));
  } else {
    // Default patterns: check CLI output (message + stderr) with all patterns,
    // but only check resultText for the specific HTTP 429 pattern to avoid
    // misclassifying product-level rate-limit text as Claude quota exhaustion.
    const cliOutput = `${message}\n${stderr}`;
    isRateLimit = patterns.some((p) => p.test(cliOutput)) ||
      RESULT_TEXT_API_RATE_LIMIT_PATTERN.test(resultText);
  }
  if (!isRateLimit) return { isRateLimit: false, resetsAtMs: null };
  return {
    isRateLimit: true,
    resetsAtMs: parseResetsTime(stderr, nowMs) ?? parseResetsTime(resultText, nowMs),
  };
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
    resumeSessionId?: string,
  ): Promise<{ outcome: AgentOutcome; stderr: string; resultText: string; sessionId: string | null; exitCode: number; assistantText: string; rateLimitResetsAtMs: number | null; rateLimitEventSeen: boolean }> {
    // カーネル §5.1: argv は一字一句この順。max-budget-usd は toFixed(2)。
    // effort が undefined（config で "auto" 指定 or 非対応モデル向け）のとき --effort を省く。
    // When resuming a rate-limited session, use a non-empty -p so the CLI stays
    // in print/headless mode and has a message to act on.  A bare -p "" with
    // --resume can hang with "No messages returned" (upstream #15918).
    // Without -p at all, --output-format and --max-budget-usd are rejected or the
    // CLI enters an interactive session instead of emitting stream-json.
    const args: string[] = [
      ...(resumeSessionId ? ["-p", "Continue.", "--resume", resumeSessionId] : ["-p", ctx.prompt]),
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      ctx.maxCostUsd.toFixed(2),
      "--permission-mode",
      this.opts.permissionMode,
      "--allowedTools",
      this.opts.allowedTools,
      ...(this.opts.tools !== undefined ? ["--tools", this.opts.tools] : []),
      "--model",
      this.opts.model,
      ...(this.opts.effort !== undefined ? ["--effort", this.opts.effort] : []),
      ...this.opts.extraArgs,
    ];

    let resultLine: ResultLine | null = null;
    let capturedSessionId: string | null = null;
    const assistantTextParts: string[] = [];
    let capturedRateLimitResetsAtMs: number | null = null;
    let rateLimitEventSeen = false;

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
          if (typeof sessionId === "string") capturedSessionId = sessionId;
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
          assistantTextParts.push(text);
        }
        return;
      }

      if (type === "rate_limit_event") {
        const info = (parsed as RateLimitEventLine).rate_limit_info;
        if (info?.status === "rejected") {
          rateLimitEventSeen = true;
          if (typeof info.resets_at === "string") {
            const ts = Date.parse(info.resets_at);
            if (!isNaN(ts)) capturedRateLimitResetsAtMs = ts;
          }
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
    const rl = resultLine as ResultLine | null;
    const outcome = this.toOutcome(rl, cmdResult.code, cmdResult.stderr);
    // When the result line carries api_error_status: 429, synthesise an HTTP/429
    // token so the rate-limit classifier can detect the failure regardless of
    // whether the result text is empty or contains a human-readable message like
    // "Claude usage limit reached" that would not match RESULT_TEXT_429_PATTERN.
    let resultText = rl?.result ?? "";
    if (rl?.api_error_status === 429) {
      resultText = resultText ? `${resultText}\nHTTP/429 Too Many Requests` : "HTTP/429 Too Many Requests";
    }
    if (rl?.api_error_status === 529) {
      resultText = resultText ? `${resultText}\nHTTP/529 Overloaded` : "HTTP/529 Overloaded";
    }
    const assistantText = assistantTextParts.join("\n");
    return { outcome, stderr: cmdResult.stderr, resultText, sessionId: capturedSessionId ?? rl?.session_id ?? null, exitCode: cmdResult.code, assistantText, rateLimitResetsAtMs: capturedRateLimitResetsAtMs, rateLimitEventSeen };
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
    let lastSessionId: string | null = null;

    while (true) {
      const remainingBudget = ctx.maxCostUsd - totalCost;
      if (remainingBudget <= 0) {
        return { kind: "cost_exceeded", costUsd: totalCost };
      }
      let runResult: Awaited<ReturnType<ClaudeAgentRunner["runOnce"]>>;
      try {
        runResult = await this.runOnce(
          { ...ctx, maxCostUsd: remainingBudget },
          lastSessionId ?? undefined,
        );
      } catch (err) {
        return {
          kind: "error",
          costUsd: totalCost,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const { outcome, stderr, resultText, sessionId, exitCode, assistantText, rateLimitResetsAtMs, rateLimitEventSeen } = runResult;
      if (sessionId) lastSessionId = sessionId;
      totalCost += outcome.costUsd;

      // Non-error outcomes (completed, cost_exceeded from the agent itself) are returned
      // immediately. The budget guard only applies to error outcomes that may trigger a
      // retry — a successful run that happens to exhaust the remaining budget must not
      // be misreported as cost_exceeded.
      if (outcome.kind !== "error") {
        return { ...outcome, costUsd: totalCost };
      }

      if (ctx.maxCostUsd - totalCost <= 0) {
        return { kind: "cost_exceeded", costUsd: totalCost };
      }

      const nowMs = rl.clock();
      // When the CLI exits cleanly (exitCode=0) the error message comes from the
      // agent's own result text, not from CLI output. Passing it as the "message"
      // arg would apply the broad /rate.?limit/ pattern to strings like
      // "GitHub API rate limit exceeded", masking the real failure as Claude quota.
      // Use an empty string so only the narrow HTTP-429 pattern fires via resultText.
      // For nonzero exits (API-level rejections from the CLI), include resultText in
      // the combined message so broad patterns like /usage.?limit/ or /overloaded/
      // are checked against the error payload emitted by the CLI.
      const cliMessage =
        exitCode !== 0
          ? resultText
            ? `${outcome.message}\n${resultText}`
            : outcome.message
          : "";
      const classification = classifyClaudeError(
        cliMessage,
        stderr,
        rl.claudePatterns,
        nowMs,
        resultText,
      );
      if (!classification.isRateLimit && !rateLimitEventSeen) {
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

      const resetsAtMs = rateLimitResetsAtMs ?? classification.resetsAtMs ?? parseResetsTime(assistantText, nowMs);
      let waitMs: number;
      if (resetsAtMs !== null) {
        waitMs = Math.max(0, resetsAtMs - nowMs + RATE_LIMIT_BUFFER_MS);
      } else {
        waitMs = reprobeMs;
      }

      waitMs = Math.max(waitMs, RATE_LIMIT_MIN_WAIT_MS);

      const remainingMs = capMs - elapsed;
      waitMs = Math.min(waitMs, remainingMs);

      this.opts.log(
        `rate limit detected; waiting ${Math.ceil(waitMs / 60_000)}m before re-probe`,
      );

      if (rl.wait) {
        const pausedAt = new Date(nowMs).toISOString();
        const meta: PauseMeta = {
          reason: "rate_limit",
          target: "claude",
          pausedAt,
          nextReprobeAt: new Date(nowMs + waitMs).toISOString(),
          capDeadlineAt: new Date(startMs + capMs).toISOString(),
        };
        const waitResult = await rl.wait(meta, waitMs);
        if (waitResult === "interrupted") {
          return { kind: "interrupted", costUsd: totalCost };
        }
      } else if (rl.isInterrupted) {
        const SLEEP_CHUNK_MS = 10_000;
        for (let slept = 0; slept < waitMs; slept += SLEEP_CHUNK_MS) {
          if (rl.isInterrupted()) {
            return { kind: "interrupted", costUsd: totalCost };
          }
          await rl.sleep(Math.min(SLEEP_CHUNK_MS, waitMs - slept));
        }
        if (rl.isInterrupted()) {
          return { kind: "interrupted", costUsd: totalCost };
        }
      } else {
        await rl.sleep(waitMs);
      }

      // Re-check cap after sleep to prevent an extra probe when sleep
      // was clamped to the remaining cap time.
      const postSleepElapsed = rl.clock() - startMs;
      if (postSleepElapsed >= capMs) {
        this.opts.log(`rate limit cap exceeded (${rl.capHours}h); halting`);
        return {
          kind: "error",
          costUsd: totalCost,
          message: `rate limit cap exceeded (${rl.capHours}h): ${outcome.message}`,
        };
      }
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
      const full = resultLine.result ?? "";
      const summary = full.slice(0, SUMMARY_MAX);
      return { kind: "completed", costUsd, summary, fullResult: full };
    }
    return {
      kind: "error",
      costUsd,
      message: resultLine.result ?? "agent error",
    };
  }
}
