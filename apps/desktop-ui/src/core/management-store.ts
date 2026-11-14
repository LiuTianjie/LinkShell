import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  getLocale,
  itoolMembershipUrl,
  itoolYearlyUpgradeUrl,
  type HostLink,
  type Locale,
} from "@linkshell/client-core";
import type { UsageReport } from "@linkshell/wire";
import type { KeepAwakeMode, MachineKeepAwake } from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  DESKTOP_LOGIN_EVENT,
  DESKTOP_UPDATE_EVENT,
  DESKTOP_VISIBILITY_EVENT,
  desktopInvoke,
  getShellVisible,
  isElectronDesktop,
  openExternalUrl,
} from "../bridge/desktop-bridge";
// The system pages' dictionary also words the labels and messages this store produces, so one
// table holds every string of the management surface. Only functions are used from it, so the
// import cycle through `core/index` is never read during module initialisation.
import { translateSystem, type SystemI18nKey } from "../features/system/system-i18n";
import { engine } from "./engine";
import { getDesktopLocale } from "./i18n";
import { notifyDesktopHostChanged, reportDesktopError } from "./storage";

export { DESKTOP_UPDATE_EVENT };
export type { UsageReport };

export const MANAGE_PAGES = [
  "overview",
  "devices",
  "password",
  "usage",
  "log",
  "updates",
  "settings",
] as const;

export type ManagePage = (typeof MANAGE_PAGES)[number];

/**
 * A message the store hands to the UI: plain text came from elsewhere (the CLI, the gateway,
 * the main process, already worded); a key is resolved in the reader's language when shown.
 */
export type ManagementMessage =
  | string
  | { key: SystemI18nKey; params?: Record<string, string | number> };

/** Legacy Chinese page names: the native shell and older commands still name pages this way. */
export const managePageTitles: Record<ManagePage, string> = {
  overview: "总览",
  devices: "设备",
  password: "访问密码",
  usage: "用量统计",
  log: "日志",
  updates: "更新",
  settings: "设置",
};

export interface DesktopDevice {
  id: string;
  name: string;
  online: boolean;
  pairedAt?: number;
}

export interface DesktopAccount {
  state: string;
  email?: string;
  userId?: string;
  plan?: string;
  planExpiresAt?: string;
  tier?: string | null;
  isTrial?: boolean;
  trialEndsAt?: string;
  daysRemaining?: number;
}

export interface DesktopSnapshot {
  schema?: number;
  status: string;
  cliVersion?: string;
  source?: string;
  hostOwner?: string;
  appBundle?: string;
  home?: string;
  access?: { password: boolean };
  account?: DesktopAccount;
  accountWarning?: string;
  machine?: { hostname: string; hostVersion: string };
  gateway?: {
    status: string;
    url?: string;
    devices: DesktopDevice[];
    error?: { message: string };
  };
  sessions?: { id: string; state: string; pendingPermissions?: number }[];
  error?: string;
}

export interface DesktopAbout {
  version: string;
  electron?: string;
  standalone: boolean;
  bundle?: string;
  home: string;
}

export interface DesktopSettings {
  opaqueWindow: boolean;
  autoCheck: boolean;
  updateChannel: "stable" | "beta";
  /** The Host's keep-awake mode (`machine.keepAwake`); undefined until the Host has answered. */
  keepAwake?: boolean | KeepAwakeMode;
  /** Whether a session that waits or finishes posts a system notification. */
  notifications: boolean;
}

export interface PairingOffer {
  code: string;
  link: string;
  gateway: string;
  expiresAt: number;
  qr?: boolean[][];
  /** Devices paired when this offer was made: a device beyond them, or paired later, used it. */
  baseline?: { ids: string[]; at: number };
}

export type Membership =
  | { kind: "signed-out" }
  | { kind: "unknown" }
  | { kind: "free" }
  | {
      kind: "pro";
      expiresAt: Date;
      tier: "monthly" | "yearly";
      isTrial?: boolean;
      daysRemaining?: number;
    };

export function isManageView(view: string): boolean {
  return view === "manage" || view.startsWith("manage:");
}

export function parseManagePage(value: unknown): ManagePage | undefined {
  if (typeof value !== "string") return undefined;
  if ((MANAGE_PAGES as readonly string[]).includes(value)) return value as ManagePage;
  return MANAGE_PAGES.find((page) => managePageTitles[page] === value);
}

export function managePage(view: string): ManagePage {
  if (view === "manage") return "overview";
  return parseManagePage(view.slice("manage:".length)) ?? "overview";
}

export function manageView(page: ManagePage = "overview"): string {
  return page === "overview" ? "manage" : `manage:${page}`;
}

export function membershipOf(
  account: DesktopAccount | undefined,
  now = Date.now(),
): Membership {
  if (account?.state !== "signed-in") return { kind: "signed-out" };
  if (account.plan === "free") return { kind: "free" };
  const rawExpiry = account.planExpiresAt ?? account.trialEndsAt;
  if (account.plan !== "pro" || !rawExpiry) return { kind: "unknown" };
  const expiresAt = new Date(rawExpiry);
  if (Number.isNaN(expiresAt.getTime())) return { kind: "unknown" };
  if (expiresAt.getTime() <= now) return { kind: "free" };
  const computedDays = Math.max(1, Math.ceil((expiresAt.getTime() - now) / 86_400_000));
  return {
    kind: "pro",
    expiresAt,
    tier: account.tier === "yearly" ? "yearly" : "monthly",
    isTrial: Boolean(account.isTrial),
    daysRemaining:
      typeof account.daysRemaining === "number" ? account.daysRemaining : computedDays,
  };
}

