import { ClickCounter, cursorCss, fusionInputMessage, mouseButton, namedKey, remoteModifiers, shortcutKey, textInput, wheelPixels, type ScreenInput, type ScreenPlatform } from "../core/screen-input";
import { fusionLayout, popupPlacement, windowPlacement, type FusionLayout } from "./sei";

/**
 * Fusion's hidden page in the desktop app (docs/v2/fusion.md §8.1). The main process speaks the
 * control protocol and owns window geometry; this page owns the one peer connection, opens a
 * frameless window per remote window (`window.open`, so it can draw into it directly) and sends
 * the person's input back with each window's stream key.
 */
interface Bridge {
  send(message: unknown): void;
  onMessage(listener: (message: HubMessage) => void): void;
  platform: string;
}
type Rect = { x: number; y: number; w: number; h: number };
type Chrome = { style?: string; toolbar?: boolean; buttons?: Partial<Record<"close" | "minimize" | "zoom", Rect>>; hitrects?: Rect[] };
type HubMessage = Record<string, unknown> & { t?: string };
type Lane = "input" | "pointer";

const bridge = (window as unknown as { linkshellFusionHub?: Bridge }).linkshellFusionHub;
const localPlatform: ScreenPlatform = bridge?.platform === "win32" ? "windows" : bridge?.platform === "darwin" ? "mac" : "other";
let remotePlatform: ScreenPlatform = "mac";

let pc: RTCPeerConnection | undefined;
let channels: Partial<Record<string, RTCDataChannel>> = {};
let trusted = false;
let controlAsked = false;
let eventNumber = 0;
let negotiating = false;
let pendingOffer: string | undefined;
let pendingCandidates: RTCIceCandidateInit[] = [];
let restarts: number[] = [];
const midToKey = new Map<string, string>();
const tracks = new Map<string, MediaStreamTrack>();
/** Per mid: the metadata of each frame, by RTP timestamp, until its picture is drawn. */
const layouts = new Map<string, Map<number, FusionLayout>>();
let displays: Array<{ index: number; frame: Rect }> = [];
const views = new Map<string, WindowView>();
const popups = new Map<number, PopupView>();
const popupInfo = new Map<number, { frame: Rect; parent: number }>();

const send = (message: HubMessage) => bridge?.send(message);
const rtc = (m: HubMessage) => send({ t: "rtc", m });
const keyOfMid = (mid: string | undefined) => (mid ? midToKey.get(mid) : undefined);
const midOfKey = (key: string) => [...midToKey.entries()].find(([, k]) => k === key)?.[0];

function post(key: string, event: ScreenInput, lane: Lane): void {
  const channel = channels[lane];
  if (!trusted || !channel || channel.readyState !== "open") return;
  if (channel.bufferedAmount > (lane === "pointer" ? 16_384 : 262_144)) return;
  eventNumber += 1;
  channel.send(JSON.stringify(fusionInputMessage(event, key, eventNumber)));
}

/** The remote pointer's pictures by id: each comes once, then only its id (as in screen sharing). */
const cursors = new Map<string, string>();

/** The remote says what its pointer looks like over a window: the pointer here wears it there. */
function shapeTold(message: HubMessage): void {
  if (message.t !== "shape" || typeof message.id !== "string" || message.id.length > 64) return;
  if (typeof message.png === "string" && message.png.length <= 1_400_000 && /^[A-Za-z0-9+/=]+$/.test(message.png)) {
    const [w, h, hotX, hotY, scale] = [message.w, message.h, message.hotX, message.hotY, message.scale].map(Number);
    if (w! > 0 && h! > 0 && w! <= 256 && h! <= 256 && Number.isFinite(hotX) && Number.isFinite(hotY)) {
      if (cursors.size >= 64) cursors.clear();
      cursors.set(message.id, cursorCss({ url: `data:image/png;base64,${message.png}`, w: w!, h: h!, hotX: hotX!, hotY: hotY!, scale: scale! }));
    }
  }
  const css = cursors.get(message.id);
  if (!css) return;
  const key = String(message.k ?? "");
  views.get(key)?.setCursor(css);
  for (const popup of popups.values()) if (popup.key === key) popup.setCursor(css);
}

