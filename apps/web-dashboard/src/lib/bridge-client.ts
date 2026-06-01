// WebSocket bridge client — the browser's connection to one gateway session.
// Ported from the mobile useSessionManager transport: connect as role=client,
// claim control, send/receive envelopes, heartbeat, exponential-backoff
// reconnect with an epoch guard, and session.resume replay with per-terminal
// ACK cursors. No React here — consumers subscribe via onEvent.

import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  parseTypedPayload,
  isAgentV2HostToClientMessage,
  PROTOCOL_VERSION,
} from "@linkshell/protocol";
import type { Envelope, ProtocolMessageType } from "@linkshell/protocol";
import type { ConnectionStatus, GatewayConfig } from "./types";
import { clientWsUrl } from "./gateway-api";
import { ensureDeviceToken, getDeviceId } from "./device-token";

const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
const RECONNECT_MAX_ATTEMPTS = 20;

export type BridgeEvent =
  | { type: "status"; status: ConnectionStatus }
  | { type: "terminal.output"; terminalId: string; data: string; seq?: number; isReplay?: boolean }
  | { type: "terminal.reset"; terminalId: string }
  | { type: "terminal.list"; envelope: Envelope }
  | { type: "control"; controllerId: string | null }
  | { type: "agent"; envelope: Envelope } // any agent.v2.* host_to_client message
  | { type: "session.error"; code: string; message: string }
  | { type: "envelope"; envelope: Envelope }; // catch-all for other types

export interface BridgeOptions {
  config: GatewayConfig;
  sessionId: string;
  /** Resolves a FRESH Supabase access token at (re)connect time for
   *  AUTH_REQUIRED cloud gateways. Called before every socket open so a
   *  rotated token is used on reconnect (a static string would go stale). */
  getJwt?: () => Promise<string | null> | string | null;
}

export class BridgeClient {
  private socket: WebSocket | undefined;
  private status: ConnectionStatus = "idle";
  private deviceId = getDeviceId();
  private controllerId: string | null = null;
  private epoch = 0;
  private reconnectAttempts = 0;
  private manualClose = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAckedSeqByTerminal = new Map<string, number>();
  // Per-terminal output buffer so a closed+reopened terminal pane (xterm gets
  // disposed on unmount) can replay what it already received. Bounded by char
  // count to avoid unbounded growth.
  private terminalBuffers = new Map<string, string>();
  private listeners = new Set<(e: BridgeEvent) => void>();

  constructor(private readonly options: BridgeOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }
  get currentStatus(): ConnectionStatus {
    return this.status;
  }
  get isController(): boolean {
    return this.controllerId === this.deviceId;
  }

