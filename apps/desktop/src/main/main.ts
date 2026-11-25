import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, powerMonitor, powerSaveBlocker, screen, shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CommandQueue, type PageCommand } from "./command-queue.js";
import { installEditingContextMenu } from "./editing-context-menu.js";
import { FusionController } from "./fusion-controller.js";
import { KeepAwake, normalizeKeepAwakeMode } from "./keep-awake.js";
import { normalizeMainLocale, translateMain, type MainKey, type MainLocale } from "./locale.js";
import { Management } from "./management.js";
import { MdnsLanBrowser } from "./mdns-browser.js";
import { native, type NativeModule } from "./native.js";
import { badgeCount } from "./notify.js";
import { isOpenPathApp, openPathPlan } from "./open-path.js";
import { WorkspacePolicy } from "./policy.js";
import { normalizePreviewSubPath, RemotePortProxyManager, validatePreviewPort } from "./remote-port-proxy.js";
import { launchOptions, Runtime } from "./runtime.js";
import { SettingsStore } from "./settings-store.js";
import { TrayMenuController } from "./tray-menu.js";
import { UpdaterController } from "./updater-controller.js";
import { restoreWindowBounds } from "./window-bounds.js";
import { SidecarUnavailableError, WorkspaceServer } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const launch = launchOptions(process.argv);
const runtime = new Runtime(app.getAppPath(), launch);
const management = new Management(runtime);
const server = new WorkspaceServer(runtime);
const settings = new SettingsStore(() => app.getPath("userData"));
const keepAwake = new KeepAwake(powerSaveBlocker);

let locale: MainLocale = "zh";
const t = (key: MainKey, params?: Record<string, string | number>) => translateMain(locale, key, params);

// A 42 px toolbar: macOS traffic lights sit optically centered in it at { x: 15, y: 13 }.
const TOOLBAR = 42;
const TRAFFIC_LIGHTS = { x: 15, y: 13 };
const MAC = process.platform === "darwin";
const WINDOWS = process.platform === "win32";
/** The page's own ground where the window is not translucent (`--ls-ground` L0). */
const ground = () => (nativeTheme.shouldUseDarkColors ? "#090a0c" : "#f2f3f6");
/** Windows draws its caption buttons over the page's 42 px title row (--chrome-h), in the page's ink (`--ls-fg`). */
const overlay = () => ({ color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#eceef2" : "#141518", height: TOOLBAR });

let surfaceDark: boolean | undefined;
let surfaceTranslucent: boolean | undefined;
let userRequestedShow = false;
let hideAfterLeaveFullScreen = false;
let boundsTimer: ReturnType<typeof setTimeout> | undefined;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;

let window: BrowserWindow | undefined;
let nativeModule: NativeModule | undefined;
let visible = false;
let systemShortcutCaptured = false;
let menuShortcutsIgnored = false;
let nativeScreenShown = false;
let pageReady = false;
let quitting = false;
let quitConfirmed = false;

const mdnsBrowser = new MdnsLanBrowser({ log: (line) => console.log(line) });
mdnsBrowser.onChange((hosts) => send("linkshell-desktop-lan-hosts", hosts));

const fusion = new FusionController({
  mac: MAC,
  windows: WINDOWS,
  runtime,
  preload: join(here, "../preload/fusion-hub.cjs"),
  homePath: () => app.getPath("home"),
  appDataPath: () => app.getPath("appData"),
  pageURL: () => server.url,
  isTrusted: (url) => server.policy?.isTrusted(url) ?? false,
  send,
});

const trayMenu = new TrayMenuController({
  mac: MAC,
  windows: WINDOWS,
  runtime,
  settings,
  t,
  getWindow: () => window,
  isVisible: () => visible,
  showWindow,
  openWorkspace,
  openManagement,
  checkUpdates: () => { updater.check(); },
  closeTab,
  toggleFullScreen: toggleWindowFullScreen,
  command,
});

const updater = new UpdaterController({
  mac: MAC,
  windows: WINDOWS,
  runtime,
  settings,
  appVersion: () => app.getVersion(),
  userData: () => app.getPath("userData"),
  getLocale: () => locale,
  t,
  getNative: () => nativeModule,
  runHostAction: (name) => runManagementAction(name),
  send,
  noteUpdate: (name, version) => trayMenu.noteUpdate(name, version),
  getUpdateAvailable: () => trayMenu.getUpdateAvailable(),
  flush,
  flushOrConfirm,
  rememberBounds,
  quitForUpdate: async () => {
    quitConfirmed = true;
    quitting = true;
    await shutdownForQuit();
    app.quit();
  },
});

const remotePortProxies = new RemotePortProxyManager({
  dispatch: (payload) => {
    if (!pageReady || !window || window.isDestroyed() || !server.policy?.isTrusted(window.webContents.getURL())) return false;
    send("linkshell-desktop-remote-port-req", payload);
    return true;
  },
  cancel: (reqId) => {
    send("linkshell-desktop-remote-port-cancel", { reqId });
  },
});

// ── App bootstrap & single instance ──────────────────────────────────────────────────────

app.setName("LinkShell");
// Hidden or behind other windows, Chromium throttles timers: heartbeats would then come late, and a dead link look alive.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const forcedLanguage = ({ zh: "zh-CN", en: "en-US", ja: "ja" } as Record<string, string>)[process.env.LINKSHELL_LOCALE ?? ""];
if (forcedLanguage) app.commandLine.appendSwitch("lang", forcedLanguage);

if (!app.requestSingleInstanceLock({ scope: runtime.scope })) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const opts = launchOptions(argv);
    if (opts.checkUpdates) { openManagement("updates"); updater.check(); }
    if (opts.fusionConnect) {
      command({ command: "fusion", computerKey: opts.fusionConnect, launchBundle: opts.fusionLaunch });
      if (!opts.fusionLaunch) { app.focus({ steal: true }); showWindow(); }
      return;
    }
    app.focus({ steal: true });
    showWindow();
  });
  void app.whenReady().then(ready);
}

// ── Window surface, fullscreen, visibility & lifecycle ───────────────────────────────────

function applyAppearance() {
  const value = settings.appearance();
  nativeTheme.themeSource = value;
  send("linkshell-desktop-appearance", { appearance: value });
  updateWindowSurface(true);
}

function setNativeScreenShown(value: boolean) {
  if (nativeScreenShown === value) return;
  nativeScreenShown = value;
  updateWindowSurface();
}

