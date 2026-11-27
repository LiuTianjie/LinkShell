import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsMediaEngine, WindowsNativeFusionMedia } from "../src/windows-media.js";

class FakeMediaProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly sent: Record<string, unknown>[] = [];
  private stdinBuffer = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString("utf8");
      for (;;) {
        const nl = this.stdinBuffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.stdinBuffer.slice(0, nl).trim();
        this.stdinBuffer = this.stdinBuffer.slice(nl + 1);
        if (line) this.sent.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  reply(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill = vi.fn(() => {
    if (this.exitCode === null) {
      this.exitCode = 0;
      this.emit("exit", 0);
    }
    return true;
  });
}

describe("WindowsMediaEngine (native C++20 libwebrtc protocol)", () => {
  const activeEngines: WindowsMediaEngine[] = [];

  afterEach(() => {
    for (const engine of activeEngines.splice(0)) engine.close();
  });

  it("handles status, display enumeration, offerVideo, live rtc.configure, rtc.audio, and clean close", async () => {
    const proc = new FakeMediaProcess();
    const spawnMock = vi.fn(() => proc as unknown as ReturnType<typeof import("node:child_process").spawn>);
    const logs: string[] = [];
    const engine = new WindowsMediaEngine("LinkShell.Media.exe", (line) => logs.push(line), spawnMock);
    activeEngines.push(engine);

    const statusPromise = engine.status();
    proc.reply({
      t: "status",
      recording: true,
      trusted: true,
      app: "LinkShell",
      video: true,
      videoReconfigure: true,
      keys: true,
      hevc: true,
      hwH264: true,
      adapter: "NVIDIA GeForce RTX 4060",
      wgc: true,
    });
    const status = await statusPromise;
    expect(status).toEqual({
      recording: true,
      trusted: true,
      app: "LinkShell",
      video: true,
      videoReconfigure: true,
      keys: true,
      hevc: true,
      hwH264: true,
      adapter: "NVIDIA GeForce RTX 4060",
      wgc: true,
    });
    expect(spawnMock).toHaveBeenCalledWith("LinkShell.Media.exe", ["--engine"], expect.objectContaining({ windowsHide: true }));

    const displaysPromise = engine.displays();
    proc.reply({
      t: "displays",
      list: [{ screen: 0, name: "Virtual Display", w: 2560, h: 1440, main: true }],
    });
    expect(await displaysPromise).toEqual([{ screen: 0, name: "Virtual Display", w: 2560, h: 1440, main: true }]);

    const routed: Record<string, unknown>[] = [];
    await engine.offerVideo(
      "sess-1",
      {
        screen: 0,
        maxWidth: 2560,
        maxFps: 120,
        codec: "hevc",
        audio: true,
        match: { w: 2560, h: 1440, scale: 1 },
        iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      },
      (msg) => routed.push(msg),
    );
    expect(proc.sent.at(-1)).toMatchObject({
      t: "rtc.open",
      v: "sess-1",
      screen: 0,
      maxWidth: 2560,
      maxFps: 120,
      codec: "hevc",
      audio: true,
      match: { w: 2560, h: 1440, scale: 1 },
    });

    proc.reply({ t: "rtc.offer", v: "sess-1", sdp: "v=0\r\n" });
    proc.reply({ t: "rtc.path", v: "sess-1", relayed: false });
    proc.reply({ t: "rtc.activity", v: "sess-1" });
    expect(routed.map((m) => m.t)).toEqual(["rtc.offer", "rtc.path", "rtc.activity"]);

    engine.signal("sess-1", { t: "rtc.answer", sdp: "v=0\r\n" });
    engine.setAudio("sess-1", false);
    expect(proc.sent.slice(-2)).toEqual([
      { t: "rtc.answer", v: "sess-1", sdp: "v=0\r\n" },
      { t: "rtc.audio", v: "sess-1", enabled: false },
    ]);

    const configPromise = engine.configureVideo("sess-1", {
      requestId: 7,
      screen: 0,
      maxWidth: 1920,
      maxFps: 60,
      paused: false,
    });
    proc.reply({
      t: "rtc.configured",
      v: "sess-1",
      requestId: 7,
      screen: 0,
      width: 1920,
      height: 1080,
      maxFps: 60,
      paused: false,
      generation: 2,
    });
    expect(await configPromise).toEqual({
      screen: 0,
      width: 1920,
      height: 1080,
      maxFps: 60,
      paused: false,
      generation: 2,
    });

    engine.endVideo("sess-1");
    expect(proc.sent.at(-1)).toEqual({ t: "rtc.close", v: "sess-1" });
  });

  it("rejects pending configurations and notifies active routes if the engine exits", async () => {
    const proc = new FakeMediaProcess();
    const engine = new WindowsMediaEngine(
      "LinkShell.Media.exe",
      () => {},
      vi.fn(() => proc as unknown as ReturnType<typeof import("node:child_process").spawn>),
    );
    activeEngines.push(engine);

    const statusPromise = engine.status();
    proc.reply({ t: "status", video: true, videoReconfigure: true, keys: true });
    await statusPromise;

    const routed: Record<string, unknown>[] = [];
    await engine.offerVideo("sess-crash", { screen: 0, iceServers: [] }, (msg) => routed.push(msg));
    const pendingConfig = engine.configureVideo("sess-crash", { requestId: 1, screen: 0, maxWidth: 1280, maxFps: 60, paused: false });

    proc.exitCode = 1;
    proc.emit("exit", 1);

    await expect(pendingConfig).rejects.toThrow("屏幕连接已断开");
    expect(routed).toContainEqual({ t: "gone" });
  });

  it("handles child spawn error events without crashing the host daemon", async () => {
    const proc = new FakeMediaProcess();
    const logs: string[] = [];
    const engine = new WindowsMediaEngine(
      "LinkShell.Media.exe",
      (line) => logs.push(line),
      vi.fn(() => proc as unknown as ReturnType<typeof import("node:child_process").spawn>),
    );
    activeEngines.push(engine);

    const pendingStatus = engine.status();
    proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    await expect(pendingStatus).rejects.toThrow("Windows 媒体引擎启动失败");
    expect(logs.some((line) => line.includes("spawn ENOENT"))).toBe(true);
  });
});

describe("WindowsNativeFusionMedia (native multi-transceiver WGC/DXGI engine)", () => {
  it("opens window & monitor tracks, deduplicates layout updates, validates ordered input, and forwards signaling", () => {
    const proc = new FakeMediaProcess();
    const engine = new WindowsMediaEngine(
      "LinkShell.Media.exe",
      () => {},
      vi.fn(() => proc as unknown as ReturnType<typeof import("node:child_process").spawn>),
    );
    const signals: Record<string, unknown>[] = [];
    const inputs: { stream: string; event: unknown }[] = [];
    const errors: { key: string; message: string }[] = [];

    const media = new WindowsNativeFusionMedia(engine, {
      signal: (m) => signals.push(m),
      input: (stream, event) => inputs.push({ stream, event }),
      error: (key, message) => errors.push({ key, message }),
      log: () => {},
    });

    media.start([{ urls: ["stun:stun.example.com:3478"] }]);
    expect(signals[0]).toEqual({ t: "config", iceServers: [{ urls: ["stun:stun.example.com:3478"] }] });
    expect(proc.sent[0]).toEqual({ t: "fusion.open", id: media.id, iceServers: [{ urls: ["stun:stun.example.com:3478"] }] });

    let width = 800;
    media.openWindow("w:42", 42, { w: 1920, h: 1080 }, 60, 8_000_000, () => [0, 0, width, 600]);
    expect(proc.sent.at(-1)).toMatchObject({
      t: "fusion.stream.open",
      id: media.id,
      key: "w:42",
      kind: "window",
      hwnd: 42,
      width: 1920,
      height: 1080,
      fps: 60,
      layout: [0, 0, 800, 600],
    });

    const beforeSync = proc.sent.length;
    media.syncLayouts();
    expect(proc.sent.length).toBe(beforeSync);

    width = 1024;
    media.syncLayouts();
    expect(proc.sent.at(-1)).toMatchObject({
      t: "fusion.stream.layout",
      id: media.id,
      key: "w:42",
      layout: [0, 0, 1024, 600],
    });

    media.receive({ t: "control" });
    expect(signals.at(-1)).toEqual({ t: "control", available: true, trusted: true });

    media.receive({ t: "answer", sdp: "v=0\r\n" });
    media.receive({ t: "ice", candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    expect(proc.sent.slice(-2)).toEqual([
      { t: "fusion.answer", id: media.id, sdp: "v=0\r\n" },
      { t: "fusion.ice", id: media.id, candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    ]);

    proc.reply({ t: "fusion.streams", id: media.id, streams: [{ mid: "0", k: "w:42" }] });
    proc.reply({ t: "fusion.offer", id: media.id, sdp: "v=0\r\n" });
    proc.reply({ t: "fusion.input", id: media.id, lossy: true, message: { stream: "w:42", t: "move", x: 0.5, y: 0.5, i: 10 } });
    proc.reply({ t: "fusion.input", id: media.id, lossy: true, message: { stream: "w:42", t: "move", x: 0.2, y: 0.2, i: 8 } });
    proc.reply({ t: "fusion.input", id: media.id, lossy: false, message: { stream: "w:42", t: "key", k: "Return", i: 11 } });
    proc.reply({ t: "fusion.error", id: media.id, key: "w:42", message: "窗口已关闭" });

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({ stream: "w:42", event: { t: "move", x: 0.5, y: 0.5, i: 10 } });
    expect(inputs[1]).toEqual({ stream: "w:42", event: { t: "key", k: "Return", i: 11 } });
    expect(errors).toEqual([{ key: "w:42", message: "窗口已关闭" }]);

    media.close("w:42");
    media.end();
    expect(proc.sent.slice(-2)).toEqual([
      { t: "fusion.stream.close", id: media.id, key: "w:42" },
      { t: "fusion.close", id: media.id },
    ]);
    engine.close();
  });
});
