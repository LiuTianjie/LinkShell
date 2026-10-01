import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  clientFrameSchema,
  gatewayChallengeMessage,
  idOf,
  RELAY_PATH,
  verifySignature,
  type DeviceEntry,
  type MachineEntry,
  type PeerRole,
  type RelayEvents,
  type ServerFrame,
} from "@linkshell/wire";
import type { VerifyToken } from "./accounts.js";
import { GatewayStore, type PeerRecord } from "./store.js";

export interface GatewayOptions {
  port: number;
  host?: string;
  databasePath: string;
  /** Validates account tokens; without it, accounts are off and only pairing works. */
  verifyToken?: VerifyToken;
  log?: (message: string) => void;
  /** Called with every frame the gateway routes, for tests that check it only sees ciphertext. */
  onRouted?: (frame: string) => void;
  pairingTtlMs?: number;
  heartbeatMs?: number;
  /**
   * Final say on a connecting peer, after its key (and token, if any) checked
   * out: return a message to refuse it. The official gateway uses this to
   * require a subscription for computers.
   */
  admit?: (peer: { role: PeerRole; userId?: string }) => Promise<string | undefined>;
  /**
   * How much may wait to be written to one peer before the gateway stops
   * reading from whoever is sending to it (default 4 MB), and how long a peer
   * may stay that far behind before it is dropped (default 60 s).
   */
  maxBufferedBytes?: number;
  stalledPeerMs?: number;
}

interface Peer {
  record: PeerRecord;
  socket: WebSocket;
  email?: string;
  /** Not being read: a peer it sends to can't keep up. */
  held?: boolean;
}

interface Offer {
  code: string;
  machineId: string;
  expiresAt: number;
  attempts: number;
}

class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const AUTH_TIMEOUT_MS = 10_000;
const PAIR_DECISION_MS = 30_000;
const MAX_CLAIM_ATTEMPTS = 8;

/**
 * Gateway v2: authenticates peers by key, routes their end-to-end encrypted
 * frames to peers they may reach (paired, or same account), and brokers
 * pairing. It has no way to read what it routes.
 */
