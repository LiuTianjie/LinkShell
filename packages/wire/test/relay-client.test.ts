import { expect, it, vi } from "vitest";
import { createIdentity, gatewayChallengeMessage, verifySignature } from "../src/crypto.js";
import { RelayClient, type RelaySocket } from "../src/relay-client.js";
import type { ClientFrame } from "../src/relay.js";

class Socket implements RelaySocket {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(data: string) { this.sent.push(JSON.parse(data) as ClientFrame); }
  close(code?: number, reason?: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

it("keeps a delayed token and stale ready frames on their original gateway socket across reauthentication", async () => {
  const identity = createIdentity();
  const sockets: Socket[] = [];
  let finish!: (token: string) => void;
  const token = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue("current-token");
  const client = new RelayClient({
    identity, name: "Test", role: "device", url: "ws://127.0.0.1/v2/connect", pingMs: 0, token,
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  try {
    client.start();
    sockets[0].message({ t: "challenge", nonce: "old-nonce" });
    client.reauthenticate();
    sockets[1].message({ t: "challenge", nonce: "current-nonce" });
    await Promise.resolve();
    finish("previous-token");
    await Promise.resolve();
    expect(sockets[0].sent).toEqual([]);
    expect(sockets[1].sent).toHaveLength(1);
    const frame = sockets[1].sent[0];
    expect(frame).toMatchObject({ t: "auth", token: "current-token" });
    if (frame.t !== "auth") throw new Error("Expected gateway authentication");
    expect(verifySignature(identity.signKey, gatewayChallengeMessage("current-nonce"), frame.signature)).toBe(true);
    sockets[0].message({ t: "ready", userId: "previous-account" });
    expect(client.status).toBe("connecting");
    sockets[1].message({ t: "ready", userId: "current-account" });
    sockets[0].message({ t: "ready", userId: "previous-account" });
    expect(client.account?.userId).toBe("current-account");
  } finally { client.stop(); }
});

it("ignores late authentication and ready frames after the owner stops the connection", async () => {
  const socket = new Socket();
  let finish!: (token: string) => void;
  const client = new RelayClient({
    identity: createIdentity(), name: "Test", role: "device", url: "ws://127.0.0.1/v2/connect", pingMs: 0,
    token: () => new Promise<string>((resolve) => { finish = resolve; }), createSocket: () => socket,
  });
  client.start();
  socket.message({ t: "challenge", nonce: "stopped-nonce" });
  client.stop();
  finish("late-token");
  await Promise.resolve();
  socket.message({ t: "ready", userId: "signed-out-account" });
  expect(socket.sent).toEqual([]);
  expect(client.status).toBe("stopped");
  expect(client.account).toBeUndefined();
});
