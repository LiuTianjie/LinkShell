import { useEffect, useState } from "react";
import {
  DESKTOP_APPEARANCE_EVENT,
  DESKTOP_COMMAND_EVENT,
  getDesktopCapability,
  getShellAppearance,
  reportDesktopRendererReady,
  type DesktopAppearance,
} from "./bridge";
import {
  attachFusionCommandListener,
  attachRouterListeners,
  engine,
  I18nProvider,
  pollManagement,
  readLocal,
  routerStore,
  startManagement,
  STORAGE_KEYS,
  subscribeStorageReady,
  useRouter,
} from "./core";
import {
  BottomTerminalDock,
  InspectorWorkbench,
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
import { DialogProvider, ErrorBoundary } from "./primitives";
import { applyDesktopAppearance, type ThemeMode } from "./theme";

// Capture `#desktop=<capability>` immediately before any route navigation mutates `location.hash`.
getDesktopCapability();

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
    const stopManagementPoll = pollManagement();
    const detachRouter = attachRouterListeners();
    const detachFusion = attachFusionCommandListener();
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
      detachFusion();
      detachRouter();
      stopManagementPoll();
    };
  }, []);

  return (
    <>
      <DesktopAppShell
        renderSessionWorkspace={({ computerKey, sessionId }) => (
          <SessionWorkspace computerKey={computerKey} sessionId={sessionId} />
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
      <ErrorBoundary fallbackTitle="本机管理面板加载异常">
        <SystemHostModal />
      </ErrorBoundary>
      <ErrorBoundary fallbackTitle="账号与配对面板加载异常">
        <SignInPairModal
          open={connectModalOpen}
          onOpenChange={setConnectModalOpen}
        />
      </ErrorBoundary>
      <ErrorBoundary fallbackTitle="配对二维码面板加载异常">
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
        <ErrorBoundary fallbackTitle="LinkShell 桌面端渲染异常">
          <DesktopWorkspaceRoot />
        </ErrorBoundary>
      </DialogProvider>
    </I18nProvider>
  );
}

export default App;
