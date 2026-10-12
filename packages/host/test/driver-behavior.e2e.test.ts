import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acpAgentSettingsSchema, type SessionEvent } from "@linkshell/wire";
import type { AgentDriver } from "../src/drivers/types.js";
import { acpBehavior } from "../src/drivers/acp/behavior.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("driver did not fulfill its behavior contract");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the same host behavior contract across native and ACP drivers", () => {
  it.each([
    { kind: "codex", desktop: "multi_client", history: "native-snapshot", fork: "native-turn" },
    { kind: "claude", desktop: "handoff", history: "native-snapshot", fork: "native-turn" },
    { kind: "acp", desktop: "remote", history: "load-replay", fork: "native-session" },
    { kind: "resume-only", desktop: "remote", history: "resume-only", fork: "native-session" },
  ])("$kind preserves approvals and history when its attachment is released", async (expected) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ls-contract-")));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const env = { ...process.env, FAKE_ACP_STORE: join(home, "agent.json"), FAKE_ACP_FORK: expected.kind === "claude" ? "0" : "1",
      FAKE_ACP_RESUME_ONLY: expected.kind === "resume-only" ? "1" : "0",
      FAKE_ACP_CALL_LOG: join(home, "calls.log"),
      FAKE_ACP_INIT_DELAY: expected.kind === "acp" ? "200" : undefined,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      FAKE_ACP_CLAUDE_DIR: expected.kind === "claude" ? join(home, "claude") : undefined };
    let driver!: AgentDriver;
    const host = await startHost({ home, version: "test", iceServers: false, discoveryIntervalMs: 0, log: () => {},
      drivers: (paths) => {
        driver = expected.kind === "codex"
          ? new CodexDriver({ socketPath: paths.codexSocket, command: fixture("fake-codex"), env, hostVersion: "test", sharedSocketPath: false, desktopBusPath: false })
          : expected.kind === "claude"
            ? new ClaudeDriver({ env, hostVersion: "test", claudeCommand: fixture("fake-claude"), adapter: { command: process.execPath, args: [fixture("fake-acp")] } })
            : new AcpDriver({ id: "fixture", label: "Fixture", tier: "remote", command: process.execPath, args: [fixture("fake-acp")] }, { env, hostVersion: "test" });
        return [driver];
      },
    });
    cleanups.push(() => host.stop());
    const client = await connectHost(host.paths.hostSocket);
    cleanups.push(() => client.close());
    const events: SessionEvent[] = [];
    client.on("session.event", (event) => events.push(event));
    const { session } = await client.call("sessions.create", { agent: driver.id, cwd: home });
    await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    expect(driver.behavior).toMatchObject({ desktop: expected.desktop, history: expected.history, fork: expected.fork });
    const info = (await client.call("machine.info", {})).agents.find((agent) => agent.id === driver.id)!;
    expect(info).toMatchObject({ tier: expected.desktop, capabilities: { fork: true, steer: expected.kind === "codex" } });

    await client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "contract", content: [{ type: "text", text: "RUN contract" }] });
    await until(() => events.some((event) => event.update.sessionUpdate === "ls_permission"));
    expect(host.hub.getSession(session.id).pendingPermissions).toBe(1);
    const permission = events.find((event) => event.update.sessionUpdate === "ls_permission")!.update;
    if (permission.sessionUpdate !== "ls_permission") throw new Error("missing approval");
    await client.call("sessions.permission", { sessionId: session.id, requestId: permission.requestId, optionId: permission.options.find((option) => option.kind === "allow_once")!.optionId });
    await until(() => events.some((event) => event.update.sessionUpdate === "ls_turn" && event.update.state === "ended"));
    expect(host.hub.getSession(session.id)).toMatchObject({ state: "idle", pendingPermissions: 0 });
    const before = events.filter((event) => event.update.sessionUpdate === "agent_message_chunk").map((event) => event.seq);
    expect(before.length).toBeGreaterThan(0);

    await driver.detach(session.nativeId);
    host.hub.driverHost.detached(driver.id, session.nativeId);
    events.length = 0;
    await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    const restored = events.filter((event) => event.update.sessionUpdate === "agent_message_chunk").map((event) => event.seq);
    expect(restored).toEqual(before);
    expect(host.hub.getSession(session.id).state).toBe("idle");
    if (expected.kind === "acp") {
      await client.call("agents.configure", { agent: driver.id, settings: acpAgentSettingsSchema.parse({}) });
      expect(driver.behavior.fork).toBe("unresolved");
      const [, forked] = await Promise.all([(driver as AcpDriver).acpInfo(), host.hub.fork(session.id)]);
      expect(forked.nativeId).not.toBe(session.nativeId);
      expect(readFileSync(join(home, "calls.log"), "utf8")).toContain("session/fork\n");
      expect(driver.behavior.fork).toBe("native-session");
    }
    if (expected.kind === "claude") {
      const reply = events.find((event) => event.update.sessionUpdate === "agent_message_chunk")!.update;
      if (reply.sessionUpdate !== "agent_message_chunk") throw new Error("missing reply");
      const forked = await host.hub.fork(session.id, { itemId: reply.messageId });
      expect(forked.nativeId).not.toBe(session.nativeId);
      const history = await driver.attach(forked.nativeId, { cwd: home });
      expect(history.flatMap((item) => item.updates).some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    }
  });

  it("does not inherit capabilities from an absent or incompatible handshake", () => {
    for (const protocolVersion of [undefined, 99]) {
      const behavior = acpBehavior("remote", { protocolVersion, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, close: {} }, _meta: { steering: { supported: true } } } });
      expect(behavior).toMatchObject({ history: "unavailable", busyInput: "queue", fork: "unresolved", detach: "local-only" });
    }
  });

  it("keeps native Claude history and turn forks without an ACP fork advertisement", () => {
    const driver = new ClaudeDriver({ hostVersion: "test", adapter: { command: process.execPath, args: [] } });
    expect(driver.behavior).toMatchObject({ desktop: "handoff", history: "native-snapshot", fork: "native-turn", busyInput: "queue" });
    expect(driver.capabilities.fork).toBe(true);
  });
});
