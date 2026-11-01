import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, RELAY_PATH, RelayClient, type RelaySocket } from "@linkshell/wire";
import { startHost } from "../../host/src/host.js";
import { Gateway, type GatewayOptions } from "../src/relay.js";
import { turnCredentials, turnOptionsFromEnv } from "../src/turn.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OPTIONS = { secret: "shared-secret", urls: ["stun:turn.example.com:3478", "turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"] };

describe("turn credentials", () => {
  it("signs the username with coturn's REST scheme, so coturn can check it without a database", () => {
    const now = Date.UTC(2026, 10, 1, 12, 0, 0);
    const { servers, ttl, maxKbps } = turnCredentials(OPTIONS, "abcdef0123456789", now);
    const turn = servers.find((server) => server.credential)!;
    expect(ttl).toBe(8 * 3600);
    expect(maxKbps).toBe(3000);
    expect(turn.username).toBe(`${now / 1000 + 8 * 3600}:abcdef012345`);
    expect(turn.credential).toBe(createHmac("sha1", "shared-secret").update(turn.username!).digest("base64"));
    expect(turn.urls).toEqual(OPTIONS.urls.slice(1));
  });

  it("gives STUN without a credential, so nothing secret goes where none is needed", () => {
    const stun = turnCredentials(OPTIONS, "peer").servers.find((server) => server.urls[0]!.startsWith("stun:"))!;
    expect(stun).toEqual({ urls: ["stun:turn.example.com:3478"] });
  });

  it("reads the environment, and refuses a URL that is not a STUN or TURN one", () => {
    expect(turnOptionsFromEnv({})).toBeUndefined();
    expect(turnOptionsFromEnv({ TURN_SECRET: "s" })).toBeUndefined();
    expect(turnOptionsFromEnv({ TURN_URLS: "turn:a:3478" })).toBeUndefined();
    expect(turnOptionsFromEnv({ TURN_SECRET: "s", TURN_URLS: " stun:a:3478 , turns:a:443?transport=tcp ", TURN_TTL_SECONDS: "7200", TURN_MAX_KBPS: "2500" }))
      .toEqual({ secret: "s", urls: ["stun:a:3478", "turns:a:443?transport=tcp"], ttlSeconds: 7200, maxKbps: 2500 });
    expect(() => turnOptionsFromEnv({ TURN_SECRET: "s", TURN_URLS: "http://a" })).toThrow(/TURN_URLS/);
    // A TTL too short to finish a screen session is ignored rather than honoured.
    expect(turnOptionsFromEnv({ TURN_SECRET: "s", TURN_URLS: "turn:a:1", TURN_TTL_SECONDS: "5" })?.ttlSeconds).toBeUndefined();
  });
});

async function start(options: Partial<GatewayOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lsh-turn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const relay = new Gateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "gateway.db"), log: () => {}, ...options });
  const port = await relay.start();
  cleanups.push(() => relay.stop());
  return { relay, dir, url: `ws://127.0.0.1:${port}` };
}

async function gateway(options: Partial<GatewayOptions> = {}, role: "machine" | "device" = "machine") {
  const { url } = await start(options);
  const peer = new RelayClient({
    url: url + RELAY_PATH,
    identity: createIdentity(),
    role,
    name: "Test Mac",
    createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
  });
  peer.start();
  cleanups.push(() => peer.stop());
  await peer.waitOnline(5000);
  return peer;
}

describe("turn.credentials", () => {
  it("lends a signed-in peer credentials for this gateway's TURN server", async () => {
    const peer = await gateway({ turn: { ...OPTIONS, maxKbps: 2500 } });
    const given = await peer.request("turn.credentials", {});
    expect(given.maxKbps).toBe(2500);
    const turn = given.servers.find((server) => server.credential)!;
    expect(turn.credential).toBe(createHmac("sha1", "shared-secret").update(turn.username!).digest("base64"));
    expect(Number(turn.username!.split(":")[0])).toBeGreaterThan(Date.now() / 1000);
  });

  it("answers an empty list when the gateway has no TURN server, which the host takes as 'direct path or byte relay only'", async () => {
    const peer = await gateway();
    expect(await peer.request("turn.credentials", {})).toEqual({ servers: [], ttl: 0 });
  });

  it("is for computers only: a phone gets them from the computer, with the picture", async () => {
    const phone = await gateway({ turn: OPTIONS }, "device");
    await expect(phone.request("turn.credentials", {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("limits how often one peer may ask", async () => {
    const peer = await gateway({ turn: OPTIONS });
    for (let i = 0; i < 30; i++) await peer.request("turn.credentials", {});
    await expect(peer.request("turn.credentials", {})).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("a host's TURN credentials", () => {
  async function host(options: Partial<GatewayOptions>, old = false) {
    const world = await start(options);
    const relay = world.relay as unknown as { handle(peer: unknown, method: string, params: unknown): Promise<unknown> };
    const original = relay.handle.bind(relay);
    // A gateway from before TURN: the method is unknown to it.
    const asked = vi.spyOn(relay, "handle").mockImplementation((peer, method, params) =>
      original(peer, old && method === "turn.credentials" ? "turn.unknown" : method, params));
    const running = await startHost({ home: join(world.dir, "host"), version: "test", drivers: () => [], log: () => {}, gateway: { url: world.url, name: "Test Mac" } });
    cleanups.push(() => running.stop());
    const link = running.gateway!;
    const deadline = Date.now() + 5000;
    while (link.status().status !== "online") {
      if (Date.now() > deadline) throw new Error("the host never came online");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const turnCalls = () => asked.mock.calls.filter(([, method]) => method === "turn.credentials").length;
    return { link, turnCalls };
  }

  it("are fetched once the host is online and kept, so a screen never waits for the gateway", async () => {
    const { link, turnCalls } = await host({ turn: OPTIONS });
    const first = await link.turn();
    expect(first?.servers.find((server) => server.credential)?.urls).toEqual(OPTIONS.urls.slice(1));
    await link.turn();
    await link.turn();
    expect(turnCalls()).toBe(1);
  });

  it("are none from a gateway without TURN, or one too old to know the method", async () => {
    const plain = await host({});
    expect(await plain.link.turn()).toBeUndefined();
    const old = await host({ turn: OPTIONS }, true);
    expect(await old.link.turn()).toBeUndefined();
    await old.link.turn();
    // Asked once, at sign-in; not again on every screen.
    expect(old.turnCalls()).toBe(1);
  });
});
