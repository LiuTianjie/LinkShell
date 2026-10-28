import type { Identity } from "@linkshell/wire";
import type { Computer } from "./engine";

interface ElectronBridge {
  postMessage(value: unknown): void;
  shell: "electron";
  platform: string;
  appearance?(): string | undefined;
  visible?(): boolean;
  setFlush?(flush: () => Promise<{ saved: boolean; pending: number }>): void;
}
const electron = typeof window !== "undefined"
  ? (window as Window & { linkshellDesktop?: ElectronBridge }).linkshellDesktop
  : undefined;

/**
 * The window's appearance setting as the shell knows it: the Electron bridge, else what the
 * Mac app's own WKWebView put on `window` before the page ran.
 */
export function shellAppearance(): string | undefined {
  if (electron?.appearance) return electron.appearance();
  const value = (window as Window & { __LINKSHELL_DESKTOP_APPEARANCE__?: unknown }).__LINKSHELL_DESKTOP_APPEARANCE__;
  return typeof value === "string" ? value : undefined;
}

/** Whether the shell's window is on screen (true when the shell doesn't say). */
export function shellVisible(): boolean {
  if (electron?.visible) return electron.visible();
  return (window as Window & { __LINKSHELL_DESKTOP_VISIBLE__?: boolean }).__LINKSHELL_DESKTOP_VISIBLE__ !== false;
}

export const isDesktop =
  typeof window !== "undefined" && window.__LINKSHELL_CONFIG__?.desktop === true;
export const isWindowsDesktop = isDesktop && window.__LINKSHELL_CONFIG__?.desktopPlatform === "win32";
/** The Electron window draws its own title bar row: the page leaves room for the traffic lights and owns local management. */
export const isElectronDesktop = isDesktop && electron?.shell === "electron";
/** What the workspace calls the computer it runs on, and where that computer shows a file. */
export const THIS_COMPUTER = isWindowsDesktop ? "这台电脑" : "这台 Mac";
/** The same before Chinese text: "Mac" keeps a space from what follows, "电脑" doesn't. */
export const THIS_COMPUTER_SPACED = isWindowsDesktop ? THIS_COMPUTER : `${THIS_COMPUTER} `;
export const REVEAL_IN_FILES = isWindowsDesktop ? "在资源管理器中显示" : "在 Finder 中显示";
export const DESKTOP_LOCAL = "desktop:local";
export const DESKTOP_VISIBILITY_EVENT = "linkshell-desktop-visibility";
export const DESKTOP_ACCOUNT_EVENT = "linkshell-desktop-account";
export const DESKTOP_ERROR_EVENT = "linkshell-desktop-error";

export interface DesktopAccount {
  userId?: string;
  email?: string;
  accessToken?: string;
}
interface DesktopBootstrap {
  identity: Identity;
  storage: Record<string, unknown>;
  localComputer?: Computer;
}

let capability: string | undefined;
let bootstrap: DesktopBootstrap | undefined;
let booting: Promise<void> | undefined;
let storageWrites = Promise.resolve();
let storageFlush: Promise<{ saved: boolean; pending: number }> | undefined;
interface StorageWrite { value: unknown }
const unsaved = new Map<string, StorageWrite>();
let account: DesktopAccount = {};
let accountRequest: Promise<DesktopAccount> | undefined;
let accountGeneration = 0;

export function reportDesktopError(error: unknown) {
  window.dispatchEvent(new CustomEvent(DESKTOP_ERROR_EVENT, {
    detail: error instanceof Error ? error.message : String(error),
  }));
}

export async function desktopRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isDesktop || !capability) throw new Error("桌面工作台尚未连接，请重新打开窗口");
  if (!/^\/desktop\/[a-z]+$/.test(path)) throw new Error("无效的桌面请求");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${capability}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "桌面服务暂时不可用，请重试");
  return data;
}

export async function bootstrapDesktop(): Promise<void> {
  if (!isDesktop || bootstrap) return;
  if (booting) return booting;
  booting = (async () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const fromURL = hash.get("desktop");
    capability = fromURL || sessionStorage.getItem("linkshell.desktop.capability") || undefined;
    if (fromURL) {
      sessionStorage.setItem("linkshell.desktop.capability", fromURL);
      hash.delete("desktop");
      history.replaceState(null, "", location.pathname + location.search + (hash.size ? `#${hash}` : ""));
    }
    bootstrap = await desktopRequest<DesktopBootstrap>("/desktop/bootstrap");
    document.documentElement.dataset.desktop = "true";
    // The other shells call this global; Electron's preload can't see the page's globals, so it
    // is handed over through the bridge as well.
    (window as Window & { __LINKSHELL_DESKTOP_FLUSH__?: typeof flushDesktopStorage }).__LINKSHELL_DESKTOP_FLUSH__ = flushDesktopStorage;
    electron?.setFlush?.(flushDesktopStorage);
  })().finally(() => { booting = undefined; });
  return booting;
}

