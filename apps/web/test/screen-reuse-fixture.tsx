/**
 * Open /test/screen-reuse-fixture.html on the ordinary Vite dev server.
 * The production Screen, retention slot, iframe bridge, viewer and browser RTC
 * run unchanged. Only Host RPC/byte streams terminate at this canvas sender.
 * This proves browser ownership and negotiation, not Mac capture or WAN media.
 */
import "../src/styles/theme.css";
import "../src/styles/base.css";
import "../src/styles/common.css";
import "../src/styles/screens.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { HostStream, HostStreams, StreamHandlers } from "@linkshell/client-core";
import { Runtime } from "../src/live/common";
import type { Connection } from "../src/live/engine";
import { Screen } from "../src/live/Video";
import { ScreenSessionSlot } from "../src/live/screen-session-slot";
import { encodeWs, WsDecoder } from "../src/live/transport";
import { viewerPage } from "../../../packages/host/src/screen-viewer";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { themeStyles } from "../src/theme";

const utf8 = new TextEncoder();
const decode = new TextDecoder();
// Both synthetic peers live in this browser. Avoid depending on LAN mDNS or
// a machine firewall merely to verify React and viewer lifetime behavior.
const loopbackCandidate = (candidate: string) => {
  const parts = candidate.split(" ");
  if (parts[7] === "host") parts[4] = "127.0.0.1";
  return parts.join(" ");
};
const fixtureKey = "screen-reuse-fixture";
const legacy = new URLSearchParams(location.search).has("legacy");
const log = {
  starts: 0,
  httpRequests: 0,
  socketOpens: 0,
  socketCloses: 0,
  offers: 0,
  viewerLoads: 0,
  receiverIds: [] as string[],
  receiverClosed: [] as string[],
  receiverStates: {} as Record<string, string>,
  configurations: [] as Record<string, unknown>[],
  inputs: 0,
  sentFrames: 0,
  senderStates: [] as string[],
  senderCandidates: 0,
  receiverCandidates: 0,
  answers: 0,
  errors: [] as string[],
};
const streams = new Set<{ close(): void }>();
let pauseAck = true;
let bridgeChannel: string | undefined;

// Keep the real two-minute callback while making expiry manually testable.
const originalSetTimeout = window.setTimeout.bind(window);
const originalClearTimeout = window.clearTimeout.bind(window);
const retentionTimers = new Map<number, () => void>();
window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  let id: number;
  const invoke = () => {
    retentionTimers.delete(id);
    if (typeof handler === "function") handler(...args);
  };
  id = originalSetTimeout(delay === 120000 && typeof handler === "function" ? invoke : handler, delay, ...args);
  if (delay === 120000 && typeof handler === "function") retentionTimers.set(id, invoke);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (id !== undefined) retentionTimers.delete(id);
  originalClearTimeout(id);
};

const instrumentation = String.raw`<script>
  (() => {
    const report = (type, extra = {}) => parent.postMessage({screenReuseFixture: true, type, ...extra}, "*");
    report("viewer-load");
    const Original = window.RTCPeerConnection;
    addEventListener("message", (event) => {
      if (event.source === parent && event.data?.screenReuseProbe) parent.postMessage({channel: "wrong-fixture-channel", type: "screenSession", session: {t: "capabilities", version: 1, configure: false, pause: false}}, "*");
    });
    window.RTCPeerConnection = new Proxy(Original, { construct(Target, args) {
      const pc = new Target(...args), id = crypto.randomUUID();
      report("receiver-created", {id});
      pc.addEventListener("connectionstatechange", () => report("receiver-state", {id, state: pc.connectionState}));
      const addIce = pc.addIceCandidate.bind(pc);
      pc.addIceCandidate = (...args) => addIce(...args).catch((error) => { report("receiver-error", {error: String(error)}); throw error; });
      const close = pc.close.bind(pc);
      pc.close = () => { report("receiver-closed", {id}); close(); };
      return pc;
    }});
  })();
</script>`;
window.addEventListener("message", (event) => {
  if (event.source !== document.querySelector("iframe")?.contentWindow) return;
  if (event.data?.type === "ws-open") bridgeChannel = event.data.channel;
  if (!event.data?.screenReuseFixture) return;
  const message = event.data;
  if (message.type === "viewer-load") log.viewerLoads++;
  if (message.type === "receiver-created") log.receiverIds.push(message.id);
  if (message.type === "receiver-closed") log.receiverClosed.push(message.id);
  if (message.type === "receiver-state") log.receiverStates[message.id] = message.state;
  if (message.type === "receiver-error") log.errors.push(message.error);
});

