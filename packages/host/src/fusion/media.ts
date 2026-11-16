import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, useAbsSendTime, useH264, useSdesMid, type RTCDataChannel, type RTCRtpTransceiver } from "werift";
import { H264_MIME, ScreenInputOrder, h264Nals, h264Payloads } from "../screen-h264.js";
import { inputEvent } from "../input.js";
import type { FusionVideoSource } from "./platform.js";

/**
 * The pictures of one Fusion session on a Node remote (docs/v2/fusion.md §5, §8.2): one werift
 * peer connection, one send-only video transceiver per stream, the four channels of screen
 * sharing shared by all of them. Each access unit gets the same SEI the Mac's encoder writes
 * (`FusionMetadata.swift`), so either local half crops it the same way.
 */
export type FusionLayout = number[] | number[][];

const UUID = Buffer.from("LinkShellFusion1");

/** An H.264 SEI NAL (user data unregistered) carrying `layout`, with emulation prevention. */
export function fusionSei(layout: FusionLayout): Buffer {
  const payload = Buffer.concat([UUID, Buffer.from(JSON.stringify(layout))]);
  const rbsp: number[] = [5];
  let size = payload.length;
  while (size >= 255) { rbsp.push(255); size -= 255; }
  rbsp.push(size, ...payload, 0x80);
  const out: number[] = [0, 0, 0, 1, 6];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) { out.push(3); zeros = 0; }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/**
 * One message of the input channels: which stream it is for, and the event itself. `stream`
 * names the window; 0.10.106 wrote it to `k`, over a key event's own `k` (the key's name), so
 * its other events are still read here and its named keys were lost before they arrived.
 */
export function fusionInput(message: Record<string, unknown>): { stream: string; event: Record<string, unknown> } | undefined {
  const { stream, ...event } = message;
  if (typeof stream === "string") {
    // What has no `k` of its own carries the stream there too, for a 0.10.106 remote.
    if (event.t !== "key") delete event.k;
    return { stream, event };
  }
  if (typeof event.k !== "string") return undefined;
  const legacy = event.k;
  delete event.k;
  return { stream: legacy, event };
}

/**
 * RTP numbering belongs to the transceiver: its SSRC stays in the SDP while it waits in the spare
 * list, so the receiver keeps its jitter and frame buffers, and a reused one must go on counting
 * where it stopped. Fresh random numbers would read as old packets there and be dropped.
 */
interface RtpState { seq: number; timestamp: number; lastFrame: number }

interface Stream {
  key: string;
  transceiver: RTCRtpTransceiver;
  rtp: RtpState;
  source?: FusionVideoSource;
  layout: () => FusionLayout | undefined;
  /** The receiver cannot decode what comes next: nothing but a key picture, or the replay, goes out. */
  needsKey: boolean;
  /** The receiver knows this stream's mid (its offer was answered): nothing is sent before. */
  announced: boolean;
  started?: boolean;
  parameterSets: Map<number, Buffer>;
  /**
   * Every access unit since the last key picture, as the encoder made them. A window's capture
   * stops while the window does not change (Windows.Graphics.Capture sends a frame per change),
   * so a receiver that connects, or loses a packet, minutes later gets no new key picture to
   * start from: it is sent these again, and has the window as it is now.
   */
  replay: Buffer[];
  replayBytes: number;
  replayedAt: number;
  replayTimer?: ReturnType<typeof setTimeout>;
  sending: Promise<void>;
  /** Encoders that ended one after another without lasting; a lasting one starts the count again. */
  failures: number;
  sourceAt: number;
  restartTimer?: ReturnType<typeof setTimeout>;
}

/**
 * An encoder that ends is started again (the window's monitor changed, the desktop was locked,
 * the capture failed once): after this many in a row that did not last, the stream is reported.
 */
const RESTART_LIMIT = 5;
const RESTART_LASTED_MS = 20_000;
/** An offer nobody answers must not keep every later window from being offered. */
const ANSWER_TIMEOUT_MS = 10_000;

/** A replay longer than this is given up: the receiver waits for the next key picture, as it did before. */
const REPLAY_MAX_UNITS = 240;
const REPLAY_MAX_BYTES = 8 << 20;
/** Lost packets come in bursts: one replay answers them all. */
const REPLAY_EVERY_MS = 1000;

