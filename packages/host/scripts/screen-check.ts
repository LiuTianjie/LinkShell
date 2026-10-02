// The screen viewer page, tried for real with nobody at the keyboard: the real page from the real
// `ScreenShare`, talking to the real LinkShell.app, in a headless Chrome or in the booted iOS
// Simulator's Safari. Nothing is posted to this computer: the run is always a dry run, and what
// would have been posted is logged instead.
//
//   pnpm tsx scripts/screen-check.ts [--viewer chrome|simulator] [--plan none|watch|hands|cursor]
//       [--query "measure=1&video=0"] [--seconds 20] [--size 1280x720] [--shot <file.png>] [--display <index>] [--verbose]
//
// Plans (what a script put into the page does there; `none` opens the page as it is served):
//   watch    says once a second what the page shows
//   hands    every gesture, in 触控板 and 点按 and with a mouse: what the page sent, on which channel,
//            and what the app would have posted for it
//   cursor   the pointer drawn over a video: what the app says of it, then positions fed to the page
//
// With a plan the page is served through a small proxy here, which adds the script; the socket
// goes through it too. `--query` is added to the page's address (`measure=1`, `video=0`,
// `failAfter=5`, `mode=trackpad`, `wait=9`: seconds before a plan's gestures begin), and with a
// plan these too, which stand in for what can't be had on one quiet computer:
//   as=app | as=app-video   the page finds itself inside the LinkShell app, which plays video in place or doesn't say
//   block=1                 the browser refuses to start the video until someone taps
//   mute=answer             the page's answer never reaches the app (no connection within 8 s)
//   lose=disconnected|failed   (watch) after 3 s the connection says it is gone
//   menu=1                  (watch) the menu is opened, to see its last line
//   legacy=fake             the socket's picture is a test pattern made here (ffmpeg), not the screen: for when the
//                           host's own can't be had. It has a clock strip that stands still at the time it began,
//                           so the page reads a latency that grows by a second a second.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";

// Whatever the environment says: nothing here may move the pointer or press a key on this computer.
process.env.LINKSHELL_INPUT_DRY_RUN = "1";
process.env.LINKSHELL_SCREEN_CLOCK ??= "1";
const { ScreenShare, AccessUnitSplitter } = await import("../src/screen.js");
const { inputApp } = await import("../src/input.js");

const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const { values: options } = parseArgs({
  options: {
    viewer: { type: "string", default: "chrome" },
    plan: { type: "string", default: "none" },
    query: { type: "string", default: "" },
    seconds: { type: "string", default: "20" },
    size: { type: "string", default: "1280x720" },
    shot: { type: "string" },
    verbose: { type: "boolean", default: false },
    display: { type: "string" },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
});
const seconds = Number(options.seconds);

// ── The host's side ─────────────────────────────────────────────────

interface Entry {
  at: number;
  line: string;
}
const lines: Entry[] = [];
const log = (message: string) => {
  lines.push({ at: Date.now(), line: message });
  // What was measured, and what would have been posted, are summed up further on.
  if (options.verbose || !/^\[screen\] (measured:|dry run)/.test(message)) console.log(`${new Date().toISOString().slice(11, 23)} ${message}`);
};

const screen = new ScreenShare(log, () => []);
const { port, token, displays } = await screen.start();
const display = options.display ?? String(displays[0]!.index);
log(`displays: ${displays.map((entry) => `${entry.index} ${entry.name}`).join(", ")}; watching ${display}`);

const app = inputApp(log);
if (app) {
  await app.access();
  // The app this process opened, and that it was told to post nothing.
  const mine = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`linkshell-input-${process.pid}-`) && line.includes("/Contents/MacOS/LinkShell"));
  if (mine.length !== 1 || !mine[0]!.includes("--dry-run")) {
    console.error(`not a dry run (${mine.join(" | ") || "the app was not found"}): stopping`);
    screen.stop();
    process.exit(2);
  }
  // What a viewer's hands would have done, when they reach the app on its own channels: the host
  // hears it under the video's name, which it does not log.
  const offer = app.offerVideo.bind(app);
  app.offerVideo = (id, request, route) =>
    offer(id, request, (message) => {
      if (message.t === "posted") log(`[screen] dry run (video): ${JSON.stringify(message)}`);
      route(message);
    });
}

// ── The script put into the page ────────────────────────────────────

