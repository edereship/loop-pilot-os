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
