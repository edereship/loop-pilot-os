import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  FakeTaskSource,
  FakeAgentRunner,
  FakeGitPr,
  FakeMonitor,
  FakeNotifier,
  fixedClock,
  instantSleep,
} from "./fakes.js";
import type { Config } from "../src/config.js";
import type { EligibleIssue, PromptArgs, TaskSessionRow } from "../src/types.js";

// ---- テストヘルパ（Task 12 の makeConfig/issue/makeHarness と同形・独立ファイルのため再定義） ----
function makeConfig(over: Partial<{
  goal: string;
  recentMergedCount: number;
  maxTasksPerRun: number;
  maxCostUsdPerSession: number;
  notEngagedGuardMinutes: number;
  monitorTimeoutMinutes: number | undefined;
  monitorPollSeconds: number;
  idleRecheckSeconds: number;
  gateLabel: string;
}> = {}): Config {
  return {
    product: { goal: over.goal ?? "ship the product" },
    digest: { recentMergedCount: over.recentMergedCount ?? 5 },
    safety: {
      maxTasksPerRun: over.maxTasksPerRun ?? 3,
      maxCostUsdPerSession: over.maxCostUsdPerSession ?? 10,
      notEngagedGuardMinutes: over.notEngagedGuardMinutes ?? 30,
      monitorTimeoutMinutes: over.monitorTimeoutMinutes,
      sessionHardTimeoutMinutes: 120,
    },
    loop: {
      monitorPollSeconds: over.monitorPollSeconds ?? 60,
      idleRecheckSeconds: over.idleRecheckSeconds ?? 300,
    },
    looppilot: { gateLabel: over.gateLabel ?? "loop-pilot" },
  } as unknown as Config;
}

function issue(id: string, identifier: string, over: Partial<EligibleIssue> = {}): EligibleIssue {
  return {
    id,
    identifier,
    title: over.title ?? `Title for ${identifier}`,
    description: over.description ?? "",
    priority: over.priority ?? 2,
    sortOrder: over.sortOrder ?? 0,
    url: over.url ?? `https://linear.app/issue/${identifier}`,
  };
}

interface Harness {
  orch: Orchestrator;
  store: SqliteStore;
  source: FakeTaskSource;
  agent: FakeAgentRunner;
  git: FakeGitPr;
  monitor: FakeMonitor;
  notifier: FakeNotifier;
  sleepCalls: number[];
  logs: string[];
  promptArgs: PromptArgs[];
}

function makeHarness(config: Config): Harness {
  const store = new SqliteStore(":memory:");
  const source = new FakeTaskSource();
  const agent = new FakeAgentRunner();
  const git = new FakeGitPr();
  const monitor = new FakeMonitor();
  const notifier = new FakeNotifier();
  const sleepInner = instantSleep();
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    await sleepInner(ms);
  };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const promptArgs: PromptArgs[] = [];
  const buildPrompt = (args: PromptArgs): string => {
    promptArgs.push(args);
    return `PROMPT for ${args.issue.identifier}`;
  };
  const orch = new Orchestrator({
    config,
    source,
    agent,
    git,
    monitor,
    notifier,
    store,
    buildPrompt,
    clock: fixedClock("2026-06-05T00:00:00.000Z"),
    sleep,
    log,
  });
  return { orch, store, source, agent, git, monitor, notifier, sleepCalls, logs, promptArgs };
}

/**
 * 前回 Run のクラッシュ状態を仕込むヘルパ。
 * 旧 Run を作り、その下に active セッション 1 行を作って指定 state へ進める。
 * 返り値は仕込んだセッション行（最新値）。
 */
function seedCrashedSession(
  store: SqliteStore,
  patch: Partial<TaskSessionRow> & { state: TaskSessionRow["state"] },
  over: Partial<{ linearIssueId: string; linearIdentifier: string; branch: string; worktreePath: string }> = {},
): TaskSessionRow {
  const oldRun = store.createRun(3, "2026-06-04T00:00:00.000Z");
  const s = store.createSession({
    runId: oldRun.id,
    linearIssueId: over.linearIssueId ?? "issue-A",
    linearIdentifier: over.linearIdentifier ?? "TY-1",
    issueTitle: "Crashed task",
    branch: over.branch ?? "looppilot/ty-1-x",
    worktreePath: over.worktreePath ?? "/wt/ty-1",
    now: "2026-06-04T00:00:01.000Z",
  });
  store.updateSession(s.id, patch);
  return store.getSession(s.id);
}

