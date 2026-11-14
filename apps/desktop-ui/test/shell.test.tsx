import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ClientStore } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { DESKTOP_LOCAL } from "../src/bridge/desktop-bridge";
import {
  engine,
  fusionStore,
  I18nProvider,
  management,
  routerStore,
  setDesktopLocalePreference,
  setProjectScope,
  type Computer,
  type Connection,
} from "../src/core";
import { App } from "../src/App";
import { openFileInInspector } from "../src/features/session";
import { DesktopAppShell, switchToComputer } from "../src/features/shell";
import { DialogProvider } from "../src/primitives";

const testDir = dirname(fileURLToPath(import.meta.url));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeMockConnection(
  computer: Computer,
  options?: {
    status?: "online" | "connecting" | "locked" | "offline";
    sessions?: SessionSummary[];
    sessionsLoaded?: boolean;
    archivedNextBefore?: number;
    archivedNextBeforeId?: string;
    loadArchivedImpl?: () => Promise<void>;
    unlockImpl?: (pw: string) => Promise<void>;
  },
): Connection {
  const sessionMap: Record<string, SessionSummary> = {};
  for (const s of options?.sessions ?? []) {
    sessionMap[s.id] = s;
  }

  const clientStore = createStore(() => ({
    status: options?.status ?? "online",
    sessions: sessionMap,
    sessionsLoaded: options?.sessionsLoaded ?? true,
    archivedNextBefore: options?.archivedNextBefore,
    archivedNextBeforeId: options?.archivedNextBeforeId,
    notices: {},
    interactions: {},
    projects: [],
    views: {},
    open: {},
    ready: {},
    loadingEarlier: {},
    subagents: {},
    workflows: {},
    tasks: {},
    subagentViews: {},
    outbox: {},
    queueing: {},
    promptProgress: {},
    sides: {},
    loadArchived: options?.loadArchivedImpl ?? vi.fn().mockResolvedValue(undefined),
    unlock: options?.unlockImpl ?? vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([]),
    gitInfo: vi.fn().mockResolvedValue(undefined),
  })) as unknown as ClientStore;

  return {
    computer,
    link: {
      call: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "fs.read") {
          return Promise.resolve({
            path: typeof params?.path === "string" ? params.path : "/mock.ts",
            size: 10,
            kind: "text",
            text: "export {};",
            truncated: false,
          });
        }
        if (method === "fs.list") {
          return Promise.resolve({ path: "/", entries: [] });
        }
        if (method === "ports.list") {
          return Promise.resolve({ ports: [] });
        }
        if (method === "terminals.list") {
          return Promise.resolve({ terminals: [] });
        }
        return Promise.resolve({
          sampledAt: Date.now(),
          sampleIntervalMs: 5_000,
          cpu: { usage: 18, cores: 10, model: "Apple M3 Pro" },
          memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        });
      }),
      on: vi.fn(() => () => {}),
      notify: vi.fn(),
      reconnectNow: vi.fn(),
    } as unknown as Connection["link"],
    streams: { open: vi.fn() } as unknown as Connection["streams"],
    store: clientStore,
    sessions: {
      acquire: () => () => {},
      evict: () => {},
      close: () => {},
    } as unknown as Connection["sessions"],
  };
}

const localMac: Computer = {
  key: DESKTOP_LOCAL,
  gateway: "local",
  machine: {
    id: "machine-local-mac-001",
    name: "Local Studio",
    online: true,
    platform: "darwin",
    signKey: "local-sign-key",
    boxKey: "local-box-key",
    via: "paired",
  },
};

const remoteMac: Computer = {
  key: "relay:remote-mac-pro",
  gateway: "wss://gateway.itool.tech",
  machine: {
    id: "machine-remote-mac-999",
    name: "Office MacBook Pro",
    online: true,
    platform: "darwin",
    signKey: "remote-sign-key",
    boxKey: "remote-box-key",
    via: "paired",
  },
};

