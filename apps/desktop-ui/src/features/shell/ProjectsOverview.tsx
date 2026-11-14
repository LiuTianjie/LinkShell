import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  computerNames,
  computerSessionTrees,
  desktopSessionTree,
  engine,
  projectScopeStore,
  revealInFilesLabel,
  revealPathOnDesktop,
  sessionGroup,
  sessionTitle,
  setProjectScope,
  useActiveDesktopPlatform,
  useI18n,
  useRouter,
  type Computer,
  type DesktopProjectGroup,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuItem,
  StatusDot,
} from "../../primitives";
import {
  buildComputerSessionInputs,
  computerPlatformIcon,
  connectionRouteBadge,
  displayComputerName,
  formatProjectCountLabel,
  formatRelativeTimestamp,
  formatSessionCountLabel,
  relativeSubdirLabel,
  shortenHomePath,
  useConnectionStore,
  useRetainedMetadataConnections,
} from "./shell-helpers";

const INITIAL_PREVIEW_SESSIONS = 5;

export interface ProjectsOverviewProps {
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
}

function readConsolidatedSessionCount(group: DesktopProjectGroup): number {
  const extra =
    "sessionCount" in group && typeof group.sessionCount === "number"
      ? group.sessionCount
      : 0;
  return Math.max(extra, group.sessions.length);
}

function readProjectBranch(group: DesktopProjectGroup): string | undefined {
  if ("branch" in group && typeof group.branch === "string" && group.branch.trim()) {
    return group.branch.trim();
  }
  return group.sessions.find((s) => s.worktree?.branch)?.worktree?.branch;
}

function selectComputerIfNeeded(computer: Computer | undefined): void {
  if (!computer) return;
  if (computer.key !== engine.state.getState().connection?.computer.key) {
    engine.select(computer);
  }
}

function matchesProjectFilter(group: DesktopProjectGroup, q: string): boolean {
  if (!q) return true;
  if (group.name.toLowerCase().includes(q)) return true;
  if (group.key.toLowerCase().includes(q)) return true;
  if (group.cwd && group.cwd.toLowerCase().includes(q)) return true;
  return false;
}

interface ProjectListRowProps {
  computerKey: string;
  computer: Computer | undefined;
  computerTitle: string;
  showComputerBadge: boolean;
  group: DesktopProjectGroup;
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
}