async function openFixtureStream(_port: number, handlers: StreamHandlers): Promise<HostStream> {
  let kind: "http" | "socket" | undefined;
  let closed = false;
  let sender: RTCPeerConnection | undefined;
  let animation = 0;
  let paused = false;
  let display = 0;
  let width = 1280;
  let maxFps = 60;
  let media: MediaStream | undefined;
  let answer: Promise<void> = Promise.resolve();
  const decoder = new WsDecoder();
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:160px;height:auto;border:1px solid #888";
  document.getElementById("fixture-sources")?.append(canvas);
  const ctx = canvas.getContext("2d")!;
  const size = () => {
    canvas.width = width;
    canvas.height = Math.round(width * (display === 0 ? 9 / 16 : 10 / 16));
  };
  size();
  const send = (value: unknown) => {
    if (!closed) handlers.data(encodeWs(utf8.encode(JSON.stringify(value)), 1));
  };
  const draw = () => {
    if (closed || paused) return;
    ctx.fillStyle = display === 0 ? "#243b65" : "#285547";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white";
    ctx.font = `${Math.round(width / 24)}px system-ui`;
    ctx.fillText(`Fixture display ${display} · ${width} × ${canvas.height}`, width / 20, width / 9);
    const x = (performance.now() / 5) % (canvas.width - width / 15);
    ctx.fillStyle = "#f3ce83";
    ctx.fillRect(x, canvas.height / 2, width / 15, width / 15);
    log.sentFrames++;
    animation = originalSetTimeout(draw, 1000 / Math.min(maxFps, 30));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (kind === "socket") log.socketCloses++;
    originalClearTimeout(animation);
    sender?.close();
    media?.getTracks().forEach((track) => track.stop());
    canvas.remove();
    streams.delete(stream);
    handlers.closed();
  };
  const receive = async (message: Record<string, unknown>) => {
    if (message.t === "screen.configure") {
      log.configurations.push(message);
      paused = message.paused === true;
      display = Number(message.display);
      width = message.width === "native" ? 2560 : Number(message.width);
      maxFps = Number(message.maxFps) || 60;
      originalClearTimeout(animation);
      size();
      if (!paused) draw();
      if (pauseAck || !paused) send({ session: { t: "configured", requestId: message.requestId, generation: log.configurations.length, display, width, height: canvas.height, maxFps, paused } });
    } else if (message.t === "rtc.answer") {
      log.answers++;
      answer = sender!.setRemoteDescription({ type: "answer", sdp: String(message.sdp) });
      await answer;
    } else if (message.t === "rtc.ice") {
      log.receiverCandidates++;
      await answer;
      await sender?.addIceCandidate({ candidate: loopbackCandidate(String(message.candidate)), sdpMid: message.sdpMid as string | null, sdpMLineIndex: message.sdpMLineIndex as number | null });
    } else if (message.t === "control") {
      send({ control: { available: true, trusted: true } });
    } else if (message.t === "ping") {
      send({ pong: message.n });
    } else if (message.t === "rtc.failed") {
      log.errors.push(String(message.reason));
    } else if (["key", "pointer", "button", "text", "scroll"].includes(String(message.t))) log.inputs++;
  };
  const connect = async () => {
    if (!legacy) send({ session: { t: "capabilities", version: 1, configure: true, pause: true, retainMs: 120000 } });
    sender = new RTCPeerConnection({ iceServers: [] });
    sender.addEventListener("connectionstatechange", () => log.senderStates.push(sender!.connectionState));
    const candidates: RTCIceCandidate[] = [];
    let offered = false;
    const sendCandidate = (candidate: RTCIceCandidate) => send({ rtc: { t: "ice", candidate: loopbackCandidate(candidate.candidate), sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } });
    sender.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate) {
        log.senderCandidates++;
        if (offered) sendCandidate(candidate);
        else candidates.push(candidate);
      }
    });
    for (const label of ["input", "pointer", "cursor", "shape"]) {
      const channel = sender.createDataChannel(label);
      channel.addEventListener("message", () => log.inputs++);
    }
    draw();
    media = canvas.captureStream(30);
    sender.addTrack(media.getVideoTracks()[0], media);
    send({ rtc: { t: "config", iceServers: [] } });
    await sender.setLocalDescription(await sender.createOffer());
    if (closed) return;
    log.offers++;
    send({ rtc: { t: "offer", sdp: sender.localDescription!.sdp } });
    offered = true;
    candidates.forEach(sendCandidate);
  };
  const stream: HostStream = {
    direct: false,
    close,
    write(bytes) {
      if (closed) return;
      if (!kind) {
        const request = decode.decode(bytes);
        if (!request.includes("Upgrade: websocket")) {
          kind = "http";
          log.httpRequests++;
          const html = viewerPage().replace("<head>", `<head>${instrumentation}`);
          const body = utf8.encode(html);
          handlers.data(utf8.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${body.byteLength}\r\nContent-Type: text/html\r\n\r\n`));
          handlers.data(body);
          handlers.closed();
          return;
        }
        kind = "socket";
        log.socketOpens++;
        const path = request.split(" ")[1];
        const query = new URL(path, "http://fixture.invalid").searchParams;
        display = Number(query.get("display")) || 0;
        width = query.get("width") === "native" ? 2560 : Number(query.get("width")) || 1280;
        maxFps = Number(query.get("maxFps")) || 60;
        size();
        const key = request.match(/Sec-WebSocket-Key: ([^\r]+)/)![1];
        void crypto.subtle.digest("SHA-1", utf8.encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")).then((digest) => {
          if (closed) return;
          const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
          handlers.data(utf8.encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
          // The iframe receives its open event before host capabilities and SDP.
          originalSetTimeout(() => void connect().catch((error) => log.errors.push(String(error))), 0);
        });
        return;
      }
      if (kind === "socket") {
        for (const frame of decoder.push(bytes)) {
          if (frame.opcode === 1) void receive(JSON.parse(decode.decode(frame.bytes))).catch((error) => log.errors.push(String(error)));
          if (frame.opcode === 8) close();
        }
      }
    },
  };
  streams.add(stream);
  return stream;
}

const state = createStore(() => ({ status: "online" }));
const connection = {
  computer: { key: fixtureKey },
  link: {
    status: "online",
    async call(method: string) {
      if (method === "screen.access") return { supported: true, recording: true, control: true };
      if (method === "screen.start") {
        log.starts++;
        return { port: 19333, token: "fixture-token", displays: [{ index: 0, name: "Fixture Display A" }, { index: 1, name: "Fixture Display B" }] };
      }
      throw new Error(`Unexpected fixture RPC: ${method}`);
    },
    onStatus() { return () => {}; },
  },
  streams: { open: openFixtureStream } as HostStreams,
  store: state,
} as unknown as Connection;

let baseline: { frame: HTMLIFrameElement; window: Window | null; starts: number; offers: number; loads: number; receiverId?: string } | undefined;
const snapshot = () => ({
  ...log,
  legacy,
  retentionTimers: retentionTimers.size,
  iframePresent: !!document.querySelector("iframe"),
  iframeVisible: !!document.querySelector("iframe")?.getBoundingClientRect().width,
  sameIframe: baseline ? document.querySelector("iframe") === baseline.frame : null,
  sameWindow: baseline ? document.querySelector("iframe")?.contentWindow === baseline.window : null,
  sameReceiver: baseline ? document.querySelector("iframe") === baseline.frame && log.receiverIds.at(-1) === baseline.receiverId && !log.receiverClosed.includes(baseline.receiverId!) : null,
  extraStarts: baseline ? log.starts - baseline.starts : null,
  extraOffers: baseline ? log.offers - baseline.offers : null,
  extraLoads: baseline ? log.viewerLoads - baseline.loads : null,
});
Object.defineProperty(window, "screenReuseSnapshot", { get: snapshot });

function Fixture() {
  const [active, setActive] = useState(true);
  const [selected, setSelected] = useState(fixtureKey);
  const [output, setOutput] = useState(snapshot);
  useEffect(() => {
    const timer = setInterval(() => setOutput(snapshot()), 100);
    return () => clearInterval(timer);
  }, []);
  return <>
    <style>{themeStyles}</style>
    <div style={{ padding: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
      <button onClick={() => setActive((value) => !value)}>{active ? "Leave screen route" : "Return to screen route"}</button>
      <button onClick={() => {
        const frame = document.querySelector("iframe");
        if (frame) baseline = { frame, window: frame.contentWindow, starts: log.starts, offers: log.offers, loads: log.viewerLoads, receiverId: log.receiverIds.at(-1) };
      }}>Save identity baseline</button>
      <button onClick={() => {
        for (const [id, invoke] of [...retentionTimers]) {
          originalClearTimeout(id);
          invoke();
        }
      }}>Expire retained screen now</button>
      <button onClick={() => setSelected((key) => key === fixtureKey ? "other-computer" : fixtureKey)}>Switch selected computer</button>
      <button onClick={() => { for (const stream of [...streams]) stream.close(); }}>Disconnect host sockets</button>
      <button onClick={() => { pauseAck = false; }}>Withhold pause acknowledgement</button>
      <button onClick={() => window.postMessage({ channel: bridgeChannel, type: "screenSession", session: { t: "capabilities", version: 1, configure: false, pause: false } }, "*")}>Forge session message source</button>
      <button onClick={() => document.querySelector("iframe")?.contentWindow?.postMessage({ screenReuseProbe: true }, "*")}>Forge session message channel</button>
      <a href="?legacy">Legacy host fixture</a>
      <a href="?">Capable host fixture</a>
    </div>
    {!active && <p style={{ margin: 20 }}>Another route is active. The retained screen must be hidden and paused.</p>}
    <div id="fixture-sources" aria-label="Synthetic source canvases" style={{ padding: "0 20px" }} />
    <div style={{ padding: "0 20px", minHeight: 420 }}>
      <ScreenSessionSlot activeKey={active ? fixtureKey : undefined} selectedKey={selected}>
        {(_key, routeActive) => <Runtime value={connection}><Screen title="Screen reuse fixture" autoStart active={routeActive} /></Runtime>}
      </ScreenSessionSlot>
    </div>
    <pre aria-label="Fixture evidence" style={{ margin: 20, padding: 12, maxHeight: 360, overflow: "auto", fontSize: 12, background: "#f2f3f6", color: "#182036" }}>{JSON.stringify(output, null, 2)}</pre>
  </>;
}

createRoot(document.getElementById("root")!).render(<TooltipProvider><Fixture /></TooltipProvider>);
