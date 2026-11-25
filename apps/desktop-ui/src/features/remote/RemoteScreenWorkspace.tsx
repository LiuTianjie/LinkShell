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
  DESKTOP_SHORTCUT_CAPTURE_EVENT,
  DESKTOP_WINDOW_EVENT,
  setSystemShortcutCapture,
} from "../../bridge/desktop-bridge";
import {
  FULLSCREEN_SHORTCUT,
  formatShortcut,
  isEditableTarget,
} from "../../bridge/shortcuts";
import { hasOpenOverlay, notifyOverlayLayout } from "../../bridge/top-layer-registry";
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
import { getRemoteCopy, localizeRemoteMessage, type RemoteCopy } from "./remote-copy";
import { uploadDroppedFilesToScreen } from "./screen-upload";
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

function hasFilesInTransfer(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.types && Array.from(dt.types).includes("Files")) return true;
  return false;
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
    machineInfo,
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
  const [systemShortcutsCaptured, setSystemShortcutsCaptured] = useState(false);
  const systemShortcutsRef = useRef(false);
  systemShortcutsRef.current = systemShortcutsCaptured;
  const [audioEnabled, setAudioEnabled] = useState(false);
  const audioUnlockRef = useRef<(() => void) | undefined>(undefined);
  const dragDepthRef = useRef(0);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const [uploadBanner, setUploadBanner] = useState<string | undefined>(undefined);
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
  const isMacClient =
    localEnv.localPlatform === "macos" &&
    (typeof document === "undefined" ||
      document.documentElement.dataset.platform !== "windows");
  const fullscreenShortcut = isMacClient
    ? "⌃⌘F"
    : localEnv.localPlatform === "windows" || localEnv.localPlatform === "linux"
      ? "F11"
      : formatShortcut(FULLSCREEN_SHORTCUT);
  const canUseNativeMetal =
    localEnv.electron && localEnv.localPlatform === "macos";
  const canUseSystemShortcutCapture = canUseNativeMetal;
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
    setAudioEnabled(false);
    setDragOverUpload(false);
    dragDepthRef.current = 0;
    if (canUseSystemShortcutCapture && systemShortcutsRef.current) {
      systemShortcutsRef.current = false;
      setSystemShortcutsCaptured(false);
      void setSystemShortcutCapture(false);
    }
  }, [canUseSystemShortcutCapture, computerKey]);

  // The host keeps the curtain and lock-on-disconnect between viewers: show what it has, per
  // computer, so the first click changes what it says it changes.
  useEffect(() => {
    setPrivacy({ curtain: false, lockOnDisconnect: false, supported: true });
    if (!connection || !online) return undefined;
    let alive = true;
    connection.link
      .call("screen.privacy", {})
      .then((res) => {
        if (alive) setPrivacy(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [computerKey, connection, online]);

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

  // Manage macOS native CGEventTap system shortcut capture with automatic blur/unmount/disconnect reset.
  const applySystemShortcutCapture = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      if (!canUseSystemShortcutCapture) {
        systemShortcutsRef.current = false;
        setSystemShortcutsCaptured(false);
        return false;
      }
      if (!enabled) {
        systemShortcutsRef.current = false;
        setSystemShortcutsCaptured(false);
        await setSystemShortcutCapture(false);
        return false;
      }
      const applied = await setSystemShortcutCapture(true);
      systemShortcutsRef.current = applied;
      setSystemShortcutsCaptured(applied);
      if (applied) setScreenKeysCaptured(true);
      return applied;
    },
    [canUseSystemShortcutCapture],
  );

  useEffect(() => {
    if (!canUseSystemShortcutCapture) return undefined;
    if (!isRouteActive || !windowVisible || !started || !online || !connection) {
      if (systemShortcutsRef.current) {
        systemShortcutsRef.current = false;
        setSystemShortcutsCaptured(false);
        void setSystemShortcutCapture(false);
      }
      return undefined;
    }
    return undefined;
  }, [canUseSystemShortcutCapture, connection, isRouteActive, online, started, windowVisible]);

  useEffect(() => {
    if (!canUseSystemShortcutCapture || typeof window === "undefined") return undefined;
    const onBlur = () => {
      if (systemShortcutsRef.current) {
        systemShortcutsRef.current = false;
        setSystemShortcutsCaptured(false);
      }
      void setSystemShortcutCapture(false);
    };
    const onMainSync = (event: Event) => {
      const captured = (event as CustomEvent<{ captured?: unknown }>).detail?.captured;
      if (captured === false) {
        systemShortcutsRef.current = false;
        setSystemShortcutsCaptured(false);
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener(DESKTOP_SHORTCUT_CAPTURE_EVENT, onMainSync);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener(DESKTOP_SHORTCUT_CAPTURE_EVENT, onMainSync);
      systemShortcutsRef.current = false;
      void setSystemShortcutCapture(false);
    };
  }, [canUseSystemShortcutCapture]);

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
      const isBareF11 =
        event.key === "F11" &&
        !event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey;
      const isMacFullscreenChord =
        event.ctrlKey &&
        event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (isBareF11 || isMacFullscreenChord) {
        if (document.querySelector("dialog[open]")) return;
        if (!fullscreen && (hasOpenOverlay() || isEditableTarget(event.target))) return;
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
    if (canUseSystemShortcutCapture) {
      systemShortcutsRef.current = false;
      setSystemShortcutsCaptured(false);
      void setSystemShortcutCapture(false);
    }
    setStageStatus(INITIAL_STAGE_STATUS);
  }, [canUseSystemShortcutCapture, setFullscreenEnabled]);

  const handleToggleAudio = useCallback(() => {
    const next = !audioEnabled;
    if (next) {
      // Synchronously create/resume WebAudio AudioContext on user gesture.
      audioUnlockRef.current?.();
    }
    setAudioEnabled(next);
    flashNote(next ? copy.screenAudioEnabledNote : copy.screenAudioMutedNote);
  }, [audioEnabled, copy.screenAudioEnabledNote, copy.screenAudioMutedNote, flashNote]);

  const handleRegisterAudioUnlock = useCallback((unlock: (() => void) | undefined) => {
    audioUnlockRef.current = unlock;
  }, []);

  const handleToggleSystemShortcutCapture = useCallback(async () => {
    const wanted = !systemShortcutsCaptured;
    const applied = await applySystemShortcutCapture(wanted);
    if (wanted) {
      flashNote(
        applied
          ? copy.screenSystemShortcutCapturedOn
          : copy.screenSystemShortcutUnavailable,
      );
    } else {
      flashNote(copy.screenSystemShortcutCapturedOff);
    }
  }, [
    applySystemShortcutCapture,
    copy.screenSystemShortcutCapturedOff,
    copy.screenSystemShortcutCapturedOn,
    copy.screenSystemShortcutUnavailable,
    flashNote,
    systemShortcutsCaptured,
  ]);

  const handleDropUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (!connection || !online) {
        flashNote(copy.screenOfflineTitle);
        return;
      }
      try {
        const res = await uploadDroppedFilesToScreen({
          connection,
          files,
          remoteHome: machineInfo?.home,
          remotePlatform,
          onProgress: ({ index, total, fileName }) => {
            setUploadBanner(copy.screenUploadProgress(index, total, fileName));
          },
        });
        setUploadBanner(undefined);
        if (res.skippedNames.length > 0 && res.uploadedPaths.length === 0 && res.failedErrors.length === 0) {
          flashNote(copy.screenUploadTooLarge(res.skippedNames[0]!));
        } else if (res.failedErrors.length > 0 || res.skippedNames.length > 0) {
          const failedCount = res.failedErrors.length + res.skippedNames.length;
          if (res.uploadedPaths.length > 0) {
            flashNote(copy.screenUploadPartialFailed(res.uploadedPaths.length, failedCount, res.dir));
          } else {
            flashNote(copy.screenUploadFailed(res.failedErrors[0] ?? copy.screenUploadTooLarge(res.skippedNames[0]!)));
          }
        } else if (res.uploadedPaths.length > 0) {
          flashNote(copy.screenUploadComplete(res.uploadedPaths.length, res.dir));
        }
      } catch (err) {
        setUploadBanner(undefined);
        flashNote(copy.screenUploadFailed(err instanceof Error ? err.message : String(err)));
      }
    },
    [connection, copy, flashNote, machineInfo?.home, online, remotePlatform],
  );

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

          <Select
            size="sm"
            fullWidth
            label={copy.screenMatchLabel}
            value={prefs.match ? "viewer" : "remote"}
            options={[
              { value: "viewer", label: copy.screenMatchViewer },
              { value: "remote", label: copy.screenMatchRemote },
            ]}
            onValueChange={(val) => prefs.setMatch(val === "viewer")}
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
        {canUseSystemShortcutCapture ? (
          <MenuCheckboxItem
            checked={systemShortcutsCaptured}
            disabled={!started || !online || !connection}
            shortcut="⌃⌥⌘Esc"
            onCheckedChange={() => {
              void handleToggleSystemShortcutCapture();
            }}
          >
            {copy.screenSystemShortcutCaptureLabel}
          </MenuCheckboxItem>
        ) : null}
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

      {canUseSystemShortcutCapture ? (
        <Button
          size="sm"
          variant={systemShortcutsCaptured ? "secondary" : "ghost"}
          leadingIcon="command"
          aria-pressed={systemShortcutsCaptured}
          disabled={!started || !online || !connection}
          title={`${copy.screenSystemShortcutCaptureLabel} · ${copy.screenSystemShortcutEscapeHint}`}
          onClick={() => {
            void handleToggleSystemShortcutCapture();
          }}
        >
          <span>
            {systemShortcutsCaptured
              ? copy.screenSystemShortcutEscapeHint
              : copy.screenSystemShortcutCaptureLabel}
          </span>
        </Button>
      ) : null}

      <IconButton
        size="icon-sm"
        variant={audioEnabled ? "subtle" : "ghost"}
        icon={audioEnabled ? "volume-2" : "volume-x"}
        aria-pressed={audioEnabled}
        label={audioEnabled ? copy.screenAudioOn : copy.screenAudioMuted}
        disabled={!started || !online || !connection || stageStatus.audioAvailable === false}
        onClick={handleToggleAudio}
      />

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
    uploadBanner ??
    transientNote ??
    (stageStatus.notice ? localizeRemoteMessage(stageStatus.notice) : undefined) ??
    // The reason, not a guess: a decoder or a sender can fail as well as the network.
    (fallbackReason && stageStatus.live ? copy.screenFallbackBanner + localizeRemoteMessage(fallbackReason) : undefined);

  useEffect(() => {
    if (useNativeMetal) notifyOverlayLayout();
  }, [dragOverUpload, stageNotice, useNativeMetal]);

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

      <div
        className="ls-screen-stage-shell"
        onDragEnter={(event) => {
          if (!hasFilesInTransfer(event.dataTransfer)) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setDragOverUpload(true);
        }}
        onDragOver={(event) => {
          if (!hasFilesInTransfer(event.dataTransfer)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          if (!dragOverUpload) setDragOverUpload(true);
        }}
        onDragLeave={() => {
          if (!dragOverUpload) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) {
            setDragOverUpload(false);
          }
        }}
        onDrop={(event) => {
          dragDepthRef.current = 0;
          setDragOverUpload(false);
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return;
          event.preventDefault();
          void handleDropUpload(files);
        }}
      >
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
              matchResolution={prefs.match}
              pacingChoice={prefs.pacing}
              transportMode={transportMode}
              controlWanted={prefs.control}
              audioEnabled={audioEnabled}
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
              matchResolution={prefs.match}
              pacingChoice={prefs.pacing}
              transportMode={transportMode}
              controlWanted={prefs.control}
              audioEnabled={audioEnabled}
              remotePlatform={remotePlatform}
              revision={revision}
              onDisplayChange={(nextDisplay) =>
                prefs.setComputerDisplay(computerKey, nextDisplay)
              }
              onExitFullScreen={() => setFullscreenEnabled(false)}
              onStatusChange={setStageStatus}
              onRegisterAudioUnlock={handleRegisterAudioUnlock}
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
                  : copy.screenErrorTitle}
            </h3>
            <p className="ls-screen-overlay-card__desc">
              {stageStatus.idle
                ? copy.screenIdlePausedDesc
                : stageStatus.taken
                  ? copy.screenTakenDesc
                  : stageStatus.error
                    ? localizeRemoteMessage(stageStatus.error)
                    : copy.screenConnectingDesc}
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

        {dragOverUpload ? (
          <div
            role="status"
            className="ls-screen-drop-overlay"
            data-native-overlay={useNativeMetal ? "" : undefined}
          >
            <DesktopIcon name="upload" size="lg" />
            <strong>{copy.screenDropUploadTitle}</strong>
            <span>{copy.screenDropUploadDesc}</span>
          </div>
        ) : null}

        {stageNotice ? (
          <div
            role="status"
            className="ls-screen-stage-notice"
            // Over the Mac's native picture, which would otherwise cover it.
            data-native-overlay={useNativeMetal ? "" : undefined}
          >
            <span>{stageNotice}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
