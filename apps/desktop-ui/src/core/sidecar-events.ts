import {
  DESKTOP_RESUME_EVENT,
  DESKTOP_VISIBILITY_EVENT,
  getDesktopCapability,
  isElectronDesktop,
  openDesktopEventStream,
  type DesktopEventStreamHandle,
} from "../bridge/desktop-bridge";
import type { DesktopSnapshot } from "./management-store";
import type { BootstrappedComputer, DesktopSidecarAccount } from "./storage";

export interface SidecarLoginEvent {
  state: "pending" | "authorize" | "done" | "cancelled" | "error";
  method?: string;
  url?: string;
  error?: string;
}

export interface SidecarEventListener {
  onSnapshot?: (snapshot: DesktopSnapshot) => void;
  onLocal?: (computer: BootstrappedComputer | undefined) => void;
  onAccount?: (account: DesktopSidecarAccount) => void;
  onLogin?: (event: SidecarLoginEvent) => void;
  onPairingDone?: (device: { id: string; name: string }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;

const listeners = new Set<SidecarEventListener>();
let active = false;
let connected = false;
let attempt = 0;
let handle: DesktopEventStreamHandle | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let windowListenersAttached = false;

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) {
    listener.onConnectionChange?.(next);
  }
}

function handleEvent(event: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  switch (event) {
    case "snapshot": {
      const snap = data as DesktopSnapshot;
      for (const listener of listeners) listener.onSnapshot?.(snap);
      break;
    }
    case "local": {
      const computer = (data as { computer?: BootstrappedComputer | null }).computer ?? undefined;
      for (const listener of listeners) listener.onLocal?.(computer);
      break;
    }
    case "account": {
      const acc = data as DesktopSidecarAccount;
      for (const listener of listeners) listener.onAccount?.(acc);
      break;
    }
    case "login": {
      const loginEvent = data as SidecarLoginEvent;
      for (const listener of listeners) listener.onLogin?.(loginEvent);
      break;
    }
    case "pairing.done": {
      const device = (data as { device?: { id?: unknown; name?: unknown } }).device;
      if (device && typeof device.id === "string" && typeof device.name === "string") {
        for (const listener of listeners) {
          listener.onPairingDone?.({ id: device.id, name: device.name });
        }
      }
      break;
    }
  }
}

function scheduleReconnect(): void {
  if (!active || retryTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)]!;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connectNow();
  }, delay);
}

function connectNow(): void {
  if (!active || handle) return;
  if (!isElectronDesktop || !getDesktopCapability()) return;
  const stream = openDesktopEventStream("/desktop/events", {
    onOpen: () => {
      if (handle !== stream) return;
      attempt = 0;
      setConnected(true);
    },
    onEvent: (event, data) => {
      if (handle !== stream) return;
      handleEvent(event, data);
    },
    onClose: () => {
      if (handle !== stream) return;
      handle = undefined;
      setConnected(false);
      scheduleReconnect();
    },
  });
  handle = stream;
}

function reconnectIfDisconnected(): void {
  if (!active) return;
  if (connected && handle) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  attempt = 0;
  connectNow();
}

const onWindowResume = () => reconnectIfDisconnected();
const onWindowOnline = () => reconnectIfDisconnected();
const onWindowVisibility = (event: Event) => {
  const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
  if (detail?.visible !== false) reconnectIfDisconnected();
};

function attachWindowListeners(): void {
  if (windowListenersAttached || typeof window === "undefined") return;
  windowListenersAttached = true;
  window.addEventListener(DESKTOP_RESUME_EVENT, onWindowResume);
  window.addEventListener(DESKTOP_VISIBILITY_EVENT, onWindowVisibility);
  window.addEventListener("online", onWindowOnline);
}

function detachWindowListeners(): void {
  if (!windowListenersAttached || typeof window === "undefined") return;
  windowListenersAttached = false;
  window.removeEventListener(DESKTOP_RESUME_EVENT, onWindowResume);
  window.removeEventListener(DESKTOP_VISIBILITY_EVENT, onWindowVisibility);
  window.removeEventListener("online", onWindowOnline);
}

export function startSidecarEvents(): void {
  if (active) return;
  if (!isElectronDesktop || !getDesktopCapability()) return;
  active = true;
  attempt = 0;
  attachWindowListeners();
  connectNow();
}

export function stopSidecarEvents(): void {
  active = false;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const current = handle;
  handle = undefined;
  current?.close();
  setConnected(false);
  detachWindowListeners();
}

export function isSidecarEventsConnected(): boolean {
  return connected;
}

export function subscribeSidecarEvents(listener: SidecarEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSidecarEventsForTests(): void {
  stopSidecarEvents();
  listeners.clear();
}
