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
  hookConfigPaths: string[];
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
  // Pending permission responses: requestId → HTTP response callback
  private pendingPermissions = new Map<string, (decision: "allow" | "deny") => void>();
  private hookMarker = `lsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  private screenCapture: ScreenFallback | undefined;
  private screenShare: ScreenShare | undefined;
  private tunnelSockets = new Map<string, WebSocket>();

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
      case "permission.decision": {
        const p = envelope.payload as { requestId: string; decision: "allow" | "deny" };
        const resolve = this.pendingPermissions.get(p.requestId);
        if (resolve) {
          this.pendingPermissions.delete(p.requestId);
          resolve(p.decision);
          this.log(`permission decision for ${p.requestId}: ${p.decision}`);
          // Pop from permission stack
          if (p.decision === "allow" || p.decision === "deny") {
            const stack = this.permissionStacks.get(tid);
            if (stack) {
              const idx = stack.findIndex((s) => s.requestId === p.requestId);
              if (idx >= 0) stack.splice(idx, 1);
              if (stack.length === 0) this.permissionStacks.delete(tid);
            }
          }
        } else {
          this.log(`no pending permission for ${p.requestId}`);
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
      this.send(
        createEnvelope({
          type: "tunnel.ws.close",
          sessionId: this.sessionId,
          payload: {
            requestId,
            code,
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
    ws.close(payload.code ?? 1000, payload.reason ?? "");
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
    // Inject marker so child CLIs' hook commands carry our identity
    cleanEnv["LINKSHELL_ID"] = this.hookMarker;

    const provider = providerOverride ?? this.options.providerConfig.provider;
    const args = [...this.options.providerConfig.args];

    // Set up hook server for structured status (all supported providers)
    // For "custom" shell, set up hooks for all providers since user may launch any of them
    let hookServer: http.Server | undefined;
    let hookPort: number | undefined;
    const hookConfigPaths: string[] = [];

    if (provider === "custom") {
      const result = await this.setupHookServer(terminalId, args, "claude");
      hookServer = result.server;
      hookPort = result.port;
      hookConfigPaths.push(result.configPath);
      // Also set up hooks for other providers (curlCmd already has marker from setupHookServer)
      const curlCmd = `curl -s -X POST "http://127.0.0.1:${result.port}/hook?m=${this.hookMarker}&lid=$LINKSHELL_ID" -H 'Content-Type: application/json' --data-binary @-`;
      hookConfigPaths.push(this.setupCodexHooks(terminalId, curlCmd));
      hookConfigPaths.push(this.setupGeminiHooks(terminalId, curlCmd));
      hookConfigPaths.push(this.setupCopilotHooks(terminalId, curlCmd));
    } else if (provider === "claude" || provider === "codex" || provider === "gemini" || provider === "copilot") {
      const result = await this.setupHookServer(terminalId, args, provider);
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
      scrollback: new ScrollbackBuffer(1000),
      outputSeq: 0,
      statusSeq: 0,
      status: "running",
      hookServer,
      hookPort,
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
    const marker = this.hookMarker;
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
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        this.log(`hook body (${body.length} bytes): ${body.slice(0, 200)}`);
        try {
          const event = JSON.parse(body);
          const hookName = (event.hook_event_name ?? event.event_name) as string | undefined;

          // PermissionRequest: hold connection, wait for user decision from mobile app
          if (hookName === "PermissionRequest") {
            const requestId = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.pendingPermissions.set(requestId, (decision) => {
              const responseJson = JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PermissionRequest",
                  decision: { behavior: decision },
                },
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(responseJson);
            });
            // Send status with requestId so app can route decision back
            this.handleHookEvent(terminalId, event, provider, requestId);
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

    const curlCmd = `curl -s -X POST "http://127.0.0.1:${port}/hook?m=${marker}&lid=$LINKSHELL_ID" -H 'Content-Type: application/json' --data-binary @-`;
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
    // Write hooks to ~/.claude/settings.json — Claude Code reads hooks from here
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch { /* doesn't exist yet */ }

    const hookEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 5 }] };
    const permissionEntry = { matcher: "", hooks: [{ type: "command", command: curlCmd, timeout: 86400 }] };

    const hookEvents: Record<string, typeof hookEntry> = {
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
      let arr = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
      // Remove any dead linkshell hook entries (from previous instances)
      arr = arr.filter((e) => !JSON.stringify(e).includes("/hook"));
      arr.push(entry);
      existingHooks[eventName] = arr;
    }

    const merged = { ...existing, hooks: existingHooks };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    this.log(`claude hooks appended to ${settingsPath}`);

    return settingsPath;
  }

  private setupCodexHooks(terminalId: string, curlCmd: string): string {
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
    const hookEvents: Record<string, typeof hookEntry> = {
      SessionStart: hookEntry,
      PreToolUse: hookEntry,
      PostToolUse: hookEntry,
      UserPromptSubmit: hookEntry,
      Stop: hookEntry,
    };

    // Read existing and append
    let existing: { hooks?: Record<string, unknown[]> } = {};
    try { existing = JSON.parse(readFileSync(hooksPath, "utf8")); } catch { /* doesn't exist yet */ }
    const existingHooks = existing.hooks ?? {};
    for (const [eventName, entry] of Object.entries(hookEvents)) {
      let arr = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
      arr = arr.filter((e) => !JSON.stringify(e).includes("/hook"));
      arr.push(entry);
      existingHooks[eventName] = arr;
    }

    writeFileSync(hooksPath, JSON.stringify({ hooks: existingHooks }, null, 2));
    this.log(`codex hooks appended to ${hooksPath}`);
    return hooksPath;
  }

  private setupGeminiHooks(terminalId: string, curlCmd: string): string {
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
      let arr = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
      arr = arr.filter((e) => !JSON.stringify(e).includes("/hook"));
      arr.push(entry);
      existingHooks[eventName] = arr;
    }

    existing.hooks = existingHooks;
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    this.log(`gemini hooks appended to ${settingsPath}`);
    return settingsPath;
  }

  private setupCopilotHooks(terminalId: string, curlCmd: string): string {
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
      let arr = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
      arr = arr.filter((e) => !JSON.stringify(e).includes("/hook"));
      arr.push(entry);
      existingHooks[eventName] = arr;
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
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      resolve("allow");
      this.log(`auto-resolved pending permission ${requestId} (user acted in terminal)`);
    }
  }

  /** Drain all pending permissions for a terminal (session ended, stop, etc.) */
  private drainPendingPermissions(terminalId: string): void {
    const stack = this.permissionStacks.get(terminalId);
    if (!stack) return;
    for (const entry of stack) {
      const resolve = this.pendingPermissions.get(entry.requestId);
      if (resolve) {
        this.pendingPermissions.delete(entry.requestId);
        resolve("deny");
        this.log(`drained pending permission ${entry.requestId}`);
      }
    }
  }

  private cleanupHookServer(term: TerminalInstance): void {
    // Drain any pending permission requests for this terminal
    this.drainPendingPermissions(term.id);
    if (term.hookServer) {
      term.hookServer.close();
      term.hookServer = undefined;
      this.log(`hook server closed for ${term.id}`);
    }
    const marker = this.hookMarker;
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
    // Clean up tunnel WebSockets
    for (const ws of this.tunnelSockets.values()) {
      ws.close(1001, "Session stopped");
    }
    this.tunnelSockets.clear();
    for (const term of this.terminals.values()) {
      this.cleanupHookServer(term);
      if (term.status === "running") term.pty.kill();
    }
    this.terminals.clear();
    process.exitCode = exitCode;
  }
}
