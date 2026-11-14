import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  canUseFusionMode,
  computerNames,
  connectAndStartComputerFusion,
  describeActionError,
  engine,
  gatewayLabel,
  routerStore,
  healthy,
  memoryPercent,
  observeMachineMetrics,
  serviceLabel,
  useFusionState,
  useI18n,
  useManagement,
  useRouter,
  type Computer,
  type MachineMetricsState,
} from "../../core";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  StatusDot,
  useDialogs,
} from "../../primitives";
import {
  computerPlatformIcon,
  connectionRouteBadge,
  currentFusionCapabilityEnv,
  DefaultFusionStatusBadge,
  displayComputerName,
  formatPlatformLabel,
  formatSessionCountLabel,
  isLocalComputer,
  reportShellError,
  switchToComputer,
} from "./shell-helpers";

export interface ComputersFleetViewProps {
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
  onOpenLocalPairingQr?: () => void;
  renderFusionQuickTrigger?: (props: { computerKey: string; compact?: boolean }) => ReactNode;
  renderFusionStatusBadge?: (props: { computerKey: string; onClick?: () => void }) => ReactNode;
}

interface FleetComputerRowProps {
  computer: Computer;
  isSelected: boolean;
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
  renderFusionStatusBadge?: (props: { computerKey: string; onClick?: () => void }) => ReactNode;
}

