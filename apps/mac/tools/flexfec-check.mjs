#!/usr/bin/env node
// A functional FlexFEC check, not a latency benchmark. Only this app's two loopback peers use
// the UDP proxy: 60 ms each way, and every twentieth original video packet dropped. No system
// network settings change. The second run models a receiver which does not support FlexFEC.
//
//   node tools/flexfec-check.mjs [--json <file>]
//
// Requires the freshly built app and its existing Screen Recording permission. Fails unless
// frames decode in both runs, real protection packets arrive in the first, and the unsupported
// receiver declines FlexFEC in the second. M154's public stats do not count FlexFEC recoveries;
// receiving protection packets proves use, not how many dropped packets those packets repaired.

import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { launch } from "./app.mjs";

const delayMs = 60;
const durationMs = 20_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function network() {
  const sender = createSocket("udp4");
  const receiver = createSocket("udp4");
  const timers = new Set();
  const counts = { mediaPackets: 0, droppedMediaPackets: 0, forwardedRepairPackets: 0 };
  let mediaSSRC;
  let repairSSRC;
  let fromSender;
  let fromReceiver;
  let closed = false;
  let failure;
  try {
    await Promise.all([sender, receiver].map((socket) => new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", resolve);
    })));
  } catch (error) {
    for (const socket of [sender, receiver]) { try { socket.close(); } catch {} }
    throw error;
  }
  for (const socket of [sender, receiver]) socket.on("error", (error) => { failure = error; });

  function relay(packet, destination, socket, outbound) {
    if (!destination || closed) return;
    // SRTP leaves the RTP header (including SSRC) readable. DTLS, STUN, SRTCP and RTX are never
    // dropped; the matching repair SSRC is counted independently of the picture's packets.
    if (outbound && packet.length >= 12 && (packet[0] & 0xc0) === 0x80 && !(packet[1] >= 192 && packet[1] <= 223)) {
      const ssrc = packet.readUInt32BE(8);
      if (ssrc === mediaSSRC) {
        counts.mediaPackets += 1;
        if (counts.mediaPackets % 20 === 0) { counts.droppedMediaPackets += 1; return; }
      }
      if (ssrc === repairSSRC) counts.forwardedRepairPackets += 1;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) socket.send(packet, destination.port, destination.address, (error) => { if (error) failure = error; });
    }, delayMs);
    timers.add(timer);
  }
  sender.on("message", (packet, peer) => {
    if (peer.port === fromSender?.port) relay(packet, fromReceiver, receiver, true);
  });
  receiver.on("message", (packet, peer) => {
    if (peer.port === fromReceiver?.port) relay(packet, fromSender, sender, false);
  });

  function candidate(message) {
    const fields = message.candidate.split(" ");
    if (fields[1] !== "1" || fields[2].toLowerCase() !== "udp" || !/^\d+\.\d+\.\d+\.\d+$/.test(fields[4]) || fields[7] !== "host") return undefined;
    return { message, fields, address: fields[4], port: Number(fields[5]) };
  }
  function through(endpoint, port, type) {
    const fields = [...endpoint.fields];
    fields[4] = "127.0.0.1";
    fields[5] = String(port);
    return { ...endpoint.message, t: type, candidate: fields.join(" ") };
  }
  return {
    counts,
    get failure() { return failure; },
    attach(app) {
      app.on("rtc.offer", ({ sdp }) => {
        const group = /a=ssrc-group:FEC-FR (\d+) (\d+)/.exec(sdp);
        mediaSSRC = Number(group?.[1] ?? /a=ssrc:(\d+) /.exec(sdp)?.[1]);
        repairSSRC = group ? Number(group[2]) : undefined;
      });
      function connect() {
        if (!fromSender || !fromReceiver) return;
        app.send(through(fromSender, receiver.address().port, "rtc.loopback.ice"));
        app.send(through(fromReceiver, sender.address().port, "rtc.ice"));
      }
      app.on("rtc.ice", (message) => {
        if (fromSender) return;
        fromSender = candidate(message);
        connect();
      });
      app.on("rtc.loopback.ice", (message) => {
        if (fromReceiver) return;
        fromReceiver = candidate(message);
        connect();
      });
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      sender.close();
      receiver.close();
    },
  };
}

async function run(declines) {
  const proxy = await network();
  let app;
  let latestSender;
  let latestReceiver;
  let error;
  try {
    app = await launch(["--loopback", "--loopback-network", "--motion", ...(declines ? ["--loopback-no-flexfec"] : [])]);
    proxy.attach(app);
    app.on("rtc.error", (message) => { error = new Error(message.message); });
    app.on("rtc.stats", (message) => { latestSender = message; });
    app.on("rtc.loopback", (message) => { latestReceiver = message; });
    const status = await app.next("status", 5000);
    assert.equal(status.recording, true, "LinkShell.app needs its existing Screen Recording permission");
    app.send({ t: "rtc.open", v: "fec-check", iceServers: [], fps: 30, maxWidth: 1920 });
    await app.next("rtc.offer", 10_000);
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline && !error && !proxy.failure) await wait(250);
    if (error || proxy.failure) throw error ?? proxy.failure;
    const result = {
      receiver: declines ? "FlexFEC declined" : "M154 FlexFEC receiver",
      conditions: { delayMsEachWay: delayMs, mediaLossPercent: 5, seconds: durationMs / 1000, fps: 30, maxWidth: 1920 },
      negotiation: latestSender?.flexfec,
      proxy: { ...proxy.counts },
      received: {
        framesDecoded: latestReceiver?.framesDecoded,
        fecPackets: latestReceiver?.fecPacketsReceived,
        fecBytes: latestReceiver?.fecBytesReceived,
        nack: latestReceiver?.nack,
      },
      recoveryCount: null,
      recoveryNote: "M154 public RTCStatistics does not expose a FlexFEC recovery count; protection receipt is not a recovery measurement.",
    };
    console.log(JSON.stringify(result, null, 2));
    assert.ok(result.received.framesDecoded > 0, "no decoded video");
    assert.ok(result.proxy.droppedMediaPackets > 0, "the media did not traverse the loss proxy");
    assert.equal(result.negotiation?.state, declines ? "declined" : "negotiated");
    if (declines) {
      assert.equal(result.proxy.forwardedRepairPackets, 0, "FlexFEC was sent to a receiver which declined it");
    } else {
      assert.ok(result.proxy.forwardedRepairPackets > 0, "no FlexFEC repair packets were sent");
      assert.ok(result.received.fecPackets > 0, "the receiver did not report protection packets");
    }
    return result;
  } finally {
    try {
      if (app) assert.ok(await app.close(), "the test app did not end with its socket");
    } finally {
      proxy.close();
    }
  }
}

const results = [];
try {
  for (const declines of [false, true]) results.push(await run(declines));
  console.log("[flexfec-check] passed: protection packets arrived, and an unsupported receiver still decoded without them");
} catch (error) {
  console.error(`[flexfec-check] FAILED: ${error.message}`);
  process.exitCode = 1;
}
const json = process.argv.indexOf("--json");
if (json >= 0) writeFileSync(process.argv[json + 1], `${JSON.stringify(results, null, 2)}\n`);
