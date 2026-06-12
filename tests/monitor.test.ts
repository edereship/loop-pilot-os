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
    statusCheckRollup: Array<
      | { status: string; conclusion: string | null }
      | { state: string }
    >;
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

  it("state=='MERGED' でも merged を返す（mergedAt 経路と等価, §5.4 規則1）", async () => {
    const { monitor } = makeMonitor({ view: prView({ state: "MERGED" }) });
    expect(await monitor.poll(1)).toEqual<MonitorVerdict>({ kind: "merged" });
  });

  it("stopped(status) と merged が同時なら merged が勝つ（コメントを読まない, §5.4 規則1）", async () => {
    // stopped の state コメントが在っても、mergedAt があれば merged を優先
    const { monitor, runner } = makeMonitor({
      view: prView({ mergedAt: "2026-06-05T01:00:00Z" }),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({
              status: "stopped",
              stopReason: "max_iterations",
            }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(7)).toEqual<MonitorVerdict>({ kind: "merged" });
    // merged は最優先なのでコメント取得は呼ばれない
    expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
  });

  it("未マージ ∧ state=='CLOSED' → pr_closed（コメントを読まない, §5.4 規則2）", async () => {
    const { monitor, runner } = makeMonitor({
      view: prView({ state: "CLOSED", closed: true }),
    });
    expect(await monitor.poll(2)).toEqual<MonitorVerdict>({ kind: "pr_closed" });
    expect(runner.calls.some((c) => c.args[0] === "api")).toBe(false);
  });

  it("信頼コメントが status=='done' → done（§5.4 規則3）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(3)).toEqual<MonitorVerdict>({ kind: "done" });
  });

  it("信頼コメントが status=='stopped' で stopReason を保持して返す（§5.4 規則3）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({
              status: "stopped",
              stopReason: "test_failure",
            }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(4)).toEqual<MonitorVerdict>({
      kind: "stopped",
      stopReason: "test_failure",
    });
  });

  it("status=='stopped' で stopReason==null を null のまま保持する（変換しない, §5.4）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "stopped", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(5)).toEqual<MonitorVerdict>({
      kind: "stopped",
      stopReason: null,
    });
  });

  it.each(["initialized", "waiting_codex", "fixing"])(
    "status=='%s' → in_progress（§5.4 規則3）",
    async (status) => {
      const { monitor } = makeMonitor({
        view: prView(),
        comments: commentsSlurp([
          [
            {
              author: "github-actions[bot]",
              body: stateCommentBody({ status, stopReason: null }),
            },
          ],
        ]),
      });
      expect(await monitor.poll(6)).toEqual<MonitorVerdict>({
        kind: "in_progress",
      });
    },
  );

  it("偽装著者（信頼著者でない）の state コメントは無視し not_engaged（§5.4 規則1: author 一致）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "attacker", // 信頼著者でない
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(8)).toEqual<MonitorVerdict>({
      kind: "not_engaged",
    });
  });

  it("可視先頭テキストが一致しない（startsWith 不成立）コメントは無視し not_engaged（§5.4 規則2）", async () => {
    // 隠しマーカーは含むが、可視テキストで「始まらない」（前置あり）。
    // state-manager.ts の Linear linkback ケース（マーカーを引用するが先頭テキストで始まらない）に相当。
    const tampered =
      "FYI here is the state:\n\n" +
      stateCommentBody({ status: "done", stopReason: null });
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [{ author: "github-actions[bot]", body: tampered }],
      ]),
    });
    expect(await monitor.poll(9)).toEqual<MonitorVerdict>({
      kind: "not_engaged",
    });
  });

  it("可視テキストで始まるが隠しマーカーを含まない（contains 不成立）コメントは無視し not_engaged（§5.4 規則3）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            // 可視先頭テキストのみ。<!-- looppilot-state を含まない
            body: STATE_COMMENT_VISIBLE_TEXT_FOR_TEST + "\n\n(no hidden marker)",
          },
        ],
      ]),
    });
    expect(await monitor.poll(10)).toEqual<MonitorVerdict>({
      kind: "not_engaged",
    });
  });

  it("信頼 state コメントが複数あれば最後（最新）を採用する（§5.4 規則4・ページ跨ぎ flat 含む）", async () => {
    // ページ1=done, ページ2=stopped。flat 後の末尾 = stopped が勝つ
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({
              status: "stopped",
              stopReason: "loop_detected",
            }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(11)).toEqual<MonitorVerdict>({
      kind: "stopped",
      stopReason: "loop_detected",
    });
  });

  it("同一ページ内に信頼 state コメントが複数あれば末尾を採用する（§5.4 規則4）", async () => {
    // 末尾 = done が勝つ（in_progress を上書き）
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "fixing", stopReason: null }),
          },
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(17)).toEqual<MonitorVerdict>({ kind: "done" });
  });

  it("user===null のコメント（ghost/削除アカウント）でクラッシュせず、有効な信頼コメントを採用する", async () => {
    // GitHub は削除/ghost アカウントのコメントを user:null で返す。著者フィルタ前に
    // c.user.login を触ると TypeError でセッションが exception HALT に固着する。
    const slurp = JSON.stringify([
      [
        { user: null, body: "third-party comment from a deleted account" },
        {
          user: { login: "github-actions[bot]" },
          body: stateCommentBody({ status: "done", stopReason: null }),
        },
      ],
    ]);
    const { monitor } = makeMonitor({ view: prView(), comments: slurp });
    expect(await monitor.poll(31)).toEqual<MonitorVerdict>({ kind: "done" });
  });

  it("信頼著者コメントは在るが JSON 破損 → corrupted（§5.4 規則4: パース不能）", async () => {
    // 可視テキスト + マーカー + 前後改行は満たすが、内側 JSON が壊れている
    const broken =
      STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
      "\n\n<!-- looppilot-state\n{ not: valid json,, }\n-->";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [{ author: "github-actions[bot]", body: broken }],
      ]),
    });
    expect(await monitor.poll(12)).toEqual<MonitorVerdict>({
      kind: "corrupted",
    });
  });

  it("信頼著者コメントは在るが内側が非オブジェクト JSON（bare string）→ corrupted（§5.4 規則4）", async () => {
    // JSON.parse は成功するが object でない（status を持てない）
    const bare =
      STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
      '\n\n<!-- looppilot-state\n"just a string"\n-->';
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [{ author: "github-actions[bot]", body: bare }],
      ]),
    });
    expect(await monitor.poll(18)).toEqual<MonitorVerdict>({
      kind: "corrupted",
    });
  });

  it("信頼著者コメントは在るが status が不正値 → corrupted（§5.4 規則4）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({
              status: "bogus_status",
              stopReason: null,
            }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(13)).toEqual<MonitorVerdict>({
      kind: "corrupted",
    });
  });

  it("信頼著者コメントは在るが抽出 regex に一致しない（マーカー前後の改行欠落）→ corrupted（§5.4 規則4）", async () => {
    // startsWith / includes は満たすが、`\n([\s\S]*?)\n` の前後改行を欠くため regex 不一致
    const noNewlines =
      STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
      '\n\n<!-- looppilot-state {"status":"done"} -->';
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [{ author: "github-actions[bot]", body: noNewlines }],
      ]),
    });
    expect(await monitor.poll(14)).toEqual<MonitorVerdict>({
      kind: "corrupted",
    });
  });

  it("コメントが1件も無い（空ページ）→ not_engaged（§5.4 規則5）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([[]]),
    });
    expect(await monitor.poll(15)).toEqual<MonitorVerdict>({
      kind: "not_engaged",
    });
  });

  it("信頼著者の corrupted コメントの後に偽装著者の正常 done があっても corrupted（信頼著者のみが対象, §5.4 規則1+4）", async () => {
    // 信頼著者の壊れた state（末尾の信頼コメント）が勝ち、偽装著者の done は無視される
    const broken =
      STATE_COMMENT_VISIBLE_TEXT_FOR_TEST +
      "\n\n<!-- looppilot-state\n{ broken }\n-->";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          { author: "github-actions[bot]", body: broken },
          {
            author: "attacker",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(19)).toEqual<MonitorVerdict>({
      kind: "corrupted",
    });
  });

  it("trustedAuthors に複数著者を設定でき、いずれか一致で採用する（§5.4 規則1）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "looppilot-app[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
        ],
      ]),
      trustedAuthors: ["github-actions[bot]", "looppilot-app[bot]"],
    });
    expect(await monitor.poll(16)).toEqual<MonitorVerdict>({ kind: "done" });
  });
});