export function desktopIdentity(): Identity {
  if (!bootstrap) throw new Error("桌面设备身份尚未载入");
  return bootstrap.identity;
}

export function desktopLocalComputer(): Computer | undefined {
  return bootstrap?.localComputer;
}

export function readDesktopStorage<T>(key: string, fallback: T): T {
  return (bootstrap?.storage[key] as T | null | undefined) ?? fallback;
}

function queueStorageWrite(key: string, write: StorageWrite) {
  storageWrites = storageWrites.then(async () => {
    try {
      await desktopRequest("/desktop/storage", { method: "PUT", body: JSON.stringify({ key, value: write.value }) });
      // Editing back to an earlier value still creates a distinct pending write.
      if (unsaved.get(key) === write) unsaved.delete(key);
    } catch (error) {
      reportDesktopError(new Error(`工作台设置尚未保存：${error instanceof Error ? error.message : String(error)}。请重试连接。`));
    }
  });
}

export function saveDesktopStorage(key: string, value: unknown): void {
  if (!bootstrap) throw new Error("桌面工作台尚未初始化");
  // Capture the JSON value now, so later mutations cannot alter an already queued write.
  const snapshot = value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
  bootstrap.storage[key] = snapshot;
  const write = { value: snapshot };
  unsaved.set(key, write);
  queueStorageWrite(key, write);
}

export function retryDesktopStorage(): Promise<void> {
  for (const [key, write] of unsaved) queueStorageWrite(key, write);
  return storageWrites;
}

async function drainDesktopStorage(): Promise<void> {
  let queued: Promise<void>;
  do {
    queued = storageWrites;
    await queued;
    // A last edit may have arrived while the previous request was in flight.
  } while (queued !== storageWrites);
}

/** Native shutdown waits for this acknowledgement before ending the sidecar. */
export function flushDesktopStorage(): Promise<{ saved: boolean; pending: number }> {
  return storageFlush ??= (async () => {
    await drainDesktopStorage();
    if (unsaved.size) await retryDesktopStorage();
    await drainDesktopStorage();
    return { saved: unsaved.size === 0, pending: unsaved.size };
  })().finally(() => { storageFlush = undefined; });
}

function updateAccount(next: DesktopAccount) {
  const changed = next.userId !== account.userId || next.email !== account.email || next.accessToken !== account.accessToken;
  account = next;
  if (changed) window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_EVENT, { detail: next }));
  return next;
}

export function desktopAccount(): Promise<DesktopAccount> {
  if (accountRequest) return accountRequest;
  const generation = accountGeneration;
  const request = desktopRequest<DesktopAccount>("/desktop/account").then((next) =>
    generation === accountGeneration ? updateAccount(next) : account,
  ).finally(() => { if (accountRequest === request) accountRequest = undefined; });
  accountRequest = request;
  return request;
}

export type DesktopSignInMethod = "web" | "password" | "github" | "google";
export type DesktopSignIn =
  | { method: "web" | "github" | "google" }
  | { method: "password"; email: string; password: string };

/** Signs this computer in (the workspace service writes the account file); resolves once it has. */
export async function desktopLogin(request: DesktopSignIn = { method: "web" }): Promise<void> {
  // The browser ways wait up to five minutes for the person; the service gives up first.
  await desktopRequest("/desktop/login", { method: "POST", body: JSON.stringify(request), signal: AbortSignal.timeout(360_000) });
  accountGeneration++;
  accountRequest = undefined;
  await desktopAccount();
}

/** The sign-in the workspace service is waiting on, with the provider's link once it has one. */
export async function desktopLoginState(): Promise<{ method: DesktopSignInMethod; url?: string } | undefined> {
  const { pending } = await desktopRequest<{ pending: { method: DesktopSignInMethod; url?: string } | null }>("/desktop/login", { signal: AbortSignal.timeout(5_000) });
  return pending ?? undefined;
}

export async function cancelDesktopLogin(): Promise<void> {
  await desktopRequest("/desktop/login", { method: "DELETE" });
}

export async function desktopLogout(): Promise<void> {
  await desktopRequest("/desktop/logout", { method: "POST" });
  accountGeneration++;
  accountRequest = undefined;
  updateAccount({});
}

