import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import { ConsoleSlackNotifier, formatNotifyEvent } from "../src/notifier.js";
import { fixedClock, instantSleep } from "./fakes.js";
import type { FetchFn } from "../src/task-source.js";

// 注入する fetch のフェイク。応答は responses キューから順に取り出す。
// "throw" を積むとネットワークエラーを模す。
function makeFetch(responses: Array<{ ok: boolean; status: number } | "throw">) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("fetch called more times than configured");
    }
    if (next === "throw") {
      throw new TypeError("network down");
    }
    return { ok: next.ok, status: next.status, json: async () => null as unknown };
  };
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
});

describe("formatNotifyEvent", () => {
  it("formats task_started with emoji, identifier and title", () => {
    const text = formatNotifyEvent({
      kind: "task_started",
      identifier: "TY-123",
      title: "Fix login bug",
    });
    expect(text).toBe("▶️ 着手: TY-123 Fix login bug");
  });

  it("formats task_merged with emoji, identifier, title and merged count", () => {
    const text = formatNotifyEvent({
      kind: "task_merged",
      identifier: "TY-456",
      title: "Add search",
      mergedCount: 2,
    });
    expect(text).toBe("✅ 完了: TY-456 Add search（merged 2件）");
  });

  it("formats quota_waiting with hourglass emoji and detail", () => {
    const text = formatNotifyEvent({
      kind: "quota_waiting",
      detail: "TY-789 codex_usage_limit (retry 1/6)",
    });
    expect(text).toBe("⏳ Codex quota 待機中: TY-789 codex_usage_limit (retry 1/6)");
  });

  it("formats quota_resumed with refresh emoji and detail", () => {
    const text = formatNotifyEvent({
      kind: "quota_resumed",
      detail: "TY-789 quota recovered after 2 retries",
    });
    expect(text).toBe("🔄 Codex quota 回復: TY-789 quota recovered after 2 retries");
  });

  it("formats paused with pause emoji, target and detail", () => {
    const text = formatNotifyEvent({
      kind: "paused",
      target: "claude",
      detail: "rate limited until 02:00 UTC",
    });
    expect(text).toBe("⏸️ LoopPilot OS 一時停止 (claude): rate limited until 02:00 UTC");
  });

  it("formats resumed with play emoji, target and detail", () => {
    const text = formatNotifyEvent({
      kind: "resumed",
      target: "codex",
      detail: "rate limit cleared",
    });
    expect(text).toBe("▶️ LoopPilot OS 再開 (codex): rate limit cleared");
  });
});
