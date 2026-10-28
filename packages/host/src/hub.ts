import {
  RpcError,
  questionReplies,
  readUserText,
  questionAnswerError,
  updateAsyncQuestions,
  type AsyncQuestion,
  type GoalChange,
  type BackgroundTask,
  sessionIdFor,
  type AgentAuth,
  type AgentInfo,
  type ContentBlock,
  type SessionActivity,
  type SessionEvent,
  type SessionSummary,
  type SessionUpdate,
  type SubagentInfo,
  type QueuedMessage,
  type QuestionAnswer,
  type GitInfo,
  type ProjectSummary,
  type WorktreeEntry,
  type SessionNotice,
  type AcpAgentSettings,
  type AcpRemoteAgent,
  type PendingPermissionSummary,
  type EditorRequest,
  type SideChat,
  type MethodResult,
} from "@linkshell/wire";
import type { AcpSettingsStore } from "./acp-settings.js";
import type {
  AgentDriver,
  DesktopController,
  DesktopLaunchContext,
  DiscoveredSession,
  DriverHost,
  LaunchSpec,
} from "./drivers/types.js";
import { inOrder } from "./drivers/acp/driver.js";
import { canForkNatively } from "./drivers/behavior.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAGE, worktreeOf, type HostStore, type SessionPatch, type WorktreeRecord } from "./store.js";
import { createWorktree, gitBranch, gitInfo, removeWorktree, worktreeState, type CreatedWorktree } from "./worktrees.js";
import { conversationDigest, copied, isConversation } from "./carry.js";
import { slimEvent } from "./slim.js";
import { outputRange } from "./task-output.js";
import { ComputerPreviews } from "./computer-preview.js";
import { MacPreviewCapture } from "./computer-preview-capture.js";
import { SideChats } from "./side.js";

export interface Subscriber {
  event(event: SessionEvent): void;
  notice?(notice: SessionNotice): void;
  /** The backlog that follows starts after `startSeq`, not where the subscriber left off. */
  window?(startSeq: number): void;
}

/**
 * Whether an update is something happening in the session. Names, settings
 * and usage figures arrive when a session is merely opened or renamed, and
 * must not move it to the top of the list.
 */
function isActivity(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "session_info_update":
    case "ls_config":
    case "ls_goal":
    case "available_commands_update":
    case "usage_update":
    // What state a session is in and who drives it are said again whenever it
    // is opened; a turn starting or ending is what counts.
    case "ls_async_questions":
    case "ls_status":
    case "ls_driver":
    // A task's record is said again whenever the session is opened; its end is followed by the agent's turn about it.
    case "ls_task":
      return false;
    default:
      return true;
  }
}

interface SubagentState {
  callDone: boolean;
  turnActive?: boolean;
  /** When the sub-agent last did anything. */
  lastChildTs?: number;
}

/**
 * Whether a sub-agent is working. Its call says so while it is open; an agent
 * that outlives its call (it reports turns of its own) counts while it keeps
 * doing things — a turn left open by an agent that was killed doesn't run forever.
 */
function subagentRunning(state: SubagentState, now = Date.now()): boolean {
  if (!state.callDone) return state.turnActive ?? true;
  return state.turnActive === true && now - (state.lastChildTs ?? 0) < 15 * 60_000;
}

/** A short name for a worktree, from what the session is asked to do. */
function promptLabel(prompt: ContentBlock[] | undefined): string {
  return prompt ? textOf(prompt).slice(0, 40) || "session" : "session";
}

function worktreeLossMessage(state: { dirty: boolean; ahead: number }): string {
  const parts = [state.dirty ? "未提交的改动" : "", state.ahead > 0 ? `${state.ahead} 个新提交` : ""].filter(Boolean);
  return `这个 worktree 里有${parts.join("和")}，删除会丢失`;
}

/** Driver-state key: when a session was renamed, and when it was last active before that. */
const RENAMED = "renamed";

/** Driver-state key: the conversation a forked session's agent is still to be told, with its first message. */
const CARRY = "carry";

/** Driver-state key: the session a session was forked from (made here, or as its agent recorded it). */
const FORKED_FROM = "forkedFrom";

/**
 * Driver-state keys, for agents with an app LinkShell only reads (`appArchive`):
 * LinkShell's own archive choice and when it was made, and the app's state as
 * last seen and since when.
 */
const LOCAL_ARCHIVE = "archive-local";
const APP_ARCHIVE = "archive-app";

/**
 * Archived here or in the app, unless it was unarchived here after the app
 * archived it (`local.at` 0: chosen before times were kept, so it never outranks the app).
 */
export function mergedArchive(local: { archived: boolean; at: number }, app: { archived: boolean; since: number } | undefined): boolean {
  if (local.archived) return true;
  return !!app?.archived && !(local.at > app.since);
}

/** A returning client catches up from where it was, unless it missed more than this. */
const CATCH_UP = { events: 800, bytes: 4 * 1024 * 1024 };

/** State a client needs from before its window: the latest of each applies. */
const STANDING: SessionUpdate["sessionUpdate"][] = [
  "ls_goal",
  "ls_config",
  "available_commands_update",
  "current_mode_update",
  "usage_update",
  "session_info_update",
  "ls_driver",
];

type PermissionUpdate = Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;

interface LiveSession {
  attached: boolean;
  attaching?: Promise<void>;
  /** Being detached because nobody had it open (see `detachWhenIdle`); attaching waits for it. */
  detaching?: Promise<void>;
  /** Live updates that arrive while native history is being imported. */
  buffer?: { update: SessionUpdate; itemId?: string; ts?: number }[];
  subscribers: Set<Subscriber>;
  /** Streaming agent text per message, for the list preview. */
  messageText: Map<string, string>;
  permissions: Map<string, PermissionUpdate>;
  turnActive: boolean;
  /** What the running turn is doing, for list rows (never persisted). */
  activity?: SessionActivity;
  /** Messages the driver holds until the turn ends (never persisted). */
  queue?: QueuedMessage[];
  /** Messages a client asked to hold while a turn runs: sent one per turn end, in this order. */
  held: { clientMessageId: string; content: ContentBlock[] }[];
  sendingHeld?: boolean;
  /** Sub-agents the session started, and whether each is working; read from the log when first needed. */
  subagents?: Map<string, SubagentState>;
  tasks?: Map<string, BackgroundTask>;
  /** True while native history is imported: no live activity, one summary at the end. */
  importing?: boolean;
  importChanged?: boolean;
}

