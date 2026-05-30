import { randomInt, randomUUID } from "node:crypto";
import type { GatewayStateStore } from "./state-store.js";

export interface PairingRecord {
  sessionId: string;
  pairingCode: string;
  expiresAt: number; // unix ms
  claimed: boolean;
  failedAttempts: number; // failed claim attempts against this code
}

const PAIRING_TTL = Number(process.env.PAIRING_TTL_MS ?? 10 * 60_000); // 10 minutes
const CLEANUP_INTERVAL = 60_000;
// Invalidate a code after this many failed claim attempts to cap brute-forcing.
const MAX_FAILED_CLAIM_ATTEMPTS = Number(
  process.env.PAIRING_MAX_FAILED_ATTEMPTS ?? 5,
);

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
        // Stored records predate the failedAttempts field; default it.
        this.pairings.set(record.pairingCode, { ...record, failedAttempts: 0 });
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
      failedAttempts: 0,
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
      // Count repeated claim attempts on an existing code; once the cap is
      // exceeded, invalidate it so it can no longer be targeted.
      record.failedAttempts += 1;
      if (record.failedAttempts >= MAX_FAILED_CLAIM_ATTEMPTS) {
        this.pairings.delete(pairingCode);
        void this.store?.deletePairing(pairingCode).catch(() => {});
      } else {
        this.persist(record);
      }
      return { error: "pairing_already_claimed", status: 409 };
    }
    record.claimed = true;
    this.persist(record);
    return record;
  }

  /** Look up a code's session without consuming an attempt or mutating state.
   *  Lets the claim endpoint stay idempotent for a device that already owns the
   *  mapped session (it re-issues instead of erroring with already_claimed). */
  peek(pairingCode: string): { sessionId: string; claimed: boolean } | null {
    const record = this.pairings.get(pairingCode);
    if (!record) return null;
    if (record.expiresAt < Date.now()) return null;
    return { sessionId: record.sessionId, claimed: record.claimed };
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
