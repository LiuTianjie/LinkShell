import { ABANDON, RpcError, type ContentBlock, type RpcId } from "@linkshell/wire";
import type { AgentAuth } from "@linkshell/wire";
import { parseCodexLoginStatus, runStatusCommand } from "../auth.js";
import type { AgentDriver, DiscoveredSession, DriverHost, DriverStatus, HistoryItem, LaunchSpec } from "../types.js";
import { CodexAppServer, detectCodex } from "./app-server.js";
import {
  APPROVAL_METHODS,
  mapApprovalRequest,
  mapNotification,
  threadStateOf,
  threadToDiscovered,
  spawnedThreads,
  threadToHistory,
  toCodexInput,
  type ApprovalRequest,
  type CodexThread,
  type CodexThreadState,
} from "./mapper.js";
import { nestHistory, nestUnder } from "../nesting.js";
import { configOptions, effective, settingsFrom, turnOverrides, type CodexModel, type CodexOverrides, type CodexSettings } from "./settings.js";

export interface CodexDriverOptions {
  socketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  hostVersion: string;
  /** Delay before restarting a crashed app-server; doubles up to 30s. */
  restartDelayMs?: number;
}

interface PendingApproval {
  threadId: string;
  request: ApprovalRequest;
  answer: (result: unknown) => void;
  abandon: () => void;
}

/**
 * Codex, tier multi_client: LinkShell and the desktop TUI (`codex --remote`)
 * are both clients of one app-server, so every thread is live on both sides.
 */
export class CodexDriver implements AgentDriver {
  readonly id = "codex";
  readonly label = "Codex";
  readonly tier = "multi_client" as const;
  readonly capabilities = {
    interrupt: true,
    steer: true,
    permissions: true,
    images: true,
    fork: true,
    models: true,
    modes: true,
  };

  private host?: DriverHost;
  private server?: CodexAppServer;
  private current: DriverStatus = { installed: false };
  private readonly threads = new Map<string, CodexThreadState>();
  private readonly attached = new Set<string>();
  /** Threads this connection started: already subscribed, and not on disk until their first turn. */
  private readonly startedHere = new Set<string>();
  private readonly followRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startsInFlight = new Set<Promise<unknown>>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly settings = new Map<string, CodexSettings>();
  private readonly overrides = new Map<string, CodexOverrides>();
  /** Sub-agent thread → the parent thread and the spawnAgent call its work nests under. */
  private readonly children = new Map<string, { threadId: string; toolCallId: string }>();
  /** Threads Codex reported as sub-agents (parentThreadId set); never shown as sessions. */
  private readonly subThreads = new Set<string>();
  private models?: Promise<CodexModel[]>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartDelay: number;
  private stopped = false;

  constructor(private readonly options: CodexDriverOptions) {
    this.restartDelay = options.restartDelayMs ?? 1000;
  }

  status(): DriverStatus {
    return this.current;
  }

  async start(host: DriverHost): Promise<DriverStatus> {
    this.host = host;
    this.stopped = false;
    const version = await detectCodex(this.options.command, this.options.env);
    if (!version) {
      this.current = { installed: false };
      return this.current;
    }
    this.current = { installed: true, version };
    await this.boot();
    return this.current;
  }

