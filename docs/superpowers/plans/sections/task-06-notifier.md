### Task 6: Notifier（console + Slack + intent永続化）

**目的**: 人間の出番（HALT / IDLE / 起動）だけを通知する `ConsoleSlackNotifier` を実装する。通知の意図を先に Store へ記録し（`notification_intent`）、コンソールへは必ず整形出力（必達）、Slack Webhook が設定済みなら `{text}` を指数バックオフ付き 3 回までリトライして POST する。Slack 失敗はコンソールの成功を妨げず throw もしない（`bumpAttempts` のみ）。さらにプリフライト専用 `probeReachability()`（カーネル §9 step10）を提供する。仕様 §10（可観測性・通知）/ §4（Notifier）/ §6（コンソールは必ず成功）。

**依存タスク**: Task 2（`src/types.ts` の `Notifier` / `NotifyEvent` 型）、Task 5（`src/store.ts` の `SqliteStore` と `notification_intent` テーブル／`recordIntent`・`markDelivered`・`bumpAttempts`）。Task 3 の `fixedClock` / `instantSleep`（`tests/fakes.ts`）はこのタスクのテストで再利用する（既存定義。本タスクでは新規追加しない）。

カーネル参照: §2（`Notifier` / `NotifyEvent`）、§4（`notification_intent` スキーマと `SqliteStore` の intent メソッド）、§9 step10（probeReachability の throw 条件）、§10（タスク表 #6）。

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/notifier.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/notifier.test.ts`

---

- [ ] **Step 1: 失敗するテストファイルを作成する（intent 記録 + console 必達 + Slack 成功）**

`/home/racoma-dev/loop-pilot-os/tests/notifier.test.ts` を新規作成する（この時点では `src/notifier.ts` が無いのでインポート解決に失敗 = red）。`fixedClock` は呼ぶ度に +1s の ISO を返す（カーネル §6）ため、`recordIntent` に渡る `now` は決定的。`SqliteStore` は `:memory:`。

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import { ConsoleSlackNotifier } from "../src/notifier.js";
import { fixedClock, instantSleep } from "./fakes.js";

// 注入する fetch のフェイク。応答は responses キューから順に取り出す。
// "throw" を積むとネットワークエラーを模す。
function makeFetch(responses: Array<{ ok: boolean; status: number } | "throw">) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("fetch called more times than configured");
    }
    if (next === "throw") {
      throw new TypeError("network down");
    }
    return new Response(null, { status: next.status }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("ConsoleSlackNotifier", () => {
  let store: SqliteStore;
  let logs: string[];
  const log = (s: string) => {
    logs.push(s);
  };

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    logs = [];
  });

  // 仕様 §10: 意図を Store へ先に記録し、ローカルチャネル(console)は必ず成功する。
  it("records the intent then logs to console and marks delivered_console=1 (no Slack configured)", async () => {
    const { fn, calls } = makeFetch([]);
    const notifier = new ConsoleSlackNotifier(
      store,
      null, // webhook 未設定
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "idle", detail: "queue empty" });

    // console へ整形出力された（絵文字付き日本語の文面・detail を含む）
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("queue empty");

    // intent は1件記録され、console 配信済み・Slack 不要(=配信済み扱い 1)
    const undelivered = store.undeliveredIntents();
    expect(undelivered.length).toBe(0); // console=1 ∧ slack=1 → 未配信なし

    // Slack 未設定なので fetch は呼ばれない
    expect(calls.length).toBe(0);
  });

  // Slack 設定時: {text} を POST し、2xx で delivered_slack=1。
  it("posts {text} to the webhook and marks delivered_slack=1 on 2xx", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "run_started", detail: "pid 42" });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.slack.test/abc");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("pid 42");

    // console + slack 両方配信済み → 未配信なし
    expect(store.undeliveredIntents().length).toBe(0);
    // console は必ず出る
    expect(logs.length).toBe(1);
  });
});
```

- [ ] **Step 2: red を確認する**

```
npx vitest run tests/notifier.test.ts
```

期待される失敗（src/notifier.ts 未作成のため import 解決エラー）:

```
Error: Failed to load url ../src/notifier.js (resolved id: .../src/notifier.ts) ... Does the file exist?
```

- [ ] **Step 3: `src/notifier.ts` を最小実装する（intent 記録 + console 必達 + Slack 単発 POST のみ）**

