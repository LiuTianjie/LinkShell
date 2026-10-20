import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Configuration = { requestId: number; screen: number; maxWidth: number; maxFps?: number; paused: boolean; inputGeneration?: number };
type Applied = { screen: number; width: number; height: number; maxFps: number; paused: boolean; generation?: number };
type Control = { start: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
type Message = Record<string, unknown> & { session?: Record<string, unknown> };
type CaptureEvents = { frame(unit: Buffer, key: boolean): void; resized?(): void; exit(message?: string): void };
type FakeCapture = { on: CaptureEvents; end: ReturnType<typeof vi.fn>; key: ReturnType<typeof vi.fn>; gone: Promise<void> };

const dependencies = vi.hoisted(() => ({ helper: undefined as FakeHelper | undefined, controls: [] as Control[] }));

vi.mock("../src/input.js", async (original) => {
  const actual = await original<typeof import("../src/input.js")>();
  return {
    ...actual,
    inputApp: () => dependencies.helper,
    closeInputApp: vi.fn(),
    macAppSupported: () => true,
    InputControl: class {
      start = vi.fn(async (_screen: number) => {});
      send = vi.fn((_event: unknown) => {});
      stop = vi.fn();
      constructor() { dependencies.controls.push(this); }
    },
  };
});

import { ScreenShare } from "../src/screen.js";

const displays = [
  { index: 0, screen: 0, name: "A", w: 1920, h: 1080 },
  { index: 1, screen: 1, name: "B", w: 2560, h: 1440 },
];

function applied(next: Configuration): Applied {
  const target = displays.find((display) => display.screen === next.screen)!;
  const width = Math.min(next.maxWidth, target.w);
  return { screen: next.screen, width, height: width * target.h / target.w, maxFps: next.maxFps ?? 60, paused: next.paused, generation: next.inputGeneration };
}

class FakeHelper {
  supportsConfiguration = true;
  routes = new Map<string, (message: Record<string, unknown>) => void>();
  access = vi.fn(async () => ({ trusted: true, recording: true, app: "LinkShell", video: true, videoReconfigure: this.supportsConfiguration, preview: false }));
  displays = vi.fn(async () => displays);
  offerVideo = vi.fn(async (id: string, _offer: unknown, route: (message: Record<string, unknown>) => void) => {
    this.routes.set(id, route);
    route({ t: "rtc.offer", v: id, sdp: "fake-screen-offer" });
  });
  configureVideo = vi.fn(async (_id: string, next: Configuration): Promise<Applied> => applied(next));
  endVideo = vi.fn((id: string) => { this.routes.delete(id); });
  signal = vi.fn();
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  messages: Message[] = [];
  frames: Buffer[] = [];
  send = vi.fn((message: string | Buffer) => {
    if (typeof message === "string") this.messages.push(JSON.parse(message) as Message);
    else this.frames.push(message);
  });
  close = vi.fn(() => {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  });
  terminate = vi.fn(() => this.close());
  receive(message: object) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  sessions(kind: string) { return this.messages.flatMap((message) => message.session?.t === kind ? [message.session] : []); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Explicit microtask turns keep deferred helper replies under the test's control.
async function settle() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }

function configure(requestId: number, changes: Record<string, unknown> = {}) {
  return { t: "screen.configure", requestId, display: 0, width: 1920, maxFps: 60, paused: false, ...changes };
}

function input(socket: FakeSocket, event: Record<string, unknown>) {
  socket.receive({ ...event, screenGeneration: socket.sessions("configured").at(-1)?.generation });
}

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const hosts: ScreenShare[] = [];
const sockets: FakeSocket[] = [];

async function receiver(supportsConfiguration = true, wantsVideo = true, captureResult?: (running: FakeCapture) => Promise<FakeCapture>) {
  const helper = new FakeHelper();
  helper.supportsConfiguration = supportsConfiguration;
  dependencies.helper = helper;
  const host = new ScreenShare(() => {});
  hosts.push(host);
  const internals = host as unknown as {
    displays: typeof displays;
    listDisplays(): Promise<typeof displays>;
    capture(...args: unknown[]): Promise<unknown>;
    stream(socket: FakeSocket, display: number, relayed: boolean, video: boolean, width: number, maxFps: number): void;
  };
  internals.displays = displays;
  vi.spyOn(internals, "listDisplays").mockResolvedValue(displays);
  const captures: FakeCapture[] = [];
  const capture = vi.spyOn(internals, "capture").mockImplementation(async (...args) => {
    if (wantsVideo) throw new Error("This RTC test must never open a real capture");
    const ended = deferred<void>();
    const running = { on: args[2] as CaptureEvents, end: vi.fn(() => ended.resolve(undefined)), key: vi.fn(), gone: ended.promise };
    captures.push(running);
    return captureResult ? captureResult(running) : running;
  });
  const connect = async (video = wantsVideo) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    internals.stream(socket, 0, false, video, 1920, 60);
    await settle();
    return socket;
  };
  const socket = await connect();
  return { host, socket, helper, capture, captures, connect };
}

function inputCalls() { return dependencies.controls.reduce((total, control) => total + control.send.mock.calls.length, 0); }
function startCalls() { return dependencies.controls.reduce((total, control) => total + control.start.mock.calls.length, 0); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LINKSHELL_SCREEN_VIDEO", "");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  dependencies.controls.length = 0;
});

