import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, useH264, useSdesMid, useAbsSendTime, type RTCDataChannel } from "werift";
import { inputEvent, type VideoOffer, type VideoSignal, type VideoConfiguration, type VideoConfigured } from "./input.js";
import { H264AccessUnits, ScreenInputOrder, h264Nals, h264Payloads } from "./screen-h264.js";
import { windowsHelper } from "./windows-screen.js";

export interface ScreenVideoSession {
  id: string;
  signal(message: VideoSignal): void;
  end(): void;
  reconfigure?: boolean;
  configure?(configuration: VideoConfiguration): Promise<VideoConfigured>;
  pause?(hidden: boolean): void;
  cursor?(x: number, y: number): boolean;
}

export function windowsMedia(): string | undefined {
  const helper = windowsHelper();
  const file = process.env.LINKSHELL_WINDOWS_FFMPEG || (helper && join(dirname(helper), "media", "ffmpeg.exe"));
  return file && existsSync(file) ? file : undefined;
}

const profiles = [
  { width: 1920, fps: 60, bitrate: 8_000_000 },
  { width: 1600, fps: 60, bitrate: 5_000_000 },
  { width: 1280, fps: 30, bitrate: 3_000_000 },
  { width: 960, fps: 30, bitrate: 1_500_000 },
  { width: 640, fps: 20, bitrate: 700_000 },
];

export function windowsVideoProfile(level: number, request: Pick<VideoOffer, "maxWidth" | "maxFps" | "fps">) {
  const profile = profiles[Math.max(0, Math.min(profiles.length - 1, level))]!;
  const width = Math.min(profile.width, request.maxWidth ?? 1920), fps = Math.min(profile.fps, request.maxFps ?? 60, request.fps ?? 60);
  return { width, fps, bitrate: Math.max(400_000, Math.round(profile.bitrate * (width / profile.width) ** 2 * fps / profile.fps)) };
}

/** Same SDP and input protocol as the Mac helper; media leaves through DTLS-SRTP, never the gateway. */
export class WindowsVideoSession implements ScreenVideoSession {
  readonly id = `windows-video-${randomBytes(6).toString("hex")}`;
  private readonly pc: RTCPeerConnection;
  private readonly sender;
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly order = new ScreenInputOrder();
  private child?: ChildProcess;
  private closed = false;
  private hidden = false;
  private sending = false;
  private pending: { unit: Buffer; key: boolean; at: number }[] = [];
  private needsKey = true;
  private connected = false;
  private level = 0;
  private changed = performance.now();
  private goodSince = performance.now();
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
  private estimate = 0;
  private strainedIntervals = 0;
  private encoder = "";
  private inputUsed = false;
  private readonly parameterSets = new Map<number, Buffer>();
  private serial = Promise.resolve();
  private captureSerial = Promise.resolve();
  private warmed = () => {};
  private readonly warming = new Promise<void>(resolve => { this.warmed = resolve; });
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly timeout: ReturnType<typeof setTimeout>;

