import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { PageCommand } from "./command-queue.js";
import type { MainKey } from "./locale.js";
import { MenuBar, updateFound, updateLabel, type MenuBarEntry, type MenuBarEvent } from "./menubar.js";
import { parseNotification, shouldNotify } from "./notify.js";
import type { Runtime } from "./runtime.js";
import type { SettingsStore } from "./settings-store.js";

export interface TrayMenuDeps {
  mac: boolean;
  windows: boolean;
  runtime: Runtime;
  settings: SettingsStore;
  t: (key: MainKey, params?: Record<string, string | number>) => string;
  getWindow: () => BrowserWindow | undefined;
  isVisible: () => boolean;
  showWindow: () => void;
  openWorkspace: () => void;
  openManagement: (page?: string) => void;
  checkUpdates: () => void;
  closeTab: () => void;
  toggleFullScreen: () => void;
  command: (detail: PageCommand) => void;
}

/**
 * Owns the native macOS MenuBar / Windows Tray, localized Application Menu,
 * Context Menus, and OS Notifications.
 */
export class TrayMenuController {
  private tray?: Tray;
  private menuBar?: MenuBar;
  private updateAvailable?: string;
  private readonly notifications = new Map<string, Notification>();

  constructor(private readonly deps: TrayMenuDeps) {}

  getUpdateAvailable(): string | undefined {
    return this.updateAvailable;
  }

