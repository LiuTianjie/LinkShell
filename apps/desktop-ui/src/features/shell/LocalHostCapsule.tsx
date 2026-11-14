import {
  healthy,
  newVersion,
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

  const isHealthy = healthy(mgmt);
  const hasUpdate = newVersion(mgmt);
  const keepAwakeOn = Boolean(mgmt.settings.keepAwake && mgmt.settings.keepAwake !== "off");

  const statusTone =
    mgmt.starting || mgmt.busy
      ? "waiting"
      : isHealthy
        ? "online"
        : mgmt.snapshot?.status === "stopped"
          ? "offline"
          : mgmt.problem
            ? "danger"
            : "neutral";

  const statusWord = isHealthy
    ? t("desktop.manage.serviceRunning")
    : mgmt.snapshot?.status === "stopped"
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
