import {
  idOf,
  openTunnel,
  publicIdentity,
  randomBytes,
  toBase64,
  type Identity,
  type PublicIdentity,
  type SecureChannel,
  type TunnelFrame,
} from "@linkshell/wire";
import { TunnelSocket, type SocketLike } from "@linkshell/client-core";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export const DEFAULT_LAN_TIMEOUT_MS = 1800;
export const DEFAULT_HAPPY_EYEBALLS_DELAY_MS = 250;

export type ActiveTransportMode = "lan" | "gateway";

/**
 * Direct LAN E2EE tunnel over a local WebSocket when the host speaks `TunnelFrame` envelopes,
 * verifying the computer's Ed25519 identity and sealing every RPC frame with XChaCha20-Poly1305.
 */
export class LanE2eeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private readonly ch = toBase64(randomBytes(12));
  private channel?: SecureChannel;
  private raw?: SocketLike;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    url: string,
    createSocket: (url: string) => SocketLike,
    device: Identity,
    machine: PublicIdentity,
    timeoutMs = 3500,
  ) {
    if (idOf(machine.signKey) !== machine.id) {
      queueMicrotask(() => this.fail("bad_identity"));
      return;
    }
    const opening = openTunnel(device, machine, this.ch);
    let ws: SocketLike;
    try {
      ws = createSocket(url);
    } catch (error) {
      queueMicrotask(() => this.fail(error instanceof Error ? error.message : String(error)));
      return;
    }
    this.raw = ws;
    this.timer = setTimeout(() => this.fail("lan_timeout"), timeoutMs);

    ws.onopen = () => {
      if (this.readyState !== CONNECTING) return;
      try {
        ws.send(
          JSON.stringify({
            from: publicIdentity(device),
            to: machine.id,
            frame: opening.hello,
          }),
        );
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    };

    ws.onmessage = (event) => {
      if (this.readyState === CLOSED) return;
      const text = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let parsed: { frame?: TunnelFrame } | TunnelFrame;
      try {
        parsed = JSON.parse(text) as { frame?: TunnelFrame } | TunnelFrame;
      } catch {
        this.fail("invalid_lan_frame");
        return;
      }
      const frame = "k" in parsed ? parsed : parsed.frame;
      if (!frame || frame.ch !== this.ch) return;
      if (frame.k === "welcome") {
        try {
          this.channel = opening.accept(frame);
        } catch (error) {
          this.fail(error instanceof Error ? error.message : String(error));
          return;
        }
        clearTimeout(this.timer);
        this.readyState = OPEN;
        this.onopen?.({});
      } else if (frame.k === "data") {
        if (!this.channel) return;
        try {
          const plain = this.channel.open(frame.box);
          this.onmessage?.({ data: plain });
        } catch {
          this.fail("lan_decrypt_failed");
        }
      } else if (frame.k === "refuse") {
        this.fail(frame.message || frame.code);
      } else if (frame.k === "close") {
        this.finish(1000, frame.reason ?? "closed");
      }
    };

    ws.onerror = (err) => {
      this.fail(err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : "lan_error");
    };

    ws.onclose = (ev) => {
      const reason = ev && typeof ev === "object" && "reason" in ev ? String((ev as { reason?: unknown }).reason ?? "closed") : "closed";
      this.finish(1000, reason);
    };
  }

  send(data: string): void {
    if (this.readyState !== OPEN || !this.channel || !this.raw) return;
    this.raw.send(JSON.stringify({ frame: { k: "data", ch: this.ch, box: this.channel.seal(data) } }));
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    if (this.readyState === OPEN && this.raw) {
      try {
        this.raw.send(JSON.stringify({ frame: { k: "close", ch: this.ch } }));
      } catch {
        // Ignore close write errors.
      }
    }
    this.finish(1000, "closed");
  }

  private fail(message: string): void {
    if (this.readyState === CLOSED) return;
    this.onerror?.({ message });
    this.finish(4000, message);
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearTimeout(this.timer);
    const ws = this.raw;
    this.raw = undefined;
    try {
      ws?.close();
    } catch {
      // Ignore
    }
    this.onclose?.({ code, reason });
  }
}