export class Gateway {
  readonly store: GatewayStore;
  private server?: Server;
  private readonly peers = new Map<string, Peer>();
  private readonly offers = new Map<string, Offer>();
  private readonly decisions = new Map<string, { machineId: string; resolve: (accept: boolean) => void }>();
  private readonly claimTimes = new Map<string, number[]>();
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Sockets that answered the last ping. */
  private readonly alive = new WeakSet<WebSocket>();
  private stopped = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: GatewayOptions) {
    this.store = new GatewayStore(options.databasePath);
    this.log = options.log ?? ((message) => process.stderr.write(`${new Date().toISOString()} [gateway] ${message}\n`));
  }

  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 48 * 1024 * 1024 });

  /** Runs on its own port. */
  async start(): Promise<number> {
    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, peers: this.peers.size }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      if (!request.url?.startsWith(RELAY_PATH)) {
        socket.destroy();
        return;
      }
      this.handleUpgrade(request, socket, head);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.options.port, this.options.host ?? "0.0.0.0", resolve));
    this.attach();
    const address = server.address();
    return typeof address === "object" && address ? address.port : this.options.port;
  }

  /**
   * Runs inside another HTTP server, which passes it upgrades for
   * `RELAY_PATH` through `handleUpgrade`.
   */
  attach(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.sweep(), this.options.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
  }

  get connected(): number {
    return this.peers.size;
  }

  /** Bytes accepted from senders and not yet written to their receivers. */
  get bufferedBytes(): number {
    let total = 0;
    for (const peer of this.peers.values()) total += peer.socket.bufferedAmount;
    return total;
  }

  /** Drops connections that didn't answer the previous ping, pings the rest. */
  private sweep(): void {
    for (const peer of this.peers.values()) {
      // A held peer isn't read, so its pong can't arrive; it is checked again once released.
      if (peer.held) continue;
      if (!this.alive.has(peer.socket)) {
        peer.socket.terminate();
        continue;
      }
      this.alive.delete(peer.socket);
      peer.socket.ping();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeat);
    for (const peer of this.peers.values()) peer.socket.terminate();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.store.close();
  }

  // ── connection ────────────────────────────────────────────────────

  private accept(socket: WebSocket): void {
    this.alive.add(socket);
    socket.on("pong", () => this.alive.add(socket));
    const nonce = randomBytes(32).toString("base64url");
    let peer: Peer | undefined;
    const send = (frame: ServerFrame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    const timer = setTimeout(() => {
      if (!peer) socket.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    send({ t: "challenge", nonce });

    socket.on("message", async (data) => {
      let parsed;
      try {
        parsed = clientFrameSchema.safeParse(JSON.parse(data.toString()));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        send({ t: "error", code: "bad_frame", message: "unreadable frame" });
        return;
      }
      const frame = parsed.data;
      if (!peer) {
        if (frame.t !== "auth") {
          socket.close(4001, "auth first");
          return;
        }
        try {
          peer = await this.authenticate(frame, nonce, socket);
        } catch (error) {
          const code = error instanceof RelayError ? error.code : "auth_failed";
          send({ t: "error", code, message: error instanceof Error ? error.message : String(error) });
          socket.close(4001, code);
          return;
        }
        clearTimeout(timer);
        send({ t: "ready", userId: peer.record.userId, email: peer.email });
        this.announce(peer.record, true);
        return;
      }
      switch (frame.t) {
        case "ping":
          send({ t: "pong" });
          return;
        case "to":
          this.route(peer, frame.to, frame.d);
          return;
        case "req":
          try {
            const result = await this.handle(peer, frame.method, (frame.params ?? {}) as Record<string, unknown>);
            send({ t: "res", id: frame.id, result });
          } catch (error) {
            const code = error instanceof RelayError ? error.code : "internal";
            send({ t: "res", id: frame.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        case "auth":
          return;
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (this.stopped || !peer || this.peers.get(peer.record.id)?.socket !== socket) return;
      this.peers.delete(peer.record.id);
      this.store.touch(peer.record.id);
      this.announce(peer.record, false);
    });
  }

  private async authenticate(frame: Extract<import("@linkshell/wire").ClientFrame, { t: "auth" }>, nonce: string, socket: WebSocket) {
    const { identity, role } = frame;
    if (idOf(identity.signKey) !== identity.id) throw new RelayError("bad_identity", "id doesn't match key");
    if (!verifySignature(identity.signKey, gatewayChallengeMessage(nonce), frame.signature)) {
      throw new RelayError("bad_signature", "signature check failed");
    }
    const existing = this.store.peer(identity.id);
    if (existing && existing.role !== role) throw new RelayError("bad_identity", "this key is registered with another role");
    let userId: string | undefined;
    let email: string | undefined;
    if (frame.token) {
      if (!this.options.verifyToken) throw new RelayError("accounts_disabled", "this gateway doesn't support accounts");
      const account = await this.options.verifyToken(frame.token);
      if (!account) throw new RelayError("token_invalid", "account token is invalid or expired");
      userId = account.userId;
      email = account.email;
    }
    const refusal = await this.options.admit?.({ role: role as PeerRole, userId });
    if (refusal) throw new RelayError("not_admitted", refusal);
    const record: PeerRecord = {
      id: identity.id,
      role: role as PeerRole,
      signKey: identity.signKey,
      boxKey: identity.boxKey,
      name: frame.name,
      platform: frame.platform,
      userId,
      lastSeen: Date.now(),
    };
    this.store.upsertPeer(record);
    const previous = this.peers.get(record.id);
    const peer: Peer = { record, socket, email };
    this.peers.set(record.id, peer);
    // One live connection per identity: the newest wins.
    previous?.socket.close(4000, "replaced by a newer connection");
    this.log(`${role} ${record.id.slice(0, 8)} "${record.name}" online${userId ? " (account)" : ""}`);
    return peer;
  }

  // ── routing ───────────────────────────────────────────────────────

  private route(from: Peer, to: string, data: string): void {
    const via = this.store.route(from.record.id, to);
    const target = this.peers.get(to);
    const undeliverable = (reason: string) =>
      from.socket.send(JSON.stringify({ t: "undeliverable", to, reason } satisfies ServerFrame));
    if (!via) return undeliverable("not_allowed");
    if (!target) return undeliverable("offline");
    const frame = JSON.stringify({
      t: "from",
      from: { id: from.record.id, signKey: from.record.signKey, boxKey: from.record.boxKey },
      via,
      d: data,
    } satisfies ServerFrame);
    this.options.onRouted?.(frame);
    target.socket.send(frame);
    this.holdWhileBehind(from, target);
  }

  /**
   * Backpressure. What a peer can't take yet would otherwise pile up here, in
   * memory every user of this gateway shares: stop reading the sender instead,
   * so the data waits on its side until the receiver catches up.
   */
  private holdWhileBehind(from: Peer, target: Peer): void {
    const limit = this.options.maxBufferedBytes ?? 4 * 1024 * 1024;
    if (from.held || target.socket.bufferedAmount <= limit) return;
    from.held = true;
    from.socket.pause();
    const since = Date.now();
    const timer = setInterval(() => {
      const open = target.socket.readyState === WebSocket.OPEN;
      if (open && target.socket.bufferedAmount > limit / 4) {
        if (Date.now() - since < (this.options.stalledPeerMs ?? 60_000)) return;
        this.log(`${target.record.role} ${target.record.id.slice(0, 8)} can't keep up; dropping it`);
        target.socket.terminate();
      }
      clearInterval(timer);
      from.held = false;
      this.alive.add(from.socket);
      if (from.socket.readyState === WebSocket.OPEN) from.socket.resume();
    }, 20);
    timer.unref();
  }

  private event<N extends keyof RelayEvents>(peerId: string, name: N, data: RelayEvents[N]): void {
    const peer = this.peers.get(peerId);
    if (peer?.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify({ t: "event", name, data } satisfies ServerFrame));
  }

  /** Tells everyone who can reach `record` that it came or went. */
  private announce(record: PeerRecord, online: boolean): void {
    for (const { peer } of this.store.reachable(record.id)) this.event(peer.id, "presence", { id: record.id, online });
  }

  private machineEntry(peer: PeerRecord, via: "paired" | "account"): MachineEntry {
    return {
      id: peer.id,
      signKey: peer.signKey,
      boxKey: peer.boxKey,
      name: peer.name,
      platform: peer.platform,
      online: this.peers.has(peer.id),
      via,
    };
  }

  private deviceEntry(peer: PeerRecord, pairedAt?: number): DeviceEntry {
    return { id: peer.id, signKey: peer.signKey, boxKey: peer.boxKey, name: peer.name, online: this.peers.has(peer.id), pairedAt };
  }

  // ── control methods ───────────────────────────────────────────────

  private async handle(peer: Peer, method: string, params: Record<string, unknown>): Promise<unknown> {
    const role = peer.record.role;
    const need = (wanted: PeerRole) => {
      if (role !== wanted) throw new RelayError("forbidden", `${method} is for ${wanted}s`);
    };
    switch (method) {
      case "pair.offer": {
        need("machine");
        for (const [code, offer] of this.offers) if (offer.machineId === peer.record.id) this.offers.delete(code);
        let code: string;
        do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        while (this.offers.has(code));
        const expiresAt = Date.now() + (this.options.pairingTtlMs ?? 10 * 60_000);
        this.offers.set(code, { code, machineId: peer.record.id, expiresAt, attempts: 0 });
        return { code, expiresAt };
      }
      case "pair.decide": {
        need("machine");
        const pending = this.decisions.get(String(params.requestId));
        if (!pending || pending.machineId !== peer.record.id) throw new RelayError("not_found", "no such pairing request");
        pending.resolve(params.accept === true);
        return {};
      }
      case "pair.claim":
        need("device");
        return this.claim(peer, params);
      case "machines.list":
        need("device");
        return {
          machines: this.store
            .reachable(peer.record.id)
            .map(({ peer: machine, via }) => this.machineEntry(machine, via))
            .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
        };
      case "machines.forget": {
        need("device");
        const machineId = String(params.machineId ?? "");
        if (this.store.unlink(machineId, peer.record.id)) this.event(machineId, "presence", { id: peer.record.id, online: false });
        return {};
      }
      case "devices.list":
        need("machine");
        return {
          devices: this.store.reachable(peer.record.id).map(({ peer: device, pairedAt }) => this.deviceEntry(device, pairedAt)),
        };
      case "devices.revoke": {
        need("machine");
        const deviceId = String(params.deviceId ?? "");
        if (this.store.unlink(peer.record.id, deviceId)) {
          this.event(deviceId, "machines.changed", {});
          this.peers.get(deviceId)?.socket.close(4003, "unpaired");
        }
        return {};
      }
      default:
        throw new RelayError("unknown_method", `unknown method ${method}`);
    }
  }

  private async claim(device: Peer, params: Record<string, unknown>): Promise<{ machine: MachineEntry }> {
    // Throttle guessing: a handful of claims per device per minute.
    const now = Date.now();
    const recent = (this.claimTimes.get(device.record.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 6) throw new RelayError("rate_limited", "too many pairing attempts, wait a minute");
    this.claimTimes.set(device.record.id, [...recent, now]);

    const code = typeof params.code === "string" ? params.code.replace(/\D/g, "") : undefined;
    const machineId = typeof params.machineId === "string" ? params.machineId : undefined;
    const offer = code
      ? this.offers.get(code)
      : [...this.offers.values()].find((candidate) => candidate.machineId === machineId);
    if (!offer || offer.expiresAt < now) {
      if (offer) this.offers.delete(offer.code);
      throw new RelayError("pairing_expired", "this pairing code is wrong or has expired");
    }
    if (++offer.attempts > MAX_CLAIM_ATTEMPTS) {
      this.offers.delete(offer.code);
      throw new RelayError("pairing_expired", "too many attempts on this code; start pairing again");
    }
    const machine = this.peers.get(offer.machineId);
    if (!machine) throw new RelayError("machine_offline", "the computer is offline");

    // The machine checks the proof (it holds the QR secret) and decides.
    const requestId = randomUUID();
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.decisions.delete(requestId);
        resolve(false);
      }, PAIR_DECISION_MS);
      this.decisions.set(requestId, {
        machineId: machine.record.id,
        resolve: (accept) => {
          clearTimeout(timer);
          this.decisions.delete(requestId);
          resolve(accept);
        },
      });
      this.event(machine.record.id, "pair.request", {
        requestId,
        device: { id: device.record.id, signKey: device.record.signKey, boxKey: device.record.boxKey, name: device.record.name },
        proof: String(params.proof ?? ""),
        code: offer.code,
      });
    });
    if (!accepted) {
      this.event(machine.record.id, "pair.done", { requestId, accepted: false });
      throw new RelayError("pairing_refused", "the computer refused this pairing");
    }
    this.offers.delete(offer.code);
    this.store.link(machine.record.id, device.record.id);
    this.event(machine.record.id, "pair.done", {
      requestId,
      accepted: true,
      device: this.deviceEntry(device.record, Date.now()),
    });
    this.log(`paired device ${device.record.id.slice(0, 8)} with machine ${machine.record.id.slice(0, 8)}`);
    return { machine: this.machineEntry(machine.record, "paired") };
  }
}
