import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";
import { INPUT_HELPER_SOURCE } from "./input-helper.js";

// Controlling the computer from the phone: the screen viewer sends pointer and
// key events down the same socket the picture comes up, and a small helper
// posts them to the system. macOS only; the helper needs the Accessibility
// permission, which the system grants to whatever started the host (the
// terminal, as with Screen Recording).

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

export type ControlState = { available: true; trusted: boolean } | { available: false; reason: string };

export interface InputListener {
  state(state: ControlState): void;
  /** Where the pointer is, when something other than this viewer moved it. */
  cursor(x: number, y: number): void;
  /** Dry runs only: the event that would have been posted. */
  posted?(event: Record<string, unknown>): void;
}

function binDir(): string {
  return join(process.env.LINKSHELL_HOME || join(homedir(), ".linkshell"), "bin");
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

let helper: Promise<string> | undefined;

/** The compiled helper's path; built on first use, once per version of its source. */
export function inputHelper(log: (message: string) => void = () => {}): Promise<string> {
  helper ??= build(log).catch((error: unknown) => {
    helper = undefined;
    throw error;
  });
  return helper;
}

/** One viewer's control of one display. */
export class InputControl {
  private child?: ChildProcess;
  private stopped = false;

  constructor(
    private readonly listener: InputListener,
    private readonly log: (message: string) => void,
    private readonly options: { dryRun?: boolean } = {},
  ) {}

  /** Starts the helper for the display ffmpeg calls "Capture screen `screen`". Reports through the listener; never throws. */
  async start(screen: number): Promise<void> {
    if (this.child || this.stopped) return;
    if (process.platform !== "darwin") {
      this.listener.state({ available: false, reason: "暂时只能控制 macOS 电脑" });
      return;
    }
    let path: string;
    try {
      path = await inputHelper(this.log);
    } catch (error) {
      this.listener.state({ available: false, reason: (error as Error).message });
      return;
    }
    if (this.child || this.stopped) return;
    const dryRun = this.options.dryRun ?? process.env.LINKSHELL_INPUT_DRY_RUN === "1";
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
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.t === "ready") this.listener.state({ available: true, trusted: message.trusted === true });
      else if (message.t === "trusted") this.listener.state({ available: true, trusted: message.v === true });
      else if (message.t === "cursor" && typeof message.x === "number" && typeof message.y === "number") this.listener.cursor(message.x, message.y);
      else if (message.t === "posted") this.listener.posted?.(message);
    });
  }

  /** Passes on one event from the viewer; anything that is not one is dropped. */
  send(raw: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    const parsed = inputEvent.safeParse(raw);
    if (parsed.success) stdin.write(`${JSON.stringify(parsed.data)}\n`);
  }

  /** Ends the helper; on its way out it lets go of any button still held. */
  stop(): void {
    this.stopped = true;
    this.child?.stdin?.end();
    const child = this.child;
    if (child) setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1000).unref();
    this.child = undefined;
  }
}