/** How long a session nobody has open stays attached to a driver that pays to follow it. */
const IDLE_DETACH_MS = 10 * 60_000;

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
  private readonly interactionListeners = new Set<(agent: string, request: PendingPermissionSummary | { requestId: string; resolved: true }) => void>();
  private readonly agentListeners = new Set<(agent: AgentInfo) => void>();
  private readonly sideListeners = new Set<(sessionId: string, side: SideChat, closed?: boolean) => void>();
  private readonly sides: SideChats;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly auth = new Map<string, { value: AgentAuth; checkedAt: number }>();
  /** Terminals (`linkshell <agent>`) currently driving handoff sessions. */
  private readonly desktops = new Map<string, DesktopController>();
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private readonly branches = new Map<string, { at: number; branch: Promise<string | undefined> }>();
  private worktreeCache?: WorktreeRecord[];
  private authRefreshing?: Promise<void>;
  readonly previews: ComputerPreviews;

  readonly driverHost: DriverHost = {
    authChanged: (agent) => {
      const driver = this.drivers.get(agent); if (!driver) return;
      void this.refreshAuth(driver).then(() => { const info = this.agents().find((entry) => entry.id === agent); if (info) for (const listener of this.agentListeners) listener(info); }).catch(() => {});
    },
    agentSettings: (agent) => this.acpServices!.settings.settings(agent),
    loginTerminal: async (agent, launch) => {
      if (!this.acpServices) throw RpcError.app("not_supported", "终端登录不可用");
      return this.acpServices.loginTerminal(agent, launch);
    },
    interaction: (agent, request) => { for (const listener of this.interactionListeners) listener(agent, request); },
    notice: (agent, nativeId, notice) => {
      const live = this.live.get(sessionIdFor(agent, nativeId));
      if (!live || live.importing) return;
      for (const subscriber of live.subscribers) subscriber.notice?.(notice);
    },
    tasks: (agent, nativeId) => {
      const id = sessionIdFor(agent, nativeId);
      return this.store.getSession(id) ? this.tasks(id) : [];
    },
    preview: (agent, nativeId, frame) => {
      // Preview is optional: storage or capture failures must not break agent notifications.
      try { void this.previews.put(sessionIdFor(agent, nativeId), frame).catch(() => this.log("[computer-preview] update failed")); }
      catch { this.log("[computer-preview] update failed"); }
    },
    sessionSeen: (agent, session) => this.recordDiscovered(agent, session),
    update: (agent, nativeId, update, itemId, ts) => this.ingest(sessionIdFor(agent, nativeId), update, itemId, ts),
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
    nativeRecordsChanged: (agent, nativeIds) => {
      for (const nativeId of nativeIds) {
        const stored = this.store.getSession(sessionIdFor(agent, nativeId));
        if (!stored) continue;
        const merged = this.reconcileAppArchive(stored);
        this.emitSummary(merged);
        if (merged.archived !== stored.archived) this.announceRelated(merged.id);
      }
    },
    desktop: (agent, nativeId) => this.desktops.get(sessionIdFor(agent, nativeId)),
    state: (agent, nativeId) => {
      const sessionId = sessionIdFor(agent, nativeId);
      return {
        get: (key) => this.store.getDriverState(sessionId, key),
        set: (key, value) => this.store.setDriverState(sessionId, key, value),
      };
    },
    agentState: (agent) => ({
      get: (key) => this.store.getAgentState(agent, key),
      set: (key, value) => this.store.setAgentState(agent, key, value),
    }),
    log: (message) => this.log(message),
  };

  constructor(
    private readonly store: HostStore,
    drivers: AgentDriver[],
    private readonly log: (message: string) => void = () => {},
    /** Where the host keeps its own files: worktrees go under it. */
    private readonly home: string = join(homedir(), ".linkshell"),
    private readonly acpServices?: { settings: AcpSettingsStore; createDriver(agent: AcpRemoteAgent): AgentDriver; loginTerminal(agent: string, launch: LaunchSpec): Promise<{ terminalId: string; exited: Promise<number | null> }> },
  ) {
    if (!acpServices) this.driverHost.agentSettings = undefined;
    const capture = process.platform === "darwin" ? new MacPreviewCapture(log) : undefined;
    this.previews = new ComputerPreviews({
      load: (id) => store.getDriverState(id, "computer-preview"),
      save: (id, value) => store.setDriverState(id, "computer-preview", value),
      exists: (id) => !!store.getSession(id),
      log,
      capture: capture ? (target, frame, failed) => capture.capture(target, frame, failed) : undefined,
    });
    for (const driver of drivers) this.drivers.set(driver.id, driver);
    this.sides = new SideChats((sessionId, side, closed) => {
      for (const listener of this.sideListeners) listener(sessionId, side, closed);
    }, log);
  }

  async start(options: { discoveryIntervalMs?: number } = {}): Promise<void> {
    for (const session of this.store.errorSessions()) {
      const state = this.store.historyFailureRecoveryState(session.id);
      if (state && state !== session.state) this.commit(session.id, { sessionUpdate: "ls_status", state });
    }
    for (const id of this.store.resetLiveSessions()) this.pendingQuestions.delete(id);
    await Promise.all(
      [...this.drivers.values()].map(async (driver) => {
        try {
          const status = await driver.start(this.driverHost);
          if (!status.installed) return;
          await this.refreshAuth(driver);
          if (status.problem) return;
          for (const session of await driver.listSessions(100)) this.recordDiscovered(driver.id, session);
          await this.refreshArchives(driver);
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
          await this.refreshArchives(driver);
        } catch (error) {
          this.log(`[hub] ${driver.id} discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  private async refreshArchives(driver: AgentDriver): Promise<void> {
    for (const nativeId of await driver.archivedSessions?.() ?? []) {
      const before = this.store.getSession(sessionIdFor(driver.id, nativeId));
      // Only reconcile sessions already known here; never import the entire native archive.
      if (!before || (before.archived && before.state === "idle")) continue;
      this.recordDiscovered(driver.id, {
        nativeId, cwd: before.cwd, createdAt: before.createdAt, updatedAt: before.updatedAt,
        archived: true, state: "idle", asyncQuestions: [],
      });
    }
    if (driver.nativeSessionAvailability) {
      for (const session of this.store.sessionsForAgent(driver.id)) this.reconcileNativeSession(driver, session);
    } else if (driver.sessionExists) {
      for (const session of this.store.sessionsForAgent(driver.id)) {
        const live = this.live.get(session.id);
        if (live?.turnActive || session.state === "running" || session.state === "waiting") continue;
        if (!driver.sessionExists(session.nativeId, session.cwd)) {
          this.forget(session.id);
        }
      }
    }
  }

  private reconcileNativeSession(driver: AgentDriver, session: SessionSummary): void {
    if (!driver.nativeSessionAvailability) return;
    const live = this.live.get(session.id);
    if (live?.turnActive || live?.held.length || this.desktops.has(session.id)) return;
    const availability = driver.nativeSessionAvailability(session.nativeId, session.cwd);
    if (availability === "missing") this.hideMissingSession(session);
    else if (availability === "available" && this.store.isNativeMissing(session.id)) {
      this.store.setNativeMissing(session.id, false);
      this.emitSummary(session);
      this.announceRelated(session.id);
    }
  }

  private hideMissingSession(session: SessionSummary): void {
    if (this.store.isNativeMissing(session.id)) return;
    this.store.setNativeMissing(session.id, true);
    this.commit(session.id, { sessionUpdate: "ls_status", state: "offline", turnActive: false });
    this.store.patchSession(session.id, { pendingPermissions: 0 });
    this.store.setDriverState(session.id, "asyncQuestions", "[]");
    this.pendingQuestions.delete(session.id);
    const driver = this.drivers.get(session.agent);
    driver?.watched?.(session.nativeId, false);
    this.live.delete(session.id);
    this.emitRemoved(session.id);
    this.announceRelated(session.id);
    void driver?.detach(session.nativeId).catch((error: unknown) => this.log(`[hub] detach missing ${session.id}: ${String(error)}`));
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await this.sides.stop((sessionId) => this.sideTarget(sessionId));
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.stop()));
    await this.previews.stop();
  }

  // ── side conversations ────────────────────────────────────────────

  onSide(listener: (sessionId: string, side: SideChat, closed?: boolean) => void): () => void {
    this.sideListeners.add(listener);
    return () => this.sideListeners.delete(listener);
  }

  side(sessionId: string, sideId: string | undefined, text: string): SideChat {
    const summary = this.getSession(sessionId);
    return this.sides.ask(sessionId, { driver: this.requireDriver(summary.agent), nativeId: summary.nativeId, cwd: summary.cwd }, sideId, text);
  }

  listSides(sessionId: string): SideChat[] {
    this.getSession(sessionId);
    return this.sides.list(sessionId);
  }

  cancelSide(sessionId: string, sideId: string): void {
    this.sides.cancel(sessionId, sideId);
  }

  async closeSide(sessionId: string, sideId: string): Promise<void> {
    const target = this.sideTarget(sessionId);
    await this.sides.close(sessionId, sideId, target?.driver, target?.nativeId ?? "");
  }

  private sideTarget(sessionId: string): { driver: AgentDriver; nativeId: string } | undefined {
    const summary = this.store.getSession(sessionId);
    const driver = summary && this.drivers.get(summary.agent);
    return summary && driver ? { driver, nativeId: summary.nativeId } : undefined;
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

  onInteraction(listener: (agent: string, request: PendingPermissionSummary | { requestId: string; resolved: true }) => void): () => void {
    this.interactionListeners.add(listener);
    return () => { this.interactionListeners.delete(listener); };
  }
  onAgent(listener: (agent: AgentInfo) => void): () => void { this.agentListeners.add(listener); return () => { this.agentListeners.delete(listener); }; }

  async acpInfo(agent: string, sessionId?: string) {
    const driver = this.requireDriver(agent);
    if (!driver.acpInfo) throw RpcError.app("not_supported", "这个 AI 不使用 ACP");
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (session && session.agent !== agent) throw RpcError.app("invalid_params", "会话与 AI 不匹配");
    return driver.acpInfo(session?.nativeId);
  }

  pendingInteractions() { return [...this.drivers.values()].flatMap((driver) => (driver.pendingInteractions?.() ?? []).map((request) => ({ agent: driver.id, request }))); }

  async editor(input: EditorRequest) {
    const driver = this.requireDriver(input.agent);
    if (!driver.editor) throw RpcError.app("not_supported", "这个 AI 不支持编辑建议");
    return driver.editor(input);
  }

  async configureAcp(agent: string, settings: AcpAgentSettings, sessionId?: string): Promise<void> {
    const driver = this.requireDriver(agent);
    if (!driver.configureAcp || !this.acpServices) throw RpcError.app("not_supported", "这个 AI 不支持 ACP 配置");
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (session && session.agent !== agent) throw RpcError.app("invalid_params", "会话与 AI 不匹配");
    await driver.configureAcp(settings, session?.nativeId);
    if (!session) this.acpServices.settings.setSettings(agent, settings);
  }

  async authenticate(agent: string, methodId?: string, logout?: boolean) {
    const driver = this.requireDriver(agent);
    if (!driver.authenticate) throw RpcError.app("not_supported", "这个 AI 不支持 ACP 登录");
    const result = await driver.authenticate(methodId, logout);
    await this.refreshAuth(driver);
    return result;
  }

  async respondInteraction(agent: string, requestId: string, response: { optionId?: string; answers?: QuestionAnswer[] }): Promise<void> {
    const driver = this.requireDriver(agent);
    if (!driver.respondInteraction) throw RpcError.app("not_supported", "这个 AI 不支持此交互");
    await driver.respondInteraction(requestId, response);
  }

  async providers(agent: string, operation: "list" | "set" | "disable", config?: { providerId: string; apiType?: string; baseUrl?: string; headers?: Record<string, string> }) {
    const driver = this.requireDriver(agent);
    if (!driver.providers) throw RpcError.app("not_supported", "这个 AI 不支持供应商配置");
    return driver.providers(operation, config);
  }

  async customAgents(save?: AcpRemoteAgent, remove?: string): Promise<AcpRemoteAgent[]> {
    const services = this.acpServices;
    if (!services) throw RpcError.app("not_supported", "自定义 ACP 配置不可用");
    if (save && remove) throw RpcError.app("invalid_params", "不能同时保存和移除 Agent");
    const id = save?.id ?? remove;
    if (id) {
      const existing = this.drivers.get(id);
      if (existing && !services.settings.agents().some((agent) => agent.id === id)) throw RpcError.app("invalid_params", "不能覆盖或移除内置 AI");
      const driver = save ? services.createDriver(save) : undefined;
      if (existing) {
        await existing.configureAcp?.(services.settings.settings(id));
        await existing.stop();
        this.drivers.delete(id);
        // What the old definition's agent reported (its models) needn't hold for the new one.
        this.store.clearAgentState(id);
      }
      if (save && driver) { services.settings.saveAgent(save); this.drivers.set(id, driver); await driver.start(this.driverHost); }
      else services.settings.removeAgent(id);
    }
    return services.settings.agents();
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

  /** Projects, each with the branch checked out there now. */
  async listProjects(limit?: number): Promise<ProjectSummary[]> {
    const projects = this.store.listProjects(limit);
    const branches = await Promise.all(projects.map((project) => this.branchOf(project.cwd)));
    return projects.map((project, index) => (branches[index] ? { ...project, branch: branches[index] } : project));
  }

  /** Asked for every project each time the list is: remembered for a moment. */
  private branchOf(cwd: string): Promise<string | undefined> {
    const known = this.branches.get(cwd);
    if (known && Date.now() - known.at < 5000) return known.branch;
    const branch = gitBranch(cwd);
    this.branches.set(cwd, { at: Date.now(), branch });
    if (this.branches.size > 500) this.branches.delete(this.branches.keys().next().value!);
    return branch;
  }

  getSession(sessionId: string): SessionSummary {
    const summary = this.store.getSession(sessionId);
    if (!summary) throw RpcError.app("not_found", `session ${sessionId} not found`);
    if (this.store.isNativeMissing(sessionId)) throw RpcError.app("not_found", "这个会话的原始记录已不存在，已从列表隐藏；本地缓存仍保留。");
    return this.decorate(summary);
  }

  /** A session and its agent's driver, unchecked: for what one driver offers itself (`mcp.*`), which says what it needs of it. */
  sessionDriver(sessionId: string): { session: SessionSummary; driver: AgentDriver | undefined } {
    const session = this.getSession(sessionId);
    return { session, driver: this.drivers.get(session.agent) };
  }

  /** Adds the live-only fields (current activity, first pending permission) to a stored summary. */
  /** Marks a session that works in one of LinkShell's worktrees. */
  private withWorktree(summary: SessionSummary): SessionSummary {
    const worktree = worktreeOf(summary.cwd, this.worktrees());
    return worktree ? { ...summary, worktree: { branch: worktree.branch, source: worktree.sourceCwd } } : summary;
  }

  /** The worktrees table, read once and again whenever it changes. */
  private worktrees(): WorktreeRecord[] {
    return (this.worktreeCache ??= this.store.listWorktrees());
  }

  private readonly pendingQuestions = new Map<string, AsyncQuestion[]>();

  private questionsOf(sessionId: string): AsyncQuestion[] {
    let questions = this.pendingQuestions.get(sessionId);
    if (!questions) {
      questions = JSON.parse(this.store.getDriverState(sessionId, "asyncQuestions") ?? "[]") as AsyncQuestion[];
      this.pendingQuestions.set(sessionId, questions);
    }
    return questions;
  }

  /** Per session, the session it was forked from (null: none), read from the store once. */
  private readonly forkOrigins = new Map<string, string | null>();
  /** Per session, the sessions whose lineage names it: their rows change when it comes or goes. */
  private readonly related = new Map<string, Set<string>>();

  private forkOrigin(sessionId: string): string | undefined {
    let origin = this.forkOrigins.get(sessionId);
    if (origin === undefined) {
      origin = this.store.getDriverState(sessionId, FORKED_FROM) ?? null;
      this.forkOrigins.set(sessionId, origin);
    }
    return origin ?? undefined;
  }

  /** Where the session came from, naming only sessions this host has: a list can't nest under one it doesn't show. */
  private withLineage(summary: SessionSummary): SessionSummary {
    const native = this.drivers.get(summary.agent)?.lineage?.(summary.nativeId);
    const ids = (nativeIds?: string[]) => nativeIds?.map((nativeId) => sessionIdFor(summary.agent, nativeId)) ?? [];
    const origin = this.forkOrigin(summary.id);
    const parentId = this.firstKnown(summary, ids(native?.parent));
    const forkedFrom = this.firstKnown(summary, [...(origin ? [origin] : []), ...ids(native?.forkedFrom)]);
    const appId = native?.appId;
    if (!parentId && !forkedFrom && !appId) return summary;
    return { ...summary, ...(parentId ? { parentId } : {}), ...(forkedFrom ? { forkedFrom } : {}), ...(appId ? { appId } : {}) };
  }

  /** As the Claude app nests: a session still in use stands alone when the one it came from is archived. */
  private firstKnown(summary: SessionSummary, candidates: string[]): string | undefined {
    let found: string | undefined;
    for (const candidate of candidates) {
      if (candidate === summary.id) continue;
      let children = this.related.get(candidate);
      if (!children) this.related.set(candidate, (children = new Set()));
      children.add(summary.id);
      if (found) continue;
      const other = this.store.getSession(candidate);
      if (other && !(other.archived && !summary.archived) && !this.store.isNativeMissing(candidate)) found = candidate;
    }
    return found;
  }

  /** The session came, went or was (un)archived: the rows that name it as parent or origin say so now. */
  private announceRelated(sessionId: string): void {
    for (const child of this.related.get(sessionId) ?? []) this.announce(child);
  }

  private decorate(summary: SessionSummary): SessionSummary {
    summary = this.withLineage({ ...summary, asyncQuestions: this.questionsOf(summary.id) });
    const live = this.live.get(summary.id);
    if (!live) return this.withWorktree(summary);
    const activity = live.turnActive ? live.activity : undefined;
    const first = live.permissions.values().next().value as PermissionUpdate | undefined;
    const tasks = this.tasksOf(summary.id, live);
    const subagents = live.attached ? this.subagentsOf(summary.id, live) : undefined;
    summary = this.withWorktree(summary);
    if (!activity && !first && !live.queue && live.held.length === 0 && !subagents?.size && !tasks.size) return summary;
    const decorated: SessionSummary = { ...summary };
    if (tasks.size) decorated.tasks = { total: tasks.size, running: [...tasks.values()].filter((task) => task.state === "running").length };
    if (subagents?.size) {
      let running = 0;
      for (const state of subagents.values()) if (subagentRunning(state)) running += 1;
      decorated.subagents = { total: subagents.size, running };
    }
    if (live.queue || live.held.length > 0) {
      decorated.queue = [
        ...(live.queue ?? []),
        ...live.held.map((entry) => ({
          clientMessageId: entry.clientMessageId,
          text: textOf(entry.content),
          images: entry.content.filter((block) => block.type === "image").length,
        })),
      ];
    }
    if (activity) decorated.activity = activity;
    if (first) {
      decorated.permission = {
        requestId: first.requestId,
        childSessionId: first.childSessionId,
        toolCallId: first.toolCallId,
        title: first.title,
        detail: first.detail,
        tool: first.tool,
        url: first.url,
        options: first.options,
        questions: first.questions,
      };
    }
    return decorated;
  }

  /** What a new session of `agent` could run on (see `agents.models`): nothing from a driver that can't tell before a session exists. */
  async agentModels(agent: string, cwd?: string): Promise<MethodResult<"agents.models">> {
    const driver = this.requireDriver(agent);
    return (await driver.listModels?.(cwd)) ?? { models: [] };
  }

  async createSession(input: {
    agent: string;
    cwd: string;
    model?: string;
    prompt?: ContentBlock[];
    clientMessageId?: string;
    /** Start in a new git worktree of `cwd`'s repository. */
    worktree?: boolean;
  }): Promise<SessionSummary> {
    const driver = this.requireDriver(input.agent);
    const worktree = input.worktree ? await this.newWorktree(input.cwd, promptLabel(input.prompt)) : undefined;
    const discovered = await driver.createSession({ cwd: worktree?.cwd ?? input.cwd, model: input.model }).catch(async (error: unknown) => {
      // The app shows "not logged in" from the agent list; make it current.
      if (error instanceof RpcError && error.appCode === "not_logged_in") await this.refreshAuth(driver);
      if (worktree) await this.dropWorktree(worktree.path);
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
   * A new session that starts with this one's conversation: all of it, or
   * through the turn `itemId` is in. With `worktree` it works in a new git
   * worktree of the project.
   */
  async fork(sessionId: string, options: { itemId?: string; worktree?: boolean } = {}): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    if (driver.behavior.desktop === "terminal") throw RpcError.app("not_supported", `${driver.label} 不支持从会话分叉`);
    let upTo: { itemId: string; turn: number } | undefined;
    let cut = summary.lastSeq;
    if (options.itemId) {
      const located = this.store.locateItem(sessionId, options.itemId);
      if (!located) throw RpcError.app("not_found", "找不到要分叉的那条消息");
      upTo = { itemId: options.itemId, turn: located.turn };
      cut = this.store.turnEnd(sessionId, located.seq);
    }
    // A fork of a worktree session made into a new worktree branches from the project, like its original did.
    const origin = worktreeOf(summary.cwd, this.store.listWorktrees());
    const worktree = options.worktree ? await this.newWorktree(origin?.sourceCwd ?? summary.cwd, summary.title ?? "fork") : undefined;
    const cwd = worktree?.cwd ?? summary.cwd;
    try {
      let discovered: DiscoveredSession | undefined;
      if (driver.fork && (driver.behavior.fork === "unresolved" || canForkNatively(driver.behavior, Boolean(upTo)))) {
        discovered = await driver.fork(summary.nativeId, { cwd, sourceCwd: summary.cwd, upTo }).catch((error: unknown) => {
          // The agent forks, but not this way (only whole sessions, say): the fork is made by us instead.
          if (error instanceof RpcError && error.appCode === "not_supported") return undefined;
          throw error;
        });
      }
      if (!discovered) return await this.forkByReplay(summary, driver, cwd, cut);
      this.recordDiscovered(driver.id, { ...discovered, title: discovered.title ?? summary.title, forkedFrom: summary.nativeId });
      return this.getSession(sessionIdFor(driver.id, discovered.nativeId));
    } catch (error) {
      if (worktree) await this.dropWorktree(worktree.path);
      throw error;
    }
  }

  /**
   * A fork for an agent that can't fork a session itself: a new session that
   * shows the conversation up to `cut` (its latest page, from our log), whose
   * agent is told that conversation with the first message sent to it.
   */
  private async forkByReplay(summary: SessionSummary, driver: AgentDriver, cwd: string, cut: number): Promise<SessionSummary> {
    const start = this.store.pageStart(summary.id, cut);
    const events = this.store.readEvents(summary.id, start, PAGE.maxEvents + 1, cut).filter((event) => isConversation(event.update));
    const discovered = await driver.createSession({ cwd });
    this.recordDiscovered(driver.id, { ...discovered, title: discovered.title ?? summary.title, forkedFrom: summary.nativeId });
    const forkId = sessionIdFor(driver.id, discovered.nativeId);
    await this.ensureAttached(forkId);
    const live = this.liveFor(forkId);
    live.importing = true;
    try {
      // Pictures and long output stay in the original; the fork's own log starts light.
      for (const event of events) this.commit(forkId, copied(slimEvent(event).update), undefined, event.ts);
    } finally {
      live.importing = false;
    }
    this.commit(forkId, {
      sessionUpdate: "ls_notice",
      level: "info",
      title: "分叉的会话",
      detail: `之前的对话以文字交给 ${driver.label}${start > 0 ? "，更早的内容在原会话里" : ""}`,
    });
    const digest = conversationDigest(events);
    if (digest) this.store.setDriverState(forkId, CARRY, digest);
    return this.getSession(forkId);
  }

  /** Hands a message to the agent — with the conversation a forked session still owes it, the first time. */
  private deliver(summary: SessionSummary, driver: AgentDriver, content: ContentBlock[], clientMessageId: string): Promise<"started" | "steered" | "queued"> {
    const carry = this.store.getDriverState(summary.id, CARRY);
    if (!carry) return driver.prompt(summary.nativeId, content, clientMessageId);
    return driver.prompt(summary.nativeId, content, clientMessageId, carry).then((delivery) => {
      this.store.setDriverState(summary.id, CARRY, "");
      return delivery;
    });
  }

  // ── worktrees ─────────────────────────────────────────────────────

  gitInfo(path: string): Promise<GitInfo | undefined> {
    return gitInfo(path);
  }

  private async newWorktree(cwd: string, label: string): Promise<CreatedWorktree> {
    const created = await createWorktree(cwd, this.home, label);
    this.store.saveWorktree({ path: created.path, branch: created.branch, source: created.source, sourceCwd: cwd, base: created.base, createdAt: Date.now() });
    this.worktreeCache = undefined;
    return created;
  }

  private async dropWorktree(path: string): Promise<void> {
    const worktree = this.store.listWorktrees().find((entry) => entry.path === path);
    if (!worktree) return;
    await removeWorktree(worktree).catch((error: unknown) => this.log(`[hub] couldn't remove worktree ${path}: ${String(error)}`));
    this.store.deleteWorktree(path);
    this.worktreeCache = undefined;
  }

  async listWorktrees(): Promise<WorktreeEntry[]> {
    return Promise.all(
      this.store.listWorktrees().map(async (worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        source: worktree.sourceCwd,
        createdAt: worktree.createdAt,
        sessions: this.store.sessionsUnder(worktree.path),
        ...(await worktreeState(worktree.path, worktree.base)),
      })),
    );
  }

  /** Removes a worktree and its branch, unless a session uses it or (without `force`) work in it would be lost. */
  async removeWorktree(path: string, force = false): Promise<void> {
    const worktree = this.store.listWorktrees().find((entry) => entry.path === path);
    if (!worktree) throw RpcError.app("not_found", "没有这个 worktree");
    if (this.store.sessionsUnder(path).length > 0) throw RpcError.app("busy", "还有会话在用这个 worktree：先删除那些会话");
    if (!force) {
      const state = await worktreeState(path, worktree.base);
      if (state.dirty || state.ahead > 0) throw RpcError.app("dirty", worktreeLossMessage(state));
    }
    await this.dropWorktree(path);
  }

  /**
   * Sends the backlog, then streams live events. A fresh subscriber (or one too
   * far behind to catch up) gets the latest turns only, after the standing
   * state from before them; earlier history is read in pages (`history`).
   * The backlog read and the subscriber registration happen in one synchronous
   * step, so no event can fall between them.
   */
  async subscribe(sessionId: string, fromSeq: number, subscriber: Subscriber, options: { latest?: boolean } = {}): Promise<{ session: SessionSummary; startSeq: number }> {
    const summary = this.getSession(sessionId);
    const driver = this.drivers.get(summary.agent);
    if (driver && driver.status().installed) {
      this.reconcileNativeSession(driver, summary);
      this.getSession(sessionId);
      try {
        await this.ensureAttached(sessionId);
      } catch (error) {
        // Serve the log we have; not_ready sessions attach once they get a turn.
        if (!(error instanceof RpcError && error.appCode === "not_ready")) {
          this.log(`[hub] attach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
          this.reconcileNativeSession(driver, summary);
          this.getSession(sessionId);
          subscriber.notice?.({ severity: "warning", title: "暂时无法读取会话历史",
            description: `${error instanceof Error ? error.message : String(error)}\n已缓存的消息仍可查看，重新打开会话可重试。` });
        }
      }
    }
    const live = this.liveFor(sessionId);
    if (driver?.behavior.desktop === "handoff") this.lendCommands(this.getSession(sessionId));
    // Old clients may still hold the synthetic error cards in memory; replay a clean window.
    if (fromSeq > 0 && this.store.hasHistoryLoadErrors(sessionId)) {
      fromSeq = 0;
      subscriber.window?.(0);
    }
    const lastSeq = this.store.getSession(sessionId)?.lastSeq ?? 0;
    let startSeq = fromSeq;
    const missed = fromSeq > 0 && fromSeq <= lastSeq ? this.store.sizeAfter(sessionId, fromSeq) : undefined;
    const budget = options.latest ? { events: PAGE.minEvents, bytes: PAGE.minBytes } : CATCH_UP;
    if (!missed || missed.events > budget.events || missed.bytes > budget.bytes) {
      const page = this.store.pageStart(sessionId, lastSeq);
      // The latest page reaches back to where the client is anyway: catching up is the same, and smaller.
      if (!missed || !options.latest || page > fromSeq) {
        startSeq = page;
        if (startSeq !== fromSeq) subscriber.window?.(startSeq);
        for (const event of this.standingBefore(sessionId, startSeq, live)) subscriber.event(event);
      }
    }
    let cursor = startSeq;
    for (;;) {
      const batch = this.store.readEvents(sessionId, cursor, 200);
      for (const event of batch) if (!this.store.isHistoryLoadEvent(event)) subscriber.event(event);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
    }
    live.subscribers.add(subscriber);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
    if (live.subscribers.size === 1) driver?.watched?.(summary.nativeId, true);
    return { session: this.getSession(sessionId), startSeq };
  }

  /**
   * A handoff agent names its commands only once it runs here, so a session
   * still driven at the desk has none to offer. It borrows the list of the
   * agent's latest session in the same folder (or its latest anywhere) until
   * it gets its own: `/compact` typed on the phone works from the first message.
   */
  private lendCommands(summary: SessionSummary): void {
    const kind = "available_commands_update" as const;
    if (this.store.latestOfKind(summary.id, kind, summary.lastSeq).length > 0) return;
    let found: SessionEvent | undefined;
    for (const other of this.store.listSessions({ limit: 80, includeArchived: true })) {
      if (other.agent !== summary.agent || other.id === summary.id) continue;
      const [event] = this.store.latestOfKind(other.id, kind, other.lastSeq);
      if (!event) continue;
      found ??= event;
      if (other.cwd === summary.cwd) {
        found = event;
        break;
      }
    }
    if (found) this.commit(summary.id, found.update);
  }

  /** The page of history before `beforeSeq`, oldest first. */
  history(sessionId: string, beforeSeq: number): { events: SessionEvent[]; startSeq: number } {
    this.getSession(sessionId);
    const upTo = beforeSeq - 1;
    if (upTo < 1) return { events: [], startSeq: 0 };
    const startSeq = this.store.pageStart(sessionId, upTo);
    return { events: this.store.readEvents(sessionId, startSeq, PAGE.maxEvents + 1, upTo).filter((event) => !this.store.isHistoryLoadEvent(event)), startSeq };
  }

  tasks(sessionId: string): BackgroundTask[] {
    if (!this.store.getSession(sessionId)) throw RpcError.app("not_found", "找不到这个会话");
    const tasks = new Map<string, BackgroundTask>();
    for (const event of this.store.taskEvents(sessionId)) {
      if (event.update.sessionUpdate === "ls_task") tasks.set(event.update.task.id, { ...event.update.task, lastSeq: event.seq });
    }
    return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private tasksOf(sessionId: string, live: LiveSession): Map<string, BackgroundTask> {
    return live.tasks ??= new Map(this.tasks(sessionId).map((task) => [task.id, task]));
  }

  taskOutput(sessionId: string, taskId: string, before?: number, limit = 64 * 1024) {
    const summary = this.getSession(sessionId);
    const task = this.tasks(sessionId).find((entry) => entry.id === taskId);
    if (!task) throw RpcError.app("not_found", "这个任务已经不在会话记录里");
    const output = this.requireDriver(summary.agent).taskOutput?.(summary.nativeId, taskId, before, limit);
    if (output) return output;
    let text = "";
    for (const event of task.toolCallId ? this.store.toolEvents(sessionId, task.toolCallId) : []) {
      const update = event.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
      if (update.sessionUpdate === "tool_call_update" && update.appendOutput) text += update.appendOutput;
      const whole = update.content?.flatMap((block) => block.type === "content" && block.content.type === "text" ? [block.content.text] : []).join("\n");
      if (whole) text = whole;
      const aggregate = update.sessionUpdate === "tool_call_update" ? (update.rawOutput as { aggregatedOutput?: unknown } | undefined)?.aggregatedOutput : undefined;
      if (typeof aggregate === "string") text = aggregate;
    }
    return outputRange(Buffer.from(text), before, limit);
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const summary = this.getSession(sessionId);
    const task = this.tasks(sessionId).find((entry) => entry.id === taskId);
    if (!task) throw RpcError.app("not_found", "这个任务已经不在会话记录里");
    if (task.state !== "running") throw RpcError.app("busy", "这个任务已经结束了");
    const driver = this.requireDriver(summary.agent);
    if (!task.canStop || !driver.stopTask) throw RpcError.app("not_supported", "这个任务不能在手机上停止");
    await driver.stopTask(summary.nativeId, taskId);
  }

  /** The sub-agents the session started, newest first. */
  subagents(sessionId: string): SubagentInfo[] {
    this.getSession(sessionId);
    const agents = new Map<string, SubagentInfo>();
    for (const event of this.store.subagentCalls(sessionId)) {
      const call = event.update as Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
      // (A call still open when the session was opened again is logged again.)
      if (agents.has(call.toolCallId)) continue;
      const detailEvent = this.store.toolDetail(sessionId, call.toolCallId);
      const latest = detailEvent?.update as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> | undefined;
      const detail = latest?.detail?.type === "subagent" ? latest.detail : call.detail?.type === "subagent" ? call.detail : undefined;
      const state = this.store.toolState(sessionId, call.toolCallId);
      const callDone = state.status === "completed" || state.status === "failed";
      const workflow = detail?.workflow && !detail.workflow.state && state.status === "failed"
        ? { ...detail.workflow, state: "failed" as const, endedAt: state.ts }
        : detail?.workflow;
      const running = workflow?.state ? workflow.state === "running" || workflow.state === "paused" || workflow.agents?.some((agent) => agent.state === "running" || agent.state === "paused") === true
        : detail?.state ? detail.state === "running" || detail.state === "paused" || detail.state === "pending"
        : subagentRunning({ callDone, turnActive: state.turnActive, lastChildTs: state.lastChildTs });
      agents.set(call.toolCallId, {
        toolCallId: call.toolCallId,
        parentToolCallId: call.parentToolCallId,
        task: detail?.task ?? call.title,
        agentType: detail?.agentType,
        name: detail?.name,
        nativeSessionId: detail?.nativeSessionId,
        canCancel: detail?.canCancel,
        running,
        failed: (workflow?.state ? workflow.state === "failed" : detail?.state ? detail.state === "failed" : state.status === "failed") || undefined,
        startedAt: workflow?.startedAt ?? event.ts,
        endedAt: running ? undefined : workflow?.endedAt ?? (callDone ? state.ts : state.lastChildTs),
        state: detail?.state,
        workflow,
        lastSeq: Math.max(detailEvent?.seq ?? event.seq, state.seq ?? 0),
      });
    }
    return [...agents.values()].reverse();
  }

  async cancelSubagent(sessionId: string, nativeSessionId: string): Promise<void> {
    const session = this.getSession(sessionId), driver = this.requireDriver(session.agent);
    if (!driver.cancelSubagent) throw RpcError.app("not_supported", "这个 AI 不支持单独停止子代理");
    await this.ensureAttached(sessionId);
    await driver.cancelSubagent(session.nativeId, nativeSessionId);
  }

  private subagentsOf(sessionId: string, live: LiveSession): NonNullable<LiveSession["subagents"]> {
    if (!live.subagents) {
      live.subagents = new Map();
      for (const event of this.store.subagentCalls(sessionId)) {
        const { toolCallId } = event.update as { toolCallId: string };
        const state = this.store.toolState(sessionId, toolCallId);
        live.subagents.set(toolCallId, {
          callDone: state.status === "completed" || state.status === "failed",
          turnActive: state.turnActive,
          lastChildTs: state.lastChildTs,
        });
      }
    }
    return live.subagents;
  }

  /** Keeps the sub-agent tally current; true when it changed. */
  private trackSubagent(live: LiveSession, update: SessionUpdate): boolean {
    const known = live.subagents;
    if (!known) return false;
    if (update.sessionUpdate === "tool_call" && update.detail?.type === "subagent" && (update.detail.action ?? "spawn") === "spawn") {
      if (known.has(update.toolCallId)) return false;
      known.set(update.toolCallId, { callDone: update.status === "completed" || update.status === "failed" });
      return true;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const state = known.get(update.toolCallId);
      if (!state || update.status === undefined) return false;
      const done = update.status === "completed" || update.status === "failed";
      if (state.callDone === done) return false;
      // A corrected launch or a teammate's next turn can reopen the same call.
      state.callDone = done;
      return true;
    }
    const parent = (update as { parentToolCallId?: string }).parentToolCallId;
    const state = parent ? known.get(parent) : undefined;
    if (!state) return false;
    const was = subagentRunning(state);
    state.lastChildTs = Date.now();
    if (update.sessionUpdate === "ls_turn") state.turnActive = update.state === "started";
    return subagentRunning(state) !== was;
  }

  /** A sub-agent's conversation: its call, then what happened under it. */
  subagent(sessionId: string, toolCallId: string): SessionEvent[] {
    this.getSession(sessionId);
    const own = this.store.toolEvents(sessionId, toolCallId);
    if (own.length === 0) throw RpcError.app("not_found", "这个子 Agent 已经不在会话记录里");
    return [...own, ...this.store.eventsUnder(sessionId, toolCallId, 2000)].sort((a, b) => a.seq - b.seq);
  }

  readEvent(sessionId: string, seq: number): SessionEvent | undefined {
    this.getSession(sessionId);
    return this.store.readEvent(sessionId, seq);
  }

  /** What still holds at `seq` from the events before it: settings, an open turn, unanswered approvals. */
  private standingBefore(sessionId: string, seq: number, live: LiveSession): SessionEvent[] {
    if (seq < 1) return [];
    const events = STANDING.flatMap((kind) => this.store.latestOfKind(sessionId, kind, seq));
    const [turn] = this.store.latestOfKind(sessionId, "ls_turn", seq);
    const [status] = this.store.latestOfKind(sessionId, "ls_status", seq);
    const statusEndedTurn =
      status &&
      turn &&
      status.seq > turn.seq &&
      status.update.sessionUpdate === "ls_status" &&
      (status.update.turnActive === false || (status.update.state !== "running" && status.update.state !== "waiting"));
    if (turn?.update.sessionUpdate === "ls_turn" && turn.update.state === "started" && !statusEndedTurn) events.push(turn);
    if (live.permissions.size > 0) {
      for (const event of this.store.latestOfKind(sessionId, "ls_permission", seq, 50)) {
        if (event.update.sessionUpdate === "ls_permission" && live.permissions.has(event.update.requestId)) events.push(event);
      }
    }
    // Sub-agents still working were started before the window: their calls, so
    // what they do next has its card to go under.
    for (const [toolCallId, state] of this.subagentsOf(sessionId, live)) {
      if (!subagentRunning(state)) continue;
      const call = this.store.toolEvents(sessionId, toolCallId)[0];
      if (call && call.seq <= seq) events.push(call);
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  unsubscribe(sessionId: string, subscriber: Subscriber): void {
    const live = this.live.get(sessionId);
    if (!live?.subscribers.delete(subscriber) || live.subscribers.size > 0) return;
    const summary = this.store.getSession(sessionId);
    if (summary) this.drivers.get(summary.agent)?.watched?.(summary.nativeId, false);
    this.detachWhenIdle(sessionId);
  }

  /**
   * Detaches a session nobody has open, from a driver that pays to follow it, once it has been
   * left alone a while with nothing under way. Without this every session opened since the host
   * started stays followed for good.
   */
  private detachWhenIdle(sessionId: string, delay = IDLE_DETACH_MS): void {
    const summary = this.store.getSession(sessionId);
    const driver = summary && this.drivers.get(summary.agent);
    if (!summary || !driver?.detachWhenIdle) return;
    clearTimeout(this.idleTimers.get(sessionId));
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const live = this.live.get(sessionId);
      if (!live || live.subscribers.size > 0 || !live.attached || live.attaching || live.detaching) return;
      const tasks = this.tasksOf(sessionId, live);
      const working = live.turnActive || live.permissions.size > 0 || !!live.queue?.length || live.held.length > 0
        || [...tasks.values()].some((task) => task.state === "running")
        || [...(live.subagents?.values() ?? [])].some((state) => subagentRunning(state));
      // Something is under way: looked at again later.
      if (working) return this.detachWhenIdle(sessionId, delay);
      live.attached = false;
      live.detaching = driver.detach(summary.nativeId)
        .catch((error: unknown) => this.log(`[hub] idle detach ${sessionId}: ${String(error)}`))
        .finally(() => { live.detaching = undefined; });
    }, delay);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  async prompt(
    sessionId: string,
    clientMessageId: string,
    content: ContentBlock[],
    whenBusy?: "queue",
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
    const live = this.liveFor(sessionId);
    // An answer belongs in the turn that asked it, even from an older client using the normal queue.
    // A Claude on the computer waiting on its question waits for nothing else: anything sent answers it.
    const answersQuestion =
      (summary.agent === "codex" && content.length === 1 && content[0]?.type === "text" && questionReplies(content[0].text)) ||
      (summary.agent === "claude" && this.questionsOf(sessionId).length > 0);
    if (whenBusy === "queue" && !answersQuestion && (live.turnActive || live.held.length > 0)) {
      live.held.push({ clientMessageId, content });
      this.announce(sessionId);
      return "queued";
    }
    let delivery: "started" | "steered" | "queued";
    try {
      delivery = await this.deliver(summary, driver, content, clientMessageId);
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
    const live = this.liveFor(sessionId);
    const held = live.held.findIndex((entry) => entry.clientMessageId === clientMessageId);
    if (held >= 0) {
      live.held.splice(held, 1);
      this.announce(sessionId);
    }
    const removed = held >= 0 || (driver.unqueue?.(summary.nativeId, clientMessageId) ?? false);
    // Sent again later, it should go through.
    if (removed) this.store.releaseClientMessage(sessionId, clientMessageId);
    return removed;
  }

  reorderQueue(sessionId: string, clientMessageIds: string[]): void {
    const summary = this.getSession(sessionId);
    const live = this.liveFor(sessionId);
    live.held = inOrder(live.held, clientMessageIds);
    this.requireDriver(summary.agent).reorderQueue?.(summary.nativeId, clientMessageIds);
    this.announce(sessionId);
  }

  /**
   * Sends a queued message without waiting for the running turn to end: into
   * that turn if the agent takes input mid-turn, otherwise by stopping it.
   */
  async sendQueuedNow(sessionId: string, clientMessageId?: string): Promise<void> {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    const live = this.liveFor(sessionId);
    const index = clientMessageId ? live.held.findIndex((entry) => entry.clientMessageId === clientMessageId) : 0;
    const item = live.held[index];
    if (!item) {
      // Held by the driver (another Claude is mid-turn in the session), or already gone.
      await driver.sendQueuedNow?.(summary.nativeId, clientMessageId);
      return;
    }
    live.held.splice(index, 1);
    if (live.turnActive && driver.behavior.busyInput === "queue") {
      // The turn has to end first: stop it, and this message is next.
      live.held.unshift(item);
      this.announce(sessionId);
      await driver.cancel(summary.nativeId);
      return;
    }
    this.announce(sessionId);
    try {
      const delivery = await this.deliver(summary, driver, item.content, item.clientMessageId);
      if (delivery === "queued") await driver.sendQueuedNow?.(summary.nativeId, item.clientMessageId);
    } catch (error) {
      live.held.unshift(item);
      this.announce(sessionId);
      throw error;
    }
  }

  /** A turn ended: the next held message starts the following one. */
  private async sendHeld(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    const summary = this.store.getSession(sessionId);
    if (!live || !summary || live.held.length === 0 || live.turnActive || live.sendingHeld) return;
    const driver = this.drivers.get(summary.agent);
    if (!driver) return;
    const next = live.held.shift()!;
    live.sendingHeld = true;
    this.announce(sessionId);
    try {
      await this.deliver(summary, driver, next.content, next.clientMessageId);
    } catch (error) {
      this.store.releaseClientMessage(sessionId, next.clientMessageId);
      this.commit(sessionId, {
        sessionUpdate: "ls_error",
        code: error instanceof RpcError ? (error.appCode ?? "send_failed") : "send_failed",
        message: `排队的消息没能发出：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      live.sendingHeld = false;
    }
  }

  onRemoved(listener: (sessionId: string) => void): () => void {
    this.removedListeners.add(listener);
    // A reconnecting client can retain sessions outside the first discovery page.
    for (const id of this.store.nativeMissingSessionIds()) listener(id);
    return () => this.removedListeners.delete(listener);
  }

  async archive(sessionId: string, archived: boolean): Promise<SessionSummary> {
    const summary = this.getSession(sessionId);
    const driver = this.drivers.get(summary.agent);
    if (driver?.archive) await driver.archive(summary.nativeId, archived);
    // Kept apart from the app's, with when: unarchiving here outranks an older archive there.
    if (driver?.appArchive) this.store.setDriverState(sessionId, LOCAL_ARCHIVE, JSON.stringify({ archived, at: Date.now() }));
    const updated = this.reconcileAppArchive(this.store.patchSession(sessionId, { archived }));
    this.emitSummary(updated);
    this.announceRelated(sessionId);
    return this.decorate(updated);
  }

  /** Folds in the archive state of the agent's app that LinkShell only reads (see `mergedArchive`). */
  private reconcileAppArchive(summary: SessionSummary): SessionSummary {
    const reported = this.drivers.get(summary.agent)?.appArchive?.(summary.nativeId);
    // Not in that app (or not read yet): the flag is LinkShell's alone, or stays as last merged.
    if (!reported) return summary;
    const saved = this.store.getDriverState(summary.id, APP_ARCHIVE);
    const seen = saved ? JSON.parse(saved) as { archived: boolean; since: number } : undefined;
    if (!seen && !reported.archived) return summary;
    // Only a change counts as the app archiving it: the app rewrites its record for much else.
    const app = seen?.archived === reported.archived ? seen : { archived: reported.archived, since: reported.at };
    if (app !== seen) this.store.setDriverState(summary.id, APP_ARCHIVE, JSON.stringify(app));
    const archived = mergedArchive(this.localArchive(summary), app);
    return archived === summary.archived ? summary : this.store.patchSession(summary.id, { archived });
  }

  private localArchive(summary: SessionSummary): { archived: boolean; at: number } {
    const saved = this.store.getDriverState(summary.id, LOCAL_ARCHIVE);
    if (saved) return JSON.parse(saved) as { archived: boolean; at: number };
    // Until the app's state is first merged in, the flag is LinkShell's own choice.
    const local = { archived: summary.archived, at: 0 };
    this.store.setDriverState(summary.id, LOCAL_ARCHIVE, JSON.stringify(local));
    return local;
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
    // The agent writing its own title record touches the session: for the next
    // few seconds a newer "last updated" from it is the rename, not activity.
    this.store.setDriverState(sessionId, RENAMED, JSON.stringify({ updatedAt: summary.updatedAt, until: Date.now() + 5000 }));
    const updated = this.store.patchSession(sessionId, { customTitle: name || null });
    this.emitSummary(updated);
    return this.decorate(updated);
  }

  /**
   * Deletes a session. A worktree only it used goes too when nothing in it
   * would be lost (or `worktree` says "remove"); "keep" leaves it.
   */
  async delete(sessionId: string, worktree?: "keep" | "remove"): Promise<void> {
    const summary = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    if (live?.turnActive || summary.state === "running") throw RpcError.app("busy", "这个会话正在运行：先停止，再删除");
    if (this.desktops.has(sessionId)) throw RpcError.app("busy", "这个会话正在电脑终端里使用：先在电脑上退出，再删除");
    const driver = this.drivers.get(summary.agent);
    if (driver) {
      await driver.detach(summary.nativeId).catch(() => {});
      if (driver.delete) {
        await driver.delete(summary.nativeId).catch((error: unknown) => {
          // Already gone on the agent's side (deleted there): only our record is left to remove.
          if (!/no rollout|not found|unknown (thread|session)|no conversation found/i.test(error instanceof Error ? error.message : String(error))) throw error;
        });
      }
    }
    this.forget(sessionId);
    const own = worktreeOf(summary.cwd, this.store.listWorktrees());
    if (!own || worktree === "keep" || this.store.sessionsUnder(own.path).length > 0) return;
    const state = await worktreeState(own.path, own.base);
    if (worktree === "remove" || (!state.dirty && state.ahead === 0)) await this.dropWorktree(own.path);
  }

  /** Drops a session from LinkShell and tells every client. */
  private forget(sessionId: string): void {
    if (!this.store.getSession(sessionId)) return;
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
    this.live.delete(sessionId);
    this.previews.forget(sessionId);
    this.sides.forget(sessionId);
    this.store.removeSession(sessionId);
    this.forkOrigins.delete(sessionId);
    this.emitRemoved(sessionId);
    this.announceRelated(sessionId);
  }

  private emitRemoved(sessionId: string): void {
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
    // Stopping stops what's waiting too; the apps put queued text back in the composer.
    const live = this.liveFor(sessionId);
    if (live.held.length > 0) {
      for (const entry of live.held) this.store.releaseClientMessage(sessionId, entry.clientMessageId);
      live.held = [];
      this.announce(sessionId);
    }
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

  /** Answers the questions an agent is waiting on. */
  async answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const summary = this.getSession(sessionId);
    const request = this.live.get(sessionId)?.permissions.get(requestId);
    if (!request?.questions) throw RpcError.app("not_found", "这个问题已经不在等回答了");
    const driver = this.requireDriver(summary.agent);
    if (!driver.answerQuestion) throw RpcError.app("not_supported", `${driver.label} 不能在这里回答问题`);
    // Only what was asked: answers to its questions, with values the question offers.
    const kept = request.questions.flatMap((question): QuestionAnswer[] => {
      const answer = answers.find((entry) => entry.id === question.id);
      if (!answer) return [];
      const offered = question.options ? new Set(question.options.map((option) => option.value)) : undefined;
      const values = (offered ? answer.values.filter((value) => offered.has(value)) : answer.values).slice(0, question.kind === "choices" ? 50 : 1);
      const other = question.other ? answer.other?.trim() || undefined : undefined;
      return [{ id: question.id, values, other }];
    });
    for (const question of request.questions) {
      const error = questionAnswerError(question, kept.find((answer) => answer.id === question.id));
      if (error) throw RpcError.app("invalid_params", error);
    }
    await driver.answerQuestion(summary.nativeId, requestId, kept);
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

  async goal(sessionId: string, change: GoalChange) {
    const summary = this.getSession(sessionId);
    const driver = this.requireDriver(summary.agent);
    if (!driver.goal) throw RpcError.app("not_supported", "这个 Agent 通过 /goal 命令管理目标");
    await this.ensureAttached(sessionId);
    return { goal: await driver.goal(summary.nativeId, change) };
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
        held: [],
      };
      this.live.set(sessionId, live);
    }
    return live;
  }

  /** Never throws synchronously: failures always arrive as a rejected promise. */
  private ensureAttached(sessionId: string): Promise<void> {
    const live = this.liveFor(sessionId);
    if (live.detaching) return live.detaching.then(() => this.ensureAttached(sessionId));
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
          // Items without a recorded time get the time of the one before, never "now".
          // (An agent that only says when a session last changed gives that as its creation too.)
          let ts = Math.min(summary.createdAt, history.find((item) => item.ts !== undefined)?.ts ?? summary.createdAt);
          // The log only grows at its end. A message before what it already has is one an earlier
          // reading skipped (a reader that now shows more), not something that happened since:
          // added now it would land at the bottom, out of place, so it is only marked as seen.
          const logged = history.map((item) => this.store.isItemLogged(sessionId, item.itemId));
          const lastLogged = logged.lastIndexOf(true);
          for (const [index, item] of history.entries()) {
            ts = Math.min(Math.max(item.ts ?? ts, ts), summary.updatedAt);
            if (logged[index]) continue;
            if (index < lastLogged && item.updates.every((update) => update.sessionUpdate === "user_message_chunk")) {
              this.store.markItemLogged(sessionId, item.itemId);
              continue;
            }
            for (const update of item.updates) this.commit(sessionId, update, undefined, ts);
            this.store.markItemLogged(sessionId, item.itemId);
          }
        } finally {
          live.importing = false;
          live.turnActive = turnActive;
          const stored = this.store.getSession(sessionId);
          if (live.importChanged && stored) this.emitSummary(stored);
        }
        live.attached = !this.store.getSession(sessionId)?.archived;
      } finally {
        const buffered = live.buffer ?? [];
        live.buffer = undefined;
        for (const { update, itemId, ts } of buffered) {
          // History already covered this item; skip its completion to avoid a duplicate.
          if (itemId && this.store.isItemLogged(sessionId, itemId)) continue;
          this.commit(sessionId, update, itemId, ts);
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
    const driver = this.drivers.get(agent);
    const availability = driver?.nativeSessionAvailability?.(session.nativeId, session.cwd);
    if (availability === "missing") {
      if (before) this.reconcileNativeSession(driver!, before);
      return;
    }
    const restored = availability === "available" && !!before && this.store.isNativeMissing(before.id);
    if (restored) this.store.setNativeMissing(before!.id, false);
    if (before && session.updatedAt > before.updatedAt) {
      // Renamed just now: the session keeps its place in the list.
      const renamed = this.store.getDriverState(before.id, RENAMED);
      if (renamed) {
        const hold = JSON.parse(renamed) as { updatedAt: number; until: number };
        if (session.updatedAt <= hold.until) session = { ...session, updatedAt: before.updatedAt };
      }
    }
    const stored = this.store.upsertSession({
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
    const { created } = stored;
    const summary = this.reconcileAppArchive(session.archived !== undefined && session.archived !== stored.summary.archived
      ? this.store.patchSession(stored.summary.id, { archived: session.archived })
      : stored.summary);
    const changed =
      !!before &&
      (before.title !== summary.title ||
        before.state !== summary.state ||
        before.archived !== summary.archived ||
        before.updatedAt !== summary.updatedAt ||
        before.cwd !== summary.cwd ||
        before.model !== summary.model);
    let questionsChanged = false;
    if (session.asyncQuestions !== undefined) {
      questionsChanged = JSON.stringify(this.questionsOf(summary.id)) !== JSON.stringify(session.asyncQuestions);
      this.pendingQuestions.set(summary.id, session.asyncQuestions);
      if (questionsChanged) this.store.setDriverState(summary.id, "asyncQuestions", JSON.stringify(session.asyncQuestions));
    }
    const origin = session.forkedFrom === undefined ? undefined : sessionIdFor(agent, session.forkedFrom);
    const forked = origin !== undefined && origin !== summary.id && origin !== this.forkOrigin(summary.id);
    if (forked) {
      this.store.setDriverState(summary.id, FORKED_FROM, origin);
      this.forkOrigins.set(summary.id, origin);
    }
    if (created || changed || questionsChanged || restored || forked) this.emitSummary(summary);
    if (created || restored || before?.archived !== summary.archived) this.announceRelated(summary.id);
  }

  private ingest(sessionId: string, update: SessionUpdate, itemId?: string, ts?: number): void {
    if (this.store.isNativeMissing(sessionId)) return;
    if (!this.store.getSession(sessionId)) {
      this.log(`[hub] dropping update for unknown session ${sessionId}`);
      return;
    }
    const live = this.liveFor(sessionId);
    if (live.buffer) {
      live.buffer.push({ update, itemId, ts });
      return;
    }
    this.commit(sessionId, update, itemId, ts);
  }

  private commit(sessionId: string, update: SessionUpdate, itemId?: string, ts?: number): void {
    const live = this.liveFor(sessionId);
    if (update.sessionUpdate === "ls_permission_resolved" && !live.permissions.has(update.requestId)) return;
    const event = this.store.appendEvent(sessionId, update, ts, isActivity(update));
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
    if (update.sessionUpdate === "ls_turn" && update.state === "ended" && !update.parentToolCallId) {
      for (const requestId of [...live.permissions.keys()]) {
        if (live.permissions.get(requestId)?.childSessionId) continue;
        this.commit(sessionId, { sessionUpdate: "ls_permission_resolved", requestId });
      }
      if (!live.importing) void this.sendHeld(sessionId);
    }
  }

  private applyToSummary(sessionId: string, live: LiveSession, update: SessionUpdate): void {
    const before = this.store.getSession(sessionId);
    if (!before) return;
    const patch: SessionPatch = {};
    let activityChanged = this.trackSubagent(live, update) && !live.importing;
    const questions = this.questionsOf(sessionId);
    const nextQuestions = updateAsyncQuestions(questions, update);
    if (questions !== nextQuestions && JSON.stringify(questions) !== JSON.stringify(nextQuestions)) {
      this.pendingQuestions.set(sessionId, nextQuestions);
      this.store.setDriverState(sessionId, "asyncQuestions", JSON.stringify(nextQuestions));
      if (live.importing) live.importChanged = true;
      else activityChanged = true;
    }
    if (update.sessionUpdate === "ls_task") {
      this.tasksOf(sessionId, live).set(update.task.id, update.task);
      if (live.importing) live.importChanged = true;
      else activityChanged = true;
    }
    const setActivity = (next: SessionActivity | undefined) => {
      if (live.importing || sameActivity(live.activity, next)) return;
      live.activity = next;
      activityChanged = true;
    };
    switch (update.sessionUpdate) {
      case "ls_message": {
        if (update.parentToolCallId || !update.content) break;
        const text = update.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        // A title is the person's words, not the context their client or Claude wrapped around them.
        if (update.role === "user" && !before.title && readUserText(text).text.trim()) patch.title = compact(readUserText(text).text, TITLE_LENGTH);
        if (update.role === "agent" && text.trim()) patch.preview = compact(text, PREVIEW_LENGTH);
        if (live.turnActive && update.role === "agent") setActivity({ kind: "responding" });
        break;
      }
      case "user_message_chunk": {
        const text = update.content.type === "text" ? readUserText(update.content.text).text : "";
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
        // A sub-agent's turn is its own; the session's is the one without a parent.
        if (update.parentToolCallId) break;
        live.turnActive = update.state === "started";
        setActivity(live.turnActive ? { kind: "thinking" } : undefined);
        // Leftover permissions are cleared right after a turn ends (see commit).
        patch.state = live.turnActive ? "running" : [...live.permissions.values()].some((permission) => permission.childSessionId) ? "waiting" : update.stopReason === "error" ? "error" : "idle";
        break;
      case "ls_status":
        patch.state = update.state;
        if (!live.importing) {
          live.turnActive = update.turnActive ?? (update.state === "running" || update.state === "waiting");
          if (!live.turnActive) setActivity(undefined);
        }
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
        if (update.title !== undefined) patch.title = update.title === null ? null : compact(update.title, TITLE_LENGTH);
        if (update.updatedAt !== undefined) {
          const updatedAt = update.updatedAt === null ? before.createdAt : Date.parse(update.updatedAt);
          if (Number.isFinite(updatedAt)) patch.updatedAt = updatedAt;
        }
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
    if (isActivity(update)) patch.updatedAt = Date.now();
    this.emitSummary(this.store.patchSession(sessionId, patch));
  }

  /** Sends the session's current summary to every client (its queue or activity changed). */
  private announce(sessionId: string): void {
    const stored = this.store.getSession(sessionId);
    if (stored) this.emitSummary(stored);
  }

  private emitSummary(stored: SessionSummary): void {
    if (this.store.isNativeMissing(stored.id)) return;
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
