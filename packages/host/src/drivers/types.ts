import type {
  AgentAuth,
  AsyncQuestion,
  GoalChange,
  SessionGoal,
  AgentCapabilities,
  AgentTier,
  BackgroundTask,
  ContentBlock,
  QueuedMessage,
  QuestionAnswer,
  SessionState,
  SessionUpdate,
  SessionNotice,
  AcpAgentSettings,
  AcpFeatures,
  AcpProvider,
  PendingPermissionSummary,
  EditorRequest,
  EditorResult,
  MethodParams,
  MethodResult,
} from "@linkshell/wire";
import type { PreviewInput } from "../computer-preview.js";
import type { DriverBehavior } from "./behavior.js";

/** A session the agent knows about, however it was created. */
export interface DiscoveredSession {
  nativeId: string;
  cwd: string;
  title?: string;
  preview?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  state?: SessionState;
  /** When supplied, the agent's own archive state is authoritative. */
  archived?: boolean;
  asyncQuestions?: AsyncQuestion[];
  /** The native id of the session (of the same agent) this one was forked from, when the agent records it. Kept by the host once seen. */
  forkedFrom?: string;
}

/** Where a session came from, as native ids of the same agent, most likely first (the host takes the first it has). */
export interface SessionLineage {
  /** The session that started this one. */
  parent?: string[];
  /** The session this one was forked from. */
  forkedFrom?: string[];
  /** The id an app of the agent's knows the session by (the Claude app's `local_…`). */
  appId?: string;
}

/**
 * One completed item of native history (a message, a tool call, …) expressed as
 * the updates that reproduce it. `itemId` lets the host skip items it already
 * logged, so re-attaching after a restart only appends what is new.
 */
export interface HistoryItem {
  itemId: string;
  updates: SessionUpdate[];
  /** When it happened (ms), if the agent's history records it. */
  ts?: number;
}

/** A piece of a background task's output (see `sessions.taskOutput`). */
export interface TaskOutput {
  text: string;
  /** Where `text` begins, in bytes of the whole output. */
  start: number;
  /** The whole output's size in bytes. */
  size: number;
}

export interface ForkOptions {
  /** Where the new session works. */
  cwd: string;
  /** Where the original works. */
  sourceCwd: string;
  /** Fork through this point instead of the whole conversation. */
  upTo?: {
    /** The message or tool call the user picked. */
    itemId: string;
    /** Which turn it is in, counting the session's turns from 1. */
    turn: number;
  };
}

/** Callbacks a driver uses to report to the host. */
export interface DriverHost {
  notice?(agent: string, nativeId: string, notice: SessionNotice): void;
  agentSettings?(agent: string): AcpAgentSettings;
  interaction?(agent: string, request: PendingPermissionSummary | { requestId: string; resolved: true }): void;
  loginTerminal?(agent: string, launch: LaunchSpec): Promise<{ terminalId: string; exited: Promise<number | null> }>;
  authChanged?(agent: string): void;
  /** Independent computer-use surface; never a conversation image. */
  preview?(agent: string, nativeId: string, frame: PreviewInput): void;
  /** A session was created or changed outside of any client request (e.g. in the desktop TUI). */
  sessionSeen(agent: string, session: DiscoveredSession): void;
  /**
   * A live update for an attached session. `itemId` marks the native item it
   * completes, if any; `ts` is when it happened, when that isn't now (what was
   * already under way when the session was opened).
   */
  update(agent: string, nativeId: string, update: SessionUpdate, itemId?: string, ts?: number): void;
  /** Asks the host to attach (import history, then follow live) — e.g. a thread the TUI just opened. */
  follow(agent: string, nativeId: string): Promise<void>;
  /** The driver lost its live connection to a session; the host re-attaches on next use. */
  detached(agent: string, nativeId: string): void;
  /** The messages the driver is holding for after the current turn (empty: none). */
  queue(agent: string, nativeId: string, items: QueuedMessage[]): void;
  /** The agent deleted a session itself (e.g. from its own UI). */
  removed(agent: string, nativeId: string): void;
  /** What `lineage` or `appArchive` says of these sessions changed (the agent's records did): the host takes it in and tells clients. */
  nativeRecordsChanged?(agent: string, nativeIds: string[]): void;
  /** The background tasks the host has on record for the session (from `ls_task` updates), to reconcile with what the agent says now. */
  tasks(agent: string, nativeId: string): BackgroundTask[];
  /** The terminal currently driving a handoff session, if any. */
  desktop(agent: string, nativeId: string): DesktopController | undefined;
  /** Durable per-session values for the driver (survive host restarts). */
  state(agent: string, nativeId: string): { get(key: string): string | undefined; set(key: string, value: string): void };
  /** Durable values for the agent as a whole, not one session (survive host restarts). */
  agentState?(agent: string): { get(key: string): string | undefined; set(key: string, value: string): void };
  log(message: string): void;
}

