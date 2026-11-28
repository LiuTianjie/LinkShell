import { createIdentity, type Identity, type MachineEntry } from "@linkshell/wire";
import {
  desktopFetch,
  gatewayDeployment,
  getDesktopCapability,
  isElectronDesktop,
  registerDesktopFlush,
} from "../bridge/desktop-bridge";
import {
  accountClient,
  accountToken,
  resetWebAccountClientForTests,
  signInWithAccountOAuth,
  type WebAccountClient,
} from "./web-account";

export const DESKTOP_LOCAL = "desktop:local";
export const DESKTOP_VISIBILITY_EVENT = "linkshell-desktop-visibility";
export const DESKTOP_ACCOUNT_EVENT = "linkshell-desktop-account";
export const DESKTOP_ERROR_EVENT = "linkshell-desktop-error";
export const DESKTOP_HOST_EVENT = "linkshell-desktop-host";

/** Canonical registry of persistent storage keys across LinkShell Desktop. */
export const STORAGE_KEYS = {
  locale: "linkshell.locale.v1",
  appearance: "appearance",
  selected: "selected",
  currentComputer: "currentComputer",
  source: "source",
  gateway: "gateway",
  paired: "paired",
  projectScope: "desktopProjectScope",
  sidebarWidth: "desktopSidebarWidth",
  sidebarHidden: "desktopSidebarHidden",
  inspectorWidth: "desktopInspectorWidth",
  bottomDockHeight: "desktopBottomDockHeight",
  filesListWidth: "desktopFilesListWidth",
  filesListFolded: "desktopFilesListFolded",
  hiddenFilesShown: "desktopFilesShowHidden",
  terminalFontSize: "terminalFontSize",
  computerNames: "computer-names",
  activeSessionsOpen: "desktopActiveSessionsOpen",
  lastRoute: "desktopLastRoute",
  screenPreferences: "screen:linkshell.screen.v2",
  selectedTerminal: (computerKey: string) => `selectedTerminal.${computerKey}`,
  openPortTabs: (computerKey: string) => `openPortTabs.${computerKey}`,
  newSessionPrefs: (machineId: string) => `linkshell.new-session.v1:${machineId}`,
  composerDraft: (computerKey: string, sessionId: string) => `draft.${computerKey}.${sessionId}`,
  sideDraft: (computerKey: string, sessionId: string) => `sideDraft.${computerKey}.${sessionId}`,
  outbox: (computerKey: string) => `outbox.${computerKey}`,
  accessToken: (computerKey: string) => `accessToken.${computerKey}`,
  treeOpen: (computerKey: string) => `desktopTree.${computerKey}`,
  treeFolded: (computerKey: string) => `desktopTreeFolded.${computerKey}`,
} as const;

export interface BootstrappedComputer {
  key: string;
  gateway: string;
  machine: MachineEntry;
  relayId?: string;
}

export interface DesktopBootstrapPayload {
  identity: Identity;
  storage: Record<string, unknown>;
  localComputer?: BootstrappedComputer;
}

export interface DesktopSidecarAccount {
  userId?: string;
  email?: string;
  accessToken?: string;
}

export type DesktopSignInMethod = "web" | "password" | "github" | "google";
export type DesktopSignInRequest =
  | { method: "web" | "github" | "google" }
  | { method: "password"; email: string; password: string };

interface StorageWrite {
  value: unknown;
}

let bootstrapState: DesktopBootstrapPayload | undefined;
let bootstrapPromise: Promise<DesktopBootstrapPayload> | undefined;
let fallbackIdentity: Identity | undefined;
const fallbackMemory = new Map<string, unknown>();
const storageListeners = new Set<() => void>();

let storageWrites = Promise.resolve();
let storageFlushPromise: Promise<{ saved: boolean; pending: number }> | undefined;
const unsaved = new Map<string, StorageWrite>();

