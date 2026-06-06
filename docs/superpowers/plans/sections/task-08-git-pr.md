### Task 8: Git/PR Manager

**目的**: 封筒（envelope）担当の `GitPrManager` を実装する。CLAIM フェーズの worktree/ブランチ作成、IMPLEMENT 後条件の実差分・未コミット検査、HANDOFF の push→PR作成→ラベル、DONE のマージ、cost_exceeded 時の破棄を、すべて `git`/`gh` CLI 呼び出しに翻訳する。コマンドの argv は本体を一切実行せず `CommandRunner` 抽象越しに発行し、テストは `FakeCommandRunner` で argv 完全一致（cwd 含む）を検証する。実 git/gh は使わない。

**依存タスク**: Task 2（`src/types.ts` の `GitPrManager`/`CommandRunner`/`EligibleIssue`/`ClaimResult`/`CommandResult`/`RunOptions` 型）、Task 3（`src/exec.ts` の実 `CommandRunner` と `tests/fakes.ts` の `FakeCommandRunner`/`FakeCommandRunner.on`）。本タスクはこれらの export を**消費する**だけで再定義しない。

**契約の出所**: 構築引数はカーネル §2 の `GitPrManager` インターフェース全メソッド + 本タスクスコープの opts。コマンド文字列はカーネル §5.2（git）/ §5.3（gh）と**一字一句一致**。slug 規則・衝突サフィックス・PR番号 parse は §5.2/§5.3 + 仕様 §5 CLAIM/HANDOFF。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/git-pr.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/git-pr.test.ts`

---

#### 設計メモ（実装前に固定する不変条件）

- 構築: `new GitPrManager(runner, opts)`。`runner: CommandRunner`、`opts: { repoPath: string; remote: string; defaultBranch: string; branchPrefix: string; worktreeRoot: string; prBodyTemplate: string; gateLabel: string }`。すべて Config 由来で解決済み（`worktreeRoot` は既定値解決済みの絶対パス）。
- `runner.run(cmd, args, opts)` の `opts.cwd` は **必ず明示**する。`git -C <path>` 形式で path を渡すコマンドでも cwd は `repoPath`（または worktree path）を渡す（§5.2 は `git -C` を使うが、CommandRunner は cwd 必須なので両方そろえる。テストは cwd を含めて検証する）。gh コマンドは `-R <remote>` でリポを指定するため cwd は `repoPath` を渡す。
- slug: `slugify(title)` = title を小文字化し `[^a-z0-9]+` を `-` に圧縮、先頭末尾の `-` を除去、30 文字に切詰め（切詰め後の末尾 `-` も除去）。identifier も小文字化。ブランチ名 = `<branchPrefix>/<identifier小文字>-<slug>`。
- fetch: `prepareWorktree` 先頭の `git fetch origin <defaultBranch>` は `code != 0`（ネットワーク断・remote 不達等）なら**即 throw**し、`worktree add` を一切呼ばない。陳腐化したローカル ref（古い `origin/<defaultBranch>`）の上で worktree を作る実害を防ぎ、カーネル §2『失敗は throw』契約と Orchestrator §7 step3『prepareWorktree 失敗 → HALT』安全弁を成立させる。
- 衝突: `git worktree add` が `code != 0` かつ stderr に `already exists` を含む場合のみ衝突とみなし、ブランチ名末尾に `-2`..`-5` を付けて再試行する。`-5` でも衝突したら throw。`already exists` 以外の失敗は即 throw（衝突ではない）。
- `hasCommitsWithDiff`: `rev-list --count origin/<defaultBranch>..HEAD` の stdout を整数 parse し `> 0`、**かつ** `diff --quiet origin/<defaultBranch>..HEAD` の `code != 0`（差分あり）。両方満たして true。
- `pushAndOpenPr`: push → `gh pr create`（`--body` は `prBodyTemplate` の `{identifier}`/`{title}`/`{issue_url}` を置換した完成本文を spawn 引数として直渡し。一時ファイル不要）→ stdout から `/pull/(\d+)` を抽出して number 化。マッチ無し/NaN は throw。
- `findOpenPrForBranch`: `gh pr list ... --json number` の stdout を `JSON.parse`（配列）。空配列 → `null`、先頭要素の `number` を返す。
- `discardWorktree`: `worktree remove --force` → `branch -D` の順（§5.2）。

---

- [ ] **Step 1: `prepareWorktree` の全挙動（正常系・衝突 -2・全滅・非衝突即throw・fetch失敗ガード・slug切詰め）を網羅する失敗テスト群を書く**

> このステップで `prepareWorktree` が満たすべき 6 挙動すべてを**実装より前に**赤にする。`src/git-pr.ts` が存在しないため、全テストが import 解決エラー（モジュール未作成）で一斉に赤になる。これにより各挙動が「テスト→失敗確認→実装→成功確認」（カーネル §11 line 521）の赤フェーズを必ず一度経る。挙動を後追いテストで「追加→即 green」する赤抜きステップは作らない。

`/home/racoma-dev/loop-pilot-os/tests/git-pr.test.ts` を新規作成:

```typescript
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
```

実行して **失敗** を確認（`src/git-pr.ts` が無いため import 解決エラーで全 6 テストが赤）:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `Failed to resolve import "../src/git-pr.js"` / `Cannot find module`（モジュール未作成）。この時点で 6 テストすべてが赤であることを確認する（衝突・全滅・非衝突即throw・fetch失敗ガード・slug切詰めの各挙動が一度ずつ赤フェーズを経る）。

- [ ] **Step 2: `src/git-pr.ts` に slug ヘルパと `prepareWorktree`（衝突対応・fetch失敗ガード込み）を実装し Step 1 の 6 テストを緑にする**

`/home/racoma-dev/loop-pilot-os/src/git-pr.ts` を新規作成:

```typescript
import type {
  CommandRunner,
  EligibleIssue,
  ClaimResult,
  GitPrManager as GitPrManagerInterface,
} from "./types.js";

