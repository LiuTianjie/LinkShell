import type { ClientSnapshot, SnapshotStorage } from "@linkshell/client-core";
import { Platform } from "react-native";

export const SNAPSHOT_DB_NAME = "linkshell-snapshots.db";

/** Cap individual serialized SessionViews so huge tool outputs never bloat startup hydration. */
const MAX_VIEW_JSON_CHARS = 512 * 1024;
/** Retain snapshots for at most the 8 most recently used computers. */
const MAX_CACHED_COMPUTERS = 8;

export interface SnapshotSQLiteDatabase {
  execSync(source: string): void;
  runSync(source: string, ...params: (string | number | null)[]): unknown;
  getAllSync<T>(source: string, ...params: (string | number | null)[]): T[];
  withTransactionSync?(task: () => void): void;
}

function defaultOpenDatabase(): SnapshotSQLiteDatabase | null {
  if (Platform.OS === "web") return null;
  try {
    const sqlite = require("expo-sqlite") as typeof import("expo-sqlite");
    if (typeof sqlite.openDatabaseSync !== "function") return null;
    return sqlite.openDatabaseSync(SNAPSHOT_DB_NAME);
  } catch {
    return null;
  }
}

function cloneSnapshot(snapshot: ClientSnapshot): ClientSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ClientSnapshot;
}

export interface SyncSnapshotStorage extends SnapshotStorage {
  load(key: string): ClientSnapshot | undefined;
  save(key: string, snapshot: ClientSnapshot): void;
  clear(key: string): void;
}

/**
 * Synchronous local SQLite snapshot cache for instant 0ms cold-start hydration of sessions,
 * projects, machine capabilities, and recent conversation timelines, falling back cleanly to
 * memory in tests or environments without native ExpoSQLite.
 */
