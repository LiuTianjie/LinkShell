import type { HostLink, HostStreams } from "@linkshell/client-core";
import { openWebSocket } from "./transport";
import { ScreenGate, type ScreenTarget } from "./screen-gate";
import type { Modifier, ScreenInput } from "./screen-input";

/**
 * The desktop window's own receiver of a computer's screen: the same protocol the host's viewer
 * page speaks (packages/host/src/screen.ts, screen-viewer.ts), without the page. The workspace
 * opens the host's `/stream` socket through its encrypted streams; the computer's app offers the
 * picture as a WebRTC video track straight to this window, with channels beside it for the hands
 * and the pointer. Where no direct path is found the host sends the picture down the socket
 * instead (H.264, or JPEG from a Windows computer), decoded here onto a canvas.
 *
 * Nothing from the host is run: its messages are bounded JSON, checked field by field, and the
 * video stays in the media pipeline. Frames never pass through React.
 */

export const SCREEN_TAKEN = "屏幕画面被另一台设备接手了";

export type ScreenPhase = "starting" | "connecting" | "receiving" | "live" | "recovering" | "paused" | "error";

export interface ScreenStats {
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrateMbps?: number;
  rttMs?: number;
  /** "lan" (both ends on one network), "direct" (across NATs), "relay" (a TURN server), "socket" (through the host's stream). */
  path?: "lan" | "direct" | "relay" | "socket";
  decoder?: string;
  hardware?: boolean;
  jitterMs?: number;
}

export interface ControlState { known: boolean; available: boolean; trusted: boolean; reason?: string; app?: string }
/** The computer's pointer picture: its size and hot spot in points, `scale` pixels of the PNG to a point. */
export interface CursorShape { id: string; url: string; w: number; h: number; hotX: number; hotY: number; scale: number }

export interface ReceiverState {
  phase: ScreenPhase;
  error?: string;
  /** Another device took the screen over. */
  taken: boolean;
  /** How the picture comes now: a video track, or the host's socket. */
  transport?: "video" | "socket";
  displays: { index: number; name: string }[];
  display: number;
  picture?: { width: number; height: number };
  stats?: ScreenStats;
  control: ControlState;
  /** Mouse and keys go to the computer now. */
  canInput: boolean;
  /** A short notice the screen shows for a moment (the path changed, a setting did not apply). */
  notice?: string;
  shape?: CursorShape;
  /** The width the host last confirmed, in pixels. */
  appliedWidth?: number;
  /** The host can change the picture on the same connection (display, width, frame rate, pause). */
  configurable: boolean;
}

export interface ReceiverOptions {
  link: HostLink;
  streams: HostStreams;
  target: Omit<ScreenTarget, "paused">;
  active: boolean;
  control: boolean;
  hevc: boolean;
  /** The workspace reaches this computer through a gateway: the host's own fallback is then lighter. */
  relayed: boolean;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onState(state: ReceiverState): void;
  /** Where the computer's pointer is, as a fraction of the picture. Many times a second: kept out of React. */
  onCursor(x: number, y: number): void;
}

type Socket = Awaited<ReturnType<typeof openWebSocket>>;
type Lane = "input" | "pointer";

const MAX_MESSAGE = 262_144;
/** How long a path may take to be found: a phone on cellular can take well over 8 s, a desktop rarely does. */
const PATIENCE_MS = 25_000;
/** From asking for the screen to the first picture, whichever way it comes. */
const FIRST_PICTURE_MS = 45_000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function fraction(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}
const round = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? undefined : +value.toFixed(digits);

/** The SPS of an H.264 access unit (Annex B), for the decoder's codec string. */
function sps(unit: Uint8Array): Uint8Array | undefined {
  for (let i = 0; i + 3 < unit.length; i++)
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1 && (unit[i + 3] & 0x1f) === 7) return unit.subarray(i + 3);
  return undefined;
}
const hex = (value: number) => value.toString(16).padStart(2, "0");

export class ScreenReceiver {
  state: ReceiverState;
  private readonly gate = new ScreenGate();
  private readonly options: ReceiverOptions;
  private target: Omit<ScreenTarget, "paused">;
  private active: boolean;
  private controlWanted: boolean;
  private closed = false;
  private socket?: Socket;
  private socketOpen = false;
  private readonly outgoing: string[] = [];
  private port = 0;
  private pc?: RTCPeerConnection;
  private channels: Record<string, RTCDataChannel> = {};
  private described: Promise<void> = Promise.resolve();
  private connectedOnce = false;
  private gaveUp = false;
  private tried = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private patience?: ReturnType<typeof setTimeout>;
  private away?: ReturnType<typeof setTimeout>;
  private firstPicture?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private controlAsked = false;
  // Input: one count across both channels (see the Mac app's ScreenSession), the buttons held, the pointer's path.
  private sent = 0;
  private readonly held = new Map<string, ScreenInput & { t: "down" }>();
  private pendingMove?: { x: number; y: number };
  private moveFrame = 0;
  private lastLane: Lane = "input";
  private rest?: ReturnType<typeof setTimeout>;
  private movedAt = -Infinity;
  private readonly trail: { x: number; y: number; t: number }[] = [];
  private cursorNumber = 0;
  private readonly shapes = new Map<string, CursorShape>();
  // The socket's picture.
  private decoder?: VideoDecoder;
  private skipping = false;
  private keyAsked = -Infinity;
  private decodeFailures = 0;
  private jpegPending?: { seq: number; unit: Uint8Array };
  private jpegDrawing = false;
  private lastShown = 0;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private socketFrames = 0;
  private socketBytes = 0;
  private statsBefore?: { at: number; frames: number; bytes: number; raw?: Record<string, unknown> };
  private readonly context: CanvasRenderingContext2D | null;
  private frameCallback?: number;

