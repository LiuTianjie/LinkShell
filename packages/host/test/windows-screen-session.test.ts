import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessions: [] as FakeVideo[], controls: [] as FakeControl[] }));
const displays = [{ screen: 0, name: "Windows", w: 1920, h: 1080, main: true }];

vi.mock("../src/windows-screen.js", async original => ({
  ...await original<typeof import("../src/windows-screen.js")>(),
  windowsDisplays: async () => [{ screen: 0, name: "Windows", w: 1920, h: 1080, main: true }],
}));
vi.mock("../src/windows-video.js", () => ({
  windowsMedia: () => "ffmpeg.exe",
  WindowsVideoSession: class {
    id = `windows-${state.sessions.length}`;
    end = vi.fn();
    pause = vi.fn();
    signal = vi.fn();
    offer = vi.fn(async () => {});
    constructor(_request: unknown, readonly events: { input(message: unknown): void }) { state.sessions.push(this); }
  },
}));
vi.mock("../src/input.js", async original => ({
  ...await original<typeof import("../src/input.js")>(),
  closeInputApp: vi.fn(),
  InputControl: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
    send = vi.fn();
    constructor() { state.controls.push(this); }
  },
}));

import { ScreenShare } from "../src/screen.js";

type FakeVideo = { id: string; end: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; events: { input(message: unknown): void } };
type FakeControl = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { if (this.readyState === 1) { this.readyState = 3; this.emit("close"); } });
  receive(message: object) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let host: ScreenShare;
let internals: {
  displays: { screen: number; index: number; name: string; w: number; h: number }[];
  holder?: { gone: Promise<void>; end(): void; on: { exit(): void } };
  video?: { id: string };
  stream(socket: Socket, display: number, relayed: boolean, video: boolean, width: number, fps: number): void;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LINKSHELL_SCREEN_VIDEO", "");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  state.sessions.length = state.controls.length = 0;
  host = new ScreenShare(() => {});
  internals = host as unknown as typeof internals;
  internals.displays = displays.map(display => ({ ...display, index: display.screen }));
});
afterEach(() => {
  host.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
});
async function connect() {
  const socket = new Socket();
  internals.stream(socket, 0, false, true, 1920, 60);
  await settle();
  return socket;
}

describe("Windows screen session integration", () => {
  it("does not let an older takeover replace the latest viewer while a JPEG capture exits", async () => {
    let released!: () => void;
    internals.holder = { gone: new Promise(resolve => { released = resolve; }), end: vi.fn(), on: { exit: vi.fn() } };
    const older = await connect();
    expect(state.sessions).toHaveLength(0);
    const latest = await connect();
    expect(older.readyState).toBe(3);
    expect(state.sessions).toHaveLength(1);
    released();
    await settle();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.end).not.toHaveBeenCalled();
    expect(internals.video?.id).toBe(state.sessions[0]!.id);
    expect(latest.readyState).toBe(1);
  });

  it("pauses and resumes its video track without advertising target configuration", async () => {
    const socket = await connect();
    expect(socket.send.mock.calls.some(([text]) => typeof text === "string" && text.includes('"configure":false,"pause":true'))).toBe(true);
    socket.receive({ t: "hidden" });
    await settle();
    expect(state.sessions[0]!.pause).toHaveBeenLastCalledWith(true);
    state.sessions[0]!.events.input({ t: "down", b: "left" });
    await settle();
    expect(state.controls).toHaveLength(0);
    socket.receive({ t: "shown" });
    await settle();
    expect(state.sessions[0]!.pause).toHaveBeenLastCalledWith(false);
    state.sessions[0]!.events.input({ t: "down", b: "left" });
    await settle();
    expect(state.controls[0]!.send).toHaveBeenCalledWith({ t: "down", b: "left" });
    expect(state.sessions[0]!.end).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
  });
});
