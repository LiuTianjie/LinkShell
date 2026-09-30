import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  answerTunnel,
  checkPairingProof,
  codeSecret,
  createIdentity,
  encodePairingLink,
  RELAY_PATH,
  RelayClient,
  RpcError,
  toBase64,
  type GatewayStatus,
  type Identity,
  type PublicIdentity,
  type RelaySocket,
  type SecureChannel,
  type TunnelFrame,
} from "@linkshell/wire";
import type { RpcTransport } from "./rpc/server.js";

// This machine on a v2 gateway: its identity, the devices it has paired with,
// and the encrypted channels devices open to it. Each channel is served as an
// ordinary client connection; the gateway only ever carries ciphertext.

interface PairedDevice extends PublicIdentity {
  name: string;
  pairedAt: number;
}

interface Pairing {
  secret: string;
  code: string;
  expiresAt: number;
}

interface Tunnel {
  channel: SecureChannel;
  deviceId: string;
  ch: string;
  message?: (text: string) => void;
  close?: () => void;
  closed: boolean;
}

export interface GatewayLinkOptions {
  /** Gateway base URL (ws:// or wss://, or http(s):// which is converted). */
  url: string;
  home: string;
  /** Account token (from `linkshell login`); the machine then belongs to that account. */
  token?: () => Promise<string | undefined> | string | undefined;
  name?: string;
  /** Serves a decrypted channel as a client connection. */
  serve: (transport: RpcTransport) => void;
  onChange?: (status: GatewayStatus) => void;
  onPaired?: (device: { id: string; name: string }) => void;
  log: (message: string) => void;
}

export function relayUrl(base: string): string {
  const url = new URL(base.replace(/^http/, "ws"));
  if (!url.pathname.endsWith(RELAY_PATH)) url.pathname = url.pathname.replace(/\/$/, "") + RELAY_PATH;
  return url.toString();
}

function loadIdentity(home: string): Identity {
  const path = join(home, "identity.json");
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Identity;
    if (stored.id && stored.signSecret && stored.boxSecret) return stored;
  } catch {
    // First run: create below.
  }
  const identity = createIdentity();
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return identity;
}

export class GatewayLink {
  readonly identity: Identity;
  private readonly relay: RelayClient;
  private readonly devicesPath: string;
  private devices: PairedDevice[];
  private pairing?: Pairing;
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly online = new Set<string>();
  private readonly name: string;

  constructor(private readonly options: GatewayLinkOptions) {
    this.identity = loadIdentity(options.home);
    this.devicesPath = join(options.home, "paired-devices.json");
    this.devices = this.loadDevices();
    this.name = options.name ?? hostname().replace(/\.local$/, "");
    this.relay = new RelayClient({
      url: relayUrl(options.url),
      identity: this.identity,
      role: "machine",
      name: this.name,
      platform: platform(),
      token: options.token,
      createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RelaySocket,
    });
    this.relay.onStatus((status, error) => {
      if (status === "online") {
        this.options.log(`[gateway] online as ${this.identity.id.slice(0, 8)}${this.relay.account ? ` (${this.relay.account.email ?? "account"})` : ""}`);
        void this.refreshPresence();
      } else if (error && status === "offline") {
        this.options.log(`[gateway] ${error.code}: ${error.message}`);
        for (const tunnel of this.tunnels.values()) this.closeTunnel(tunnel, "gateway disconnected");
      }
      this.changed();
    });
    this.relay.onFrame((from, via, frame) => this.onFrame(from, via, frame));
    this.relay.on("pair.request", (request) => void this.onPairRequest(request));
    this.relay.on("presence", ({ id, online }) => {
      if (online) this.online.add(id);
      else {
        this.online.delete(id);
        for (const tunnel of this.tunnels.values()) if (tunnel.deviceId === id) this.closeTunnel(tunnel, "device went offline");
      }
      this.changed();
    });
  }

  start(): void {
    this.relay.start();
  }

  stop(): void {
    for (const tunnel of this.tunnels.values()) this.closeTunnel(tunnel, "host stopping");
    this.relay.stop();
  }

  status(): GatewayStatus {
    const status = this.relay.status;
    return {
      url: this.options.url,
      status: status === "stopped" ? "off" : status,
      error: status === "online" ? undefined : this.relay.lastError,
      machine: { id: this.identity.id, name: this.name },
      account: this.relay.account,
      devices: this.devices.map((device) => ({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        online: this.online.has(device.id),
      })),
    };
  }

  /** Opens a pairing window; the returned link goes in the QR code. */
  async startPairing(): Promise<{ link: string; code: string; expiresAt: number; gateway: string }> {
    if (!(await this.relay.waitOnline(8000))) {
      throw RpcError.app("offline", `can't reach the gateway (${this.options.url})${this.relay.lastError ? `: ${this.relay.lastError.message}` : ""}`);
    }
    const offer = await this.relay.request("pair.offer", {});
    const secret = toBase64(randomBytes(16));
    this.pairing = { secret, code: offer.code, expiresAt: offer.expiresAt };
    const link = encodePairingLink({ gateway: this.options.url, signKey: this.identity.signKey, secret, code: offer.code });
    return { link, code: offer.code, expiresAt: offer.expiresAt, gateway: this.options.url };
  }

