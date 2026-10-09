#!/usr/bin/env node
// Proves that pictures flow, with no viewer: has the built LinkShell.app answer its own offer
// (`--loopback`: a second peer connection in the same process receives and decodes the track)
// and reports both ends' numbers.
//
//   node tools/loopback.mjs [--fps 30,60] [--maxFps 60] [--seconds 10] [--maxWidth 1920] [--screen 0] [--codec h264]
//                           [--still] [--motion] [--encoder own|stock] [--no-low-latency] [--trial <name>=<value>]
//                           [--narrow <bit/s>:<from second>:<for seconds>] [--timeline]
//                           [--no-playout-delay] [--no-flexfec] [--loopback-no-flexfec] [--rtc-log] [--json <file>]
//
// Without --fps it is one run at the app's own choice of frame rate: 60, and 30 while 60 is not
// carried. --maxFps 120 opts into the 120/60/30 ladder on a display that supports 120 Hz.
// --fps names rates to hold, one run each ("auto" among them is the app's own choice).
//
// --narrow holds the bandwidth estimate down for a while, as a narrow network does (without its
// loss and delay): `--narrow 1500000:8:25` is 1.5 Mbit/s from the 8th second for 25. It prints
// every second (as --timeline does), and each change of frame rate with the longest wait for a
// frame across it. Where the app chooses the rate, the run fails unless the rate went down and
// came back up.
//
// The clock strip is shown while it runs (unless --still): it changes at every refresh of the
// display, so the capture has a new picture every time, and the receiving end reads it back to
// say how long a frame took from the glass to being decoded. --still leaves the screen as it is,
// to see what a quiet screen costs. --motion adds the window of moving text: a busy screen's work
// for the encoder. --encoder chooses the H.264 encoder: the app's own low-latency one, or libwebrtc's.
//
// The receiving end decodes in the same process, so the CPU figure is capture + encode + decode.
//
// Exits 1 when a run fails or its receiving end decoded no frame.

import { writeFileSync } from "node:fs";
import { launch } from "./app.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const rates = value("--fps", "auto").split(",").map((rate) => (rate === "auto" ? undefined : Number(rate)));
const seconds = Number(value("--seconds", "10"));
const narrow = value("--narrow")?.split(":").map(Number);
const timeline = args.includes("--timeline") || Boolean(narrow);
const still = args.includes("--still");
const flags = [
  "--loopback",
  ...(still ? [] : ["--clock"]),
  ...["--rtc-log", "--no-playout-delay", "--motion", "--no-low-latency", "--no-flexfec", "--loopback-no-flexfec"].filter((flag) => args.includes(flag)),
  ...(value("--encoder") ? ["--encoder", value("--encoder")] : []),
  ...(value("--trial") ? ["--trial", value("--trial")] : []),
];
/** Seconds left out of the averages: the connection coming up and the bitrate finding its level. */
const WARM_UP = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mean = (values) => {
  const numbers = values.filter((item) => typeof item === "number");
  return numbers.length ? numbers.reduce((total, item) => total + item, 0) / numbers.length : undefined;
};
const show = (number, digits = 0) => (typeof number === "number" ? number.toFixed(digits) : "–");
const megabits = (bits) => (typeof bits === "number" ? `${(bits / 1e6).toFixed(2)} Mbit/s` : "–");

