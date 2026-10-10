import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

// LinkShell.app, the Mac side of the screen (apps/mac): it captures and sends
// the picture, and posts the viewer's pointer and key events to the system.
// macOS only, and the system has to allow both (Privacy & Security › Screen
// Recording, Accessibility).
//
// The host has the system open the app, which makes it an app of its own: the
// permissions are asked for and kept under the name LinkShell, whichever
// terminal started the host and however often the CLI is upgraded. It comes
// in `@linkshell/mac`, installed with the host on a Mac.

const unit = z.number().min(0).max(1);
const button = z.enum(["left", "right"]);
const modifiers = z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).max(4).optional();
const clicks = z.number().int().min(1).max(3).optional();
const delta = z.number().finite();

/** What a viewer may ask the helper to do. Positions are fractions of the display being watched. */
export const inputEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("move"), x: unit, y: unit }),
  z.object({ t: z.literal("down"), b: button, n: clicks, m: modifiers }),
  z.object({ t: z.literal("up"), b: button, n: clicks, m: modifiers }),
  z.object({ t: z.literal("scroll"), dx: delta, dy: delta, m: modifiers }),
  z.object({ t: z.literal("key"), k: z.string().min(1).max(16), m: modifiers }),
  z.object({ t: z.literal("text"), s: z.string().min(1).max(4000) }),
  /** Have the system ask, on the computer, for the permission to control it. */
  z.object({ t: z.literal("prompt") }),
]);
export type InputEvent = z.infer<typeof inputEvent>;

/** `app` is the name the system's privacy settings list: the one to allow. */
export type ControlState = { available: true; trusted: boolean; app?: string } | { available: false; reason: string };

export interface InputListener {
  state(state: ControlState): void;
  /** Where the pointer is, when something other than this viewer moved it. */
  cursor(x: number, y: number): void;
  /** Dry runs only: the event that would have been posted. */
  posted?(event: Record<string, unknown>): void;
}

/** What the helper says of itself: what it may do, and under which app's name. */
export interface HelperStatus {
  trusted: boolean;
  recording: boolean;
  app: string;
  /** The app can send the screen as a video track (it carries the media engine). */
  video: boolean;
  preview: boolean;
}

/** A display as the app sees it. `screen` is its number in everything said to the app. */
export interface AppDisplay {
  screen: number;
  name: string;
  /** In pixels. */
  w: number;
  h: number;
  main: boolean;
}

/** The picture asked of the app for a pipe that loses nothing: rates in bits a second. */
export interface StreamProfile {
  width: number;
  fps: number;
  bitrate: number;
  ceiling: number;
}

/** A stream under way. */
export interface AppStream {
  /** Another profile, without stopping: a new size starts a new generation, at a keyframe. */
  set(profile: StreamProfile): void;
  /** The next frame a keyframe. */
  key(): void;
  end(): void;
}

/** How the app is to offer a screen as a video track. */
export interface VideoOffer {
  /** Which of the system's displays. */
  screen: number;
  iceServers: { urls: string[] }[];
  /** Frames a second; the app's own choice when left out. */
  fps?: number;
  /** Receiver ceiling; adaptation remains enabled. Older helpers safely ignore it. */
  maxFps?: number;
  /** The widest the picture may be, in pixels; the app's own choice (1920) when left out. */
  maxWidth?: number;
}

