import { useEffect } from "react";
import type { PublicIdentity } from "@linkshell/wire";

export interface DiscoveredLanHost {
  name: string;
  host: string;
  port: number;
  machineId?: string;
  fingerprint?: string;
  displayName?: string;
}

export type LanMatchReason = "machineId" | "fingerprint" | "url";

export interface LanReachabilityHint {
  url: string;
  displayName: string;
  host: DiscoveredLanHost;
  matchedBy: LanMatchReason;
}

export interface LanMatchableComputer {
  key: string;
  kind: "relay" | "direct";
  url?: string;
  name?: string;
  lanUrl?: string;
  machine?: Pick<PublicIdentity, "id" | "signKey">;
}

// Standard FIPS 180-4 SHA-256 initial hash values and round constants so fingerprint matching
// works synchronously across Hermes (React Native) and Node test environments without external deps.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function encodeUtf8(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
        i += 1;
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/** Computes a lowercase hex SHA-256 digest of `input`. */
export function sha256Hex(input: string): string {
  const bytes = encodeUtf8(input);
  const bitLen = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLen >>> 0, false);

  const hash = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** Matches `packages/host/src/mdns.ts` primary `identity.id` fingerprint (first 24 hex chars). */
export function lanHostFingerprint(identityId: string): string {
  return sha256Hex(identityId).slice(0, 24);
}

/** Matches `packages/host/src/mdns.ts` fallback `linkshell-machine:${machineId}` fingerprint. */
export function lanHostMachineFallbackFingerprint(machineId: string): string {
  return sha256Hex(`linkshell-machine:${machineId}`).slice(0, 24);
}

