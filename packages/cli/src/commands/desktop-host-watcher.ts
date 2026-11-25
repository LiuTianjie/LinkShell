import WebSocket from "ws";
import { localWebSocket } from "@linkshell/host/local-transport";
import {
  agentInfoSchema,
  gatewayStatusSchema,
  machineInfoSchema,
  type GatewayStatus,
  type MachineInfo,
} from "@linkshell/wire";

const MAX_CONTROL_PAYLOAD = 8 * 1024 * 1024;
const BACKOFF_MS = [500, 1_000, 2_000, 3_000] as const;

export interface HostLiveState {
  machine: MachineInfo;
  gateway: GatewayStatus;
  accessPassword?: boolean;
}

export interface HostWatcherCallbacks {
  onStateChange(): void;
  onPairingDone(device: { id: string; name: string }): void;
}

/**
 * Single persistent control connection from the Workspace Sidecar to the local Host socket.
 * Replaces 5s/30s/60s polling with millisecond push updates driven by Host JSON-RPC notifications
 * (`machine.changed`, `gateway.changed`, `agent.changed`, `pairing.done`).
 *
 * Ref-counted by active SSE subscribers so tests and idle sidecars never hold unused sockets.
 */
export class HostControlWatcher {
  private socket?: WebSocket;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private active = false;
  private live?: HostLiveState;
  private pendingMachine?: MachineInfo;
  private pendingGateway?: GatewayStatus;
  private pendingAccess?: boolean;
  private pendingAccessDone = false;
  private seq = 0;

  constructor(
    private readonly target: string,
    private readonly upstreams: Set<WebSocket>,
    private readonly callbacks: HostWatcherCallbacks,
  ) {}

  get isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.live);
  }

  currentLive(): HostLiveState | undefined {
    return this.live;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.active = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const sock = this.socket;
    this.socket = undefined;
    this.live = undefined;
    this.resetPending();
    if (sock) {
      this.upstreams.delete(sock);
      sock.terminate();
    }
  }

  /** Re-queries the live Host immediately, or wakes a sleeping reconnect timer right after start/restart. */
  nudge(): void {
    if (!this.active) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.requestRefresh(this.socket);
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt = 0;
    if (!this.socket) this.connect();
  }

  private resetPending(): void {
    this.pendingMachine = undefined;
    this.pendingGateway = undefined;
    this.pendingAccess = undefined;
    this.pendingAccessDone = false;
  }

  private requestRefresh(sock: WebSocket): void {
    const tag = ++this.seq;
    this.resetPending();
    try {
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-info-${tag}`, method: "machine.info", params: {} }));
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-gw-${tag}`, method: "gateway.status", params: {} }));
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-acc-${tag}`, method: "access.status", params: {} }));
    } catch {
      sock.terminate();
    }
  }

  private connect(): void {
    if (!this.active || this.socket) return;
    const sock = localWebSocket(this.target, 1_500, { maxPayload: MAX_CONTROL_PAYLOAD });
    this.socket = sock;
    this.upstreams.add(sock);

    const onDisconnect = () => {
      if (this.socket !== sock) return;
      this.socket = undefined;
      this.upstreams.delete(sock);
      const wasOnline = this.live !== undefined;
      this.live = undefined;
      this.resetPending();
      if (wasOnline) this.callbacks.onStateChange();
      if (!this.active) return;
      const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.connect();
      }, delay);
    };

    sock.on("open", () => {
      if (this.socket !== sock) { sock.terminate(); return; }
      this.attempt = 0;
      this.requestRefresh(sock);
    });

    sock.on("message", (raw) => {
      if (this.socket !== sock) return;
      this.handleMessage(raw.toString(), sock);
    });

    sock.on("error", () => {
      if (this.socket === sock) sock.terminate();
    });
    sock.on("close", onDisconnect);
  }

  private handleMessage(text: string, sock: WebSocket): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    // Response to one of our initial/refresh RPC queries.
    if (typeof msg.id === "string") {
      const result = msg.result;
      if (msg.id.startsWith("watch-info-")) {
        const parsed = machineInfoSchema.safeParse(result);
        if (parsed.success) {
          this.pendingMachine = parsed.data;
          this.maybeCommitPending();
        }
      } else if (msg.id.startsWith("watch-gw-")) {
        const parsed = gatewayStatusSchema.safeParse(result);
        if (parsed.success) {
          this.pendingGateway = parsed.data;
          this.maybeCommitPending();
        }
      } else if (msg.id.startsWith("watch-acc-")) {
        if (result && typeof result === "object" && typeof (result as { password?: unknown }).password === "boolean") {
          this.pendingAccess = (result as { password: boolean }).password;
        }
        this.pendingAccessDone = true;
        this.maybeCommitPending();
      }
      return;
    }

    // Host push notification.
    if (typeof msg.method !== "string") return;
    switch (msg.method) {
      case "machine.changed": {
        const parsed = machineInfoSchema.safeParse(msg.params);
        if (parsed.success && this.live) {
          this.live = { ...this.live, machine: parsed.data };
          this.callbacks.onStateChange();
        } else {
          try {
            sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-info-${++this.seq}`, method: "machine.info", params: {} }));
          } catch { /* Close handler will recover. */ }
        }
        break;
      }
      case "gateway.changed": {
        const parsed = gatewayStatusSchema.safeParse(msg.params);
        if (parsed.success && this.live) {
          this.live = { ...this.live, gateway: parsed.data };
          this.callbacks.onStateChange();
        } else {
          try {
            sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-gw-${++this.seq}`, method: "gateway.status", params: {} }));
          } catch { /* Close handler will recover. */ }
        }
        break;
      }
      case "agent.changed": {
        const agent = (msg.params as { agent?: unknown } | undefined)?.agent;
        const parsed = agentInfoSchema.safeParse(agent);
        if (parsed.success && this.live) {
          const existing = this.live.machine.agents;
          const idx = existing.findIndex((item) => item.id === parsed.data.id);
          const nextAgents =
            idx >= 0
              ? existing.map((item, i) => (i === idx ? parsed.data : item))
              : [...existing, parsed.data];
          this.live = { ...this.live, machine: { ...this.live.machine, agents: nextAgents } };
          this.callbacks.onStateChange();
        }
        break;
      }
      case "pairing.done": {
        const device = (msg.params as { device?: { id?: unknown; name?: unknown } } | undefined)?.device;
        if (device && typeof device.id === "string" && typeof device.name === "string") {
          this.callbacks.onPairingDone({ id: device.id, name: device.name });
          // Refresh gateway.status immediately so the newly paired device appears in snapshot.
          try {
            sock.send(JSON.stringify({ jsonrpc: "2.0", id: `watch-gw-${++this.seq}`, method: "gateway.status", params: {} }));
          } catch { /* Close handler will recover. */ }
        }
        break;
      }
    }
  }

  private maybeCommitPending(): void {
    const machine = this.pendingMachine ?? this.live?.machine;
    const gateway = this.pendingGateway ?? this.live?.gateway;
    if (!machine || !gateway) return;
    if (!this.live && (!this.pendingMachine || !this.pendingGateway)) return;
    const accessPassword = this.pendingAccessDone ? this.pendingAccess : this.live?.accessPassword;
    this.live = { machine, gateway, accessPassword };
    this.callbacks.onStateChange();
  }
}