/** What a viewer answers the app's offer with, and the candidates it finds. */
export type VideoSignal =
  | { t: "rtc.answer"; sdp: string }
  | { t: "rtc.ice"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

const line = z.string().max(64_000);
export const videoSignal = z.discriminatedUnion("t", [
  z.object({ t: z.literal("rtc.answer"), sdp: line }),
  z.object({ t: z.literal("rtc.ice"), candidate: z.string().max(2000), sdpMid: z.string().max(64).nullable(), sdpMLineIndex: z.number().int().min(0).max(64).nullable() }),
]);

const dryRunByDefault = () => process.env.LINKSHELL_INPUT_DRY_RUN === "1";
/** Measuring latency: the app shows a clock on the screen it sends, which the viewer page reads back (`?measure=1`). */
const measuring = () => process.env.LINKSHELL_SCREEN_CLOCK === "1";

// ── Where the helper is ─────────────────────────────────────────────

const home = () => process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");
const programOf = (app: string) => join(app, "Contents/MacOS/LinkShell");

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app out of the archive it is shipped in, unpacked under the user's own
 * directory. An archive, because a package can carry neither the links a
 * framework is made of nor a program's permission to run; unpacked whole, the
 * app is as it was signed. Always at the same place, so that an upgrade
 * replaces the app instead of adding another: macOS has been seen to ask
 * about recording again for the same app run from a new path. (A host still
 * running the app being replaced keeps the one it has open.)
 */
export function unpackedApp(archive: string, at = join(home(), "LinkShell.app")): string | undefined {
  try {
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const mark = `${at}.unpacked`;
    const current = () => existsSync(mark) && readFileSync(mark, "utf8").trim() === hash && runnable(programOf(at));
    if (current()) return at;
    const partial = `${at}.${process.pid}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", partial], { stdio: "ignore", timeout: 60_000 });
    // Another host may have done the same meanwhile: its app is this one.
    if (!current()) {
      const old = `${at}.${process.pid}.old`;
      rmSync(mark, { force: true });
      if (existsSync(at)) renameSync(at, old);
      renameSync(join(partial, "LinkShell.app"), at);
      writeFileSync(mark, hash);
      rmSync(old, { recursive: true, force: true });
    }
    rmSync(partial, { recursive: true, force: true });
    return runnable(programOf(at)) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** The app from `@linkshell/mac`: as built, in a checkout; out of its archive, in an installation. */
function packagedApp(): string | undefined {
  let root: string;
  try {
    root = dirname(createRequire(import.meta.url).resolve("@linkshell/mac/package.json"));
  } catch {
    // Not a Mac, or installed without optional packages.
    return undefined;
  }
  const built = join(root, "build/LinkShell.app");
  if (runnable(programOf(built))) return built;
  const archive = join(root, "build/LinkShell.app.tar.gz");
  return existsSync(archive) ? unpackedApp(archive) : undefined;
}

let found: { app: string | undefined } | undefined;

/** The universal app ships both native Mac architectures (Node calls x86_64 "x64"). */
export function macAppSupported(): boolean {
  return process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64");
}

/** LinkShell.app, with `@linkshell/mac` installed beside the host. */
export function shippedApp(): string | undefined {
  if (!macAppSupported() || process.env.LINKSHELL_INPUT_APP === "off") return undefined;
  found ??= { app: packagedApp() };
  return found.app;
}

/** The optional package may have been omitted on either Mac architecture. */
export const NO_APP = "这次安装缺少 LinkShell.app（可选组件没有装上）。重新安装一次即可：npm install -g linkshell-cli";

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const message: unknown = JSON.parse(line);
    return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function statusOf(message: Record<string, unknown>): HelperStatus {
  return {
    trusted: message.trusted === true,
    recording: message.recording === true,
    app: typeof message.app === "string" ? message.app : "",
    video: message.video === true,
    preview: message.preview === true,
  };
}

// ── The app: one for the whole host, opened by the system ───────────

const RECORD_HEAD = 6;
/**
 * A keyframe is made when one is needed (a viewer coming back from having fallen behind asks), not
 * by the clock: each costs as much as seconds of ordinary frames. This is only what a stream is
 * never without for longer, should a request go astray.
 */
const STREAM_GOP_SECONDS = 10;
/** No frame is this large: a length beyond it is not a record. */
const RECORD_MAX = 16 * 1024 * 1024;

function displaysOf(list: unknown): AppDisplay[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const display = entry as Partial<Record<keyof AppDisplay, unknown>> | null;
    if (!display || typeof display.screen !== "number" || !Number.isInteger(display.screen) || display.screen < 0) return [];
    return [
      {
        screen: display.screen,
        name: typeof display.name === "string" ? display.name.slice(0, 80) : "",
        w: typeof display.w === "number" ? display.w : 0,
        h: typeof display.h === "number" ? display.h : 0,
        main: display.main === true,
      },
    ];
  });
}

type Route = (message: Record<string, unknown>) => void;

class HelperApp {
  private server?: Server;
  private socket?: Socket;
  private opening?: Promise<Socket>;
  private status?: HelperStatus;
  private readonly routes = new Map<string, Route>();
  private readonly watchers = new Set<(status: HelperStatus) => void>();
  private waiting: { resolve(status: HelperStatus): void; reject(error: Error): void }[] = [];
  private listing: ((displays: AppDisplay[]) => void)[] = [];

  constructor(
    private readonly app: string,
    private readonly dryRun: boolean,
    private readonly log: (message: string) => void,
  ) {}

  /** The app's end of the socket; opens the app when it isn't there. */
  private link(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private open(): Promise<Socket> {
    // The app comes to us: a socket only this user can reach, in a directory of its own name.
    const path = join(tmpdir(), `linkshell-input-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
    return new Promise<Socket>((resolve, reject) => {
      const server = createServer();
      const fail = (error: Error) => {
        clearTimeout(timer);
        server.close();
        rmSync(path, { force: true });
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("LinkShell.app did not start")), 15_000);
      server.once("error", fail);
      server.once("connection", (socket) => {
        clearTimeout(timer);
        // One app, one connection: nothing else gets in.
        server.close();
        rmSync(path, { force: true });
        this.server = undefined;
        this.adopt(socket);
        resolve(socket);
      });
      server.listen(path, () => {
        chmodSync(path, 0o600);
        // Opened by the system, not started as a child: that is what makes it an app of its own to the privacy settings.
        execFile("/usr/bin/open", ["-n", "-g", "-a", this.app, "--args", "--connect", path, ...(this.dryRun ? ["--dry-run"] : []), ...(measuring() ? ["--clock"] : [])], (error) => {
          if (error) fail(new Error(`LinkShell.app could not be opened: ${error.message}`));
        });
      });
      this.server = server;
    });
  }

  private adopt(socket: Socket): void {
    this.socket = socket;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.status = undefined;
      // The app went (quit, or crashed): each viewer hears it, and the next one to ask opens it again.
      for (const route of this.routes.values()) route({ t: "gone" });
      this.routes.clear();
      for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("LinkShell.app went before it answered"));
    });
    createInterface({ input: socket }).on("line", (line) => {
      const message = parse(line);
      if (!message) return;
      if (message.t === "status") {
        const before = this.status;
        this.status = statusOf(message);
        for (const waiter of this.waiting.splice(0)) waiter.resolve(this.status);
        // Recording was just allowed: the process that was running before it was can't count on the
        // system letting it record. With nobody using it, it is let go; the next use opens it afresh.
        if (before && !before.recording && this.status.recording && this.routes.size === 0) socket.destroy();
      } else if (message.t === "trusted" && this.status) {
        this.status = { ...this.status, trusted: message.on === true };
        for (const watcher of this.watchers) watcher(this.status);
      } else if (message.t === "log") {
        this.log(`[app] ${String(message.message).slice(0, 2000)}`);
      } else if (message.t === "displays") {
        const displays = displaysOf(message.list);
        for (const waiter of this.listing.splice(0)) waiter(displays);
      } else if (typeof message.v === "string") {
        this.routes.get(message.v)?.(message);
      }
    });
  }

  private async write(message: object): Promise<void> {
    const socket = await this.link();
    socket.write(`${JSON.stringify(message)}\n`);
  }

  /** What the app may do. It says so as it connects; asked again, it looks again. */
  async access(): Promise<HelperStatus> {
    await this.link();
    if (this.status) {
      const answer = new Promise<HelperStatus>((resolve, reject) => this.waiting.push({ resolve, reject }));
      await this.write({ t: "status" });
      return answer;
    }
    return new Promise<HelperStatus>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  /** The displays there are to watch. */
  async displays(): Promise<AppDisplay[]> {
    await this.link();
    const answer = new Promise<AppDisplay[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("LinkShell.app did not list the displays")), 8000);
      this.listing.push((displays) => {
        clearTimeout(timer);
        resolve(displays);
      });
    });
    await this.write({ t: "displays" });
    return answer;
  }

  /**
   * Has the app capture a screen and encode it for a pipe that loses nothing:
   * the socket to a viewer it couldn't reach directly. Whole frames come to
   * `on.frame`, each with the generation of picture size it belongs to.
   */
  async stream(
    screen: number,
    profile: StreamProfile,
    on: { frame(unit: Buffer, key: boolean, generation: number): void; exit(error?: string): void },
  ): Promise<AppStream> {
    await this.link();
    const id = `stream-${randomBytes(6).toString("hex")}`;
    const path = join(tmpdir(), `linkshell-stream-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
    let over = false;
    let pending: Buffer = Buffer.alloc(0);
    const server = createServer((socket) => {
      server.close();
      rmSync(path, { force: true });
      socket.on("error", () => {});
      // Records: length (4 bytes), flags (bit 0: keyframe), generation, then that many bytes of one frame.
      socket.on("data", (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= RECORD_HEAD) {
          const length = pending.readUInt32BE(0);
          if (length > RECORD_MAX) {
            socket.destroy();
            return;
          }
          if (pending.length < RECORD_HEAD + length) break;
          if (!over) on.frame(pending.subarray(RECORD_HEAD, RECORD_HEAD + length), (pending[4]! & 1) === 1, pending[5]!);
          pending = pending.subarray(RECORD_HEAD + length);
        }
      });
    });
    const tellApp = (message: object) => {
      if (!over && this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ ...message, v: id })}\n`);
    };
    const finish = () => {
      over = true;
      this.routes.delete(id);
      server.close();
      rmSync(path, { force: true });
    };
    this.routes.set(id, (message) => {
      if (over || (message.t !== "stream.ended" && message.t !== "gone")) return;
      finish();
      on.exit(typeof message.error === "string" ? message.error : message.t === "gone" ? "LinkShell.app went" : undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        chmodSync(path, 0o600);
        resolve();
      });
    });
    await this.write({ t: "stream.open", v: id, screen, socket: path, gop: STREAM_GOP_SECONDS, ...profile });
    return {
      set: (next) => tellApp({ t: "stream.set", ...next }),
      key: () => tellApp({ t: "stream.key" }),
      end: () => {
        if (over) return;
        tellApp({ t: "stream.close" });
        finish();
      },
    };
  }

  /**
   * Opens LinkShell's own window for its permissions, on this computer: it says
   * what each is for, has the system ask, takes the user to the switch, and
   * ticks each off as it is turned on. Nothing appears when both are allowed
   * already, and there is only ever one such window.
   */
  ask(): Promise<void> {
    return new Promise((resolve, reject) =>
      execFile("/usr/bin/open", ["-n", "-a", this.app, "--args", "--setup", "--quiet-if-done"], (error) => (error ? reject(error) : resolve())),
    );
  }

  /**
   * Has the app offer a screen to one viewer as a video track. What the app
   * says of it (`rtc.offer`, `rtc.ice`, `rtc.state`, `rtc.error`, and `gone`
   * when the app itself went) comes to `route`; the viewer's answer goes back
   * with `signal`. The picture and the viewer's hands then travel between the
   * two of them, not through here.
   */
  async offerVideo(id: string, offer: VideoOffer, route: Route): Promise<void> {
    this.routes.set(id, route);
    await this.write({ t: "rtc.open", v: id, ...offer });
  }

  async preview(id: string, target: { bundleId: string; title?: string; app?: boolean }, route: Route): Promise<void> {
    this.routes.set(id, route);
    await this.write({ t: "preview.open", v: id, ...target });
  }

  endPreview(id: string): void {
    this.routes.delete(id);
    if (this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ t: "preview.close", v: id })}\n`);
  }

  signal(id: string, signal: VideoSignal): void {
    if (this.socket && !this.socket.destroyed && this.routes.has(id)) this.socket.write(`${JSON.stringify({ ...signal, v: id })}\n`);
  }

  endVideo(id: string): void {
    if (!this.routes.delete(id)) return;
    if (this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ t: "rtc.close", v: id })}\n`);
  }

  async join(id: string, screen: number, route: Route, watcher: (status: HelperStatus) => void): Promise<void> {
    this.routes.set(id, route);
    this.watchers.add(watcher);
    await this.write({ t: "open", v: id, screen });
  }

  send(id: string, event: InputEvent): void {
    if (this.socket && !this.socket.destroyed && this.routes.has(id)) this.socket.write(`${JSON.stringify({ ...event, v: id })}\n`);
  }

  leave(id: string, watcher: (status: HelperStatus) => void): void {
    this.watchers.delete(watcher);
    if (!this.routes.has(id)) return;
    if (this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ t: "close", v: id })}\n`);
    // What the app says as it lets go (a dry run's last report) still finds its viewer.
    setTimeout(() => this.routes.delete(id), 1000).unref();
  }

  /** The host is going: the app leaves when its socket closes. */
  close(): void {
    this.server?.close();
    this.socket?.destroy();
  }
}

let shared: HelperApp | undefined;

function helperApp(app: string, dryRun: boolean, log: (message: string) => void): HelperApp {
  shared ??= new HelperApp(app, dryRun, log);
  return shared;
}

/** Ends the helper app, if this process opened one. */
export function closeInputApp(): void {
  shared?.close();
  shared = undefined;
}

/** The signed app, opened when it isn't yet; undefined where the package has none. */
export function inputApp(log: (message: string) => void): HelperApp | undefined {
  const app = shippedApp();
  return app ? helperApp(app, dryRunByDefault(), log) : undefined;
}
/** A separate process: preview failures must not terminate normal screen sharing or input. */
export function previewApp(log: (message: string) => void): HelperApp | undefined {
  const app = shippedApp();
  return app ? new HelperApp(app, false, log) : undefined;
}
export type { HelperApp };

// ── One viewer's control of one display ─────────────────────────────

export class InputControl {
  private child?: ChildProcess;
  private joined?: { app: HelperApp; id: string; watcher: (status: HelperStatus) => void };
  private stopped = false;
  private started = false;

  constructor(
    private readonly listener: InputListener,
    private readonly log: (message: string) => void,
    /** `app: false` runs the app's program as this process's child instead of having the system open it (tests). */
    private readonly options: { dryRun?: boolean; app?: boolean } = {},
  ) {}

  /** Starts control of the display the app numbers `screen`. Reports through the listener; never throws. */
  async start(screen: number): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (process.platform !== "darwin") {
      this.listener.state({ available: false, reason: "暂时只能控制 macOS 电脑" });
      return;
    }
    const dryRun = this.options.dryRun ?? dryRunByDefault();
    const app = shippedApp();
    if (!app) {
      this.listener.state({ available: false, reason: NO_APP });
      return;
    }
    if (this.options.app !== false) {
      try {
        await this.joinApp(helperApp(app, dryRun, this.log), screen);
        return;
      } catch (error) {
        // The app's own program still works as a child of the host: the permission is then the terminal's.
        this.log(`[screen] ${(error as Error).message}; controlling as the host's own process instead`);
      }
    }
    if (this.stopped) return;
    this.spawn(programOf(app), screen, dryRun);
  }

  private async joinApp(app: HelperApp, screen: number): Promise<void> {
    const id = randomBytes(6).toString("hex");
    let named = "";
    const watcher = (status: HelperStatus) => this.listener.state({ available: true, trusted: status.trusted, app: named || status.app });
    await app.join(
      id,
      screen,
      (message) => {
        if (message.t === "ready") {
          named = typeof message.app === "string" ? message.app : "";
          this.listener.state({ available: true, trusted: message.trusted === true, app: named });
        } else if (message.t === "gone") {
          this.joined = undefined;
          this.started = false;
          this.listener.state({ available: false, reason: "电脑上的 LinkShell 控制组件退出了，重新选择控制方式即可" });
        } else this.heard(message);
      },
      watcher,
    );
    this.joined = { app, id, watcher };
    if (this.stopped) this.stop();
  }

  private spawn(path: string, screen: number, dryRun: boolean): void {
    const child = spawn(path, [String(screen), ...(dryRun ? ["--dry-run"] : [])], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    child.on("error", (error) => {
      this.log(`[screen] the input helper did not start: ${error.message}`);
      this.listener.state({ available: false, reason: "控制组件没能启动" });
    });
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
    });
    // The viewer going away mid-write is not an error worth a crash.
    child.stdin!.on("error", () => {});
    let named = "";
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const message = parse(line);
      if (!message) return;
      if (message.t === "ready") {
        named = typeof message.app === "string" ? message.app : "";
        this.listener.state({ available: true, trusted: message.trusted === true, app: named });
      } else if (message.t === "trusted") this.listener.state({ available: true, trusted: message.on === true, app: named });
      else this.heard(message);
    });
  }

  private heard(message: Record<string, unknown>): void {
    if (message.t === "cursor" && typeof message.x === "number" && typeof message.y === "number") this.listener.cursor(message.x, message.y);
    else if (message.t === "posted") this.listener.posted?.(message);
  }

  /** Passes on one event from the viewer; anything that is not one is dropped. */
  send(raw: unknown): void {
    const parsed = inputEvent.safeParse(raw);
    if (!parsed.success) return;
    if (this.joined) {
      // Asking opens the settings too, which the app does for itself.
      if (parsed.data.t === "prompt") void this.joined.app.ask().catch(() => {});
      else this.joined.app.send(this.joined.id, parsed.data);
      return;
    }
    const stdin = this.child?.stdin;
    if (stdin?.writable) stdin.write(`${JSON.stringify(parsed.data)}\n`);
  }

  /** Ends this viewer's control; on its way out the helper lets go of any button still held. */
  stop(): void {
    this.stopped = true;
    if (this.joined) {
      this.joined.app.leave(this.joined.id, this.joined.watcher);
      this.joined = undefined;
    }
    this.child?.stdin?.end();
    const child = this.child;
    if (child) setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1000).unref();
    this.child = undefined;
  }
}
