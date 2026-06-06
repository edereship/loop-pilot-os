### Task 13: Orchestrator 失敗系 + 安全弁

**目的**: Task 12 が組んだ `src/orchestrator.ts` の正常フローに対し、カーネル §7 の**全失敗経路と安全弁**を確定させる。コード変更は最小限の 2 点（①`done` verdict での `mergePr` **2 連続 throw → fail-closed stopped(ci_failed)** をカーネル §7.6 の文言どおりに実装、②**SIGINT/停止要求フラグ**を注入可能な形で追加し「次の安全点で halt」を実現）に留め、残りは Task 12 が既に書いた失敗分岐（CLAIM ①/②・agent_no_change・cost_exceeded・exception・handoff_failed・各 verdict→stopped 写像・poll throw バックオフ・DONE transition 失敗継続）を **テストで固定**する。`fixedClock`/`instantSleep`＋テスト内の `monitorStartedAt` 上書きで時間を決定的にする。

**依存タスク**:
- Task 12（`src/orchestrator.ts` の `Orchestrator`・`OrchestratorDeps`・`loop`/`claim`/`implement`/`handoff`/`monitorSession`/`tryMerge`/`done`/`stopSession`、`tests/fakes.ts` の `FakeTaskSource`/`FakeAgentRunner`/`FakeGitPr`/`FakeMonitor`/`FakeNotifier`、`tests/orchestrator.test.ts` の `makeConfig`/`issue`/`makeHarness`/`Harness`）。本タスクは**これらを再定義せず Modify する**。
- Task 2（`src/types.ts`：`FailureReason`・`MonitorVerdict`・`MergeReadiness`・`TaskSessionRow` 等）
- Task 5（`src/store.ts`：`SqliteStore`。`updateSession`/`setRunState`/`countTasksStarted`/`countMerged`/`getSession`/`sessionsForRun`/`latestRun` を使用）

**前提とする既存シンボル（他タスク定義物・本タスクでは作らない）**:
- `src/orchestrator.ts`: `Orchestrator`, `OrchestratorDeps`（Task 12）
- `src/types.ts`: `FailureReason`, `MonitorVerdict`, `MergeReadiness`, `TaskSessionRow`, `AgentOutcome`, `EligibleIssue`, `NotifyEvent`（カーネル §2）
- `src/store.ts`: `SqliteStore`（カーネル §4）
- `src/config.ts`: `Config`（型のみ。テストは `makeConfig` の `as unknown as Config` キャスト）
- `tests/fakes.ts`: `FakeTaskSource`, `FakeAgentRunner`, `FakeGitPr`, `FakeMonitor`, `FakeNotifier`, `fixedClock`, `instantSleep`（Task 3/12）
- `tests/orchestrator.test.ts`: `makeConfig`, `issue`, `makeHarness`, `Harness`（Task 12 で定義済み。本タスクは import せず**同ファイルに describe を追記**するだけ）

> 注: 本タスクが触る Config フィールドは Task 12 と同一（`safety.maxTasksPerRun`/`safety.maxCostUsdPerSession`/`safety.notEngagedGuardMinutes`/`safety.monitorTimeoutMinutes`/`loop.monitorPollSeconds`/`loop.idleRecheckSeconds`/`looppilot.gateLabel`/`product.goal`/`digest.recentMergedCount`）。新フィールドは追加しない。

---

#### このセクションが確定させる失敗系・安全弁の形（実装の正）

カーネル §7 の失敗経路を、Task 12 のコード構造（`RunControl` 番兵・`stopSession` 共通終端・各フェーズ private メソッド）の上で固定する。**Task 12 から変えるコードは 2 箇所だけ**:

1. **`mergePr` 2 連続 throw の fail-closed（カーネル §7.6）** — Task 12 の `tryMerge` は throw を握って常に `"continue"` を返す（連続回数を数えない）。これを「`ready` verdict のまま `mergePr` が **2 連続** throw → `stopped(ci_failed, stop_detail="merge call failed under ready verdict: <error>")`」に直す。実装は `monitorSession` 側に **連続マージ失敗カウンタ** `mergeFailures` を持たせ、`tryMerge` が throw を `{ kind:"merge_failed", error }`（判別共用体の第 4 メンバ）として返す形に変更する。`ready` 以外の readiness（ci_failed/conflict/blocked）由来の即 halt は Task 12 のまま。`continue`（ci_pending/unknown）が一度でも挟まれば `mergeFailures` をリセットする（「ready のまま 2 連続」を厳密に表す）。

2. **SIGINT / 停止要求フラグ（カーネル §7 末尾）** — `process.on("SIGINT")` を直接張ると `process.exit` が混ざりテスト不能になるため、注入可能にする。`Orchestrator` に public `requestStop(): void`（`interrupted=true` を立てるだけ）と private `interrupted=false` を追加し、**ループの安全点**（各反復先頭＝タスク上限チェックの直前）で `interrupted` を見て `haltForInterrupt()`（Run=halted(reason="user_interrupt") + notify(halted)・進行中セッションは stopped にしない）→ ループ脱出する。実 SIGINT ハンドラ（`process.on("SIGINT", () => orch.requestStop())` と最終 `process.exit`）の配線は Task 16（main）の所掌。ロック解放は Task 12 の `run()` の `finally` が担うため二重実装しない。

その他の失敗経路（CLAIM ①②、agent_no_change の 2 形、cost_exceeded、exception、handoff_failed の PR 番号明記、各 verdict→stopped 写像、not_engaged ガード、monitor_timeout、poll throw 5 連続、DONE transition 3 回失敗でも継続）は **Task 12 の実装が既に正しい**ので、コードは変えず **網羅テストだけを足す**。テストで挙動が仕様とズレた場合のみ、カーネルとの一致を確認し、矛盾は openQuestions に上げる（勝手に直さない）。

---

#### Files

- **Modify**: `/home/racoma-dev/loop-pilot-os/src/orchestrator.ts`（`tryMerge` の戻り値型と throw 扱い・`monitorSession` の連続マージ失敗カウント、`requestStop`/`interrupted`/安全点チェック/`haltForInterrupt` を追加）
- **Modify**: `/home/racoma-dev/loop-pilot-os/tests/orchestrator.test.ts`（失敗系・安全弁の describe を追記。`makeConfig`/`issue`/`makeHarness`/`Harness` は再定義しない）

---

#### Step-by-step（TDD）

- [ ] **Step 1: CLAIM ①（prepareWorktree 失敗→セッション行なし HALT）と ②（transition 失敗→discardWorktree+stopped(claim_failed)+todo 復帰→HALT）のテストを追加（red→green）**

`tests/orchestrator.test.ts` の末尾に describe を追記する（`makeConfig`/`issue`/`makeHarness` は Task 12 で定義済みのものを使う）:

