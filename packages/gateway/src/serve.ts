import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { RELAY_PATH } from "@linkshell/wire";
import type { VerifyToken } from "./accounts.js";
import { clientIp, isLoopback, normalizeIp, RateLimiter, trustedProxySet } from "./rate-limit.js";
import { Gateway, type GatewayOptions } from "./relay.js";

export interface StartGatewayOptions {
  port: number;
  /** The interface to listen on; all of them when omitted. */
  host?: string;
  /** SQLite file holding pairings and peers' public keys. Losing it unpairs every phone. */
  databasePath: string;
  /** What `/healthz` reports; this package's version when omitted. */
  version?: string;
  log?: (message: string) => void;
  /** Validates account tokens; without it, accounts are off and only pairing works. */
  verifyToken?: VerifyToken;
  admit?: GatewayOptions["admit"];
  /** Addresses of the reverse proxies in front, whose X-Forwarded-For is believed. */
  trustedProxies?: readonly string[];
  /** Connections one address may open per window (default 20 a minute). */
  wsConnectLimit?: { max: number; windowMs: number };
}

export interface RunningGateway {
  port: number;
  relay: Gateway;
  close(): Promise<void>;
}

/**
 * The gateway as it is deployed: one HTTP server with the relay on
 * `RELAY_PATH` and a health check on `/healthz`. Nothing else is served.
 */
export async function startGateway(options: StartGatewayOptions): Promise<RunningGateway> {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const relay = new Gateway({
    port: 0,
    databasePath: options.databasePath,
    verifyToken: options.verifyToken,
    admit: options.admit,
    log: options.log,
  });
  const version = options.version ?? packageVersion();
  const trustedProxies = trustedProxySet(options.trustedProxies ?? []);
  const limit = options.wsConnectLimit ?? { max: 20, windowMs: 60_000 };
  const connectLimiter = new RateLimiter(limit.max, limit.windowMs);

  // A proxy that isn't in `trustedProxies` makes every user share one allowance. Said once per address, so
  // the gateway's log names the address to add.
  const untrustedProxies = new Set<string>();
  const noteUntrustedProxy = (request: IncomingMessage) => {
    // As it would be written in TRUSTED_PROXIES: without the IPv6 mapping a dual-stack socket adds.
    const peer = normalizeIp(request.socket.remoteAddress ?? "");
    if (request.headers["x-forwarded-for"] === undefined || isLoopback(peer) || trustedProxies.has(peer)) return;
    if (untrustedProxies.has(peer) || untrustedProxies.size >= 16) return;
    untrustedProxies.add(peer);
    options.log?.(`a connection from ${peer} carries X-Forwarded-For, which is ignored: if ${peer} is your reverse proxy, add it to TRUSTED_PROXIES so each user gets their own connection limit`);
  };

  const server = createServer((request, response) => {
    if (request.method === "GET" && pathOf(request) === "/healthz") {
      // memoryMb: what the process holds, to watch against the container's limit.
      json(response, 200, { ok: true, version, relay: relay.connected, memoryMb: Math.round(process.memoryUsage.rss() / 1048576) });
      return;
    }
    json(response, 404, { error: "not_found" });
  });

  server.on("upgrade", (request, socket, head) => {
    if (pathOf(request) !== RELAY_PATH) {
      socket.destroy();
      return;
    }
    const ip = clientIp(request, trustedProxies);
    noteUntrustedProxy(request);
    if (!isLoopback(ip) && !connectLimiter.allow(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    relay.handleUpgrade(request, socket, head);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    connectLimiter.destroy();
    await relay.stop();
    throw error;
  }
  relay.attach();

  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    relay,
    close: async () => {
      connectLimiter.destroy();
      // The relay drops its peers first: the server only finishes closing once their sockets are gone.
      await relay.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The request's path; undefined for a target that doesn't parse, which then matches nothing. */
function pathOf(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "/", "http://gateway").pathname;
  } catch {
    return undefined;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** This package's version, so `/healthz` says which build is deployed. */
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  // package.json is one level up from src/ and three up from dist/gateway/src/.
  for (const path of ["../package.json", "../../../package.json"]) {
    try {
      const manifest = require(path) as { name?: string; version?: string };
      if (manifest.name === "@linkshell/gateway" && manifest.version) return manifest.version;
    } catch {
      // Not at this depth.
    }
  }
  return "unknown";
}
