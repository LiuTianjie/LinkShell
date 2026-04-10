import { randomInt, randomUUID } from "node:crypto";

export interface PairingRecord {
  sessionId: string;
  pairingCode: string;
  expiresAt: number; // unix ms
  claimed: boolean;
}

const PAIRING_TTL = 7 * 24 * 60 * 60_000; // 7 days
const CLEANUP_INTERVAL = 60_000;

export class PairingManager {
  private pairings = new Map<string, PairingRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
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
    return record;
  }

  claim(pairingCode: string): PairingRecord | { error: string; status: number } {
    const record = this.pairings.get(pairingCode);
    if (!record) {
      return { error: "pairing_not_found", status: 404 };
    }
    if (record.expiresAt < Date.now()) {
      this.pairings.delete(pairingCode);
      return { error: "pairing_expired", status: 410 };
    }
    record.claimed = true;
    return record;
  }

  getStatus(pairingCode: string): { status: string; expiresAt: number; sessionId: string } | { error: string; httpStatus: number } {
    const record = this.pairings.get(pairingCode);
    if (!record) {
      return { error: "pairing_not_found", httpStatus: 404 };
    }
    if (record.expiresAt < Date.now()) {
      this.pairings.delete(pairingCode);
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
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
