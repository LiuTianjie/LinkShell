import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:tls";
import { FUSION_MAX_CLIPBOARD, FUSION_PORT, FUSION_PROTO } from "@linkshell/wire";
import { FusionNodeMedia, type FusionLayout } from "./media.js";
import type { FusionClip, FusionPlatform, FusionWindowInfo } from "./platform.js";
import { listenFusion, type FusionConnection, type FusionMessage } from "./wire.js";

/**
 * A Fusion remote in the host itself (docs/v2/fusion.md §8.2): what `LinkShell --fusion-remote`
 * is on a Mac, for Windows (and, with the simulated platform, for tests anywhere). The protocol
 * and its lifecycle follow FusionRemote.swift / FusionRemoteSession.swift: single-use tokens,
 * hello/welcome, `bye`, a 30 s grace for `resume`, windows put back when it ends.
 *
 * There are no virtual displays: windows stay where they are on this computer. The local side
 * decides where they are there (`place`); this side remembers that and changes only the size.
 */
const RESUME_GRACE_MS = 30_000;
/**
 * Multi-stage Windows apps (Chrome's Profile Picker → browser window, splash/login → main window,
 * IDE welcome → project window) destroy their first window moments before showing the next: wait
 * before declaring the app exited, while keeping explicit user close/quit responsive.
 */
const APP_EXIT_TRANSITION_MS = 2_000;
const APP_EXIT_EXPLICIT_MS = 200;
/**
 * No `keys`: the Windows helper types named keys and text, not physical key codes. `clipboard`
 * where the platform has one to share (text and pictures; no RTF).
 */
const features = (platform: FusionPlatform): string[] => (platform.setClipboard ? ["clipboard"] : []);
/** Hardware encoders run only so many sessions at once (consumer NVENC: a handful). */
const MAX_WINDOW_STREAMS = 6;

type Rect = { x: number; y: number; w: number; h: number };
type LocalDisplay = { frame: Rect; visible: Rect; scale: number };

export interface FusionNodeRemoteOptions {
  log(line: string): void;
  port?: number;
}

export class FusionNodeRemote {
  private token?: string;
  private ice: unknown[] = [];
  private listener?: Server;
  private current?: FusionNodeSession;
  private suspended?: FusionNodeSession;
  private readonly pending = new Set<FusionNodeSession>();

  constructor(private readonly platform: FusionPlatform, private readonly options: FusionNodeRemoteOptions) {}

  /** A fresh token for one `fusion.start`: a new listener keyed to it. Returns the port. */
  async issue(token: string, ice: unknown[]): Promise<number> {
    this.token = token;
    this.ice = ice;
    this.listener?.close();
    const { server, port } = await listenFusion(token, this.options.port ?? FUSION_PORT, (connection) => this.accept(connection));
    this.listener = server;
    this.options.log(`[fusion] remote listening on ${port}`);
    return port;
  }

