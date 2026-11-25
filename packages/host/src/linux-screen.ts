import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { type InputEvent, type InputListener, type StreamProfile } from "./input.js";
import { fallbackProfile } from "./screen-session.js";

const runExecFile = promisify(execFile);

export type LinuxDisplayServer = "wayland" | "x11" | "headless";

export type LinuxCaptureBackend =
  | "x11-ffmpeg"
  | "x11-ffmpeg-mjpeg"
  | "wayland-wf-recorder"
  | "wayland-gst-vaapi"
  | "wayland-gst-x264"
  | "wayland-gst-mjpeg"
  | "wayland-ffmpeg-mjpeg";

export type LinuxInputBackend = "xdotool" | "ydotool" | "dotool" | "wtype";

export interface LinuxCaptureTools {
  ffmpeg: boolean;
  ffmpegX11Grab: boolean;
  ffmpegLibx264: boolean;
  wfRecorder: boolean;
  gstLaunch: boolean;
  gstPipewire: boolean;
  gstVaapiH264: boolean;
  gstX264: boolean;
  gstJpeg: boolean;
  xrandr: boolean;
  xdpyinfo: boolean;
  wlrRandr: boolean;
}

export interface LinuxInputTools {
  xdotool: boolean;
  ydotool: boolean;
  ydotoolSocket: boolean;
  dotool: boolean;
  wtype: boolean;
}

export interface LinuxScreenDiagnostics {
  displayServer: LinuxDisplayServer;
  captureBackend: LinuxCaptureBackend | null;
  captureFormat: "h264" | "jpeg" | null;
  inputBackend: LinuxInputBackend | null;
  recording: boolean;
  control: boolean;
  missingCapture: string[];
  missingInput: string[];
  problem?: string;
  captureTools: LinuxCaptureTools;
  inputTools: LinuxInputTools;
}

export interface LinuxDisplayInfo {
  index: number;
  screen: number;
  name: string;
  output?: string;
  w?: number;
  h?: number;
  x?: number;
  y?: number;
}

export type LinuxExtendedInputEvent =
  | InputEvent
  | { t: "click"; b: "left" | "right" | "middle"; n?: number; m?: ("cmd" | "shift" | "alt" | "ctrl")[] };

export interface LinuxInputCommand {
  command: string;
  args: string[];
  stdin?: string;
}

export interface LinuxProbeDeps {
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  fileExists?: (path: string) => boolean;
}

export const HEADLESS_LINUX_PROBLEM =
  "Headless Linux session (no DISPLAY or WAYLAND_DISPLAY); screen sharing requires a desktop X11/Wayland session";

/** Detects whether the current Linux session runs on Wayland, X11, or headless (SSH/container/TTY). */
export function detectLinuxDisplayServer(env: NodeJS.ProcessEnv = process.env): LinuxDisplayServer {
  const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (sessionType === "wayland" || env.WAYLAND_DISPLAY?.trim()) return "wayland";
  if (sessionType === "x11" || env.DISPLAY?.trim()) return "x11";
  return "headless";
}

async function hasBinary(name: string, deps: LinuxProbeDeps): Promise<boolean> {
  if (deps.runCommand) {
    return deps.runCommand("which", [name], { timeout: 1500 }).then(() => true, () => false);
  }
  const pathEnv = (deps.env ?? process.env).PATH ?? "";
  const existsFn = deps.fileExists;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsFn) {
        if (existsFn(candidate)) return true;
      } else {
        accessSync(candidate, constants.X_OK);
        return true;
      }
    } catch {
      // Try next PATH entry.
    }
  }
  return runExecFile("which", [name], { timeout: 1500 }).then(() => true, () => false);
}

async function hasGstPlugin(plugin: string, deps: LinuxProbeDeps): Promise<boolean> {
  const exec = resolveExec(deps);
  return exec("gst-inspect-1.0", [plugin], { timeout: 1500 }).then(() => true, () => false);
}

async function probeFfmpegCapabilities(
  displayServer: LinuxDisplayServer,
  deps: LinuxProbeDeps,
): Promise<{ x11grab: boolean; libx264: boolean }> {
  const exec = resolveExec(deps);
  const [devices, encoders] = await Promise.all([
    displayServer === "x11"
      ? exec("ffmpeg", ["-hide_banner", "-devices"], { timeout: 2000 }).then(
          ({ stdout, stderr }) => /\bx11grab\b/i.test(`${stdout}\n${stderr}`),
          () => false,
        )
      : Promise.resolve(false),
    exec("ffmpeg", ["-hide_banner", "-encoders"], { timeout: 2000 }).then(
      ({ stdout, stderr }) => /\blibx264\b/i.test(`${stdout}\n${stderr}`),
      () => false,
    ),
  ]);
  return { x11grab: devices, libx264: encoders };
}

