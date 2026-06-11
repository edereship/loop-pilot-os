import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";

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

    expect(config.loop.monitorPollSeconds).toBe(60);
    expect(config.loop.idleRecheckSeconds).toBe(300);

    expect(config.digest.recentMergedCount).toBe(5);

    expect(config.slackWebhookUrl).toBe(
      "https://hooks.slack.com/services/T/B/X",
    );
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
  // monitor_timeout_minutes=undefined, not_engaged_guard_minutes=30）。
  it("applies defaults for omitted optional keys", () => {
    const config = loadConfig(fixture("config-minimal.toml"), fullEnv);
    expect(config.repo.defaultBranch).toBe("main");
    expect(config.agent.extraArgs).toEqual([]);
    expect(config.agent.effort).toBe("max");
    expect(config.safety.monitorTimeoutMinutes).toBeUndefined();
    expect(config.safety.notEngagedGuardMinutes).toBe(30);
    expect(config.safety.sessionHardTimeoutMinutes).toBe(120); // 省略時の既定
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

  // 仕様 §8: 必須キー欠落（[product].goal が無い）→ 該当パスを message に出す。
  it("throws listing the missing required key", () => {
    expect(() =>
      loadConfig(fixture("config-missing-required.toml"), fullEnv),
    ).toThrow(/product\.goal/);
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
    // [product].goal 欠落（zod 由来）と LINEAR_API_KEY 欠落（env 由来）の両方が同じ message に出る。
    expect(message).toContain("product.goal");
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
});
