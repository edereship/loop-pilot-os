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
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    // slug: "add the login flow!" → "add-the-login-flow"（30字以内、末尾 ! は除去）
    const branch = "looppilot/ty-123-add-the-login-flow";
    const wtPath = "/wt/ty-123-add-the-login-flow";
    expect(result).toEqual({ branch, worktreePath: wtPath });

    // calls[0] is the ES-531 stale-PR lookup (gh pr list); fetch/worktree add follow.
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "fetch", "origin", "main"],
      opts: { cwd: "/repo", timeoutMs: 120_000 },
    });
    expect(runner.calls[2]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "worktree", "add", "-b", branch, wtPath, "origin/main"],
      opts: { cwd: "/repo", timeoutMs: 30_000 },
    });
  });

  it("appends -2 on 'already exists' collision and adds the worktree on the retried branch", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });
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
    // fetch + 2 回の worktree add（gh pr list の args[5] も truthy になり得るため、
    // worktree add の呼び出しに絞って branch 引数を検証する）
    const worktreeAddBranches = runner.calls
      .filter((c) => c.cmd === "git" && c.args[3] === "add")
      .map((c) => c.args[5]);
    expect(worktreeAddBranches).toEqual([
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
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });
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
    // gh pr list（ES-531 の旧PR検索）+ fetch のみ実行し、worktree add は一切呼ばない
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
    const adds = runner.calls.filter((c) => c.args[3] === "add");
    expect(adds).toHaveLength(0);
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

  // ES-531: 旧セッションで park された PR を worktree 作成後にクローズし、リモートブランチも削除する
  // Finding 1: close is deferred until after worktree creation so a transient fetch/add
  // failure does not leave the ticket with no open PR.
  // Finding 2: the stale remote branch is deleted to prevent non-fast-forward push failures.
  it("closes existing open PRs AFTER worktree creation and deletes their remote branches (ES-531 F1+F2)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 7, headRefName: "looppilot/ty-123-add-the-login-flow" },
      ]),
      stderr: "",
    });
    runner.on(["gh", "pr", "close"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "push", "origin", "--delete"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.prepareWorktree(issue());

    // PR close must happen AFTER worktree add (Finding 1: defer until claim succeeds)
    const closeCall = runner.calls.find(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "close");
    const addCall = runner.calls.find(c => c.cmd === "git" && c.args[3] === "worktree" && c.args[4] === "add");
    expect(closeCall).toBeDefined();
    expect(closeCall!.args).toEqual(["pr", "close", "7", "-R", "owner/name"]);
    const closeIdx = runner.calls.indexOf(closeCall!);
    const addIdx = runner.calls.indexOf(addCall!);
    expect(closeIdx).toBeGreaterThan(addIdx);

    // Remote branch must be deleted after PR close (Finding 2: prevent non-fast-forward push)
    const deleteCall = runner.calls.find(c => c.cmd === "git" && c.args.includes("--delete"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.args).toEqual(["-C", "/repo", "push", "origin", "--delete", "looppilot/ty-123-add-the-login-flow"]);
    const deleteIdx = runner.calls.indexOf(deleteCall!);
    expect(deleteIdx).toBeGreaterThan(closeIdx);

    expect(result.branch).toBe("looppilot/ty-123-add-the-login-flow");
  });

  it("skips PR close when no existing PRs are found", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 0, stdout: "[]", stderr: "" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.prepareWorktree(issue());

    const closeCalls = runner.calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "close");
    expect(closeCalls).toHaveLength(0);
  });

  it("logs and continues when stale PR lookup fails (non-fatal)", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], { code: 1, stdout: "", stderr: "rate limit" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    const result = await mgr.prepareWorktree(issue());

    expect(result.branch).toBe("looppilot/ty-123-add-the-login-flow");
    expect(logs.some(l => l.includes("stale PRs") && l.includes("non-fatal"))).toBe(true);
  });

  it("closes multiple stale PRs for the same issue and deletes their remote branches", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 7, headRefName: "looppilot/ty-123-add-the-login-flow" },
        { number: 12, headRefName: "looppilot/ty-123-add-the-login-flow-2" },
      ]),
      stderr: "",
    });
    runner.on(["gh", "pr", "close"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "push", "origin", "--delete"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.prepareWorktree(issue());

    const closeCalls = runner.calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "close");
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0].args[2]).toBe("7");
    expect(closeCalls[1].args[2]).toBe("12");

    // Remote branches must also be deleted for each stale PR (Finding 2)
    const deleteCalls = runner.calls.filter(c => c.cmd === "git" && c.args.includes("--delete"));
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0].args[5]).toBe("looppilot/ty-123-add-the-login-flow");
    expect(deleteCalls[1].args[5]).toBe("looppilot/ty-123-add-the-login-flow-2");
  });

  it("continues closing remaining PRs when one closePr fails, and still deletes remote branches", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 7, headRefName: "looppilot/ty-123-add-the-login-flow" },
        { number: 12, headRefName: "looppilot/ty-123-add-the-login-flow-2" },
      ]),
      stderr: "",
    });
    runner.on(["gh", "pr", "close"], (args) => {
      if (args[2] === "7") return { code: 1, stdout: "", stderr: "network timeout" };
      return { code: 0, stdout: "", stderr: "" };
    });
    runner.on(["git", "-C", "/repo", "push", "origin", "--delete"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    const result = await mgr.prepareWorktree(issue());

    expect(result.branch).toBe("looppilot/ty-123-add-the-login-flow");
    // PR #7 close failed but #12 was still attempted
    const closeCalls = runner.calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "close");
    expect(closeCalls).toHaveLength(2);
    expect(logs.some(l => l.includes("#7") && l.includes("non-fatal"))).toBe(true);
    expect(logs.some(l => l.includes("closed stale PR #12"))).toBe(true);
    // Remote branch deletes are attempted for both PRs regardless of close outcome (Finding 2)
    const deleteCalls = runner.calls.filter(c => c.cmd === "git" && c.args.includes("--delete"));
    expect(deleteCalls).toHaveLength(2);
  });

  // ES-531 Finding 2: "remote ref does not exist" is benign — GitHub may auto-delete
  // the remote branch when the PR is closed.
  it("treats remote-ref-does-not-exist as benign when deleting stale remote branch", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 7, headRefName: "looppilot/ty-123-add-the-login-flow" },
      ]),
      stderr: "",
    });
    runner.on(["gh", "pr", "close"], { code: 0, stdout: "", stderr: "" });
    // Simulate GitHub already having deleted the branch when the PR was closed
    runner.on(["git", "-C", "/repo", "push", "origin", "--delete"], {
      code: 1,
      stdout: "",
      stderr: "error: remote ref does not exist",
    });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    // Must not throw — "remote ref does not exist" is treated as already-deleted
    await expect(mgr.prepareWorktree(issue())).resolves.toBeDefined();
    // No non-fatal log for the benign "does not exist" case
    expect(logs.some(l => l.includes("failed to delete stale remote branch"))).toBe(false);
  });

  // ES-531 Finding 2: a genuine remote branch delete failure (e.g. network error) is
  // non-fatal — prepareWorktree succeeds and the failure is logged.
  it("remote branch delete failure is non-fatal and is logged", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 7, headRefName: "looppilot/ty-123-add-the-login-flow" },
      ]),
      stderr: "",
    });
    runner.on(["gh", "pr", "close"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "push", "origin", "--delete"], {
      code: 1,
      stdout: "",
      stderr: "fatal: unable to access remote",
    });
    runner.on(["git", "-C", "/repo", "fetch"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "worktree", "add"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    const result = await mgr.prepareWorktree(issue());

    expect(result.branch).toBe("looppilot/ty-123-add-the-login-flow");
    expect(logs.some(l => l.includes("failed to delete stale remote branch") && l.includes("non-fatal"))).toBe(true);
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

  // ES-463: git branch -D 失敗時は warning ログ、throw しない
  it("logs warning when git branch -D fails but does not throw", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "worktree", "remove"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "branch", "-D"], {
      code: 1,
      stdout: "",
      stderr: "error: branch 'looppilot/ty-123-x' not found.",
    });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    await mgr.discardWorktree("looppilot/ty-123-x", "/wt/ty-123-x");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/git branch -D failed/);
    expect(logs[0]).toContain("looppilot/ty-123-x");
  });

  // ES-463: git worktree remove 失敗時もログし、branch -D は試行する
  it("logs warning when git worktree remove fails and still attempts branch -D", async () => {
    const logs: string[] = [];
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "worktree", "remove"], {
      code: 128,
      stdout: "",
      stderr: "fatal: '/wt/ty-123-x' is not a valid directory",
    });
    runner.on(["git", "-C", "/repo", "branch", "-D"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, { ...OPTS, log: (line) => logs.push(line) });
    await mgr.discardWorktree("looppilot/ty-123-x", "/wt/ty-123-x");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/git worktree remove failed/);
    expect(runner.calls).toHaveLength(2);
  });

  // ES-463: log なしでも安全に動作する（既存コードの後方互換）
  it("does not throw when log is not provided and a step fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/repo", "worktree", "remove"], { code: 0, stdout: "", stderr: "" });
    runner.on(["git", "-C", "/repo", "branch", "-D"], {
      code: 1,
      stdout: "",
      stderr: "error: branch not found",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.discardWorktree("looppilot/ty-123-x", "/wt/ty-123-x")).resolves.toBeUndefined();
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

describe("GitPrManager.fetchCiLogs", () => {
  const RUN_LIST_PREFIX = ["gh", "run", "list", "-R", "owner/name"];
  const runsJson = (conclusion: string, status = "completed") =>
    JSON.stringify([{ databaseId: 999, conclusion, status }]);

  // ES-493 Finding 1: failure conclusion → --log-failed (only failed step output)
  it("uses --log-failed for conclusion=failure", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 0, stdout: runsJson("failure") });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "step output\n" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    expect(viewCall!.args).toContain("--log-failed");
    expect(viewCall!.args).not.toContain("--log");
  });

  // ES-493 Finding 1: non-failure conclusions have no failed steps, so --log-failed
  // returns nothing. Use --log to capture diagnostics for timed_out/cancelled/etc.
  it("uses --log for conclusion=timed_out", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 0, stdout: runsJson("timed_out") });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "partial output\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    expect(viewCall!.args).toContain("--log");
    expect(viewCall!.args).not.toContain("--log-failed");
    expect(logs).toBe("partial output\n");
  });

  it("uses --log for conclusion=cancelled", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 0, stdout: runsJson("cancelled") });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "cancelled output\n" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall!.args).toContain("--log");
    expect(viewCall!.args).not.toContain("--log-failed");
  });

  it("uses --log for conclusion=action_required", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 0, stdout: runsJson("action_required") });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "action output\n" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall!.args).toContain("--log");
    expect(viewCall!.args).not.toContain("--log-failed");
  });

  it("returns null when all runs are green (no non-success conclusion)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([{ databaseId: 1, conclusion: "success" }]),
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix");
    expect(result).toBeNull();
  });

  it("returns null when gh run list fails", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 1, stdout: "" });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix");
    expect(result).toBeNull();
  });

  // ES-493 Finding 1 (Codex): --limit must be high enough that the failing run is not
  // outside the cap when there are many workflows on the same commit.
  it("passes --limit >= 20 so the failing run is not outside the cap in busy repos", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, { code: 0, stdout: runsJson("failure") });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "output\n" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    const listCall = runner.calls.find(
      (c) => c.cmd === "gh" && c.args.includes("list") && c.args.includes("--limit"),
    );
    expect(listCall).toBeDefined();
    const limitIdx = listCall!.args.indexOf("--limit");
    const limitValue = parseInt(listCall!.args[limitIdx + 1], 10);
    expect(limitValue).toBeGreaterThanOrEqual(20);
  });

  // ES-493 Finding 1 (this PR): in-progress/queued runs have conclusion="" and must be
  // skipped so the completed failed run is selected instead.
  it("skips in_progress run and returns logs from the completed failed run", async () => {
    const runner = new FakeCommandRunner();
    // First run is in_progress with empty conclusion, second is the completed failure.
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 100, conclusion: "", status: "in_progress" },
        { databaseId: 200, conclusion: "failure", status: "completed" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // Must have fetched the completed run (200), not the in-progress one (100).
    expect(viewCall!.args).toContain("200");
    expect(viewCall!.args).not.toContain("100");
  });

  it("returns null when all runs are in_progress (no completed run)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 100, conclusion: "", status: "in_progress" },
        { databaseId: 101, conclusion: "", status: "queued" },
      ]),
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");
    expect(result).toBeNull();
  });

  // ES-493 Iteration 7 Finding 1: a workflow that failed and was later rerun successfully
  // must not have its stale failure selected. Only the most recent completed run per workflow
  // is considered; if it is green the workflow is treated as passing and excluded.
  it("skips superseded failure when a later run of the same workflow succeeded (ES-493 Finding 1)", async () => {
    const runner = new FakeCommandRunner();
    // gh run list returns newest-first. workflow-a's latest run succeeded (rerun); the old
    // failure is superseded. workflow-b is still failing.
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 300, conclusion: "success",  status: "completed", workflowName: "workflow-a" },
        { databaseId: 100, conclusion: "failure",  status: "completed", workflowName: "workflow-a" },
        { databaseId: 200, conclusion: "failure",  status: "completed", workflowName: "workflow-b" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "workflow-b logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("workflow-b logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // workflow-b's failing run (200) must be selected, not workflow-a's superseded failure (100).
    expect(viewCall!.args).toContain("200");
    expect(viewCall!.args).not.toContain("100");
    expect(viewCall!.args).not.toContain("300");
  });

  it("selects the failing run even when a newer in_progress run exists for the same workflow", async () => {
    const runner = new FakeCommandRunner();
    // workflow-a's rerun is in_progress; the most recent COMPLETED run is still the failure.
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 200, conclusion: "",        status: "in_progress", workflowName: "workflow-a" },
        { databaseId: 100, conclusion: "failure", status: "completed",   workflowName: "workflow-a" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    expect(viewCall!.args).toContain("100");
  });

  // ES-493 Iteration 8 Finding 1: org/enterprise ruleset workflows may omit workflowName.
  // Each unnamed run must be keyed by workflowDatabaseId so a green ruleset run for one
  // workflow does not suppress a failing run of a different unnamed workflow.
  it("keys unnamed workflows by workflowDatabaseId so distinct unnamed workflows are not grouped", async () => {
    const runner = new FakeCommandRunner();
    // Two unnamed workflows (workflowName absent): workflow 10 succeeded, workflow 20 failed.
    // Without the fix both would share key "" and the newer green run (300) would suppress
    // the failing run (200) from a completely different ruleset workflow.
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 300, conclusion: "success", status: "completed", workflowDatabaseId: 10 },
        { databaseId: 200, conclusion: "failure", status: "completed", workflowDatabaseId: 20 },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "ruleset failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("ruleset failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // Must have fetched the failing unnamed workflow run (200), not the green one (300).
    expect(viewCall!.args).toContain("200");
    expect(viewCall!.args).not.toContain("300");
  });

  // ES-493 Iteration 9 Finding 1: gh CLI sets workflowName="" (empty string) on the
  // ruleset 404 path. ?? treats "" as present so all unnamed workflows share key "".
  // Using || instead ensures "" falls back to the workflowDatabaseId-based key.
  it("keys empty-string workflowName workflows by workflowDatabaseId (ruleset 404 path)", async () => {
    const runner = new FakeCommandRunner();
    // Two runs where gh CLI returned workflowName="" for both but different workflowDatabaseId.
    // Workflow 10 succeeded, workflow 20 failed. Without the fix the green run (300) would
    // share key "" with the failing run (200) and suppress it.
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 300, conclusion: "success", status: "completed", workflowName: "", workflowDatabaseId: 10 },
        { databaseId: 200, conclusion: "failure", status: "completed", workflowName: "", workflowDatabaseId: 20 },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "empty-name ruleset failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("empty-name ruleset failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // Must have fetched the failing run (200), not the green one (300).
    expect(viewCall!.args).toContain("200");
    expect(viewCall!.args).not.toContain("300");
  });

  // ES-493 Iteration 10 Finding 3: two workflow files with the same display name but
  // different workflowDatabaseId values must not be collapsed into one bucket. Without
  // preferring workflowDatabaseId as the primary key, a green run from workflow A could
  // suppress a failing run from workflow B when both share the same name.
  it("keeps distinct workflows separate when workflowName matches but workflowDatabaseId differs", async () => {
    const runner = new FakeCommandRunner();
    // Two workflows both named "CI" but different database IDs (different workflow files).
    // Workflow 10 (run 300) succeeded; workflow 20 (run 200) failed. Without the fix both
    // share key "CI" and the green run (300, first) suppresses the failing run (200).
    runner.on(RUN_LIST_PREFIX, {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 300, conclusion: "success", status: "completed", workflowName: "CI", workflowDatabaseId: 10 },
        { databaseId: 200, conclusion: "failure", status: "completed", workflowName: "CI", workflowDatabaseId: 20 },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "same-name workflow failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("same-name workflow failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // Must have fetched the failing run (200), not the green run (300).
    expect(viewCall!.args).toContain("200");
    expect(viewCall!.args).not.toContain("300");
  });

  // ES-493 Iteration 12 Finding 1: pull_request workflows use the merge commit SHA as
  // GITHUB_SHA, not the PR head SHA. So --commit <headSha> can miss those runs.
  // If the commit-based search finds no failing run, fall back to --branch search.
  it("falls back to branch when commit-based list finds no failing run (pull_request merge SHA mismatch)", async () => {
    const runner = new FakeCommandRunner();
    // --commit headSha returns empty (no runs match — merge SHA differs from head SHA)
    runner.on(["gh", "run", "list", "-R", "owner/name", "--commit"], {
      code: 0,
      stdout: JSON.stringify([]),
    });
    // --branch returns the pull_request workflow's failing run (headSha matches PR head SHA)
    runner.on(["gh", "run", "list", "-R", "owner/name", "--branch"], {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 500, conclusion: "failure", status: "completed", workflowName: "CI", event: "pull_request", headSha: "abc123" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "pull_request workflow failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("pull_request workflow failure logs\n");
    // The view call must target the run found via branch fallback.
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    expect(viewCall!.args).toContain("500");
    // Both list calls must have been made: commit first, then branch.
    const listCalls = runner.calls.filter((c) => c.cmd === "gh" && c.args.includes("list"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].args).toContain("--commit");
    expect(listCalls[1].args).toContain("--branch");
  });

  it("does not make branch fallback call when commit-based list already found a failing run", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "run", "list", "-R", "owner/name", "--commit"], {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 300, conclusion: "failure", status: "completed", workflowName: "CI", event: "push" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "push workflow failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("push workflow failure logs\n");
    // Only one list call: no branch fallback needed.
    const listCalls = runner.calls.filter((c) => c.cmd === "gh" && c.args.includes("list"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args).toContain("--commit");
  });

  // Codex Finding 1: branch fallback must filter runs by headSha to avoid injecting logs
  // from a stale failed run on an older commit of a long-lived or reused branch.
  it("branch fallback ignores runs from older commits (stale headSha)", async () => {
    const runner = new FakeCommandRunner();
    // --commit headSha returns empty (pull_request merge SHA mismatch)
    runner.on(["gh", "run", "list", "-R", "owner/name", "--commit"], {
      code: 0,
      stdout: JSON.stringify([]),
    });
    // --branch returns two runs: one for the current head SHA and one stale run from an older commit.
    // Without the headSha filter, the stale run (900) would be selected (it appears after the current
    // one but is still the "most recent completed failure" for its workflow key if the current one
    // is from a later submission that only partially shows up).
    runner.on(["gh", "run", "list", "-R", "owner/name", "--branch"], {
      code: 0,
      stdout: JSON.stringify([
        // Stale run from a previous commit — must be excluded.
        { databaseId: 900, conclusion: "failure", status: "completed", workflowName: "CI", event: "pull_request", headSha: "old-sha-from-prior-commit" },
        // Current run for the PR head commit — must be selected.
        { databaseId: 500, conclusion: "failure", status: "completed", workflowName: "CI", event: "pull_request", headSha: "abc123" },
      ]),
    });
    runner.on(["gh", "run", "view"], { code: 0, stdout: "current commit failure logs\n" });

    const mgr = new GitPrManager(runner, OPTS);
    const logs = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    expect(logs).toBe("current commit failure logs\n");
    const viewCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "view");
    expect(viewCall).toBeDefined();
    // Must have selected the current-SHA run (500), not the stale one (900).
    expect(viewCall!.args).toContain("500");
    expect(viewCall!.args).not.toContain("900");
  });

  // Codex Finding 1: when the branch fallback finds only stale runs (none matching headSha),
  // it must return null rather than injecting logs from an unrelated commit.
  it("branch fallback returns null when no run matches headSha", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "run", "list", "-R", "owner/name", "--commit"], {
      code: 0,
      stdout: JSON.stringify([]),
    });
    // --branch returns only a run from an older commit (different headSha).
    runner.on(["gh", "run", "list", "-R", "owner/name", "--branch"], {
      code: 0,
      stdout: JSON.stringify([
        { databaseId: 700, conclusion: "failure", status: "completed", workflowName: "CI", event: "pull_request", headSha: "some-old-commit" },
      ]),
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.fetchCiLogs(1, "looppilot/ty-1-fix", "abc123");

    // Must return null: no run matches the current PR head SHA.
    expect(result).toBeNull();
  });
});

