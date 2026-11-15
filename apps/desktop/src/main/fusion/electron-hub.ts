import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, nativeImage, screen, shell, type MenuItemConstructorOptions, type WebContents } from "electron";
import { connectFusion, type FusionConnection, type FusionMessage } from "./wire.js";
import { fusionAppId, fusionIconFile, pngToIco } from "./naming.js";

export { fusionAppId, fusionIconFile, pngToIco };

/**
 * The local half of Fusion inside the desktop app (docs/v2/fusion.md §8.1): what `--fusion-local`
 * and its stubs are on a Mac, for Windows (and, with LINKSHELL_FUSION_HUB=electron, a Mac too).
 *
 * The main process speaks the control protocol and owns every window's geometry; a hidden
 * renderer (`fusion.html`) owns the one peer connection and draws each remote window into a
 * frameless window it opened itself (so the video track can go straight into its DOM).
 */
export const FUSION_PROTO = 2;
const RESUME_GRACE_MS = 30_000;
// No `clipboard` yet: syncing it from the desktop app is a follow-up.
const LOCAL_FEATURES = ["keys"];
/** What a taskbar and the app grid need; a Mac's Dock icon (1024) is thirty times the bytes. */
const ICON_PIXELS = 256;

export interface FusionHubOptions {
  computerKey: string;
  name: string;
  slug: string;
  home: string;
  /** Where the hub page is served (the workspace origin, with its capability). */
  pageURL: () => URL | undefined;
  preload: string;
  /** For a stub-less relaunch: LinkShell.exe with these arguments starts Fusion and the app. */
  relaunch: { executable: string; args: (app: string) => string[] };
  /** Start menu folder for this computer's apps (Windows). */
  shortcutDir?: string;
  isTrusted: (url: string) => boolean;
  log: (line: string) => void;
}

interface AppEntry { app: string; name: string; category: string; system: boolean }

interface WindowRecord {
  id: number;
  app: string;
  title: string;
  stream: string;
  /** Local global points. */
  frame: Rect;
  chrome: Record<string, unknown>;
  seq: number;
  ack: number;
  win?: BrowserWindow;
  /** Setting bounds ourselves fires the same events as the person dragging: not a `place`. */
  applying: boolean;
  placeTimer?: ReturnType<typeof setTimeout>;
  /** A resize among the events this pending `place` covers (an edge drag also moves the window). */
  pendingResize: boolean;
  /** The size asked for with `seq`: what the remote's answer is compared with. */
  asked?: { w: number; h: number };
}

interface PopupRecord { id: number; app: string; parent: number; offset: { x: number; y: number }; frame: Rect; layer: number; win?: BrowserWindow }

type Rect = { x: number; y: number; w: number; h: number };

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const rect = (value: unknown): Rect => {
  const r = (value ?? {}) as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) };
};

export class FusionElectronHub {
  private connection?: FusionConnection;
  private page?: BrowserWindow;
  private pageReady = false;
  private pageQueue: FusionMessage[] = [];
  private welcomed = false;
  private connected = false;
  private suspended = false;
  private stopping = false;
  private sessionID?: string;
  private remotePlatform: "macos" | "windows" = "macos";
  private remoteFeatures = new Set<string>();
  private suspendTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private rtt = 0;
  private apps: AppEntry[] = [];
  private windows = new Map<number, WindowRecord>();
  private popups = new Map<number, PopupRecord>();
  private displays: Array<{ index: number; frame: Rect }> = [];
  private alerts = new Map<string, Record<string, unknown>>();
  private iconBundles = new Set<string>();
  private iconRequested = new Set<string>();
  private iconQueue: string[] = [];
  private iconInFlight?: string;
  private iconTimer?: ReturnType<typeof setTimeout>;
  private pendingLaunches: string[] = [];
  private quitting = new Map<string, number>();
  private statusText = "正在初始化融合会话…";
  private exitReason?: { reason: string; message: string };
  private endpoint?: { host: string; port: number; token: string };
  private readonly iconsDir: string;
  onExit?: (reason: string, message: string) => void;

  constructor(private readonly options: FusionHubOptions) {
    this.iconsDir = join(options.home, "fusion-icons", options.slug);
    mkdirSync(this.iconsDir, { recursive: true });
  }

  get running(): boolean { return !this.stopping && (this.connected || this.suspended || !!this.connection); }