describe("回復 — in_review + PR が停止系 verdict（仕様 §9 / カーネル §8）", () => {
  it("poll が pr_closed → stopped(pr_closed) + Run=halted、ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Z", "TY-9")]; // 回復で HALT すれば SELECT には進まない
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.runId).toBe(newRun.id);
    // Run=halted・回復で停止したのでループに入らず getNextEligible は呼ばれない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "pr_closed" });
  });

  it("poll が stopped(stopReason='codex gave up') → stopped(looppilot_stopped, detail=stopReason) + HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });

  it("poll が stopped(stopReason=null) → detail は既定文言へ", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });
});

describe("回復 — in_review + PR が open 扱い → 採用して MONITOR 再開（仕様 §9 / カーネル §8）", () => {
  it("poll が in_progress → done → merged で完走し、monitorStartedAt は上書きされない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:10:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: originalStart,
    });
    // 回復 poll(in_progress) で採用 → monitorSession の poll で done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];
    // 回復後ループに入るので 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // 採用 → MONITOR 再開 → merged
    expect(s.state).toBe("merged");
    expect(s.runId).toBe(newRun.id);
    // 監視起点は上書きされない（ガード/timeout の経過継続。カーネル §8）
    expect(s.monitorStartedAt).toBe(originalStart);
    // DONE 後段 transition(done)
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // merge が呼ばれた（done→ready→merge）
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
    // tasks_started=1（採用で新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
  });

  it("poll が corrupted（open 扱いで採用）→ 続く poll が即 corrupted を維持 → MONITOR が即 stopped(monitor_never_engaged) で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 回復 poll(corrupted) で採用 → monitorSession の poll(corrupted) で即停止
    h.monitor.verdicts = [{ kind: "corrupted" }, { kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // 回復が HALT で終わったのでループに入らない
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});

describe("回復 — in_review + poll throw → 採用して MONITOR 再開（仕様 §9 / カーネル §8: 再起動直後 API 不調）", () => {
  // 回復時の poll throw は最頻の実障害（再起動直後の API 不調）。採用して MONITOR 再開することをピン留めする（この分岐を消すと red になる）
  it("poll が 1 回目 throw → 採用・MONITOR 再開 → 2 回目 merged → 完走し runId が新 Run に付替えられログに recovery: poll threw が含まれる", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 2 回目以降の poll は merged を返す（FakeMonitor の verdicts キュー）
    h.monitor.verdicts = [{ kind: "merged" }];
    // 1 回目の poll だけ throw、以降は元の FakeMonitor.poll に委譲
    const origPoll = h.monitor.poll.bind(h.monitor);
    let thrown = false;
    h.monitor.poll = async (pr: number) => {
      if (!thrown) {
        thrown = true;
        throw new Error("gh 502");
      }
      return origPoll(pr);
    };
    // 回復後ループで無限化しないよう getNextEligible の最初の呼び出しで停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    // 採用 → MONITOR 再開 → merged
    expect(s.state).toBe("merged");
    // runId が新 Run へ付替えられている
    expect(s.runId).toBe(newRun.id);
    // DONE 後段: transition(done) が呼ばれた
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // ログに recovery: poll threw が含まれる
    expect(h.logs.some((l) => l.includes("recovery: poll threw"))).toBe(true);
  });
});

describe("回復 — claimed/implementing/handing_off で open PR ヒット → 採用（仕様 §9 / カーネル §8）", () => {
  it("handing_off で findOpenPrForBranch が #555 を返す → state=in_review・PR永続化・monitorStartedAt は既存値 → MONITOR 完走", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:12:00.000Z";
    const crashed = seedCrashedSession(
      h.store,
      { state: "handing_off", monitorStartedAt: originalStart },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 既存オープン PR を発見
    h.git.openPrForBranch.set("looppilot/ty-1-x", 555);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(555);
    expect(s.runId).toBe(newRun.id);
    // monitorStartedAt は既存値（??  clock の右辺は使われない）
    expect(s.monitorStartedAt).toBe(originalStart);
    // 採用で tasks_started に数えられる
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [555, "sha-555"] });
  });

  it("implementing で monitorStartedAt=null・open PR ヒット → monitorStartedAt が clock() で新規設定される", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "implementing", monitorStartedAt: null },
      { branch: "looppilot/ty-2-x", worktreePath: "/wt/ty-2", linearIssueId: "issue-B", linearIdentifier: "TY-2" },
    );
    h.git.openPrForBranch.set("looppilot/ty-2-x", 666);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("merged");
    expect(s.prNumber).toBe(666);
    // monitorStartedAt は null だったので clock() で設定（基準 2026-06-05... 始まり）
    expect(typeof s.monitorStartedAt).toBe("string");
    expect(s.monitorStartedAt).toMatch(/^2026-06-05T00:00:\d{2}\.\d{3}Z$/);
  });
});

