import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { RpcError, type McpApp, type MethodParams, type MethodResult, type ToolDetail } from "@linkshell/wire";
import { trackPid } from "../../children.js";
import type { McpAppsSupport } from "../types.js";
import { descriptorPage, isPageUri, type McpToolDescriptor } from "../codex/mapper.js";

// MCP Apps in Claude sessions. Claude Code loads the user's MCP servers itself
// but tells no one which of its tools have pages, and has no way for a page to
// call them. So the host reads the same configuration Claude does and opens its
// own connection to a server when a page needs one: to list its tools, read a
// page and run the tools the page calls.

type Json = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const MAX_RESOURCE = 4 * 1024 * 1024;
/** How old a server's tool list may be before it's read again. */
const TOOLS_MAX_AGE_MS = 30_000;
/** A server that couldn't be reached isn't tried again for this long. */
const FAILED_RETRY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long the menu waits for servers: a slow one (an `npx` download) joins the list the next time it's opened. */
const LIST_WAIT_MS = 4000;
/** A connection no page has used for this long is closed. */
const IDLE_MS = 10 * 60_000;

export type ClaudeMcpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

/** Claude Code's name for a server in its tool names (`mcp__<name>__<tool>`). */
export const normalizedServerName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in its MCP configuration. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

function strings(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj(value) ?? {})) if (typeof entry === "string") out[key] = expand(entry, env);
  return out;
}

function parseServer(raw: unknown, env: NodeJS.ProcessEnv): ClaudeMcpServerConfig | undefined {
  const entry = obj(raw);
  if (!entry) return undefined;
  const type = str(entry.type) ?? (entry.url ? "http" : "stdio");
  if (type === "stdio") {
    const command = str(entry.command);
    if (!command) return undefined;
    return { type, command: expand(command, env), args: arr(entry.args).flatMap((arg) => (typeof arg === "string" ? [expand(arg, env)] : [])), env: strings(entry.env, env) };
  }
  if (type === "http" || type === "sse") {
    const url = str(entry.url);
    return url ? { type, url: expand(url, env), headers: strings(entry.headers, env) } : undefined;
  }
  // (`sdk` and `ws` servers live inside another process: nothing to connect to.)
  return undefined;
}

function readJson(path: string): Json | undefined {
  try {
    return existsSync(path) ? obj(JSON.parse(readFileSync(path, "utf8"))) : undefined;
  } catch {
    return undefined;
  }
}

/** Where Claude Code keeps its global state: beside the config directory's parent, unless CLAUDE_CONFIG_DIR moved both. */
export function claudeStatePath(configDir: string, env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(dirname(configDir) || homedir(), ".claude.json");
}

/**
 * The MCP servers a Claude session in `cwd` has, by name, as Claude Code
 * resolves them: the user's servers, then the project's own entry in
 * `.claude.json`, then the project's `.mcp.json` where the user approved it.
 */
export function claudeMcpServers(statePath: string, configDir: string, cwd: string | undefined, env: NodeJS.ProcessEnv): Map<string, ClaudeMcpServerConfig> {
  const servers = new Map<string, ClaudeMcpServerConfig>();
  const state = readJson(statePath);
  const project = cwd ? obj(obj(state?.projects)?.[cwd]) : undefined;
  const add = (map: unknown, allowed: (name: string) => boolean = () => true) => {
    for (const [name, raw] of Object.entries(obj(map) ?? {})) {
      const parsed = parseServer(raw, env);
      if (parsed && allowed(name)) servers.set(name, parsed);
    }
  };
  add(state?.mcpServers);
  if (cwd) {
    const settings = { ...readJson(join(configDir, "settings.json")), ...readJson(join(cwd, ".claude", "settings.json")), ...readJson(join(cwd, ".claude", "settings.local.json")) };
    const enabled = new Set([...arr(project?.enabledMcpjsonServers), ...arr(settings.enabledMcpjsonServers)].flatMap((name) => (typeof name === "string" ? [name] : [])));
    const disabled = new Set([...arr(project?.disabledMcpjsonServers), ...arr(settings.disabledMcpjsonServers)].flatMap((name) => (typeof name === "string" ? [name] : [])));
    const all = project?.enableAllProjectMcpServers === true || settings.enableAllProjectMcpServers === true;
    // Project-scoped servers ask before they run: only the ones the user said yes to.
    add(obj(readJson(join(cwd, ".mcp.json"))?.mcpServers), (name) => !disabled.has(name) && (all || enabled.has(name)));
    add(project?.mcpServers);
  }
  for (const name of arr(project?.disabledMcpServers)) if (typeof name === "string") servers.delete(name);
  return servers;
}

