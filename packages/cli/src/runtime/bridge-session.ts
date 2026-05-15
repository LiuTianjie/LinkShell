import * as pty from "node-pty";
import * as http from "node:http";
import WebSocket from "ws";
import { hostname, platform, homedir } from "node:os";
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
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
import { startKeepAwake, type KeepAwakeHandle } from "../utils/keep-awake.js";
import { loadOrCreateMachineIdentity, type MachineIdentity } from "../machine-id.js";
import { getValidToken } from "../auth.js";
import { AgentSessionProxy } from "./acp/agent-session.js";
import { AgentWorkspaceProxy } from "./acp/agent-workspace.js";
import { detectAvailableProviders, type AgentProvider } from "./acp/provider-resolver.js";

export interface BridgeSessionOptions {
  gatewayUrl: string;
  gatewayHttpUrl: string;
  pairingGateway?: string;
  hostDeviceId?: string;
  cols: number;
  rows: number;
  clientName: string;
  hostname?: string;
  verbose?: boolean;
  screen?: boolean;
  providerConfig: ProviderConfig;
  authToken?: string;
  keepAwake?: boolean;
  agentUi?: boolean;
  agentProvider?: AgentProvider;
  agentCommand?: string;
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
  scrollback: ScrollbackBuffer;
  outputSeq: number;
  status: "running" | "exited";
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

function normalizeAgentProvider(provider: unknown): AgentProvider {
  if (provider === "claude" || provider === "custom") {
    return provider;
  }
  return "codex";
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
  private screenCapture: ScreenFallback | undefined;
  private screenShare: ScreenShare | undefined;
  private tunnelSockets = new Map<string, WebSocket>();
  private keepAwake: KeepAwakeHandle | undefined;
  private agentSession: AgentSessionProxy | undefined;
  private agentWorkspace: AgentWorkspaceProxy | undefined;
  private machineIdentity: MachineIdentity | undefined;

  constructor(options: BridgeSessionOptions) {
    this.options = options;
    this.sessionId = options.hostDeviceId ?? "";
  }

  private log(msg: string): void {
    if (this.options.verbose) {
      process.stderr.write(`[bridge:verbose] ${msg}\n`);
    }
  }

  async start(): Promise<void> {
    this.log(
      `starting device bridge (gateway=${this.options.gatewayUrl}, terminal=shell)`,
    );
    this.machineIdentity = loadOrCreateMachineIdentity();
    this.sessionId ||= this.machineIdentity.machineId;
    await this.createPairing();
    if (this.options.keepAwake) {
      this.keepAwake = startKeepAwake();
    } else {
      process.stderr.write("[bridge] keep-awake disabled\n");
    }
    if (this.options.agentUi) {
      const availableProviders = this.options.agentProvider
        ? [normalizeAgentProvider(this.options.agentProvider)]
        : detectAvailableProviders();
      const agentOptions = {
        sessionId: this.sessionId,
        cwd: process.cwd(),
        availableProviders,
        command: this.options.agentCommand,
        verbose: this.options.verbose,
        send: (envelope: Envelope) => this.send(envelope),
      };
      this.agentSession = new AgentSessionProxy({
        ...agentOptions,
      });
      this.agentWorkspace = new AgentWorkspaceProxy({
        ...agentOptions,
      });
      process.stderr.write(`[bridge] agent workspace channel enabled (providers: ${availableProviders.join(", ") || "none"})\n`);
    }
    await this.spawnTerminal(DEFAULT_TERMINAL_ID, process.cwd());
    await this.connectGateway();
  }

  private async createPairing(): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authToken = await this.resolveAuthToken();
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const res = await fetch(`${this.options.gatewayHttpUrl}/pairings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hostDeviceId: this.sessionId }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create pairing: ${res.status}`);
    }
    const body = (await res.json()) as {
      hostDeviceId: string;
      pairingCode: string;
      expiresAt: string;
    };
    this.sessionId = body.hostDeviceId;

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
    process.stderr.write(`  Host device: ${body.hostDeviceId}\n`);
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

