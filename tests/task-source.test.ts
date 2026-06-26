import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LinearTaskSource,
  resolveLinearSetup,
  type FetchFn,
} from "../src/task-source.js";
import type { TicketState } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

/**
 * フェイク fetchFn。responses を順に返す（HTTP 200/ok=true 既定）。
 * calls に request の body を記録する。各 response は { status?, ok?, body } で
 * HTTP レイヤの失敗も注入できる。
 */
function makeFetch(
  responses: Array<{ status?: number; ok?: boolean; body: unknown }>,
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    const parsed = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({
      url,
      headers: init.headers,
      query: parsed.query,
      variables: parsed.variables,
    });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  };
  return { fetchFn, calls };
}

const STATE_IDS: Record<TicketState, string> = {
  todo: "state-todo",
  in_progress: "state-wip",
  in_review: "state-review",
  done: "state-done",
};

function makeSource(fetchFn: FetchFn): LinearTaskSource {
  return new LinearTaskSource({
    apiKey: "lin_api_test",
    projectId: "project-uuid-1",
    stateIds: STATE_IDS,
    optInLabel: "ai-ok",
    fetchFn,
  });
}

describe("LinearTaskSource.getNextEligible", () => {
  // 仕様 §5 SELECT 決定的順序: ①意味的優先度 Urgent>High>Medium>Low>No priority
  // ②sortOrder 昇順 ③id 昇順。先頭(=Urgent)を返す。
  it("returns the urgent issue first regardless of fetch order", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([]);
    expect(result?.id).toBe("i-urgent");
    expect(result?.identifier).toBe("TY-1");
    // 適格クエリは projectId / todoStateId / label を variables で渡す（カーネル §5.5）
    expect(calls[0].variables).toEqual({
      projectId: "project-uuid-1",
      todoStateId: "state-todo",
      label: "ai-ok",
    });
    expect(calls[0].headers.Authorization).toBe("lin_api_test");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].url).toBe("https://api.linear.app/graphql");
  });

  // priority の意味写像: No priority(0) は最後、Low(4) より後ろに来る。
  // 同優先度は sortOrder、同 sortOrder は id で決まる。
  it("orders by mapped priority then sortOrder then id (None is last)", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-priority.json") },
    ]);
    // 先頭は High かつ sortOrder=7 同値 → id 昇順で "i-a" が先（"i-a" < "i-b"）。
    const first = await makeSource(fetchFn).getNextEligible([]);
    expect(first?.id).toBe("i-a");
  });

  // excludeIds（Store 由来の進行中 issue id）を除外して次点を返す。
  it("skips excluded ids and returns the next deterministic issue", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    // Urgent(i-urgent) を除外 → 次は High(i-high)。
    const result = await makeSource(fetchFn).getNextEligible(["i-urgent"]);
    expect(result?.id).toBe("i-high");
  });

  // 適格なし → null（仕様 §5: 適格なし → IDLE）。
  it("returns null when no eligible issues remain", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-empty.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([]);
    expect(result).toBeNull();
  });

  // 全件が excludeIds に含まれるなら null。
  it("returns null when every eligible issue is excluded", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getNextEligible([
      "i-urgent",
      "i-high",
      "i-medium",
      "i-low",
      "i-none",
    ]);
    expect(result).toBeNull();
  });

  // GraphQL errors は throw（HTTP 200 でも errors があれば失敗扱い）。
  it("throws when the GraphQL response carries errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(makeSource(fetchFn).getNextEligible([])).rejects.toThrow(
      /Linear GraphQL error/i,
    );
  });

  // HTTP 非2xx は throw。
  it("throws on a non-2xx HTTP response", async () => {
    const { fetchFn } = makeFetch([
      { ok: false, status: 500, body: {} },
    ]);
    await expect(makeSource(fetchFn).getNextEligible([])).rejects.toThrow(
      /Linear HTTP 500/i,
    );
  });

  // 実API挙動: description が null のチケットは空文字に正規化される（EligibleIssue.description は非null）
  it("normalizes a null description to an empty string", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-null-description.json") },
    ]);
    const issue = await makeSource(fetchFn).getNextEligible([]);
    expect(issue?.id).toBe("i-nulldesc");
    expect(issue?.description).toBe("");
  });
});

