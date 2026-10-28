// An MCP App's host side (SEP-1865 / `@modelcontextprotocol/ext-apps`, as Codex hosts them): the
// page a tool ships (`ui://…`) runs in a sandboxed frame of its own and talks to us over
// postMessage JSON-RPC (`ui/*`, plus the MCP requests it may make of its own server).

export const MCP_APP_PROTOCOL = "2026-01-26";

/** The MIME types Codex accepts for an app's page. */
export function isAppPage(mimeType: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase().replace(/\s+/g, "");
  return type === "text/html;profile=mcp-app" || type === "text/html+skybridge" || type === "text/html";
}

interface AppCsp { connectDomains?: unknown; resourceDomains?: unknown; frameDomains?: unknown }

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Origins a page declared it needs, kept to plain https/wss origins: nothing that widens to a scheme or a wildcard of everything. */
function origins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const match = /^(https|wss):\/\/(\*\.)?((?:[a-z0-9-]+\.)+[a-z0-9-]+)(:\d{1,5})?\/?$/i.exec(entry.trim());
    return match ? [`${match[1].toLowerCase()}://${match[2] ?? ""}${match[3].toLowerCase()}${match[4] ?? ""}`] : [];
  });
}

/** The page's display mode preference and CSP, from its resource's `_meta` (Codex's keys). */
export function appResourceMeta(meta: unknown): { csp: AppCsp; displayModes: string[]; preferred?: string } {
  const root = obj(meta) ?? {};
  const ui = obj(root.ui) ?? {};
  const openai = obj(root["openai/ui"]) ?? {};
  const modes = Array.isArray(openai.availableDisplayModes) ? openai.availableDisplayModes.filter((mode): mode is string => typeof mode === "string") : [];
  return { csp: (obj(ui.csp) ?? {}) as AppCsp, displayModes: modes, preferred: typeof openai.preferredDisplayMode === "string" ? openai.preferredDisplayMode : undefined };
}

/**
 * The policy the page runs under: its own inline code, the origins it declared and nothing else.
 * It sits in a sandboxed frame with an opaque origin, so it never reaches this window's storage,
 * cookies or the host connection; this only bounds what it may fetch and load.
 */
export function appCsp(csp: AppCsp): string {
  const connect = origins(csp.connectDomains);
  const resource = origins(csp.resourceDomains);
  const frame = origins(csp.frameDomains);
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
  ].map((rule) => rule.trim()).join("; ");
}

/** The page as the frame loads it: its own document with the policy first in its head. */
export function appDocument(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (root) => `${root}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
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
  /** `tools/call` from the page: always on the app's own server. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  openLink(url: string): void;
  /** `ui/message`: the page asks to say something in the conversation. */
  message?(content: unknown[]): Promise<void>;
  /** Once the page is ready: what it should be told first (the call's input, then its result). */
  ready(): void;
}

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** One page's end of the conversation, on a frame's window. */
export class AppBridge {
  private nextId = 1;
  private readonly waiting = new Map<string | number, (message: Message) => void>();
  private initialized = false;
  private readonly listener = (event: MessageEvent) => {
    // Only the frame's own document; it has no origin to check (sandboxed, opaque).
    if (event.source !== this.frame.contentWindow) return;
    const message = obj(event.data) as Message | undefined;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id === undefined) return void this.notified(message.method);
    void this.answer(message.id, message.method, obj(message.params) ?? {});
  };

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly handlers: AppBridgeHandlers,
    private context: AppHostContext,
    private readonly hostInfo: { name: string; version: string },
  ) {
    window.addEventListener("message", this.listener);
  }

  dispose(): void {
    window.removeEventListener("message", this.listener);
    for (const resolve of this.waiting.values()) resolve({ error: { message: "closed" } });
    this.waiting.clear();
  }

  get ready(): boolean { return this.initialized; }

  private post(message: Message): void {
    this.frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
  }

  notify(method: string, params: unknown = {}): void {
    if (this.initialized) this.post({ method, params });
  }

  request(method: string, params: unknown = {}, timeout = 1500): Promise<Message | undefined> {
    const id = `host-${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(undefined); }, timeout);
      this.waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.post({ id, method, params });
    });
  }

  setContext(next: Partial<AppHostContext>): void {
    this.context = { ...this.context, ...next };
    this.notify("ui/notifications/host-context-changed", next);
  }

  /** Asks the page to let go before its frame is removed; it gets a moment, not a veto. */
  async teardown(): Promise<void> {
    if (this.initialized) await this.request("ui/resource-teardown", {}, 500);
  }

  private notified(method: string): void {
    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      this.handlers.ready();
    }
    // size-changed and the rest: the panel sizes the page, not the other way round.
  }

  private async answer(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.handle(method, params);
      this.post({ id, result });
    } catch (error) {
      const known = error instanceof BridgeError;
      this.post({ id, error: { code: known ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ui/initialize":
        return {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_APP_PROTOCOL,
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
        if (typeof params.name !== "string" || !params.name) throw new BridgeError(-32602, "缺少工具名");
        return this.handlers.callTool(params.name, obj(params.arguments) ?? {});
      }
      case "resources/read": {
        if (typeof params.uri !== "string") throw new BridgeError(-32602, "缺少资源地址");
        return this.handlers.readResource(params.uri);
      }
      case "ui/request-display-mode":
        // The inspector is the only place an app shows: whatever it asks, it is there.
        return { mode: "fullscreen" };
      case "ui/open-link": {
        if (typeof params.url !== "string") throw new BridgeError(-32602, "缺少链接");
        this.handlers.openLink(params.url);
        return {};
      }
      case "ui/message": {
        if (!this.handlers.message) throw new BridgeError(-32601, "不支持发送消息");
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

class BridgeError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
