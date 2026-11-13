import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostStore } from "../src/store.js";
import { SessionHub } from "../src/hub.js";
import type { AgentDriver, DriverHost } from "../src/drivers/types.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ls-store-maint-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("state.db post-turn chunk compaction and lifecycle TTL maintenance", () => {
  it("coalesces contiguous agent message & thought chunks while preserving lastSeq, fromSeq, and history pagination", () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    try {
      const sessionId = "codex:compact-1";
      store.upsertSession({
        id: sessionId,
        agent: "codex",
        nativeId: "compact-1",
        cwd: dir,
        createdAt: 1000,
        updatedAt: 1000,
      });

      store.appendEvent(sessionId, { sessionUpdate: "ls_turn", state: "started" }, 1001);
      store.appendEvent(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Explain LinkShell" } }, 1002);
      store.appendEvent(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "First " } }, 1003);
      store.appendEvent(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "second " } }, 1004);
      store.appendEvent(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "third." } }, 1005);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } }, 1006);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "from " } }, 1007);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "LinkShell!" } }, 1008);
      // Subagent chunk with parentToolCallId must not merge with root message chunks.
      store.appendEvent(
        sessionId,
        { sessionUpdate: "agent_message_chunk", parentToolCallId: "sub-1", messageId: "m1", content: { type: "text", text: "Child A" } },
        1009,
      );
      store.appendEvent(
        sessionId,
        { sessionUpdate: "agent_message_chunk", parentToolCallId: "sub-1", messageId: "m1", content: { type: "text", text: " + B" } },
        1010,
      );
      store.appendEvent(sessionId, { sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }, 1011);
      const ended = store.appendEvent(sessionId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }, 1012);

      expect(ended.seq).toBe(12);
      const stats = store.compactTurnChunks(sessionId);
      expect(stats).toEqual({ coalescedRuns: 3, removedRows: 5 });

      // Session lastSeq remains monotonically 12; next append gets 13.
      expect(store.getSession(sessionId)?.lastSeq).toBe(12);
      const events = store.readEvents(sessionId, 0, 100);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 5, 8, 10, 11, 12]);

      const thought = events.find((e) => e.seq === 5)?.update;
      expect(thought).toEqual({
        sessionUpdate: "agent_thought_chunk",
        messageId: "t1",
        replace: true,
        content: { type: "text", text: "First second third." },
      });

      const msg = events.find((e) => e.seq === 8)?.update;
      expect(msg).toEqual({
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        replace: true,
        content: { type: "text", text: "Hello from LinkShell!" },
      });

      const subMsg = events.find((e) => e.seq === 10)?.update;
      expect(subMsg).toEqual({
        sessionUpdate: "agent_message_chunk",
        parentToolCallId: "sub-1",
        messageId: "m1",
        replace: true,
        content: { type: "text", text: "Child A + B" },
      });

      // Resumability from mid-turn seq (e.g. client had seq 5) still works monotonically.
      expect(store.readEvents(sessionId, 5, 100).map((e) => e.seq)).toEqual([8, 10, 11, 12]);
      expect(store.pageStart(sessionId, 12)).toBe(0);

      const next = store.appendEvent(sessionId, { sessionUpdate: "ls_notice", level: "info", title: "after" }, 1013);
      expect(next.seq).toBe(13);
    } finally {
      store.close();
    }
  });

  it("bounds compactTurnChunks row scans per call without splitting contiguous chunk runs", () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    try {
      const sessionId = "codex:bounded-scan";
      store.upsertSession({
        id: sessionId,
        agent: "codex",
        nativeId: "bounded-scan",
        cwd: dir,
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Message 1: 4 chunks + ls_message_done (5 rows)
      for (let i = 1; i <= 4; i++) {
        store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: `A${i}` } }, 1000 + i);
      }
      store.appendEvent(sessionId, { sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }, 1005);
      // Message 2: 4 chunks (including a mid-stream replace: true) + ls_message_done (5 rows)
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "draft" } }, 1011);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", replace: true, content: { type: "text", text: "B1B2" } }, 1012);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "B3" } }, 1013);
      store.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "B4" } }, 1014);
      store.appendEvent(sessionId, { sessionUpdate: "ls_message_done", messageId: "m2", role: "agent" }, 1015);
      store.appendEvent(sessionId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }, 1016);

      // Scan limit 7 lands inside Message 2's chunk run, so pass 1 compacts Message 1 and defers Message 2 intact.
      const pass1 = store.compactTurnChunks(sessionId, { maxScanRows: 7 });
      expect(pass1).toEqual({ coalescedRuns: 1, removedRows: 3 });

      const pass2 = store.compactTurnChunks(sessionId, { maxScanRows: 7 });
      expect(pass2).toEqual({ coalescedRuns: 1, removedRows: 3 });

      const chunks = store
        .readEvents(sessionId, 0, 50)
        .filter((e) => e.update.sessionUpdate === "agent_message_chunk")
        .map((e) => e.update);
      expect(chunks).toEqual([
        { sessionUpdate: "agent_message_chunk", messageId: "m1", replace: true, content: { type: "text", text: "A1A2A3A4" } },
        { sessionUpdate: "agent_message_chunk", messageId: "m2", replace: true, content: { type: "text", text: "B1B2B3B4" } },
      ]);
    } finally {
      store.close();
    }
  });

  it("compacts immediately on turn end when unsubscribed and defers while a live subscriber is attached", async () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    let hostCallbacks!: DriverHost;
    const fakeDriver: AgentDriver = {
      id: "codex",
      label: "Codex",
      tier: 1,
      behavior: {
        desktop: 1,
        history: "native-snapshot",
        turnCompletion: "native-events",
        busyInput: "native-steer",
        fork: "native-turn",
        detach: "native-unsubscribe",
      },
      capabilities: { images: true, cancel: true, permissions: true },
      status: () => ({ installed: true }),
      start: async (h) => {
        hostCallbacks = h;
        return { installed: true };
      },
      stop: async () => {},
      listSessions: async () => [],
      createSession: async ({ cwd }) => ({ nativeId: "n-1", cwd, createdAt: 1000, updatedAt: 1000 }),
      attach: async () => [],
      detach: async () => {},
      prompt: async () => "started",
      cancel: async () => {},
      respondPermission: async () => {},
    };

    const hub = new SessionHub(store, [fakeDriver], () => {}, dir);
    await hub.start({ discoveryIntervalMs: 0 });
    try {
      const created = await hub.createSession({ agent: "codex", cwd: dir });
      // Turn 1 with NO subscribers -> compacted immediately on ls_turn ended.
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "ls_turn", state: "started" });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Part 1 " } });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Part 2" } });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });

      expect(store.readEvents(created.id, 0, 50).filter((e) => e.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);

      // Turn 2 WITH an active subscriber -> chunks kept granular until subscriber leaves and idle flush runs.
      const sub = { event: () => {} };
      await hub.subscribe(created.id, 0, sub);
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "ls_turn", state: "started" });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Live A " } });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Live B" } });
      hostCallbacks.update("codex", "n-1", { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });

      expect(store.readEvents(created.id, 0, 50).filter((e) => e.update.sessionUpdate === "agent_message_chunk")).toHaveLength(3);

      hub.unsubscribe(created.id, sub);
      expect(hub.compactIdleSessions()).toBe(1);
      expect(store.readEvents(created.id, 0, 50).filter((e) => e.update.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
    } finally {
      await hub.stop();
      store.close();
    }
  });

  it("prunes exited terminal_frames >7d, caps live terminal_frames window, retains removed_sessions by count cap, and checkpoints WAL", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const store = new HostStore(dbPath);
    const now = 1_800_000_000_000;
    const eightDaysAgo = now - 8 * 86_400_000;
    const twoDaysAgo = now - 2 * 86_400_000;
    const fortyDaysAgo = now - 40 * 86_400_000;

    store.upsertSession({ id: "codex:s1", agent: "codex", nativeId: "s1", cwd: dir, createdAt: fortyDaysAgo, updatedAt: now });
    // Old exited terminal (>7d): frames pruned, snapshot preserved!
    store.saveTerminal({
      id: "term-old-exited",
      title: "zsh",
      cwd: dir,
      cols: 80,
      rows: 24,
      createdAt: eightDaysAgo,
      activeAt: eightDaysAgo,
      exitCode: 0,
      ended: true,
      buffer: "",
    });
    store.appendTerminalFrame("term-old-exited", 1, 80, 24, "old frame");
    store.saveTerminalSnapshot("term-old-exited", { frame: 1, cols: 80, rows: 24, data: "preserved snapshot" });

    // Still-running terminal (ended = false): sliding window prunes older frames beyond maxTerminalFrames!
    store.saveTerminal({
      id: "term-running",
      title: "zsh",
      cwd: dir,
      cols: 80,
      rows: 24,
      createdAt: eightDaysAgo,
      activeAt: eightDaysAgo,
      exitCode: null,
      ended: false,
      buffer: "",
    });
    for (let f = 1; f <= 5; f++) {
      store.appendTerminalFrame("term-running", f, 80, 24, `running-${f}`);
    }

    // Recent exited terminal (2d ago): frames within window preserved!
    store.saveTerminal({
      id: "term-recent-exited",
      title: "zsh",
      cwd: dir,
      cols: 80,
      rows: 24,
      createdAt: twoDaysAgo,
      activeAt: twoDaysAgo,
      exitCode: 0,
      ended: true,
      buffer: "",
    });
    store.appendTerminalFrame("term-recent-exited", 1, 80, 24, "recent frame");

    store.claimClientMessage("codex:s1", "old-msg", fortyDaysAgo);
    store.claimClientMessage("codex:s1", "fresh-msg", twoDaysAgo);

    // Backdate removed_sessions directly to verify >30d tombstones stay until count cap is exceeded.
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      INSERT INTO removed_sessions (id, ts) VALUES
        ('codex:oldest-removed', ${fortyDaysAgo - 1000}),
        ('codex:old-removed', ${fortyDaysAgo}),
        ('codex:fresh-removed', ${twoDaysAgo});
    `);
    raw.close();

    const reopened = new HostStore(dbPath);
    try {
      // Default 50,000 cap keeps >30d tombstones so deleted sessions never resurrect on discovery.
      const first = reopened.runMaintenance(now, { maxTerminalFrames: 3, idle: true });
      expect(first.prunedTerminalFrames).toBe(3); // 1 from term-old-exited + 2 excess from term-running (frames 1,2)
      expect(first.prunedClientMessages).toBe(1);
      expect(first.prunedRemovedSessions).toBe(0);
      expect(reopened.isRemoved("codex:oldest-removed")).toBe(true);
      expect(reopened.isRemoved("codex:old-removed")).toBe(true);

      // Enforcing a smaller count cap (2) prunes only the oldest tombstone.
      const second = reopened.runMaintenance(now, { maxRemovedSessions: 2, maxTerminalFrames: 3, idle: true });
      expect(second.prunedRemovedSessions).toBe(1);
      expect(reopened.isRemoved("codex:oldest-removed")).toBe(false);
      expect(reopened.isRemoved("codex:old-removed")).toBe(true);
      expect(reopened.isRemoved("codex:fresh-removed")).toBe(true);

      expect(reopened.lastTerminalFrame("term-old-exited")).toBe(0);
      expect(reopened.terminalSnapshot("term-old-exited")?.data).toBe("preserved snapshot");
      expect(reopened.terminalFrames("term-running", 0, 10).map((f) => f.frame)).toEqual([3, 4, 5]);
      expect(reopened.lastTerminalFrame("term-recent-exited")).toBe(1);

      // Old client message id was pruned so claiming it succeeds; fresh one is still deduplicated.
      expect(reopened.claimClientMessage("codex:s1", "old-msg")).toBe(true);
      expect(reopened.claimClientMessage("codex:s1", "fresh-msg")).toBe(false);
    } finally {
      reopened.close();
    }
  });
});
