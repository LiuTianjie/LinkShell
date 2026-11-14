import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { useStore } from "zustand";
import {
  DESKTOP_FULLSCREEN_EVENT,
  DESKTOP_WINDOW_EVENT,
} from "../../bridge/desktop-bridge";
import {
  FULLSCREEN_SHORTCUT,
  formatShortcut,
} from "../../bridge/shortcuts";
import { hasOpenOverlay } from "../../bridge/top-layer-registry";
import { useI18n } from "../../core/i18n";
import { routerStore } from "../../core/router-store";
import {
  SCREEN_CODEC_CHOICES,
  SCREEN_FPS_CHOICES,
  SCREEN_PACING_CHOICES,
  SCREEN_WIDTH_CHOICES,
  leaveScreenFullscreen,
  requestScreenFullScreen,
  setScreenKeysCaptured,
  useScreenPreferences,
  windowFullscreenChanged,
  type ScreenCodecChoice,
  type ScreenFpsChoice,
  type ScreenFullscreen,
  type ScreenPacingChoice,
  type ScreenWidthChoice,
} from "../../core/screen-client";
import { DesktopIcon } from "../../icons";
import {
  Button,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  StatusDot,
  Toolbar,
  isImeComposing,
} from "../../primitives";
import { NativeMetalStage } from "./NativeMetalStage";
import { getRemoteCopy, type RemoteCopy } from "./remote-copy";
import type { RemoteStageStatus, ScreenTransportMode } from "./stage-types";
import {
  resolveLocalDesktopEnv,
  useRemoteComputer,
  useRemoteWindowVisible,
} from "./use-remote-computer";
import { WebRtcScreenStage } from "./WebRtcScreenStage";

export interface RemoteScreenWorkspaceProps {
  computerKey: string;
  /** Set true only when WorkspaceTopBar is intentionally omitted above this view. */
  standaloneChrome?: boolean;
}

interface ScreenAccessInfo {
  supported: boolean;
  recording?: boolean | null;
  control?: boolean | null;
  problem?: string;
}

const INITIAL_STAGE_STATUS: RemoteStageStatus = {
  phase: "connecting",
  live: false,
  displays: [],
  controlling: false,
  controlRequested: false,
  canControl: true,
  telemetry: { engine: "webrtc" },
};

function formatPathLabel(
  path: RemoteStageStatus["telemetry"]["path"],
  copy: RemoteCopy,
): string {
  if (path === "direct") return copy.screenPathDirect;
  if (path === "lan") return copy.screenPathLan;
  if (path === "relay") return copy.screenPathTurn;
  if (path === "socket") return copy.screenPathRelay;
  return "—";
}

function formatEngineLabel(
  engine: RemoteStageStatus["telemetry"]["engine"],
  copy: RemoteCopy,
): string {
  if (engine === "metal") return copy.screenEngineMetal;
  if (engine === "compat") return copy.screenEngineCompat;
  return copy.screenEngineWebRtc;
}

/**
 * Unified Remote Screen Workspace (`#7` §3.4, `#10` §2.1, `#18`, `#30`).
 * Single-header contextual HUD strip (`.ls-remote-subbar`), codec selector (including HEVC / H.264 on macOS!),
 * clipboard/privacy tools, and `tabular-nums` telemetry across macOS Native Metal
 * (`NativeMetalStage`) and Windows / Fallback WebRTC (`WebRtcScreenStage`).
 */
