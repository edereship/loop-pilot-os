import { parseArgs } from "node:util";
import process from "node:process";

import type { TicketState } from "./types.js";
import { loadConfig } from "./config.js";
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
import { Orchestrator } from "./orchestrator.js";
import { runPreflight } from "./preflight.js";
import { renderStatus } from "./status.js";

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

function parseCli(argv: string[]): { command: string; configPath: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", default: "./looppilot-os.toml" },
    },
  });
  const command = positionals[0] ?? "";
  return { command, configPath: values.config as string };
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
    const agent = new ClaudeAgentRunner(runner, {
      model: config.agent.model,
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
    });

    // SIGINT → orchestrator.requestStop()（次の安全点でクリーン halt）。
    // run_started 通知は orchestrator.run() が内部で送る（カーネル §7）。
    let interrupted = false;
    const onSigint = (): void => {
      if (interrupted) return;
      interrupted = true;
      process.stderr.write(
        "\nSIGINT received: stopping at next safe point...\n",
      );
      orchestrator.requestStop();
    };
    process.on("SIGINT", onSigint);

    try {
      await orchestrator.run();
    } finally {
      process.removeListener("SIGINT", onSigint);
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
  const { command, configPath } = parseCli(process.argv.slice(2));
  switch (command) {
    case "run":
      process.exitCode = await runLoop(configPath);
      return;
    case "status":
      process.exitCode = await runStatus(configPath);
      return;
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
