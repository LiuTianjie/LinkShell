import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { inputEvent, type AppDisplay, type VideoConfiguration, type VideoConfigured, type VideoOffer, type VideoSignal } from "./input.js";
import { ScreenInputOrder } from "./screen-h264.js";
import { fusionInput, type FusionLayout, type FusionMediaEvents } from "./fusion/media.js";
import { windowsHelper } from "./windows-screen.js";

export interface WindowsMediaStatus {
  recording: boolean;
  trusted: boolean;
  app: string;
  video: boolean;
  videoReconfigure: boolean;
  keys: boolean;
  hevc: boolean;
  hwH264: boolean;
  adapter?: string;
  wgc?: boolean;
}

const videoConfiguredSchema = z.object({
  screen: z.number().int().nonnegative(),
  width: z.number().int().min(2).max(3840),
  height: z.number().int().min(2).max(16384),
  maxFps: z.number().int().min(1).max(120),
  paused: z.boolean(),
  generation: z.number().int().nonnegative().safe().optional(),
});

/** Locates the native C++20 libwebrtc media engine (`LinkShell.Media.exe`). */
export function windowsMediaBinary(): string | undefined {
  if (process.platform !== "win32" || process.env.LINKSHELL_WINDOWS_MEDIA === "off") return undefined;
  const envPath = process.env.LINKSHELL_WINDOWS_MEDIA;
  if (envPath && existsSync(envPath)) return envPath;
  const bundle = process.env.LINKSHELL_APP_BUNDLE;
  if (bundle) {
    const candidate = join(bundle, "LinkShell.Media.exe");
    if (existsSync(candidate)) return candidate;
  }
  const helper = windowsHelper();
  if (helper) {
    const beside = join(dirname(helper), "LinkShell.Media.exe");
    if (existsSync(beside)) return beside;
  }
  return undefined;
}

type Route = (message: Record<string, unknown>) => void;

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseDisplays(list: unknown): AppDisplay[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const d = entry as Partial<Record<keyof AppDisplay, unknown>> | null;
    if (!d || typeof d.screen !== "number" || !Number.isInteger(d.screen) || d.screen < 0) return [];
    return [{
      screen: d.screen,
      name: typeof d.name === "string" ? d.name.slice(0, 80) : `屏幕 ${d.screen + 1}`,
      w: typeof d.w === "number" ? d.w : 0,
      h: typeof d.h === "number" ? d.h : 0,
      main: d.main === true,
    }];
  });
}

function parseStatus(message: Record<string, unknown>): WindowsMediaStatus {
  return {
    recording: message.recording !== false,
    trusted: message.trusted !== false,
    app: typeof message.app === "string" ? message.app : "LinkShell",
    video: message.video !== false,
    videoReconfigure: message.videoReconfigure === true,
    keys: message.keys === true,
    hevc: message.hevc === true,
    hwH264: message.hwH264 === true,
    ...(typeof message.adapter === "string" ? { adapter: message.adapter } : {}),
    ...(typeof message.wgc === "boolean" ? { wgc: message.wgc } : {}),
  };
}

/**
 * Manages the singleton native C++20 libwebrtc engine (`LinkShell.Media.exe --engine`),
 * speaking the same newline-delimited JSON signaling contract as LinkShell.app on macOS.
 */
export class WindowsMediaEngine {
  private child?: ChildProcess;
  private statusCache?: WindowsMediaStatus;
  private readonly videoRoutes = new Map<string, Route>();
  private readonly fusionRoutes = new Map<string, Route>();
  private readonly configuring = new Map<string, Map<number, { resolve(value: VideoConfigured): void; reject(error: Error): void }>>();
  private statusWaiters: { resolve(status: WindowsMediaStatus): void; reject(error: Error): void }[] = [];
  private displayWaiters: { resolve(displays: AppDisplay[]): void; reject(error: Error): void }[] = [];

