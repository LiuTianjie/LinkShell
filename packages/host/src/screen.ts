import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { RpcError } from "@linkshell/wire";
import { closeInputApp, inputApp, InputControl, NO_APP, videoSignal, type HelperApp } from "./input.js";
import { LADDER, Pacer, RELAY_LEVEL, rung } from "./screen-pacer.js";
import { viewerPage } from "./screen-viewer.js";

// Viewing the computer's screen from the phone. The host serves a small
// viewer page on a loopback port; the phone opens it through the same
// encrypted forwarder as port previews. A random token gates the port: other
// programs on this machine can't watch the screen without having Screen
// Recording permission themselves.
//
// On a Mac the picture is LinkShell.app's (apps/mac; see `input.ts`), which
// holds the system's permissions under its own name. Where the app and the
// viewer can reach each other, it is a video track the app sends the viewer
// directly (docs/v2/screen-realtime.md): the page's socket then carries only
// what the two need to find each other. Where they can't, the app encodes the
// picture for the socket instead, and the host paces it (`screen-pacer.ts`):
// H.264 frames down a pipe that loses nothing, through the forwarder, with the
// viewer's pointer and key events coming back up it. On Linux that second way
// is the only one, with ffmpeg capturing.

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
  /** One whole frame. */
  frame(unit: Buffer, key: boolean): void;
  /** The frames from here on are of another size (a capture that changes level without stopping). */
  resized?(): void;
  /** Over, and not because it was ended here; with words for the viewer when they can do something about it. */
  exit(message?: string): void;
}

/** A capture under way: how to end it, and when it has gone. */
interface Running {
  end(): void;
  gone: Promise<void>;
  /** Whose it is. */
  on: CaptureEvents;
  /** Another level without stopping, where the capture can do that. */
  change?(level: number): void;
  /** The next frame a keyframe, where the capture can do that. */
  key?(): void;
}

/** A display to capture, and its number to the app (`index` is what the viewer names it by). */
interface Capturable extends Display {
  screen: number;
}

