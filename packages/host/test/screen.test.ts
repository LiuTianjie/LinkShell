import { spawn } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeInputApp, shippedApp } from "../src/input.js";
import { AccessUnitSplitter, ScreenShare, captureArgs, endCapture, videoWidth, videoMaxFps } from "../src/screen.js";

const nal = (type: number, ...body: number[]) => [0, 0, 0, 1, type, ...body];
const aud = () => nal(9, 0xf0);

describe("ending a capture", () => {
  it("insists when the process sits through being asked (ffmpeg holding a screen does)", async () => {
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve) => stubborn.stdout!.once("data", resolve));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => stubborn.once("exit", (_code, signal) => resolve(signal)));
    endCapture(stubborn);
    expect(await exited).toBe("SIGKILL");
    // Ending it again, or one that left by itself, is nothing.
    endCapture(stubborn);
    const polite = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const gone = new Promise<NodeJS.Signals | null>((resolve) => polite.once("exit", (_code, signal) => resolve(signal)));
    endCapture(polite);
    expect(await gone).toBe("SIGTERM");
  });
});

describe("what ffmpeg captures (Linux)", () => {
  it("is capped at its level's frame rate, and lighter the further down the ladder", () => {
    const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    const best = captureArgs();
    const relayed = captureArgs(2);
    const lightest = captureArgs(99);
    expect(value(best, "-vf")).toMatch(/^fps=20,scale='min\(1600,iw\)'/);
    expect(value(relayed, "-vf")).toMatch(/^fps=12,scale='min\(1280,iw\)'/);
    expect(value(lightest, "-vf")).toMatch(/^fps=8,scale='min\(854,iw\)'/);
    expect([value(best, "-b:v"), value(relayed, "-b:v"), value(lightest, "-b:v")]).toEqual(["3000k", "900k", "260k"]);
    // A keyframe every second, so a viewer that fell behind is back on the live picture within one.
    expect([value(best, "-g"), value(relayed, "-g")]).toEqual(["20", "12"]);
  });
});

describe("AccessUnitSplitter", () => {
  it("splits an Annex-B stream into whole frames at delimiters, across chunk boundaries", () => {
    const stream = Buffer.from([
      ...aud(), ...nal(0x67, 0x42, 0xe0, 0x1f), ...nal(0x68, 0xce), ...nal(0x65, 1, 2, 3), // key frame: SPS, PPS, IDR
      ...aud(), ...nal(0x41, 4, 5), // delta
      ...aud(), ...nal(0x41, 6),
      ...aud(), // the next frame's start: the one before it is complete
    ]);
    const frames: { key: boolean; length: number }[] = [];
    const splitter = new AccessUnitSplitter();
    // Fed in awkward pieces, as a pipe delivers it.
    for (let i = 0; i < stream.length; i += 7) splitter.push(stream.subarray(i, i + 7), (unit, key) => frames.push({ key, length: unit.length }));
    expect(frames.map((frame) => frame.key)).toEqual([true, false, false]);
    expect(frames[0]!.length).toBe(aud().length + 8 + 6 + 8);
  });
});

// On a Mac the displays are LinkShell.app's to list: skipped where it hasn't been built.
describe.skipIf(!shippedApp())("screen viewer server", () => {
  let screen: ScreenShare | undefined;
  afterEach(() => screen?.stop());
  afterAll(() => closeInputApp());

  it("serves the viewer only with the current token", async () => {
    screen = new ScreenShare(() => {});
    const first = await screen.start();
    expect(first.displays.length).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${first.port}/`;
    expect((await fetch(base)).status).toBe(403);
    expect((await fetch(`${base}?token=wrong`)).status).toBe(403);
    const page = await fetch(`${base}?token=${first.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("VideoDecoder");
    // A new start rotates the token: the old link stops working.
    const second = await screen.start();
    expect(second.port).toBe(first.port);
    expect((await fetch(`${base}?token=${first.token}`)).status).toBe(403);
  });
});

describe("the width a viewer asks the video track for", () => {
  it("is a number of pixels, or the display's own, held to 4K", () => {
    expect(videoWidth("2560")).toBe(2560);
    expect(videoWidth("1280")).toBe(1280);
    expect(videoWidth("native")).toBe(3840);
    expect(videoWidth("99999")).toBe(3840);
  });

  it("is the app's own choice when it says nothing that makes sense", () => {
    for (const asked of [null, "", "auto", "12", "1920.5", "-1"]) expect(videoWidth(asked)).toBeUndefined();
  });
});

describe("receiver frame-rate capabilities", () => {
  it("only admits supported ceilings and leaves older viewers unchanged", () => {
    expect(videoMaxFps("120")).toBe(120);
    expect(videoMaxFps("60")).toBe(60);
    expect(videoMaxFps("30")).toBe(30);
    for (const value of [null, "", "0", "240", "120.0", "NaN", "-1"]) expect(videoMaxFps(value)).toBeUndefined();
  });
});
