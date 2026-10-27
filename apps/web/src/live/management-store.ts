import { createStore } from "zustand/vanilla";
import { desktopInvoke, isElectronDesktop, reportDesktopError } from "./desktop";
import {
  membershipOf,
  newerVersion,
  passwordProblem,
  redemptionProblem,
  type DesktopAbout,
  type DesktopSettings,
  type DesktopSnapshot,
} from "./management-model";

/**
 * This Mac's service as the Electron window sees it: a port of LinkShell.app's DesktopModel.
 * One store for the page, the sidebar entry and the update notices, so state survives leaving
 * the management view. Every call goes through `desktopInvoke` (main.ts `handle`).
 */
export interface ManagementState {
  snapshot?: DesktopSnapshot;
  problem?: string;
  busy: boolean;
  started: boolean;
  about?: DesktopAbout;
  settings: DesktopSettings;
  permissions: { known: boolean; recording: boolean; control: boolean };
  loginItem: { enabled: boolean; approval: boolean };
  loginItemMessage: string;
  activity: { at: number; text: string }[];
  signingIn: boolean;
  accountMessage: string;
  checkingMembership: boolean;
  passwordMessage: string;
  passwordIsError: boolean;
  savingPassword: boolean;
  redemptionMessage: string;
  redemptionIsError: boolean;
  redeeming: boolean;
  commandMessage: string;
  log: string;
  update: { checking: boolean; installing: boolean; available: boolean; version?: string; latest?: string; message: string };
}

export const DESKTOP_UPDATE_EVENT = "linkshell-desktop-update";
const POLL_INTERVAL = 5_000;
const ACCOUNT_INTERVAL = 300_000;

export const management = createStore<ManagementState>(() => ({
  busy: false,
  started: false,
  settings: { opaqueWindow: false, autoCheck: true, updateChannel: "stable" },
  permissions: { known: false, recording: false, control: false },
  loginItem: { enabled: false, approval: false },
  loginItemMessage: "",
  activity: [],
  signingIn: false,
  accountMessage: "",
  checkingMembership: false,
  passwordMessage: "",
  passwordIsError: false,
  savingPassword: false,
  redemptionMessage: "",
  redemptionIsError: false,
  redeeming: false,
  commandMessage: "",
  log: "",
  update: { checking: false, installing: false, available: false, message: "尚未检查更新" },
}));

const set = (partial: Partial<ManagementState>) => management.setState(partial);
const get = () => management.getState();
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Sticky problems: shown until the step that caused them succeeds, like the native model.
let recoveryProblem: string | undefined;
let startupProblem: string | undefined;
let polling = false;
let revision = 0;
let lastAccountRefresh = 0;
let loginCancelled = false;

/** A mutation started: polls that began before it must not overwrite what it returns. */
function begin(partial: Partial<ManagementState> = {}) {
  revision++;
  set({ ...partial, busy: true });
}

export function managementEvent(text: string) {
  set({ activity: [{ at: Date.now(), text }, ...get().activity].slice(0, 20) });
}

function applySnapshot(next: DesktopSnapshot) {
  const before = get().snapshot;
  if (before?.account?.userId !== next.account?.userId) {
    lastAccountRefresh = 0;
    set({ redemptionMessage: "", redemptionIsError: false, accountMessage: "" });
  }
  set({ snapshot: next });
}

export const healthy = (state: ManagementState) => state.snapshot?.status === "running" && !state.problem;
export const standalone = (state: ManagementState) => state.about?.standalone === true;
export const newVersion = (state: ManagementState) => {
  if (standalone(state)) return state.update.available;
  const current = state.snapshot?.cliVersion;
  return !!state.update.latest && !!current && newerVersion(state.update.latest, current);
};

