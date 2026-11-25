import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeScreenAudioPacket, SCREEN_AUDIO_CODEC_PCM16 } from "@linkshell/wire";
import { RTCPeerConnection, useH264, type RTCDataChannel } from "werift";
import { H264AccessUnits, h264Nals, h264Payloads, ScreenInputOrder } from "../src/screen-h264.js";
import { weriftIceServers, WindowsAudioSplitter, WindowsVideoSession, windowsVideoProfile } from "../src/windows-video.js";
import { viewerPage } from "../src/screen-viewer.js";

const nal = (type: number, bytes = Buffer.from([7, 8, 9])) => Buffer.concat([Buffer.from([0, 0, 0, 1, type]), bytes]);
const aud = nal(9, Buffer.from([0xf0]));

describe("the Windows sender's ICE servers", () => {
  it("keeps the UDP TURN address with its login, and leaves the TCP and TLS ones werift can't use", () => {
    expect(weriftIceServers([
      { urls: ["stun:turn.example.com:3478"] },
      { urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp", "turns:turn.example.com:443?transport=tcp"], username: "u", credential: "c" },
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ])).toEqual([
      { urls: "stun:turn.example.com:3478" },
      { urls: "turn:turn.example.com:3478?transport=udp", username: "u", credential: "c" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
  });
});

describe("Windows H.264 media", () => {
  it("keeps complete access units across every pipe boundary and identifies IDRs", () => {
    const first = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]);
    const second = Buffer.concat([aud, nal(0x41)]);
    const bytes = Buffer.concat([first, second, aud]);
    for (let split = 1; split < bytes.length; split++) {
      const parser = new H264AccessUnits(), result: [Buffer, boolean][] = [];
      parser.push(bytes.subarray(0, split), (unit, key) => result.push([unit, key]));
      parser.push(bytes.subarray(split), (unit, key) => result.push([unit, key]));
      expect(result).toEqual([[first, true], [second, false]]);
    }
    const parser = new H264AccessUnits(), result: Buffer[] = [];
    for (const byte of bytes) parser.push(Buffer.from([byte]), unit => result.push(unit));
    expect(result).toEqual([first, second]);
  });
  it("hands on a framed picture with its last byte, at every pipe boundary", () => {
    const chunk = (unit: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32LE(unit.length); return Buffer.concat([Buffer.from("00dc"), size, unit, Buffer.alloc(unit.length & 1)]); };
    const first = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]);
    const second = Buffer.concat([aud, nal(0x41), Buffer.from([7])]);
    // What FFmpeg's AVI muxer writes before the pictures, a stand-in: headers that are not chunks of pictures.
    const header = Buffer.concat([Buffer.from("RIFF\xff\xff\xff\xffAVI LIST", "latin1"), Buffer.alloc(40, 0x30), Buffer.from("00dcLIST\xff\xff\xff\xffmovi", "latin1")]);
    const empty = Buffer.concat([Buffer.from("00dc"), Buffer.alloc(4)]);
    const bytes = Buffer.concat([header, chunk(first), empty, empty, chunk(second)]);
    for (let split = 1; split < bytes.length; split++) {
      const parser = new H264AccessUnits(), result: [Buffer, boolean][] = [];
      parser.push(bytes.subarray(0, split), (unit, key) => result.push([Buffer.from(unit), key]));
      // The first picture is whole as soon as its own bytes are: nothing of the next is needed.
      if (split >= header.length + 8 + first.length && split < bytes.length - 1) expect(result).toEqual([[first, true]]);
      if (split < header.length + 8 + first.length) expect(result).toEqual([]);
      parser.push(bytes.subarray(split), (unit, key) => result.push([Buffer.from(unit), key]));
      expect(result).toEqual([[first, true], [second, false]]);
    }
    const parser = new H264AccessUnits(), result: Buffer[] = [];
    for (const byte of bytes) parser.push(Buffer.from([byte]), unit => result.push(Buffer.from(unit)));
    expect(result).toEqual([first, second]);
  });
  it("finds the next framed picture after bytes that are not one", () => {
    const chunk = (unit: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32LE(unit.length); return Buffer.concat([Buffer.from("00dc"), size, unit, Buffer.alloc(unit.length & 1)]); };
    const first = Buffer.concat([aud, nal(0x65)]), second = Buffer.concat([aud, nal(0x41)]);
    const parser = new H264AccessUnits(), result: Buffer[] = [];
    parser.push(Buffer.concat([Buffer.from("RIFF"), chunk(first), Buffer.from("ix00\x04\x00\x00\x00junk00dcxx", "latin1"), chunk(second)]), unit => result.push(Buffer.from(unit)));
    expect(result).toEqual([first, second]);
    // A long run of nothing is let go of, not kept.
    for (let i = 0; i < 40; i++) parser.push(Buffer.alloc(1024 * 1024, 0x30), () => {});
    parser.push(chunk(first), unit => result.push(Buffer.from(unit)));
    expect(result).toEqual([first, second, first]);
  });
  it("bounds malformed encoder output", () => {
    const parser = new H264AccessUnits();
    parser.push(Buffer.alloc(16 * 1024 * 1024), () => {});
    expect(() => parser.push(Buffer.from([1]), () => {})).toThrow(/too large/);
  });
  it("does not count duplicate hardware AUDs as frames", () => {
    const parser = new H264AccessUnits(), pictures: Buffer[] = [];
    const frame = Buffer.concat([aud, nal(0x65)]);
    parser.push(Buffer.concat([aud, frame, aud, aud]), unit => pictures.push(unit));
    expect(pictures).toEqual([frame]);
  });
  it("fragments large slices into valid FU-A packets and preserves parameter sets", () => {
    const slice = Buffer.alloc(4000, 0x78);
    const unit = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65, slice)]);
    const payloads = h264Payloads(unit, 1000);
    expect(payloads.every(packet => packet.length <= 1000)).toBe(true);
    expect(payloads.slice(0, 2)).toEqual(h264Nals(unit).slice(1, 3));
    const fragments = payloads.slice(2);
    expect(fragments[0]!.subarray(0, 2)).toEqual(Buffer.from([0x7c, 0x85]));
    expect(fragments.at(-1)![1]).toBe(0x45);
    expect(Buffer.concat(fragments.map(part => part.subarray(2)))).toEqual(slice);
    expect(h264Payloads(nal(0x41))).toEqual([Buffer.from([0x41, 7, 8, 9])]);
  });
  it("drops late lossy moves without losing reliable button releases", () => {
    const order = new ScreenInputOrder();
    expect(order.accept({ t: "down", i: 4 }, false)).toBe(true);
    expect(order.accept({ t: "move", i: 3 }, true)).toBe(false);
    expect(order.accept({ t: "move", i: 6 }, true)).toBe(true);
    expect(order.accept({ t: "up", i: 5 }, false)).toBe(true);
    expect(order.accept({ t: "key", i: 7 }, true)).toBe(false);
    expect(order.accept({ t: "move" }, true)).toBe(true);
  });
  it("respects receiver ceilings while enabling standard video on Windows", () => {
    expect(windowsVideoProfile(0, { maxWidth: 1280, maxFps: 30 })).toMatchObject({ width: 1280, fps: 30 });
    expect(windowsVideoProfile(0, { maxFps: 120 })).toMatchObject({ width: 1920, fps: 60 });
    const qhd = windowsVideoProfile(0, { maxWidth: 2560, maxFps: 60 });
    expect(qhd).toMatchObject({ width: 2560, fps: 60 });
    expect(qhd.bitrate).toBeGreaterThan(12_000_000);
    expect(qhd.bitrate).toBeLessThanOrEqual(16_000_000);
    expect(windowsVideoProfile(0, { maxWidth: 3840, maxFps: 60 })).toMatchObject({ width: 2560, fps: 60 });
    expect(windowsVideoProfile(1, { maxWidth: 2560, maxFps: 60 })).toMatchObject({ width: 1600, fps: 60 });
    expect(windowsVideoProfile(4, {})).toMatchObject({ width: 640, fps: 20 });
    const page = viewerPage("win32");
    expect(page).toContain('const wantVideo = !nativePicture && "RTCPeerConnection" in window');
    expect(page).toContain('if (windowsHost)');
  });
});