async function run(fps) {
  const app = await launch(flags);
  const sender = [];
  const receiver = [];
  const cpu = [];
  const logs = [];
  const changes = [];
  let error;
  app.on("log", (message) => {
    logs.push(message.message);
    if (args.includes("--rtc-log") || !message.message.startsWith("rtc: ")) console.log(`  log  ${message.message}`);
    // Said after a second's numbers: the change is in the seconds that follow.
    const change = /^frame rate (\d+) → (\d+): /.exec(message.message);
    if (change) changes.push({ second: sender.length, from: Number(change[1]), to: Number(change[2]), said: message.message, got: receiver.length });
  });
  app.on("rtc.error", (message) => (error = message.message));
  app.on("rtc.state", (message) => console.log(`  state  ice ${message.ice}, connection ${message.connection}`));
  app.on("rtc.stats", (message) => {
    sender.push(message);
    cpu.push(app.cpu());
    if (!timeline) return;
    const got = receiver.at(-1) ?? {};
    console.log(
      `  ${String(sender.length).padStart(3)} s  ${message.frameRate} fps  ${message.width ?? "–"}×${message.height ?? "–"}  captured ${message.captureFps}, encoded ${show(message.fps)}` +
        `  ${megabits(message.bitrate)} (estimate ${megabits(message.availableOutgoing)})  limited by ${message.qualityLimitation ?? "–"}` +
        `  longest wait: capture ${show(message.gapMs)} ms, decoded ${show(got.gapMs)} ms${got.latency?.n > 0 ? `  glass → decoded p50 ${got.latency.p50} ms` : ""}` +
        `  (unsent ${show(message.sendDelayMs)} ms, jitter buffer ${show(got.jitterBufferMs)} ms)`,
    );
  });
  app.on("rtc.loopback", (message) => receiver.push(message));

  let result;
  try {
    const status = await app.next("status", 5000);
    console.log(`  status ${JSON.stringify(status)}   (pid ${app.pid})`);
    if (!status.recording) throw new Error("recording is false: Screen Recording is not allowed for this LinkShell.app — not asking again");
    app.cpu();
    app.send({ t: "rtc.open", v: "loop", iceServers: [], fps, maxFps: Number(value("--maxFps", "60")), maxWidth: Number(value("--maxWidth", "1920")), screen: Number(value("--screen", "0")), codec: value("--codec", "h264") });
    await app.next("rtc.offer", 10_000);
    for (let second = 0; second < seconds + WARM_UP && !error; second += 1) {
      if (narrow && second === narrow[1]) {
        console.log(`  the estimate is held to ${megabits(narrow[0])}`);
        app.send({ t: "rtc.loopback.limit", v: "loop", bitrate: narrow[0] });
      }
      if (narrow && second === narrow[1] + narrow[2]) {
        console.log("  the estimate is let go");
        app.send({ t: "rtc.loopback.limit", v: "loop" });
      }
      await sleep(1000);
    }
    if (error) throw new Error(error);

    const sent = sender.slice(WARM_UP);
    const got = receiver.slice(WARM_UP);
    const last = sender.at(-1) ?? {};
    const lastGot = receiver.at(-1) ?? {};
    const latencies = got.map((sample) => sample.latency).filter((latency) => latency?.n > 0);
    result = {
      fps: fps ?? "auto",
      screen: Number(value("--screen", "0")),
      maxWidth: Number(value("--maxWidth", "1920")),
      maxFps: Number(value("--maxFps", "60")),
      seconds: sent.length,
      // Each change of frame rate, with the longest wait for a frame in the two seconds after it
      // was said, the worst second's median from the glass to a decoded frame in the three after
      // it, and the picture sent just before it and at the end of the rate it changed to.
      changes: changes.map((change, index) => {
        const until = changes[index + 1]?.second ?? sender.length;
        return {
          second: change.second,
          from: change.from,
          to: change.to,
          said: change.said,
          captureGapMs: Math.max(...sender.slice(change.second, change.second + 2).map((sample) => sample.gapMs ?? 0)),
          decodedGapMs: Math.max(...receiver.slice(change.got, change.got + 2).map((sample) => sample.gapMs ?? 0)),
          latencyMs: still ? undefined : Math.max(...receiver.slice(change.got, change.got + 3).map((sample) => sample.latency?.p50 ?? 0)),
          widthBefore: sender[change.second - 1]?.width,
          widthAfter: sender[until - 1]?.width,
        };
      }),
      timeline: timeline ? { sender, receiver } : undefined,
      sender: {
        frameRate: [...new Set(sent.map((sample) => sample.frameRate))].join(","),
        captureFps: mean(sent.map((sample) => sample.captureFps)),
        repeated: mean(sent.map((sample) => sample.repeated)),
        encodedFps: mean(sent.map((sample) => sample.fps)),
        encoder: last.encoder,
        flexfec: last.flexfec,
        hardware: last.hardware,
        codec: last.codec,
        fmtp: last.fmtp,
        width: last.width,
        height: last.height,
        bitrate: mean(sent.map((sample) => sample.bitrate)),
        targetBitrate: mean(sent.map((sample) => sample.targetBitrate)),
        availableOutgoing: last.availableOutgoing,
        encodeMs: mean(sent.map((sample) => sample.encodeMs)),
        sendDelayMs: mean(sent.map((sample) => sample.sendDelayMs)),
        hugeFrames: last.hugeFrames,
        keyFrames: last.keyFrames,
        qualityLimitation: [...new Set(sent.map((sample) => sample.qualityLimitation))].join(","),
        rttMs: mean(sent.map((sample) => sample.rttMs)),
        packetsLost: last.packetsLost,
        nack: last.nack,
        pli: last.pli,
      },
      receiver: {
        framesReceived: lastGot.framesReceived,
        framesDecoded: lastGot.framesDecoded,
        fps: mean(got.map((sample) => sample.fps)),
        width: lastGot.width,
        height: lastGot.height,
        bitrate: mean(got.map((sample) => sample.bitrate)),
        decoder: lastGot.decoder,
        jitterBufferMs: mean(got.map((sample) => sample.jitterBufferMs)),
        decodeMs: mean(got.map((sample) => sample.decodeMs)),
        framesDropped: lastGot.framesDropped,
        fecPacketsReceived: lastGot.fecPacketsReceived,
        fecBytesReceived: lastGot.fecBytesReceived,
        freezes: lastGot.freezes,
        gapMs: Math.max(...got.map((sample) => sample.gapMs ?? 0)),
        keyFrames: lastGot.keyFrames,
        cursorMessages: lastGot.heard?.cursor ?? 0,
        latency: latencies.length
          ? {
              n: latencies.reduce((total, latency) => total + latency.n, 0),
              min: Math.min(...latencies.map((latency) => latency.min)),
              p50: mean(latencies.map((latency) => latency.p50)),
              p95: mean(latencies.map((latency) => latency.p95)),
              max: Math.max(...latencies.map((latency) => latency.max)),
            }
          : undefined,
        unreadable: still ? undefined : got.reduce((total, sample) => total + (sample.invalid ?? 0), 0),
      },
      cpu: { average: mean(cpu.slice(WARM_UP).map((sample) => sample.average)), ps: cpu.at(-1)?.ps },
      agreed: logs.find((line) => line.startsWith("agreed:")),
      strip: (() => {
        const checks = sent.map((sample) => sample.clock).filter((check) => check?.n > 0);
        return checks.length
          ? { n: checks.reduce((total, check) => total + check.n, 0), min: Math.min(...checks.map((check) => check.min)), median: mean(checks.map((check) => check.median)), max: Math.max(...checks.map((check) => check.max)) }
          : undefined;
      })(),
    };
    app.send({ t: "rtc.close", v: "loop" });
  } catch (failure) {
    console.error(`  FAILED ${failure.message}`);
  }
  const went = await app.close();
  if (!went) console.error("  THE APP DID NOT END WITH THE SOCKET (killed)");
  return result;
}

