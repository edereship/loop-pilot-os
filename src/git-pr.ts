import type {
  CommandRunner,
  EligibleIssue,
  ClaimResult,
  GitPrManager as GitPrManagerInterface,
  PrDiffSummary,
} from "./types.js";
import { isTransientError } from "./transient-retry.js";

// GitHub CLI error text emitted when a PR for the branch already exists.
// Matches both "a pull request for branch 'x' already exists" and
// "a pull request for branch \"x\" already exists".
const DUPLICATE_PR_RE = /a pull request for branch/i;

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
    const { repoPath, defaultBranch, branchPrefix, worktreeRoot, log } = this.opts;
    const slug = `${issue.identifier.toLowerCase()}-${slugify(issue.title)}`;

    // Close stale PRs from a prior parked session for the same issue (ES-531).
    // Non-fatal: if detection or close fails, proceed — the worst case is a
    // stale PR that the operator must close manually (status quo).
    try {
      const stalePrs = await this.findOpenPrsForIssue(issue.identifier);
      for (const pr of stalePrs) {
        try {
          await this.closePr(pr);
          log?.(`prepareWorktree: closed stale PR #${pr} for ${issue.identifier}`);
        } catch (err) {
          log?.(`prepareWorktree: failed to close stale PR #${pr} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log?.(`prepareWorktree: failed to close stale PRs for ${issue.identifier} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

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
      const rawErr = res.stderr.trim() || `exit ${res.code}`;
      throw new Error(`gh pr list failed for ${branch}: ${rawErr}`, { cause: rawErr });
    }
    const rows = JSON.parse(res.stdout) as Array<{ number: number }>;
    if (rows.length === 0) {
      return null;
    }
    return rows[0].number;
  }

  async findOpenPrsForIssue(issueIdentifier: string): Promise<number[]> {
    const { repoPath, remote, branchPrefix } = this.opts;
    const searchPrefix = `${branchPrefix}/${issueIdentifier.toLowerCase()}-`;
    const res = await this.runner.run(
      "gh",
      [
        "pr", "list", "-R", remote,
        "--search", `head:${searchPrefix}`,
        "--state", "open",
        "--json", "number,headRefName",
      ],
      { cwd: repoPath, timeoutMs: 60_000 },
    );
    if (res.code !== 0) {
      const rawErr = res.stderr.trim() || `exit ${res.code}`;
      throw new Error(`gh pr list failed for issue ${issueIdentifier}: ${rawErr}`, { cause: rawErr });
    }
    const rows = JSON.parse(res.stdout) as Array<{ number: number; headRefName: string }>;
    return rows
      .filter(r => r.headRefName.startsWith(searchPrefix))
      .map(r => r.number);
  }

  async closePr(prNumber: number): Promise<void> {
    const { repoPath, remote } = this.opts;
    const res = await this.runner.run(
      "gh",
      ["pr", "close", String(prNumber), "-R", remote],
      { cwd: repoPath, timeoutMs: 60_000 },
    );
    if (res.code !== 0) {
      const rawErr = res.stderr.trim() || `exit ${res.code}`;
      if (/already\s*closed/i.test(rawErr)) return;
      throw new Error(`gh pr close failed for PR #${prNumber}: ${rawErr}`, { cause: rawErr });
    }
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
      const rawErr = push.stderr.trim() || `exit ${push.code}`;
      throw new Error(`git push failed for ${branch}: ${rawErr}`, { cause: rawErr });
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
      const rawErr = res.stderr.trim() || `exit ${res.code}`;
      // Look up any server-side-created PR for two distinct cases:
      // 1) Transient errors: the create may have succeeded but the response was lost.
      // 2) Duplicate-PR errors: the previous retry created the PR successfully; the current
      //    retry's `gh pr create` is deterministically rejected because the PR already
      //    exists.  Adopting the existing PR is correct here (idempotent success path).
      // All other deterministic errors (auth, validation) must not adopt stale PRs.
      if (isTransientError(rawErr) || DUPLICATE_PR_RE.test(rawErr)) {
        try {
          const existing = await this.findOpenPrForBranch(branch);
          if (existing !== null) return existing;
        } catch (secondaryErr) {
          try { this.opts.log?.(`pushAndOpenPr: idempotency check also failed: ${secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr)}`); } catch { /* log must not suppress original error */ }
          if (isTransientError(secondaryErr)) throw secondaryErr;
        }
      }
      throw new Error(`gh pr create failed for ${branch}: ${rawErr}`, { cause: rawErr });
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
      const rawErr = res.stderr.trim() || `exit ${res.code}`;
      throw new Error(`gh pr edit --add-label failed for PR #${prNumber}: ${rawErr}`, { cause: rawErr });
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
      // Filter to runs whose conclusion indicates a non-success outcome so that
      // timed_out, cancelled, action_required, and startup_failure all surface logs —
      // not just the failure status that the previous --status filter matched (ES-493 Finding 3).
      // Skip runs that have not completed yet: in-progress/queued runs export conclusion as ""
      // and would otherwise be selected before the actual failed run (ES-493 Finding 1).
      const GREEN = new Set(["success", "neutral", "skipped"]);
      type RunEntry = { databaseId: number; conclusion: string | null; status: string; workflowName?: string; workflowDatabaseId?: number; event?: string; headSha?: string };

      // Fetch run list for a given ref and return the most-recent failing run, or null.
      // Deduplicate by workflow: gh run list is newest-first, so the first completed run
      // encountered per workflow is its most recent. If that latest completed run is green
      // (e.g. a re-run succeeded), the earlier failure was superseded and must not be
      // selected — otherwise stale logs from a fixed workflow can mask a currently-failing
      // one (ES-493 Finding 1 / Codex Iteration 7 Finding 1).
      // Organization/enterprise ruleset workflows may omit workflowName; use the stable
      // numeric workflowDatabaseId as fallback so each unnamed workflow gets its own key
      // and a green ruleset run cannot suppress a failing one of a different ruleset
      // (ES-493 Iteration 8 Finding 1).
      // Include the event (push vs pull_request) in the key so that when the same workflow
      // runs for both events on the same commit, a green push run cannot suppress a failing
      // pull_request run (ES-493 Iteration 11 Finding 1).
      const findFailingRun = async (refArgs: string[], shaFilter?: string): Promise<RunEntry | null> => {
        const listResult = await this.runner.run("gh", [
          "run", "list",
          "-R", remote,
          ...refArgs,
          "--limit", "25",
          "--json", "databaseId,conclusion,status,workflowName,workflowDatabaseId,event,headSha",
        ], { cwd: repoPath, timeoutMs: 15_000 });
        if (listResult.code !== 0 || !listResult.stdout.trim()) return null;
        let runs: RunEntry[];
        try {
          runs = JSON.parse(listResult.stdout);
        } catch {
          return null;
        }
        // When doing a branch-based search, filter to runs whose headSha matches the PR
        // head SHA so that stale runs from older commits on a long-lived branch are not
        // selected (Codex Finding 1). Without this filter, a prior failed run from an
        // earlier commit can be injected as CI diagnostics for the wrong failure.
        if (shaFilter) {
          runs = runs.filter((r) => r.headSha === shaFilter);
        }
        const latestCompletedByWorkflow = new Map<string, RunEntry>();
        for (const r of runs) {
          if (r.status !== "completed" || r.conclusion === null || r.conclusion === "") continue;
          const event = r.event ?? "";
          const key = r.workflowDatabaseId != null ? `id:${r.workflowDatabaseId}:${event}` : `${r.workflowName || ""}:${event}`;
          if (!latestCompletedByWorkflow.has(key)) {
            latestCompletedByWorkflow.set(key, r);
          }
        }
        return Array.from(latestCompletedByWorkflow.values()).find(
          (r) => !GREEN.has(r.conclusion!.toLowerCase())) ?? null;
      };

      // Try by commit SHA first, then fall back to branch. For pull_request workflows
      // GitHub uses the merge commit SHA as GITHUB_SHA, which differs from the PR head
      // SHA, so --commit <headSha> may miss those runs (ES-493 Finding 1).
      let failing = await findFailingRun(headSha ? ["--commit", headSha] : ["--branch", branch]);
      if (!failing && headSha) {
        // Branch fallback: filter by headSha to exclude stale runs from older commits
        // on the same branch (Codex Finding 1).
        failing = await findFailingRun(["--branch", branch], headSha);
      }
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
