#!/usr/bin/env node
import { spawn } from "node:child_process";
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

function isIgnoredInterface(name) {
  return IGNORED_INTERFACE_PATTERNS.some((pattern) => pattern.test(name));
}

function isUsableIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || (a === 169 && b === 254)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function getLanIp() {
  const candidates = [];
  const nets = networkInterfaces();

  for (const [name, addrs] of Object.entries(nets)) {
    if (isIgnoredInterface(name) || !addrs) continue;
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
  return candidates[0]?.address;
}

const explicitHost = process.env.REACT_NATIVE_PACKAGER_HOSTNAME?.trim();
const host = explicitHost || getLanIp();
const env = { ...process.env };

if (host) {
  env.REACT_NATIVE_PACKAGER_HOSTNAME = host;
  console.error(`Expo LAN host: ${host}`);
} else {
  console.error("Expo LAN host: auto (no real LAN IPv4 found)");
}

const child = spawn(
  "expo",
  ["start", "--dev-client", "--host", "lan", ...process.argv.slice(2)],
  {
    env,
    stdio: "inherit",
    shell: true,
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