afterEach(() => {
  for (const socket of sockets.splice(0)) if (socket.readyState === socket.OPEN) socket.close();
  for (const host of hosts.splice(0)) host.stop();
  dependencies.helper = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
});

describe("an authenticated screen socket's retained session", () => {
  it("reconfigures display, resolution and frame-rate ceiling without another video offer", async () => {
    const { socket, helper } = await receiver();
    expect(socket.sessions("capabilities")).toHaveLength(1);
    expect(socket.sessions("capabilities")[0]).toMatchObject({ configure: true, pause: true, retainMs: 120_000 });
    const viewer = helper.offerVideo.mock.calls[0]![0];

    socket.receive(configure(1, { display: 1, width: "1280", maxFps: 30 }));
    await settle();
    socket.receive({ t: "hidden" });
    await settle();
    expect(helper.configureVideo.mock.calls.at(-1)![1]).toMatchObject({ screen: 1, paused: true });
    socket.receive({ t: "shown" });
    await settle();
    expect(helper.configureVideo.mock.calls.at(-1)![1]).toMatchObject({ screen: 1, paused: false });
    socket.receive(configure(2, { display: 1, width: "native", maxFps: 120 }));
    await settle();

    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).not.toHaveBeenCalled();
    expect(helper.configureVideo.mock.calls.every(([id]) => id === viewer)).toBe(true);
    expect(socket.sessions("configured").at(-1)).toMatchObject({ requestId: 2, display: 1, width: 2560, height: 1440, maxFps: 120, paused: false });
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("rejects invalid configurations before touching capture or control, and keeps the socket healthy", async () => {
    const { socket, helper } = await receiver();
    helper.configureVideo.mockClear();
    const invalid = [
      { requestId: -1 }, { requestId: 1.5 }, { requestId: Number.MAX_SAFE_INTEGER + 1 },
      { display: -1 }, { display: 999 }, { width: 639 }, { width: 3841 }, { width: "oops" },
      { maxFps: 90 }, { paused: "false" }, { paused: undefined },
    ];
    for (const [index, changes] of invalid.entries()) {
      socket.receive(configure(index + 10, changes));
      await settle();
    }

    expect(helper.configureVideo).not.toHaveBeenCalled();
    expect(helper.endVideo).not.toHaveBeenCalled();
    expect(startCalls()).toBe(0);
    expect(inputCalls()).toBe(0);
    expect(dependencies.controls.every((control) => control.stop.mock.calls.length === 0)).toBe(true);
    expect(socket.sessions("error")).toHaveLength(invalid.length);
    expect(socket.sessions("error").every((error) => /[\u3400-\u9fff]/.test(String(error.message)))).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("serializes helper changes, coalesces intermediate requests, and never unlocks input for an obsolete reply", async () => {
    const { socket, helper } = await receiver();
    socket.receive(configure(1));
    await settle();
    input(socket, { t: "control" });
    await settle();
    helper.configureVideo.mockClear();
    const first = deferred<Applied>();
    const last = deferred<Applied>();
    helper.configureVideo.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);

    socket.receive(configure(2, { display: 1, width: 1280 }));
    await settle();
    socket.receive(configure(3, { display: 0, width: 1600 }));
    socket.receive(configure(4, { display: 1, width: 2560, paused: true }));
    await settle();
    expect(helper.configureVideo).toHaveBeenCalledTimes(1);
    const starts = startCalls();
    const inputs = inputCalls();
    first.resolve(applied(helper.configureVideo.mock.calls[0]![1]));
    await settle();

    expect(helper.configureVideo).toHaveBeenCalledTimes(2);
    expect(helper.configureVideo.mock.calls[1]![1]).toMatchObject({ screen: 1, maxWidth: 2560, paused: true });
    input(socket, { t: "control" });
    input(socket, { t: "text", s: "must stay blocked" });
    await settle();
    expect(startCalls()).toBe(starts);
    expect(inputCalls()).toBe(inputs);

    last.resolve(applied(helper.configureVideo.mock.calls[1]![1]));
    await settle();
    expect(socket.sessions("configured").at(-1)).toMatchObject({ requestId: 4, display: 1, width: 2560, paused: true });
    expect(socket.sessions("configured").some((message) => message.requestId === 3)).toBe(false);
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("releases control on pause and waits for the applied resume before accepting input on the new display", async () => {
    const { socket, helper } = await receiver();
    socket.receive(configure(1));
    await settle();
    input(socket, { t: "control" });
    await settle();
    input(socket, { t: "down", b: "left" });
    const oldControl = dependencies.controls.find((control) => control.start.mock.calls.length > 0)!;
    expect(oldControl.send).toHaveBeenCalledWith(expect.objectContaining({ t: "down", b: "left" }));

    socket.receive(configure(2, { display: 1, paused: true }));
    await settle();
    expect(oldControl.stop).toHaveBeenCalledTimes(1);
    const inputs = inputCalls();
    const starts = startCalls();
    input(socket, { t: "control" });
    input(socket, { t: "text", s: "hidden" });
    expect(startCalls()).toBe(starts);
    expect(inputCalls()).toBe(inputs);

    const resumed = deferred<Applied>();
    helper.configureVideo.mockImplementationOnce(() => resumed.promise);
    socket.receive(configure(3, { display: 1 }));
    await settle();
    input(socket, { t: "control" });
    input(socket, { t: "key", k: "return" });
    expect(startCalls()).toBe(starts);
    expect(inputCalls()).toBe(inputs);
    resumed.resolve(applied(helper.configureVideo.mock.calls.at(-1)![1]));
    await settle();
    input(socket, { t: "control" });
    await settle();
    input(socket, { t: "text", s: "visible again" });

    const newControl = dependencies.controls.findLast((control) => control.start.mock.calls.length > 0)!;
    expect(newControl).not.toBe(oldControl);
    expect(newControl.start).toHaveBeenLastCalledWith(1);
    expect(newControl.send).toHaveBeenCalledWith(expect.objectContaining({ t: "text", s: "visible again" }));
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).not.toHaveBeenCalled();
  });

  it("drops delayed input from the previous display even after the new display is ready", async () => {
    const { socket, helper } = await receiver();
    socket.receive(configure(1));
    await settle();
    const previousGeneration = helper.configureVideo.mock.calls.at(-1)![1].inputGeneration;
    input(socket, { t: "control" });
    await settle();
    socket.receive(configure(2, { display: 1 }));
    await settle();
    const currentGeneration = helper.configureVideo.mock.calls.at(-1)![1].inputGeneration;
    expect(Number.isSafeInteger(currentGeneration)).toBe(true);
    expect(currentGeneration).not.toBe(previousGeneration);
    input(socket, { t: "control" });
    await settle();
    const calls = inputCalls();
    socket.receive({ t: "down", b: "left", screenGeneration: previousGeneration });
    socket.receive({ t: "text", s: "stale target", screenGeneration: previousGeneration });
    socket.receive({ t: "key", k: "return" });
    expect(inputCalls()).toBe(calls);
    input(socket, { t: "text", s: "current target" });
    expect(inputCalls()).toBe(calls + 1);
    expect(dependencies.controls.findLast((control) => control.start.mock.calls.length > 0)!.start).toHaveBeenLastCalledWith(1);
  });

  it("bounds one pause to 120 seconds even when its desired settings keep changing", async () => {
    const { socket, helper } = await receiver();
    socket.receive(configure(1, { paused: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(119_000);
    socket.receive(configure(2, { paused: true, width: 1280 }));
    socket.receive({ t: "hidden" });
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
  });

  it("cancels the old expiry on a quick return and starts a new deadline for the next pause", async () => {
    const { socket, helper } = await receiver();
    socket.receive(configure(1, { paused: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(119_000);
    socket.receive(configure(2));
    await settle();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(socket.close).not.toHaveBeenCalled();
    expect(helper.endVideo).not.toHaveBeenCalled();
    socket.receive(configure(3, { paused: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
  });

  it("reports a configuration failure without replacing or closing a healthy video session", async () => {
    const { socket, helper } = await receiver();
    helper.configureVideo.mockRejectedValueOnce(new Error("display disappeared"));
    socket.receive(configure(1, { display: 1 }));
    await settle();
    expect(socket.sessions("error").at(-1)).toMatchObject({ requestId: 1 });
    expect(String(socket.sessions("error").at(-1)?.message)).toMatch(/[\u3400-\u9fff]/);
    expect(socket.close).not.toHaveBeenCalled();
    expect(helper.endVideo).not.toHaveBeenCalled();
    socket.receive(configure(2, { width: 1280 }));
    await settle();
    expect(socket.sessions("configured").at(-1)).toMatchObject({ requestId: 2, width: 1280 });
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
  });

  it("ignores a deferred configuration after the socket closes instead of resurrecting its session", async () => {
    const { socket, helper } = await receiver();
    const pending = deferred<Applied>();
    helper.configureVideo.mockImplementationOnce(() => pending.promise);
    socket.receive(configure(1, { display: 1 }));
    await settle();
    expect(helper.configureVideo).toHaveBeenCalledTimes(1);
    socket.close();
    const messages = socket.messages.length;
    const starts = startCalls();
    pending.resolve(applied(helper.configureVideo.mock.calls[0]![1]));
    await settle();

    expect(socket.messages).toHaveLength(messages);
    expect(startCalls()).toBe(starts);
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
  });

  it("closes retained sockets immediately when the host stops", async () => {
    const { host, socket, helper } = await receiver();
    socket.receive(configure(1, { paused: true }));
    await settle();
    host.stop();
    expect(socket.readyState).not.toBe(socket.OPEN);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
  });

  it("keeps a replacement viewer alive after the paused viewer's pending reply and expiry", async () => {
    const { socket, helper, connect } = await receiver();
    socket.receive(configure(1, { paused: true }));
    await settle();
    const pending = deferred<Applied>();
    helper.configureVideo.mockImplementationOnce(() => pending.promise);
    socket.receive(configure(2, { display: 1 }));
    await settle();
    const oldConfiguration = helper.configureVideo.mock.calls.at(-1)![1];
    const replacement = await connect();
    expect(socket.close).toHaveBeenCalledTimes(1);
    const oldMessages = socket.messages.length;
    pending.resolve(applied(oldConfiguration));
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(socket.messages).toHaveLength(oldMessages);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(helper.offerVideo).toHaveBeenCalledTimes(2);
    expect(helper.endVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).toHaveBeenCalledWith(helper.offerVideo.mock.calls[0]![0]);
    expect(helper.endVideo).not.toHaveBeenCalledWith(helper.offerVideo.mock.calls[1]![0]);
  });

  it("never claims retention or in-place configuration for a legacy video helper", async () => {
    const { socket, helper } = await receiver(false);
    expect(socket.sessions("capabilities")).toHaveLength(1);
    expect(socket.sessions("capabilities")[0]).toMatchObject({ configure: false, pause: false });
    socket.receive(configure(1, { display: 1, paused: true }));
    await settle();
    expect(helper.configureVideo).not.toHaveBeenCalled();
    expect(socket.sessions("configured")).toHaveLength(0);
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe("a retained byte-stream fallback", () => {
  it("releases held input immediately when capture exits, before the socket close handshake finishes", async () => {
    const { socket, captures } = await receiver(true, false);
    socket.receive({ t: "control" });
    await settle();
    socket.receive({ t: "down", b: "left" });
    const control = dependencies.controls.find((entry) => entry.start.mock.calls.length > 0)!;
    expect(control.send).toHaveBeenCalledWith({ t: "down", b: "left" });
    socket.close.mockImplementation(() => { socket.readyState = 2; });

    captures[0]!.on.exit("capture ended");
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(control.stop).toHaveBeenCalledTimes(1);
    expect(captures[0]!.end).toHaveBeenCalledTimes(1);
  });

  it("stops capture and keyframe work while paused, then replaces only capture for the latest display and width", async () => {
    const { socket, helper, captures } = await receiver(true, false);
    expect(socket.sessions("capabilities")[0]).toMatchObject({ configure: true, pause: true });
    expect(captures).toHaveLength(1);
    const previous = captures[0]!;
    previous.on.frame(Buffer.from([1]), true);
    expect(socket.frames).toHaveLength(1);
    socket.receive({ t: "keyframe" });
    expect(previous.key).toHaveBeenCalledTimes(1);

    socket.receive(configure(1, { paused: true }));
    await settle();
    expect(previous.end).toHaveBeenCalledTimes(1);
    previous.on.frame(Buffer.from([2]), true);
    socket.receive({ t: "keyframe" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.frames).toHaveLength(1);
    expect(previous.key).toHaveBeenCalledTimes(1);
    socket.receive(configure(2, { display: 1, width: 1280, paused: true }));
    await settle();
    expect(captures).toHaveLength(1);
    expect(socket.sessions("configured").at(-1)).toMatchObject({ requestId: 2, display: 1, width: 1280, height: 720, paused: true });

    socket.receive(configure(3, { display: 1, width: 1280 }));
    await settle();
    expect(captures).toHaveLength(2);
    const messages = socket.messages.length;
    previous.on.frame(Buffer.from([3]), true);
    previous.on.resized?.();
    previous.on.exit("obsolete capture stopped");
    expect(socket.frames).toHaveLength(1);
    expect(socket.messages).toHaveLength(messages);
    expect(socket.close).not.toHaveBeenCalled();
    captures[1]!.on.frame(Buffer.from([4]), true);
    expect(socket.frames).toHaveLength(2);
    expect(socket.sessions("configured").at(-1)).toMatchObject({ requestId: 3, display: 1, width: 1280, height: 720, paused: false });
    expect(helper.offerVideo).not.toHaveBeenCalled();
    expect(helper.endVideo).not.toHaveBeenCalled();
  });

  it.each(["pause", "close"] as const)("disposes a capture that finishes starting after %s without publishing its late callbacks", async (action) => {
    const pending = deferred<FakeCapture>();
    const { host, socket, captures } = await receiver(true, false, () => pending.promise);
    expect(captures).toHaveLength(1);
    if (action === "pause") socket.receive(configure(1, { paused: true }));
    else socket.close();
    await settle();
    const messages = socket.messages.length;
    const closes = socket.close.mock.calls.length;
    const late = captures[0]!;
    pending.resolve(late);
    await settle();

    expect(late.end).toHaveBeenCalledTimes(1);
    expect((host as unknown as { holder?: unknown }).holder).toBeUndefined();
    late.on.frame(Buffer.from([5]), true);
    late.on.resized?.();
    late.on.exit("late initial capture");
    expect(socket.frames).toHaveLength(0);
    expect(socket.messages).toHaveLength(messages);
    expect(socket.close).toHaveBeenCalledTimes(closes);
  });

  it("cannot steal the capture holder back when a new video viewer takes over during capture startup", async () => {
    const pending = deferred<FakeCapture>();
    const { host, socket, helper, captures, connect } = await receiver(true, false, () => pending.promise);
    const replacement = await connect(true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    const late = captures[0]!;
    pending.resolve(late);
    await settle();
    expect(late.end).toHaveBeenCalledTimes(1);
    expect((host as unknown as { holder?: unknown }).holder).toBeUndefined();
    late.on.frame(Buffer.from([6]), true);
    late.on.exit("old capture");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.endVideo).not.toHaveBeenCalled();
  });
});