export function passwordProblem(password: string): ManagementMessage | undefined {
  return password.length < 4 || password.length > 128
    ? { key: "password.lengthHint" }
    : undefined;
}

/** A store message in `locale` (the current UI language by default). */
export function managementMessageText(
  message: ManagementMessage | undefined,
  locale: Locale = getDesktopLocale(),
  params: Record<string, string | number> = {},
): string {
  if (!message) return "";
  if (typeof message === "string") return message;
  return translateSystem(locale, message.key, { ...params, ...message.params });
}

export function serviceLabel(
  snapshot: DesktopSnapshot | undefined,
  problem: string | undefined,
  locale: Locale = getDesktopLocale(),
): string {
  if (problem) return translateSystem(locale, "status.unknown");
  const key = ({
    running: "status.running",
    stopped: "status.stopped",
    unreachable: "status.unreachable",
  } as Record<string, SystemI18nKey>)[snapshot?.status ?? ""];
  return translateSystem(locale, key ?? "status.connecting");
}

export function gatewayLabel(
  snapshot: DesktopSnapshot | undefined,
  isHealthy: boolean,
  locale: Locale = getDesktopLocale(),
): string {
  if (!isHealthy) return translateSystem(locale, "status.unknown");
  const key = ({
    online: "gateway.connected",
    connecting: "gateway.connecting",
    offline: "gateway.disconnected",
    off: "gateway.off",
  } as Record<string, SystemI18nKey>)[snapshot?.gateway?.status ?? ""];
  return translateSystem(locale, key ?? "status.unknown");
}

export function sourceLabel(
  snapshot: DesktopSnapshot | undefined,
  isStandalone: boolean,
  locale: Locale = getDesktopLocale(),
): string {
  if (isStandalone) return translateSystem(locale, "updates.sourceStandalone");
  return snapshot?.source === "homebrew"
    ? translateSystem(locale, "updates.sourceHomebrew")
    : snapshot?.source === "npm"
      ? translateSystem(locale, "updates.sourceNpm")
      : translateSystem(locale, "status.unknown");
}

export function newerVersion(latest: string, current: string): boolean {
  const parts = (value: string) =>
    value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

export function wholeNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

export function compactNumber(value: number): string {
  for (const [scale, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (value >= scale) return `${(value / scale).toFixed(1)}${suffix}`;
  }
  return wholeNumber(value);
}

export interface LogEntry {
  at?: number;
  tag?: string;
  text: string;
}

const LOG_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (?:\[([^\]\s]{1,24})\] )?(.*)$/;

export function parseHostLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = text.replace(/\n+$/, "").split("\n");
  if (
    lines.length > 1 &&
    !LOG_LINE.test(lines[0]!) &&
    lines.some((line) => LOG_LINE.test(line))
  ) {
    lines.shift();
  }
  for (const line of lines) {
    const match = LOG_LINE.exec(line);
    const at = match ? Date.parse(match[1]!) : Number.NaN;
    if (match && !Number.isNaN(at)) {
      entries.push({ at, tag: match[2], text: match[3]! });
    } else if (entries.length) {
      entries[entries.length - 1]!.text += `\n${line}`;
    } else {
      entries.push({ text: line });
    }
  }
  return entries;
}

export function splitPath(path: string): [head: string, tail: string] {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const cut = slash > 0 && path.length - slash <= 24 ? slash : Math.max(0, path.length - 16);
  return [path.slice(0, cut), path.slice(cut)];
}

// ── Management Store & IPC Actions ─────────────────────────────────────────────────────

export type SignInMethod = "web" | "password" | "github" | "google";

export interface ManagementState {
  snapshot?: DesktopSnapshot;
  problem?: string;
  /** A user action is running; other mutations wait for it. Background refreshes never set it. */
  busy: boolean;
  /** Why the last click did nothing: another action was still running. Clears itself. */
  busyNotice: ManagementMessage;
  starting: boolean;
  started: boolean;
  about?: DesktopAbout;
  settings: DesktopSettings;
  /** The Host's keep-awake state as it last answered (mode and whether it holds the Mac awake now). */
  keepAwake?: MachineKeepAwake;
  keepAwakeError: ManagementMessage;
  permissions: {
    known: boolean;
    recording: boolean;
    control: boolean;
    sharing?: boolean;
  };
  loginItem: { enabled: boolean; approval: boolean };
  loginItemMessage: ManagementMessage;
  activity: { at: number; text: ManagementMessage }[];
  signingIn: boolean;
  signInMethod?: SignInMethod;
  signInLink?: string;
  signInError: string;
  accountMessage: ManagementMessage;
  checkingMembership: boolean;
  gatewayMessage: string;
  passwordMessage: ManagementMessage;
  passwordIsError: boolean;
  savingPassword: boolean;
  commandMessage: ManagementMessage;
  log: string;
  logPath?: string;
  pairingOffer?: PairingOffer;
  pairingLoading: boolean;
  pairingError?: string;
  /** The phone that used the last offer, shown until another offer is made. */
  pairedDevice?: { id: string; name: string; at: number };
  revokingDeviceId?: string;
  usageReport?: UsageReport;
  usageLoading: boolean;
  usageError?: string;
  update: {
    checking: boolean;
    installing: boolean;
    available: boolean;
    version?: string;
    latest?: string;
    message: ManagementMessage;
    checkedAt?: number;
  };
}

