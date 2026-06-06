### Task 7: TaskSource（Linear GraphQL）

**目的**: Linear GraphQL を `fetch` POST で叩く `LinearTaskSource`（カーネル §2 `TaskSource` 実装）と、プリフライト/main が使う `resolveLinearSetup`（team/project/4状態/ラベルの ID 解決）を実装する。SELECT の決定的順序（優先度の意味写像 → sortOrder → id）・除外・遷移・孤児検出を、フェイク `fetchFn` と fixture JSON で検証する。仕様 §5 SELECT / §6（検知の前段の冪等性）/ カーネル §5.5（GraphQL 契約）。

**依存タスク**: Task 2（`src/types.ts`: `TaskSource`, `EligibleIssue`, `TicketState`）。Task 3/4/5 には依存しない（このタスクは純粋に `fetchFn` 注入で完結する）。`better-sqlite3` 等の I/O は使わない。

**前提**:
- HTTP は Node 24 ネイティブ `fetch`。テストでは `fetchFn` を DI して実ネットワークを使わない。
- 注入する `fetchFn` の型は Web 標準 `fetch` のサブセット: `(url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>`。`src/task-source.ts` 内に `FetchFn` 型として定義し export する（Task 15/16 の本番配線が `globalThis.fetch` を渡せるように）。
- Linear API は GraphQL を 200 で返し、エラーは本文 `{ errors: [...] }` に入る（HTTP ステータスは 200 のことがある）。よって「`!ok`（HTTP 非2xx）」と「`body.errors` 非空」の両方を失敗として扱う。
- GraphQL クエリ・mutation 文字列はカーネル §5.5 と**一字一句一致**させる。

---

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/task-source.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/task-source.test.ts`
- Create (fixtures): `/home/racoma-dev/loop-pilot-os/tests/fixtures/linear-eligible.json`, `linear-eligible-priority.json`, `linear-eligible-empty.json`, `linear-errors.json`, `linear-orphans.json`, `linear-issue-update-success.json`, `linear-issue-update-fail.json`, `linear-resolve-setup.json`, `linear-resolve-setup-workspace-label.json`, `linear-resolve-setup-missing.json`

---

- [ ] **Step 1: fixture — 適格チケット（基本）を作成する**

  `tests/fixtures/linear-eligible.json` を作成（決定的順序の検証用。`priority` と `sortOrder` と `id` をわざと「ソート前の生順」に並べる。期待結果: 優先度写像 1→0(U), 2→1(H), 3→2(M), 4→3(L), 0→4(None) → sortOrder昇順 → id昇順）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-medium", "identifier": "TY-3", "title": "Medium task", "description": "m", "priority": 3, "sortOrder": 10, "url": "https://linear.app/ty/issue/TY-3" },
        { "id": "i-urgent", "identifier": "TY-1", "title": "Urgent task", "description": "u", "priority": 1, "sortOrder": 99, "url": "https://linear.app/ty/issue/TY-1" },
        { "id": "i-none", "identifier": "TY-5", "title": "No priority task", "description": "", "priority": 0, "sortOrder": 1, "url": "https://linear.app/ty/issue/TY-5" },
        { "id": "i-low", "identifier": "TY-4", "title": "Low task", "description": "l", "priority": 4, "sortOrder": 5, "url": "https://linear.app/ty/issue/TY-4" },
        { "id": "i-high", "identifier": "TY-2", "title": "High task", "description": "h", "priority": 2, "sortOrder": 50, "url": "https://linear.app/ty/issue/TY-2" }
      ]
    }
  }
}
```

