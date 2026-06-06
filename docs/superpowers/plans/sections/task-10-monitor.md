### Task 10: LoopPilot Monitor

**目的**: PR の merged 状態と `looppilot-state` 隠しコメントを読み、カーネル §5.4 の単一検知式（`poll()`）と §5.3 のマージ可否判定（`checkMergeReadiness()`）を実装する `GhLoopPilotMonitor` を作る。コメントの特定・抽出は LoopPilot 実ソース（`/home/racoma-dev/loop-pilot/src/state-manager.ts`）の規則と一字一句一致させ、`merged | done | stopped(reason) | in_progress | corrupted | not_engaged | pr_closed` を決定的に返す。

**依存タスク**: Task 2（`src/types.ts` の `MonitorVerdict` / `MergeReadiness` / `LoopPilotMonitor` / `CommandRunner` / `CommandResult` / `RunOptions`）、Task 3（`tests/fakes.ts` の `FakeCommandRunner`）。本タスクは `src/monitor.ts` と `tests/monitor.test.ts` のみを新規作成する。`tests/fakes.ts` は Task 3 で既に `FakeCommandRunner`（`on(cmdPrefix, result)` 前方一致 + `calls` 記録）を export 済みである前提（本タスクでは変更しない）。

**カーネル契約の要点（このタスクが従う唯一の正）**:

- コンストラクタ（タスク指定）: `new GhLoopPilotMonitor(runner: CommandRunner, opts: { remote: string; trustedAuthors: string[] })`。`remote` は `"owner/name"` 形式。`trustedAuthors` は `config.looppilot.stateCommentAuthors`。Monitor の opts に repoPath は無い（カーネル §2 の `LoopPilotMonitor` は `poll`/`checkMergeReadiness` のみを規定し、gh は `-R <remote>` でリポを指定するため cwd は任意でよい。本実装は `process.cwd()` を渡す）。
- `poll(prNumber)` の決定順（§5.4。この順に評価し、最初に成立したものを返し以降を読まない）:
  1. `gh pr view <pr> -R <remote> --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed` を実行。`mergedAt != null` または `state === "MERGED"` → `{ kind: "merged" }`（**最優先**。コメントを取りに行く前に判定する）
  2. 未マージ ∧ `state === "CLOSED"` → `{ kind: "pr_closed" }`
  3. ここで初めてコメントを取得（`gh api ... comments --paginate --slurp`）。信頼 state コメント（特定規則）が存在しパース成功:
     - `status === "stopped"` → `{ kind: "stopped", stopReason }`（`stopReason` は文字列 or null。null はそのまま保持・変換しない）
     - `status === "done"` → `{ kind: "done" }`
     - `status ∈ {initialized, waiting_codex, fixing}` → `{ kind: "in_progress" }`
  4. 信頼著者コメントは存在するがパース不能/不正 status → `{ kind: "corrupted" }`
  5. 信頼コメント未出現 → `{ kind: "not_engaged" }`
- コメント特定の4規則（§5.4・`state-manager.ts` と同一）:
  1. `author.login` が `trustedAuthors` のいずれかに一致（`state-manager.ts` の `buildTrustedAuthorJqFilter`: `.user.login == "<author>"`）
  2. `body` が `LoopPilot state is stored in this comment.` で**始まる**（`startsWith`。`state-manager.ts` jq: `startswith(STATE_COMMENT_VISIBLE_TEXT)`）
  3. `body` が `<!-- looppilot-state` を**含む**（`includes`。`state-manager.ts` jq: `contains(STATE_COMMENT_OPEN)`）
  4. 複数該当時は**最後**のもの（gh は作成昇順で返すため配列末尾 = 最新。`state-manager.ts`: `lines[lines.length - 1]`）
