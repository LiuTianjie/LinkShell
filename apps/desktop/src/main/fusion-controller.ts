import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket as NetSocket } from "node:net";
import { join } from "node:path";
import { nativeImage, type WebContents } from "electron";
import { fusionSlug, isFusionSlug, pickDirectFusionHost } from "./fusion-probe.js";
import { FusionElectronHub, fusionIconFile } from "./fusion/electron-hub.js";
import type { Runtime } from "./runtime.js";

type FusionTunnelState = {
  tunnelId: string;
  server: NetServer;
  localPort: number;
  connections: Map<string, NetSocket>;
};

export interface FusionControllerDeps {
  mac: boolean;
  windows: boolean;
  runtime: Runtime;
  preload: string;
  homePath: () => string;
  appDataPath: () => string;
  pageURL: () => URL | undefined;
  isTrusted: (url: string) => boolean;
  send: (name: string, detail: unknown) => void;
}

function fusionSlugOf(params: Record<string, unknown>): string | undefined {
  if (typeof params.computerKey === "string" && params.computerKey) return fusionSlug(params.computerKey);
  return isFusionSlug(params.hostSlug) ? params.hostSlug : undefined;
}

function mapFusionCategory(raw: string): string {
  if (raw.includes("developer-tools")) return "开发工具";
  if (raw.includes("productivity") || raw.includes("finance") || raw.includes("business")) return "效率";
  if (raw.includes("utilities")) return "实用工具";
  if (raw.includes("social-networking")) return "社交";
  if (raw.includes("entertainment") || raw.includes("games") || raw.includes("music") || raw.includes("video")) return "娱乐";
  if (raw.includes("graphics-design") || raw.includes("photography")) return "创意";
  return "其他";
}

/**
 * Encapsulates Fusion Mode tunnels, Electron hubs, macOS FusionLocal IPC,
 * cached Stub bundle discovery, and icon thumbnails out of `main.ts`.
 */
export class FusionController {
  private readonly electronHubMode: boolean;
  private readonly tunnels = new Map<string, FusionTunnelState>();
  private readonly electronHubs = new Map<string, FusionElectronHub>();
  private readonly electronHubExits = new Map<string, { reason: string; message: string; at: number }>();

  constructor(private readonly deps: FusionControllerDeps) {
    this.electronHubMode = deps.windows || process.env.LINKSHELL_FUSION_HUB === "electron";
  }

  fromHubPage(sender: WebContents, body: Record<string, unknown>): void {
    for (const hub of this.electronHubs.values()) hub.fromPage(sender, body);
  }

  handleTunnelMessage(message: Record<string, unknown>): void {
    const tunnelId = typeof message.tunnelId === "string" ? message.tunnelId : "";
    const connId = typeof message.connId === "string" ? message.connId : "";
    const type = typeof message.type === "string" ? message.type : "";
    if (!tunnelId || !connId) return;
    let owner: FusionTunnelState | undefined;
    for (const state of this.tunnels.values()) {
      if (state.tunnelId === tunnelId) { owner = state; break; }
    }
    const sock = owner?.connections.get(connId);
    if (!sock) return;
    if (type === "data" && typeof message.data === "string") {
      sock.write(Buffer.from(message.data, "base64"));
    } else if (type === "close") {
      owner?.connections.delete(connId);
      sock.end();
    }
  }

  stopAll(): void {
    for (const hub of this.electronHubs.values()) hub.stop();
    this.electronHubs.clear();
    for (const state of this.tunnels.values()) {
      for (const sock of state.connections.values()) sock.destroy();
      state.connections.clear();
      state.server.close();
    }
    this.tunnels.clear();
  }

