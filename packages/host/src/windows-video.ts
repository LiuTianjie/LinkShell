import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { encodeScreenAudioPacket, SCREEN_AUDIO_CODEC_PCM16 } from "@linkshell/wire";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useAbsSendTime,
  useH264,
  useNACK,
  usePLI,
  useREMB,
  useSdesMid,
  useTWCC,
  useTransportWideCC,
  type RTCDataChannel,
} from "werift";
import { inputEvent, type VideoOffer, type VideoSignal, type VideoConfiguration, type VideoConfigured } from "./input.js";
import { H264_MIME, H264AccessUnits, ScreenInputOrder, h264Nals, h264Payloads } from "./screen-h264.js";
import { configureWindowsCapture, noteWindowsVideo, windowsHelper, windowsVideoEnv } from "./windows-screen.js";

export interface ScreenVideoSession {
  id: string;
  signal(message: VideoSignal): void;
  end(): void;
  reconfigure?: boolean;
  /** Input may name physical keys held and released (`keydown` / `keyup`) and the middle button. */
  keys?: boolean;
  configure?(configuration: VideoConfiguration): Promise<VideoConfigured>;
  pause?(hidden: boolean): void;
  cursor?(x: number, y: number): boolean;
  setAudio?(enabled: boolean): void;
}

export function windowsMedia(): string | undefined {
  const helper = windowsHelper();
  const file = process.env.LINKSHELL_WINDOWS_FFMPEG || (helper && join(dirname(helper), "media", "ffmpeg.exe"));
  return file && existsSync(file) ? file : undefined;
}

const profiles = [
  { width: 2560, fps: 60, bitrate: 14_000_000 },
  { width: 1920, fps: 60, bitrate: 10_000_000 },
  { width: 1920, fps: 30, bitrate: 6_000_000 },
  { width: 1600, fps: 30, bitrate: 3_500_000 },
  { width: 1280, fps: 24, bitrate: 1_800_000 },
];

/**
 * The best profile this computer has shown it can make. A small PC that captures 30 frames a
 * second never reaches a 60 fps profile however good the network is: without this each viewer
 * started at the top, was moved down ten seconds later (an encoder restart, a frozen picture,
 * often a reconnect) and then, on a good network, was moved up to fall again.
 */
const machine = { level: 0, at: 0 };
/** One step higher is tried again after this long: the computer may only have been busy. */
const MACHINE_RETRY_MS = 30 * 60_000;

export function windowsMachineLevel(now = Date.now()): number {
  return machine.level > 0 && now - machine.at > MACHINE_RETRY_MS ? machine.level - 1 : machine.level;
}

export function noteWindowsMachineLevel(level: number, now = Date.now()): void {
  machine.level = Math.max(0, Math.min(profiles.length - 1, level));
  machine.at = now;
}

/**
 * The next profile down for a sender that delivered `made` frames a second: past the ones that
 * ask for more frames than it makes, since those would only be left the same way.
 */
export function windowsSlowerLevel(level: number, made: number | undefined): number {
  let next = Math.min(profiles.length - 1, level + 1);
  if (made !== undefined) while (next < profiles.length - 1 && profiles[next]!.fps > made * 1.15) next++;
  return next;
}

export function windowsVideoProfile(level: number, request: Pick<VideoOffer, "maxWidth" | "maxFps" | "fps">) {
  const index = Math.max(0, Math.min(profiles.length - 1, level));
  const profile = profiles[index]!;
  // Allow up to 4K native (3840x2160) at level 0 when requested; default to crisp 2560 at level 0.
  const ceiling = index === 0 && request.maxWidth && request.maxWidth > profile.width
    ? Math.min(3840, request.maxWidth)
    : profile.width;
  const width = Math.min(ceiling, request.maxWidth ?? profile.width);
  const fps = Math.min(profile.fps, request.maxFps ?? 60, request.fps ?? 60);
  const bitrate = Math.min(24_000_000, Math.max(600_000, Math.round(profile.bitrate * (width / profile.width) ** 2 * fps / profile.fps)));
  return { width, fps, bitrate };
}

/** werift relays over UDP only and takes one address a server: TLS and TCP relays are for the other senders. */
export function weriftIceServers(servers: VideoOffer["iceServers"]): { urls: string; username?: string; credential?: string }[] {
  return servers.flatMap(server => server.urls
    .filter(url => !url.startsWith("turns:") && !/[?&]transport=tcp/.test(url))
    .map(urls => ({ urls, ...(server.username && server.credential ? { username: server.username, credential: server.credential } : {}) })));
}

/** Length-and-timestamp-prefixed 48 kHz stereo PCM16 frames from `LinkShell.Screen.exe --audio`. */
export class WindowsAudioSplitter {
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private frame?: Buffer;
  private frameBytes = 0;
  private timestampMs = 0;