describe("Slice 2B-1 DesktopAppShell, Chrome Geometry, Sidebar E2E Hooks & Command Center", () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = (node: ReactNode) => {
    act(() => {
      root.render(
        <I18nProvider>
          <DialogProvider>{node}</DialogProvider>
        </I18nProvider>,
      );
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    setDesktopLocalePreference("zh");
    setProjectScope("computer");
    routerStore.setState({
      activeRoute: { kind: "home" },
      canGoBack: false,
      canGoForward: false,
      systemModal: { open: false, page: "overview" },
      sidebarHidden: false,
      sidebarWidth: 248,
      inspectorOpen: false,
      inspectorWidth: 380,
      inspectorTab: "changes",
      bottomDockOpen: false,
      bottomDockHeight: 240,
      commandCenterOpen: false,
      connectModalOpen: false,
      shortcutSheetOpen: false,
    });
    fusionStore.setState({ byComputer: {} });
    management.setState({
      snapshot: { status: "running" },
      problem: undefined,
      busy: false,
      starting: false,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it("wraps shell.css inside @layer components with zero !important rules", () => {
    const cssPath = resolve(testDir, "..", "src", "styles", "shell.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css.trimStart().startsWith("@layer components")).toBe(true);
    expect(css).not.toContain("!important");
  });

  it("applies platform, sidebar-collapsed, and session-scoped inspector-open data attributes on .desktop-root", () => {
    const conn = makeMockConnection(localMac);
    engine.state.setState({
      computers: [localMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });

    mount(
      <DesktopAppShell
        platformOverride="windows"
        renderInspector={() => <div data-testid="inspector-slot">Inspector</div>}
      />,
    );

    const desktopRoot = host.querySelector(".desktop-root") as HTMLElement;
    expect(desktopRoot).not.toBeNull();
    expect(desktopRoot.dataset.platform).toBe("windows");
    expect(desktopRoot.dataset.sidebarCollapsed).toBeUndefined();
    expect(desktopRoot.dataset.inspectorOpen).toBeUndefined();

    // On non-session routes ("home"), inspector stays auto-hidden even when toggled open (#73 C.2)
    act(() => {
      routerStore.getState().toggleSidebar();
      routerStore.getState().setInspectorTab("changes");
      routerStore.getState().toggleInspector(true);
    });

    expect(desktopRoot.dataset.sidebarCollapsed).toBe("true");
    expect(desktopRoot.dataset.inspectorOpen).toBeUndefined();
    expect(host.querySelector('[data-testid="inspector-slot"]')).toBeNull();

    // Entering a session route immediately reveals the Right Side Panel
    act(() => {
      routerStore.getState().openSession(DESKTOP_LOCAL, "sess-1");
    });
    expect(desktopRoot.dataset.inspectorOpen).toBe("true");
    expect(host.querySelector('[data-testid="inspector-slot"]')).not.toBeNull();

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderInspector={() => <div data-testid="inspector-slot">Inspector</div>}
      />,
    );
    expect(desktopRoot.dataset.platform).toBe("macos");
    expect(desktopRoot.dataset.translucent).toBe("true");
  });

  it("preserves model-ui-e2e.mjs DOM hooks (.desktop-new-session, .desktop-places .desktop-place, .tree-session[data-session-id]) and recency sort order with zero 0-session ghost projects", () => {
    const olderCreatedHigherUpdated: SessionSummary = {
      id: "sess-older",
      agent: "codex",
      nativeId: "native-older",
      cwd: "/Users/dev/repo-alpha",
      title: "Older Session With Recent Reply",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 0,
      archived: false,
      createdAt: 1_000,
      updatedAt: 99_000,
    };
    const newerCreated: SessionSummary = {
      id: "sess-newer",
      agent: "claude",
      nativeId: "native-newer",
      cwd: "/Users/dev/repo-alpha",
      title: "Newer Created Session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 0,
      archived: false,
      createdAt: 5_000,
      updatedAt: 5_000,
    };
    const archivedSession: SessionSummary = {
      id: "sess-archived-only",
      agent: "codex",
      nativeId: "native-arch",
      cwd: "/Users/dev/ws-archived",
      title: "Archived Session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 0,
      archived: true,
      createdAt: 10_000,
      updatedAt: 10_000,
    };

    const conn = makeMockConnection(localMac, {
      projects: [
        {
          cwd: "/Users/dev/repo-alpha",
          name: "repo-alpha",
          createdAt: 1_000,
          lastActiveAt: 99_000,
          sessionCount: 2,
        },
        {
          cwd: "/Users/dev/ws-archived",
          name: "ws-archived",
          createdAt: 10_000,
          lastActiveAt: 10_000,
          sessionCount: 1,
        },
        {
          cwd: "/Users/dev/unloaded-zero-live",
          name: "unloaded-zero-live",
          createdAt: 20_000,
          lastActiveAt: 20_000,
          sessionCount: 3,
        },
      ],
      sessions: [olderCreatedHigherUpdated, newerCreated, archivedSession],
    });
    engine.state.setState({
      computers: [localMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });

    const newSessionMounts = vi.fn();

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderNewSessionWorkspace={({ computerKey }) => {
          newSessionMounts(computerKey);
          return <div data-testid="new-session-canvas">New Session Canvas</div>;
        }}
        renderSessionWorkspace={({ sessionId }) => (
          <div data-testid="active-session-canvas">Session: {sessionId}</div>
        )}
      />,
    );

    // 1. On initial home route, NewSessionWorkspace is NOT prematurely mounted before clicking .desktop-new-session
    expect(newSessionMounts).not.toHaveBeenCalled();

    // 2. Verify recency descending order in .tree-session rows AND zero 0-session / all-archived project headers in Sidebar!
    const projectHeaders = Array.from(
      host.querySelectorAll<HTMLElement>(".tree-project .tree-project__name"),
    ).map((el) => el.textContent?.trim());
    expect(projectHeaders).toEqual(["repo-alpha"]);

    const sessionButtons = Array.from(
      host.querySelectorAll<HTMLElement>(".tree-session[data-session-id]"),
    );
    expect(sessionButtons.map((el) => el.dataset.sessionId)).toEqual([
      "sess-older",
      "sess-newer",
    ]);

    // 3. Click .desktop-new-session -> mounts NewSessionWorkspace
    const newBtn = host.querySelector(".desktop-new-session") as HTMLButtonElement;
    expect(newBtn).not.toBeNull();
    act(() => {
      newBtn.click();
    });
    expect(newSessionMounts).toHaveBeenCalledWith(DESKTOP_LOCAL);
    expect(host.querySelector('[data-testid="new-session-canvas"]')).not.toBeNull();

    // 4. Click .tree-session[data-session-id="sess-older"] -> opens session
    const olderRow = host.querySelector(
      '.tree-session[data-session-id="sess-older"]',
    ) as HTMLButtonElement;
    act(() => {
      olderRow.click();
    });
    expect(
      host.querySelector('[data-testid="active-session-canvas"]')?.textContent,
    ).toContain("sess-older");

    // 5. Click .desktop-places .desktop-place[0] -> leaves session and sets aria-current="page"
    const firstPlace = host.querySelectorAll<HTMLButtonElement>(
      ".desktop-places .desktop-place",
    )[0]!;
    act(() => {
      firstPlace.click();
    });
    expect(firstPlace.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[data-testid="active-session-canvas"]')).toBeNull();
  });

  it("keeps the workspace session mounted when opening Local Host Management (systemModal)", () => {
    const session: SessionSummary = {
      id: "sess-live-1",
      agent: "codex",
      nativeId: "native-live-1",
      cwd: "/Users/dev/linkshell",
      title: "Live Streaming Session",
      state: "running",
      pendingPermissions: 0,
      lastSeq: 0,
      archived: false,
      createdAt: 10_000,
      updatedAt: 10_000,
    };
    const conn = makeMockConnection(localMac, { sessions: [session] });
    engine.state.setState({
      computers: [localMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });
    routerStore.getState().openSession(DESKTOP_LOCAL, "sess-live-1");

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderSessionWorkspace={({ sessionId }) => (
          <div data-testid="mounted-session">{sessionId}</div>
        )}
      />,
    );

    expect(host.querySelector('[data-testid="mounted-session"]')?.textContent).toBe(
      "sess-live-1",
    );

    const capsuleBtn = host.querySelector(
      ".local-host-capsule__status",
    ) as HTMLButtonElement;
    act(() => {
      capsuleBtn.click();
    });

    expect(routerStore.getState().systemModal).toEqual({
      open: true,
      page: "overview",
    });
    expect(host.querySelector('[data-testid="mounted-session"]')?.textContent).toBe(
      "sess-live-1",
    );
  });

  it("surfaces global Fusion Mode commands in CommandCenter when a remote Mac is online and guards CJK IME Enter", () => {
    const conn = makeMockConnection(localMac);
    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });

    const prevDesktop = window.linkshellDesktop;
    window.linkshellDesktop = {
      shell: "electron",
      platform: "darwin",
      postMessage: vi.fn(),
    };

    try {
      routerStore.getState().setCommandCenterOpen(true);
      mount(<DesktopAppShell platformOverride="macos" />);

      const input = document.querySelector(".command-center__input") as HTMLInputElement;
      expect(input).not.toBeNull();

      act(() => {
        setNativeInputValue(input, "融合");
      });

      const optionsText = Array.from(
        document.querySelectorAll(".command-center__item-title"),
      ).map((el) => el.textContent);
      expect(
        optionsText.some((txt) => txt?.includes("开启融合模式 — Office MacBook Pro")),
      ).toBe(true);

      // CJK IME composition Enter (keyCode 229) must NOT execute or close CommandCenter
      act(() => {
        const imeEvent = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(imeEvent, "keyCode", { value: 229 });
        input.dispatchEvent(imeEvent);
      });
      expect(routerStore.getState().commandCenterOpen).toBe(true);
    } finally {
      window.linkshellDesktop = prevDesktop;
    }
  });

  it("renders AccessUnlockView when the active computer connection is locked and unlocks on password submit", async () => {
    const unlockMock = vi.fn().mockResolvedValue(undefined);
    const lockedConn = makeMockConnection(remoteMac, {
      status: "locked",
      unlockImpl: unlockMock,
    });

    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: lockedConn,
      locked: true,
    });

    mount(<DesktopAppShell platformOverride="macos" />);

    const pwInput = host.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(pwInput).not.toBeNull();

    act(() => {
      setNativeInputValue(pwInput, "secret-pass");
    });

    const buttons = Array.from(host.querySelectorAll("button"));
    const unlockBtn = buttons.find((b) => b.textContent?.includes("解锁电脑"));
    expect(unlockBtn).toBeDefined();

    await act(async () => {
      unlockBtn!.click();
    });

    expect(unlockMock).toHaveBeenCalledWith("secret-pass");
  });

  it("mounts full <App /> assembly, handles #view=manage E2E contract, and bridges openFileInInspector", async () => {
    vi.spyOn(engine, "start").mockResolvedValue(undefined);
    const conn = makeMockConnection(localMac);
    engine.state.setState({
      computers: [localMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });

    act(() => {
      root.render(<App />);
    });

    expect(host.querySelector(".desktop-root")).not.toBeNull();
    expect(host.querySelector(".desktop-new-session")).not.toBeNull();

    // 1. Verify #view=manage hash navigation opens SystemHostModal with E2E .management-nav-item tabs
    act(() => {
      window.location.hash = "#view=manage";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(routerStore.getState().systemModal.open).toBe(true);
    const manageNavLabels = Array.from(
      document.querySelectorAll(".management-nav-item"),
    ).map((el) => el.textContent?.trim());
    expect(manageNavLabels).toContain("总览");
    expect(manageNavLabels).toContain("更新");
    expect(manageNavLabels).toContain("设置");

    act(() => {
      routerStore.getState().closeSystemModal();
    });

    // 2. Verify openFileInInspector opens the right-hand Inspector on the files tab even when initially closed
    expect(routerStore.getState().inspectorOpen).toBe(false);
    await act(async () => {
      openFileInInspector(DESKTOP_LOCAL, undefined, "/Users/dev/linkshell/src/App.tsx", 42);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(routerStore.getState().inspectorOpen).toBe(true);
    expect(routerStore.getState().inspectorTab).toBe("files");
  });

  it("right-aligns sidebar toggle [◧] in .desktop-sidebar-header when expanded and in .workspace-topbar__right when collapsed, suppresses hover-peek on collapse, switches WorkspaceSurfaceTabs, and isolates panel crashes via ErrorBoundary", () => {
    const conn = makeMockConnection(localMac);
    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: conn,
      locked: false,
    });

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderStandaloneTool={({ mode }) => {
          if (mode === "ports") {
            throw new Error("simulated ports crash");
          }
          return <div data-testid="standalone-tool">{mode}</div>;
        }}
      />,
    );

    // 1. Deleted .desktop-sidebar-toggle-pin near traffic lights; right-aligned toggle sits inside .desktop-sidebar-header
    expect(document.documentElement.dataset.platform).toBe("macos");
    expect(host.querySelector(".desktop-sidebar-toggle-pin")).toBeNull();
    const sidebarToggleBtn = host.querySelector(
      ".desktop-sidebar-header button.desktop-sidebar-header__toggle",
    ) as HTMLButtonElement;
    expect(sidebarToggleBtn).not.toBeNull();
    expect(host.querySelector(".workspace-topbar__history")).toBeNull();
    expect(
      host.querySelector(".workspace-topbar__left button.workspace-topbar__sidebar-toggle"),
    ).toBeNull();

    // 2. Clicking right-aligned header toggle collapses sidebar, suppresses immediate hover-peek drawer, and surfaces [◧] in .workspace-topbar__left (with zero Back/Forward history arrows)
    act(() => {
      sidebarToggleBtn.click();
    });
    expect(routerStore.getState().sidebarHidden).toBe(true);
    expect(host.querySelector(".workspace-topbar__history")).toBeNull();
    const collapsedTopbarToggle = host.querySelector(
      ".workspace-topbar__left button.workspace-topbar__sidebar-toggle",
    ) as HTMLButtonElement;
    expect(collapsedTopbarToggle).not.toBeNull();
    expect(
      host.querySelector(".workspace-topbar__right button.workspace-topbar__sidebar-toggle"),
    ).toBeNull();

    const edgeSensor = host.querySelector(".desktop-sidebar-edge-sensor") as HTMLElement;
    expect(edgeSensor).not.toBeNull();
    act(() => {
      edgeSensor.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    });
    expect(host.querySelector(".desktop-sidebar-peek")).toBeNull();

    // 3. WorkspaceSurfaceTabs is hidden on home/session/new-session, and renders cleanly on standalone tool routes
    expect(host.querySelector(".desktop-surface-tabs")).toBeNull();
    act(() => {
      routerStore.getState().navigate({ kind: "terminals", computerKey: DESKTOP_LOCAL });
    });
    expect(host.querySelector('[data-testid="standalone-tool"]')?.textContent).toBe(
      "terminals",
    );
    expect(host.querySelector('.desktop-surface-tab[data-surface="terminals"]')).not.toBeNull();

    // 4. ErrorBoundary isolates a throwing panel without unmounting the shell or left-aligned topbar sidebar toggle
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const portsTab = host.querySelector(
      '.desktop-surface-tab[data-surface="ports"]',
    ) as HTMLButtonElement;
    act(() => {
      portsTab.click();
    });
    expect(host.querySelector(".ls-error-boundary")).not.toBeNull();
    expect(
      host.querySelector(".workspace-topbar__left button.workspace-topbar__sidebar-toggle"),
    ).not.toBeNull();
    errSpy.mockRestore();
  });

  it("places full-width ComputerSwitcher inside .sidebar-top-stack, keeps .desktop-sidebar-header clean with LinkShell + right-aligned [◧], removes duplicate CommandCenter button from WorkspaceTopBar, and protects .workspace-title-primary width", () => {
    const localMacBook: Computer = {
      ...localMac,
      machine: { ...localMac.machine, name: "Local MacBook" },
    };
    const conn = makeMockConnection(localMacBook);
    engine.state.setState({
      computers: [localMacBook, remoteMac],
      localComputer: localMacBook,
      connection: conn,
      locked: false,
    });

    mount(<DesktopAppShell platformOverride="macos" />);

    // 1. Clean drag header holds LinkShell wordmark on left + right-aligned [◧]; ComputerSwitcher lives inside .sidebar-top-stack
    const sidebarHeader = host.querySelector(".desktop-sidebar-header");
    expect(
      sidebarHeader?.querySelector(".desktop-sidebar-wordmark")?.textContent,
    ).toBe("LinkShell");
    expect(
      sidebarHeader?.querySelector("button.desktop-sidebar-header__toggle"),
    ).not.toBeNull();
    expect(sidebarHeader?.querySelector(".computer-switcher-trigger")).toBeNull();

    const switcherInStack = host.querySelector(
      ".sidebar-top-stack .computer-switcher-trigger__name",
    );
    expect(switcherInStack?.textContent).toBe("Local MacBook");

    // 2. WorkspaceTopBar has no duplicate Command Center button; Sidebar still provides .sidebar-search-row
    expect(
      host.querySelector('.desktop-main-header [aria-label="搜索与命令"]'),
    ).toBeNull();
    expect(host.querySelector(".sidebar-search-row")).not.toBeNull();

    // 3. CSS invariants: .workspace-title-primary min-inline-size: 96px & collapsed macOS --titlebar-left-inset: 84px
    const cssPath = resolve(testDir, "..", "src", "styles", "shell.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.workspace-title-primary\s*\{[^}]*min-inline-size:\s*96px/);

    const chromeCssPath = resolve(testDir, "..", "src", "styles", "chrome.css");
    const chromeCss = readFileSync(chromeCssPath, "utf8");
    expect(chromeCss).not.toContain(".desktop-sidebar-toggle-pin");
    expect(chromeCss).toContain("--titlebar-left-inset: 84px;");
    expect(chromeCss).toContain("grid-template-columns 220ms cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("enforces Phase 5 popover hit-target safety and radical UI de-cluttering across Sidebar, LocalHostCapsule, WorkspaceSurfaceTabs, and WorkspaceTopBar", () => {
    const waitingSess: SessionSummary = {
      id: "sess-wait-1",
      agent: "claude",
      nativeId: "native-wait-1",
      cwd: "/Users/dev/claude-remote",
      title: "Waiting Approval Session",
      state: "waiting",
      pendingPermissions: 1,
      lastSeq: 1,
      archived: false,
      createdAt: 20_000,
      updatedAt: 20_000,
    };
    const runningSess: SessionSummary = {
      id: "sess-run-1",
      agent: "codex",
      nativeId: "native-run-1",
      cwd: "/Users/dev/claude-remote",
      title: "Running Refactor Session",
      state: "running",
      pendingPermissions: 0,
      lastSeq: 2,
      archived: false,
      createdAt: 30_000,
      updatedAt: 30_000,
    };

    const localConn = makeMockConnection(localMac, {
      sessions: [waitingSess, runningSess],
    });
    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: localConn,
      locked: false,
    });
    routerStore.getState().openSession(DESKTOP_LOCAL, "sess-run-1");

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderSessionWorkspace={({ sessionId }) => (
          <div data-testid="session-stage">{sessionId}</div>
        )}
      />,
    );

    // 1. Popover hit-target CSS invariant: .computer-switcher-popover never sets display: flex on [popover]
    const cssPath = resolve(testDir, "..", "src", "styles", "shell.css");
    const css = readFileSync(cssPath, "utf8");
    const popoverBlock = css.match(/\.computer-switcher-popover\s*\{[^}]*\}/)?.[0] ?? "";
    expect(popoverBlock).not.toContain("display:");
    expect(css).toContain('.computer-switcher-popover:not([data-state="open"])');
    expect(host.querySelector(".desktop-sidebar-edge-sensor")).toBeNull();

    // 2. WorkspaceSurfaceTabs is NOT rendered on session or new-session routes
    expect(host.querySelector(".desktop-surface-tabs")).toBeNull();

    // 3. Sidebar Active + By Project UX overhaul:
    //    - Zero duplicate search IconButton in .sidebar-section__header
    //    - Active section (`section[aria-label="Active"]`) pins waiting + running + <6h recent (2-line with .tree-session__sub)
    //    - By Project (`按项目`) session rows are single-line (no .tree-session__sub repeating project monogram)
    expect(
      host.querySelector('.sidebar-section__header [aria-label="搜索与命令"]'),
    ).toBeNull();
    const activeSection = host.querySelector('section[aria-label="Active"]');
    expect(activeSection).not.toBeNull();
    expect(activeSection?.textContent).toContain("活跃会话");
    expect(
      host.querySelector('[data-pinned-session-id="sess-wait-1"] .tree-session__sub'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-pinned-session-id="sess-run-1"] .tree-session__sub'),
    ).not.toBeNull();
    const projectsSection = host.querySelector('section[aria-label="项目"]');
    expect(projectsSection?.querySelector(".sidebar-section__title")?.textContent).toContain(
      "按项目",
    );
    const projectRow = host.querySelector(
      '.tree-session[data-session-id="sess-run-1"]',
    ) as HTMLElement;
    expect(projectRow).not.toBeNull();
    expect(projectRow.dataset.singleLine).toBe("true");
    expect(projectRow.querySelector(".tree-session__sub")).toBeNull();

    // 4. LocalHostCapsule renders ONE unified Settings button (.sidebar-footer-settings-btn) with zero split hover boxes (#73 C.3)
    expect(host.querySelector(".local-host-capsule__dock")).toBeNull();
    expect(
      host.querySelectorAll(".desktop-sidebar-footer button").length,
    ).toBe(1);
    const unifiedFooterBtn = host.querySelector(
      ".desktop-sidebar-footer button.sidebar-footer-settings-btn.local-host-capsule__status",
    );
    expect(unifiedFooterBtn).not.toBeNull();
    expect(unifiedFooterBtn?.textContent).toContain("设置");

    // 5. WorkspaceTopBar omits .workspace-computer-chip on session routes and scopes Terminal & Inspector toggles strictly to session (#73 C.2)
    expect(host.querySelector(".desktop-main-header .workspace-computer-chip")).toBeNull();
    const dockBtn = host.querySelector(
      '.desktop-main-header button[aria-label="打开或收起底部终端"]',
    );
    expect(dockBtn).not.toBeNull();
    expect(dockBtn?.classList.contains("topbar-keycap")).toBe(false);

    // 6. Remote computer state: flat .desktop-places .desktop-place rows (zero boxed .sidebar-remote-strip), and non-session topbar hides [>_] / [◨]
    const remoteConn = makeMockConnection(remoteMac, { sessions: [] });
    act(() => {
      fusionStore.setState({
        byComputer: {
          [remoteMac.key]: {
            phase: "connected",
            connected: true,
            windowCounts: { preview: 2 },
            error: undefined,
          },
        } as unknown as ReturnType<typeof fusionStore.getState>["byComputer"],
      });
      engine.state.setState({
        computers: [localMac, remoteMac],
        localComputer: localMac,
        connection: remoteConn,
        locked: false,
      });
      routerStore.getState().navigate({ kind: "home" });
    });

    expect(host.querySelector(".desktop-main-header .workspace-computer-chip")).not.toBeNull();
    expect(host.querySelector(".sidebar-remote-strip")).toBeNull();
    expect(
      host.querySelector('.desktop-main-header button[aria-label="打开或收起底部终端"]'),
    ).toBeNull();
    const placeLabels = Array.from(
      host.querySelectorAll(".desktop-places .desktop-place__label"),
    ).map((el) => el.textContent);
    expect(placeLabels).toContain("远程屏幕");
  });

  it("renders clean single-row .ls-entity-list in ComputersFleetView, ProjectsOverview, and ArchiveView with human-readable macOS labels, ~/ paths, .ls-collapse-grid accordions, and zero trailing ellipses", async () => {
    const activeProjectSess: SessionSummary = {
      id: "sess-proj-1",
      agent: "claude",
      nativeId: "native-proj-1",
      cwd: "/Users/turning4th/teachvideo",
      title: "Generate slide deck transitions",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: false,
      createdAt: 40_000,
      updatedAt: 45_000,
    };
    const archivedSess: SessionSummary = {
      id: "sess-arch-1",
      agent: "codex",
      nativeId: "native-arch-1",
      cwd: "/Users/turning4th/claude-remote",
      title: "Archived refactor session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: true,
      createdAt: 10_000,
      updatedAt: 12_000,
    };

    const localConn = makeMockConnection(localMac, {
      sessions: [activeProjectSess, archivedSess],
    });
    const remoteConn = makeMockConnection(remoteMac, { sessions: [] });

    vi.spyOn(engine, "retainComputer").mockImplementation((comp) => ({
      connection: comp.key === DESKTOP_LOCAL ? localConn : remoteConn,
      release: () => {},
    }));

    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: localConn,
      locked: false,
    });

    // 1. ComputersFleetView: single-column .ls-entity-list, "macOS" (never raw "darwin"), zero sparkbars
    routerStore.getState().navigate({ kind: "computers" });
    mount(<DesktopAppShell platformOverride="macos" />);

    await act(async () => {
      await Promise.resolve();
    });

    const fleetList = host.querySelector(".shell-page .ls-entity-list");
    expect(fleetList).not.toBeNull();
    expect(host.querySelector(".fleet-sparkbars")).toBeNull();
    expect(fleetList?.textContent).toContain("macOS");
    expect(fleetList?.textContent).not.toContain("darwin");
    expect(fleetList?.textContent).toContain("1 个会话");

    // 2. ProjectsOverview: single-column .ls-entity-list, ~/ path shortening, zero ProjectMonogram in list, .ls-collapse-grid accordion
    act(() => {
      routerStore.getState().navigate({ kind: "projects" });
    });

    const projectList = host.querySelector(".shell-page .ls-entity-list") as HTMLElement;
    expect(projectList).not.toBeNull();
    expect(host.querySelector(".projects-grid")).toBeNull();
    expect(projectList.querySelector(".project-monogram")).toBeNull();
    expect(projectList.querySelector(".ls-entity-row__path")?.textContent).toBe("~/teachvideo");
    expect(projectList.textContent).toContain("1 个会话");

    const projectSearch = host.querySelector(
      ".shell-page input.ls-input",
    ) as HTMLInputElement;
    expect(projectSearch?.placeholder).toBe("搜索项目或路径");
    expect(projectSearch?.placeholder).not.toContain("…");

    const collapseGrid = projectList.querySelector(".ls-collapse-grid") as HTMLElement;
    expect(collapseGrid?.dataset.open).toBe("false");
    expect(
      collapseGrid?.querySelector(".ls-collapse-grid__inner")?.hasAttribute("inert"),
    ).toBe(true);

    const projectMainBtn = projectList.querySelector(
      ".ls-entity-row__main",
    ) as HTMLButtonElement;
    act(() => {
      projectMainBtn.click();
    });
    expect(collapseGrid?.dataset.open).toBe("true");
    expect(
      collapseGrid?.querySelector(".ls-collapse-grid__inner")?.hasAttribute("inert"),
    ).toBe(false);
    expect(projectList.querySelector(".ls-entity-subrow")?.textContent).toContain(
      "Generate slide deck transitions",
    );

    // 3. ArchiveView: single-column .ls-entity-list, ~/ path, zero trailing ellipsis in search placeholder
    await act(async () => {
      routerStore.getState().navigate({ kind: "archive" });
      await Promise.resolve();
    });

    const archiveList = host.querySelector(".shell-page .ls-entity-list") as HTMLElement;
    expect(archiveList).not.toBeNull();
    expect(archiveList.querySelector(".ls-entity-row__path")?.textContent).toBe(
      "~/claude-remote",
    );
    const archiveSearch = host.querySelector(
      ".shell-page input.ls-input",
    ) as HTMLInputElement;
    expect(archiveSearch?.placeholder).toBe("搜索已归档的会话");
    expect(archiveSearch?.placeholder).not.toContain("…");
  });

  it("groups sessions and projects by 电脑 → 项目 → 会话 when switched to 所有电脑 and updates live as remote connections finish syncing", async () => {
    const chengduMini: Computer = {
      key: "relay:chengdu-mini",
      gateway: "wss://gateway.itool.tech",
      machine: {
        id: "machine-chengdu-mini",
        name: "成都-mini",
        online: true,
        platform: "darwin",
        signKey: "chengdu-sign-key",
        boxKey: "chengdu-box-key",
        via: "account",
      },
    };
    const winWorkstation: Computer = {
      key: "relay:win-workstation",
      gateway: "wss://gateway.itool.tech",
      machine: {
        id: "machine-win-workstation",
        name: "Win Workstation",
        online: true,
        platform: "win32",
        signKey: "win-sign-key",
        boxKey: "win-box-key",
        via: "paired",
      },
    };

    const localSession: SessionSummary = {
      id: "local-s1",
      agent: "claude",
      nativeId: "native-local-s1",
      cwd: "/Users/turning4th/claude-remote",
      title: "Local desktop UI polish",
      state: "running",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: false,
      createdAt: 50_000,
      updatedAt: 52_000,
    };
    const winWaitingSession: SessionSummary = {
      id: "win-s1",
      agent: "codex",
      nativeId: "native-win-s1",
      cwd: "C:\\Users\\dev\\teachvideo\\runs\\20261112-01\\01",
      title: "Approve Windows DXGI encoder config",
      state: "waiting",
      pendingPermissions: 1,
      lastSeq: 2,
      archived: false,
      createdAt: 60_000,
      updatedAt: 61_000,
    };
    const winShardSession: SessionSummary = {
      id: "win-s2",
      agent: "codex",
      nativeId: "native-win-s2",
      cwd: "C:\\Users\\dev\\teachvideo\\runs\\20261112-01\\02",
      title: "Render shard 02 slides",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 3,
      archived: false,
      createdAt: 55_000,
      updatedAt: 56_000,
    };

    const localConn = makeMockConnection(localMac, { sessions: [localSession] });
    // 成都-mini starts still syncing (`sessionsLoaded: false`, `sessions: []`)
    const chengduConn = makeMockConnection(chengduMini, {
      status: "connecting",
      sessions: [],
      sessionsLoaded: false,
    });
    const winConn = makeMockConnection(winWorkstation, {
      sessions: [winWaitingSession, winShardSession],
    });

    const connByKey: Record<string, Connection> = {
      [localMac.key]: localConn,
      [chengduMini.key]: chengduConn,
      [winWorkstation.key]: winConn,
    };

    vi.spyOn(engine, "retainComputer").mockImplementation((comp) => ({
      connection: connByKey[comp.key] ?? localConn,
      release: () => {},
    }));
    const selectSpy = vi.spyOn(engine, "select").mockImplementation((comp) => {
      engine.state.setState({ connection: connByKey[comp.key] ?? localConn });
    });

    engine.state.setState({
      computers: [chengduMini, localMac, winWorkstation],
      localComputer: localMac,
      connection: localConn,
      locked: false,
    });

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderSessionWorkspace={({ computerKey, sessionId }) => (
          <div data-testid="opened-session">{`${computerKey}:${sessionId}`}</div>
        )}
      />,
    );

    // 1. Default scope ("computer"): flat single-computer project tree (1 project on 本机), no .tree-computer, zero .project-monogram, and .sidebar-sessions-scope-bar precedes section[aria-label="Active"]!
    expect(host.querySelector(".tree-computer")).toBeNull();
    expect(host.querySelectorAll(".desktop-sidebar .project-monogram").length).toBe(0);
    expect(host.querySelector(".desktop-sidebar .tree-project__icon")).not.toBeNull();

    const scopeBar = host.querySelector(".desktop-sidebar .sidebar-sessions-scope-bar") as HTMLElement;
    const activeSectionBefore = host.querySelector(
      '.desktop-sidebar section[aria-label="Active"]',
    ) as HTMLElement;
    expect(scopeBar).not.toBeNull();
    expect(activeSectionBefore).not.toBeNull();
    expect(
      Boolean(
        scopeBar.compareDocumentPosition(activeSectionBefore) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      activeSectionBefore.querySelector('[data-pinned-session-id="local-s1"]')?.textContent,
    ).not.toContain("Local Studio");
    expect(
      activeSectionBefore.querySelector('[data-pinned-session-id="win-s1"]'),
    ).toBeNull();

    const placesCountsBefore = Array.from(
      host.querySelectorAll(".desktop-places .desktop-place__count"),
    ).map((el) => el.textContent);
    expect(placesCountsBefore[0]).toBe("1");

    // 2. Click "所有电脑" in Sidebar -> renders 3-level 电脑 → 项目 → 会话 hierarchy AND updates Active section with computer badges
    const allScopeBtn = Array.from(
      host.querySelectorAll(".desktop-sidebar .sidebar-scope-switch__btn"),
    ).find((btn) => btn.textContent?.includes("所有电脑")) as HTMLButtonElement;
    const computerScopeBtn = Array.from(
      host.querySelectorAll(".desktop-sidebar .sidebar-scope-switch__btn"),
    ).find((btn) => btn.textContent?.includes("当前电脑")) as HTMLButtonElement;
    expect(allScopeBtn).not.toBeNull();
    expect(computerScopeBtn).not.toBeNull();

    await act(async () => {
      allScopeBtn.click();
      await Promise.resolve();
    });

    expect(host.querySelectorAll(".desktop-sidebar .project-monogram").length).toBe(0);
    const localPinAll = host.querySelector(
      '[data-pinned-session-id="local-s1"]',
    ) as HTMLElement;
    expect(localPinAll?.textContent).toContain("claude-remote · Local Studio");

    // Toggle back to "当前电脑" -> Active section strictly filters out remote win-s1, then back to "所有电脑"
    await act(async () => {
      computerScopeBtn.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-pinned-session-id="win-s1"]')).toBeNull();
    expect(
      host.querySelector('[data-pinned-session-id="local-s1"]')?.textContent,
    ).not.toContain("· Local Studio");

    await act(async () => {
      allScopeBtn.click();
      await Promise.resolve();
    });

    const computerBlocks = Array.from(
      host.querySelectorAll(".desktop-sidebar .tree-computer"),
    ) as HTMLElement[];
    expect(computerBlocks.map((el) => el.dataset.computerKey)).toEqual([
      DESKTOP_LOCAL,
      winWorkstation.key,
      chengduMini.key,
    ]);

    // Win Workstation consolidates shard paths into 1 "teachvideo" project without redundant "· Win Workstation" suffix
    const winBlock = host.querySelector(
      `.tree-computer[data-computer-key="${winWorkstation.key}"]`,
    ) as HTMLElement;
    const winProjectNames = Array.from(
      winBlock.querySelectorAll(".tree-project__name"),
    ).map((el) => el.textContent);
    expect(winProjectNames).toEqual(["teachvideo"]);
    expect(
      winBlock.querySelectorAll(".tree-session[data-session-id]").length,
    ).toBe(2);

    // 成都-mini shows syncing state while sessionsLoaded is false
    const chengduBlock = host.querySelector(
      `.tree-computer[data-computer-key="${chengduMini.key}"]`,
    ) as HTMLElement;
    expect(chengduBlock.querySelector(".tree-computer__sync")?.textContent).toBe(
      "同步中",
    );

    // Cross-computer Waiting section ("待你处理") includes Win Workstation's waiting session with computer badge
    const waitingPin = host.querySelector(
      '[data-pinned-session-id="win-s1"]',
    ) as HTMLElement;
    expect(waitingPin).not.toBeNull();
    expect(waitingPin.textContent).toContain("Win Workstation");

    // Collapsing a Level-1 computer group sets data-open="false" and inert on .ls-collapse-grid__inner
    const winToggle = winBlock.querySelector(
      ".tree-computer__toggle",
    ) as HTMLButtonElement;
    act(() => {
      winToggle.click();
    });
    expect(winBlock.dataset.open).toBe("false");
    expect(
      winBlock
        .querySelector(".ls-collapse-grid > .ls-collapse-grid__inner")
        ?.hasAttribute("inert"),
    ).toBe(true);
    act(() => {
      winToggle.click();
    });
    expect(winBlock.dataset.open).toBe("true");

    // 3. Live async store update on 成都-mini updates Sidebar & 项目 place count immediately without manual refresh!
    const chengduSession: SessionSummary = {
      id: "chengdu-s1",
      agent: "claude",
      nativeId: "native-chengdu-s1",
      cwd: "/Users/mini/mini-agent",
      title: "Sync gateway metrics",
      state: "running",
      pendingPermissions: 0,
      lastSeq: 4,
      archived: false,
      createdAt: 70_000,
      updatedAt: 71_000,
    };

    act(() => {
      chengduConn.store.setState({
        status: "online",
        sessionsLoaded: true,
        sessions: { [chengduSession.id]: chengduSession },
      });
    });

    const updatedChengduBlock = host.querySelector(
      `.tree-computer[data-computer-key="${chengduMini.key}"]`,
    ) as HTMLElement;
    expect(updatedChengduBlock.querySelector(".tree-computer__sync")).toBeNull();
    expect(
      updatedChengduBlock.querySelector(".tree-computer__count")?.textContent,
    ).toBe("1");
    expect(
      updatedChengduBlock.querySelector(".tree-project__name")?.textContent,
    ).toBe("mini-agent");
    expect(
      updatedChengduBlock.querySelector(
        '.tree-session[data-session-id="chengdu-s1"]',
      ),
    ).not.toBeNull();

    // 项目 place count badge in .desktop-places now reflects all 3 consolidated projects across the 3 computers
    const placesCountsAfter = Array.from(
      host.querySelectorAll(".desktop-places .desktop-place__count"),
    ).map((el) => el.textContent);
    expect(placesCountsAfter[0]).toBe("3");

    // 4. Navigate to 项目 page (ProjectsOverview) -> renders .ls-computer-section per computer -> .ls-entity-list -> expandable sessions
    act(() => {
      routerStore.getState().navigate({ kind: "projects" });
    });

    const sections = Array.from(
      host.querySelectorAll(".shell-page .ls-computer-section"),
    ) as HTMLElement[];
    expect(sections.map((el) => el.dataset.computerKey)).toEqual([
      DESKTOP_LOCAL,
      winWorkstation.key,
      chengduMini.key,
    ]);

    const chengduSection = host.querySelector(
      `.ls-computer-section[data-computer-key="${chengduMini.key}"]`,
    ) as HTMLElement;
    expect(chengduSection.textContent).toContain("成都-mini");
    expect(chengduSection.textContent).toContain("网关");
    expect(chengduSection.textContent).toContain("1 个项目");

    // Expand 成都-mini's project row and click its session subrow -> selects 成都-mini and opens session
    const chengduProjectMain = chengduSection.querySelector(
      ".ls-entity-row__main",
    ) as HTMLButtonElement;
    act(() => {
      chengduProjectMain.click();
    });
    const chengduSubrow = chengduSection.querySelector(
      ".ls-entity-subrow",
    ) as HTMLButtonElement;
    expect(chengduSubrow?.textContent).toContain("Sync gateway metrics");

    act(() => {
      chengduSubrow.click();
    });
    expect(selectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: chengduMini.key }),
    );
    expect(host.querySelector('[data-testid="opened-session"]')?.textContent).toBe(
      `${chengduMini.key}:chengdu-s1`,
    );
  });

  it("synchronizes computer-bound routes on switchToComputer, scopes Right Side Panel & Bottom Dock to session, and renders standalone single-bar Remote Screen (#73 C.1–C.3)", () => {
    const remoteSession: SessionSummary = {
      id: "remote-sess-1",
      agent: "claude",
      nativeId: "native-remote-1",
      cwd: "/Users/remote/linkshell-pack",
      title: "Build notarized universal DMG artifact for standalone macOS release",
      state: "running",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: false,
      createdAt: 80_000,
      updatedAt: 82_000,
    };

    const localConn = makeMockConnection(localMac, { sessions: [] });
    const remoteConn = makeMockConnection(remoteMac, { sessions: [remoteSession] });

    const selectSpy = vi.spyOn(engine, "select").mockImplementation((comp) => {
      engine.state.setState({
        connection: comp.key === DESKTOP_LOCAL ? localConn : remoteConn,
      });
    });

    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: remoteConn,
      locked: false,
    });

    // 1. Remote new-session with remote cwd -> switching back to 本机 resets computerKey AND clears stale cwd
    routerStore.getState().openNewSession(remoteMac.key, "/Users/remote/linkshell-pack");
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "new-session",
      computerKey: remoteMac.key,
      cwd: "/Users/remote/linkshell-pack",
    });

    act(() => {
      switchToComputer(localMac);
    });
    expect(selectSpy).toHaveBeenCalledWith(localMac);
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "new-session",
      computerKey: DESKTOP_LOCAL,
      cwd: undefined,
    });

    // 2. Remote session with Inspector & Bottom Dock open -> full readable session title, zero crushed .workspace-computer-chip
    act(() => {
      switchToComputer(remoteMac);
      routerStore.getState().openSession(remoteMac.key, "remote-sess-1");
      routerStore.getState().toggleInspector(true);
      routerStore.getState().toggleBottomDock(true);
    });

    mount(
      <DesktopAppShell
        platformOverride="macos"
        renderSessionWorkspace={({ sessionId }) => (
          <div data-testid="session-view">{sessionId}</div>
        )}
        renderRemoteScreenWorkspace={({ computerKey }) => (
          <div className="ls-remote-workspace" data-testid="remote-screen-view">
            <div className="ls-remote-subbar chrome-bar">{computerKey}</div>
          </div>
        )}
        renderInspector={() => <div data-testid="right-inspector">Inspector</div>}
        renderBottomTerminal={() => <div data-testid="bottom-dock">Dock</div>}
      />,
    );

    expect(host.querySelector('[data-testid="right-inspector"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bottom-dock"]')).not.toBeNull();
    expect(host.querySelector(".desktop-main-header .workspace-computer-chip")).toBeNull();
    expect(
      host.querySelector(".workspace-title-primary--session")?.textContent,
    ).toBe("Build notarized universal DMG artifact for standalone macOS release");

    // 3. Navigating to standalone Remote Screen omits WorkspaceTopBar, WorkspaceSurfaceTabs, Inspector, and Bottom Dock
    act(() => {
      routerStore.getState().openScreen(remoteMac.key);
    });

    expect(host.querySelector('[data-testid="remote-screen-view"]')).not.toBeNull();
    expect(host.querySelector(".desktop-main-header")).toBeNull();
    expect(host.querySelector(".desktop-surface-tabs")).toBeNull();
    expect(host.querySelector('[data-testid="right-inspector"]')).toBeNull();
    expect(host.querySelector('[data-testid="bottom-dock"]')).toBeNull();

    // 4. Switching back to 本机 from remote screen route navigates cleanly to home on 本机 (never stuck on remote screen)
    act(() => {
      switchToComputer(localMac);
    });
    expect(routerStore.getState().activeRoute).toEqual({ kind: "home" });
    expect(engine.state.getState().connection?.computer.key).toBe(DESKTOP_LOCAL);
  });

  it("preserves retained metadata connections across computers array reference churn (#74) and loads/paginates real archived sessions in ArchiveView (#73 C.4)", async () => {
    const archivedPage1: SessionSummary = {
      id: "arch-local-1",
      agent: "claude",
      nativeId: "native-arch-1",
      cwd: "/Users/turning4th/claude-remote",
      title: "Archived page 1 session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: true,
      createdAt: 10_000,
      updatedAt: 15_000,
    };
    const archivedPage2: SessionSummary = {
      id: "arch-local-2",
      agent: "codex",
      nativeId: "native-arch-2",
      cwd: "/Users/turning4th/claude-remote",
      title: "Archived older page 2 session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: true,
      createdAt: 5_000,
      updatedAt: 6_000,
    };
    const remoteArchived: SessionSummary = {
      id: "arch-remote-1",
      agent: "codex",
      nativeId: "native-arch-r1",
      cwd: "/Users/remote/builder",
      title: "Remote archived build session",
      state: "idle",
      pendingPermissions: 0,
      lastSeq: 1,
      archived: true,
      createdAt: 20_000,
      updatedAt: 22_000,
    };

    let localLoadCalls = 0;
    const localConn = makeMockConnection(localMac, {
      sessions: [],
      loadArchivedImpl: async () => {
        localLoadCalls += 1;
        if (localLoadCalls === 1) {
          localConn.store.setState({
            sessions: { [archivedPage1.id]: archivedPage1 },
            archivedNextBefore: 15_000,
            archivedNextBeforeId: archivedPage1.id,
          });
        } else {
          localConn.store.setState({
            sessions: {
              [archivedPage1.id]: archivedPage1,
              [archivedPage2.id]: archivedPage2,
            },
            archivedNextBefore: undefined,
            archivedNextBeforeId: undefined,
          });
        }
      },
    });

    const remoteLoadSpy = vi.fn().mockImplementation(async () => {
      remoteConn.store.setState({
        sessions: { [remoteArchived.id]: remoteArchived },
      });
    });
    const remoteConn = makeMockConnection(remoteMac, {
      sessions: [],
      loadArchivedImpl: remoteLoadSpy,
    });

    const releaseCounts: Record<string, number> = {
      [localMac.key]: 0,
      [remoteMac.key]: 0,
    };
    const retainCounts: Record<string, number> = {
      [localMac.key]: 0,
      [remoteMac.key]: 0,
    };

    vi.spyOn(engine, "retainComputer").mockImplementation((comp) => {
      retainCounts[comp.key] = (retainCounts[comp.key] ?? 0) + 1;
      return {
        connection: comp.key === DESKTOP_LOCAL ? localConn : remoteConn,
        release: () => {
          releaseCounts[comp.key] = (releaseCounts[comp.key] ?? 0) + 1;
        },
      };
    });

    setProjectScope("all");
    routerStore.getState().navigate({ kind: "archive" });
    engine.state.setState({
      computers: [localMac, remoteMac],
      localComputer: localMac,
      connection: localConn,
      locked: false,
    });

    mount(<DesktopAppShell platformOverride="macos" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 1. Both computers' archived sessions loaded via loadArchived() and grouped under .ls-computer-section
    expect(localLoadCalls).toBe(1);
    expect(remoteLoadSpy).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".shell-page")?.textContent).toContain(
      "Archived page 1 session",
    );
    expect(host.querySelector(".shell-page")?.textContent).toContain(
      "Remote archived build session",
    );

    const baselineLocalRetains = retainCounts[localMac.key]!;
    const baselineRemoteRetains = retainCounts[remoteMac.key]!;
    expect(baselineLocalRetains).toBeGreaterThanOrEqual(1);
    expect(baselineRemoteRetains).toBeGreaterThanOrEqual(1);

    // 2. Simulate live gateway presence / refreshLocal replacing `computers` array with fresh object clones (#74):
    //    retained connections MUST NOT drop refcount or call release()!
    act(() => {
      engine.state.setState({
        computers: [
          { ...localMac, machine: { ...localMac.machine, name: "Local Studio Renamed" } },
          { ...remoteMac, machine: { ...remoteMac.machine } },
        ],
      });
    });
    expect(releaseCounts[localMac.key]).toBe(0);
    expect(releaseCounts[remoteMac.key]).toBe(0);
    expect(retainCounts[localMac.key]).toBe(baselineLocalRetains);
    expect(retainCounts[remoteMac.key]).toBe(baselineRemoteRetains);

    // 3. Clicking "加载更多" fetches page 2 when archivedNextBefore is present
    const loadMoreBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".archive-load-more-row button"),
    ).find((b) => b.textContent?.includes("加载更多"));
    expect(loadMoreBtn).toBeDefined();

    await act(async () => {
      loadMoreBtn!.click();
      await Promise.resolve();
    });

    expect(localLoadCalls).toBe(2);
    expect(host.querySelector(".shell-page")?.textContent).toContain(
      "Archived older page 2 session",
    );
    expect(host.querySelector(".archive-load-more-row")).toBeNull();
  });

  it("enforces permanent zero-3px-stripe ban across all stylesheets, stable Right Side Panel tab geometry, centered remote stage, and Windows caption parity (#73 C.5 & #75)", () => {
    const styleFiles = [
      "tokens.css",
      "chrome.css",
      "primitives.css",
      "shell.css",
      "session.css",
      "inspector.css",
      "remote.css",
      "system.css",
    ];

    for (const file of styleFiles) {
      const content = readFileSync(
        resolve(testDir, "..", "src", "styles", file),
        "utf8",
      );
      expect(content, `${file} must contain zero 3px solid stripes`).not.toContain(
        "3px solid",
      );
    }

    const chromeCss = readFileSync(
      resolve(testDir, "..", "src", "styles", "chrome.css"),
      "utf8",
    );
    expect(chromeCss).not.toContain("!important");
    expect(chromeCss).toContain("--ls-win-caption-w: 138px");
    expect(chromeCss).toContain('[data-screen-fullscreen="true"]');

    const remoteCss = readFileSync(
      resolve(testDir, "..", "src", "styles", "remote.css"),
      "utf8",
    );
    expect(remoteCss).toMatch(
      /\.ls-screen-stage-viewport\s*\{[^}]*position:\s*absolute;\s*inset:\s*0;/s,
    );
    expect(remoteCss).toContain(".ls-screen-fullscreen-handle");

    const inspectorCss = readFileSync(
      resolve(testDir, "..", "src", "styles", "inspector.css"),
      "utf8",
    );
    expect(inspectorCss).toContain(".ls-inspector-header");
    expect(inspectorCss).toContain("interpolate-size: allow-keywords");
    expect(inspectorCss).toContain(":not(.ls-inspector-tabstrip)");
    expect(inspectorCss).toMatch(
      /\.ls-inspector-tab__label\s+\.inspector-tab-title\s*\{[^}]*display:\s*block;/s,
    );
    expect(inspectorCss).toMatch(
      /\.ls-inspector-tabstrip\s+\.ls-inspector-tab\.ls-tab\[aria-selected="true"\]::after[^}]*content:\s*none;/s,
    );
    expect(inspectorCss).toContain(".ls-newtab__tools-grid");
    expect(inspectorCss).toContain(".ls-newtab__tool-card");
    expect(inspectorCss).toContain(".ls-subagent-panel");
    expect(inspectorCss).toContain(".ls-sidechat-panel");
  });

  it("renders bare {macName} without '融合模式 · ' prefix in Home Hub on macOS, suppresses all .home-fusion-row items on Windows clients, and renders Ctrl+/Alt+ shortcuts without macOS glyphs", () => {
    const prevDesktop = window.linkshellDesktop;
    const air3 = {
      ...remoteMac,
      key: "wss://gateway.itool.tech#air3",
      machine: { ...remoteMac.machine, id: "m-air3", name: "air3", platform: "darwin", online: true },
    };
    const packager = {
      ...remoteMac,
      key: "wss://gateway.itool.tech#packager",
      machine: { ...remoteMac.machine, id: "m-pack", name: "打包机", platform: "darwin", online: true },
    };
    const chengduMini = {
      ...remoteMac,
      key: "wss://gateway.itool.tech#chengdu",
      machine: { ...remoteMac.machine, id: "m-cd", name: "成都-mini", platform: "darwin", online: true },
    };
    const localConn = makeMockConnection(localMac);

    engine.state.setState({
      computers: [localMac, air3, packager, chengduMini],
      localComputer: localMac,
      connection: localConn,
      locked: false,
    });
    routerStore.setState({ activeRoute: { kind: "home" } });

    try {
      // 1. macOS Electron client -> renders bare `{macName}` (`air3`, `打包机`, `成都-mini`), zero `"融合模式 · "` prefix
      window.linkshellDesktop = {
        shell: "electron",
        platform: "darwin",
        postMessage: vi.fn(),
      };
      mount(<DesktopAppShell platformOverride="macos" />);

      const macTitles = Array.from(
        host.querySelectorAll(".home-fusion-row__title"),
      ).map((el) => el.textContent?.trim());
      expect(macTitles).toEqual(["air3", "打包机", "成都-mini"]);
      for (const title of macTitles) {
        expect(title).not.toContain("融合模式");
      }

      // 2. Windows Electron client -> renders 0 `.home-fusion-row` elements & Ctrl+/Alt+ shortcuts (0 ⌘/⌥ glyphs)
      window.linkshellDesktop = {
        shell: "electron",
        platform: "win32",
        postMessage: vi.fn(),
      };
      act(() => {
        routerStore.getState().setShortcutSheetOpen(true);
        root.render(
          <I18nProvider>
            <DialogProvider>
              <DesktopAppShell platformOverride="windows" />
            </DialogProvider>
          </I18nProvider>,
        );
      });

      expect(document.documentElement.dataset.platform).toBe("windows");
      expect(host.querySelectorAll(".home-fusion-row")).toHaveLength(0);

      const allKbdText = Array.from(document.querySelectorAll(".ls-kbd"))
        .map((el) => el.textContent ?? "")
        .join(" ");
      expect(allKbdText).toContain("Ctrl");
      expect(allKbdText).not.toContain("⌘");
      expect(allKbdText).not.toContain("⌥");
    } finally {
      act(() => {
        routerStore.getState().setShortcutSheetOpen(false);
      });
      window.linkshellDesktop = prevDesktop;
    }
  });
});