/** ffmpeg's capture of an X display (Linux), for one rung of the ladder (see `screen-pacer.ts`): 0 is the best picture. */
export function captureArgs(level = 0): string[] {
  const profile = rung(level);
  const rate = (bits: number) => `${Math.round(bits / 1000)}k`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f", "x11grab", "-framerate", String(profile.fps), "-i", process.env.DISPLAY ?? ":0",
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

/** Ends a capture. ffmpeg holding a screen can sit through SIGTERM — and through its output going away — so it is asked, then made to. */
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

/**
 * The widest picture a viewer asks the video track for (`?width=`), or undefined for the app's own
 * choice. "native" is the display's own width: the app never sends more than the display has.
 */
export function videoWidth(asked: string | null): number | undefined {
  if (asked === "native") return VIDEO_WIDEST;
  const width = Number(asked);
  return Number.isInteger(width) && width >= 640 ? Math.min(width, VIDEO_WIDEST) : undefined;
}

/** A receiver capability, not a request to disable the sender's frame-rate adaptation. */
export function videoMaxFps(asked: string | null): number | undefined {
  return asked === "30" || asked === "60" || asked === "120" ? Number(asked) : undefined;
}
// A 5K display's 5120 would be past what the encoder and a phone's decoder carry at 60 frames.
const VIDEO_WIDEST = 3840;

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
  /** The viewer the app is sending the screen to as a video track. One at a time, like captures. */
  private video?: { id: string; taken(): void };
  private readonly controls = new Set<InputControl>();

  constructor(
    private readonly log: (message: string) => void,
    /** The servers both ends ask for their public address, to reach each other directly. */
    private readonly iceServers: () => string[] = () => [],
  ) {
    void reapOrphanCaptures(log);
  }

  async start(): Promise<{ port: number; token: string; displays: Display[] }> {
    const displays = (this.displays = await this.listDisplays());
    if (!displays.length) throw RpcError.app("not_supported", "没有找到可以捕获的屏幕");
    // A fresh token per start: an old viewer URL stops working.
    this.token = randomBytes(24).toString("base64url");
    const port = await this.listen();
    return { port, token: this.token, displays: displays.map(({ index, name }) => ({ index, name })) };
  }

  private async listDisplays(): Promise<Capturable[]> {
    if (process.platform === "darwin") {
      const app = inputApp(this.log);
      if (!app) throw RpcError.app("not_supported", NO_APP);
      const displays = await app.displays();
      return displays.map(({ screen, name }) => ({ index: screen, screen, name: name || `屏幕 ${screen + 1}` }));
    }
    if (process.platform !== "linux") throw RpcError.app("not_supported", "这台电脑的系统暂不支持查看屏幕");
    if (!(await hasFfmpeg())) throw RpcError.app("not_supported", "查看屏幕需要电脑上装有 ffmpeg");
    return [{ index: 0, name: "屏幕", screen: 0 }];
  }

  private listen(): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as AddressInfo).port);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!this.authorized(url)) {
        response.writeHead(403).end();
        return;
      }
      // Measuring (LINKSHELL_SCREEN_CLOCK=1): every viewer reads the clock the app shows, whoever made its address.
      if (process.env.LINKSHELL_SCREEN_CLOCK === "1" && !url.searchParams.has("measure")) {
        url.searchParams.set("measure", "sync");
        response.writeHead(302, { location: `${url.pathname}${url.search}`, "cache-control": "no-store" }).end();
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
      // "video": the viewer can take the picture as a video track.
      const video = url.searchParams.get("video") === "1";
      const width = videoWidth(url.searchParams.get("width"));
      const maxFps = videoMaxFps(url.searchParams.get("maxFps"));
      const diagnostics = url.searchParams.get("diagnostics") === "1";
      sockets.handleUpgrade(request, socket, head, (ws) => this.stream(ws, Number(url.searchParams.get("display") ?? NaN), relayed, video, width, maxFps, diagnostics));
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
   * Whether the screen can be watched and controlled. On a Mac that is the
   * app's to say; with `ask`, the app opens its window for what is missing.
   * (`ffmpeg`: whether what captures is there — ffmpeg itself on Linux.)
   */
  async access(ask: boolean): Promise<ScreenAccess> {
    const supported = process.platform === "darwin" || process.platform === "linux";
    if (process.platform !== "darwin") return { supported, ffmpeg: supported && (await hasFfmpeg()), recording: null, control: null, problem: "controlling the screen needs macOS" };
    const app = inputApp(this.log);
    if (!app) {
      const problem =
        process.arch === "arm64"
          ? "LinkShell.app is missing from this installation (the optional package @linkshell/mac was not installed): reinstall with `npm install -g linkshell-cli`"
          : "the screen needs a Mac with Apple silicon (this one is Intel)";
      return { supported: process.arch === "arm64", ffmpeg: false, recording: null, control: null, problem };
    }
    try {
      const status = await app.access();
      if (ask && (!status.recording || !status.trusted)) await app.ask();
      return { supported, ffmpeg: true, recording: status.recording, control: status.trusted, app: status.app };
    } catch (error) {
      return { supported, ffmpeg: true, recording: null, control: null, problem: (error as Error).message };
    }
  }

  /** Starts a capture where it may record. Undefined when it may not: the viewer has been told why. */
  private async capture(screen: number, level: number, on: CaptureEvents): Promise<Running | undefined> {
    let ended = false;
    let leave = () => {};
    const gone = new Promise<void>((resolve) => (leave = resolve));
    if (process.platform === "darwin") {
      const app = inputApp(this.log);
      if (!app) {
        on.exit(NO_APP);
        return undefined;
      }
      const status = await app.access();
      if (!status.recording) {
        // Someone may be at the computer: the app's window for its permissions comes up there.
        void app.ask().catch(() => {});
        on.exit(notAllowed(status.app));
        return undefined;
      }
      let size: number | undefined;
      const stream = await app.stream(screen, rung(level), {
        frame: (unit, key, generation) => {
          if (ended) return;
          if (size !== undefined && generation !== size) on.resized?.();
          size = generation;
          on.frame(unit, key);
        },
        exit: (error) => {
          leave();
          if (ended) return;
          if (error) this.log(`[screen] the app's capture ended: ${error}`);
          on.exit(!error ? undefined : /permission|not allowed|not authorized|denied|declined/i.test(error) ? notAllowed(status.app) : "屏幕捕获失败");
        },
      });
      return {
        on,
        gone,
        end: () => {
          ended = true;
          stream.end();
          leave();
        },
        change: (next) => stream.set(rung(next)),
        key: () => stream.key(),
      };
    }
    const capture = spawn("ffmpeg", captureArgs(level), { stdio: ["ignore", "pipe", "pipe"] });
    this.captures.add(capture);
    const splitter = new AccessUnitSplitter();
    let errors = "";
    capture.stdout!.on("data", (chunk: Buffer) => {
      if (!ended) splitter.push(chunk, on.frame);
    });
    capture.stderr!.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)));
    const finished = (code: number, said: string) => {
      leave();
      if (ended) return;
      if (code) this.log(`[screen] capture exited ${code}: ${said.trim()}`);
      on.exit(code ? "屏幕捕获失败" : undefined);
    };
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
  private take(screen: number, level: number, on: CaptureEvents, wanted: () => boolean): Promise<Running | undefined> {
    const mine = this.turn.then(async () => {
      this.video?.taken();
      const previous = this.holder;
      if (previous) {
        this.holder = undefined;
        previous.end();
        // Another device's picture ends here; a viewer changing its own just carries on.
        if (previous.on !== on) previous.on.exit("屏幕画面被另一台设备接手了");
        await Promise.race([previous.gone, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
      if (!wanted()) return undefined;
      const running = await this.capture(screen, level, on);
      this.holder = running;
      return running;
    });
    this.turn = mine.catch(() => {});
    return mine;
  }

  /**
   * Has the app offer the screen to this viewer as a video track. False when it can't (no app, an
   * app without the media engine): the picture then goes down the socket.
   */
  private async offerVideo(screen: number, maxWidth: number | undefined, maxFps: number | undefined, diagnostics: boolean, viewer: { closed(): boolean; tell(message: object): void; refuse(message: string): void; lost(): void }): Promise<{ app: HelperApp; id: string } | "refused" | undefined> {
    // LINKSHELL_SCREEN_VIDEO=off: every viewer gets the picture down the socket (to compare the two, or should the track ever misbehave).
    const app = process.platform === "darwin" && process.env.LINKSHELL_SCREEN_VIDEO !== "off" ? inputApp(this.log) : undefined;
    if (!app) return undefined;
    const status = await app.access();
    if (!status.video) return undefined;
    if (!status.recording) {
      // Someone may be at the computer: the system's question, and its settings, come up there.
      void app.ask().catch(() => {});
      viewer.refuse(notAllowed(status.app));
      return "refused";
    }
    if (viewer.closed()) return "refused";
    // The latest viewer has the screen, whichever way the one before was getting it.
    this.video?.taken();
    const holder = this.holder;
    if (holder) {
      this.holder = undefined;
      holder.end();
      holder.on.exit("屏幕画面被另一台设备接手了");
    }
    const id = `video-${randomBytes(6).toString("hex")}`;
    const mine = {
      id,
      taken: () => {
        if (this.video === mine) this.video = undefined;
        app.endVideo(id);
        viewer.refuse("屏幕画面被另一台设备接手了");
      },
    };
    this.video = mine;
    let reached: unknown;
    let lastStats = 0;
    const iceServers = this.iceServers().map((url) => ({ urls: [url] }));
    viewer.tell({ rtc: { t: "config", iceServers } });
    // LINKSHELL_SCREEN_FPS: another frame rate than the app's own choice, to try one out.
    const fps = Number(process.env.LINKSHELL_SCREEN_FPS);
    await app.offerVideo(id, { screen, iceServers, ...(fps >= 1 && fps <= 120 ? { fps } : {}), ...(maxWidth ? { maxWidth } : {}), ...(maxFps ? { maxFps } : {}) }, (message) => {
      if (this.video !== mine) return;
      const kind = String(message.t);
      if (kind === "gone" || kind === "rtc.error") {
        this.log(`[screen] the video track ended: ${kind === "gone" ? "LinkShell.app went" : String(message.message)}`);
        viewer.lost();
      } else if (kind === "posted") {
        // A dry run: what the viewer's events, come to the app directly, would have done.
        this.log(`[screen] dry run: ${JSON.stringify(message)}`);
      } else if (kind === "rtc.offer" || kind === "rtc.ice" || kind === "rtc.state" || (kind === "rtc.stats" && diagnostics && Date.now() - lastStats >= 5000)) {
        if (kind === "rtc.stats") lastStats = Date.now();
        if (kind === "rtc.state" && message.connection !== reached) {
          reached = message.connection;
          if (reached === "connected") this.log("[screen] the picture is a video track, straight to the viewer");
        }
        const { v: _viewer, t: _kind, ...rest } = message;
        viewer.tell({ rtc: { ...rest, t: kind.slice(4) } });
      }
    });
    return { app, id };
  }

  private stream(ws: WebSocket, display: number, relayed: boolean, wantsVideo: boolean, width: number | undefined, maxFps?: number, diagnostics = false): void {
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
    let closed = false;
    let changing = false;
    let lighter = false;
    let askedForKey = 0;
    // Nobody is looking at the viewer (its page is hidden): nothing is sent, and its slowness to answer means nothing.
    let unwatched = false;
    // Sending again starts at a keyframe.
    let wantsKey = false;
    let running: Running | undefined;
    // Dropping, with only a keyframe missing to carry on: a capture that makes one when asked is asked.
    const askForKey = () => {
      const now = Date.now();
      if (!running?.key || now - askedForKey < 500 || !pacer.needsKey(now)) return;
      askedForKey = now;
      running.key();
    };
    // A still screen sends no frame to be reminded by.
    const reminder = setInterval(askForKey, 500);
    const events: CaptureEvents = {
      frame: (unit, key) => {
        if (ws.readyState !== ws.OPEN || unwatched) return;
        if (wantsKey && !key) return;
        wantsKey = false;
        const now = Date.now();
        const seq = pacer.next(key, now);
        if (seq !== undefined) {
          const head = Buffer.allocUnsafe(5);
          head[0] = key ? 1 : 0;
          head.writeUInt32BE(seq >>> 0, 1);
          ws.send(Buffer.concat([head, unit]));
        } else askForKey();
        const advice = changing ? undefined : pacer.advice(now, level > best, level < LADDER.length - 1);
        if (advice) void change(level + (advice === "down" ? 1 : -1));
      },
      // The page starts its decoder afresh for the new size; what it had of the old one came before this, in order.
      resized: () => tell({ restart: true, level, lighter }),
      exit: (message) => {
        if (message) tell({ error: message });
        ws.close();
      },
    };
    const begin = async () => {
      const started = await this.take(shown?.screen ?? 0, level, events, () => !closed);
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
      lighter = next > level;
      const to = rung(next);
      this.log(`[screen] picture ${lighter ? "lighter" : "better"}: ${to.width} wide, ${to.fps} a second, ${Math.round(to.bitrate / 1000)} kbit/s`);
      if (running?.change) {
        // The capture carries on: the new level takes over at a keyframe, with nothing lost in between.
        running.change(next);
        level = next;
        pacer.changed(Date.now());
        changing = false;
        return;
      }
      // Nothing more of the old stream goes out; the page starts its decoder afresh for the new one.
      running?.end();
      tell({ restart: true, level: next, lighter });
      level = next;
      await begin().catch(failed);
      pacer.restarted(Date.now());
      changing = false;
    };

    // The picture as a video track; down this socket when that can't be had, or didn't get across.
    let video: { app: HelperApp; id: string } | undefined;
    const endVideo = () => {
      if (!video) return;
      video.app.endVideo(video.id);
      if (this.video?.id === video.id) this.video = undefined;
      video = undefined;
    };
    const fallBack = () => {
      if (!video) return;
      endVideo();
      if (closed) return;
      tell({ rtc: { t: "off" } });
      void begin().catch(failed);
    };
    if (wantsVideo) {
      this.offerVideo(shown?.screen ?? 0, width, maxFps, diagnostics, {
        closed: () => closed,
        tell,
        refuse: (message) => {
          video = undefined;
          tell({ error: message });
          ws.close();
        },
        lost: fallBack,
      })
        .then((offered) => {
          if (offered === "refused") return;
          if (closed) {
            if (offered) offered.app.endVideo(offered.id);
            return;
          }
          if (offered) video = offered;
          else {
            tell({ rtc: { t: "off" } });
            return begin();
          }
        })
        .catch(failed);
    } else void begin().catch(failed);

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
      else if (kind === "rtc.answer" || kind === "rtc.ice") {
        const signal = videoSignal.safeParse(message);
        if (signal.success && video) video.app.signal(video.id, signal.data);
      }
      // The viewer's decoder lost its place (it skipped ahead, or failed): it can only carry on from a keyframe.
      // (Named apart from the viewer's own events: whatever isn't one of these kinds is taken for a pointer or key event.)
      else if (kind === "keyframe") {
        const now = Date.now();
        if (running?.key && now - askedForKey >= 500) {
          askedForKey = now;
          running.key();
        }
      } else if (kind === "hidden") unwatched = true;
      else if (kind === "shown") {
        if (!unwatched) return;
        unwatched = false;
        wantsKey = true;
        // What was on its way when the page went out of sight is not waited for.
        pacer.restarted(Date.now());
        running?.key?.();
      }
      // No direct path between the two, or none in time: the viewer asks for the picture here instead.
      else if (kind === "rtc.failed") {
        this.log(`[screen] no video track for this viewer (${String((message as { reason?: unknown }).reason ?? "no reason given").slice(0, 200)}): the picture goes down the socket`);
        fallBack();
      }
      // A viewer measuring (`?measure=1`): its clock against this computer's (it keeps the answer that came back
      // quickest), then what it sees, once a second.
      else if (kind === "ping") tell({ pong: { n: (message as { n?: unknown }).n, at: (message as { at?: unknown }).at, now: Date.now() } });
      else if (kind === "measure") this.log(`[screen] measured: ${JSON.stringify(message).slice(0, 1000)}`);
      else if (kind === "control") void control.start(shown?.screen ?? 0);
      else control.send(message);
    });
    ws.on("close", () => {
      closed = true;
      clearInterval(reminder);
      if (running && this.holder === running) this.holder = undefined;
      running?.end();
      endVideo();
      control.stop();
      this.controls.delete(control);
    });
  }

  stop(): void {
    // The host is going: there is no later to insist in.
    this.holder?.end();
    this.holder = undefined;
    this.video = undefined;
    for (const capture of this.captures) endCapture(capture, true);
    this.captures.clear();
    for (const control of this.controls) control.stop();
    this.controls.clear();
    closeInputApp();
    this.server?.close();
    this.server = undefined;
  }
}
