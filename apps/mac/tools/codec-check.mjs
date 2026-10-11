#!/usr/bin/env node
// Compare VideoToolbox encoders without RTP or a network controller. No decoder or physical
// presentation is measured here. --fps is a request; the source display must supply it.
// TMPDIR=/tmp node tools/codec-check.mjs --screen 1 --fps 120 --maxWidth 2560 --codec hevc --bitrate 5000000
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, launch } from "./app.mjs";
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const seconds = Number(value("--seconds", "12"));
const conditions = { codec: value("--codec", "h264"), fps: Number(value("--fps", "120")),
  maxWidth: Number(value("--maxWidth", "1920")), screen: Number(value("--screen", "0")), bitrate: Number(value("--bitrate", "5000000")), seconds };
conditions.pending = Number(value("--pending", "2"));
conditions.appSha256 = createHash("sha256").update(readFileSync(join(APP, "Contents/MacOS/LinkShell"))).digest("hex");
assert.ok(["h264", "hevc"].includes(conditions.codec) && seconds >= 1 && seconds <= 120);
assert.ok(Number.isInteger(conditions.pending) && conditions.pending >= 1 && conditions.pending <= 8);
assert.ok(Number.isInteger(conditions.fps) && conditions.fps >= 1 && conditions.fps <= 120);
assert.ok(Number.isInteger(conditions.maxWidth) && conditions.maxWidth >= 160 && conditions.maxWidth <= 3840);
assert.ok(Number.isInteger(conditions.screen) && conditions.screen >= 0);
assert.ok(Number.isFinite(conditions.bitrate) && conditions.bitrate >= 80_000 && conditions.bitrate <= 30_000_000);
const rows = [];
let ready, failure;
const app = await launch(["--loopback", "--media-lab", "--lab-codec-only", "--full-screen-motion", "--lab-bitrate", String(conditions.bitrate), "--lab-encoder-pending", String(conditions.pending)]);
try {
  app.on("lab.error", ({ message }) => { failure = new Error(message); });
  app.on("lab.stats", (row) => { rows.push(row); console.log(JSON.stringify({ second: rows.length, captured: row.captureFps, encoded: row.encodedFps, encodeMs: row.encodeMs, bitrate: row.bitrate })); });
  const status = await app.next("status", 5000);
  assert.ok(status.recording, "existing recording permission is required");
  app.send({ t: "lab.open", v: "codec-check", ...conditions });
  ready = await app.next("lab.ready", 10_000);
  console.log(JSON.stringify({ ready }));
  app.send({ t: "lab.route", v: "codec-check", senderPort: ready.receiverPort, receiverPort: ready.senderPort });
  const until = Date.now() + (seconds + 3) * 1000;
  while (Date.now() < until && !failure) await new Promise((resolve) => setTimeout(resolve, 250));
  if (failure) throw failure;
  assert.equal(ready.codec, conditions.codec);
  assert.ok(rows.slice(3).some((row) => row.encodedFps > 0), "encoder produced no frames");
} finally {
  assert.ok(await app.close(), "codec helper did not exit");
  const result = { conditions, ready, rows };
  if (value("--json")) writeFileSync(value("--json"), `${JSON.stringify(result, null, 2)}\n`);
}