  async revoke(deviceId: string): Promise<void> {
    this.devices = this.devices.filter((device) => device.id !== deviceId);
    this.saveDevices();
    for (const tunnel of this.tunnels.values()) if (tunnel.deviceId === deviceId) this.closeTunnel(tunnel, "unpaired");
    await this.relay.request("devices.revoke", { deviceId }).catch(() => {});
    this.changed();
  }

  // ── pairing ───────────────────────────────────────────────────────

  private async onPairRequest(request: { requestId: string; device: PublicIdentity & { name: string }; proof: string; code: string }) {
    const pairing = this.pairing;
    const valid =
      !!pairing &&
      pairing.expiresAt > Date.now() &&
      request.code === pairing.code &&
      (checkPairingProof(pairing.secret, request.device, request.proof) || checkPairingProof(codeSecret(pairing.code), request.device, request.proof));
    if (valid) {
      this.devices = [
        ...this.devices.filter((device) => device.id !== request.device.id),
        { ...request.device, pairedAt: Date.now() },
      ];
      this.saveDevices();
      this.pairing = undefined;
      this.online.add(request.device.id);
      this.options.log(`[gateway] paired with "${request.device.name}"`);
      this.options.onPaired?.({ id: request.device.id, name: request.device.name });
      this.changed();
    } else {
      this.options.log(`[gateway] refused a pairing attempt from "${request.device.name}"`);
    }
    await this.relay.request("pair.decide", { requestId: request.requestId, accept: valid }).catch(() => {});
  }

  // ── channels ──────────────────────────────────────────────────────

  private onFrame(from: PublicIdentity, via: "paired" | "account", frame: TunnelFrame): void {
    const key = `${from.id}:${frame.ch}`;
    switch (frame.k) {
      case "hello": {
        const device = this.authorize(from, via);
        if (!device) {
          this.relay.send(from.id, { k: "refuse", ch: frame.ch, code: "not_paired", message: "this device isn't paired with this computer" });
          return;
        }
        let answer;
        try {
          answer = answerTunnel(this.identity, device, frame);
        } catch {
          this.relay.send(from.id, { k: "refuse", ch: frame.ch, code: "bad_hello", message: "handshake failed" });
          return;
        }
        const previous = this.tunnels.get(key);
        if (previous) this.closeTunnel(previous, "reopened");
        const tunnel: Tunnel = { channel: answer.channel, deviceId: from.id, ch: frame.ch, closed: false };
        this.tunnels.set(key, tunnel);
        this.relay.send(from.id, answer.welcome);
        this.options.serve({
          local: false,
          send: (text) => {
            if (!tunnel.closed) this.relay.send(from.id, { k: "data", ch: frame.ch, box: tunnel.channel.seal(text) });
          },
          close: () => this.closeTunnel(tunnel, "closed by host", true),
          onMessage: (listener) => (tunnel.message = listener),
          onClose: (listener) => (tunnel.close = listener),
        });
        return;
      }
      case "data": {
        const tunnel = this.tunnels.get(key);
        if (!tunnel) return;
        let text: string;
        try {
          text = tunnel.channel.open(frame.box);
        } catch {
          // Tampered, replayed or out of order: the channel can't be trusted any more.
          this.closeTunnel(tunnel, "bad frame", true);
          return;
        }
        tunnel.message?.(text);
        return;
      }
      case "close": {
        const tunnel = this.tunnels.get(key);
        if (tunnel) this.closeTunnel(tunnel, frame.reason ?? "closed by device");
        return;
      }
      default:
        return;
    }
  }

  /**
   * Whose hello to accept: devices paired here (with the keys stored at
   * pairing, not whatever the gateway says now), or, when this machine is
   * signed in, devices the gateway says share its account.
   */
  private authorize(from: PublicIdentity, via: "paired" | "account"): PublicIdentity | undefined {
    const paired = this.devices.find((device) => device.id === from.id);
    if (paired) return paired.signKey === from.signKey && paired.boxKey === from.boxKey ? paired : undefined;
    if (via === "account" && this.relay.account) return from;
    return undefined;
  }

  private closeTunnel(tunnel: Tunnel, reason: string, notify = false): void {
    if (tunnel.closed) return;
    tunnel.closed = true;
    this.tunnels.delete(`${tunnel.deviceId}:${tunnel.ch}`);
    if (notify) this.relay.send(tunnel.deviceId, { k: "close", ch: tunnel.ch, reason });
    tunnel.close?.();
  }

  private async refreshPresence(): Promise<void> {
    try {
      const { devices } = await this.relay.request("devices.list", {});
      this.online.clear();
      for (const device of devices) if (device.online) this.online.add(device.id);
      this.changed();
    } catch {
      // Presence events will correct it.
    }
  }

  private changed(): void {
    this.options.onChange?.(this.status());
  }

  private loadDevices(): PairedDevice[] {
    if (!existsSync(this.devicesPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.devicesPath, "utf8")) as PairedDevice[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveDevices(): void {
    writeFileSync(this.devicesPath, `${JSON.stringify(this.devices, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.devicesPath, 0o600);
  }
}
