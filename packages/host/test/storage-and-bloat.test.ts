import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcPeer, type ContentBlock, type SessionEvent, type SessionUpdate } from "@linkshell/wire";
import { BLOB_URI_PREFIX, BlobStore, INLINE_BLOB_THRESHOLD, parseBlobUri } from "../src/blob-store.js";
import { capStoredUpdate, imageOf, slimEvent } from "../src/slim.js";
import { HostStore } from "../src/store.js";
import { SessionHub, type Subscriber } from "../src/hub.js";
import { HostRpcServer } from "../src/rpc/server.js";
import { mapNotification, itemToHistory, type CodexThreadState } from "../src/drivers/codex/mapper.js";
import type { AgentDriver, DriverHost } from "../src/drivers/types.js";
import type { DriverBehavior } from "../src/drivers/behavior.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ls-storage-bloat-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class StubDriver implements AgentDriver {
  readonly id = "stub";
  readonly label = "Stub";
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: true, fork: false, models: false, modes: false };
  readonly behavior: DriverBehavior = {
    desktop: "multi_client",
    history: "native-snapshot",
    turnCompletion: "native-events",
    busyInput: "queue",
    fork: "context",
    detach: "local-only",
  };
  host!: DriverHost;
  async start(host: DriverHost) {
    this.host = host;
    return { installed: true, version: "1.0" };
  }
  async stop() {}
  status() {
    return { installed: true, version: "1.0" };
  }
  async listSessions() {
    return [];
  }
  async createSession(options: { cwd: string }) {
    return { nativeId: "s1", cwd: options.cwd, createdAt: Date.now(), updatedAt: Date.now() };
  }
  async attach() {
    return [];
  }
  async detach() {}
  async prompt(_nativeId: string, _content: ContentBlock[], _clientMessageId: string) {
    return "started" as const;
  }
  async cancel() {}
  async answerPermission() {}
}