export function desktopHostSocket(): WebSocket {
  if (!capability) throw new Error("桌面连接已失效，请重新打开窗口");
  const url = new URL("/desktop/host", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", capability);
  return new WebSocket(url);
}

export function postDesktopMessage(message: Record<string, unknown>): boolean {
  if (!isDesktop) return false;
  if (electron) { electron.postMessage(message); return true; }
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { linkshellDesktop?: { postMessage(value: unknown): void } } };
  }).webkit?.messageHandlers?.linkshellDesktop;
  if (!handler) return false;
  handler.postMessage(message);
  return true;
}

function nativeCommand(message: { action: "manage" } | { action: "workspace" } |{ action: "external"; url: string } | { action: "appearance"; value: "system" | "light" | "dark" } | { action: "contentFocus"; focused: boolean } | { action: "screenFullScreen"; enabled: boolean }): boolean {
  if (electron) return postDesktopMessage(message);
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { linkshellDesktop?: { postMessage(value: unknown): void } } };
  }).webkit?.messageHandlers?.linkshellDesktop;
  if (!isDesktop || !handler) return false;
  handler.postMessage(message);
  return true;
}

const DESKTOP_REPLY_EVENT = "linkshell-desktop-reply";
const replies = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
if (typeof window !== "undefined") {
  window.addEventListener(DESKTOP_REPLY_EVENT, (event) => {
    const { id, result, error } = ((event as CustomEvent).detail ?? {}) as { id?: string; result?: unknown; error?: string };
    const waiting = id ? replies.get(id) : undefined;
    if (!waiting || !id) return;
    replies.delete(id);
    clearTimeout(waiting.timer);
    if (error) waiting.reject(new Error(error)); else waiting.resolve(result);
  });
}

/** This Mac's service, through the Electron window (`linkshell desktop` underneath). */
export function desktopInvoke<T>(method: string, params: Record<string, unknown> = {}, timeout = 130_000): Promise<T> {
  if (!electron) return Promise.reject(new Error("本机管理需要 LinkShell 桌面版"));
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    // The longest action (sign-in) has its own, longer limit on the native side.
    const timer = setTimeout(() => { replies.delete(id); reject(new Error("操作超时，请重试")); }, method === "login" ? 400_000 : timeout);
    replies.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    electron.postMessage({ action: "invoke", id, method, params });
  });
}

/** One item of a native context menu: a choice (`id`), a submenu, or a separator. */
export interface DesktopMenuItem {
  id?: string;
  label?: string;
  type?: "separator";
  enabled?: boolean;
  checked?: boolean;
  /** Shown beside the item, in Electron's accelerator form ("CommandOrControl+Shift+A"). */
  accelerator?: string;
  submenu?: DesktopMenuItem[];
}

/** A native context menu at the pointer (the Electron window only): the chosen item's id, if any. */
export async function desktopContextMenu(items: DesktopMenuItem[], at?: { x: number; y: number }): Promise<string | undefined> {
  if (!isElectronDesktop) return undefined;
  // A menu can stay open as long as the person likes; its answer still finds its way back.
  const { id } = await desktopInvoke<{ id?: string }>("contextMenu", { items, at }, 3_600_000);
  return id;
}

/** Shows a file or folder of this computer in Finder or File Explorer. */
export function revealOnDesktop(path: string): Promise<unknown> {
  return desktopInvoke("reveal", { path }, 15_000);
}

/** Asks the window to go full screen (the terminal, the Mac app's native remote screen); the answer arrives as `DESKTOP_FULLSCREEN_EVENT`. */
export function setDesktopScreenFullScreen(enabled: boolean): boolean {
  return nativeCommand({ action: "screenFullScreen", enabled });
}
export const DESKTOP_FULLSCREEN_EVENT = "linkshell-desktop-fullscreen";

export function openDesktopManagement(): void {
  // In Electron, management is a page of this window: the shell navigates on the same command
  // the menu bar sends (desktop-commands.ts), without a round trip through the main process.
  if (isElectronDesktop) {
    window.dispatchEvent(new CustomEvent("linkshell-desktop-command", { detail: { command: "manage" } }));
    return;
  }
  if (!nativeCommand({ action: "manage" })) reportDesktopError("请通过 LinkShell 菜单打开本机服务");
}

/** Tells the Electron window the workspace is showing again (it tracks which view is up). */
export function reportDesktopWorkspace(): void {
  if (isElectronDesktop) nativeCommand({ action: "workspace" });
}

export function setDesktopAppearance(value: "system" | "light" | "dark"): void {
  nativeCommand({ action: "appearance", value });
}

export function setDesktopContentFocus(focused: boolean): void {
  nativeCommand({ action: "contentFocus", focused });
}

export function openDesktopExternal(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  if (!nativeCommand({ action: "external", url: url.href }))
    window.open(url.href, "_blank", "noopener,noreferrer");
}
