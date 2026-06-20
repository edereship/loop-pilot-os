import process from "node:process";
import type { CommandRunner, RunOptions } from "./types.js";

const STDERR_TAIL_MAX = 1000;

// Keep in sync with agent-runner.ts SENSITIVE_ENV_KEYS
// CLAUDE_CODE_EFFORT_LEVEL is intentionally not filtered: Codex CLI does not
// consume this env var (it is Claude Code specific).
const SENSITIVE_ENV_KEYS = [
  "LINEAR_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // Codex/OpenAI auth credentials: must not be exposed to the Codex child process
  // because ticket-derived prompts run inside it and could exfiltrate them via shell.
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN",
];

function codexChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface CodexPlannerContext {
  worktreePath: string;
  prompt: string;
  timeoutMs?: number;
}

export type CodexOutcome =
  | { kind: "completed"; text: string }
  | { kind: "error"; message: string };

export interface CodexPlannerOptions {
  log: (line: string) => void;
  extraArgs?: string[];
}

export class CodexPlanner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: CodexPlannerOptions,
  ) {}

  async run(ctx: CodexPlannerContext): Promise<CodexOutcome> {
    const args: string[] = [
      "exec",
      "--ephemeral",
      ...(this.opts.extraArgs ?? []),
      ctx.prompt,
    ];

    const runOpts: RunOptions = {
      cwd: ctx.worktreePath,
      env: codexChildEnv(),
      stdin: "ignore",
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    };

    this.opts.log("codex session started");

    let result;
    try {
      result = await this.runner.run("codex", args, runOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`codex session failed: ${message}`);
      return { kind: "error", message };
    }

    if (result.code !== 0) {
      const tail = result.stderr.trim().slice(-STDERR_TAIL_MAX);
      const msg = `codex exited with code ${result.code}`;
      this.opts.log(`codex session error: ${msg}`);
      return { kind: "error", message: tail ? `${msg}: ${tail}` : msg };
    }

    this.opts.log("codex session completed");
    return { kind: "completed", text: result.stdout.trim() };
  }

  async checkAvailability(): Promise<string> {
    let result;
    try {
      result = await this.runner.run("codex", ["--version"], { cwd: "." });
    } catch (err) {
      throw new Error(
        `codex CLI not found or not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (result.code !== 0) {
      throw new Error("codex CLI not found or not available");
    }
    const version = result.stdout.trim();

    let authResult;
    try {
      authResult = await this.runner.run("codex", ["login", "status"], { cwd: "." });
    } catch (err) {
      throw new Error(
        `codex: 認証状態を確認できません（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (authResult.code !== 0) {
      throw new Error("codex: 認証されていません（codex login を実行してください）");
    }

    return version;
  }
}