function resolveCaptureSelection(displayServer: LinuxDisplayServer, tools: LinuxCaptureTools): {
  backend: LinuxCaptureBackend | null;
  format: "h264" | "jpeg" | null;
  missing: string[];
} {
  if (displayServer === "headless") {
    return { backend: null, format: null, missing: [] };
  }
  if (displayServer === "x11") {
    if (!tools.ffmpeg) return { backend: null, format: null, missing: ["ffmpeg"] };
    if (!tools.ffmpegX11Grab) return { backend: null, format: null, missing: ["ffmpeg (x11grab)"] };
    if (tools.ffmpegLibx264) return { backend: "x11-ffmpeg", format: "h264", missing: [] };
    // Fedora's `ffmpeg-free` omits libx264 while shipping x11grab + mjpeg.
    return { backend: "x11-ffmpeg-mjpeg", format: "jpeg", missing: [] };
  }
  if (tools.wfRecorder) return { backend: "wayland-wf-recorder", format: "h264", missing: [] };
  if (tools.gstLaunch && tools.gstPipewire) {
    if (tools.gstVaapiH264) return { backend: "wayland-gst-vaapi", format: "h264", missing: [] };
    if (tools.gstX264) return { backend: "wayland-gst-x264", format: "h264", missing: [] };
    if (tools.gstJpeg) return { backend: "wayland-gst-mjpeg", format: "jpeg", missing: [] };
    if (tools.ffmpeg) return { backend: "wayland-ffmpeg-mjpeg", format: "jpeg", missing: [] };
    return { backend: null, format: null, missing: ["x264enc / vaapih264enc / jpegenc / ffmpeg"] };
  }
  const missing = ["wf-recorder", !tools.gstLaunch ? "gst-launch-1.0" : "pipewiresrc"];
  return { backend: null, format: null, missing };
}

function resolveInputSelection(displayServer: LinuxDisplayServer, tools: LinuxInputTools): {
  backend: LinuxInputBackend | null;
  missing: string[];
} {
  if (displayServer === "headless") return { backend: null, missing: [] };
  if (displayServer === "x11") {
    if (tools.xdotool) return { backend: "xdotool", missing: [] };
    if (tools.dotool) return { backend: "dotool", missing: [] };
    return { backend: null, missing: ["xdotool"] };
  }
  if (tools.dotool) return { backend: "dotool", missing: [] };
  // ydotool requires a running ydotoold socket to inject uinput events.
  if (tools.ydotool && tools.ydotoolSocket) return { backend: "ydotool", missing: [] };
  if (tools.wtype) return { backend: "wtype", missing: [] };
  return { backend: null, missing: tools.ydotool ? ["ydotoold"] : ["dotool / ydotool (或 wtype)"] };
}

function buildDiagnosticsProblem(
  displayServer: LinuxDisplayServer,
  captureBackend: LinuxCaptureBackend | null,
  inputBackend: LinuxInputBackend | null,
  missingCapture: string[],
  missingInput: string[],
  captureTools: LinuxCaptureTools,
  inputTools: LinuxInputTools,
): string | undefined {
  if (displayServer === "headless") return HEADLESS_LINUX_PROBLEM;
  const parts: string[] = [];
  if (!captureBackend) {
    if (displayServer === "x11" && captureTools.ffmpeg && !captureTools.ffmpegX11Grab) {
      parts.push("检测到 ffmpeg，但当前构建不支持 x11grab 输入设备，请安装包含 x11grab 的完整版 ffmpeg");
    } else {
      parts.push(
        displayServer === "wayland"
          ? `Wayland 屏幕捕获需要安装 ${missingCapture.join(" 或 ")}`
          : `查看屏幕需要安装 ${missingCapture.join("、")}`,
      );
    }
  }
  if (!inputBackend) {
    if (inputTools.ydotool && !inputTools.ydotoolSocket) {
      parts.push("检测到 ydotool，但未发现 ydotoold 套接字，请确认 ydotoold 服务正在运行");
    } else {
      parts.push(
        displayServer === "wayland"
          ? `Wayland 远程控制需要安装 ${missingInput.join(" 或 ")}`
          : `远程控制需要安装 ${missingInput.join(" 或 ")}`,
      );
    }
  } else if (inputBackend === "wtype") {
    parts.push(
      inputTools.ydotool && !inputTools.ydotoolSocket
        ? "当前仅检测到 wtype（仅支持键盘输入）；检测到 ydotool 但未发现 ydotoold 套接字，启动 ydotoold 或安装 dotool 可同时控制鼠标"
        : "当前仅检测到 wtype（仅支持键盘输入）；安装 dotool 或 ydotool 可同时控制鼠标",
    );
  }
  return parts.length > 0 ? parts.join("；") : undefined;
}