/** Vibrancy only while it is worth it: focused, and below 4K, where the blur costs frames. */
function updateWindowSurface(force: unknown = false) {
  if (!window || window.isDestroyed()) return;
  const forceSync = force === true;
  const dark = nativeTheme.shouldUseDarkColors;
  if (!MAC) {
    if (dark !== surfaceDark) {
      surfaceDark = dark;
      window.setBackgroundColor(ground());
      if (WINDOWS) window.setTitleBarOverlay(overlay());
    }
    if (forceSync || surfaceTranslucent !== false) {
      surfaceTranslucent = false;
      send("linkshell-desktop-surface", { translucent: false });
    }
    return;
  }
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const physical = bounds.width * display.scaleFactor * bounds.height * display.scaleFactor;
  const translucent = window.isFocused() && physical < 3840 * 2160 && !settings.opaqueWindow() && !nativeScreenShown && !isWindowFullScreen();
  const surfaceChanged = translucent !== surfaceTranslucent;
  const groundChanged = !translucent && dark !== surfaceDark;
  if (forceSync || surfaceChanged || groundChanged) {
    surfaceTranslucent = translucent;
    surfaceDark = dark;
    window.setVibrancy(translucent ? "menu" : null);
    window.setBackgroundColor(translucent ? "#00000000" : ground());
    send("linkshell-desktop-surface", { translucent });
  }
}

function send(name: string, detail: unknown) {
  if (!window || window.isDestroyed() || !server.policy?.isTrusted(window.webContents.getURL())) return;
  window.webContents.send("linkshell:event", name, detail);
}

function setSystemShortcutCaptureEnabled(enabled: boolean): boolean {
  if (enabled && MAC && nativeModule) {
    const active = Boolean(nativeModule.setSystemShortcutCapture(true));
    systemShortcutCaptured = active;
    return active;
  }
  nativeModule?.setSystemShortcutCapture(false);
  const changed = systemShortcutCaptured;
  systemShortcutCaptured = false;
  if (changed) send("linkshell-desktop-shortcut-capture", { captured: false });
  return false;
}

function resetSystemShortcutCapture(): void {
  if (systemShortcutCaptured) setSystemShortcutCaptureEnabled(false);
  else nativeModule?.setSystemShortcutCapture(false);
}

let wantedFullScreen: boolean | undefined;
let wantedImmersiveFullScreen = false;
let fullScreenMoving = false;
let preSimpleFullScreenBounds: Electron.Rectangle | undefined;
let fullScreenAsked = false;
let fullScreenRetry: ReturnType<typeof setTimeout> | undefined;

function isSimpleFullScreen(): boolean {
  return MAC && !!window && !window.isDestroyed() && window.isSimpleFullScreen();
}
function isWindowFullScreen(): boolean {
  return !!window && !window.isDestroyed() && (window.isFullScreen() || isSimpleFullScreen());
}
function syncImmersivePresentation() {
  if (!MAC) return;
  const active = isSimpleFullScreen() && visible && !!window && !window.isDestroyed() && window.isFocused() && !window.isFullScreen();
  nativeModule?.setImmersiveFullScreen(active);
}
function reconcileFullScreen() {
  if (!window || window.isDestroyed() || wantedFullScreen === undefined || fullScreenMoving) return;
  const wanted = wantedFullScreen;
  if (MAC && wanted && wantedImmersiveFullScreen && !window.isFullScreen()) {
    clearTimeout(fullScreenRetry);
    if (!window.isSimpleFullScreen()) {
      preSimpleFullScreenBounds = window.getBounds();
      rememberBounds();
      window.setSimpleFullScreen(true);
    }
    syncImmersivePresentation();
    updateWindowSurface();
    send("linkshell-desktop-window", { fullscreen: true });
    send("linkshell-desktop-fullscreen", { fullscreen: true });
    return;
  }
  if (MAC && !wanted && window.isSimpleFullScreen()) {
    clearTimeout(fullScreenRetry);
    wantedImmersiveFullScreen = false;
    const restoreBounds = preSimpleFullScreenBounds;
    preSimpleFullScreenBounds = undefined;
    window.setSimpleFullScreen(false);
    nativeModule?.setImmersiveFullScreen(false);
    const restoreChrome = () => {
      if (!window || window.isDestroyed() || isWindowFullScreen()) return;
      if (restoreBounds) window.setBounds(restoreBounds);
      window.setWindowButtonPosition(TRAFFIC_LIGHTS);
      updateWindowSurface();
    };
    restoreChrome();
    setTimeout(restoreChrome, 60);
    setTimeout(restoreChrome, 320);
    wantedFullScreen = undefined;
    send("linkshell-desktop-window", { fullscreen: false });
    send("linkshell-desktop-fullscreen", { fullscreen: false });
    return;
  }
  if (window.isFullScreen() === wanted) {
    clearTimeout(fullScreenRetry);
    syncImmersivePresentation();
    send("linkshell-desktop-fullscreen", { fullscreen: wanted });
    if (!wanted) { wantedFullScreen = undefined; wantedImmersiveFullScreen = false; }
    return;
  }
  fullScreenMoving = true;
  if (!wanted) { fullScreenAsked = true; wantedImmersiveFullScreen = false; }
  syncImmersivePresentation();
  window.setFullScreen(wanted);
  clearTimeout(fullScreenRetry);
  fullScreenRetry = setTimeout(() => { fullScreenMoving = false; reconcileFullScreen(); }, 1500);
}

function toggleWindowFullScreen() {
  if (!window || window.isDestroyed()) return;
  if (isSimpleFullScreen() || window.isFullScreen()) {
    wantedFullScreen = false;
    wantedImmersiveFullScreen = false;
    reconcileFullScreen();
    return;
  }
  wantedFullScreen = true;
  wantedImmersiveFullScreen = nativeScreenShown;
  reconcileFullScreen();
}

function setVisible(value: boolean) {
  visible = value;
  nativeModule?.screenVisible(value);
  syncImmersivePresentation();
  send("linkshell-desktop-visibility", { visible });
}

