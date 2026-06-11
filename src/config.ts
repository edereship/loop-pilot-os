import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// ---- snake_case TOML スキーマ（カーネル §3 の全キー） ----
const rawSchema = z.object({
  product: z.object({
    goal: z.string(),
  }).strict(),
  repo: z.object({
    path: z.string(),
    remote: z.string(),
    default_branch: z.string().default("main"),
    worktree_root: z.string().optional(),
  }).strict(),
  linear: z.object({
    team: z.string(),
    project: z.string(),
    opt_in_label: z.string(),
    states: z.object({
      todo: z.string(),
      in_progress: z.string(),
      in_review: z.string(),
      done: z.string(),
    }).strict(),
  }).strict(),
  agent: z.object({
    model: z.string(),
    allowed_tools: z.string(),
    extra_args: z.array(z.string()).default([]),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).default("max"),
  }).strict(),
  handoff: z.object({
    branch_prefix: z.string(),
    pr_body_template: z.string(),
  }).strict(),
  looppilot: z.object({
    gate_label: z.string(),
    state_comment_authors: z.array(z.string()).min(1),
  }).strict(),
  safety: z.object({
    max_tasks_per_run: z.number().int().positive(),
    max_cost_usd_per_session: z.number().positive(),
    monitor_timeout_minutes: z.number().positive().optional(),
    not_engaged_guard_minutes: z.number().positive().default(30),
    // 停止した（コストを消費しない）claude が無人ループを永久に固めるのを防ぐ hard backstop。
    // コスト一本化（仕様§11）は維持し、これは進捗・支出ゼロのハングを切る最終手段。
    session_hard_timeout_minutes: z.number().positive().default(120),
  }).strict(),
  loop: z.object({
    monitor_poll_seconds: z.number().int().positive(),
    idle_recheck_seconds: z.number().int().positive(),
  }).strict(),
  digest: z.object({
    recent_merged_count: z.number().int().positive(),
  }).strict(),
  notify: z.object({}).strict().optional(),
}).strict();

type RawConfig = z.infer<typeof rawSchema>;

// ---- camelCase Config（このモジュールが唯一の定義元・types.ts には置かない。カーネル §3） ----
export interface Config {
  product: { goal: string };
  repo: {
    path: string;
    remote: string;
    defaultBranch: string;
    worktreeRoot: string;
  };
  linear: {
    team: string;
    project: string;
    optInLabel: string;
    states: {
      todo: string;
      inProgress: string;
      inReview: string;
      done: string;
    };
  };
  agent: {
    model: string;
    allowedTools: string;
    extraArgs: string[];
    effort: string;
  };
  handoff: {
    branchPrefix: string;
    prBodyTemplate: string;
  };
  looppilot: {
    gateLabel: string;
    stateCommentAuthors: string[];
  };
  safety: {
    maxTasksPerRun: number;
    maxCostUsdPerSession: number;
    monitorTimeoutMinutes: number | undefined;
    notEngagedGuardMinutes: number;
    sessionHardTimeoutMinutes: number;
  };
  loop: {
    monitorPollSeconds: number;
    idleRecheckSeconds: number;
  };
  digest: {
    recentMergedCount: number;
  };
  linearApiKey: string;
  slackWebhookUrl: string | undefined;
  stateDbPath: string;
}

// モデル名に含まれるサブストリング（小文字）が一致した場合のみ effort 対応とみなす allowlist。
// Claude Code docs が effort 対応を明記しているのは Fable 5, Opus 4.x, Sonnet 4.6 のみ。
// Sonnet 4.5 は非対応のため "sonnet" 全体ではなくバージョン付きサブストリングで照合する。
// claude-3-opus-20240229 等のレガシー Opus は非対応のため "opus-4" でバージョン限定する。
// 未知・将来モデルは非サポートとして安全側に倒す（denylist では漏れが生じる）。
const EFFORT_SUPPORTED_MODEL_SUBSTRINGS = ["fable", "opus-4", "sonnet-4-6", "sonnet-4.6"];
// ベアエイリアスはサブストリングで照合すると誤ヒットするため完全一致で扱う。
// "sonnet" → 最新 Sonnet（4.6）, "opus" → 最新 Opus（4.x）, "best" → Fable 5 / 最新 Opus
// "opusplan" → Opus の plan モード（effort 対応）
// にそれぞれ解決されるため effort 対応とみなす。
// 注意: Bedrock / Vertex / Foundry 等サードパーティプロバイダでは "sonnet" が Sonnet 4.5 に
// 解決される場合がある（4.5 は effort 非対応）。そのようなデプロイでは effort = "auto" を
// 明示するか、バージョン付きモデル名（例: claude-sonnet-4-6）を使用すること。
const EFFORT_SUPPORTED_MODEL_EXACT = new Set(["sonnet", "opus", "best", "opusplan"]);

// "[1m]" サフィックスはコンテキストウィンドウ指定であり effort 対応可否に影響しない。
// 照合前に除去することで "opus[1m]" → "opus" のような 1M バリアントを透過的に扱う。
function normalizeModelForCapabilityCheck(model: string): string {
  return model.toLowerCase().replace(/\[1m\]$/i, "");
}

/** モデルが effort フラグをサポートしているか（allowlist に合致する場合のみ対応とみなす）。 */
export function modelSupportsEffort(model: string): boolean {
  const lower = normalizeModelForCapabilityCheck(model);
  return EFFORT_SUPPORTED_MODEL_EXACT.has(lower) ||
    EFFORT_SUPPORTED_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
}