function requestControl(): void {
  if (controlAsked || channels.input?.readyState !== "open" || ![...views.values()].some((view) => view.received)) return;
  controlAsked = true;
  rtc({ t: "control" });
}

// ── Peer connection ─────────────────────────────────────────────────────────

function resetPeer(): void {
  for (const view of views.values()) view.detach();
  for (const popup of popups.values()) popup.detach();
  pc?.close();
  pc = undefined;
  channels = {};
  trusted = false;
  controlAsked = false;
  negotiating = false;
  pendingOffer = undefined;
  pendingCandidates = [];
  midToKey.clear();
  tracks.clear();
  layouts.clear();
}

function createPeer(iceServers: RTCIceServer[]): void {
  if (pc) return;
  // `encodedInsertableStreams` is Chromium's: each receiver's encoded frames pass through this
  // page, which is where the crop metadata (an SEI) can be read. Without it there is no crop.
  const peer = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", encodedInsertableStreams: true } as RTCConfiguration);
  pc = peer;
  peer.onicecandidate = (event) => {
    if (event.candidate) rtc({ t: "ice", candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid ?? null, sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0 });
  };
  peer.ontrack = (event) => {
    const mid = event.transceiver.mid;
    if (!mid) return;
    tracks.set(mid, event.track);
    readMetadata(event.receiver, mid);
    reroute();
  };
  peer.ondatachannel = (event) => {
    const channel = event.channel;
    if (!["input", "pointer", "cursor", "shape"].includes(channel.label) || channels[channel.label]) return channel.close();
    channels[channel.label] = channel;
    if (channel.label === "shape") channel.onmessage = (event) => {
      if (peer !== pc || typeof event.data !== "string") return;
      try { shapeTold(JSON.parse(event.data) as HubMessage); } catch { /* A malformed shape changes nothing. */ }
    };
    channel.onopen = () => requestControl();
    if (channel.readyState === "open") requestControl();
  };
  peer.onconnectionstatechange = () => {
    if (peer !== pc) return;
    if (peer.connectionState === "connected") send({ t: "status", live: true });
    if (peer.connectionState === "failed") restartMedia("融合视频连接已中断");
  };
}

/** The remote makes a new peer connection when this one fails while the control link lives. */
function restartMedia(reason: string): void {
  const now = Date.now();
  restarts = restarts.filter((at) => now - at < 60_000);
  if (restarts.length >= 3) {
    send({ t: "status", mediaError: reason });
    return;
  }
  restarts.push(now);
  resetPeer();
  rtc({ t: "restart" });
}

function readMetadata(receiver: RTCRtpReceiver, mid: string): void {
  const encoded = (receiver as RTCRtpReceiver & { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } }).createEncodedStreams?.();
  if (!encoded) {
    send({ t: "status", mediaError: "此版本的窗口组件无法读取融合画面的裁剪信息" });
    return;
  }
  const map = layouts.get(mid) ?? new Map<number, FusionLayout>();
  layouts.set(mid, map);
  const transform = new TransformStream({
    transform(frame: RTCEncodedVideoFrame, controller) {
      const layout = fusionLayout(new Uint8Array(frame.data));
      if (layout) {
        const metadata = frame.getMetadata() as RTCEncodedVideoFrameMetadata & { rtpTimestamp?: number };
        const timestamp = metadata.rtpTimestamp ?? (frame as unknown as { timestamp: number }).timestamp;
        map.set(timestamp, layout);
        if (map.size > 120) map.delete(map.keys().next().value!);
        const key = keyOfMid(mid);
        if (key?.startsWith("d") && Array.isArray(layout[0])) showPopups(Number(key.slice(1)), layout as number[][]);
      }
      controller.enqueue(frame);
    },
  });
  void encoded.readable.pipeThrough(transform).pipeTo(encoded.writable).catch(() => undefined);
}

