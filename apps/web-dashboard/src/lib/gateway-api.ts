// HTTP calls to the LinkShell gateway (not Supabase). The browser claims a
// pairing code to get a device token, then lists/inspects sessions. CORS on the
// gateway is permissive and token auth rides in headers/query — no cookies.

import type { GatewayConfig, SessionSummary } from "./types";
import { getDeviceToken, setDeviceToken } from "./device-token";

function httpBase(config: GatewayConfig): string {
  return config.httpUrl.replace(/\/+$/, "");
}

/** Derive the ws(s):// URL from the gateway http(s):// base. */
export function wsBase(config: GatewayConfig): string {
  if (config.wsUrl) return config.wsUrl.replace(/\/+$/, "");
  const base = httpBase(config);
  return base.replace(/^http/, "ws");
}

interface AuthHeaders {
  deviceToken?: string | null;
  /** Supabase access token, for AUTH_REQUIRED gateways. */
  jwt?: string | null;
}

function authHeaders(auth: AuthHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  // On a premium gateway the JWT must be the bearer (it satisfies the
  // AUTH_REQUIRED gate). The device token — which proves session ownership —
  // can't share the header, so it rides in the `?token=` query param instead
  // (see withDeviceToken). For a logged-out user the device token is the bearer.
  const bearer = auth.jwt ?? auth.deviceToken;
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return headers;
}

/** Append the device token as `?token=` so the gateway can resolve session
 *  ownership even when the Authorization header carries the Supabase JWT. */
function withDeviceToken(rawUrl: string, auth: AuthHeaders): string {
  if (!auth.deviceToken) return rawUrl;
  const url = new URL(rawUrl);
  url.searchParams.set("token", auth.deviceToken);
  return url.toString();
}

/** Claim a 6-digit pairing code → returns a device token bound to the session. */
export async function claimPairing(
  config: GatewayConfig,
  pairingCode: string,
): Promise<{ sessionId: string; deviceToken: string }> {
  const res = await fetch(`${httpBase(config)}/pairings/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingCode,
      deviceToken: getDeviceToken() ?? undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `配对失败 (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { sessionId: string; deviceToken: string };
  if (body.deviceToken) setDeviceToken(body.deviceToken);
  return body;
}

/** List sessions this device token (or JWT user) owns. */
export async function listSessions(
  config: GatewayConfig,
  auth: AuthHeaders,
): Promise<SessionSummary[]> {
  const res = await fetch(withDeviceToken(`${httpBase(config)}/sessions`, auth), {
    headers: authHeaders(auth),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { sessions?: SessionSummary[] };
  return body.sessions ?? [];
}

/** Detail for one session (host status, cwd, provider). */
export async function getSession(
  config: GatewayConfig,
  sessionId: string,
  auth: AuthHeaders,
): Promise<SessionSummary | null> {
  const res = await fetch(withDeviceToken(`${httpBase(config)}/sessions/${sessionId}`, auth), {
    headers: authHeaders(auth),
  });
  if (!res.ok) return null;
  return (await res.json()) as SessionSummary;
}

/** Build the client WebSocket URL. Browsers can't set WS headers, so the device
 *  token and (optional) JWT ride in the query string — the gateway reads both. */
export function clientWsUrl(
  config: GatewayConfig,
  input: { sessionId: string; deviceId: string; deviceToken?: string | null; jwt?: string | null },
): string {
  const url = new URL(`${wsBase(config)}/ws`);
  url.searchParams.set("sessionId", input.sessionId);
  url.searchParams.set("role", "client");
  url.searchParams.set("deviceId", input.deviceId);
  if (input.deviceToken) url.searchParams.set("token", input.deviceToken);
  if (input.jwt) url.searchParams.set("auth_token", input.jwt);
  return url.toString();
}