export function RemoteScreenWorkspace({
  computerKey,
  standaloneChrome = true,
}: RemoteScreenWorkspaceProps): JSX.Element {
  const { locale, t } = useI18n();
  const copy = getRemoteCopy(locale);
  const prefs = useScreenPreferences();
  const windowVisible = useRemoteWindowVisible();
  const activeRoute = useStore(routerStore, (s) => s.activeRoute);
  const sidebarHidden = useStore(routerStore, (s) => s.sidebarHidden);
  const canGoBack = useStore(routerStore, (s) => s.canGoBack);
  const canGoForward = useStore(routerStore, (s) => s.canGoForward);

  const {
    connection,
    displayName,
    remotePlatform,
    platformIcon,
    online,
    statusTone,
  } = useRemoteComputer(computerKey, { retainStreams: true });

  const isRouteActive =
    activeRoute.kind === "screen" && activeRoute.computerKey === computerKey;

  const [started, setStarted] = useState(true);
  const [revision, setRevision] = useState(0);
  const [transportMode, setTransportMode] =
    useState<ScreenTransportMode>("auto");
  const [fallbackReason, setFallbackReason] = useState<string | undefined>(
    undefined,
  );
  const [stageStatus, setStageStatus] =
    useState<RemoteStageStatus>(INITIAL_STAGE_STATUS);

  const [accessState, setAccessState] = useState<{
    loading: boolean;
    data?: ScreenAccessInfo;
    error?: string;
  }>({ loading: false });
  const [askingAccess, setAskingAccess] = useState(false);

  const [keysCaptured, setKeysCaptured] = useState(false);
  const [privacy, setPrivacy] = useState<{
    curtain: boolean;
    lockOnDisconnect: boolean;
    supported: boolean;
  }>({ curtain: false, lockOnDisconnect: false, supported: true });
  const [transientNote, setTransientNote] = useState<string | undefined>(
    undefined,
  );

  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenDockRevealed, setFullscreenDockRevealed] = useState(false);
  const fullscreenStateRef = useRef<ScreenFullscreen>({
    owns: false,
    fullscreen: false,
  });
  const dockHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const localEnv = resolveLocalDesktopEnv();
  const isWindowsClient =
    localEnv.localPlatform === "windows" ||
    (typeof document !== "undefined" &&
      document.documentElement.dataset.platform === "windows");
  const fullscreenShortcut = isWindowsClient
    ? "F11"
    : localEnv.localPlatform === "macos"
      ? "⌃⌘F"
      : formatShortcut(FULLSCREEN_SHORTCUT);
  const canUseNativeMetal =
    localEnv.electron && localEnv.localPlatform === "macos";
  const useNativeMetal = canUseNativeMetal && !fallbackReason;

  const selectedDisplay = prefs.byComputer[computerKey]?.display ?? 0;

  const flashNote = useCallback((note: string) => {
    setTransientNote(note);
    setTimeout(() => {
      setTransientNote((current) => (current === note ? undefined : current));
    }, 2_400);
  }, []);

  // Reset per-computer transient state when switching computers.
  useEffect(() => {
    setFallbackReason(undefined);
    setStageStatus(INITIAL_STAGE_STATUS);
    setStarted(true);
  }, [computerKey]);

  // Query `screen.access` when connected so permission & capability issues have proactive guidance.
  const refreshAccess = useCallback(
    async (ask = false) => {
      if (!connection || !online) return;
      if (ask) setAskingAccess(true);
      else setAccessState((prev) => ({ ...prev, loading: true, error: undefined }));
      try {
        const res = await connection.link.call(
          "screen.access",
          ask ? { ask: true } : {},
        );
        setAccessState({ loading: false, data: res });
      } catch (err) {
        setAccessState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (ask) setAskingAccess(false);
      }
    },
    [connection, online],
  );

  useEffect(() => {
    void refreshAccess(false);
  }, [refreshAccess]);

  // Manage system shortcut forwarding (`screenKeys`) cleanly across focus/route changes.
  const applyKeysCaptured = useCallback((next: boolean) => {
    setKeysCaptured(next);
    setScreenKeysCaptured(next);
  }, []);

  useEffect(() => {
    if (!isRouteActive || !windowVisible || !started) {
      setScreenKeysCaptured(false);
    } else if (keysCaptured) {
      setScreenKeysCaptured(true);
    }
  }, [isRouteActive, keysCaptured, started, windowVisible]);

  useEffect(() => {
    return () => {
      setScreenKeysCaptured(false);
    };
  }, []);

  // Manage desktop window fullscreen synchronization.
  const setFullscreenEnabled = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        clearTimeout(dockHideTimerRef.current);
        const next = leaveScreenFullscreen(fullscreenStateRef.current);
        if (next) fullscreenStateRef.current = next;
        setFullscreen(false);
        setFullscreenDockRevealed(false);
        requestScreenFullScreen(false);
        return;
      }
      fullscreenStateRef.current = {
        ...fullscreenStateRef.current,
        owns: true,
      };
      const accepted = requestScreenFullScreen(true, {
        immersive:
          localEnv.localPlatform === "macos" ||
          remotePlatform === "darwin" ||
          remotePlatform === "macos",
      });
      if (!accepted) {
        fullscreenStateRef.current = { owns: false, fullscreen: true };
        setFullscreen(true);
      }
    },
    [localEnv.localPlatform, remotePlatform],
  );

  // Briefly reveal the top fullscreen HUD dock on entry, and allow Esc / F11 / Ctrl+Cmd+F exit.
  useEffect(() => {
    if (!fullscreen) {
      clearTimeout(dockHideTimerRef.current);
      setFullscreenDockRevealed(false);
      return undefined;
    }
    setFullscreenDockRevealed(true);
    clearTimeout(dockHideTimerRef.current);
    dockHideTimerRef.current = setTimeout(() => {
      if (!hasOpenOverlay()) {
        setFullscreenDockRevealed(false);
      }
    }, 1_800);
    return () => {
      clearTimeout(dockHideTimerRef.current);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (typeof window === "undefined" || !isRouteActive) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      if (
        fullscreen &&
        event.key === "Escape" &&
        (!prefs.control || !stageStatus.live) &&
        !keysCaptured &&
        !hasOpenOverlay()
      ) {
        event.preventDefault();
        setFullscreenEnabled(false);
        return;
      }
      if (
        event.key === "F11" ||
        (event.ctrlKey &&
          event.metaKey &&
          event.key.toLowerCase() === "f")
      ) {
        event.preventDefault();
        setFullscreenEnabled(!fullscreen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    fullscreen,
    isRouteActive,
    keysCaptured,
    prefs.control,
     setFullscreenEnabled,
    stageStatus.live,
  ]);

  const adoptableRef = useRef(isRouteActive && started);
  adoptableRef.current = isRouteActive && started;

  useEffect(() => {
    if (!isRouteActive || !windowVisible) {
      if (fullscreenStateRef.current.fullscreen) {
        setFullscreenEnabled(false);
      }
    }
  }, [isRouteActive, setFullscreenEnabled, windowVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const syncFs = (nextFs: boolean, adopt: boolean) => {
      const updated = windowFullscreenChanged(
        fullscreenStateRef.current,
        nextFs,
        adopt,
      );
      if (!updated) return;
      fullscreenStateRef.current = {
        owns: updated.owns,
        fullscreen: updated.fullscreen,
      };
      setFullscreen(updated.fullscreen);
    };
    const onFsEvent = (event: Event) => {
      syncFs(
        (event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen ===
          true,
        false,
      );
    };
    const onWinEvent = (event: Event) => {
      syncFs(
        (event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen ===
          true,
        adoptableRef.current,
      );
    };
    window.addEventListener(DESKTOP_FULLSCREEN_EVENT, onFsEvent);
    window.addEventListener(DESKTOP_WINDOW_EVENT, onWinEvent);
    return () => {
      window.removeEventListener(DESKTOP_FULLSCREEN_EVENT, onFsEvent);
      window.removeEventListener(DESKTOP_WINDOW_EVENT, onWinEvent);
      clearTimeout(dockHideTimerRef.current);
      if (fullscreenStateRef.current.owns) {
        requestScreenFullScreen(false);
      }
    };
  }, []);

  const handleReconnect = useCallback(() => {
    setStarted(true);
    setRevision((n) => n + 1);
  }, []);

  const handleRetryNativeMetal = useCallback(() => {
    setFallbackReason(undefined);
    setStarted(true);
    setRevision((n) => n + 1);
  }, []);

  const handleDisconnect = useCallback(() => {
    setStarted(false);
    setFullscreenEnabled(false);
    setScreenKeysCaptured(false);
    setStageStatus(INITIAL_STAGE_STATUS);
  }, [setFullscreenEnabled]);

  const handlePasteToRemote = useCallback(async () => {
    if (!connection) return;
    if (!navigator.clipboard?.readText) {
      flashNote(copy.screenClipboardFailed);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        flashNote(copy.screenClipboardEmpty);
        return;
      }
      await connection.link.call("clipboard.write", {
        text: text.slice(0, 100_000),
      });
      flashNote(copy.screenClipboardSynced);
    } catch {
      flashNote(copy.screenClipboardFailed);
    }
  }, [connection, copy, flashNote]);

  const handleCopyFromRemote = useCallback(async () => {
    if (!connection) return;
    try {
      const res = await connection.link.call("clipboard.read", {});
      if (!res.text) {
        flashNote(copy.screenClipboardEmpty);
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.text);
      }
      flashNote(copy.screenClipboardSynced);
    } catch {
      flashNote(copy.screenClipboardFailed);
    }
  }, [connection, copy, flashNote]);

  const handleTogglePrivacy = useCallback(
    async (field: "curtain" | "lockOnDisconnect") => {
      if (!connection) return;
      const nextValue = !privacy[field];
      try {
        const res = await connection.link.call(
          "screen.privacy",
          field === "curtain"
            ? { curtain: nextValue }
            : { lockOnDisconnect: nextValue },
        );
        setPrivacy(res);
        if (field === "curtain") {
          flashNote(
            res.curtain
              ? copy.screenCurtainEnabledNote
              : copy.screenCurtainDisabledNote,
          );
        }
      } catch (err) {
        flashNote(err instanceof Error ? err.message : String(err));
      }
    },
    [connection, copy, flashNote, privacy],
  );

  const widthOptions = useMemo(
    () =>
      SCREEN_WIDTH_CHOICES.map((value) => ({
        value,
        label: copy.clarityChoices[value],
      })),
    [copy],
  );

  const fpsOptions = useMemo(
    () =>
      SCREEN_FPS_CHOICES.map((value) => ({
        value,
        label: copy.fpsChoices[value],
      })),
    [copy],
  );

  const codecOptions = useMemo(
    () =>
      SCREEN_CODEC_CHOICES.map((value) => ({
        value,
        label: copy.codecChoices[value],
      })),
    [copy],
  );

  const pacingOptions = useMemo(
    () =>
      SCREEN_PACING_CHOICES.map((value) => ({
        value,
        label: copy.pacingChoices[value],
      })),
    [copy],
  );

  const transportOptions = useMemo(
    () => [
      { value: "auto", label: copy.screenTransportAuto },
      { value: "compat", label: copy.screenTransportCompat },
    ],
    [copy],
  );

  const codecShortBadge = prefs.codec === "auto" ? "HEVC" : "H.264";

  const needsPermission = accessState.data?.recording === false;
  const unsupportedHost = accessState.data?.supported === false;
  const canRenderStage =
    Boolean(connection && online) &&
    started &&
    !needsPermission &&
    !unsupportedHost;
  const stageActive = canRenderStage && isRouteActive && windowVisible;

  const controlDisabled =
    !started ||
    accessState.data?.control === false ||
    (stageStatus.live && !stageStatus.canControl);

  const controlLabel = !prefs.control
    ? copy.screenControlViewOnly
    : stageStatus.controlling
      ? copy.screenControlActive
      : stageStatus.controlRequested
        ? copy.screenControlRequesting
        : copy.screenControlActive;

  const renderToolbarActions = () => (
    <Toolbar
      label={copy.screenToolbarLabel}
      className="ls-remote-subbar__actions no-drag"
    >
      {stageStatus.displays.length > 1 ? (
        <Menu
          placement="bottom-end"
          label={copy.screenDisplayLabel}
          trigger={
            <Button size="sm" variant="ghost" leadingIcon="remote-screen">
              {stageStatus.displays.find((d) => d.index === selectedDisplay)
                ?.name ?? `${copy.screenDisplayLabel} ${selectedDisplay + 1}`}
            </Button>
          }
        >
          <MenuLabel>{copy.screenDisplayLabel}</MenuLabel>
          <MenuRadioGroup
            value={String(selectedDisplay)}
            onValueChange={(val) =>
              prefs.setComputerDisplay(computerKey, Number(val))
            }
          >
            {stageStatus.displays.map((entry) => (
              <MenuRadioItem key={entry.index} value={String(entry.index)}>
                {entry.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
      ) : null}

      <Popover>
        <PopoverTrigger>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon="sliders"
            aria-label={copy.screenQualityTitle}
          >
            {codecShortBadge}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          placement="bottom-end"
          aria-label={copy.screenQualityTitle}
          className="ls-remote-popover-panel"
        >
          <h3 className="ls-remote-popover-panel__title">
            {copy.screenQualityTitle}
          </h3>

          <Select
            size="sm"
            fullWidth
            label={copy.screenClarityLabel}
            value={prefs.width}
            options={widthOptions}
            onValueChange={(val) => prefs.setWidth(val as ScreenWidthChoice)}
          />

          <Select
            size="sm"
            fullWidth
            label={copy.screenFpsLabel}
            value={prefs.maxFps}
            options={fpsOptions}
            onValueChange={(val) => prefs.setMaxFps(val as ScreenFpsChoice)}
          />

          <Select
            size="sm"
            fullWidth
            label={copy.screenCodecLabel}
            value={prefs.codec}
            options={codecOptions}
            onValueChange={(val) => prefs.setCodec(val as ScreenCodecChoice)}
          />

          {useNativeMetal ? (
            <Select
              size="sm"
              fullWidth
              label={copy.screenPacingLabel}
              value={prefs.pacing}
              options={pacingOptions}
              onValueChange={(val) =>
                prefs.setPacing(val as ScreenPacingChoice)
              }
            />
          ) : (
            <Select
              size="sm"
              fullWidth
              label={copy.screenTransportModeLabel}
              value={transportMode}
              options={transportOptions}
              onValueChange={(val) =>
                setTransportMode(val as ScreenTransportMode)
              }
            />
          )}

          {fallbackReason && canUseNativeMetal ? (
            <Button
              size="xs"
              variant="secondary"
              leadingIcon="refresh"
              onClick={handleRetryNativeMetal}
            >
              {copy.screenTryNativeAgain}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>

      <Menu
        placement="bottom-end"
        label={copy.screenToolsLabel}
        trigger={
          <IconButton
            size="icon-sm"
            variant={
              privacy.curtain || privacy.lockOnDisconnect || keysCaptured
                ? "subtle"
                : "ghost"
            }
            icon="clipboard"
            label={copy.screenToolsLabel}
          />
        }
      >
        <MenuItem
          icon="upload"
          disabled={!connection || !online}
          onSelect={() => void handlePasteToRemote()}
        >
          {copy.screenPasteToRemote}
        </MenuItem>
        <MenuItem
          icon="download"
          disabled={!connection || !online}
          onSelect={() => void handleCopyFromRemote()}
        >
          {copy.screenCopyFromRemote}
        </MenuItem>
        {started ? (
          <MenuItem icon="refresh" onSelect={handleReconnect}>
            {copy.screenReconnect}
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuCheckboxItem
          checked={keysCaptured}
          onCheckedChange={(checked) => {
            applyKeysCaptured(checked);
            flashNote(
              checked ? copy.screenKeysCapturedOn : copy.screenKeysCapturedOff,
            );
          }}
        >
          {copy.screenKeysCaptureLabel}
        </MenuCheckboxItem>
        {privacy.supported !== false ? (
          <>
            <MenuSeparator />
            <MenuLabel>{copy.screenPrivacySection}</MenuLabel>
            <MenuCheckboxItem
              checked={privacy.curtain}
              disabled={!connection || !online}
              onCheckedChange={() => void handleTogglePrivacy("curtain")}
            >
              {copy.screenPrivacyCurtain}
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={privacy.lockOnDisconnect}
              disabled={!connection || !online}
              onCheckedChange={() =>
                void handleTogglePrivacy("lockOnDisconnect")
              }
            >
              {copy.screenLockOnDisconnect}
            </MenuCheckboxItem>
          </>
        ) : null}
      </Menu>

      <Popover>
        <PopoverTrigger>
          <IconButton
            size="icon-sm"
            icon="usage-meter"
            label={copy.screenTelemetryLabel}
          />
        </PopoverTrigger>
        <PopoverContent
          placement="bottom-end"
          aria-label={copy.screenTelemetryTitle}
          className="ls-remote-popover-panel"
        >
          <h3 className="ls-remote-popover-panel__title">
            {copy.screenTelemetryTitle}
          </h3>
          <div className="ls-remote-telemetry-grid">
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricEngine}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {formatEngineLabel(stageStatus.telemetry.engine, copy)}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricPath}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {formatPathLabel(stageStatus.telemetry.path, copy)}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricResolution}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.width && stageStatus.telemetry.height
                  ? `${stageStatus.telemetry.width}×${stageStatus.telemetry.height}`
                  : "—"}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricFps}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.fps !== undefined
                  ? `${stageStatus.telemetry.fps} FPS`
                  : prefs.maxFps
                    ? `≤ ${prefs.maxFps} FPS`
                    : "—"}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricCodec}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.codec ?? codecShortBadge}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricBitrate}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.bitrateMbps !== undefined
                  ? `${stageStatus.telemetry.bitrateMbps} Mbps`
                  : "—"}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricRtt}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.rttMs !== undefined
                  ? `${Math.round(stageStatus.telemetry.rttMs)} ms`
                  : "—"}
              </span>
            </div>
            <div className="ls-remote-telemetry-cell">
              <span className="ls-remote-telemetry-cell__label">
                {copy.screenMetricDecode}
              </span>
              <span className="ls-remote-telemetry-cell__value">
                {stageStatus.telemetry.hardware === undefined
                  ? "—"
                  : stageStatus.telemetry.hardware
                    ? copy.screenDecodeHardware
                    : copy.screenDecodeSoftware}
              </span>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        variant={prefs.control ? "secondary" : "ghost"}
        aria-pressed={prefs.control}
        disabled={controlDisabled}
        disabledReason={copy.screenControlUnavailableReason}
        onClick={() => prefs.setControl(!prefs.control)}
      >
        <StatusDot
          tone={
            !prefs.control
              ? "idle"
              : stageStatus.controlling
                ? "ok"
                : "waiting"
          }
          size="sm"
        />
        <span>{controlLabel}</span>
      </Button>

      {started && !stageStatus.live ? (
        <IconButton
          size="icon-sm"
          icon="refresh"
          label={copy.screenReconnect}
          onClick={handleReconnect}
        />
      ) : null}

      <IconButton
        size="icon-sm"
        icon={fullscreen ? "minimize" : "maximize"}
        label={
          fullscreen ? copy.screenFullscreenExit : copy.screenFullscreenEnter
        }
        shortcut={fullscreenShortcut}
        onClick={() => setFullscreenEnabled(!fullscreen)}
      />

      {started ? (
        <IconButton
          size="icon-sm"
          variant="danger-ghost"
          icon="stop-square"
          label={copy.screenDisconnect}
          onClick={handleDisconnect}
        />
      ) : (
        <Button
          size="sm"
          variant="primary"
          leadingIcon="play"
          disabled={!online || !connection}
          disabledReason={!online ? copy.screenOfflineTitle : undefined}
          onClick={() => setStarted(true)}
        >
          {copy.screenStart}
        </Button>
      )}
    </Toolbar>
  );

  const stageNotice =
    transientNote ??
    stageStatus.notice ??
    (fallbackReason && stageStatus.live ? copy.screenFallbackBanner : undefined);

  const livePathLabel = stageStatus.telemetry.path
    ? formatPathLabel(stageStatus.telemetry.path, copy)
    : undefined;
  const liveRttLabel =
    stageStatus.telemetry.rttMs !== undefined
      ? `${Math.max(1, Math.round(stageStatus.telemetry.rttMs))}ms`
      : undefined;
  const nativeOwnsFullscreenHud =
    useNativeMetal && canRenderStage && stageStatus.phase !== "error";

  return (
    <section
      aria-label={`${displayName} · ${copy.fullDesktop}`}
      data-fullscreen-stage={fullscreen ? "true" : undefined}
      className="ls-remote-workspace"
      onPointerMove={(event) => {
        if (!fullscreen) return;
        const nearTop = event.clientY <= 36;
        if (nearTop) {
          clearTimeout(dockHideTimerRef.current);
          setFullscreenDockRevealed(true);
        } else if (fullscreenDockRevealed && !hasOpenOverlay()) {
          clearTimeout(dockHideTimerRef.current);
          dockHideTimerRef.current = setTimeout(() => {
            if (!hasOpenOverlay()) {
              setFullscreenDockRevealed(false);
            }
          }, 900);
        }
      }}
    >
      {!fullscreen ? (
        <div
          role="region"
          aria-label={copy.screenToolbarLabel}
          data-standalone-chrome={standaloneChrome ? "true" : undefined}
          data-sidebar-hidden={sidebarHidden ? "true" : undefined}
          className={
            standaloneChrome
              ? "ls-remote-subbar chrome-bar app-drag"
              : "ls-remote-subbar chrome-bar"
          }
        >
          <div className="ls-remote-subbar__lead no-drag">
            {sidebarHidden ? (
              <IconButton
                size="icon-sm"
                icon="sidebar-toggle"
                label={t("desktop.toggleSidebar")}
                shortcut="Mod+B"
                onClick={() => routerStore.getState().toggleSidebar()}
              />
            ) : null}
            <IconButton
              size="icon-sm"
              icon="arrow-left"
              label={copy.navBack}
              shortcut="Mod+["
              disabled={!canGoBack}
              onClick={() => routerStore.getState().back()}
            />
            <IconButton
              size="icon-sm"
              icon="arrow-right"
              label={copy.navForward}
              shortcut="Mod+]"
              disabled={!canGoForward}
              onClick={() => routerStore.getState().forward()}
            />
            <span className="ls-remote-subbar__title">
              <DesktopIcon name="remote-screen" size="sm" />
              <span>{copy.screenHeaderTitle}</span>
            </span>
            <span className="ls-remote-subbar__computer ls-remote-subbar__computer--always">
              <StatusDot tone={statusTone} size="sm" />
              <span className="ls-remote-subbar__computer-name">
                {displayName}
              </span>
            </span>
            {started && stageStatus.live ? (
              <span className="ls-remote-subbar__meta no-drag">
                <span>{formatEngineLabel(stageStatus.telemetry.engine, copy)}</span>
                {livePathLabel ? (
                  <>
                    <span className="ls-remote-subbar__meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span>{livePathLabel}</span>
                  </>
                ) : null}
                {liveRttLabel ? (
                  <>
                    <span className="ls-remote-subbar__meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span>{liveRttLabel}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>

          {renderToolbarActions()}
        </div>
      ) : !nativeOwnsFullscreenHud ? (
        <>
          <button
            type="button"
            className="ls-screen-fullscreen-handle"
            aria-label={copy.screenFullscreenExit}
            onPointerEnter={() => {
              clearTimeout(dockHideTimerRef.current);
              setFullscreenDockRevealed(true);
            }}
            onClick={() => {
              if (fullscreenDockRevealed) {
                setFullscreenEnabled(false);
              } else {
                setFullscreenDockRevealed(true);
              }
            }}
          />
          <div
            data-revealed={fullscreenDockRevealed ? "true" : undefined}
            className="ls-screen-fullscreen-dock"
          >
            <div className="ls-screen-fullscreen-bar">
              <span className="ls-remote-subbar__computer ls-remote-subbar__computer--always">
                <DesktopIcon name={platformIcon} size="xs" />
                <span className="ls-remote-subbar__computer-name">
                  {displayName}
                </span>
              </span>
              {renderToolbarActions()}
            </div>
          </div>
        </>
      ) : null}

      <div className="ls-screen-stage-shell">
        {canRenderStage && connection ? (
          useNativeMetal ? (
            <NativeMetalStage
              link={connection.link}
              streams={connection.streams}
              active={stageActive}
              fullscreen={fullscreen}
              display={selectedDisplay}
              widthChoice={prefs.width}
              fpsChoice={prefs.maxFps}
              codecChoice={prefs.codec}
              pacingChoice={prefs.pacing}
              transportMode={transportMode}
              controlWanted={prefs.control}
              remotePlatform={remotePlatform}
              revision={revision}
              onDisplayChange={(nextDisplay) =>
                prefs.setComputerDisplay(computerKey, nextDisplay)
              }
              onExitFullScreen={() => setFullscreenEnabled(false)}
              onStatusChange={setStageStatus}
              onFallback={(reason) => setFallbackReason(reason)}
            />
          ) : (
            <WebRtcScreenStage
              link={connection.link}
              streams={connection.streams}
              active={stageActive}
              fullscreen={fullscreen}
              display={selectedDisplay}
              widthChoice={prefs.width}
              fpsChoice={prefs.maxFps}
              codecChoice={prefs.codec}
              pacingChoice={prefs.pacing}
              transportMode={transportMode}
              controlWanted={prefs.control}
              remotePlatform={remotePlatform}
              revision={revision}
              onDisplayChange={(nextDisplay) =>
                prefs.setComputerDisplay(computerKey, nextDisplay)
              }
              onExitFullScreen={() => setFullscreenEnabled(false)}
              onStatusChange={setStageStatus}
            />
          )
        ) : null}

        {!online || !connection ? (
          <div role="status" className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon name={platformIcon} size="lg" />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {copy.screenOfflineTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {copy.screenOfflineDesc}
            </p>
            {fullscreen ? (
              <div className="ls-screen-overlay-card__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              </div>
            ) : null}
          </div>
        ) : unsupportedHost ? (
          <div role="status" className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon name="alert-circle" size="lg" />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {copy.screenUnsupportedTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {accessState.data?.problem ?? copy.screenUnsupportedDesc}
            </p>
            <div className="ls-screen-overlay-card__actions">
              <Button
                size="sm"
                variant="secondary"
                loading={accessState.loading}
                onClick={() => void refreshAccess(false)}
              >
                {copy.screenReconnect}
              </Button>
              {fullscreen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              ) : null}
            </div>
          </div>
        ) : needsPermission ? (
          <div role="alert" className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon name="approval-pending" size="lg" />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {copy.screenPermissionTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {accessState.data?.problem ?? copy.screenPermissionDesc}
            </p>
            <div className="ls-screen-overlay-card__actions">
              <Button
                size="sm"
                variant="primary"
                loading={askingAccess}
                onClick={() => void refreshAccess(true)}
              >
                {copy.fusionCheckPermissions}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={accessState.loading}
                onClick={() => void refreshAccess(false)}
              >
                {copy.screenReconnect}
              </Button>
              {fullscreen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              ) : null}
            </div>
          </div>
        ) : !started ? (
          <div className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon name="remote-screen" size="lg" />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {copy.screenReadyTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {copy.screenReadyDesc}
            </p>
            <div className="ls-screen-overlay-card__actions">
              <Button
                size="sm"
                variant="primary"
                leadingIcon="play"
                onClick={() => setStarted(true)}
              >
                {copy.screenStart}
              </Button>
              {fullscreen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              ) : null}
            </div>
          </div>
        ) : stageStatus.phase === "error" ? (
          <div role="alert" className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon
                name={
                  stageStatus.idle
                    ? "clock"
                    : stageStatus.taken
                      ? "remote-screen"
                      : "alert-triangle"
                }
                size="lg"
              />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {stageStatus.idle
                ? copy.screenIdlePausedTitle
                : stageStatus.taken
                  ? copy.screenTakenTitle
                  : copy.fusionConnectionErrorTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {stageStatus.idle
                ? copy.screenIdlePausedDesc
                : stageStatus.taken
                  ? copy.screenTakenDesc
                  : (stageStatus.error ?? copy.screenConnectingDesc)}
            </p>
            <div className="ls-screen-overlay-card__actions">
              <Button
                size="sm"
                variant="primary"
                leadingIcon="refresh"
                onClick={handleReconnect}
              >
                {copy.screenReconnect}
              </Button>
              {fullscreen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              ) : null}
            </div>
          </div>
        ) : !stageStatus.live ? (
          <div role="status" className="ls-screen-overlay-card">
            <span className="ls-screen-overlay-card__icon" aria-hidden="true">
              <DesktopIcon name="spinner" size="lg" />
            </span>
            <h3 className="ls-screen-overlay-card__title">
              {stageStatus.phase === "retrying"
                ? copy.screenRetryingTitle
                : copy.screenConnectingTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {copy.screenConnectingDesc}
            </p>
            {fullscreen ? (
              <div className="ls-screen-overlay-card__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="minimize"
                  onClick={() => setFullscreenEnabled(false)}
                >
                  {copy.screenFullscreenExit}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {stageNotice ? (
          <div role="status" className="ls-screen-stage-notice">
            <span>{stageNotice}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