describe("LinearTaskSource.transition", () => {
  // 遷移は issueUpdate mutation（カーネル §5.5）。stateId を引く。
  it("calls issueUpdate with the mapped stateId", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-issue-update-success.json") },
    ]);
    await makeSource(fetchFn).transition("i-urgent", "in_progress");
    expect(calls[0].query).toContain("issueUpdate");
    expect(calls[0].variables).toEqual({
      id: "i-urgent",
      stateId: "state-wip",
    });
  });

  // success==false は throw。
  it("throws when issueUpdate returns success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-issue-update-fail.json") },
    ]);
    await expect(
      makeSource(fetchFn).transition("i-urgent", "done"),
    ).rejects.toThrow(/issueUpdate failed/i);
  });

  // GraphQL errors も throw。
  it("throws when issueUpdate response carries GraphQL errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(
      makeSource(fetchFn).transition("i-urgent", "todo"),
    ).rejects.toThrow(/Linear GraphQL error/i);
  });
});

describe("LinearTaskSource.findOrphanedInProgress", () => {
  // in_progress stateId でクエリし knownIssueIds 外を返す（CLAIM 途中クラッシュ孤児）。
  it("returns in-progress issues not in knownIssueIds", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-orphans.json") },
    ]);
    const orphans = await makeSource(fetchFn).findOrphanedInProgress([
      "i-known",
    ]);
    expect(orphans.map((o) => o.id)).toEqual(["i-orphan"]);
    expect(orphans[0].identifier).toBe("TY-101");
    // in_progress stateId でフィルタしている。
    expect(calls[0].variables).toEqual({
      projectId: "project-uuid-1",
      todoStateId: "state-wip",
      label: "ai-ok",
    });
  });

  // 全て既知なら空配列。
  it("returns an empty array when all in-progress issues are known", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-orphans.json") },
    ]);
    const orphans = await makeSource(fetchFn).findOrphanedInProgress([
      "i-known",
      "i-orphan",
    ]);
    expect(orphans).toEqual([]);
  });
});