describe("GhLoopPilotMonitor.checkMergeReadiness — 決定順 ①-⑥ (§5.3)", () => {
  it("① mergeable=='CONFLICTING' → conflict（最優先）", async () => {
    // CONFLICTING かつ BLOCKED でも、conflict が先に成立する
    const { monitor } = makeMonitor({
      view: prView({ mergeable: "CONFLICTING", mergeStateStatus: "BLOCKED" }),
    });
    expect(await monitor.checkMergeReadiness(1)).toEqual<MergeReadiness>({
      ready: false,
      reason: "conflict",
    });
  });

  it("① mergeStateStatus=='DIRTY' → conflict（mergeable が MERGEABLE でも）", async () => {
    const { monitor } = makeMonitor({
      view: prView({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }),
    });
    expect(await monitor.checkMergeReadiness(2)).toEqual<MergeReadiness>({
      ready: false,
      reason: "conflict",
    });
  });

  it("② 完了かつ conclusion が失敗 → ci_failed（未完了チェックより先, conflict 不成立時）", async () => {
    // FAILURE は GREEN_CONCLUSIONS に無い。未完了チェックが在っても ② が先に成立する
    const { monitor } = makeMonitor({
      view: prView({
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "FAILURE" },
          { status: "IN_PROGRESS", conclusion: null },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(3)).toEqual<MergeReadiness>({
      ready: false,
      reason: "ci_failed",
    });
  });

  it("② 完了かつ conclusion==null（TIMED_OUT 相当の欠落）も失敗扱い → ci_failed", async () => {
    // COMPLETED だが conclusion が null/未知 → グリーン集合に無いので失敗扱い
    const { monitor } = makeMonitor({
      view: prView({
        statusCheckRollup: [{ status: "COMPLETED", conclusion: null }],
      }),
    });
    expect(await monitor.checkMergeReadiness(10)).toEqual<MergeReadiness>({
      ready: false,
      reason: "ci_failed",
    });
  });

  it("② NEUTRAL / SKIPPED は失敗扱いしない（グリーン扱い）→ ready", async () => {
    // 全て completed かつ {SUCCESS,NEUTRAL,SKIPPED} のみ・MERGEABLE → ready
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "feedface1234",
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "NEUTRAL" },
          { status: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(4)).toEqual<MergeReadiness>({
      ready: true,
      headSha: "feedface1234",
    });
  });

  it("③ 未完了チェックあり（失敗は無い）→ ci_pending", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "IN_PROGRESS", conclusion: null },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(5)).toEqual<MergeReadiness>({
      ready: false,
      reason: "ci_pending",
    });
  });

  it("④ 全グリーン（チェックあり）かつ mergeStateStatus=='BLOCKED' → blocked", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    });
    expect(await monitor.checkMergeReadiness(6)).toEqual<MergeReadiness>({
      ready: false,
      reason: "blocked",
    });
  });

  it("④ チェック空配列（=チェック無し=グリーン扱い）かつ BLOCKED → blocked", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [],
      }),
    });
    expect(await monitor.checkMergeReadiness(7)).toEqual<MergeReadiness>({
      ready: false,
      reason: "blocked",
    });
  });

  it("⑤ 全グリーン（空配列含む）かつ MERGEABLE かつ非 BLOCKED → ready(headSha=headRefOid)", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "abc123sha",
        statusCheckRollup: [],
      }),
    });
    expect(await monitor.checkMergeReadiness(8)).toEqual<MergeReadiness>({
      ready: true,
      headSha: "abc123sha",
    });
  });

  it("⑥ いずれにも該当しない（mergeable=='UNKNOWN'・非BLOCKED・グリーン）→ unknown", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    });
    expect(await monitor.checkMergeReadiness(9)).toEqual<MergeReadiness>({
      ready: false,
      reason: "unknown",
    });
  });

  // legacy commit status（StatusContext）は status/conclusion を持たず state を持つ。
  // gh pr view --json statusCheckRollup は CheckRun と StatusContext を混在で返すため、
  // state を解釈しないと「失敗を見逃し」「成功すら永久 pending 扱いでマージ不能」になる。
  it("StatusContext state=='FAILURE' → ci_failed（status/conclusion が無くても失敗を検出）", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { state: "FAILURE" },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(10)).toEqual<MergeReadiness>({
      ready: false,
      reason: "ci_failed",
    });
  });

  it("StatusContext state=='SUCCESS' のみ（全グリーン・MERGEABLE）→ ready（pending 誤判定しない）", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "ctxsha",
        statusCheckRollup: [{ state: "SUCCESS" }],
      }),
    });
    expect(await monitor.checkMergeReadiness(11)).toEqual<MergeReadiness>({
      ready: true,
      headSha: "ctxsha",
    });
  });

  it("StatusContext state=='PENDING' → ci_pending", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { state: "PENDING" },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(12)).toEqual<MergeReadiness>({
      ready: false,
      reason: "ci_pending",
    });
  });

  it("CheckRun と StatusContext 混在で双方グリーン → ready", async () => {
    const { monitor } = makeMonitor({
      view: prView({
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "mixsha",
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { state: "SUCCESS" },
        ],
      }),
    });
    expect(await monitor.checkMergeReadiness(13)).toEqual<MergeReadiness>({
      ready: true,
      headSha: "mixsha",
    });
  });
});