  push(chunk: Buffer, emit: (frame: { timestampMs: number; payload: Buffer }) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const copied = chunk.copy(this.header, this.headerBytes, offset, offset + 8 - this.headerBytes);
        this.headerBytes += copied; offset += copied;
        if (this.headerBytes < 8) return;
        const size = this.header.readUInt32LE(0);
        if (size < 4 || size > 65536 || (size & 3) !== 0) throw new Error("Invalid Windows audio frame length");
        this.timestampMs = this.header.readUInt32LE(4);
        this.frame = Buffer.allocUnsafe(size); this.frameBytes = 0; this.headerBytes = 0;
      }
      const copied = chunk.copy(this.frame, this.frameBytes, offset, offset + this.frame.length - this.frameBytes);
      this.frameBytes += copied; offset += copied;
      if (this.frameBytes < this.frame.length) return;
      const frame = this.frame;
      this.frame = undefined;
      emit({ timestampMs: this.timestampMs, payload: frame });
    }
  }
}

export interface WindowsCursorShape {
  id: string;
  png: string;
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  scale: number;
  displayW: number;
  displayH: number;
}

export interface WindowsVideoDeps {
  helper?: () => string | undefined;
  media?: () => string | undefined;
  spawn?: typeof spawn;
  displaySize?: (screen: number) => { w?: number; h?: number } | undefined;
}

