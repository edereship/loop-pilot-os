import { describe, it, expect } from "vitest";
import { runPreflight, normalizeRemote } from "../src/preflight.js";
import { FakeCommandRunner } from "./fakes.js";
import type { Notifier, NotifyEvent, TicketState } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FetchFn } from "../src/task-source.js";

// Windows では npm CLI が .cmd shim 経由になる（codex-planner.ts の CODEX_COMMAND と同一規則）
const CODEX_CMD = process.platform === "win32" ? "codex.cmd" : "codex";

// ---- テスト用の最小 Config（config.ts §の Config 形・camelCase は解決済みの形） ----
function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    product: { goal: "ship it", specDir: undefined },
    repo: {
      path: "/abs/repo",
      remote: "owner/name",
      defaultBranch: "main",
      worktreeRoot: "/home/u/.looppilot-os/worktrees/repo",
    },
    linear: {
      team: "TY",
      project: "LoopPilot OS",
      optInLabel: "ai-ok",
      needsHumanLabel: "needs-human",
      scoutLabel: "scout",
      scoutTriageLabel: "scout-triage",
      states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" },
    },
    agent: { model: "opus", effort: "max", permissionMode: "acceptEdits", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [], design: undefined, implement: undefined, selfReview: undefined, recovery: undefined, verify: undefined, scout: undefined },
    pm: undefined,
    handoff: { branchPrefix: "looppilot", prBodyTemplate: "Implements {identifier}" },
    looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]"] },
    safety: {
      maxTasksPerRun: 3,
      maxAbandonsPerRun: 3,
      maxCostUsdPerSession: 10,
      monitorTimeoutMinutes: 60,
      notEngagedGuardMinutes: 30,
      sessionHardTimeoutMinutes: 120,
      maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2,
      codexTimeoutMinutes: 30,
      designTimeoutMinutes: 15,
      maxCostUsdPerDesign: 2,
      designReviewTimeoutMinutes: 15,
      maxDesignReviewAttempts: 2,
      selectDiffBudgetChars: 6000,
      selectCodebaseSummaryBudgetChars: 5000,
      groomTimeoutMinutes: 10,
      groomBoardBudgetChars: 10000,
      selfReviewTimeoutMinutes: 15,
      maxCostUsdPerSelfReview: 2,
      maxVerifyAttempts: 2,
      maxCostUsdPerVerify: 2,
      verifyTimeoutMinutes: 15,
      maxRecoveryAttempts: 2,
      transientRetryAttempts: 2,
      mergeGateTimeoutMinutes: 15,
      maxMergeGateFixAttempts: 2,
      maxCostUsdPerMergeGateFix: 2,
      maxCostUsdPerScout: 2,
      scoutTimeoutMinutes: 30,
      scoutReviewTimeoutMinutes: 15,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300, idleTimeoutMinutes: 120 },
    digest: { recentMergedCount: 5, enabled: true },
    notify: { progress: false },
    groom: { enabled: true },
    mergeGate: { enabled: true },
    selfReview: { enabled: true },
    memory: { maxCharsPerFile: 8000, injectBudgetChars: 6000 },
    verify: { enabled: true, runRecipe: "" },
    scout: { enabled: false, idleMinutes: 30, minIntervalHours: 24, maxIssuesPerScout: 3 },
    rateLimit: { reprobeMinutes: 15, capHours: 6, claudePatterns: [], codexPatterns: [] },
    linearApiKey: "lin_api_test",
    slackWebhookUrl: undefined,
    stateDbPath: "/abs/repo/looppilot-os.db",
  };
  return { ...base, ...overrides };
}

