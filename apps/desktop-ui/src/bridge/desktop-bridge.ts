export type DesktopAppearance = "light" | "dark" | "system";
export type RawPlatform = "darwin" | "win32" | "linux";
export type DesktopPlatform = "macos" | "windows" | "linux";

export interface DesktopFlushResult {
  saved: boolean;
  pending: number;
}

export type DesktopFlushHandler = () =>
  | Promise<DesktopFlushResult>
  | DesktopFlushResult;

export interface ElectronPreloadBridge {
  readonly shell: "electron";
  readonly platform: string;
  appearance?(): string | undefined;
  visible?(): boolean;
  postMessage(message: Record<string, unknown>): void;
  setFlush?(fn: (() => Promise<DesktopFlushResult>) | null): void;
}

export interface LinkShellRuntimeConfig {
  desktop?: boolean;
  desktopPlatform?: string;
  deployment?: string;
  previewOrigin?: string;
}

declare global {
  interface Window {
    linkshellDesktop?: ElectronPreloadBridge;
    __LINKSHELL_CONFIG__?: LinkShellRuntimeConfig;
    __LINKSHELL_DESKTOP_APPEARANCE__?: string;
    __LINKSHELL_DESKTOP_VISIBLE__?: boolean;
    __LINKSHELL_DESKTOP_FLUSH__?: () => Promise<DesktopFlushResult>;
    webkit?: {
      messageHandlers?: {
        linkshellDesktop?: { postMessage(value: unknown): void };
      };
    };
  }
}

export const DESKTOP_LOCAL = "desktop:local";
export const CAPABILITY_STORAGE_KEY = "linkshell.desktop.capability";

export const DESKTOP_APPEARANCE_EVENT = "linkshell-desktop-appearance";
export const DESKTOP_VISIBILITY_EVENT = "linkshell-desktop-visibility";
export const DESKTOP_SURFACE_EVENT = "linkshell-desktop-surface";
export const DESKTOP_WINDOW_EVENT = "linkshell-desktop-window";
export const DESKTOP_FULLSCREEN_EVENT = "linkshell-desktop-fullscreen";
export const DESKTOP_COMMAND_EVENT = "linkshell-desktop-command";
export const DESKTOP_REPLY_EVENT = "linkshell-desktop-reply";
export const DESKTOP_LOGIN_EVENT = "linkshell-desktop-login";
export const DESKTOP_UPDATE_EVENT = "linkshell-desktop-update";
export const DESKTOP_NATIVE_SCREEN_EVENT = "linkshell-native-screen";
export const DESKTOP_FUSION_TUNNEL_EVENT = "linkshell-fusion-tunnel";
export const DESKTOP_ACCOUNT_EVENT = "linkshell-desktop-account";
export const DESKTOP_ERROR_EVENT = "linkshell-desktop-error";
export const DESKTOP_HOST_EVENT = "linkshell-desktop-host";

function getPreloadBridge(): ElectronPreloadBridge | undefined {
  return typeof window !== "undefined" ? window.linkshellDesktop : undefined;
}

function detectRawPlatform(): RawPlatform {
  if (typeof window !== "undefined") {
    const reported =
      window.linkshellDesktop?.platform ??
      window.__LINKSHELL_CONFIG__?.desktopPlatform;
    if (reported === "win32" || reported === "windows") return "win32";
    if (reported === "darwin" || reported === "macos") return "darwin";
    if (reported === "linux") return "linux";
  }
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return "win32";
    if (ua.includes("mac")) return "darwin";
  }
  const nodePlatform = (globalThis as { process?: { platform?: string } }).process?.platform;
  if (nodePlatform === "win32") return "win32";
  if (nodePlatform === "darwin") return "darwin";
  return "linux";
}

export const rawPlatform: RawPlatform = detectRawPlatform();

export const desktopPlatform: DesktopPlatform =
  rawPlatform === "win32"
    ? "windows"
    : rawPlatform === "darwin"
      ? "macos"
      : "linux";

export const isDesktop: boolean =
  typeof window !== "undefined" &&
  (window.__LINKSHELL_CONFIG__?.desktop === true ||
    window.linkshellDesktop?.shell === "electron");

export const isElectronDesktop: boolean =
  typeof window !== "undefined" &&
  window.linkshellDesktop?.shell === "electron";

export const isMacDesktop: boolean = rawPlatform === "darwin";
export const isWindowsDesktop: boolean = rawPlatform === "win32";

export function normalizeDesktopPlatform(
  value: string | undefined | null,
): DesktopPlatform | undefined {
  if (value === "win32" || value === "windows") return "windows";
  if (value === "darwin" || value === "macos") return "macos";
  if (value === "linux") return "linux";
  return undefined;
}

export function isElectronRuntime(): boolean {
  if (isElectronDesktop) return true;
  if (typeof window === "undefined") return false;
  return (
    window.linkshellDesktop?.shell === "electron" ||
    window.__LINKSHELL_CONFIG__?.desktop === true
  );
}

