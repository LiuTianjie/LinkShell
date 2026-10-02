import { DatabaseSync } from "node:sqlite";
import type { PeerRole } from "@linkshell/wire";

// What the gateway remembers: peers' public keys and account, and which
// devices are paired with which machines. No content, ever.

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
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
  }

  close(): void {
    this.db.close();
  }

  peer(id: string): PeerRecord | undefined {
    const row = this.db.prepare("SELECT * FROM peers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toPeer(row) : undefined;
  }

  upsertPeer(peer: PeerRecord): void {
    this.db
      .prepare(
        `INSERT INTO peers (id, role, sign_key, box_key, name, platform, user_id, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET box_key = excluded.box_key, name = excluded.name,
           platform = excluded.platform, user_id = excluded.user_id, last_seen = excluded.last_seen`,
      )
      .run(peer.id, peer.role, peer.signKey, peer.boxKey, peer.name, peer.platform ?? null, peer.userId ?? null, peer.lastSeen);
  }

  touch(id: string, at = Date.now()): void {
    this.db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?").run(at, id);
  }

  link(machineId: string, deviceId: string, at = Date.now()): void {
    this.db.prepare("INSERT OR IGNORE INTO links (machine_id, device_id, created_at) VALUES (?, ?, ?)").run(machineId, deviceId, at);
  }

  unlink(machineId: string, deviceId: string): boolean {
    return this.db.prepare("DELETE FROM links WHERE machine_id = ? AND device_id = ?").run(machineId, deviceId).changes > 0;
  }

  /**
   * Takes a peer off its account: the account's other peers no longer reach it, or list it. Its
   * keys and pairings stay, and signing in again puts it back.
   */
  disown(id: string): boolean {
    return this.db.prepare("UPDATE peers SET user_id = NULL WHERE id = ? AND user_id IS NOT NULL").run(id).changes > 0;
  }

  linkedAt(machineId: string, deviceId: string): number | undefined {
    const row = this.db.prepare("SELECT created_at FROM links WHERE machine_id = ? AND device_id = ?").get(machineId, deviceId) as
      | { created_at: number }
      | undefined;
    return row?.created_at;
  }

  /** Peers of the other role that `id` may reach: linked, or owned by the same account. */
  reachable(id: string): { peer: PeerRecord; via: "paired" | "account"; pairedAt?: number }[] {
    const self = this.peer(id);
    if (!self) return [];
    const other = self.role === "machine" ? "device" : "machine";
    const linked = (
      self.role === "machine"
        ? this.db.prepare("SELECT p.*, l.created_at AS paired_at FROM links l JOIN peers p ON p.id = l.device_id WHERE l.machine_id = ?").all(id)
        : this.db.prepare("SELECT p.*, l.created_at AS paired_at FROM links l JOIN peers p ON p.id = l.machine_id WHERE l.device_id = ?").all(id)
    ) as Record<string, unknown>[];
    const out = new Map<string, { peer: PeerRecord; via: "paired" | "account"; pairedAt?: number }>();
    for (const row of linked) out.set(String(row.id), { peer: toPeer(row), via: "paired", pairedAt: Number(row.paired_at) });
    if (self.userId) {
      const owned = this.db.prepare("SELECT * FROM peers WHERE user_id = ? AND role = ?").all(self.userId, other) as Record<string, unknown>[];
      for (const row of owned) if (!out.has(String(row.id))) out.set(String(row.id), { peer: toPeer(row), via: "account" });
    }
    return [...out.values()];
  }

  /** How `from` may reach `to`, or undefined when it may not. */
  route(from: string, to: string): "paired" | "account" | undefined {
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
