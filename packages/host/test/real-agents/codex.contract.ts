import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import { ABANDON, RpcPeer } from "@linkshell/wire";
import { completed, content, harness, until } from "./support.js";

let run: Awaited<ReturnType<typeof harness>> | undefined;
let desktopSocket: WebSocket | undefined;
afterEach(async () => { desktopSocket?.close(); await run?.close(); run = undefined; desktopSocket = undefined; });

it("codex-multi-client: native events, cross-client approval and reconnect", async () => {
  let finish!: () => void;
  const streamed = new Promise<void>((resolve) => { finish = resolve; });
  run = await harness("codex", ({ body }) => {
    const input = JSON.stringify(body.input);
    if (input.includes("LS_CODEX_TOOL") && !input.includes('"type":"function_call_output"')) {
      const tools = body.tools as { name?: string; type: string; tools?: { name: string }[] }[];
      const names = tools.flatMap((tool) => tool.name ? [tool.name] : tool.tools?.map((entry) => entry.name) ?? []);
      if (!names.includes("exec_command")) throw new Error(`exec_command missing: ${names.join(",")}`);
      return { tool: "exec_command", id: "call_contract", arguments: { cmd: "printf real-agent-ok > approved.txt", yield_time_ms: 1000 } };
    }
    return input.includes("LS_CODEX_TOOL") ? { text: "TOOL-OK" } : input.includes("LS_CODEX_DESKTOP") ? { text: "MULTICLIENT-OK", finish: streamed } : { text: "SEED-OK" };
  });
  const phone = await run.connect(), tablet = await run.connect();
  desktopSocket = new WebSocket(`ws+unix://${run.host.paths.codexSocket}:/`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => { desktopSocket!.once("open", resolve); desktopSocket!.once("error", reject); });
  const nativeEvents: string[] = [];
  const desktop = new RpcPeer({ send: (text) => desktopSocket!.send(text), onRequest: () => ABANDON, onNotification: (method) => nativeEvents.push(method) });
  desktopSocket.on("message", (data) => desktop.receive(data.toString()));
  await desktop.request("initialize", { clientInfo: { name: "linkshell-contract-desktop", title: null, version: "1" }, capabilities: null });
  desktop.notify("initialized", {});
  const { thread } = await desktop.request<{ thread: { id: string } }>("thread/start", { cwd: run.workspace, approvalPolicy: "untrusted", sandbox: "workspace-write" });
  const id = `codex:${thread.id}`;
  await desktop.request("turn/start", { threadId: thread.id, input: content("LS_CODEX_SEED") });
  await until(() => nativeEvents.includes("turn/completed"), "desktop seed persisted");
  await until(() => run!.host.hub.listSessions({}).sessions.some((session) => session.id === id), "desktop session discovery");
  for (const screen of [phone, tablet]) await screen.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
  const phoneTurns = completed(phone.events, id).length, tabletTurns = completed(tablet.events, id).length;
  await desktop.request("turn/start", { threadId: thread.id, input: content("LS_CODEX_DESKTOP") });
  await until(() => phone.text(id).includes("MULTICLIENT-OK") && tablet.text(id).includes("MULTICLIENT-OK"), "stream reaches both devices before completion");
  finish();
  await until(() => completed(phone.events, id).length === phoneTurns + 1 && completed(tablet.events, id).length === tabletTurns + 1, "desktop turn on both devices").catch((error) => {
    console.error({ updates: phone.events.map((event) => event.update), nativeEvents, errors: run!.api.errors, requests: run!.api.requests.length, logs: run!.logs.slice(-8) }); throw error;
  });
  expect(phone.text(id)).toContain("MULTICLIENT-OK"); expect(tablet.text(id)).toBe(phone.text(id));

  await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "tool", content: content("LS_CODEX_TOOL") });
  await until(() => tablet.events.some((event) => event.update.sessionUpdate === "ls_permission"), "real command approval", 30_000);
  const permission = tablet.events.find((event) => event.update.sessionUpdate === "ls_permission")!.update;
  if (permission.sessionUpdate !== "ls_permission") throw new Error("missing approval");
  expect(existsSync(`${run.workspace}/approved.txt`)).toBe(false);
  await tablet.client.call("sessions.permission", { sessionId: id, requestId: permission.requestId, optionId: permission.options.find((option) => option.kind === "allow_once")!.optionId });
  await until(() => completed(phone.events, id).length === phoneTurns + 2, "approved command completion", 30_000);
  expect(readFileSync(`${run.workspace}/approved.txt`, "utf8")).toBe("real-agent-ok");
  expect(phone.text(id)).toContain("TOOL-OK");
  expect(nativeEvents.filter((method) => method === "turn/completed")).toHaveLength(3);
  const cursor = tablet.events.at(-1)!.seq; tablet.client.close();
  const reconnected = await run.connect();
  await reconnected.client.call("sessions.subscribe", { sessionId: id, fromSeq: cursor });
  await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "reconnected", content: content("LS_CODEX_RECONNECTED") });
  await until(() => completed(reconnected.events, id).length === 1, "reconnected client receives a new turn");
  expect(reconnected.text(id)).toBe("TOOL-OK");
  expect(reconnected.events.every((event) => event.seq > cursor)).toBe(true);
  const launch = await phone.client.call("desktop.launch", { agent: "codex", sessionId: id, args: [] });
  expect(launch.args).toContain(`unix://${run.host.paths.codexSocket}`);
  expect(run.api.errors).toEqual([]);
});

it("codex-restart: native history survives host restart without duplicated messages", async () => {
  run = await harness("codex", () => ({ text: "PERSISTED-OK" }));
  const phone = await run.connect();
  const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: run.workspace });
  await phone.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
  await phone.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "first", content: content("LS_CODEX_PERSIST") });
  await until(() => completed(phone.events, session.id).length === 1, "first persisted turn");
  const before = phone.events.filter((event) => event.update.sessionUpdate === "agent_message_chunk").map((event) => event.seq);
  await run.restart();
  const restored = await run.connect();
  await restored.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
  expect(restored.events.filter((event) => event.update.sessionUpdate === "agent_message_chunk").map((event) => event.seq)).toEqual(before);
  await restored.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "second", content: content("LS_CODEX_AFTER_RESTART") });
  await until(() => completed(restored.events, session.id).length === 2, "turn after restart");
  const request = [...run.api.requests].reverse().find(({ body }) => JSON.stringify(body.input).includes("LS_CODEX_AFTER_RESTART"));
  expect(JSON.stringify(request?.body.input)).toContain("LS_CODEX_PERSIST");
  expect(run.api.errors).toEqual([]);
});
