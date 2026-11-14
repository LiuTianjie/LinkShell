import { useState, type JSX } from "react";
import {
  evaluateFusionCapability,
  fusionCapabilityMessage,
  startComputerFusion,
  useFusionState,
} from "../../core/fusion-store";
import { useActiveDesktopPlatform, useI18n } from "../../core/i18n";
import { routerStore } from "../../core/router-store";
import { DesktopIcon } from "../../icons";
import { Button, Tooltip } from "../../primitives";
import { getRemoteCopy } from "./remote-copy";
import {
  resolveLocalDesktopEnv,
  useRemoteComputer,
} from "./use-remote-computer";

export interface FusionStatusBadgeProps {
  computerKey: string;
  onClick?: () => void;
}

/**
 * Live Fusion telemetry pill (`[融合中 · 直连 · 4ms]`) for Left Sidebar, ComputerSwitcher & Fleet cards.
 * Renders `null` when idle so resting rows stay clean.
 */
export function FusionStatusBadge({
  computerKey,
  onClick,
}: FusionStatusBadgeProps): JSX.Element | null {
  const { locale } = useI18n();
  const copy = getRemoteCopy(locale);
  const fusion = useFusionState(computerKey);

  const handleActivate = () => {
    if (onClick) {
      onClick();
      return;
    }
    routerStore.getState().openFusion(computerKey);
  };

  if (fusion.phase === "starting") {
    return (
      <button
        type="button"
        data-phase="starting"
        className="ls-fusion-status-badge no-drag"
        onClick={handleActivate}
      >
        <DesktopIcon name="spinner" size="xs" />
        <span>{copy.fusionConnecting}</span>
      </button>
    );
  }

  const isActive =
    fusion.phase === "connected" || (fusion.hubRunning && fusion.connected);
  if (!isActive) {
    return null;
  }

  const transportLabel =
    fusion.mode === "direct" ? copy.fusionDirect : copy.fusionTunnel;
  const transportIcon =
    fusion.mode === "direct" ? "direct-p2p" : "gateway-relay";
  const rttLabel =
    typeof fusion.rttMs === "number" && Number.isFinite(fusion.rttMs)
      ? `${Math.max(1, Math.round(fusion.rttMs))}ms`
      : undefined;
  const totalWindows = Object.values(fusion.windowCounts).reduce(
    (sum, count) => sum + (Number.isFinite(count) ? count : 0),
    0,
  );
  const badgeCount =
    totalWindows > 0 ? totalWindows : fusion.activeBundles.length;

  return (
    <button
      type="button"
      data-phase="connected"
      data-transport={fusion.mode ?? "tunnel"}
      className="ls-fusion-status-badge no-drag"
      onClick={handleActivate}
    >
      <span className="ls-fusion-status-badge__dot" aria-hidden="true" />
      <DesktopIcon name={transportIcon} size="xs" />
      <span>{copy.fusionActiveShort}</span>
      <span className="ls-fusion-status-badge__sep" aria-hidden="true">
        ·
      </span>
      <span>{transportLabel}</span>
      {rttLabel ? (
        <>
          <span className="ls-fusion-status-badge__sep" aria-hidden="true">
            ·
          </span>
          <span>{rttLabel}</span>
        </>
      ) : null}
      {badgeCount > 0 ? (
        <span className="ls-fusion-status-badge__count">{badgeCount}</span>
      ) : null}
    </button>
  );
}

export interface FusionQuickTriggerProps {
  computerKey: string;
  compact?: boolean;
}

/**
 * First-class Fusion Mode quick trigger for Fleet cards, ComputerSwitcher & Session headers.
 * Self-explaining capability boundary (`#7` §3.3):
 * - Hidden on `desktop:local`, non-Electron, or Windows→non-Mac pairs.
 * - Disabled with a clear `popover="hint"` explanation on Windows→Mac or Mac→Windows/Linux.
 * - Width-locked `loading` spinner while starting; jumps straight to Fusion Launchpad.
 */
