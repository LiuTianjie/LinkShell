import {
   useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  DESKTOP_FULLSCREEN_EVENT,
  DESKTOP_LOCAL,
  DESKTOP_NATIVE_SCREEN_EVENT,
  DESKTOP_SURFACE_EVENT,
  DESKTOP_WINDOW_EVENT,
  getActiveDesktopPlatform,
  isElectronDesktop,
  isElectronRuntime,
  normalizeDesktopPlatform,
  notifyDesktopPlatformChanged,
  postDesktopMessage,
  type DesktopPlatform,
} from "../../bridge/desktop-bridge";
import {
  DESKTOP_SHORTCUT_META,
  DESKTOP_SHORTCUTS,
  isEditableTarget,
  isImeComposing,
  keysBelongToRemoteOrPreview,
  matchesShortcut,
  requestCloseTab,
  requestComposerFocus,
  requestGoToFile,
  useDesktopCommand,
  type DesktopShortcutId,
  type ShortcutBinding,
} from "../../bridge/shortcuts";
import { registerOverlayOpen } from "../../bridge/top-layer-registry";
import {
  canUseFusionMode,
  computerNames,
  connectAndStartComputerFusion,
  engine,
  healthy,
  routerStore,
  serviceAction,
  sessionTitle,
  setNavigationConfirmer,
  useI18n,
  useManagement,
  useRouter,
  type Computer,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import {
  Button,
  EmptyState,
  ErrorBoundary,
  IconButton,
  SplitResizer,
  StatusDot,
  useDialogs,
} from "../../primitives";
import { AccessUnlockView } from "./AccessUnlockView";
import { ArchiveView } from "./ArchiveView";
import { CommandCenter } from "./CommandCenter";
import { ComputersFleetView } from "./ComputersFleetView";
import { ProjectsOverview } from "./ProjectsOverview";
import {
  displayComputerName,
  folderBasename,
  formatRelativeTimestamp,
  isLocalComputer,
  isRouteStillValid,
  openSessionOnComputer,
  sessionActivity,
  sessionListState,
  sessionRecency,
  useConnectionStore,
  useMinuteTick,
  visibleSidebarSessions,
  type ShellRenderSlots,
} from "./shell-helpers";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { Sidebar } from "./Sidebar";
import { WorkspaceSurfaceTabs } from "./WorkspaceSurfaceTabs";
import { WorkspaceTopBar } from "./WorkspaceTopBar";

function RenderSlot({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

const NOTICE_DISMISS_MS = 6_000;

/** The one place failed actions surface; before it, `engine.state.error` was written and never shown. */
function ShellNoticeHost() {
  const { t } = useI18n();
  const error = useStore(engine.state, (s) => s.error);
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => {
      if (engine.state.getState().error === error) engine.clearError();
    }, NOTICE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error]);
  if (!error) return null;
  return (
    <div className="shell-notice" role="alert">
      <DesktopIcon name="alert-circle" size="sm" className="shell-notice__icon" />
      <span className="shell-notice__text">{error}</span>
      <IconButton
        icon="close"
        size="icon-sm"
        variant="ghost"
        label={t("desktop.shell.dismiss")}
        onClick={() => engine.clearError()}
      />
    </div>
  );
}

/** Lets ⌘W / the menu's Close dismiss the topmost overlay first, the way native windows do. */
function closeTopOverlay(): boolean {
  if (typeof document === "undefined") return false;
  const router = routerStore.getState();
  if (router.commandCenterOpen) {
    router.setCommandCenterOpen(false);
    return true;
  }
  if (router.shortcutSheetOpen) {
    router.setShortcutSheetOpen(false);
    return true;
  }
  const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
  const top = dialogs[dialogs.length - 1];
  if (top) {
    const closable = top as HTMLDialogElement & { requestClose?: () => void };
    if (typeof closable.requestClose === "function") closable.requestClose();
    else top.close();
    return true;
  }
  if (router.systemModal.open) {
    router.closeSystemModal();
    return true;
  }
  return false;
}

export interface DesktopAppShellProps extends ShellRenderSlots {
  /** Optional platform override used in deterministic cross-platform UI tests. */
  platformOverride?: DesktopPlatform;
}

interface WorkspaceHomeHubProps {
  activeComputer: Computer | undefined;
  effectivePlatform: DesktopPlatform;
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
}

function WorkspaceHomeHub({
  activeComputer,
  effectivePlatform,
  onRequestNewSession,
}: WorkspaceHomeHubProps) {
  const { locale, t } = useI18n();
  const mgmt = useManagement();
  const openSession = useRouter((s) => s.openSession);
  const openFusion = useRouter((s) => s.openFusion);
  const openScreen = useRouter((s) => s.openScreen);
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);
  const openSystemModal = useRouter((s) => s.openSystemModal);

  const computers = useStore(engine.state, (s) => s.computers);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);
  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);
  const linkStatus = useConnectionStore(activeConnection, (s) => s.status);
  const sessionsLoaded = useConnectionStore(activeConnection, (s) => s.sessionsLoaded);
  useMinuteTick();

  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;
  const compTitle = displayComputerName(activeComputer, names, locale);
  const isLocal = isLocalComputer(activeComputer);
  const listState = sessionListState(activeComputer, linkStatus, sessionsLoaded);

  // Local daemon stopped state: give immediate 1-click Start Service CTA without trapping navigation
  if (isLocal && mgmt.snapshot?.status === "stopped" && !healthy(mgmt)) {
    return (
      <div className="shell-page" style={{ display: "flex", alignItems: "center" }}>
        <EmptyState
          icon="host-daemon"
          title={t("desktop.fleet.localStoppedTitle")}
          description={t("desktop.fleet.localStoppedDesc", { computer: compTitle })}
          actions={
            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Button
                variant="primary"
                leadingIcon="play"
                loading={mgmt.busy}
                onClick={() => void serviceAction("start")}
              >
                {t("desktop.manage.startService")}
              </Button>
              <Button
                variant="secondary"
                leadingIcon="pair-qr"
                onClick={() => setConnectModalOpen(true)}
              >
                {t("desktop.fleet.connectComputer")}
              </Button>
              <Button
                variant="ghost"
                leadingIcon="settings"
                onClick={() => openSystemModal("overview")}
              >
                {t("desktop.localManagement")}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const recentSessions = Object.values(sessionsMap)
    .filter((s) => !s.archived)
    .sort((a, b) => sessionRecency(b) - sessionRecency(a))
    .slice(0, 8);

  const electronShell = isElectronRuntime();
  const fusionCandidates = computers.filter(
    (c) =>
      c.key !== DESKTOP_LOCAL &&
      c.machine.online &&
      canUseFusionMode(c.key, c.machine.platform, {
        electron: electronShell,
        localPlatform: effectivePlatform,
      }),
  );

  return (
    <div className="shell-page">
      <div className="shell-page__inner home-hub">
        <div className="home-compact-header">
          <div className="shell-page__heading">
            <h1 className="shell-page__title">{compTitle}</h1>
            <p className="shell-page__subtitle">{t("desktop.shell.homeSubtitle")}</p>
          </div>

          <div className="shell-page__actions">
            {!isLocal && activeComputer ? (
              <Button
                variant="secondary"
                leadingIcon="remote-screen"
                disabled={!activeComputer.machine.online}
                onClick={() => openScreen(activeComputer.key)}
              >
                {t("desktop.screen.openDesktop")}
              </Button>
            ) : null}

            <Button
              variant="primary"
              leadingIcon="plus"
              disabled={listState === "offline"}
              onClick={() => onRequestNewSession(activeComputerKey)}
            >
              {t("desktop.newSession")}
            </Button>
          </div>
        </div>

        {listState !== "ready" && recentSessions.length === 0 ? (
          <div className="home-state" data-state={listState}>
            {listState === "loading" ? <DesktopIcon name="spinner" size="sm" /> : null}
            <span>
              {listState === "loading"
                ? t("desktop.shell.connectingTo", { name: compTitle })
                : t("desktop.shell.offlineTitle", { name: compTitle })}
            </span>
            {listState === "offline" ? (
              <span className="home-state__hint">{t("desktop.shell.offlineDesc")}</span>
            ) : null}
          </div>
        ) : null}

        {/* Concise Fusion Mode Quick Row when eligible remote Macs are online */}
        {fusionCandidates.length > 0 ? (
          <div className="home-fusion-list">
            {fusionCandidates.map((mac) => {
              const macName = displayComputerName(mac, names, locale);
              return (
                <div key={mac.key} className="home-fusion-row">
                  <div className="home-fusion-row__body">
                    <span className="home-fusion-row__title">
                      <DesktopIcon name="fusion-mode" size="sm" style={{ color: "var(--ls-accent)" }} />
                      <span>{macName}</span>
                    </span>
                    <span className="home-fusion-row__subtitle">
                      {t("desktop.fusion.subtitle")}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon="fusion-mode"
                    onClick={() => {
                      engine.select(mac);
                      openFusion(mac.key);
                      void connectAndStartComputerFusion(mac.key);
                    }}
                  >
                    {t("desktop.fusion.start")}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}

        {recentSessions.length > 0 ? (
          <div className="home-recent-section">
            <h2 className="home-recent-section__heading">
              {t("desktop.shell.recentSessions")}
            </h2>
            <div className="home-recent-list">
              {recentSessions.map((session) => {
                const activity = sessionActivity(session, locale);
                return (
                <button
                  key={session.id}
                  type="button"
                  className="home-recent-row"
                  onClick={() => openSession(activeComputerKey, session.id)}
                >
                  <span className="home-recent-row__lead" aria-hidden="true">
                    <AgentMark agent={session.agent} size={15} />
                    {activity ? (
                      <StatusDot tone={activity.kind} size="sm" className="tree-session__dot" />
                    ) : null}
                  </span>
                  <span className="home-recent-row__title ls-truncate">
                    {sessionTitle(session)}
                  </span>
                  {activity ? (
                    <span className={`tree-session__pill tree-session__pill--${activity.kind}`}>
                      {activity.label}
                    </span>
                  ) : null}
                  <span className="home-recent-row__cwd ls-truncate">
                    {folderBasename(session.cwd)}
                  </span>
                  <span className="home-recent-row__time">
                    {formatRelativeTimestamp(sessionRecency(session), locale)}
                  </span>
                </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DesktopAppShell({
  platformOverride,
  renderSessionWorkspace,
  renderNewSessionWorkspace,
  renderSessionHeaderActions,
  renderInspector,
  renderBottomTerminal,
  renderStandaloneTool,
  renderFusionWorkspace,
  renderRemoteScreenWorkspace,
  renderFusionStatusBadge,
  renderFusionQuickTrigger,
  onOpenLocalPairingQr,
}: DesktopAppShellProps) {
  const { t } = useI18n();
  const dialogs = useDialogs();
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const [runtimePlatform, setRuntimePlatform] = useState<DesktopPlatform>(() =>
    getActiveDesktopPlatform(),
  );
  const effectivePlatform = platformOverride ?? runtimePlatform;

  const activeRoute = useRouter((s) => s.activeRoute);
  const sidebarHidden = useRouter((s) => s.sidebarHidden);
  const sidebarWidth = useRouter((s) => s.sidebarWidth);
  const inspectorOpen = useRouter((s) => s.inspectorOpen);
  const inspectorWidth = useRouter((s) => s.inspectorWidth);
  const bottomDockOpen = useRouter((s) => s.bottomDockOpen);
  const bottomDockHeight = useRouter((s) => s.bottomDockHeight);

  const openNewSession = useRouter((s) => s.openNewSession);
  const openSystemModal = useRouter((s) => s.openSystemModal);
  const toggleSidebar = useRouter((s) => s.toggleSidebar);
  const setSidebarWidth = useRouter((s) => s.setSidebarWidth);
  const toggleInspector = useRouter((s) => s.toggleInspector);
  const toggleBottomDock = useRouter((s) => s.toggleBottomDock);
  const back = useRouter((s) => s.back);
  const forward = useRouter((s) => s.forward);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const locked = useStore(engine.state, (s) => s.locked);
  const mgmt = useManagement();

  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);
  const linkStatus = useConnectionStore(activeConnection, (s) => s.status);
  const sessionsLoaded = useConnectionStore(activeConnection, (s) => s.sessionsLoaded);
  const restoredRoute = useRouter((s) => s.restoredRoute);

  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [windowFocused, setWindowFocused] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [nativeScreenActive, setNativeScreenActive] = useState(false);
  const [surfaceOpaque, setSurfaceOpaque] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);
  const peekCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressPeekUntilRef = useRef(0);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;

  const handleRequestNewSession = useCallback(
    (computerKey?: string, cwd?: string) => {
      setNewSessionNonce((n) => n + 1);
      openNewSession(computerKey ?? activeComputerKey, cwd);
    },
    [activeComputerKey, openNewSession],
  );

  // Leaving the session family unmounts its panels; ask through the app's own dialog, not window.confirm.
  useEffect(
    () =>
      setNavigationConfirmer(() =>
        dialogs.confirm(t("desktop.shell.leaveSessionConfirm"), {
          title: t("desktop.shell.leaveSessionTitle"),
          confirmLabel: t("desktop.shell.leave"),
          cancelLabel: t("desktop.shell.cancel"),
          destructive: true,
        }),
      ),
    [dialogs, t],
  );

  useEffect(() => {
    const router = routerStore.getState();
    router.setRouteValidator(isRouteStillValid);
    return () => router.setRouteValidator(undefined);
  }, []);

  // A route restored from the last run may name a session deleted since; once the list is in, check.
  useEffect(() => {
    if (!restoredRoute) return;
    const route = activeRoute;
    if (route.kind !== "session") {
      routerStore.getState().markRouteVerified();
      return;
    }
    if (!activeConnection || activeConnection.computer.key !== route.computerKey) {
      if (!isRouteStillValid(route)) routerStore.getState().forgetSession(route.computerKey, route.sessionId);
      return;
    }
    if (!sessionsLoaded) return;
    if (sessionsMap[route.sessionId]) routerStore.getState().markRouteVerified();
    else routerStore.getState().forgetSession(route.computerKey, route.sessionId);
  }, [activeConnection, activeRoute, restoredRoute, sessionsLoaded, sessionsMap, computers]);

  const handleToggleSidebar = useCallback(() => {
    const willCollapse = !routerStore.getState().sidebarHidden;
    if (willCollapse) {
      suppressPeekUntilRef.current = Date.now() + 450;
      setPeekOpen(false);
    }
    toggleSidebar();
  }, [toggleSidebar]);

  // Sync window/surface/fullscreen/native-screen custom events from Electron preload
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const onSurface = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          opaque?: boolean;
          translucent?: boolean;
          value?: string;
        }>
      ).detail ?? {};
      if (typeof detail.translucent === "boolean") {
        setSurfaceOpaque(!detail.translucent);
      } else if (typeof detail.opaque === "boolean") {
        setSurfaceOpaque(detail.opaque);
      } else if (detail.value === "opaque") {
        setSurfaceOpaque(true);
      } else if (detail.value === "translucent") {
        setSurfaceOpaque(false);
      }
    };

    const onWindowState = (event: Event) => {
      const detail = ((
        event as CustomEvent<{ focused?: boolean; fullscreen?: boolean }>
      ).detail ?? {});
      if (typeof detail.focused === "boolean") setWindowFocused(detail.focused);
      if (typeof detail.fullscreen === "boolean") setIsFullscreen(detail.fullscreen);
    };

    const onFullscreen = (event: Event) => {
      const detail = ((event as CustomEvent<{ fullscreen?: boolean; value?: boolean }>).detail ??
        {});
      const next = detail.fullscreen ?? detail.value ?? Boolean(document.fullscreenElement);
      setIsFullscreen(Boolean(next));
    };

    const onDomFullscreen = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    const onNativeScreen = (event: Event) => {
      const detail = ((event as CustomEvent<{ active?: boolean; state?: string }>).detail ?? {});
      if (typeof detail.active === "boolean") {
        setNativeScreenActive(detail.active);
      } else if (typeof detail.state === "string") {
        setNativeScreenActive(detail.state === "active" || detail.state === "connected");
      }
    };

    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);

    window.addEventListener(DESKTOP_SURFACE_EVENT, onSurface);
    window.addEventListener(DESKTOP_WINDOW_EVENT, onWindowState);
    window.addEventListener(DESKTOP_FULLSCREEN_EVENT, onFullscreen);
    window.addEventListener(DESKTOP_NATIVE_SCREEN_EVENT, onNativeScreen);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onDomFullscreen);

    return () => {
      window.removeEventListener(DESKTOP_SURFACE_EVENT, onSurface);
      window.removeEventListener(DESKTOP_WINDOW_EVENT, onWindowState);
      window.removeEventListener(DESKTOP_FULLSCREEN_EVENT, onFullscreen);
      window.removeEventListener(DESKTOP_NATIVE_SCREEN_EVENT, onNativeScreen);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onDomFullscreen);
    };
  }, []);

  // Preserve pre-mount documentElement platform for isolated test teardown
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const prevPlatform = document.documentElement.dataset.platform;
    return () => {
      if (prevPlatform === undefined) {
        delete document.documentElement.dataset.platform;
      } else {
        document.documentElement.dataset.platform = prevPlatform;
      }
      notifyDesktopPlatformChanged();
    };
  }, []);

  // Mirror platform & fullscreen onto documentElement synchronously before paint so Top-Layer <dialog>, <Kbd>, and i18n adapt immediately
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.platform = effectivePlatform;
    if (isFullscreen) {
      document.documentElement.dataset.fullscreen = "true";
    } else {
      delete document.documentElement.dataset.fullscreen;
    }
    notifyDesktopPlatformChanged();
  }, [effectivePlatform, isFullscreen]);

  // Honor live `data-platform` attribute switches on `:root` or `.desktop-root` when `platformOverride` is unset
  useEffect(() => {
    if (
      platformOverride ||
      typeof MutationObserver === "undefined" ||
      typeof document === "undefined"
    ) {
      return undefined;
    }
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        const target = rec.target as HTMLElement;
        const next = normalizeDesktopPlatform(target?.dataset?.platform);
        if (next) {
          setRuntimePlatform((prev) => (prev === next ? prev : next));
        }
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-platform"],
    });
    if (rootElRef.current) {
      observer.observe(rootElRef.current, {
        attributes: true,
        attributeFilter: ["data-platform"],
      });
    }
    return () => observer.disconnect();
  }, [platformOverride]);

  // Close hover peek whenever docked sidebar re-opens
  useEffect(() => {
    if (!sidebarHidden) {
      setPeekOpen(false);
    }
  }, [sidebarHidden]);

  const handleCloseTab = useCallback(() => {
    if (closeTopOverlay()) return;
    if (requestCloseTab()) return;
    const router = routerStore.getState();
    if (router.bottomDockOpen && router.activeRoute.kind === "session") {
      router.toggleBottomDock(false);
      return;
    }
    postDesktopMessage({ action: "closeWindow" });
  }, []);

  useDesktopCommand((command) => {
    if (command.command === "close-tab") handleCloseTab();
    else if (command.command === "composer") requestComposerFocus();
  });

  // Global keyboard shortcuts (honoring remote-screen capture & CJK IME composition guards)
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const stepSession = (offset: number | { index: number }) => {
      const rows = visibleSidebarSessions();
      if (rows.length === 0) return;
      const route = routerStore.getState().activeRoute;
      let target: (typeof rows)[number] | undefined;
      if (typeof offset === "number") {
        const current =
          route.kind === "session"
            ? rows.findIndex(
                (row) => row.computerKey === route.computerKey && row.sessionId === route.sessionId,
              )
            : -1;
        const next = current < 0 ? (offset > 0 ? 0 : rows.length - 1) : current + offset;
        target = rows[Math.max(0, Math.min(rows.length - 1, next))];
      } else {
        target = rows[offset.index];
      }
      if (target) openSessionOnComputer(target.computerKey, target.sessionId);
    };

    const run: Record<DesktopShortcutId, () => void> = {
      palette: () => {
        const r = routerStore.getState();
        r.setCommandCenterOpen(!r.commandCenterOpen);
      },
      newSession: () => {
        const r = routerStore.getState();
        // ⌘N from a session starts in that session's project, like a new tab in the same folder.
        const route = r.activeRoute;
        if (route.kind === "session") {
          const session = engine.state.getState().connection?.store.getState().sessions[route.sessionId];
          handleRequestNewSession(route.computerKey, session?.cwd || undefined);
          return;
        }
        handleRequestNewSession();
      },
      settings: () => openSystemModal("settings"),
      back: () => back(),
      forward: () => forward(),
      previousSession: () => stepSession(-1),
      nextSession: () => stepSession(1),
      closeTab: () => handleCloseTab(),
      toggleSidebar: () => handleToggleSidebar(),
      terminal: () => {
        // Closing the terminal hands the keyboard back to the conversation, not to nothing.
        const wasOpen = routerStore.getState().bottomDockOpen;
        toggleBottomDock();
        if (wasOpen) requestComposerFocus();
      },
      toggleInspector: () => toggleInspector(),
      focusComposer: () => requestComposerFocus(),
      goToFile: () => {
        toggleInspector(true, "files");
        requestGoToFile();
      },
      findInSession: () => {
        // The session workspace owns its find bar; route the key there however focus wandered.
        const workspace = document.querySelector<HTMLElement>(".ls-session-workspace");
        workspace?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
            metaKey: getActiveDesktopPlatform() !== "windows",
            ctrlKey: getActiveDesktopPlatform() === "windows",
            bubbles: true,
            cancelable: true,
          }),
        );
      },
    };

    // Keys that edit text where they land: ⌘[ / ⌘] indent in editors, so they stay with the field.
    const editingKeys = new Set<DesktopShortcutId>(["back", "forward"]);

    // Where Ctrl is the app's modifier it is also the shell's: in a terminal ^K ^L ^W ^B ^N ^P ^F
    // and ^[ belong to readline and tmux. Only chords that mean nothing to a shell still reach
    // the app from there (⌘ on a Mac never collides).
    const shellSafeKeys = new Set<DesktopShortcutId>(["terminal", "settings"]);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      if (keysBelongToRemoteOrPreview()) return;
      const inSession = routerStore.getState().activeRoute.kind === "session";
      const editable = isEditableTarget(event.target);
      const inCtrlTerminal =
        getActiveDesktopPlatform() === "windows" &&
        event.target instanceof Element &&
        Boolean(event.target.closest(".xterm"));

      for (const id of Object.keys(DESKTOP_SHORTCUTS) as DesktopShortcutId[]) {
        const binding: ShortcutBinding = DESKTOP_SHORTCUTS[id];
        if (!matchesShortcut(event, binding)) continue;
        if (inCtrlTerminal && !shellSafeKeys.has(id) && !binding.shift && !binding.alt) return;
        if (editable && editingKeys.has(id)) return;
        if (DESKTOP_SHORTCUT_META[id].scope === "session" && !inSession) return;
        if (id === "findInSession" && event.target instanceof Node) {
          // Already inside the workspace: its own handler sees this keydown, don't open the bar twice.
          const workspace = document.querySelector(".ls-session-workspace");
          if (workspace?.contains(event.target)) return;
        }
        event.preventDefault();
        run[id]();
        return;
      }

      // ⌘1…⌘9 jump to the sidebar's Nth visible session.
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit && matchesShortcut(event, { key: digit })) {
        event.preventDefault();
        stepSession({ index: Number(digit) - 1 });
        return;
      }

      // Bare `?` opens Keyboard Shortcuts sheet when focus is NOT inside an input/editor/xterm
      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !editable
      ) {
        event.preventDefault();
        const r = routerStore.getState();
        r.setShortcutSheetOpen(!r.shortcutSheetOpen);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    back,
    forward,
    handleCloseTab,
    handleRequestNewSession,
    handleToggleSidebar,
    openSystemModal,
    toggleBottomDock,
    toggleInspector,
  ]);

  // On macOS the native screen layer sits above the page; like dialogs, the drawer must make it yield.
  useEffect(() => (peekOpen ? registerOverlayOpen("sidebar-peek") : undefined), [peekOpen]);

  // Esc closes the hover drawer, matching every other transient surface.
  useEffect(() => {
    if (!peekOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return;
      suppressPeekUntilRef.current = Date.now() + 450;
      setPeekOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [peekOpen]);

  const isTranslucent =
    effectivePlatform === "macos" &&
    !mgmt.settings.opaqueWindow &&
    !surfaceOpaque &&
    windowFocused &&
    !nativeScreenActive;

  const isConnectionLocked = Boolean(
    activeConnection && (locked || linkStatus === "locked"),
  );

  // Right Side Panel & Bottom Terminal ONLY follow active session routes (#73 C.2)
  const showInspector = inspectorOpen && activeRoute.kind === "session";
  const showBottomDock = bottomDockOpen && activeRoute.kind === "session";
  const isStandaloneRemoteScreen =
    activeRoute.kind === "screen" && Boolean(renderRemoteScreenWorkspace);
  const isScreenFullscreen = activeRoute.kind === "screen" && isFullscreen;

  const currentSession =
    activeRoute.kind === "session" ? sessionsMap[activeRoute.sessionId] : undefined;
  const currentCwd =
    currentSession?.cwd ??
    (activeRoute.kind === "new-session" ? activeRoute.cwd : undefined) ??
    (activeRoute.kind === "files" ? activeRoute.path : undefined);
  const currentSessionId =
    activeRoute.kind === "session" ? activeRoute.sessionId : undefined;

  const renderMainContent = () => {
    // Computers, Projects & System views are always reachable even if a remote computer is locked
    if (activeRoute.kind === "computers") {
      return (
        <ComputersFleetView
          onRequestNewSession={handleRequestNewSession}
          onOpenLocalPairingQr={onOpenLocalPairingQr}
          renderFusionQuickTrigger={renderFusionQuickTrigger}
          renderFusionStatusBadge={renderFusionStatusBadge}
        />
      );
    }

    if (activeRoute.kind === "projects") {
      return <ProjectsOverview onRequestNewSession={handleRequestNewSession} />;
    }

    if (isConnectionLocked && activeConnection) {
      return <AccessUnlockView connection={activeConnection} />;
    }

    if (activeRoute.kind === "archive") {
      return <ArchiveView />;
    }

    if (activeRoute.kind === "session") {
      if (renderSessionWorkspace) {
        return renderSessionWorkspace({
          computerKey: activeRoute.computerKey,
          sessionId: activeRoute.sessionId,
        });
      }
      return null;
    }

    if (activeRoute.kind === "new-session") {
      const targetComputer = activeRoute.computerKey ?? activeComputerKey;
      if (renderNewSessionWorkspace) {
        return (
          <div
            key={`${targetComputer}:${activeRoute.cwd ?? ""}:${newSessionNonce}`}
            style={{
              flex: "1 1 auto",
              minInlineSize: 0,
              minBlockSize: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {renderNewSessionWorkspace({
              computerKey: targetComputer,
              initialCwd: activeRoute.cwd,
            })}
          </div>
        );
      }
      return null;
    }

    if (activeRoute.kind === "fusion") {
      if (renderFusionWorkspace) {
        return renderFusionWorkspace({ computerKey: activeRoute.computerKey });
      }
      return null;
    }

    if (activeRoute.kind === "screen") {
      if (renderRemoteScreenWorkspace) {
        return renderRemoteScreenWorkspace({ computerKey: activeRoute.computerKey });
      }
      return null;
    }

    if (
      activeRoute.kind === "terminals" ||
      activeRoute.kind === "files" ||
      activeRoute.kind === "ports" ||
      activeRoute.kind === "worktrees"
    ) {
      if (renderStandaloneTool) {
        return renderStandaloneTool({
          mode: activeRoute.kind,
          computerKey: activeRoute.computerKey,
        });
      }
      return null;
    }

    return (
      <WorkspaceHomeHub
        activeComputer={activeComputer}
        effectivePlatform={effectivePlatform}
        onRequestNewSession={handleRequestNewSession}
      />
    );
  };

  const workbenchStyle = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--inspector-w": `${inspectorWidth}px`,
    "--bottom-dock-h": `${bottomDockHeight}px`,
  } as CSSProperties;

  const stageMotionKey =
    activeRoute.kind === "session"
      ? `session:${activeRoute.computerKey}:${activeRoute.sessionId}`
      : activeRoute.kind === "new-session"
        ? `new-session:${activeRoute.computerKey ?? activeComputerKey}:${activeRoute.cwd ?? ""}`
        : activeRoute.kind === "computers" || activeRoute.kind === "projects"
          ? activeRoute.kind
          : activeRoute.kind === "screen" ||
              activeRoute.kind === "fusion" ||
              activeRoute.kind === "terminals" ||
              activeRoute.kind === "files" ||
              activeRoute.kind === "ports" ||
              activeRoute.kind === "worktrees"
            ? `${activeRoute.kind}:${activeRoute.computerKey}`
            : `${activeRoute.kind}:${activeComputerKey}`;

  const schedulePeekClose = () => {
    if (peekCloseTimerRef.current) clearTimeout(peekCloseTimerRef.current);
    peekCloseTimerRef.current = setTimeout(() => {
      setPeekOpen(false);
    }, 180);
  };

  const cancelPeekClose = () => {
    if (peekCloseTimerRef.current) {
      clearTimeout(peekCloseTimerRef.current);
      peekCloseTimerRef.current = null;
    }
  };

  return (
    <div
      ref={rootElRef}
      className="desktop-root"
      data-shell={isElectronDesktop || isElectronRuntime() ? "electron" : "browser"}
      data-platform={effectivePlatform}
      data-translucent={isTranslucent ? "true" : undefined}
      data-fullscreen={isFullscreen ? "true" : undefined}
      data-screen-fullscreen={isScreenFullscreen ? "true" : undefined}
      data-sidebar-collapsed={sidebarHidden ? "true" : undefined}
      data-inspector-open={showInspector ? "true" : undefined}
    >
      {/* Left-Edge 8px Hover Peek Sensor & Floating Drawer when collapsed (suppressed for 450ms on collapse click & in screen fullscreen) */}
      {sidebarHidden && !isScreenFullscreen ? (
        <>
          {!peekOpen ? (
            <div
              aria-hidden="true"
              className="desktop-sidebar-edge-sensor"
              onMouseEnter={() => {
                if (Date.now() < suppressPeekUntilRef.current) return;
                cancelPeekClose();
                setPeekOpen(true);
              }}
              onPointerEnter={() => {
                if (Date.now() < suppressPeekUntilRef.current) return;
                cancelPeekClose();
                setPeekOpen(true);
              }}
            />
          ) : null}
          {peekOpen ? (
            <div
              onMouseEnter={cancelPeekClose}
              onMouseLeave={schedulePeekClose}
              onPointerEnter={cancelPeekClose}
              onPointerLeave={schedulePeekClose}
            >
              <Sidebar
                isPeekDrawer
                onToggleSidebar={handleToggleSidebar}
                onNavigateDone={() => setPeekOpen(false)}
                onRequestNewSession={handleRequestNewSession}
                renderFusionStatusBadge={renderFusionStatusBadge}
              />
            </div>
          ) : null}
        </>
      ) : null}

      <div className="desktop-workbench" style={workbenchStyle}>
        {/* Column 1: L1 Deep Carbon Left Sidebar Rail */}
        <Sidebar
          onToggleSidebar={handleToggleSidebar}
          onRequestNewSession={handleRequestNewSession}
          renderFusionStatusBadge={renderFusionStatusBadge}
        />

        {!sidebarHidden && !isScreenFullscreen ? (
          <div className="desktop-col-sash desktop-col-sash--sidebar">
            <SplitResizer
              label={t("desktop.toggleSidebar")}
              size={sidebarWidth}
              min={220}
              max={420}
              defaultSize={256}
              orientation="vertical"
              side="end"
              cssVariable="--sidebar-w"
              targetSelector=".desktop-workbench"
              paneSelector=".desktop-sidebar"
              collapse={{
                threshold: 140,
                onCollapse: handleToggleSidebar,
              }}
              onResize={setSidebarWidth}
            />
          </div>
        ) : null}

        {/* Column 2: L2 Sculpted Island Workspace Canvas + Paseo Surface Tabs + Optional Bottom Terminal */}
        <main className="desktop-main">
          {!isStandaloneRemoteScreen ? (
            <WorkspaceTopBar
              onToggleSidebar={handleToggleSidebar}
              onRequestNewSession={handleRequestNewSession}
              renderSessionHeaderActions={renderSessionHeaderActions}
              renderFusionStatusBadge={renderFusionStatusBadge}
              renderFusionQuickTrigger={renderFusionQuickTrigger}
            />
          ) : null}

          {!isStandaloneRemoteScreen ? (
            <WorkspaceSurfaceTabs onRequestNewSession={handleRequestNewSession} />
          ) : null}

          <div className="desktop-main-body">
            <ErrorBoundary
              fallbackTitle={t("desktop.shell.workspaceCrashed")}
              resetKeys={[activeRoute.kind, activeComputerKey, currentSessionId]}
            >
              <div
                key={stageMotionKey}
                data-stage-kind={activeRoute.kind}
                className="desktop-stage-enter"
              >
                <RenderSlot render={renderMainContent} />
              </div>
            </ErrorBoundary>
          </div>

          {/* BottomTerminalDock owns its own horizontal <SplitResizer> + .desktop-bottom-dock (#31 §3, session-only per #73 C.2) */}
          {showBottomDock && renderBottomTerminal ? (
            <ErrorBoundary
              fallbackTitle={t("desktop.shell.dockCrashed")}
              resetKeys={[activeComputerKey, currentSessionId]}
            >
              <RenderSlot
                render={() =>
                  renderBottomTerminal({
                    computerKey: activeComputerKey,
                    sessionId: currentSessionId,
                    cwd: currentCwd,
                  })
                }
              />
            </ErrorBoundary>
          ) : null}
        </main>

        {/* Column 3: L3 Right Inspector Workbench (InspectorWorkbench owns its left-edge <SplitResizer> per #31 §3) */}
        <div
          role="region"
          aria-label={t("desktop.toggleInspector")}
          className="desktop-inspector"
        >
          {showInspector && renderInspector ? (
            <ErrorBoundary
              fallbackTitle={t("desktop.shell.inspectorCrashed")}
              resetKeys={[activeComputerKey, currentSessionId]}
            >
              <RenderSlot
                render={() =>
                  renderInspector({
                    computerKey: activeComputerKey,
                    sessionId: currentSessionId,
                    cwd: currentCwd,
                  })
                }
              />
            </ErrorBoundary>
          ) : null}
        </div>
      </div>

      {/* Global Non-Unmounting Command Center & Shortcuts Reference */}
      <CommandCenter
        onRequestNewSession={handleRequestNewSession}
        onOpenLocalPairingQr={onOpenLocalPairingQr}
        platformOverride={platformOverride}
      />
      <ShortcutsHelpDialog />
      <ShellNoticeHost />
    </div>
  );
}