/** Before the page's own script: keeps what the page sends, by the way it went, and the channels it is given. */
const HOOKS = String.raw`
window.__sent = [];
window.__heard = { frames: 0, said: [], times: {} };
window.__at = (what) => { if (!(what in __heard.times)) __heard.times[what] = Math.round(performance.now()); };
window.__channels = {};
(() => {
  const query = new URLSearchParams(location.search);
  if ((query.get("as") || "").startsWith("app")) {
    window.ReactNativeWebView = { postMessage: (message) => __heard.said.push("to the app: " + message) };
    if (query.get("as") === "app-video") window.__linkshellChrome = { video: true };
  }
  if (query.get("block")) {
    const play = HTMLMediaElement.prototype.play;
    let refused = false;
    HTMLMediaElement.prototype.play = function () {
      if (refused) return play.call(this);
      refused = true;
      return Promise.reject(new DOMException("play() needs someone to ask for it", "NotAllowedError"));
    };
  }
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string") {
      const message = JSON.parse(data);
      if (message.t === "rtc.answer" && query.get("mute") === "answer") return;
      if (message.t.startsWith("rtc.")) __at("sent " + message.t);
      if (!["ack", "measure", "ping", "rtc.ice"].includes(message.t)) __sent.push(Object.assign({ lane: "socket" }, message.t === "rtc.answer" ? { t: message.t } : message));
    }
    return socketSend.call(this, data);
  };
  const Socket = window.WebSocket;
  window.WebSocket = function (url) {
    const socket = new Socket(url);
    __heard.said.push("socket " + url.replace(/token=[^&]*/, "token=…"));
    socket.addEventListener("open", () => __at("socket open"));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return void (__at("first frame down the socket"), (__heard.frames += 1));
      const message = JSON.parse(event.data);
      if (message.rtc) __at("heard rtc." + message.rtc.t);
      if (message.rtc && message.rtc.t !== "ice") __heard.said.push("rtc." + message.rtc.t + (__heard.frames ? " (after " + __heard.frames + " frames)" : ""));
      else if (!message.rtc && !message.pong) __heard.said.push(event.data.slice(0, 160));
    });
    return socket;
  };
  if (!window.RTCPeerConnection) return;
  const channelSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    __sent.push(Object.assign({ lane: this.label }, JSON.parse(data)));
    return channelSend.call(this, data);
  };
  const Connection = window.RTCPeerConnection;
  window.RTCPeerConnection = function (configuration) {
    const connection = (window.__pc = new Connection(configuration));
    connection.addEventListener("iceconnectionstatechange", () => __at("ice " + connection.iceConnectionState));
    connection.addEventListener("connectionstatechange", () => __at("connection " + connection.connectionState));
    connection.addEventListener("track", () => __at("track"));
    connection.addEventListener("datachannel", (event) => {
      __channels[event.channel.label] = event.channel;
      event.channel.addEventListener("open", () => __at("channel " + event.channel.label + " open"));
      event.channel.addEventListener("message", (said) => {
        const message = JSON.parse(said.data);
        const about = message.t === "shape" ? Object.assign({}, message, { png: message.png ? message.png.length + " characters" : undefined }) : message;
        (__heard[event.channel.label] = __heard[event.channel.label] || []).push(about);
      });
    });
    return connection;
  };
  window.RTCPeerConnection.prototype = Connection.prototype;
})();
`;