```typescript
describe("Orchestrator 失敗系 — CLAIM（仕様 §5.2 / カーネル §7.3）", () => {
  it("① prepareWorktree が throw → セッション行を作らず Run=halted(claim_failed) で停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.failNext("prepareWorktree", new Error("worktree add: already exists"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    // セッション行は 1 つも作られない（CLAIM ① はセッション行なしで HALT）
    expect(h.store.sessionsForRun(run.id)).toHaveLength(0);
    expect(h.store.countTasksStarted(run.id)).toBe(0);
    // Run は halted・理由に claim_failed
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("claim_failed");
    expect(run.haltReason).toContain("TY-1");
    // transition は一切呼ばれない（in_progress すら）
    expect(h.source.transitions).toEqual([]);
    // 通知列: run_started → halted(claim_failed)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });

  it("② transition(in_progress) が throw → discardWorktree + stopped(claim_failed) + ticket→Todo 復帰 → HALT", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    const iss = issue("issue-A", "TY-1");
    h.source.queue = [iss];
    // prepareWorktree は成功・branch/worktree を固定
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // transition の最初の呼び出し（in_progress）で throw
    h.source.failNext("transition", new Error("Linear 5xx"));

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // セッション行は作られている（createSession は transition より前）
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("claim_failed");
    expect(s.stopDetail).toContain("transition(in_progress) failed");
    expect(s.endedAt).not.toBeNull();
    // discardWorktree がベストエフォートで呼ばれた
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // ticket→Todo 復帰がベストエフォートで呼ばれた（in_progress は throw したので記録されない）
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "todo" }]);
    // Run=halted・通知列 run_started → halted(claim_failed)
    expect(run.state).toBe("halted");
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "claim_failed" });
  });
});
```

実行して green を確認する（コア実装は Task 12 が済ませているので初回 green の見込み）:

```
npx vitest run tests/orchestrator.test.ts -t "CLAIM"
```

期待: 両テスト green。落ちたら Task 12 の `claim()` 分岐（① はセッション作成前に HALT、② は `createSession` 後に `discardWorktree`→`transition(todo)`→`stopSession`）を仕様と突き合わせる。ズレがカーネル §7.3（カーネル §7 ステップ 3）と矛盾するなら openQuestions に記録（勝手に直さない）。

- [ ] **Step 2: IMPLEMENT 失敗系（agent_no_change 2 形 / cost_exceeded の discardWorktree 順 / exception）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記:

```typescript
describe("Orchestrator 失敗系 — IMPLEMENT（仕様 §5.3 / カーネル §7.4）", () => {
  it("agent_no_change【未コミット残骸】hasUncommittedChanges=true → stopped(agent_no_change, 'uncommitted leftovers')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 0.7, summary: "tried" }];
    // 残骸あり → hasCommitsWithDiff まで進まない
    h.git.uncommitted.set("/wt/ty-1", true);

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBe("uncommitted leftovers");
    // 仕様 §7: completed はまず cost と summary を永続化してから後条件を見る
    expect(s.costUsd).toBe(0.7);
    expect(s.agentSummary).toBe("tried");
    // hasUncommittedChanges を見たら true なので hasCommitsWithDiff は呼ばれない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // HANDOFF へ進んでいない
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("agent_no_change【無差分】hasUncommittedChanges=false ∧ hasCommitsWithDiff=false → stopped(agent_no_change, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1.2, summary: "nothing useful" }];
    h.git.uncommitted.set("/wt/ty-1", false);
    h.git.commitsWithDiff.set("/wt/ty-1", false); // 実差分なし

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("agent_no_change");
    expect(s.stopDetail).toBeNull();
    expect(s.costUsd).toBe(1.2);
    expect(s.agentSummary).toBe("nothing useful");
    // 両後条件メソッドが呼ばれている（残骸→差分の順）
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).toContain("hasUncommittedChanges");
    expect(methods).toContain("hasCommitsWithDiff");
    expect(methods).not.toContain("pushAndOpenPr");
  });

  it("cost_exceeded → updateSession(costUsd) → discardWorktree → stopped(cost_exceeded)。discard が後条件チェックより前に走り、後条件は走らない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 5 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 5.0 }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(5.0);
    expect(s.endedAt).not.toBeNull();
    // discardWorktree が呼ばれた（部分作業破棄）
    expect(h.git.calls).toContainEqual({
      method: "discardWorktree",
      args: ["looppilot/ty-1-x", "/wt/ty-1"],
    });
    // 後条件チェック（hasUncommittedChanges/hasCommitsWithDiff）は走らない
    const methods = h.git.calls.map((c) => c.method);
    expect(methods).not.toContain("hasUncommittedChanges");
    expect(methods).not.toContain("hasCommitsWithDiff");
    // 通知列 run_started → halted(cost_exceeded)
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
  });

  it("agent error outcome → updateSession(costUsd) → stopped(exception, stop_detail=message)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "error", costUsd: 0.3, message: "claude crashed: ENOSPC" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("claude crashed: ENOSPC");
    expect(s.costUsd).toBe(0.3);
  });

  it("agent.runSession 自体が throw → stopped(exception, stop_detail=エラーメッセージ)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    // outcomes を空にすると FakeAgentRunner.runSession が "no outcome queued" を throw する
    h.agent.outcomes = [];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("no outcome queued");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "IMPLEMENT"
```

期待: 全 green。落ちたら Task 12 の `implement()` の順序（cost_exceeded → updateSession(costUsd) → discardWorktree → stopSession / completed → updateSession(costUsd,summary) → hasUncommittedChanges → hasCommitsWithDiff）を仕様 §7.4（カーネル §7 ステップ 4）と突き合わせる。

- [ ] **Step 3: HANDOFF 失敗（handoff_failed の stop_detail に PR 番号明記）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記:

```typescript
describe("Orchestrator 失敗系 — HANDOFF（仕様 §5.4 / カーネル §7.5）", () => {
  it("addLabel が 3 連続 throw → stopped(handoff_failed)。PR は作成済みなので stop_detail に PR 番号を明記する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // pushAndOpenPr は #100 を返す。addLabel をずっと失敗させる（retry 3 回）
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    let addLabelCalls = 0;
    h.git.addLabel = async (prNumber: number, label: string) => {
      addLabelCalls += 1;
      h.git.calls.push({ method: "addLabel", args: [prNumber, label] });
      throw new Error("gh: label not found");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    // PR 番号は即時永続化されている
    expect(s.prNumber).toBe(100);
    // stop_detail に PR #100 が明記される（仕様: 作成済みPRを通知に明記）
    expect(s.stopDetail).toContain("PR #100");
    // addLabel は retry で 3 回呼ばれた
    expect(addLabelCalls).toBe(3);
    // transition(in_review) は addLabel が先に死ぬので呼ばれていない
    expect(h.source.transitions).toEqual([{ issueId: "issue-A", state: "in_progress" }]);
    // 通知列 run_started → halted(handoff_failed)
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "handoff_failed" });
  });

  it("pushAndOpenPr 自体が throw → PR 未作成なので stop_detail は 'no PR created'", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.failNext("pushAndOpenPr", new Error("git push rejected"));

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("handoff_failed");
    expect(s.prNumber).toBeNull();
    expect(s.stopDetail).toContain("no PR created");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "HANDOFF"
```

