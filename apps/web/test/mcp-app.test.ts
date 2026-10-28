import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppBridge, appCsp, appDocument, appResourceMeta, isAppPage } from "../src/live/mcp-app";

describe("an MCP App's page", () => {
  it("is accepted only in the MIME types Codex renders", () => {
    expect(isAppPage("text/html;profile=mcp-app")).toBe(true);
    expect(isAppPage("text/html; profile=mcp-app")).toBe(true);
    expect(isAppPage("text/html+skybridge")).toBe(true);
    expect(isAppPage("text/html")).toBe(true);
    expect(isAppPage("application/json")).toBe(false);
    expect(isAppPage(undefined)).toBe(false);
  });

  it("reads its display modes and CSP from the resource's _meta", () => {
    const meta = { "openai/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" }, ui: { csp: { connectDomains: ["https://api.example.com"] } } };
    expect(appResourceMeta(meta)).toEqual({ csp: { connectDomains: ["https://api.example.com"] }, displayModes: ["fullscreen"], preferred: "fullscreen" });
    expect(appResourceMeta(undefined)).toEqual({ csp: {}, displayModes: [], preferred: undefined });
  });

  it("may only reach the origins it declared, and only https / wss ones", () => {
    const policy = appCsp({
      connectDomains: ["https://api.example.com", "wss://live.example.com:8443", "http://insecure.example.com", "*", "javascript:alert(1)", "https://*.figma.com"],
      resourceDomains: ["https://cdn.example.com/"],
    });
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src https://api.example.com wss://live.example.com:8443 https://*.figma.com");
    expect(policy).not.toContain("insecure");
    expect(policy).not.toMatch(/connect-src[^;]*\*(?!\.)/);
    expect(policy).toContain("img-src data: blob: https://cdn.example.com");
    expect(policy).toContain("frame-src 'none'");
    expect(appCsp({})).toContain("connect-src 'none'");
  });

  it("gets the policy first in its head, whatever its document looks like", () => {
    expect(appDocument("<!doctype html><html lang=\"zh\"><head><title>x</title></head><body></body></html>", "default-src 'none'"))
      .toBe("<!doctype html><html lang=\"zh\"><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><title>x</title></head><body></body></html>");
    expect(appDocument("<html><body>x</body></html>", "a")).toBe("<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"a\"></head><body>x</body></html>");
    expect(appDocument("<p>x</p>", "a\"b")).toContain("content=\"a&quot;b\"");
  });
});

describe("the bridge to an app's frame", () => {
  // No DOM here: a window to listen on and a frame whose window records what it is sent.
  const host = new EventTarget();
  beforeAll(() => vi.stubGlobal("window", host));
  afterAll(() => vi.unstubAllGlobals());

  function frameWithBridge(overrides: Partial<ConstructorParameters<typeof AppBridge>[1]> = {}) {
    const sent: unknown[] = [];
    const page = { postMessage: (message: unknown) => void sent.push(message) };
    const frame = { contentWindow: page } as unknown as HTMLIFrameElement;
    const handlers = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] })),
      readResource: vi.fn(async (uri: string) => ({ contents: [{ uri, text: "<p>x</p>" }] })),
      openLink: vi.fn(),
      ready: vi.fn(),
      ...overrides,
    };
    const bridge = new AppBridge(frame, handlers, { theme: "dark", displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], platform: "desktop", locale: "zh-CN" }, { name: "LinkShell", version: "1" });
    const fromPage = (data: unknown, source: unknown = page) => {
      const event = new MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: source });
      host.dispatchEvent(event);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { frame, bridge, sent, handlers, fromPage, settle };
  }

  it("answers ui/initialize with what this host offers and the context", async () => {
    const { sent, fromPage, settle, bridge } = frameWithBridge();
    fromPage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "StupidMirror" } } });
    await settle();
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "LinkShell" },
        hostCapabilities: { serverTools: {}, openLinks: {} },
        hostContext: { theme: "dark", displayMode: "fullscreen", platform: "desktop" },
      },
    });
    expect((sent[0] as { result: { hostCapabilities: Record<string, unknown> } }).result.hostCapabilities.message).toBeUndefined();
    bridge.dispose();
  });

  it("tells the page about its call only once it says it is ready", async () => {
    const { sent, fromPage, settle, bridge, handlers } = frameWithBridge();
    bridge.notify("ui/notifications/tool-result", { content: [] });
    expect(sent).toHaveLength(0);
    fromPage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await settle();
    expect(handlers.ready).toHaveBeenCalledOnce();
    bridge.notify("ui/notifications/tool-result", { content: [] });
    expect(sent).toEqual([{ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [] } }]);
    bridge.dispose();
  });

  it("passes the page's tool calls on and answers them by id", async () => {
    const { sent, fromPage, settle, bridge, handlers } = frameWithBridge();
    fromPage({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "screen_frame", arguments: { device: 1 } } });
    await settle();
    expect(handlers.callTool).toHaveBeenCalledWith("screen_frame", { device: 1 });
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: "a", result: { content: [{ type: "text", text: "screen_frame:{\"device\":1}" }] } });
    bridge.dispose();
  });

  it("returns a failed call as a JSON-RPC error, not a crash", async () => {
    const { sent, fromPage, settle, bridge } = frameWithBridge({ callTool: vi.fn(async () => { throw new Error("工具不在这个服务上"); }) });
    fromPage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "elsewhere" } });
    await settle();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "工具不在这个服务上" } });
    bridge.dispose();
  });

  it("refuses what it doesn't know, and keeps the app in the panel", async () => {
    const { sent, fromPage, settle, bridge } = frameWithBridge();
    fromPage({ jsonrpc: "2.0", id: 3, method: "ui/request-display-mode", params: { mode: "inline" } });
    fromPage({ jsonrpc: "2.0", id: 4, method: "sampling/createMessage", params: {} });
    await settle();
    expect(sent).toContainEqual({ jsonrpc: "2.0", id: 3, result: { mode: "fullscreen" } });
    expect(sent).toContainEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "不支持的请求：sampling/createMessage" } });
    bridge.dispose();
  });

  it("ignores messages from anything but its own frame", async () => {
    const { sent, fromPage, settle, bridge, handlers } = frameWithBridge();
    fromPage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x" } }, {});
    fromPage({ id: 6, method: "tools/call", params: { name: "x" } });
    await settle();
    expect(handlers.callTool).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    bridge.dispose();
  });

  it("offers messages only when the conversation can take them", async () => {
    const message = vi.fn(async () => {});
    const { sent, fromPage, settle, bridge } = frameWithBridge({ message });
    fromPage({ jsonrpc: "2.0", id: 7, method: "ui/initialize", params: {} });
    fromPage({ jsonrpc: "2.0", id: 8, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "看这里" }] } });
    await settle();
    expect((sent[0] as { result: { hostCapabilities: Record<string, unknown> } }).result.hostCapabilities.message).toEqual({ text: {}, image: {} });
    expect(message).toHaveBeenCalledWith([{ type: "text", text: "看这里" }]);
    bridge.dispose();
  });
});