/** Probes installed capture and input binaries on Linux and returns structured diagnostics. */
export async function probeLinuxScreen(deps: LinuxProbeDeps = {}): Promise<LinuxScreenDiagnostics> {
  const env = deps.env ?? process.env;
  const checkFile = deps.fileExists ?? existsSync;
  const displayServer = detectLinuxDisplayServer(env);

  if (displayServer === "headless") {
    return {
      displayServer: "headless",
      captureBackend: null,
      captureFormat: null,
      inputBackend: null,
      recording: false,
      control: false,
      missingCapture: [],
      missingInput: [],
      problem: HEADLESS_LINUX_PROBLEM,
      captureTools: {
        ffmpeg: false,
        ffmpegX11Grab: false,
        ffmpegLibx264: false,
        wfRecorder: false,
        gstLaunch: false,
        gstPipewire: false,
        gstVaapiH264: false,
        gstX264: false,
        gstJpeg: false,
        xrandr: false,
        xdpyinfo: false,
        wlrRandr: false,
      },
      inputTools: {
        xdotool: false,
        ydotool: false,
        ydotoolSocket: false,
        dotool: false,
        wtype: false,
      },
    };
  }

  const [ffmpeg, wfRecorder, gstLaunch, xrandr, xdpyinfo, wlrRandr, xdotool, ydotool, dotool, wtype] = await Promise.all([
    hasBinary("ffmpeg", deps),
    hasBinary("wf-recorder", deps),
    hasBinary("gst-launch-1.0", deps),
    displayServer === "x11" ? hasBinary("xrandr", deps) : Promise.resolve(false),
    displayServer === "x11" ? hasBinary("xdpyinfo", deps) : Promise.resolve(false),
    displayServer === "wayland" ? hasBinary("wlr-randr", deps) : Promise.resolve(false),
    hasBinary("xdotool", deps),
    hasBinary("ydotool", deps),
    hasBinary("dotool", deps),
    hasBinary("wtype", deps),
  ]);

  let ffmpegX11Grab = false;
  let ffmpegLibx264 = false;
  if (ffmpeg && (displayServer === "x11" || wfRecorder)) {
    const caps = await probeFfmpegCapabilities(displayServer, deps);
    ffmpegX11Grab = caps.x11grab;
    ffmpegLibx264 = caps.libx264;
  }

  let gstPipewire = false;
  let gstVaapiH264 = false;
  let gstX264 = false;
  let gstJpeg = false;
  if (displayServer === "wayland" && gstLaunch && !wfRecorder) {
    [gstPipewire, gstVaapiH264, gstX264, gstJpeg] = await Promise.all([
      hasGstPlugin("pipewiresrc", deps),
      hasGstPlugin("vaapih264enc", deps),
      hasGstPlugin("x264enc", deps),
      hasGstPlugin("jpegenc", deps),
    ]);
  }

  const captureTools: LinuxCaptureTools = {
    ffmpeg,
    ffmpegX11Grab,
    ffmpegLibx264,
    wfRecorder,
    gstLaunch,
    gstPipewire,
    gstVaapiH264,
    gstX264,
    gstJpeg,
    xrandr,
    xdpyinfo,
    wlrRandr,
  };
  const ydotoolSocketCandidates = [
    env.YDOTOOL_SOCKET?.trim(),
    env.XDG_RUNTIME_DIR?.trim() ? join(env.XDG_RUNTIME_DIR.trim(), ".ydotool_socket") : undefined,
    "/tmp/.ydotool_socket",
    "/run/ydotoold/socket",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const inputTools: LinuxInputTools = {
    xdotool,
    ydotool,
    ydotoolSocket: ydotool && ydotoolSocketCandidates.some((candidate) => checkFile(candidate)),
    dotool,
    wtype,
  };

  const capture = resolveCaptureSelection(displayServer, captureTools);
  const input = resolveInputSelection(displayServer, inputTools);
  const problem = buildDiagnosticsProblem(
    displayServer,
    capture.backend,
    input.backend,
    capture.missing,
    input.missing,
    captureTools,
    inputTools,
  );

  return {
    displayServer,
    captureBackend: capture.backend,
    captureFormat: capture.format,
    inputBackend: input.backend,
    recording: capture.backend !== null,
    control: input.backend !== null,
    missingCapture: capture.missing,
    missingInput: input.missing,
    ...(problem ? { problem } : {}),
    captureTools,
    inputTools,
  };
}

/** Parses `xrandr --listactivemonitors` output into physical X11 monitors with offsets (`+X+Y`). */
export function parseXrandrActiveMonitors(stdout: string): LinuxDisplayInfo[] {
  const displays: LinuxDisplayInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // Format: ` 0: +*DP-1 2560/597x1440/336+0+0  DP-1` or ` 1: +HDMI-1 1920x1080+2560+0  HDMI-1`
    const match = /^\s*(\d+):\s+\S+\s+(\d+)(?:\/\d+)?x(\d+)(?:\/\d+)?\+(\d+)\+(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const w = Number(match[2]);
    const h = Number(match[3]);
    const x = Number(match[4]);
    const y = Number(match[5]);
    const output = match[6]!;
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) continue;
    const index = displays.length;
    displays.push({ index, screen: index, name: output, output, w, h, x, y });
  }
  return displays;
}

/** Parses `xdpyinfo` stdout into root display dimensions. */
export function parseXdpyinfoDimensions(stdout: string): { w: number; h: number } | null {
  const match = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(stdout);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { w, h } : null;
}

/** Parses `wlr-randr --json` output into enabled Wayland displays. */
export function parseWlrRandrJson(stdout: string): LinuxDisplayInfo[] {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return [];
    const displays: LinuxDisplayInfo[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { name?: unknown; description?: unknown; enabled?: unknown; modes?: unknown };
      if (item.enabled === false) continue;
      const modes = Array.isArray(item.modes) ? item.modes : [];
      const current = modes.find((m): m is { width?: unknown; height?: unknown; current?: unknown } =>
        Boolean(m && typeof m === "object" && (m as { current?: unknown }).current === true),
      );
      const w = typeof current?.width === "number" ? current.width : undefined;
      const h = typeof current?.height === "number" ? current.height : undefined;
      const output = typeof item.name === "string" ? item.name : undefined;
      const label = typeof item.description === "string" && item.description.trim() ? item.description.trim() : output || `屏幕 ${displays.length + 1}`;
      const index = displays.length;
      displays.push({ index, screen: index, name: label, ...(output ? { output } : {}), ...(w ? { w } : {}), ...(h ? { h } : {}) });
    }
    return displays;
  } catch {
    return [];
  }
}

function resolveExec(deps: LinuxProbeDeps): (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }> {
  return deps.runCommand ?? (async (cmd, args, opts) => {
    const res = await runExecFile(cmd, args, { ...opts, encoding: "utf8" });
    return { stdout: String(res.stdout), stderr: String(res.stderr) };
  });
}