- [ ] **Step 2: fixture — 同値タイブレーク（sortOrder 同値・優先度逆転）を作成する**

  `tests/fixtures/linear-eligible-priority.json` を作成（優先度が同じものは sortOrder で、sortOrder も同じなら id で決まることを示す。意味写像の検証として `priority:0`（None）が `priority:4`（Low）より後ろに来ることを含める）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-b", "identifier": "TY-20", "title": "High b", "description": "", "priority": 2, "sortOrder": 7, "url": "https://linear.app/ty/issue/TY-20" },
        { "id": "i-a", "identifier": "TY-21", "title": "High a", "description": "", "priority": 2, "sortOrder": 7, "url": "https://linear.app/ty/issue/TY-21" },
        { "id": "i-none1", "identifier": "TY-22", "title": "None", "description": "", "priority": 0, "sortOrder": 1, "url": "https://linear.app/ty/issue/TY-22" },
        { "id": "i-low1", "identifier": "TY-23", "title": "Low", "description": "", "priority": 4, "sortOrder": 999, "url": "https://linear.app/ty/issue/TY-23" }
      ]
    }
  }
}
```

- [ ] **Step 3: fixture — 空キュー / GraphQL エラー / 遷移 success・fail を作成する**

  4 ファイルを作成。

  `tests/fixtures/linear-eligible-empty.json`:

```json
{ "data": { "issues": { "nodes": [] } } }
```

  `tests/fixtures/linear-errors.json`（Linear の GraphQL エラー形。HTTP 200 でも `errors` が入る）:

```json
{
  "errors": [
    { "message": "Authentication required, not authenticated", "extensions": { "type": "authentication" } }
  ]
}
```

  `tests/fixtures/linear-issue-update-success.json`:

```json
{ "data": { "issueUpdate": { "success": true } } }
```

  `tests/fixtures/linear-issue-update-fail.json`:

```json
{ "data": { "issueUpdate": { "success": false } } }
```

- [ ] **Step 4: fixture — 孤児検出（In Progress）を作成する**

  `tests/fixtures/linear-orphans.json`（in_progress stateId で取得した issues。`knownIssueIds` 外のものが孤児）:

```json
{
  "data": {
    "issues": {
      "nodes": [
        { "id": "i-known", "identifier": "TY-100", "title": "Tracked WIP", "description": "", "priority": 2, "sortOrder": 3, "url": "https://linear.app/ty/issue/TY-100" },
        { "id": "i-orphan", "identifier": "TY-101", "title": "Orphan WIP", "description": "", "priority": 1, "sortOrder": 4, "url": "https://linear.app/ty/issue/TY-101" }
      ]
    }
  }
}
```

- [ ] **Step 5: fixture — resolveLinearSetup の解決成功 / 不在を作成する**

  `tests/fixtures/linear-resolve-setup.json`（viewer + teams(states) + projects + labels をまとめて返す 1 レスポンス）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" },
            { "id": "state-done", "name": "Done" }
          ] },
          "labels": { "nodes": [
            { "id": "label-aiok", "name": "ai-ok" }
          ] }
        },
        {
          "id": "team-uuid-2",
          "key": "OTHER",
          "states": { "nodes": [] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-1", "name": "LoopPilot OS" },
        { "id": "project-uuid-2", "name": "Other Project" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-bug", "name": "bug" }
    ] }
  }
}
```

  `tests/fixtures/linear-resolve-setup-workspace-label.json`（opt-in ラベルが team スコープには無く、ワークスペースラベルとしてのみ存在する。`team.labels`+workspace labels の和集合解決を固定する。team ラベルは空、`issueLabels` に `ai-ok` がある）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" },
            { "id": "state-done", "name": "Done" }
          ] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-1", "name": "LoopPilot OS" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-aiok-ws", "name": "ai-ok" }
    ] }
  }
}
```

  `tests/fixtures/linear-resolve-setup-missing.json`（team は在るが project / 状態 "Done" / ラベルが欠ける。複数欠落を 1 回でまとめて報告する検証用。`team.labels` も workspace `issueLabels` も `ai-ok` を含まない）:

```json
{
  "data": {
    "viewer": { "id": "user-1", "name": "LoopPilot Bot" },
    "teams": {
      "nodes": [
        {
          "id": "team-uuid-1",
          "key": "TY",
          "states": { "nodes": [
            { "id": "state-todo", "name": "Todo" },
            { "id": "state-wip", "name": "In Progress" },
            { "id": "state-review", "name": "In Review" }
          ] },
          "labels": { "nodes": [] }
        }
      ]
    },
    "projects": {
      "nodes": [
        { "id": "project-uuid-2", "name": "Other Project" }
      ]
    },
    "issueLabels": { "nodes": [
      { "id": "label-bug", "name": "bug" }
    ] }
  }
}
```

- [ ] **Step 6: 失敗するテストを書く（task-source.test.ts 全体）**

  `tests/task-source.test.ts` を作成。`makeFetch` ヘルパで「呼ばれた body に応じて fixture を返す or 連続キューで返す」フェイク `fetchFn` を組む。実装は未作成なので import が解決できず全テストが失敗する。

```typescript
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
    ).catch((e: unknown) => e as Error);
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
```

- [ ] **Step 7: テストを実行して失敗を確認する**

  ```
  npx vitest run tests/task-source.test.ts
  ```

  期待される失敗: `Failed to resolve import "../src/task-source.js"`（モジュール未作成）。全 `describe` ブロックがロード時エラーで collect 失敗する。

- [ ] **Step 8: `src/task-source.ts` を実装する（最小・完全形）**

  `src/task-source.ts` を作成。GraphQL 文字列はカーネル §5.5 と一字一句一致。`EligibleIssue` / `TicketState` / `TaskSource` は Task 2 の `src/types.ts` から import。

```typescript
import type { EligibleIssue, TaskSource, TicketState } from "./types.js";

