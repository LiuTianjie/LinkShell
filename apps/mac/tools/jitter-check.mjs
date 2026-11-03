#!/usr/bin/env node
// Wi-Fi-like jitter through two owned UDP proxies: a few ms each way, small random jitter, and a
// radio hold every ~1 s (40-80 ms, as power save or peer-to-peer Wi-Fi visiting another channel),
// after which held packets leave in a burst, in order. Compares how a receiver paces through it:
//
//   TMPDIR=/tmp node tools/jitter-check.mjs --screen 1 --maxFps 120 [--loopback-smooth] --json /tmp/jitter.json
//
// Both peers run inside the built Mac app; the clock strip gives glass-to-decoded latency and
// --frame-trace the decoded frame times. Not a measurement of a real phone or network.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, launch } from "./app.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const flags = ["--clock", "--frame-trace", ...(args.includes("--loopback-smooth") ? ["--loopback-smooth"] : [])];
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
  delayEachWayMs: 3, jitterMs: 4, holdEveryMs: [800, 1200], holdMs: [40, 80], phaseSeconds: [40],
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
const counts = { forwarded: 0, holds: 0 };
const traces = [];
let fromSender, fromReceiver, started, failure, app, receiver;
let finishTime = 0;
let closed = false;
const rows = [];
const phase = () => !started ? "warmup" : "jitter";

let holdUntil = 0;
let nextHold = 0;
const lastRelease = { true: 0, false: 0 };
const between = ([low, high]) => low + Math.random() * (high - low);
function relay(packet, destination, socket, outbound) {
  if (!destination || closed) return;
  const now = performance.now();
  if (started && now >= nextHold) {
    holdUntil = now + between(conditions.holdMs);
    nextHold = now + between(conditions.holdEveryMs);
    counts.holds += 1;
  }
  // A held radio sends nothing in either direction; packets wait and then leave in order.
  const at = Math.max(now + conditions.delayEachWayMs + Math.random() * conditions.jitterMs, holdUntil, lastRelease[outbound]);
  lastRelease[outbound] = at;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (closed) return;
    socket.send(packet, destination.port, destination.address, (error) => { if (error) failure = error; });
    counts.forwarded += 1;
  }, at - now);
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
  app.on("rtc.loopback", (message) => { receiver = message; if (message.trace) traces.push(...message.trace); });
  app.on("rtc.stats", (message) => {
    const row = { second: started ? Math.round((performance.now() - started) / 1000) : 0, phase: phase(), sender: message, receiver };
    rows.push(row);
    console.log(JSON.stringify({ second: row.second, phase: row.phase, frameRate: message.frameRate, encoded: message.fps,
      sendDelayMs: message.sendDelayMs, bitrate: message.bitrate, decodeFps: receiver?.fps, jitterBufferMs: receiver?.jitterBufferMs, latency: receiver?.latency, holds: counts.holds }));
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
  // Summary from the 10th second: decoded-frame waits over 25 ms, and glass-to-decoded latency.
  const from = (traces[0]?.[1] ?? 0) + 10;
  const decoded = traces.filter(([kind, time]) => kind === "decoded" && time >= from).map(([, time]) => time);
  const waits = decoded.slice(1).map((time, index) => (time - decoded[index]) * 1000);
  const latencies = rows.filter((row) => row.second >= 10).map((row) => row.receiver?.latency?.p50).filter((value) => typeof value === "number").sort((a, b) => a - b);
  const p95s = rows.filter((row) => row.second >= 10).map((row) => row.receiver?.latency?.p95).filter((value) => typeof value === "number").sort((a, b) => a - b);
  const seconds = decoded.length ? decoded.at(-1) - decoded[0] : 0;
  console.log(`[jitter-check] ${args.includes("--loopback-smooth") ? "smooth" : "immediate"}: ${decoded.length} frames in ${seconds.toFixed(1)} s, waits > 25 ms: ${waits.filter((wait) => wait > 25).length}, > 50 ms: ${waits.filter((wait) => wait > 50).length}, longest ${Math.max(...waits).toFixed(0)} ms; glass → decoded p50 (median of seconds) ${latencies[latencies.length >> 1]} ms, p95 (median of seconds) ${p95s[p95s.length >> 1]} ms; ${counts.holds} radio holds`);
} finally {
  try {
    if (app) assert.ok(await app.close(), "the test app did not end with its socket");
  } finally {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) { try { socket.close(); } catch {} }
    if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify({ conditions, trials: flags, counts, rows, traces }, null, 2)}\n`);
  }
}
