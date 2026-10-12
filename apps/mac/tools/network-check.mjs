#!/usr/bin/env node
// Congestion/recovery through two owned UDP proxies, not a physical-network latency benchmark.
// No system network settings change. Both media peers run inside the built Mac app; this does
// not measure an iPhone, picture quality, or glass-to-glass latency.
//
//   TMPDIR=/tmp node tools/network-check.mjs --screen 1 --maxFps 120 --json /tmp/network.json
//   --app <LinkShell.app> compares an installed build; --trial <name>=<value> is repeatable;
//   --codec hevc asks for HEVC.
//
// For 48 seconds: 20 Mbps for 8 s, 0.7 Mbps for 16 s, then 20 Mbps for 24 s. Every outbound
// SRTP packet (including RTX/FEC) pays serialization time. Queue overflow drops packets, with
// 10 ms propagation each way and a 200 ms router queue. DTLS/STUN/RTCP only pay propagation.
// Passing proves decoded video and traversal of the proxy, not acceptable congestion latency.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, launch } from "./app.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const flags = ["--media-probe"];
if (args.includes("--budget-keyframes")) flags.push("--budget-keyframes");
if (args.includes("--full-screen-motion")) flags.push("--full-screen-motion");
if (args.includes("--quality")) flags.push("--media-quality");
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--trial") {
    assert.ok(args[index + 1]?.includes("="), "--trial needs name=value");
    flags.push("--trial", args[++index]);
  }
}
const conditions = {
  delayEachWayMs: 10, capacityMbps: [20, 0.7, 20], phaseSeconds: [8, 16, 24], maxRouterQueueMs: 200,
  screen: Number(value("--screen", "0")), maxWidth: Number(value("--maxWidth", "1920")), maxFps: Number(value("--maxFps", "60")),
  fullScreenMotion: args.includes("--full-screen-motion"),
  qualitySampling: args.includes("--quality"),
  appSha256: createHash("sha256").update(readFileSync(join(value("--app", APP), "Contents/MacOS/LinkShell"))).digest("hex"),
};
assert.ok(Number.isInteger(conditions.screen) && conditions.screen >= 0, "invalid screen");
assert.ok(Number.isInteger(conditions.maxWidth) && conditions.maxWidth >= 160 && conditions.maxWidth <= 3840, "invalid maxWidth");
assert.ok(Number.isInteger(conditions.maxFps) && conditions.maxFps >= 1 && conditions.maxFps <= 120, "invalid maxFps");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const senderSocket = createSocket("udp4");
const receiverSocket = createSocket("udp4");
const sockets = [senderSocket, receiverSocket];
const timers = new Set();
const counts = { forwarded: 0, forwardedRtp: 0, queueDrops: 0, maxRouterQueueMs: 0, deliveredMediaBytes: {} };
let fromSender, fromReceiver, started, failure, app, receiver;
let finishTime = 0;
let closed = false;
const rows = [];
const phase = () => !started ? "warmup" : performance.now() - started < 8000 ? "wide" : performance.now() - started < 24_000 ? "narrow" : "recovered";

function relay(packet, destination, socket, outbound) {
  if (!destination || closed) return;
  const now = performance.now();
  let delay = conditions.delayEachWayMs;
  const rtp = packet.length >= 12 && (packet[0] & 0xc0) === 0x80 && !(packet[1] >= 192 && packet[1] <= 223);
  if (outbound && rtp) {
    const capacity = (phase() === "narrow" ? conditions.capacityMbps[1] : conditions.capacityMbps[0]) * 1e6;
    const at = Math.max(finishTime, now) + packet.length * 8 / capacity * 1000;
    const queue = at - now;
    if (queue > conditions.maxRouterQueueMs) { counts.queueDrops += 1; return; }
    finishTime = at;
    delay += queue;
    counts.maxRouterQueueMs = Math.max(counts.maxRouterQueueMs, queue);
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (closed) return;
    socket.send(packet, destination.port, destination.address, (error) => { if (error) failure = error; });
    counts.forwarded += 1;
    if (outbound && rtp) {
      counts.forwardedRtp += 1;
      const current = phase();
      counts.deliveredMediaBytes[current] = (counts.deliveredMediaBytes[current] ?? 0) + packet.length;
    }
  }, delay);
  timers.add(timer);
}