- state 抽出 regex（一字一句、`state-manager.ts` `deserializeState` の `STATE_COMMENT_OPEN + "\\n([\\s\\S]*?)\\n" + STATE_COMMENT_CLOSE` と等価）: `/<!-- looppilot-state\n([\s\S]*?)\n-->/` の捕捉グループ1を `JSON.parse`。`status` ∈ {initialized, waiting_codex, fixing, done, stopped}（`state-manager.ts` `VALID_STATUSES`）。それ以外/`JSON.parse` 失敗/非オブジェクト/`status` 非文字列 → corrupted。
- corrupted の定義: 上記4規則を満たす信頼著者コメントが**存在する**が、(a) regex 不一致、(b) `JSON.parse` 失敗、(c) パース結果が非オブジェクト、(d) `status` が文字列でない、(e) `status` が上記5値以外、のいずれか。
- gh api comments は `gh api repos/<o>/<n>/issues/<pr>/comments --paginate --slurp` で取得。`--paginate --slurp` の出力は**ページ配列の配列** `[[...],[...]]`（カーネル §5.3 明記）なので flat 化してから走査する。
- `checkMergeReadiness(prNumber)` の決定順（§5.3 ①-⑥。この順に評価し最初に成立したものを返す）:
  - ① `mergeable === "CONFLICTING"` または `mergeStateStatus === "DIRTY"` → `{ ready:false, reason:"conflict" }`
  - ② `statusCheckRollup` に失敗（`status === "COMPLETED"` かつ `conclusion ∉ {SUCCESS, NEUTRAL, SKIPPED}`）が1つでも → `{ ready:false, reason:"ci_failed" }`
  - ③ 未完了チェックあり（`status !== "COMPLETED"` が1つでも）→ `{ ready:false, reason:"ci_pending" }`
  - ④ 全チェック完了グリーン（空配列=チェック無し=グリーン扱い）かつ `mergeStateStatus === "BLOCKED"` → `{ ready:false, reason:"blocked" }`
  - ⑤ `mergeable === "MERGEABLE"` → `{ ready:true, headSha: headRefOid }`
  - ⑥ それ以外 → `{ ready:false, reason:"unknown" }`

**LoopPilot serializeState 実形式（fixture を一致させる根拠、`state-manager.ts` 検証済み）**: `serializeState`（L283-329）は body を

```
LoopPilot state is stored in this comment.<\n><\n><!-- looppilot-state<\n>{JSON.stringify(state, null, 2)}<\n>-->
```

の連結で生成する（L286-294: `VISIBLE_TEXT + "\n\n" + "<!-- looppilot-state" + "\n" + json + "\n" + "-->"`）。`STATE_COMMENT_OPEN = "<!-- " + "looppilot-state"`（L20-21）。本タスクの fixture ヘルパ `stateCommentBody` はこの連結式を**一字一句**再現する。

---

#### Files

- **Create**: `/home/racoma-dev/loop-pilot-os/src/monitor.ts`
- **Test**: `/home/racoma-dev/loop-pilot-os/tests/monitor.test.ts`
- **Test fixtures**: gh pr view JSON / comments slurp JSON は test 内のヘルパ（`prView` / `commentsSlurp` / `stateCommentBody`）で生成する。`tests/fixtures/` は使わず本タスクは上記2ファイルのみ作成する。

---

#### Steps

- [ ] **Step 1: 失敗するテストの足場を作る（import + fixture ヘルパ + 1ケースだけ）。** 新規ファイル `/home/racoma-dev/loop-pilot-os/tests/monitor.test.ts` を以下の完全な内容で作成する。この時点では `src/monitor.ts` が無いため import 解決で失敗する。

  ```typescript
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
  ```

- [ ] **Step 2: テストを実行して失敗を確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待される失敗: `Failed to resolve import "../src/monitor.js" from "tests/monitor.test.ts"`（`src/monitor.ts` 未作成）。