interface Tool extends McpToolDescriptor {
  /** Whether it can be run with nothing (no required input). */
  bare: boolean;
}

interface Connection {
  key: string;
  name: string;
  config: ClaudeMcpServerConfig;
  client?: Promise<Client>;
  tools?: Map<string, Tool>;
  toolsAt?: number;
  listing?: Promise<Map<string, Tool>>;
  failedAt?: number;
  failure?: string;
  usedAt: number;
  untrack?: () => void;
  /** While it opens, so closing needn't wait for that. */
  transport?: { close(): Promise<void> };
}

export interface ClaudeMcpAppsOptions {
  env(): NodeJS.ProcessEnv;
  configDir: string;
  /** The session's working directory, where the host knows it. */
  cwdOf(nativeId: string): string | undefined;
  /** A call's page, found after its card went out. */
  lateDetail(nativeId: string, toolCallId: string, detail: Extract<ToolDetail, { type: "mcp" }>, parentToolCallId?: string): void;
  log(message: string): void;
  /** For tests: a client already connected. */
  connect?(config: ClaudeMcpServerConfig): Promise<Client>;
  listWaitMs?: number;
}

export class ClaudeMcpApps implements McpAppsSupport {
  private readonly connections = new Map<string, Connection>();
  private sweep?: ReturnType<typeof setInterval>;
  private readonly looking = new Set<string>();

  constructor(private readonly options: ClaudeMcpAppsOptions) {}

