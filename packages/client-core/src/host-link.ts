import {
  RPC_METHOD_NOT_FOUND,
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

/** `locked`: connected, but the computer has an access password and this device hasn't given it (`unlock`). */
export type LinkStatus = "idle" | "connecting" | "online" | "locked" | "reconnecting" | "stopped";

export interface HostLinkOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** How often to check the connection is alive; 0 disables. */
  heartbeatMs?: number;
  /**
   * This client loads pictures in a session when it shows them
   * (`sessions.image`), so the host sends references instead of the data.
   */
  lazyImages?: boolean;
  /** Keeps the token an unlock returns, so later connections to this computer don't ask for the password again. */
  accessToken?: { load(): string | undefined; save(token: string | undefined): void };
}

const OPEN = 1;
const STUCK_SOCKET_MS = 5_000;
const MIN_CALL_EXECUTION_MS = 15_000;

/** Maps raw OS and WebSocket transport errors to user-facing Chinese messages. */
export function translateSocketError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "连接已断开";
  if (/No WebSocket implementation available/i.test(trimmed)) return "当前环境不支持 WebSocket 连接";
  if (/ECONNREFUSED|connection refused/i.test(trimmed)) return "连接被拒绝，请确认电脑上的 LinkShell 正在运行";
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out|lan_timeout/i.test(trimmed)) return "连接电脑超时，请检查网络连接";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(trimmed)) return "找不到电脑的网络地址，请检查网络设置";
  if (/ECONNRESET|ECONNABORTED|EPIPE|socket hang up|connection reset/i.test(trimmed)) return "网络连接意外中断";
  if (
    /Network request failed|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|failed to connect|Software caused connection abort|Internet connection appears to be offline|Socket is not connected/i.test(
      trimmed,
    )
  ) {
    return "网络请求失败，请检查网络连接";
  }
  if (/WebSocket (is|was) closed|WebSocket is already in CLOSING or CLOSED|network connection was lost/i.test(trimmed)) {
    return "连接已断开";
  }
  return trimmed;
}

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
  private readonly restoredListeners = new Set<(summary: SessionSummary) => void>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  lastError?: string;
  /** Set while away (`resumeLatest`): the next subscriptions start at the latest turns. */
  private latest = false;
  private openedAt = 0;
  private probePromise?: Promise<boolean>;
  /** Used when no `accessToken` store is given: lasts as long as this link. */
  private heldToken?: string;

  constructor(private readonly options: HostLinkOptions) {}

  get url(): string {
    return this.options.url;
  }

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
    this.probePromise = undefined;
    this.peer?.close("连接已停止");
    this.socket?.close();
    this.socket = undefined;
    for (const wake of this.waiters) wake();
  }

  /** Reconnects now (e.g. the app came back to the foreground, or a liveness probe failed). */
  reconnectNow(force = false): void {
    if (this.statusValue === "stopped") return;
    if (!force && (this.statusValue === "online" || this.statusValue === "locked")) return;
    // A connection being made right now is left to finish unless forced: starting another would
    // abandon it half open (on the computer too, which keeps a few channels per device and drops
    // the oldest). One that has been at it for > 5 s is stuck (made before a suspension).
    if (!force && this.socket && Date.now() - this.openedAt < STUCK_SOCKET_MS) return;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.probePromise = undefined;
    if (this.socket) {
      const stuck = this.socket;
      this.socket = undefined;
      this.peer?.close("正在重新连接");
      stuck.onclose = null;
      stuck.close();
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.attempt = 0;
    this.open();
  }

  /**
   * Checks an online connection still answers (the app came back to the foreground): concurrent
   * checks share one request, and a socket that fails to answer reconnects immediately.
   */
  probe(timeoutMs = 2500): Promise<boolean> {
    const socket = this.socket;
    if (this.statusValue !== "online" || !socket || !this.peer) return Promise.resolve(false);
    if (this.probePromise) return this.probePromise;
    const active = this.peer
      .request("machine.info", {}, timeoutMs)
      .then(
        () => true,
        () => {
          if (this.socket === socket && this.statusValue !== "stopped") this.reconnectNow(true);
          return false;
        },
      )
      .finally(() => {
        if (this.probePromise === active) this.probePromise = undefined;
      });
    this.probePromise = active;
    return active;
  }

  /**
   * The app was away (in the background): sessions restored on the next connection start at
   * their latest turns instead of replaying everything they missed, which loads as history
   * when scrolled to. Older hosts ignore it and catch up as before.
   */
  resumeLatest(on = true): void {
    this.latest = on;
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>> {
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    const deadline = Date.now() + limit;
    // Interactive authentication can wait for the user indefinitely, while an
    // offline connection still needs a bounded wait before reporting failure.
    await this.waitOnline(limit > 0 ? limit : this.options.requestTimeoutMs || 30_000);
    if (this.statusValue === "locked") throw RpcError.app("locked", "请先输入这台电脑的访问密码");
    if (!this.peer || this.statusValue !== "online") {
      throw RpcError.app("offline", "没有连上电脑");
    }
    // Even if reconnecting consumed most of `waitOnline`, leave enough budget for the RPC itself.
    const requestTimeout = limit === 0 ? 0 : Math.max(Math.min(limit, MIN_CALL_EXECUTION_MS), deadline - Date.now());
    return this.peer.request<MethodResult<M>>(method, params, requestTimeout).catch((error: unknown) => {
      // A method this app knows and the computer doesn't: what to do about it, not the RPC error.
      if (error instanceof RpcError && error.code === RPC_METHOD_NOT_FOUND) {
        throw RpcError.app("host_outdated", "电脑上的 LinkShell 比 App 旧，还不支持这个功能：请更新电脑上的 LinkShell", { method });
      }
      throw error;
    });
  }

  /** A session's subscription was restored after a (re)connect: its backlog has been delivered. */
  onRestored(listener: (summary: SessionSummary) => void): () => void {
    this.restoredListeners.add(listener);
    return () => this.restoredListeners.delete(listener);
  }

  /**
   * Streams a session's events from `cursor()` on, now and after every
   * reconnect. Resolves undefined when the link is down: the subscription is
   * made when it comes back, and `onRestored` says so.
   */
  subscribe(sessionId: string, cursor: () => number): Promise<SessionSummary | undefined> {
    const subscription = { cursor };
    this.subscriptions.set(sessionId, subscription);
    if (this.statusValue !== "online") return Promise.resolve(undefined);
    const socket = this.socket;
    return this.sendSubscribe(sessionId).then((result) => {
      if (!result && socket && this.socket === socket && this.subscriptions.get(sessionId) === subscription) void this.restoreLater(sessionId, socket);
      return result?.session;
    });
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
    if (this.statusValue === "online" || this.statusValue === "locked" || this.statusValue === "stopped") return Promise.resolve();
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
      this.scheduleReconnect(translateSocketError(error instanceof Error ? error.message : String(error)));
      return;
    }
    this.socket = socket;
    this.openedAt = Date.now();
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
      if (typeof message === "string" && message) socketError = translateSocketError(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      peer.close("连接已断开");
      this.socket = undefined;
      this.probePromise = undefined;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.statusValue !== "stopped") this.scheduleReconnect(socketError ?? "连接已断开");
    };
  }

  private async onOpen(socket: SocketLike): Promise<void> {
    if (this.socket !== socket) return;
    // Watched from the start: restoring a long backlog mustn't leave a dead socket unnoticed.
    const heartbeat = this.options.heartbeatMs ?? 25_000;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (heartbeat > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.socket !== socket) return;
        this.peer?.request("machine.info", {}, 10_000).catch(() => {
          // The socket looks open but nothing answers (common after a network change).
          if (this.socket === socket) socket.close();
        });
      }, heartbeat);
    }
    // Hosts without a password (and older hosts) don't say `locked`: nothing changes for them.
    let info: { locked?: boolean } | undefined;
    try {
      info = await this.peer?.request<{ locked?: boolean }>("machine.info", {}, 10_000);
    } catch (error) {
      if (this.socket !== socket) return;
      if (!(error instanceof RpcError && error.code === RPC_METHOD_NOT_FOUND)) {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }
        this.peer?.close("电脑没有响应");
        this.socket = undefined;
        socket.onclose = null;
        socket.close();
        this.scheduleReconnect(error instanceof RpcError ? translateSocketError(error.message) : "电脑没有响应");
        return;
      }
    }
    if (this.socket !== socket) return;
    // Reset backoff only once `machine.info` proves the end-to-end RPC channel works.
    this.attempt = 0;
    if (info?.locked) {
      const token = this.loadToken();
      const unlocked = token ? await this.peer?.request<{ token: string }>("access.unlock", { token }, 10_000).then((result) => result, () => undefined) : undefined;
      if (this.socket !== socket) return;
      if (!unlocked) {
        if (token) this.saveToken(undefined);
        this.setStatus("locked", "这台电脑设置了访问密码");
        for (const wake of [...this.waiters]) wake();
        return;
      }
      this.saveToken(unlocked.token);
    }
    await this.goOnline(socket);
  }

  /**
   * Gives the computer's access password (status `locked`). A wrong one throws (`wrong_password`,
   * or `busy` after too many tries) and the link stays locked.
   */
  async unlock(password: string): Promise<void> {
    const socket = this.socket;
    if (this.statusValue !== "locked" || !socket || !this.peer) throw RpcError.app("offline", "没有连上电脑");
    const result = await this.peer.request<{ token: string }>("access.unlock", { password }, 20_000);
    if (this.socket !== socket) return;
    this.saveToken(result.token);
    await this.goOnline(socket);
  }

  private loadToken(): string | undefined {
    return this.options.accessToken ? this.options.accessToken.load() : this.heldToken;
  }

  private saveToken(token: string | undefined): void {
    if (this.options.accessToken) this.options.accessToken.save(token);
    else this.heldToken = token;
  }

  private async goOnline(socket: SocketLike): Promise<void> {
    // Online first, so calls made now go through; anyone waiting is woken once every open
    // session is restored, so nothing they render is missing what happened while offline.
    this.setStatus("online", "");
    await Promise.all([...this.subscriptions.keys()].map((sessionId) => this.restore(sessionId, socket)));
    if (this.socket !== socket) return;
    this.latest = false;
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.onlineListeners) listener();
  }

  /**
   * Subscribes again after a (re)connect; one that fails is tried twice more, then left to
   * `restoreLater` so the reconnect isn't held up by it.
   */
  private async restore(sessionId: string, socket: SocketLike): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      if (this.socket !== socket || this.subscriptions.get(sessionId) !== subscription) return;
      const result = await this.sendSubscribe(sessionId);
      if (this.socket !== socket || this.subscriptions.get(sessionId) !== subscription) return;
      if (result?.session) {
        // Its backlog has arrived — also for a session opened while the link was down, which nothing else answers.
        for (const listener of this.restoredListeners) listener(result.session);
        return;
      }
    }
    void this.restoreLater(sessionId, socket);
  }

  /**
   * Keeps trying, less and less often, for as long as this connection lasts: given up on, the
   * session would show nothing new until it was closed and opened again.
   */
  private async restoreLater(sessionId: string, socket: SocketLike): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 5000 * 2 ** attempt)));
      if (this.socket !== socket || this.subscriptions.get(sessionId) !== subscription) return;
      const result = await this.sendSubscribe(sessionId);
      if (this.socket !== socket || this.subscriptions.get(sessionId) !== subscription) return;
      if (result?.session) {
        for (const listener of this.restoredListeners) listener(result.session);
        return;
      }
    }
  }

  private sendSubscribe(sessionId: string) {
    const subscription = this.subscriptions.get(sessionId);
    const peer = this.peer;
    if (!subscription || !peer) return Promise.resolve(undefined);
    const current = () => this.peer === peer && this.subscriptions.get(sessionId) === subscription;
    return peer
      .request<MethodResult<"sessions.subscribe">>("sessions.subscribe", {
        sessionId,
        fromSeq: subscription.cursor(),
        lazyImages: this.options.lazyImages,
        latest: this.latest || undefined,
      })
      // A closed and reopened conversation owns a new subscription: an older response
      // must not make its unfinished history appear ready.
      .then((result) => current() ? result : undefined)
      .catch((error: unknown) => {
        // Gone on the host (deleted meanwhile): nothing to restore, and nothing to retry.
        if (current() && error instanceof RpcError && error.appCode === "not_found") {
          this.subscriptions.delete(sessionId);
          // Archived sessions and older list pages are not covered by refresh's first page.
          this.onNotification("session.removed", { sessionId });
        }
        return undefined;
      });
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