function createWindow() {
  const state = restoreWindowBounds(settings.get("window"), screen.getAllDisplays().map((display) => display.workArea), { width: 940, height: 640 }, { width: 1280, height: 820 });
  surfaceDark = nativeTheme.shouldUseDarkColors;
  surfaceTranslucent = undefined;
  const initialOpaque = settings.opaqueWindow();
  window = new BrowserWindow({
    title: "LinkShell",
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 640,
    show: false,
    ...(MAC
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: TRAFFIC_LIGHTS,
          ...(initialOpaque
            ? { backgroundColor: ground() }
            : { vibrancy: "menu" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000" }),
        }
      : { titleBarStyle: "hidden" as const, titleBarOverlay: overlay(), backgroundColor: ground(), icon: join(app.getAppPath(), "assets/icon.png") }),
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
  const created = window;
  if (state.maximized) window.maximize();
  window.on("closed", () => {
    if (window === created) window = undefined;
    clearPageReadyTimer();
    clearBoundsTimer();
    clearHungTimer();
    clearTimeout(fullScreenRetry);
    hideAfterLeaveFullScreen = false;
    pageReady = false;
    menuShortcutsIgnored = false;
    resetSystemShortcutCapture();
    nativeModule?.setImmersiveFullScreen(false);
    nativeModule?.screenStop();
    nativeScreenShown = false;
    void mdnsBrowser.stop();
  });
  const web = window.webContents;
  guard(web);
  window.on("focus", () => {
    if (!created.isDestroyed() && !visible && created.isVisible() && !created.isMinimized()) setVisible(true);
    if (WINDOWS && !created.isDestroyed()) created.flashFrame(false);
    syncImmersivePresentation();
    updateWindowSurface();
    updater.maybeAutoCheck();
  });
  window.on("blur", () => {
    syncImmersivePresentation();
    updateWindowSurface();
    menuShortcutsIgnored = false;
    if (!created.isDestroyed()) created.webContents.setIgnoreMenuShortcuts(false);
    resetSystemShortcutCapture();
  });
  window.on("resize", () => { updateWindowSurface(); scheduleRememberBounds(); });
  window.on("moved", () => { updateWindowSurface(); scheduleRememberBounds(); });
  window.on("ready-to-show", () => {
    if (!quitting && (userRequestedShow || (!launch.hidden && !(launch.fusionConnect && launch.fusionLaunch)))) showWindow();
  });
  window.on("show", () => { if (!created.isDestroyed()) setVisible(!created.isMinimized()); });
  window.on("hide", () => { if (!created.isDestroyed() && !created.isVisible()) setVisible(false); });
  window.on("minimize", () => setVisible(false));
  window.on("restore", () => setVisible(true));
  window.on("close", (event) => {
    rememberBounds();
    if (quitting || created.isDestroyed()) return;
    event.preventDefault();
    wantedFullScreen = undefined;
    wantedImmersiveFullScreen = false;
    nativeModule?.setImmersiveFullScreen(false);
    if (isSimpleFullScreen()) {
      created.setSimpleFullScreen(false);
      if (preSimpleFullScreenBounds) {
        created.setBounds(preSimpleFullScreenBounds);
        preSimpleFullScreenBounds = undefined;
      }
      if (MAC) created.setWindowButtonPosition(TRAFFIC_LIGHTS);
      send("linkshell-desktop-window", { fullscreen: false });
      send("linkshell-desktop-fullscreen", { fullscreen: false });
      created.hide();
      if (MAC) app.dock?.hide();
    } else if (created.isFullScreen()) {
      hideAfterLeaveFullScreen = true;
      created.setFullScreen(false);
    } else {
      created.hide();
      if (MAC) app.dock?.hide();
    }
  });
  window.on("enter-full-screen", () => {
    fullScreenMoving = false;
    syncImmersivePresentation();
    if (wantedFullScreen === undefined) wantedFullScreen = true;
    send("linkshell-desktop-window", { fullscreen: true });
    reconcileFullScreen();
  });
  window.on("leave-full-screen", () => {
    fullScreenMoving = false;
    wantedImmersiveFullScreen = false;
    if (MAC && window && !window.isDestroyed()) window.setWindowButtonPosition(TRAFFIC_LIGHTS);
    syncImmersivePresentation();
    if (wantedFullScreen === true && !fullScreenAsked) wantedFullScreen = false;
    fullScreenAsked = false;
    send("linkshell-desktop-window", { fullscreen: false });
    if (wantedFullScreen !== true) send("linkshell-desktop-fullscreen", { fullscreen: false });
    if (hideAfterLeaveFullScreen) {
      hideAfterLeaveFullScreen = false;
      if (!quitting && window && !window.isDestroyed()) {
        window.hide();
        if (MAC) app.dock?.hide();
      }
      return;
    }
    reconcileFullScreen();
  });
  web.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      clearPageReadyTimer();
      pageReady = false;
      menuShortcutsIgnored = false;
      resetSystemShortcutCapture();
      nativeModule?.screenStop();
      setNativeScreenShown(false);
      void mdnsBrowser.stop();
    }
  });
  web.on("did-finish-load", () => {
    if (!server.policy?.isTrusted(web.getURL())) return;
    send("linkshell-desktop-visibility", { visible });
    applyAppearance();
    if (!pageReady) {
      clearPageReadyTimer();
      pageReadyTimer = setTimeout(() => { markPageReady(); }, 2500);
    }
  });
  web.on("render-process-gone", () => {
    clearHungTimer();
    clearPageReadyTimer();
    pageReady = false;
    resetSystemShortcutCapture();
    nativeModule?.setImmersiveFullScreen(false);
    nativeModule?.screenStop();
    nativeScreenShown = false;
    void mdnsBrowser.stop();
    showProblem(t("problem.gone"));
  });
  web.on("unresponsive", () => {
    if (hungTimer || hungDialog) return;
    hungTimer = setTimeout(() => { hungTimer = undefined; void offerReload(); }, 10_000);
  });
  web.on("responsive", clearHungTimer);
  startServer();
}

function clearBoundsTimer() {
  if (!boundsTimer) return;
  clearTimeout(boundsTimer);
  boundsTimer = undefined;
}
function scheduleRememberBounds() {
  clearBoundsTimer();
  boundsTimer = setTimeout(() => { boundsTimer = undefined; rememberBounds(); }, 500);
}
function rememberBounds() {
  clearBoundsTimer();
  if (!window || window.isDestroyed() || isWindowFullScreen() || window.isMinimized()) return;
  settings.set("window", { ...window.getNormalBounds(), maximized: window.isMaximized() });
  void settings.save();
}

let hungTimer: ReturnType<typeof setTimeout> | undefined;
let hungDialog = false;
function clearHungTimer() { clearTimeout(hungTimer); hungTimer = undefined; }
async function offerReload() {
  if (!window || window.isDestroyed()) return;
  hungDialog = true;
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: "warning", message: t("hung.message"), detail: t("hung.detail"),
      buttons: [t("hung.wait"), t("hung.reload")], defaultId: 0, cancelId: 0,
    });
    if (response !== 1 || !window || window.isDestroyed()) return;
    remotePortProxies.stopAll();
    await server.stop();
    startServer();
  } finally { hungDialog = false; }
}

