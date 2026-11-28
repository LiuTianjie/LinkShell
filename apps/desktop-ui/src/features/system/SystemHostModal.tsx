import { useEffect, useId, useState, type ReactElement } from "react";
import { useStore } from "zustand";
import { LOCALE_LABELS, type LocalePreference } from "@linkshell/client-core";
import {
  DESKTOP_APPEARANCE_EVENT,
  gatewayDeployment,
  getShellAppearance,
  hasDesktopSidecar,
  setAppearanceBridge,
} from "../../bridge/desktop-bridge";
import {
  MANAGE_PAGES,
  STORAGE_KEYS,
  accountAction,
  cancelLogin,
  engine,
  healthy as isHealthy,
  managementStore,
  newVersion as hasNewVersion,
  pollManagement,
  readLocal,
  refreshManagement,
  revokePairedDevice,
  routerStore,
  saveLocal,
  serviceAction,
  setAccessPassword,
  upgradeInstall,
  useI18n,
  useManagement,
  useRouter,
  type ManagePage,
} from "../../core";
import { DesktopIcon, type DesktopIconName } from "../../icons";
import {
  AlertDialog,
  Button,
  Dialog,
  DialogHeader,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
  StatusDot,
  Tab,
  TabList,
  Tabs,
} from "../../primitives";
import { applyDesktopAppearance, type ThemeMode } from "../../theme";
import { SystemDevicesPage } from "./SystemDevicesPage";
import { SystemLogPage } from "./SystemLogPage";
import {
  SystemOverviewPage,
  type SystemConfirmAction,
} from "./SystemOverviewPage";
import { SystemPasswordPage } from "./SystemPasswordPage";
import { SystemSettingsPage } from "./SystemSettingsPage";
import { SystemUpdatesPage } from "./SystemUpdatesPage";
import { SystemUsagePage } from "./SystemUsagePage";
import { useSystemI18n } from "./system-i18n";

const PAGE_ICONS: Record<ManagePage, DesktopIconName> = {
  overview: "host-daemon",
  devices: "phone-device",
  password: "lock",
  usage: "usage-meter",
  log: "file-text",
  updates: "download",
  settings: "settings",
};

/**
 * Non-unmounting Unified System & Host Control Modal (`960×680`, `#7` §3.2, `#18`):
 * Opens over the active workspace (`routerStore` `systemModal`) so inspecting logs,
 * pairing phones, checking usage, or updating settings never unmounts active sessions,
 * xterm terminals, diffs, or Fusion windows.
 */
function readBrowserAppearanceMode(): ThemeMode {
  const fromShell = getShellAppearance();
  if (fromShell === "light" || fromShell === "dark" || fromShell === "system") {
    return fromShell;
  }
  const saved = readLocal<string>(STORAGE_KEYS.appearance, "system");
  return saved === "light" || saved === "dark" ? saved : "system";
}

function BrowserPreferencesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const { preference, setPreference, ts } = useSystemI18n();
  const { t } = useI18n();
  const titleId = useId();
  const accountEmail = useStore(engine.state, (s) => s.account);
  const accountUserId = useStore(engine.state, (s) => s.accountUserId);
  const gatewayUrl = useStore(engine.state, (s) => s.gateway);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readBrowserAppearanceMode);

  useEffect(() => {
    const syncAppearance = () => setThemeMode(readBrowserAppearanceMode());
    window.addEventListener(DESKTOP_APPEARANCE_EVENT, syncAppearance);
    return () =>
      window.removeEventListener(DESKTOP_APPEARANCE_EVENT, syncAppearance);
  }, []);

  const handleThemeChange = (next: ThemeMode) => {
    setThemeMode(next);
    saveLocal(STORAGE_KEYS.appearance, next);
    applyDesktopAppearance(next);
    setAppearanceBridge(next);
  };

  const selfHosted = gatewayDeployment() === "self-hosted";
  const signedIn = Boolean(accountEmail || accountUserId);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      size="md"
      dismissible
      unmountWhenClosed
      aria-labelledby={titleId}
    >
      <DialogHeader onClose={onClose} closeLabel={ts("modal.close")}>
        <DialogTitle id={titleId}>{t("desktop.shell.browserPreferences")}</DialogTitle>
      </DialogHeader>

      <div className="ls-system-stack" style={{ padding: "0 20px 20px" }}>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name={selfHosted ? "gateway-relay" : "user"} size="sm" />
                {selfHosted
                  ? t("desktop.shell.gateway")
                  : signedIn
                    ? (accountEmail ?? accountUserId)
                    : ts("overview.notSignedIn")}
              </span>
              <span className="ls-system-row__detail">{gatewayUrl}</span>
            </div>
            <div className="ls-system-row__controls">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onClose();
                  routerStore.getState().setConnectModalOpen(true);
                }}
              >
                {t("desktop.fleet.connectComputer")}
              </Button>
            </div>
          </div>
        </div>

        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="globe" size="sm" />
                {ts("settings.language")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Select
                size="sm"
                ariaLabel={ts("settings.language")}
                value={preference}
                onValueChange={(next) => setPreference(next as LocalePreference)}
                options={[
                  { value: "system", label: ts("settings.languageSystem") },
                  { value: "zh", label: LOCALE_LABELS.zh },
                  { value: "en", label: LOCALE_LABELS.en },
                  { value: "ja", label: LOCALE_LABELS.ja },
                ]}
              />
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon
                  name={themeMode === "dark" ? "moon" : "sun"}
                  size="sm"
                />
                {ts("settings.theme")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Tabs
                value={themeMode}
                variant="segmented"
                onValueChange={(next) => handleThemeChange(next as ThemeMode)}
              >
                <TabList label={ts("settings.theme")}>
                  <Tab value="system">{ts("settings.themeSystem")}</Tab>
                  <Tab value="light">{ts("settings.themeLight")}</Tab>
                  <Tab value="dark">{ts("settings.themeDark")}</Tab>
                </TabList>
              </Tabs>
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="command" size="sm" />
                {t("desktop.shortcuts")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onClose();
                  routerStore.getState().setShortcutSheetOpen(true);
                }}
              >
                ?
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function SystemHostModal(): ReactElement {
  const { ts, tm, pageTitle, computer } = useSystemI18n();
  const { open, page } = useRouter((s) => s.systemModal);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const state = useManagement();
  const browserOnly =
    !hasDesktopSidecar() &&
    !localComputer &&
    !state.snapshot &&
    !state.starting &&
    !state.problem;
  const healthy = isHealthy(state);
  // A hung Host (pid alive, socket silent) is recovered by restarting it; starting would only
  // spawn a second daemon beside it.
  const hostProcess = state.snapshot?.status === "running" || state.snapshot?.status === "unreachable";
  const stopped = state.snapshot?.status === "stopped";
  const newVersion = hasNewVersion(state);
  const titleId = useId();
  const descId = useId();

  const [confirmAction, setConfirmAction] = useState<SystemConfirmAction | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || browserOnly) {
      setConfirmAction(null);
      setActionError(null);
      return undefined;
    }
    return pollManagement();
  }, [browserOnly, open]);

  const navigatePage = (nextPage: ManagePage) => {
    setActionError(null);
    routerStore.getState().openSystemModal(nextPage);
  };

  const closeModal = () => {
    if (state.signingIn) cancelLogin();
    routerStore.getState().closeSystemModal();
  };

  const machineName =
    state.snapshot?.machine?.hostname.replace(/\.local$/i, "") ?? computer;
  const hostVer = state.snapshot?.machine?.hostVersion;
  const homePath = state.about?.home ?? state.snapshot?.home ?? "~/.linkshell";

  const serviceStatusText = state.problem
    ? ts("status.unknown")
    : state.snapshot?.status === "running"
      ? ts("status.running")
      : state.snapshot?.status === "stopped"
        ? ts("status.stopped")
        : state.snapshot?.status === "unreachable"
          ? ts("status.unreachable")
          : ts("status.connecting");

  const headerSubtitle =
    page === "overview"
      ? hostVer
        ? `Host ${hostVer}`
        : undefined
      : page === "usage"
        ? ts("usage.subtitle")
        : page === "log"
          ? `${ts("log.autoRefreshHint")} · ${state.logPath ?? `${homePath}/host.log`}`
          : undefined;

  const confirmCopy = confirmAction
    ? {
        stop: {
          title: ts("confirm.stopTitle"),
          desc: ts("confirm.stopDesc"),
          action: ts("confirm.stopAction"),
        },
        restart: {
          title: ts("confirm.restartTitle"),
          desc: ts("confirm.restartDesc"),
          action: ts("confirm.restartAction"),
        },
        logout: {
          title: ts("confirm.logoutTitle"),
          desc: ts("confirm.logoutDesc"),
          action: ts("confirm.logoutAction"),
        },
        "remove-password": {
          title: ts("confirm.removePasswordTitle"),
          desc: ts("confirm.removePasswordDesc"),
          action: ts("confirm.removePasswordAction"),
        },
        upgrade: {
          title: ts("confirm.upgradeTitle"),
          desc: ts("confirm.upgradeDesc"),
          action: ts("confirm.upgradeAction"),
        },
        "revoke-device": {
          title: ts("confirm.revokeDeviceTitle", {
            name:
              confirmAction.kind === "revoke-device"
                ? confirmAction.deviceName
                : "",
          }),
          desc: ts("confirm.revokeDeviceDesc"),
          action: ts("confirm.revokeDeviceAction"),
        },
      }[confirmAction.kind]
    : null;

  const executeConfirmedAction = async () => {
    if (!confirmAction || confirmBusy) return;
    setConfirmBusy(true);
    setActionError(null);
    const prevProblem = managementStore.getState().problem;
    try {
      let ok: boolean | void = true;
      switch (confirmAction.kind) {
        case "stop":
          ok = await serviceAction("stop");
          break;
        case "restart":
          ok = await serviceAction("restart");
          break;
        case "logout":
          ok = await accountAction("logout");
          break;
        case "remove-password":
          ok = await setAccessPassword(null);
          break;
        case "upgrade":
          ok = await upgradeInstall();
          break;
        case "revoke-device":
          ok = await revokePairedDevice(confirmAction.deviceId);
          break;
      }
      const next = managementStore.getState();
      const failure =
        next.problem && next.problem !== prevProblem
          ? next.problem
          : ok === false
            ? (next.problem ?? (next.passwordIsError ? next.passwordMessage : undefined))
            : undefined;
      if (failure) setActionError(tm(failure));
      setConfirmAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setConfirmAction(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  if (browserOnly) {
    return <BrowserPreferencesDialog open={open} onClose={closeModal} />;
  }

  if (browserOnly) {
    return <BrowserPreferencesDialog open={open} onClose={closeModal} />;
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeModal();
        }}
        size="system"
        dismissible={!state.signingIn}
        preventDismiss={Boolean(confirmAction)}
        unmountWhenClosed
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="ls-system-dialog"
      >
        <h2 id={titleId} className="ls-sr-only">
          {ts("modal.srTitle", { page: pageTitle(page) })}
        </h2>
        <p id={descId} className="ls-sr-only">
          {ts("modal.srDesc")}
        </p>

        <div className="ls-system-modal-shell">
          {/* Left Navigation Rail (`.management-nav-item` preserved for E2E!) */}
          <aside className="ls-system-rail" aria-label={ts("nav.settings")}>
            <div className="ls-system-machine-card">
              <StatusDot
                size="md"
                tone={
                  healthy
                    ? "ok"
                    : state.snapshot?.status === "unreachable"
                      ? "danger"
                      : "offline"
                }
              />
              <div className="ls-system-machine-copy">
                <strong title={machineName}>{machineName}</strong>
                <span>{ts("modal.serviceStatus", { status: serviceStatusText })}</span>
              </div>
            </div>

            <nav className="ls-system-nav" aria-label={ts("nav.settings")}>
              {MANAGE_PAGES.map((id, index) => {
                const active = page === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className="ls-system-nav-item management-nav-item"
                    data-active={active ? "true" : undefined}
                    data-gap={index === 5 ? "true" : undefined}
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigatePage(id)}
                  >
                    <DesktopIcon name={PAGE_ICONS[id]} size="sm" />
                    <span className="ls-system-nav-label">{pageTitle(id)}</span>
                    {id === "updates" && newVersion ? (
                      <span className="ls-system-nav-dot" aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Right Content Pane */}
          <div className="ls-system-pane">
            <header className="ls-system-header">
              <div className="ls-system-header__titles">
                <h3 className="ls-system-header__title">{pageTitle(page)}</h3>
                {headerSubtitle ? (
                  <span className="ls-system-header__subtitle">
                    {headerSubtitle}
                  </span>
                ) : null}
              </div>

              <div className="ls-system-header__actions">
                {state.busy ? <DesktopIcon name="spinner" size="sm" /> : null}
                <Menu
                  placement="bottom-end"
                  trigger={
                    <IconButton
                      icon="more-horizontal"
                      size="icon-sm"
                      variant="ghost"
                      label={ts("modal.serviceMenu")}
                      disabled={state.busy}
                    />
                  }
                >
                  <MenuItem
                    icon="refresh"
                    onSelect={() => void refreshManagement()}
                  >
                    {ts("modal.refreshStatus")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon="play"
                    disabled={hostProcess}
                    onSelect={() => void serviceAction("start")}
                  >
                    {ts("modal.startService")}
                  </MenuItem>
                  <MenuItem
                    icon="refresh"
                    disabled={!hostProcess}
                    onSelect={() => setConfirmAction({ kind: "restart" })}
                  >
                    {ts("modal.restartService")}
                  </MenuItem>
                  <MenuItem
                    icon="stop-square"
                    destructive
                    disabled={!hostProcess}
                    onSelect={() => setConfirmAction({ kind: "stop" })}
                  >
                    {ts("modal.stopService")}
                  </MenuItem>
                </Menu>

                <IconButton
                  icon="close"
                  size="icon-sm"
                  variant="ghost"
                  className="management-back"
                  label={ts("modal.close")}
                  onClick={closeModal}
                />
              </div>
            </header>

            <div
              className={
                page === "log"
                  ? "ls-system-scroll ls-system-scroll--flush"
                  : "ls-system-scroll"
              }
            >
              {state.busyNotice ? (
                <div
                  className="ls-system-banner ls-system-banner--spaced"
                  role="status"
                >
                  <div className="ls-system-banner__copy">
                    <DesktopIcon name="spinner" size="sm" />
                    <span>{tm(state.busyNotice)}</span>
                  </div>
                </div>
              ) : null}
              {actionError ? (
                <div
                  className="ls-system-banner ls-system-banner--spaced"
                  data-tone="warning"
                  role="alert"
                >
                  <div className="ls-system-banner__copy">
                    <DesktopIcon name="alert-triangle" size="sm" />
                    <span>{actionError}</span>
                  </div>
                  <IconButton
                    icon="close"
                    size="icon-sm"
                    variant="ghost"
                    label={ts("modal.close")}
                    onClick={() => setActionError(null)}
                  />
                </div>
              ) : null}
              {state.problem ? (
                <div
                  className="ls-system-banner ls-system-banner--spaced"
                  data-tone="warning"
                  role="alert"
                >
                  <div className="ls-system-banner__copy">
                    <DesktopIcon name="alert-triangle" size="sm" />
                    <span>{state.problem}</span>
                  </div>
                  {/* A failed start is retried by starting again, not by re-reading the same state. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={state.busy}
                    onClick={() =>
                      void (stopped ? serviceAction("start") : refreshManagement())
                    }
                  >
                    {stopped ? ts("modal.startAgain") : ts("modal.retry")}
                  </Button>
                </div>
              ) : null}

              {page === "overview" ? (
                <SystemOverviewPage
                  onNavigate={navigatePage}
                  onRequestConfirm={setConfirmAction}
                />
              ) : null}
              {page === "devices" ? (
                <SystemDevicesPage onRequestConfirm={setConfirmAction} />
              ) : null}
              {page === "password" ? (
                <SystemPasswordPage onRequestConfirm={setConfirmAction} />
              ) : null}
              {page === "usage" ? <SystemUsagePage /> : null}
              {page === "log" ? <SystemLogPage /> : null}
              {page === "updates" ? (
                <SystemUpdatesPage onRequestConfirm={setConfirmAction} />
              ) : null}
              {page === "settings" ? <SystemSettingsPage /> : null}
            </div>
          </div>
        </div>
      </Dialog>

      <AlertDialog
        open={Boolean(confirmAction && confirmCopy)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !confirmBusy) setConfirmAction(null);
        }}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.desc}
        cancelLabel={ts("modal.cancel")}
        confirmLabel={confirmCopy?.action}
        destructive={confirmAction?.kind !== "upgrade"}
        loading={confirmBusy}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void executeConfirmedAction()}
      />
    </>
  );
}
