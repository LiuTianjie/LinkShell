import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RpcError } from "@linkshell/wire";
import {
  LSA_DEFAULT_MAX_RETRIES,
  LSA_DEFAULT_MEMORY_CHAR_LIMIT,
  lsaAcceptanceCheckSchema,
  type LsaAcceptanceCheck,
  type LsaFollowup,
  type LsaFollowupStatus,
  type LsaGeneration,
  type LsaMemory,
  type LsaTask,
  type LsaTaskStatus,
} from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lsa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lsa_session_fences (
  session_id TEXT PRIMARY KEY,
  controller_epoch INTEGER NOT NULL,
  hijacked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lsa_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'verifying', 'waiting_decision', 'completed', 'failed', 'cancelled')),
  cwd TEXT NOT NULL,
  worktree INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  agent TEXT NOT NULL,
  session_id TEXT,
  controller_epoch INTEGER NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  verification_summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lsa_tasks_status_updated ON lsa_tasks (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lsa_tasks_session ON lsa_tasks (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lsa_tasks_cwd ON lsa_tasks (cwd);

CREATE TABLE IF NOT EXISTS lsa_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'private',
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_lsa_memories_scope_updated ON lsa_memories (scope, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS lsa_memories_fts USING fts5(
  memory_id UNINDEXED,
  scope UNINDEXED,
  key,
  content,
  tags,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS lsa_followups (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES lsa_tasks(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  triggered_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'triggered', 'done', 'cancelled')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lsa_followups_due ON lsa_followups (status, due_at ASC);
CREATE INDEX IF NOT EXISTS idx_lsa_followups_task ON lsa_followups (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lsa_generations (
  generation INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  handoff_summary TEXT
);
`;

interface TaskRow {
  id: string;
  title: string;
  goal: string;
  status: LsaTaskStatus;
  cwd: string;
  worktree: number;
  worktree_path: string | null;
  agent: string;
  session_id: string | null;
  controller_epoch: number;
  acceptance_json: string;
  verification_summary: string | null;
  retry_count: number;
  max_retries: number;
  generation: number;
  created_at: number;
  updated_at: number;
}

interface MemoryRow {
  id: string;
  scope: string;
  key: string;
  content: string;
  tags_json: string;
  updated_at: number;
}

interface FollowupRow {
  id: string;
  task_id: string | null;
  note: string;
  due_at: number;
  triggered_at: number | null;
  status: LsaFollowupStatus;
  created_at: number;
}

interface GenerationRow {
  generation: number;
  started_at: number;
  ended_at: number | null;
  token_estimate: number;
  handoff_summary: string | null;
}

export interface LsaTaskInsert {
  id?: string;
  title: string;
  goal: string;
  status?: LsaTaskStatus;
  cwd: string;
  worktree?: boolean;
  worktreePath?: string;
  agent: string;
  sessionId?: string;
  controllerEpoch: number;
  acceptanceChecks?: LsaAcceptanceCheck[];
  verificationSummary?: string;
  retryCount?: number;
  maxRetries?: number;
  generation?: number;
  createdAt?: number;
  updatedAt?: number;
}

export type LsaTaskPatch = Partial<{
  title: string;
  goal: string;
  status: LsaTaskStatus;
  cwd: string;
  worktree: boolean;
  worktreePath: string | null;
  agent: string;
  sessionId: string | null;
  controllerEpoch: number;
  acceptanceChecks: LsaAcceptanceCheck[];
  verificationSummary: string | null;
  retryCount: number;
  maxRetries: number;
  updatedAt: number;
}>;

function parseChecks(raw: string): LsaAcceptanceCheck[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const checks: LsaAcceptanceCheck[] = [];
    for (const entry of parsed) {
      if (typeof entry === "string") {
        checks.push({
          id: `check-${checks.length + 1}`,
          raw: entry,
          kind: "assertion",
          label: entry,
        });
        continue;
      }
      const candidate =
        entry && typeof entry === "object" && !("raw" in entry) && "label" in entry
          ? { ...(entry as Record<string, unknown>), raw: String((entry as { label: unknown }).label) }
          : entry;
      const result = lsaAcceptanceCheckSchema.safeParse(candidate);
      if (result.success) checks.push(result.data);
    }
    return checks;
  } catch {
    return [];
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function rowToTask(row: TaskRow): LsaTask {
  const summary = row.verification_summary ?? undefined;
  const checks = parseChecks(row.acceptance_json);
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    cwd: row.cwd,
    worktree: row.worktree === 1,
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    agent: row.agent,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    controllerEpoch: row.controller_epoch,
    acceptanceChecks: checks.map((check) => check.raw),
    checks,
    ...(summary !== undefined ? { verificationSummary: summary, summary } : {}),
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMemory(row: MemoryRow): LsaMemory {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    content: row.content,
    tags: parseTags(row.tags_json),
    updatedAt: row.updated_at,
  };
}

function rowToFollowup(row: FollowupRow): LsaFollowup {
  return {
    id: row.id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    note: row.note,
    dueAt: row.due_at,
    ...(row.triggered_at !== null ? { triggeredAt: row.triggered_at } : {}),
    status: row.status,
    done: row.status === "done",
    createdAt: row.created_at,
  };
}

function rowToGeneration(row: GenerationRow): LsaGeneration {
  return {
    generation: row.generation,
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    tokenEstimate: row.token_estimate,
    ...(row.handoff_summary !== null ? { handoffSummary: row.handoff_summary } : {}),
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function lsaDatabasePath(linkshellHome: string): string {
  return join(linkshellHome, "lsa.db");
}

export interface LsaStoreOptions {
  /** Direct SQLite file path or `":memory:"`. */
  dbPath?: string;
  /** `<linkshellHome>` directory; resolves `<linkshellHome>/lsa.db` when `dbPath` is omitted. */
  home?: string;
  /** Initial monotonic controller epoch when creating a fresh database (default: 1). */
  initialEpoch?: number;
  now?: () => number;
}

/**
 * Deterministic SQLite ledger for LinkShell Agent (LSA) Phase 1 (`<linkshellHome>/lsa.db`).
 * Context is treated purely as disposable cache; tasks, epoch fences, memories, followups,
 * and generation handoffs all live durably here.
 */
export class LsaStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private closed = false;
  private txDepth = 0;

  constructor(options: LsaStoreOptions | string) {
    const normalized: LsaStoreOptions =
      typeof options === "string" ? { dbPath: options } : options;
    const resolvedPath =
      normalized.dbPath ??
      (normalized.home ? lsaDatabasePath(normalized.home) : ":memory:");
    this.dbPath = resolvedPath;
    this.clock = normalized.now ?? (() => Date.now());

    if (resolvedPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(resolvedPath);
    if (resolvedPath !== ":memory:" && process.platform !== "win32") {
      try {
        chmodSync(resolvedPath, 0o600);
      } catch {
        // Best-effort permission hardening.
      }
    }
    this.db.exec(SCHEMA);
    this.initializeDefaults(normalized.initialEpoch ?? 1);
  }

  private initializeDefaults(initialEpoch: number): void {
    const safeInitial = Math.max(1, Math.trunc(initialEpoch));
    this.inTransaction(() => {
      const { user_version: version } = this.db
        .prepare("PRAGMA user_version")
        .get() as { user_version: number };
      if (version < 1) {
        this.db.exec("PRAGMA user_version = 1");
      }

      const existingEpoch = this.db
        .prepare("SELECT value FROM lsa_meta WHERE key = 'controller_epoch'")
        .get() as { value: string } | undefined;
      if (!existingEpoch) {
        this.db
          .prepare("INSERT INTO lsa_meta (key, value) VALUES ('controller_epoch', ?)")
          .run(String(safeInitial));
      } else {
        const stored = Number.parseInt(existingEpoch.value, 10) || 1;
        if (safeInitial > stored) {
          this.db
            .prepare("UPDATE lsa_meta SET value = ? WHERE key = 'controller_epoch'")
            .run(String(safeInitial));
        }
      }

      const activeGen = this.db
        .prepare("SELECT generation FROM lsa_generations ORDER BY generation DESC LIMIT 1")
        .get() as { generation: number } | undefined;
      if (!activeGen) {
        this.db
          .prepare(
            "INSERT INTO lsa_generations (generation, started_at, ended_at, token_estimate, handoff_summary) VALUES (1, ?, NULL, 0, NULL)",
          )
          .run(this.clock());
      }
    });
  }

  private inTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `lsa_sp_${this.txDepth}`;
      this.txDepth += 1;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const out = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ── Controller Epoch & Session Fencing ────────────────────────────

  getControllerEpoch(): number {
    if (this.closed) return 1;
    const row = this.db
      .prepare("SELECT value FROM lsa_meta WHERE key = 'controller_epoch'")
      .get() as { value: string } | undefined;
    const parsed = row ? Number.parseInt(row.value, 10) : 1;
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  }

  /**
   * Monotonically advances (or validates equal) `controller_epoch`.
   * Throws `RpcError` (`fenced`) if `requestedEpoch < currentEpoch`.
   * When omitted, increments the current epoch by 1.
   */
  advanceControllerEpoch(requestedEpoch?: number): number {
    if (this.closed) return requestedEpoch === undefined ? 1 : Math.max(1, Math.trunc(requestedEpoch));
    return this.inTransaction(() => {
      const current = this.getControllerEpoch();
      const target = requestedEpoch === undefined ? current + 1 : Math.trunc(requestedEpoch);
      if (!Number.isFinite(target) || target < 1) {
        throw RpcError.app("invalid_params", `无效的 controllerEpoch：${String(requestedEpoch)}`);
      }
      if (target < current) {
        throw RpcError.app(
          "fenced",
          `陈旧的主控代次（controllerEpoch=${target} < 当前 ${current}），操作已被拒绝`,
          { currentEpoch: current, requestedEpoch: target },
        );
      }
      if (target > current) {
        this.db
          .prepare("INSERT OR REPLACE INTO lsa_meta (key, value) VALUES ('controller_epoch', ?)")
          .run(String(target));
      }
      return target;
    });
  }

  claimSessionFence(sessionId: string, epoch: number): void {
    if (this.closed) return;
    const now = this.clock();
    this.inTransaction(() => {
      const existing = this.db
        .prepare("SELECT controller_epoch, hijacked FROM lsa_session_fences WHERE session_id = ?")
        .get(sessionId) as { controller_epoch: number; hijacked: number } | undefined;
      if (existing && epoch < existing.controller_epoch) {
        throw RpcError.app(
          "fenced",
          `会话 ${sessionId} 已由更高代次（epoch=${existing.controller_epoch}）接管，拒绝旧代次（epoch=${epoch}）修改`,
          { sessionEpoch: existing.controller_epoch, requestedEpoch: epoch },
        );
      }
      if (existing && existing.hijacked === 1 && epoch <= existing.controller_epoch) {
        throw RpcError.app(
          "fenced",
          `会话 ${sessionId} 已被外部接管（hijacked），旧代次（epoch=${epoch}）不可继续操作`,
          { sessionId, requestedEpoch: epoch },
        );
      }
      this.db
        .prepare(
          `INSERT INTO lsa_session_fences (session_id, controller_epoch, hijacked, updated_at)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             controller_epoch = excluded.controller_epoch,
             hijacked = 0,
             updated_at = excluded.updated_at`,
        )
        .run(sessionId, epoch, now);
    });
  }

  markSessionHijacked(sessionId: string, hijacked = true): void {
    if (this.closed) return;
    const now = this.clock();
    this.inTransaction(() => {
      const existing = this.db
        .prepare("SELECT controller_epoch FROM lsa_session_fences WHERE session_id = ?")
        .get(sessionId) as { controller_epoch: number } | undefined;
      const epoch = existing?.controller_epoch ?? this.getControllerEpoch();
      this.db
        .prepare(
          `INSERT INTO lsa_session_fences (session_id, controller_epoch, hijacked, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             hijacked = excluded.hijacked,
             updated_at = excluded.updated_at`,
        )
        .run(sessionId, epoch, hijacked ? 1 : 0, now);
    });
  }

  getSessionFence(sessionId: string): { controllerEpoch: number; hijacked: boolean } | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare("SELECT controller_epoch, hijacked FROM lsa_session_fences WHERE session_id = ?")
      .get(sessionId) as { controller_epoch: number; hijacked: number } | undefined;
    if (!row) return undefined;
    return { controllerEpoch: row.controller_epoch, hijacked: row.hijacked === 1 };
  }

  // ── Tasks (`lsa_tasks`) ───────────────────────────────────────────

  insertTask(input: LsaTaskInsert): LsaTask {
    const now = this.clock();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const id = input.id ?? `lsa_task_${randomUUID()}`;
    const status: LsaTaskStatus = input.status ?? "queued";
    const checksJson = JSON.stringify(input.acceptanceChecks ?? []);
    if (this.closed) {
      return rowToTask({
        id,
        title: input.title,
        goal: input.goal,
        status,
        cwd: input.cwd,
        worktree: input.worktree ? 1 : 0,
        worktree_path: input.worktreePath ?? null,
        agent: input.agent,
        session_id: input.sessionId ?? null,
        controller_epoch: input.controllerEpoch,
        acceptance_json: checksJson,
        verification_summary: input.verificationSummary ?? null,
        retry_count: input.retryCount ?? 0,
        max_retries: input.maxRetries ?? LSA_DEFAULT_MAX_RETRIES,
        generation: input.generation ?? 1,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }
    const generation = input.generation ?? this.currentGeneration().generation;

    this.inTransaction(() => {
      if (input.sessionId) {
        this.claimSessionFence(input.sessionId, input.controllerEpoch);
      }
      this.db
        .prepare(
          `INSERT INTO lsa_tasks (
             id, title, goal, status, cwd, worktree, worktree_path, agent, session_id,
             controller_epoch, acceptance_json, verification_summary,
             retry_count, max_retries, generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.goal,
          status,
          input.cwd,
          input.worktree ? 1 : 0,
          input.worktreePath ?? null,
          input.agent,
          input.sessionId ?? null,
          input.controllerEpoch,
          checksJson,
          input.verificationSummary ?? null,
          input.retryCount ?? 0,
          input.maxRetries ?? LSA_DEFAULT_MAX_RETRIES,
          generation,
          createdAt,
          updatedAt,
        );
    });

    return this.getTask(id)!;
  }

  getTask(id: string): LsaTask | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare("SELECT * FROM lsa_tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  findActiveTaskBySession(sessionId: string): LsaTask | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM lsa_tasks
         WHERE session_id = ? AND status IN ('running', 'verifying', 'queued', 'waiting_decision')
         ORDER BY controller_epoch DESC, updated_at DESC LIMIT 1`,
      )
      .get(sessionId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listActiveTasks(limit = 200): LsaTask[] {
    if (this.closed) return [];
    return this.listTasks({
      status: ["queued", "running", "verifying", "waiting_decision"],
      limit,
    });
  }

  listTasks(
    options: {
      status?: LsaTaskStatus | readonly LsaTaskStatus[];
      cwd?: string;
      limit?: number;
    } = {},
  ): LsaTask[] {
    if (this.closed) return [];
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      const list = typeof options.status === "string" ? [options.status] : [...options.status];
      if (list.length > 0) {
        clauses.push(`status IN (${list.map(() => "?").join(", ")})`);
        params.push(...list);
      }
    }
    if (options.cwd) {
      clauses.push("cwd = ?");
      params.push(options.cwd);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM lsa_tasks ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(id: string, patch: LsaTaskPatch, options?: { expectedEpoch?: number }): LsaTask {
    if (this.closed) {
      const now = patch.updatedAt ?? this.clock();
      return rowToTask({
        id,
        title: patch.title ?? "",
        goal: patch.goal ?? "",
        status: patch.status ?? "cancelled",
        cwd: patch.cwd ?? "",
        worktree: patch.worktree ? 1 : 0,
        worktree_path: patch.worktreePath ?? null,
        agent: patch.agent ?? "unknown",
        session_id: patch.sessionId ?? null,
        controller_epoch: patch.controllerEpoch ?? options?.expectedEpoch ?? 1,
        acceptance_json: JSON.stringify(patch.acceptanceChecks ?? []),
        verification_summary: patch.verificationSummary ?? null,
        retry_count: patch.retryCount ?? 0,
        max_retries: patch.maxRetries ?? LSA_DEFAULT_MAX_RETRIES,
        generation: 1,
        created_at: now,
        updated_at: now,
      });
    }
    return this.inTransaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM lsa_tasks WHERE id = ?")
        .get(id) as TaskRow | undefined;
      if (!existing) {
        throw RpcError.app("not_found", `找不到 LSA 任务：${id}`);
      }
      if (options?.expectedEpoch !== undefined && existing.controller_epoch !== options.expectedEpoch) {
        throw RpcError.app(
          "fenced",
          `任务 ${id} 所属代次（epoch=${existing.controller_epoch}）与请求代次（epoch=${options.expectedEpoch}）不匹配`,
          { taskEpoch: existing.controller_epoch, expectedEpoch: options.expectedEpoch },
        );
      }

      const sets: string[] = [];
      const values: (string | number | null)[] = [];

      if (patch.title !== undefined) {
        sets.push("title = ?");
        values.push(patch.title);
      }
      if (patch.goal !== undefined) {
        sets.push("goal = ?");
        values.push(patch.goal);
      }
      if (patch.status !== undefined) {
        sets.push("status = ?");
        values.push(patch.status);
      }
      if (patch.cwd !== undefined) {
        sets.push("cwd = ?");
        values.push(patch.cwd);
      }
      if (patch.worktree !== undefined) {
        sets.push("worktree = ?");
        values.push(patch.worktree ? 1 : 0);
      }
      if (patch.worktreePath !== undefined) {
        sets.push("worktree_path = ?");
        values.push(patch.worktreePath);
      }
      if (patch.agent !== undefined) {
        sets.push("agent = ?");
        values.push(patch.agent);
      }
      if (patch.sessionId !== undefined) {
        sets.push("session_id = ?");
        values.push(patch.sessionId);
        if (patch.sessionId) {
          this.claimSessionFence(patch.sessionId, patch.controllerEpoch ?? existing.controller_epoch);
        }
      }
      if (patch.controllerEpoch !== undefined) {
        sets.push("controller_epoch = ?");
        values.push(patch.controllerEpoch);
      }
      if (patch.acceptanceChecks !== undefined) {
        sets.push("acceptance_json = ?");
        values.push(JSON.stringify(patch.acceptanceChecks));
      }
      if (patch.verificationSummary !== undefined) {
        sets.push("verification_summary = ?");
        values.push(patch.verificationSummary);
      }
      if (patch.retryCount !== undefined) {
        sets.push("retry_count = ?");
        values.push(patch.retryCount);
      }
      if (patch.maxRetries !== undefined) {
        sets.push("max_retries = ?");
        values.push(patch.maxRetries);
      }

      const updatedAt = patch.updatedAt ?? this.clock();
      sets.push("updated_at = ?");
      values.push(updatedAt);

      this.db
        .prepare(`UPDATE lsa_tasks SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values, id);

      return this.getTask(id)!;
    });
  }

  // ── Memories (`lsa_memories` + FTS5 / Keyword Search) ─────────────

  saveMemory(input: {
    id?: string;
    scope?: string;
    key: string;
    content: string;
    tags?: readonly string[];
    updatedAt?: number;
    maxChars?: number;
  }): LsaMemory {
    const scope = (input.scope ?? "private").trim() || "private";
    const key = input.key.trim();
    if (!key) throw RpcError.app("invalid_params", "记忆键名（key）不能为空");
    const maxChars = input.maxChars ?? LSA_DEFAULT_MEMORY_CHAR_LIMIT;
    if ([...input.content].length > maxChars) {
      throw RpcError.app(
        "too_large",
        `记忆内容超出上限（当前 ${[...input.content].length} 字，上限 ${maxChars} 字），请先合并精简`,
      );
    }
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(" ");
    const updatedAt = input.updatedAt ?? this.clock();

    if (this.closed) {
      return {
        id: input.id ?? `lsa_mem_${randomUUID()}`,
        scope,
        key,
        content: input.content,
        tags,
        updatedAt,
      };
    }

    return this.inTransaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM lsa_memories WHERE scope = ? AND key = ?")
        .get(scope, key) as { id: string } | undefined;
      const id = existing?.id ?? input.id ?? `lsa_mem_${randomUUID()}`;

      this.db
        .prepare(
          `INSERT INTO lsa_memories (id, scope, key, content, tags_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET
             content = excluded.content,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .run(id, scope, key, input.content, tagsJson, updatedAt);

      this.db.prepare("DELETE FROM lsa_memories_fts WHERE memory_id = ?").run(id);
      this.db
        .prepare(
          "INSERT INTO lsa_memories_fts (memory_id, scope, key, content, tags) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, scope, key, input.content, tagsText);

      const saved = this.db
        .prepare("SELECT * FROM lsa_memories WHERE id = ?")
        .get(id) as unknown as MemoryRow;
      return rowToMemory(saved);
    });
  }

  getMemory(scope: string, key: string): LsaMemory | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare("SELECT * FROM lsa_memories WHERE scope = ? AND key = ?")
      .get(scope, key) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  deleteMemory(target: { id?: string; scope?: string; key?: string }): boolean {
    if (this.closed) return false;
    return this.inTransaction(() => {
      let row: { id: string } | undefined;
      if (target.id) {
        row = this.db
          .prepare("SELECT id FROM lsa_memories WHERE id = ?")
          .get(target.id) as { id: string } | undefined;
      } else if (target.key) {
        row = this.db
          .prepare("SELECT id FROM lsa_memories WHERE scope = ? AND key = ?")
          .get(target.scope ?? "private", target.key) as { id: string } | undefined;
      }
      if (!row) return false;
      this.db.prepare("DELETE FROM lsa_memories_fts WHERE memory_id = ?").run(row.id);
      this.db.prepare("DELETE FROM lsa_memories WHERE id = ?").run(row.id);
      return true;
    });
  }

  searchMemories(
    options: {
      query?: string;
      scope?: string;
      tags?: readonly string[];
      limit?: number;
    } = {},
  ): LsaMemory[] {
    if (this.closed) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const trimmedQuery = options.query?.trim() ?? "";
    const requiredTags = (options.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

    const filterByTags = (items: LsaMemory[]): LsaMemory[] => {
      if (requiredTags.length === 0) return items;
      return items.filter((mem) => {
        const lowerTags = new Set(mem.tags.map((t) => t.toLowerCase()));
        return requiredTags.every((tag) => lowerTags.has(tag));
      });
    };

    if (!trimmedQuery) {
      const rows = options.scope
        ? (this.db
            .prepare("SELECT * FROM lsa_memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?")
            .all(options.scope, limit * 2) as unknown as MemoryRow[])
        : (this.db
            .prepare("SELECT * FROM lsa_memories ORDER BY updated_at DESC LIMIT ?")
            .all(limit * 2) as unknown as MemoryRow[]);
      return filterByTags(rows.map(rowToMemory)).slice(0, limit);
    }

    const tokens = trimmedQuery.split(/\s+/).filter(Boolean);
    const ftsTokens = tokens.filter((tok) => [...tok].length >= 3);
    const resultsById = new Map<string, { memory: LsaMemory; score: number }>();

    // 1. FTS5 trigram match for 3+ character substrings (handles English + CJK).
    if (ftsTokens.length > 0) {
      const ftsExpr = ftsTokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(" OR ");
      try {
        const sql = options.scope
          ? `SELECT m.*, bm25(lsa_memories_fts, 0.0, 0.0, 3.0, 1.5, 2.0) AS rank
             FROM lsa_memories_fts
             JOIN lsa_memories m ON m.id = lsa_memories_fts.memory_id
             WHERE lsa_memories_fts MATCH ? AND m.scope = ?
             ORDER BY rank ASC, m.updated_at DESC
             LIMIT ?`
          : `SELECT m.*, bm25(lsa_memories_fts, 0.0, 0.0, 3.0, 1.5, 2.0) AS rank
             FROM lsa_memories_fts
             JOIN lsa_memories m ON m.id = lsa_memories_fts.memory_id
             WHERE lsa_memories_fts MATCH ?
             ORDER BY rank ASC, m.updated_at DESC
             LIMIT ?`;
        const rows = (
          options.scope
            ? this.db.prepare(sql).all(ftsExpr, options.scope, limit * 3)
            : this.db.prepare(sql).all(ftsExpr, limit * 3)
        ) as unknown as (MemoryRow & { rank: number })[];
        for (const row of rows) {
          const mem = rowToMemory(row);
          // bm25 returns negative numbers where smaller = better match.
          resultsById.set(mem.id, { memory: mem, score: 100 - row.rank });
        }
      } catch {
        // Fall through to deterministic LIKE keyword matching if FTS expression cannot parse.
      }
    }

    // 2. Keyword LIKE match (handles 1–2 char CJK/short acronyms and exact key/tag matches).
    const likeClauses: string[] = [];
    const likeParams: (string | number)[] = [];
    if (options.scope) {
      likeClauses.push("scope = ?");
      likeParams.push(options.scope);
    }
    const tokenOrs: string[] = [];
    for (const tok of tokens) {
      const pattern = `%${escapeLike(tok.toLowerCase())}%`;
      tokenOrs.push(
        "(LOWER(key) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')",
      );
      likeParams.push(pattern, pattern, pattern);
    }
    if (tokenOrs.length > 0) {
      likeClauses.push(`(${tokenOrs.join(" OR ")})`);
    }
    const likeWhere = likeClauses.length > 0 ? `WHERE ${likeClauses.join(" AND ")}` : "";
    const likeRows = this.db
      .prepare(`SELECT * FROM lsa_memories ${likeWhere} ORDER BY updated_at DESC LIMIT ?`)
      .all(...likeParams, limit * 3) as unknown as MemoryRow[];

    const lowerFull = trimmedQuery.toLowerCase();
    for (const row of likeRows) {
      const mem = rowToMemory(row);
      const lowerKey = mem.key.toLowerCase();
      const lowerContent = mem.content.toLowerCase();
      let bonus = 10;
      if (lowerKey === lowerFull) bonus += 120;
      else if (lowerKey.includes(lowerFull)) bonus += 60;
      if (lowerContent.includes(lowerFull)) bonus += 35;
      const matchedCount = tokens.filter(
        (tok) =>
          lowerKey.includes(tok.toLowerCase()) ||
          lowerContent.includes(tok.toLowerCase()) ||
          mem.tags.some((t) => t.toLowerCase().includes(tok.toLowerCase())),
      ).length;
      bonus += matchedCount * 20;
      const prev = resultsById.get(mem.id);
      resultsById.set(mem.id, {
        memory: mem,
        score: (prev?.score ?? 0) + bonus,
      });
    }

    const ranked = [...resultsById.values()]
      .sort(
        (a, b) =>
          b.score - a.score || b.memory.updatedAt - a.memory.updatedAt,
      )
      .map((entry) => entry.memory);

    return filterByTags(ranked).slice(0, limit);
  }

  // ── Followups (`lsa_followups`) ───────────────────────────────────

  scheduleFollowup(input: {
    id?: string;
    taskId?: string;
    note: string;
    dueAt: number;
    createdAt?: number;
  }): LsaFollowup {
    const note = input.note.trim();
    if (!note) throw RpcError.app("invalid_params", "跟进提醒内容（note）不能为空");
    if (!Number.isFinite(input.dueAt)) {
      throw RpcError.app("invalid_params", "跟进到期时间（dueAt）无效");
    }
    const id = input.id ?? `lsa_fu_${randomUUID()}`;
    const createdAt = input.createdAt ?? this.clock();
    const dueAt = Math.trunc(input.dueAt);
    if (this.closed) {
      return {
        id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        note,
        dueAt,
        status: "pending",
        done: false,
        createdAt,
      };
    }

    this.db
      .prepare(
        `INSERT INTO lsa_followups (id, task_id, note, due_at, triggered_at, status, created_at)
         VALUES (?, ?, ?, ?, NULL, 'pending', ?)`,
      )
      .run(id, input.taskId ?? null, note, dueAt, createdAt);

    return this.getFollowup(id)!;
  }

  getFollowup(id: string): LsaFollowup | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare("SELECT * FROM lsa_followups WHERE id = ?")
      .get(id) as FollowupRow | undefined;
    return row ? rowToFollowup(row) : undefined;
  }

  listFollowups(
    options: {
      taskId?: string;
      status?: LsaFollowupStatus | readonly LsaFollowupStatus[];
      includeDone?: boolean;
      limit?: number;
    } = {},
  ): LsaFollowup[] {
    if (this.closed) return [];
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.status) {
      const list = typeof options.status === "string" ? [options.status] : [...options.status];
      if (list.length > 0) {
        clauses.push(`status IN (${list.map(() => "?").join(", ")})`);
        params.push(...list);
      }
    } else if (options.includeDone === false) {
      clauses.push("status IN ('pending', 'triggered')");
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM lsa_followups ${where} ORDER BY due_at ASC, created_at ASC LIMIT ?`)
      .all(...params, limit) as unknown as FollowupRow[];
    return rows.map(rowToFollowup);
  }

  /**
   * Atomically claims all pending followups due at or before `now`, marking them
   * `triggered` with `triggered_at = now` so repeated polls never double-fire.
   */
  claimDueFollowups(now = this.clock()): LsaFollowup[] {
    if (this.closed) return [];
    return this.inTransaction(() => {
      const dueRows = this.db
        .prepare(
          `SELECT * FROM lsa_followups
           WHERE status = 'pending' AND due_at <= ?
           ORDER BY due_at ASC, created_at ASC`,
        )
        .all(now) as unknown as FollowupRow[];
      if (dueRows.length === 0) return [];

      const markStmt = this.db.prepare(
        "UPDATE lsa_followups SET status = 'triggered', triggered_at = ? WHERE id = ?",
      );
      for (const row of dueRows) {
        markStmt.run(now, row.id);
      }
      return dueRows.map((row) =>
        rowToFollowup({ ...row, status: "triggered", triggered_at: now }),
      );
    });
  }

  nextPendingFollowupDueAt(): number | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare(
        "SELECT MIN(due_at) AS next_due FROM lsa_followups WHERE status = 'pending'",
      )
      .get() as { next_due: number | null } | undefined;
    return row?.next_due ?? undefined;
  }

  updateFollowupStatus(id: string, status: LsaFollowupStatus, now = this.clock()): LsaFollowup {
    if (this.closed) {
      return {
        id,
        note: "",
        dueAt: now,
        ...(status === "triggered" ? { triggeredAt: now } : {}),
        status,
        done: status === "done",
        createdAt: now,
      };
    }
    const existing = this.getFollowup(id);
    if (!existing) throw RpcError.app("not_found", `找不到跟进提醒：${id}`);
    const triggeredAt =
      status === "triggered" ? (existing.triggeredAt ?? now) : existing.triggeredAt ?? null;
    this.db
      .prepare("UPDATE lsa_followups SET status = ?, triggered_at = ? WHERE id = ?")
      .run(status, triggeredAt, id);
    return this.getFollowup(id)!;
  }

  cancelFollowupsForTask(taskId: string): number {
    if (this.closed) return 0;
    const result = this.db
      .prepare(
        "UPDATE lsa_followups SET status = 'cancelled' WHERE task_id = ? AND status = 'pending'",
      )
      .run(taskId);
    return Number(result.changes);
  }

  // ── Generations (`lsa_generations`) ───────────────────────────────

  currentGeneration(): LsaGeneration {
    if (this.closed) {
      return { generation: 1, startedAt: this.clock(), tokenEstimate: 0 };
    }
    const open = this.db
      .prepare(
        "SELECT * FROM lsa_generations WHERE ended_at IS NULL ORDER BY generation DESC LIMIT 1",
      )
      .get() as GenerationRow | undefined;
    if (open) return rowToGeneration(open);

    // Defensive recovery if every generation had been closed manually.
    const latest = this.db
      .prepare("SELECT MAX(generation) AS max_gen FROM lsa_generations")
      .get() as { max_gen: number | null };
    const nextGen = (latest.max_gen ?? 0) + 1;
    const now = this.clock();
    this.db
      .prepare(
        "INSERT INTO lsa_generations (generation, started_at, ended_at, token_estimate, handoff_summary) VALUES (?, ?, NULL, 0, NULL)",
      )
      .run(nextGen, now);
    return {
      generation: nextGen,
      startedAt: now,
      tokenEstimate: 0,
    };
  }

  getGeneration(generation: number): LsaGeneration | undefined {
    if (this.closed) return undefined;
    const row = this.db
      .prepare("SELECT * FROM lsa_generations WHERE generation = ?")
      .get(generation) as GenerationRow | undefined;
    return row ? rowToGeneration(row) : undefined;
  }

  listGenerations(limit = 50): LsaGeneration[] {
    if (this.closed) return [];
    const rows = this.db
      .prepare("SELECT * FROM lsa_generations ORDER BY generation DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as unknown as GenerationRow[];
    return rows.map(rowToGeneration);
  }

  updateCurrentGenerationTokens(tokenEstimate: number): LsaGeneration {
    const safeTokens = Math.max(0, Math.trunc(tokenEstimate));
    if (this.closed) {
      return { generation: 1, startedAt: this.clock(), tokenEstimate: safeTokens };
    }
    return this.inTransaction(() => {
      const current = this.currentGeneration();
      this.db
        .prepare("UPDATE lsa_generations SET token_estimate = ? WHERE generation = ?")
        .run(safeTokens, current.generation);
      return { ...current, tokenEstimate: safeTokens };
    });
  }

  rotateGeneration(input: {
    tokenEstimate: number;
    handoffSummary: string;
    now?: number;
  }): { closed: LsaGeneration; current: LsaGeneration } {
    const now = input.now ?? this.clock();
    const safeTokens = Math.max(0, Math.trunc(input.tokenEstimate));
    if (this.closed) {
      return {
        closed: {
          generation: 1,
          startedAt: now,
          endedAt: now,
          tokenEstimate: safeTokens,
          handoffSummary: input.handoffSummary,
        },
        current: {
          generation: 2,
          startedAt: now,
          tokenEstimate: 0,
        },
      };
    }

    return this.inTransaction(() => {
      const prev = this.currentGeneration();
      this.db
        .prepare(
          `UPDATE lsa_generations
           SET ended_at = ?, token_estimate = ?, handoff_summary = ?
           WHERE generation = ?`,
        )
        .run(now, safeTokens, input.handoffSummary, prev.generation);

      const nextNum = prev.generation + 1;
      this.db
        .prepare(
          `INSERT INTO lsa_generations (generation, started_at, ended_at, token_estimate, handoff_summary)
           VALUES (?, ?, NULL, 0, NULL)`,
        )
        .run(nextNum, now);

      return {
        closed: this.getGeneration(prev.generation)!,
        current: this.getGeneration(nextNum)!,
      };
    });
  }
}