const POLL_INTERVAL = 5_000;
const BACKGROUND_POLL_INTERVAL = 60_000;
const ACCOUNT_INTERVAL = 300_000;
const BUSY_NOTICE_MS = 4_000;

const INITIAL_MANAGEMENT_STATE: ManagementState = {
  busy: false,
  busyNotice: "",
  starting: false,
  started: false,
  settings: { opaqueWindow: false, autoCheck: true, updateChannel: "stable", notifications: true },
  keepAwakeError: "",
  permissions: { known: false, recording: false, control: false },
  loginItem: { enabled: false, approval: false },
  loginItemMessage: "",
  activity: [],
  signingIn: false,
  signInError: "",
  accountMessage: "",
  checkingMembership: false,
  gatewayMessage: "",
  passwordMessage: "",
  passwordIsError: false,
  savingPassword: false,
  commandMessage: "",
  log: "",
  pairingLoading: false,
  usageLoading: false,
  update: {
    checking: false,
    installing: false,
    available: false,
    message: "",
  },
};

export const management = createStore<ManagementState>(() => ({
  ...INITIAL_MANAGEMENT_STATE,
}));
export const managementStore = management;

export function useManagement<T = ManagementState>(
  selector: (state: ManagementState) => T = (s) => s as unknown as T,
): T {
  return useStore(management, selector);
}

const set = (partial: Partial<ManagementState>) => management.setState(partial);
const get = () => management.getState();
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

let recoveryProblem: string | undefined;
let startupProblem: string | undefined;
let polling = false;
let revision = 0;
let lastAccountRefresh = 0;
let loginCancelled = false;
let busyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
let usageRequest = 0;

function begin(partial: Partial<ManagementState> = {}) {
  revision++;
  set({ ...partial, busy: true });
}

/** Tells the person why their click did nothing, instead of dropping it silently. */
function noteBusy() {
  clearTimeout(busyNoticeTimer);
  set({ busyNotice: { key: "notice.busy" } });
  busyNoticeTimer = setTimeout(() => set({ busyNotice: "" }), BUSY_NOTICE_MS);
}

export function managementEvent(text: ManagementMessage): void {
  set({ activity: [{ at: Date.now(), text }, ...get().activity].slice(0, 20) });
}

function applySnapshot(next: DesktopSnapshot) {
  const before = get().snapshot;
  if (before?.account?.userId !== next.account?.userId) {
    lastAccountRefresh = 0;
    set({ accountMessage: "" });
  }
  set({ snapshot: next });
  if (next.status !== "running" && get().keepAwake) {
    // A stopped Host holds nothing: don't keep showing the last answer as if it still applied.
    set({ keepAwake: undefined, settings: { ...get().settings, keepAwake: undefined } });
  }
}

export const healthy = (state: ManagementState) =>
  state.snapshot?.status === "running" && !state.problem;
export const standalone = (state: ManagementState) => state.about?.standalone === true;
export const installedCliVersion = (state: ManagementState) =>
  state.snapshot?.cliVersion ??
  state.snapshot?.machine?.hostVersion ??
  state.about?.version;
export const newVersion = (state: ManagementState) => {
  if (standalone(state)) return state.update.available;
  const current = installedCliVersion(state);
  return Boolean(
    state.update.latest && current && newerVersion(state.update.latest, current),
  );
};

export function startManagement(): void {
  if (!isElectronDesktop || get().started || typeof window === "undefined") return;
  set({ started: true, starting: true });
  window.addEventListener(DESKTOP_UPDATE_EVENT, receiveUpdate);
  window.addEventListener(DESKTOP_LOGIN_EVENT, receiveLoginLink);
  window.addEventListener("focus", returnedFromShop);
  window.addEventListener("focus", returnedToWindow);
  void desktopInvoke<ManagementState["update"] | undefined>("updateStatus").then(
    (update) => {
      if (update) set({ update: { ...get().update, ...update } });
    },
    () => undefined,
  );
  void Promise.all([desktopInvoke<DesktopAbout>("about"), loadSettings()]).then(
    ([about]) => {
      set({ about });
      if (!about.standalone && get().settings.autoCheck) void checkUpdates();
    },
    () => undefined,
  );
  void refreshLoginItem();
  begin();
  void (async () => {
    try {
      applySnapshot(await desktopInvoke<DesktopSnapshot>("startup", {}, 100_000));
      recoveryProblem = undefined;
      managementEvent({
        key:
          get().snapshot?.status === "running"
            ? "activity.startupReady"
            : "activity.startupCheck",
      });
      notifyDesktopHostChanged();
      if (get().snapshot?.status === "running") void refreshKeepAwake();
    } catch (error) {
      const message = messageOf(error);
      if (message.startsWith("服务恢复")) recoveryProblem = message;
      else startupProblem = message;
      set({ problem: message });
      reportDesktopError(message);
    }
    set({ busy: false, starting: false });
    void refreshManagement();
  })();
}

