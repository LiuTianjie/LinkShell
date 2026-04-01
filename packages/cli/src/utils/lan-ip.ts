import { networkInterfaces } from "node:os";

/**
 * Get the first non-internal IPv4 address (LAN IP).
 * Falls back to 127.0.0.1 if none found.
 */
export function getLanIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}
