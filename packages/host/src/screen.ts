import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { RpcError } from "@linkshell/wire";
import { closeInputApp, inputApp, InputControl, macAppSupported, NO_APP, videoSignal, type HelperApp, type StreamProfile, type VideoConfigured } from "./input.js";
import { LADDER, Pacer, RELAY_LEVEL, rung } from "./screen-pacer.js";
import { viewerPage } from "./screen-viewer.js";
import { screenMeasurementLog } from "./screen-metrics.js";
import { fallbackProfile, fallbackSize, SCREEN_RETAIN_MS, screenConfiguration, type ScreenConfiguration } from "./screen-session.js";

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
  ready?: Promise<{ width: number; height: number; maxFps: number }>;
  /** Whose it is. */
  on: CaptureEvents;
  /** Another level without stopping, where the capture can do that. */
  change?(level: number, profile?: StreamProfile): void;
  /** The next frame a keyframe, where the capture can do that. */
  key?(): void;
}

/** A display to capture, and its number to the app (`index` is what the viewer names it by). */
interface Capturable extends Display {
  screen: number;
  w?: number;
  h?: number;
}

async function captureReleased(capture: Running): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([capture.gone, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** ffmpeg's capture of an X display (Linux), for one rung of the ladder (see `screen-pacer.ts`): 0 is the best picture. */
export function captureArgs(level = 0, profile = fallbackProfile(level)): string[] {
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

/**
 * The address in an ICE candidate's SDP (`candidate:<foundation> <component> <transport>
 * <priority> <address> <port> typ <type> …`), and the same line with another address in its place.
 */
const candidateAddress = (sdp: string): string | undefined => sdp.split(" ")[4];

function withCandidateAddress(sdp: string, address: string): string {
  const fields = sdp.split(" ");
  fields[4] = address;
  return fields.join(" ");
}

/**
 * A browser hides the computer it runs on by offering its host candidates under a random mDNS
 * name (`<uuid>.local`) instead of an address: Chrome and Safari both do, and a page cannot turn
 * it off. libwebrtc in LinkShell.app does not resolve a remote candidate's name, so every one of
 * those pairs stays in checking and the video falls back to a reflexive path through the
 * internet — on the local network, where the floor under the bandwidth estimate (`LanFloor`) is
 * never then set, so the estimate starves and the picture is encoded far below the link's means.
 *
 * The host runs on that same local network and can resolve the name (mDNSResponder on macOS,
 * Avahi where it is installed), so it does it here, before the candidate reaches the app. An
 * address that doesn't resolve is passed on as it came: the app will do no worse with it.
 */
export async function resolvedCandidate(sdp: string, resolve: (name: string) => Promise<string> = mdns): Promise<string> {
  const address = candidateAddress(sdp);
  if (!address?.toLowerCase().endsWith(".local")) return sdp;
  try {
    return withCandidateAddress(sdp, await resolve(address));
  } catch {
    return sdp;
  }
}

const mdns = async (name: string) => (await lookup(name, { family: 4 })).address;

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
  private readonly viewers = new Map<WebSocket, () => void>();

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
      return displays.map(({ screen, name, w, h }) => ({ index: screen, screen, name: name || `屏幕 ${screen + 1}`, w, h }));
    }
    if (process.platform !== "linux") throw RpcError.app("not_supported", "这台电脑的系统暂不支持查看屏幕");
    if (!(await hasFfmpeg())) throw RpcError.app("not_supported", "查看屏幕需要电脑上装有 ffmpeg");
    // x11grab captures the X display's root window, which may span several monitors.
    const dimensions = await run("xdpyinfo", [], { timeout: 5000 }).then(({ stdout }) => /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(stdout), () => null);
    return [{ index: 0, name: "屏幕", screen: 0, ...(dimensions ? { w: Number(dimensions[1]), h: Number(dimensions[2]) } : {}) }];
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
      // "hevc": the receiver decodes HEVC (the iOS app's native one); the app offers it first and H.264 after.
      const codec = url.searchParams.get("codec") === "hevc" ? "hevc" : undefined;
      sockets.handleUpgrade(request, socket, head, (ws) => this.stream(ws, Number(url.searchParams.get("display") ?? NaN), relayed, video, width, maxFps, diagnostics, codec));
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
    const supported = macAppSupported() || process.platform === "linux";
    if (process.platform !== "darwin") return { supported, ffmpeg: supported && (await hasFfmpeg()), recording: null, control: null, problem: "controlling the screen needs macOS" };
    const app = inputApp(this.log);
    if (!app) {
      const problem =
        supported
          ? "LinkShell.app is missing from this installation (the optional package @linkshell/mac was not installed): reinstall with `npm install -g linkshell-cli`"
          : "this Mac architecture is not supported";
      return { supported, ffmpeg: false, recording: null, control: null, problem };
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
  private async capture(screen: number, level: number, on: CaptureEvents, profile = fallbackProfile(level), wanted: () => boolean = () => true): Promise<Running | undefined> {
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
      if (!wanted()) return undefined;
      if (!status.recording) {
        // Someone may be at the computer: the app's window for its permissions comes up there.
        void app.ask().catch(() => {});
        on.exit(notAllowed(status.app));
        return undefined;
      }
      let size: number | undefined;
      const stream = await app.stream(screen, profile, {
        frame: (unit, key, generation) => {
          if (ended || !wanted()) return;
          if (size !== undefined && generation !== size) on.resized?.();
          size = generation;
          on.frame(unit, key);
        },
        exit: (error) => {
          leave();
          if (ended || !wanted()) return;
          if (error) this.log(`[screen] the app's capture ended: ${error}`);
          on.exit(!error ? undefined : /permission|not allowed|not authorized|denied|declined/i.test(error) ? notAllowed(status.app) : "屏幕捕获失败");
        },
      });
      const ready = stream.ready.then(({ width, height, fps }) => ({ width, height, maxFps: fps }));
      void ready.catch(() => {});
      return {
        on,
        gone,
        ready,
        end: () => {
          ended = true;
          stream.end();
          leave();
        },
        change: (next, requested) => stream.set(requested ?? rung(next)),
        key: () => stream.key(),
      };
    }
    if (!wanted()) return undefined;
    const capture = spawn("ffmpeg", captureArgs(level, profile), { stdio: ["ignore", "pipe", "pipe"] });
    this.captures.add(capture);
    const splitter = new AccessUnitSplitter();
    let errors = "";
    capture.stdout!.on("data", (chunk: Buffer) => {
      if (!ended && wanted()) splitter.push(chunk, on.frame);
    });
    capture.stderr!.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)));
    const finished = (code: number, said: string) => {
      leave();
      if (ended || !wanted()) return;
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
  private take(screen: number, level: number, on: CaptureEvents, wanted: () => boolean, profile = fallbackProfile(level)): Promise<Running | undefined> {
    const mine = this.turn.then(async () => {
      if (!wanted()) return undefined;
      this.video?.taken();
      const previous = this.holder;
      if (previous) {
        this.holder = undefined;
        previous.end();
        // Another device's picture ends here; a viewer changing its own just carries on.
        if (previous.on !== on) previous.on.exit("屏幕画面被另一台设备接手了");
        await captureReleased(previous);
      }
      if (!wanted()) return undefined;
      const running = await this.capture(screen, level, on, profile, wanted);
      if (!wanted()) {
        running?.end();
        return undefined;
      }
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
  private async offerVideo(screen: number, maxWidth: number | undefined, maxFps: number | undefined, diagnostics: boolean, codec: "hevc" | undefined, viewer: { closed(): boolean; tell(message: object): void; refuse(message: string): void; lost(): void }): Promise<{ app: HelperApp; id: string; reconfigure: boolean } | "refused" | undefined> {
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
      holder.end();
      holder.on.exit("屏幕画面被另一台设备接手了");
      await captureReleased(holder);
      if (this.holder === holder) this.holder = undefined;
    }
    if (viewer.closed()) return "refused";
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
    await app.offerVideo(id, { screen, iceServers, ...(fps >= 1 && fps <= 120 ? { fps } : {}), ...(maxWidth ? { maxWidth } : {}), ...(maxFps ? { maxFps } : {}), ...(codec ? { codec } : {}) }, (message) => {
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
    if (viewer.closed() || this.video !== mine) {
      app.endVideo(id);
      if (this.video === mine) this.video = undefined;
      return "refused";
    }
    return { app, id, reconfigure: status.videoReconfigure === true };
  }

  private stream(ws: WebSocket, display: number, relayed: boolean, wantsVideo: boolean, width: number | undefined, maxFps?: number, diagnostics = false, codec?: "hevc"): void {
    // Paused viewers still own a session. A new authenticated viewer takes that ownership too.
    for (const [previous, release] of this.viewers) {
      if (previous.readyState === previous.OPEN) previous.send(JSON.stringify({ error: "屏幕画面被另一台设备接手了" }));
      release();
      previous.close();
    }
    let shown = this.displays.find((entry) => entry.index === display) ?? this.displays[0];
    let desired: ScreenConfiguration = { display: shown?.index ?? 0, width: width ?? 1920, maxFps: maxFps === 30 || maxFps === 60 || maxFps === 120 ? maxFps : undefined, paused: false };
    let closed = false;
    const live = () => !closed && ws.readyState === ws.OPEN;
    const tell = (message: object) => { if (live()) ws.send(JSON.stringify(message)); };
    let control: InputControl | undefined;
    let controlRequested = false;
    let inputEnabled = false;
    let generationEnabled = false;
    let inputGeneration = 0;
    let appliedGeneration: number | undefined;
    let revision = 0;
    let lastRequestId = -1;
    let desiredRequestId: number | undefined;
    let helperRequestId = 0;
    type Change = { configuration: ScreenConfiguration; revision: number; requestId?: number; generation?: number };
    let pending: Change | undefined;
    let configuring = false;
    let initialized = false;
    let canConfigure = false;
    let pausedExpiry: ReturnType<typeof setTimeout> | undefined;
    let running: Running | undefined;
    let captureGeneration = 0;
    let video: { app: HelperApp; id: string; reconfigure: boolean } | undefined;
    let signals: Promise<void> = Promise.resolve();
    const best = relayed ? RELAY_LEVEL : 0;
    const pacer = new Pacer(Date.now());
    let level = best;
    let changing = false;
    let lighter = false;
    let askedForKey = 0;
    let wantsKey = true;

    const stopControl = () => {
      inputEnabled = false;
      if (!control) return;
      control.stop();
      this.controls.delete(control);
      control = undefined;
    };
    const startControl = async (preparing = false) => {
      if (!live() || (!inputEnabled && !preparing) || desired.paused || !controlRequested || control) return;
      const at = revision;
      const created = new InputControl({
        // Readiness may arrive while the applied target is still being acknowledged; it is
        // safe to report permissions then, while the independent input gate stays closed.
        state: (state) => { if (control === created && revision === at) tell({ control: state }); },
        cursor: (x, y) => { if (control === created && inputEnabled) tell({ cursor: { x, y } }); },
        posted: (event) => this.log(`[screen] dry run: ${JSON.stringify(event)}`),
      }, this.log);
      control = created;
      this.controls.add(created);
      await created.start(shown?.screen ?? 0);
      if (!live() || control !== created || revision !== at || (!inputEnabled && !preparing)) {
        created.stop();
        this.controls.delete(created);
      }
    };
    const stopRunning = () => {
      captureGeneration += 1;
      const stopped = running;
      running = undefined;
      stopped?.end();
      // ffmpeg can hold the recorder until SIGKILL; the next capture must wait for it.
      if (stopped && this.holder === stopped) void stopped.gone.then(() => { if (this.holder === stopped) this.holder = undefined; });
    };
    const endVideo = () => {
      if (!video) return;
      const ended = video;
      video = undefined;
      ended.app.endVideo(ended.id);
      if (this.video?.id === ended.id) this.video = undefined;
    };
    const expirePaused = () => {
      if (pausedExpiry) return;
      pausedExpiry = setTimeout(() => {
        pausedExpiry = undefined;
        if (live()) { dispose(); ws.close(1000, "screen retention expired"); }
      }, SCREEN_RETAIN_MS);
      pausedExpiry.unref();
    };
    const resumed = () => {
      if (pausedExpiry) clearTimeout(pausedExpiry);
      pausedExpiry = undefined;
    };
    const capabilities = () => tell({ session: { t: "capabilities", version: 1, configure: canConfigure, pause: video ? video.reconfigure : true, retainMs: SCREEN_RETAIN_MS } });
    const failure = (error: unknown) => {
      if (!live()) return;
      this.log(`[screen] the capture did not start: ${String(error)}`);
      tell({ error: "屏幕捕获失败" });
      dispose();
      ws.close();
    };
    const askForKey = () => {
      if (!live() || desired.paused || configuring) return;
      const now = Date.now();
      if (!running?.key || now - askedForKey < 500 || !pacer.needsKey(now)) return;
      askedForKey = now;
      running.key();
    };
    let reminder: ReturnType<typeof setInterval> | undefined;
    const stopReminder = () => { if (reminder) clearInterval(reminder); reminder = undefined; };
    const startReminder = () => { if (!reminder) reminder = setInterval(askForKey, 500); };
    startReminder();
    const events: CaptureEvents = {
      frame: (unit, key) => {
        if (!live() || desired.paused) return;
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
        const advice = changing || configuring ? undefined : pacer.advice(now, level > best, level < LADDER.length - 1);
        if (advice) void changeLevel(level + (advice === "down" ? 1 : -1));
      },
      resized: () => tell({ restart: true, level, lighter }),
      exit: (message) => { if (message) tell({ error: message }); dispose(); ws.close(); },
    };
    const begin = async (at: number, target: Capturable | undefined, configuration: ScreenConfiguration) => {
      const captureAt = ++captureGeneration;
      const wanted = () => live() && revision === at && captureGeneration === captureAt && !desired.paused && !video;
      const scoped: CaptureEvents = {
        frame: (unit, key) => { if (wanted()) events.frame(unit, key); },
        resized: () => { if (wanted()) events.resized?.(); },
        exit: (message) => { if (wanted()) events.exit(message); },
      };
      const started = await this.take(target?.screen ?? 0, level, scoped, wanted, fallbackProfile(level, configuration));
      if (!wanted()) {
        if (this.holder === started) this.holder = undefined;
        started?.end();
      }
      else {
        running = started;
        if (started?.ready) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const size = await Promise.race([started.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("屏幕捕获启动超时")), 15_000); timer.unref(); })]);
            if (wanted()) return size;
          } catch (error) { if (wanted()) throw error; }
          finally { if (timer) clearTimeout(timer); }
        }
      }
      return undefined;
    };
    const changeLevel = async (next: number) => {
      if (!live() || desired.paused || configuring || changing) return;
      changing = true;
      lighter = next > level;
      level = next;
      if (running?.change) {
        running.change(next, fallbackProfile(next, desired));
        pacer.changed(Date.now());
      } else {
        stopRunning();
        tell({ restart: true, level, lighter });
        await begin(revision, shown, desired).catch(failure);
        pacer.restarted(Date.now());
      }
      changing = false;
    };
    const current = (change: Change) => live() && revision === change.revision;
    const drain = async () => {
      if (!initialized || configuring || !live()) return;
      configuring = true;
      try {
        while (pending && live()) {
          const change = pending;
          pending = undefined;
          const configuration = change.configuration;
          try {
            if (!canConfigure && change.requestId !== undefined) throw new Error("电脑上的屏幕组件不支持保留连接，请重新连接");
            // A monitor may have been unplugged since screen.start listed it.
            const displays = await this.listDisplays();
            if (!current(change)) continue;
            this.displays = displays;
            const target = displays.find((entry) => entry.index === configuration.display);
            if (!target) throw new Error("所选屏幕已不可用，请选择其他屏幕");
            let applied: VideoConfigured;
            if (video) {
              if (!video.reconfigure) {
                // An old helper cannot stop capture without closing its peer connection.
                if (configuration.paused) { dispose(); ws.close(); return; }
                throw new Error("电脑上的屏幕组件不支持保留连接，请重新连接");
              }
              applied = await video.app.configureVideo(video.id, {
                requestId: ++helperRequestId, screen: target.screen, maxWidth: configuration.width,
                ...(configuration.maxFps === undefined ? {} : { maxFps: configuration.maxFps }), paused: configuration.paused,
                ...(change.generation === undefined ? {} : { inputGeneration: change.generation }),
              });
              if (applied.screen !== target.screen || applied.paused !== configuration.paused || (change.generation !== undefined && applied.generation !== change.generation)) {
                throw new Error("电脑返回的屏幕设置无效，请重试");
              }
            } else {
              const profile = fallbackProfile(level, configuration);
              let size = !target.w || !target.h ? { width: 0, height: 0 } : fallbackSize(target, profile);
              let fps = profile.fps;
              if ((!size.width || !size.height) && change.requestId !== undefined) throw new Error("无法读取当前屏幕尺寸，请重新连接");
              stopRunning();
              if (!configuration.paused) {
                wantsKey = true;
                pacer.restarted(Date.now());
                tell({ restart: true, level, lighter: false });
                const started = await begin(change.revision, target, configuration);
                if (started) { size = started; fps = started.maxFps; }
              }
              applied = { screen: target.screen, ...size, maxFps: fps, paused: configuration.paused, generation: change.generation };
            }
            if (!current(change)) continue;
            shown = target;
            appliedGeneration = change.generation;
            if (!configuration.paused) await startControl(true);
            if (!current(change)) continue;
            inputEnabled = !configuration.paused;
            if (!configuration.paused) { resumed(); startReminder(); }
            if (change.requestId !== undefined) tell({ session: {
              t: "configured", requestId: change.requestId, display: target.index, width: applied.width, height: applied.height,
              maxFps: applied.maxFps, paused: applied.paused,
              ...(applied.generation === undefined ? {} : { generation: applied.generation }),
            } });
          } catch (error) {
            if (!current(change)) continue;
            stopControl();
            if (!video) stopRunning();
            this.log(`[screen] configuration failed: ${String(error)}`);
            if (change.requestId !== undefined) tell({ session: { t: "error", requestId: change.requestId, message: "屏幕设置未能应用，请重试" } });
            else if (configuration.paused) { dispose(); ws.close(); }
          }
        }
      } finally { configuring = false; }
    };
    const configure = (configuration: ScreenConfiguration, requestId?: number) => {
      desired = configuration;
      if (requestId !== undefined) { generationEnabled = true; desiredRequestId = requestId; }
      const at = ++revision;
      pending = { configuration, revision: at, requestId, ...(generationEnabled ? { generation: ++inputGeneration } : {}) };
      stopControl();
      if (configuration.paused) { stopReminder(); stopRunning(); expirePaused(); }
      void drain();
    };
    const startFallback = () => {
      endVideo();
      if (!live()) return;
      tell({ rtc: { t: "off" } });
      canConfigure = !!shown?.w && !!shown?.h;
      initialized = true;
      capabilities();
      if (pending || desiredRequestId !== undefined || desired.paused) {
        configure(desired, desiredRequestId);
      } else {
        const at = revision;
        void begin(at, shown, desired).then(() => {
          if (live() && revision === at && !desired.paused) { inputEnabled = true; void startControl(); }
        }).catch(failure);
      }
    };
    const fallBack = () => { if (video) startFallback(); };

    const dispose = () => {
      if (closed) return;
      closed = true;
      revision += 1;
      pending = undefined;
      stopReminder();
      resumed();
      stopRunning();
      endVideo();
      stopControl();
      this.viewers.delete(ws);
    };
    this.viewers.set(ws, dispose);
    ws.on("close", dispose);
    ws.on("message", (data, binary) => {
      if (binary || !live()) return;
      let message: unknown;
      try { message = JSON.parse(String(data)); } catch { return; }
      const kind = (message as { t?: unknown } | null)?.t;
      if (kind === "screen.configure") {
        const parsed = screenConfiguration.safeParse(message);
        if (!parsed.success || !this.displays.some((entry) => entry.index === parsed.data.display)) {
          const requestId = (message as { requestId?: unknown }).requestId;
          tell({ session: { t: "error", ...(typeof requestId === "number" && Number.isSafeInteger(requestId) && requestId >= 0 ? { requestId } : {}), message: "屏幕设置无效，请检查屏幕、分辨率和帧率" } });
          return;
        }
        if (parsed.data.requestId <= lastRequestId) return;
        if (initialized && !canConfigure) {
          tell({ session: { t: "error", requestId: parsed.data.requestId, message: "电脑上的屏幕组件不支持保留连接，请重新连接" } });
          return;
        }
        lastRequestId = parsed.data.requestId;
        const { t: _type, requestId, ...configuration } = parsed.data;
        configure(configuration, requestId);
      } else if (kind === "hidden" || kind === "shown") {
        const paused = kind === "hidden";
        if (desired.paused !== paused) configure({ ...desired, paused });
      } else if (kind === "ack") pacer.ack(Number((message as { n?: unknown }).n), Date.now());
      else if (kind === "rtc.answer" || kind === "rtc.ice") {
        const signal = videoSignal.safeParse(message);
        if (!signal.success) return;
        signals = signals.then(async () => {
          const target = video;
          if (!target || !live()) return;
          const data = signal.data;
          const resolved = data.t === "rtc.ice" ? { ...data, candidate: await resolvedCandidate(data.candidate) } : data;
          if (live() && video === target) target.app.signal(target.id, resolved);
        }).catch(() => {});
      } else if (kind === "keyframe") {
        const now = Date.now();
        if (!desired.paused && !configuring && running?.key && now - askedForKey >= 500) { askedForKey = now; running.key(); }
      } else if (kind === "rtc.diagnosis") {
        const { reason, ice } = message as { reason?: unknown; ice?: unknown };
        this.log(`[screen] the video track was given up (${String(reason ?? "no reason").slice(0, 120)}): ${String(ice || "no ICE statistics").slice(0, 300)}`);
      } else if (kind === "rtc.failed") fallBack();
      else if (kind === "ping") tell({ pong: { n: (message as { n?: unknown }).n, at: (message as { at?: unknown }).at, now: Date.now() } });
      else if (kind === "measure") this.log(`[screen] measured: ${screenMeasurementLog(message)}`);
      else if (kind === "control" && !desired.paused) {
        // Requesting control only records intent. Input still needs the applied generation,
        // and startup/configuration must finish before the helper can be joined.
        controlRequested = true;
        void startControl();
      }
      else if (!desired.paused && inputEnabled && (!generationEnabled || (message as { screenGeneration?: unknown } | null)?.screenGeneration === appliedGeneration)) {
        control?.send(message);
      }
    });

    if (wantsVideo) {
      let lostWhileOpening = false;
      void this.offerVideo(shown?.screen ?? 0, width, maxFps, diagnostics, codec, {
        closed: () => !live(), tell,
        refuse: (message) => { tell({ error: message }); dispose(); ws.close(); },
        lost: () => { if (video) fallBack(); else lostWhileOpening = true; },
      }).then((offered) => {
        if (offered === "refused") return;
        if (!live()) { if (offered) offered.app.endVideo(offered.id); return; }
        if (!offered) { startFallback(); return; }
        video = offered;
        if (lostWhileOpening) { startFallback(); return; }
        initialized = true;
        canConfigure = offered.reconfigure;
        capabilities();
        if (pending) void drain();
        else { inputEnabled = true; void startControl(); }
      }).catch(failure);
    } else startFallback();
  }

  stop(): void {
    for (const [viewer, release] of this.viewers) { release(); viewer.close(1000, "host stopped"); }
    this.viewers.clear();
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
