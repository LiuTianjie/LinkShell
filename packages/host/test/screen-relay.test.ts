import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnCredentials } from "@linkshell/wire";

type Message = Record<string, unknown>;
type CaptureEvents = { frame(unit: Buffer, key: boolean): void; resized?(): void; exit(message?: string): void };

const dependencies = vi.hoisted(() => ({ helper: undefined as FakeHelper | undefined }));

vi.mock("../src/input.js", async (original) => {
  const actual = await original<typeof import("../src/input.js")>();
  return {
    ...actual,
    inputApp: () => dependencies.helper,
    closeInputApp: vi.fn(),
    macAppSupported: () => true,
    InputControl: class {
      start = vi.fn(async () => {});
      send = vi.fn();
      stop = vi.fn();
    },
  };
});

import { ScreenShare } from "../src/screen.js";
import { SCREEN_IDLE } from "../src/screen-viewer.js";

const displays = [{ index: 0, screen: 0, name: "A", w: 1920, h: 1080 }];

class FakeHelper {
  routes = new Map<string, (message: Record<string, unknown>) => void>();
  access = vi.fn(async () => ({ trusted: true, recording: true, app: "LinkShell", video: true, videoReconfigure: true, preview: false }));
  displays = vi.fn(async () => displays);
  offerVideo = vi.fn(async (id: string, _offer: Record<string, unknown>, route: (message: Record<string, unknown>) => void) => {
    this.routes.set(id, route);
    route({ t: "rtc.offer", v: id, sdp: "fake-screen-offer" });
  });
  configureVideo = vi.fn(async (_id: string, next: { screen: number; maxWidth: number; maxFps?: number; paused: boolean; inputGeneration?: number }) =>
    ({ screen: next.screen, width: 1920, height: 1080, maxFps: next.maxFps ?? 60, paused: next.paused, generation: next.inputGeneration }));
  endVideo = vi.fn((id: string) => { this.routes.delete(id); });
  signal = vi.fn();
  /** What the app says of its track, as LinkShell.app does. */
  say(message: Record<string, unknown>) { for (const [id, route] of this.routes) route({ ...message, v: id }); }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  messages: Message[] = [];
  send = vi.fn((message: string | Buffer) => { if (typeof message === "string") this.messages.push(JSON.parse(message) as Message); });
  close = vi.fn(() => {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  });
  terminate = vi.fn(() => this.close());
  receive(message: object) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  config() { return (this.messages.find((message) => (message.rtc as Message | undefined)?.t === "config")?.rtc as { iceServers: unknown[] } | undefined)?.iceServers; }
}

async function settle() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }

const TURN: TurnCredentials = {
  servers: [
    { urls: ["stun:turn.example.com:3478"] },
    { urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:443?transport=tcp"], username: "1800000000:abc", credential: "secret" },
  ],
  ttl: 28800,
  maxKbps: 2500,
};

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const hosts: ScreenShare[] = [];
const sockets: FakeSocket[] = [];

type Internals = {
  displays: typeof displays;
  listDisplays(): Promise<typeof displays>;
  capture(...args: unknown[]): Promise<unknown>;
  stream(socket: FakeSocket, display: number, relayed: boolean, video: boolean, width: number, maxFps: number, diagnostics: boolean, codec: undefined, turn: boolean): void;
};

function share(relay: () => Promise<TurnCredentials | undefined> | undefined = () => Promise.resolve(TURN)) {
  const helper = new FakeHelper();
  dependencies.helper = helper;
  const host = new ScreenShare(() => {}, () => ["stun:stun.cloudflare.com:3478"], relay);
  hosts.push(host);
  const internals = host as unknown as Internals;
  internals.displays = displays;
  vi.spyOn(internals, "listDisplays").mockResolvedValue(displays);
  const captures: { on: CaptureEvents; end: ReturnType<typeof vi.fn> }[] = [];
  vi.spyOn(internals, "capture").mockImplementation(async (...args) => {
    const running = { on: args[2] as CaptureEvents, end: vi.fn(), key: vi.fn(), gone: Promise.resolve() };
    captures.push(running);
    return running;
  });
  const open = async ({ relayed = false, video = true, turn = true } = {}) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    internals.stream(socket, 0, relayed, video, 1920, 60, false, undefined, turn);
    await settle();
    return socket;
  };
  return { host, helper, captures, open };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LINKSHELL_SCREEN_VIDEO", "");
  vi.stubEnv("LINKSHELL_SCREEN_IDLE_SECONDS", undefined as unknown as string);
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
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

describe("the gateway's TURN server for the screen's video", () => {
  it("is given to the sender with its share, and to a viewer that takes a TURN login, ahead of the public STUN", async () => {
    const { helper, open } = share();
    const socket = await open();
    const offer = helper.offerVideo.mock.calls[0]![1];
    expect(offer.iceServers).toEqual([...TURN.servers, { urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(offer.relayKbps).toBe(2500);
    expect(socket.config()).toEqual(offer.iceServers);
  });

  it("is kept from a viewer that would drop the login: a TURN address without one makes WebRTC refuse even the direct path", async () => {
    const { helper, open } = share();
    const socket = await open({ turn: false });
    expect(helper.offerVideo.mock.calls[0]![1].iceServers).toHaveLength(3);
    expect(socket.config()).toEqual([{ urls: ["stun:turn.example.com:3478"] }, { urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("never holds the picture up: a gateway slow to answer only costs this picture its relay", async () => {
    const { helper, open } = share(() => new Promise(() => {}));
    const socket = await open();
    expect(helper.offerVideo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(helper.offerVideo).toHaveBeenCalledTimes(1);
    expect(helper.offerVideo.mock.calls[0]![1].relayKbps).toBeUndefined();
    expect(socket.config()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("is left out where there is none (a self-hosted gateway, LINKSHELL_TURN=off)", async () => {
    const { helper, open } = share(() => undefined);
    await open();
    expect(helper.offerVideo.mock.calls[0]![1].iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });
});

describe("a relayed picture no one uses", () => {
  const ended = (socket: FakeSocket) => socket.messages.some((message) => message.error === SCREEN_IDLE) && socket.readyState !== socket.OPEN;

  it("is ended after 3 minutes while the video track goes through a TURN relay", async () => {
    const { helper, open } = share();
    const socket = await open();
    helper.say({ t: "rtc.path", relayed: true });
    await vi.advanceTimersByTimeAsync(170_000);
    expect(ended(socket)).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ended(socket)).toBe(true);
    expect(helper.endVideo).toHaveBeenCalled();
  });

  it("goes on while someone uses it: input on the track's own channels, as the app reports it, or a gesture the viewer reports", async () => {
    const { helper, open } = share();
    const socket = await open();
    helper.say({ t: "rtc.path", relayed: true });
    for (let minute = 0; minute < 6; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      if (minute % 2) helper.say({ t: "rtc.activity" });
      else socket.receive({ t: "activity" });
    }
    expect(ended(socket)).toBe(false);
  });

  it("does not count what the viewer sends by itself", async () => {
    const { helper, open } = share();
    const socket = await open();
    helper.say({ t: "rtc.path", relayed: true });
    for (let second = 0; second < 200; second += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      socket.receive({ t: "ping", n: second, at: second });
      socket.receive({ t: "keyframe" });
    }
    expect(ended(socket)).toBe(true);
  });

  it("is never ended for this on a direct path, which costs no one anything", async () => {
    const { helper, open } = share();
    const socket = await open();
    helper.say({ t: "rtc.path", relayed: true });
    await vi.advanceTimersByTimeAsync(60_000);
    helper.say({ t: "rtc.path", relayed: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ended(socket)).toBe(false);
  });

  it("is ended when its frames come down the socket through the gateway, and input there keeps it", async () => {
    const kept = await share().open({ relayed: true, video: false });
    const idle = await share().open({ relayed: true, video: false });
    for (let second = 0; second < 300; second += 30) {
      await vi.advanceTimersByTimeAsync(30_000);
      kept.receive({ t: "move", x: 0.5, y: 0.5 });
    }
    expect(ended(idle)).toBe(true);
    expect(kept.readyState).toBe(kept.OPEN);
    expect(kept.messages.some((message) => typeof message.error === "string")).toBe(false);
  });

  it("is never ended for this when the socket's frames don't go through a gateway", async () => {
    const { open } = share();
    const socket = await open({ relayed: false, video: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ended(socket)).toBe(false);
  });

  it("waits while the picture is paused: nothing is sent then", async () => {
    const { helper, open } = share();
    const socket = await open();
    helper.say({ t: "rtc.path", relayed: true });
    socket.receive({ t: "hidden" });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(ended(socket)).toBe(false);
    socket.receive({ t: "shown" });
    await vi.advanceTimersByTimeAsync(170_000);
    expect(ended(socket)).toBe(false);
  });

  it("follows LINKSHELL_SCREEN_IDLE_SECONDS, and 0 turns the limit off", async () => {
    vi.stubEnv("LINKSHELL_SCREEN_IDLE_SECONDS", "20");
    const short = share();
    const socket = await short.open();
    short.helper.say({ t: "rtc.path", relayed: true });
    await vi.advanceTimersByTimeAsync(26_000);
    expect(ended(socket)).toBe(true);

    vi.stubEnv("LINKSHELL_SCREEN_IDLE_SECONDS", "0");
    const off = share();
    const kept = await off.open();
    off.helper.say({ t: "rtc.path", relayed: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ended(kept)).toBe(false);
  });
});
