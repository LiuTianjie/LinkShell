import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, publicIdentity, sign, gatewayChallengeMessage, RelayClient, type RelaySocket } from "@linkshell/wire";
import { startGateway } from "../src/serve.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-poll-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const gateway = await startGateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "relay.db"), log: () => {}, verifyToken: async (t) => t === "account" ? { userId: "owner" } : undefined });
  cleanup.push(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = async (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const opened = await (await post("/v2/poll", {})).json() as { id: string; token: string };
  const path = `/v2/poll/${opened.id}`;
  let ack = 0, request = 0;
  const exchange = async (frames: unknown[] = [], waitMs = 100) => {
    const body = { request: ++request, ack, frames: frames.map((f) => JSON.stringify(f)), waitMs };
    const res = await post(path, body, opened.token);
    expect(res.status).toBe(200);
    const result = await res.json() as { frames: { seq: number; frame: string }[]; closed?: string };
    for (const entry of result.frames) ack = Math.max(ack, entry.seq);
    return { ...result, decoded: result.frames.map((entry) => JSON.parse(entry.frame)), body };
  };
  return { gateway, base, post, opened, path, exchange };
}

describe("HTTPS transport for the v2 relay", () => {
  it("requires its session secret, then the same signed gateway authentication", async () => {
    const { post, path, exchange, gateway } = await setup();
    expect((await post(path, {})).status).toBe(401);
    const challenge = (await exchange()).decoded[0];
    expect(challenge.t).toBe("challenge");
    const identity = createIdentity();
    const auth = await exchange([{ t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" }]);
    expect(auth.decoded).toContainEqual({ t: "ready", userId: "owner" });
    expect(gateway.relay.connected).toBe(1);
    const list = await exchange([{ t: "req", id: 1, method: "machines.list", params: {} }]);
    expect(list.decoded).toContainEqual({ t: "res", id: 1, result: { machines: [] } });
  });

  it("retains responses until acknowledged and never replays retried mutation frames", async () => {
    const { base, post, path, opened, exchange } = await setup();
    const machine = new RelayClient({ url: base.replace("http:", "ws:") + "/v2/connect", identity: createIdentity(), role: "machine", name: "Mac", token: () => "account", createSocket: (url) => new WebSocket(url) as unknown as RelaySocket });
    cleanup.push(() => machine.stop()); machine.start();
    expect(await machine.waitOnline(5000)).toBe(true);
    const identity = createIdentity();
    const challenge = (await exchange()).decoded[0];
    await exchange([{ t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" }]);
    let routed = 0;
    machine.onFrame(() => routed++);
    const body = { request: 3, ack: 2, frames: [JSON.stringify({ t: "to", to: machine.identity.id, d: JSON.stringify({ k: "close", ch: "test" }) })], waitMs: 10 };
    expect((await post(path, body, opened.token)).status).toBe(200);
    expect((await post(path, body, opened.token)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routed).toBe(1);
    expect((await post(path, { ...body, frames: [] }, opened.token)).status).toBe(409);
    expect((await post(path, { ...body, request: 5 }, opened.token)).status).toBe(409);
    const resBody = { request: 4, ack: 2, frames: [JSON.stringify({ t: "req", id: 7, method: "machines.list", params: {} })], waitMs: 100 };
    const first = await (await post(path, resBody, opened.token)).json();
    const retry = await (await post(path, resBody, opened.token)).json();
    expect(retry).toEqual(first);
  });

  it("closes concurrent authentication without retaining an authenticated peer", async () => {
    const { exchange, gateway } = await setup();
    const challenge = (await exchange()).decoded[0];
    const identity = createIdentity();
    const frame = { t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" };
    const result = await exchange([frame, frame]);
    expect(result.closed).toBe("auth first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.relay.connected).toBe(0);
  });

  it("rejects unsigned authentication and malformed request limits", async () => {
    const { exchange, post, path, opened } = await setup();
    await exchange();
    const result = await exchange([{ t: "auth", identity: publicIdentity(createIdentity()), role: "device", name: "Watch", signature: "invalid" }]);
    expect(result.closed).toBe("bad_signature");
    expect(result.decoded[0].code).toBe("bad_signature");
    expect((await post(path, { request: 3, ack: 0, frames: [], waitMs: 60_000 }, opened.token)).status).toBe(400);
  });
});