let cachedAccount: DesktopSidecarAccount = {};
let accountRequest: Promise<DesktopSidecarAccount> | undefined;
let accountGeneration = 0;
let browserIdentityPromise: Promise<Identity> | undefined;
let subscribedWebClient: WebAccountClient | undefined;
let pendingBrowserLogin:
  | {
      method: DesktopSignInMethod;
      url?: string;
      controller: AbortController;
    }
  | undefined;

function hasSidecarCapability(): boolean {
  return Boolean(getDesktopCapability());
}

function loadBrowserDeviceIdentity(): Promise<Identity> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.open !== "function") {
    fallbackIdentity ??= createIdentity();
    return Promise.resolve(fallbackIdentity);
  }
  return (browserIdentityPromise ??= new Promise<Identity>((resolve, reject) => {
    const request = indexedDB.open("linkshell.web.identity", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("keys")) {
        request.result.createObjectStore("keys");
      }
    };
    request.onerror = () =>
      reject(new Error("无法保存浏览器设备身份，请允许此网站使用本地存储"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      const getReq = store.get("device");
      let identity: Identity | undefined;
      getReq.onsuccess = () => {
        identity = (getReq.result as Identity | undefined) ?? createIdentity();
        if (!getReq.result) store.put(identity, "device");
      };
      tx.oncomplete = () => {
        db.close();
        fallbackIdentity = identity ?? createIdentity();
        resolve(fallbackIdentity);
      };
      tx.onerror = () => {
        db.close();
        reject(new Error("设备身份保存失败"));
      };
    };
  }));
}

function ensureWebAccountSubscription(): void {
  if (hasSidecarCapability() || gatewayDeployment() === "self-hosted") return;
  const currentClient = accountClient();
  if (subscribedWebClient === currentClient) return;
  subscribedWebClient = currentClient;
  currentClient.auth.onAuthStateChange((_event, session) => {
    accountGeneration++;
    accountRequest = undefined;
    updateCachedAccount(
      session
        ? {
            userId: session.user.id,
            email: session.user.email,
            accessToken: session.access_token,
          }
        : {},
    );
  });
}

function notifyStorageListeners(): void {
  for (const listener of storageListeners) listener();
}

export function subscribeStorageReady(listener: () => void): () => void {
  storageListeners.add(listener);
  return () => {
    storageListeners.delete(listener);
  };
}

export function reportDesktopError(error: unknown): void {
  if (typeof window === "undefined") return;
  const detail = error instanceof Error ? error.message : String(error);
  window.dispatchEvent(new CustomEvent(DESKTOP_ERROR_EVENT, { detail }));
}

export function notifyDesktopHostChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DESKTOP_HOST_EVENT));
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// Keys with a write already waiting in the chain: later saves only replace the value in `unsaved`,
// so typing in the composer costs one request per round trip instead of one per keystroke.
const queuedKeys = new Set<string>();
// One failure report per outage, not one per save while the sidecar is away.
let reportedStorageFailure = false;

function queueStorageWrite(key: string): void {
  if (queuedKeys.has(key)) return;
  queuedKeys.add(key);
  storageWrites = storageWrites.then(async () => {
    queuedKeys.delete(key);
    const latest = unsaved.get(key);
    if (!latest) return;
    try {
      await desktopFetch("/desktop/storage", {
        method: "PUT",
        body: JSON.stringify({ key, value: latest.value }),
      });
      if (unsaved.get(key) === latest) unsaved.delete(key);
      reportedStorageFailure = false;
    } catch (error) {
      if (reportedStorageFailure) return;
      reportedStorageFailure = true;
      const detail = error instanceof Error ? error.message : String(error);
      reportDesktopError(new Error(`工作台设置尚未保存：${detail}。请重试连接。`));
    }
  });
}

/**
 * Bootstraps device identity, persisted key-value storage, and initial local Host discovery
 * from the Electron WorkspaceServer (`/desktop/bootstrap`), registering the 10s shutdown barrier.
 */
