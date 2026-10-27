import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, type MenuItemConstructorOptions, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Management } from "./management.js";
import { native, type NativeModule } from "./native.js";
import { WorkspacePolicy } from "./policy.js";
import { launchOptions, Runtime } from "./runtime.js";
import { WorkspaceServer } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const launch = launchOptions(process.argv);
const runtime = new Runtime(app.getAppPath(), launch);
const management = new Management(runtime);
const server = new WorkspaceServer(runtime);
const settings = new Map<string, unknown>();

// Codex's window: the toolbar row is 46px; the traffic lights sit centred on its 44px chrome.
const TOOLBAR = 44;
const TRAFFIC_LIGHTS = { x: 16, y: Math.round((TOOLBAR - 14) / 2) };

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let nativeModule: NativeModule | undefined;
let visible = false;
/** The workspace document has loaded and mounted: commands can be delivered to it. */
let pageReady = false;
let quitting = false;
let quitConfirmed = false;
let problem: string | undefined;

app.setName("LinkShell");
// Hidden or behind other windows, Chromium throttles timers: heartbeats would then come late, and a dead link look alive.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

if (!app.requestSingleInstanceLock({ scope: runtime.scope })) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (launchOptions(argv).checkUpdates) openManagement("更新");
    showWindow();
  });
  void app.whenReady().then(ready);
}

function appearance(): "light" | "dark" | "system" {
  const value = settings.get("appearance");
  return WorkspacePolicy.validAppearance(value) ? value : "dark";
}

function applyAppearance() {
  const value = appearance();
  nativeTheme.themeSource = value;
  send("linkshell-desktop-appearance", { appearance: value });
  updateWindowSurface();
}

/** Vibrancy only while it is worth it: focused, and below 4K, where the blur costs frames. */
function updateWindowSurface() {
  if (!window) return;
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const physical = bounds.width * display.scaleFactor * bounds.height * display.scaleFactor;
  const translucent = window.isFocused() && physical < 3840 * 2160 && settings.get("opaqueWindow") !== true;
  window.setVibrancy(translucent ? "menu" : null);
  const dark = nativeTheme.shouldUseDarkColors;
  // The page's own ground where vibrancy is off (theme.ts `background`).
  window.setBackgroundColor(translucent ? "#00000000" : dark ? "#1d1d1d" : "#f3f3f3");
  send("linkshell-desktop-surface", { translucent });
}

function send(name: string, detail: unknown) {
  if (!window || window.isDestroyed() || !server.policy?.isTrusted(window.webContents.getURL())) return;
  window.webContents.send("linkshell:event", name, detail);
}

/** Hidden, minimized or closed: the page pauses its remote screen and previews. */
function setVisible(value: boolean) {
  visible = value;
  send("linkshell-desktop-visibility", { visible });
}

