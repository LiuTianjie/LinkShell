import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, platform } from "node:os";
import WebSocket from "ws";
import { RELAY_PATH, RelayClient, type Identity, type RelaySocket } from "@linkshell/wire";

export class GatewayAccountLeaveError extends Error {
  constructor(message: string, readonly replaced: boolean) { super(message); }
}

/** Revoke with the existing machine key when a stopped/older Host cannot do it. */
export async function leaveGatewayAccount(options: { home: string; url: string; token: string; name?: string; machineId?: string }): Promise<void> {
  const identity = JSON.parse(readFileSync(join(options.home, "identity.json"), "utf8")) as Identity;
  if (!identity.id || !identity.signSecret || !identity.boxSecret || (options.machineId && options.machineId !== identity.id)) {
    throw new Error("The computer identity is unavailable.");
  }
  const url = new URL(options.url.replace(/^http/i, "ws"));
  if (!url.pathname.endsWith(RELAY_PATH)) url.pathname = url.pathname.replace(/\/$/, "") + RELAY_PATH;
  const relay = new RelayClient({
    url: url.toString(), identity, role: "machine", name: options.name ?? hostname(), platform: platform(),
    token: () => options.token,
    createSocket: (target) => new WebSocket(target, { perMessageDeflate: false }) as unknown as RelaySocket,
  });
  // Taking over this identity also ends an older Host's existing tunnels. A
  // 'replaced' connection does not automatically reconnect and fight the logout.
  relay.start();
  let replaced = false;
  try {
    if (!(await relay.waitOnline(10_000))) throw new Error("The gateway could not be reached to remove the account binding.");
    replaced = true;
    await relay.request("account.leave", {}, 5000);
  } catch (error) {
    throw new GatewayAccountLeaveError(error instanceof Error ? error.message : String(error), replaced);
  } finally {
    relay.stop();
  }
}
