#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { config as dotenvConfig } from "dotenv";

import type { TicketState } from "./types.js";
import { loadConfig, modelSupportsEffort, modelHasEffortCapabilityEnvVar } from "./config.js";
import { SqliteStore } from "./store.js";
import { RealCommandRunner } from "./exec.js";
import { ConsoleSlackNotifier } from "./notifier.js";
import {
  LinearTaskSource,
  resolveLinearSetup,
  type LinearSetupRequest,
} from "./task-source.js";
import { GitPrManager } from "./git-pr.js";
import { ClaudeAgentRunner } from "./agent-runner.js";
import { GhLoopPilotMonitor } from "./monitor.js";
import { buildPrompt } from "./context-bundle.js";
import { Orchestrator, type RunOutcome } from "./orchestrator.js";
import { runPreflight } from "./preflight.js";
import { renderStatus } from "./status.js";
import { AgentWorkflowRecovery } from "./workflow-recovery.js";

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

const CONFIG_CANDIDATES = ["looppilot-os.toml"];

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
    const notifier = new ConsoleSlackNotifier(
      store,
      config.slackWebhookUrl ?? null,
      logLine,
    );

    // プリフライト: 違反を全件収集 → 列挙して exit 1（仕様 §8 / カーネル §9）。
    // fetchFn は Node 24 ネイティブ fetch。Linear 解決もこの中で fetch を使う。
    const preflightErrors = await runPreflight({
      config,
      runner,
      notifier,
      fetchFn: globalThis.fetch,
      getuid: process.getuid?.bind(process),
    });
    if (preflightErrors.length > 0) {
      process.stderr.write("Preflight failed:\n");
      for (const message of preflightErrors) {
        process.stderr.write(`  - ${message}\n`);
      }
      return EXIT_PREFLIGHT;
    }

    // Linear の team/project/4状態/オプトインラベルを ID へ解決。
    // config の camelCase 状態名 → TicketState キーへ写像して渡す。
    const stateNames: Record<TicketState, string> = {
      todo: config.linear.states.todo,
      in_progress: config.linear.states.inProgress,
      in_review: config.linear.states.inReview,
      done: config.linear.states.done,
    };
    const setupRequest: LinearSetupRequest = {
      teamKey: config.linear.team,
      projectName: config.linear.project,
      stateNames,
      optInLabel: config.linear.optInLabel,
    };
    const linearSetup = await resolveLinearSetup(
      config.linearApiKey,
      setupRequest,
      globalThis.fetch,
    );

    const source = new LinearTaskSource({
      apiKey: config.linearApiKey,
      projectId: linearSetup.projectId,
      stateIds: linearSetup.stateIds,
      optInLabel: config.linear.optInLabel,
      fetchFn: globalThis.fetch,
    });
    // CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 はカスタムモデル/ゲートウェイ向けのエスケープハッチ。
    // *_SUPPORTED_CAPABILITIES env var も同様のオーバーライドとして扱う（loadConfig と一致）。
    // これらが未設定の場合は通常の allowlist 照合で effort 対応の有無を判定する。
    const effortAlwaysEnabled = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1";
    const effortSupported = effortAlwaysEnabled ||
      modelHasEffortCapabilityEnvVar(config.agent.model, process.env) ||
      modelSupportsEffort(config.agent.model);
    const effort = config.agent.effort;
    const agent = new ClaudeAgentRunner(runner, {
      model: config.agent.model,
      // omit --effort flag for "auto" or models that do not support effort
      effort: effortSupported && effort !== "auto" ? effort : undefined,
      // override CLAUDE_CODE_EFFORT_LEVEL for supported models (so inherited env cannot
      // silently override the TOML value) and also for effort="auto" on any model (so an
      // inherited CLAUDE_CODE_EFFORT_LEVEL=max in the shell cannot leak into the child)
      effortEnvOverride: effortSupported || effort === "auto" ? effort : undefined,
      permissionMode: config.agent.permissionMode,
      allowedTools: config.agent.allowedTools,
      extraArgs: config.agent.extraArgs,
      log: logLine,
    });
    const git = new GitPrManager(runner, {
      repoPath: config.repo.path,
      remote: config.repo.remote,
      defaultBranch: config.repo.defaultBranch,
      branchPrefix: config.handoff.branchPrefix,
      worktreeRoot: config.repo.worktreeRoot,
      prBodyTemplate: config.handoff.prBodyTemplate,
      gateLabel: config.looppilot.gateLabel,
    });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: config.repo.remote,
      trustedAuthors: config.looppilot.stateCommentAuthors,
    });

    const recovery = new AgentWorkflowRecovery(
      agent,
      runner,
      config.repo.remote,
      config.safety.maxWorkflowFixAttempts,
      logLine,
    );

    const orchestrator = new Orchestrator({
      config,
      source,
      agent,
      git,
      monitor,
      notifier,
      store,
      buildPrompt,
      clock: nowIso,
      sleep,
      log: logLine,
      recovery,
    });

    // 停止シグナル → orchestrator.requestStop()（次の安全点でクリーン halt）。
    // SIGINT に加え、常駐運用で一般的な SIGTERM（systemd/コンテナ停止）・SIGHUP（端末切断）も
    // 捕捉する（未捕捉だと Node 既定の即時終了で finally の releaseRunLock/close が走らず、
    // run_lock 行・Run=running・未チェックポイント WAL が残留する）。
    // 2 回目の停止シグナルは強制終了（安全点まで待てない運用者向けのエスケープハッチ）。
    // run_started 通知は orchestrator.run() が内部で送る（カーネル §7）。
    const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    let stopRequested = false;
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
