import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { AcpDriver, type AcpAgentSpec } from "../src/drivers/acp/driver.js";
import { connectHost } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
chmodSync(FAKE_ACP, 0o755);

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const spec: AcpAgentSpec = {
  id: "fake",
  label: "Fake",
  tier: "remote",
  command: FAKE_ACP,
  args: [],
  version: { command: FAKE_ACP, args: ["--version"] },
  discover: true,
};

const running: { host: RunningHost; home: string }[] = [];

async function setup(env: Record<string, string> = {}, store?: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "lsh-acp-"));
  const storePath = join(home, "fake-acp-store.json");
  if (store) writeFileSync(storePath, JSON.stringify(store));
  const host = await startHost({
    home,
    version: "test",
    drivers: () => [new AcpDriver(spec, { env: { ...process.env, FAKE_ACP_STORE: storePath, ...env }, hostVersion: "test" })],
    log: () => {},
  });
  running.push({ host, home });
  const client = await connectHost(host.paths.hostSocket);
  const events: SessionEvent[] = [];
  const summaries: SessionSummary[] = [];
  client.on("session.event", (event) => events.push(event));
  client.on("session.summary", ({ session }) => summaries.push(session));
  const of = (id: string) => events.filter((e) => e.sessionId === id);
  const text = (id: string, kind = "agent_message_chunk") =>
    of(id)
      .map((e) => (e.update.sessionUpdate === kind && "content" in e.update && e.update.content.type === "text" ? e.update.content.text : ""))
      .join("");
  const ended = (id: string) => of(id).filter((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended");
  return { host, client, events, summaries, of, text, ended, storePath };
}

afterEach(async () => {
  for (const { host, home } of running.splice(0)) {
    await host.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

const prompt = (t: string) => [{ type: "text" as const, text: t }];

describe("generic ACP driver (fake agent)", () => {
  it("starts agents that don't list sessions only when first used", async () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-acp-lazy-"));
    const host = await startHost({
      home,
      version: "test",
      drivers: () => [new AcpDriver({ ...spec, discover: false }, { env: process.env, hostVersion: "test" })],
      log: () => {},
    });
    running.push({ host, home });
    const driver = (host.hub as unknown as { drivers: Map<string, AcpDriver> }).drivers.get("fake")!;
    expect((driver as unknown as { connection?: unknown }).connection).toBeUndefined();
    expect(host.machineInfo().agents[0]).toMatchObject({ installed: true, version: "1.2.3" });
    const client = await connectHost(host.paths.hostSocket);
    const { session } = await client.call("sessions.create", { agent: "fake", cwd: "/w" });
    expect(session.agent).toBe("fake");
    expect((driver as unknown as { connection?: { alive: boolean } }).connection?.alive).toBe(true);
    client.close();
  });

  it("reports the agent and streams a turn with config, thoughts and a closed message", async () => {
    const t = await setup();
    const info = await t.client.call("machine.info", {});
    expect(info.agents[0]).toMatchObject({ id: "fake", installed: true, version: "1.2.3", tier: "remote" });
    expect(info.agents[0]?.capabilities).toMatchObject({ steer: false, images: true });

    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w/app" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    const config = await waitFor(() => t.of(session.id).find((e) => e.update.sessionUpdate === "ls_config"));
    expect(config.update).toMatchObject({
      options: [
        { id: "model", category: "model", current: "fast", values: [{ value: "fast" }, { value: "smart" }] },
        { id: "mode", category: "mode", current: "default" },
      ],
    });

    expect(await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "c1", content: prompt("hello") })).toEqual({
      delivery: "started",
    });
    await waitFor(() => t.ended(session.id).length === 1);
    expect(t.text(session.id)).toBe("echo: hello");
    expect(t.text(session.id, "agent_thought_chunk")).toBe("thinking");
    expect(t.text(session.id, "user_message_chunk")).toBe("hello");
    const kinds = t.of(session.id).map((e) => e.update.sessionUpdate);
    expect(kinds.filter((k) => k === "ls_message_done")).toHaveLength(3); // user, thought, agent
    expect(t.ended(session.id)[0]?.update).toMatchObject({ stopReason: "end_turn" });
    expect(t.host.hub.getSession(session.id)).toMatchObject({ title: "hello", preview: "echo: hello", state: "idle" });
  });

  it("queues a message sent mid-turn when the agent can't steer, then runs it", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("SLOW one") });
    expect(await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("second") })).toEqual({
      delivery: "queued",
    });
    await waitFor(() => t.ended(session.id).length === 2, 8000);
    expect(t.text(session.id)).toContain("echo: second");
  });

  it("steers into a running turn when the agent supports prompt queueing", async () => {
    const t = await setup({ FAKE_ACP_STEERING: "1" });
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("SLOW one") });
    await waitFor(() => t.text(session.id).includes("s1 "));
    expect(await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("change course") })).toEqual({
      delivery: "steered",
    });
    await waitFor(() => t.ended(session.id).length === 1, 8000);
    expect(t.text(session.id)).toContain("echo: change course");
    expect(t.host.hub.getSession(session.id).state).toBe("idle");
  });

  it("cancels a running turn", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("SLOW") });
    await waitFor(() => t.text(session.id).includes("s2 "));
    await t.client.call("sessions.cancel", { sessionId: session.id });
    const ended = await waitFor(() => t.ended(session.id)[0]);
    expect(ended.update).toMatchObject({ stopReason: "cancelled" });
    expect(t.text(session.id)).not.toContain("s29");
  });

  it("routes a permission request to the phone and back", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("RUN it") });
    const request = await waitFor(() => t.of(session.id).find((e) => e.update.sessionUpdate === "ls_permission"));
    expect(request.update).toMatchObject({ title: "Run echo hi", detail: "echo hi", options: [{ optionId: "allow-once", kind: "allow_once" }, {}, {}] });
    expect(t.host.hub.getSession(session.id)).toMatchObject({ state: "waiting", pendingPermissions: 1 });
    await t.client.call("sessions.permission", {
      sessionId: session.id,
      requestId: (request.update as { requestId: string }).requestId,
      optionId: "allow-once",
    });
    await waitFor(() => t.ended(session.id).length === 1);
    const done = t.of(session.id).find((e) => e.update.sessionUpdate === "tool_call_update" && e.update.status === "completed");
    expect(done?.update).toMatchObject({ content: [{ type: "content", content: { type: "text", text: "hi" } }] });
    expect(t.host.hub.getSession(session.id)).toMatchObject({ state: "idle", pendingPermissions: 0 });
  });

  it("changes model and mode", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.setConfig", { sessionId: session.id, optionId: "model", value: "smart" });
    await t.client.call("sessions.setConfig", { sessionId: session.id, optionId: "mode", value: "plan" });
    await expect(t.client.call("sessions.setConfig", { sessionId: session.id, optionId: "model", value: "nope" })).rejects.toMatchObject({
      appCode: "invalid_params",
    });
    const configs = t.of(session.id).filter((e) => e.update.sessionUpdate === "ls_config");
    expect(configs[configs.length - 1]?.update).toMatchObject({
      options: [{ id: "model", current: "smart" }, { id: "mode", current: "plan" }],
    });
  });

  it("discovers existing sessions, loads their history once, and doesn't duplicate it after an agent restart", async () => {
    const store = {
      old: {
        cwd: "/w/old",
        title: "Old task",
        updatedAt: "2026-09-01T00:00:00.000Z",
        mode: "default",
        model: "fast",
        history: [
          { role: "user", id: "u-1", text: "what is 2+2" },
          { role: "agent", id: "msg_a", text: "4" },
          { role: "tool", id: "toolu_1", text: "hi", ok: true },
        ],
      },
    };
    const t = await setup({}, store);
    const { sessions } = await t.client.call("sessions.list", {});
    expect(sessions).toEqual([expect.objectContaining({ id: "fake:old", title: "Old task", cwd: "/w/old" })]);
    await t.client.call("sessions.subscribe", { sessionId: "fake:old", fromSeq: 0 });
    expect(t.text("fake:old", "user_message_chunk")).toBe("what is 2+2");
    expect(t.text("fake:old")).toBe("4");
    const firstLoad = t.of("fake:old").length;

    // New turn, then the agent process dies and the session is reopened.
    await t.client.call("sessions.prompt", { sessionId: "fake:old", clientMessageId: "n1", content: prompt("and 3+3?") });
    await waitFor(() => t.ended("fake:old").length === 1);
    const driver = (t.host.hub as unknown as { drivers: Map<string, AcpDriver> }).drivers.get("fake")!;
    await (driver as unknown as { connection: { stop(): Promise<void> } }).connection.stop();
    (driver as unknown as { onExit(reason: string): void }).onExit("test kill");
    await waitFor(() => t.host.machineInfo().agents[0]?.problem === undefined, 10_000);
    const before = t.of("fake:old").length;
    const again = await connectHost(t.host.paths.hostSocket);
    const replayed: SessionEvent[] = [];
    again.on("session.event", (e) => replayed.push(e));
    await again.call("sessions.subscribe", { sessionId: "fake:old", fromSeq: before });
    // Only status/config bookkeeping after reopening; no message is imported twice.
    const kinds = t.of("fake:old").slice(before).map((e) => e.update.sessionUpdate);
    expect(kinds.filter((k) => k.endsWith("_chunk"))).toEqual([]);
    expect(firstLoad).toBeGreaterThan(0);
    again.close();
  }, 20_000);

  it("uses content-derived ids for agents without message ids", async () => {
    const store = {
      s: { cwd: "/w", title: "No ids", updatedAt: "2026-09-01T00:00:00.000Z", mode: "default", model: "fast", history: [
        { role: "user", id: "u", text: "hi" },
        { role: "agent", id: "m", text: "hello there" },
      ] },
    };
    const t = await setup({ FAKE_ACP_MESSAGE_IDS: "0" }, store);
    await t.client.call("sessions.subscribe", { sessionId: "fake:s", fromSeq: 0 });
    expect(t.text("fake:s")).toBe("hello there");
    const done = t.of("fake:s").filter((e) => e.update.sessionUpdate === "ls_message_done");
    expect(done).toHaveLength(2);
  });

  it("explains auth failures in plain language", async () => {
    const t = await setup({ FAKE_ACP_FAIL_AUTH: "1" });
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("hi") });
    const error = await waitFor(() => t.of(session.id).find((e) => e.update.sessionUpdate === "ls_error"));
    expect(error.update).toMatchObject({ message: "Fake 鉴权失败", hint: expect.stringContaining("已登录") });
    await waitFor(() => t.ended(session.id)[0]);
    expect(t.host.hub.getSession(session.id).state).toBe("error");
  });
});