export async function bootstrapDesktopStorage(): Promise<DesktopBootstrapPayload> {
  if (bootstrapState) return bootstrapState;
  if (bootstrapPromise) return bootstrapPromise;

  if (!hasSidecarCapability()) {
    bootstrapPromise = (async () => {
      const identity = await loadBrowserDeviceIdentity();
      const localPayload: DesktopBootstrapPayload = {
        identity,
        storage: Object.fromEntries(fallbackMemory.entries()),
      };
      bootstrapState = localPayload;
      ensureWebAccountSubscription();
      notifyStorageListeners();
      return localPayload;
    })().finally(() => {
      bootstrapPromise = undefined;
    });
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    const payload = await desktopFetch<DesktopBootstrapPayload>("/desktop/bootstrap");
    bootstrapState = {
      identity: payload.identity,
      storage: { ...(payload.storage ?? {}) },
      localComputer: payload.localComputer,
    };
    if (typeof document !== "undefined") {
      document.documentElement.dataset.desktop = "true";
    }
    if (typeof window !== "undefined") {
      (window as Window & { __LINKSHELL_DESKTOP_FLUSH__?: typeof flushDesktopStorage }).__LINKSHELL_DESKTOP_FLUSH__ =
        flushDesktopStorage;
    }
    registerDesktopFlush(flushDesktopStorage);
    notifyStorageListeners();
    return bootstrapState;
  })().finally(() => {
    bootstrapPromise = undefined;
  });

  return bootstrapPromise;
}

export function isStorageBootstrapped(): boolean {
  return Boolean(bootstrapState);
}

export function desktopIdentity(): Identity {
  if (bootstrapState?.identity) return bootstrapState.identity;
  fallbackIdentity ??= createIdentity();
  return fallbackIdentity;
}

export async function loadDeviceIdentity(): Promise<Identity> {
  const payload = await bootstrapDesktopStorage();
  return payload.identity;
}

export function bootstrappedLocalComputer(): BootstrappedComputer | undefined {
  return bootstrapState?.localComputer;
}

function legacyWebStorageKeys(key: string): string[] {
  const keys = [`linkshell.web.${key}`];
  if (key === STORAGE_KEYS.locale) keys.push(key);
  if (key === STORAGE_KEYS.appearance) keys.push("linkshell.web.theme");
  return keys;
}

export function readLocal<T>(key: string, fallback: T): T {
  if (bootstrapState && key in bootstrapState.storage) {
    const stored = bootstrapState.storage[key];
    return (stored as T | null | undefined) ?? fallback;
  }
  if (fallbackMemory.has(key)) {
    const stored = fallbackMemory.get(key);
    return (stored as T | null | undefined) ?? fallback;
  }
  if (!isElectronDesktop && typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(`linkshell.desktop.${key}`);
      if (raw !== null) return (JSON.parse(raw) as T | null) ?? fallback;
      // Preserve pairings, selected computers, gateway URLs, and preferences from `apps/web`.
      for (const legacyKey of legacyWebStorageKeys(key)) {
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw !== null) {
          return (JSON.parse(legacyRaw) as T | null) ?? fallback;
        }
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function saveLocal(key: string, value: unknown): void {
  const snapshot = value === undefined ? null : cloneJsonValue(value);

  if (bootstrapState && hasSidecarCapability()) {
    bootstrapState.storage[key] = snapshot;
    const write: StorageWrite = { value: snapshot };
    unsaved.set(key, write);
    queueStorageWrite(key);
    return;
  }

  if (bootstrapState) {
    if (value === undefined) delete bootstrapState.storage[key];
    else bootstrapState.storage[key] = snapshot;
  }
  if (value === undefined) fallbackMemory.delete(key);
  else fallbackMemory.set(key, snapshot);

  if (!isElectronDesktop && typeof localStorage !== "undefined") {
    try {
      if (value === undefined) {
        localStorage.removeItem(`linkshell.desktop.${key}`);
        for (const legacyKey of legacyWebStorageKeys(key)) {
          localStorage.removeItem(legacyKey);
        }
      } else {
        localStorage.setItem(`linkshell.desktop.${key}`, JSON.stringify(snapshot));
      }
    } catch {
      // Never block UI state mutations when browser quota is full.
    }
  }
}

export function retryDesktopStorage(): Promise<void> {
  if (!hasSidecarCapability()) return Promise.resolve();
  for (const key of unsaved.keys()) queueStorageWrite(key);
  return storageWrites;
}

async function drainDesktopStorage(): Promise<void> {
  let current: Promise<void>;
  do {
    current = storageWrites;
    await current;
  } while (current !== storageWrites);
}

/** Awaited by Electron `main.ts` on `before-quit` and `retry()` before shutting down the sidecar. */
export function flushDesktopStorage(): Promise<{ saved: boolean; pending: number }> {
  return (storageFlushPromise ??= (async () => {
    await drainDesktopStorage();
    if (unsaved.size > 0) await retryDesktopStorage();
    await drainDesktopStorage();
    return { saved: unsaved.size === 0, pending: unsaved.size };
  })().finally(() => {
    storageFlushPromise = undefined;
  }));
}

export function pendingStorageWriteCount(): number {
  return unsaved.size;
}

function updateCachedAccount(next: DesktopSidecarAccount): DesktopSidecarAccount {
  const changed =
    next.userId !== cachedAccount.userId ||
    next.email !== cachedAccount.email ||
    Boolean(next.accessToken) !== Boolean(cachedAccount.accessToken);
  cachedAccount = next;
  if (changed && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_EVENT, { detail: next }));
  }
  return next;
}