export function refreshManagement(options?: {
  invoke?: typeof desktopInvoke;
  force?: boolean;
}): Promise<void> {
  const invoke = options?.invoke ?? desktopInvoke;
  if ((!isElectronDesktop && !options?.force) || polling || get().busy) {
    return Promise.resolve();
  }
  polling = true;
  const started = revision;
  return (async () => {
    try {
      const next = await invoke<DesktopSnapshot>("snapshot", {}, 30_000);
      if (get().busy || started !== revision) return;
      const before = get().snapshot;
      const statusChanged = next.status !== before?.status;
      if (statusChanged) {
        managementEvent({
          key:
            next.status === "running"
              ? "activity.serviceConnected"
              : next.status === "stopped"
                ? "activity.serviceStopped"
                : "activity.serviceUnreachable",
        });
      }
      if (before?.gateway?.status && before.gateway.status !== next.gateway?.status) {
        managementEvent({ key: "activity.gatewayChanged" });
      }
      if (next.status === "running" && !next.error) startupProblem = undefined;
      applySnapshot(next);
      set({ problem: next.error ?? recoveryProblem ?? startupProblem });
      if (statusChanged) notifyDesktopHostChanged();
      if (!options?.invoke) void refreshPermissions();
    } catch (error) {
      if (!get().busy && started === revision) {
        set({ snapshot: undefined, problem: messageOf(error) });
      }
    } finally {
      polling = false;
    }
    if (started !== revision) {
      if (!get().busy) void refreshManagement(options);
      return;
    }
    if (
      !options?.invoke &&
      get().snapshot?.account?.state === "signed-in" &&
      Date.now() - lastAccountRefresh > ACCOUNT_INTERVAL
    ) {
      refreshAccount();
    }
  })();
}

function shellVisible(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return getShellVisible();
}

/**
 * Polls while the window is on screen and refreshes as soon as it comes back. Every poll runs
 * the CLI, so a hidden window must not keep spawning one.
 */
function pollWhileVisible(interval: number, keepAwake = false): () => void {
  if (typeof window === "undefined") return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible = shellVisible();
  const refresh = () => {
    void refreshManagement().then(() => {
      // The sidebar shows the Host's keep-awake mode; the Settings page reads it on its own.
      if (keepAwake && get().snapshot?.status === "running") void refreshKeepAwake();
    });
  };
  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (visible) refresh();
    }, interval);
  };
  const onVisibility = (event: Event) => {
    const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
    const next = detail ? detail.visible !== false : shellVisible();
    if (next && !visible) {
      refresh();
      startTimer();
    }
    visible = next;
  };
  const onDocumentVisibility = () => onVisibility(new CustomEvent("visibility"));
  window.addEventListener(DESKTOP_VISIBILITY_EVENT, onVisibility);
  document.addEventListener("visibilitychange", onDocumentVisibility);
  if (visible) refresh();
  startTimer();
  return () => {
    clearInterval(timer);
    window.removeEventListener(DESKTOP_VISIBILITY_EVENT, onVisibility);
    document.removeEventListener("visibilitychange", onDocumentVisibility);
  };
}

/** The Settings modal's poll: every 5 s while it is open and the window is on screen. */
export function pollManagement(): () => void {
  return pollWhileVisible(POLL_INTERVAL);
}

/**
 * The app-wide poll for the sidebar's Host status: once a minute, paused while the window is
 * hidden, refreshed when it is shown again.
 */
export function pollManagementInBackground(): () => void {
  return pollWhileVisible(BACKGROUND_POLL_INTERVAL, true);
}

async function refreshPermissions() {
  try {
    const value = await desktopInvoke<{
      recording: boolean;
      control: boolean;
      unavailable?: boolean;
      sharing?: boolean;
    }>("permissions", {}, 15_000);
    set({
      permissions: {
        known: !value.unavailable,
        recording: value.recording,
        control: value.control,
        sharing: value.sharing,
      },
    });
  } catch {
    set({ permissions: { known: false, recording: false, control: false } });
  }
}

async function loadSettings() {
  try {
    const loaded = await desktopInvoke<Partial<DesktopSettings>>("settings");
    // `keepAwake` in the window's own settings is an older window's choice; the Host's answer counts.
    const { keepAwake: _legacy, ...rest } = loaded ?? {};
    set({
      settings: {
        ...get().settings,
        ...rest,
        notifications: rest.notifications !== false,
        keepAwake: get().keepAwake?.mode,
      },
    });
  } catch {
    // Keep defaults.
  }
}

export async function refreshLoginItem(): Promise<void> {
  try {
    set({
      loginItem: await desktopInvoke<{ enabled: boolean; approval: boolean }>(
        "loginItem",
      ),
    });
  } catch {
    // Unchanged.
  }
}

/** Approval happens in System Settings, outside the window: coming back is when it may have changed. */
function returnedToWindow() {
  if (get().loginItem.approval) void refreshLoginItem();
}