describe("回復 — open PR ミス → stopped(exception) + HALT（仕様 §9 / カーネル §8: 手動掃除）", () => {
  it("claimed で findOpenPrForBranch が null → stopped(exception, stop_detail に branch/worktree/identifier) + HALT・ループに入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", monitorStartedAt: null },
      { branch: "looppilot/ty-7-x", worktreePath: "/wt/ty-7", linearIssueId: "issue-G", linearIdentifier: "TY-7" },
    );
    // open PR なし（既定 null）
    h.source.queue = [issue("issue-Z", "TY-9")];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    // stop_detail に branch / worktree / identifier を明記（手動掃除を促す。カーネル §8）
    expect(s.stopDetail).toContain("crash recovery: no open PR");
    expect(s.stopDetail).toContain("looppilot/ty-7-x");
    expect(s.stopDetail).toContain("/wt/ty-7");
    expect(s.stopDetail).toContain("TY-7");
    expect(s.runId).toBe(newRun.id);
    // HALT したのでループに入らない
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 通知列: run_started → halted（停止 1 回）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
    // pushAndOpenPr / mergePr は呼ばれない（タスク内再開は v1 スコープ外）
    expect(h.git.calls.some((c) => c.method === "pushAndOpenPr")).toBe(false);
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("worktreePath=null でも stop_detail にプレースホルダを出して HALT する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "claimed", worktreePath: null },
      { branch: "looppilot/ty-8-x", linearIssueId: "issue-H", linearIdentifier: "TY-8" },
    );

    await h.orch.run();

    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("<no worktree>");
    expect(s.stopDetail).toContain("looppilot/ty-8-x");
    expect(s.stopDetail).toContain("TY-8");
  });

  // findOpenPrForBranch が throw（gh 一時障害）→ Fatal 落ち・無通知ではなく
  // stopped(exception)+HALT+通知で人間に上げる（回復経路でも「失敗は HALT で surface」）。
  it("handing_off で findOpenPrForBranch が throw → run() は throw せず stopped(exception)+HALT+通知", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(
      h.store,
      { state: "handing_off", monitorStartedAt: null },
      { branch: "looppilot/ty-11-x", worktreePath: "/wt/ty-11", linearIssueId: "issue-K", linearIdentifier: "TY-11" },
    );
    h.git.failNext("findOpenPrForBranch", new Error("gh pr list failed: API rate limit"));

    // run() は Fatal 経路へ伝播せず正常終了する
    await expect(h.orch.run()).resolves.toBe("finished");

    const newRun = h.store.latestRun()!;
    const s = h.store.getSession(crashed.id);
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("API rate limit");
    expect(newRun.state).toBe("halted");
    // ループに入らない・通知される
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "exception" });
  });
});

