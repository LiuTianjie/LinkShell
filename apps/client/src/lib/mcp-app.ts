import type { McpApp } from "@linkshell/wire";

export const MCP_APP_PROTOCOL = "2026-01-26";

export interface AppCsp {
  connectDomains?: unknown;
  resourceDomains?: unknown;
  frameDomains?: unknown;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether the session's agent/host supports MCP Apps (older hosts omit the flag; only Codex had them). */
export function isMcpAppsCapable(capable: boolean | undefined, sessionAgent: string | undefined): boolean {
  return capable ?? sessionAgent === "codex";
}

export function mcpAppTabId(server: string, resourceUri: string): string {
  return `${server}::${resourceUri}`;
}

export function mcpAppTitle(app: Pick<McpApp, "title" | "tool">): string {
  return app.title?.trim() || app.tool;
}

/** Allowed HTML MIME types for an MCP App resource page. */
export function isAppPage(mimeType: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase().replace(/\s+/g, "");
  return (
    type === "text/html;profile=mcp-app" ||
    type === "text/html+skybridge" ||
    type === "text/html"
  );
}

/** Restricts declared CSP origins strictly to safe https/wss host origins. */
function allowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const match =
      /^(https|wss):\/\/(\*\.)?((?:[a-z0-9-]+\.)+[a-z0-9-]+)(:\d{1,5})?\/?$/i.exec(
        entry.trim(),
      );
    return match
      ? [
          `${match[1]!.toLowerCase()}://${match[2] ?? ""}${match[3]!.toLowerCase()}${match[4] ?? ""}`,
        ]
      : [];
  });
}

export function appResourceMeta(meta: unknown): {
  csp: AppCsp;
  displayModes: string[];
  preferred?: string;
} {
  const root = asObject(meta) ?? {};
  const ui = asObject(root.ui) ?? {};
  const openai = asObject(root["openai/ui"]) ?? {};
  const modes = Array.isArray(openai.availableDisplayModes)
    ? openai.availableDisplayModes.filter((mode): mode is string => typeof mode === "string")
    : [];
  return {
    csp: (asObject(ui.csp) ?? {}) as AppCsp,
    displayModes: modes,
    preferred: typeof openai.preferredDisplayMode === "string" ? openai.preferredDisplayMode : undefined,
  };
}