  constructor(
    private readonly binary: string,
    private readonly log: (message: string) => void,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.stdin && !this.child.stdin.destroyed) {
      return this.child;
    }
    const child = this.spawnProcess(this.binary, ["--engine"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.statusCache = undefined;
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log(`[win-media] ${text.slice(0, 1000)}`);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const msg = parseJsonLine(line);
      if (msg) this.dispatch(msg);
    });
    const teardown = (reason: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.statusCache = undefined;
      for (const id of this.configuring.keys()) this.cancelConfigurations(id);
      for (const route of this.videoRoutes.values()) route({ t: "gone" });
      this.videoRoutes.clear();
      for (const route of this.fusionRoutes.values()) route({ t: "gone" });
      this.fusionRoutes.clear();
      for (const waiter of this.statusWaiters.splice(0)) waiter.reject(new Error(reason));
      for (const waiter of this.displayWaiters.splice(0)) waiter.reject(new Error(reason));
    };
    child.on("error", (error) => {
      this.log(`[win-media] engine spawn error: ${error.message}`);
      teardown(`Windows 媒体引擎启动失败：${error.message}`);
    });
    child.on("exit", (code) => {
      if (this.child === child && code && code !== 0) this.log(`[win-media] engine exited ${code}`);
      teardown("Windows 媒体引擎已退出");
    });
    return child;
  }

  private dispatch(message: Record<string, unknown>): void {
    const kind = typeof message.t === "string" ? message.t : "";
    if (kind === "status") {
      this.statusCache = parseStatus(message);
      for (const waiter of this.statusWaiters.splice(0)) waiter.resolve(this.statusCache);
      return;
    }
    if (kind === "log" && typeof message.message === "string") {
      this.log(`[win-media] ${message.message.slice(0, 2000)}`);
      return;
    }
    if (kind === "displays") {
      const list = parseDisplays(message.list);
      for (const waiter of this.displayWaiters.splice(0)) waiter.resolve(list);
      return;
    }
    if (typeof message.v === "string") {
      const waiting = typeof message.requestId === "number" ? this.configuring.get(message.v)?.get(message.requestId) : undefined;
      if (waiting && (kind === "rtc.configured" || kind === "rtc.configure.error")) {
        if (kind === "rtc.configure.error") {
          waiting.reject(new Error(typeof message.message === "string" ? message.message : "屏幕设置未能应用，请重试"));
        } else {
          const parsed = videoConfiguredSchema.safeParse(message);
          if (parsed.success) waiting.resolve(parsed.data);
          else waiting.reject(new Error("电脑返回的屏幕设置无效，请重试"));
        }
      }
      this.videoRoutes.get(message.v)?.(message);
      return;
    }
    if (kind.startsWith("fusion.") && typeof message.id === "string") {
      this.fusionRoutes.get(message.id)?.(message);
    }
  }

  private write(message: object): void {
    const child = this.ensure();
    if (child.stdin?.writable && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  async status(timeoutMs = 8_000): Promise<WindowsMediaStatus> {
    this.ensure();
    if (this.statusCache) return this.statusCache;
    return new Promise<WindowsMediaStatus>((resolve, reject) => {
      const entry = {
        resolve: (value: WindowsMediaStatus) => { clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const idx = this.statusWaiters.indexOf(entry);
        if (idx >= 0) this.statusWaiters.splice(idx, 1);
        reject(new Error("Windows 媒体引擎启动超时"));
      }, timeoutMs);
      timer.unref?.();
      this.statusWaiters.push(entry);
      this.write({ t: "status" });
    });
  }

  async displays(timeoutMs = 8_000): Promise<AppDisplay[]> {
    this.ensure();
    return new Promise<AppDisplay[]>((resolve, reject) => {
      const entry = {
        resolve: (value: AppDisplay[]) => { clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const idx = this.displayWaiters.indexOf(entry);
        if (idx >= 0) this.displayWaiters.splice(idx, 1);
        reject(new Error("无法枚举 Windows 显示器"));
      }, timeoutMs);
      timer.unref?.();
      this.displayWaiters.push(entry);
      this.write({ t: "displays" });
    });
  }

  async offerVideo(id: string, offer: VideoOffer, route: Route): Promise<void> {
    await this.status();
    this.videoRoutes.set(id, route);
    const { audio, ...rest } = offer;
    this.write({ t: "rtc.open", v: id, ...rest, ...(audio !== undefined ? { audio } : {}) });
  }

  signal(id: string, signal: VideoSignal): void {
    if (this.videoRoutes.has(id)) this.write({ ...signal, v: id });
  }

  configureVideo(id: string, configuration: VideoConfiguration): Promise<VideoConfigured> {
    if (!this.child || this.child.exitCode !== null || !this.videoRoutes.has(id)) {
      return Promise.reject(new Error("屏幕连接已断开"));
    }
    return new Promise((resolve, reject) => {
      const requests: Map<number, { resolve(value: VideoConfigured): void; reject(error: Error): void }> = this.configuring.get(id) ?? new Map();
      this.configuring.set(id, requests);
      const finish = () => {
        clearTimeout(timer);
        requests.delete(configuration.requestId);
        if (!requests.size) this.configuring.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("应用屏幕设置超时，请重试"));
      }, 15_000);
      timer.unref?.();
      requests.set(configuration.requestId, {
        resolve: (value: VideoConfigured) => { finish(); resolve(value); },
        reject: (error: Error) => { finish(); reject(error); },
      });
      try {
        this.write({ t: "rtc.configure", v: id, ...configuration });
      } catch (error) {
        finish();
        reject(error);
      }
    });
  }

  setAudio(id: string, enabled: boolean): void {
    if (this.videoRoutes.has(id)) this.write({ t: "rtc.audio", v: id, enabled });
  }

  endVideo(id: string): void {
    this.cancelConfigurations(id);
    if (!this.videoRoutes.delete(id)) return;
    if (this.child && this.child.exitCode === null) this.write({ t: "rtc.close", v: id });
  }

  // ── Native Fusion multi-stream WebRTC API ───────────────────────────────

  openFusion(id: string, iceServers: unknown[], route: Route): void {
    this.fusionRoutes.set(id, route);
    this.write({ t: "fusion.open", id, iceServers });
  }

  openFusionStream(id: string, params: {
    key: string;
    kind: "window" | "monitor";
    hwnd?: number;
    screen?: number;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    layout?: FusionLayout;
  }): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.stream.open", id, ...params });
  }

  updateFusionLayout(id: string, key: string, layout: FusionLayout): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.stream.layout", id, key, layout });
  }

  closeFusionStream(id: string, key: string): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.stream.close", id, key });
  }

  fusionAnswer(id: string, sdp: string): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.answer", id, sdp });
  }

  fusionIce(id: string, candidate: string, sdpMid?: string | null, sdpMLineIndex?: number | null): void {
    if (this.fusionRoutes.has(id)) {
      this.write({ t: "fusion.ice", id, candidate, sdpMid: sdpMid ?? "", sdpMLineIndex: sdpMLineIndex ?? 0 });
    }
  }

  fusionShape(id: string, shape: Record<string, unknown>): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.shape", id, shape });
  }

  fusionCursor(id: string, x: number, y: number): void {
    if (this.fusionRoutes.has(id)) this.write({ t: "fusion.cursor", id, x, y });
  }

  closeFusion(id: string): void {
    if (!this.fusionRoutes.delete(id)) return;
    if (this.child && this.child.exitCode === null) this.write({ t: "fusion.close", id });
  }

  private cancelConfigurations(id: string): void {
    for (const req of this.configuring.get(id)?.values() ?? []) req.reject(new Error("屏幕连接已断开"));
    this.configuring.delete(id);
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.statusCache = undefined;
    if (!child || child.exitCode !== null) return;
    try { child.stdin?.write(`${JSON.stringify({ t: "quit" })}\n`); } catch { /* ignore */ }
    child.stdin?.end();
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500).unref?.();
  }
}

