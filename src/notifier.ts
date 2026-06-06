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