/** Once per window: recover an interrupted update, then start a stopped Host (DesktopModel.start). */
export function startManagement(): void {
  if (!isElectronDesktop || get().started) return;
  set({ started: true });
  window.addEventListener(DESKTOP_UPDATE_EVENT, receiveUpdate);
  void Promise.all([desktopInvoke<DesktopAbout>("about"), loadSettings()]).then(([about]) => {
    set({ about });
    // Sparkle's checks run in main.ts; a CLI install compares with npm here, once per window.
    if (!about.standalone && get().settings.autoCheck) void checkUpdates();
  }, () => undefined);
  void refreshLoginItem();
  begin();
  void (async () => {
    try {
      applySnapshot(await desktopInvoke<DesktopSnapshot>("startup", {}, 100_000));
      recoveryProblem = undefined;
      managementEvent(`桌面启动：后台服务${get().snapshot?.status === "running" ? "已就绪" : "需要检查"}`);
    } catch (error) {
      const message = messageOf(error);
      if (message.startsWith("服务恢复")) recoveryProblem = message; else startupProblem = message;
      set({ problem: message });
      reportDesktopError(message);
    }
    set({ busy: false });
    refreshManagement();
  })();
}

/** One poll: the snapshot, then the permissions; the page calls it every 5 s while it is shown. */
export function refreshManagement(): void {
  if (!isElectronDesktop || polling || get().busy) return;
  polling = true;
  const started = revision;
  void (async () => {
    try {
      const next = await desktopInvoke<DesktopSnapshot>("snapshot", {}, 30_000);
      if (get().busy || started !== revision) return;
      const before = get().snapshot;
      if (next.status !== before?.status)
        managementEvent(next.status === "running" ? "本机服务已连接" : `本机服务：${next.status === "stopped" ? "已停止" : "无法连接"}`);
      if (before?.gateway?.status && before.gateway.status !== next.gateway?.status) managementEvent("网关连接状态已变化");
      if (next.status === "running" && !next.error) startupProblem = undefined;
      applySnapshot(next);
      set({ problem: next.error ?? recoveryProblem ?? startupProblem });
      void refreshPermissions();
    } catch (error) {
      if (!get().busy && started === revision) set({ snapshot: undefined, problem: messageOf(error) });
    } finally {
      polling = false;
    }
    if (started !== revision) { if (!get().busy) refreshManagement(); return; }
    if (get().snapshot?.account?.state === "signed-in" && Date.now() - lastAccountRefresh > ACCOUNT_INTERVAL) refreshAccount();
  })();
}

/** Polls while a management page is shown; returns the stop function. */
export function pollManagement(): () => void {
  refreshManagement();
  const timer = setInterval(refreshManagement, POLL_INTERVAL);
  return () => clearInterval(timer);
}

async function refreshPermissions() {
  try {
    const value = await desktopInvoke<{ recording: boolean; control: boolean; unavailable?: boolean }>("permissions", {}, 15_000);
    set({ permissions: { known: !value.unavailable, recording: value.recording, control: value.control } });
  } catch { set({ permissions: { known: false, recording: false, control: false } }); }
}

async function loadSettings() {
  try { set({ settings: await desktopInvoke<DesktopSettings>("settings") }); } catch { /* Defaults stay. */ }
}

export async function refreshLoginItem() {
  try { set({ loginItem: await desktopInvoke<{ enabled: boolean; approval: boolean }>("loginItem") }); } catch { /* Unknown: unchanged. */ }
}

async function mutate(work: () => Promise<void>, partial: Partial<ManagementState> = {}) {
  if (get().busy) return;
  begin(partial);
  try { await work(); }
  finally { set({ busy: false }); refreshManagement(); }
}

/** start / stop / restart / recover-update. */
export function serviceAction(name: "start" | "stop" | "restart" | "recover-update") {
  return mutate(async () => {
    try {
      applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
      if (name === "recover-update") recoveryProblem = undefined;
      managementEvent({ start: "已启动本机服务", stop: "已停止本机服务", restart: "已重启本机服务", "recover-update": "已恢复后台服务" }[name]);
    } catch (error) {
      const message = messageOf(error);
      if (name === "recover-update") recoveryProblem = `服务恢复需要处理：${message}`;
      set({ problem: name === "recover-update" ? recoveryProblem : message });
    }
  }, { problem: undefined });
}

export function login() {
  loginCancelled = false;
  return mutate(async () => {
    try {
      applySnapshot(await desktopInvoke<DesktopSnapshot>("login"));
      set({ accountMessage: "登录成功。手机登录同一账号后，可通过官方网关连接这台 Mac（需要 Pro）。" });
      managementEvent("账号已登录");
    } catch (error) {
      set({ accountMessage: loginCancelled ? "已取消登录" : messageOf(error) });
    } finally { set({ signingIn: false }); }
  }, { signingIn: true, accountMessage: "请在浏览器中完成登录，完成后会自动返回账号状态。" });
}

