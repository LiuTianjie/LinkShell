import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RpcError,
  type AgentAuth,
  type AgentCapabilities,
  type AgentTier,
  type ContentBlock,
  type RpcId,
  type SessionState,
  type SessionUpdate,
  type StopReason,
  type QuestionAnswer,
  acpAgentSettingsSchema,
  type AcpAgentSettings,
  type AcpRemoteAgent,
  type AcpFeatures,
  type AcpProvider,
  type PendingPermissionSummary,
  type WorkflowAgentState,
  type EditorRequest,
  type EditorResult,
  acpProviderSchema,
  questionAnswerError,
} from "@linkshell/wire";
import { AcpClientServices } from "./client-services.js";
import { AcpUpdates, usageUpdate } from "./updates.js";
import { AcpMcpBridge } from "./mcp.js";
import { AcpEditor } from "./editor.js";
import type { AgentDriver, AttachContext, DiscoveredSession, DriverHost, DriverStatus, ForkOptions, HistoryItem } from "../types.js";
import { AcpConnection, AcpProtocolError } from "./connection.js";
import { mapAcpQuestions, questionMethod, type AcpQuestionRequest } from "./questions.js";
import {
  AcpItemTracker,
  mapPermissionRequest,
  normalizeAcpUpdate,
  toAcpPrompt,
  withContext,
  toConfigOptions,
  toHistory,
  toStopReason,
  type SourcedConfigOption,
} from "./mapper.js";

const execFileAsync = promisify(execFile);

export interface AcpAgentSpec {
  id: string;
  label: string;
  tier: AgentTier;
  /** How to start the agent as an ACP server. */
  command: string;
  args: string[];
  /** Detects the install; defaults to `<command> --version`. */
  version?: { command: string; args: string[] };
  env?: Record<string, string>;
  authStatus?: (env: NodeJS.ProcessEnv) => Promise<AgentAuth>;
  /** Non-interactive ACP method that reuses the agent's own saved login. */
  cachedAuthMethod?: string;
  transport?: AcpRemoteAgent["transport"];
  url?: string;
  headerEnv?: Record<string, string>;
  settings?: AcpAgentSettings;
  /**
   * Start the agent process with the host so its existing sessions show up
   * (needs ACP session/list). Otherwise it starts on first use.
   */
  discover?: boolean;
}

/** `items` with the ones named in `ids` first, in that order; the rest keep theirs. */
export function inOrder<T extends { clientMessageId: string }>(items: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.clientMessageId) ?? ids.length) - (rank.get(b.item.clientMessageId) ?? ids.length) || a.index - b.index)
    .map((entry) => entry.item);
}

interface PendingPrompt {
  content: ContentBlock[];
  clientMessageId: string;
  context?: string;
}

export interface AcpSessionState {
  cwd: string;
  settings: AcpAgentSettings;
  loaded: boolean;
  tracker: AcpItemTracker;
  updates: AcpUpdates;
  messageAliases: Map<string, string>;
  deferredUserUpdates: unknown[];
  idleReason?: StopReason;
  reportedState?: SessionState;
  commands?: Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>;
  config: SourcedConfigOption[];
  /** Set while a session/load replays history. */
  replaying?: SessionUpdate[];
  turnActive: boolean;
  /** session/prompt requests in flight; with steering, a turn spans several. */
  inflight: number;
  queue: PendingPrompt[];
  permissions: Map<string, { rpcId: RpcId; resolve: (outcome: unknown) => void }>;
  /** Keep the native response adapter until the user answers or the agent cancels the request. */
  questions: Map<string, { rpcId: RpcId; request: AcpQuestionRequest; resolve: (response: unknown) => void }>;
  /** Cursor's documented question extension omits sessionId; tool calls provide its routing context. */
  toolCalls: Set<string>;
}

/** Turns agent failures into something a person can act on. */
export function describeAgentError(label: string, message: string): { message: string; hint?: string } {
  const lower = message.toLowerCase();
  if (/auth|login|401|unauthori[sz]ed|credential|api key/.test(lower)) {
    return { message: `${label} 鉴权失败`, hint: `在电脑终端确认 ${label} 已登录（或 API key 有效）后重试。原始信息：${message.slice(0, 200)}` };
  }
  if (/rate.?limit|429|quota|usage limit/.test(lower)) {
    return { message: `${label} 用量已达上限`, hint: message.slice(0, 200) };
  }
  if (/model/.test(lower) && /not (supported|found|available)/.test(lower)) {
    return { message: `${label} 当前模型不可用`, hint: `在会话设置里换一个模型。原始信息：${message.slice(0, 200)}` };
  }
  return { message: message.slice(0, 300) };
}

/**
 * A generic Agent Client Protocol driver: one agent subprocess serving every
 * session. Tier "remote" by default — LinkShell drives the agent, the desktop
 * uses LinkShell's own UI. Subclasses add desktop handoff.
 */
export class AcpDriver implements AgentDriver {
  readonly id: string;
  readonly label: string;
  readonly tier: AgentTier;
  capabilities: AgentCapabilities = {
    acp: true,
    interrupt: true,
    steer: false,
    permissions: true,
    images: false,
    fork: false,
    models: false,
    modes: false,
  };

  protected host?: DriverHost;
  /** Set when the agent refused a session for want of a login (ACP auth_required). */
  private signedOut?: AgentAuth;
  protected connection?: AcpConnection;
  protected current: DriverStatus = { installed: false };
  protected readonly sessions = new Map<string, AcpSessionState>();
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartDelay = 1000;
  private stopped = false;
  private nextPermissionId = 1;
  private authenticating?: { connection: AcpConnection; promise: Promise<void> };
  private credentialsChanged = false;
  private readonly services: AcpClientServices;
  private readonly mcp: AcpMcpBridge;
  private readonly edits: AcpEditor;
  private readonly serviceRequests = new Map<RpcId, AbortController>();
  private readonly terminalCalls = new Map<string, Set<string>>();
  private readonly interactions = new Map<string, { rpcId: RpcId; parentId: RpcId; request: AcpQuestionRequest; resolve: (response: unknown) => void }>();
  private readonly children = new Map<string, Map<string, { title?: string; description?: string; canCancel: boolean; state?: unknown }>>();
  private readonly discoveredDirectories = new Map<string, string[]>();

  constructor(
    protected readonly spec: AcpAgentSpec,
    protected readonly options: { env?: NodeJS.ProcessEnv; hostVersion: string },
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.tier = spec.tier;
    this.services = new AcpClientServices({ env: this.env,
      scope: (id) => { const state = this.sessions.get(id); return state ? { cwd: state.cwd, additionalDirectories: state.settings.additionalDirectories } : undefined; },
      output: (id, terminalId, _text, snapshot) => {
        for (const call of this.terminalCalls.get(`${id}\n${terminalId}`) ?? []) {
          this.emit(id, { sessionUpdate: "tool_call_update", toolCallId: call, replaceOutput: snapshot.output });
          if (snapshot.exitStatus) this.emit(id, { sessionUpdate: "tool_call_update", toolCallId: call, rawOutput: { output: snapshot.output, truncated: snapshot.truncated, ...snapshot.exitStatus } });
        }
      },
    });
    this.mcp = new AcpMcpBridge({ env: this.env,
      notify: (params) => this.connection?.notify("mcp/message", params),
      request: async (sessionId, method, params, id) => {
        if (method === "ping") return {};
        const state = sessionId ? this.sessions.get(sessionId) : undefined;
        if (method === "roots/list" && state) return { roots: [state.cwd, ...state.settings.additionalDirectories].map((path) => ({ uri: pathToFileURL(path).href, name: path })) };
        if (method === "elicitation/create" && state) return this.onQuestions(method, { mode: "form", ...(params as object), sessionId }, id);
        throw new RpcError(-32601, `MCP 客户端不支持 ${method}`);
      },
    });
    this.edits = new AcpEditor({ capabilities: () => this.connection?.capabilities ?? {}, settings: () => this.settings(),
      request: (method, params) => this.connection?.request(method, params, method === "nes/close" ? 5000 : 30_000) ?? Promise.reject(RpcError.app("offline", "ACP 连接已关闭")),
      notify: (method, params) => this.connection?.notify(method, params),
    });
  }

