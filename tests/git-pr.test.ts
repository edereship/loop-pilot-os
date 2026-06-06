import { describe, it, expect } from "vitest";
import { GitPrManager } from "../src/git-pr.js";
import { FakeCommandRunner } from "./fakes.js";
import type { EligibleIssue } from "../src/types.js";

// 共通: 構築 opts（全テストで同一）
const OPTS = {
  repoPath: "/repo",
  remote: "owner/name",
  defaultBranch: "main",
  branchPrefix: "looppilot",
  worktreeRoot: "/wt",
  prBodyTemplate: "Implements {identifier}: {title}\n\n{issue_url}\n",
  gateLabel: "loop-pilot",
};

function issue(over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id: "uuid-1",
    identifier: "TY-123",
    title: "Add the login flow!",
    description: "",
    priority: 2,
    sortOrder: 1,
    url: "https://linear.app/team/issue/TY-123",
    ...over,
  };
}

describe("GitPrManager.prepareWorktree", () => {
  // 仕様 §5 CLAIM: デフォルトブランチからブランチ <prefix>/<id小文字>-<slug> + worktree
  // カーネル §5.2: fetch origin <defaultBranch> → worktree add -b <branch> <wtPath> origin/<defaultBranch>
  it("fetches default branch then adds a worktree from origin/<defaultBranch> with slugified branch", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    // slug: "add the login flow!" → "add-the-login-flow"（30字以内、末尾 ! は除去）
    const branch = "looppilot/ty-123-add-the-login-flow";
    const wtPath = "/wt/ty-123-add-the-login-flow";
    expect(result).toEqual({ branch, worktreePath: wtPath });

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "fetch", "origin", "main"],
      opts: { cwd: "/repo" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "add", "-b", branch, wtPath, "origin/main"],
      opts: { cwd: "/repo" },
    });
  });

  it("appends -2 on 'already exists' collision and adds the worktree on the retried branch", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    // 最初のブランチは衝突、-2 は成功（args[5] = -b の次 = branch 名で分岐）
    runner.on(["git", "-C", "/repo", "worktree", "add"], (args) => {
      const branch = args[5];
      if (branch === "looppilot/ty-123-add-the-login-flow") {
        return { code: 128, stdout: "", stderr: "fatal: a branch named 'x' already exists" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    expect(result).toEqual({
      branch: "looppilot/ty-123-add-the-login-flow-2",
      worktreePath: "/wt/ty-123-add-the-login-flow-2",
    });
    // fetch + 2 回の worktree add
    expect(runner.calls.map((c) => c.args[5]).filter(Boolean)).toEqual([
      "looppilot/ty-123-add-the-login-flow",
      "looppilot/ty-123-add-the-login-flow-2",
    ]);
  });

  it("throws when -2..-5 are all exhausted by collisions", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], {
      code: 128,
      stdout: "",
      stderr: "fatal: already exists",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/collision exhausted/);
    // base + -2 + -3 + -4 + -5 = 5 回の worktree add 試行
    const adds = runner.calls.filter((c) => c.args[3] === "add");
    expect(adds).toHaveLength(5);
  });

  it("throws immediately on a non-'already exists' worktree add failure", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], {
      code: 1,
      stdout: "",
      stderr: "fatal: permission denied",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/permission denied/);
    // 衝突ではないので 1 回だけ試行
    const adds = runner.calls.filter((c) => c.args[3] === "add");
    expect(adds).toHaveLength(1);
  });

  it("throws when 'git fetch' exits non-zero and never calls worktree add", async () => {
    const runner = new FakeCommandRunner();
    // fetch が非0（ネットワーク断・remote 不達等）。worktree add は登録するが呼ばれてはならない
    runner.on(["git", "-C", "/repo", "fetch"], {
      code: 128,
      stdout: "",
      stderr: "fatal: unable to access remote",
    });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    // 契約（カーネル §2）: prepareWorktree は失敗を throw。陳腐化した base 上で worktree を作らない
    await expect(mgr.prepareWorktree(issue())).rejects.toThrow(/fetch origin main failed/);
    // fetch のみ実行し、worktree add は一切呼ばない（calls 長 1）
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
  });

  it("truncates the slug to 30 chars and strips a trailing hyphen", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    // title 38字。slug 部は title から生成し 30 字で切詰め、末尾ハイフン除去
    const result = await mgr.prepareWorktree(
      issue({ title: "Refactor the authentication module now" }),
    );
    // "refactor-the-authentication-module-now" → 先頭30字 "refactor-the-authentication-mo"
    expect(result.branch).toBe("looppilot/ty-123-refactor-the-authentication-mo");
  });
});