describe("external BlobStore, SQLite bloat prevention, indexes & maintenance", () => {
  it("externalizes >16 KB images to content-addressed files, resolves them transparently, and prunes by LRU budget", () => {
    const dir = tempDir();
    const blobsDir = join(dir, "blobs");
    const bigA = Buffer.alloc(INLINE_BLOB_THRESHOLD + 4096, 0x41).toString("base64");
    const bigB = Buffer.alloc(INLINE_BLOB_THRESHOLD + 4096, 0x42).toString("base64");
    const small = Buffer.from("tiny-image").toString("base64");

    const store = new BlobStore(blobsDir, { maxBytes: 40 * 1024 });
    const putA1 = store.putBase64(bigA);
    const putA2 = store.putBase64(bigA);
    expect(putA1.uri).toBe(putA2.uri); // Content-addressed dedup by SHA-256.
    const shaA = parseBlobUri(putA1.uri)!;
    expect(existsSync(join(blobsDir, shaA))).toBe(true);
    expect(store.getBase64(putA1.uri)).toBe(bigA);

    // Small payloads stay inline (externalizeUpdate leaves <=16 KB untouched).
    const smallUpdate: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: "image/png", data: small },
    };
    const untouched = store.externalizeUpdate(smallUpdate);
    expect(untouched).toBe(smallUpdate);

    // Put a second blob and make blob A older on disk; pruning evicts A and keeps B.
    const putB = store.putBase64(bigB);
    const shaB = parseBlobUri(putB.uri)!;
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(blobsDir, shaA), past, past);
    const pruned = store.prune();
    expect(pruned.removedFiles).toBe(1);
    expect(existsSync(join(blobsDir, shaA))).toBe(false);
    expect(existsSync(join(blobsDir, shaB))).toBe(true);
    expect(readdirSync(blobsDir)).toEqual([shaB]);
  });

  it("stores compact blob URIs in SQLite while resolving sessions.image for blob URIs, event URIs, and legacy inline base64", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const hostStore = new HostStore(dbPath);
    const hub = new SessionHub(hostStore, [new StubDriver()]);
    await hub.start();
    try {
      const sid = "stub:img-1";
      hostStore.upsertSession({ id: sid, agent: "stub", nativeId: "img-1", cwd: dir, createdAt: 100, updatedAt: 100 });

      const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24 * 1024, 0x7f)]);
      const bigBase64 = pngBytes.toString("base64");
      const ev = hostStore.appendEvent(
        sid,
        { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "image", mimeType: "image/png", data: bigBase64 } },
        101,
      );

      // Verify raw SQLite row is tiny (no inline base64 blob).
      const rawDb = new DatabaseSync(dbPath, { readOnly: true });
      const row = rawDb.prepare("SELECT body FROM events WHERE session_id = ? AND seq = ?").get(sid, ev.seq) as { body: string };
      rawDb.close();
      expect(Buffer.byteLength(row.body, "utf8")).toBeLessThan(512);
      expect(row.body).toContain(BLOB_URI_PREFIX);
      const storedUri = (JSON.parse(row.body) as { content: { uri?: string } }).content.uri!;
      expect(storedUri.startsWith(BLOB_URI_PREFIX)).toBe(true);

      // slimEvent turns the externalized image into a lazy `linkshell-event:` reference without touching disk.
      const slimmed = slimEvent(ev, { lazyImages: true });
      expect(slimmed.update).toMatchObject({
        sessionUpdate: "user_message_chunk",
        content: { type: "image", mimeType: "image/png", uri: `linkshell-event:${ev.seq}/0` },
      });
      expect((slimmed.update as { content: { data?: string } }).content.data).toBeUndefined();

      // imageOf transparently resolves the external blob from disk.
      const loaded = hostStore.readEvent(sid, ev.seq)!;
      expect(imageOf(loaded, 0)).toEqual({ mimeType: "image/png", data: bigBase64 });

      // Insert a legacy >16 KB inline base64 row directly into SQLite (older DB format) and verify fallback works too.
      const legacyBase64 = Buffer.alloc(24 * 1024, 0x33).toString("base64");
      const legacyBody = JSON.stringify({
        sessionUpdate: "user_message_chunk",
        messageId: "u2",
        content: { type: "image", mimeType: "image/jpeg", data: legacyBase64 },
      });
      const rwDb = new DatabaseSync(dbPath);
      rwDb.prepare("INSERT INTO events (session_id, seq, ts, body) VALUES (?, ?, ?, ?)").run(sid, ev.seq + 1, 102, legacyBody);
      rwDb.close();

      // Verify `sessions.image` RPC handles event URI, direct blob URI, and legacy inline event URI.
      const rpc = new HostRpcServer({
        hub,
        terminals: { onChange: () => () => {} } as never,
        machineInfo: () => ({ machineId: "m1", hostname: "mac", platform: "darwin", hostVersion: "test", agents: [] }),
        log: () => {},
      });
      let serverOnMessage!: (text: string) => void;
      let serverOnClose!: () => void;
      const client = new RpcPeer({ send: (text) => serverOnMessage(text) });
      rpc.connect({
        send: (text) => client.receive(text),
        close: () => serverOnClose(),
        onMessage: (fn) => {
          serverOnMessage = fn;
        },
        onClose: (fn) => {
          serverOnClose = fn;
        },
      });
      try {
        const byEvent = await client.request<{ mimeType: string; data: string }>("sessions.image", { sessionId: sid, uri: `linkshell-event:${ev.seq}/0` });
        expect(byEvent).toEqual({ mimeType: "image/png", data: bigBase64 });

        const byBlob = await client.request<{ mimeType: string; data: string }>("sessions.image", { sessionId: sid, uri: storedUri });
        expect(byBlob).toEqual({ mimeType: "image/png", data: bigBase64 });

        const byLegacy = await client.request<{ mimeType: string; data: string }>("sessions.image", { sessionId: sid, uri: `linkshell-event:${ev.seq + 1}/0` });
        expect(byLegacy).toEqual({ mimeType: "image/jpeg", data: legacyBase64 });
      } finally {
        serverOnClose();
        await rpc.stop();
      }
    } finally {
      await hub.stop();
      hostStore.close();
    }
  });

  it("caps giant rawOutput/rawInput/text payloads, clamps sizeAfter(), creates indexes + incremental vacuum, and protects terminal snapshots during maintenance", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const store = new HostStore(dbPath);
    try {
      // 1. Verify PRAGMA auto_vacuum = INCREMENTAL (2) and all required indexes.
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const autoVacuum = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
      expect(autoVacuum.auto_vacuum).toBe(2);
      const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
      db.close();
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "sessions_by_archived_state",
          "sessions_by_agent",
          "driver_state_by_key_value",
          "client_messages_by_ts",
          "event_meta_by_kind_global",
        ]),
      );

      // 2. Hard cap giant 2 MB rawOutput so no single row blows up SQLite.
      const huge = "x".repeat(2 * 1024 * 1024);
      const capped = capStoredUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawOutput: { stdout: huge },
        appendOutput: huge,
      });
      expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThan(600 * 1024);

      // 3. sizeAfter() clamps per-event bytes so a couple of huge rows don't force a full window reset.
      const sid = "stub:size-1";
      store.upsertSession({ id: sid, agent: "stub", nativeId: "size-1", cwd: dir, createdAt: 100, updatedAt: 100 });
      store.appendEvent(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawOutput: huge }, 101);
      store.appendEvent(sid, { sessionUpdate: "tool_call_update", toolCallId: "t2", rawOutput: huge }, 102);
      const after = store.sizeAfter(sid, 0);
      expect(after.events).toBe(2);
      expect(after.bytes).toBeLessThanOrEqual(2 * (64 * 1024 + 512));

      // 4. Maintenance protects terminal_frames after terminal_snapshots.frame (no snapshot replay gap)
      //    and still runs PASSIVE checkpoint + blob pruning even when active (`idle: false`).
      const now = Date.now();
      store.saveTerminalSnapshot("term-1", { cols: 80, rows: 24, frame: 4, data: "snap" });
      for (let frame = 1; frame <= 8; frame += 1) {
        store.appendTerminalFrame("term-1", frame, 80, 24, `frame-${frame}`);
      }
      // `maxTerminalFrames: 2` would normally keep only frames 7..8 (leaving gap 5..6 after snapshot.frame 4!),
      // so maintenance MUST clamp cutoff to `snap.frame + 1` (5) and keep frames 5..8 intact!
      const activeMaint = store.runMaintenance(now, { idle: false, maxTerminalFrames: 2 });
      expect(activeMaint.prunedTerminalFrames).toBe(4); // frames 1..4 pruned
      expect(store.terminalFrames("term-1", 0, 100).map((f) => f.frame)).toEqual([5, 6, 7, 8]);

      const idleMaint = store.runMaintenance(now, { idle: true, maxTerminalFrames: 2 });
      expect(idleMaint.prunedTerminalFrames).toBe(0);
      expect(store.terminalFrames("term-1", 4, 100).map((f) => f.frame)).toEqual([5, 6, 7, 8]);
    } finally {
      store.close();
    }
  });

  it("CodexMapper avoids duplicating aggregatedOutput into rawOutput and caps oversized user data: URLs", () => {
    const states = new Map<string, CodexThreadState>();
    const stateOf = (id: string) => {
      let state = states.get(id);
      if (!state) states.set(id, (state = {}));
      return state;
    };

    // Stream exact same text as aggregatedOutput -> no redundant replaceOutput or rawOutput.aggregatedOutput!
    mapNotification(
      "item/started",
      { threadId: "t1", item: { id: "cmd-1", type: "commandExecution", command: "echo hi", status: "inProgress" } },
      stateOf,
    );
    mapNotification("item/commandExecution/outputDelta", { threadId: "t1", itemId: "cmd-1", delta: "hello world\n" }, stateOf);
    const completed = mapNotification(
      "item/completed",
      {
        threadId: "t1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo hi",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "hello world\n",
        },
      },
      stateOf,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]!.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-1",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    expect((completed[0]!.update as { replaceOutput?: string }).replaceOutput).toBeUndefined();
    expect((completed[0]!.update as { appendOutput?: string }).appendOutput).toBeUndefined();
    expect((completed[0]!.update as { rawOutput?: Record<string, unknown> }).rawOutput?.aggregatedOutput).toBeUndefined();

    // Oversized >12 MB data: URL on userMessage is dropped cleanly with a notice instead of bloating SQLite.
    const hugeDataUrl = `data:image/png;base64,${"A".repeat(13 * 1024 * 1024)}`;
    const userHistory = itemToHistory({
      id: "u-huge",
      type: "userMessage",
      content: [{ type: "image", url: hugeDataUrl }],
    });
    expect(userHistory).toBeDefined();
    expect(userHistory!.updates).toHaveLength(1);
    expect(JSON.stringify(userHistory!.updates[0])).not.toContain("AAAA".repeat(100));
  });

  it("SessionHub deduplicates identical available_commands_update / ls_config and paces subscribe() under backpressure", async () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    const driver = new StubDriver();
    const hub = new SessionHub(store, [driver]);
    await hub.start();
    try {
      const sid = "stub:dedup-pace";
      store.upsertSession({ id: sid, agent: "stub", nativeId: "dedup-pace", cwd: dir, createdAt: 100, updatedAt: 100 });
      const commandsUpdate: SessionUpdate = {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "Compact conversation" }],
      };
      const configUpdate: SessionUpdate = {
        sessionUpdate: "ls_config",
        options: [{ id: "model", name: "Model", category: "model", current: "sonnet", values: [{ value: "sonnet", name: "Sonnet" }] }],
      };
      // Emit identical commands and config twice -> only logged once each!
      driver.host.update("stub", "dedup-pace", commandsUpdate);
      driver.host.update("stub", "dedup-pace", commandsUpdate);
      driver.host.update("stub", "dedup-pace", configUpdate);
      driver.host.update("stub", "dedup-pace", configUpdate);
      expect(store.readEvents(sid, 0)).toHaveLength(2);

      // Populate 120 events and subscribe with a simulated high `bufferedAmount` that drains on the next tick.
      for (let i = 0; i < 120; i += 1) {
        store.appendEvent(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: `c${i} ` } }, 200 + i);
      }

      let buffered = 1024 * 1024; // 1 MB > 512 KB high-water mark
      const received: SessionEvent[] = [];
      let liveEmitted = false;
      const subscriber: Subscriber = {
        bufferedAmount: () => buffered,
        event: (ev) => {
          received.push(ev);
          // Drain the simulated socket right after the first batch, and also emit a live event mid-backlog!
          if (!liveEmitted && received.length >= 50) {
            liveEmitted = true;
            setTimeout(() => {
              driver.host.update("stub", "dedup-pace", {
                sessionUpdate: "agent_message_chunk",
                messageId: "m1",
                content: { type: "text", text: "LIVE" },
              });
              buffered = 0;
            }, 25);
          }
        },
      };
      await hub.subscribe(sid, 0, subscriber);
      hub.unsubscribe(sid, subscriber);

      // Every backlog event PLUS the live event arrived in strictly increasing `seq` order with zero duplicates!
      expect(received.length).toBe(123);
      for (let i = 1; i < received.length; i += 1) {
        expect(received[i]!.seq).toBeGreaterThan(received[i - 1]!.seq);
      }
      expect(received.at(-1)!.update).toMatchObject({ content: { text: "LIVE" } });
    } finally {
      await hub.stop();
      store.close();
    }
  });
});