/** Applies a sidecar-pushed account update atomically, invalidating any older in-flight fetch. */
export function applySidecarAccountPush(next: DesktopSidecarAccount): DesktopSidecarAccount {
  accountGeneration++;
  accountRequest = undefined;
  return updateCachedAccount(next);
}

export function fetchDesktopAccount(): Promise<DesktopSidecarAccount> {
  if (!hasSidecarCapability()) {
    if (gatewayDeployment() === "self-hosted") {
      return Promise.resolve(updateCachedAccount({}));
    }
    ensureWebAccountSubscription();
    if (accountRequest) return accountRequest;
    const generation = accountGeneration;
    const request = (async (): Promise<DesktopSidecarAccount> => {
      const auth = accountClient().auth;
      const { data, error } = await auth.getSession();
      if (error) throw error;
      if (!data.session?.user?.id) {
        return generation === accountGeneration
          ? updateCachedAccount({})
          : cachedAccount;
      }
      const token = await accountToken(data.session.user.id);
      const latest = await auth.getSession();
      const session = latest.data.session ?? data.session;
      const next: DesktopSidecarAccount = session?.user?.id
        ? {
            userId: session.user.id,
            email: session.user.email,
            accessToken: token ?? session.access_token,
          }
        : {};
      return generation === accountGeneration
        ? updateCachedAccount(next)
        : cachedAccount;
    })().finally(() => {
      if (accountRequest === request) accountRequest = undefined;
    });
    accountRequest = request;
    return request;
  }
  if (accountRequest) return accountRequest;
  const generation = accountGeneration;
  const request = desktopFetch<DesktopSidecarAccount>("/desktop/account")
    .then((next) => (generation === accountGeneration ? updateCachedAccount(next) : cachedAccount))
    .finally(() => {
      if (accountRequest === request) accountRequest = undefined;
    });
  accountRequest = request;
  return request;
}