  async authStatus(): Promise<AgentAuth> {
    return parseCodexLoginStatus(await runStatusCommand(this.options.command ?? "codex", ["login", "status"], this.options.env));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const timer of this.followRetries.values()) clearTimeout(timer);
    this.followRetries.clear();
    for (const pending of this.approvals.values()) pending.abandon();
    this.approvals.clear();
    await this.server?.stop();
    this.server = undefined;
  }

  async listSessions(limit: number): Promise<DiscoveredSession[]> {
    const result = await this.rpc<{ data: CodexThread[] }>("thread/list", { limit, archived: false });
    return result.data.map(threadToDiscovered);
  }

  async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    const starting = this.rpc<{ thread: CodexThread; model?: string }>("thread/start", {
      cwd: options.cwd,
      model: options.model ?? null,
    }).then((result) => {
      this.startedHere.add(result.thread.id);
      this.settings.set(result.thread.id, settingsFrom(result as unknown as Record<string, unknown>));
      return result;
    });
    this.startsInFlight.add(starting);
    let result: { thread: CodexThread; model?: string };
    try {
      result = await starting;
    } finally {
      this.startsInFlight.delete(starting);
    }
    const discovered = threadToDiscovered(result.thread);
    return { ...discovered, model: discovered.model ?? result.model };
  }

  async attach(nativeId: string): Promise<HistoryItem[]> {
    // Mark first: notifications that race the resume response are buffered by
    // the host rather than dropped.
    this.attached.add(nativeId);
    if (this.startedHere.delete(nativeId)) {
      // thread/start already subscribed us, and a thread without turns has no
      // rollout yet, so thread/resume would fail. Nothing to import either.
      void this.announceConfig(nativeId);
      return [];
    }
    let thread: CodexThread;
    try {
      // On a running thread, thread/resume rejoins it; otherwise it loads it from disk.
      const resumed = await this.rpc<{ thread: CodexThread }>("thread/resume", { threadId: nativeId });
      thread = resumed.thread;
      this.settings.set(nativeId, settingsFrom(resumed as unknown as Record<string, unknown>));
      void this.announceConfig(nativeId);
    } catch (error) {
      this.attached.delete(nativeId);
      if (error instanceof Error && /no rollout/i.test(error.message)) {
        // Opened in another client but no turn yet, so not on disk. A turn can
        // still be started on it; after that it can be joined.
        throw RpcError.app("not_ready", "this Codex session has no messages yet");
      }
      throw error;
    }
    const active = thread.turns?.find((turn) => turn.status === "inProgress");
    this.stateOf(nativeId).activeTurnId = active?.id;
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: threadStateOf(thread.status) });
    return this.withSubAgents(nativeId, thread, threadToHistory(thread));
  }

  /** Nests each sub-agent's own history right after the call that spawned it. */
  private async withSubAgents(threadId: string, thread: CodexThread, history: HistoryItem[]): Promise<HistoryItem[]> {
    const spawns = new Map<string, string[]>();
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items) {
        const ids = spawnedThreads(item);
        const callId = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined;
        if (!callId || ids.length === 0) continue;
        spawns.set(callId, ids);
        for (const child of ids) this.children.set(child, { threadId, toolCallId: callId });
      }
    }
    if (spawns.size === 0) return history;
    const nested = new Map<string, HistoryItem[]>();
    await Promise.all(
      [...spawns].map(async ([callId, ids]) => {
        const parts = await Promise.all(
          ids.map((child) =>
            this.rpc<{ thread: CodexThread }>("thread/read", { threadId: child, includeTurns: true })
              .then((result) => nestHistory(threadToHistory(result.thread), callId))
              .catch(() => [] as HistoryItem[]),
          ),
        );
        nested.set(callId, parts.flat());
      }),
    );
    return history.flatMap((item) => {
      const callId = item.itemId.replace(/^tool:/, "");
      const children = nested.get(callId) ?? nested.get(item.itemId);
      return children ? [item, ...children.map((child) => ({ ...child, ts: child.ts ?? item.ts }))] : [item];
    });
  }

  async detach(nativeId: string): Promise<void> {
    if (!this.attached.delete(nativeId)) return;
    await this.rpc("thread/unsubscribe", { threadId: nativeId }).catch(() => {});
  }

  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string): Promise<"started" | "steered"> {
    const input = toCodexInput(content);
    if (input.length === 0) throw RpcError.app("invalid_params", "nothing to send");
    const activeTurnId = this.stateOf(nativeId).activeTurnId;
    if (activeTurnId) {
      try {
        await this.rpc("turn/steer", {
          threadId: nativeId,
          expectedTurnId: activeTurnId,
          clientUserMessageId: clientMessageId,
          input,
        });
        return "steered";
      } catch (error) {
        // The turn may have just ended; fall through to a fresh turn.
        this.host?.log(`[codex] steer failed, starting a new turn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.rpc("turn/start", {
      threadId: nativeId,
      clientUserMessageId: clientMessageId,
      input,
      ...turnOverrides(this.overrides.get(nativeId) ?? {}),
    });
    return "started";
  }

  /** Model, reasoning effort and permissions apply from the next turn on. */
  async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    const models = await this.loadModels();
    const current = effective(this.settings.get(nativeId) ?? {}, this.overrides.get(nativeId) ?? {}, models);
    const next: CodexOverrides = { ...this.overrides.get(nativeId) };
    if (optionId === "model") {
      if (!models.some((m) => m.model === value) && value !== current.model) {
        throw RpcError.app("invalid_params", `unknown model ${value}`);
      }
      next.model = value;
      // Keep the effort only if the new model supports it.
      const info = models.find((m) => m.model === value);
      const supported = info?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [];
      if (next.effort && !supported.includes(next.effort)) delete next.effort;
    } else if (optionId === "effort") {
      if (current.info?.supportedReasoningEfforts && !current.info.supportedReasoningEfforts.some((e) => e.reasoningEffort === value)) {
        throw RpcError.app("invalid_params", `unsupported reasoning effort ${value}`);
      }
      next.effort = value;
    } else if (optionId === "permissions") {
      if (value === "custom") delete next.permissions;
      else next.permissions = value;
    } else {
      throw RpcError.app("not_supported", `Codex has no setting ${optionId}`);
    }
    this.overrides.set(nativeId, next);
    await this.announceConfig(nativeId);
  }

  private loadModels(): Promise<CodexModel[]> {
    this.models ??= this.rpc<{ data: CodexModel[] }>("model/list", { includeHidden: false })
      .then((result) => result.data)
      .catch((error: unknown) => {
        this.models = undefined;
        this.host?.log(`[codex] model/list failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
    return this.models;
  }

  private async announceConfig(nativeId: string): Promise<void> {
    const models = await this.loadModels();
    const options = configOptions(this.settings.get(nativeId) ?? {}, this.overrides.get(nativeId) ?? {}, models);
    if (options.length > 0) this.host?.update(this.id, nativeId, { sessionUpdate: "ls_config", options });
  }

  async cancel(nativeId: string): Promise<void> {
    const turnId = this.stateOf(nativeId).activeTurnId;
    if (!turnId) return;
    await this.rpc("turn/interrupt", { threadId: nativeId, turnId });
  }

  async respondPermission(nativeId: string, requestId: string, optionId: string): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.threadId !== nativeId) {
      throw RpcError.app("not_found", "this permission request is no longer pending");
    }
    this.approvals.delete(requestId);
    pending.answer(pending.request.respond(optionId));
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_permission_resolved", requestId, optionId });
    if (optionId === "cancel") await this.cancel(nativeId).catch(() => {});
  }

  desktopLaunch(args: string[], nativeId?: string): LaunchSpec {
    // Multi-client: no lease to take, the TUI just joins the shared server.
    const remote = ["--remote", `unix://${this.options.socketPath}`];
    return {
      command: this.options.command ?? "codex",
      args: nativeId ? [...remote, "resume", nativeId, ...args] : [...remote, ...args],
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    const server = new CodexAppServer({
      socketPath: this.options.socketPath,
      command: this.options.command,
      env: this.options.env,
      clientVersion: this.options.hostVersion,
      log: (message) => this.host?.log(message),
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onServerRequest(method, params, id),
      onDown: (reason) => this.onDown(reason),
    });
    this.server = server;
    try {
      await server.start();
      this.current = { installed: true, version: this.current.version };
      this.restartDelay = this.options.restartDelayMs ?? 1000;
      await this.reattachLoaded();
    } catch (error) {
      this.current = {
        installed: true,
        version: this.current.version,
        problem: `Codex app-server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.scheduleRestart();
    }
  }

  /** Follows every thread already live in the app-server (e.g. opened in the TUI). */
  private async reattachLoaded(): Promise<void> {
    const loaded = await this.rpc<{ data: string[] }>("thread/loaded/list", {}).catch(() => ({ data: [] }));
    for (const threadId of loaded.data) this.follow(threadId);
  }

  /**
   * Asks the host to follow a thread another client opened. A brand-new thread
   * has no rollout on disk until its first turn, so thread/resume fails until
   * then; keep retrying while the thread stays loaded.
   */
  private follow(threadId: string, attempt = 0): void {
    if (this.stopped || !this.host || this.followRetries.has(threadId)) return;
    this.host.follow(this.id, threadId).catch(async (error: unknown) => {
      if (this.stopped) return;
      if (!(error instanceof RpcError && error.appCode === "not_ready")) {
        this.host?.log(`[codex] could not follow ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (attempt % 30 === 29) {
        const loaded = await this.rpc<{ data: string[] }>("thread/loaded/list", {}).catch(() => ({ data: [] as string[] }));
        if (!loaded.data.includes(threadId)) return;
      }
      const timer = setTimeout(() => {
        this.followRetries.delete(threadId);
        this.follow(threadId, attempt + 1);
      }, attempt < 4 ? 250 : 1000);
      this.followRetries.set(threadId, timer);
    });
  }

  private onDown(reason: string): void {
    this.models = undefined;
    if (this.stopped) return;
    this.host?.log(`[codex] ${reason}`);
    for (const pending of this.approvals.values()) pending.abandon();
    this.approvals.clear();
    for (const threadId of this.attached) {
      this.threads.delete(threadId);
      this.host?.update(this.id, threadId, { sessionUpdate: "ls_status", state: "offline" });
      this.host?.detached(this.id, threadId);
    }
    this.attached.clear();
    this.startedHere.clear();
    this.current = { installed: true, version: this.current.version, problem: "Codex app-server restarting" };
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.server?.stop().finally(() => {
        if (!this.stopped) void this.boot();
      });
    }, delay);
  }

  private stateOf(threadId: string): CodexThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {};
      this.threads.set(threadId, state);
    }
    return state;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "thread/started") {
      const thread = (params as { thread?: CodexThread } | undefined)?.thread;
      if (!thread?.id) return;
      if ((thread as { parentThreadId?: string | null }).parentThreadId) {
        // A sub-agent: its work shows inside the parent session, not as a session of its own.
        this.subThreads.add(thread.id);
        return;
      }
      this.host?.sessionSeen(this.id, threadToDiscovered(thread));
      // The broadcast can beat our own thread/start response; decide whether
      // the thread was opened elsewhere (the desktop TUI) once those settle.
      void Promise.allSettled([...this.startsInFlight]).then(() => {
        if (!this.attached.has(thread.id) && !this.startedHere.has(thread.id)) this.follow(thread.id);
      });
      return;
    }
    this.noteSpawns(params);
    for (const mapped of mapNotification(method, params, (threadId) => this.stateOf(threadId))) {
      if (mapped.update.sessionUpdate === "ls_permission_resolved") {
        const pending = this.approvals.get(mapped.update.requestId);
        if (pending) {
          // Another client (the TUI) answered first.
          this.approvals.delete(mapped.update.requestId);
          pending.abandon();
        }
      }
      const parent = this.children.get(mapped.threadId);
      if (parent) {
        const nested = nestUnder(mapped.update, parent.toolCallId);
        if (nested && this.attached.has(parent.threadId)) {
          this.host?.update(this.id, parent.threadId, nested, mapped.itemId && `sub:${parent.toolCallId}:${mapped.itemId}`);
        }
        continue;
      }
      if (!this.attached.has(mapped.threadId)) continue;
      this.host?.update(this.id, mapped.threadId, mapped.update, mapped.itemId);
    }
  }

  /** Remembers which spawnAgent call each new sub-agent thread belongs to. */
  private noteSpawns(params: unknown): void {
    const record = params as { threadId?: unknown; item?: unknown } | undefined;
    const threadId = typeof record?.threadId === "string" ? record.threadId : undefined;
    const callId = (record?.item as { id?: unknown } | undefined)?.id;
    if (!threadId || typeof callId !== "string") return;
    // A sub-agent's own sub-agents nest under the same top-level session.
    const root = this.children.get(threadId)?.threadId ?? threadId;
    for (const child of spawnedThreads(record?.item)) this.children.set(child, { threadId: root, toolCallId: callId });
  }

  private onServerRequest(method: string, params: unknown, id: RpcId): unknown {
    if (!APPROVAL_METHODS.has(method)) return ABANDON;
    const requestId = String(id);
    const mapped = mapApprovalRequest(method, params, requestId);
    // A sub-agent asking for permission asks in its parent session.
    const request = mapped && this.children.has(mapped.threadId) ? { ...mapped, threadId: this.children.get(mapped.threadId)!.threadId } : mapped;
    if (!request || !this.attached.has(request.threadId)) return ABANDON;
    return new Promise((resolve) => {
      this.approvals.set(requestId, {
        threadId: request.threadId,
        request,
        answer: resolve,
        abandon: () => resolve(ABANDON),
      });
      this.host?.update(this.id, request.threadId, request.update);
    });
  }

  private rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.server) return Promise.reject(RpcError.app("agent_unavailable", "Codex is not running"));
    return this.server.request<T>(method, params);
  }
}