  constructor(options: ReceiverOptions) {
    this.options = options;
    this.target = options.target;
    this.active = options.active;
    this.controlWanted = options.control;
    this.context = options.canvas.getContext("2d");
    this.state = {
      phase: "starting", taken: false, displays: [], display: options.target.display,
      control: { known: false, available: false, trusted: false }, canInput: false, configurable: false,
    };
    const video = options.video;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("resize", this.sized);
    video.addEventListener("loadedmetadata", this.sized);
    // A frame on screen is what says the picture is there; metadata and a connected path don't.
    video.addEventListener("playing", this.videoShown);
    if (typeof video.requestVideoFrameCallback === "function") {
      const next = () => {
        if (this.closed) return;
        this.videoShown();
        this.frameCallback = video.requestVideoFrameCallback(next);
      };
      this.frameCallback = video.requestVideoFrameCallback(next);
    }
    void this.start();
  }

  // ── Life ────────────────────────────────────────────────────────────────────────────────

  private set(next: Partial<ReceiverState>) {
    if (this.closed) return;
    const state = { ...this.state, ...next };
    state.canInput = this.inputAllowed(state);
    this.state = state;
    this.options.onState(state);
  }

  private inputAllowed(state: ReceiverState): boolean {
    return this.active && this.controlWanted && this.gate.allowsInput && state.control.available && state.control.trusted
      && !!state.picture && (state.phase === "live" || state.phase === "receiving");
  }