describe("回復 — 孤児チケット（In Progress だがセッション行なし → Todo 復帰・ベストエフォート）（仕様 §9 / カーネル §8）", () => {
  it("findOrphanedInProgress が 2 件返す → 各々 transition(todo) + 警告ログ。HALT しない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 活性セッションは無し（孤児だけ）→ 回復は孤児復帰のみ。
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 回復後ループは 1 回の SELECT で停止させる
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 孤児 2 件が Todo へ戻された
    expect(h.source.transitions).toEqual([
      { issueId: "issue-O1", state: "todo" },
      { issueId: "issue-O2", state: "todo" },
    ]);
    // 警告ログが各孤児に出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-11"))).toBe(true);
    expect(h.logs.some((l) => l.includes("warning") && l.includes("TY-12"))).toBe(true);
    // 孤児復帰は HALT しない → ループに入った（getNextEligible が呼ばれている）
    // 注: requestStop() → haltForInterrupt() により run.state は halted になるが、
    // これは recovery の HALT ではなく user_interrupt による正常終了である。
    // recovery が HALT していないことは eligibleCalls >= 1（ループに入った）で確認する。
    expect(h.source.eligibleCalls).toHaveLength(1);
    // 通知列には run_started が含まれる（recovery-HALT なら run_started のみ + halted(from recovery)）
    expect(h.notifier.events.some((e) => e.kind === "run_started")).toBe(true);
  });

  it("transition(todo) が throw してもベストエフォート（HALT せず警告ログ）で次の孤児へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.orphans = [issue("issue-O1", "TY-11"), issue("issue-O2", "TY-12")];
    // 最初の transition(todo) で 1 回だけ throw（FakeTaskSource.failNext は次の1回だけ throw）
    h.source.failNext("transition", new Error("Linear 5xx"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    // 1 件目の transition は throw（記録されない）、2 件目は成功して記録される
    expect(h.source.transitions).toEqual([{ issueId: "issue-O2", state: "todo" }]);
    // ベストエフォートなので recovery は HALT していない → ループに入った
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("findOrphanedInProgress 自体が throw しても回復は HALT せず警告のみで継続する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.failNext("findOrphanedInProgress", new Error("Linear query failed"));
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    expect(h.logs.some((l) => l.includes("warning") && l.includes("findOrphanedInProgress failed"))).toBe(true);
    // findOrphanedInProgress の throw は recovery HALT しない → ループに入った
    expect(h.source.eligibleCalls).toHaveLength(1);
  });
});

describe("回復 — 採用セッションが tasks_started に数えられ上限と比較される（仕様 §11 / カーネル §8）", () => {
  it("maxTasksPerRun=1 で回復が 1 件採用→完走すると、ループ先頭で task cap 到達 → SELECT せず HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 残キューに 1 件あるが、採用 1 件で上限到達のため着手されない
    h.source.queue = [issue("issue-Q", "TY-99")];
    // 回復 poll が open → 採用して MONITOR、done→merged で完走
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 採用セッションは新 Run の tasks_started=1
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // 上限到達でループ先頭 HALT（SELECT に進まない → getNextEligible は呼ばれない）
    expect(newRun.state).toBe("halted");
    expect(newRun.haltReason).toContain("task cap reached");
    expect(h.source.eligibleCalls).toHaveLength(0);
    // 残キューの TY-99 は未着手
    expect(h.source.queue.map((i) => i.identifier)).toEqual(["TY-99"]);
    // 通知列: run_started → halted(task_cap)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "task_cap" });
  });

  it("回復で HALT したら（in_review が stopped verdict）ループに一切入らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    h.source.queue = [issue("issue-Q", "TY-99")];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "gave up" }];

    await h.orch.run();

    // 回復で HALT → ループ(loop)に入らず SELECT は 0 回
    expect(h.source.eligibleCalls).toHaveLength(0);
    expect(h.agent.contexts).toHaveLength(0); // 実装フェーズにも入らない
    expect(h.store.latestRun()!.state).toBe("halted");
  });
});

describe("回復 — updateSession({runId}) による再ペアレント確認（Task 5 carry-over）", () => {
  it("再ペアレントで countTasksStarted が旧 Run から新 Run へ移行し monitorStartedAt は保持される", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const originalStart = "2026-06-04T00:15:00.000Z";
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 200,
      monitorStartedAt: originalStart,
    });
    // 旧 Run の countTasksStarted を確認（セッション 1 件が旧 Run に属している）
    const oldRunId = crashed.runId;
    expect(h.store.countTasksStarted(oldRunId)).toBe(1);

    // 回復: poll=merged → runId を新 Run へ付替え
    h.monitor.verdicts = [{ kind: "merged" }];
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.orch.requestStop();
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const adopted = h.store.getSession(crashed.id);

    // 旧 Run の countTasksStarted は 0 に減少（セッションが新 Run へ移動）
    expect(h.store.countTasksStarted(oldRunId)).toBe(0);
    // 新 Run の countTasksStarted は 1 に増加
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // monitorStartedAt は再ペアレント後も保持されている（上書きされない）
    expect(adopted.monitorStartedAt).toBe(originalStart);
  });
});

