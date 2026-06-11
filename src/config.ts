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
