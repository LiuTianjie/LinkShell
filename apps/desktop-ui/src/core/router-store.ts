import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { DESKTOP_COMMAND_EVENT, DESKTOP_LOCAL } from "../bridge/desktop-bridge";
import {
  isManageView,
  managePage,
  manageView,
  parseManagePage,
  type ManagePage,
} from "./management-store";
import { STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";
import { hasUnsavedWork } from "./unsaved-work";

export type InspectorTab =
  | "new-tab"
  | "changes"
  | "files"
  | "ports"
  | "mcp"
  | "terminal"
  | "tasks"
  | "side";

export type WorkspaceRoute =
  | { kind: "home" }
  | { kind: "new-session"; computerKey?: string; cwd?: string }
  | { kind: "session"; computerKey: string; sessionId: string }
  | { kind: "projects"; group?: string }
  | { kind: "computers" }
  | { kind: "archive" }
  | { kind: "screen"; computerKey: string }
  | { kind: "fusion"; computerKey: string }
  | { kind: "terminals"; computerKey: string; terminalId?: string }
  | { kind: "files"; computerKey: string; path?: string }
  | { kind: "ports"; computerKey: string; port?: number }
  | { kind: "worktrees"; computerKey: string };

export interface SystemModalState {
  open: boolean;
  page: ManagePage;
}

export interface RouterLocationAdapter {
  getHash(): string;
  setHash(hash: string): void;
}

function defaultLocationAdapter(): RouterLocationAdapter {
  return {
    getHash() {
      return typeof location !== "undefined" ? location.hash : "";
    },
    setHash(hash: string) {
      if (typeof location === "undefined") return;
      const normalized = hash.startsWith("#") ? hash : hash ? `#${hash}` : "";
      if (typeof history !== "undefined" && typeof history.replaceState === "function") {
        history.replaceState(
          null,
          "",
          `${location.pathname ?? "/"}${location.search ?? ""}${normalized}`,
        );
      } else {
        location.hash = normalized;
      }
    },
  };
}

export function routesEqual(a: WorkspaceRoute, b: WorkspaceRoute): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "home":
    case "computers":
    case "archive":
      return true;
    case "new-session": {
      const other = b as Extract<WorkspaceRoute, { kind: "new-session" }>;
      return a.computerKey === other.computerKey && a.cwd === other.cwd;
    }
    case "session": {
      const other = b as Extract<WorkspaceRoute, { kind: "session" }>;
      return a.computerKey === other.computerKey && a.sessionId === other.sessionId;
    }
    case "projects": {
      const other = b as Extract<WorkspaceRoute, { kind: "projects" }>;
      return a.group === other.group;
    }
    case "screen":
    case "fusion":
    case "worktrees": {
      const other = b as Extract<
        WorkspaceRoute,
        { kind: "screen" | "fusion" | "worktrees" }
      >;
      return a.computerKey === other.computerKey;
    }
    case "terminals": {
      const other = b as Extract<WorkspaceRoute, { kind: "terminals" }>;
      return a.computerKey === other.computerKey && a.terminalId === other.terminalId;
    }
    case "files": {
      const other = b as Extract<WorkspaceRoute, { kind: "files" }>;
      return a.computerKey === other.computerKey && a.path === other.path;
    }
    case "ports": {
      const other = b as Extract<WorkspaceRoute, { kind: "ports" }>;
      return a.computerKey === other.computerKey && a.port === other.port;
    }
  }
}

