import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@linkshell/wire";
import { TranscriptTail } from "../src/drivers/claude/transcript.js";
import { HostStore } from "../src/store.js";
import { SessionHub, type Subscriber } from "../src/hub.js";
import { Pacer } from "../src/screen-pacer.js";
import { DirectPeer } from "../src/direct.js";
import type { AgentDriver, DriverHost } from "../src/drivers/types.js";
import type { DriverBehavior } from "../src/drivers/behavior.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ls-drivers-lifecycle-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class LifecycleDriver implements AgentDriver {
  readonly id = "claude";
  readonly label = "Claude";
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  readonly behavior: DriverBehavior = {
    desktop: "handoff",
    history: "native-snapshot",
    turnCompletion: "native-events",
    busyInput: "queue",
    fork: "context",
    detach: "local-only",
  };
  detachWhenIdle = true;
  host!: DriverHost;
  detaches = 0;
  promptImpl: (nativeId: string, content: ContentBlock[], clientMessageId: string) => Promise<"started" | "steered" | "queued"> = async () => "started";

  async start(host: DriverHost) {
    this.host = host;
    return { installed: true, version: "1.0" };
  }
  async stop() {}
  status() {
    return { installed: true, version: "1.0" };
  }
  async listSessions() {
    return [{ nativeId: "s1", cwd: "/work", createdAt: 1, updatedAt: 1 }];
  }
  async createSession(options: { cwd: string }) {
    return { nativeId: "s1", cwd: options.cwd, createdAt: 1, updatedAt: 1 };
  }
  async attach() {
    return [];
  }
  async detach() {
    this.detaches += 1;
  }
  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string) {
    return this.promptImpl(nativeId, content, clientMessageId);
  }
  async cancel() {}
  async answerPermission() {}
}

