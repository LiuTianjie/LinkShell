import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import type { AgentDriver, DriverHost, HistoryItem } from "../src/drivers/types.js";
import type { DriverBehavior } from "../src/drivers/behavior.js";
import { SessionHub } from "../src/hub.js";
import { HostStore } from "../src/store.js";

// A host that reads an agent's own history again (after a restart, with a reader that now shows
// more, e.g. a message whose envelope it used to drop) must not put what it skipped before at the
// bottom of the log, below the turns that came after it.

class HistoryDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  readonly tier = "multi_client" as const;
  readonly behavior: DriverBehavior = { desktop: "multi_client", history: "native-snapshot", turnCompletion: "native-events", busyInput: "queue", fork: "context", detach: "local-only" };
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  constructor(private readonly history: HistoryItem[]) {}
  async start(_host: DriverHost) { return { installed: true, version: "1.0" }; }
  async stop() {}
  status() { return { installed: true, version: "1.0" }; }
  async listSessions() { return [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 10 }]; }
  async createSession(options: { cwd: string }) { return { nativeId: "new", cwd: options.cwd, createdAt: 2, updatedAt: 2 }; }
  async attach() { return this.history; }
  async detach() {}
  async prompt() { return "started" as const; }
  async cancel() {}
  async respondPermission() {}
}

const user = (id: string, text: string, ts: number): HistoryItem => ({ itemId: id, ts, updates: [{ sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text } }] });
const reply = (id: string, text: string, ts: number): HistoryItem => ({ itemId: id, ts, updates: [{ sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } }] });

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

async function read(store: HostStore, history: HistoryItem[]): Promise<string[]> {
  const hub = new SessionHub(store, [new HistoryDriver(history)]);
  await hub.start();
  const events: SessionEvent[] = [];
  await hub.subscribe("fake:s1", 0, { event: (event) => events.push(event), window: () => {} });
  return events.flatMap((event) => {
    const update = event.update;
    return (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") && update.content.type === "text"
      ? [`${update.sessionUpdate === "user_message_chunk" ? "user" : "agent"}: ${update.content.text}`] : [];
  });
}

describe("reading an agent's history again", () => {
  it("marks a message an earlier reading skipped as seen instead of adding it after later turns", async () => {
    dir = mkdtempSync(join(tmpdir(), "lsh-reread-"));
    const store = new HostStore(join(dir, "state.db"));
    try {
      // First reading: the reader dropped the first question (all of it looked like an envelope).
      expect(await read(store, [reply("a1", "answer 1", 2), user("u2", "question 2", 3), reply("a2", "answer 2", 4)]))
        .toEqual(["agent: answer 1", "user: question 2", "agent: answer 2"]);
      // Second reading shows it, and one new turn has happened since.
      expect(await read(store, [user("u1", "question 1", 1), reply("a1", "answer 1", 2), user("u2", "question 2", 3), reply("a2", "answer 2", 4), user("u3", "question 3", 5), reply("a3", "answer 3", 6)]))
        .toEqual(["agent: answer 1", "user: question 2", "agent: answer 2", "user: question 3", "agent: answer 3"]);
    } finally { store.close(); }
  });
});