/** Builds a normalized `ws://host:port` URL from a discovered LAN host. */
export function lanHostUrl(host: Pick<DiscoveredLanHost, "host" | "port">): string | undefined {
  const rawHost = host.host?.trim();
  if (!rawHost) return undefined;
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) return undefined;
  const formattedHost = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  try {
    const parsed = new URL(`ws://${formattedHost}:${host.port}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

export function lanHostDisplayName(host: Pick<DiscoveredLanHost, "displayName" | "name" | "host">): string {
  return host.displayName?.trim() || host.name?.trim() || host.host.trim() || "局域网电脑";
}

function lanHostDedupeKey(host: DiscoveredLanHost): string {
  const mid = host.machineId?.trim();
  if (mid) return `mid:${mid}`;
  const fp = host.fingerprint?.trim().toLowerCase();
  if (fp) return `fp:${fp}`;
  const url = lanHostUrl(host);
  if (url) return `url:${url}`;
  return `name:${host.name.trim()}`;
}

/** Deduplicates and merges discovered mDNS hosts, preserving valid endpoints and richer metadata. */
export function mergeDiscoveredLanHosts(
  current: readonly DiscoveredLanHost[],
  incoming: readonly DiscoveredLanHost[],
): DiscoveredLanHost[] {
  const map = new Map<string, DiscoveredLanHost>();
  for (const host of current) {
    if (!lanHostUrl(host)) continue;
    map.set(lanHostDedupeKey(host), host);
  }
  for (const host of incoming) {
    if (!lanHostUrl(host)) continue;
    const key = lanHostDedupeKey(host);
    const prev = map.get(key);
    map.set(key, prev ? {
      ...prev,
      ...host,
      machineId: host.machineId?.trim() || prev.machineId,
      fingerprint: host.fingerprint?.trim() || prev.fingerprint,
      displayName: host.displayName?.trim() || prev.displayName,
    } : host);
  }
  return [...map.values()].sort((a, b) => lanHostDisplayName(a).localeCompare(lanHostDisplayName(b)));
}

/** Replaces the live mDNS snapshot cleanly with valid normalized hosts sorted by name. */
export function normalizeDiscoveredLanHosts(hosts: readonly DiscoveredLanHost[]): DiscoveredLanHost[] {
  return mergeDiscoveredLanHosts([], hosts);
}

/** Checks whether a discovered mDNS host corresponds to a saved/known computer by machineId, fingerprint, or URL. */
export function matchLanHostToComputer(
  host: DiscoveredLanHost,
  computer: LanMatchableComputer,
): LanMatchReason | undefined {
  const machineId = computer.machine?.id?.trim();
  const hostMachineId = host.machineId?.trim();
  if (machineId && hostMachineId && machineId === hostMachineId) {
    return "machineId";
  }

  const hostFingerprint = host.fingerprint?.trim().toLowerCase();
  if (machineId && hostFingerprint) {
    if (
      hostFingerprint === lanHostFingerprint(machineId) ||
      hostFingerprint === lanHostMachineFallbackFingerprint(machineId)
    ) {
      return "fingerprint";
    }
  }

  const discoveredUrl = lanHostUrl(host);
  if (discoveredUrl) {
    if (computer.kind === "direct" && computer.url) {
      const normalized = lanHostUrlSafeCompare(computer.url);
      if (normalized && normalized === discoveredUrl) return "url";
    }
    if (computer.lanUrl) {
      const normalized = lanHostUrlSafeCompare(computer.lanUrl);
      if (normalized && normalized === discoveredUrl) return "url";
    }
  }
  return undefined;
}

function lanHostUrlSafeCompare(raw: string): string | undefined {
  try {
    const parsed = new URL(raw.includes("://") ? raw : `ws://${raw}`);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined;
    const port = parsed.port || (parsed.protocol === "ws:" ? "7878" : "");
    return `ws://${parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return undefined;
  }
}

/** Resolves the best LAN reachability hint for a single computer given live mDNS hosts. */
export function resolveLanReachabilityHint(
  computer: LanMatchableComputer,
  hosts: readonly DiscoveredLanHost[],
): LanReachabilityHint | undefined {
  let best: LanReachabilityHint | undefined;
  const priority: Record<LanMatchReason, number> = { machineId: 3, fingerprint: 2, url: 1 };
  for (const host of hosts) {
    const matchedBy = matchLanHostToComputer(host, computer);
    if (!matchedBy) continue;
    const url = lanHostUrl(host);
    if (!url) continue;
    if (!best || priority[matchedBy] > priority[best.matchedBy]) {
      best = {
        url,
        displayName: lanHostDisplayName(host),
        host,
        matchedBy,
      };
    }
  }
  return best;
}

/** Annotates every computer with its live LAN reachability hint when reachable on the local network. */
export function annotateComputersWithLan<T extends LanMatchableComputer>(
  computers: readonly T[],
  hosts: readonly DiscoveredLanHost[],
): Array<T & { lanReachable?: boolean; lanDiscoveredUrl?: string; lanMatchedBy?: LanMatchReason }> {
  if (hosts.length === 0) return computers as Array<T & { lanReachable?: boolean; lanDiscoveredUrl?: string; lanMatchedBy?: LanMatchReason }>;
  return computers.map((computer) => {
    const hint = resolveLanReachabilityHint(computer, hosts);
    if (!hint) return computer;
    return {
      ...computer,
      lanReachable: true,
      lanDiscoveredUrl: hint.url,
      lanMatchedBy: hint.matchedBy,
    };
  });
}

/** Finds discovered LAN hosts that do not match any currently listed computer. */
export function findUnmatchedLanHosts(
  computers: readonly LanMatchableComputer[],
  hosts: readonly DiscoveredLanHost[],
): DiscoveredLanHost[] {
  return hosts.filter((host) => !computers.some((computer) => matchLanHostToComputer(host, computer)));
}

export interface LanDiscoveryBridge {
  hasDiscovery(): boolean;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  getHosts(): Promise<DiscoveredLanHost[]>;
  subscribe(listener: (event: { hosts: DiscoveredLanHost[] }) => void): () => void;
}

const noopBridge: LanDiscoveryBridge = {
  hasDiscovery: () => false,
  start: () => Promise.resolve(false),
  stop: () => Promise.resolve(),
  getHosts: () => Promise.resolve([]),
  subscribe: () => () => {},
};

let activeBridge: LanDiscoveryBridge = noopBridge;

/** Binds the native `link-layout` mDNS bridge from UI/runtime layers without pulling Expo into pure store modules. */
export function bindLanDiscoveryBridge(bridge: LanDiscoveryBridge): void {
  activeBridge = bridge;
}

/** Refcounted native mDNS discovery manager, extracted for deterministic lifecycle unit tests. */
export function createLanDiscoveryController(
  bridge: LanDiscoveryBridge,
  onHosts: (hosts: DiscoveredLanHost[]) => void,
) {
  let refs = 0;
  let unsubscribe: (() => void) | null = null;
  let sawEvent = false;
  let generation = 0;

  const startLocked = () => {
    if (!bridge.hasDiscovery()) return;
    generation += 1;
    const token = generation;
    sawEvent = false;
    unsubscribe?.();
    unsubscribe = bridge.subscribe((event) => {
      if (token !== generation || refs === 0) return;
      sawEvent = true;
      onHosts(normalizeDiscoveredLanHosts(event.hosts ?? []));
    });
    void bridge.start().catch(() => false);
    void bridge
      .getHosts()
      .then((hosts) => {
        if (token !== generation || refs === 0 || sawEvent) return;
        onHosts(normalizeDiscoveredLanHosts(hosts ?? []));
      })
      .catch(() => {});
  };

  const stopLocked = () => {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    void bridge.stop().catch(() => {});
  };

  return {
    acquire(): () => void {
      refs += 1;
      if (refs === 1) startLocked();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refs = Math.max(0, refs - 1);
        if (refs === 0) stopLocked();
      };
    },
    async refresh(): Promise<DiscoveredLanHost[]> {
      if (!bridge.hasDiscovery()) return [];
      const hosts = normalizeDiscoveredLanHosts(await bridge.getHosts().catch(() => []));
      onHosts(hosts);
      return hosts;
    },
    activeCount: () => refs,
  };
}

let hostsSink: (hosts: DiscoveredLanHost[]) => void = () => {};

/** Registers the store setter used by the global native LAN discovery controller. */
export function bindLanHostsSink(sink: (hosts: DiscoveredLanHost[]) => void): void {
  hostsSink = sink;
}

const sharedController = createLanDiscoveryController(
  {
    hasDiscovery: () => activeBridge.hasDiscovery(),
    start: () => activeBridge.start(),
    stop: () => activeBridge.stop(),
    getHosts: () => activeBridge.getHosts(),
    subscribe: (listener) => activeBridge.subscribe(listener),
  },
  (hosts) => {
    hostsSink(hosts);
  },
);

export function isLanDiscoveryAvailable(): boolean {
  return activeBridge.hasDiscovery();
}

export function acquireLanDiscovery(): () => void {
  return sharedController.acquire();
}

export function refreshLanDiscovery(): Promise<DiscoveredLanHost[]> {
  return sharedController.refresh();
}

/** Keeps native LAN mDNS discovery active while `enabled` is true. */
export function useLanDiscovery(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return acquireLanDiscovery();
  }, [enabled]);
}