describe("GitPrManager.hasCommitsWithDiff", () => {
  // カーネル §5.2: rev-list --count origin/<defaultBranch>..HEAD > 0
  //                AND diff --quiet origin/<defaultBranch>..HEAD が非0（差分あり）
  it("returns true when there are commits ahead and the diff is non-empty", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "2\n", stderr: "" });
    runner.on(["git", "-C", "/wt/x", "diff", "--quiet"], { code: 1, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(true);

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "rev-list", "--count", "origin/main..HEAD"],
      opts: { cwd: "/wt/x" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "diff", "--quiet", "origin/main..HEAD"],
      opts: { cwd: "/wt/x" },
    });
  });

  it("returns false when there are zero commits ahead (skips diff check)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "0\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(false);
    // count==0 で短絡し diff は呼ばない
    expect(runner.calls).toHaveLength(1);
  });

  it("returns false when commits exist but diff --quiet reports no diff (code 0)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], { code: 0, stdout: "3\n", stderr: "" });
    runner.on(["git", "-C", "/wt/x", "diff", "--quiet"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasCommitsWithDiff("/wt/x")).toBe(false);
  });
});

describe("GitPrManager.hasUncommittedChanges", () => {
  // カーネル §5.2: git status --porcelain 非空
  it("returns true when status --porcelain output is non-empty", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], {
      code: 0,
      stdout: " M src/a.ts\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasUncommittedChanges("/wt/x")).toBe(true);
    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "status", "--porcelain"],
      opts: { cwd: "/wt/x" },
    });
  });

  it("returns false when status --porcelain output is empty (whitespace only)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], { code: 0, stdout: "\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasUncommittedChanges("/wt/x")).toBe(false);
  });
});

describe("GitPrManager.findOpenPrForBranch", () => {
  // カーネル §5.3: gh pr list -R <o/n> --head <branch> --state open --json number
  it("issues the exact gh pr list argv and parses the first PR number from JSON", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: '[{"number":42}]',
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const n = await mgr.findOpenPrForBranch("looppilot/ty-123-x");
    expect(n).toBe(42);

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: [
        "pr",
        "list",
        "-R",
        "owner/name",
        "--head",
        "looppilot/ty-123-x",
        "--state",
        "open",
        "--json",
        "number",
      ],
      opts: { cwd: "/repo" },
    });
  });

  it("returns null when the JSON array is empty (no open PR)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.findOpenPrForBranch("looppilot/ty-123-x")).toBe(null);
  });
});

describe("GitPrManager.pushAndOpenPr", () => {
  // カーネル §5.2 push: git -C <wt> push -u origin <branch>
  // カーネル §5.3 create: gh pr create -R <o/n> --base <defaultBranch> --head <branch>
  //                       --title "<identifier>: <title>" --body <本文>
  // PR番号: stdout 末尾 URL の /pull/(\d+)
  it("pushes then creates the PR with template-substituted body and parses the PR number", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], {
      code: 0,
      stdout: "https://github.com/owner/name/pull/57\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const branch = "looppilot/ty-123-x";
    const n = await mgr.pushAndOpenPr(branch, "/wt/x", issue());
    expect(n).toBe(57);

    // push の argv（cwd=worktree）
    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "push", "-u", "origin", branch],
      opts: { cwd: "/wt/x" },
    });

    // gh pr create の argv。--body は template 置換済み完成本文を直渡し
    const expectedBody =
      "Implements TY-123: Add the login flow!\n\n" +
      "https://linear.app/team/issue/TY-123\n";
    expect(runner.calls[1]).toEqual({
      cmd: "gh",
      args: [
        "pr",
        "create",
        "-R",
        "owner/name",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        "TY-123: Add the login flow!",
        "--body",
        expectedBody,
      ],
      opts: { cwd: "/repo" },
    });
  });

  it("throws when the PR create stdout has no /pull/<n> URL", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], {
      code: 0,
      stdout: "https://github.com/owner/name/tree/looppilot\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(
      mgr.pushAndOpenPr("looppilot/ty-123-x", "/wt/x", issue()),
    ).rejects.toThrow(/PR number/);
  });
});
