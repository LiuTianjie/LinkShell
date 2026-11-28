import type { ClientSnapshot } from "@linkshell/client-core";
import { emptyView } from "@linkshell/client-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const { createSnapshotStorage } = await import("../src/lib/snapshot-db");
import type { SnapshotSQLiteDatabase } from "../src/lib/snapshot-db";

/** Minimal synchronous SQLite table simulator matching `computer_snapshots` & `computer_view_snapshots`. */
function createFakeSqliteDb(): SnapshotSQLiteDatabase & { failNext: boolean } {
  const heads = new Map<
    string,
    {
      computer_key: string;
      machine_json: string | null;
      sessions_json: string;
      next_before: number | null;
      next_before_id: string | null;
      projects_json: string;
      saved_at: number;
    }
  >();
  const views = new Map<string, { computer_key: string; session_id: string; ord: number; view_json: string }[]>();
  const db: SnapshotSQLiteDatabase & { failNext: boolean } = {
    failNext: false,
    execSync() {
      if (db.failNext) {
        db.failNext = false;
        throw new Error("SQLITE_BUSY");
      }
    },
    runSync(sql: string, ...params: (string | number | null)[]) {
      if (db.failNext) {
        db.failNext = false;
        throw new Error("SQLITE_IOERR");
      }
      if (sql.includes("INSERT OR REPLACE INTO computer_snapshots")) {
        const [computer_key, machine_json, sessions_json, next_before, next_before_id, projects_json, saved_at] = params as [
          string,
          string | null,
          string,
          number | null,
          string | null,
          string,
          number,
        ];
        heads.set(computer_key, {
          computer_key,
          machine_json,
          sessions_json,
          next_before,
          next_before_id,
          projects_json,
          saved_at,
        });
      } else if (sql.startsWith("DELETE FROM computer_view_snapshots WHERE computer_key = ?")) {
        views.delete(String(params[0]));
      } else if (sql.startsWith("DELETE FROM computer_snapshots WHERE computer_key = ?")) {
        heads.delete(String(params[0]));
      } else if (sql.startsWith("INSERT INTO computer_view_snapshots")) {
        const [computer_key, session_id, ord, view_json] = params as [string, string, number, string];
        const list = views.get(computer_key) ?? [];
        list.push({ computer_key, session_id, ord, view_json });
        views.set(computer_key, list);
      }
    },
    getAllSync<T>(sql: string, ...params: (string | number | null)[]): T[] {
      if (db.failNext) {
        db.failNext = false;
        throw new Error("SQLITE_CORRUPT");
      }
      if (sql.includes("FROM computer_snapshots WHERE computer_key = ?")) {
        const row = heads.get(String(params[0]));
        return (row ? [row] : []) as unknown as T[];
      }
      if (sql.includes("FROM computer_view_snapshots WHERE computer_key = ?")) {
        const list = (views.get(String(params[0])) ?? []).slice().sort((a, b) => a.ord - b.ord);
        return list as unknown as T[];
      }
      if (sql.includes("SELECT computer_key FROM computer_snapshots ORDER BY saved_at DESC")) {
        return [...heads.values()]
          .sort((a, b) => b.saved_at - a.saved_at)
          .map((r) => ({ computer_key: r.computer_key })) as unknown as T[];
      }
      return [];
    },
    withTransactionSync(task: () => void) {
      task();
    },
  };
  return db;
}

describe("snapshot-db synchronous SQLite cache", () => {
  const sampleSnapshot = (savedAt = 1000): ClientSnapshot => ({
    machine: {
      machineId: "m-1",
      hostname: "Studio Mac",
      home: "/Users/dev",
      platform: "darwin",
      hostVersion: "2.0.0",
      agents: [],
    },
    sessions: [
      {
        id: "codex:1",
        nativeId: "1",
        agent: "codex",
        title: "Refactor auth",
        cwd: "/Users/dev/app",
        state: "idle",
        pendingPermissions: 0,
        createdAt: 10,
        updatedAt: 20,
        lastSeq: 5,
        archived: false,
      },
    ],
    sessionsNextBefore: 20,
    sessionsNextBeforeId: "codex:1",
    projects: [{ cwd: "/Users/dev/app", name: "app", sessionCount: 1, lastActiveAt: 20 }],
    views: [
      {
        ...emptyView("codex:1"),
        lastSeq: 5,
        items: [{ kind: "agent", id: "a1", text: "Done!", streaming: false, ts: 20 }],
        index: { a1: 0 },
      },
    ],
    savedAt,
  });

  it("persists and reloads snapshots across instances, preserving view order and skipping oversized views", () => {
    const db = createFakeSqliteDb();
    const storeA = createSnapshotStorage(() => db);
    const snap = sampleSnapshot(500);
    const hugeView = {
      ...emptyView("codex:huge"),
      lastSeq: 9,
      items: [{ kind: "agent" as const, id: "big", text: "x".repeat(600 * 1024), streaming: false, ts: 30 }],
      index: { big: 0 },
    };
    storeA.save("wss://gw#mac-1", { ...snap, views: [...snap.views, hugeView] });

    const storeB = createSnapshotStorage(() => db);
    const loaded = storeB.load("wss://gw#mac-1");
    expect(loaded).toBeDefined();
    expect(loaded?.machine?.home).toBe("/Users/dev");
    expect(loaded?.sessions).toHaveLength(1);
    expect(loaded?.projects).toHaveLength(1);
    expect(loaded?.sessionsNextBefore).toBe(20);
    // Normal view kept; >512 KB view skipped without failing the snapshot save!
    expect(loaded?.views.map((v) => v.sessionId)).toEqual(["codex:1"]);
  });

  it("refuses to persist locked computers, clears cleanly, and bounds total cached computers to 8", () => {
    const db = createFakeSqliteDb();
    const storage = createSnapshotStorage(() => db);

    storage.save("locked-mac", {
      ...sampleSnapshot(100),
      machine: { ...sampleSnapshot().machine!, locked: true },
    });
    expect(storage.load("locked-mac")).toBeUndefined();

    for (let i = 1; i <= 10; i += 1) {
      storage.save(`mac-${i}`, sampleSnapshot(i * 100));
    }
    expect(storage.load("mac-1")).toBeUndefined();
    expect(storage.load("mac-2")).toBeUndefined();
    expect(storage.load("mac-3")).toBeDefined();
    expect(storage.load("mac-10")).toBeDefined();

    storage.clear("mac-10");
    expect(storage.load("mac-10")).toBeUndefined();
  });
});
