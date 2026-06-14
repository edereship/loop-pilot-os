import type { SqliteStore } from "./store.js";
import type { Notifier, NotifyEvent } from "./types.js";

/** Slack へ POST する最大試行回数（カーネル §10: リトライ3回）。 */
const SLACK_MAX_ATTEMPTS = 3;
/** 指数バックオフの基準ミリ秒（試行 n 回目失敗後に base * 2^(n-1) 待つ）。 */
const SLACK_BACKOFF_BASE_MS = 1000;

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
    case "task_started":
      return `▶️ 着手: ${event.identifier} ${event.title}`;
    case "task_merged":
      return `✅ 完了: ${event.identifier} ${event.title}（merged ${event.mergedCount}件）`;
    case "quota_waiting":
      return `⏳ Codex quota 待機中: ${event.detail}`;
    case "quota_resumed":
      return `🔄 Codex quota 回復: ${event.detail}`;
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
}
