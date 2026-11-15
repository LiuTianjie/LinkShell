import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { windowsHelper } from "../windows-screen.js";
import { windowsMedia } from "../windows-video.js";
import { processSource, type FusionAppInfo, type FusionMonitor, type FusionPlatform, type FusionVideoSource, type FusionWindowInfo, type InputTarget } from "./platform.js";

/**
 * Windows' half of a Fusion remote (docs/v2/fusion.md §8.2): `LinkShell.Screen.exe --fusion`
 * watches the fused apps' windows, lists and launches apps, resizes, focuses, closes and types;
 * `--fusion-video <hwnd>` captures one window (FFmpeg's gfxcapture) into the same hardware H.264
 * as the remote screen. JSON lines on stdin / stdout, as the screen helper's other modes.
 */
export class WindowsFusionPlatform implements FusionPlatform {
  readonly platform = "windows" as const;
  private child?: ChildProcess;
  private monitorList: FusionMonitor[] = [{ index: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }];
  private listener?: (windows: FusionWindowInfo[]) => void;
  private latest: FusionWindowInfo[] = [];
  private readonly fused = new Set<string>();
  private readonly replies = new Map<number, (message: Record<string, unknown>) => void>();
  private nextRequest = 1;

  constructor(private readonly helper = windowsHelper(), private readonly ffmpeg = windowsMedia()) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    if (!this.helper) throw new Error("请安装 Windows 桌面版（缺少 LinkShell.Screen.exe）");
    const child = spawn(this.helper, ["--fusion"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin?.on("error", () => undefined);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      this.receive(message);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      for (const reply of this.replies.values()) reply({ t: "error", message: "Windows 屏幕组件已退出" });
      this.replies.clear();
      // A session is watching: the helper comes back by itself (it exits on a locked desktop's errors, say).
      if (this.listener) setTimeout(() => { if (this.listener && !this.child) { try { this.ensure(); } catch { /* No helper: nothing to watch. */ } } }, 1_000).unref?.();
    });
    child.stdin?.write(`${JSON.stringify({ t: "fuse", apps: [...this.fused] })}\n`);
    return child;
  }

  private write(message: Record<string, unknown>): void {
    const child = this.ensure();
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private request(message: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const rid = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(rid); reject(new Error("Windows 屏幕组件没有响应")); }, timeoutMs);
      timer.unref?.();
      this.replies.set(rid, (reply) => { clearTimeout(timer); resolve(reply); });
      this.write({ ...message, rid });
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.rid === "number") {
      const reply = this.replies.get(message.rid);
      this.replies.delete(message.rid);
      reply?.(message);
      return;
    }
    if (message.t === "monitors" && Array.isArray(message.monitors)) {
      this.monitorList = message.monitors.map((m) => {
        const mon = m as Record<string, number>;
        return { index: mon.index ?? 0, rect: { x: mon.x ?? 0, y: mon.y ?? 0, w: mon.w ?? 1920, h: mon.h ?? 1080 }, scale: mon.scale || 1 };
      });
    }
    if (message.t === "windows" && Array.isArray(message.windows)) {
      this.latest = message.windows.map((w) => parseWindow(w as Record<string, unknown>));
      this.listener?.(this.latest);
    }
  }

  watch(onWindows: (windows: FusionWindowInfo[]) => void): void {
    this.listener = onWindows;
    this.ensure();
    onWindows(this.latest);
  }

  monitors(): FusionMonitor[] { return this.monitorList; }

  async apps(): Promise<FusionAppInfo[]> {
    const reply = await this.request({ t: "apps" }, 20_000);
    return Array.isArray(reply.apps) ? (reply.apps as FusionAppInfo[]) : [];
  }

  async icon(app: string): Promise<Buffer | undefined> {
    // Icons queue behind each other at a session's start (one per catalog app): a long wait is fine.
    const reply = await this.request({ t: "icon", app }, 30_000);
    return typeof reply.png === "string" ? Buffer.from(reply.png, "base64") : undefined;
  }

  setFused(apps: string[]): void {
    this.fused.clear();
    for (const app of apps) this.fused.add(app);
    this.write({ t: "fuse", apps: [...this.fused] });
  }

  async launch(app: string): Promise<void> {
    const reply = await this.request({ t: "launch", app }, 20_000);
    if (reply.ok !== true) throw new Error(typeof reply.error === "string" ? reply.error : "无法启动");
  }

  quit(app: string, force: boolean): void { this.write({ t: "quit", app, force }); }
  resize(id: number, w: number, h: number): void { this.write({ t: "resize", hwnd: id, w, h }); }
  focus(id: number): void { this.write({ t: "focus", hwnd: id }); }
  close(id: number): void { this.write({ t: "close", hwnd: id }); }

  input(target: InputTarget, event: Record<string, unknown>): void {
    this.write({ t: "input", ...("window" in target ? { hwnd: target.window } : { monitor: target.monitor }), event });
  }

  windowVideo(id: number, canvas: { w: number; h: number }, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
    if (!this.helper || !this.ffmpeg) throw new Error("Windows 视频组件缺失");
    const child = spawn(this.helper, ["--fusion-video", String(id), String(canvas.w), String(canvas.h), String(fps), String(bitrate), this.ffmpeg], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return processSource(child, onUnit, onEnd);
  }

  monitorVideo(index: number, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
    if (!this.helper || !this.ffmpeg) throw new Error("Windows 视频组件缺失");
    const width = Math.min(1920, this.monitorList.find((m) => m.index === index)?.rect.w ?? 1920);
    const child = spawn(this.helper, ["--video", String(index), String(width), String(fps), String(bitrate), this.ffmpeg], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return processSource(child, onUnit, onEnd);
  }

  stop(): void {
    this.listener = undefined;
    const child = this.child;
    this.child = undefined;
    child?.stdin?.end();
    setTimeout(() => { if (child && child.exitCode === null) child.kill(); }, 1_500).unref?.();
  }
}

export function parseWindow(w: Record<string, unknown>): FusionWindowInfo {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const buttons = (w.buttons ?? {}) as Record<string, Record<string, number>>;
  const rect = (r: Record<string, number> | undefined) => (r ? { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) } : undefined);
  return {
    id: n(w.id), pid: n(w.pid), app: String(w.app ?? ""), title: String(w.title ?? ""),
    rect: { x: n(w.x), y: n(w.y), w: n(w.w), h: n(w.h) }, monitor: n(w.monitor), popup: w.popup === true,
    ...(typeof w.owner === "number" ? { owner: w.owner } : {}),
    minimized: w.minimized === true,
    buttons: { close: rect(buttons.close), minimize: rect(buttons.minimize), zoom: rect(buttons.zoom) },
    hitrects: (Array.isArray(w.hitrects) ? w.hitrects : []).flatMap((r) => { const v = rect(r as Record<string, number>); return v ? [v] : []; }),
  };
}