function ProjectListRow({
  computerKey,
  computer,
  computerTitle,
  showComputerBadge,
  group,
  onRequestNewSession,
}: ProjectListRowProps) {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const navigate = useRouter((s) => s.navigate);
  const openSession = useRouter((s) => s.openSession);

  const [expanded, setExpanded] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);

  const isLocal = computerKey === DESKTOP_LOCAL;
  const projectPath = group.cwd || group.key;
  const hasSessions = group.sessions.length > 0;
  const totalSessions = readConsolidatedSessionCount(group);
  const branch = readProjectBranch(group);
  const latestSession = group.sessions[0];
  const latestEpoch =
    latestSession?.updatedAt ??
    latestSession?.createdAt ??
    (group.lastActiveAt > 0 ? group.lastActiveAt : undefined);
  const latestTimestamp = latestEpoch
    ? formatRelativeTimestamp(latestEpoch, locale)
    : "";
  const countAndTime = latestTimestamp
    ? `${formatSessionCountLabel(totalSessions, locale)} · ${latestTimestamp}`
    : formatSessionCountLabel(totalSessions, locale);

  const visibleSessions = showAllSessions
    ? group.sessions
    : group.sessions.slice(0, INITIAL_PREVIEW_SESSIONS);
  const hiddenSessionCount = Math.max(
    0,
    group.sessions.length - INITIAL_PREVIEW_SESSIONS,
  );

  const moreActionsLabel =
    locale === "en"
      ? `Actions for ${group.name}`
      : locale === "ja"
        ? `${group.name} の操作`
        : `${group.name} 更多操作`;

  return (
    <div
      role="listitem"
      className="ls-entity-group"
      data-open={expanded && hasSessions ? "true" : "false"}
    >
      <div className="ls-entity-row">
        <button
          type="button"
          aria-expanded={hasSessions ? expanded : undefined}
          className="ls-entity-row__main"
          onClick={() => {
            if (hasSessions) {
              setExpanded((prev) => !prev);
            } else {
              selectComputerIfNeeded(computer);
              onRequestNewSession(computerKey, projectPath || undefined);
            }
          }}
        >
          <span
            className="ls-entity-row__chevron"
            data-empty={!hasSessions ? "true" : undefined}
            aria-hidden="true"
          >
            <DesktopIcon name="chevron-right" size="xs" />
          </span>

          <span className="ls-entity-row__folder" aria-hidden="true">
            <DesktopIcon name="folder" size="sm" />
          </span>

          <span className="ls-entity-row__title ls-truncate">{group.name}</span>

          {branch ? (
            <Badge icon="git-branch" tone="neutral">
              <span className="ls-truncate">{branch}</span>
            </Badge>
          ) : null}

          {group.running > 0 ? (
            <Badge dot="running" tone="running">
              {group.running}
            </Badge>
          ) : null}

          {showComputerBadge ? <Badge tone="neutral">{computerTitle}</Badge> : null}

          {projectPath && !group.generated ? (
            <span className="ls-entity-row__path ls-truncate" title={projectPath}>
              {shortenHomePath(projectPath)}
            </span>
          ) : null}
        </button>

        <div className="ls-entity-row__actions">
          <span className="ls-entity-row__meta">{countAndTime}</span>

          <IconButton
            icon="plus"
            variant="ghost"
            label={`${t("desktop.newSession")}: ${group.name}`}
            tooltip={t("desktop.newSession")}
            onClick={() => {
              selectComputerIfNeeded(computer);
              onRequestNewSession(computerKey, projectPath || undefined);
            }}
          />

          <Menu
            placement="bottom-end"
            label={moreActionsLabel}
            trigger={
              <IconButton
                icon="more-horizontal"
                variant="ghost"
                label={moreActionsLabel}
              />
            }
          >
            <MenuItem
              icon="file-code"
              onSelect={() => {
                selectComputerIfNeeded(computer);
                navigate({
                  kind: "files",
                  computerKey,
                  path: projectPath || undefined,
                });
              }}
            >
              {locale === "en"
                ? "Browse Files"
                : locale === "ja"
                  ? "ファイルを参照"
                  : "浏览文件"}
            </MenuItem>
            {projectPath ? (
              <MenuItem
                icon="copy"
                onSelect={() => {
                  void navigator.clipboard?.writeText(projectPath);
                }}
              >
                {t("desktop.menu.copyPath")}
              </MenuItem>
            ) : null}
            {isLocal && projectPath ? (
              <MenuItem
                icon="external-link"
                onSelect={() => void revealPathOnDesktop(projectPath)}
              >
                {revealInFilesLabel(locale, activePlatform)}
              </MenuItem>
            ) : null}
          </Menu>
        </div>
      </div>

      {hasSessions ? (
        <div
          className="ls-collapse-grid"
          data-open={expanded ? "true" : "false"}
        >
          <div className="ls-collapse-grid__inner" inert={!expanded || undefined}>
            <div className="ls-entity-sublist">
              {visibleSessions.map((session) => {
                const stateGroup = sessionGroup(session);
                const subdir = relativeSubdirLabel(projectPath, session.cwd);
                return (
                  <button
                    key={session.id}
                    type="button"
                    className="ls-entity-subrow"
                    onClick={() => {
                      selectComputerIfNeeded(computer);
                      openSession(computerKey, session.id);
                    }}
                  >
                    <span className="ls-entity-subrow__lead" aria-hidden="true">
                      <AgentMark agent={session.agent} size={14} />
                      {stateGroup === "running" ? (
                        <StatusDot tone="running" size="sm" className="ls-entity-subrow__dot" />
                      ) : stateGroup === "waiting" ? (
                        <StatusDot tone="waiting" size="sm" className="ls-entity-subrow__dot" />
                      ) : null}
                    </span>

                    <span className="ls-entity-subrow__title ls-truncate">
                      {sessionTitle(session)}
                    </span>

                    {subdir ? (
                      <span className="ls-entity-subrow__subdir ls-truncate" title={session.cwd}>
                        {subdir}
                      </span>
                    ) : null}

                    <span className="ls-entity-subrow__time">
                      {formatRelativeTimestamp(
                        session.updatedAt ?? session.createdAt,
                        locale,
                      )}
                    </span>
                  </button>
                );
              })}

              {hiddenSessionCount > 0 ? (
                <button
                  type="button"
                  className="ls-entity-sublist__more"
                  onClick={() => setShowAllSessions((prev) => !prev)}
                >
                  <DesktopIcon
                    name={showAllSessions ? "chevron-up" : "chevron-down"}
                    size="xs"
                  />
                  <span>
                    {showAllSessions
                      ? t("desktop.nav.showLess")
                      : t("desktop.nav.showMore", { count: hiddenSessionCount })}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsOverview({ onRequestNewSession }: ProjectsOverviewProps) {
  const { locale, t } = useI18n();

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);
  const scope = useStore(projectScopeStore, (s) => s.scope);

  const [filter, setFilter] = useState("");
  const activeComputer = activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;

  const isAllScope = scope === "all";
  const showScopeSwitch = computers.length > 1 || isAllScope;

  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);
  const projectsList = useConnectionStore(activeConnection, (s) => s.projects);
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

  const singleTree = useMemo(
    () => desktopSessionTree(projectsList, Object.values(sessionsMap)),
    [projectsList, sessionsMap],
  );

  const query = filter.trim().toLowerCase();

  const filteredSingleGroups = useMemo(() => {
    if (!query) return singleTree.groups;
    return singleTree.groups.filter((g) => matchesProjectFilter(g, query));
  }, [singleTree.groups, query]);

  const filteredComputerSections = useMemo(() => {
    if (!isAllScope || !allTrees) return [];
    return allTrees.computers
      .map((compTree) => {
        const filteredGroups = query
          ? compTree.groups.filter((g) => matchesProjectFilter(g, query))
          : compTree.groups;
        return { compTree, filteredGroups };
      })
      .filter(
        ({ compTree, filteredGroups }) =>
          filteredGroups.length > 0 || (!query && compTree.syncing),
      );
  }, [isAllScope, allTrees, query]);

  const totalProjectCount =
    isAllScope && allTrees ? allTrees.totalProjects : singleTree.groups.length;
  const hasAnyProjectsOrSyncing =
    isAllScope && allTrees
      ? allTrees.computers.length > 0
      : singleTree.groups.length > 0;
  const hasVisibleResults = isAllScope
    ? filteredComputerSections.length > 0
    : filteredSingleGroups.length > 0;

  const syncingBadgeLabel =
    locale === "en" ? "Syncing" : locale === "ja" ? "同期中" : "同步中";
  const syncingRowLabel =
    locale === "en"
      ? "Loading projects and sessions"
      : locale === "ja"
        ? "プロジェクトとセッションを読み込み中"
        : "正在同步项目与会话";

  return (
    <div className="shell-page">
      <div className="shell-page__inner">
        <div className="shell-page__header">
          <div className="shell-page__heading">
            <h1 className="shell-page__title">{t("desktop.nav.projects")}</h1>
            <p className="shell-page__subtitle">
              {formatProjectCountLabel(totalProjectCount, locale)}
            </p>
          </div>

          <div className="shell-page__actions">
            {showScopeSwitch ? (
              <div
                className="sidebar-scope-switch"
                role="group"
                aria-label={t("desktop.nav.projects")}
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
            ) : null}

            <Button
              size="md"
              variant="primary"
              leadingIcon="plus"
              onClick={() => onRequestNewSession(activeComputerKey)}
            >
              {t("desktop.newSession")}
            </Button>
          </div>
        </div>

        {hasAnyProjectsOrSyncing ? (
          <div className="shell-toolbar-bar">
            <div style={{ flex: "1 1 260px", maxInlineSize: "360px", minInlineSize: 0 }}>
              <Input
                size="md"
                leadingIcon="search"
                value={filter}
                placeholder={
                  locale === "en"
                    ? "Search projects or paths"
                    : locale === "ja"
                      ? "プロジェクト名またはパスを検索"
                      : "搜索项目或路径"
                }
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {hasVisibleResults ? (
          isAllScope ? (
            <div className="ls-computer-sections">
              {filteredComputerSections.map(({ compTree, filteredGroups }) => {
                const comp = computers.find((c) => c.key === compTree.key);
                const compTitle = displayComputerName(comp, names, locale);
                const routeBadge = connectionRouteBadge(comp, undefined, locale);

                return (
                  <section
                    key={compTree.key}
                    className="ls-computer-section"
                    data-computer-key={compTree.key}
                    aria-label={compTitle}
                  >
                    <div className="ls-computer-section__header">
                      <div className="ls-computer-section__title-group">
                        <span className="ls-computer-section__icon" aria-hidden="true">
                          <DesktopIcon
                            name={computerPlatformIcon(comp?.machine.platform)}
                            size="sm"
                          />
                        </span>
                        <StatusDot
                          tone={compTree.online ? "ok" : "offline"}
                          size="sm"
                        />
                        <h2 className="ls-computer-section__title ls-truncate">
                          {compTitle}
                        </h2>
                        <Badge icon={routeBadge.icon} tone={routeBadge.tone}>
                          {routeBadge.label}
                        </Badge>
                        <span className="ls-computer-section__count">
                          {compTree.syncing && filteredGroups.length === 0
                            ? syncingBadgeLabel
                            : formatProjectCountLabel(filteredGroups.length, locale)}
                        </span>
                      </div>

                      <div className="ls-computer-section__actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon="plus"
                          disabled={!compTree.online}
                          onClick={() => {
                            selectComputerIfNeeded(comp);
                            onRequestNewSession(compTree.key);
                          }}
                        >
                          {t("desktop.newSession")}
                        </Button>
                      </div>
                    </div>

                    {filteredGroups.length > 0 ? (
                      <div
                        className="ls-entity-list"
                        role="list"
                        aria-label={compTitle}
                      >
                        {filteredGroups.map((group) => (
                          <ProjectListRow
                            key={`${compTree.key}:${group.key}`}
                            computerKey={compTree.key}
                            computer={comp}
                            computerTitle={compTitle}
                            showComputerBadge={false}
                            group={group}
                            onRequestNewSession={onRequestNewSession}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="ls-entity-list" aria-busy="true">
                        <div className="ls-computer-section__sync-row">
                          <DesktopIcon name="spinner" size="xs" />
                          <span className="ls-truncate">{syncingRowLabel}</span>
                        </div>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div
              className="ls-entity-list"
              role="list"
              aria-label={t("desktop.nav.projects")}
            >
              {filteredSingleGroups.map((group) => {
                const compTitle = displayComputerName(
                  activeComputer,
                  names,
                  locale,
                );
                return (
                  <ProjectListRow
                    key={`${activeComputerKey}:${group.key}`}
                    computerKey={activeComputerKey}
                    computer={activeComputer}
                    computerTitle={compTitle}
                    showComputerBadge={false}
                    group={group}
                    onRequestNewSession={onRequestNewSession}
                  />
                );
              })}
            </div>
          )
        ) : (
          <EmptyState
            icon="folder-open"
            title={t("desktop.nav.projects")}
            description={
              locale === "en"
                ? "Start a coding agent session in any directory on your Mac or PC."
                : locale === "ja"
                  ? "任意のフォルダでエージェントセッションを開始しましょう。"
                  : "在任意代码仓库或文件夹中启动会话，项目将自动按创建时间归类。"
            }
            actions={
              <Button
                variant="primary"
                leadingIcon="plus"
                onClick={() => onRequestNewSession(activeComputerKey)}
              >
                {t("desktop.newSession")}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
