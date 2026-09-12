import * as pty from "node-pty";
import * as http from "node:http";
import WebSocket from "ws";
import { hostname, platform, homedir } from "node:os";
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve, relative, isAbsolute } from "node:path";
import {
  agentV2MessageRoute,
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
import { getValidToken, refreshAccessToken } from "../auth.js";
import { AgentSessionProxy } from "./acp/agent-session.js";
import { AgentWorkspaceProxy, makeAgentV2RemoteConversationId } from "./acp/agent-workspace.js";
import { detectAvailableProviders, type AgentProvider } from "./acp/provider-resolver.js";
import { sweepLinkShellHookConfigs } from "./hook-command.js";

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
  authToken?: string;
  keepAwake?: boolean;
  agentUi?: boolean;
  agentProvider?: AgentProvider;
  agentCommand?: string;
  /**
   * Confinement root for client-driven filesystem operations
   * (terminal.browse / terminal.file.read / terminal.mkdir).
   * Defaults to the user's home directory. Paths resolving outside this root are rejected.
   */
  fileRoot?: string;
  /**
   * Ports the tunnel proxy is allowed to connect to on 127.0.0.1.
   * Defaults to DEFAULT_TUNNEL_PORTS when omitted.
   */
  allowedTunnelPorts?: number[];
}

const HEARTBEAT_INTERVAL = 15_000;
// Transport-layer WS keepalive: ping the gateway periodically; if a pong
// doesn't arrive before the next ping, the socket is half-open (network
// silently dropped, no FIN) — terminate it so the reconnect loop kicks in.
const WS_PING_INTERVAL = 20_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
// Cap the exponent so the backoff levels off at RECONNECT_MAX_DELAY instead of
// overflowing. There is NO attempt ceiling — a connected host never gives up
// (only `stop()`/all-PTYs-exited ends it), so it survives gateway restarts and
// arbitrarily long network outages, reconnecting whenever connectivity returns.
const RECONNECT_MAX_EXPONENT = 5;
const DEFAULT_TERMINAL_ID = "default";
const SCROLLBACK_LINES = 500;
// Upper bound on concurrent live terminals — forceNew removed the cwd-dedup
// ceiling, so bound growth to avoid PTY/fd exhaustion from a runaway client.
const MAX_TERMINALS = 12;
// How long to keep an exited terminal (with its scrollback) in memory so the
// client can replay its final output before it is reaped.
const EXITED_TERMINAL_GRACE_MS = 30_000;
// Default ports the bridge will proxy tunnel requests to when no explicit
// allowlist is configured. Covers the common dev servers the app tunnels to.
const DEFAULT_TUNNEL_PORTS = [3000, 3001, 4321, 5173, 5174, 8080, 8000, 8081];
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
}

function stripGatewayBase(url: URL): string {
  url.hash = "";
  url.search = "";
  url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

function isHttpGatewayUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function getPairingGatewayParam(gatewayHttpUrl: string): string | undefined {
  try {
    const url = new URL(gatewayHttpUrl);
    if (!isHttpGatewayUrl(url)) {
      return undefined;
    }
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
      return stripGatewayBase(url);
    }
    return stripGatewayBase(url);
  } catch {
    return gatewayHttpUrl.replace(/\/+$/, "") || undefined;
  }
}

export function resolvePairingGateway(
  gatewayHttpUrl: string,
  pairingGateway?: string,
): string | undefined {
  const override = pairingGateway?.trim();
  if (!override) {
    return getPairingGatewayParam(gatewayHttpUrl);
  }

  try {
    const absoluteUrl = new URL(override);
    if (isHttpGatewayUrl(absoluteUrl)) {
      return stripGatewayBase(absoluteUrl);
    }
  } catch {
    // Fall through and treat the override as a host[:port] value.
  }

  try {
    const baseUrl = new URL(gatewayHttpUrl);
    if (!isHttpGatewayUrl(baseUrl)) {
      return override.replace(/\/+$/, "") || undefined;
    }
    const normalizedHost = override
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim();

    if (!normalizedHost) {
      return getPairingGatewayParam(gatewayHttpUrl);
    }

    baseUrl.host = normalizedHost;
    return stripGatewayBase(baseUrl);
  } catch {
    try {
      const prefixed = new URL(`http://${override.replace(/^\/+/, "")}`);
      return stripGatewayBase(prefixed);
    } catch {
      return undefined;
    }
  }
}

function normalizeAgentProvider(provider: unknown): AgentProvider {
  if (typeof provider === "string" && provider.trim()) return provider.trim();
  return "codex";
}

