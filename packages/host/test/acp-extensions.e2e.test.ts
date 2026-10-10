import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acpAgentSettingsSchema, type PendingPermissionSummary, type SessionEvent, type SessionNotice } from "@linkshell/wire";
import { applyEvents, emptyView } from "../../client-core/src/timeline.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const fixture = fileURLToPath(new URL("./fixtures/acp-extensions.mjs", import.meta.url));
const running: { host: RunningHost; home: string }[] = [];
afterEach(async () => { for (const { host, home } of running.splice(0)) { await host.stop(); rmSync(home, { recursive: true, force: true }); } });
async function waitFor(probe: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!probe()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function setup(version: 1 | 2 = 1) {
  const home = mkdtempSync(join(tmpdir(), "linkshell-acp-ext-"));
  writeFileSync(join(home, "acp.json"), JSON.stringify({ settings: { fixture: { protocolVersion: version } } }));
  const log = join(home, "calls.jsonl");
  const host = await startHost({ home, version: "test", iceServers: false, discoveryIntervalMs: 0, log: () => {}, drivers: () => [new AcpDriver({ id: "fixture", label: "Fixture", tier: "remote", command: process.execPath, args: [fixture], discover: true }, { env: { ...process.env, ACP_TEST_VERSION: String(version), ACP_TEST_LOG: log }, hostVersion: "test" })] });
  running.push({ home, host });
  const client = await connectHost(host.paths.hostSocket), events: SessionEvent[] = [], notices: SessionNotice[] = [], interactions: PendingPermissionSummary[] = [];
  client.on("session.event", (event) => events.push(event));
  client.on("session.notice", ({ notice }) => notices.push(notice));
  client.on("agent.interaction", ({ request }) => { if (!("resolved" in request)) interactions.push(request); });
  const { session } = await client.call("sessions.create", { agent: "fixture", cwd: home });
  await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
  const send = (text: string, id = text) => client.call("sessions.prompt", { sessionId: session.id, clientMessageId: id, content: [{ type: "text", text }] });
  const ended = () => events.filter((event) => event.update.sessionUpdate === "ls_turn" && event.update.state === "ended" && !event.update.parentToolCallId).length;
  const view = () => applyEvents(emptyView(session.id), events);
  return { home, host, client, events, notices, interactions, session, send, ended, view, log };
}

describe("ACP optional capabilities across the host RPC", () => {
  it("negotiates services, sends configured MCP roots, and consumes authoritative boolean config responses", async () => {
    const f = await setup();
    const info = await f.client.call("agents.acp", { agent: "fixture" });
    expect(info.features).toMatchObject({ protocolVersion: 1, mcpHttp: true, additionalDirectories: true, logout: true });
    await f.client.call("agents.configure", { agent: "fixture", sessionId: f.session.id, settings: acpAgentSettingsSchema.parse({ additionalDirectories: [f.home], mcpServers: [{ type: "http", name: "docs", url: "https://example.com/mcp", headers: { "X-Test": "yes" } }] }) });
    await f.client.call("sessions.subscribe", { sessionId: f.session.id, fromSeq: f.events.at(-1)?.seq ?? 0 });
    await f.client.call("sessions.setConfig", { sessionId: f.session.id, optionId: "enabled", value: "on" });
    expect(f.view().config).toMatchObject([{ id: "enabled", type: "boolean", current: "on" }]);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const load = calls.findLast((entry) => entry.method === "session/load");
    expect(load.params).toMatchObject({ additionalDirectories: [f.home], mcpServers: [{ type: "http", name: "docs", headers: [{ name: "X-Test", value: "yes" }] }] });
    expect(calls.find((entry) => entry.method === "initialize").params.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {}, url: {} }, session: { configOptions: { boolean: {} }, compaction: {}, notices: {} } });
  });

  it("runs client file and terminal services through actual reverse RPC requests", async () => {
    const f = await setup(); await f.send("IO"); await waitFor(() => f.ended() === 1);
    expect(readFileSync(join(f.home, "written.txt"), "utf8")).toBe("第一行\n第二行\n");
    const text = f.view().items.find((item) => item.kind === "agent");
    expect(text?.kind === "agent" && text.text).toContain("终端中文");
    expect(f.view().items.find((item) => item.id === "terminal-tool")).toMatchObject({ kind: "tool", output: "终端中文", status: "completed" });
  });

  it("streams client terminal deltas through RPC without retransmitting the accumulated log", async () => {
    const f = await setup(); await f.send("STREAM_IO"); await waitFor(() => f.ended() === 1);
    const expected = Array.from({ length: 100 }, (_, i) => String(i).padStart(4, "0") + "x".repeat(1020)).join("");
    expect(f.view().items.find((item) => item.id === "stream-output")).toMatchObject({ kind: "tool", output: expected, status: "completed" });
    const events = f.events.filter((event) => "toolCallId" in event.update && event.update.toolCallId === "stream-output");
    expect(events.some((event) => "appendOutput" in event.update)).toBe(true);
    expect(events.filter((event) => "replaceOutput" in event.update)).toHaveLength(1);
    expect(events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0)).toBeLessThan(Buffer.byteLength(expected) * 1.5);
  });

  it("decodes split UTF-8 and keeps notices ephemeral", async () => {
    const f = await setup(); await f.send("UTF8"); await waitFor(() => f.ended() === 1);
    expect(f.view().items.find((item) => item.id === "utf8")).toMatchObject({ text: "中文" });
    await f.send("EVENTS"); await waitFor(() => f.ended() === 2);
    expect(f.notices).toEqual([{ severity: "warning", title: "临时提示" }]);
    expect(f.events.some((event) => event.update.sessionUpdate === "ls_notice" && event.update.title === "临时提示")).toBe(false);
    expect(f.view().usage).toMatchObject({ usedTokens: 50, contextWindow: 1000, cost: { amount: 0.1, currency: "USD" }, tokens: { totalTokens: 20 } });
  });

  it("clears cancelled approvals and rejects invalid form answers without losing the pending request", async () => {
    const f = await setup(); await f.send("CANCEL_PERMISSION"); await waitFor(() => f.ended() === 1);
    expect(f.view().permissions).toHaveLength(0);
    expect(f.events.some((event) => event.update.sessionUpdate === "ls_permission_resolved")).toBe(true);
    await f.send("FORM"); await waitFor(() => f.view().permissions.length === 1);
    const requestId = f.view().permissions[0]!.requestId;
    await expect(f.client.call("sessions.answer", { sessionId: f.session.id, requestId, answers: [{ id: "count", values: ["1.5"] }] })).rejects.toThrow("整数");
    expect(f.view().permissions).toHaveLength(1);
    await f.client.call("sessions.answer", { sessionId: f.session.id, requestId, answers: [{ id: "count", values: ["3"] }] });
    await waitFor(() => f.ended() === 2);
  });

  it("routes request-scoped forms and URLs during login without a session", async () => {
    const f = await setup();
    const login = f.client.call("agents.authenticate", { agent: "fixture", methodId: "form" });
    await waitFor(() => f.interactions.length === 1);
    const pending = (await f.client.call("agents.acp", { agent: "fixture" })).interactions;
    expect(pending).toHaveLength(1);
    await expect(f.client.call("agents.respond", { agent: "fixture", requestId: pending[0]!.requestId, answers: [{ id: "code", values: ["x"] }] })).rejects.toThrow();
    await f.client.call("agents.respond", { agent: "fixture", requestId: pending[0]!.requestId, answers: [{ id: "code", values: ["1234"] }] });
    await login;
    const url = f.client.call("agents.authenticate", { agent: "fixture", methodId: "url" });
    await waitFor(() => f.interactions.length === 2);
    expect(f.interactions[1]?.url).toEqual({ url: "https://example.com/authorize", elicitationId: "login" });
    await f.client.call("agents.respond", { agent: "fixture", requestId: f.interactions[1]!.requestId, optionId: "accept" });
    await url;
    expect((await f.client.call("agents.acp", { agent: "fixture" })).interactions).toHaveLength(0);
  });

  it("protects required providers and applies a supported provider configuration", async () => {
    const f = await setup();
    await expect(f.client.call("agents.providers", { agent: "fixture", operation: "disable", config: { providerId: "main" } })).rejects.toThrow("必需");
    const result = await f.client.call("agents.providers", { agent: "fixture", operation: "set", config: { providerId: "other", apiType: "openai", baseUrl: "https://example.com/v1", headers: { Authorization: "test-only" } } });
    expect(result.providers[1]?.current).toEqual({ apiType: "openai", baseUrl: "https://example.com/v1" });
    expect(JSON.stringify(result)).not.toContain("test-only");
  });

  it("keeps a child's approval after the parent turn ends and cancels only the selected child", async () => {
    const f = await setup(); await f.send("CHILD"); await waitFor(() => f.ended() === 1 && f.view().permissions.length === 1);
    const { subagents } = await f.client.call("sessions.subagents", { sessionId: f.session.id });
    expect(subagents[0]).toMatchObject({ nativeSessionId: "child-1", canCancel: true, state: "running" });
    const permission = f.view().permissions[0]!;
    expect(permission.childSessionId).toBe("child-1");
    await f.client.call("sessions.cancelSubagent", { sessionId: f.session.id, nativeSessionId: "child-1" });
    await waitFor(() => readFileSync(f.log, "utf8").includes('"method":"session/cancel"'));
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((entry) => entry.method === "session/cancel").map((entry) => entry.params.sessionId)).toEqual(["child-1"]);
    await f.client.call("sessions.permission", { sessionId: f.session.id, requestId: permission.requestId, optionId: "allow" });
    await waitFor(() => f.view().permissions.length === 0);
    const nested = f.view().items.find((item) => item.kind === "tool" && item.detail?.type === "subagent");
    expect(nested?.kind === "tool" && nested.sub?.items.some((item) => item.kind === "agent" && item.text === "子代理输出")).toBe(true);
  });
});

describe("ACP 2 asynchronous prompt lifecycle", () => {
  it("waits for idle after acknowledgement, applies message upserts, and runs queued work", async () => {
    const f = await setup(2); await f.send("one");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.ended()).toBe(0);
    expect(await f.send("two")).toEqual({ delivery: "queued" });
    await waitFor(() => f.ended() === 2);
    const view = f.view();
    expect(view.items.filter((item) => item.kind === "user")).toHaveLength(2);
    expect(view.items.filter((item) => item.kind === "agent").map((item) => item.text)).toEqual(["replaced one", "replaced two"]);
    expect(f.host.hub.getSession(f.session.id).state).toBe("idle");
  });

  it("handles idle before the prompt response without remaining stuck", async () => {
    const f = await setup(2); await f.send("FAST"); await waitFor(() => f.ended() === 1);
    expect(f.view().items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(f.view().state).toBe("idle");
  });
});
