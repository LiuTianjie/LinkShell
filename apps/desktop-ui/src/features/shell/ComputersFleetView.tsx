import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  canUseFusionMode,
  computerNames,
  connectAndStartComputerFusion,
  engine,
  gatewayLabel,
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
      const offlineText =
        locale === "en" ? "Offline" : locale === "ja" ? "オフライン" : "离线";
      return [osLabel, offlineText].filter(Boolean).join(" · ");
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
          : msg,
      );
    } finally {
      retained.release();
    }
  };

  const handleForget = async () => {
    const confirmed = await dialogs.confirm(
      locale === "en"
        ? `Remove paired computer "${displayName}"? You will need to pair again to reconnect.`
        : locale === "ja"
          ? `「${displayName}」のペアリングを解除しますか？`
          : `确定移除电脑「${displayName}」吗？移除后需要重新配对或登录同一账号连接。`,
      { destructive: true, confirmLabel: t("desktop.fleet.forgetComputer") },
    );
    if (!confirmed) return;
    await engine.forget(computer);
  };

  const copyMachineIdLabel =
    locale === "en"
      ? "Copy Machine ID"
      : locale === "ja"
        ? "Machine ID をコピー"
        : "复制 Machine ID";

  const localSettingsLabel =
    locale === "en"
      ? "Local Settings"
      : locale === "ja"
        ? "ローカル設定"
        : "本机设置";

  const moreActionsLabel =
    locale === "en"
      ? `More actions for ${displayName}`
      : locale === "ja"
        ? `${displayName} の操作`
        : `${displayName} 更多操作`;

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
              {locale === "en" ? "Save" : locale === "ja" ? "保存" : "保存"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setRenameError(undefined);
              }}
            >
              {locale === "en" ? "Cancel" : locale === "ja" ? "キャンセル" : "取消"}
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
                {locale === "en"
                  ? "Open Terminal"
                  : locale === "ja"
                    ? "ターミナルを開く"
                    : "打开终端"}
              </MenuItem>
              <MenuItem
                icon="file-code"
                onSelect={() => {
                  engine.select(computer);
                  navigate({ kind: "files", computerKey: computer.key });
                }}
              >
                {locale === "en"
                  ? "Browse Files"
                  : locale === "ja"
                    ? "ファイルを参照"
                    : "浏览文件"}
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
  const gatewayTitle =
    locale === "en" ? "Gateway" : locale === "ja" ? "ゲートウェイ" : "网关";
  const subtitle = `${t("desktop.localManagement")} ${serviceLabel(
    mgmt.snapshot,
    mgmt.problem,
  )} · ${gatewayTitle} ${gatewayLabel(mgmt.snapshot, isLocalHealthy)} · ${onlineCount}/${
    allComputers.length
  } ${locale === "en" ? "online" : locale === "ja" ? "オンライン" : "台在线"}`;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await engine.refreshComputers();
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
              {locale === "en" ? "Refresh" : locale === "ja" ? "更新" : "刷新"}
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
            description={
              locale === "en"
                ? "Sign in or pair a remote computer to manage sessions, terminals, and Fusion Mode."
                : locale === "ja"
                  ? "サインインまたはペアリングして他のコンピュータを接続します。"
                  : "登录同一账号或输入 6 位配对码连接远端 Mac / Windows 电脑。"
            }
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