/** Lists available Linux displays for X11 or Wayland (empty when headless). */
export async function listLinuxDisplays(deps: LinuxProbeDeps = {}): Promise<LinuxDisplayInfo[]> {
  const exec = resolveExec(deps);
  const env = deps.env ?? process.env;
  const displayServer = detectLinuxDisplayServer(env);
  if (displayServer === "headless") return [];
  if (displayServer === "wayland") {
    const wlr = await exec("wlr-randr", ["--json"], { timeout: 3000 }).then(({ stdout }) => parseWlrRandrJson(stdout), () => []);
    if (wlr.length > 0) return wlr;
    return [{ index: 0, screen: 0, name: "屏幕" }];
  }
  const monitors = await exec("xrandr", ["--listactivemonitors"], { timeout: 3000 }).then(
    ({ stdout }) => parseXrandrActiveMonitors(stdout),
    () => [],
  );
  if (monitors.length > 0) return monitors;
  const dimensions = await exec("xdpyinfo", [], { timeout: 5000 }).then(({ stdout }) => parseXdpyinfoDimensions(stdout), () => null);
  return [{ index: 0, name: "屏幕", screen: 0, ...(dimensions ? { w: dimensions.w, h: dimensions.h } : {}) }];
}

function buildX11InputArgs(
  display: string,
  fps: number,
  target?: Pick<LinuxDisplayInfo, "w" | "h" | "x" | "y">,
): string[] {
  const sizeArgs = target?.w && target?.h ? ["-video_size", `${target.w}x${target.h}`] : [];
  const inputTarget =
    target && (target.x !== undefined || target.y !== undefined)
      ? `${display}+${target.x ?? 0},${target.y ?? 0}`
      : display;
  return ["-f", "x11grab", "-framerate", String(fps), ...sizeArgs, "-i", inputTarget];
}

/** Builds ffmpeg x11grab H.264 capture arguments for an X11 display (with optional monitor geometry/offset). */
export function buildX11CaptureArgs(
  level = 0,
  profile = fallbackProfile(level),
  display = process.env.DISPLAY ?? ":0",
  target?: Pick<LinuxDisplayInfo, "w" | "h" | "x" | "y">,
): string[] {
  const rate = (bits: number) => `${Math.round(bits / 1000)}k`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...buildX11InputArgs(display, profile.fps, target),
    "-vf",
    `fps=${profile.fps},scale='min(${profile.width},iw)':-2,format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-x264-params", "sliced-threads=0",
    "-b:v", rate(profile.bitrate), "-maxrate", rate(profile.ceiling), "-bufsize", rate(profile.ceiling),
    // A keyframe a second: a viewer that fell behind is back on the live picture within one.
    "-g",
    String(profile.fps),
    "-bf",
    "0",
    // An access-unit delimiter before every frame, so the stream splits into frames cleanly.
    "-bsf:v",
    "h264_metadata=aud=insert",
    "-f",
    "h264",
    "-",
  ];
}

/** Builds ffmpeg x11grab MJPEG fallback capture arguments when libx264 is absent (e.g. Fedora `ffmpeg-free`). */
export function buildX11MjpegCaptureArgs(
  level = 0,
  profile = fallbackProfile(level),
  display = process.env.DISPLAY ?? ":0",
  target?: Pick<LinuxDisplayInfo, "w" | "h" | "x" | "y">,
): string[] {
  const quality = String(Math.max(3, Math.min(12, 5 + level * 2)));
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...buildX11InputArgs(display, profile.fps, target),
    "-vf",
    `fps=${profile.fps},scale='min(${profile.width},iw)':-2`,
    "-c:v", "mjpeg", "-q:v", quality,
    "-f", "mjpeg",
    "-",
  ];
}

/** Builds `wf-recorder` capture arguments for Wayland (`nut` raw intermediate or direct `h264` stream). */
export function buildWaylandWfRecorderArgs(
  profile: StreamProfile,
  options: { mode?: "nut" | "h264"; output?: string } = {},
): string[] {
  const mode = options.mode ?? "h264";
  const outputArgs = options.output ? ["-o", options.output] : [];
  if (mode === "nut") {
    return ["-y", ...outputArgs, "-c", "rawvideo", "-x", "yuv420p", "-m", "nut", "-f", "-"];
  }
  return [
    "-y",
    ...outputArgs,
    "-c", "libx264",
    "-p", "preset=ultrafast",
    "-p", "tune=zerolatency",
    "-p", "aud=1",
    "-p", "bf=0",
    "-p", `g=${profile.fps}`,
    "-m", "h264",
    "-f", "-",
  ];
}

/** Builds `ffmpeg` transcoding args for a piped Wayland `nut` stream into Annex-B H.264 with AUD markers. */
export function buildWaylandFfmpegTranscodeArgs(profile: StreamProfile): string[] {
  const rate = (bits: number) => `${Math.round(bits / 1000)}k`;
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "nut", "-i", "pipe:0",
    "-vf", `fps=${profile.fps},scale='min(${profile.width},iw)':-2,format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-x264-params", "sliced-threads=0",
    "-b:v", rate(profile.bitrate), "-maxrate", rate(profile.ceiling), "-bufsize", rate(profile.ceiling),
    "-g", String(profile.fps),
    "-bf", "0",
    "-bsf:v", "h264_metadata=aud=insert",
    "-f", "h264",
    "-",
  ];
}

