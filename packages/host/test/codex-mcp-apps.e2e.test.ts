import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcError, RpcPeer, type SessionEvent } from "@linkshell/wire";
import { connectHost } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

const SCREEN = "ui://mirror/screen.html";
const SERVERS = [
  {
    name: "mirror", pluginId: "mirror@local", serverInfo: { name: "mirror", title: "Mirror Automation" }, authStatus: "unsupported",
    tools: {
      show_screen: { name: "show_screen", title: "Show screen", description: "Shows the phone.", _meta: { "openai/ui": { entrypoints: [{ type: "thread" }] }, ui: { resourceUri: SCREEN } } },
      screen_frame: { name: "screen_frame", _meta: { ui: { visibility: ["app"] } } },
      for_the_model: { name: "for_the_model", _meta: { ui: { visibility: ["model"] } } },
      upload: { name: "upload", _meta: { "openai/fileParams": ["file"] } },
      site: { name: "site", _meta: { ui: { resourceUri: "internal://site-creator" } } },
    },
  },
  {
    name: "codex_apps", pluginId: null, authStatus: "bearerToken",
    tools: {
      "figma.open_in_thread": {
        name: "figma.open_in_thread", title: "Figma",
        _meta: { ui: { visibility: ["model", "app"], resourceUri: "ui://figma/codex.html" }, "openai/ui": { entrypoints: [{ type: "thread" }], preferredModelDisplayMode: "fullscreen" }, connector_id: "c_figma", connector_name: "Figma" },
      },
      "figma.get_context": { name: "figma.get_context", _meta: { connector_id: "c_figma" } },
      "github.get_pr": { name: "github.get_pr", _meta: { connector_id: "c_github", connector_name: "GitHub" } },
    },
  },
  { name: "node_repl", pluginId: null, authStatus: "unsupported", tools: { js: { name: "js" } } },
];

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Plays Codex's own side: a raw client on the app-server, for the fake's test methods. */
async function rawCodexClient(socketPath: string) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const peer = new RpcPeer({ send: (text) => socket.send(text) });
  socket.on("message", (data) => peer.receive(data.toString()));
  await peer.request("initialize", { clientInfo: { name: "test", title: null, version: "0" }, capabilities: null });
  return { peer, close: () => socket.close() };
}

const toolCall = (id: string, tool: string, extra: Record<string, unknown> = {}) => ({
  type: "mcpToolCall", id, server: "mirror", tool, status: "inProgress", arguments: {}, appContext: null, mcpAppUi: null,
  pluginId: "mirror@local", result: null, error: null, durationMs: null, ...extra,
});

let home: string;
let host: RunningHost;
let client: Awaited<ReturnType<typeof connectHost>>;
let codex: Awaited<ReturnType<typeof rawCodexClient>>;
const events: SessionEvent[] = [];

async function appCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof RpcError ? error.appCode : String(error);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lsh-mcp-"));
  chmodSync(FAKE_CODEX, 0o755);
  host = await startHost({
    home,
    version: "test",
    drivers: (paths) => [
      new CodexDriver({
        socketPath: paths.codexSocket,
        command: FAKE_CODEX,
        env: { ...process.env, FAKE_CODEX_MCP: JSON.stringify(SERVERS) },
        hostVersion: "test",
        sharedSocketPath: false,
        desktopBusPath: false,
      }),
    ],
    log: () => {},
  });
  client = await connectHost(host.paths.hostSocket);
  client.on("session.event", (event) => events.push(event));
  codex = await rawCodexClient(host.paths.codexSocket);
});

