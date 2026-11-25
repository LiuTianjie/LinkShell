import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { PeerRole } from "@linkshell/wire";

// What the gateway remembers: peers' public keys and account, and which
// devices are paired with which machines. No content, ever.

function enforcePrivateDbPermissions(path: string): void {
  if (process.platform === "win32" || !path || path === ":memory:") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    } catch {
      // Best-effort on restricted or virtual filesystems.
    }
  }
}

export interface PeerRecord {
  id: string;
  role: PeerRole;
  signKey: string;
  boxKey: string;
  name: string;
  platform?: string;
  userId?: string;
  lastSeen: number;
}

export class GatewayStore {
  private readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  /**
   * Who may reach whom, asked for every routed frame. Tracked per-peer so reconnects without
   * membership changes preserve the cache and mutations only invalidate affected peers/pairs.
   */
  private readonly routes = new Map<string, "paired" | "account" | null>();
  private readonly routesByPeer = new Map<string, Set<string>>();

  private readonly stmtPeer: StatementSync;
  private readonly stmtPeerRoleUser: StatementSync;
  private readonly stmtUpsertPeer: StatementSync;
  private readonly stmtTouch: StatementSync;
  private readonly stmtLink: StatementSync;
  private readonly stmtUnlink: StatementSync;
  private readonly stmtDisown: StatementSync;
  private readonly stmtLinkedAt: StatementSync;
  private readonly stmtReachableForMachine: StatementSync;
  private readonly stmtReachableForDevice: StatementSync;
  private readonly stmtOwnedPeers: StatementSync;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        sign_key TEXT NOT NULL,
        box_key TEXT NOT NULL,
        name TEXT NOT NULL,
        platform TEXT,
        user_id TEXT,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS peers_by_user ON peers (user_id);
      CREATE TABLE IF NOT EXISTS links (
        machine_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (machine_id, device_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS links_by_device ON links (device_id);
    `);
    enforcePrivateDbPermissions(path);
    this.stmtPeer = this.db.prepare("SELECT * FROM peers WHERE id = ?");
    this.stmtPeerRoleUser = this.db.prepare("SELECT role, user_id FROM peers WHERE id = ?");
    this.stmtUpsertPeer = this.db.prepare(
      `INSERT INTO peers (id, role, sign_key, box_key, name, platform, user_id, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET box_key = excluded.box_key, name = excluded.name,
         platform = excluded.platform, user_id = excluded.user_id, last_seen = excluded.last_seen`,
    );
    this.stmtTouch = this.db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
    this.stmtLink = this.db.prepare("INSERT OR IGNORE INTO links (machine_id, device_id, created_at) VALUES (?, ?, ?)");
    this.stmtUnlink = this.db.prepare("DELETE FROM links WHERE machine_id = ? AND device_id = ?");
    this.stmtDisown = this.db.prepare("UPDATE peers SET user_id = NULL WHERE id = ? AND user_id IS NOT NULL");
    this.stmtLinkedAt = this.db.prepare("SELECT created_at FROM links WHERE machine_id = ? AND device_id = ?");
    this.stmtReachableForMachine = this.db.prepare(
      "SELECT p.*, l.created_at AS paired_at FROM links l JOIN peers p ON p.id = l.device_id WHERE l.machine_id = ?",
    );
    this.stmtReachableForDevice = this.db.prepare(
      "SELECT p.*, l.created_at AS paired_at FROM links l JOIN peers p ON p.id = l.machine_id WHERE l.device_id = ?",
    );
    this.stmtOwnedPeers = this.db.prepare("SELECT * FROM peers WHERE user_id = ? AND role = ?");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Flush WAL into relay.db before shutdown so rolling deploys preserve every pairing cleanly.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort checkpoint; still close the handle below.
    }
    this.db.close();
    enforcePrivateDbPermissions(this.path);
  }

  /** Checkpoints the WAL so the journal cannot grow unboundedly (PASSIVE while active, TRUNCATE when idle). */
  checkpoint(mode: "PASSIVE" | "TRUNCATE" = "TRUNCATE"): void {
    if (this.closed) return;
    this.db.exec(`PRAGMA wal_checkpoint(${mode})`);
    enforcePrivateDbPermissions(this.path);
  }

  peer(id: string): PeerRecord | undefined {
    const row = this.stmtPeer.get(id) as Record<string, unknown> | undefined;
    return row ? toPeer(row) : undefined;
  }

  upsertPeer(peer: PeerRecord): void {
    const prev = this.stmtPeerRoleUser.get(peer.id) as { role: string; user_id: string | null } | undefined;
    const prevUserId = prev?.user_id ?? undefined;
    this.stmtUpsertPeer.run(
      peer.id,
      peer.role,
      peer.signKey,
      peer.boxKey,
      peer.name,
      peer.platform ?? null,
      peer.userId ?? null,
      peer.lastSeen,
    );
    if (!prev || prev.role !== peer.role || prevUserId !== peer.userId) {
      this.invalidatePeer(peer.id);
    }
  }

  touch(id: string, at = Date.now()): void {
    this.stmtTouch.run(at, id);
  }

  link(machineId: string, deviceId: string, at = Date.now()): void {
    this.stmtLink.run(machineId, deviceId, at);
    this.invalidatePair(machineId, deviceId);
  }

  unlink(machineId: string, deviceId: string): boolean {
    const changed = this.stmtUnlink.run(machineId, deviceId).changes > 0;
    if (changed) this.invalidatePair(machineId, deviceId);
    return changed;
  }

  /**
   * Takes a peer off its account: the account's other peers no longer reach it, or list it. Its
   * keys and pairings stay, and signing in again puts it back.
   */
  disown(id: string): boolean {
    const changed = this.stmtDisown.run(id).changes > 0;
    if (changed) this.invalidatePeer(id);
    return changed;
  }

  linkedAt(machineId: string, deviceId: string): number | undefined {
    const row = this.stmtLinkedAt.get(machineId, deviceId) as { created_at: number } | undefined;
    return row?.created_at;
  }

  /** Peers of the other role that `id` may reach: linked, or owned by the same account. */
  reachable(id: string): { peer: PeerRecord; via: "paired" | "account"; pairedAt?: number }[] {
    const self = this.peer(id);
    if (!self) return [];
    const other = self.role === "machine" ? "device" : "machine";
    const linked = (
      self.role === "machine"
        ? this.stmtReachableForMachine.all(id)
        : this.stmtReachableForDevice.all(id)
    ) as Record<string, unknown>[];
    const out = new Map<string, { peer: PeerRecord; via: "paired" | "account"; pairedAt?: number }>();
    for (const row of linked) out.set(String(row.id), { peer: toPeer(row), via: "paired", pairedAt: Number(row.paired_at) });
    if (self.userId) {
      const owned = this.stmtOwnedPeers.all(self.userId, other) as Record<string, unknown>[];
      for (const row of owned) if (!out.has(String(row.id))) out.set(String(row.id), { peer: toPeer(row), via: "account" });
    }
    return [...out.values()];
  }

  /** How `from` may reach `to`, or undefined when it may not. */
  route(from: string, to: string): "paired" | "account" | undefined {
    const key = `${from}\n${to}`;
    const cached = this.routes.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const via = this.findRoute(from, to);
    if (this.routes.size > 20_000) {
      this.routes.clear();
      this.routesByPeer.clear();
    }
    this.routes.set(key, via ?? null);
    this.trackRoute(from, key);
    this.trackRoute(to, key);
    return via;
  }

  private trackRoute(peerId: string, key: string): void {
    let set = this.routesByPeer.get(peerId);
    if (!set) this.routesByPeer.set(peerId, (set = new Set()));
    set.add(key);
  }

  private invalidatePeer(peerId: string): void {
    const keys = this.routesByPeer.get(peerId);
    if (!keys) return;
    this.routesByPeer.delete(peerId);
    for (const key of keys) {
      this.routes.delete(key);
      const sep = key.indexOf("\n");
      const a = key.slice(0, sep);
      const b = key.slice(sep + 1);
      const other = a === peerId ? b : a;
      const otherSet = this.routesByPeer.get(other);
      if (otherSet) {
        otherSet.delete(key);
        if (otherSet.size === 0) this.routesByPeer.delete(other);
      }
    }
  }

  private invalidatePair(a: string, b: string): void {
    for (const key of [`${a}\n${b}`, `${b}\n${a}`]) {
      if (!this.routes.delete(key)) continue;
      for (const peerId of [a, b]) {
        const set = this.routesByPeer.get(peerId);
        if (set) {
          set.delete(key);
          if (set.size === 0) this.routesByPeer.delete(peerId);
        }
      }
    }
  }

  private findRoute(from: string, to: string): "paired" | "account" | undefined {
    const a = this.peer(from);
    const b = this.peer(to);
    if (!a || !b || a.role === b.role) return undefined;
    const [machine, device] = a.role === "machine" ? [a, b] : [b, a];
    if (this.linkedAt(machine.id, device.id) !== undefined) return "paired";
    if (a.userId && a.userId === b.userId) return "account";
    return undefined;
  }
}

function toPeer(row: Record<string, unknown>): PeerRecord {
  return {
    id: String(row.id),
    role: row.role as PeerRole,
    signKey: String(row.sign_key),
    boxKey: String(row.box_key),
    name: String(row.name),
    platform: row.platform ? String(row.platform) : undefined,
    userId: row.user_id ? String(row.user_id) : undefined,
    lastSeen: Number(row.last_seen),
  };
}
