import { useEffect, useId, useState, type ReactElement } from "react";
import {
  MANAGE_PAGES,
  accountAction,
  healthy as isHealthy,
  newVersion as hasNewVersion,
  pollManagement,
  refreshManagement,
  revokePairedDevice,
  routerStore,
  serviceAction,
  setAccessPassword,
  upgradeInstall,
  useManagement,
  useRouter,
  type ManagePage,
} from "../../core";
import { DesktopIcon, type DesktopIconName } from "../../icons";
import {
  AlertDialog,
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  StatusDot,
} from "../../primitives";
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
export function SystemHostModal(): ReactElement {
  const { ts, tm, pageTitle, computer } = useSystemI18n();
  const { open, page } = useRouter((s) => s.systemModal);
  const state = useManagement();
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

  useEffect(() => {
    if (!open) {
      setConfirmAction(null);
      return undefined;
    }
    return pollManagement();
  }, [open]);

  const navigatePage = (nextPage: ManagePage) => {
    routerStore.getState().openSystemModal(nextPage);
  };

  const closeModal = () => {
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
    try {
      switch (confirmAction.kind) {
        case "stop":
          await serviceAction("stop");
          break;
        case "restart":
          await serviceAction("restart");
          break;
        case "logout":
          await accountAction("logout");
          break;
        case "remove-password":
          await setAccessPassword(null);
          break;
        case "upgrade":
          await upgradeInstall();
          break;
        case "revoke-device":
          await revokePairedDevice(confirmAction.deviceId);
          break;
      }
      setConfirmAction(null);
    } finally {
      setConfirmBusy(false);
    }
  };

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