describe("what a small computer can make", () => {
  it("moves past the profiles that ask for more frames than it makes", async () => {
    const { windowsSlowerLevel } = await import("../src/windows-video.js");
    // 32 frames a second at 1920 / 60: 1600 / 60 would be left the same way, 1280 / 30 fits.
    expect(windowsSlowerLevel(0, 32)).toBe(2);
    expect(windowsSlowerLevel(0, 58)).toBe(1);
    // The network's doing: one step, as before.
    expect(windowsSlowerLevel(0, undefined)).toBe(1);
    expect(windowsSlowerLevel(4, 5)).toBe(4);
  });

  it("starts the next viewer where the computer coped, and tries one step higher half an hour later", async () => {
    const { noteWindowsMachineLevel, windowsMachineLevel } = await import("../src/windows-video.js");
    noteWindowsMachineLevel(2, 1_000_000);
    expect(windowsMachineLevel(1_000_000 + 60_000)).toBe(2);
    expect(windowsMachineLevel(1_000_000 + 31 * 60_000)).toBe(1);
    noteWindowsMachineLevel(0, 0);
    expect(windowsMachineLevel(10)).toBe(0);
  });

  it("remembers which encoder path made pictures, for the helper to try first", async () => {
    const { noteWindowsVideo, windowsVideoEnv } = await import("../src/windows-screen.js");
    expect(windowsVideoEnv().LINKSHELL_WINDOWS_VIDEO_HINT).toBeUndefined();
    noteWindowsVideo("[video] child=4300\n[video:h264_qsv] Could not create the texture (80070057)\n");
    expect(windowsVideoEnv().LINKSHELL_WINDOWS_VIDEO_HINT).toBeUndefined();
    noteWindowsVideo("[video] encoder=h264_qsv width=1920 height=1280 fps=30 path=compatible\n");
    expect(windowsVideoEnv().LINKSHELL_WINDOWS_VIDEO_HINT).toBe("h264_qsv:compatible");
  });
});

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdinLines: string[] = [];

  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        this.stdinLines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    this.stdin.on("finish", () => {
      if (this.exitCode === null) {
        this.exitCode = 0;
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.signalCode = signal;
    this.exitCode = 0;
    this.emit("exit", 0, signal);
    this.emit("close", 0, signal);
    return true;
  }
}

function audioFrame(timestampMs: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt32LE(timestampMs >>> 0, 4);
  return Buffer.concat([head, payload]);
}

describe("Windows audio & cursor shape streaming", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("splits length-and-timestamp-prefixed 48kHz stereo PCM16 frames across arbitrary boundaries", () => {
    const p1 = Buffer.alloc(3840, 0x11);
    const p2 = Buffer.alloc(3840, 0x22);
    const wire = Buffer.concat([audioFrame(100, p1), audioFrame(120, p2)]);
    const splitter = new WindowsAudioSplitter();
    const out: Array<{ timestampMs: number; payload: Buffer }> = [];
    for (const byte of wire) splitter.push(Buffer.from([byte]), frame => out.push(frame));
    expect(out).toHaveLength(2);
    expect(out[0]!.timestampMs).toBe(100);
    expect(out[0]!.payload.equals(p1)).toBe(true);
    expect(out[1]!.timestampMs).toBe(120);
    expect(out[1]!.payload.equals(p2)).toBe(true);

    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(6, 0); // not 4-byte aligned PCM16 stereo
    expect(() => new WindowsAudioSplitter().push(bad, () => {})).toThrow(/length/);
  });

  it("streams cursor shapes on shape channel and toggles audio via offer.audio and setAudio without stopping video", async () => {
    const spawned: Array<{ args: string[]; proc: FakeProcess }> = [];
    const receiver = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    cleanups.push(() => { void receiver.close().catch(() => {}); });

    const channels = new Map<string, RTCDataChannel>();
    const shapeMessages: Array<Record<string, unknown>> = [];
    const audioPackets: ReturnType<typeof decodeScreenAudioPacket>[] = [];
    receiver.onDataChannel.subscribe(ch => {
      channels.set(ch.label, ch);
      ch.onMessage.subscribe(data => {
        if (ch.label === "shape" && typeof data === "string") shapeMessages.push(JSON.parse(data) as Record<string, unknown>);
        if (ch.label === "audio" && Buffer.isBuffer(data)) audioPackets.push(decodeScreenAudioPacket(data));
      });
    });

    const session = new WindowsVideoSession(
      { screen: 0, iceServers: [], audio: true },
      {
        tell: message => {
          const m = message as { t: string; sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
          if (m.t === "offer" && m.sdp) {
            void (async () => {
              await receiver.setRemoteDescription({ type: "offer", sdp: m.sdp! });
              const answer = await receiver.createAnswer();
              await receiver.setLocalDescription(answer);
              session.signal({ t: "rtc.answer", sdp: receiver.localDescription!.sdp });
            })();
          } else if (m.t === "ice" && m.candidate) {
            void receiver.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid ?? undefined, sdpMLineIndex: m.sdpMLineIndex ?? 0 }).catch(() => {});
          }
        },
        input: () => {},
        lost: () => {},
        log: () => {},
      },
      {
        helper: () => "C:\\Program Files\\LinkShell\\LinkShell.Screen.exe",
        media: () => "C:\\Program Files\\LinkShell\\media\\ffmpeg.exe",
        spawn: ((_cmd: string, args: string[]) => {
          const proc = new FakeProcess();
          spawned.push({ args, proc });
          return proc as never;
        }) as unknown as typeof import("node:child_process").spawn,
      },
    );
    cleanups.push(() => session.end());
    receiver.onIceCandidate.subscribe(c => {
      if (c) session.signal({ t: "rtc.ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
    });

    const offerPromise = session.offer();
    await vi.waitFor(() => {
      expect(spawned.some(s => s.args[0] === "--video")).toBe(true);
      expect(spawned.some(s => s.args[0] === "--shape")).toBe(true);
      expect(spawned.some(s => s.args[0] === "--audio")).toBe(true);
    });

    const videoProc = spawned.find(s => s.args[0] === "--video")!.proc;
    const shapeProc = spawned.find(s => s.args[0] === "--shape")!.proc;
    const firstAudioProc = spawned.find(s => s.args[0] === "--audio")!.proc;

    // Emit initial shape BEFORE DataChannel opens — verify replay upon open.
    shapeProc.stdout.write(`${JSON.stringify({ t: "shape", id: "arrow-1", png: "AAAA", w: 32, h: 32, hotX: 1, hotY: 1, scale: 1, displayW: 1920, displayH: 1080 })}\n`);

    // Warm video encoder with an AVI movi chunk.
    const unit = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]);
    const chunkSize = Buffer.alloc(4);
    chunkSize.writeUInt32LE(unit.length, 0);
    const aviHeader = Buffer.concat([Buffer.from("RIFF\xff\xff\xff\xffAVI LIST", "latin1"), Buffer.alloc(40, 0x30), Buffer.from("00dcLIST\xff\xff\xff\xffmovi", "latin1")]);
    videoProc.stdout.write(Buffer.concat([aviHeader, Buffer.from("00dc"), chunkSize, unit]));
    await offerPromise;

    await vi.waitFor(() => {
      expect(channels.get("shape")?.readyState).toBe("open");
      expect(channels.get("audio")?.readyState).toBe("open");
    }, { timeout: 10_000 });

    // Initial shape arrived on open with full PNG metadata.
    await vi.waitFor(() => expect(shapeMessages).toHaveLength(1));
    expect(shapeMessages[0]).toMatchObject({ t: "shape", id: "arrow-1", png: "AAAA", w: 32, h: 32, hotX: 1, hotY: 1, scale: 1, displayW: 1920, displayH: 1080 });

    // Changing to a second shape sends full PNG; switching back to arrow-1 sends id-only.
    shapeProc.stdout.write(`${JSON.stringify({ t: "shape", id: "ibeam-2", png: "BBBB", w: 16, h: 32, hotX: 8, hotY: 16, scale: 1, displayW: 1920, displayH: 1080 })}\n`);
    shapeProc.stdout.write(`${JSON.stringify({ t: "shape", id: "arrow-1" })}\n`);
    await vi.waitFor(() => expect(shapeMessages).toHaveLength(3));
    expect(shapeMessages[1]).toMatchObject({ t: "shape", id: "ibeam-2", png: "BBBB" });
    expect(shapeMessages[2]).toEqual({ t: "shape", id: "arrow-1" });

    // PCM16 audio frame is packetized using encodeScreenAudioPacket and sent over "audio" channel.
    const pcm = Buffer.alloc(3840, 0x42);
    firstAudioProc.stdout.write(audioFrame(240, pcm));
    await vi.waitFor(() => expect(audioPackets).toHaveLength(1));
    expect(audioPackets[0]).toMatchObject({ version: 1, codec: SCREEN_AUDIO_CODEC_PCM16, timestampMs: 240 });
    expect(Buffer.from(audioPackets[0]!.payload).equals(pcm)).toBe(true);

    // Muting stops only the audio helper; video keeps running.
    session.setAudio(false);
    await vi.waitFor(() => expect(firstAudioProc.exitCode).toBe(0));
    expect(videoProc.exitCode).toBeNull();

    // Unmuting spawns a fresh audio helper and resumes packet delivery.
    session.setAudio(true);
    await vi.waitFor(() => expect(spawned.filter(s => s.args[0] === "--audio")).toHaveLength(2));
    const secondAudioProc = spawned.filter(s => s.args[0] === "--audio")[1]!.proc;
    const pcm2 = Buffer.alloc(3840, 0x55);
    secondAudioProc.stdout.write(audioFrame(500, pcm2));
    await vi.waitFor(() => expect(audioPackets).toHaveLength(2));
    expect(audioPackets[1]!.timestampMs).toBe(500);
    expect(audioPackets[1]!.seq).toBe((audioPackets[0]!.seq + 1) & 0xffff);
  }, 20_000);
});

