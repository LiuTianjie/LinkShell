import * as pty from "node-pty";
import * as http from "node:http";
import WebSocket from "ws";
import { hostname, platform, homedir } from "node:os";
import { writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
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
import { AgentWorkspaceProxy } from "./acp/agent-workspace.js";
import { detectAvailableProviders, type AgentProvider } from "./acp/provider-resolver.js";

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
   * Defaults to the bridge's cwd. Paths resolving outside this root are rejected.
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
const HOOK_BODY_LIMIT = 256 * 1024;
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
const PERMISSION_REQUEST_TIMEOUT_MS = Number(
  process.env.LINKSHELL_PERMISSION_TIMEOUT_MS ?? 5 * 60_000,
);
const LINKSHELL_PERMISSION_GUARD_MARKER = "LINKSHELL_PERMISSION_GUARD";

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
  hookMarker: string;
  hookConfigPaths: string[];
}

interface PendingPermission {
  terminalId: string;
  timeout: ReturnType<typeof setTimeout>;
  permissionSuggestions: unknown[];
  resolve: (decision: HookPermissionDecision) => boolean;
}

interface HookPermissionDecision {
  behavior: "allow" | "deny";
  updatedPermissions?: unknown[];
  message?: string;
  interrupt?: boolean;
}

type HookPermissionChoice =
  | "allow"
  | "deny"
  | {
      outcome: "allow" | "deny" | "cancelled";
      optionId?: string;
    };

function isLinkShellHookEntry(entry: unknown, marker?: string): boolean {
  let raw = "";
  try {
    raw = JSON.stringify(entry);
  } catch {
    raw = String(entry);
  }
  return (
    (marker ? raw.includes(`/hook?m=${marker}`) : false) ||
    raw.includes("/hook?m=lsh-") ||
    (raw.includes("/hook?m=") && raw.includes("LINKSHELL_ID"))
  );
}

function withLinkShellHookEntry<T>(
  entries: unknown[] | undefined,
  entry: T,
  priority: "first" | "last",
): unknown[] {
  const cleaned = (Array.isArray(entries) ? entries : []).filter((item) => !isLinkShellHookEntry(item));
  return priority === "first" ? [entry, ...cleaned] : [...cleaned, entry];
}

function guardPermissionCommandForLinkShell(command: unknown): unknown {
  if (typeof command !== "string") return command;
  if (command.includes(LINKSHELL_PERMISSION_GUARD_MARKER)) return command;
  return [
    `case "\${LINKSHELL_ID:-}" in lsh-*) exit 0 ;; esac`,
    `# ${LINKSHELL_PERMISSION_GUARD_MARKER}`,
    command,
  ].join("\n");
}

function guardPermissionHookObjectForLinkShell(
  hook: Record<string, unknown>,
): Record<string, unknown> {
  if (isLinkShellHookEntry(hook)) return hook;
  const next: Record<string, unknown> = { ...hook };
  if (typeof next.command === "string") {
    next.command = guardPermissionCommandForLinkShell(next.command);
  }
  if (typeof next.bash === "string") {
    next.bash = guardPermissionCommandForLinkShell(next.bash);
  }
  return next;
}

function guardPermissionHookEntryForLinkShell(entry: unknown): unknown {
  if (isLinkShellHookEntry(entry)) return entry;
  if (typeof entry === "string") return guardPermissionCommandForLinkShell(entry);
  if (Array.isArray(entry)) return entry.map(guardPermissionHookEntryForLinkShell);
  if (!entry || typeof entry !== "object") return entry;

  const next = { ...(entry as Record<string, unknown>) };
  if (Array.isArray(next.hooks)) {
    next.hooks = next.hooks.map((hook) =>
      hook && typeof hook === "object" && !Array.isArray(hook)
        ? guardPermissionHookObjectForLinkShell(hook as Record<string, unknown>)
        : guardPermissionHookEntryForLinkShell(hook),
    );
  }
  if (typeof next.command === "string" || typeof next.bash === "string") {
    return guardPermissionHookObjectForLinkShell(next);
  }
  return next;
}

function withBlockingLinkShellPermissionEntry<T>(
  entries: unknown[] | undefined,
  entry: T,
): unknown[] {
  const cleaned = (Array.isArray(entries) ? entries : [])
    .filter((item) => !isLinkShellHookEntry(item))
    .map(guardPermissionHookEntryForLinkShell);
  return [entry, ...cleaned];
}