  private async ensureTunnel(computerKey: string): Promise<FusionTunnelState> {
    const existing = this.tunnels.get(computerKey);
    if (existing && existing.server.listening) return existing;
    if (existing) {
      for (const sock of existing.connections.values()) sock.destroy();
      existing.server.close();
      this.tunnels.delete(computerKey);
    }
    const tunnelId = randomUUID();
    const connections = new Map<string, NetSocket>();
    const tcpServer = createNetServer((sock) => {
      const connId = randomUUID();
      connections.set(connId, sock);
      sock.setNoDelay(true);
      this.deps.send("linkshell-fusion-tunnel", { tunnelId, connId, type: "open" });
      sock.on("data", (chunk: Buffer) => {
        this.deps.send("linkshell-fusion-tunnel", { tunnelId, connId, type: "data", data: chunk.toString("base64") });
      });
      const closed = () => {
        if (!connections.delete(connId)) return;
        this.deps.send("linkshell-fusion-tunnel", { tunnelId, connId, type: "close" });
      };
      sock.once("close", closed);
      sock.once("error", closed);
    });
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", () => {
        tcpServer.removeListener("error", reject);
        resolve();
      });
    });
    const localPort = (tcpServer.address() as AddressInfo).port;
    const state: FusionTunnelState = { tunnelId, server: tcpServer, localPort, connections };
    this.tunnels.set(computerKey, state);
    return state;
  }

  private spawnFusionLocal(helper: string, args: string[], token: string): void {
    const env: NodeJS.ProcessEnv = { ...process.env, LINKSHELL_HOME: this.deps.runtime.home, LINKSHELL_FUSION_TOKEN: token };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    spawn(helper, args, { detached: true, stdio: "ignore", env }).unref();
  }

  private ensureElectronHub(computerKey: string, name: string): FusionElectronHub {
    const existing = this.electronHubs.get(computerKey);
    if (existing?.running) return existing;
    const slug = fusionSlug(computerKey);
    const hub = new FusionElectronHub({
      computerKey,
      name,
      slug,
      home: this.deps.runtime.home,
      pageURL: this.deps.pageURL,
      preload: this.deps.preload,
      relaunch: { executable: process.execPath, args: (bundle) => ["--fusion-connect", computerKey, "--fusion-launch", bundle] },
      ...(this.deps.windows
        ? { shortcutDir: join(this.deps.appDataPath(), "Microsoft/Windows/Start Menu/Programs/LinkShell", name.replace(/[\\/:*?"<>|]/g, "_")) }
        : {}),
      isTrusted: this.deps.isTrusted,
      log: (line) => console.log(line),
    });
    hub.onExit = (reason, message) => {
      this.electronHubExits.set(slug, { reason, message, at: Date.now() });
      if (this.electronHubs.get(computerKey) === hub) this.electronHubs.delete(computerKey);
    };
    this.electronHubs.set(computerKey, hub);
    return hub;
  }

  async start(params: Record<string, unknown>) {
    if (!this.electronHubMode && (!this.deps.mac || !this.deps.runtime.helper || !existsSync(this.deps.runtime.helper))) {
      throw new Error("融合模式需要 macOS 或 Windows 桌面版 LinkShell");
    }
    const computerKey = typeof params.computerKey === "string" ? params.computerKey : "";
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "Remote";
    const port = Number(params.port);
    const token = typeof params.token === "string" ? params.token : "";
    const hosts = Array.isArray(params.hosts) ? params.hosts.filter((h): h is string => typeof h === "string" && h.length > 0) : [];
    const launchBundle = typeof params.launchBundle === "string" && params.launchBundle ? params.launchBundle : undefined;
    if (!computerKey || !token || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("远端融合模式连接信息无效");
    }
    const directHost = await pickDirectFusionHost(hosts, port);
    if (this.electronHubMode) {
      const hub = this.ensureElectronHub(computerKey, name);
      if (directHost) {
        hub.connect(directHost, port, token, launchBundle);
        return { mode: "direct" as const, host: directHost, port };
      }
      const tunnel = await this.ensureTunnel(computerKey);
      hub.connect("127.0.0.1", tunnel.localPort, token, launchBundle);
      return { mode: "tunnel" as const, tunnelId: tunnel.tunnelId, port: tunnel.localPort };
    }
    const helper = this.deps.runtime.helper;
    if (!helper) throw new Error("融合模式需要 macOS 或 Windows 桌面版 LinkShell");
    const extra = launchBundle ? ["--launch", launchBundle] : [];
    if (directHost) {
      this.spawnFusionLocal(helper, ["--fusion-local", "--host", directHost, "--port", String(port), "--name", name, "--computer-key", computerKey, ...extra], token);
      return { mode: "direct" as const, host: directHost, port };
    }
    const tunnel = await this.ensureTunnel(computerKey);
    this.spawnFusionLocal(helper, ["--fusion-local", "--host", "127.0.0.1", "--port", String(tunnel.localPort), "--name", name, "--computer-key", computerKey, ...extra], token);
    return { mode: "tunnel" as const, tunnelId: tunnel.tunnelId, port: tunnel.localPort };
  }

  private queryFusionSocket(hostSlug: string | undefined, payload: Record<string, unknown>, timeoutMs = 450): Promise<Record<string, unknown> | undefined> {
    if (!this.deps.mac || !isFusionSlug(hostSlug)) return Promise.resolve(undefined);
    const sockPath = join(this.deps.runtime.home, `fusion-${hostSlug}.sock`);
    if (!existsSync(sockPath)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      let buf = "";
      const sock = createConnection(sockPath);
      const finish = (value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      sock.once("connect", () => sock.write(JSON.stringify(payload) + "\n"));
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          try { finish(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); }
          catch { finish(undefined); }
        }
      });
      sock.once("error", () => finish(undefined));
      sock.once("end", () => finish(undefined));
    });
  }

  private async readCachedState(name: string, hostSlug: string) {
    const { readdir, readFile } = await import("node:fs/promises");
    const iconDir = join(this.deps.runtime.home, "fusion-icons", hostSlug);
    const appsDir = join(this.deps.homePath(), "Applications/LinkShell", name);
    const iconBundles: string[] = [];
    try {
      for (const file of await readdir(iconDir)) {
        if (file.endsWith(".png")) iconBundles.push(file.slice(0, -4));
      }
    } catch { /* No icon cache yet. */ }

    const isOwnFusionBundle = (bundle: unknown) =>
      typeof bundle === "string" && (bundle.startsWith("LinkShell.") || bundle.startsWith("com.bd.linkshell."));
    try {
      const raw = JSON.parse(await readFile(join(iconDir, "catalog.json"), "utf8")) as {
        apps?: Array<Record<string, unknown>>;
        appsDir?: string;
      };
      const filtered = Array.isArray(raw.apps) ? raw.apps.filter((item) => !isOwnFusionBundle(item?.bundle)) : [];
      if (filtered.length > 0) {
        return {
          appsDir: typeof raw.appsDir === "string" && raw.appsDir ? raw.appsDir : appsDir,
          iconBundles,
          apps: filtered,
        };
      }
    } catch { /* Fall back to scanning Stub bundles. */ }

    const fallbackApps: Array<Record<string, unknown>> = [];
    try {
      const entries = await readdir(appsDir);
      const suffix = ` · ${name}`;
      for (const entry of entries) {
        if (!entry.endsWith(".app")) continue;
        const appPath = join(appsDir, entry);
        try {
          const xml = await readFile(join(appPath, "Contents/Info.plist"), "utf8");
          const field = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1]?.trim() ?? "";
          const bundle = field("LSFusionBundleID");
          if (!bundle || isOwnFusionBundle(bundle)) continue;
          const display = field("CFBundleDisplayName") || entry.slice(0, -4);
          const cleanName = display.endsWith(suffix) ? display.slice(0, -suffix.length) : display;
          const rawCategory = field("LSApplicationCategoryType");
          fallbackApps.push({ name: cleanName, bundle, category: mapFusionCategory(rawCategory), rawCategory, isSystem: false, stubPath: appPath });
        } catch { /* Ignore partial bundle. */ }
      }
    } catch { /* No Stub directory yet. */ }
    return { appsDir, iconBundles, apps: fallbackApps };
  }

  private async readFusionExit(hostSlug: string): Promise<Record<string, unknown> | undefined> {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = JSON.parse(await readFile(join(this.deps.runtime.home, `fusion-${hostSlug}.status.json`), "utf8")) as Record<string, unknown>;
      return raw && typeof raw === "object" ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  async state(params: Record<string, unknown>) {
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "Remote";
    const computerKey = typeof params.computerKey === "string" ? params.computerKey : "";
    const hostSlug = fusionSlugOf(params) ?? fusionSlug(name);
    const hub = computerKey ? this.electronHubs.get(computerKey) : undefined;
    const live = hub?.running ? hub.status() : await this.queryFusionSocket(hostSlug, { t: "status" });
    const lastExit = live ? undefined : (this.electronHubExits.get(hostSlug) ?? await this.readFusionExit(hostSlug));
    const cached = (!live || !Array.isArray(live.apps) || live.apps.length === 0)
      ? await this.readCachedState(name, hostSlug)
      : undefined;
    return {
      hubRunning: Boolean(live),
      connected: live?.connected === true,
      reconnecting: live?.reconnecting === true,
      rttMs: typeof live?.rttMs === "number" ? live.rttMs : undefined,
      hostLabel: typeof live?.hostLabel === "string" ? live.hostLabel : name,
      hostSlug,
      appsDir: typeof live?.appsDir === "string" ? live.appsDir : (cached?.appsDir ?? join(this.deps.homePath(), "Applications/LinkShell", name)),
      statusText: typeof live?.statusText === "string" ? live.statusText : undefined,
      activeBundles: Array.isArray(live?.activeBundles) ? live.activeBundles : [],
      windowCounts: live?.windowCounts && typeof live.windowCounts === "object" ? live.windowCounts : {},
      iconBundles: Array.isArray(live?.iconBundles) && live.iconBundles.length > 0 ? live.iconBundles : (cached?.iconBundles ?? []),
      apps: Array.isArray(live?.apps) && live.apps.length > 0 ? live.apps : (cached?.apps ?? []),
      alerts: Array.isArray(live?.alerts) ? live.alerts : [],
      lastExit,
    };
  }

  async icons(params: Record<string, unknown>) {
    if (!this.deps.mac && !this.electronHubMode) return { icons: {} };
    const { readFile } = await import("node:fs/promises");
    const hostSlug = fusionSlugOf(params);
    if (!hostSlug) return { icons: {} };
    const bundles = Array.isArray(params.bundles)
      ? params.bundles.filter((b): b is string => typeof b === "string" && b.length > 0).slice(0, 48)
      : [];
    const iconDir = join(this.deps.runtime.home, "fusion-icons", hostSlug);
    const icons: Record<string, { src: string; badged: boolean }> = {};
    for (const bundle of bundles) {
      const safe = fusionIconFile(bundle);
      try {
        const bytes = await readFile(join(iconDir, "ui", `${safe}.png`));
        icons[bundle] = { src: `data:image/png;base64,${bytes.toString("base64")}`, badged: true };
        continue;
      } catch { /* Fall back to raw cached PNG. */ }
      const rawPath = join(iconDir, `${safe}.png`);
      if (existsSync(rawPath)) {
        try {
          const img = nativeImage.createFromPath(rawPath);
          if (!img.isEmpty()) {
            const resized = img.resize({ width: 144, height: 144, quality: "best" }).toPNG();
            icons[bundle] = { src: `data:image/png;base64,${resized.toString("base64")}`, badged: false };
          }
        } catch { /* Ignore unreadable icon. */ }
      }
    }
    return { icons };
  }

  async control(params: Record<string, unknown>, type: "launchApp" | "quitApp") {
    const hostSlug = fusionSlugOf(params);
    const bundle = typeof params.bundle === "string" ? params.bundle : "";
    if (!bundle) throw new Error("缺少目标应用标识");
    const hub = typeof params.computerKey === "string" ? this.electronHubs.get(params.computerKey) : undefined;
    if (hub?.running) {
      if (type === "launchApp") hub.launchApp(bundle); else hub.quitApp(bundle, params.force === true);
      return { ok: true };
    }
    const reply = await this.queryFusionSocket(hostSlug, { t: type, bundle, force: params.force === true });
    return { ok: Boolean(reply) };
  }

  async stop(params: Record<string, unknown>) {
    const hostSlug = fusionSlugOf(params);
    const computerKey = typeof params.computerKey === "string" ? params.computerKey : "";
    const hub = computerKey ? this.electronHubs.get(computerKey) : undefined;
    if (hub) { hub.stop(); this.electronHubs.delete(computerKey); }
    else await this.queryFusionSocket(hostSlug, { t: "stopHub" });
    const tunnel = computerKey ? this.tunnels.get(computerKey) : undefined;
    if (tunnel) {
      for (const sock of tunnel.connections.values()) sock.destroy();
      tunnel.connections.clear();
      tunnel.server.close();
      this.tunnels.delete(computerKey);
    }
    return { ok: true };
  }
}