- [ ] **Step 3: Step 1 の merged ケースだけを通す最小実装を書く。** 新規ファイル `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を以下の完全な内容で作成する。この段階では Step 1 の `merged` ケースを green にするのに必要なものだけ（コンストラクタ + `fetchPrView` + `poll` の merged 判定）を実装し、それ以外の poll 分岐（pr_closed/done/stopped/in_progress/corrupted/not_engaged）と `checkMergeReadiness` は**未実装のまま明示 throw** にする。残り分岐の実装は Step 7b（poll）・Step 9b（readiness）の red→green サイクルで追加する。

  ```typescript
  import type {
    CommandRunner,
    LoopPilotMonitor,
    MergeReadiness,
    MonitorVerdict,
  } from "./types.js";

  // ---- gh pr view --json の型 ---------------------------------------------

  interface PrViewJson {
    state: string;
    mergedAt: string | null;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
    closed: boolean;
  }

  export interface GhLoopPilotMonitorOptions {
    remote: string; // "owner/name"
    trustedAuthors: string[];
  }

  export class GhLoopPilotMonitor implements LoopPilotMonitor {
    private readonly runner: CommandRunner;
    private readonly remote: string;
    private readonly trustedAuthors: string[];
    private readonly owner: string;
    private readonly name: string;

    constructor(runner: CommandRunner, opts: GhLoopPilotMonitorOptions) {
      this.runner = runner;
      this.remote = opts.remote;
      this.trustedAuthors = opts.trustedAuthors;
      const slash = opts.remote.indexOf("/");
      this.owner = opts.remote.slice(0, slash);
      this.name = opts.remote.slice(slash + 1);
    }

    async poll(prNumber: number): Promise<MonitorVerdict> {
      const pr = await this.fetchPrView(prNumber);

      // §5.4 規則1: merged が最優先（コメントを取りに行く前に判定）
      if (pr.mergedAt !== null || pr.state === "MERGED") {
        return { kind: "merged" };
      }

      // 残りの verdict 分岐は Step 7b の red→green で実装する（現時点は未実装）
      throw new Error("poll: non-merged verdicts not implemented yet");
    }

    async checkMergeReadiness(_prNumber: number): Promise<MergeReadiness> {
      // ①-⑥ は Step 9b の red→green で実装する（現時点は未実装）
      throw new Error("checkMergeReadiness not implemented yet");
    }

    // ---- 内部ヘルパ -------------------------------------------------------

    private async fetchPrView(prNumber: number): Promise<PrViewJson> {
      const result = await this.runner.run(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "-R",
          this.remote,
          "--json",
          "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
        ],
        { cwd: process.cwd() },
      );
      return JSON.parse(result.stdout) as PrViewJson;
    }
  }
  ```

  注: `owner`/`name`/`trustedAuthors` は Step 7b の `findTrustedStateComment` で初めて参照される。この最小実装の段階では private フィールドとして保持するだけにとどめ（`strict` の未使用ローカル検査はクラスフィールドには適用されないため `tsc` は通る）、Step 7b で消費する。`checkMergeReadiness` の引数は未使用のため `_prNumber`（先頭アンダースコアで未使用許容）とし、Step 9b で `prNumber` に戻して消費する。

- [ ] **Step 4: テストを実行して Step 1 のケースがグリーンになることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: `Tests  1 passed (1)`（merged ケース）。この時点では poll の他分岐と checkMergeReadiness は throw のままだが、それらに対応するテストはまだ追加していないため `failed 0`。

- [ ] **Step 5: `npm run check` を実行して型 + テスト全体がグリーンであることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`。期待: tsc（src）+ tsc（test）+ vitest がすべて成功（exit 0）。

