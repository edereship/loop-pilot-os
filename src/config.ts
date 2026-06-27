import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// ---- snake_case TOML スキーマ（カーネル §3 の全キー） ----
const rawSchema = z.object({
  product: z.object({
    goal: z.string().min(1, "product.goal must not be empty").optional(),
    spec_dir: z.string().min(1, "product.spec_dir must not be empty").optional(),
  }).strict().refine(
    (p) => p.goal !== undefined || p.spec_dir !== undefined,
    { message: "product.goal or product.spec_dir is required" },
  ).refine(
    (p) => !(p.goal !== undefined && p.spec_dir !== undefined),
    { message: "product.goal and product.spec_dir are mutually exclusive; set one or the other" },
  ),
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
    needs_human_label: z.string().default("needs-human"),
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
    permission_mode: z.enum([
      "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions",
    ]).default("acceptEdits"),
    // Per-phase overrides (ES-486). Each field is individually optional; omitted fields
    // fall back to the parent agent.model/effort. E.g. [agent.design] model = "opus" with
    // no effort key inherits agent.effort.
    design: z.object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    }).strict().optional(),
    implement: z.object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    }).strict().optional(),
    self_review: z.object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    }).strict().optional(),
    recovery: z.object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    }).strict().optional(),
    verify: z.object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).optional(),
    }).strict().optional(),
  }).strict(),
  // Codex (PM) per-phase effort (ES-486). Absent → Codex gets no -m/-c flags (backward compat).
  // effort fields use z.string() so loadConfig can produce error messages that include the
  // received value (Zod v4 enum errors omit it). Validation of "low"|"medium"|"high" is done
  // manually in loadConfig after schema parse.
  pm: z.object({
    model: z.string().default("gpt-5.5"),
    effort: z.object({
      groom: z.string().default("medium"),
      select: z.string().default("low"),
      design_review: z.string().default("high"),
      recovery: z.string().default("high"),
      verify: z.string().default("high"),
    }).strict().optional(),
  }).strict().optional(),
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
    monitor_timeout_minutes: z.number().positive().default(60),
    not_engaged_guard_minutes: z.number().positive().default(30),
    // 停止した（コストを消費しない）claude が無人ループを永久に固めるのを防ぐ hard backstop。
    // コスト一本化（仕様§11）は維持し、これは進捗・支出ゼロのハングを切る最終手段。
    session_hard_timeout_minutes: z.number().positive().default(120),
    max_workflow_fix_attempts: z.number().int().positive().default(2),
    max_cost_usd_per_fix: z.number().positive().default(2),
    codex_timeout_minutes: z.number().positive().default(30),
    design_timeout_minutes: z.number().positive().default(15),
    max_cost_usd_per_design: z.number().positive().default(2),
    design_review_timeout_minutes: z.number().positive().default(15),
    max_design_review_attempts: z.number().int().positive().default(2),
    select_diff_budget_chars: z.number().int().positive().default(6000),
    select_codebase_summary_budget_chars: z.number().int().positive().default(5000),
    groom_timeout_minutes: z.number().positive().default(10),
    groom_board_budget_chars: z.number().int().positive().default(10000),
    self_review_timeout_minutes: z.number().positive().default(15),
    max_cost_usd_per_self_review: z.number().positive().default(2),
    max_verify_attempts: z.number().int().positive().default(2),
    max_cost_usd_per_verify: z.number().positive().default(2),
    verify_timeout_minutes: z.number().positive().default(15),
    max_recovery_attempts: z.number().int().positive().default(2),
    transient_retry_attempts: z.number().int().nonnegative().default(2),
  }).strict(),
  loop: z.object({
    monitor_poll_seconds: z.number().int().positive(),
    idle_recheck_seconds: z.number().int().positive(),
    idle_timeout_minutes: z.number().int().nonnegative().default(120),
  }).strict(),
  digest: z.object({
    recent_merged_count: z.number().int().positive(),
    enabled: z.boolean().default(true),
  }).strict(),
  notify: z.object({
    progress: z.boolean().default(false),
  }).strict().optional(),
  groom: z.object({
    enabled: z.boolean().default(true),
  }).strict().optional(),
  self_review: z.object({
    enabled: z.boolean().default(true),
  }).strict().optional(),
  memory: z.object({
    max_chars_per_file: z.number().int().positive().default(8000),
    inject_budget_chars: z.number().int().positive().default(6000),
  }).strict().optional(),
  verify: z.object({
    enabled: z.boolean().default(true),
    run_recipe: z.string().default(""),
  }).strict().optional(),
  rate_limit: z.object({
    reprobe_minutes: z.number().positive().default(15),
    cap_hours: z.number().positive().default(6),
    claude_patterns: z.array(z.string()).default([]),
    codex_patterns: z.array(z.string()).default([]),
  }).strict().optional(),
}).strict();

