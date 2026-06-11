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
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
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
// Claude Code docs が effort 対応を明記しているのは Fable 5, Opus 4.6/4.7/4.8, Sonnet 4.6 のみ。
// Sonnet 4.5 は非対応のため "sonnet" 全体ではなくバージョン付きサブストリングで照合する。
// claude-3-opus-20240229 等のレガシー Opus および claude-opus-4-20250514 等の 4.x patch ID は
// 非対応のため "opus-4-6/4-7/4-8" の完全バージョン番号でのみ照合する（"opus-4" では漏れる）。
// 未知・将来モデルは非サポートとして安全側に倒す（denylist では漏れが生じる）。
const EFFORT_SUPPORTED_MODEL_SUBSTRINGS = [
  "fable",
  "opus-4-6", "opus-4.6",
  "opus-4-7", "opus-4.7",
  "opus-4-8", "opus-4.8",
  "sonnet-4-6", "sonnet-4.6",
];
// ベアエイリアスはサブストリングで照合すると誤ヒットするため完全一致で扱う。
// "sonnet" → 最新 Sonnet（4.6）, "opus" → 最新 Opus（4.x）, "best" → Fable 5 / 最新 Opus
// "opusplan" → Opus の plan モード（plan フェーズは Opus、実行フェーズは Sonnet を使用）
// にそれぞれ解決されるため effort 対応とみなす。
// 注意: Bedrock / Vertex / Foundry 等サードパーティプロバイダでは "sonnet" および "opusplan"
// の実行フェーズが Sonnet 4.5 に解決される場合がある（4.5 は effort 非対応）。
// そのようなデプロイでは effort = "auto" を明示するか、バージョン付きモデル名を使用すること。
const EFFORT_SUPPORTED_MODEL_EXACT = new Set(["sonnet", "opus", "best", "opusplan"]);
// effort キーが未設定のときにデフォルト "max" を採用する（安全な）ベアエイリアスのセット。
// "sonnet" はサードパーティプロバイダで Sonnet 4.5 に解決される可能性があるため除外する。
// "opusplan" は実行フェーズで Sonnet を使用するため同様にサードパーティで Sonnet 4.5 に
// 解決される可能性がある。未指定設定を安全側に倒すため除外する。
const EFFORT_SAFE_DEFAULT_MODEL_EXACT = new Set(["opus", "best"]);

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

/**
 * effort キー未指定時に "max" をデフォルトとして安全に採用できるモデルか。
 * "sonnet" ベアエイリアスは除外する（Bedrock/Vertex/Foundry では Sonnet 4.5 に解決され得るため）。
 * バージョン付き ID（"claude-sonnet-4-6" 等）は EFFORT_SUPPORTED_MODEL_SUBSTRINGS で対象になる。
 */