async function acceptOffer(sdp: string): Promise<void> {
  const peer = pc;
  if (!peer) return;
  negotiating = true;
  try {
    await peer.setRemoteDescription({ type: "offer", sdp });
    for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate).catch(() => undefined);
    // The remote encodes H.264 only: its SEI is where the crop is.
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const preferred = [...codecs.filter((c) => /h264/i.test(c.mimeType)), ...codecs.filter((c) => !/h264|flexfec/i.test(c.mimeType))];
    for (const transceiver of peer.getTransceivers()) {
      try { transceiver.setCodecPreferences(preferred); } catch { /* A stopped transceiver keeps what it had. */ }
    }
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (peer === pc) rtc({ t: "answer", sdp: answer.sdp ?? "" });
  } catch {
    // No answer would leave the remote waiting for one, and no window would get a picture again.
    negotiating = false;
    restartMedia("融合视频格式协商失败");
    return;
  } finally {
    negotiating = false;
  }
  reroute();
  const next = pendingOffer;
  pendingOffer = undefined;
  if (next) await acceptOffer(next);
}

function onRtc(m: HubMessage): void {
  switch (m.t) {
    case "config": return createPeer(((m.iceServers as RTCIceServer[]) ?? []).slice(0, 16));
    case "streams":
      for (const entry of (m.streams as Array<{ k: string; mid: string }>) ?? []) {
        for (const [mid, key] of midToKey) if (key === entry.k) midToKey.delete(mid);
        midToKey.set(entry.mid, entry.k);
      }
      return reroute();
    case "offer":
      if (typeof m.sdp !== "string") return;
      if (negotiating) pendingOffer = m.sdp;
      else void acceptOffer(m.sdp);
      return;
    case "ice": {
      const candidate = { candidate: String(m.candidate ?? ""), sdpMid: (m.sdpMid as string | null) ?? null, sdpMLineIndex: Number(m.sdpMLineIndex ?? 0) };
      if (pc?.remoteDescription) void pc.addIceCandidate(candidate).catch(() => undefined);
      else if (pendingCandidates.length < 256) pendingCandidates.push(candidate);
      return;
    }
    case "control":
      trusted = m.available === true && m.trusted === true;
      if (!trusted) send({ t: "status", controlError: "远端电脑尚未允许控制，请在该电脑授予辅助功能权限后重试" });
      return;
    default:
      return;
  }
}

/** A transceiver can carry a later window after its first one closed: follow the latest map. */
function reroute(): void {
  for (const view of views.values()) {
    const mid = midOfKey(view.key);
    const track = mid ? tracks.get(mid) : undefined;
    if (mid && track) view.attach(mid, track);
  }
  for (const popup of popups.values()) {
    const mid = midOfKey(popup.key);
    const track = mid ? tracks.get(mid) : undefined;
    if (mid && track) popup.attach(mid, track);
  }
}

// ── Input shared by windows and popups ──────────────────────────────────────

abstract class Surface {
  mid?: string;
  received = false;
  readonly video: HTMLVideoElement;
  protected readonly clicks = new ClickCounter();
  protected readonly held = new Set<string>();
  private pendingMove?: { x: number; y: number };
  private moveFrame = 0;
  private callback = 0;

