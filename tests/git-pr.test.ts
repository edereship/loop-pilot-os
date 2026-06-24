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
      opts: { cwd: "/repo", timeoutMs: 120_000 },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "add", "-b", branch, wtPath, "origin/main"],
      opts: { cwd: "/repo", timeoutMs: 30_000 },
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

  // 本プロジェクトの実チケットは日本語タイトル。slug 規則（カーネル§5.2: 英数字以外をハイフン圧縮）に従うと
  // 日本語のみのタイトルは識別子のみのブランチ名になる — この挙動を意図的なものとしてピン留めする。
  it("produces an identifier-only branch for a Japanese-only title", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(
      issue({ title: "ログインフローを追加する", identifier: "TY-123" }),
    );
    // 日本語は [^a-z0-9]+ にマッチするため slugify → ""。
    // branch = "<branchPrefix>/<id小文字>-" (末尾ハイフンは slugify 後に id との連結部として残る)
    expect(result.branch).toBe("looppilot/ty-123-");
    expect(result.worktreePath.endsWith("ty-123-")).toBe(true);
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
      opts: { cwd: "/wt/x", timeoutMs: 30_000 },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/wt/x", "diff", "--quiet", "origin/main..HEAD"],
      opts: { cwd: "/wt/x", timeoutMs: 30_000 },
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

  // Finding 1: when the worktree path is missing or inaccessible, git rev-list returns
  // non-zero. The method must throw so the orchestrator's catch block can treat the
  // situation as "has work" and take the safe manual-cleanup path instead of discarding
  // the worktree and reverting the ticket.
  it("throws when rev-list fails (e.g. worktree missing or inaccessible)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "rev-list"], {
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.hasCommitsWithDiff("/wt/x")).rejects.toThrow(/git rev-list failed/);
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
      opts: { cwd: "/wt/x", timeoutMs: 30_000 },
    });
  });

  it("returns false when status --porcelain output is empty (whitespace only)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], { code: 0, stdout: "\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.hasUncommittedChanges("/wt/x")).toBe(false);
  });

  // Finding 1: when the worktree path is missing or inaccessible, git status returns
  // non-zero. The method must throw so the orchestrator's catch block can treat the
  // situation as "has work" and avoid destroying the worktree prematurely.
  it("throws when status --porcelain fails (e.g. worktree missing or inaccessible)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "status"], {
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.hasUncommittedChanges("/wt/x")).rejects.toThrow(/git status failed/);
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
      opts: { cwd: "/repo", timeoutMs: 60_000 },
    });
  });

  it("returns null when the JSON array is empty (no open PR)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    expect(await mgr.findOpenPrForBranch("looppilot/ty-123-x")).toBe(null);
  });

  // 他の gh ラッパ（pushAndOpenPr/addLabel/mergePr）と一貫させ、非0終了は throw。
  // gh の一時障害（auth 失効/レート制限）で stdout が空/HTML/部分でも JSON.parse の
  // 偶発 SyntaxError に頼らず、明示エラーで失敗を上げる。
  it("throws on non-zero gh exit instead of JSON.parse of garbage", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 1,
      stdout: "",
      stderr: "gh: API rate limit exceeded",
    });
    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.findOpenPrForBranch("looppilot/ty-123-x")).rejects.toThrow(
      /gh pr list/,
    );
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
      opts: { cwd: "/wt/x", timeoutMs: 120_000 },
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
      opts: { cwd: "/repo", timeoutMs: 60_000 },
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

  it("throws with stderr when git push fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], {
      code: 1,
      stdout: "",
      stderr: "remote: permission denied\n",
    });
    runner.on(["gh", "pr", "create"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const branch = "looppilot/ty-123-x";
    await expect(mgr.pushAndOpenPr(branch, "/wt/x", issue())).rejects.toThrow(
      /git push failed.*permission denied/,
    );
    // gh pr create は呼ばれてはならない
    const createCalls = runner.calls.filter(
      (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "create",
    );
    expect(createCalls).toHaveLength(0);
  });

  it("throws with stderr when gh pr create fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/x", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], {
      code: 1,
      stdout: "",
      stderr: "GraphQL: was submitted too quickly",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const branch = "looppilot/ty-123-x";
    await expect(mgr.pushAndOpenPr(branch, "/wt/x", issue())).rejects.toThrow(
      /gh pr create failed.*too quickly/,
    );
    // 誤解を招く "parse error" ではなく、意図したエラーが上がること
    await expect(mgr.pushAndOpenPr(branch, "/wt/x", issue())).rejects.not.toThrow(
      /could not parse PR number/,
    );
  });
});

