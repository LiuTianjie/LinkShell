import * as pty from "node-pty";
import WebSocket from "ws";
import { hostname, platform } from "node:os";
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
  providerConfig: ProviderConfig;
}

const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
const RECONNECT_MAX_ATTEMPTS = 20;

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
  private terminal: pty.IPty | undefined;
  private outputSeq = 0;
  private lastAckedSeq = -1;
  private scrollback = new ScrollbackBuffer(1000);
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private sessionId = "";
  private exited = false;
  private stopped = false;

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
    this.spawnTerminal();
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
      this.handleMessage(envelope);
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

  private handleMessage(envelope: Envelope): void {
    switch (envelope.type) {
      case "terminal.input": {
        const p = parseTypedPayload("terminal.input", envelope.payload);
        this.terminal?.write(p.data);
        break;
      }
      case "terminal.resize": {
        const p = parseTypedPayload("terminal.resize", envelope.payload);
        this.terminal?.resize(p.cols, p.rows);
        break;
      }
      case "session.ack": {
        const p = parseTypedPayload("session.ack", envelope.payload);
        this.lastAckedSeq = Math.max(this.lastAckedSeq, p.seq);
        this.scrollback.trimUpTo(this.lastAckedSeq);
        break;
      }
      case "session.resume": {
        const p = parseTypedPayload("session.resume", envelope.payload);
        this.replayFrom(p.lastAckedSeq);
        break;
      }
      case "session.heartbeat":
        break;
      default:
        break;
    }
  }

  private replayFrom(seq: number): void {
    const messages = this.scrollback.replayFrom(seq);
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
          seq: msg.seq,
          payload: { ...payload, isReplay: true },
        }),
      );
    }
  }

  private spawnTerminal(): void {
    // Filter out undefined env values — node-pty's native posix_spawnp chokes on them
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.providerConfig.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }

    this.terminal = pty.spawn(
      this.options.providerConfig.command,
      this.options.providerConfig.args,
      {
        name: "xterm-256color",
        cols: this.options.cols,
        rows: this.options.rows,
        cwd: process.cwd(),
        env: cleanEnv,
      },
    );

    this.terminal.onData((data) => {
      const seq = this.outputSeq++;
      const envelope = createEnvelope({
        type: "terminal.output",
        sessionId: this.sessionId,
        seq,
        payload: {
          stream: "stdout" as const,
          data,
          encoding: "utf8" as const,
          isReplay: false,
          isFinal: false,
        },
      });
      this.scrollback.push(envelope);
      this.send(envelope);
    });

    this.terminal.onExit(({ exitCode, signal }) => {
      this.exited = true;
      const envelope = createEnvelope({
        type: "terminal.exit",
        sessionId: this.sessionId,
        payload: { exitCode, signal },
      });
      this.send(envelope);
      setTimeout(() => {
        this.stopHeartbeat();
        this.socket?.close();
      }, 500);
      process.exitCode = exitCode ?? 0;
    });
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.terminal?.kill();
    process.exitCode = exitCode;
  }
}
