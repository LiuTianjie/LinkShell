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
import {
  DESKTOP_LOCAL,
  DESKTOP_LOGIN_EVENT,
  DESKTOP_UPDATE_EVENT,
  desktopInvoke,
  isElectronDesktop,
  openExternalUrl,
} from "../bridge/desktop-bridge";
import { engine } from "./engine";
import { thisComputerLabel, thisComputerSpacedLabel } from "./i18n";
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
  keepAwake?: boolean | "smart" | "always" | "off";
}

export interface PairingOffer {
  code: string;
  link: string;
  gateway: string;
  expiresAt: number;
  qr?: boolean[][];
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

export function passwordProblem(password: string): string | undefined {
  return password.length < 4 || password.length > 128
    ? "密码需要 4 到 128 位。"
    : undefined;
}

export function serviceLabel(
  snapshot: DesktopSnapshot | undefined,
  problem: string | undefined,
): string {
  if (problem) return "状态未知";
  return (
    ({
      running: "运行中",
      stopped: "已停止",
      unreachable: "无法连接",
    } as Record<string, string>)[snapshot?.status ?? ""] ?? "正在连接"
  );
}

export function gatewayLabel(
  snapshot: DesktopSnapshot | undefined,
  isHealthy: boolean,
): string {
  if (!isHealthy) return "未知";
  return (
    ({
      online: "已连接",
      connecting: "连接中",
      offline: "已断开",
      off: "未启用",
    } as Record<string, string>)[snapshot?.gateway?.status ?? ""] ?? "未知"
  );
}

export function sourceLabel(
  snapshot: DesktopSnapshot | undefined,
  isStandalone: boolean,
): string {
  if (isStandalone) return "独立 App · 内置运行环境";
  return snapshot?.source === "homebrew"
    ? "Homebrew"
    : snapshot?.source === "npm"
      ? "npm / CLI"
      : "未知";
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
  busy: boolean;
  starting: boolean;
  started: boolean;
  about?: DesktopAbout;
  settings: DesktopSettings;
  permissions: {
    known: boolean;
    recording: boolean;
    control: boolean;
    sharing?: boolean;
  };
  loginItem: { enabled: boolean; approval: boolean };
  loginItemMessage: string;
  activity: { at: number; text: string }[];
  signingIn: boolean;
  signInMethod?: SignInMethod;
  signInLink?: string;
  signInError: string;
  accountMessage: string;
  checkingMembership: boolean;
  gatewayMessage: string;
  passwordMessage: string;
  passwordIsError: boolean;
  savingPassword: boolean;
  commandMessage: string;
  log: string;
  logPath?: string;
  pairingOffer?: PairingOffer;
  pairingLoading: boolean;
  pairingError?: string;
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
    message: string;
    checkedAt?: number;
  };
}

const POLL_INTERVAL = 5_000;
const ACCOUNT_INTERVAL = 300_000;