// ---- すべて合格になるよう FakeCommandRunner を仕込むヘルパ（カーネル §9 の各コマンド） ----
function passingRunner(): FakeCommandRunner {
  const r = new FakeCommandRunner();
  // §9.2: クリーンな defaultBranch 上
  r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "main\n", stderr: "" });
  r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: "", stderr: "" });
  // §9.3: remote 到達
  r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 0, stdout: "deadbeef\tHEAD\n", stderr: "" });
  // ES-415: origin URL が repo.remote と一致
  r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
  // ES-415: push URL（pushurl 未設定時は fetch URL と同じ）
  r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
  // §9.4: gh 認証
  r.on(["gh", "auth", "status"], { code: 0, stdout: "Logged in", stderr: "" });
  // §9.4: push 権限
  r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "true\n", stderr: "" });
  // §9.4: 認証ユーザー名（restrictions の許可リスト照合に使う）
  r.on(["gh", "api", "user", "--jq", ".login"], { code: 0, stdout: "the-bot\n", stderr: "" });
  // §9.4: ブランチ保護なし → 404
  r.on(["gh", "api", "repos/owner/name/branches/main/protection"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.4: required_signatures 設定なし → 404（保護が存在する場合に呼ばれる別エンドポイント）
  r.on(["gh", "api", "repos/owner/name/branches/main/protection/required_signatures"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.4: rulesets 空配列（保護なし）
  r.on(["gh", "api", "repos/owner/name/rules/branches/main"], { code: 0, stdout: "[]\n", stderr: "" });
  // §9.5: gate_label がリポラベルに存在
  r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nloop-pilot\nai-ok\n", stderr: "" });
  // §9.6: AUTO_MERGE 未設定 → 404
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.9: STATE_COMMENT_AUTHORS 未設定 → 404（リポ既定 github-actions[bot]）
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.8: claude 起動可 + 認証済み
  r.on(["claude", "--version"], { code: 0, stdout: "2.1.165 (Claude Code)\n", stderr: "" });
  r.on(["claude", "auth", "status", "--json"], { code: 0, stdout: '{"loggedIn":true}\n', stderr: "" });
  // ES-498: codex 起動可 + 認証済み（Linux の bwrap probe も portable にスタブ）
  r.on([CODEX_CMD, "--version"], { code: 0, stdout: "codex-cli 0.137.0\n", stderr: "" });
  r.on([CODEX_CMD, "login", "status"], { code: 0, stdout: "", stderr: "" });
  r.on(["bwrap", "--version"], { code: 0, stdout: "bwrap 0.8.0\n", stderr: "" });
  return r;
}

// resolveLinearSetup は 2段階で Linear GraphQL を叩く:
// (1) viewer + team keys (2) 対象 team の詳細 + workspace labels。
// FetchFn の戻り値は { ok, status, json() }。Web Response ではない。
function passingFetch(): FetchFn {
  const viewerBody = {
    data: {
      viewer: { id: "user-1", name: "Viewer" },
      teams: { nodes: [{ id: "team-1", key: "TY" }] },
    },
  };
  const teamBody = {
    data: {
      team: {
        id: "team-1",
        key: "TY",
        states: {
          nodes: [
            { id: "st-todo", name: "Todo" },
            { id: "st-prog", name: "In Progress" },
            { id: "st-rev", name: "In Review" },
            { id: "st-done", name: "Done" },
          ],
        },
        labels: { nodes: [{ id: "lb-1", name: "ai-ok" }, { id: "lb-2", name: "needs-human" }], pageInfo: { hasNextPage: false, endCursor: null } },
        projects: { nodes: [{ id: "proj-1", name: "LoopPilot OS" }] },
      },
      issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
  const bodies = [viewerBody, teamBody];
  let i = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => bodies[Math.min(i++, bodies.length - 1)],
  });
}

const passingNotifier: Notifier = {
  notify: async (_e: NotifyEvent) => {},
  probeReachability: async () => {},
};

describe("runPreflight", () => {
  // 仕様 §9.2 / §8: repo はクリーンな git で default_branch 上であること。
  it("default_branch 以外で起動すると NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "feature-x\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("feature-x") && e.includes("default_branch"))).toBe(true);
  });

  it("作業ツリーがダーティなら NG（仕様 §9.2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M src/a.ts\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
  });

  // ES-512 Finding 1: allowDirtyCheckout=true はブランチチェック・ダーティチェック両方をスキップする。
  // checkout_dirty が設定された後の次回起動時、HEAD が detached または別ブランチである可能性があるため、
  // orchestrator の startup cleanup（git rebase --abort + git reset --hard）が実行できるよう
  // 両チェックをスキップしてプリフライトを通過させる。
  it("allowDirtyCheckout=true のとき detached HEAD でもブランチエラーを出さない（ES-512 Finding 1）", async () => {
    const r = passingRunner();
    // Detached HEAD: rev-parse --abbrev-ref HEAD returns "HEAD"
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "HEAD\n", stderr: "" });
    const errors = await runPreflight({
      config: makeConfig(),
      runner: r,
      notifier: passingNotifier,
      fetchFn: passingFetch(),
      allowDirtyCheckout: true,
    });
    expect(errors.filter((e) => e.includes("default_branch") || e.includes("HEAD"))).toEqual([]);
  });

  it("allowDirtyCheckout=true のとき別ブランチでもブランチエラーを出さない（ES-512 Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "some-feature-branch\n", stderr: "" });
    const errors = await runPreflight({
      config: makeConfig(),
      runner: r,
      notifier: passingNotifier,
      fetchFn: passingFetch(),
      allowDirtyCheckout: true,
    });
    expect(errors.filter((e) => e.includes("default_branch") || e.includes("some-feature-branch"))).toEqual([]);
  });

  it("allowDirtyCheckout=true のときダーティな作業ツリーでもエラーを出さない（ES-512 Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "HEAD\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M src/a.ts\n", stderr: "" });
    const errors = await runPreflight({
      config: makeConfig(),
      runner: r,
      notifier: passingNotifier,
      fetchFn: passingFetch(),
      allowDirtyCheckout: true,
    });
    expect(errors.filter((e) => e.includes("クリーンではありません") || e.includes("default_branch"))).toEqual([]);
  });

  it("remote 到達不可なら NG（仕様 §9.3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "ls-remote", "origin", "HEAD"], { code: 128, stdout: "", stderr: "fatal: could not read from remote" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("到達できません"))).toBe(true);
  });

  it("gh 認証されていなければ NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "auth", "status"], { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("認証されていません"))).toBe(true);
  });

  it("push 権限が false なら NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
  });

  it("ブランチ保護なし（404）は OK 判定（仕様 §9.4）", async () => {
    // passingRunner はすでに protection=404, rulesets=[] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("必須承認レビュー") || e.includes("restrictions"))).toEqual([]);
  });

  it("required_approving_review_count>0 のブランチ保護は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("必須承認レビュー数") && e.includes("1"))).toBe(true);
  });

  it("restrictions に認証ユーザーが含まれていれば OK（仕様 §9.4・カーネル『含むときのみ OK』）", async () => {
    const r = passingRunner();
    // 認証ユーザーは the-bot（passingRunner の gh api user 応答）。restrictions.users に the-bot を含める。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "the-bot" }, { login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    // restrictions があっても認証ユーザーが許可リストに居る → ブランチ由来エラーなし。
    expect(errors.filter((e) => e.includes("restrictions") || e.includes("必須承認レビュー"))).toEqual([]);
  });

  it("restrictions に認証ユーザーが不在なら NG（仕様 §9.4・カーネル『不在のみ NG』）", async () => {
    const r = passingRunner();
    // 認証ユーザー the-bot が restrictions.users に居ない → NG。
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "someone-else" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("restrictions") && e.includes("the-bot"))).toBe(true);
  });

  it("rulesets が空配列なら OK（仕様 §9.4）", async () => {
    // passingRunner は rules/branches/main = [] を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ルールセット"))).toEqual([]);
  });

  it("rulesets の pull_request ルールで required_approving_review_count>0 は NG（仕様 §9.4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 2 } }]),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ルールセット") && e.includes("2"))).toBe(true);
  });

  it("required_pull_request_reviews が設定されていて restrictions が null なら直接プッシュ不可として NG（ES-452 Finding 5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: null,
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("required_pull_request_reviews") && e.includes("restrictions"))).toBe(true);
  });

  it("rulesets の pull_request ルールで required_approving_review_count=0 でも直接プッシュ不可として NG（ES-452 Finding 5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 0 } }]),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("pull_request ルール") && e.includes("直接プッシュ"))).toBe(true);
  });

  it("required_pull_request_reviews + restrictions あり + bypass_pull_request_allowances に認証ユーザー不在 → NG（ES-452 Finding 4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: { users: [{ login: "the-bot" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("bypass_pull_request_allowances") && e.includes("the-bot"))).toBe(true);
  });

  it("required_pull_request_reviews + restrictions あり + bypass_pull_request_allowances に認証ユーザーあり → OK（ES-452 Finding 4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          bypass_pull_request_allowances: { users: [{ login: "the-bot" }], teams: [], apps: [] },
        },
        restrictions: { users: [{ login: "the-bot" }], teams: [], apps: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("bypass_pull_request_allowances") || e.includes("restrictions"))).toEqual([]);
  });

  it("required_status_checks が設定されていれば直接プッシュ不可として NG（ES-452 Finding 5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_status_checks: { contexts: ["ci/tests"], checks: [] },
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("required_status_checks") && e.includes("直接プッシュ"))).toBe(true);
  });

  it("required_signatures が有効なら直接プッシュ不可として NG（ES-452 Finding 3）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({}),
      stderr: "",
    });
    // required_signatures は GET /branches/{branch}/protection ではなく専用エンドポイントで確認する
    r.on(["gh", "api", "repos/owner/name/branches/main/protection/required_signatures"], {
      code: 0,
      stdout: JSON.stringify({ enabled: true }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("required_signatures") && e.includes("直接プッシュ"))).toBe(true);
  });

  it("ルールセット pull_request ルール（count=0）に bypass_actors として認証ユーザーが含まれていれば OK（ES-452 Finding 6）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", ruleset_id: 42, parameters: { required_approving_review_count: 0 } }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/42"], {
      code: 0,
      stdout: JSON.stringify({
        bypass_actors: [{ actor_id: 123, actor_type: "User", bypass_mode: "always" }],
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("pull_request ルール"))).toEqual([]);
  });

  it("ルールセット pull_request ルール（count=0）の bypass_actors に認証ユーザーが不在なら NG（ES-452 Finding 6）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", ruleset_id: 42, parameters: { required_approving_review_count: 0 } }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "999\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/42"], {
      code: 0,
      stdout: JSON.stringify({
        bypass_actors: [{ actor_id: 123, actor_type: "User", bypass_mode: "always" }],
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("pull_request ルール") && e.includes("直接プッシュ"))).toBe(true);
  });

  it("required_pull_request_reviews + restrictions=null + bypass_pull_request_allowances に認証ユーザーあり → OK（ES-452 Finding 2）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          bypass_pull_request_allowances: { users: [{ login: "the-bot" }], teams: [], apps: [] },
        },
        restrictions: null,
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("required_pull_request_reviews") && e.includes("restrictions"))).toEqual([]);
  });

  it("required_pull_request_reviews + restrictions=null + team bypass のみで認証ユーザー不在 → NG（ES-452 Finding 2）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 0,
      stdout: JSON.stringify({
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          bypass_pull_request_allowances: { users: [], teams: [{ slug: "devs" }], apps: [] },
        },
        restrictions: null,
      }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    // チームバイパスはプリフライト時に所属確認できないためフェイルクローズ
    expect(errors.some((e) => e.includes("required_pull_request_reviews") && e.includes("restrictions"))).toBe(true);
  });

  it("ルールセット required_status_checks ルールが存在しバイパスなし → NG（ES-452 Finding 3）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "required_status_checks", ruleset_id: 99 }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/99"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("required_status_checks") && e.includes("ルールセット"))).toBe(true);
  });

  it("ルールセット required_status_checks ルールが存在しユーザーバイパスあり → OK（ES-452 Finding 3）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "required_status_checks", ruleset_id: 99 }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/99"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [{ actor_id: 123, actor_type: "User", bypass_mode: "always" }] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("required_status_checks") && e.includes("ルールセット"))).toEqual([]);
  });

  it("ルールセット required_signatures ルールが存在しバイパスなし → NG（ES-452 Finding 4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "required_signatures", ruleset_id: 77 }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/77"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("required_signatures") && e.includes("ルールセット"))).toBe(true);
  });

  it("ルールセット required_signatures ルールが存在しユーザーバイパスあり → OK（ES-452 Finding 4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "required_signatures", ruleset_id: 77 }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/77"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [{ actor_id: 123, actor_type: "User", bypass_mode: "always" }] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("required_signatures") && e.includes("ルールセット"))).toEqual([]);
  });

  it("ルールセット pull_request ルール（count=0）に OrganizationAdmin バイパスのみで認証ユーザー不在 → NG（ES-452 Finding 5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", ruleset_id: 42, parameters: { required_approving_review_count: 0 } }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/42"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    // 非 User バイパスはプリフライト時に所属確認できないためフェイルクローズ
    expect(errors.some((e) => e.includes("pull_request ルール") && e.includes("直接プッシュ"))).toBe(true);
  });

  it("ルールセット pull_request ルール（count=0）に bypass_mode=exempt のバイパスがあれば OK（ES-452 Finding 4）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 0,
      stdout: JSON.stringify([{ type: "pull_request", ruleset_id: 42, parameters: { required_approving_review_count: 0 } }]),
      stderr: "",
    });
    r.on(["gh", "api", "user", "--jq", ".id"], { code: 0, stdout: "123\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/rulesets/42"], {
      code: 0,
      stdout: JSON.stringify({ bypass_actors: [{ actor_id: 123, actor_type: "User", bypass_mode: "exempt" }] }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("pull_request ルール"))).toEqual([]);
  });

  it("gate_label がリポに無ければ NG（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ゲートラベル") && e.includes("loop-pilot"))).toBe(true);
  });

  it("gate_label は大小無視で照合する（仕様 §9.5）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "Loop-Pilot\nai-ok\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ゲートラベル"))).toEqual([]);
  });

  it("LOOPPILOT_AUTO_MERGE variable 404 は OK 判定（仕様 §9.6）", async () => {
    // passingRunner は variable=404 を仕込んでおり合格する。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toEqual([]);
  });

  it("LOOPPILOT_AUTO_MERGE が 'true'（大小無視）なら NG（仕様 §9.6）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_AUTO_MERGE", value: "TRUE" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE") && e.includes("唯一のマージャー"))).toBe(true);
  });

  it("STATE_COMMENT_AUTHORS variable 404 で config が github-actions[bot] を含めば OK（仕様 §9.9）", async () => {
    // passingRunner は variable=404、config は ["github-actions[bot]"] → R ⊆ C 成立。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("state_comment_authors") || e.includes("monitor_never_engaged"))).toEqual([]);
  });

  it("R ⊄ C（リポ writer を config が包含しない）なら NG（仕様 §9.9）", async () => {
    const r = passingRunner();
    // リポは bot-machine も writer に使うが、config は github-actions[bot] のみ → 欠落。
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ name: "LOOPPILOT_STATE_COMMENT_AUTHORS", value: "github-actions[bot], bot-machine" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("bot-machine") && e.includes("monitor_never_engaged"))).toBe(true);
  });

  it("config が R を包含すれば余分な信頼著者があっても OK（R ⊆ C; 仕様 §9.9）", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], {
      code: 0,
      stdout: JSON.stringify({ value: "github-actions[bot]" }),
      stderr: "",
    });
    const cfg = makeConfig({
      looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]", "extra-bot"] },
    });
    const errors = await runPreflight({ config: cfg, runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("monitor_never_engaged"))).toEqual([]);
  });

  it("Linear 解決が失敗すると NG（仕様 §9.7）", async () => {
    // team が見つからない応答 → resolveLinearSetup は throw する契約（task-source.ts）。
    const failFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: "user-1", name: "Viewer" },
          teams: { nodes: [] },
          issueLabels: { nodes: [] },
        },
      }),
    });
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: failFetch });
    expect(errors.some((e) => e.includes("Linear"))).toBe(true);
  });

  it("Linear 解決が成功すれば Linear 由来エラーなし（仕様 §9.7）", async () => {
    // passingFetch は viewer/team/project/states/label をすべて解決できる応答を返す。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Linear"))).toEqual([]);
  });

  it("scout.enabled=true かつ ANTHROPIC_API_KEY 未設定時は scout ラベル未登録でも Linear エラーにならない（ES-535）", async () => {
    // passingFetch には scout ラベルが含まれない。scout.enabled=true のまま API キーを除去し、
    // SCOUT が実効的に無効化されるため scout ラベルの解決が不要になることを確認する。
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cfg = makeConfig({
        scout: { enabled: true, idleMinutes: 30, minIntervalHours: 24, maxIssuesPerScout: 3 },
      });
      const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("Linear"))).toEqual([]);
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
    }
  });

  it("claude が起動できないと NG（仕様 §9.8）", async () => {
    const r = passingRunner();
    r.on(["claude", "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude") && e.includes("起動できません"))).toBe(true);
  });

  it("claude auth status が非ゼロ終了なら NG（ES-416: コマンド失敗）", async () => {
    const r = passingRunner();
    r.on(["claude", "auth", "status", "--json"], { code: 1, stdout: "", stderr: "auth subcommand failed" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude") && e.includes("認証状態を取得できません"))).toBe(true);
  });

  it("claude がログアウト状態なら NG（ES-416: loggedIn:false）", async () => {
    const r = passingRunner();
    r.on(["claude", "auth", "status", "--json"], { code: 0, stdout: '{"loggedIn":false}\n', stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude") && e.includes("認証されていません"))).toBe(true);
  });

  it("claude がログアウト状態（exit 1 + loggedIn:false）でも認証 remediation を返す（ES-416: 公式 CLI は未ログイン時 exit 1）", async () => {
    const r = passingRunner();
    // 公式リファレンス: ログイン時 exit 0 / 未ログイン時 exit 1。exit code ではなく
    // stdout の loggedIn で判定するため、「認証状態を取得できません」ではなく remediation を返す。
    r.on(["claude", "auth", "status", "--json"], { code: 1, stdout: '{"loggedIn":false}\n', stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude") && e.includes("認証されていません"))).toBe(true);
    expect(errors.some((e) => e.includes("認証状態を取得できません"))).toBe(false);
  });

  it("claude auth status の出力がパース不能なら NG（ES-416: 判定不能）", async () => {
    const r = passingRunner();
    r.on(["claude", "auth", "status", "--json"], { code: 0, stdout: "not json\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude") && e.includes("認証状態を判定できません"))).toBe(true);
  });

  it("Slack Webhook が非2xxなら NG（仕様 §9.10）", async () => {
    const failingNotifier: Notifier = {
      notify: async () => {},
      probeReachability: async () => {
        throw new Error("HTTP 500 from webhook");
      },
    };
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: failingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("Slack") && e.includes("HTTP 500"))).toBe(true);
  });

  it("Slack 未設定（probeReachability 即 resolve）なら Slack 由来エラーなし（仕様 §9.10）", async () => {
    // passingNotifier.probeReachability は即 resolve（未設定相当）。
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("Slack"))).toEqual([]);
  });

  // ES-385: bypassPermissions + root (uid 0) → NG
  it("bypassPermissions + root 実行は NG（ES-385 非 root preflight）", async () => {
    const cfg = makeConfig({
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [], design: undefined, implement: undefined, selfReview: undefined, recovery: undefined, verify: undefined, scout: undefined },
    });
    const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch(), getuid: () => 0 });
    expect(errors.some((e) => e.includes("root") && e.includes("bypassPermissions"))).toBe(true);
  });

  // ES-385: bypassPermissions + 非 root → OK
  it("bypassPermissions + 非 root は OK（ES-385）", async () => {
    const cfg = makeConfig({
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [], design: undefined, implement: undefined, selfReview: undefined, recovery: undefined, verify: undefined, scout: undefined },
    });
    const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch(), getuid: () => 1000 });
    expect(errors.filter((e) => e.includes("root"))).toEqual([]);
  });

  // ES-385: acceptEdits + root → root チェックしない（bypassPermissions 以外はスキップ）
  it("acceptEdits + root は root チェックしない（ES-385）", async () => {
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch(), getuid: () => 0 });
    expect(errors.filter((e) => e.includes("root"))).toEqual([]);
  });

  // ES-385: getuid 未提供（Windows/非 POSIX）→ root チェックスキップ
  it("getuid 未提供時は root チェックスキップ（ES-385）", async () => {
    const cfg = makeConfig({
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [], design: undefined, implement: undefined, selfReview: undefined, recovery: undefined, verify: undefined, scout: undefined },
    });
    const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("root"))).toEqual([]);
  });

  // ---- ES-415: origin URL と repo.remote の一致検証 ----

  it("HTTPS origin が repo.remote と一致すればエラーなし（ES-415）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("SSH origin が repo.remote と不一致なら NG（ES-415）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("HTTPS origin の owner 違いは NG（ES-415）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/different-owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("大小・.git 有無の表記ゆれを吸収して正当な一致では誤検知しない（ES-415）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/Owner/Name\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("git remote get-url が失敗したら取得不能エラー（ES-415）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 2, stdout: "", stderr: "fatal: No such remote 'origin'" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin の URL を取得できません"))).toBe(true);
  });

  it("大文字 .GIT 接尾辞を正しく除去する（ES-415 P3 fix）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/Owner/Name.GIT\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://github.com/Owner/Name.GIT\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("非 GitHub ホスト（gitlab.com）は NG（ES-415 P2 host fix）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://gitlab.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("SSH-over-HTTPS (ssh.github.com:443) は正当な一致として扱う（ES-415 P2 SSH-over-HTTPS fix）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:443/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:443/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("push URL が fetch URL と異なり repo.remote と不一致なら NG（ES-415 P1 push URL fix）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/other-repo.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("fetch URL と push URL が同一なら push URL 重複エラーなし（ES-415 pushurl 未設定）", async () => {
    const errors = await runPreflight({ config: makeConfig(), runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL"))).toEqual([]);
  });

  it("push URL が空リストなら NG（ES-415 Finding 3: empty pushurl）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL がありません"))).toBe(true);
  });

  it("複数 push URL のうち1つが不一致なら NG（ES-415 P2 multi push fix）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], {
      code: 0,
      stdout: "git@github.com:owner/name.git\ngit@github.com:owner/mirror.git\n",
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("mirror"))).toBe(true);
  });

  it("HTTPS URL に埋め込まれた認証情報をエラーメッセージで秘匿する（ES-415 P2 credential redact）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://ghp_secret_token@github.com/owner/wrong.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_secret_token"))).toBe(true);
  });

  it("クエリ文字列トークンをエラーメッセージで秘匿する（ES-415 Finding 2: query-string credential）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/wrong.git?token=ghp_query_secret\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_query_secret"))).toBe(true);
  });

  it("末尾スラッシュ付き HTTPS origin が repo.remote と一致すればエラーなし（ES-415 Finding 1: trailing slash）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name/\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://github.com/owner/name/\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("末尾スラッシュ付き .git/ HTTPS origin が repo.remote と一致すればエラーなし（ES-415 Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git/\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://github.com/owner/name.git/\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  // ES-415 Finding 1: SSH config aliases (non-standard hostnames) must not be rejected
  it("SSH config alias の fetch URL は origin 一致チェックをスキップする（ES-415 Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("SSH config alias の push URL は push URL 一致チェックをスキップする（ES-415 Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // ES-415 Finding 1: non-GitHub SCP remotes (real domain hostname) must be rejected
  it("非 GitHub SCP remote (git@gitlab.com:...) の fetch URL は NG（ES-415 Finding 1: non-GitHub SCP）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gitlab.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gitlab.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // ES-415 Finding 2: local-path remotes must be rejected
  it("ローカルパス remote は NG（ES-415 Finding 2: local-path remote）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "/srv/git/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "/srv/git/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // ES-415 Finding 3: SSH config alias push URL with mismatched path must be rejected
  it("SSH config alias の push URL でパスが不一致なら NG（ES-415 Finding 3: SSH-alias push path mismatch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // ES-415 Finding 2: unparseable remote URLs must not expose credentials in error messages
  it("パース不能な URL は origin エラーを生成せず認証情報を漏洩しない（ES-415 Finding 2）", async () => {
    const r = passingRunner();
    // `:notaport` makes the URL unparseable (non-numeric port); the token must not appear in errors.
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://ghp_leak@github.com:notaport/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://ghp_leak@github.com:notaport/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.every((e) => !e.includes("ghp_leak"))).toBe(true);
  });

  // Finding 1: SSH config alias (no-dot) fetch URL with mismatched path must be rejected
  it("SSH config alias の fetch URL でパスが不一致なら NG（Finding 1: SSH-alias fetch path mismatch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2: dotted SSH config alias (e.g. "github.com-work") must be accepted when path matches
  it("ドット含む SSH config alias (github.com-work) が repo.remote と一致すればエラーなし（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com-work:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.com-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ドット含む SSH config alias (github.com-work) でパスが不一致なら NG（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com-work:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com-work:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3: malformed push URL (different from fetch) must emit an error without leaking credentials
  it("不正な push URL はエラーを報告し認証情報を漏洩しない（Finding 3: malformed push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    // Malformed push URL with embedded credential; notaport makes URL unparseable
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://ghp_secret@github.com:notaport/owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_secret"))).toBe(true);
  });

  // Finding 1: non-GitHub URL schemes must be rejected
  it("file:// scheme で github.com ホストの URL は NG（Finding 1: scheme restriction）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "file://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "file://github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2: IPv4 SCP remotes must be rejected (not treated as SSH config aliases)
  it("IPv4 SCP remote は NG（Finding 2: IPv4 SCP rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@192.168.1.10:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@192.168.1.10:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("IPv4 SCP の push URL は NG（Finding 2: IPv4 push URL rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@192.168.1.10:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3: userless SSH config alias (no git@ prefix) must be accepted when path matches
  it("ユーザーなし SSH alias (github-work:owner/name.git) がパス一致ならエラーなし（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "github-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github-work:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "github-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ユーザーなし SSH alias でパスが不一致なら NG（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "github-work:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github-work:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 4: mixed pushurls with both a valid URL and an empty entry must be rejected
  it("push URL リストに有効 URL と空エントリが混在する場合はエラー（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], {
      code: 0,
      stdout: "git@github.com:owner/name.git\n\n",
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL がありません"))).toBe(true);
  });

  // Finding 1: absolute SCP path (git@github.com:/owner/name.git) must be accepted
  it("絶対パス SCP (git@github.com:/owner/name.git) がパス一致ならエラーなし（Finding 1）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  // Finding 2: trailing-dot non-GitHub SCP host must be rejected
  it("末尾ドット付き非 GitHub SCP (git@gitlab.com.:...) は NG（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gitlab.com.:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gitlab.com.:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3: userless GitHub SCP (github.com:owner/name.git) must be accepted
  it("ユーザーなし GitHub SCP (github.com:owner/name.git) がパス一致ならエラーなし（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ユーザーなし GitHub SCP でパスが不一致なら NG（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "github.com:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github.com:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1: non-git explicit user on GitHub SSH remote must be rejected
  it("非 git ユーザー付き GitHub SSH (alice@github.com:...) の fetch URL は NG（Finding 1: non-git SSH user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "alice@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "alice@github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("非 git ユーザー付き SSH alias (alice@github-work:...) の fetch URL は NG（Finding 1: non-git alias user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "alice@github-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "alice@github-work:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("非 git ユーザー付き SSH alias の push URL は NG（Finding 1: non-git alias push user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "alice@github-work:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3: query string or fragment in HTTPS URL must be rejected even when path matches
  it("クエリ文字列付き HTTPS URL はパスが一致してもエラー（Finding 3: query-string rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git?token=ghp_test\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://github.com/owner/name.git?token=ghp_test\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_test"))).toBe(true);
  });

  // Finding 4: SSH alias with absolute SCP path must be accepted when path matches
  it("SSH config alias の絶対パス SCP (git@github-work:/owner/name.git) がパス一致ならエラーなし（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("SSH config alias の絶対パス SCP でパスが不一致なら NG（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:/owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:/owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("絶対パス SCP の push URL (git@github-work:/owner/name.git) がパス一致ならエラーなし（Finding 4 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github-work"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 1: SCP-style remote with query-string token must not leak token in error message
  it("SCP URL のクエリ文字列トークンをエラーメッセージで秘匿する（Finding 1: SCP query-string token）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/wrong.git?token=ghp_scp_secret\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_scp_secret"))).toBe(true);
  });

  // Finding 2: SSH config alias with no "github" in name must be rejected (unknown target host)
  it("非 GitHub bare alias (git@gitlab:...) は NG（Finding 2: non-GitHub bare alias）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gitlab:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gitlab:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3: push URL with leading whitespace must be rejected even though normalizeRemote trims
  it("先頭に空白のある push URL は NG（Finding 3: whitespace-padded push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: " git@github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("空白") && e.includes("push URL"))).toBe(true);
  });

  // Finding 4: push URL with nonstandard port must be rejected
  it("非標準ポート付き HTTPS push URL (github.com:8443) は NG（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://github.com:8443/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("非標準ポート付き SSH push URL (github.com:2222) は NG（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com:2222/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (current iteration): SCP-form ssh.github.com fetch/push URL must be rejected
  it("SCP 形式の ssh.github.com fetch URL は NG（Finding 1: ssh.github.com SCP）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@ssh.github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@ssh.github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("SCP 形式の ssh.github.com push URL は NG（Finding 1: ssh.github.com SCP push）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@ssh.github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (current iteration): non-git SSH URL users must be rejected
  it("非 git ユーザー付き SSH URL の fetch URL は NG（Finding 2: non-git SSH URL user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://alice@github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://alice@github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("alice"))).toBe(true);
  });

  it("非 git ユーザー付き SSH URL の push URL は NG（Finding 2: non-git SSH URL push user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://alice@github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("alice"))).toBe(true);
  });

  // Finding 1 (current iteration): HTTPS to ssh.github.com must be rejected
  it("HTTPS fetch URL が ssh.github.com を使用していれば NG（Finding 1: HTTPS ssh.github.com fetch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://ssh.github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://ssh.github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("HTTPS push URL が ssh.github.com を使用していれば NG（Finding 1: HTTPS ssh.github.com push）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "https://ssh.github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (current iteration): push URLs with empty SSH user to real GitHub hosts must be rejected
  it("ユーザーなし SSH push URL は NG（Finding 2: userless SSH push URL rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("ユーザー"))).toBe(true);
  });

  it("ssh.github.com:443 の push URL でユーザーなしなら NG（Finding 2: SSH-over-HTTPS userless push）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://ssh.github.com:443/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("ユーザー"))).toBe(true);
  });

  it("git ユーザー付き SSH push URL はユーザーエラーなし（Finding 2: explicit git user ok）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("ユーザー"))).toEqual([]);
  });

  // Finding 3 (current iteration): SSH config aliases resolved via ssh -G
  it("ssh -G で github.com に解決される SSH config alias は origin 一致チェックを通過する（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh -G で github.com に解決される alias でパスが不一致なら NG（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G が利用不能な場合は SSH config alias を拒否する（Finding 3: ssh -G fallback reject）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    // No ssh -G stub → FakeCommandRunner throws → conservative reject
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G で非 GitHub ホストに解決される alias は NG（Finding 3: non-GitHub alias）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname gitlab.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL の SSH config alias が ssh -G で github.com に解決されパスが一致すればエラーなし（Finding 3 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  it("push URL の SSH config alias が ssh -G で github.com に解決されパスが不一致なら NG（Finding 3 push URL path mismatch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 4: SSH alias resolved via ssh -G to ssh.github.com:443 must be accepted
  it("ssh -G で ssh.github.com:443 に解決される SSH config alias は origin 一致チェックを通過する（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh -G で ssh.github.com:443 に解決される alias でパスが不一致なら NG（Finding 4: path mismatch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G で ssh.github.com に解決されるが port 443 以外なら NG（Finding 4: wrong port）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL の SSH config alias が ssh -G で ssh.github.com:443 に解決されパスが一致すればエラーなし（Finding 4 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 6: SSH alias resolved to github.com with non-standard port must be rejected
  it("ssh -G で github.com:2222 に解決される SSH config alias は NG（Finding 6: non-standard port）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL の SSH config alias が ssh -G で github.com:2222 に解決されたら NG（Finding 6: non-standard port push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (current iteration): ssh://git@ssh.github.com/... without :443 must be rejected
  it("ポートなし ssh.github.com URL の fetch は NG（Finding 1: port 443 必須）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ポートなし ssh.github.com URL の push は NG（Finding 1: port 443 必須 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (current iteration): github-named alias resolved to non-GitHub host must be rejected
  it("ssh -G で非 GitHub ホストに解決される github 名 alias は NG（Finding 2: github alias → non-GitHub host）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github-work"], { code: 0, stdout: "hostname gitlab.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G が利用不能な github 名 alias は保守的に拒否する（Finding 2: github alias without ssh -G）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github-work:owner/name.git\n", stderr: "" });
    // No ssh -G stub → FakeCommandRunner throws → conservative reject
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3 (current iteration): ssh -G resolved alias with non-git user must be rejected
  it("ssh -G で git 以外のユーザーに解決される alias の fetch URL は NG（Finding 3: non-git resolved user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser alice\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G で git 以外のユーザーに解決される alias の push URL は NG（Finding 3: non-git resolved user push）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser alice\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (password in SSH URL): ssh://git:secret@github.com/... must be rejected
  it("パスワード付き SSH fetch URL は NG（Finding 1: SSH URL password）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git:secret@github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git:secret@github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("secret"))).toBe(true);
  });

  it("パスワード付き SSH push URL は NG（Finding 1: SSH URL password push）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git:token@github.com/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("token"))).toBe(true);
  });

  // Finding 2 (honor core.sshCommand): alias resolved via custom ssh -F config must be accepted
  it("core.sshCommand 設定時はそのオプションを ssh -G に渡して alias を解決する（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "ssh -F /custom/config\n", stderr: "" });
    r.on(["ssh", "-F", "/custom/config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("core.sshCommand 設定時の push URL alias も同オプションで解決する（Finding 2 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "ssh -F /custom/config\n", stderr: "" });
    r.on(["ssh", "-F", "/custom/config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 3 (userless SCP push URL): github.com:owner/name.git as a distinct push URL must check SSH user
  it("ユーザーなし GitHub SCP の push URL で SSH 設定が非 git ユーザーを返す場合は NG（Finding 3）", async () => {
    const r = passingRunner();
    // fetch URL has explicit git@ user; push URL is the userless SCP form (different from fetch URL)
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "github.com"], { code: 0, stdout: "hostname github.com\nuser root\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("ユーザー"))).toBe(true);
  });

  it("ユーザーなし GitHub SCP の push URL で SSH 設定が git ユーザーを返す場合はエラーなし（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("ユーザー"))).toEqual([]);
  });

  // Finding 2 (current iteration): ssh:// aliases resolved via ssh -G
  it("ssh:// alias (ssh://git@gh/owner/name.git) が github.com に解決されパスが一致すればエラーなし（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh:// alias でパスが不一致なら NG（Finding 2）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh/owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh:// alias が非 GitHub ホストに解決される場合は NG（Finding 2: non-GitHub alias）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname gitlab.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh:// alias が利用不能な場合は保守的に拒否する（Finding 2: ssh -G fallback reject）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    // No ssh -G stub → FakeCommandRunner throws → conservative reject
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL の ssh:// alias が github.com に解決されパスが一致すればエラーなし（Finding 2 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  it("push URL の ssh:// alias でパスが不一致なら NG（Finding 2 push URL path mismatch）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3 (current iteration): GIT_SSH_COMMAND env var honored in alias resolution
  it("GIT_SSH_COMMAND 設定時はそのオプションを ssh -G に渡して alias を解決する（Finding 3）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-F", "/env/config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -F /env/config";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = origEnv;
      }
    }
  });

  // Finding 4 (current iteration): getGitSshArgs reused for userless push URL checks
  it("core.sshCommand 設定時はユーザーなし SSH URL push URL の ssh -G 検証でも同オプションを使用する（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "ssh -F /custom/config\n", stderr: "" });
    r.on(["ssh", "-F", "/custom/config", "-G", "github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ユーザー"))).toEqual([]);
  });

  it("core.sshCommand 設定時はユーザーなし SCP push URL の ssh -G 検証でも同オプションを使用する（Finding 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "ssh -F /custom/config\n", stderr: "" });
    r.on(["ssh", "-F", "/custom/config", "-G", "github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("ユーザー"))).toEqual([]);
  });

  it("全項目合格なら空配列を返す（仕様 §9）", async () => {
    const errors = await runPreflight({
      config: makeConfig(),
      runner: passingRunner(),
      notifier: passingNotifier,
      fetchFn: passingFetch(),
    });
    expect(errors).toEqual([]);
  });

  it("複数違反を同時に報告する（途中 throw せず全件集約; 仕様 §9）", async () => {
    const r = passingRunner();
    // §9.2 ダーティ + §9.4 push 不可 + §9.6 auto-merge true を同時に仕込む
    r.on(["git", "-C", "/abs/repo", "status", "--porcelain"], { code: 0, stdout: " M x\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "false\n", stderr: "" });
    r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], {
      code: 0,
      stdout: JSON.stringify({ value: "true" }),
      stderr: "",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("クリーンではありません"))).toBe(true);
    expect(errors.some((e) => e.includes("push 権限がありません"))).toBe(true);
    expect(errors.some((e) => e.includes("LOOPPILOT_AUTO_MERGE"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  // GitHub Free private リポで機能未提供の 403 は「保護なし = OK」として扱う
  it("ブランチ保護 API が 'Upgrade to GitHub Pro' 403 を返したら保護なし扱いで OK", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 1,
      stdout: "",
      stderr: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors).toHaveLength(0);
  });

  it("rulesets API が 'Upgrade to GitHub Pro' 403 を返したら保護なし扱いで OK", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 1,
      stdout: "",
      stderr: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors).toHaveLength(0);
  });

  // フェイルオープン回帰ガード: 権限不足の 403 は引き続きエラーとして報告する（最重要の安全特性）
  it("ブランチ保護 API が権限不足 403 を返したら fail-open せず違反として報告する", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/branches/main/protection"], {
      code: 1,
      stdout: "",
      stderr: "gh: Must have admin rights to Repository. (HTTP 403)",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ブランチ保護を取得できません"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("rulesets API が 500 を返したら fail-open せず違反として報告する", async () => {
    const r = passingRunner();
    r.on(["gh", "api", "repos/owner/name/rules/branches/main"], {
      code: 1,
      stdout: "",
      stderr: "gh: Internal Server Error (HTTP 500)",
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("ブランチルールセットを取得できません"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  // Finding 1 (current iteration): ssh.github.com:22 via URL must be rejected
  it("ssh://git@ssh.github.com:22 の fetch URL は NG（Finding 1: ssh.github.com port 22 rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:22/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:22/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh://git@ssh.github.com:22 の push URL は NG（Finding 1: ssh.github.com port 22 push rejection）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:22/owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (current iteration): quoted path in core.sshCommand must be preserved
  it("core.sshCommand のパスにスペースが含まれる場合は引用符を正しく解析する（Finding 2: quoted SSH args）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: 'ssh -F "/Users/me/ssh config"\n', stderr: "" });
    r.on(["ssh", "-F", "/Users/me/ssh config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("GIT_SSH_COMMAND のパスにスペースが含まれる場合は引用符を正しく解析する（Finding 2: quoted GIT_SSH_COMMAND args）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-F", "/Users/me/ssh config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'ssh -F "/Users/me/ssh config"';
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 3 (current iteration): push URL lookup failure must fail closed
  it("push URL 取得が失敗したら fail-closed でエラーになる（Finding 3: push URL lookup failure）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 2, stdout: "", stderr: "fatal: No such remote 'origin'" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("取得できません"))).toBe(true);
  });

  // Finding 4 (current iteration): explicit port in ssh:// alias URL must be honoured
  it("ssh:// alias に明示ポートがある場合そのポートで検証する（Finding 4: explicit port fetch URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh:2222/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh:2222/owner/name.git\n", stderr: "" });
    // URL port 2222 is passed to ssh -G (-p 2222); OpenSSH overrides config Port 22 → reports 2222.
    // github.com only accepts port 22, so must reject.
    r.on(["ssh", "-p", "2222", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL の ssh:// alias に明示ポートがある場合そのポートで検証する（Finding 4: explicit port push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh:2222/owner/name.git\n", stderr: "" });
    // URL port 2222 is passed to ssh -G (-p 2222); OpenSSH overrides config Port 22 → reports 2222.
    r.on(["ssh", "-p", "2222", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (this iteration): unquoted backslash-escaped path in GIT_SSH_COMMAND
  it("GIT_SSH_COMMAND のバックスラッシュエスケープパスを正しく解析してエイリアス解決に使用する（Finding 1 iteration 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    // Backslash-escaped space: ssh -F /Users/me/ssh\ config — note the path has a space
    r.on(["ssh", "-F", "/Users/me/ssh config", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -F /Users/me/ssh\\ config";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (this iteration): GIT_SSH wrapper binary used for alias resolution
  it("GIT_SSH ラッパーバイナリでエイリアスを解決する（Finding 2 iteration 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["/usr/local/bin/git-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH;
    process.env.GIT_SSH = "/usr/local/bin/git-ssh-wrapper";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH;
      else process.env.GIT_SSH = origEnv;
    }
  });

  // Finding 3 (this iteration): direct GitHub SSH host HostName redirect must be rejected
  it("SSH config が github.com を別のホストに HostName 転送している fetch URL は NG（Finding 3 iteration 4）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    // SSH config redirects github.com to a different server
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname evil.example.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("SSH config が github.com を転送していない場合は HostName チェックでエラーなし（Finding 3 iteration 4）", async () => {
    const r = passingRunner();
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors).toHaveLength(0);
  });

  it("push URL の SSH config が github.com を別ホストに転送している場合は NG（Finding 3 iteration 4 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com/owner/name.git\n", stderr: "" });
    // SSH config redirects github.com to a different server
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname evil.example.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 4 (this iteration): SSH alias URLs with extra components must be rejected
  it("ssh:// alias に password コンポーネントがある push URL は NG（Finding 4 iteration 4: push URL password）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git:secret@gh/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh:// alias にクエリ文字列がある push URL は NG（Finding 4 iteration 4: push URL query）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh/owner/name.git?token=x\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh:// alias に password コンポーネントがある fetch URL は NG（Finding 4 iteration 4: fetch URL password）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git:secret@gh/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git:secret@gh/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (this iteration): GIT_SSH_COMMAND with $HOME variable expansion
  it("GIT_SSH_COMMAND の $HOME 変数を展開して alias を解決する（Finding 1 iteration 5: env var expansion）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    const homeDir = process.env.HOME ?? "/home/runner";
    r.on(["ssh", "-F", `${homeDir}/.ssh/gh config`, "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'ssh -F "$HOME/.ssh/gh config"';
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  it("GIT_SSH_COMMAND の ${HOME} 変数を展開して alias を解決する（Finding 1 iteration 5: braced env var expansion）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    const homeDir = process.env.HOME ?? "/home/runner";
    r.on(["ssh", "-F", `${homeDir}/.ssh/gh config`, "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'ssh -F "${HOME}/.ssh/gh config"';
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (this iteration): core.sshCommand wrapper binary used for alias resolution
  it("core.sshCommand がラッパーバイナリの場合はそのバイナリで alias を解決する（Finding 2 iteration 5: wrapper binary）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "/usr/local/bin/my-ssh-wrapper\n", stderr: "" });
    r.on(["/usr/local/bin/my-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("core.sshCommand がラッパーバイナリの場合の push URL alias も同バイナリで解決する（Finding 2 iteration 5: wrapper binary push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "/usr/local/bin/my-ssh-wrapper\n", stderr: "" });
    r.on(["/usr/local/bin/my-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 3 (this iteration): direct GitHub SSH push URL with non-standard port
  it("SSH config が github.com の push URL を非標準ポートにリダイレクトしている場合は NG（Finding 3 iteration 5: push URL port redirect）", async () => {
    const r = passingRunner();
    // fetch is HTTPS; push is direct GitHub SSH SCP so the port check applies
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("SSH config が github.com の fetch URL を非標準ポートにリダイレクトしている場合は NG（Finding 3 iteration 5: fetch URL port redirect）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    // SSH config maps github.com to port 2222
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 2222\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("SSH config が github.com を標準ポート 22 に設定している場合はエラーなし（Finding 3 iteration 5: standard port ok）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 1 (iteration 6): GIT_SSH_COMMAND wrapper binary used for alias resolution
  it("GIT_SSH_COMMAND がラッパーバイナリの場合はそのバイナリで alias を解決する（Finding 1 iteration 6）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["/usr/local/bin/git-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "/usr/local/bin/git-ssh-wrapper";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (iteration 6): core.sshCommand $HOME variable expansion
  it("core.sshCommand の $HOME 変数を展開して alias を解決する（Finding 2 iteration 6）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    const homeDir = process.env.HOME ?? "/home/runner";
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: 'ssh -F "$HOME/.ssh/config"\n', stderr: "" });
    r.on(["ssh", "-F", `${homeDir}/.ssh/config`, "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  // Finding 3 (iteration 6): explicit port in ssh.github.com:443 URL is passed to ssh -G as -p
  it("ssh.github.com:443 URL の明示ポートを -p で ssh -G に渡してエラーなし（Finding 3 iteration 6）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:443/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:443/owner/name.git\n", stderr: "" });
    // ssh -G is now called with -p 443; command-line port takes precedence over any config Port directive.
    r.on(["ssh", "-p", "443", "-G", "git@ssh.github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("ssh.github.com:443 push URL の明示ポートを -p で ssh -G に渡してエラーなし（Finding 3 iteration 6 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@ssh.github.com:443/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-p", "443", "-G", "git@ssh.github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 4 (iteration 6): github.com → ssh.github.com:443 SSH-over-HTTPS remap accepted
  it("SSH config が github.com を ssh.github.com:443 にリダイレクトしている fetch URL はエラーなし（Finding 4 iteration 6）", async () => {
    const r = passingRunner();
    // passingRunner uses git@github.com:owner/name.git as origin
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("origin") && e.includes("一致しません"))).toEqual([]);
  });

  it("SSH config が github.com を ssh.github.com:443 にリダイレクトしている push URL はエラーなし（Finding 4 iteration 6 push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  it("SSH config が github.com を ssh.github.com:22 にリダイレクトしている場合は NG（Finding 4 iteration 6: wrong port）", async () => {
    const r = passingRunner();
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 5 (iteration 6): real non-GitHub ssh:// hosts rejected before alias resolution
  it("ssh:// 形式の gitlab.com が github.com に解決されても NG（Finding 5: real domain rejected before alias resolution）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gitlab.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gitlab.com/owner/name.git\n", stderr: "" });
    // Even if SSH config maps gitlab.com to github.com, real domains must be rejected outright.
    r.on(["ssh", "-G", "git@gitlab.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("SCP 形式の gitlab.com が github.com に解決されても NG（Finding 5: SCP real domain rejected before alias resolution）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gitlab.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gitlab.com:owner/name.git\n", stderr: "" });
    // Even if SSH config maps gitlab.com to github.com, real domains must be rejected outright.
    r.on(["ssh", "-G", "git@gitlab.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("ssh:// 形式の gitlab.com push URL が github.com に解決されても NG（Finding 5: push URL real domain）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gitlab.com/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gitlab.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("SCP 形式の gitlab.com push URL が github.com に解決されても NG（Finding 5: SCP push URL real domain）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gitlab.com:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gitlab.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (iteration 7): tilde in GIT_SSH_COMMAND binary path must be expanded
  it("GIT_SSH_COMMAND のバイナリパスに ~ がある場合 HOME に展開して alias を解決する（Finding 1 iteration 7: tilde in binary path）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    const homeDir = process.env.HOME ?? "/home/runner";
    r.on([`${homeDir}/bin/ssh`, "-F", "/cfg", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "~/bin/ssh -F /cfg";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (iteration 7): GIT_SSH_COMMAND wrapper with required arguments must pass those args
  it("GIT_SSH_COMMAND のラッパーバイナリに引数がある場合はその引数を ssh -G に渡す（Finding 2 iteration 7: wrapper args preserved）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["/usr/local/bin/git-ssh-wrapper", "--config", "gh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "/usr/local/bin/git-ssh-wrapper --config gh";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 3 (iteration 7): tilde in GIT_SSH_COMMAND arguments must be expanded
  it("GIT_SSH_COMMAND の引数に ~ がある場合 HOME に展開して alias を解決する（Finding 3 iteration 7: tilde in args）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    const homeDir = process.env.HOME ?? "/home/runner";
    r.on(["ssh", "-F", `${homeDir}/.ssh/config`, "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -F ~/.ssh/config";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 1 (iteration 8): single-quoted $VAR in GIT_SSH_COMMAND must not be expanded
  it("GIT_SSH_COMMAND の単一引用符内 $HOME は展開しない（Finding 1 iteration 8: single-quoted vars not expanded）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    // Single-quoted '$HOME/cfg' must reach ssh as the literal string, not expanded.
    r.on(["ssh", "-F", "$HOME/cfg", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -F '$HOME/cfg'";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (iteration 9): mixed-case SSH config alias hostname must be probed with original case
  it("大文字 SSH config alias (git@GH:...) を元のケースで ssh -G に渡す（Finding 2 iteration 9: alias host case preserved）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@GH:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@GH:owner/name.git\n", stderr: "" });
    // Must probe with original case 'GH', not lowercased 'gh', to match the Host GH ssh_config entry.
    r.on(["ssh", "-G", "git@GH"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("大文字 SSH config alias で SSH config が非 GitHub ホストにリダイレクトしている場合は NG（Finding 2 iteration 9: mixed-case alias redirect detected）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@GH:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@GH:owner/name.git\n", stderr: "" });
    // Host GH block redirects to evil server; detected only when probing with original 'GH' case.
    r.on(["ssh", "-G", "git@GH"], { code: 0, stdout: "hostname evil.example.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (iteration 8): mixed-case GitHub hostname must be probed with original case
  it("大文字 GitHub.com SCP URL を元のケースで ssh -G に渡す（Finding 2 iteration 8: host case preserved）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@GitHub.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@GitHub.com:owner/name.git\n", stderr: "" });
    // Must be probed with the original mixed-case hostname so case-sensitive Host blocks are matched.
    r.on(["ssh", "-G", "git@GitHub.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("大文字 GitHub.com SCP URL で SSH config がリダイレクトしている場合は NG（Finding 2 iteration 8: mixed-case host redirect detected）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@GitHub.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@GitHub.com:owner/name.git\n", stderr: "" });
    // Host block for 'GitHub.com' (capital G) redirects to evil server; must be caught with original case.
    r.on(["ssh", "-G", "git@GitHub.com"], { code: 0, stdout: "hostname evil.example.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3 (iteration 8): explicit URL port is passed to ssh -G to select the correct Host block
  it("ssh://git@github.com:22 で SSH config が port 443 にリダイレクトしている場合は NG（Finding 3 iteration 8: port conflict）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@github.com:22/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com:22/owner/name.git\n", stderr: "" });
    // SSH config: Host github.com → HostName ssh.github.com, Port 443 (SSH-over-HTTPS).
    // With -p 22 on the command line, SSH overrides the config Port, so effective port is 22.
    r.on(["ssh", "-p", "22", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("push URL ssh://git@github.com:22 で SSH config が port 443 にリダイレクトしている場合は NG（Finding 3 iteration 8: port conflict push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com:22/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-p", "22", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 3 (iteration 9): GIT_SSH_COMMAND with -p takes precedence over URL port in ssh -G probe
  it("GIT_SSH_COMMAND の -p 443 が ssh:// alias URL の port 2222 より優先される（Finding 3 iteration 9: first -p wins）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@gh:2222/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@gh:2222/owner/name.git\n", stderr: "" });
    // Git runs: ssh -p 443 -p 2222 git@gh. OpenSSH uses the first -p 443.
    // ssh -G mirrors this: ssh -p 443 -p 2222 -G git@gh → reports port 443.
    // github.com:443 is not valid, so must reject.
    r.on(["ssh", "-p", "443", "-p", "2222", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 443\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -p 443";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 4 (iteration 8): SSH user override via GIT_SSH_COMMAND must be detected on direct URLs
  it("直接 GitHub SSH URL で GIT_SSH_COMMAND が -l alice でユーザーを上書きしている場合は NG（Finding 4 iteration 8）", async () => {
    const r = passingRunner();
    // passingRunner origin: git@github.com:owner/name.git (direct GitHub SSH)
    r.on(["ssh", "-l", "alice", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser alice\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -l alice";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  it("直接 GitHub SSH URL で GIT_SSH_COMMAND が git ユーザーを使用する場合はエラーなし（Finding 4 iteration 8: git user ok）", async () => {
    const r = passingRunner();
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  // Finding 1 (iteration 10): origin URL comparison runs before remote reachability probe
  it("checkOriginMatchesRemote は checkRemote より前に実行される（Finding 1 iteration 10）", async () => {
    const r = passingRunner();
    // origin points at a different repo — mismatch should be detected
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/other.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
    // Verify that the origin URL check was invoked (get-url) before the remote probe (ls-remote)
    const getUrlIdx = r.calls.findIndex((c) => c.args.includes("get-url"));
    const lsRemoteIdx = r.calls.findIndex((c) => c.args.includes("ls-remote"));
    expect(getUrlIdx).toBeLessThan(lsRemoteIdx);
  });

  // Finding 2 (iteration 10): custom SSH command + ssh -G failure must fail closed
  it("カスタム SSH コマンド使用時に ssh -G が失敗すると fail-closed（Finding 2 iteration 10: custom SSH fail closed）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "/custom/ssh-wrapper\n", stderr: "" });
    // ssh -G probe fails (non-zero exit)
    r.on(["/custom/ssh-wrapper", "-G", "git@github.com"], { code: 1, stdout: "", stderr: "error" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("カスタム SSH コマンド使用時に ssh -G が hostname を返さないと fail-closed（Finding 2 iteration 10: missing hostname）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "/custom/ssh-wrapper\n", stderr: "" });
    // ssh -G succeeds but omits hostname
    r.on(["/custom/ssh-wrapper", "-G", "git@github.com"], { code: 0, stdout: "user git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("カスタム SSH コマンド使用時に push URL の ssh -G が失敗すると fail-closed（Finding 2 iteration 10: push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://github.com/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "/custom/ssh-wrapper\n", stderr: "" });
    r.on(["/custom/ssh-wrapper", "-G", "git@github.com"], { code: 1, stdout: "", stderr: "error" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("デフォルト ssh 使用時に ssh -G が失敗しても fail-open のまま（Finding 2 iteration 10: default ssh fail-open）", async () => {
    const r = passingRunner();
    // No custom SSH command — default ssh
    // ssh -G throws because no stub exists → catch fires → fail-open (isCustomSsh = false)
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors).toEqual([]);
  });

  // Finding 3 (iteration 10): resolved SSH user must be compared case-sensitively
  it("ssh -G で大文字 Git ユーザーに解決される場合は NG（Finding 3 iteration 10: case-sensitive user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    // SSH config resolves to user "Git" (capital G) — must be rejected
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser Git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
  });

  it("ssh -G で大文字 GIT ユーザーに解決される push URL は NG（Finding 3 iteration 10: case-sensitive push user）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser GIT\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("push URL") && e.includes("一致しません"))).toBe(true);
  });

  it("直接 GitHub SSH URL で ssh -G が大文字 Git ユーザーを返す場合は NG（Finding 3 iteration 10: direct URL case user）", async () => {
    const r = passingRunner();
    // Direct GitHub SSH URL — ssh -G resolves user to "Git" (capital G)
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser Git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("一致しません"))).toBe(true);
  });

  // Finding 1 (iteration 11): GIT_SSH_COMMAND with leading KEY=VALUE shell assignment
  it("GIT_SSH_COMMAND が KEY=VALUE 代入で始まる場合は代入をスキップして SSH バイナリを特定する（Finding 1 iteration 11）", async () => {
    const r = passingRunner();
    // direct GitHub origin — the default passingRunner origin: git@github.com:owner/name.git
    // With GIT_SSH_COMMAND='SSH_AUTH_SOCK=/tmp/agent.sock ssh', the effective binary is 'ssh'
    // and isCustomSsh must be false (no non-standard binary or extra args).
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "SSH_AUTH_SOCK=/tmp/agent.sock ssh";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  it("core.sshCommand が KEY=VALUE 代入で始まる場合は代入をスキップして SSH バイナリを特定する（Finding 1 iteration 11: core.sshCommand）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "SSH_AUTH_SOCK=/tmp/agent.sock ssh -F /cfg\n", stderr: "" });
    // After skipping SSH_AUTH_SOCK=... the binary is 'ssh' and extra args are ['-F', '/cfg'].
    r.on(["ssh", "-F", "/cfg", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("GIT_SSH_COMMAND が複数の KEY=VALUE 代入で始まる場合もスキップする（Finding 1 iteration 11: multiple assignments）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-F", "/cfg", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "A=1 B=2 ssh -F /cfg";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  // Finding 2 (iteration 11): domain-like SSH aliases with private TLDs must be accepted via ssh -G
  it("プライベート TLD の SSH config alias (git@github.internal:...) が github.com に解決されパスが一致すればエラーなし（Finding 2 iteration 11）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.internal:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.internal:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.internal"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("プライベート TLD の SSH config alias でパスが不一致なら NG（Finding 2 iteration 11）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.internal:owner/other.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.internal:owner/other.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.internal"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  it("プライベート TLD (.corp) の SSH config alias が github.com に解決されパスが一致すればエラーなし（Finding 2 iteration 11: .corp TLD）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@git.corp:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@git.corp:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@git.corp"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh:// alias にプライベート TLD がある場合も ssh -G で github.com に解決されパスが一致すればエラーなし（Finding 2 iteration 11: ssh:// alias）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@github.internal/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.internal/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.internal"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("push URL がプライベート TLD alias で github.com に解決されパスが一致すればエラーなし（Finding 2 iteration 11: push URL）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.internal:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@github.internal"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("push URL") && e.includes("一致しません"))).toEqual([]);
  });

  // Finding 3 (iteration 11): malformed fetch URL must emit error even when push URL is valid
  it("不正な fetch URL はエラーを報告し push URL が正常でも検証をスキップしない（Finding 3 iteration 11）", async () => {
    const r = passingRunner();
    // Malformed fetch URL with embedded credential and non-numeric port
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "https://ghp_secret@github.com:notaport/owner/name.git\n", stderr: "" });
    // Valid push URL that matches repo.remote
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
    expect(errors.every((e) => !e.includes("ghp_secret"))).toBe(true);
  });

  // Finding 1 (iteration 12): ssh://git@github.com:443 with SSH-over-HTTPS remap must be accepted
  it("ssh://git@github.com:443 fetch URL が SSH config で ssh.github.com:443 にリダイレクトされた場合はエラーなし（Finding 1 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@github.com:443/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com:443/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-p", "443", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh://git@github.com:443 fetch URL が SSH config リダイレクトなしの場合は NG（Finding 1 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "ssh://git@github.com:443/owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "ssh://git@github.com:443/owner/name.git\n", stderr: "" });
    r.on(["ssh", "-p", "443", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("origin") && e.includes("一致しません"))).toBe(true);
  });

  // Finding 2 (iteration 12): leading shell assignments in GIT_SSH_COMMAND must be passed as env to SSH probes
  it("GIT_SSH_COMMAND が KEY=VALUE 代入で始まる場合は代入を SSH probe の環境変数として渡す（Finding 2 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["/usr/local/bin/git-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const origEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "WRAPPER_CONFIG=/cfg /usr/local/bin/git-ssh-wrapper";
    try {
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
      const sshProbeCall = r.calls.find((c) => c.cmd === "/usr/local/bin/git-ssh-wrapper" && c.args.includes("-G"));
      expect(sshProbeCall?.opts.env?.WRAPPER_CONFIG).toBe("/cfg");
    } finally {
      if (origEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origEnv;
    }
  });

  it("core.sshCommand が KEY=VALUE 代入で始まる場合は代入を SSH probe の環境変数として渡す（Finding 2 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "config", "--get", "core.sshCommand"], { code: 0, stdout: "WRAPPER_CONFIG=/cfg /usr/local/bin/git-ssh-wrapper\n", stderr: "" });
    r.on(["/usr/local/bin/git-ssh-wrapper", "-G", "git@gh"], { code: 0, stdout: "hostname github.com\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
    const sshProbeCall = r.calls.find((c) => c.cmd === "/usr/local/bin/git-ssh-wrapper" && c.args.includes("-G"));
    expect(sshProbeCall?.opts.env?.WRAPPER_CONFIG).toBe("/cfg");
  });

  // Finding 3 (iteration 12): FQDN absolute-DNS notation (trailing dot) from ssh -G must be normalized
  it("ssh -G の hostname が FQDN 絶対表記 (github.com.) でも正常に一致する（Finding 3 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname github.com.\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("SSH config alias の ssh -G で hostname が FQDN 絶対表記 (github.com.) でも一致する（Finding 3 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["git", "-C", "/abs/repo", "remote", "get-url", "--push", "--all", "origin"], { code: 0, stdout: "git@gh:owner/name.git\n", stderr: "" });
    r.on(["ssh", "-G", "git@gh"], { code: 0, stdout: "hostname github.com.\nuser git\nport 22\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });

  it("ssh -G の hostname が ssh.github.com. (FQDN) でも SSH-over-HTTPS として一致する（Finding 3 iteration 12）", async () => {
    const r = passingRunner();
    r.on(["ssh", "-G", "git@github.com"], { code: 0, stdout: "hostname ssh.github.com.\nuser git\nport 443\n", stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("一致しません"))).toEqual([]);
  });
});

describe("normalizeRemote", () => {
  it("SSH 形式を owner/name に正規化する", () => {
    expect(normalizeRemote("git@github.com:owner/name.git")).toBe("owner/name");
  });

  it("SSH 形式 .git なしを正規化する", () => {
    expect(normalizeRemote("git@github.com:owner/name")).toBe("owner/name");
  });

  it("SSH URL 形式を正規化する", () => {
    expect(normalizeRemote("ssh://git@github.com/owner/name.git")).toBe("owner/name");
  });

  it("HTTPS 形式を正規化する", () => {
    expect(normalizeRemote("https://github.com/owner/name.git")).toBe("owner/name");
  });

  it("HTTPS 形式 .git なしを正規化する", () => {
    expect(normalizeRemote("https://github.com/owner/name")).toBe("owner/name");
  });

  it("大文字を小文字化する", () => {
    expect(normalizeRemote("https://github.com/Owner/Name.git")).toBe("owner/name");
    expect(normalizeRemote("git@github.com:Owner/Name.git")).toBe("owner/name");
  });

  it("前後の空白・改行を除去する", () => {
    expect(normalizeRemote("  git@github.com:owner/name.git\n")).toBe("owner/name");
  });

  it("パース不能な文字列は null を返す", () => {
    expect(normalizeRemote("not-a-url")).toBeNull();
    expect(normalizeRemote("")).toBeNull();
  });

  // Finding 2: 非 GitHub ホストは null
  it("GitLab の HTTPS URL は null を返す（Finding 2: 非 GitHub ホスト）", () => {
    expect(normalizeRemote("https://gitlab.com/owner/name.git")).toBeNull();
  });

  it("非 GitHub SSH URL は null を返す（Finding 2: 非 GitHub ホスト）", () => {
    expect(normalizeRemote("git@gitlab.com:owner/name.git")).toBeNull();
  });

  // Finding 3: 大文字 .GIT サフィックスの除去
  it("大文字の .GIT サフィックスを除去して正規化する（Finding 3）", () => {
    expect(normalizeRemote("https://github.com/Owner/Name.GIT")).toBe("owner/name");
  });

  it("SSH 形式の大文字 .GIT サフィックスを除去する（Finding 3）", () => {
    expect(normalizeRemote("git@github.com:Owner/Name.GIT")).toBe("owner/name");
  });

  it("SSH-over-HTTPS (ssh.github.com:443) を正規化する", () => {
    expect(normalizeRemote("ssh://git@ssh.github.com:443/owner/name.git")).toBe("owner/name");
  });

  it("ポートなし ssh.github.com SSH URL は null を返す（Finding 1: port 443 必須）", () => {
    // ssh.github.com on port 22 (the SSH default) is not a valid git endpoint.
    expect(normalizeRemote("ssh://git@ssh.github.com/owner/name.git")).toBeNull();
  });

  it("ssh.github.com:22 の SSH URL は null を返す（Finding 1: ssh.github.com port 22 rejection）", () => {
    expect(normalizeRemote("ssh://git@ssh.github.com:22/owner/name.git")).toBeNull();
  });

  it("非 GitHub SSH URL (bitbucket) は null を返す", () => {
    expect(normalizeRemote("ssh://git@bitbucket.org/owner/name.git")).toBeNull();
  });

  // Finding 1: absolute SCP path (leading slash after colon) must normalize correctly
  it("絶対パス SCP (git@github.com:/owner/name.git) を owner/name に正規化する（Finding 1）", () => {
    expect(normalizeRemote("git@github.com:/owner/name.git")).toBe("owner/name");
  });

  // Finding 3: userless GitHub SCP (github.com:path) must normalize correctly
  it("ユーザーなし GitHub SCP (github.com:owner/name.git) を owner/name に正規化する（Finding 3）", () => {
    expect(normalizeRemote("github.com:owner/name.git")).toBe("owner/name");
  });

  // Finding 4: nonstandard ports must be rejected
  it("非標準ポート付き HTTPS URL は null を返す（Finding 4）", () => {
    expect(normalizeRemote("https://github.com:8443/owner/name.git")).toBeNull();
  });

  it("非標準ポート付き SSH URL は null を返す（Finding 4）", () => {
    expect(normalizeRemote("ssh://git@github.com:2222/owner/name.git")).toBeNull();
  });

  it("標準 SSH ポート 22 の明示指定は owner/name に正規化する（Finding 4 境界）", () => {
    expect(normalizeRemote("ssh://git@github.com:22/owner/name.git")).toBe("owner/name");
  });

  // Finding 1: non-git explicit SSH user must be rejected for GitHub hosts
  it("非 git ユーザー付き GitHub SCP は null を返す（Finding 1: non-git user）", () => {
    expect(normalizeRemote("alice@github.com:owner/name.git")).toBeNull();
  });

  it("git ユーザー付き GitHub SCP は正規化する（Finding 1: git user ok）", () => {
    expect(normalizeRemote("git@github.com:owner/name.git")).toBe("owner/name");
  });

  it("ユーザーなし GitHub SCP は正規化する（Finding 1: userless ok）", () => {
    expect(normalizeRemote("github.com:owner/name.git")).toBe("owner/name");
  });

  // Finding 1 (iteration 9): SSH username must match 'git' exactly (case-sensitive)
  it("大文字 Git ユーザー付き GitHub SCP は null を返す（Finding 9: exact SSH username SCP）", () => {
    expect(normalizeRemote("Git@github.com:owner/name.git")).toBeNull();
  });

  it("大文字 Git ユーザー付き GitHub SSH URL は null を返す（Finding 9: exact SSH username url）", () => {
    expect(normalizeRemote("ssh://Git@github.com/owner/name.git")).toBeNull();
  });

  // Finding 3: query string or fragment must be rejected in URL-parsed remotes
  it("クエリ文字列付き HTTPS URL はパスが正しくても null を返す（Finding 3）", () => {
    expect(normalizeRemote("https://github.com/owner/name.git?token=bad")).toBeNull();
  });

  it("フラグメント付き HTTPS URL は null を返す（Finding 3）", () => {
    expect(normalizeRemote("https://github.com/owner/name.git#frag")).toBeNull();
  });

  // Finding 1: non-GitHub URL schemes must be rejected
  it("file:// スキームは null を返す（Finding 1: scheme restriction）", () => {
    expect(normalizeRemote("file://github.com/owner/name.git")).toBeNull();
  });

  it("git:// スキームは null を返す（Finding 1: scheme restriction）", () => {
    expect(normalizeRemote("git://github.com/owner/name.git")).toBeNull();
  });

  // Finding 2: IPv4 SCP remotes must not normalize
  it("IPv4 SCP remote は null を返す（Finding 2: IPv4 rejection）", () => {
    expect(normalizeRemote("git@192.168.1.10:owner/name.git")).toBeNull();
  });

  // Finding 1: 末尾スラッシュの正規化
  it("HTTPS URL の末尾スラッシュを除去して正規化する（Finding 1）", () => {
    expect(normalizeRemote("https://github.com/owner/name/")).toBe("owner/name");
  });

  it("HTTPS URL の .git/ を除去して正規化する（Finding 1）", () => {
    expect(normalizeRemote("https://github.com/owner/name.git/")).toBe("owner/name");
  });

  it("SSH 形式の末尾スラッシュを除去して正規化する（Finding 1）", () => {
    expect(normalizeRemote("git@github.com:owner/name.git/")).toBe("owner/name");
    expect(normalizeRemote("git@github.com:owner/name/")).toBe("owner/name");
  });

  // Finding 1 (current iteration): SCP-form ssh.github.com cannot express port 443
  it("SCP 形式の ssh.github.com は null を返す（Finding 1: ssh.github.com SCP rejection）", () => {
    expect(normalizeRemote("git@ssh.github.com:owner/name.git")).toBeNull();
  });

  // Finding 1 (current iteration): HTTPS to ssh.github.com must be rejected
  it("HTTPS の ssh.github.com URL は null を返す（Finding 1: HTTPS ssh.github.com rejection）", () => {
    expect(normalizeRemote("https://ssh.github.com/owner/name.git")).toBeNull();
  });

  it("HTTPS の ssh.github.com URL (.git なし) は null を返す（Finding 1: HTTPS ssh.github.com no .git）", () => {
    expect(normalizeRemote("https://ssh.github.com/owner/name")).toBeNull();
  });

  it("ユーザーなし SCP 形式の ssh.github.com は null を返す（Finding 1: ssh.github.com SCP userless）", () => {
    expect(normalizeRemote("ssh.github.com:owner/name.git")).toBeNull();
  });

  // Finding 2 (current iteration): non-git SSH URL users must be rejected
  it("非 git ユーザー付き SSH URL は null を返す（Finding 2: non-git SSH URL user）", () => {
    expect(normalizeRemote("ssh://alice@github.com/owner/name.git")).toBeNull();
  });

  it("git ユーザー付き SSH URL は正規化する（Finding 2: git SSH URL user ok）", () => {
    expect(normalizeRemote("ssh://git@github.com/owner/name.git")).toBe("owner/name");
  });

  it("ユーザーなし SSH URL は正規化する（Finding 2: userless SSH URL ok）", () => {
    expect(normalizeRemote("ssh://github.com/owner/name.git")).toBe("owner/name");
  });

  // Finding 1 (current iteration): SSH URLs with a password component must be rejected
  it("パスワード付き SSH URL は null を返す（Finding 1: SSH URL password rejection）", () => {
    expect(normalizeRemote("ssh://git:secret@github.com/owner/name.git")).toBeNull();
  });

  it("ユーザーのみ（パスワードなし）SSH URL は正規化する（Finding 1: no password ok）", () => {
    expect(normalizeRemote("ssh://git@github.com/owner/name.git")).toBe("owner/name");
  });

  // Finding 1 (iteration 12): ssh://git@github.com:443 must be accepted for SSH-over-HTTPS remap
  it("ssh://git@github.com:443 は SSH-over-HTTPS リダイレクト用に正規化する（Finding 1 iteration 12）", () => {
    expect(normalizeRemote("ssh://git@github.com:443/owner/name.git")).toBe("owner/name");
  });
});

describe("runPreflight — runner.run に timeoutMs が設定される (ES-465)", () => {
  it("全 runner.run 呼び出しに timeoutMs が設定される", async () => {
    const runner = passingRunner();
    const config = makeConfig();
    await runPreflight({ runner, config, fetchFn: passingFetch(), notifier: passingNotifier });
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.opts.timeoutMs, `${call.cmd} ${call.args.join(" ")}`).toBeTypeOf("number");
      expect(call.opts.timeoutMs).toBeGreaterThan(0);
    }
  });
});

// ---- ES-498: codex CLI 可用性（checkCodexAvailability の runPreflight 配線） ----
describe("runPreflight: codex CLI 可用性（ES-498）", () => {
  it("codex が正常（--version 成功 + 認証済み）なら codex 系エラーなし・probe は cwd '.' / 30s timeout", async () => {
    const r = passingRunner();
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.toLowerCase().includes("codex"))).toEqual([]);
    const versionCall = r.calls.find((c) => c.cmd === CODEX_CMD && c.args[0] === "--version");
    expect(versionCall).toBeDefined();
    expect(versionCall!.opts.cwd).toBe(".");
    expect(versionCall!.opts.timeoutMs).toBe(30_000);
  });

  it("codex --version が非0終了なら not-found + インストール対処 + stderr 実診断を列挙（修正方針 1）", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) =>
      e.includes("codex CLI not found or not available") &&
      e.includes("インストール") &&
      e.includes("command not found"), // ES-498 レビュー反映: stderr を捨てない
    )).toBe(true);
    // ES-498 R2 反映: checkCodex は codex 発のメッセージを加工しない（"codex: " 二重前置なし）。
    // startsWith で先頭を固定し、無条件 prefix 化の退行を検出する。
    expect(errors.some((e) => e.startsWith("codex CLI not found or not available"))).toBe(true);
  });

  it("codex --version が spawn 失敗（ENOENT）なら診断付き not-found + インストール対処を列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "--version"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) =>
      e.includes("codex CLI not found or not available") &&
      e.includes("ENOENT") &&
      e.includes("インストール"), // ES-498 レビュー反映: ENOENT 経路の対処もピン留め
    )).toBe(true);
  });

  it("codex --version が timeout なら not found と誤分類せず原因を列挙する（ES-498 レビュー反映）", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "--version"], () => {
      throw new Error('command "codex" timed out after 30000ms');
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 可用性確認に失敗しました") && e.includes("timed out after 30000ms"))).toBe(true);
    // ハングした codex（= 発見済み）に「インストールせよ」という矛盾した対処を出さない
    expect(errors.some((e) => e.includes("インストール"))).toBe(false);
  });

  it("codex login status が非0（未認証）なら codex login の対処 + stderr 実診断を列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) =>
      e.includes("codex: 認証されていません") &&
      e.includes("codex login") &&
      e.includes("詳細: not logged in"), // ES-498 レビュー反映: 未認証以外の非0終了の誤誘導対策
    )).toBe(true);
  });

  it("codex login status が spawn 失敗なら認証確認エラーを列挙", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], () => {
      throw new Error("spawn codex ENOENT");
    });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 認証状態を確認できません"))).toBe(true);
  });

  // skipIf: 非 Linux では「パス」ではなく「スキップ」として報告させる（空振り合格の可視化）
  it.skipIf(process.platform !== "linux")(
    "Linux: bwrap probe が失敗しても codex チェックは合格のまま（non-fatal probe 維持）",
    async () => {
      const r = passingRunner();
      // FakeCommandRunner は同一プレフィックスなら後登録が勝つ — bwrap probe を spawn 失敗に上書き。
      r.on(["bwrap", "--version"], () => {
        throw new Error("spawn bwrap ENOENT");
      });
      const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
      // probe が実際に呼ばれた（= スキップによる空振り合格ではない）ことを確認した上で、
      // その失敗が preflight を汚さないことを検証する。
      expect(r.calls.some((c) => c.cmd === "bwrap")).toBe(true);
      expect(errors).toEqual([]);
    },
  );

  it("codex 未認証 + claude 未認証は両方同時に列挙される（途中 throw せず集約; 仕様 §9）", async () => {
    const r = passingRunner();
    r.on([CODEX_CMD, "login", "status"], { code: 1, stdout: "", stderr: "not logged in" });
    r.on(["claude", "auth", "status", "--json"], { code: 0, stdout: '{"loggedIn":false}\n', stderr: "" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("codex: 認証されていません"))).toBe(true);
    expect(errors.some((e) => e.includes("claude: 認証されていません"))).toBe(true);
  });
});