  /** Constant time and single use, as FusionRemote.consume. */
  private consume(candidate: string): boolean {
    const token = this.token;
    if (!token || token.length !== candidate.length) return false;
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(candidate))) return false;
    this.token = undefined;
    return true;
  }

  private accept(connection: FusionConnection): void {
    const session = new FusionNodeSession(connection, this.platform, this.options.log, this.ice);
    this.pending.add(session);
    const deadline = setTimeout(() => {
      if (!this.pending.delete(session)) return;
      session.end();
      connection.close("unauthenticated");
    }, 8_000);
    deadline.unref?.();
    session.authorize = (token) => this.consume(token);
    session.onAuthenticated = () => {
      this.pending.delete(session);
      clearTimeout(deadline);
      if (this.suspended) { this.suspended.ownsPlatform = false; this.suspended.end(); this.suspended = undefined; }
      if (this.current && this.current !== session) {
        this.current.ownsPlatform = false;
        this.current.finish("replaced", "另一台电脑开启了与这台电脑的融合模式");
      }
      session.ownsPlatform = true;
      this.current = session;
      connection.startWatchdog(8_000);
    };
    session.resumeTarget = (id) => {
      if (this.suspended?.id === id && !this.suspended.ended) {
        const old = this.suspended;
        this.suspended = undefined;
        return old;
      }
      if (this.current?.id === id && !this.current.ended) {
        this.current.detach();
        return this.current;
      }
      return undefined;
    };
    session.onResumed = (old) => {
      this.pending.delete(session);
      clearTimeout(deadline);
      if (this.current && this.current !== old) {
        this.current.ownsPlatform = false;
        this.current.finish("replaced");
      }
      old.ownsPlatform = true;
      this.current = old;
      this.attach(old, connection);
      connection.startWatchdog(8_000);
    };
    connection.onMessage = (message) => session.receive(message);
    connection.onClose = (reason) => {
      this.pending.delete(session);
      this.closed(session, reason);
    };
  }

  private attach(session: FusionNodeSession, connection: FusionConnection): void {
    connection.onMessage = (message) => session.receive(message);
    connection.onClose = (reason) => this.closed(session, reason);
  }

  private closed(session: FusionNodeSession, reason: string): void {
    if (this.current !== session) { if (session !== this.suspended) session.end(); return; }
    this.current = undefined;
    if (session.ended || ["bye", "token", "proto", "replaced"].includes(reason)) return session.end();
    this.suspended?.end();
    this.suspended = session;
    session.suspend(() => { if (this.suspended === session) this.suspended = undefined; });
  }

  /** The host stops Fusion here (`fusion.stop`, or the host is going). */
  stop(): void {
    this.current?.finish("stopped", "远端电脑结束了融合模式");
    this.current = undefined;
    this.suspended?.end();
    this.suspended = undefined;
    for (const session of this.pending) session.end();
    this.pending.clear();
    this.listener?.close();
    this.listener = undefined;
    this.token = undefined;
  }
}

interface WindowState {
  info: FusionWindowInfo;
  /** The encoder's fixed picture, pixels: the window at its top left, never larger than this. */
  canvas?: { w: number; h: number };
  /** Where the local computer shows it, its points. */
  local: Rect;
  seq: number;
  applied: number;
  streamed: boolean;
  /** The size it had before the local side first resized it, pixels: put back at the end. */
  original?: { w: number; h: number };
}

export class FusionNodeSession {
  readonly id = `s-${randomUUID().slice(0, 8)}`;
  ended = false;
  /** Only the active or suspended session drives the shared OS helper; unauthenticated probes never clear it. */
  ownsPlatform = false;
  authorize: (token: string) => boolean = () => false;
  onAuthenticated?: () => void;
  resumeTarget?: (id: string) => FusionNodeSession | undefined;
  onResumed?: (session: FusionNodeSession) => void;
  private authenticated = false;
  private paused = false;
  private clipboardArmed = false;
  /** The local side said it shares its clipboard (`hello.features`). */
  private localClipboard = false;
  private media?: FusionNodeMedia;
  private displays: LocalDisplay[] = [];
  private localPlatform = "macos";
  private readonly windows = new Map<number, WindowState>();
  private readonly fusedApps = new Set<string>();
  private readonly userActions = new Map<string, number>();
  private readonly exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly explicitCloseApps = new Set<string>();
  private lastLayout = "";
  private grace?: ReturnType<typeof setTimeout>;
  private cascade = 0;
  private resumeKnown?: Set<number>;
  private readonly capped = new Set<number>();

  constructor(private connection: FusionConnection, private readonly platform: FusionPlatform, private readonly log: (line: string) => void, private readonly ice: unknown[]) {}

  private send(message: FusionMessage): void { if (!this.paused) this.connection.send(message); }

  private syncFused(): void { if (this.ownsPlatform) this.platform.setFused([...this.fusedApps]); }

  private clearExitTimer(app: string): void {
    const timer = this.exitTimers.get(app);
    if (timer) { clearTimeout(timer); this.exitTimers.delete(app); }
  }

  private clearAllExitTimers(): void {
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    this.explicitCloseApps.clear();
  }