function guard(web: WebContents) {
  installEditingContextMenu(web, () => window, () => server.policy?.isTrusted(web.getURL()) ?? false, () => ({
    undo: t("menu.undo"), redo: t("menu.redo"), cut: t("menu.cut"), copy: t("menu.copy"),
    paste: t("menu.paste"), delete: t("menu.delete"), selectAll: t("menu.selectAll"),
  }));
  web.setWindowOpenHandler(({ url }) => {
    if (WorkspacePolicy.externalURL(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  web.on("will-navigate", (event, url) => {
    if (server.policy?.isTrusted(url)) return;
    event.preventDefault();
    if (url === "linkshell-retry:" && web.getURL().startsWith("data:")) { void retry(); return; }
    if (WorkspacePolicy.externalURL(url)) void shell.openExternal(url);
  });
  web.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame && !server.policy?.allowsSubframe(details.url)) details.preventDefault();
  });
  web.on("will-redirect", (event, url) => {
    if (!server.policy?.isTrusted(url) && !server.policy?.isPreview(url)) event.preventDefault();
  });
  web.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const trusted = server.policy?.isTrusted(details.requestingUrl) ?? false;
    callback(trusted && ["clipboard-sanitized-write", "clipboard-read", "media", "fullscreen", "notifications"].includes(permission));
  });
  web.session.on("will-download", (_event, item) => {
    const url = item.getURL();
    if (!server.policy || !(server.policy.isTrusted(url) || server.policy.allowsBlob(url) || url.startsWith("data:"))) { item.cancel(); return; }
    item.setSaveDialogOptions({ title: t("save.title"), buttonLabel: t("save.button"), defaultPath: item.getFilename() });
    item.once("done", (_done, state) => {
      if (state === "interrupted" && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: "warning", message: t("save.failed"), detail: t("save.failedDetail") });
    });
  });
  if (!MAC) {
    // Windows and Linux remove the Electron application menu, so wire standard zoom & DevTools shortcuts explicitly.
    web.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || menuShortcutsIgnored) return;
      const ctrlOnly = input.control && !input.alt && !input.meta;
      if (ctrlOnly && !input.shift) {
        if (input.key === "=" || input.key === "+" || input.code === "Equal" || input.code === "NumpadAdd") {
          web.setZoomLevel(Math.min(5, web.getZoomLevel() + 0.5));
          event.preventDefault();
          return;
        }
        if (input.key === "-" || input.key === "_" || input.code === "Minus" || input.code === "NumpadSubtract") {
          web.setZoomLevel(Math.max(-3, web.getZoomLevel() - 0.5));
          event.preventDefault();
          return;
        }
        if (input.key === "0" || input.code === "Digit0" || input.code === "Numpad0") {
          web.setZoomLevel(0);
          event.preventDefault();
          return;
        }
      }
      if (!app.isPackaged && ((ctrlOnly && input.shift && input.key.toLowerCase() === "i") || input.key === "F12")) {
        web.toggleDevTools();
        event.preventDefault();
      }
    });
  }
}

function startServer() {
  if (!window || window.isDestroyed()) return;
  showLoading();
  server.start((url) => {
    if (!window || window.isDestroyed()) return;
    void window.loadURL(url.href).catch((error: Error & { code?: string }) => {
      if (error.code !== "ERR_ABORTED") showProblem(t("problem.open", { message: error.message }));
    });
  }, (message) => showProblem(message));
}