export function appCsp(csp: AppCsp): string {
  const connect = allowedOrigins(csp.connectDomains);
  const resource = allowedOrigins(csp.resourceDomains);
  const frame = allowedOrigins(csp.frameDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${resource.join(" ")}`,
    `style-src 'unsafe-inline' ${resource.join(" ")}`,
    `img-src data: blob: ${resource.join(" ")}`,
    `font-src data: ${resource.join(" ")}`,
    `media-src data: blob: ${resource.join(" ")}`,
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    `frame-src ${frame.length ? frame.join(" ") : "'none'"}`,
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ]
    .map((rule) => rule.trim())
    .join("; ");
}

function injectIntoDocumentHead(html: string, injection: string): string {
  const len = html.length;
  let pos = 0;
  const skipPreamble = (allowDoctype: boolean) => {
    while (pos < len) {
      const ws = /^\s+/.exec(html.slice(pos));
      if (ws) { pos += ws[0].length; continue; }
      if (html.startsWith("<!--", pos)) {
        const end = html.indexOf("-->", pos + 4);
        pos = end >= 0 ? end + 3 : len;
        continue;
      }
      if (allowDoctype) {
        const dt = /^<!doctype\b[^>]*>/i.exec(html.slice(pos));
        if (dt) { pos += dt[0].length; continue; }
      }
      break;
    }
  };
  skipPreamble(true);
  const htmlTag = /^<html(?:\s[^>]*)?>/i.exec(html.slice(pos));
  if (htmlTag) {
    const afterHtml = pos + htmlTag[0].length;
    pos = afterHtml;
    skipPreamble(false);
    const headTag = /^<head(?:\s[^>]*)?>/i.exec(html.slice(pos));
    if (headTag) {
      const insertAt = pos + headTag[0].length;
      return `${html.slice(0, insertAt)}${injection}${html.slice(insertAt)}`;
    }
    return `${html.slice(0, afterHtml)}<head>${injection}</head>${html.slice(afterHtml)}`;
  }
  const headTag = /^<head(?:\s[^>]*)?>/i.exec(html.slice(pos));
  if (headTag) {
    const insertAt = pos + headTag[0].length;
    return `${html.slice(0, insertAt)}${injection}${html.slice(insertAt)}`;
  }
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}

/**
 * Wraps the MCP App HTML with its strict CSP `<meta>` and a zero-loop postMessage shim
 * routing SEP-1865 JSON-RPC calls over `window.ReactNativeWebView.postMessage`.
 */
export function appDocument(html: string, csp: string): string {
  const safeCsp = csp.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${safeCsp}">`;
  const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">`;
  const shim = `<script>(function(){if(window.__linkshellMcpBridgeInit)return;window.__linkshellMcpBridgeInit=true;var origPost=typeof window.postMessage==="function"?window.postMessage.bind(window):null;window.postMessage=function(msg,target,transfer){if(msg&&typeof msg==="object"&&msg.jsonrpc==="2.0"){if(window.ReactNativeWebView&&typeof window.ReactNativeWebView.postMessage==="function"){window.ReactNativeWebView.postMessage(JSON.stringify({__linkshellMcp:true,payload:msg}));}return;}if(origPost)return origPost(msg,target||"*",transfer);};window.__linkshellMcpDeliver=function(payload){try{var ev=new MessageEvent("message",{data:payload,origin:window.location&&window.location.origin?window.location.origin:""});window.dispatchEvent(ev);}catch(_){if(typeof window.onmessage==="function")window.onmessage({data:payload});}};})();</script>`;
  const injection = `${meta}${viewport}${shim}`;
  return injectIntoDocumentHead(html, injection);
}

export function decodeBase64Utf8(blob: string): string {
  const binary = atob(blob);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  return binary;
}

export function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function mcpContentBlocks(
  content: unknown,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "other" }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "other" }> = [];
  for (const item of content) {
    const record = asObject(item);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      out.push({ type: "text", text: record.text });
    } else if (
      record.type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      out.push({ type: "image", data: record.data, mimeType: record.mimeType });
    } else {
      out.push({ type: "other" });
    }
  }
  return out;
}

export interface AppHostContext {
  theme: "light" | "dark";
  displayMode: "fullscreen";
  availableDisplayModes: string[];
  platform: "mobile";
  locale: string;
  containerDimensions?: { width: number; height: number };
}

export interface AppSizeNotification {
  width?: number;
  height?: number;
}

export interface McpAppBridgeHandlers {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  openLink(url: string): void;
  message?(content: unknown[]): Promise<void>;
  onSizeChanged?(size: AppSizeNotification): void;
  ready(): void;
}

export interface McpJsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function parseMcpBridgeEnvelope(raw: string): McpJsonRpcMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const envelope = asObject(parsed);
  if (!envelope) return undefined;
  const candidate = envelope.__linkshellMcp === true ? asObject(envelope.payload) : envelope;
  if (!candidate || candidate.jsonrpc !== "2.0") return undefined;
  if (candidate.id !== undefined && typeof candidate.id !== "string" && typeof candidate.id !== "number") {
    return undefined;
  }
  return candidate as McpJsonRpcMessage;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

class BridgeError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * Pure SEP-1865 MCP App JSON-RPC host bridge for React Native `WebView`.
 */
export class McpAppBridgeController {
  private nextId = 1;
  private readonly waiting = new Map<string | number, (message: McpJsonRpcMessage) => void>();
  private initialized = false;
  private disposed = false;

