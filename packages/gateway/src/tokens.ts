import { randomUUID } from "node:crypto";
import type { GatewayStateStore } from "./state-store.js";

const CLEANUP_INTERVAL = 5 * 60_000;
const SESSION_TTL = 7 * 24 * 60 * 60_000; // 7 days — prune stale bindings

interface TokenRecord {
  token: string;
  sessionIds: Set<string>;
  createdAt: number;
  lastUsedAt: number;
}

export class TokenManager {
  private tokens = new Map<string, TokenRecord>();
  private sessionToToken = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly store?: GatewayStateStore) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  async hydrate(): Promise<void> {
    if (!this.store) return;
    try {
      const records = await this.store.loadTokens();
      const now = Date.now();
      for (const record of records) {
        if (now - record.lastUsedAt > SESSION_TTL) {
          void this.store.deleteToken(record.token).catch(() => {});
          continue;
        }
        this.tokens.set(record.token, {
          token: record.token,
          sessionIds: new Set(record.sessionIds),
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
        });
        for (const sessionId of record.sessionIds) {
          this.sessionToToken.set(sessionId, record.token);
        }
      }
    } catch (err) {
      process.stderr.write(`[gateway] token store hydrate failed, using memory only: ${err}\n`);
    }
  }

  register(deviceToken?: string): string {
    if (deviceToken && this.tokens.has(deviceToken)) {
      const record = this.tokens.get(deviceToken)!;
      record.lastUsedAt = Date.now();
      this.persist(record);
      return deviceToken;
    }
    const token = deviceToken || randomUUID();
    this.tokens.set(token, {
      token,
      sessionIds: new Set(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    this.persist(this.tokens.get(token)!);
    return token;
  }

  bind(token: string, sessionId: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.sessionIds.add(sessionId);
    record.lastUsedAt = Date.now();
    this.sessionToToken.set(sessionId, token);
    this.persist(record);
    return true;
  }

  validate(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.lastUsedAt = Date.now();
    this.persist(record);
    return true;
  }

  owns(token: string, sessionId: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.lastUsedAt = Date.now();
    this.persist(record);
    return record.sessionIds.has(sessionId);
  }

  getSessionIds(token: string): Set<string> {
    const record = this.tokens.get(token);
    if (!record) return new Set();
    record.lastUsedAt = Date.now();
    this.persist(record);
    return record.sessionIds;
  }

  getTokenForSession(sessionId: string): string | undefined {
    return this.sessionToToken.get(sessionId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, record] of this.tokens) {
      if (now - record.lastUsedAt > SESSION_TTL) {
        for (const sid of record.sessionIds) {
          this.sessionToToken.delete(sid);
        }
        this.tokens.delete(token);
        void this.store?.deleteToken(token).catch(() => {});
      }
    }
  }

  private persist(record: TokenRecord): void {
    void this.store?.saveToken({
      token: record.token,
      sessionIds: [...record.sessionIds],
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    }).catch((err) => {
      process.stderr.write(`[gateway] token store save failed: ${err}\n`);
    });
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