describe("host drivers, hub lifecycle, screen pacer & direct peer reliability", () => {
  it("TranscriptTail preserves multi-byte UTF-8 characters split across read chunks", () => {
    const dir = tempDir();
    const transcript = join(dir, "session.jsonl");
    // Build a line containing 3-byte CJK and 4-byte emoji characters, then write it in two halves
    // splitting RIGHT in the middle of a 4-byte emoji sequence!
    const text = "你好世界 🚀🔥 LinkShell 测试";
    const fullLine = Buffer.from(
      `${JSON.stringify({
        type: "assistant",
        uuid: "u-utf8",
        message: { id: "m-utf8", role: "assistant", content: [{ type: "text", text }] },
      })}\n`,
      "utf8",
    );
    const emojiIdx = fullLine.indexOf(Buffer.from("🚀", "utf8"));
    expect(emojiIdx).toBeGreaterThan(0);

    const lines: string[] = [];
    writeFileSync(transcript, fullLine.subarray(0, emojiIdx + 2));
    const tail = new TranscriptTail({ locate: () => transcript, offset: 0, onLine: (line) => lines.push(line) });
    // First poll sees no newline -> advances 0 bytes (doesn't corrupt the partial multi-byte character).
    tail.poll();
    expect(lines).toEqual([]);

    // Remaining bytes finish the UTF-8 sequence and newline -> full clean JSON line with zero replacement chars!
    appendFileSync(transcript, fullLine.subarray(emojiIdx + 2));
    tail.poll();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\ufffd");
    expect(JSON.parse(lines[0]!).message.content[0].text).toBe(text);
  });

  it("detaches archived sessions cleanly so detachWhenIdle drivers do not leak polling timers", async () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    const driver = new LifecycleDriver();
    const hub = new SessionHub(store, [driver]);
    await hub.start();
    try {
      const sid = "claude:s1";
      const subscriber: Subscriber = { event: () => {} };
      await hub.subscribe(sid, 0, subscriber);
      await hub.archive(sid, true);
      hub.unsubscribe(sid, subscriber);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(driver.detaches).toBeGreaterThanOrEqual(1);
    } finally {
      await hub.stop();
      store.close();
    }
  });

  it("does not stall held prompt queue after a zero-turn slash command returning started + ls_notice", async () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    const driver = new LifecycleDriver();
    const hub = new SessionHub(store, [driver]);
    await hub.start();
    try {
      const sid = "claude:s1";
      const delivered: string[] = [];
      driver.promptImpl = async (_nativeId, content) => {
        const text = content[0]?.type === "text" ? content[0].text : "";
        delivered.push(text);
        if (text === "/status") {
          // Informational slash command: emits ls_notice and NO ls_turn!
          driver.host.update("claude", "s1", { sessionUpdate: "ls_notice", level: "info", title: "/status", detail: "OK" });
        }
        return "started";
      };

      const subscriber: Subscriber = { event: () => {} };
      await hub.subscribe(sid, 0, subscriber);
      // Start an active turn so the next two prompts queue up.
      driver.host.update("claude", "s1", { sessionUpdate: "ls_turn", state: "started", turnId: "t1" });
      await hub.prompt(sid, "c-slash", [{ type: "text", text: "/status" }], "queue");
      await hub.prompt(sid, "c-next", [{ type: "text", text: "follow up" }], "queue");
      expect(delivered).toEqual([]);

      // End turn t1 -> `/status` runs, emits ls_notice without starting a turn, and `follow up` MUST immediately drain next!
      driver.host.update("claude", "s1", { sessionUpdate: "ls_turn", state: "ended", turnId: "t1", stopReason: "end_turn" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(delivered).toEqual(["/status", "follow up"]);
      hub.unsubscribe(sid, subscriber);
    } finally {
      await hub.stop();
      store.close();
    }
  });

  it("releases client_messages claim when driver reports delivery failure so retries succeed", async () => {
    const dir = tempDir();
    const store = new HostStore(join(dir, "state.db"));
    const driver = new LifecycleDriver();
    const hub = new SessionHub(store, [driver]);
    await hub.start();
    try {
      const sid = "claude:s1";
      expect(store.claimClientMessage(sid, "retry-me")).toBe(true);
      expect(store.claimClientMessage(sid, "retry-me")).toBe(false);
      driver.host.releaseClientMessage?.("claude", "s1", "retry-me");
      expect(store.claimClientMessage(sid, "retry-me")).toBe(true);
    } finally {
      await hub.stop();
      store.close();
    }
  });

  it("ScreenPacer stays in dropping mode even after >600 unshown frames evict shown + 1", () => {
    const pacer = new Pacer(0, { behindMs: 250, caughtUpMs: 80, probeMs: 5000 });
    // First frame acknowledged so `heard` is true and pacing is active.
    const f1 = pacer.next(true, 100)!;
    pacer.ack(f1, 120);
    // Send 620 keyframes spaced 1ms apart while viewer never acks again -> `sentAt` evicts `f1 + 1` (seq 2..20).
    for (let i = 0; i < 620; i += 1) {
      pacer.next(true, 200 + i);
    }
    // At t=2000 (well past behindMs, before probeMs), oldest retained frame is >1500ms old, so pacer MUST drop!
    expect(pacer.next(true, 2000)).toBeUndefined();
    expect(pacer.dropping).toBe(true);
  });

  it("DirectPeer queues under backpressure, returns false past cap, and drains via fallback timer when bufferedAmountLow is missed", async () => {
    vi.useFakeTimers();
    const sentPayloads: Buffer[] = [];
    let buffered = 1500 * 1024; // above HIGH_WATER (1 MB)
    const fakeChannel = {
      readyState: "open",
      get bufferedAmount() {
        return buffered;
      },
      bufferedAmountLowThreshold: 0,
      send: (bytes: Buffer) => {
        sentPayloads.push(bytes);
      },
      close: () => {},
    };
    const peer = new DirectPeer([], () => {});
    (peer as unknown as { channel: unknown }).channel = fakeChannel;
    try {
      const payload = new Uint8Array(1024);
      // Queued cleanly while bufferedAmount > HIGH_WATER.
      expect(peer.send({ type: "data", stream: 1, data: payload })).toBe(true);
      expect(sentPayloads).toHaveLength(0);

      let drained = false;
      const cancelDrain = peer.whenDrained(() => {
        drained = true;
      });

      // Lower bufferedAmount WITHOUT firing `bufferedAmountLow` -> 25ms fallback poll flushes queue and fires drain listener!
      buffered = 0;
      await vi.advanceTimersByTimeAsync(30);
      expect(sentPayloads).toHaveLength(1);
      expect(drained).toBe(true);
      cancelDrain();

      // Overflowing the 2 MB queue cap returns false cleanly instead of unbounded OOM.
      buffered = 1500 * 1024;
      const big = new Uint8Array(512 * 1024);
      let rejected = false;
      for (let i = 0; i < 10; i += 1) {
        if (!peer.send({ type: "data", stream: 1, data: big })) {
          rejected = true;
          break;
        }
      }
      expect(rejected).toBe(true);
    } finally {
      peer.close();
    }
  });
});