/**
 * Resolves the active desktop platform dynamically, honoring explicit preload/config mocks
 * as well as runtime `data-platform` attributes on `:root` / `.desktop-root`.
 */
export function getActiveDesktopPlatform(): DesktopPlatform {
  const rootAttr =
    typeof document !== "undefined"
      ? normalizeDesktopPlatform(
          document.documentElement?.dataset?.platform ??
            document.querySelector<HTMLElement>(".desktop-root")?.dataset?.platform,
        )
      : undefined;
  const bridgePlat =
    typeof window !== "undefined"
      ? normalizeDesktopPlatform(
          window.linkshellDesktop?.platform ??
            window.__LINKSHELL_CONFIG__?.desktopPlatform,
        )
      : undefined;
  if (rootAttr && rootAttr !== desktopPlatform) {
    return rootAttr;
  }
  if (bridgePlat && bridgePlat !== desktopPlatform) {
    return bridgePlat;
  }
  return rootAttr ?? bridgePlat ?? desktopPlatform;
}

const platformListeners = new Set<() => void>();
let platformObserver: MutationObserver | null = null;

export function notifyDesktopPlatformChanged(): void {
  for (const fn of platformListeners) {
    fn();
  }
}

export function subscribeDesktopPlatform(listener: () => void): () => void {
  platformListeners.add(listener);
  if (
    !platformObserver &&
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined" &&
    document.documentElement
  ) {
    platformObserver = new MutationObserver(() => {
      for (const fn of platformListeners) {
        fn();
      }
    });
    platformObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-platform"],
    });
  }
  return () => {
    platformListeners.delete(listener);
    if (platformListeners.size === 0 && platformObserver) {
      platformObserver.disconnect();
      platformObserver = null;
    }
  };
}

export function getShellAppearance(): DesktopAppearance | undefined {
  if (typeof window === "undefined") return undefined;
  const raw =
    getPreloadBridge()?.appearance?.() ??
    window.__LINKSHELL_DESKTOP_APPEARANCE__;
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return undefined;
}

export function getShellVisible(): boolean {
  if (typeof window === "undefined") return true;
  const bridge = getPreloadBridge();
  if (bridge?.visible) return bridge.visible();
  return window.__LINKSHELL_DESKTOP_VISIBLE__ !== false;
}

export function postDesktopMessage(message: Record<string, unknown>): boolean {
  if (typeof window === "undefined") return false;
  const bridge = getPreloadBridge();
  if (bridge) {
    bridge.postMessage(message);
    return true;
  }
  const webkitHandler = window.webkit?.messageHandlers?.linkshellDesktop;
  if (webkitHandler) {
    webkitHandler.postMessage(message);
    return true;
  }
  return false;
}

interface PendingReply {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingReplies = new Map<string, PendingReply>();
let replyListenerAttached = false;

function ensureReplyListener(): void {
  if (replyListenerAttached || typeof window === "undefined") return;
  replyListenerAttached = true;
  window.addEventListener(DESKTOP_REPLY_EVENT, (event: Event) => {
    const detail = ((event as CustomEvent).detail ?? {}) as {
      id?: string;
      result?: unknown;
      error?: string;
    };
    if (!detail.id) return;
    const entry = pendingReplies.get(detail.id);
    if (!entry) return;
    pendingReplies.delete(detail.id);
    clearTimeout(entry.timer);
    if (detail.error) {
      entry.reject(new Error(detail.error));
    } else {
      entry.resolve(detail.result);
    }
  });
}

export function desktopInvoke<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const bridge = getPreloadBridge();
  if (!bridge) {
    return Promise.reject(new Error("本机管理需要 LinkShell 桌面版"));
  }
  ensureReplyListener();
  const id = crypto.randomUUID();
  const effectiveTimeout =
    timeoutMs ?? (method === "login" ? 400_000 : 130_000);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error("操作超时，请重试"));
    }, effectiveTimeout);
    pendingReplies.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    bridge.postMessage({ action: "invoke", id, method, params });
  });
}

let cachedCapability: string | undefined;

