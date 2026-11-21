import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { trackChild } from "./children.js";

export const MDNS_MULTICAST_ADDR = "224.0.0.251";
export const MDNS_PORT = 5353;
export const MDNS_DEFAULT_TTL = 120;
export const LINKSHELL_SERVICE_TYPE = "_linkshell._tcp.local";
export const DNS_SD_ENUM_TYPE = "_services._dns-sd._udp.local";

export const DNS_TYPE_A = 1;
export const DNS_TYPE_PTR = 12;
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_SRV = 33;
export const DNS_TYPE_ANY = 255;
export const DNS_CLASS_IN = 1;
export const DNS_CACHE_FLUSH_BIT = 0x8000;

export interface MdnsSocketLike {
  bind(port: number, address?: string, callback?: () => void): void;
  send(msg: Buffer, offset: number, length: number, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  on(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "listening", listener: () => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  addMembership(multicastAddress: string, multicastInterface?: string): void;
  dropMembership?(multicastAddress: string, multicastInterface?: string): void;
  setMulticastTTL?(ttl: number): void;
  setMulticastLoopback?(flag: boolean): void;
  unref?(): void;
}

export interface MdnsAdvertiseOptions {
  port: number;
  machineId: string;
  fingerprint: string;
  protocolVersion: number;
  machineName?: string;
  hostPort?: number;
  platform?: NodeJS.Platform;
  ttlSeconds?: number;
  ipv4Addresses?: string[];
  socketFactory?: () => MdnsSocketLike;
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  log?: (message: string) => void;
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

export interface MdnsPacket {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: MdnsQuestion[];
  answers: MdnsResourceRecord[];
  authorities: MdnsResourceRecord[];
  additionals: MdnsResourceRecord[];
}

export interface MdnsRecordInput {
  name: string;
  type: number;
  ttl?: number;
  cacheFlush?: boolean;
  data:
    | { kind: "ptr"; target: string }
    | { kind: "txt"; entries: string[] }
    | { kind: "srv"; priority?: number; weight?: number; port: number; target: string }
    | { kind: "a"; ip: string }
    | { kind: "raw"; buffer: Buffer };
}

function sanitizeToken(raw: string, maxLength = 64): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, maxLength);
}

function sanitizeLabelText(raw: string, maxBytes = 63): string {
  const cleaned = raw.replace(/[\r\n\0.]+/g, " ").trim();
  if (!cleaned) return "";
  let out = cleaned;
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return out.trim();
}

/**
 * Computes a short, non-identifying fingerprint from `identity.json`'s public id
 * (or falls back to a hash of `machineId`), never exposing usernames or paths.
 */
export function hostFingerprint(home: string, machineId: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "identity.json"), "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id) {
      return createHash("sha256").update(parsed.id).digest("hex").slice(0, 24);
    }
  } catch {
    // Identity file may not exist until GatewayLink or LAN pairing initializes it.
  }
  return createHash("sha256").update(`linkshell-machine:${machineId}`).digest("hex").slice(0, 24);
}

/** Builds standardized LinkShell TXT records while honoring optional machine name / hostport. */
export function buildMdnsTxtRecords(options: {
  protocolVersion: number;
  machineId: string;
  fingerprint: string;
  machineName?: string;
  hostPort?: number;
}): string[] {
  const safeMid = sanitizeToken(options.machineId, 64);
  const safeFp = sanitizeToken(options.fingerprint, 48);
  const txt = [`v=${options.protocolVersion}`, `mid=${safeMid}`, `fp=${safeFp}`];
  if (typeof options.hostPort === "number" && Number.isInteger(options.hostPort) && options.hostPort > 0 && options.hostPort <= 65535) {
    txt.push(`hostport=${options.hostPort}`);
  }
  if (options.machineName) {
    const safeName = sanitizeLabelText(options.machineName, 128);
    if (safeName) txt.push(`name=${safeName}`);
  }
  return txt;
}

