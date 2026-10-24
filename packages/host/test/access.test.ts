import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcPeer } from "@linkshell/wire";
import { AccessControl, accessPath } from "../src/access.js";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function host(): Promise<{ host: RunningHost; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "ls-access-"));
  const home = join(root, "host");
  const running = await startHost({ home, version: "test", env: {}, drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
  cleanups.push(async () => { await running.stop(); await rm(root, { recursive: true, force: true }); });
  return { host: running, home };
}

/** A connection as a device reaches the host through the gateway (not local). */
function remote(running: RunningHost, deviceId = "device-1") {
  const notifications: string[] = [];
  let toHost: ((text: string) => void) | undefined;
  let hostClosed: (() => void) | undefined;
  let closed = false;
  const peer = new RpcPeer({
    send: (text) => queueMicrotask(() => toHost?.(text)),
    onNotification: (method) => notifications.push(method),
  });
  running.server.connect({
    local: false,
    deviceId,
    send: (text) => queueMicrotask(() => peer.receive(text)),
    close: () => { closed = true; hostClosed?.(); },
    onMessage: (listener) => (toHost = listener),
    onClose: (listener) => (hostClosed = listener),
  });
  return {
    call: <T = unknown>(method: string, params: unknown = {}) => peer.request<T>(method, params, 5000),
    notifications,
    get closed() { return closed; },
  };
}

it("lets a remote connection in without a password, as before", async () => {
  const { host: running } = await host();
  const device = remote(running);
  const info = await device.call<{ locked?: boolean; agents: unknown[] }>("machine.info");
  expect(info.locked).toBeUndefined();
  await expect(device.call("sessions.list", { limit: 10 })).resolves.toBeTruthy();
});

it("holds a remote connection at machine.info and access.unlock until the password is given", async () => {
  const { host: running, home } = await host();
  const local = await connectHost(running.paths.hostSocket);
  cleanups.push(async () => local.close());
  expect(await local.call("access.status", {})).toEqual({ password: false });
  expect(await local.call("access.set", { password: "secret-1" })).toEqual({ password: true });
  expect((await stat(accessPath(home))).mode & 0o777).toBe(0o600);

  const device = remote(running);
  const info = await device.call<{ locked?: boolean; agents: unknown[]; home?: string }>("machine.info");
  expect(info.locked).toBe(true);
  expect(info.agents).toEqual([]);
  expect(info.home).toBeUndefined();
  await expect(device.call("sessions.list", { limit: 10 })).rejects.toMatchObject({ data: { code: "locked" } });
  await expect(device.call("fs.list", {})).rejects.toMatchObject({ data: { code: "locked" } });
  await expect(device.call("access.set", {})).rejects.toMatchObject({ data: { code: "locked" } });
  // Broadcasts don't reach it either.
  running.server.broadcast("gateway.changed", { status: "off", devices: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(device.notifications).not.toContain("gateway.changed");

  await expect(device.call("access.unlock", { password: "wrong" })).rejects.toMatchObject({ data: { code: "wrong_password" } });
  const { token } = await device.call<{ token: string }>("access.unlock", { password: "secret-1" });
  expect(token).toMatch(/^\d+\./);
  await expect(device.call("sessions.list", { limit: 10 })).resolves.toBeTruthy();
  running.server.broadcast("gateway.changed", { status: "off", devices: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(device.notifications).toContain("gateway.changed");

  // A reconnect uses the token instead of the password; another device can't borrow it.
  const again = remote(running);
  await expect(again.call("access.unlock", { token })).resolves.toMatchObject({ token: expect.any(String) });
  await expect(again.call("sessions.list", { limit: 10 })).resolves.toBeTruthy();
  const other = remote(running, "device-2");
  await expect(other.call("access.unlock", { token })).rejects.toMatchObject({ data: { code: "locked" } });

  // The computer itself never asks.
  await expect(local.call("sessions.list", { limit: 10 })).resolves.toBeTruthy();
  await expect(remote(running).call("access.status")).rejects.toMatchObject({ data: { code: "locked" } });
});

it("drops remote connections and voids tokens when the password changes or goes", async () => {
  const { host: running } = await host();
  const local = await connectHost(running.paths.hostSocket);
  cleanups.push(async () => local.close());
  await local.call("access.set", { password: "first" });
  const device = remote(running);
  const { token } = await device.call<{ token: string }>("access.unlock", { password: "first" });
  await expect(device.call("access.set", {})).rejects.toMatchObject({ data: { code: "forbidden" } });

  await local.call("access.set", { password: "second" });
  expect(device.closed).toBe(true);
  await expect(remote(running).call("access.unlock", { token })).rejects.toMatchObject({ data: { code: "locked" } });

  await local.call("access.set", {});
  const open = remote(running);
  expect((await open.call<{ locked?: boolean }>("machine.info")).locked).toBeUndefined();
  await expect(open.call("sessions.list", { limit: 10 })).resolves.toBeTruthy();
});

it("throttles wrong guesses per device", () => {
  const dir = join(tmpdir(), `ls-access-throttle-${process.pid}-${Date.now()}`);
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  const access = new AccessControl(dir);
  return import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(dir, { recursive: true });
    access.set("right-one");
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) expect(access.unlock("a", { password: "nope" }, now)).toEqual({ ok: false, reason: "wrong" });
    // Even the right password waits out the window once a device has guessed too often.
    expect(access.unlock("a", { password: "right-one" }, now + 1000)).toEqual({ ok: false, reason: "throttled" });
    expect(access.unlock("b", { password: "right-one" }, now + 1000)).toMatchObject({ ok: true });
    expect(access.unlock("a", { password: "right-one" }, now + 5 * 60_000 + 1)).toMatchObject({ ok: true });
    // An expired token doesn't open anything.
    const issued = access.unlock("c", { password: "right-one" }, now);
    if (!issued.ok) throw new Error("unlock failed");
    expect(access.unlock("c", { token: issued.token }, issued.expiresAt + 1)).toEqual({ ok: false, reason: "invalid_token" });
  });
});

it("stays locked when the password file is damaged", async () => {
  const { home } = await host();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(accessPath(home), "not json");
  const access = new AccessControl(home);
  expect(access.enabled).toBe(true);
  expect(access.unlock("a", { password: "" })).toEqual({ ok: false, reason: "wrong" });
});
