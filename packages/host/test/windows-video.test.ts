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