/** The local Host's RPC link: the engine's own when it is on this computer, or a metadata-only one. */
async function withLocalHostLink<T>(
  run: (link: Pick<HostLink, "call">) => Promise<T>,
  localLink?: Pick<HostLink, "call">,
): Promise<T> {
  let link = localLink;
  let release: (() => void) | undefined;
  if (!link) {
    const engineState = engine.state.getState();
    if (engineState.connection?.computer.key === DESKTOP_LOCAL) {
      link = engineState.connection.link;
    } else if (engineState.localComputer) {
      const retained = engine.retainComputer(engineState.localComputer, {
        metadataOnly: true,
      });
      link = retained.connection.link;
      release = retained.release;
    }
  }
  if (!link) throw new Error(translateSystem(getDesktopLocale(), "notice.hostNotConnected"));
  try {
    return await run(link);
  } finally {
    release?.();
  }
}

function applyKeepAwake(state: MachineKeepAwake) {
  set({
    keepAwake: state,
    keepAwakeError: "",
    settings: { ...get().settings, keepAwake: state.mode },
  });
}

/** Reads the Host's keep-awake mode; silent when the Host can't be reached. */
export async function refreshKeepAwake(options?: {
  localLink?: Pick<HostLink, "call">;
}): Promise<void> {
  try {
    const state = await withLocalHostLink(
      (link) => link.call("machine.keepAwake", {}) as Promise<MachineKeepAwake>,
      options?.localLink,
    );
    applyKeepAwake(state);
  } catch {
    // Unknown stays unknown: the page shows the control without a mode.
  }
}

/** Keep-awake belongs to the Host: it holds the assertion while sessions run, even with no window open. */
export async function setKeepAwakeMode(
  mode: KeepAwakeMode,
  options?: { localLink?: Pick<HostLink, "call"> },
): Promise<boolean> {
  const previous = get().keepAwake;
  set({
    keepAwakeError: "",
    settings: { ...get().settings, keepAwake: mode },
  });
  try {
    const state = await withLocalHostLink(
      (link) => link.call("machine.keepAwake", { mode }) as Promise<MachineKeepAwake>,
      options?.localLink,
    );
    applyKeepAwake(state);
    return true;
  } catch (error) {
    set({
      keepAwake: previous,
      settings: { ...get().settings, keepAwake: previous?.mode },
      keepAwakeError: messageOf(error),
    });
    return false;
  }
}

async function mutate(
  work: () => Promise<void>,
  partial: Partial<ManagementState> = {},
): Promise<boolean> {
  if (get().busy) {
    noteBusy();
    return false;
  }
  begin(partial);
  try {
    await work();
  } finally {
    set({ busy: false });
    void refreshManagement();
  }
  return true;
}

export function serviceAction(
  name: "start" | "stop" | "restart" | "recover-update",
): Promise<boolean> {
  return mutate(
    async () => {
      try {
        applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
        if (name === "recover-update") recoveryProblem = undefined;
        if (name === "start" || name === "restart") startupProblem = undefined;
        managementEvent({
          key: {
            start: "activity.started",
            stop: "activity.stopped",
            restart: "activity.restarted",
            "recover-update": "activity.recovered",
          }[name] as SystemI18nKey,
        });
        notifyDesktopHostChanged();
      } catch (error) {
        const message = messageOf(error);
        if (name === "recover-update") {
          recoveryProblem = `服务恢复需要处理：${message}`;
        } else if (name === "start" || name === "restart") {
          startupProblem = message;
        }
        set({ problem: name === "recover-update" ? recoveryProblem : message });
      }
    },
    { problem: undefined },
  );
}

/**
 * Sign-in waits on a browser for up to five minutes. It does not take the `busy` lock, so the
 * Host's status keeps refreshing meanwhile; the sign-in buttons are locked by `signingIn`.
 */
async function signIn(
  method: SignInMethod,
  run: () => Promise<DesktopSnapshot>,
): Promise<boolean> {
  if (get().signingIn) {
    noteBusy();
    return false;
  }
  loginCancelled = false;
  set({
    signingIn: true,
    signInMethod: method,
    signInLink: undefined,
    signInError: "",
    accountMessage: "",
  });
  let signedIn = false;
  try {
    const next = await run();
    if (next.error) throw new Error(next.error);
    // A poll that started before the sign-in finished must not put the signed-out snapshot back.
    revision++;
    applySnapshot(next);
    signedIn = next.account?.state === "signed-in";
    set({ accountMessage: { key: "account.signedIn" } });
    managementEvent({ key: "activity.signedIn" });
    notifyDesktopHostChanged();
  } catch (error) {
    set({ signInError: loginCancelled ? "" : messageOf(error) });
  } finally {
    set({ signingIn: false, signInMethod: undefined, signInLink: undefined });
    void refreshManagement();
  }
  return signedIn;
}

/** Resolves true only when the account is signed in afterwards. */
export function login(): Promise<boolean> {
  return signIn("web", () => desktopInvoke<DesktopSnapshot>("login", {}, 400_000));
}

export function loginWithPassword(email: string, password: string): Promise<boolean> {
  return signIn("password", () =>
    desktopInvoke<DesktopSnapshot>("loginPassword", { email, password }, 90_000),
  );
}

