import Database from "better-sqlite3";
import type {
  RunRow,
  RunState,
  SessionState,
  FailureReason,
  TaskSessionRow,
  PauseMeta,
  GroomLogRow,
  GroomOutcome,
  ScoutLogRow,
  ScoutOutcome,
  MergeGateLogRow,
  MergeGateOutcome,
  DesignReviewLogRow,
  DesignReviewOutcome,
  SelfReviewLogRow,
  SelfReviewOutcome,
  VerifyLogRow,
  VerifyOutcome,
} from "./types.js";

// ---- カーネル §4 のスキーマ（一字一句） ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  task_cap INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','idle','halted','paused')),
  halt_reason TEXT,
  pause_meta TEXT
);
CREATE TABLE IF NOT EXISTS task_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  linear_issue_id TEXT NOT NULL,
  linear_identifier TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  issue_url TEXT NOT NULL DEFAULT '',
  issue_description TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL,
  worktree_path TEXT,
  pr_number INTEGER,
  state TEXT NOT NULL CHECK (state IN
    ('claimed','implementing','handing_off','in_review','merged','stopped')),
  cost_usd REAL,
  failure_reason TEXT,
  stop_detail TEXT,
  agent_summary TEXT,
  plan_brief TEXT,
  select_rationale TEXT,
  started_at TEXT NOT NULL,
  monitor_started_at TEXT,
  ended_at TEXT,
  workflow_fix_attempts INTEGER NOT NULL DEFAULT 0,
  workflow_handled_error_count INTEGER NOT NULL DEFAULT 0,
  auto_restart_attempts INTEGER NOT NULL DEFAULT 0,
  quota_retry_attempts INTEGER NOT NULL DEFAULT 0,
  pending_restart_reason TEXT,
  recovery_attempted INTEGER NOT NULL DEFAULT 0,
  recovery_action TEXT,
  done_transition_pending INTEGER NOT NULL DEFAULT 0,
  needs_human_label_added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_active ON task_session(state)
  WHERE state NOT IN ('merged','stopped');
