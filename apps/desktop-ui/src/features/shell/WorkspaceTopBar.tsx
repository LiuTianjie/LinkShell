import { type ReactNode } from "react";
import { useStore } from "zustand";
import {
  computerNames,
  engine,
  sessionGroup,
  sessionTitle,
  useActiveDesktopPlatform,
  useI18n,
  useRouter,
  waitingLabel,
  type Computer,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import { Badge, IconButton, StatusDot } from "../../primitives";
import {
  connectionRouteBadge,
  displayComputerName,
  folderBasename,
  isLocalComputer,
  useConnectionStore,
} from "./shell-helpers";

export interface WorkspaceTopBarProps {
  onToggleSidebar?: () => void;
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
  renderSessionHeaderActions?: (props: {
    computerKey: string;
    sessionId: string;
  }) => ReactNode;
  renderFusionStatusBadge?: (props: {
    computerKey: string;
    onClick?: () => void;
  }) => ReactNode;
  renderFusionQuickTrigger?: (props: {
    computerKey: string;
    compact?: boolean;
  }) => ReactNode;
}

export function WorkspaceTopBar({
  onToggleSidebar,
  onRequestNewSession,
  renderSessionHeaderActions,
}: WorkspaceTopBarProps) {
  const { locale, t } = useI18n();

  const activeRoute = useRouter((s) => s.activeRoute);
  const sidebarHidden = useRouter((s) => s.sidebarHidden);
  const inspectorOpen = useRouter((s) => s.inspectorOpen);
  const bottomDockOpen = useRouter((s) => s.bottomDockOpen);
  const navigate = useRouter((s) => s.navigate);
  const routerToggleSidebar = useRouter((s) => s.toggleSidebar);
  const toggleInspector = useRouter((s) => s.toggleInspector);
  const toggleBottomDock = useRouter((s) => s.toggleBottomDock);
  const handleToggleSidebar = onToggleSidebar ?? routerToggleSidebar;

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);

  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerTitle = displayComputerName(activeComputer, names, locale);
  const routeBadge = connectionRouteBadge(activeComputer, undefined, locale);
  const isRemote = Boolean(activeComputer && !isLocalComputer(activeComputer));

  const currentSession =
    activeRoute.kind === "session" ? sessionsMap[activeRoute.sessionId] : undefined;
  const currentSessionGroup = currentSession ? sessionGroup(currentSession) : undefined;
  const isSessionRoute = activeRoute.kind === "session";

  const activePlatform = useActiveDesktopPlatform();
  const inspectorShortcut = activePlatform === "macos" ? "Opt+Mod+B" : "Ctrl+Alt+B";

  return (
    <header className="chrome-bar desktop-main-header">
      <div className="workspace-topbar__left">
        {sidebarHidden ? (
          <IconButton
            icon="sidebar-toggle"
            variant="ghost"
            aria-pressed={false}
            label={t("desktop.toggleSidebar")}
            shortcut="Mod+B"
            className="workspace-topbar__sidebar-toggle"
            onClick={() => handleToggleSidebar()}
          />
        ) : null}

        <nav className="workspace-breadcrumbs" aria-label="Breadcrumb">
          {isSessionRoute ? (
            <>
              <span className="workspace-title-primary workspace-title-primary--session">
                {currentSession ? (
                  <AgentMark agent={currentSession.agent} size={15} />
                ) : (
                  <DesktopIcon name="terminal" size="sm" />
                )}
                <span className="ls-truncate">
                  {currentSession
                    ? sessionTitle(currentSession)
                    : activeRoute.sessionId.slice(0, 8)}
                </span>
              </span>

              {currentSession?.cwd ? (
                <>
                  <span className="workspace-breadcrumb-sep" aria-hidden="true">
                    ·
                  </span>
                  <button
                    type="button"
                    className="workspace-project-slug"
                    title={currentSession.cwd}
                    onClick={() =>
                      onRequestNewSession(activeRoute.computerKey, currentSession.cwd)
                    }
                  >
                    <span className="ls-truncate">
                      {folderBasename(currentSession.cwd)}
                    </span>
                  </button>
                </>
              ) : null}

              {currentSession && currentSessionGroup === "waiting" ? (
                <Badge dot="waiting" tone="waiting">
                  {waitingLabel(currentSession, locale)}
                </Badge>
              ) : null}
            </>
          ) : activeRoute.kind === "new-session" ? (
            <>
              <span className="workspace-title-primary">
                <DesktopIcon name="plus" size="sm" />
                <span className="ls-truncate">{t("desktop.newSession")}</span>
              </span>
              {activeRoute.cwd ? (
                <>
                  <span className="workspace-breadcrumb-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="workspace-project-slug workspace-project-slug--static">
                    <span className="ls-truncate">{folderBasename(activeRoute.cwd)}</span>
                  </span>
                </>
              ) : null}
              {isRemote ? (
                <button
                  type="button"
                  className="workspace-computer-chip"
                  onClick={() => navigate({ kind: "computers" })}
                >
                  <StatusDot
                    tone={activeComputer?.machine.online ? "online" : "offline"}
                    size="sm"
                  />
                  <span className="ls-truncate">{activeComputerTitle}</span>
                  <span className="workspace-computer-chip__tag">{routeBadge.label}</span>
                </button>
              ) : null}
            </>
          ) : (
            <>
              <span className="workspace-title-primary">
                {activeRoute.kind === "fusion" ? (
                  <DesktopIcon
                    name="fusion-mode"
                    size="sm"
                    style={{ color: "var(--ls-accent)" }}
                  />
                ) : activeRoute.kind === "screen" ? (
                  <DesktopIcon name="remote-screen" size="sm" />
                ) : activeRoute.kind === "projects" ? (
                  <DesktopIcon name="folder-open" size="sm" />
                ) : activeRoute.kind === "computers" ? (
                  <DesktopIcon name="computer-pc" size="sm" />
                ) : activeRoute.kind === "archive" ? (
                  <DesktopIcon name="archive" size="sm" />
                ) : activeRoute.kind === "terminals" ? (
                  <DesktopIcon name="terminal" size="sm" />
                ) : activeRoute.kind === "files" ? (
                  <DesktopIcon name="file-code" size="sm" />
                ) : activeRoute.kind === "ports" ? (
                  <DesktopIcon name="port-preview" size="sm" />
                ) : activeRoute.kind === "worktrees" ? (
                  <DesktopIcon name="worktree" size="sm" />
                ) : (
                  <DesktopIcon name="host-daemon" size="sm" />
                )}
                <span className="ls-truncate">
                  {activeRoute.kind === "fusion"
                    ? t("desktop.fusion.title")
                    : activeRoute.kind === "screen"
                      ? t("desktop.nav.screen")
                      : activeRoute.kind === "projects"
                        ? t("desktop.nav.projects")
                        : activeRoute.kind === "computers"
                          ? t("desktop.nav.computers")
                          : activeRoute.kind === "archive"
                            ? t("desktop.nav.archive")
                            : activeRoute.kind === "terminals"
                              ? t("desktop.nav.terminals")
                              : activeRoute.kind === "files"
                                ? t("desktop.nav.files")
                                : activeRoute.kind === "ports"
                                  ? t("desktop.nav.ports")
                                  : activeRoute.kind === "worktrees"
                                    ? t("desktop.nav.worktrees")
                                    : t("desktop.workspace")}
                </span>
              </span>

              {isRemote && activeRoute.kind !== "computers" ? (
                <button
                  type="button"
                  className="workspace-computer-chip"
                  onClick={() => navigate({ kind: "computers" })}
                >
                  <StatusDot
                    tone={activeComputer?.machine.online ? "online" : "offline"}
                    size="sm"
                  />
                  <span className="ls-truncate">{activeComputerTitle}</span>
                  <span className="workspace-computer-chip__tag">{routeBadge.label}</span>
                </button>
              ) : null}
            </>
          )}
        </nav>
      </div>

      {/* Right-Hand Action Strip:
          - Session route: SessionHeaderActions (☰, ⋯) + [>_] + [◨]
          - Non-session routes: clean empty right strip (sidebar expand lives in .workspace-topbar__left) */}
      <div className="workspace-topbar__right">
        {isSessionRoute && renderSessionHeaderActions
          ? renderSessionHeaderActions({
              computerKey: activeRoute.computerKey,
              sessionId: activeRoute.sessionId,
            })
          : null}

        {isSessionRoute ? (
          <>
            <IconButton
              icon="terminal"
              variant={bottomDockOpen ? "subtle" : "ghost"}
              aria-pressed={bottomDockOpen}
              label={t("desktop.toggleBottomDock")}
              shortcut="Mod+J"
              onClick={() => toggleBottomDock()}
            />

            <IconButton
              icon="inspector-toggle"
              variant={inspectorOpen ? "subtle" : "ghost"}
              aria-pressed={inspectorOpen}
              label={t("desktop.toggleInspector")}
              shortcut={inspectorShortcut}
              onClick={() => toggleInspector()}
            />
          </>
        ) : null}
      </div>
    </header>
  );
}
