import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AccessUnitSplitter, ScreenShare, captureArgs, endCapture } from "../src/screen.js";

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

describe("what is captured", () => {
  it("is capped at the profile's frame rate, and lighter when a gateway relays it", () => {
    const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    const full = captureArgs(1);
    const low = captureArgs(1, "low");
    // The frame rate is enforced by a filter: the capture device doesn't honour the one it is asked for.
    expect(value(full, "-vf")).toMatch(/^fps=20,scale='min\(1600,iw\)'/);
    expect(value(low, "-vf")).toMatch(/^fps=12,scale='min\(1280,iw\)'/);
    expect([value(full, "-b:v"), value(low, "-b:v")]).toEqual(["3M", "900k"]);
    // A keyframe every two seconds either way, so a viewer that fell behind can catch up.
    expect([value(full, "-g"), value(low, "-g")]).toEqual(["40", "24"]);
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

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg || process.platform !== "darwin")("screen viewer server", () => {
  let screen: ScreenShare | undefined;
  afterEach(() => screen?.stop());

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