/** After it: carries out the plan named in the address, and says what happened. */
const DRIVER = String.raw`
(async () => {
  const query = new URLSearchParams(location.search), plan = query.get("plan");
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const say = (kind, data) => fetch("/report", { method: "POST", body: JSON.stringify(Object.assign({ kind }, data)) }).catch(() => {});
  const stage = $("stage"), video = $("video"), canvas = $("screen"), pointer = $("pointer");
  const box = (element) => { const r = element.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const live = () => !video.classList.contains("gone");
  const state = () => ({
    picture: live() ? "video" : canvas.classList.contains("gone") ? "none" : "canvas",
    size: live() ? [video.videoWidth, video.videoHeight] : [canvas.width, canvas.height],
    box: box(live() ? video : canvas),
    note: $("note").classList.contains("gone") ? "" : $("note").textContent,
    toast: $("toast").classList.contains("on") ? $("toast").textContent : "",
    status: $("status").textContent,
    pointer: { classes: pointer.className, box: box(pointer), transform: pointer.style.transform, origin: pointer.style.transformOrigin, image: pointer.style.backgroundImage.slice(0, 32) },
    stage: stage.className,
    bar: [...$("bar").children].filter((tool) => !tool.classList.contains("gone")).map((tool) => tool.id + (tool.classList.contains("on") ? "*" : "")).join(" "),
    rtc: window.__pc ? { ice: __pc.iceConnectionState, channels: Object.fromEntries(Object.entries(__channels).map(([label, channel]) => [label, channel.readyState])) } : null,
    heard: { frames: __heard.frames, said: __heard.said, cursor: (__heard.cursor || []).length, shape: __heard.shape || [] },
  });
  const until = async (done, ms) => { for (const end = performance.now() + ms; performance.now() < end; await sleep(50)) if (done()) return true; return false; };
  const pictured = () => (live() ? video.videoWidth > 0 : canvas.width !== 300);
  video.addEventListener("resize", () => __at("video sized"));
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => __at("video frame shown"));

  let finger = 100;
  const fire = (type, id, x, y, kind, more) => stage.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: id, pointerType: kind || "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }, more)));
  /** Where a fraction of the picture is on the page. */
  const at = (u, v) => { const [x, y, w, h] = box(live() ? video : canvas); return { x: x + u * w, y: y + v * h }; };
  async function drag(id, from, to, ms, kind) {
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      fire("pointermove", id, from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, kind);
      await sleep(16);
    }
  }
  async function swipe(from, to, ms) {
    const id = ++finger;
    fire("pointerdown", id, from.x, from.y);
    await drag(id, from, to, ms || 300);
    fire("pointerup", id, to.x, to.y);
  }
  async function tap(point, heldFor) {
    const id = ++finger;
    fire("pointerdown", id, point.x, point.y);
    await sleep(heldFor || 40);
    fire("pointerup", id, point.x, point.y);
  }
  async function two(point, dx, dy, spread) {
    const a = ++finger, b = ++finger;
    fire("pointerdown", a, point.x - 30, point.y);
    fire("pointerdown", b, point.x + 30, point.y);
    await sleep(40);
    if (dx || dy || spread) {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const wide = 30 + ((spread || 0) * i) / steps;
        fire("pointermove", a, point.x - wide + (dx * i) / steps, point.y + (dy * i) / steps);
        fire("pointermove", b, point.x + wide + (dx * i) / steps, point.y + (dy * i) / steps);
        await sleep(16);
      }
    }
    fire("pointerup", a, point.x + dx, point.y + dy);
    fire("pointerup", b, point.x + dx, point.y + dy);
  }
  async function tapAndDrag(from, to) {
    await tap(from);
    await sleep(120);
    await swipe(from, to, 300);
  }
  /** A control of the toolbar, the menu or the key bar. */
  async function press(element) {
    const [x, y, w, h] = box(element);
    const where = { pointerId: ++finger, pointerType: "touch", clientX: x + w / 2, clientY: y + h / 2, bubbles: true, cancelable: true };
    element.dispatchEvent(new PointerEvent("pointerdown", where));
    await sleep(30);
    element.dispatchEvent(new PointerEvent("pointerup", where));
  }
  async function setMode(mode) {
    await press($("mode"));
    await sleep(1800);
    const menu = $("status").textContent;
    await press(document.querySelector('.choice[data-mode="' + mode + '"]'));
    return menu;
  }
  async function step(name, run) {
    __sent.length = 0;
    const result = await run();
    // A frame for the position to go, the pointer's rest, and the way to the computer and back into its log.
    await sleep(350);
    await say("step", { name, sent: __sent.splice(0), pointer: box(pointer).slice(0, 2), result });
  }

  await say("state", { when: "loaded", state: state() });
  if (!(await until(pictured, 30000))) return say("done", { failed: "no picture within 30 s", state: state() });
  await sleep(300);
  await say("state", { when: "first picture", ms: Math.round(performance.now()) - 300, times: __heard.times, state: state() });
  await sleep((Number(query.get("wait")) || 1) * 1000);

  if (plan === "watch") {
    if (query.get("menu")) await press($("mode"));
    for (let i = 0; i < (Number(query.get("seconds")) || 10); i++) {
      await sleep(1000);
      await say("state", { when: i + 1 + " s", state: state() });
      if ($("note").textContent.startsWith("轻点")) {
        dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
        await sleep(200);
        await say("state", { when: "after the tap it asked for", state: state() });
      }
      if (i === 2 && query.get("lose") && window.__pc) {
        for (const name of ["iceConnectionState", "connectionState"]) Object.defineProperty(__pc, name, { get: () => query.get("lose") });
        __pc.oniceconnectionstatechange();
        await say("state", { when: "the connection says it is " + query.get("lose"), state: state() });
      }
    }
  }

  if (plan === "hands") {
    await say("state", { when: "before the gestures", state: state() });
    const menu = await setMode("trackpad");
    const ready = await until(() => $("toast").textContent.startsWith("触控板"), 8000);
    await say("state", { when: "触控板 chosen", menu, controlling: ready, state: state() });
    if (!ready) return say("done", { failed: "not controlling: " + $("toast").textContent });
    await sleep(600);
    const mid = at(0.5, 0.5);
    await step("触控板: one finger slides", () => swipe(mid, { x: mid.x + 90, y: mid.y + 40 }, 320));
    await step("触控板: a tap", () => tap(mid));
    await step("触控板: a slide and a tap straight after it", async () => { await swipe(mid, { x: mid.x - 60, y: mid.y - 20 }, 200); await tap(mid); });
    await sleep(400);
    await step("触控板: two taps (a double click)", async () => { await tap(mid); await sleep(100); await tap(mid); });
    await sleep(400);
    await step("触控板: two-finger tap", () => two(mid, 0, 0));
    await step("触控板: a long press", () => tap(mid, 620));
    await step("触控板: two fingers slide (the wheel)", () => two(mid, 0, 70));
    await sleep(400);
    await step("触控板: a tap, then down again and slide (a drag)", () => tapAndDrag(mid, { x: mid.x + 80, y: mid.y + 10 }));
    await step("keys: esc on the key bar", () => press(document.querySelector('.key[data-key="escape"]')));
    await step("keys: ⌘ armed, then the letter c", async () => {
      await press(document.querySelector('.key[data-mod="cmd"]'));
      $("shortcut").value = "c";
      $("shortcut").dispatchEvent(new Event("input"));
    });
    await step("keys: text, and return", () => {
      $("typing").value = "::你好 ok";
      $("typing").dispatchEvent(new Event("input"));
      $("typing").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    await setMode("touch");
    await sleep(600);
    await say("state", { when: "点按 chosen", state: state() });
    await step("点按: a tap at 0.25, 0.25", () => tap(at(0.25, 0.25)));
    await sleep(400);
    await step("点按: a long press at 0.75, 0.25", () => tap(at(0.75, 0.25), 620));
    await step("点按: two-finger tap at 0.5, 0.75", () => two(at(0.5, 0.75), 0, 0));
    await step("点按: two fingers slide at 0.3, 0.6 (the wheel)", () => two(at(0.3, 0.6), 0, -70));
    await sleep(400);
    await step("点按: a tap at 0.4, 0.4, then down again and slide to 0.6, 0.5 (a drag)", () => tapAndDrag(at(0.4, 0.4), at(0.6, 0.5)));
    await sleep(400);
    await step("点按: one finger slides (moves the view, sends nothing)", () => swipe(at(0.5, 0.5), at(0.6, 0.6), 200));
    await step("点按: a tap outside the picture (nothing)", () => { const [x, y, w, h] = box(live() ? video : canvas); return tap({ x: x + w / 2, y: y + h + 12 }); });

    const mouse = (type, point, more) => fire(type, 1, point.x, point.y, "mouse", more);
    await step("mouse: moves across the picture", async () => { for (let i = 0; i <= 12; i++) { mouse("pointermove", at(0.2 + i * 0.02, 0.3)); await sleep(16); } });
    await step("mouse: moves, and clicks on the way", async () => {
      for (let i = 0; i <= 6; i++) { mouse("pointermove", at(0.5 + i * 0.01, 0.5)); await sleep(16); }
      mouse("pointerdown", at(0.56, 0.5), { button: 0 });
      await sleep(40);
      mouse("pointerup", at(0.56, 0.5), { button: 0 });
    });
    await sleep(500);
    await step("mouse: right button", async () => { mouse("pointerdown", at(0.6, 0.6), { button: 2 }); await sleep(40); mouse("pointerup", at(0.6, 0.6), { button: 2 }); });
    await sleep(500);
    await step("mouse: a drag", async () => {
      mouse("pointerdown", at(0.3, 0.7), { button: 0 });
      for (let i = 1; i <= 8; i++) { mouse("pointermove", at(0.3 + i * 0.02, 0.7)); await sleep(16); }
      mouse("pointerup", at(0.46, 0.7), { button: 0 });
    });
    await step("mouse: the wheel, at rest", async () => { for (let i = 0; i < 4; i++) { stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, clientX: at(0.46, 0.7).x, clientY: at(0.46, 0.7).y, bubbles: true, cancelable: true })); await sleep(16); } });
    await step("mouse: the wheel, while moving", async () => {
      mouse("pointermove", at(0.5, 0.72));
      stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true }));
      await sleep(16);
      stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true }));
    });

    await setMode("view");
    await sleep(300);
    await step("只看: one finger slides, a tap, two fingers slide (nothing)", async () => { await swipe(at(0.5, 0.5), at(0.6, 0.6), 200); await tap(at(0.3, 0.3)); await sleep(400); await two(at(0.5, 0.5), 0, 50); });
    const before = state().box;
    await step("只看: two fingers apart (zoom), nothing sent", () => two(at(0.5, 0.5), 0, 0, 120));
    await say("state", { when: "zoomed", before, state: state() });
    if (live()) {
      // The sender drops to a smaller picture, as it does on a worse network: the page must not move or resize what it shows.
      const zoomed = box(video);
      Object.defineProperty(video, "videoWidth", { get: () => 1280, configurable: true });
      Object.defineProperty(video, "videoHeight", { get: () => 720, configurable: true });
      video.dispatchEvent(new Event("resize"));
      await sleep(100);
      await say("state", { when: "the track's resolution changed to 1280×720", before: zoomed, after: box(video), same: JSON.stringify(zoomed) === JSON.stringify(box(video)), css: [video.style.width, video.style.height, video.style.transform] });
    }
  }

  if (plan === "cursor") {
    await until(() => window.__channels.cursor && __channels.cursor.readyState === "open" && __channels.input.readyState === "open", 8000);
    await sleep(1200);
    await say("state", { when: "what the app said of its pointer", cursor: (__heard.cursor || []).slice(0, 3), state: state() });
    const feed = (message) => __channels[message.t].dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    const where = () => { const [px, py] = box(pointer), [x, y, w, h] = box(video); const tip = pointer.style.transformOrigin.split(" ").map(parseFloat); const scale = Number((/scale\(([^)]+)\)/.exec(pointer.style.transform) || [0, 1])[1]); return { u: +((px + (tip[0] || 0) * scale - x) / w).toFixed(4), v: +((py + (tip[1] || 0) * scale - y) / h).toFixed(4), scale: +scale.toFixed(3), size: box(pointer).slice(2) }; };
    let n = 1e6;
    const results = {};
    feed({ t: "cursor", x: 0.25, y: 0.75, i: ++n });
    results["told 0.25, 0.75"] = where();
    feed({ t: "cursor", x: 0.1, y: 0.1, i: n - 5 });
    results["an older one (0.1, 0.1) after it: not drawn"] = where();
    feed({ t: "cursor", x: 1, y: 1, i: ++n });
    results["told 1, 1 (the far corner)"] = where();
    feed({ t: "cursor", x: 0.5, y: 0.5, i: ++n });
    // Zoomed in on a spot, the pointer stays on its place in the picture and grows with it.
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, ctrlKey: true, clientX: at(0.3, 0.3).x, clientY: at(0.3, 0.3).y, bubbles: true, cancelable: true }));
    await sleep(100);
    results["told 0.5, 0.5, then zoomed in"] = Object.assign(where(), { picture: box(video) });
    feed({ t: "cursor", x: 0.4, y: 0.45, i: ++n });
    results["told 0.4, 0.45 while zoomed"] = where();
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 4000, ctrlKey: true, clientX: at(0.3, 0.3).x, clientY: at(0.3, 0.3).y, bubbles: true, cancelable: true }));
    await sleep(100);
    results["zoomed back out"] = Object.assign(where(), { picture: box(video) });
    // A shape of the page's own making: 2 by 2 points, hot spot in its middle, on a display 1000 points wide.
    const dot = document.createElement("canvas");
    dot.width = dot.height = 4;
    dot.getContext("2d").fillRect(0, 0, 4, 4);
    feed({ t: "shape", id: "check", png: dot.toDataURL("image/png").split(",")[1], w: 20, h: 20, hotX: 10, hotY: 10, scale: 2, displayW: 1000, displayH: 600 });
    results["a shape 20 points square, hot spot in its middle, display 1000 points wide"] = Object.assign(where(), { style: [pointer.style.width, pointer.style.height, pointer.style.left, pointer.style.top], image: pointer.style.backgroundImage.slice(0, 28) });
    const known = (__heard.shape || [])[0];
    if (known) {
      feed({ t: "shape", id: known.id });
      results["back to the app's own shape, by id"] = Object.assign(where(), { style: [pointer.style.width, pointer.style.height, pointer.style.left, pointer.style.top] });
    }
    await say("state", { when: "positions fed to the page", results });

    // The hand at the phone against what comes back from the computer.
    await press($("mode"));
    await sleep(300);
    await press(document.querySelector('.choice[data-mode="trackpad"]'));
    const ready = await until(() => $("toast").textContent.startsWith("触控板"), 8000);
    if (!ready) return say("done", { failed: "not controlling: " + $("toast").textContent });
    await sleep(600);
    feed({ t: "cursor", x: 0.5, y: 0.5, i: ++n });
    const echo = {};
    echo["start"] = where();
    const id = ++finger, from = at(0.5, 0.5);
    fire("pointerdown", id, from.x, from.y);
    const trailOf = [];
    for (let i = 1; i <= 20; i++) {
      fire("pointermove", id, from.x + i * 6, from.y);
      await sleep(16);
      trailOf.push(where().u);
      // What the computer would say now: where the hand was four frames ago.
      if (i > 4) feed({ t: "cursor", x: trailOf[i - 5], y: 0.5, i: ++n });
      if (where().u < trailOf[trailOf.length - 1]) echo["went backwards at move " + i] = where();
    }
    fire("pointerup", id, from.x + 120, from.y);
    echo["after the slide (never backwards: " + trailOf.every((u, i) => i === 0 || u >= trailOf[i - 1]) + ")"] = where();
    for (let i = 16; i < 20; i++) { await sleep(16); feed({ t: "cursor", x: trailOf[i], y: 0.5, i: ++n }); }
    echo["after the last of its own came back"] = where();
    feed({ t: "cursor", x: 0.2, y: 0.2, i: ++n });
    echo["someone at the computer moves it to 0.2, 0.2 within a quarter second: not yet"] = where();
    await sleep(300);
    feed({ t: "cursor", x: 0.21, y: 0.2, i: ++n });
    echo["and again after it: drawn"] = where();
    const next = ++finger;
    fire("pointerdown", next, from.x, from.y);
    await drag(next, from, { x: from.x + 30, y: from.y }, 100);
    fire("pointerup", next, from.x + 30, from.y);
    echo["the next slide starts from there"] = where();
    await say("state", { when: "the hand against the echo", echo, sent: __sent.filter((event) => event.t === "move").length + " moves sent" });
  }

  await sleep(500);
  await say("done", { state: state() });
})();
`;

