import { ABANDON, RpcError, type ContentBlock, type QuestionAnswer, type RpcId } from "@linkshell/wire";
import type { AgentAuth } from "@linkshell/wire";
import { parseCodexLoginStatus, runStatusCommand } from "../auth.js";
import type { AgentDriver, DiscoveredSession, DriverHost, DriverStatus, ForkOptions, HistoryItem, LaunchSpec } from "../types.js";
import { CodexAppServer, detectCodex } from "./app-server.js";
import {
  APPROVAL_METHODS,
  QUESTION_METHODS,
  mapApprovalRequest,
  mapQuestionRequest,
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
import { COMMANDS, INIT_PROMPT, commandOf, type CodexSkill } from "./commands.js";

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
  /** Recent tool titles by item, so a file-change approval can name its files. */
  private readonly toolTitles = new Map<string, string>();
  private readonly settings = new Map<string, CodexSettings>();
  private readonly overrides = new Map<string, CodexOverrides>();
  /** Sub-agent thread → the parent thread and the spawnAgent call its work nests under. */
  private readonly children = new Map<string, { threadId: string; toolCallId: string }>();
  /** Threads Codex reported as sub-agents (parentThreadId set); never shown as sessions. */
  private readonly subThreads = new Set<string>();
  /** Each thread's working directory: where its skills are looked up. */
  private readonly cwds = new Map<string, string>();
  private readonly skills = new Map<string, Promise<CodexSkill[]>>();
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

  /** Codex's own fork: a new thread with this one's turns, all or through `lastTurnId`, in `cwd`. */
  async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    let lastTurnId: string | undefined;
    if (options.upTo) {
      const { thread } = await this.rpc<{ thread: CodexThread }>("thread/read", { threadId: nativeId, includeTurns: true });
      const turns = thread.turns ?? [];
      const picked = options.upTo;
      const holding = turns.find((turn) => turn.items.some((item) => (item as { id?: unknown }).id === picked.itemId));
      lastTurnId = (holding ?? turns[picked.turn - 1])?.id;
      if (!lastTurnId) throw RpcError.app("not_found", "找不到要分叉的那一轮");
    }
    const result = await this.rpc<{ thread: CodexThread; model?: string }>("thread/fork", {
      threadId: nativeId,
      lastTurnId: lastTurnId ?? null,
      cwd: options.cwd,
      excludeTurns: true,
    });
    // (Not `startedHere`: unlike a new thread, a fork has turns to import when it is opened.)
    this.settings.set(result.thread.id, settingsFrom(result as unknown as Record<string, unknown>));
    const discovered = threadToDiscovered(result.thread);
    return { ...discovered, cwd: discovered.cwd || options.cwd, model: discovered.model ?? result.model };
  }

  async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    const starting = this.rpc<{ thread: CodexThread; model?: string }>("thread/start", {
      cwd: options.cwd,
      model: options.model ?? null,
    }).then((result) => {
      this.startedHere.add(result.thread.id);
      this.cwds.set(result.thread.id, result.thread.cwd ?? options.cwd);
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
      void this.announceCommands(nativeId);
      return [];
    }
    let thread: CodexThread;
    try {
      // On a running thread, thread/resume rejoins it; otherwise it loads it from disk.
      const resumed = await this.rpc<{ thread: CodexThread }>("thread/resume", { threadId: nativeId });
      thread = resumed.thread;
      this.settings.set(nativeId, settingsFrom(resumed as unknown as Record<string, unknown>));
      if (thread.cwd) this.cwds.set(nativeId, thread.cwd);
      void this.announceConfig(nativeId);
      void this.announceCommands(nativeId);
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
    const command = commandOf(content);
    if (command) {
      const ran = await this.runCommand(nativeId, command, clientMessageId);
      if (ran) return ran;
    }
    return this.send(nativeId, toCodexInput(content), clientMessageId);
  }

  /**
   * `/compact`, `/review`, `/init` and `/<skill>`: what the TUI does for them,
   * through the app-server. Anything else is an ordinary message.
   */
  private async runCommand(
    nativeId: string,
    command: { name: string; args: string; text: string },
    clientMessageId: string,
  ): Promise<"started" | "steered" | undefined> {
    const echo = () =>
      this.host?.update(
        this.id,
        nativeId,
        { sessionUpdate: "user_message_chunk", messageId: `local-${clientMessageId}`, content: { type: "text", text: command.text } },
        `command:${clientMessageId}`,
      );
    if (command.name === "compact" || command.name === "review") {
      if (this.stateOf(nativeId).activeTurnId) {
        throw RpcError.app("busy", command.name === "compact" ? "等这一轮结束后再压缩上下文" : "等这一轮结束后再开始审查");
      }
      if (command.name === "compact") {
        await this.rpc("thread/compact/start", { threadId: nativeId });
      } else {
        await this.rpc("review/start", {
          threadId: nativeId,
          target: command.args ? { type: "custom", instructions: command.args } : { type: "uncommittedChanges" },
          delivery: "inline",
        });
      }
      echo();
      return "started";
    }
    if (command.name === "init") {
      const text = command.args ? `${INIT_PROMPT}\n\n${command.args}` : INIT_PROMPT;
      return this.send(nativeId, [{ type: "text", text, text_elements: [] }], clientMessageId);
    }
    const skill = (await this.loadSkills(this.cwds.get(nativeId))).find((entry) => entry.name === command.name);
    if (!skill) return undefined;
    // The way the TUI sends a skill: the skill itself, and `$name` in the text.
    return this.send(
      nativeId,
      [
        { type: "skill", name: skill.name, path: skill.path },
        { type: "text", text: command.args ? `$${skill.name} ${command.args}` : `$${skill.name}`, text_elements: [] },
      ],
      clientMessageId,
    );
  }

  private async send(nativeId: string, input: unknown[], clientMessageId: string): Promise<"started" | "steered"> {
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
    const overrides = this.overrides.get(nativeId) ?? {};
    await this.rpc("turn/start", {
      threadId: nativeId,
      clientUserMessageId: clientMessageId,
      input,
      ...turnOverrides(overrides, overrides.plan === undefined ? {} : effective(this.settings.get(nativeId) ?? {}, overrides, await this.loadModels())),
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
    } else if (optionId === "plan") {
      next.plan = value === "on";
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

  private loadSkills(cwd: string | undefined): Promise<CodexSkill[]> {
    const key = cwd ?? "";
    let loading = this.skills.get(key);
    if (!loading) {
      loading = this.rpc<{ data: { skills?: CodexSkill[] }[] }>("skills/list", cwd ? { cwds: [cwd] } : {})
        .then((result) => result.data.flatMap((entry) => entry.skills ?? []).filter((skill) => skill.enabled !== false && skill.name && skill.path))
        .catch((error: unknown) => {
          this.skills.delete(key);
          this.host?.log(`[codex] skills/list failed: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        });
      this.skills.set(key, loading);
    }
    return loading;
  }

  /** What `/` offers on a device: the commands above, then the skills this project can use. */
  private async announceCommands(nativeId: string): Promise<void> {
    const skills = await this.loadSkills(this.cwds.get(nativeId));
    const taken = new Set(COMMANDS.map((command) => command.name));
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        ...COMMANDS,
        ...skills
          .filter((skill) => !taken.has(skill.name))
          .map((skill) => ({
            name: skill.name,
            description: (skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description ?? "").slice(0, 160),
          })),
      ],
    });
  }

  async archive(nativeId: string, archived: boolean): Promise<void> {
    await this.rpc(archived ? "thread/archive" : "thread/unarchive", { threadId: nativeId });
  }

  async rename(nativeId: string, title: string): Promise<void> {
    await this.rpc("thread/name/set", { threadId: nativeId, name: title });
  }

  async delete(nativeId: string): Promise<void> {
    await this.rpc("thread/delete", { threadId: nativeId });
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

  async answerQuestion(nativeId: string, requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.threadId !== nativeId || !pending.request.answer) {
      throw RpcError.app("not_found", "这个问题已经不在等回答了");
    }
    this.approvals.delete(requestId);
    pending.answer(pending.request.answer(answers));
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_permission_resolved", requestId, optionId: "answered", answers });
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
    this.skills.clear();
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
    if (method === "thread/deleted") {
      // Deleted in the TUI or another client.
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (threadId && !this.subThreads.has(threadId)) this.host?.removed(this.id, threadId);
      return;
    }
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
      if (mapped.update.sessionUpdate === "tool_call") this.rememberTitle(mapped.update.toolCallId, mapped.update.title);
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
    if (!APPROVAL_METHODS.has(method) && !QUESTION_METHODS.has(method)) return ABANDON;
    const requestId = String(id);
    const mapped = QUESTION_METHODS.has(method) ? mapQuestionRequest(method, params, requestId) : mapApprovalRequest(method, params, requestId);
    // A sub-agent asking for permission asks in its parent session.
    const request = mapped && this.children.has(mapped.threadId) ? { ...mapped, threadId: this.children.get(mapped.threadId)!.threadId } : mapped;
    if (!request || !this.attached.has(request.threadId)) return ABANDON;
    // "Edit app.ts" says more than "Apply file changes".
    const toolTitle = method === "item/fileChange/requestApproval" && request.update.toolCallId && this.toolTitles.get(request.update.toolCallId);
    if (toolTitle) request.update = { ...request.update, title: toolTitle };
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

  private rememberTitle(toolCallId: string, title: string): void {
    this.toolTitles.delete(toolCallId);
    this.toolTitles.set(toolCallId, title);
    if (this.toolTitles.size > 200) this.toolTitles.delete(this.toolTitles.keys().next().value!);
  }

  private rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.server) return Promise.reject(RpcError.app("agent_unavailable", "Codex is not running"));
    return this.server.request<T>(method, params);
  }
}
