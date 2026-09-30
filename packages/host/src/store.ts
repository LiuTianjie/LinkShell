import { DatabaseSync } from "node:sqlite";
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
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
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

/**
 * Durable host state: session summaries plus one append-only event log per
 * session. Every update a client sees gets a per-session `seq`, so a client
 * that reconnects asks for "everything after seq N" and gets exactly that.
 */
export class HostStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first release. */
  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("custom_title")) this.db.exec("ALTER TABLE sessions ADD COLUMN custom_title TEXT");
  }

  // ── removal ───────────────────────────────────────────────────────

  /** Deleted by the user: forgotten, and kept out of rediscovery. */
  removeSession(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sessions", "events", "logged_items", "driver_state", "client_messages"]) {
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
    return this.db.prepare("SELECT 1 FROM removed_sessions WHERE id = ?").get(id) !== undefined;
  }

  close(): void {
    this.db.close();
  }

  // ── terminals ─────────────────────────────────────────────────────

  saveTerminal(t: TerminalRecord): void {
    this.db
      .prepare(
        `INSERT INTO terminals (id, cwd, title, command, cols, rows, created_at, active_at, exit_code, ended, buffer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, cols = excluded.cols, rows = excluded.rows,
           active_at = excluded.active_at, exit_code = excluded.exit_code, ended = excluded.ended, buffer = excluded.buffer`,
      )
      .run(t.id, t.cwd, t.title, t.command ?? null, t.cols, t.rows, t.createdAt, t.activeAt, t.exitCode, t.ended ? 1 : 0, t.buffer);
  }

  listTerminals(): TerminalRecord[] {
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
    }));
  }

  deleteTerminal(id: string): void {
    this.db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }

  /** Inserts a session, or refreshes discovery fields of an existing one. */
  upsertSession(input: SessionInsert): { summary: SessionSummary; created: boolean } {
    const existing = this.getSession(input.id);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sessions (id, agent, native_id, title, preview, cwd, state, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  listSessions(options: { limit?: number; before?: number; includeArchived?: boolean } = {}): SessionSummary[] {
    const where: string[] = [];
    const values: (number | string)[] = [];
    if (!options.includeArchived) where.push("archived = 0");
    if (options.before !== undefined) {
      where.push("updated_at < ?");
      values.push(options.before);
    }
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values, options.limit ?? 50) as unknown as SessionRow[];
    return rows.map(toSummary);
  }

  listProjects(limit = 50): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT cwd, MAX(updated_at) AS last_active_at, COUNT(*) AS session_count
         FROM sessions WHERE archived = 0 GROUP BY cwd ORDER BY last_active_at DESC LIMIT ?`,
      )
      .all(limit) as { cwd: string; last_active_at: number; session_count: number }[];
    return rows.map((row) => ({
      cwd: row.cwd,
      name: basename(row.cwd) || row.cwd,
      lastActiveAt: row.last_active_at,
      sessionCount: row.session_count,
    }));
  }

  /** Appends one update to the session's log and returns it with its seq. */
  appendEvent(sessionId: string, update: SessionUpdate, ts = Date.now()): SessionEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(sessionId) as
        | { last_seq: number }
        | undefined;
      if (!row) throw new Error(`unknown session ${sessionId}`);
      const seq = row.last_seq + 1;
      this.db
        .prepare("INSERT INTO events (session_id, seq, ts, body) VALUES (?, ?, ?, ?)")
        .run(sessionId, seq, ts, JSON.stringify(update));
      this.db.prepare("UPDATE sessions SET last_seq = ?, updated_at = MAX(updated_at, ?) WHERE id = ?").run(seq, ts, sessionId);
      this.db.exec("COMMIT");
      return { sessionId, seq, ts, update };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readEvents(sessionId: string, afterSeq: number, limit = 5000): SessionEvent[] {
    const rows = this.db
      .prepare("SELECT seq, ts, body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, afterSeq, limit) as { seq: number; ts: number; body: string }[];
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  /** Marks a native item (message, tool call) as present in the log. Returns false if it already was. */
  markItemLogged(sessionId: string, itemId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO logged_items (session_id, item_id) VALUES (?, ?)")
      .run(sessionId, itemId);
    return Number(result.changes) > 0;
  }

  isItemLogged(sessionId: string, itemId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM logged_items WHERE session_id = ? AND item_id = ?").get(sessionId, itemId) !==
      undefined
    );
  }

  /** Records a client message id. Returns false when it was already delivered. */
  claimClientMessage(sessionId: string, clientMessageId: string, ts = Date.now()): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO client_messages (session_id, client_message_id, ts) VALUES (?, ?, ?)")
      .run(sessionId, clientMessageId, ts);
    return Number(result.changes) > 0;
  }

  /** Small per-session values a driver keeps across restarts (e.g. a transcript read offset). */
  getDriverState(sessionId: string, key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM driver_state WHERE session_id = ? AND key = ?").get(sessionId, key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setDriverState(sessionId: string, key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO driver_state (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value",
      )
      .run(sessionId, key, value);
  }

  releaseClientMessage(sessionId: string, clientMessageId: string): void {
    this.db
      .prepare("DELETE FROM client_messages WHERE session_id = ? AND client_message_id = ?")
      .run(sessionId, clientMessageId);
  }
}