  onEvent(listener: (e: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: BridgeEvent): void {
    for (const l of this.listeners) l(event);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: "status", status });
  }

  connect(): void {
    this.manualClose = false;
    this.openSocket(false);
  }

  private openSocket(isReconnect: boolean): void {
    if (this.manualClose) return;
    const epoch = ++this.epoch;
    this.setStatus(isReconnect ? "reconnecting" : "connecting");
    // Resolve a fresh JWT (token may have rotated since the last connect).
    void Promise.resolve(this.options.getJwt?.() ?? null).then((jwt) => {
      if (epoch !== this.epoch || this.manualClose) return; // superseded
      this.openSocketWithJwt(epoch, isReconnect, jwt);
    });
  }

  private openSocketWithJwt(epoch: number, isReconnect: boolean, jwt: string | null): void {
    const url = clientWsUrl(this.options.config, {
      sessionId: this.options.sessionId,
      deviceId: this.deviceId,
      deviceToken: ensureDeviceToken(),
      jwt,
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect(epoch);
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      if (epoch !== this.epoch) {
        try { ws.close(); } catch {}
        return;
      }
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.startHeartbeat();
      // Auto-claim control so the browser can drive the session immediately.
      this.claimControl();
      if (isReconnect) {
        this.sendResume();
      }
    };

    ws.onmessage = (event) => {
      if (epoch !== this.epoch) return;
      this.handleMessage(typeof event.data === "string" ? event.data : String(event.data));
    };

    ws.onerror = () => {
      if (epoch !== this.epoch) return;
      // onclose will follow and drive reconnect.
    };

    ws.onclose = () => {
      // Ignore close events from superseded sockets.
      if (epoch !== this.epoch) return;
      this.stopHeartbeat();
      if (this.manualClose) {
        this.setStatus("disconnected");
        return;
      }
      this.scheduleReconnect(epoch);
    };
  }

  private scheduleReconnect(epoch: number): void {
    if (this.manualClose || epoch !== this.epoch) return;
    // After the cap, hold at the max delay (don't collapse back to 1s and
    // hammer the gateway). Keep retrying indefinitely — web clients should
    // recover whenever the host returns.
    const attempt = Math.min(this.reconnectAttempts++, RECONNECT_MAX_ATTEMPTS);
    const base = Math.min(RECONNECT_BASE_DELAY * 2 ** attempt, RECONNECT_MAX_DELAY);
    // Full jitter so many tabs don't reconnect in lockstep (thundering herd).
    const delay = base * (0.5 + Math.random() * 0.5);
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => this.openSocket(true), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw(
        createEnvelope({
          type: "session.heartbeat",
          sessionId: this.options.sessionId,
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

  private sendResume(): void {
    this.sendRaw(
      createEnvelope({
        type: "session.resume",
        sessionId: this.options.sessionId,
        payload: {
          lastAckedSeq: -1,
          lastAckedSeqByTerminal: Object.fromEntries(this.lastAckedSeqByTerminal),
        },
      }),
    );
  }

  private handleMessage(raw: string): void {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch {
      return;
    }

    const type = envelope.type as string;

    if (type === "terminal.output") {
      try {
        const p = parseTypedPayload("terminal.output", envelope.payload);
        const terminalId = envelope.terminalId ?? "default";
        // ACK the highest seq we've seen per terminal so resume can replay gaps.
        if (envelope.seq !== undefined) {
          const prev = this.lastAckedSeqByTerminal.get(terminalId) ?? -1;
          if (envelope.seq > prev) {
            this.lastAckedSeqByTerminal.set(terminalId, envelope.seq);
            this.sendRaw(
              createEnvelope({
                type: "session.ack",
                sessionId: this.options.sessionId,
                terminalId,
                payload: { seq: envelope.seq },
              }),
            );
          }
        }
        this.emit({
          type: "terminal.output",
          terminalId,
          data: p.data,
          seq: envelope.seq,
          isReplay: (p as { isReplay?: boolean }).isReplay,
        });
        // Buffer for replay when a reopened pane needs to catch up. Cap at
        // ~256KB per terminal (drop oldest half on overflow).
        const prevBuf = this.terminalBuffers.get(terminalId) ?? "";
        let nextBuf = prevBuf + p.data;
        if (nextBuf.length > 262144) nextBuf = nextBuf.slice(nextBuf.length - 131072);
        this.terminalBuffers.set(terminalId, nextBuf);
      } catch {}
      return;
    }

    if (type === "terminal.reset") {
      const terminalId = envelope.terminalId ?? "default";
      // Host cleared the screen / restarted the PTY — drop the replay buffer so
      // a reopened pane doesn't prepend stale scrollback before live output.
      this.terminalBuffers.delete(terminalId);
      this.lastAckedSeqByTerminal.delete(terminalId);
      this.emit({ type: "terminal.reset", terminalId });
      return;
    }

    if (type === "control.grant") {
      const deviceId = (envelope.payload as { deviceId?: string })?.deviceId ?? null;
      this.controllerId = deviceId;
      this.emit({ type: "control", controllerId: deviceId });
      return;
    }
    if (type === "control.release") {
      this.controllerId = null;
      this.emit({ type: "control", controllerId: null });
      return;
    }

    if (type === "session.error") {
      const p = envelope.payload as { code?: string; message?: string };
      this.emit({ type: "session.error", code: p.code ?? "error", message: p.message ?? "" });
      return;
    }

    if (type === "session.host_disconnected") {
      this.setStatus("host_disconnected");
      return;
    }
    if (type === "session.host_reconnected") {
      this.setStatus("connected");
      return;
    }

    if (type === "terminal.list" || type === "terminal.spawned") {
      this.emit({ type: "terminal.list", envelope });
      return;
    }

    if (isAgentV2HostToClientMessage(type)) {
      this.emit({ type: "agent", envelope });
      return;
    }

    this.emit({ type: "envelope", envelope });
  }

  // ── Outbound ──────────────────────────────────────────────────────

  private sendRaw(envelope: Envelope): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(serializeEnvelope(envelope));
    return true;
  }

  /** Send an envelope, claiming control first if we don't already hold it. */
  send<T>(type: ProtocolMessageType, payload: T, terminalId?: string): boolean {
    return this.sendRaw(
      createEnvelope({
        type,
        sessionId: this.options.sessionId,
        deviceId: this.deviceId,
        terminalId,
        payload,
      }),
    );
  }

  claimControl(): void {
    this.sendRaw(
      createEnvelope({
        type: "control.claim",
        sessionId: this.options.sessionId,
        deviceId: this.deviceId,
        payload: { deviceId: this.deviceId },
      }),
    );
  }

  sendInput(terminalId: string, data: string): void {
    this.send("terminal.input", { data }, terminalId);
  }

  sendResize(terminalId: string, cols: number, rows: number): void {
    this.send("terminal.resize", { cols, rows }, terminalId);
  }

  requestTerminalList(): void {
    this.send("terminal.list", { terminals: [] });
  }

  /** Buffered output for a terminal, so a reopened pane can replay it. */
  terminalBuffer(terminalId: string): string {
    return this.terminalBuffers.get(terminalId) ?? "";
  }

  /** Spawn a new terminal tab. forceNew lets multiple tabs share one cwd. */
  spawnTerminal(cwd: string): void {
    this.send("terminal.spawn", { cwd, forceNew: true });
  }

  killTerminal(terminalId: string): void {
    this.send("terminal.kill", { terminalId }, terminalId);
    this.terminalBuffers.delete(terminalId);
  }

  /** Send an agent.v2.* (or any) client message; protocol version is implied. */
  sendAgent<T>(type: ProtocolMessageType, payload: T): void {
    this.send(type, payload);
  }

  protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  disconnect(): void {
    this.manualClose = true;
    this.epoch++; // invalidate any in-flight socket callbacks
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      try { this.socket.close(1000, "client disconnect"); } catch {}
      this.socket = undefined;
    }
    this.setStatus("disconnected");
  }
}
