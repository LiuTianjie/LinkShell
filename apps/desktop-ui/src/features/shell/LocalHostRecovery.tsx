import {
  refreshManagement,
  resolveLocalHostPhase,
  serviceAction,
  thisComputerLabel,
  useI18n,
  useManagement,
  useRouter,
} from "../../core";
import { Button, EmptyState } from "../../primitives";

export interface LocalHostRecoveryProps {
  /** Display name of the local computer (defaults to localized "This Mac"/"This PC"). */
  computerName?: string;
  /** Whether to show the secondary "Connect Computer" button alongside Start/Restart and Settings. */
  showConnect?: boolean;
  /** Compact layout for narrower session/tool panes. */
  compact?: boolean;
}

/**
 * Single consistent local-Host recovery surface rendered whenever the local Host is
 * stopped, unreachable, or errored across Home, Session, New Session, and Standalone Tools.
 */
export function LocalHostRecovery({
  computerName,
  showConnect = false,
  compact = false,
}: LocalHostRecoveryProps) {
  const { locale, t } = useI18n();
  const mgmt = useManagement();
  const openSystemModal = useRouter((s) => s.openSystemModal);
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);

  const phase = resolveLocalHostPhase(mgmt);
  const label = computerName || thisComputerLabel(locale);
  const isStopped = phase === "stopped";
  const isUnreachable = phase === "unreachable";

  const title = isStopped
    ? t("desktop.fleet.localStoppedTitle")
    : t("desktop.fleet.localUnreachableTitle");
  const description = isStopped
    ? t("desktop.fleet.localStoppedDesc", { computer: label })
    : mgmt.problem || t("desktop.fleet.localUnreachableDesc", { computer: label });

  const buttonSize = compact ? "sm" : undefined;

  return (
    <EmptyState
      icon="host-daemon"
      title={title}
      description={description}
      actions={
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
          {isStopped ? (
            <Button
              size={buttonSize}
              variant="primary"
              leadingIcon="play"
              loading={mgmt.busy}
              onClick={() => void serviceAction("start")}
            >
              {t("desktop.manage.startService")}
            </Button>
          ) : isUnreachable ? (
            <Button
              size={buttonSize}
              variant="primary"
              leadingIcon="refresh"
              loading={mgmt.busy}
              onClick={() => void serviceAction("restart")}
            >
              {t("desktop.manage.restartService")}
            </Button>
          ) : (
            <Button
              size={buttonSize}
              variant="primary"
              leadingIcon="refresh"
              loading={mgmt.busy}
              onClick={() => void refreshManagement()}
            >
              {t("desktop.shell.retry")}
            </Button>
          )}
          {showConnect ? (
            <Button
              size={buttonSize}
              variant="secondary"
              leadingIcon="pair-qr"
              onClick={() => setConnectModalOpen(true)}
            >
              {t("desktop.fleet.connectComputer")}
            </Button>
          ) : null}
          <Button
            size={buttonSize}
            variant={showConnect ? "ghost" : "secondary"}
            leadingIcon="settings"
            onClick={() => openSystemModal(isStopped ? "overview" : "log")}
          >
            {t("desktop.localManagement")}
          </Button>
        </div>
      }
    />
  );
}
