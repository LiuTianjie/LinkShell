import { describe, expect, it } from "vitest";
import { RpcError, type SessionUpdate } from "@linkshell/wire";
import { itemToHistory, mapNotification, toolStart, type CodexThreadState, type McpToolDescriptor } from "../src/drivers/codex/mapper.js";
import { CodexMcpApps } from "../src/drivers/codex/mcp-apps.js";
import { mcpHandlers } from "../src/rpc/mcp.js";
import type { SessionHub } from "../src/hub.js";

const SCREEN = "ui://stupidmirror/phone-screen-1.html";
const SHOW_SCREEN: McpToolDescriptor = {
  name: "show_screen",
  title: "StupidMirror",
  _meta: { "openai/ui": { entrypoints: [{ type: "thread" }] }, ui: { resourceUri: SCREEN } },
};

/** An `mcpToolCall` item the way codex-cli 0.162 sends it. */
const call = (extra: Record<string, unknown> = {}) => ({
  type: "mcpToolCall", id: "call-1", server: "stupidmirror", tool: "show_screen", status: "inProgress",
  arguments: { device_id: "d" }, appContext: null, mcpAppUi: null, pluginId: "stupidmirror@local",
  result: null, error: null, durationMs: null, ...extra,
});

function mapper(lookup?: () => McpToolDescriptor | undefined) {
  const states = new Map<string, CodexThreadState>();
  const stateOf = (id: string) => states.get(id) ?? states.set(id, {}).get(id)!;
  return (method: string, params: unknown) => mapNotification(method, params, stateOf, lookup && (() => lookup)).map((mapped) => mapped.update);
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const detailOf = (update: SessionUpdate | undefined) =>
  update && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") ? update.detail : undefined;

describe("Codex MCP tool calls with pages", () => {
  it("takes the page Codex captured with the call", () => {
    const start = toolStart(call({ mcpAppUi: { resourceUri: SCREEN, preferredModelDisplayMode: "fullscreen" } }));
    expect(start?.detail).toEqual({ type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: SCREEN, displayMode: "fullscreen" } });
  });

  it("falls back to the tool's descriptor, and without one has no page", () => {
    expect(toolStart(call(), () => SHOW_SCREEN)?.detail).toEqual({ type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: SCREEN } });
    expect(toolStart(call())?.detail).toEqual({ type: "mcp", server: "stupidmirror", tool: "show_screen" });
  });

  it("reads the app context first, with its connector, and the display mode from the descriptor", () => {
    const figma: McpToolDescriptor = {
      name: "figma.open_figma_mcp_app_in_thread",
      _meta: {
        ui: { visibility: ["model", "app"], resourceUri: "ui://figma/codex.html" },
        "openai/ui": { entrypoints: [{ type: "thread" }], preferredModelDisplayMode: "fullscreen" },
        connector_id: "connector_figma",
      },
    };
    const item = call({
      server: "codex_apps", tool: "figma.open_figma_mcp_app_in_thread",
      appContext: { connectorId: "connector_figma", linkId: null, resourceUri: "ui://figma/from-context.html", appName: "Figma", actionName: null },
    });
    expect(toolStart(item, () => figma)?.detail).toMatchObject({ app: { resourceUri: "ui://figma/from-context.html", displayMode: "fullscreen", connector: "connector_figma" } });
  });

  it("counts only ui:// pages", () => {
    const internal: McpToolDescriptor = { name: "list_projects", _meta: { ui: { resourceUri: "internal://site-creator" }, "openai/outputTemplate": "internal://site-creator" } };
    expect(toolStart(call(), () => internal)?.detail).not.toHaveProperty("app");
    // A connector's resource path in the app context isn't a page: the descriptor's is.
    const item = call({ appContext: { connectorId: "c", linkId: null, resourceUri: "/connector_c/link/tool", appName: null, actionName: null } });
    expect(toolStart(item, () => SHOW_SCREEN)?.detail).toMatchObject({ app: { resourceUri: SCREEN, connector: "c" } });
    expect(toolStart(call({ mcpAppResourceUri: "https://example.com/page.html" }))?.detail).not.toHaveProperty("app");
    expect(toolStart(call({ mcpAppResourceUri: "ui://legacy/page.html" }))?.detail).toMatchObject({ app: { resourceUri: "ui://legacy/page.html" } });
  });

  it("finishes a call with the result's page and the raw result, pictures and oversized parts left out", () => {
    const map = mapper();
    const [started] = map("item/started", { threadId: "t", item: call() });
    expect(detailOf(started)).not.toHaveProperty("app");
    const picture = "A".repeat(20_000);
    const result = {
      content: [{ type: "text", text: "opened" }, { type: "image", data: picture, mimeType: "image/png" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { device: "d" },
      _meta: { "openai/outputTemplate": "ui://widget/screen.html" },
    };
    const [finished] = map("item/completed", { threadId: "t", item: call({ status: "completed", result }) });
    expect(finished).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
    expect(detailOf(finished)).toEqual({ type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: "ui://widget/screen.html" } });
    expect(finished!.sessionUpdate === "tool_call_update" && finished!.rawOutput).toEqual({
      content: [{ type: "text", text: "opened" }, { type: "image", mimeType: "image/png", omitted: true }, { type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { device: "d" },
      _meta: { "openai/outputTemplate": "ui://widget/screen.html" },
      truncated: true,
    });
    // The card's own content is what it was.
    expect(finished!.sessionUpdate === "tool_call_update" && finished!.content?.[0]).toEqual({ type: "content", content: { type: "text", text: "opened" } });
  });

  it("leaves out structured content above 256 KB and marks a failed result", () => {
    const map = mapper(() => SHOW_SCREEN);
    map("item/started", { threadId: "t", item: call() });
    const [finished] = map("item/completed", {
      threadId: "t",
      item: call({ status: "completed", result: { content: [], structuredContent: { frame: "x".repeat(300 * 1024) }, _meta: null, isError: true } }),
    });
    expect(finished!.sessionUpdate === "tool_call_update" && finished!.rawOutput).toEqual({ content: [], isError: true, truncated: true });
    expect(finished).toMatchObject({ status: "failed" });
    expect(detailOf(finished)).toMatchObject({ app: { resourceUri: SCREEN } });
  });

  it("fills history the same way", () => {
    const item = call({ status: "completed", result: { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null } });
    const history = itemToHistory(item, () => SHOW_SCREEN);
    expect(history?.updates.map(detailOf)).toEqual([
      { type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: SCREEN } },
      { type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: SCREEN } },
    ]);
    expect(history?.updates[1]).toMatchObject({ rawOutput: { content: [{ type: "text", text: "ok" }] } });
  });
});