  constructor(
    private readonly request: VideoOffer,
    private readonly events: { tell(message: object): void; input(message: unknown): void; lost(): void; log(message: string): void },
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: request.iceServers.flatMap(server => server.urls.map(urls => ({ urls }))),
      bundlePolicy: "max-bundle",
      codecs: { video: [
        useH264({ payloadType: 96, parameters: "profile-level-id=42e02a;packetization-mode=1;level-asymmetry-allowed=1" }),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000, payloadType: 97, parameters: "apt=96" }),
      ] },
      headerExtensions: { video: [useSdesMid(), useAbsSendTime()] },
    });
    this.sender = this.pc.addTransceiver("video", { direction: "sendonly" }).sender;
    this.sender.onPictureLossIndication.subscribe(() => { this.plis++; this.needsKey = true; });
    this.sender.onRtcp.subscribe(() => {
      const estimate = Number(this.sender.receiverEstimatedMaxBitrate);
      if (estimate > 0) { this.estimate = estimate; this.lastFeedback = performance.now(); }
    });
    this.pc.onIceCandidate.subscribe(candidate => {
      if (candidate && !this.closed) this.events.tell({ t: "ice", ...candidate.toJSON() });
    });
    this.pc.connectionStateChange.subscribe(state => {
      if (this.closed) return;
      this.events.tell({ t: "state", connection: state, ice: this.pc.iceConnectionState });
      this.connected = state === "connected";
      if (this.connected) {
        this.needsKey = true;
        this.events.log("[screen] Windows H.264 video connected directly to the viewer");
      } else if (state === "failed" || state === "closed" || state === "disconnected") this.fail("video connection lost");
    });
    for (const label of ["input", "pointer", "cursor", "shape"]) {
      const lossy = label === "pointer" || label === "cursor";
      const channel = this.pc.createDataChannel(label, lossy ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      this.channels.set(label, channel);
      if (label !== "input" && label !== "pointer") continue;
      channel.onMessage.subscribe(data => {
        if (this.closed || this.hidden || typeof data !== "string" || data.length > 32_000) return;
        try {
          const message: unknown = JSON.parse(data);
          if (inputEvent.safeParse(message).success && this.order.accept(message, lossy)) { this.inputUsed = true; this.events.input(message); }
        } catch { /* Invalid input cannot terminate a screen session. */ }
      });
      channel.stateChanged.subscribe(state => { if (state === "closed" && !this.closed) this.release(); });
    }
    this.monitor = setInterval(() => this.report(), 1000);
    this.timeout = setTimeout(() => { if (!this.connected) this.fail("video negotiation timed out"); }, 30_000);
  }

  async offer(): Promise<void> {
    if (!windowsMedia() || !windowsHelper()) throw new Error("Windows video runtime is missing");
    // Warm the encoder during ICE, so a connected receiver need not wait for hardware startup.
    this.captureSerial = this.captureSerial.then(() => this.startCapture()).catch(error => this.fail(String(error)));
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
        if (!this.sender.codec || this.sender.codec.mimeType.toLowerCase() !== "video/h264") this.fail("viewer did not accept H.264");
      } else await this.pc.addIceCandidate(message);
    }).catch(error => this.fail(String(error)));
  }

  cursor(x: number, y: number): boolean {
    const channel = this.channels.get("cursor");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 4096) return false;
    try { channel.send(JSON.stringify({ t: "cursor", x, y, i: ++this.cursorSeq })); return true; }
    catch { return false; }
  }

  pause(hidden: boolean): void {
    if (this.hidden === hidden || this.closed) return;
    this.hidden = hidden;
    this.needsKey = true;
    if (hidden) this.release();
    this.captureSerial = this.captureSerial.then(async () => { await this.stopCapture(); if (!this.hidden && !this.closed) this.startCapture(); }).catch(error => this.fail(String(error)));
  }

  private startCapture(): void {
    if (this.closed || this.hidden) return;
    const profile = windowsVideoProfile(this.level, this.request);
    const child = spawn(windowsHelper()!, ["--video", String(this.request.screen), String(profile.width), String(profile.fps), String(profile.bitrate), windowsMedia()!], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.needsKey = true;
    const splitter = new H264AccessUnits();
    let errors = "", received = false;
    const startup = setTimeout(() => { if (this.child === child && !received) this.fail("hardware encoder produced no frames"); }, 12_000);
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.closed) return;
      try {
        splitter.push(chunk, (unit, key) => {
          received = true; clearTimeout(startup); this.warmed();
          this.enqueue(unit, key);
        });
      } catch (error) { this.fail(String(error)); }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString(); errors = (errors + text).slice(-2000);
      const encoder = /\[video\] encoder=(\S+)/.exec(text)?.[1];
      if (encoder) { this.encoder = encoder; this.events.log(`[screen] Windows hardware encoder: ${encoder}`); }
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
    if (this.pending.length >= 2 || (this.pending[0] && at - this.pending[0].at > 80)) {
      this.dropped += this.pending.length; this.queueDrops += this.pending.length; this.pending = []; this.needsKey = true;
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
      for (let i = 0; i < payloads.length; i += 32) {
        if (this.closed || this.hidden) break;
        if (performance.now() - now > 120) { this.needsKey = true; this.dropped++; break; }
        // Small batches avoid one event-loop round trip per UDP packet in a large IDR.
        await Promise.all(payloads.slice(i, i + 32).map((payload, offset) => this.sender.sendRtp(new RtpPacket(new RtpHeader({
          payloadType: 96, sequenceNumber: this.seq++ & 0xffff, timestamp: this.timestamp, ssrc: this.sender.ssrc, marker: i + offset === payloads.length - 1,
        }), payload))));
      }
      this.sentFrames++; this.sentBytes += unit.length;
    } catch (error) { this.fail(String(error)); }
  }

  private report(): void {
    if (this.closed) return;
    const now = performance.now(), elapsed = (now - this.lastStats) / 1000;
    const profile = windowsVideoProfile(this.level, this.request);
    const sendBitrate = Math.round(this.sentBytes * 8 / elapsed);
    if (process.env.LINKSHELL_SCREEN_DIAGNOSTICS === "1") this.events.log(`[screen] Windows video ${JSON.stringify({ captured: this.captured, sent: this.sentFrames, dropped: this.dropped, queueDrops: this.queueDrops, pli: this.plis, bitrate: sendBitrate, estimate: this.estimate })}`);
    this.captured = this.queueDrops = this.plis = 0;
    this.events.tell({ t: "stats", encoder: this.encoder, codec: "H264", fps: Math.round(this.sentFrames / elapsed), bitrate: Math.round(this.sentBytes * 8 / elapsed), targetFps: profile.fps, targetBitrate: profile.bitrate, dropped: this.dropped });
    this.sentFrames = this.sentBytes = 0; this.lastStats = now;
    if (!this.connected || this.hidden) return;
    const feedback = this.lastFeedback > 0 && now - this.lastFeedback < 3000;
    const pair = this.pc.iceTransports[0]?.connection.nominated;
    // A same-computer receiver can bootstrap a low REMB from an almost still desktop.
    // That estimate says nothing about link capacity and must not trigger repeated encoder restarts.
    const loopback = pair && pair.localCandidate.host === pair.remoteCandidate.host;
    const strained = this.dropped > profile.fps / 2 || (!loopback && feedback && this.estimate < profile.bitrate * 0.75 && sendBitrate > this.estimate * 0.9);
    this.strainedIntervals = strained ? this.strainedIntervals + 1 : 0;
    this.dropped = 0;
    if (strained) {
      this.goodSince = now;
      if (this.strainedIntervals >= 3 && now - this.changed > 10_000 && this.level < profiles.length - 1) this.adapt(this.level + 1);
    } else if (feedback && this.level > 0 && this.estimate > profiles[this.level - 1]!.bitrate * 1.2 && now - this.goodSince > 20_000 && now - this.changed > 20_000) this.adapt(this.level - 1);
  }

  private adapt(level: number): void {
    this.level = level; this.changed = performance.now(); this.needsKey = true;
    this.events.log(`[screen] Windows video profile: ${JSON.stringify(windowsVideoProfile(level, this.request))}`);
    this.captureSerial = this.captureSerial.then(async () => { await this.stopCapture(); this.startCapture(); }).catch(error => this.fail(String(error)));
  }

  private stopCapture(): Promise<void> {
    this.pending = [];
    const child = this.child; this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
    });
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
    clearInterval(this.monitor); clearTimeout(this.timeout);
    this.release();
    void this.stopCapture();
    void this.pc.close().catch(() => {});
  }
}
