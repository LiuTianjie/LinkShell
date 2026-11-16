import { spawn } from "node:child_process";
import { processSource, type FusionAppInfo, type FusionClip, type FusionMonitor, type FusionPlatform, type FusionVideoSource, type FusionWindowInfo, type InputTarget } from "./platform.js";

/**
 * A remote with one app whose window shows ffmpeg's test picture: any computer with ffmpeg (and
 * libx264) can stand in for a Windows remote, so the local halves are tested without one
 * (docs/v2/fusion.md §8.4). `LINKSHELL_FUSION_SIMULATED=1` makes a host use it.
 */
export const SIMULATED_APP = "linkshell.simulated.pattern";

export class SimulatedFusionPlatform implements FusionPlatform {
  readonly platform = "simulated" as const;
  readonly inputs: Array<{ target: InputTarget; event: Record<string, unknown> }> = [];
  private windows: FusionWindowInfo[] = [];
  private listener?: (windows: FusionWindowInfo[]) => void;
  private nextId = 4100;
  private readonly fused = new Set<string>();

  constructor(private readonly ffmpeg = process.env.LINKSHELL_FFMPEG || "ffmpeg") {}

  watch(onWindows: (windows: FusionWindowInfo[]) => void): void {
    this.listener = onWindows;
    onWindows(this.windows);
  }

  monitors(): FusionMonitor[] { return [{ index: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }]; }

  async apps(): Promise<FusionAppInfo[]> {
    return [{ app: SIMULATED_APP, name: "测试画面", category: "public.app-category.developer-tools", system: false }];
  }

  async icon(): Promise<Buffer | undefined> {
    // A 1×1 PNG: enough for the local side's icon path.
    return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  }

  setFused(apps: string[]): void {
    this.fused.clear();
    for (const app of apps) this.fused.add(app);
    this.emit();
  }

  async launch(app: string): Promise<void> {
    if (app !== SIMULATED_APP) throw new Error("没有这个应用");
    const id = this.nextId++;
    this.windows = [...this.windows, {
      id, pid: 1, app, title: `测试画面 ${id}`, rect: { x: 100, y: 100, w: 800, h: 600 }, monitor: 0, popup: false,
      buttons: { minimize: { x: 662, y: 0, w: 46, h: 32 }, zoom: { x: 708, y: 0, w: 46, h: 32 }, close: { x: 754, y: 0, w: 46, h: 32 } },
    }];
    this.emit();
  }

  /** What the local side put on this computer's clipboard, for tests to read. */
  clipboard?: FusionClip;
  private clipListener?: (clip: FusionClip) => void;
  watchClipboard(onClip: (clip: FusionClip) => void): void { this.clipListener = onClip; }
  setClipboard(clip: FusionClip): void { this.clipboard = clip; }
  /** A fused app copies something. */
  copy(clip: FusionClip): void { this.clipListener?.(clip); }

  quit(app: string): void {
    this.windows = this.windows.filter((w) => w.app !== app);
    this.emit();
  }

  resize(id: number, w: number, h: number): void {
    this.windows = this.windows.map((win) => (win.id === id ? { ...win, rect: { ...win.rect, w: Math.round(w), h: Math.round(h) } } : win));
    this.emit();
  }

  focus(): void {}

  close(id: number): void {
    this.windows = this.windows.filter((w) => w.id !== id);
    this.emit();
  }

  input(target: InputTarget, event: Record<string, unknown>): void {
    this.inputs.push({ target, event });
    if (this.inputs.length > 200) this.inputs.shift();
  }

  windowVideo(id: number, canvas: { w: number; h: number }, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
    const win = this.windows.find((w) => w.id === id);
    const w = Math.min(canvas.w, win?.rect.w ?? 800) & ~1, h = Math.min(canvas.h, win?.rect.h ?? 600) & ~1;
    return this.encode(`testsrc2=size=${w}x${h}:rate=${fps},pad=${canvas.w & ~1}:${canvas.h & ~1}:0:0:black`, fps, bitrate, onUnit, onEnd);
  }

  monitorVideo(_index: number, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
    return this.encode(`color=c=0x202020:size=1920x1080:rate=${fps}`, fps, bitrate, onUnit, onEnd);
  }

  private encode(source: string, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
    const child = spawn(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", source,
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
      "-b:v", String(bitrate), "-g", String(fps * 2), // Framed, as the Windows helper writes it (`H264AccessUnits`).
      "-bsf:v", "h264_metadata=aud=insert,setts=ts=N", "-flush_packets", "1", "-f", "avi", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    return processSource(child, onUnit, onEnd);
  }

  stop(): void {
    this.listener = undefined;
  }

  private emit(): void { this.listener?.(this.windows.filter((w) => this.fused.has(w.app))); }
}