  start(): void {
    const { mac, runtime } = this.deps;
    this.installMenu();
    const iconPath = join(app.getAppPath(), mac ? "assets/trayTemplate.png" : "assets/tray.png");
    if (mac && runtime.bundle) {
      this.menuBar = new MenuBar(runtime.bundle, (event) => this.onMenuBarEvent(event), (message) => console.error(message));
      this.menuBar.start();
      this.updateTray();
    } else if (existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath);
      if (mac) icon.setTemplateImage(true);
      this.tray = new Tray(icon);
      this.tray.setToolTip("LinkShell");
      if (!mac) this.tray.on("click", () => this.deps.showWindow());
      this.updateTray();
    }
  }

  stop(): void {
    this.menuBar?.stop();
  }

  noteUpdate(name: string, version?: unknown): void {
    const next = updateFound(this.updateAvailable, name, version);
    if (next === this.updateAvailable) return;
    this.updateAvailable = next;
    this.updateTray();
  }

  private trayItems(): MenuBarEntry[] {
    const { t } = this.deps;
    return [
      { id: "open", label: t("tray.open") },
      { id: "manage", label: t("tray.settings") },
      { id: "update", label: updateLabel(this.updateAvailable, { check: t("update.check"), to: (version) => t("update.to", { version }), found: t("update.found") }) },
      { separator: true },
      { id: "quit", label: t("menu.quit") },
    ];
  }

  private trayClicked(id: string): void {
    if (id === "open") { this.deps.openWorkspace(); this.deps.showWindow(); }
    else if (id === "manage") { this.deps.openManagement("settings"); this.deps.showWindow(); }
    else if (id === "update") { this.deps.openManagement("updates"); this.deps.showWindow(); if (this.updateAvailable === undefined) this.deps.checkUpdates(); }
    else if (id === "quit") app.quit();
  }

  updateTray(): void {
    const items = this.trayItems();
    this.menuBar?.show("LinkShell", items);
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(items.map((entry): MenuItemConstructorOptions =>
      "separator" in entry ? { type: "separator" } : { label: entry.label, click: () => this.trayClicked(entry.id) })));
  }

  private onMenuBarEvent(event: MenuBarEvent): void {
    if (event.t === "click" && event.id === "quit") { app.quit(); return; }
    app.focus({ steal: true });
    if (event.t === "click") this.trayClicked(event.id);
    else this.deps.showWindow();
  }

  installMenu(): void {
    const { mac, t } = this.deps;
    if (!mac) { Menu.setApplicationMenu(null); return; }
    const template: MenuItemConstructorOptions[] = [
      { label: "LinkShell", submenu: [
        { label: t("menu.about"), role: "about" },
        { type: "separator" },
        { label: t("menu.settings"), accelerator: "CmdOrCtrl+,", click: () => { this.deps.openManagement("settings"); this.deps.showWindow(); } },
        { label: t("menu.checkUpdates"), click: () => { this.deps.openManagement("updates"); this.deps.showWindow(); this.deps.checkUpdates(); } },
        { type: "separator" },
        { label: t("menu.hide"), role: "hide" },
        { label: t("menu.hideOthers"), role: "hideOthers" },
        { label: t("menu.showAll"), role: "unhide" },
        { type: "separator" },
        { label: t("menu.closeTab"), accelerator: "CmdOrCtrl+W", click: () => this.deps.closeTab() },
        { label: t("menu.quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ] },
      { label: t("menu.edit"), submenu: [
        { label: t("menu.undo"), role: "undo" }, { label: t("menu.redo"), role: "redo" }, { type: "separator" },
        { label: t("menu.cut"), role: "cut" }, { label: t("menu.copy"), role: "copy" }, { label: t("menu.paste"), role: "paste" },
        { label: t("menu.pasteMatch"), role: "pasteAndMatchStyle" }, { label: t("menu.selectAll"), role: "selectAll" },
      ] },
      { label: t("menu.view"), submenu: [
        { label: t("menu.resetZoom"), role: "resetZoom" }, { label: t("menu.zoomIn"), role: "zoomIn" }, { label: t("menu.zoomOut"), role: "zoomOut" },
        { type: "separator" },
        { label: t("menu.fullScreen"), accelerator: "Ctrl+Command+F", click: () => this.deps.toggleFullScreen() },
        ...(app.isPackaged ? [] : [{ type: "separator" as const }, { label: t("menu.devTools"), role: "toggleDevTools" as const }]),
      ] },
      { label: t("menu.window"), role: "windowMenu", submenu: [
        { label: t("menu.minimize"), role: "minimize" }, { label: t("menu.zoom"), role: "zoom" }, { type: "separator" }, { label: t("menu.front"), role: "front" },
      ] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  contextMenu(raw: unknown, at: unknown): Promise<{ id?: string }> {
    return new Promise((resolve) => {
      const win = this.deps.getWindow();
      let count = 0;
      const build = (items: unknown, depth: number): MenuItemConstructorOptions[] =>
        (Array.isArray(items) ? items : []).flatMap((item): MenuItemConstructorOptions[] => {
          if (!item || typeof item !== "object" || ++count > 80) return [];
          const entry = item as Record<string, unknown>;
          if (entry.type === "separator") return [{ type: "separator" }];
          const label = typeof entry.label === "string" ? entry.label.slice(0, 120).replaceAll("&", "&&") : "";
          if (!label) return [];
          const enabled = entry.enabled !== false;
          const accelerator = typeof entry.accelerator === "string" ? entry.accelerator : undefined;
          if (Array.isArray(entry.submenu) && depth < 2) return [{ label, enabled, submenu: build(entry.submenu, depth + 1) }];
          const id = typeof entry.id === "string" ? entry.id : undefined;
          return [{
            label,
            enabled: enabled && !!id,
            ...(typeof entry.checked === "boolean" ? { type: "checkbox" as const, checked: entry.checked } : {}),
            ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
            click: () => resolve({ id }),
          }];
        });
      const template = build(raw, 0);
      if (!template.length || !win) return resolve({});
      const point = at && typeof at === "object" ? (at as { x?: unknown; y?: unknown }) : {};
      const zoom = win.webContents.getZoomFactor();
      const position = typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
        : {};
      Menu.buildFromTemplate(template).popup({ window: win, ...position, callback: () => setTimeout(() => resolve({}), 100) });
    });
  }

  notify(message: Record<string, unknown>): void {
    const request = parseNotification(message);
    if (!request) return;
    const win = this.deps.getWindow();
    const focused = !!win && !win.isDestroyed() && win.isFocused();
    if (!shouldNotify({ supported: Notification.isSupported(), enabled: this.deps.settings.notifications(), focused, visible: this.deps.isVisible() })) {
      return;
    }
    this.notifications.get(request.id)?.close();
    const shown = new Notification({ title: request.title, body: request.body, silent: false });
    this.notifications.set(request.id, shown);
    const forget = () => { if (this.notifications.get(request.id) === shown) this.notifications.delete(request.id); };
    shown.on("click", () => {
      forget();
      this.deps.showWindow();
      this.deps.command({ command: "open-session", computerKey: request.computerKey, sessionId: request.sessionId });
    });
    shown.on("close", forget);
    shown.show();
    if (this.deps.mac) app.dock?.bounce("informational");
    else if (this.deps.windows && win && !win.isDestroyed()) win.flashFrame(true);
  }
}
