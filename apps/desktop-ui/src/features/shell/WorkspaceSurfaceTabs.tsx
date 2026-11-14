import { useMemo } from "react";
import { useStore } from "zustand";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  computerNames,
  connectAndStartComputerFusion,
  engine,
  evaluateFusionCapability,
  fusionCapabilityMessage,
  sessionTitle,
  useFusionState,
  useI18n,
  useRouter,
  type Computer,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import { StatusDot, Tooltip } from "../../primitives";
import {
  displayComputerName,
  isLocalComputer,
  useConnectionStore,
} from "./shell-helpers";

export interface WorkspaceSurfaceTabsProps {
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
}

/**
 * Paseo-inspired 34px Workspace Surface Tab Strip (`#30` §5.2):
 * Switches instantaneously between Session Canvas, Terminals, Files, Port Previews,
 * Remote Screen, and Fusion Mode — with ZERO double headers inside child views.
 */
export function WorkspaceSurfaceTabs({
  onRequestNewSession,
}: WorkspaceSurfaceTabsProps) {
  const { locale, t } = useI18n();

  const activeRoute = useRouter((s) => s.activeRoute);
  const navigate = useRouter((s) => s.navigate);
  const openSession = useRouter((s) => s.openSession);
  const openScreen = useRouter((s) => s.openScreen);
  const openFusion = useRouter((s) => s.openFusion);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);

  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;
  const isRemote = Boolean(activeComputer && !isLocalComputer(activeComputer));

  const fusionState = useFusionState(activeComputerKey);
  const fusionCap = evaluateFusionCapability(
    activeComputerKey,
    activeComputer?.machine.platform,
  );
  const fusionDisabledReason = !fusionCap.supported
    ? fusionCapabilityMessage(fusionCap.reason, locale)
    : !activeComputer?.machine.online
      ? t("desktop.fusion.offlineHost", {
          name: displayComputerName(activeComputer, names, locale),
        })
      : undefined;

  const latestSession = useMemo(() => {
    const live = Object.values(sessionsMap)
      .filter((s) => !s.archived)
      .sort((a, b) => b.createdAt - a.createdAt);
    return live[0];
  }, [sessionsMap]);

  const activeSession =
    activeRoute.kind === "session"
      ? sessionsMap[activeRoute.sessionId]
      : latestSession;

  const currentCwd =
    activeSession?.cwd ??
    (activeRoute.kind === "new-session" ? activeRoute.cwd : undefined) ??
    (activeRoute.kind === "files" ? activeRoute.path : undefined);

  // Only render WorkspaceSurfaceTabs on standalone tool surfaces (terminals, files, ports, worktrees)
  // so session, new-session, home, fleet, projects, archive, screen, and fusion never show a redundant 2nd bar.
  const isStandaloneToolRoute =
    activeRoute.kind === "terminals" ||
    activeRoute.kind === "files" ||
    activeRoute.kind === "ports" ||
    activeRoute.kind === "worktrees";

  if (!isStandaloneToolRoute) {
    return null;
  }

  const handleSelectSessionSurface = () => {
    if (activeSession) {
      openSession(activeComputerKey, activeSession.id);
    } else {
      navigate({ kind: "home" });
    }
  };

  return (
    <div
      role="navigation"
      aria-label={t("desktop.workspace")}
      className="desktop-surface-tabs"
    >
      <div className="desktop-surface-tabs__track">
        <button
          type="button"
          data-surface="session"
          className="desktop-surface-tab"
          onClick={handleSelectSessionSurface}
        >
          {activeSession ? (
            <AgentMark agent={activeSession.agent} size={14} />
          ) : (
            <DesktopIcon name="sparkles" size="xs" />
          )}
          <span className="ls-truncate">
            {activeSession ? sessionTitle(activeSession) : t("desktop.workspace")}
          </span>
        </button>

        <button
          type="button"
          data-surface="terminals"
          data-active={activeRoute.kind === "terminals" ? "true" : undefined}
          aria-current={activeRoute.kind === "terminals" ? "page" : undefined}
          className="desktop-surface-tab"
          onClick={() =>
            navigate({ kind: "terminals", computerKey: activeComputerKey })
          }
        >
          <DesktopIcon name="terminal" size="xs" />
          <span>{t("desktop.nav.terminals")}</span>
        </button>

        <button
          type="button"
          data-surface="files"
          data-active={activeRoute.kind === "files" ? "true" : undefined}
          aria-current={activeRoute.kind === "files" ? "page" : undefined}
          className="desktop-surface-tab"
          onClick={() =>
            navigate({
              kind: "files",
              computerKey: activeComputerKey,
              path: currentCwd,
            })
          }
        >
          <DesktopIcon name="file-code" size="xs" />
          <span>{t("desktop.nav.files")}</span>
        </button>

        <button
          type="button"
          data-surface="ports"
          data-active={activeRoute.kind === "ports" ? "true" : undefined}
          aria-current={activeRoute.kind === "ports" ? "page" : undefined}
          className="desktop-surface-tab"
          onClick={() =>
            navigate({ kind: "ports", computerKey: activeComputerKey })
          }
        >
          <DesktopIcon name="port-preview" size="xs" />
          <span>{t("desktop.nav.ports")}</span>
        </button>

        {activeRoute.kind === "worktrees" ? (
          <button
            type="button"
            data-surface="worktrees"
            data-active="true"
            aria-current="page"
            className="desktop-surface-tab"
            onClick={() =>
              navigate({ kind: "worktrees", computerKey: activeComputerKey })
            }
          >
            <DesktopIcon name="worktree" size="xs" />
            <span>{t("desktop.nav.worktrees")}</span>
          </button>
        ) : null}

        {isRemote ? (
          <>
            <button
              type="button"
              data-surface="screen"
              disabled={!activeComputer?.machine.online}
              className="desktop-surface-tab"
              onClick={() => openScreen(activeComputerKey)}
            >
              <DesktopIcon name="remote-screen" size="xs" />
              <span>{t("desktop.nav.screen")}</span>
            </button>

            <Tooltip
              content={fusionDisabledReason}
              wrapDisabled={Boolean(fusionDisabledReason)}
            >
              <button
                type="button"
                data-surface="fusion"
                data-active={fusionState.connected ? "true" : undefined}
                disabled={Boolean(fusionDisabledReason)}
                className="desktop-surface-tab"
                onClick={() => {
                  openFusion(activeComputerKey);
                  if (fusionState.phase === "idle") {
                    void connectAndStartComputerFusion(activeComputerKey);
                  }
                }}
              >
                <DesktopIcon name="fusion-mode" size="xs" />
                <span>{t("desktop.nav.fusion")}</span>
                {fusionState.connected ? (
                  <StatusDot tone="ok" size="sm" />
                ) : null}
              </button>
            </Tooltip>
          </>
        ) : null}

        <Tooltip content={t("desktop.newSession")} shortcut="Mod+N">
          <button
            type="button"
            aria-label={t("desktop.newSession")}
            className="desktop-surface-tabs__new"
            onClick={() => onRequestNewSession(activeComputerKey, currentCwd)}
          >
            <DesktopIcon name="plus" size="xs" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
