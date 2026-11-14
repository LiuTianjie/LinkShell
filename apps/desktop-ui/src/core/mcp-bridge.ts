// Host-side MCP App bridge (SEP-1865 / `@modelcontextprotocol/ext-apps`, matching Codex Desktop):
// sandboxed `ui://…` iframe pages communicate over postMessage JSON-RPC (`ui/*`, `tools/call`, `resources/read`).

export const MCP_APP_PROTOCOL = "2026-01-26";

export interface AppCsp {
  connectDomains?: unknown;
  resourceDomains?: unknown;
  frameDomains?: unknown;
}

export interface AppTab {
  id: string;
  server: string;
  uri: string;
  title: string;
  toolName?: string;
  callId?: string;
  input?: Record<string, unknown>;
  result?: unknown;
}

export function appTabId(server: string, uri: string, callId?: string): string {
  return callId ? `${server}:${uri}:${callId}` : `${server}:${uri}`;
}

export function isAppPage(mimeType: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase().replace(/\s+/g, "");
  return (
    type === "text/html;profile=mcp-app" ||
    type === "text/html+skybridge" ||
    type === "text/html"
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeOrigins(value: unknown): string[] {
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
    preferred:
      typeof openai.preferredDisplayMode === "string"
        ? openai.preferredDisplayMode
        : undefined,
  };
}

export function appCsp(csp: AppCsp): string {
  const connect = sanitizeOrigins(csp.connectDomains);
  const resource = sanitizeOrigins(csp.resourceDomains);
  const frame = sanitizeOrigins(csp.frameDomains);
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

export function appDocument(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (root) => `${root}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export interface McpExtractedBlock {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  data?: string;
}

export function mcpContentBlocks(content: unknown[]): McpExtractedBlock[] {
  const out: McpExtractedBlock[] = [];
  for (const item of content) {
    const record = asObject(item);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      out.push({ type: "text", text: record.text });
    } else if (
      record.type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      out.push({ type: "image", data: record.data, mimeType: record.mimeType });
    }
  }
  return out;
}

export interface AppHostContext {
  theme: "light" | "dark";
  displayMode: "fullscreen";
  availableDisplayModes: string[];
  platform: "desktop";
  locale: string;
  containerDimensions?: { width: number; height: number };
}

export interface AppBridgeHandlers {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  openLink(url: string): void;
  message?(content: unknown[]): Promise<void>;
  ready(): void;
}

interface JsonRpcFrameMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class BridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class AppBridge {
  private nextId = 1;
  private readonly waiting = new Map<string | number, (message: JsonRpcFrameMessage) => void>();
  private initialized = false;

  private readonly listener = (event: MessageEvent) => {
    if (event.source !== this.frame.contentWindow) return;
    const message = asObject(event.data) as JsonRpcFrameMessage | undefined;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id === undefined) {
      this.notified(message.method);
      return;
    }
    void this.answer(message.id, message.method, asObject(message.params) ?? {});
  };

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly handlers: AppBridgeHandlers,
    private context: AppHostContext,
    private readonly hostInfo: { name: string; version: string },
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.listener);
    }
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("message", this.listener);
    }
    for (const resolve of this.waiting.values()) {
      resolve({ error: { message: "closed" } });
    }
    this.waiting.clear();
  }

  get ready(): boolean {
    return this.initialized;
  }

  private post(message: JsonRpcFrameMessage): void {
    this.frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
  }

  notify(method: string, params: unknown = {}): void {
    if (this.initialized) this.post({ method, params });
  }

  request(
    method: string,
    params: unknown = {},
    timeout = 1500,
  ): Promise<JsonRpcFrameMessage | undefined> {
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
    if (this.initialized) await this.request("ui/resource-teardown", {}, 500);
  }

  private notified(method: string): void {
    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      this.handlers.ready();
    }
  }

  private async answer(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.handle(method, params);
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

  private async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
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
        if (typeof params.name !== "string" || !params.name) {
          throw new BridgeError(-32602, "缺少工具名");
        }
        return this.handlers.callTool(params.name, asObject(params.arguments) ?? {});
      }
      case "resources/read": {
        if (typeof params.uri !== "string") {
          throw new BridgeError(-32602, "缺少资源地址");
        }
        return this.handlers.readResource(params.uri);
      }
      case "ui/request-display-mode":
        return { mode: "fullscreen" };
      case "ui/open-link": {
        if (typeof params.url !== "string") {
          throw new BridgeError(-32602, "缺少链接");
        }
        this.handlers.openLink(params.url);
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
