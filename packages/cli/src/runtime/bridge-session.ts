import * as pty from "node-pty";
import * as http from "node:http";
import WebSocket from "ws";
import { hostname, platform, homedir } from "node:os";
import { writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
  PROTOCOL_VERSION,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type { ProviderConfig } from "../providers.js";
import { ScrollbackBuffer } from "./scrollback.js";
import { ScreenFallback } from "./screen-fallback.js";
import { ScreenShare } from "./screen-share.js";
import { getLanIp } from "../utils/lan-ip.js";

export interface BridgeSessionOptions {
  gatewayUrl: string;
  gatewayHttpUrl: string;
  pairingGateway?: string;
  sessionId?: string;
  cols: number;
  rows: number;
  clientName: string;
  hostname?: string;
  verbose?: boolean;
  screen?: boolean;
  providerConfig: ProviderConfig;
}

const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
const RECONNECT_MAX_ATTEMPTS = 20;
const DEFAULT_TERMINAL_ID = "default";

interface TerminalInstance {
  id: string;
  pty: pty.IPty;
  cwd: string;
  projectName: string;
  provider: string;
  scrollback: ScrollbackBuffer;
  outputSeq: number;
  statusSeq: number;
  status: "running" | "exited";
  hookServer?: http.Server;
  hookPort?: number;
  hookConfigPath?: string;
}

function getPairingGatewayParam(gatewayHttpUrl: string): string | undefined {
  try {
    const url = new URL(gatewayHttpUrl);
    const hostname = url.hostname.trim().toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    ) {
      // Replace localhost with LAN IP so real devices can reach it
      const lanIp = getLanIp();
      if (lanIp === "127.0.0.1") {
        return undefined; // No LAN interface found, can't help
      }
      url.hostname = lanIp;
      return url.toString().replace(/\/+$/, "");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return gatewayHttpUrl.replace(/\/+$/, "") || undefined;
  }
}

function resolvePairingGateway(
  gatewayHttpUrl: string,
  pairingGateway?: string,
): string | undefined {
  const override = pairingGateway?.trim();
  if (!override) {
    return getPairingGatewayParam(gatewayHttpUrl);
  }

  try {
    const absoluteUrl = new URL(override);
    return absoluteUrl.toString().replace(/\/+$/, "");
  } catch {
    try {
      const baseUrl = new URL(gatewayHttpUrl);
      const normalizedHost = override
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .trim();

      if (!normalizedHost) {
        return getPairingGatewayParam(gatewayHttpUrl);
      }

      baseUrl.hostname = normalizedHost;
      return baseUrl.toString().replace(/\/+$/, "");
    } catch {
      return override.replace(/\/+$/, "") || undefined;
    }
  }
}

export class BridgeSession {
  private readonly options: BridgeSessionOptions;
  private socket: WebSocket | undefined;
  private terminals = new Map<string, TerminalInstance>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private sessionId = "";
  private exited = false;
  private stopped = false;
  private permissionStacks = new Map<string, Array<{
    requestId: string;
    toolName: string;
    toolInput: string;
    permissionRequest: string;
    timestamp: number;
  }>>();
  private screenCapture: ScreenFallback | undefined;
  private screenShare: ScreenShare | undefined;

  constructor(options: BridgeSessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? "";
  }

  private log(msg: string): void {
    if (this.options.verbose) {
      process.stderr.write(`[bridge:verbose] ${msg}\n`);
    }
  }

  async start(): Promise<void> {
    this.log(
      `starting session (gateway=${this.options.gatewayUrl}, provider=${this.options.providerConfig.provider})`,
    );
    if (!this.sessionId) {
      await this.createPairing();
    }
    await this.spawnTerminal(DEFAULT_TERMINAL_ID, process.cwd());
    this.connectGateway();
  }

  private async createPairing(): Promise<void> {
    const res = await fetch(`${this.options.gatewayHttpUrl}/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Failed to create pairing: ${res.status}`);
    }
    const body = (await res.json()) as {
      sessionId: string;
      pairingCode: string;
      expiresAt: string;
    };
    this.sessionId = body.sessionId;

    const pairingGateway = resolvePairingGateway(
      this.options.gatewayHttpUrl,
      this.options.pairingGateway,
    );
    const deepLink = pairingGateway
      ? `linkshell://pair?code=${body.pairingCode}&gateway=${encodeURIComponent(pairingGateway)}`
      : `linkshell://pair?code=${body.pairingCode}`;

    process.stderr.write(
      `\n  \x1b[1mPairing code: \x1b[36m${body.pairingCode}\x1b[0m\n`,
    );
    process.stderr.write(`  Session: ${body.sessionId}\n`);
    process.stderr.write(`  Expires: ${body.expiresAt}\n\n`);
    if (!pairingGateway) {
      process.stderr.write(
        "  Note: QR will use the app's current gateway because the CLI is pointed at a local-only address.\n\n",
      );
    } else if (this.options.pairingGateway) {
      process.stderr.write(`  Pairing gateway: ${pairingGateway}\n\n`);
    }

    // Show QR code for mobile scanning
    try {
      const qrModule = await import("qrcode-terminal");
      const qrDriver = qrModule.default ?? qrModule;
      if (typeof qrDriver.generate === "function") {
        qrDriver.generate(deepLink, { small: true }, (code: string) => {
          process.stderr.write(`  Scan to connect:\n`);
          for (const line of code.split("\n")) {
            process.stderr.write(`  ${line}\n`);
          }
          process.stderr.write(`\n`);
        });
      }
    } catch {
      // qrcode-terminal not available, skip
    }

    process.stderr.write(`  Deep link: ${deepLink}\n\n`);
  }

  private connectGateway(): void {
    if (this.stopped) {
      return;
    }

    const url = new URL(this.options.gatewayUrl);
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("role", "host");

    this.socket = new WebSocket(url);

    this.socket.on("open", () => {
      process.stderr.write(
        this.reconnectAttempts > 0
          ? "[bridge] gateway reconnected\n"
          : "[bridge] gateway connected\n",
      );
      this.reconnectAttempts = 0;
      this.reconnecting = false;
      this.send(
        createEnvelope({
          type: "session.connect",
          sessionId: this.sessionId,
          payload: {
            role: "host" as const,
            clientName: this.options.clientName,
            provider: this.options.providerConfig.provider,
            protocolVersion: PROTOCOL_VERSION,
            hostname: this.options.hostname || hostname(),
            platform: platform(),
            cwd: process.cwd(),
            projectName: basename(process.cwd()),
          },
        }),
      );
      this.startHeartbeat();
    });

    this.socket.on("message", (data) => {
      const envelope = parseEnvelope(data.toString());
      this.log(
        `recv ${envelope.type}${envelope.seq !== undefined ? ` seq=${envelope.seq}` : ""}`,
      );
      this.handleMessage(envelope).catch((err) => {
        this.log(`handleMessage error: ${err}`);
      });
    });

    this.socket.on("close", (code, reasonBuffer) => {
      this.stopHeartbeat();
      this.socket = undefined;
      const reason = reasonBuffer.toString();
      process.stderr.write(
        `[bridge] gateway connection closed (code=${code}${reason ? `, reason=${reason}` : ""})\n`,
      );
      if (!this.exited) {
        this.scheduleReconnect();
      }
    });

    this.socket.on("error", (error) => {
      process.stderr.write(`[bridge] gateway error: ${error.message}\n`);
    });
  }

  private async handleMessage(envelope: Envelope): Promise<void> {
    const tid = envelope.terminalId ?? DEFAULT_TERMINAL_ID;
    switch (envelope.type) {
      case "terminal.input": {
        const p = parseTypedPayload("terminal.input", envelope.payload);
        const term = this.terminals.get(tid);
        if (term && term.status === "running") term.pty.write(p.data);
        break;
      }
      case "terminal.resize": {
        const p = parseTypedPayload("terminal.resize", envelope.payload);
        const term = this.terminals.get(tid);
        if (term && term.status === "running") term.pty.resize(p.cols, p.rows);
        break;
      }
      case "terminal.spawn": {
        const p = parseTypedPayload("terminal.spawn", envelope.payload);
        const normalizedCwd = resolve(p.cwd);
        // Dedup: if a running terminal already exists for this cwd, return it
        const existing = [...this.terminals.values()].find(
          (t) => t.status === "running" && resolve(t.cwd) === normalizedCwd,
        );
        if (existing) {
          this.send(createEnvelope({
            type: "terminal.spawned",
            sessionId: this.sessionId,
            terminalId: existing.id,
            payload: { terminalId: existing.id, cwd: existing.cwd, projectName: existing.projectName },
          }));
        } else {
          const newId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          try {
            await this.spawnTerminal(newId, normalizedCwd, p.provider);
            this.send(createEnvelope({
              type: "terminal.spawned",
              sessionId: this.sessionId,
              terminalId: newId,
              payload: { terminalId: newId, cwd: normalizedCwd, projectName: basename(normalizedCwd) },
            }));
          } catch (err) {
            this.log(`failed to spawn terminal ${newId}: ${err}`);
            this.send(createEnvelope({
              type: "terminal.exit",
              sessionId: this.sessionId,
              terminalId: newId,
              payload: { exitCode: 1, signal: 0 },
            }));
          }
        }
        this.sendTerminalList();
        break;
      }
      case "terminal.kill": {
        const p = parseTypedPayload("terminal.kill", envelope.payload);
        const term = this.terminals.get(p.terminalId);
        if (term && term.status === "running") {
          term.pty.kill();
        }
        break;
      }
      case "terminal.browse": {
        const p = parseTypedPayload("terminal.browse", envelope.payload);
        // Expand ~ to home directory
        const rawPath = p.path.startsWith("~") ? p.path.replace(/^~/, homedir()) : p.path;
        const browsePath = resolve(rawPath);
        try {
          const entries = readdirSync(browsePath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) => ({
              name: d.name,
              path: join(browsePath, d.name),
              isDirectory: true,
            }));
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: browsePath, entries },
          }));
        } catch (err: unknown) {
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: browsePath, entries: [], error: (err as Error).message },
          }));
        }
        break;
      }
      case "terminal.list": {
        this.sendTerminalList();
        break;
      }
      case "session.ack": {
        const p = parseTypedPayload("session.ack", envelope.payload);
        const term = this.terminals.get(tid);
        if (term) {
          term.scrollback.trimUpTo(p.seq);
        }
        break;
      }
      case "session.resume": {
        const p = parseTypedPayload("session.resume", envelope.payload);
        // Replay all terminals
        for (const [termId, term] of this.terminals) {
          this.replayFrom(termId, term, p.lastAckedSeq);
        }
        // Also send terminal list so client knows what's available
        this.sendTerminalList();
        break;
      }
      case "session.heartbeat":
        break;
      case "screen.start": {
        const p = parseTypedPayload("screen.start", envelope.payload);
        this.startScreenCapture(p.fps, p.quality, p.scale);
        break;
      }
      case "screen.stop": {
        this.stopScreenCapture();
        break;
      }
      case "screen.answer": {
        const p = parseTypedPayload("screen.answer", envelope.payload);
        this.screenShare?.handleAnswer(p.sdp);
        break;
      }
      case "screen.ice": {
        const p = parseTypedPayload("screen.ice", envelope.payload);
        this.screenShare?.handleIceCandidate(p.candidate, p.sdpMid, p.sdpMLineIndex);
        break;
      }
      case "file.upload": {
        const p = parseTypedPayload("file.upload", envelope.payload);
        const ext = p.filename.split(".").pop() || "png";
        const tempPath = join(tmpdir(), `linkshell-image-${Date.now()}.${ext}`);
        writeFileSync(tempPath, Buffer.from(p.data, "base64"));
        this.log(`image saved to ${tempPath}`);
        const term = this.terminals.get(tid);
        if (term && term.status === "running") {
          term.pty.write(`\x1b[200~${tempPath}\x1b[201~`);
        }
        break;
      }
      default:
        break;
    }
  }

  private sendTerminalList(): void {
    const terminals = [...this.terminals.values()].map((t) => ({
      terminalId: t.id,
      cwd: t.cwd,
      projectName: t.projectName,
      provider: t.provider,
      status: t.status,
    }));
    this.send(createEnvelope({
      type: "terminal.list",
      sessionId: this.sessionId,
      payload: { terminals },
    }));
  }

  private replayFrom(terminalId: string, term: TerminalInstance, afterSeq: number): void {
    const messages = term.scrollback.replayFrom(afterSeq);
    for (const msg of messages) {
      const payload = msg.payload as {
        stream: string;
        data: string;
        encoding: string;
        isReplay: boolean;
        isFinal: boolean;
      };
      this.send(
        createEnvelope({
          type: "terminal.output",
          sessionId: this.sessionId,
          terminalId,
          seq: msg.seq,
          payload: { ...payload, isReplay: true },
        }),
      );
    }
  }

  private async spawnTerminal(terminalId: string, cwd: string, providerOverride?: string): Promise<void> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.providerConfig.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }

    const provider = providerOverride ?? this.options.providerConfig.provider;
    const args = [...this.options.providerConfig.args];

    // Set up hook server for structured status (all supported providers)
    // For "custom" shell, set up hooks for all providers since user may launch any of them
    let hookServer: http.Server | undefined;
    let hookPort: number | undefined;
    let hookConfigPath: string | undefined;

    if (provider === "custom") {
      const result = await this.setupHookServer(terminalId, args, "claude");
      hookServer = result.server;
      hookPort = result.port;
      hookConfigPath = result.configPath;
      // Also set up hooks for other providers
      const curlCmd = `curl -s -X POST http://127.0.0.1:${result.port}/hook -H 'Content-Type: application/json' -d "$(cat)"`;
      this.setupCodexHooks(terminalId, curlCmd);
      this.setupGeminiHooks(terminalId, curlCmd);
      this.setupCopilotHooks(terminalId, curlCmd);
    } else if (provider === "claude" || provider === "codex" || provider === "gemini" || provider === "copilot") {
      const result = await this.setupHookServer(terminalId, args, provider);
      hookServer = result.server;
      hookPort = result.port;
      hookConfigPath = result.configPath;
    }

    const term: TerminalInstance = {
      id: terminalId,
      pty: pty.spawn(
        this.options.providerConfig.command,
        args,
        {
          name: "xterm-256color",
          cols: this.options.cols,
          rows: this.options.rows,
          cwd,
          env: cleanEnv,
        },
      ),
      cwd,
      projectName: basename(cwd),
      provider,
      scrollback: new ScrollbackBuffer(1000),
      outputSeq: 0,
      statusSeq: 0,
      status: "running",
      hookServer,
      hookPort,
      hookConfigPath,
    };

    term.pty.onData((data) => {
      const seq = term.outputSeq++;
      const envelope = createEnvelope({
        type: "terminal.output",
        sessionId: this.sessionId,
        terminalId,
        seq,
        payload: {
          stream: "stdout" as const,
          data,
          encoding: "utf8" as const,
          isReplay: false,
          isFinal: false,
        },
      });
      term.scrollback.push(envelope);
      this.send(envelope);
    });

    term.pty.onExit(({ exitCode, signal }) => {
      term.status = "exited";
      this.cleanupHookServer(term);
      this.send(createEnvelope({
        type: "terminal.exit",
        sessionId: this.sessionId,
        terminalId,
        payload: { exitCode, signal },
      }));
      this.sendTerminalList();

      // If all terminals exited, close the session
      const allExited = [...this.terminals.values()].every((t) => t.status === "exited");
      if (allExited) {
        this.exited = true;
        setTimeout(() => {
          this.stopHeartbeat();
          this.socket?.close();
        }, 500);
        process.exitCode = exitCode ?? 0;
      }
    });

    this.terminals.set(terminalId, term);
    this.log(`spawned terminal ${terminalId} in ${cwd}`);
  }

  private async setupHookServer(terminalId: string, args: string[], provider: string): Promise<{
    server: http.Server;
    port: number;
    configPath: string;
  }> {
    const server = http.createServer((req, res) => {
      this.log(`hook server received: ${req.method} ${req.url}`);
      if (req.method !== "POST" || req.url !== "/hook") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
        this.log(`hook body (${body.length} bytes): ${body.slice(0, 200)}`);
        try {
          const event = JSON.parse(body);
          this.handleHookEvent(terminalId, event, provider);
        } catch (e) {
          this.log(`hook parse error: ${e}`);
        }
      });
    });

    // Listen on random port — await binding before reading address
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
      server.on("error", reject);
    });
    this.log(`hook server for ${terminalId} (${provider}) listening on port ${port}`);

    const curlCmd = `curl -s -X POST http://127.0.0.1:${port}/hook -H 'Content-Type: application/json' -d "$(cat)"`;
    let configPath: string;

    if (provider === "codex") {
      configPath = this.setupCodexHooks(terminalId, curlCmd);
    } else if (provider === "gemini") {
      configPath = this.setupGeminiHooks(terminalId, curlCmd);
    } else if (provider === "copilot") {
      configPath = this.setupCopilotHooks(terminalId, curlCmd);
    } else {
      // Claude (default)
      configPath = this.setupClaudeHooks(terminalId, curlCmd, args);
    }

    return { server, port, configPath };
  }

  private setupClaudeHooks(terminalId: string, curlCmd: string, args: string[]): string {
    // Write hooks to ~/.claude/settings.local.json so Claude picks them up
    // regardless of how it's launched (direct or inside a custom shell)
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");

    // Backup existing settings
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch { /* doesn't exist yet */ }

    // Save backup for restore
    const backupPath = join(tmpdir(), `linkshell-claude-settings-backup-${terminalId}.json`);
    writeFileSync(backupPath, JSON.stringify(existing));

    const hookEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const hookEntryWithMatcher = { matcher: "*", hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const permissionEntry = { matcher: "*", hooks: [{ type: "command", command: curlCmd, timeout: 86400 }] };

    const merged = {
      ...existing,
      hooks: {
        PreToolUse: [hookEntryWithMatcher],
        PostToolUse: [hookEntryWithMatcher],
        PostToolUseFailure: [hookEntryWithMatcher],
        Stop: [hookEntry],
        PermissionRequest: [permissionEntry],
        UserPromptSubmit: [hookEntry],
        SessionStart: [hookEntry],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    this.log(`claude hooks written to ${settingsPath} (backup at ${backupPath})`);

    return backupPath;
  }

  private setupCodexHooks(terminalId: string, curlCmd: string): string {
    // Codex uses ~/.codex/hooks.json — nested format (no matcher)
    const codexDir = join(homedir(), ".codex");
    if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });

    // Ensure codex_hooks = true in config.toml
    const tomlPath = join(codexDir, "config.toml");
    let tomlContent = "";
    try { tomlContent = readFileSync(tomlPath, "utf8"); } catch { /* doesn't exist yet */ }
    if (!tomlContent.includes("codex_hooks")) {
      tomlContent += `\ncodex_hooks = true\n`;
      writeFileSync(tomlPath, tomlContent);
      this.log(`enabled codex_hooks in ${tomlPath}`);
    }

    const hooksPath = join(codexDir, "hooks.json");
    const hookEntry = { hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const config = {
      hooks: {
        SessionStart: [hookEntry],
        PreToolUse: [hookEntry],
        PostToolUse: [hookEntry],
      },
    };

    // Backup existing hooks.json if present and not ours
    if (existsSync(hooksPath)) {
      try {
        const existing = readFileSync(hooksPath, "utf8");
        if (!existing.includes(`127.0.0.1:`) || !existing.includes("/hook")) {
          writeFileSync(`${hooksPath}.linkshell-backup`, existing);
          this.log(`backed up existing codex hooks`);
        }
      } catch { /* ignore */ }
    }

    writeFileSync(hooksPath, JSON.stringify(config, null, 2));
    this.log(`codex hook config written to ${hooksPath}`);
    return hooksPath;
  }

  private setupGeminiHooks(terminalId: string, curlCmd: string): string {
    // Gemini uses ~/.gemini/settings.json — nested format, timeout in milliseconds
    const geminiDir = join(homedir(), ".gemini");
    if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

    const settingsPath = join(geminiDir, "settings.json");
    const hookEntry = { hooks: [{ type: "command", command: curlCmd, timeout: 5000 }] };
    const hookConfig = {
      SessionStart: [hookEntry],
      BeforeTool: [hookEntry],
      AfterTool: [hookEntry],
      BeforeSubmitPrompt: [hookEntry],
      AfterSubmitPrompt: [hookEntry],
      SessionEnd: [hookEntry],
    };

    // Merge with existing settings if present
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch { /* doesn't exist yet */ }

    // Backup existing hooks if present and not ours
    if (existing.hooks && JSON.stringify(existing.hooks).indexOf("127.0.0.1:") === -1) {
      writeFileSync(`${settingsPath}.linkshell-backup`, JSON.stringify(existing, null, 2));
      this.log(`backed up existing gemini settings`);
    }

    existing.hooks = hookConfig;
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    this.log(`gemini hook config written to ${settingsPath}`);
    return settingsPath;
  }

  private setupCopilotHooks(terminalId: string, curlCmd: string): string {
    // Copilot uses ~/.copilot/hooks/<name>.json — flat format with `bash` key
    const copilotDir = join(homedir(), ".copilot", "hooks");
    if (!existsSync(copilotDir)) mkdirSync(copilotDir, { recursive: true });

    const hooksPath = join(copilotDir, "linkshell.json");
    const mkHook = (eventName: string) => ({
      type: "command",
      bash: `${curlCmd.replace('"$(cat)"', `'{"hook_event_name":"${eventName}"}'`)}`,
      timeoutSec: 5,
    });
    const config = {
      version: 1,
      hooks: {
        sessionStart: [mkHook("sessionStart")],
        preToolUse: [mkHook("preToolUse")],
        postToolUse: [mkHook("postToolUse")],
        sessionEnd: [mkHook("sessionEnd")],
      },
    };

    writeFileSync(hooksPath, JSON.stringify(config, null, 2));
    this.log(`copilot hook config written to ${hooksPath}`);
    return hooksPath;
  }

  private handleHookEvent(terminalId: string, event: Record<string, unknown>, provider: string): void {
    const rawHookName = (event.hook_event_name ?? event.event_name) as string | undefined;
    if (!rawHookName) return;

    // Normalize hook event names from different providers to unified names
    const hookName = this.normalizeHookName(rawHookName, provider);
    if (!hookName) return;

    let phase: string;
    let toolName: string | undefined;
    let toolInput: string | undefined;
    let permissionRequest: string | undefined;
    let summary: string | undefined;

    switch (hookName) {
      case "PreToolUse":
        phase = "tool_use";
        toolName = (event.tool_name ?? event.toolName) as string | undefined;
        if (event.tool_input && typeof event.tool_input === "object") {
          const input = event.tool_input as Record<string, unknown>;
          toolInput = JSON.stringify(input).slice(0, 200);
        } else if (event.toolInput && typeof event.toolInput === "object") {
          toolInput = JSON.stringify(event.toolInput).slice(0, 200);
        }
        break;
      case "PostToolUse":
        phase = "thinking";
        toolName = (event.tool_name ?? event.toolName) as string | undefined;
        // Pop permission stack: tool completed
        {
          const stack = this.permissionStacks.get(terminalId);
          if (stack && stack.length > 0) {
            stack.pop();
            if (stack.length === 0) this.permissionStacks.delete(terminalId);
          }
        }
        break;
      case "PostToolUseFailure":
        phase = "error";
        toolName = (event.tool_name ?? event.toolName) as string | undefined;
        {
          const stack = this.permissionStacks.get(terminalId);
          if (stack && stack.length > 0) {
            stack.pop();
            if (stack.length === 0) this.permissionStacks.delete(terminalId);
          }
        }
        break;
      case "Stop":
        phase = "idle";
        if (event.stop_reason) summary = String(event.stop_reason);
        this.permissionStacks.delete(terminalId);
        break;
      case "PermissionRequest":
        phase = "waiting";
        toolName = (event.tool_name ?? event.toolName) as string | undefined;
        if (event.tool_input && typeof event.tool_input === "object") {
          const input = event.tool_input as Record<string, unknown>;
          permissionRequest = JSON.stringify(input).slice(0, 300);
        } else if (event.toolInput && typeof event.toolInput === "object") {
          permissionRequest = JSON.stringify(event.toolInput).slice(0, 300);
        }
        // Push to permission stack
        {
          const requestId = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          if (!this.permissionStacks.has(terminalId)) {
            this.permissionStacks.set(terminalId, []);
          }
          this.permissionStacks.get(terminalId)!.push({
            requestId,
            toolName: toolName ?? "unknown",
            toolInput: toolInput ?? (permissionRequest ?? ""),
            permissionRequest: permissionRequest ?? "",
            timestamp: Date.now(),
          });
        }
        break;
      case "SessionStart":
        phase = "idle";
        summary = "session started";
        break;
      case "UserPromptSubmit":
        phase = "thinking";
        this.permissionStacks.delete(terminalId);
        break;
      default:
        return;
    }

    this.log(`hook event [${provider}]: ${rawHookName} → ${hookName} → phase=${phase} tool=${toolName ?? "none"}`);

    // Build topPermission from stack
    const stack = this.permissionStacks.get(terminalId);
    const topPermission = stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
    const pendingPermissionCount = stack?.length ?? 0;

    // Increment statusSeq for ordering
    const term = this.terminals.get(terminalId);
    const seq = term ? term.statusSeq++ : 0;

    this.send(createEnvelope({
      type: "terminal.status",
      sessionId: this.sessionId,
      terminalId,
      payload: {
        phase,
        seq,
        ...(toolName && { toolName }),
        ...(toolInput && { toolInput }),
        ...(permissionRequest && { permissionRequest }),
        ...(summary && { summary }),
        ...(topPermission && { topPermission }),
        ...(pendingPermissionCount > 0 && { pendingPermissionCount }),
      },
    }));
  }

  /**
   * Normalize hook event names from different CLI providers to unified internal names.
   * Claude: PascalCase (PreToolUse, PostToolUse, Stop, PermissionRequest)
   * Codex: camelCase (preToolUse, postToolUse, sessionStart)
   * Gemini: PascalCase but different names (BeforeTool, AfterTool, BeforeSubmitPrompt)
   */
  private normalizeHookName(rawName: string, provider: string): string | undefined {
    // Claude events — already in our canonical format
    if (provider === "claude") {
      return rawName;
    }

    // Codex events (PascalCase in nested format)
    if (provider === "codex") {
      switch (rawName) {
        case "PreToolUse": case "preToolUse": return "PreToolUse";
        case "PostToolUse": case "postToolUse": return "PostToolUse";
        case "SessionStart": case "sessionStart": return "SessionStart";
        default: return undefined;
      }
    }

    // Gemini events
    if (provider === "gemini") {
      switch (rawName) {
        case "BeforeTool": return "PreToolUse";
        case "AfterTool": return "PostToolUse";
        case "BeforeSubmitPrompt": return "SessionStart";
        case "AfterSubmitPrompt": return "Stop";
        case "SessionStart": return "SessionStart";
        case "SessionEnd": return "Stop";
        default: return undefined;
      }
    }

    // Copilot events (camelCase)
    if (provider === "copilot") {
      switch (rawName) {
        case "preToolUse": return "PreToolUse";
        case "postToolUse": return "PostToolUse";
        case "sessionStart": return "SessionStart";
        case "sessionEnd": return "Stop";
        default: return undefined;
      }
    }

    // Unknown provider — try all known formats
    // This handles "custom" shell where any provider might be launched
    const allProviders = ["claude", "codex", "gemini", "copilot"];
    for (const p of allProviders) {
      const result = this.normalizeHookName(rawName, p);
      if (result) return result;
    }
    return undefined;
  }

  private cleanupHookServer(term: TerminalInstance): void {
    if (term.hookServer) {
      term.hookServer.close();
      term.hookServer = undefined;
      this.log(`hook server closed for ${term.id}`);
    }
    if (term.hookConfigPath) {
      const configPath = term.hookConfigPath;
      try {
        if (term.provider === "claude") {
          // configPath is the backup file — restore settings.local.json from it
          const settingsPath = join(homedir(), ".claude", "settings.local.json");
          if (existsSync(configPath)) {
            const backup = readFileSync(configPath, "utf8");
            writeFileSync(settingsPath, backup);
            unlinkSync(configPath);
            this.log(`restored claude settings.local.json from backup`);
          }
        } else {
          // Codex/Gemini/Copilot use home dir configs — restore backup if exists
          const backupPath = `${configPath}.linkshell-backup`;
          if (existsSync(backupPath)) {
            const backup = readFileSync(backupPath, "utf8");
            writeFileSync(configPath, backup);
            unlinkSync(backupPath);
            this.log(`restored backup for ${configPath}`);
          } else if (configPath.startsWith(tmpdir())) {
            unlinkSync(configPath);
          }
        }
      } catch { /* ignore */ }
      term.hookConfigPath = undefined;
    }
  }

  private send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(serializeEnvelope(message));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(
        createEnvelope({
          type: "session.heartbeat",
          sessionId: this.sessionId,
          payload: { ts: Date.now() },
        }),
      );
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private startScreenCapture(fps: number, quality: number, scale: number): void {
    if (!this.options.screen) {
      this.log("screen sharing not enabled (use --screen)");
      this.send(
        createEnvelope({
          type: "screen.status",
          sessionId: this.sessionId,
          payload: { active: false, mode: "off" as const, error: "Screen sharing not enabled on host. Start CLI with --screen flag." },
        }),
      );
      return;
    }
    this.stopScreenCapture();
    this.log(`starting screen capture (fps=${fps}, quality=${quality}, scale=${scale})`);

    // Try WebRTC first, fall back to screenshot stream
    if (ScreenShare.isAvailable()) {
      this.log("WebRTC available, starting screen share");
      this.screenShare = new ScreenShare({
        sessionId: this.sessionId,
        fps,
        quality,
        scale,
        onSignal: (envelope) => this.send(envelope),
        onStatus: (envelope) => this.send(envelope),
      });
      this.screenShare.start().catch((err) => {
        this.log(`WebRTC failed, falling back to screenshot stream: ${err}`);
        this.screenShare = undefined;
        this.startFallbackCapture(fps, quality, scale);
      });
    } else {
      this.log("WebRTC not available (missing werift or ffmpeg), using screenshot fallback");
      this.startFallbackCapture(fps, quality, scale);
    }
  }

  private startFallbackCapture(fps: number, quality: number, scale: number): void {
    this.screenCapture = new ScreenFallback({
      fps,
      quality,
      scale,
      sessionId: this.sessionId,
      onFrame: (envelope) => this.send(envelope),
      onStatus: (envelope) => this.send(envelope),
    });
    this.screenCapture.start();
  }

  private stopScreenCapture(): void {
    if (this.screenShare) {
      this.log("stopping WebRTC screen share");
      this.screenShare.stop();
      this.screenShare = undefined;
    }
    if (this.screenCapture) {
      this.log("stopping screenshot capture");
      this.screenCapture.stop();
      this.screenCapture = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      process.stderr.write(
        "[bridge] max reconnect attempts reached, stopping bridge session\n",
      );
      this.stop(1);
      return;
    }
    this.reconnecting = true;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempts++;
    process.stderr.write(
      `[bridge] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})\n`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped || this.exited) {
        return;
      }
      this.reconnecting = false;
      this.connectGateway();
    }, delay);
  }

  stop(exitCode = 0): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.exited = true;
    this.stopHeartbeat();
    this.stopScreenCapture();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    for (const term of this.terminals.values()) {
      this.cleanupHookServer(term);
      if (term.status === "running") term.pty.kill();
    }
    this.terminals.clear();
    process.exitCode = exitCode;
  }
}
