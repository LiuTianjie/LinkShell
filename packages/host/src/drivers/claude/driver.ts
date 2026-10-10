import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { RpcError, type ContentBlock, type SessionConfigOption, type SessionUpdate } from "@linkshell/wire";
import { AcpDriver, inOrder } from "../acp/driver.js";
import { AcpItemTracker, toConfigOptions, toHistory, type SourcedConfigOption } from "../acp/mapper.js";
import { parseClaudeAuthStatus, runStatusCommand } from "../auth.js";
import type { AttachContext, DesktopLaunch, DesktopLaunchContext, DiscoveredSession, ForkOptions, HistoryItem, LaunchSpec } from "../types.js";
import { descendsFrom, sessionHolders, type SessionHolder } from "./holders.js";
import { ClaudeTasks } from "./tasks.js";
import { ClaudeActivity } from "./activity.js";
import {
  claudeConfigDir,
  encodeProjectDir,
  findTranscript,
  turnEndUuid,
  mergeSettings,
  mergeByTime,
  readTail,
  readTranscript,
  settingsOf,
  transcriptLine,
  transcriptTimes,
  TranscriptTail,
  type ObservedSettings,
} from "./transcript.js";

const execFileAsync = promisify(execFile);

/** How the adapter's Claude marks the transcript lines it writes. */
const REMOTE_ENTRYPOINT = '"entrypoint":"sdk-ts"';

/** A message in the transcript that some other Claude (the desktop app, a terminal) wrote. */
function writtenByAnotherClaude(line: string): boolean {
  return line.includes('"entrypoint":"') && !line.includes(REMOTE_ENTRYPOINT) && /"type":"(user|assistant)"/.test(line);
}

/**
 * Whether another Claude is in the middle of a turn, going by the transcript's
 * last message: a prompt or a tool result with no final reply after it. A turn
 * that has written nothing for `stalledMs` no longer counts (it waits on its
 * own approval prompt, or that Claude is gone).
 */
function turnInProgress(path: string, stalledMs: number): boolean {
  const { size, mtimeMs } = statSync(path);
  if (Date.now() - mtimeMs > stalledMs) return false;
  // Lines can be megabytes (a screenshot in a tool result): widen the look until one is whole.
  for (const bytes of [512 * 1024, 8 * 1024 * 1024, size]) {
    const tail = readTail(path, Math.min(size, bytes));
    const lines = (bytes >= size ? tail : tail.slice(tail.indexOf("\n") + 1)).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!/"type":"(user|assistant)"/.test(line)) continue;
      let entry: { type?: string; isSidechain?: boolean; message?: { stop_reason?: string | null; content?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) continue;
      if (line.includes(REMOTE_ENTRYPOINT)) return false;
      if (entry.type === "assistant") return entry.message?.stop_reason == null || entry.message.stop_reason === "tool_use";
      return !JSON.stringify(entry.message?.content ?? "").includes("[Request interrupted");
    }
    if (bytes >= size) break;
  }
  return false;
}

