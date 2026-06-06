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
    agent: { model: "opus", allowedTools: "Edit,Write,Read,Glob,Grep,Bash", extraArgs: [] },
    handoff: { branchPrefix: "looppilot", prBodyTemplate: "Implements {identifier}" },
    looppilot: { gateLabel: "loop-pilot", stateCommentAuthors: ["github-actions[bot]"] },
    safety: {
      maxTasksPerRun: 3,
      maxCostUsdPerSession: 10,
      monitorTimeoutMinutes: undefined,
      notEngagedGuardMinutes: 30,
    },
    loop: { monitorPollSeconds: 60, idleRecheckSeconds: 300 },
    digest: { recentMergedCount: 5 },
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
          },
        ],
      },
      projects: { nodes: [{ id: "proj-1", name: "LoopPilot OS" }] },
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
});