- [ ] **Step 6: red-green の最初の単位をコミットする。** コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/monitor.ts tests/monitor.test.ts && git commit -m "feat: GhLoopPilotMonitor poll skeleton with merged-first verdict"`。

- [ ] **Step 7: poll の残り verdict 分岐の失敗するテストを追加する（red）。** `tests/monitor.test.ts` の `describe("GhLoopPilotMonitor.poll — verdict 決定順 (§5.4)", ...)` ブロック内（Step 1 で書いた `it("mergedAt != null ...")` の直後）に、以下の `it` 群を追加する。この時点で実装は Step 3 の最小形（merged 判定のみ、その他は throw）なので、これらは**失敗する**ことを期待する（次の Step 7b で実装を加えて green にする）。

  ```typescript
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
  ```

- [ ] **Step 7a: テストを実行して poll 残り分岐の失敗を確認する（red 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: Step 1 の `merged` ケースは `passed` のまま、Step 7 で追加した各 it（pr_closed / done / stopped / in_progress / corrupted / not_engaged / 規則1-4 / flat 等）が `failed`。失敗理由は実装側の未実装分岐（`pr.state !== "MERGED"` の経路に到達して `poll: non-merged verdicts not implemented yet` を throw）であること。

- [ ] **Step 7b: poll の残り verdict 分岐を実装する（green）。** `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を以下の完全な内容で**全置換**する。(1) ファイル冒頭の型 import 群の直後に LoopPilot `state-manager.ts` と同一の定数群と `IssueComment` 型を追加、(2) `poll` の `throw` を pr_closed / コメント特定 / status 分岐の実装へ置換、(3) `findTrustedStateComment` と `extractStatus` の private ヘルパを追加する。`checkMergeReadiness` はまだ Step 9b で実装するため throw のまま据え置く。

  ```typescript
  import type {
    CommandRunner,
    LoopPilotMonitor,
    MergeReadiness,
    MonitorVerdict,
  } from "./types.js";

  // ---- LoopPilot state-manager.ts と同一の定数 -----------------------------

  /** 信頼 state コメントの可視先頭テキスト（state-manager.ts: STATE_COMMENT_VISIBLE_TEXT） */
  const STATE_COMMENT_VISIBLE_TEXT = "LoopPilot state is stored in this comment.";
  /** 隠しコメント開始マーカー（state-manager.ts: STATE_COMMENT_OPEN = "<!-- " + "looppilot-state"） */
  const STATE_COMMENT_OPEN = "<!-- looppilot-state";
  /** state 抽出 regex（state-manager.ts deserializeState と同一の捕捉式） */
  const STATE_EXTRACT_RE = /<!-- looppilot-state\n([\s\S]*?)\n-->/;
  /** LoopPilot VALID_STATUSES（state-manager.ts L33） */
  const VALID_STATUSES = new Set([
    "initialized",
    "waiting_codex",
    "fixing",
    "done",
    "stopped",
  ]);

  // ---- gh pr view --json の型 ---------------------------------------------

  interface PrViewJson {
    state: string;
    mergedAt: string | null;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    statusCheckRollup: Array<{ status: string; conclusion: string | null }>;
    closed: boolean;
  }

  /** gh api issue comments の1要素（必要フィールドのみ） */
  interface IssueComment {
    user: { login: string };
    body: string;
  }

  export interface GhLoopPilotMonitorOptions {
    remote: string; // "owner/name"
    trustedAuthors: string[];
  }

  export class GhLoopPilotMonitor implements LoopPilotMonitor {
    private readonly runner: CommandRunner;
    private readonly remote: string;
    private readonly trustedAuthors: string[];
    private readonly owner: string;
    private readonly name: string;

    constructor(runner: CommandRunner, opts: GhLoopPilotMonitorOptions) {
      this.runner = runner;
      this.remote = opts.remote;
      this.trustedAuthors = opts.trustedAuthors;
      const slash = opts.remote.indexOf("/");
      this.owner = opts.remote.slice(0, slash);
      this.name = opts.remote.slice(slash + 1);
    }

    async poll(prNumber: number): Promise<MonitorVerdict> {
      const pr = await this.fetchPrView(prNumber);

      // §5.4 規則1: merged が最優先（コメントを取りに行く前に判定）
      if (pr.mergedAt !== null || pr.state === "MERGED") {
        return { kind: "merged" };
      }
      // §5.4 規則2: 未マージ ∧ CLOSED → pr_closed
      if (pr.state === "CLOSED") {
        return { kind: "pr_closed" };
      }

      // §5.4 規則3-5: ここで初めてコメントを取得して信頼 state コメントを特定
      const trusted = await this.findTrustedStateComment(prNumber);
      if (trusted === null) {
        return { kind: "not_engaged" };
      }

      const status = this.extractStatus(trusted.body);
      if (status === null) {
        return { kind: "corrupted" };
      }
      if (status.status === "stopped") {
        return { kind: "stopped", stopReason: status.stopReason };
      }
      if (status.status === "done") {
        return { kind: "done" };
      }
      // initialized | waiting_codex | fixing
      return { kind: "in_progress" };
    }

    async checkMergeReadiness(_prNumber: number): Promise<MergeReadiness> {
      // ①-⑥ は Step 9b の red→green で実装する（現時点は未実装）
      throw new Error("checkMergeReadiness not implemented yet");
    }

    // ---- 内部ヘルパ -------------------------------------------------------

    private async fetchPrView(prNumber: number): Promise<PrViewJson> {
      const result = await this.runner.run(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "-R",
          this.remote,
          "--json",
          "state,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,closed",
        ],
        { cwd: process.cwd() },
      );
      return JSON.parse(result.stdout) as PrViewJson;
    }

    /**
     * §5.4 のコメント特定4規則を適用して信頼 state コメントを返す。
     * 該当無し → null。複数該当 → 最後のもの（gh は作成昇順、配列末尾 = 最新）。
     */
    private async findTrustedStateComment(
      prNumber: number,
    ): Promise<IssueComment | null> {
      const result = await this.runner.run(
        "gh",
        [
          "api",
          `repos/${this.owner}/${this.name}/issues/${prNumber}/comments`,
          "--paginate",
          "--slurp",
        ],
        { cwd: process.cwd() },
      );
      // --paginate --slurp は [[...page1...],[...page2...]] を返すので flat 化（§5.3）
      const pages = JSON.parse(result.stdout) as IssueComment[][];
      const comments: IssueComment[] = pages.flat();

      let found: IssueComment | null = null;
      for (const c of comments) {
        // 規則1: 信頼著者
        if (!this.trustedAuthors.includes(c.user.login)) continue;
        // 規則2: 可視テキストで始まる
        if (!c.body.startsWith(STATE_COMMENT_VISIBLE_TEXT)) continue;
        // 規則3: 隠しマーカーを含む
        if (!c.body.includes(STATE_COMMENT_OPEN)) continue;
        // 規則4: 最後優先（上書きし続けて末尾を残す）
        found = c;
      }
      return found;
    }

    /**
     * 信頼コメント body から status / stopReason を抽出。
     * regex 不一致 / JSON.parse 失敗 / 非オブジェクト / status 非文字列・不正値 → null（= corrupted の合図）。
     */
    private extractStatus(
      body: string,
    ): { status: string; stopReason: string | null } | null {
      const match = body.match(STATE_EXTRACT_RE);
      if (!match) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      const status = obj.status;
      if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        return null;
      }
      // stopReason は文字列 or null（null はそのまま保持・変換しない、§5.4）
      const rawReason = obj.stopReason;
      const stopReason = typeof rawReason === "string" ? rawReason : null;
      return { status, stopReason };
    }
  }
  ```