/** Finds an executable on the given PATH (the adapter needs an absolute path). */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(name)) return name;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The bundled claude-agent-acp, or undefined if it isn't installed. */
function defaultAdapter(): { command: string; args: string[] } | undefined {
  try {
    const require = createRequire(import.meta.url);
    return { command: process.execPath, args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")] };
  } catch {
    return undefined;
  }
}

/** Which process may write the session right now. */
type Mode = "idle" | "desktop" | "remote";

/**
 * Who wrote the session last, kept across host restarts: "remote" (this host,
 * through ACP) or "desktop" (a TUI started by `linkshell claude`). Anything else
 * means an unmanaged `claude` may be using it.
 */
type Writer = "remote" | "desktop";

function driverOf(mode: Mode): "desktop" | "remote" | "none" {
  return mode === "idle" ? "none" : mode;
}

export interface ClaudeDriverOptions {
  env?: NodeJS.ProcessEnv;
  hostVersion: string;
  /** The user's Claude Code CLI; the TUI and the adapter both run this binary. */
  claudeCommand?: string;
  /** How to start the ACP adapter; defaults to the bundled claude-agent-acp. */
  adapter?: { command: string; args: string[] };
  /** Another Claude's turn that has written nothing for this long no longer counts as running. */
  busyWindowMs?: number;
  /** How often to check that a session driven from a device wasn't reopened on the computer. */
  holderCheckMs?: number;
}

/**
 * Claude Code, tier handoff. On the desktop the native TUI owns the session
 * (`linkshell claude` runs it); a device can take over, and the session then
 * continues headlessly through the ACP adapter under the same id. Claude has
 * no write lock, so the host guarantees one writer at a time.
 *
 * History and desktop activity come from the transcript file; remote turns
 * stream through ACP. Both carry the same message and tool ids.
 */
export class ClaudeDriver extends AcpDriver {
  private readonly modes = new Map<string, Mode>();
  private readonly tails = new Map<string, TranscriptTail>();
  private readonly tasks = new Map<string, ClaudeTasks>();
  private readonly activity = new Map<string, ClaudeActivity>();
  /**
   * The settings Claude offers (model, effort, permission mode…), as the
   * adapter reported them for any session: what a desktop-driven session
   * shows before the phone has it open over ACP.
   */
  private template?: SourcedConfigOption[];
  private templateLoading?: Promise<SourcedConfigOption[] | undefined>;
  /** Desktop-driven sessions: the model of the latest reply, from the transcript. */
  /** Per session: the settings its transcript shows it running with (what the Claude on the computer is set to). */
  private readonly observed = new Map<string, ObservedSettings>();
  /** Per session: TodoWrite calls shown as the plan, whose results the tail skips. */
  private readonly hiddenTools = new Map<string, Set<string>>();
  /** Per session: calls that started an agent in the background and haven't heard back (see transcriptLine). */
  private readonly backgroundAgents = new Map<string, Set<string>>();
  /** Ids of the transcript lines read lately: Claude writes some again after compacting. */
  private readonly seenLines = new Map<string, Set<string>>();
  private readonly claudeCommand: string;
  private readonly configDir: string;
  private readonly busyWindowMs: number;
  private readonly holderCheckMs: number;
  private claudePath?: string;

  constructor(options: ClaudeDriverOptions) {
    const env = options.env ?? process.env;
    const claudeCommand = options.claudeCommand ?? "claude";
    const adapter = options.adapter ?? defaultAdapter();
    const claudePath = resolveExecutable(claudeCommand, env);
    const adapterMissing = !adapter;
    super(
      {
        id: "claude",
        label: "Claude",
        tier: "handoff",
        discover: true,
        command: adapter?.command ?? process.execPath,
        args: adapter?.args ?? [],
        version: { command: claudePath ?? claudeCommand, args: ["--version"] },
        // Run the user's own Claude Code, not the SDK's bundled copy, so the TUI
        // and remote turns read and write the same transcript format.
        env: claudePath ? { CLAUDE_CODE_EXECUTABLE: claudePath } : {},
        authStatus: async (runEnv) =>
          parseClaudeAuthStatus(await runStatusCommand(claudePath ?? claudeCommand, ["auth", "status", "--json"], runEnv)),
      },
      { env: options.env, hostVersion: options.hostVersion },
    );
    this.claudeCommand = claudeCommand;
    this.claudePath = claudePath;
    this.configDir = claudeConfigDir(env);
    this.busyWindowMs = options.busyWindowMs ?? 10 * 60_000;
    this.holderCheckMs = options.holderCheckMs ?? 3000;
    this.adapterMissing = adapterMissing;
    this.capabilities = { ...this.capabilities, models: true, modes: true };
  }

  private readonly adapterMissing: boolean;
  /** Sent from a device while another Claude was mid-turn in the session; goes out when that turn ends. */
  private readonly waiting = new Map<string, { content: ContentBlock[]; clientMessageId: string }[]>();
  /** Checks that sessions driven from a device haven't been reopened on the computer. */
  private remoteWatch?: ReturnType<typeof setInterval>;
  private remoteWatchRun?: Promise<void>;

  override async start(host: import("../types.js").DriverHost) {
    if (!this.adapterMissing) return super.start(host);
    this.host = host;
    const version = await this.detectVersion();
    this.current =
      version === undefined
        ? { installed: false }
        : { installed: true, version: version || undefined, problem: "LinkShell 缺少 Claude 适配器（@agentclientprotocol/claude-agent-acp），请重新安装 linkshell" };
    return this.current;
  }

  override async stop(): Promise<void> {
    clearInterval(this.remoteWatch);
    this.remoteWatch = undefined;
    await this.remoteWatchRun;
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
    for (const follower of this.activity.values()) follower.stop();
    this.activity.clear();
    this.tasks.clear();
    await super.stop();
  }

  override async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    const state = this.stateFor(nativeId, context.cwd);
    const path = findTranscript(this.configDir, nativeId, context.cwd);
    let history: HistoryItem[] = [];
    let offset = 0;
    this.activity.get(nativeId)?.stop();
    let importing = true;
    const nested: SessionUpdate[] = [];
    const tasks = new ClaudeTasks((task) => { if (!importing) this.emit(nativeId, { sessionUpdate: "ls_task", task }); });
    this.tasks.set(nativeId, tasks);
    const activity = new ClaudeActivity({
      locate: () => findTranscript(this.configDir, nativeId, context.cwd),
      onLine: (raw) => tasks.observe(raw),
      desktop: () => importing || this.modes.get(nativeId) !== "remote",
      onUpdate: (update, ts) => {
        if (importing) {
          if (ts !== undefined) transcriptTimes.set(update, ts);
          nested.push(update);
        } else this.emit(nativeId, update);
      },
      onError: (error) => this.host?.log(`[claude] child transcript: ${String(error)}`),
    });
    this.activity.set(nativeId, activity);
    if (path) {
      const transcript = readTranscript(path, { includeSubagents: false, onLine: (raw) => activity.observe(raw) });
      activity.poll();
      if (!(this.modes.get(nativeId) === "remote" && state.loaded) && sessionHolders(this.configDir, nativeId).length === 0) activity.lostHolder();
      state.tracker = new AcpItemTracker();
      // What is under way on the computer isn't history yet: a turn's start and
      // the tool calls still running, and agents working in the background
      // (which outlive the turn that started them). They go out as what is
      // happening now (after the history; the hub holds them until then), so
      // the session shows as working and results have a card to land on.
      const underway: SessionUpdate[] = [];
      history = toHistory(mergeByTime(transcript.updates, nested), state.tracker, (update) => transcriptTimes.get(update), underway);
      const working = turnInProgress(path, this.busyWindowMs);
      for (const update of underway) {
        const call = (update as { parentToolCallId?: string; toolCallId?: string }).parentToolCallId ?? (update as { toolCallId?: string }).toolCallId;
        if (working || (call && (transcript.agents.has(call) || activity.isRunning(call)))) this.host?.update(this.id, nativeId, update, undefined, transcriptTimes.get(update));
      }
      // A terminal tool item is deduplicated during history import. Its workflow
      // sidecars can still have changed while the host was down, so reconcile the
      // current metadata separately, without replaying any conversation text.
      const snapshots = nested.filter((update): update is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
        update.sessionUpdate === "tool_call_update" && update.detail?.type === "subagent" && (!!update.detail.workflow || !!update.detail.state));
      const calls = new Set(snapshots.map((update) => update.toolCallId));
      const turns = new Map<string, Extract<SessionUpdate, { sessionUpdate: "ls_turn" }>>();
      for (const update of nested) {
        if (update.sessionUpdate === "ls_turn" && update.parentToolCallId && calls.has(update.parentToolCallId)) turns.set(update.parentToolCallId, update);
      }
      for (const update of [...snapshots, ...turns.values()]) this.host?.update(this.id, nativeId, update, undefined, transcriptTimes.get(update));
      offset = transcript.size;
      this.backgroundAgents.set(nativeId, transcript.agents);
      this.seenLines.set(nativeId, transcript.seen);
      this.observed.set(nativeId, transcript.settings);
      if (transcript.title) this.host?.update(this.id, nativeId, { sessionUpdate: "session_info_update", title: transcript.title });
    }
    if (!(this.modes.get(nativeId) === "remote" && state.loaded) && sessionHolders(this.configDir, nativeId).length === 0) tasks.lostHolder();
    importing = false;
    const storedTasks = new Map((this.host?.tasks(this.id, nativeId) ?? []).map(({ lastSeq: _, ...task }) => [task.id, task]));
    for (const task of tasks.records.values()) {
      if (JSON.stringify(storedTasks.get(task.id)) !== JSON.stringify(task)) this.emit(nativeId, { sessionUpdate: "ls_task", task });
    }
    this.startWatch();
    activity.followFrom(offset);
    this.startTail(nativeId, context.cwd, offset);
    activity.start();
    const mode = this.modes.get(nativeId) ?? "idle";
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_driver", driver: driverOf(mode) });
    if (mode === "remote") this.emitConfig(nativeId, state);
    else void this.loadTemplate(context.cwd).then(() => this.emitDesktopConfig(nativeId));
    return history;
  }

  /**
   * Claude's settings list without a session to ask: a throwaway session that
   * never gets a message (Claude writes no transcript for it), closed at once.
   */
  private loadTemplate(cwd: string): Promise<SourcedConfigOption[] | undefined> {
    if (this.template) return Promise.resolve(this.template);
    this.templateLoading ??= (async () => {
      try {
        const response = await this.rpc<Record<string, unknown>>("session/new", { cwd, mcpServers: [], ...this.sessionMeta() });
        const options = toConfigOptions(response);
        if (options.length > 0) this.template ??= options;
        if (typeof response.sessionId === "string" && this.connection?.capabilities.sessionCapabilities?.close) {
          void this.rpc("session/close", { sessionId: response.sessionId }).catch(() => {});
        }
        return this.template;
      } catch (error) {
        this.host?.log(`[claude] couldn't read Claude's settings: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally {
        this.templateLoading = undefined;
      }
    })();
    return this.templateLoading;
  }

  private pendingConfig(nativeId: string): Record<string, string> {
    try {
      return JSON.parse(this.host?.state(this.id, nativeId).get("pendingConfig") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** A desktop-driven session's settings: the template, its model, and choices waiting for the phone. */
  private emitDesktopConfig(nativeId: string): void {
    if (!this.template || this.modes.get(nativeId) === "remote") return;
    const pending = this.pendingConfig(nativeId);
    const observed = this.observed.get(nativeId) ?? {};
    const options: SessionConfigOption[] = this.template.map(({ source: _source, ...option }) => {
      const current = pending[option.id] ?? observedValue(option, observed);
      return { ...option, current: current !== undefined && option.values.some((value) => value.value === current) ? current : option.current };
    });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_config", options });
  }

  override async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    const created = await super.createSession(options);
    // A new session's settings are Claude's defaults: the freshest template.
    // (Not a resumed or changed one's: those are that session's own.)
    const config = this.sessions.get(created.nativeId)?.config;
    if (config?.length) this.template = config;
    // Born on a device: this host is the writer from the start.
    this.modes.set(created.nativeId, "remote");
    this.setWriter(created.nativeId, "remote");
    return created;
  }

  /** The `linkshell claude` terminal went away (the user quit the TUI). */
  desktopDetached(nativeId: string): void {
    if (this.modes.get(nativeId) === "desktop") this.setMode(nativeId, "idle");
  }

  override async detach(nativeId: string): Promise<void> {
    this.tails.get(nativeId)?.stop();
    this.tails.delete(nativeId);
    await super.detach(nativeId);
  }

  /**
   * A copy of the session's transcript under a new id (the SDK's fork), all of
   * it or through a turn. A fork that works somewhere else (a worktree) has
   * its transcript moved to that directory's project folder, where Claude
   * looks for the sessions of a directory.
   */
  override async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    const source = findTranscript(this.configDir, nativeId, options.sourceCwd);
    if (!source) throw RpcError.app("not_ready", "这个 Claude 会话还没有任何消息，没有可分叉的内容");
    const upToMessageId = options.upTo ? turnEndUuid(source, options.upTo.itemId, options.upTo.turn) : undefined;
    if (options.upTo && !upToMessageId) throw RpcError.app("not_found", "找不到要分叉的那一轮");
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = this.configDir;
    let forked: string;
    try {
      forked = (await forkSession(nativeId, { dir: options.sourceCwd, upToMessageId })).sessionId;
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    if (options.cwd !== options.sourceCwd) {
      const made = findTranscript(this.configDir, forked, options.sourceCwd);
      if (!made) throw RpcError.app("not_found", "分叉出的会话没有写出来");
      const folder = join(this.configDir, "projects", encodeProjectDir(options.cwd));
      mkdirSync(folder, { recursive: true });
      renameSync(made, join(folder, `${forked}.jsonl`));
    }
    const now = Date.now();
    return { nativeId: forked, cwd: options.cwd, createdAt: now, updatedAt: now };
  }

  /** Claude's own title record (what /rename writes), so `claude --resume` shows it too. */
  async rename(nativeId: string, title: string): Promise<void> {
    const { renameSession } = await import("@anthropic-ai/claude-agent-sdk");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    // The SDK finds transcripts through CLAUDE_CONFIG_DIR, as Claude does.
    process.env.CLAUDE_CONFIG_DIR = this.configDir;
    try {
      await renameSession(nativeId, title);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }

  override async delete(nativeId: string): Promise<void> {
    const transcript = findTranscript(this.configDir, nativeId);
    // No transcript (never messaged): Claude has nothing to delete.
    if (transcript) await super.delete(nativeId);
    else this.sessions.delete(nativeId);
    this.modes.delete(nativeId);
    this.hiddenTools.delete(nativeId);
    this.backgroundAgents.delete(nativeId);
    this.activity.get(nativeId)?.stop();
    this.activity.delete(nativeId);
    this.tasks.get(nativeId)?.lostHolder();
    this.tasks.delete(nativeId);
    if (transcript) sweepTranscript(transcript);
  }

  override async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string): Promise<"started" | "steered" | "queued"> {
    // Another Claude is in the middle of a turn here: the message waits for it to finish.
    if (this.waiting.get(nativeId)?.length || (await this.elsewhere(nativeId))?.working) {
      const waiting = this.waiting.get(nativeId) ?? [];
      waiting.push({ content, clientMessageId });
      this.waiting.set(nativeId, waiting);
      this.reportWaiting(nativeId);
      this.startWatch();
      return "queued";
    }
    // Sending from a device is taking the session over.
    await this.ensureRemote(nativeId);
    return super.prompt(nativeId, content, clientMessageId);
  }

  override unqueue(nativeId: string, clientMessageId: string): boolean {
    const waiting = this.waiting.get(nativeId);
    const index = waiting?.findIndex((entry) => entry.clientMessageId === clientMessageId) ?? -1;
    if (!waiting || index < 0) return super.unqueue(nativeId, clientMessageId);
    waiting.splice(index, 1);
    if (waiting.length === 0) this.waiting.delete(nativeId);
    this.reportWaiting(nativeId);
    return true;
  }

  override reorderQueue(nativeId: string, clientMessageIds: string[]): void {
    const waiting = this.waiting.get(nativeId);
    if (!waiting) return super.reorderQueue(nativeId, clientMessageIds);
    this.waiting.set(nativeId, inOrder(waiting, clientMessageIds));
    this.reportWaiting(nativeId);
  }

  private reportWaiting(nativeId: string): void {
    this.host?.queue(
      this.id,
      nativeId,
      (this.waiting.get(nativeId) ?? []).map((entry) => ({
        clientMessageId: entry.clientMessageId,
        text: entry.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim(),
        images: entry.content.filter((block) => block.type === "image").length,
      })),
    );
  }

  /** Sends what waited for another Claude's turn, now that it has ended. */
  private async sendWaiting(nativeId: string): Promise<void> {
    const waiting = this.waiting.get(nativeId);
    if (!waiting?.length || (await this.elsewhere(nativeId))?.working) return;
    this.waiting.delete(nativeId);
    this.reportWaiting(nativeId);
    try {
      await this.ensureRemote(nativeId);
      for (const entry of waiting) await super.prompt(nativeId, entry.content, entry.clientMessageId);
    } catch (error) {
      this.emit(nativeId, {
        sessionUpdate: "ls_error",
        code: error instanceof RpcError ? (error.appCode ?? "send_failed") : "send_failed",
        message: `排队的消息没能发出：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  override async cancel(nativeId: string): Promise<void> {
    if (this.modes.get(nativeId) === "remote") return super.cancel(nativeId);
    // Stopping stops what's waiting too; the apps put queued text back in the composer.
    if (this.waiting.delete(nativeId)) this.reportWaiting(nativeId);
    // The turn runs in a Claude on the computer. A `linkshell claude` terminal
    // steps aside (which ends its turn); any other Claude is interrupted.
    if (this.host?.desktop(this.id, nativeId)) await this.ensureRemote(nativeId);
    else await this.interruptElsewhere(nativeId);
  }

  override async sendQueuedNow(nativeId: string): Promise<void> {
    if (!this.waiting.get(nativeId)?.length) return super.sendQueuedNow(nativeId);
    await this.interruptElsewhere(nativeId);
    await this.sendWaiting(nativeId);
  }

  /**
   * Stops the turn another Claude (the desktop app, a `claude` in a terminal)
   * is running in this session, the way Ctrl-C would: asked to stop first,
   * told to quit if it doesn't. Only ever the processes that have this session open.
   */
  private async interruptElsewhere(nativeId: string): Promise<void> {
    if (!(await this.elsewhere(nativeId))?.working) return;
    const recorded = (await this.foreignHolders(nativeId)).map((holder) => holder.pid);
    const pids = recorded.length > 0 || this.hasHolderRecords() ? recorded : await this.commandLineHolders(nativeId);
    const stopped = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!(await this.elsewhere(nativeId))?.working) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const pid of new Set(pids)) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
      if (await stopped(signal === "SIGINT" ? 6000 : 4000)) return;
    }
    throw RpcError.app("busy", "没能停下电脑上的这一轮：请在电脑上按 Esc 停止它");
  }

  override async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    if (this.modes.get(nativeId) === "remote" && this.sessions.get(nativeId)?.loaded) {
      await super.setConfig(nativeId, optionId, value);
      return;
    }
    // The desktop has it (or nobody): choosing a model mustn't take the session
    // from the terminal. Remember it; it applies when the phone next drives.
    const option = this.template?.find((entry) => entry.id === optionId);
    if (!option || !option.values.some((entry) => entry.value === value)) throw RpcError.app("invalid_params", `unknown setting ${optionId}=${value}`);
    this.host?.state(this.id, nativeId).set("pendingConfig", JSON.stringify({ ...this.pendingConfig(nativeId), [optionId]: value }));
    this.emitDesktopConfig(nativeId);
  }

  async takeover(nativeId: string): Promise<void> {
    await this.ensureRemote(nativeId);
  }

  async reclaim(nativeId: string, _context: DesktopLaunchContext): Promise<LaunchSpec> {
    await this.leaveRemote(nativeId);
    this.setMode(nativeId, "desktop");
    this.setWriter(nativeId, "desktop");
    return this.launchSpec(["--resume", nativeId]);
  }

  async desktopLaunch(args: string[], nativeId: string | undefined, context: DesktopLaunchContext): Promise<DesktopLaunch> {
    const parsed = this.parseSessionArgs(args);
    let id = nativeId ?? parsed.sessionId;
    let rest = parsed.rest;
    if (id) {
      await this.leaveRemote(id);
      rest = ["--resume", id, ...rest];
    } else {
      id = randomUUID();
      rest = ["--session-id", id, ...rest];
    }
    if (nativeId ?? parsed.sessionId) this.setMode(id, "desktop");
    else this.modes.set(id, "desktop"); // brand new: not registered yet, attach() reports it
    this.setWriter(id, "desktop");
    return { ...this.launchSpec(rest), nativeId: id, cwd: context.cwd };
  }

  // ── internals ──────────────────────────────────────────────────────

  private launchSpec(args: string[]): LaunchSpec {
    return { command: this.claudePath ?? this.claudeCommand, args };
  }

  /** Pulls a session id out of `--resume <id>` / `-r <id>` / `--session-id <id>`. */
  private parseSessionArgs(args: string[]): { sessionId?: string; rest: string[] } {
    const rest: string[] = [];
    let sessionId: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const next = args[i + 1];
      if ((arg === "--resume" || arg === "-r" || arg === "--session-id") && next && !next.startsWith("-")) {
        sessionId = next;
        i += 1;
      } else if (arg.startsWith("--resume=") || arg.startsWith("--session-id=")) {
        sessionId = arg.slice(arg.indexOf("=") + 1);
      } else {
        rest.push(arg);
      }
    }
    return { sessionId, rest };
  }

  private writer(nativeId: string): Writer | undefined {
    const value = this.host?.state(this.id, nativeId).get("writer");
    return value === "remote" || value === "desktop" ? value : undefined;
  }

  private setWriter(nativeId: string, writer: Writer): void {
    this.host?.state(this.id, nativeId).set("writer", writer);
  }

  private setMode(nativeId: string, mode: Mode): void {
    if (this.modes.get(nativeId) === mode) return;
    this.modes.set(nativeId, mode);
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_driver", driver: driverOf(mode) });
  }

  private startTail(nativeId: string, cwd: string, offset: number): void {
    this.tails.get(nativeId)?.stop();
    const tail = new TranscriptTail({
      locate: () => findTranscript(this.configDir, nativeId, cwd),
      offset,
      onLine: (line) => this.onTranscriptLine(nativeId, line),
    });
    if (this.modes.get(nativeId) === "remote") tail.pause();
    this.tails.set(nativeId, tail);
    tail.start();
  }

  /** Desktop activity: what the TUI (or a plain `claude`) writes to the transcript. */
  private onTranscriptLine(nativeId: string, line: string): void {
    let hidden = this.hiddenTools.get(nativeId);
    if (!hidden) this.hiddenTools.set(nativeId, (hidden = new Set()));
    let agents = this.backgroundAgents.get(nativeId);
    if (!agents) this.backgroundAgents.set(nativeId, (agents = new Set()));
    let seen = this.seenLines.get(nativeId);
    if (!seen) this.seenLines.set(nativeId, (seen = new Set()));
    const result = transcriptLine(line, { hidden, agents, seen });
    if (result.title) this.host?.update(this.id, nativeId, { sessionUpdate: "session_info_update", title: result.title });
    for (const update of result.updates) this.emit(nativeId, update);
    // Changed on the computer (another model, effort, permission mode): the phone shows it.
    const settings = mergeSettings(this.observed.get(nativeId) ?? {}, settingsOf(line));
    if (settings) {
      this.observed.set(nativeId, settings);
      this.emitDesktopConfig(nativeId);
    }
  }

  /** Makes this host the session's only writer, taking it from the desktop if needed. */
  private async ensureRemote(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (this.modes.get(nativeId) === "remote" && state?.loaded) return;
    const cwd = state?.cwd ?? "";
    // Claude writes nothing until the first message, and there is nothing to
    // resume without it: say so before the terminal gives the session up.
    if (!state?.loaded && !findTranscript(this.configDir, nativeId, cwd)) {
      throw RpcError.app("not_ready", "这个 Claude 会话还没有任何消息：先在电脑上发一条");
    }
    const desktop = this.host?.desktop(this.id, nativeId);
    let alsoOpenIn: "app" | "terminal" | undefined;
    if (desktop) {
      await desktop.yield();
    } else if (this.modes.get(nativeId) !== "remote") {
      const other = await this.elsewhere(nativeId);
      // Two Claudes writing one turn at once would garble it; a message sent now waits instead (see prompt).
      if (other?.working) throw RpcError.app("busy", "电脑上的 Claude 正在跑这一轮。直接发消息即可：会排队，等它结束后发出。");
      alsoOpenIn = other?.where;
    }
    // Take in the TUI's last lines, then stop following: ACP streams from here on.
    const tail = this.tails.get(nativeId);
    tail?.poll();
    tail?.pause();
    if (!findTranscript(this.configDir, nativeId, cwd) && !state?.loaded) {
      tail?.resumeAtEnd();
      throw RpcError.app("not_ready", "这个 Claude 会话还没有任何消息：先在电脑上发一条");
    }
    const target = this.stateFor(nativeId, cwd);
    if (!target.loaded) {
      const response = await this.rpc<Record<string, unknown>>("session/resume", { sessionId: nativeId, cwd, mcpServers: [], ...this.sessionMeta() });
      target.config = toConfigOptions(response);
      target.loaded = true;
    }
    // The session keeps the settings it ran with on the computer, except where
    // the phone chose otherwise while the desktop had it.
    const observed = this.observed.get(nativeId) ?? {};
    const kept = Object.fromEntries(target.config.flatMap((option) => [[option.id, observedValue(option, observed)]]).filter(([, value]) => value !== undefined));
    const pending = this.pendingConfig(nativeId);
    for (const [optionId, value] of Object.entries({ ...kept, ...pending } as Record<string, string>)) {
      const option = target.config.find((entry) => entry.id === optionId);
      if (option && option.current !== value && option.values.some((entry) => entry.value === value)) {
        await super.setConfig(nativeId, optionId, value).catch((error: unknown) => this.host?.log(`[claude] couldn't apply ${optionId}: ${String(error)}`));
      }
    }
    if (Object.keys(pending).length) this.host?.state(this.id, nativeId).set("pendingConfig", "{}");
    this.setWriter(nativeId, "remote");
    this.setMode(nativeId, "remote");
    this.emitConfig(nativeId, target);
    if (alsoOpenIn) {
      // That Claude keeps its own copy of the conversation and can't be told about this one.
      this.emit(
        nativeId,
        alsoOpenIn === "app"
          ? {
              sessionUpdate: "ls_notice",
              level: "info",
              title: "已在手机上接着做",
              detail: "这个会话在 Claude 桌面 App 里也开着：App 要重启后才会显示手机上的消息。",
            }
          : {
              sessionUpdate: "ls_notice",
              level: "info",
              title: "已在手机上接着做",
              detail: `这个会话在电脑终端里也开着：那边要重新打开才会显示手机上的消息（用 linkshell claude --resume ${nativeId} 打开，之后可以随时接力）。`,
            },
      );
    }
    this.startWatch();
  }

  private startWatch(): void {
    this.remoteWatch ??= setInterval(() => {
      // Process inspection can outlast the poll interval. Two simultaneous
      // checks must not both take over and send the same queued prompt.
      this.remoteWatchRun ??= this.watchRemoteSessions()
        .catch((error: unknown) => this.host?.log(`[claude] session watch: ${String(error)}`))
        .finally(() => { this.remoteWatchRun = undefined; });
    }, this.holderCheckMs);
    this.remoteWatch.unref?.();
  }

  /**
   * A session driven from a device that another Claude wrote to (the desktop
   * app, or a `claude` in a terminal, continued it): that process has the
   * conversation now, so stop writing to it and follow what it does instead.
   */
  taskOutput(nativeId: string, taskId: string, before: number | undefined, limit: number) {
    return this.tasks.get(nativeId)?.output(nativeId, taskId, before, limit);
  }

  private async watchRemoteSessions(): Promise<void> {
    for (const [nativeId, tasks] of this.tasks) {
      const activity = this.activity.get(nativeId);
      if (![...tasks.records.values()].some((task) => task.state === "running") && !activity?.hasRunningTeammates()) continue;
      if (this.modes.get(nativeId) === "remote" && this.sessions.get(nativeId)?.loaded) continue;
      if (sessionHolders(this.configDir, nativeId).length === 0) {
        tasks.lostHolder();
        activity?.lostHolder();
      }
    }
    for (const nativeId of [...this.waiting.keys()]) await this.sendWaiting(nativeId).catch(() => {});
    for (const [nativeId, mode] of this.modes) {
      if (mode !== "remote" || this.host?.desktop(this.id, nativeId)) continue;
      if (!this.tails.get(nativeId)?.writtenMeanwhile(writtenByAnotherClaude)) continue;
      await this.leaveRemote(nativeId).catch(() => {});
      this.emit(nativeId, {
        sessionUpdate: "ls_notice",
        level: "info",
        title: "电脑上继续了这个会话",
        detail: "这里转为实时显示电脑上的进展；再发消息会重新接管。",
      });
    }
  }

  /** Running Claude processes on this session that this host didn't start. */
  private async foreignHolders(nativeId: string): Promise<SessionHolder[]> {
    const foreign: SessionHolder[] = [];
    for (const holder of sessionHolders(this.configDir, nativeId)) {
      // The adapter's own Claude process is a child of this host.
      if (!(await descendsFrom(holder.pid, process.pid))) foreign.push(holder);
    }
    return foreign;
  }

  /** Hands the session back: stop remote driving and resume following the transcript. */
  private async leaveRemote(nativeId: string): Promise<void> {
    if (this.modes.get(nativeId) !== "remote") return;
    const state = this.sessions.get(nativeId);
    if (state?.turnActive) {
      await super.cancel(nativeId).catch(() => {});
      const deadline = Date.now() + 5000;
      while (state.turnActive && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await super.detach(nativeId);
    this.setMode(nativeId, "idle");
    // What the remote turns wrote was already streamed live; anything another
    // Claude wrote in between (it was reopened on the computer) is new.
    this.tails.get(nativeId)?.resumeSkipping((line) => line.includes(REMOTE_ENTRYPOINT));
  }

  /**
   * With no `linkshell claude` terminal to ask: another Claude (the desktop
   * app, a `claude` in some terminal) that has the session open, and whether
   * it is in the middle of a turn. It can't be made to step aside, and it won't
   * show what a device does until it is reopened; a device continues the
   * session all the same, once that turn is over.
   */
  private async elsewhere(nativeId: string): Promise<{ where: "app" | "terminal"; working: boolean } | undefined> {
    if (this.modes.get(nativeId) === "remote" || this.host?.desktop(this.id, nativeId)) return undefined;
    const path = findTranscript(this.configDir, nativeId, this.sessions.get(nativeId)?.cwd ?? "");
    if (!path) return undefined;
    // Claude's own record of who has the session open.
    const holders = await this.foreignHolders(nativeId);
    if (holders.length > 0) {
      const where = holders.some((holder) => holder.entrypoint !== "claude-desktop") ? "terminal" : "app";
      return { where, working: turnInProgress(path, this.busyWindowMs) };
    }
    if (this.hasHolderRecords()) return undefined;
    // An older Claude keeps no such record: its command line, or a transcript it wrote moments ago, is the sign.
    if (await this.tuiProcessHolds(nativeId)) return { where: "terminal", working: turnInProgress(path, this.busyWindowMs) };
    const justWritten = Date.now() - statSync(path).mtimeMs < Math.min(this.busyWindowMs, 60_000);
    return justWritten && this.writer(nativeId) === undefined && turnInProgress(path, this.busyWindowMs) ? { where: "terminal", working: true } : undefined;
  }

  private async tuiProcessHolds(nativeId: string): Promise<boolean> {
    return (await this.commandLineHolders(nativeId)).length > 0;
  }

  /** Whether this Claude records who has which session open (see holders.ts). */
  private hasHolderRecords(): boolean {
    return existsSync(join(this.configDir, "sessions"));
  }

  /** Processes with the session on their command line (`claude --resume <id>`): how an older Claude shows it. */
  private async commandLineHolders(nativeId: string): Promise<number[]> {
    try {
      // -ww: never truncate; the session id is at the end of long command lines.
      const { stdout } = await execFileAsync("/bin/ps", ["-Aww", "-o", "pid=,command="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      const pids: number[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.includes(nativeId) || line.includes("claude-agent-acp")) continue;
        const pid = Number(line.trim().split(/\s+/, 1)[0]);
        if (Number.isInteger(pid) && pid !== process.pid) pids.push(pid);
      }
      return pids;
    } catch {
      return [];
    }
  }

  /** Mirrors remote progress to the terminal that stepped aside. */
  protected override emit(nativeId: string, update: SessionUpdate): void {
    super.emit(nativeId, update);
    if (this.modes.get(nativeId) !== "remote") return;
    const desktop = this.host?.desktop(this.id, nativeId);
    if (!desktop) return;
    if (update.sessionUpdate === "tool_call") desktop.activity(`  ↳ ${update.title}`);
    else if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
      desktop.activity(`📱 ${update.content.text.split("\n")[0]!.slice(0, 160)}`);
    } else if (update.sessionUpdate === "ls_turn" && update.state === "ended") desktop.activity("   (回合结束)");
  }
}

/**
 * The option value for a model id from a transcript ("claude-opus-5-5"):
 * "default" when that's what default resolves to, else the entry with that
 * name ("Opus 5.5").
 */
/**
 * A closing Claude process writes its exit record (last prompt, title, cost)
 * after the adapter has deleted the transcript, bringing the file back. Removes
 * it again for a while after a delete.
 */
function sweepTranscript(path: string, forMs = 15_000): void {
  const sessionDir = path.replace(/\.jsonl$/, "");
  const until = Date.now() + forMs;
  const sweep = () => {
    for (const target of [path, sessionDir]) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
    if (Date.now() < until) setTimeout(sweep, 250).unref();
  };
  sweep();
}

/** The value of a setting that matches what the session was seen running with, if it says. */
function observedValue(option: SessionConfigOption, observed: ObservedSettings): string | undefined {
  if (option.category === "model") return observed.model ? matchModel(option, observed.model) : undefined;
  if (option.category === "mode") return observed.mode;
  if (option.id === "effort" || option.category === "effort") return observed.effort;
  if (option.id === "fast") return observed.fast === undefined ? undefined : observed.fast ? "on" : "off";
  return undefined;
}

export function matchModel(option: SessionConfigOption, modelId: string): string | undefined {
  if (option.values.some((value) => value.value === modelId)) return modelId;
  const parts = modelId.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const family = parts.shift();
  if (!family || parts.length === 0) return undefined;
  const name = `${family[0]!.toUpperCase()}${family.slice(1)} ${parts.join(".")}`;
  const byDefault = option.values.find((value) => value.value === "default" && value.description === name);
  if (byDefault) return byDefault.value;
  return option.values.find((value) => value.name === name)?.value;
}
