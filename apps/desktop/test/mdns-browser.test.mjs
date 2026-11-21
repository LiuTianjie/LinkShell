import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  DNS_CLASS_IN,
  DNS_TYPE_A,
  DNS_TYPE_PTR,
  DNS_TYPE_SRV,
  DNS_TYPE_TXT,
  LINKSHELL_SERVICE_TYPE,
  MDNS_MULTICAST_ADDR,
  MDNS_PORT,
  MdnsLanBrowser,
  buildMdnsPtrQueryPacket,
  decodeDnsName,
  encodeDnsName,
  parseLinkshellTxtRecords,
  parseMdnsResponsePacket,
} from "../dist/main/mdns-browser.js";

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function encodeTxt(entries) {
  return Buffer.concat(
    entries.map((entry) => {
      const data = Buffer.from(entry, "utf8");
      return Buffer.concat([Buffer.from([data.length]), data]);
    }),
  );
}

function buildRr(nameBuf, type, rclass, ttl, rdata) {
  return Buffer.concat([nameBuf, u16(type), u16(rclass), u32(ttl), u16(rdata.length), rdata]);
}

function buildLinkshellAnnouncement({
  instanceLabel = "linkshell-12345678",
  hostName = "studio.local",
  ip = "192.168.1.42",
  srvPort = 7878,
  ttl = 120,
  txtEntries = [
    "v=3",
    "mid=machine-alpha",
    "fp=1234567890abcdef12345678",
    "hostport=7878",
    "name=Mac Studio",
  ],
  compressPtr = false,
} = {}) {
  const serviceName = encodeDnsName(LINKSHELL_SERVICE_TYPE);
  const fullInstanceName = `${instanceLabel}.${LINKSHELL_SERVICE_TYPE}`;
  const fullInstanceBuf = encodeDnsName(fullInstanceName);
  const targetBuf = encodeDnsName(hostName);

  const answers = [buildRr(serviceName, DNS_TYPE_PTR, DNS_CLASS_IN, ttl, fullInstanceBuf)];

  // Optional RFC 1035 compression pointer pointing back into the PTR rdata at offset 12 + serviceName.length + 10.
  const instanceNameOrPtr = compressPtr
    ? Buffer.from([0xc0, 12 + serviceName.length + 10])
    : fullInstanceBuf;

  const ipParts = ip.split(".").map(Number);
  const additionals = [
    buildRr(
      instanceNameOrPtr,
      DNS_TYPE_SRV,
      DNS_CLASS_IN | 0x8000,
      ttl,
      Buffer.concat([u16(0), u16(0), u16(srvPort), targetBuf]),
    ),
    buildRr(instanceNameOrPtr, DNS_TYPE_TXT, DNS_CLASS_IN | 0x8000, ttl, encodeTxt(txtEntries)),
    buildRr(targetBuf, DNS_TYPE_A, DNS_CLASS_IN | 0x8000, ttl, Buffer.from(ipParts)),
  ];

  const header = Buffer.concat([
    u16(0),
    u16(0x8400),
    u16(0),
    u16(answers.length),
    u16(0),
    u16(additionals.length),
  ]);
  return Buffer.concat([header, ...answers, ...additionals]);
}

class MockUdpSocket extends EventEmitter {
  joined = [];
  sentPackets = [];
  bound = null;
  closed = false;
  loopback = undefined;

  bind(port, address, cb) {
    this.bound = { port, address };
    queueMicrotask(() => {
      this.emit("listening");
      cb?.();
    });
  }

  addMembership(multicastAddress, multicastInterface) {
    this.joined.push({ multicastAddress, multicastInterface });
  }

  setMulticastLoopback(flag) {
    this.loopback = flag;
  }

  send(msg, _offset, _length, port, address, cb) {
    this.sentPackets.push({ msg: Buffer.from(msg), port, address });
    cb?.(null);
  }

  close(cb) {
    this.closed = true;
    cb?.();
  }

  unref() {}
}

test("mDNS packet builder/parser roundtrip and compression pointer safety", () => {
  const query = buildMdnsPtrQueryPacket(LINKSHELL_SERVICE_TYPE);
  const parsedQuery = parseMdnsResponsePacket(query);
  assert.ok(parsedQuery);
  assert.equal(parsedQuery.isResponse, false);
  assert.equal(parsedQuery.questions.length, 1);
  assert.equal(parsedQuery.questions[0].name, LINKSHELL_SERVICE_TYPE);
  assert.equal(parsedQuery.questions[0].type, DNS_TYPE_PTR);

  const response = buildLinkshellAnnouncement({ compressPtr: true });
  const parsedResp = parseMdnsResponsePacket(response);
  assert.ok(parsedResp);
  assert.equal(parsedResp.isResponse, true);
  assert.equal(parsedResp.answers.length, 1);
  assert.equal(parsedResp.answers[0].ptr, `linkshell-12345678.${LINKSHELL_SERVICE_TYPE}`);
  assert.equal(parsedResp.additionals.length, 3);
  assert.equal(parsedResp.additionals[0].name, `linkshell-12345678.${LINKSHELL_SERVICE_TYPE}`);
  assert.equal(parsedResp.additionals[0].srv?.port, 7878);
  assert.equal(parsedResp.additionals[2].a, "192.168.1.42");

  // Guard against infinite pointer loops in malformed packets.
  const loopPacket = Buffer.from([0xc0, 0x00]);
  assert.equal(decodeDnsName(loopPacket, 0), undefined);
  assert.equal(parseMdnsResponsePacket(Buffer.alloc(4)), undefined);
  assert.throws(() => encodeDnsName(`${"a".repeat(64)}.local`));
});