export function formatWorkspaceView(route: WorkspaceRoute): string {
  switch (route.kind) {
    case "home":
      return "";
    case "new-session":
      return route.computerKey
        ? `new-session:${encodeURIComponent(route.computerKey)}${
            route.cwd ? `:${encodeURIComponent(route.cwd)}` : ""
          }`
        : "new-session";
    case "session":
      return `session:${encodeURIComponent(route.computerKey)}:${encodeURIComponent(
        route.sessionId,
      )}`;
    case "projects":
      return route.group ? `projects:${encodeURIComponent(route.group)}` : "projects";
    case "computers":
      return "computers";
    case "archive":
      return "archive";
    case "screen":
      return `screen:${encodeURIComponent(route.computerKey)}`;
    case "fusion":
      return `fusion:${encodeURIComponent(route.computerKey)}`;
    case "terminals":
      return route.terminalId
        ? `terminals:${encodeURIComponent(route.computerKey)}:${encodeURIComponent(
            route.terminalId,
          )}`
        : `terminals:${encodeURIComponent(route.computerKey)}`;
    case "files":
      return route.path
        ? `files:${encodeURIComponent(route.computerKey)}:${encodeURIComponent(
            route.path,
          )}`
        : `files:${encodeURIComponent(route.computerKey)}`;
    case "ports":
      return route.port
        ? `ports:${encodeURIComponent(route.computerKey)}:${route.port}`
        : `ports:${encodeURIComponent(route.computerKey)}`;
    case "worktrees":
      return `worktrees:${encodeURIComponent(route.computerKey)}`;
  }
}