let sharedEngine: WindowsMediaEngine | undefined;

export function windowsMediaEngine(log: (message: string) => void): WindowsMediaEngine | undefined {
  const binary = windowsMediaBinary();
  if (!binary) return undefined;
  sharedEngine ??= new WindowsMediaEngine(binary, log);
  return sharedEngine;
}

export function closeWindowsMediaEngine(): void {
  sharedEngine?.close();
  sharedEngine = undefined;
}

/**
 * Native C++ libwebrtc Fusion media transport replacing werift + FFmpeg on Windows.
 * Streams windows via GPU WGC (fixed canvas + SEI metadata) and monitors via GPU WGC/DXGI.
 */
export class WindowsNativeFusionMedia {
  readonly id = `win-fusion-${randomBytes(6).toString("hex")}`;
  private readonly order = new ScreenInputOrder();
  private readonly streamLayouts = new Map<string, () => FusionLayout | undefined>();
  private readonly lastLayoutText = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly engine: WindowsMediaEngine,
    private readonly events: FusionMediaEvents,
  ) {}

  start(iceServers: unknown[]): void {
    this.events.signal({ t: "config", iceServers });
    this.engine.openFusion(this.id, iceServers, (msg) => {
      if (this.closed) return;
      const kind = typeof msg.t === "string" ? msg.t : "";
      if (kind === "fusion.streams" && Array.isArray(msg.streams)) {
        this.events.signal({ t: "streams", streams: msg.streams });
      } else if (kind === "fusion.offer" && typeof msg.sdp === "string") {
        this.events.signal({ t: "offer", sdp: msg.sdp });
      } else if (kind === "fusion.ice" && typeof msg.candidate === "string") {
        this.events.signal({
          t: "ice",
          candidate: msg.candidate,
          sdpMid: msg.sdpMid ?? null,
          sdpMLineIndex: msg.sdpMLineIndex ?? 0,
        });
      } else if (kind === "fusion.state" && typeof msg.connection === "string") {
        this.events.log(`[fusion] native media: connection ${msg.connection}`);
        this.events.signal({ t: "state", connection: msg.connection });
      } else if (kind === "fusion.input" && msg.message && typeof msg.message === "object") {
        const parsed = fusionInput(msg.message as Record<string, unknown>);
        if (!parsed || !this.streamLayouts.has(parsed.stream)) return;
        const lossy = msg.lossy === true;
        if (inputEvent.safeParse(parsed.event).success && this.order.accept(parsed.event, lossy)) {
          this.events.input(parsed.stream, parsed.event);
        }
      } else if (kind === "fusion.error" && typeof msg.key === "string") {
        this.events.error(msg.key, typeof msg.message === "string" ? msg.message : "窗口捕获失败");
      } else if (kind === "gone") {
        this.events.log("[fusion] native Windows media engine exited");
      }
    });
  }

  openWindow(
    key: string,
    hwnd: number,
    canvas: { w: number; h: number },
    fps: number,
    bitrate: number,
    layout: () => FusionLayout | undefined,
  ): void {
    if (this.closed || this.streamLayouts.has(key)) return;
    this.streamLayouts.set(key, layout);
    const current = layout();
    if (current) this.lastLayoutText.set(key, JSON.stringify(current));
    this.engine.openFusionStream(this.id, {
      key, kind: "window", hwnd, width: canvas.w, height: canvas.h, fps, bitrate,
      ...(current ? { layout: current } : {}),
    });
  }

  openMonitor(
    key: string,
    screen: number,
    width: number,
    fps: number,
    bitrate: number,
    layout: () => FusionLayout | undefined,
  ): void {
    if (this.closed || this.streamLayouts.has(key)) return;
    this.streamLayouts.set(key, layout);
    const current = layout();
    if (current) this.lastLayoutText.set(key, JSON.stringify(current));
    this.engine.openFusionStream(this.id, {
      key, kind: "monitor", screen, width, height: Math.round(width * 9 / 16), fps, bitrate,
      ...(current ? { layout: current } : {}),
    });
  }

  syncLayouts(): void {
    if (this.closed) return;
    for (const [key, layoutFn] of this.streamLayouts) {
      const next = layoutFn();
      if (!next) continue;
      const serialized = JSON.stringify(next);
      if (this.lastLayoutText.get(key) === serialized) continue;
      this.lastLayoutText.set(key, serialized);
      this.engine.updateFusionLayout(this.id, key, next);
    }
  }

  close(key: string): void {
    if (!this.streamLayouts.delete(key)) return;
    this.lastLayoutText.delete(key);
    if (!this.closed) this.engine.closeFusionStream(this.id, key);
  }

  receive(m: Record<string, unknown>): void {
    if (this.closed) return;
    if (m.t === "control") {
      this.events.signal({ t: "control", available: true, trusted: true });
      return;
    }
    if (m.t === "answer" && typeof m.sdp === "string") {
      this.engine.fusionAnswer(this.id, m.sdp);
    } else if (m.t === "ice" && typeof m.candidate === "string") {
      this.engine.fusionIce(
        this.id,
        m.candidate,
        typeof m.sdpMid === "string" ? m.sdpMid : null,
        typeof m.sdpMLineIndex === "number" ? m.sdpMLineIndex : 0,
      );
    }
  }

  sendShape(shape: Record<string, unknown>): void {
    if (!this.closed) this.engine.fusionShape(this.id, shape);
  }

  sendCursor(x: number, y: number): void {
    if (!this.closed) this.engine.fusionCursor(this.id, x, y);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.streamLayouts.clear();
    this.lastLayoutText.clear();
    this.engine.closeFusion(this.id);
  }
}