export interface GitPrManagerOptions {
  repoPath: string;
  remote: string;
  defaultBranch: string;
  branchPrefix: string;
  worktreeRoot: string;
  prBodyTemplate: string;
  gateLabel: string;
}

/** title を小文字化し英数字以外を "-" に圧縮、先頭末尾 "-" 除去、30字に切詰め */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = base.slice(0, 30);
  return truncated.replace(/-+$/g, "");
}

export class GitPrManager implements GitPrManagerInterface {
  private readonly runner: CommandRunner;
  private readonly opts: GitPrManagerOptions;

  constructor(runner: CommandRunner, opts: GitPrManagerOptions) {
    this.runner = runner;
    this.opts = opts;
  }

  async prepareWorktree(issue: EligibleIssue): Promise<ClaimResult> {
    const { repoPath, defaultBranch, branchPrefix, worktreeRoot } = this.opts;
    const slug = `${issue.identifier.toLowerCase()}-${slugify(issue.title)}`;

    const fetch = await this.runner.run(
      "git",
      ["-C", repoPath, "fetch", "origin", defaultBranch],
      { cwd: repoPath },
    );
    if (fetch.code !== 0) {
      throw new Error(
        `git fetch origin ${defaultBranch} failed: ${fetch.stderr.trim() || `exit ${fetch.code}`}`,
      );
    }

    const suffixes = ["", "-2", "-3", "-4", "-5"];
    for (const suffix of suffixes) {
      const branch = `${branchPrefix}/${slug}${suffix}`;
      const worktreePath = `${worktreeRoot}/${slug}${suffix}`;
      const res = await this.runner.run(
        "git",
        [
          "-C",
          repoPath,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          `origin/${defaultBranch}`,
        ],
        { cwd: repoPath },
      );
      if (res.code === 0) {
        return { branch, worktreePath };
      }
      if (!res.stderr.includes("already exists")) {
        throw new Error(
          `git worktree add failed for ${branch}: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
    }
    throw new Error(
      `git worktree add failed: branch name collision exhausted for ${branchPrefix}/${slug}`,
    );
  }
}
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: 6 tests passed（prepareWorktree describe 全体: 正常系 + 衝突 -2 + 全滅 + 非衝突即throw + fetch失敗ガード + slug切詰め）。Step 1 で import 解決エラーにより赤だった 6 挙動が、この実装で一斉に緑になる（各挙動が red→green を一度ずつ経る）。

> fetch 失敗ガードの恒久検証: もし `git fetch` の `res.code` 検査を外し fetch 結果を破棄する実装に退行すると、`worktree add` が陳腐化した base 上で成功し `calls` 長が 2 になり、Step 1 の「fetch 非0で worktree add を呼ばない」テストが落ちて契約違反（カーネル §2『失敗は throw』）を検知する。

`npm run check` を実行（tsc×2 + vitest グリーン）。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.prepareWorktree with slug + worktree add + collision/fetch guard"`

- [ ] **Step 3: `hasCommitsWithDiff` / `hasUncommittedChanges` の失敗テストを書く**

`tests/git-pr.test.ts` に新しい describe を追記:

```typescript
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
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.hasCommitsWithDiff is not a function` / `mgr.hasUncommittedChanges is not a function`（メソッド未実装）。

- [ ] **Step 4: `hasCommitsWithDiff` / `hasUncommittedChanges` を最小実装**

`src/git-pr.ts` の `prepareWorktree` メソッドの直後（class 内）に追記:

```typescript
  async hasCommitsWithDiff(worktreePath: string): Promise<boolean> {
    const { defaultBranch } = this.opts;
    const range = `origin/${defaultBranch}..HEAD`;

    const count = await this.runner.run(
      "git",
      ["-C", worktreePath, "rev-list", "--count", range],
      { cwd: worktreePath },
    );
    const ahead = Number.parseInt(count.stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead <= 0) {
      return false;
    }

    const diff = await this.runner.run(
      "git",
      ["-C", worktreePath, "diff", "--quiet", range],
      { cwd: worktreePath },
    );
    // diff --quiet: 差分なし → code 0、差分あり → code 1（非0）
    return diff.code !== 0;
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const res = await this.runner.run(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { cwd: worktreePath },
    );
    return res.stdout.trim().length > 0;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: hasCommitsWithDiff の 3 件 + hasUncommittedChanges の 2 件を含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager diff/uncommitted change detection"`

- [ ] **Step 5: `findOpenPrForBranch` の失敗テストを書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
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
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.findOpenPrForBranch is not a function`（未実装）。

- [ ] **Step 6: `findOpenPrForBranch` を最小実装**

`src/git-pr.ts` の class 内（`hasUncommittedChanges` の後）に追記:

```typescript
  async findOpenPrForBranch(branch: string): Promise<number | null> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "list", "-R", remote, "--head", branch, "--state", "open", "--json", "number"],
      { cwd: repoPath },
    );
    const rows = JSON.parse(res.stdout) as Array<{ number: number }>;
    if (rows.length === 0) {
      return null;
    }
    return rows[0].number;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: findOpenPrForBranch の 2 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.findOpenPrForBranch via gh pr list"`

- [ ] **Step 7: `pushAndOpenPr` の失敗テストを書く（push→create の argv + 本文置換 + PR番号 parse）**

`tests/git-pr.test.ts` に describe を追記:

```typescript
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
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.pushAndOpenPr is not a function`（未実装）。

- [ ] **Step 8: `pushAndOpenPr` を最小実装（テンプレ置換ヘルパ込み）**

`src/git-pr.ts` の `slugify` 関数の直後（class の外、トップレベル）にテンプレ置換ヘルパを追記:

```typescript
/** prBodyTemplate の {identifier}/{title}/{issue_url} を置換（全出現を置換） */
function renderPrBody(template: string, issue: EligibleIssue): string {
  return template
    .replaceAll("{identifier}", issue.identifier)
    .replaceAll("{title}", issue.title)
    .replaceAll("{issue_url}", issue.url);
}
```

`src/git-pr.ts` の class 内（`findOpenPrForBranch` の後）に追記:

```typescript
  async pushAndOpenPr(
    branch: string,
    worktreePath: string,
    issue: EligibleIssue,
  ): Promise<number> {
    const { repoPath, remote, defaultBranch } = this.opts;

    await this.runner.run("git", ["-C", worktreePath, "push", "-u", "origin", branch], {
      cwd: worktreePath,
    });

    const body = renderPrBody(this.opts.prBodyTemplate, issue);
    const title = `${issue.identifier}: ${issue.title}`;
    const res = await this.runner.run(
      "gh",
      [
        "pr",
        "create",
        "-R",
        remote,
        "--base",
        defaultBranch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repoPath },
    );

    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (match === null) {
      throw new Error(`could not parse PR number from gh pr create output: ${res.stdout.trim()}`);
    }
    const prNumber = Number.parseInt(match[1], 10);
    if (!Number.isFinite(prNumber)) {
      throw new Error(`could not parse PR number from gh pr create output: ${res.stdout.trim()}`);
    }
    return prNumber;
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: pushAndOpenPr の 2 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.pushAndOpenPr push + gh pr create + number parse"`

- [ ] **Step 9: `addLabel` / `mergePr` の失敗テストを書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
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
      opts: { cwd: "/repo" },
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
      opts: { cwd: "/repo" },
    });
  });

  it("throws when gh pr merge exits non-zero (caller maps to ci_failed/conflict)", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "merge"], { code: 1, stdout: "", stderr: "not mergeable" });

    const mgr = new GitPrManager(runner, OPTS);
    await expect(mgr.mergePr(57, "deadbeef")).rejects.toThrow(/not mergeable/);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.addLabel is not a function` / `mgr.mergePr is not a function`（未実装）。

- [ ] **Step 10: `addLabel` / `mergePr` を最小実装**

`src/git-pr.ts` の class 内（`pushAndOpenPr` の後）に追記:

```typescript
  async addLabel(prNumber: number, label: string): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "edit", String(prNumber), "-R", remote, "--add-label", label],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      throw new Error(
        `gh pr edit --add-label failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

  async mergePr(prNumber: number, headSha: string): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "merge", String(prNumber), "-R", remote, "--squash", "--match-head-commit", headSha],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      throw new Error(
        `gh pr merge failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: addLabel/mergePr の 4 件含む全テスト passed。

`npm run check` グリーン。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.addLabel + mergePr via gh"`

- [ ] **Step 11: `discardWorktree` の失敗テスト（順序検証）を書く**

`tests/git-pr.test.ts` に describe を追記:

```typescript
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
      opts: { cwd: "/repo" },
    });
    expect(runner.calls[1]).toEqual({
      cmd: "git",
      args: ["-C", "/repo", "branch", "-D", "looppilot/ty-123-x"],
      opts: { cwd: "/repo" },
    });
    expect(runner.calls).toHaveLength(2);
  });
});
```

実行して **失敗** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待される失敗: `mgr.discardWorktree is not a function`（未実装）。

- [ ] **Step 12: `discardWorktree` を最小実装**

`src/git-pr.ts` の class 内（`mergePr` の後、class の末尾）に追記:

```typescript
  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    const { repoPath } = this.opts;
    await this.runner.run(
      "git",
      ["-C", repoPath, "worktree", "remove", "--force", worktreePath],
      { cwd: repoPath },
    );
    await this.runner.run("git", ["-C", repoPath, "branch", "-D", branch], {
      cwd: repoPath,
    });
  }
```

実行して **成功** を確認:

```
npx vitest run tests/git-pr.test.ts
```

期待: 全 describe 全テスト passed（prepareWorktree / hasCommitsWithDiff / hasUncommittedChanges / findOpenPrForBranch / pushAndOpenPr / addLabel / mergePr / discardWorktree）。

`npm run check` グリーン（tsc src + tsc test + vitest 全グリーン）。

`git add src/git-pr.ts tests/git-pr.test.ts && git commit -m "feat: GitPrManager.discardWorktree (worktree remove + branch -D)"`

---

#### 完了確認（このタスクの受け入れ条件）

- `GitPrManager` がカーネル §2 の `GitPrManager` インターフェース全メソッド（`prepareWorktree` / `hasCommitsWithDiff` / `hasUncommittedChanges` / `findOpenPrForBranch` / `pushAndOpenPr` / `addLabel` / `mergePr` / `discardWorktree`）を実装し、各メソッドの引数・戻り値型がインターフェースと一致。
- 全 git/gh コマンドの argv が §5.2/§5.3 と一字一句一致（テストで cwd を含め完全一致検証）。
- slug 規則・衝突 `-2..-5`・全滅 throw・PR番号 parse 失敗 throw が網羅されている。
- `prepareWorktree` の `git fetch` が非0終了したら throw し（カーネル §2『失敗は throw』）、`worktree add` を呼ばない（陳腐化 base での worktree 作成を防止）ことがテストで検証されている。
- 実 git/gh を一切起動していない（`FakeCommandRunner` のみ）。
- `npm run check` グリーン。
