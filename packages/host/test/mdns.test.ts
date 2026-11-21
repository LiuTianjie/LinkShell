import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { RemoteInfo } from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  buildMdnsCommand,
  buildMdnsQueryPacket,
  buildMdnsResponsePacket,
  buildMdnsTxtRecords,
  decodeDnsName,
  DNS_SD_ENUM_TYPE,
  DNS_TYPE_A,
  DNS_TYPE_ANY,
  DNS_TYPE_PTR,
  DNS_TYPE_SRV,
  DNS_TYPE_TXT,
  encodeDnsName,
  LINKSHELL_SERVICE_TYPE,
  MDNS_DEFAULT_TTL,
  MDNS_MULTICAST_ADDR,
  MDNS_PORT,
  MdnsAdvertiser,
  parseMdnsPacket,
  PureMdnsResponder,
  type MdnsSocketLike,
} from "../src/mdns.js";

class FakeMdnsSocket extends EventEmitter implements MdnsSocketLike {
  readonly memberships: Array<{ addr: string; iface?: string }> = [];
  readonly sent: Array<{ packet: Buffer; port: number; address: string }> = [];
  closed = false;

  bind(_port: number, _address?: string, cb?: () => void): void {
    queueMicrotask(() => {
      this.emit("listening");
      cb?.();
    });
  }

  send(msg: Buffer, offset: number, length: number, port: number, address: string, cb?: (error: Error | null) => void): void {
    this.sent.push({ packet: Buffer.from(msg.subarray(offset, offset + length)), port, address });
    cb?.(null);
  }

  close(cb?: () => void): void {
    this.closed = true;
    cb?.();
  }

  addMembership(multicastAddress: string, multicastInterface?: string): void {
    this.memberships.push({ addr: multicastAddress, iface: multicastInterface });
  }

  setMulticastTTL(): void {}
  setMulticastLoopback(): void {}
  unref(): void {}
}

function rinfo(address = "192.168.1.50", port = MDNS_PORT): RemoteInfo {
  return { address, family: "IPv4", port, size: 0 };
}

describe("mDNS packet codec and TXT builders", () => {
  it("encodes and decodes DNS names including RFC 1035 compression pointers and cycle guards", () => {
    const encoded = encodeDnsName("linkshell-abcd._linkshell._tcp.local.");
    const decoded = decodeDnsName(encoded, 0);
    expect(decoded.name).toBe("linkshell-abcd._linkshell._tcp.local");
    expect(decoded.nextOffset).toBe(encoded.length);

    // Build a packet with a compressed name pointer referencing offset 0.
    const prefix = encodeDnsName("_linkshell._tcp.local");
    const withPtr = Buffer.concat([prefix, Buffer.from([3]), Buffer.from("foo"), Buffer.from([0xc0, 0x00])]);
    const compressed = decodeDnsName(withPtr, prefix.length);
    expect(compressed.name).toBe("foo._linkshell._tcp.local");
    expect(compressed.nextOffset).toBe(withPtr.length);

    // Reject self-referential pointer loop without hanging.
    const cyclic = Buffer.from([0xc0, 0x00]);
    expect(() => decodeDnsName(cyclic, 0)).toThrow();
  });

  it("builds and parses PTR/SRV/TXT/A mDNS packets and rejects truncated packets", () => {
    expect(parseMdnsPacket(Buffer.alloc(4))).toBeNull();

    const packet = buildMdnsResponsePacket({
      answers: [
        { name: LINKSHELL_SERVICE_TYPE, type: DNS_TYPE_PTR, data: { kind: "ptr", target: "linkshell-1234._linkshell._tcp.local" } },
      ],
      additionals: [
        { name: "linkshell-1234._linkshell._tcp.local", type: DNS_TYPE_SRV, cacheFlush: true, data: { kind: "srv", port: 7878, target: "linkshell-1234.local" } },
        { name: "linkshell-1234._linkshell._tcp.local", type: DNS_TYPE_TXT, cacheFlush: true, data: { kind: "txt", entries: ["v=4", "mid=m1", "fp=fp1", "hostport=7878", "name=Office Box"] } },
        { name: "linkshell-1234.local", type: DNS_TYPE_A, cacheFlush: true, data: { kind: "a", ip: "192.168.1.10" } },
      ],
    });
    const parsed = parseMdnsPacket(packet)!;
    expect(parsed.isResponse).toBe(true);
    expect(parsed.answers[0]?.ptr).toBe("linkshell-1234._linkshell._tcp.local");
    expect(parsed.answers[0]?.ttl).toBe(MDNS_DEFAULT_TTL);
    expect(parsed.additionals[0]?.srv).toEqual({ priority: 0, weight: 0, port: 7878, target: "linkshell-1234.local" });
    expect(parsed.additionals[1]?.txt).toEqual(["v=4", "mid=m1", "fp=fp1", "hostport=7878", "name=Office Box"]);
    expect(parsed.additionals[2]?.a).toBe("192.168.1.10");
  });

  it("advertises machineId, name, hostPort, and fingerprint in TXT records when provided", () => {
    expect(buildMdnsTxtRecords({
      protocolVersion: 4,
      machineId: "machine-1",
      fingerprint: "abcdef1234567890",
      hostPort: 9100,
      machineName: "Studio.PC",
    })).toEqual(["v=4", "mid=machine-1", "fp=abcdef1234567890", "hostport=9100", "name=Studio PC"]);

    const cmd = buildMdnsCommand({
      port: 9100,
      machineId: "machine-1",
      fingerprint: "abcdef1234567890",
      protocolVersion: 4,
      hostPort: 9100,
      machineName: "Workstation",
      platform: "darwin",
    });
    expect(cmd?.args).toContain("hostport=9100");
    expect(cmd?.args).toContain("name=Workstation");
  });
});