/** A Codex app-server that answers the MCP methods from a list that can change. */
function fakeCodex(initial: unknown[]) {
  let data = initial;
  const requests: { method: string; params: Record<string, unknown>; threadId?: string }[] = [];
  const late: { threadId: string; toolCallId: string; detail: unknown }[] = [];
  const apps = new CodexMcpApps({
    request: async <T>(method: string, params: unknown, threadId?: string): Promise<T> => {
      requests.push({ method, params: params as Record<string, unknown>, threadId });
      if (method === "mcpServerStatus/list") return { data, nextCursor: null } as T;
      if (method === "plugin/installed") return { marketplaces: [{ plugins: [{ id: "stupidmirror@local", interface: { displayName: "StupidMirror" } }] }] } as T;
      if (method === "mcpServer/tool/call") return { content: [{ type: "text", text: "ok" }], isError: false } as T;
      throw new RpcError(-32601, `unknown method ${method}`);
    },
    reach: (threadId) => (threadId === "held" ? "held" : "joined"),
    lateDetail: (threadId, toolCallId, detail) => late.push({ threadId, toolCallId, detail }),
    log: () => {},
    refreshCooldownMs: 60,
  });
  const lists = () => requests.filter((request) => request.method === "mcpServerStatus/list").length;
  return { apps, requests, late, lists, set: (next: unknown[]) => { data = next; } };
}

const stupidmirror = (tools: Record<string, unknown>) => ({ name: "stupidmirror", pluginId: "stupidmirror@local", serverInfo: { title: "StupidMirror Device Automation" }, tools, authStatus: "unsupported" });
const codexApps = {
  name: "codex_apps",
  pluginId: null,
  tools: {
    "figma.open_figma_mcp_app_in_thread": {
      name: "figma.open_figma_mcp_app_in_thread", title: "Figma",
      _meta: { ui: { visibility: ["model", "app"], resourceUri: "ui://figma/codex.html" }, "openai/ui": { entrypoints: [{ type: "thread" }], preferredModelDisplayMode: "fullscreen" }, connector_id: "connector_figma", connector_name: "Figma" },
    },
    "figma.open_figma_mcp_app": {
      name: "figma.open_figma_mcp_app", title: "Figma",
      _meta: { ui: { visibility: ["app"], resourceUri: "ui://figma/codex.html" }, "openai/ui": { entrypoints: [{ type: "global" }] }, connector_id: "connector_figma", connector_name: "Figma" },
    },
    "figma.generate_deck": { name: "figma.generate_deck", _meta: { "openai/outputTemplate": "ui://widget/generate_deck.html", connector_id: "connector_figma" } },
    "github.get_pr": { name: "github.get_pr", _meta: { connector_id: "connector_github", connector_name: "GitHub" } },
  },
};