  constructor(readonly key: string, readonly win: Window) {
    const doc = win.document;
    doc.documentElement.style.cssText = "margin:0;height:100%;background:transparent;overflow:hidden";
    doc.body.style.cssText = "margin:0;height:100%;overflow:hidden;background:#000;user-select:none;cursor:default";
    this.video = doc.createElement("video");
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none";
    doc.body.appendChild(this.video);
    doc.addEventListener("pointermove", (event) => this.pointerMove(event));
    doc.addEventListener("pointerdown", (event) => this.pointerDown(event));
    doc.addEventListener("pointerup", (event) => this.pointerUp(event));
    doc.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    doc.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /** The remote's fraction (its `Control` bounds) for a point in this window. */
  protected abstract fraction(clientX: number, clientY: number): { x: number; y: number };
  protected abstract placed(layout: FusionLayout): void;
  protected intercept(_event: PointerEvent): boolean { return false; }
  protected pressed(): void {}

  attach(mid: string, track: MediaStreamTrack): void {
    if (this.mid === mid && (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0] === track) return;
    this.mid = mid;
    this.video.srcObject = new MediaStream([track]);
    void this.video.play().catch(() => undefined);
    if (this.callback) this.video.cancelVideoFrameCallback(this.callback);
    const next = (_now: number, metadata: VideoFrameCallbackMetadata & { rtpTimestamp?: number }) => {
      const layout = metadata.rtpTimestamp !== undefined ? layouts.get(mid)?.get(metadata.rtpTimestamp) : undefined;
      if (layout) this.placed(layout);
      if (!this.received) {
        this.received = true;
        requestControl();
      }
      this.callback = this.video.requestVideoFrameCallback(next);
    };
    this.callback = this.video.requestVideoFrameCallback(next);
  }

  detach(): void {
    this.video.srcObject = null;
    this.mid = undefined;
  }

  setCursor(css: string): void {
    if (!this.win.closed) this.win.document.body.style.cursor = css;
  }

  private pointerMove(event: PointerEvent): void {
    this.pendingMove = this.fraction(event.clientX, event.clientY);
    if (this.moveFrame) return;
    this.moveFrame = this.win.requestAnimationFrame(() => {
      this.moveFrame = 0;
      const move = this.pendingMove;
      this.pendingMove = undefined;
      if (move) post(this.key, { t: "move", ...move }, this.held.size ? "input" : "pointer");
    });
  }

  private pointerDown(event: PointerEvent): void {
    if (this.intercept(event)) return;
    const button = mouseButton(event.button);
    if (!button) return;
    event.preventDefault();
    (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
    const at = this.fraction(event.clientX, event.clientY);
    post(this.key, { t: "move", ...at }, "input");
    const clicks = this.clicks.down(button, event.clientX, event.clientY, event.timeStamp);
    const m = remoteModifiers(event, localPlatform, remotePlatform);
    this.held.add(button);
    post(this.key, { t: "down", b: button, n: clicks, ...(m.length ? { m } : {}) }, "input");
    this.pressed();
  }

  private pointerUp(event: PointerEvent): void {
    const button = mouseButton(event.button);
    if (!button || !this.held.delete(button)) return;
    const at = this.fraction(event.clientX, event.clientY);
    post(this.key, { t: "move", ...at }, "input");
    const m = remoteModifiers(event, localPlatform, remotePlatform);
    post(this.key, { t: "up", b: button, n: this.clicks.current(button), ...(m.length ? { m } : {}) }, "input");
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const { dx, dy } = wheelPixels(event);
    if (!dx && !dy) return;
    post(this.key, { t: "move", ...this.fraction(event.clientX, event.clientY) }, "input");
    const m = remoteModifiers(event, localPlatform, remotePlatform);
    post(this.key, { t: "scroll", dx: Math.round(dx), dy: Math.round(dy), ...(m.length ? { m } : {}) }, "input");
  }

  /** Nothing stays pressed on the remote when this window goes. */
  releaseAll(): void {
    for (const button of this.held) post(this.key, { t: "up", b: button as "left" | "right" }, "input");
    this.held.clear();
  }
}

// ── A remote window ─────────────────────────────────────────────────────────

class WindowView extends Surface {
  private readonly ime: HTMLTextAreaElement;
  private readonly drag: HTMLDivElement;
  private composing = false;
  /** The remote window's size from its latest frame: clicks are fractions of it, not of this window. */
  private remoteSize?: { w: number; h: number };
  chrome: Chrome = {};

  constructor(readonly id: number, key: string, win: Window, chrome: Chrome, title: string) {
    super(key, win);
    const doc = win.document;
    doc.title = title;
    this.drag = doc.createElement("div");
    this.drag.style.cssText = "position:fixed;left:0;top:0;right:0;-webkit-app-region:drag;z-index:2";
    doc.body.appendChild(this.drag);
    // Text arrives here (IME included); shortcuts are read from its key events.
    this.ime = doc.createElement("textarea");
    this.ime.setAttribute("aria-hidden", "true");
    this.ime.style.cssText = "position:fixed;left:-20px;top:0;width:1px;height:1px;opacity:0";
    doc.body.appendChild(this.ime);
    this.ime.addEventListener("keydown", (event) => this.keyDown(event));
    this.ime.addEventListener("compositionstart", () => { this.composing = true; });
    this.ime.addEventListener("compositionend", () => { this.composing = false; this.flushText(); });
    this.ime.addEventListener("input", () => { if (!this.composing) this.flushText(); });
    win.addEventListener("focus", () => this.ime.focus());
    win.addEventListener("blur", () => this.releaseAll());
    this.ime.focus();
    this.setChrome(chrome);
  }

  setChrome(chrome: Chrome): void {
    this.chrome = chrome ?? {};
    const doc = this.win.document;
    const buttons = Object.values(this.chrome.buttons ?? {}).filter(Boolean) as Rect[];
    // The title bar band: the Mac's (taller with a toolbar) or the height of Windows' caption buttons.
    const band = this.chrome.style === "windows"
      ? Math.max(24, ...buttons.map((b) => b.y + b.h))
      : this.chrome.toolbar ? 52 : 28;
    this.drag.style.height = `${band}px`;
    this.drag.replaceChildren(...[...buttons, ...(this.chrome.hitrects ?? [])].map((r) => {
      const hole = doc.createElement("div");
      hole.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;-webkit-app-region:no-drag`;
      return hole;
    }));
  }

  protected fraction(clientX: number, clientY: number) {
    // The picture is drawn at the remote window's size: until the remote takes this window's size,
    // a point here is that far into the remote window, whatever this window's size.
    const w = Math.max(1, this.remoteSize?.w ?? this.win.innerWidth), h = Math.max(1, this.remoteSize?.h ?? this.win.innerHeight);
    return { x: Math.min(1, Math.max(0, clientX / w)), y: Math.min(1, Math.max(0, clientY / h)) };
  }

  protected placed(layout: FusionLayout): void {
    if (!Array.isArray(layout) || typeof layout[0] !== "number") return;
    const values = layout as number[];
    // Frames a reused transceiver still carries from the window before this one.
    if (values.length >= 15 && values[14] !== this.id) return;
    const at = windowPlacement(values);
    if (!at) return;
    if (values[2]! > 0 && values[3]! > 0) this.remoteSize = { w: values[2]!, h: values[3]! };
    const style = this.video.style;
    style.width = `${at.width}px`;
    style.height = `${at.height}px`;
    style.transform = `translate(${at.left}px, ${at.top}px)`;
  }

  /** A press may open a menu: the remote warms its popup layer up from 2 fps. */
  protected pressed(): void { send({ t: "action", id: this.id, what: "prewarm" }); }

  /** The window buttons drawn in the picture act here: close asks the remote, the others are local. */
  protected intercept(event: PointerEvent): boolean {
    if (event.button !== 0) return false;
    for (const [what, r] of Object.entries(this.chrome.buttons ?? {})) {
      if (!r) continue;
      if (event.clientX >= r.x && event.clientX <= r.x + r.w && event.clientY >= r.y && event.clientY <= r.y + r.h) {
        event.preventDefault();
        send({ t: "action", id: this.id, what });
        return true;
      }
    }
    return false;
  }

  private keyDown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    const m = remoteModifiers(event, localPlatform, remotePlatform);
    const command = m.some((modifier) => modifier !== "shift");
    // AltGr characters (Ctrl+Alt on Windows) are text, not shortcuts.
    if (localPlatform === "windows" && event.ctrlKey && event.altKey && event.key.length === 1) return;
    const name = command ? shortcutKey(event) : namedKey(event);
    if (!name) return;
    event.preventDefault();
    post(this.key, { t: "key", k: name, ...(m.length ? { m } : {}) }, "input");
  }

  private flushText(): void {
    const text = this.ime.value;
    this.ime.value = "";
    if (text) for (const event of textInput(text)) post(this.key, event, "input");
  }
}

// ── A popup (menu, tooltip) cut from its display's layer ────────────────────

class PopupView extends Surface {
  frame: Rect;
  seen = Date.now();

  constructor(readonly id: number, readonly index: number, win: Window, frame: Rect) {
    super(`d${index}`, win);
    this.frame = frame;
    this.win.document.body.style.background = "transparent";
  }

  private get display(): Rect | undefined { return displays.find((d) => d.index === this.index)?.frame; }

  protected fraction(clientX: number, clientY: number) {
    const d = this.display;
    if (!d) return { x: 0, y: 0 };
    return { x: Math.min(1, Math.max(0, (this.frame.x + clientX - d.x) / d.w)), y: Math.min(1, Math.max(0, (this.frame.y + clientY - d.y) / d.h)) };
  }

  protected placed(layout: FusionLayout): void {
    if (!Array.isArray(layout[0])) return;
    const entry = (layout as number[][]).find((e) => e[0] === this.id);
    const d = this.display;
    if (!entry || !d) return;
    this.frame = { x: entry[2]!, y: entry[3]!, w: entry[4]!, h: entry[5]! };
    const at = popupPlacement(this.frame, d);
    const style = this.video.style;
    style.width = `${at.width}px`;
    style.height = `${at.height}px`;
    style.transform = `translate(${at.left}px, ${at.top}px)`;
  }
}

function showPopups(index: number, list: number[][]): void {
  const now = Date.now();
  for (const entry of list) {
    const id = entry[0]!;
    if (!popupInfo.has(id)) continue;
    const frame = { x: entry[2]!, y: entry[3]!, w: entry[4]!, h: entry[5]! };
    const existing = popups.get(id);
    if (existing && !existing.win.closed) { existing.seen = now; continue; }
    const win = window.open("", `p${id}`, "");
    if (!win) continue;
    const popup = new PopupView(id, index, win, frame);
    popups.set(id, popup);
    const mid = midOfKey(popup.key);
    const track = mid ? tracks.get(mid) : undefined;
    if (mid && track) popup.attach(mid, track);
  }
  // A popup missing from its layer for a moment is gone (the menu closed).
  for (const [id, popup] of popups) {
    if (popup.index === index && now - popup.seen > 150) closePopup(id);
  }
}

function closePopup(id: number): void {
  const popup = popups.get(id);
  popups.delete(id);
  popup?.releaseAll();
  if (popup && !popup.win.closed) popup.win.close();
}

// ── Messages from the main process ──────────────────────────────────────────

bridge?.onMessage((message) => {
  switch (message.t) {
    case "reset":
      remotePlatform = message.remote === "windows" ? "windows" : "mac";
      resetPeer();
      return;
    case "pause":
      resetPeer();
      return;
    case "rtc":
      return onRtc((message.m ?? {}) as HubMessage);
    case "displays":
      displays = (message.displays as typeof displays) ?? [];
      return;
    case "open": {
      const id = Number(message.id);
      const key = String(message.key ?? `w${id}`);
      const existing = views.get(key);
      if (existing && !existing.win.closed) {
        existing.setChrome((message.chrome as Chrome) ?? {});
        return reroute();
      }
      const win = window.open("", `w${id}`, "");
      if (!win) return;
      views.set(key, new WindowView(id, key, win, (message.chrome as Chrome) ?? {}, String(message.title ?? "")));
      return reroute();
    }
    case "chrome":
      views.get(String(message.key))?.setChrome((message.chrome as Chrome) ?? {});
      return;
    case "close": {
      const key = String(message.key);
      const view = views.get(key);
      views.delete(key);
      view?.releaseAll();
      view?.detach();
      return;
    }
    case "popups":
      popupInfo.clear();
      for (const p of (message.popups as Array<{ id: number; frame: Rect; parent: number }>) ?? []) popupInfo.set(p.id, { frame: p.frame, parent: p.parent });
      for (const id of [...popups.keys()]) if (!popupInfo.has(id)) closePopup(id);
      return;
    case "popup.close":
      closePopup(Number(message.id));
      return;
    default:
      return;
  }
});

send({ t: "ready" });
