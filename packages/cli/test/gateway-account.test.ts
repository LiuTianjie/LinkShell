import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, RELAY_PATH, RelayClient, type RelaySocket } from "@linkshell/wire";
import { Gateway } from "../../gateway/src/relay.js";
import { leaveGatewayAccount } from "../src/gateway-account.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "lsh-account-leave-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const identity = createIdentity();
  writeFileSync(join(home, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  const gateway = new Gateway({ port: 0, host: "127.0.0.1", databasePath: join(home, "gateway.db"), log: () => {}, verifyToken: async () => ({ userId: "alice" }) });
  const url = `ws://127.0.0.1:${await gateway.start()}`;
  cleanups.push(() => gateway.stop());
  const previous = new RelayClient({
    url: url + RELAY_PATH, identity, role: "machine", name: "Computer", token: () => "valid-token",
    createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
  });
  cleanups.push(() => previous.stop());
  previous.start();
  expect(await previous.waitOnline(5000)).toBe(true);
  return { home, identity, gateway, url, previous };
}

describe("logout compatibility with an older running Host", () => {
  it("takes over the same identity and revokes the binding without restarting the Host", async () => {
    const { home, identity, gateway, url, previous } = await setup();
    await leaveGatewayAccount({ home, url, token: "valid-token", machineId: identity.id, name: "Computer" });
    expect(gateway.store.peer(identity.id)?.userId).toBeUndefined();
    await vi.waitFor(() => expect(previous.lastError?.code).toBe("replaced"));
    expect(previous.status).toBe("offline");
  });

  it("reports an unconfirmed binding while leaving the old connection replaced on an older gateway", async () => {
    const { home, identity, gateway, url, previous } = await setup();
    const controls = gateway as unknown as { handle(peer: unknown, method: string, params: unknown): Promise<unknown> };
    const original = controls.handle.bind(controls);
    vi.spyOn(controls, "handle").mockImplementation((peer, method, params) => original(peer, method === "account.leave" ? "unsupported-account-leave" : method, params));
    await expect(leaveGatewayAccount({ home, url, token: "valid-token", machineId: identity.id })).rejects.toMatchObject({ replaced: true });
    expect(gateway.store.peer(identity.id)?.userId).toBe("alice");
    await vi.waitFor(() => expect(previous.lastError?.code).toBe("replaced"));
    expect(previous.status).toBe("offline");
  });
});