export function buildMdnsCommand(options: {
  port: number;
  machineId: string;
  fingerprint: string;
  protocolVersion: number;
  machineName?: string;
  hostPort?: number;
  platform?: NodeJS.Platform;
}): { command: string; args: string[]; instanceName: string; txtRecords: string[] } | undefined {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) return undefined;
  const safeMid = sanitizeToken(options.machineId, 64);
  const safeFp = sanitizeToken(options.fingerprint, 48);
  if (!safeMid || !safeFp) return undefined;

  const instanceName = `linkshell-${safeFp.slice(0, 8)}`;
  const txtRecords = buildMdnsTxtRecords(options);

  if (platform === "darwin") {
    return {
      command: "/usr/bin/dns-sd",
      args: ["-R", instanceName, "_linkshell._tcp", "local", String(options.port), ...txtRecords],
      instanceName,
      txtRecords,
    };
  }
  if (platform === "linux") {
    return {
      command: "avahi-publish-service",
      args: [instanceName, "_linkshell._tcp", String(options.port), ...txtRecords],
      instanceName,
      txtRecords,
    };
  }
  return undefined;
}

// ---- Wire-level DNS-SD / mDNS codec ----

/** Encodes a DNS domain name into uncompressed length-prefixed labels ending with a 0x00 root byte. */
export function encodeDnsName(name: string): Buffer {
  const normalized = name.replace(/\.+$/, "");
  if (!normalized) return Buffer.from([0]);
  const parts = normalized.split(".").filter(Boolean);
  const chunks: Buffer[] = [];
  for (const label of parts) {
    const buf = Buffer.from(label, "utf8");
    if (buf.length > 63) throw new Error(`DNS label exceeds 63 bytes: ${label}`);
    chunks.push(Buffer.from([buf.length]), buf);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Decodes a DNS domain name from `packet` at `offset`, supporting RFC 1035 compression pointers safely. */
export function decodeDnsName(packet: Buffer, offset: number): { name: string; nextOffset: number } {
  const labels: string[] = [];
  const visited = new Set<number>();
  let cursor = offset;
  let endOffset = -1;
  let jumps = 0;

  while (cursor < packet.length) {
    const len = packet[cursor]!;
    if (len === 0) {
      if (endOffset < 0) endOffset = cursor + 1;
      return { name: labels.join("."), nextOffset: endOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (cursor + 1 >= packet.length) throw new Error("Truncated DNS compression pointer");
      const ptr = ((len & 0x3f) << 8) | packet[cursor + 1]!;
      if (ptr >= packet.length || visited.has(ptr) || ++jumps > 64) {
        throw new Error("Invalid or cyclic DNS compression pointer");
      }
      visited.add(ptr);
      if (endOffset < 0) endOffset = cursor + 2;
      cursor = ptr;
      continue;
    }
    if ((len & 0xc0) !== 0) {
      throw new Error(`Unsupported DNS label mask: 0x${len.toString(16)}`);
    }
    const start = cursor + 1;
    const end = start + len;
    if (end > packet.length) throw new Error("Truncated DNS label");
    labels.push(packet.subarray(start, end).toString("utf8"));
    cursor = end;
  }
  throw new Error("Unterminated DNS name");
}

function encodeTxtRdata(entries: string[]): Buffer {
  if (entries.length === 0) return Buffer.from([0]);
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry, "utf8");
    const clipped = bytes.length > 255 ? bytes.subarray(0, 255) : bytes;
    chunks.push(Buffer.from([clipped.length]), clipped);
  }
  return Buffer.concat(chunks);
}

function decodeTxtRdata(rdata: Buffer): string[] {
  const entries: string[] = [];
  let offset = 0;
  while (offset < rdata.length) {
    const len = rdata[offset++]!;
    if (offset + len > rdata.length) break;
    if (len > 0) entries.push(rdata.subarray(offset, offset + len).toString("utf8"));
    offset += len;
  }
  return entries;
}

function encodeIpv4Rdata(ip: string): Buffer {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address for A record: ${ip}`);
  }
  return Buffer.from(octets);
}

function encodeRecordRdata(data: MdnsRecordInput["data"]): Buffer {
  switch (data.kind) {
    case "ptr":
      return encodeDnsName(data.target);
    case "txt":
      return encodeTxtRdata(data.entries);
    case "srv": {
      const head = Buffer.allocUnsafe(6);
      head.writeUInt16BE(data.priority ?? 0, 0);
      head.writeUInt16BE(data.weight ?? 0, 2);
      head.writeUInt16BE(data.port, 4);
      return Buffer.concat([head, encodeDnsName(data.target)]);
    }
    case "a":
      return encodeIpv4Rdata(data.ip);
    case "raw":
      return data.buffer;
  }
}

function encodeRecord(record: MdnsRecordInput, defaultTtl: number): Buffer {
  const nameBuf = encodeDnsName(record.name);
  const rdata = encodeRecordRdata(record.data);
  const meta = Buffer.allocUnsafe(10);
  const rclass = DNS_CLASS_IN | (record.cacheFlush ? DNS_CACHE_FLUSH_BIT : 0);
  meta.writeUInt16BE(record.type, 0);
  meta.writeUInt16BE(rclass, 2);
  meta.writeUInt32BE((record.ttl ?? defaultTtl) >>> 0, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, meta, rdata]);
}

/** Builds a wire-format mDNS query packet (useful for callers and unit tests). */
export function buildMdnsQueryPacket(
  questions: { name: string; type: number; unicastResponse?: boolean }[],
  id = 0,
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(questions.length, 4);
  const encodedQuestions = questions.map((q) => {
    const qname = encodeDnsName(q.name);
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(DNS_CLASS_IN | (q.unicastResponse ? 0x8000 : 0), 2);
    return Buffer.concat([qname, tail]);
  });
  return Buffer.concat([header, ...encodedQuestions]);
}

/** Builds a wire-format mDNS authoritative response packet (`QR=1`, `AA=1`). */
export function buildMdnsResponsePacket(options: {
  id?: number;
  answers?: MdnsRecordInput[];
  additionals?: MdnsRecordInput[];
  ttlSeconds?: number;
}): Buffer {
  const answers = options.answers ?? [];
  const additionals = options.additionals ?? [];
  const ttlDefault = options.ttlSeconds ?? MDNS_DEFAULT_TTL;
  const header = Buffer.alloc(12);
  header.writeUInt16BE((options.id ?? 0) & 0xffff, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([
    header,
    ...answers.map((rr) => encodeRecord(rr, ttlDefault)),
    ...additionals.map((rr) => encodeRecord(rr, ttlDefault)),
  ]);
}

function parseResourceRecords(packet: Buffer, offset: number, count: number): { records: MdnsResourceRecord[]; nextOffset: number } {
  const records: MdnsResourceRecord[] = [];
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    const { name, nextOffset } = decodeDnsName(packet, cursor);
    cursor = nextOffset;
    if (cursor + 10 > packet.length) throw new Error("Truncated DNS resource record header");
    const type = packet.readUInt16BE(cursor);
    const rawClass = packet.readUInt16BE(cursor + 2);
    const ttl = packet.readUInt32BE(cursor + 4);
    const rdLength = packet.readUInt16BE(cursor + 8);
    cursor += 10;
    if (cursor + rdLength > packet.length) throw new Error("Truncated DNS resource record rdata");
    const rdataStart = cursor;
    const rdata = packet.subarray(rdataStart, rdataStart + rdLength);
    cursor += rdLength;

    const record: MdnsResourceRecord = {
      name,
      type,
      rclass: rawClass & 0x7fff,
      cacheFlush: (rawClass & DNS_CACHE_FLUSH_BIT) !== 0,
      ttl,
      rdata,
    };
    if (type === DNS_TYPE_PTR && rdLength > 0) {
      record.ptr = decodeDnsName(packet, rdataStart).name;
    } else if (type === DNS_TYPE_TXT) {
      record.txt = decodeTxtRdata(rdata);
    } else if (type === DNS_TYPE_SRV && rdLength >= 6) {
      record.srv = {
        priority: rdata.readUInt16BE(0),
        weight: rdata.readUInt16BE(2),
        port: rdata.readUInt16BE(4),
        target: decodeDnsName(packet, rdataStart + 6).name,
      };
    } else if (type === DNS_TYPE_A && rdLength === 4) {
      record.a = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
    }
    records.push(record);
  }
  return { records, nextOffset: cursor };
}

/** Parses a raw UDP mDNS packet; returns `null` when malformed or truncated. */
export function parseMdnsPacket(packet: Buffer): MdnsPacket | null {
  if (packet.length < 12) return null;
  try {
    const id = packet.readUInt16BE(0);
    const flags = packet.readUInt16BE(2);
    const qdCount = packet.readUInt16BE(4);
    const anCount = packet.readUInt16BE(6);
    const nsCount = packet.readUInt16BE(8);
    const arCount = packet.readUInt16BE(10);

    let cursor = 12;
    const questions: MdnsQuestion[] = [];
    for (let i = 0; i < qdCount; i++) {
      const { name, nextOffset } = decodeDnsName(packet, cursor);
      cursor = nextOffset;
      if (cursor + 4 > packet.length) return null;
      const type = packet.readUInt16BE(cursor);
      const rawClass = packet.readUInt16BE(cursor + 2);
      cursor += 4;
      questions.push({
        name,
        type,
        qclass: rawClass & 0x7fff,
        unicastResponse: (rawClass & 0x8000) !== 0,
      });
    }
    const answers = parseResourceRecords(packet, cursor, anCount);
    const authorities = parseResourceRecords(packet, answers.nextOffset, nsCount);
    const additionals = parseResourceRecords(packet, authorities.nextOffset, arCount);
    return {
      id,
      flags,
      isResponse: (flags & 0x8000) !== 0,
      questions,
      answers: answers.records,
      authorities: authorities.records,
      additionals: additionals.records,
    };
  } catch {
    return null;
  }
}

function localIpv4Addresses(): string[] {
  const seen = new Set<string>();
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === "IPv4" && !info.internal && info.address) seen.add(info.address);
    }
  }
  return [...seen];
}

/**
 * Pure-Node zero-dependency mDNS/DNS-SD responder over UDP IPv4 multicast (`224.0.0.251:5353`).
 * Answers LinkShell PTR/SRV/TXT/A queries, handles instance name conflicts, and broadcasts TTL=0 goodbye packets on stop.
 */
export class PureMdnsResponder {
  private socket?: MdnsSocketLike;
  private running = false;
  private stopped = false;
  private conflictIndex = 0;
  private reannounceTimer?: ReturnType<typeof setTimeout>;
  private readonly baseInstance: string;
  private readonly txtRecords: string[];
  private readonly ttlSeconds: number;
  private readonly safeMid: string;
  private readonly safeFp: string;

  constructor(private readonly options: MdnsAdvertiseOptions) {
    this.safeMid = sanitizeToken(options.machineId, 64);
    this.safeFp = sanitizeToken(options.fingerprint, 48);
    this.baseInstance = `linkshell-${this.safeFp.slice(0, 8)}`;
    this.txtRecords = buildMdnsTxtRecords(options);
    this.ttlSeconds = options.ttlSeconds ?? MDNS_DEFAULT_TTL;
  }

  get active(): boolean {
    return this.running && !this.stopped;
  }

  get instanceName(): string {
    return this.conflictIndex === 0 ? this.baseInstance : `${this.baseInstance}-${this.conflictIndex + 1}`;
  }

  get serviceFqdn(): string {
    return `${this.instanceName}.${LINKSHELL_SERVICE_TYPE}`;
  }

  get hostFqdn(): string {
    return `${this.instanceName}.local`;
  }

  private addresses(): string[] {
    return this.options.ipv4Addresses ?? localIpv4Addresses();
  }

  private validConfig(): boolean {
    return Number.isInteger(this.options.port) && this.options.port > 0 && this.options.port <= 65535 && Boolean(this.safeMid && this.safeFp);
  }

  private buildFullRecords(ttl = this.ttlSeconds): MdnsRecordInput[] {
    const records: MdnsRecordInput[] = [
      { name: LINKSHELL_SERVICE_TYPE, type: DNS_TYPE_PTR, ttl, cacheFlush: false, data: { kind: "ptr", target: this.serviceFqdn } },
      { name: this.serviceFqdn, type: DNS_TYPE_SRV, ttl, cacheFlush: ttl > 0, data: { kind: "srv", port: this.options.port, target: this.hostFqdn } },
      { name: this.serviceFqdn, type: DNS_TYPE_TXT, ttl, cacheFlush: ttl > 0, data: { kind: "txt", entries: this.txtRecords } },
    ];
    for (const ip of this.addresses()) {
      records.push({ name: this.hostFqdn, type: DNS_TYPE_A, ttl, cacheFlush: ttl > 0, data: { kind: "a", ip } });
    }
    return records;
  }

  /** Builds a multicast announcement or goodbye (`ttl = 0`) packet for this host instance. */
  buildAnnouncementPacket(ttl = this.ttlSeconds): Buffer {
    return buildMdnsResponsePacket({
      answers: this.buildFullRecords(ttl),
      ttlSeconds: ttl,
    });
  }

  /** Computes the response packet (and unicast flag) for a parsed mDNS query, or `null` if irrelevant. */
  buildQueryResponse(packet: MdnsPacket): { buffer: Buffer; unicast: boolean } | null {
    const answerKeys = new Set<string>();
    const answers: MdnsRecordInput[] = [];
    const additionalKeys = new Set<string>();
    const additionals: MdnsRecordInput[] = [];
    let unicast = false;

    const addUnique = (list: MdnsRecordInput[], keys: Set<string>, rr: MdnsRecordInput) => {
      const k = `${rr.name.toLowerCase()}|${rr.type}|${rr.data.kind === "a" ? rr.data.ip : rr.data.kind === "ptr" ? rr.data.target : ""}`;
      if (keys.has(k)) return;
      keys.add(k);
      list.push(rr);
    };

    const full = this.buildFullRecords();
    const ptrRec = full[0]!;
    const srvRec = full[1]!;
    const txtRec = full[2]!;
    const aRecs = full.slice(3);
    const serviceLower = LINKSHELL_SERVICE_TYPE.toLowerCase();
    const enumLower = DNS_SD_ENUM_TYPE.toLowerCase();
    const fqdnLower = this.serviceFqdn.toLowerCase();
    const hostLower = this.hostFqdn.toLowerCase();

    for (const q of packet.questions) {
      if (q.qclass !== DNS_CLASS_IN && q.qclass !== DNS_TYPE_ANY) continue;
      const qname = q.name.replace(/\.+$/, "").toLowerCase();
      if (qname === enumLower && (q.type === DNS_TYPE_PTR || q.type === DNS_TYPE_ANY)) {
        if (q.unicastResponse) unicast = true;
        addUnique(answers, answerKeys, {
          name: DNS_SD_ENUM_TYPE,
          type: DNS_TYPE_PTR,
          ttl: this.ttlSeconds,
          cacheFlush: false,
          data: { kind: "ptr", target: LINKSHELL_SERVICE_TYPE },
        });
        addUnique(additionals, additionalKeys, ptrRec);
        addUnique(additionals, additionalKeys, srvRec);
        addUnique(additionals, additionalKeys, txtRec);
        for (const a of aRecs) addUnique(additionals, additionalKeys, a);
      } else if (qname === serviceLower && (q.type === DNS_TYPE_PTR || q.type === DNS_TYPE_ANY)) {
        if (q.unicastResponse) unicast = true;
        addUnique(answers, answerKeys, ptrRec);
        addUnique(additionals, additionalKeys, srvRec);
        addUnique(additionals, additionalKeys, txtRec);
        for (const a of aRecs) addUnique(additionals, additionalKeys, a);
      } else if (qname === fqdnLower) {
        if (q.unicastResponse) unicast = true;
        if (q.type === DNS_TYPE_SRV || q.type === DNS_TYPE_ANY) {
          addUnique(answers, answerKeys, srvRec);
          addUnique(additionals, additionalKeys, txtRec);
          for (const a of aRecs) addUnique(additionals, additionalKeys, a);
        }
        if (q.type === DNS_TYPE_TXT || q.type === DNS_TYPE_ANY) {
          addUnique(answers, answerKeys, txtRec);
          if (q.type !== DNS_TYPE_ANY) {
            addUnique(additionals, additionalKeys, srvRec);
            for (const a of aRecs) addUnique(additionals, additionalKeys, a);
          }
        }
      } else if (qname === hostLower && (q.type === DNS_TYPE_A || q.type === DNS_TYPE_ANY)) {
        if (q.unicastResponse) unicast = true;
        for (const a of aRecs) addUnique(answers, answerKeys, a);
      }
    }

    if (answers.length === 0) return null;
    const filteredAdditionals = additionals.filter((rr) => {
      const k = `${rr.name.toLowerCase()}|${rr.type}|${rr.data.kind === "a" ? rr.data.ip : rr.data.kind === "ptr" ? rr.data.target : ""}`;
      return !answerKeys.has(k);
    });
    return {
      buffer: buildMdnsResponsePacket({
        id: unicast ? packet.id : 0,
        answers,
        additionals: filteredAdditionals,
        ttlSeconds: this.ttlSeconds,
      }),
      unicast,
    };
  }

  /** Detects instance or hostname conflicts in incoming peer announcements; advances suffix if needed. */
  private detectConflict(packet: MdnsPacket): boolean {
    const fqdnLower = this.serviceFqdn.toLowerCase();
    const hostLower = this.hostFqdn.toLowerCase();
    const ips = new Set(this.addresses());
    for (const rr of [...packet.answers, ...packet.additionals]) {
      if (rr.ttl === 0) continue;
      const rrName = rr.name.replace(/\.+$/, "").toLowerCase();
      if (rrName === fqdnLower && rr.type === DNS_TYPE_SRV && rr.srv) {
        if (rr.srv.port !== this.options.port || rr.srv.target.replace(/\.+$/, "").toLowerCase() !== hostLower) {
          return true;
        }
      }
      if (rrName === fqdnLower && rr.type === DNS_TYPE_TXT && rr.txt) {
        const peerMid = rr.txt.find((entry) => entry.startsWith("mid="))?.slice(4);
        const peerFp = rr.txt.find((entry) => entry.startsWith("fp="))?.slice(3);
        if ((peerMid && peerMid !== this.safeMid) || (peerFp && peerFp !== this.safeFp)) {
          return true;
        }
      }
      if (rrName === hostLower && rr.type === DNS_TYPE_A && rr.a && ips.size > 0 && !ips.has(rr.a)) {
        return true;
      }
    }
    return false;
  }

  /** Processes one incoming mDNS UDP packet (exposed for unit tests and socket message handling). */
  handlePacket(raw: Buffer, rinfo?: Partial<RemoteInfo>): void {
    if (!this.active || !this.socket) return;
    const packet = parseMdnsPacket(raw);
    if (!packet) return;
    if (packet.isResponse) {
      if (this.detectConflict(packet)) {
        this.conflictIndex += 1;
        this.options.log?.(`[mdns] instance conflict detected; renaming to ${this.instanceName}`);
        this.sendMulticast(this.buildAnnouncementPacket());
      }
      return;
    }
    const reply = this.buildQueryResponse(packet);
    if (!reply) return;
    if (reply.unicast && rinfo?.address && rinfo?.port) {
      this.sendTo(reply.buffer, rinfo.port, rinfo.address);
    } else if (rinfo?.port && rinfo.port !== MDNS_PORT && rinfo.address) {
      // Legacy non-5353 unicast queries expect a direct reply on the requester's source port.
      this.sendTo(reply.buffer, rinfo.port, rinfo.address);
    } else {
      this.sendMulticast(reply.buffer);
    }
  }

  private sendMulticast(packet: Buffer): void {
    this.sendTo(packet, MDNS_PORT, MDNS_MULTICAST_ADDR);
  }

  private sendTo(packet: Buffer, port: number, address: string): void {
    if (!this.socket || this.stopped) return;
    try {
      this.socket.send(packet, 0, packet.length, port, address, (error) => {
        if (error) this.options.log?.(`[mdns] UDP send failed: ${error.message}`);
      });
    } catch (error) {
      this.options.log?.(`[mdns] UDP send threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private joinMulticast(socket: MdnsSocketLike): void {
    try {
      socket.setMulticastTTL?.(255);
      socket.setMulticastLoopback?.(true);
    } catch {
      // Multicast socket options may fail on restricted interfaces.
    }
    const addrs = this.addresses();
    let joinedAny = false;
    for (const ip of addrs) {
      try {
        socket.addMembership(MDNS_MULTICAST_ADDR, ip);
        joinedAny = true;
      } catch {
        // Ignore individual interface join errors (e.g. VPN/virtual adapters).
      }
    }
    if (!joinedAny) {
      try {
        socket.addMembership(MDNS_MULTICAST_ADDR);
      } catch (error) {
        this.options.log?.(`[mdns] multicast join failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  start(): boolean {
    if (this.stopped || this.socket || !this.validConfig()) return this.active;
    const socket = this.options.socketFactory
      ? this.options.socketFactory()
      : (createSocket({ type: "udp4", reuseAddr: true }) as unknown as MdnsSocketLike);
    this.socket = socket;
    this.running = true;

    socket.on("error", (error) => {
      this.options.log?.(`[mdns] pure responder socket error: ${error.message}`);
      if (this.socket === socket) {
        this.running = false;
        this.socket = undefined;
        try { socket.close(); } catch {}
      }
    });
    socket.on("message", (msg, rinfo) => this.handlePacket(msg, rinfo));
    socket.on("listening", () => {
      if (this.stopped || this.socket !== socket) return;
      this.joinMulticast(socket);
      this.sendMulticast(this.buildAnnouncementPacket());
      this.reannounceTimer = setTimeout(() => {
        if (this.active) this.sendMulticast(this.buildAnnouncementPacket());
      }, 400);
      this.reannounceTimer.unref?.();
    });

    try {
      socket.bind(MDNS_PORT, "0.0.0.0");
      socket.unref?.();
      return true;
    } catch (error) {
      this.options.log?.(`[mdns] pure responder bind failed: ${error instanceof Error ? error.message : String(error)}`);
      this.running = false;
      this.socket = undefined;
      try { socket.close(); } catch {}
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.reannounceTimer) {
      clearTimeout(this.reannounceTimer);
      this.reannounceTimer = undefined;
    }
    const socket = this.socket;
    if (socket && this.running) {
      const goodbye = this.buildAnnouncementPacket(0);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 150);
        timer.unref?.();
        try {
          socket.send(goodbye, 0, goodbye.length, MDNS_PORT, MDNS_MULTICAST_ADDR, finish);
        } catch {
          finish();
        }
      });
    }
    this.stopped = true;
    this.running = false;
    this.socket = undefined;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 150);
      timer.unref?.();
      try {
        socket.close(finish);
      } catch {
        finish();
      }
    });
  }
}

export class MdnsAdvertiser {
  private child?: ChildProcess;
  private responder?: PureMdnsResponder;
  private stopped = false;

  constructor(private readonly options: MdnsAdvertiseOptions) {}

  get active(): boolean {
    const childRunning = Boolean(this.child && this.child.exitCode === null && !this.child.killed);
    return childRunning || Boolean(this.responder?.active);
  }

  private startPureFallback(reason?: string): boolean {
    if (this.stopped || this.responder) return this.active;
    if (reason) this.options.log?.(`[mdns] ${reason}; falling back to built-in pure-Node mDNS responder`);
    const responder = new PureMdnsResponder(this.options);
    if (!responder.start()) return false;
    this.responder = responder;
    return true;
  }

  start(): boolean {
    if (this.stopped || this.active) return this.active;
    const platform = this.options.platform ?? process.platform;

    // Windows and Linux use the zero-dependency built-in mDNS responder natively (no Avahi/Bonjour required).
    if (platform === "win32" || platform === "linux") {
      return this.startPureFallback();
    }

    const spec = buildMdnsCommand(this.options);
    if (!spec) return false;
    const spawnFn =
      this.options.spawnProcess ??
      ((command: string, args: string[]) => spawn(command, args, { stdio: "ignore", windowsHide: true }));
    try {
      const child = spawnFn(spec.command, spec.args);
      this.child = child;
      trackChild(child, "mdns", spec.command, spec.args, false);
      child.unref?.();
      child.once("error", (error) => {
        if (this.child === child) this.child = undefined;
        this.options.log?.(`[mdns] ${spec.command} unavailable: ${error.message}`);
        if (!this.stopped) this.startPureFallback(`${spec.command} failed`);
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = undefined;
        if (!this.stopped) this.startPureFallback(`${spec.command} exited (${code ?? "signal"})`);
      });
      return true;
    } catch (error) {
      this.options.log?.(`[mdns] failed to start ${spec.command}: ${error instanceof Error ? error.message : String(error)}`);
      return this.startPureFallback();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const responder = this.responder;
    this.responder = undefined;
    if (responder) await responder.stop();

    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
        finish();
      }, 400);
      killTimer.unref?.();
      child.once("exit", finish);
      child.once("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }
}