describe("resolveLinearSetup", () => {
  // viewer 検証 + team/project/4状態/ラベルの ID 解決（カーネル §5.5 プリフライト解決）。
  it("resolves all ids when team/project/states/label exist", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-setup-viewer.json") },
      { body: fixture("linear-resolve-setup.json") },
    ]);
    const resolved = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    );
    expect(resolved).toEqual({
      viewerId: "user-1",
      teamId: "team-uuid-1",
      projectId: "project-uuid-1",
      stateIds: {
        todo: "state-todo",
        in_progress: "state-wip",
        in_review: "state-review",
        done: "state-done",
      },
      optInLabelId: "label-aiok",
      labelMap: new Map([["bug", "label-bug"], ["ai-ok", "label-aiok"]]),
      knownLabels: ["ai-ok", "bug"],
    });
    expect(calls[0].headers.Authorization).toBe("lin_api_test");
  });

  // 同名 project が他チームにも存在する場合、指定 team 配下の project に解決する
  // （仕様 §5.1「指定Team/PJ」。ワークスペース横断の名前解決は誤った project に解決し得る）。
  // fixture はワークスペース横断リスト（他チームの project が先頭）も含み、
  // team.projects が優先されることを固定する。
  it("resolves the project from the requested team when another team has a same-named project", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-setup-viewer.json") },
      { body: fixture("linear-resolve-setup-duplicate-project.json") },
    ]);
    const resolved = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    );
    expect(resolved.projectId).toBe("project-uuid-ty");
  });

  // opt-in ラベルが team スコープに無くワークスペースラベルとしてのみ存在する場合でも
  // 解決できる（カーネル §5.5: `team.labels`+workspace labels の和集合）。
  it("resolves the opt-in label from workspace-level labels when absent on the team", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-setup-viewer.json") },
      { body: fixture("linear-resolve-setup-workspace-label.json") },
    ]);
    const resolved = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    );
    expect(resolved.optInLabelId).toBe("label-aiok-ws");
  });

  // 不在要素は名前を列挙して 1 回でまとめて throw。
  it("throws listing every missing element", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-setup-viewer.json") },
      { body: fixture("linear-resolve-setup-missing.json") },
    ]);
    const err = await resolveLinearSetup(
      "lin_api_test",
      {
        teamKey: "TY",
        projectName: "LoopPilot OS",
        stateNames: {
          todo: "Todo",
          in_progress: "In Progress",
          in_review: "In Review",
          done: "Done",
        },
        optInLabel: "ai-ok",
      },
      fetchFn,
    ).then(
      (): Error => {
        // 不在エラーを期待するパスで成功してしまった場合は明示的に失敗させる。
        throw new Error("resolveLinearSetup unexpectedly succeeded");
      },
      (e: unknown): Error => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    // project "LoopPilot OS" 不在 / state "Done" 不在 / label "ai-ok" 不在 を全て含む。
    expect(err.message).toContain("LoopPilot OS");
    expect(err.message).toContain("Done");
    expect(err.message).toContain("ai-ok");
  });

  // team key が無ければ team 名で throw（後続の解決に進まない）。
  it("throws when the team key is not found", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-setup-viewer.json") },
    ]);
    await expect(
      resolveLinearSetup(
        "lin_api_test",
        {
          teamKey: "NOPE",
          projectName: "LoopPilot OS",
          stateNames: {
            todo: "Todo",
            in_progress: "In Progress",
            in_review: "In Review",
            done: "Done",
          },
          optInLabel: "ai-ok",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/NOPE/);
  });

  it("throws when team label pagination exceeds MAX_PAGES", async () => {
    const viewerData = {
      data: {
        viewer: { id: "user-1", name: "Bot" },
        teams: { nodes: [{ id: "team-uuid-1", key: "TY" }] },
      },
    };
    const teamData = {
      data: {
        team: {
          id: "team-uuid-1", key: "TY",
          states: { nodes: [
            { id: "state-todo", name: "Todo" },
            { id: "state-wip", name: "In Progress" },
            { id: "state-review", name: "In Review" },
            { id: "state-done", name: "Done" },
          ] },
          labels: { nodes: [{ id: "l-1", name: "ai-ok" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
          projects: { nodes: [{ id: "project-uuid-1", name: "LoopPilot OS" }] },
        },
        issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
    const infiniteLabelPage = {
      body: { data: { team: { labels: { nodes: [{ id: "l-x", name: "x" }], pageInfo: { hasNextPage: true, endCursor: "stuck" } } } } },
    };
    const { fetchFn } = makeFetch([
      { body: viewerData },
      { body: teamData },
      ...Array(51).fill(infiniteLabelPage),
    ]);
    await expect(
      resolveLinearSetup("key", { teamKey: "TY", projectName: "LoopPilot OS", stateNames: { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" }, optInLabel: "ai-ok" }, fetchFn),
    ).rejects.toThrow(/exceeded 50 pages.*possible infinite pagination/);
  });

  it("throws when workspace label pagination exceeds MAX_PAGES", async () => {
    const viewerData = {
      data: {
        viewer: { id: "user-1", name: "Bot" },
        teams: { nodes: [{ id: "team-uuid-1", key: "TY" }] },
      },
    };
    const teamData = {
      data: {
        team: {
          id: "team-uuid-1", key: "TY",
          states: { nodes: [
            { id: "state-todo", name: "Todo" },
            { id: "state-wip", name: "In Progress" },
            { id: "state-review", name: "In Review" },
            { id: "state-done", name: "Done" },
          ] },
          labels: { nodes: [{ id: "l-1", name: "ai-ok" }], pageInfo: { hasNextPage: false, endCursor: null } },
          projects: { nodes: [{ id: "project-uuid-1", name: "LoopPilot OS" }] },
        },
        issueLabels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      },
    };
    const infiniteLabelPage = {
      body: { data: { issueLabels: { nodes: [{ id: "l-x", name: "x" }], pageInfo: { hasNextPage: true, endCursor: "stuck" } } } },
    };
    const { fetchFn } = makeFetch([
      { body: viewerData },
      { body: teamData },
      ...Array(51).fill(infiniteLabelPage),
    ]);
    await expect(
      resolveLinearSetup("key", { teamKey: "TY", projectName: "LoopPilot OS", stateNames: { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done" }, optInLabel: "ai-ok" }, fetchFn),
    ).rejects.toThrow(/exceeded 50 pages.*possible infinite pagination/);
  });

  // GraphQL errors は throw。
  it("throws when the setup query returns GraphQL errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(
      resolveLinearSetup(
        "lin_api_test",
        {
          teamKey: "TY",
          projectName: "LoopPilot OS",
          stateNames: {
            todo: "Todo",
            in_progress: "In Progress",
            in_review: "In Review",
            done: "Done",
          },
          optInLabel: "ai-ok",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/Linear GraphQL error/i);
  });
});

describe("LinearTaskSource.postComment", () => {
  it("calls commentCreate mutation with issueId and body", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-comment-create-success.json") },
    ]);
    await makeSource(fetchFn).postComment("i-urgent", "## Goal\nDo the thing.");
    expect(calls[0].query).toContain("commentCreate");
    expect(calls[0].variables).toEqual({
      issueId: "i-urgent",
      body: "## Goal\nDo the thing.",
    });
  });

  it("throws when commentCreate returns success=false", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-comment-create-fail.json") },
    ]);
    await expect(
      makeSource(fetchFn).postComment("i-urgent", "brief"),
    ).rejects.toThrow(/commentCreate failed/i);
  });

  it("throws when commentCreate response carries GraphQL errors", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-errors.json") },
    ]);
    await expect(
      makeSource(fetchFn).postComment("i-urgent", "brief"),
    ).rejects.toThrow(/Linear GraphQL error/i);
  });
});