function FleetComputerRow({
  computer,
  isSelected,
  onRequestNewSession,
  renderFusionStatusBadge,
}: FleetComputerRowProps) {
  const { locale, t } = useI18n();
  const dialogs = useDialogs();
  const names = useStore(computerNames.store);
  const openScreen = useRouter((s) => s.openScreen);
  const openFusion = useRouter((s) => s.openFusion);
  const openSystemModal = useRouter((s) => s.openSystemModal);
  const navigate = useRouter((s) => s.navigate);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState<string | undefined>();
  const [metricsState, setMetricsState] = useState<MachineMetricsState>({ history: [] });
  const [sessionCount, setSessionCount] = useState(0);

  const isLocal = isLocalComputer(computer);
  const isOnline = computer.machine.online || isLocal;
  const displayName = displayComputerName(computer, names, locale);
  const routeBadge = connectionRouteBadge(computer, undefined, locale);
  const fusionState = useFusionState(computer.key);
  const supportsFusion =
    !isLocal &&
    canUseFusionMode(computer.key, computer.machine.platform, currentFusionCapabilityEnv());

  // Observe live telemetry & session counts via metadata-only connection when online
  useEffect(() => {
    if (!computer.machine.online && !isLocal) {
      setMetricsState({ history: [] });
      return undefined;
    }
    const retained = engine.retainComputer(computer, { metadataOnly: true });
    const syncStore = () => {
      const state = retained.connection.store.getState();
      setSessionCount(
        Object.values(state.sessions).filter((s) => !s.archived).length,
      );
    };
    syncStore();
    const unsubStore = retained.connection.store.subscribe(syncStore);
    const unsubMetrics = observeMachineMetrics(
      () => retained.connection.link.call("machine.metrics", {}),
      (next) => setMetricsState(next),
    );
    return () => {
      unsubMetrics();
      unsubStore();
      retained.release();
    };
  }, [computer, computer.machine.online, isLocal]);

  const metrics = metricsState.metrics;
  const memPct = metrics ? memoryPercent(metrics) : null;
  const osLabel = formatPlatformLabel(computer.machine.platform);

  const inlineTelemetry = (() => {
    if (!computer.machine.online && !isLocal) {
      return [osLabel, t("desktop.shell.offline")].filter(Boolean).join(" · ");
    }
    const parts: string[] = [];
    if (osLabel) parts.push(osLabel);
    parts.push(formatSessionCountLabel(sessionCount, locale));
    if (metrics && metrics.cpu.usage !== null) {
      parts.push(`${t("desktop.fleet.cpu")} ${Math.round(metrics.cpu.usage)}%`);
    }
    if (metrics && memPct !== null) {
      parts.push(`${t("desktop.fleet.memory")} ${Math.round(memPct)}%`);
    }
    return parts.join(" · ");
  })();

  const handleStartRename = () => {
    setDraftName(displayName);
    setRenameError(undefined);
    setRenaming(true);
  };

  const handleSaveRename = async () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === displayName) {
      setRenaming(false);
      setRenameError(undefined);
      return;
    }
    const retained = engine.retainComputer(computer, { metadataOnly: true });
    try {
      await computerNames.rename(computer, trimmed, retained.connection.link);
      setRenaming(false);
      setRenameError(undefined);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setRenameError(
        /method not found|machine\.rename|-32601/i.test(msg)
          ? t("desktop.fleet.renameOutdated")
          : describeActionError(error, locale),
      );
    } finally {
      retained.release();
    }
  };

  const handleForget = async () => {
    const confirmed = await dialogs.confirm(t("desktop.shell.forgetConfirm", { name: displayName }), {
      destructive: true,
      confirmLabel: t("desktop.fleet.forgetComputer"),
    });
    if (!confirmed) return;
    try {
      await engine.forget(computer);
      // Back must not lead into a computer that is no longer paired.
      routerStore.getState().forgetComputer(computer.key);
    } catch (error) {
      reportShellError(error, locale);
    }
  };

  const copyMachineIdLabel = t("desktop.shell.copyMachineId");
  const localSettingsLabel = t("desktop.localManagement");
  const moreActionsLabel = t("desktop.shell.computerActions", { name: displayName });

  return (
    <div
      role="listitem"
      className="ls-entity-row"
      data-selected={isSelected ? "true" : undefined}
      data-computer-key={computer.key}
    >
      {renaming ? (
        <div className="ls-entity-row__main ls-entity-row__main--static">
          <span className="ls-entity-row__lead" aria-hidden="true">
            <DesktopIcon
              name={computerPlatformIcon(computer.machine.platform)}
              size="md"
            />
            <StatusDot
              tone={computer.machine.online ? "online" : "offline"}
              size="sm"
              className="ls-entity-row__status-dot"
            />
          </span>

          <div className="ls-entity-row__inline-edit">
            <Input
              size="sm"
              value={draftName}
              aria-label={t("desktop.fleet.renameComputer")}
              onChange={(e) => setDraftName(e.target.value)}
              onEnterSubmit={() => void handleSaveRename()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameError(undefined);
                }
              }}
            />
            <Button size="sm" variant="primary" onClick={() => void handleSaveRename()}>
              {t("desktop.shell.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setRenameError(undefined);
              }}
            >
              {t("desktop.shell.cancel")}
            </Button>
          </div>
          {renameError ? (
            <span className="ls-entity-row__error ls-truncate">{renameError}</span>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="ls-entity-row__main"
          onClick={() => switchToComputer(computer)}
        >
          <span className="ls-entity-row__lead" aria-hidden="true">
            <DesktopIcon
              name={computerPlatformIcon(computer.machine.platform)}
              size="md"
            />
            <StatusDot
              tone={computer.machine.online ? "online" : "offline"}
              size="sm"
              className="ls-entity-row__status-dot"
            />
          </span>

          <span className="ls-entity-row__title ls-truncate">{displayName}</span>

          <Badge icon={routeBadge.icon} tone={routeBadge.tone}>
            {routeBadge.label}
          </Badge>

          <span className="ls-entity-row__secondary ls-truncate">
            {inlineTelemetry}
          </span>
        </button>
      )}

      {!isLocal && !renaming ? (
        renderFusionStatusBadge ? (
          renderFusionStatusBadge({
            computerKey: computer.key,
            onClick: () => {
              engine.select(computer);
              openFusion(computer.key);
            },
          })
        ) : (
          <DefaultFusionStatusBadge
            computerKey={computer.key}
            onClick={() => {
              engine.select(computer);
              openFusion(computer.key);
            }}
          />
        )
      ) : null}

      <div className="ls-entity-row__actions">
        {isLocal ? (
          <Button
            size="sm"
            variant="ghost"
            leadingIcon="settings"
            onClick={() => openSystemModal("overview")}
          >
            {localSettingsLabel}
          </Button>
        ) : computer.machine.online ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon="remote-screen"
              onClick={() => {
                engine.select(computer);
                openScreen(computer.key);
              }}
            >
              {t("desktop.nav.screen")}
            </Button>

            {supportsFusion ? (
              <Button
                size="sm"
                variant={fusionState.connected ? "subtle" : "ghost"}
                leadingIcon="fusion-mode"
                loading={fusionState.phase === "starting"}
                onClick={() => {
                  engine.select(computer);
                  openFusion(computer.key);
                  if (fusionState.phase === "idle") {
                    void connectAndStartComputerFusion(computer.key);
                  }
                }}
              >
                {t("desktop.nav.fusion")}
              </Button>
            ) : null}
          </>
        ) : null}

        <Menu
          placement="bottom-end"
          label={moreActionsLabel}
          trigger={
            <IconButton
              icon="more-horizontal"
              variant="ghost"
              label={moreActionsLabel}
            />
          }
        >
          {isOnline ? (
            <>
              <MenuItem
                icon="plus"
                onSelect={() => {
                  engine.select(computer);
                  onRequestNewSession(computer.key);
                }}
              >
                {t("desktop.newSession")}
              </MenuItem>
              <MenuItem icon="edit" onSelect={handleStartRename}>
                {t("desktop.menu.rename")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon="terminal"
                onSelect={() => {
                  engine.select(computer);
                  navigate({ kind: "terminals", computerKey: computer.key });
                }}
              >
                {t("desktop.shell.openTerminal")}
              </MenuItem>
              <MenuItem
                icon="file-code"
                onSelect={() => {
                  engine.select(computer);
                  navigate({ kind: "files", computerKey: computer.key });
                }}
              >
                {t("desktop.shell.browseFiles")}
              </MenuItem>
              <MenuItem
                icon="port-preview"
                onSelect={() => {
                  engine.select(computer);
                  navigate({ kind: "ports", computerKey: computer.key });
                }}
              >
                {t("desktop.nav.ports")}
              </MenuItem>
              <MenuSeparator />
            </>
          ) : (
            <MenuItem
              icon="edit"
              disabled
              disabledReason={t("desktop.fusion.offlineHost", { name: displayName })}
            >
              {t("desktop.menu.rename")}
            </MenuItem>
          )}

          <MenuItem
            icon="copy"
            onSelect={() => {
              void navigator.clipboard?.writeText(computer.machine.id);
            }}
          >
            {copyMachineIdLabel}
          </MenuItem>

          {!isLocal ? (
            <>
              <MenuSeparator />
              <MenuItem
                icon="trash"
                destructive
                onSelect={() => void handleForget()}
              >
                {t("desktop.fleet.forgetComputer")}
              </MenuItem>
            </>
          ) : null}
        </Menu>
      </div>
    </div>
  );
}

