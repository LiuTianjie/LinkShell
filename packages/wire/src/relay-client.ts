import { gatewayChallengeMessage, publicIdentity, sign, type Identity, type PublicIdentity } from "./crypto.js";
import {
  serverFrameSchema,
  tunnelFrameSchema,
  type ClientFrame,
  type PeerRole,
  type RelayEvents,
  type RelayMethod,
  type RelayMethods,
  type TunnelFrame,
} from "./relay.js";

// One connection from a machine or device to a v2 gateway: authenticates,
// reconnects, makes control requests and carries tunnel frames. Runs on
// Node (ws) and in React Native (WebSocket) alike.

export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RelayStatus = "connecting" | "online" | "offline" | "stopped";

export interface RelayClientOptions {
  url: string;
  identity: Identity;
  role: PeerRole;
  name: string;
  platform?: string;
  /** Account token, fetched fresh for each connection. */
  token?: () => Promise<string | undefined> | string | undefined;
  createSocket: (url: string) => RelaySocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
}

export class RelayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OPEN = 1;

export class RelayClient {
  private socket?: RelaySocket;
  private statusValue: RelayStatus = "offline";
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly statusListeners = new Set<(status: RelayStatus, error?: { code: string; message: string }) => void>();
  private readonly frameListeners = new Set<(from: PublicIdentity, via: "paired" | "account", frame: TunnelFrame) => void>();
  private readonly undeliverableListeners = new Set<(to: string, reason: string) => void>();
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private readonly waiters = new Set<() => void>();
  /** Account the gateway recognised on the last connection. */
  account?: { userId: string; email?: string };
  lastError?: { code: string; message: string };

  constructor(private readonly options: RelayClientOptions) {}

  get status(): RelayStatus {
    return this.statusValue;
  }

  get identity(): PublicIdentity {
    return publicIdentity(this.options.identity);
  }

  onStatus(listener: (status: RelayStatus, error?: { code: string; message: string }) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onFrame(listener: (from: PublicIdentity, via: "paired" | "account", frame: TunnelFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onUndeliverable(listener: (to: string, reason: string) => void): () => void {
    this.undeliverableListeners.add(listener);
    return () => this.undeliverableListeners.delete(listener);
  }

  on<N extends keyof RelayEvents>(name: N, listener: (data: RelayEvents[N]) => void): () => void {
    let set = this.eventListeners.get(name);
    if (!set) this.eventListeners.set(name, (set = new Set()));
    const entry = listener as (data: unknown) => void;
    set.add(entry);
    return () => set.delete(entry);
  }

  start(): void {
    if (this.statusValue === "connecting" || this.statusValue === "online") return;
    this.open();
  }

  stop(): void {
    this.setStatus("stopped");
    clearTimeout(this.timer);
    this.socket?.close(1000, "stopped");
    this.socket = undefined;
    this.failPending("stopped");
    for (const wake of this.waiters) wake();
  }

  /** Reconnect now instead of waiting out the backoff (app foregrounded, network back). */
  reconnectNow(): void {
    if (this.statusValue === "stopped" || this.statusValue === "online" || this.statusValue === "connecting") return;
    clearTimeout(this.timer);
    this.attempt = 0;
    this.open();
  }

  /** Connects afresh so the gateway sees the current account (after a login or logout). */
  reauthenticate(): void {
    if (this.statusValue === "stopped") return;
    clearTimeout(this.timer);
    this.attempt = 0;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "signing in again");
    this.failPending("connection closed");
    this.open();
  }

  /** Waits (up to `timeoutMs`) for the gateway connection. */
  waitOnline(timeoutMs: number): Promise<boolean> {
    if (this.statusValue === "online") return Promise.resolve(true);
    if (this.statusValue === "stopped") return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.statusValue === "online");
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  async request<M extends RelayMethod>(method: M, params: RelayMethods[M]["params"], timeoutMs?: number): Promise<RelayMethods[M]["result"]> {
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
    if (!(await this.waitOnline(limit))) throw new RelayRequestError("offline", "not connected to the gateway");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayRequestError("timeout", `${method} timed out`));
      }, limit);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.sendFrame({ t: "req", id, method, params });
    });
  }

  /** Sends a tunnel frame to a peer. Returns false when not connected. */
  send(to: string, frame: TunnelFrame): boolean {
    if (this.statusValue !== "online") return false;
    return this.sendFrame({ t: "to", to, d: JSON.stringify(frame) });
  }

  // ── internals ─────────────────────────────────────────────────────

  private sendFrame(frame: ClientFrame): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private setStatus(status: RelayStatus, error?: { code: string; message: string }): void {
    if (error) this.lastError = error;
    if (status === "online") this.lastError = undefined;
    if (this.statusValue === status && !error) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status, error);
    if (status === "online" || status === "stopped") for (const wake of this.waiters) wake();
  }

  private failPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RelayRequestError("offline", reason));
      this.pending.delete(id);
    }
  }

  private open(): void {
    this.setStatus("connecting");
    let socket: RelaySocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (error) {
      this.scheduleReconnect({ code: "connect_failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.socket = socket;
    let fatal: { code: string; message: string } | undefined;
    socket.onmessage = (event) => {
      let frame;
      try {
        const parsed = serverFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        frame = parsed.data;
      } catch {
        return;
      }
      switch (frame.t) {
        case "challenge":
          void this.authenticate(frame.nonce);
          return;
        case "ready":
          this.attempt = 0;
          this.account = frame.userId ? { userId: frame.userId, email: frame.email } : undefined;
          this.setStatus("online");
          return;
        case "res": {
          const entry = this.pending.get(frame.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(frame.id);
          if (frame.error) entry.reject(new RelayRequestError(frame.error.code, frame.error.message));
          else entry.resolve(frame.result);
          return;
        }
        case "event":
          for (const listener of this.eventListeners.get(frame.name) ?? []) listener(frame.data);
          return;
        case "from": {
          let inner: TunnelFrame;
          try {
            const parsed = tunnelFrameSchema.safeParse(JSON.parse(frame.d));
            if (!parsed.success) return;
            inner = parsed.data;
          } catch {
            return;
          }
          for (const listener of this.frameListeners) listener(frame.from, frame.via, inner);
          return;
        }
        case "undeliverable":
          for (const listener of this.undeliverableListeners) listener(frame.to, frame.reason);
          return;
        case "error":
          fatal = { code: frame.code, message: frame.message };
          return;
        case "pong":
          return;
      }
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failPending("connection closed");
      if (this.statusValue === "stopped") return;
      // Another connection with our identity took over: don't fight it.
      if (event.code === 4000) {
        this.setStatus("offline", { code: "replaced", message: "connected elsewhere with this identity" });
        return;
      }
      this.scheduleReconnect(fatal ?? { code: "disconnected", message: event.reason || "connection lost" });
    };
  }

  private async authenticate(nonce: string): Promise<void> {
    let token: string | undefined;
    try {
      token = (await this.options.token?.()) ?? undefined;
    } catch {
      token = undefined;
    }
    this.sendFrame({
      t: "auth",
      role: this.options.role,
      identity: publicIdentity(this.options.identity),
      signature: sign(this.options.identity, gatewayChallengeMessage(nonce)),
      name: this.options.name.slice(0, 120),
      platform: this.options.platform,
      token,
    });
  }

  private scheduleReconnect(error: { code: string; message: string }): void {
    this.setStatus("offline", error);
    const min = this.options.minBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    this.timer = setTimeout(() => this.open(), delay);
  }
}