test("parseLinkshellTxtRecords extracts LinkShell TXT attributes safely", () => {
  const meta = parseLinkshellTxtRecords([
    "v=4",
    "mid=mach-123",
    "fp=abcdef0123456789",
    "hostport=7979",
    "name=Workstation",
    "ignored-no-equals",
  ]);
  assert.equal(meta.protocolVersion, 4);
  assert.equal(meta.machineId, "mach-123");
  assert.equal(meta.fingerprint, "abcdef0123456789");
  assert.equal(meta.hostPort, 7979);
  assert.equal(meta.name, "Workstation");

  const invalidPort = parseLinkshellTxtRecords(["hostport=99999", "v=0"]);
  assert.equal(invalidPort.hostPort, undefined);
  assert.equal(invalidPort.protocolVersion, undefined);
});

test("MdnsLanBrowser discovers, updates, expires by TTL, and handles goodbye packets", async () => {
  let now = 1_000_000;
  let mockSocket;
  const changes = [];
  const browser = new MdnsLanBrowser({
    queryIntervalMs: 60_000,
    pruneIntervalMs: 60_000,
    now: () => now,
    socketFactory: () => {
      mockSocket = new MockUdpSocket();
      return mockSocket;
    },
  });

  browser.onChange((hosts) => changes.push(hosts));
  browser.start();
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(browser.isRunning, true);
  assert.equal(mockSocket.bound.port, MDNS_PORT);
  assert.equal(mockSocket.joined[0].multicastAddress, MDNS_MULTICAST_ADDR);
  assert.ok(mockSocket.sentPackets.length >= 1);
  assert.equal(mockSocket.sentPackets[0].address, MDNS_MULTICAST_ADDR);
  assert.equal(mockSocket.sentPackets[0].port, MDNS_PORT);

  // Feed valid announcement packet.
  const packet = buildLinkshellAnnouncement({
    ip: "10.0.0.15",
    srvPort: 7000,
    ttl: 10,
    txtEntries: [
      "v=3",
      "mid=mid-1",
      "fp=fp11223344",
      "hostport=7878",
      "name=Build Box",
    ],
  });
  mockSocket.emit("message", packet, { address: "10.0.0.15", port: 5353 });

  const discovered = browser.getHosts();
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].machineId, "mid-1");
  assert.equal(discovered[0].fingerprint, "fp11223344");
  assert.equal(discovered[0].name, "Build Box");
  assert.equal(discovered[0].port, 7878);
  assert.equal(discovered[0].hostPort, 7878);
  assert.equal(discovered[0].srvPort, 7000);
  assert.deepEqual(discovered[0].addresses, ["10.0.0.15"]);
  assert.equal(changes.at(-1).length, 1);

  // Duplicate identical packet should not trigger duplicate change notifications.
  const prevCount = changes.length;
  mockSocket.emit("message", packet, { address: "10.0.0.15", port: 5353 });
  assert.equal(changes.length, prevCount);

  // Goodbye packet (ttl=0) removes the entry immediately.
  const goodbye = buildLinkshellAnnouncement({
    ip: "10.0.0.15",
    ttl: 0,
  });
  mockSocket.emit("message", goodbye, { address: "10.0.0.15", port: 5353 });
  assert.deepEqual(browser.getHosts(), []);
  assert.equal(changes.at(-1).length, 0);

  // Re-announce with 5s TTL and verify TTL expiration removes it once clock advances.
  mockSocket.emit(
    "message",
    buildLinkshellAnnouncement({
      instanceLabel: "linkshell-ttl",
      ip: "192.168.50.9",
      ttl: 5,
      txtEntries: ["v=3", "mid=mid-ttl", "fp=fpttl1234", "hostport=7880", "name=TTL Host"],
    }),
    { address: "192.168.50.9", port: 5353 },
  );
  assert.equal(browser.getHosts().length, 1);
  now += 5_001;
  assert.equal(browser.pruneExpired(), true);
  assert.deepEqual(browser.getHosts(), []);

  await browser.stop();
  assert.equal(mockSocket.closed, true);
  assert.equal(browser.isRunning, false);
});
