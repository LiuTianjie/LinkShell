export interface StoredAuthorizationRecord {
  authorizationId: string;
  token: string;
  hostDeviceId: string;
  clientDeviceId?: string;
  clientName?: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface StoredPairingRecord {
  hostDeviceId: string;
  pairingCode: string;
  expiresAt: number;
  claimed: boolean;
}

export interface GatewayStateStore {
  loadAuthorizations(): Promise<StoredAuthorizationRecord[]>;
  saveAuthorization(record: StoredAuthorizationRecord): Promise<void>;
  deleteAuthorization(authorizationId: string): Promise<void>;
  loadPairings(): Promise<StoredPairingRecord[]>;
  savePairing(record: StoredPairingRecord): Promise<void>;
  deletePairing(pairingCode: string): Promise<void>;
}

const AUTHORIZATION_TABLE =
  process.env.SUPABASE_GATEWAY_AUTHORIZATION_TABLE ??
  "linkshell_gateway_device_authorizations";
const PAIRING_TABLE =
  process.env.SUPABASE_GATEWAY_PAIRING_TABLE ??
  "linkshell_gateway_pairing_challenges";
const STORE_TIMEOUT_MS = Number(process.env.SUPABASE_STATE_TIMEOUT_MS ?? 3_000);

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoToMs(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    async loadAuthorizations() {
      const rows = await request<Array<Record<string, unknown>>>(
        `${AUTHORIZATION_TABLE}?select=authorization_id,token,host_device_id,client_device_id,client_name,created_at,last_used_at`,
      );
      return rows.map((row) => ({
        authorizationId: String(row.authorization_id ?? ""),
        token: String(row.token ?? ""),
        hostDeviceId: String(row.host_device_id ?? ""),
        clientDeviceId: maybeString(row.client_device_id),
        clientName: maybeString(row.client_name),
        createdAt: isoToMs(row.created_at),
        lastUsedAt: isoToMs(row.last_used_at),
      })).filter((record) => record.authorizationId && record.token && record.hostDeviceId);
    },
    async saveAuthorization(record) {
      await request(
        `${AUTHORIZATION_TABLE}?on_conflict=authorization_id`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            authorization_id: record.authorizationId,
            token: record.token,
            host_device_id: record.hostDeviceId,
            client_device_id: record.clientDeviceId ?? null,
            client_name: record.clientName ?? null,
            created_at: msToIso(record.createdAt),
            last_used_at: msToIso(record.lastUsedAt),
          }),
        },
      );
    },
    async deleteAuthorization(authorizationId) {
      await request(
        `${AUTHORIZATION_TABLE}?authorization_id=eq.${encodeURIComponent(authorizationId)}`,
        { method: "DELETE" },
      );
    },
    async loadPairings() {
      const rows = await request<Array<Record<string, unknown>>>(
        `${PAIRING_TABLE}?select=pairing_code,host_device_id,expires_at,claimed`,
      );
      return rows.map((row) => ({
        pairingCode: String(row.pairing_code ?? ""),
        hostDeviceId: String(row.host_device_id ?? ""),
        expiresAt: isoToMs(row.expires_at),
        claimed: row.claimed === true,
      })).filter((record) => record.pairingCode && record.hostDeviceId);
    },
    async savePairing(record) {
      await request(
        `${PAIRING_TABLE}?on_conflict=pairing_code`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            pairing_code: record.pairingCode,
            host_device_id: record.hostDeviceId,
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
