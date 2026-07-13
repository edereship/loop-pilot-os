#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { config as dotenvConfig } from "dotenv";

import { loadConfig, modelSupportsEffort, modelHasEffortCapabilityEnvVar, SCOUT_DEFAULT_ALLOWED_TOOLS } from "./config.js";
import { SqliteStore } from "./store.js";
import { RealCommandRunner } from "./exec.js";
import { ConsoleSlackNotifier } from "./notifier.js";
import {
  LinearTaskSource,
  resolveLinearSetup,
  buildLinearSetupRequest,
} from "./task-source.js";
import { GitPrManager } from "./git-pr.js";
import { ClaudeAgentRunner, type RateLimitOpts } from "./agent-runner.js";
import { GhLoopPilotMonitor } from "./monitor.js";
import { buildPrompt } from "./context-bundle.js";
import { loadSpecContent } from "./spec-reader.js";
import { Orchestrator, type RunOutcome } from "./orchestrator.js";
import { runPreflight } from "./preflight.js";
import { renderStatus } from "./status.js";
import { AgentWorkflowRecovery } from "./workflow-recovery.js";
import { CodexPlanner, type CodexRateLimitOpts } from "./codex-planner.js";
import { ClaudePlanRunner } from "./claude-planner.js";
import { generateCodebaseSummary } from "./codebase-summary.js";
import { GroomBoardFetcher } from "./groom-board-fetcher.js";
import { GroomLinearClient } from "./groom-linear-client.js";
import { fetchWithTimeout } from "./fetch-timeout.js";

const EXIT_OK = 0;
const EXIT_PREFLIGHT = 1;
const EXIT_HALTED = 2;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLine(line: string): void {
  process.stdout.write(line + "\n");
}

const CONFIG_CANDIDATES = ["looppilot-os.toml", ".looppilot-os.toml"];

function resolveDefaultConfigPath(): string {
  for (const name of CONFIG_CANDIDATES) {
    if (existsSync(name)) return name;
  }
  process.stderr.write(
    `Error: no config file found (tried ${CONFIG_CANDIDATES.join(", ")}). ` +
      `Use --config <path> to specify one.\n`,
  );
  process.exit(1);
}

function parseCli(argv: string[]): { command: string; configPath: string | null } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
    },
  });
  if (positionals.length > 1) {
    process.stderr.write("Usage: looppilot-os <run|status> [--config <path>]\n");
    process.exit(1);
  }
  const command = positionals[0] ?? "";
  return { command, configPath: values.config ?? null };
}

async function runStatus(configPath: string): Promise<number> {
  const config = loadConfig(configPath, process.env);
  const store = new SqliteStore(config.stateDbPath);
  try {
    process.stdout.write(renderStatus(store) + "\n");
    return EXIT_OK;
  } finally {
    store.close();
  }
}

