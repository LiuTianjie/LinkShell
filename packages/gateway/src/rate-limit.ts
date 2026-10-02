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

/** The reverse proxies in front of this gateway. */
export interface TrustedProxies {
  has(ip: string): boolean;
}

function ipv4Number(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

/**
 * From a list of their addresses. An IPv4 range can be given as `10.0.0.0/8`: a proxy in a container network
 * has another address after every deploy, and only its network is known beforehand.
 */
export function trustedProxySet(addresses: readonly string[]): TrustedProxies {
  const exact = new Set<string>();
  const ranges: { base: number; size: number }[] = [];
  for (const address of addresses.map(normalizeIp).filter(Boolean)) {
    const [network, bits, ...rest] = address.split("/");
    const base = bits === undefined ? undefined : ipv4Number(network ?? "");
    const prefix = Number(bits);
    if (base === undefined || rest.length > 0 || !/^\d{1,2}$/.test(bits ?? "") || prefix > 32) {
      exact.add(address);
      continue;
    }
    const size = 2 ** (32 - prefix);
    ranges.push({ base: base - (base % size), size });
  }
  return {
    has(ip) {
      const address = normalizeIp(ip);
      if (exact.has(address)) return true;
      const value = ranges.length > 0 ? ipv4Number(address) : undefined;
      return value !== undefined && ranges.some((range) => value >= range.base && value < range.base + range.size);
    },
  };
}

/**
 * Who is connecting. X-Forwarded-For is believed only when the direct peer is
 * one of `trustedProxies`: from anyone else the header is the caller's own
 * claim, and believing it would let them pick their rate-limit key. The same
 * goes for what the header starts with: a proxy adds the address it saw to
 * the end of whatever the caller sent, so the client is the last address that
 * isn't a proxy's, not the first one written.
 */
export function clientIp(request: IncomingMessage, trustedProxies: TrustedProxies): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  if (!trustedProxies.has(peer)) return peer;
  const forwarded = request.headers["x-forwarded-for"];
  const hops = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").map((hop) => hop.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trustedProxies.has(hops[i]!)) return hops[i]!;
  }
  // Every hop is a proxy of ours (or there is no header): the connection is the proxy's own.
  return hops[0] ?? peer;
}
