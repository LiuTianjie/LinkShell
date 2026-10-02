#!/usr/bin/env node
// Checks the stream LinkShell.app encodes for the host's socket (`stream.open`): the fallback for
// a viewer the video track can't reach. Opens the built app as the host does, runs a scripted
// session, reads the records off the socket and judges them; then, where they are installed, has
// ffprobe and ffmpeg decode what came, to prove it is H.264 any decoder takes.
//
//   node tools/stream-check.mjs [--ladder] [--gop 1] [--profile baseline|high] [--screen 0]
//                               [--seconds 5] [--flags "--no-low-latency"]
//                               [--keep <directory>] [--json <file>] [--only still|busy|beside]
//                               [--no-chrome] [--chrome <path to Chrome>]
//
// The session: open at 1600 wide, 20 a second, 3 Mbit/s → `stream.set` the bitrate → `stream.set`
// width 1024 → `stream.key` → `stream.close`. With --ladder it walks the host's five rungs instead
// (packages/host/src/screen-pacer.ts), down and back up, a `stream.set` each.
//
// It runs twice: on the screen as it is, which is mostly still (what a quiet screen costs, and
// the key frame every `gop` seconds), and with the clock strip and the window of moving text
// (`--clock --motion`), which give the encoder a busy screen's work. A third, short run has a
// video track open for another viewer beside the stream (`rtc.open`, answered inside the app),
// closed and opened again while the stream runs: neither may disturb the other.
//
// The busy run's records are also decoded in a headless Chrome the way the host's page decodes
// them (packages/host/src/screen-viewer.ts: WebCodecs, the codec named from the SPS,
// `optimizeForLatency`, a new decoder at each generation), a frame at a time: each has to come
// out before the next goes in.
//
// Exits 1 when a check fails. ffmpeg, ffprobe and Chrome are used here only, never by the app;
// without them their checks are left out, and that is said.
//
// It runs the app in build/ and no copy of it elsewhere: the first time a copy built into another
// directory recorded the screen, macOS 26.7 put its question to the user again ("LinkShell is
// requesting to bypass the system private window picker…"), as it does for a program at a new path.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "./app.mjs";
import WebSocket from "ws";
import { nalUnits, parsePps, parseSlice, parseSps } from "./h264.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const seconds = Number(value("--seconds", "5"));
const gop = Number(value("--gop", "1"));
const profile = value("--profile");
const screen = Number(value("--screen", "0"));
const keep = value("--keep") ? resolve(value("--keep")) : undefined;
const extraFlags = value("--flags", "").split(/\s+/).filter(Boolean);
const chromePath = value("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

/** ffprobe and ffmpeg are both there to decode with. */
const canDecode = ["ffprobe", "ffmpeg"].every((program) => spawnSync(program, ["-version"], { stdio: "ignore" }).status === 0);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined);
const show = (number, digits = 0) => (typeof number === "number" && Number.isFinite(number) ? number.toFixed(digits) : "–");
const kilobits = (bits) => (typeof bits === "number" && Number.isFinite(bits) ? `${(bits / 1000).toFixed(0)} kbit/s` : "–");

const LADDER = [
  { width: 1600, fps: 20, bitrate: 3_000_000, ceiling: 4_000_000 },
  { width: 1440, fps: 15, bitrate: 1_500_000, ceiling: 2_000_000 },
  { width: 1280, fps: 12, bitrate: 900_000, ceiling: 1_300_000 },
  { width: 1024, fps: 10, bitrate: 500_000, ceiling: 700_000 },
  { width: 854, fps: 8, bitrate: 260_000, ceiling: 380_000 },
];

/** What is asked of the app, a step at a time; each step is held for `seconds`. */
const STEPS = args.includes("--ladder")
  ? [
      { name: "rung 0", open: LADDER[0] },
      ...[1, 2, 3, 4, 3, 2, 1, 0].map((rung) => ({ name: `rung ${rung}`, set: LADDER[rung] })),
      { name: "after stream.key", key: true },
    ]
  : [
      { name: "open 1600w 20fps 3M", open: LADDER[0] },
      { name: "set bitrate 1.5M", set: { bitrate: 1_500_000, ceiling: 2_000_000 } },
      { name: "set width 1024", set: { width: 1024 } },
      { name: "after stream.key", key: true },
    ];

