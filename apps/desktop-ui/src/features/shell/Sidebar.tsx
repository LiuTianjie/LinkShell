import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import { DESKTOP_LOCAL, isElectronDesktop } from "../../bridge/desktop-bridge";
import {
  computerNames,
  computerSessionTrees,
  confirmAndDeleteSession,
  connectAndStartComputerFusion,
  desktopSessionTree,
  engine,
  evaluateFusionCapability,
  fusionCapabilityMessage,
  openProjectContextMenu,
  openSessionContextMenu,
  projectScopeStore,
  readLocal,
  refreshConnectionProjects,
  revealInFilesLabel,
  revealPathOnDesktop,
  saveLocal,
  sessionFamilies,
  sessionGroup,
  sessionTitle,
  setProjectScope,
  STORAGE_KEYS,
  useActiveDesktopPlatform,
  useFusionState,
  useI18n,
  useRouter,
  type Computer,
  type ComputerSessionTree,
  type Connection,
  type DesktopProjectGroup,
} from "../../core";
import { AgentMark, DesktopIcon, SubagentGlyph } from "../../icons";
import {
  ContextMenu,
  IconButton,
  Kbd,
  MenuItem,
  MenuSeparator,
  StatusDot,
  Tooltip,
  isImeComposing,
  useDialogs,
} from "../../primitives";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { LocalHostCapsule } from "./LocalHostCapsule";
import {
  asSessionActionDialogs,
  buildComputerSessionInputs,
  computerPlatformIcon,
  currentFusionCapabilityEnv,
  displayComputerName,
  folderBasename,
  formatRelativeTimestamp,
  isLocalComputer,
  reportShellError,
  sessionActivity,
  sessionListState,
  useConnectionStore,
  useMinuteTick,
  useRetainedMetadataConnections,
} from "./shell-helpers";

const ROW_SELECTOR =
  ".tree-session, .tree-project__toggle, .tree-computer__toggle, .tree-show-more";

/** Opens the row's context menu from the keyboard by replaying the event the mouse would send. */
function openRowContextMenu(row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + Math.min(24, rect.width / 2)),
      clientY: Math.round(rect.bottom),
    }),
  );
}

/** A collapse choice the user made, remembered per computer so reloads and the hover drawer keep it. */
function usePersistedFold(
  computerKey: string,
  groupKey: string,
  initial: () => boolean,
): [boolean, (next: boolean) => void] {
  const storageKey = STORAGE_KEYS.treeFolded(computerKey);
  const [collapsed, setCollapsedState] = useState(() => {
    const stored = readLocal<Record<string, boolean>>(storageKey, {});
    return typeof stored[groupKey] === "boolean" ? stored[groupKey]! : initial();
  });
  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      const stored = readLocal<Record<string, boolean>>(storageKey, {});
      saveLocal(storageKey, { ...stored, [groupKey]: next });
    },
    [groupKey, storageKey],
  );
  return [collapsed, setCollapsed];
}

const INITIAL_VISIBLE_SESSIONS = 8;

export interface SidebarProps {
  isPeekDrawer?: boolean;
  onToggleSidebar?: () => void;
  onNavigateDone?: () => void;
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
  renderFusionStatusBadge?: (props: {
    computerKey: string;
    onClick?: () => void;
  }) => ReactNode;
}

interface SessionRowProps {
  session: SessionSummary;
  computerKey: string;
  connection: Connection | undefined;
  isChild?: boolean;
  isPinnedSection?: boolean;
  isActiveRoute: boolean;
  computerBadge?: string;
  onOpen: (computerKey: string, sessionId: string) => void;
}

/**
 * Clean T3 Code / Linear Session Row:
 * - Inside a project group (`!isPinnedSection && !computerBadge`): single-line row (`AgentMark` + live `StatusDot` + `Title` + `wt` tag + timestamp) without repeating parent project monogram/slug.
 * - In pinned attention section (`isPinnedSection`) or cross-computer badge (`computerBadge`): shows compact context subline.
 */