describe("LinearTaskSource.getAllEligible", () => {
  // getAllEligible は全適格チケットを決定的順序（①意味的優先度 ②sortOrder ③id）で返す。
  // linear-eligible.json は Medium/Urgent/None/Low/High の順で格納。
  it("returns all eligible issues sorted by priority→sortOrder→id, excluding excludeIds", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    // "b" は i-high に対応しないが、実際の id で excludeIds を渡す。
    // i-high (priority=2, sortOrder=50) を除外して残りの 4 件が返ることを確認する。
    const result = await makeSource(fetchFn).getAllEligible(["i-high"]);
    expect(result).toHaveLength(4);
    // 先頭は Urgent (priority=1)。
    expect(result[0].id).toBe("i-urgent");
    expect(result[0].identifier).toBe("TY-1");
    // 2番目は Medium (priority=3)。i-high は除外済み。
    expect(result[1].id).toBe("i-medium");
    expect(result[1].identifier).toBe("TY-3");
    // 末尾は No priority (priority=0 → rank=4)。
    expect(result[3].id).toBe("i-none");
  });

  it("returns all issues when excludeIds is empty", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getAllEligible([]);
    // linear-eligible.json には 5 件
    expect(result).toHaveLength(5);
    // 先頭は Urgent、末尾は No priority
    expect(result[0].id).toBe("i-urgent");
    expect(result[4].id).toBe("i-none");
  });

  it("returns empty array when no eligible tickets exist", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible-empty.json") },
    ]);
    const result = await makeSource(fetchFn).getAllEligible([]);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when every eligible issue is excluded", async () => {
    const { fetchFn } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    const result = await makeSource(fetchFn).getAllEligible([
      "i-urgent", "i-high", "i-medium", "i-low", "i-none",
    ]);
    expect(result).toHaveLength(0);
  });

  it("throws when pagination exceeds MAX_PAGES (infinite pagination guard)", async () => {
    const infinitePage = {
      body: {
        data: {
          issues: {
            nodes: [{ id: "i-1", identifier: "TY-1", title: "t", description: "", priority: 3, sortOrder: 1, url: "u" }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-stuck" },
          },
        },
      },
    };
    const { fetchFn } = makeFetch(Array(51).fill(infinitePage));
    await expect(makeSource(fetchFn).getAllEligible([])).rejects.toThrow(
      /exceeded 50 pages.*possible infinite pagination/,
    );
  });

  // getAllEligible は getNextEligible と同じクエリ引数（projectId/todoStateId/label）を使う。
  it("sends correct query variables for the todo state", async () => {
    const { fetchFn, calls } = makeFetch([
      { body: fixture("linear-eligible.json") },
    ]);
    await makeSource(fetchFn).getAllEligible([]);
    expect(calls[0].variables).toEqual({
      projectId: "project-uuid-1",
      todoStateId: "state-todo",
      label: "ai-ok",
      after: null,
    });
  });
});
