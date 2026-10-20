import type { Identity } from "@linkshell/wire";
import type { Computer } from "./engine";

export const isDesktop =
  typeof window !== "undefined" && window.__LINKSHELL_CONFIG__?.desktop === true;
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
    (window as Window & { __LINKSHELL_DESKTOP_FLUSH__?: typeof flushDesktopStorage }).__LINKSHELL_DESKTOP_FLUSH__ = flushDesktopStorage;
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

export async function desktopLogin(): Promise<void> {
  await desktopRequest("/desktop/login", { method: "POST", signal: AbortSignal.timeout(360_000) });
  accountGeneration++;
  accountRequest = undefined;
  await desktopAccount();
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

function nativeCommand(message: { action: "manage" } | { action: "external"; url: string } | { action: "appearance"; value: "system" | "light" | "dark" } | { action: "contentFocus"; focused: boolean }): boolean {
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { linkshellDesktop?: { postMessage(value: unknown): void } } };
  }).webkit?.messageHandlers?.linkshellDesktop;
  if (!isDesktop || !handler) return false;
  handler.postMessage(message);
  return true;
}

export function openDesktopManagement(): void {
  if (!nativeCommand({ action: "manage" })) reportDesktopError("请通过 LinkShell 菜单打开本机服务");
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