  private later(ms: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) action(); }, ms);
    this.timers.add(timer);
    return timer;
  }
  private cancel(timer: ReturnType<typeof setTimeout> | undefined) {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private async start() {
    this.firstPicture = this.later(FIRST_PICTURE_MS, () => {
      if (!this.state.picture && this.active) this.fail("画面一直没有出现。请确认电脑在线、已允许屏幕录制，然后重新连接。");
    });
    let viewer: { port: number; token: string; displays: { index: number; name: string }[] };
    try {
      viewer = await this.options.link.call("screen.start", {}, 20_000);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    if (this.closed) return;
    this.port = viewer.port;
    const displays = viewer.displays.slice(0, 16).map((entry) => ({ index: entry.index, name: String(entry.name).slice(0, 80) }));
    if (displays.length && !displays.some((entry) => entry.index === this.target.display)) this.target = { ...this.target, display: displays[0].index };
    this.set({ phase: "connecting", displays, display: this.target.display });
    const query = new URLSearchParams({
      token: viewer.token, display: String(this.target.display), width: String(this.target.width),
      maxFps: String(this.target.maxFps), video: "1",
    });
    if (this.options.hevc) query.set("codec", "hevc");
    if (this.options.relayed) query.set("q", "low");
    try {
      const socket = await openWebSocket(this.options.streams, this.port, "/stream?" + query, {
        open: () => {
          this.socketOpen = true;
          for (const message of this.outgoing.splice(0)) this.socket?.send(message);
          // A host from before capabilities says nothing of them.
          this.later(10_000, () => { if (!this.gate.capabilitiesKnown) { this.gate.assumeLegacy(); this.afterGate(); } });
        },
        data: (data) => this.received(data),
        close: (reason) => {
          if (this.closed) return;
          this.socketOpen = false;
          this.fail(this.state.taken ? SCREEN_TAKEN : reason || "屏幕连接已断开，请确认电脑在线后重新连接。");
        },
      });
      if (this.closed) socket.close();
      else this.socket = socket;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Ends everything; nothing is told afterwards. */
  stop() {
    if (this.closed) return;
    this.releaseAll();
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearInterval(this.statsTimer);
    clearTimeout(this.ackTimer);
    cancelAnimationFrame(this.moveFrame);
    this.dropPeer();
    this.socket?.close();
    this.socket = undefined;
    try { this.decoder?.close(); } catch { /* Already closed. */ }
    this.decoder = undefined;
    const video = this.options.video;
    video.removeEventListener("resize", this.sized);
    video.removeEventListener("loadedmetadata", this.sized);
    video.removeEventListener("playing", this.videoShown);
    if (this.frameCallback !== undefined && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(this.frameCallback);
    video.srcObject = null;
  }

  private fail(message: string) {
    if (this.closed) return;
    const taken = this.state.taken || message === SCREEN_TAKEN;
    this.releaseAll();
    this.set({ phase: "error", error: message.slice(0, 600), taken });
    // The error is the last word: the connection behind it is ended.
    this.stop();
  }

  // ── What the host says ──────────────────────────────────────────────────────────────────

  private received(data: string | ArrayBuffer) {
    if (this.closed) return;
    if (typeof data !== "string") return this.frame(data);
    if (data.length > MAX_MESSAGE) return;
    let message: Record<string, unknown> | undefined;
    try { message = object(JSON.parse(data)); } catch { return; }
    if (!message) return;
    const session = object(message.session);
    if (session) return this.sessionMessage(session);
    if (typeof message.error === "string") {
      if (message.error === SCREEN_TAKEN) this.state = { ...this.state, taken: true };
      return this.fail(message.error);
    }
    const rtc = object(message.rtc);
    if (rtc) return this.signal(rtc);
    if (message.restart) {
      // The host starts the socket's stream again at another quality: a new decoder for it.
      this.resetDecoder();
      this.shownUpTo(this.lastShown);
      if (message.lighter === true) this.notice("网络较慢：已降低画质，优先保证跟得上");
    }
    const control = object(message.control);
    if (control) {
      const next: ControlState = {
        known: true,
        available: control.available === true,
        trusted: control.trusted === true,
        reason: typeof control.reason === "string" ? control.reason.slice(0, 400) : undefined,
        app: typeof control.app === "string" ? control.app.slice(0, 80) : undefined,
      };
      if (!next.trusted) this.releaseAll();
      this.set({ control: next });
    }
    const cursor = object(message.cursor);
    if (cursor) {
      const x = fraction(cursor.x), y = fraction(cursor.y);
      if (x !== undefined && y !== undefined) this.echo(x, y);
    }
  }

  private sessionMessage(session: Record<string, unknown>) {
    if (session.t === "capabilities") {
      if (this.gate.capabilities(session)) this.configure();
      this.set({ configurable: this.gate.canConfigure });
      this.afterGate();
    } else if (session.t === "configured") {
      if (!this.gate.configured(session)) return;
      // A new generation: control is asked for again with it.
      this.controlAsked = false;
      this.set({ appliedWidth: finite(session.width), display: this.gate.current?.display ?? this.target.display, phase: this.resumedPhase() });
      this.afterGate();
    } else if (session.t === "error") {
      const reason = this.gate.failed(session);
      if (!reason) return;
      this.notice(reason);
      this.set({});
    }
  }

  private resumedPhase(): ScreenPhase {
    if (!this.active) return "paused";
    if (this.state.picture) return this.state.phase === "recovering" ? "recovering" : "live";
    return this.state.phase === "paused" || this.state.phase === "starting" ? "receiving" : this.state.phase;
  }

  /** Input may go now: control is asked for, where it is wanted. */
  private afterGate() {
    this.askControl();
    this.set({});
  }

  private askControl() {
    if (!this.controlWanted || this.controlAsked || !this.gate.allowsInput || !this.active) return;
    this.controlAsked = true;
    this.sendSocket(this.gate.stamp({ t: "control" }));
  }

  private configure() {
    if (!this.gate.canConfigure) return;
    this.sendSocket(this.gate.request({ ...this.target, paused: !this.active }));
    this.set({});
  }

  private notice(text: string) {
    this.set({ notice: text });
    this.later(4200, () => { if (this.state.notice === text) this.set({ notice: undefined }); });
  }

  private sendSocket(message: object) {
    const text = JSON.stringify(message);
    if (text.length > MAX_MESSAGE) return;
    if (this.socket && this.socketOpen) this.socket.send(text);
    else if (this.outgoing.length < 128) this.outgoing.push(text);
  }

  // ── The video track ─────────────────────────────────────────────────────────────────────

  private signal(rtc: Record<string, unknown>) {
    if (rtc.t === "off") return this.fallBack();
    if (this.gaveUp) return;
    if (rtc.t === "config") return this.createPeer(rtc.iceServers);
    const pc = this.pc;
    if (!pc) return;
    if (rtc.t === "offer" && typeof rtc.sdp === "string" && rtc.sdp.length < 128_000) {
      this.tried = true;
      this.patience = this.later(PATIENCE_MS, () => this.patient(pc));
      this.described = pc.setRemoteDescription({ type: "offer", sdp: rtc.sdp })
        .then(() => { this.preferCodecs(pc); return pc.createAnswer(); })
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => { if (this.pc === pc && pc.localDescription) this.sendSocket({ t: "rtc.answer", sdp: pc.localDescription.sdp }); });
      this.described.catch((error: unknown) => { if (this.pc === pc) this.giveUp("the offer could not be answered: " + (error instanceof Error ? error.message : String(error))); });
    } else if (rtc.t === "ice" && typeof rtc.candidate === "string" && rtc.candidate.length < 8192) {
      const index = finite(rtc.sdpMLineIndex);
      const candidate = { candidate: rtc.candidate, sdpMid: typeof rtc.sdpMid === "string" ? rtc.sdpMid.slice(0, 64) : null, sdpMLineIndex: index === undefined ? null : index };
      // A candidate that comes before the offer is in place waits for it.
      this.described.then(() => this.pc === pc ? pc.addIceCandidate(candidate) : undefined).catch(() => {});
    }
  }

  private createPeer(servers: unknown) {
    this.dropPeer();
    const iceServers = (Array.isArray(servers) ? servers : []).slice(0, 8).flatMap((server): RTCIceServer[] => {
      const entry = object(server);
      const urls = (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]).filter((url): url is string =>
        typeof url === "string" && url.length <= 1024 && /^(stuns?|turns?):/.test(url));
      return urls.length ? [{ urls }] : [];
    });
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" }); }
    catch (error) { return this.giveUp("the receiver could not start: " + (error instanceof Error ? error.message : String(error))); }
    this.pc = pc;
    this.channels = {};
    this.connectedOnce = false;
    pc.onicecandidate = ({ candidate }) => {
      // The empty one only says there are no more.
      if (candidate?.candidate) this.sendSocket({ t: "rtc.ice", candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null });
    };
    pc.ontrack = ({ receiver, track, streams }) => {
      // No waiting beyond what decoding takes: the sender's playout-delay header asks the same.
      const tuning = receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
      try { if ("jitterBufferTarget" in tuning) tuning.jitterBufferTarget = 0; } catch { /* Older engines. */ }
      try { if ("playoutDelayHint" in tuning) tuning.playoutDelayHint = 0; } catch { /* Older engines. */ }
      const video = this.options.video;
      video.srcObject = streams[0] ?? new MediaStream([track]);
      void video.play().catch(() => {});
    };
    pc.ondatachannel = ({ channel }) => {
      if (!["input", "pointer", "cursor", "shape"].includes(channel.label) || this.channels[channel.label]) { channel.close(); return; }
      this.channels[channel.label] = channel;
      if (channel.label === "cursor" || channel.label === "shape") channel.onmessage = (event) => {
        if (this.pc !== pc || typeof event.data !== "string" || event.data.length > 1_500_000) return;
        try {
          const message = object(JSON.parse(event.data));
          if (message?.t === channel.label) this.told(message);
        } catch { /* Not one of the app's. */ }
      };
      channel.onclose = () => { if (this.pc === pc && channel.label === "input" && !this.gaveUp) this.giveUp("the input channel closed"); };
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => { if (this.pc === pc) this.watch(pc); };
  }

  /**
   * H.265 first where it was asked for, then H.264; the sender's other codecs after. No FlexFEC,
   * as the phone and the Mac's own receiver answer: it takes bitrate for a recovery not shown to help.
   */
  private preferCodecs(pc: RTCPeerConnection) {
    const transceiver = pc.getTransceivers().find((entry) => entry.receiver.track?.kind === "video");
    if (!transceiver?.setCodecPreferences) return;
    try {
      const codecs = (RTCRtpReceiver.getCapabilities("video")?.codecs ?? []).filter((codec) => codec.mimeType.toLowerCase() !== "video/flexfec-03");
      const rank = (mime: string) => mime === "video/h265" ? (this.options.hevc ? 0 : 1) : mime === "video/h264" ? (this.options.hevc ? 1 : 0) : 2;
      const ordered = [...codecs].sort((a, b) => rank(a.mimeType.toLowerCase()) - rank(b.mimeType.toLowerCase()));
      if (ordered.some((codec) => ["video/h264", "video/h265"].includes(codec.mimeType.toLowerCase()))) transceiver.setCodecPreferences(ordered);
    } catch { /* The browser's own order stands. */ }
  }

  private watch(pc: RTCPeerConnection) {
    // The whole connection's state where the engine has one: a path found is not yet a connection made.
    const state: string = pc.connectionState || pc.iceConnectionState;
    if (state === "failed" || pc.iceConnectionState === "failed") return this.giveUp(this.connectedOnce ? "the connection failed" : "no path between the two (ICE failed)");
    if (state === "disconnected") {
      if (this.state.picture) this.set({ phase: "recovering" });
      // A path that drops for a moment comes back by itself; one gone for longer is given up.
      if (this.connectedOnce && !this.away) this.away = this.later(4000, () => { this.away = undefined; if (this.pc === pc && this.active) this.giveUp("disconnected for more than 4 s"); });
    } else if (state === "connected" || state === "completed") {
      this.cancel(this.away);
      this.away = undefined;
      if (this.state.phase === "recovering") this.set({ phase: this.state.picture ? "live" : "receiving" });
      if (this.connectedOnce) return;
      this.connectedOnce = true;
      this.cancel(this.patience);
      if (!this.state.picture) {
        this.set({ phase: "receiving" });
        this.patience = this.later(4000, () => this.frameless(pc));
      }
    }
  }

  private patient(pc: RTCPeerConnection) {
    if (this.pc !== pc) return;
    if (!this.active) this.patience = this.later(PATIENCE_MS, () => this.patient(pc));
    else if (!this.connectedOnce) this.giveUp(`not connected within ${PATIENCE_MS / 1000} s of the offer`);
  }

  private frameless(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.state.picture) return;
    // A screen nobody is looking at is sent nothing: that is not the path's doing.
    if (!this.active) this.patience = this.later(4000, () => this.frameless(pc));
    else this.giveUp("connected, but no frame within 4 s");
  }

  /** The track is not getting across: the host is asked for the picture down the socket instead. */
  private giveUp(reason: string) {
    if (this.gaveUp || this.closed) return;
    this.gaveUp = true;
    this.set({ phase: "recovering" });
    const pc = this.pc;
    const told = (detail: string) => {
      this.dropPeer();
      // The host's log says why, whichever way the picture goes next.
      if (detail) this.sendSocket({ t: "rtc.diagnosis", reason, ice: detail });
      this.sendSocket({ t: "rtc.failed", reason: detail ? `${reason} (${detail})` : reason });
    };
    if (pc) void iceSummary(pc).then(told, () => told(""));
    else told("");
  }

  /** From here on the picture comes down the socket. */
  private fallBack() {
    const wasLive = this.state.transport === "video";
    this.gaveUp = true;
    this.dropPeer();
    this.set({ phase: this.state.picture ? "recovering" : "receiving" });
    if (typeof VideoDecoder === "undefined") return this.fail("这个系统版本的浏览器内核不支持视频解码，请更新 LinkShell 后重试。");
    if (this.tried) this.notice(wasLive ? "直连断开了：已改用兼容方式传画面，延迟会高一些" : "没能和电脑直连：已改用兼容方式传画面，延迟会高一些");
  }

  private dropPeer() {
    this.cancel(this.patience);
    this.cancel(this.away);
    this.away = undefined;
    const pc = this.pc;
    if (!pc) return;
    this.pc = undefined;
    for (const channel of Object.values(this.channels)) { channel.onmessage = null; channel.onclose = null; }
    this.channels = {};
    pc.ontrack = pc.ondatachannel = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
    pc.close();
    // The track's last picture stays up until the socket's first frame takes its place.
  }

  private sized = () => {
    const video = this.options.video;
    if (!this.pc || !video.videoWidth || !video.videoHeight) return;
    const picture = this.state.picture;
    if (this.state.transport === "video" && picture?.width === video.videoWidth && picture.height === video.videoHeight) return;
    this.pictureArrived("video", { width: video.videoWidth, height: video.videoHeight });
  };

  private videoShown = () => {
    const video = this.options.video;
    if (!this.pc || video.readyState < 2 || !video.videoWidth) return;
    if (this.state.transport !== "video" || !this.state.picture) this.pictureArrived("video", { width: video.videoWidth, height: video.videoHeight });
  };

  private pictureArrived(transport: "video" | "socket", picture: { width: number; height: number }) {
    this.cancel(this.patience);
    this.cancel(this.firstPicture);
    const first = !this.state.picture || this.state.transport !== transport;
    if (transport === "socket" && this.state.transport === "video") this.options.video.srcObject = null;
    this.set({ transport, picture, phase: this.active ? "live" : "paused", error: undefined });
    if (first) {
      this.startStats();
      this.askControl();
    }
  }

  // ── The pointer the computer draws ──────────────────────────────────────────────────────

  private told(message: Record<string, unknown>) {
    if (message.t === "cursor") {
      const number = finite(message.i);
      // The channel keeps no order: a position older than the one drawn is not drawn after it.
      if (number !== undefined) {
        if (number <= this.cursorNumber) return;
        this.cursorNumber = number;
      }
      const x = fraction(message.x), y = fraction(message.y);
      if (x !== undefined && y !== undefined) this.echo(x, y);
      return;
    }
    if (message.t !== "shape" || typeof message.id !== "string" || message.id.length > 64) return;
    if (typeof message.png === "string") {
      const w = finite(message.w), h = finite(message.h), hotX = finite(message.hotX), hotY = finite(message.hotY);
      if (message.png.length <= 1_400_000 && /^[A-Za-z0-9+/=]+$/.test(message.png) && w && h && w > 0 && h > 0 && w <= 256 && h <= 256 && hotX !== undefined && hotY !== undefined) {
        if (this.shapes.size >= 64) this.shapes.clear();
        const scale = finite(message.scale);
        this.shapes.set(message.id, {
          id: message.id, url: "data:image/png;base64," + message.png, w, h,
          hotX: Math.min(w, Math.max(0, hotX)), hotY: Math.min(h, Math.max(0, hotY)),
          scale: scale && scale >= 1 && scale <= 4 ? scale : 2,
        });
      }
    }
    const shape = this.shapes.get(message.id);
    if (shape && shape !== this.state.shape) this.set({ shape });
  }

  /** The computer says where its pointer is: news unless it is this window's own move coming back. */
  private echo(x: number, y: number) {
    const now = performance.now();
    if (this.state.canInput && (now - this.movedAt < 250 || this.trail.some((point) => now - point.t < 1000 && Math.abs(point.x - x) < 0.003 && Math.abs(point.y - y) < 0.003))) return;
    this.options.onCursor(x, y);
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────

  /** A new picture to ask for. The same connection carries it where the host can; otherwise a new connection does (the caller's to make). */
  setTarget(next: Partial<Omit<ScreenTarget, "paused">>): "applied" | "unchanged" | "reconnect" {
    const target = { ...this.target, ...next };
    if (target.display === this.target.display && target.width === this.target.width && target.maxFps === this.target.maxFps) return "unchanged";
    if (!this.gate.canConfigure) {
      // A lower frame-rate ceiling needs no new connection: the receiver shows what comes.
      if (target.display === this.target.display && target.width === this.target.width) { this.target = target; return "unchanged"; }
      return this.gate.capabilitiesKnown ? "reconnect" : "unchanged";
    }
    this.releaseAll();
    this.target = target;
    this.configure();
    this.set({ display: target.display });
    return "applied";
  }

  /** On or off the page: a capable host pauses the capture and keeps the connection. */
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.releaseAll();
    if (this.gate.canConfigure) this.configure();
    else if (this.gate.capabilitiesKnown) this.sendSocket({ t: active ? "shown" : "hidden" });
    if (active) this.askControl();
    this.set({ phase: this.resumedPhase() });
  }
  get canPause(): boolean { return this.gate.canPause; }

  setControl(wanted: boolean) {
    if (this.controlWanted === wanted) return;
    this.controlWanted = wanted;
    if (!wanted) this.releaseAll();
    this.askControl();
    this.set({});
  }

  /** The computer opens its window for the permission to be controlled. */
  askPermission() {
    this.sendSocket(this.gate.stamp({ t: "prompt" }));
  }

  // ── Input ───────────────────────────────────────────────────────────────────────────────

  private lanesOpen(): boolean {
    return this.state.transport === "video" && this.channels.input?.readyState === "open" && this.channels.pointer?.readyState === "open";
  }

  private post(event: ScreenInput, lane: Lane) {
    if (!this.state.canInput) return;
    const stamped = this.gate.stamp(event);
    if (!this.lanesOpen()) return this.sendSocket(stamped);
    const channel = this.channels[lane];
    // A pointer move that can't go now is replaced by the next; anything else waits its turn.
    if (lane === "pointer" && channel.bufferedAmount > 16_384) return;
    channel.send(JSON.stringify({ ...stamped, i: ++this.sent }));
  }

  /** The pointer, a frame at a time: as often as the picture could show it. */
  pointer(x: number, y: number) {
    if (!this.state.canInput) return;
    this.pendingMove = { x, y };
    this.movedAt = performance.now();
    if (!this.moveFrame) this.moveFrame = requestAnimationFrame(() => { this.moveFrame = 0; this.flushMove(false); });
  }

  /**
   * Says where the pointer is. "placed": something is about to happen there (a click, the wheel),
   * so it goes in order with it, on the reliable channel. Otherwise, with no button held, on the
   * channel that keeps no order; once the pointer rests its last position is said again in order.
   */
  private flushMove(placed: boolean) {
    const move = this.pendingMove;
    if (!move) {
      // Where the last move went unordered, a click must still land where it was.
      if (placed && this.lastLane === "pointer" && this.trail.length) {
        const last = this.trail[this.trail.length - 1];
        this.post({ t: "move", x: last.x, y: last.y }, "input");
        this.lastLane = "input";
      }
      return;
    }
    this.pendingMove = undefined;
    const now = performance.now();
    this.trail.push({ ...move, t: now });
    while (this.trail.length && now - this.trail[0].t > 1000) this.trail.shift();
    const lane: Lane = placed || this.held.size ? "input" : "pointer";
    this.post({ t: "move", x: move.x, y: move.y }, lane);
    this.lastLane = lane;
    this.cancel(this.rest);
    if (lane === "pointer") this.rest = this.later(80, () => {
      if (this.lastLane !== "pointer" || !this.trail.length) return;
      const last = this.trail[this.trail.length - 1];
      this.post({ t: "move", x: last.x, y: last.y }, "input");
      this.lastLane = "input";
    });
  }

  /** A button pressed or let go at a point of the picture. */
  button(down: boolean, button: "left" | "right", x: number, y: number, clicks: number, modifiers: Modifier[]) {
    if (!this.state.canInput) return;
    if (!down && !this.held.has(button)) return;
    this.pendingMove = { x, y };
    this.flushMove(true);
    const event = { t: down ? "down" : "up", b: button, n: Math.min(3, Math.max(1, clicks)), ...(modifiers.length ? { m: modifiers } : {}) } as ScreenInput & { t: "down" };
    this.post(event, "input");
    if (down) this.held.set(button, event);
    else this.held.delete(button);
  }

  scroll(dx: number, dy: number, x: number, y: number, modifiers: Modifier[]) {
    if (!this.state.canInput || (!dx && !dy)) return;
    this.pendingMove = { x, y };
    this.flushMove(true);
    this.post({ t: "scroll", dx: Math.round(dx), dy: Math.round(dy), ...(modifiers.length ? { m: modifiers } : {}) }, "input");
  }

  key(name: string, modifiers: Modifier[]) {
    if (!this.state.canInput || !name || name.length > 16) return;
    this.flushMove(true);
    this.post({ t: "key", k: name, ...(modifiers.length ? { m: modifiers } : {}) }, "input");
  }

  input(events: ScreenInput[]) {
    if (!this.state.canInput) return;
    this.flushMove(true);
    for (const event of events) this.post(event, "input");
  }

  /** Nothing stays pressed: the window lost the keys, the page went, control was turned off. */
  releaseAll() {
    const held = [...this.held.values()];
    this.held.clear();
    const allowed = this.state.canInput;
    for (const event of held) {
      const up = { ...event, t: "up" as const };
      // Let go even where input has just been closed: a button left down on the computer is worse.
      if (allowed) this.post(up, "input");
      else if (this.lanesOpen()) this.channels.input.send(JSON.stringify({ ...this.gate.stamp(up), i: ++this.sent }));
      else this.sendSocket(this.gate.stamp(up));
    }
  }

  // ── The picture down the socket ─────────────────────────────────────────────────────────

  private frame(data: ArrayBuffer) {
    if (data.byteLength < 6) return;
    const head = new DataView(data);
    const kind = head.getUint8(0), seq = head.getUint32(1);
    const unit = new Uint8Array(data, 5);
    this.socketBytes += data.byteLength;
    if (!this.active) return this.shownUpTo(seq);
    if (kind === 2) {
      // A latest-frame mailbox keeps decoding bounded when this end is slow.
      this.jpegPending = { seq, unit };
      void this.drawJpeg();
      return;
    }
    if (typeof VideoDecoder === "undefined") return;
    const key = kind === 1;
    // A decoder that can't keep up skips to the next keyframe; what it skips has still arrived.
    if (this.decoder && !key && (this.skipping || this.decoder.decodeQueueSize > 8)) { this.skipping = true; this.askKey(); return this.shownUpTo(seq); }
    this.skipping = false;
    if (!this.decoder) {
      const params = key ? sps(unit) : undefined;
      if (!params || params.length < 4) { this.askKey(); return this.shownUpTo(seq); }
      this.decoder = new VideoDecoder({
        output: (frame) => {
          try { this.drawFrame(frame, frame.displayWidth, frame.displayHeight, Number(frame.timestamp)); }
          finally { frame.close(); }
        },
        error: (error) => {
          // One bad frame is not the end of the picture: a new decoder at the next keyframe.
          if (this.decodeFailures++ > 4) return this.fail("画面解码失败：" + error.message);
          this.decoder = undefined;
          this.askKey();
        },
      });
      this.decoder.configure({ codec: "avc1." + hex(params[1]) + hex(params[2]) + hex(params[3]), optimizeForLatency: true });
    }
    this.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: seq, data: unit }));
  }

  private async drawJpeg() {
    if (this.jpegDrawing) return;
    this.jpegDrawing = true;
    try {
      while (this.jpegPending && !this.closed) {
        const next = this.jpegPending;
        this.jpegPending = undefined;
        const bitmap = await createImageBitmap(new Blob([next.unit as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
        try { if (!this.closed && this.active) this.drawFrame(bitmap, bitmap.width, bitmap.height, next.seq, true); }
        finally { bitmap.close(); }
      }
    } catch (error) {
      this.fail("画面解码失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { this.jpegDrawing = false; }
  }

  private drawFrame(source: CanvasImageSource, width: number, height: number, seq: number, now = false) {
    if (this.closed || !this.context) return;
    const canvas = this.options.canvas;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    this.context.drawImage(source, 0, 0);
    this.socketFrames += 1;
    this.shownUpTo(seq, now);
    const picture = this.state.picture;
    if (this.state.transport !== "socket" || picture?.width !== width || picture.height !== height) this.pictureArrived("socket", { width, height });
  }

  private resetDecoder() {
    this.jpegPending = undefined;
    try { this.decoder?.close(); } catch { /* Already closed. */ }
    this.decoder = undefined;
    this.skipping = false;
  }

  private askKey() {
    const now = performance.now();
    if (now - this.keyAsked < 500) return;
    this.keyAsked = now;
    this.sendSocket({ t: "keyframe" });
  }

  /** The host is told which frame is on screen: that is how it knows this end has fallen behind. */
  private shownUpTo(seq: number, now = false) {
    if (seq > this.lastShown) this.lastShown = seq;
    if (now) { this.sendSocket({ t: "ack", n: this.lastShown }); return; }
    if (!this.ackTimer) this.ackTimer = setTimeout(() => { this.ackTimer = undefined; if (!this.closed) this.sendSocket({ t: "ack", n: this.lastShown }); }, 40);
  }

  // ── Numbers ─────────────────────────────────────────────────────────────────────────────

  private startStats() {
    if (this.statsTimer) return;
    this.statsBefore = undefined;
    this.statsTimer = setInterval(() => void this.measure(), 2000);
    void this.measure();
  }

  private async measure() {
    if (this.closed || document.hidden || !this.active) return;
    const now = performance.now();
    if (this.state.transport === "socket") {
      const before = this.statsBefore;
      this.statsBefore = { at: now, frames: this.socketFrames, bytes: this.socketBytes };
      if (!before) return;
      const seconds = (now - before.at) / 1000;
      this.set({ stats: {
        width: this.state.picture?.width, height: this.state.picture?.height, path: "socket",
        fps: round((this.socketFrames - before.frames) / seconds), bitrateMbps: round((this.socketBytes - before.bytes) * 8 / seconds / 1e6, 2),
        codec: this.decoder ? "H.264" : "JPEG",
      } });
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    let report: RTCStatsReport;
    try { report = await pc.getStats(); } catch { return; }
    if (this.pc !== pc || this.closed) return;
    let track: Record<string, unknown> = {}, transport: Record<string, unknown> = {};
    const pairs: Record<string, unknown>[] = [], ends = new Map<string, Record<string, unknown>>(), codecs = new Map<string, Record<string, unknown>>();
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type === "inbound-rtp" && (entry.kind ?? entry.mediaType) === "video") track = entry;
      else if (entry.type === "transport") transport = entry;
      else if (entry.type === "candidate-pair") pairs.push(entry);
      else if (entry.type === "local-candidate" || entry.type === "remote-candidate") ends.set(String(entry.id), entry);
      else if (entry.type === "codec") codecs.set(String(entry.id), entry);
    });
    const pair = pairs.find((one) => one.id === transport.selectedCandidatePairId) ?? pairs.find((one) => one.nominated && one.state === "succeeded");
    const near = pair && ends.get(String(pair.localCandidateId)), far = pair && ends.get(String(pair.remoteCandidateId));
    const types = [near?.candidateType, far?.candidateType];
    const before = this.statsBefore?.raw;
    const was = before && before.id === track.id && Number(track.timestamp) > Number(before.timestamp) ? before : undefined;
    const since = (field: string) => Number(track[field] ?? 0) - Number(was?.[field] ?? 0);
    const seconds = was ? (Number(track.timestamp) - Number(was.timestamp)) / 1000 : 0;
    this.statsBefore = { at: now, frames: 0, bytes: 0, raw: track };
    const mime = String(codecs.get(String(track.codecId))?.mimeType ?? "").toLowerCase();
    const rtt = finite(pair?.currentRoundTripTime);
    this.set({ stats: {
      width: finite(track.frameWidth) ?? this.state.picture?.width,
      height: finite(track.frameHeight) ?? this.state.picture?.height,
      fps: seconds > 0 ? round(since("framesDecoded") / seconds) : round(finite(track.framesPerSecond)),
      bitrateMbps: seconds > 0 ? round(Math.max(0, since("bytesReceived")) * 8 / seconds / 1e6, 2) : undefined,
      codec: mime === "video/h265" ? "H.265" : mime === "video/h264" ? "H.264" : mime ? mime.replace("video/", "").toUpperCase() : undefined,
      rttMs: rtt === undefined ? undefined : round(rtt * 1000, 0),
      path: types.includes("relay") ? "relay" : near ? privateAddress(near.address) && privateAddress(far?.address) ? "lan" : "direct" : undefined,
      decoder: typeof track.decoderImplementation === "string" ? track.decoderImplementation.slice(0, 60) : undefined,
      hardware: typeof track.powerEfficientDecoder === "boolean" ? track.powerEfficientDecoder : undefined,
      jitterMs: since("jitterBufferEmittedCount") > 0 ? round(since("jitterBufferDelay") / since("jitterBufferEmittedCount") * 1000) : undefined,
    } });
  }
}

/**
 * Whether an address is on a local network (RFC 1918, link-local, unique-local IPv6, loopback,
 * CGNAT as Tailscale uses it). A peer-reflexive candidate on a LAN has no address in the stats;
 * one known address on each side is enough then.
 */
function privateAddress(value: unknown): boolean {
  if (typeof value !== "string" || !value) return true;
  if (/^(10|127)\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value)) return true;
  const second = /^172\.(\d+)\./.exec(value)?.[1] ?? /^100\.(\d+)\./.exec(value)?.[1];
  if (second !== undefined) return value.startsWith("172.") ? Number(second) >= 16 && Number(second) <= 31 : Number(second) >= 64 && Number(second) <= 127;
  return /^(f[cd]|fe[89ab])[0-9a-f]*:/i.test(value) || value === "::1";
}

/** What ICE gathered and tried, for the host's log when a track is given up. */
async function iceSummary(pc: RTCPeerConnection): Promise<string> {
  try {
    const report = await pc.getStats();
    const local: Record<string, number> = {}, remote: Record<string, number> = {}, pairs: Record<string, number> = {};
    let nominated = false;
    report.forEach((entry: Record<string, unknown>) => {
      const count = (into: Record<string, number>, key: unknown) => { const name = String(key); into[name] = (into[name] ?? 0) + 1; };
      if (entry.type === "local-candidate") count(local, entry.candidateType);
      else if (entry.type === "remote-candidate") count(remote, entry.candidateType);
      else if (entry.type === "candidate-pair") { count(pairs, entry.state); if (entry.nominated && entry.state === "succeeded") nominated = true; }
    });
    const list = (counts: Record<string, number>) => Object.entries(counts).map(([kind, n]) => `${kind}×${n}`).join(",") || "none";
    return `local ${list(local)}; remote ${list(remote)}; pairs ${list(pairs)}${nominated ? "; nominated" : ""}; ice ${pc.iceConnectionState}/${pc.iceGatheringState}`;
  } catch {
    return "no statistics";
  }
}