export function cancelLogin() {
  loginCancelled = true;
  void desktopInvoke("cancelLogin").catch(() => undefined);
}

export function accountAction(name: "logout" | "connect-gateway") {
  return mutate(async () => {
    try {
      applySnapshot(await desktopInvoke<DesktopSnapshot>("action", { name }));
      set({ accountMessage: name === "logout" ? "已退出当前电脑的账号。" : "已应用官方网关设置，请查看连接状态。" });
    } catch (error) { set({ accountMessage: messageOf(error) }); }
  }, { accountMessage: "正在处理…" });
}

export function refreshAccount() {
  const state = get();
  if (state.snapshot?.account?.state !== "signed-in" || state.busy) return;
  const userId = state.snapshot.account.userId;
  lastAccountRefresh = Date.now();
  void mutate(async () => {
    try {
      const next = await desktopInvoke<DesktopSnapshot>("action", { name: "account-refresh" });
      if (get().snapshot?.account?.userId !== userId) return;
      applySnapshot(next);
      if (next.account?.userId === userId) set({ accountMessage: next.accountWarning ?? "" });
    } catch (error) {
      if (get().snapshot?.account?.userId === userId) set({ accountMessage: messageOf(error) });
    } finally { set({ checkingMembership: false }); }
  }, { checkingMembership: true });
}

/** Sets, or with `null` removes, this computer's access password. Resolves true when it took. */
export async function setAccessPassword(password: string | null): Promise<boolean> {
  if (get().busy) return false;
  if (password !== null) {
    const problem = passwordProblem(password);
    if (problem) { set({ passwordMessage: problem, passwordIsError: true }); return false; }
  }
  let saved = false;
  await mutate(async () => {
    try {
      const next = password === null
        ? await desktopInvoke<DesktopSnapshot>("action", { name: "remove-password" })
        : await desktopInvoke<DesktopSnapshot>("action", { name: "set-password", input: { password } });
      if (next.error) throw new Error(next.error);
      applySnapshot(next);
      saved = true;
      set({ passwordMessage: password === null ? "已移除访问密码。" : "已设置访问密码。其他设备下次打开这台电脑时需要输入。" });
      managementEvent(password === null ? "访问密码已移除" : "访问密码已设置");
    } catch (error) { set({ passwordMessage: messageOf(error), passwordIsError: true }); }
    finally { set({ savingPassword: false }); }
  }, { savingPassword: true, passwordMessage: "", passwordIsError: false });
  return saved;
}

export function clearPasswordMessage() { set({ passwordMessage: "", passwordIsError: false }); }

/** Resolves true when the code was redeemed for the signed-in account. */
export async function redeemPro(code: string): Promise<boolean> {
  const state = get();
  const userId = state.snapshot?.account?.userId;
  if (state.busy || !userId || membershipOf(state.snapshot?.account).kind !== "free") return false;
  const problem = redemptionProblem(code);
  if (problem) { set({ redemptionMessage: problem, redemptionIsError: true }); return false; }
  let redeemed = false;
  await mutate(async () => {
    try {
      const next = await desktopInvoke<DesktopSnapshot>("action", { name: "redeem-pro", input: { code: code.trim(), userId } });
      if (get().snapshot?.account?.userId !== userId) return;
      applySnapshot(next);
      if (next.account?.userId !== userId) return;
      if (next.redemption?.userId !== userId || membershipOf(next.account).kind !== "pro")
        throw new Error("尚未确认 Pro 有效期，请刷新会员状态后重试。");
      redeemed = true;
      lastAccountRefresh = Date.now();
      set({
        redemptionMessage: next.redemption.idempotent ? "该激活码已为当前账号兑换，Pro 会员状态已更新。" : "兑换成功，Pro 会员已开通。",
        accountMessage: next.accountWarning ?? "",
      });
      managementEvent("Pro 会员状态已更新");
    } catch (error) {
      if (get().snapshot?.account?.userId === userId) set({ redemptionMessage: messageOf(error), redemptionIsError: true });
    } finally { set({ redeeming: false }); }
  }, { redeeming: true, redemptionMessage: "", redemptionIsError: false });
  return redeemed;
}