// ── The page, with the script in it ─────────────────────────────────

interface Report {
  at: number;
  kind: string;
  [key: string]: unknown;
}
const reports: Report[] = [];
let finished = () => {};
const done = new Promise<void>((resolve) => (finished = resolve));
let stepFrom = 0;

function heard(report: Report): void {
  reports.push(report);
  if (report.kind === "step") {
    const posted = lines.slice(stepFrom).filter((entry) => entry.line.includes("dry run"));
    stepFrom = lines.length;
    console.log(`\n■ ${String(report.name)}`);
    const sent = report.sent as { lane: string; t: string }[];
    console.log(`  the page sent ${sent.length}: ${compact(sent.map((event) => `${event.lane}:${describe(event)}`)) || "nothing"}`);
    console.log(`  the app would post ${posted.length}: ${compact(posted.map((entry) => entry.line.replace(/^.*?dry run( \(video\))?: /, (_all, video) => (video ? "channel " : "socket ")).replace(/"t":"posted",?|"v":"[^"]*",?/g, ""))) || "nothing"}`);
  } else if (report.kind === "state" || report.kind === "done") {
    stepFrom = lines.length;
    console.log(`\n● ${String(report.when ?? report.kind)} ${JSON.stringify({ ...report, at: undefined, kind: undefined, when: undefined })}`);
    if (report.kind === "done") finished();
  }
}