/** Web 標準 fetch のサブセット。本番は globalThis.fetch、テストはフェイクを注入する。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// カーネル §5.5: 適格チケット取得（1クエリ、client-side で決定的順序）。一字一句一致。
const ELIGIBLE_QUERY = `query Eligible($projectId: ID, $todoStateId: ID!, $label: String!) {
  issues(first: 50, filter: {
    project: { id: { eq: $projectId } },
    state: { id: { eq: $todoStateId } },
    labels: { name: { eq: $label } }
  }) { nodes { id identifier title description priority sortOrder url } }
}`;

// カーネル §5.5: 遷移 mutation。一字一句一致。
const TRANSITION_MUTATION = `mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

// カーネル §5.5 プリフライト解決: viewer 検証 + team/project/states/labels。
// ラベルは team.labels + ワークスペース全体の issueLabels の和集合で解決する
// （opt_in_label がワークスペースラベルとして定義されているケースに対応）。
const SETUP_QUERY = `query Setup {
  viewer { id name }
  teams { nodes { id key states { nodes { id name } } labels { nodes { id name } } } }
  projects { nodes { id name } }
  issueLabels { nodes { id name } }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  sortOrder: number;
  url: string;
}

interface IssuesData {
  issues: { nodes: IssueNode[] };
}

/** 優先度の意味写像（カーネル §5.5 / 仕様 §5）: 1→0, 2→1, 3→2, 4→3, 0→4。 */
function priorityRank(priority: number): number {
  switch (priority) {
    case 1:
      return 0; // Urgent
    case 2:
      return 1; // High
    case 3:
      return 2; // Medium
    case 4:
      return 3; // Low
    default:
      return 4; // No priority (0)
  }
}

/** ①意味的優先度 ②sortOrder 昇順 ③id 昇順 の決定的比較。 */
function compareIssues(a: IssueNode, b: IssueNode): number {
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function toEligible(node: IssueNode): EligibleIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    priority: node.priority,
    sortOrder: node.sortOrder,
    url: node.url,
  };
}

async function graphql<T>(
  fetchFn: FetchFn,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear HTTP ${res.status}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear GraphQL error: ${msg}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL error: response had no data");
  }
  return body.data;
}

export interface LinearTaskSourceOptions {
  apiKey: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabel: string;
  fetchFn: FetchFn;
}

