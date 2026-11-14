import { useEffect, useState } from "react";
import {
  CLOSE_TAB_EVENT,
  DESKTOP_APPEARANCE_EVENT,
  DESKTOP_COMMAND_EVENT,
  getDesktopCapability,
  getShellAppearance,
  GO_TO_FILE_EVENT,
  postDesktopMessage,
  reportDesktopRendererReady,
  type DesktopAppearance,
} from "./bridge";
import {
  attachFusionCommandListener,
  attachRouterListeners,
  engine,
  I18nProvider,
  localeStore,
  pollManagementInBackground,
  readLocal,
  routerStore,
  startManagement,
  startSessionAttention,
  STORAGE_KEYS,
  subscribeStorageReady,
  useRouter,
} from "./core";
import {
  BottomTerminalDock,
  closeActiveInspectorTab,
  cycleInspectorTab,
  InspectorWorkbench,
  openInspectorGoToFile,
  StandaloneToolWorkspace,
} from "./features/inspector";
import {
  FusionQuickTrigger,
  FusionStatusBadge,
  FusionWorkspace,
  RemoteScreenWorkspace,
} from "./features/remote";
import {
  INSPECTOR_OPEN_FILE_EVENT,
  NewSessionWorkspace,
  SessionHeaderActions,
  SessionWorkspace,
} from "./features/session";
import { DesktopAppShell } from "./features/shell";
import {
  LocalPairingQrDialog,
  SignInPairModal,
  SystemHostModal,
} from "./features/system";
import { DialogProvider, ErrorBoundary, setPrimitiveLocale } from "./primitives";
import { applyDesktopAppearance, type ThemeMode } from "./theme";

// Capture `#desktop=<capability>` immediately before any route navigation mutates `location.hash`.
getDesktopCapability();

// The primitives carry their own fallback words (a dialog's Close, a confirm's answers).
setPrimitiveLocale(localeStore.getState().locale);
localeStore.subscribe((state) => setPrimitiveLocale(state.locale));

export function resolveStoredAppearance(): ThemeMode {
  const shellAppearance = getShellAppearance();
  if (
    shellAppearance === "light" ||
    shellAppearance === "dark" ||
    shellAppearance === "system"
  ) {
    return shellAppearance;
  }
  const stored = readLocal<string>(STORAGE_KEYS.appearance, "system");
  return stored === "light" || stored === "dark" ? stored : "system";
}

