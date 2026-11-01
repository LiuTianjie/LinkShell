import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Events = { open(): void; data(value: string | ArrayBuffer): void; close(reason?: string): void };
const sockets = vi.hoisted(() => [] as { path: string; events: Events; sent: string[] }[]);

vi.mock("../src/live/transport", () => ({
  openWebSocket: async (_streams: unknown, _port: number, path: string, events: Events) => {
    const socket = { path, events, sent: [] as string[], send(text: string) { socket.sent.push(text); }, close() {} };
    sockets.push(socket);
    queueMicrotask(() => events.open());
    return socket;
  },
}));

import { SCREEN_IDLE, ScreenReceiver, type ReceiverState } from "../src/live/screen-receiver";

class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
}

async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }

function receiver(options: { videoTrack?: boolean } = {}) {
  const states: ReceiverState[] = [];
  const created = new ScreenReceiver({
    link: { call: async () => ({ port: 5000, token: "t", displays: [{ index: 0, name: "A" }] }) } as never,
    streams: {} as never,
    target: { display: 0, width: 1920, maxFps: 60 },
    active: true,
    control: false,
    hevc: false,
    relayed: true,
    ...options,
    video: new FakeVideo() as unknown as HTMLVideoElement,
    canvas: { getContext: () => null } as unknown as HTMLCanvasElement,
    onState: (state) => states.push(state),
    onCursor: () => {},
  });
  return { created, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  sockets.length = 0;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the desktop's screen receiver", () => {
  it("says it takes a TURN login, and asks for a video track unless told to go straight to the socket", async () => {
    receiver();
    receiver({ videoTrack: false });
    await settle();
    const [track, socket] = sockets.map((entry) => new URL(entry.path, "http://localhost").searchParams);
    expect(track!.get("turn")).toBe("1");
    expect(track!.get("video")).toBe("1");
    expect(socket!.get("video")).toBe("0");
  });

  it("says someone uses the picture at most every 15 s", async () => {
    const { created } = receiver();
    await settle();
    const said = () => sockets[0]!.sent.filter((text) => JSON.parse(text).t === "activity").length;
    created.used();
    created.used();
    expect(said()).toBe(1);
    vi.advanceTimersByTime(15_000);
    created.used();
    expect(said()).toBe(2);
    created.stop();
  });

  it("ends for good when the host ended an unused relayed picture: no other path is tried", async () => {
    const { created, states } = receiver();
    await settle();
    sockets[0]!.events.data(JSON.stringify({ error: SCREEN_IDLE }));
    expect(states.at(-1)).toMatchObject({ phase: "error", idle: true, taken: false });
    expect(sockets[0]!.sent.some((text) => JSON.parse(text).t === "rtc.failed")).toBe(false);
    expect(created.state.idle).toBe(true);
  });
});
