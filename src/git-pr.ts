import type {
  CommandRunner,
  EligibleIssue,
  ClaimResult,
  GitPrManager as GitPrManagerInterface,
  PrDiffSummary,
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

/** prBodyTemplate の {identifier}/{title}/{issue_url} を置換（全出現を置換） */
function renderPrBody(template: string, issue: EligibleIssue): string {
  return template
    .replaceAll("{identifier}", issue.identifier)
    .replaceAll("{title}", issue.title)
    .replaceAll("{issue_url}", issue.url);
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

  async hasCommitsWithDiff(worktreePath: string): Promise<boolean> {
    const { defaultBranch } = this.opts;
    const range = `origin/${defaultBranch}..HEAD`;

    const count = await this.runner.run(
      "git",
      ["-C", worktreePath, "rev-list", "--count", range],
      { cwd: worktreePath },
    );
    if (count.code !== 0) {
      throw new Error(
        `git rev-list failed in ${worktreePath}: ${count.stderr.trim() || `exit ${count.code}`}`,
      );
    }
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
    if (res.code !== 0) {
      throw new Error(
        `git status failed in ${worktreePath}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    return res.stdout.trim().length > 0;
  }

  async findOpenPrForBranch(branch: string): Promise<number | null> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "list", "-R", remote, "--head", branch, "--state", "open", "--json", "number"],
      { cwd: repoPath },
    );
    // 非0終了は throw（他の gh ラッパと一貫）。stdout が空/HTML/部分でも
    // JSON.parse の偶発例外に頼らず明示的に失敗を上げる。
    if (res.code !== 0) {
      throw new Error(
        `gh pr list failed for ${branch}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    const rows = JSON.parse(res.stdout) as Array<{ number: number }>;
    if (rows.length === 0) {
      return null;
    }
    return rows[0].number;
  }

  async pushAndOpenPr(
    branch: string,
    worktreePath: string,
    issue: EligibleIssue,
  ): Promise<number> {
    const { repoPath, remote, defaultBranch } = this.opts;

    const push = await this.runner.run(
      "git",
      ["-C", worktreePath, "push", "-u", "origin", branch],
      { cwd: worktreePath },
    );
    if (push.code !== 0) {
      throw new Error(
        `git push failed for ${branch}: ${push.stderr.trim() || `exit ${push.code}`}`,
      );
    }

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

    if (res.code !== 0) {
      throw new Error(
        `gh pr create failed for ${branch}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }

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

  async postComment(prNumber: number, body: string): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      [
        "api",
        `repos/${remote}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      { cwd: repoPath },
    );
    if (res.code !== 0) {
      throw new Error(
        `postComment failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

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

  async getPrDiffSummary(prNumber: number): Promise<PrDiffSummary> {
    const { repoPath } = this.opts;
    const viewRes = await this.runner.run(
      "gh",
      ["pr", "view", String(prNumber), "--json", "title,body"],
      { cwd: repoPath },
    );
    if (viewRes.code !== 0) {
      throw new Error(
        `gh pr view failed for #${prNumber}: ${viewRes.stderr.trim() || `exit ${viewRes.code}`}`,
      );
    }
    const { title, body: rawBody } = JSON.parse(viewRes.stdout) as {
      title: string;
      body: string | null;
    };
    const body = rawBody ?? "";

    const diffRes = await this.runner.run(
      "gh",
      ["pr", "diff", String(prNumber)],
      { cwd: repoPath },
    );
    if (diffRes.code !== 0) {
      throw new Error(
        `gh pr diff failed for #${prNumber}: ${diffRes.stderr.trim() || `exit ${diffRes.code}`}`,
      );
    }

    return { title, body, diff: diffRes.stdout };
  }
}
