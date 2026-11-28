import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, RELAY_PATH, RelayClient, type PeerRole, type RelaySocket } from "@linkshell/wire";
import { startGateway, type StartGatewayOptions } from "../src/serve.js";
import { requirePro, type SubscriptionCheck } from "../src/subscription.js";

// The gateway as production runs it: one port, the health check, the relay behind the limiter.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ACCOUNTS: Record<string, { userId: string }> = {
  "token-active": { userId: "active" },
  "token-lapsed": { userId: "lapsed" },
  "token-unknown": { userId: "unknown" },
};

async function gateway(options: Partial<StartGatewayOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lsh-serve-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const running = await startGateway({
    port: 0,
    host: "127.0.0.1",
    // A directory that doesn't exist yet: a fresh volume, or a first `linkshell gateway`.
    databasePath: join(dir, "data", "relay.db"),
    log: () => {},
    verifyToken: async (token) => ACCOUNTS[token],
    ...options,
  });
  cleanups.push(() => running.close());
  return { ...running, http: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}` };
}

function peer(url: string, role: PeerRole, token?: string) {
  const relay = new RelayClient({
    url: url + RELAY_PATH,
    identity: createIdentity(),
    role,
    name: role,
    token: token ? () => token : undefined,
    createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
  });
  const errors: { code: string; message: string }[] = [];
  relay.onStatus((_status, error) => {
    if (error) errors.push(error);
  });
  relay.start();
  cleanups.push(() => relay.stop());
  return { relay, errors };
}

/** How an upgrade request ends: "open", or the HTTP status it was refused with (0: the socket was just closed). */
function upgrade(url: string, headers: Record<string, string> = {}): Promise<"open" | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on("open", () => {
      socket.terminate();
      resolve("open");
    });
    socket.on("unexpected-response", (_request, response) => {
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.on("error", () => resolve(0));
  });
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("startGateway", () => {
  it("answers /healthz with the build, the peers connected and its memory", async () => {
    const { http, ws } = await gateway();
    const response = await fetch(`${http}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const health = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(health)).toEqual(["ok", "version", "relay", "memoryMb"]);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(health).toMatchObject({ ok: true, version: manifest.version, relay: 0 });
    expect(health.memoryMb).toBeGreaterThan(0);

    const phone = peer(ws, "device");
    expect(await phone.relay.waitOnline(5000)).toBe(true);
    expect(await (await fetch(`${http}/healthz`)).json()).toMatchObject({ relay: 1 });
  });

  it("serves bundled web assets with pairing-only runtime config and no filesystem fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-web-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>LinkShell</html>");
    writeFileSync(join(dir, "assets", "index-abc.js"), "console.log('web')");
    const { http, ws } = await gateway({ web: { directory: dir }, verifyToken: undefined });
    expect(await (await fetch(http)).text()).toBe("<html>LinkShell</html>");
    const oauthCallback = await fetch(http + "/linkshell/callback?code=pkce-test");
    expect(oauthCallback.status).toBe(200);
    expect(oauthCallback.headers.get("cache-control")).toBe("no-store");
    expect(await oauthCallback.text()).toBe("<html>LinkShell</html>");
    const config = await fetch(http + "/config.js");
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await config.text()).toContain('"deployment":"self-hosted"');
    const asset = await fetch(http + "/assets/index-abc.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await (await fetch(http, { method: "HEAD" })).text()).toBe("");
    for (const path of ["/package.json", "/%2e%2e%2fpackage.json", "/assets/missing.js", "/sessions"]) {
      expect((await fetch(http + path)).status).toBe(404);
    }
    expect(await peer(ws, "device").relay.waitOnline(5000)).toBe(true);
  });

  it("exposes only selected public account settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-web-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "web");
    const account = { url: "https://account.example", anonKey: "public", serviceRoleKey: "secret" };
    const { http } = await gateway({ web: { directory: dir, account, previewOrigin: "https://preview.example" } });
    const config = await (await fetch(http + "/config.js")).text();
    expect(config).toContain('"deployment":"official"');
    expect(config).toContain('"anonKey":"public"');
    expect(config).toContain('"previewOrigin":"https://preview.example"');
    expect(config).not.toContain("secret");
    expect(config).not.toContain("serviceRoleKey");
  });

  it("reports the version it is given", async () => {
    const { http } = await gateway({ version: "9.9.9" });
    expect(await (await fetch(`${http}/healthz`)).json()).toMatchObject({ version: "9.9.9" });
  });

  it("keeps removed APIs unavailable when web is disabled", async () => {
    const { http } = await gateway({ web: { directory: false } });
    // What 1.x served here, and the health check by any other method.
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/sessions"],
      ["POST", "/pairings"],
      ["GET", "/tunnel/abc/3000/"],
      ["POST", "/healthz"],
      ["OPTIONS", "/healthz"],
      ["GET", RELAY_PATH],
    ] as const) {
      const response = await fetch(http + path, { method });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("hands a WebSocket on the relay path to the relay, and refuses one anywhere else", async () => {
    const { ws, http, port, relay } = await gateway();
    const phone = peer(ws, "device");
    expect(await phone.relay.waitOnline(5000)).toBe(true);
    expect(relay.connected).toBe(1);
    expect(await phone.relay.request("machines.list", {})).toEqual({ machines: [] });

    for (const path of ["/ws", "/", `${RELAY_PATH}/`, `${RELAY_PATH}x`, "/tunnel/abc/3000/"]) {
      expect([path, await upgrade(ws + path)]).toEqual([path, 0]);
    }
    // A query doesn't change which path it is.
    expect(await upgrade(`${ws}${RELAY_PATH}?from=test`)).toBe("open");

    // A request target that isn't a path at all is dropped like any other; the gateway stays up.
    await new Promise<void>((resolve) => {
      const socket = connectTcp(port, "127.0.0.1", () => {
        socket.write("GET // HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
  });

  it("limits connections per address, by the proxy's word only when the proxy is trusted", async () => {
    const limit = { max: 2, windowMs: 60_000 };
    const forwarded = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };

    const behindProxy = await gateway({ trustedProxies: [" 127.0.0.1 ", ""], wsConnectLimit: limit });
    const target = behindProxy.ws + RELAY_PATH;
    expect(await upgrade(target, forwarded)).toBe("open");
    expect(await upgrade(target, forwarded)).toBe("open");
    expect(await upgrade(target, forwarded)).toBe(429);
    // Another client behind the same proxy has its own allowance.
    expect(await upgrade(target, { "x-forwarded-for": "198.51.100.7" })).toBe("open");
    // Only the relay path counts: a refused path doesn't use up the allowance.
    expect(await upgrade(`${behindProxy.ws}/ws`, { "x-forwarded-for": "198.51.100.8" })).toBe(0);

    // What the caller wrote in front of the proxy's own entry doesn't give them a new allowance.
    const spoofing = await gateway({ trustedProxies: ["127.0.0.1"], wsConnectLimit: limit });
    expect(await upgrade(spoofing.ws + RELAY_PATH, { "x-forwarded-for": "1.1.1.1, 203.0.113.9" })).toBe("open");
    expect(await upgrade(spoofing.ws + RELAY_PATH, { "x-forwarded-for": "2.2.2.2, 203.0.113.9" })).toBe("open");
    expect(await upgrade(spoofing.ws + RELAY_PATH, { "x-forwarded-for": "3.3.3.3, 203.0.113.9" })).toBe(429);

    // Nobody is trusted: the header is ignored, and this machine itself is never limited.
    const direct = await gateway({ wsConnectLimit: limit });
    for (let i = 0; i < 4; i++) expect(await upgrade(direct.ws + RELAY_PATH, forwarded)).toBe("open");

    // Default limit is 60 connections per minute per address.
    const defaulted = await gateway({ trustedProxies: ["127.0.0.1"] });
    for (let i = 0; i < 60; i++) {
      expect(await upgrade(defaulted.ws + RELAY_PATH, { "x-forwarded-for": "198.51.100.42" })).toBe("open");
    }
    expect(await upgrade(defaulted.ws + RELAY_PATH, { "x-forwarded-for": "198.51.100.42" })).toBe(429);
  });

  it("asks admit about each peer, and refuses with its reason", async () => {
    const asked: { role: PeerRole; userId?: string }[] = [];
    const { ws, relay } = await gateway({
      admit: async (who) => {
        asked.push(who);
        return who.role === "machine" && !who.userId ? "log in first" : undefined;
      },
    });
    const anonymous = peer(ws, "machine");
    await until(() => anonymous.errors.some((error) => error.code === "not_admitted"));
    expect(anonymous.errors.find((error) => error.code === "not_admitted")?.message).toBe("log in first");
    anonymous.relay.stop();

    const computer = peer(ws, "machine", "token-active");
    expect(await computer.relay.waitOnline(5000)).toBe(true);
    expect(asked).toContainEqual({ role: "machine", userId: undefined });
    expect(asked).toContainEqual({ role: "machine", userId: "active" });
    expect(relay.connected).toBe(1);
  });

  it("requires Pro of computers only, and admits when the lookup fails", async () => {
    const checked: string[] = [];
    const warnings: string[] = [];
    const subscriptions: Record<string, SubscriptionCheck> = {
      active: { status: "active" },
      lapsed: { status: "inactive" },
      unknown: { status: "unknown", reason: "profile_lookup_failed" },
    };
    const { ws } = await gateway({
      admit: requirePro(
        async (userId) => {
          checked.push(userId);
          return subscriptions[userId]!;
        },
        (message) => warnings.push(message),
      ),
    });

    const anonymous = peer(ws, "machine");
    await until(() => anonymous.errors.some((error) => error.code === "not_admitted"));
    const anonMessage = anonymous.errors.find((error) => error.code === "not_admitted")?.message;
    expect(anonMessage).toContain("linkshell login");
    expect(anonMessage).not.toMatch(/7-day|7\s*天|trial/i);
    anonymous.relay.stop();

    const lapsed = peer(ws, "machine", "token-lapsed");
    await until(() => lapsed.errors.some((error) => error.code === "not_admitted"));
    const lapsedMessage = lapsed.errors.find((error) => error.code === "not_admitted")?.message;
    expect(lapsedMessage).toContain("https://www.itool.tech/pro?from=linkshell");
    expect(lapsedMessage).not.toMatch(/7-day|7\s*天|trial/i);
    lapsed.relay.stop();

    expect(await peer(ws, "machine", "token-active").relay.waitOnline(5000)).toBe(true);
    expect(warnings).toEqual([]);
    expect(await peer(ws, "machine", "token-unknown").relay.waitOnline(5000)).toBe(true);
    expect(warnings).toEqual(["subscription check unavailable (profile_lookup_failed); admitting unknown"]);

    // Phones are never checked, with an account or without.
    const before = [...checked];
    expect(await peer(ws, "device").relay.waitOnline(5000)).toBe(true);
    expect(await peer(ws, "device", "token-lapsed").relay.waitOnline(5000)).toBe(true);
    expect(checked).toEqual(before);
    expect(new Set(checked)).toEqual(new Set(["lapsed", "active", "unknown"]));
  });

  it("fails to start on a port already taken, and leaves the database free", async () => {
    const first = await gateway();
    const dir = mkdtempSync(join(tmpdir(), "lsh-serve-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = join(dir, "relay.db");
    await expect(startGateway({ port: first.port, host: "127.0.0.1", databasePath, log: () => {} })).rejects.toMatchObject({ code: "EADDRINUSE" });
    const second = await startGateway({ port: 0, host: "127.0.0.1", databasePath, log: () => {} });
    await second.close();
  });

  it("closes all sockets cleanly with 1001 ('going away'), checkpoints SQLite, enforces 0700/0600 perms, and lets peers auto-reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-graceful-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dataDir = join(dir, "data");
    const databasePath = join(dataDir, "relay.db");
    const first = await startGateway({ port: 0, host: "127.0.0.1", databasePath, log: () => {} });
    const port = first.port;
    const wsUrl = `ws://127.0.0.1:${port}${RELAY_PATH}`;

    if (process.platform !== "win32") {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }

    // Track the exact WebSocket close code/reason received by an authenticated RelayClient AND an unauthenticated socket.
    const closes: Array<{ code: number; reason: string }> = [];
    const identity = createIdentity();
    const client = new RelayClient({
      url: wsUrl,
      identity,
      role: "machine",
      name: "Zero-Downtime Host",
      createSocket: (target) => {
        const ws = new WebSocket(target);
        ws.once("close", (code, reason) => closes.push({ code, reason: reason.toString("utf8") }));
        return ws as unknown as RelaySocket;
      },
    });
    client.start();
    cleanups.push(() => client.stop());
    expect(await client.waitOnline(5000)).toBe(true);

    const raw = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      raw.once("open", () => resolve());
      raw.once("error", reject);
    });
    const rawClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      raw.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });

    // Graceful shutdown delivers 1001 ("going away") to both authenticated and unauthenticated sockets.
    await first.close();
    expect(await rawClosed).toEqual({ code: 1001, reason: "going away" });
    await until(() => closes.length >= 1);
    expect(closes[0]).toEqual({ code: 1001, reason: "going away" });

    // WAL was checkpointed cleanly and the restarted gateway preserves the peer record and accepts instant auto-reconnect.
    const second = await startGateway({ port, host: "127.0.0.1", databasePath, log: () => {} });
    cleanups.push(() => second.close());
    expect(second.relay.store.peer(identity.id)?.name).toBe("Zero-Downtime Host");
    expect(await client.waitOnline(5000)).toBe(true);
    expect(second.relay.connected).toBe(1);
  });
});