  receive(m: FusionMessage): void {
    if (m.t === "hello") return void this.hello(m);
    if (!this.authenticated || this.ended) return;
    switch (m.t) {
      case "bye": this.end(); this.connection.close("bye"); return;
      case "ping": this.send({ t: "pong", ts: m.ts ?? 0 }); return;
      case "launch": return void this.launch(String(m.app ?? ""));
      case "quit": {
        const app = String(m.app ?? "");
        if (app) this.explicitCloseApps.add(app);
        this.platform.quit(app, m.force === true);
        return;
      }
      case "icon": return void this.icon(String(m.app ?? ""));
      case "focus": {
        const state = this.windows.get(Number(m.id));
        if (state) { this.userActions.set(state.info.app, Date.now()); this.platform.focus(state.info.id); }
        // The clipboard is shared from the first time the user is in one of the windows, as on a Mac.
        this.clipboardArmed = true;
        return;
      }
      case "clip": return this.pasted(m);
      case "place": return this.place(m);
      case "wclose.req": {
        const id = Number(m.id);
        const state = this.windows.get(id);
        if (state) this.explicitCloseApps.add(state.info.app);
        this.platform.close(id);
        return;
      }
      case "displays": if (Array.isArray(m.displays)) this.displays = m.displays as LocalDisplay[]; return;
      case "rtc": if (m.m && typeof m.m === "object") this.rtc(m.m as Record<string, unknown>); return;
      default: return; // app.active, prewarm: nothing to do on this remote yet.
    }
  }

  private async hello(m: FusionMessage): Promise<void> {
    if (this.authenticated || typeof m.token !== "string" || !this.authorize(m.token)) {
      this.connection.send({ t: "bye", reason: "token" });
      setTimeout(() => this.connection.close("token"), 100).unref?.();
      return;
    }
    if (m.proto !== FUSION_PROTO) {
      this.connection.send({ t: "bye", reason: "proto", message: "本机 LinkShell 版本与远端不一致，请把两台电脑都升级到最新版本后再开启融合模式" });
      setTimeout(() => this.connection.close("proto"), 100).unref?.();
      return;
    }
    this.authenticated = true;
    const target = typeof m.resume === "string" ? this.resumeTarget?.(m.resume) : undefined;
    if (target) {
      target.resume(this.connection, m);
      this.onResumed?.(target);
      return;
    }
    this.onAuthenticated?.();
    this.adopt(m);
    this.welcome(false);
    this.syncFused();
    const apps = await this.platform.apps().catch(() => []);
    // The catalog can take seconds on Windows: the session may have ended (bye, replaced) meanwhile.
    if (this.ended) return;
    this.send({ t: "apps", apps });
    this.ready();
    this.platform.watch((windows) => this.track(windows));
    this.platform.watchClipboard?.((clip) => this.copied(clip));
  }

  /** The local computer copied something: it is this computer's clipboard too. */
  private pasted(m: FusionMessage): void {
    if (!this.clipboardArmed || !this.platform.setClipboard) return;
    const text = typeof m.text === "string" && m.text ? m.text : undefined;
    const png = typeof m.png === "string" && m.png ? Buffer.from(m.png, "base64") : undefined;
    if (!text && !png) return;
    if (Buffer.byteLength(text ?? "") + (png?.length ?? 0) > FUSION_MAX_CLIPBOARD) return;
    this.platform.setClipboard({ ...(text ? { text } : {}), ...(png ? { png } : {}) });
  }

  /** A fused app copied something. */
  private copied(clip: FusionClip): void {
    if (!this.clipboardArmed || !this.authenticated || this.ended || !this.localClipboard) return;
    if (Buffer.byteLength(clip.text ?? "") + (clip.png?.length ?? 0) > FUSION_MAX_CLIPBOARD) return;
    this.send({ t: "clip", ...(clip.text ? { text: clip.text } : {}), ...(clip.png ? { png: clip.png.toString("base64") } : {}) });
  }

  private adopt(m: FusionMessage): void {
    this.displays = Array.isArray(m.displays) ? (m.displays as LocalDisplay[]) : [];
    this.localPlatform = m.platform === "windows" ? "windows" : "macos";
    this.localClipboard = Array.isArray(m.features) && m.features.includes("clipboard");
  }

