import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { INPUT_HELPER_SOURCE } from "./input-helper.js";

// Controlling the computer from the phone: the screen viewer sends pointer and
// key events down the same socket the picture comes up, and a small helper
// posts them to the system. macOS only, and the system has to allow it
// (Privacy & Security › Accessibility).
//
// A released package carries the helper as LinkShell.app, signed. The host has
// the system open it, which makes it an app of its own: the permission is
// asked for and kept under the name LinkShell, whichever terminal started the
// host and however often the CLI is upgraded. A build without the app (a
// checkout with no signing identity) compiles the same source on first use and
// runs it as the host's child; the permission is then the terminal's.

const run = promisify(execFile);

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
}

const dryRunByDefault = () => process.env.LINKSHELL_INPUT_DRY_RUN === "1";

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
 * The app as it came in the package, made runnable. Packing a package drops
 * the program's permission to run (pnpm stores every file that isn't a `bin`
 * as a plain one): it is given back here, and where the installation can't be
 * written to (a root-owned one), a copy under the user's own directory is used.
 * Neither touches the signature.
 */
export function usableApp(packaged: string, copyTo = join(home(), "LinkShell.app")): string | undefined {
  if (runnable(programOf(packaged))) return packaged;
  try {
    chmodSync(programOf(packaged), 0o755);
    return packaged;
  } catch {
    // Not ours to change: fall through to a copy.
  }
  try {
    const plist = (app: string) => readFileSync(join(app, "Contents/Info.plist"), "utf8");
    if (!existsSync(programOf(copyTo)) || plist(copyTo) !== plist(packaged)) {
      rmSync(copyTo, { recursive: true, force: true });
      cpSync(packaged, copyTo, { recursive: true });
    }
    chmodSync(programOf(copyTo), 0o755);
    return copyTo;
  } catch {
    return undefined;
  }
}

let found: { app: string | undefined } | undefined;

/** The signed app this package was made with, if it was. */
export function shippedApp(): string | undefined {
  if (process.platform !== "darwin" || process.env.LINKSHELL_INPUT_APP === "off") return undefined;
  if (found) return found.app;
  found = { app: undefined };
  // Beside `dist` in a package (the host's own, or the CLI's, which compiles the host in); beside `src` in a checkout.
  for (const relative of ["../../../helper/LinkShell.app", "../helper/LinkShell.app"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(programOf(path))) {
      found.app = usableApp(path);
      break;
    }
  }
  return found.app;
}

function binDir(): string {
  return join(home(), "bin");
}