/** The short run beside a video track: the stream, then the track closed and opened again under it. */
const BESIDE = [
  { name: "beside a video track", open: LADDER[0] },
  { name: "the track opened again", track: true },
];

const rows = [];
const row = (run, name, ok, detail = "") => rows.push({ run, name, ok, detail: String(detail) });

/** A socket the app writes its records to, and the records as they come. */
function listen() {
  const path = join(tmpdir(), `linkshell-stream-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  const records = [];
  const state = { path, records, connected: false, ended: false, malformed: undefined, trailing: 0 };
  let buffer = Buffer.alloc(0);
  const server = createServer((socket) => {
    state.connected = true;
    server.close();
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const at = performance.now();
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 6) {
        const length = buffer.readUInt32BE(0);
        if (length === 0 || length > 16 * 1024 * 1024) {
          state.malformed ??= `a record of ${length} bytes`;
          buffer = Buffer.alloc(0);
          return;
        }
        if (buffer.length < 6 + length) break;
        records.push({ at, flags: buffer[4], generation: buffer[5], payload: Buffer.from(buffer.subarray(6, 6 + length)) });
        buffer = buffer.subarray(6 + length);
      }
    });
    socket.on("close", () => {
      state.ended = true;
      state.trailing = buffer.length;
    });
  });
  return new Promise((done) => {
    server.listen(path, () => {
      chmodSync(path, 0o600);
      done(state);
    });
  });
}

/** Reads each record's frame: its NAL units, whether it stands by itself, its size and quantizer. */
function read(records) {
  let sps;
  let pps;
  for (const record of records) {
    const units = nalUnits(record.payload);
    record.types = units.map((unit) => unit.type);
    record.startsWithCode = record.payload[0] === 0 && record.payload[1] === 0 && (record.payload[2] === 1 || (record.payload[2] === 0 && record.payload[3] === 1));
    try {
      for (const unit of units) {
        if (unit.type === 7) record.sps = sps = parseSps(unit.data);
        else if (unit.type === 8) pps = parsePps(unit.data);
        else if ((unit.type === 1 || unit.type === 5) && sps && pps && !record.slice) record.slice = parseSlice(unit, sps, pps);
      }
    } catch (error) {
      record.unreadable = error.message;
    }
    record.size = sps ? `${sps.width}×${sps.height}` : "?";
    record.key = record.types.includes(5);
  }
}

function ffprobe(file) {
  const probed = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level,width,height,pix_fmt,has_b_frames,nb_read_frames,color_space", "-of", "json", file], { encoding: "utf8" });
  let stream;
  try {
    stream = JSON.parse(probed.stdout).streams[0];
  } catch {
    // Said below.
  }
  // Every frame decoded, and anything the decoder objects to.
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  return { stream, errors: `${probed.stderr}${decoded.stderr}`.trim(), status: decoded.status };
}

// The page's own way with a frame, a frame at a time. `held`: frames that had not come out when
// the next one went in — a decoder waiting to see whether a later frame is to be shown first.
const DECODE_PAGE = `<!doctype html><meta charset="utf-8"><script>
const hex = (n) => n.toString(16).padStart(2, "0");
function sps(unit) {
  for (let i = 0; i + 3 < unit.length; i++)
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1 && (unit[i + 3] & 0x1f) === 7) return unit.subarray(i + 3);
}
async function decodeAll() {
  const data = new Uint8Array(await (await fetch("/records")).arrayBuffer());
  const view = new DataView(data.buffer);
  const result = { fed: 0, out: 0, held: 0, slowest: 0, errors: [], sizes: {}, configs: [] };
  let decoder, generation = -1;
  for (let at = 0, seq = 1; at < data.length; seq++) {
    const length = view.getUint32(at), key = (data[at + 4] & 1) === 1, unit = data.subarray(at + 6, at + 6 + length);
    if (data[at + 5] !== generation) {
      generation = data[at + 5];
      try { if (decoder) decoder.close(); } catch {}
      decoder = undefined;
    }
    at += 6 + length;
    if (!decoder) {
      const params = key && sps(unit);
      if (!params) continue;
      const config = { codec: "avc1." + hex(params[1]) + hex(params[2]) + hex(params[3]), optimizeForLatency: true };
      result.configs.push({ codec: config.codec, supported: (await VideoDecoder.isConfigSupported(config)).supported });
      decoder = new VideoDecoder({
        output: (frame) => {
          result.out += 1;
          const size = frame.displayWidth + "×" + frame.displayHeight;
          result.sizes[size] = (result.sizes[size] || 0) + 1;
          frame.close();
        },
        error: (error) => result.errors.push(error.message),
      });
      decoder.configure(config);
    }
    const before = result.out, began = performance.now();
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: seq, data: unit }));
    result.fed += 1;
    while (result.out === before && !result.errors.length && performance.now() - began < 300) await new Promise((done) => setTimeout(done, 0));
    if (result.out === before) result.held += 1;
    else result.slowest = Math.max(result.slowest, performance.now() - began);
    if (result.errors.length) break;
  }
  return result;
}
</script>`;

/** Decodes the records in a headless Chrome, as the host's page would. Undefined where there is no Chrome. */
async function decodeInChrome(records) {
  if (!existsSync(chromePath)) return undefined;
  const body = Buffer.concat(records.map((record) => {
    const head = Buffer.alloc(6);
    head.writeUInt32BE(record.payload.length, 0);
    head[4] = record.flags;
    head[5] = record.generation;
    return Buffer.concat([head, record.payload]);
  }));
  // WebCodecs is only there for a page from a secure place: this computer counts as one.
  const server = createHttpServer((request, response) => {
    if (request.url === "/records") response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DECODE_PAGE);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const profileDirectory = mkdtempSync(join(tmpdir(), "linkshell-stream-chrome-"));
  const child = spawn(chromePath, ["--headless=new", `--user-data-dir=${profileDirectory}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "about:blank"], { stdio: "ignore" });
  try {
    const portFile = join(profileDirectory, "DevToolsActivePort");
    for (let waited = 0; !existsSync(portFile); waited += 100) {
      if (waited > 15_000) throw new Error("Chrome did not start");
      await sleep(100);
    }
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    let page;
    for (let waited = 0; !page; waited += 100) {
      if (waited > 10_000) throw new Error("Chrome opened no page");
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json(), () => []);
      page = targets.find((target) => target.type === "page");
      if (!page) await sleep(100);
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, failed) => socket.once("open", done).once("error", failed));
    const waiting = new Map();
    let calls = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id) waiting.get(message.id)?.(message);
    });
    const call = (method, params) => new Promise((done) => {
      waiting.set(++calls, done);
      socket.send(JSON.stringify({ id: calls, method, params }));
    });
    await call("Page.enable");
    const loaded = new Promise((done) => socket.on("message", (data) => JSON.parse(data.toString()).method === "Page.loadEventFired" && done()));
    await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    await loaded;
    const version = await call("Browser.getVersion");
    const { result } = await call("Runtime.evaluate", { expression: "decodeAll()", returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    socket.close();
    return { ...result.result.value, browser: version.result?.product };
  } finally {
    server.close();
    child.kill("SIGTERM");
    await new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done)));
    rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function run(name, flags, steps = STEPS) {
  console.log(`\n== ${name} ==`);
  const opened = await launch([...flags, ...extraFlags]);
  const messages = [];
  /** The video track beside the stream, when there is one: what its receiving end has decoded. */
  const track = { decoded: [], errors: [] };
  opened.on("*", (message) => {
    if (message.t.startsWith("stream.")) messages.push({ ...message, at: performance.now() });
    if (message.t === "rtc.loopback") track.decoded.push({ at: performance.now(), frames: message.framesDecoded ?? 0 });
    if (message.t === "rtc.error") track.errors.push(message.message);
    if (message.t === "log" && !message.message.startsWith("channel ")) console.log(`  log  ${message.message}`);
  });
  const openTrack = () => opened.send({ t: "rtc.open", v: "track", iceServers: [], fps: 30, maxWidth: 1280, screen });
  const pipe = await listen();
  const phases = [];
  let cpu;
  try {
    const status = await opened.next("status", 5000);
    if (!status.recording) throw new Error("recording is false: Screen Recording is not allowed for this LinkShell.app — not asking");
    opened.cpu();
    if (steps === BESIDE) {
      openTrack();
      await opened.next("rtc.offer", 10_000);
    }
    for (const step of steps) {
      const phase = { name: step.name, from: pipe.records.length, sent: performance.now() };
      if (step.open) {
        phase.asked = { ...step.open };
        opened.send({ t: "stream.open", v: "check", screen, socket: pipe.path, gop, ...(profile ? { profile } : {}), ...step.open });
      } else if (step.set) {
        phase.asked = { ...phases.at(-1).asked, ...step.set };
        phase.resized = step.set.width !== undefined && step.set.width !== phases.at(-1).asked.width;
        opened.send({ t: "stream.set", v: "check", ...step.set });
      } else if (step.key) {
        phase.asked = { ...phases.at(-1).asked };
        // Away from the key frame the `gop` makes: half an interval after the last one.
        const lastKey = () => pipe.records.findLast((record) => record.flags & 1);
        const seen = lastKey();
        for (let waited = 0; lastKey() === seen && waited < Math.min(gop, 2) * 1000 + 500; waited += 5) await sleep(5);
        await sleep(Math.min(gop * 500, 1000));
        phase.from = pipe.records.length;
        phase.sent = performance.now();
        phase.keyAsked = true;
        opened.send({ t: "stream.key", v: "check" });
      } else if (step.track) {
        phase.asked = { ...phases.at(-1).asked };
        opened.send({ t: "rtc.close", v: "track" });
        await sleep(300);
        phase.sent = performance.now();
        phase.from = pipe.records.length;
        openTrack();
      }
      phases.push(phase);
      await sleep(seconds * 1000);
      phase.to = pipe.records.length;
      phase.until = performance.now();
    }
    cpu = opened.cpu().average;
    opened.send({ t: "stream.close", v: "check" });
    for (let waited = 0; !pipe.ended && waited < 3000; waited += 20) await sleep(20);
    if (steps === BESIDE) {
      // The stream has gone: the track must still be decoding.
      const before = track.decoded.at(-1)?.frames ?? 0;
      await sleep(2500);
      track.afterStream = (track.decoded.at(-1)?.frames ?? 0) - before;
      opened.send({ t: "rtc.close", v: "track" });
    }
  } catch (error) {
    row(name, "the session ran", false, error.message);
  }
  const went = await opened.close();
  rmSync(pipe.path, { force: true });

  // ── What came ─────────────────────────────────────────────────────
  const { records } = pipe;
  read(records);
  const started = messages.filter((message) => message.t === "stream.started");
  const ended = messages.filter((message) => message.t === "stream.ended");
  const stats = messages.filter((message) => message.t === "stream.stats");

  row(name, "the app connected to the socket and wrote records", pipe.connected && records.length > 0, `${records.length} records`);
  if (records.length === 0) return { name, phases: [] };

  const bad = records.filter((record) => record.unreadable || !record.startsWithCode || (record.flags & ~1) !== 0 || !record.types.some((type) => type === 1 || type === 5) || record.types.some((type) => ![1, 5, 6, 7, 8, 9].includes(type)));
  row(name, "every record is well formed: one access unit in Annex B, flags 0 or 1", !pipe.malformed && bad.length === 0, pipe.malformed ?? (bad.length ? `${bad.length} bad, the first: ${bad[0].unreadable ?? bad[0].types}` : `${records.length} records; NAL types ${[...new Set(records.flatMap((record) => record.types))].sort((a, b) => a - b).join(",")}`));
  const mismatched = records.filter((record) => Boolean(record.flags & 1) !== record.key);
  row(name, "flags bit 0 is set on the frames with an IDR slice, and no others", mismatched.length === 0, mismatched.length ? `${mismatched.length} differ` : `${records.filter((record) => record.key).length} key frames`);
  const bare = records.filter((record) => record.key && !(record.types.indexOf(7) >= 0 && record.types.indexOf(8) > record.types.indexOf(7) && record.types.indexOf(5) > record.types.indexOf(8)));
  row(name, "every key frame has its SPS and PPS in front", bare.length === 0, bare.length ? `${bare.length} without` : "");
  row(name, "the first record is a key frame", records[0].key, `NAL types ${records[0].types.join(",")}`);
  const delimited = records.filter((record) => record.types.includes(9)).length;
  const first = records[0].sps;
  row(name, "no frame waits on a later one (the stream says so, or the profile has no reordering)", first?.reorder === 0 || first?.profileIdc === 66, `${first?.profile} level ${first?.level}, ${first?.codec}, max_num_reorder_frames ${first?.reorder ?? "not said"}, ${first?.refFrames} reference frames; access unit delimiters: ${delimited ? delimited : "none"}`);
  row(name, "no B-frames", records.every((record) => record.slice?.type !== "B"), "");

  row(name, "the first frame comes soon after stream.open", started.length > 0 && started[0].at - phases[0].sent <= 2000, `stream.started ${show(started[0]?.at - phases[0].sent)} ms after stream.open, the first record ${show(records[0].at - phases[0].sent)} ms after`);

  // Generations: one more at each change of size, and never otherwise; each begins with a key frame.
  const generations = [];
  for (const [index, record] of records.entries()) {
    if (generations.at(-1)?.generation !== record.generation) generations.push({ generation: record.generation, from: index, key: record.key, size: record.size, at: record.at });
    generations.at(-1).to = index + 1;
  }
  const sizes = [];
  for (const record of records) if (sizes.at(-1) !== record.size) sizes.push(record.size);
  const expected = 1 + phases.filter((phase) => phase.resized).length;
  row(name, "the generation goes up by one exactly where the size changes", generations.length === sizes.length && generations.length === expected && generations.every((entry, index) => entry.generation === index % 256 && records.slice(entry.from, entry.to).every((record) => record.size === entry.size)), `${generations.map((entry) => `${entry.generation}: ${entry.size} (${entry.to - entry.from} frames)`).join(", ")}`);
  row(name, "the first record of each generation is a key frame", generations.every((entry) => entry.key), "");
  row(name, "stream.started after the first frame, and again at each change of size, with the size the stream has", started.length === generations.length && started.every((message, index) => `${message.width}×${message.height}` === generations[index].size && message.at >= generations[index].at - 50), started.map((message) => `${message.width}×${message.height}@${message.fps} gen ${message.generation} ${message.mode} ${message.profile}${message.hardware ? " hardware" : " SOFTWARE"}`).join("; "));

  // Each step: frames a second, bits a second, how coarse.
  for (const phase of phases) {
    // The first second is the change itself; the rate is judged on the rest.
    const settled = records.slice(phase.from, phase.to).filter((record) => record.at >= phase.sent + 1000);
    const span = (phase.until - phase.sent - 1000) / 1000;
    phase.frames = settled.length;
    phase.fps = settled.length / span;
    phase.bitrate = (settled.reduce((total, record) => total + record.payload.length, 0) * 8) / span;
    phase.keys = settled.filter((record) => record.key).length;
    phase.quantizer = mean(settled.filter((record) => !record.key && record.slice).map((record) => record.slice.qp));
    phase.keyQuantizer = mean(settled.filter((record) => record.key && record.slice).map((record) => record.slice.qp));
    phase.keyBytes = mean(settled.filter((record) => record.key).map((record) => record.payload.length));
    // The most in any one second.
    phase.peak = Math.max(0, ...settled.map((record, index) => settled.slice(index).filter((later) => later.at < record.at + 1000).reduce((total, later) => total + later.payload.length, 0) * 8));
    phase.size = settled.at(-1)?.size;
    const between = records.slice(phase.from, phase.to).filter((record) => record.key).map((record) => record.at);
    phase.keyGap = Math.max(0, ...between.slice(1).map((at, index) => at - between[index]));
    const during = stats.filter((message) => message.at >= phase.sent + 1000 && message.at <= phase.until);
    phase.encodeMs = mean(during.map((message) => message.encodeMs).filter((ms) => typeof ms === "number"));
    phase.dropped = during.reduce((total, message) => total + message.dropped, 0);
    phase.captured = mean(during.map((message) => message.captured));
  }

  // The longest wait for a key frame, over the whole stream.
  const keyTimes = records.filter((record) => record.key).map((record) => record.at);
  const longest = Math.max(0, ...keyTimes.slice(1).map((at, index) => at - keyTimes[index]));
  row(name, `a key frame at least every ${gop} s`, longest <= gop * 1000 * 1.25 + 100, `the longest wait ${show(longest)} ms, ${keyTimes.length} key frames`);

  const busy = flags.includes("--motion");
  for (const phase of phases) {
    const { asked } = phase;
    if (busy) {
      row(name, `${phase.name}: ${asked.fps} frames a second`, Math.abs(phase.fps - asked.fps) <= asked.fps * 0.1, `${show(phase.fps, 1)} fps`);
      // Near the rate asked, unless the picture is already as fine as it gets on less.
      const near = phase.bitrate <= asked.bitrate * 1.15 && (phase.bitrate >= asked.bitrate * 0.7 || phase.quantizer <= 24);
      row(name, `${phase.name}: about ${kilobits(asked.bitrate)}`, near, `${kilobits(phase.bitrate)}, the most in one second ${kilobits(phase.peak)} (ceiling ${kilobits(asked.ceiling)})`);
    } else {
      row(name, `${phase.name}: no more than ${asked.fps} frames a second, nor ${kilobits(asked.bitrate)}`, phase.fps <= asked.fps * 1.1 && phase.bitrate <= asked.bitrate * 1.15, `${show(phase.fps, 1)} fps, ${kilobits(phase.bitrate)}`);
    }
  }

  // The change of size: how long the picture stood still across it.
  for (const [index, entry] of generations.entries()) {
    if (index === 0) continue;
    const phase = phases.findLast((candidate) => candidate.resized && candidate.from <= entry.from);
    const before = records[entry.from - 1];
    const interval = 1000 / (phase?.asked.fps ?? 20);
    entry.gap = entry.at - before.at;
    entry.afterSet = phase ? entry.at - phase.sent : undefined;
    // On a still screen the last frame of the old size may be a second old: there the wait is the one after stream.set.
    row(name, `the size changes without a stall (generation ${entry.generation}, ${entry.size})`, Math.min(entry.gap, entry.afterSet ?? Infinity) <= Math.max(interval * 3, 250), `${show(entry.gap)} ms between the last frame of the old size and the first of the new (a frame is ${show(interval)} ms); ${show(entry.afterSet)} ms after stream.set`);
  }

  const keyPhase = phases.find((phase) => phase.keyAsked);
  if (keyPhase) {
    const after = records.slice(keyPhase.from);
    const position = after.findIndex((record) => record.key);
    row(name, "stream.key: a key frame within 2 frames", position >= 0 && position < 2, position < 0 ? "none came" : `frame ${position + 1} after it, ${show(after[position].at - keyPhase.sent)} ms later`);
  }

  row(name, "stream.close ends the stream without a stream.ended, and the socket closes", ended.length === 0 && pipe.ended, ended.length ? ended.map((message) => message.error).join("; ") : `${pipe.trailing} bytes of a frame cut off by the close`);
  row(name, "the app ended with its socket", went, "");

  // ── Decoded by ffmpeg ─────────────────────────────────────────────
  const directory = keep ?? mkdtempSync(join(tmpdir(), "linkshell-stream-check-"));
  mkdirSync(directory, { recursive: true });
  try {
    for (const entry of generations) {
      const file = join(directory, `${name.replace(/\W+/g, "-")}-generation-${entry.generation}.h264`);
      const frames = records.slice(entry.from, entry.to);
      if (keep || canDecode) writeFileSync(file, Buffer.concat(frames.map((record) => record.payload)));
      if (!canDecode) continue;
      const { stream, errors, status } = ffprobe(file);
      const [width, height] = entry.size.split("×").map(Number);
      const ok = status === 0 && !errors && stream?.codec_name === "h264" && stream.width === width && stream.height === height && Number(stream.nb_read_frames) === frames.length && stream.has_b_frames === 0;
      row(name, `ffprobe and ffmpeg decode generation ${entry.generation} with no error`, ok, errors ? errors.split("\n")[0] : `${stream?.codec_name} ${stream?.profile} level ${stream?.level / 10}, ${stream?.width}×${stream?.height} ${stream?.pix_fmt} ${stream?.color_space}, ${stream?.nb_read_frames} frames of ${frames.length}, has_b_frames ${stream?.has_b_frames}`);
    }
  } finally {
    if (!keep) rmSync(directory, { recursive: true, force: true });
  }

  if (steps === BESIDE) {
    for (const phase of phases) {
      const during = track.decoded.filter((sample) => sample.at >= phase.sent && sample.at <= phase.until);
      const frames = during.length ? during.at(-1).frames - (during[0].frames ?? 0) : 0;
      row(name, `${phase.name}: the track's pictures are decoded while the stream runs`, frames > 30 && track.errors.length === 0, track.errors.length ? track.errors.join("; ") : `${frames} frames decoded by the track's receiving end, ${phase.frames} frames in the stream`);
    }
    row(name, "the track goes on after the stream has closed", track.afterStream > 30, `${track.afterStream} more frames decoded`);
  }

  if (flags.includes("--motion") && steps === STEPS && !args.includes("--no-chrome")) {
    try {
      const chrome = await decodeInChrome(records);
      if (!chrome) console.log(`  no Chrome at ${chromePath}: not decoded as the page decodes`);
      else {
        const ok = chrome.errors.length === 0 && chrome.out === chrome.fed && chrome.fed === records.length && chrome.held === 0 && chrome.configs.every((config) => config.supported);
        row(name, "Chrome's WebCodecs decodes every frame as the page does, each out before the next goes in", ok, chrome.errors.length ? chrome.errors[0] : `${chrome.browser}: ${chrome.out} frames out of ${chrome.fed} in (${records.length} records), ${chrome.held} held back, the slowest ${show(chrome.slowest, 1)} ms; ${chrome.configs.map((config) => `${config.codec}${config.supported ? "" : " NOT SUPPORTED"}`).join(", ")}; ${Object.entries(chrome.sizes).map(([size, count]) => `${count} at ${size}`).join(", ")}`);
      }
    } catch (error) {
      row(name, "Chrome's WebCodecs decodes every frame as the page does, each out before the next goes in", false, error.message);
    }
  }

  console.log(`  ${"step".padEnd(22)} ${"size".padEnd(10)} ${"fps".padStart(5)} ${"captured".padStart(8)} ${"bitrate".padStart(12)} ${"peak 1 s".padStart(12)} ${"keys".padStart(4)} ${"key bytes".padStart(9)} ${"key QP".padStart(6)} ${"QP".padStart(5)} ${"encode".padStart(8)} ${"dropped".padStart(7)}`);
  for (const phase of phases) {
    console.log(`  ${phase.name.padEnd(22)} ${String(phase.size).padEnd(10)} ${show(phase.fps, 1).padStart(5)} ${show(phase.captured, 1).padStart(8)} ${kilobits(phase.bitrate).padStart(12)} ${kilobits(phase.peak).padStart(12)} ${String(phase.keys).padStart(4)} ${show(phase.keyBytes).padStart(9)} ${show(phase.keyQuantizer, 1).padStart(6)} ${show(phase.quantizer, 1).padStart(5)} ${`${show(phase.encodeMs, 1)} ms`.padStart(8)} ${String(phase.dropped).padStart(7)}`);
  }
  console.log(`  cpu ${show(cpu, 1)}% of one core (capture + encode${flags.includes("--motion") ? " + drawing the strip and the moving window" : ""})`);
  return { name, cpu, phases: phases.map(({ from, to, sent, until, ...rest }) => rest), generations, started, records: records.length };
}

const results = [];
const only = value("--only");
if (!only || only === "still") results.push(await run("still screen", []));
if (!only || only === "busy") results.push(await run("busy screen", ["--clock", "--motion"]));
if (!only || only === "beside") results.push(await run("beside a video track", ["--clock", "--motion", "--loopback"], BESIDE));

console.log("");
let failed = 0;
let last;
for (const entry of rows) {
  if (entry.run !== last) console.log(`${entry.run}`);
  last = entry.run;
  if (!entry.ok) failed += 1;
  console.log(`  ${entry.ok ? "ok  " : "FAIL"}  ${entry.name}${entry.detail ? `  — ${entry.detail}` : ""}`);
}
if (canDecode) console.log(`\n${execFileSync("ffprobe", ["-version"], { encoding: "utf8" }).split("\n")[0]}`);
else console.log("\nffprobe and ffmpeg are not installed: nothing was decoded by them");
console.log(failed ? `\n[stream-check] FAILED: ${failed} of ${rows.length} checks` : `\n[stream-check] ok: ${rows.length} checks`);
if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify({ gop, profile, results, rows }, null, 2)}\n`);
process.exit(failed ? 1 : 0);
