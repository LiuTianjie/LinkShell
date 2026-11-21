import { createSocket, type RemoteInfo } from "node:dgram";
import { networkInterfaces } from "node:os";

export const MDNS_MULTICAST_ADDR = "224.0.0.251";
export const MDNS_PORT = 5353;
export const LINKSHELL_SERVICE_TYPE = "_linkshell._tcp.local";

export const DNS_TYPE_A = 1;
export const DNS_TYPE_PTR = 12;
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_SRV = 33;
export const DNS_CLASS_IN = 1;
export const DNS_QU_BIT = 0x8000;

const DEFAULT_QUERY_INTERVAL_MS = 5_000;
const DEFAULT_PRUNE_INTERVAL_MS = 2_000;

export interface MdnsBrowserSocketLike {
  bind(port: number, address?: string, callback?: () => void): void;
  send(
    msg: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback?: (error: Error | null) => void,
  ): void;
  close(callback?: () => void): void;
  on(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "listening", listener: () => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  addMembership(multicastAddress: string, multicastInterface?: string): void;
  setMulticastLoopback?(flag: boolean): void;
  unref?(): void;
}

export interface MdnsQuestion {
  name: string;
  type: number;
  qclass: number;
  unicastResponse: boolean;
}

export interface MdnsResourceRecord {
  name: string;
  type: number;
  rclass: number;
  cacheFlush: boolean;
  ttl: number;
  rdata: Buffer;
  ptr?: string;
  txt?: string[];
  srv?: { priority: number; weight: number; port: number; target: string };
  a?: string;
}

export interface MdnsParsedPacket {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: MdnsQuestion[];
  answers: MdnsResourceRecord[];
  authorities: MdnsResourceRecord[];
  additionals: MdnsResourceRecord[];
}

export interface LinkshellTxtMetadata {
  protocolVersion?: number;
  machineId?: string;
  fingerprint?: string;
  hostPort?: number;
  name?: string;
  raw: Record<string, string>;
}

export interface LanHostEntry {
  instanceName: string;
  machineId: string;
  fingerprint: string;
  name?: string;
  protocolVersion?: number;
  host?: string;
  addresses: string[];
  port: number;
  hostPort?: number;
  srvPort?: number;
  lastSeen: number;
  ttl: number;
}

export interface MdnsLanBrowserOptions {
  serviceType?: string;
  queryIntervalMs?: number;
  pruneIntervalMs?: number;
  socketFactory?: () => MdnsBrowserSocketLike;
  now?: () => number;
  log?: (message: string) => void;
}

function normalizeDnsName(name: string): string {
  return name.replace(/\.+$/, "").toLowerCase();
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function localIpv4Interfaces(): string[] {
  const addresses: string[] = [];
  const ifaces = networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
}

/** Encodes a DNS name (`_linkshell._tcp.local`) into uncompressed label wire format. */
export function encodeDnsName(name: string): Buffer {
  const clean = name.replace(/\.+$/, "");
  if (!clean) return Buffer.from([0]);
  const parts = clean.split(".").filter(Boolean);
  const chunks: Buffer[] = [];
  for (const label of parts) {
    const encoded = Buffer.from(label, "utf8");
    if (encoded.length === 0 || encoded.length > 63) {
      throw new Error(`Invalid DNS label length for "${label}"`);
    }
    chunks.push(Buffer.from([encoded.length]), encoded);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Decodes a DNS name at `offset`, safely following RFC 1035 compression pointers (`0xc0`). */
export function decodeDnsName(
  packet: Buffer,
  offset: number,
): { name: string; nextOffset: number } | undefined {
  if (offset < 0 || offset >= packet.length) return undefined;
  const labels: string[] = [];
  let cursor = offset;
  let nextOffset = offset;
  let jumped = false;
  const visited = new Set<number>();

  while (true) {
    if (cursor >= packet.length) return undefined;
    const len = packet[cursor]!;
    if (len === 0) {
      if (!jumped) nextOffset = cursor + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (cursor + 1 >= packet.length) return undefined;
      const pointer = ((len & 0x3f) << 8) | packet[cursor + 1]!;
      if (pointer >= packet.length || visited.has(pointer) || visited.size >= 32) {
        return undefined;
      }
      visited.add(pointer);
      if (!jumped) nextOffset = cursor + 2;
      jumped = true;
      cursor = pointer;
      continue;
    }
    if ((len & 0xc0) !== 0) return undefined;
    const start = cursor + 1;
    const end = start + len;
    if (end > packet.length) return undefined;
    labels.push(packet.subarray(start, end).toString("utf8"));
    cursor = end;
    if (!jumped) nextOffset = end;
  }

  return { name: labels.join("."), nextOffset };
}

/** Builds a standard mDNS PTR query packet for `_linkshell._tcp.local`. */
export function buildMdnsPtrQueryPacket(
  serviceType = LINKSHELL_SERVICE_TYPE,
  unicastResponse = false,
): Buffer {
  const qname = encodeDnsName(serviceType);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // mDNS queries use transaction ID 0.
  header.writeUInt16BE(0, 2); // Standard query flags = 0.
  header.writeUInt16BE(1, 4); // QDCOUNT = 1.
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(DNS_TYPE_PTR, 0);
  tail.writeUInt16BE(DNS_CLASS_IN | (unicastResponse ? DNS_QU_BIT : 0), 2);
  return Buffer.concat([header, qname, tail]);
}

function parseTxtRdata(rdata: Buffer): string[] {
  const out: string[] = [];
  let offset = 0;
  while (offset < rdata.length) {
    const len = rdata[offset]!;
    offset += 1;
    if (offset + len > rdata.length) break;
    out.push(rdata.subarray(offset, offset + len).toString("utf8"));
    offset += len;
  }
  return out;
}

function parseRrList(
  packet: Buffer,
  startOffset: number,
  count: number,
): { records: MdnsResourceRecord[]; nextOffset: number } | undefined {
  let cursor = startOffset;
  const records: MdnsResourceRecord[] = [];
  for (let i = 0; i < count; i++) {
    const decodedName = decodeDnsName(packet, cursor);
    if (!decodedName) return undefined;
    cursor = decodedName.nextOffset;
    if (cursor + 10 > packet.length) return undefined;
    const type = packet.readUInt16BE(cursor);
    const rawClass = packet.readUInt16BE(cursor + 2);
    const cacheFlush = (rawClass & 0x8000) !== 0;
    const rclass = rawClass & 0x7fff;
    const ttl = packet.readUInt32BE(cursor + 4);
    const rdlength = packet.readUInt16BE(cursor + 8);
    cursor += 10;
    if (cursor + rdlength > packet.length) return undefined;
    const rdataStart = cursor;
    const rdata = packet.subarray(rdataStart, rdataStart + rdlength);
    cursor += rdlength;

    const record: MdnsResourceRecord = {
      name: decodedName.name,
      type,
      rclass,
      cacheFlush,
      ttl,
      rdata,
    };

    if (type === DNS_TYPE_PTR) {
      const ptr = decodeDnsName(packet, rdataStart);
      if (ptr) record.ptr = ptr.name;
    } else if (type === DNS_TYPE_TXT) {
      record.txt = parseTxtRdata(rdata);
    } else if (type === DNS_TYPE_SRV && rdlength >= 6) {
      const target = decodeDnsName(packet, rdataStart + 6);
      if (target) {
        record.srv = {
          priority: packet.readUInt16BE(rdataStart),
          weight: packet.readUInt16BE(rdataStart + 2),
          port: packet.readUInt16BE(rdataStart + 4),
          target: target.name,
        };
      }
    } else if (type === DNS_TYPE_A && rdlength === 4) {
      record.a = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
    }

    records.push(record);
  }
  return { records, nextOffset: cursor };
}

/** Parses an incoming UDP mDNS packet into questions and typed resource records. */
export function parseMdnsResponsePacket(packet: Buffer): MdnsParsedPacket | undefined {
  if (packet.length < 12) return undefined;
  const id = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  const qdCount = packet.readUInt16BE(4);
  const anCount = packet.readUInt16BE(6);
  const nsCount = packet.readUInt16BE(8);
  const arCount = packet.readUInt16BE(10);

  let cursor = 12;
  const questions: MdnsQuestion[] = [];
  for (let i = 0; i < qdCount; i++) {
    const qname = decodeDnsName(packet, cursor);
    if (!qname) return undefined;
    cursor = qname.nextOffset;
    if (cursor + 4 > packet.length) return undefined;
    const type = packet.readUInt16BE(cursor);
    const rawClass = packet.readUInt16BE(cursor + 2);
    cursor += 4;
    questions.push({
      name: qname.name,
      type,
      qclass: rawClass & 0x7fff,
      unicastResponse: (rawClass & DNS_QU_BIT) !== 0,
    });
  }

  const answers = parseRrList(packet, cursor, anCount);
  if (!answers) return undefined;
  const authorities = parseRrList(packet, answers.nextOffset, nsCount);
  if (!authorities) return undefined;
  const additionals = parseRrList(packet, authorities.nextOffset, arCount);
  if (!additionals) return undefined;

  return {
    id,
    flags,
    isResponse: (flags & 0x8000) !== 0,
    questions,
    answers: answers.records,
    authorities: authorities.records,
    additionals: additionals.records,
  };
}

/** Parses LinkShell DNS-SD TXT entries (`v`, `mid`, `fp`, `hostport`, `name`). */
export function parseLinkshellTxtRecords(entries: readonly string[]): LinkshellTxtMetadata {
  const raw: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      if (entry) raw[entry.toLowerCase()] = "";
      continue;
    }
    const key = entry.slice(0, eq).trim().toLowerCase();
    const val = entry.slice(eq + 1);
    if (!key) continue;
    raw[key] = val;
  }

  const vNum = raw.v !== undefined ? Number(raw.v) : undefined;
  const protocolVersion =
    vNum !== undefined && Number.isInteger(vNum) && vNum > 0 ? vNum : undefined;

  const hpNum = raw.hostport !== undefined ? Number(raw.hostport) : undefined;
  const hostPort =
    hpNum !== undefined && Number.isInteger(hpNum) && hpNum > 0 && hpNum <= 65535
      ? hpNum
      : undefined;

  const machineId = raw.mid?.trim() || undefined;
  const fingerprint = raw.fp?.trim() || undefined;
  const name = raw.name?.trim() || undefined;

  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(machineId ? { machineId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(name ? { name } : {}),
    raw,
  };
}

interface PtrCacheEntry {
  instanceName: string;
  expiresAt: number;
  ttl: number;
  lastSeen: number;
}

interface SrvCacheEntry {
  target: string;
  port: number;
  expiresAt: number;
  ttl: number;
  lastSeen: number;
  fallbackAddress?: string;
}

interface TxtCacheEntry {
  meta: LinkshellTxtMetadata;
  expiresAt: number;
  ttl: number;
  lastSeen: number;
}

interface ACacheEntry {
  expiresAt: number;
  lastSeen: number;
}

/**
 * Zero-dependency mDNS / DNS-SD LAN browser for `_linkshell._tcp.local`.
 * Listens on UDP multicast `224.0.0.251:5353`, periodically queries PTR records,
 * resolves SRV + TXT + A records with TTL expiration, and notifies subscribers on change.
 */
export class MdnsLanBrowser {
  private readonly serviceType: string;
  private readonly serviceKey: string;
  private readonly queryIntervalMs: number;
  private readonly pruneIntervalMs: number;
  private readonly socketFactory: () => MdnsBrowserSocketLike;
  private readonly now: () => number;
  private readonly log?: (message: string) => void;

  private socket?: MdnsBrowserSocketLike;
  private running = false;
  private ready = false;
  private queryTimer?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private burstTimers: Array<ReturnType<typeof setTimeout>> = [];

  private readonly ptrs = new Map<string, PtrCacheEntry>();
  private readonly srvs = new Map<string, SrvCacheEntry>();
  private readonly txts = new Map<string, TxtCacheEntry>();
  private readonly aRecords = new Map<string, Map<string, ACacheEntry>>();
  private readonly listeners = new Set<(hosts: LanHostEntry[]) => void>();
  private lastSnapshotJson = "[]";
  private cachedHosts: LanHostEntry[] = [];

  constructor(options: MdnsLanBrowserOptions = {}) {
    this.serviceType = options.serviceType ?? LINKSHELL_SERVICE_TYPE;
    this.serviceKey = normalizeDnsName(this.serviceType);
    this.queryIntervalMs = options.queryIntervalMs ?? DEFAULT_QUERY_INTERVAL_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.socketFactory =
      options.socketFactory ??
      (() => createSocket({ type: "udp4", reuseAddr: true }) as unknown as MdnsBrowserSocketLike);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      if (this.ready) this.refresh();
      return;
    }
    this.running = true;
    this.ready = false;

    let sock: MdnsBrowserSocketLike;
    try {
      sock = this.socketFactory();
    } catch (error) {
      this.running = false;
      this.log?.(`[mdns-browser] failed to create UDP socket: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.socket = sock;

    sock.on("error", (err) => {
      this.log?.(`[mdns-browser] UDP socket error: ${err.message}`);
    });
    sock.on("message", (msg, rinfo) => {
      if (!this.running || this.socket !== sock) return;
      this.ingestPacket(msg, rinfo?.address);
    });
    sock.on("listening", () => {
      if (!this.running || this.socket !== sock) return;
      this.ready = true;
      try {
        sock.setMulticastLoopback?.(true);
      } catch {
        // Ignore platform errors when loopback option isn't supported.
      }
      try {
        sock.addMembership(MDNS_MULTICAST_ADDR);
      } catch (error) {
        this.log?.(`[mdns-browser] default multicast join failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const iface of localIpv4Interfaces()) {
        try {
          sock.addMembership(MDNS_MULTICAST_ADDR, iface);
        } catch {
          // Best-effort join on extra interfaces.
        }
      }

      this.refresh();
      this.burstTimers = [250, 1_000].map((delay) => {
        const timer = setTimeout(() => {
          if (this.running && this.ready) this.refresh();
        }, delay);
        timer.unref?.();
        return timer;
      });
    });

    try {
      sock.bind(MDNS_PORT, "0.0.0.0", () => {
        sock.unref?.();
      });
    } catch (error) {
      this.log?.(`[mdns-browser] bind failed: ${error instanceof Error ? error.message : String(error)}`);
      void this.stop();
      return;
    }

    this.queryTimer = setInterval(() => {
      if (this.running && this.ready) this.refresh();
    }, this.queryIntervalMs);
    this.queryTimer.unref?.();

    this.pruneTimer = setInterval(() => {
      this.pruneExpired();
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  refresh(): void {
    if (!this.running || !this.ready || !this.socket) return;
    const packet = buildMdnsPtrQueryPacket(this.serviceType);
    try {
      this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR, (err) => {
        if (err) this.log?.(`[mdns-browser] query send failed: ${err.message}`);
      });
    } catch (error) {
      this.log?.(`[mdns-browser] query send threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): Promise<void> {
    this.running = false;
    this.ready = false;
    clearInterval(this.queryTimer);
    this.queryTimer = undefined;
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    for (const timer of this.burstTimers) clearTimeout(timer);
    this.burstTimers = [];

    const sock = this.socket;
    this.socket = undefined;
    this.ptrs.clear();
    this.srvs.clear();
    this.txts.clear();
    this.aRecords.clear();
    this.recompute(true);

    if (!sock) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        sock.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  getHosts(): LanHostEntry[] {
    this.pruneExpired();
    return this.cachedHosts.map((host) => ({
      ...host,
      addresses: [...host.addresses],
    }));
  }

  onChange(listener: (hosts: LanHostEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Decodes a raw mDNS UDP packet and updates internal PTR/SRV/TXT/A caches. */
  ingestPacket(packet: Buffer, remoteAddress?: string): void {
    const parsed = parseMdnsResponsePacket(packet);
    if (!parsed || !parsed.isResponse) return;

    const currentTime = this.now();
    const validRemoteIp = remoteAddress && isValidIpv4(remoteAddress) ? remoteAddress : undefined;
    const records = [...parsed.answers, ...parsed.authorities, ...parsed.additionals];
    let dirty = false;

    for (const rr of records) {
      if (rr.rclass !== DNS_CLASS_IN) continue;
      const rrKey = normalizeDnsName(rr.name);

      if (rr.type === DNS_TYPE_PTR && rr.ptr && rrKey === this.serviceKey) {
        const instanceKey = normalizeDnsName(rr.ptr);
        if (rr.ttl === 0) {
          if (this.ptrs.delete(instanceKey)) dirty = true;
        } else {
          this.ptrs.set(instanceKey, {
            instanceName: rr.ptr,
            ttl: rr.ttl,
            expiresAt: currentTime + rr.ttl * 1_000,
            lastSeen: currentTime,
          });
          dirty = true;
        }
        continue;
      }

      if (rr.type === DNS_TYPE_SRV && rr.srv) {
        if (rr.ttl === 0) {
          if (this.srvs.delete(rrKey)) dirty = true;
        } else if (rrKey.endsWith(`.${this.serviceKey}`) || this.ptrs.has(rrKey)) {
          this.srvs.set(rrKey, {
            target: rr.srv.target,
            port: rr.srv.port,
            ttl: rr.ttl,
            expiresAt: currentTime + rr.ttl * 1_000,
            lastSeen: currentTime,
            ...(validRemoteIp ? { fallbackAddress: validRemoteIp } : {}),
          });
          dirty = true;
        }
        continue;
      }

      if (rr.type === DNS_TYPE_TXT && rr.txt) {
        if (rr.ttl === 0) {
          if (this.txts.delete(rrKey)) dirty = true;
        } else if (rrKey.endsWith(`.${this.serviceKey}`) || this.ptrs.has(rrKey)) {
          const meta = parseLinkshellTxtRecords(rr.txt);
          if (meta.machineId && meta.fingerprint) {
            this.txts.set(rrKey, {
              meta,
              ttl: rr.ttl,
              expiresAt: currentTime + rr.ttl * 1_000,
              lastSeen: currentTime,
            });
            dirty = true;
          }
        }
        continue;
      }

      if (rr.type === DNS_TYPE_A && rr.a && isValidIpv4(rr.a)) {
        if (rr.cacheFlush && rr.ttl > 0) {
          this.aRecords.set(rrKey, new Map([[rr.a, { expiresAt: currentTime + rr.ttl * 1_000, lastSeen: currentTime }]]));
          dirty = true;
        } else {
          let map = this.aRecords.get(rrKey);
          if (rr.ttl === 0) {
            if (map?.delete(rr.a)) {
              if (map.size === 0) this.aRecords.delete(rrKey);
              dirty = true;
            }
          } else {
            if (!map) {
              map = new Map();
              this.aRecords.set(rrKey, map);
            }
            map.set(rr.a, {
              expiresAt: currentTime + rr.ttl * 1_000,
              lastSeen: currentTime,
            });
            dirty = true;
          }
        }
      }
    }

    if (dirty || this.pruneExpiredInternal(currentTime)) {
      this.recompute(true);
    }
  }

  /** Removes expired PTR, SRV, TXT, and A records and notifies listeners if hosts changed. */
  pruneExpired(): boolean {
    const removed = this.pruneExpiredInternal(this.now());
    if (removed) {
      this.recompute(true);
    }
    return removed;
  }

  private pruneExpiredInternal(currentTime: number): boolean {
    let changed = false;
    for (const [key, entry] of this.ptrs) {
      if (currentTime >= entry.expiresAt) {
        this.ptrs.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of this.srvs) {
      if (currentTime >= entry.expiresAt) {
        this.srvs.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of this.txts) {
      if (currentTime >= entry.expiresAt) {
        this.txts.delete(key);
        changed = true;
      }
    }
    for (const [hostKey, ipMap] of this.aRecords) {
      for (const [ip, entry] of ipMap) {
        if (currentTime >= entry.expiresAt) {
          ipMap.delete(ip);
          changed = true;
        }
      }
      if (ipMap.size === 0) this.aRecords.delete(hostKey);
    }
    return changed;
  }

  private recompute(emit: boolean): void {
    const keys = new Set<string>([...this.ptrs.keys(), ...this.srvs.keys()]);
    const entries: LanHostEntry[] = [];

    for (const instanceKey of keys) {
      const txt = this.txts.get(instanceKey);
      const srv = this.srvs.get(instanceKey);
      const ptr = this.ptrs.get(instanceKey);
      if (!txt?.meta.machineId || !txt.meta.fingerprint) continue;
      if (!ptr && !srv) continue;

      const targetKey = srv ? normalizeDnsName(srv.target) : undefined;
      const resolvedIps = targetKey ? [...(this.aRecords.get(targetKey)?.keys() ?? [])] : [];
      const addresses =
        resolvedIps.length > 0
          ? resolvedIps.sort()
          : srv?.fallbackAddress
            ? [srv.fallbackAddress]
            : [];

      const srvPort = srv?.port && srv.port > 0 ? srv.port : undefined;
      const hostPort = txt.meta.hostPort;
      const effectivePort = hostPort ?? srvPort ?? 0;
      const lastSeen = Math.max(ptr?.lastSeen ?? 0, srv?.lastSeen ?? 0, txt.lastSeen);
      const ttl = Math.min(
        ptr?.ttl ?? Number.MAX_SAFE_INTEGER,
        srv?.ttl ?? Number.MAX_SAFE_INTEGER,
        txt.ttl,
      );

      entries.push({
        instanceName: ptr?.instanceName ?? instanceKey,
        machineId: txt.meta.machineId,
        fingerprint: txt.meta.fingerprint,
        ...(txt.meta.name ? { name: txt.meta.name } : {}),
        ...(txt.meta.protocolVersion !== undefined
          ? { protocolVersion: txt.meta.protocolVersion }
          : {}),
        ...(srv?.target ? { host: srv.target } : {}),
        addresses,
        port: effectivePort,
        ...(hostPort !== undefined ? { hostPort } : {}),
        ...(srvPort !== undefined ? { srvPort } : {}),
        lastSeen,
        ttl: ttl === Number.MAX_SAFE_INTEGER ? 0 : ttl,
      });
    }

    entries.sort((a, b) => {
      const nameDiff = (a.name ?? a.machineId).localeCompare(b.name ?? b.machineId);
      if (nameDiff !== 0) return nameDiff;
      return a.instanceName.localeCompare(b.instanceName);
    });

    const compareShape = JSON.stringify(
      entries.map(({ lastSeen: _ts, ttl: _ttl, ...stable }) => stable),
    );
    const changed = compareShape !== this.lastSnapshotJson;
    this.cachedHosts = entries;
    if (changed) {
      this.lastSnapshotJson = compareShape;
      if (emit) {
        const snapshot = this.getHosts();
        for (const listener of this.listeners) {
          try {
            listener(snapshot);
          } catch {
            // Listener failures never break discovery updates.
          }
        }
      }
    }
  }
}