afterAll(async () => {
  codex?.close();
  client?.close();
  await host?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("MCP Apps in a Codex session (fake app-server)", () => {
  let sessionId: string;
  let nativeId: string;
  const toolEvents = (toolCallId: string) =>
    events.filter((event) => event.sessionId === sessionId && (event.update.sessionUpdate === "tool_call" || event.update.sessionUpdate === "tool_call_update") && event.update.toolCallId === toolCallId);
  const detailOf = (event: SessionEvent) => (event.update.sessionUpdate === "tool_call" || event.update.sessionUpdate === "tool_call_update" ? event.update.detail : undefined);

  it("gives a call its page from the tool list when the call doesn't name it", async () => {
    const { session } = await client.call("sessions.create", { agent: "codex", cwd: home });
    sessionId = session.id;
    nativeId = session.nativeId;
    await client.call("sessions.subscribe", { sessionId, fromSeq: 0 });
    // Nothing has listed the tools yet: the call's card goes out first, its page when the list is in.
    await codex.peer.request("test/mcpToolCall", {
      threadId: nativeId,
      started: toolCall("call-1", "show_screen"),
      completed: toolCall("call-1", "show_screen", { status: "completed", result: { content: [{ type: "text", text: "showing" }], structuredContent: { device: "iPhone" }, _meta: null } }),
    });
    const withPage = await waitFor(() => toolEvents("call-1").find((event) => detailOf(event)?.type === "mcp" && "app" in detailOf(event)!));
    expect(detailOf(withPage)).toEqual({ type: "mcp", server: "mirror", tool: "show_screen", app: { resourceUri: SCREEN } });
    const finished = await waitFor(() => toolEvents("call-1").find((event) => event.update.sessionUpdate === "tool_call_update" && event.update.status === "completed"));
    expect(finished.update).toMatchObject({ rawOutput: { content: [{ type: "text", text: "showing" }], structuredContent: { device: "iPhone" } } });
  });

  it("names the page on the card itself once the tool is known, and none for a non-ui:// one", async () => {
    await codex.peer.request("test/mcpToolCall", {
      threadId: nativeId,
      started: toolCall("call-2", "show_screen", { mcpAppUi: { resourceUri: SCREEN, preferredModelDisplayMode: "fullscreen" } }),
      completed: toolCall("call-2", "show_screen", { status: "completed", result: { content: [], structuredContent: null, _meta: null } }),
    });
    await codex.peer.request("test/mcpToolCall", { threadId: nativeId, started: toolCall("call-3", "site"), completed: toolCall("call-3", "site", { status: "completed" }) });
    const card = await waitFor(() => toolEvents("call-2").find((event) => event.update.sessionUpdate === "tool_call"));
    expect(detailOf(card)).toEqual({ type: "mcp", server: "mirror", tool: "show_screen", app: { resourceUri: SCREEN, displayMode: "fullscreen" } });
    await waitFor(() => toolEvents("call-3").length >= 2);
    expect(toolEvents("call-3").some((event) => detailOf(event) && "app" in detailOf(event)!)).toBe(false);
  });

  it("lists the thread's apps", async () => {
    const { apps } = await client.call("mcp.apps", { sessionId });
    expect(apps).toEqual([
      { server: "mirror", tool: "show_screen", title: "Mirror", description: "Shows the phone.", resourceUri: SCREEN, entrypoints: ["thread"] },
      { server: "codex_apps", tool: "figma.open_in_thread", title: "Figma", resourceUri: "ui://figma/codex.html", entrypoints: ["thread"], visibility: ["model", "app"], displayMode: "fullscreen", connector: "c_figma" },
    ]);
  });

  it("reads a page in the session's thread, and only ui:// ones", async () => {
    const page = await client.call("mcp.resource", { sessionId, server: "mirror", uri: SCREEN });
    expect(page).toEqual({ mimeType: "text/html;profile=mcp-app", text: `<p>mirror ${nativeId} no connector</p>`, meta: { ui: { prefersBorder: false } } });
    const figma = await client.call("mcp.resource", { sessionId, server: "codex_apps", uri: "ui://figma/codex.html", connector: "c_figma" });
    expect(figma.text).toBe(`<p>codex_apps ${nativeId} c_figma</p>`);
    expect(await appCodeOf(client.call("mcp.resource", { sessionId, server: "mirror", uri: "https://example.com/" }))).toBe("invalid_params");
    // Codex's own refusal, in words the client can show.
    await expect(client.call("mcp.resource", { sessionId, server: "mirror", uri: "ui://mirror/missing.html" })).rejects.toMatchObject({ message: expect.stringContaining("Codex 没能读取插件页面") });
  });

  it("calls a page's own tools in the session's thread", async () => {
    const result = await client.call("mcp.call", { sessionId, server: "mirror", tool: "screen_frame", arguments: { size: 2 } });
    expect(result).toEqual({ content: [{ type: "text", text: "called screen_frame" }], structuredContent: { echo: { size: 2 } }, isError: false });
    // A connector's page names its tools without the connector's namespace.
    await client.call("mcp.call", { sessionId, server: "codex_apps", tool: "get_context", connector: "c_figma" });
    const { calls } = await codex.peer.request<{ calls: { threadId: string; server: string; tool: string; arguments?: unknown }[] }>("test/mcpCalls", {});
    expect(calls).toEqual([
      { threadId: nativeId, server: "mirror", tool: "screen_frame", arguments: { size: 2 } },
      { threadId: nativeId, server: "codex_apps", tool: "figma.get_context" },
    ]);
  });

  it("refuses what a page may not call", async () => {
    const refused = async (params: { server: string; tool: string; connector?: string }) => appCodeOf(client.call("mcp.call", { sessionId, ...params }));
    expect(await refused({ server: "codex_apps", tool: "github.get_pr", connector: "c_figma" })).toBe("forbidden");
    expect(await refused({ server: "codex_apps", tool: "get_pr", connector: "c_figma" })).toBe("not_found");
    expect(await refused({ server: "codex_apps", tool: "figma.get_context" })).toBe("invalid_params");
    expect(await refused({ server: "mirror", tool: "upload" })).toBe("forbidden");
    expect(await refused({ server: "mirror", tool: "for_the_model" })).toBe("forbidden");
    expect(await refused({ server: "node_repl", tool: "js" })).toBe("forbidden");
    expect(await refused({ server: "mirror", tool: "js" })).toBe("not_found");
    const { calls } = await codex.peer.request<{ calls: unknown[] }>("test/mcpCalls", {});
    expect(calls).toHaveLength(2);
  });

  it("finds a tool installed since the list was read, reading it once more", async () => {
    const { lists } = await codex.peer.request<{ lists: number }>("test/mcpLists", {});
    const tools = { ...SERVERS[0]!.tools, show_more: { name: "show_more", _meta: { ui: { resourceUri: "ui://mirror/more.html", visibility: ["app"] } } } };
    await codex.peer.request("test/setMcp", { data: [{ ...SERVERS[0], tools }, ...SERVERS.slice(1)] });
    await client.call("mcp.call", { sessionId, server: "mirror", tool: "show_more" });
    expect((await codex.peer.request<{ lists: number }>("test/mcpLists", {})).lists).toBe(lists + 1);
  });
});
