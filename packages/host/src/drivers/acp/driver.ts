import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  RpcError,
  type AgentAuth,
  type AgentCapabilities,
  type AgentTier,
  type ContentBlock,
  type RpcId,
  type SessionUpdate,
  type StopReason,
  type QuestionAnswer,
} from "@linkshell/wire";
import type { AgentDriver, AttachContext, DiscoveredSession, DriverHost, DriverStatus, ForkOptions, HistoryItem } from "../types.js";
import { AcpConnection } from "./connection.js";
import { QUESTION_OPTIONS, formContent, formQuestions, type Form } from "../../questions.js";
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
  loaded: boolean;
  tracker: AcpItemTracker;
  config: SourcedConfigOption[];
  /** Set while a session/load replays history. */
  replaying?: SessionUpdate[];
  turnActive: boolean;
  /** session/prompt requests in flight; with steering, a turn spans several. */
  inflight: number;
  queue: PendingPrompt[];
  permissions: Map<string, (outcome: unknown) => void>;
  /** Questions waiting for an answer: the form each came as, and how it is answered. */
  questions: Map<string, { form: Form; resolve: (response: unknown) => void }>;
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

  constructor(
    protected readonly spec: AcpAgentSpec,
    protected readonly options: { env?: NodeJS.ProcessEnv; hostVersion: string },
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.tier = spec.tier;
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
    await this.connection?.stop();
    this.connection = undefined;
  }

  async listSessions(limit: number): Promise<DiscoveredSession[]> {
    if (!this.connection?.alive || !this.connection.capabilities.sessionCapabilities?.list) return [];
    const found: DiscoveredSession[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{ sessions?: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }[]; nextCursor?: string | null }>(
        "session/list",
        cursor ? { cursor } : {},
      );
      for (const info of page.sessions ?? []) {
        const updatedAt = info.updatedAt ? Date.parse(info.updatedAt) || Date.now() : Date.now();
        found.push({ nativeId: info.sessionId, cwd: info.cwd, title: info.title ?? undefined, createdAt: updatedAt, updatedAt });
        if (found.length >= limit) return found;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }

  /** ACP's session/fork, for agents that offer it: the whole conversation, in `cwd`. */
  async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    if (!this.connection?.alive) await this.ensureStarted();
    if (!this.connection?.capabilities.sessionCapabilities?.fork) throw RpcError.app("not_supported", `${this.label} 不支持从会话分叉`);
    if (options.upTo) throw RpcError.app("not_supported", `${this.label} 只能分叉整个会话`);
    const response = await this.rpc<{ sessionId: string }>("session/fork", { sessionId: nativeId, cwd: options.cwd, mcpServers: [] });
    const now = Date.now();
    return { nativeId: response.sessionId, cwd: options.cwd, createdAt: now, updatedAt: now };
  }

  protected sessionMeta(): Record<string, unknown> {
    // Raw Goal messages preserve the normal sub-agent stream. AIR opt-in changes
    // parentToolUseId/toolName metadata and is incompatible with our mapper.
    return this.id === "claude" ? { _meta: { claudeCode: { emitRawSDKMessages: [{ type: "active_goal" }] } } } : {};
  }

  async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    let response: { sessionId: string } & Record<string, unknown>;
    try {
      response = await this.rpc<{ sessionId: string } & Record<string, unknown>>("session/new", {
        cwd: options.cwd,
        mcpServers: [],
        ...this.sessionMeta(),
      });
    } catch (error) {
      throw this.signInError(error);
    }
    this.signedOut = undefined;
    const state = this.stateFor(response.sessionId, options.cwd);
    state.loaded = true;
    state.config = toConfigOptions(response);
    if (options.model) await this.setConfig(response.sessionId, "model", options.model).catch(() => {});
    const now = Date.now();
    return { nativeId: response.sessionId, cwd: options.cwd, createdAt: now, updatedAt: now, state: "idle" };
  }

  async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    const state = this.stateFor(nativeId, context.cwd);
    if (state.loaded) {
      this.emitConfig(nativeId, state);
      return [];
    }
    const capabilities = this.connection?.capabilities;
    let history: HistoryItem[] = [];
    if (capabilities?.loadSession) {
      state.replaying = [];
      try {
        const response = await this.rpc<Record<string, unknown>>("session/load", {
          sessionId: nativeId,
          cwd: context.cwd,
          mcpServers: [],
          ...this.sessionMeta(),
        });
        state.config = toConfigOptions(response);
        state.tracker = new AcpItemTracker();
        history = toHistory(state.replaying, state.tracker);
      } finally {
        state.replaying = undefined;
      }
    } else if (capabilities?.sessionCapabilities?.resume) {
      const response = await this.rpc<Record<string, unknown>>("session/resume", {
        sessionId: nativeId,
        cwd: context.cwd,
        mcpServers: [],
        ...this.sessionMeta(),
      });
      state.config = toConfigOptions(response);
    } else {
      throw RpcError.app("not_supported", `${this.label} can't reopen earlier sessions`);
    }
    state.loaded = true;
    this.emitConfig(nativeId, state);
    return history;
  }

  async detach(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (!state?.loaded) return;
    state.loaded = false;
    this.cancelPermissions(state);
    if (this.connection?.capabilities.sessionCapabilities?.close) {
      await this.rpc("session/close", { sessionId: nativeId }).catch(() => {});
    }
  }

  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string, context?: string): Promise<"started" | "steered" | "queued"> {
    const state = this.sessions.get(nativeId);
    if (!state?.loaded) throw RpcError.app("not_ready", "session is not open");
    const prompt = toAcpPrompt(content);
    if (prompt.length === 0) throw RpcError.app("invalid_params", "nothing to send");
    if (state.turnActive) {
      if (this.capabilities.steer) {
        this.echoUserMessage(nativeId, content, clientMessageId);
        void this.sendPrompt(nativeId, state, withContext(prompt, context));
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

  /** Stops the running turn only: the first queued message starts as soon as it has ended. */
  async sendQueuedNow(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (!state?.turnActive || state.queue.length === 0) return;
    this.cancelPermissions(state);
    this.connection?.notify("session/cancel", { sessionId: nativeId });
  }

  async respondPermission(nativeId: string, requestId: string, optionId: string): Promise<void> {
    const question = this.sessions.get(nativeId)?.questions.get(requestId);
    if (question) {
      // Not answering: skip (the agent goes on without an answer) or stop.
      this.sessions.get(nativeId)?.questions.delete(requestId);
      question.resolve({ action: optionId === "cancel" ? "cancel" : "decline" });
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_permission_resolved", requestId, optionId });
      return;
    }
    const resolve = this.sessions.get(nativeId)?.permissions.get(requestId);
    if (!resolve) throw RpcError.app("not_found", "this permission request is no longer pending");
    this.sessions.get(nativeId)?.permissions.delete(requestId);
    resolve({ outcome: { outcome: "selected", optionId } });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_permission_resolved", requestId, optionId });
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
      await this.rpc("session/set_config_option", { sessionId: nativeId, configId: optionId, value });
    }
    option.current = value;
    this.emitConfig(nativeId, state);
  }

  // ── internals ──────────────────────────────────────────────────────

  protected async detectVersion(): Promise<string | undefined> {
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
    if (this.connection?.alive) return Promise.resolve();
    this.booting ??= this.boot().finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }

  protected async boot(): Promise<void> {
    const connection = new AcpConnection({
      command: this.spec.command,
      args: this.spec.args,
      env: this.env,
      clientVersion: this.options.hostVersion,
      onUpdate: (sessionId, update) => this.onUpdate(sessionId, update),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
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
        fork: Boolean(caps.sessionCapabilities?.fork),
      };
      this.current = { installed: true, version: this.current.version };
      this.restartDelay = 1000;
    } catch (error) {
      this.current = {
        installed: true,
        version: this.current.version,
        problem: `${this.label} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.scheduleRestart();
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
      state = {
        cwd,
        loaded: false,
        tracker: new AcpItemTracker(),
        config: [],
        turnActive: false,
        inflight: 0,
        queue: [],
        permissions: new Map(),
        questions: new Map(),
      };
      this.sessions.set(nativeId, state);
    }
    return state;
  }

  protected emitConfig(nativeId: string, state: AcpSessionState): void {
    if (state.config.length === 0) return;
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "ls_config",
      options: state.config.map(({ source: _source, ...option }) => option),
    });
  }

  /** Feeds an update through the item tracker and on to the host. */
  protected emit(nativeId: string, update: SessionUpdate): void {
    const state = this.sessions.get(nativeId);
    const tracked = state ? state.tracker.feed(update) : [{ update }];
    for (const entry of tracked) this.host?.update(this.id, nativeId, entry.update, entry.itemId);
  }

  protected closeMessage(nativeId: string): void {
    const state = this.sessions.get(nativeId);
    if (!state) return;
    for (const entry of state.tracker.close()) this.host?.update(this.id, nativeId, entry.update, entry.itemId);
  }

  protected onUpdate(sessionId: string, raw: unknown): void {
    const update = normalizeAcpUpdate(raw);
    if (!update) return;
    const state = this.sessions.get(sessionId);
    if (state?.replaying) {
      state.replaying.push(update);
      return;
    }
    if (update.sessionUpdate === "current_mode_update" && state) {
      const mode = state.config.find((option) => option.category === "mode");
      if (mode) mode.current = update.currentModeId;
    }
    if (update.sessionUpdate === "ls_config" && state) {
      state.config = update.options.map((option) => ({ ...option, source: "configOptions" as const }));
    }
    this.emit(sessionId, update);
  }

  private onRequest(method: string, params: unknown, id: RpcId): unknown {
    if (method === "elicitation/create") return this.onQuestions(params, id);
    if (method !== "session/request_permission") {
      throw new RpcError(-32601, `LinkShell does not implement ${method}`);
    }
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    const state = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    const requestId = `${this.id}-${this.nextPermissionId++}-${String(id)}`;
    const mapped = mapPermissionRequest(params, requestId);
    if (!state || !mapped) return { outcome: { outcome: "cancelled" } };
    return new Promise((resolve) => {
      state.permissions.set(requestId, resolve);
      this.closeMessage(sessionId as string);
      this.host?.update(this.id, sessionId as string, mapped.update);
    });
  }

  /** The agent asks the user something (a form to fill in): it waits as a request with questions. */
  private onQuestions(params: unknown, id: RpcId): unknown {
    const request = params as { sessionId?: unknown; mode?: unknown; message?: unknown; requestedSchema?: unknown; toolCallId?: unknown } | undefined;
    const sessionId = typeof request?.sessionId === "string" ? request.sessionId : undefined;
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    const message = typeof request?.message === "string" ? request.message : undefined;
    const form = request?.mode === "form" ? formQuestions(request.requestedSchema, message) : undefined;
    // Nothing we can show (a page to open, a form without fields): the agent goes on without an answer.
    if (!sessionId || !state || !form) return { action: "decline" };
    const requestId = `${this.id}-q${this.nextPermissionId++}-${String(id)}`;
    return new Promise((resolve) => {
      state.questions.set(requestId, { form, resolve });
      this.closeMessage(sessionId);
      this.host?.update(this.id, sessionId, {
        sessionUpdate: "ls_permission",
        requestId,
        toolCallId: typeof request?.toolCallId === "string" ? request.toolCallId : undefined,
        title: message ?? form.questions[0]!.text,
        options: QUESTION_OPTIONS,
        questions: form.questions,
      });
    });
  }

  async answerQuestion(nativeId: string, requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const state = this.sessions.get(nativeId);
    const pending = state?.questions.get(requestId);
    if (!state || !pending) throw RpcError.app("not_found", "这个问题已经不在等回答了");
    state.questions.delete(requestId);
    pending.resolve({ action: "accept", content: formContent(pending.form, answers) });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_permission_resolved", requestId, optionId: "answered", answers });
  }

  private cancelPermissions(state: AcpSessionState): void {
    for (const resolve of state.permissions.values()) resolve({ outcome: { outcome: "cancelled" } });
    state.permissions.clear();
    for (const pending of state.questions.values()) pending.resolve({ action: "cancel" });
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
    this.echoUserMessage(nativeId, content, clientMessageId);
    this.emit(nativeId, { sessionUpdate: "ls_turn", state: "started" });
    void this.sendPrompt(nativeId, state, withContext(toAcpPrompt(content), context));
  }

  private async sendPrompt(nativeId: string, state: AcpSessionState, prompt: Record<string, unknown>[]): Promise<void> {
    state.inflight += 1;
    let stopReason: StopReason;
    try {
      const result = await this.rpc<{ stopReason?: unknown }>("session/prompt", { sessionId: nativeId, prompt }, 0);
      stopReason = toStopReason(result.stopReason);
    } catch (error) {
      stopReason = "error";
      const described = describeAgentError(this.label, error instanceof Error ? error.message : String(error));
      this.closeMessage(nativeId);
      this.emit(nativeId, { sessionUpdate: "ls_error", code: "turn_failed", message: described.message, hint: described.hint });
    }
    state.inflight -= 1;
    // A steered prompt settles the earlier one; the turn ends with the last.
    if (state.inflight > 0) return;
    this.closeMessage(nativeId);
    state.turnActive = false;
    this.cancelPermissions(state);
    this.emit(nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason });
    const next = state.queue.shift();
    if (next) this.reportQueue(nativeId, state);
    if (next && state.loaded) this.startTurn(nativeId, state, next.content, next.clientMessageId, next.context);
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
    try {
      const result = await connection.request<T>(method, params, timeoutMs);
      if (opensSession) this.signedOut = undefined;
      return result;
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
        return result;
      } catch (retryError) {
        throw this.signInError(retryError);
      }
    }
  }
}
