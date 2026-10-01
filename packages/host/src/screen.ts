import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { RpcError } from "@linkshell/wire";
import { InputControl } from "./input.js";
import { viewerPage } from "./screen-viewer.js";

// Viewing the computer's screen from the phone. The host serves a small
// viewer page and an H.264 stream on a loopback port; the phone opens it
// through the same encrypted forwarder as port previews, so the video never
// leaves the end-to-end channel and needs no NAT traversal. A random token
// gates the port: other programs on this machine can't watch the screen
// without having Screen Recording permission themselves. The same socket
// carries the viewer's pointer and key events back (see `input.ts`).

const run = promisify(execFile);

export interface Display {
  index: number;
  name: string;
}

/**
 * How the picture is sent. `full` when it goes straight to the device; `low`
 * when it is relayed by a gateway, which should carry messages rather than video.
 */
const PROFILES = {
  full: { fps: 20, width: 1600, bitrate: "3M", ceiling: "4M" },
  low: { fps: 12, width: 1280, bitrate: "900k", ceiling: "1300k" },
} as const;
export type ScreenProfile = keyof typeof PROFILES;

async function hasFfmpeg(): Promise<boolean> {
  return run("ffmpeg", ["-hide_banner", "-version"], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
}

/** A display to capture, and which of the system's displays it is (ffmpeg's "Capture screen N" is the Nth active one). */
interface Capturable extends Display {
  screen: number;
}

/** macOS: AVFoundation's "Capture screen N" devices. */
async function listDisplays(): Promise<Capturable[]> {
  if (process.platform !== "darwin") return [{ index: 0, name: "屏幕", screen: 0 }];
  const output = await run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { timeout: 8000 }).then(
    ({ stderr }) => stderr,
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  const displays: Capturable[] = [];
  for (const match of output.matchAll(/\[(\d+)\] Capture screen (\d+)/g)) {
    displays.push({ index: Number(match[1]), name: `屏幕 ${Number(match[2]) + 1}`, screen: Number(match[2]) });
  }
  return displays;
}

export function captureArgs(display: number, quality: ScreenProfile = "full"): string[] {
  const profile = PROFILES[quality];
  const input =
    process.platform === "darwin"
      ? ["-f", "avfoundation", "-capture_cursor", "1", "-framerate", String(profile.fps), "-i", `${display}:none`]
      : ["-f", "x11grab", "-framerate", String(profile.fps), "-i", process.env.DISPLAY ?? ":0"];
  const encode =
    process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-realtime", "1", "-profile:v", "baseline", "-b:v", profile.bitrate, "-maxrate", profile.ceiling]
      : [
          "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-x264-params", "sliced-threads=0",
          "-b:v", profile.bitrate, "-maxrate", profile.ceiling, "-bufsize", profile.ceiling,
        ];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...input,
    "-vf",
    // AVFoundation captures a screen at its refresh rate whatever -framerate asks (120 a second on a
    // ProMotion display): the frames are dropped here, before the encoder and the network pay for them.
    `fps=${profile.fps},scale='min(${profile.width},iw)':-2,format=yuv420p`,
    ...encode,
    "-g",
    String(profile.fps * 2),
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

/** Splits an Annex-B stream at access-unit delimiters (NAL type 9) into whole frames. */
export class AccessUnitSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, emit: (unit: Buffer, key: boolean) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = this.nextDelimiter(0);
    if (start < 0) return;
    for (;;) {
      const next = this.nextDelimiter(start + 4);
      if (next < 0) break;
      const unit = this.buffer.subarray(start, next);
      emit(unit, AccessUnitSplitter.isKey(unit));
      start = next;
    }
    this.buffer = this.buffer.subarray(start);
  }

  /** Start of the next `00 00 01 09` (with its optional leading zero) at or after `from`. */
  private nextDelimiter(from: number): number {
    for (let i = from; i + 3 < this.buffer.length; i++) {
      if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1 && (this.buffer[i + 3]! & 0x1f) === 9) {
        return i > 0 && this.buffer[i - 1] === 0 ? i - 1 : i;
      }
    }
    return -1;
  }

  /** Holds an IDR slice (NAL type 5). */
  static isKey(unit: Buffer): boolean {
    for (let i = 0; i + 3 < unit.length; i++) {
      if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1 && (unit[i + 3]! & 0x1f) === 5) return true;
    }
    return false;
  }
}

/**
 * Ends a capture. ffmpeg holding a screen through avfoundation can sit through
 * SIGTERM — and through its output going away — so it is asked, then made to.
 */
export function endCapture(capture: ChildProcess, now = false): void {
  if (capture.exitCode !== null || capture.signalCode !== null) return;
  if (now) {
    capture.kill("SIGKILL");
    return;
  }
  capture.kill("SIGTERM");
  setTimeout(() => {
    if (capture.exitCode === null && capture.signalCode === null) capture.kill("SIGKILL");
  }, 800).unref();
}

/** What marks a process as one of our captures: the stream options no other use of ffmpeg combines. */
const CAPTURE_MARK = "-bsf:v h264_metadata=aud=insert -f h264 -";

