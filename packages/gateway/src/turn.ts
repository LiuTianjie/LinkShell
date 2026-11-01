import { createHmac } from "node:crypto";
import type { RelayIceServer, TurnCredentials } from "@linkshell/wire";

export interface TurnOptions {
  /** coturn's `static-auth-secret`: with it, a username that carries its own expiry needs no database. */
  secret: string;
  /** The server as clients are to be given it: `stun:`, `turn:` and `turns:` URLs. */
  urls: string[];
  /** How long a pair of username and credential works (default 8 hours: a screen session may be long). */
  ttlSeconds?: number;
  /** The most a relayed picture should send, in kilobits a second (default 3000). */
  maxKbps?: number;
}

const URL_PATTERN = /^(stun|turn|turns):[^\s,]+$/;

/** `TURN_SECRET` and `TURN_URLS` (comma separated); both or neither. */
export function turnOptionsFromEnv(env: NodeJS.ProcessEnv): TurnOptions | undefined {
  const secret = env.TURN_SECRET?.trim();
  const urls = (env.TURN_URLS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!secret || !urls.length) return undefined;
  const bad = urls.find((url) => !URL_PATTERN.test(url));
  if (bad) throw new Error(`TURN_URLS: "${bad}" is not a stun:, turn: or turns: URL`);
  const ttl = Number(env.TURN_TTL_SECONDS);
  const kbps = Number(env.TURN_MAX_KBPS);
  return {
    secret,
    urls,
    ...(Number.isFinite(ttl) && ttl >= 300 ? { ttlSeconds: Math.floor(ttl) } : {}),
    ...(Number.isFinite(kbps) && kbps >= 300 ? { maxKbps: Math.floor(kbps) } : {}),
  };
}

/**
 * coturn's REST scheme (`use-auth-secret`): the username is "<expiry>:<name>", the credential the
 * HMAC-SHA1 of it under the shared secret. The name only helps read coturn's log.
 */
export function turnCredentials(options: TurnOptions, peerId: string, now = Date.now()): TurnCredentials {
  const ttl = options.ttlSeconds ?? 8 * 3600;
  const username = `${Math.floor(now / 1000) + ttl}:${peerId.slice(0, 12)}`;
  const credential = createHmac("sha1", options.secret).update(username).digest("base64");
  const servers: RelayIceServer[] = [];
  const stun = options.urls.filter((url) => url.startsWith("stun:"));
  const turn = options.urls.filter((url) => !url.startsWith("stun:"));
  if (stun.length) servers.push({ urls: stun });
  if (turn.length) servers.push({ urls: turn, username, credential });
  return { servers, ttl, maxKbps: options.maxKbps ?? 3000 };
}
