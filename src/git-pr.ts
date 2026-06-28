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
  log?: (line: string) => void;
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
      { cwd: repoPath, timeoutMs: 120_000 },
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
        { cwd: repoPath, timeoutMs: 30_000 },
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
      { cwd: worktreePath, timeoutMs: 30_000 },
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
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    // diff --quiet: 差分なし → code 0、差分あり → code 1（非0）
    return diff.code !== 0;
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const res = await this.runner.run(
      "git",
      ["-C", worktreePath, "status", "--porcelain"],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    if (res.code !== 0) {
      throw new Error(
        `git status failed in ${worktreePath}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    return res.stdout.trim().length > 0;
  }

  async discardUncommittedChanges(worktreePath: string): Promise<void> {
    const unstage = await this.runner.run(
      "git",
      ["-C", worktreePath, "restore", "--staged", "."],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    if (unstage.code !== 0) {
      throw new Error(
        `git restore --staged failed in ${worktreePath}: ${unstage.stderr.trim() || `exit ${unstage.code}`}`,
      );
    }
    const restore = await this.runner.run(
      "git",
      ["-C", worktreePath, "restore", "."],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    if (restore.code !== 0) {
      throw new Error(
        `git restore failed in ${worktreePath}: ${restore.stderr.trim() || `exit ${restore.code}`}`,
      );
    }
    const clean = await this.runner.run(
      "git",
      ["-C", worktreePath, "clean", "-ffdx"],
      { cwd: worktreePath, timeoutMs: 30_000 },
    );
    if (clean.code !== 0) {
      throw new Error(
        `git clean failed in ${worktreePath}: ${clean.stderr.trim() || `exit ${clean.code}`}`,
      );
    }
  }

  async findOpenPrForBranch(branch: string): Promise<number | null> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "list", "-R", remote, "--head", branch, "--state", "open", "--json", "number"],
      { cwd: repoPath, timeoutMs: 60_000 },
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
      { cwd: worktreePath, timeoutMs: 120_000 },
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
      { cwd: repoPath, timeoutMs: 60_000 },
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
      { cwd: repoPath, timeoutMs: 60_000 },
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
      { cwd: repoPath, timeoutMs: 60_000 },
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
      { cwd: repoPath, timeoutMs: 60_000 },
    );
    if (res.code !== 0) {
      throw new Error(
        `postComment failed for PR #${prNumber}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

  async discardWorktree(branch: string, worktreePath: string): Promise<void> {
    const { repoPath, log } = this.opts;
    const wtRes = await this.runner.run(
      "git",
      ["-C", repoPath, "worktree", "remove", "--force", worktreePath],
      { cwd: repoPath, timeoutMs: 30_000 },
    );
    if (wtRes.code !== 0) {
      log?.(`warning: git worktree remove failed for ${worktreePath}: ${wtRes.stderr.trim() || `exit ${wtRes.code}`}`);
    }
    const brRes = await this.runner.run("git", ["-C", repoPath, "branch", "-D", branch], {
      cwd: repoPath, timeoutMs: 30_000,
    });
    if (brRes.code !== 0) {
      log?.(`warning: git branch -D failed for ${branch}: ${brRes.stderr.trim() || `exit ${brRes.code}`}`);
    }
  }

  async getPrDiffSummary(prNumber: number, maxDiffChars?: number): Promise<PrDiffSummary> {
    const { repoPath, remote } = this.opts;
    const viewRes = await this.runner.run(
      "gh",
      ["pr", "view", String(prNumber), "-R", remote, "--json", "title,body"],
      { cwd: repoPath, timeoutMs: 60_000 },
    );
    if (viewRes.code !== 0) {
      throw new Error(
        `gh pr view failed for #${prNumber}: ${viewRes.stderr.trim() || `exit ${viewRes.code}`}`,
      );
    }
    let parsed: { title: string; body: string | null };
    try {
      parsed = JSON.parse(viewRes.stdout) as { title: string; body: string | null };
    } catch {
      throw new Error(
        `gh pr view for #${prNumber} returned unparseable JSON: ${viewRes.stdout.slice(0, 200)}`,
      );
    }
    const { title, body: rawBody } = parsed;
    const body = rawBody ?? "";

    const diffRes = await this.runner.run(
      "gh",
      ["pr", "diff", String(prNumber), "-R", remote],
      { cwd: repoPath, timeoutMs: 60_000 },
    );
    if (diffRes.code !== 0) {
      throw new Error(
        `gh pr diff failed for #${prNumber}: ${diffRes.stderr.trim() || `exit ${diffRes.code}`}`,
      );
    }

    const diff =
      maxDiffChars !== undefined && diffRes.stdout.length > maxDiffChars
        ? diffRes.stdout.slice(0, maxDiffChars)
        : diffRes.stdout;

    return { title, body, diff };
  }

  async fetchDefaultBranch(): Promise<void> {
    const { repoPath, defaultBranch } = this.opts;
    const fetchRes = await this.runner.run(
      "git",
      ["-C", repoPath, "fetch", "origin", defaultBranch],
      { cwd: repoPath, timeoutMs: 120_000 },
    );
    if (fetchRes.code !== 0) {
      throw new Error(
        `git fetch origin ${defaultBranch} failed: ${fetchRes.stderr.trim() || `exit ${fetchRes.code}`}`,
      );
    }
    const resetRes = await this.runner.run(
      "git",
      ["-C", repoPath, "reset", "--hard", `origin/${defaultBranch}`],
      { cwd: repoPath, timeoutMs: 30_000 },
    );
    if (resetRes.code !== 0) {
      throw new Error(
        `git reset --hard origin/${defaultBranch} failed: ${resetRes.stderr.trim() || `exit ${resetRes.code}`}`,
      );
    }
  }

  async fetchCiLogs(_prNumber: number, branch: string, headSha?: string): Promise<string | null> {
    const MAX_LOG_CHARS = 4000;
    const { repoPath, remote } = this.opts;
    try {
      const refArgs: string[] = headSha
        ? ["--commit", headSha]
        : ["--branch", branch];
      const listResult = await this.runner.run("gh", [
        "run", "list",
        "-R", remote,
        ...refArgs,
        "--limit", "5",
        "--json", "databaseId,conclusion",
      ], { cwd: repoPath, timeoutMs: 15_000 });
      if (listResult.code !== 0 || !listResult.stdout.trim()) return null;
      let runs: Array<{ databaseId: number; conclusion: string | null }>;
      try {
        runs = JSON.parse(listResult.stdout);
      } catch {
        return null;
      }
      // Filter to runs whose conclusion indicates a non-success outcome so that
      // timed_out, cancelled, action_required, and startup_failure all surface logs —
      // not just the failure status that the previous --status filter matched (ES-493 Finding 3).
      const GREEN = new Set(["success", "neutral", "skipped"]);
      const failing = runs.find((r) => r.conclusion !== null && !GREEN.has(r.conclusion.toLowerCase()));
      if (!failing) return null;

      // For actual failures, --log-failed surfaces only the failing steps.
      // For timed_out/cancelled/action_required/startup_failure there are no
      // "failed steps", so --log-failed returns nothing; use --log instead.
      const logFlag = failing.conclusion?.toLowerCase() === "failure" ? "--log-failed" : "--log";
      const logResult = await this.runner.run("gh", [
        "run", "view", String(failing.databaseId),
        "-R", remote,
        logFlag,
      ], { cwd: repoPath, timeoutMs: 30_000 });
      if (logResult.code !== 0 || !logResult.stdout.trim()) return null;

      const log = logResult.stdout;
      return log.length > MAX_LOG_CHARS ? log.slice(-MAX_LOG_CHARS) : log;
    } catch {
      return null;
    }
  }
}