describe("PureMdnsResponder and MdnsAdvertiser fallback", () => {
  it("answers DNS-SD PTR/SRV/TXT/A queries, handles instance conflicts, and sends TTL=0 goodbye on stop", async () => {
    const socket = new FakeMdnsSocket();
    const responder = new PureMdnsResponder({
      port: 7878,
      hostPort: 7878,
      machineId: "machine-1",
      machineName: "Dev-Node",
      fingerprint: "deadbeef12345678",
      protocolVersion: 4,
      ipv4Addresses: ["10.0.0.42"],
      socketFactory: () => socket,
      log: () => {},
    });

    expect(responder.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(responder.active).toBe(true);
    expect(socket.memberships.some((m) => m.addr === MDNS_MULTICAST_ADDR)).toBe(true);
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);

    const initial = parseMdnsPacket(socket.sent[0]!.packet)!;
    expect(initial.answers.some((rr) => rr.type === DNS_TYPE_PTR && rr.ptr === "linkshell-deadbeef._linkshell._tcp.local")).toBe(true);
    expect(initial.answers.some((rr) => rr.type === DNS_TYPE_A && rr.a === "10.0.0.42")).toBe(true);

    socket.sent.length = 0;

    // Service discovery enumeration query (`_services._dns-sd._udp.local`).
    socket.emit("message", buildMdnsQueryPacket([{ name: DNS_SD_ENUM_TYPE, type: DNS_TYPE_PTR }]), rinfo());
    expect(socket.sent).toHaveLength(1);
    const enumReply = parseMdnsPacket(socket.sent[0]!.packet)!;
    expect(enumReply.answers[0]?.ptr).toBe(LINKSHELL_SERVICE_TYPE);
    expect(enumReply.additionals.some((rr) => rr.type === DNS_TYPE_SRV && rr.srv?.port === 7878)).toBe(true);

    // Direct PTR query with QU unicast bit replies directly to requester address.
    socket.sent.length = 0;
    socket.emit("message", buildMdnsQueryPacket([{ name: LINKSHELL_SERVICE_TYPE, type: DNS_TYPE_PTR, unicastResponse: true }]), rinfo("10.0.0.99", 5353));
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.address).toBe("10.0.0.99");
    const ptrReply = parseMdnsPacket(socket.sent[0]!.packet)!;
    expect(ptrReply.additionals.find((rr) => rr.type === DNS_TYPE_TXT)?.txt).toContain("hostport=7878");
    expect(ptrReply.additionals.find((rr) => rr.type === DNS_TYPE_TXT)?.txt).toContain("name=Dev-Node");

    // Host A query (`linkshell-deadbeef.local`).
    socket.sent.length = 0;
    socket.emit("message", buildMdnsQueryPacket([{ name: "linkshell-deadbeef.local", type: DNS_TYPE_A }]), rinfo());
    expect(parseMdnsPacket(socket.sent[0]!.packet)?.answers[0]?.a).toBe("10.0.0.42");

    // Conflict from another machine claiming `linkshell-deadbeef` with a different port renames instance safely.
    socket.sent.length = 0;
    socket.emit(
      "message",
      buildMdnsResponsePacket({
        answers: [{ name: "linkshell-deadbeef._linkshell._tcp.local", type: DNS_TYPE_SRV, data: { kind: "srv", port: 9999, target: "other.local" } }],
      }),
      rinfo("10.0.0.77"),
    );
    expect(responder.instanceName).toBe("linkshell-deadbeef-2");
    expect(socket.sent.length).toBe(1);
    expect(parseMdnsPacket(socket.sent[0]!.packet)?.answers[0]?.ptr).toBe("linkshell-deadbeef-2._linkshell._tcp.local");

    // Stop broadcasts TTL=0 goodbye packet and closes socket.
    socket.sent.length = 0;
    await responder.stop();
    expect(responder.active).toBe(false);
    expect(socket.closed).toBe(true);
    const goodbye = parseMdnsPacket(socket.sent[0]!.packet)!;
    expect(goodbye.answers.every((rr) => rr.ttl === 0)).toBe(true);
    expect(goodbye.answers.some((rr) => rr.type === DNS_TYPE_SRV && rr.ttl === 0)).toBe(true);
  });

  it("uses PureMdnsResponder natively on Windows and Linux without spawning dns-sd/avahi", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const socket = new FakeMdnsSocket();
      let spawned = false;
      const adv = new MdnsAdvertiser({
        port: 7878,
        machineId: "m1",
        fingerprint: "1122334455667788",
        protocolVersion: 4,
        platform,
        ipv4Addresses: ["127.0.0.1"],
        socketFactory: () => socket,
        spawnProcess: () => {
          spawned = true;
          throw new Error("should not spawn");
        },
        log: () => {},
      });
      expect(adv.start()).toBe(true);
      await new Promise((r) => setTimeout(r, 15));
      expect(spawned).toBe(false);
      expect(adv.active).toBe(true);
      await adv.stop();
      expect(adv.active).toBe(false);
    }
  });

  it("falls back automatically to PureMdnsResponder on macOS when dns-sd errors or exits", async () => {
    const socket = new FakeMdnsSocket();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      unref: () => {},
      kill: () => true,
    }) as unknown as ChildProcess;

    const adv = new MdnsAdvertiser({
      port: 7878,
      machineId: "mac-1",
      fingerprint: "cafebabe00112233",
      protocolVersion: 4,
      platform: "darwin",
      ipv4Addresses: ["192.168.1.20"],
      socketFactory: () => socket,
      spawnProcess: () => child,
      log: () => {},
    });

    expect(adv.start()).toBe(true);
    expect(adv.active).toBe(true);

    // Simulate dns-sd crashing unexpectedly.
    (child as unknown as { exitCode: number }).exitCode = 1;
    (child as unknown as EventEmitter).emit("exit", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(adv.active).toBe(true);
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);

    // Instance conflict query check with ANY type works through fallback.
    socket.sent.length = 0;
    socket.emit("message", buildMdnsQueryPacket([{ name: LINKSHELL_SERVICE_TYPE, type: DNS_TYPE_ANY }]), rinfo());
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]!.port).toBe(MDNS_PORT);

    await adv.stop();
    expect(adv.active).toBe(false);
  });
});
