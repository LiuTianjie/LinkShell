import { randomUUID } from "node:crypto";

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

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  register(deviceToken?: string): string {
    if (deviceToken && this.tokens.has(deviceToken)) {
      const record = this.tokens.get(deviceToken)!;
      record.lastUsedAt = Date.now();
      return deviceToken;
    }
    const token = deviceToken || randomUUID();
    this.tokens.set(token, {
      token,
      sessionIds: new Set(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return token;
  }

  bind(token: string, sessionId: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.sessionIds.add(sessionId);
    record.lastUsedAt = Date.now();
    this.sessionToToken.set(sessionId, token);
    return true;
  }

  validate(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.lastUsedAt = Date.now();
    return true;
  }

  owns(token: string, sessionId: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.lastUsedAt = Date.now();
    return record.sessionIds.has(sessionId);
  }

  getSessionIds(token: string): Set<string> {
    const record = this.tokens.get(token);
    if (!record) return new Set();
    record.lastUsedAt = Date.now();
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
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