describe("GitPrManager.addLabel", () => {
  // カーネル §5.3: gh pr edit <n> -R <o/n> --add-label <gate_label>
  it("issues the exact gh pr edit argv with the gate label", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "edit"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.addLabel(57, "loop-pilot");

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: ["pr", "edit", "57", "-R", "owner/name", "--add-label", "loop-pilot"],
      opts: { cwd: "/repo", timeoutMs: 60_000 },
    });
  });

  it("throws when gh pr edit exits non-zero", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "edit"], { code: 1, stdout: "", stderr: "label not found" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.addLabel(57, "loop-pilot")).rejects.toThrow(/label not found/);
  });
});

describe("GitPrManager.mergePr", () => {
  // カーネル §5.3: gh pr merge <n> -R <o/n> --squash --match-head-commit <headSha>
  it("issues the exact gh pr merge argv with squash and match-head-commit", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.mergePr(57, "deadbeef");

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: ["pr", "merge", "57", "-R", "owner/name", "--squash", "--match-head-commit", "deadbeef"],
      opts: { cwd: "/repo", timeoutMs: 60_000 },
    });
  });

  it("throws when gh pr merge exits non-zero (caller maps to ci_failed/conflict)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 1, stdout: "", stderr: "not mergeable" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.mergePr(57, "deadbeef")).rejects.toThrow(/not mergeable/);
  });
});

describe("GitPrManager.getPrDiffSummary", () => {
  // カーネル §ES-382: gh pr view --json title,body + gh pr diff でサマリを返す。
  it("returns title, body, and diff from gh commands", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "42"], (args) => {
      if (args.includes("--json")) {
        return { code: 0, stdout: JSON.stringify({ title: "TY-1: Fix bug", body: "Fixes the login bug" }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    runner.on(["gh", "pr", "diff", "42"], {
      code: 0,
      stdout: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1,2 @@\n line\n+added\n",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.getPrDiffSummary(42);
    expect(result.title).toBe("TY-1: Fix bug");
    expect(result.body).toBe("Fixes the login bug");
    expect(result.diff).toContain("diff --git");
  });

  // GitHub API は body が null を返し得る。null は空文字に正規化する。
  it("coerces a null body to an empty string", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "42"], {
      code: 0,
      stdout: JSON.stringify({ title: "TY-2: Add feature", body: null }),
      stderr: "",
    });
    runner.on(["gh", "pr", "diff", "42"], { code: 0, stdout: "diff --git a/x b/x\n", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.getPrDiffSummary(42);
    expect(result.body).toBe("");
  });

  it("throws when gh pr view exits non-zero", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "99"], { code: 1, stdout: "", stderr: "not found" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.getPrDiffSummary(99)).rejects.toThrow(/gh pr view failed/);
  });

  it("throws when gh pr diff exits non-zero", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "99"], {
      code: 0,
      stdout: JSON.stringify({ title: "TY-3: Some fix", body: "body" }),
      stderr: "",
    });
    runner.on(["gh", "pr", "diff", "99"], { code: 1, stdout: "", stderr: "diff failed" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.getPrDiffSummary(99)).rejects.toThrow(/gh pr diff failed/);
  });

  it("throws descriptive error when gh pr view returns unparseable JSON", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "42"], {
      code: 0,
      stdout: "<html>502 Bad Gateway</html>",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.getPrDiffSummary(42)).rejects.toThrow(/unparseable JSON/);
  });
});

describe("GitPrManager.discardWorktree", () => {
  // カーネル §5.2: worktree remove --force <wt> → branch -D <branch>（この順）
  it("removes the worktree first then deletes the branch, in that order", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "worktree", "remove"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "branch", "-D"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.discardWorktree("looppilot/ty-123-x", "/wt/ty-123-x");

    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "remove", "--force", "/wt/ty-123-x"],
      opts: { cwd: "/repo", timeoutMs: 30_000 },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "branch", "-D", "looppilot/ty-123-x"],
      opts: { cwd: "/repo", timeoutMs: 30_000 },
    });
    expect(runner.calls).toHaveLength(2);
  });
});

