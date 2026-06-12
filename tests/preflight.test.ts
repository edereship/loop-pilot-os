import { describe, it, expect } from "vitest";
import { runPreflight } from "../src/preflight.js";
import { FakeCommandRunner } from "./fakes.js";
import type { Notifier, NotifyEvent, TicketState } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FetchFn } from "../src/task-source.js";

// ---- テスト用の最小 Config（config.ts §の Config 形・camelCase は解決済みの形） ----
function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    product: { goal: "ship it" },
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
      states: { todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: "Done" },
    },
    agent: { model: "opus", effort: "max", permissionMode: "acceptEdits", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    handoff: { branchPrefix: "looppilot", prBodyTemplate: "Implements {identifier}" },
    looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]"] },
    safety: {
      maxTasksPerRun: 3,
      maxCostUsdPerSession: 10,
      monitorTimeoutMinutes: undefined,
      notEngagedGuardMinutes: 30,
      sessionHardTimeoutMinutes: 120,
      maxWorkflowFixAttempts: 2,
      maxCostUsdPerFix: 2,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    digest: { recentMergedCount: 5 },
    notify: { progress: false },
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
  // §9.4: gh 認証
  r.on(["gh", "auth", "status"], { code: 0, stdout: "Logged in", stderr: "" });
  // §9.4: push 権限
  r.on(["gh", "api", "repos/owner/name", "--jq", ".permissions.push"], { code: 0, stdout: "true\n", stderr: "" });
  // §9.4: 認証ユーザー名（restrictions の許可リスト照合に使う）
  r.on(["gh", "api", "user", "--jq", ".login"], { code: 0, stdout: "the-bot\n", stderr: "" });
  // §9.4: ブランチ保護なし → 404
  r.on(["gh", "api", "repos/owner/name/branches/main/protection"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.4: rulesets 空配列（保護なし）
  r.on(["gh", "api", "repos/owner/name/rules/branches/main"], { code: 0, stdout: "[]\n", stderr: "" });
  // §9.5: gate_label がリポラベルに存在
  r.on(["gh", "api", "repos/owner/name/labels", "--paginate", "--jq", ".[].name"], { code: 0, stdout: "bug\nloop-pilot\nai-ok\n", stderr: "" });
  // §9.6: AUTO_MERGE 未設定 → 404
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_AUTO_MERGE"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.9: STATE_COMMENT_AUTHORS 未設定 → 404（リポ既定 github-actions[bot]）
  r.on(["gh", "api", "repos/owner/name/actions/variables/LOOPPILOT_STATE_COMMENT_AUTHORS"], { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  // §9.8: claude 起動可
  r.on(["claude", "--version"], { code: 0, stdout: "2.1.165 (Claude Code)\n", stderr: "" });
  return r;
}

// resolveLinearSetup は https://api.linear.app/graphql を `FetchFn` で叩く。
// 解決に必要な viewer/teams/projects/issueLabels を一括で返す合格応答（Task 7 SETUP_QUERY の shape）。
// FetchFn の戻り値は { ok, status, json() }。Web Response ではない。
function passingFetch(): FetchFn {
  const body = {
    data: {
      viewer: { id: "user-1", name: "Viewer" },
      teams: {
        nodes: [
          {
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
            labels: { nodes: [{ id: "lb-1", name: "ai-ok" }] },
            projects: { nodes: [{ id: "proj-1", name: "LoopPilot OS" }] },
          },
        ],
      },
      issueLabels: { nodes: [] },
    },
  };
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
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

  it("claude が起動できないと NG（仕様 §9.8）", async () => {
    const r = passingRunner();
    r.on(["claude", "--version"], { code: 127, stdout: "", stderr: "command not found" });
    const errors = await runPreflight({ config: makeConfig(), runner: r, notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.some((e) => e.includes("claude"))).toBe(true);
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
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    });
    const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch(), getuid: () => 0 });
    expect(errors.some((e) => e.includes("root") && e.includes("bypassPermissions"))).toBe(true);
  });

  // ES-385: bypassPermissions + 非 root → OK
  it("bypassPermissions + 非 root は OK（ES-385）", async () => {
    const cfg = makeConfig({
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
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
      agent: { model: "opus", effort: "max", permissionMode: "bypassPermissions", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    });
    const errors = await runPreflight({ config: cfg, runner: passingRunner(), notifier: passingNotifier, fetchFn: passingFetch() });
    expect(errors.filter((e) => e.includes("root"))).toEqual([]);
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
});
