#!/usr/bin/env node
// Real ScreenCaptureKit + WebRTC loopback: configure and return without another offer.
// node tools/screen-reuse-check.mjs [--app /absolute/LinkShell.app]
// Input uses --dry-run: this never clicks or types into the user's apps.
import assert from "node:assert/strict";
import { launch } from "./app.mjs";

const args = process.argv.slice(2);
const appPath = args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined;
const app = await launch(["--loopback", "--dry-run"], appPath ? { app: appPath } : {});
const messages = [];
const waiters = new Set();
app.on("*", (message) => {
  messages.push(message);
  for (const waiter of waiters) if (waiter.match(message)) waiter.resolve(message);
});
const wait = (match, timeout = 12_000) => new Promise((resolve, reject) => {
  const waiter = { match, resolve: (message) => { clearTimeout(timer); waiters.delete(waiter); resolve(message); } };
  const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("Timed out waiting for the screen state")); }, timeout);
  waiters.add(waiter);
});
const next = (kind, match = () => true) => wait((message) => message.t === kind && match(message));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let requestId = 0;
let screen = 0;
let width = 1280;
let generation = 0;
const configure = async (paused = false, changes = {}) => {
  screen = changes.screen ?? screen;
  width = changes.width ?? width;
  const id = ++requestId;
  const reply = wait((message) => ["rtc.configured", "rtc.configure.error"].includes(message.t) && message.requestId === id);
  app.send({ t: "rtc.configure", v: "reuse", requestId: id, screen, maxWidth: width, maxFps: 120, paused, inputGeneration: ++generation });
  const applied = await reply;
  assert.equal(applied.t, "rtc.configured", applied.message);
  assert.equal(applied.generation, generation);
  assert.equal(applied.paused, paused);
  return applied;
};
const decoded = async (applied) => {
  const before = messages.findLast((message) => message.t === "rtc.loopback")?.framesDecoded ?? 0;
  return next("rtc.loopback", (message) => message.width === applied.width && message.height === applied.height && message.framesDecoded > before);
};
const sendInput = (screenGeneration, events) => app.send({
  t: "rtc.loopback.send", v: "reuse", channel: "input",
  events: events.map((event) => ({ ...event, screenGeneration })),
});

try {
  app.send({ t: "status" });
  const status = await next("status");
  assert.equal(status.videoReconfigure, true, "The tested app must advertise configuration support");
  assert.equal(status.recording, true, "The tested app has no Screen Recording permission; the check does not request it");
  app.send({ t: "displays" });
  const displays = (await next("displays")).list;
  assert.ok(displays.length > 0);
  screen = displays[0].screen;
  app.send({ t: "rtc.open", v: "reuse", screen, iceServers: [], maxWidth: width, maxFps: 60 });
  await next("rtc.loopback", (message) => message.framesDecoded > 0);
  const initialOfferCount = messages.filter((message) => message.t === "rtc.offer").length;
  assert.equal(initialOfferCount, 1);

  let applied = await configure(false, { width: 1920 });
  await decoded(applied);
  if (status.trusted) {
    const firstCorner = next("posted", (message) => message.kind === "move");
    sendInput(generation, [{ t: "move", x: 0, y: 0, i: 9 }]);
    const point = await firstCorner;
    assert.equal(point.x, applied.controlBounds.x);
    assert.equal(point.y, applied.controlBounds.y);
  }
  const target = displays.at(-1);
  applied = await configure(false, { screen: target.screen, width: 1280 });
  await decoded(applied);
  if (status.trusted) {
    const posted = next("posted", (message) => message.kind === "move");
    sendInput(generation, [{ t: "move", x: 1, y: 1, i: 10 }]);
    const point = await posted;
    assert.equal(point.x, applied.controlBounds.x + applied.controlBounds.width - 1, "Input must use the newly selected display's bounds");
    assert.equal(point.y, applied.controlBounds.y + applied.controlBounds.height - 1);
    const held = next("posted", (message) => message.kind === "down");
    sendInput(generation, [{ t: "down", b: "left", m: ["shift"], i: 11 }]);
    await held;
  }

  const staleGeneration = generation;
  const releaseStart = messages.length;
  await configure(true);
  if (status.trusted) assert.ok(messages.slice(releaseStart).some((message) => message.t === "posted" && message.kind === "up"), "Pause releases a held drag");
  await sleep(1500); // Drain pictures already encoded before the pause acknowledgment.
  const paused = await next("rtc.loopback");
  const stillPaused = await next("rtc.loopback");
  assert.equal(stillPaused.framesDecoded, paused.framesDecoded, "Capture/repeat must stop while paused");
  const inputStart = messages.length;
  sendInput(generation, [{ t: "move", x: 0, y: 0, i: 12 }]);
  await sleep(250);
  assert.equal(messages.slice(inputStart).filter((message) => message.t === "posted").length, 0, "Paused input must be rejected");

  const resumedAt = performance.now();
  applied = await configure(false, { screen: displays[0].screen, width: 1920 });
  await decoded(applied);
  const resumeObservedMs = Math.round(performance.now() - resumedAt);
  const oldInputStart = messages.length;
  sendInput(staleGeneration, [{ t: "move", x: 0, y: 0, i: 13 }]);
  await sleep(250);
  assert.equal(messages.slice(oldInputStart).filter((message) => message.t === "posted").length, 0, "Old-display input must be rejected after resume");

  // An invalid configuration must leave the healthy peer connection usable.
  const invalidId = ++requestId;
  const refused = next("rtc.configure.error", (message) => message.requestId === invalidId);
  app.send({ t: "rtc.configure", v: "reuse", requestId: invalidId, screen: 1_000_000, maxWidth: 1920, paused: false });
  await refused;
  await decoded(applied);

  // Configure during a pending start/stop and coalesce to the last requested target.
  const finalId = requestId + 3;
  const finalAck = next("rtc.configured", (message) => message.requestId === finalId);
  for (const maxWidth of [1280, 2560, 1920]) {
    app.send({ t: "rtc.configure", v: "reuse", requestId: ++requestId, screen, maxWidth, maxFps: 120, paused: false, inputGeneration: ++generation });
  }
  const final = await finalAck;
  await decoded(final);
  // A pause received while a replacement is starting must cancel that start as well.
  const pausedId = requestId + 2;
  const pausedAck = next("rtc.configured", (message) => message.requestId === pausedId);
  for (const paused of [false, true]) {
    app.send({ t: "rtc.configure", v: "reuse", requestId: ++requestId, screen, maxWidth: 1280, maxFps: 120, paused, inputGeneration: ++generation });
  }
  assert.equal((await pausedAck).paused, true);
  await sleep(1500);
  const afterCancelledStart = await next("rtc.loopback");
  assert.equal((await next("rtc.loopback")).framesDecoded, afterCancelledStart.framesDecoded, "An obsolete start cannot resume a paused session");
  await decoded(await configure(false, { width: 1920 }));
  assert.equal(messages.filter((message) => message.t === "rtc.offer").length, initialOfferCount, "Configuration/resume must not renegotiate");
  assert.equal(messages.filter((message) => message.t === "rtc.error").length, 0);
  console.log(JSON.stringify({ ok: true, displays: displays.length, offers: initialOfferCount, finalWidth: final.width, finalHeight: final.height,
    resumeObservedMs, inputChecked: status.trusted, boundary: "Mac loopback, not phone or WAN proof" }));
} finally {
  app.send({ t: "rtc.close", v: "reuse" });
  assert.equal(await app.close(), true, "The test helper must exit with its socket");
}