async function build(log: (message: string) => void): Promise<string> {
  const hash = createHash("sha256").update(INPUT_HELPER_SOURCE).digest("hex").slice(0, 12);
  const dir = binDir();
  const path = join(dir, `input-${hash}`);
  if (existsSync(path)) return path;
  // Asking the `swiftc` shim on a Mac without the tools opens an install dialog there: look first.
  const tools = await run("/usr/bin/xcode-select", ["-p"], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  if (!tools) throw new Error("控制电脑需要 Xcode 命令行工具：在电脑上运行 xcode-select --install 后再试");
  await mkdir(dir, { recursive: true });
  const source = `${path}.swift`;
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(source, INPUT_HELPER_SOURCE);
  try {
    await run("/usr/bin/swiftc", ["-O", "-swift-version", "5", "-o", partial, source], { timeout: 180_000 });
    await rename(partial, path);
  } catch (error) {
    log(`[screen] the input helper did not compile: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`);
    throw new Error("控制组件没能在这台电脑上编译，详情见电脑上的 LinkShell 日志");
  } finally {
    await rm(source, { force: true });
    await rm(partial, { force: true });
  }
  // Helpers built from an earlier version's source.
  for (const name of await readdir(dir).catch(() => [])) {
    if (/^input-[0-9a-f]{12}$/.test(name) && name !== `input-${hash}`) await rm(join(dir, name), { force: true });
  }
  log("[screen] built the input helper");
  return path;
}

let compiled: Promise<string> | undefined;

/** The helper compiled here; built on first use, once per version of its source. */
export function inputHelper(log: (message: string) => void = () => {}): Promise<string> {
  compiled ??= build(log).catch((error: unknown) => {
    compiled = undefined;
    throw error;
  });
  return compiled;
}

/** The helper to run as this process's child: the app's own program, or the one compiled here. */
function childHelper(log: (message: string) => void, app: string | undefined): Promise<string> {
  return app ? Promise.resolve(programOf(app)) : inputHelper(log);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const message: unknown = JSON.parse(line);
    return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function statusOf(message: Record<string, unknown>): HelperStatus {
  return { trusted: message.trusted === true, recording: message.recording === true, app: typeof message.app === "string" ? message.app : "" };
}

/**
 * What this process itself (so: the host, and the capture it starts) is
 * allowed to do, and under which app's name. `ask` has the system put its
 * question for that permission, and opens the settings page for it.
 */
export async function hostAccess(log: (message: string) => void, ask?: "recording" | "control"): Promise<HelperStatus> {
  const helper = await childHelper(log, shippedApp());
  const { stdout } = await run(helper, [ask ? `--ask-${ask}` : "--status"], { timeout: 15_000 });
  const message = parse(stdout.trim().split("\n").pop() ?? "");
  if (!message) throw new Error("the input helper gave no answer");
  return statusOf(message);
}

// ── The app: one for the whole host, opened by the system ───────────

type Route = (message: Record<string, unknown>) => void;

class HelperApp {
  private server?: Server;
  private socket?: Socket;
  private opening?: Promise<Socket>;
  private status?: HelperStatus;
  private readonly routes = new Map<string, Route>();
  private readonly watchers = new Set<(status: HelperStatus) => void>();
  private waiting: ((status: HelperStatus) => void)[] = [];

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
        execFile("/usr/bin/open", ["-n", "-g", "-a", this.app, "--args", "--connect", path, ...(this.dryRun ? ["--dry-run"] : [])], (error) => {
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
    });
    createInterface({ input: socket }).on("line", (line) => {
      const message = parse(line);
      if (!message) return;
      if (message.t === "status") {
        this.status = statusOf(message);
        for (const waiter of this.waiting.splice(0)) waiter(this.status);
      } else if (message.t === "trusted" && this.status) {
        this.status = { ...this.status, trusted: message.on === true };
        for (const watcher of this.watchers) watcher(this.status);
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
      const answer = new Promise<HelperStatus>((resolve) => this.waiting.push(resolve));
      await this.write({ t: "status" });
      return answer;
    }
    return new Promise<HelperStatus>((resolve) => this.waiting.push(resolve));
  }

  /** The system's dialog and its settings page, for the app. */
  ask(what: "control" | "recording" = "control"): Promise<void> {
    return this.write({ t: what === "recording" ? "ask-recording" : "ask" });
  }

  /**
   * Has the app run a screen capture: as the app's child, the recording is the
   * app's to be allowed. The picture comes down a socket of its own; the
   * returned function ends the capture.
   */
  async capture(exec: string, args: string[], on: { data(chunk: Buffer): void; exit(code: number, errors: string): void }): Promise<() => void> {
    await this.link();
    const id = `capture-${randomBytes(6).toString("hex")}`;
    const path = join(tmpdir(), `linkshell-capture-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
    const server = createServer((socket) => {
      server.close();
      rmSync(path, { force: true });
      socket.on("error", () => {});
      socket.on("data", on.data);
    });
    let over = false;
    this.routes.set(id, (message) => {
      if (over || (message.t !== "captured" && message.t !== "gone")) return;
      over = true;
      this.routes.delete(id);
      server.close();
      rmSync(path, { force: true });
      on.exit(typeof message.code === "number" ? message.code : -1, typeof message.errors === "string" ? message.errors : "");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        chmodSync(path, 0o600);
        resolve();
      });
    });
    await this.write({ t: "capture", v: id, exec, args, socket: path });
    return () => {
      if (!over && this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ t: "stop", v: id })}\n`);
    };
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
    /** `app: false` keeps to a child process even when the package has the app (tests). */
    private readonly options: { dryRun?: boolean; app?: boolean } = {},
  ) {}

  /** Starts the helper for the display ffmpeg calls "Capture screen `screen`". Reports through the listener; never throws. */
  async start(screen: number): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (process.platform !== "darwin") {
      this.listener.state({ available: false, reason: "暂时只能控制 macOS 电脑" });
      return;
    }
    const dryRun = this.options.dryRun ?? dryRunByDefault();
    const app = this.options.app === false ? undefined : shippedApp();
    if (app) {
      try {
        await this.joinApp(helperApp(app, dryRun, this.log), screen);
        return;
      } catch (error) {
        // The app's own program still works as a child of the host: the permission is then the terminal's.
        this.log(`[screen] ${(error as Error).message}; controlling as the host's own process instead`);
      }
    }
    let path: string;
    try {
      path = await childHelper(this.log, app);
    } catch (error) {
      this.listener.state({ available: false, reason: (error as Error).message });
      return;
    }
    if (this.stopped) return;
    this.spawn(path, screen, dryRun);
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