export function createSnapshotStorage(openDb: () => SnapshotSQLiteDatabase | null = defaultOpenDatabase): SyncSnapshotStorage {
  let db: SnapshotSQLiteDatabase | undefined;
  const memory = new Map<string, ClientSnapshot>();

  const getDb = (): SnapshotSQLiteDatabase | null => {
    if (db !== undefined) return db;
    try {
      const opened = openDb();
      if (!opened) return null;
      opened.execSync(
        `CREATE TABLE IF NOT EXISTS computer_snapshots (
          computer_key TEXT PRIMARY KEY NOT NULL,
          machine_json TEXT,
          sessions_json TEXT NOT NULL,
          next_before INTEGER,
          next_before_id TEXT,
          projects_json TEXT NOT NULL,
          saved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS computer_view_snapshots (
          computer_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ord INTEGER NOT NULL DEFAULT 0,
          view_json TEXT NOT NULL,
          PRIMARY KEY (computer_key, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_view_snapshots_ord
          ON computer_view_snapshots (computer_key, ord ASC);`,
      );
      db = opened;
      return db;
    } catch {
      db = undefined;
      return null;
    }
  };

  const runTx = (database: SnapshotSQLiteDatabase, work: () => void) => {
    if (database.withTransactionSync) {
      database.withTransactionSync(work);
      return;
    }
    database.execSync("BEGIN IMMEDIATE");
    try {
      work();
      database.execSync("COMMIT");
    } catch (error) {
      try {
        database.execSync("ROLLBACK");
      } catch {}
      throw error;
    }
  };

  return {
    load(key: string): ClientSnapshot | undefined {
      if (!key || key === "none") return undefined;
      const database = getDb();
      if (database) {
        try {
          const rows = database.getAllSync<{
            machine_json: string | null;
            sessions_json: string;
            next_before: number | null;
            next_before_id: string | null;
            projects_json: string;
            saved_at: number;
          }>(
            "SELECT machine_json, sessions_json, next_before, next_before_id, projects_json, saved_at FROM computer_snapshots WHERE computer_key = ? LIMIT 1",
            key,
          );
          const head = rows[0];
          if (!head) return undefined;
          const sessions = JSON.parse(head.sessions_json) as ClientSnapshot["sessions"];
          const projects = JSON.parse(head.projects_json) as ClientSnapshot["projects"];
          if (!Array.isArray(sessions) || !Array.isArray(projects)) return undefined;
          let machine: ClientSnapshot["machine"];
          if (typeof head.machine_json === "string" && head.machine_json) {
            try {
              const parsed = JSON.parse(head.machine_json) as ClientSnapshot["machine"];
              if (parsed && typeof parsed === "object" && !parsed.locked) machine = parsed;
            } catch {
              // Ignore corrupt machine metadata without losing cached sessions.
            }
          }
          const viewRows = database.getAllSync<{ view_json: string }>(
            "SELECT view_json FROM computer_view_snapshots WHERE computer_key = ? ORDER BY ord ASC",
            key,
          );
          const views: ClientSnapshot["views"] = [];
          for (const row of viewRows) {
            if (typeof row.view_json !== "string" || !row.view_json) continue;
            try {
              const parsed = JSON.parse(row.view_json) as ClientSnapshot["views"][number];
              if (parsed && typeof parsed.sessionId === "string" && Array.isArray(parsed.items)) {
                views.push(parsed);
              }
            } catch {
              // Skip one corrupt view row cleanly.
            }
          }
          const snapshot: ClientSnapshot = {
            ...(machine ? { machine } : {}),
            sessions,
            ...(typeof head.next_before === "number" && Number.isFinite(head.next_before) ? { sessionsNextBefore: head.next_before } : {}),
            ...(typeof head.next_before_id === "string" && head.next_before_id ? { sessionsNextBeforeId: head.next_before_id } : {}),
            projects,
            views,
            savedAt: typeof head.saved_at === "number" && Number.isFinite(head.saved_at) ? head.saved_at : Date.now(),
          };
          memory.set(key, cloneSnapshot(snapshot));
          return snapshot;
        } catch {
          db = undefined;
        }
      }
      const cached = memory.get(key);
      return cached ? cloneSnapshot(cached) : undefined;
    },

    save(key: string, snapshot: ClientSnapshot): void {
      if (!key || key === "none") return;
      if (snapshot.machine?.locked) return;
      const boundedViews: ClientSnapshot["views"] = [];
      const serializedViews: { sessionId: string; json: string }[] = [];
      for (const view of snapshot.views ?? []) {
        if (!view?.sessionId || !Array.isArray(view.items)) continue;
        try {
          const json = JSON.stringify(view);
          if (json.length <= MAX_VIEW_JSON_CHARS) {
            boundedViews.push(view);
            serializedViews.push({ sessionId: view.sessionId, json });
          }
        } catch {
          // Skip unserializable view.
        }
      }
      const normalized: ClientSnapshot = {
        ...(snapshot.machine && !snapshot.machine.locked ? { machine: snapshot.machine } : {}),
        sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions : [],
        ...(snapshot.sessionsNextBefore !== undefined ? { sessionsNextBefore: snapshot.sessionsNextBefore } : {}),
        ...(snapshot.sessionsNextBeforeId !== undefined ? { sessionsNextBeforeId: snapshot.sessionsNextBeforeId } : {}),
        projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
        views: boundedViews,
        savedAt: typeof snapshot.savedAt === "number" && Number.isFinite(snapshot.savedAt) ? Math.trunc(snapshot.savedAt) : Date.now(),
      };

      memory.delete(key);
      memory.set(key, cloneSnapshot(normalized));
      while (memory.size > MAX_CACHED_COMPUTERS) {
        const oldest = memory.keys().next().value as string | undefined;
        if (!oldest || oldest === key) break;
        memory.delete(oldest);
      }

      const database = getDb();
      if (!database) return;

      try {
        const machineJson = normalized.machine ? JSON.stringify(normalized.machine) : null;
        const sessionsJson = JSON.stringify(normalized.sessions);
        const projectsJson = JSON.stringify(normalized.projects);
        runTx(database, () => {
          database.runSync(
            `INSERT OR REPLACE INTO computer_snapshots
              (computer_key, machine_json, sessions_json, next_before, next_before_id, projects_json, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            key,
            machineJson,
            sessionsJson,
            normalized.sessionsNextBefore ?? null,
            normalized.sessionsNextBeforeId ?? null,
            projectsJson,
            normalized.savedAt,
          );
          database.runSync("DELETE FROM computer_view_snapshots WHERE computer_key = ?", key);
          for (let i = 0; i < serializedViews.length; i += 1) {
            const entry = serializedViews[i]!;
            database.runSync(
              "INSERT INTO computer_view_snapshots (computer_key, session_id, ord, view_json) VALUES (?, ?, ?, ?)",
              key,
              entry.sessionId,
              i,
              entry.json,
            );
          }
          const allKeys = database.getAllSync<{ computer_key: string }>(
            "SELECT computer_key FROM computer_snapshots ORDER BY saved_at DESC",
          );
          for (let i = MAX_CACHED_COMPUTERS; i < allKeys.length; i += 1) {
            const evictKey = allKeys[i]?.computer_key;
            if (!evictKey || evictKey === key) continue;
            database.runSync("DELETE FROM computer_snapshots WHERE computer_key = ?", evictKey);
            database.runSync("DELETE FROM computer_view_snapshots WHERE computer_key = ?", evictKey);
          }
        });
      } catch {
        db = undefined;
      }
    },

    clear(key: string): void {
      if (!key || key === "none") return;
      memory.delete(key);
      const database = getDb();
      if (!database) return;
      try {
        runTx(database, () => {
          database.runSync("DELETE FROM computer_snapshots WHERE computer_key = ?", key);
          database.runSync("DELETE FROM computer_view_snapshots WHERE computer_key = ?", key);
        });
      } catch {
        db = undefined;
      }
    },
  };
}

export const snapshotStorage = createSnapshotStorage();