export function loginWithProvider(provider: "github" | "google"): Promise<boolean> {
  return signIn(provider, () =>
    desktopInvoke<DesktopSnapshot>("loginOAuth", { provider }, 400_000),
  );
}

export function cancelLogin(): void {
  loginCancelled = true;
  void desktopInvoke("cancelLogin").catch(() => undefined);
}

export function clearSignInError(): void {
  if (get().signInError) set({ signInError: "" });
}

function receiveLoginLink(event: Event) {
  const detail =
    (event as CustomEvent<{ provider?: unknown; url?: unknown }>).detail ?? {};
  const state = get();
  if (
    state.signingIn &&
    detail.provider === state.signInMethod &&
    typeof detail.url === "string"
  ) {
    set({ signInLink: detail.url });
  }
}

export function accountAction(name: "logout"): Promise<boolean> {
  return mutate(
    async () => {
      try {
        applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
        set({ accountMessage: { key: "account.signedOut" } });
        notifyDesktopHostChanged();
      } catch (error) {
        set({ accountMessage: messageOf(error) });
      }
    },
    { accountMessage: { key: "account.working" } },
  );
}

/**
 * The membership check runs in the background every few minutes. It has its own flag and never
 * takes the `busy` lock, so it can't grey out the page or swallow a click while it waits on iTool.
 */
export function refreshAccount(): void {
  const state = get();
  if (state.snapshot?.account?.state !== "signed-in" || state.checkingMembership) return;
  const userId = state.snapshot.account.userId;
  lastAccountRefresh = Date.now();
  set({ checkingMembership: true });
  void (async () => {
    try {
      const next = await desktopInvoke<DesktopSnapshot>("action", {
        name: "account-refresh",
      });
      // A user action that ran meanwhile has the newer snapshot.
      if (get().busy || get().snapshot?.account?.userId !== userId) return;
      applySnapshot(next);
      if (next.account?.userId === userId) {
        set({ accountMessage: next.accountWarning ?? "" });
      }
    } catch (error) {
      if (get().snapshot?.account?.userId === userId) {
        set({ accountMessage: messageOf(error) });
      }
    } finally {
      set({ checkingMembership: false });
    }
  })();
}

let visitedShop = false;

export function openMembershipPage(locale?: Locale): void {
  visitedShop = true;
  openExternalUrl(itoolMembershipUrl(locale ?? getLocale()));
}

export function openYearlyUpgradePage(locale?: Locale): void {
  visitedShop = true;
  openExternalUrl(itoolYearlyUpgradeUrl(locale ?? getLocale()));
}

function returnedFromShop() {
  if (!visitedShop) return;
  visitedShop = false;
  refreshAccount();
}

export async function setAccessPassword(password: string | null): Promise<boolean> {
  if (password !== null) {
    const problem = passwordProblem(password);
    if (problem) {
      set({ passwordMessage: problem, passwordIsError: true });
      return false;
    }
  }
  let saved = false;
  await mutate(
    async () => {
      try {
        const next =
          password === null
            ? await desktopInvoke<DesktopSnapshot>("action", {
                name: "remove-password",
              })
            : await desktopInvoke<DesktopSnapshot>("action", {
                name: "set-password",
                input: { password },
              });
        if (next.error) throw new Error(next.error);
        applySnapshot(next);
        saved = true;
        set({
          passwordMessage: {
            key: password === null ? "password.removedMessage" : "password.setMessage",
          },
        });
        managementEvent({
          key: password === null ? "activity.passwordRemoved" : "activity.passwordSet",
        });
      } catch (error) {
        set({ passwordMessage: messageOf(error), passwordIsError: true });
      } finally {
        set({ savingPassword: false });
      }
    },
    { savingPassword: true, passwordMessage: "", passwordIsError: false },
  );
  return saved;
}

export type GatewayChoice =
  | { kind: "official" }
  | { kind: "own"; url: string }
  | { kind: "off" };

export async function setGateway(choice: GatewayChoice): Promise<boolean> {
  let saved = false;
  await mutate(
    async () => {
      try {
        const next =
          choice.kind === "official"
            ? await desktopInvoke<DesktopSnapshot>("action", {
                name: "connect-gateway",
              })
            : await desktopInvoke<DesktopSnapshot>("action", {
                name: "set-gateway",
                input: { gateway: choice.kind === "off" ? "off" : choice.url },
              });
        if (next.error) throw new Error(next.error);
        applySnapshot(next);
        saved = true;
        managementEvent(
          choice.kind === "official"
            ? { key: "activity.gatewayOfficial" }
            : choice.kind === "off"
              ? { key: "activity.gatewayOff" }
              : { key: "activity.gatewayOwn", params: { url: choice.url } },
        );
        notifyDesktopHostChanged();
      } catch (error) {
        set({ gatewayMessage: messageOf(error) });
      }
    },
    { gatewayMessage: "" },
  );
  return saved;
}

export function clearGatewayMessage(): void {
  set({ gatewayMessage: "" });
}

export function clearPasswordMessage(): void {
  set({ passwordMessage: "", passwordIsError: false });
}

