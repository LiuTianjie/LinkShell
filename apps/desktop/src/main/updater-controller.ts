import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { net } from "electron";
import type { MainKey, MainLocale } from "./locale.js";
import { localizeUpdaterMessage } from "./locale.js";
import { macUpdatePreparation } from "./mac-update-preparation.js";
import type { NativeModule } from "./native.js";
import type { Runtime } from "./runtime.js";
import type { SettingsStore } from "./settings-store.js";
import { AUTO_UPDATE_CHECK_COOLDOWN_MS, PERIODIC_UPDATE_CHECK_INTERVAL_MS, shouldAutoCheckUpdates } from "./update-policy.js";
import {
  checkWindowsRelease,
  cleanWindowsUpdateDownloads,
  compareVersions,
  downloadWindowsInstaller,
  verifyInstaller,
  type DownloadedInstaller,
  type WindowsRelease,
} from "./windows-update.js";

export interface UpdateState {
  checking: boolean;
  installing: boolean;
  available: boolean;
  message: string;
  version?: string;
  checkedAt?: number;
}

export interface UpdaterDeps {
  mac: boolean;
  windows: boolean;
  runtime: Runtime;
  settings: SettingsStore;
  appVersion: () => string;
  userData: () => string;
  getLocale: () => MainLocale;
  t: (key: MainKey, params?: Record<string, string | number>) => string;
  getNative: () => NativeModule | undefined;
  runHostAction: (name: string) => Promise<unknown>;
  send: (name: string, detail: unknown) => void;
  noteUpdate: (name: string, version?: unknown) => void;
  getUpdateAvailable: () => string | undefined;
  flush: () => Promise<boolean>;
  flushOrConfirm: (continuing: string) => Promise<boolean>;
  rememberBounds: () => void;
  quitForUpdate: () => Promise<void>;
}

/**
 * Unifies macOS Sparkle updates and Windows GitHub Releases updates (x64 & arm64) behind
 * one clean controller, ensuring drafts, bounds, and sidecar flush cleanly before relaunch.
 */
