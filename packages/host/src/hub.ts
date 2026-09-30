import {
  RpcError,
  sessionIdFor,
  type AgentAuth,
  type AgentInfo,
  type ContentBlock,
  type SessionActivity,
  type SessionEvent,
  type SessionSummary,
  type SessionUpdate,
  type QueuedMessage,
} from "@linkshell/wire";
import type {
  AgentDriver,
  DesktopController,
  DesktopLaunchContext,
  DiscoveredSession,
  DriverHost,
  LaunchSpec,
} from "./drivers/types.js";
import type { HostStore, SessionPatch } from "./store.js";

export interface Subscriber {
  event(event: SessionEvent): void;
}

type PermissionUpdate = Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;

interface LiveSession {
  attached: boolean;
  attaching?: Promise<void>;
  /** Live updates that arrive while native history is being imported. */
  buffer?: { update: SessionUpdate; itemId?: string }[];
  subscribers: Set<Subscriber>;
  /** Streaming agent text per message, for the list preview. */
  messageText: Map<string, string>;
  permissions: Map<string, PermissionUpdate>;
  turnActive: boolean;
  /** What the running turn is doing, for list rows (never persisted). */
  activity?: SessionActivity;
  /** Messages the driver holds until the turn ends (never persisted). */
  queue?: QueuedMessage[];
  /** True while native history is imported: no live activity, one summary at the end. */
  importing?: boolean;
  importChanged?: boolean;
}

const PREVIEW_LENGTH = 160;
const TITLE_LENGTH = 60;