`/home/racoma-dev/loop-pilot-os/src/notifier.ts` を新規作成。カーネル §2 の `Notifier` / `NotifyEvent`、§4 の `SqliteStore` intent メソッドに一字一句一致させる。**この Step では Step 1 の2ケースだけを満たす最小実装に留める**：intent 記録 + console 必達 + （Slack 設定時は）`bumpAttempts` 1回 + **単発** POST し 2xx で `markDelivered(_, "slack")`。リトライ／指数バックオフは**まだ書かない**（Step 7 のテストに応じて追加する）。`probeReachability` は `Notifier` インターフェース充足のための**未実装スタブ**に留め、到達性検証ロジック（非2xx・network で throw、未設定で即 resolve・fetch 不呼出）は**まだ書かない**（Step 12 のテストに応じて追加する）。スタブは `Promise<void>` を即 resolve するだけで、POST もしないし throw もしない。これにより Step 12 の probe テストは genuine に red になる。

> TDD 上の意図（カーネル §0「全タスク red→green」・§11「テスト→失敗確認→実装→成功確認」）: バックオフループと probe ロジックは、**それを検証するテストが先に存在してから**書く。Step 3 ではそれらのテストはまだ無いので、対応コードも書かない。

```typescript
import type { SqliteStore } from "./store.js";
import type { Notifier, NotifyEvent } from "./types.js";

/**
 * NotifyEvent を「絵文字付き日本語」の1行テキストへ整形する。
 * console / Slack の双方で同じ文面を使う（仕様 §10）。
 */
export function formatNotifyEvent(event: NotifyEvent): string {
  switch (event.kind) {
    case "halted":
      return `🛑 LoopPilot OS 停止: ${event.reason} — ${event.detail}`;
    case "idle":
      return `💤 LoopPilot OS アイドル: 着手可能なタスクがありません — ${event.detail}`;
    case "run_started":
      return `🚀 LoopPilot OS 起動: ${event.detail}`;
  }
}

export class ConsoleSlackNotifier implements Notifier {
  private readonly store: SqliteStore;
  private readonly webhookUrl: string | null;
  private readonly log: (s: string) => void;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => string;

  constructor(
    store: SqliteStore,
    webhookUrl: string | null,
    log: (s: string) => void,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.webhookUrl = webhookUrl;
    this.log = log;
    this.fetchFn = fetchFn;
    this.sleep = sleep;
    this.clock = clock;
  }

  async notify(event: NotifyEvent): Promise<void> {
    const slackConfigured = this.webhookUrl !== null;
    // ① 意図を Store へ先に記録（payload = NotifyEvent の JSON）。
    //    Slack 未設定なら delivered_slack=1（=配信不要）で記録される（カーネル §4）。
    const intentId = this.store.recordIntent(
      JSON.stringify(event),
      slackConfigured,
      this.clock(),
    );

    // ② コンソールは必ず成功する（仕様 §6/§10）。整形して出力し delivered_console=1。
    const text = formatNotifyEvent(event);
    this.log(text);
    this.store.markDelivered(intentId, "console");

    // ③ Slack 設定時のみ POST。失敗しても throw しない（bumpAttempts のみ）。
    //    ※ この最小実装は「単発 POST」のみ。リトライ／指数バックオフは Step 7 のテストに応じて追加する。
    if (!slackConfigured) {
      return;
    }
    await this.deliverSlack(intentId, text);
  }

  /**
   * Slack へ {text} を **単発** POST する。2xx で delivered_slack=1。
   * 失敗しても throw しない（bumpAttempts のみ／人間の出番通知は console で既に届いている）。
   * ※ リトライ／指数バックオフは Step 7 のテスト追加時に実装する。
   */
  private async deliverSlack(intentId: number, text: string): Promise<void> {
    const url = this.webhookUrl as string;
    this.store.bumpAttempts(intentId);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        this.store.markDelivered(intentId, "slack");
      }
      // 非2xx は失敗扱い。undelivered のまま残す。
    } catch {
      // network エラーも失敗扱い。undelivered のまま残す。
    }
  }

  /**
   * プリフライト専用（カーネル §9 step10）。
   * ※ 未実装スタブ。到達性検証ロジック（未設定→即 resolve・fetch 不呼出／設定時は
   *   最小 POST し非2xx・network エラーで throw）は Step 12 のテスト追加時に実装する。
   *   現状は何もせず即 resolve するため、Step 12 の probe テストは genuine に red になる。
   */
  async probeReachability(): Promise<void> {
    return;
  }
}
```

- [ ] **Step 4: green を確認する**

```
npx vitest run tests/notifier.test.ts
```

期待: Step 1 の2ケースが pass（`2 passed`）。

- [ ] **Step 5: `npm run check` を通す**

```
npm run check
```

期待: tsc（src/test 双方）と vitest がグリーン（`0 errors` / 全テスト pass）。