export async function startDesktopLogin(request: DesktopSignInRequest = { method: "web" }): Promise<void> {
  if (!hasSidecarCapability()) {
    if (gatewayDeployment() === "self-hosted") {
      throw new Error("私有部署使用设备配对");
    }
    ensureWebAccountSubscription();
    if (request.method === "password") {
      const { data, error } = await accountClient().auth.signInWithPassword({
        email: request.email,
        password: request.password,
      });
      if (error) throw error;
      if (!data.session) throw new Error("登录未完成，请重试");
      accountGeneration++;
      accountRequest = undefined;
      updateCachedAccount({
        userId: data.session.user.id,
        email: data.session.user.email,
        accessToken: data.session.access_token,
      });
      return;
    }
    if (request.method === "github" || request.method === "google") {
      pendingBrowserLogin?.controller.abort();
      const controller = new AbortController();
      const entry: NonNullable<typeof pendingBrowserLogin> = {
        method: request.method,
        controller,
      };
      pendingBrowserLogin = entry;
      try {
        // Must invoke signInWithAccountOAuth synchronously before the first await so window.open isn't blocked.
        await signInWithAccountOAuth(accountClient().auth, request.method, {
          signal: controller.signal,
          onAuthorizeUrl: (url) => {
            if (pendingBrowserLogin === entry) entry.url = url;
          },
        });
        accountGeneration++;
        accountRequest = undefined;
        await fetchDesktopAccount();
      } finally {
        if (pendingBrowserLogin === entry) pendingBrowserLogin = undefined;
      }
      return;
    }
    throw new Error("请使用 GitHub、Google 或邮箱密码直接完成登录");
  }
  await desktopFetch("/desktop/login", {
    method: "POST",
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(360_000),
  });
  accountGeneration++;
  accountRequest = undefined;
  await fetchDesktopAccount();
}

export async function pollDesktopLoginState(): Promise<{ method: DesktopSignInMethod; url?: string } | undefined> {
  if (!hasSidecarCapability()) {
    return pendingBrowserLogin
      ? { method: pendingBrowserLogin.method, url: pendingBrowserLogin.url }
      : undefined;
  }
  const { pending } = await desktopFetch<{ pending: { method: DesktopSignInMethod; url?: string } | null }>(
    "/desktop/login",
    { signal: AbortSignal.timeout(5_000) },
  );
  return pending ?? undefined;
}

export async function cancelDesktopLoginRequest(): Promise<void> {
  if (!hasSidecarCapability()) {
    pendingBrowserLogin?.controller.abort();
    pendingBrowserLogin = undefined;
    return;
  }
  await desktopFetch("/desktop/login", { method: "DELETE" });
}

export async function logoutDesktopAccount(): Promise<void> {
  if (!hasSidecarCapability()) {
    await accountClient().auth.signOut({ scope: "local" });
    accountGeneration++;
    accountRequest = undefined;
    updateCachedAccount({});
    return;
  }
  await desktopFetch("/desktop/logout", { method: "POST" });
  accountGeneration++;
  accountRequest = undefined;
  updateCachedAccount({});
}

export async function fetchDesktopLocalComputer(
  signal?: AbortSignal,
): Promise<BootstrappedComputer | undefined> {
  if (!hasSidecarCapability()) return undefined;
  const { computer } = await desktopFetch<{ computer?: BootstrappedComputer }>("/desktop/local", { signal });
  return computer;
}

/** Test-only helper to reset in-memory bootstrap and storage state between cases. */
export function resetDesktopStorageForTests(initialStorage: Record<string, unknown> = {}): void {
  if (typeof localStorage !== "undefined") {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("linkshell.desktop.") || k?.startsWith("linkshell.web.")) {
        localStorage.removeItem(k);
      }
    }
  }
  pendingBrowserLogin?.controller.abort();
  pendingBrowserLogin = undefined;
  browserIdentityPromise = undefined;
  subscribedWebClient = undefined;
  resetWebAccountClientForTests();
  bootstrapState = {
    identity: fallbackIdentity ?? (fallbackIdentity = createIdentity()),
    storage: cloneJsonValue(initialStorage),
  };
  bootstrapPromise = undefined;
  fallbackMemory.clear();
  for (const [k, v] of Object.entries(initialStorage)) fallbackMemory.set(k, cloneJsonValue(v));
  unsaved.clear();
  queuedKeys.clear();
  reportedStorageFailure = false;
  cachedAccount = {};
  accountRequest = undefined;
  accountGeneration = 0;
  notifyStorageListeners();
}