/** Same SDP and input protocol as the Mac helper; media leaves through DTLS-SRTP, never the gateway. */
export class WindowsVideoSession implements ScreenVideoSession {
  readonly id = `windows-video-${randomBytes(6).toString("hex")}`;
  readonly reconfigure = true;
  private readonly pc: RTCPeerConnection;
  private readonly sender;
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly order = new ScreenInputOrder();
  private targetScreen: number;
  private targetMaxWidth?: number;
  private targetMaxFps?: number;
  private inputGeneration?: number;
  private h264Profile: "main" | "baseline";
  private lastWidth = 0;
  private lastHeight = 0;
  private child?: ChildProcess;
  private shapeChild?: ChildProcess;
  private audioChild?: ChildProcess;
  private readonly shapes = new Map<string, WindowsCursorShape>();
  private readonly shapesSent = new Set<string>();
  private lastShapeId?: string;
  private audioEnabled: boolean;
  private audioSeq = 0;
  private started = false;
  private closed = false;
  private hidden = false;
  private sending = false;
  private pending: { unit: Buffer; key: boolean; at: number }[] = [];
  private needsKey = true;
  private connected = false;
  private level = windowsMachineLevel();
  /** Seconds in a row in which an active capture/encoder delivered well under the profile's frame rate. */
  private behindIntervals = 0;
  private made = 0;
  /** When the running capture delivered its first frame: its first seconds say nothing about its rate. */
  private steadySince = Infinity;
  private changed = performance.now();
  private goodSince = performance.now();
  private calmUpgradeMs = 25_000;
  private lastUpgradeAt?: number;
  private seq = randomBytes(2).readUInt16BE();
  private cursorSeq = 0;
  private timestamp = randomBytes(4).readUInt32BE();
  private lastFrame = performance.now();
  private sentFrames = 0;
  private sentBytes = 0;
  private dropped = 0;
  private captured = 0;
  private queueDrops = 0;
  private plis = 0;
  private lastStats = performance.now();
  private lastFeedback = 0;
  private feedbackSource: "none" | "remb" | "twcc" = "none";
  private estimate = 0;
  private strainedIntervals = 0;
  private encoder = "";
  private inputUsed = false;
  /** The chosen pair goes through a TURN relay: the picture is held to the relay's share. */
  private relayed = false;
  private readonly parameterSets = new Map<number, Buffer>();
  private serial = Promise.resolve();
  private captureSerial = Promise.resolve();
  private warmed = () => {};
  private readonly warming = new Promise<void>(resolve => { this.warmed = resolve; });
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private unsteady?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly request: VideoOffer,
    private readonly events: { tell(message: object): void; input(message: unknown): void; lost(): void; log(message: string): void; path?(relayed: boolean): void },
    private readonly deps: WindowsVideoDeps = {},
  ) {
    this.targetScreen = request.screen;
    this.targetMaxWidth = request.maxWidth;
    this.targetMaxFps = request.maxFps;
    this.h264Profile = process.env.LINKSHELL_WINDOWS_PROFILE?.toLowerCase() === "baseline" ? "baseline" : "main";
    this.audioEnabled = request.audio === true;
    const rtcpFeedback = [useNACK(), usePLI(), useREMB(), useTWCC()];
    this.pc = new RTCPeerConnection({
      iceServers: weriftIceServers(request.iceServers),
      bundlePolicy: "max-bundle",
      codecs: { video: [
        // Main for Chrome/Safari/Edge/Firefox, Constrained High for iOS native VideoToolbox, Baseline fallback.
        useH264({ mimeType: H264_MIME, payloadType: 96, rtcpFeedback, parameters: "profile-level-id=4d002a;packetization-mode=1;level-asymmetry-allowed=1" }),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000, payloadType: 97, parameters: "apt=96" }),
        useH264({ mimeType: H264_MIME, payloadType: 98, rtcpFeedback, parameters: "profile-level-id=640c2a;packetization-mode=1;level-asymmetry-allowed=1" }),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000, payloadType: 99, parameters: "apt=98" }),
        useH264({ mimeType: H264_MIME, payloadType: 100, rtcpFeedback, parameters: "profile-level-id=42e02a;packetization-mode=1;level-asymmetry-allowed=1" }),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000, payloadType: 101, parameters: "apt=100" }),
      ] },
      headerExtensions: { video: [useSdesMid(), useAbsSendTime(), useTransportWideCC()] },
    });
    this.sender = this.pc.addTransceiver("video", { direction: "sendonly" }).sender;
    // Never gate P-frames on a PLI: FFmpeg cannot emit an on-demand IDR here, so setting needsKey
    // would discard seconds of valid P-frames instead of letting RTX/NACK repair packet loss.
    this.sender.onPictureLossIndication.subscribe(() => { this.plis++; });
    this.sender.onRtcp.subscribe(() => {
      const remb = Number(this.sender.receiverEstimatedMaxBitrate);
      if (Number.isFinite(remb) && remb > 0) {
        this.estimate = remb;
        this.feedbackSource = "remb";
        this.lastFeedback = performance.now();
        return;
      }
      const bwe = Number((this.sender as { senderBWE?: { availableBitrate?: number } }).senderBWE?.availableBitrate);
      if (Number.isFinite(bwe) && bwe > 0) {
        this.estimate = bwe;
        this.feedbackSource = "twcc";
        this.lastFeedback = performance.now();
      }
    });
    this.pc.onIceCandidate.subscribe(candidate => {
      if (candidate && !this.closed) this.events.tell({ t: "ice", ...candidate.toJSON() });
    });
    this.pc.connectionStateChange.subscribe(state => {
      if (this.closed) return;
      this.events.tell({ t: "state", connection: state, ice: this.pc.iceConnectionState });
      this.connected = state === "connected";
      clearTimeout(this.unsteady);
      if (this.connected) {
        this.needsKey = true;
        this.goodSince = performance.now();
        this.strainedIntervals = this.behindIntervals = 0;
        this.events.log("[screen] Windows H.264 video connected directly to the viewer");
      } else if (state === "disconnected") {
        // Missed consent checks on Wi-Fi recover on their own; ending at once sent the viewer to
        // the JPEG fallback for good. The receivers allow four seconds, the sender a little more.
        this.unsteady = setTimeout(() => { if (!this.connected) this.fail("video connection lost"); }, 5000);
      } else if (state === "failed" || state === "closed") this.fail("video connection lost");
    });
    for (const label of ["input", "pointer", "cursor", "shape", "audio"]) {
      const lossy = label === "pointer" || label === "cursor" || label === "audio";
      const channel = this.pc.createDataChannel(label, lossy ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      this.channels.set(label, channel);
      if (label === "shape") {
        channel.stateChanged.subscribe(state => {
          if (state === "open" && !this.closed && !this.hidden && this.lastShapeId) this.sendShape(this.lastShapeId);
        });
        continue;
      }
      if (label !== "input" && label !== "pointer") continue;
      channel.onMessage.subscribe(data => {
        if (this.closed || this.hidden || typeof data !== "string" || data.length > 32_000) return;
        try {
          const message: unknown = JSON.parse(data);
          if (this.inputGeneration !== undefined && (message as { screenGeneration?: unknown } | null)?.screenGeneration !== this.inputGeneration) return;
          if (inputEvent.safeParse(message).success && this.order.accept(message, lossy)) { this.inputUsed = true; this.events.input(message); }
        } catch { /* Invalid input cannot terminate a screen session. */ }
      });
      channel.stateChanged.subscribe(state => { if (state === "closed" && !this.closed) this.release(); });
    }
    this.monitor = setInterval(() => this.report(), 1000);
    this.timeout = setTimeout(() => { if (!this.connected) this.fail("video negotiation timed out"); }, 30_000);
  }

  private resolveHelper(): string | undefined { return (this.deps.helper ?? windowsHelper)(); }
  private resolveMedia(): string | undefined { return (this.deps.media ?? windowsMedia)(); }
  private spawnProcess(): typeof spawn { return this.deps.spawn ?? spawn; }

  async offer(): Promise<void> {
    if (!this.resolveMedia() || !this.resolveHelper()) throw new Error("Windows video runtime is missing");
    this.started = true;
    // Warm the encoder during ICE, so a connected receiver need not wait for hardware startup.
    this.captureSerial = this.captureSerial.then(() => this.startCapture()).catch(error => this.fail(String(error)));
    this.startShapeCapture();
    if (this.audioEnabled) this.startAudioCapture();
    // Do not start the receiver's four-second first-frame deadline while probing a driver.
    await this.warming;
    if (this.closed) return;
    const offer = await this.pc.createOffer();
    if (this.closed) return;
    const gathering = this.pc.setLocalDescription(offer);
    this.events.tell({ t: "offer", sdp: offer.sdp });
    void gathering.catch(error => this.fail(String(error)));
  }

  signal(message: VideoSignal): void {
    this.serial = this.serial.then(async () => {
      if (this.closed) return;
      if (message.t === "rtc.answer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        if (!this.sender.codec || this.sender.codec.mimeType.toLowerCase() !== "video/h264") {
          this.fail("viewer did not accept H.264");
          return;
        }
        const params = (this.sender.codec.parameters ?? "").toLowerCase();
        if (/(?:^|;)\s*profile-level-id=42/.test(params) && this.h264Profile !== "baseline") {
          this.h264Profile = "baseline";
          this.events.log("[screen] viewer accepted Baseline H.264 only; restarting Windows capture in baseline profile");
          if (this.started && !this.hidden) this.restartCapture();
        }
      } else await this.pc.addIceCandidate(message);
    }).catch(error => this.fail(String(error)));
  }

  cursor(x: number, y: number): boolean {
    const channel = this.channels.get("cursor");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 4096) return false;
    try { channel.send(JSON.stringify({ t: "cursor", x, y, i: ++this.cursorSeq })); return true; }
    catch { return false; }
  }

  setAudio(enabled: boolean): void {
    if (this.closed || this.audioEnabled === enabled) return;
    this.audioEnabled = enabled;
    if (!enabled) {
      this.stopAudioCapture();
      return;
    }
    if (this.started && !this.hidden) this.startAudioCapture();
  }

  pause(hidden: boolean): void {
    if (this.hidden === hidden || this.closed) return;
    this.hidden = hidden;
    this.needsKey = true;
    if (hidden) this.release();
    if (this.shapeChild) configureWindowsCapture(this.shapeChild, { t: "pause", value: hidden ? 1 : 0 });
    if (hidden) this.stopAudioCapture();
    else if (this.started && this.audioEnabled) this.startAudioCapture();
    this.captureSerial = this.captureSerial.then(async () => { await this.stopCapture(); if (!this.hidden && !this.closed) this.startCapture(); }).catch(error => this.fail(String(error)));
  }

  async configure(configuration: VideoConfiguration): Promise<VideoConfigured> {
    if (this.closed) throw new Error("屏幕连接已断开");
    const screenChanged = configuration.screen !== this.targetScreen;
    const sizeChanged = configuration.maxWidth !== this.targetMaxWidth || configuration.maxFps !== this.targetMaxFps;
    const before = this.profile();
    const wasHidden = this.hidden;
    this.targetScreen = configuration.screen;
    this.targetMaxWidth = configuration.maxWidth;
    this.targetMaxFps = configuration.maxFps;
    if (configuration.inputGeneration !== undefined) this.inputGeneration = configuration.inputGeneration;
    if (screenChanged || sizeChanged) {
      this.level = windowsMachineLevel();
      this.strainedIntervals = this.behindIntervals = 0;
      this.changed = performance.now();
      this.goodSince = this.changed;
      this.calmUpgradeMs = 25_000;
      this.lastUpgradeAt = undefined;
    }
    const after = this.profile();
    const dims = this.resolvedDimensions(after.width, screenChanged);
    if (configuration.paused) {
      this.hidden = true;
      this.needsKey = true;
      this.release();
      if (screenChanged) {
        this.stopShapeCapture();
        this.shapesSent.clear();
        this.lastShapeId = undefined;
      } else if (this.shapeChild) {
        configureWindowsCapture(this.shapeChild, { t: "pause", value: 1 });
      }
      this.stopAudioCapture();
      const stopping = this.captureSerial.then(async () => { await this.stopCapture(); });
      this.captureSerial = stopping.catch(error => this.fail(String(error)));
      await stopping;
      if (this.closed) throw new Error("屏幕连接已断开");
      return {
        screen: this.targetScreen, width: dims.width, height: dims.height, maxFps: after.fps, paused: true,
        ...(configuration.inputGeneration === undefined ? {} : { generation: configuration.inputGeneration }),
      };
    }
    this.hidden = false;
    if (screenChanged) {
      this.stopShapeCapture();
      this.shapesSent.clear();
      this.lastShapeId = undefined;
      if (this.started) this.startShapeCapture();
    } else if (wasHidden) {
      if (this.shapeChild) configureWindowsCapture(this.shapeChild, { t: "pause", value: 0 });
      else if (this.started) this.startShapeCapture();
    }
    if (wasHidden && this.started && this.audioEnabled) this.startAudioCapture();
    const needsRestart = this.started && (
      wasHidden || screenChanged || !this.child ||
      after.width !== before.width || after.fps !== before.fps || after.bitrate !== before.bitrate
    );
    if (needsRestart) {
      this.needsKey = true;
      const restarting = this.captureSerial.then(async () => {
        if (this.closed) return;
        await this.stopCapture();
        if (!this.hidden && !this.closed) this.startCapture();
      });
      this.captureSerial = restarting.catch(error => this.fail(String(error)));
      await restarting;
    }
    if (this.closed) throw new Error("屏幕连接已断开");
    return {
      screen: this.targetScreen, width: dims.width, height: dims.height, maxFps: after.fps, paused: false,
      ...(configuration.inputGeneration === undefined ? {} : { generation: configuration.inputGeneration }),
    };
  }

  private resolvedDimensions(requestedWidth: number, screenChanged: boolean): { width: number; height: number } {
    const maxW = Math.max(320, Math.min(3840, requestedWidth));
    const maxH = maxW > 2560 ? 2160 : maxW > 1920 ? 1440 : 1080;
    const display = this.deps.displaySize?.(this.targetScreen);
    if (display && display.w && display.h) {
      const scale = Math.min(1, Math.min(maxW / display.w, maxH / display.h));
      return { width: Math.max(2, Math.floor(display.w * scale / 2) * 2), height: Math.max(2, Math.floor(display.h * scale / 2) * 2) };
    }
    if (!screenChanged && this.lastWidth > 0 && this.lastHeight > 0) {
      const scale = Math.min(maxW / this.lastWidth, maxH / this.lastHeight);
      return { width: Math.max(2, Math.floor(this.lastWidth * scale / 2) * 2), height: Math.max(2, Math.floor(this.lastHeight * scale / 2) * 2) };
    }
    return { width: maxW, height: Math.max(2, Math.floor(maxW * 9 / 16 / 2) * 2) };
  }

  /** The profile for a given level, held to the relay's share while the path goes through one. */
  private profileFor(level: number) {
    const profile = windowsVideoProfile(level, { maxWidth: this.targetMaxWidth, maxFps: this.targetMaxFps, fps: this.request.fps });
    if (!this.relayed) return profile;
    // On TURN (typically 3 Mbps), cap to 30 fps so every frame gets 2x the bits for razor-sharp UI text.
    const relayKbps = this.request.relayKbps ?? 3000;
    const relayFps = Math.min(profile.fps, relayKbps <= 2500 ? 24 : 30);
    return { ...profile, fps: relayFps, bitrate: Math.min(profile.bitrate, relayKbps * 1000) };
  }

  private profile() {
    return this.profileFor(this.level);
  }

  private restartCapture(): void {
    this.needsKey = true;
    this.captureSerial = this.captureSerial.then(async () => {
      await this.stopCapture();
      if (!this.hidden && !this.closed) this.startCapture();
    }).catch(error => this.fail(String(error)));
  }

  private startCapture(): void {
    if (this.closed || this.hidden) return;
    const helper = this.resolveHelper(), media = this.resolveMedia();
    if (!helper || !media) return;
    const profile = this.profile();
    const env: NodeJS.ProcessEnv = this.h264Profile === "baseline"
      ? { ...windowsVideoEnv(), LINKSHELL_WINDOWS_PROFILE: "baseline" }
      : windowsVideoEnv();
    const child = this.spawnProcess()(helper, ["--video", String(this.targetScreen), String(profile.width), String(profile.fps), String(profile.bitrate), media], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env,
    });
    this.child = child;
    this.needsKey = true;
    this.steadySince = Infinity;
    const splitter = new H264AccessUnits();
    let errors = "", received = false;
    const startup = setTimeout(() => { if (this.child === child && !received) this.fail("hardware encoder produced no frames"); }, 12_000);
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.closed) return;
      try {
        splitter.push(chunk, (unit, key) => {
          if (!received) this.steadySince = performance.now() + 3000;
          received = true; clearTimeout(startup); this.warmed();
          this.enqueue(unit, key);
        });
      } catch (error) { this.fail(String(error)); }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString(); errors = (errors + text).slice(-2000);
      noteWindowsVideo(text);
      const dims = /\[video\] encoder=(\S+)\s+width=(\d+)\s+height=(\d+)/.exec(text);
      if (dims) {
        this.encoder = dims[1]!;
        this.lastWidth = Number(dims[2]);
        this.lastHeight = Number(dims[3]);
        this.events.log(`[screen] Windows hardware encoder: ${this.encoder}`);
      } else {
        const encoder = /\[video\] encoder=(\S+)/.exec(text)?.[1];
        if (encoder) { this.encoder = encoder; this.events.log(`[screen] Windows hardware encoder: ${encoder}`); }
      }
    });
    child.on("error", error => this.fail(error.message));
    child.on("exit", code => {
      clearTimeout(startup);
      if (this.child === child && !this.closed) { this.child = undefined; this.fail(`encoder exited ${code}: ${errors.trim()}`); }
    });
  }

  private enqueue(unit: Buffer, key: boolean): void {
    const nals = h264Nals(unit);
    for (const nal of nals) { const type = nal[0]! & 31; if (type === 7 || type === 8) this.parameterSets.set(type, Buffer.from(nal)); }
    if (!nals.some(nal => (nal[0]! & 31) >= 1 && (nal[0]! & 31) <= 5)) return;
    this.captured++;
    if (this.closed || this.hidden || !this.connected) return;
    const at = performance.now();
    if (this.pending.length >= 4 || (this.pending[0] && at - this.pending[0].at > 160)) {
      if (key) {
        this.dropped += this.pending.length;
        this.queueDrops += this.pending.length;
        this.pending = [];
        this.needsKey = false;
      } else {
        let newestKey = -1;
        for (let i = this.pending.length - 1; i >= 1; i--) {
          if (this.pending[i]!.key) { newestKey = i; break; }
        }
        if (newestKey > 0) {
          this.dropped += newestKey;
          this.queueDrops += newestKey;
          this.pending = this.pending.slice(newestKey);
          this.needsKey = false;
        } else {
          this.dropped += this.pending.length;
          this.queueDrops += this.pending.length;
          this.pending = [];
          this.needsKey = true;
        }
      }
    }
    this.pending.push({ unit, key, at });
    if (this.sending) return;
    this.sending = true;
    void (async () => {
      while (this.pending.length && !this.closed && !this.hidden) {
        const next = this.pending.shift()!;
        await this.frame(next.unit, next.key, next.at);
      }
    })().catch(error => this.fail(String(error))).finally(() => { this.sending = false; });
  }

  private async frame(unit: Buffer, key: boolean, capturedAt: number): Promise<void> {
    if (this.needsKey && !key) { this.dropped++; return; }
    this.needsKey = false;
    const now = performance.now();
    this.timestamp = (this.timestamp + Math.max(1, Math.round((capturedAt - this.lastFrame) * 90))) >>> 0;
    this.lastFrame = capturedAt;
    try {
      // A receiver may join after the initial SPS/PPS, or lose one at an IDR.
      const nals = h264Nals(unit);
      const missing = key ? [...this.parameterSets].filter(([type]) => !nals.some(nal => (nal[0]! & 31) === type)).map(([, nal]) => Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])) : [];
      const payloads = h264Payloads(missing.length ? Buffer.concat([...missing, unit]) : unit);
      const payloadType = this.sender.codec?.payloadType ?? 96;
      const batchSize = 8;
      const shouldPace = payloads.length > 16;
      for (let i = 0; i < payloads.length; i += batchSize) {
        if (this.closed || this.hidden) break;
        if (performance.now() - now > 200) { this.needsKey = true; this.dropped++; this.queueDrops++; break; }
        // Micro-paced 8-packet batches smooth large IDR UDP bursts so Wi-Fi/TURN queues and werift's NACK ring do not overflow.
        await Promise.all(payloads.slice(i, i + batchSize).map((payload, offset) => this.sender.sendRtp(new RtpPacket(new RtpHeader({
          payloadType, sequenceNumber: this.seq++ & 0xffff, timestamp: this.timestamp, ssrc: this.sender.ssrc, marker: i + offset === payloads.length - 1,
        }), payload))));
        // Cap pacing wait to 60 ms so Windows' default 15.6 ms timer tick never trips the 200 ms stall guard.
        if (shouldPace && i + batchSize < payloads.length && performance.now() - now < 60) {
          await new Promise<void>(resolve => setTimeout(resolve, 1));
        }
      }
      this.sentFrames++; this.sentBytes += unit.length;
    } catch (error) { this.fail(String(error)); }
  }

  private report(): void {
    if (this.closed) return;
    const now = performance.now(), elapsed = Math.max((now - this.lastStats) / 1000, 0.001);
    const profile = this.profile();
    const captured = this.captured;
    const queueDrops = this.queueDrops;
    const plis = this.plis;
    const dropped = this.dropped;
    const sentFrames = this.sentFrames;
    const sentBytes = this.sentBytes;
    this.captured = this.queueDrops = this.plis = this.dropped = this.sentFrames = this.sentBytes = 0;
    this.lastStats = now;
    const sendBitrate = Math.round(sentBytes * 8 / elapsed);
    if (process.env.LINKSHELL_SCREEN_DIAGNOSTICS === "1") {
      this.events.log(`[screen] Windows video ${JSON.stringify({ captured, sent: sentFrames, dropped, queueDrops, pli: plis, bitrate: sendBitrate, estimate: this.estimate, source: this.feedbackSource })}`);
    }
    // What the capture and encoder delivered, whatever was then sent: the computer's own limit.
    this.made = captured / elapsed;
    this.events.tell({ t: "stats", encoder: this.encoder, codec: "H264", fps: Math.round(sentFrames / elapsed), bitrate: sendBitrate, targetFps: profile.fps, targetBitrate: profile.bitrate, dropped });
    if (!this.connected || this.hidden) return;
    const feedback = this.lastFeedback > 0 && now - this.lastFeedback < 3000;
    const rembFeedback = feedback && this.feedbackSource === "remb";
    const twccFeedback = feedback && this.feedbackSource === "twcc";
    const bweCongested = (this.sender as { senderBWE?: { congestion?: boolean } }).senderBWE?.congestion === true;
    const pair = this.pc.iceTransports[0]?.connection.nominated;
    const relayed = !!pair && (pair.localCandidate.type === "relay" || pair.remoteCandidate.type === "relay");
    if (relayed !== this.relayed) {
      const before = profile.bitrate;
      this.relayed = relayed;
      this.events.path?.(relayed);
      this.events.log(`[screen] Windows video ${relayed ? "goes through a TURN relay" : "no longer goes through a relay"}`);
      // A new ceiling for the encoder only takes effect in a new capture.
      if (this.profile().bitrate !== before) { this.adapt(this.level); return; }
    }
    // A same-computer receiver can bootstrap a low REMB from an almost still desktop.
    // That estimate says nothing about link capacity and must not trigger repeated encoder restarts.
    const loopback = pair && pair.localCandidate.host === pair.remoteCandidate.host;
    // A mostly static desktop (typing, cursor moves) legitimately produces 5-35 fps at low bitrate.
    // Only treat sub-target FPS as a real CPU/GPU machine bottleneck during sustained active motion.
    const activeMotion = sendBitrate > profile.bitrate * 0.25;
    const behind = now > this.steadySince && activeMotion && this.made >= 15 && this.made < profile.fps * 0.55;
    this.behindIntervals = behind ? this.behindIntervals + 1 : 0;
    // REMB estimates link capacity; werift's TWCC senderBWE reports min(send, recv) throughput which tracks
    // sendBitrate on a quiet screen, so TWCC only flags congestion when recv lags send or congestion triggers.
    const lowBandwidth = !loopback && (
      (rembFeedback && this.estimate < profile.bitrate * 0.65 && sendBitrate > this.estimate * 0.9) ||
      (twccFeedback && this.estimate < profile.bitrate * 0.65 && (
        sendBitrate > this.estimate * 1.15 ||
        (bweCongested && sendBitrate > this.estimate * 0.9)
      ))
    );
    const strained = behind || queueDrops > profile.fps * 0.4 || plis >= 4 || lowBandwidth;
    this.strainedIntervals = strained ? this.strainedIntervals + 1 : 0;
    if (strained) {
      this.goodSince = now;
      if (this.strainedIntervals >= 5 && now - this.changed > 15_000 && this.level < profiles.length - 1) {
        if (this.lastUpgradeAt !== undefined && now - this.lastUpgradeAt < 45_000) {
          this.calmUpgradeMs = Math.min(120_000, this.calmUpgradeMs * 2);
        }
        const machineLimit = this.behindIntervals >= 6;
        const next = windowsSlowerLevel(this.level, machineLimit ? this.made : undefined);
        if (machineLimit) noteWindowsMachineLevel(next);
        this.adapt(next);
      }
    } else if (queueDrops === 0 && plis === 0 && !bweCongested) {
      if (this.lastUpgradeAt !== undefined && now - this.lastUpgradeAt >= 45_000) {
        this.calmUpgradeMs = 25_000;
        this.lastUpgradeAt = undefined;
      }
      if (this.level > windowsMachineLevel() && now - this.goodSince >= this.calmUpgradeMs && now - this.changed >= this.calmUpgradeMs) {
        const nextProfile = this.profileFor(this.level - 1);
        const canUpgrade = !rembFeedback || this.estimate > nextProfile.bitrate * 1.15;
        if (canUpgrade) {
          this.lastUpgradeAt = now;
          this.adapt(this.level - 1);
        }
      }
    } else {
      this.goodSince = now;
    }
  }

  private adapt(level: number): void {
    this.level = level; this.changed = performance.now(); this.goodSince = this.changed; this.needsKey = true;
    this.strainedIntervals = this.behindIntervals = 0;
    this.events.log(`[screen] Windows video profile: ${JSON.stringify(this.profile())}`);
    this.restartCapture();
  }

  private stopChild(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { } }, 1500);
      timer.unref?.();
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
    });
  }

  private stopCapture(): Promise<void> {
    this.pending = [];
    const child = this.child; this.child = undefined;
    return this.stopChild(child);
  }

  private startShapeCapture(): void {
    if (this.closed || this.shapeChild) return;
    const helper = this.resolveHelper();
    if (!helper) return;
    const child = this.spawnProcess()(helper, ["--shape", String(this.targetScreen)], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    this.shapeChild = child;
    child.stdin?.on("error", () => {});
    if (this.hidden) configureWindowsCapture(child, { t: "pause", value: 1 });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", line => {
        if (this.shapeChild !== child || this.closed || line.length > 1_500_000) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (message.t !== "shape" || typeof message.id !== "string" || !message.id || message.id.length > 64) return;
        if (typeof message.png === "string" && message.png.length > 0 && message.png.length <= 1_400_000) {
          const w = Number(message.w), h = Number(message.h), hotX = Number(message.hotX), hotY = Number(message.hotY);
          const scale = Number(message.scale), displayW = Number(message.displayW), displayH = Number(message.displayH);
          if (w > 0 && h > 0 && w <= 256 && h <= 256 && Number.isFinite(hotX) && Number.isFinite(hotY) && Number.isFinite(displayW) && Number.isFinite(displayH)) {
            if (this.shapes.size >= 64) this.shapes.clear();
            this.shapes.set(message.id, {
              id: message.id, png: message.png, w, h, hotX, hotY,
              scale: scale >= 1 && scale <= 4 ? scale : 1,
              displayW, displayH,
            });
          }
        }
        this.lastShapeId = message.id;
        this.sendShape(message.id);
      });
    }
    child.on("error", () => { if (this.shapeChild === child) this.shapeChild = undefined; });
    child.on("exit", () => { if (this.shapeChild === child) this.shapeChild = undefined; });
  }

  private stopShapeCapture(): void {
    const child = this.shapeChild; this.shapeChild = undefined;
    void this.stopChild(child);
  }

  private sendShape(id: string): void {
    const channel = this.channels.get("shape");
    if (!channel || channel.readyState !== "open" || this.closed || this.hidden) return;
    if (!this.shapesSent.has(id)) {
      const shape = this.shapes.get(id);
      if (!shape) return;
      try {
        channel.send(JSON.stringify({ t: "shape", ...shape }));
        this.shapesSent.add(id);
      } catch { /* Shape send failure will retry on next change or reconnect. */ }
      return;
    }
    try { channel.send(JSON.stringify({ t: "shape", id })); }
    catch { /* Ignore transient DataChannel errors. */ }
  }

  private startAudioCapture(): void {
    if (this.closed || this.hidden || !this.audioEnabled || this.audioChild) return;
    const helper = this.resolveHelper();
    if (!helper) return;
    const child = this.spawnProcess()(helper, ["--audio"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.audioChild = child;
    const splitter = new WindowsAudioSplitter();
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.audioChild !== child || this.closed) return;
      try {
        splitter.push(chunk, ({ timestampMs, payload }) => this.sendAudio(timestampMs, payload));
      } catch (error) {
        this.events.log(`[screen] Windows audio stream error: ${error instanceof Error ? error.message : String(error)}`);
        this.stopAudioCapture();
      }
    });
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-1000); });
    child.on("error", error => {
      if (this.audioChild === child) this.audioChild = undefined;
      this.events.log(`[screen] Windows audio unavailable: ${error.message}`);
    });
    child.on("exit", code => {
      if (this.audioChild === child) {
        this.audioChild = undefined;
        if (code && !this.closed && this.audioEnabled && !this.hidden) {
          this.events.log(`[screen] Windows audio exited ${code}: ${errors.trim()}`);
        }
      }
    });
  }

  private stopAudioCapture(): void {
    const child = this.audioChild; this.audioChild = undefined;
    void this.stopChild(child);
  }

  private sendAudio(timestampMs: number, payload: Buffer): void {
    const channel = this.channels.get("audio");
    if (this.closed || this.hidden || !this.audioEnabled || !this.connected || !channel || channel.readyState !== "open") return;
    if (channel.bufferedAmount > 64 * 1024) return;
    const packet = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_PCM16,
      seq: this.audioSeq++ & 0xffff,
      timestampMs,
      payload,
    });
    try { channel.send(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)); }
    catch { /* Lossy audio channel drop is non-fatal. */ }
  }

  private release(): void {
    if (!this.inputUsed) return;
    this.inputUsed = false;
    this.events.input({ t: "up", b: "left" });
    this.events.input({ t: "up", b: "right" });
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.events.log(`[screen] Windows video unavailable: ${reason}`);
    this.end(); this.events.lost();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.warmed();
    clearInterval(this.monitor); clearTimeout(this.timeout); clearTimeout(this.unsteady);
    this.release();
    this.stopShapeCapture();
    this.stopAudioCapture();
    void this.stopCapture();
    void this.pc.close().catch(() => {});
  }
}