function showLoading() {
  if (!window || window.isDestroyed()) return;
  const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>LinkShell</title><style>
    :root{color-scheme:light dark;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    body{margin:0;height:100vh;display:grid;place-items:center;background:light-dark(#f2f3f6,#090a0c);color:light-dark(rgb(20 21 24/.62),rgb(236 238 242/.62));-webkit-app-region:drag;user-select:none}
    main{display:flex;align-items:center;gap:10px;letter-spacing:-.01em}
    .spinner{width:14px;height:14px;border-radius:999px;border:1.5px solid light-dark(rgb(20 21 24/.16),rgb(236 238 242/.2));border-top-color:light-dark(#4c5fd5,#5263e8);animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.spinner{animation:none;border-color:light-dark(#4c5fd5,#5263e8)}}
  </style><main><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(t("loading"))}</span></main>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
}

function showProblem(message: string) {
  if (!window || window.isDestroyed()) return;
  const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>LinkShell</title><style>
    :root{color-scheme:light dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
    body{margin:0;height:100vh;display:grid;place-items:center;background:transparent;color:light-dark(#1a1c1f,#dfdfdf);-webkit-app-region:drag}
    main{max-width:420px;text-align:center;padding:24px}h1{font-size:16px;font-weight:600;margin:0 0 8px}
    p{margin:0 0 20px;color:light-dark(rgb(26 28 31/.7),rgb(255 255 255/.7))}
    button{-webkit-app-region:no-drag;height:32px;padding:0 12px;border-radius:6px;border:0;font:inherit;font-size:13px;font-weight:500;background:light-dark(#4c5fd5,#5263e8);color:#fff}
    button:hover{background:light-dark(#4254c7,#4d5fe0)}
  </style><main><h1>${escapeHtml(t("problem.title"))}</h1><p></p><button>${escapeHtml(t("problem.retry"))}</button></main>
  <script>document.querySelector("p").textContent=${JSON.stringify(message)};document.querySelector("button").onclick=()=>location.href="linkshell-retry:";</script>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function retry() {
  if (!(await flushOrConfirm(t("flush.reconnect")))) return;
  remotePortProxies.stopAll();
  await server.stop();
  startServer();
}

function showWindow() {
  userRequestedShow = true;
  hideAfterLeaveFullScreen = false;
  if (!window || window.isDestroyed()) return;
  if (MAC) void app.dock?.show();
  if (window.isMinimized()) window.restore();
  if (MAC) window.webContents.focus();
  window.show();
  window.focus();
  setVisible(true);
}

function cameBack<T>(result: T): T {
  app.focus({ steal: true });
  showWindow();
  return result;
}

function onSystemResume() {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined;
    if (quitting) return;
    send("linkshell-desktop-resume", { at: Date.now() });
    updater.maybeAutoCheck();
  }, 500);
}

const pendingCommands = new CommandQueue();
let pageReadyTimer: ReturnType<typeof setTimeout> | undefined;
function clearPageReadyTimer() {
  if (!pageReadyTimer) return;
  clearTimeout(pageReadyTimer);
  pageReadyTimer = undefined;
}
function markPageReady() {
  clearPageReadyTimer();
  if (!window || window.isDestroyed() || !server.policy?.isTrusted(window.webContents.getURL())) return;
  if (!pageReady) {
    pageReady = true;
    updateWindowSurface(true);
    send("linkshell-desktop-window", { fullscreen: isWindowFullScreen() });
  }
  for (const queued of pendingCommands.drain()) send("linkshell-desktop-command", queued);
}
function command(detail: PageCommand) {
  if (pageReady) send("linkshell-desktop-command", detail);
  else pendingCommands.push(detail);
}
function openManagement(page?: string) { command({ command: "manage", ...(page ? { page } : {}) }); }
function openWorkspace() { command({ command: "workspace" }); }
function closeTab() {
  if (!window || window.isDestroyed()) return;
  if (pageReady && server.policy?.isTrusted(window.webContents.getURL())) command({ command: "close-tab" });
  else window.close();
}

// ── Sidecar-first management routing (zero child spawns on warm sidecar) ─────────────────

const ACTION_TIMEOUTS: Record<string, number> = {
  startup: 60_000, start: 45_000, stop: 45_000, restart: 45_000, logout: 60_000, "connect-gateway": 60_000,
  "account-refresh": 60_000, "set-gateway": 60_000, "set-password": 45_000, "remove-password": 45_000,
  "prepare-update": 45_000, "recover-update": 45_000, "stop-update-host": 45_000, pair: 30_000, "pair-qr": 30_000,
};

async function withSidecarFallback<T>(viaSidecar: () => Promise<T>, viaCli: () => Promise<T>): Promise<T> {
  try { return await viaSidecar(); }
  catch (error) {
    if (error instanceof SidecarUnavailableError) return viaCli();
    throw error;
  }
}

async function runManagementAction(name: string, input?: unknown): Promise<Record<string, unknown>> {
  if (!(name in ACTION_TIMEOUTS)) throw new Error("不支持的操作");
  if (name === "logout") {
    return withSidecarFallback(
      async () => {
        await server.logout();
        return (await server.snapshot({ fresh: true })) ?? management.snapshot();
      },
      () => management.action("logout"),
    );
  }
  return withSidecarFallback(
    () => server.action(name, input, ACTION_TIMEOUTS[name]),
    () => (name === "startup" ? management.startup() : management.action(name, input)),
  );
}

// ── IPC: Native invoke + fire-and-forget shell messages ──────────────────────────────────

ipcMain.on("linkshell:boot", (event) => {
  event.returnValue = server.policy?.isTrusted(event.senderFrame?.url)
    ? { appearance: settings.appearance(), visible, platform: process.platform, opaqueWindow: settings.opaqueWindow() }
    : undefined;
});

ipcMain.on("linkshell:fusion-hub", (event, body: unknown) => {
  if (body && typeof body === "object") fusion.fromHubPage(event.sender, body as Record<string, unknown>);
});

ipcMain.handle("linkshell:invoke", async (event, body: unknown) => {
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !frame || !server.policy?.allowsBridge(frame.url, frame === event.sender.mainFrame)) {
    return { ok: false, error: "来源不受信任" };
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const method = typeof payload.method === "string" ? payload.method : "";
  const params = payload.params && typeof payload.params === "object" ? (payload.params as Record<string, unknown>) : {};
  try {
    return { ok: true, result: await handle(method, params) };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
  }
});

ipcMain.on("linkshell:message", (event, body: unknown) => {
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !frame || !server.policy?.allowsBridge(frame.url, frame === event.sender.mainFrame)) return;
  if (!body || typeof body !== "object") return;
  const message = body as Record<string, unknown>;
  switch (message.action) {
    case "manage":
    case "workspace": return;
    case "renderer-ready": markPageReady(); return;
    case "appearance":
      if (WorkspacePolicy.validAppearance(message.value)) {
        const changed = settings.get("appearance") !== message.value;
        settings.set("appearance", message.value);
        if (changed) void settings.save();
        applyAppearance();
        if (changed) trayMenu.updateTray();
      }
      return;
    case "external":
      if (typeof message.url === "string" && WorkspacePolicy.externalURL(message.url)) void shell.openExternal(message.url);
      return;
    case "locale": {
      const next = normalizeMainLocale(message.value);
      if (!next || next === locale) return;
      locale = next;
      settings.set("locale", next);
      void settings.save();
      trayMenu.installMenu();
      trayMenu.updateTray();
      return;
    }
    case "closeWindow": window.close(); return;
    case "focusWindow": cameBack(undefined); return;
    case "notify": trayMenu.notify(message); return;
    case "badge": {
      const count = badgeCount(message.count);
      if (count !== undefined) { try { app.setBadgeCount(count); } catch { /* Unsupported here. */ } }
      return;
    }
    case "contentFocus": return;
    case "screen": {
      if (!MAC || typeof message.id !== "string") return;
      try {
        if (!nativeModule || !runtime.helper) throw new Error("原生屏幕组件不可用，请重新安装 LinkShell");
        const zoom = window.webContents.getZoomFactor();
        const isFiniteRect = (raw: unknown): raw is Record<string, number> =>
          !!raw && typeof raw === "object" && ["x", "y", "width", "height"].every((key) => {
            const val = (raw as Record<string, unknown>)[key];
            return typeof val === "number" && Number.isFinite(val);
          });
        const scaleRect = (raw: Record<string, number>) => ({
          x: raw.x * zoom, y: raw.y * zoom, width: raw.width * zoom, height: raw.height * zoom,
        });
        const adjusted: Record<string, unknown> = { ...message };
        if (isFiniteRect(message.rect)) adjusted.rect = scaleRect(message.rect);
        if (Array.isArray(message.holes)) {
          adjusted.holes = message.holes.slice(0, 64).filter(isFiniteRect).map((hole) => ({
            ...scaleRect(hole),
            ...(typeof hole.radius === "number" && Number.isFinite(hole.radius) && hole.radius >= 0 ? { radius: hole.radius * zoom } : {}),
          }));
        }
        if ("overlayOpen" in message) adjusted.overlayOpen = Boolean(message.overlayOpen);
        if (message.type === "start") {
          if ("audioMuted" in message) adjusted.audioMuted = Boolean(message.audioMuted);
          if ("systemShortcutCapture" in message) adjusted.systemShortcutCapture = Boolean(message.systemShortcutCapture);
          nativeModule.screenStart(window.getNativeWindowHandle(), runtime.helper, adjusted, (detail) => {
            if ((detail as { type?: unknown }).type === "error") setNativeScreenShown(false);
            send("linkshell-native-screen", detail);
          });
          nativeModule.screenVisible(visible);
          setNativeScreenShown(true);
        } else {
          if (message.type === "audio" || message.type === "mute") {
            if ("muted" in message) adjusted.muted = Boolean(message.muted);
            if ("enabled" in message) adjusted.enabled = Boolean(message.enabled);
          }
          nativeModule.screenMessage(adjusted);
          if (message.type === "stop") {
            resetSystemShortcutCapture();
            setNativeScreenShown(false);
          }
        }
      } catch (error) {
        setNativeScreenShown(false);
        send("linkshell-native-screen", { id: message.id, type: "error", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    case "screenKeys":
      if (typeof message.captured === "boolean") {
        menuShortcutsIgnored = message.captured;
        if (!window.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(message.captured);
      }
      return;
    case "screenFullScreen":
      if (window && !window.isDestroyed() && typeof message.enabled === "boolean") {
        wantedFullScreen = message.enabled;
        wantedImmersiveFullScreen = message.enabled && message.immersive === true;
        reconcileFullScreen();
      }
      return;
    case "fusionTunnel": fusion.handleTunnelMessage(message); return;
    case "invoke": return void legacyInvoke(event.sender, message);
  }
});

async function legacyInvoke(sender: WebContents, message: Record<string, unknown>) {
  const id = typeof message.id === "string" ? message.id : undefined;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  if (!id) return;
  let result: unknown;
  let error: string | undefined;
  try { result = await handle(method, params); }
  catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  if (!sender.isDestroyed()) send("linkshell-desktop-reply", { id, result, error });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "snapshot":
      return withSidecarFallback(() => server.request("GET", "/desktop/snapshot", undefined, 10_000), () => management.snapshot());
    case "startup":
      return runManagementAction("startup");
    case "action":
      return runManagementAction(String(params.name ?? ""), params.input);
    case "login":
      return cameBack(await withSidecarFallback(
        async () => { await server.login({ method: "web" }, 350_000); return (await server.snapshot({ fresh: true })) ?? management.snapshot(); },
        () => management.signIn(),
      ));
    case "loginPassword":
      return withSidecarFallback(
        async () => {
          await server.login({ method: "password", email: params.email, password: params.password }, 60_000);
          return (await server.snapshot({ fresh: true })) ?? management.snapshot();
        },
        () => management.signInWithPassword(params.email, params.password),
      );
    case "loginOAuth": {
      const provider = params.provider;
      return cameBack(await withSidecarFallback(
        async () => {
          if (provider !== "github" && provider !== "google") throw new Error("不支持的登录方式");
          await server.login({ method: provider }, 350_000);
          return (await server.snapshot({ fresh: true })) ?? management.snapshot();
        },
        () => management.signInWithProvider(provider, (url) => send("linkshell-desktop-login", { provider, url })),
      ));
    }
    case "cancelLogin":
      management.cancelSignIn();
      await server.cancelLogin().catch(() => undefined);
      return {};
    case "usage": {
      const days = Number(params.days);
      const agent = String(params.agent ?? "all");
      return withSidecarFallback(
        () => server.action("usage", { days, agent }, 125_000),
        () => management.usage(days, agent),
      );
    }
    case "log":
      return withSidecarFallback(
        () => server.log(),
        async () => ({ text: await management.log(runtime.home), path: join(runtime.home, "host.log") }),
      );
    case "revealLog":
      shell.showItemInFolder(join(runtime.home, "host.log"));
      return {};
    case "upgrade":
      if (runtime.standalone) return updater.install();
      await management.exec(["upgrade"], 240_000).catch(() => { throw new Error("更新未完成，请在终端运行 linkshell upgrade 查看详情。"); });
      return { message: "更新完成。重新打开 LinkShell 可加载新版界面。" };
    case "about":
      return {
        version: app.getVersion(), electron: process.versions.electron, standalone: runtime.standalone,
        bundle: runtime.bundle ?? runtime.folder, home: runtime.home, info: await management.standaloneInfo(),
      };
    case "permissions": {
      if (!WINDOWS) return nativeModule?.permissions() ?? { recording: false, control: false, unavailable: true };
      const sharing = !existsSync(screenDisabled());
      const elevatedService = await queryWindowsElevatedService();
      return { recording: sharing, control: sharing, notNeeded: true, sharing, elevatedService };
    }
    case "setScreenSharing": {
      if (!WINDOWS) throw new Error("不支持的操作");
      if (params.enabled === true) rmSync(screenDisabled(), { force: true });
      else { mkdirSync(runtime.home, { recursive: true }); writeFileSync(screenDisabled(), "disabled\n"); }
      return { sharing: params.enabled === true };
    }
    case "setElevatedScreenService": {
      if (!WINDOWS) throw new Error("不支持的操作");
      const elevatedService = await setWindowsElevatedService(params.enabled === true);
      return { elevatedService };
    }
    case "openSetup": return openSetup(params);
    case "loginItem": return nativeModule?.loginItem() ?? { enabled: windowsLoginItem() ?? app.getLoginItemSettings().openAtLogin, approval: false };
    case "setLoginItem": {
      const enabled = params.enabled === true;
      if (nativeModule) { const failed = nativeModule.setLoginItem(enabled); if (failed) throw new Error(`无法修改开机启动：${failed}`); }
      else if (WINDOWS) app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ["--hidden"], name: "LinkShell" });
      else app.setLoginItemSettings({ openAtLogin: enabled });
      return nativeModule?.loginItem() ?? { enabled: windowsLoginItem() ?? enabled, approval: false };
    }
    case "openLoginItems": nativeModule?.openLoginItems(); return {};
    case "installCommand": return { path: await installCommand() };
    case "copyCommandPath": {
      if (!runtime.folder) throw new Error("当前不是 Windows 安装");
      const path = join(runtime.folder, "linkshell.cmd");
      clipboard.writeText(path);
      return { path };
    }
    case "settings": return settings.snapshot();
    case "setSetting": {
      const key = String(params.key ?? "");
      if (!["opaqueWindow", "autoCheck", "updateChannel", "keepAwake", "notifications"].includes(key)) throw new Error("未知设置");
      if (key === "notifications" && typeof params.value !== "boolean") throw new Error("无效的通知设置");
      if (key === "updateChannel" && !["stable", "beta"].includes(String(params.value))) throw new Error("未知更新通道");
      if (key === "updateChannel") updater.assertChannelSwitchAllowed();
      if (key === "keepAwake") {
        if (typeof params.value !== "boolean" && !["smart", "always", "off"].includes(String(params.value))) throw new Error("无效的保持唤醒设置");
        settings.set(key, normalizeKeepAwakeMode(params.value));
      } else {
        settings.set(key, params.value);
      }
      if (key === "updateChannel") updater.beforeChannelSave();
      await settings.save();
      if (key === "opaqueWindow") updateWindowSurface(true);
      if (key === "updateChannel") updater.afterChannelSave(String(params.value));
      return {};
    }
    case "checkUpdates": return updater.check();
    case "updateStatus": return updater.status();
    case "installUpdate": return updater.install();
    case "retry": void retry(); return {};
    case "contextMenu": return trayMenu.contextMenu(params.items, params.at);
    case "openPath": return openPath(params);
    case "reveal": {
      const path = typeof params.path === "string" ? params.path : "";
      if (!isAbsolute(path) || !existsSync(path)) throw new Error("这个位置已经不在了");
      shell.showItemInFolder(path);
      return {};
    }
    case "fusionStart": return fusion.start(params);
    case "fusionState": return fusion.state(params);
    case "fusionIcons": return fusion.icons(params);
    case "fusionLaunchApp": return fusion.control(params, "launchApp");
    case "fusionQuitApp": return fusion.control(params, "quitApp");
    case "fusionStop": return fusion.stop(params);
    case "openRemotePortExternal": return openRemotePortExternal(params);
    case "remotePortReply": return remotePortProxies.reply(params);
    case "setSystemShortcutCapture": return setSystemShortcutCaptureEnabled(params.enabled === true);
    case "startLanDiscovery": mdnsBrowser.start(); mdnsBrowser.refresh(); return mdnsBrowser.getHosts();
    case "stopLanDiscovery": await mdnsBrowser.stop(); return {};
    case "getLanHosts": return mdnsBrowser.getHosts();
    default: throw new Error("不支持的操作");
  }
}

// ── Saving & clean shutdown ──────────────────────────────────────────────────────────────

function flush(): Promise<boolean> {
  return new Promise((resolve) => {
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
    type: "warning" as const, message: t("flush.message"), detail: t("flush.detail"),
    buttons: [t("flush.back"), continuing], defaultId: 0, cancelId: 0,
  };
  const liveWin = window && !window.isDestroyed() ? window : undefined;
  if (liveWin) showWindow();
  const { response } = liveWin ? await dialog.showMessageBox(liveWin, options) : await dialog.showMessageBox(options);
  return response === 1;
}

app.on("before-quit", (event) => {
  if (quitConfirmed) { quitting = true; return; }
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void flushOrConfirm(t("flush.quit")).then(async (confirmed) => {
    if (!confirmed) { quitting = false; return; }
    quitConfirmed = true;
    await shutdownForQuit();
    app.quit();
  });
});

async function shutdownForQuit(): Promise<void> {
  clearTimeout(resumeTimer);
  resumeTimer = undefined;
  clearTimeout(fullScreenRetry);
  fullScreenRetry = undefined;
  clearHungTimer();
  clearPageReadyTimer();
  clearBoundsTimer();
  menuShortcutsIgnored = false;
  resetSystemShortcutCapture();
  nativeModule?.setImmersiveFullScreen(false);
  nativeModule?.screenStop();
  nativeScreenShown = false;
  updater.stop();
  void mdnsBrowser.stop();
  fusion.stopAll();
  remotePortProxies.stopAll();
  trayMenu.stop();
  keepAwake.set(false);
  rememberBounds();
  await Promise.all([settings.save(), server.stop()]);
}

app.on("activate", () => { showWindow(); updater.maybeAutoCheck(); });
app.on("window-all-closed", () => { /* LinkShell stays in the menu bar. */ });
app.on("will-quit", () => keepAwake.set(false));

// ── Native helpers ───────────────────────────────────────────────────────────────────────

async function openPath(params: Record<string, unknown>): Promise<{ ok: boolean }> {
  const path = typeof params.path === "string" ? params.path : "";
  const targetApp = params.app ?? "default";
  if (!isAbsolute(path) || !existsSync(path)) throw new Error("这个位置已经不在了");
  if (!isOpenPathApp(targetApp)) throw new Error("不支持的打开方式");
  const plan = openPathPlan(process.platform, targetApp, path);
  if (plan.kind === "default") {
    const failed = await shell.openPath(path);
    if (failed) throw new Error(failed);
  } else if (plan.kind === "reveal") shell.showItemInFolder(path);
  else if (plan.kind === "url") await shell.openExternal(plan.url);
  else {
    await new Promise<void>((done, fail) => {
      const child = spawn(plan.file, plan.args, { stdio: "ignore", shell: false, windowsHide: true });
      child.once("error", () => fail(new Error("没有找到对应的应用")));
      if (MAC) child.once("exit", (code) => (code === 0 ? done() : fail(new Error("没有找到对应的应用"))));
      else child.once("spawn", () => { child.unref(); done(); });
    });
  }
  return { ok: true };
}

function openSetup(params?: Record<string, unknown>) {
  if (WINDOWS) throw new Error("Windows 不需要单独授权屏幕录制和控制");
  const helper = runtime.bundle;
  if (!helper) throw new Error("开发模式下请从 apps/mac 构建的 LinkShell.app 打开权限引导");
  const requested = params?.permission;
  let target: "recording" | "control";
  if (requested === "recording" || requested === "control") target = requested;
  else {
    const current = nativeModule?.permissions();
    target = current && current.recording && !current.control ? "control" : "recording";
  }
  spawn("/usr/bin/open", ["-n", "-a", helper, "--args", "--guide-permission", target], { stdio: "ignore", detached: true }).unref();
  return {};
}

async function openRemotePortExternal(params: Record<string, unknown>): Promise<{ url: string; localPort: number }> {
  const computerKey = typeof params.computerKey === "string" ? params.computerKey.trim() : "";
  const isLocal = !computerKey || computerKey === "desktop:local";
  const forbiddenPort = isLocal && server.policy ? Number(server.policy.origin.port) : undefined;
  const port = validatePreviewPort(params.port, forbiddenPort);
  const safePath = normalizePreviewSubPath(params.path);
  const localPort = isLocal ? port : await remotePortProxies.ensureProxy(computerKey, port);
  const url = `http://127.0.0.1:${localPort}${safePath}`;
  if (params.open !== false) await shell.openExternal(url);
  return { url, localPort };
}

function screenDisabled() { return join(runtime.home, "windows-screen-disabled"); }

const execFileAsync = promisify(execFile);

interface WindowsElevatedServiceStatus {
  installed: boolean;
  running: boolean;
  authorized: boolean;
  outdated: boolean;
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function queryWindowsElevatedService(): Promise<WindowsElevatedServiceStatus | undefined> {
  if (!WINDOWS || !runtime.helper || !existsSync(runtime.helper)) return undefined;
  try {
    const { stdout } = await execFileAsync(runtime.helper, ["--service-status"], {
      windowsHide: true,
      timeout: 5_000,
      encoding: "utf8",
      env: { ...process.env, LINKSHELL_HOME: runtime.home },
    });
    const parsed = JSON.parse(stdout.trim()) as Partial<WindowsElevatedServiceStatus>;
    return {
      installed: parsed.installed === true,
      running: parsed.running === true,
      authorized: parsed.authorized === true,
      outdated: parsed.outdated === true,
    };
  } catch {
    return undefined;
  }
}

async function currentWindowsUserSid(): Promise<string> {
  const { stdout } = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 5_000,
    encoding: "utf8",
  });
  const match = /"(S-1-[0-9-]+)"/.exec(stdout);
  if (!match?.[1]) throw new Error("无法读取当前 Windows 用户 SID");
  return match[1];
}

async function setWindowsElevatedService(enable: boolean): Promise<WindowsElevatedServiceStatus> {
  const helper = runtime.helper;
  if (!WINDOWS || !helper || !existsSync(helper)) {
    throw new Error("未找到 LinkShell.Screen.exe，请重新安装 Windows 桌面版");
  }
  const cleanHome = runtime.home.replace(/[\\]+$/, "");
  const errFile = join(runtime.home, "windows-service-last-error.txt");
  rmSync(errFile, { force: true });
  const helperArgs = enable
    ? ["--install-service", await currentWindowsUserSid(), cleanHome]
    : ["--uninstall-service", cleanHome];
  const argArray = helperArgs.map(psSingleQuote).join(", ");
  const script = `$p = Start-Process -FilePath ${psSingleQuote(helper)} -ArgumentList @(${argArray}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: 60_000,
      encoding: "utf8",
    });
  } catch (error) {
    let detail = "";
    try {
      if (existsSync(errFile)) detail = readFileSync(errFile, "utf8").trim();
    } catch { /* Ignore unreadable error file. */ }
    if (detail) throw new Error(`系统控制服务操作失败：${detail}`);
    const text = error instanceof Error ? `${error.message} ${String((error as { stderr?: string }).stderr ?? "")}` : String(error);
    if (/canceled by the user|被用户取消|1223/i.test(text)) {
      throw new Error("已取消管理员授权，未更改系统控制服务");
    }
    throw new Error(`系统控制服务操作失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const next = await queryWindowsElevatedService();
  if (!next) throw new Error("无法确认系统控制服务状态，请重试");
  if (enable && (!next.installed || !next.running || !next.authorized)) {
    throw new Error("系统控制服务未能启动，请在管理员权限下重试");
  }
  return next;
}

async function installCommand(): Promise<string> {
  if (runtime.folder) throw new Error(`可直接使用安装目录中的 ${join(runtime.folder, "linkshell.cmd")}`);
  if (!runtime.standalone || !runtime.bundle) throw new Error("当前不是独立 App 安装");
  const { mkdir, readlink, symlink, lstat } = await import("node:fs/promises");
  const directory = join(app.getPath("home"), ".local/bin");
  const link = join(directory, "linkshell");
  const target = join(runtime.bundle, "Contents/MacOS/linkshell-cli");
  await mkdir(directory, { recursive: true });
  const existing = await readlink(link).catch(() => undefined);
  if (existing === target) return link;
  if (existing !== undefined || await lstat(link).then(() => true, () => false)) {
    throw new Error("~/.local/bin/linkshell 已存在，未覆盖。可直接使用 App 内 Contents/MacOS/linkshell-cli。");
  }
  await symlink(target, link);
  return link;
}

function windowsLoginItem(): boolean | undefined {
  if (!WINDOWS) return undefined;
  const info = app.getLoginItemSettings({ path: process.execPath, args: ["--hidden"] });
  return info.launchItems?.some((item) => item.name === "LinkShell" && item.enabled) ?? info.openAtLogin;
}

async function ready() {
  await settings.load();
  locale = normalizeMainLocale(process.env.LINKSHELL_LOCALE) ?? normalizeMainLocale(settings.get("locale")) ?? (/^ja/i.test(app.getLocale()) ? "ja" : /^zh/i.test(app.getLocale()) ? "zh" : app.getLocale() ? "en" : "zh");
  keepAwake.set("off");
  if (launch.home) { settings.set("home", launch.home); void settings.save(); }
  else if (typeof settings.get("home") === "string" && runtime.standalone) process.env.LINKSHELL_HOME = settings.get("home") as string;
  if (WINDOWS && runtime.standalone && !launch.home && !process.env.LINKSHELL_HOME && settings.get("windowsAutoLaunchInitialized") !== true) {
    try {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ["--hidden"], name: "LinkShell" });
    } catch { /* Non-fatal if Group Policy blocks HKCU Run keys. */ }
    settings.set("windowsAutoLaunchInitialized", true);
    void settings.save();
  }
  nativeTheme.themeSource = settings.appearance();
  nativeModule = native(runtime.bundle, app.getAppPath());
  if (MAC && !runtime.bundle) {
    const dockIcon = join(app.getAppPath(), "../mac/assets/icon.png");
    if (existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
  }
  trayMenu.start();
  createWindow();
  nativeTheme.on("updated", updateWindowSurface);
  powerMonitor.on("resume", onSystemResume);
  powerMonitor.on("unlock-screen", onSystemResume);
  updater.start(launch.checkUpdates);
  if (launch.checkUpdates) { openManagement("updates"); updater.check(); }
  if (launch.fusionConnect) command({ command: "fusion", computerKey: launch.fusionConnect, launchBundle: launch.fusionLaunch });
}