async function runLoop(configPath: string): Promise<number> {
  const config = loadConfig(configPath, process.env);
  const store = new SqliteStore(config.stateDbPath);
  try {
    const runner = new RealCommandRunner();
    const timedFetch = fetchWithTimeout(globalThis.fetch as unknown as import("./task-source.js").FetchFn);
    const notifier = new ConsoleSlackNotifier(
      store,
      config.slackWebhookUrl ?? null,
      logLine,
      timedFetch,
    );

    // ES-534 / ES-535: --bare disables OAuth; SCOUT requires ANTHROPIC_API_KEY.
    // Compute effective SCOUT availability before preflight so that Linear label
    // resolution (checkLinear) and the post-preflight resolveLinearSetup both omit
    // scout labels when the key is absent, preventing spurious preflight failures.
    const scoutAvailable = config.scout.enabled && !!process.env.ANTHROPIC_API_KEY;

    // When the previous run persisted checkout_dirty=1, the working tree may still contain
    // Codex artifacts. Skip the dirty-tree check so the daemon can start and let the
    // orchestrator's startup cleanup restore the checkout before any work runs (ES-512 Finding 1).
    const allowDirtyCheckout = (store.latestRun()?.checkoutDirty ?? 0) !== 0;

    // プリフライト: 違反を全件収集 → 列挙して exit 1（仕様 §8 / カーネル §9）。
    // fetchFn は Node 24 ネイティブ fetch。Linear 解決もこの中で fetch を使う。
    const preflightErrors = await runPreflight({
      config,
      runner,
      notifier,
      fetchFn: timedFetch,
      getuid: process.getuid?.bind(process),
      allowDirtyCheckout,
    });
    if (preflightErrors.length > 0) {
      process.stderr.write("Preflight failed:\n");
      for (const message of preflightErrors) {
        process.stderr.write(`  - ${message}\n`);
      }
      return EXIT_PREFLIGHT;
    }

    // Linear の team/project/4状態/ラベル（opt-in / needs-human / scout）を ID へ解決（ES-516）。
    // scoutAvailable を渡すことで API キー不在時に scout ラベル解決をスキップする（ES-535）。
    const setupRequest = buildLinearSetupRequest(config, scoutAvailable);
    const linearSetup = await resolveLinearSetup(
      config.linearApiKey,
      setupRequest,
      timedFetch,
    );

    const source = new LinearTaskSource({
      apiKey: config.linearApiKey,
      projectId: linearSetup.projectId,
      stateIds: linearSetup.stateIds,
      optInLabel: config.linear.optInLabel,
      needsHumanLabel: config.linear.needsHumanLabel,
      needsHumanLabelId: linearSetup.needsHumanLabelId,
      fetchFn: timedFetch,
    });
    // CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 はカスタムモデル/ゲートウェイ向けのエスケープハッチ。
    // *_SUPPORTED_CAPABILITIES env var も同様のオーバーライドとして扱う（loadConfig と一致）。
    // これらが未設定の場合は通常の allowlist 照合で effort 対応の有無を判定する。
    const effortAlwaysEnabled = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1";
    let stopRequested = false;
    const rateLimitOpts: RateLimitOpts = {
      reprobeMinutes: config.rateLimit.reprobeMinutes,
      capHours: config.rateLimit.capHours,
      claudePatterns: config.rateLimit.claudePatterns,
      sleep,
      clock: Date.now,
      isInterrupted: () => stopRequested,
    };

    // Build a ClaudeAgentRunner for a specific phase. When phaseConfig is set, uses
    // the per-phase model/effort; otherwise falls back to the global agent defaults.
    // `tools` (when set) passes --tools to restrict the tool set available to the agent;
    // this is distinct from `allowedTools` which only controls which tools auto-execute.
    // `skipRateLimit` omits the rate-limit retry loop; use for idle/scheduled phases
    // (e.g. SCOUT) so a Claude rate limit causes an immediate error rather than blocking
    // the orchestrator for up to cap_hours (Finding 3 — Codex review).
    function buildPhaseAgent(
      phaseConfig: { model: string; effort: string } | undefined,
      permissionMode: string,
      allowedTools?: string,
      extraArgs?: string[],
      tools?: string,
      skipRateLimit?: boolean,
    ): ClaudeAgentRunner {
      const model = phaseConfig?.model ?? config.agent.model;
      const rawEffort = phaseConfig?.effort ?? config.agent.effort;
      const supported = effortAlwaysEnabled ||
        modelHasEffortCapabilityEnvVar(model, process.env) ||
        modelSupportsEffort(model);
      return new ClaudeAgentRunner(runner, {
        model,
        effort: supported && rawEffort !== "auto" ? rawEffort : undefined,
        effortEnvOverride: supported || rawEffort === "auto" ? rawEffort : undefined,
        permissionMode,
        allowedTools: allowedTools ?? config.agent.allowedTools,
        tools,
        extraArgs: extraArgs ?? config.agent.extraArgs,
        log: logLine,
        rateLimit: skipRateLimit ? undefined : rateLimitOpts,
      });
    }

    const agent = buildPhaseAgent(config.agent.implement, config.agent.permissionMode);
    const selfReviewAgent = buildPhaseAgent(config.agent.selfReview, config.agent.permissionMode);
    const verifyAgent = buildPhaseAgent(config.agent.verify, config.agent.permissionMode);
    const recoveryAgent = buildPhaseAgent(config.agent.recovery, config.agent.permissionMode);
    // SCOUT always runs in "default" permission mode so that only the explicitly listed
    // allowedTools auto-execute.  Inheriting "acceptEdits" or "bypassPermissions" would
    // let the agent edit files despite the read-only-ish tool list (those modes
    // auto-approve edits regardless of allowedTools).
    // Strip permission-mode overrides, --dangerously-skip-permissions, and --tools overrides
    // from global extra_args. These flags, when appended after the SCOUT-specific values,
    // override the SCOUT boundary (Claude Code uses the last occurrence) and nullify SCOUT's
    // read-only intent (ES-519 Finding 1, Finding 3).
    // Handles both "--flag=value" (one arg) and "--flag" "value" (two args) forms.
    if (config.scout.enabled && !scoutAvailable) {
      logLine("SCOUT disabled: ANTHROPIC_API_KEY not set (--bare requires API-key auth)");
    }
    const scoutAgent = scoutAvailable ? (() => {
      const scoutExtraArgs = (() => {
        const out: string[] = [];
        const raw = config.agent.extraArgs;
        for (let i = 0; i < raw.length; i++) {
          const a = raw[i];
          if (a === "--dangerously-skip-permissions") continue;
          if (a.startsWith("--permission-mode=")) continue;
          if (a === "--permission-mode") { i++; continue; }
          if (a.startsWith("--tools=")) continue;
          if (a === "--tools") { i++; continue; }
          if (a.startsWith("--add-dir=")) continue;
          if (a === "--add-dir") { i++; continue; }
          out.push(a);
        }
        out.push("--disallowedTools", "mcp__*");
        out.push("--bare");
        return out;
      })();
      const scoutTools = config.agent.scout?.allowedTools ?? SCOUT_DEFAULT_ALLOWED_TOOLS;
      const scoutBareTools = scoutTools.split(",").map(t => t.split("(")[0].trim()).join(",");
      return buildPhaseAgent(
        config.agent.scout,
        "default",
        scoutTools,
        scoutExtraArgs,
        scoutBareTools,
        true,
      );
    })() : null;
    const designAgent = buildPhaseAgent(config.agent.design, "plan");
    const designer = new ClaudePlanRunner(designAgent, {
      maxCostUsd: config.safety.maxCostUsdPerDesign,
    });
    const git = new GitPrManager(runner, {
      repoPath: config.repo.path,
      remote: config.repo.remote,
      defaultBranch: config.repo.defaultBranch,
      branchPrefix: config.handoff.branchPrefix,
      worktreeRoot: config.repo.worktreeRoot,
      prBodyTemplate: config.handoff.prBodyTemplate,
      gateLabel: config.looppilot.gateLabel,
      log: logLine,
    });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: config.repo.remote,
      trustedAuthors: config.looppilot.stateCommentAuthors,
    });

    const recovery = new AgentWorkflowRecovery(
      recoveryAgent,
      runner,
      config.repo.remote,
      config.safety.maxWorkflowFixAttempts,
      logLine,
    );

    const codexRateLimitOpts: CodexRateLimitOpts = {
      reprobeMinutes: config.rateLimit.reprobeMinutes,
      capHours: config.rateLimit.capHours,
      codexPatterns: config.rateLimit.codexPatterns,
      sleep,
      clock: Date.now,
      isInterrupted: () => stopRequested,
    };
    const codexPlanner = new CodexPlanner(runner, {
      log: logLine,
      rateLimit: codexRateLimitOpts,
    });

    const codebaseSummaryGenerator = (repoPath: string) =>
      generateCodebaseSummary(repoPath, runner, config.safety.selectCodebaseSummaryBudgetChars);

    const groomBoardFetcher = new GroomBoardFetcher({
      apiKey: config.linearApiKey,
      projectId: linearSetup.projectId,
      stateIds: linearSetup.stateIds,
      optInLabel: config.linear.optInLabel,
      fetchFn: timedFetch,
    });

    const groomLinearClient = new GroomLinearClient({
      apiKey: config.linearApiKey,
      projectId: linearSetup.projectId,
      teamId: linearSetup.teamId,
      stateIds: linearSetup.stateIds,
      optInLabelId: linearSetup.optInLabelId,
      labelMap: linearSetup.labelMap,
      fetchFn: timedFetch,
    });

    const orchestrator = new Orchestrator({
      config,
      source,
      agent,
      selfReviewAgent,
      verifyAgent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt,
      specLoader: config.product.specDir ? loadSpecContent : null,
      clock: nowIso,
      sleep,
      log: logLine,
      recovery,
      planner: codexPlanner,
      designer,
      designReviewer: codexPlanner,
      mergeGateJudge: codexPlanner,
      codebaseSummaryGenerator,
      runner,
      recoveryTurn: {
        planner: codexPlanner,
        agent: recoveryAgent,
        git,
        runner,
        source,
        config,
        log: logLine,
      },
      groomDeps: config.groom.enabled ? {
        boardFetcher: groomBoardFetcher,
        linearClient: groomLinearClient,
        knownLabels: linearSetup.knownLabels,
      } : null,
      scoutDeps: scoutAgent !== null ? {
        agent: scoutAgent,
        boardFetcher: groomBoardFetcher,
        linearClient: groomLinearClient,
        reviewer: codexPlanner,
        scoutLabelId: linearSetup.scoutLabelId,
        scoutTriageLabelId: linearSetup.scoutTriageLabelId,
      } : null,
    });

    // Wire the orchestrator's interruptablePause into the agent runner so that
    // Claude API rate-limit waits set the run's paused state and fire
    // paused/resumed notifications, instead of sleeping silently.
    rateLimitOpts.wait = async (meta, waitMs) => {
      const ctrl = await orchestrator.interruptablePause(meta, waitMs);
      return ctrl.control === "halt" ? "interrupted" : "complete";
    };
    codexRateLimitOpts.wait = async (meta, waitMs) => {
      const ctrl = await orchestrator.interruptablePause(meta, waitMs);
      return ctrl.control === "halt" ? "interrupted" : "complete";
    };

    // 停止シグナル → orchestrator.requestStop()（次の安全点でクリーン halt）。
    // SIGINT に加え、常駐運用で一般的な SIGTERM（systemd/コンテナ停止）・SIGHUP（端末切断）も
    // 捕捉する（未捕捉だと Node 既定の即時終了で finally の releaseRunLock/close が走らず、
    // run_lock 行・Run=running・未チェックポイント WAL が残留する）。
    // 2 回目の停止シグナルは強制終了（安全点まで待てない運用者向けのエスケープハッチ）。
    // run_started 通知は orchestrator.run() が内部で送る（カーネル §7）。
    const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onStopSignal = (signal: NodeJS.Signals): void => {
      if (stopRequested) {
        process.stderr.write(`\n${signal} again: forcing exit.\n`);
        process.exit(130);
      }
      stopRequested = true;
      process.stderr.write(
        `\n${signal} received: stopping at next safe point (repeat to force exit)...\n`,
      );
      orchestrator.requestStop();
    };
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of STOP_SIGNALS) {
      const handler = (): void => {
        onStopSignal(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    let outcome: RunOutcome;
    try {
      outcome = await orchestrator.run();
    } finally {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    }

    if (outcome === "lock_rejected") {
      process.stderr.write(
        "Error: another looppilot-os run is already active (run lock held).\n",
      );
      return EXIT_PREFLIGHT;
    }

    // HALT 終端なら exit 2、それ以外（idle で綺麗に止まった等）は 0。
    const finalRun = store.latestRun();
    return finalRun !== null && finalRun.state === "halted"
      ? EXIT_HALTED
      : EXIT_OK;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const { command, configPath: rawConfigPath } = parseCli(process.argv.slice(2));
  switch (command) {
    case "run":
    case "status": {
      const configPath = rawConfigPath ?? resolveDefaultConfigPath();
      dotenvConfig({ path: path.resolve(path.dirname(configPath), ".env"), quiet: true });
      process.exitCode = await (command === "run" ? runLoop(configPath) : runStatus(configPath));
      return;
    }
    default:
      process.stderr.write(
        "Usage: looppilot-os <run|status> [--config <path>]\n",
      );
      process.exitCode = EXIT_PREFLIGHT;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exitCode = EXIT_PREFLIGHT;
});
