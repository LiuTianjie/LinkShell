import { randomInt, randomUUID } from "node:crypto";
import type { GatewayStateStore } from "./state-store.js";

export interface PairingRecord {
  sessionId: string;
  pairingCode: string;
  expiresAt: number; // unix ms
  claimed: boolean;
}

const PAIRING_TTL = Number(process.env.PAIRING_TTL_MS ?? 10 * 60_000); // 10 minutes
const CLEANUP_INTERVAL = 60_000;

export class PairingManager {
  private pairings = new Map<string, PairingRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly store?: GatewayStateStore) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  async hydrate(): Promise<void> {
    if (!this.store) return;
    try {
      const records = await this.store.loadPairings();
      const now = Date.now();
      for (const record of records) {
        if (record.expiresAt < now) {
          void this.store.deletePairing(record.pairingCode).catch(() => {});
          continue;
        }
        this.pairings.set(record.pairingCode, record);
      }
    } catch (err) {
      process.stderr.write(`[gateway] pairing store hydrate failed, using memory only: ${err}\n`);
    }
  }

  create(sessionId?: string): PairingRecord {
    const id = sessionId ?? randomUUID();
    const code = String(randomInt(100000, 999999));
    const record: PairingRecord = {
      sessionId: id,
      pairingCode: code,
      expiresAt: Date.now() + PAIRING_TTL,
      claimed: false,
    };
    this.pairings.set(code, record);
    this.persist(record);
    return record;
  }

  claim(pairingCode: string): PairingRecord | { error: string; status: number } {
    const record = this.pairings.get(pairingCode);
    if (!record) {
      return { error: "pairing_not_found", status: 404 };
    }
    if (record.expiresAt < Date.now()) {
      this.pairings.delete(pairingCode);
      void this.store?.deletePairing(pairingCode).catch(() => {});
      return { error: "pairing_expired", status: 410 };
    }
    if (record.claimed) {
      return { error: "pairing_already_claimed", status: 409 };
    }
    record.claimed = true;
    this.persist(record);
    return record;
  }

  getStatus(pairingCode: string): { status: string; expiresAt: number; sessionId: string } | { error: string; httpStatus: number } {
    const record = this.pairings.get(pairingCode);
    if (!record) {
      return { error: "pairing_not_found", httpStatus: 404 };
    }
    if (record.expiresAt < Date.now()) {
      this.pairings.delete(pairingCode);
      void this.store?.deletePairing(pairingCode).catch(() => {});
      return { error: "pairing_expired", httpStatus: 410 };
    }
    return {
      status: record.claimed ? "claimed" : "waiting",
      expiresAt: record.expiresAt,
      sessionId: record.sessionId,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, record] of this.pairings) {
      if (record.expiresAt < now) {
        this.pairings.delete(code);
        void this.store?.deletePairing(code).catch(() => {});
      }
    }
  }

  private persist(record: PairingRecord): void {
    void this.store?.savePairing(record).catch((err) => {
      process.stderr.write(`[gateway] pairing store save failed: ${err}\n`);
    });
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
