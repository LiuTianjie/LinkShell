import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { RpcError, type ContentBlock, type SessionConfigOption, type SessionUpdate } from "@linkshell/wire";
import { AcpDriver } from "../acp/driver.js";
import { AcpItemTracker, toConfigOptions, toHistory, type SourcedConfigOption } from "../acp/mapper.js";
import { parseClaudeAuthStatus, runStatusCommand } from "../auth.js";
import type { AttachContext, DesktopLaunch, DesktopLaunchContext, DiscoveredSession, HistoryItem, LaunchSpec } from "../types.js";
import { claudeConfigDir, findTranscript, readTranscript, transcriptLine, transcriptTimes, TranscriptTail } from "./transcript.js";

const execFileAsync = promisify(execFile);

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
  /** A transcript written within this window counts as "in use" by an unmanaged TUI. */
  busyWindowMs?: number;
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
  /**
   * The settings Claude offers (model, effort, permission mode…), as the
   * adapter reported them for any session: what a desktop-driven session
   * shows before the phone has it open over ACP.
   */
  private template?: SourcedConfigOption[];
  private templateLoading?: Promise<SourcedConfigOption[] | undefined>;
  /** Desktop-driven sessions: the model of the latest reply, from the transcript. */
  private readonly lastModels = new Map<string, string>();
  /** Per session: TodoWrite calls shown as the plan, whose results the tail skips. */
  private readonly hiddenTools = new Map<string, Set<string>>();
  private readonly claudeCommand: string;
  private readonly configDir: string;
  private readonly busyWindowMs: number;
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
    this.busyWindowMs = options.busyWindowMs ?? 60_000;
    this.adapterMissing = adapterMissing;
    this.capabilities = { ...this.capabilities, models: true, modes: true };
  }

  private readonly adapterMissing: boolean;

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
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
    await super.stop();
  }

  override async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    const state = this.stateFor(nativeId, context.cwd);
    const path = findTranscript(this.configDir, nativeId, context.cwd);
    let history: HistoryItem[] = [];
    let offset = 0;
    if (path) {
      const transcript = readTranscript(path);
      state.tracker = new AcpItemTracker();
      history = toHistory(transcript.updates, state.tracker, (update) => transcriptTimes.get(update));
      offset = transcript.size;
      if (transcript.model) this.lastModels.set(nativeId, transcript.model);
      if (transcript.title) this.host?.update(this.id, nativeId, { sessionUpdate: "session_info_update", title: transcript.title });
    }
    this.startTail(nativeId, context.cwd, offset);
    const mode = this.modes.get(nativeId) ?? "idle";
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_driver", driver: driverOf(mode) });
    if (mode === "remote") this.emitConfig(nativeId, state);
    else void this.loadTemplate(context.cwd).then(() => this.emitDesktopConfig(nativeId));
    return history;
  }

  protected override emitConfig(nativeId: string, state: Parameters<AcpDriver["emitConfig"]>[1]): void {
    if (state.config.length > 0) this.template = state.config;
    super.emitConfig(nativeId, state);
  }

  /**
   * Claude's settings list without a session to ask: a throwaway session that
   * never gets a message (Claude writes no transcript for it), closed at once.
   */
  private loadTemplate(cwd: string): Promise<SourcedConfigOption[] | undefined> {
    if (this.template) return Promise.resolve(this.template);
    this.templateLoading ??= (async () => {
      try {
        const response = await this.rpc<Record<string, unknown>>("session/new", { cwd, mcpServers: [] });
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
    const model = this.lastModels.get(nativeId);
    const options: SessionConfigOption[] = this.template.map(({ source: _source, ...option }) => {
      let current = option.current;
      if (option.category === "model" && model) current = matchModel(option, model) ?? current;
      const chosen = pending[option.id];
      if (chosen && option.values.some((value) => value.value === chosen)) current = chosen;
      return { ...option, current };
    });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_config", options });
  }

  override async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    const created = await super.createSession(options);
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
    await super.delete(nativeId);
    this.modes.delete(nativeId);
    this.hiddenTools.delete(nativeId);
  }

  override async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string): Promise<"started" | "steered" | "queued"> {
    // Sending from a device is taking the session over.
    await this.ensureRemote(nativeId);
    return super.prompt(nativeId, content, clientMessageId);
  }

  override async cancel(nativeId: string): Promise<void> {
    if (this.modes.get(nativeId) !== "remote") {
      throw RpcError.app("not_supported", "Claude 正在电脑上运行：先接管，再停止");
    }
    await super.cancel(nativeId);
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
    const result = transcriptLine(line, { hidden });
    if (result.title) this.host?.update(this.id, nativeId, { sessionUpdate: "session_info_update", title: result.title });
    for (const update of result.updates) this.emit(nativeId, update);
  }

  /** Makes this host the session's only writer, taking it from the desktop if needed. */
  private async ensureRemote(nativeId: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    if (this.modes.get(nativeId) === "remote" && state?.loaded) return;
    const cwd = state?.cwd ?? "";
    const desktop = this.host?.desktop(this.id, nativeId);
    if (desktop) {
      await desktop.yield();
    } else if (this.modes.get(nativeId) !== "remote") {
      await this.refuseIfTuiMayBeActive(nativeId, cwd);
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
      const response = await this.rpc<Record<string, unknown>>("session/resume", { sessionId: nativeId, cwd, mcpServers: [] });
      target.config = toConfigOptions(response);
      target.loaded = true;
    }
    // Settings chosen while the desktop had the session.
    const pending = this.pendingConfig(nativeId);
    for (const [optionId, value] of Object.entries(pending)) {
      const option = target.config.find((entry) => entry.id === optionId);
      if (option && option.current !== value && option.values.some((entry) => entry.value === value)) {
        await super.setConfig(nativeId, optionId, value).catch((error: unknown) => this.host?.log(`[claude] couldn't apply ${optionId}: ${String(error)}`));
      }
    }
    if (Object.keys(pending).length) this.host?.state(this.id, nativeId).set("pendingConfig", "{}");
    this.setWriter(nativeId, "remote");
    this.setMode(nativeId, "remote");
    this.emitConfig(nativeId, target);
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
    // Skip what the remote turns wrote; those were already streamed live.
    this.tails.get(nativeId)?.resumeAtEnd();
  }

  /**
   * With no `linkshell claude` terminal to ask, make sure no other `claude` is
   * writing the session before becoming a second writer. If this host or a
   * managed terminal wrote it last, only a live process counts; otherwise a
   * transcript written moments ago does too (a plain `claude` may be mid-turn).
   */
  private async refuseIfTuiMayBeActive(nativeId: string, cwd: string): Promise<void> {
    const path = findTranscript(this.configDir, nativeId, cwd);
    if (!path) return;
    const known = this.writer(nativeId) !== undefined;
    const recentlyWritten = !known && Date.now() - statSync(path).mtimeMs < this.busyWindowMs;
    if (!recentlyWritten && !(await this.tuiProcessHolds(nativeId))) return;
    throw RpcError.app(
      "busy",
      `这个会话正在电脑上用 claude 直接运行，无法安全接管。在电脑终端用 linkshell claude --resume ${nativeId} 打开后即可接力。`,
    );
  }

  private async tuiProcessHolds(nativeId: string): Promise<boolean> {
    try {
      // -ww: never truncate; the session id is at the end of long command lines.
      const { stdout } = await execFileAsync("/bin/ps", ["-Aww", "-o", "command="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      return stdout.split("\n").some((command) => command.includes(nativeId) && !command.includes("claude-agent-acp"));
    } catch {
      return false;
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