export interface AttachContext {
  cwd: string;
}

export interface SideRequest {
  sideId: string;
  /** The session's directory. */
  cwd: string;
  question: string;
  /** The side conversation so far, for an agent that doesn't keep it itself. */
  history: { question: string; answer: string }[];
}

/** Where a side answer goes as it is written. */
export interface SideOutput {
  text(delta: string): void;
  /** One step of the agent's on the way (a file read, a search). */
  activity(line: string): void;
}

/** A terminal running an agent's native UI via `linkshell <agent>`. */
export interface DesktopController {
  /** Asks the terminal to exit its native UI; resolves once it has (or went away). */
  yield(): Promise<void>;
  /** Shows a line of remote progress in the terminal. */
  activity(line: string): void;
}

export interface DesktopLaunchContext {
  cwd?: string;
  env?: Record<string, string>;
}

export interface DesktopLaunch extends LaunchSpec {
  /** Handoff agents: the session the terminal now drives. */
  nativeId?: string;
  cwd?: string;
}

export interface DriverStatus {
  installed: boolean;
  version?: string;
  problem?: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** A session's MCP Apps, by the session's native id (see `mcp.*` in the wire). */
export interface McpAppsSupport {
  apps(nativeId: string): Promise<MethodResult<"mcp.apps">["apps"]>;
  resource(nativeId: string, request: Omit<MethodParams<"mcp.resource">, "sessionId">): Promise<MethodResult<"mcp.resource">>;
  call(nativeId: string, request: Omit<MethodParams<"mcp.call">, "sessionId">): Promise<MethodResult<"mcp.call">>;
}

export interface AgentDriver {
  readonly id: string;
  readonly label: string;
  /** Read after initialization; protocol drivers refresh it from each negotiated connection. */
  readonly behavior: DriverBehavior;
  readonly tier: AgentTier;
  readonly capabilities: AgentCapabilities;

  start(host: DriverHost): Promise<DriverStatus>;
  stop(): Promise<void>;
  status(): DriverStatus;
  /** The agent's own report of how it is logged in. Must not read or return secrets. */
  authStatus?(): Promise<AgentAuth>;
  acpInfo?(nativeId?: string): Promise<{ features: AcpFeatures; settings: AcpAgentSettings; interactions: PendingPermissionSummary[] }>;
  pendingInteractions?(): PendingPermissionSummary[];
  editor?(input: EditorRequest): Promise<EditorResult>;
  configureAcp?(settings: AcpAgentSettings, nativeId?: string): Promise<void>;
  authenticate?(methodId?: string, logout?: boolean): Promise<{ terminalId?: string }>;
  respondInteraction?(requestId: string, response: { optionId?: string; answers?: QuestionAnswer[] }): Promise<void>;
  providers?(operation: "list" | "set" | "disable", config?: { providerId: string; apiType?: string; baseUrl?: string; headers?: Record<string, string> }): Promise<AcpProvider[]>;
  /** MCP tools with pages of their own (`mcp.*`); only Codex offers them. */
  readonly mcpApps?: McpAppsSupport;

  listSessions(limit: number): Promise<DiscoveredSession[]>;
  /** Native archives, including sessions that disappeared from recent discovery. Never implies deletion. */
  archivedSessions?(): Promise<string[]>;
  /** Whether a previously discovered session still exists in the agent's native storage on disk. */
  sessionExists?(nativeId: string, cwd: string): boolean;
  /** Missing native history can be hidden reversibly; an unreadable store is not proof of deletion. */
  nativeSessionAvailability?(nativeId: string, cwd: string): "available" | "missing" | "unknown";
  /**
   * Where a session came from, by records the agent keeps outside the
   * session (the Claude desktop app's). Asked for every summary sent, so it
   * answers from memory; `nativeRecordsChanged` says when an answer changes.
   */
  lineage?(nativeId: string): SessionLineage | undefined;
  /**
   * Whether an app of the agent's that LinkShell can only read (the Claude
   * desktop app) has the session archived, and the latest time it can have
   * changed. Undefined when that app doesn't have the session, or isn't read
   * yet. From memory, like `lineage`; the host merges it with its own flag.
   */
  appArchive?(nativeId: string): { archived: boolean; at: number } | undefined;
  /**
   * The models a new session could start on, and the one it starts on when
   * `createSession` is given none (`cwd`: where it would work). Only what the
   * driver can say without starting a session or a turn; absent, or an empty
   * list, where it can't.
   */
  listModels?(cwd?: string, model?: string): Promise<MethodResult<"agents.models">>;
  createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession>;
  /**
   * Starts live updates and returns history according to behavior.history.
   * Idempotent: an attached session may return no new items; the host keeps its cache.
   */
  attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]>;
  detach(nativeId: string): Promise<void>;
  /**
   * Whether a device has the session open, said when the first one opens it
   * and when the last one leaves. For a driver that holds something only
   * while someone is looking.
   */
  watched?(nativeId: string, open: boolean): void;
  /**
   * Following an attached session costs this driver something for as long as
   * it is attached (Claude polls the transcript): the host detaches one nobody
   * has open and nothing runs in, and attaches it again when it is opened.
   */
  readonly detachWhenIdle?: boolean;