export function ComputersFleetView({
  onRequestNewSession,
  onOpenLocalPairingQr,
  renderFusionStatusBadge,
}: ComputersFleetViewProps) {
  const { locale, t } = useI18n();
  const mgmt = useManagement();
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const [refreshing, setRefreshing] = useState(false);

  const allComputers =
    computers.length > 0 ? computers : localComputer ? [localComputer] : [];
  const activeKey = activeConnection?.computer.key ?? DESKTOP_LOCAL;
  const onlineCount = allComputers.filter((c) => c.machine.online).length;

  const isLocalHealthy = healthy(mgmt);
  const gatewayTitle = t("desktop.shell.gateway");
  const subtitle = `${t("desktop.shell.localService")} ${serviceLabel(
    mgmt.snapshot,
    mgmt.problem,
  )} · ${gatewayTitle} ${gatewayLabel(mgmt.snapshot, isLocalHealthy)} · ${t(
    "desktop.shell.onlineCount",
    { online: onlineCount, total: allComputers.length },
  )}`;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await engine.refreshComputers();
    } catch (error) {
      reportShellError(error, locale);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="shell-page">
      <div className="shell-page__inner">
        <div className="shell-page__header">
          <div className="shell-page__heading">
            <h1 className="shell-page__title">{t("desktop.nav.computers")}</h1>
            <p className="shell-page__subtitle">{subtitle}</p>
          </div>

          <div className="shell-page__actions">
            <Button
              size="md"
              variant="secondary"
              leadingIcon="refresh"
              loading={refreshing}
              onClick={() => void handleRefresh()}
            >
              {t("desktop.shell.refresh")}
            </Button>

            {onOpenLocalPairingQr ? (
              <Button
                size="md"
                variant="secondary"
                leadingIcon="pair-qr"
                onClick={onOpenLocalPairingQr}
              >
                {t("desktop.fleet.pairDevice")}
              </Button>
            ) : null}

            <Button
              size="md"
              variant="primary"
              leadingIcon="plus"
              onClick={() => setConnectModalOpen(true)}
            >
              {t("desktop.fleet.connectComputer")}
            </Button>
          </div>
        </div>

        {allComputers.length > 0 ? (
          <div className="ls-entity-list" role="list" aria-label={t("desktop.nav.computers")}>
            {allComputers.map((computer) => (
              <FleetComputerRow
                key={computer.key}
                computer={computer}
                isSelected={computer.key === activeKey}
                onRequestNewSession={onRequestNewSession}
                renderFusionStatusBadge={renderFusionStatusBadge}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon="computer-pc"
            title={t("desktop.nav.computers")}
            description={t("desktop.shell.fleetEmpty")}
            actions={
              <Button
                variant="primary"
                leadingIcon="pair-qr"
                onClick={() => setConnectModalOpen(true)}
              >
                {t("desktop.fleet.connectComputer")}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