export class LinearTaskSource implements TaskSource {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly stateIds: Record<TicketState, string>;
  private readonly optInLabel: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: LinearTaskSourceOptions) {
    this.apiKey = opts.apiKey;
    this.projectId = opts.projectId;
    this.stateIds = opts.stateIds;
    this.optInLabel = opts.optInLabel;
    this.fetchFn = opts.fetchFn;
  }

  private async queryByState(stateId: string): Promise<IssueNode[]> {
    const data = await graphql<IssuesData>(
      this.fetchFn,
      this.apiKey,
      ELIGIBLE_QUERY,
      {
        projectId: this.projectId,
        todoStateId: stateId,
        label: this.optInLabel,
      },
    );
    return data.issues.nodes;
  }

  async getNextEligible(excludeIds: string[]): Promise<EligibleIssue | null> {
    const exclude = new Set(excludeIds);
    const nodes = (await this.queryByState(this.stateIds.todo))
      .filter((n) => !exclude.has(n.id))
      .sort(compareIssues);
    const first = nodes[0];
    return first ? toEligible(first) : null;
  }

  async transition(issueId: string, state: TicketState): Promise<void> {
    const data = await graphql<{ issueUpdate: { success: boolean } }>(
      this.fetchFn,
      this.apiKey,
      TRANSITION_MUTATION,
      { id: issueId, stateId: this.stateIds[state] },
    );
    if (!data.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate failed for ${issueId} -> ${state}`,
      );
    }
  }

  async findOrphanedInProgress(
    knownIssueIds: string[],
  ): Promise<EligibleIssue[]> {
    const known = new Set(knownIssueIds);
    const nodes = await this.queryByState(this.stateIds.in_progress);
    return nodes.filter((n) => !known.has(n.id)).map(toEligible);
  }
}

// ---- プリフライト/main 用のセットアップ解決 ----

interface SetupData {
  viewer: { id: string; name: string };
  teams: {
    nodes: Array<{
      id: string;
      key: string;
      states: { nodes: Array<{ id: string; name: string }> };
      labels: { nodes: Array<{ id: string; name: string }> };
    }>;
  };
  projects: { nodes: Array<{ id: string; name: string }> };
  // ワークスペース全体のラベル（team スコープに無いラベルの解決に使う）。
  issueLabels: { nodes: Array<{ id: string; name: string }> };
}

export interface LinearSetupRequest {
  teamKey: string;
  projectName: string;
  stateNames: Record<TicketState, string>;
  optInLabel: string;
}

export interface ResolvedLinearSetup {
  viewerId: string;
  teamId: string;
  projectId: string;
  stateIds: Record<TicketState, string>;
  optInLabelId: string;
}

const TICKET_STATES: TicketState[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

/**
 * viewer を検証し、team key / project 名 / 4状態名 / opt-in ラベル名を ID に解決する。
 * 見つからない要素は名前を列挙して 1 回でまとめて throw（プリフライトの fail-fast 用）。
 */
export async function resolveLinearSetup(
  apiKey: string,
  req: LinearSetupRequest,
  fetchFn: FetchFn,
): Promise<ResolvedLinearSetup> {
  const data = await graphql<SetupData>(fetchFn, apiKey, SETUP_QUERY, {});

  const team = data.teams.nodes.find((t) => t.key === req.teamKey);
  if (!team) {
    throw new Error(`Linear team not found: key "${req.teamKey}"`);
  }

  const missing: string[] = [];

  const project = data.projects.nodes.find(
    (p) => p.name === req.projectName,
  );
  if (!project) {
    missing.push(`project "${req.projectName}"`);
  }

  const stateIds = {} as Record<TicketState, string>;
  for (const state of TICKET_STATES) {
    const wantedName = req.stateNames[state];
    const found = team.states.nodes.find((s) => s.name === wantedName);
    if (found) {
      stateIds[state] = found.id;
    } else {
      missing.push(`state "${wantedName}"`);
    }
  }

  // ラベルは team スコープ + ワークスペーススコープの和集合から解決する
  // （カーネル §5.5: `team.labels`+workspace labels）。team ラベルを優先。
  const label =
    team.labels.nodes.find((l) => l.name === req.optInLabel) ??
    data.issueLabels.nodes.find((l) => l.name === req.optInLabel);
  if (!label) {
    missing.push(`label "${req.optInLabel}"`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Linear setup resolution failed; not found: ${missing.join(", ")}`,
    );
  }

  return {
    viewerId: data.viewer.id,
    teamId: team.id,
    // project と label は missing.length===0 の時点で必ず解決済み。
    projectId: project!.id,
    stateIds,
    optInLabelId: label!.id,
  };
}
```

- [ ] **Step 9: テストを実行して成功を確認する**

  ```
  npx vitest run tests/task-source.test.ts
  ```

  期待: 全テストパス（`getNextEligible` 7件・`transition` 3件・`findOrphanedInProgress` 2件・`resolveLinearSetup` 5件 = 17 passed）。

- [ ] **Step 10: 型チェックを通す**

  ```
  npm run check
  ```

  期待: `tsc -p tsconfig.json`（src）と `tsc -p tsconfig.test.json`（tests 含む）と vitest が全てグリーン。`project!`/`label!` の non-null は `missing.length===0` 保証下でのみ使用しており strict 下でも型エラーなし。

- [ ] **Step 11: red→green をコミットする**

  ```
  git add src/task-source.ts tests/task-source.test.ts tests/fixtures/linear-eligible.json tests/fixtures/linear-eligible-priority.json tests/fixtures/linear-eligible-empty.json tests/fixtures/linear-errors.json tests/fixtures/linear-orphans.json tests/fixtures/linear-issue-update-success.json tests/fixtures/linear-issue-update-fail.json tests/fixtures/linear-resolve-setup.json tests/fixtures/linear-resolve-setup-workspace-label.json tests/fixtures/linear-resolve-setup-missing.json
  git commit -m "feat: LinearTaskSource + resolveLinearSetup (Linear GraphQL via fetch)"
  ```
