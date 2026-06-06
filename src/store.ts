import Database from "better-sqlite3";
import type {
  RunRow,
  RunState,
  SessionState,
  FailureReason,
  TaskSessionRow,
} from "./types.js";

// ---- カーネル §4 のスキーマ（一字一句） ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  task_cap INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','idle','halted')),
  halt_reason TEXT
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
  started_at TEXT NOT NULL,
  monitor_started_at TEXT,
  ended_at TEXT
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
}
function toRunRow(r: RawRunRow): RunRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    taskCap: r.task_cap,
    state: r.state as RunState,
    haltReason: r.halt_reason,
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
  started_at: string;
  monitor_started_at: string | null;
  ended_at: string | null;
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
    startedAt: r.started_at,
    monitorStartedAt: r.monitor_started_at,
    endedAt: r.ended_at,
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
  monitorStartedAt: "monitor_started_at",
  endedAt: "ended_at",
  runId: "run_id",
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
    this.db.pragma("user_version = 1");
    this.db.exec(SCHEMA);
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
      .prepare(`UPDATE run SET state = ?, halt_reason = ? WHERE id = ?`)
      .run(state, haltReason ?? null, id);
    if (info.changes !== 1) {
      throw new Error(`setRunState affected ${info.changes} rows for run id=${id}`);
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
        | "monitorStartedAt"
        | "endedAt"
        | "runId"
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
}
