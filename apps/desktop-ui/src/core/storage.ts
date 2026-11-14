import { createIdentity, type Identity, type MachineEntry } from "@linkshell/wire";
import {
  desktopFetch,
  getDesktopCapability,
  isElectronDesktop,
  registerDesktopFlush,
} from "../bridge/desktop-bridge";

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

function hasSidecarCapability(): boolean {
  return Boolean(getDesktopCapability());
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
    fallbackIdentity ??= createIdentity();
    const localPayload: DesktopBootstrapPayload = {
      identity: fallbackIdentity,
      storage: Object.fromEntries(fallbackMemory.entries()),
    };
    bootstrapState = localPayload;
    notifyStorageListeners();
    return localPayload;
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
    bootstrapState.storage[key] = snapshot;
  }
  if (value === undefined) fallbackMemory.delete(key);
  else fallbackMemory.set(key, snapshot);

  if (!isElectronDesktop && typeof localStorage !== "undefined") {
    try {
      if (value === undefined) localStorage.removeItem(`linkshell.desktop.${key}`);
      else localStorage.setItem(`linkshell.desktop.${key}`, JSON.stringify(snapshot));
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

export function fetchDesktopAccount(): Promise<DesktopSidecarAccount> {
  if (!hasSidecarCapability()) return Promise.resolve(cachedAccount);
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
  const { pending } = await desktopFetch<{ pending: { method: DesktopSignInMethod; url?: string } | null }>(
    "/desktop/login",
    { signal: AbortSignal.timeout(5_000) },
  );
  return pending ?? undefined;
}

export async function cancelDesktopLoginRequest(): Promise<void> {
  await desktopFetch("/desktop/login", { method: "DELETE" });
}

export async function logoutDesktopAccount(): Promise<void> {
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