// xhigh をサポートするのは Fable 5 と Opus 4.7+（README §model×effort 対応表）。
// Opus 4.6 や Sonnet 4.6 は xhigh 非対応（low/medium/high/max のみ）。
const XHIGH_SUPPORTED_MODEL_SUBSTRINGS = ["fable", "opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8"];
// "fable"/"opus" ベアエイリアスは最新世代（xhigh 対応）に解決されるため完全一致で許可する。
// "opus[1m]" は normalizeModelForCapabilityCheck により "opus" に正規化されてヒットする。
const XHIGH_SUPPORTED_MODEL_EXACT = new Set(["fable", "opus", "best"]);

/** モデルが xhigh effort をサポートしているか（Fable 5 / Opus 4.7+ のみ）。 */
function modelSupportsXhigh(model: string): boolean {
  const lower = normalizeModelForCapabilityCheck(model);
  return XHIGH_SUPPORTED_MODEL_EXACT.has(lower) ||
    XHIGH_SUPPORTED_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
}

function formatIssuePath(issuePath: PropertyKey[]): string {
  return issuePath.map((segment) => String(segment)).join(".");
}

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Config {
  let rawText: string;
  try {
    rawText = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read config file at ${configPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(rawText);
  } catch (err) {
    throw new Error(
      `Failed to parse TOML at ${configPath}: ${(err as Error).message}`,
    );
  }

  const errors: string[] = [];

  // env シークレット検証（zod エラーと同じ集約に混ぜる）。
  const linearApiKey = env.LINEAR_API_KEY;
  if (linearApiKey === undefined || linearApiKey === "") {
    errors.push("LINEAR_API_KEY: required environment variable is not set");
  }
  const slackWebhookUrl =
    env.SLACK_WEBHOOK_URL !== undefined && env.SLACK_WEBHOOK_URL !== ""
      ? env.SLACK_WEBHOOK_URL
      : undefined;

  const result = rawSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${formatIssuePath(issue.path)}: ${issue.message}`);
    }
  }

  // モデルと effort の組み合わせ検証（schema parse 成功後に実施）。
  // CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 がセットされている場合はカスタムモデル/ゲートウェイ
  // デプロイ向けのエスケープハッチとして allowlist チェックをスキップする。
  if (result.success) {
    const { model, effort, extra_args } = result.data.agent;
    const effortAlwaysEnabled = env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1";
    if (!effortAlwaysEnabled && effort !== "auto" && !modelSupportsEffort(model)) {
      errors.push(
        `agent.effort: model "${model}" does not support effort levels; ` +
          `set agent.effort = "auto" or use a supported model (Fable 5, Opus 4.x, Sonnet 4.6)`,
      );
    }
    if (!effortAlwaysEnabled && effort === "xhigh" && modelSupportsEffort(model) && !modelSupportsXhigh(model)) {
      errors.push(
        `agent.effort: effort level "xhigh" requires Fable 5 or Opus 4.7+; ` +
          `model "${model}" supports low/medium/high/max only`,
      );
    }
    // CLAUDE_CODE_EFFORT_LEVEL env override（effortEnvOverride 経由で子プロセスに注入）は
    // --effort フラグより優先されるため、extra_args に --effort を含めると agent.effort の
    // 設定が無視されてしまう。effort の調整は agent.effort キーで一元管理すること。
    if (extra_args.includes("--effort")) {
      errors.push(
        `agent.extra_args: "--effort" must not be set via extra_args; ` +
          `use agent.effort instead (the CLAUDE_CODE_EFFORT_LEVEL env override injected at launch ` +
          `takes precedence over --effort flags in extra_args)`,
      );
    }
  }

  if (!result.success || errors.length > 0) {
    throw new Error(
      `Invalid LoopPilot OS config (${configPath}):\n` +
        errors.map((line) => `  - ${line}`).join("\n"),
    );
  }

  const raw: RawConfig = result.data;

  const worktreeRoot =
    raw.repo.worktree_root ??
    path.join(
      os.homedir(),
      ".looppilot-os",
      "worktrees",
      path.basename(raw.repo.path),
    );
  const stateDbPath = path.join(path.dirname(path.resolve(configPath)), "looppilot-os.db");

  return {
    product: { goal: raw.product.goal },
    repo: {
      path: raw.repo.path,
      remote: raw.repo.remote,
      defaultBranch: raw.repo.default_branch,
      worktreeRoot,
    },
    linear: {
      team: raw.linear.team,
      project: raw.linear.project,
      optInLabel: raw.linear.opt_in_label,
      states: {
        todo: raw.linear.states.todo,
        inProgress: raw.linear.states.in_progress,
        inReview: raw.linear.states.in_review,
        done: raw.linear.states.done,
      },
    },
    agent: {
      model: raw.agent.model,
      allowedTools: raw.agent.allowed_tools,
      extraArgs: raw.agent.extra_args,
      effort: raw.agent.effort,
    },
    handoff: {
      branchPrefix: raw.handoff.branch_prefix,
      prBodyTemplate: raw.handoff.pr_body_template,
    },
    looppilot: {
      gateLabel: raw.looppilot.gate_label,
      stateCommentAuthors: raw.looppilot.state_comment_authors,
    },
    safety: {
      maxTasksPerRun: raw.safety.max_tasks_per_run,
      maxCostUsdPerSession: raw.safety.max_cost_usd_per_session,
      monitorTimeoutMinutes: raw.safety.monitor_timeout_minutes,
      notEngagedGuardMinutes: raw.safety.not_engaged_guard_minutes,
      sessionHardTimeoutMinutes: raw.safety.session_hard_timeout_minutes,
    },
    loop: {
      monitorPollSeconds: raw.loop.monitor_poll_seconds,
      idleRecheckSeconds: raw.loop.idle_recheck_seconds,
    },
    digest: {
      recentMergedCount: raw.digest.recent_merged_count,
    },
    linearApiKey: linearApiKey as string,
    slackWebhookUrl,
    stateDbPath,
  };
}
