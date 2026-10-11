#!/usr/bin/env node
// Encrypted, deadline-aware UDP media experiment. It never contacts a remote address.
// Reuses the Mac app's capture, VideoToolbox and native H.264 decoder. No phone/display proof.
//
// TMPDIR=/tmp node tools/media-lab.mjs --screen 1 --maxFps 120 [--network] [--no-ltr] --json /tmp/lab.json
// --network: the same 20 -> 0.7 -> 20 Mbps / 10 ms each way / 200 ms queue as network-check.mjs.
// Passing proves functioning authenticated media and decode; compare gaps and quality too.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, launch } from "./app.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const shaped = args.includes("--network");
const seconds = Number(value("--seconds", shaped ? "48" : "20"));
assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 120, "invalid seconds");
const conditions = { shaped, seconds, screen: Number(value("--screen", "0")), maxFps: Number(value("--maxFps", "60")),
  fullScreenMotion: args.includes("--full-screen-motion"),
  qualitySampling: args.includes("--quality"),
  appSha256: createHash("sha256").update(readFileSync(join(APP, "Contents/MacOS/LinkShell"))).digest("hex"),
  maxWidth: Number(value("--maxWidth", "1920")), delayEachWayMs: shaped ? 10 : 0,
  capacityMbps: shaped ? [20, 0.7, 20] : null, phaseSeconds: shaped ? [8, 16, 24] : null, maxRouterQueueMs: shaped ? 200 : 0 };
const rows = [];
const sockets = [createSocket("udp4"), createSocket("udp4")];
const timers = new Set();
const counts = { forwarded: 0, queueDrops: 0, maxRouterQueueMs: 0, deliveredMediaBytes: {} };
let app, ready, started, failure;
let closed = false;
let finishTime = 0;
const phase = () => !shaped ? "direct" : performance.now() - started < 8000 ? "wide" : performance.now() - started < 24_000 ? "narrow" : "recovered";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function relay(packet, socket, port, outbound) {
  if (closed) return;
  const now = performance.now();
  let delay = conditions.delayEachWayMs;
  if (outbound && shaped) {
    const capacity = (phase() === "narrow" ? 0.7 : 20) * 1e6;
    const at = Math.max(finishTime, now) + packet.length * 8 / capacity * 1000;
    const queue = at - now;
    if (queue > 200) { counts.queueDrops += 1; return; }
    finishTime = at; delay += queue; counts.maxRouterQueueMs = Math.max(counts.maxRouterQueueMs, queue);
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (closed) return;
    socket.send(packet, port, "127.0.0.1", (error) => { if (error) failure = error; });
    counts.forwarded += 1;
    if (outbound) {
      const current = phase();
      counts.deliveredMediaBytes[current] = (counts.deliveredMediaBytes[current] ?? 0) + packet.length;
    }
  }, delay);
  timers.add(timer);
}

try {
  app = await launch(["--loopback", "--media-lab", ...(args.includes("--no-ltr") ? ["--lab-no-ltr"] : []),
    ...(args.includes("--full-screen-motion") ? ["--full-screen-motion"] : []),
    ...(args.includes("--quality") ? ["--lab-quality"] : []),
    ...(value("--deadline-ms") ? ["--lab-deadline-ms", value("--deadline-ms")] : [])]);
  app.on("lab.error", ({ message }) => { failure = new Error(message); });
  app.on("lab.stats", (stats) => {
    const row = { second: Math.round((performance.now() - started) / 1000), phase: phase(), ...stats };
    rows.push(row);
    console.log(JSON.stringify({ second: row.second, phase: row.phase, fps: row.decodedFps, bitrate: row.bitrate,
      ageP95Ms: row.encodeInputToDecode.p95Ms, sendP95Ms: row.sendDelay.p95Ms, gapMs: row.decodeGapMs,
      ltrAcknowledged: row.ltrAcknowledged, ltrRefreshes: row.ltrRefreshes, rejected: row.rejectedPackets, queueDrops: counts.queueDrops }));
  });
  const status = await app.next("status", 5000);
  assert.equal(status.recording, true, "existing Screen Recording permission is required");
  app.send({ t: "lab.open", v: "media-lab", screen: conditions.screen, maxFps: conditions.maxFps, maxWidth: conditions.maxWidth });
  ready = await app.next("lab.ready", 10_000);
  console.log(JSON.stringify({ ready }));
  if (shaped) {
    for (const socket of sockets) socket.on("error", (error) => { failure = error; });
    await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => {
      socket.once("error", reject); socket.bind(0, "127.0.0.1", resolve);
    })));
    sockets[0].on("message", (packet, peer) => {
      if (peer.address === "127.0.0.1" && peer.port === ready.senderPort) relay(packet, sockets[1], ready.receiverPort, true);
    });
    sockets[1].on("message", (packet, peer) => {
      if (peer.address === "127.0.0.1" && peer.port === ready.receiverPort) relay(packet, sockets[0], ready.senderPort, false);
    });
  }
  started = performance.now();
  app.send({ t: "lab.route", v: "media-lab", senderPort: shaped ? sockets[0].address().port : ready.receiverPort,
    receiverPort: shaped ? sockets[1].address().port : ready.senderPort });
  while (performance.now() - started < seconds * 1000 && !failure) await wait(250);
  if (failure) throw failure;
  assert.ok(rows.at(-1)?.framesDecoded > 0, "no video decoded");
  if (shaped && seconds >= 40) {
    const before = rows.findLast((row) => row.second <= seconds - 5);
    assert.ok(rows.at(-1).framesDecoded - (before?.framesDecoded ?? 0) >= 10, "video did not recover after capacity returned");
  }
  assert.equal(rows.at(-1).rejectedPackets, 0, "valid laboratory packets were rejected");
  if (shaped) assert.ok(counts.forwarded > 0, "no traffic traversed the proxy");
  console.log("[media-lab] completed; this experimental controller has not been accepted for remote use");
} finally {
  try { if (app) assert.ok(await app.close(), "the laboratory helper did not exit"); }
  finally {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) { try { socket.close(); } catch {} }
    if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify({ conditions, ready, counts, rows }, null, 2)}\n`);
  }
}
