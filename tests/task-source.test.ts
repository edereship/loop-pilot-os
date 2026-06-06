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
    });
    expect(calls[0].headers.Authorization).toBe("lin_api_test");
  });

  // opt-in ラベルが team スコープに無くワークスペースラベルとしてのみ存在する場合でも
  // 解決できる（カーネル §5.5: `team.labels`+workspace labels の和集合）。
  it("resolves the opt-in label from workspace-level labels when absent on the team", async () => {
    const { fetchFn } = makeFetch([
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
      { body: fixture("linear-resolve-setup.json") },
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