  private welcome(resumed: boolean): void {
    this.send({ t: "welcome", proto: FUSION_PROTO, platform: "windows", features: features(this.platform), session: this.id, resumed });
  }

  /** Each monitor's popup layer is a "display" on the wire, in this computer's points. */
  private ready(): void {
    const monitors = this.platform.monitors();
    this.send({ t: "ready", displays: monitors.map((mon) => ({ index: mon.index, frame: points(mon.rect, mon.scale) })) });
    this.startMedia();
  }

  private startMedia(): void {
    this.media?.end();
    const media = new FusionNodeMedia(this.ice.flatMap(weriftServer), {
      signal: (payload) => { this.trace("→", payload); this.send({ t: "rtc", m: payload }); },
      input: (key, event) => this.input(key, event),
      error: (key, message) => this.send({ t: "alert", kind: "webrtc", subject: key, message }),
      log: this.log,
    });
    this.media = media;
    media.start(this.ice);
    for (const mon of this.platform.monitors()) {
      media.open(`d${mon.index}`, (onUnit, onEnd) => this.platform.monitorVideo(mon.index, 30, 1_500_000, onUnit, onEnd), () => this.popupLayout(mon.index));
    }
    for (const state of this.windows.values()) if (state.streamed) this.openStream(state);
  }

  /** LINKSHELL_FUSION_DIAGNOSTICS=1: the media signalling, both ways, in the host's log. */
  private trace(direction: string, m: Record<string, unknown>): void {
    if (process.env.LINKSHELL_FUSION_DIAGNOSTICS !== "1") return;
    const sdp = typeof m.sdp === "string" ? ` ${m.sdp.split(/\r?\n/).filter((line) => /^(m=|a=mid|a=(sendonly|recvonly|inactive|sendrecv)|a=rtpmap|a=fmtp|a=group|a=extmap|a=ssrc|a=msid|a=rtcp|a=setup|a=bundle)/.test(line)).join(" | ")}` : "";
    this.log(`[fusion] rtc ${direction} ${String(m.t)}${sdp || ` ${JSON.stringify(m).slice(0, 300)}`}`);
  }

  private rtc(m: Record<string, unknown>): void {
    this.trace("←", m);
    if (m.t === "restart") {
      this.log("[fusion] media restart");
      this.startMedia();
      return;
    }
    this.media?.receive(m);
  }

