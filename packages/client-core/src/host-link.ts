import {
  RpcError,
  RpcPeer,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type SessionEvent,
  type SessionSummary,
  type NotificationName,
  type NotificationParams,
} from "@linkshell/wire";

/** The subset of the WebSocket API LinkShell needs (browser, React Native and `ws` all fit). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type LinkStatus = "idle" | "connecting" | "online" | "reconnecting" | "stopped";

export interface HostLinkOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** How often to check the connection is alive; 0 disables. */
  heartbeatMs?: number;
}

const OPEN = 1;

function defaultSocket(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new Error("No WebSocket implementation available");
  return new Ctor(url);
}

interface Subscription {
  /** The last seq the client has, read at (re)subscribe time. */
  cursor: () => number;
}

/**
 * One connection to a LinkShell host. Reconnects with backoff, re-subscribes
 * every open session from the last seq it has, and holds calls made while
 * offline until the link is back (or they time out).
 */
export class HostLink {
  private socket?: SocketLike;
  private peer?: RpcPeer;
  private statusValue: LinkStatus = "idle";
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly waiters = new Set<() => void>();
  private readonly statusListeners = new Set<(status: LinkStatus, error?: string) => void>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private readonly summaryListeners = new Set<(summary: SessionSummary) => void>();
  private readonly onlineListeners = new Set<() => void>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  lastError?: string;

  constructor(private readonly options: HostLinkOptions) {}

  get status(): LinkStatus {
    return this.statusValue;
  }

  onStatus(listener: (status: LinkStatus, error?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onSummary(listener: (summary: SessionSummary) => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  /** Any other host notification (terminal output, …). */
  on<N extends NotificationName>(name: N, listener: (params: NotificationParams<N>) => void): () => void {
    let set = this.notificationListeners.get(name);
    if (!set) this.notificationListeners.set(name, (set = new Set()));
    const entry = listener as (params: unknown) => void;
    set.add(entry);
    return () => set.delete(entry);
  }

  /** Called every time the link (re)connects, after subscriptions are restored. */
  onOnline(listener: () => void): () => void {
    this.onlineListeners.add(listener);
    return () => this.onlineListeners.delete(listener);
  }

  start(): void {
    if (this.statusValue === "connecting" || this.statusValue === "online") return;
    this.open();
  }

  stop(): void {
    this.setStatus("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.peer?.close("stopped");
    this.socket?.close();
    this.socket = undefined;
    for (const wake of this.waiters) wake();
  }

  /** Reconnects now (e.g. the app came back to the foreground). */
  reconnectNow(): void {
    if (this.statusValue === "stopped") return;
    if (this.statusValue === "online") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.attempt = 0;
    this.open();
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>> {
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    const deadline = Date.now() + limit;
    await this.waitOnline(limit);
    if (!this.peer || this.statusValue !== "online") {
      throw RpcError.app("offline", "Not connected to the computer", { code: "offline" });
    }
    return this.peer.request<MethodResult<M>>(method, params, Math.max(1000, deadline - Date.now()));
  }

  /** Streams a session's events from `cursor()` on, now and after every reconnect. */
  subscribe(sessionId: string, cursor: () => number): Promise<SessionSummary | undefined> {
    this.subscriptions.set(sessionId, { cursor });
    if (this.statusValue !== "online") return Promise.resolve(undefined);
    return this.sendSubscribe(sessionId).then((result) => result?.session);
  }

  unsubscribe(sessionId: string): void {
    if (!this.subscriptions.delete(sessionId)) return;
    if (this.statusValue === "online") void this.peer?.request("sessions.unsubscribe", { sessionId }).catch(() => {});
  }

  // ── internals ──────────────────────────────────────────────────────

  private setStatus(status: LinkStatus, error?: string): void {
    if (error !== undefined) this.lastError = error;
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status, error);
  }

  private waitOnline(timeoutMs: number): Promise<void> {
    if (this.statusValue === "online" || this.statusValue === "stopped") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  private open(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = (this.options.createSocket ?? defaultSocket)(this.options.url);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    const peer = new RpcPeer({
      send: (text) => {
        if (socket.readyState === OPEN) socket.send(text);
      },
      onNotification: (method, params) => this.onNotification(method, params),
      requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
    });
    this.peer = peer;
    socket.onmessage = (event) => {
      const data = event.data;
      peer.receive(typeof data === "string" ? data : String(data));
    };
    let socketError: string | undefined;
    socket.onopen = () => void this.onOpen(socket);
    socket.onerror = (event) => {
      // Browsers hide the reason; React Native and `ws` put it on `message`.
      const message = (event as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message) socketError = message;
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      peer.close("connection closed");
      this.socket = undefined;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.statusValue !== "stopped") this.scheduleReconnect(socketError ?? "连接已断开");
    };
  }

  private async onOpen(socket: SocketLike): Promise<void> {
    if (this.socket !== socket) return;
    this.attempt = 0;
    // Restore every open session before announcing we're online, so nothing
    // rendered in between is missing the events that happened while offline.
    this.setStatus("online", "");
    await Promise.all([...this.subscriptions.keys()].map((sessionId) => this.sendSubscribe(sessionId)));
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.onlineListeners) listener();
    const heartbeat = this.options.heartbeatMs ?? 25_000;
    if (heartbeat > 0) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.socket !== socket || this.statusValue !== "online") return;
        this.peer?.request("machine.info", {}, 10_000).catch(() => {
          // The socket looks open but nothing answers (common after a network change).
          if (this.socket === socket) socket.close();
        });
      }, heartbeat);
    }
  }

  private sendSubscribe(sessionId: string) {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription || !this.peer) return Promise.resolve(undefined);
    return this.peer
      .request<MethodResult<"sessions.subscribe">>("sessions.subscribe", { sessionId, fromSeq: subscription.cursor() })
      .catch(() => undefined);
  }

  private scheduleReconnect(reason: string): void {
    if (this.statusValue === "stopped") return;
    this.setStatus("reconnecting", reason);
    const min = this.options.minBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "session.event") {
      for (const listener of this.eventListeners) listener(params as SessionEvent);
    } else if (method === "session.summary") {
      const summary = (params as { session?: SessionSummary }).session;
      if (summary) for (const listener of this.summaryListeners) listener(summary);
    }
    for (const listener of this.notificationListeners.get(method) ?? []) listener(params);
  }
}
