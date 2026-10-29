import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One entry of the menu bar item's menu. */
export type MenuBarEntry = { id: string; label: string } | { separator: true };

/** What the menu bar process reports: a click on an entry, or LinkShell opened again with it in front. */
export type MenuBarEvent = { t: "click"; id: string } | { t: "reopen" };

function openMenuBar(bundle: string, socket: string): void {
  // -n: an instance of its own beside this one; -g: without taking the focus.
  const child = spawn("/usr/bin/open", ["-n", "-g", "-a", bundle, "--args", "--menubar", socket], { stdio: "ignore", detached: true });
  child.on("error", () => { /* Not connecting in time is what counts: it is opened again. */ });
  child.unref();
}

/** The complete lines of `buffer` as the menu bar process's events, and what is left after them. */
export function menuBarEvents(buffer: string): { events: MenuBarEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: MenuBarEvent[] = [];
  for (const line of lines) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    if (!message || typeof message !== "object") continue;
    const { t, id } = message as Record<string, unknown>;
    if (t === "click" && typeof id === "string") events.push({ t, id });
    else if (t === "reopen") events.push({ t });
  }
  return { events, rest };
}

/**
 * The Mac's menu bar item. macOS draws one only for a process running the bundle's main
 * executable, the Swift `LinkShell`; this process is `LinkShell Desktop`, so a Tray made here is
 * never shown. The system opens LinkShell.app again with `--menubar <socket>`, as the Host opens
 * it for the screen; that process shows the menu sent to it and ends when the socket closes.
 */
export class MenuBar {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private menu: { tooltip: string; items: MenuBarEntry[] } = { tooltip: "LinkShell", items: [] };
  private stopped = false;
  private starts = 0;
  private timer?: NodeJS.Timeout;
  readonly path = join(tmpdir(), `linkshell-menubar-${process.pid}-${randomBytes(4).toString("hex")}.sock`);

  constructor(
    private readonly bundle: string,
    private readonly on: (event: MenuBarEvent) => void,
    private readonly log: (message: string) => void,
    private readonly launch: (bundle: string, socket: string) => void = openMenuBar,
  ) {}

  start(): void {
    rmSync(this.path, { force: true });
    this.server = createServer((socket) => this.connected(socket));
    this.server.on("error", (error) => this.log(`[menubar] ${error.message}`));
    this.server.listen(this.path, () => this.open());
  }

  show(tooltip: string, items: MenuBarEntry[]): void {
    this.menu = { tooltip, items };
    for (const socket of this.sockets) this.send(socket);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    rmSync(this.path, { force: true });
  }

  private open(): void {
    if (this.stopped) return;
    this.starts += 1;
    try {
      this.launch(this.bundle, this.path);
    } catch (error) {
      this.log(`[menubar] open: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.retry(15_000);
  }

  /** Opens it again unless it has connected by then; a few times only, each wait longer. */
  private retry(after: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.stopped || this.sockets.size > 0) return;
      if (this.starts >= 5) { this.log("[menubar] the menu bar item did not start"); return; }
      this.open();
    }, after);
  }

  private connected(socket: Socket): void {
    this.sockets.add(socket);
    clearTimeout(this.timer);
    this.send(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const { events, rest } = menuBarEvents(buffer + chunk);
      buffer = rest;
      for (const event of events) this.on(event);
    });
    socket.on("error", () => { /* "close" follows. */ });
    socket.on("close", () => {
      this.sockets.delete(socket);
      // Quit from Activity Monitor, or crashed: the item comes back.
      if (!this.stopped && this.sockets.size === 0) this.retry(1000 * this.starts);
    });
  }

  private send(socket: Socket): void {
    socket.write(`${JSON.stringify({ t: "menu", ...this.menu })}\n`);
  }
}
