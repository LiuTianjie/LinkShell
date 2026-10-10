import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { encodeProjectDir } from "../src/drivers/claude/transcript.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";
import { HostStore } from "../src/store.js";

const fakeAcp = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: { claude?: boolean; lazy?: boolean; env?: Record<string, string>; transcript?: "finished" | "unfinished"; holder?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ls-recovery-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const agent = options.claude ? "claude" : "fake";
  const id = `${agent}:old`;
  const store = new HostStore(join(home, "state.db"));
  for (const nativeId of ["old", "outside-discovery"]) {
    store.upsertSession({ id: `${agent}:${nativeId}`, nativeId, agent, cwd: home, title: "Prior task", state: "running", createdAt: 1, updatedAt: 2 });
    store.patchSession(`${agent}:${nativeId}`, { pendingPermissions: 1 });
    store.setDriverState(`${agent}:${nativeId}`, "asyncQuestions", JSON.stringify([{ id: "stale", title: "old question", options: [] }]));
  }
  store.appendEvent(id, { sessionUpdate: "agent_message_chunk", messageId: "cached", content: { type: "text", text: "cached reply" } }, 2);
  store.close();
  const agentStore = join(home, "agent.json");
  writeFileSync(agentStore, JSON.stringify({ old: {
    cwd: home, title: "Prior task", updatedAt: "2026-10-09T00:00:00Z", mode: "default", model: "fast",
    history: [{ role: "user", id: "u", text: "old question" }, { role: "agent", id: "a", text: "old answer" }],
  } }));
  const config = join(home, "claude");
  const transcript = join(config, "projects", encodeProjectDir(home), "old.jsonl");
  const writeTranscript = (finished: boolean) => {
    mkdirSync(join(transcript, ".."), { recursive: true });
    const entries = [
      { type: "user", uuid: "u", message: { content: "old question" } },
      ...(finished ? [{ type: "assistant", uuid: "a", message: { id: "msg_a", content: [{ type: "text", text: "old answer" }], stop_reason: "end_turn" } }] : []),
    ];
    writeFileSync(transcript, entries.map((entry) => JSON.stringify({ ...entry, sessionId: "old", cwd: home, entrypoint: "cli", timestamp: new Date().toISOString() })).join("\n") + "\n");
  };
  if (options.claude) mkdirSync(join(config, "sessions"), { recursive: true });
  if (options.transcript) writeTranscript(options.transcript === "finished");
  const holder = join(config, "sessions", `${process.pid}.json`);
  if (options.holder) writeFileSync(holder, JSON.stringify({ pid: process.pid, sessionId: "old", entrypoint: "cli" }));
  const callsPath = join(home, "calls.log");
  const env = { ...process.env, ...options.env, FAKE_ACP_STORE: agentStore, FAKE_ACP_CALL_LOG: callsPath,
    CLAUDE_CONFIG_DIR: config, FAKE_ACP_CLAUDE_DIR: options.claude ? config : undefined };
  const driver = options.claude
    ? new ClaudeDriver({ env, hostVersion: "test", claudeCommand: fakeClaude, adapter: { command: fakeAcp, args: [] }, holderCheckMs: 20 })
    : new AcpDriver({ id: agent, label: "Fake", tier: "remote", command: fakeAcp, args: [], discover: !options.lazy }, { env, hostVersion: "test" });
  const host = await startHost({ home, version: "test", drivers: () => [driver], log: () => {} });
  cleanups.push(() => host.stop());
  const client = await connectHost(host.paths.hostSocket);
  cleanups.push(() => client.close());
  const events: SessionEvent[] = [];
  client.on("session.event", (event) => { if (event.sessionId === id) events.push(event); });
  const calls = () => { try { return readFileSync(callsPath, "utf8").trim().split("\n"); } catch { return []; } };
  return { host, client, id, driver, events, calls, holder, writeTranscript };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("state did not reconcile");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const messages = (events: SessionEvent[]) => events.flatMap(({ update }) =>
  (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk") && update.content.type === "text" ? [update.content.text] : []);

describe("session discovery and history recovery", () => {
  it("replaces cached running with current idle, and leaves unverified old sessions offline without deleting them", async () => {
    const t = await setup();
    expect(t.host.hub.getSession(t.id)).toMatchObject({ state: "idle", pendingPermissions: 0, asyncQuestions: [] });
    expect(t.host.hub.getSession("fake:outside-discovery")).toMatchObject({ state: "offline", updatedAt: 2, pendingPermissions: 0, asyncQuestions: [] });
    const result = await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(result.session.state).toBe("idle");
    expect(messages(t.events)).toEqual(["cached reply", "old question", "old answer"]);
  });

  it("initializes a lazy agent before checking whether it can replay an old session", async () => {
    const t = await setup({ lazy: true });
    expect(t.calls()).toEqual([]);
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(t.calls().filter((method) => method === "initialize" || method === "session/load")).toEqual(["initialize", "session/load"]);
    expect(messages(t.events)).toContain("old answer");
    expect(t.host.hub.getSession(t.id).state).toBe("idle");
  });

  it("explains resume-only history once, preserves cached messages, and does not call session/load", async () => {
    const t = await setup({ env: { FAKE_ACP_RESUME_ONLY: "1" } });
    const before = t.host.hub.getSession(t.id).updatedAt;
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(messages(t.events)).toEqual(["cached reply"]);
    expect(t.events.filter(({ update }) => update.sessionUpdate === "ls_notice")).toHaveLength(1);
    expect(t.host.hub.getSession(t.id)).toMatchObject({ state: "idle", updatedAt: before });
    expect(t.calls()).toContain("session/resume");
    expect(t.calls()).not.toContain("session/load");
    const cursor = t.host.hub.getSession(t.id).lastSeq;
    await t.driver.detach("old");
    t.host.hub.driverHost.detached("fake", "old");
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: cursor });
    expect(t.events.filter(({ update }) => update.sessionUpdate === "ls_notice")).toHaveLength(1);
  });

  it("reports a missing Claude transcript, keeps the cache, and imports it when it is restored", async () => {
    const t = await setup({ claude: true });
    const failed = await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(failed.session.state).toBe("error");
    expect(messages(t.events)).toEqual(["cached reply"]);
    expect(t.events.some(({ update }) => update.sessionUpdate === "ls_error" && update.code === "history_unavailable")).toBe(true);
    t.writeTranscript(true);
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: failed.session.lastSeq });
    expect(messages(t.events)).toContain("old answer");
    expect(t.host.hub.getSession(t.id).state).toBe("idle");
  });

  it("does not revive an unfinished Claude turn after the writer is gone", async () => {
    const t = await setup({ claude: true, transcript: "unfinished" });
    expect(t.host.hub.getSession(t.id).state).toBe("idle");
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(t.host.hub.getSession(t.id).state).toBe("idle");
    expect(t.events.some(({ update }) => update.sessionUpdate === "ls_turn" && update.state === "started")).toBe(false);
  });

  it("preserves a live Claude turn, then clears it when its holder disappears without a final transcript entry", async () => {
    const t = await setup({ claude: true, transcript: "unfinished", holder: true });
    expect(t.host.hub.getSession(t.id).state).toBe("running");
    await t.client.call("sessions.subscribe", { sessionId: t.id, fromSeq: 0 });
    expect(t.host.hub.getSession(t.id).state).toBe("running");
    unlinkSync(t.holder);
    await until(() => t.host.hub.getSession(t.id).state === "idle");
  });

  it.each(["2", "99", "missing"])("refuses incompatible ACP version %s before invoking session methods", async (protocolVersion) => {
    const t = await setup({ env: { FAKE_ACP_PROTOCOL_VERSION: protocolVersion } });
    expect(t.driver.status().problem).toContain("不兼容的 ACP 协议版本");
    expect(t.calls()).toEqual(["initialize"]);
    expect(t.host.hub.getSession(t.id).state).toBe("offline");
  });
});