export function resolveAgentWorkspaceProviders(options: {
  agentProvider?: AgentProvider;
  agentCommand?: string;
}): AgentProvider[] {
  if (options.agentCommand?.trim()) {
    return [normalizeAgentProvider(options.agentProvider ?? "custom")];
  }
  const defaultProviders: AgentProvider[] = ["codex", "claude"];
  const detected = detectAvailableProviders();
  const requested = options.agentProvider ? normalizeAgentProvider(options.agentProvider) : undefined;
  const ordered = [
    ...(requested ? [requested] : []),
    ...detected,
    ...defaultProviders,
  ];
  const unique: AgentProvider[] = [];
  for (const provider of ordered) {
    if (!unique.includes(provider)) unique.push(provider);
  }
  return unique;
}

export class BridgeSession {
  private readonly options: BridgeSessionOptions;
  private socket: WebSocket | undefined;
  private terminals = new Map<string, TerminalInstance>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private wsPingTimer: ReturnType<typeof setInterval> | undefined;
  // True between sending a WS ping and receiving its pong. If still true at the
  // next ping tick, the socket is half-open and gets terminated.
  private awaitingPong = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private sessionId = "";
  private hostToken: string | undefined;
  private exited = false;
  private stopped = false;
  private screenCapture: ScreenFallback | undefined;
  private screenShare: ScreenShare | undefined;
  private tunnelSockets = new Map<string, WebSocket>();
  private keepAwake: KeepAwakeHandle | undefined;
  private agentSession: AgentSessionProxy | undefined;
  private agentWorkspace: AgentWorkspaceProxy | undefined;
  private outboundAgentQueue: Envelope[] = [];
  private machineIdentity: MachineIdentity | undefined;
  // Default host workspace shown to clients and used by the initial PTY.
  private readonly defaultCwd: string;
  // Confinement root for client-driven filesystem ops; resolved once at construction.
  private readonly fileRoot: string;
  // Ports the tunnel proxy may connect to on 127.0.0.1.
  private readonly allowedTunnelPorts: Set<number>;
  // Pending deletions of exited terminals (terminalId → timer) so we can clear on stop().
  private exitedTerminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Invoked when all terminals have exited naturally — closes embedded gateway,
  // removes daemon PID file, etc. Set by the CLI entry point.
  private onAllTerminalsExited: (() => void | Promise<void>) | undefined;

  constructor(options: BridgeSessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? "";
    this.defaultCwd = resolve(homedir());
    // Confine client-driven file ops to the user's home by default (single-user
    // self-hosted model: the owner browses their own projects under ~). This
    // still blocks /etc, /usr, other users' dirs. Override via --file-root.
    this.fileRoot = resolve(options.fileRoot ?? homedir());
    this.allowedTunnelPorts = new Set(
      options.allowedTunnelPorts && options.allowedTunnelPorts.length > 0
        ? options.allowedTunnelPorts
        : DEFAULT_TUNNEL_PORTS,
    );
  }

  /** Register a callback invoked once all terminals exit naturally (process self-cleanup). */
  setOnAllTerminalsExited(handler: () => void | Promise<void>): void {
    this.onAllTerminalsExited = handler;
  }

