import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { loadConfig, SCOUT_DEFAULT_ALLOWED_TOOLS } from "../src/config.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const fixture = (name: string): string => path.join(fixturesDir, name);

const fullEnv: NodeJS.ProcessEnv = {
  LINEAR_API_KEY: "lin_api_test_key",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
};

describe("loadConfig", () => {
  // 仕様 §8: product/repo/linear/agent/handoff/looppilot/safety/loop/digest を読み込み、
  // snake_case TOML を camelCase Config に写像する（カーネル §3）。
  it("loads a fully-specified config and maps snake_case TOML to camelCase Config", () => {
    const config = loadConfig(fixture("config-valid.toml"), fullEnv);

    expect(config.product.goal).toBe(
      "Build the best widget. Constraint: no breaking API changes.",
    );
    expect(config.repo.path).toBe("/abs/path/to/target-repo");
    expect(config.repo.remote).toBe("owner/name");
    expect(config.repo.defaultBranch).toBe("main");
    expect(config.repo.worktreeRoot).toBe("/custom/worktrees");

    expect(config.linear.team).toBe("TY");
    expect(config.linear.project).toBe("LoopPilot OS");
    expect(config.linear.optInLabel).toBe("ai-ok");
    expect(config.linear.states).toEqual({
      todo: "Todo",
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
    });
    expect(config.linearApiKey).toBe("lin_api_test_key");

    expect(config.agent.model).toBe("opus");
    expect(config.agent.allowedTools).toBe("Edit,Write,Read,Glob,Grep,Bash");
    expect(config.agent.extraArgs).toEqual(["--verbose"]);
    expect(config.agent.effort).toBe("high");

    expect(config.handoff.branchPrefix).toBe("looppilot");
    expect(config.handoff.prBodyTemplate).toContain("{identifier}");

    expect(config.looppilot.gateLabel).toBe("loop-pilot");
    expect(config.looppilot.stateCommentAuthors).toEqual([
      "github-actions[bot]",
    ]);

    expect(config.safety.maxTasksPerRun).toBe(3);
    expect(config.safety.maxCostUsdPerSession).toBe(10.0);
    expect(config.safety.monitorTimeoutMinutes).toBe(120);
    expect(config.safety.notEngagedGuardMinutes).toBe(30);
    expect(config.safety.sessionHardTimeoutMinutes).toBe(120); // 既定（hung claude 用 hard backstop）
    expect(config.safety.maxWorkflowFixAttempts).toBe(2); // default (not in config-valid.toml)
    expect(config.safety.maxCostUsdPerFix).toBe(2); // default (not in config-valid.toml)
    expect(config.safety.codexTimeoutMinutes).toBe(30); // default (not in config-valid.toml)
    expect(config.safety.selectCodebaseSummaryBudgetChars).toBe(5000); // default (not in config-valid.toml)

    expect(config.loop.monitorPollSeconds).toBe(60);
    expect(config.loop.idleRecheckSeconds).toBe(300);
    expect(config.loop.idleTimeoutMinutes).toBe(120); // default (not in config-valid.toml)

    expect(config.digest.recentMergedCount).toBe(5);
    expect(config.digest.enabled).toBe(true);

    expect(config.slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/T/B/X",
    );
  });

  // B1: spec_dir のみ（goal なし）でも有効な config として読み込める。
  it("loads config with spec_dir only (no goal) — v2 primary path", () => {
    const config = loadConfig(fixture("config-spec-dir.toml"), fullEnv);
    expect(config.product.specDir).toBe("docs/specs");
    expect(config.product.goal).toBeUndefined();
  });

  // 仕様 §8: stateDbPath = config と同ディレクトリの looppilot-os.db（カーネル §3）。
  it("resolves stateDbPath next to the config file", () => {
    const config = loadConfig(fixture("config-valid.toml"), fullEnv);
    expect(config.stateDbPath).toBe(path.join(fixturesDir, "looppilot-os.db"));
  });

  // カーネル §3: worktree_root 省略時 ~/.looppilot-os/worktrees/<repo basename>。
  it("defaults worktreeRoot under the home directory using the repo basename", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.repo.worktreeRoot).toBe(
      path.join(os.homedir(), ".looppilot-os", "worktrees", "myrepo"),
    );
  });

  // カーネル §3: 任意キーの既定値解決（default_branch=main, extra_args=[],
  // monitor_timeout_minutes=60, not_engaged_guard_minutes=30）。
  it("applies defaults for omitted optional keys", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.repo.defaultBranch).toBe("main");
    expect(config.agent.extraArgs).toEqual([]);
    expect(config.agent.effort).toBe("max");
    expect(config.safety.monitorTimeoutMinutes).toBe(60);
    expect(config.safety.notEngagedGuardMinutes).toBe(30);
    expect(config.safety.sessionHardTimeoutMinutes).toBe(120); // 省略時の既定
  });

  it("max_workflow_fix_attempts and max_cost_usd_per_fix default to 2 and 2.0", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.maxWorkflowFixAttempts).toBe(2);
    expect(config.safety.maxCostUsdPerFix).toBe(2);
  });

  it("merge gate config applies defaults when keys are omitted (ES-514)", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.mergeGateTimeoutMinutes).toBe(15);
    expect(config.safety.maxMergeGateFixAttempts).toBe(2);
    expect(config.safety.maxCostUsdPerMergeGateFix).toBe(2);
    expect(config.mergeGate.enabled).toBe(true);
  });

  // カーネル §3: SLACK_WEBHOOK_URL 未設定なら undefined（コンソールのみ）。
  it("leaves slackWebhookUrl undefined when env var is absent", () => {
    const config = loadConfig(fixture("config-minimal.toml"), {
      LINEAR_API_KEY: "lin_api_test_key",
    });
    expect(config.slackWebhookUrl).toBeUndefined();
    expect(config.linearApiKey).toBe("lin_api_test_key");
  });

  // カーネル §3: LINEAR_API_KEY 必須（env 欠落はエラー集約に含める）。
  it("throws when LINEAR_API_KEY is missing from the environment", () => {
    expect(() =>
      loadConfig(fixture("config-valid.toml"), {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
      }),
    ).toThrow(/LINEAR_API_KEY/);
  });

  // product.goal と product.spec_dir が両方欠落 → refine エラー。
  it("throws when both product.goal and product.spec_dir are missing", () => {
    expect(() =>
      loadConfig(fixture("config-missing-required.toml"), fullEnv),
    ).toThrow(/product\.goal or product\.spec_dir/);
  });

  // product.goal と product.spec_dir が両方設定 → refine エラー（相互排他）。
  it("throws when both product.goal and product.spec_dir are set", () => {
    expect(() =>
      loadConfig(fixture("config-both-goal-specdir.toml"), fullEnv),
    ).toThrow(/mutually exclusive/);
  });

  // 型不正（max_tasks_per_run に文字列）→ 該当パスを message に出す。
  it("throws on a type mismatch with the offending path", () => {
    expect(() =>
      loadConfig(fixture("config-wrong-type.toml"), fullEnv),
    ).toThrow(/safety\.max_tasks_per_run/);
  });

  // カーネル §3: 検証エラーは全件集約して1つの Error message に（最初の1件で止めない）。
  it("aggregates every validation error into a single message", () => {
    let message = "";
    try {
      loadConfig(fixture("config-missing-required.toml"), {});
    } catch (err) {
      message = (err as Error).message;
    }
    // product.goal/spec_dir 両欠落（zod refine 由来）と LINEAR_API_KEY 欠落（env 由来）の両方が同じ message に出る。
    expect(message).toContain("product.goal or product.spec_dir");
    expect(message).toContain("LINEAR_API_KEY");
  });

  // TOML 構文エラーは "Failed to parse TOML" でラップして throw する。
  it("throws wrapping TOML parse errors with 'Failed to parse TOML'", () => {
    expect(() =>
      loadConfig(fixture("config-syntax-error.toml"), fullEnv),
    ).toThrow(/Failed to parse TOML/);
  });

  // 不明キー（operator typo）は集約エラーの message に含める。
  it("throws on an unrecognized key in a sub-table", () => {
    expect(() =>
      loadConfig(fixture("config-unknown-key.toml"), fullEnv),
    ).toThrow(/max_task_per_run/);
  });

  // LINEAR_API_KEY が空文字列の場合も欠落と同等に扱う。
  it("throws when LINEAR_API_KEY is an empty string", () => {
    expect(() =>
      loadConfig(fixture("config-minimal.toml"), { LINEAR_API_KEY: "" }),
    ).toThrow(/LINEAR_API_KEY/);
  });

  // Finding 2: effort 非対応モデル（Haiku 等）で auto 以外の effort を指定したとき config エラー。
  it("throws when a non-effort model is paired with a non-auto effort value", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), fullEnv),
    ).toThrow(/agent\.effort/);
  });

  // Finding 2: Sonnet 4.5 は effort 非対応（4.6 以降のみ対応）。
  it("throws when Sonnet 4.5 is paired with a non-auto effort value", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet45-unsupported.toml"), fullEnv),
    ).toThrow(/agent\.effort/);
  });

  // Finding 2: "sonnet" ベアエイリアスは最新 Sonnet（4.6）に解決されるため effort 対応とみなす。
  it("accepts the 'sonnet' bare alias with a non-auto effort value", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet-alias.toml"), fullEnv),
    ).not.toThrow();
  });

  // Finding 1: "opusplan" は Claude Code が文書化するベアエイリアス（plan モード Opus）。
  // effort 対応とみなす（allowlist に含まれていないと default max で設定エラーになる）。
  it("accepts the 'opusplan' alias with a non-auto effort value", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opusplan.toml"), fullEnv),
    ).not.toThrow();
  });

  // Finding 3: "opus[1m]" は 1M コンテキストウィンドウ付き Opus のベアエイリアス。
  // [1m] サフィックスは capability に影響しないため effort 対応とみなす。
  it("accepts the 'opus[1m]' alias with a non-auto effort value", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opus1m.toml"), fullEnv),
    ).not.toThrow();
  });

  // Finding 3: effort 対応モデルでも xhigh 非対応モデル（Sonnet 4.6 等）では xhigh を拒否する。
  it("throws when xhigh effort is paired with a model that does not support xhigh", () => {
    expect(() =>
      loadConfig(fixture("config-effort-xhigh-unsupported.toml"), fullEnv),
    ).toThrow(/agent\.effort/);
  });

  // Finding 2: CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 でカスタムモデル/ゲートウェイの allowlist チェックをスキップする。
  it("does not throw for an unsupported model when CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 is set", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), {
        ...fullEnv,
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      }),
    ).not.toThrow();
  });

  // Finding 3: extra_args に --effort を含めると agent.effort（CLAUDE_CODE_EFFORT_LEVEL）に
  // 上書きされるため、重複設定はエラーとして拒否する。
  it("throws when extra_args contains --effort (conflicts with agent.effort env override)", () => {
    expect(() =>
      loadConfig(fixture("config-effort-extra-args-conflict.toml"), fullEnv),
    ).toThrow(/agent\.extra_args/);
  });

  // Finding 3 (equals syntax): extra_args に --effort=low のようなイコール構文も拒否する。
  it("throws when extra_args contains --effort=<level> (equals syntax conflicts with agent.effort env override)", () => {
    expect(() =>
      loadConfig(fixture("config-effort-extra-args-conflict-equals.toml"), fullEnv),
    ).toThrow(/agent\.extra_args/);
  });

  // Finding 4: ANTHROPIC_CUSTOM_MODEL_OPTION + _SUPPORTED_CAPABILITIES でカスタムモデルの
  // allowlist チェックをスキップする（Claude Code 公式 capability オーバーライド機構）。
  it("skips allowlist check when ANTHROPIC_CUSTOM_MODEL_OPTION matches and capabilities include effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-haiku-4-5-20251001",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).not.toThrow();
  });

  // Finding 4: ANTHROPIC_CUSTOM_MODEL_OPTION が model と一致しない場合はスキップしない。
  it("does not skip allowlist check when ANTHROPIC_CUSTOM_MODEL_OPTION does not match the config model", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "some-other-model",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 4: ANTHROPIC_DEFAULT_{X}_MODEL + _SUPPORTED_CAPABILITIES でピン留めデフォルトモデルの
  // allowlist チェックをスキップする（Claude Code 公式 capability オーバーライド機構）。
  it("skips allowlist check when ANTHROPIC_DEFAULT_{X}_MODEL matches and capabilities include effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).not.toThrow();
  });

  // Finding 4: ANTHROPIC_DEFAULT_{X}_MODEL が model と一致しない場合はスキップしない。
  it("does not skip allowlist check when ANTHROPIC_DEFAULT_{X}_MODEL does not match the config model", () => {
    expect(() =>
      loadConfig(fixture("config-effort-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "some-other-model",
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 3: "effort" のみ宣言されたカスタムモデルで effort 未指定のとき "max" ではなく "auto" をデフォルトにする。
  // ("effort" と "max_effort" は別 capability — "effort" だけの宣言では max は許可されない)
  it("defaults effort to 'auto' when capability declares only 'effort' (not 'max_effort')", () => {
    const config = loadConfig(fixture("config-effort-custom-no-effort.toml"), {
      ...fullEnv,
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-haiku-4-5-20251001",
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
    });
    expect(config.agent.effort).toBe("auto");
  });

  // Finding 3: "max_effort" が宣言されていれば "max" をデフォルトにする。
  it("defaults effort to 'max' when capability declares 'max_effort'", () => {
    const config = loadConfig(fixture("config-effort-custom-no-effort.toml"), {
      ...fullEnv,
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-haiku-4-5-20251001",
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort",
    });
    expect(config.agent.effort).toBe("max");
  });

  // Finding 1: Bedrock/Vertex/Foundry コンテキストで "sonnet" ベアエイリアス + 明示的 non-auto effort は拒否。
  it("throws when 'sonnet' bare alias is paired with explicit non-auto effort on a third-party provider", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet-alias.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 1: サードパーティプロバイダでも capability オーバーライドがあれば許可する。
  it("does not throw for 'sonnet' + explicit effort on a third-party provider when capability override exists", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet-alias.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_CUSTOM_MODEL_OPTION: "sonnet",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).not.toThrow();
  });

  // Finding 2: Bedrock/Vertex/Foundry コンテキストで "opus" ベアエイリアス + xhigh は拒否。
  it("throws when 'opus' bare alias is paired with xhigh on a third-party provider", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opus-xhigh.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_VERTEX: "1",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 2: "opus" + xhigh はサードパーティプロバイダなし（直接 API）では許可する。
  it("accepts 'opus' bare alias with xhigh when no third-party provider context is set", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opus-xhigh.toml"), fullEnv),
    ).not.toThrow();
  });

  // Finding 2: サードパーティプロバイダでも capability オーバーライドがあれば許可する。
  it("does not throw for 'opus' + xhigh on a third-party provider when capability override exists", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opus-xhigh.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_CUSTOM_MODEL_OPTION: "opus",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,xhigh_effort",
      }),
    ).not.toThrow();
  });

  // Finding 1 (opusplan): Bedrock/Vertex/Foundry コンテキストで "opusplan" ベアエイリアス +
  // 明示的 non-auto effort は拒否（実行フェーズで Sonnet を使用するため）。
  it("throws when 'opusplan' bare alias is paired with explicit non-auto effort on a third-party provider", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opusplan.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 1 (opusplan): サードパーティプロバイダでも capability オーバーライドがあれば許可する。
  it("does not throw for 'opusplan' + explicit effort on a third-party provider when capability override exists", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opusplan.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_CUSTOM_MODEL_OPTION: "opusplan",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).not.toThrow();
  });

  // Finding 2 (pinned alias): ANTHROPIC_DEFAULT_OPUS_MODEL でゲートウェイモデルにピン留めされた
  // "opus" エイリアスでも capability env var が読まれ、xhigh_effort 宣言があれば許可する。
  it("skips third-party xhigh check when ANTHROPIC_DEFAULT_OPUS_MODEL alias has xhigh_effort capability", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opus-xhigh.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "some-gateway-opus",
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,xhigh_effort",
      }),
    ).not.toThrow();
  });

  // Finding 3 (xhigh): "effort" のみ宣言されたカスタムモデルで xhigh を要求したときエラー。
  it("throws when a model with only 'effort' capability is paired with xhigh effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-xhigh-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-sonnet-4-6",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 3 (xhigh): "effort,xhigh_effort" を宣言したカスタムモデルで xhigh を要求したときは許可。
  it("does not throw when a model with 'effort,xhigh_effort' capability is paired with xhigh effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-xhigh-unsupported.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-sonnet-4-6",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,xhigh_effort",
      }),
    ).not.toThrow();
  });

  // Finding 3 (max): "effort" のみ宣言されたカスタムモデルで "max" を要求したときエラー。
  it("throws when a model with only 'effort' capability is paired with max effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-custom-max.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-haiku-4-5-20251001",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 3 (max): "effort,max_effort" を宣言したカスタムモデルで "max" を要求したときは許可。
  it("does not throw when a model with 'effort,max_effort' capability is paired with max effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-custom-max.toml"), {
        ...fullEnv,
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-haiku-4-5-20251001",
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort",
      }),
    ).not.toThrow();
  });

  // Finding 1: ANTHROPIC_DEFAULT_{X}_MODEL でベアエイリアスが別モデルにリマップされ、
  // _SUPPORTED_CAPABILITIES が宣言されていない場合は allowlist を信用せずエラーとする。
  it("throws when a supported alias is remapped via ANTHROPIC_DEFAULT_{X}_MODEL to an unknown model without capabilities", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet-alias.toml"), {
        ...fullEnv,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-gateway-sonnet-model",
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 1: _SUPPORTED_CAPABILITIES に "effort" が宣言されていれば、ピン留めモデルでも許可する。
  it("does not throw when a remapped alias has effort declared in ANTHROPIC_DEFAULT_{X}_MODEL_SUPPORTED_CAPABILITIES", () => {
    expect(() =>
      loadConfig(fixture("config-effort-sonnet-alias.toml"), {
        ...fullEnv,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-gateway-sonnet-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort",
      }),
    ).not.toThrow();
  });

  // Finding 2: "sonnet" ベアエイリアスで effort 未指定のとき、直接 Anthropic API（非サードパーティ）では "max" がデフォルト。
  it("defaults effort to 'max' for 'sonnet' alias when no effort is specified and no third-party provider is set", () => {
    const config = loadConfig(fixture("config-effort-sonnet-no-effort.toml"), fullEnv);
    expect(config.agent.effort).toBe("max");
  });

  // Finding 2: "sonnet" ベアエイリアスで effort 未指定のとき、サードパーティプロバイダでは "auto" がデフォルト。
  it("defaults effort to 'auto' for 'sonnet' alias when no effort is specified and a third-party provider is set", () => {
    const config = loadConfig(fixture("config-effort-sonnet-no-effort.toml"), {
      ...fullEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(config.agent.effort).toBe("auto");
  });

  // Finding 2: "opusplan" エイリアスで effort 未指定のとき、直接 Anthropic API では "max" がデフォルト。
  it("defaults effort to 'max' for 'opusplan' alias when no effort is specified and no third-party provider is set", () => {
    const config = loadConfig(fixture("config-effort-opusplan-no-effort.toml"), fullEnv);
    expect(config.agent.effort).toBe("max");
  });

  // Finding 2: "opusplan" エイリアスで effort 未指定のとき、サードパーティプロバイダでは "auto" がデフォルト。
  it("defaults effort to 'auto' for 'opusplan' alias when no effort is specified and a third-party provider is set", () => {
    const config = loadConfig(fixture("config-effort-opusplan-no-effort.toml"), {
      ...fullEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(config.agent.effort).toBe("auto");
  });

  // Finding 2 (opusplan phase-model): Bedrock/Vertex/Foundry で ANTHROPIC_DEFAULT_OPUS_MODEL と
  // ANTHROPIC_DEFAULT_SONNET_MODEL の両方が "effort" を宣言している場合、opusplan の non-auto effort を許可する。
  it("does not throw for 'opusplan' + explicit effort on third-party when both phase-model pins declare effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opusplan.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "bedrock-sonnet-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort",
      }),
    ).not.toThrow();
  });

  // Finding 2 (opusplan phase-model): 片方の phase-model しか effort を宣言していない場合は拒否する。
  it("throws for 'opusplan' + explicit effort on third-party when only one phase-model pin declares effort", () => {
    expect(() =>
      loadConfig(fixture("config-effort-opusplan.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort",
        // SONNET is missing
      }),
    ).toThrow(/agent\.effort/);
  });

  // Finding 2 (opusplan phase-model): effort 未指定のとき、両 phase-model が max_effort を宣言していれば "max" をデフォルトにする。
  it("defaults effort to 'max' for 'opusplan' on third-party when both phase-model pins declare max_effort", () => {
    const config = loadConfig(fixture("config-effort-opusplan-no-effort.toml"), {
      ...fullEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "bedrock-sonnet-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort",
    });
    expect(config.agent.effort).toBe("max");
  });

  // Finding 2 (opusplan phase-model): 両 phase-model が "effort" のみ宣言（max_effort なし）のとき effort 未指定なら "auto"。
  it("defaults effort to 'auto' for 'opusplan' on third-party when phase-model pins declare only 'effort' (no max_effort)", () => {
    const config = loadConfig(fixture("config-effort-opusplan-no-effort.toml"), {
      ...fullEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "bedrock-sonnet-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort",
    });
    expect(config.agent.effort).toBe("auto");
  });

  // ES-385: agent.permission_mode — 省略時は既定 "acceptEdits"
  it("defaults agent.permissionMode to 'acceptEdits' when permission_mode is omitted", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.agent.permissionMode).toBe("acceptEdits");
  });

  // ES-385: agent.permission_mode = "bypassPermissions" を明示的に設定
  it("reads agent.permissionMode when explicitly set to 'bypassPermissions'", () => {
    const config = loadConfig(fixture("config-permission-bypass.toml"), fullEnv);
    expect(config.agent.permissionMode).toBe("bypassPermissions");
  });

  // ES-385: 不正な permission_mode はエラー
  it("throws on an invalid permission_mode value", () => {
    expect(() =>
      loadConfig(fixture("config-permission-invalid.toml"), fullEnv),
    ).toThrow(/agent\.permission_mode/);
  });

  // ES-383: rate_limit セクション省略時の既定値
  it("defaults rateLimit when [rate_limit] section is omitted", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.rateLimit).toEqual({
      reprobeMinutes: 15,
      capHours: 6,
      claudePatterns: [],
      codexPatterns: [],
    });
  });

  it("reads explicit [rate_limit] values", () => {
    const config = loadConfig(fixture("config-rate-limit.toml"), fullEnv);
    expect(config.rateLimit).toEqual({
      reprobeMinutes: 5,
      capHours: 2,
      claudePatterns: [],
      codexPatterns: [],
    });
  });

  it("reads claude_patterns from [rate_limit]", () => {
    const config = loadConfig(fixture("config-rate-limit-custom.toml"), fullEnv);
    expect(config.rateLimit.claudePatterns).toEqual([
      "custom_429",
      "my_rate_limit_pattern",
    ]);
  });

  it("reads codex_patterns from [rate_limit]", () => {
    const config = loadConfig(fixture("config-rate-limit-codex.toml"), fullEnv);
    expect(config.rateLimit.codexPatterns).toEqual([
      "codex_quota",
      "openai_rate_limit",
    ]);
  });

  it("rejects invalid codex_patterns regex", () => {
    expect(() =>
      loadConfig(fixture("config-rate-limit-codex-invalid.toml"), fullEnv),
    ).toThrow(/rate_limit\.codex_patterns.*invalid regex/);
  });

  // notify.progress: 既定 false（未設定 or empty [notify]）
  it("defaults notify.progress to false when [notify] section is empty", () => {
    const config = loadConfig(fixture("config-valid.toml"), fullEnv);
    expect(config.notify.progress).toBe(false);
  });

  // notify.progress = true を明示的に設定
  it("reads notify.progress = true when explicitly set", () => {
    const config = loadConfig(fixture("config-notify-progress.toml"), fullEnv);
    expect(config.notify.progress).toBe(true);
  });

  // ES-382: select_diff_budget_chars defaults to 6000
  it("select_diff_budget_chars defaults to 6000", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.selectDiffBudgetChars).toBe(6000);
  });

  // ES-382: select_diff_budget_chars is configurable
  it("select_diff_budget_chars is configurable", () => {
    const config = loadConfig(fixture("config-select-diff-budget.toml"), fullEnv);
    expect(config.safety.selectDiffBudgetChars).toBe(10000);
  });

  // ES-451: v3 groom/memory config defaults
  it("defaults groom and memory config when sections are omitted", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.groom.enabled).toBe(true);
    expect(config.safety.groomTimeoutMinutes).toBe(10);
    expect(config.safety.groomBoardBudgetChars).toBe(10000);
    expect(config.memory.maxCharsPerFile).toBe(8000);
    expect(config.memory.injectBudgetChars).toBe(6000);
  });

  it("reads explicit [groom] and [memory] values", () => {
    const config = loadConfig(fixture("config-groom-memory.toml"), fullEnv);
    expect(config.groom.enabled).toBe(false);
    expect(config.safety.groomTimeoutMinutes).toBe(5);
    expect(config.safety.groomBoardBudgetChars).toBe(20000);
    expect(config.memory.maxCharsPerFile).toBe(4000);
    expect(config.memory.injectBudgetChars).toBe(3000);
  });

  // ES-477: design review safety config defaults
  it("provides defaults for design review safety keys", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.maxDesignReviewAttempts).toBe(2);
    expect(config.safety.designReviewTimeoutMinutes).toBe(15);
  });

  it("provides defaults for self-review safety keys (ES-473)", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.safety.selfReviewTimeoutMinutes).toBe(15);
    expect(config.safety.maxCostUsdPerSelfReview).toBe(2);
  });

  // ES-486: per-phase model/effort config

  it("pm is undefined when [pm] section is omitted (backward compat)", () => {
    const config = loadConfig(fixture("config-valid.toml"), fullEnv);
    expect(config.pm).toBeUndefined();
  });

  it("pm defaults model to gpt-5.5 when [pm] is present but model is omitted; effort fields are undefined without [pm.effort]", () => {
    const config = loadConfig(fixture("config-per-phase-pm-minimal.toml"), fullEnv);
    expect(config.pm).toBeDefined();
    expect(config.pm!.model).toBe("gpt-5.5");
    expect(config.pm!.effort.groom).toBeUndefined();
    expect(config.pm!.effort.select).toBeUndefined();
    expect(config.pm!.effort.designReview).toBeUndefined();
    expect(config.pm!.effort.recovery).toBeUndefined();
  });

  it("reads explicit [pm] section with per-phase effort", () => {
    const config = loadConfig(fixture("config-per-phase.toml"), fullEnv);
    expect(config.pm).toBeDefined();
    expect(config.pm!.model).toBe("gpt-5.5");
    expect(config.pm!.effort.groom).toBe("high");
    expect(config.pm!.effort.select).toBe("medium");
    expect(config.pm!.effort.designReview).toBe("high");
    expect(config.pm!.effort.recovery).toBe("high");
  });

  it("reads per-phase agent overrides", () => {
    const config = loadConfig(fixture("config-per-phase.toml"), fullEnv);
    expect(config.agent.design!.model).toBe("claude-opus-4-8[1m]");
    expect(config.agent.design!.effort).toBe("max");
    expect(config.agent.implement!.model).toBe("claude-opus-4-6[1m]");
    expect(config.agent.implement!.effort).toBe("high");
    expect(config.agent.selfReview!.model).toBe("claude-opus-4-8[1m]");
    expect(config.agent.selfReview!.effort).toBe("max");
    expect(config.agent.recovery!.model).toBe("claude-sonnet-4-6");
    expect(config.agent.recovery!.effort).toBe("high");
  });

  it("falls back to agent.model/effort when per-phase keys are absent", () => {
    const config = loadConfig(fixture("config-per-phase-partial.toml"), fullEnv);
    expect(config.agent.design!.model).toBe("claude-opus-4-8[1m]");
    expect(config.agent.implement).toBeUndefined();
    expect(config.agent.selfReview).toBeUndefined();
    expect(config.agent.recovery).toBeUndefined();
  });

  it("per-phase agent block with only model inherits global effort", () => {
    const config = loadConfig(fixture("config-per-phase-model-only.toml"), fullEnv);
    expect(config.agent.design!.model).toBe("claude-opus-4-8[1m]");
    expect(config.agent.design!.effort).toBe("high"); // inherited from agent.effort
  });

  it("rejects codex effort 'max' (only low/medium/high allowed)", () => {
    expect(() => loadConfig(fixture("config-per-phase-codex-max.toml"), fullEnv))
      .toThrow(/pm\.effort\.groom.*max/);
  });

  it("rejects per-phase agent effort for non-effort-supporting model", () => {
    expect(() => loadConfig(fixture("config-per-phase-bad-model.toml"), fullEnv))
      .toThrow(/agent\.recovery\.effort.*does not support effort/);
  });

  // ES-486 (review fix): per-phase 'sonnet' bare alias + explicit non-auto effort on third-party provider.
  it("throws when per-phase 'sonnet' alias is paired with explicit non-auto effort on a third-party provider", () => {
    expect(() =>
      loadConfig(fixture("config-per-phase-sonnet-alias.toml"), {
        ...fullEnv,
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toThrow(/agent\.recovery\.effort/);
  });

  // ES-486 (review fix): per-phase 'sonnet' alias with non-auto effort is allowed on direct Anthropic API.
  it("accepts per-phase 'sonnet' alias with non-auto effort when no third-party provider is set", () => {
    expect(() =>
      loadConfig(fixture("config-per-phase-sonnet-alias.toml"), fullEnv),
    ).not.toThrow();
  });

  // ES-487: verify config
  it("new safety/verify/linear keys get defaults from config-valid.toml (no new keys present)", () => {
    const config = loadConfig(fixture("config-valid.toml"), fullEnv);
    // safety defaults
    expect(config.safety.maxVerifyAttempts).toBe(2);
    expect(config.safety.maxCostUsdPerVerify).toBe(2);
    expect(config.safety.verifyTimeoutMinutes).toBe(15);
    expect(config.safety.maxRecoveryAttempts).toBe(2);
    expect(config.safety.transientRetryAttempts).toBe(2);
    // verify defaults
    expect(config.verify.enabled).toBe(true);
    expect(config.verify.runRecipe).toBe("");
    // linear defaults
    expect(config.linear.needsHumanLabel).toBe("needs-human");
    // agent.verify is undefined when not specified
    expect(config.agent.verify).toBeUndefined();
  });

  it("reads per-phase agent.verify override", () => {
    const config = loadConfig(fixture("config-per-phase-verify.toml"), fullEnv);
    expect(config.agent.verify!.model).toBe("claude-opus-4-8[1m]");
    expect(config.agent.verify!.effort).toBe("max");
  });

  it("reads pm.effort.verify", () => {
    const config = loadConfig(fixture("config-per-phase-verify.toml"), fullEnv);
    expect(config.pm!.effort.verify).toBe("high");
  });

  it("rejects codex verify effort 'max' (only low/medium/high allowed)", () => {
    expect(() => loadConfig(fixture("config-per-phase-codex-max.toml"), fullEnv))
      .toThrow(/pm\.effort\.verify.*max/);
  });

  it("pm.effort.merge_gate に不正値を渡すと値入りのエラーメッセージで落ちる", () => {
    expect(() => loadConfig(fixture("config-per-phase-codex-merge-gate-max.toml"), fullEnv))
      .toThrow(/pm\.effort\.merge_gate: "ultra" is not a valid Codex effort level/);
  });

  it("pm.effort.merge_gate の既定は high", () => {
    const config = loadConfig(fixture("config-per-phase-merge-gate.toml"), fullEnv);
    expect(config.pm?.effort.mergeGate).toBe("high");
  });

  it("reads explicit verify/safety/linear values from config-per-phase-verify fixture", () => {
    const config = loadConfig(fixture("config-per-phase-verify.toml"), fullEnv);
    expect(config.verify.enabled).toBe(false);
    expect(config.verify.runRecipe).toBe("npm run e2e");
    expect(config.safety.maxVerifyAttempts).toBe(3);
    expect(config.safety.maxCostUsdPerVerify).toBe(1.5);
    expect(config.safety.verifyTimeoutMinutes).toBe(10);
    expect(config.safety.maxRecoveryAttempts).toBe(3);
    expect(config.safety.transientRetryAttempts).toBe(1);
    expect(config.linear.needsHumanLabel).toBe("needs-human-custom");
  });

  describe("scout config (ES-516)", () => {
    it("applies scout defaults when [scout] and label keys are omitted", () => {
      const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
      expect(config.scout.enabled).toBe(false);
      expect(config.scout.idleMinutes).toBe(30);
      expect(config.scout.minIntervalHours).toBe(24);
      expect(config.scout.maxIssuesPerScout).toBe(3);
      expect(config.linear.scoutLabel).toBe("scout");
      expect(config.linear.scoutTriageLabel).toBe("scout-triage");
      expect(config.safety.maxCostUsdPerScout).toBe(2);
    });

    it("loads explicit scout keys and maps snake_case to camelCase", () => {
      const config = loadConfig(fixture("config-scout.toml"), fullEnv);
      expect(config.scout.enabled).toBe(true);
      expect(config.scout.idleMinutes).toBe(15);
      expect(config.scout.minIntervalHours).toBe(12);
      expect(config.scout.maxIssuesPerScout).toBe(1);
      expect(config.linear.scoutLabel).toBe("bug-scout");
      expect(config.linear.scoutTriageLabel).toBe("bug-scout-triage");
      expect(config.safety.maxCostUsdPerScout).toBe(1.5);
    });

    it("rejects unknown keys in [scout] (strict schema)", () => {
      expect(() =>
        loadConfig(fixture("config-scout-unknown-key.toml"), fullEnv),
      ).toThrow(/scout/);
    });

    it("fills zod defaults for keys omitted from a partial [scout] section", () => {
      const config = loadConfig(fixture("config-scout-partial.toml"), fullEnv);
      expect(config.scout.enabled).toBe(true);
      expect(config.scout.idleMinutes).toBe(30);
      expect(config.scout.minIntervalHours).toBe(24);
      expect(config.scout.maxIssuesPerScout).toBe(3);
    });
  });

  // ES-519: SCOUT 専用 per-phase ブロック [agent.scout] + safety.scout_timeout_minutes
  it("throws when extra_args contains --allowedTools (silently overrides per-phase tool restrictions)", () => {
    expect(() =>
      loadConfig(fixture("config-extra-args-allowed-tools.toml"), fullEnv),
    ).toThrow(/agent\.extra_args.*--allowedTools/);
  });

  describe("agent.scout (ES-519)", () => {
    it("resolves [agent.scout] with explicit model/effort/allowed_tools", () => {
      const config = loadConfig(fixture("config-agent-scout.toml"), fullEnv);
      expect(config.agent.scout).toEqual({
        model: "opus",
        effort: "low",
        allowedTools: "Read,Bash",
      });
      expect(config.safety.scoutTimeoutMinutes).toBe(45);
    });

    it("agent.scout is undefined when the block is absent; scout_timeout_minutes defaults to 30", () => {
      const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
      expect(config.agent.scout).toBeUndefined();
      expect(config.safety.scoutTimeoutMinutes).toBe(30);
    });

    it("empty [agent.scout] block falls back to agent model/effort and SCOUT_DEFAULT_ALLOWED_TOOLS", () => {
      const config = loadConfig(fixture("config-agent-scout-partial.toml"), fullEnv);
      expect(config.agent.scout!.model).toBe("opus");
      expect(config.agent.scout!.effort).toBe(config.agent.effort);
      expect(config.agent.scout!.allowedTools).toBe(SCOUT_DEFAULT_ALLOWED_TOOLS);
    });

    it("rejects invalid model/effort combination in [agent.scout] via validatePhaseModelEffort", () => {
      expect(() =>
        loadConfig(fixture("config-agent-scout-bad-model.toml"), fullEnv),
      ).toThrow(/agent\.scout/);
    });

    it("rejects unknown keys in [agent.scout] (strict schema)", () => {
      expect(() =>
        loadConfig(fixture("config-agent-scout-unknown-key.toml"), fullEnv),
      ).toThrow();
    });
  });
});
