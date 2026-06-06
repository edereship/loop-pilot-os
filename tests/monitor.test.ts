import { describe, it, expect } from "vitest";
import { GhLoopPilotMonitor } from "../src/monitor.js";
import { FakeCommandRunner } from "./fakes.js";
import type { MonitorVerdict, MergeReadiness } from "../src/types.js";

// ---- fixture helpers ----------------------------------------------------

const REMOTE = "acme/widget";
const TRUSTED = ["github-actions[bot]"];

/** state-manager.ts STATE_COMMENT_VISIBLE_TEXT と同一（テスト内参照用） */
const STATE_COMMENT_VISIBLE_TEXT_FOR_TEST =
  "LoopPilot state is stored in this comment.";

/**
 * LoopPilot serializeState の実形式に正確に一致させる（state-manager.ts L286-294 検証済み）:
 * "LoopPilot state is stored in this comment.\n\n<!-- looppilot-state\n<json(2-space)>\n-->"
 */
function stateCommentBody(state: Record<string, unknown>): string {
  const json = JSON.stringify(state, null, 2);
  return (
    STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
    "\n\n" +
    "<!-- looppilot-state" +
    "\n" +
    json +
    "\n" +
    "-->"
  );
}

/** gh pr view --json の戻り（必要フィールドのみ。未指定はグリーン/未マージの既定） */
function prView(
  overrides: Partial<{
    state: string;
    mergedAt: string | null;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
    closed: boolean;
  }> = {},
): string {
  return JSON.stringify({
    state: overrides.state ?? "OPEN",
    mergedAt: overrides.mergedAt ?? null,
    mergeable: overrides.mergeable ?? "MERGEABLE",
    mergeStateStatus: overrides.mergeStateStatus ?? "CLEAN",
    headRefOid: overrides.headRefOid ?? "deadbeefcafe",
    statusCheckRollup: overrides.statusCheckRollup ?? [],
    closed: overrides.closed ?? false,
  });
}

/** gh api ... comments --paginate --slurp の戻り（ページ配列の配列 [[...],[...]]） */
function commentsSlurp(
  pages: Array<Array<{ author: string; body: string }>>,
): string {
  return JSON.stringify(
    pages.map((page) =>
      page.map((c) => ({ user: { login: c.author }, body: c.body })),
    ),
  );
}

/** runner を pr view / comments の応答で構成して Monitor を返す */
function makeMonitor(opts: {
  view: string;
  comments?: string;
  trustedAuthors?: string[];
}): { monitor: GhLoopPilotMonitor; runner: FakeCommandRunner } {
  const runner = new FakeCommandRunner();
  runner.on(["gh", "pr", "view"], { code: 0, stdout: opts.view, stderr: "" });
  if (opts.comments !== undefined) {
    runner.on(["gh", "api"], { code: 0, stdout: opts.comments, stderr: "" });
  }
  const monitor = new GhLoopPilotMonitor(runner, {
    remote: REMOTE,
    trustedAuthors: opts.trustedAuthors ?? TRUSTED,
  });
  return { monitor, runner };
}

describe("GhLoopPilotMonitor.poll — verdict 決定順 (§5.4)", () => {
  it("mergedAt != null は最優先で merged を返し、コメントを取りに行かない (§5.4 規則1)", async () => {
    const { monitor, runner } = makeMonitor({
      view: prView({ mergedAt: "2026-06-05T00:00:00Z" }),
      // comments は登録しない: 呼ばれたら FakeCommandRunner が throw する
    });
    const verdict = await monitor.poll(42);
    expect(verdict).toEqual<MonitorVerdict>({ kind: "merged" });
    // コメント取得 (gh api) を一切呼ばないこと
    expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
  });
});