function SidebarSessionRow({
  session,
  computerKey,
  connection,
  isChild = false,
  isPinnedSection = false,
  isActiveRoute,
  computerBadge,
  onOpen,
}: SessionRowProps) {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const dialogs = useDialogs();
  const activity = sessionActivity(session, locale);
  const title = sessionTitle(session);
  const isLocal = computerKey === DESKTOP_LOCAL;
  const status = useConnectionStore(connection, (s) => s.status);
  const online = status === "online";
  const repoSlug = folderBasename(session.cwd);
  const showSubline = Boolean(isPinnedSection || computerBadge);
  const actionDialogs = asSessionActionDialogs(dialogs);

  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => reportShellError(error, locale));
  };

  const handleRename = async () => {
    if (!connection) return;
    const next = await dialogs.prompt(
      t("desktop.shell.renameSessionTitle"),
      title,
      t("desktop.shell.save"),
    );
    if (next !== null && next.trim()) {
      await connection.store.getState().rename(session.id, next.trim());
    }
  };

  const handleFork = async (worktree: boolean) => {
    if (!connection) return;
    const created = await connection.store.getState().forkSession(session.id, { worktree });
    onOpen(computerKey, created.id);
  };

  const handleArchiveToggle = async () => {
    if (!connection) return;
    await connection.store.getState().archive(session.id, !session.archived);
    refreshConnectionProjects(connection);
  };

  const handleDelete = async () => {
    if (!connection) return;
    const deleted = await confirmAndDeleteSession(
      session,
      connection.store.getState(),
      actionDialogs,
      locale,
      computerKey,
    );
    if (deleted) refreshConnectionProjects(connection);
  };

  const fallbackMenu = (
    <>
      <MenuItem icon="edit" disabled={!online} onSelect={() => run(handleRename)}>
        {t("desktop.menu.rename")}
      </MenuItem>
      <MenuItem icon="session-fork" disabled={!online} onSelect={() => run(() => handleFork(false))}>
        {session.worktree ? t("desktop.menu.forkSameWorktree") : t("desktop.menu.forkHere")}
      </MenuItem>
      {!session.worktree ? (
        <MenuItem icon="worktree" disabled={!online} onSelect={() => run(() => handleFork(true))}>
          {t("desktop.menu.forkNewWorktree")}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon="copy"
        onSelect={() => {
          void navigator.clipboard?.writeText(title);
        }}
      >
        {t("desktop.menu.copyTitle")}
      </MenuItem>
      <MenuItem
        icon="folder"
        onSelect={() => {
          void navigator.clipboard?.writeText(session.cwd);
        }}
      >
        {t("desktop.menu.copyCwd")}
      </MenuItem>
      {isLocal ? (
        <MenuItem icon="external-link" onSelect={() => run(() => revealPathOnDesktop(session.cwd))}>
          {revealInFilesLabel(locale, activePlatform)}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={session.archived ? "archive-restore" : "archive"}
        disabled={!online}
        onSelect={() => run(handleArchiveToggle)}
      >
        {session.archived ? t("desktop.menu.unarchive") : t("desktop.menu.archive")}
      </MenuItem>
      <MenuItem
        icon="trash"
        destructive
        disabled={!online || session.state === "running"}
        onSelect={() => run(handleDelete)}
      >
        {t("desktop.menu.deletePermanent")}
      </MenuItem>
    </>
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isImeComposing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "F2" && online) {
      event.preventDefault();
      run(handleRename);
    } else if ((event.key === "Delete" || event.key === "Backspace") && online) {
      if (session.state === "running") return;
      event.preventDefault();
      run(handleDelete);
    }
  };

  const buttonNode = (
    <button
      type="button"
      data-session-id={isPinnedSection ? undefined : session.id}
      data-pinned-session-id={isPinnedSection ? session.id : undefined}
      data-row-session-id={session.id}
      data-computer-key={computerKey}
      data-single-line={!showSubline ? "true" : undefined}
      data-active={isActiveRoute ? "true" : undefined}
      aria-current={isActiveRoute ? "page" : undefined}
      className="tree-session"
      onClick={() => onOpen(computerKey, session.id)}
      onKeyDown={handleKeyDown}
      onContextMenu={
        isElectronDesktop && connection
          ? (event) => {
              event.preventDefault();
              void openSessionContextMenu(session, {
                connection,
                dialogs: actionDialogs,
                navigateSession: (nextId) => onOpen(computerKey, nextId),
                at: { x: event.clientX, y: event.clientY },
                locale,
              });
            }
          : undefined
      }
    >
      <span className="tree-session__top">
        <span className="tree-session__lead" aria-hidden="true">
          {isChild && session.parentId ? (
            <SubagentGlyph seed={[session.parentId, session.id]} size={15} />
          ) : isChild && session.forkedFrom ? (
            <DesktopIcon name="session-fork" size="sm" />
          ) : (
            <AgentMark agent={session.agent} size={15} />
          )}
          {activity ? (
            <StatusDot tone={activity.kind} size="sm" className="tree-session__dot" />
          ) : null}
        </span>

        <span className="tree-session__title">{title}</span>

        {!showSubline && session.worktree ? (
          <span className="tree-session__pill">
            <DesktopIcon name="worktree" size="xs" />
            <span>{t("desktop.shell.worktreeTag")}</span>
          </span>
        ) : null}

        <span className="tree-session__meta">
          {formatRelativeTimestamp(session.updatedAt ?? session.createdAt, locale)}
        </span>
      </span>

      {showSubline ? (
        <span className="tree-session__sub">
          <span className="tree-session__repo">
            <span className="ls-truncate">
              {computerBadge ? `${repoSlug} · ${computerBadge}` : repoSlug}
            </span>
          </span>

          <span className="tree-session__badges">
            {session.worktree ? (
              <span className="tree-session__pill">
                <DesktopIcon name="worktree" size="xs" />
                <span>{t("desktop.shell.worktreeTag")}</span>
              </span>
            ) : null}

            {activity ? (
              <span className={`tree-session__pill tree-session__pill--${activity.kind}`}>
                {activity.label}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
    </button>
  );

  return (
    <div className={`tree-session-row${isChild ? " tree-session-row--child" : ""}`}>
      {isElectronDesktop ? (
        buttonNode
      ) : (
        <ContextMenu label={title} menu={fallbackMenu}>
          {buttonNode}
        </ContextMenu>
      )}
    </div>
  );
}

interface ProjectTreeBlockProps {
  group: DesktopProjectGroup;
  groupIndex?: number;
  computerKey: string;
  connection: Connection | undefined;
  computerBadge?: string;
  activeSessionId?: string;
  activeComputerKey?: string;
  onOpenSession: (computerKey: string, sessionId: string) => void;
  onNewInProject: (computerKey: string, cwd: string) => void;
}

function ProjectTreeBlock({
  group,
  groupIndex = 0,
  computerKey,
  connection,
  computerBadge,
  activeSessionId,
  activeComputerKey,
  onOpenSession,
  onNewInProject,
}: ProjectTreeBlockProps) {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const dialogs = useDialogs();
  const groupContainsActiveRoute = Boolean(
    activeSessionId &&
      activeComputerKey === computerKey &&
      group.sessions.some((s) => s.id === activeSessionId),
  );
  const [collapsed, setCollapsed] = usePersistedFold(computerKey, group.key, () => {
    if (group.running > 0 || groupContainsActiveRoute) return false;
    if (groupIndex < 3) return false;
    return (
      group.lastActiveAt >= 1_000_000_000_000 &&
      Date.now() - group.lastActiveAt > 3 * 86_400_000
    );
  });
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (groupContainsActiveRoute && collapsed) setCollapsed(false);
  }, [collapsed, groupContainsActiveRoute, setCollapsed]);

  const families = useMemo(() => sessionFamilies(group.sessions), [group.sessions]);
  const visibleFamilies = showAll ? families : families.slice(0, INITIAL_VISIBLE_SESSIONS);
  const hiddenCount = Math.max(0, families.length - INITIAL_VISIBLE_SESSIONS);
  const isLocal = computerKey === DESKTOP_LOCAL;
  const status = useConnectionStore(connection, (s) => s.status);
  const online = status === "online";
  const projectPath = group.cwd || group.key;
  const newSessionCwd = group.generated ? "" : projectPath;

  const handleArchiveAll = async () => {
    if (!connection) return;
    const live = group.sessions.filter((s) => !s.archived);
    if (live.length === 0) return;
    const ok = await dialogs.confirm(
      t("desktop.shell.archiveAllConfirm", { name: group.name, count: live.length }),
      { confirmLabel: t("desktop.menu.archiveAll") },
    );
    if (!ok) return;
    try {
      for (const s of live) {
        await connection.store.getState().archive(s.id, true);
      }
    } catch (error) {
      reportShellError(error, locale);
    } finally {
      refreshConnectionProjects(connection);
    }
  };

  const projectFallbackMenu = (
    <>
      <MenuItem
        icon="plus"
        disabled={!online}
        onSelect={() => onNewInProject(computerKey, newSessionCwd)}
      >
        {t("desktop.menu.newInProject")}
      </MenuItem>
      <MenuSeparator />
      {isLocal && !group.generated ? (
        <MenuItem
          icon="external-link"
          onSelect={() => {
            void revealPathOnDesktop(projectPath).catch((error: unknown) =>
              reportShellError(error, locale),
            );
          }}
        >
          {revealInFilesLabel(locale, activePlatform)}
        </MenuItem>
      ) : null}
      {!group.generated ? (
        <MenuItem
          icon="copy"
          onSelect={() => {
            void navigator.clipboard?.writeText(projectPath);
          }}
        >
          {t("desktop.menu.copyPath")}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon="archive"
        disabled={!online || group.sessions.length === 0}
        onSelect={() => void handleArchiveAll()}
      >
        {t("desktop.menu.archiveAll")}
      </MenuItem>
    </>
  );

  const headerButton = (
    <button
      type="button"
      aria-expanded={!collapsed}
      className="tree-project__toggle"
      onClick={() => setCollapsed(!collapsed)}
      onContextMenu={
        isElectronDesktop && connection
          ? (event) => {
              event.preventDefault();
              void openProjectContextMenu(group, {
                connection,
                dialogs: asSessionActionDialogs(dialogs),
                openNewSession: (cwd) => onNewInProject(computerKey, cwd),
                at: { x: event.clientX, y: event.clientY },
                locale,
              });
            }
          : undefined
      }
    >
      <span className="tree-project__chevron" aria-hidden="true">
        <DesktopIcon name="chevron-right" size="xs" />
      </span>
      <span className="tree-project__icon" aria-hidden="true">
        <DesktopIcon name={collapsed ? "folder" : "folder-open"} size={14} />
      </span>
      <span className="tree-project__name">
        {computerBadge ? `${group.name} · ${computerBadge}` : group.name}
      </span>
      <span className="tree-project__count">{group.sessions.length}</span>
    </button>
  );

  return (
    <div className="tree-project" data-open={!collapsed ? "true" : "false"}>
      <div className="tree-project__header">
        {isElectronDesktop ? (
          headerButton
        ) : (
          <ContextMenu label={group.name} menu={projectFallbackMenu}>
            {headerButton}
          </ContextMenu>
        )}

        <div className="tree-project__actions">
          <IconButton
            icon="plus"
            label={`${t("desktop.menu.newInProject")}: ${group.name}`}
            tooltip={t("desktop.menu.newInProject")}
            onClick={() => onNewInProject(computerKey, newSessionCwd)}
          />
        </div>
      </div>

      <div className="ls-collapse-grid" data-open={!collapsed ? "true" : "false"}>
        <div className="ls-collapse-grid__inner" inert={collapsed || undefined}>
          <div className="tree-project__sessions">
            {visibleFamilies.map((family) => (
              <div key={family.root.id}>
                <SidebarSessionRow
                  session={family.root}
                  computerKey={computerKey}
                  connection={connection}
                  isActiveRoute={
                    activeSessionId === family.root.id &&
                    activeComputerKey === computerKey
                  }
                  onOpen={onOpenSession}
                />
                {family.children.map((child) => (
                  <SidebarSessionRow
                    key={child.id}
                    session={child}
                    computerKey={computerKey}
                    connection={connection}
                    isChild
                    isActiveRoute={
                      activeSessionId === child.id &&
                      activeComputerKey === computerKey
                    }
                    onOpen={onOpenSession}
                  />
                ))}
              </div>
            ))}

            {hiddenCount > 0 ? (
              <button
                type="button"
                className="tree-show-more"
                onClick={() => setShowAll((prev) => !prev)}
              >
                <DesktopIcon name={showAll ? "chevron-up" : "chevron-down"} size="xs" />
                <span>
                  {showAll
                    ? t("desktop.nav.showLess")
                    : t("desktop.nav.showMore", { count: hiddenCount })}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ComputerTreeBlockProps {
  compTree: ComputerSessionTree;
  computer: Computer | undefined;
  computerTitle: string;
  connection: Connection | undefined;
  activeSessionId?: string;
  activeComputerKey?: string;
  onOpenSession: (computerKey: string, sessionId: string) => void;
  onNewInProject: (computerKey: string, cwd: string) => void;
  onNewOnComputer: (computerKey: string) => void;
}

/**
 * Level-1 Computer Group inside Left Sidebar when `scope === "all"` (`所有电脑`):
 * `电脑 → 项目 → 会话` with smooth `.ls-collapse-grid` accordion and vertical guide line.
 */
function ComputerTreeBlock({
  compTree,
  computer,
  computerTitle,
  connection,
  activeSessionId,
  activeComputerKey,
  onOpenSession,
  onNewInProject,
  onNewOnComputer,
}: ComputerTreeBlockProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = usePersistedFold(compTree.key, "__computer__", () => false);

  const visibleCompGroups = useMemo(
    () => compTree.groups.filter((g) => g.sessions.length > 0),
    [compTree.groups],
  );
  const visibleSessionCount = useMemo(
    () => visibleCompGroups.reduce((sum, g) => sum + g.sessions.length, 0),
    [visibleCompGroups],
  );

  if (!compTree.syncing && visibleCompGroups.length === 0) {
    return null;
  }

  const newOnComputerLabel = t("desktop.shell.newOnComputer");
  const syncingBadgeLabel = t("desktop.shell.syncing");
  const syncingRowLabel = t("desktop.shell.loadingSessions");

  return (
    <div
      className="tree-computer"
      data-computer-key={compTree.key}
      data-open={!collapsed ? "true" : "false"}
    >
      <div className="tree-computer__header">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="tree-computer__toggle"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="tree-computer__chevron" aria-hidden="true">
            <DesktopIcon name="chevron-right" size="xs" />
          </span>
          <span className="tree-computer__icon" aria-hidden="true">
            <DesktopIcon
              name={computerPlatformIcon(computer?.machine.platform)}
              size={14}
            />
          </span>
          <StatusDot tone={compTree.online ? "ok" : "offline"} size="sm" />
          <span className="tree-computer__name ls-truncate">{computerTitle}</span>
          {compTree.syncing ? (
            <span className="tree-computer__sync">{syncingBadgeLabel}</span>
          ) : (
            <span className="tree-computer__count">{visibleSessionCount}</span>
          )}
        </button>

        <div className="tree-computer__actions">
          <IconButton
            icon="plus"
            disabled={!compTree.online}
            label={`${newOnComputerLabel}: ${computerTitle}`}
            tooltip={newOnComputerLabel}
            onClick={() => onNewOnComputer(compTree.key)}
          />
        </div>
      </div>

      <div className="ls-collapse-grid" data-open={!collapsed ? "true" : "false"}>
        <div className="ls-collapse-grid__inner" inert={collapsed || undefined}>
          <div className="tree-computer__projects">
            {compTree.syncing ? (
              <div className="tree-computer__empty">
                <DesktopIcon name="spinner" size="xs" />
                <span className="ls-truncate">{syncingRowLabel}</span>
              </div>
            ) : (
              visibleCompGroups.map((group, idx) => (
                <ProjectTreeBlock
                  key={group.key}
                  group={group}
                  groupIndex={idx}
                  computerKey={compTree.key}
                  connection={connection}
                  activeSessionId={activeSessionId}
                  activeComputerKey={activeComputerKey}
                  onOpenSession={onOpenSession}
                  onNewInProject={onNewInProject}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  isPeekDrawer = false,
  onToggleSidebar,
  onNavigateDone,
  onRequestNewSession,
}: SidebarProps) {
  const { locale, t } = useI18n();
  useMinuteTick();
  const activeRoute = useRouter((s) => s.activeRoute);
  const sidebarHidden = useRouter((s) => s.sidebarHidden);
  const routerToggleSidebar = useRouter((s) => s.toggleSidebar);
  const navigate = useRouter((s) => s.navigate);
  const openSession = useRouter((s) => s.openSession);
  const openScreen = useRouter((s) => s.openScreen);
  const openFusion = useRouter((s) => s.openFusion);
  const setCommandCenterOpen = useRouter((s) => s.setCommandCenterOpen);
  const handleToggleSidebar = onToggleSidebar ?? routerToggleSidebar;

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);
  const scope = useStore(projectScopeStore, (s) => s.scope);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;
  const activeIsRemote = Boolean(activeComputer && !isLocalComputer(activeComputer));

  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);
  const projectsList = useConnectionStore(activeConnection, (s) => s.projects);
  const linkStatus = useConnectionStore(activeConnection, (s) => s.status);
  const sessionsLoaded = useConnectionStore(activeConnection, (s) => s.sessionsLoaded);
  const listState = sessionListState(activeComputer, linkStatus, sessionsLoaded);
  const activeComputerTitle = displayComputerName(activeComputer, names, locale);

  const sessions = useMemo(() => Object.values(sessionsMap), [sessionsMap]);
  const archivedCount = useMemo(
    () => sessions.filter((session) => session.archived).length,
    [sessions],
  );
  const tree = useMemo(
    () => desktopSessionTree(projectsList, sessions),
    [projectsList, sessions],
  );

  const isAllScope = scope === "all";
  const showScopeSwitch = computers.length > 1 || isAllScope;

  // Retain live metadata connections when "All Computers" project scope is enabled
  const retainedMap = useRetainedMetadataConnections(computers, isAllScope);

  const allTrees = useMemo(() => {
    if (!isAllScope) return null;
    return computerSessionTrees(
      buildComputerSessionInputs(
        computers,
        activeConnection,
        retainedMap,
        names,
        locale,
      ),
    );
  }, [isAllScope, computers, activeConnection, retainedMap, names, locale]);

  const activeEntries = useMemo(() => {
    if (isAllScope && allTrees) {
      return allTrees.activeEntries;
    }
    return tree.active.map((session) => ({ computerKey: activeComputerKey, session }));
  }, [isAllScope, allTrees, tree.active, activeComputerKey]);

  const visibleGroups = useMemo(
    () => tree.groups.filter((g) => g.sessions.length > 0),
    [tree.groups],
  );
  const visibleAllComputers = useMemo(
    () =>
      allTrees
        ? allTrees.computers.filter(
            (c) => c.syncing || c.groups.some((g) => g.sessions.length > 0),
          )
        : [],
    [allTrees],
  );

  const placesProjectCount =
    isAllScope && allTrees ? allTrees.totalProjects : tree.groups.length;

  const fusionState = useFusionState(activeComputerKey);
  const activePlatform = useActiveDesktopPlatform();
  const fusionCapability = evaluateFusionCapability(
    activeComputerKey,
    activeComputer?.machine.platform,
    currentFusionCapabilityEnv(activePlatform),
  );
  const fusionDisabledReason = !fusionCapability.supported
    ? fusionCapabilityMessage(fusionCapability.reason, locale)
    : !activeComputer?.machine.online
      ? t("desktop.fusion.offlineHost", {
          name: displayComputerName(activeComputer, names, locale),
        })
      : undefined;

  const activeSessionId =
    activeRoute.kind === "session" ? activeRoute.sessionId : undefined;
  const activeSessionComputer =
    activeRoute.kind === "session" ? activeRoute.computerKey : undefined;

  const handleOpenSession = (computerKey: string, sessionId: string) => {
    const comp = engine.computerForKey(computerKey);
    if (comp && comp.key !== activeConnection?.computer.key) {
      engine.select(comp);
    }
    openSession(computerKey, sessionId);
    onNavigateDone?.();
  };

  const handleNewInProject = (computerKey: string, cwd: string) => {
    const comp = engine.computerForKey(computerKey);
    if (comp && comp.key !== activeConnection?.computer.key) {
      engine.select(comp);
    }
    onRequestNewSession(computerKey, cwd || undefined);
    onNavigateDone?.();
  };

  const handleNewOnComputer = (computerKey: string) => {
    const comp = engine.computerForKey(computerKey);
    if (comp && comp.key !== activeConnection?.computer.key) {
      engine.select(comp);
    }
    onRequestNewSession(computerKey);
    onNavigateDone?.();
  };

  const onlineComputersCount = computers.filter((c) => c.machine.online).length;

  // Rows are plain buttons in tab order; arrows move between the visible ones like a native list.
  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (isImeComposing(event) || !target.matches?.(ROW_SELECTOR)) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openRowContextMenu(target);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR),
    ).filter((row) => !row.closest("[inert]"));
    const index = rows.indexOf(target);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = rows[index + 1];
    else if (event.key === "ArrowUp") next = index > 0 ? rows[index - 1] : undefined;
    else if (event.key === "Home") next = rows[0];
    else if (event.key === "End") next = rows[rows.length - 1];
    else return;
    event.preventDefault();
    next?.focus();
  };

  const emptyHint =
    listState === "loading" ? (
      <div className="sidebar-empty-hint" data-state="loading">
        <DesktopIcon name="spinner" size="xs" />
        <span>{t("desktop.shell.connectingTo", { name: activeComputerTitle })}</span>
      </div>
    ) : listState === "offline" ? (
      <div className="sidebar-empty-hint" data-state="offline">
        {t("desktop.shell.offlineTitle", { name: activeComputerTitle })}
      </div>
    ) : (
      <div className="sidebar-empty-hint">{t("desktop.shell.noSessions")}</div>
    );

  return (
    <aside
      aria-label={t("desktop.workspace")}
      className={isPeekDrawer ? "desktop-sidebar-peek" : "desktop-sidebar"}
      data-open={isPeekDrawer ? "true" : undefined}
      onKeyDown={handleTreeKeyDown}
    >
      {isPeekDrawer ? (
        <div className="desktop-sidebar-peek-header">
          <span className="desktop-sidebar-wordmark">LinkShell</span>
          <IconButton
            icon="sidebar-toggle"
            variant="ghost"
            aria-pressed={!sidebarHidden}
            label={t("desktop.toggleSidebar")}
            shortcut="Mod+B"
            className="desktop-sidebar-header__toggle"
            onClick={() => handleToggleSidebar()}
          />
        </div>
      ) : (
        <div className="chrome-bar desktop-sidebar-header">
          <span className="desktop-sidebar-wordmark">LinkShell</span>
          <IconButton
            icon="sidebar-toggle"
            variant="ghost"
            aria-pressed={!sidebarHidden}
            label={t("desktop.toggleSidebar")}
            shortcut="Mod+B"
            className="desktop-sidebar-header__toggle"
            onClick={() => handleToggleSidebar()}
          />
        </div>
      )}

      {/* Paseo Top Action Stack: Full-width sculpted ComputerSwitcher + quiet ghost action rows */}
      <div className="sidebar-top-stack">
        <ComputerSwitcher onSelectDone={onNavigateDone} />

        <button
          type="button"
          className="desktop-new-session"
          onClick={() => {
            onRequestNewSession(activeComputerKey);
            onNavigateDone?.();
          }}
        >
          <span className="desktop-new-session__label">
            <DesktopIcon name="plus" size="sm" />
            <span className="ls-truncate">{t("desktop.newSession")}</span>
          </span>
          <Kbd shortcut="Mod+N" />
        </button>

        <button
          type="button"
          aria-label={t("desktop.commandCenter")}
          className="sidebar-search-row"
          onClick={() => {
            setCommandCenterOpen(true);
            onNavigateDone?.();
          }}
        >
          <span className="desktop-new-session__label">
            <DesktopIcon name="search" size="sm" />
            <span className="ls-truncate">{t("desktop.commandCenter")}</span>
          </span>
          <Kbd shortcut="Mod+K" />
        </button>
      </div>

      <div className="desktop-sidebar-scroll">
        {/* Primary Navigation Places (.desktop-places .desktop-place — E2E invariant!) */}
        <nav className="desktop-places" aria-label={t("desktop.workspace")}>
          <button
            type="button"
            aria-current={activeRoute.kind === "projects" ? "page" : undefined}
            className="desktop-place sidebar-nav-item"
            onClick={() => {
              navigate({ kind: "projects" });
              onNavigateDone?.();
            }}
          >
            <span className="desktop-place__icon" aria-hidden="true">
              <DesktopIcon name="folder-open" size="sm" />
            </span>
            <span className="desktop-place__label">{t("desktop.nav.projects")}</span>
            {placesProjectCount > 0 ? (
              <span className="desktop-place__count">{placesProjectCount}</span>
            ) : null}
          </button>

          <button
            type="button"
            aria-current={activeRoute.kind === "computers" ? "page" : undefined}
            className="desktop-place sidebar-nav-item"
            onClick={() => {
              navigate({ kind: "computers" });
              onNavigateDone?.();
            }}
          >
            <span className="desktop-place__icon" aria-hidden="true">
              <DesktopIcon name="computer-pc" size="sm" />
            </span>
            <span className="desktop-place__label">{t("desktop.nav.computers")}</span>
            {computers.length > 0 ? (
              <span className="desktop-place__count">
                {onlineComputersCount}/{computers.length}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            aria-current={activeRoute.kind === "archive" ? "page" : undefined}
            className="desktop-place sidebar-nav-item"
            onClick={() => {
              navigate({ kind: "archive" });
              onNavigateDone?.();
            }}
          >
            <span className="desktop-place__icon" aria-hidden="true">
              <DesktopIcon name="archive" size="sm" />
            </span>
            <span className="desktop-place__label">{t("desktop.nav.archive")}</span>
            {archivedCount > 0 ? (
              <span className="desktop-place__count">{archivedCount}</span>
            ) : null}
          </button>

          {activeIsRemote && activeComputer ? (
            <>
              <Tooltip
                content={
                  !activeComputer.machine.online
                    ? t("desktop.fusion.offlineHost", {
                        name: displayComputerName(activeComputer, names, locale),
                      })
                    : undefined
                }
                wrapDisabled={!activeComputer.machine.online}
              >
                <button
                  type="button"
                  disabled={!activeComputer.machine.online}
                  aria-current={activeRoute.kind === "screen" ? "page" : undefined}
                  className="desktop-place sidebar-nav-item"
                  onClick={() => {
                    openScreen(activeComputer.key);
                    onNavigateDone?.();
                  }}
                >
                  <span className="desktop-place__icon" aria-hidden="true">
                    <DesktopIcon name="remote-screen" size="sm" />
                  </span>
                  <span className="desktop-place__label">{t("desktop.nav.screen")}</span>
                </button>
              </Tooltip>

              {fusionCapability.supported ? (
                <Tooltip
                  content={fusionDisabledReason}
                  wrapDisabled={Boolean(fusionDisabledReason)}
                >
                  <button
                    type="button"
                    disabled={Boolean(fusionDisabledReason)}
                    aria-current={activeRoute.kind === "fusion" ? "page" : undefined}
                    className="desktop-place sidebar-nav-item"
                    onClick={() => {
                      openFusion(activeComputer.key);
                      if (fusionState.phase === "idle") {
                        void connectAndStartComputerFusion(activeComputer.key);
                      }
                      onNavigateDone?.();
                    }}
                  >
                    <span className="desktop-place__icon" aria-hidden="true">
                      {fusionState.phase === "starting" ? (
                        <DesktopIcon name="spinner" size="sm" />
                      ) : (
                        <DesktopIcon name="fusion-mode" size="sm" />
                      )}
                    </span>
                    <span className="desktop-place__label">{t("desktop.nav.fusion")}</span>
                    {fusionState.connected ? <StatusDot tone="ok" size="sm" /> : null}
                  </button>
                </Tooltip>
              ) : null}
            </>
          ) : null}
        </nav>

        {/* Unified Sessions Scope Bar governing BOTH Active & By Project */}
        {showScopeSwitch ? (
          <div className="sidebar-sessions-scope-bar">
            <span className="sidebar-sessions-scope-bar__label">
              {t("desktop.nav.sessions")}
            </span>
            <div
              className="sidebar-scope-switch"
              role="group"
              aria-label={t("desktop.nav.sessions")}
            >
              <button
                type="button"
                aria-pressed={scope === "computer"}
                className="sidebar-scope-switch__btn"
                onClick={() => setProjectScope("computer")}
              >
                {t("desktop.nav.scopeComputer")}
              </button>
              <button
                type="button"
                aria-pressed={scope === "all"}
                className="sidebar-scope-switch__btn"
                onClick={() => setProjectScope("all")}
              >
                {t("desktop.nav.scopeAll")}
              </button>
            </div>
          </div>
        ) : null}

        {/* Paseo Status Section 1: Active Working Set (waiting -> running -> <6h recent) */}
        {activeEntries.length > 0 ? (
          <section
            className="sidebar-section"
            data-section="active"
            aria-label={t("desktop.nav.activeSessions")}
          >
            <div className="sidebar-section__header">
              <span className="sidebar-section__title">
                {activeEntries.some(({ session }) => sessionGroup(session) === "waiting") ? (
                  <StatusDot tone="waiting" size="sm" />
                ) : activeEntries.some(({ session }) => sessionGroup(session) === "running") ? (
                  <StatusDot tone="running" size="sm" />
                ) : null}
                <span>
                  {t("desktop.nav.activeSessions")} ({activeEntries.length})
                </span>
              </span>
            </div>
            <div className="sidebar-section__cards">
              {activeEntries.map(({ computerKey: entryCompKey, session }) => {
                const entryConn =
                  entryCompKey === activeConnection?.computer.key
                    ? activeConnection
                    : retainedMap[entryCompKey];
                const entryComp = computers.find((c) => c.key === entryCompKey);
                const entryBadge = isAllScope
                  ? displayComputerName(entryComp, names, locale)
                  : undefined;
                return (
                  <SidebarSessionRow
                    key={`active-${entryCompKey}-${session.id}`}
                    session={session}
                    computerKey={entryCompKey}
                    connection={entryConn}
                    isPinnedSection
                    computerBadge={entryBadge}
                    isActiveRoute={
                      activeSessionId === session.id &&
                      activeSessionComputer === entryCompKey
                    }
                    onOpen={handleOpenSession}
                  />
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Workspaces & Session Tree (recency-ordered By Project) */}
        <section className="sidebar-section" aria-label={t("desktop.nav.projects")}>
          <div className="sidebar-section__header">
            <span className="sidebar-section__title">
              <span>{t("desktop.shell.byProject")}</span>
            </span>
          </div>

          {isAllScope && allTrees ? (
            visibleAllComputers.length > 0 ? (
              visibleAllComputers.map((compTree) => {
                const comp = computers.find((c) => c.key === compTree.key);
                const conn =
                  compTree.key === activeConnection?.computer.key
                    ? activeConnection
                    : retainedMap[compTree.key];
                const compTitle = displayComputerName(comp, names, locale);
                return (
                  <ComputerTreeBlock
                    key={compTree.key}
                    compTree={compTree}
                    computer={comp}
                    computerTitle={compTitle}
                    connection={conn}
                    activeSessionId={activeSessionId}
                    activeComputerKey={activeSessionComputer}
                    onOpenSession={handleOpenSession}
                    onNewInProject={handleNewInProject}
                    onNewOnComputer={handleNewOnComputer}
                  />
                );
              })
            ) : (
              <div className="sidebar-empty-hint">{t("desktop.shell.noSessions")}</div>
            )
          ) : visibleGroups.length > 0 ? (
            visibleGroups.map((group, idx) => (
              <ProjectTreeBlock
                key={group.key}
                group={group}
                groupIndex={idx}
                computerKey={activeComputerKey}
                connection={activeConnection}
                activeSessionId={activeSessionId}
                activeComputerKey={activeSessionComputer}
                onOpenSession={handleOpenSession}
                onNewInProject={handleNewInProject}
              />
            ))
          ) : (
            emptyHint
          )}
        </section>
      </div>

      <LocalHostCapsule onActionDone={onNavigateDone} />
    </aside>
  );
}
