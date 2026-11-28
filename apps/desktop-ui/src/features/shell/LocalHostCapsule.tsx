import { useStore } from "zustand";
import { hasDesktopSidecar } from "../../bridge/desktop-bridge";
import {
  engine,
  newVersion,
  resolveLocalHostPhase,
  useI18n,
  useManagement,
  useRouter,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { StatusDot } from "../../primitives";
import { useConnectionStore } from "./shell-helpers";

export interface LocalHostCapsuleProps {
  onActionDone?: () => void;
}

export function LocalHostCapsule({ onActionDone }: LocalHostCapsuleProps) {
  const { t } = useI18n();
  const mgmt = useManagement();
  const openSystemModal = useRouter((s) => s.openSystemModal);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const relayStatus = useStore(engine.state, (s) => s.relayStatus);
  const account = useStore(engine.state, (s) => s.account);
  const linkStatus = useConnectionStore(activeConnection, (s) => s.status);

  const pureBrowserMode =
    !hasDesktopSidecar() &&
    !localComputer &&
    !mgmt.snapshot &&
    !mgmt.starting &&
    !mgmt.problem;

  const phase = resolveLocalHostPhase(mgmt);
  const hasUpdate = !pureBrowserMode && newVersion(mgmt);
  const keepAwakeOn =
    !pureBrowserMode &&
    Boolean(mgmt.settings.keepAwake && mgmt.settings.keepAwake !== "off");

  const relayValues = Object.values(relayStatus);
  const browserOnline =
    linkStatus === "online" || relayValues.some((value) => value === "online");
  const browserConnecting =
    !browserOnline &&
    (linkStatus === "connecting" ||
      linkStatus === "reconnecting" ||
      relayValues.some((value) => value === "connecting" || value === "reconnecting"));

  const statusTone = pureBrowserMode
    ? browserOnline
      ? "online"
      : browserConnecting
        ? "waiting"
        : "offline"
    : phase === "starting" || mgmt.busy
      ? "waiting"
      : phase === "running"
        ? "online"
        : phase === "stopped"
          ? "offline"
          : "danger";

  const statusWord = pureBrowserMode
    ? browserOnline
      ? (account ?? t("desktop.shell.online"))
      : browserConnecting
        ? t("desktop.manage.serviceConnecting")
        : t("desktop.shell.offline")
    : phase === "running"
      ? t("desktop.manage.serviceRunning")
      : phase === "starting"
        ? t("desktop.manage.serviceConnecting")
        : phase === "stopped"
          ? t("desktop.manage.serviceStopped")
          : t("desktop.manage.serviceUnreachable");

  return (
    <footer className="desktop-sidebar-footer">
      <button
        type="button"
        title={pureBrowserMode ? undefined : mgmt.problem || undefined}
        className="sidebar-footer-settings-btn local-host-capsule__status"
        onClick={() => {
          openSystemModal(
            pureBrowserMode ? "settings" : hasUpdate ? "updates" : "overview",
          );
          onActionDone?.();
        }}
      >
        <span className="sidebar-footer-settings-btn__lead">
          <span className="sidebar-footer-settings-btn__icon" aria-hidden="true">
            <DesktopIcon name="settings" size="sm" />
          </span>
          <span className="sidebar-footer-settings-btn__label ls-truncate">
            {t("desktop.localManagement")}
          </span>
        </span>

        <span className="sidebar-footer-settings-btn__meta">
          <StatusDot tone={statusTone} size="sm" />
          <span className="sidebar-footer-settings-btn__status ls-truncate">
            {statusWord}
          </span>
          {keepAwakeOn ? (
            <span className="local-host-capsule__flags" aria-hidden="true">
              <DesktopIcon name="keep-awake" size="xs" />
            </span>
          ) : null}
          {hasUpdate ? (
            <span className="local-host-capsule__update-dot" aria-hidden="true">
              <DesktopIcon name="sparkles" size="xs" />
            </span>
          ) : null}
        </span>
      </button>
    </footer>
  );
}
