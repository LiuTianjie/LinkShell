import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { RpcError } from "@linkshell/wire";
import { closeInputApp, hostAccess, inputApp, InputControl } from "./input.js";
import { LADDER, Pacer, RELAY_LEVEL } from "./screen-pacer.js";
import { viewerPage } from "./screen-viewer.js";

// Viewing the computer's screen from the phone. The host serves a small
// viewer page and an H.264 stream on a loopback port; the phone opens it
// through the same encrypted forwarder as port previews, so the video never
// leaves the end-to-end channel and needs no NAT traversal. A random token
// gates the port: other programs on this machine can't watch the screen
// without having Screen Recording permission themselves. The same socket
// carries the viewer's pointer and key events back (see `input.ts`).
//
// On a Mac the system allows recording to an app by name. A released package
// carries one, LinkShell.app, and the capture runs as its child: the
// permission is LinkShell's, whichever terminal started the host.

const run = promisify(execFile);

export interface Display {
  index: number;
  name: string;
}

async function hasFfmpeg(): Promise<boolean> {
  return run("ffmpeg", ["-hide_banner", "-version"], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
}

/** Where ffmpeg is: an app the system opened has no shell's PATH to find it on. */
async function ffmpegPath(): Promise<string> {
  return run("/usr/bin/which", ["ffmpeg"], { timeout: 5000 }).then(
    ({ stdout }) => stdout.trim() || "ffmpeg",
    () => "ffmpeg",
  );
}

/** What the phone is told when the picture can't be had for want of the permission. */
const notAllowed = (app: string) =>
  `电脑还没有允许${app ? `「${app}」` : ""}录制屏幕。在电脑上运行 linkshell screen 按提示操作，或在「系统设置 › 隐私与安全性 › 录屏与系统录音」里打开${app ? `「${app}」` : "它"}的开关，然后重新进入这个页面。`;

export interface ScreenAccess {
  supported: boolean;
  ffmpeg: boolean;
  recording: boolean | null;
  control: boolean | null;
  app?: string;
  problem?: string;
}

interface CaptureEvents {
  data(chunk: Buffer): void;
  /** Over, and not because it was ended here; with words for the viewer when they can do something about it. */
  exit(message?: string): void;
}

/** A capture under way: how to end it, and when it has gone. */
interface Running {
  end(): void;
  gone: Promise<void>;
  /** Whose it is. */
  on: CaptureEvents;
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

/** The capture for one rung of the ladder (see `screen-pacer.ts`): 0 is the best picture. */
export function captureArgs(display: number, level = 0): string[] {
  const profile = LADDER[Math.min(Math.max(level, 0), LADDER.length - 1)]!;
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
  /**
   * The capture that has the screen. The system gives it to one at a time, and
   * one started while another still holds it never gets a frame, even after
   * the other has gone: the next starts once this one has.
   */
  private holder?: Running;
  private turn: Promise<unknown> = Promise.resolve();
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
      // "low": the viewer is reached through a gateway, which should carry messages rather than video.
      const relayed = url.searchParams.get("q") === "low";
      sockets.handleUpgrade(request, socket, head, (ws) => this.stream(ws, Number(url.searchParams.get("display") ?? NaN), relayed));
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

  /**
   * Whether the screen can be watched and controlled, as whatever will do it
   * sees it: the app where the package has one, this process otherwise. With
   * `ask`, the system asks for the first permission missing.
   */
  async access(ask: boolean): Promise<ScreenAccess> {
    const supported = process.platform === "darwin" || process.platform === "linux";
    const ffmpeg = supported && (await hasFfmpeg());
    if (process.platform !== "darwin") return { supported, ffmpeg, recording: null, control: null, problem: "controlling the screen needs macOS" };
    const app = inputApp(this.log);
    try {
      const status = app ? await app.access() : await hostAccess(this.log);
      // One question at a time: the picture first, then the hands.
      const missing = !status.recording ? "recording" : !status.trusted ? "control" : undefined;
      if (ask && missing) await (app ? app.ask(missing) : hostAccess(this.log, missing));
      return { supported, ffmpeg, recording: status.recording, control: status.trusted, app: status.app };
    } catch (error) {
      return { supported, ffmpeg, recording: null, control: null, problem: (error as Error).message };
    }
  }

  /** Starts a capture where it may record. Undefined when it may not: the viewer has been told why. */
  private async capture(index: number, level: number, on: CaptureEvents): Promise<Running | undefined> {
    const args = captureArgs(index, level);
    let ended = false;
    let leave = () => {};
    const gone = new Promise<void>((resolve) => (leave = resolve));
    const data = (chunk: Buffer) => {
      if (!ended) on.data(chunk);
    };
    const finished = (code: number, errors: string) => {
      leave();
      if (ended) return;
      if (code) this.log(`[screen] capture exited ${code}: ${errors.trim()}`);
      on.exit(!code ? undefined : /permission|not authorized|denied/i.test(errors) ? notAllowed("") : "屏幕捕获失败");
    };
    const app = process.platform === "darwin" ? inputApp(this.log) : undefined;
    if (app) {
      const status = await app.access();
      if (!status.recording) {
        // Someone may be at the computer: the system's question, and its settings, come up there.
        void app.ask("recording").catch(() => {});
        on.exit(notAllowed(status.app));
        return undefined;
      }
      const stop = await app.capture(await ffmpegPath(), args, { data, exit: finished });
      return {
        on,
        gone,
        end: () => {
          ended = true;
          stop();
        },
      };
    }
    if (process.platform === "darwin") {
      // Without the permission the capture just waits, and so would the phone.
      const status = await hostAccess(this.log).catch(() => undefined);
      if (status && !status.recording) {
        void hostAccess(this.log, "recording").catch(() => {});
        on.exit(notAllowed(status.app));
        return undefined;
      }
    }
    const capture = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.captures.add(capture);
    let errors = "";
    capture.stdout!.on("data", data);
    capture.stderr!.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)));
    capture.on("error", (error) => finished(-1, error.message));
    capture.on("exit", (code) => {
      this.captures.delete(capture);
      finished(code ?? 0, errors);
    });
    return {
      on,
      gone,
      end: () => {
        ended = true;
        endCapture(capture);
      },
    };
  }

  /** Takes the screen for a new capture: whatever holds it is ended, and has left, before the new one starts. */
  private take(index: number, level: number, on: CaptureEvents, wanted: () => boolean): Promise<Running | undefined> {
    const mine = this.turn.then(async () => {
      const previous = this.holder;
      if (previous) {
        this.holder = undefined;
        previous.end();
        // Another device's picture ends here; a viewer changing its own just carries on.
        if (previous.on !== on) previous.on.exit("屏幕画面被另一台设备接手了");
        await Promise.race([previous.gone, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
      if (!wanted()) return undefined;
      const running = await this.capture(index, level, on);
      this.holder = running;
      return running;
    });
    this.turn = mine.catch(() => {});
    return mine;
  }

  private stream(ws: WebSocket, display: number, relayed: boolean): void {
    const shown = this.displays.find((entry) => entry.index === display) ?? this.displays[0];
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

    // The picture: as good as the path carries without falling behind (see `screen-pacer.ts`).
    const best = relayed ? RELAY_LEVEL : 0;
    const pacer = new Pacer(Date.now());
    let level = best;
    let splitter = new AccessUnitSplitter();
    let closed = false;
    let changing = false;
    let running: Running | undefined;
    const events: CaptureEvents = {
      data: (chunk) =>
        splitter.push(chunk, (unit, key) => {
          if (ws.readyState !== ws.OPEN) return;
          const now = Date.now();
          const seq = pacer.next(key, now);
          if (seq !== undefined) {
            const head = Buffer.allocUnsafe(5);
            head[0] = key ? 1 : 0;
            head.writeUInt32BE(seq >>> 0, 1);
            ws.send(Buffer.concat([head, unit]));
          }
          const advice = changing ? undefined : pacer.advice(now, level > best, level < LADDER.length - 1);
          if (advice) void change(level + (advice === "down" ? 1 : -1));
        }),
      exit: (message) => {
        if (message) tell({ error: message });
        ws.close();
      },
    };
    const begin = async () => {
      const started = await this.take(shown?.index ?? 0, level, events, () => !closed);
      if (closed) started?.end();
      else running = started;
    };
    const failed = (error: Error) => {
      this.log(`[screen] the capture did not start: ${error.message}`);
      tell({ error: "屏幕捕获失败" });
      ws.close();
    };
    const change = async (next: number) => {
      changing = true;
      this.log(`[screen] picture ${next > level ? "lighter" : "better"}: ${LADDER[next]!.width} wide, ${LADDER[next]!.fps} a second, ${LADDER[next]!.bitrate}`);
      // Nothing more of the old stream goes out; the page starts its decoder afresh for the new one.
      running?.end();
      tell({ restart: true, level: next, lighter: next > level });
      level = next;
      splitter = new AccessUnitSplitter();
      await begin().catch(failed);
      pacer.restarted(Date.now());
      changing = false;
    };
    void begin().catch(failed);

    ws.on("message", (data, binary) => {
      if (binary) return;
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      const kind = (message as { t?: unknown } | null)?.t;
      if (kind === "ack") pacer.ack(Number((message as { n?: unknown }).n), Date.now());
      else if (kind === "control") void control.start(shown?.screen ?? 0);
      else control.send(message);
    });
    ws.on("close", () => {
      closed = true;
      if (running && this.holder === running) this.holder = undefined;
      running?.end();
      control.stop();
      this.controls.delete(control);
    });
  }

  stop(): void {
    // The host is going: there is no later to insist in.
    this.holder?.end();
    this.holder = undefined;
    for (const capture of this.captures) endCapture(capture, true);
    this.captures.clear();
    for (const control of this.controls) control.stop();
    this.controls.clear();
    closeInputApp();
    this.server?.close();
    this.server = undefined;
  }
}