export interface FusionMediaEvents {
  signal(payload: Record<string, unknown>): void;
  input(key: string, event: Record<string, unknown>): void;
  error(key: string, message: string): void;
  log(line: string): void;
}

export class FusionNodeMedia {
  private readonly pc: RTCPeerConnection;
  private readonly streams = new Map<string, Stream>();
  private readonly spare: RTCRtpTransceiver[] = [];
  private readonly rtp = new WeakMap<RTCRtpTransceiver, RtpState>();
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly order = new ScreenInputOrder();
  /** The streams of the offer the receiver is answering. */
  private offered: Stream[] = [];
  private negotiating = false;
  private answerTimer?: ReturnType<typeof setTimeout>;
  private offerWanted = false;
  private offerTimer?: ReturnType<typeof setTimeout>;
  private serial: Promise<void> = Promise.resolve();
  private connected = false;
  private closed = false;

  constructor(iceServers: Array<{ urls: string; username?: string; credential?: string }>, private readonly events: FusionMediaEvents) {
    this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      codecs: { video: [
        // Level 5.1: a window's canvas is its monitor, up to 4K (4.2 stops at 1080p).
        useH264({ mimeType: H264_MIME, payloadType: 96, parameters: "profile-level-id=42e033;packetization-mode=1;level-asymmetry-allowed=1" }),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000, payloadType: 97, parameters: "apt=96" }),
      ] },
      headerExtensions: { video: [useSdesMid(), useAbsSendTime()] },
    });
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && !this.closed) this.events.signal({ t: "ice", ...candidate.toJSON() });
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      this.connected = state === "connected";
      // As the Mac remote logs it: what a field report needs to tell "never connected" from "no pictures".
      this.events.log(`[fusion] media: connection ${state}`);
      this.events.signal({ t: "state", connection: state });
      if (this.connected) for (const stream of this.streams.values()) this.wantKey(stream);
    });
    for (const label of ["input", "pointer", "cursor", "shape"]) {
      const lossy = label === "pointer" || label === "cursor";
      const channel = this.pc.createDataChannel(label, lossy ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      this.channels.set(label, channel);
      if (label !== "input" && label !== "pointer") continue;
      channel.onMessage.subscribe((data) => {
        if (this.closed || typeof data !== "string" || data.length > 32_000) return;
        try {
          const input = fusionInput(JSON.parse(data) as Record<string, unknown>);
          if (!input || !this.streams.has(input.stream)) return;
          if (inputEvent.safeParse(input.event).success && this.order.accept(input.event, lossy)) this.events.input(input.stream, input.event);
        } catch { /* Invalid input never ends a session. */ }
      });
    }
  }

  start(iceServers: unknown[]): void {
    this.events.signal({ t: "config", iceServers });
    this.wantOffer();
  }

  /** A stream: its encoder starts now; the receiver learns its mid with the next offer. */
  open(key: string, start: (onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void) => FusionVideoSource, layout: () => FusionLayout | undefined): void {
    if (this.closed || this.streams.has(key)) return;
    let transceiver = this.spare.pop();
    if (transceiver) transceiver.setDirection("sendonly");
    else {
      transceiver = this.pc.addTransceiver("video", { direction: "sendonly" });
      this.rtp.set(transceiver, { seq: randomBytes(2).readUInt16BE(), timestamp: randomBytes(4).readUInt32BE(), lastFrame: performance.now() });
      const owner = transceiver;
      transceiver.sender.onPictureLossIndication.subscribe(() => {
        for (const stream of this.streams.values()) if (stream.transceiver === owner) this.wantKey(stream);
      });
    }
    const stream: Stream = {
      key, transceiver, rtp: this.rtp.get(transceiver)!, layout, needsKey: true, announced: false, parameterSets: new Map(),
      replay: [], replayBytes: 0, replayedAt: 0, sending: Promise.resolve(), failures: 0, sourceAt: 0,
    };
    this.streams.set(key, stream);
    this.startSource(stream, start);
    this.wantOffer();
  }

  private startSource(stream: Stream, start: Parameters<FusionNodeMedia["open"]>[1]): void {
    const current = () => !this.closed && this.streams.get(stream.key) === stream;
    stream.sourceAt = performance.now();
    let over = false;
    const ended = (reason: string) => {
      if (over || !current()) return;
      over = true;
      stream.failures = performance.now() - stream.sourceAt > RESTART_LASTED_MS ? 1 : stream.failures + 1;
      if (stream.failures > RESTART_LIMIT) return this.events.error(stream.key, reason);
      this.events.log(`[fusion] stream ${stream.key} ended (${reason.slice(0, 200)}); starting it again`);
      stream.restartTimer = setTimeout(() => {
        if (!current()) return;
        // The new encoder's pictures do not follow the old one's.
        stream.replay = []; stream.replayBytes = 0; stream.needsKey = true;
        this.startSource(stream, start);
      }, Math.min(8_000, 500 * 2 ** (stream.failures - 1)));
      stream.restartTimer.unref?.();
    };
    try {
      stream.source = start((unit, isKey) => { if (!over) this.frame(stream, unit, isKey); }, ended);
    } catch (error) {
      ended(error instanceof Error ? error.message : String(error));
    }
  }

  close(key: string): void {
    const stream = this.streams.get(key);
    if (!stream) return;
    this.streams.delete(key);
    clearTimeout(stream.replayTimer);
    clearTimeout(stream.restartTimer);
    stream.replay = [];
    stream.source?.stop();
    stream.transceiver.setDirection("inactive");
    this.spare.push(stream.transceiver);
    this.wantOffer();
  }

  receive(m: Record<string, unknown>): void {
    if (this.closed) return;
    if (m.t === "control") {
      // SendInput needs no permission on Windows; locked or secure desktops are told as alerts.
      this.events.signal({ t: "control", available: true, trusted: true });
      return;
    }
    this.serial = this.serial.then(async () => {
      if (this.closed) return;
      if (m.t === "answer" && typeof m.sdp === "string") {
        clearTimeout(this.answerTimer);
        // Whatever becomes of this answer, the next offer must be free to go.
        try { await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }); }
        finally { this.negotiating = false; }
        // The receiver has these streams' mids now: each starts from a key picture.
        for (const stream of this.offered) {
          if (stream.announced || this.streams.get(stream.key) !== stream) continue;
          stream.announced = true;
          this.wantKey(stream);
        }
        if (this.offerWanted) this.wantOffer();
      } else if (m.t === "ice" && typeof m.candidate === "string") {
        await this.pc.addIceCandidate({ candidate: m.candidate, sdpMid: (m.sdpMid as string | undefined) ?? undefined, sdpMLineIndex: Number(m.sdpMLineIndex ?? 0) });
      }
    }).catch((error) => this.events.log(`[fusion] media signal: ${String(error)}`));
  }

  private wantOffer(): void {
    this.offerWanted = true;
    if (this.negotiating || this.offerTimer || this.closed) return;
    this.offerTimer = setTimeout(() => {
      this.offerTimer = undefined;
      this.serial = this.serial.then(() => this.offer()).catch((error) => {
        this.negotiating = false;
        this.events.log(`[fusion] media offer: ${String(error)}`);
      });
    }, 50);
  }

  private async offer(): Promise<void> {
    if (this.closed || this.negotiating || !this.offerWanted) return;
    this.offerWanted = false;
    this.negotiating = true;
    const offer = await this.pc.createOffer();
    // werift gives the transceivers their mids as it starts to apply the offer, and only then waits
    // for ICE gathering: seconds, on a computer with many interfaces or a STUN server out of
    // reach. The offer goes out now and the candidates follow, as they do for the remote screen.
    const applied = this.pc.setLocalDescription(offer);
    applied.catch((error) => this.events.log(`[fusion] media offer: ${String(error)}`));
    if ([...this.streams.values()].some((s) => !s.transceiver.mid)) await applied.catch(() => undefined);
    if (this.closed) return;
    // The receiver must know the mids before it sees the tracks.
    this.offered = [...this.streams.values()].filter((s) => s.transceiver.mid);
    const streams = this.offered.map((s) => ({ k: s.key, mid: s.transceiver.mid! }));
    this.events.signal({ t: "streams", streams });
    this.events.signal({ t: "offer", sdp: offer.sdp });
    clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      if (this.closed || !this.negotiating) return;
      this.events.log("[fusion] media offer was not answered; offering again");
      this.negotiating = false;
      this.wantOffer();
    }, ANSWER_TIMEOUT_MS);
    this.answerTimer.unref?.();
  }

  /** An access unit from a stream's encoder: kept for a replay, and sent when the receiver can use it. */
  private frame(stream: Stream, unit: Buffer, key: boolean): void {
    for (const nal of h264Nals(unit)) {
      const type = nal[0]! & 31;
      if (type === 7 || type === 8) stream.parameterSets.set(type, Buffer.from(nal));
    }
    if (this.closed || this.streams.get(stream.key) !== stream) return;
    if (key) { stream.replay = []; stream.replayBytes = 0; }
    if (key || stream.replay.length) {
      stream.replay.push(unit);
      stream.replayBytes += unit.length;
      if (stream.replay.length > REPLAY_MAX_UNITS || stream.replayBytes > REPLAY_MAX_BYTES) { stream.replay = []; stream.replayBytes = 0; }
    }
    if (!this.connected || !stream.announced) return;
    // Waiting for a key picture: what is skipped here is in the replay, if one goes out first.
    if (stream.needsKey && !key) return;
    if (this.send(stream, unit, key)) { stream.needsKey = false; this.started(stream); }
  }

  private started(stream: Stream): void {
    if (stream.started) return;
    stream.started = true;
    this.events.log(`[fusion] ${stream.key}: first picture sent (mid ${stream.transceiver.mid})`);
  }

  /** The receiver needs a picture to start from: the replay if there is one, else the next key picture. */
  private wantKey(stream: Stream): void {
    stream.needsKey = true;
    this.catchUp(stream);
  }

  private catchUp(stream: Stream): void {
    clearTimeout(stream.replayTimer);
    stream.replayTimer = undefined;
    if (this.closed || !this.connected || !stream.announced || !stream.needsKey || this.streams.get(stream.key) !== stream) return;
    const later = (ms: number) => { stream.replayTimer = setTimeout(() => this.catchUp(stream), ms); stream.replayTimer.unref?.(); };
    if (!stream.replay.length) return;
    const wait = stream.replayedAt + REPLAY_EVERY_MS - performance.now();
    if (wait > 0) return later(wait);
    // No crop yet (the window is being laid out): a picture without one would be drawn wrong.
    if (!stream.layout()) return later(100);
    stream.replayedAt = performance.now();
    stream.needsKey = false;
    stream.replay.forEach((unit, index) => this.send(stream, unit, index === 0));
    this.started(stream);
  }

  /** Packetizes one access unit with the stream's crop metadata; false when there is no crop to send it with. */
  private send(stream: Stream, unit: Buffer, key: boolean): boolean {
    const layout = stream.layout();
    // A frame without metadata is dropped by the local side once it has seen one: send none rather than a wrong crop.
    if (!layout) return false;
    const now = performance.now();
    stream.rtp.timestamp = (stream.rtp.timestamp + Math.max(1, Math.round((now - stream.rtp.lastFrame) * 90))) >>> 0;
    stream.rtp.lastFrame = now;
    const nals = h264Nals(unit);
    const missing = key ? [...stream.parameterSets].filter(([type]) => !nals.some((nal) => (nal[0]! & 31) === type)).map(([, nal]) => Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])) : [];
    const payloads = h264Payloads(Buffer.concat([...missing, fusionSei(layout), unit]));
    const timestamp = stream.rtp.timestamp;
    stream.sending = stream.sending.then(async () => {
      for (let i = 0; i < payloads.length; i += 32) {
        // A closed stream's transceiver may already carry another window: what is still queued
        // for the old one would go out between the new one's packets.
        if (this.closed || this.streams.get(stream.key) !== stream) return;
        await Promise.all(payloads.slice(i, i + 32).map((payload, offset) => stream.transceiver.sender.sendRtp(new RtpPacket(new RtpHeader({
          payloadType: 96, sequenceNumber: stream.rtp.seq++ & 0xffff, timestamp, ssrc: stream.transceiver.sender.ssrc, marker: i + offset === payloads.length - 1,
        }), payload))));
      }
    }).catch(() => undefined);
    return true;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.offerTimer);
    clearTimeout(this.answerTimer);
    for (const stream of this.streams.values()) { clearTimeout(stream.replayTimer); clearTimeout(stream.restartTimer); stream.source?.stop(); }
    this.streams.clear();
    void this.pc.close().catch(() => undefined);
  }
}
