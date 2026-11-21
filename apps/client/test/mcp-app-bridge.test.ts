import { describe, expect, it, vi } from "vitest";
import {
  appCsp,
  appDocument,
  appResourceMeta,
  decodeBase64Utf8,
  isAppPage,
  isMcpAppsCapable,
  isSafeExternalUrl,
  MCP_APP_PROTOCOL,
  McpAppBridgeController,
  mcpAppTabId,
  mcpContentBlocks,
  parseMcpBridgeEnvelope,
} from "../src/lib/mcp-app";

describe("MCP App sandbox, CSP, and JSON-RPC bridge", () => {
  it("recognizes MCP App capability and valid HTML MIME types", () => {
    expect(isMcpAppsCapable(true, "claude")).toBe(true);
    expect(isMcpAppsCapable(false, "codex")).toBe(false);
    expect(isMcpAppsCapable(undefined, "codex")).toBe(true);
    expect(isMcpAppsCapable(undefined, "claude")).toBe(false);

    expect(isAppPage("text/html; profile=mcp-app")).toBe(true);
    expect(isAppPage("text/html+skybridge")).toBe(true);
    expect(isAppPage("text/html")).toBe(true);
    expect(isAppPage("application/json")).toBe(false);
    expect(mcpAppTabId("weather", "ui://forecast")).toBe("weather::ui://forecast");
  });

  it("enforces strict CSP allowing only safe https/wss origins and wraps document with bridge shim", () => {
    const meta = appResourceMeta({
      ui: {
        csp: {
          connectDomains: ["https://api.example.com", "http://insecure.example.com", "javascript:alert(1)"],
          resourceDomains: ["https://cdn.example.com/", "file:///etc/passwd"],
          frameDomains: ["wss://rt.example.com:8443"],
        },
      },
      "openai/ui": {
        availableDisplayModes: ["inline", "fullscreen"],
        preferredDisplayMode: "fullscreen",
      },
    });
    expect(meta.preferred).toBe("fullscreen");
    const csp = appCsp(meta.csp);
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).not.toContain("insecure.example.com");
    expect(csp).not.toContain("file:///");
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.example.com");
    expect(csp).toContain("frame-src wss://rt.example.com:8443");

    const doc = appDocument("<html><head><title>App</title></head><body>Hi</body></html>", csp);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("__linkshellMcpBridgeInit");
    expect(doc).toContain("__linkshellMcpDeliver");
  });

  it("validates external URL schemes and parses WebView envelopes safely", () => {
    expect(isSafeExternalUrl("https://example.com/docs")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3000")).toBe(true);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("linkshell:///session/1")).toBe(false);

    expect(parseMcpBridgeEnvelope("not json")).toBeUndefined();
    expect(parseMcpBridgeEnvelope(JSON.stringify({ jsonrpc: "1.0", method: "ping" }))).toBeUndefined();
    expect(
      parseMcpBridgeEnvelope(
        JSON.stringify({
          __linkshellMcp: true,
          payload: { jsonrpc: "2.0", id: 1, method: "ping" },
        }),
      ),
    ).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(decodeBase64Utf8(Buffer.from("你好 MCP", "utf8").toString("base64"))).toBe("你好 MCP");
    expect(mcpContentBlocks([{ type: "text", text: "hi" }, { type: "image" }])).toEqual([
      { type: "text", text: "hi" },
      { type: "other" },
    ]);
  });

  it("handles SEP-1865 JSON-RPC requests, notifications, errors, and teardown", async () => {
    const scripts: string[] = [];
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "sunny" }] }));
    const readResource = vi.fn(async () => ({ mimeType: "text/plain", text: "ok" }));
    const openLink = vi.fn();
    const message = vi.fn(async () => {});
    const onSizeChanged = vi.fn();
    const ready = vi.fn();

    const bridge = new McpAppBridgeController(
      (script) => scripts.push(script),
      { callTool, readResource, openLink, message, onSizeChanged, ready },
      {
        theme: "dark",
        displayMode: "fullscreen",
        availableDisplayModes: ["fullscreen"],
        platform: "mobile",
        locale: "zh",
        containerDimensions: { width: 390, height: 800 },
      },
    );

    const lastDelivered = () => {
      const script = scripts[scripts.length - 1]!;
      const match = /__linkshellMcpDeliver\((.+)\); true;$/.exec(script);
      return JSON.parse(match![1]!) as {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: unknown;
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
    };

    await bridge.receive(
      JSON.stringify({
        __linkshellMcp: true,
        payload: { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} },
      }),
    );
    expect(lastDelivered()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: MCP_APP_PROTOCOL,
        hostContext: { theme: "dark", platform: "mobile" },
      },
    });

    await bridge.receive(JSON.stringify({ jsonrpc: "2.0", method: "ui/notifications/initialized" }));
    expect(bridge.ready).toBe(true);
    expect(ready).toHaveBeenCalledOnce();

    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "forecast", arguments: { city: "Shanghai" } },
      }),
    );
    expect(callTool).toHaveBeenCalledWith("forecast", { city: "Shanghai" });
    expect(lastDelivered().result).toEqual({ content: [{ type: "text", text: "sunny" }] });

    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "ui://data" },
      }),
    );
    expect(readResource).toHaveBeenCalledWith("ui://data");
    expect(lastDelivered().result).toEqual({ mimeType: "text/plain", text: "ok" });

    // Allowed external link vs rejected javascript link
    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    );
    expect(openLink).toHaveBeenCalledWith("https://example.com");

    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "ui/open-link",
        params: { url: "javascript:alert(1)" },
      }),
    );
    expect(lastDelivered().error?.code).toBe(-32602);

    // Size notification & theme context change
    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: 390, height: 480 },
      }),
    );
    expect(onSizeChanged).toHaveBeenCalledWith({ width: 390, height: 480 });

    bridge.setContext({ theme: "light" });
    expect(lastDelivered()).toMatchObject({
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });

    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "ui/message",
        params: { content: [{ type: "text", text: "Apply settings" }] },
      }),
    );
    expect(message).toHaveBeenCalledWith([{ type: "text", text: "Apply settings" }]);

    await bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unknown/method" }));
    expect(lastDelivered().error?.code).toBe(-32601);

    bridge.dispose();
  });
});
