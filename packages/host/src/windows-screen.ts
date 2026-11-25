import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDisplay, StreamProfile } from "./input.js";

const JPEG_PROFILES = [
  { width: 2560, fps: 30, quality: 88 },
  { width: 1920, fps: 24, quality: 84 },
  { width: 1600, fps: 20, quality: 80 },
  { width: 1280, fps: 15, quality: 74 },
  { width: 1024, fps: 12, quality: 68 },
] as const;

export function windowsProfile(level: number, maxWidth = 1920, maxFps = 30) {
  const index = Math.min(JPEG_PROFILES.length - 1, Math.max(0, Math.trunc(level) || 0));
  const profile = JPEG_PROFILES[index]!;
  const width = Math.max(320, Math.min(3840, Number.isFinite(maxWidth) ? maxWidth : 1920));
  return { ...profile, width: index === 0 ? width : Math.min(width, profile.width), fps: Math.max(1, Math.min(profile.fps, Number.isFinite(maxFps) ? maxFps : 30)) };
}

export function configureWindowsCapture(child: ChildProcess, message: object): void {
  if (child.exitCode === null && child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** The standalone app bundles the helper; CLI-only installations can select it explicitly. */
export function windowsHelper(): string | undefined {
  const file = process.env.LINKSHELL_WINDOWS_HELPER || (process.env.LINKSHELL_APP_BUNDLE && join(process.env.LINKSHELL_APP_BUNDLE, "LinkShell.Screen.exe"));
  return process.platform === "win32" && file && existsSync(file) ? file : undefined;
}

/**
 * Which encoder, and which way of getting frames to it, made pictures last time on this computer.
 * A helper told so tries that first: a driver that refuses the zero-copy path refuses it every
 * time, and finding that out again costs each start an FFmpeg launch (a second on a small PC).
 */
let videoHint: string | undefined;

export function windowsVideoEnv(): NodeJS.ProcessEnv {
  // Framed: each picture with its length, so it is handed on as it ends and not when the next
  // begins (`H264AccessUnits`). A helper that does not know the request writes what it always did.
  return { ...process.env, LINKSHELL_VIDEO_FRAMED: "1", ...(videoHint ? { LINKSHELL_WINDOWS_VIDEO_HINT: videoHint } : {}) };
}

/** Reads the helper's `[video] encoder=h264_qsv … path=compatible` line. */
export function noteWindowsVideo(stderr: string): void {
  const found = /\[video\] encoder=(h264_[a-z]+)\b[^\n]*\bpath=(native|compatible)/.exec(stderr);
  if (found) videoHint = `${found[1]}:${found[2]}`;
}

export async function windowsDisplays(): Promise<AppDisplay[]> {
  const helper = windowsHelper();
  if (!helper) throw new Error("请安装 Windows 桌面版，或设置 LINKSHELL_WINDOWS_HELPER 指向 LinkShell.Screen.exe");
  const { stdout } = await promisify(execFile)(helper, ["--displays"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
  return z.array(z.object({ screen: z.number().int().nonnegative(), name: z.string(), w: z.number().positive(), h: z.number().positive(), main: z.boolean() })).parse(JSON.parse(stdout));
}

/** Length-prefixed JPEG frames, bounded before allocation; stdout is never a log channel. */
export class WindowsFrameSplitter {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private frame?: Buffer;
  private frameBytes = 0;
  push(chunk: Buffer, emit: (frame: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const copied = chunk.copy(this.header, this.headerBytes, offset, offset + 4 - this.headerBytes);
        this.headerBytes += copied; offset += copied;
        if (this.headerBytes < 4) return;
        const size = this.header.readUInt32LE(0);
        if (size < 4 || size > 16 * 1024 * 1024) throw new Error("Invalid Windows screen frame length");
        this.frame = Buffer.allocUnsafe(size); this.frameBytes = 0; this.headerBytes = 0;
      }
      const copied = chunk.copy(this.frame, this.frameBytes, offset, offset + this.frame.length - this.frameBytes);
      this.frameBytes += copied; offset += copied;
      if (this.frameBytes < this.frame.length) return;
      const frame = this.frame;
      this.frame = undefined;
      if (frame[0] !== 0xff || frame[1] !== 0xd8) throw new Error("Invalid Windows screen JPEG");
      emit(frame);
    }
  }
}

export function captureWindows(screen: number, profile: Pick<StreamProfile, "width" | "fps"> & { quality?: number }): ChildProcess {
  const helper = windowsHelper();
  if (!helper) throw new Error("Windows 屏幕组件缺失，请重新安装桌面版");
  const child = spawn(helper, ["--capture", String(screen), String(profile.width), String(Math.min(30, profile.fps)), String(profile.quality ?? 80)], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => {}); // A capture can exit while a profile change is in flight.
  return child;
}
