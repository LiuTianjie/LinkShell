import { DatabaseSync, type StatementSync } from "node:sqlite";
import { basename } from "node:path";
import type {
  ProjectSummary,
  SessionDriver,
  SessionEvent,
  SessionState,
  SessionSummary,
  SessionUpdate,
} from "@linkshell/wire";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  native_id TEXT NOT NULL,
  title TEXT,
  preview TEXT,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  driver TEXT,
  pending_permissions INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_updated ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_by_updated_id ON sessions (updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_meta (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  opens_turn INTEGER NOT NULL DEFAULT 0,
  tool TEXT,
  parent TEXT,
  spawns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_meta_by_kind ON event_meta (session_id, kind, seq);
CREATE TABLE IF NOT EXISTS logged_items (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS driver_state (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agent_state (
  agent TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (agent, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS client_messages (
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, client_message_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS removed_sessions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS worktrees (
  path TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  source TEXT NOT NULL,
  source_cwd TEXT NOT NULL,
  base TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  command TEXT,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  active_at INTEGER NOT NULL,
  exit_code INTEGER,
  ended INTEGER NOT NULL DEFAULT 0,
  buffer TEXT NOT NULL DEFAULT ''
);
-- Original control sequences and geometry are needed to recover image and
-- keyboard state that a text-only screen serializer cannot represent.
CREATE TABLE IF NOT EXISTS terminal_frames (
  terminal_id TEXT NOT NULL,
  frame INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (terminal_id, frame)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS terminal_snapshots (
  terminal_id TEXT PRIMARY KEY,
  frame INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
`;

export interface TerminalRecord {
  id: string;
  cwd: string;
  title: string;
  command?: string;
  cols: number;
  rows: number;
  createdAt: number;
  activeAt: number;
  exitCode: number | null;
  ended: boolean;
  buffer: string;
  /** The session it was opened for, if any. */
  sessionId?: string;
}

interface SessionRow {
  id: string;
  agent: string;
  native_id: string;
  title: string | null;
  preview: string | null;
  cwd: string;
  state: string;
  driver: string | null;
  pending_permissions: number;
  model: string | null;
  created_at: number;
  updated_at: number;
  last_seq: number;
  archived: number;
  custom_title: string | null;
}

export interface SessionInsert {
  id: string;
  agent: string;
  nativeId: string;
  cwd: string;
  title?: string;
  preview?: string;
  state?: SessionState;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export type SessionPatch = Partial<{
  title: string | null;
  preview: string | null;
  cwd: string;
  state: SessionState;
  driver: SessionDriver | null;
  pendingPermissions: number;
  model: string | null;
  updatedAt: number;
  archived: boolean;
  customTitle: string | null;
}>;

const PATCH_COLUMNS: Record<keyof SessionPatch, string> = {
  title: "title",
  preview: "preview",
  cwd: "cwd",
  state: "state",
  driver: "driver",
  pendingPermissions: "pending_permissions",
  model: "model",
  updatedAt: "updated_at",
  archived: "archived",
  customTitle: "custom_title",
};

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    agent: row.agent,
    nativeId: row.native_id,
    // A name given in LinkShell wins over the agent's own.
    title: row.custom_title ?? row.title ?? undefined,
    preview: row.preview ?? undefined,
    cwd: row.cwd,
    state: row.state as SessionState,
    driver: (row.driver ?? undefined) as SessionDriver | undefined,
    pendingPermissions: row.pending_permissions,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
    archived: row.archived === 1,
  };
}

/** A git worktree made for sessions (see worktrees.ts). */
export interface WorktreeRecord {
  /** The worktree's top directory. */
  path: string;
  branch: string;
  /** The repository's top directory. */
  source: string;
  /** The directory the first session in it was started from (a project, possibly inside the repository). */
  sourceCwd: string;
  /** The commit it started at. */
  base: string;
  createdAt: number;
}

/** The worktree `cwd` is in, if any. */
export function worktreeOf(cwd: string, worktrees: WorktreeRecord[]): WorktreeRecord | undefined {
  // Either separator: Windows paths use backslashes.
  return worktrees.find((worktree) => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`) || cwd.startsWith(`${worktree.path}\\`));
}

/** The project a session in `cwd` belongs to: for a worktree, the directory it was made from. */
function projectOf(cwd: string, worktrees: WorktreeRecord[]): string {
  return worktreeOf(cwd, worktrees)?.sourceCwd ?? cwd;
}

/**
 * How much history one page carries (see `pageStart`). Events are counted as a client shows
 * them: the next piece of a message or thought streamed in pieces (one per token, thousands in a
 * long turn) joins the one before, so it adds bytes but no event.
 */
export interface PageBudget {
  /** A page goes back whole turns until it has this many events or bytes… */
  minEvents: number;
  minBytes: number;
  /** …and never more than this: inside one turn, when the newest turn alone is bigger. */
  maxEvents: number;
  maxBytes: number;
  /** What one event counts for at most: its size as sent, not as stored. */
  eventBytes: number;
  /** What sending any event adds to its own size: the notification around it. */
  eventOverhead: number;
}

export const PAGE: PageBudget = { minEvents: 120, minBytes: 384 * 1024, maxEvents: 600, maxBytes: 2 * 1024 * 1024, eventBytes: 40 * 1024, eventOverhead: 160 };

/** Updates streamed in pieces: consecutive ones of a kind are one message or thought to a client. */
const STREAMED = new Set(["agent_message_chunk", "agent_thought_chunk"]);
const STREAMED_SQL = [...STREAMED].map((kind) => `'${kind}'`).join(", ");

interface MetaRow {
  seq: number;
  kind: string;
  bytes: number;
  opens_turn: number;
  parent: string | null;
}

/** The next piece of the message or thought `before` is part of (`before` is the row just before it). */
function continuesStream(row: MetaRow, before: MetaRow | undefined): boolean {
  return !!before && STREAMED.has(row.kind) && before.kind === row.kind && before.parent === row.parent;
}

function isHistoryLoadError(update: SessionUpdate | undefined): boolean {
  return update?.sessionUpdate === "ls_error" && update.message.startsWith("读取会话消息失败：") && update.hint === "重新打开会话可重试";
}

const VISIBLE_SESSION_WHERE =
  "NOT EXISTS (SELECT 1 FROM driver_state WHERE session_id = sessions.id AND key = 'native-missing' AND value = '1')";

interface PreparedStatements {
  isRemoved: StatementSync;
  getSession: StatementSync;
  insertSession: StatementSync;
  listSessionsActive: StatementSync;
  listSessionsActiveBefore: StatementSync;
  listSessionsActiveCursor: StatementSync;
  listSessionsAll: StatementSync;
  listSessionsAllBefore: StatementSync;
  listSessionsAllCursor: StatementSync;
  sessionsForAgent: StatementSync;
  selectLastSeq: StatementSync;
  insertEvent: StatementSync;
  insertEventMeta: StatementSync;
  updateSessionSeq: StatementSync;
  readEvents: StatementSync;
  sizeAfter: StatementSync;
  pageStartBatch: StatementSync;
  markItemLogged: StatementSync;
  isItemLogged: StatementSync;
  claimClientMessage: StatementSync;
  releaseClientMessage: StatementSync;
  getDriverState: StatementSync;
  setDriverState: StatementSync;
  deleteDriverState: StatementSync;
  getAgentState: StatementSync;
  setAgentState: StatementSync;
  clearAgentState: StatementSync;
  saveTerminal: StatementSync;
  appendTerminalFrame: StatementSync;
  lastTerminalFrame: StatementSync;
  saveTerminalSnapshot: StatementSync;
  terminalSnapshot: StatementSync;
  terminalFrameCandidates: StatementSync;
  terminalFramesRange: StatementSync;
  hasBusySession: StatementSync;
}

/**
 * Durable host state: session summaries plus one append-only event log per
 * session. Every update a client sees gets a per-session `seq`, so a client
 * that reconnects asks for "everything after seq N" and gets exactly that.
 */
export class HostStore {
  private readonly db: DatabaseSync;
  private readonly stmts: PreparedStatements;
  private closed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
    this.stmts = this.prepareStatements();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Columns added after the first release. */
  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("custom_title")) this.db.exec("ALTER TABLE sessions ADD COLUMN custom_title TEXT");
    const terminalColumns = new Set((this.db.prepare("PRAGMA table_info(terminals)").all() as { name: string }[]).map((c) => c.name));
    if (!terminalColumns.has("session_id")) this.db.exec("ALTER TABLE terminals ADD COLUMN session_id TEXT");
    // event_meta came later (and its sub-agent columns later still): describe
    // the events logged before it, once.
    const meta = new Set((this.db.prepare("PRAGMA table_info(event_meta)").all() as { name: string }[]).map((c) => c.name));
    if (!meta.has("tool")) {
      this.db.exec("ALTER TABLE event_meta ADD COLUMN tool TEXT; ALTER TABLE event_meta ADD COLUMN parent TEXT; ALTER TABLE event_meta ADD COLUMN spawns INTEGER NOT NULL DEFAULT 0;");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS sessions_by_updated_id ON sessions (updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS event_meta_by_tool ON event_meta (session_id, tool, seq) WHERE tool IS NOT NULL;
      CREATE INDEX IF NOT EXISTS event_meta_by_parent ON event_meta (session_id, parent, seq) WHERE parent IS NOT NULL;
      CREATE INDEX IF NOT EXISTS event_meta_spawns ON event_meta (session_id, seq) WHERE spawns = 1;
    `);
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version < 2) {
      this.db.exec(`
        INSERT OR REPLACE INTO event_meta (session_id, seq, kind, bytes, opens_turn, tool, parent, spawns)
        SELECT session_id, seq, COALESCE(json_extract(body, '$.sessionUpdate'), ''), length(CAST(body AS BLOB)),
          CASE json_extract(body, '$.sessionUpdate')
            WHEN 'user_message_chunk' THEN 1
            WHEN 'ls_turn' THEN COALESCE(json_extract(body, '$.state') = 'started' AND json_extract(body, '$.parentToolCallId') IS NULL, 0)
            ELSE 0 END,
          json_extract(body, '$.toolCallId'),
          json_extract(body, '$.parentToolCallId'),
          COALESCE(json_extract(body, '$.sessionUpdate') = 'tool_call' AND json_extract(body, '$.detail.type') = 'subagent'
            AND COALESCE(json_extract(body, '$.detail.action'), 'spawn') = 'spawn', 0)
        FROM events;
        PRAGMA user_version = 2;
      `);
    }
  }

  private prepareStatements(): PreparedStatements {
    return {
      isRemoved: this.db.prepare("SELECT 1 FROM removed_sessions WHERE id = ?"),
      getSession: this.db.prepare("SELECT * FROM sessions WHERE id = ?"),
      insertSession: this.db.prepare(
        `INSERT INTO sessions (id, agent, native_id, title, preview, cwd, state, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      listSessionsActive: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE} AND archived = 0
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      listSessionsActiveBefore: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE} AND archived = 0 AND updated_at < ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      listSessionsActiveCursor: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE} AND archived = 0
           AND (updated_at < ? OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      listSessionsAll: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      listSessionsAllBefore: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE} AND updated_at < ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      listSessionsAllCursor: this.db.prepare(
        `SELECT * FROM sessions WHERE ${VISIBLE_SESSION_WHERE}
           AND (updated_at < ? OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ),
      sessionsForAgent: this.db.prepare("SELECT * FROM sessions WHERE agent = ?"),
      selectLastSeq: this.db.prepare("SELECT last_seq FROM sessions WHERE id = ?"),
      insertEvent: this.db.prepare("INSERT INTO events (session_id, seq, ts, body) VALUES (?, ?, ?, ?)"),
      insertEventMeta: this.db.prepare(
        "INSERT INTO event_meta (session_id, seq, kind, bytes, opens_turn, tool, parent, spawns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      updateSessionSeq: this.db.prepare("UPDATE sessions SET last_seq = ?, updated_at = MAX(updated_at, ?) WHERE id = ?"),
      readEvents: this.db.prepare(
        "SELECT seq, ts, body FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
      ),
      sizeAfter: this.db.prepare(
        `SELECT COALESCE(SUM(NOT (kind IN (${STREAMED_SQL}) AND kind IS before_kind AND parent IS before_parent)), 0) AS events,
                COALESCE(SUM(bytes), 0) + COUNT(*) * ? AS bytes
         FROM (SELECT kind, parent, bytes, LAG(kind) OVER (ORDER BY seq) AS before_kind, LAG(parent) OVER (ORDER BY seq) AS before_parent
               FROM event_meta WHERE session_id = ? AND seq > ?)`,
      ),
      pageStartBatch: this.db.prepare(
        "SELECT seq, kind, bytes, opens_turn, parent FROM event_meta WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?",
      ),
      markItemLogged: this.db.prepare("INSERT OR IGNORE INTO logged_items (session_id, item_id) VALUES (?, ?)"),
      isItemLogged: this.db.prepare("SELECT 1 FROM logged_items WHERE session_id = ? AND item_id = ?"),
      claimClientMessage: this.db.prepare("INSERT OR IGNORE INTO client_messages (session_id, client_message_id, ts) VALUES (?, ?, ?)"),
      releaseClientMessage: this.db.prepare("DELETE FROM client_messages WHERE session_id = ? AND client_message_id = ?"),
      getDriverState: this.db.prepare("SELECT value FROM driver_state WHERE session_id = ? AND key = ?"),
      setDriverState: this.db.prepare(
        "INSERT INTO driver_state (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value",
      ),
      deleteDriverState: this.db.prepare("DELETE FROM driver_state WHERE session_id = ? AND key = ?"),
      getAgentState: this.db.prepare("SELECT value FROM agent_state WHERE agent = ? AND key = ?"),
      setAgentState: this.db.prepare(
        "INSERT INTO agent_state (agent, key, value) VALUES (?, ?, ?) ON CONFLICT (agent, key) DO UPDATE SET value = excluded.value",
      ),
      clearAgentState: this.db.prepare("DELETE FROM agent_state WHERE agent = ?"),
      saveTerminal: this.db.prepare(
        `INSERT INTO terminals (id, cwd, title, command, cols, rows, created_at, active_at, exit_code, ended, buffer, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, cols = excluded.cols, rows = excluded.rows,
           active_at = excluded.active_at, exit_code = excluded.exit_code, ended = excluded.ended, buffer = excluded.buffer`,
      ),
      appendTerminalFrame: this.db.prepare(
        "INSERT INTO terminal_frames (terminal_id, frame, cols, rows, data) VALUES (?, ?, ?, ?, ?)",
      ),
      lastTerminalFrame: this.db.prepare("SELECT MAX(frame) AS frame FROM terminal_frames WHERE terminal_id = ?"),
      saveTerminalSnapshot: this.db.prepare(
        "INSERT OR REPLACE INTO terminal_snapshots (terminal_id, frame, cols, rows, data) VALUES (?, ?, ?, ?, ?)",
      ),
      terminalSnapshot: this.db.prepare("SELECT frame, cols, rows, data FROM terminal_snapshots WHERE terminal_id = ?"),
      terminalFrameCandidates: this.db.prepare(
        "SELECT frame, octet_length(data) AS bytes FROM terminal_frames WHERE terminal_id = ? AND frame > ? AND frame <= ? ORDER BY frame LIMIT 256",
      ),
      terminalFramesRange: this.db.prepare(
        "SELECT frame, cols, rows, data FROM terminal_frames WHERE terminal_id = ? AND frame > ? AND frame <= ? ORDER BY frame",
      ),
      hasBusySession: this.db.prepare(
        `SELECT 1 FROM sessions
         WHERE archived = 0
           AND state IN ('running', 'waiting')
           AND NOT EXISTS (SELECT 1 FROM driver_state d WHERE d.session_id = sessions.id AND d.key = 'native-missing' AND d.value = '1')
         LIMIT 1`,
      ),
    };
  }

  // ── removal ───────────────────────────────────────────────────────

  /** A previous host's busy flags are not evidence that an agent is still working. */
  resetLiveSessions(): string[] {
    if (this.closed) return [];
    const now = Date.now();
    const candidates = this.db
      .prepare(
        `SELECT id, state, pending_permissions FROM sessions s
         WHERE s.state IN ('running', 'waiting')
            OR s.pending_permissions > 0
            OR EXISTS (SELECT 1 FROM event_meta m WHERE m.session_id = s.id AND m.kind = 'ls_permission')`,
      )
      .all() as { id: string; state: string; pending_permissions: number }[];
    if (candidates.length === 0) return [];

    const permEventsStmt = this.db.prepare(
      `SELECT m.kind, json_extract(e.body, '$.requestId') AS request_id
       FROM event_meta m
       JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
       WHERE m.session_id = ? AND m.kind IN ('ls_permission', 'ls_permission_resolved')
       ORDER BY m.seq ASC`,
    );

    const affected = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.state === "running" || candidate.state === "waiting" || candidate.pending_permissions > 0) {
        affected.add(candidate.id);
      }
      const permRows = permEventsStmt.all(candidate.id) as { kind: string; request_id: string | null }[];
      const unresolved = new Set<string>();
      for (const row of permRows) {
        if (!row.request_id) continue;
        if (row.kind === "ls_permission") unresolved.add(row.request_id);
        else if (row.kind === "ls_permission_resolved") unresolved.delete(row.request_id);
      }
      if (unresolved.size > 0) {
        affected.add(candidate.id);
        // Close orphaned approval cards from a crashed/stopped host without bumping session activity.
        for (const requestId of unresolved) {
          this.appendEvent(candidate.id, { sessionUpdate: "ls_permission_resolved", requestId }, now, false);
        }
      }
    }

    this.db
      .prepare("UPDATE sessions SET state = 'offline', pending_permissions = 0 WHERE state IN ('running', 'waiting') OR pending_permissions > 0")
      .run();
    for (const id of affected) {
      this.stmts.deleteDriverState.run(id, "asyncQuestions");
    }
    return [...affected];
  }

  /** Deleted by the user: forgotten, and kept out of rediscovery. */
  removeSession(id: string): void {
    if (this.closed) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sessions", "events", "event_meta", "logged_items", "driver_state", "client_messages"]) {
        const column = table === "sessions" ? "id" : "session_id";
        this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
      }
      this.db.prepare("INSERT OR REPLACE INTO removed_sessions (id, ts) VALUES (?, ?)").run(id, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isRemoved(id: string): boolean {
    if (this.closed) return false;
    return this.stmts.isRemoved.get(id) !== undefined;
  }

  /** Missing native history is reversible; never use the user's deletion tombstone. */
  setNativeMissing(id: string, missing: boolean): void {
    if (this.closed) return;
    if (missing) this.setDriverState(id, "native-missing", "1");
    else this.stmts.deleteDriverState.run(id, "native-missing");
  }

  isNativeMissing(id: string): boolean {
    if (this.closed) return false;
    return this.getDriverState(id, "native-missing") === "1";
  }

  nativeMissingSessionIds(): string[] {
    if (this.closed) return [];
    return this.db.prepare("SELECT session_id FROM driver_state WHERE key = 'native-missing' AND value = '1'")
      .all().map((row) => String(row.session_id));
  }

  hasHistoryLoadErrors(id: string): boolean {
    if (this.closed) return false;
    return this.db.prepare(`SELECT 1 FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
      WHERE m.session_id = ? AND m.kind = 'ls_error' AND json_extract(e.body, '$.message') LIKE '读取会话消息失败：%'
      AND json_extract(e.body, '$.hint') = '重新打开会话可重试' LIMIT 1`).get(id) !== undefined;
  }

  /** Undo only the old subscribe path's synthetic execution failure. Keep real failed turns. */
  historyFailureRecoveryState(id: string): SessionState | undefined {
    if (this.closed) return undefined;
    const rows = this.db.prepare(`
      SELECT e.body, next.body AS following FROM event_meta m
      JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
      LEFT JOIN events next ON next.session_id = e.session_id AND next.seq = e.seq + 1
      WHERE m.session_id = ? AND m.kind IN ('ls_status', 'ls_turn') AND m.parent IS NULL
      ORDER BY m.seq DESC
    `).iterate(id);
    let skipped = false;
    for (const row of rows) {
      const update = JSON.parse(String(row.body)) as SessionUpdate;
      const next = row.following ? JSON.parse(String(row.following)) as SessionUpdate : undefined;
      if (update.sessionUpdate === "ls_status" && update.state === "error" && isHistoryLoadError(next)) {
        skipped = true;
        continue;
      }
      if (!skipped) return undefined;
      if (update.sessionUpdate === "ls_status") return update.state === "error" ? "error" : "offline";
      if (update.sessionUpdate === "ls_turn") return update.state === "ended" && update.stopReason === "error" ? "error" : "offline";
    }
    return skipped ? "offline" : undefined;
  }

  errorSessions(): SessionSummary[] {
    if (this.closed) return [];
    return (this.db.prepare("SELECT * FROM sessions WHERE state = 'error'").all() as unknown as SessionRow[]).map(toSummary);
  }

  /** Keep the original log and cursors intact, but stop replaying old synthetic failures. */
  isHistoryLoadEvent(event: SessionEvent): boolean {
    if (isHistoryLoadError(event.update)) return true;
    if (this.closed) return false;
    return event.update.sessionUpdate === "ls_status" && event.update.state === "error"
      && isHistoryLoadError(this.readEvent(event.sessionId, event.seq + 1)?.update);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── terminals ─────────────────────────────────────────────────────

  saveTerminal(t: TerminalRecord): void {
    if (this.closed) return;
    this.stmts.saveTerminal.run(
      t.id,
      t.cwd,
      t.title,
      t.command ?? null,
      t.cols,
      t.rows,
      t.createdAt,
      t.activeAt,
      t.exitCode,
      t.ended ? 1 : 0,
      t.buffer,
      t.sessionId ?? null,
    );
  }

  listTerminals(): TerminalRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare("SELECT * FROM terminals ORDER BY active_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      cwd: String(row.cwd),
      title: String(row.title),
      command: row.command ? String(row.command) : undefined,
      cols: Number(row.cols),
      rows: Number(row.rows),
      createdAt: Number(row.created_at),
      activeAt: Number(row.active_at),
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      ended: Number(row.ended) === 1,
      buffer: String(row.buffer),
      sessionId: row.session_id ? String(row.session_id) : undefined,
    }));
  }

  appendTerminalFrame(id: string, frame: number, cols: number, rows: number, data: string): void {
    if (this.closed) return;
    this.stmts.appendTerminalFrame.run(id, frame, cols, rows, data);
  }

  appendTerminalFrames(
    id: string,
    frames: readonly { frame: number; cols: number; rows: number; data: string }[],
  ): void {
    if (this.closed || frames.length === 0) return;
    if (frames.length === 1) {
      const f = frames[0]!;
      this.stmts.appendTerminalFrame.run(id, f.frame, f.cols, f.rows, f.data);
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const f of frames) {
        this.stmts.appendTerminalFrame.run(id, f.frame, f.cols, f.rows, f.data);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  lastTerminalFrame(id: string): number {
    if (this.closed) return 0;
    const row = this.stmts.lastTerminalFrame.get(id) as { frame: number | null };
    return row.frame ?? 0;
  }

  saveTerminalSnapshot(id: string, snapshot: { frame: number; cols: number; rows: number; data: string }): void {
    if (this.closed) return;
    this.stmts.saveTerminalSnapshot.run(id, snapshot.frame, snapshot.cols, snapshot.rows, snapshot.data);
  }

  terminalSnapshot(id: string): { frame: number; cols: number; rows: number; data: string } | undefined {
    if (this.closed) return undefined;
    return this.stmts.terminalSnapshot.get(id) as { frame: number; cols: number; rows: number; data: string } | undefined;
  }

  terminalFrames(id: string, after: number, through: number): { frame: number; cols: number; rows: number; data: string }[] {
    if (this.closed) return [];
    // Tiny PTY writes must not cost one network round trip per eight frames.
    // Read lengths first so large frames don't inflate the database read just
    // to decide where the bounded response ends.
    const candidates = this.stmts.terminalFrameCandidates.all(id, after, through) as { frame: number; bytes: number }[];
    let end = after, bytes = 0;
    for (const candidate of candidates) {
      if (end > after && bytes + candidate.bytes > 512 * 1024) break;
      bytes += candidate.bytes; end = candidate.frame;
    }
    return this.stmts.terminalFramesRange.all(id, after, end) as { frame: number; cols: number; rows: number; data: string }[];
  }

  deleteTerminal(id: string): void {
    if (this.closed) return;
    this.db.prepare("DELETE FROM terminal_snapshots WHERE terminal_id = ?").run(id);
    this.db.prepare("DELETE FROM terminal_frames WHERE terminal_id = ?").run(id);
    this.db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }

  /** Inserts a session, or refreshes discovery fields of an existing one. */
  upsertSession(input: SessionInsert): { summary: SessionSummary; created: boolean } {
    if (this.closed) {
      return {
        summary: {
          id: input.id,
          agent: input.agent,
          nativeId: input.nativeId,
          title: input.title,
          preview: input.preview,
          cwd: input.cwd,
          state: input.state ?? "idle",
          pendingPermissions: 0,
          model: input.model,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          lastSeq: 0,
          archived: false,
        },
        created: false,
      };
    }
    const existing = this.getSession(input.id);
    if (!existing) {
      this.stmts.insertSession.run(
        input.id,
        input.agent,
        input.nativeId,
        input.title ?? null,
        input.preview ?? null,
        input.cwd,
        input.state ?? "idle",
        input.model ?? null,
        input.createdAt,
        input.updatedAt,
      );
      return { summary: this.getSession(input.id)!, created: true };
    }
    const patch: SessionPatch = {};
    if (input.title && input.title !== existing.title) patch.title = input.title;
    if (input.preview && !existing.preview) patch.preview = input.preview;
    if (input.cwd && input.cwd !== existing.cwd) patch.cwd = input.cwd;
    if (input.model && input.model !== existing.model) patch.model = input.model;
    if (input.state && input.state !== existing.state) patch.state = input.state;
    if (input.updatedAt > existing.updatedAt) patch.updatedAt = input.updatedAt;
    const summary = Object.keys(patch).length > 0 ? this.patchSession(input.id, patch) : existing;
    return { summary, created: false };
  }

  patchSession(id: string, patch: SessionPatch): SessionSummary {
    if (this.closed) {
      const colon = id.indexOf(":");
      const now = patch.updatedAt ?? Date.now();
      return {
        id,
        agent: colon > 0 ? id.slice(0, colon) : "unknown",
        nativeId: colon > 0 ? id.slice(colon + 1) : id,
        title: (patch.customTitle ?? patch.title) ?? undefined,
        preview: patch.preview ?? undefined,
        cwd: patch.cwd ?? "",
        state: patch.state ?? "offline",
        driver: patch.driver ?? undefined,
        pendingPermissions: patch.pendingPermissions ?? 0,
        model: patch.model ?? undefined,
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        archived: patch.archived ?? false,
      };
    }
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof SessionPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    const summary = this.getSession(id);
    if (!summary) throw new Error(`unknown session ${id}`);
    return summary;
  }

  getSession(id: string): SessionSummary | undefined {
    if (this.closed) return undefined;
    const row = this.stmts.getSession.get(id) as SessionRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  listSessions(
    options: { limit?: number; before?: number; beforeId?: string; includeArchived?: boolean } = {},
  ): SessionSummary[] {
    if (this.closed) return [];
    const limit = options.limit ?? 50;
    let before = options.before;
    const beforeId = options.beforeId;
    if (before === undefined && beforeId !== undefined) {
      before = this.getSession(beforeId)?.updatedAt;
    }
    let rows: SessionRow[];
    if (options.includeArchived) {
      if (before !== undefined && beforeId !== undefined) {
        rows = this.stmts.listSessionsAllCursor.all(before, before, beforeId, limit) as unknown as SessionRow[];
      } else if (before !== undefined) {
        rows = this.stmts.listSessionsAllBefore.all(before, limit) as unknown as SessionRow[];
      } else {
        rows = this.stmts.listSessionsAll.all(limit) as unknown as SessionRow[];
      }
    } else if (before !== undefined && beforeId !== undefined) {
      rows = this.stmts.listSessionsActiveCursor.all(before, before, beforeId, limit) as unknown as SessionRow[];
    } else if (before !== undefined) {
      rows = this.stmts.listSessionsActiveBefore.all(before, limit) as unknown as SessionRow[];
    } else {
      rows = this.stmts.listSessionsActive.all(limit) as unknown as SessionRow[];
    }
    return rows.map(toSummary);
  }

  sessionsForAgent(agent: string): SessionSummary[] {
    if (this.closed) return [];
    const rows = this.stmts.sessionsForAgent.all(agent) as unknown as SessionRow[];
    return rows.map(toSummary);
  }

  listProjects(limit = 50): ProjectSummary[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare(`SELECT cwd, MIN(created_at) AS created_at,
        MAX(CASE WHEN archived = 0 THEN updated_at ELSE 0 END) AS last_active_at,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS session_count FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM driver_state WHERE session_id = sessions.id AND key = 'native-missing' AND value = '1') GROUP BY cwd`)
      .all() as { cwd: string; created_at: number; last_active_at: number; session_count: number }[];
    // A session in a worktree belongs to the project the worktree was made from.
    const worktrees = this.listWorktrees();
    const projects = new Map<string, ProjectSummary>();
    for (const row of rows) {
      const cwd = projectOf(row.cwd, worktrees);
      const project = projects.get(cwd) ?? { cwd, name: basename(cwd) || cwd, createdAt: row.created_at, lastActiveAt: 0, sessionCount: 0 };
      // Archiving an old session must not make its project appear newly created.
      project.createdAt = Math.min(project.createdAt ?? row.created_at, row.created_at);
      project.lastActiveAt = Math.max(project.lastActiveAt, row.last_active_at);
      project.sessionCount += row.session_count;
      projects.set(cwd, project);
    }
    return [...projects.values()].filter((project) => project.sessionCount > 0).sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, limit);
  }

  // ── worktrees ─────────────────────────────────────────────────────

  saveWorktree(worktree: WorktreeRecord): void {
    if (this.closed) return;
    this.db
      .prepare("INSERT OR REPLACE INTO worktrees (path, branch, source, source_cwd, base, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(worktree.path, worktree.branch, worktree.source, worktree.sourceCwd, worktree.base, worktree.createdAt);
  }

  listWorktrees(): WorktreeRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare("SELECT * FROM worktrees ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      path: String(row.path),
      branch: String(row.branch),
      source: String(row.source),
      sourceCwd: String(row.source_cwd),
      base: String(row.base),
      createdAt: Number(row.created_at),
    }));
  }

  deleteWorktree(path: string): void {
    if (this.closed) return;
    this.db.prepare("DELETE FROM worktrees WHERE path = ?").run(path);
  }

  /** Sessions whose directory is `path` or inside it. */
  sessionsUnder(path: string): string[] {
    if (this.closed) return [];
    const rows = this.db.prepare("SELECT id FROM sessions WHERE cwd = ? OR substr(cwd, 1, ?) IN (?, ?)").all(path, path.length + 1, `${path}/`, `${path}\\`) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** The seq of the latest event that mentions message or tool call `itemId`, and how many turns had started by then. */
  locateItem(sessionId: string, itemId: string): { seq: number; turn: number } | undefined {
    if (this.closed) return undefined;
    const tool = this.db
      .prepare("SELECT MAX(seq) AS seq FROM event_meta WHERE session_id = ? AND tool = ?")
      .get(sessionId, itemId) as { seq: number | null };
    const needle = `"messageId":${JSON.stringify(itemId)}`;
    const message = this.db
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE session_id = ? AND instr(body, ?) > 0")
      .get(sessionId, needle) as { seq: number | null };
    const seq = Math.max(tool.seq ?? 0, message.seq ?? 0);
    if (seq === 0) return undefined;
    const { turn } = this.db
      .prepare("SELECT COUNT(*) AS turn FROM event_meta WHERE session_id = ? AND kind = 'ls_turn' AND opens_turn = 1 AND seq <= ?")
      .get(sessionId, seq) as { turn: number };
    return { seq, turn };
  }

  /** Where the exchange that `seq` is in ends: just before the user speaks next, or the end of the session. */
  turnEnd(sessionId: string, seq: number): number {
    if (this.closed) return seq;
    const next = this.db
      .prepare("SELECT MIN(seq) AS seq FROM event_meta WHERE session_id = ? AND kind IN ('user_message_chunk', 'ls_message') AND opens_turn = 1 AND seq > ?")
      .get(sessionId, seq) as { seq: number | null };
    return next.seq ? next.seq - 1 : (this.getSession(sessionId)?.lastSeq ?? seq);
  }

  /**
   * Appends one update to the session's log and returns it with its seq.
   * `activity` false: the session's "last updated" stays (a setting or a name
   * is not something happening in the session).
   */
  appendEvent(sessionId: string, update: SessionUpdate, ts = Date.now(), activity = true): SessionEvent {
    if (this.closed) return { sessionId, seq: 1, ts, update };
    const inOuterTx = this.db.isTransaction;
    if (!inOuterTx) this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmts.selectLastSeq.get(sessionId) as
        | { last_seq: number }
        | undefined;
      if (!row) throw new Error(`unknown session ${sessionId}`);
      const seq = row.last_seq + 1;
      const body = JSON.stringify(update);
      this.stmts.insertEvent.run(sessionId, seq, ts, body);
      const fields = update as { toolCallId?: string; parentToolCallId?: string };
      const userMessage = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "ls_message" && update.role === "user" && !update.parentToolCallId;
      const messageKey = userMessage && update.messageId ? `ls:user-present:${update.messageId}` : undefined;
      const newUser = userMessage && (update.sessionUpdate === "user_message_chunk" || !messageKey || !this.isItemLogged(sessionId, messageKey));
      const opensTurn = newUser || (update.sessionUpdate === "ls_turn" && update.state === "started" && !fields.parentToolCallId);
      if (messageKey) this.markItemLogged(sessionId, messageKey);
      const spawns = update.sessionUpdate === "tool_call" && update.detail?.type === "subagent" && (update.detail.action ?? "spawn") === "spawn";
      this.stmts.insertEventMeta.run(
        sessionId,
        seq,
        update.sessionUpdate,
        Buffer.byteLength(body),
        opensTurn ? 1 : 0,
        fields.toolCallId ?? null,
        fields.parentToolCallId ?? null,
        spawns ? 1 : 0,
      );
      this.stmts.updateSessionSeq.run(seq, activity ? ts : 0, sessionId);
      if (!inOuterTx) this.db.exec("COMMIT");
      return { sessionId, seq, ts, update };
    } catch (error) {
      if (!inOuterTx) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Events after `afterSeq`, up to and including `upToSeq` when given. */
  readEvents(sessionId: string, afterSeq: number, limit = 5000, upToSeq = Number.MAX_SAFE_INTEGER): SessionEvent[] {
    if (this.closed) return [];
    const rows = this.stmts.readEvents.all(sessionId, afterSeq, upToSeq, limit) as { seq: number; ts: number; body: string }[];
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  readEvent(sessionId: string, seq: number): SessionEvent | undefined {
    return this.readEvents(sessionId, seq - 1, 1, seq)[0];
  }

  /** How much was logged after `afterSeq`, counted as a page is (see `PageBudget`). */
  sizeAfter(sessionId: string, afterSeq: number, page: PageBudget = PAGE): { events: number; bytes: number } {
    if (this.closed) return { events: 0, bytes: 0 };
    return this.stmts.sizeAfter.get(page.eventOverhead, sessionId, afterSeq) as { events: number; bytes: number };
  }

  /**
   * Where a page of history ending at `beforeSeq` starts: the seq before its
   * first event (0: the beginning of the log). Pages are whole turns, going
   * back until one is worth showing; only a newest turn too big for a page is cut.
   */
  pageStart(sessionId: string, beforeSeq: number, page: PageBudget = PAGE): number {
    if (this.closed) return 0;
    const batch = 1000;
    const rows: MetaRow[] = [];
    let complete = false;
    // Read back only as far as needed: a page of streamed pieces holds many more rows than events.
    const at = (i: number): MetaRow | undefined => {
      while (i >= rows.length && !complete) {
        const more = this.stmts.pageStartBatch.all(
          sessionId,
          rows.length ? rows[rows.length - 1]!.seq - 1 : beforeSeq,
          batch,
        ) as unknown as MetaRow[];
        rows.push(...more);
        complete = more.length < batch;
      }
      return rows[i];
    };
    let events = 0;
    let bytes = 0;
    // Where the newest turn passed so far starts: a page that must stop ends there, not inside an older turn.
    let boundary: number | undefined;
    for (let i = 0; ; i++) {
      const row = at(i);
      if (!row) return 0;
      const previous = at(i + 1);
      if (!continuesStream(row, previous)) events += 1;
      // What a client receives: pictures are left out and long text is cut.
      bytes += Math.min(row.bytes, page.eventBytes) + page.eventOverhead;
      if (!previous) return 0;
      // The end of the message before (`ls_message_done`) belongs to it: a user's message, its end,
      // then the turn it starts is one turn, which starts at the message.
      let before = i + 1;
      while (at(before)?.kind === "ls_message_done") before += 1;
      const turnStarts = row.opens_turn === 1 && at(before)?.opens_turn === 0;
      if (turnStarts) {
        if (events >= page.minEvents || bytes >= page.minBytes) return previous.seq;
        boundary = previous.seq;
      }
      if (events >= page.maxEvents || bytes >= page.maxBytes) return boundary ?? previous.seq;
    }
  }

  /** The calls that started a sub-agent, oldest first. */
  subagentCalls(sessionId: string): SessionEvent[] {
    return this.joined("m.session_id = ? AND m.spawns = 1 ORDER BY m.seq ASC", [sessionId]);
  }

  /** A tool call's own events (the call and its updates), oldest first. */
  toolEvents(sessionId: string, toolCallId: string): SessionEvent[] {
    return this.joined("m.session_id = ? AND m.tool = ? ORDER BY m.seq ASC", [sessionId, toolCallId]);
  }

  /** A roster needs the latest detail even when the launching turn is no longer loaded. */
  toolDetail(sessionId: string, toolCallId: string): SessionEvent | undefined {
    return this.joined("m.session_id = ? AND m.tool = ? AND json_extract(e.body, '$.detail') IS NOT NULL ORDER BY m.seq DESC LIMIT 1", [sessionId, toolCallId])[0];
  }

  /** The latest `limit` events of the sub-agent under a tool call, oldest first. */
  eventsUnder(sessionId: string, toolCallId: string, limit: number): SessionEvent[] {
    return this.joined(`m.session_id = ? AND m.parent IN (
      WITH RECURSIVE children(id) AS (
        SELECT ? UNION SELECT c.tool FROM event_meta c JOIN children p ON c.parent = p.id
        WHERE c.session_id = ? AND c.spawns = 1 AND c.tool IS NOT NULL
      ) SELECT id FROM children
    ) ORDER BY m.seq DESC LIMIT ?`, [sessionId, toolCallId, sessionId, limit]).reverse();
  }

  /** A tool call's latest status, whether the sub-agent under it is in a turn, and when that sub-agent last did anything. */
  toolState(sessionId: string, toolCallId: string): { status?: string; ts?: number; seq?: number; turnActive?: boolean; lastChildTs?: number } {
    if (this.closed) return {};
    const last = this.db
      .prepare(
        `SELECT e.ts, e.seq, json_extract(e.body, '$.status') AS status FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.tool = ? AND json_extract(e.body, '$.status') IS NOT NULL ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(sessionId, toolCallId) as { ts: number; seq: number; status: string } | undefined;
    const turn = this.db
      .prepare(
        `SELECT json_extract(e.body, '$.state') AS state FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.parent = ? AND m.kind = 'ls_turn' ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(sessionId, toolCallId) as { state: string } | undefined;
    const child = this.db
      .prepare(
        `SELECT e.ts FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.parent = ? ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(sessionId, toolCallId) as { ts: number } | undefined;
    return { status: last?.status, ts: last?.ts, seq: last?.seq, turnActive: turn ? turn.state === "started" : undefined, lastChildTs: child?.ts };
  }

  private joined(where: string, values: (string | number)[]): SessionEvent[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare(`SELECT e.seq, e.ts, e.body FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq WHERE ${where}`)
      .all(...values) as { seq: number; ts: number; body: string }[];
    const sessionId = String(values[0]);
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  /** Read numeric usage only; include earlier counters to establish cumulative baselines. */
  *usageEvents(): Iterable<SessionEvent & { agent: string }> {
    if (this.closed) return;
    const rows = this.db.prepare(`SELECT e.session_id, e.seq, e.ts, e.body, s.agent
      FROM sessions s JOIN event_meta m ON m.session_id = s.id AND m.kind = 'usage_update'
      JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
      WHERE s.agent NOT IN ('codex', 'claude') ORDER BY e.session_id, e.seq`).iterate();
    for (const row of rows) yield { sessionId: String(row.session_id), seq: Number(row.seq), ts: Number(row.ts),
      agent: String(row.agent), update: JSON.parse(String(row.body)) as SessionUpdate };
  }

  /** Every background-task record the session logged, oldest first (each is a whole record: the last per task holds). */
  taskEvents(sessionId: string): SessionEvent[] {
    return this.joined("m.session_id = ? AND m.kind = 'ls_task' ORDER BY m.seq ASC", [sessionId]);
  }

  /** The latest event of `kind` at or before `seq`. */
  latestOfKind(sessionId: string, kind: SessionUpdate["sessionUpdate"], seq: number, limit = 1): SessionEvent[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.ts, e.body FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.kind = ? AND m.seq <= ? ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(sessionId, kind, seq, limit) as { seq: number; ts: number; body: string }[];
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  /** Marks a native item (message, tool call) as present in the log. Returns false if it already was. */
  markItemLogged(sessionId: string, itemId: string): boolean {
    if (this.closed) return false;
    const result = this.stmts.markItemLogged.run(sessionId, itemId);
    return Number(result.changes) > 0;
  }

  isItemLogged(sessionId: string, itemId: string): boolean {
    if (this.closed) return false;
    return this.stmts.isItemLogged.get(sessionId, itemId) !== undefined;
  }

  /** Records a client message id. Returns false when it was already delivered. */
  claimClientMessage(sessionId: string, clientMessageId: string, ts = Date.now()): boolean {
    if (this.closed) return false;
    const result = this.stmts.claimClientMessage.run(sessionId, clientMessageId, ts);
    return Number(result.changes) > 0;
  }

  /** Small per-session values a driver keeps across restarts (e.g. a transcript read offset). */
  getDriverState(sessionId: string, key: string): string | undefined {
    if (this.closed) return undefined;
    const row = this.stmts.getDriverState.get(sessionId, key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setDriverState(sessionId: string, key: string, value: string): void {
    if (this.closed) return;
    this.stmts.setDriverState.run(sessionId, key, value);
  }

  /** Small values a driver keeps for the agent as a whole across restarts (what it last said its models were). */
  getAgentState(agent: string, key: string): string | undefined {
    if (this.closed) return undefined;
    const row = this.stmts.getAgentState.get(agent, key) as { value: string } | undefined;
    return row?.value;
  }

  setAgentState(agent: string, key: string, value: string): void {
    if (this.closed) return;
    this.stmts.setAgentState.run(agent, key, value);
  }

  /** Forgets what was kept for an agent: another agent may come to have its id. */
  clearAgentState(agent: string): void {
    if (this.closed) return;
    this.stmts.clearAgentState.run(agent);
  }

  releaseClientMessage(sessionId: string, clientMessageId: string): void {
    if (this.closed) return;
    this.stmts.releaseClientMessage.run(sessionId, clientMessageId);
  }

  /**
   * Coalesces contiguous runs of `agent_message_chunk` (same `messageId` and
   * `parentToolCallId`) and `agent_thought_chunk` inside completed turns into a
   * single consolidated chunk row, preserving the final chunk's `seq` so
   * `lastSeq`, `fromSeq`, and `pageStart` / `sessions.history` stay monotonic.
   */
  compactTurnChunks(
    sessionId: string,
    options: { maxScanRows?: number } = {},
  ): { coalescedRuns: number; removedRows: number } {
    if (this.closed) return { coalescedRuns: 0, removedRows: 0 };
    const maxScanRows = Math.max(2, Math.trunc(options.maxScanRows ?? 5_000));
    const ended = this.db
      .prepare(
        `SELECT MAX(m.seq) AS seq FROM event_meta m
         JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.kind = 'ls_turn' AND m.parent IS NULL AND json_extract(e.body, '$.state') = 'ended'`,
      )
      .get(sessionId) as { seq: number | null } | undefined;
    const maxEndedSeq = ended?.seq ?? 0;
    const savedCursor = Number(this.getDriverState(sessionId, "compacted-seq") ?? 0);
    const afterSeq = Number.isSafeInteger(savedCursor) && savedCursor >= 0 ? savedCursor : 0;
    if (!maxEndedSeq || maxEndedSeq <= afterSeq) {
      return { coalescedRuns: 0, removedRows: 0 };
    }

    const rows = this.db
      .prepare(
        `SELECT m.seq, m.kind, m.parent, e.body
         FROM event_meta m
         JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE m.session_id = ? AND m.seq > ? AND m.seq <= ?
         ORDER BY m.seq ASC
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, maxEndedSeq, maxScanRows) as { seq: number; kind: string; parent: string | null; body: string }[];
    if (rows.length === 0) {
      this.setDriverState(sessionId, "compacted-seq", String(maxEndedSeq));
      return { coalescedRuns: 0, removedRows: 0 };
    }

    type ChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>;
    interface Run {
      kind: "agent_message_chunk" | "agent_thought_chunk";
      messageId: string;
      parent: string | null;
      annotationsKey: string;
      seqs: number[];
      texts: string[];
      lastUpdate: ChunkUpdate;
    }
    interface Coalesced {
      toDelete: number[];
      keptSeq: number;
      mergedBody: string;
      mergedBytes: number;
    }

    const plans: Coalesced[] = [];
    let current: Run | undefined;

    const flush = () => {
      if (current && current.seqs.length >= 2) {
        const keptSeq = current.seqs[current.seqs.length - 1]!;
        const toDelete = current.seqs.slice(0, -1);
        const mergedText = current.texts.join("");
        const mergedUpdate: ChunkUpdate = {
          ...current.lastUpdate,
          content: { ...current.lastUpdate.content, type: "text", text: mergedText },
          replace: true,
        };
        const mergedBody = JSON.stringify(mergedUpdate);
        plans.push({
          toDelete,
          keptSeq,
          mergedBody,
          mergedBytes: Buffer.byteLength(mergedBody),
        });
      }
      current = undefined;
    };

    for (const row of rows) {
      if (row.kind !== "agent_message_chunk" && row.kind !== "agent_thought_chunk") {
        flush();
        continue;
      }
      let parsed: ChunkUpdate;
      try {
        parsed = JSON.parse(row.body) as ChunkUpdate;
      } catch {
        flush();
        continue;
      }
      if (
        (parsed.sessionUpdate !== "agent_message_chunk" && parsed.sessionUpdate !== "agent_thought_chunk") ||
        (parsed.messageId !== undefined && typeof parsed.messageId !== "string") ||
        parsed.content?.type !== "text"
      ) {
        flush();
        continue;
      }
      const messageId = parsed.messageId ?? "";
      const parent = parsed.parentToolCallId ?? null;
      const annotationsKey = JSON.stringify(parsed.content.annotations ?? null);
      if (
        current &&
        current.kind === parsed.sessionUpdate &&
        current.messageId === messageId &&
        current.parent === parent &&
        current.annotationsKey === annotationsKey
      ) {
        current.seqs.push(row.seq);
        if (parsed.replace) {
          current.texts = [parsed.content.text];
        } else {
          current.texts.push(parsed.content.text);
        }
        current.lastUpdate = parsed;
      } else {
        flush();
        current = {
          kind: parsed.sessionUpdate,
          messageId,
          parent,
          annotationsKey,
          seqs: [row.seq],
          texts: [parsed.content.text],
          lastUpdate: parsed,
        };
      }
    }

    const lastScannedSeq = rows[rows.length - 1]!.seq;
    const hitLimit = rows.length === maxScanRows && lastScannedSeq < maxEndedSeq;
    let nextCursor: number;
    if (!hitLimit) {
      flush();
      nextCursor = maxEndedSeq;
    } else if (!current) {
      nextCursor = lastScannedSeq;
    } else if (current.seqs[0]! > rows[0]!.seq) {
      // Stop right before the trailing run so the next batch coalesces it whole instead of splitting `replace: true` chunks.
      nextCursor = current.seqs[0]! - 1;
      current = undefined;
    } else {
      // A single run spans the entire batch: merge this prefix and start the next scan at keptSeq so the remainder joins it.
      const keptSeq = current.seqs[current.seqs.length - 1]!;
      flush();
      nextCursor = keptSeq - 1;
    }

    let removedRows = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (plans.length > 0) {
        const delEvent = this.db.prepare("DELETE FROM events WHERE session_id = ? AND seq = ?");
        const delMeta = this.db.prepare("DELETE FROM event_meta WHERE session_id = ? AND seq = ?");
        const updEvent = this.db.prepare("UPDATE events SET body = ? WHERE session_id = ? AND seq = ?");
        const updMeta = this.db.prepare("UPDATE event_meta SET bytes = ? WHERE session_id = ? AND seq = ?");
        for (const plan of plans) {
          for (const seq of plan.toDelete) {
            delEvent.run(sessionId, seq);
            delMeta.run(sessionId, seq);
            removedRows++;
          }
          updEvent.run(plan.mergedBody, sessionId, plan.keptSeq);
          updMeta.run(plan.mergedBytes, sessionId, plan.keptSeq);
        }
      }
      this.setDriverState(sessionId, "compacted-seq", String(nextCursor));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { coalescedRuns: plans.length, removedRows };
  }

  /**
   * Periodic database lifecycle pruning and WAL checkpoint:
   * - Prunes `terminal_frames` for exited terminals older than 7 days while keeping `terminal_snapshots`,
   *   and trims any terminal's `terminal_frames` (even while `ended = 0`) to a sliding window of 8,192 frames.
   * - Prunes `client_messages` older than 30 days.
   * - Retains `removed_sessions` tombstones by count cap (default latest 50,000) so deleted sessions never resurrect.
   * - Runs `PRAGMA wal_checkpoint(TRUNCATE)` when idle, or `PASSIVE` while sessions are busy.
   */
  runMaintenance(
    now = Date.now(),
    options: {
      terminalFramesMaxAgeMs?: number;
      ephemeralMaxAgeMs?: number;
      maxTerminalFrames?: number;
      maxRemovedSessions?: number;
      idle?: boolean;
    } = {},
  ): { prunedTerminalFrames: number; prunedClientMessages: number; prunedRemovedSessions: number } {
    if (this.closed) {
      return { prunedTerminalFrames: 0, prunedClientMessages: 0, prunedRemovedSessions: 0 };
    }
    const terminalCutoff = now - (options.terminalFramesMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000);
    const ephemeralCutoff = now - (options.ephemeralMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
    const maxTerminalFrames = Math.max(1, Math.trunc(options.maxTerminalFrames ?? 8_192));
    const maxRemovedSessions = Math.max(0, Math.trunc(options.maxRemovedSessions ?? 50_000));

    let prunedTerminalFrames = 0;
    let prunedClientMessages: number;
    let prunedRemovedSessions = 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      prunedTerminalFrames += Number(
        this.db
          .prepare(
            `DELETE FROM terminal_frames
             WHERE terminal_id IN (SELECT id FROM terminals WHERE ended = 1 AND active_at < ?)`,
          )
          .run(terminalCutoff).changes,
      );

      const oversizedTerminals = this.db
        .prepare(
          `SELECT terminal_id
           FROM terminal_frames
           GROUP BY terminal_id
           HAVING COUNT(*) > ?`,
        )
        .all(maxTerminalFrames) as { terminal_id: string }[];
      if (oversizedTerminals.length > 0) {
        const windowCutoffStmt = this.db.prepare(
          `SELECT frame FROM terminal_frames
           WHERE terminal_id = ?
           ORDER BY frame DESC
           LIMIT 1 OFFSET ?`,
        );
        const pruneWindowStmt = this.db.prepare(
          "DELETE FROM terminal_frames WHERE terminal_id = ? AND frame < ?",
        );
        for (const { terminal_id: terminalId } of oversizedTerminals) {
          const row = windowCutoffStmt.get(terminalId, maxTerminalFrames - 1) as { frame: number } | undefined;
          if (row !== undefined) {
            prunedTerminalFrames += Number(pruneWindowStmt.run(terminalId, row.frame).changes);
          }
        }
      }

      prunedClientMessages = Number(
        this.db.prepare("DELETE FROM client_messages WHERE ts < ?").run(ephemeralCutoff).changes,
      );

      const { total: totalRemoved } = this.db
        .prepare("SELECT COUNT(*) AS total FROM removed_sessions")
        .get() as { total: number };
      if (totalRemoved > maxRemovedSessions) {
        prunedRemovedSessions = Number(
          this.db
            .prepare(
              `DELETE FROM removed_sessions
               WHERE id IN (
                 SELECT id FROM removed_sessions
                 ORDER BY ts ASC, id ASC
                 LIMIT ?
               )`,
            )
            .run(totalRemoved - maxRemovedSessions).changes,
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const isIdle = options.idle ?? !this.hasBusySession();
    try {
      this.db.exec(`PRAGMA wal_checkpoint(${isIdle ? "TRUNCATE" : "PASSIVE"})`);
    } catch {
      // Checkpoint is best-effort and never fails maintenance if another handle holds the WAL.
    }

    return { prunedTerminalFrames, prunedClientMessages, prunedRemovedSessions };
  }

  /** Fast check for any non-archived stored session in `running` or `waiting` state. */
  hasBusySession(): boolean {
    if (this.closed) return false;
    return this.stmts.hasBusySession.get() !== undefined;
  }

  /** Non-archived session IDs whose latest `ls_goal` record has `status === "active"`. */
  activeGoalSessionIds(): string[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare(
        `SELECT s.id
         FROM sessions s
         JOIN event_meta m ON m.session_id = s.id AND m.seq = (
           SELECT MAX(m2.seq) FROM event_meta m2 WHERE m2.session_id = s.id AND m2.kind = 'ls_goal'
         )
         JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
         WHERE s.archived = 0
           AND NOT EXISTS (SELECT 1 FROM driver_state d WHERE d.session_id = s.id AND d.key = 'native-missing' AND d.value = '1')
           AND json_extract(e.body, '$.goal.status') = 'active'`,
      )
      .all() as { id: string }[];
    return rows.map((row) => String(row.id));
  }

  /** Counts LinkShell-submitted turns and answered permission/question approvals within `[sinceMs, untilMs]`. */
  remoteStats(sinceMs: number, untilMs: number, agent = "all"): { remoteTurns: number; remoteApprovals: number } {
    if (this.closed) return { remoteTurns: 0, remoteApprovals: 0 };
    const filterAgent = agent !== "all";
    const turnsRow = (filterAgent
      ? this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM client_messages cm
             JOIN sessions s ON s.id = cm.session_id
             WHERE cm.ts >= ? AND cm.ts <= ? AND s.agent = ?`,
          )
          .get(sinceMs, untilMs, agent)
      : this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM client_messages cm
             JOIN sessions s ON s.id = cm.session_id
             WHERE cm.ts >= ? AND cm.ts <= ?`,
          )
          .get(sinceMs, untilMs)) as { n: number };

    const approvalsRow = (filterAgent
      ? this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM event_meta m
             JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
             JOIN sessions s ON s.id = m.session_id
             WHERE m.kind = 'ls_permission_resolved'
               AND e.ts >= ? AND e.ts <= ?
               AND s.agent = ?
               AND (json_extract(e.body, '$.optionId') IS NOT NULL OR json_extract(e.body, '$.answers') IS NOT NULL)`,
          )
          .get(sinceMs, untilMs, agent)
      : this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM event_meta m
             JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq
             JOIN sessions s ON s.id = m.session_id
             WHERE m.kind = 'ls_permission_resolved'
               AND e.ts >= ? AND e.ts <= ?
               AND (json_extract(e.body, '$.optionId') IS NOT NULL OR json_extract(e.body, '$.answers') IS NOT NULL)`,
          )
          .get(sinceMs, untilMs)) as { n: number };

    return {
      remoteTurns: Number(turnsRow?.n ?? 0),
      remoteApprovals: Number(approvalsRow?.n ?? 0),
    };
  }
}