CREATE TABLE IF NOT EXISTS notification_intent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivered_console INTEGER NOT NULL DEFAULT 0,
  delivered_slack INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS groom_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  loop_index INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  actions_requested INTEGER NOT NULL DEFAULT 0,
  actions_executed INTEGER NOT NULL DEFAULT 0,
  actions_rejected INTEGER NOT NULL DEFAULT 0,
  action_details TEXT,
  outcome TEXT CHECK (outcome IN ('completed','skipped','error')),
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS design_review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  session_id INTEGER NOT NULL REFERENCES task_session(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  verdict TEXT CHECK (verdict IN ('approve','reject')),
  reasons TEXT,
  outcome TEXT CHECK (outcome IN ('approved','rejected','error')),
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS self_review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  session_id INTEGER NOT NULL REFERENCES task_session(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  verdict TEXT CHECK (verdict IN ('pass','fail')),
  issue_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  outcome TEXT CHECK (outcome IN ('passed','fixed','failed','error')),
  cost_usd REAL,
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS verify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  session_id INTEGER NOT NULL REFERENCES task_session(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  verdict TEXT CHECK (verdict IN ('pass','fail')),
  reason_count INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  outcome TEXT CHECK (outcome IN ('passed','failed','error')),
  cost_usd REAL,
  error_detail TEXT,
  verified_head_sha TEXT
);
CREATE TABLE IF NOT EXISTS merge_gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  session_id INTEGER NOT NULL REFERENCES task_session(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  verdict TEXT CHECK (verdict IN ('pass','fail')),
  signals TEXT,
  violations TEXT,
  outcome TEXT CHECK (outcome IN ('passed','fixed','parked','skipped','error')),
  cost_usd REAL,
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS scout_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id),
  fired_at TEXT NOT NULL,
  ended_at TEXT,
  candidates TEXT,
  verdicts TEXT,
  created_issue_ids TEXT,
  outcome TEXT CHECK (outcome IN ('completed','skipped','error')),
  cost_usd REAL,
  error_detail TEXT
);
CREATE TABLE IF NOT EXISTS run_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);
`;

// ---- DB の生 row（snake_case）→ ドメイン型（camelCase）マッピング ----
interface RawRunRow {
  id: number;
  started_at: string;
  task_cap: number;
  state: string;
  halt_reason: string | null;
  pause_meta: string | null;
  idle_started_at: string | null;
}
function parsePauseMeta(raw: string | null): PauseMeta | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PauseMeta;
  } catch {
    return null;
  }
}
function toRunRow(r: RawRunRow): RunRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    taskCap: r.task_cap,
    state: r.state as RunState,
    haltReason: r.halt_reason,
    pauseMeta: parsePauseMeta(r.pause_meta),
    idleStartedAt: r.idle_started_at,
  };
}

interface RawSessionRow {
  id: number;
  run_id: number;
  linear_issue_id: string;
  linear_identifier: string;
  issue_title: string;
  issue_url: string;
  issue_description: string;
  branch: string;
  worktree_path: string | null;
  pr_number: number | null;
  state: string;
  cost_usd: number | null;
  failure_reason: string | null;
  stop_detail: string | null;
  agent_summary: string | null;
  plan_brief: string | null;
  select_rationale: string | null;
  started_at: string;
  monitor_started_at: string | null;
  ended_at: string | null;
  workflow_fix_attempts: number;
  workflow_handled_error_count: number;
  auto_restart_attempts: number;
  quota_retry_attempts: number;
  pending_restart_reason: string | null;
  recovery_attempted: number;
  recovery_action: string | null;
  done_transition_pending: number;
  needs_human_label_added: number;
  design_review_attempts: number;
  self_review_cost_usd: number | null;
  verify_attempts: number;
  recovery_turn_attempts: number;
  handoff_head_sha: string | null;
}
function toSessionRow(r: RawSessionRow): TaskSessionRow {
  return {
    id: r.id,
    runId: r.run_id,
    linearIssueId: r.linear_issue_id,
    linearIdentifier: r.linear_identifier,
    issueTitle: r.issue_title,
    issueUrl: r.issue_url,
    issueDescription: r.issue_description,
    branch: r.branch,
    worktreePath: r.worktree_path,
    prNumber: r.pr_number,
    state: r.state as SessionState,
    costUsd: r.cost_usd,
    failureReason: r.failure_reason as FailureReason | null,
    stopDetail: r.stop_detail,
    agentSummary: r.agent_summary,
    planBrief: r.plan_brief,
    selectRationale: r.select_rationale,
    startedAt: r.started_at,
    monitorStartedAt: r.monitor_started_at,
    endedAt: r.ended_at,
    workflowFixAttempts: r.workflow_fix_attempts,
    workflowHandledErrorCount: r.workflow_handled_error_count,
    autoRestartAttempts: r.auto_restart_attempts,
    quotaRetryAttempts: r.quota_retry_attempts,
    pendingRestartReason: r.pending_restart_reason,
    recoveryAttempted: r.recovery_attempted,
    recoveryAction: r.recovery_action,
    doneTransitionPending: r.done_transition_pending,
    needsHumanLabelAdded: r.needs_human_label_added,
    designReviewAttempts: r.design_review_attempts,
    selfReviewCostUsd: r.self_review_cost_usd,
    verifyAttempts: r.verify_attempts,
    recoveryTurnAttempts: r.recovery_turn_attempts,
    handoffHeadSha: r.handoff_head_sha,
  };
}

interface RawGroomLogRow {
  id: number;
  run_id: number;
  loop_index: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  actions_requested: number;
  actions_executed: number;
  actions_rejected: number;
  action_details: string | null;
  outcome: string | null;
  error_detail: string | null;
}
function toGroomLogRow(r: RawGroomLogRow): GroomLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    loopIndex: r.loop_index,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    summary: r.summary,
    actionsRequested: r.actions_requested,
    actionsExecuted: r.actions_executed,
    actionsRejected: r.actions_rejected,
    actionDetails: r.action_details,
    outcome: r.outcome as GroomOutcome | null,
    errorDetail: r.error_detail,
  };
}

interface RawMergeGateLogRow {
  id: number;
  run_id: number;
  session_id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  signals: string | null;
  violations: string | null;
  outcome: string | null;
  cost_usd: number | null;
  error_detail: string | null;
}
function toMergeGateLogRow(r: RawMergeGateLogRow): MergeGateLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    verdict: r.verdict as "pass" | "fail" | null,
    signals: r.signals,
    violations: r.violations,
    outcome: r.outcome as MergeGateOutcome | null,
    costUsd: r.cost_usd,
    errorDetail: r.error_detail,
  };
}

interface RawScoutLogRow {
  id: number;
  run_id: number;
  fired_at: string;
  ended_at: string | null;
  candidates: string | null;
  verdicts: string | null;
  created_issue_ids: string | null;
  outcome: string | null;
  cost_usd: number | null;
  error_detail: string | null;
}
function toScoutLogRow(r: RawScoutLogRow): ScoutLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    firedAt: r.fired_at,
    endedAt: r.ended_at,
    candidates: r.candidates,
    verdicts: r.verdicts,
    createdIssueIds: r.created_issue_ids,
    outcome: r.outcome as ScoutOutcome | null,
    costUsd: r.cost_usd,
    errorDetail: r.error_detail,
  };
}

interface RawDesignReviewLogRow {
  id: number;
  run_id: number;
  session_id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  reasons: string | null;
  outcome: string | null;
  error_detail: string | null;
}
function toDesignReviewLogRow(r: RawDesignReviewLogRow): DesignReviewLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    verdict: r.verdict,
    reasons: r.reasons,
    outcome: r.outcome as DesignReviewOutcome | null,
    errorDetail: r.error_detail,
  };
}

interface RawSelfReviewLogRow {
  id: number;
  run_id: number;
  session_id: number;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  issue_count: number;
  summary: string | null;
  outcome: string | null;
  cost_usd: number | null;
  error_detail: string | null;
}
function toSelfReviewLogRow(r: RawSelfReviewLogRow): SelfReviewLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    verdict: r.verdict as "pass" | "fail" | null,
    issueCount: r.issue_count,
    summary: r.summary,
    outcome: r.outcome as SelfReviewOutcome | null,
    costUsd: r.cost_usd,
    errorDetail: r.error_detail,
  };
}

interface RawVerifyLogRow {
  id: number;
  run_id: number;
  session_id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  reason_count: number;
  evidence: string | null;
  outcome: string | null;
  cost_usd: number | null;
  error_detail: string | null;
  verified_head_sha: string | null;
}
function toVerifyLogRow(r: RawVerifyLogRow): VerifyLogRow {
  return {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    verdict: r.verdict as "pass" | "fail" | null,
    reasonCount: r.reason_count,
    evidence: r.evidence,
    outcome: r.outcome as VerifyOutcome | null,
    costUsd: r.cost_usd,
    errorDetail: r.error_detail,
    verifiedHeadSha: r.verified_head_sha,
  };
}

// ---- patch キー → DB 列名の対応（部分更新の SET 句生成に使う） ----
const GROOM_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  summary: "summary",
  actionsRequested: "actions_requested",
  actionsExecuted: "actions_executed",
  actionsRejected: "actions_rejected",
  actionDetails: "action_details",
  outcome: "outcome",
  errorDetail: "error_detail",
};
const SESSION_PATCH_COLUMNS: Record<string, string> = {
  state: "state",
  issueUrl: "issue_url",
  worktreePath: "worktree_path",
  prNumber: "pr_number",
  costUsd: "cost_usd",
  failureReason: "failure_reason",
  stopDetail: "stop_detail",
  agentSummary: "agent_summary",
  planBrief: "plan_brief",
  selectRationale: "select_rationale",
  monitorStartedAt: "monitor_started_at",
  endedAt: "ended_at",
  runId: "run_id",
  workflowFixAttempts: "workflow_fix_attempts",
  workflowHandledErrorCount: "workflow_handled_error_count",
  autoRestartAttempts: "auto_restart_attempts",
  quotaRetryAttempts: "quota_retry_attempts",
  pendingRestartReason: "pending_restart_reason",
  recoveryAttempted: "recovery_attempted",
  recoveryAction: "recovery_action",
  doneTransitionPending: "done_transition_pending",
  designReviewAttempts: "design_review_attempts",
  selfReviewCostUsd: "self_review_cost_usd",
  verifyAttempts: "verify_attempts",
  recoveryTurnAttempts: "recovery_turn_attempts",
  handoffHeadSha: "handoff_head_sha",
};
const DESIGN_REVIEW_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  verdict: "verdict",
  reasons: "reasons",
  outcome: "outcome",
  errorDetail: "error_detail",
};
const SELF_REVIEW_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  verdict: "verdict",
  issueCount: "issue_count",
  summary: "summary",
  outcome: "outcome",
  costUsd: "cost_usd",
  errorDetail: "error_detail",
};
const VERIFY_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  verdict: "verdict",
  reasonCount: "reason_count",
  evidence: "evidence",
  outcome: "outcome",
  costUsd: "cost_usd",
  errorDetail: "error_detail",
  verifiedHeadSha: "verified_head_sha",
};

const MERGE_GATE_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  verdict: "verdict",
  signals: "signals",
  violations: "violations",
  outcome: "outcome",
  costUsd: "cost_usd",
  errorDetail: "error_detail",
};

const SCOUT_LOG_PATCH_COLUMNS: Record<string, string> = {
  endedAt: "ended_at",
  candidates: "candidates",
  verdicts: "verdicts",
  createdIssueIds: "created_issue_ids",
  outcome: "outcome",
  costUsd: "cost_usd",
  errorDetail: "error_detail",
};

// needs-human 終端（人間のトリアージ待ちで SELECT から除外すべきセッション）の共有述語。
// abandon 完了(recovery_action='abandon')に加え、abandon を経ない終端 reason を列挙する。
// 3 クエリ（excludedIssueIds / legacyExcludedIssueIds / markNeedsHumanLabelAddedByIssueId）は
// この述語を必ず共有すること — 片方だけ更新すると legacy 検出と bit 更新が非同期になり、
// ラベルを外してもチケットが恒久除外される（ES-521 レビュー所見）。
const NEEDS_HUMAN_TERMINAL_PREDICATE =
  `(recovery_action = 'abandon' OR failure_reason IN ('design_rejected', 'merge_gate_failed'))`;

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // WAL 化。:memory: では no-op（journal_mode=memory が返る）。
    // ファイル DB で稀に失敗しても致命ではないので握り潰す（カーネル §4）。
    try {
      this.db.pragma("journal_mode = WAL");
    } catch {
      // ignore: WAL is a best-effort optimization
    }
    // 別プロセスとの書込み競合時に即 SQLITE_BUSY で失敗せず待つ
    // （acquireRunLock の BEGIN IMMEDIATE をプロセス間で直列化するため）。
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("user_version = 1");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 既存 DB へのスキーマ追従（ES-397）。
   * `CREATE TABLE IF NOT EXISTS` は既存 task_session に列を追加しないため、
   * workflow-recovery 導入前に作られた DB は古い列構成のまま残る。その状態で
   * updateSession が workflow_fix_attempts / workflow_handled_error_count を書くと
   * `no such column` で失敗する。欠けている列だけを冪等に ALTER TABLE で補う。
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(task_session)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!columns.has("workflow_fix_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN workflow_fix_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("workflow_handled_error_count")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN workflow_handled_error_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("quota_retry_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN quota_retry_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("auto_restart_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN auto_restart_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("pending_restart_reason")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN pending_restart_reason TEXT`,
      );
    }
    if (!columns.has("plan_brief")) {
      this.db.exec(`ALTER TABLE task_session ADD COLUMN plan_brief TEXT`);
    }
    if (!columns.has("select_rationale")) {
      this.db.exec(`ALTER TABLE task_session ADD COLUMN select_rationale TEXT`);
    }
    if (!columns.has("recovery_attempted")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN recovery_attempted INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("recovery_action")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN recovery_action TEXT`,
      );
    }
    if (!columns.has("done_transition_pending")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN done_transition_pending INTEGER NOT NULL DEFAULT 0`,
      );
      // Backfill all pre-ES-462 merged rows so the startup recovery loop will
      // retry transition(done) for any that failed before the flag existed.
      // Calling transition(done) on an already-done ticket is idempotent in Linear.
      this.db.exec(
        `UPDATE task_session SET done_transition_pending = 1 WHERE state = 'merged'`,
      );
    }
    if (!columns.has("design_review_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN design_review_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("self_review_cost_usd")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN self_review_cost_usd REAL`,
      );
    }
    if (!columns.has("verify_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("recovery_turn_attempts")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN recovery_turn_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("issue_url")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN issue_url TEXT NOT NULL DEFAULT ''`,
      );
    }
    if (!columns.has("needs_human_label_added")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN needs_human_label_added INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!columns.has("issue_description")) {
      this.db.exec(
        `ALTER TABLE task_session ADD COLUMN issue_description TEXT NOT NULL DEFAULT ''`,
      );
    }
    if (!columns.has("handoff_head_sha")) {
      this.db.exec(`ALTER TABLE task_session ADD COLUMN handoff_head_sha TEXT`);
    }

    const runColumns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(run)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!runColumns.has("pause_meta")) {
      // pause_meta 追加と同時に CHECK 制約を ('running','idle','halted','paused') へ更新する。
      // SQLite は ALTER CONSTRAINT 非対応のためテーブル再作成が必要。
      // Wrap in an explicit transaction so the recreate/copy/drop/rename sequence
      // is all-or-nothing: a mid-migration crash cannot leave an empty run table
      // with the data stranded in run_new.
      const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
      this.db.pragma("foreign_keys = OFF");
      try {
        const runMigration = this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE run_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              started_at TEXT NOT NULL,
              task_cap INTEGER NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('running','idle','halted','paused')),
              halt_reason TEXT,
              pause_meta TEXT
            );
            INSERT INTO run_new (id, started_at, task_cap, state, halt_reason)
              SELECT id, started_at, task_cap, state, halt_reason FROM run;
            DROP TABLE run;
            ALTER TABLE run_new RENAME TO run;
          `);
        });
        runMigration();
      } finally {
        this.db.pragma(`foreign_keys = ${fkWasOn}`);
      }
    }

    if (!runColumns.has("idle_started_at")) {
      this.db.exec(`ALTER TABLE run ADD COLUMN idle_started_at TEXT`);
    }

    const verifyLogColumns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(verify_log)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!verifyLogColumns.has("verified_head_sha")) {
      this.db.exec(`ALTER TABLE verify_log ADD COLUMN verified_head_sha TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- run ----
  createRun(taskCap: number, now: string): RunRow {
    const info = this.db
      .prepare(
        `INSERT INTO run (started_at, task_cap, state, halt_reason)
         VALUES (?, ?, 'running', NULL)`,
      )
      .run(now, taskCap);
    return this.getRun(Number(info.lastInsertRowid));
  }

  getRun(id: number): RunRow {
    const row = this.db
      .prepare(`SELECT * FROM run WHERE id = ?`)
      .get(id) as RawRunRow | undefined;
    if (row === undefined) {
      throw new Error(`run not found: id=${id}`);
    }
    return toRunRow(row);
  }

  latestRun(): RunRow | null {
    const row = this.db
      .prepare(`SELECT * FROM run ORDER BY id DESC LIMIT 1`)
      .get() as RawRunRow | undefined;
    return row === undefined ? null : toRunRow(row);
  }

  setRunState(id: number, state: RunState, haltReason?: string): void {
    const info = this.db
      .prepare(`UPDATE run SET state = ?, halt_reason = ?, pause_meta = NULL WHERE id = ?`)
      .run(state, haltReason ?? null, id);
    if (info.changes !== 1) {
      throw new Error(`setRunState affected ${info.changes} rows for run id=${id}`);
    }
  }

  setPauseMeta(id: number, meta: PauseMeta): void {
    const info = this.db
      .prepare(`UPDATE run SET state = 'paused', pause_meta = ? WHERE id = ?`)
      .run(JSON.stringify(meta), id);
    if (info.changes !== 1) {
      throw new Error(`setPauseMeta affected ${info.changes} rows for run id=${id}`);
    }
  }

  clearPauseMeta(id: number): void {
    const info = this.db
      .prepare(`UPDATE run SET state = 'running', pause_meta = NULL WHERE id = ?`)
      .run(id);
    if (info.changes !== 1) {
      throw new Error(`clearPauseMeta affected ${info.changes} rows for run id=${id}`);
    }
  }

  setIdleStartedAt(id: number, isoTimestamp: string): void {
    this.db.prepare(
      `UPDATE run SET idle_started_at = ? WHERE id = ? AND idle_started_at IS NULL`,
    ).run(isoTimestamp, id);
  }

  clearIdleStartedAt(id: number): void {
    this.db.prepare(
      `UPDATE run SET idle_started_at = NULL WHERE id = ?`,
    ).run(id);
  }

  countTasksStarted(runId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM task_session WHERE run_id = ?`)
      .get(runId) as { c: number };
    return row.c;
  }

  countMerged(runId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM task_session WHERE run_id = ? AND state = 'merged'`,
      )
      .get(runId) as { c: number };
    return row.c;
  }

  // ---- session ----
  createSession(s: {
    runId: number;
    linearIssueId: string;
    linearIdentifier: string;
    issueTitle: string;
    issueUrl?: string;
    issueDescription?: string;
    branch: string;
    worktreePath: string;
    now: string;
  }): TaskSessionRow {
    const info = this.db
      .prepare(
        `INSERT INTO task_session
           (run_id, linear_issue_id, linear_identifier, issue_title, issue_url,
            issue_description, branch, worktree_path, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(
        s.runId,
        s.linearIssueId,
        s.linearIdentifier,
        s.issueTitle,
        s.issueUrl ?? "",
        s.issueDescription ?? "",
        s.branch,
        s.worktreePath,
        s.now,
      );
    return this.getSession(Number(info.lastInsertRowid));
  }

  getSession(id: number): TaskSessionRow {
    const row = this.db
      .prepare(`SELECT * FROM task_session WHERE id = ?`)
      .get(id) as RawSessionRow | undefined;
    if (row === undefined) {
      throw new Error(`task_session not found: id=${id}`);
    }
    return toSessionRow(row);
  }

  updateSession(
    id: number,
    patch: Partial<
      Pick<
        TaskSessionRow,
        | "state"
        | "issueUrl"
        | "worktreePath"
        | "prNumber"
        | "costUsd"
        | "failureReason"
        | "stopDetail"
        | "agentSummary"
        | "planBrief"
        | "selectRationale"
        | "monitorStartedAt"
        | "endedAt"
        | "runId"
        | "workflowFixAttempts"
        | "workflowHandledErrorCount"
        | "autoRestartAttempts"
        | "quotaRetryAttempts"
        | "pendingRestartReason"
        | "recoveryAttempted"
        | "recoveryAction"
        | "doneTransitionPending"
        | "designReviewAttempts"
        | "selfReviewCostUsd"
        | "verifyAttempts"
        | "recoveryTurnAttempts"
        | "handoffHeadSha"
      >
    >,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = SESSION_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateSession: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      // undefined はそもそも Object.keys に来ない想定だが、明示キー undefined は NULL 扱いにしない
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) {
      return; // 空 patch は no-op
    }
    values.push(id);
    const info = this.db
      .prepare(`UPDATE task_session SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(
        `updateSession affected ${info.changes} rows for session id=${id}`,
      );
    }
  }

  activeSessions(): TaskSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_session
         WHERE state NOT IN ('merged','stopped')
         ORDER BY id ASC`,
      )
      .all() as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  stoppedSessionsWithPr(failureReason: FailureReason): TaskSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_session
         WHERE state = 'stopped' AND failure_reason = ? AND pr_number IS NOT NULL
           AND (recovery_action IS NULL OR recovery_action != 'abandon')
           AND id IN (SELECT MAX(id) FROM task_session GROUP BY linear_issue_id)
         ORDER BY id ASC`,
      )
      .all(failureReason) as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  /**
   * Stopped sessions with a PR where Codex recovery was attempted but its action failed.
   * Requires the recovery-failure marker in stop_detail so that historical sessions whose
   * recovery_attempted defaulted to 0 during migration are not retried (ES-450 Finding 4).
   * Excludes cost_exceeded (terminal) and looppilot_stopped (handled by stoppedSessionsWithPr).
   * pr_closed is NOT excluded: a partial abandon that failed at ticket revert leaves
   * failure_reason='pr_closed' with a recovery-failed stop_detail and recovery_attempted=0;
   * the stop_detail LIKE filter below limits inclusion to only sessions with recovery markers,
   * and isPartialAbandon in stopSession detects these for retry (ES-450 Finding 3).
   */
  stoppedSessionsWithFailedRecovery(): TaskSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_session
         WHERE state = 'stopped'
           AND pr_number IS NOT NULL
           AND recovery_attempted = 0
           AND failure_reason NOT IN ('cost_exceeded', 'looppilot_stopped')
           AND (recovery_action IS NULL OR recovery_action != 'abandon')
           AND (stop_detail LIKE '%(recovery failed:%' OR stop_detail LIKE 'recovery failed:%'
                OR stop_detail LIKE 'abandon_in_progress%')
           AND id IN (SELECT MAX(id) FROM task_session GROUP BY linear_issue_id)
         ORDER BY id ASC`,
      )
      .all() as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  sessionsWithPendingDoneTransition(): TaskSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_session
         WHERE state = 'merged' AND done_transition_pending = 1
           AND id IN (SELECT MAX(id) FROM task_session GROUP BY linear_issue_id)
         ORDER BY id ASC`,
      )
      .all() as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  activeIssueIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT linear_issue_id AS id FROM task_session
         WHERE state NOT IN ('merged','stopped')`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  excludedIssueIds(runId: number): string[] {
    // Current-run guard (ES-492 Finding 2): defense-in-depth when addLabel fails transiently
    // within this run — blocks re-selection for the remainder of the run when the label was
    // NOT successfully applied (needs_human_label_added=0). When the label WAS applied
    // (needs_human_label_added=1), the Linear label is the authority: if an operator removes
    // the label during the current run, the ticket becomes eligible again immediately.
    // needs-human 終端述語は NEEDS_HUMAN_TERMINAL_PREDICATE を共有（同期必須）。
    const rows = this.db
      .prepare(
        `SELECT DISTINCT linear_issue_id AS id FROM task_session
         WHERE run_id = ?
           AND state = 'stopped'
           AND ${NEEDS_HUMAN_TERMINAL_PREDICATE}
           AND needs_human_label_added = 0`,
      )
      .all(runId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  legacyExcludedIssueIds(): string[] {
    // Cross-run legacy guard (ES-492 Finding 3): issues whose LATEST session is stopped/abandoned
    // and where the needs-human label was never successfully applied (needs_human_label_added=0).
    // This covers pre-ES-492 sessions and post-ES-492 transient addLabel failures, ensuring they
    // stay excluded until either:
    //   a) the operator manually adds the label (detected by getAllEligible → onLegacyLabelDetected
    //      callback flips needs_human_label_added=1) and then removes it to requeue, OR
    //   b) the session is superseded by a newer one.
    // Kept separate from excludedIssueIds so that getAllEligible can check the Linear label FIRST
    // for legacy-excluded issues and detect manual label additions (ES-492 Finding 3).
    // needs-human 終端述語は NEEDS_HUMAN_TERMINAL_PREDICATE を共有（同期必須）。
    const rows = this.db
      .prepare(
        `SELECT ts.linear_issue_id AS id
         FROM task_session ts
         WHERE ts.state = 'stopped'
           AND ${NEEDS_HUMAN_TERMINAL_PREDICATE}
           AND ts.needs_human_label_added = 0
           AND ts.id = (
             SELECT MAX(id) FROM task_session WHERE linear_issue_id = ts.linear_issue_id
           )`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  markNeedsHumanLabelAdded(sessionId: number): void {
    this.db
      .prepare(`UPDATE task_session SET needs_human_label_added = 1 WHERE id = ?`)
      .run(sessionId);
  }

  markNeedsHumanLabelAddedByIssueId(issueId: string): void {
    // Flip needs_human_label_added=1 for the latest stopped/abandoned session for this issue.
    // Called by getAllEligible's onLegacyLabelDetected callback when the operator manually adds
    // the needs-human label to a legacy-excluded issue, so that a subsequent label removal
    // re-enables the ticket (ES-492 Finding 3).
    // needs-human 終端述語は NEEDS_HUMAN_TERMINAL_PREDICATE を共有（同期必須）。
    this.db
      .prepare(
        `UPDATE task_session SET needs_human_label_added = 1
         WHERE linear_issue_id = ?
           AND state = 'stopped'
           AND ${NEEDS_HUMAN_TERMINAL_PREDICATE}
           AND id = (SELECT MAX(id) FROM task_session WHERE linear_issue_id = ?)`,
      )
      .run(issueId, issueId);
  }

  knownIssueIds(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT linear_issue_id AS id FROM task_session`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  recentMergedSummaries(
    n: number,
  ): Array<
    Pick<TaskSessionRow, "linearIdentifier" | "issueTitle" | "agentSummary">
  > {
    const rows = this.db
      .prepare(
        `SELECT linear_identifier, issue_title, agent_summary
         FROM task_session
         WHERE state = 'merged'
         ORDER BY ended_at DESC, id DESC
         LIMIT ?`,
      )
      .all(n) as Array<{
      linear_identifier: string;
      issue_title: string;
      agent_summary: string | null;
    }>;
    return rows.map((r) => ({
      linearIdentifier: r.linear_identifier,
      issueTitle: r.issue_title,
      agentSummary: r.agent_summary,
    }));
  }

  recentSessionSummaries(
    n: number,
  ): Array<{
    linearIdentifier: string;
    issueTitle: string;
    state: "merged" | "stopped";
    costUsd: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT linear_identifier, issue_title, state, cost_usd
         FROM task_session
         WHERE state IN ('merged', 'stopped')
         ORDER BY ended_at DESC, id DESC
         LIMIT ?`,
      )
      .all(n) as Array<{
      linear_identifier: string;
      issue_title: string;
      state: "merged" | "stopped";
      cost_usd: number | null;
    }>;
    return rows.map((r) => ({
      linearIdentifier: r.linear_identifier,
      issueTitle: r.issue_title,
      state: r.state,
      costUsd: r.cost_usd,
    }));
  }

  lastMergedWithPr(): TaskSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_session
         WHERE state = 'merged' AND pr_number IS NOT NULL
         ORDER BY ended_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as RawSessionRow | undefined;
    return row === undefined ? null : toSessionRow(row);
  }

  sessionsForRun(runId: number): TaskSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_session WHERE run_id = ? ORDER BY id ASC`,
      )
      .all(runId) as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  recentSessions(n: number): TaskSessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_session ORDER BY id DESC LIMIT ?`)
      .all(n) as RawSessionRow[];
    return rows.map(toSessionRow);
  }

  // ---- notification intents ----
  recordIntent(payload: string, slackConfigured: boolean, now: string): number {
    // Slack 未設定なら delivered_slack=1（=配信不要）で記録（カーネル §4）
    const deliveredSlack = slackConfigured ? 0 : 1;
    const info = this.db
      .prepare(
        `INSERT INTO notification_intent
           (created_at, payload, delivered_console, delivered_slack, attempts)
         VALUES (?, ?, 0, ?, 0)`,
      )
      .run(now, payload, deliveredSlack);
    return Number(info.lastInsertRowid);
  }

  markDelivered(id: number, channel: "console" | "slack"): void {
    const column =
      channel === "console" ? "delivered_console" : "delivered_slack";
    const info = this.db
      .prepare(`UPDATE notification_intent SET ${column} = 1 WHERE id = ?`)
      .run(id);
    if (info.changes !== 1) {
      throw new Error(
        `markDelivered affected ${info.changes} rows for intent id=${id}`,
      );
    }
  }

  bumpAttempts(id: number): void {
    const info = this.db
      .prepare(
        `UPDATE notification_intent SET attempts = attempts + 1 WHERE id = ?`,
      )
      .run(id);
    if (info.changes !== 1) {
      throw new Error(
        `bumpAttempts affected ${info.changes} rows for intent id=${id}`,
      );
    }
  }

  undeliveredIntents(): Array<{
    id: number;
    payload: string;
    attempts: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, payload, attempts FROM notification_intent
         WHERE delivered_console = 0 OR delivered_slack = 0
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; payload: string; attempts: number }>;
    return rows;
  }

  // ---- run lock（単一インスタンス）----
  acquireRunLock(
    pid: number,
    isPidAlive: (pid: number) => boolean,
    now: string,
  ): boolean {
    // read(SELECT)→liveness 判定→write(UPSERT) を BEGIN IMMEDIATE で原子化する。
    // 非トランザクションだと 2 プロセスが共に空を読んで共にロック取得し（TOCTOU）、
    // 単一インスタンス前提（仕様 §3/§5.1）が破れる。IMMEDIATE は開始時に write ロックを
    // 取り、後発プロセスを busy_timeout まで待たせて直列化する。
    const acquire = this.db.transaction((): boolean => {
      const existing = this.db
        .prepare(`SELECT pid FROM run_lock WHERE id = 1`)
        .get() as { pid: number } | undefined;

      if (existing !== undefined) {
        // 自 pid のロックは冪等に奪える。別 pid は生存中なら奪わない。
        if (existing.pid !== pid && isPidAlive(existing.pid)) {
          return false;
        }
      }

      // 空・自 pid・死んだ保持者 → 奪取（id=1 行を upsert）
      this.db
        .prepare(
          `INSERT INTO run_lock (id, pid, acquired_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at`,
        )
        .run(pid, now);
      return true;
    });
    return acquire.immediate();
  }

  releaseRunLock(pid: number): void {
    // 自分が保持しているロックだけ解放する（他 pid の解放は no-op）
    this.db
      .prepare(`DELETE FROM run_lock WHERE id = 1 AND pid = ?`)
      .run(pid);
  }

  // ---- groom_log (ES-451) ----
  insertGroomLog(s: {
    runId: number;
    loopIndex: number;
    startedAt: string;
  }): GroomLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO groom_log (run_id, loop_index, started_at)
         VALUES (?, ?, ?)`,
      )
      .run(s.runId, s.loopIndex, s.startedAt);
    return this.getGroomLog(Number(info.lastInsertRowid));
  }

  getGroomLog(id: number): GroomLogRow {
    const row = this.db
      .prepare(`SELECT * FROM groom_log WHERE id = ?`)
      .get(id) as RawGroomLogRow | undefined;
    if (row === undefined) {
      throw new Error(`groom_log not found: id=${id}`);
    }
    return toGroomLogRow(row);
  }

  updateGroomLog(
    id: number,
    patch: Partial<Pick<GroomLogRow,
      | "endedAt"
      | "summary"
      | "actionsRequested"
      | "actionsExecuted"
      | "actionsRejected"
      | "actionDetails"
      | "outcome"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = GROOM_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateGroomLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE groom_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateGroomLog affected ${info.changes} rows for id=${id}`);
    }
  }

  // ---- merge_gate_log (ES-514) ----
  insertMergeGateLog(s: {
    runId: number;
    sessionId: number;
    attempt: number;
    startedAt: string;
  }): MergeGateLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO merge_gate_log (run_id, session_id, attempt, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(s.runId, s.sessionId, s.attempt, s.startedAt);
    return this.getMergeGateLog(Number(info.lastInsertRowid));
  }

  getMergeGateLog(id: number): MergeGateLogRow {
    const row = this.db
      .prepare(`SELECT * FROM merge_gate_log WHERE id = ?`)
      .get(id) as RawMergeGateLogRow | undefined;
    if (row === undefined) {
      throw new Error(`merge_gate_log not found: id=${id}`);
    }
    return toMergeGateLogRow(row);
  }

  updateMergeGateLog(
    id: number,
    patch: Partial<Pick<MergeGateLogRow,
      | "endedAt"
      | "verdict"
      | "signals"
      | "violations"
      | "outcome"
      | "costUsd"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = MERGE_GATE_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateMergeGateLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE merge_gate_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateMergeGateLog affected ${info.changes} rows for id=${id}`);
    }
  }

  /** ES-521: セッションのゲート判定履歴（id 昇順）。fix attempt 上限の耐久カウントに使う。 */
  getMergeGateLogsForSession(sessionId: number): MergeGateLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM merge_gate_log WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId) as RawMergeGateLogRow[];
    return rows.map(toMergeGateLogRow);
  }

  // ---- scout_log (ES-516) ----
  insertScoutLog(s: { runId: number; firedAt: string }): ScoutLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO scout_log (run_id, fired_at)
         VALUES (?, ?)`,
      )
      .run(s.runId, s.firedAt);
    return this.getScoutLog(Number(info.lastInsertRowid));
  }

  getScoutLog(id: number): ScoutLogRow {
    const row = this.db
      .prepare(`SELECT * FROM scout_log WHERE id = ?`)
      .get(id) as RawScoutLogRow | undefined;
    if (row === undefined) {
      throw new Error(`scout_log not found: id=${id}`);
    }
    return toScoutLogRow(row);
  }

  updateScoutLog(
    id: number,
    patch: Partial<Pick<ScoutLogRow,
      | "endedAt"
      | "candidates"
      | "verdicts"
      | "createdIssueIds"
      | "outcome"
      | "costUsd"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = SCOUT_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateScoutLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE scout_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateScoutLog affected ${info.changes} rows for id=${id}`);
    }
  }

  /**
   * 前回 SCOUT 発火時刻（run 横断のグローバル MAX・ES-516）。
   * min_interval_hours 判定用。ISO-8601 文字列は辞書順 = 時系列順のため MAX で正しい。
   * 一度も発火していなければ null。
   */
  latestScoutFiredAt(): string | null {
    const row = this.db
      .prepare(`SELECT MAX(fired_at) AS latest FROM scout_log`)
      .get() as { latest: string | null };
    return row.latest;
  }

  // ---- design_review_log (ES-477) ----
  insertDesignReviewLog(s: {
    runId: number;
    sessionId: number;
    attempt: number;
    startedAt: string;
  }): DesignReviewLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO design_review_log (run_id, session_id, attempt, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(s.runId, s.sessionId, s.attempt, s.startedAt);
    return this.getDesignReviewLog(Number(info.lastInsertRowid));
  }

  getDesignReviewLog(id: number): DesignReviewLogRow {
    const row = this.db
      .prepare(`SELECT * FROM design_review_log WHERE id = ?`)
      .get(id) as RawDesignReviewLogRow | undefined;
    if (row === undefined) {
      throw new Error(`design_review_log not found: id=${id}`);
    }
    return toDesignReviewLogRow(row);
  }

  updateDesignReviewLog(
    id: number,
    patch: Partial<Pick<DesignReviewLogRow,
      | "endedAt"
      | "verdict"
      | "reasons"
      | "outcome"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = DESIGN_REVIEW_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateDesignReviewLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE design_review_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateDesignReviewLog affected ${info.changes} rows for id=${id}`);
    }
  }

  // ---- self_review_log (ES-473) ----
  insertSelfReviewLog(s: {
    runId: number;
    sessionId: number;
    startedAt: string;
  }): SelfReviewLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO self_review_log (run_id, session_id, started_at)
         VALUES (?, ?, ?)`,
      )
      .run(s.runId, s.sessionId, s.startedAt);
    return this.getSelfReviewLog(Number(info.lastInsertRowid));
  }

  getSelfReviewLog(id: number): SelfReviewLogRow {
    const row = this.db
      .prepare(`SELECT * FROM self_review_log WHERE id = ?`)
      .get(id) as RawSelfReviewLogRow | undefined;
    if (row === undefined) {
      throw new Error(`self_review_log not found: id=${id}`);
    }
    return toSelfReviewLogRow(row);
  }

  updateSelfReviewLog(
    id: number,
    patch: Partial<Pick<SelfReviewLogRow,
      | "endedAt"
      | "verdict"
      | "issueCount"
      | "summary"
      | "outcome"
      | "costUsd"
      | "errorDetail"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = SELF_REVIEW_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateSelfReviewLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE self_review_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateSelfReviewLog affected ${info.changes} rows for id=${id}`);
    }
  }

  getSelfReviewLogsForSession(sessionId: number): SelfReviewLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM self_review_log WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId) as RawSelfReviewLogRow[];
    return rows.map(toSelfReviewLogRow);
  }

  // ---- verify_log (ES-487) ----
  insertVerifyLog(s: {
    runId: number;
    sessionId: number;
    attempt: number;
    startedAt: string;
  }): VerifyLogRow {
    const info = this.db
      .prepare(
        `INSERT INTO verify_log (run_id, session_id, attempt, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(s.runId, s.sessionId, s.attempt, s.startedAt);
    return this.getVerifyLog(Number(info.lastInsertRowid));
  }

  getVerifyLog(id: number): VerifyLogRow {
    const row = this.db
      .prepare(`SELECT * FROM verify_log WHERE id = ?`)
      .get(id) as RawVerifyLogRow | undefined;
    if (row === undefined) {
      throw new Error(`verify_log not found: id=${id}`);
    }
    return toVerifyLogRow(row);
  }

  updateVerifyLog(
    id: number,
    patch: Partial<Pick<VerifyLogRow,
      | "endedAt"
      | "verdict"
      | "reasonCount"
      | "evidence"
      | "outcome"
      | "costUsd"
      | "errorDetail"
      | "verifiedHeadSha"
    >>,
  ): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = VERIFY_LOG_PATCH_COLUMNS[key as string];
      if (column === undefined) {
        throw new Error(`updateVerifyLog: unknown patch key "${String(key)}"`);
      }
      const raw = patch[key];
      if (raw === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(raw as string | number | null);
    }
    if (setClauses.length === 0) return;
    values.push(id);
    const info = this.db
      .prepare(`UPDATE verify_log SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...values);
    if (info.changes !== 1) {
      throw new Error(`updateVerifyLog affected ${info.changes} rows for id=${id}`);
    }
  }

  getVerifyLogsForSession(sessionId: number): VerifyLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM verify_log WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId) as RawVerifyLogRow[];
    return rows.map(toVerifyLogRow);
  }
}
