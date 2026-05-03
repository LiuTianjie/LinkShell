import { networkInterfaces } from "node:os";

const IGNORED_INTERFACE_PATTERNS = [
  /^lo\d*$/i,
  /^bridge\d*$/i,
  /^utun\d*$/i,
  /^awdl\d*$/i,
  /^llw\d*$/i,
  /^vmnet\d*$/i,
  /^vboxnet\d*$/i,
  /^docker\d*$/i,
  /^br-/i,
  /^tun\d*$/i,
  /^tap\d*$/i,
];

function isIgnoredInterface(name: string): boolean {
  return IGNORED_INTERFACE_PATTERNS.some((pattern) => pattern.test(name));
}

function isUsableIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 169 && b === 254) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/**
 * Get the best non-internal IPv4 address (LAN IP).
 *
 * macOS often exposes virtual bridge/VPN interfaces before Wi-Fi/Ethernet,
 * which can produce QR codes that phones cannot reach. Prefer real LAN
 * interfaces and ignore virtual point-to-point bridges.
 * Falls back to 127.0.0.1 if none found.
 */
export function getLanIp(): string {
  const nets = networkInterfaces();
  const candidates: Array<{ address: string; score: number }> = [];

  for (const name of Object.keys(nets)) {
    if (isIgnoredInterface(name)) continue;
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal || !isUsableIpv4(addr.address)) continue;
      const score =
        /^en\d+$/i.test(name) ? 100 :
        /^(eth|wlan|wifi|wi-fi)/i.test(name) ? 90 :
        10;
      candidates.push({ address: addr.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0].address;
  return "127.0.0.1";
}