function createWindow() {
  const state = settings.get("window") as { x?: number; y?: number; width?: number; height?: number } | undefined;
  window = new BrowserWindow({
    title: "LinkShell",
    width: state?.width ?? 1280,
    height: state?.height ?? 820,
    x: state?.x,
    y: state?.y,
    minWidth: 940,
    minHeight: 640,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC_LIGHTS,
    vibrancy: "menu",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    acceptFirstMouse: true,
    fullscreenable: true,
    webPreferences: {
      preload: join(here, "../preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      scrollBounce: true,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  });
  const web = window.webContents;
  guard(web);
  window.on("focus", updateWindowSurface);
  window.on("blur", updateWindowSurface);
  window.on("resize", updateWindowSurface);
  window.on("moved", updateWindowSurface);
  window.on("ready-to-show", () => { if (!quitting) showWindow(); });
  window.on("show", () => setVisible(!window!.isMinimized()));
  window.on("hide", () => setVisible(false));
  window.on("minimize", () => setVisible(false));
  window.on("restore", () => setVisible(true));
  window.on("close", (event) => {
    rememberBounds();
    if (quitting) return;
    // Closing the window leaves LinkShell in the menu bar; the Host is never stopped here.
    event.preventDefault();
    // A full-screen window would leave an empty Space behind when hidden.
    if (window!.isFullScreen()) { window!.once("leave-full-screen", () => window?.hide()); window!.setFullScreen(false); }
    else window!.hide();
    if (process.platform === "darwin") app.dock?.hide();
  });
  window.on("enter-full-screen", () => send("linkshell-desktop-window", { fullscreen: true }));
  window.on("leave-full-screen", () => send("linkshell-desktop-window", { fullscreen: false }));
  web.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) pageReady = false; });
  web.on("did-finish-load", () => {
    if (!server.policy?.isTrusted(web.getURL())) return;
    problem = undefined;
    send("linkshell-desktop-visibility", { visible });
    applyAppearance();
    // React mounts after load; its command listeners are there a moment later.
    setTimeout(() => {
      pageReady = true;
      updateWindowSurface();
      send("linkshell-desktop-window", { fullscreen: window?.isFullScreen() ?? false });
      if (pendingCommand) { send("linkshell-desktop-command", pendingCommand); pendingCommand = undefined; }
    }, 300);
  });
  web.on("render-process-gone", () => {
    showProblem("工作台页面意外退出。请重新连接以恢复电脑与会话。");
  });
  startServer();
}

function rememberBounds() {
  if (!window || window.isFullScreen() || window.isMinimized()) return;
  settings.set("window", window.getBounds());
  void saveSettings();
}

/** The signed page owns the bridge; preview and screen frames never do. */
function guard(web: WebContents) {
  web.setWindowOpenHandler(({ url }) => {
    if (WorkspacePolicy.externalURL(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  web.on("will-navigate", (event, url) => {
    if (server.policy?.isTrusted(url)) return;
    event.preventDefault();
    // The error page's only button: it cannot reach the bridge, so it asks by navigating.
    if (url === "linkshell-retry:" && web.getURL().startsWith("data:")) { void retry(); return; }
    if (WorkspacePolicy.externalURL(url)) void shell.openExternal(url);
  });
  web.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    if (!server.policy?.allowsSubframe(details.url)) details.preventDefault();
  });
  web.on("will-redirect", (event, url) => {
    if (!server.policy?.isTrusted(url) && !server.policy?.isPreview(url)) event.preventDefault();
  });
  web.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = server.policy?.isTrusted(details.requestingUrl) ?? false;
    callback(trusted && ["clipboard-sanitized-write", "clipboard-read", "media", "fullscreen", "notifications"].includes(permission));
    void contents;
  });
  web.session.on("will-download", (_event, item) => {
    const url = item.getURL();
    if (!server.policy || !(server.policy.isTrusted(url) || server.policy.allowsBlob(url) || url.startsWith("data:"))) { item.cancel(); return; }
    item.setSaveDialogOptions({ title: "保存", buttonLabel: "保存", defaultPath: item.getFilename() });
    item.once("done", (_done, state) => {
      if (state === "interrupted" && window) void dialog.showMessageBox(window, { type: "warning", message: "文件未能保存", detail: "下载被中断，请重试。" });
    });
  });
}

function startServer() {
  if (!window) return;
  problem = undefined;
  server.start((url) => {
    if (!window) return;
    void window.loadURL(url.href).catch((error: Error) => showProblem(`无法打开工作台：${error.message}`));
  }, (message) => showProblem(message));
}

/** Shown when the page itself cannot be: the native shell has no other way to say it. */
function showProblem(message: string) {
  problem = message;
  if (!window) return;
  const html = `<!doctype html><meta charset="utf-8"><title>LinkShell</title><style>
    :root{color-scheme:light dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
    body{margin:0;height:100vh;display:grid;place-items:center;background:transparent;color:light-dark(#1a1c1f,#dfdfdf);-webkit-app-region:drag}
    main{max-width:420px;text-align:center;padding:24px}h1{font-size:16px;font-weight:600;margin:0 0 8px}
    p{margin:0 0 20px;color:light-dark(rgb(26 28 31/.7),rgb(255 255 255/.7))}
    button{-webkit-app-region:no-drag;height:28px;padding:0 14px;border-radius:8px;border:0;font:inherit;font-weight:500;background:light-dark(#1a1c1f,#fff);color:light-dark(#fff,#0d0d0d)}
  </style><main><h1>工作台暂时不可用</h1><p></p><button>重新连接</button></main>
  <script>document.querySelector("p").textContent=${JSON.stringify(message)};document.querySelector("button").onclick=()=>location.href="linkshell-retry:";</script>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function retry() {
  if (!(await flushOrConfirm("仍然重新连接"))) return;
  server.stop();
  startServer();
}

function showWindow() {
  if (!window) return;
  if (process.platform === "darwin") void app.dock?.show();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  setVisible(true);
}

/** A command for the page; one sent before it has loaded (a second launch, --check-updates) waits for it. */
let pendingCommand: Record<string, unknown> | undefined;
function command(detail: Record<string, unknown>) {
  if (pageReady) send("linkshell-desktop-command", detail);
  else pendingCommand = detail;
}

function openManagement(page?: string) { command({ command: "manage", page }); }
function openWorkspace() { command({ command: "workspace" }); }

// ── The page's messages ───────────────────────────────────────────────────────────────────

ipcMain.on("linkshell:boot", (event) => {
  event.returnValue = server.policy?.isTrusted(event.senderFrame?.url) ?
    { appearance: appearance(), visible, platform: process.platform } : undefined;
});

ipcMain.on("linkshell:message", (event, body: unknown) => {
  const frame = event.senderFrame;
  if (!window || event.sender !== window.webContents || !frame || !server.policy?.allowsBridge(frame.url, frame === event.sender.mainFrame)) return;
  if (!body || typeof body !== "object") return;
  const message = body as Record<string, unknown>;
  switch (message.action) {
    // The page switches between the workspace and management itself; nothing native follows it.
    case "manage":
    case "workspace": return;
    case "appearance":
      if (WorkspacePolicy.validAppearance(message.value) && message.value !== appearance()) {
        settings.set("appearance", message.value); void saveSettings(); applyAppearance(); updateTray();
      }
      return;
    case "external":
      if (typeof message.url === "string" && WorkspacePolicy.externalURL(message.url)) void shell.openExternal(message.url);
      return;
    // The page's own element full screen and focus handling are enough: nothing native sits above it.
    case "contentFocus": return;
    case "invoke": return void invoke(event.sender, message);
  }
});

/** Management requests: each answered once, by id, through the same event channel. */
async function invoke(sender: WebContents, message: Record<string, unknown>) {
  const id = typeof message.id === "string" ? message.id : undefined;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  if (!id) return;
  let result: unknown;
  let error: string | undefined;
  try { result = await handle(method, params); }
  catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  if (sender.isDestroyed()) return;
  send("linkshell-desktop-reply", { id, result, error });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "snapshot": return management.snapshot();
    case "startup": return management.startup();
    case "action": return management.action(String(params.name ?? ""), params.input);
    case "login": return management.signIn();
    case "cancelLogin": management.cancelSignIn(); return {};
    case "usage": return management.usage(Number(params.days), String(params.agent ?? "all"));
    case "log": return { text: await management.log(runtime.home), path: join(runtime.home, "host.log") };
    case "revealLog": shell.showItemInFolder(join(runtime.home, "host.log")); return {};
    // An npm or Homebrew install updates itself (`linkshell upgrade`); a standalone app uses Sparkle.
    case "upgrade": {
      if (runtime.standalone) { nativeModule?.updaterInstall(); return {}; }
      await management.exec(["upgrade"], 240_000).catch(() => { throw new Error("更新未完成，请在终端运行 linkshell upgrade 查看详情。"); });
      return { message: "更新完成。重新打开 LinkShell 可加载新版界面。" };
    }
    case "about": return {
      version: app.getVersion(), electron: process.versions.electron, standalone: runtime.standalone,
      bundle: runtime.bundle, home: runtime.home, info: await management.standaloneInfo(),
    };
    case "permissions": return nativeModule?.permissions() ?? { recording: false, control: false, unavailable: true };
    case "openSetup": return openSetup();
    case "loginItem": return nativeModule?.loginItem() ?? { enabled: app.getLoginItemSettings().openAtLogin, approval: false };
    case "setLoginItem": {
      const enabled = params.enabled === true;
      if (nativeModule) { const failed = nativeModule.setLoginItem(enabled); if (failed) throw new Error(`无法修改开机启动：${failed}`); }
      else app.setLoginItemSettings({ openAtLogin: enabled });
      return nativeModule?.loginItem() ?? { enabled, approval: false };
    }
    case "openLoginItems": nativeModule?.openLoginItems(); return {};
    case "installCommand": return { path: await installCommand() };
    case "settings": return { opaqueWindow: settings.get("opaqueWindow") === true, autoCheck: settings.get("autoCheck") !== false, updateChannel: settings.get("updateChannel") ?? "stable" };
    case "setSetting": {
      const key = String(params.key ?? "");
      if (!["opaqueWindow", "autoCheck", "updateChannel"].includes(key)) throw new Error("未知设置");
      if (key === "updateChannel" && !["stable", "beta"].includes(String(params.value))) throw new Error("未知更新通道");
      settings.set(key, params.value); await saveSettings();
      if (key === "opaqueWindow") updateWindowSurface();
      if (key === "updateChannel") nativeModule?.updaterChannel(String(params.value));
      return {};
    }
    case "checkUpdates": return checkUpdates();
    case "installUpdate": nativeModule?.updaterInstall(); return {};
    case "retry": void retry(); return {};
    default: throw new Error("不支持的操作");
  }
}

// ── Saving before quitting or reconnecting ────────────────────────────────────────────────

function flush(): Promise<boolean> {
  return new Promise((resolve) => {
    // No workspace document: nothing of the page's is waiting to be saved.
    if (!window || window.isDestroyed() || !server.policy?.isTrusted(window.webContents.getURL())) return resolve(true);
    const nonce = randomUUID();
    const timer = setTimeout(() => { ipcMain.removeListener("linkshell:flushed", done); resolve(false); }, 10_000);
    const done = (event: Electron.IpcMainEvent, answered: unknown, result: unknown) => {
      if (answered !== nonce || event.sender !== window?.webContents) return;
      clearTimeout(timer);
      ipcMain.removeListener("linkshell:flushed", done);
      const value = result as { saved?: boolean; pending?: number } | undefined;
      resolve(value?.saved === true && value.pending === 0);
    };
    ipcMain.on("linkshell:flushed", done);
    window.webContents.send("linkshell:flush", nonce);
  });
}

async function flushOrConfirm(continuing: string): Promise<boolean> {
  if (await flush()) return true;
  const options = {
    type: "warning" as const, message: "部分草稿或设置尚未确认保存",
    detail: "保存请求失败或等待超时。你可以返回工作台重试；继续可能丢失最近的修改。",
    buttons: ["返回工作台", continuing], defaultId: 0, cancelId: 0,
  };
  if (window) showWindow();
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 1;
}

app.on("before-quit", (event) => {
  if (quitConfirmed) { quitting = true; return; }
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void flushOrConfirm("仍然退出").then((confirmed) => {
    if (!confirmed) { quitting = false; return; }
    quitConfirmed = true;
    server.stop();
    rememberBounds();
    app.quit();
  });
});

app.on("activate", () => showWindow());
app.on("window-all-closed", () => { /* LinkShell stays in the menu bar. */ });

// ── Native pieces ─────────────────────────────────────────────────────────────────────────

function openSetup() {
  const helper = runtime.bundle;
  if (!helper) throw new Error("开发模式下请从 apps/mac 构建的 LinkShell.app 打开权限引导");
  // The system opens it, so the permissions it shows are LinkShell's, not this process's.
  spawn("/usr/bin/open", ["-n", "-a", helper, "--args", "--setup"], { stdio: "ignore", detached: true }).unref();
  return {};
}

async function installCommand(): Promise<string> {
  if (!runtime.standalone || !runtime.bundle) throw new Error("当前不是独立 App 安装");
  const { mkdir, readlink, symlink, lstat } = await import("node:fs/promises");
  const directory = join(app.getPath("home"), ".local/bin");
  const link = join(directory, "linkshell");
  const target = join(runtime.bundle, "Contents/MacOS/linkshell-cli");
  await mkdir(directory, { recursive: true });
  const existing = await readlink(link).catch(() => undefined);
  if (existing === target) return link;
  // A different installation's command is never silently replaced.
  if (existing !== undefined || await lstat(link).then(() => true, () => false)) {
    throw new Error("~/.local/bin/linkshell 已存在，未覆盖。可直接使用 App 内 Contents/MacOS/linkshell-cli。");
  }
  await symlink(target, link);
  return link;
}

let lastUpdateCheck = 0;
function checkUpdates() {
  lastUpdateCheck = Date.now();
  if (!nativeModule || !runtime.standalone) return { started: false };
  nativeModule.updaterCheck();
  return { started: true };
}

function startUpdater() {
  if (!nativeModule || !runtime.standalone) return;
  nativeModule.updaterStart({
    event: (name, detail) => {
      if (name === "prepare") {
        // Sparkle is about to relaunch: the CLI stops this app's Host first, then Sparkle continues.
        void management.action("prepare-update").catch(() => undefined).finally(() => nativeModule?.updaterPrepared());
        return;
      }
      if (name === "recover") { void management.action("recover-update").catch(() => undefined); }
      send("linkshell-desktop-update", { name, ...detail });
    },
  }, String(settings.get("updateChannel") ?? "stable"));
  setInterval(() => {
    if (settings.get("autoCheck") !== false && Date.now() - lastUpdateCheck > 6 * 3600_000) checkUpdates();
  }, 60_000).unref();
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 LinkShell", click: () => { openWorkspace(); showWindow(); } },
    { label: "本机管理", click: () => { openManagement(); showWindow(); } },
    { type: "separator" },
    { label: "退出 LinkShell 界面", click: () => app.quit() },
  ]));
}

function installMenu() {
  const template: MenuItemConstructorOptions[] = [
    { label: "LinkShell", submenu: [
      { label: "关于 LinkShell", role: "about" },
      { type: "separator" },
      { label: "工作台", accelerator: "CmdOrCtrl+1", click: () => { openWorkspace(); showWindow(); } },
      { label: "本机管理", accelerator: "CmdOrCtrl+2", click: () => { openManagement(); showWindow(); } },
      { label: "检查更新…", click: () => { openManagement("更新"); showWindow(); checkUpdates(); } },
      { type: "separator" },
      { label: "隐藏 LinkShell", role: "hide" },
      { label: "隐藏其他", role: "hideOthers" },
      { type: "separator" },
      { label: "关闭窗口", accelerator: "CmdOrCtrl+W", role: "close" },
      { label: "退出 LinkShell 界面", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ] },
    { label: "编辑", submenu: [
      { label: "撤销", role: "undo" }, { label: "重做", role: "redo" }, { type: "separator" },
      { label: "剪切", role: "cut" }, { label: "复制", role: "copy" }, { label: "粘贴", role: "paste" },
      { label: "粘贴并匹配样式", role: "pasteAndMatchStyle" }, { label: "全选", role: "selectAll" },
    ] },
    { label: "显示", submenu: [
      { label: "实际大小", role: "resetZoom" }, { label: "放大", role: "zoomIn" }, { label: "缩小", role: "zoomOut" },
      { type: "separator" },
      { label: "进入全屏", role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ type: "separator" as const }, { label: "开发者工具", role: "toggleDevTools" as const }]),
    ] },
    { label: "窗口", role: "windowMenu", submenu: [
      { label: "最小化", role: "minimize" }, { label: "缩放", role: "zoom" }, { type: "separator" }, { label: "前置全部窗口", role: "front" },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Settings: one small JSON file in Electron's userData, not the Host's directory ────────

async function loadSettings() {
  const { readFile } = await import("node:fs/promises");
  try {
    const parsed = JSON.parse(await readFile(join(app.getPath("userData"), "desktop.json"), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) settings.set(key, value);
  } catch { /* First run: defaults. */ }
}

let saving = Promise.resolve();
function saveSettings(): Promise<void> {
  saving = saving.then(async () => {
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    const directory = app.getPath("userData");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "desktop.json");
    await writeFile(file + ".tmp", JSON.stringify(Object.fromEntries(settings), null, 2), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }).catch((error: unknown) => console.error("[settings]", error));
  return saving;
}

async function ready() {
  await loadSettings();
  // Sparkle relaunches with no arguments: keep the chosen state directory, never credentials.
  if (launch.home) { settings.set("home", launch.home); void saveSettings(); }
  else if (typeof settings.get("home") === "string" && runtime.standalone) process.env.LINKSHELL_HOME = settings.get("home") as string;
  nativeTheme.themeSource = appearance();
  nativeModule = native(runtime.bundle, app.getAppPath());
  installMenu();
  const iconPath = join(app.getAppPath(), "assets/trayTemplate.png");
  if (existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("LinkShell");
    updateTray();
  }
  createWindow();
  startUpdater();
  if (launch.checkUpdates) { openManagement("更新"); checkUpdates(); }
}
