import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, useAbsSendTime, useH264, useSdesMid, type RTCDataChannel, type RTCRtpTransceiver } from "werift";
import { ScreenInputOrder, h264Nals, h264Payloads } from "../screen-h264.js";
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
  needsKey: boolean;
  parameterSets: Map<number, Buffer>;
  sending: Promise<void>;
}

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
  private negotiating = false;
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
        useH264({ payloadType: 96, parameters: "profile-level-id=42e033;packetization-mode=1;level-asymmetry-allowed=1" }),
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
      this.events.signal({ t: "state", connection: state });
      if (this.connected) for (const stream of this.streams.values()) stream.needsKey = true;
    });
    for (const label of ["input", "pointer", "cursor", "shape"]) {
      const lossy = label === "pointer" || label === "cursor";
      const channel = this.pc.createDataChannel(label, lossy ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      this.channels.set(label, channel);
      if (label !== "input" && label !== "pointer") continue;
      channel.onMessage.subscribe((data) => {
        if (this.closed || typeof data !== "string" || data.length > 32_000) return;
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          const key = typeof message.k === "string" ? message.k : "";
          if (!this.streams.has(key)) return;
          const { k: _k, ...event } = message;
          if (inputEvent.safeParse(event).success && this.order.accept(event, lossy)) this.events.input(key, event);
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
        for (const stream of this.streams.values()) if (stream.transceiver === owner) stream.needsKey = true;
      });
    }
    const stream: Stream = {
      key, transceiver, rtp: this.rtp.get(transceiver)!, layout, needsKey: true, parameterSets: new Map(), sending: Promise.resolve(),
    };
    this.streams.set(key, stream);
    stream.source = start(
      (unit, isKey) => this.frame(stream, unit, isKey),
      (reason) => { if (this.streams.get(key) === stream) this.events.error(key, reason); },
    );
    this.wantOffer();
  }

  close(key: string): void {
    const stream = this.streams.get(key);
    if (!stream) return;
    this.streams.delete(key);
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
        await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
        this.negotiating = false;
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
    await this.pc.setLocalDescription(offer);
    // The mids exist only now; the receiver must know them before it sees the tracks.
    const streams = [...this.streams.values()].flatMap((s) => (s.transceiver.mid ? [{ k: s.key, mid: s.transceiver.mid }] : []));
    this.events.signal({ t: "streams", streams });
    this.events.signal({ t: "offer", sdp: this.pc.localDescription?.sdp ?? offer.sdp });
  }

  private frame(stream: Stream, unit: Buffer, key: boolean): void {
    for (const nal of h264Nals(unit)) {
      const type = nal[0]! & 31;
      if (type === 7 || type === 8) stream.parameterSets.set(type, Buffer.from(nal));
    }
    if (!this.connected || this.closed || this.streams.get(stream.key) !== stream) return;
    if (stream.needsKey && !key) return;
    stream.needsKey = false;
    const layout = stream.layout();
    const now = performance.now();
    stream.rtp.timestamp = (stream.rtp.timestamp + Math.max(1, Math.round((now - stream.rtp.lastFrame) * 90))) >>> 0;
    stream.rtp.lastFrame = now;
    const nals = h264Nals(unit);
    const missing = key ? [...stream.parameterSets].filter(([type]) => !nals.some((nal) => (nal[0]! & 31) === type)).map(([, nal]) => Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])) : [];
    // A frame without metadata is dropped by the local side once it has seen one: send none rather than a wrong crop.
    if (!layout) return;
    const payloads = h264Payloads(Buffer.concat([...missing, fusionSei(layout), unit]));
    const timestamp = stream.rtp.timestamp;
    stream.sending = stream.sending.then(async () => {
      for (let i = 0; i < payloads.length; i += 32) {
        if (this.closed) return;
        await Promise.all(payloads.slice(i, i + 32).map((payload, offset) => stream.transceiver.sender.sendRtp(new RtpPacket(new RtpHeader({
          payloadType: 96, sequenceNumber: stream.rtp.seq++ & 0xffff, timestamp, ssrc: stream.transceiver.sender.ssrc, marker: i + offset === payloads.length - 1,
        }), payload))));
      }
    }).catch(() => undefined);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.offerTimer);
    for (const stream of this.streams.values()) stream.source?.stop();
    this.streams.clear();
    void this.pc.close().catch(() => undefined);
  }
}
