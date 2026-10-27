#!/usr/bin/env node
// Development only: the remote screen's receive statistics in the running window, from
// Chromium itself (no change to the page). Attaches to every frame, records each
// RTCPeerConnection the viewer makes, reloads the screen once, then samples twice.
//   node scripts/screen-stats.mjs <port> [seconds]
const [port, seconds = "4"] = process.argv.slice(2);
const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let next = 0;
const waiting = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
});
const call = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++next;
  waiting.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const hook = `(() => { const Original = window.RTCPeerConnection; if (!Original || window.__peers) return; window.__peers = [];
  window.RTCPeerConnection = new Proxy(Original, { construct(target, args) { const pc = Reflect.construct(target, args); window.__peers.push(pc); return pc; } }); })();`;
const sample = `(async () => { const pc = (window.__peers || []).filter((p) => p.connectionState !== "closed").at(-1); if (!pc) return null;
  const take = async () => { let track = {}, codecs = new Map(); (await pc.getStats()).forEach((e) => { if (e.type === "inbound-rtp" && e.kind === "video") track = e; if (e.type === "codec") codecs.set(e.id, e); }); return { track, codec: codecs.get(track.codecId)?.mimeType }; };
  const a = await take(); await new Promise((r) => setTimeout(r, ${Number(seconds) * 1000})); const b = await take();
  const dt = (b.track.timestamp - a.track.timestamp) / 1000, d = (k) => (b.track[k] || 0) - (a.track[k] || 0);
  return { codec: b.codec, decoder: b.track.decoderImplementation, powerEfficientDecoder: b.track.powerEfficientDecoder,
    width: b.track.frameWidth, height: b.track.frameHeight, fps: +(d("framesDecoded") / dt).toFixed(1),
    decodeMs: +(d("totalDecodeTime") / Math.max(1, d("framesDecoded")) * 1000).toFixed(2),
    jitterBufferMs: +(d("jitterBufferDelay") / Math.max(1, d("jitterBufferEmittedCount")) * 1000).toFixed(1),
    mbps: +(d("bytesReceived") * 8 / dt / 1e6).toFixed(2), dropped: d("framesDropped"), freezes: d("freezeCount") }; })()`;
const { result } = await call("Target.getTargets");
const frames = result.targetInfos.filter((target) => target.type === "iframe" || target.type === "page");
const sessions = [];
for (const target of frames) {
  const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) continue;
  await call("Page.enable", {}, sessionId);
  await call("Page.addScriptToEvaluateOnNewDocument", { source: hook, runImmediately: true }, sessionId);
  sessions.push({ target, sessionId });
}
const page = sessions.find((one) => one.target.type === "page");
// A new viewer frame is a new target: catch it paused and hook it before its script runs.
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method !== "Target.attachedToTarget") return;
  const sessionId = message.params.sessionId;
  void call("Page.addScriptToEvaluateOnNewDocument", { source: hook, runImmediately: true }, sessionId)
    .then(() => call("Runtime.runIfWaitingForDebugger", {}, sessionId));
});
await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page.sessionId);
// Remount the screen so the viewer's new connection is made after the hook.
await call("Runtime.evaluate", { expression: "(() => { const h = location.hash; location.hash = '#view=home'; setTimeout(() => { location.hash = h; }, 300); return h; })()", returnByValue: true }, page.sessionId);
await new Promise((resolve) => setTimeout(resolve, 12_000));
const { result: after } = await call("Target.getTargets");
for (const target of after.targetInfos.filter((one) => one.type === "iframe")) {
  const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) continue;
  const value = await call("Runtime.evaluate", { expression: sample, awaitPromise: true, returnByValue: true }, sessionId);
  const stats = value.result?.result?.value;
  if (stats) { console.log(JSON.stringify(stats, null, 2)); break; }
}
socket.close();