  private async launch(app: string): Promise<void> {
    if (!app) return;
    this.clearExitTimer(app);
    this.explicitCloseApps.delete(app);
    this.fusedApps.add(app);
    this.syncFused();
    this.userActions.set(app, Date.now());
    try {
      await this.platform.launch(app);
      this.send({ t: "alert", kind: "launch", subject: app, clear: true });
    } catch (error) {
      this.send({ t: "alert", kind: "launch", subject: app, message: `远端应用启动失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async icon(app: string): Promise<void> {
    const png = await this.platform.icon(app).catch(() => undefined);
    // Answered either way: the local side asks for one icon at a time, and waits for this.
    this.send({ t: "icon", app, ...(png ? { png: png.toString("base64") } : {}) });
  }

  // ── Windows ────────────────────────────────────────────────────────────

  private track(list: FusionWindowInfo[]): void {
    if (this.ended || this.paused) return;
    const live = new Set<number>();
    const appsWithWindows = new Set<string>();
    for (const info of list) {
      if (info.popup || !this.fusedApps.has(info.app)) continue;
      live.add(info.id);
      appsWithWindows.add(info.app);
      this.clearExitTimer(info.app);
      this.explicitCloseApps.delete(info.app);
      const state = this.windows.get(info.id);
      if (state) {
        state.info = info;
        if (!state.streamed && !info.minimized) this.show(state);
        continue;
      }
      const fresh: WindowState = { info, local: this.placeNew(info), seq: 0, applied: 0, streamed: false };
      this.windows.set(info.id, fresh);
      if (!info.minimized) this.show(fresh);
    }
    for (const [id, state] of this.windows) {
      if (live.has(id)) continue;
      this.windows.delete(id);
      this.capped.delete(id);
      if (state.streamed) {
        this.media?.close(`w${id}`);
        this.send({ t: "wclose", id });
      }
      const app = state.info.app;
      // Windows apps quit with their last window, unless they are handing off to a new one
      // (Profile Picker → browser window, splash/login → main window): wait briefly before `app.exited`.
      if (!appsWithWindows.has(app) && ![...this.windows.values()].some((w) => w.info.app === app) && !this.exitTimers.has(app)) {
        const waitMs = this.explicitCloseApps.has(app) ? APP_EXIT_EXPLICIT_MS : APP_EXIT_TRANSITION_MS;
        const timer = setTimeout(() => {
          this.exitTimers.delete(app);
          this.explicitCloseApps.delete(app);
          if (this.ended || this.paused) return;
          if ([...this.windows.values()].some((w) => w.info.app === app)) return;
          this.send({ t: "app.exited", app });
        }, waitMs);
        timer.unref?.();
        this.exitTimers.set(app, timer);
      }
    }
    if (this.resumeKnown) {
      for (const id of this.resumeKnown) if (!this.windows.has(id)) this.send({ t: "wclose", id });
      this.resumeKnown = undefined;
    }
    this.sendLayout(list);
  }

  /** A new window opens on the local computer's main display, at its own size in points. */
  private placeNew(info: FusionWindowInfo): Rect {
    const scale = this.monitorScale(info.monitor);
    const area = this.displays[0]?.visible ?? { x: 0, y: 0, w: 1440, h: 900 };
    const w = Math.min(info.rect.w / scale, area.w - 40), h = Math.min(info.rect.h / scale, area.h - 40);
    const offset = (this.cascade++ % 8) * 28;
    return { x: area.x + Math.max(20, (area.w - w) / 2 - 112) + offset, y: area.y + Math.max(20, (area.h - h) / 3) + offset, w, h };
  }

  private show(state: WindowState): void {
    if ([...this.windows.values()].filter((w) => w.streamed).length >= MAX_WINDOW_STREAMS) {
      if (this.capped.has(state.info.id)) return;
      this.capped.add(state.info.id);
      this.send({ t: "alert", kind: "webrtc", subject: `w${state.info.id}`, message: `远端电脑同时融合的窗口过多（最多 ${MAX_WINDOW_STREAMS} 个），请关闭不用的窗口` });
      return;
    }
    state.streamed = true;
    const info = state.info;
    const scale = this.monitorScale(info.monitor);
    const buttons = Object.fromEntries(Object.entries(info.buttons ?? {}).filter(([, rect]) => rect).map(([name, rect]) => [name, points(rect!, scale)]));
    const hitrects = (info.hitrects ?? []).slice(0, 64).map((rect) => points(rect, scale));
    this.send({
      t: "wopen", id: info.id, app: info.app, title: info.title,
      activate: Date.now() - (this.userActions.get(info.app) ?? 0) < 3_000,
      frame: { ...state.local, w: info.rect.w / scale, h: info.rect.h / scale },
      chrome: { style: "windows", toolbar: false, ...(Object.keys(buttons).length ? { buttons } : {}), ...(hitrects.length ? { hitrects } : {}) },
      stream: `w${info.id}`,
    });
    this.openStream(state);
  }

  private openStream(state: WindowState): void {
    const info = state.info;
    const monitor = this.platform.monitors().find((mon) => mon.index === info.monitor) ?? this.platform.monitors()[0];
    // As LinkShell.Screen.exe clamps it: even, and no larger than 4K.
    const canvas = { w: Math.min(3840, monitor?.rect.w ?? 1920) & ~1, h: Math.min(2160, monitor?.rect.h ?? 1080) & ~1 };
    state.canvas = canvas;
    this.media?.open(`w${info.id}`,
      (onUnit, onEnd) => this.platform.windowVideo(info.id, canvas, 60, 8_000_000, onUnit, onEnd),
      () => this.windowLayout(info.id, canvas));
  }

  /** The Mac's metadata for a window: [lx,ly,lw,lh, nx,ny,nw,nh, ix,iy,iw,ih, scale, ack, id]. */
  private windowLayout(id: number, canvas: { w: number; h: number }): FusionLayout | undefined {
    const state = this.windows.get(id);
    if (!state) return undefined;
    const scale = this.monitorScale(state.info.monitor);
    const w = state.info.rect.w, h = state.info.rect.h;
    // A window larger than the canvas (moved to a bigger monitor) shows its top-left canvas's worth.
    const vw = Math.min(w, canvas.w), vh = Math.min(h, canvas.h);
    return [
      state.local.x, state.local.y, w / scale, h / scale,
      0, 0, vw / canvas.w, vh / canvas.h,
      0, 0, vw / scale, vh / scale,
      scale, state.applied, id,
    ];
  }

  /** The popups over one monitor, in the same points as its `ready` display: [[id, layer, x, y, w, h]]. */
  private popupLayout(index: number): FusionLayout {
    return this.currentPopups.filter((p) => p.monitor === index).map((p) => {
      const r = points(p.rect, this.monitorScale(p.monitor));
      return [p.id, 101, r.x, r.y, r.w, r.h];
    });
  }

  private currentPopups: FusionWindowInfo[] = [];
  private lastList: FusionWindowInfo[] = [];

  private sendLayout(list: FusionWindowInfo[]): void {
    this.lastList = list;
    this.currentPopups = list.filter((w) => w.popup && w.owner !== undefined && this.windows.get(w.owner)?.streamed);
    // Front to back, as the window list comes (EnumWindows' z-order): the first is the front one.
    const order = new Map(list.map((w, index) => [w.id, index]));
    const own = [...this.windows.values()].filter((w) => w.streamed).sort((a, b) => (order.get(a.info.id) ?? 1e9) - (order.get(b.info.id) ?? 1e9)).map((w) => {
      const scale = this.monitorScale(w.info.monitor);
      return { id: w.info.id, app: w.info.app, own: true, layer: 0, title: w.info.title, frame: { ...w.local, w: w.info.rect.w / scale, h: w.info.rect.h / scale }, ack: w.applied };
    });
    const popups = this.currentPopups.map((p) => {
      const owner = this.windows.get(p.owner!)!;
      const scale = this.monitorScale(p.monitor);
      return {
        id: p.id, app: p.app, own: false, layer: 101, title: p.title, frame: points(p.rect, scale), parent: p.owner,
        offset: { x: (p.rect.x - owner.info.rect.x) / scale, y: (p.rect.y - owner.info.rect.y) / scale },
      };
    });
    const windows = [...own, ...popups];
    const text = JSON.stringify(windows);
    if (text === this.lastLayout) return;
    this.lastLayout = text;
    this.send({ t: "layout", windows });
  }

  /** Where the local computer put it is its own business; a new size is resized here. */
  private place(m: FusionMessage): void {
    const state = this.windows.get(Number(m.id));
    if (!state) return;
    const frame = m.frame as Rect;
    const seq = Number(m.seq ?? 0);
    if (seq < state.seq) return;
    state.seq = seq;
    state.local = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    const scale = this.monitorScale(state.info.monitor);
    if (m.resize === true) {
      state.original ??= { w: state.info.rect.w, h: state.info.rect.h };
      const canvas = state.canvas ?? { w: 3840, h: 2160 };
      this.platform.resize(state.info.id, Math.min(canvas.w, Math.round(frame.w * scale)), Math.min(canvas.h, Math.round(frame.h * scale)));
    }
    // The window list reports the size the app accepted; until then the old one is shown.
    // The window list changes only when the window does: the acknowledgement goes out on its own.
    setTimeout(() => {
      state.applied = Math.max(state.applied, seq);
      if (!this.ended && !this.paused) this.sendLayout(this.lastList);
    }, m.resize === true ? 120 : 0).unref?.();
  }

  private input(key: string, raw: Record<string, unknown>): void {
    // ⌘C on the Mac is Ctrl+C here (docs/v2/fusion.md §8.3); the Mac's own Control stays Ctrl.
    const event = this.localPlatform === "macos" ? macShortcuts(raw) : raw;
    if (key.startsWith("w")) {
      const id = Number(key.slice(1));
      const state = this.windows.get(id);
      if (!state) return;
      // A click or key goes to the window under it only if it is in front: bring it there first.
      if (event.t !== "move" && event.t !== "scroll") { this.userActions.set(state.info.app, Date.now()); this.platform.focus(id); }
      this.platform.input({ window: id }, event);
    } else if (key.startsWith("d")) {
      this.platform.input({ monitor: Number(key.slice(1)) }, event);
    }
  }

  private monitorScale(index: number): number {
    return this.platform.monitors().find((mon) => mon.index === index)?.scale ?? 1;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** The connection dropped without a `bye`: pictures stop, windows stay, for a while. */
  suspend(onExpired: () => void): void {
    this.paused = true;
    this.clearAllExitTimers();
    this.media?.end();
    this.media = undefined;
    this.grace = setTimeout(() => { onExpired(); this.end(); }, RESUME_GRACE_MS);
    this.grace.unref?.();
    this.log(`[fusion] connection lost: keeping session ${this.id} for 30 s`);
  }

  /** The local computer is resuming on a new connection while this side still had the old one. */
  detach(): void {
    this.connection.onClose = undefined;
    this.connection.close("replaced");
    this.paused = true;
    this.clearAllExitTimers();
    this.media?.end();
    this.media = undefined;
  }

  resume(connection: FusionConnection, m: FusionMessage): void {
    if (this.ended) return;
    clearTimeout(this.grace);
    this.connection = connection;
    this.paused = false;
    this.authenticated = true;
    this.adopt(m);
    this.welcome(true);
    this.syncFused();
    void this.platform.apps().then((apps) => this.send({ t: "apps", apps })).catch(() => undefined);
    // Every window still open is announced again; those that closed meanwhile get `wclose`.
    this.resumeKnown = new Set([...this.windows.values()].filter((w) => w.streamed).map((w) => w.info.id));
    for (const state of this.windows.values()) state.streamed = false;
    this.lastLayout = "";
    this.ready();
    this.platform.watch((windows) => this.track(windows));
    this.log(`[fusion] session ${this.id} resumed`);
  }

  finish(reason: string, message?: string): void {
    if (this.ended) return;
    this.connection.send({ t: "bye", reason, ...(message ? { message } : {}) });
    this.end();
    setTimeout(() => this.connection.close("bye"), 200).unref?.();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.grace);
    this.clearAllExitTimers();
    this.media?.end();
    this.media = undefined;
    // Sizes the local computer changed go back; positions were never touched.
    for (const state of this.windows.values()) {
      if (state.original) this.platform.resize(state.info.id, state.original.w, state.original.h);
    }
    this.windows.clear();
    this.fusedApps.clear();
    if (this.ownsPlatform) {
      this.ownsPlatform = false;
      this.platform.setFused([]);
    }
    this.log(`[fusion] session ${this.id} ended`);
  }
}

function points(rect: Rect, scale: number): Rect {
  return { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale };
}

/** werift takes one URL a server, UDP only. */
function weriftServer(server: unknown): Array<{ urls: string; username?: string; credential?: string }> {
  const s = server as { urls?: string | string[]; username?: string; credential?: string };
  const urls = Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : [];
  return urls.filter((url) => !url.startsWith("turns:") && !/[?&]transport=tcp/.test(url))
    .map((urls) => ({ urls, ...(s.username && s.credential ? { username: s.username, credential: s.credential } : {}) }));
}

/** A Mac's ⌘ is Windows' Ctrl. Its Control key has no better home than Ctrl either. */
export function macShortcuts(event: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(event.m)) return event;
  const mapped = new Set((event.m as string[]).map((m) => (m === "cmd" ? "ctrl" : m)));
  return { ...event, m: [...mapped] };
}