function describe(event: Record<string, unknown>): string {
  const { lane: _lane, t, i, ...rest } = event;
  const inside = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  return `${String(t)}${i === undefined ? "" : `#${String(i)}`}${inside ? `(${inside})` : ""}`;
}

/** A run of the same kind of line, shortened to its ends. */
function compact(items: string[]): string {
  const out: string[] = [];
  const kind = (item: string) => item.replace(/[#(].*$/, "").replace(/\{.*$/, (all) => (/"kind":"(\w+)"/.exec(all)?.[1] ?? all));
  for (let i = 0; i < items.length; ) {
    let j = i;
    while (j + 1 < items.length && kind(items[j + 1]!) === kind(items[i]!)) j++;
    if (j - i >= 3) out.push(items[i]!, `… ${j - i - 1} more …`, items[j]!);
    else out.push(...items.slice(i, j + 1));
    i = j + 1;
  }
  return out.join("  ");
}

const upstream = `127.0.0.1:${port}`;
const started: ChildProcess[] = [];
const proxy = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/report") {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      response.writeHead(204).end();
      try {
        heard({ at: Date.now(), ...(JSON.parse(body) as { kind: string }) });
      } catch {
        // Not a report.
      }
    });
    return;
  }
  void fetch(`http://${upstream}/${url.search}`).then(async (page) => {
    const html = (await page.text()).replace("<style>", () => `<script>${HOOKS}</script><style>`).replace("</body>", () => `<script>${DRIVER}</script></body>`);
    response.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
  });
});
/** A picture for the socket that is not the screen's: a moving pattern, with a clock strip stopped at the time it began. */
function pattern(near: WebSocket): ChildProcess {
  const time = Date.now() % 65536;
  const gray = time ^ (time >> 1);
  const cells = [1, 0, ...Array.from({ length: 16 }, (_, bit) => (gray >> (15 - bit)) & 1), 0, 1];
  const strip = cells.map((on, i) => `drawbox=x=iw*${(0.05 + i * 0.02).toFixed(2)}:y=ih*0.10:w=iw*0.02+1:h=ih*0.04:color=${on ? "white" : "black"}:t=fill`).join(",");
  const child = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=20", "-vf", `${strip},format=yuv420p`,
      "-c:v", "h264_videotoolbox", "-realtime", "1", "-profile:v", "baseline", "-b:v", "2M", "-g", "20", "-bf", "0", "-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "-"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  started.push(child);
  const splitter = new AccessUnitSplitter();
  let seq = 0;
  child.stdout!.on("data", (chunk: Buffer) =>
    splitter.push(chunk, (unit: Buffer, key: boolean) => {
      if (near.readyState !== WebSocket.OPEN) return;
      const head = Buffer.allocUnsafe(5);
      head[0] = key ? 1 : 0;
      head.writeUInt32BE(++seq, 1);
      near.send(Buffer.concat([head, unit]));
    }),
  );
  near.on("close", () => child.kill("SIGKILL"));
  log(`a test pattern stands in for the socket's picture (its strip says ${time})`);
  return child;
}

