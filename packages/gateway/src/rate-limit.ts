import type { IncomingMessage } from "node:http";

/** Counts hits per key in fixed windows; over `maxHits` in one window is refused. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {
    // Finished windows are dropped, so the map holds only keys seen lately.
    this.pruneTimer = setInterval(() => this.prune(), Math.max(windowMs, 60_000));
    this.pruneTimer.unref();
  }

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxHits;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
  }
}

/** A host or a test on this machine: never rate limited. */
export function isLoopback(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

/** IPv4 addresses arrive IPv6-mapped (::ffff:1.2.3.4) on a dual-stack socket. */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

/** The reverse proxies in front of this gateway, from a list of their addresses. */
export function trustedProxySet(addresses: readonly string[]): Set<string> {
  return new Set(addresses.map(normalizeIp).filter(Boolean));
}

/**
 * Who is connecting. X-Forwarded-For is believed only when the direct peer is
 * one of `trustedProxies`: from anyone else the header is the caller's own
 * claim, and believing it would let them pick their rate-limit key.
 */
export function clientIp(request: IncomingMessage, trustedProxies: ReadonlySet<string>): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  if (trustedProxies.has(normalizeIp(peer))) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return peer;
}