  /**
   * Resolve a client-supplied path inside the confinement root.
   * Returns the absolute resolved path, or null if it escapes the root.
   */
  private resolveConfinedPath(clientPath: string): string | null {
    const expanded = clientPath.startsWith("~")
      ? clientPath.replace(/^~/, homedir())
      : clientPath;
    // Resolve relative paths against the confinement root, not process.cwd().
    const target = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.fileRoot, expanded);
    const rel = relative(this.fileRoot, target);
    if (rel === "") return target; // the root itself
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return target;
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
    this.machineIdentity = loadOrCreateMachineIdentity();
    // One-shot leftover sweep. Structured agent control is ACP/SDK subprocesses;
    // we never rewrite hook configs.
    sweepLinkShellHookConfigs(homedir(), [join(this.defaultCwd, "hooks.json")]);
    if (!this.sessionId) {
      await this.createPairing();
    }
    if (this.options.keepAwake) {
      this.keepAwake = startKeepAwake();
    } else {
      process.stderr.write("[bridge] keep-awake disabled\n");
    }
    if (this.options.agentUi) {
      const availableProviders = resolveAgentWorkspaceProviders(this.options);
      const agentOptions = {
        sessionId: this.sessionId,
        cwd: this.defaultCwd,
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
    await this.spawnTerminal(DEFAULT_TERMINAL_ID, this.defaultCwd);
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
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Failed to create pairing: ${res.status}`);
    }
    const body = (await res.json()) as {
      sessionId: string;
      pairingCode: string;
      hostToken?: string;
      expiresAt: string;
    };
    this.sessionId = body.sessionId;
    // Secret token proving we are the legitimate host for this session; sent on
    // every host WS connect so a third party who learns the sessionId can't
    // hijack the host role.
    this.hostToken = body.hostToken;

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

  private async resolveAuthToken(): Promise<string | undefined> {
    if (!this.options.authToken) return undefined;
    try {
      const token = await getValidToken();
      if (token) {
        this.options.authToken = token;
        return token;
      }
      // Refresh failed (e.g. offline / transient Supabase error). Do NOT clear
      // the token — keep using the last one we had. It may be expired and the
      // gateway may reject it, but the close handler force-refreshes on the next
      // attempt, and clearing it would permanently downgrade us to no-auth and
      // lock a pro host out of its own sessions once connectivity returns.
      process.stderr.write(
        "[bridge] token refresh failed; reusing last token (will retry refresh on reconnect)\n",
      );
      return this.options.authToken;
    } catch (error) {
      this.log(`failed to refresh login token: ${error instanceof Error ? error.message : String(error)}`);
      return this.options.authToken;
    }
  }

  // After an auth-class WS close, force a token refresh before reconnecting so
  // we don't spin on 401/4001/4003. A gateway restart surfaces as 1006 right
  // after a fresh connect, so we refresh on that too (cheap, debounced by the
  // reconnect backoff). No-op for clean/normal closes.
  private async maybeRefreshTokenForClose(code: number): Promise<void> {
    if (!this.options.authToken) return;
    const authClass = code === 4001 || code === 4003 || code === 1006 || code === 401;
    if (!authClass) return;
    try {
      const refreshed = await refreshAccessToken();
      if (refreshed?.accessToken) {
        this.options.authToken = refreshed.accessToken;
        this.log("refreshed auth token after auth-class close");
      }
    } catch {
      // Offline — keep the old token; the reconnect loop will retry later.
    }
  }

  private async connectGateway(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const url = new URL(this.options.gatewayUrl);
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("role", "host");
    const authToken = await this.resolveAuthToken();
    const wsOptions: WebSocket.ClientOptions = {};
    const headers: Record<string, string> = {};
    if (authToken) {
      // Prefer the Authorization header so the token doesn't leak into URLs/logs.
      headers["Authorization"] = `Bearer ${authToken}`;
      // TODO: remove the query param once all gateways read the Authorization
      // header. Kept for backward compatibility with older gateways that only
      // read the `auth_token` query parameter.
      url.searchParams.set("auth_token", authToken);
    }
    if (this.hostToken) {
      headers["x-linkshell-host-token"] = this.hostToken;
    }
    if (Object.keys(headers).length > 0) {
      wsOptions.headers = headers;
    }

    this.socket = new WebSocket(url, wsOptions);

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
            machineId: this.machineIdentity?.machineId,
            hostname: this.options.hostname || hostname(),
            platform: platform(),
            cwd: this.defaultCwd,
            projectName: basename(this.defaultCwd),
          },
        }),
      );
      if (this.outboundAgentQueue.length > 0) {
        const queued = this.outboundAgentQueue.splice(0);
        for (const envelope of queued) this.send(envelope);
      }
      this.startHeartbeat();
      this.startWsPing();
    });

    // Gateway answered our WS ping — connection is alive.
    this.socket.on("pong", () => {
      this.awaitingPong = false;
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
      this.stopWsPing();
      this.socket = undefined;
      const reason = reasonBuffer.toString();
      // Quiet during an ongoing outage: log the first close (we were connected,
      // attempts==0) and every 10th, so multi-hour outages don't flood the log.
      if (this.reconnectAttempts === 0 || this.reconnectAttempts % 10 === 0) {
        process.stderr.write(
          `[bridge] gateway connection closed (code=${code}${reason ? `, reason=${reason}` : ""})\n`,
        );
      }
      if (!this.exited) {
        // Auth-class closes (token expired / gateway restarted) get a forced
        // token refresh before the next attempt, so we don't loop on 401/4xxx.
        this.maybeRefreshTokenForClose(code).finally(() => {
          this.scheduleReconnect();
        });
      }
    });

    this.socket.on("error", (error) => {
      // During an outage every retry emits a connection error; the `close`
      // handler already logs (quietly) and drives reconnect. Only surface the
      // first error of an outage to avoid flooding the daemon log.
      if (this.reconnectAttempts <= 1) {
        process.stderr.write(`[bridge] gateway error: ${error.message || "connection failed"}\n`);
      }
    });
  }

  private async handleMessage(envelope: Envelope): Promise<void> {
    const tid = envelope.terminalId ?? DEFAULT_TERMINAL_ID;
    const agentV2Route = agentV2MessageRoute(envelope.type);
    if (agentV2Route === "client_write" || agentV2Route === "client_read") {
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
        return;
      }
      try {
        await this.agentWorkspace.handleEnvelope(envelope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`agent.v2 invalid message: ${message}`);
        this.send(createEnvelope({
          type: "session.error",
          sessionId: this.sessionId,
          payload: {
            code: "invalid_message",
            message: `Invalid Agent Workspace message: ${message}`,
          },
        }));
      }
      return;
    }
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
        // Cap concurrent terminals — forceNew removed the cwd-dedup ceiling, so
        // bound growth explicitly to avoid PTY/fd exhaustion from a runaway client.
        const liveCount = [...this.terminals.values()].filter((t) => t.status === "running").length;
        if (liveCount >= MAX_TERMINALS) {
          this.send(createEnvelope({
            type: "session.error",
            sessionId: this.sessionId,
            payload: { code: "too_many_terminals", message: `最多同时打开 ${MAX_TERMINALS} 个终端` },
          }));
          break;
        }
        // Dedup by cwd UNLESS the client explicitly asks for a fresh terminal
        // (forceNew lets web open multiple tabs in the same directory).
        const existing = p.forceNew
          ? undefined
          : [...this.terminals.values()].find(
              (t) => t.status === "running" && resolve(t.cwd) === normalizedCwd,
            );
        if (existing) {
          this.send(createEnvelope({
            type: "terminal.spawned",
            sessionId: this.sessionId,
            terminalId: existing.id,
            payload: { terminalId: existing.id, cwd: existing.cwd, projectName: existing.projectName, provider: existing.provider },
          }));
        } else {
          const newId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          try {
            await this.spawnTerminal(newId, normalizedCwd, p.provider);
            this.send(createEnvelope({
              type: "terminal.spawned",
              sessionId: this.sessionId,
              terminalId: newId,
              payload: { terminalId: newId, cwd: normalizedCwd, projectName: basename(normalizedCwd), provider: p.provider },
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
        const browsePath = this.resolveConfinedPath(p.path);
        if (browsePath === null) {
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: p.path, entries: [], error: "Path is outside the allowed root", requestId: p.requestId },
          }));
          break;
        }
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
        const filePath = this.resolveConfinedPath(p.path);
        if (filePath === null) {
          this.send(createEnvelope({
            type: "terminal.file.read.result",
            sessionId: this.sessionId,
            payload: {
              path: p.path,
              content: "",
              encoding: "utf8",
              truncated: false,
              error: "Path is outside the allowed root",
              requestId: p.requestId,
            },
          }));
          break;
        }
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
        const dirPath = this.resolveConfinedPath(p.path);
        if (dirPath === null) {
          this.send(createEnvelope({
            type: "terminal.browse.result",
            sessionId: this.sessionId,
            payload: { path: p.path, entries: [], error: "Path is outside the allowed root" },
          }));
          break;
        }
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
        const p = parseTypedPayload("agent.permission.response", envelope.payload);
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
      case "permission.decision": {
        const p = envelope.payload as { requestId: string; decision: "allow" | "deny" };
        process.stderr.write(
          `[bridge] permission.decision ignored (ACP/SDK owns authorization) request=${p.requestId} decision=${p.decision}\n`,
        );
        this.send(createEnvelope({
          type: "permission.decision.result",
          sessionId: this.sessionId,
          terminalId: tid,
          payload: {
            requestId: p.requestId,
            decision: p.decision,
            resolved: false,
            delivered: false,
            source: "permission.decision",
            message: "Authorization is handled by the ACP/SDK agent subprocess",
          },
        }));
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

    // SSRF guard: only proxy to ports in the allowlist (pinned to 127.0.0.1).
    if (!this.allowedTunnelPorts.has(port)) {
      this.log(`rejecting tunnel request to disallowed port ${port}`);
      if (headers.upgrade === "websocket") {
        this.send(createEnvelope({
          type: "tunnel.ws.close",
          sessionId: this.sessionId,
          payload: { requestId, code: 1008, reason: `Port ${port} is not allowed` },
        }));
      } else {
        this.sendTunnelError(requestId, 403, `Port ${port} is not allowed`);
      }
      return;
    }

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
      scrollback: new ScrollbackBuffer(SCROLLBACK_LINES),
      outputSeq: 0,
      statusSeq: 0,
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

      // Reap the exited terminal (and its scrollback) after a grace period so
      // clients can replay final output, then free the memory. Tracked so the
      // timer can be cleared on stop().
      const reapTimer = setTimeout(() => {
        this.exitedTerminalTimers.delete(terminalId);
        const t = this.terminals.get(terminalId);
        if (t && t.status === "exited") {
          this.terminals.delete(terminalId);
          this.log(`reaped exited terminal ${terminalId}`);
        }
      }, EXITED_TERMINAL_GRACE_MS);
      if (typeof reapTimer.unref === "function") reapTimer.unref();
      this.exitedTerminalTimers.set(terminalId, reapTimer);

      // If all terminals exited, close the session
      const allExited = [...this.terminals.values()].every((t) => t.status === "exited");
      if (allExited) {
        this.exited = true;
        setTimeout(() => {
          this.stopHeartbeat();
          this.socket?.close();
          // Self-clean process-level resources (embedded gateway + PID file)
          // since the PTYs exited naturally rather than via a signal handler.
          void this.onAllTerminalsExited?.();
        }, 500);
        process.exitCode = exitCode ?? 0;
      }
    });

    this.terminals.set(terminalId, term);
    this.log(`spawned terminal ${terminalId} in ${cwd}`);
  }


  private send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (message.type.startsWith("agent.v2.")) {
        this.outboundAgentQueue.push(message);
        if (this.outboundAgentQueue.length > 40) {
          this.outboundAgentQueue.splice(0, this.outboundAgentQueue.length - 40);
        }
      }
      return;
    }
    const machineId = this.machineIdentity?.machineId;
    const enriched = machineId && (
      message.type === "terminal.status" ||
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

  // Transport-layer keepalive. WS ping/pong detects a half-open socket (network
  // dropped without a TCP FIN, e.g. laptop sleep / Wi-Fi loss) that would
  // otherwise hang silently. If the previous ping's pong never arrived, the
  // socket is dead → terminate it, which fires `close` → scheduleReconnect.
  private startWsPing(): void {
    this.stopWsPing();
    this.awaitingPong = false;
    this.wsPingTimer = setInterval(() => {
      const sock = this.socket;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // No pong since the last ping → half-open. Forcibly close so we reconnect.
        process.stderr.write("[bridge] no pong from gateway; terminating dead connection\n");
        this.awaitingPong = false;
        try {
          sock.terminate();
        } catch {
          // terminate may throw if already closing; close handler still runs.
        }
        return;
      }
      this.awaitingPong = true;
      try {
        sock.ping();
      } catch {
        // ping failed → let the next tick terminate, or close already fired.
      }
    }, WS_PING_INTERVAL);
    if (typeof this.wsPingTimer.unref === "function") this.wsPingTimer.unref();
  }

  private stopWsPing(): void {
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = undefined;
    }
    this.awaitingPong = false;
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
    if (this.reconnecting || this.stopped || this.exited) return;

    this.reconnecting = true;
    // Exponential backoff capped at RECONNECT_MAX_DELAY, with full jitter so a
    // fleet of hosts doesn't stampede a restarting gateway. The attempt counter
    // only ever grows toward the cap — it is NEVER reset to "give up"; the host
    // keeps trying forever until stop()/exit.
    const exponent = Math.min(this.reconnectAttempts, RECONNECT_MAX_EXPONENT);
    const base = Math.min(RECONNECT_BASE_DELAY * 2 ** exponent, RECONNECT_MAX_DELAY);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts++;
    // Quiet logging: only the first retry of an outage and every 10th attempt,
    // so a multi-hour offline window doesn't flood the daemon log.
    if (this.reconnectAttempts === 1 || this.reconnectAttempts % 10 === 0) {
      process.stderr.write(
        `[bridge] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})\n`,
      );
    }
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
    this.stopWsPing();
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
    // Clear pending exited-terminal reap timers.
    for (const timer of this.exitedTerminalTimers.values()) {
      clearTimeout(timer);
    }
    this.exitedTerminalTimers.clear();
    for (const term of this.terminals.values()) {
      if (term.status === "running") term.pty.kill();
    }
    this.terminals.clear();
    process.exitCode = exitCode;
  }
}
