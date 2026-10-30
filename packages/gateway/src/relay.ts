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
  /** How long a receiver may take nothing while its sender is held (default 15 s). */
  stalledPeerMs?: number;
  /** How long a receiver that is reading, slowly, may hold its sender (default 60 s). */
  slowPeerMs?: number;
}

/** The relay owns authentication/routing; transports only carry opaque v2 frames. */
export interface GatewaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close" | "pong", listener: () => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  pause(): void;
  resume(): void;
  /** Its peer authenticated: a transport may hold connections that haven't to a tighter limit. */
  authenticated?(): void;
}

interface Peer {
  record: PeerRecord;
  socket: GatewaySocket;
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
  /** Machines that said they have an access password, as of their last sign-in (memory only: the schema stays as it is). */
  private readonly locked = new Set<string>();
  /** Hosts persist this marker; retaining it while offline keeps legacy aliases from returning. */
  private readonly namingConfigured = new Set<string>();
  private readonly offers = new Map<string, Offer>();
  private readonly decisions = new Map<string, { machineId: string; resolve: (accept: boolean) => void }>();
  private readonly claimTimes = new Map<string, number[]>();
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Sockets that answered the last ping. */
  private readonly alive = new WeakSet<GatewaySocket>();
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
    this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptTransport(ws));
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

  /** Drops connections that didn't answer the previous ping, pings the rest; forgets what has run out. */
  private sweep(): void {
    const now = Date.now();
    for (const [code, offer] of this.offers) if (offer.expiresAt < now) this.offers.delete(code);
    for (const [deviceId, times] of this.claimTimes) if (times.every((t) => now - t >= 60_000)) this.claimTimes.delete(deviceId);
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

  acceptTransport(socket: GatewaySocket): void {
    this.alive.add(socket);
    socket.on("pong", () => this.alive.add(socket));
    const nonce = randomBytes(32).toString("base64url");
    let peer: Peer | undefined;
    let authenticating = false;
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
        if (frame.t !== "auth" || authenticating) {
          socket.close(4001, "auth first");
          return;
        }
        authenticating = true;
        try {
          peer = await this.authenticate(frame, nonce, socket);
        } catch (error) {
          const code = error instanceof RelayError ? error.code : "auth_failed";
          send({ t: "error", code, message: error instanceof Error ? error.message : String(error) });
          socket.close(4001, code);
          return;
        }
        clearTimeout(timer);
        socket.authenticated?.();
        send({ t: "ready", userId: peer.record.userId, email: peer.email });
        this.announce(peer.record, true);
        return;
      }
      // Replaced by a newer connection with this identity: what still arrives on this one is from a
      // connection that is over, and must not reach channels opened on the new one.
      if (this.peers.get(peer.record.id)?.socket !== socket) return;
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

  private async authenticate(frame: Extract<import("@linkshell/wire").ClientFrame, { t: "auth" }>, nonce: string, socket: GatewaySocket) {
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
      if (account) {
        userId = account.userId;
        email = account.email;
      } else if (existing?.userId) {
        // Once a peer's Ed25519 key is bound to an account, keep that binding if its local OAuth
        // token later expires or fails to refresh while the computer is unattended.
        userId = existing.userId;
      } else {
        throw new RelayError("token_invalid", "account token is invalid or expired");
      }
    } else if (existing?.userId && this.options.verifyToken) {
      userId = existing.userId;
    }
    const refusal = await this.options.admit?.({ role: role as PeerRole, userId });
    if (refusal) throw new RelayError("not_admitted", refusal);
    if (socket.readyState !== WebSocket.OPEN) throw new RelayError("closed", "connection closed during authentication");
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
    if (role === "machine") {
      const was = this.locked.has(record.id);
      const nameWasConfigured = this.namingConfigured.has(record.id);
      if (frame.locked) this.locked.add(record.id);
      else this.locked.delete(record.id);
      if (frame.namingConfigured) this.namingConfigured.add(record.id);
      if (was !== Boolean(frame.locked) || nameWasConfigured !== this.namingConfigured.has(record.id) || existing?.name !== record.name) {
        for (const { peer: device } of this.store.reachable(record.id)) this.event(device.id, "machines.changed", {});
      }
    }
    const previous = this.peers.get(record.id);
    const peer: Peer = { record, socket, email };
    this.peers.set(record.id, peer);
    // One live connection per identity: the newest wins.
    previous?.socket.close(4000, "replaced by a newer connection");
    // The old connection's close won't announce anything, since this one is registered by then. A
    // device's channels live and die with its gateway connection, so its machines must still drop
    // them, and now: before this connection is ready and can open new ones. (Devices don't drop
    // channels on presence; a machine that reconnects answers their next frame with `close`.)
    if (previous && role === "device") this.announce(record, false);
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
    let lowest = target.socket.bufferedAmount;
    let progressAt = since;
    const timer = setInterval(() => {
      const open = target.socket.readyState === WebSocket.OPEN;
      const behind = target.socket.bufferedAmount;
      if (behind < lowest) {
        lowest = behind;
        progressAt = Date.now();
      }
      if (open && behind > limit / 4) {
        // While the sender is held, what it sends its other peers waits too, so a receiver that
        // takes nothing (a phone suspended in the background, a dead link) is let go soon. One
        // that is slowly reading gets longer. Either catches up from its last seq on reconnect.
        const stalled = Date.now() - progressAt >= (this.options.stalledPeerMs ?? 15_000);
        const tooLong = Date.now() - since >= (this.options.slowPeerMs ?? 60_000);
        if (!stalled && !tooLong) return;
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
      ...(this.locked.has(peer.id) ? { locked: true } : {}),
      ...(this.namingConfigured.has(peer.id) ? { namingConfigured: true } : {}),
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
      case "machines.update": {
        need("machine");
        if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 120) {
          throw new RelayError("invalid_params", "name must contain 1 to 120 characters");
        }
        const name = params.name.trim();
        const newlyConfigured = params.namingConfigured === true && !this.namingConfigured.has(peer.record.id);
        if (peer.record.name !== name || newlyConfigured) {
          const updated = { ...peer.record, name };
          this.store.upsertPeer(updated);
          peer.record = updated;
          if (params.namingConfigured === true) this.namingConfigured.add(peer.record.id);
          for (const { peer: device } of this.store.reachable(peer.record.id)) this.event(device.id, "machines.changed", {});
        }
        return {};
      }
      case "machines.forget": {
        need("device");
        const machineId = String(params.machineId ?? "");
        const unpaired = this.store.unlink(machineId, peer.record.id);
        if (unpaired) this.event(machineId, "presence", { id: peer.record.id, online: false });
        // A computer that is listed because it signed in to this account, and is gone (reinstalled,
        // given away): taken off the account, so the list stops showing it. One that is connected
        // stays: it is signed in right now, and would only be back at once.
        const machine = this.store.peer(machineId);
        const ours = machine?.role === "machine" && peer.record.userId !== undefined && machine.userId === peer.record.userId;
        if (ours && !this.peers.has(machineId)) this.store.disown(machineId);
        return {};
      }
      case "account.leave": {
        // A phone signing out. Its binding outlives a missing or failed token (installed apps rely
        // on that), so it is ended by asking.
        need("device");
        if (!peer.record.userId) return {};
        const machines = this.store.reachable(peer.record.id).filter(({ via }) => via === "account");
        this.store.disown(peer.record.id);
        peer.record.userId = undefined;
        peer.email = undefined;
        // Their channels from it close now, not when it next reconnects.
        for (const { peer: machine } of machines) this.event(machine.id, "presence", { id: peer.record.id, online: false });
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
