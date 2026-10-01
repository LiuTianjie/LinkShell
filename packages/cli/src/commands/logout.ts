import { clearAuth, loadAuth } from "../auth.js";
import { refreshGateway, withRunningHost } from "./host.js";

export async function runLogout(): Promise<void> {
  const auth = loadAuth();
  if (!auth || !auth.accessToken) {
    process.stderr.write("\n  Not currently logged in.\n\n");
    return;
  }

  const before = await withRunningHost((client) => client.call("gateway.status", {}));
  clearAuth();
  process.stderr.write(`\n  \x1b[32m✓\x1b[0m Logged out${auth.email ? ` (${auth.email})` : ""}.\n`);
  // A running host leaves the account's gateway now, not at its next reconnect.
  const after = await refreshGateway(0);
  if (before && before.status !== "off" && after?.status === "off") {
    process.stderr.write("  This computer is off the official gateway; the host and its sessions keep running.\n");
  }
  process.stderr.write("\n");
}