function modelDefaultsToMaxEffort(model: string): boolean {
  const lower = normalizeModelForCapabilityCheck(model);
  return EFFORT_SAFE_DEFAULT_MODEL_EXACT.has(lower) ||
    EFFORT_SUPPORTED_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Claude Code が定義する *_SUPPORTED_CAPABILITIES 環境変数に "effort" が含まれるか確認する。
 * 以下の 3 つのパターンを順に照合する。
 *
 * 1. モデル ID 由来変数（既存）:
 *    例: model "anthropic.claude-sonnet-4-6-20250514-v1:0" →
 *        ANTHROPIC_CLAUDE_SONNET_4_6_20250514_V1_0_SUPPORTED_CAPABILITIES=effort
 *
 * 2. カスタムモデルオプション（ANTHROPIC_CUSTOM_MODEL_OPTION が model と一致する場合）:
 *    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES=effort
 *
 * 3. デフォルトモデルエイリアスのピン留め（ANTHROPIC_DEFAULT_{X}_MODEL が model と一致する場合）:
 *    例: ANTHROPIC_DEFAULT_OPUS_MODEL=my-gateway-model かつ
 *        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES=effort
 */
export function modelHasEffortCapabilityEnvVar(model: string, env: NodeJS.ProcessEnv): boolean {
  function hasEffort(capVar: string | undefined): boolean {
    return capVar !== undefined && capVar.split(",").map((s) => s.trim()).includes("effort");
  }

  // 1. Direct model-ID-derived variable.
  const prefix = model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (hasEffort(env[`${prefix}_SUPPORTED_CAPABILITIES`])) return true;

  // 2. ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES when the custom model option matches.
  if (env["ANTHROPIC_CUSTOM_MODEL_OPTION"] === model &&
      hasEffort(env["ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES"])) {
    return true;
  }

  // 3. ANTHROPIC_DEFAULT_{X}_MODEL_SUPPORTED_CAPABILITIES for any pinned default model alias.
  //    Also matches when the alias derived from the env key name (e.g. "OPUS" → "opus") equals
  //    the normalized config model, so that ANTHROPIC_DEFAULT_OPUS_MODEL capabilities apply when
  //    agent.model = "opus" even if the pinned value is a gateway model ID.
  const normalizedModel = normalizeModelForCapabilityCheck(model);
  for (const [key, value] of Object.entries(env)) {
    const match = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/.exec(key);
    if (match) {
      const aliasFromKey = match[1].toLowerCase();
      if ((value === model || aliasFromKey === normalizedModel) &&
          hasEffort(env[`ANTHROPIC_DEFAULT_${match[1]}_MODEL_SUPPORTED_CAPABILITIES`])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Claude Code が定義する *_SUPPORTED_CAPABILITIES 環境変数に "max_effort" が含まれるか確認する。
 * modelHasEffortCapabilityEnvVar と同じ 3 パターンで "max_effort" を照合する。
 * "effort" だけが宣言されている場合は false を返すため、デフォルトを "max" にするか
 * "auto" にするかの判断に使用できる。
 */
export function modelHasMaxEffortCapabilityEnvVar(model: string, env: NodeJS.ProcessEnv): boolean {
  function hasMaxEffort(capVar: string | undefined): boolean {
    return capVar !== undefined && capVar.split(",").map((s) => s.trim()).includes("max_effort");
  }

  const prefix = model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (hasMaxEffort(env[`${prefix}_SUPPORTED_CAPABILITIES`])) return true;

  if (env["ANTHROPIC_CUSTOM_MODEL_OPTION"] === model &&
      hasMaxEffort(env["ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES"])) {
    return true;
  }

  const normalizedModel = normalizeModelForCapabilityCheck(model);
  for (const [key, value] of Object.entries(env)) {
    const match = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/.exec(key);
    if (match) {
      const aliasFromKey = match[1].toLowerCase();
      if ((value === model || aliasFromKey === normalizedModel) &&
          hasMaxEffort(env[`ANTHROPIC_DEFAULT_${match[1]}_MODEL_SUPPORTED_CAPABILITIES`])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Claude Code が定義する *_SUPPORTED_CAPABILITIES 環境変数に "xhigh_effort" が含まれるか確認する。
 * modelHasEffortCapabilityEnvVar と同じ 3 パターンで "xhigh_effort" を照合する。
 * "effort" や "max_effort" だけが宣言されている場合は false を返す。
 */
export function modelHasXhighEffortCapabilityEnvVar(model: string, env: NodeJS.ProcessEnv): boolean {
  function hasXhighEffort(capVar: string | undefined): boolean {
    return capVar !== undefined && capVar.split(",").map((s) => s.trim()).includes("xhigh_effort");
  }

  const prefix = model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (hasXhighEffort(env[`${prefix}_SUPPORTED_CAPABILITIES`])) return true;

  if (env["ANTHROPIC_CUSTOM_MODEL_OPTION"] === model &&
      hasXhighEffort(env["ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES"])) {
    return true;
  }

  const normalizedModel = normalizeModelForCapabilityCheck(model);
  for (const [key, value] of Object.entries(env)) {
    const match = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/.exec(key);
    if (match) {
      const aliasFromKey = match[1].toLowerCase();
      if ((value === model || aliasFromKey === normalizedModel) &&
          hasXhighEffort(env[`ANTHROPIC_DEFAULT_${match[1]}_MODEL_SUPPORTED_CAPABILITIES`])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Bedrock / Vertex / Foundry のサードパーティプロバイダ実行コンテキストか確認する。
 * これらのプロバイダではベアエイリアス（"sonnet", "opus"）が古い世代に解決される場合がある。
 */
function isThirdPartyProviderContext(env: NodeJS.ProcessEnv): boolean {
  return !!(
    env["CLAUDE_CODE_USE_BEDROCK"] ||
    env["CLAUDE_CODE_USE_VERTEX"] ||
    env["CLAUDE_CODE_USE_FOUNDRY"]
  );
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
  // プロバイダ固有モデル ID に対する *_SUPPORTED_CAPABILITIES env var も同様にスキップを
  // トリガーする（Claude Code 公式の capability オーバーライド機構）。
  const effortAlwaysEnabled = env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1";
  // effort の有効値（モデル対応を考慮したデフォルト解決済み）。
  // result.success の場合のみ上書きされるが、エラー時はこの値を使わないため初期値は不問。
  let effectiveEffort = "max";
  if (result.success) {
    const { model, effort: rawEffort, extra_args } = result.data.agent;
    // capability env var または CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 がある場合は
    // allowlist チェックを全スキップする。
    const hasEffortEnvVar = modelHasEffortCapabilityEnvVar(model, env);
    const skipEffortChecks = effortAlwaysEnabled || hasEffortEnvVar;
    // xhigh / max はそれぞれ xhigh_effort / max_effort が宣言されている場合のみスキップする。
    // "effort" のみ宣言されたカスタムモデルでも xhigh/max の level-specific チェックを通す。
    const skipXhighCheck = effortAlwaysEnabled || modelHasXhighEffortCapabilityEnvVar(model, env);
    // allowlist に含まれる標準モデルはすべて max を対応とみなすため skipMaxCheck = true。
    // カスタムモデルで max_effort が宣言されていない場合は max を拒否する。
    const skipMaxCheck = effortAlwaysEnabled ||
      modelHasMaxEffortCapabilityEnvVar(model, env) ||
      modelSupportsEffort(model);
    // effort 未指定時のデフォルト:
    // - effortAlwaysEnabled が true: "max"（エスケープハッチ、全対応宣言）
    // - max_effort 宣言済み capability がある: "max"（明示的に max_effort が宣言された）
    //   ※ "effort" だけの宣言では "max" にしない（max_effort と effort は別 capability）
    // - modelDefaultsToMaxEffort が true: "max"（バージョン確定済み・全プロバイダ対応）
    // - それ以外: "auto"（"sonnet" 等の曖昧なエイリアス、Bedrock/Vertex での安全側）
    const canDefaultToMax = effortAlwaysEnabled ||
      modelHasMaxEffortCapabilityEnvVar(model, env) ||
      modelDefaultsToMaxEffort(model);
    effectiveEffort = rawEffort ?? (canDefaultToMax ? "max" : "auto");

    const isThirdParty = isThirdPartyProviderContext(env);

    if (!skipEffortChecks && effectiveEffort !== "auto" && !modelSupportsEffort(model)) {
      errors.push(
        `agent.effort: model "${model}" does not support effort levels; ` +
          `set agent.effort = "auto" or use a supported model (Fable 5, Opus 4.x, Sonnet 4.6)`,
      );
    }
    // Bedrock/Vertex/Foundry では "sonnet" ベアエイリアスが Sonnet 4.5 に解決される
    // 可能性があるため、明示的な non-auto effort は拒否する（バージョン付き ID またはオーバーライドを要求）。
    if (!skipEffortChecks && isThirdParty && normalizeModelForCapabilityCheck(model) === "sonnet" && effectiveEffort !== "auto") {
      errors.push(
        `agent.effort: model "sonnet" may resolve to Sonnet 4.5 on Bedrock/Vertex/Foundry which does not support effort; ` +
          `pin to a versioned model (e.g., claude-sonnet-4-6) or set agent.effort = "auto"`,
      );
    }
    // "opusplan" は実行フェーズで Sonnet を使用するため、Bedrock/Vertex/Foundry では
    // Sonnet 4.5 に解決される可能性があり "sonnet" と同様に non-auto effort を拒否する。
    if (!skipEffortChecks && isThirdParty && normalizeModelForCapabilityCheck(model) === "opusplan" && effectiveEffort !== "auto") {
      errors.push(
        `agent.effort: model "opusplan" execution phase may resolve to Sonnet 4.5 on Bedrock/Vertex/Foundry which does not support effort; ` +
          `pin to a versioned model or set agent.effort = "auto"`,
      );
    }
    // xhigh は xhigh_effort capability が宣言されているか allowlist でサポートが確認できる
    // 場合のみ許可する（"effort" のみ宣言されたカスタムモデルでも xhigh は拒否）。
    if (!skipXhighCheck && effectiveEffort === "xhigh" && (skipEffortChecks || modelSupportsEffort(model)) && !modelSupportsXhigh(model)) {
      errors.push(
        `agent.effort: effort level "xhigh" requires Fable 5 or Opus 4.7+; ` +
          `model "${model}" supports low/medium/high/max only`,
      );
    }
    // Bedrock/Vertex/Foundry では "opus" ベアエイリアスが Opus 4.6 に解決される
    // 可能性があるため、xhigh は拒否する（Opus 4.6 は xhigh 非対応）。
    if (!skipXhighCheck && isThirdParty && normalizeModelForCapabilityCheck(model) === "opus" && effectiveEffort === "xhigh") {
      errors.push(
        `agent.effort: effort level "xhigh" requires Fable 5 or Opus 4.7+; ` +
          `model "opus" on Bedrock/Vertex/Foundry resolves to Opus 4.6 which supports low/medium/high/max only`,
      );
    }
    // max_effort capability が宣言されていないカスタムモデルで "max" を要求した場合は拒否する。
    // "effort" と "max_effort" は別 capability であり、"effort" のみの宣言では max は非許可。
    if (!skipMaxCheck && hasEffortEnvVar && effectiveEffort === "max") {
      errors.push(
        `agent.effort: effort level "max" requires "max_effort" capability; ` +
          `model "${model}" declares "effort" but not "max_effort" ` +
          `— add "max_effort" to the supported capabilities or use a lower effort level`,
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
      effort: effectiveEffort,
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