function compact(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sameActivity(a?: SessionActivity, b?: SessionActivity): boolean {
  return a?.kind === b?.kind && a?.title === b?.title && a?.toolKind === b?.toolKind;
}

function textOf(content: ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .trim();
}

/**
 * The host's source of truth for sessions. Drivers push native events in;
 * the hub logs them with a per-session seq, keeps summaries current and fans
 * events out to subscribed clients.
 */
export class SessionHub {
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly live = new Map<string, LiveSession>();
  private readonly summaryListeners = new Set<(summary: SessionSummary) => void>();
  private readonly removedListeners = new Set<(sessionId: string) => void>();
  private readonly auth = new Map<string, { value: AgentAuth; checkedAt: number }>();
  /** Terminals (`linkshell <agent>`) currently driving handoff sessions. */
  private readonly desktops = new Map<string, DesktopController>();
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private authRefreshing?: Promise<void>;

  readonly driverHost: DriverHost = {
    sessionSeen: (agent, session) => this.recordDiscovered(agent, session),
    update: (agent, nativeId, update, itemId) => this.ingest(sessionIdFor(agent, nativeId), update, itemId),
    follow: (agent, nativeId) => {
      const sessionId = sessionIdFor(agent, nativeId);
      if (!this.store.getSession(sessionId)) return Promise.reject(new Error(`unknown session ${sessionId}`));
      return this.ensureAttached(sessionId);
    },
    detached: (agent, nativeId) => {
      const live = this.live.get(sessionIdFor(agent, nativeId));
      if (live) live.attached = false;
    },
    queue: (agent, nativeId, items) => {
      const sessionId = sessionIdFor(agent, nativeId);
      const stored = this.store.getSession(sessionId);
      if (!stored) return;
      this.liveFor(sessionId).queue = items.length ? items : undefined;
      this.emitSummary(stored);
    },
    removed: (agent, nativeId) => this.forget(sessionIdFor(agent, nativeId)),
    desktop: (agent, nativeId) => this.desktops.get(sessionIdFor(agent, nativeId)),
    state: (agent, nativeId) => {
      const sessionId = sessionIdFor(agent, nativeId);
      return {
        get: (key) => this.store.getDriverState(sessionId, key),
        set: (key, value) => this.store.setDriverState(sessionId, key, value),
      };
    },
    log: (message) => this.log(message),
  };

  constructor(
    private readonly store: HostStore,
    drivers: AgentDriver[],
    private readonly log: (message: string) => void = () => {},
  ) {
    for (const driver of drivers) this.drivers.set(driver.id, driver);
  }

  async start(options: { discoveryIntervalMs?: number } = {}): Promise<void> {
    await Promise.all(
      [...this.drivers.values()].map(async (driver) => {
        try {
          const status = await driver.start(this.driverHost);
          if (!status.installed) return;
          await this.refreshAuth(driver);
          if (status.problem) return;
          for (const session of await driver.listSessions(100)) this.recordDiscovered(driver.id, session);
        } catch (error) {
          this.log(`[hub] ${driver.id} failed to start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    // Sessions also start outside LinkShell (a plain `claude`, the Codex app…).
    const interval = options.discoveryIntervalMs ?? 30_000;
    if (interval > 0) {
      this.discoveryTimer = setInterval(() => void this.refreshDiscovery(), interval);
      this.discoveryTimer.unref?.();
    }
  }

  /** Re-lists recent sessions from every running agent. */
  async refreshDiscovery(limit = 50): Promise<void> {
    await Promise.all(
      [...this.drivers.values()].map(async (driver) => {
        const status = driver.status();
        if (!status.installed || status.problem) return;
        try {
          for (const session of await driver.listSessions(limit)) this.recordDiscovered(driver.id, session);
        } catch (error) {
          this.log(`[hub] ${driver.id} discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.stop()));
  }

  agents(): AgentInfo[] {
    return [...this.drivers.values()].map((driver) => {
      const status = driver.status();
      return {
        id: driver.id,
        label: driver.label,
        tier: driver.tier,
        installed: status.installed,
        version: status.version,
        problem: status.problem,
        auth: this.auth.get(driver.id)?.value,
        capabilities: driver.capabilities,
      };
    });
  }

  /** Re-checks login state in the background when the cached answer is older than `maxAgeMs`. */
  refreshAuthIfStale(maxAgeMs = 60_000): Promise<void> {
    if (this.authRefreshing) return this.authRefreshing;
    const stale = [...this.drivers.values()].filter(
      (driver) => driver.status().installed && Date.now() - (this.auth.get(driver.id)?.checkedAt ?? 0) > maxAgeMs,
    );
    if (stale.length === 0) return Promise.resolve();
    this.authRefreshing = Promise.all(stale.map((driver) => this.refreshAuth(driver))).then(() => {
      this.authRefreshing = undefined;
    });
    return this.authRefreshing;
  }

  private async refreshAuth(driver: AgentDriver): Promise<void> {
    if (!driver.authStatus) return;
    try {
      this.auth.set(driver.id, { value: await driver.authStatus(), checkedAt: Date.now() });
    } catch {
      this.auth.set(driver.id, { value: { state: "unknown" }, checkedAt: Date.now() });
    }
  }

  onSummary(listener: (summary: SessionSummary) => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  listSessions(options: { limit?: number; before?: number; includeArchived?: boolean }): {
    sessions: SessionSummary[];
    nextBefore?: number;
  } {
    const limit = options.limit ?? 50;
    const sessions = this.store.listSessions({ ...options, limit }).map((session) => this.decorate(session));
    const last = sessions[sessions.length - 1];
    return { sessions, nextBefore: sessions.length === limit && last ? last.updatedAt : undefined };
  }

  listProjects(limit?: number) {
    return this.store.listProjects(limit);
  }

  getSession(sessionId: string): SessionSummary {
    const summary = this.store.getSession(sessionId);
    if (!summary) throw RpcError.app("not_found", `session ${sessionId} not found`);
    return this.decorate(summary);
  }

  /** Adds the live-only fields (current activity, first pending permission) to a stored summary. */
  private decorate(summary: SessionSummary): SessionSummary {
    const live = this.live.get(summary.id);
    if (!live) return summary;
    const activity = live.turnActive ? live.activity : undefined;
    const first = live.permissions.values().next().value as PermissionUpdate | undefined;
    if (!activity && !first && !live.queue) return summary;
    const decorated: SessionSummary = { ...summary };
    if (live.queue) decorated.queue = live.queue;
    if (activity) decorated.activity = activity;
    if (first) {
      decorated.permission = {
        requestId: first.requestId,
        toolCallId: first.toolCallId,
        title: first.title,
        detail: first.detail,
        options: first.options,
      };
    }
    return decorated;
  }

  async createSession(input: {
    agent: string;
    cwd: string;
    model?: string;
    prompt?: ContentBlock[];
    clientMessageId?: string;
  }): Promise<SessionSummary> {
    const driver = this.requireDriver(input.agent);
    const discovered = await driver.createSession({ cwd: input.cwd, model: input.model }).catch(async (error: unknown) => {
      // The app shows "not logged in" from the agent list; make it current.
      if (error instanceof RpcError && error.appCode === "not_logged_in") await this.refreshAuth(driver);
      throw error;
    });
    this.recordDiscovered(driver.id, discovered);
    const sessionId = sessionIdFor(driver.id, discovered.nativeId);
    await this.ensureAttached(sessionId);
    if (input.prompt && input.prompt.length > 0) {
      await this.prompt(sessionId, input.clientMessageId ?? `create-${sessionId}`, input.prompt);
    }
    return this.getSession(sessionId);
  }

  /**
   * Sends everything after `fromSeq`, then streams live events. The backlog read
   * and the subscriber registration happen in one synchronous step, so no event
   * can fall between them.
   */
  async subscribe(sessionId: string, fromSeq: number, subscriber: Subscriber): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const driver = this.drivers.get(summary.agent);
    if (driver && driver.status().installed) {
      try {
        await this.ensureAttached(sessionId);
      } catch (error) {
        // Serve the log we have; not_ready sessions attach once they get a turn.
        if (!(error instanceof RpcError && error.appCode === "not_ready")) {
          this.log(`[hub] attach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    let cursor = fromSeq;
    for (;;) {
      const batch = this.store.readEvents(sessionId, cursor);
      for (const event of batch) subscriber.event(event);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
    }
    this.liveFor(sessionId).subscribers.add(subscriber);
    return this.getSession(sessionId);
  }

  unsubscribe(sessionId: string, subscriber: Subscriber): void {
    this.live.get(sessionId)?.subscribers.delete(subscriber);
  }

  async prompt(
    sessionId: string,
    clientMessageId: string,
    content: ContentBlock[],
  ): Promise<"started" | "steered" | "queued" | "duplicate"> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    let joinAfterSend = false;
    try {
      await this.ensureAttached(sessionId);
    } catch (error) {
      // Not joinable until it has a first message — which is what we're sending.
      if (!(error instanceof RpcError && error.appCode === "not_ready")) throw error;
      joinAfterSend = true;
    }
    if (!this.store.claimClientMessage(sessionId, clientMessageId)) return "duplicate";
    let delivery: "started" | "steered" | "queued";
    try {
      delivery = await driver.prompt(summary.nativeId, content, clientMessageId);
    } catch (error) {
      this.store.releaseClientMessage(sessionId, clientMessageId);
      throw error;
    }
    if (joinAfterSend) void this.attachWhenReady(sessionId);
    return delivery;
  }

  /** Retries attaching a session that just became joinable. */
  private async attachWhenReady(sessionId: string, attempts = 40): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.ensureAttached(sessionId);
        return;
      } catch (error) {
        if (!(error instanceof RpcError && error.appCode === "not_ready")) {
          this.log(`[hub] attach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
      }
    }
  }

  unqueue(sessionId: string, clientMessageId: string): boolean {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    const removed = driver.unqueue?.(summary.nativeId, clientMessageId) ?? false;
    // Sent again later, it should go through.
    if (removed) this.store.releaseClientMessage(sessionId, clientMessageId);
    return removed;
  }

  onRemoved(listener: (sessionId: string) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  async archive(sessionId: string, archived: boolean): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const driver = this.drivers.get(summary.agent);
    if (driver?.archive) await driver.archive(summary.nativeId, archived);
    const updated = this.store.patchSession(sessionId, { archived });
    this.emitSummary(updated);
    return this.decorate(updated);
  }

  async rename(sessionId: string, title: string): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const name = compact(title, TITLE_LENGTH);
    const driver = this.drivers.get(summary.agent);
    if (name && driver?.rename) {
      try {
        await driver.rename(summary.nativeId, name);
      } catch (error) {
        // The name still holds in LinkShell.
        this.log(`[hub] ${summary.agent} rename failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const updated = this.store.patchSession(sessionId, { customTitle: name || null });
    this.emitSummary(updated);
    return this.decorate(updated);
  }

  async delete(sessionId: string): Promise<void> {
    const summary = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    if (live?.turnActive || summary.state === "running") throw RpcError.app("busy", "这个会话正在运行：先停止，再删除");
    if (this.desktops.has(sessionId)) throw RpcError.app("busy", "这个会话正在电脑终端里使用：先在电脑上退出，再删除");
    const driver = this.drivers.get(summary.agent);
    if (driver) {
      await driver.detach(summary.nativeId).catch(() => {});
      if (driver.delete) await driver.delete(summary.nativeId);
    }
    this.forget(sessionId);
  }

  /** Drops a session from LinkShell and tells every client. */
  private forget(sessionId: string): void {
    if (!this.store.getSession(sessionId)) return;
    this.live.delete(sessionId);
    this.store.removeSession(sessionId);
    for (const listener of this.removedListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        this.log(`[hub] removal listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const summary = this.getSession(sessionId);
    await this.requireDriver(summary.agent).cancel(summary.nativeId);
  }

  async respondPermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
    const summary = this.getSession(sessionId);
    const request = this.live.get(sessionId)?.permissions.get(requestId);
    if (!request) throw RpcError.app("not_found", "this permission request is no longer pending");
    if (!request.options.some((option) => option.optionId === optionId)) {
      throw RpcError.app("invalid_params", `unknown option ${optionId}`);
    }
    await this.requireDriver(summary.agent).respondPermission(summary.nativeId, requestId, optionId);
  }

  async desktopLaunch(
    agent: string,
    args: string[],
    sessionId: string | undefined,
    context: DesktopLaunchContext,
  ): Promise<LaunchSpec & { sessionId?: string }> {
    const driver = this.requireDriver(agent);
    if (!driver.desktopLaunch) throw RpcError.app("not_supported", `${driver.label} has no desktop mode`);
    const nativeId = sessionId ? this.getSession(sessionId).nativeId : undefined;
    const launch = await driver.desktopLaunch(args, nativeId, context);
    if (!launch.nativeId) return { command: launch.command, args: launch.args, env: launch.env };
    const id = sessionIdFor(driver.id, launch.nativeId);
    if (!this.store.getSession(id)) {
      const now = Date.now();
      this.recordDiscovered(driver.id, {
        nativeId: launch.nativeId,
        cwd: launch.cwd ?? context.cwd ?? "",
        createdAt: now,
        updatedAt: now,
        state: "idle",
      });
    }
    // Follow it right away: the phone sees desktop activity as it happens.
    this.ensureAttached(id).catch((error: unknown) =>
      this.log(`[hub] attach ${id} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    return { command: launch.command, args: launch.args, env: launch.env, sessionId: id };
  }

  /** Registers the terminal driving a handoff session; returns the unregister function. */
  registerDesktop(sessionId: string, controller: DesktopController): () => void {
    this.desktops.set(sessionId, controller);
    return () => {
      if (this.desktops.get(sessionId) !== controller) return;
      this.desktops.delete(sessionId);
      const summary = this.store.getSession(sessionId);
      if (summary) this.drivers.get(summary.agent)?.desktopDetached?.(summary.nativeId);
    };
  }

  async takeover(sessionId: string): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    if (driver.takeover) await driver.takeover(summary.nativeId);
    return this.getSession(sessionId);
  }

  async reclaim(sessionId: string, context: DesktopLaunchContext): Promise<LaunchSpec> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    if (!driver.reclaim) throw RpcError.app("not_supported", `${driver.label} has no desktop mode`);
    return driver.reclaim(summary.nativeId, { cwd: summary.cwd, ...context });
  }

  async setConfig(sessionId: string, optionId: string, value: string): Promise<void> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    if (!driver.setConfig) throw RpcError.app("not_supported", `${driver.label} settings can't be changed remotely yet`);
    await this.ensureAttached(sessionId);
    await driver.setConfig(summary.nativeId, optionId, value);
  }

  // ── internals ──────────────────────────────────────────────────────

  private requireDriver(agent: string): AgentDriver {
    const driver = this.drivers.get(agent);
    if (!driver) throw RpcError.app("not_found", `unknown agent ${agent}`);
    const status = driver.status();
    if (!status.installed) throw RpcError.app("agent_unavailable", `${driver.label} is not installed`);
    if (status.problem) throw RpcError.app("agent_unavailable", status.problem);
    return driver;
  }

  private liveFor(sessionId: string): LiveSession {
    let live = this.live.get(sessionId);
    if (!live) {
      live = {
        attached: false,
        subscribers: new Set(),
        messageText: new Map(),
        permissions: new Map(),
        turnActive: false,
      };
      this.live.set(sessionId, live);
    }
    return live;
  }

  /** Never throws synchronously: failures always arrive as a rejected promise. */
  private ensureAttached(sessionId: string): Promise<void> {
    const live = this.liveFor(sessionId);
    if (live.attached) return Promise.resolve();
    if (live.attaching) return live.attaching;
    let summary: SessionSummary;
    let driver: AgentDriver;
    try {
      summary = this.getSession(sessionId);
      driver = this.requireDriver(summary.agent);
    } catch (error) {
      return Promise.reject(error);
    }
    live.buffer = [];
    live.attaching = (async () => {
      try {
        const history = await driver.attach(summary.nativeId, { cwd: summary.cwd });
        // Old turns are not live: replay them quietly and announce the result once.
        const turnActive = live.turnActive;
        live.importing = true;
        live.importChanged = false;
        try {
          // Items without a recorded time get the session's last activity, never "now".
          let ts = summary.createdAt;
          for (const item of history) {
            ts = Math.min(Math.max(item.ts ?? ts, ts), summary.updatedAt);
            if (this.store.isItemLogged(sessionId, item.itemId)) continue;
            for (const update of item.updates) this.commit(sessionId, update, undefined, ts);
            this.store.markItemLogged(sessionId, item.itemId);
          }
        } finally {
          live.importing = false;
          live.turnActive = turnActive;
          const stored = this.store.getSession(sessionId);
          if (live.importChanged && stored) this.emitSummary(stored);
        }
        live.attached = true;
      } finally {
        const buffered = live.buffer ?? [];
        live.buffer = undefined;
        for (const { update, itemId } of buffered) {
          // History already covered this item; skip its completion to avoid a duplicate.
          if (itemId && this.store.isItemLogged(sessionId, itemId)) continue;
          this.commit(sessionId, update, itemId);
        }
        live.attaching = undefined;
      }
    })();
    return live.attaching;
  }

  private recordDiscovered(agent: string, session: DiscoveredSession): void {
    // Deleted in LinkShell: an agent without native delete keeps listing it.
    if (this.store.isRemoved(sessionIdFor(agent, session.nativeId))) return;
    const before = this.store.getSession(sessionIdFor(agent, session.nativeId));
    const { summary, created } = this.store.upsertSession({
      id: sessionIdFor(agent, session.nativeId),
      agent,
      nativeId: session.nativeId,
      cwd: session.cwd,
      title: session.title ? compact(session.title, TITLE_LENGTH) : undefined,
      preview: session.preview ? compact(session.preview, PREVIEW_LENGTH) : undefined,
      model: session.model,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    const changed =
      !!before &&
      (before.title !== summary.title ||
        before.state !== summary.state ||
        before.updatedAt !== summary.updatedAt ||
        before.cwd !== summary.cwd ||
        before.model !== summary.model);
    if (created || changed) this.emitSummary(summary);
  }

  private ingest(sessionId: string, update: SessionUpdate, itemId?: string): void {
    if (!this.store.getSession(sessionId)) {
      this.log(`[hub] dropping update for unknown session ${sessionId}`);
      return;
    }
    const live = this.liveFor(sessionId);
    if (live.buffer) {
      live.buffer.push({ update, itemId });
      return;
    }
    this.commit(sessionId, update, itemId);
  }

  private commit(sessionId: string, update: SessionUpdate, itemId?: string, ts?: number): void {
    const live = this.liveFor(sessionId);
    if (update.sessionUpdate === "ls_permission_resolved" && !live.permissions.has(update.requestId)) return;
    const event = this.store.appendEvent(sessionId, update, ts);
    if (itemId) this.store.markItemLogged(sessionId, itemId);
    this.applyToSummary(sessionId, live, update);
    for (const subscriber of live.subscribers) {
      try {
        subscriber.event(event);
      } catch (error) {
        this.log(`[hub] subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A finished turn can't still be waiting on approvals; clear stale cards.
    if (update.sessionUpdate === "ls_turn" && update.state === "ended") {
      for (const requestId of [...live.permissions.keys()]) {
        this.commit(sessionId, { sessionUpdate: "ls_permission_resolved", requestId });
      }
    }
  }

  private applyToSummary(sessionId: string, live: LiveSession, update: SessionUpdate): void {
    const before = this.store.getSession(sessionId);
    if (!before) return;
    const patch: SessionPatch = {};
    let activityChanged = false;
    const setActivity = (next: SessionActivity | undefined) => {
      if (live.importing || sameActivity(live.activity, next)) return;
      live.activity = next;
      activityChanged = true;
    };
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const text = update.content.type === "text" ? update.content.text : "";
        if (text && !before.title) patch.title = compact(text, TITLE_LENGTH);
        if (text && !before.preview) patch.preview = compact(text, PREVIEW_LENGTH);
        break;
      }
      case "agent_message_chunk":
        if (update.content.type === "text") {
          live.messageText.set(update.messageId, (live.messageText.get(update.messageId) ?? "") + update.content.text);
        }
        if (live.turnActive) setActivity({ kind: "responding" });
        break;
      case "agent_thought_chunk":
        if (live.turnActive) setActivity({ kind: "thinking" });
        break;
      case "tool_call":
        if (live.turnActive) setActivity({ kind: "tool", title: compact(update.title, TITLE_LENGTH), toolKind: update.kind });
        break;
      case "ls_message_done": {
        const text = live.messageText.get(update.messageId);
        live.messageText.delete(update.messageId);
        if (update.role === "agent" && text?.trim()) patch.preview = compact(text, PREVIEW_LENGTH);
        break;
      }
      case "ls_turn":
        live.turnActive = update.state === "started";
        setActivity(live.turnActive ? { kind: "thinking" } : undefined);
        // Leftover permissions are cleared right after a turn ends (see commit).
        patch.state = live.turnActive ? "running" : update.stopReason === "error" ? "error" : "idle";
        break;
      case "ls_status":
        patch.state = update.state;
        break;
      case "ls_permission":
        live.permissions.set(update.requestId, update);
        patch.pendingPermissions = live.permissions.size;
        patch.state = "waiting";
        break;
      case "ls_permission_resolved":
        live.permissions.delete(update.requestId);
        patch.pendingPermissions = live.permissions.size;
        if (live.permissions.size === 0 && before.state === "waiting") patch.state = live.turnActive ? "running" : "idle";
        break;
      case "session_info_update":
        if (update.title) patch.title = compact(update.title, TITLE_LENGTH);
        if (update.model) patch.model = update.model;
        break;
      case "ls_driver":
        patch.driver = update.driver;
        break;
      default:
        break;
    }
    const changed = (Object.keys(patch) as (keyof SessionPatch)[]).filter(
      (key) => patch[key] !== (before as unknown as Record<string, unknown>)[key],
    );
    if (changed.length === 0) {
      if (activityChanged) this.emitSummary(before);
      return;
    }
    if (live.importing) {
      // History keeps its own timestamps; don't make an old session look fresh.
      if (patch.state === "running" || patch.state === "waiting") delete patch.state;
      if (Object.keys(patch).length > 0) this.store.patchSession(sessionId, patch);
      live.importChanged = true;
      return;
    }
    patch.updatedAt = Date.now();
    this.emitSummary(this.store.patchSession(sessionId, patch));
  }

  private emitSummary(stored: SessionSummary): void {
    const summary = this.decorate(stored);
    for (const listener of this.summaryListeners) {
      try {
        listener(summary);
      } catch (error) {
        this.log(`[hub] summary listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
