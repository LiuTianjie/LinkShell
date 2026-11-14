import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientState, ClientStore, HostLink, HostStreams } from "@linkshell/client-core";
import {
  DESKTOP_FULLSCREEN_EVENT,
  DESKTOP_NATIVE_SCREEN_EVENT,
  DESKTOP_REPLY_EVENT,
} from "../src/bridge/desktop-bridge";
import { getOpenOverlayRects, hasOpenOverlay } from "../src/bridge/top-layer-registry";
import type { Computer, Connection, SessionSubscriptions } from "../src/core/connections";
import { engine } from "../src/core/engine";
import { fusionStore, type FusionComputerState } from "../src/core/fusion-store";
import { setDesktopLocalePreference } from "../src/core/i18n";
import { routerStore } from "../src/core/router-store";
import { screenPreferencesStore } from "../src/core/screen-client";
import { DESKTOP_LOCAL } from "../src/core/storage";
import {
  FusionQuickTrigger,
  FusionStatusBadge,
  FusionWorkspace,
  RemoteScreenWorkspace,
} from "../src/features/remote";
import { RemoteModeSwitch } from "../src/features/remote/FusionControls";
import { DialogProvider } from "../src/primitives";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface PostedBridgeMessage {
  action?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
  rect?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
}

function makeMockComputer(
  key: string,
  platform: "darwin" | "win32" | "linux",
  name: string,
  online = true,
): Computer {
  return {
    key,
    gateway: key === DESKTOP_LOCAL ? DESKTOP_LOCAL : "wss://gateway.itool.tech",
    machine: {
      id: `machine-${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      platform,
      online,
      via: "account",
    },
  };
}

function makeMockConnection(
  computer: Computer,
  rpcHandler?: (method: string, params: unknown) => Promise<unknown>,
): Connection {
  const store = createStore<ClientState>(() => ({
    status: computer.machine.online ? "online" : "offline",
    machine: {
      id: computer.machine.id,
      hostname: computer.machine.name,
      platform: computer.machine.platform ?? "darwin",
      arch: "arm64",
      homedir: "/Users/dev",
      protocolVersion: 3,
    },
    agents: [],
    sessions: {},
    timelines: {},
    connect: () => {},
    disconnect: () => {},
    openSession: () => {},
    closeSession: () => {},
  })) as unknown as ClientStore;

  const link = {
    status: computer.machine.online ? "online" : "offline",
    call: vi.fn(async (method: string, params: unknown) => {
      if (rpcHandler) return rpcHandler(method, params);
      if (method === "screen.access") {
        return { supported: true, recording: true, control: true };
      }
      if (method === "screen.start") {
        // Keep unresolved unless test drives full WebSocket handshake.
        return new Promise(() => {});
      }
      return {};
    }),
    reconnectNow: vi.fn(),
  } as unknown as HostLink;

  const streams = {
    start: vi.fn(),
    stop: vi.fn(),
    connect: vi.fn(),
  } as unknown as HostStreams;

  const sessions = {
    acquire: () => () => {},
    evict: () => {},
    close: () => {},
  } as unknown as SessionSubscriptions;

  return {
    computer,
    link,
    streams,
    store,
    sessions,
  };
}

function seedFusionComputer(
  computerKey: string,
  patch: Partial<FusionComputerState>,
): void {
  fusionStore.setState((prev) => ({
    byComputer: {
      ...prev.byComputer,
      [computerKey]: {
        phase: "idle",
        hubRunning: false,
        connected: false,
        hostLabel: "",
        hostSlug: "",
        appsDir: "",
        activeBundles: [],
        windowCounts: {},
        apps: [],
        icons: {},
        busyBundles: {},
        ...(prev.byComputer[computerKey] ?? {}),
        ...patch,
      },
    },
  }));
}

describe("Slice 2B-4: Fusion Launchpad & Unified Remote Screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  let postedMessages: PostedBridgeMessage[];

  function installPreloadBridge(
    platform: "darwin" | "win32",
    invokeResponder?: (
      method: string,
      params: Record<string, unknown>,
    ) => unknown,
  ) {
    postedMessages = [];
    window.linkshellDesktop = {
      shell: "electron",
      platform,
      visible: () => true,
      postMessage: (msg: Record<string, unknown>) => {
        postedMessages.push(msg as PostedBridgeMessage);
        if (msg.action === "invoke" && typeof msg.id === "string") {
          const method = String(msg.method ?? "");
          const params = (msg.params as Record<string, unknown>) ?? {};
          const result = invokeResponder
            ? invokeResponder(method, params)
            : method === "fusionState"
              ? {
                  running: false,
                  connected: false,
                  apps: [],
                  activeBundles: [],
                  windowCounts: {},
                }
              : {};
          queueMicrotask(() => {
            window.dispatchEvent(
              new CustomEvent(DESKTOP_REPLY_EVENT, {
                detail: { id: msg.id, result },
              }),
            );
          });
        }
      },
    };
  }

  beforeEach(() => {
    setDesktopLocalePreference("zh");
    fusionStore.setState({ byComputer: {} });
    routerStore.setState({
      activeRoute: { kind: "home" },
      history: [{ kind: "home" }],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
    });
    screenPreferencesStore.setState({
      width: "auto",
      maxFps: "120",
      codec: "auto",
      pacing: "immediate",
      control: true,
      mode: "view",
      byComputer: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete window.linkshellDesktop;
    engine.state.setState({
      computers: [],
      localComputer: undefined,
      connection: undefined,
    });
    expect(hasOpenOverlay()).toBe(false);
    vi.restoreAllMocks();
  });

  it("enforces @layer components, zero !important, overflow: clip, :focus-within parity, and collapsed-sidebar traffic-light clearance in remote.css", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/styles/remote.css"),
      "utf8",
    );
    expect(css.trimStart().startsWith("@layer components")).toBe(true);
    expect(css).not.toContain("!important");
    expect(css).not.toContain("overflow: hidden");
    expect(css).toContain(".ls-fusion-app-card:hover .ls-fusion-app-card__quick");
    expect(css).toContain(
      ".ls-fusion-app-card:focus-within .ls-fusion-app-card__quick",
    );
    expect(css).toContain("padding-inline-start: var(--titlebar-left-inset, 84px)");
    expect(css).toContain("--ls-win-caption-w");
    expect(css).toContain(".ls-screen-stage-viewport");
    // Closed `[popover]` must never receive unconditional author `display: flex` (Chromium 152 UA override bug)
    const rootPopoverRule = css.match(/\.ls-remote-popover-panel\s*\{([^}]*)\}/);
    expect(rootPopoverRule).not.toBeNull();
    expect(rootPopoverRule?.[1]).not.toContain("display:");
    expect(css).toContain(
      '.ls-remote-popover-panel:is(:popover-open, [data-state="open"])',
    );
  });

  it("renders standalone single-bar .chrome-bar header on RemoteScreenWorkspace (no RemoteModeSwitch) and zero .chrome-bar inside FusionWorkspace", async () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#header-audit",
      "darwin",
      "MacBook Pro",
    );
    const mockConn = makeMockConnection(remoteMac);
    engine.state.setState({
      computers: [remoteMac],
      connection: mockConn,
    });
    installPreloadBridge("darwin");

    await act(async () => {
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });
    expect(container.querySelector(".chrome-bar")).toBeNull();
    expect(container.querySelector(".desktop-main-header")).toBeNull();
    expect(container.querySelector(".ls-remote-subbar")).not.toBeNull();

    await act(async () => {
      routerStore.setState({ sidebarHidden: true });
      root.render(
        <DialogProvider>
          <RemoteScreenWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });
    expect(container.querySelectorAll(".chrome-bar")).toHaveLength(1);
    expect(container.querySelector(".desktop-main-header")).toBeNull();
    expect(container.querySelector(".ls-remote-mode-switch")).toBeNull();
    const subbar = container.querySelector(".ls-remote-subbar");
    expect(subbar?.getAttribute("data-standalone-chrome")).toBe("true");
    expect(subbar?.getAttribute("data-sidebar-hidden")).toBe("true");
    expect(subbar?.textContent).toContain("远程屏幕");
    expect(subbar?.textContent).toContain("MacBook Pro");
    expect(
      subbar?.querySelector('button[aria-label="后退"]'),
    ).not.toBeNull();
    expect(
      subbar?.querySelector('button[aria-label="前进"]'),
    ).not.toBeNull();
    expect(
      subbar?.querySelector('[data-icon="sidebar-toggle"]'),
    ).not.toBeNull();
    act(() => {
      routerStore.setState({ sidebarHidden: false });
    });
  });

  it("renders FusionStatusBadge only when starting or connected, displaying transport, RTT and window count", () => {
    const macKey = "wss://gateway.itool.tech#mac-studio";
    installPreloadBridge("darwin");

    act(() => {
      root.render(<FusionStatusBadge computerKey={macKey} />);
    });
    expect(container.textContent).toBe("");

    act(() => {
      seedFusionComputer(macKey, {
        phase: "connected",
        hubRunning: true,
        connected: true,
        mode: "direct",
        rttMs: 4.2,
        activeBundles: ["com.apple.dt.Xcode"],
        windowCounts: { "com.apple.dt.Xcode": 3 },
      });
    });

    const badge = container.querySelector<HTMLButtonElement>(
      ".ls-fusion-status-badge",
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("融合中");
    expect(badge?.textContent).toContain("直连");
    expect(badge?.textContent).toContain("4ms");
    expect(badge?.textContent).toContain("3");

    act(() => {
      badge?.click();
    });
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "fusion",
      computerKey: macKey,
    });
  });

  it("handles FusionQuickTrigger capability boundaries across Local, Windows client, Linux remote, and Mac→Mac", () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#mac-pro",
      "darwin",
      "Studio Mac",
    );
    const remoteWin = makeMockComputer(
      "wss://gateway.itool.tech#win-workstation",
      "win32",
      "Windows RTX",
    );
    const localMac = makeMockComputer(DESKTOP_LOCAL, "darwin", "This Mac");

    engine.state.setState({
      computers: [localMac, remoteMac, remoteWin],
      localComputer: localMac,
    });

    // 1. Hidden on desktop:local
    installPreloadBridge("darwin");
    act(() => {
      root.render(<FusionQuickTrigger computerKey={DESKTOP_LOCAL} compact />);
    });
    expect(container.querySelector("button")).toBeNull();

    // 2. Hidden on Windows client -> Windows remote
    installPreloadBridge("win32");
    act(() => {
      root.render(<FusionQuickTrigger computerKey={remoteWin.key} compact />);
    });
    expect(container.querySelector("button")).toBeNull();

    // 3. Hidden on Windows client -> Mac remote (no dead Fusion trigger outside RemoteModeSwitch)
    act(() => {
      root.render(<FusionQuickTrigger computerKey={remoteMac.key} />);
    });
    expect(container.querySelector("button")).toBeNull();

    // 3b. RemoteModeSwitch on Windows client -> Mac remote keeps disabled Fusion tab + tooltip explanation
    act(() => {
      root.render(
        <RemoteModeSwitch computerKey={remoteMac.key} activeMode="screen" />,
      );
    });
    const winSwitchFusionBtn = container.querySelector<HTMLButtonElement>(
      'button[data-mode="fusion"]',
    );
    expect(winSwitchFusionBtn?.disabled).toBe(true);
    expect(container.querySelector('[popover="hint"]')?.textContent).toContain(
      "macOS",
    );

    // 3c. Disabled with popover="hint" explanation on Mac client -> Windows remote
    installPreloadBridge("darwin");
    act(() => {
      root.render(<FusionQuickTrigger computerKey={remoteWin.key} />);
    });
    const macToWinDisabledBtn = container.querySelector("button");
    expect(macToWinDisabledBtn?.disabled).toBe(true);
    expect(container.querySelector('[popover="hint"]')?.textContent).toContain(
      "macOS",
    );

    // 4. Enabled on Mac client -> Mac remote
    act(() => {
      root.render(<FusionQuickTrigger computerKey={remoteMac.key} />);
    });
    const macBtn = container.querySelector("button");
    expect(macBtn?.disabled).toBe(false);
    act(() => {
      macBtn?.click();
    });
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "fusion",
      computerKey: remoteMac.key,
    });
  });

  it("renders FusionWorkspace Launchpad catalog, category tabs, search filter, active fused windows, and launch/quit actions", async () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#mac-mini",
      "darwin",
      "Mac mini M4",
    );
    const mockConn = makeMockConnection(remoteMac);
    engine.state.setState({
      computers: [remoteMac],
      connection: mockConn,
    });

    const invokedMethods: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [];

    installPreloadBridge("darwin", (method, params) => {
      invokedMethods.push({ method, params });
      if (method === "fusionState") {
        return {
          running: true,
          connected: true,
          hostLabel: "Mac mini M4",
          hostSlug: "mac-mini-m4",
          appsDir: "/Users/dev/Applications/LinkShell (Mac mini M4)",
          activeBundles: ["com.apple.dt.Xcode"],
          windowCounts: { "com.apple.dt.Xcode": 2 },
          apps: [
            {
              name: "Xcode",
              bundle: "com.apple.dt.Xcode",
              category: "开发工具",
              rawCategory: "public.app-category.developer-tools",
            },
            {
              name: "Figma",
              bundle: "com.figma.Desktop",
              category: "创意",
              rawCategory: "public.app-category.graphics-design",
            },
          ],
        };
      }
      if (method === "fusionIcons") {
        return {
          icons: {
            "com.apple.dt.Xcode": {
              src: "data:image/png;base64,iVBORw0KGgo=",
              badged: true,
            },
          },
        };
      }
      return { ok: true };
    });

    seedFusionComputer(remoteMac.key, {
      phase: "connected",
      mode: "direct",
      rttMs: 5,
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Active fused windows strip shows Xcode with 2 windows
    const activeSection = container.querySelector(".ls-fusion-active-section");
    expect(activeSection).not.toBeNull();
    expect(activeSection?.textContent).toContain("Xcode");
    expect(activeSection?.textContent).toContain("2 个窗口");

    // Catalog grid shows both Xcode and Figma
    expect(container.querySelectorAll(".ls-fusion-app-card").length).toBe(2);

    // Clicking Figma card launches com.figma.Desktop via bridge invoke("fusionLaunchApp")
    const figmaLaunchBtn = container.querySelector<HTMLButtonElement>(
      '[data-bundle="com.figma.Desktop"] .ls-fusion-app-card__launch',
    );
    expect(figmaLaunchBtn).not.toBeNull();
    await act(async () => {
      figmaLaunchBtn?.click();
      await Promise.resolve();
    });
    expect(
      invokedMethods.some(
        (call) =>
          call.method === "fusionLaunchApp" &&
          call.params.bundle === "com.figma.Desktop",
      ),
    ).toBe(true);

    // Clicking Quit in Active Fused Windows strip invokes "fusionQuitApp" for com.apple.dt.Xcode
    const activeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".ls-fusion-active-card__actions button",
      ),
    );
    const quitBtn = activeButtons.find((btn) =>
      btn.textContent?.includes("退出应用"),
    );
    expect(quitBtn).toBeDefined();
    await act(async () => {
      quitBtn?.click();
      await Promise.resolve();
    });
    expect(
      invokedMethods.some(
        (call) =>
          call.method === "fusionQuitApp" &&
          call.params.bundle === "com.apple.dt.Xcode",
      ),
    ).toBe(true);

    // Search filtering narrows catalog cleanly
    const searchInput = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    expect(searchInput).not.toBeNull();
    await act(async () => {
      const nativeValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeValueSetter?.call(searchInput, "Figma");
      searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".ls-fusion-app-card").length).toBe(1);
    expect(
      container.querySelector('[data-bundle="com.figma.Desktop"]'),
    ).not.toBeNull();
  });

  it("renders self-explanatory capability EmptyState on Windows client and step-by-step permission remediation on macOS", async () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#studio-perm",
      "darwin",
      "Remote Studio",
    );
    const mockConn = makeMockConnection(remoteMac);
    engine.state.setState({
      computers: [remoteMac],
      connection: mockConn,
    });

    // 1. Windows client -> clear capability explanation + 1-click switch to Full Desktop
    installPreloadBridge("win32");
    await act(async () => {
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("当前环境暂不支持融合模式");
    const switchBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-empty-state__actions button"),
    )[0];
    expect(switchBtn?.textContent).toContain("切换至完整桌面");
    act(() => {
      switchBtn?.click();
    });
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "screen",
      computerKey: remoteMac.key,
    });

    // 2. macOS client with Screen Recording permission error -> step-by-step remediation banner
    installPreloadBridge("darwin");
    await act(async () => {
      seedFusionComputer(remoteMac.key, {
        phase: "error",
        error: "需要屏幕录制权限才能启动融合窗口捕获",
      });
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const remediation = container.querySelector(".ls-remote-remediation");
    expect(remediation).not.toBeNull();
    expect(remediation?.textContent).toContain("需要远端 Mac 授权屏幕录制");
    expect(remediation?.textContent).toContain("系统设置 → 隐私与安全性 → 屏幕录制");
  });

  // Replaces the old "auto-starts on mount" case, which asserted the behaviour B16 removes:
  // merely viewing the page hid the remote Dock and added virtual displays on the remote Mac.
  it("never starts Fusion just because the page is open; one primary start button does", async () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#headless-autostart",
      "darwin",
      "Remote M3 Max",
    );
    const mockConn = makeMockConnection(remoteMac, async (method) => {
      if (method === "fusion.start") {
        return { port: 51900, token: "tok-headless", hosts: ["192.168.1.90"] };
      }
      return {};
    });
    engine.state.setState({
      computers: [remoteMac],
      connection: mockConn,
    });

    const invoked: string[] = [];
    installPreloadBridge("darwin", (method) => {
      invoked.push(method);
      if (method === "fusionStart") {
        return { mode: "direct", host: "192.168.1.90", port: 9300 };
      }
      if (method === "fusionState") {
        return {
          hubRunning: false,
          connected: false,
          apps: [],
          activeBundles: [],
          windowCounts: {},
        };
      }
      return {};
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockConn.link.call).not.toHaveBeenCalledWith("fusion.start", {});
    expect(invoked).not.toContain("fusionStart");
    const offState = container.querySelector(".ls-fusion-catalog .ls-empty-state");
    expect(offState?.textContent).toContain("融合模式未开启");
    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(searchInput?.placeholder).toBe("搜索应用名称");

    const startButton = Array.from(offState?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
      button.textContent?.includes("开启融合模式"),
    );
    expect(startButton).toBeDefined();
    await act(async () => {
      startButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockConn.link.call).toHaveBeenCalledWith("fusion.start", {});
    expect(invoked).toContain("fusionStart");
  });

  it("renders each hub alert with its own remedy, and the remote lock alert offers Full Desktop", async () => {
    const remoteMac = makeMockComputer("wss://gateway.itool.tech#alerts", "darwin", "Alert Mac");
    const mockConn = makeMockConnection(remoteMac);
    engine.state.setState({ computers: [remoteMac], connection: mockConn });
    installPreloadBridge("darwin", (method) =>
      method === "fusionState"
        ? {
            hubRunning: true,
            connected: true,
            hostSlug: "25b8b967c6e4",
            apps: [{ name: "Xcode", bundle: "com.apple.dt.Xcode" }],
            activeBundles: [],
            windowCounts: {},
            alerts: [
              { kind: "accessibility", message: "远程电脑尚未允许控制" },
              { kind: "locked", message: "远端 Mac 处于锁屏状态" },
              { kind: "launch", subject: "com.apple.dt.Xcode", message: "远端应用启动失败：not found" },
              { kind: "something-new", message: "未知问题" },
            ],
          }
        : {},
    );
    seedFusionComputer(remoteMac.key, { phase: "connected", connected: true, hubRunning: true });
    await act(async () => {
      root.render(
        <DialogProvider>
          <FusionWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".ls-fusion-alert"));
    expect(rows.map((row) => row.dataset.kind)).toEqual(["accessibility", "locked", "launch", "generic"]);
    expect(rows[0]?.textContent).toContain("辅助功能");
    expect(rows[2]?.textContent).toContain("Xcode");
    expect(rows[2]?.textContent).toContain("not found");
    const lockButton = rows[1]?.querySelector<HTMLButtonElement>("button");
    expect(lockButton?.textContent).toContain("切换至完整桌面");
    act(() => {
      lockButton?.click();
    });
    expect(routerStore.getState().activeRoute).toEqual({ kind: "screen", computerKey: remoteMac.key });
  });

  it("exposes Codec selector on macOS RemoteScreenWorkspace, keeps Native Metal stage rect live with cutout holes when Popover opens, and sends in-band pacing without restarting", async () => {
    const remoteMac = makeMockComputer(
      "wss://gateway.itool.tech#studio-display",
      "darwin",
      "Mac Studio",
    );
    const mockConn = makeMockConnection(remoteMac);
    engine.state.setState({
      computers: [remoteMac],
      connection: mockConn,
    });
    routerStore.getState().openScreen(remoteMac.key);
    installPreloadBridge("darwin");

    // Mock non-zero bounding rects on the native Metal stage viewport and open Popover panels.
    const origGetBcr = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList?.contains("ls-screen-stage-viewport")) {
          return {
            x: 40,
            y: 46,
            left: 40,
            top: 46,
            right: 1240,
            bottom: 726,
            width: 1200,
            height: 680,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (
          this.classList?.contains("ls-remote-popover-panel") &&
          this.getAttribute("data-state") === "open"
        ) {
          return {
            x: 910,
            y: 48,
            left: 910,
            top: 48,
            right: 1210,
            bottom: 348,
            width: 300,
            height: 300,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return origGetBcr.call(this);
      },
    );

    await act(async () => {
      root.render(
        <DialogProvider>
          <RemoteScreenWorkspace computerKey={remoteMac.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });

    const startMessagesBefore = postedMessages.filter(
      (m) => m.action === "screen" && m.type === "start",
    );
    expect(startMessagesBefore).toHaveLength(1);
    const startMsg = startMessagesBefore[0];
    expect(startMsg?.rect).toEqual({
      x: 40,
      y: 46,
      width: 1200,
      height: 680,
    });

    // Click Quality & Codec button -> opens Popover -> Metal rect stays 1200x680 with cutout holes & overlayOpen: true!
    const qualityTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="画面与编码设置"]',
    );
    expect(qualityTrigger).not.toBeNull();

    await act(async () => {
      qualityTrigger?.click();
      await Promise.resolve();
    });

    const metalViewport = container.querySelector('[data-stage-engine="metal"]');
    expect(metalViewport?.getAttribute("data-overlay-yielded")).toBe("true");
    expect(getOpenOverlayRects()).toEqual([
      expect.objectContaining({
        x: 910,
        y: 48,
        width: 300,
        height: 300,
      }),
    ]);

    const layoutMessages = postedMessages.filter(
      (m) => m.action === "screen" && m.type === "layout",
    );
    const openPopoverLayout = layoutMessages.at(-1);
    expect(openPopoverLayout?.rect).toEqual({
      x: 40,
      y: 46,
      width: 1200,
      height: 680,
    });
    expect(openPopoverLayout?.overlayOpen).toBe(true);
    expect(openPopoverLayout?.holes).toEqual([
      expect.objectContaining({
        x: 910,
        y: 48,
        width: 300,
        height: 300,
      }),
    ]);

    // Changing pacing choice sends in-band `pacing` command WITHOUT restarting `screen` session!
    const selects = Array.from(container.querySelectorAll("select"));
    const pacingSelect = selects.find((sel) =>
      Array.from(sel.options).some((opt) => opt.value === "smooth"),
    );
    expect(pacingSelect).toBeDefined();
    await act(async () => {
      if (pacingSelect) {
        pacingSelect.value = "smooth";
        pacingSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(
      postedMessages.some(
        (m) => m.action === "screen" && m.type === "pacing" && m.smooth === true,
      ),
    ).toBe(true);
    expect(
      postedMessages.filter((m) => m.action === "screen" && m.type === "start"),
    ).toHaveLength(1);

    // Verify Codec selector (Auto HEVC / H.264) is rendered and interactive on macOS!
    const codecSelect = selects.find((sel) =>
      Array.from(sel.options).some((opt) => opt.value === "h264"),
    );
    expect(codecSelect).toBeDefined();

    await act(async () => {
      if (codecSelect) {
        codecSelect.value = "h264";
        codecSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(screenPreferencesStore.getState().codec).toBe("h264");

    // Closing the Quality Popover clears overlayOpen and restores empty holes!
    await act(async () => {
      qualityTrigger?.click();
      await Promise.resolve();
    });

    expect(metalViewport?.getAttribute("data-overlay-yielded")).toBeNull();
    const afterCloseLayouts = postedMessages.filter(
      (m) => m.action === "screen" && m.type === "layout",
    );
    expect(afterCloseLayouts.at(-1)?.rect).toEqual({
      x: 40,
      y: 46,
      width: 1200,
      height: 680,
    });
    expect(afterCloseLayouts.at(-1)?.overlayOpen).toBe(false);
    expect(afterCloseLayouts.at(-1)?.holes).toEqual([]);
  });

  it("toggles RemoteScreenWorkspace fullscreen cleanly via both the HUD button and Escape key on macOS Metal and WebRTC stages", async () => {
    const remoteWin = makeMockComputer(
      "wss://gateway.itool.tech#win-fullscreen",
      "win32",
      "Windows Studio",
    );
    const mockConn = makeMockConnection(remoteWin);
    engine.state.setState({
      computers: [remoteWin],
      connection: mockConn,
    });
    routerStore.getState().openScreen(remoteWin.key);

    // Part 1: macOS client (NativeMetalStage + immersive simpleFullScreen + native HUD exit + Escape)
    installPreloadBridge("darwin");
    await act(async () => {
      root.render(
        <DialogProvider>
          <RemoteScreenWorkspace computerKey={remoteWin.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });

    const macEnterBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="全屏观看"]',
    );
    expect(macEnterBtn).not.toBeNull();
    expect(macEnterBtn?.nextElementSibling?.textContent).toContain("⌃⌘F");
    act(() => {
      macEnterBtn?.click();
      window.dispatchEvent(
        new CustomEvent(DESKTOP_FULLSCREEN_EVENT, {
          detail: { fullscreen: true },
        }),
      );
    });

    const enterFsMsg = postedMessages.find(
      (m) => m.action === "screenFullScreen" && m.enabled === true,
    );
    expect(enterFsMsg?.immersive).toBe(true);

    const macSection = container.querySelector(".ls-remote-workspace");
    expect(macSection?.getAttribute("data-fullscreen-stage")).toBe("true");

    // Native AppKit DesktopFullScreenOverlay clicking "退出全屏" emits exitFullScreen: true
    const nativeStart = postedMessages.find(
      (m) => m.action === "screen" && m.type === "start",
    );
    expect(nativeStart?.id).toBeTypeOf("string");
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DESKTOP_NATIVE_SCREEN_EVENT, {
          detail: {
            id: nativeStart?.id,
            type: "status",
            status: { exitFullScreen: true },
          },
        }),
      );
    });
    expect(macSection?.getAttribute("data-fullscreen-stage")).toBeNull();

    // Part 2: WebRTC stage (Windows client -> DOM fullscreen HUD dock + Popover Escape priority + HUD Exit button)
    installPreloadBridge("win32");
    await act(async () => {
      root.render(
        <DialogProvider>
          <RemoteScreenWorkspace computerKey={remoteWin.key} />
        </DialogProvider>,
      );
      await Promise.resolve();
    });

    const enterBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="全屏观看"]',
    );
    expect(enterBtn).not.toBeNull();
    const winTipText = enterBtn?.nextElementSibling?.textContent ?? "";
    expect(winTipText).toContain("F11");
    expect(winTipText).not.toContain("Ctrl+Ctrl+F");
    act(() => {
      enterBtn?.click();
      window.dispatchEvent(
        new CustomEvent(DESKTOP_FULLSCREEN_EVENT, {
          detail: { fullscreen: true },
        }),
      );
    });

    const section = container.querySelector(".ls-remote-workspace");
    expect(section?.getAttribute("data-fullscreen-stage")).toBe("true");

    // HUD dock is auto-revealed on entry and exposes Exit Fullscreen button
    const dock = container.querySelector(".ls-screen-fullscreen-dock");
    expect(dock?.getAttribute("data-revealed")).toBe("true");

    // Open Quality Popover inside fullscreen HUD -> Escape closes Popover FIRST, keeping fullscreen active
    const qualityBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="画面与编码设置"]',
    );
    act(() => {
      qualityBtn?.click();
    });
    expect(hasOpenOverlay()).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(hasOpenOverlay()).toBe(false);
    expect(section?.getAttribute("data-fullscreen-stage")).toBe("true");

    // Second Escape (with no overlay open) cleanly exits fullscreen!
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(section?.getAttribute("data-fullscreen-stage")).toBeNull();
    expect(
      postedMessages.some(
        (m) => m.action === "screenFullScreen" && m.enabled === false,
      ),
    ).toBe(true);

    // Re-enter fullscreen and exit via the HUD Exit Fullscreen button
    const enterAgainBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="全屏观看"]',
    );
    act(() => {
      enterAgainBtn?.click();
      window.dispatchEvent(
        new CustomEvent(DESKTOP_FULLSCREEN_EVENT, {
          detail: { fullscreen: true },
        }),
      );
    });
    expect(section?.getAttribute("data-fullscreen-stage")).toBe("true");

    const exitHudBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="退出全屏"]',
    );
    expect(exitHudBtn).not.toBeNull();
    act(() => {
      exitHudBtn?.click();
    });
    expect(section?.getAttribute("data-fullscreen-stage")).toBeNull();

    // Verify F11 & ⌃⌘F toggle/exit fullscreen in Electron AND overlay card renders `[退出全屏]` button!
    const fsCallsBeforeF11 = postedMessages.filter(
      (m) => m.action === "screenFullScreen" && m.enabled === true,
    ).length;
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F11", bubbles: true }),
      );
      window.dispatchEvent(
        new CustomEvent(DESKTOP_FULLSCREEN_EVENT, {
          detail: { fullscreen: true },
        }),
      );
    });
    expect(
      postedMessages.filter(
        (m) => m.action === "screenFullScreen" && m.enabled === true,
      ).length,
    ).toBe(fsCallsBeforeF11 + 1);
    expect(section?.getAttribute("data-fullscreen-stage")).toBe("true");
    // Top-center persistent handle is present when non-native HUD owns fullscreen
    expect(container.querySelector(".ls-screen-fullscreen-handle")).not.toBeNull();
    // Connecting overlay card also exposes an explicit `[退出全屏]` button in fullscreen
    const overlayExitBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".ls-screen-overlay-card button",
      ),
    ).find((b) => b.textContent?.includes("退出全屏"));
    expect(overlayExitBtn).toBeDefined();

    // `⌃⌘F` exits fullscreen even in Electron!
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(section?.getAttribute("data-fullscreen-stage")).toBeNull();
  });

  it("sets app-drag on .ls-remote-subbar ONLY when standaloneChrome is true so embedded row-2 subbar buttons remain clickable on Windows", () => {
    const remoteWin = makeMockComputer(
      "wss://gateway.itool.tech#win-host",
      "win32",
      "Windows Studio",
    );
    const mockConn = makeMockConnection(remoteWin);
    engine.state.setState({
      computers: [remoteWin],
      connection: mockConn,
    });
    installPreloadBridge("win32");

    // 1. Embedded inside DesktopAppShell (`standaloneChrome={false}`) -> NO `app-drag`
    act(() => {
      root.render(
        <RemoteScreenWorkspace
          computerKey={remoteWin.key}
          standaloneChrome={false}
        />,
      );
    });
    const embeddedSubbar = container.querySelector(".ls-remote-subbar");
    expect(embeddedSubbar).not.toBeNull();
    expect(embeddedSubbar?.classList.contains("app-drag")).toBe(false);

    // 2. Standalone screen chrome (`standaloneChrome={true}`) -> HAS `app-drag`
    act(() => {
      root.render(
        <RemoteScreenWorkspace
          computerKey={remoteWin.key}
          standaloneChrome
        />,
      );
    });
    const standaloneSubbar = container.querySelector(".ls-remote-subbar");
    expect(standaloneSubbar).not.toBeNull();
    expect(standaloneSubbar?.classList.contains("app-drag")).toBe(true);
  });
});