  /**
   * `context`: what the agent should know before this message without it
   * being part of what the user said — the earlier conversation, for a session
   * forked from an agent that can't fork itself.
   */
  prompt(nativeId: string, content: ContentBlock[], clientMessageId: string, context?: string): Promise<"started" | "steered" | "queued">;
  cancel(nativeId: string): Promise<void>;
  cancelSubagent?(nativeId: string, childId: string): Promise<void>;
  respondPermission(nativeId: string, requestId: string, optionId: string): Promise<void>;
  /** Answers the questions of a pending request (an `ls_permission` with `questions`). */
  answerQuestion?(nativeId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>;
  setConfig?(nativeId: string, optionId: string, value: string): Promise<void>;
  goal?(nativeId: string, change: GoalChange): Promise<SessionGoal | null>;
  /** Drops a message the driver holds in its queue; whether it was there. */
  unqueue?(nativeId: string, clientMessageId: string): boolean;
  /**
   * A new session with this one's conversation, all of it or through the turn
   * `upTo` names, working in `cwd` (the same directory, or a worktree of it).
   */
  fork?(nativeId: string, options: ForkOptions): Promise<DiscoveredSession>;
  /** Sends what the driver's queue holds (the message named, or the first) without waiting for the running turn to end: into that turn, or by stopping it. */
  sendQueuedNow?(nativeId: string, clientMessageId?: string): Promise<void>;
  /** Puts the driver's queue in the order of `clientMessageIds`. */
  reorderQueue?(nativeId: string, clientMessageIds: string[]): void;
  /**
   * A background task's output, from the agent's own record of it: the text
   * before byte `before` (the end when undefined), at most `limit` bytes.
   * Undefined when the driver has none (the host then reads the call's output from the log).
   */
  taskOutput?(nativeId: string, taskId: string, before: number | undefined, limit: number): TaskOutput | undefined;
  /** Stops one background task (one whose record says `canStop`), leaving the turn and the other tasks alone. */
  stopTask?(nativeId: string, taskId: string): Promise<void>;

  /**
   * Answers a question in a side conversation of the session, the agent's own
   * way (present only where the agent has one; `capabilities.side` says so).
   * Nothing of it enters the session. Resolves when the answer is complete;
   * `signal` stops it.
   */
  sideAsk?(nativeId: string, request: SideRequest, out: SideOutput, signal: AbortSignal): Promise<void>;
  /** The side conversation is over: let go of whatever the agent keeps for it. */
  sideClose?(nativeId: string, sideId: string): Promise<void>;

  // Housekeeping, where the agent keeps its own record. Without these the host
  // archives, names and forgets sessions on its side only.
  archive?(nativeId: string, archived: boolean): Promise<void>;
  rename?(nativeId: string, title: string): Promise<void>;
  /** Deletes the agent's own record of the session. */
  delete?(nativeId: string): Promise<void>;

  /** How a desktop terminal launches this agent's native UI attached to the host. */
  desktopLaunch?(args: string[], nativeId: string | undefined, context: DesktopLaunchContext): DesktopLaunch | Promise<DesktopLaunch>;
  /** Handoff agents: a device takes the session over from the desktop. */
  takeover?(nativeId: string): Promise<void>;
  /** Handoff agents: the terminal driving the session disconnected (its native UI exited). */
  desktopDetached?(nativeId: string): void;
  /** Handoff agents: the desktop takes the session back; returns how to relaunch the native UI. */
  reclaim?(nativeId: string, context: DesktopLaunchContext): Promise<LaunchSpec>;
}