const sockets = new WebSocketServer({ noServer: true });
proxy.on("upgrade", (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (near) => {
    const asked = new URL(request.url ?? "/", "http://localhost").searchParams;
    const fake = asked.get("legacy") === "fake";
    let faked: ChildProcess | undefined;
    if (fake && asked.get("video") !== "1") faked = pattern(near);
    const far = new WebSocket(`ws://${upstream}${request.url ?? "/"}`);
    const waiting: [WebSocket.RawData, boolean][] = [];
    near.on("message", (data, binary) => (far.readyState === WebSocket.OPEN ? far.send(data, { binary }) : waiting.push([data, binary])));
    far.on("open", () => waiting.splice(0).forEach(([data, binary]) => far.send(data, { binary })));
    far.on("message", (data, binary) => {
      if (fake) {
        // The host's own picture, if it has one, is left out; what it says is passed on, but for its capture's failing.
        if (binary || String(data).startsWith('{"error"')) return;
        if (String(data) === '{"rtc":{"t":"off"}}') faked ??= pattern(near);
      }
      if (near.readyState === WebSocket.OPEN) near.send(data, { binary });
    });
    far.on("close", () => !fake && near.close());
    near.on("close", () => far.close());
    far.on("error", () => near.close());
    near.on("error", () => far.close());
  });
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

const planned = options.plan !== "none";
const address = `http://127.0.0.1:${planned ? (proxy.address() as AddressInfo).port : port}/?token=${token}&display=${display}${planned ? `&plan=${options.plan}&seconds=${seconds}` : ""}${options.query ? `&${options.query}` : ""}`;
log(`the page: ${address}`);

// ── The viewer ──────────────────────────────────────────────────────

const profiles: string[] = [];
let shoot: ((file: string) => Promise<void>) | undefined;
let bootedHere: string | undefined;

async function chrome(url: string): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "linkshell-screen-check-"));
  profiles.push(profile);
  const child = spawn(
    options.chrome!,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // A fresh profile would otherwise ask for the keychain.
      "--use-mock-keychain",
      `--window-size=${options.size!.replace("x", ",")}`,
      // Nobody looks at this window, and a page that counts as hidden neither draws nor decodes.
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  started.push(child);
  const portFile = join(profile, "DevToolsActivePort");
  for (let waited = 0; !existsSync(portFile); waited += 100) {
    if (waited > 15_000) throw new Error("Chrome did not start");
    await pause(100);
  }
  const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
  let page: { webSocketDebuggerUrl: string } | undefined;
  for (let waited = 0; !page; waited += 100) {
    if (waited > 10_000) throw new Error("Chrome opened no page");
    const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json(), () => [])) as { type: string; webSocketDebuggerUrl: string }[];
    page = targets.find((target) => target.type === "page");
    if (!page) await pause(100);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
  const waiting = new Map<number, (message: { result?: Record<string, unknown> }) => void>();
  let calls = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id?: number; method?: string; params?: { exceptionDetails?: { text: string; exception?: { description?: string } }; type?: string; args?: { value?: unknown; description?: string }[] }; result?: Record<string, unknown> };
    if (message.id) waiting.get(message.id)?.(message);
    else if (message.method === "Runtime.exceptionThrown") log(`[page] threw: ${message.params!.exceptionDetails!.exception?.description ?? message.params!.exceptionDetails!.text}`);
    else if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params!.type!)) log(`[page] ${message.params!.type}: ${message.params!.args!.map((arg) => arg.value ?? arg.description).join(" ")}`);
  });
  const call = (method: string, params?: object) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve) => {
      waiting.set(++calls, resolve);
      socket.send(JSON.stringify({ id: calls, method, params }));
    });
  await call("Runtime.enable");
  // Chrome gives every interface's address only to a page allowed to capture; otherwise just the default
  // route's, which on a Mac behind a tunnelling proxy reaches nothing.
  const origin = new URL(url).origin;
  await call("Browser.grantPermissions", { origin, permissions: ["audioCapture", "videoCapture"] });
  await call("Page.navigate", { url });
  shoot = async (file) => {
    const { result } = await call("Page.captureScreenshot", { format: "png" });
    if (result?.data) writeFileSync(file, Buffer.from(String(result.data), "base64"));
  };
}

