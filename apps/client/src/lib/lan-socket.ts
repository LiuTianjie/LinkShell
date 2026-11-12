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
 * Tries a direct LAN socket first (E2EE tunnel or local WS) when on local Wi-Fi,
 * and seamlessly falls back to the Gateway E2EE `TunnelSocket` when away from home.
 */
export class HybridLanGatewaySocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private active?: SocketLike;
  private lanTimer?: ReturnType<typeof setTimeout>;
  private switchedToGateway = false;

  constructor(options: {
    openLan: () => SocketLike;
    openGateway: () => SocketLike;
    lanTimeoutMs?: number;
    onRouteSelected?: (mode: ActiveTransportMode) => void;
  }) {
    const timeoutMs = options.lanTimeoutMs ?? DEFAULT_LAN_TIMEOUT_MS;
    let lanOpened = false;

    const startGatewayFallback = () => {
      if (this.switchedToGateway || lanOpened || this.readyState === CLOSED) return;
      this.switchedToGateway = true;
      clearTimeout(this.lanTimer);
      const prev = this.active;
      this.active = undefined;
      if (prev) {
        prev.onopen = null;
        prev.onmessage = null;
        prev.onerror = null;
        prev.onclose = null;
        try {
          prev.close();
        } catch {
          // Ignore LAN teardown errors during fallback.
        }
      }
      let gw: SocketLike;
      try {
        gw = options.openGateway();
      } catch (error) {
        this.readyState = CLOSED;
        this.onerror?.(error);
        this.onclose?.({ code: 4000, reason: "gateway_fallback_failed" });
        return;
      }
      this.active = gw;
      gw.onopen = (ev) => {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        options.onRouteSelected?.("gateway");
        this.onopen?.(ev);
      };
      gw.onmessage = (ev) => {
        this.onmessage?.(ev);
      };
      gw.onerror = (ev) => {
        this.onerror?.(ev);
      };
      gw.onclose = (ev) => {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.onclose?.(ev);
      };
    };

    let lan: SocketLike;
    try {
      lan = options.openLan();
    } catch {
      startGatewayFallback();
      return;
    }
    this.active = lan;
    this.lanTimer = setTimeout(() => {
      if (!lanOpened) startGatewayFallback();
    }, timeoutMs);

    lan.onopen = (ev) => {
      if (this.switchedToGateway || this.readyState !== CONNECTING) return;
      lanOpened = true;
      clearTimeout(this.lanTimer);
      this.readyState = OPEN;
      options.onRouteSelected?.("lan");
      this.onopen?.(ev);
    };
    lan.onmessage = (ev) => {
      if (!this.switchedToGateway) this.onmessage?.(ev);
    };
    lan.onerror = (ev) => {
      if (!lanOpened && !this.switchedToGateway) {
        startGatewayFallback();
        return;
      }
      if (!this.switchedToGateway) this.onerror?.(ev);
    };
    lan.onclose = (ev) => {
      if (!lanOpened && !this.switchedToGateway) {
        startGatewayFallback();
        return;
      }
      if (this.switchedToGateway || this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.onclose?.(ev);
    };
  }

  send(data: string): void {
    if (this.readyState !== OPEN || !this.active) return;
    this.active.send(data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearTimeout(this.lanTimer);
    const sock = this.active;
    this.active = undefined;
    if (sock) {
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
