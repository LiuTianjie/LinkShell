import { RpcError, type McpApp, type MethodParams, type MethodResult, type ToolDetail } from "@linkshell/wire";
import type { McpAppsSupport } from "../types.js";
import { connectorOf, descriptorPage, isPageUri, itemHasPage, mcpPage, type McpToolDescriptor, type McpToolLookup } from "./mapper.js";

// MCP Apps in Codex: tools with a `ui://` page of their own (StupidMirror's
// phone viewer, Figma). Codex lists them in `mcpServerStatus/list`, reads their
// pages with `mcpServer/resource/read` and lets a page call its server's tools
// with `mcpServer/tool/call`.

type Json = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Where Codex's connectors (Figma, GitHub, …) are served from: one server, each connector's tools under its own namespace. */
const CONNECTORS = "codex_apps";
/** A page is a few hundred KB; this keeps a runaway resource off the tunnel. */
const MAX_RESOURCE = 4 * 1024 * 1024;
/** The list is ~1 MB from Codex's connectors alone: not re-read for every unknown tool. */
const REFRESH_COOLDOWN_MS = 30_000;
/** How old a list `mcp.apps` answers from: someone opening the menu may just have installed a plugin. */
const APPS_MAX_AGE_MS = 30_000;
const MAX_PENDING = 200;
const MAX_PAGES = 20;
/** `plugin/installed` waits on remote marketplaces (30 s when one doesn't answer): the list doesn't wait longer than this for it. */
const PLUGIN_WAIT_MS = 1500;
const PLUGIN_MAX_AGE_MS = 5 * 60_000;

interface Server {
  pluginId?: string;
  title?: string;
  tools: Map<string, McpToolDescriptor>;
}

export interface CodexMcpAppsOptions {
  /** A request to the app-server; with `threadId`, to the server that thread is loaded in. */
  request<T>(method: string, params: unknown, threadId?: string): Promise<T>;
  /** Whether a thread is joined here, held by a Codex that takes no other clients, or neither. */
  reach(threadId: string): "joined" | "held" | "unloaded";
  /** A call's page turned out only once its tool had been looked up, after its card went out. */
  lateDetail(threadId: string, toolCallId: string, detail: Extract<ToolDetail, { type: "mcp" }>): void;
  log(message: string): void;
  refreshCooldownMs?: number;
}

/** A call whose tool wasn't known when it was mapped. */
interface Missed {
  threadId: string;
  item: Json;
}

export class CodexMcpApps implements McpAppsSupport {
  private servers = new Map<string, Server>();
  private loadedAt?: number;
  /** When the list was last asked for, read or not: misses wait out the cooldown from then. */
  private triedAt?: number;
  private loading?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly missed = new Map<string, Missed>();
  /**
   * Tools a read didn't find for a call (uninstalled since): history is mapped
   * again and again (a thread read from disk, every few seconds), and each time
   * would have the list read again. Found again by any later read.
   */
  private readonly absent = new Set<string>();
  /** Plugins' display names by id, as last read. */
  private plugins = new Map<string, string>();
  private pluginsAskedAt?: number;
  private pluginsReading?: Promise<void>;
  private pluginsAnswered = false;
  private readonly cooldown: number;

  constructor(private readonly options: CodexMcpAppsOptions) {
    this.cooldown = options.refreshCooldownMs ?? REFRESH_COOLDOWN_MS;
  }

  /**
   * Looks up the tools of a thread's calls. A tool that isn't known has the
   * list read again, and a page found then reaches the call's card late.
   */
  lookup(threadId: string): McpToolLookup {
    return (item) => {
      const server = str(item.server);
      const tool = str(item.tool);
      if (!server || !tool) return undefined;
      const found = this.find(server, tool, str(obj(item.appContext)?.connectorId));
      if (found || itemHasPage(item) || this.absent.has(`${server}\n${tool}`)) return found;
      const id = str(item.id);
      if (id) this.miss(threadId, id, item);
      return undefined;
    };
  }