function aviChunk(unit: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(unit.length, 0);
  return Buffer.concat([Buffer.from("00dc"), size, unit, Buffer.alloc(unit.length & 1)]);
}

const AVI_HEADER = Buffer.concat([
  Buffer.from("RIFF\xff\xff\xff\xffAVI LIST", "latin1"),
  Buffer.alloc(40, 0x30),
  Buffer.from("00dcLIST\xff\xff\xff\xffmovi", "latin1"),
]);

describe("Windows video quality, pacing, recovery and in-band reconfigure", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) fn();
    const { noteWindowsMachineLevel } = await import("../src/windows-video.js");
    noteWindowsMachineLevel(0, 0);
  });

  it("offers Main, Constrained High, Baseline and TWCC; falls back to baseline env & dynamic payloadType when receiver only accepts Baseline", async () => {
    const spawned: Array<{ args: string[]; env?: NodeJS.ProcessEnv; proc: FakeProcess }> = [];
    let offerSdp = "";
    const session = new WindowsVideoSession(
      { screen: 0, iceServers: [] },
      {
        tell: message => {
          const m = message as { t: string; sdp?: string };
          if (m.t === "offer" && m.sdp) offerSdp = m.sdp;
        },
        input: () => {},
        lost: () => {},
        log: () => {},
      },
      {
        helper: () => "C:\\LinkShell\\LinkShell.Screen.exe",
        media: () => "C:\\LinkShell\\media\\ffmpeg.exe",
        spawn: ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
          const proc = new FakeProcess();
          spawned.push({ args, env: opts?.env, proc });
          return proc as never;
        }) as unknown as typeof import("node:child_process").spawn,
      },
    );
    cleanups.push(() => session.end());

    const offerPromise = session.offer();
    await vi.waitFor(() => expect(spawned.some(s => s.args[0] === "--video")).toBe(true));
    const firstVideo = spawned.find(s => s.args[0] === "--video")!;
    expect(firstVideo.env?.LINKSHELL_WINDOWS_PROFILE).toBeUndefined();

    const idr = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]);
    firstVideo.proc.stdout.write(Buffer.concat([AVI_HEADER, aviChunk(idr)]));
    await offerPromise;

    expect(offerSdp).toContain("profile-level-id=4d002a");
    expect(offerSdp).toContain("profile-level-id=640c2a");
    expect(offerSdp).toContain("profile-level-id=42e02a");
    expect(offerSdp).toContain("transport-cc");
    expect(offerSdp).toContain("draft-holmer-rmcat-transport-wide-cc-extensions-01");

    // Craft a realistic receiver answer accepting ONLY Baseline (PT 100) + RTX (PT 101).
    const fakeRx = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    cleanups.push(() => { void fakeRx.close().catch(() => {}); });
    await fakeRx.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const rawAnswer = await fakeRx.createAnswer();
    const baselineOnlyAnswer = rawAnswer.sdp
      .replace(/m=video 9 UDP\/TLS\/RTP\/SAVPF [^\r\n]+/, "m=video 9 UDP\/TLS\/RTP\/SAVPF 100")
      .split("\r\n")
      .filter(l => !/^a=(rtpmap|rtcp-fb|fmtp):(96|97|98|99)\b/.test(l))
      .join("\r\n");

    session.signal({ t: "rtc.answer", sdp: baselineOnlyAnswer });
    await vi.waitFor(() => expect(spawned.filter(s => s.args[0] === "--video")).toHaveLength(2));
    const secondVideo = spawned.filter(s => s.args[0] === "--video")[1]!;
    expect(secondVideo.env?.LINKSHELL_WINDOWS_PROFILE).toBe("baseline");

    const internals = session as unknown as {
      sender: { codec?: { payloadType: number }; sendRtp: (pkt: { header: { payloadType: number } }) => Promise<void> };
      connected: boolean;
      needsKey: boolean;
      frame(unit: Buffer, key: boolean, capturedAt: number): Promise<void>;
    };
    expect(internals.sender.codec?.payloadType).toBe(100);
    const sentPayloadTypes: number[] = [];
    internals.sender.sendRtp = async pkt => { sentPayloadTypes.push(pkt.header.payloadType); };
    internals.connected = true;
    internals.needsKey = false;
    await internals.frame(idr, true, performance.now());
    expect(sentPayloadTypes.length).toBeGreaterThan(0);
    expect(sentPayloadTypes.every(pt => pt === 100)).toBe(true);
  });

  it("does not freeze P-frames on PLI and preserves newer IDR on queue overflow", async () => {
    const session = new WindowsVideoSession(
      { screen: 0, iceServers: [] },
      { tell: () => {}, input: () => {}, lost: () => {}, log: () => {} },
    );
    cleanups.push(() => session.end());

    const internals = session as unknown as {
      sender: {
        onPictureLossIndication: { execute(): void };
        sendRtp: (pkt: unknown) => Promise<void>;
      };
      connected: boolean;
      needsKey: boolean;
      plis: number;
      sentFrames: number;
      sending: boolean;
      pending: { unit: Buffer; key: boolean; at: number }[];
      enqueue(unit: Buffer, key: boolean): void;
      frame(unit: Buffer, key: boolean, capturedAt: number): Promise<void>;
    };
    let rtpCalls = 0;
    internals.sender.sendRtp = async () => { rtpCalls++; };
    internals.connected = true;

    const idr = Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]);
    const pframe = Buffer.concat([aud, nal(0x41)]);
    await internals.frame(idr, true, performance.now());
    expect(internals.needsKey).toBe(false);
    const afterIdr = internals.sentFrames;

    // PLI must increment counter without gating subsequent P-frames.
    internals.sender.onPictureLossIndication.execute();
    expect(internals.plis).toBe(1);
    expect(internals.needsKey).toBe(false);
    await internals.frame(pframe, false, performance.now() + 16);
    expect(internals.sentFrames).toBe(afterIdr + 1);
    expect(rtpCalls).toBeGreaterThan(1);

    // Overflowing queue with a newer IDR already buffered slices to that IDR instead of setting needsKey.
    internals.sending = true;
    const now = performance.now();
    internals.pending = [
      { unit: pframe, key: false, at: now - 50 },
      { unit: pframe, key: false, at: now - 35 },
      { unit: idr, key: true, at: now - 20 },
      { unit: pframe, key: false, at: now - 5 },
    ];
    internals.enqueue(pframe, false);
    expect(internals.needsKey).toBe(false);
    expect(internals.pending).toHaveLength(3);
    expect(internals.pending[0]!.key).toBe(true);
  });

  it("ignores static desktop (< 5 fps) and waiting-for-IDR drops; recovers calmly without REMB and backs off on rapid re-strain", async () => {
    const { windowsMachineLevel } = await import("../src/windows-video.js");
    const spawned: Array<{ args: string[]; proc: FakeProcess }> = [];
    const session = new WindowsVideoSession(
      { screen: 0, iceServers: [] },
      { tell: () => {}, input: () => {}, lost: () => {}, log: () => {} },
      {
        helper: () => "C:\\LinkShell\\LinkShell.Screen.exe",
        media: () => "C:\\LinkShell\\media\\ffmpeg.exe",
        spawn: ((_cmd: string, args: string[]) => {
          const proc = new FakeProcess();
          spawned.push({ args, proc });
          return proc as never;
        }) as unknown as typeof import("node:child_process").spawn,
      },
    );
    cleanups.push(() => session.end());

    const internals = session as unknown as {
      connected: boolean;
      level: number;
      captured: number;
      dropped: number;
      queueDrops: number;
      plis: number;
      sentBytes: number;
      steadySince: number;
      lastStats: number;
      changed: number;
      goodSince: number;
      calmUpgradeMs: number;
      lastUpgradeAt?: number;
      behindIntervals: number;
      strainedIntervals: number;
      lastFeedback: number;
      feedbackSource: "none" | "remb" | "twcc";
      estimate: number;
      report(): void;
    };
    internals.connected = true;
    internals.steadySince = 0;

    // 10 consecutive seconds of static desktop (2 fps) + 40 waiting-for-IDR drops (queueDrops=0) must NOT downgrade or lock machine level.
    for (let i = 0; i < 10; i++) {
      internals.lastStats = performance.now() - 1000;
      internals.changed = performance.now() - 30_000;
      internals.captured = 2;
      internals.dropped = 40;
      internals.queueDrops = 0;
      internals.plis = 0;
      internals.report();
    }
    expect(internals.level).toBe(0);
    expect(internals.behindIntervals).toBe(0);
    expect(internals.strainedIntervals).toBe(0);
    expect(windowsMachineLevel()).toBe(0);

    // Calm upgrade recovery works even WITHOUT REMB feedback (no feedback at all).
    internals.level = 3;
    internals.lastFeedback = 0;
    internals.feedbackSource = "none";
    internals.goodSince = performance.now() - 26_000;
    internals.changed = performance.now() - 26_000;
    internals.lastStats = performance.now() - 1000;
    internals.captured = 30;
    internals.queueDrops = 0;
    internals.plis = 0;
    internals.report();
    expect(internals.level).toBe(2);
    expect(internals.lastUpgradeAt).toBeGreaterThan(0);

    // Quiet TWCC-only desktop (senderBWE tracks sendBitrate) does NOT falsely downgrade and still upgrades when calm.
    internals.feedbackSource = "twcc";
    internals.lastFeedback = performance.now();
    internals.estimate = 1_000_000;
    internals.sentBytes = Math.round(1_000_000 / 8); // sendBitrate === estimate (not congested)
    internals.captured = 30;
    internals.lastStats = performance.now() - 1000;
    internals.goodSince = performance.now() - 26_000;
    internals.changed = performance.now() - 26_000;
    internals.report();
    expect(internals.strainedIntervals).toBe(0);
    expect(internals.level).toBe(1);

    // Rapid re-strain within 45s of an upgrade doubles calmUpgradeMs (exponential backoff).
    const beforeBackoff = internals.calmUpgradeMs;
    internals.changed = performance.now() - 20_000;
    internals.lastUpgradeAt = performance.now() - 20_000;
    for (let i = 0; i < 5; i++) {
      internals.lastStats = performance.now() - 1000;
      internals.captured = 60;
      internals.plis = 5;
      internals.report();
    }
    expect(internals.level).toBe(2);
    expect(internals.calmUpgradeMs).toBe(beforeBackoff * 2);
  });

  it("supports in-band reconfigure of display, width, fps and pause without closing PeerConnection, and enforces inputGeneration", async () => {
    const spawned: Array<{ args: string[]; proc: FakeProcess }> = [];
    const receivedInputs: unknown[] = [];
    const receiver = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    cleanups.push(() => { void receiver.close().catch(() => {}); });
    const channels = new Map<string, RTCDataChannel>();
    receiver.onDataChannel.subscribe(ch => { channels.set(ch.label, ch); });

    const session = new WindowsVideoSession(
      { screen: 0, iceServers: [], maxWidth: 1920, maxFps: 60 },
      {
        tell: message => {
          const m = message as { t: string; sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
          if (m.t === "offer" && m.sdp) {
            void (async () => {
              await receiver.setRemoteDescription({ type: "offer", sdp: m.sdp! });
              const answer = await receiver.createAnswer();
              await receiver.setLocalDescription(answer);
              session.signal({ t: "rtc.answer", sdp: receiver.localDescription!.sdp });
            })();
          } else if (m.t === "ice" && m.candidate) {
            void receiver.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid ?? undefined, sdpMLineIndex: m.sdpMLineIndex ?? 0 }).catch(() => {});
          }
        },
        input: msg => { receivedInputs.push(msg); },
        lost: () => {},
        log: () => {},
      },
      {
        helper: () => "C:\\LinkShell\\LinkShell.Screen.exe",
        media: () => "C:\\LinkShell\\media\\ffmpeg.exe",
        displaySize: s => (s === 1 ? { w: 2560, h: 1440 } : { w: 1920, h: 1080 }),
        spawn: ((_cmd: string, args: string[]) => {
          const proc = new FakeProcess();
          spawned.push({ args, proc });
          return proc as never;
        }) as unknown as typeof import("node:child_process").spawn,
      },
    );
    cleanups.push(() => session.end());
    expect(session.reconfigure).toBe(true);
    receiver.onIceCandidate.subscribe(c => {
      if (c) session.signal({ t: "rtc.ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
    });

    const offerPromise = session.offer();
    await vi.waitFor(() => expect(spawned.some(s => s.args[0] === "--video")).toBe(true));
    const firstVideo = spawned.find(s => s.args[0] === "--video")!.proc;
    firstVideo.stdout.write(Buffer.concat([AVI_HEADER, aviChunk(Buffer.concat([aud, nal(0x67), nal(0x68), nal(0x65)]))]));
    await offerPromise;
    await vi.waitFor(() => expect(channels.get("input")?.readyState).toBe("open"), { timeout: 10_000 });

    // Switch to display 1 at 2560x1440 @ 60fps in-band without tearing down WebRTC.
    const configured = await session.configure({
      requestId: 1, screen: 1, maxWidth: 2560, maxFps: 60, paused: false, inputGeneration: 2,
    });
    expect(configured).toEqual({ screen: 1, width: 2560, height: 1440, maxFps: 60, paused: false, generation: 2 });
    expect(firstVideo.exitCode).toBe(0);
    const videos = spawned.filter(s => s.args[0] === "--video");
    expect(videos).toHaveLength(2);
    expect(videos[1]!.args.slice(0, 4)).toEqual(["--video", "1", "2560", "60"]);
    const shapes = spawned.filter(s => s.args[0] === "--shape");
    expect(shapes).toHaveLength(2);
    expect(shapes[1]!.args).toEqual(["--shape", "1"]);
    expect(channels.get("input")?.readyState).toBe("open");

    // Stale generation input is dropped; current generation input passes through.
    channels.get("input")!.send(JSON.stringify({ t: "down", b: "left", screenGeneration: 1 }));
    channels.get("input")!.send(JSON.stringify({ t: "down", b: "left", screenGeneration: 2 }));
    await vi.waitFor(() => expect(receivedInputs).toHaveLength(1));
    expect(receivedInputs[0]).toMatchObject({ t: "down", b: "left", screenGeneration: 2 });

    // Pause stops capture while keeping PeerConnection open.
    const paused = await session.configure({
      requestId: 2, screen: 1, maxWidth: 2560, maxFps: 60, paused: true, inputGeneration: 3,
    });
    expect(paused).toMatchObject({ screen: 1, paused: true, generation: 3 });
    expect(videos[1]!.proc.exitCode).toBe(0);
    expect(channels.get("input")?.readyState).toBe("open");
  }, 20_000);
});
