import type {
  AgentAuth,
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
} from "@linkshell/wire";
import type { PreviewInput } from "../computer-preview.js";

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
  /** The background tasks the host has on record for the session (from `ls_task` updates), to reconcile with what the agent says now. */
  tasks(agent: string, nativeId: string): BackgroundTask[];
  /** The terminal currently driving a handoff session, if any. */
  desktop(agent: string, nativeId: string): DesktopController | undefined;
  /** Durable per-session values for the driver (survive host restarts). */
  state(agent: string, nativeId: string): { get(key: string): string | undefined; set(key: string, value: string): void };
  log(message: string): void;
}

export interface AttachContext {
  cwd: string;
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

export interface AgentDriver {
  readonly id: string;
  readonly label: string;
  readonly tier: AgentTier;
  readonly capabilities: AgentCapabilities;

  start(host: DriverHost): Promise<DriverStatus>;
  stop(): Promise<void>;
  status(): DriverStatus;
  /** The agent's own report of how it is logged in. Must not read or return secrets. */
  authStatus?(): Promise<AgentAuth>;

  listSessions(limit: number): Promise<DiscoveredSession[]>;
  createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession>;
  /**
   * Starts live updates for a session and returns its full native history.
   * Idempotent: attaching an attached session just returns the history again.
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
   * `context`: what the agent should know before this message without it
   * being part of what the user said — the earlier conversation, for a session
   * forked from an agent that can't fork itself.
   */
  prompt(nativeId: string, content: ContentBlock[], clientMessageId: string, context?: string): Promise<"started" | "steered" | "queued">;
  cancel(nativeId: string): Promise<void>;
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