describe("GitPrManager.findOpenPrsForIssue", () => {
  it("returns PR numbers for branches matching the issue identifier prefix", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 10, headRefName: "looppilot/ty-123-add-the-login-flow" },
        { number: 15, headRefName: "looppilot/ty-123-add-the-login-flow-2" },
      ]),
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.findOpenPrsForIssue("TY-123");

    expect(result).toEqual([10, 15]);
    expect(runner.calls[0].args).toEqual([
      "pr", "list", "-R", "owner/name",
      "--search", "head:looppilot/ty-123-",
      "--state", "open",
      "--json", "number,headRefName",
    ]);
  });

  it("returns empty array when no matching PRs exist", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: "[]",
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.findOpenPrsForIssue("TY-999");

    expect(result).toEqual([]);
  });

  it("throws on non-zero exit", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 1,
      stdout: "",
      stderr: "auth required",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.findOpenPrsForIssue("TY-123")).rejects.toThrow(/auth required/);
  });

  it("filters out branches that do not match the identifier prefix", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "list"], {
      code: 0,
      stdout: JSON.stringify([
        { number: 10, headRefName: "looppilot/ty-123-add-login" },
        { number: 20, headRefName: "looppilot/ty-1234-other-issue" },
      ]),
      stderr: "",
    });

    const mgr = new GitPrManager(runner, OPTS);
    const result = await mgr.findOpenPrsForIssue("TY-123");

    expect(result).toEqual([10]);
  });
});

describe("GitPrManager.closePr", () => {
  it("closes the PR via gh pr close", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "close"], { code: 0, stdout: "", stderr: "" });

    const mgr = new GitPrManager(runner, OPTS);
    await mgr.closePr(42);

    expect(runner.calls[0].args).toEqual([
      "pr", "close", "42", "-R", "owner/name",
    ]);
  });

  it("tolerates already-closed errors", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "close"], {
      code: 1,
      stdout: "",
      stderr: "already closed",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.closePr(42)).resolves.toBeUndefined();
  });

  it("throws on other non-zero exits", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "close"], {
      code: 1,
      stdout: "",
      stderr: "network error",
    });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.closePr(42)).rejects.toThrow(/network error/);
  });
});