  async apps(_nativeId: string): Promise<McpApp[]> {
    if (this.loadedAt === undefined || Date.now() - this.loadedAt > APPS_MAX_AGE_MS) await this.load();
    const plugins = await this.pluginNames();
    const apps: McpApp[] = [];
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools.values()) {
        const meta = tool._meta;
        const entrypoints = arr(obj(meta?.["openai/ui"])?.entrypoints).flatMap((entry) => str(obj(entry)?.type) ?? []);
        const app = descriptorPage(meta);
        if (!app || !entrypoints.includes("thread")) continue;
        const visibility = obj(meta?.ui)?.visibility;
        apps.push({
          server: serverName,
          tool: tool.name,
          // "StupidMirror" says more than "show_screen".
          title: str(meta?.connector_name) ?? (server.pluginId ? plugins.get(server.pluginId) : undefined) ?? tool.title ?? server.title ?? tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          resourceUri: app.resourceUri,
          entrypoints,
          ...(Array.isArray(visibility) ? { visibility: visibility.filter((entry): entry is string => typeof entry === "string") } : {}),
          ...(app.displayMode ? { displayMode: app.displayMode } : {}),
          ...(app.connector ? { connector: app.connector } : {}),
        });
      }
    }
    return apps;
  }

  async resource(nativeId: string, request: Omit<MethodParams<"mcp.resource">, "sessionId">): Promise<MethodResult<"mcp.resource">> {
    if (!isPageUri(request.uri)) throw RpcError.app("invalid_params", "只能读取插件页面（ui:// 开头的地址）");
    // The thread's own MCP connection, where there is one to reach; Codex reads a page without it too.
    const threadId = this.options.reach(nativeId) === "joined" ? nativeId : undefined;
    const result = await this.codex<{ contents?: unknown[] }>(
      "mcpServer/resource/read",
      { ...(threadId ? { threadId } : {}), server: request.server, uri: request.uri, ...(request.connector ? { connectorId: request.connector } : {}) },
      threadId,
      "读取插件页面",
    );
    const first = obj(arr(result.contents)[0]);
    if (!first) throw RpcError.app("not_found", "插件没有给出这个页面");
    const text = str(first.text);
    const blob = str(first.blob);
    const size = (text?.length ?? 0) + (blob?.length ?? 0);
    if (size > MAX_RESOURCE) throw RpcError.app("too_large", `插件页面有 ${(size / 1024 / 1024).toFixed(1)} MB，超过了 ${MAX_RESOURCE / 1024 / 1024} MB 的上限`);
    return {
      ...(str(first.mimeType) ? { mimeType: str(first.mimeType) } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(blob !== undefined ? { blob } : {}),
      ...(first._meta !== undefined ? { meta: first._meta } : {}),
    };
  }

  async call(nativeId: string, request: Omit<MethodParams<"mcp.call">, "sessionId">): Promise<MethodResult<"mcp.call">> {
    if (this.options.reach(nativeId) === "held") {
      throw RpcError.app("not_supported", "这个会话开在电脑的另一个 Codex 里，插件页面不能从这里调用工具");
    }
    const { server, tool, connector } = request;
    if (server === CONNECTORS && !connector) throw RpcError.app("invalid_params", "调用 codex_apps 的工具要说明是哪个插件（connector）");
    let descriptor = this.find(server, tool, connector);
    // A tool installed since the list was read: read it again, once.
    if (!descriptor) {
      await this.load();
      descriptor = this.find(server, tool, connector);
    }
    if (!descriptor) throw RpcError.app("not_found", `MCP 服务 ${server} 没有工具 ${tool}`);
    const meta = descriptor._meta;
    // Least privilege: a page may call its own server's tools, and only a server that has pages has them.
    if (!this.hasPage(server, connector)) throw RpcError.app("forbidden", `MCP 服务 ${server} 没有插件页面，不能从页面调用它的工具`);
    if (server === CONNECTORS && connectorOf(meta) !== connector) throw RpcError.app("forbidden", "这个工具属于另一个插件，当前页面不能调用");
    if (meta?.["openai/fileParams"] !== undefined) throw RpcError.app("forbidden", "这个工具要读写电脑上的文件，插件页面不能直接调用");
    const visibility = obj(meta?.ui)?.visibility;
    if (Array.isArray(visibility) && !visibility.includes("app")) throw RpcError.app("forbidden", "这个工具只给 Codex 自己调用，插件页面不能调用");
    const result = await this.codex<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean; _meta?: unknown }>(
      "mcpServer/tool/call",
      // The name as the server lists it: a `codex_apps` page may leave out its connector's namespace.
      { threadId: nativeId, server, tool: descriptor.name, ...(request.arguments ? { arguments: request.arguments } : {}) },
      nativeId,
      "调用插件工具",
    );
    return {
      content: arr(result.content),
      ...(result.structuredContent != null ? { structuredContent: result.structuredContent } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...(result._meta != null ? { meta: result._meta } : {}),
    };
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.missed.clear();
  }

  /**
   * A tool by the name a call or a page gives it. `codex_apps` lists its tools
   * under their connector's namespace (`figma.generate_deck`), which a call or
   * a page may leave out.
   */
  private find(server: string, tool: string, connector?: string): McpToolDescriptor | undefined {
    const tools = this.servers.get(server)?.tools;
    if (!tools) return undefined;
    const exact = tools.get(tool);
    if (exact && (!connector || server !== CONNECTORS || connectorOf(exact._meta) === connector)) return exact;
    let match: McpToolDescriptor | undefined;
    for (const [name, descriptor] of tools) {
      if (!name.endsWith(`.${tool}`) || (connector && connectorOf(descriptor._meta) !== connector)) continue;
      // Two connectors' tools of the same name: which one was meant isn't known.
      if (match) return undefined;
      match = descriptor;
    }
    return match ?? exact;
  }

  private hasPage(server: string, connector: string | undefined): boolean {
    for (const tool of this.servers.get(server)?.tools.values() ?? []) {
      if ((server !== CONNECTORS || connectorOf(tool._meta) === connector) && descriptorPage(tool._meta)) return true;
    }
    return false;
  }

  private miss(threadId: string, toolCallId: string, item: Json): void {
    // What finding its page needs, not the whole result.
    const result = obj(item.result);
    this.missed.delete(toolCallId);
    this.missed.set(toolCallId, {
      threadId,
      item: { id: toolCallId, server: item.server, tool: item.tool, appContext: item.appContext, mcpAppUi: item.mcpAppUi, mcpAppResourceUri: item.mcpAppResourceUri, ...(result ? { result: { _meta: result._meta } } : {}) },
    });
    if (this.missed.size > MAX_PENDING) this.missed.delete(this.missed.keys().next().value!);
    this.schedule();
  }

  private schedule(): void {
    if (this.loading || this.timer || this.missed.size === 0) return;
    const wait = this.triedAt === undefined ? 0 : Math.max(0, this.triedAt + this.cooldown - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load().catch(() => {});
    }, wait);
    this.timer.unref?.();
  }

  /** Reads every server's tools again. Concurrent callers share one read. */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    const asked = new Set(this.missed.keys());
    this.triedAt = Date.now();
    this.loading = this.read()
      .then((servers) => {
        this.servers = servers;
        this.loadedAt = Date.now();
        this.settle(asked);
      })
      .catch((error: unknown) => {
        // (An older Codex without the list fails every time: the calls it was read for get no page.)
        for (const toolCallId of asked) this.missed.delete(toolCallId);
        this.options.log(`[codex] couldn't list MCP tools: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      })
      .finally(() => {
        this.loading = undefined;
        // Calls that came in while the list was being read may name tools it predates.
        this.schedule();
      });
    return this.loading;
  }

  private async read(): Promise<Map<string, Server>> {
    const servers = new Map<string, Server>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.codex<{ data?: unknown[]; nextCursor?: string | null }>(
        "mcpServerStatus/list",
        // Tools and their metadata are enough; resources would add every server's inventory.
        { detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}) },
        undefined,
        "列出 MCP 工具",
      );
      for (const raw of arr(result.data)) {
        const entry = obj(raw);
        const name = str(entry?.name);
        if (!entry || !name) continue;
        const tools = new Map<string, McpToolDescriptor>();
        for (const [key, value] of Object.entries(obj(entry.tools) ?? {})) {
          const tool = obj(value);
          if (!tool) continue;
          // Only what pages need: the input schemas are most of the megabyte.
          tools.set(key, {
            name: str(tool.name) ?? key,
            ...(str(tool.title) ? { title: str(tool.title) } : {}),
            ...(str(tool.description) ? { description: str(tool.description) } : {}),
            ...(obj(tool._meta) ? { _meta: obj(tool._meta) } : {}),
          });
        }
        servers.set(name, { pluginId: str(entry.pluginId), title: str(obj(entry.serverInfo)?.title), tools });
      }
      cursor = str(result.nextCursor);
      if (!cursor) break;
    }
    return servers;
  }

  /** Sends the pages found for the calls that were waiting; drops the ones the list was read for and that still aren't known. */
  private settle(asked: Set<string>): void {
    for (const [toolCallId, missed] of [...this.missed]) {
      const server = str(missed.item.server);
      const tool = str(missed.item.tool);
      const descriptor = server && tool ? this.find(server, tool, str(obj(missed.item.appContext)?.connectorId)) : undefined;
      if (!descriptor && !asked.has(toolCallId)) continue;
      this.missed.delete(toolCallId);
      if (!descriptor) {
        this.absent.add(`${server}\n${tool}`);
        if (this.absent.size > MAX_PENDING) this.absent.delete(this.absent.values().next().value!);
      }
      const app = descriptor ? mcpPage(missed.item, () => descriptor) : undefined;
      if (app) this.options.lateDetail(missed.threadId, toolCallId, { type: "mcp", server: server!, tool: tool!, app });
    }
  }

  /**
   * Plugins' display names by id: what was last read, or what a read answers
   * shortly. A read that takes longer goes on for the next list; until then
   * titles fall back to the tools' own.
   */
  private async pluginNames(): Promise<Map<string, string>> {
    if (!this.pluginsReading && (this.pluginsAskedAt === undefined || Date.now() - this.pluginsAskedAt > PLUGIN_MAX_AGE_MS)) {
      this.pluginsAskedAt = Date.now();
      this.pluginsReading = this.options
        .request<{ marketplaces?: unknown[] }>("plugin/installed", {})
        .then((result) => {
          const names = new Map<string, string>();
          for (const marketplace of arr(result.marketplaces)) {
            for (const raw of arr(obj(marketplace)?.plugins)) {
              const plugin = obj(raw);
              const id = str(plugin?.id);
              const name = str(obj(plugin?.interface)?.displayName);
              if (id && name) names.set(id, name);
            }
          }
          // A marketplace that didn't answer this time still had its plugins' names.
          this.plugins = new Map([...this.plugins, ...names]);
          this.pluginsAnswered = true;
        })
        .catch(() => {
          // An older Codex without it: titles stay the tools' own.
        })
        .finally(() => {
          this.pluginsReading = undefined;
        });
    }
    // Names read before are good enough while they are read again.
    if (this.pluginsReading && !this.pluginsAnswered) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.pluginsReading, new Promise((resolve) => (timer = setTimeout(resolve, PLUGIN_WAIT_MS)))]);
      clearTimeout(timer);
    }
    return this.plugins;
  }

  /** A Codex request, its failures said in the user's words. */
  private async codex<T>(method: string, params: unknown, threadId: string | undefined, what: string): Promise<T> {
    try {
      return await this.options.request<T>(method, params, threadId);
    } catch (error) {
      if (error instanceof RpcError && error.appCode === "agent_unavailable") throw RpcError.app("agent_unavailable", "电脑上的 Codex 现在没有运行");
      if (error instanceof RpcError && error.appCode === "timeout") throw RpcError.app("timeout", `Codex ${what}超时`);
      if (error instanceof RpcError && error.appCode) throw error;
      throw RpcError.app("agent_error", `Codex 没能${what}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