describe("回復 — 複数 active セッションは id ASC・最初の HALT で打ち切り（仕様 §9 / カーネル §8）", () => {
  it("2 件 active（1 件目 in_review→merged、2 件目 claimed→open PR ミス）→ 1 件目採用後 2 件目で HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 5 });
    const h = makeHarness(config);
    // 1 件目: in_review + PR #100（merged で完走）
    const s1 = seedCrashedSession(
      h.store,
      { state: "in_review", prNumber: 100, monitorStartedAt: "2026-06-04T00:10:00.000Z" },
      { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1", linearIssueId: "issue-A", linearIdentifier: "TY-1" },
    );
    // 2 件目: claimed・open PR ミス → HALT（同じ store・別セッション）
    const s2RunSeed = h.store.createSession({
      runId: h.store.latestRun()!.id, // s1 の旧 Run と同じ旧 Run
      linearIssueId: "issue-B",
      linearIdentifier: "TY-2",
      issueTitle: "second crashed",
      branch: "looppilot/ty-2-x",
      worktreePath: "/wt/ty-2",
      now: "2026-06-04T00:00:02.000Z",
    });
    h.store.updateSession(s2RunSeed.id, { state: "claimed" });
    // 1 件目だけ open verdict→merged で完走。2 件目は open PR 無し（既定 null）で HALT。
    h.monitor.verdicts = [{ kind: "merged" }];
    // 回復で HALT したらループに入らないことを assertion で保証する。
    // カットオフが退行した場合、ここで requestStop() せず null を返し続けると CI がハングするため、
    // getNextEligible を hook して requestStop() + null を返す（ハング→アサーション失敗に変換）。
    // 正常動作では回復 HALT → ループに入らない → このフックは呼ばれず eligibleCalls.length===0。
    h.source.getNextEligible = async (excludeIds: string[]) => {
      h.source.eligibleCalls.push([...excludeIds]);
      h.orch.requestStop();
      return null;
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    const r1 = h.store.getSession(s1.id);
    const r2 = h.store.getSession(s2RunSeed.id);
    // 1 件目は merged（採用・DONE 後段）
    expect(r1.state).toBe("merged");
    expect(r1.runId).toBe(newRun.id);
    // 2 件目は stopped(exception)（open PR ミス）→ HALT
    expect(r2.state).toBe("stopped");
    expect(r2.failureReason).toBe("exception");
    expect(r2.runId).toBe(newRun.id);
    // 回復で HALT → ループに入らない（cutoff 退行なら getNextEligible が呼ばれ eligibleCalls.length>0 になる）
    expect(newRun.state).toBe("halted");
    expect(h.source.eligibleCalls).toHaveLength(0);
  });
});

describe("回復 — in_review + PR が merged（仕様 §9 / カーネル §8: DONE 後段・二重計上なし）", () => {
  it("再起動時 in_review+PR で monitor.poll が merged → merged 永続化 + transition(done)・新 Run の merged_count=1", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    // 前回クラッシュ: in_review・PR #100・監視起点あり
    const crashed = seedCrashedSession(h.store, {
      state: "in_review",
      prNumber: 100,
      monitorStartedAt: "2026-06-04T00:10:00.000Z",
    });
    // 起動後キューは空（回復のみで完結、その後 IDLE→…だが taskCap で止める設計確認のため queue 空）
    h.source.queue = [];
    // 回復で poll は 1 回呼ばれ merged を返す
    h.monitor.verdicts = [{ kind: "merged" }];
    // 回復後ループで getNextEligible は null → IDLE → だが taskCap=3 未到達で sleep ループに入る。
    // それを避けるため回復完了直後にループへ入らせない: queue 空 + idle を 1 回で抜けられないので、
    // ここでは「回復処理単体の効果」を検証するため、回復後ループに入る前提で merged を確認する。
    // ループ無限化を防ぐため getNextEligible を 1 回 null 後に requestStop で抜ける。
    let getCalls = 0;
    const origGetNext = h.source.getNextEligible.bind(h.source);
    h.source.getNextEligible = async (excludeIds: string[]) => {
      getCalls += 1;
      h.orch.requestStop(); // 回復後ループの最初の安全点で停止
      return origGetNext(excludeIds);
    };

    await h.orch.run();

    const newRun = h.store.latestRun()!;
    // 回復で採用された旧セッションは新 Run へ付替えられ merged になっている
    const adopted = h.store.getSession(crashed.id);
    expect(adopted.state).toBe("merged");
    expect(adopted.runId).toBe(newRun.id);
    expect(adopted.endedAt).not.toBeNull();
    // DONE 後段: transition(done) が呼ばれた
    expect(h.source.transitions).toContainEqual({ issueId: "issue-A", state: "done" });
    // 二重計上なし: 新 Run の merged_count は導出で 1
    expect(h.store.countMerged(newRun.id)).toBe(1);
    // tasks_started も 1（runId 付替えで新 Run に数えられる）
    expect(h.store.countTasksStarted(newRun.id)).toBe(1);
    // 回復で HALT していない（merged は成功終端）→ ループに入っている
    expect(getCalls).toBeGreaterThanOrEqual(1);
  });
});
