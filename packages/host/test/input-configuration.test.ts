import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelperApp, InputControl } from "../src/input.js";

class HelperSocket extends Duplex {
  readonly messages: Record<string, unknown>[] = [];
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.messages.push(JSON.parse(chunk.toString()));
    callback();
  }
  receive(message: object) { this.push(`${JSON.stringify(message)}\n`); }
}

const helpers: HelperApp[] = [];
async function connected() {
  const app = new HelperApp("unused-test-helper", false, () => {});
  helpers.push(app);
  const socket = new HelperSocket();
  (app as unknown as { adopt(socket: Socket): void }).adopt(socket as unknown as Socket);
  const route = vi.fn();
  await app.offerVideo("viewer", { screen: 0, iceServers: [] }, route);
  return { app, socket, route };
}
const requested = { requestId: 1, screen: 1, maxWidth: 1920, maxFps: 120, paused: false, inputGeneration: 3 };
const reply = { t: "rtc.configured", v: "viewer", requestId: 1, screen: 1, width: 1920, height: 1080, maxFps: 120, paused: false, generation: 3 };

afterEach(() => { for (const app of helpers.splice(0)) app.close(); vi.useRealTimers(); });

describe("the helper's additive video configuration protocol", () => {
  it("correlates acknowledgements to both viewer and request, preserving input generation", async () => {
    const { app, socket } = await connected();
    const resolved = vi.fn();
    const pending = app.configureVideo("viewer", requested).then((value) => { resolved(value); return value; });
    expect(socket.messages.at(-1)).toEqual({ t: "rtc.configure", v: "viewer", ...requested });
    socket.receive({ ...reply, v: "old-viewer" });
    socket.receive({ ...reply, requestId: 0 });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    socket.receive(reply);
    await expect(pending).resolves.toEqual({ screen: 1, width: 1920, height: 1080, maxFps: 120, paused: false, generation: 3 });
    expect(socket.messages.filter((message) => message.t === "rtc.open")).toHaveLength(1);
  });

  it("rejects invalid results or helper failures without closing the video", async () => {
    const { app, socket } = await connected();
    const invalid = app.configureVideo("viewer", requested);
    socket.receive({ ...reply, width: -1 });
    await expect(invalid).rejects.toThrow("电脑返回的屏幕设置无效");
    const failure = app.configureVideo("viewer", { ...requested, requestId: 2 });
    socket.receive({ t: "rtc.configure.error", v: "viewer", requestId: 2, message: "capture unavailable" });
    await expect(failure).rejects.toThrow("屏幕设置未能应用");
    expect(socket.messages.some((message) => message.t === "rtc.close")).toBe(false);
    const retried = app.configureVideo("viewer", { ...requested, requestId: 3 });
    socket.receive({ ...reply, requestId: 3 });
    await expect(retried).resolves.toMatchObject({ generation: 3 });
  });

  it("cancels pending configuration when the viewer closes and rejects late replies", async () => {
    vi.useFakeTimers();
    const { app, socket } = await connected();
    const pending = app.configureVideo("viewer", requested);
    app.endVideo("viewer");
    await expect(pending).rejects.toThrow("屏幕连接已断开");
    socket.receive(reply);
    expect(vi.getTimerCount()).toBe(0);
    await expect(app.configureVideo("viewer", { ...requested, requestId: 2 })).rejects.toThrow("屏幕连接已断开");
  });

  it("requires an explicit true capability from the helper", async () => {
    const { app, socket } = await connected();
    const legacy = app.access();
    await Promise.resolve();
    socket.receive({ t: "status", video: true, trusted: true, recording: true });
    await expect(legacy).resolves.toMatchObject({ video: true, videoReconfigure: false });
    const current = app.access();
    await Promise.resolve();
    socket.receive({ t: "status", video: true, trusted: true, recording: true, videoReconfigure: true });
    await expect(current).resolves.toMatchObject({ videoReconfigure: true });
  });

  it("keeps teardown release reports while suppressing stopped control state, cursor and input", async () => {
    const { app, socket } = await connected();
    const listener = { state: vi.fn(), cursor: vi.fn(), posted: vi.fn() };
    const control = new InputControl(listener, () => {}, { dryRun: true });
    await (control as unknown as { joinApp(app: HelperApp, screen: number): Promise<void> }).joinApp(app, 0);
    const viewer = socket.messages.find((message) => message.t === "open")!.v;
    socket.receive({ t: "ready", v: viewer, trusted: true, app: "LinkShell" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listener.state).toHaveBeenCalledTimes(1);
    control.send({ t: "down", b: "left" });
    control.stop();
    expect(socket.messages.at(-1)).toEqual({ t: "close", v: viewer });
    const sent = socket.messages.length;

    // The real helper emits the release after reading close. Its audit remains observable;
    // none of the old viewer's interactive callbacks can revive control of that display.
    socket.receive({ t: "posted", v: viewer, kind: "up", b: "left" });
    socket.receive({ t: "ready", v: viewer, trusted: true, app: "late helper" });
    socket.receive({ t: "cursor", v: viewer, x: 0.4, y: 0.6 });
    socket.receive({ t: "gone", v: viewer });
    control.send({ t: "text", s: "must not be posted" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listener.posted).toHaveBeenCalledExactlyOnceWith({ t: "posted", v: viewer, kind: "up", b: "left" });
    expect(listener.state).toHaveBeenCalledTimes(1);
    expect(listener.cursor).not.toHaveBeenCalled();
    expect(socket.messages).toHaveLength(sent);
  });
});