/**
 * Generates a fresh 6-digit pairing code + QR matrix for pairing a phone to this local Host.
 * The devices paired at that moment are kept with the offer, so a phone that uses it is noticed
 * however often the page showing it is closed and reopened.
 */
export async function createLocalPairingOffer(
  invoke: typeof desktopInvoke = desktopInvoke,
): Promise<PairingOffer | undefined> {
  set({ pairingLoading: true, pairingError: undefined, pairedDevice: undefined });
  const baseline = {
    ids: (get().snapshot?.gateway?.devices ?? []).map((device) => device.id),
    at: Date.now(),
  };
  try {
    const offer = await invoke<PairingOffer>("action", { name: "pair-qr" }, 35_000);
    set({
      pairingOffer: { ...offer, baseline },
      pairingLoading: false,
      pairingError: undefined,
    });
    return offer;
  } catch (error) {
    const msg = messageOf(error);
    set({ pairingLoading: false, pairingError: msg });
    return undefined;
  }
}

/**
 * The device that used `offer`, if the device list shows one: a new id, or a known phone that
 * paired again (the Host renews `pairedAt`) after the offer was made. The Host forgets a code once
 * it is used, so the offer is spent from then on.
 */
export function deviceThatUsedOffer(
  offer: PairingOffer | undefined,
  devices: DesktopDevice[],
): DesktopDevice | undefined {
  if (!offer?.baseline) return undefined;
  const known = new Set(offer.baseline.ids);
  return devices.find(
    (device) =>
      !known.has(device.id) ||
      (typeof device.pairedAt === "number" && device.pairedAt >= offer.baseline!.at),
  );
}

function notePairing(devices: DesktopDevice[] | undefined) {
  const offer = get().pairingOffer;
  const device = deviceThatUsedOffer(offer, devices ?? []);
  if (!device) return;
  set({
    pairingOffer: undefined,
    pairedDevice: { id: device.id, name: device.name, at: Date.now() },
  });
  managementEvent({ key: "activity.devicePaired", params: { name: device.name } });
}

management.subscribe((state, previous) => {
  if (state.snapshot?.gateway?.devices !== previous.snapshot?.gateway?.devices || state.pairingOffer !== previous.pairingOffer) {
    if (state.pairingOffer) notePairing(state.snapshot?.gateway?.devices);
  }
});

export function clearPairedDevice(): void {
  if (get().pairedDevice) set({ pairedDevice: undefined });
}

/**
 * Revokes a paired phone device from this local Host via `devices.revoke` over the local Host RPC link,
 * then immediately refreshes the management snapshot.
 */
export async function revokePairedDevice(
  deviceId: string,
  options?: {
    localLink?: Pick<HostLink, "call">;
    invoke?: typeof desktopInvoke;
  },
): Promise<boolean> {
  if (!deviceId.trim()) return false;
  set({ revokingDeviceId: deviceId });
  try {
    await withLocalHostLink(
      (link) => link.call("devices.revoke", { deviceId }),
      options?.localLink,
    );
    managementEvent({ key: "activity.deviceRemoved" });
    // Optimistically remove from current snapshot immediately, then refresh authoritative state.
    const currentSnapshot = get().snapshot;
    if (currentSnapshot?.gateway?.devices) {
      set({
        snapshot: {
          ...currentSnapshot,
          gateway: {
            ...currentSnapshot.gateway,
            devices: currentSnapshot.gateway.devices.filter((d) => d.id !== deviceId),
          },
        },
      });
    }
    await refreshManagement({
      invoke: options?.invoke,
      force: Boolean(options?.invoke),
    });
    return true;
  } catch (error) {
    reportDesktopError(error);
    return false;
  } finally {
    set({ revokingDeviceId: undefined });
  }
}

/**
 * Each range is a separate CLI run of up to two minutes; only the newest request may land, so a
 * slow 30-day report can't replace the 1-day one picked after it.
 */
export async function fetchUsageAnalytics(
  days: 1 | 7 | 30 = 7,
  agent = "all",
  invoke: typeof desktopInvoke = desktopInvoke,
): Promise<UsageReport | undefined> {
  const request = ++usageRequest;
  set({ usageLoading: true, usageError: undefined });
  try {
    const report = await invoke<UsageReport>("usage", { days, agent }, 130_000);
    if (request !== usageRequest) return undefined;
    set({ usageReport: report, usageLoading: false, usageError: undefined });
    return report;
  } catch (error) {
    if (request !== usageRequest) return undefined;
    set({ usageLoading: false, usageError: messageOf(error) });
    return undefined;
  }
}

export async function readLog(): Promise<void> {
  try {
    const reply = await desktopInvoke<{ text: string; path?: string }>("log");
    set({ log: reply.text, logPath: reply.path });
  } catch (error) {
    set({ log: messageOf(error) });
  }
}

export async function revealLog(): Promise<void> {
  try {
    await desktopInvoke("revealLog", {}, 15_000);
  } catch (error) {
    reportDesktopError(error);
  }
}

export async function setScreenSharing(enabled: boolean): Promise<void> {
  try {
    await desktopInvoke("setScreenSharing", { enabled });
  } catch (error) {
    reportDesktopError(error);
  }
  await refreshPermissions();
}

