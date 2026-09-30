// Account tokens (Supabase JWTs from the iTool login). The gateway only needs
// to know whose token it is; it never sees passwords.

export interface Account {
  userId: string;
  email?: string;
}

export type VerifyToken = (token: string) => Promise<Account | undefined>;

export function supabaseVerifier(url: string, anonKey: string): VerifyToken {
  const cache = new Map<string, { account: Account; until: number }>();
  return async (token) => {
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.account;
    try {
      const response = await fetch(`${url}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;
      const user = (await response.json()) as { id?: string; email?: string };
      if (!user.id) return undefined;
      const account = { userId: user.id, email: user.email };
      cache.set(token, { account, until: Date.now() + 60_000 });
      if (cache.size > 5000) for (const [key, value] of cache) if (value.until < Date.now()) cache.delete(key);
      return account;
    } catch {
      return undefined;
    }
  };
}