  constructor(
    private readonly postScript: (script: string) => void,
    private readonly handlers: McpAppBridgeHandlers,
    private context: AppHostContext,
    private readonly hostInfo: { name: string; version: string } = {
      name: "LinkShell Mobile",
      version: "2.0.0",
    },
  ) {}

  get ready(): boolean {
    return this.initialized;
  }

  dispose(): void {
    this.disposed = true;
    for (const resolve of this.waiting.values()) {
      resolve({ error: { message: "closed" } });
    }
    this.waiting.clear();
  }

  private post(message: McpJsonRpcMessage): void {
    if (this.disposed) return;
    const full = { jsonrpc: "2.0", ...message };
    this.postScript(
      `window.__linkshellMcpDeliver && window.__linkshellMcpDeliver(${JSON.stringify(full)}); true;`,
    );
  }

  notify(method: string, params: unknown = {}): void {
    if (this.initialized) this.post({ method, params });
  }

  request(method: string, params: unknown = {}, timeout = 1500): Promise<McpJsonRpcMessage | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const id = `host-${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(undefined);
      }, timeout);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.post({ id, method, params });
    });
  }

  setContext(next: Partial<AppHostContext>): void {
    this.context = { ...this.context, ...next };
    this.notify("ui/notifications/host-context-changed", next);
  }

  async teardown(): Promise<void> {
    if (this.initialized && !this.disposed) {
      await this.request("ui/resource-teardown", {}, 500);
    }
  }

  async receive(rawData: string): Promise<void> {
    if (this.disposed) return;
    const message = parseMcpBridgeEnvelope(rawData);
    if (!message) return;

    if (message.method === undefined && message.id !== undefined) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }

    if (typeof message.method !== "string") return;
    const params = asObject(message.params) ?? {};
    if (message.id === undefined) {
      this.handleNotification(message.method, params);
      return;
    }

    await this.answer(message.id, message.method, params);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      this.handlers.ready();
      return;
    }
    if (method === "ui/notifications/size-changed") {
      const width = positiveFinite(params.width);
      const height = positiveFinite(params.height);
      if (width !== undefined || height !== undefined) {
        this.handlers.onSizeChanged?.({ width, height });
      }
    }
  }

  private async answer(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.handleRequest(method, params);
      this.post({ id, result });
    } catch (error) {
      const known = error instanceof BridgeError;
      this.post({
        id,
        error: {
          code: known ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "ui/initialize":
        return {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : MCP_APP_PROTOCOL,
          hostInfo: this.hostInfo,
          hostCapabilities: {
            serverTools: {},
            serverResources: {},
            openLinks: {},
            ...(this.handlers.message ? { message: { text: {}, image: {} } } : {}),
          },
          hostContext: this.context,
        };
      case "ping":
        return {};
      case "tools/call": {
        if (typeof params.name !== "string" || !params.name.trim()) {
          throw new BridgeError(-32602, "缺少工具名");
        }
        return this.handlers.callTool(params.name, asObject(params.arguments) ?? {});
      }
      case "resources/read": {
        if (typeof params.uri !== "string" || !params.uri.trim()) {
          throw new BridgeError(-32602, "缺少资源地址");
        }
        return this.handlers.readResource(params.uri);
      }
      case "ui/request-display-mode":
        return { mode: "fullscreen" };
      case "ui/open-link": {
        if (typeof params.url !== "string" || !isSafeExternalUrl(params.url)) {
          throw new BridgeError(-32602, "链接地址无效或不受支持");
        }
        this.handlers.openLink(params.url.trim());
        return {};
      }
      case "ui/message": {
        if (!this.handlers.message) {
          throw new BridgeError(-32601, "不支持发送消息");
        }
        await this.handlers.message(Array.isArray(params.content) ? params.content : []);
        return {};
      }
      case "ui/update-model-context":
        return {};
      default:
        throw new BridgeError(-32601, `不支持的请求：${method}`);
    }
  }
}
