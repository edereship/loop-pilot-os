import Database from "better-sqlite3";
import type {
  RunRow,
  RunState,
  SessionState,
  FailureReason,
  TaskSessionRow,
  PauseMeta,
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
  pending_restart_reason TEXT
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
  };
}

interface RawSessionRow {
  id: number;
  run_id: number;
  linear_issue_id: string;
  linear_identifier: string;
  issue_title: string;
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
  pending_restart_reason: string | null;
}
function toSessionRow(r: RawSessionRow): TaskSessionRow {
  return {
    id: r.id,
    runId: r.run_id,
    linearIssueId: r.linear_issue_id,
    linearIdentifier: r.linear_identifier,
    issueTitle: r.issue_title,
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
    pendingRestartReason: r.pending_restart_reason,
  };
}

// ---- updateSession の patch キー → DB 列名の対応（部分更新の SET 句生成に使う） ----
const SESSION_PATCH_COLUMNS: Record<string, string> = {
  state: "state",
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
  pendingRestartReason: "pending_restart_reason",
};

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
    branch: string;
    worktreePath: string;
    now: string;
  }): TaskSessionRow {
    const info = this.db
      .prepare(
        `INSERT INTO task_session
           (run_id, linear_issue_id, linear_identifier, issue_title,
            branch, worktree_path, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(
        s.runId,
        s.linearIssueId,
        s.linearIdentifier,
        s.issueTitle,
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
        | "pendingRestartReason"
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
           AND id IN (SELECT MAX(id) FROM task_session GROUP BY linear_issue_id)
         ORDER BY id ASC`,
      )
      .all(failureReason) as RawSessionRow[];
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
}
