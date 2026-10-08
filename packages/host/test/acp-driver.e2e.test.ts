import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  cachedAuthMethod: "cached_token",
};

const running: { host: RunningHost; home: string }[] = [];

async function setup(env: Record<string, string> = {}, store?: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "lsh-acp-"));
  const storePath = join(home, "fake-acp-store.json");
  const authLog = join(home, "auth.log");
  if (store) writeFileSync(storePath, JSON.stringify(store));
  const host = await startHost({
    home,
    version: "test",
    drivers: () => [new AcpDriver(spec, { env: { ...process.env, FAKE_ACP_STORE: storePath, FAKE_ACP_AUTH_LOG: authLog, ...env }, hostVersion: "test" })],
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
  return { host, client, events, summaries, of, text, ended, storePath, authLog };
}

afterEach(async () => {
  for (const { host, home } of running.splice(0)) {
    await host.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

const prompt = (t: string) => [{ type: "text" as const, text: t }];

describe("generic ACP driver (fake agent)", () => {
  it("accepts raw runtime Goal updates without enabling AIR client behavior", async () => {
    const f = await setup();
    const { session } = await f.client.call("sessions.create", { agent: "fake", cwd: "/tmp" });
    await f.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await f.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "raw-goal", content: prompt("RAW_GOAL") });
    await waitFor(() => f.of(session.id).some((event) => event.update.sessionUpdate === "ls_goal"));
    expect(f.of(session.id).find((event) => event.update.sessionUpdate === "ls_goal")?.update).toMatchObject({ goal: { objective: "完整验证", status: "active", iterations: 2 } });
  });
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

  it("forks a session of an agent that can't fork itself: the conversation is shown, and handed to the agent as text", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("first") });
    await waitFor(() => t.ended(session.id).length === 1);
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("second") });
    await waitFor(() => t.ended(session.id).length === 2);
    const said = (id: string) =>
      t.of(id).flatMap((e) =>
        (e.update.sessionUpdate === "user_message_chunk" || e.update.sessionUpdate === "agent_message_chunk") && e.update.content.type === "text"
          ? [e.update.content.text]
          : [],
      );
    const firstReply = t.of(session.id).find((e) => e.update.sessionUpdate === "agent_message_chunk")!.update as { messageId: string };

    // From the first reply: what came after it stays behind.
    const { session: fork } = await t.client.call("sessions.fork", { sessionId: session.id, itemId: firstReply.messageId });
    expect(fork.id).not.toBe(session.id);
    expect(fork).toMatchObject({ agent: "fake", cwd: "/w", title: t.host.hub.getSession(session.id).title, state: "idle" });
    await t.client.call("sessions.subscribe", { sessionId: fork.id, fromSeq: 0 });
    expect(said(fork.id).join("")).toBe("firstecho: first");
    expect(t.of(fork.id).find((e) => e.update.sessionUpdate === "ls_notice")?.update).toMatchObject({ title: expect.stringContaining("分叉") });

    // The agent gets the conversation with the first message; the user is shown only what they wrote.
    await t.client.call("sessions.prompt", { sessionId: fork.id, clientMessageId: "c", content: prompt("go on") });
    await waitFor(() => t.ended(fork.id).length === 1);
    const all = said(fork.id).join("");
    expect(all.startsWith("firstecho: firstgo onecho: <previous-conversation>")).toBe(true);
    const reply = all.slice("firstecho: firstgo on".length);
    expect(reply).toContain("<previous-conversation>");
    expect(reply).toContain("User: first");
    expect(reply).toContain("Assistant: echo: first");
    expect(reply).not.toContain("second");
    expect(reply.trimEnd().endsWith("go on")).toBe(true);
    // Once is enough.
    await t.client.call("sessions.prompt", { sessionId: fork.id, clientMessageId: "d", content: prompt("again") });
    await waitFor(() => t.ended(fork.id).length === 2);
    expect(said(fork.id).join("").endsWith("go onagainecho: again")).toBe(true);

    // The whole session, and the original is untouched.
    const { session: whole } = await t.client.call("sessions.fork", { sessionId: session.id });
    await t.client.call("sessions.subscribe", { sessionId: whole.id, fromSeq: 0 });
    expect(said(whole.id).join("")).toBe("firstecho: firstsecondecho: second");
    expect(said(session.id).join("")).toBe("firstecho: firstsecondecho: second");
  });

  it("keeps a fork's new replies apart from the copied ones when the agent numbers its messages per session", async () => {
    const t = await setup({ FAKE_ACP_MESSAGE_IDS: "0" });
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("first") });
    await waitFor(() => t.ended(session.id).length === 1);
    const { session: fork } = await t.client.call("sessions.fork", { sessionId: session.id });
    await t.client.call("sessions.subscribe", { sessionId: fork.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: fork.id, clientMessageId: "b", content: prompt("go on") });
    await waitFor(() => t.ended(fork.id).length === 1);
    const agentIds = t
      .of(fork.id)
      .flatMap((e) => (e.update.sessionUpdate === "agent_message_chunk" ? [e.update.messageId] : []));
    // The copied reply and the new one are two messages.
    expect(new Set(agentIds).size).toBe(2);
    expect(agentIds[0]).toMatch(/^fork:/);
    expect(agentIds.at(-1)).not.toMatch(/^fork:/);
  });

  it("uses an agent's own fork for a whole session, and its own way for a fork from a reply", async () => {
    const t = await setup({ FAKE_ACP_FORK: "1" });
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("first") });
    await waitFor(() => t.ended(session.id).length === 1);
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("second") });
    await waitFor(() => t.ended(session.id).length === 2);
    expect((await t.client.call("machine.info", {})).agents[0]!.capabilities.fork).toBe(true);

    // Whole: the agent's fork knows the conversation itself — nothing to carry.
    const { session: whole } = await t.client.call("sessions.fork", { sessionId: session.id });
    await t.client.call("sessions.subscribe", { sessionId: whole.id, fromSeq: 0 });
    expect(t.text(whole.id)).toBe("echo: firstecho: second");
    await t.client.call("sessions.prompt", { sessionId: whole.id, clientMessageId: "c", content: prompt("more") });
    await waitFor(() => t.ended(whole.id).length === 1);
    expect(t.text(whole.id)).toBe("echo: firstecho: secondecho: more");

    // From a reply: the agent can't cut a session, so the fork is made from our log.
    const firstReply = t.of(session.id).find((e) => e.update.sessionUpdate === "agent_message_chunk")!.update as { messageId: string };
    const { session: cut } = await t.client.call("sessions.fork", { sessionId: session.id, itemId: firstReply.messageId });
    await t.client.call("sessions.subscribe", { sessionId: cut.id, fromSeq: 0 });
    expect(t.text(cut.id)).toBe("echo: first");
    await t.client.call("sessions.prompt", { sessionId: cut.id, clientMessageId: "d", content: prompt("more") });
    await waitFor(() => t.ended(cut.id).length === 1);
    expect(t.text(cut.id)).toContain("User: first");
    expect(t.text(cut.id)).not.toContain("second");
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

  it("shows the queue on the summary, lets a queued message be dropped, and stopping clears it", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("SLOW one") });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("second") });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "c", content: prompt("third") });
    const queued = await waitFor(() => t.summaries.findLast((s) => s.id === session.id)?.queue?.length === 2 && t.summaries.findLast((s) => s.id === session.id));
    expect(queued.queue).toEqual([
      { clientMessageId: "b", text: "second", images: 0 },
      { clientMessageId: "c", text: "third", images: 0 },
    ]);
    expect(await t.client.call("sessions.unqueue", { sessionId: session.id, clientMessageId: "b" })).toEqual({ removed: true });
    expect(await t.client.call("sessions.unqueue", { sessionId: session.id, clientMessageId: "b" })).toEqual({ removed: false });
    await waitFor(() => t.summaries.findLast((s) => s.id === session.id)?.queue?.length === 1);
    await t.client.call("sessions.cancel", { sessionId: session.id });
    await waitFor(() => !t.summaries.findLast((s) => s.id === session.id)?.queue);
    await waitFor(() => t.ended(session.id).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.text(session.id)).not.toContain("echo: third");
    expect(t.text(session.id)).not.toContain("echo: second");
  });

  it("renames, archives and deletes a session; a deleted one isn't rediscovered", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("hello") });
    await waitFor(() => t.ended(session.id).length === 1);
    expect((await t.client.call("sessions.rename", { sessionId: session.id, title: "  My   task " })).session.title).toBe("My task");
    expect((await t.client.call("sessions.archive", { sessionId: session.id, archived: true })).session.archived).toBe(true);
    expect((await t.client.call("sessions.list", {})).sessions.map((s) => s.id)).not.toContain(session.id);
    expect((await t.client.call("sessions.list", { includeArchived: true })).sessions.map((s) => s.id)).toContain(session.id);
    let removed: string | undefined;
    t.client.on("session.removed", ({ sessionId }) => (removed = sessionId));
    await t.client.call("sessions.delete", { sessionId: session.id });
    await waitFor(() => removed === session.id);
    // Gone from the agent too (session/delete), and not brought back by discovery.
    const store = JSON.parse((await import("node:fs")).readFileSync(t.storePath, "utf8")) as { sessions?: Record<string, unknown> };
    expect(Object.keys(store.sessions ?? store)).not.toContain(session.nativeId);
    await t.host.hub.refreshDiscovery();
    expect((await t.client.call("sessions.list", { includeArchived: true })).sessions.map((s) => s.id)).not.toContain(session.id);
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

  it("puts an agent's questions to the phone: picks, an own answer, skipping", async () => {
    const t = await setup();
    const { session } = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    await t.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    const asked = () => t.of(session.id).flatMap((e) => (e.update.sessionUpdate === "ls_permission" ? [e.update] : []));

    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: prompt("ASK me") });
    await waitFor(() => asked().length === 1);
    const request = asked()[0]!;
    // Each question once, with what can be picked; the adapter's "Other" fields are the questions' own-answer box.
    expect(request).toMatchObject({
      toolCallId: "toolu_ask",
      options: [{ optionId: "skip" }, { optionId: "cancel" }],
      questions: [
        { id: "question_0", header: "Database", text: "Which database should it use?", kind: "choice", other: true, options: [{ value: "Postgres", description: "Good default" }, { value: "SQLite" }] },
        { id: "question_1", header: "Checks", text: "Which checks should run?", kind: "choices", other: true },
      ],
    });
    // The session waits for the user, and says with what.
    expect(t.host.hub.getSession(session.id)).toMatchObject({ state: "waiting", pendingPermissions: 1, permission: { requestId: request.requestId, questions: [{ id: "question_0" }, { id: "question_1" }] } });

    // Something that wasn't offered isn't an answer; what was asked for is passed on in the form's own shape.
    await t.client.call("sessions.answer", {
      sessionId: session.id,
      requestId: request.requestId,
      answers: [
        { id: "question_0", values: ["Postgres", "MySQL"], other: "version 16 please" },
        { id: "question_1", values: ["lint", "types", "deploy"] },
        { id: "question_9", values: ["x"] },
      ],
    });
    await waitFor(() => t.ended(session.id).length === 1);
    expect(t.text(session.id)).toBe(
      `asked: ${JSON.stringify({ action: "accept", content: { question_0: "Postgres", question_0_custom: "version 16 please", question_1: ["lint", "types"] } })}`,
    );
    const resolved = t.of(session.id).find((e) => e.update.sessionUpdate === "ls_permission_resolved")?.update;
    expect(resolved).toMatchObject({ requestId: request.requestId, optionId: "answered", answers: [{ id: "question_0", values: ["Postgres"], other: "version 16 please" }, { id: "question_1", values: ["lint", "types"] }] });
    expect(t.host.hub.getSession(session.id)).toMatchObject({ state: "idle", pendingPermissions: 0 });
    // Answered once.
    await expect(t.client.call("sessions.answer", { sessionId: session.id, requestId: request.requestId, answers: [] })).rejects.toMatchObject({ appCode: "not_found" });

    // Skipping lets the agent go on without an answer; stopping ends the turn.
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "b", content: prompt("ASK again") });
    await waitFor(() => asked().length === 2);
    await t.client.call("sessions.permission", { sessionId: session.id, requestId: asked()[1]!.requestId, optionId: "skip" });
    await waitFor(() => t.ended(session.id).length === 2);
    expect(t.text(session.id)).toContain('asked: {"action":"decline"}');
    await t.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "c", content: prompt("ASK once more") });
    await waitFor(() => asked().length === 3);
    await t.client.call("sessions.cancel", { sessionId: session.id });
    await waitFor(() => t.ended(session.id).length === 3);
    expect(t.text(session.id)).toContain('asked: {"action":"cancel"}');
    expect(t.host.hub.getSession(session.id).pendingPermissions).toBe(0);
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
    const t = await setup({ FAKE_ACP_CACHED_AUTH: "1" }, store);
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
    expect(readFileSync(t.authLog, "utf8")).toBe("cached_token\ncached_token\n");
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

  it("says how to log in when the agent refuses a session without one (Grok)", async () => {
    const t = await setup({ FAKE_ACP_SIGNED_OUT: "1" });
    const failure = await t.client.call("sessions.create", { agent: "fake", cwd: "/w" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: expect.stringContaining("Fake 未登录：在电脑终端运行"), data: { code: "not_logged_in" } });
    const agents = t.host.hub.agents().find((agent) => agent.id === "fake");
    expect(agents?.auth).toMatchObject({ state: "missing", hint: expect.stringContaining("未登录") });
    expect(existsSync(t.authLog)).toBe(false);
  });

  it("shares cached authentication across concurrent session opens", async () => {
    const t = await setup({ FAKE_ACP_CACHED_AUTH: "1" });
    const sessions = await Promise.all(["/w/a", "/w/b"].map((cwd) => t.client.call("sessions.create", { agent: "fake", cwd })));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.session.id).not.toBe(sessions[1]!.session.id);
    expect(readFileSync(t.authLog, "utf8")).toBe("cached_token\n");
  });

  it("shows a login error when cached authentication cannot load discovered history", async () => {
    const t = await setup({ FAKE_ACP_CACHED_AUTH: "1", FAKE_ACP_SIGNED_OUT: "1" }, {
      old: { cwd: "/w", title: "Old task", updatedAt: "2026-09-01T00:00:00.000Z", mode: "default", model: "fast",
        history: [{ role: "user", id: "u", text: "hi" }] },
    });
    await t.client.call("sessions.subscribe", { sessionId: "fake:old", fromSeq: 0 });
    expect(t.of("fake:old").find((event) => event.update.sessionUpdate === "ls_error")?.update)
      .toMatchObject({ code: "not_logged_in", message: expect.stringContaining("Fake 未登录") });
    expect(readFileSync(t.authLog, "utf8")).toBe("cached_token\n");
  });

  it("retries an auth-rejected session only once even if authenticate succeeds", async () => {
    const t = await setup({ FAKE_ACP_CACHED_AUTH: "1", FAKE_ACP_REJECT_AUTH: "1" });
    await expect(t.client.call("sessions.create", { agent: "fake", cwd: "/w" }))
      .rejects.toMatchObject({ data: { code: "not_logged_in" } });
    expect(readFileSync(t.authLog, "utf8")).toBe("cached_token\n");
  });
});
