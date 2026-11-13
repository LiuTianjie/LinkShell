import { createHash } from "node:crypto";

// Account tokens (Supabase JWTs from the iTool login). The gateway only needs
// to know whose token it is; it never sees passwords.

export interface Account {
  userId: string;
  email?: string;
}

export type VerifyToken = (token: string) => Promise<Account | undefined>;

const DEFAULT_CACHE_TTL_MS = 45_000;
const DEFAULT_MAX_CACHE_ENTRIES = 5000;

export function supabaseVerifier(
  url: string,
  anonKey: string,
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): VerifyToken {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const cache = new Map<string, { account: Account; until: number }>();
  const inflight = new Map<string, Promise<Account | undefined>>();

  return async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const currentNow = now();
    const hit = cache.get(key);
    if (hit) {
      if (hit.until > currentNow) {
        // Refresh insertion order so active tokens stay cached under bounded eviction.
        cache.delete(key);
        cache.set(key, hit);
        return hit.account;
      }
      cache.delete(key);
    }

    const pending = inflight.get(key);
    if (pending) return pending;

    const request = (async (): Promise<Account | undefined> => {
      try {
        const response = await fetch(`${url}/auth/v1/user`, {
          headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return undefined;
        const user = (await response.json()) as { id?: string; email?: string };
        if (!user.id) return undefined;
        const account = { userId: user.id, email: user.email };
        const settledAt = now();
        cache.delete(key);
        if (maxEntries > 0) {
          if (cache.size >= maxEntries) {
            for (const [entryKey, value] of cache) {
              if (value.until <= settledAt) cache.delete(entryKey);
            }
            while (cache.size >= maxEntries) {
              const oldest = cache.keys().next().value;
              if (oldest === undefined) break;
              cache.delete(oldest);
            }
          }
          cache.set(key, { account, until: settledAt + ttlMs });
        }
        return account;
      } catch {
        return undefined;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, request);
    return request;
  };
}
