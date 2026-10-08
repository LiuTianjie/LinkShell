import { statSync } from "node:fs";
import { codexPreview } from "./computer-preview.js";
import { ABANDON, RpcError, sessionGoalSchema, type GoalChange, type SessionGoal, type ContentBlock, type QuestionAnswer, type RpcId, type SessionState } from "@linkshell/wire";
import type { AgentAuth, BackgroundTask } from "@linkshell/wire";
import { parseCodexLoginStatus, runStatusCommand } from "../auth.js";
import type { AgentDriver, DiscoveredSession, DriverHost, DriverStatus, ForkOptions, HistoryItem, LaunchSpec } from "../types.js";
import { CodexAppServer, CodexSharedServer, detectCodex, sharedServerSocket } from "./app-server.js";
import {
  APPROVAL_METHODS,
  QUESTION_METHODS,
  mapApprovalRequest,
  mapQuestionRequest,
  mapNotification,
  threadStateOf,
  threadToDiscovered,
  spawnedThreads,
  subagentHistory,
  threadToHistory,
  toCodexInput,
  toolStart,
  turnUnderWay,
  type ApprovalRequest,
  type CodexThread,
  type CodexThreadState,
} from "./mapper.js";
import { nestHistory, nestUnder } from "../nesting.js";
import { configOptions, effective, settingsFrom, turnOverrides, type CodexModel, type CodexOverrides, type CodexSettings } from "./settings.js";
import { COMMANDS, INIT_PROMPT, commandOf, type CodexSkill } from "./commands.js";
import { DesktopUnconfirmed, desktopBusSocket, interruptThroughDesktop, startThroughDesktop, steerThroughDesktop } from "./desktop-ipc.js";

export interface CodexDriverOptions {
  socketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  hostVersion: string;
  /** Delay before restarting a crashed app-server; doubles up to 30s. */
  restartDelayMs?: number;
  /**
   * Codex's own background server, joined for the threads that live in it
   * (default: where the installed Codex keeps it). `false`: never.
   */
  sharedSocketPath?: string | false;
  /**
   * The bus the Codex desktop app's windows share, through which it is asked
   * to stop a turn it runs (default: where the installed Codex keeps it). `false`: never.
   */
  desktopBusPath?: string | false;
  /** How often a thread that can only be read is looked at again. */
  observeIntervalMs?: number;
  /** How long a thread no device has open, and that isn't working, stays joined. */
  releaseDelayMs?: number;
  /** How long to look for a turn the desktop app was asked to start and didn't confirm. */
  confirmStartMs?: number;
}

/** Where a thread is loaded: this host's app-server, or Codex's own background server. */
type Home = "own" | "shared";

/** A thread another Codex process holds and doesn't share: read from disk for as long as a device has it open. */
interface Observed {
  goalCheckedAt?: number;
  goalReading?: boolean;
  /** The thread's file and how it looked when last read: unchanged means nothing new. */
  path?: string;
  stamp?: string;
  /** The items already reported. */
  seen: Set<string>;
  running: boolean;
  /** The turn that is running there. */
  turnId?: string;
  timer: ReturnType<typeof setInterval>;
  reading?: boolean;
}

/** A message left in Codex's own queue for a thread another process holds. */
interface Waiting {
  clientMessageId: string;
  submissionId: string;
  text: string;
  images: number;
  /** As Codex has it: what is sent if the message is put into the running turn instead. */
  input: unknown[];
}

/** A thread this host is subscribed to: what has finished in it, and what was still running when it was joined. */
interface Joined {
  thread: CodexThread;
  underWay: Record<string, unknown>[];
}

/** Codex's refusal to load a thread that another process has loaded. */
function heldElsewhere(error: unknown): boolean {
  return error instanceof Error && /already has an active writer/i.test(error.message);
}

function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/** The text of a message as Codex holds it. */
function textOf(input: Record<string, unknown>[]): string {
  return input.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("").trim();
}

/** A request id from Codex's background server: both servers count theirs from the same numbers. */
const sharedRequestId = (id: string): string => `shared-${id}`;

// (Shown as one small line in the conversation: short enough to read at a glance.)
const HELD_NOTICE = { title: "会话开在电脑的另一个 Codex 里 · 这一轮结束前发的消息会排队" };
const HELD_SEND = "会话开在电脑的另一个 Codex 里，这条消息没能排进它的队列。在那边关掉这个会话后再发。";
// (The desktop app's windows can lose each other, after which none of them answers for its threads until the app is restarted.)
const HELD_STOP = "这一轮跑在电脑的 Codex 桌面 App（或 IDE 插件）里，这次没能从手机停下它。请在电脑上停止；一直这样的话，重启一下 Codex 桌面 App。";
const HELD_NOW =
  "这一轮跑在电脑的 Codex 桌面 App（或 IDE 插件）里，这次没能从手机插进去。它结束后这条消息会自动发送；想现在就插入，在电脑上对这条排队消息点 Steer。一直这样的话，重启一下 Codex 桌面 App。";
const HELD_COMMAND = "会话开在电脑的另一个 Codex 里，要在那边关掉它之后才能从手机做。";

interface PendingApproval {
  threadId: string;
  request: ApprovalRequest;
  answer: (result: unknown) => void;
  abandon: () => void;
}