type RawConfig = z.infer<typeof rawSchema>;

// ---- camelCase Config（このモジュールが唯一の定義元・types.ts には置かない。カーネル §3） ----
export interface Config {
  product: {
    goal: string | undefined;
    specDir: string | undefined;
  };
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
    needsHumanLabel: string;
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
    permissionMode: string;
    design: { model: string; effort: string } | undefined;
    implement: { model: string; effort: string } | undefined;
    selfReview: { model: string; effort: string } | undefined;
    recovery: { model: string; effort: string } | undefined;
    verify: { model: string; effort: string } | undefined;
  };
  pm: {
    model: string;
    effort: {
      groom: string | undefined;
      select: string | undefined;
      designReview: string | undefined;
      recovery: string | undefined;
      verify: string | undefined;
    };
  } | undefined;
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
    monitorTimeoutMinutes: number;
    notEngagedGuardMinutes: number;
    sessionHardTimeoutMinutes: number;
    maxWorkflowFixAttempts: number;
    maxCostUsdPerFix: number;
    codexTimeoutMinutes: number;
    designTimeoutMinutes: number;
    maxCostUsdPerDesign: number;
    designReviewTimeoutMinutes: number;
    maxDesignReviewAttempts: number;
    selectDiffBudgetChars: number;
    selectCodebaseSummaryBudgetChars: number;
    groomTimeoutMinutes: number;
    groomBoardBudgetChars: number;
    selfReviewTimeoutMinutes: number;
    maxCostUsdPerSelfReview: number;
    maxVerifyAttempts: number;
    maxCostUsdPerVerify: number;
    verifyTimeoutMinutes: number;
    maxRecoveryAttempts: number;
    transientRetryAttempts: number;
  };
  loop: {
    monitorPollSeconds: number;
    idleRecheckSeconds: number;
    idleTimeoutMinutes: number;
  };
  digest: {
    recentMergedCount: number;
    enabled: boolean;
  };
  notify: {
    progress: boolean;
  };
  groom: {
    enabled: boolean;
  };
  selfReview: {
    enabled: boolean;
  };
  memory: {
    maxCharsPerFile: number;
    injectBudgetChars: number;
  };
  verify: {
    enabled: boolean;
    runRecipe: string;
  };
  rateLimit: {
    reprobeMinutes: number;
    capHours: number;
    claudePatterns: string[];
    codexPatterns: string[];
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

  // 4. For "opusplan": both the Opus and Sonnet phase-model pins must declare the capability,
  //    since opusplan runs plan phase on Opus and execution phase on Sonnet.
  if (normalizedModel === "opusplan") {
    if (hasEffort(env["ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"]) &&
        hasEffort(env["ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES"])) {
      return true;
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

  // 4. For "opusplan": both the Opus and Sonnet phase-model pins must declare max_effort.
  if (normalizedModel === "opusplan") {
    if (hasMaxEffort(env["ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"]) &&
        hasMaxEffort(env["ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES"])) {
      return true;
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

  // 4. For "opusplan": both the Opus and Sonnet phase-model pins must declare xhigh_effort.
  if (normalizedModel === "opusplan") {
    if (hasXhighEffort(env["ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"]) &&
        hasXhighEffort(env["ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES"])) {
      return true;
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

/**
 * ベアエイリアス（EFFORT_SUPPORTED_MODEL_EXACT に含まれる）が ANTHROPIC_DEFAULT_{X}_MODEL で
 * 別モデルにリマップされているが _SUPPORTED_CAPABILITIES="effort" の宣言がない場合に true を返す。
 * そのようなケースでは allowlist による effort 対応判定を信用できないため、
 * 呼び出し元でエラーとして扱うか "auto" にフォールバックする。
 */
function isAliasPinnedToUnknownModel(model: string, env: NodeJS.ProcessEnv): boolean {
  const normalizedModel = normalizeModelForCapabilityCheck(model);
  if (!EFFORT_SUPPORTED_MODEL_EXACT.has(normalizedModel)) return false;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const match = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/.exec(key);
    if (!match) continue;
    const aliasFromKey = match[1].toLowerCase();
    if (aliasFromKey !== normalizedModel) continue;
    // ピン先が自分自身（no-op）の場合はスキップ。
    if (normalizeModelForCapabilityCheck(value) === normalizedModel) continue;
    // 別モデルにリマップされている。effort capability が宣言されているか確認する。
    const caps = env[`ANTHROPIC_DEFAULT_${match[1]}_MODEL_SUPPORTED_CAPABILITIES`];
    if (!caps || !caps.split(",").map((s) => s.trim()).includes("effort")) {
      return true;
    }
  }
  return false;
}

/**
 * Per-phase model/effort pair validation (ES-486).
 * Applies the same allowlist and capability checks as the global agent.model/effort validation,
 * but scoped to a specific per-phase block (e.g. "agent.design", "agent.recovery").
 * phasePath is used as the error message prefix; ".effort" is appended automatically.
 */
function validatePhaseModelEffort(
  phasePath: string,
  model: string,
  effort: string,
  env: NodeJS.ProcessEnv,
  errors: string[],
): void {
  const effortAlwaysEnabled = env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1";
  const hasEffortEnvVar = modelHasEffortCapabilityEnvVar(model, env);
  const skipEffortChecks = effortAlwaysEnabled || hasEffortEnvVar;
  const skipXhighCheck = effortAlwaysEnabled || modelHasXhighEffortCapabilityEnvVar(model, env);
  const skipMaxCheck = effortAlwaysEnabled ||
    modelHasMaxEffortCapabilityEnvVar(model, env) ||
    modelSupportsEffort(model);
  const aliasPinnedToUnknown = !skipEffortChecks && isAliasPinnedToUnknownModel(model, env);
  const isThirdParty = isThirdPartyProviderContext(env);
  const normalizedModel = normalizeModelForCapabilityCheck(model);

  if (!skipEffortChecks && effort !== "auto" && (!modelSupportsEffort(model) || aliasPinnedToUnknown)) {
    errors.push(
      `${phasePath}.effort: model "${model}" does not support effort levels; ` +
        `set ${phasePath}.effort = "auto" or use a supported model (Fable 5, Opus 4.x, Sonnet 4.6)`,
    );
  }

  // Bedrock/Vertex/Foundry では "sonnet" ベアエイリアスが Sonnet 4.5 に解決される
  // 可能性があるため、明示的な non-auto effort は拒否する。
  if (!skipEffortChecks && isThirdParty && normalizedModel === "sonnet" && effort !== "auto") {
    errors.push(
      `${phasePath}.effort: model "sonnet" may resolve to Sonnet 4.5 on Bedrock/Vertex/Foundry which does not support effort; ` +
        `pin to a versioned model (e.g., claude-sonnet-4-6) or set ${phasePath}.effort = "auto"`,
    );
  }

  // "opusplan" は実行フェーズで Sonnet を使用するため、Bedrock/Vertex/Foundry では
  // Sonnet 4.5 に解決される可能性があり "sonnet" と同様に non-auto effort を拒否する。
  if (!skipEffortChecks && isThirdParty && normalizedModel === "opusplan" && effort !== "auto") {
    errors.push(
      `${phasePath}.effort: model "opusplan" execution phase may resolve to Sonnet 4.5 on Bedrock/Vertex/Foundry which does not support effort; ` +
        `pin to a versioned model or set ${phasePath}.effort = "auto"`,
    );
  }

  if (!skipXhighCheck && effort === "xhigh" && (skipEffortChecks || modelSupportsEffort(model)) && !modelSupportsXhigh(model)) {
    errors.push(
      `${phasePath}.effort: effort level "xhigh" requires Fable 5 or Opus 4.7+; ` +
        `model "${model}" supports low/medium/high/max only`,
    );
  }

  // Bedrock/Vertex/Foundry では "opus" ベアエイリアスが Opus 4.6 に解決される
  // 可能性があるため、xhigh は拒否する（Opus 4.6 は xhigh 非対応）。
  if (!skipXhighCheck && isThirdParty && normalizedModel === "opus" && effort === "xhigh") {
    errors.push(
      `${phasePath}.effort: effort level "xhigh" requires Fable 5 or Opus 4.7+; ` +
        `model "opus" on Bedrock/Vertex/Foundry resolves to Opus 4.6 which supports low/medium/high/max only`,
    );
  }

  if (!skipMaxCheck && hasEffortEnvVar && effort === "max") {
    errors.push(
      `${phasePath}.effort: effort level "max" requires "max_effort" capability; ` +
        `model "${model}" declares "effort" but not "max_effort" ` +
        `— add "max_effort" to the supported capabilities or use a lower effort level`,
    );
  }
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
    const isThirdParty = isThirdPartyProviderContext(env);
    // ベアエイリアスが ANTHROPIC_DEFAULT_{X}_MODEL で capability 宣言なしに別モデルへ
    // リマップされている場合、allowlist 判定を信用しない（Finding 1）。
    const aliasPinnedToUnknown = !skipEffortChecks && isAliasPinnedToUnknownModel(model, env);
    // effort 未指定時のデフォルト:
    // - effortAlwaysEnabled が true: "max"（エスケープハッチ、全対応宣言）
    // - max_effort 宣言済み capability がある: "max"（明示的に max_effort が宣言された）
    //   ※ "effort" だけの宣言では "max" にしない（max_effort と effort は別 capability）
    // - modelDefaultsToMaxEffort が true かつ alias のリマップなし: "max"（バージョン確定済み・全プロバイダ対応）
    // - 直接 Anthropic API（非サードパーティ）で EFFORT_SUPPORTED_MODEL_EXACT のエイリアス（Finding 2）:
    //   "max"（"sonnet"/"opusplan" を Bedrock/Vertex 以外で使う直接 API ユーザ向け）
    // - それ以外: "auto"（Bedrock/Vertex/Foundry での "sonnet"/"opusplan"、alias リマップ済み等）
    const canDefaultToMax = effortAlwaysEnabled ||
      modelHasMaxEffortCapabilityEnvVar(model, env) ||
      (modelDefaultsToMaxEffort(model) && !aliasPinnedToUnknown) ||
      (!isThirdParty && !aliasPinnedToUnknown &&
        EFFORT_SUPPORTED_MODEL_EXACT.has(normalizeModelForCapabilityCheck(model)));
    effectiveEffort = rawEffort ?? (canDefaultToMax ? "max" : "auto");

    if (!skipEffortChecks && effectiveEffort !== "auto" && (!modelSupportsEffort(model) || aliasPinnedToUnknown)) {
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
    if (extra_args.some((arg) => arg === "--effort" || arg.startsWith("--effort="))) {
      errors.push(
        `agent.extra_args: "--effort" must not be set via extra_args; ` +
          `use agent.effort instead (the CLAUDE_CODE_EFFORT_LEVEL env override injected at launch ` +
          `takes precedence over --effort flags in extra_args)`,
      );
    }

    // Codex (pm) effort validation (ES-486): only low/medium/high are valid (Codex caps at high).
    // Produces custom error messages that include the received value so tests can match on it.
    const VALID_CODEX_EFFORT = ["low", "medium", "high"];
    if (result.data.pm?.effort) {
      const pmEffort = result.data.pm.effort;
      for (const [field, value] of [
        ["groom", pmEffort.groom],
        ["select", pmEffort.select],
        ["design_review", pmEffort.design_review],
        ["recovery", pmEffort.recovery],
        ["verify", pmEffort.verify],
      ] as [string, string][]) {
        if (!VALID_CODEX_EFFORT.includes(value)) {
          errors.push(
            `pm.effort.${field}: "${value}" is not a valid Codex effort level; ` +
              `expected one of "low", "medium", "high" (Codex reasoning effort caps at "high")`,
          );
        }
      }
    }

    // Per-phase agent model/effort validation (ES-486).
    // Validate the resolved values (with parent fallback) so partial overrides are also checked.
    const phaseEntries: [string, { model?: string; effort?: string } | undefined][] = [
      ["agent.design", result.data.agent.design],
      ["agent.implement", result.data.agent.implement],
      ["agent.self_review", result.data.agent.self_review],
      ["agent.recovery", result.data.agent.recovery],
      ["agent.verify", result.data.agent.verify],
    ];
    for (const [phasePath, rawPhase] of phaseEntries) {
      if (rawPhase !== undefined) {
        const resolvedModel = rawPhase.model ?? result.data.agent.model;
        const resolvedEffort = rawPhase.effort ?? effectiveEffort;
        validatePhaseModelEffort(phasePath, resolvedModel, resolvedEffort, env, errors);
      }
    }

    if (result.data.rate_limit?.claude_patterns) {
      for (const pattern of result.data.rate_limit.claude_patterns) {
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(
            `rate_limit.claude_patterns: invalid regex "${pattern}"`,
          );
        }
      }
    }
    if (result.data.rate_limit?.codex_patterns) {
      for (const pattern of result.data.rate_limit.codex_patterns) {
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(
            `rate_limit.codex_patterns: invalid regex "${pattern}"`,
          );
        }
      }
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
    product: { goal: raw.product.goal, specDir: raw.product.spec_dir },
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
      needsHumanLabel: raw.linear.needs_human_label,
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
      permissionMode: raw.agent.permission_mode,
      design: raw.agent.design
        ? { model: raw.agent.design.model ?? raw.agent.model, effort: raw.agent.design.effort ?? effectiveEffort }
        : undefined,
      implement: raw.agent.implement
        ? { model: raw.agent.implement.model ?? raw.agent.model, effort: raw.agent.implement.effort ?? effectiveEffort }
        : undefined,
      selfReview: raw.agent.self_review
        ? { model: raw.agent.self_review.model ?? raw.agent.model, effort: raw.agent.self_review.effort ?? effectiveEffort }
        : undefined,
      recovery: raw.agent.recovery
        ? { model: raw.agent.recovery.model ?? raw.agent.model, effort: raw.agent.recovery.effort ?? effectiveEffort }
        : undefined,
      verify: raw.agent.verify
        ? { model: raw.agent.verify.model ?? raw.agent.model, effort: raw.agent.verify.effort ?? effectiveEffort }
        : undefined,
    },
    pm: raw.pm !== undefined
      ? {
          model: raw.pm.model,
          effort: {
            groom: raw.pm.effort?.groom,
            select: raw.pm.effort?.select,
            designReview: raw.pm.effort?.design_review,
            recovery: raw.pm.effort?.recovery,
            verify: raw.pm.effort?.verify,
          },
        }
      : undefined,
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
      maxWorkflowFixAttempts: raw.safety.max_workflow_fix_attempts,
      maxCostUsdPerFix: raw.safety.max_cost_usd_per_fix,
      codexTimeoutMinutes: raw.safety.codex_timeout_minutes,
      designTimeoutMinutes: raw.safety.design_timeout_minutes,
      maxCostUsdPerDesign: raw.safety.max_cost_usd_per_design,
      designReviewTimeoutMinutes: raw.safety.design_review_timeout_minutes,
      maxDesignReviewAttempts: raw.safety.max_design_review_attempts,
      selectDiffBudgetChars: raw.safety.select_diff_budget_chars,
      selectCodebaseSummaryBudgetChars: raw.safety.select_codebase_summary_budget_chars,
      groomTimeoutMinutes: raw.safety.groom_timeout_minutes,
      groomBoardBudgetChars: raw.safety.groom_board_budget_chars,
      selfReviewTimeoutMinutes: raw.safety.self_review_timeout_minutes,
      maxCostUsdPerSelfReview: raw.safety.max_cost_usd_per_self_review,
      maxVerifyAttempts: raw.safety.max_verify_attempts,
      maxCostUsdPerVerify: raw.safety.max_cost_usd_per_verify,
      verifyTimeoutMinutes: raw.safety.verify_timeout_minutes,
      maxRecoveryAttempts: raw.safety.max_recovery_attempts,
      transientRetryAttempts: raw.safety.transient_retry_attempts,
    },
    loop: {
      monitorPollSeconds: raw.loop.monitor_poll_seconds,
      idleRecheckSeconds: raw.loop.idle_recheck_seconds,
      idleTimeoutMinutes: raw.loop.idle_timeout_minutes,
    },
    digest: {
      recentMergedCount: raw.digest.recent_merged_count,
      enabled: raw.digest.enabled,
    },
    notify: {
      progress: raw.notify?.progress ?? false,
    },
    groom: {
      enabled: raw.groom?.enabled ?? true,
    },
    selfReview: {
      enabled: raw.self_review?.enabled ?? true,
    },
    memory: {
      maxCharsPerFile: raw.memory?.max_chars_per_file ?? 8000,
      injectBudgetChars: raw.memory?.inject_budget_chars ?? 6000,
    },
    verify: {
      enabled: raw.verify?.enabled ?? true,
      runRecipe: raw.verify?.run_recipe ?? "",
    },
    rateLimit: {
      reprobeMinutes: raw.rate_limit?.reprobe_minutes ?? 15,
      capHours: raw.rate_limit?.cap_hours ?? 6,
      claudePatterns: raw.rate_limit?.claude_patterns ?? [],
      codexPatterns: raw.rate_limit?.codex_patterns ?? [],
    },
    linearApiKey: linearApiKey as string,
    slackWebhookUrl,
    stateDbPath,
  };
}
