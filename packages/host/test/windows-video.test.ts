import { describe, expect, it } from "vitest";
import { H264AccessUnits, h264Nals, h264Payloads, ScreenInputOrder } from "../src/screen-h264.js";
import { weriftIceServers, windowsVideoProfile } from "../src/windows-video.js";
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