期待: green。落ちたら Task 12 の `handoff()` の `describePr(this.store.getSession(...).prNumber)` 経路（PR 即時永続化→addLabel/transition の retry→失敗で stopSession(handoff_failed)）を確認する。

> 注: addLabel を差し替えるテストでは `h.git.calls.push` を手動で行う。Task 12 の `FakeGitPr.addLabel` は `takeFailure` 前に calls へ push するが、メソッドごと差し替える本テストでは差し替え側で push を再現する（呼び出し記録の整合性のため）。

- [ ] **Step 4: ここまでの失敗系テスト群をコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator CLAIM/IMPLEMENT/HANDOFF failure paths"
```

- [ ] **Step 5: MONITOR の verdict→stopped 写像（looppilot_stopped の stopReason null 含む・pr_closed・corrupted 即停止）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`monitor.verdicts` の最初の要素を失敗 verdict にすれば、1 回目の poll で確定する（Task 12 の `FakeMonitor.poll` は要素 >1 で shift、=1 で同じものを返す）:

```typescript
describe("Orchestrator 失敗系 — MONITOR verdict 写像（仕様 §5.5 / §5.4 / カーネル §7.6）", () => {
  it("stopped(stopReason='codex gave up') → stopped(looppilot_stopped, stop_detail=stopReason)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: "codex gave up" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("looppilot_stopped");
    expect(s.stopDetail).toBe("codex gave up");
  });

  it("stopped(stopReason=null) → stopped(looppilot_stopped, stop_detail='looppilot stopped (no reason)')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "stopped", stopReason: null }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.failureReason).toBe("looppilot_stopped");
    // null はそのまま保持せず既定文言へ（カーネル §7.6）
    expect(s.stopDetail).toBe("looppilot stopped (no reason)");
  });

  it("pr_closed → stopped(pr_closed, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "pr_closed" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("pr_closed");
    expect(s.stopDetail).toBeNull();
  });

  it("corrupted → 即 stopped(monitor_never_engaged)。ガード経過を待たない（1 回目 poll で停止）", async () => {
    // ガードを 999 分にしても即停止することで「ガードを待たない」ことを確かめる
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 999 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "corrupted" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBe("looppilot-state comment present but corrupted");
    // poll は 1 回だけ（即停止）
    expect(h.monitor.pollCalls).toHaveLength(1);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "MONITOR verdict 写像"
```

期待: 全 green。落ちたら Task 12 の `monitorSession()` の switch を仕様 §7.6（カーネル §7 ステップ 6）と突き合わせる（特に corrupted は `not_engaged` と違いガード経過を**見ずに**即 `stopSession`）。

- [ ] **Step 6: not_engaged ガード経過 / in_progress の monitor_timeout を、`monitorStartedAt` 上書きで決定的にテスト（red→green）**

`fixedClock` は呼ぶ度 +1s なので 30 分等の閾値超過を時刻進行だけでは作りにくい。そこで**テスト内で `monitorStartedAt` を直接過去へ上書き**し、`clock()` が返す時刻（基準 `2026-06-05T00:00:00.000Z` から +1s ずつ）との差を閾値超に仕立てる。Task 12 の `elapsedMinutesSinceMonitorStart` は毎回 `getSession(id).monitorStartedAt` を読み直す（store 由来）ので、poll をフックして poll 前に上書きすれば 1 ポーリングで閾値超過を作れる:

```typescript
describe("Orchestrator 失敗系 — not_engaged ガード / monitor_timeout（仕様 §5.5 / §11 / カーネル §7.6）", () => {
  it("not_engaged かつ経過 > not_engaged_guard_minutes → stopped(monitor_never_engaged, detail=null)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // not_engaged を返し続ける（FakeMonitor は要素 1 のとき同じものを返す）
    h.monitor.verdicts = [{ kind: "not_engaged" }];

    // poll をフックして、poll の直前に monitorStartedAt を「現在 clock より 60 分前」へ上書きする。
    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T23:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("monitor_never_engaged");
    expect(s.stopDetail).toBeNull();
    // 1 回目の poll で経過超過 → 即停止
    expect(h.monitor.pollCalls).toHaveLength(1);
  });

  it("not_engaged かつ経過 <= guard → 続行（停止しない）。経過が閾値内なら poll を繰り返す", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, notEngagedGuardMinutes: 30 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // 1 回目 not_engaged（ガード未経過で続行）→ 2 回目 done → merged で完走
    // monitorStartedAt は上書きしない（clock の進みは数秒なので 30 分閾値を超えない）
    h.monitor.verdicts = [{ kind: "not_engaged" }, { kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ガード内 not_engaged では停止せず、最終的に merged
    expect(s.state).toBe("merged");
    // 少なくとも 2 回 poll した（not_engaged 続行 → done）
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("in_progress かつ monitor_timeout_minutes 設定・total 経過超過 → stopped(exception, 'monitor timeout')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorTimeoutMinutes: 120 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "in_progress" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      // monitorStartedAt を 3 時間前へ（> 120 分）
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-04T21:00:00.000Z" });
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toBe("monitor timeout");
  });

  it("in_progress かつ monitor_timeout 未設定（既定 undefined）→ timeout で止まらず続行する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorTimeoutMinutes: undefined });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // in_progress（経過いくら長くても止まらない）→ done → merged
    h.monitor.verdicts = [{ kind: "in_progress" }, { kind: "done" }, { kind: "merged" }];

    const origPoll = h.monitor.poll.bind(h.monitor);
    h.monitor.poll = async (pr: number) => {
      const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
      h.store.updateSession(s.id, { monitorStartedAt: "2026-06-01T00:00:00.000Z" }); // 何日も前
      return origPoll(pr);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // timeout 未設定なので in_progress では止まらず、done→merged で完走
    expect(s.state).toBe("merged");
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "not_engaged ガード / monitor_timeout"
```

期待: 全 green。落ちたら `elapsedMinutesSinceMonitorStart` が `getSession(id).monitorStartedAt` を毎回読み直す（再起動でリセットしない＝store 由来）こと、`not_engaged` は `> guard`、`in_progress` は `timeout !== undefined && > timeout` の比較になっていることを確認する。

- [ ] **Step 7: poll() throw のバックオフ（5 連続失敗で stopped(exception)）と回復（4 回失敗後に成功で続行）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`h.sleepCalls` で poll 間隔のバックオフ（×2..×8 クランプ）も検証する:

```typescript
describe("Orchestrator 失敗系 — poll throw バックオフ（仕様 §5.5 / カーネル §7.6）", () => {
  it("poll が 5 連続で throw → stopped(exception, 'monitor poll failed 5x: ...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    // verdicts は使わず poll を常に throw させる
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      throw new Error("gh api 502");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("exception");
    expect(s.stopDetail).toContain("monitor poll failed 5x");
    expect(s.stopDetail).toContain("gh api 502");
    // poll は 5 回呼ばれた
    expect(h.monitor.pollCalls).toHaveLength(5);
    // バックオフ: 1回目 sleep=60000、以降 ×2..×8 クランプ。MONITOR の sleep だけ抜き出す。
    // 各反復先頭で sleep(pollIntervalMs * backoffMultiplier)。
    // multiplier 列: 1,2,4,8,8 → sleep 列: 60000,120000,240000,480000,480000
    // （このテストは IDLE に入らない＝queue 1 件・taskCap 3 のため、MONITOR の sleep のみ）
    const base = config.loop.monitorPollSeconds * 1000;
    const monitorSleeps = h.sleepCalls.filter((ms) => ms % base === 0 && ms >= base);
    expect(monitorSleeps.slice(0, 5)).toEqual([
      base * 1,
      base * 2,
      base * 4,
      base * 8,
      base * 8, // ×8 でクランプ
    ]);
  });

  it("poll が 4 回 throw 後に成功（done→merged）→ 停止せず完走し、バックオフは成功でリセットされる", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, monitorPollSeconds: 60 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];

    let n = 0;
    h.monitor.poll = async (pr: number) => {
      h.monitor.pollCalls.push(pr);
      n += 1;
      if (n <= 4) throw new Error("transient 503");
      if (n === 5) return { kind: "done" };
      return { kind: "merged" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 4 連続失敗（<5）なので停止せず、5 回目 done → 6 回目 merged で完走
    expect(s.state).toBe("merged");
    expect(h.monitor.pollCalls.length).toBeGreaterThanOrEqual(6);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "poll throw バックオフ"
```

期待: green。落ちたら Task 12 の `monitorSession()` の `pollFailures`/`backoffMultiplier` 制御（`>= 5` で stopped・成功で両者リセット・`Math.min(backoffMultiplier*2, 8)`）を確認する。

- [ ] **Step 8: MONITOR/poll 失敗系テストをコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator monitor verdict mapping, guards, timeout, poll backoff"
```

- [ ] **Step 9: merge readiness 分岐（ci_failed / conflict / blocked / ci_pending 続行）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`done` verdict → `checkMergeReadiness` の readiness を `h.monitor.readiness` で差し替える:

```typescript
describe("Orchestrator 失敗系 — merge readiness 分岐（仕様 §5.5 / §5.4 readiness / カーネル §7.6）", () => {
  it("done → readiness ci_failed → stopped(ci_failed, detail=null)。mergePr は呼ばれない", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "ci_failed" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBeNull();
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness conflict → stopped(merge_conflict)", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "conflict" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("merge_conflict");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness blocked → stopped(ci_failed, detail='merge blocked by branch protection...')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }];
    h.monitor.readiness.set(100, { ready: false, reason: "blocked" });

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // blocked は failureReason=ci_failed（カーネル §7.6）に写像
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toContain("merge blocked by branch protection");
    expect(h.git.calls.some((c) => c.method === "mergePr")).toBe(false);
  });

  it("done → readiness ci_pending を 1 回 → 次 poll で done→ready→merge し、停止せず完走する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged。readiness: 1回目 ci_pending、2回目 ready
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      if (readinessCall === 1) return { ready: false, reason: "ci_pending" };
      return { ready: true, headSha: "sha-100" };
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // ci_pending では止まらず、2 回目の done で ready→merge→次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-100"] });
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "merge readiness 分岐"
```

期待: green。落ちたら Task 12 の `tryMerge()` の readiness switch（ci_pending/unknown→continue、ci_failed→stopped(ci_failed)、conflict→stopped(merge_conflict)、blocked→stopped(ci_failed, 既定文言)）を仕様 §7.6 と突き合わせる。

> 注: Step 10 で `tryMerge` の戻り値を判別共用体（`{ kind: ... }`）へ変える。本 Step のテストは `mergePr` 呼び出しの有無と最終 state を検証しているだけなので Step 10 後も不変（halt/continue 経路を引き続き通る）。

- [ ] **Step 10: 【コード変更】`tryMerge` を「throw を区別して返す」形に直し、`monitorSession` で mergePr 2 連続 throw を fail-closed にする（red→green）**

> **設計ノート（仕様 §6 「HEAD移動なら見送り（次ポーリング）」と mergePr fail-closed の対応）:** 仕様 §6 のマージ手順は `gh pr merge <pr> --squash --match-head-commit <sha>` であり、「HEAD移動・CI未完なら見送り（次ポーリング）」と規定する。実装上、**§6 の HEAD 移動見送りは `--match-head-commit` の失敗（HEAD が `<sha>` から動いたことで gh が非0終了）= `mergePr` の throw として現れる**。本セクションの fail-closed はこれと整合する: ready verdict 下で mergePr が **1 回目** throw したときは即停止せず次ポーリングで poll→done→`checkMergeReadiness` を再評価する（=§6 の「見送り」。HEAD が動いていれば readiness の headSha が更新され、CI 未完なら ci_pending で続行）。**ready のまま 2 連続** throw したときのみ fail-closed(ci_failed) する。すなわち「HEAD 移動 1 回 → 次ポーリング再評価 ready → mergePr 成功 → merged」が §6 の正常な回復経路であり、下の 3 つ目の it() がそれを固定する。

まず**失敗するテスト**を `tests/orchestrator.test.ts` に追記する（現状の Task 12 実装では `mergePr` throw を握って永遠に続行するため、2 連続でも停止せず別の停止理由で落ちる＝このテストは red）:

```typescript
describe("Orchestrator 失敗系 — mergePr 2 連続 throw fail-closed（カーネル §7.6）", () => {
  it("ready のまま mergePr が 2 連続 throw → stopped(ci_failed, 'merge call failed under ready verdict: <error>')", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll は done を返し続ける（要素 1 → 同じ verdict を維持）。readiness は常に ready（既定）。
    h.monitor.verdicts = [{ kind: "done" }];
    // mergePr を毎回 throw させる
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      throw new Error("gh: merge failed 422");
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("stopped");
    // 2 連続失敗で fail-closed（既定理由 ci_failed）
    expect(s.failureReason).toBe("ci_failed");
    expect(s.stopDetail).toBe("merge call failed under ready verdict: gh: merge failed 422");
    // mergePr は ちょうど 2 回呼ばれて停止（1 回目は続行、2 回目で fail-closed）
    expect(mergeCalls).toBe(2);
  });

  it("mergePr が 1 回 throw → 次 poll(done→ready) で成功 → 完走する（カウンタは成功でリセット）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done → done → merged
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];
    let mergeCalls = 0;
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      mergeCalls += 1;
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      if (mergeCalls === 1) throw new Error("transient 500");
      // 2 回目は成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回失敗 → 2 回目成功 → 次 poll merged で完走（2 連続には達しない）
    expect(s.state).toBe("merged");
    expect(mergeCalls).toBe(2);
  });

  it("§6 HEAD 移動見送り: --match-head-commit 失敗で 1 回 throw → 次ポーリングで readiness 再評価 ready → mergePr 成功 → merged", async () => {
    // 仕様 §6: HEAD 移動なら見送り（次ポーリング）。実装では --match-head-commit 失敗が mergePr の throw として現れ、
    // 1 回目は次ポーリングで done→checkMergeReadiness を再評価する（mergeFailures=1、2 連続未満なので fail-closed しない）。
    // 再評価で新しい headSha の ready が返り、その sha で mergePr が成功 → merged で回復する。
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    // poll: done（1 回目 merge 試行）→ done（再評価して成功）→ merged（DONE へ）
    h.monitor.verdicts = [{ kind: "done" }, { kind: "done" }, { kind: "merged" }];

    // readiness は毎回 ready だが headSha が HEAD 移動で変わる: 1 回目 sha-stale → 2 回目 sha-fresh
    let readinessCall = 0;
    h.monitor.checkMergeReadiness = async (pr: number) => {
      h.monitor.readinessCalls.push(pr);
      readinessCall += 1;
      return readinessCall === 1
        ? { ready: true, headSha: "sha-stale" }
        : { ready: true, headSha: "sha-fresh" };
    };

    // mergePr は --match-head-commit に相当: 渡された headSha が現在の HEAD（sha-fresh）と異なれば throw（HEAD 移動）。
    const mergeShas: string[] = [];
    h.git.mergePr = async (prNumber: number, headSha: string) => {
      h.git.calls.push({ method: "mergePr", args: [prNumber, headSha] });
      mergeShas.push(headSha);
      if (headSha !== "sha-fresh") {
        throw new Error("gh: head commit moved (--match-head-commit failed)");
      }
      // sha-fresh では成功
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 1 回目 sha-stale で throw（見送り）→ 2 回目 sha-fresh で成功 → 次 poll merged で完走
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    // mergePr は 2 回呼ばれ、stale→fresh の順。2 連続失敗には達しないので fail-closed しない。
    expect(mergeShas).toEqual(["sha-stale", "sha-fresh"]);
    // 成功した sha で DONE 経路に入る
    expect(h.git.calls).toContainEqual({ method: "mergePr", args: [100, "sha-fresh"] });
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/orchestrator.test.ts -t "mergePr 2 連続 throw fail-closed"
```

期待される失敗（3 ケース中 1 件目で red）: 1 件目のテストで `s.failureReason` が `ci_failed` にならず（Task 12 実装は throw を握って "continue" を返し続けるため）、別経路（poll の verdict 切れ等）で停止し `expect(s.failureReason).toBe("ci_failed")` が落ちる。2 件目（1 回失敗→成功）と 3 件目（§6 HEAD 移動見送り→回復）は Task 12 実装でも green になり得る（throw を握って続行するため結果的に回復する）が、1 件目が red であることを確認する。

次に **コードを直す**。`src/orchestrator.ts` の `monitorSession` の `case "done"` ブロックと `tryMerge` を以下のとおり置き換える。

(a) `monitorSession` 内ループ冒頭付近の Task 12 の宣言:

```typescript
    let pollFailures = 0;
    let backoffMultiplier = 1;
```

を次に置き換える（**マージ連続失敗カウンタ**を 1 つ足す）:

```typescript
    let pollFailures = 0;
    let backoffMultiplier = 1;
    let mergeFailures = 0; // ready verdict 下での mergePr 連続失敗（2 連続で fail-closed）
```

(b) Task 12 の `case "done"` ブロック:

```typescript
        case "done": {
          const ctrl = await this.tryMerge(session, prNumber);
          if (ctrl === "merged") return CONTINUE;
          if (ctrl === "halt") return HALT;
          continue; // 続行（次ポーリング）
        }
```

を次に置き換える:

```typescript
        case "done": {
          const outcome = await this.tryMerge(session, prNumber);
          if (outcome.kind === "merged") return CONTINUE;
          if (outcome.kind === "halt") return HALT;
          if (outcome.kind === "merge_failed") {
            // ready verdict のまま mergePr が throw。2 連続で fail-closed（カーネル §7.6）。
            mergeFailures += 1;
            if (mergeFailures >= 2) {
              return await this.stopSession(
                session,
                "ci_failed",
                `merge call failed under ready verdict: ${outcome.error}`,
              );
            }
            continue; // 1 回目は次ポーリングで再評価
          }
          // outcome.kind === "continue"（readiness が ci_pending/unknown 等）
          mergeFailures = 0; // ready 連続を断ち切る事象が起きたらリセット
          continue;
        }
```

(c) Task 12 の `tryMerge` 全体:

```typescript
  /** done verdict 時のマージ試行。"merged" | "continue" | "halt" を返す */
  private async tryMerge(session: TaskSessionRow, prNumber: number): Promise<"merged" | "continue" | "halt"> {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return "continue";
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return "halt";
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return "halt";
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return "halt";
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return "merged";
    } catch {
      // 次ポーリングで再評価（mergePr 連続失敗の fail-closed は Task 13 で精密化）
      return "continue";
    }
  }
```

を次に置き換える（戻り値を判別共用体にし、throw を `merge_failed` として上へ返す）:

```typescript
  /**
   * done verdict 時のマージ試行（カーネル §7.6）。
   * - readiness が ready でなければ reason ごとに分類（ci_pending/unknown→continue、その他は stopSession→halt）。
   * - ready なら mergePr。成功→merged。throw→merge_failed（連続回数の判定は monitorSession 側）。
   */
  private async tryMerge(
    session: TaskSessionRow,
    prNumber: number,
  ): Promise<
    | { kind: "merged" }
    | { kind: "continue" }
    | { kind: "halt" }
    | { kind: "merge_failed"; error: string }
  > {
    const readiness = await this.monitor.checkMergeReadiness(prNumber);
    if (!readiness.ready) {
      switch (readiness.reason) {
        case "ci_pending":
        case "unknown":
          return { kind: "continue" };
        case "ci_failed":
          await this.stopSession(session, "ci_failed", null);
          return { kind: "halt" };
        case "conflict":
          await this.stopSession(session, "merge_conflict", null);
          return { kind: "halt" };
        case "blocked":
          await this.stopSession(
            session,
            "ci_failed",
            "merge blocked by branch protection: required reviews/rulesets (mergeStateStatus=BLOCKED with green checks)",
          );
          return { kind: "halt" };
      }
    }
    try {
      await this.git.mergePr(prNumber, readiness.headSha);
      return { kind: "merged" };
    } catch (err) {
      return { kind: "merge_failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
```

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts -t "mergePr 2 連続 throw fail-closed"
```

期待: 3 ケースとも green（fail-closed 2 連続停止 / 1 回失敗→回復 / §6 HEAD 移動見送り→回復）。§6 HEAD 移動見送りのケースは、1 回目 throw で `mergeFailures=1`（2 連続未満）→ `continue`（次ポーリング）→ 再 poll done で readiness 再評価 → 新 headSha(sha-fresh) で `mergePr` 成功 → merged、という回復経路をたどる。`tryMerge` の戻り値型変更は `monitorSession` の `case "done"` 以外から参照されないため他テストに波及しない（Step 9 の readiness 分岐テストも `outcome.kind === "halt"`/`"continue"` 経路を通り引き続き green）。

- [ ] **Step 11: `npm run check` で型・全テスト green を確認し、merge fail-closed をコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`tryMerge` の戻り値が判別共用体に変わったため、`monitorSession` の `case "done"` で `outcome.kind` を網羅していること（merged/halt/merge_failed/continue）を tsc が保証する。

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: fail-closed STOPPED(ci_failed) after two consecutive mergePr throws under ready verdict"
```

- [ ] **Step 12: DONE の transition 3 回失敗でも HALT せず継続（警告ログ・Run=running 維持）のテストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。`transition(done)` だけを失敗させたいので、`source.transition` をフックして state==="done" のときだけ throw させる:

```typescript
describe("Orchestrator 失敗系 — DONE transition 失敗でも継続（仕様 §5.6 / カーネル §7.7）", () => {
  it("transition(done) が 3 回失敗しても HALT せず警告ログのみ・merged は永続化・次 SELECT へ進む", async () => {
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    // transition(done) のみ常に throw（in_progress/in_review は通す）
    const orig = h.source.transition.bind(h.source);
    let doneAttempts = 0;
    h.source.transition = async (issueId: string, state) => {
      if (state === "done") {
        doneAttempts += 1;
        throw new Error("Linear timeout");
      }
      return orig(issueId, state);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // merged は永続化される（DONE は merged 先に永続化 → transition は best-effort）
    expect(s.state).toBe("merged");
    expect(s.endedAt).not.toBeNull();
    expect(h.store.countMerged(run.id)).toBe(1);
    // transition(done) は retry 3 回試みた
    expect(doneAttempts).toBe(3);
    // HALT していない：halted は taskCap 到達由来のみ（looppilot_stopped/exception ではない）
    expect(run.state).toBe("halted"); // taskCap=1 到達で最終的に halted
    expect(run.haltReason).toContain("task cap reached");
    // 通知列に「失敗由来の halted」は無い（run_started → halted(task_cap) のみ）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ reason: "task_cap" });
    // 警告ログが出ている
    expect(h.logs.some((l) => l.includes("warning") && l.includes("transition(done) failed"))).toBe(true);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "DONE transition 失敗でも継続"
```

期待: green。落ちたら Task 12 の `done()` が `retry(3, transition(done))` を try で囲み catch で `log(warning)` のみ・`stopSession` を**呼ばない**（HALT しない）ことを確認する。最終 halted は taskCap=1 到達由来であって failure 由来ではない点に注意（カーネル §7 ステップ 7：DONE の transition 失敗は HALT しない）。

- [ ] **Step 13: STOPPED 共通処理（costUsd 保存・notify(halted)・Run=halted）の不変条件テストを追加（red→green）**

`tests/orchestrator.test.ts` に describe を追記。任意の停止経路（ここでは cost_exceeded）で「セッション=stopped＋failureReason＋endedAt」「Run=halted＋haltReason」「notify(halted) 1 回」が同時に成り立つことを固定する:

```typescript
describe("Orchestrator 失敗系 — STOPPED 共通処理の不変条件（仕様 §7 STOPPED⇒HALT 1:1 / カーネル §7 末尾）", () => {
  it("stopSession を通る経路では『session=stopped+costUsd 保存』『Run=halted』『notify(halted) 1 回』が同時に成立する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3, maxCostUsdPerSession: 8 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    // cost_exceeded 経路（costUsd が判明している経路では併せて保存される）
    h.agent.outcomes = [{ kind: "cost_exceeded", costUsd: 8.0 }];

    await h.orch.run();

    const run = h.store.latestRun()!;
    const s = h.store.sessionsForRun(run.id)[0];
    // セッション側
    expect(s.state).toBe("stopped");
    expect(s.failureReason).toBe("cost_exceeded");
    expect(s.costUsd).toBe(8.0); // costUsd 併せて保存（カーネル §7 STOPPED 共通処理）
    expect(s.endedAt).not.toBeNull();
    // Run 側（TaskSession=stopped ⇒ Run=halted の 1:1）
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("cost_exceeded");
    expect(run.haltReason).toContain("TY-1");
    // notify(halted) はちょうど 1 回
    const haltedEvents = h.notifier.events.filter((e) => e.kind === "halted");
    expect(haltedEvents).toHaveLength(1);
    expect(haltedEvents[0]).toMatchObject({ kind: "halted", reason: "cost_exceeded" });
    // 失敗後はループを脱出し、次の SELECT を試みない（getNextEligible は 1 回だけ）
    expect(h.source.eligibleCalls).toHaveLength(1);
  });

  it("MONITOR 中（in_review→merged 完走）にオーケは PR/ブランチへ書き込まない（マージのみ例外・仕様 §5.5/§4）", async () => {
    // 仕様 §4/§5.5 の不変条件: MONITOR 中はオーケが PR/ブランチへ書き込まない（LoopPilot を唯一の書き手とし、mergePr のみ例外）。
    // 正常完走（done→merged）を回し、monitorSession 突入後の Git/PR 呼び出しが mergePr 以外の書き込み系を含まないことを固定する。
    const config = makeConfig({ maxTasksPerRun: 1 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.git.claimResults.set("TY-1", { branch: "looppilot/ty-1-x", worktreePath: "/wt/ty-1" });
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.git.pushPrNumber.set("looppilot/ty-1-x", 100);
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    expect(s.state).toBe("merged");

    // 全 Git/PR 書き込み系メソッド（FakeGitPr.calls は { method, args } 形式）
    const writeMethods = ["pushAndOpenPr", "addLabel", "prepareWorktree", "discardWorktree"];
    // monitorSession 突入以降に書き込み系が一切呼ばれていないことを確認する。
    // CLAIM/HANDOFF で prepareWorktree/pushAndOpenPr/addLabel は MONITOR 突入「前」に呼ばれ済みなので、
    // 突入の境界＝最後の addLabel（HANDOFF 末尾の書き込み）以降のスライスを見る。
    const lastHandoffWriteIdx = h.git.calls.map((c) => c.method).lastIndexOf("addLabel");
    expect(lastHandoffWriteIdx).toBeGreaterThanOrEqual(0); // HANDOFF で addLabel は呼ばれている
    const afterMonitor = h.git.calls.slice(lastHandoffWriteIdx + 1);
    // MONITOR 中の書き込み系（pushAndOpenPr/addLabel/prepareWorktree/discardWorktree）は 0 件
    expect(afterMonitor.filter((c) => writeMethods.includes(c.method))).toEqual([]);
    // マージのみ例外として許される
    expect(afterMonitor.map((c) => c.method)).toContain("mergePr");

    // 念のため全期間でも: prepareWorktree/pushAndOpenPr/addLabel は各 1 回（CLAIM/HANDOFF のみ）、
    // discardWorktree は 0 回（正常完走では破棄しない）、mergePr は 1 回。
    const counts = (m: string): number => h.git.calls.filter((c) => c.method === m).length;
    expect(counts("prepareWorktree")).toBe(1);
    expect(counts("pushAndOpenPr")).toBe(1);
    expect(counts("addLabel")).toBe(1);
    expect(counts("discardWorktree")).toBe(0);
    expect(counts("mergePr")).toBe(1);
  });
});
```

実行:

```
npx vitest run tests/orchestrator.test.ts -t "STOPPED 共通処理の不変条件"
```

期待: 2 ケースとも green（STOPPED 共通不変条件 1 ケース + MONITOR 書き込み不変条件 1 ケース）。後者はコード変更なしの既 green 確認（Task 12 の monitorSession は `mergePr` 以外の書き込み系を呼ばない設計）。落ちたら Task 12 の `stopSession()`（updateSession(stopped, failureReason, stopDetail, endedAt, extraPatch.costUsd) → notify(halted) → setRunState(halted) → return HALT）と、`run()`/`loop()` が HALT で `return` してループを抜けること、および `monitorSession`/`tryMerge` が MONITOR 中に `pushAndOpenPr`/`addLabel`/`prepareWorktree`/`discardWorktree` を呼ばない（マージのみ例外）ことを仕様 §4/§5.5 と突き合わせる。MONITOR 中に書き込み系が呼ばれていたら仕様 §5.5 違反として openQuestions に上げる（勝手に直さない）。

- [ ] **Step 14: MONITOR/merge/DONE/STOPPED 系テストをコミット**

```
git add tests/orchestrator.test.ts
git commit -m "test: Orchestrator merge readiness, DONE best-effort, STOPPED invariants"
```

- [ ] **Step 15: 【コード変更】SIGINT/停止要求フラグを Orchestrator に追加（red→green）**

まず**失敗するテスト**を `tests/orchestrator.test.ts` に追記する（現状 `Orchestrator` に `requestStop` が無いため、tsc が型エラーで red）:

```typescript
describe("Orchestrator 安全弁 — SIGINT/停止要求フラグ（仕様 §11 / カーネル §7 末尾）", () => {
  it("requestStop() を実装フェーズで立てると、現フェーズ群完了後の次の安全点で Run=halted(user_interrupt) して停止する", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1"), issue("issue-B", "TY-2")];
    h.agent.outcomes = [
      { kind: "completed", costUsd: 1, summary: "A ok" },
      { kind: "completed", costUsd: 1, summary: "B ok" },
    ];
    h.monitor.verdicts = [
      { kind: "done" },
      { kind: "merged" },
      { kind: "done" },
      { kind: "merged" },
    ];

    // 1 件目の IMPLEMENT 中に停止要求を立てる（次の安全点まで現フェーズ群は完了させる）
    const origRun = h.agent.runSession.bind(h.agent);
    let agentCalls = 0;
    h.agent.runSession = async (ctx) => {
      agentCalls += 1;
      if (agentCalls === 1) h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const run = h.store.latestRun()!;
    const sessions = h.store.sessionsForRun(run.id);
    // 1 件目は現フェーズ群を完走して merged になる（安全点までは止めない）
    expect(sessions).toHaveLength(1);
    expect(sessions[0].linearIdentifier).toBe("TY-1");
    expect(sessions[0].state).toBe("merged");
    // 2 件目は着手しない（次反復先頭の安全点で停止）
    expect(h.agent.contexts).toHaveLength(1);
    // Run=halted、理由は user_interrupt
    expect(run.state).toBe("halted");
    expect(run.haltReason).toContain("user_interrupt");
    // 通知列: run_started → halted(user_interrupt)。失敗 stopped ではない（セッションは merged）
    expect(h.notifier.events.map((e) => e.kind)).toEqual(["run_started", "halted"]);
    expect(h.notifier.events[1]).toMatchObject({ kind: "halted", reason: "user_interrupt" });
  });

  it("requestStop() 後でも進行中セッションは stopped にならず merged のまま（クリーン停止）", async () => {
    const config = makeConfig({ maxTasksPerRun: 3 });
    const h = makeHarness(config);
    h.source.queue = [issue("issue-A", "TY-1")];
    h.agent.outcomes = [{ kind: "completed", costUsd: 1, summary: "ok" }];
    h.monitor.verdicts = [{ kind: "done" }, { kind: "merged" }];

    const origRun = h.agent.runSession.bind(h.agent);
    h.agent.runSession = async (ctx) => {
      h.orch.requestStop();
      return origRun(ctx);
    };

    await h.orch.run();

    const s = h.store.sessionsForRun(h.store.latestRun()!.id)[0];
    // 現セッションは完走（merged）。stopped にしない。
    expect(s.state).toBe("merged");
    expect(s.failureReason).toBeNull();
    expect(h.store.latestRun()!.state).toBe("halted");
    expect(h.store.latestRun()!.haltReason).toContain("user_interrupt");
  });
});
```

実行して **red を確認**する:

```
npx vitest run tests/orchestrator.test.ts -t "SIGINT/停止要求フラグ"
```

期待される失敗: tsc が `Property 'requestStop' does not exist on type 'Orchestrator'` を報告（`npm run check` の tsc-test 段、または vitest 実行時に `h.orch.requestStop is not a function`）。

次に **コードを直す**。`src/orchestrator.ts` の `Orchestrator` クラスに以下を追加する。

(a) フィールド宣言。Task 12 の `private runId = 0;` の直後に 1 行足す:

```typescript
  private runId = 0;
  private interrupted = false; // SIGINT 等の停止要求（次の安全点で halt）
```

(b) public メソッド `requestStop` を追加する。`run()` メソッドの直前（コンストラクタの後）に挿入する:

```typescript
  /** 停止要求を立てる（SIGINT ハンドラ等から呼ぶ）。次の安全点でクリーン halt する。 */
  requestStop(): void {
    this.interrupted = true;
  }
```

(c) 安全点チェックを `loop()` に挿入する。Task 12 の `loop()` の while 冒頭、タスク上限チェックの**直前**に停止要求の確認を足す。Task 12 の:

```typescript
  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
```

を次に置き換える:

```typescript
  private async loop(): Promise<void> {
    let idleNotified = false;
    while (true) {
      // 0) 停止要求の安全点（各反復先頭。現フェーズ群完了後にここへ戻る）
      if (this.interrupted) {
        this.haltForInterrupt();
        return;
      }

      // 1) タスク上限チェック（仕様 §11 / §5 SELECT 末尾）
      const started = this.store.countTasksStarted(this.runId);
```

(d) 停止要求の共通 halt ヘルパ `haltForInterrupt` を追加する。`stopSession` メソッドの直後に挿入する（クラス内・private）:

```typescript
  /** 停止要求による Run レベルのクリーン halt（セッションは stopped にしない）。 */
  private haltForInterrupt(): void {
    const detail = "user_interrupt: stop requested; halting at safe point";
    this.store.setRunState(this.runId, "halted", detail);
    void this.notifier.notify({ kind: "halted", reason: "user_interrupt", detail });
    this.log(detail);
  }
```

> 設計注: `haltForInterrupt` は同期メソッドにして `loop()` から同期的に `return` させ、ロック解放（`run()` の finally）へ即進む。通知の確実性より「安全点での即時停止」を優先し、`notify` は fire-and-forget（`void`）とする。FakeNotifier は同期 push なのでテストでは確定的に記録される。Slack 配信の確実性は通知 intent（Store）側が担保する設計（カーネル §10 / §4 notification_intent）であり、ここで await しないことは仕様と矛盾しない。HALT 理由語彙は `Run.haltReason`（自由文字列。`FailureReason` enum とは別）なので `"user_interrupt"` の文字列を使うのは型上問題ない。

実行して green を確認する:

```
npx vitest run tests/orchestrator.test.ts -t "SIGINT/停止要求フラグ"
```

期待: 両テスト green。1 件目は IMPLEMENT 中に `requestStop()` を立てても現セッションは MONITOR/DONE まで完走し（安全点は次反復の先頭）、2 件目着手前の安全点で `haltForInterrupt`→`return`。セッションは merged のまま・Run=halted(user_interrupt)。

- [ ] **Step 16: `npm run check` で型・全テスト green を確認し、SIGINT フラグをコミット**

```
npm run check
```

期待: tsc（src）・tsc（tests）・vitest 全 green。`requestStop`/`interrupted`/`haltForInterrupt` 追加で既存正常系テスト（Task 12）に波及しないこと（`interrupted` 既定 false なので安全点は素通し）を確認する。

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: SIGINT-driven clean halt at next safe point (requestStop)"
```

- [ ] **Step 17: 失敗系の網羅性を確認する最終 `npm run check` と仕上げコミット**

```
npm run check
```

期待: 全 green。本タスクで追加した失敗系 describe（CLAIM ①②／IMPLEMENT 5 ケース／HANDOFF 2 ケース／MONITOR verdict 写像 4 ケース／not_engaged・timeout 4 ケース／poll backoff 2 ケース／merge readiness 4 ケース／mergePr fail-closed 3 ケース［2 連続停止／1 回で回復／§6 HEAD 移動見送り→回復］／DONE 継続 1 ケース／STOPPED 不変条件 1 ケース＋MONITOR 書き込み不変条件 1 ケース／SIGINT 2 ケース）が全て pass。カーネル §7 の各失敗経路と仕様 §4/§5.5/§6 の不変条件が 1 つ以上のテストで固定されていること。

未コミット差分があれば:

```
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "chore: finalize Orchestrator failure-path and safety-valve coverage"
```

---

#### このタスクの完了条件

- `src/orchestrator.ts` の `tryMerge` が判別共用体（`merged`/`continue`/`halt`/`merge_failed`）を返し、`monitorSession` が `ready` verdict 下での `mergePr` **2 連続 throw** で `stopped(ci_failed, "merge call failed under ready verdict: <error>")` に fail-closed する（カーネル §7.6）。
- `src/orchestrator.ts` が public `requestStop()` を持ち、`interrupted` フラグを各反復先頭の安全点で見て `haltForInterrupt()`（Run=halted(user_interrupt)・notify(halted)・進行中セッションは stopped にしない）→ ループ脱出する（カーネル §7 末尾）。
- `tests/orchestrator.test.ts` がカーネル §7 の全失敗経路を固定する: CLAIM ①（セッション行なし HALT）／②（discardWorktree+stopped(claim_failed)+todo 復帰）、agent_no_change（未コミット残骸／無差分の 2 形）、cost_exceeded（discardWorktree 順）、exception（error outcome／runSession throw）、handoff_failed（PR 番号明記／PR 未作成）、looppilot_stopped（stopReason あり／null）、pr_closed、corrupted（即停止）、monitor_never_engaged（not_engaged ガード経過）、monitor timeout（設定時／未設定時）、poll throw バックオフ（5 連続停止／4 回後回復）、merge readiness（ci_failed／conflict／blocked／ci_pending 続行）、mergePr 2 連続 throw fail-closed（停止／1 回で回復／§6 HEAD 移動見送り→回復）、DONE transition 3 回失敗でも継続、STOPPED 共通不変条件、SIGINT 安全点停止。
- 仕様 §4/§5.5/§6 の不変条件をテストで固定する: MONITOR 中はオーケが PR/ブランチへ書き込まない（`mergePr` のみ例外。monitorSession 完走後の `FakeGitPr` コール記録が `pushAndOpenPr`/`addLabel`/`prepareWorktree`/`discardWorktree` を含まない）、および §6 HEAD 移動見送り（`--match-head-commit` 失敗の throw → 1 回目は次ポーリングで readiness 再評価 → ready なら新 headSha で `mergePr` 成功 → merged の回復経路）。
- 全テストは `fixedClock`/`instantSleep`＋テスト内の `monitorStartedAt` 上書きで時間決定的。`vi.mock` 不使用（フェイクのメソッド差し替えのみ）。
- `npm run check` が green。
- 既存シンボル（`Orchestrator`/`OrchestratorDeps`/各フェイク/`makeConfig`/`issue`/`makeHarness`/`Harness`）は再定義せず Modify した。