/**
 * Codex, tier multi_client: LinkShell and the desktop TUI (`codex --remote`)
 * are both clients of one app-server, so every thread is live on both sides.
 *
 * Codex lets one process have a thread loaded at a time. A thread loaded in
 * Codex's own background server (a plain `codex` in a terminal) is joined
 * there, as one more client. A thread in a process that takes no other
 * clients (the desktop app, an IDE extension) is read from disk as that
 * process writes it; a message for it goes into Codex's own queue, which that
 * process starts when it is idle; and its turn is stopped by asking the app.
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
  private readonly children = new Map<string, { threadId: string; toolCallId: string; path?: string; stamp?: string }>();
  /** Threads Codex reported as sub-agents (parentThreadId set); never shown as sessions. */
  private readonly subThreads = new Set<string>();
  /** Each thread's working directory: where its skills are looked up. */
  private readonly cwds = new Map<string, string>();
  private readonly skills = new Map<string, Promise<CodexSkill[]>>();
  private readonly goalAvailable = new Set<string>();
  private readonly goalRevision = new Map<string, number>();
  private skillsRevision = 0;
  private models?: Promise<CodexModel[]>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartDelay: number;
  private stopped = false;
  private shared?: CodexSharedServer;
  /** Threads loaded in Codex's background server: announced by it, or joined there. */
  private readonly inShared = new Set<string>();
  private readonly observed = new Map<string, Observed>();
  private readonly takingUp = new Map<string, Promise<void>>();
  /** Messages in Codex's own queue for threads another process holds: it starts them when it is idle or its turn ends. */
  private readonly waiting = new Map<string, Waiting[]>();
  /** Notifications for a thread being joined, held until its history has been read. */
  private readonly joining = new Map<string, { method: string; params: unknown; from: Home }[]>();
  /** Threads a device has open. */
  private readonly taskProcesses = new Map<string, Map<string, string>>();
  private readonly taskPolls = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly taskSyncs = new Map<string, Promise<void>>();
  private readonly stoppingTasks = new Set<string>();
  private readonly taskRevisions = new Map<string, number>();
  private readonly watching = new Set<string>();
  /** Threads another client of this host's app-server opened (`linkshell codex`): followed for as long as the host runs. */
  private readonly kept = new Set<string>();
  /** Threads started here that have had no turn: nothing on disk yet to come back to. */
  private readonly fresh = new Set<string>();
  private readonly releases = new Map<string, ReturnType<typeof setTimeout>>();
  /** What was last announced per thread (settings, commands): a thread joined again says it only if it changed. */
  private readonly announced = new Map<string, string>();
  private readonly observeIntervalMs: number;
  private readonly releaseDelayMs: number;
  private readonly confirmStartMs: number;
  private readonly sharedSocketPath?: string;
  private readonly desktopBusPath?: string;

  constructor(private readonly options: CodexDriverOptions) {
    this.restartDelay = options.restartDelayMs ?? 1000;
    this.desktopBusPath = options.desktopBusPath === false ? undefined : (options.desktopBusPath ?? desktopBusSocket(options.env));
    this.sharedSocketPath = options.sharedSocketPath === false ? undefined : (options.sharedSocketPath ?? sharedServerSocket(options.env));
    this.observeIntervalMs = options.observeIntervalMs ?? 2000;
    this.releaseDelayMs = options.releaseDelayMs ?? 30_000;
    this.confirmStartMs = options.confirmStartMs ?? 20_000;
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
    for (const timer of this.taskPolls.values()) clearTimeout(timer);
    this.taskPolls.clear();
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const timer of this.followRetries.values()) clearTimeout(timer);
    this.followRetries.clear();
    for (const timer of this.releases.values()) clearTimeout(timer);
    this.releases.clear();
    for (const threadId of [...this.observed.keys()]) this.stopObserving(threadId);
    for (const pending of this.approvals.values()) pending.abandon();
    this.approvals.clear();
    this.shared?.close();
    this.shared = undefined;
    await this.server?.stop();
    this.server = undefined;
  }

  async listSessions(limit: number): Promise<DiscoveredSession[]> {
    const result = await this.rpc<{ data: CodexThread[] }>("thread/list", { limit, archived: false });
    return result.data.map((thread) => {
      const discovered = threadToDiscovered(thread);
      // This host's app-server only knows the state of the threads loaded in it.
      const state = this.stateElsewhere(thread.id);
      return state ? { ...discovered, state } : discovered;
    });
  }

  private stateElsewhere(threadId: string): SessionState | undefined {
    const watch = this.observed.get(threadId);
    if (watch) return watch.running ? "running" : "idle";
    if (!this.inShared.has(threadId) || !this.attached.has(threadId)) return undefined;
    if (this.hasApprovals(threadId)) return "waiting";
    return this.stateOf(threadId).activeTurnId ? "running" : "idle";
  }

  /** Codex's own fork: a new thread with this one's turns, all or through `lastTurnId`, in `cwd`. */
  async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    let lastTurnId: string | undefined;
    if (options.upTo) {
      const { thread } = await this.rpcFor<{ thread: CodexThread }>(nativeId, "thread/read", { threadId: nativeId, includeTurns: true });
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
      this.fresh.add(result.thread.id);
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
      void this.announceGoal(nativeId);
      return [];
    }
    let joined: Joined;
    try {
      joined = await this.subscribe(nativeId);
    } catch (error) {
      this.attached.delete(nativeId);
      if (error instanceof Error && /no rollout/i.test(error.message)) {
        // Opened in another client but no turn yet, so not on disk. A turn can
        // still be started on it; after that it can be joined.
        throw RpcError.app("not_ready", "this Codex session has no messages yet");
      }
      if (!heldElsewhere(error)) throw error;
      // A Codex process that takes no other clients has it: what it writes can still be read.
      return this.observe(nativeId);
    }
    this.stopObserving(nativeId);
    const history = await this.withSubAgents(nativeId, joined.thread, threadToHistory(joined.thread));
    this.goLive(nativeId, joined);
    this.reportHeld(nativeId, false);
    void this.announceConfig(nativeId);
    void this.announceCommands(nativeId);
    void this.announceGoal(nativeId);
    if (this.waiting.has(nativeId)) void this.syncWaiting(nativeId);
    this.considerRelease(nativeId);
    return history;
  }

  /**
   * Subscribes to a thread where it can be driven: this host's app-server, or
   * Codex's background server when the thread is loaded there. What the
   * server sends from then on is held until `goLive`.
   */
  private async subscribe(threadId: string): Promise<Joined> {
    this.joining.set(threadId, []);
    try {
      // On a running thread, thread/resume rejoins it; otherwise it loads it from disk.
      const resumed = await this.resume(threadId);
      let thread = resumed.thread as CodexThread;
      const running = thread.turns?.find((turn) => turn.status === "inProgress");
      if (running) {
        // The response numbers a running turn's messages itself (item-1,
        // item-2…): imported like that, they would come a second time under
        // their real ids. Read from disk they have the ids they keep, and
        // only what is finished is there.
        const read = await this.rpcFor<{ thread: CodexThread }>(threadId, "thread/read", { threadId, includeTurns: true }).catch(
          async (error: unknown) => {
            await this.rpcFor(threadId, "thread/unsubscribe", { threadId }).catch(() => {});
            throw error;
          },
        );
        thread = read.thread;
      }
      this.settings.set(threadId, settingsFrom(resumed));
      if (thread.cwd) this.cwds.set(threadId, thread.cwd);
      return { thread, underWay: running?.items.filter((item) => item.status === "inProgress") ?? [] };
    } catch (error) {
      this.joining.delete(threadId);
      throw error;
    }
  }

  /** thread/resume where the thread can be loaded: here, or in Codex's background server if it is loaded there. */
  private async resume(threadId: string): Promise<Record<string, unknown>> {
    const places: Home[] = this.inShared.has(threadId) ? ["shared", "own"] : ["own", "shared"];
    let refused: unknown;
    for (const home of places) {
      if (home === "shared" && !(await this.connectShared())) continue;
      try {
        const server = home === "shared" ? this.shared : this.server;
        if (!server) throw RpcError.app("agent_unavailable", "Codex is not running");
        const resumed = await server.request<Record<string, unknown>>("thread/resume", { threadId });
        if (home === "shared") this.inShared.add(threadId);
        else this.inShared.delete(threadId);
        return resumed;
      } catch (error) {
        // Loaded in another process: the other place may be that process. Anything else is the answer.
        if (refused === undefined && !heldElsewhere(error)) throw error;
        refused ??= error;
      }
    }
    throw refused;
  }

  /** Says where the joined thread stands, then lets through what arrived while it was being read. */
  private goLive(threadId: string, { thread, underWay }: Joined): void {
    void this.syncTasks(threadId);
    const state = this.stateOf(threadId);
    const active = thread.turns?.find((turn) => turn.status === "inProgress");
    state.activeTurnId = active?.id;
    state.midTurn = active ? true : undefined;
    state.begun = undefined;
    // A turn already running: the session shows as working, and its end has a start to close.
    if (active) this.host?.update(this.id, threadId, { sessionUpdate: "ls_turn", state: "started", turnId: active.id });
    this.host?.update(this.id, threadId, { sessionUpdate: "ls_status", state: threadStateOf(thread.status) });
    const read = new Set((thread.turns ?? []).flatMap((turn) => turn.items.map((item) => item.id)));
    for (const item of underWay) {
      // A command still running: its card. (Its output so far was missed, so the whole of it comes when it finishes.)
      const start = read.has(item.id) ? undefined : toolStart(item);
      if (start) this.host?.update(this.id, threadId, start);
    }
    const held = this.joining.get(threadId) ?? [];
    this.joining.delete(threadId);
    for (const { method, params, from } of held) {
      const record = params as { itemId?: unknown; item?: { id?: unknown }; turn?: { id?: unknown } } | undefined;
      const itemId = record?.itemId ?? record?.item?.id;
      // Already in what was read: the item, or the start and end of turns it shows.
      if (typeof itemId === "string" && read.has(itemId)) continue;
      if (method === "turn/started" && record?.turn?.id === active?.id) continue;
      if (method === "turn/completed" && record?.turn?.id !== active?.id) continue;
      this.onNotification(method, params, from);
    }
  }

  // ── a thread held by a Codex that can't be joined ──────────────────

  /** Reads the thread from disk, and keeps reading while a device has it open. */
  private async observe(threadId: string): Promise<HistoryItem[]> {
    const { thread } = await this.rpc<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: true });
    const history = await this.withSubAgents(threadId, thread, threadToHistory(thread));
    this.stopObserving(threadId);
    const timer = setInterval(() => void this.refresh(threadId), this.observeIntervalMs);
    timer.unref?.();
    const last = thread.turns?.at(-1);
    const running = turnUnderWay(last);
    // (No stamp yet: the file may have grown since it was read, so the first look reads it again.)
    this.observed.set(threadId, {
      path: thread.path ?? undefined,
      seen: new Set(history.map((item) => item.itemId)),
      running,
      turnId: running ? last?.id : undefined,
      timer,
    });
    if (thread.cwd) this.cwds.set(threadId, thread.cwd);
    this.host?.update(this.id, threadId, { sessionUpdate: "ls_status", state: running ? "running" : "idle" });
    this.reportHeld(threadId, true);
    void this.announceCommands(threadId);
    void this.announceGoal(threadId);
    // What was queued for it before this host last started is still waiting.
    void this.syncWaiting(threadId);
    this.considerRelease(threadId);
    return history;
  }

  /** Reports what the other process has finished since the last look. An item still being written isn't on disk. */
  private async refresh(threadId: string): Promise<void> {
    const watch = this.observed.get(threadId);
    if (!watch || watch.reading) return;
    if (!watch.goalReading && this.goalAvailable.has(threadId) && Date.now() - (watch.goalCheckedAt ?? 0) >= 5000) {
      watch.goalCheckedAt = Date.now();
      watch.goalReading = true;
      // Goal changes live in SQLite and need not change the rollout file.
      void this.goal(threadId, { action: "get" }).catch(() => {}).finally(() => { watch.goalReading = false; });
    }
    if (this.waiting.has(threadId)) void this.syncWaiting(threadId);
    const stamp = watch.path ? fileStamp(watch.path) : undefined;
    // A parent waiting for its agents may not write anything while their own
    // rollout files keep growing. Each of those files can invalidate the read.
    const childrenChanged = [...this.children.values()].some((child) =>
      child.threadId === threadId && (!child.path || child.stamp === undefined || fileStamp(child.path) !== child.stamp));
    if (stamp !== undefined && stamp === watch.stamp && !childrenChanged) return;
    watch.reading = true;
    try {
      const { thread } = await this.rpc<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: true });
      const history = await this.withSubAgents(threadId, thread, threadToHistory(thread));
      // Joined, or let go, while it was being read.
      if (this.observed.get(threadId) !== watch) return;
      watch.stamp = stamp;
      watch.path = thread.path ?? undefined;
      for (const item of history) {
        if (watch.seen.has(item.itemId)) continue;
        watch.seen.add(item.itemId);
        this.report(threadId, item);
      }
      const last = thread.turns?.at(-1);
      const running = turnUnderWay(last);
      watch.turnId = running ? last?.id : undefined;
      if (running !== watch.running) {
        watch.running = running;
        this.host?.update(this.id, threadId, { sessionUpdate: "ls_status", state: running ? "running" : "idle" });
      }
    } catch (error) {
      // Gone, or unreadable: opening it again says what is wrong.
      this.host?.log(`[codex] couldn't read ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      if (this.observed.get(threadId) === watch) {
        this.stopObserving(threadId);
        this.host?.detached(this.id, threadId);
      }
    } finally {
      watch.reading = false;
    }
  }

  private report(threadId: string, item: HistoryItem): void {
    item.updates.forEach((update, index) => this.host?.update(this.id, threadId, update, index === item.updates.length - 1 ? item.itemId : undefined));
  }

  private stopObserving(threadId: string): void {
    const watch = this.observed.get(threadId);
    if (!watch) return;
    clearInterval(watch.timer);
    this.observed.delete(threadId);
  }

  /**
   * Before writing to a thread that could only be read: joins it if whoever
   * had it has let go, with what they wrote since the last look. Still held,
   * it stays as it is.
   */
  private takeUp(threadId: string): Promise<void> {
    const watch = this.observed.get(threadId);
    if (!watch) return Promise.resolve();
    let taking = this.takingUp.get(threadId);
    if (!taking) {
      taking = (async () => {
        this.attached.add(threadId);
        let joined: Joined;
        try {
          joined = await this.subscribe(threadId);
        } catch (error) {
          this.attached.delete(threadId);
          if (heldElsewhere(error)) return;
          throw error;
        }
        this.stopObserving(threadId);
        for (const item of await this.withSubAgents(threadId, joined.thread, threadToHistory(joined.thread))) {
          if (!watch.seen.has(item.itemId)) this.report(threadId, item);
        }
        this.goLive(threadId, joined);
        this.reportHeld(threadId, false);
        void this.announceConfig(threadId);
        void this.announceCommands(threadId);
        void this.announceGoal(threadId);
        // What still waits in Codex's queue is started by this host's app-server now.
        void this.syncWaiting(threadId);
      })().finally(() => this.takingUp.delete(threadId));
      this.takingUp.set(threadId, taking);
    }
    return taking;
  }

  /**
   * Leaves a message in Codex's own queue for a thread another process holds.
   * That process starts it when it is idle, or right after the turn it is running.
   */
  private async enqueue(threadId: string, input: unknown[], clientMessageId: string): Promise<"started" | "queued"> {
    const watch = this.observed.get(threadId);
    if (watch && !watch.running && this.desktopBusPath) {
      // Idle: the app starts it at once when asked, where its queue is only looked at every so often.
      try {
        await this.startElsewhere(threadId, this.desktopMessage(threadId, input, clientMessageId));
        return "started";
      } catch (error) {
        this.host?.log(`[codex] the Codex desktop app didn't start a turn in ${threadId}, queueing instead: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await this.rpc("thread/queue/add", { threadId, input, clientUserMessageId: clientMessageId });
    } catch (error) {
      this.host?.log(`[codex] couldn't queue a message for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      throw this.refused(threadId, "消息没发出去 · 在电脑的 Codex 里关掉这个会话后再发", HELD_SEND);
    }
    await this.syncWaiting(threadId);
    return "queued";
  }

  /** What waits in Codex's queue for the thread, as the session's queue on the devices. */
  private async syncWaiting(threadId: string): Promise<void> {
    const listed = await this.rpc<{ data: { id: string; clientUserMessageId: string; input: Record<string, unknown>[] }[] }>("thread/queue/list", {
      threadId,
    }).catch(() => undefined);
    if (!listed) return;
    this.setWaiting(
      threadId,
      listed.data.map((entry) => ({
        clientMessageId: entry.clientUserMessageId,
        submissionId: entry.id,
        text: textOf(entry.input),
        images: entry.input.filter((part) => part.type === "image" || part.type === "localImage").length,
        input: entry.input,
      })),
    );
  }

  private setWaiting(threadId: string, waiting: Waiting[]): void {
    const before = this.waiting.get(threadId) ?? [];
    if (JSON.stringify(before) === JSON.stringify(waiting)) return;
    if (waiting.length > 0) this.waiting.set(threadId, waiting);
    else this.waiting.delete(threadId);
    this.host?.queue(
      this.id,
      threadId,
      waiting.map(({ clientMessageId, text, images }) => ({ clientMessageId, text, images })),
    );
  }

  unqueue(nativeId: string, clientMessageId: string): boolean {
    const waiting = this.waiting.get(nativeId) ?? [];
    const entry = waiting.find((candidate) => candidate.clientMessageId === clientMessageId);
    if (!entry) return false;
    this.setWaiting(
      nativeId,
      waiting.filter((candidate) => candidate !== entry),
    );
    // (Already started over there: then it runs, and shows as any message does.)
    void this.rpc("thread/queue/delete", { threadId: nativeId, queuedSubmissionId: entry.submissionId }).catch(() => {});
    return true;
  }

  /**
   * A message waiting in Codex's queue goes into the turn another Codex is
   * running, by asking that Codex's app: what its own "Steer" on the waiting
   * message does.
   */
  async sendQueuedNow(nativeId: string, clientMessageId?: string): Promise<void> {
    const waiting = this.waiting.get(nativeId) ?? [];
    const entry = clientMessageId ? waiting.find((candidate) => candidate.clientMessageId === clientMessageId) : waiting[0];
    const watch = this.observed.get(nativeId);
    // (Joined since: what waits is started by the app-server the thread is in now.)
    if (!entry || !watch) return;
    try {
      if (!this.desktopBusPath) throw new Error("not asked");
      const message = this.desktopMessage(nativeId, entry.input, entry.clientMessageId);
      if (watch.running) {
        await steerThroughDesktop(this.desktopBusPath, nativeId, message).catch((error: unknown) => {
          // Asked, and the app is at it: left in the queue too, it would be said twice.
          if (!(error instanceof DesktopUnconfirmed)) throw error;
          this.host?.log(`[codex] the Codex desktop app took a message for ${nativeId} without saying how it went`);
        });
      } else {
        await this.startElsewhere(nativeId, message);
      }
    } catch (error) {
      this.host?.log(`[codex] couldn't put a message into ${nativeId} through the Codex desktop app: ${error instanceof Error ? error.message : String(error)}`);
      throw RpcError.app("busy", HELD_NOW);
    }
    // In the turn now. (Taken out of the queue only after: a message that runs twice is better than one that is lost.)
    this.setWaiting(
      nativeId,
      waiting.filter((candidate) => candidate !== entry),
    );
    await this.rpc("thread/queue/delete", { threadId: nativeId, queuedSubmissionId: entry.submissionId }).catch(() => {});
    void this.refresh(nativeId);
  }

  /**
   * Starts a turn in the desktop app that has the thread. The app often
   * starts it and answers too late for its own bus: then the thread itself
   * says whether the turn began, so the message isn't queued as well and run twice.
   */
  private async startElsewhere(threadId: string, message: ReturnType<CodexDriver["desktopMessage"]>): Promise<void> {
    if (!this.desktopBusPath) throw new Error("not asked");
    try {
      await startThroughDesktop(this.desktopBusPath, threadId, message);
    } catch (error) {
      if (!(error instanceof DesktopUnconfirmed)) throw error;
      const deadline = Date.now() + this.confirmStartMs;
      for (;;) {
        await this.refresh(threadId);
        // (Joined meanwhile: then the turn is reported by the server the thread is in.)
        const watch = this.observed.get(threadId);
        if (!watch || watch.running) break;
        if (Date.now() >= deadline) throw new Error(`${error.message}, and no turn began`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, this.observeIntervalMs)));
      }
    }
    void this.refresh(threadId);
  }

  private desktopMessage(threadId: string, input: unknown[], clientMessageId: string) {
    return { input, text: textOf(input as Record<string, unknown>[]), clientMessageId, cwd: this.cwds.get(threadId) };
  }

  /**
   * Stops the turn a Codex that can't be joined is running. Only its own app
   * can: it is asked over the bus its windows share.
   */
  private async stopElsewhere(threadId: string): Promise<void> {
    const watch = this.observed.get(threadId);
    if (!watch?.running) return;
    try {
      if (!this.desktopBusPath) throw new Error("not asked");
      await interruptThroughDesktop(this.desktopBusPath, threadId, watch.turnId);
    } catch (error) {
      this.host?.log(`[codex] couldn't stop ${threadId} through the Codex desktop app: ${error instanceof Error ? error.message : String(error)}`);
      throw RpcError.app("busy", HELD_STOP);
    }
    void this.refresh(threadId);
  }

  /**
   * What a message for a thread held elsewhere is refused with. The apps show
   * a failed message without its reason, so the reason goes into the session too.
   */
  private refused(threadId: string, notice: string, message: string): RpcError {
    this.host?.update(this.id, threadId, { sessionUpdate: "ls_notice", level: "warning", title: notice });
    return RpcError.app("busy", message);
  }

  /** Says, when it becomes so and when it is over, that the session is in a Codex this host can't join. */
  private reportHeld(threadId: string, held: boolean): void {
    const memory = this.host?.state(this.id, threadId);
    if ((memory?.get("held") === "1") === held) return;
    memory?.set("held", held ? "1" : "");
    this.host?.update(this.id, threadId, { sessionUpdate: "ls_driver", driver: held ? "desktop" : "none" });
    if (held) this.host?.update(this.id, threadId, { sessionUpdate: "ls_notice", level: "info", ...HELD_NOTICE });
  }

  // ── letting go ─────────────────────────────────────────────────────

  /** Whether a device has the session open. */
  watched(nativeId: string, open: boolean): void {
    if (open) {
      this.watching.add(nativeId);
      void this.syncTasks(nativeId);
      this.cancelRelease(nativeId);
    } else {
      this.watching.delete(nativeId);
      this.considerRelease(nativeId);
    }
  }

  private publishTask(threadId: string, task: BackgroundTask): void {
    const { lastSeq: _, ...record } = task;
    this.host?.update(this.id, threadId, { sessionUpdate: "ls_task", task: record });
  }

  private loseTasks(threadId: string): void {
    clearTimeout(this.taskPolls.get(threadId));
    this.taskPolls.delete(threadId);
    this.taskProcesses.delete(threadId);
    this.taskRevisions.set(threadId, (this.taskRevisions.get(threadId) ?? 0) + 1);
    for (const task of this.host?.tasks(this.id, threadId) ?? []) {
      if (task.state === "running") this.publishTask(threadId, { ...task, state: "unknown", endedAt: Date.now(), canStop: false });
    }
  }

  private syncTasks(threadId: string): Promise<void> {
    const pending = this.taskSyncs.get(threadId);
    if (pending) return pending;
    if (!this.attached.has(threadId) || this.observed.has(threadId)) return Promise.resolve();
    const sync = this.readTasks(threadId).catch(() => {}).finally(() => {
      this.taskSyncs.delete(threadId);
      clearTimeout(this.taskPolls.get(threadId));
      this.taskPolls.delete(threadId);
      if (this.attached.has(threadId) && this.watching.has(threadId) && this.host?.tasks(this.id, threadId).some((task) => task.state === "running")) {
        const timer = setTimeout(() => void this.syncTasks(threadId), 5000);
        timer.unref?.();
        this.taskPolls.set(threadId, timer);
      }
    });
    this.taskSyncs.set(threadId, sync);
    return sync;
  }

  private async readTasks(threadId: string): Promise<void> {
    const revision = this.taskRevisions.get(threadId) ?? 0;
    const entries: { itemId: string; processId: string; command: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpcFor<{ data: typeof entries; nextCursor?: string | null }>(threadId, "thread/backgroundTerminals/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      entries.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!this.attached.has(threadId) || revision !== (this.taskRevisions.get(threadId) ?? 0)) return;
    const previous = new Map((this.host?.tasks(this.id, threadId) ?? []).map((task) => [task.id, task]));
    const processes = new Map<string, string>();
    for (const entry of entries) {
      processes.set(entry.itemId, entry.processId);
      const old = previous.get(entry.itemId);
      if (old?.state === "running") continue;
      this.publishTask(threadId, { id: entry.itemId, kind: "shell", toolCallId: entry.itemId, title: this.toolTitles.get(entry.itemId) ?? entry.command, command: entry.command, state: "running", startedAt: old?.startedAt ?? Date.now(), output: true, canStop: true });
    }
    this.taskProcesses.set(threadId, processes);
    for (const task of previous.values()) {
      if (task.state === "running" && !processes.has(task.id)) this.publishTask(threadId, { ...task, state: "unknown", endedAt: Date.now(), canStop: false });
    }
  }

  async stopTask(nativeId: string, taskId: string): Promise<void> {
    await this.syncTasks(nativeId);
    const processId = this.taskProcesses.get(nativeId)?.get(taskId);
    if (!processId) throw RpcError.app("not_found", "这个后台任务已经不在运行列表里");
    const key = `${nativeId}:${taskId}`;
    this.stoppingTasks.add(key);
    try {
      const result = await this.rpcFor<{ terminated: boolean }>(nativeId, "thread/backgroundTerminals/terminate", { threadId: nativeId, processId });
      if (!result.terminated) throw RpcError.app("busy", "没能停止这个后台任务");
      const task = this.host?.tasks(this.id, nativeId).find((task) => task.id === taskId);
      if (task?.state === "running") this.publishTask(nativeId, { ...task, state: "stopped", endedAt: Date.now(), canStop: false });
    } finally { this.stoppingTasks.delete(key); }
  }

  private cancelRelease(threadId: string): void {
    clearTimeout(this.releases.get(threadId));
    this.releases.delete(threadId);
  }

  /**
   * A thread stays loaded, and closed to every other Codex program, for as
   * long as this host is subscribed to it. One that no device has open and
   * that isn't working is let go after a while, so the desktop app or a
   * `codex` in a terminal can open it; opening it on a device joins it again.
   */
  private considerRelease(threadId: string): void {
    this.cancelRelease(threadId);
    if (this.watching.has(threadId) || this.kept.has(threadId) || this.fresh.has(threadId)) return;
    if (!this.attached.has(threadId) && !this.observed.has(threadId)) return;
    const timer = setTimeout(() => {
      this.releases.delete(threadId);
      void this.release(threadId);
    }, this.releaseDelayMs);
    timer.unref?.();
    this.releases.set(threadId, timer);
  }

  private async release(threadId: string): Promise<void> {
    if (this.watching.has(threadId) || this.kept.has(threadId) || this.fresh.has(threadId)) return;
    if (this.observed.has(threadId)) {
      this.stopObserving(threadId);
      this.host?.detached(this.id, threadId);
      return;
    }
    // Working: its turn's end asks again.
    const busy = () => !this.attached.has(threadId) || this.stateOf(threadId).activeTurnId !== undefined || this.hasApprovals(threadId);
    if (busy()) return;
    // A command the agent left running (a dev server, say) ends when its thread
    // is unloaded: the thread stays, and is looked at again later. So does one
    // in a Codex that can't say what it has running.
    let background: unknown[];
    try {
      background = (await this.rpcFor<{ data: unknown[] }>(threadId, "thread/backgroundTerminals/list", { threadId, limit: 1 })).data;
    } catch {
      return;
    }
    if (background.length > 0) return this.considerRelease(threadId);
    if (busy() || this.watching.has(threadId) || this.kept.has(threadId)) return;
    this.host?.detached(this.id, threadId);
    await this.detach(threadId);
  }

  private hasApprovals(threadId: string): boolean {
    for (const pending of this.approvals.values()) if (pending.threadId === threadId) return true;
    return false;
  }

  /** Nests each sub-agent's own history right after the call that spawned it. */
  private async withSubAgents(threadId: string, thread: CodexThread, history: HistoryItem[]): Promise<HistoryItem[]> {
    // Restore the last surface across idle turns and history windows.
    outer: for (const turn of [...(thread.turns ?? [])].reverse()) {
      for (const item of [...turn.items].reverse()) {
        const stamp = turn.completedAt ?? turn.startedAt ?? thread.updatedAt;
        const frame = codexPreview(item, stamp < 1e12 ? stamp * 1000 : stamp);
        if (frame) { this.host?.preview?.(this.id, threadId, frame); break outer; }
      }
    }
    const spawns = new Map<string, string[]>();
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items) {
        const ids = spawnedThreads(item);
        const callId = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined;
        if (!callId || ids.length === 0) continue;
        spawns.set(callId, ids);
        for (const child of ids) {
          this.subThreads.add(child);
          this.children.set(child, { ...this.children.get(child), threadId, toolCallId: callId });
        }
      }
    }
    if (spawns.size === 0) return history;
    const nested = new Map<string, HistoryItem[]>();
    await Promise.all(
      [...spawns].map(async ([callId, ids]) => {
        const parts = await Promise.all(
          ids.map(async (child) => {
            const known = this.children.get(child)!;
            const stamp = known.path ? fileStamp(known.path) : undefined;
            try {
              const result = await this.rpcFor<{ thread: CodexThread }>(threadId, "thread/read", { threadId: child, includeTurns: true });
              known.path = result.thread.path ?? undefined;
              known.stamp = stamp;
              return nestHistory(subagentHistory(result.thread), callId);
            } catch {
              // A just-started child may not have written its rollout yet.
              known.stamp = undefined;
              return [] as HistoryItem[];
            }
          }),
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
    clearTimeout(this.taskPolls.get(nativeId));
    this.taskPolls.delete(nativeId);
    this.taskProcesses.delete(nativeId);
    this.cancelRelease(nativeId);
    this.stopObserving(nativeId);
    if (!this.attached.delete(nativeId)) return;
    await this.rpcFor(nativeId, "thread/unsubscribe", { threadId: nativeId }).catch(() => {});
  }

  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string): Promise<"started" | "steered" | "queued"> {
    await this.takeUp(nativeId);
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
  ): Promise<"started" | "steered" | "queued" | undefined> {
    const echo = () =>
      this.host?.update(
        this.id,
        nativeId,
        { sessionUpdate: "user_message_chunk", messageId: `local-${clientMessageId}`, content: { type: "text", text: command.text } },
        `command:${clientMessageId}`,
      );
    if (command.name === "goal") {
      const args = command.args;
      const change: GoalChange = !args ? { action: "get" }
        : args === "pause" || args === "resume" || args === "clear" ? { action: args }
        : { action: "set", objective: args.replace(/^edit\s+/, "") };
      if (args === "edit") throw RpcError.app("invalid_params", "请在 /goal edit 后写上新的目标，或打开目标面板编辑");
      const goal = await this.goal(nativeId, change);
      echo();
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_notice", level: "info", title: goal ? `目标：${goal.objective}` : "当前没有目标" });
      return "started";
    }
    if (command.name === "reload-skills") {
      this.skillsRevision++;
      this.skills.delete(this.cwds.get(nativeId) ?? "");
      await this.loadSkills(this.cwds.get(nativeId), true);
      await this.announceCommands(nativeId);
      echo();
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_notice", level: "info", title: "已刷新可用技能" });
      return "started";
    }
    if (["status", "mcp", "apps", "ps", "stop"].includes(command.name)) {
      if (command.args) throw RpcError.app("invalid_params", `/${command.name} 暂不接受参数`);
      const lines: string[] = [];
      if (command.name === "status") {
        const { thread } = await this.rpcFor<{ thread: CodexThread }>(nativeId, "thread/read", { threadId: nativeId, includeTurns: false });
        const current = effective(this.settings.get(nativeId) ?? {}, this.overrides.get(nativeId) ?? {}, await this.loadModels());
        const running = this.observed.get(nativeId)?.running ?? Boolean(this.stateOf(nativeId).activeTurnId);
        lines.push(`目录：${thread.cwd}`, `模型：${current.model ?? "默认"}`, `推理强度：${current.effort ?? "默认"}`, `状态：${running ? "运行中" : "空闲"}`);
      } else if (command.name === "stop") {
        await this.rpcFor(nativeId, "thread/backgroundTerminals/clean", { threadId: nativeId });
        lines.push("已停止当前会话的后台终端");
      } else {
        const method = command.name === "mcp" ? "mcpServerStatus/list" : command.name === "apps" ? "app/list" : "thread/backgroundTerminals/list";
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await this.rpcFor<{ data: { name?: string; command?: string; processId?: string; authStatus?: string; isEnabled?: boolean; tools?: Record<string, unknown> }[]; nextCursor?: string | null }>(nativeId, method, { threadId: nativeId, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const entry of page.data) {
            lines.push(command.name === "ps" ? `${entry.processId ?? ""} · ${entry.command ?? "后台终端"}` : command.name === "mcp" ? `${entry.name ?? "MCP"} · ${Object.keys(entry.tools ?? {}).length} 个工具 · ${entry.authStatus ?? ""}` : `${entry.name ?? "应用"} · ${entry.isEnabled ? "已启用" : "未启用"}`);
          }
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) throw RpcError.app("invalid_params", "Agent 返回了重复的分页游标，请重试");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      echo();
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_notice", level: "info", title: `/${command.name}`, detail: lines.join("\n") || "当前没有记录" });
      return "started";
    }
    if (command.name === "compact" || command.name === "review") {
      // Not something a queue can carry: they run in the app-server that has the thread.
      if (this.observed.has(nativeId)) throw this.refused(nativeId, `会话开在电脑的另一个 Codex 里 · 这里不能${command.name === "compact" ? "压缩上下文" : "开始审查"}`, HELD_COMMAND);
      if (this.stateOf(nativeId).activeTurnId) {
        throw RpcError.app("busy", command.name === "compact" ? "等这一轮结束后再压缩上下文" : "等这一轮结束后再开始审查");
      }
      if (command.name === "compact") {
        await this.rpcFor(nativeId, "thread/compact/start", { threadId: nativeId });
      } else {
        await this.rpcFor(nativeId, "review/start", {
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
    if (!skill) throw RpcError.app("not_supported", `当前 Codex 未提供 /${command.name}。请从命令面板选择可用命令。`);
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

  private async send(nativeId: string, input: unknown[], clientMessageId: string): Promise<"started" | "steered" | "queued"> {
    if (input.length === 0) throw RpcError.app("invalid_params", "nothing to send");
    if (this.observed.has(nativeId)) return this.enqueue(nativeId, input, clientMessageId);
    const activeTurnId = this.stateOf(nativeId).activeTurnId;
    if (activeTurnId) {
      try {
        await this.rpcFor(nativeId, "turn/steer", {
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
    await this.rpcFor(nativeId, "turn/start", {
      threadId: nativeId,
      clientUserMessageId: clientMessageId,
      input,
      ...turnOverrides(overrides, overrides.plan === undefined ? {} : effective(this.settings.get(nativeId) ?? {}, overrides, await this.loadModels())),
    });
    return "started";
  }

  async goal(nativeId: string, change: GoalChange): Promise<SessionGoal | null> {
    if (this.observed.has(nativeId) && change.action !== "get") throw this.refused(nativeId, "会话开在电脑的另一个 Codex 里 · 暂时只能查看目标", HELD_COMMAND);
    const method = change.action === "get" ? "thread/goal/get" : change.action === "clear" ? "thread/goal/clear" : "thread/goal/set";
    let status: SessionGoal["status"] = "active";
    if (change.action === "set") {
      const current = await this.rpcFor<{ goal: SessionGoal | null }>(nativeId, "thread/goal/get", { threadId: nativeId });
      // Editing a paused goal must not silently restart work. This matches the
      // native editor; finished or exhausted goals start afresh when edited.
      if (current.goal && ["paused", "blocked", "usageLimited"].includes(current.goal.status)) status = current.goal.status;
    }
    const params = change.action === "set"
      ? { threadId: nativeId, objective: change.objective, status, ...(change.tokenBudget === undefined ? {} : { tokenBudget: change.tokenBudget }) }
      : { threadId: nativeId, ...(change.action === "pause" ? { status: "paused" } : change.action === "resume" ? { status: "active" } : {}) };
    const revision = this.goalRevision.get(nativeId) ?? 0;
    const result = await this.rpcFor<{ goal?: unknown }>(nativeId, method, params);
    const goal = change.action === "clear" || result.goal == null ? null : sessionGoalSchema.parse(result.goal);
    this.goalAvailable.add(nativeId);
    // A live update can overtake a snapshot request. Never overwrite it with
    // the older response (especially a null read from just before /goal set).
    if ((this.goalRevision.get(nativeId) ?? 0) === revision && this.isNews(`goal:${nativeId}`, goal)) this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal });
    return goal;
  }

  private async announceGoal(nativeId: string): Promise<void> {
    try {
      await this.goal(nativeId, { action: "get" });
      await this.announceCommands(nativeId);
    } catch (error) {
      // Older Codex builds do not implement Goals; ordinary sessions still work.
      this.host?.log(`[codex] goal unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    if (options.length > 0 && this.isNews(`config:${nativeId}`, options)) this.host?.update(this.id, nativeId, { sessionUpdate: "ls_config", options });
  }

  private isNews(key: string, value: unknown): boolean {
    const text = JSON.stringify(value);
    if (this.announced.get(key) === text) return false;
    this.announced.set(key, text);
    return true;
  }

  private loadSkills(cwd: string | undefined, forceReload = false): Promise<CodexSkill[]> {
    const key = cwd ?? "";
    let loading = this.skills.get(key);
    if (!loading) {
      loading = this.rpc<{ data: { skills?: CodexSkill[] }[] }>("skills/list", { ...(cwd ? { cwds: [cwd] } : {}), ...(forceReload ? { forceReload } : {}) })
        .then((result) => result.data.flatMap((entry) => entry.skills ?? []).filter((skill) => skill.enabled !== false && skill.name && skill.path))
        .catch((error: unknown) => {
          if (this.skills.get(key) === loading) this.skills.delete(key);
          this.host?.log(`[codex] skills/list failed: ${error instanceof Error ? error.message : String(error)}`);
          if (forceReload) throw error;
          return [];
        });
      this.skills.set(key, loading);
    }
    return loading;
  }

  /** What `/` offers on a device: the commands above, then the skills this project can use. */
  private async announceCommands(nativeId: string): Promise<void> {
    // Built-ins must be usable even while skill discovery is slow or unavailable.
    if (!this.announced.has(`commands:${nativeId}`)) {
      this.isNews(`commands:${nativeId}`, COMMANDS);
      this.host?.update(this.id, nativeId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
    }
    const revision = this.skillsRevision;
    const skills = await this.loadSkills(this.cwds.get(nativeId));
    if (revision !== this.skillsRevision) return;
    const taken = new Set(COMMANDS.map((command) => command.name));
    const availableCommands = [
      ...COMMANDS,
      ...(this.goalAvailable.has(nativeId) ? [{ name: "goal", description: "设置、查看、暂停、继续或清除持续目标", hint: "目标 / pause / resume / clear" }] : []),
      ...skills
        .filter((skill) => !taken.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          description: (skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description ?? "").slice(0, 160),
        })),
    ];
    if (this.isNews(`commands:${nativeId}`, availableCommands)) this.host?.update(this.id, nativeId, { sessionUpdate: "available_commands_update", availableCommands });
  }

  async archive(nativeId: string, archived: boolean): Promise<void> {
    await this.rpcFor(nativeId, archived ? "thread/archive" : "thread/unarchive", { threadId: nativeId });
  }

  async rename(nativeId: string, title: string): Promise<void> {
    await this.rpcFor(nativeId, "thread/name/set", { threadId: nativeId, name: title });
  }

  async delete(nativeId: string): Promise<void> {
    await this.rpcFor(nativeId, "thread/delete", { threadId: nativeId });
  }

  async cancel(nativeId: string): Promise<void> {
    if (this.observed.has(nativeId)) {
      // Stopping stops what's waiting too; the apps put queued text back in the composer.
      for (const entry of this.waiting.get(nativeId) ?? []) this.unqueue(nativeId, entry.clientMessageId);
      return this.stopElsewhere(nativeId);
    }
    const turnId = this.stateOf(nativeId).activeTurnId;
    if (!turnId) return;
    await this.rpcFor(nativeId, "turn/interrupt", { threadId: nativeId, turnId });
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

  async desktopLaunch(args: string[], nativeId?: string): Promise<LaunchSpec> {
    // Multi-client: no lease to take, the TUI just joins the server the thread is in.
    let socketPath = this.options.socketPath;
    if (nativeId) {
      // Joined first, which finds where the thread is loaded: the TUI has to go to the same server.
      await this.host?.follow(this.id, nativeId).catch(() => {});
      if (this.attached.has(nativeId) && this.inShared.has(nativeId) && this.sharedSocketPath) socketPath = this.sharedSocketPath;
      // In this host's app-server it is followed from now on, like a thread the TUI starts.
      else this.kept.add(nativeId);
    }
    const remote = ["--remote", `unix://${socketPath}`];
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
      onNotification: (method, params) => this.onNotification(method, params, "own"),
      onRequest: (method, params, id) => this.onServerRequest(method, params, id, "own"),
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
    for (const threadId of loaded.data) {
      this.kept.add(threadId);
      this.follow(threadId);
    }
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
    this.abandonApprovals("own");
    for (const threadId of [...this.attached]) {
      // (What is joined in Codex's background server is still there.)
      if (this.inShared.has(threadId)) continue;
      this.loseTasks(threadId);
      this.attached.delete(threadId);
      this.threads.delete(threadId);
      this.host?.update(this.id, threadId, { sessionUpdate: "ls_status", state: "offline" });
      this.host?.detached(this.id, threadId);
    }
    // Read through the app-server that just went away.
    for (const threadId of [...this.observed.keys()]) {
      this.stopObserving(threadId);
      this.host?.detached(this.id, threadId);
    }
    this.startedHere.clear();
    this.fresh.clear();
    this.kept.clear();
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

  private onNotification(method: string, params: unknown, from: Home): void {
    if (method === "skills/changed") {
      this.skillsRevision++;
      this.skills.clear();
      for (const id of this.attached) void this.announceCommands(id);
      return;
    }
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      const id = (params as { threadId?: string } | undefined)?.threadId;
      if (id) {
        this.goalRevision.set(id, (this.goalRevision.get(id) ?? 0) + 1);
        if (this.attached.has(id) && !this.goalAvailable.has(id)) {
          this.goalAvailable.add(id);
          void this.announceCommands(id);
        }
      }
    }
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
      if (from === "shared") {
        // A plain `codex` opened it in Codex's background server. It is joined
        // there when a device opens it: until then this host keeps nothing loaded.
        this.inShared.add(thread.id);
        return;
      }
      // The broadcast can beat our own thread/start response; decide whether
      // the thread was opened elsewhere (the desktop TUI) once those settle.
      void Promise.allSettled([...this.startsInFlight]).then(() => {
        if (this.attached.has(thread.id) || this.startedHere.has(thread.id)) return;
        this.kept.add(thread.id);
        this.follow(thread.id);
      });
      return;
    }
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    const held = typeof threadId === "string" ? this.joining.get(threadId) : undefined;
    if (held) {
      held.push({ method, params, from });
      return;
    }
    this.noteSpawns(params);
    if (method === "item/completed" && typeof threadId === "string") {
      const item = (params as { item?: { id?: string; exitCode?: number | null; status?: string } }).item;
      const task = this.host?.tasks(this.id, threadId).find((task) => task.id === item?.id);
      if (task && task.state === "running") {
        this.taskRevisions.set(threadId, (this.taskRevisions.get(threadId) ?? 0) + 1);
        const stopped = this.stoppingTasks.delete(`${threadId}:${task.id}`);
        this.publishTask(threadId, { ...task, state: stopped ? "stopped" : item?.exitCode === 0 ? "completed" : item?.exitCode != null || item?.status === "failed" ? "failed" : "unknown", endedAt: Date.now(), exitCode: item?.exitCode ?? undefined, canStop: false });
      }
    }
    if (method === "item/completed" && typeof threadId === "string") {
      const frame = codexPreview((params as { item?: unknown }).item);
      if (frame) this.host?.preview?.(this.id, threadId, frame);
    }
    for (const mapped of mapNotification(method, params, (id) => this.stateOf(id))) {
      const update =
        from === "shared" && mapped.update.sessionUpdate === "ls_permission_resolved"
          ? { ...mapped.update, requestId: sharedRequestId(mapped.update.requestId) }
          : mapped.update;
      if (update.sessionUpdate === "ls_goal" && !this.isNews(`goal:${mapped.threadId}`, update.goal)) continue;
      if (update.sessionUpdate === "tool_call") this.rememberTitle(update.toolCallId, update.title);
      if (update.sessionUpdate === "ls_permission_resolved") {
        const pending = this.approvals.get(update.requestId);
        if (pending) {
          // Another client (the TUI) answered first.
          this.approvals.delete(update.requestId);
          pending.abandon();
        }
      }
      const parent = this.children.get(mapped.threadId);
      if (parent) {
        const nested = nestUnder(update, parent.toolCallId);
        if (nested && this.attached.has(parent.threadId)) {
          this.host?.update(this.id, parent.threadId, nested, mapped.itemId && `sub:${parent.toolCallId}:${mapped.itemId}`);
        }
        continue;
      }
      if (!this.attached.has(mapped.threadId)) continue;
      this.host?.update(this.id, mapped.threadId, update, mapped.itemId);
      // A message that waited in Codex's queue has started.
      if (update.sessionUpdate === "user_message_chunk" && this.waiting.has(mapped.threadId)) void this.syncWaiting(mapped.threadId);
      if (update.sessionUpdate !== "ls_turn") continue;
      if (update.state === "started") this.fresh.delete(mapped.threadId);
      else { void this.syncTasks(mapped.threadId); this.considerRelease(mapped.threadId); }
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

  private onServerRequest(method: string, params: unknown, id: RpcId, from: Home): unknown {
    if (!APPROVAL_METHODS.has(method) && !QUESTION_METHODS.has(method)) return ABANDON;
    const requestId = from === "shared" ? sharedRequestId(String(id)) : String(id);
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

  /** A request about a thread, to the server it is loaded in. */
  private rpcFor<T = unknown>(threadId: string, method: string, params: unknown): Promise<T> {
    return this.inShared.has(threadId) && this.shared ? this.shared.request<T>(method, params) : this.rpc<T>(method, params);
  }

  /** Connects to Codex's background server, if it is running. */
  private connectShared(): Promise<boolean> {
    if (!this.sharedSocketPath || this.stopped) return Promise.resolve(false);
    this.shared ??= new CodexSharedServer({
      socketPath: this.sharedSocketPath,
      clientVersion: this.options.hostVersion,
      onNotification: (method, params) => this.onNotification(method, params, "shared"),
      onRequest: (method, params, id) => this.onServerRequest(method, params, id, "shared"),
      onDown: () => this.onSharedDown(),
    });
    return this.shared.connect();
  }

  /** Codex's background server went away (stopped, or restarted by its updater): the threads joined there are joined again wherever they are now. */
  private onSharedDown(): void {
    if (this.stopped) return;
    this.host?.log("[codex] lost Codex's background server");
    this.abandonApprovals("shared");
    const joined = [...this.inShared].filter((threadId) => this.attached.delete(threadId));
    this.inShared.clear();
    for (const threadId of joined) {
      this.loseTasks(threadId);
      const turnId = this.stateOf(threadId).activeTurnId;
      this.threads.delete(threadId);
      // Whether the turn goes on is told again when the thread is joined again.
      if (turnId) this.host?.update(this.id, threadId, { sessionUpdate: "ls_turn", state: "ended", turnId });
      this.host?.detached(this.id, threadId);
      this.follow(threadId);
    }
  }

  private abandonApprovals(from: Home): void {
    for (const [requestId, pending] of this.approvals) {
      if (requestId.startsWith(sharedRequestId("")) !== (from === "shared")) continue;
      this.approvals.delete(requestId);
      pending.abandon();
    }
  }
}
