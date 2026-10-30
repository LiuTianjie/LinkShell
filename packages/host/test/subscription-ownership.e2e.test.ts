import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost, type HostClient } from "../src/rpc/client.js";
import type { AgentDriver, DriverHost } from "../src/drivers/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "lsh-subscription-"));
  const attaching = deferred();
  const attached = deferred();
  const unwatched = deferred();
  let driverHost!: DriverHost;
  const driver: AgentDriver = {
    id: "delayed", label: "Delayed history", tier: "multi_client",
    capabilities: { interrupt: true, steer: false, permissions: false, images: false, fork: false, models: false, modes: false },
    behavior: { desktop: "multi_client", history: "native-snapshot", turnCompletion: "native-events", busyInput: "queue", fork: "context", detach: "local-only" },
    async start(host) { driverHost = host; return { installed: true }; },
    async stop() {}, status: () => ({ installed: true }),
    async listSessions() { return [{ nativeId: "one", cwd: home, createdAt: 1, updatedAt: 1 }]; },
    async createSession() { throw new Error("unused"); },
    async attach() {
      attaching.resolve();
      await attached.promise;
      return [{ itemId: "history", updates: [{ sessionUpdate: "agent_message_chunk", messageId: "history", content: { type: "text", text: "Stored history" } }] }];
    },
    async detach() {}, async prompt() { return "started"; }, async cancel() {}, async respondPermission() {},
    watched(_id, open) { if (!open) unwatched.resolve(); },
  };
  const host: RunningHost = await startHost({ home, version: "subscription-e2e", drivers: () => [driver], iceServers: false, log: () => {} });
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  cleanups.push(() => host.stop());
  // Release a blocked history read even if an assertion aborts the scenario.
  cleanups.push(() => attached.resolve());
  const client: HostClient = await connectHost(host.paths.hostSocket);
  cleanups.push(() => client.close());
  const events: SessionEvent[] = [];
  client.on("session.event", (event) => events.push(event));
  return { host, client, events, attaching, attached, unwatched, emit: () => driverHost.update("delayed", "one", { sessionUpdate: "agent_message_chunk", messageId: "live", content: { type: "text", text: "After leaving" } }) };
}

describe("subscription ownership across a real host connection", () => {
  it("does not keep an old subscriber when the reader leaves and reopens during attachment", async () => {
    const { client, events, attaching, attached, unwatched, emit } = await setup();
    const first = client.call("sessions.subscribe", { sessionId: "delayed:one", fromSeq: 0 });
    await attaching.promise;
    await client.call("sessions.unsubscribe", { sessionId: "delayed:one" });
    const second = client.call("sessions.subscribe", { sessionId: "delayed:one", fromSeq: 0 });
    // The second request reaches the same real server before native history finishes.
    await client.call("machine.info", {});
    attached.resolve();
    await Promise.all([first, second]);
    const replayCount = events.filter((event) => event.update.sessionUpdate === "agent_message_chunk").length;
    await client.call("sessions.unsubscribe", { sessionId: "delayed:one" });
    events.length = 0;
    emit();
    await client.call("machine.info", {});
    expect(events).toEqual([]);
    expect(replayCount).toBe(1);
    await unwatched.promise;
  });

  it("releases a disconnected reader even when native history finishes later", async () => {
    const { client, attaching, attached, unwatched, host } = await setup();
    const subscribed = client.call("sessions.subscribe", { sessionId: "delayed:one", fromSeq: 0 }).catch(() => undefined);
    await attaching.promise;
    client.close();
    await client.closed;
    attached.resolve();
    await subscribed;
    // No old socket survives to announce completion: observe the driver's watch lifecycle.
    const released = await Promise.race([unwatched.promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
    expect(released).toBe(true);
    expect(host.hub.getSession("delayed:one").id).toBe("delayed:one");
  });
});