describe("Codex MCP Apps catalog", () => {
  it("reads the tool list for a call it doesn't know, and sends the page late", async () => {
    const codex = fakeCodex([stupidmirror({ show_screen: SHOW_SCREEN })]);
    const lookup = codex.apps.lookup("thread-1");
    expect(lookup(call())).toBeUndefined();
    const [late] = await waitFor(() => codex.late.length > 0 && codex.late);
    expect(late).toEqual({ threadId: "thread-1", toolCallId: "call-1", detail: { type: "mcp", server: "stupidmirror", tool: "show_screen", app: { resourceUri: SCREEN } } });
    expect(codex.requests[0]).toMatchObject({ method: "mcpServerStatus/list", params: { detail: "toolsAndAuthOnly" }, threadId: undefined });
    // Known now: no second read.
    expect(lookup(call({ id: "call-2" }))?._meta).toEqual(SHOW_SCREEN._meta);
    expect(codex.lists()).toBe(1);
  });

  it("reads the list again for a tool installed since, after a pause, and gives up on one that doesn't exist", async () => {
    const codex = fakeCodex([stupidmirror({ show_screen: SHOW_SCREEN })]);
    const lookup = codex.apps.lookup("t");
    lookup(call());
    await waitFor(() => codex.late.length === 1);
    codex.set([stupidmirror({ show_screen: SHOW_SCREEN, show_other: { name: "show_other", _meta: { ui: { resourceUri: "ui://stupidmirror/other.html" } } } })]);
    lookup(call({ id: "call-other", tool: "show_other" }));
    lookup(call({ id: "call-gone", tool: "uninstalled" }));
    expect(codex.lists()).toBe(1);
    await waitFor(() => codex.late.length === 2);
    expect(codex.lists()).toBe(2);
    expect(codex.late[1]).toMatchObject({ toolCallId: "call-other", detail: { app: { resourceUri: "ui://stupidmirror/other.html" } } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(codex.lists()).toBe(2);
    expect(codex.late).toHaveLength(2);
    // History mapped again (a thread read from disk) doesn't have the list read again for it.
    lookup(call({ id: "call-gone", tool: "uninstalled" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(codex.lists()).toBe(2);
  });

  it("doesn't look up a call that names its page itself", () => {
    const codex = fakeCodex([]);
    codex.apps.lookup("t")(call({ mcpAppUi: { resourceUri: SCREEN, preferredModelDisplayMode: "inline" } }));
    expect(codex.requests).toHaveLength(0);
  });

  it("finds a codex_apps tool by the name its connector's page gives it", async () => {
    const codex = fakeCodex([codexApps]);
    await codex.apps.apps("t");
    const lookup = codex.apps.lookup("t");
    const item = call({ server: "codex_apps", tool: "open_figma_mcp_app_in_thread", appContext: { connectorId: "connector_figma", linkId: null, resourceUri: null, appName: null, actionName: null } });
    expect(lookup(item)?.name).toBe("figma.open_figma_mcp_app_in_thread");
  });

  it("lists the apps Codex offers in a thread", async () => {
    const codex = fakeCodex([
      stupidmirror({ show_screen: SHOW_SCREEN, screen_frame: { name: "screen_frame", _meta: { ui: { visibility: ["app"] } } } }),
      codexApps,
      { name: "node_repl", tools: { js: { name: "js" } } },
    ]);
    expect(await codex.apps.apps("t")).toEqual([
      { server: "stupidmirror", tool: "show_screen", title: "StupidMirror", resourceUri: SCREEN, entrypoints: ["thread"] },
      {
        server: "codex_apps", tool: "figma.open_figma_mcp_app_in_thread", title: "Figma", resourceUri: "ui://figma/codex.html",
        entrypoints: ["thread"], visibility: ["model", "app"], displayMode: "fullscreen", connector: "connector_figma",
      },
    ]);
  });

  it("refuses tool calls in a thread another Codex holds", async () => {
    const codex = fakeCodex([stupidmirror({ show_screen: SHOW_SCREEN })]);
    await expect(codex.apps.call("held", { server: "stupidmirror", tool: "show_screen" })).rejects.toMatchObject({ appCode: "not_supported" });
    expect(codex.requests.some((request) => request.method === "mcpServer/tool/call")).toBe(false);
  });
});

describe("mcp.* handlers", () => {
  const hub = (agent: string, driver: unknown) => ({ sessionDriver: () => ({ session: { agent, nativeId: "native" }, driver }) }) as unknown as SessionHub;

  it("refuses a session whose agent has no MCP Apps", async () => {
    const handlers = mcpHandlers(hub("claude", { label: "Claude", status: () => ({ installed: true }) }));
    await expect(handlers["mcp.apps"]({ sessionId: "s" })).rejects.toMatchObject({ appCode: "not_supported", message: "插件页面（MCP App）只在 Codex 会话里可用" });
    expect(() => handlers["mcp.call"]({ sessionId: "s", server: "x", tool: "y" })).toThrow(RpcError);
  });

  it("refuses when Codex can't run", async () => {
    const mcpApps = { apps: async () => [], resource: async () => ({}), call: async () => ({ content: [] }) };
    const handlers = mcpHandlers(hub("codex", { label: "Codex", mcpApps, status: () => ({ installed: true, problem: "codex app-server exited" }) }));
    await expect(handlers["mcp.apps"]({ sessionId: "s" })).rejects.toMatchObject({ appCode: "agent_unavailable" });
  });
});