- [ ] **Step 6: red-green の第1単位をコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier (intent record + console + Slack POST)"
```

---

- [ ] **Step 7: Slack リトライ／指数バックオフの失敗系テストを追加する（red）**

`tests/notifier.test.ts` の `describe` 末尾（最後の `it` の後）へ以下の3ケースを追記する。これらは Step 3 では**まだ実装していない** 3回リトライ＋指数バックオフ（1000ms→2000ms）の振る舞いを駆動するテストである。`instantSleep()` は呼び出しを記録するので、バックオフ呼び出し回数も検証する。Slack 全滅でも throw せず console は必達・intent は未配信(slack 未達)で `attempts=3` で残ることを確認する。

```typescript
  // 3回連続失敗(非2xx): throw せず、attempts=3、delivered_slack=0 のまま残る。
  it("retries 3 times on persistent non-2xx, never throws, leaves intent undelivered to Slack", async () => {
    const { fn, calls } = makeFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      sleep,
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    // throw しないこと
    await expect(
      notifier.notify({ kind: "halted", reason: "task_cap", detail: "3/3" }),
    ).resolves.toBeUndefined();

    // 3回 POST した
    expect(calls.length).toBe(3);
    // 指数バックオフ: 試行間の sleep は2回（1000ms, 2000ms）。最終失敗後は待たない。
    expect(sleeps).toEqual([1000, 2000]);

    // console は必達
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("3/3");

    // Slack 未達: undelivered に1件残り attempts=3
    const undelivered = store.undeliveredIntents();
    expect(undelivered.length).toBe(1);
    expect(undelivered[0].attempts).toBe(3);
    const event = JSON.parse(undelivered[0].payload);
    expect(event.kind).toBe("halted");
  });

  // network エラー(throw)が続いても notify は throw しない。
  it("swallows network errors across all attempts without throwing", async () => {
    const { fn, calls } = makeFetch(["throw", "throw", "throw"]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(
      notifier.notify({ kind: "idle", detail: "queue empty" }),
    ).resolves.toBeUndefined();

    expect(calls.length).toBe(3);
    expect(store.undeliveredIntents().length).toBe(1);
  });

  // 2回目で成功: それ以降リトライせず delivered_slack=1、attempts=2。
  it("succeeds on the second attempt and stops retrying", async () => {
    const { fn, calls } = makeFetch([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      sleep,
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await notifier.notify({ kind: "run_started", detail: "pid 7" });

    // 2回だけ POST（3回目はしない）
    expect(calls.length).toBe(2);
    // 1回目失敗後に1回だけ待つ
    expect(sleeps).toEqual([1000]);
    // 配信完了 → 未配信なし
    expect(store.undeliveredIntents().length).toBe(0);
  });
```

- [ ] **Step 8: red を確認する（genuine な失敗）**

```
npx vitest run tests/notifier.test.ts
```

期待: 追加3ケースは**必ず fail する**。Step 3 の `deliverSlack` は単発 POST のみ（リトライ無し）なので、3回 POST されず・バックオフ sleep も呼ばれず・`attempts` は 1 にしかならない。典型的な失敗:

```
FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > retries 3 times on persistent non-2xx, ...
AssertionError: expected 1 to be 3 // calls.length（1回しか POST していない）

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > succeeds on the second attempt and stops retrying
AssertionError: expected [] to deeply equal [ 1000 ] // sleeps（バックオフ未実装で sleep が呼ばれていない）
```

`makeFetch` は2件目以降を消費しないため、`succeeds on the second attempt` ケースでは1件目の 503 で諦め `undeliveredIntents().length` が 1 になり（期待 0）これも fail する。**いずれも「リトライ／バックオフ未実装」という予測どおりの失敗**であり、characterization ではない。

- [ ] **Step 9: 緑にするため Step 3 の `deliverSlack` をリトライ／指数バックオフ実装へ拡張する → green を確認する**

`src/notifier.ts` の `deliverSlack` を、Step 8 のテストを満たすよう **3回リトライ＋指数バックオフ** へ書き換える。あわせて定数を追加する（ファイル冒頭の import 直後）。

```typescript
/** Slack へ POST する最大試行回数（カーネル §10: リトライ3回）。 */
const SLACK_MAX_ATTEMPTS = 3;
/** 指数バックオフの基準ミリ秒（試行 n 回目失敗後に base * 2^(n-1) 待つ）。 */
const SLACK_BACKOFF_BASE_MS = 1000;
```

`deliverSlack` メソッド本体を以下へ差し替える:

```typescript
  /**
   * Slack へ {text} を POST する。2xx で delivered_slack=1。
   * 各試行で attempts を加算し、SLACK_MAX_ATTEMPTS まで指数バックオフでリトライ。
   * 全滅しても throw しない（人間の出番通知は console で既に届いている）。
   */
  private async deliverSlack(intentId: number, text: string): Promise<void> {
    const url = this.webhookUrl as string;
    for (let attempt = 1; attempt <= SLACK_MAX_ATTEMPTS; attempt++) {
      this.store.bumpAttempts(intentId);
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          this.store.markDelivered(intentId, "slack");
          return;
        }
        // 非2xx は失敗扱い。次の試行へ（最終試行なら諦める）。
      } catch {
        // network エラーも失敗扱い。次の試行へ。
      }
      if (attempt < SLACK_MAX_ATTEMPTS) {
        await this.sleep(SLACK_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
    // 全滅: throw せず undelivered のまま残す（status CLI で可視化）。
  }
```

再実行:

```
npx vitest run tests/notifier.test.ts
```

期待: 5ケース全て pass（`5 passed`）。最終失敗後は `attempt < SLACK_MAX_ATTEMPTS` ガードで待たないため `sleeps` は `[1000, 2000]` になる。

- [ ] **Step 10: `npm run check` を通す**

```
npm run check
```

期待: グリーン。

- [ ] **Step 11: リトライ／バックオフ実装＋失敗系テストをコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier Slack retry/backoff with failure-path tests"
```

---

- [ ] **Step 12: `probeReachability` のテストを追加する（red）**

`tests/notifier.test.ts` の `describe` 末尾へ追記。これらは Step 3 では**未実装スタブ**のままにした到達性検証の振る舞いを駆動するテストである。カーネル §9 step10: 未設定→即 resolve（fetch 不呼出）／設定→最小 POST、非2xx・network で throw。

```typescript
  // probe: webhook 未設定なら即 resolve、fetch を呼ばない。
  it("probeReachability resolves immediately without calling fetch when webhook is unset", async () => {
    const { fn, calls } = makeFetch([]);
    const notifier = new ConsoleSlackNotifier(
      store,
      null,
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });

  // probe: 2xx なら resolve。POST を1回だけ行う。
  it("probeReachability resolves on 2xx", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].init?.method).toBe("POST");
  });

  // probe: 非2xx なら throw（リトライしない・1回で判定）。
  it("probeReachability throws on non-2xx and does not retry", async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 404 }]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).rejects.toThrow(/404/);
    expect(calls.length).toBe(1);
  });

  // probe: network エラーは throw を伝播する。
  it("probeReachability propagates network errors", async () => {
    const { fn } = makeFetch(["throw"]);
    const notifier = new ConsoleSlackNotifier(
      store,
      "https://hooks.slack.test/abc",
      log,
      fn,
      instantSleep(),
      fixedClock("2026-06-05T00:00:00.000Z"),
    );

    await expect(notifier.probeReachability()).rejects.toThrow(/network down/);
  });
```

- [ ] **Step 13: red を確認する（genuine な失敗）**

```
npx vitest run tests/notifier.test.ts
```

期待: 追加4ケースのうち**到達性検証を要する2ケースは必ず fail する**。Step 3 の `probeReachability` は何もせず即 resolve するだけのスタブなので:

```
FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability resolves on 2xx
AssertionError: expected 0 to be 1 // calls.length（POST していない）

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability throws on non-2xx and does not retry
AssertionError: expected promise to resolve but it resolved with undefined; expected rejection matching /404/

FAIL  tests/notifier.test.ts > ConsoleSlackNotifier > probeReachability propagates network errors
AssertionError: expected promise to reject with error matching /network down/
```

（`resolves immediately without calling fetch when webhook is unset` ケースだけはスタブでも偶然 pass するが、設定時に POST・非2xx throw・network 伝播を要する3ケースは**スタブには未実装**なので予測どおり fail する。characterization ではない。）

- [ ] **Step 14: 緑にするため `probeReachability` を実装する → green を確認する**

`src/notifier.ts` の `probeReachability` スタブを、Step 12 のテストを満たす到達性検証実装へ差し替える（カーネル §9 step10）。

```typescript
  /**
   * プリフライト専用（カーネル §9 step10）。
   * Webhook 未設定なら即 resolve（fetch 不呼出）。設定時は最小 POST し、非2xx・network エラーで throw。
   * notify() と違い、ここでは到達性検証のため失敗を呼び出し元へ伝播する。
   */
  async probeReachability(): Promise<void> {
    if (this.webhookUrl === null) {
      return;
    }
    const res = await this.fetchFn(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "LoopPilot OS preflight reachability probe" }),
    });
    if (!res.ok) {
      throw new Error(
        `Slack webhook unreachable: POST returned HTTP ${res.status}`,
      );
    }
  }
```

再実行:

```
npx vitest run tests/notifier.test.ts
```

期待: 全9ケース pass（`9 passed`）。throw メッセージは `HTTP ${res.status}` を含むため `/404/` にマッチし、network エラーは throw がそのまま伝播するため `/network down/` にマッチする。

- [ ] **Step 15: `npm run check` を通す**

```
npm run check
```

期待: グリーン。

- [ ] **Step 16: probe 実装＋テストをコミットする**

```
git add src/notifier.ts tests/notifier.test.ts && git commit -m "feat: ConsoleSlackNotifier probeReachability with throw-condition tests"
```