describe("GhLoopPilotMonitor — gh 終了コード検査（失敗を JSON.parse 偶発に頼らない）", () => {
  // gh が非0終了かつ stdout に何らかの JSON を載せた場合でも、失敗を成功として
  // 採用してはならない（poll の backoff/5連続停止の安全弁を迂回させない）。
  it("poll: gh pr view が非0終了なら（stdout に JSON があっても）throw する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], {
      code: 1,
      stdout: '{"state":"OPEN","mergedAt":null,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"x","statusCheckRollup":[],"closed":false}',
      stderr: "gh: API rate limit exceeded",
    });
    const monitor = new GhLoopPilotMonitor(runner, { remote: REMOTE, trustedAuthors: TRUSTED });
    await expect(monitor.poll(40)).rejects.toThrow(/gh pr view/);
  });

  it("checkMergeReadiness: gh pr view が非0終了なら throw する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 1, stdout: "{}", stderr: "boom" });
    const monitor = new GhLoopPilotMonitor(runner, { remote: REMOTE, trustedAuthors: TRUSTED });
    await expect(monitor.checkMergeReadiness(41)).rejects.toThrow(/gh pr view/);
  });

  it("poll: コメント取得(gh api)が非0終了なら throw する（not_engaged 誤判定しない）", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 0, stdout: prView(), stderr: "" });
    runner.on(["gh", "api"], { code: 1, stdout: "[]", stderr: "gh: Not Found" });
    const monitor = new GhLoopPilotMonitor(runner, { remote: REMOTE, trustedAuthors: TRUSTED });
    await expect(monitor.poll(42)).rejects.toThrow(/gh api/);
  });
});

