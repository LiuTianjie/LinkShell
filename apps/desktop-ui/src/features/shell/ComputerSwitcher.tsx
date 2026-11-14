import { useState } from "react";
import { useStore } from "zustand";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  computerNames,
  connectAndStartComputerFusion,
  engine,
  evaluateFusionCapability,
  fusionCapabilityMessage,
  fusionStore,
  useActiveDesktopPlatform,
  useI18n,
  useRouter,
  type Computer,
} from "../../core";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
} from "../../primitives";
import {
  computerPlatformIcon,
  connectionRouteBadge,
  currentFusionCapabilityEnv,
  displayComputerName,
  switchToComputer,
  useConnectionStore,
} from "./shell-helpers";

export interface ComputerSwitcherProps {
  onSelectDone?: () => void;
  isPeekDrawer?: boolean;
}

export function ComputerSwitcher({
  onSelectDone,
}: ComputerSwitcherProps) {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const locked = useStore(engine.state, (s) => s.locked);
  const names = useStore(computerNames.store);
  const fusionByComputer = useStore(fusionStore, (s) => s.byComputer);

  const navigate = useRouter((s) => s.navigate);
  const openScreen = useRouter((s) => s.openScreen);
  const openFusion = useRouter((s) => s.openFusion);
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);

  const linkStatus = useConnectionStore(activeConnection, (s) => s.status);
  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];

  const activeName = displayComputerName(activeComputer, names, locale);
  const activeRouteTag = connectionRouteBadge(activeComputer, undefined, locale);

  const dotTone = locked
    ? "waiting"
    : activeComputer?.key === DESKTOP_LOCAL
      ? linkStatus === "online" || activeComputer.machine.online
        ? "online"
        : "offline"
      : activeComputer?.machine.online
        ? linkStatus === "connecting"
          ? "waiting"
          : "online"
        : "offline";

  const handleSelectComputer = (computer: Computer) => {
    switchToComputer(computer);
    setOpen(false);
    onSelectDone?.();
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await engine.refreshComputers();
    } finally {
      setRefreshing(false);
    }
  };

  const allComputers = computers.length > 0 ? computers : localComputer ? [localComputer] : [];

  return (
    <div className="computer-switcher">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <button
            type="button"
            aria-label={`${t("desktop.nav.computers")}: ${activeName}`}
            className="computer-switcher-trigger"
          >
            <span className="computer-switcher-trigger__icon" aria-hidden="true">
              <DesktopIcon
                name={computerPlatformIcon(activeComputer?.machine.platform)}
                size="sm"
              />
              <StatusDot tone={dotTone} size="sm" className="computer-switcher-trigger__dot" />
            </span>
            <span className="computer-switcher-trigger__name">{activeName}</span>
            <span className="computer-switcher-trigger__route">{activeRouteTag.label}</span>
            <span className="computer-switcher-trigger__chevron" aria-hidden="true">
              <DesktopIcon name="chevrons-up-down" size="xs" />
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent placement="bottom-start" className="computer-switcher-popover">
          <div className="computer-switcher-popover__inner">
            <div className="computer-switcher-popover__header">
            <span>{t("desktop.nav.computers")}</span>
            <IconButton
              icon="refresh"
              loading={refreshing}
              label={locale === "en" ? "Refresh computers" : locale === "ja" ? "更新" : "刷新电脑列表"}
              onClick={() => void handleRefresh()}
            />
          </div>

          <div className="computer-switcher-list" role="listbox" aria-label={t("desktop.nav.computers")}>
            {allComputers.map((computer) => {
              const isSelected = computer.key === activeComputer?.key;
              const isLocal = computer.key === DESKTOP_LOCAL;
              const name = displayComputerName(computer, names, locale);
              const route = connectionRouteBadge(computer, undefined, locale);
              const fusionState = fusionByComputer[computer.key];
              const fusionActive = Boolean(fusionState?.connected);
              const fusionWindows = fusionState
                ? Object.values(fusionState.windowCounts).reduce((a, b) => a + b, 0)
                : 0;
              const fusionCap = evaluateFusionCapability(
                computer.key,
                computer.machine.platform,
                currentFusionCapabilityEnv(activePlatform),
              );
              const showFusionAction =
                fusionCap.supported ||
                (fusionCap.reason !== "windows-client" &&
                  fusionCap.reason !== "not-electron" &&
                  fusionCap.reason !== "local-computer");
              const fusionDisabledReason = !fusionCap.supported
                ? fusionCapabilityMessage(fusionCap.reason, locale)
                : !computer.machine.online
                  ? t("desktop.fusion.offlineHost", { name })
                  : undefined;

              return (
                <div
                  key={computer.key}
                  data-selected={isSelected ? "true" : undefined}
                  data-fusion-active={fusionActive ? "true" : undefined}
                  className="computer-switcher-row"
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="computer-switcher-row__main"
                    onClick={() => handleSelectComputer(computer)}
                  >
                    <span className="computer-switcher-trigger__icon" aria-hidden="true">
                      <DesktopIcon
                        name={computerPlatformIcon(computer.machine.platform)}
                        size="md"
                      />
                      <StatusDot
                        tone={computer.machine.online ? "online" : "offline"}
                        size="sm"
                        className="computer-switcher-trigger__dot"
                      />
                    </span>

                    <span className="computer-switcher-row__body">
                      <span className="computer-switcher-row__title">
                        <span className="ls-truncate">{name}</span>
                        {fusionActive ? (
                          <Badge tone="ok" icon="fusion-mode">
                            {fusionWindows > 0 ? String(fusionWindows) : t("desktop.fusion.title")}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="computer-switcher-row__sub">
                        <span>{route.label}</span>
                        <span>·</span>
                        <span>
                          {computer.machine.online
                            ? locale === "en"
                              ? "Online"
                              : locale === "ja"
                                ? "オンライン"
                                : "在线"
                            : locale === "en"
                              ? "Offline"
                              : locale === "ja"
                                ? "オフライン"
                                : "离线"}
                        </span>
                      </span>
                    </span>

                    {isSelected ? (
                      <DesktopIcon name="check" size="sm" style={{ color: "var(--ls-accent)" }} />
                    ) : null}
                  </button>

                  {!isLocal ? (
                    <div className="computer-switcher-row__actions">
                      <IconButton
                        icon="remote-screen"
                        disabled={!computer.machine.online}
                        disabledReason={
                          !computer.machine.online
                            ? t("desktop.fusion.offlineHost", { name })
                            : undefined
                        }
                        label={`${t("desktop.screen.openDesktop")} — ${name}`}
                        tooltip={t("desktop.screen.openDesktop")}
                        onClick={() => {
                          engine.select(computer);
                          openScreen(computer.key);
                          setOpen(false);
                          onSelectDone?.();
                        }}
                      />
                      {showFusionAction ? (
                        <IconButton
                          icon="fusion-mode"
                          variant={fusionActive ? "subtle" : "ghost"}
                          aria-pressed={fusionActive}
                          loading={fusionState?.phase === "starting"}
                          disabled={Boolean(fusionDisabledReason)}
                          disabledReason={fusionDisabledReason}
                          label={`${t("desktop.fusion.title")} — ${name}`}
                          tooltip={fusionDisabledReason ?? t("desktop.fusion.start")}
                          onClick={() => {
                            engine.select(computer);
                            openFusion(computer.key);
                            if (!fusionState || fusionState.phase === "idle") {
                              void connectAndStartComputerFusion(computer.key);
                            }
                            setOpen(false);
                            onSelectDone?.();
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="computer-switcher-popover__footer">
            <button
              type="button"
              className="computer-switcher-footer-btn"
              onClick={() => {
                setOpen(false);
                setConnectModalOpen(true);
                onSelectDone?.();
              }}
            >
              <DesktopIcon name="pair-qr" size="sm" />
              <span>{t("desktop.fleet.connectComputer")}</span>
            </button>
            <button
              type="button"
              className="computer-switcher-footer-btn"
              onClick={() => {
                setOpen(false);
                navigate({ kind: "computers" });
                onSelectDone?.();
              }}
            >
              <DesktopIcon name="computer-pc" size="sm" />
              <span>{t("desktop.nav.computers")}</span>
            </button>
          </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
