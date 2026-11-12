import type { ClientStore } from "@linkshell/client-core";

export interface SessionSubscriptionsOptions {
  /** How many recently left sessions keep their stream open for instant switching. */
  maxWarm?: number;
  /** How long an idle warm session stays subscribed before releasing its cursor. */
  ttlMs?: number;
}

/**
 * Reference-counted session subscriptions with a bounded warm LRU cache.
 *
 * Switching between sessions, opening settings or glancing at another tool keeps recently
 * visited sessions subscribed for `ttlMs`, avoiding redundant `sessions.subscribe` round-trips
 * and sync banners. Archived or deleted sessions are evicted immediately.
 */
export class SessionSubscriptions {
  private readonly counts = new Map<string, number>();
  private readonly warm = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxWarm: number;
  private readonly ttlMs: number;
  private readonly unsubscribeStore: () => void;
  private closed = false;

  constructor(private readonly store: ClientStore, options: SessionSubscriptionsOptions = {}) {
    this.maxWarm = options.maxWarm ?? 6;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.unsubscribeStore = store.subscribe((state, previous) => {
      if (!state?.sessions || state.sessions === previous?.sessions || this.warm.size === 0) return;
      for (const sessionId of [...this.warm.keys()]) {
        const summary = state.sessions[sessionId];
        if (!summary || summary.archived) this.evict(sessionId);
      }
    });
  }

  acquire(sessionId: string): () => void {
    if (this.closed) return () => {};
    const warmTimer = this.warm.get(sessionId);
    if (warmTimer !== undefined) {
      clearTimeout(warmTimer);
      this.warm.delete(sessionId);
    }
    const current = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, current + 1);
    if (current === 0 && warmTimer === undefined) {
      this.store.getState().openSession?.(sessionId);
    }
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      const next = (this.counts.get(sessionId) ?? 1) - 1;
      if (next > 0) {
        this.counts.set(sessionId, next);
        return;
      }
      this.counts.delete(sessionId);
      const sessions = this.store.getState().sessions;
      const summary = sessions ? sessions[sessionId] : undefined;
      if ((sessions && (!summary || summary.archived)) || this.maxWarm <= 0 || this.ttlMs <= 0) {
        this.store.getState().closeSession?.(sessionId);
        return;
      }
      while (this.warm.size >= this.maxWarm) {
        const oldest = this.warm.keys().next().value;
        if (oldest === undefined) break;
        this.evict(oldest);
      }
      const timer = setTimeout(() => {
        this.warm.delete(sessionId);
        if (!this.closed && !this.counts.has(sessionId)) {
          this.store.getState().closeSession?.(sessionId);
        }
      }, this.ttlMs);
      this.warm.set(sessionId, timer);
    };
  }

  evict(sessionId: string): void {
    const timer = this.warm.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.warm.delete(sessionId);
    }
    if (!this.counts.has(sessionId)) {
      this.store.getState().closeSession?.(sessionId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeStore();
    for (const timer of this.warm.values()) clearTimeout(timer);
    const ids = new Set([...this.counts.keys(), ...this.warm.keys()]);
    this.counts.clear();
    this.warm.clear();
    for (const sessionId of ids) {
      this.store.getState().closeSession?.(sessionId);
    }
  }
}