function candidate(message) {
  const fields = message.candidate.split(" ");
  if (fields[1] !== "1" || fields[2].toLowerCase() !== "udp" || !/^\d+\.\d+\.\d+\.\d+$/.test(fields[4]) || fields[7] !== "host") return;
  return { message, fields, address: fields[4], port: Number(fields[5]) };
}
function through(endpoint, port, type) {
  const fields = [...endpoint.fields];
  fields[4] = "127.0.0.1";
  fields[5] = String(port);
  return { ...endpoint.message, t: type, candidate: fields.join(" ") };
}

try {
  for (const socket of sockets) socket.on("error", (error) => { failure = error; });
  await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  })));
  senderSocket.on("message", (packet, peer) => {
    if (peer.port === fromSender?.port) relay(packet, fromReceiver, receiverSocket, true);
  });
  receiverSocket.on("message", (packet, peer) => {
    if (peer.port === fromReceiver?.port) relay(packet, fromSender, senderSocket, false);
  });
  app = await launch(["--loopback", "--loopback-network", "--motion", ...flags], value("--app") ? { app: value("--app") } : {});
  function connect() {
    if (!fromSender || !fromReceiver) return;
    app.send(through(fromSender, receiverSocket.address().port, "rtc.loopback.ice"));
    app.send(through(fromReceiver, senderSocket.address().port, "rtc.ice"));
  }
  app.on("rtc.ice", (message) => { if (!fromSender) { fromSender = candidate(message); connect(); } });
  app.on("rtc.loopback.ice", (message) => { if (!fromReceiver) { fromReceiver = candidate(message); connect(); } });
  app.on("rtc.error", (message) => { failure = new Error(message.message); });
  app.on("log", (message) => { if (message.message.startsWith("frame rate ")) console.log(message.message); });
  app.on("rtc.loopback", (message) => { receiver = message; });
  app.on("rtc.stats", (message) => {
    const row = { second: started ? Math.round((performance.now() - started) / 1000) : 0, phase: phase(), sender: message, receiver };
    rows.push(row);
    console.log(JSON.stringify({ second: row.second, phase: row.phase, frameRate: message.frameRate, encoded: message.fps,
      sendDelayMs: message.sendDelayMs, bitrate: message.bitrate, decodeFps: receiver?.fps, jitterBufferMs: receiver?.jitterBufferMs, queueDrops: counts.queueDrops }));
  });
  const status = await app.next("status", 5000);
  assert.equal(status.recording, true, "LinkShell.app needs its existing Screen Recording permission");
  app.send({ t: "rtc.open", v: "network-check", iceServers: [], maxFps: conditions.maxFps, maxWidth: conditions.maxWidth, screen: conditions.screen, ...(value("--codec") ? { codec: value("--codec") } : {}) });
  await app.next("rtc.offer", 10_000);
  started = performance.now();
  const duration = conditions.phaseSeconds.reduce((sum, seconds) => sum + seconds, 0) * 1000;
  while (performance.now() - started < duration && !failure) await wait(250);
  if (failure) throw failure;
  assert.ok(receiver?.framesDecoded > 0, "no decoded video");
  assert.ok(counts.forwardedRtp > 0 && rows.some((row) => row.phase === "recovered"), "the full scenario did not traverse the proxy");
  console.log("[network-check] complete: compare queue, frame loss and recovery together; this is not a latency acceptance test");
} finally {
  try {
    if (app) assert.ok(await app.close(), "the test app did not end with its socket");
  } finally {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) { try { socket.close(); } catch {} }
    if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify({ conditions, trials: flags, counts, rows }, null, 2)}\n`);
  }
}