  async apps(nativeId: string): Promise<McpApp[]> {
    const connections = this.configured(nativeId);
    const apps: McpApp[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, this.options.listWaitMs ?? LIST_WAIT_MS, undefined)));
    await Promise.all(
      connections.map(async (connection) => {
        const tools = await Promise.race([this.tools(connection).catch(() => undefined), deadline]);
        for (const tool of tools?.values() ?? []) {
          const meta = tool._meta;
          const page = descriptorPage(meta);
          if (!page) continue;
          const visibility = arr(obj(meta?.ui)?.visibility).filter((entry): entry is string => typeof entry === "string");
          // A page only the server's own pages open isn't one to start from the menu.
          if (visibility.length && !visibility.includes("model")) continue;
          const entrypoints = arr(obj(meta?.["openai/ui"])?.entrypoints).flatMap((entry) => str(obj(entry)?.type) ?? []);
          // Codex's rule where the tool states one; otherwise a page that needs nothing to start.
          if (entrypoints.length ? !entrypoints.includes("thread") : !tool.bare) continue;
          apps.push({
            server: connection.name,
            tool: tool.name,
            title: tool.title ?? connection.name,
            ...(tool.description ? { description: tool.description } : {}),
            resourceUri: page.resourceUri,
            entrypoints: entrypoints.length ? entrypoints : ["thread"],
            ...(visibility.length ? { visibility } : {}),
            ...(page.displayMode ? { displayMode: page.displayMode } : {}),
          });
        }
      }),
    );
    clearTimeout(timer);
    return apps.sort((a, b) => a.title.localeCompare(b.title));
  }

  async resource(nativeId: string, request: Omit<MethodParams<"mcp.resource">, "sessionId">): Promise<MethodResult<"mcp.resource">> {
    if (!isPageUri(request.uri)) throw RpcError.app("invalid_params", "只能读取插件页面（ui:// 开头的地址）");
    const connection = this.server(nativeId, request.server);
    const client = await this.client(connection);
    const result = await this.attempt(connection, "读取插件页面", () => client.readResource({ uri: request.uri }, { timeout: CALL_TIMEOUT_MS }));
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
    const connection = this.server(nativeId, request.server);
    let tools = await this.tools(connection);
    let tool = tools.get(request.tool);
    if (!tool) {
      // Added since the list was read.
      connection.toolsAt = undefined;
      tools = await this.tools(connection);
      tool = tools.get(request.tool);
    }
    if (!tool) throw RpcError.app("not_found", `MCP 服务 ${request.server} 没有工具 ${request.tool}`);
    // Least privilege, as for Codex: only a server that has pages, and only tools its pages may call.
    if (![...tools.values()].some((entry) => descriptorPage(entry._meta))) throw RpcError.app("forbidden", `MCP 服务 ${request.server} 没有插件页面，不能从页面调用它的工具`);
    const meta = tool._meta;
    if (meta?.["openai/fileParams"] !== undefined) throw RpcError.app("forbidden", "这个工具要读写电脑上的文件，插件页面不能直接调用");
    const visibility = obj(meta?.ui)?.visibility;
    if (Array.isArray(visibility) && !visibility.includes("app")) throw RpcError.app("forbidden", "这个工具只给 Claude 自己调用，插件页面不能调用");
    const client = await this.client(connection);
    const result = await this.attempt(connection, "调用插件工具", () => client.callTool({ name: tool.name, arguments: request.arguments ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS }));
    return {
      content: arr(result.content),
      ...(result.structuredContent != null ? { structuredContent: result.structuredContent } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...(result._meta != null ? { meta: result._meta } : {}),
    };
  }

  /**
   * The page of a call's tool, where it is known now. An unknown tool of a
   * configured server has the server's tools read, and a page found then
   * reaches the call's card late (`lateDetail`).
   */
  page(nativeId: string, toolCallId: string, detail: Extract<ToolDetail, { type: "mcp" }>, parentToolCallId?: string): Extract<ToolDetail, { type: "mcp" }>["app"] {
    if (detail.app) return detail.app;
    const connection = this.byToolName(nativeId, detail.server);
    if (!connection) return undefined;
    const known = connection.tools?.get(detail.tool);
    if (known || (connection.tools && connection.toolsAt && Date.now() - connection.toolsAt < TOOLS_MAX_AGE_MS)) return known && descriptorPage(known._meta);
    if (connection.failedAt && Date.now() - connection.failedAt < FAILED_RETRY_MS) return undefined;
    const key = `${nativeId}\n${toolCallId}`;
    if (this.looking.has(key)) return undefined;
    this.looking.add(key);
    void this.tools(connection)
      .then((tools) => {
        const tool = tools.get(detail.tool);
        const app = tool && descriptorPage(tool._meta);
        if (app) this.options.lateDetail(nativeId, toolCallId, { ...detail, app }, parentToolCallId);
      })
      .catch(() => {})
      .finally(() => this.looking.delete(key));
    return undefined;
  }

  async stop(): Promise<void> {
    clearInterval(this.sweep);
    this.sweep = undefined;
    const open = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(open.map((connection) => this.close(connection)));
  }

  /** The servers configured for the session, one connection per distinct configuration. */
  private configured(nativeId: string): Connection[] {
    const env = this.options.env();
    const servers = claudeMcpServers(claudeStatePath(this.options.configDir, env), this.options.configDir, this.options.cwdOf(nativeId), env);
    return [...servers].map(([name, config]) => {
      const key = `${name}\n${JSON.stringify(config)}`;
      let connection = this.connections.get(key);
      if (!connection) {
        connection = { key, name, config, usedAt: Date.now() };
        this.connections.set(key, connection);
      }
      return connection;
    });
  }

  private server(nativeId: string, name: string): Connection {
    // (A call's card names the server as Claude's tool names do.)
    const connection = this.byToolName(nativeId, name);
    if (!connection) throw RpcError.app("not_found", `这个会话的 Claude 没有配置 MCP 服务 ${name}`);
    return connection;
  }

  /** The server a tool call names, by Claude Code's normalized form of the name. */
  private byToolName(nativeId: string, server: string): Connection | undefined {
    const connections = this.configured(nativeId);
    return connections.find((entry) => entry.name === server) ?? connections.find((entry) => normalizedServerName(entry.name) === server);
  }

  private async tools(connection: Connection): Promise<Map<string, Tool>> {
    if (connection.tools && connection.toolsAt && Date.now() - connection.toolsAt < TOOLS_MAX_AGE_MS) return connection.tools;
    if (connection.failedAt && Date.now() - connection.failedAt < FAILED_RETRY_MS) throw RpcError.app("agent_error", connection.failure ?? `连不上 MCP 服务 ${connection.name}`);
    connection.listing ??= (async () => {
      const client = await this.client(connection);
      const tools = new Map<string, Tool>();
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await this.attempt(connection, "列出 MCP 工具", () => client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS }));
        for (const raw of result.tools) {
          const required = arr(obj(raw.inputSchema)?.required);
          tools.set(raw.name, {
            name: raw.name,
            ...(raw.title ? { title: raw.title } : {}),
            ...(raw.description ? { description: raw.description } : {}),
            ...(obj(raw._meta) ? { _meta: obj(raw._meta) } : {}),
            bare: required.length === 0,
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      connection.tools = tools;
      connection.toolsAt = Date.now();
      return tools;
    })().finally(() => {
      connection.listing = undefined;
    });
    return connection.listing;
  }

  private client(connection: Connection): Promise<Client> {
    connection.usedAt = Date.now();
    this.startSweep();
    if (connection.client) return connection.client;
    if (connection.failedAt && Date.now() - connection.failedAt < FAILED_RETRY_MS) {
      return Promise.reject(RpcError.app("agent_error", connection.failure ?? `连不上 MCP 服务 ${connection.name}`));
    }
    const opening = this.open(connection).catch((error: unknown) => {
      if (connection.client === opening) connection.client = undefined;
      connection.failedAt = Date.now();
      connection.failure = `连不上 MCP 服务 ${connection.name}：${describe(error)}`;
      this.options.log(`[claude] MCP ${connection.name}: ${describe(error)}`);
      throw RpcError.app("agent_error", connection.failure);
    });
    connection.client = opening;
    return opening;
  }

  private async open(connection: Connection): Promise<Client> {
    if (this.options.connect) return this.options.connect(connection.config);
    const { config } = connection;
    const client = new Client(
      { name: "linkshell", version: "1" },
      // Tells servers that render pages that this client shows them.
      { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
    );
    const env = this.options.env();
    const transport =
      config.type === "stdio"
        ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...definedOnly(env), ...config.env }, stderr: "ignore" })
        : config.type === "http"
          ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
          : new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    connection.transport = transport;
    client.onclose = () => {
      connection.untrack?.();
      connection.untrack = undefined;
      // The next use opens it again.
      if (connection.client) connection.client = undefined;
      connection.toolsAt = undefined;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("连接超时")), CONNECT_TIMEOUT_MS))),
      ]);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (transport instanceof StdioClientTransport && transport.pid) {
      // A crashed host leaves no MCP servers behind (children.ts).
      connection.untrack = trackPid(transport.pid, "MCP server", config.type === "stdio" ? config.command : "", config.type === "stdio" ? config.args : [], false);
    }
    connection.failedAt = undefined;
    connection.failure = undefined;
    return client;
  }

  /** A request to the server, its failures said in the user's words; a dropped connection is opened again once. */
  private async attempt<T>(connection: Connection, what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw RpcError.app("agent_error", `MCP 服务 ${connection.name} 没能${what}：${describe(error)}`);
    }
  }

  private startSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (connection.client && Date.now() - connection.usedAt > IDLE_MS) void this.close(connection);
      }
    }, 60_000);
    this.sweep.unref?.();
  }

  private async close(connection: Connection): Promise<void> {
    connection.client = undefined;
    connection.toolsAt = undefined;
    const transport = connection.transport;
    connection.transport = undefined;
    // (Closing the transport ends a connect still waiting on it, too.)
    await transport?.close().catch(() => {});
    connection.untrack?.();
    connection.untrack = undefined;
  }
}

function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthori[sz]ed|invalid_token/i.test(message)) return "需要登录授权，LinkShell 不能代为登录这个服务";
  return message.slice(0, 200);
}