function readSessionStorageSafe(key: string): string | undefined {
  try {
    return typeof sessionStorage !== "undefined"
      ? (sessionStorage.getItem(key) ?? undefined)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeSessionStorageSafe(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore restricted test environments without Web Storage.
  }
}

/**
 * Extracts `#desktop=<capability>` from the initial URL hash (persisting to `sessionStorage`
 * and stripping `#desktop` from `location.hash` while preserving route parameters like `#view=manage`),
 * or returns the previously captured capability token.
 */
export function getDesktopCapability(): string | undefined {
  if (typeof location !== "undefined" && typeof location.hash === "string" && location.hash.length > 1) {
    const params = new URLSearchParams(location.hash.slice(1));
    const fromHash = params.get("desktop");
    if (fromHash) {
      cachedCapability = fromHash;
      writeSessionStorageSafe(CAPABILITY_STORAGE_KEY, fromHash);
      params.delete("desktop");
      try {
        if (typeof history !== "undefined" && typeof history.replaceState === "function") {
          const rest = params.toString();
          history.replaceState(
            null,
            "",
            `${location.pathname ?? "/"}${location.search ?? ""}${rest ? `#${rest}` : ""}`,
          );
        }
      } catch {
        // Ignore non-browser mock locations without history.replaceState.
      }
      return cachedCapability;
    }
  }
  if (cachedCapability) return cachedCapability;
  const stored = readSessionStorageSafe(CAPABILITY_STORAGE_KEY);
  if (stored) {
    cachedCapability = stored;
    return stored;
  }
  return undefined;
}

export interface DesktopFetchInit extends RequestInit {
  timeoutMs?: number;
}

export async function desktopFetch<T = unknown>(
  path: string,
  init: DesktopFetchInit = {},
): Promise<T> {
  const token = getDesktopCapability();
  if (!token) {
    throw new Error("桌面工作台尚未连接，请重新打开窗口");
  }
  if (!/^\/desktop\/[a-z-]+$/.test(path)) {
    throw new Error("无效的桌面请求");
  }
  const { timeoutMs = 15_000, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (requestInit.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...requestInit,
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: requestInit.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || "桌面服务暂时不可用，请重试");
  }
  return data;
}

export function desktopHostWsUrl(): string | undefined {
  const token = getDesktopCapability();
  if (!token || typeof location === "undefined" || !location.origin) {
    return undefined;
  }
  const url = new URL("/desktop/host", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

export function openDesktopHostSocket(): WebSocket {
  const url = desktopHostWsUrl();
  if (!url) {
    throw new Error("桌面连接已失效，请重新打开窗口");
  }
  return new WebSocket(url);
}

export function previewOriginUrl(): string | undefined {
  if (typeof window !== "undefined") {
    const configured = window.__LINKSHELL_CONFIG__?.previewOrigin;
    if (typeof configured === "string" && configured.length > 0) {
      return configured;
    }
  }
  if (typeof location !== "undefined" && location.port) {
    const proto = location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//localhost:${location.port}`;
  }
  return undefined;
}

export function openExternalUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    return;
  }
  if (!postDesktopMessage({ action: "external", url: parsed.href })) {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(parsed.href, "_blank", "noopener,noreferrer");
    }
  }
}

export interface NativeContextMenuItem {
  id?: string;
  label?: string;
  type?: "separator";
  enabled?: boolean;
  checked?: boolean;
  /** Electron accelerator format, e.g. `"CommandOrControl+Shift+A"`. */
  accelerator?: string;
  submenu?: NativeContextMenuItem[];
}

export async function showNativeContextMenu(
  items: NativeContextMenuItem[],
  at?: { x: number; y: number },
): Promise<string | null> {
  if (!getPreloadBridge()) return null;
  const result = await desktopInvoke<{ id?: string | null }>(
    "contextMenu",
    { items, at },
    3_600_000,
  );
  return result?.id ?? null;
}

const flushHandlers = new Set<DesktopFlushHandler>();
let flushWired = false;

async function runFlushHandlers(): Promise<DesktopFlushResult> {
  if (flushHandlers.size === 0) {
    return { saved: true, pending: 0 };
  }
  let saved = true;
  let pending = 0;
  for (const handler of [...flushHandlers]) {
    try {
      const res = await handler();
      if (!res.saved) saved = false;
      pending += Math.max(0, res.pending);
    } catch {
      saved = false;
      pending += 1;
    }
  }
  return { saved: saved && pending === 0, pending };
}

function wireFlushBarrier(): void {
  if (typeof window === "undefined") return;
  if (!flushWired) {
    flushWired = true;
    window.__LINKSHELL_DESKTOP_FLUSH__ = runFlushHandlers;
  }
  getPreloadBridge()?.setFlush?.(runFlushHandlers);
}

export function registerDesktopFlush(
  fn: DesktopFlushHandler | null,
): () => void {
  if (fn === null) {
    flushHandlers.clear();
    wireFlushBarrier();
    return () => {};
  }
  flushHandlers.add(fn);
  wireFlushBarrier();
  return () => {
    flushHandlers.delete(fn);
  };
}

export function reportDesktopRendererReady(): void {
  postDesktopMessage({ action: "renderer-ready" });
}

export function applyDocumentTheme(value: DesktopAppearance | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value === "light" || value === "dark") {
    root.dataset.theme = value;
  } else {
    delete root.dataset.theme;
  }
}

export function setAppearanceBridge(value: DesktopAppearance): void {
  applyDocumentTheme(value);
  postDesktopMessage({ action: "appearance", value });
}

export function setDesktopScreenFullScreen(
  enabled: boolean,
  options?: { immersive?: boolean },
): boolean {
  return postDesktopMessage({
    action: "screenFullScreen",
    enabled,
    ...(options?.immersive ? { immersive: true } : {}),
  });
}

export function setDesktopScreenKeys(captured: boolean): void {
  postDesktopMessage({ action: "screenKeys", captured });
}

export function revealOnDesktop(path: string): Promise<unknown> {
  return desktopInvoke("reveal", { path }, 15_000);
}