/** Builds `gst-launch-1.0` PipeWire capture pipeline args for Wayland (`vaapi`, `x264`, or `mjpeg`). */
export function buildWaylandGstArgs(encoder: "vaapi" | "x264" | "mjpeg", profile: StreamProfile, level = 0): string[] {
  const kbps = Math.max(200, Math.round(profile.bitrate / 1000));
  const common = ["-q", "pipewiresrc", "do-timestamp=true", "!", "videoconvert", "!", "videoscale", "!"];
  if (encoder === "vaapi") {
    return [
      ...common,
      `video/x-raw,format=NV12,framerate=${profile.fps}/1`,
      "!", "vaapih264enc", "rate-control=cbr", `bitrate=${kbps}`, `keyframe-period=${profile.fps}`,
      "!", "h264parse", "config-interval=1",
      "!", "video/x-h264,stream-format=byte-stream,alignment=au",
      "!", "fdsink", "fd=1",
    ];
  }
  if (encoder === "x264") {
    return [
      ...common,
      `video/x-raw,format=I420,framerate=${profile.fps}/1`,
      "!", "x264enc", "tune=zerolatency", "speed-preset=ultrafast", `bitrate=${kbps}`, `key-int-max=${profile.fps}`, "bframes=0", "aud=true",
      "!", "video/x-h264,stream-format=byte-stream,alignment=au",
      "!", "fdsink", "fd=1",
    ];
  }
  const quality = Math.max(40, Math.min(85, 80 - level * 8));
  return [
    ...common,
    "videorate", "!", `video/x-raw,framerate=${profile.fps}/1`,
    "!", "jpegenc", `quality=${quality}`,
    "!", "fdsink", "fd=1",
  ];
}

/** Builds fallback ffmpeg MJPEG capture args for Wayland/PipeWire or X11 image2pipe streaming. */
export function buildWaylandFfmpegMjpegArgs(profile: StreamProfile, inputDevice = "pipe:0", inputFormat = "rawvideo"): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-f", inputFormat, "-i", inputDevice,
    "-vf", `fps=${profile.fps},scale='min(${profile.width},iw)':-2`,
    "-c:v", "mjpeg", "-q:v", "6",
    "-f", "mjpeg",
    "-",
  ];
}

/** Splits concatenated raw JPEG frames (SOI 0xFF 0xD8 .. EOI 0xFF 0xD9) from stdout chunks. */
export class JpegFrameSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, emit: (frame: Buffer) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const soi = this.findMarker(0xd8, 0);
      if (soi < 0) {
        // Keep a single trailing 0xFF in case the SOI marker spans two chunks.
        this.buffer = this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === 0xff
          ? this.buffer.subarray(this.buffer.length - 1)
          : Buffer.alloc(0);
        return;
      }
      const eoi = this.findMarker(0xd9, soi + 2);
      if (eoi < 0) {
        if (soi > 0) this.buffer = this.buffer.subarray(soi);
        return;
      }
      const end = eoi + 2;
      emit(this.buffer.subarray(soi, end));
      this.buffer = this.buffer.subarray(end);
    }
  }

  private findMarker(secondByte: number, from: number): number {
    for (let i = from; i + 1 < this.buffer.length; i++) {
      if (this.buffer[i] === 0xff && this.buffer[i + 1] === secondByte) return i;
    }
    return -1;
  }
}

export interface LinuxCapturePlan {
  backend: LinuxCaptureBackend;
  format: "h264" | "jpeg";
  command: string;
  args: string[];
  pipeTo?: { command: string; args: string[] };
}

/** Selects the capture command pipeline for the probed Linux backend. */
export function buildLinuxCapturePlan(
  diag: LinuxScreenDiagnostics,
  level: number,
  profile: StreamProfile,
  display?: LinuxDisplayInfo,
  env: NodeJS.ProcessEnv = process.env,
): LinuxCapturePlan | null {
  switch (diag.captureBackend) {
    case "x11-ffmpeg":
      return { backend: "x11-ffmpeg", format: "h264", command: "ffmpeg", args: buildX11CaptureArgs(level, profile, env.DISPLAY ?? ":0", display) };
    case "x11-ffmpeg-mjpeg":
      return { backend: "x11-ffmpeg-mjpeg", format: "jpeg", command: "ffmpeg", args: buildX11MjpegCaptureArgs(level, profile, env.DISPLAY ?? ":0", display) };
    case "wayland-wf-recorder":
      if (diag.captureTools.ffmpeg && diag.captureTools.ffmpegLibx264) {
        return {
          backend: "wayland-wf-recorder",
          format: "h264",
          command: "wf-recorder",
          args: buildWaylandWfRecorderArgs(profile, { mode: "nut", output: display?.output }),
          pipeTo: { command: "ffmpeg", args: buildWaylandFfmpegTranscodeArgs(profile) },
        };
      }
      return {
        backend: "wayland-wf-recorder",
        format: "h264",
        command: "wf-recorder",
        args: buildWaylandWfRecorderArgs(profile, { mode: "h264", output: display?.output }),
      };
    case "wayland-gst-vaapi":
      return { backend: "wayland-gst-vaapi", format: "h264", command: "gst-launch-1.0", args: buildWaylandGstArgs("vaapi", profile, level) };
    case "wayland-gst-x264":
      return { backend: "wayland-gst-x264", format: "h264", command: "gst-launch-1.0", args: buildWaylandGstArgs("x264", profile, level) };
    case "wayland-gst-mjpeg":
      return { backend: "wayland-gst-mjpeg", format: "jpeg", command: "gst-launch-1.0", args: buildWaylandGstArgs("mjpeg", profile, level) };
    case "wayland-ffmpeg-mjpeg":
      return {
        backend: "wayland-ffmpeg-mjpeg",
        format: "jpeg",
        command: "gst-launch-1.0",
        args: ["-q", "pipewiresrc", "do-timestamp=true", "!", "videoconvert", "!", "videoscale", "!", "videorate", "!", `video/x-raw,format=I420,framerate=${profile.fps}/1`, "!", "y4menc", "!", "fdsink", "fd=1"],
        pipeTo: { command: "ffmpeg", args: buildWaylandFfmpegMjpegArgs(profile, "pipe:0", "yuv4mpegpipe") },
      };
    default:
      return null;
  }
}