export async function readLog() {
  try { set({ log: (await desktopInvoke<{ text: string }>("log")).text }); }
  catch (error) { set({ log: messageOf(error) }); }
}

export async function installCommand() {
  try { set({ commandMessage: `已安装：${(await desktopInvoke<{ path: string }>("installCommand")).path}。请将 ~/.local/bin 加入 PATH。` }); }
  catch (error) { set({ commandMessage: messageOf(error) }); }
}

export async function setLaunchAtLogin(enabled: boolean) {
  try { set({ loginItem: await desktopInvoke<{ enabled: boolean; approval: boolean }>("setLoginItem", { enabled }), loginItemMessage: "" }); }
  catch (error) { set({ loginItemMessage: messageOf(error) }); void refreshLoginItem(); }
}

export async function setDesktopSetting<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) {
  const previous = get().settings;
  set({ settings: { ...previous, [key]: value } });
  if (key === "updateChannel") set({ update: { ...get().update, available: false, version: undefined, message: "通道已切换，检查更新后生效" } });
  try { await desktopInvoke("setSetting", { key, value }); }
  catch (error) { set({ settings: previous }); reportDesktopError(error); }
}

export function openSetup() {
  void desktopInvoke("openSetup").catch((error: unknown) => reportDesktopError(error));
}

export function openLoginItems() {
  void desktopInvoke("openLoginItems").catch(() => undefined);
}

/** A standalone app asks Sparkle; a CLI install compares npm's latest with its own version. */
export async function checkUpdates() {
  const state = get();
  if (state.update.checking) return;
  try {
    const result = await desktopInvoke<{ started: boolean }>("checkUpdates");
    if (result.started) return;
  } catch { /* Fall back to npm below. */ }
  set({ update: { ...get().update, checking: true, message: "正在检查…" } });
  try {
    const response = await fetch("https://registry.npmjs.org/linkshell-cli/latest", { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15_000) });
    const body = (await response.json()) as { version?: unknown };
    if (!response.ok || typeof body.version !== "string") throw new Error("版本信息无效");
    const latest = body.version;
    const current = get().snapshot?.cliVersion;
    const message = !current ? `最新稳定版 ${latest}；当前 CLI 版本未知` : newerVersion(latest, current) ? `有新版本 ${latest}` : "当前已是最新稳定版";
    set({ update: { ...get().update, checking: false, latest, message } });
  } catch (error) {
    set({ update: { ...get().update, checking: false, message: `检查失败：${messageOf(error)}` } });
  }
}

/** An npm or Homebrew install: `linkshell upgrade`, run by the window for this computer. */
export function upgradeInstall() {
  return mutate(async () => {
    set({ update: { ...get().update, message: "正在更新 CLI 和 Host…" } });
    try {
      const result = await desktopInvoke<{ message?: string }>("upgrade", {}, 250_000);
      set({ update: { ...get().update, message: result.message ?? "更新完成。" } });
      managementEvent("CLI 更新完成");
    } catch (error) {
      set({ update: { ...get().update, message: messageOf(error) } });
    }
  });
}

export function installUpdate() {
  set({ update: { ...get().update, message: "正在打开更新窗口…" } });
  void desktopInvoke("installUpdate").catch((error: unknown) => set({ update: { ...get().update, message: `更新未完成：${messageOf(error)}` } }));
}

/** Sparkle's progress, forwarded by main.ts. */
function receiveUpdate(event: Event) {
  const detail = (event as CustomEvent<{ name?: unknown; message?: unknown; version?: unknown }>).detail ?? {};
  const update = get().update;
  const message = typeof detail.message === "string" ? detail.message : update.message;
  switch (detail.name) {
    case "checking": set({ update: { ...update, checking: true, message } }); break;
    case "available":
      set({ update: { ...update, available: true, version: typeof detail.version === "string" ? detail.version : update.version, message } });
      break;
    case "current": set({ update: { ...update, available: false, message } }); break;
    case "message": set({ update: { ...update, message } }); break;
    case "installing": set({ update: { ...update, installing: true, message } }); break;
    case "finished": set({ update: { ...update, checking: false, installing: false } }); break;
  }
}