  // ── Connection ─────────────────────────────────────────────────────────────

  /** First start, or a fresh token for the same computer (a resume after a drop). */
  connect(host: string, port: number, token: string, launch?: string): void {
    if (launch && !this.pendingLaunches.includes(launch)) this.pendingLaunches.push(launch);
    if (this.connected) {
      for (const app of this.pendingLaunches.splice(0)) this.launchApp(app);
      return;
    }
    this.endpoint = { host, port, token };
    // Detached first: its close must not read as this session ending.
    const old = this.connection;
    this.connection = undefined;
    old?.close("replaced");
    this.ensurePage();
    const connection = connectFusion(host, port, token);
    this.connection = connection;
    connection.onReady = () => {
      connection.startWatchdog(5_000);
      this.hello();
    };
    connection.onMessage = (message) => this.receive(message);
    connection.onClose = (reason) => { if (this.connection === connection) this.closed(reason); };
    this.statusText = `正在连接 ${this.options.name}…`;
  }

  private hello(): void {
    const displays = screen.getAllDisplays().map((display) => ({
      frame: { x: display.bounds.x, y: display.bounds.y, w: display.bounds.width, h: display.bounds.height },
      visible: { x: display.workArea.x, y: display.workArea.y, w: display.workArea.width, h: display.workArea.height },
      scale: display.scaleFactor,
      hz: Math.max(60, display.displayFrequency || 60),
    }));
    const hello: FusionMessage = {
      t: "hello", proto: FUSION_PROTO, token: this.endpoint?.token ?? "", platform: process.platform === "win32" ? "windows" : "macos",
      features: LOCAL_FEATURES, displays, name: hostname(),
    };
    if (this.suspended && this.sessionID) hello.resume = this.sessionID;
    this.send(hello);
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ t: "ping", ts: Date.now() }), 1_500);
    this.pingTimer.unref?.();
  }

  private send(message: FusionMessage): void { this.connection?.send(message); }

  private receive(m: FusionMessage): void {
    if (m.t === "welcome") return this.welcome(m);
    if (m.t === "bye") return this.bye(m);
    if (!this.welcomed) {
      if (m.t === "apps" || m.t === "ready") this.end("proto", "远端 LinkShell 版本较旧，请先升级远端电脑的 LinkShell 后再开启融合模式");
      return;
    }
    switch (m.t) {
      case "apps": return this.catalog(m.apps);
      case "ready": return this.ready(m);
      case "rtc": return this.toPage({ t: "rtc", m: m.m });
      case "wopen": return this.windowOpened(m);
      case "wclose": return this.windowClosed(num(m.id));
      case "wstyle": return this.windowStyle(m);
      case "layout": return this.layout(Array.isArray(m.windows) ? m.windows as FusionMessage[] : []);
      case "fullscreen": return void this.windows.get(num(m.id))?.win?.setFullScreen(m.on !== false);
      case "minimize": return void this.windows.get(num(m.id))?.win?.minimize();
      case "app.hidden":
        for (const record of this.windows.values()) if (record.app === m.app) { if (m.on) record.win?.hide(); else record.win?.showInactive(); }
        return;
      case "app.exited": return this.appExited(String(m.app ?? ""));
      case "icon": return this.icon(m);
      case "menu": return this.menuReply(m);
      case "clip": return; // Clipboard sync on Electron is a follow-up: the remote only sends while armed.
      case "pong": this.rtt = Date.now() - num(m.ts); return;
      case "alert": {
        const key = `${m.kind}:${m.subject ?? ""}`;
        if (m.clear) this.alerts.delete(key);
        else this.alerts.set(key, { kind: m.kind, subject: m.subject, message: m.message, at: Date.now() });
        return;
      }
      default: return;
    }
  }

  private welcome(m: FusionMessage): void {
    if (m.proto !== FUSION_PROTO) return this.end("proto", "远端 LinkShell 版本与本机不一致，请把两台电脑都升级到最新版本后再开启融合模式");
    const resumed = m.resumed === true && this.suspended;
    this.welcomed = true;
    this.sessionID = typeof m.session === "string" ? m.session : undefined;
    this.remotePlatform = m.platform === "windows" ? "windows" : "macos";
    this.remoteFeatures = new Set(Array.isArray(m.features) ? m.features.map(String) : []);
    clearTimeout(this.suspendTimer);
    this.suspended = false;
    this.alerts.delete("reconnecting:");
    if (!resumed) this.dropWindows();
    // A fresh peer connection on either path: the old one belonged to the old control connection.
    this.toPage({ t: "reset", remote: this.remotePlatform, local: process.platform === "win32" ? "windows" : "macos" });
    this.options.log(`[fusion] welcome ${this.sessionID ?? "?"}${resumed ? " (resumed)" : ""}`);
  }

  private bye(m: FusionMessage): void {
    const reason = String(m.reason ?? "stopped");
    this.sessionID = undefined;
    this.suspended = false;
    this.end(reason, typeof m.message === "string" ? m.message : describe(reason));
  }

  private closed(reason: string): void {
    this.connected = false;
    clearInterval(this.pingTimer);
    this.toPage({ t: "pause" });
    if (!this.stopping && (this.welcomed || this.suspended) && this.sessionID && reason !== "proto" && reason !== "token") {
      this.welcomed = false;
      this.statusText = `与 ${this.options.name} 的连接中断，正在重新连接…`;
      this.alerts.set("reconnecting:", { kind: "reconnecting", message: this.statusText, at: Date.now() });
      if (!this.suspended) {
        this.suspended = true;
        this.suspendTimer = setTimeout(() => {
          this.suspended = false;
          this.sessionID = undefined;
          this.end(reason, describe(reason));
        }, RESUME_GRACE_MS + 5_000);
        this.suspendTimer.unref?.();
      }
      this.options.log(`[fusion] connection lost (${reason}): keeping windows for a resume`);
      return;
    }
    this.end(reason, describe(reason));
  }

  /** The session is over: windows go, and the desktop shows why. */
  private end(reason: string, message: string): void {
    this.stopping = true;
    clearTimeout(this.suspendTimer);
    clearInterval(this.pingTimer);
    const connection = this.connection;
    this.connection = undefined;
    connection?.close(reason === "user" ? "bye" : reason);
    this.dropWindows();
    this.page?.destroy();
    this.page = undefined;
    this.exitReason = { reason, message };
    this.statusText = message;
    this.onExit?.(reason, message);
  }

  /** The person ended it here: say `bye` so the remote puts its windows back at once. */
  stop(): void {
    if (this.stopping) return;
    this.send({ t: "bye", reason: "user" });
    const connection = this.connection;
    this.connection = undefined;
    setTimeout(() => connection?.close("bye"), 200).unref?.();
    this.end("stopped", "融合模式已停止");
  }

  // ── Catalog, apps, icons ───────────────────────────────────────────────────

  private catalog(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const parsed = raw.flatMap((item) => {
      const entry = item as Record<string, unknown>;
      return typeof entry.app === "string" && entry.app ? [{ app: entry.app, name: String(entry.name ?? ""), category: String(entry.category ?? ""), system: entry.system === true }] : [];
    });
    if (parsed.length || !this.apps.length) this.apps = parsed;
    writeFileSync(join(this.iconsDir, "catalog.json"), JSON.stringify({
      computerKey: this.options.computerKey, hostLabel: this.options.name, hostSlug: this.options.slug, updatedAt: Date.now(),
      apps: this.apps.map((a) => ({ name: a.name, bundle: a.app, category: a.category, isSystem: a.system })),
    }));
    for (const entry of this.apps) this.requestIcon(entry.app);
    // What was still queued when the last connection dropped goes on from here.
    this.requestNextIcon();
  }

  /**
   * Icons are asked for one at a time, at the size a taskbar needs. A hundred at once (a megabyte
   * each from a Mac at its Dock's size) filled the control connection for minutes through a relay,
   * with every window and every answer queued behind them. `first`: an app being opened now.
   */
  private requestIcon(app: string, first = false): void {
    if (this.iconRequested.has(app)) {
      const index = this.iconQueue.indexOf(app);
      if (first && index > 0) { this.iconQueue.splice(index, 1); this.iconQueue.unshift(app); }
      return;
    }
    if (existsSync(join(this.iconsDir, `${fusionIconFile(app)}.png`))) {
      this.iconBundles.add(app);
      return;
    }
    this.iconRequested.add(app);
    if (first) this.iconQueue.unshift(app); else this.iconQueue.push(app);
    this.requestNextIcon();
  }

  private requestNextIcon(): void {
    if (this.iconInFlight !== undefined || !this.connection || this.connection.isClosed) return;
    const app = this.iconQueue.shift();
    if (app === undefined) return;
    this.iconInFlight = app;
    this.send({ t: "icon", app, size: ICON_PIXELS });
    // A remote without an icon for it answers without one; an older remote does not answer at all.
    clearTimeout(this.iconTimer);
    this.iconTimer = setTimeout(() => this.iconAnswered(app), 2_000);
    this.iconTimer.unref?.();
  }

  private iconAnswered(app: string): void {
    if (this.iconInFlight !== app) return;
    this.iconInFlight = undefined;
    clearTimeout(this.iconTimer);
    this.requestNextIcon();
  }

  private icon(m: FusionMessage): void {
    const app = String(m.app ?? "");
    if (app) this.iconAnswered(app);
    if (!app || typeof m.png !== "string") return;
    const png = Buffer.from(m.png, "base64");
    const file = fusionIconFile(app);
    writeFileSync(join(this.iconsDir, `${file}.png`), png);
    // Taskbar icons are ICO files; 256 px PNG inside one keeps them sharp at every scale.
    const small = nativeImage.createFromBuffer(png).resize({ width: 256, height: 256, quality: "best" }).toPNG();
    writeFileSync(join(this.iconsDir, `${file}.ico`), pngToIco(small));
    this.iconBundles.add(app);
    for (const record of this.windows.values()) if (record.app === app && record.win) this.brand(record.win, app);
  }

  private iconPath(app: string): string | undefined {
    const ico = join(this.iconsDir, `${fusionIconFile(app)}.ico`);
    return existsSync(ico) ? ico : undefined;
  }

  launchApp(app: string): void {
    this.quitting.delete(app);
    if (!this.connected) {
      if (!this.pendingLaunches.includes(app)) this.pendingLaunches.push(app);
      return;
    }
    this.requestIcon(app, true);
    this.send({ t: "launch", app });
    this.shortcut(app);
  }

  quitApp(app: string, force: boolean): void {
    this.quitting.set(app, Date.now() + 6_000);
    this.send({ t: "quit", app, force });
  }

  private appExited(app: string): void {
    this.quitting.delete(app);
    for (const record of [...this.windows.values()]) if (record.app === app) this.windowClosed(record.id);
  }

  /** Windows search and the Start menu find the remote apps people used. */
  private shortcut(app: string): void {
    if (process.platform !== "win32" || !this.options.shortcutDir) return;
    const entry = this.apps.find((a) => a.app === app);
    if (!entry) return;
    mkdirSync(this.options.shortcutDir, { recursive: true });
    const name = entry.name.replace(/[\\/:*?"<>|]/g, "_") || "App";
    const icon = this.iconPath(app);
    shell.writeShortcutLink(join(this.options.shortcutDir, `${name}.lnk`), existsSync(join(this.options.shortcutDir, `${name}.lnk`)) ? "replace" : "create", {
      target: this.options.relaunch.executable,
      args: this.options.relaunch.args(app).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
      description: `${entry.name}（${this.options.name}）`,
      appUserModelId: fusionAppId(this.options.slug, app),
      ...(icon ? { icon, iconIndex: 0 } : {}),
    });
  }

  private brand(win: BrowserWindow, app: string): void {
    if (process.platform !== "win32") return;
    const entry = this.apps.find((a) => a.app === app);
    const icon = this.iconPath(app);
    win.setAppDetails({
      appId: fusionAppId(this.options.slug, app),
      ...(icon ? { appIconPath: icon, appIconIndex: 0 } : {}),
      relaunchCommand: [this.options.relaunch.executable, ...this.options.relaunch.args(app)].map((arg) => `"${arg}"`).join(" "),
      relaunchDisplayName: entry?.name ?? app,
    });
    if (icon) win.setIcon(nativeImage.createFromPath(icon));
  }

  // ── Windows ────────────────────────────────────────────────────────────────

  private ready(m: FusionMessage): void {
    this.connected = true;
    this.displays = (Array.isArray(m.displays) ? m.displays : []).map((d) => {
      const entry = d as Record<string, unknown>;
      return { index: num(entry.index), frame: rect(entry.frame) };
    });
    this.toPage({ t: "displays", displays: this.displays });
    this.statusText = `已连接 ${this.options.name}`;
    for (const app of this.pendingLaunches.splice(0)) this.launchApp(app);
  }

  private windowOpened(m: FusionMessage): void {
    const id = num(m.id);
    const app = String(m.app ?? "");
    this.quitting.delete(app);
    const existing = this.windows.get(id);
    const record: WindowRecord = existing ?? {
      id, app, title: String(m.title ?? ""), stream: String(m.stream ?? `w${id}`), frame: rect(m.frame),
      chrome: (m.chrome ?? {}) as Record<string, unknown>, seq: 0, ack: 0, applying: false, pendingResize: false,
    };
    record.title = String(m.title ?? record.title);
    record.chrome = (m.chrome ?? record.chrome) as Record<string, unknown>;
    record.stream = String(m.stream ?? record.stream);
    this.windows.set(id, record);
    this.requestIcon(app, true);
    if (record.win && !record.win.isDestroyed()) {
      this.toPage({ t: "open", id, key: record.stream, chrome: record.chrome, title: record.title, reuse: true });
      return;
    }
    // The page opens the window (window.open) so it can draw into it; `windowOpenOptions` sizes it.
    this.toPage({ t: "open", id, key: record.stream, chrome: record.chrome, title: record.title, activate: m.activate === true });
  }

  /** What `window.open("", "w<id>")` from the hub page becomes. */
  windowOpenOptions(frameName: string): Electron.BrowserWindowConstructorOptions | undefined {
    const popup = /^p(\d+)$/.exec(frameName);
    if (popup) {
      const record = this.popups.get(Number(popup[1]));
      if (!record) return undefined;
      const at = this.popupBounds(record);
      return {
        x: Math.round(at.x), y: Math.round(at.y), width: Math.max(1, Math.round(at.w)), height: Math.max(1, Math.round(at.h)),
        frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false,
        hasShadow: true, backgroundColor: "#00000000", transparent: true,
      };
    }
    const match = /^w(\d+)$/.exec(frameName);
    if (!match) return undefined;
    const record = this.windows.get(Number(match[1]));
    if (!record) return undefined;
    const f = this.clampToScreens(record.frame);
    return {
      x: Math.round(f.x), y: Math.round(f.y), width: Math.max(80, Math.round(f.w)), height: Math.max(60, Math.round(f.h)),
      frame: false, show: false, title: record.title || this.appName(record.app), backgroundColor: "#000000",
      minWidth: 80, minHeight: 60, acceptFirstMouse: true, roundedCorners: true, hasShadow: true,
      ...(this.iconPath(record.app) ? { icon: this.iconPath(record.app)! } : {}),
    };
  }

  /** The window the page just opened: geometry, focus and close are the main process's. */
  windowCreated(frameName: string, win: BrowserWindow): void {
    const popup = /^p(\d+)$/.exec(frameName);
    if (popup) {
      const record = this.popups.get(Number(popup[1]));
      if (!record) return void win.destroy();
      record.win = win;
      win.setAlwaysOnTop(true, "pop-up-menu");
      win.showInactive();
      return;
    }
    const match = /^w(\d+)$/.exec(frameName);
    const record = match ? this.windows.get(Number(match[1])) : undefined;
    if (!record) return void win.destroy();
    record.win = win;
    this.brand(win, record.app);
    win.on("move", () => this.userMoved(record, false));
    win.on("resize", () => this.userMoved(record, true));
    win.on("focus", () => this.send({ t: "focus", id: record.id }));
    win.on("blur", () => setTimeout(() => {
      if (![...this.windows.values()].some((w) => w.win?.isFocused())) this.send({ t: "app.active", on: false });
    }, 80).unref?.());
    // Closing here asks the remote app; the window goes when the remote says it closed.
    win.on("close", (event) => {
      if (this.stopping || !this.windows.has(record.id)) return;
      event.preventDefault();
      this.send({ t: "wclose.req", id: record.id });
    });
    win.on("system-context-menu", (event, point) => {
      event.preventDefault();
      void this.showAppMenu(record, point);
    });
    win.once("ready-to-show", () => win.show());
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 300).unref?.();
    // Opened smaller than the remote window (to fit this screen): the remote must know, or its
    // picture and every click would be laid out for a size this window doesn't have.
    const b = win.getBounds();
    if (Math.abs(b.width - record.frame.w) >= 2 || Math.abs(b.height - record.frame.h) >= 2) {
      record.frame = { x: b.x, y: b.y, w: b.width, h: b.height };
      this.sendPlace(record, true);
    }
  }

  private sendPlace(record: WindowRecord, resize: boolean): void {
    record.seq += 1;
    record.asked = { w: record.frame.w, h: record.frame.h };
    this.send({ t: "place", id: record.id, seq: record.seq, frame: record.frame, resize });
    this.toPage({ t: "seq", id: record.id, seq: record.seq });
  }

  private userMoved(record: WindowRecord, resize: boolean): void {
    const win = record.win;
    if (!win || record.applying || win.isDestroyed()) return;
    const b = win.getBounds();
    record.frame = { x: b.x, y: b.y, w: b.width, h: b.height };
    record.pendingResize ||= resize;
    clearTimeout(record.placeTimer);
    // As the stub throttles: one `place` per 80 ms is all the remote's AX writes keep up with.
    record.placeTimer = setTimeout(() => {
      record.placeTimer = undefined;
      const resizing = record.pendingResize;
      record.pendingResize = false;
      this.sendPlace(record, resizing);
    }, 80);
  }

  private setBounds(record: WindowRecord, frame: Rect): void {
    const win = record.win;
    if (!win || win.isDestroyed()) return;
    record.applying = true;
    win.setBounds({ x: Math.round(frame.x), y: Math.round(frame.y), width: Math.max(80, Math.round(frame.w)), height: Math.max(60, Math.round(frame.h)) });
    setTimeout(() => { record.applying = false; }, 50);
  }

  private windowClosed(id: number): void {
    const record = this.windows.get(id);
    if (!record) return;
    this.windows.delete(id);
    clearTimeout(record.placeTimer);
    this.toPage({ t: "close", id, key: record.stream });
    if (record.win && !record.win.isDestroyed()) record.win.destroy();
    for (const popup of [...this.popups.values()]) if (popup.parent === id) this.dropPopup(popup.id);
  }

  private windowStyle(m: FusionMessage): void {
    const record = this.windows.get(num(m.id));
    if (!record) return;
    if (typeof m.title === "string" && m.title) {
      record.title = m.title;
      record.win?.setTitle(m.title);
    }
    if (m.chrome) record.chrome = m.chrome as Record<string, unknown>;
    this.toPage({ t: "chrome", id: record.id, key: record.stream, chrome: record.chrome });
  }

  private layout(list: FusionMessage[]): void {
    const seen = new Set<number>();
    for (const entry of list) {
      const id = num(entry.id);
      const frame = rect(entry.frame);
      if (entry.own === true) {
        const record = this.windows.get(id);
        if (!record) continue;
        if (typeof entry.title === "string" && entry.title && entry.title !== record.title) {
          record.title = entry.title;
          record.win?.setTitle(entry.title);
        }
        const ack = num(entry.ack);
        record.ack = Math.max(record.ack, ack);
        // Position is local; the remote decides the size it accepted (an app's minimum, say). Only
        // once it answered the latest `place`, nothing newer is pending here (a drag going on), and
        // what it accepted is not what was asked.
        const asked = record.asked;
        if (record.ack >= record.seq && !record.placeTimer && asked && record.win
            && (Math.abs(frame.w - asked.w) >= 3 || Math.abs(frame.h - asked.h) >= 3)) {
          record.frame = { ...record.frame, w: frame.w, h: frame.h };
          record.asked = { w: frame.w, h: frame.h };
          this.setBounds(record, record.frame);
        }
        if (!record.win) record.frame = frame;
      } else {
        seen.add(id);
        const offset = (entry.offset ?? { x: 0, y: 0 }) as { x: number; y: number };
        const existing = this.popups.get(id);
        const popup: PopupRecord = { id, app: String(entry.app ?? ""), parent: num(entry.parent), offset: { x: num(offset.x), y: num(offset.y) }, frame, layer: num(entry.layer, 101), win: existing?.win };
        this.popups.set(id, popup);
        if (existing?.win && !existing.win.isDestroyed()) {
          const at = this.popupBounds(popup);
          existing.win.setBounds({ x: Math.round(at.x), y: Math.round(at.y), width: Math.max(1, Math.round(at.w)), height: Math.max(1, Math.round(at.h)) });
        }
      }
    }
    for (const id of [...this.popups.keys()]) if (!seen.has(id)) this.dropPopup(id);
    this.toPage({ t: "popups", popups: [...this.popups.values()].map((p) => ({ id: p.id, frame: p.frame, parent: p.parent })) });
  }

  /** Beside its parent window here, where the parent is (not where it is on the remote). */
  private popupBounds(popup: PopupRecord): Rect {
    const parent = this.windows.get(popup.parent);
    const base = parent?.win && !parent.win.isDestroyed() ? parent.win.getBounds() : undefined;
    return base ? { x: base.x + popup.offset.x, y: base.y + popup.offset.y, w: popup.frame.w, h: popup.frame.h } : popup.frame;
  }

  private dropPopup(id: number): void {
    const popup = this.popups.get(id);
    this.popups.delete(id);
    if (popup?.win && !popup.win.isDestroyed()) popup.win.destroy();
    this.toPage({ t: "popup.close", id });
  }

  private dropWindows(): void {
    for (const id of [...this.windows.keys()]) this.windowClosed(id);
    for (const id of [...this.popups.keys()]) this.dropPopup(id);
  }

  /** A window must open where the person can see it, whatever the remote last knew. */
  private clampToScreens(frame: Rect): Rect {
    const area = screen.getDisplayMatching({ x: Math.round(frame.x), y: Math.round(frame.y), width: Math.max(1, Math.round(frame.w)), height: Math.max(1, Math.round(frame.h)) }).workArea;
    const w = Math.min(frame.w, area.width), h = Math.min(frame.h, area.height);
    return {
      x: Math.min(Math.max(frame.x, area.x), area.x + area.width - w),
      y: Math.min(Math.max(frame.y, area.y), area.y + area.height - h),
      w, h,
    };
  }

  private appName(app: string): string { return this.apps.find((a) => a.app === app)?.name ?? app; }

  // ── The remote app's menu (Mac remotes) ────────────────────────────────────

  private menuWaiters = new Map<string, (items: FusionMessage[] | undefined) => void>();

  private menuReply(m: FusionMessage): void {
    const key = `${m.app}:${JSON.stringify(m.path ?? [])}`;
    this.menuWaiters.get(key)?.(m.error ? undefined : (Array.isArray(m.items) ? m.items as FusionMessage[] : undefined));
    this.menuWaiters.delete(key);
  }

  private fetchMenu(app: string, path: number[]): Promise<FusionMessage[] | undefined> {
    return new Promise((resolve) => {
      const key = `${app}:${JSON.stringify(path)}`;
      const timer = setTimeout(() => { this.menuWaiters.delete(key); resolve(undefined); }, 1_500);
      this.menuWaiters.set(key, (items) => { clearTimeout(timer); resolve(items); });
      this.send({ t: "menu.fetch", app, path });
    });
  }

  /** Right-click on the title bar: the Mac app's menu bar, as a native menu (Windows has no global one). */
  private async showAppMenu(record: WindowRecord, point: { x: number; y: number }): Promise<void> {
    if (!this.remoteFeatures.has("menubar") || !record.win) return;
    const bar = await this.fetchMenu(record.app, []);
    if (!bar) return;
    // The Apple menu (0) and the app menu (1) are the remote Mac's own: Quit is in the window.
    const top = bar.map((item, index) => ({ item, index })).filter(({ index }) => index >= 1);
    const subs = await Promise.all(top.map(({ index }) => this.fetchMenu(record.app, [index])));
    const build = (items: FusionMessage[] | undefined, path: number[]): MenuItemConstructorOptions[] =>
      (items ?? []).map((item, index) => item.sep
        ? { type: "separator" as const }
        : {
          label: String(item.title ?? ""),
          enabled: item.enabled !== false,
          type: item.checked ? "checkbox" as const : "normal" as const,
          checked: item.checked === true,
          click: () => this.send({ t: "menu.press", app: record.app, path: [...path, index] }),
        });
    const template: MenuItemConstructorOptions[] = top.map(({ item, index }, i) => ({
      label: String(item.title ?? ""),
      submenu: build(subs[i], [index]),
    }));
    if (!template.length || !record.win || record.win.isDestroyed()) return;
    Menu.buildFromTemplate(template).popup({ window: record.win, x: Math.round(point.x), y: Math.round(point.y) });
  }

  // ── The hub page ───────────────────────────────────────────────────────────

  private ensurePage(): void {
    if (this.page && !this.page.isDestroyed()) return;
    const url = this.options.pageURL();
    if (!url) return;
    this.pageReady = false;
    const page = new BrowserWindow({
      show: false,
      webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.page = page;
    page.webContents.setWindowOpenHandler(({ frameName }) => {
      const options = this.windowOpenOptions(frameName);
      return options ? { action: "allow", overrideBrowserWindowOptions: options } : { action: "deny" };
    });
    page.webContents.on("did-create-window", (win, details) => this.windowCreated(details.frameName, win));
    page.webContents.on("will-navigate", (event) => event.preventDefault());
    page.on("closed", () => { if (this.page === page) this.page = undefined; });
    void page.loadURL(new URL(`fusion.html?hub=${encodeURIComponent(this.options.slug)}`, url).href).catch(() => undefined);
  }

  /** Messages from the hub page (its preload sends them on `linkshell:fusion-hub`). */
  fromPage(sender: WebContents, message: FusionMessage): void {
    if (!this.page || sender !== this.page.webContents || !this.options.isTrusted(sender.getURL())) return;
    switch (message.t) {
      case "ready":
        this.pageReady = true;
        for (const queued of this.pageQueue.splice(0)) sender.send("linkshell:fusion-hub", queued);
        return;
      case "rtc": return this.send({ t: "rtc", m: message.m });
      case "action": {
        const record = this.windows.get(num(message.id));
        if (!record?.win) return;
        if (message.what === "close") this.send({ t: "wclose.req", id: record.id });
        else if (message.what === "minimize") record.win.minimize();
        else if (message.what === "zoom") { if (record.win.isMaximized()) record.win.unmaximize(); else record.win.maximize(); }
        else if (message.what === "prewarm") this.send({ t: "prewarm", id: record.id });
        return;
      }
      case "status":
        if (typeof message.controlError === "string") this.alerts.set("accessibility:", { kind: "accessibility", message: message.controlError, at: Date.now() });
        if (message.live === true) this.alerts.delete("webrtc:");
        if (typeof message.mediaError === "string") this.alerts.set("webrtc:", { kind: "webrtc", message: message.mediaError, at: Date.now() });
        return;
      default: return;
    }
  }

  private toPage(message: FusionMessage): void {
    if (!this.page || this.page.isDestroyed()) return;
    if (!this.pageReady) { this.pageQueue.push(message); return; }
    this.page.webContents.send("linkshell:fusion-hub", message);
  }

  // ── Status for the desktop's Fusion page ───────────────────────────────────

  status(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const record of this.windows.values()) counts[record.app] = (counts[record.app] ?? 0) + 1;
    const now = Date.now();
    const active = Object.keys(counts).filter((app) => (this.quitting.get(app) ?? 0) < now);
    return {
      t: "status",
      connected: this.connected,
      reconnecting: this.suspended,
      rttMs: Math.round(this.rtt),
      hostLabel: this.options.name,
      hostSlug: this.options.slug,
      computerKey: this.options.computerKey,
      appsDir: this.options.shortcutDir ?? this.iconsDir,
      statusText: this.statusText,
      activeBundles: active.sort(),
      windowCounts: counts,
      iconBundles: [...this.iconBundles].sort(),
      apps: this.apps.map((a) => ({ name: a.name, bundle: a.app, category: a.category, rawCategory: a.category, isSystem: a.system, stubPath: "" })),
      alerts: [...this.alerts.values()],
      remotePlatform: this.remotePlatform,
    };
  }

  get exit(): { reason: string; message: string } | undefined { return this.exitReason; }
}

function describe(reason: string): string {
  switch (reason) {
    case "timeout": return "远端电脑已无响应（可能已睡眠或网络中断）";
    case "tls": case "token": return "无法与远端电脑的融合服务完成加密握手，请重新开启融合模式";
    case "unreachable": case "failed": return "无法连接到远端电脑的融合服务";
    case "stopped": case "user": return "融合模式已停止";
    case "proto": return "两台电脑的 LinkShell 版本不一致，请都升级到最新版本后再开启融合模式";
    case "replaced": return "另一台电脑开启了与远端的融合模式";
    default: return "与远端电脑的融合连接已断开";
  }
}