function decodePart(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const RELAY_COMPUTER_KEY_RE =
  /^((?:wss?|https?):\/\/(?:\[[^\]]+\]|[^/:?#]+)(?::\d+)?(?:\/[^:#]*)?#[^:]+)(?::([\s\S]*))?$/i;
const DIRECT_URL_COMPUTER_KEY_RE =
  /^((?:wss?|https?):\/\/(?:\[[^\]]+\]|[^/:?#]+)(?::\d+)?(?:\/[^:#]*)?)(?::([\s\S]*))?$/i;
const DOUBLE_COLON_COMPUTER_KEY_RE = /^([^:]+::[^:]+)(?::([\s\S]*))?$/;

/**
 * Splits `<computerKey>[:<tail>]` after `URLSearchParams.get("view")` may have already
 * decoded `%3A` once (producing colons inside `desktop:local`, `ws(s)://...#id`,
 * direct `ws(s)://host:port`, or `gw::id` keys) while keeping multi-colon tails
 * (such as Windows `C:\...` paths) intact.
 */
function splitComputerKeyAndTail(
  rest: string,
): [computerKey: string | undefined, tail: string | undefined] {
  const trimmed = rest.trim();
  if (!trimmed) return [undefined, undefined];

  if (trimmed === DESKTOP_LOCAL) return [DESKTOP_LOCAL, undefined];
  if (trimmed.startsWith(`${DESKTOP_LOCAL}:`)) {
    const rawTail = trimmed.slice(DESKTOP_LOCAL.length + 1);
    return [DESKTOP_LOCAL, rawTail ? decodePart(rawTail) : undefined];
  }

  const relayMatch = RELAY_COMPUTER_KEY_RE.exec(trimmed);
  if (relayMatch) {
    const rawTail = relayMatch[2];
    return [relayMatch[1], rawTail ? decodePart(rawTail) : undefined];
  }

  const directUrlMatch = DIRECT_URL_COMPUTER_KEY_RE.exec(trimmed);
  if (directUrlMatch) {
    const rawTail = directUrlMatch[2];
    return [directUrlMatch[1], rawTail ? decodePart(rawTail) : undefined];
  }

  const doubleColonMatch = DOUBLE_COLON_COMPUTER_KEY_RE.exec(trimmed);
  if (doubleColonMatch) {
    const rawTail = doubleColonMatch[2];
    return [doubleColonMatch[1], rawTail ? decodePart(rawTail) : undefined];
  }

  const sep = trimmed.indexOf(":");
  if (sep < 0) return [decodePart(trimmed), undefined];
  if (sep === 0) {
    const rawTail = trimmed.slice(1);
    return [undefined, rawTail ? decodePart(rawTail) : undefined];
  }
  const rawKey = trimmed.slice(0, sep);
  const rawTail = trimmed.slice(sep + 1);
  return [decodePart(rawKey), rawTail ? decodePart(rawTail) : undefined];
}

export function parseWorkspaceView(raw: string | null | undefined): WorkspaceRoute | undefined {
  const view = (raw ?? "").trim();
  if (!view || view === "workspace" || view === "home") return { kind: "home" };
  if (isManageView(view)) return undefined;
  if (view === "new-session") return { kind: "new-session" };
  if (view.startsWith("new-session:")) {
    const [computerKey, cwd] = splitComputerKeyAndTail(view.slice("new-session:".length));
    return {
      kind: "new-session",
      ...(computerKey ? { computerKey } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (view === "computers") return { kind: "computers" };
  if (view === "archive") return { kind: "archive" };
  if (view === "projects") return { kind: "projects" };
  if (view.startsWith("projects:")) {
    return { kind: "projects", group: decodePart(view.slice("projects:".length)) };
  }
  if (view.startsWith("session:")) {
    const [computerKey, sessionId] = splitComputerKeyAndTail(view.slice("session:".length));
    if (computerKey && sessionId) {
      return { kind: "session", computerKey, sessionId };
    }
    return undefined;
  }
  if (view.startsWith("screen:")) {
    const computerKey = decodePart(view.slice("screen:".length));
    return computerKey ? { kind: "screen", computerKey } : undefined;
  }
  if (view === "screen") return { kind: "screen", computerKey: DESKTOP_LOCAL };
  if (view.startsWith("fusion:")) {
    const computerKey = decodePart(view.slice("fusion:".length));
    return computerKey ? { kind: "fusion", computerKey } : undefined;
  }
  if (view === "terminals") return { kind: "terminals", computerKey: DESKTOP_LOCAL };
  if (view.startsWith("terminals:")) {
    const [computerKey, terminalId] = splitComputerKeyAndTail(view.slice("terminals:".length));
    return {
      kind: "terminals",
      computerKey: computerKey ?? DESKTOP_LOCAL,
      ...(terminalId ? { terminalId } : {}),
    };
  }
  if (view === "files") return { kind: "files", computerKey: DESKTOP_LOCAL };
  if (view.startsWith("files:")) {
    const [computerKey, path] = splitComputerKeyAndTail(view.slice("files:".length));
    return {
      kind: "files",
      computerKey: computerKey ?? DESKTOP_LOCAL,
      ...(path ? { path } : {}),
    };
  }
  if (view === "ports") return { kind: "ports", computerKey: DESKTOP_LOCAL };
  if (view.startsWith("ports:")) {
    const [computerKey, rawPort] = splitComputerKeyAndTail(view.slice("ports:".length));
    const parsedPort = rawPort ? Number(rawPort) : Number.NaN;
    return {
      kind: "ports",
      computerKey: computerKey ?? DESKTOP_LOCAL,
      ...(Number.isInteger(parsedPort) && parsedPort > 0 ? { port: parsedPort } : {}),
    };
  }
  if (view === "worktrees") return { kind: "worktrees", computerKey: DESKTOP_LOCAL };
  if (view.startsWith("worktrees:")) {
    return {
      kind: "worktrees",
      computerKey: decodePart(view.slice("worktrees:".length)) ?? DESKTOP_LOCAL,
    };
  }
  return undefined;
}

function buildHashWithView(existingHash: string, viewValue: string): string {
  const params = new URLSearchParams(
    existingHash.startsWith("#") ? existingHash.slice(1) : existingHash,
  );
  if (viewValue) params.set("view", viewValue);
  else params.delete("view");
  const serialized = params.toString();
  return serialized ? `#${serialized}` : "";
}

export interface RouterState {
  activeRoute: WorkspaceRoute;
  history: WorkspaceRoute[];
  historyIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Non-unmounting System & Local Host modal synced with `#view=manage[:<page>]`. */
  systemModal: SystemModalState;
  sidebarHidden: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorTab: InspectorTab;
  inspectorTabRequestSeq: number;
  bottomDockOpen: boolean;
  bottomDockHeight: number;
  commandCenterOpen: boolean;
  connectModalOpen: boolean;
  shortcutSheetOpen: boolean;

  navigate(route: WorkspaceRoute, options?: { replace?: boolean }): boolean;
  openSession(computerKey: string, sessionId: string): boolean;
  openNewSession(computerKey?: string, cwd?: string): boolean;
  openScreen(computerKey: string): boolean;
  openFusion(computerKey: string): boolean;
  back(): boolean;
  forward(): boolean;
  openSystemModal(page?: ManagePage): void;
  closeSystemModal(): void;
  syncFromHash(hash?: string): void;
  toggleSidebar(hidden?: boolean): void;
  setSidebarWidth(width: number): void;
  toggleInspector(open?: boolean, tab?: InspectorTab): void;
  setInspectorTab(tab: InspectorTab): void;
  setInspectorWidth(width: number): void;
  toggleBottomDock(open?: boolean): void;
  setBottomDockHeight(height: number): void;
  setCommandCenterOpen(open: boolean): void;
  setConnectModalOpen(open: boolean): void;
  setShortcutSheetOpen(open: boolean): void;
  hydrateLayout(): void;
}

export interface CreateRouterStoreOptions {
  location?: RouterLocationAdapter;
  initialRoute?: WorkspaceRoute;
  /** Optional synchronous or custom unsaved-work guard; returns `false` to abort route change. */
  confirmNavigate?: (next: WorkspaceRoute, current: WorkspaceRoute) => boolean;
}

const MAX_HISTORY_ENTRIES = 64;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

export function createRouterStore(options: CreateRouterStoreOptions = {}) {
  const loc = options.location ?? defaultLocationAdapter();

  const initialHash = loc.getHash();
  const initialParams = new URLSearchParams(
    initialHash.startsWith("#") ? initialHash.slice(1) : initialHash,
  );
  const initialView = initialParams.get("view") ?? "";
  const initialModalOpen = isManageView(initialView);
  const initialModalPage: ManagePage = initialModalOpen
    ? managePage(initialView)
    : "overview";
  const parsedInitialRoute =
    options.initialRoute ?? parseWorkspaceView(initialView) ?? { kind: "home" };

  return createStore<RouterState>((set, get) => {
    const syncUrlHash = (route: WorkspaceRoute, modal: SystemModalState) => {
      const targetView = modal.open
        ? manageView(modal.page)
        : formatWorkspaceView(route);
      loc.setHash(buildHashWithView(loc.getHash(), targetView));
    };

    return {
      activeRoute: parsedInitialRoute,
      history: [parsedInitialRoute],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
      systemModal: { open: initialModalOpen, page: initialModalPage },
      sidebarHidden: Boolean(readLocal<boolean>(STORAGE_KEYS.sidebarHidden, false)),
      sidebarWidth: clamp(readLocal<number>(STORAGE_KEYS.sidebarWidth, 256), 210, 420),
      inspectorOpen: false,
      inspectorWidth: clamp(
        readLocal<number>(STORAGE_KEYS.inspectorWidth, 400),
        280,
        720,
      ),
      inspectorTab: "new-tab",
      inspectorTabRequestSeq: 0,
      bottomDockOpen: false,
      bottomDockHeight: clamp(
        readLocal<number>(STORAGE_KEYS.bottomDockHeight, 240),
        140,
        560,
      ),
      commandCenterOpen: false,
      connectModalOpen: false,
      shortcutSheetOpen: false,

      navigate: (route, navOptions) => {
        const current = get();
        if (
          options.confirmNavigate &&
          hasUnsavedWork() &&
          !routesEqual(current.activeRoute, route) &&
          !options.confirmNavigate(route, current.activeRoute)
        ) {
          return false;
        }
        const closingModal: SystemModalState = current.systemModal.open
          ? { ...current.systemModal, open: false }
          : current.systemModal;

        if (routesEqual(current.activeRoute, route)) {
          if (current.systemModal.open) {
            set({ systemModal: closingModal });
            syncUrlHash(route, closingModal);
          }
          return true;
        }

        let nextHistory: WorkspaceRoute[];
        let nextIndex: number;
        if (navOptions?.replace) {
          nextHistory = [...current.history];
          nextHistory[current.historyIndex] = route;
          nextIndex = current.historyIndex;
        } else {
          const head = current.history.slice(0, current.historyIndex + 1);
          head.push(route);
          if (head.length > MAX_HISTORY_ENTRIES) {
            head.shift();
          }
          nextHistory = head;
          nextIndex = nextHistory.length - 1;
        }

        set({
          activeRoute: route,
          history: nextHistory,
          historyIndex: nextIndex,
          canGoBack: nextIndex > 0,
          canGoForward: nextIndex < nextHistory.length - 1,
          systemModal: closingModal,
        });
        syncUrlHash(route, closingModal);
        return true;
      },

      openSession: (computerKey, sessionId) =>
        get().navigate({ kind: "session", computerKey, sessionId }),

      openNewSession: (computerKey, cwd) =>
        get().navigate({ kind: "new-session", computerKey, cwd }),

      openScreen: (computerKey) => get().navigate({ kind: "screen", computerKey }),

      openFusion: (computerKey) => get().navigate({ kind: "fusion", computerKey }),

      back: () => {
        const current = get();
        if (current.systemModal.open) {
          current.closeSystemModal();
          return true;
        }
        if (current.historyIndex <= 0) return false;
        const nextIndex = current.historyIndex - 1;
        const route = current.history[nextIndex]!;
        if (
          options.confirmNavigate &&
          hasUnsavedWork() &&
          !options.confirmNavigate(route, current.activeRoute)
        ) {
          return false;
        }
        set({
          activeRoute: route,
          historyIndex: nextIndex,
          canGoBack: nextIndex > 0,
          canGoForward: nextIndex < current.history.length - 1,
        });
        syncUrlHash(route, current.systemModal);
        return true;
      },

      forward: () => {
        const current = get();
        if (current.historyIndex >= current.history.length - 1) return false;
        const nextIndex = current.historyIndex + 1;
        const route = current.history[nextIndex]!;
        if (
          options.confirmNavigate &&
          hasUnsavedWork() &&
          !options.confirmNavigate(route, current.activeRoute)
        ) {
          return false;
        }
        set({
          activeRoute: route,
          historyIndex: nextIndex,
          canGoBack: nextIndex > 0,
          canGoForward: nextIndex < current.history.length - 1,
        });
        syncUrlHash(route, current.systemModal);
        return true;
      },

      openSystemModal: (page) => {
        const current = get();
        const nextModal: SystemModalState = {
          open: true,
          page: page ?? current.systemModal.page ?? "overview",
        };
        // CRITICAL: Never unmount or alter `activeRoute` when opening `#view=manage[:<page>]`!
        set({ systemModal: nextModal });
        syncUrlHash(current.activeRoute, nextModal);
      },

      closeSystemModal: () => {
        const current = get();
        if (!current.systemModal.open) return;
        const nextModal: SystemModalState = { ...current.systemModal, open: false };
        set({ systemModal: nextModal });
        syncUrlHash(current.activeRoute, nextModal);
      },

      syncFromHash: (hashArg) => {
        const rawHash = hashArg ?? loc.getHash();
        const params = new URLSearchParams(
          rawHash.startsWith("#") ? rawHash.slice(1) : rawHash,
        );
        const view = params.get("view") ?? "";
        const current = get();
        if (isManageView(view)) {
          const page = managePage(view);
          if (!current.systemModal.open || current.systemModal.page !== page) {
            set({ systemModal: { open: true, page } });
          }
          return;
        }
        if (view === "workspace") {
          if (current.systemModal.open) {
            const nextModal: SystemModalState = { ...current.systemModal, open: false };
            set({ systemModal: nextModal });
            syncUrlHash(current.activeRoute, nextModal);
          }
          return;
        }
        const parsed = parseWorkspaceView(view);
        if (parsed) {
          if (!routesEqual(current.activeRoute, parsed)) {
            const head = current.history.slice(0, current.historyIndex + 1);
            head.push(parsed);
            if (head.length > MAX_HISTORY_ENTRIES) head.shift();
            const nextIndex = head.length - 1;
            set({
              activeRoute: parsed,
              history: head,
              historyIndex: nextIndex,
              canGoBack: nextIndex > 0,
              canGoForward: false,
              systemModal: { ...current.systemModal, open: false },
            });
          } else if (current.systemModal.open) {
            set({ systemModal: { ...current.systemModal, open: false } });
          }
        }
      },

      toggleSidebar: (hidden) => {
        const next = hidden ?? !get().sidebarHidden;
        set({ sidebarHidden: next });
        saveLocal(STORAGE_KEYS.sidebarHidden, next);
      },

      setSidebarWidth: (width) => {
        const clamped = clamp(width, 210, 420);
        set({ sidebarWidth: clamped });
        saveLocal(STORAGE_KEYS.sidebarWidth, clamped);
      },

      toggleInspector: (open, tab) => {
        const current = get();
        if (tab && current.inspectorOpen && open === undefined) {
          if (current.inspectorTab === tab) {
            set({ inspectorOpen: false });
          } else {
            set({
              inspectorTab: tab,
              inspectorTabRequestSeq: current.inspectorTabRequestSeq + 1,
            });
          }
          return;
        }
        const nextOpen = open ?? !current.inspectorOpen;
        set({
          inspectorOpen: nextOpen,
          ...(tab
            ? {
                inspectorTab: tab,
                inspectorTabRequestSeq: current.inspectorTabRequestSeq + 1,
              }
            : {}),
        });
      },

      setInspectorTab: (tab) => {
        set((state) => ({
          inspectorOpen: true,
          inspectorTab: tab,
          inspectorTabRequestSeq: state.inspectorTabRequestSeq + 1,
        }));
      },

      setInspectorWidth: (width) => {
        const clamped = clamp(width, 280, 720);
        set({ inspectorWidth: clamped });
        saveLocal(STORAGE_KEYS.inspectorWidth, clamped);
      },

      toggleBottomDock: (open) => {
        set({ bottomDockOpen: open ?? !get().bottomDockOpen });
      },

      setBottomDockHeight: (height) => {
        const clamped = clamp(height, 140, 560);
        set({ bottomDockHeight: clamped });
        saveLocal(STORAGE_KEYS.bottomDockHeight, clamped);
      },

      setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
      setConnectModalOpen: (open) => set({ connectModalOpen: open }),
      setShortcutSheetOpen: (open) => set({ shortcutSheetOpen: open }),

      hydrateLayout: () => {
        set({
          sidebarHidden: Boolean(readLocal<boolean>(STORAGE_KEYS.sidebarHidden, false)),
          sidebarWidth: clamp(
            readLocal<number>(STORAGE_KEYS.sidebarWidth, 256),
            210,
            420,
          ),
          inspectorWidth: clamp(
            readLocal<number>(STORAGE_KEYS.inspectorWidth, 400),
            280,
            720,
          ),
          bottomDockHeight: clamp(
            readLocal<number>(STORAGE_KEYS.bottomDockHeight, 240),
            140,
            560,
          ),
        });
      },
    };
  });
}

export const routerStore = createRouterStore();
subscribeStorageReady(() => routerStore.getState().hydrateLayout());

export function useRouter<T = RouterState>(
  selector: (state: RouterState) => T = (s) => s as unknown as T,
): T {
  return useStore(routerStore, selector);
}

/**
 * Wires `window` `hashchange` and Electron menu/tray `linkshell-desktop-command` events
 * (`manage`, `workspace`, `palette`, `new-session`, `toggle-sidebar`, `inspector`) to `routerStore`.
 */
export function attachRouterListeners(store = routerStore): () => void {
  if (typeof window === "undefined") return () => {};
  const onHashChange = () => store.getState().syncFromHash();
  const onDesktopCommand = (event: Event) => {
    const detail = ((event as CustomEvent<Record<string, unknown>>).detail ?? {});
    const command = detail.command;
    const router = store.getState();
    switch (command) {
      case "palette":
        router.setCommandCenterOpen(!router.commandCenterOpen);
        break;
      case "new-session":
        router.openNewSession(
          typeof detail.computerKey === "string" ? detail.computerKey : undefined,
        );
        break;
      case "toggle-sidebar":
        router.toggleSidebar();
        break;
      case "inspector": {
        const tab = detail.tab;
        const validTab: InspectorTab | undefined =
          tab === "new-tab" ||
          tab === "changes" ||
          tab === "files" ||
          tab === "ports" ||
          tab === "mcp" ||
          tab === "terminal" ||
          tab === "tasks" ||
          tab === "side"
            ? tab
            : undefined;
        router.toggleInspector(undefined, validTab);
        break;
      }
      case "manage": {
        const page = parseManagePage(detail.page);
        router.openSystemModal(page ?? "overview");
        break;
      }
      case "workspace":
        router.closeSystemModal();
        break;
    }
  };
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener(DESKTOP_COMMAND_EVENT, onDesktopCommand);
  return () => {
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener(DESKTOP_COMMAND_EVENT, onDesktopCommand);
  };
}
