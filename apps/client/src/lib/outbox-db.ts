import type { OutboxItem } from "@linkshell/client-core";
import { Platform } from "react-native";

export const OUTBOX_DB_NAME = "linkshell-outbox.db";

export interface OutboxSQLiteDatabase {
  execSync(source: string): void;
  runSync(source: string, ...params: (string | number | null)[]): unknown;
  getAllSync<T>(source: string, ...params: (string | number | null)[]): T[];
  withTransactionSync?(task: () => void): void;
}

export interface OutboxStorage {
  load(key: string): OutboxItem[];
  save(key: string, items: OutboxItem[]): void;
}

function cloneItems(items: OutboxItem[]): OutboxItem[] {
  return items.map((item) => ({
    clientMessageId: item.clientMessageId,
    sessionId: item.sessionId,
    content: item.content.map((block) => ({ ...block })),
    createdAt: item.createdAt,
  }));
}

function defaultOpenDatabase(): OutboxSQLiteDatabase | null {
  if (Platform.OS === "web") return null;
  try {
    // Loaded lazily so Vitest and environments without the native ExpoSQLite binary fall back cleanly.
    const sqlite = require("expo-sqlite") as typeof import("expo-sqlite");
    if (typeof sqlite.openDatabaseSync !== "function") return null;
    return sqlite.openDatabaseSync(OUTBOX_DB_NAME);
  } catch {
    return null;
  }
}

/**
 * Durable SQLite outbox for unsent/failed prompts and image attachments so messages survive
 * iOS app termination, falling back transparently to memory when native SQLite is unavailable.
 */
export function createOutboxStorage(openDb: () => OutboxSQLiteDatabase | null = defaultOpenDatabase): OutboxStorage {
  let db: OutboxSQLiteDatabase | null | undefined;
  const memory = new Map<string, OutboxItem[]>();

  const getDb = (): OutboxSQLiteDatabase | null => {
    if (db !== undefined) return db;
    try {
      const opened = openDb();
      if (!opened) {
        db = null;
        return null;
      }
      opened.execSync(
        `CREATE TABLE IF NOT EXISTS outbox_items (
          computer_key TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          ord INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (computer_key, client_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_computer_ord
          ON outbox_items (computer_key, ord ASC, created_at ASC);`,
      );
      db = opened;
      return db;
    } catch {
      db = null;
      return null;
    }
  };

  return {
    load(key: string): OutboxItem[] {
      if (!key || key === "none") return [];
      const database = getDb();
      if (database) {
        try {
          const rows = database.getAllSync<{
            client_message_id: string;
            session_id: string;
            content_json: string;
            created_at: number;
          }>(
            "SELECT client_message_id, session_id, content_json, created_at FROM outbox_items WHERE computer_key = ? ORDER BY ord ASC, created_at ASC",
            key,
          );
          const items: OutboxItem[] = [];
          for (const row of rows) {
            if (!row.client_message_id || !row.session_id || typeof row.content_json !== "string") continue;
            try {
              const content = JSON.parse(row.content_json) as OutboxItem["content"];
              if (!Array.isArray(content)) continue;
              items.push({
                clientMessageId: row.client_message_id,
                sessionId: row.session_id,
                content,
                createdAt:
                  typeof row.created_at === "number" && Number.isFinite(row.created_at) ? row.created_at : Date.now(),
              });
            } catch {
              // One corrupt row must not discard other unsent prompts.
            }
          }
          memory.set(key, cloneItems(items));
          return items;
        } catch {
          db = null;
        }
      }
      return cloneItems(memory.get(key) ?? []);
    },

    save(key: string, items: OutboxItem[]): void {
      if (!key || key === "none") return;
      const valid = items.filter(
        (item) => Boolean(item?.clientMessageId && item.sessionId && Array.isArray(item.content)),
      );
      if (valid.length === 0) memory.delete(key);
      else memory.set(key, cloneItems(valid));

      const database = getDb();
      if (!database) return;

      const writeRows = () => {
        database.runSync("DELETE FROM outbox_items WHERE computer_key = ?", key);
        for (let i = 0; i < valid.length; i += 1) {
          const item = valid[i]!;
          const createdAt =
            typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
              ? Math.trunc(item.createdAt)
              : Date.now();
          database.runSync(
            "INSERT INTO outbox_items (computer_key, client_message_id, session_id, content_json, created_at, ord) VALUES (?, ?, ?, ?, ?, ?)",
            key,
            item.clientMessageId,
            item.sessionId,
            JSON.stringify(item.content),
            createdAt,
            i,
          );
        }
      };

      try {
        if (database.withTransactionSync) {
          database.withTransactionSync(writeRows);
        } else {
          database.execSync("BEGIN IMMEDIATE");
          try {
            writeRows();
            database.execSync("COMMIT");
          } catch (error) {
            try {
              database.execSync("ROLLBACK");
            } catch {}
            throw error;
          }
        }
      } catch {
        db = null;
      }
    },
  };
}

export const outboxStorage: OutboxStorage = createOutboxStorage();