const results = [];
for (const fps of rates) {
  console.log(`\n== ${fps === undefined ? "the app's own frame rate" : `${fps} fps`}, ${seconds} s${still ? ", still screen" : ", clock strip on"} ==`);
  const result = await run(fps);
  if (!result) {
    process.exitCode = 1;
    continue;
  }
  results.push(result);
  const { sender, receiver, cpu } = result;
  if (!(receiver.framesDecoded > 0)) process.exitCode = 1;
  console.log(`  ${result.agreed ?? ""}`);
  console.log(`  sender    frame rate ${sender.frameRate}: captured ${show(sender.captureFps, 1)} fps (+${show(sender.repeated, 1)} repeated), encoded ${show(sender.encodedFps, 1)} fps, ${sender.width}×${sender.height}`);
  console.log(`            ${sender.encoder} (${sender.hardware ? "hardware" : "not hardware"}), ${sender.codec} ${sender.fmtp ?? ""}`);
  console.log(`            ${megabits(sender.bitrate)} sent (target ${megabits(sender.targetBitrate)}, estimate ${megabits(sender.availableOutgoing)}), encode ${show(sender.encodeMs, 1)} ms/frame, then ${show(sender.sendDelayMs, 1)} ms a packet waiting to be sent`);
  console.log(`            key frames ${sender.keyFrames}, limited by ${sender.qualityLimitation}, rtt ${show(sender.rttMs, 1)} ms, lost ${sender.packetsLost}, nack ${sender.nack}, pli ${sender.pli}`);
  console.log(`  receiver  ${receiver.framesReceived} frames received, ${receiver.framesDecoded} decoded (${receiver.decoder}), ${show(receiver.fps, 1)} fps, ${receiver.width}×${receiver.height}, ${megabits(receiver.bitrate)}`);
  console.log(`            jitter buffer ${show(receiver.jitterBufferMs, 1)} ms, decode ${show(receiver.decodeMs, 1)} ms/frame, dropped ${receiver.framesDropped}, freezes ${receiver.freezes}, longest wait for a frame ${show(receiver.gapMs)} ms`);
  console.log(`  FlexFEC   ${sender.flexfec?.state ?? "unknown"}; receiver counted ${show(receiver.fecPacketsReceived)} protection packets, ${show(receiver.fecBytesReceived)} bytes (not a recovery count)`);
  if (receiver.latency) console.log(`            glass → decoded: p50 ${show(receiver.latency.p50)} ms, p95 ${show(receiver.latency.p95)} ms (min ${receiver.latency.min}, max ${receiver.latency.max}, ${receiver.latency.n} frames, ${receiver.unreadable} unreadable)`);
  if (result.strip) console.log(`            the strip as captured − the time the capture says it was displayed: median ${show(result.strip.median, 1)} ms (min ${result.strip.min}, max ${result.strip.max}, ${result.strip.n} frames)`);
  console.log(`  channels  the receiving end got ${receiver.cursorMessages} cursor messages (they are sent when the pointer moves); input-check.mjs proves the other channels`);
  console.log(`  cpu       ${show(cpu.average, 1)}% of one core (from CPU time), ps says ${show(cpu.ps, 1)}%   — capture + encode + decode`);
  for (const change of result.changes) {
    console.log(`  change    at ${change.second} s: ${change.said}`);
    console.log(`            longest wait for a frame across it: ${change.captureGapMs} ms captured, ${change.decodedGapMs} ms decoded${still ? "" : `; glass → decoded p50 at most ${change.latencyMs} ms in the three seconds after`}`);
    console.log(`            ${change.widthBefore} wide before it, ${change.widthAfter} wide by the end of ${change.to} fps`);
  }
  if (narrow && fps === undefined) {
    const down = result.changes.findIndex((change) => change.to < change.from);
    const up = result.changes.findIndex((change, index) => index > down && change.to > change.from);
    if (down < 0 || up < 0) {
      console.error(`  FAILED the frame rate ${down < 0 ? "did not go down" : "went down and did not come back up"}`);
      process.exitCode = 1;
    }
  }
}
if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify(results, null, 2)}\n`);
