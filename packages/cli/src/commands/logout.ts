import { clearAuth, loadAuth } from "../auth.js";
import { GatewayAccountLeaveError, leaveGatewayAccount } from "../gateway-account.js";
import { linkshellDir } from "../utils/daemon.js";
import { OFFICIAL_GATEWAY, refreshGateway, sameGateway, withRunningHost } from "./host.js";

export async function runLogout(): Promise<void> {
  const auth = loadAuth();
  if (!auth || !auth.accessToken) {
    process.stderr.write("\n  Not currently logged in.\n\n");
    return;
  }

  const before = await withRunningHost((client) => client.call("gateway.status", {}, 5000)).catch(() => undefined);
  clearAuth();
  if (loadAuth()?.accessToken) throw new Error("Could not remove the local account credentials; logout did not finish.");
  let unbound = before !== undefined && before.status !== "off" && !before.account && !sameGateway(before.url, OFFICIAL_GATEWAY);
  let disconnected: boolean;
  let replacedWithoutRevoking = false;
  let after: Awaited<ReturnType<typeof refreshGateway>>;
  try {
    if (before && before.status !== "off" && (before.account || sameGateway(before.url, OFFICIAL_GATEWAY))) {
      const result = await withRunningHost((client) => client.call("gateway.account.leave", {}, 10_000));
      unbound = result !== undefined;
    }
  } catch {
    unbound = false;
  } finally {
    if (!unbound && (!before || before.status === "off" || sameGateway(before.url, OFFICIAL_GATEWAY))) {
      try {
        await leaveGatewayAccount({ home: linkshellDir(), url: OFFICIAL_GATEWAY, token: auth.accessToken, name: before?.machine?.name, machineId: before?.machine?.id });
        unbound = true;
      } catch (error) {
        // Local credentials are already gone. Never claim an offline/old gateway acknowledged it.
        replacedWithoutRevoking = error instanceof GatewayAccountLeaveError && error.replaced;
      }
    }
    // Also disconnect an explicitly configured official gateway if revocation could not reach it.
    try {
      // If takeover succeeded but the gateway was too old to revoke, refreshing an
      // older Host would reconnect it with that old binding. Leave its socket replaced.
      after = replacedWithoutRevoking
        ? await withRunningHost((client) => client.call("gateway.status", {}, 5000))
        : await refreshGateway(0);
      disconnected = !after || after.status === "off" || after.status === "offline" || !sameGateway(after.url, OFFICIAL_GATEWAY);
    } catch {
      disconnected = false;
    }
  }
  process.stderr.write(`\n  \x1b[32m✓\x1b[0m Logged out locally${auth.email ? ` (${auth.email})` : ""}.\n`);
  if (!unbound) process.stderr.write("  The gateway could not confirm removing this computer's account binding. When it is reachable, remove this offline computer from your account's device list.\n");
  if (!disconnected) process.stderr.write("  The running Host could not confirm disconnecting. Stop the Host to end its existing remote connections; it will stay signed out when restarted.\n");
  if (before && before.status !== "off" && after?.status === "off") {
    process.stderr.write("  This computer is off the official gateway; the host and its sessions keep running.\n");
  }
  process.stderr.write("\n");
}