async function simulator(url: string): Promise<void> {
  const listed = JSON.parse((await run("xcrun", ["simctl", "list", "devices", "-j"])).stdout) as { devices: Record<string, { name: string; udid: string; state: string; isAvailable: boolean }[]> };
  const all = Object.values(listed.devices).flat();
  if (!all.some((device) => device.state === "Booted")) {
    const phone = all.find((device) => device.isAvailable && /^iPhone/.test(device.name));
    if (!phone) throw new Error("no iPhone simulator to boot");
    log(`booting ${phone.name}`);
    await run("xcrun", ["simctl", "boot", phone.udid]);
    await run("xcrun", ["simctl", "bootstatus", phone.udid, "-b"], { timeout: 180_000 });
    bootedHere = phone.udid;
  }
  // A simulator just booted, or a busy Mac, can time the first request out.
  for (let attempt = 1; ; attempt++) {
    try {
      await run("xcrun", ["simctl", "openurl", "booted", url]);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await pause(2000);
    }
  }
  shoot = async (file) => void (await run("xcrun", ["simctl", "io", "booted", "screenshot", file]));
}

async function tidy(): Promise<void> {
  if (options.viewer === "simulator") {
    await run("xcrun", ["simctl", "terminate", "booted", "com.apple.mobilesafari"]).catch(() => {});
    if (bootedHere) await run("xcrun", ["simctl", "shutdown", bootedHere]).catch(() => {});
  }
  await Promise.all(
    started.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      child.kill("SIGTERM");
      return new Promise((resolve) => child.once("exit", resolve));
    }),
  );
  for (const profile of profiles) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  proxy.close();
  screen.stop();
}