export async function copyCommandPath(): Promise<void> {
  try {
    const { path } = await desktopInvoke<{ path: string }>("copyCommandPath");
    set({ commandMessage: { key: "settings.cliCopied", params: { path } } });
  } catch (error) {
    set({ commandMessage: messageOf(error) });
  }
}

export async function installCommand(): Promise<void> {
  try {
    const { path } = await desktopInvoke<{ path: string }>("installCommand");
    set({ commandMessage: { key: "settings.cliInstalled", params: { path } } });
  } catch (error) {
    set({ commandMessage: messageOf(error) });
  }
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  try {
    set({
      loginItem: await desktopInvoke<{ enabled: boolean; approval: boolean }>(
        "setLoginItem",
        { enabled },
      ),
      loginItemMessage: "",
    });
  } catch (error) {
    set({ loginItemMessage: messageOf(error) });
    void refreshLoginItem();
  }
}

export async function setDesktopSetting<
  K extends Exclude<keyof DesktopSettings, "keepAwake">,
>(key: K, value: DesktopSettings[K]): Promise<void> {
  const previous = get().settings;
  set({ settings: { ...previous, [key]: value } });
  if (key === "updateChannel") {
    set({
      update: {
        ...get().update,
        available: false,
        version: undefined,
        message: { key: "updates.channelChanged" },
      },
    });
  }
  try {
    await desktopInvoke("setSetting", { key, value });
  } catch (error) {
    set({ settings: { ...get().settings, [key]: previous[key] } });
    reportDesktopError(error);
  }
}

export function openSetup(): void {
  void desktopInvoke("openSetup").catch((error: unknown) => reportDesktopError(error));
}

export function openLoginItems(): void {
  void desktopInvoke("openLoginItems").catch(() => undefined);
}

export async function checkUpdates(): Promise<void> {
  const state = get();
  if (state.update.checking || state.update.installing) return;
  try {
    const result = await desktopInvoke<{ started: boolean }>("checkUpdates");
    if (result.started) return;
  } catch {
    // Fall back to npm registry check.
  }
  set({ update: { ...get().update, checking: true, message: { key: "updates.checkingMessage" } } });
  try {
    const response = await fetch("https://registry.npmjs.org/linkshell-cli/latest", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { version?: unknown };
    if (!response.ok || typeof body.version !== "string") {
      throw new Error(translateSystem(getDesktopLocale(), "updates.invalidVersion"));
    }
    const latest = body.version;
    const current = installedCliVersion(get());
    const message: ManagementMessage = !current
      ? { key: "updates.latestUnknownCurrent", params: { latest } }
      : newerVersion(latest, current)
        ? { key: "updates.newVersion", params: { latest } }
        : { key: "updates.upToDate" };
    set({
      update: { ...get().update, checking: false, latest, message, checkedAt: Date.now() },
    });
  } catch (error) {
    set({
      update: {
        ...get().update,
        checking: false,
        message: { key: "updates.checkFailed", params: { message: messageOf(error) } },
        checkedAt: Date.now(),
      },
    });
  }
}

export function upgradeInstall(): Promise<boolean> {
  return mutate(async () => {
    set({ update: { ...get().update, message: { key: "updates.upgrading" } } });
    try {
      const result = await desktopInvoke<{ message?: string }>("upgrade", {}, 250_000);
      set({
        update: {
          ...get().update,
          message: result.message ?? { key: "updates.upgraded" },
        },
      });
      managementEvent({ key: "activity.cliUpgraded" });
      notifyDesktopHostChanged();
    } catch (error) {
      set({ update: { ...get().update, message: messageOf(error) } });
    }
  });
}

export function installUpdate(): void {
  if (get().update.checking || get().update.installing) return;
  set({ update: { ...get().update, message: { key: "updates.opening" } } });
  void desktopInvoke("installUpdate").catch((error: unknown) =>
    set({
      update: {
        ...get().update,
        message: { key: "updates.installFailed", params: { message: messageOf(error) } },
      },
    }),
  );
}

function receiveUpdate(event: Event) {
  const detail =
    (event as CustomEvent<{ name?: unknown; message?: unknown; version?: unknown }>)
      .detail ?? {};
  const update = get().update;
  const message = typeof detail.message === "string" ? detail.message : update.message;
  switch (detail.name) {
    case "checking":
      set({ update: { ...update, checking: true, message } });
      break;
    case "available":
      set({
        update: {
          ...update,
          available: true,
          version:
            typeof detail.version === "string" ? detail.version : update.version,
          message,
          checkedAt: Date.now(),
        },
      });
      break;
    case "current":
      set({ update: { ...update, available: false, message, checkedAt: Date.now() } });
      break;
    case "message":
      set({ update: { ...update, message } });
      break;
    case "installing":
      set({ update: { ...update, installing: true, message } });
      break;
    case "finished":
      set({ update: { ...update, checking: false, installing: false } });
      break;
  }
}

export function resetManagementStoreForTests(): void {
  recoveryProblem = undefined;
  startupProblem = undefined;
  polling = false;
  revision = 0;
  lastAccountRefresh = 0;
  loginCancelled = false;
  usageRequest = 0;
  clearTimeout(busyNoticeTimer);
  management.setState({ ...INITIAL_MANAGEMENT_STATE }, true);
}
