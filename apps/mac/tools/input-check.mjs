#!/usr/bin/env node
// Checks LinkShell.app's hands without moving anything: with --dry-run the app says what it
// would post (`posted`) instead of posting it. The same events go in the two ways a viewer's
// can — down the host's socket (`open`, then events with `v`), and down a video session's data
// channels, sent by the viewer inside the app (`--loopback`) — and have to come out the same.
// The cases are those of packages/host/test/app.test.ts, and a few more.
//
//   node tools/input-check.mjs [--shapes]
//
// --shapes   also gives the pointer other pictures for a moment (tools/pointer-shapes.swift: no
//            event is posted, the arrow is put back), to see the `shape` channel follow.
//
// Exits 1 when a check fails.

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { APP, launch } from "./app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(APP, "Contents/MacOS/LinkShell");
const CMD = 0x100000;
const SHIFT = 0x20000;
const ALT = 0x80000;
const CTRL = 0x40000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rows = [];
const row = (path, name, ok, detail = "") => rows.push({ path, name, ok, detail: String(detail) });

async function until(done, what, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A part of the check: what goes wrong in it is one failed row, and the rest still runs. */
async function part(path, name, run) {
  try {
    await run();
  } catch (error) {
    row(path, name, false, error.message);
  }
}

// ── The events, and what they have to become ────────────────────────

// app.test.ts: "turns a viewer's events into the system's".
const BASIC = [
  { t: "move", x: 0, y: 0 },
  { t: "down", b: "left", n: 2, m: ["cmd", "shift"] },
  // With the button down a move is a drag.
  { t: "move", x: 1, y: 1 },
  { t: "up", b: "left", n: 2 },
  { t: "scroll", dx: 3, dy: -40 },
  { t: "key", k: "c", m: ["cmd"] },
  { t: "text", s: "你好 😀" },
  { t: "key", k: "escape" },
];
const BASIC_KINDS = ["move", "moddown", "moddown", "down", "drag", "up", "modup", "modup", "scroll", "moddown", "keydown", "keyup", "modup", "textdown", "textup", "keydown", "keyup"];

/** Not events: the host drops them before the socket; on a data channel the app has to. */
const NOT_EVENTS = [
  { t: "key", k: "c", m: ["hyper"] },
  "move",
  { t: "move", x: 1.2, y: 0 },
  { t: "move", x: true, y: 0 },
  { t: "down", b: "middle" },
  { t: "down", b: "left", n: 4 },
  { t: "down", b: "left", n: 1.5 },
  { t: "scroll", dx: 1 },
  { t: "key", k: "c", m: null },
  { t: "key", k: "" },
  { t: "key", k: "a-key-with-a-name-too-long" },
  { t: "text", s: "" },
  { t: "text", s: "x".repeat(4001) },
  { t: "exec", s: "rm -rf" },
  null,
  [{ t: "key", k: "a" }],
];

// 19 letters and then an emoji: its two halves are the 20th and 21st units, and must stay together.
const LONG = "abcdefghijklmnopqrs😀tuvwxyz，这是一段要分成好几块才能送完的中文：你好，世界！😀😀😀 the end";

const MORE = [
  { t: "down", b: "right", m: ["ctrl", "alt"] },
  // Already down: nothing.
  { t: "down", b: "right" },
  { t: "up", b: "right" },
  { t: "down", b: "left", n: 3 },
  { t: "up", b: "left", n: 3 },
  { t: "scroll", dx: 5000, dy: -5000, m: ["shift"] },
  { t: "key", k: "left", m: ["cmd", "shift"] },
  { t: "key", k: "f5" },
  // No such key: nothing.
  { t: "key", k: "nosuchkey" },
  { t: "text", s: LONG },
  { t: "key", k: "return" },
];

/** The pieces `text` is typed in: 20 UTF-16 units at most, never between the halves of a pair. */
function chunks(text) {
  const pieces = [];
  for (let index = 0; index < text.length; ) {
    let end = Math.min(index + 20, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(index, end));
    index = end;
  }
  return pieces;
}

function judgeBasic(path, posted, bounds) {
  const kinds = posted.map((event) => event.kind);
  row(path, "move, double click with ⌘⇧, drag, scroll, ⌘C, text, escape: in a hand's order", same(kinds, BASIC_KINDS), kinds.join(" "));
  const plain = posted.filter((event) => !event.kind.startsWith("mod"));
  const [origin, down, drag, up, scroll, shortcut, , text] = plain;
  row(path, "move to 0,0 is the display's top left", origin?.x === bounds.x && origin?.y === bounds.y, `${origin?.x},${origin?.y}`);
  row(path, "double click with ⌘ and ⇧ held", down?.n === 2 && down?.flags === (CMD | SHIFT) && up?.flags === (CMD | SHIFT), `n ${down?.n}, flags 0x${down?.flags?.toString(16)}`);
  const modifiers = posted.filter((event) => event.kind.startsWith("mod")).slice(0, 4).map((event) => `${event.kind} ${event.k}`);
  row(path, "modifiers are keys: down before the button, up after it, last down first up", same(modifiers, ["moddown shift", "moddown cmd", "modup cmd", "modup shift"]), modifiers.join(", "));
  row(path, "with the button down a move is a drag, to the far corner", drag?.kind === "drag" && drag?.x === bounds.x + bounds.w - 1 && drag?.y === bounds.y + bounds.h - 1, `${drag?.x},${drag?.y}`);
  row(path, "scroll", scroll?.dx === 3 && scroll?.dy === -40, `${scroll?.dx},${scroll?.dy}`);
  row(path, "⌘C: the key C is on this Mac's layout, with ⌘", shortcut?.code === 8 && shortcut?.flags === CMD, `code ${shortcut?.code}, flags 0x${shortcut?.flags?.toString(16)}`);
  row(path, "text arrives as written (Chinese, emoji)", text?.s === "你好 😀", text?.s);
}

function judgeMore(path, posted) {
  const kinds = posted.map((event) => event.kind);
  const pieces = chunks(LONG);
  const expected = [
    "moddown", "moddown", "down", "up", "modup", "modup",
    "down", "up",
    "scroll",
    "moddown", "moddown", "keydown", "keyup", "modup", "modup",
    "keydown", "keyup",
    ...pieces.flatMap(() => ["textdown", "textup"]),
    "keydown", "keyup",
  ];
  row(path, "right click with ⌃⌥, triple click, clamped scroll, ⇧⌘←, F5, long text: in order", same(kinds, expected), same(kinds, expected) ? `${kinds.length} events` : kinds.join(" "));
  const plain = posted.filter((event) => !event.kind.startsWith("mod"));
  const [right, rightUp, triple, , scroll, arrow, , f5] = plain;
  row(path, "right button with ⌃ and ⌥, pressed once though asked twice", right?.b === "right" && right?.n === 1 && right?.flags === (CTRL | ALT) && rightUp?.kind === "up" && rightUp?.b === "right", `b ${right?.b}, n ${right?.n}, flags 0x${right?.flags?.toString(16)}`);
  row(path, "triple click", triple?.b === "left" && triple?.n === 3 && triple?.flags === 0, `n ${triple?.n}`);
  row(path, "scroll is held to ±2000", scroll?.dx === 2000 && scroll?.dy === -2000, `${scroll?.dx},${scroll?.dy}`);
  row(path, "⇧⌘← and F5: keys that are where they are on every layout", arrow?.code === 123 && arrow?.flags === (CMD | SHIFT) && f5?.code === 96 && f5?.flags === 0, `codes ${arrow?.code}, ${f5?.code}`);
  const typed = posted.filter((event) => event.kind === "textdown").map((event) => event.s);
  const let_go = posted.filter((event) => event.kind === "textup").map((event) => event.s);
  row(path, `long text in pieces of at most 20 units, no emoji cut in half (${pieces.length} pieces)`, same(typed, pieces) && same(let_go, pieces) && typed.join("") === LONG, typed.map((piece) => piece.length).join("+"));
}

// ── The app as a program: --status, and one viewer on stdin ─────────

await part("program", "--status", async () => {
  const status = JSON.parse(execFileSync(PROGRAM, ["--status"], { encoding: "utf8" }));
  console.log(`--status, run directly:        ${JSON.stringify(status)}`);
  row("program", "--status answers, and says it can send video", status.t === "status" && status.video === true && typeof status.trusted === "boolean" && typeof status.recording === "boolean", `app ${status.app}`);
});

await part("stdin", "one viewer on stdin", async () => {
  const child = spawn(PROGRAM, ["0", "--dry-run"], { stdio: ["pipe", "pipe", "ignore"] });
  const said = [];
  let code;
  child.on("exit", (status) => (code = status));
  createInterface({ input: child.stdout }).on("line", (line) => said.push(JSON.parse(line)));
  await until(() => said.length > 0, "ready");
  row("stdin", "says ready, trusted in a dry run", said[0].t === "ready" && said[0].trusted === true && said[0].w > 0 && said[0].v === undefined, JSON.stringify(said[0]));
  const posted = () => said.filter((message) => message.t === "posted");
  for (const event of BASIC) child.stdin.write(`${JSON.stringify(event)}\n`);
  await until(() => posted().some((event) => event.kind === "keyup" && event.k === "escape"), "the events");
  judgeBasic("stdin", posted(), { x: 0, y: 0, w: said[0].w, h: said[0].h });
  const before = posted().length;
  child.stdin.write(`${JSON.stringify({ t: "down", b: "left" })}\n`);
  await until(() => posted().length === before + 1, "the press");
  child.stdin.end();
  await until(() => code !== undefined, "the program to end");
  row("stdin", "lets go of a held button and ends when stdin closes", posted().at(-1)?.kind === "up" && posted().at(-1)?.b === "left" && code === 0, `exit ${code}`);
});

// ── The host's socket ───────────────────────────────────────────────

/** What the app would have posted for each viewer, and what else it said to one. */
function listen(app) {
  const posted = new Map();
  const others = [];
  app.on("posted", (message) => posted.set(message.v, [...(posted.get(message.v) ?? []), message]));
  app.on("*", (message) => message.t !== "posted" && others.push(message));
  return { of: (viewer) => posted.get(viewer) ?? [], others };
}

/** Each display's place among the displays, in points, as the socket's viewers find it. */
const places = [];
let displays = [];
/** The display the pointer is on now (the app says where it is to the viewers of that display). */
let pointerScreen;

await part("socket", "the app on the host's socket", async () => {
  const app = await launch(["--dry-run"]);
  try {
    const heard = listen(app);
    const status = await app.next("status", 5000);
    console.log(`status, opened by the system:  ${JSON.stringify(status)}`);
    row("socket", "first message is status, under the app's own name", status.app === "LinkShell" && status.video === true && status.w > 0 && status.h > 0, `app ${status.app}, recording ${status.recording}, trusted ${status.trusted} (a dry run always is)`);
    app.send({ t: "status" });
    const again = await app.next("status", 5000);
    row("socket", "asked for status, it says it again", again.app === status.app, "");

    app.send({ t: "displays" });
    displays = (await app.next("displays", 5000)).list;
    console.log(`displays:                      ${JSON.stringify(displays)}`);
    row("socket", "displays: screen 0 is the main one, every one named and sized", displays.length > 0 && displays[0].main === true && displays.every((display, index) => display.screen === index && display.name && display.w > 0 && display.h > 0 && display.scale > 0), displays.map((display) => `${display.screen}: ${display.name} ${display.w}×${display.h} @${display.scale}`).join("; "));

    // Every display: `open` finds the one `displays` lists under that number.
    for (const display of displays) {
      const viewer = `place-${display.screen}`;
      app.send({ t: "open", v: viewer, screen: display.screen });
      await until(() => heard.others.some((message) => message.t === "ready" && message.v === viewer), `ready for screen ${display.screen}`);
      const ready = heard.others.find((message) => message.t === "ready" && message.v === viewer);
      app.send({ t: "move", v: viewer, x: 0, y: 0 });
      app.send({ t: "move", v: viewer, x: 1, y: 1 });
      await until(() => heard.of(viewer).length === 2, `the corners of screen ${display.screen}`);
      const [topLeft, bottomRight] = heard.of(viewer);
      const place = { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x + 1, h: bottomRight.y - topLeft.y + 1 };
      places[display.screen] = place;
      const fits = place.w === ready.w && place.h === ready.h && Math.abs(place.w * display.scale - display.w) < 1 && Math.abs(place.h * display.scale - display.h) < 1;
      row("socket", `open screen ${display.screen}: its corners are those of “${display.name}”`, ready.trusted === true && ready.app === "LinkShell" && fits && (!display.main || (place.x === 0 && place.y === 0)), `at ${place.x},${place.y}, ${place.w}×${place.h} points`);
    }
    // The pointer hasn't been moved by anyone here: each viewer of the display it is on is told where it is.
    await sleep(700);
    const cursors = heard.others.filter((message) => message.t === "cursor");
    pointerScreen = cursors.length ? Number(cursors[0].v.split("-")[1]) : undefined;
    row("socket", "cursor: the pointer's place, to the viewer of the display it is on", cursors.length >= 1 && cursors.every((cursor) => cursor.v === cursors[0].v && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1), cursors.map((cursor) => `${cursor.v}: ${cursor.x.toFixed(4)},${cursor.y.toFixed(4)}`).join("; ") || "none");
    for (const display of displays) app.send({ t: "close", v: `place-${display.screen}` });

    app.send({ t: "open", v: "basic", screen: 0 });
    for (const event of BASIC) app.send({ ...event, v: "basic" });
    await until(() => heard.of("basic").some((event) => event.kind === "keyup" && event.k === "escape"), "the events");
    judgeBasic("socket", heard.of("basic"), places[0]);
    app.send({ t: "close", v: "basic" });

    app.send({ t: "open", v: "more", screen: 0 });
    for (const event of MORE) app.send({ ...event, v: "more" });
    await until(() => heard.of("more").some((event) => event.kind === "keyup" && event.k === "return"), "the events");
    judgeMore("socket", heard.of("more"));
    app.send({ t: "close", v: "more" });

    // Both buttons down, each with modifiers: a key both hold is pressed once, and let go with the last.
    app.send({ t: "open", v: "both", screen: 0 });
    for (const event of [{ t: "down", b: "left", m: ["shift"] }, { t: "down", b: "right", m: ["shift", "cmd"] }, { t: "up", b: "left" }, { t: "up", b: "right" }]) app.send({ ...event, v: "both" });
    await until(() => heard.of("both").filter((event) => event.kind === "modup").length === 2, "both buttons let go");
    const both = heard.of("both").map((event) => `${event.kind} ${event.b ?? event.k}`);
    row("socket", "both buttons with modifiers: a key both hold goes down once, and up with the last button", same(both, ["moddown shift", "down left", "moddown cmd", "down right", "up left", "up right", "modup cmd", "modup shift"]) && heard.of("both")[4].flags === (CMD | SHIFT), both.join(", "));
    app.send({ t: "close", v: "both" });

    // app.test.ts: "holds the permissions under its own name, and serves several viewers at once".
    app.send({ t: "open", v: "a", screen: 0 });
    app.send({ t: "open", v: "b", screen: 0 });
    app.send({ t: "move", v: "a", x: 0, y: 0 });
    app.send({ t: "down", v: "a", b: "left" });
    app.send({ t: "key", v: "b", k: "escape" });
    await until(() => heard.of("a").length === 2 && heard.of("b").length === 2, "two viewers' events");
    row("socket", "two viewers at once, each its own events", same(heard.of("a").map((event) => event.kind), ["move", "down"]) && same(heard.of("b").map((event) => event.kind), ["keydown", "keyup"]), "");
    // app.test.ts: "lets go of a held button when the viewer leaves".
    app.send({ t: "close", v: "a" });
    await until(() => heard.of("a").length === 3, "the button let go");
    await sleep(100);
    row("socket", "a viewer that leaves lets go of its button; the other is untouched", heard.of("a")[2].kind === "up" && heard.of("a")[2].b === "left" && heard.of("b").length === 2, "");
    app.send({ t: "close", v: "b" });
  } finally {
    const went = await app.close();
    row("socket", "the app ends when the socket closes", went, "");
  }
});

// ── A video session's data channels ─────────────────────────────────

await part("channels", "the app's data channels", async () => {
  const app = await launch(["--dry-run", "--loopback"]);
  try {
    const heard = listen(app);
    const status = await app.next("status", 5000);
    // Asking to capture without the permission would have the system ask whoever is at the Mac.
    if (!status.recording) throw new Error("recording is false: Screen Recording is not allowed for this LinkShell.app — not asking");
    const errors = () => heard.others.filter((message) => message.t === "rtc.error");
    const logs = () => heard.others.filter((message) => message.t === "log").map((message) => message.message);

    const open = async (viewer, screen) => {
      app.send({ t: "rtc.open", v: viewer, screen, iceServers: [{ urls: ["stun:127.0.0.1:3478"] }], fps: 30 });
      const ready = () => ["input", "pointer", "cursor", "shape"].every((channel) => heard.others.some((message) => message.t === "rtc.loopback.channel" && message.v === viewer && message.channel === channel));
      await until(() => ready() || heard.others.some((message) => message.t === "rtc.error" && message.v === viewer), `the channels of ${viewer}`, 20_000);
      const failed = heard.others.find((message) => message.t === "rtc.error" && message.v === viewer);
      if (failed) throw new Error(failed.message);
    };
    const send = (viewer, channel, events) => app.send({ t: "rtc.loopback.send", v: viewer, channel, events });
    const from = (viewer, channel) => heard.others.filter((message) => message.t === "rtc.loopback.heard" && message.v === viewer && message.channel === channel);

    // Every display: the picture and the hands are on the one `displays` lists under that number.
    for (const display of displays) {
      const viewer = `video-place-${display.screen}`;
      await open(viewer, display.screen);
      await until(() => logs().some((line) => line.startsWith("capturing display ")), "the capture to start", 15_000);
      const capturing = logs().filter((line) => line.startsWith("capturing display ")).at(-1);
      send(viewer, "input", [{ t: "move", x: 0, y: 0 }, { t: "move", x: 1, y: 1 }]);
      await until(() => heard.of(viewer).length === 2, `the corners of screen ${display.screen}`);
      const [topLeft, bottomRight] = heard.of(viewer);
      const place = places[display.screen];
      const sameCorners = place && topLeft.x === place.x && topLeft.y === place.y && bottomRight.x === place.x + place.w - 1 && bottomRight.y === place.y + place.h - 1;
      row("channels", `rtc.open screen ${display.screen}: captures “${display.name}”, and its events land where the socket's do`, capturing.startsWith(`capturing display ${display.id} (${display.w}×${display.h})`) && sameCorners, `${capturing}; corners ${topLeft.x},${topLeft.y} – ${bottomRight.x},${bottomRight.y}`);
      heard.others.splice(0, heard.others.length, ...heard.others.filter((message) => message.t !== "log"));
    }

    // The rest on the display the pointer is on, so that there is a place to be told.
    const screen = pointerScreen ?? 0;
    const viewer = "video-basic";
    await open(viewer, screen);
    row("channels", "each rtc.open takes the screen from the one before, with input, pointer, cursor and shape channels", errors().length === 0, errors().map((error) => error.message).join("; "));

    // The same events as down the socket, with what is not an event among them.
    send(viewer, "input", [...BASIC.slice(0, -1), ...NOT_EVENTS, BASIC.at(-1)]);
    await until(() => heard.of(viewer).some((event) => event.kind === "keyup" && event.k === "escape"), "the events");
    judgeBasic("channels", heard.of(viewer), places[screen]);
    row("channels", `${NOT_EVENTS.length} messages that are not events are dropped`, same(heard.of(viewer).map((event) => event.kind), BASIC_KINDS), "");
    row("channels", "posted is said on the socket, with the video session's id", heard.of(viewer).every((event) => event.t === "posted" && event.v === viewer), "");

    const before = heard.of(viewer).length;
    send(viewer, "input", MORE);
    await until(() => heard.of(viewer).some((event) => event.kind === "keyup" && event.k === "return"), "the events");
    judgeMore("channels", heard.of(viewer).slice(before));

    // The lossy channel carries the same events.
    let count = heard.of(viewer).length;
    send(viewer, "pointer", [{ t: "move", x: 0.5, y: 0.5 }, { t: "scroll", dx: 0, dy: -12 }]);
    await until(() => heard.of(viewer).length === count + 2, "events from the pointer channel");
    row("channels", "pointer: move and scroll arrive there too", same(heard.of(viewer).slice(count).map((event) => event.kind), ["move", "scroll"]), "");

    // Numbered events: a move from `pointer` that is older than what was already done is dropped.
    count = heard.of(viewer).length;
    const place = places[screen];
    const at = (fraction) => place.x + fraction * (place.w - 1);
    send(viewer, "input", [{ t: "move", x: 0.25, y: 0.25, i: 10 }, { t: "down", b: "left", i: 11 }]);
    await until(() => heard.of(viewer).length === count + 2, "the press");
    send(viewer, "pointer", [{ t: "move", x: 0.1, y: 0.1, i: 9 }]);
    await sleep(300);
    send(viewer, "pointer", [{ t: "move", x: 0.5, y: 0.5, i: 12 }]);
    await until(() => heard.of(viewer).length === count + 3, "the drag");
    send(viewer, "pointer", [{ t: "move", x: 0.4, y: 0.4, i: 11 }]);
    await sleep(300);
    send(viewer, "input", [{ t: "move", x: 0.75, y: 0.75, i: 13 }, { t: "up", b: "left", i: 14 }]);
    await until(() => heard.of(viewer).length === count + 5, "the release");
    send(viewer, "pointer", [{ t: "move", x: 0.9, y: 0.9, i: 12 }]);
    await sleep(300);
    // Not numbered: done, as every event of a viewer that doesn't number them is.
    send(viewer, "pointer", [{ t: "move", x: 1, y: 1 }]);
    await until(() => heard.of(viewer).length === count + 6, "the last move");
    const numbered = heard.of(viewer).slice(count);
    const story = numbered.map((event) => `${event.kind}${event.kind === "move" || event.kind === "drag" ? ` ${((event.x - place.x) / (place.w - 1)).toFixed(2)}` : ""}`);
    row(
      "channels",
      "a late move (older than the press, the newest move, or the release) is dropped: the drag is the finger's",
      same(story, ["move 0.25", "down", "drag 0.50", "drag 0.75", "up", "move 1.00"]) && numbered[1].x === at(0.25) && numbered[4].x === at(0.75),
      story.join(", "),
    );

    // The pointer, to a viewer that draws it itself.
    const cursors = from(viewer, "cursor").map((message) => message.message);
    row("channels", "cursor: the pointer's place when the channel opens, numbered", cursors.length >= 1 && cursors.every((cursor) => cursor.t === "cursor" && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1 && Number.isInteger(cursor.i)), `${cursors.length} message${cursors.length === 1 ? "" : "s"}${cursors[0] ? `, first ${JSON.stringify(cursors[0])}` : pointerScreen === undefined ? " (the pointer is on no display the socket's viewers were told of)" : ""}`);
    await until(() => from(viewer, "shape").length > 0, "the pointer's picture", 3000);
    const shapes = () => from(viewer, "shape");
    const first = shapes()[0].message;
    const png = Buffer.from(first.png ?? "", "base64");
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    row(
      "channels",
      "shape: the pointer's picture when the channel opens",
      first.t === "shape" && typeof first.id === "string" && isPng && png.readUInt32BE(16) === Math.round(first.w * first.scale) && png.readUInt32BE(20) === Math.round(first.h * first.scale) && first.hotX >= 0 && first.hotX <= first.w && first.hotY >= 0 && first.hotY <= first.h && first.displayW === place.w && first.displayH === place.h,
      `id ${first.id}, ${first.w}×${first.h} points, hot spot ${first.hotX},${first.hotY}, PNG ${png.readUInt32BE(16)}×${png.readUInt32BE(20)} ${png.length} bytes, message ${shapes()[0].bytes} bytes`,
    );

    if (process.argv.includes("--shapes")) {
      const tool = join(here, "../build/pointer-shapes");
      execFileSync("/usr/bin/swiftc", ["-O", join(here, "pointer-shapes.swift"), "-o", tool], { stdio: ["ignore", "ignore", "pipe"] });
      const shown = execFileSync(tool, ["0.7"], { encoding: "utf8" }).trim().split("\n");
      await sleep(500);
      const all = shapes().map((entry) => entry.message);
      const pictures = all.filter((shape) => shape.png);
      const ids = all.map((shape) => shape.id);
      const repeats = all.filter((shape, index) => ids.indexOf(shape.id) < index);
      console.log(`shapes while the pointer was ${shown.join(", ")}: ${shapes().map((entry) => `${entry.message.id}${entry.message.png ? ` (${entry.message.w}×${entry.message.h}, hot ${entry.message.hotX},${entry.message.hotY}, ${entry.bytes} bytes)` : ` (id only, ${entry.bytes} bytes)`}`).join(" → ")}`);
      row(
        "channels",
        "shape: follows the pointer's picture; each picture is sent once, then named by its id",
        new Set(pictures.map((shape) => shape.id)).size === pictures.length && pictures.length >= 3 && repeats.length >= 1 && repeats.every((shape) => !shape.png) && all.every((shape, index) => index === 0 || shape.id !== all[index - 1].id),
        `${all.length} messages: ${pictures.length} pictures, ${repeats.length} by id alone`,
      );
    }

    // app.test.ts: "lets go of a held button when the viewer leaves".
    count = heard.of(viewer).length;
    send(viewer, "input", [{ t: "down", b: "left", m: ["shift"] }]);
    await until(() => heard.of(viewer).length === count + 2, "the press");
    app.send({ t: "rtc.close", v: viewer });
    await until(() => heard.of(viewer).length === count + 4, "the button let go");
    row("channels", "rtc.close lets go of a held button and its modifier", same(heard.of(viewer).slice(count + 2).map((event) => `${event.kind} ${event.b ?? event.k}`), ["up left", "modup shift"]), "");
  } finally {
    const went = await app.close();
    row("channels", "the app ends when the socket closes", went, "");
  }
});

// ── The table ───────────────────────────────────────────────────────

const width = Math.max(...rows.map((entry) => entry.name.length));
console.log("");
for (const entry of rows) console.log(`${entry.ok ? "pass" : "FAIL"}  ${entry.path.padEnd(8)}  ${entry.name.padEnd(width)}  ${entry.detail}`);
const failed = rows.filter((entry) => !entry.ok).length;
console.log(`\n${rows.length - failed} of ${rows.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