// ── The run ─────────────────────────────────────────────────────────

let failed = false;
try {
  await (options.viewer === "simulator" ? simulator(address) : chrome(address));
  const limit = pause((planned && options.plan !== "watch" ? 180 : seconds + 25) * 1000);
  if (planned) await Promise.race([done, limit]);
  else await pause(seconds * 1000);
  if (options.shot) await shoot?.(options.shot).catch((error: Error) => log(`no screenshot: ${error.message}`));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await tidy();
}

// ── What was measured ───────────────────────────────────────────────

interface Measured {
  mode: string;
  latency: { n: number; min: number | null; p50: number | null; p95: number | null; max: number | null };
  fps: number | null;
  width: number;
  height: number;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  rttMs: number | null;
  path: string | null;
  dropped: number | null;
  freezes: number | null;
  unread: number;
}
const measured = lines.filter((entry) => entry.line.startsWith("[screen] measured: ")).map((entry) => JSON.parse(entry.line.slice(19)) as Measured);
const middle = (values: (number | null)[]) => {
  const sorted = values.filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : null;
};
for (const mode of ["video", "legacy"]) {
  const all = measured.filter((entry) => entry.mode === mode && (entry.fps ?? 0) > 0);
  if (!all.length) continue;
  // The first seconds are the connection coming up and the first key frame.
  const steady = all.slice(Math.min(3, all.length >> 1));
  const last = steady.at(-1)!;
  console.log(
    `\n[measured] ${mode}, ${options.viewer}: ${steady.length} s of ${all.length} — latency p50 ${middle(steady.map((entry) => entry.latency.p50))} ms, p95 ${middle(steady.map((entry) => entry.latency.p95))} ms, ` +
      `max ${Math.max(...steady.map((entry) => entry.latency.max ?? 0))} ms (${steady.reduce((sum, entry) => sum + entry.latency.n, 0)} frames read, ${steady.reduce((sum, entry) => sum + entry.unread, 0)} unread); ` +
      `${middle(steady.map((entry) => entry.fps))} fps, ${last.width}×${last.height}, jitter buffer ${middle(steady.map((entry) => entry.jitterBufferMs))} ms, decode ${middle(steady.map((entry) => entry.decodeMs))} ms, ` +
      `rtt ${middle(steady.map((entry) => entry.rttMs))} ms, path ${last.path}, dropped ${last.dropped}, freezes ${last.freezes}`,
  );
  console.log(`  each second (p50/p95/max, fps): ${all.map((entry) => `${entry.latency.p50}/${entry.latency.p95}/${entry.latency.max}@${entry.fps}`).join("  ")}`);
}
process.exit(failed ? 1 : 0);