/** Spawns a Wayland/X11 capture pipeline and streams H.264 or JPEG bytes via stdout/stderr. */
export function spawnLinuxCapture(plan: LinuxCapturePlan): {
  primary: ChildProcess;
  output: NodeJS.ReadableStream;
  stderrSources: NodeJS.ReadableStream[];
  stop: (force?: boolean) => void;
  children: ChildProcess[];
} {
  if (!plan.pipeTo) {
    const primary = spawn(plan.command, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
    return {
      primary,
      output: primary.stdout!,
      stderrSources: [primary.stderr!],
      children: [primary],
      stop: (force) => {
        if (primary.exitCode === null) primary.kill(force ? "SIGKILL" : "SIGTERM");
      },
    };
  }
  const source = spawn(plan.command, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
  const transcoder = spawn(plan.pipeTo.command, plan.pipeTo.args, { stdio: ["pipe", "pipe", "pipe"] });
  source.stdout!.pipe(transcoder.stdin!);
  transcoder.stdin!.on("error", () => {});
  source.once("exit", () => transcoder.stdin?.end());
  return {
    primary: transcoder,
    output: transcoder.stdout!,
    stderrSources: [source.stderr!, transcoder.stderr!],
    children: [source, transcoder],
    stop: (force) => {
      const sig = force ? "SIGKILL" : "SIGTERM";
      if (source.exitCode === null) source.kill(sig);
      if (transcoder.exitCode === null) transcoder.kill(sig);
    },
  };
}

// ---- Input key & button mappings ----

const X11_KEY_MAP: Record<string, string> = {
  enter: "Return",
  return: "Return",
  backspace: "BackSpace",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  " ": "space",
  delete: "Delete",
  del: "Delete",
  arrowup: "Up",
  up: "Up",
  arrowdown: "Down",
  down: "Down",
  arrowleft: "Left",
  left: "Left",
  arrowright: "Right",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  insert: "Insert",
  capslock: "Caps_Lock",
};

const X11_MODIFIER_MAP: Record<string, string> = {
  cmd: "Super_L",
  ctrl: "Control_L",
  alt: "Alt_L",
  shift: "Shift_L",
};

const DOTOOL_MODIFIER_MAP: Record<string, string> = {
  cmd: "super",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
};

const WTYPE_MODIFIER_MAP: Record<string, string> = {
  cmd: "logo",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
};

// Linux evdev keycodes (linux/input-event-codes.h) for ydotool.
const EVDEV_KEY_CODES: Record<string, number> = {
  escape: 1, esc: 1,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  "-": 12, "=": 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, "[": 26, "]": 27,
  enter: 28, return: 28, ctrl: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ";": 39, "'": 40, "`": 41,
  shift: 42, "\\": 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ",": 51, ".": 52, "/": 53,
  alt: 56, space: 57, " ": 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
  home: 102, arrowup: 103, up: 103, pageup: 104,
  arrowleft: 105, left: 105, arrowright: 106, right: 106,
  end: 107, arrowdown: 108, down: 108, pagedown: 109,
  insert: 110, delete: 111, del: 111,
  cmd: 125, super: 125,
};

function mapX11Key(key: string): string {
  const lower = key.toLowerCase();
  if (X11_KEY_MAP[lower]) return X11_KEY_MAP[lower];
  if (/^f([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return key;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function toPixelCoords(
  x: number,
  y: number,
  size: { w: number; h: number; x?: number; y?: number },
): { px: number; py: number } {
  const maxW = Math.max(1, size.w - 1);
  const maxH = Math.max(1, size.h - 1);
  return {
    px: (size.x ?? 0) + Math.round(clampUnit(x) * maxW),
    py: (size.y ?? 0) + Math.round(clampUnit(y) * maxH),
  };
}

function buttonNumberX11(b: "left" | "right" | "middle"): string {
  if (b === "right") return "3";
  if (b === "middle") return "2";
  return "1";
}

function ydotoolButtonFlag(b: "left" | "right" | "middle", action: "down" | "up" | "click"): string {
  const index = b === "right" ? 1 : b === "middle" ? 2 : 0;
  const base = action === "down" ? 0x40 : action === "up" ? 0x80 : 0xc0;
  return `0x${(base + index).toString(16)}`;
}

function mapModifiers(names: ("cmd" | "shift" | "alt" | "ctrl")[] | undefined, table: Record<string, string>): string[] {
  return (names ?? []).map((m) => table[m]).filter((v): v is string => Boolean(v));
}

function buildXdotoolCommands(event: LinuxExtendedInputEvent, size: { w: number; h: number; x?: number; y?: number }): LinuxInputCommand[] {
  if (event.t === "prompt") return [];
  if (event.t === "move") {
    const { px, py } = toPixelCoords(event.x, event.y, size);
    return [{ command: "xdotool", args: ["mousemove", String(px), String(py)] }];
  }
  const mods = "m" in event ? mapModifiers(event.m, X11_MODIFIER_MAP) : [];
  if (event.t === "down" || event.t === "up") {
    const btn = buttonNumberX11(event.b);
    const cmds: LinuxInputCommand[] = [];
    if (event.t === "down" && mods.length > 0) cmds.push({ command: "xdotool", args: ["keydown", ...mods] });
    cmds.push({ command: "xdotool", args: [event.t === "down" ? "mousedown" : "mouseup", btn] });
    if (event.t === "up" && mods.length > 0) cmds.push({ command: "xdotool", args: ["keyup", ...mods] });
    return cmds;
  }
  if (event.t === "click") {
    const btn = buttonNumberX11(event.b);
    const repeat = Math.max(1, Math.min(3, event.n ?? 1));
    const cmds: LinuxInputCommand[] = [];
    if (mods.length > 0) cmds.push({ command: "xdotool", args: ["keydown", ...mods] });
    cmds.push({ command: "xdotool", args: ["click", "--repeat", String(repeat), "--delay", "25", btn] });
    if (mods.length > 0) cmds.push({ command: "xdotool", args: ["keyup", ...mods] });
    return cmds;
  }
  if (event.t === "scroll") {
    const cmds: LinuxInputCommand[] = [];
    if (mods.length > 0) cmds.push({ command: "xdotool", args: ["keydown", ...mods] });
    const pushWheel = (delta: number, posBtn: string, negBtn: string) => {
      const steps = Math.min(20, Math.round(Math.abs(delta)));
      if (steps <= 0) return;
      cmds.push({ command: "xdotool", args: ["click", "--repeat", String(steps), "--delay", "0", delta > 0 ? posBtn : negBtn] });
    };
    pushWheel(event.dy, "4", "5");
    pushWheel(event.dx, "6", "7");
    if (mods.length > 0) cmds.push({ command: "xdotool", args: ["keyup", ...mods] });
    return cmds;
  }
  if (event.t === "key") {
    const mapped = mapX11Key(event.k);
    return [{ command: "xdotool", args: ["key", [...mods, mapped].join("+")] }];
  }
  return [{ command: "xdotool", args: ["type", "--clearmodifiers", "--delay", "0", "--", event.s] }];
}

function buildYdotoolCommands(event: LinuxExtendedInputEvent, size: { w: number; h: number; x?: number; y?: number }): LinuxInputCommand[] {
  if (event.t === "prompt") return [];
  if (event.t === "move") {
    const { px, py } = toPixelCoords(event.x, event.y, size);
    return [{ command: "ydotool", args: ["mousemove", "--absolute", "-x", String(px), "-y", String(py)] }];
  }
  if (event.t === "down" || event.t === "up") {
    return [{ command: "ydotool", args: ["click", ydotoolButtonFlag(event.b, event.t)] }];
  }
  if (event.t === "click") {
    const repeat = Math.max(1, Math.min(3, event.n ?? 1));
    return [{ command: "ydotool", args: ["click", "--repeat", String(repeat), ydotoolButtonFlag(event.b, "click")] }];
  }
  if (event.t === "scroll") {
    const dx = Math.trunc(event.dx);
    const dy = Math.trunc(event.dy);
    if (dx === 0 && dy === 0) return [];
    return [{ command: "ydotool", args: ["mousemove", "--wheel", "-x", String(dx), "-y", String(dy)] }];
  }
  if (event.t === "key") {
    const code = EVDEV_KEY_CODES[event.k.toLowerCase()];
    if (!code) return [];
    const mods = (event.m ?? []).map((m) => EVDEV_KEY_CODES[m]).filter((v): v is number => v !== undefined);
    const seq = [
      ...mods.map((c) => `${c}:1`),
      `${code}:1`,
      `${code}:0`,
      ...mods.slice().reverse().map((c) => `${c}:0`),
    ];
    return [{ command: "ydotool", args: ["key", ...seq] }];
  }
  return [{ command: "ydotool", args: ["type", "--", event.s] }];
}

function buildDotoolLines(event: LinuxExtendedInputEvent): string[] {
  if (event.t === "prompt") return [];
  if (event.t === "move") return [`mouseto ${clampUnit(event.x).toFixed(4)} ${clampUnit(event.y).toFixed(4)}`];
  if (event.t === "down") return [`buttondown ${event.b}`];
  if (event.t === "up") return [`buttonup ${event.b}`];
  if (event.t === "click") {
    const repeat = Math.max(1, Math.min(3, event.n ?? 1));
    return Array.from({ length: repeat }, () => `click ${event.b}`);
  }
  if (event.t === "scroll") {
    const lines: string[] = [];
    const dy = Math.round(event.dy);
    const dx = Math.round(event.dx);
    if (dy !== 0) lines.push(`wheel ${dy}`);
    if (dx !== 0) lines.push(`hwheel ${dx}`);
    return lines;
  }
  if (event.t === "key") {
    const keyName = mapX11Key(event.k);
    const mods = (event.m ?? []).map((m) => DOTOOL_MODIFIER_MAP[m]).filter(Boolean);
    return [`key ${[...mods, keyName].join("+")}`];
  }
  // dotool splits commands by newline, so type each line safely or emit key Return between lines.
  const segments = event.s.split(/\r?\n/);
  const lines: string[] = [];
  segments.forEach((seg, index) => {
    if (seg.length > 0) lines.push(`type ${seg}`);
    if (index < segments.length - 1) lines.push("key Return");
  });
  return lines;
}

function buildWtypeCommands(event: LinuxExtendedInputEvent): LinuxInputCommand[] {
  if (event.t === "key") {
    const args: string[] = [];
    for (const m of event.m ?? []) {
      const mod = WTYPE_MODIFIER_MAP[m];
      if (mod) args.push("-M", mod);
    }
    args.push("-k", mapX11Key(event.k));
    return [{ command: "wtype", args }];
  }
  if (event.t === "text") {
    return [{ command: "wtype", args: ["--", event.s] }];
  }
  return [];
}

/** Maps a pointer or keyboard input event into concrete CLI commands for a Linux input backend. */
export function buildLinuxInputCommands(
  event: LinuxExtendedInputEvent,
  backend: LinuxInputBackend,
  size: { w: number; h: number; x?: number; y?: number } = { w: 1920, h: 1080 },
): LinuxInputCommand[] {
  switch (backend) {
    case "xdotool":
      return buildXdotoolCommands(event, size);
    case "ydotool":
      return buildYdotoolCommands(event, size);
    case "dotool": {
      const lines = buildDotoolLines(event);
      return lines.length > 0 ? [{ command: "dotool", args: [], stdin: `${lines.join("\n")}\n` }] : [];
    }
    case "wtype":
      return buildWtypeCommands(event);
  }
}

/** Dispatches viewer pointer and keyboard events on Linux using the available X11/Wayland backend. */
export class LinuxInputControl {
  private backend: LinuxInputBackend | null = null;
  private displaySize: { w: number; h: number; x?: number; y?: number } = { w: 1920, h: 1080 };
  private stopped = false;
  private running = false;
  private pendingMove: InputEvent | undefined;
  private queue: LinuxInputCommand[] = [];
  private dotoolProcess: ChildProcess | undefined;

  constructor(
    private readonly listener: InputListener,
    private readonly log: (message: string) => void,
    private readonly deps: LinuxProbeDeps = {},
  ) {}

  async start(screen: number): Promise<void> {
    if (this.stopped) return;
    const [diag, displays] = await Promise.all([probeLinuxScreen(this.deps), listLinuxDisplays(this.deps)]);
    if (this.stopped) return;
    const target = displays.find((d) => d.screen === screen || d.index === screen) ?? displays[0];
    if (target?.w && target?.h) {
      this.displaySize = {
        w: target.w,
        h: target.h,
        ...(target.x !== undefined ? { x: target.x } : {}),
        ...(target.y !== undefined ? { y: target.y } : {}),
      };
    }
    this.backend = diag.inputBackend;
    if (!diag.inputBackend) {
      this.listener.state({
        available: false,
        reason: diag.problem || "请安装 xdotool（X11）或 dotool / ydotool（Wayland）",
      });
      return;
    }
    if (diag.inputBackend === "dotool" && !this.deps.runCommand) {
      this.startDotoolDaemon();
    }
    this.listener.state({ available: true, trusted: true, app: diag.inputBackend });
  }

  private startDotoolDaemon(): void {
    const child = spawn("dotool", [], { stdio: ["pipe", "ignore", "pipe"] });
    this.dotoolProcess = child;
    child.stdin?.on("error", () => {});
    child.on("error", (err) => {
      this.log(`[screen] dotool error: ${err.message}`);
      if (this.dotoolProcess === child) this.dotoolProcess = undefined;
    });
    child.on("exit", () => {
      if (this.dotoolProcess === child) this.dotoolProcess = undefined;
    });
  }

  send(event: InputEvent): void {
    if (this.stopped || !this.backend) return;
    if (this.backend === "dotool" && this.dotoolProcess?.stdin?.writable) {
      const lines = buildDotoolLines(event);
      if (lines.length > 0) this.dotoolProcess.stdin.write(`${lines.join("\n")}\n`);
      return;
    }
    // Coalesce queued move events so pointer drag/trackpad motion stays responsive without subprocess backlog.
    if (event.t === "move" && this.running) {
      this.pendingMove = event;
      return;
    }
    const commands = buildLinuxInputCommands(event, this.backend, this.displaySize);
    if (commands.length === 0) return;
    this.queue.push(...commands);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped || !this.backend) return;
    this.running = true;
    const exec = resolveExec(this.deps);
    try {
      while (!this.stopped) {
        let next = this.queue.shift();
        if (!next && this.pendingMove) {
          const move = this.pendingMove;
          this.pendingMove = undefined;
          next = buildLinuxInputCommands(move, this.backend, this.displaySize)[0];
        }
        if (!next) break;
        await this.executeCommand(next, exec);
      }
    } finally {
      this.running = false;
    }
  }

  private async executeCommand(
    cmd: LinuxInputCommand,
    exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>,
  ): Promise<void> {
    if (cmd.stdin !== undefined && !this.deps.runCommand) {
      await new Promise<void>((resolve) => {
        const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", () => resolve());
        child.once("exit", () => resolve());
        child.stdin?.end(cmd.stdin);
      });
      return;
    }
    await exec(cmd.command, cmd.args, { timeout: 2000 }).catch((error) => {
      this.log(`[screen] linux input (${cmd.command}) failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.pendingMove = undefined;
    if (this.dotoolProcess) {
      const child = this.dotoolProcess;
      this.dotoolProcess = undefined;
      child.stdin?.end();
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 500).unref();
    }
  }
}
