import { openTunnel, randomBytes, toBase64, type Identity, type PublicIdentity, type RelayClient, type SecureChannel } from "@linkshell/wire";
import type { SocketLike } from "./host-link.js";

// A SocketLike that is an end-to-end encrypted channel to one machine through
// a v2 gateway. HostLink uses it exactly like a WebSocket, so reconnects and
// catch-up work the same whether the phone is on the LAN or across the world.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export class TunnelSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private readonly ch = toBase64(randomBytes(12));
  private channel?: SecureChannel;
  private readonly cleanup: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly relay: RelayClient,
    device: Identity,
    private readonly machine: PublicIdentity,
  ) {
    const opening = openTunnel(device, machine, this.ch);
    this.cleanup.push(
      relay.onFrame((from, _via, frame) => {
        if (from.id !== machine.id || frame.ch !== this.ch) return;
        switch (frame.k) {
          case "welcome":
            try {
              this.channel = opening.accept(frame);
            } catch (error) {
              this.fail(error instanceof Error ? error.message : String(error));
              return;
            }
            clearTimeout(this.timer);
            this.readyState = OPEN;
            this.onopen?.({});
            return;
          case "data": {
            if (!this.channel) return;
            let text: string;
            try {
              text = this.channel.open(frame.box);
            } catch {
              this.fail("the connection was tampered with");
              return;
            }
            this.onmessage?.({ data: text });
            return;
          }
          case "refuse":
            this.fail(frame.code === "not_paired" ? "这台电脑不再信任这台设备，请重新配对" : frame.message, frame.code);
            return;
          case "close":
            this.finish(1000, frame.reason ?? "closed");
            return;
          default:
            return;
        }
      }),
      relay.onUndeliverable((to, reason) => {
        if (to !== machine.id) return;
        this.fail(reason === "offline" ? "电脑不在线" : reason === "not_allowed" ? "没有权限连接这台电脑" : reason, reason);
      }),
      relay.onStatus((status) => {
        if (status === "offline" || status === "stopped") this.fail("与网关的连接断开了");
      }),
    );
    // Wait for the gateway, then say hello.
    void relay.waitOnline(HANDSHAKE_TIMEOUT_MS).then((online) => {
      if (this.readyState !== CONNECTING) return;
      if (!online) {
        this.fail(relay.lastError?.message ?? "连不上网关");
        return;
      }
      relay.send(machine.id, opening.hello);
      this.timer = setTimeout(() => this.fail("电脑没有响应"), HANDSHAKE_TIMEOUT_MS);
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN || !this.channel) return;
    this.relay.send(this.machine.id, { k: "data", ch: this.ch, box: this.channel.seal(data) });
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    if (this.readyState === OPEN) this.relay.send(this.machine.id, { k: "close", ch: this.ch });
    this.finish(1000, "closed");
  }

  private fail(message: string, code?: string): void {
    if (this.readyState === CLOSED) return;
    this.onerror?.({ message, code });
    this.finish(4000, message);
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearTimeout(this.timer);
    for (const stop of this.cleanup.splice(0)) stop();
    this.onclose?.({ code, reason });
  }
}
