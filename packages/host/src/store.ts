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
  return worktrees.find((worktree) => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`));
}

/** The project a session in `cwd` belongs to: for a worktree, the directory it was made from. */
function projectOf(cwd: string, worktrees: WorktreeRecord[]): string {
  return worktreeOf(cwd, worktrees)?.sourceCwd ?? cwd;
}

/** How much history one page carries (see `pageStart`). */
export interface PageBudget {
  /** A page goes back whole turns until it has this many events or bytes… */
  minEvents: number;
  minBytes: number;
  /** …and never more than this, even inside one turn. */
  maxEvents: number;
  maxBytes: number;
  /** What one event counts for at most: its size as sent, not as stored. */
  eventBytes: number;
}

export const PAGE: PageBudget = { minEvents: 120, minBytes: 384 * 1024, maxEvents: 600, maxBytes: 2 * 1024 * 1024, eventBytes: 40 * 1024 };

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
    // event_meta came later (and its sub-agent columns later still): describe
    // the events logged before it, once.
    const meta = new Set((this.db.prepare("PRAGMA table_info(event_meta)").all() as { name: string }[]).map((c) => c.name));
    if (!meta.has("tool")) {
      this.db.exec("ALTER TABLE event_meta ADD COLUMN tool TEXT; ALTER TABLE event_meta ADD COLUMN parent TEXT; ALTER TABLE event_meta ADD COLUMN spawns INTEGER NOT NULL DEFAULT 0;");
    }
    this.db.exec(`
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

  // ── removal ───────────────────────────────────────────────────────

  /** A previous host's busy flags are not evidence that an agent is still working. */
  resetLiveSessions(): string[] {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE state IN ('running', 'waiting') OR pending_permissions > 0").all() as { id: string }[];
    this.db.prepare("UPDATE sessions SET state = 'offline', pending_permissions = 0 WHERE state IN ('running', 'waiting') OR pending_permissions > 0").run();
    const clearQuestions = this.db.prepare("DELETE FROM driver_state WHERE session_id = ? AND key = 'asyncQuestions'");
    for (const { id } of rows) clearQuestions.run(id);
    return rows.map(({ id }) => id);
  }

  /** Deleted by the user: forgotten, and kept out of rediscovery. */
  removeSession(id: string): void {
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

  appendTerminalFrame(id: string, frame: number, cols: number, rows: number, data: string): void {
    this.db.prepare("INSERT INTO terminal_frames (terminal_id, frame, cols, rows, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, frame, cols, rows, data);
  }

  lastTerminalFrame(id: string): number {
    const row = this.db.prepare("SELECT MAX(frame) AS frame FROM terminal_frames WHERE terminal_id = ?").get(id) as { frame: number | null };
    return row.frame ?? 0;
  }

  saveTerminalSnapshot(id: string, snapshot: { frame: number; cols: number; rows: number; data: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO terminal_snapshots (terminal_id, frame, cols, rows, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, snapshot.frame, snapshot.cols, snapshot.rows, snapshot.data);
  }

  terminalSnapshot(id: string): { frame: number; cols: number; rows: number; data: string } | undefined {
    return this.db.prepare("SELECT frame, cols, rows, data FROM terminal_snapshots WHERE terminal_id = ?")
      .get(id) as { frame: number; cols: number; rows: number; data: string } | undefined;
  }

  terminalFrames(id: string, after: number, through: number): { frame: number; cols: number; rows: number; data: string }[] {
    // Tiny PTY writes must not cost one network round trip per eight frames.
    // Read lengths first so large frames don't inflate the database read just
    // to decide where the bounded response ends.
    const candidates = this.db.prepare("SELECT frame, octet_length(data) AS bytes FROM terminal_frames WHERE terminal_id = ? AND frame > ? AND frame <= ? ORDER BY frame LIMIT 256")
      .all(id, after, through) as { frame: number; bytes: number }[];
    let end = after, bytes = 0;
    for (const candidate of candidates) {
      if (end > after && bytes + candidate.bytes > 512 * 1024) break;
      bytes += candidate.bytes; end = candidate.frame;
    }
    return this.db.prepare("SELECT frame, cols, rows, data FROM terminal_frames WHERE terminal_id = ? AND frame > ? AND frame <= ? ORDER BY frame")
      .all(id, after, end) as { frame: number; cols: number; rows: number; data: string }[];
  }

  deleteTerminal(id: string): void {
    this.db.prepare("DELETE FROM terminal_snapshots WHERE terminal_id = ?").run(id);
    this.db.prepare("DELETE FROM terminal_frames WHERE terminal_id = ?").run(id);
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
      .prepare(`SELECT cwd, MAX(updated_at) AS last_active_at, COUNT(*) AS session_count FROM sessions WHERE archived = 0 GROUP BY cwd`)
      .all() as { cwd: string; last_active_at: number; session_count: number }[];
    // A session in a worktree belongs to the project the worktree was made from.
    const worktrees = this.listWorktrees();
    const projects = new Map<string, ProjectSummary>();
    for (const row of rows) {
      const cwd = projectOf(row.cwd, worktrees);
      const project = projects.get(cwd) ?? { cwd, name: basename(cwd) || cwd, lastActiveAt: 0, sessionCount: 0 };
      project.lastActiveAt = Math.max(project.lastActiveAt, row.last_active_at);
      project.sessionCount += row.session_count;
      projects.set(cwd, project);
    }
    return [...projects.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, limit);
  }

  // ── worktrees ─────────────────────────────────────────────────────

  saveWorktree(worktree: WorktreeRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO worktrees (path, branch, source, source_cwd, base, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(worktree.path, worktree.branch, worktree.source, worktree.sourceCwd, worktree.base, worktree.createdAt);
  }

  listWorktrees(): WorktreeRecord[] {
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
    this.db.prepare("DELETE FROM worktrees WHERE path = ?").run(path);
  }

  /** Sessions whose directory is `path` or inside it. */
  sessionsUnder(path: string): string[] {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE cwd = ? OR substr(cwd, 1, ?) = ?").all(path, path.length + 1, `${path}/`) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** The seq of the latest event that mentions message or tool call `itemId`, and how many turns had started by then. */
  locateItem(sessionId: string, itemId: string): { seq: number; turn: number } | undefined {
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
    const next = this.db
      .prepare("SELECT MIN(seq) AS seq FROM event_meta WHERE session_id = ? AND kind = 'user_message_chunk' AND seq > ?")
      .get(sessionId, seq) as { seq: number | null };
    return next.seq ? next.seq - 1 : (this.getSession(sessionId)?.lastSeq ?? seq);
  }

  /**
   * Appends one update to the session's log and returns it with its seq.
   * `activity` false: the session's "last updated" stays (a setting or a name
   * is not something happening in the session).
   */
  appendEvent(sessionId: string, update: SessionUpdate, ts = Date.now(), activity = true): SessionEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(sessionId) as
        | { last_seq: number }
        | undefined;
      if (!row) throw new Error(`unknown session ${sessionId}`);
      const seq = row.last_seq + 1;
      const body = JSON.stringify(update);
      this.db.prepare("INSERT INTO events (session_id, seq, ts, body) VALUES (?, ?, ?, ?)").run(sessionId, seq, ts, body);
      const fields = update as { toolCallId?: string; parentToolCallId?: string };
      const opensTurn =
        update.sessionUpdate === "user_message_chunk" || (update.sessionUpdate === "ls_turn" && update.state === "started" && !fields.parentToolCallId);
      const spawns = update.sessionUpdate === "tool_call" && update.detail?.type === "subagent" && (update.detail.action ?? "spawn") === "spawn";
      this.db
        .prepare("INSERT INTO event_meta (session_id, seq, kind, bytes, opens_turn, tool, parent, spawns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, seq, update.sessionUpdate, Buffer.byteLength(body), opensTurn ? 1 : 0, fields.toolCallId ?? null, fields.parentToolCallId ?? null, spawns ? 1 : 0);
      this.db.prepare("UPDATE sessions SET last_seq = ?, updated_at = MAX(updated_at, ?) WHERE id = ?").run(seq, activity ? ts : 0, sessionId);
      this.db.exec("COMMIT");
      return { sessionId, seq, ts, update };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Events after `afterSeq`, up to and including `upToSeq` when given. */
  readEvents(sessionId: string, afterSeq: number, limit = 5000, upToSeq = Number.MAX_SAFE_INTEGER): SessionEvent[] {
    const rows = this.db
      .prepare("SELECT seq, ts, body FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, afterSeq, upToSeq, limit) as { seq: number; ts: number; body: string }[];
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  readEvent(sessionId: string, seq: number): SessionEvent | undefined {
    return this.readEvents(sessionId, seq - 1, 1, seq)[0];
  }

  /** How much was logged after `afterSeq`. */
  sizeAfter(sessionId: string, afterSeq: number): { events: number; bytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS events, COALESCE(SUM(bytes), 0) AS bytes FROM event_meta WHERE session_id = ? AND seq > ?")
      .get(sessionId, afterSeq) as { events: number; bytes: number };
    return row;
  }

  /**
   * Where a page of history ending at `beforeSeq` starts: the seq before its
   * first event (0: the beginning of the log). Pages are whole turns, going
   * back until one is worth showing; a single turn too big for a page is cut.
   */
  pageStart(sessionId: string, beforeSeq: number, page: PageBudget = PAGE): number {
    const rows = this.db
      .prepare("SELECT seq, bytes, opens_turn FROM event_meta WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, beforeSeq, page.maxEvents + 1) as { seq: number; bytes: number; opens_turn: number }[];
    let events = 0;
    let bytes = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const previous = rows[i + 1];
      events += 1;
      // What a client receives: pictures are left out and long text is cut.
      bytes += Math.min(row.bytes, page.eventBytes);
      if (!previous) return 0;
      const turnStarts = row.opens_turn === 1 && previous.opens_turn === 0;
      if (turnStarts && (events >= page.minEvents || bytes >= page.minBytes)) return previous.seq;
      if (events >= page.maxEvents || bytes >= page.maxBytes) return previous.seq;
    }
    return 0;
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
    const rows = this.db
      .prepare(`SELECT e.seq, e.ts, e.body FROM event_meta m JOIN events e ON e.session_id = m.session_id AND e.seq = m.seq WHERE ${where}`)
      .all(...values) as { seq: number; ts: number; body: string }[];
    const sessionId = String(values[0]);
    return rows.map((row) => ({ sessionId, seq: row.seq, ts: row.ts, update: JSON.parse(row.body) as SessionUpdate }));
  }

  /** Every background-task record the session logged, oldest first (each is a whole record: the last per task holds). */
  taskEvents(sessionId: string): SessionEvent[] {
    return this.joined("m.session_id = ? AND m.kind = 'ls_task' ORDER BY m.seq ASC", [sessionId]);
  }

  /** The latest event of `kind` at or before `seq`. */
  latestOfKind(sessionId: string, kind: SessionUpdate["sessionUpdate"], seq: number, limit = 1): SessionEvent[] {
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
