import {
  newVersion,
  resolveLocalHostPhase,
  useI18n,
  useManagement,
  useRouter,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { StatusDot } from "../../primitives";

export interface LocalHostCapsuleProps {
  onActionDone?: () => void;
}

export function LocalHostCapsule({ onActionDone }: LocalHostCapsuleProps) {
  const { t } = useI18n();
  const mgmt = useManagement();
  const openSystemModal = useRouter((s) => s.openSystemModal);

  const phase = resolveLocalHostPhase(mgmt);
  const hasUpdate = newVersion(mgmt);
  const keepAwakeOn = Boolean(mgmt.settings.keepAwake && mgmt.settings.keepAwake !== "off");

  const statusTone =
    phase === "starting" || mgmt.busy
      ? "waiting"
      : phase === "running"
        ? "online"
        : phase === "stopped"
          ? "offline"
          : "danger";

  const statusWord =
    phase === "running"
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
        title={mgmt.problem || undefined}
        className="sidebar-footer-settings-btn local-host-capsule__status"
        onClick={() => {
          openSystemModal(hasUpdate ? "updates" : "overview");
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