/**
 * RFC 8305 staggered Happy Eyeballs transport: dials the direct LAN socket at t = 0ms
 * and starts the Gateway E2EE `TunnelSocket` after a short stagger delay (250ms default)
 * if LAN has not yet opened. The first path to reach OPEN wins and immediately aborts the loser.
 */
export class HybridLanGatewaySocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private active?: SocketLike;
  private lanSocket?: SocketLike;
  private gatewaySocket?: SocketLike;
  private staggerTimer?: ReturnType<typeof setTimeout>;
  private lanTimeoutTimer?: ReturnType<typeof setTimeout>;
  private winner?: ActiveTransportMode;
  private lanDone = false;
  private gatewayDone = false;
  private gatewayStarted = false;
  private lastError?: unknown;

  constructor(options: {
    openLan: () => SocketLike;
    openGateway: () => SocketLike;
    lanTimeoutMs?: number;
    happyEyeballsDelayMs?: number;
    onRouteSelected?: (mode: ActiveTransportMode) => void;
  }) {
    const lanTimeoutMs = Math.max(0, options.lanTimeoutMs ?? DEFAULT_LAN_TIMEOUT_MS);
    const staggerMs = Math.min(
      lanTimeoutMs,
      Math.max(0, options.happyEyeballsDelayMs ?? DEFAULT_HAPPY_EYEBALLS_DELAY_MS),
    );

    const detachAndClose = (sock: SocketLike | undefined) => {
      if (!sock) return;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        // Ignore teardown errors on losing/aborted sockets.
      }
    };

    const clearTimers = () => {
      if (this.staggerTimer !== undefined) {
        clearTimeout(this.staggerTimer);
        this.staggerTimer = undefined;
      }
      if (this.lanTimeoutTimer !== undefined) {
        clearTimeout(this.lanTimeoutTimer);
        this.lanTimeoutTimer = undefined;
      }
    };

    const failIfAllExhausted = (fallbackReason: string) => {
      if (this.winner || this.readyState === CLOSED) return;
      if (!this.lanDone || !this.gatewayDone) return;
      clearTimers();
      this.readyState = CLOSED;
      if (this.lastError !== undefined) {
        this.onerror?.(this.lastError);
      }
      this.onclose?.({ code: 4000, reason: fallbackReason });
    };

    const electWinner = (mode: ActiveTransportMode, sock: SocketLike, ev: unknown) => {
      if (this.winner || this.readyState !== CONNECTING) {
        detachAndClose(sock);
        return;
      }
      this.winner = mode;
      clearTimers();
      const loser = mode === "lan" ? this.gatewaySocket : this.lanSocket;
      if (mode === "lan") this.gatewaySocket = undefined;
      else this.lanSocket = undefined;
      detachAndClose(loser);

      this.active = sock;
      this.readyState = OPEN;
      options.onRouteSelected?.(mode);
      this.onopen?.(ev);
    };

    const startGateway = () => {
      if (this.gatewayStarted || this.winner || this.readyState === CLOSED) return;
      this.gatewayStarted = true;
      if (this.staggerTimer !== undefined) {
        clearTimeout(this.staggerTimer);
        this.staggerTimer = undefined;
      }
      let gw: SocketLike;
      try {
        gw = options.openGateway();
      } catch (error) {
        this.gatewayDone = true;
        this.lastError = error;
        failIfAllExhausted("gateway_fallback_failed");
        return;
      }
      this.gatewaySocket = gw;

      gw.onopen = (ev) => {
        electWinner("gateway", gw, ev);
      };
      gw.onmessage = (ev) => {
        if (this.winner === "gateway" && this.active === gw) this.onmessage?.(ev);
      };
      gw.onerror = (ev) => {
        if (this.winner === "gateway" && this.active === gw) {
          this.onerror?.(ev);
          return;
        }
        if (this.winner || this.readyState === CLOSED) return;
        this.lastError = ev;
        if (!this.gatewayDone) {
          this.gatewayDone = true;
          this.gatewaySocket = undefined;
          detachAndClose(gw);
          failIfAllExhausted("gateway_error");
        }
      };
      gw.onclose = (ev) => {
        if (this.winner === "gateway" && this.active === gw) {
          if (this.readyState === CLOSED) return;
          this.readyState = CLOSED;
          this.active = undefined;
          this.gatewaySocket = undefined;
          this.onclose?.(ev);
          return;
        }
        if (this.winner || this.readyState === CLOSED) return;
        this.gatewayDone = true;
        this.gatewaySocket = undefined;
        failIfAllExhausted("gateway_closed");
      };
    };

    const abortPendingLan = () => {
      if (this.lanDone || this.winner || this.readyState === CLOSED) return;
      this.lanDone = true;
      if (this.lanTimeoutTimer !== undefined) {
        clearTimeout(this.lanTimeoutTimer);
        this.lanTimeoutTimer = undefined;
      }
      const pending = this.lanSocket;
      this.lanSocket = undefined;
      detachAndClose(pending);
      if (!this.gatewayStarted) {
        startGateway();
      } else {
        failIfAllExhausted("lan_timeout");
      }
    };

    let lan: SocketLike;
    try {
      lan = options.openLan();
    } catch (error) {
      this.lanDone = true;
      this.lastError = error;
      startGateway();
      return;
    }
    this.lanSocket = lan;

    // Staggered Happy Eyeballs: start Gateway after 250ms if LAN is still negotiating,
    // while keeping LAN alive until lanTimeoutMs so a slower LAN handshake can still win.
    this.staggerTimer = setTimeout(() => {
      this.staggerTimer = undefined;
      startGateway();
    }, staggerMs);

    this.lanTimeoutTimer = setTimeout(() => {
      this.lanTimeoutTimer = undefined;
      abortPendingLan();
    }, lanTimeoutMs);

    lan.onopen = (ev) => {
      electWinner("lan", lan, ev);
    };
    lan.onmessage = (ev) => {
      if (this.winner === "lan" && this.active === lan) this.onmessage?.(ev);
    };
    lan.onerror = (ev) => {
      if (this.winner === "lan" && this.active === lan) {
        this.onerror?.(ev);
        return;
      }
      if (this.winner || this.readyState === CLOSED) return;
      this.lastError = ev;
      if (!this.lanDone) {
        abortPendingLan();
      }
    };
    lan.onclose = (ev) => {
      if (this.winner === "lan" && this.active === lan) {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.active = undefined;
        this.lanSocket = undefined;
        this.onclose?.(ev);
        return;
      }
      if (this.winner || this.readyState === CLOSED) return;
      this.lanDone = true;
      this.lanSocket = undefined;
      if (this.lanTimeoutTimer !== undefined) {
        clearTimeout(this.lanTimeoutTimer);
        this.lanTimeoutTimer = undefined;
      }
      if (!this.gatewayStarted) {
        startGateway();
      } else {
        failIfAllExhausted("lan_closed");
      }
    };
  }

  send(data: string): void {
    if (this.readyState !== OPEN || !this.active) return;
    this.active.send(data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this.staggerTimer !== undefined) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = undefined;
    }
    if (this.lanTimeoutTimer !== undefined) {
      clearTimeout(this.lanTimeoutTimer);
      this.lanTimeoutTimer = undefined;
    }
    const sockets = new Set<SocketLike>();
    if (this.active) sockets.add(this.active);
    if (this.lanSocket) sockets.add(this.lanSocket);
    if (this.gatewaySocket) sockets.add(this.gatewaySocket);
    this.active = undefined;
    this.lanSocket = undefined;
    this.gatewaySocket = undefined;
    for (const sock of sockets) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        // Ignore
      }
    }
    this.onclose?.({ code: 1000, reason: "closed" });
  }
}

export { TunnelSocket };