export function FusionQuickTrigger({
  computerKey,
  compact = false,
}: FusionQuickTriggerProps): JSX.Element | null {
  const { locale } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const copy = getRemoteCopy(locale);
  const { computer, connection, displayName, remotePlatform } =
    useRemoteComputer(computerKey);
  const fusion = useFusionState(computerKey);
  const [startingLocal, setStartingLocal] = useState(false);

  const env = resolveLocalDesktopEnv();
  const capability = evaluateFusionCapability(computerKey, remotePlatform, {
    electron: env.electron,
    localPlatform: activePlatform,
  });

  if (!capability.supported) {
    if (
      capability.reason === "local-computer" ||
      capability.reason === "not-electron" ||
      capability.reason === "windows-client"
    ) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        size={compact ? "xs" : "sm"}
        leadingIcon="fusion-mode"
        disabled
        disabledReason={fusionCapabilityMessage(capability.reason, locale)}
        className="no-drag"
      >
        {compact ? copy.fusionMode : copy.fusionOpenHub}
      </Button>
    );
  }

  const isConnected =
    fusion.phase === "connected" || (fusion.hubRunning && fusion.connected);
  const isBusy = fusion.phase === "starting" || startingLocal;

  const handleClick = () => {
    routerStore.getState().openFusion(computerKey);
    if (isConnected || isBusy) return;
    if (connection && computer?.machine.online !== false) {
      setStartingLocal(true);
      void startComputerFusion({
        computerKey,
        name: displayName,
        link: connection.link,
        streams: connection.streams,
      })
        .catch(() => {
          // Error is recorded in `fusionStore` and surfaced inside `FusionWorkspace`.
        })
        .finally(() => {
          setStartingLocal(false);
        });
    }
  };

  return (
    <Button
      variant={isConnected ? "subtle" : compact ? "ghost" : "secondary"}
      size={compact ? "xs" : "sm"}
      leadingIcon="fusion-mode"
      loading={isBusy}
      loadingLabel={compact ? undefined : copy.fusionConnecting}
      onClick={handleClick}
      className="no-drag"
    >
      {isConnected
        ? compact
          ? copy.fusionActiveShort
          : copy.fusionOpenHub
        : copy.fusionMode}
    </Button>
  );
}

export interface RemoteModeSwitchProps {
  computerKey: string;
  activeMode: "screen" | "fusion";
}

/**
 * Paired `[完整桌面 | 融合模式]` sculpted segmented mode switch inside `.ls-remote-subbar`.
 */
export function RemoteModeSwitch({
  computerKey,
  activeMode,
}: RemoteModeSwitchProps): JSX.Element {
  const { locale } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const copy = getRemoteCopy(locale);
  const { remotePlatform } = useRemoteComputer(computerKey);
  const fusion = useFusionState(computerKey);
  const fusionLive =
    fusion.phase === "connected" || (fusion.hubRunning && fusion.connected);
  const env = resolveLocalDesktopEnv();
  const capability = evaluateFusionCapability(computerKey, remotePlatform, {
    electron: env.electron,
    localPlatform: activePlatform,
  });

  const fusionBtn = (
    <button
      type="button"
      data-mode="fusion"
      data-live={fusionLive ? "true" : undefined}
      aria-pressed={activeMode === "fusion"}
      disabled={!capability.supported && activeMode !== "fusion"}
      className="ls-remote-mode-switch__btn no-drag"
      onClick={() => {
        if (!capability.supported) return;
        routerStore.getState().openFusion(computerKey);
      }}
    >
      <DesktopIcon name="fusion-mode" size="xs" />
      <span>{copy.fusionMode}</span>
      {fusionLive ? (
        <span className="ls-remote-mode-switch__live-dot" aria-hidden="true" />
      ) : null}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={copy.modeSwitchLabel}
      className="ls-remote-mode-switch no-drag"
    >
      <button
        type="button"
        data-mode="screen"
        aria-pressed={activeMode === "screen"}
        className="ls-remote-mode-switch__btn no-drag"
        onClick={() => {
          routerStore.getState().openScreen(computerKey);
        }}
      >
        <DesktopIcon name="remote-screen" size="xs" />
        <span>{copy.fullDesktop}</span>
      </button>
      {!capability.supported && activeMode !== "fusion" ? (
        <Tooltip
          content={fusionCapabilityMessage(capability.reason, locale)}
          wrapDisabled
        >
          {fusionBtn}
        </Tooltip>
      ) : (
        fusionBtn
      )}
    </div>
  );
}
