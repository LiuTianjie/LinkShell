import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createClientStore, type HostLink, type OutboxItem } from "@linkshell/client-core";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

const { createOutboxStorage } = await import("../src/lib/outbox-db");
import type { OutboxSQLiteDatabase } from "../src/lib/outbox-db";

/** Adapts Node 22's built-in `node:sqlite` `DatabaseSync` to Expo SQLite's sync interface. */
function wrapNodeSQLite(db: DatabaseSync): OutboxSQLiteDatabase {
  return {
    execSync(sql: string) {
      db.exec(sql);
    },
    runSync(sql: string, ...params: Array<string | number | null>) {
      db.prepare(sql).run(...params);
    },
    getAllSync<T>(sql: string, ...params: Array<string | number | null>): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    withTransactionSync(task: () => void) {
      db.exec("BEGIN IMMEDIATE");
      try {
        task();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function makeFakeLink(overrides?: Partial<HostLink>): HostLink {
  let onlineListener: (() => void) | undefined;
  return {
    status: "reconnecting",
    lastError: "连接已断开",
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnectNow: vi.fn(),
    probe: vi.fn(() => Promise.resolve(false)),
    resumeLatest: vi.fn(),
    subscribe: vi.fn(() => Promise.resolve(undefined)),
    unsubscribe: vi.fn(() => Promise.resolve()),
    call: vi.fn(() => Promise.reject(new Error("没有连上电脑"))),
    onStatus: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onSummary: vi.fn(() => () => {}),
    onOnline: vi.fn((cb: () => void) => {
      onlineListener = cb;
      return () => {
        if (onlineListener === cb) onlineListener = undefined;
      };
    }),
    onRestored: vi.fn(() => () => {}),
    on: vi.fn(() => () => {}),
    ...(overrides ?? {}),
  } as unknown as HostLink;
}

describe("SQLite durable outbox persistence (outbox-db)", () => {
  it("persists failed/unsent prompts and images across app termination and isolates computer keys", async () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      const storageInstance1 = createOutboxStorage(() => wrapNodeSQLite(rawDb));
      const link1 = makeFakeLink();

      let idSeq = 0;
      const store1 = createClientStore(link1, {
        newId: () => `msg-${++idSeq}`,
        outboxStorage: storageInstance1,
        outboxKey: "relay:https://gateway.itool.tech#mac-1",
      });

      const imageAndTextContent = [
        { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", mimeType: "image/png" },
        { type: "text" as const, text: "请修复截图里的布局错位" },
      ];

      const sendResult = await store1.getState().send("sess-1", imageAndTextContent);
      expect(sendResult).toBe("failed");
      expect(store1.getState().outbox["msg-1"]).toEqual({
        sessionId: "sess-1",
        content: imageAndTextContent,
      });

      // Another computer stores its own outbox in the same SQLite database without colliding.
      const otherItem: OutboxItem = {
        clientMessageId: "other-1",
        sessionId: "sess-other",
        content: [{ type: "text", text: "另一台电脑的消息" }],
        createdAt: 2000,
      };
      storageInstance1.save("relay:https://gateway.itool.tech#mac-2", [otherItem]);

      // Simulate iOS terminating the app and relaunching cold against the same SQLite file.
      const storageInstance2 = createOutboxStorage(() => wrapNodeSQLite(rawDb));
      const call2 = vi.fn().mockResolvedValue({ delivery: "started" });
      const link2 = makeFakeLink({ status: "online", call: call2 as never });
      const store2 = createClientStore(link2, {
        newId: () => `relaunch-${++idSeq}`,
        outboxStorage: storageInstance2,
        outboxKey: "relay:https://gateway.itool.tech#mac-1",
      });

      expect(store2.getState().outbox["msg-1"]).toEqual({
        sessionId: "sess-1",
        content: imageAndTextContent,
      });

      // Retrying once back online delivers the exact clientMessageId + image blocks and clears SQLite.
      await store2.getState().retry("msg-1");
      expect(call2).toHaveBeenCalledWith("sessions.prompt", {
        sessionId: "sess-1",
        content: imageAndTextContent,
        clientMessageId: "msg-1",
        whenBusy: "queue",
      });
      expect(store2.getState().outbox["msg-1"]).toBeUndefined();
      expect(storageInstance2.load("relay:https://gateway.itool.tech#mac-1")).toEqual([]);
      // Other computer's outbox remains untouched.
      expect(storageInstance2.load("relay:https://gateway.itool.tech#mac-2")).toEqual([otherItem]);
    } finally {
      rawDb.close();
    }
  });

  it("preserves ordering, removes discarded items, and skips corrupt rows without losing valid ones", async () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      const storage = createOutboxStorage(() => wrapNodeSQLite(rawDb));
      const items: OutboxItem[] = [
        {
          clientMessageId: "m-1",
          sessionId: "s-1",
          content: [{ type: "text", text: "第一条" }],
          createdAt: 100,
        },
        {
          clientMessageId: "m-2",
          sessionId: "s-1",
          content: [{ type: "text", text: "第二条" }],
          createdAt: 200,
        },
      ];
      storage.save("mac-1", items);

      // Inject a corrupt row directly into SQLite and ensure valid rows still hydrate cleanly.
      rawDb
        .prepare(
          "INSERT INTO outbox_items (computer_key, client_message_id, session_id, content_json, created_at, ord) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("mac-1", "m-corrupt", "s-1", "{not-json", 150, 1);

      const loaded = storage.load("mac-1");
      expect(loaded.map((item) => item.clientMessageId)).toEqual(["m-1", "m-2"]);

      // Discarding from a hydrated store deletes the row from SQLite.
      const store = createClientStore(makeFakeLink(), {
        outboxStorage: storage,
        outboxKey: "mac-1",
      });
      store.getState().discard("m-1");
      expect(storage.load("mac-1").map((item) => item.clientMessageId)).toEqual(["m-2"]);

      store.getState().discard("m-2");
      expect(storage.load("mac-1")).toEqual([]);
    } finally {
      rawDb.close();
    }
  });

  it("falls back safely to in-memory storage when SQLite is unavailable or throws", () => {
    const fallback = createOutboxStorage(() => {
      throw new Error("Cannot find native module 'ExpoSQLite'");
    });
    const sample: OutboxItem = {
      clientMessageId: "mem-1",
      sessionId: "s-mem",
      content: [{ type: "text", text: "离线草稿" }],
      createdAt: 500,
    };

    expect(fallback.load("mac-mem")).toEqual([]);
    fallback.save("mac-mem", [sample]);
    expect(fallback.load("mac-mem")).toEqual([sample]);
    // Returned items are cloned so external mutation cannot corrupt stored records.
    fallback.load("mac-mem")[0]!.content[0] = { type: "text", text: "mutated" };
    expect(fallback.load("mac-mem")[0]!.content[0]).toEqual({ type: "text", text: "离线草稿" });
    fallback.save("mac-mem", []);
    expect(fallback.load("mac-mem")).toEqual([]);
  });
});