  status(): DriverStatus {
    return this.current;
  }

  protected get env(): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env), ...this.spec.env };
  }

  async authStatus(): Promise<AgentAuth> {
    if (this.spec.authStatus) return this.spec.authStatus(this.env);
    return this.signedOut ?? { state: "unknown" };
  }

  async start(host: DriverHost): Promise<DriverStatus> {
    this.host = host;
    this.stopped = false;
    const version = await this.detectVersion();
    if (version === undefined) {
      this.current = { installed: false };
      return this.current;
    }
    this.current = { installed: true, version: version || undefined };
    if (this.spec.discover) await this.boot();
    return this.current;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const state of this.sessions.values()) this.cancelPermissions(state);
    for (const id of [...this.interactions.keys()]) this.resolveInteraction(id, "cancel");
    await this.edits.close();
    await this.connection?.stop();
    this.connection = undefined;
    for (const controller of this.serviceRequests.values()) controller.abort();
    this.serviceRequests.clear(); this.terminalCalls.clear();
    await this.services.close();
    await this.mcp.close();
  }

  async acpInfo(nativeId?: string): Promise<{ features: AcpFeatures; settings: AcpAgentSettings; interactions: PendingPermissionSummary[] }> {
    await this.ensureStarted();
    if (!this.connection?.alive) throw RpcError.app("agent_unavailable", this.current.problem ?? "ACP 启动失败");
    const caps = this.connection.capabilities;
    return { features: {
      protocolVersion: this.connection.protocolVersion,
      authMethods: (this.connection.initializeResult.authMethods ?? []).filter((method) => !method.type || ["terminal", "agent"].includes(method.type)).map((method) => ({ id: method.id, name: method.name ?? method.id, description: method.description ?? undefined, type: method.type === "terminal" ? "terminal" : "agent" })),
      logout: this.connection.protocolVersion === 2 ? caps.auth !== undefined : Boolean(caps.auth?.logout), providers: Boolean(caps.providers) && this.settings().experimental,
      nes: Boolean(caps.nes) && this.settings().experimental,
      additionalDirectories: Boolean(caps.sessionCapabilities?.additionalDirectories), mcpHttp: caps.mcpCapabilities?.http === true, mcpSse: caps.mcpCapabilities?.sse === true,
    }, settings: nativeId ? this.sessions.get(nativeId)?.settings ?? this.settings() : this.settings(), interactions: this.pendingInteractions() };
  }

  async editor(input: EditorRequest): Promise<EditorResult> { await this.ensureStarted(); return this.edits.run(input); }
  pendingInteractions(): PendingPermissionSummary[] { return [...this.interactions.values()].map((entry) => entry.request.update); }

  async configureAcp(settings: AcpAgentSettings, nativeId?: string): Promise<void> {
    settings = acpAgentSettingsSchema.parse(settings);
    await this.validateDirectories(settings);
    const affected = nativeId ? [this.sessions.get(nativeId)].filter((state): state is AcpSessionState => !!state) : [...this.sessions.values()];
    if (affected.some((state) => state.turnActive || state.inflight || state.permissions.size || state.questions.size) || this.interactions.size) throw RpcError.app("busy", "请先结束运行和待处理的交互，再修改 ACP 配置");
    if (nativeId) {
      if (settings.protocolVersion !== this.settings().protocolVersion || settings.experimental !== this.settings().experimental) throw RpcError.app("invalid_params", "协议版本和实验功能需要在 AI 全局设置中修改");
      this.validateSessionSettings(settings);
      await this.detach(nativeId);
      this.host?.state(this.id, nativeId).set("acp-settings", JSON.stringify(settings));
      const state = this.sessions.get(nativeId); if (state) state.settings = settings;
      this.host?.detached(this.id, nativeId);
    } else {
      await this.stop();
      this.stopped = false;
      this.children.clear();
      for (const [id, state] of this.sessions) {
        state.loaded = false;
        if (!this.host?.state(this.id, id).get("acp-settings")) state.settings = settings;
        this.host?.detached(this.id, id);
      }
    }
  }

  async authenticate(methodId?: string, logout = false): Promise<{ terminalId?: string }> {
    const { features } = await this.acpInfo();
    if (logout) {
      if (!features.logout) throw RpcError.app("not_supported", "这个 AI 不支持退出登录");
      if ([...this.sessions.values()].some((state) => state.turnActive)) throw RpcError.app("busy", "请先结束正在运行的会话");
      await this.rpc(this.connection!.protocolVersion === 2 ? "auth/logout" : "logout", {});
      this.signedOut = { state: "missing" }; return {};
    }
    const method = this.connection!.initializeResult.authMethods?.find((entry) => entry.id === methodId);
    if (!method || (method.type && !["agent", "terminal"].includes(method.type))) throw RpcError.app("invalid_params", "请选择可用的登录方式");
    if (method.type === "terminal") {
      if (!this.host?.loginTerminal || ["http", "websocket"].includes(this.spec.transport ?? "")) throw RpcError.app("not_supported", "这个连接不支持终端登录");
      const launch = await this.host.loginTerminal(this.id, { command: this.spec.command, args: [...this.spec.args, ...(method.args ?? [])], env: { ...this.spec.env, ...method.env } });
      void launch.exited.then((code) => {
        if (this.stopped) return;
        this.signedOut = code === 0 ? { state: "ok" } : { state: "missing", hint: "终端登录未成功，请重试" };
        this.credentialsChanged = code === 0;
        this.host?.authChanged?.(this.id);
      });
      return { terminalId: launch.terminalId };
    }
    await this.rpc(this.connection!.protocolVersion === 2 ? "auth/login" : "authenticate", { methodId }, 0);
    this.signedOut = { state: "ok" }; return {};
  }

  async providers(operation: "list" | "set" | "disable", config?: { providerId: string; apiType?: string; baseUrl?: string; headers?: Record<string, string> }): Promise<AcpProvider[]> {
    const { features } = await this.acpInfo();
    if (!features.providers) throw RpcError.app("not_supported", "这个 AI 不支持供应商配置");
    const list = async () => {
      const response = await this.rpc<{ providers: unknown[] }>("providers/list", {});
      return response.providers.map((provider) => acpProviderSchema.parse(provider));
    };
    if (operation === "list") return list();
    const provider = (await list()).find((entry) => entry.providerId === config?.providerId);
    if (!provider || !config) throw RpcError.app("invalid_params", "供应商不存在");
    if (operation === "disable" && provider.required) throw RpcError.app("invalid_params", "不能停用必需的供应商");
    if (operation === "set" && (!config.apiType || !provider.supported.includes(config.apiType) || !config.baseUrl)) throw RpcError.app("invalid_params", "供应商地址或协议无效");
    await this.rpc(`providers/${operation}`, operation === "disable" ? { providerId: config.providerId } : { ...config, headers: config.headers ?? {} });
    return list();
  }

  async respondInteraction(requestId: string, response: { optionId?: string; answers?: QuestionAnswer[] }): Promise<void> {
    const pending = this.interactions.get(requestId);
    if (!pending) throw RpcError.app("not_found", "这个请求已结束");
    if (response.answers) {
      const error = (pending.request.update.questions ?? []).map((question) => questionAnswerError(question, response.answers!.find((answer) => answer.id === question.id))).find(Boolean);
      if (error) throw RpcError.app("invalid_params", error);
      const result = pending.request.answer(response.answers);
      this.interactions.delete(requestId); pending.resolve(result);
      this.host?.interaction?.(this.id, { requestId, resolved: true });
    } else {
      if (!pending.request.update.options.some((option) => option.optionId === response.optionId)) throw RpcError.app("invalid_params", "选项已失效");
      this.resolveInteraction(requestId, response.optionId!);
    }
  }

  private resolveInteraction(requestId: string, optionId: string): void {
    const pending = this.interactions.get(requestId); if (!pending) return;
    this.interactions.delete(requestId); pending.resolve(pending.request.respond(optionId));
    this.host?.interaction?.(this.id, { requestId, resolved: true });
  }

  private async validateDirectories(settings: AcpAgentSettings): Promise<void> {
    for (const path of settings.additionalDirectories) {
      if (!isAbsolute(path) || !await stat(await realpath(path)).then((info) => info.isDirectory()).catch(() => false)) throw RpcError.app("invalid_params", `附加目录不存在或不是绝对路径：${path}`);
    }
    if (new Set(settings.mcpServers.map((server) => server.name)).size !== settings.mcpServers.length) throw RpcError.app("invalid_params", "MCP 服务名称不能重复");
  }

  private validateSessionSettings(settings: AcpAgentSettings): void {
    const caps = this.connection?.capabilities;
    if (settings.additionalDirectories.length && !caps?.sessionCapabilities?.additionalDirectories) throw RpcError.app("not_supported", "这个 AI 未声明支持附加目录");
    for (const server of settings.mcpServers) {
      if ((server.type === "http" || server.type === "sse") && !caps?.mcpCapabilities?.[server.type]) throw RpcError.app("not_supported", `这个 AI 不支持 ${server.type} MCP 服务`);
      if (server.type === "stdio" && this.connection?.protocolVersion === 2 && !caps?.mcpCapabilities?.stdio) throw RpcError.app("not_supported", "这个 AI 不支持 stdio MCP 服务");
      if (server.type === "acp" && !caps?.mcpCapabilities?.acp) throw RpcError.app("not_supported", "这个 AI 不支持通过 ACP 连接 MCP 服务");
    }
  }

  protected async sessionParameters(cwd: string, settings = this.settings()): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    await this.validateDirectories(settings); this.validateSessionSettings(settings);
    const v2 = this.connection?.protocolVersion === 2;
    return { cwd, mcpServers: settings.mcpServers.map((server) => {
      if (server.type === "stdio") return { ...(v2 ? { type: "stdio" } : {}), name: server.name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) };
      if (server.type === "acp") return { type: "acp", name: server.name, serverId: this.mcp.open(server, cwd) };
      return { type: server.type, name: server.name, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) };
    }), ...(settings.additionalDirectories.length ? { additionalDirectories: settings.additionalDirectories } : {}), ...this.sessionMeta() };
  }

  async listSessions(limit: number): Promise<DiscoveredSession[]> {
    if (!this.connection?.alive || !this.connection.capabilities.sessionCapabilities?.list) return [];
    const found: DiscoveredSession[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{ sessions?: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null; additionalDirectories?: string[] }[]; nextCursor?: string | null }>(
        "session/list",
        cursor ? { cursor } : {},
      );
      for (const info of page.sessions ?? []) {
        if (Array.isArray(info.additionalDirectories) && info.additionalDirectories.every((path) => typeof path === "string" && isAbsolute(path))) this.discoveredDirectories.set(info.sessionId, info.additionalDirectories);
        const updatedAt = info.updatedAt ? Date.parse(info.updatedAt) || Date.now() : Date.now();
        found.push({
          nativeId: info.sessionId, cwd: info.cwd, title: info.title ?? undefined, createdAt: updatedAt, updatedAt,
          state: await this.discoveredState(info.sessionId, info.cwd),
        });
        if (found.length >= limit) return found;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }

  /** ACP v1 does not include live state in session/list; only this connection's turns are known. */
  protected async discoveredState(nativeId: string, _cwd: string): Promise<SessionState> {
    return this.localState(nativeId);
  }

  protected localState(nativeId: string): SessionState {
    const state = this.sessions.get(nativeId);
    if (state?.permissions.size || state?.questions.size) return "waiting";
    for (const [id, child] of this.sessions) if ((child.permissions.size || child.questions.size) && this.isChildOf(id, nativeId)) return "waiting";
    return state?.reportedState ?? (state?.turnActive ? "running" : "idle");
  }

  /** ACP's session/fork, for agents that offer it: the whole conversation, in `cwd`. */
  async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    if (!this.connection?.alive) await this.ensureStarted();
    if (!this.connection?.capabilities.sessionCapabilities?.fork) throw RpcError.app("not_supported", `${this.label} 不支持从会话分叉`);
    if (options.upTo) throw RpcError.app("not_supported", `${this.label} 只能分叉整个会话`);
    const settings = this.sessions.get(nativeId)?.settings ?? this.settings();
    const response = await this.rpc<{ sessionId: string }>("session/fork", { sessionId: nativeId, ...await this.sessionParameters(options.cwd, settings) });
    this.stateFor(response.sessionId, options.cwd).settings = settings;
    const now = Date.now();
    return { nativeId: response.sessionId, cwd: options.cwd, createdAt: now, updatedAt: now };
  }

  protected sessionMeta(): Record<string, unknown> {
    // Raw Goal messages preserve the normal sub-agent stream. AIR opt-in changes
    // parentToolUseId/toolName metadata and is incompatible with our mapper.
    if (this.id === "grok") return { _meta: { askUserQuestion: true } };
    return this.id === "claude" ? { _meta: { claudeCode: { emitRawSDKMessages: [{ type: "active_goal" }] } } } : {};
  }

  async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    await this.ensureStarted();
    if (this.connection?.capabilities.sessions === false) throw RpcError.app("not_supported", "这个 ACP Agent 不支持会话，可在文件中使用编辑建议");
    let response: { sessionId: string } & Record<string, unknown>;
    try {
      response = await this.rpc<{ sessionId: string } & Record<string, unknown>>("session/new", {
        ...await this.sessionParameters(options.cwd),
      });
    } catch (error) {
      throw this.signInError(error);
    }
    this.signedOut = undefined;
    const state = this.stateFor(response.sessionId, options.cwd);
    state.loaded = true;
    state.config = toConfigOptions(response);
    this.sessionCommands(state, response);
    if (options.model) await this.setConfig(response.sessionId, "model", options.model).catch(() => {});
    const now = Date.now();
    return { nativeId: response.sessionId, cwd: options.cwd, createdAt: now, updatedAt: now, state: "idle" };
  }

  async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    // Lazy agents have no capabilities until initialize has completed.
    await this.ensureStarted();
    if (!this.connection?.alive) throw RpcError.app("agent_unavailable", this.current.problem ?? `${this.label} 尚未启动`);
    const state = this.stateFor(nativeId, context.cwd);
    if (state.loaded) {
      this.emitConfig(nativeId, state);
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: this.localState(nativeId), turnActive: state.turnActive });
      return [];
    }
    const capabilities = this.connection?.capabilities;
    let history: HistoryItem[] = [];
    state.config = []; state.commands = undefined;
    if (capabilities?.loadSession || this.connection.protocolVersion === 2) {
      state.replaying = [];
      state.updates = new AcpUpdates();
      try {
        const response = await this.rpc<Record<string, unknown>>(this.connection.protocolVersion === 2 ? "session/resume" : "session/load", {
          sessionId: nativeId,
          ...await this.sessionParameters(context.cwd, state.settings),
          ...(this.connection.protocolVersion === 2 ? { replayFrom: { type: "start" } } : {}),
        });
        if (response.configOptions !== undefined || response.modes !== undefined || response.models !== undefined) state.config = this.mergeConfig(state, toConfigOptions(response));
        this.sessionCommands(state, response);
        state.tracker = new AcpItemTracker();
        const unfinished: SessionUpdate[] = [];
        history = toHistory(state.replaying, state.tracker, undefined, unfinished);
        if (unfinished.length) history.push({ itemId: `acp:snapshot:${createHash("sha256").update(JSON.stringify(unfinished)).digest("hex")}`, updates: unfinished });
      } finally {
        state.replaying = undefined;
      }
    } else if (capabilities?.sessionCapabilities?.resume) {
      const response = await this.rpc<Record<string, unknown>>("session/resume", {
        sessionId: nativeId,
        ...await this.sessionParameters(context.cwd, state.settings),
      });
      state.config = toConfigOptions(response);
      this.sessionCommands(state, response);
      history.push({
        itemId: "linkshell:acp-history-unavailable",
        updates: [{
          sessionUpdate: "ls_notice", level: "info", title: "这个 AI 暂不提供以往消息",
          detail: "会话已恢复；这里只显示 LinkShell 已缓存的内容和之后的新消息。",
        }],
      });
    } else {
      throw RpcError.app("not_supported", `${this.label} 当前版本不支持恢复以往会话；已缓存的消息仍可查看。`);
    }
    state.loaded = true;
    this.emitConfig(nativeId, state);
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: this.localState(nativeId), turnActive: state.turnActive });
    return history;
  }

  async detach(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (!state?.loaded) return;
    state.loaded = false;
    this.cancelPermissions(state);
    await this.services.close(nativeId);
    await this.mcp.close(nativeId);
    for (const key of this.terminalCalls.keys()) if (key.startsWith(`${nativeId}\n`)) this.terminalCalls.delete(key);
    if (this.connection?.capabilities.sessionCapabilities?.close) {
      await this.rpc("session/close", { sessionId: nativeId }).catch(() => {});
    }
  }

  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string, context?: string): Promise<"started" | "steered" | "queued"> {
    const state = this.sessions.get(nativeId);
    if (!state?.loaded) throw RpcError.app("not_ready", "session is not open");
    if (state.reportedState === "unknown") throw RpcError.app("not_ready", "Agent 尚未确认当前执行状态，请刷新会话或停止后重试");
    for (const block of content) {
      if (block.type === "image" && !this.capabilities.images || block.type === "audio" && !this.capabilities.audio || block.type === "resource" && !this.capabilities.embeddedContext) throw RpcError.app("not_supported", `${this.label} 未声明支持这种附件`);
    }
    const prompt = toAcpPrompt(content);
    if (prompt.length === 0) throw RpcError.app("invalid_params", "nothing to send");
    if (state.turnActive) {
      if (this.capabilities.steer) {
        this.echoUserMessage(nativeId, content, clientMessageId);
        void this.sendPrompt(nativeId, state, withContext(prompt, context), clientMessageId);
        return "steered";
      }
      state.queue.push({ content, clientMessageId, context });
      this.reportQueue(nativeId, state);
      return "queued";
    }
    this.startTurn(nativeId, state, content, clientMessageId, context);
    return "started";
  }

  async cancel(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (!state) return;
    // Stopping stops what's waiting too; the apps put queued text back in the composer.
    state.queue = [];
    this.reportQueue(nativeId, state);
    this.cancelPermissions(state);
    this.connection?.notify("session/cancel", { sessionId: nativeId });
  }

  async cancelSubagent(nativeId: string, childId: string): Promise<void> {
    const permitted = [...this.children.get(childId)?.entries() ?? []].some(([parent, association]) => association.canCancel && (parent === nativeId || this.isChildOf(parent, nativeId)));
    if (!permitted) throw RpcError.app("not_supported", "这个子代理未允许单独停止");
    this.connection?.notify("session/cancel", { sessionId: childId });
  }

  /** Stops the running turn only: the first queued message starts as soon as it has ended. */
  async sendQueuedNow(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (!state?.turnActive || state.queue.length === 0) return;
    this.cancelPermissions(state);
    this.connection?.notify("session/cancel", { sessionId: nativeId });
  }

  async respondPermission(nativeId: string, requestId: string, optionId: string): Promise<void> {
    const owner = this.requestOwner(nativeId, requestId);
    const question = owner?.state.questions.get(requestId);
    if (question) {
      // Not answering: skip (the agent goes on without an answer) or stop.
      owner!.state.questions.delete(requestId);
      question.resolve(question.request.respond(optionId));
      this.publish(owner!.id, { sessionUpdate: "ls_permission_resolved", requestId, optionId });
      return;
    }
    const pending = owner?.state.permissions.get(requestId);
    if (!pending) throw RpcError.app("not_found", "this permission request is no longer pending");
    owner!.state.permissions.delete(requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    this.publish(owner!.id, { sessionUpdate: "ls_permission_resolved", requestId, optionId });
  }

  async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    const option = state?.config.find((entry) => entry.id === optionId);
    if (!state || !option) throw RpcError.app("not_found", `unknown setting ${optionId}`);
    if (!option.values.some((entry) => entry.value === value)) throw RpcError.app("invalid_params", `unknown value ${value}`);
    // Modes and legacy model lists predate configOptions and have their own methods.
    if (option.source === "modes") {
      await this.rpc("session/set_mode", { sessionId: nativeId, modeId: value });
    } else if (option.source === "models") {
      await this.rpc("session/set_model", { sessionId: nativeId, modelId: value });
    } else {
      const response = await this.rpc<Record<string, unknown>>("session/set_config_option", {
        sessionId: nativeId, configId: optionId, ...(option.type === "boolean" ? { type: "boolean", value: value === "on" } : { ...(this.connection?.protocolVersion === 2 ? { type: "select" } : {}), value }),
      });
      if (Array.isArray(response.configOptions)) {
        state.config = this.mergeConfig(state, toConfigOptions(response));
        this.emitConfig(nativeId, state);
        return;
      }
    }
    option.current = value;
    this.emitConfig(nativeId, state);
  }

  // ── internals ──────────────────────────────────────────────────────

  protected async detectVersion(): Promise<string | undefined> {
    if (this.spec.transport === "http" || this.spec.transport === "websocket") return "remote";
    if (this.spec.transport === "stdio") return "";
    const probe = this.spec.version ?? { command: this.spec.command, args: ["--version"] };
    try {
      const { stdout, stderr } = await execFileAsync(probe.command, probe.args, { env: this.env, timeout: 15_000 });
      const text = `${stdout}\n${stderr}`.trim();
      // "GitHub Copilot CLI 1.0.22." → "1.0.22"
      return text.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/)?.[0]?.replace(/[.-]+$/, "") ?? "";
    } catch {
      return undefined;
    }
  }

  private booting?: Promise<void>;

  /** Starts the agent process once; concurrent callers share the attempt. */
  protected ensureStarted(): Promise<void> {
    const refresh = this.credentialsChanged && ![...this.sessions.values()].some((state) => state.turnActive);
    if (this.connection?.alive && !refresh) return Promise.resolve();
    this.booting ??= (async () => {
      if (refresh) {
        this.credentialsChanged = false;
        await this.connection?.stop(); this.connection = undefined;
        for (const [id, state] of this.sessions) { state.loaded = false; this.host?.detached(this.id, id); }
      }
      await this.boot();
    })().finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }

  protected async boot(): Promise<void> {
    const settings = this.settings();
    const remote = this.spec.transport === "http" || this.spec.transport === "websocket";
    const headers: Record<string, string> = {};
    for (const [key, name] of Object.entries(this.spec.headerEnv ?? {})) {
      const value = this.env[name];
      if (value) headers[key] = value;
    }
    const connection = new AcpConnection({
      command: this.spec.command,
      args: this.spec.args,
      env: this.env,
      protocolVersion: settings.protocolVersion,
      experimental: settings.experimental,
      transport: remote ? { type: this.spec.transport as "http" | "websocket", url: this.spec.url!, headers } : undefined,
      clientVersion: this.options.hostVersion,
      onUpdate: (sessionId, update) => this.onUpdate(sessionId, update),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onCancelRequest: (id) => this.cancelQuestionRequest(id),
      onNotification: (method, params) => {
        if (method !== "elicitation/complete") return;
        const id = (params as { elicitationId?: string })?.elicitationId;
        if (!id) return;
        for (const [requestId, pending] of this.interactions) if (pending.request.update.url?.elicitationId === id) this.resolveInteraction(requestId, "cancel");
        for (const [sessionId, state] of this.sessions) for (const [requestId, pending] of state.questions) {
          if (pending.request.update.url?.elicitationId !== id) continue;
          state.questions.delete(requestId); pending.resolve(pending.request.respond("cancel"));
          this.host?.update(this.id, sessionId, { sessionUpdate: "ls_permission_resolved", requestId });
        }
      },
      onExit: (reason) => this.onExit(reason),
    });
    this.connection = connection;
    try {
      const init = await connection.start();
      const caps = init.agentCapabilities ?? {};
      const meta = { ...(caps._meta ?? {}), ...(init._meta ?? {}) } as Record<string, unknown>;
      const steering = (meta.steering as { supported?: boolean } | undefined)?.supported === true;
      const queueing = (meta.claudeCode as { promptQueueing?: boolean } | undefined)?.promptQueueing === true;
      this.capabilities = {
        ...this.capabilities,
        steer: steering || queueing,
        images: caps.promptCapabilities?.image === true,
        audio: caps.promptCapabilities?.audio === true,
        embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        fork: Boolean(caps.sessionCapabilities?.fork),
      };
      this.current = { installed: true, version: this.current.version };
      this.restartDelay = 1000;
    } catch (error) {
      await connection.stop();
      this.current = {
        installed: true,
        version: this.current.version,
        problem: `${this.label} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      };
      if (!(error instanceof AcpProtocolError)) this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.connection?.stop().finally(() => {
        if (!this.stopped) void this.boot();
      });
    }, delay);
  }

  private onExit(reason: string): void {
    if (this.stopped) return;
    this.host?.log(`[${this.id}] ${reason}`);
    for (const controller of this.serviceRequests.values()) controller.abort();
    this.serviceRequests.clear(); this.terminalCalls.clear();
    void this.services.close();
    void this.mcp.close();
    void this.edits.close();
    for (const id of [...this.interactions.keys()]) this.resolveInteraction(id, "cancel");
    for (const [nativeId, state] of this.sessions) {
      if (!state.loaded) continue;
      state.loaded = false;
      this.cancelPermissions(state);
      if (state.turnActive) {
        state.turnActive = false;
        this.emit(nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "error" });
      }
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "offline" });
      this.host?.detached(this.id, nativeId);
    }
    this.current = { installed: true, version: this.current.version, problem: `${this.label} restarting` };
    this.scheduleRestart();
  }

  protected stateFor(nativeId: string, cwd: string): AcpSessionState {
    let state = this.sessions.get(nativeId);
    if (!state) {
      const saved = this.host?.state(this.id, nativeId).get("acp-settings");
      state = {
        cwd,
        settings: saved ? acpAgentSettingsSchema.parse(JSON.parse(saved)) : { ...this.settings(), ...(this.discoveredDirectories.has(nativeId) ? { additionalDirectories: this.discoveredDirectories.get(nativeId)! } : {}) },
        loaded: false,
        tracker: new AcpItemTracker(),
        updates: new AcpUpdates(),
        messageAliases: new Map(JSON.parse(this.host?.state(this.id, nativeId).get("acp-message-aliases") ?? "[]") as [string, string][]),
        deferredUserUpdates: [],
        config: [],
        turnActive: false,
        inflight: 0,
        queue: [],
        permissions: new Map(),
        questions: new Map(),
        toolCalls: new Set(),
      };
      this.sessions.set(nativeId, state);
    }
    return state;
  }

  protected emitConfig(nativeId: string, state: AcpSessionState): void {
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "ls_config",
      options: state.config.map(({ source: _source, ...option }) => option),
    });
    if (state.commands) this.host?.update(this.id, nativeId, state.commands);
  }

  private sessionCommands(state: AcpSessionState, response: unknown): void {
    const commands = (response as { availableCommands?: unknown }).availableCommands;
    if (!Array.isArray(commands)) return;
    const update = normalizeAcpUpdate({ sessionUpdate: "available_commands_update", availableCommands: commands });
    if (update?.sessionUpdate === "available_commands_update") state.commands = update;
  }

  private mergeConfig(state: AcpSessionState, options: SourcedConfigOption[]): SourcedConfigOption[] {
    return [...options, ...state.config.filter((option) => option.source !== "configOptions" && !options.some((next) => next.id === option.id || next.category === option.category))];
  }

  /** Feeds an update through the item tracker and on to the host. */
  protected emit(nativeId: string, update: SessionUpdate): void {
    const state = this.sessions.get(nativeId);
    const tracked = state ? state.tracker.feed(update) : [{ update }];
    for (const entry of tracked) this.publish(nativeId, entry.update, entry.itemId);
  }

  protected closeMessage(nativeId: string): void {
    const state = this.sessions.get(nativeId);
    if (!state) return;
    for (const entry of state.tracker.close()) this.publish(nativeId, entry.update, entry.itemId);
  }

  /** Child streams reuse the existing nested timeline and never overwrite the parent's settings or status. */
  private publish(nativeId: string, update: SessionUpdate, itemId?: string): void {
    const parents = this.children.get(nativeId);
    if (!parents?.size) { this.host?.update(this.id, nativeId, update, itemId); return; }
    if (["ls_status", "ls_config", "session_info_update", "usage_update", "available_commands_update", "current_mode_update", "ls_goal", "plan"].includes(update.sessionUpdate)) return;
    const prefix = `acp:${encodeURIComponent(nativeId)}:`;
    for (const [parent, association] of parents) {
      const mapped: SessionUpdate = update.sessionUpdate === "user_message_chunk"
        ? { sessionUpdate: "ls_message", messageId: update.messageId ?? "prompt", role: "user", content: [update.content], append: true }
        : { ...update };
      if ("messageId" in mapped && mapped.messageId) mapped.messageId = prefix + mapped.messageId;
      if ("toolCallId" in mapped && mapped.toolCallId) mapped.toolCallId = prefix + mapped.toolCallId;
      if (["agent_message_chunk", "agent_thought_chunk", "ls_message", "ls_message_done", "tool_call", "tool_call_update", "ls_turn"].includes(mapped.sessionUpdate)) {
        (mapped as { parentToolCallId?: string }).parentToolCallId = "parentToolCallId" in update && update.parentToolCallId ? prefix + update.parentToolCallId : this.childCallId(nativeId);
      }
      if (mapped.sessionUpdate === "ls_permission") { mapped.title = `${association.title ?? "子代理"} · ${mapped.title}`; mapped.childSessionId ??= nativeId; }
      this.onMappedUpdate(parent, mapped);
    }
  }

  private childCallId(id: string): string { return `acp:subagent:${encodeURIComponent(id)}`; }

  private subagentUpdate(parent: string, raw: unknown): void {
    const update = raw as { sessionId?: unknown; title?: string | null; description?: string | null; capabilities?: { cancel?: unknown } | null; state?: unknown };
    const childId = update.sessionId;
    if (typeof childId !== "string" || childId === parent || this.isChildOf(parent, childId)) return;
    const parentState = this.sessions.get(parent); if (!parentState) return;
    const parents = this.children.get(childId) ?? new Map();
    const created = !parents.has(parent);
    const association = parents.get(parent) ?? { canCancel: false };
    if (update.title !== undefined) association.title = update.title ?? undefined;
    if (update.description !== undefined) association.description = update.description ?? undefined;
    if (update.capabilities !== undefined) association.canCancel = !!update.capabilities?.cancel;
    if (update.state !== undefined) association.state = update.state;
    parents.set(parent, association); this.children.set(childId, parents);
    const child = this.stateFor(childId, parentState.cwd); child.loaded = true; child.settings = parentState.settings;
    const status = association.state as { state?: string; stopReason?: string } | null | undefined;
    const state: WorkflowAgentState = status?.state === "running" ? "running" : status?.state === "requires_action" ? "paused" : status?.state === "idle"
      ? status.stopReason === "cancelled" ? "stopped" : status.stopReason === "error" ? "failed" : status.stopReason ? "completed" : "unknown" : "unknown";
    const call = {
      toolCallId: this.childCallId(childId), title: association.title ?? "子代理", kind: "other" as const,
      status: state === "failed" || state === "stopped" ? "failed" as const : state === "completed" ? "completed" as const : "in_progress" as const,
      detail: { type: "subagent" as const, action: "spawn" as const, name: association.title, task: association.description, nativeSessionId: childId, canCancel: association.canCancel, state },
    };
    this.onMappedUpdate(parent, { sessionUpdate: created ? "tool_call" : "tool_call_update", ...call });
  }

  private isChildOf(child: string, parent: string, seen = new Set<string>()): boolean {
    if (seen.has(child)) return false; seen.add(child);
    const parents = this.children.get(child);
    return !!parents && (parents.has(parent) || [...parents.keys()].some((id) => this.isChildOf(id, parent, seen)));
  }

  private requestOwner(nativeId: string, requestId: string): { id: string; state: AcpSessionState } | undefined {
    for (const [id, state] of this.sessions) if ((id === nativeId || this.isChildOf(id, nativeId)) && (state.permissions.has(requestId) || state.questions.has(requestId))) return { id, state };
    return undefined;
  }

  protected onUpdate(sessionId: string, raw: unknown): void {
    const record = raw as { sessionUpdate?: string; severity?: unknown; title?: unknown; description?: unknown } | undefined;
    if (record?.sessionUpdate === "notice") {
      if (!this.sessions.get(sessionId)?.replaying && typeof record.title === "string" && typeof record.severity === "string") {
        const roots = (id: string): string[] => this.children.has(id) ? [...this.children.get(id)!.keys()].flatMap(roots) : [id];
        for (const root of new Set(roots(sessionId))) this.host?.notice?.(this.id, root, { severity: record.severity, title: record.title, description: typeof record.description === "string" ? record.description : undefined });
      }
      return;
    }
    const state = this.sessions.get(sessionId);
    if (record?.sessionUpdate === "subagent_update" && this.settings().experimental) { this.subagentUpdate(sessionId, raw); return; }
    const version = this.connection?.protocolVersion ?? 1;
    if (version === 2 && state && record?.sessionUpdate === "state_update") {
      const status = raw as { state: string; stopReason?: string; usage?: unknown; message?: string };
      for (const parent of this.children.get(sessionId)?.keys() ?? []) this.subagentUpdate(parent, { sessionId, state: status });
      state.reportedState = status.state === "running" ? "running" : status.state === "requires_action" ? "waiting" : status.state === "idle" ? "idle" : "unknown";
      if (status.state === "running" || status.state === "requires_action") {
        if (!state.turnActive && !state.replaying) this.emit(sessionId, { sessionUpdate: "ls_turn", state: "started" });
        state.turnActive = true; state.idleReason = undefined;
      } else if (status.state === "idle") {
        if (state.replaying) state.turnActive = false;
        else if (state.turnActive) {
          state.idleReason = toStopReason(status.stopReason);
          if (!state.inflight) this.finishTurn(sessionId, state, state.idleReason);
        }
      }
      const usage = status.usage ? usageUpdate(status.usage) : undefined;
      if (usage) this.onMappedUpdate(sessionId, usage);
      if (!state.replaying && !this.children.has(sessionId)) this.host?.update(this.id, sessionId, { sessionUpdate: "ls_status", state: this.localState(sessionId), turnActive: state.turnActive });
      return;
    }
    if (version === 2 && state && record?.sessionUpdate === "user_message" && state.inflight > 0 && !state.replaying) {
      state.deferredUserUpdates.push(raw); return;
    }
    const remapped = version === 2 && raw && typeof raw === "object" && "messageId" in raw && typeof raw.messageId === "string"
      ? { ...raw, messageId: state?.messageAliases.get(raw.messageId) ?? raw.messageId } : raw;
    for (const update of state?.updates.map(remapped, version) ?? [normalizeAcpUpdate(remapped)].filter((entry): entry is SessionUpdate => !!entry)) this.onMappedUpdate(sessionId, update);
  }

  private onMappedUpdate(sessionId: string, update: SessionUpdate): void {
    const state = this.sessions.get(sessionId);
    if (state?.turnActive && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) state.toolCalls.add(update.toolCallId);
    if (update.sessionUpdate === "current_mode_update" && state) {
      const mode = state.config.find((option) => option.category === "mode");
      if (mode) mode.current = update.currentModeId;
    }
    if (update.sessionUpdate === "ls_config" && state) {
      state.config = this.mergeConfig(state, update.options.map((option) => ({ ...option, source: "configOptions" as const })));
      update = { ...update, options: state.config.map(({ source: _source, ...option }) => option) };
    }
    if (update.sessionUpdate === "available_commands_update" && state) state.commands = update;
    if (state?.replaying) { state.replaying.push(update); return; }
    this.emit(sessionId, update);
    if (this.connection?.protocolVersion !== 2 && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
      for (const content of update.content ?? []) {
        if (content.type !== "terminal") continue;
        const key = `${sessionId}\n${content.terminalId}`;
        const calls = this.terminalCalls.get(key) ?? new Set<string>();
        if (!calls.has(update.toolCallId)) {
          calls.add(update.toolCallId); this.terminalCalls.set(key, calls);
          const snapshot = this.services.output(sessionId, content.terminalId);
          if (snapshot) this.emit(sessionId, { sessionUpdate: "tool_call_update", toolCallId: update.toolCallId, replaceOutput: snapshot.output });
        }
      }
    }
  }

  private onRequest(method: string, params: unknown, id: RpcId): unknown {
    if (method === "mcp/message") {
      const controller = new AbortController(); this.serviceRequests.set(id, controller);
      return this.mcp.request(params, controller.signal).finally(() => this.serviceRequests.delete(id));
    }
    if (method.startsWith("fs/") || method.startsWith("terminal/")) {
      const controller = new AbortController(); this.serviceRequests.set(id, controller);
      return this.services.request(method, params, controller.signal).finally(() => this.serviceRequests.delete(id));
    }
    if (questionMethod(this.id, method)) return this.onQuestions(method, params, id);
    if (method !== "session/request_permission") {
      throw new RpcError(-32601, `LinkShell does not implement ${method}`);
    }
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    const state = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    const requestId = `${this.id}-${this.nextPermissionId++}-${String(id)}`;
    const mapped = mapPermissionRequest(params, requestId);
    if (!state || !mapped) return { outcome: { outcome: "cancelled" } };
    return new Promise((resolve) => {
      state.permissions.set(requestId, { rpcId: id, resolve });
      this.closeMessage(sessionId as string);
      this.publish(sessionId as string, mapped.update);
    });
  }

  /** Questions are routed by explicit session id, then Cursor's tool id, never a "last session". */
  private questionSession(params: unknown): string {
    const request = params as { sessionId?: unknown; toolCallId?: unknown } | undefined;
    if (!request || typeof request !== "object") throw new RpcError(-32602, "提问缺少会话信息");
    const matches = [...this.sessions].filter(([, state]) => state.turnActive && typeof request.toolCallId === "string" && state.toolCalls.has(request.toolCallId));
    if (request.sessionId !== undefined) {
      if (typeof request.sessionId === "string" && this.sessions.has(request.sessionId)) return request.sessionId;
      throw new RpcError(-32602, "提问的会话信息不匹配");
    }
    if (this.id === "cursor") {
      if (matches.length === 1) return matches[0]![0];
      const active = [...this.sessions].filter(([, state]) => state.turnActive);
      if (matches.length === 0 && active.length === 1) return active[0]![0];
    }
    throw new RpcError(-32602, "无法确定这个问题属于哪个会话，未提交任何回答");
  }

  private onQuestions(method: string, params: unknown, id: RpcId): unknown {
    const scope = params as { sessionId?: unknown; requestId?: unknown };
    if (method === "elicitation/create" && scope.sessionId === undefined && (typeof scope.requestId === "string" || typeof scope.requestId === "number")) {
      if (!this.connection?.hasPendingRequest(scope.requestId)) throw new RpcError(-32602, "授权请求已经结束");
      const requestId = `${this.id}-q${this.nextPermissionId++}-${String(id)}`;
      const request = mapAcpQuestions(this.id, method, params, requestId);
      return new Promise((resolve) => {
        this.interactions.set(requestId, { rpcId: id, parentId: scope.requestId as RpcId, request, resolve });
        this.host?.interaction?.(this.id, request.update);
      });
    }
    const sessionId = this.questionSession(params);
    const state = this.sessions.get(sessionId)!;
    const requestId = `${this.id}-q${this.nextPermissionId++}-${String(id)}`;
    const request = mapAcpQuestions(this.id, method, params, requestId);
    return new Promise((resolve) => {
      state.questions.set(requestId, { rpcId: id, request, resolve });
      this.closeMessage(sessionId);
      this.publish(sessionId, request.update);
    });
  }

  private cancelQuestionRequest(id: RpcId): void {
    this.serviceRequests.get(id)?.abort();
    for (const [requestId, pending] of this.interactions) if (pending.rpcId === id) this.resolveInteraction(requestId, "cancel");
    for (const [sessionId, state] of this.sessions) {
      for (const [requestId, pending] of state.permissions) {
        if (pending.rpcId !== id) continue;
        state.permissions.delete(requestId);
        pending.resolve({ outcome: { outcome: "cancelled" } });
        this.publish(sessionId, { sessionUpdate: "ls_permission_resolved", requestId });
      }
      for (const [requestId, pending] of state.questions) {
        if (pending.rpcId !== id) continue;
        state.questions.delete(requestId);
        pending.resolve(pending.request.respond("cancel"));
        this.publish(sessionId, { sessionUpdate: "ls_permission_resolved", requestId });
      }
    }
  }

  async answerQuestion(nativeId: string, requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const owner = this.requestOwner(nativeId, requestId);
    const state = owner?.state;
    const pending = state?.questions.get(requestId);
    if (!state || !pending) throw RpcError.app("not_found", "这个问题已经不在等回答了");
    const response = pending.request.answer(answers);
    state.questions.delete(requestId);
    pending.resolve(response);
    const recorded = answers.map((answer) => pending.request.update.questions?.find((question) => question.id === answer.id)?.secret ? { id: answer.id, values: ["••••••"] } : answer);
    this.publish(owner!.id, { sessionUpdate: "ls_permission_resolved", requestId, optionId: "answered", answers: recorded });
  }

  private cancelPermissions(state: AcpSessionState): void {
    const nativeId = [...this.sessions].find(([, value]) => value === state)?.[0];
    if (nativeId) for (const requestId of [...state.permissions.keys(), ...state.questions.keys()]) this.publish(nativeId, { sessionUpdate: "ls_permission_resolved", requestId });
    for (const pending of state.permissions.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
    state.permissions.clear();
    for (const pending of state.questions.values()) pending.resolve(pending.request.respond("cancel"));
    state.questions.clear();
  }

  private echoUserMessage(nativeId: string, content: ContentBlock[], clientMessageId: string): void {
    // ACP agents don't echo the prompt back; record it ourselves.
    this.closeMessage(nativeId);
    for (const block of content) {
      this.emit(nativeId, { sessionUpdate: "user_message_chunk", messageId: `local-${clientMessageId}`, content: block });
    }
    this.closeMessage(nativeId);
  }

  protected startTurn(nativeId: string, state: AcpSessionState, content: ContentBlock[], clientMessageId: string, context?: string): void {
    state.turnActive = true;
    state.reportedState = undefined; state.idleReason = undefined;
    this.echoUserMessage(nativeId, content, clientMessageId);
    this.emit(nativeId, { sessionUpdate: "ls_turn", state: "started" });
    void this.sendPrompt(nativeId, state, withContext(toAcpPrompt(content), context), clientMessageId);
  }

  private async sendPrompt(nativeId: string, state: AcpSessionState, prompt: Record<string, unknown>[], clientMessageId: string): Promise<void> {
    state.inflight += 1;
    let stopReason: StopReason | undefined;
    try {
      const result = await this.rpc<{ stopReason?: unknown; messageId?: string; usage?: unknown }>("session/prompt", { sessionId: nativeId, prompt }, 0);
      if (this.connection?.protocolVersion === 2) {
        if (typeof result.messageId !== "string") throw new Error("ACP 2 未返回已接收的消息 ID");
        state.messageAliases.set(result.messageId, `local-${clientMessageId}`);
        this.host?.state(this.id, nativeId).set("acp-message-aliases", JSON.stringify([...state.messageAliases]));
      } else stopReason = toStopReason(result.stopReason);
      const usage = result.usage ? usageUpdate(result.usage) : undefined;
      if (usage) this.emit(nativeId, usage);
    } catch (error) {
      stopReason = "error";
      const described = describeAgentError(this.label, error instanceof Error ? error.message : String(error));
      this.closeMessage(nativeId);
      this.emit(nativeId, { sessionUpdate: "ls_error", code: "turn_failed", message: described.message, hint: described.hint });
    }
    state.inflight -= 1;
    // A steered prompt settles the earlier one; the turn ends with the last.
    if (state.inflight > 0) return;
    for (const raw of state.deferredUserUpdates.splice(0)) this.onUpdate(nativeId, raw);
    const ended = stopReason ?? state.idleReason;
    if (ended) this.finishTurn(nativeId, state, ended);
  }

  private finishTurn(nativeId: string, state: AcpSessionState, stopReason: StopReason): void {
    if (!state.turnActive) return;
    this.closeMessage(nativeId);
    state.turnActive = false;
    state.reportedState = stopReason === "error" ? "error" : "idle";
    state.idleReason = undefined;
    state.toolCalls.clear();
    this.cancelPermissions(state);
    this.emit(nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason });
    const next = state.queue.shift();
    if (next) this.reportQueue(nativeId, state);
    if (next && state.loaded) this.startTurn(nativeId, state, next.content, next.clientMessageId, next.context);
  }

  protected settings(): AcpAgentSettings {
    return this.host?.agentSettings?.(this.id) ?? this.spec.settings ?? acpAgentSettingsSchema.parse({});
  }

  /** The agent's own delete, when it has one (ACP session/delete). */
  async delete(nativeId: string): Promise<void> {
    if (!this.connection?.alive) await this.ensureStarted();
    if (this.connection?.capabilities.sessionCapabilities?.delete) await this.rpc("session/delete", { sessionId: nativeId });
    this.sessions.delete(nativeId);
  }

  /** ACP's auth_required, said the way the app says it for Claude and Codex. */
  private signInError(error: unknown): unknown {
    // -32000 is also LinkShell's own application error (which carries an app code).
    const agentAuth = error instanceof RpcError && error.code === -32000 && !error.appCode;
    const message = error instanceof Error ? error.message : String(error);
    if (!agentAuth && !/auth(entication)? required|not (logged|signed) in/i.test(message)) return error;
    const hint = `${this.label} 未登录：在电脑终端运行 ${this.spec.command} 并登录`;
    this.signedOut = { state: "missing", hint };
    return RpcError.app("not_logged_in", `${hint}，然后再试。`);
  }

  unqueue(nativeId: string, clientMessageId: string): boolean {
    const state = this.sessions.get(nativeId);
    const index = state?.queue.findIndex((entry) => entry.clientMessageId === clientMessageId) ?? -1;
    if (!state || index < 0) return false;
    state.queue.splice(index, 1);
    this.reportQueue(nativeId, state);
    return true;
  }

  reorderQueue(nativeId: string, clientMessageIds: string[]): void {
    const state = this.sessions.get(nativeId);
    if (!state) return;
    state.queue = inOrder(state.queue, clientMessageIds);
    this.reportQueue(nativeId, state);
  }

  private reportQueue(nativeId: string, state: { queue: PendingPrompt[] }): void {
    this.host?.queue(
      this.id,
      nativeId,
      state.queue.map((entry) => ({
        clientMessageId: entry.clientMessageId,
        text: entry.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim(),
        images: entry.content.filter((block) => block.type === "image").length,
      })),
    );
  }

  protected async rpc<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.stopped && this.current.installed) await this.ensureStarted();
    if (!this.connection?.alive) {
      throw RpcError.app("agent_unavailable", this.current.problem ?? `${this.label} is not running`);
    }
    const connection = this.connection;
    const opensSession = ["session/new", "session/load", "session/resume", "session/fork"].includes(method);
    const serverIds = opensSession ? ((params as { mcpServers?: { type?: string; serverId?: string }[] }).mcpServers ?? []).flatMap((server) => server.type === "acp" && server.serverId ? [server.serverId] : []) : [];
    let succeeded = false;
    const bindServers = (result: T) => {
      succeeded = true;
      const sessionId = (result as { sessionId?: string })?.sessionId ?? (params as { sessionId?: string }).sessionId;
      if (sessionId) this.mcp.bind(serverIds, sessionId);
      return result;
    };
    try {
      const result = await connection.request<T>(method, params, timeoutMs);
      if (opensSession) this.signedOut = undefined;
      return bindServers(result);
    } catch (error) {
      if (!opensSession) throw error;
      const authRequired = error instanceof RpcError && error.code === -32000 && !error.appCode;
      const methodId = this.spec.cachedAuthMethod;
      if (!authRequired || !methodId || !connection.initializeResult.authMethods?.some((entry) => entry.id === methodId)) {
        throw this.signInError(error);
      }
      // A long-lived agent may predate the user's login. Ask it to reread its
      // own credentials; never choose an interactive sign-in method here.
      try {
        if (this.authenticating?.connection !== connection) {
          const attempt = { connection, promise: connection.request<void>("authenticate", { methodId }) };
          this.authenticating = attempt;
          void attempt.promise.finally(() => {
            if (this.authenticating === attempt) this.authenticating = undefined;
          }).catch(() => {});
        }
        await this.authenticating.promise;
        const result = await connection.request<T>(method, params, timeoutMs);
        this.signedOut = undefined;
        return bindServers(result);
      } catch (retryError) {
        throw this.signInError(retryError);
      }
    } finally {
      if (!succeeded && serverIds.length) await this.mcp.close(undefined, serverIds);
      for (const [requestId, pending] of this.interactions) if (!connection.hasPendingRequest(pending.parentId)) this.resolveInteraction(requestId, "cancel");
    }
  }
}