describe("GitPrManager.postComment", () => {
  it("issues gh api to post a comment on the given PR number", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "api"], { code: 0, stdout: "{}", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.postComment(42, "/restart-review");

    expect(runner.calls[0]).toEqual({
      cmd: "gh",
      args: [
        "api",
        "repos/owner/name/issues/42/comments",
        "-f",
        "body=/restart-review",
      ],
      opts: { cwd: "/repo", timeoutMs: 60_000 },
    });
  });

  it("throws when gh api exits non-zero", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "api"], { code: 1, stdout: "", stderr: "Not Found" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.postComment(42, "hello")).rejects.toThrow(/postComment.*Not Found/);
  });
});

describe("GitPrManager.fetchDefaultBranch", () => {
  it("issues git fetch then git reset --hard in sequence", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch", "origin", "main"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "reset", "--hard", "origin/main"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.fetchDefaultBranch();

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "fetch", "origin", "main"],
      opts: { cwd: "/repo", timeoutMs: 120_000 },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "reset", "--hard", "origin/main"],
      opts: { cwd: "/repo", timeoutMs: 30_000 },
    });
  });

  it("throws and skips reset when git fetch fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch", "origin", "main"], {
      code: 128,
      stdout: "",
      stderr: "fatal: unable to access remote",
    });
    runner.on(["git", "-C", "/repo", "reset", "--hard", "origin/main"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.fetchDefaultBranch()).rejects.toThrow(/git fetch origin main failed/);
    // reset must not be called when fetch fails
    const resets = runner.calls.filter((c) => c.args[3] === "reset");
    expect(resets).toHaveLength(0);
  });

  it("throws when git reset --hard fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch", "origin", "main"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "reset", "--hard", "origin/main"], {
      code: 1,
      stdout: "",
      stderr: "fatal: could not reset",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.fetchDefaultBranch()).rejects.toThrow(/git reset --hard origin\/main failed/);
  });
});

describe("GitPrManager.getPrDiffSummary (maxDiffChars)", () => {
  it("truncates diff to maxDiffChars when the fetched diff exceeds the limit", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "42"], {
      code: 0,
      stdout: JSON.stringify({ title: "TY-1: Big PR", body: "large change" }),
      stderr: "",
    });
    const longDiff = "diff --git a/x.ts b/x.ts\n" + "+".repeat(500);
    runner.on(["gh", "pr", "diff", "42"], { code: 0, stdout: longDiff, stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.getPrDiffSummary(42, 100);
    expect(result.diff.length).toBe(100);
    expect(result.diff).toBe(longDiff.slice(0, 100));
  });

  it("returns the full diff when it is within maxDiffChars", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view", "7"], {
      code: 0,
      stdout: JSON.stringify({ title: "TY-2: Small PR", body: "" }),
      stderr: "",
    });
    const smallDiff = "diff --git a/x.ts b/x.ts\n+line\n";
    runner.on(["gh", "pr", "diff", "7"], { code: 0, stdout: smallDiff, stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.getPrDiffSummary(7, 10000);
    expect(result.diff).toBe(smallDiff);
  });
});

describe("GitPrManager — runner.run に timeoutMs が設定される (ES-465)", () => {
  it("prepareWorktree の全 runner.run 呼び出しに timeoutMs が設定される", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });
    const mgr = new GitPrManager(runner, OPTS);
    await mgr.prepareWorktree(issue());
    for (const call of runner.calls) {
      expect(call.opts.timeoutMs, `${call.cmd} ${call.args.join(" ")}`).toBeTypeOf("number");
      expect(call.opts.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("pushAndOpenPr の全 runner.run 呼び出しに timeoutMs が設定される", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt/test", "push"], { code: 0, stdout: "", stderr: "" });
    runner.on(["gh", "pr", "create"], { code: 0, stdout: "https://github.com/owner/name/pull/42\n", stderr: "" });
    const mgr = new GitPrManager(runner, OPTS);
    await mgr.pushAndOpenPr("looppilot/ty-123-test", "/wt/test", issue());
    for (const call of runner.calls) {
      expect(call.opts.timeoutMs, `${call.cmd} ${call.args.join(" ")}`).toBeTypeOf("number");
      expect(call.opts.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("mergePr の runner.run 呼び出しに timeoutMs が設定される", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 0, stdout: "", stderr: "" });
    const mgr = new GitPrManager(runner, OPTS);
    await mgr.mergePr(10, "abc123");
    for (const call of runner.calls) {
      expect(call.opts.timeoutMs, `${call.cmd} ${call.args.join(" ")}`).toBeTypeOf("number");
      expect(call.opts.timeoutMs).toBeGreaterThan(0);
    }
  });
});