  private async resolveAuthToken(): Promise<string | undefined> {
    if (!this.options.authToken) return undefined;
    try {
      const token = await getValidToken();
      if (token) {
        this.options.authToken = token;
        return token;
      }
      process.stderr.write(
        "[bridge] login token expired and refresh failed; run `linkshell login` if the gateway rejects the connection\n",
      );
      this.options.authToken = undefined;
      return undefined;
    } catch (error) {
      this.log(`failed to refresh login token: ${error instanceof Error ? error.message : String(error)}`);
      return this.options.authToken;
    }
  }

  private async connectGateway(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const url = new URL(this.options.gatewayUrl);
    url.searchParams.set("hostDeviceId", this.sessionId);
    url.searchParams.set("role", "host");
    const authToken = await this.resolveAuthToken();
    if (authToken) {
      url.searchParams.set("auth_token", authToken);
    }

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
          type: "device.connect",
          hostDeviceId: this.sessionId,
          payload: {
            role: "host" as const,
            clientName: this.options.clientName,
            protocolVersion: PROTOCOL_VERSION,
            machineId: this.machineIdentity?.machineId,
            hostname: this.options.hostname || hostname(),
            platform: platform(),
            cwd: process.cwd(),
            capabilities: [
              "terminal",
              ...(this.options.agentUi ? ["agent-ui"] : []),
              ...(this.options.screen ? ["screen"] : []),
              "tunnel",
            ],
          },
        }),
      );
      this.startHeartbeat();
    });

    this.socket.on("message", (data) => {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(data.toString());
      } catch (err) {
        this.log(`invalid gateway message ignored: ${err}`);
        return;
      }
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
        const normalizedCwd = resolve(p.cwd ?? process.cwd());
        // Dedup: if a running terminal already exists for this cwd, return it
        const existing = [...this.terminals.values()].find(
          (t) => t.status === "running" && resolve(t.cwd) === normalizedCwd,
        );
        if (existing) {
          this.send(createEnvelope({
            type: "terminal.spawned",
            sessionId: this.sessionId,
            terminalId: existing.id,
            payload: { terminalId: existing.id, cwd: existing.cwd, shell: this.options.providerConfig.command },
          }));
        } else {
          const newId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          try {
            await this.spawnTerminal(newId, normalizedCwd);
            this.send(createEnvelope({
              type: "terminal.spawned",
              sessionId: this.sessionId,
              terminalId: newId,
              payload: { terminalId: newId, cwd: normalizedCwd, shell: this.options.providerConfig.command },
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
            .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || (p.includeFiles && d.isFile())))
            .map((d) => {
              const entryPath = join(browsePath, d.name);
              const stats = statSync(entryPath);
              return {
                name: d.name,
                path: entryPath,
                isDirectory: d.isDirectory(),
                size: stats.size,
                modifiedAt: stats.mtime.toISOString(),
              };
            })
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: browsePath, entries, requestId: p.requestId },
          }));
        } catch (err: unknown) {
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: browsePath, entries: [], error: (err as Error).message, requestId: p.requestId },
          }));
        }
        break;
      }
      case "terminal.file.read": {
        const p = parseTypedPayload("terminal.file.read", envelope.payload);
        const rawPath = p.path.startsWith("~") ? p.path.replace(/^~/, homedir()) : p.path;
        const filePath = resolve(rawPath);
        try {
          const stats = statSync(filePath);
          if (!stats.isFile()) {
            throw new Error("Path is not a file");
          }
          const maxBytes = p.maxBytes ?? 256_000;
          const bytesToRead = Math.min(stats.size, maxBytes);
          const buffer = Buffer.alloc(bytesToRead);
          const fd = openSync(filePath, "r");
          try {
            readSync(fd, buffer, 0, bytesToRead, 0);
          } finally {
            closeSync(fd);
          }
          if (buffer.includes(0)) {
            throw new Error("Binary files cannot be previewed");
          }
          this.send(createEnvelope({
            type: "terminal.file.read.result",
            sessionId: this.sessionId,
            payload: {
              path: filePath,
              content: buffer.toString("utf8"),
              encoding: "utf8",
              size: stats.size,
              truncated: stats.size > maxBytes,
              requestId: p.requestId,
            },
          }));
        } catch (err: unknown) {
          this.send(createEnvelope({
            type: "terminal.file.read.result",
            sessionId: this.sessionId,
            payload: {
              path: filePath,
              content: "",
              encoding: "utf8",
              truncated: false,
              error: (err as Error).message,
              requestId: p.requestId,
            },
          }));
        }
        break;
      }
      case "terminal.mkdir": {
        const p = parseTypedPayload("terminal.mkdir", envelope.payload);
        const rawPath = p.path.startsWith("~") ? p.path.replace(/^~/, homedir()) : p.path;
        const dirPath = resolve(rawPath);
        try {
          mkdirSync(dirPath, { recursive: true });
          // Browse the parent to refresh the listing
          const parentPath = join(dirPath, "..");
          const entries = readdirSync(parentPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) => ({
              name: d.name,
              path: join(parentPath, d.name),
              isDirectory: true,
            }));
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: parentPath, entries },
          }));
        } catch (err: unknown) {
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: dirPath, entries: [], error: (err as Error).message },
          }));
        }
        break;
      }
      case "terminal.list": {
        this.sendTerminalList();
        break;
      }
      case "terminal.history.request": {
        const p = parseTypedPayload("terminal.history.request", envelope.payload);
        const count = p.count ?? 100;
        let entries: string[] = [];
        let shell = "unknown";
        try {
          const home = homedir();
          // Try zsh first, then bash
          const histFiles = [
            { path: join(home, ".zsh_history"), shell: "zsh" },
            { path: join(home, ".bash_history"), shell: "bash" },
          ];
          for (const hf of histFiles) {
            if (existsSync(hf.path)) {
              const raw = readFileSync(hf.path, "utf8");
              const lines = raw.split("\n").filter(Boolean);
              // zsh history lines may start with ": <timestamp>:0;" — strip prefix
              const parsed = lines.map((l) => {
                const m = l.match(/^:\s*\d+:\d+;(.*)$/);
                return m ? m[1]! : l;
              });
              // Deduplicate and take last N
              const unique = [...new Set(parsed.reverse())].slice(0, count).reverse();
              entries = unique;
              shell = hf.shell;
              break;
            }
          }
        } catch {}
        this.send(createEnvelope({
          type: "terminal.history.response",
          sessionId: this.sessionId,
          payload: { entries, shell },
        }));
        break;
      }
      case "device.ack":
      case "session.ack": {
        const p = parseTypedPayload(envelope.type === "device.ack" ? "device.ack" : "session.ack", envelope.payload);
        const term = this.terminals.get(tid);
        if (term) {
          term.scrollback.trimUpTo(p.seq);
        }
        break;
      }
      case "device.resume":
      case "session.resume": {
        const p = parseTypedPayload(envelope.type === "device.resume" ? "device.resume" : "session.resume", envelope.payload);
        // Replay all terminals
        for (const [termId, term] of this.terminals) {
          this.replayFrom(
            termId,
            term,
            p.lastAckedSeqByTerminal[termId] ?? p.lastAckedSeq,
          );
        }
        // Also send terminal list so client knows what's available
        this.sendTerminalList();
        break;
      }
      case "device.heartbeat":
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
      case "agent.initialize":
      case "agent.session.new":
      case "agent.session.load":
      case "agent.session.list":
      case "agent.prompt":
      case "agent.cancel": {
        if (!this.agentSession) {
          this.send(
            createEnvelope({
              type: "agent.capabilities",
              sessionId: this.sessionId,
              payload: {
                enabled: false,
                provider: normalizeAgentProvider(
                  this.options.agentProvider ?? "codex",
                ),
                machineId: this.machineIdentity?.machineId,
                error: "Agent GUI is not enabled. Start CLI with --agent-ui.",
                supportsSessionList: false,
                supportsSessionLoad: false,
                supportsImages: false,
                supportsAudio: false,
                supportsPermission: false,
                supportsPlan: false,
                supportsCancel: false,
              },
            }),
          );
          break;
        }
        await this.agentSession.handleEnvelope(envelope);
        break;
      }
      case "agent.permission.response": {
        if (!this.agentSession) {
          this.send(
            createEnvelope({
              type: "agent.capabilities",
              sessionId: this.sessionId,
              payload: {
                enabled: false,
                provider: normalizeAgentProvider(
                  this.options.agentProvider ?? "codex",
                ),
                machineId: this.machineIdentity?.machineId,
                error: "Agent GUI is not enabled. Start CLI with --agent-ui.",
                supportsSessionList: false,
                supportsSessionLoad: false,
                supportsImages: false,
                supportsAudio: false,
                supportsPermission: false,
                supportsPlan: false,
                supportsCancel: false,
              },
            }),
          );
          break;
        }
        await this.agentSession.handleEnvelope(envelope);
        break;
      }
      case "agent.v2.capabilities.request":
      case "agent.v2.conversation.open":
      case "agent.v2.conversation.list":
      case "agent.v2.prompt":
      case "agent.v2.command.execute":
      case "agent.v2.cancel":
      case "agent.v2.permission.respond":
      case "agent.v2.structured_input.respond":
      case "agent.v2.snapshot.request": {
        if (!this.agentWorkspace) {
          this.send(
            createEnvelope({
              type: "agent.v2.capabilities",
              sessionId: this.sessionId,
              payload: {
                enabled: false,
                provider: normalizeAgentProvider(
                  this.options.agentProvider ?? "codex",
                ),
                machineId: this.machineIdentity?.machineId,
                workspaceProtocolVersion: 2,
                error: "Agent Workspace is not enabled. Start CLI with --agent-ui.",
                supportsSessionList: false,
                supportsSessionLoad: false,
                supportsImages: false,
                supportsAudio: false,
                supportsPermission: false,
                supportsPlan: false,
                supportsCancel: false,
              },
            }),
          );
          break;
        }
        await this.agentWorkspace.handleEnvelope(envelope);
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
      case "tunnel.request": {
        const p = parseTypedPayload("tunnel.request", envelope.payload);
        this.handleTunnelRequest(p);
        break;
      }
      case "tunnel.ws.data": {
        const p = parseTypedPayload("tunnel.ws.data", envelope.payload);
        this.handleTunnelWsData(p);
        break;
      }
      case "tunnel.ws.close": {
        const p = parseTypedPayload("tunnel.ws.close", envelope.payload);
        this.handleTunnelWsClose(p);
        break;
      }
      default:
        break;
    }
  }

  // ── Tunnel handlers ────────────────────────────────────────────────

  private handleTunnelRequest(payload: {
    requestId: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    port: number;
  }): void {
    const { requestId, method, url: reqUrl, headers, body, port } = payload;

    // WebSocket upgrade request
    if (headers.upgrade === "websocket") {
      this.handleTunnelWsUpgrade(requestId, port, reqUrl);
      return;
    }

    const parsedUrl = new URL(reqUrl, `http://127.0.0.1:${port}`);

    const reqOptions: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { ...headers, host: `127.0.0.1:${port}` },
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      // Collect response headers
      const resHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (typeof val === "string") resHeaders[key] = val;
        else if (Array.isArray(val)) resHeaders[key] = val.join(", ");
      }

      let firstChunk = true;
      proxyRes.on("data", (chunk: Buffer) => {
        this.send(
          createEnvelope({
            type: "tunnel.response",
            sessionId: this.sessionId,
            payload: {
              requestId,
              statusCode: proxyRes.statusCode ?? 200,
              headers: firstChunk ? resHeaders : {},
              body: chunk.toString("base64"),
              isFinal: false,
            },
          }),
        );
        firstChunk = false;
      });

      proxyRes.on("end", () => {
        this.send(
          createEnvelope({
            type: "tunnel.response",
            sessionId: this.sessionId,
            payload: {
              requestId,
              statusCode: proxyRes.statusCode ?? 200,
              headers: firstChunk ? resHeaders : {},
              body: "",
              isFinal: true,
            },
          }),
        );
      });

      proxyRes.on("error", () => {
        this.sendTunnelError(requestId, 502, "Upstream read error");
      });
    });

    proxyReq.on("error", () => {
      this.sendTunnelError(requestId, 502, "Connection refused");
    });

    proxyReq.setTimeout(30_000, () => {
      proxyReq.destroy();
      this.sendTunnelError(requestId, 504, "Upstream timeout");
    });

    if (body) {
      proxyReq.write(Buffer.from(body, "base64"));
    }
    proxyReq.end();
  }

  private handleTunnelWsUpgrade(requestId: string, port: number, url: string): void {
    const wsUrl = `ws://127.0.0.1:${port}${url}`;
    const localWs = new WebSocket(wsUrl);

    localWs.on("open", () => {
      this.tunnelSockets.set(requestId, localWs);
    });

    localWs.on("message", (data: Buffer | string) => {
      const isBinary = typeof data !== "string";
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      this.send(
        createEnvelope({
          type: "tunnel.ws.data",
          sessionId: this.sessionId,
          payload: {
            requestId,
            data: buf.toString("base64"),
            isBinary,
          },
        }),
      );
    });

    localWs.on("close", (code, reason) => {
      this.tunnelSockets.delete(requestId);
      const safeCode = typeof code === "number" && code >= 1000 && code <= 4999 ? code : 1000;
      this.send(
        createEnvelope({
          type: "tunnel.ws.close",
          sessionId: this.sessionId,
          payload: {
            requestId,
            code: safeCode,
            reason: reason?.toString() || "",
          },
        }),
      );
    });

    localWs.on("error", () => {
      this.tunnelSockets.delete(requestId);
      this.send(
        createEnvelope({
          type: "tunnel.ws.close",
          sessionId: this.sessionId,
          payload: {
            requestId,
            code: 1001,
            reason: "Local WebSocket error",
          },
        }),
      );
    });
  }

  private handleTunnelWsData(payload: {
    requestId: string;
    data: string;
    isBinary: boolean;
  }): void {
    const ws = this.tunnelSockets.get(payload.requestId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.from(payload.data, "base64");
    ws.send(payload.isBinary ? buf : buf.toString("utf8"));
  }

  private handleTunnelWsClose(payload: {
    requestId: string;
    code?: number;
    reason?: string;
  }): void {
    const ws = this.tunnelSockets.get(payload.requestId);
    if (!ws) return;
    const code = payload.code && payload.code >= 1000 && payload.code <= 4999 ? payload.code : 1000;
    ws.close(code, payload.reason ?? "");
    this.tunnelSockets.delete(payload.requestId);
  }

  private sendTunnelError(requestId: string, statusCode: number, message: string): void {
    this.send(
      createEnvelope({
        type: "tunnel.response",
        sessionId: this.sessionId,
        payload: {
          requestId,
          statusCode,
          headers: { "content-type": "text/plain" },
          body: Buffer.from(message).toString("base64"),
          isFinal: true,
        },
      }),
    );
  }

  private sendTerminalList(): void {
    const terminals = [...this.terminals.values()].map((t) => ({
      terminalId: t.id,
      cwd: t.cwd,
      status: t.status,
      shell: this.options.providerConfig.command,
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

  private async spawnTerminal(terminalId: string, cwd: string): Promise<void> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.providerConfig.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }

    const args = [...this.options.providerConfig.args];

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
      scrollback: new ScrollbackBuffer(1000),
      outputSeq: 0,
      status: "running",
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

  private send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const machineId = this.machineIdentity?.machineId;
    const enriched = machineId && (
      message.type === "agent.capabilities" ||
      message.type === "agent.snapshot" ||
      message.type === "agent.v2.capabilities" ||
      message.type === "agent.v2.snapshot"
    )
      ? {
          ...message,
          payload: {
            ...(message.payload as Record<string, unknown>),
            machineId,
          },
        }
      : message;
    this.socket.send(serializeEnvelope(enriched));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(
        createEnvelope({
          type: "device.heartbeat",
          hostDeviceId: this.sessionId,
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
    if (this.reconnecting) return;

    // In daemon mode, never give up — reset attempts after hitting max
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      process.stderr.write(
        "[bridge] max reconnect attempts reached, resetting counter and continuing...\n",
      );
      this.reconnectAttempts = 0;
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
      void this.connectGateway();
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
    this.agentSession?.stop();
    this.agentSession = undefined;
    this.agentWorkspace?.stop();
    this.agentWorkspace = undefined;
    this.keepAwake?.stop();
    this.keepAwake = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    // Clean up tunnel WebSockets
    for (const ws of this.tunnelSockets.values()) {
      ws.close(1001, "Session stopped");
    }
    this.tunnelSockets.clear();
    for (const term of this.terminals.values()) {
      if (term.status === "running") term.pty.kill();
    }
    this.terminals.clear();
    process.exitCode = exitCode;
  }
}