function DesktopWorkspaceRoot() {
  const connectModalOpen = useRouter((s) => s.connectModalOpen);
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);
  const [localPairQrOpen, setLocalPairQrOpen] = useState(false);

  useEffect(() => {
    getDesktopCapability();
    applyDesktopAppearance(resolveStoredAppearance());

    void engine.start();
    startManagement();
    const stopManagementPoll = pollManagementInBackground();
    // The menu bar, tray and native dialogs are drawn by the main process: it follows the page's language.
    const sendLocale = () =>
      postDesktopMessage({ action: "locale", value: localeStore.getState().locale });
    sendLocale();

    // ⌘W closes the inspector's tab when it has one; unclaimed, the shell closes the dock or window.
    const onCloseTab = (event: Event) => {
      if (closeActiveInspectorTab()) event.preventDefault();
    };
    const onGoToFile = () => {
      openInspectorGoToFile();
    };
    // ⌃Tab walks the inspector's tabs from anywhere in the window, as in an editor.
    const onTabCycle = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented) return;
      if (cycleInspectorTab(event.shiftKey ? -1 : 1)) event.preventDefault();
    };
    window.addEventListener(CLOSE_TAB_EVENT, onCloseTab);
    window.addEventListener(GO_TO_FILE_EVENT, onGoToFile);
    window.addEventListener("keydown", onTabCycle);
    const detachLocale = localeStore.subscribe((state, previous) => {
      if (state.locale !== previous.locale) sendLocale();
    });
    const detachRouter = attachRouterListeners();
    const detachFusion = attachFusionCommandListener();
    const stopAttention = startSessionAttention();
    const detachStorageTheme = subscribeStorageReady(() => {
      applyDesktopAppearance(resolveStoredAppearance());
    });

    const onShellAppearance = (event: Event) => {
      const appearance = (
        (event as CustomEvent<{ appearance?: DesktopAppearance }>).detail
      )?.appearance;
      if (
        appearance === "light" ||
        appearance === "dark" ||
        appearance === "system"
      ) {
        applyDesktopAppearance(appearance);
      }
    };

    const mediaQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const onSystemColorSchemeChange = () => {
      const currentMode = document.documentElement.dataset.themeMode;
      if (!currentMode || currentMode === "system") {
        applyDesktopAppearance("system");
      }
    };

    // Bridge Timeline/Markdown/Diff file-jump events into InspectorWorkbench even if Inspector was closed.
    let pendingFileRaf = 0;
    const onOpenFileInInspector = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          computerKey?: string;
          sessionId?: string;
          path?: string;
          line?: number;
        }>
      ).detail;
      if (!detail?.path) return;
      const spec =
        typeof detail.line === "number" && detail.line > 0
          ? `${detail.path}#L${detail.line}`
          : detail.path;
      routerStore.getState().toggleInspector(true, "files");
      if (pendingFileRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pendingFileRaf);
      }
      const dispatchJump = () => {
        pendingFileRaf = 0;
        window.dispatchEvent(
          new CustomEvent(DESKTOP_COMMAND_EVENT, {
            detail: { command: "open-file", path: spec },
          }),
        );
      };
      if (typeof requestAnimationFrame === "function") {
        pendingFileRaf = requestAnimationFrame(dispatchJump);
      } else {
        queueMicrotask(dispatchJump);
      }
    };

    window.addEventListener(DESKTOP_APPEARANCE_EVENT, onShellAppearance);
    window.addEventListener(INSPECTOR_OPEN_FILE_EVENT, onOpenFileInInspector);
    mediaQuery?.addEventListener("change", onSystemColorSchemeChange);

    reportDesktopRendererReady();

    return () => {
      if (pendingFileRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(pendingFileRaf);
      }
      mediaQuery?.removeEventListener("change", onSystemColorSchemeChange);
      window.removeEventListener(
        INSPECTOR_OPEN_FILE_EVENT,
        onOpenFileInInspector,
      );
      window.removeEventListener(DESKTOP_APPEARANCE_EVENT, onShellAppearance);
      detachStorageTheme();
      stopAttention();
      detachLocale();
      window.removeEventListener(CLOSE_TAB_EVENT, onCloseTab);
      window.removeEventListener(GO_TO_FILE_EVENT, onGoToFile);
      window.removeEventListener("keydown", onTabCycle);
      detachFusion();
      detachRouter();
      stopManagementPoll();
    };
  }, []);

  return (
    <>
      <DesktopAppShell
        renderSessionWorkspace={({ computerKey, sessionId }) => (
          // Attachments, send state and scroll position belong to one session: without the key
          // React reuses the instance and the next session inherits (and sends) them.
          <SessionWorkspace
            key={`${computerKey}:${sessionId}`}
            computerKey={computerKey}
            sessionId={sessionId}
          />
        )}
        renderNewSessionWorkspace={({ computerKey, initialCwd }) => (
          <NewSessionWorkspace
            computerKey={computerKey}
            initialCwd={initialCwd}
          />
        )}
        renderSessionHeaderActions={({ computerKey, sessionId }) => (
          <SessionHeaderActions
            computerKey={computerKey}
            sessionId={sessionId}
          />
        )}
        renderInspector={({ computerKey, sessionId, cwd }) => (
          <InspectorWorkbench
            computerKey={computerKey}
            sessionId={sessionId}
            cwd={cwd}
          />
        )}
        renderBottomTerminal={({ computerKey, sessionId, cwd }) => (
          <BottomTerminalDock
            computerKey={computerKey}
            sessionId={sessionId}
            cwd={cwd}
          />
        )}
        renderStandaloneTool={({ mode, computerKey }) => (
          <StandaloneToolWorkspace mode={mode} computerKey={computerKey} />
        )}
        renderFusionWorkspace={({ computerKey }) => (
          <FusionWorkspace computerKey={computerKey} />
        )}
        renderRemoteScreenWorkspace={({ computerKey }) => (
          <RemoteScreenWorkspace computerKey={computerKey} />
        )}
        renderFusionStatusBadge={({ computerKey, onClick }) => (
          <FusionStatusBadge computerKey={computerKey} onClick={onClick} />
        )}
        renderFusionQuickTrigger={({ computerKey, compact }) => (
          <FusionQuickTrigger computerKey={computerKey} compact={compact} />
        )}
        onOpenLocalPairingQr={() => setLocalPairQrOpen(true)}
      />

      {/* Non-unmounting Top-Layer System, Account Sign-In & Pairing Modals */}
      <ErrorBoundary>
        <SystemHostModal />
      </ErrorBoundary>
      <ErrorBoundary>
        <SignInPairModal
          open={connectModalOpen}
          onOpenChange={setConnectModalOpen}
        />
      </ErrorBoundary>
      <ErrorBoundary>
        <LocalPairingQrDialog
          open={localPairQrOpen}
          onOpenChange={setLocalPairQrOpen}
        />
      </ErrorBoundary>
    </>
  );
}

export function App() {
  return (
    <I18nProvider>
      <DialogProvider>
        <ErrorBoundary>
          <DesktopWorkspaceRoot />
        </ErrorBoundary>
      </DialogProvider>
    </I18nProvider>
  );
}

export default App;