describe("GhLoopPilotMonitor — gh 呼び出し形の固定 (§5.3)", () => {
  it("poll は gh pr view を契約どおりの -R / --json フィールドで呼ぶ", async () => {
    const { monitor, runner } = makeMonitor({
      view: prView({ mergedAt: "2026-06-05T00:00:00Z" }),
    });
    await monitor.poll(123);
    const call = runner.calls.find(
      (c) => c.args[0] === "pr" && c.args[1] === "view",
    );
    expect(call).toBeDefined();
    expect(call!.cmd).toBe("gh");
    expect(call!.args).toEqual([
      "pr",
      "view",
      "123",
      "-R",
      REMOTE,
      "--json",
      "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
    ]);
  });

  it("poll は comments を gh api ... --paginate --slurp で owner/name 分解して呼ぶ", async () => {
    const { monitor, runner } = makeMonitor({
      view: prView(), // 未マージ・未クローズ → コメント取得まで進む
      comments: commentsSlurp([[]]),
    });
    await monitor.poll(77);
    const call = runner.calls.find((c) => c.args[0] === "api");
    expect(call).toBeDefined();
    expect(call!.cmd).toBe("gh");
    expect(call!.args).toEqual([
      "api",
      "repos/acme/widget/issues/77/comments",
      "--paginate",
      "--slurp",
    ]);
  });

  it("checkMergeReadiness は gh pr view を同一の -R / --json フィールドで呼ぶ", async () => {
    const { monitor, runner } = makeMonitor({
      view: prView({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    });
    await monitor.checkMergeReadiness(55);
    const call = runner.calls.find(
      (c) => c.args[0] === "pr" && c.args[1] === "view",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual([
      "pr",
      "view",
      "55",
      "-R",
      REMOTE,
      "--json",
      "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
    ]);
  });
});

describe("GhLoopPilotMonitor.poll — ⚠️ error comment detection (ES-397)", () => {
  it("⚠️コメント1件 + state=initialized → workflow_failed(count=1, body=⚠️コメント)", async () => {
    const errorBody = "⚠️ **LoopPilot Workflow B failed before the auto-fix loop could start.**";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
          {
            author: "github-actions[bot]",
            body: errorBody,
          },
        ],
      ]),
    });
    expect(await monitor.poll(50)).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody,
      errorCommentCount: 1,
      hasStateComment: true,
    });
  });

  it("⚠️コメント2件 + stateコメントなし → workflow_failed(count=2, body=最新)", async () => {
    const error1 = "⚠️ first failure";
    const error2 = "⚠️ second failure";
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          { author: "github-actions[bot]", body: error1 },
          { author: "github-actions[bot]", body: error2 },
        ],
      ]),
    });
    const verdict = await monitor.poll(51);
    expect(verdict).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody: error2,
      errorCommentCount: 2,
      hasStateComment: false,
    });
  });

  it("⚠️コメント0件 + state=initialized → in_progress（既存動作不変）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(52)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("⚠️コメント0件 + stateコメントなし → not_engaged（既存動作不変）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([[]]),
    });
    expect(await monitor.poll(53)).toEqual<MonitorVerdict>({ kind: "not_engaged" });
  });

  it("⚠️コメント1件 + state=done → done（done が優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "done", stopReason: null }),
          },
          { author: "github-actions[bot]", body: "⚠️ old failure" },
        ],
      ]),
    });
    expect(await monitor.poll(54)).toEqual<MonitorVerdict>({ kind: "done" });
  });

  it("⚠️コメント1件 + state=stopped → stopped（stopped が優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "stopped", stopReason: "max_iterations" }),
          },
          { author: "github-actions[bot]", body: "⚠️ old failure" },
        ],
      ]),
    });
    expect(await monitor.poll(55)).toEqual<MonitorVerdict>({
      kind: "stopped",
      stopReason: "max_iterations",
    });
  });

  it("偽装著者の⚠️は無視し、信頼著者の⚠️のみカウントする", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          { author: "attacker", body: "⚠️ fake error" },
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(56)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("stateコメントは⚠️カウントに含めない（STATE_COMMENT_VISIBLE_TEXT先頭はstate優先）", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "initialized", stopReason: null }),
          },
        ],
      ]),
    });
    expect(await monitor.poll(57)).toEqual<MonitorVerdict>({ kind: "in_progress" });
  });

  it("⚠️が複数ページに跨ぐ場合でもカウントが正確", async () => {
    const { monitor } = makeMonitor({
      view: prView(),
      comments: commentsSlurp([
        [
          {
            author: "github-actions[bot]",
            body: stateCommentBody({ status: "waiting_codex", stopReason: null }),
          },
          { author: "github-actions[bot]", body: "⚠️ page 1 error" },
        ],
        [
          { author: "github-actions[bot]", body: "⚠️ page 2 error" },
        ],
      ]),
    });
    const verdict = await monitor.poll(58);
    expect(verdict).toEqual<MonitorVerdict>({
      kind: "workflow_failed",
      errorBody: "⚠️ page 2 error",
      errorCommentCount: 2,
      hasStateComment: true,
    });
  });
});