/**
 * Captures a host left behind when it was killed (nothing reads them, and they
 * keep the screen recorder busy): ours by their arguments, orphaned by their parent.
 */
export async function reapOrphanCaptures(log: (message: string) => void): Promise<number> {
  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
    let reaped = 0;
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match || match[2] !== "1") continue;
      const command = match[3]!;
      if (!/(^|\/)ffmpeg /.test(command) || !command.trimEnd().endsWith(CAPTURE_MARK)) continue;
      try {
        process.kill(Number(match[1]), "SIGKILL");
        reaped += 1;
      } catch {
        // Gone already, or not ours to end.
      }
    }
    if (reaped > 0) log(`[screen] ended ${reaped} screen capture${reaped === 1 ? "" : "s"} left by an earlier host`);
    return reaped;
  } catch {
    return 0;
  }
}

/** The loopback viewer server; started on first use, one capture per watching device. */
export class ScreenShare {
  private server?: Server;
  private token = "";
  private displays: Capturable[] = [];
  private readonly captures = new Set<ChildProcess>();
  private readonly controls = new Set<InputControl>();

  constructor(private readonly log: (message: string) => void) {
    void reapOrphanCaptures(log);
  }

  async start(): Promise<{ port: number; token: string; displays: Display[] }> {
    if (process.platform !== "darwin" && process.platform !== "linux") throw RpcError.app("not_supported", "这台电脑的系统暂不支持查看屏幕");
    if (!(await hasFfmpeg())) throw RpcError.app("not_supported", "查看屏幕需要电脑上装有 ffmpeg（brew install ffmpeg）");
    const displays = (this.displays = await listDisplays());
    if (!displays.length) throw RpcError.app("not_supported", "没有找到可以捕获的屏幕");
    // A fresh token per start: an old viewer URL stops working.
    this.token = randomBytes(24).toString("base64url");
    const port = await this.listen();
    return { port, token: this.token, displays: displays.map(({ index, name }) => ({ index, name })) };
  }

  private listen(): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as AddressInfo).port);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!this.authorized(url)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(viewerPage());
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/stream" || !this.authorized(url)) {
        socket.destroy();
        return;
      }
      const quality: ScreenProfile = url.searchParams.get("q") === "low" ? "low" : "full";
      sockets.handleUpgrade(request, socket, head, (ws) => this.stream(ws, Number(url.searchParams.get("display") ?? NaN), quality));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  private authorized(url: URL): boolean {
    const given = Buffer.from(url.searchParams.get("token") ?? "");
    const expected = Buffer.from(this.token);
    return this.token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  }

  private stream(ws: WebSocket, display: number, quality: ScreenProfile): void {
    const shown = this.displays.find((entry) => entry.index === display) ?? this.displays[0];
    const capture = spawn("ffmpeg", captureArgs(shown?.index ?? 0, quality), { stdio: ["ignore", "pipe", "pipe"] });
    this.captures.add(capture);
    const tell = (message: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    // The viewer's hands: started when it first asks to control, for the display it is watching.
    const control = new InputControl(
      {
        state: (state) => tell({ control: state }),
        cursor: (x, y) => tell({ cursor: { x, y } }),
        posted: (event) => this.log(`[screen] dry run: ${JSON.stringify(event)}`),
      },
      this.log,
    );
    this.controls.add(control);
    ws.on("message", (data, binary) => {
      if (binary) return;
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if ((message as { t?: unknown } | null)?.t === "control") void control.start(shown?.screen ?? 0);
      else control.send(message);
    });
    const splitter = new AccessUnitSplitter();
    let errors = "";
    capture.stdout!.on("data", (chunk: Buffer) =>
      splitter.push(chunk, (unit, key) => {
        // Behind (a slow link): skip frames until the next keyframe rather than queue up delay.
        if (!key && ws.bufferedAmount > 2_000_000) return;
        ws.send(Buffer.concat([Buffer.from([key ? 1 : 0]), unit]));
      }),
    );
    capture.stderr!.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)));
    capture.on("exit", (code) => {
      this.captures.delete(capture);
      if (code && ws.readyState === ws.OPEN) {
        this.log(`[screen] capture exited ${code}: ${errors.trim()}`);
        const permission = /permission|not authorized|denied/i.test(errors);
        ws.send(
          JSON.stringify({
            error: permission ? "电脑没有允许录制屏幕：在「系统设置 › 隐私与安全性 › 录屏与系统录音」里允许运行 LinkShell 的终端" : "屏幕捕获失败",
          }),
        );
      }
      ws.close();
    });
    ws.on("close", () => {
      endCapture(capture);
      control.stop();
      this.controls.delete(control);
    });
  }

  stop(): void {
    // The host is going: there is no later to insist in.
    for (const capture of this.captures) endCapture(capture, true);
    this.captures.clear();
    for (const control of this.controls) control.stop();
    this.controls.clear();
    this.server?.close();
    this.server = undefined;
  }
}