function stringifyHookInput(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 1200);
  if (typeof value === "object" && value) {
    try {
      return JSON.stringify(value, null, 2).slice(0, 1200);
    } catch {
      return String(value).slice(0, 1200);
    }
  }
  return "";
}

function hookPermissionSuggestions(event: Record<string, unknown>): unknown[] {
  if (isCodexPermissionRequest(event)) return [];
  const snake = event.permission_suggestions;
  const camel = event.permissionSuggestions;
  if (Array.isArray(snake)) return snake;
  if (Array.isArray(camel)) return camel;
  return [];
}

function isCodexPermissionRequest(event: Record<string, unknown>): boolean {
  if (typeof event.turn_id === "string" || typeof event.turnId === "string") return true;
  const transcriptPath = event.transcript_path ?? event.transcriptPath;
  return typeof transcriptPath === "string" && transcriptPath.includes("/.codex/");
}

function hookPermissionOptions(suggestions: unknown[]): Array<{
  id: string;
  label: string;
  kind: "allow" | "deny" | "other";
}> {
  return [
    { id: "deny", label: "拒绝", kind: "deny" },
    { id: "allow_once", label: "允许一次", kind: "allow" },
    ...(suggestions.length > 0
      ? [{ id: "allow_always" as const, label: "始终允许", kind: "allow" as const }]
      : []),
  ];
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
  if (provider === "claude" || provider === "custom") {
    return provider;
  }
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
  private permissionStacks = new Map<string, Array<{
    requestId: string;
    toolName: string;
    toolInput: string;
    permissionRequest: string;
    timestamp: number;
  }>>();
  // Pending permission responses: requestId → HTTP response callback
  private pendingPermissions = new Map<string, PendingPermission>();
  private hookMarker = `lsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  private screenCapture: ScreenFallback | undefined;
  private screenShare: ScreenShare | undefined;
  private tunnelSockets = new Map<string, WebSocket>();
  private keepAwake: KeepAwakeHandle | undefined;
  private agentSession: AgentSessionProxy | undefined;
  private agentWorkspace: AgentWorkspaceProxy | undefined;
  private machineIdentity: MachineIdentity | undefined;
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

  private terminalHookMarker(terminalId: string): string {
    const safeTerminalId = terminalId.replace(/[^a-zA-Z0-9_-]+/g, "-");
    return `${this.hookMarker}-${safeTerminalId}`;
  }

  async start(): Promise<void> {
    this.log(
      `starting session (gateway=${this.options.gatewayUrl}, provider=${this.options.providerConfig.provider})`,
    );
    this.machineIdentity = loadOrCreateMachineIdentity();
    // Sweep stale LinkShell hook entries (dead curl ports) left by a prior crash
    // before we write fresh ones for this session.
    this.sweepStaleHookConfigs();
    if (!this.sessionId) {
      await this.createPairing();
    }
    if (this.options.keepAwake) {
      this.keepAwake = startKeepAwake();
    } else {
      process.stderr.write("[bridge] keep-awake disabled\n");
    }
    if (this.options.agentUi) {
      process.env.LINKSHELL_ID = this.terminalHookMarker(DEFAULT_TERMINAL_ID);
      const availableProviders = resolveAgentWorkspaceProviders(this.options);
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
            cwd: process.cwd(),
            projectName: basename(process.cwd()),
          },
        }),
      );
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
      if (envelope.type === "agent.v2.prompt" || envelope.type === "agent.v2.command.execute") {
        this.refreshAgentPermissionHooks();
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
        if (envelope.type === "agent.prompt") this.refreshAgentPermissionHooks();
        await this.agentSession.handleEnvelope(envelope);
        break;
      }
      case "agent.permission.response": {
        const p = parseTypedPayload("agent.permission.response", envelope.payload);
        if (this.resolvePendingPermission(p.requestId, {
          outcome: p.outcome,
          optionId: p.optionId,
        }, "agent.permission.response").resolved) {
          break;
        }
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
        const result = this.resolvePendingPermission(p.requestId, p.decision, "permission.decision");
        if (!result.resolved) {
          this.sendPermissionSnapshot(
            tid,
            "thinking",
            "permission not pending",
            {
              requestId: p.requestId,
              outcome: p.decision,
              source: "permission.decision",
              delivered: false,
            },
          );
        }
        process.stderr.write(
          `[bridge] permission decision request=${p.requestId} decision=${p.decision} resolved=${result.resolved} delivered=${result.delivered}\n`,
        );
        this.send(createEnvelope({
          type: "permission.decision.result",
          sessionId: this.sessionId,
          terminalId: tid,
          payload: {
            requestId: p.requestId,
            decision: p.decision,
            resolved: result.resolved,
            delivered: result.delivered,
            source: "permission.decision",
            message: result.delivered
              ? undefined
              : result.resolved
                ? "Permission resolved but response was not delivered"
                : "Permission request is no longer pending",
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
    const hookMarker = this.terminalHookMarker(terminalId);
    // Inject marker so child CLIs' hook commands carry our identity
    cleanEnv["LINKSHELL_ID"] = hookMarker;

    const provider = providerOverride ?? this.options.providerConfig.provider;
    const args = [...this.options.providerConfig.args];

    // Set up hook server for structured status (all supported providers)
    // For "custom" shell, set up hooks for all providers since user may launch any of them
    let hookServer: http.Server | undefined;
    let hookPort: number | undefined;
    const hookConfigPaths: string[] = [];

    if (provider === "custom") {
      const result = await this.setupHookServer(terminalId, args, "claude", hookMarker);
      hookServer = result.server;
      hookPort = result.port;
      hookConfigPaths.push(result.configPath);
      // Also set up hooks for other providers (curlCmd already has marker from setupHookServer)
      const curlCmd = `curl -s --connect-timeout 1 --max-time ${Math.ceil((PERMISSION_REQUEST_TIMEOUT_MS + 30_000) / 1000)} -X POST "http://127.0.0.1:${result.port}/hook?m=${hookMarker}&lid=$LINKSHELL_ID" -H 'Content-Type: application/json' --data-binary @- || true`;
      hookConfigPaths.push(this.setupCodexHooks(terminalId, curlCmd, hookMarker));
      hookConfigPaths.push(this.setupGeminiHooks(terminalId, curlCmd, hookMarker));
      hookConfigPaths.push(this.setupCopilotHooks(terminalId, curlCmd, hookMarker));
    } else if (provider === "claude" || provider === "codex" || provider === "gemini" || provider === "copilot") {
      const result = await this.setupHookServer(terminalId, args, provider, hookMarker);
      hookServer = result.server;
      hookPort = result.port;
      hookConfigPaths.push(result.configPath);
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
      scrollback: new ScrollbackBuffer(SCROLLBACK_LINES),
      outputSeq: 0,
      statusSeq: 0,
      status: "running",
      hookServer,
      hookPort,
      hookMarker,
      hookConfigPaths,
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

  private async setupHookServer(terminalId: string, args: string[], provider: string, marker: string): Promise<{
    server: http.Server;
    port: number;
    configPath: string;
  }> {
    const server = http.createServer((req, res) => {
      this.log(`hook server received: ${req.method} ${req.url}`);
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "POST" || reqUrl.pathname !== "/hook") {
        res.writeHead(404);
        res.end();
        return;
      }
      // Check marker — reject events not from our PTY
      // m must match; lid must match OR be empty (some CLIs don't inherit env vars)
      const reqMarker = reqUrl.searchParams.get("m");
      const reqLid = reqUrl.searchParams.get("lid") ?? "";
      if (reqMarker !== marker || (reqLid !== "" && reqLid !== marker)) {
        this.log(`ignoring hook event: m=${reqMarker} lid=${reqLid} (expected ${marker})`);
        res.writeHead(200);
        res.end("ok");
        return;
      }
      let body = "";
      let bodyTooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (bodyTooLarge) return;
        body += chunk.toString();
        if (Buffer.byteLength(body, "utf8") > HOOK_BODY_LIMIT) {
          bodyTooLarge = true;
          res.writeHead(413);
          res.end("payload too large");
          req.destroy();
        }
      });
      req.on("end", () => {
        if (bodyTooLarge || res.writableEnded) return;
        this.log(`hook body (${body.length} bytes): ${body.slice(0, 200)}`);
        try {
          const event = JSON.parse(body);
          const hookName = (event.hook_event_name ?? event.event_name) as string | undefined;

          // PermissionRequest: hold connection, wait for user decision from mobile app
          if (hookName === "PermissionRequest") {
            const requestId = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const permissionSuggestions = hookPermissionSuggestions(event);
            const timeout = setTimeout(() => {
              if (this.resolvePendingPermission(requestId, "deny", "permission.timeout").resolved) {
                this.log(`permission request ${requestId} timed out`);
                this.sendPermissionSnapshot(terminalId, "thinking", "permission timed out");
              }
            }, PERMISSION_REQUEST_TIMEOUT_MS);
            this.pendingPermissions.set(requestId, {
              terminalId,
              timeout,
              permissionSuggestions,
              resolve: (decision) => {
                if (res.writableEnded) return false;
                const responseJson = JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PermissionRequest",
                    decision,
                  },
                });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(responseJson);
                return true;
              },
            });
            // Send status with requestId so app can route decision back
            this.handleHookEvent(terminalId, event, provider, requestId);
            this.sendHookPermissionRequest(terminalId, event, requestId);
          } else {
            // All other hooks: respond immediately
            res.writeHead(200);
            res.end("ok");
            this.handleHookEvent(terminalId, event, provider);
          }
        } catch (e) {
          res.writeHead(200);
          res.end("ok");
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
    this.log(`hook server for ${terminalId} (${provider}) listening on port ${port}, marker=${marker}`);

    const curlCmd = `curl -s --connect-timeout 1 --max-time ${Math.ceil((PERMISSION_REQUEST_TIMEOUT_MS + 30_000) / 1000)} -X POST "http://127.0.0.1:${port}/hook?m=${marker}&lid=$LINKSHELL_ID" -H 'Content-Type: application/json' --data-binary @- || true`;
    let configPath: string;

    if (provider === "codex") {
      configPath = this.setupCodexHooks(terminalId, curlCmd, marker);
    } else if (provider === "gemini") {
      configPath = this.setupGeminiHooks(terminalId, curlCmd, marker);
    } else if (provider === "copilot") {
      configPath = this.setupCopilotHooks(terminalId, curlCmd, marker);
    } else {
      // Claude (default)
      configPath = this.setupClaudeHooks(terminalId, curlCmd, args, marker);
    }

    return { server, port, configPath };
  }

  private refreshAgentPermissionHooks(): void {
    const term = this.terminals.get(DEFAULT_TERMINAL_ID);
    if (!term?.hookPort) return;
    const marker = term.hookMarker;
    const curlCmd = `curl -s --connect-timeout 1 --max-time ${Math.ceil((PERMISSION_REQUEST_TIMEOUT_MS + 30_000) / 1000)} -X POST "http://127.0.0.1:${term.hookPort}/hook?m=${marker}&lid=$LINKSHELL_ID" -H 'Content-Type: application/json' --data-binary @- || true`;
    const providers = resolveAgentWorkspaceProviders(this.options);
    try {
      for (const provider of providers) {
        if (provider === "codex") {
          this.setupCodexHooks(DEFAULT_TERMINAL_ID, curlCmd, marker);
        } else {
          // claude, custom
          this.setupClaudeHooks(DEFAULT_TERMINAL_ID, curlCmd, [], marker);
        }
      }
    } catch (error) {
      this.log(`failed to refresh agent permission hooks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private setupClaudeHooks(terminalId: string, curlCmd: string, args: string[], marker: string): string {
    // Write hooks to ~/.claude/settings.json — Claude Code reads hooks from here
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch { /* doesn't exist yet */ }

    const hookEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const permissionEntry = {
      matcher: "",
      hooks: [{
        type: "command",
        command: curlCmd,
        timeout: Math.ceil((PERMISSION_REQUEST_TIMEOUT_MS + 30_000) / 1000),
      }],
    };

    const hookEvents: Record<string, typeof hookEntry | typeof permissionEntry> = {
      PreToolUse: hookEntry,
      PostToolUse: hookEntry,
      PostToolUseFailure: hookEntry,
      Stop: hookEntry,
      PermissionRequest: permissionEntry,
      UserPromptSubmit: hookEntry,
      SessionStart: hookEntry,
    };

    // Append our entries to existing hooks (first remove stale linkshell entries)
    const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
    for (const [eventName, entry] of Object.entries(hookEvents)) {
      existingHooks[eventName] = eventName === "PermissionRequest"
        ? withBlockingLinkShellPermissionEntry(existingHooks[eventName], entry)
        : withLinkShellHookEntry(existingHooks[eventName], entry, "last");
    }

    const merged = { ...existing, hooks: existingHooks };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    this.log(`claude hooks appended to ${settingsPath}`);

    return settingsPath;
  }

  private setupCodexHooks(terminalId: string, curlCmd: string, marker: string): string {
    // Codex uses ~/.codex/hooks.json — same format as Claude (with matcher)
    const codexDir = join(homedir(), ".codex");
    if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });

    // Ensure [features] codex_hooks = true in config.toml
    const tomlPath = join(codexDir, "config.toml");
    let tomlContent = "";
    try { tomlContent = readFileSync(tomlPath, "utf8"); } catch { /* doesn't exist yet */ }

    // Remove top-level codex_hooks (wrong location) and ensure it's under [features]
    const hasFeatureSection = tomlContent.includes("[features]");
    const hasCodexHooksUnderFeatures = hasFeatureSection &&
      /\[features\][^\[]*codex_hooks\s*=\s*true/s.test(tomlContent);

    if (!hasCodexHooksUnderFeatures) {
      // Remove any top-level codex_hooks line
      tomlContent = tomlContent.replace(/^codex_hooks\s*=.*\n?/m, "");
      if (!tomlContent.includes("[features]")) {
        tomlContent += `\n[features]\ncodex_hooks = true\n`;
      } else {
        tomlContent = tomlContent.replace("[features]", "[features]\ncodex_hooks = true");
      }
      writeFileSync(tomlPath, tomlContent);
      this.log(`enabled codex_hooks under [features] in ${tomlPath}`);
    }

    const hooksPath = join(codexDir, "hooks.json");
    const hookEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const permissionEntry = {
      matcher: "",
      hooks: [{
        type: "command",
        command: curlCmd,
        timeout: Math.ceil((PERMISSION_REQUEST_TIMEOUT_MS + 30_000) / 1000),
      }],
    };
    const hookEvents: Record<string, typeof hookEntry | typeof permissionEntry> = {
      SessionStart: hookEntry,
      PreToolUse: hookEntry,
      PostToolUse: hookEntry,
      UserPromptSubmit: hookEntry,
      Stop: hookEntry,
      PermissionRequest: permissionEntry,
    };

    // Read existing and append
    let existing: { hooks?: Record<string, unknown[]> } = {};
    try { existing = JSON.parse(readFileSync(hooksPath, "utf8")); } catch { /* doesn't exist yet */ }
    const existingHooks = existing.hooks ?? {};
    for (const [eventName, entry] of Object.entries(hookEvents)) {
      existingHooks[eventName] = eventName === "PermissionRequest"
        ? withBlockingLinkShellPermissionEntry(existingHooks[eventName], entry)
        : withLinkShellHookEntry(existingHooks[eventName], entry, "last");
    }

    writeFileSync(hooksPath, JSON.stringify({ ...existing, hooks: existingHooks }, null, 2));
    this.log(`codex hooks appended to ${hooksPath}`);
    return hooksPath;
  }

  private setupGeminiHooks(terminalId: string, curlCmd: string, marker: string): string {
    // Gemini uses ~/.gemini/settings.json — same format as Claude (with matcher)
    const geminiDir = join(homedir(), ".gemini");
    if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

    const settingsPath = join(geminiDir, "settings.json");
    const hookEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 5000 }] };
    const hookEvents: Record<string, typeof hookEntry> = {
      SessionStart: hookEntry,
      SessionEnd: hookEntry,
      BeforeTool: hookEntry,
      AfterTool: hookEntry,
    };

    // Merge with existing settings if present
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch { /* doesn't exist yet */ }

    const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
    for (const [eventName, entry] of Object.entries(hookEvents)) {
      existingHooks[eventName] = withLinkShellHookEntry(existingHooks[eventName], entry, "last");
    }

    existing.hooks = existingHooks;
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    this.log(`gemini hooks appended to ${settingsPath}`);
    return settingsPath;
  }

  private setupCopilotHooks(terminalId: string, curlCmd: string, marker: string): string {
    // Copilot loads hooks from CWD as hooks.json
    const cwd = this.terminals.get(terminalId)?.cwd ?? process.cwd();
    const hooksPath = join(cwd, "hooks.json");
    const mkHook = () => ({
      type: "command",
      bash: curlCmd,
      timeoutSec: 30,
    });
    const hookEvents: Record<string, ReturnType<typeof mkHook>> = {
      sessionStart: mkHook(),
      sessionEnd: mkHook(),
      userPromptSubmitted: mkHook(),
      preToolUse: mkHook(),
      postToolUse: mkHook(),
      errorOccurred: mkHook(),
    };

    // Read existing and append
    let existing: { version?: number; hooks?: Record<string, unknown[]> } = {};
    try { existing = JSON.parse(readFileSync(hooksPath, "utf8")); } catch { /* doesn't exist yet */ }
    const existingHooks = existing.hooks ?? {};
    for (const [eventName, entry] of Object.entries(hookEvents)) {
      existingHooks[eventName] = withLinkShellHookEntry(existingHooks[eventName], entry, "last");
    }

    writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: existingHooks }, null, 2));
    this.log(`copilot hooks appended to ${hooksPath}`);
    return hooksPath;
  }

  private handleHookEvent(terminalId: string, event: Record<string, unknown>, provider: string, permissionRequestId?: string): void {
    const rawHookName = (event.hook_event_name ?? event.event_name) as string | undefined;
    if (!rawHookName) return;

    // Auto-detect provider from hook event fields
    const hookTerm = this.terminals.get(terminalId);
    let detectedProvider = provider;

    // Always detect from transcript_path (most reliable), regardless of current provider
    const transcriptPath = typeof event.transcript_path === "string" ? event.transcript_path as string : "";
    if (transcriptPath.includes(".claude/")) {
      detectedProvider = "claude";
    } else if (transcriptPath.includes(".gemini/")) {
      detectedProvider = "gemini";
    } else if (transcriptPath.includes(".codex/")) {
      detectedProvider = "codex";
    } else if (hookTerm?.provider === "custom") {
      // Fallback heuristics only when provider is still unknown
      if (event.model && typeof event.model === "string" && /^(gpt|o[0-9]|codex)/i.test(event.model as string)) {
        detectedProvider = "codex";
      } else if (event.session_id && !transcriptPath) {
        detectedProvider = "codex";
      } else if (/^(Before|After)(Tool)$|^Session(Start|End)$/.test(rawHookName)) {
        detectedProvider = "gemini";
      } else if (/^(pre|post)ToolUse$|^session(Start|End)$|^userPromptSubmitted$|^errorOccurred$/.test(rawHookName)) {
        detectedProvider = "copilot";
      }
    }

    if (hookTerm && detectedProvider !== hookTerm.provider) {
      const wasCustom = hookTerm.provider === "custom";
      hookTerm.provider = detectedProvider;
      this.log(`${wasCustom ? "detected" : "provider switched"} provider for ${terminalId}: ${detectedProvider}`);
      this.permissionStacks.delete(terminalId);
      this.sendTerminalList();
    }

    // Normalize hook event names from different providers to unified names
    const hookName = this.normalizeHookName(rawHookName, detectedProvider);
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
        // Pop permission stack + auto-resolve pending HTTP connection
        {
          const stack = this.permissionStacks.get(terminalId);
          if (stack && stack.length > 0) {
            const popped = stack.pop();
            if (popped) this.autoResolvePending(popped.requestId);
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
            const popped = stack.pop();
            if (popped) this.autoResolvePending(popped.requestId);
            if (stack.length === 0) this.permissionStacks.delete(terminalId);
          }
        }
        break;
      case "Stop":
        phase = "idle";
        if (event.stop_reason) summary = String(event.stop_reason);
        this.drainPendingPermissions(terminalId);
        this.permissionStacks.delete(terminalId);
        // Reset provider to "custom" when a CLI session ends inside a custom shell
        if (hookTerm && this.options.providerConfig.provider === "custom") {
          hookTerm.provider = "custom";
          this.log(`provider reset to custom for ${terminalId} (CLI session ended)`);
          this.sendTerminalList();
        }
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
        // Push to permission stack (use requestId from hook server if available)
        {
          const reqId = permissionRequestId ?? `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          if (!this.permissionStacks.has(terminalId)) {
            this.permissionStacks.set(terminalId, []);
          }
          this.permissionStacks.get(terminalId)!.push({
            requestId: reqId,
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
        this.drainPendingPermissions(terminalId);
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

  private sendHookPermissionRequest(
    terminalId: string,
    event: Record<string, unknown>,
    requestId: string,
  ): void {
    const toolName = (event.tool_name ?? event.toolName) as string | undefined;
    const toolInput = stringifyHookInput(event.tool_input ?? event.toolInput);
    const suggestions = hookPermissionSuggestions(event);
    const context =
      typeof event.permission_prompt === "string"
        ? event.permission_prompt
        : typeof event.message === "string"
          ? event.message
          : undefined;
    this.send(createEnvelope({
      type: "agent.permission.request",
      sessionId: this.sessionId,
      terminalId,
      payload: {
        requestId,
        toolName,
        toolInput,
        context,
        options: hookPermissionOptions(suggestions),
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

    // Codex events — same as Claude (PascalCase)
    if (provider === "codex") {
      switch (rawName) {
        case "PreToolUse": case "preToolUse": return "PreToolUse";
        case "PostToolUse": case "postToolUse": return "PostToolUse";
        case "SessionStart": case "sessionStart": return "SessionStart";
        case "UserPromptSubmit": return "UserPromptSubmit";
        case "PermissionRequest": return "PermissionRequest";
        case "Stop": return "Stop";
        default: return undefined;
      }
    }

    // Gemini events
    if (provider === "gemini") {
      switch (rawName) {
        case "BeforeTool": return "PreToolUse";
        case "AfterTool": return "PostToolUse";
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
        case "userPromptSubmitted": return "UserPromptSubmit";
        case "errorOccurred": return "PostToolUseFailure";
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

  /** Auto-resolve a single pending permission (user acted in terminal) */
  private autoResolvePending(requestId: string): void {
    if (this.resolvePendingPermission(requestId, "allow", "terminal.auto").resolved) {
      this.log(`auto-resolved pending permission ${requestId} (user acted in terminal)`);
    }
  }

  /** Drain all pending permissions for a terminal (session ended, stop, etc.) */
  private drainPendingPermissions(terminalId: string): void {
    const stack = this.permissionStacks.get(terminalId);
    if (!stack) return;
    for (const entry of [...stack]) {
      if (this.resolvePendingPermission(entry.requestId, "deny", "terminal.drain").resolved) {
        this.log(`drained pending permission ${entry.requestId}`);
      }
    }
  }

  private resolvePendingPermission(
    requestId: string,
    choice: HookPermissionChoice,
    source = "unknown",
  ): { resolved: boolean; delivered: boolean } {
    const pending = this.pendingPermissions.get(requestId);
    const outcome = typeof choice === "string" ? choice : choice.outcome;
    const optionId = typeof choice === "string" ? undefined : choice.optionId;
    if (!pending) {
      this.log(`no pending permission for ${requestId} via ${source}: ${outcome}:${optionId ?? "default"}`);
      return { resolved: false, delivered: false };
    }
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timeout);
    const delivered = pending.resolve(this.formatHookPermissionDecision(pending, choice));

    const stack = this.permissionStacks.get(pending.terminalId);
    if (stack) {
      const idx = stack.findIndex((entry) => entry.requestId === requestId);
      if (idx >= 0) stack.splice(idx, 1);
      if (stack.length === 0) this.permissionStacks.delete(pending.terminalId);
    }
    this.log(`resolved permission ${requestId} via ${source}: ${outcome}:${optionId ?? "default"} delivered=${delivered}`);
    this.sendPermissionSnapshot(
      pending.terminalId,
      "thinking",
      outcome === "allow" ? "permission allowed" : "permission denied",
      { requestId, outcome, source, delivered },
    );
    return { resolved: true, delivered };
  }

  private formatHookPermissionDecision(
    permission: PendingPermission,
    choice: HookPermissionChoice,
  ): HookPermissionDecision {
    const outcome = typeof choice === "string" ? choice : choice.outcome;
    const optionId = typeof choice === "string" ? undefined : choice.optionId;
    if (outcome === "allow") {
      return {
        behavior: "allow",
        ...(optionId === "allow_always" && permission.permissionSuggestions.length > 0
          ? { updatedPermissions: permission.permissionSuggestions }
          : {}),
      };
    }
    return {
      behavior: "deny",
      message: outcome === "cancelled" ? "Permission request cancelled." : "Permission denied by user.",
    };
  }

  private sendPermissionSnapshot(
    terminalId: string,
    phase: string,
    summary?: string,
    permissionResolution?: {
      requestId: string;
      outcome: "allow" | "deny" | "cancelled";
      source: string;
      delivered: boolean;
    },
  ): void {
    const stack = this.permissionStacks.get(terminalId);
    const topPermission = stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
    const pendingPermissionCount = stack?.length ?? 0;
    const term = this.terminals.get(terminalId);
    const seq = term ? term.statusSeq++ : 0;
    this.send(createEnvelope({
      type: "terminal.status",
      sessionId: this.sessionId,
      terminalId,
      payload: {
        phase,
        seq,
        ...(summary && { summary }),
        ...(permissionResolution && { permissionResolution }),
        ...(topPermission && { topPermission }),
        ...(pendingPermissionCount > 0 && { pendingPermissionCount }),
      },
    }));
  }

  private cleanupHookServer(term: TerminalInstance): void {
    // Drain any pending permission requests for this terminal
    this.drainPendingPermissions(term.id);
    if (term.hookServer) {
      term.hookServer.close();
      term.hookServer = undefined;
      this.log(`hook server closed for ${term.id}`);
    }
    const marker = term.hookMarker;
    for (const configPath of term.hookConfigPaths) {
      try {
        // Copilot: per-instance file — just delete it
        if (configPath.includes(`linkshell-${marker}`)) {
          if (existsSync(configPath)) {
            unlinkSync(configPath);
            this.log(`removed copilot hook file ${configPath}`);
          }
        } else {
          // Claude/Codex/Gemini: remove our entries from the shared config
          this.removeHookEntries(configPath, marker);
        }
      } catch { /* ignore */ }
    }
    term.hookConfigPaths = [];
  }

  /** Remove hook entries containing our marker from a JSON config file */
  private removeHookEntries(configPath: string, marker: string): void {
    if (!existsSync(configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      const hooks = raw.hooks as Record<string, unknown[]> | undefined;
      if (!hooks) return;

      let changed = false;
      for (const [eventName, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => {
          const str = JSON.stringify(entry);
          return !str.includes(marker);
        });
        if (filtered.length !== entries.length) {
          changed = true;
          if (filtered.length === 0) {
            delete hooks[eventName];
          } else {
            hooks[eventName] = filtered;
          }
        }
      }

      if (changed) {
        // If no hooks left, remove the hooks key entirely
        if (Object.keys(hooks).length === 0) {
          delete raw.hooks;
        }
        writeFileSync(configPath, JSON.stringify(raw, null, 2));
        this.log(`removed our hook entries from ${configPath}`);
      }
    } catch { /* ignore parse errors */ }
  }

  /**
   * Remove ALL LinkShell hook entries (any marker) from a JSON config file.
   * Used on startup to sweep stale entries left behind by a crashed instance,
   * whose curl ports are now dead. Matches via isLinkShellHookEntry rather than
   * a single marker so entries from previous runs are also cleaned.
   */
  private sweepLinkShellHookEntries(configPath: string): void {
    if (!existsSync(configPath)) return;
    try {
      // Re-read immediately before write to minimize the window for a
      // concurrent writer to clobber our changes.
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      const hooks = raw.hooks as Record<string, unknown[]> | undefined;
      if (!hooks) return;

      let changed = false;
      for (const [eventName, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => !isLinkShellHookEntry(entry));
        if (filtered.length !== entries.length) {
          changed = true;
          if (filtered.length === 0) {
            delete hooks[eventName];
          } else {
            hooks[eventName] = filtered;
          }
        }
      }

      if (changed) {
        if (Object.keys(hooks).length === 0) {
          delete raw.hooks;
        }
        writeFileSync(configPath, JSON.stringify(raw, null, 2));
        this.log(`swept stale LinkShell hook entries from ${configPath}`);
      }
    } catch { /* ignore parse errors */ }
  }

  /** Sweep stale LinkShell hook entries from known shared config files on startup. */
  private sweepStaleHookConfigs(): void {
    const home = homedir();
    const candidates = [
      join(home, ".claude", "settings.json"),
      join(home, ".codex", "hooks.json"),
      join(home, ".gemini", "settings.json"),
      join(process.cwd(), "hooks.json"), // copilot (per-cwd)
    ];
    for (const path of candidates) {
      this.sweepLinkShellHookEntries(path);
    }
  }

  private send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
      this.cleanupHookServer(term);
      if (term.status === "running") term.pty.kill();
    }
    this.terminals.clear();
    process.exitCode = exitCode;
  }
}
