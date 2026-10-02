import { join } from "node:path";
import * as daemon from "../utils/daemon.js";
import { assertHostRuntime, silenceSqliteWarning } from "./host.js";

/** Runs a gateway in this process until SIGINT/SIGTERM. */
export async function runGatewayForeground(version: string, port: number): Promise<void> {
  // The relay keeps its pairings in node:sqlite, like the host.
  assertHostRuntime();
  silenceSqliteWarning();
  const { startGateway } = await import("@linkshell/gateway");
  // Pairings live here; keeping this file keeps phones paired.
  const databasePath = join(daemon.linkshellDir(), "relay.db");
  const gateway = await startGateway({
    port,
    databasePath,
    log: (message) => process.stderr.write(`[gateway] ${message}\n`),
    // As for the Docker image: the reverse proxy in front, whose X-Forwarded-For says who is connecting.
    trustedProxies: (process.env.TRUSTED_PROXIES ?? "").split(","),
  });
  daemon.savePid("gateway", process.pid);

  process.stderr.write(`\n  LinkShell Gateway ${version}\n`);
  process.stderr.write(`  Listening on http://0.0.0.0:${gateway.port}\n`);
  process.stderr.write(`  PID: ${process.pid}\n`);
  process.stderr.write(`  Pairings: ${databasePath}\n\n`);
  process.stderr.write(`  Computers:    linkshell host --gateway ws://this-server:${gateway.port}\n`);
  process.stderr.write(`  Health check: curl http://this-server:${gateway.port}/healthz\n\n`);

  const shutdown = async () => {
    process.stderr.write("[gateway] shutting down...\n");
    daemon.removePid("gateway");
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