describe("GhLoopPilotMonitor — gh 失敗時は throw（オーケストレーターのバックオフ契約）", () => {
  // 仕様(§7 step6): gh pr view 失敗（非0 exit・空 stdout）で poll は誤分類せず reject する
  it("gh pr view が非0 exit・空 stdout を返したら poll は reject する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 1, stdout: "", stderr: "gh: Not Found" });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: REMOTE,
      trustedAuthors: TRUSTED,
    });
    await expect(monitor.poll(42)).rejects.toThrow();
  });

  // gh pr view が壊れた出力を返したら poll は reject する
  it("gh pr view が壊れた出力（HTML）を返したら poll は reject する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 0, stdout: "<html>rate limited</html>", stderr: "" });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: REMOTE,
      trustedAuthors: TRUSTED,
    });
    await expect(monitor.poll(42)).rejects.toThrow();
  });

  // コメント取得失敗（非0 exit・空 stdout）でも poll は reject する
  it("gh api コメント取得が非0 exit・空 stdout を返したら poll は reject する", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], { code: 0, stdout: prView(), stderr: "" });
    runner.on(["gh", "api"], { code: 1, stdout: "", stderr: "" });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: REMOTE,
      trustedAuthors: TRUSTED,
    });
    await expect(monitor.poll(42)).rejects.toThrow();
  });

  // 防御: 将来の gh が statusCheckRollup を null で返しても checkMergeReadiness は throw しない（poll バックオフ外のため fail-safe）
  it("statusCheckRollup が null でも checkMergeReadiness は throw せず ready を返す", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["gh", "pr", "view"], {
      code: 0,
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "deadbeefcafe",
        statusCheckRollup: null,
        closed: false,
      }),
      stderr: "",
    });
    const monitor = new GhLoopPilotMonitor(runner, {
      remote: REMOTE,
      trustedAuthors: TRUSTED,
    });
    expect(await monitor.checkMergeReadiness(42)).toEqual<MergeReadiness>({
      ready: true,
      headSha: "deadbeefcafe",
    });
  });
});