const INITIAL_MANAGEMENT_STATE: ManagementState = {
  busy: false,
  starting: false,
  started: false,
  settings: { opaqueWindow: false, autoCheck: true, updateChannel: "stable" },
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
    message: "尚未检查更新",
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

function begin(partial: Partial<ManagementState> = {}) {
  revision++;
  set({ ...partial, busy: true });
}

export function managementEvent(text: string): void {
  set({ activity: [{ at: Date.now(), text }, ...get().activity].slice(0, 20) });
}

function applySnapshot(next: DesktopSnapshot) {
  const before = get().snapshot;
  if (before?.account?.userId !== next.account?.userId) {
    lastAccountRefresh = 0;
    set({ accountMessage: "" });
  }
  set({ snapshot: next });
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
  void desktopInvoke<ManagementState["update"] | undefined>("updateStatus").then(
    (update) => {
      if (update) set({ update });
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
      managementEvent(
        `桌面启动：后台服务${
          get().snapshot?.status === "running" ? "已就绪" : "需要检查"
        }`,
      );
      notifyDesktopHostChanged();
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
        managementEvent(
          next.status === "running"
            ? "本机服务已连接"
            : `本机服务：${next.status === "stopped" ? "已停止" : "无法连接"}`,
        );
      }
      if (before?.gateway?.status && before.gateway.status !== next.gateway?.status) {
        managementEvent("网关连接状态已变化");
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

export function pollManagement(): () => void {
  void refreshManagement();
  const timer = setInterval(() => void refreshManagement(), POLL_INTERVAL);
  return () => clearInterval(timer);
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
    set({ settings: await desktopInvoke<DesktopSettings>("settings") });
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

async function mutate(
  work: () => Promise<void>,
  partial: Partial<ManagementState> = {},
) {
  if (get().busy) return;
  begin(partial);
  try {
    await work();
  } finally {
    set({ busy: false });
    void refreshManagement();
  }
}

export function serviceAction(
  name: "start" | "stop" | "restart" | "recover-update",
): Promise<void> {
  return mutate(
    async () => {
      try {
        applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
        if (name === "recover-update") recoveryProblem = undefined;
        managementEvent(
          {
            start: "已启动本机服务",
            stop: "已停止本机服务",
            restart: "已重启本机服务",
            "recover-update": "已恢复后台服务",
          }[name],
        );
        notifyDesktopHostChanged();
      } catch (error) {
        const message = messageOf(error);
        if (name === "recover-update") {
          recoveryProblem = `服务恢复需要处理：${message}`;
        }
        set({ problem: name === "recover-update" ? recoveryProblem : message });
      }
    },
    { problem: undefined },
  );
}

function signIn(method: SignInMethod, run: () => Promise<DesktopSnapshot>) {
  loginCancelled = false;
  return mutate(
    async () => {
      try {
        const next = await run();
        if (next.error) throw new Error(next.error);
        applySnapshot(next);
        set({
          accountMessage: `登录成功。手机登录同一账号后，可通过官方网关连接${thisComputerLabel("zh")}（需要 iTool 会员）。`,
        });
        managementEvent("账号已登录");
        notifyDesktopHostChanged();
      } catch (error) {
        set({ signInError: loginCancelled ? "" : messageOf(error) });
      } finally {
        set({ signingIn: false, signInMethod: undefined, signInLink: undefined });
      }
    },
    {
      signingIn: true,
      signInMethod: method,
      signInLink: undefined,
      signInError: "",
      accountMessage: "",
    },
  );
}

export function login(): Promise<void> {
  return signIn("web", () => desktopInvoke<DesktopSnapshot>("login", {}, 400_000));
}

export function loginWithPassword(email: string, password: string): Promise<void> {
  return signIn("password", () =>
    desktopInvoke<DesktopSnapshot>("loginPassword", { email, password }, 90_000),
  );
}

export function loginWithProvider(provider: "github" | "google"): Promise<void> {
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

export function accountAction(name: "logout"): Promise<void> {
  return mutate(
    async () => {
      try {
        applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
        set({ accountMessage: `已退出${thisComputerSpacedLabel("zh")}的账号。` });
        notifyDesktopHostChanged();
      } catch (error) {
        set({ accountMessage: messageOf(error) });
      }
    },
    { accountMessage: "正在处理…" },
  );
}

export function refreshAccount(): void {
  const state = get();
  if (state.snapshot?.account?.state !== "signed-in" || state.busy) return;
  const userId = state.snapshot.account.userId;
  lastAccountRefresh = Date.now();
  void mutate(
    async () => {
      try {
        const next = await desktopInvoke<DesktopSnapshot>("action", {
          name: "account-refresh",
        });
        if (get().snapshot?.account?.userId !== userId) return;
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
    },
    { checkingMembership: true },
  );
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
  if (get().busy) return false;
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
          passwordMessage:
            password === null
              ? "已移除访问密码。"
              : `已设置访问密码。其他设备下次打开${thisComputerSpacedLabel("zh")}时需要输入。`,
        });
        managementEvent(password === null ? "访问密码已移除" : "访问密码已设置");
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
  if (get().busy) return false;
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
            ? "已切换到官方网关"
            : choice.kind === "off"
              ? "已关闭网关"
              : `已切换到自建网关 ${choice.url}`,
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

/** Generates a fresh 6-digit pairing code + QR matrix for pairing a phone to this local Host. */
export async function createLocalPairingOffer(
  invoke: typeof desktopInvoke = desktopInvoke,
): Promise<PairingOffer | undefined> {
  set({ pairingLoading: true, pairingError: undefined });
  try {
    const offer = await invoke<PairingOffer>("action", { name: "pair-qr" }, 35_000);
    set({ pairingOffer: offer, pairingLoading: false, pairingError: undefined });
    return offer;
  } catch (error) {
    const msg = messageOf(error);
    set({ pairingLoading: false, pairingError: msg });
    return undefined;
  }
}

/**
 * Revokes a paired phone device from this local Host via `devices.revoke` over the local Host RPC link,
 * then immediately refreshes the management snapshot (`#8` §8.8 unpairing fix).
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
  let releaseRetained: (() => void) | undefined;
  try {
    let link = options?.localLink;
    if (!link) {
      const engineState = engine.state.getState();
      if (engineState.connection?.computer.key === DESKTOP_LOCAL) {
        link = engineState.connection.link;
      } else if (engineState.localComputer) {
        const retained = engine.retainComputer(engineState.localComputer, {
          metadataOnly: true,
        });
        link = retained.connection.link;
        releaseRetained = retained.release;
      }
    }
    if (!link) {
      throw new Error("本机服务尚未连接，请先确认后台服务运行中");
    }
    await link.call("devices.revoke", { deviceId });
    managementEvent("已移除配对设备");
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
    releaseRetained?.();
    set({ revokingDeviceId: undefined });
  }
}

export async function fetchUsageAnalytics(
  days: 1 | 7 | 30 = 7,
  agent = "all",
  invoke: typeof desktopInvoke = desktopInvoke,
): Promise<UsageReport | undefined> {
  set({ usageLoading: true, usageError: undefined });
  try {
    const report = await invoke<UsageReport>("usage", { days, agent }, 130_000);
    set({ usageReport: report, usageLoading: false, usageError: undefined });
    return report;
  } catch (error) {
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
    set({ commandMessage: `已复制：${path}` });
  } catch (error) {
    set({ commandMessage: messageOf(error) });
  }
}

export async function installCommand(): Promise<void> {
  try {
    const { path } = await desktopInvoke<{ path: string }>("installCommand");
    set({
      commandMessage: `已安装：${path}。请将 ~/.local/bin 加入 PATH。`,
    });
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

export async function setDesktopSetting<K extends keyof DesktopSettings>(
  key: K,
  value: DesktopSettings[K],
): Promise<void> {
  const previous = get().settings;
  set({ settings: { ...previous, [key]: value } });
  if (key === "updateChannel") {
    set({
      update: {
        ...get().update,
        available: false,
        version: undefined,
        message: "通道已切换，检查更新后生效",
      },
    });
  }
  try {
    await desktopInvoke("setSetting", { key, value });
  } catch (error) {
    set({ settings: previous });
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
  set({ update: { ...get().update, checking: true, message: "正在检查…" } });
  try {
    const response = await fetch("https://registry.npmjs.org/linkshell-cli/latest", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { version?: unknown };
    if (!response.ok || typeof body.version !== "string") {
      throw new Error("版本信息无效");
    }
    const latest = body.version;
    const current = installedCliVersion(get());
    const message = !current
      ? `最新稳定版 ${latest}；启动本机服务后可检测当前版本`
      : newerVersion(latest, current)
        ? `有新版本 ${latest}`
        : "当前已是最新稳定版";
    set({
      update: { ...get().update, checking: false, latest, message, checkedAt: Date.now() },
    });
  } catch (error) {
    set({
      update: {
        ...get().update,
        checking: false,
        message: `检查失败：${messageOf(error)}`,
        checkedAt: Date.now(),
      },
    });
  }
}

export function upgradeInstall(): Promise<void> {
  return mutate(async () => {
    set({ update: { ...get().update, message: "正在更新 CLI 和 Host…" } });
    try {
      const result = await desktopInvoke<{ message?: string }>("upgrade", {}, 250_000);
      set({ update: { ...get().update, message: result.message ?? "更新完成。" } });
      managementEvent("CLI 更新完成");
      notifyDesktopHostChanged();
    } catch (error) {
      set({ update: { ...get().update, message: messageOf(error) } });
    }
  });
}

export function installUpdate(): void {
  if (get().update.checking || get().update.installing) return;
  set({ update: { ...get().update, message: "正在打开更新窗口…" } });
  void desktopInvoke("installUpdate").catch((error: unknown) =>
    set({
      update: { ...get().update, message: `更新未完成：${messageOf(error)}` },
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
  management.setState({ ...INITIAL_MANAGEMENT_STATE }, true);
}
