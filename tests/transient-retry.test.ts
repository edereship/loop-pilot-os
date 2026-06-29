import { describe, it, expect } from "vitest";
import { isTransientError, retryTransient } from "../src/transient-retry.js";
import { GitPrManager } from "../src/git-pr.js";
import type { CommandResult, RunOptions } from "../src/types.js";

// ---- isTransientError ----

describe("isTransientError", () => {
  const transientMessages = [
    "ECONNRESET",
    "read ECONNREFUSED 127.0.0.1:443",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo EAI_AGAIN api.linear.app",
    "socket hang up",
    "Connection reset by peer",
    "request timed out after 30000ms",
    "fetch failed",
    "HTTP 502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "Internal Server Error",
    "git push failed for branch: fatal: 500",
  ];

  for (const msg of transientMessages) {
    it(`classifies "${msg}" as transient`, () => {
      expect(isTransientError(new Error(msg))).toBe(true);
    });
  }

  const deterministicMessages = [
    "gh pr create failed for branch: 422 Validation Failed",
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "HTTP 404 Not Found",
    "Bad credentials",
    "branch already exists",
    "cost_exceeded",
    "permission denied",
    "Repository not found",
    "git push failed for branch: exit 128",
    "gh pr edit --add-label failed for PR #500: HTTP 403 Forbidden",
    "gh pr edit --add-label failed for PR #502: permission denied",
    "gh pr create failed for looppilot/es-500-fix-bug: 422 Validation Failed",
    "gh pr create failed for looppilot/ty-503-add-auth: HTTP 401 Unauthorized",
  ];

  for (const msg of deterministicMessages) {
    it(`classifies "${msg}" as deterministic (not transient)`, () => {
      expect(isTransientError(new Error(msg))).toBe(false);
    });
  }

  it("handles non-Error values", () => {
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isTransientError("permission denied")).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it("prefers Error.cause (raw stderr) over message for classification", () => {
    // Branch name with 500 in message, deterministic cause → not transient
    expect(isTransientError(
      new Error("gh pr create failed for looppilot/es-500-fix: 422 Validation Failed", { cause: "422 Validation Failed" }),
    )).toBe(false);

    // Branch name with 500 in message, transient cause → transient
    expect(isTransientError(
      new Error("gh pr create failed for looppilot/es-500-fix: ECONNRESET", { cause: "ECONNRESET" }),
    )).toBe(true);

    // Slug with "timeout" in message, deterministic cause → not transient
    expect(isTransientError(
      new Error("git push failed for looppilot/ty-42-fix-timeout-handling: exit 128", { cause: "exit 128" }),
    )).toBe(false);

    // Non-string/non-Error cause is ignored, falls back to message
    expect(isTransientError(
      new Error("ECONNRESET", { cause: 42 }),
    )).toBe(true);

    // Standard error chaining: { cause: Error } with string cause inside
    const inner = new Error("git push failed for looppilot/es-500-fix: ECONNRESET", { cause: "ECONNRESET" });
    const outer = new Error("handoff step failed", { cause: inner });
    expect(isTransientError(outer)).toBe(true);

    // Chained deterministic cause is not misclassified
    const innerDet = new Error("git push failed for looppilot/es-500-fix: exit 128", { cause: "exit 128" });
    const outerDet = new Error("handoff step failed", { cause: innerDet });
    expect(isTransientError(outerDet)).toBe(false);
  });
});

// ---- retryTransient ----

describe("retryTransient", () => {
  it("returns on first success without retry", async () => {
    let calls = 0;
    const result = await retryTransient(2, async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient errors and succeeds", async () => {
    let calls = 0;
    const result = await retryTransient(2, async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries on transient errors", async () => {
    let calls = 0;
    await expect(
      retryTransient(2, async () => {
        calls++;
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("throws deterministic errors immediately without retry", async () => {
    let calls = 0;
    await expect(
      retryTransient(2, async () => {
        calls++;
        throw new Error("HTTP 401 Unauthorized");
      }),
    ).rejects.toThrow("401 Unauthorized");
    expect(calls).toBe(1);
  });

  it("retries=0 disables retry (single attempt)", async () => {
    let calls = 0;
    await expect(
      retryTransient(0, async () => {
        calls++;
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
  });

  it("transient then deterministic throws deterministic immediately", async () => {
    let calls = 0;
    await expect(
      retryTransient(3, async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        throw new Error("HTTP 403 Forbidden");
      }),
    ).rejects.toThrow("403 Forbidden");
    expect(calls).toBe(2);
  });

  it("calls onRetry callback on each transient retry", async () => {
    const retried: Array<{ attempt: number; msg: string }> = [];
    let calls = 0;
    await retryTransient(2, async () => {
      calls++;
      if (calls <= 2) throw new Error("ECONNRESET");
      return "ok";
    }, {
      onRetry: (attempt, err) => retried.push({ attempt, msg: (err as Error).message }),
    });
    expect(retried).toEqual([
      { attempt: 1, msg: "ECONNRESET" },
      { attempt: 2, msg: "ECONNRESET" },
    ]);
  });

  it("throws on invalid retries value (undefined/NaN/fractional/negative)", async () => {
    await expect(
      retryTransient(undefined as any, async () => "ok"),
    ).rejects.toThrow("invalid retries value");
    await expect(
      retryTransient(NaN, async () => "ok"),
    ).rejects.toThrow("invalid retries value");
    await expect(
      retryTransient(-1, async () => "ok"),
    ).rejects.toThrow("invalid retries value");
    await expect(
      retryTransient(0.5, async () => "ok"),
    ).rejects.toThrow("invalid retries value");
  });

  it("onRetry throw does not break the retry loop", async () => {
    let calls = 0;
    const result = await retryTransient(2, async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return "recovered";
    }, {
      onRetry: () => { throw new Error("log failed"); },
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });
});

// ---- findOpenPrForBranch error classification (ES-488 Finding 2) ----

describe("findOpenPrForBranch — error carries raw cause for correct transient classification", () => {
  function stubRunner(response: { code: number; stdout: string; stderr: string }): {
    run: (cmd: string, args: string[], opts: RunOptions) => Promise<CommandResult>;
  } {
    return {
      run: async (_cmd: string, _args: string[], _opts: RunOptions) => response,
    };
  }

  // ES-488 Finding 2: a branch name containing "500" or "timeout" must NOT cause a
  // deterministic gh pr list failure (e.g. HTTP 401) to be misclassified as transient.
  it("branch name with '500' does not cause HTTP 401 to be misclassified as transient", async () => {
    const { isTransientError: isTrans } = await import("../src/transient-retry.js");
    const runner = stubRunner({ code: 1, stdout: "", stderr: "HTTP 401 Unauthorized" });

    const { GitPrManager: GPM } = await import("../src/git-pr.js");
    const git = new GPM(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    let thrown: unknown;
    try {
      await git.findOpenPrForBranch("lp/es-500-fix-timeout-handling");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The raw stderr (HTTP 401 Unauthorized) is deterministic, not transient.
    // Without { cause: rawErr }, isTransientError would fall back to the message which
    // contains "500" and "timeout", causing a false positive.
    expect(isTrans(thrown)).toBe(false);
  });

  it("branch name with 'timed_out' does not cause HTTP 403 to be misclassified as transient", async () => {
    const { isTransientError: isTrans } = await import("../src/transient-retry.js");
    const runner = stubRunner({ code: 1, stdout: "", stderr: "HTTP 403 Forbidden" });

    const { GitPrManager: GPM } = await import("../src/git-pr.js");
    const git = new GPM(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    let thrown: unknown;
    try {
      await git.findOpenPrForBranch("lp/ty-99-fix-timed-out-handler");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(isTrans(thrown)).toBe(false);
  });

  it("genuine ECONNRESET from gh pr list is still classified as transient", async () => {
    const { isTransientError: isTrans } = await import("../src/transient-retry.js");
    const runner = stubRunner({ code: 1, stdout: "", stderr: "ECONNRESET" });

    const { GitPrManager: GPM } = await import("../src/git-pr.js");
    const git = new GPM(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    let thrown: unknown;
    try {
      await git.findOpenPrForBranch("lp/es-999-some-fix");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(isTrans(thrown)).toBe(true);
  });
});

// ---- PR creation idempotency (ES-488) ----

describe("pushAndOpenPr — idempotency on retry", () => {
  function stubRunner(responses: Array<{ code: number; stdout: string; stderr: string }>): {
    run: (cmd: string, args: string[], opts: RunOptions) => Promise<CommandResult>;
    calls: Array<{ cmd: string; args: string[] }>;
  } {
    let callIndex = 0;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      run: async (cmd: string, args: string[], _opts: RunOptions) => {
        calls.push({ cmd, args });
        const r = responses[callIndex++] ?? { code: 1, stdout: "", stderr: "no more stubs" };
        return { code: r.code, stdout: r.stdout, stderr: r.stderr };
      },
    };
  }

  const fakeIssue = { id: "iss-1", identifier: "TY-1", title: "test", description: "", priority: 2, sortOrder: 0, url: "https://example.com" };

  it("gh pr create fails → existing PR detected → returns existing PR number", async () => {
    const runner = stubRunner([
      // git push succeeds
      { code: 0, stdout: "", stderr: "" },
      // gh pr create fails (network drop)
      { code: 1, stdout: "", stderr: "ECONNRESET" },
      // findOpenPrForBranch: gh pr list returns existing PR
      { code: 0, stdout: JSON.stringify([{ number: 42 }]), stderr: "" },
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    const prNumber = await git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue);
    expect(prNumber).toBe(42);
  });

  it("gh pr create fails, no existing PR → throws original error", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },       // push
      { code: 1, stdout: "", stderr: "ECONNRESET" },  // pr create
      { code: 0, stdout: "[]", stderr: "" },           // pr list (empty)
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow("gh pr create failed for feat-branch: ECONNRESET");
  });

  it("gh pr create fails, findOpenPrForBranch also fails → throws original error", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },                  // push
      { code: 1, stdout: "", stderr: "connection reset" },   // pr create
      { code: 1, stdout: "", stderr: "network error" },      // pr list also fails
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow("gh pr create failed for feat-branch: connection reset");
  });

  it("gh pr create deterministic error → skips idempotency check, throws immediately", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },                      // push
      { code: 1, stdout: "", stderr: "422 Validation Failed" }, // pr create (deterministic)
      // findOpenPrForBranch should NOT be called — no third stub needed
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow("gh pr create failed for feat-branch: 422 Validation Failed");
    // Only 2 runner calls: push + pr create (no pr list)
    expect(runner.calls).toHaveLength(2);
  });

  it("duplicate-PR error → existing PR detected → returns existing PR number", async () => {
    // Scenario: first retry created the PR but the response was lost; on the second attempt
    // gh pr create is rejected because the PR already exists.
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },  // git push
      // gh pr create: deterministic duplicate-PR rejection
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      // findOpenPrForBranch: returns the already-created PR
      { code: 0, stdout: JSON.stringify([{ number: 77 }]), stderr: "" },
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    const prNumber = await git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue);
    expect(prNumber).toBe(77);
    // Three calls: push + pr create + pr list
    expect(runner.calls).toHaveLength(3);
  });

  it("duplicate-PR error, no open PR found → throws original error", async () => {
    // Unusual but possible: PR was closed between create and lookup.
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },  // git push
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 0, stdout: "[]", stderr: "" },  // pr list returns empty
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow(/gh pr create failed.*a pull request for branch/);
    expect(runner.calls).toHaveLength(3);
  });

  it("duplicate-PR error, findOpenPrForBranch throws → throws original error", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },              // git push
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 1, stdout: "", stderr: "network error" }, // pr list also fails
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow(/gh pr create failed.*a pull request for branch/);
  });

  // ES-488 Finding 1: when duplicate-PR error triggers idempotency lookup and that
  // lookup itself fails transiently, the transient error must be rethrown so the outer
  // retryTransient can retry the whole pushAndOpenPr (including the lookup again).
  it("duplicate-PR error, findOpenPrForBranch fails transiently → rethrows transient error for outer retry", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },              // git push
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 1, stdout: "", stderr: "ECONNRESET" },    // pr list fails transiently
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    // Must throw the transient secondary error, not the deterministic duplicate error,
    // so that the outer retryTransient retries instead of failing fast.
    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow(/ECONNRESET/);
  });

  // ES-488 Finding 1: when transient pr create triggers idempotency lookup and that
  // lookup also fails transiently, the secondary transient error surfaces to allow retry.
  it("transient gh pr create, findOpenPrForBranch also fails transiently → rethrows secondary transient", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },              // git push
      { code: 1, stdout: "", stderr: "ECONNRESET" },    // pr create transient
      { code: 1, stdout: "", stderr: "ETIMEDOUT" },     // pr list also transient
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow(/ETIMEDOUT/);
  });

  // ES-488 Finding 1: when duplicate-PR error triggers lookup and that lookup fails
  // with a deterministic error, the original duplicate error is still rethrown.
  it("duplicate-PR error, findOpenPrForBranch fails deterministically → throws original error", async () => {
    const runner = stubRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 1, stdout: "", stderr: "HTTP 401 Unauthorized" }, // deterministic
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    await expect(git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue))
      .rejects.toThrow(/gh pr create failed.*a pull request for branch/);
  });

  // ES-488 Finding 1+2 integration: outer retryTransient retries when the duplicate-branch
  // path surfaces a transient lookup failure, and succeeds on the next attempt.
  it("retryTransient retries after duplicate-PR error + transient lookup failure, succeeds on next attempt", async () => {
    const runner = stubRunner([
      // Attempt 1: push OK, pr create gets duplicate error, pr list fails transiently
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 1, stdout: "", stderr: "ECONNRESET" },
      // retryTransient sees ECONNRESET → retries pushAndOpenPr
      // Attempt 2: push OK, pr create gets duplicate error again, pr list succeeds
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: 'a pull request for branch "feat-branch" already exists:' },
      { code: 0, stdout: JSON.stringify([{ number: 88 }]), stderr: "" },
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    const prNumber = await retryTransient(2, () =>
      git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue),
    );
    expect(prNumber).toBe(88);
  });

  it("retryTransient + idempotent pushAndOpenPr → no duplicate PR", async () => {
    const runner = stubRunner([
      // Attempt 1: push OK, pr create network drop, pr list finds no existing PR
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "ECONNRESET" },
      { code: 0, stdout: "[]", stderr: "" },
      // pushAndOpenPr throws (no existing PR). retryTransient retries (ECONNRESET is transient).
      // Attempt 2: push OK (idempotent), pr create succeeds
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "https://github.com/o/r/pull/99\n", stderr: "" },
    ]);

    const git = new GitPrManager(runner, {
      repoPath: "/repo", remote: "o/r", defaultBranch: "main",
      branchPrefix: "lp", worktreeRoot: "/wt", prBodyTemplate: "", gateLabel: "lp",
    });

    const prNumber = await retryTransient(2, () =>
      git.pushAndOpenPr("feat-branch", "/wt/feat", fakeIssue),
    );
    expect(prNumber).toBe(99);
  });
});