export class UpdaterController {
  private windowsUpdate: UpdateState = { checking: false, installing: false, available: false, message: "" };
  private windowsInstaller?: WindowsRelease;
  private windowsDownloaded?: DownloadedInstaller;
  private windowsInstallerChild?: ChildProcess;
  private macUpdate: UpdateState = { checking: false, installing: false, available: false, message: "" };
  private lastUpdateCheck = 0;
  private cleanTimer?: ReturnType<typeof setTimeout>;
  private initialCheckTimer?: ReturnType<typeof setTimeout>;
  private periodicCheckTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: UpdaterDeps) {}

  stop(): void {
    if (this.cleanTimer) { clearTimeout(this.cleanTimer); this.cleanTimer = undefined; }
    if (this.initialCheckTimer) { clearTimeout(this.initialCheckTimer); this.initialCheckTimer = undefined; }
    if (this.periodicCheckTimer) { clearInterval(this.periodicCheckTimer); this.periodicCheckTimer = undefined; }
  }

  private windowsUpdateCache(): string {
    return join(this.deps.userData(), "windows-updates", this.deps.runtime.scope);
  }

  private isBusy(): boolean {
    return this.deps.windows
      ? this.windowsUpdate.checking || this.windowsUpdate.installing
      : this.macUpdate.checking || this.macUpdate.installing;
  }

  private emitWindowsEvent(detail: { name: string; message?: string; version?: string }): void {
    const { name, message, version } = detail;
    this.windowsUpdate = {
      ...this.windowsUpdate,
      ...(message === undefined ? {} : { message }),
      ...(version === undefined ? {} : { version }),
    };
    if (name === "checking") this.windowsUpdate.checking = true;
    if (name === "available" || name === "current") {
      this.windowsUpdate.available = name === "available";
      this.windowsUpdate.checkedAt = Date.now();
    }
    if (name === "current") this.windowsUpdate.version = undefined;
    if (name === "installing") this.windowsUpdate.installing = true;
    if (name === "finished") {
      this.windowsUpdate.checking = false;
      this.windowsUpdate.installing = false;
    }
    this.deps.noteUpdate(name, version);
    this.deps.send("linkshell-desktop-update", detail);
  }

  private recordMacEvent(name: string, detail: Record<string, unknown>, message: unknown): void {
    const nextMessage = typeof message === "string" ? message : this.macUpdate.message;
    const nextVersion = typeof detail.version === "string" ? detail.version : this.macUpdate.version;
    this.macUpdate = { ...this.macUpdate, message: nextMessage, version: nextVersion };
    if (name === "checking") this.macUpdate.checking = true;
    if (name === "available" || name === "current") {
      this.macUpdate.available = name === "available";
      this.macUpdate.checkedAt = Date.now();
    }
    if (name === "current") this.macUpdate.version = undefined;
    if (name === "installing") this.macUpdate.installing = true;
    if (name === "finished") {
      this.macUpdate.checking = false;
      this.macUpdate.installing = false;
    }
  }

  assertChannelSwitchAllowed(): void {
    if (this.isBusy()) {
      throw new Error("更新正在进行，请稍后再切换通道");
    }
  }

  beforeChannelSave(): void {
    if (!this.deps.windows) return;
    this.windowsInstaller = undefined;
    this.emitWindowsEvent({ name: "current", message: this.deps.t("win.channel") });
  }

  afterChannelSave(channel: string): void {
    if (this.deps.mac) {
      this.macUpdate = { checking: false, installing: false, available: false, message: this.deps.t("win.channel") };
      this.deps.noteUpdate("current");
    }
    this.deps.getNative()?.updaterChannel(channel);
  }

  status(): UpdateState | undefined {
    const { windows, mac, runtime, t } = this.deps;
    if (windows && runtime.standalone) return this.windowsUpdate;
    if (mac && runtime.standalone && (this.macUpdate.checking || this.macUpdate.installing || this.macUpdate.available || this.macUpdate.checkedAt)) {
      return this.macUpdate;
    }
    const available = this.deps.getUpdateAvailable();
    if (mac && runtime.standalone && available !== undefined) {
      return {
        checking: false,
        installing: false,
        available: true,
        ...(available ? { version: available } : {}),
        message: available ? t("mac.available", { version: available }) : t("update.found").replace(/…$/, ""),
      };
    }
    return undefined;
  }

  start(launchCheckUpdates: boolean): void {
    const { windows, runtime, settings, t } = this.deps;
    if (windows && runtime.standalone) {
      void cleanWindowsUpdateDownloads(this.windowsUpdateCache());
      this.cleanTimer = setTimeout(() => { this.cleanTimer = undefined; void cleanWindowsUpdateDownloads(this.windowsUpdateCache()); }, 60_000);
      this.cleanTimer.unref();
      if (!launchCheckUpdates) {
        this.initialCheckTimer = setTimeout(() => { this.initialCheckTimer = undefined; this.maybeAutoCheck(); }, 3_000);
        this.initialCheckTimer.unref();
      }
      this.periodicCheckTimer = setInterval(() => this.maybeAutoCheck(PERIODIC_UPDATE_CHECK_INTERVAL_MS), 60_000);
      this.periodicCheckTimer.unref();
      return;
    }
    const native = this.deps.getNative();
    if (!native || !runtime.standalone) return;
    const prepare = macUpdatePreparation({
      prepare: async () => {
        await this.deps.flush().catch(() => undefined);
        this.deps.rememberBounds();
        await settings.save();
        return this.deps.runHostAction("prepare-update");
      },
      recover: () => this.deps.runHostAction("recover-update"),
      resume: () => this.deps.getNative()?.updaterPrepared(),
      text: {
        paused: (why) => t("mac.paused", { message: why }),
        recover: (why) => t("mac.recoverSentence", { message: why }),
        get retry() { return t("mac.retry"); },
      },
      failed: (message) => {
        this.recordMacEvent("message", {}, message);
        this.recordMacEvent("finished", {}, undefined);
        this.deps.send("linkshell-desktop-update", { name: "message", message });
        this.deps.send("linkshell-desktop-update", { name: "finished" });
      },
    });
    native.updaterStart({
      event: (name, detail) => {
        if (name === "prepare") {
          void prepare();
          return;
        }
        if (name === "recover") {
          void this.deps.runHostAction("recover-update").catch((error: unknown) => {
            this.deps.send("linkshell-desktop-update", {
              name: "message",
              message: t("mac.recover", { message: error instanceof Error ? error.message : String(error) }),
            });
          });
        }
        const localizedMessage = "message" in detail ? localizeUpdaterMessage(this.deps.getLocale(), detail.message) : undefined;
        this.recordMacEvent(name, detail, localizedMessage);
        this.deps.noteUpdate(name, detail?.version);
        this.deps.send("linkshell-desktop-update", { name, ...detail, ...("message" in detail ? { message: localizedMessage } : {}) });
      },
    }, settings.updateChannel());
    if (!launchCheckUpdates) {
      this.initialCheckTimer = setTimeout(() => { this.initialCheckTimer = undefined; this.maybeAutoCheck(); }, 3_000);
      this.initialCheckTimer.unref();
    }
    this.periodicCheckTimer = setInterval(() => this.maybeAutoCheck(PERIODIC_UPDATE_CHECK_INTERVAL_MS), 60_000);
    this.periodicCheckTimer.unref();
  }

  check(): { started: boolean } {
    this.lastUpdateCheck = Date.now();
    if (this.deps.windows && this.deps.runtime.standalone) {
      void this.checkWindows();
      return { started: true };
    }
    const native = this.deps.getNative();
    if (!native || !this.deps.runtime.standalone) return { started: false };
    native.updaterCheck();
    return { started: true };
  }

  maybeAutoCheck(cooldownMs = AUTO_UPDATE_CHECK_COOLDOWN_MS): void {
    if (!shouldAutoCheckUpdates({
      enabled: this.deps.settings.autoCheck(),
      standalone: this.deps.runtime.standalone,
      busy: this.isBusy(),
      lastCheckAt: this.lastUpdateCheck,
      now: Date.now(),
      cooldownMs,
    })) return;
    this.check();
  }

  install(): unknown {
    if (this.deps.windows) return this.downloadWindows();
    this.deps.getNative()?.updaterInstall();
    return {};
  }

  private async checkWindows(): Promise<void> {
    if (this.windowsUpdate.checking || this.windowsUpdate.installing) return;
    const { t } = this.deps;
    this.emitWindowsEvent({ name: "checking", message: t("win.checking") });
    try {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const release = await checkWindowsRelease((url, init) => net.fetch(url, init), this.deps.settings.updateChannel() === "beta", arch);
      this.windowsInstaller = release && compareVersions(release.version, this.deps.appVersion()) > 0 ? release : undefined;
      if (this.windowsInstaller) {
        this.emitWindowsEvent({
          name: "available",
          version: this.windowsInstaller.version,
          message: t("win.available", { version: this.windowsInstaller.version }),
        });
      } else {
        this.emitWindowsEvent({ name: "current", message: release ? t("win.current") : t("win.none") });
      }
    } catch (error) {
      this.emitWindowsEvent({
        name: "message",
        message: t("win.checkFailed", { message: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      this.emitWindowsEvent({ name: "finished" });
    }
  }

  private async launchWindowsInstaller(download: DownloadedInstaller): Promise<void> {
    const folder = this.deps.runtime.folder;
    if (!folder) throw new Error("当前不是 Windows 独立安装");
    if (this.windowsInstallerChild?.pid && this.windowsInstallerChild.exitCode === null) {
      throw new Error("安装程序仍在运行，请先回到安装窗口继续或关闭它");
    }
    const { readFile, rm } = await import("node:fs/promises");
    const ready = join(download.directory, "ready");
    const home = resolve(this.deps.runtime.home);
    await rm(ready, { force: true });
    const child = spawn(download.path, ["--update", "--wait-pid", String(process.pid), "--target", folder, "--home", home, "--ready", ready], {
      detached: true,
      stdio: "ignore",
      cwd: download.directory,
      env: { ...process.env, LINKSHELL_HOME: home },
    });
    this.windowsInstallerChild = child;
    let failed: Error | undefined;
    const onError = (error: Error) => { failed = error; };
    child.on("error", onError);
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (failed) throw failed;
        if (child.exitCode !== null) throw new Error("安装程序已退出，请重试更新");
        const acknowledged = Number(await readFile(ready, "utf8").catch(() => ""));
        if (child.pid && acknowledged === child.pid) { child.unref(); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("安装程序未能就绪，LinkShell 保持运行；请关闭安装窗口后重试");
    } finally {
      child.removeListener("error", onError);
    }
  }

  private downloadWindows(): { started: boolean } {
    const { windows, runtime, t } = this.deps;
    if (!windows || !runtime.folder) throw new Error("当前不是 Windows 独立安装");
    if (!this.windowsInstaller) throw new Error("请先检查更新");
    if (this.windowsInstallerChild?.pid && this.windowsInstallerChild.exitCode === null) {
      throw new Error("安装程序仍在运行，请先回到安装窗口继续或关闭它");
    }
    if (this.windowsUpdate.checking || this.windowsUpdate.installing) return { started: false };
    const release = this.windowsInstaller;
    this.emitWindowsEvent({ name: "installing", message: t("win.downloading") });
    void (async () => {
      try {
        if (this.windowsDownloaded?.version !== release.version) {
          if (this.windowsDownloaded) {
            await import("node:fs/promises").then(({ rm }) => rm(this.windowsDownloaded!.directory, { recursive: true, force: true }));
          }
          this.windowsDownloaded = undefined;
          this.windowsDownloaded = await downloadWindowsInstaller(
            release,
            this.windowsUpdateCache(),
            (url, init) => net.fetch(url, init),
            (received, total) => {
              this.emitWindowsEvent({
                name: "message",
                message: t("win.progress", {
                  percent: Math.floor((received / total) * 100),
                  received: (received / 1048576).toFixed(1),
                  total: (total / 1048576).toFixed(1),
                }),
              });
            },
          );
        }
        this.emitWindowsEvent({ name: "message", message: t("win.downloaded") });
        if (!(await this.deps.flushOrConfirm(t("flush.install")))) {
          this.emitWindowsEvent({ name: "message", message: t("win.postponed") });
          return;
        }
        await verifyInstaller(this.windowsDownloaded);
        this.emitWindowsEvent({ name: "message", message: t("win.launching") });
        await this.launchWindowsInstaller(this.windowsDownloaded);
        await this.deps.quitForUpdate();
      } catch (error) {
        if (this.windowsDownloaded && (!this.windowsInstallerChild?.pid || this.windowsInstallerChild.exitCode !== null)) {
          const failed = this.windowsDownloaded;
          this.windowsDownloaded = undefined;
          await import("node:fs/promises").then(({ rm }) => rm(failed.directory, { recursive: true, force: true })).catch(() => undefined);
        }
        this.emitWindowsEvent({
          name: "message",
          message: t("win.failed", { message: error instanceof Error ? error.message : String(error) }),
        });
      } finally {
        this.emitWindowsEvent({ name: "finished" });
      }
    })();
    return { started: true };
  }
}
