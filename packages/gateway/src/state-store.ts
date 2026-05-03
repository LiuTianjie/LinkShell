export interface StoredTokenRecord {
  token: string;
  sessionIds: string[];
  createdAt: number;
  lastUsedAt: number;
}

export interface StoredPairingRecord {
  sessionId: string;
  pairingCode: string;
  expiresAt: number;
  claimed: boolean;
}

export interface GatewayStateStore {
  loadTokens(): Promise<StoredTokenRecord[]>;
  saveToken(record: StoredTokenRecord): Promise<void>;
  deleteToken(token: string): Promise<void>;
  loadPairings(): Promise<StoredPairingRecord[]>;
  savePairing(record: StoredPairingRecord): Promise<void>;
  deletePairing(pairingCode: string): Promise<void>;
}

const TOKEN_TABLE = process.env.SUPABASE_GATEWAY_TOKEN_TABLE ?? "linkshell_gateway_tokens";
const PAIRING_TABLE = process.env.SUPABASE_GATEWAY_PAIRING_TABLE ?? "linkshell_gateway_pairings";
const STORE_TIMEOUT_MS = Number(process.env.SUPABASE_STATE_TIMEOUT_MS ?? 3_000);

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoToMs(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function createSupabaseStateStore(): GatewayStateStore | undefined {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return undefined;

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(STORE_TIMEOUT_MS),
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Supabase state store ${res.status}: ${body || res.statusText}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    async loadTokens() {
      const rows = await request<Array<Record<string, unknown>>>(
        `${TOKEN_TABLE}?select=token,session_ids,created_at,last_used_at`,
      );
      return rows.map((row) => ({
        token: String(row.token ?? ""),
        sessionIds: Array.isArray(row.session_ids)
          ? row.session_ids.map(String)
          : [],
        createdAt: isoToMs(row.created_at),
        lastUsedAt: isoToMs(row.last_used_at),
      })).filter((record) => record.token);
    },
    async saveToken(record) {
      await request(
        `${TOKEN_TABLE}?on_conflict=token`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            token: record.token,
            session_ids: record.sessionIds,
            created_at: msToIso(record.createdAt),
            last_used_at: msToIso(record.lastUsedAt),
          }),
        },
      );
    },
    async deleteToken(token) {
      await request(`${TOKEN_TABLE}?token=eq.${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
    },
    async loadPairings() {
      const rows = await request<Array<Record<string, unknown>>>(
        `${PAIRING_TABLE}?select=pairing_code,session_id,expires_at,claimed`,
      );
      return rows.map((row) => ({
        pairingCode: String(row.pairing_code ?? ""),
        sessionId: String(row.session_id ?? ""),
        expiresAt: isoToMs(row.expires_at),
        claimed: row.claimed === true,
      })).filter((record) => record.pairingCode && record.sessionId);
    },
    async savePairing(record) {
      await request(
        `${PAIRING_TABLE}?on_conflict=pairing_code`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            pairing_code: record.pairingCode,
            session_id: record.sessionId,
            expires_at: msToIso(record.expiresAt),
            claimed: record.claimed,
          }),
        },
      );
    },
    async deletePairing(pairingCode) {
      await request(
        `${PAIRING_TABLE}?pairing_code=eq.${encodeURIComponent(pairingCode)}`,
        { method: "DELETE" },
      );
    },
  };
}
