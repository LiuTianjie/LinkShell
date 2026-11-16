import type { ChildProcess } from "node:child_process";
import { H264AccessUnits } from "../screen-h264.js";

/**
 * What a Fusion remote needs from its operating system (docs/v2/fusion.md §8.2). The protocol,
 * the peer connection and the per-frame metadata are in remote.ts / media.ts and are the same
 * everywhere; `WindowsFusionPlatform` (LinkShell.Screen.exe --fusion) and `SimulatedFusionPlatform`
 * (a test picture, so any computer can stand in for a Windows remote in tests) implement this.
 *
 * Rectangles here are the remote's screen pixels.
 */
export type PixelRect = { x: number; y: number; w: number; h: number };

export interface FusionAppInfo { app: string; name: string; category: string; system: boolean }

export interface FusionWindowInfo {
  /** The low 32 bits of the HWND on Windows. */
  id: number;
  pid: number;
  /** The app it belongs to, as the catalog names it (an AppUserModelID on Windows). */
  app: string;
  title: string;
  /** The visible window (DWM's extended frame), screen pixels. */
  rect: PixelRect;
  /** Index into `monitors()`. */
  monitor: number;
  /** A menu, tooltip or dropdown: drawn over its owner, cut from the monitor's layer. */
  popup: boolean;
  owner?: number;
  minimized?: boolean;
  /** Minimize / maximize / close, relative to the window, pixels. */
  buttons?: Partial<Record<"close" | "minimize" | "zoom", PixelRect>>;
  /** Interactive parts of the title bar (tabs, a search box): never a drag area on the local side. */
  hitrects?: PixelRect[];
}

export interface FusionMonitor { index: number; rect: PixelRect; scale: number }

/** An encoder's output: H.264 access units in Annex B. */
export interface FusionVideoSource {
  stop(): void;
}

/** What was copied: text, and a picture as PNG. */
export interface FusionClip { text?: string; png?: Buffer }

export type InputTarget = { window: number } | { monitor: number };

export interface FusionPlatform {
  readonly platform: "windows" | "simulated";
  /** Snapshots of every top-level window of the fused apps, on change (about 30 a second at most). */
  watch(onWindows: (windows: FusionWindowInfo[]) => void): void;
  monitors(): FusionMonitor[];
  apps(): Promise<FusionAppInfo[]>;
  icon(app: string): Promise<Buffer | undefined>;
  launch(app: string): Promise<void>;
  quit(app: string, force: boolean): void;
  /** Which apps' windows are watched: the current session's, replaced whole (a later session starts empty). */
  setFused(apps: string[]): void;
  resize(id: number, w: number, h: number): void;
  focus(id: number): void;
  close(id: number): void;
  /** `event` positions are fractions of `target`'s rectangle (`ScreenSession`'s input protocol). */
  input(target: InputTarget, event: Record<string, unknown>): void;
  /** A window at the top left of a fixed `canvas`, so resizing it never restarts the encoder. */
  windowVideo(id: number, canvas: { w: number; h: number }, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource;
  monitorVideo(index: number, fps: number, bitrate: number, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource;
  /** What a fused app copies, as it is copied. Absent where the clipboard is not synchronised. */
  watchClipboard?(onClip: (clip: FusionClip) => void): void;
  setClipboard?(clip: FusionClip): void;
  stop(): void;
}

/** An encoder process writing Annex B to stdout, as a source. */
export function processSource(child: ChildProcess, onUnit: (unit: Buffer, key: boolean) => void, onEnd: (reason: string) => void): FusionVideoSource {
  const splitter = new H264AccessUnits();
  let ended = false;
  let errors = "";
  const end = (reason: string) => { if (!ended) { ended = true; onEnd(reason); } };
  child.stdout?.on("data", (chunk: Buffer) => {
    try { splitter.push(chunk, onUnit); } catch (error) { end(String(error)); child.kill(); }
  });
  child.stderr?.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-1500); });
  child.on("error", (error) => end(error.message));
  child.on("exit", (code) => end(`encoder exited ${code}: ${errors.trim()}`));
  child.stdin?.on("error", () => undefined);
  return {
    stop() {
      ended = true;
      child.stdin?.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1_500);
      timer.unref?.();
      child.once("exit", () => clearTimeout(timer));
      child.kill("SIGTERM");
    },
  };
}