- [ ] **Step 8: テストを実行して poll の全分岐がグリーンになったことを確認する（green 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: Step 7 で追加した poll ケースを含め全 `passed`、`failed 0`（`checkMergeReadiness` のテストはまだ未追加）。

- [ ] **Step 9: `checkMergeReadiness` の6分岐を網羅する失敗テストを追加する（red）。** `tests/monitor.test.ts` の末尾（最後の `describe` の閉じ `});` の後、ファイル終端）に、以下の `describe` を追加する。この時点で `checkMergeReadiness` は Step 3/7b で throw のまま据え置かれているので、これらは**失敗する**ことを期待する（次の Step 9b で実装を加えて green にする）。

  ```typescript
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
  });
  ```

- [ ] **Step 9a: テストを実行して readiness 6分岐の失敗を確認する（red 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: poll 系の全ケースは `passed` のまま、Step 9 で追加した `checkMergeReadiness` の各 it（①-⑥）が `failed`。失敗理由は実装側の未実装（`checkMergeReadiness not implemented yet` を throw）であること。

- [ ] **Step 9b: `checkMergeReadiness` の ①-⑥ を実装する（green）。** `/home/racoma-dev/loop-pilot-os/src/monitor.ts` を編集する。(1) 冒頭の定数群（`VALID_STATUSES` の `]);` の直後）に GREEN_CONCLUSIONS を追加、(2) `checkMergeReadiness` メソッド全体を ①-⑥ の決定順実装へ置換し、未使用だった引数 `_prNumber` を `prNumber` に戻して消費する。

  まず定数を追加する（`VALID_STATUSES` の `]);` の直後に挿入）:

  ```typescript
  /** checkMergeReadiness ② の「失敗でない」conclusion 集合（§5.3） */
  const GREEN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  ```

  次に `checkMergeReadiness` メソッド全体を以下へ置換する:

  ```typescript
    async checkMergeReadiness(prNumber: number): Promise<MergeReadiness> {
      const pr = await this.fetchPrView(prNumber);
      const checks = pr.statusCheckRollup;

      // ① コンフリクト
      if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        return { ready: false, reason: "conflict" };
      }
      // ② 失敗チェックあり（completed かつ conclusion ∉ {SUCCESS,NEUTRAL,SKIPPED}）
      const hasFailed = checks.some(
        (c) =>
          c.status === "COMPLETED" && !GREEN_CONCLUSIONS.has(c.conclusion ?? ""),
      );
      if (hasFailed) {
        return { ready: false, reason: "ci_failed" };
      }
      // ③ 未完了チェックあり
      const hasPending = checks.some((c) => c.status !== "COMPLETED");
      if (hasPending) {
        return { ready: false, reason: "ci_pending" };
      }
      // ④ 全グリーン（空配列含む）かつ BLOCKED
      if (pr.mergeStateStatus === "BLOCKED") {
        return { ready: false, reason: "blocked" };
      }
      // ⑤ MERGEABLE
      if (pr.mergeable === "MERGEABLE") {
        return { ready: true, headSha: pr.headRefOid };
      }
      // ⑥ それ以外
      return { ready: false, reason: "unknown" };
    }
  ```

- [ ] **Step 10: テストを実行して readiness 6分岐がグリーンになったことを確認する（green 確認）。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: 全ケース `passed`、`failed 0`。

- [ ] **Step 11: `gh` 呼び出し形が契約どおりであることを検証するテストを追加する（red→green は同一サイクル: 実装は既に Step 7b で確定済みのため green になる）。** `tests/monitor.test.ts` の末尾（最後の `describe` の閉じ `});` の後）に、以下の `describe` を追加する。`gh pr view` の `--json` フィールド列・`-R <remote>` と、`gh api ... comments --paginate --slurp` の引数が §5.3 と一字一句一致することを固定する。

  ```typescript
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
  ```

- [ ] **Step 12: テストを実行して呼び出し形テストがグリーンであることを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/monitor.test.ts`。期待: 全ケース `passed`、`failed 0`。

- [ ] **Step 13: `npm run check` で型 + 全テストの最終グリーンを確認する。** コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`。期待: tsc（src）+ tsc（test）+ vitest すべて成功（exit 0）。

- [ ] **Step 14: green の単位をコミットする。** コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/monitor.ts tests/monitor.test.ts && git commit -m "test: cover GhLoopPilotMonitor verdict precedence, comment identification, readiness branches, and gh call shapes"`。
