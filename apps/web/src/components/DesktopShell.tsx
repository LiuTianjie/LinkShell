import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import { HOST_PROTOCOL, type SessionSummary } from "@linkshell/wire";
import type { ProjectGroup } from "@linkshell/client-core";
import { LOCALE_LABELS, isLocalePreference, t as translate, type I18nKey, type Locale } from "@linkshell/client-core";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  File,
  GitBranch,
  Globe,
  Keyboard,
  Laptop,
  MessageSquare,
  Monitor,
  PanelLeft,
  Moon,
  Plus,
  RefreshCw,
  Search,
  SquarePen,
  Sun,
  SunMoon,
  Terminal,
  type LucideIcon,
  Lock,
  Settings2,
} from "lucide-react";
// Keep the app icon's white tile visible in both desktop themes.
import appIcon from "../assets/app-icon.png";
import { engine, type Computer, type Connection } from "../live/engine";
import { baseName, titleOf } from "../live/common";
import { computerName, computerNames } from "../live/computer-names";
import { DESKTOP_LOCAL, isElectronDesktop, isWindowsDesktop, reportDesktopWorkspace, setDesktopContentFocus, THIS_COMPUTER } from "../live/desktop";
import { newVersion, management, startManagement } from "../live/management-store";
import { isManageView, managePage, manageView, type ManagePage } from "../live/management-model";
import { ManagementNav } from "../live/Management";
import {
  desktopModeShortcuts,
  desktopShortcuts,
  keysBelongToContent,
  matchesShortcut,
  sendDesktopCommand,
  shortcutText,
  useDesktopCommand,
  deferNewSession,
  opensNewSessions,
} from "../live/desktop-commands";
import { screenComputerKey } from "../live/screen-route";
import { sessionGroup, sessionNeedsAttention, sessionPreview } from "../live/session-list";
import { desktopSessionTree, sessionFamilies } from "../live/desktop-session-tree";
import { compactTime } from "../live/session-time";
import { readLocal, saveLocal } from "../live/storage";
import { ProjectOverview, projectScope, setProjectScope, type ProjectSource } from "../live/project-overview";
import type { CrossComputerProject } from "../live/cross-computer-projects";
import { Badge } from "./ui/badge";
import { useApplyDesktopAppearance, useDesktopAppearance, type Appearance } from "../live/desktop-appearance";
import { setWebLocalePreference, useLocale, useLocalePreference, useT } from "../live/i18n";
import type { ConsoleShellProps } from "./ConsoleShell";
import { CommandCenter } from "./CommandCenter";
import { ColumnResizer } from "./ColumnResizer";
import { useDialogs } from "./Dialogs";
import { openProjectMenu, openSessionMenu } from "./sidebar-menus";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import "../styles/desktop.css";
import "../styles/desktop-session.css";
import "../styles/desktop-components.css";
import "../styles/desktop-resources.css";
import "../styles/desktop-preview.css";
import "../styles/management.css";

type NavigationItem = { id: string; titleKey: I18nKey; icon: LucideIcon };

// The sidebar is mostly the working set (what waits on you, projects and their sessions), as in
// Codex. Above it, every place on this computer in one flat list: a fold would only add a click.
// Projects open from the tree's own heading; 电脑 and 已归档 from the computer menu, the session
// list or ⌘K.
const navigationItems: NavigationItem[] = [
  { id: "home", titleKey: "nav.sessions", icon: MessageSquare },
  { id: "screen", titleKey: "nav.screen", icon: Monitor },
  { id: "terminals", titleKey: "nav.terminals", icon: Terminal },
  { id: "files", titleKey: "nav.files", icon: File },
  { id: "ports", titleKey: "nav.ports", icon: Globe },
  { id: "worktrees", titleKey: "nav.worktrees", icon: GitBranch },
];
const PROJECTS_SHOWN = 8;
const SESSIONS_SHOWN = 5;
const ACTIVE_SESSIONS_SHOWN = 6;

function connectionLabel(status: string, locale: Locale = "zh"): string {
  if (status === "online") return translate(locale, "connection.online");
  if (status === "locked") return translate(locale, "connection.locked");
  if (status === "connecting") return translate(locale, "connection.connecting");
  if (status === "reconnecting") return translate(locale, "connection.reconnecting");
  return translate(locale, "connection.offline");
}

function sessionTone(session: SessionSummary): "waiting" | "running" | "error" | undefined {
  if (sessionNeedsAttention(session)) return "waiting";
  if (session.state === "running") return "running";
  if (session.state === "error") return "error";
  return undefined;
}


/**
 * Whether the Electron window is translucent (vibrancy on: focused, below 4K, not turned off);
 * the sidebar shows the desktop through it only then. Also full screen, where there is no
 * traffic-light row to leave room for.
 */
function useWindowSurface() {
  useEffect(() => {
    if (!isElectronDesktop) return;
    const root = document.documentElement;
    root.dataset.surface = "translucent";
    const surface = (event: Event) => {
      root.dataset.surface = (event as CustomEvent<{ translucent?: boolean }>).detail?.translucent ? "translucent" : "opaque";
    };
    const window_ = (event: Event) => {
      if ((event as CustomEvent<{ fullscreen?: boolean }>).detail?.fullscreen) root.dataset.fullscreen = "";
      else delete root.dataset.fullscreen;
    };
    window.addEventListener("linkshell-desktop-surface", surface);
    window.addEventListener("linkshell-desktop-window", window_);
    return () => {
      window.removeEventListener("linkshell-desktop-surface", surface);
      window.removeEventListener("linkshell-desktop-window", window_);
    };
  }, []);
}

function ComputerPicker({
  connect,
  selectComputer,
  navigate,
}: Pick<ConsoleShellProps, "connect" | "selectComputer" | "navigate">) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const selected = state.computers.find(
    (computer) => computer.key === (state.connection && engine.computerForKey(state.connection.computer.key)?.key),
  ) ?? state.connection?.computer;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { await engine.refreshComputers(); } catch (error) { engine.report(error); } finally { setRefreshing(false); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="desktop-computer-picker" aria-label="切换当前电脑">
          {selected && state.connection?.computer.key === selected.key
            ? <PickerFacts computer={selected} connection={state.connection} name={computerName(selected, names)} />
            : <PickerCopy name={selected ? computerName(selected, names) : "选择电脑"} online={!!selected?.machine.online}
                detail={selected ? `${selected.key === DESKTOP_LOCAL ? THIS_COMPUTER : "远程电脑"} · ${selected.machine.online ? "在线" : "离线"}` : "登录账号或使用配对码"} />}
          <ChevronDown size={14} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="desktop-computer-menu" side="bottom" align="start" sideOffset={6}>
        {/* The Electron window has no status line: how this computer is reached lives here. */}
        {isElectronDesktop && state.connection && (
          <>
            <ConnectionSummary connection={state.connection} />
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>切换电脑</DropdownMenuLabel>
        {state.computers.map((computer) => (
          <DropdownMenuItem key={computer.key} onSelect={() => selectComputer(computer)}>
            <span className="desktop-presence" data-online={computer.machine.online || undefined} />
            <span className="desktop-menu-computer-name">{computerName(computer, names)}</span>
            {computer.machine.locked && <Lock className="computer-lock-mark" size={12} aria-label="已设置访问密码" />}
            {computer.key === DESKTOP_LOCAL && <small>本机</small>}
            {selected?.key === computer.key && <Check size={14} />}
          </DropdownMenuItem>
        ))}
        {!state.computers.length && <p className="desktop-menu-empty">连接后，在这里切换工作电脑。</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("computers")}><Laptop />电脑与 Agent</DropdownMenuItem>
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void refresh(); }} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />{refreshing ? "正在刷新…" : "刷新电脑列表"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={connect}><Plus />连接电脑</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The current computer's connection: its state, the route, the Host's version and whether it is behind. */
function ConnectionSummary({ connection }: { connection: Connection }) {
  const locale = useLocale();
  const status = useStore(connection.store, (state) => state.status);
  const detail = useStore(connection.store, (state) => state.statusDetail);
  const machine = useStore(connection.store, (state) => state.machine);
  let route = "本机 Host";
  if (connection.computer.key !== DESKTOP_LOCAL) {
    try { route = `经 ${new URL(connection.computer.gateway).host}`; } catch { route = "经网关"; }
  }
  const behind = machine && (machine.protocol ?? 0) < HOST_PROTOCOL;
  return (
    <div className="desktop-connection-summary">
      <span><span className="desktop-presence" data-online={status === "online" || undefined} />{status === "online" ? route : detail ?? connectionLabel(status, locale)}</span>
      {machine?.hostVersion && <span className="desktop-status-meta">Host {machine.hostVersion}</span>}
      {behind && <span data-tone="waiting">电脑上的 LinkShell 较旧，部分功能不可用</span>}
    </div>
  );
}

function PickerCopy({ name, detail, online }: { name: string; detail: string; online: boolean }) {
  // In the Electron window one line, as Codex's workspace switcher: the name, its state on hover.
  return (
    <>
      <span className="desktop-presence" data-online={online || undefined} />
      <span className="desktop-computer-copy" title={isElectronDesktop ? detail : undefined}>
        <strong>{name}</strong>
        {!isElectronDesktop && <span>{detail}</span>}
      </span>
    </>
  );
}

function PickerFacts({ computer, connection, name }: { computer: Computer; connection: Connection; name: string }) {
  const locale = useLocale();
  const status = useStore(connection.store, (state) => state.status);
  return (
    <PickerCopy
      name={name}
      online={status === "online"}
      detail={`${computer.key === DESKTOP_LOCAL ? THIS_COMPUTER : "远程电脑"} · ${connectionLabel(status, locale)}`}
    />
  );
}

function SessionCountBadge({ connection }: { connection: Connection }) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const waiting = Object.values(sessions).filter((session) => !session.archived && sessionNeedsAttention(session)).length;
  if (!waiting) return null;
  return <span className="desktop-nav-badge" title={`${waiting} 项等你处理`}>{waiting}</span>;
}

function SessionRow({
  session,
  computerKey,
  active,
  navigate,
  detail,
  menuOpen,
  openMenu,
  child,
  fold,
}: {
  session: SessionSummary;
  computerKey: string;
  active: boolean;
  navigate: (view: string) => void;
  detail?: string;
  /** Its right-click menu is showing: the row stays marked, as a native list's does. */
  menuOpen?: boolean;
  openMenu?: (at: { x: number; y: number }) => void;
  /** Started from or forked off the row above it (its family's root): drawn under it. */
  child?: boolean;
  /** It has such sessions under it: they fold away behind its chevron (or ← / →). */
  fold?: { open: boolean; toggle: () => void };
}) {
  const tone = sessionTone(session);
  return (
    <button
      type="button"
      className="tree-session"
      data-session-id={session.id}
      data-computer-key={computerKey}
      data-active={active || undefined}
      data-menu-open={menuOpen || undefined}
      data-child={child || undefined}
      aria-current={active ? "page" : undefined}
      aria-expanded={fold ? fold.open : undefined}
      title={`${titleOf(session)}${tone === "waiting" ? " · 等你处理" : tone === "running" ? " · 运行中" : tone === "error" ? " · 出错" : ""}`}
      onClick={() => navigate(session.id)}
      onKeyDown={fold && ((event) => {
        if ((event.key === "ArrowLeft" && fold.open) || (event.key === "ArrowRight" && !fold.open)) { event.preventDefault(); fold.toggle(); }
      })}
      onContextMenu={openMenu && ((event) => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }); })}
    >
      <span className="tree-state" data-tone={tone} aria-hidden />
      <span className="tree-title">
        <span className={fold ? "tree-name" : undefined}>
          {fold ? <span>{titleOf(session)}</span> : titleOf(session)}
          {fold && (
            // Inside the row so it reads as part of the title, as the Claude app draws it; it folds
            // without opening the session.
            <span className="tree-fold" aria-hidden onClick={(event) => { event.stopPropagation(); fold.toggle(); }}>
              <ChevronDown size={12} />
            </span>
          )}
        </span>
        {detail && <small title={detail}>{detail}</small>}
      </span>
      <time dateTime={new Date(session.updatedAt).toISOString()}>{compactTime(session.updatedAt)}</time>
    </button>
  );
}

/** Live work stays separate from the project tree's stable creation order. */
function SessionTree({ connection, view, navigate, background = false, scopeMenu, hideHeading = false, projectKey }: {
  connection: Connection; view: string; navigate: (view: string) => void; background?: boolean;
  scopeMenu?: ReactNode; hideHeading?: boolean; projectKey?: string;
}) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const projects = useStore(connection.store, (state) => state.projects);
  const loaded = useStore(connection.store, (state) => state.sessionsLoaded);
  const status = useStore(connection.store, (state) => state.status);
  const sessionsError = useStore(connection.store, (state) => state.sessionsError);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const storageKey = `desktopTree.${connection.computer.key}`;
  const [open, setOpen] = useState<Record<string, boolean>>(() => readLocal(storageKey, {}));
  const [more, setMore] = useState<Record<string, boolean>>({});
  const foldKey = `desktopTreeFolded.${connection.computer.key}`;
  const [folded, setFolded] = useState<Record<string, boolean>>(() => readLocal(foldKey, {}));
  const toggleFold = (id: string) => {
    const next = { ...folded, [id]: !folded[id] };
    setFolded(next);
    try { saveLocal(foldKey, next); } catch { /* The tree still works without storage. */ }
  };
  const [allProjects, setAllProjects] = useState(false);
  const [allActive, setAllActive] = useState(false);
  const tree = useMemo(() => desktopSessionTree(projects, Object.values(sessions)), [sessions, projects]);
  const active = projectKey ? [] : tree.active;
  const groups = projectKey ? tree.groups.filter((group) => group.key === projectKey) : tree.groups;
  const currentProject = groups.find((group) => group.sessions.some((session) => session.id === view))?.key;
  const isOpen = (group: ProjectGroup, index: number) =>
    projectKey !== undefined || (open[group.key] ?? (group.key === currentProject || index === 0));
  const toggle = (group: ProjectGroup, index: number) => {
    const next = { ...open, [group.key]: !isOpen(group, index) };
    setOpen(next);
    try { saveLocal(storageKey, next); } catch { /* The tree still works without storage. */ }
  };
  // Creation order puts an old project you're working in past the first eight, and an old session
  // past a project's first five: the one open stays in its place in the tree regardless.
  const shown = allProjects ? groups : groups.filter((group, index) => index < PROJECTS_SHOWN || group.key === currentProject);
  const dialogs = useDialogs();
  const [menuFor, setMenuFor] = useState<string>();
  const withMenu = (key: string, open: (at: { x: number; y: number }) => Promise<void>) =>
    isElectronDesktop && !background ? (at: { x: number; y: number }) => { setMenuFor(key); void open(at).finally(() => setMenuFor(undefined)); } : undefined;
  const sessionMenu = (session: SessionSummary) => withMenu(session.id, (at) => openSessionMenu(session, { connection, dialogs, navigate, at }));
  return (
    <>
      {active.length > 0 && (
        <section className="tree-section" aria-label="活跃会话">
          <h2 className="tree-heading">活跃会话<span>{active.length}</span></h2>
          {(allActive ? active : active.slice(0, ACTIVE_SESSIONS_SHOWN)).map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              computerKey={engine.computerForKey(connection.computer.key)?.key ?? connection.computer.key}
              active={view === session.id}
              navigate={navigate}
              detail={`${baseName(session.worktree?.source ?? session.cwd)} · ${sessionNeedsAttention(session) ? "等你处理" : sessionPreview(session) || "运行中"}`}
              menuOpen={menuFor === session.id}
              openMenu={sessionMenu(session)}
            />
          ))}
          {active.length > ACTIVE_SESSIONS_SHOWN && (
            <button type="button" className="tree-more" onClick={() => setAllActive((value) => !value)}>
              {allActive ? "收起" : `显示其余 ${active.length - ACTIVE_SESSIONS_SHOWN} 个活跃会话`}
            </button>
          )}
        </section>
      )}
      <section className={projectKey ? "tree-project-member-sessions" : "tree-section"} aria-label="项目">
        {!hideHeading && <h2 className="tree-heading">
          <button type="button" className="tree-heading-link" title="打开项目列表" onClick={() => navigate("projects")}>
            项目
          </button>
          {scopeMenu}
          {!background && <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="tree-heading-action" aria-label="新建会话" onClick={() => sendDesktopCommand({ command: "new-session" })}>
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>新建会话 · {shortcutText(desktopShortcuts.newSession)}</TooltipContent>
          </Tooltip>}
        </h2>}
        {status === "locked" ? <button type="button" className="tree-more" onClick={() => navigate("home")}>输入访问密码以查看项目</button>
          : sessionsError ? <p className="tree-note" role="alert">{sessionsError}</p>
          : !loaded && <p className="tree-note">正在载入会话…</p>}
        {loaded && !groups.length && <p className="tree-note">还没有会话。按 {shortcutText(desktopShortcuts.newSession)} 开始第一个任务。</p>}
        {shown.map((group, index) => {
          const expanded = isOpen(group, index);
          const all = sessionFamilies(group.sessions);
          const limit = more[group.key] ? 40 : SESSIONS_SHOWN;
          const list = all.filter((family, index) => index < limit || family.root.id === view || family.children.some((child) => child.id === view));
          return (
            <div className="tree-project" key={group.key}>
              {!projectKey && <div
                className="tree-project-row"
                data-menu-open={menuFor === `project:${group.key}` || undefined}
                onContextMenu={isElectronDesktop && !background && !group.generated ? (event) => {
                  event.preventDefault();
                  withMenu(`project:${group.key}`, (at) => openProjectMenu({ ...group, key: group.cwd }, { connection, dialogs, navigate, at }))?.({ x: event.clientX, y: event.clientY });
                } : undefined}
              >
                <button
                  type="button"
                  className="tree-project-toggle"
                  aria-expanded={expanded}
                  title={group.cwd}
                  onClick={() => toggle(group, index)}
                >
                  <ChevronRight size={13} aria-hidden />
                  <span>{group.name}</span>
                  {group.generated && <Badge variant="secondary">自动</Badge>}
                  {group.running > 0 && <small className="tree-running" title={`${group.running} 个运行中`}>{group.running}</small>}
                </button>
                {!background && !group.generated && <button
                  type="button"
                  className="tree-project-new"
                  aria-label={`在 ${group.name} 中新建会话`}
                  title={`在 ${group.name} 中新建会话`}
                  onClick={() => sendDesktopCommand({ command: "new-session", cwd: group.cwd })}
                >
                  <SquarePen size={13} />
                </button>}
              </div>}
              {expanded && (
                <div className="tree-sessions">
                  {list.map(({ root, children }) => {
                    const open = !folded[root.id];
                    return [root, ...(open ? children : [])].map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        computerKey={engine.computerForKey(connection.computer.key)?.key ?? connection.computer.key}
                        active={view === session.id}
                        navigate={navigate}
                        menuOpen={menuFor === session.id}
                        openMenu={sessionMenu(session)}
                        child={session !== root}
                        fold={session === root && children.length ? { open, toggle: () => toggleFold(root.id) } : undefined}
                      />
                    ));
                  })}
                  {(more[group.key] || Math.min(all.length, 40) > list.length) && (
                    <button
                      type="button"
                      className="tree-more"
                      onClick={() => setMore((state) => ({ ...state, [group.key]: !state[group.key] }))}
                    >
                      {more[group.key] ? "收起" : `显示其余 ${Math.min(all.length, 40) - list.length} 个`}
                    </button>
                  )}
                  {/* The sidebar stops at 40; the project's page has them all. */}
                  {more[group.key] && all.length > 40 && (
                    <button type="button" className="tree-more" onClick={() => navigate("projects")}>
                      在项目中查看全部 {all.length} 个
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {groups.length > PROJECTS_SHOWN && (allProjects || groups.length > shown.length) && (
          <button type="button" className="tree-more tree-more-projects" onClick={() => setAllProjects((value) => !value)}>
            {allProjects ? "收起" : `显示全部 ${groups.length} 个项目`}
          </button>
        )}
      </section>
    </>
  );
}

function AllProjectTree({ view, openComputerView, navigate, scopeMenu }: {
  view: string; openComputerView: ConsoleShellProps["openComputerView"];
  navigate: (view: string) => void; scopeMenu: ReactNode;
}) {
  return <ProjectOverview>{(sources, projects) => <CrossProjectTree sources={sources} projects={projects}
    view={view} openComputerView={openComputerView} navigate={navigate} scopeMenu={scopeMenu} />}</ProjectOverview>;
}

function CrossProjectTree({ sources, projects, view, openComputerView, navigate, scopeMenu }: {
  sources: ProjectSource[]; projects: CrossComputerProject[]; view: string;
  openComputerView: ConsoleShellProps["openComputerView"]; navigate: (view: string) => void; scopeMenu: ReactNode;
}) {
  const names = useStore(computerNames.store);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readLocal("desktopTree.all", {}));
  const [showAll, setShowAll] = useState(false);
  const [showAllActive, setShowAllActive] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const dialogs = useDialogs();
  const [menuFor, setMenuFor] = useState<string>();
  const sessionMenu = (source: ProjectSource, session: SessionSummary) => isElectronDesktop && source.selected && source.connection
    ? (at: { x: number; y: number }) => {
      const key = `${source.computer.key}:${session.id}`;
      setMenuFor(key);
      void openSessionMenu(session, { connection: source.connection!, dialogs, at, navigate: (id) => openComputerView(source.computer, id) }).finally(() => setMenuFor(undefined));
    } : undefined;
  const byKey = new Map(sources.map((source) => [source.computer.key, source]));
  const active = sources.flatMap((source) => source.state && source.state.status !== "locked"
    ? desktopSessionTree(source.state.projects, Object.values(source.state.sessions)).active.map((session) => ({ source, session })) : [])
    .sort((a, b) => b.session.createdAt - a.session.createdAt || a.source.computer.key.localeCompare(b.source.computer.key) || a.session.id.localeCompare(b.session.id));
  const containsCurrent = (project: CrossComputerProject) => project.members.some((member) =>
    byKey.get(member.computerKey)?.selected && member.project.sessions.some((session) => session.id === view));
  const shown = showAll ? projects : projects.filter((project, index) => index < PROJECTS_SHOWN || containsCurrent(project));
  return <>
    {!!active.length && <section className="tree-section" aria-label="活跃会话">
      <h2 className="tree-heading">活跃会话<span>{active.length}</span></h2>
      {(showAllActive ? active : active.slice(0, ACTIVE_SESSIONS_SHOWN)).map(({ source, session }) => <SessionRow
        key={`${source.computer.key}:${session.id}`} session={session} computerKey={source.computer.key} active={!!source.selected && view === session.id}
        navigate={(id) => openComputerView(source.computer, id)} menuOpen={menuFor === `${source.computer.key}:${session.id}`} openMenu={sessionMenu(source, session)}
        detail={`${computerName(source.computer, names)} · ${baseName(session.worktree?.source ?? session.cwd)} · ${sessionNeedsAttention(session) ? "等你处理" : sessionPreview(session) || "运行中"}`} />)}
      {active.length > ACTIVE_SESSIONS_SHOWN && <button type="button" className="tree-more" onClick={() => setShowAllActive((value) => !value)}>
        {showAllActive ? "收起" : `显示其余 ${active.length - ACTIVE_SESSIONS_SHOWN} 个活跃会话`}
      </button>}
    </section>}
    <section className="tree-section" aria-label="所有电脑的项目">
      <h2 className="tree-heading tree-projects-heading">
        <button type="button" className="tree-heading-link" title="打开项目列表" onClick={() => navigate("projects")}>项目</button>
        {scopeMenu}
      </h2>
      {shown.map((project, index) => {
        const open = expanded[project.key] ?? (index === 0 || containsCurrent(project));
        return <div key={project.key} className="tree-project">
          <button type="button" className="tree-project-toggle" aria-expanded={open} onClick={() => {
            const next = { ...expanded, [project.key]: !open };
            setExpanded(next);
            try { saveLocal("desktopTree.all", next); } catch { /* The tree still works without storage. */ }
          }}>
            <ChevronRight size={13} aria-hidden /><span>{project.name}</span>
            {project.generated && <Badge variant="secondary">自动</Badge>}
          </button>
          {open && project.members.map((member) => {
            const source = byKey.get(member.computerKey)!;
            return <div key={`${member.computerKey}:${member.project.key}`} className="tree-project-member">
              <div className="tree-project-row" onContextMenu={isElectronDesktop && source.selected && source.connection && !member.project.generated ? (event) => {
                event.preventDefault();
                void openProjectMenu({ ...member.project, key: member.project.cwd }, { connection: source.connection!, dialogs, at: { x: event.clientX, y: event.clientY }, navigate: (id) => openComputerView(source.computer, id) });
              } : undefined}>
              <button type="button" className="tree-project-computer" title={`${computerName(source.computer, names)} · ${member.project.cwd}`}
                onClick={() => openComputerView(source.computer, "projects")}>
                <span className="desktop-presence" data-online={source.state?.status === "online" || undefined} />
                <span>{computerName(source.computer, names)}</span>
                {source.selected && <Badge variant="secondary">当前</Badge>}
              </button>
              {source.selected && !member.project.generated && <button type="button" className="tree-project-new" aria-label={`在 ${project.name} 中新建会话`}
                onClick={() => sendDesktopCommand({ command: "new-session", cwd: member.project.cwd })}><SquarePen size={13} /></button>}
              </div>
              <p className="tree-project-path" title={member.project.cwd}>{member.project.cwd}</p>
              {source.connection && <SessionTree connection={source.connection} projectKey={member.project.key}
                view={source.selected ? view : ""} navigate={(id) => openComputerView(source.computer, id)} background={!source.selected} hideHeading />}
            </div>;
          })}
        </div>;
      })}
      {projects.length > PROJECTS_SHOWN && (showAll || projects.length > shown.length) && <button type="button" className="tree-more" onClick={() => setShowAll((value) => !value)}>
        {showAll ? "收起" : `显示全部 ${projects.length} 个项目`}
      </button>}
      {sources.filter((source) => !source.state?.sessionsLoaded || source.state.status === "locked" || source.state.sessionsError).map((source) =>
        <button key={source.computer.key} type="button" className="tree-more tree-project-status" onClick={() => openComputerView(source.computer, "home")}>{computerName(source.computer, names)} · {source.error ?? (source.state?.status === "locked" ? "输入访问密码" : source.state?.sessionsError ?? (!source.computer.machine.online ? "电脑离线" : "正在读取项目…"))}</button>)}
      {!projects.length && sources.length > 0 && sources.every((source) => source.state?.sessionsLoaded && source.state.status !== "locked" && !source.state.sessionsError) &&
        <p className="tree-note">还没有项目。</p>}
      {!sources.length && <p className="tree-note">连接电脑后可查看项目。</p>}
    </section>
  </>;
}

function ProjectScopeMenu({ value }: { value: "current" | "all" }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="xs" className="tree-scope-menu" aria-label={`项目范围：${value === "all" ? "所有电脑" : "当前电脑"}`}>
        <span>{value === "all" ? "所有电脑" : "当前电脑"}</span><ChevronDown data-icon="inline-end" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={4}>
      <DropdownMenuLabel>项目范围</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(value) => {
        const next = value === "all" ? "all" : "current";
        setProjectScope(next);
      }}>
        <DropdownMenuRadioItem value="current">当前电脑</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="all">所有电脑</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function DesktopNavigation({
  view,
  navigate,
  connect,
  selectComputer,
  openComputerView,
  appearance,
  setAppearance,
  openPalette,
}: Omit<ConsoleShellProps, "children"> & {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  openPalette: () => void;
}) {
  const state = useStore(engine.state);
  const t = useT();
  const localePreference = useLocalePreference();
  const scope = useStore(projectScope, (state) => state.value);
  const multipleComputers = state.computers.length > 1;
  const showAllProjects = scope === "all";
  const scopeMenu = multipleComputers || showAllProjects ? <ProjectScopeMenu value={scope} /> : undefined;
  const { setOpenMobile } = useSidebar();
  const go = (id: string) => { navigate(id); setOpenMobile(false); };
  // Management takes the sidebar for its own pages, as Codex's settings do.
  const managing = isElectronDesktop && isManageView(view);
  const activeView = screenComputerKey(view)
    ? "screen"
    : view === "archive" ? "home"
    : navigationItems.some((item) => item.id === view) ? view : "";
  const place = (item: NavigationItem) => (
    <button
      type="button"
      key={item.id}
      className="desktop-place"
      data-active={activeView === item.id || undefined}
      aria-current={activeView === item.id ? "page" : undefined}
      onClick={() => go(item.id)}
    >
      <item.icon size={16} aria-hidden />
      <span>{t(item.titleKey)}</span>
      {item.id === "home" && state.connection && <SessionCountBadge connection={state.connection} />}
    </button>
  );
  return (
    <Sidebar className="desktop-sidebar" collapsible="none">
      {isElectronDesktop && (
        // The window's title row: the traffic lights sit at its left, it drags the window.
        <div className="desktop-titlebar desktop-sidebar-titlebar">
          {/* Ours, in the title row beside the traffic lights: the app's mark and name. */}
          <span className="desktop-brand" aria-hidden><img src={appIcon} alt="" draggable={false} /><span>LinkShell</span></span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="隐藏侧栏" onClick={() => sendDesktopCommand({ command: "toggle-sidebar" })}>
                <PanelLeft size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>隐藏侧栏 · {shortcutText(desktopShortcuts.toggleSidebar)}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="搜索与命令" onClick={openPalette}>
                <Search size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>搜索与命令 · {shortcutText(desktopShortcuts.palette)}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <SidebarHeader className="desktop-sidebar-header" hidden={managing}>
        <ComputerPicker connect={connect} selectComputer={selectComputer} navigate={go} />
        <div className="desktop-sidebar-actions">
          <button type="button" className="desktop-new-session" disabled={!state.connection} onClick={() => sendDesktopCommand({ command: "new-session" })}>
            <SquarePen size={16} aria-hidden />
            <span>{t("session.new")}</span>
            <kbd>{shortcutText(desktopShortcuts.newSession)}</kbd>
          </button>
          {!isElectronDesktop && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="desktop-search" aria-label="搜索与命令" onClick={openPalette}>
                  <Search size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent>搜索与命令 · {shortcutText(desktopShortcuts.palette)}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </SidebarHeader>
      {managing ? (
        <SidebarContent className="desktop-navigation">
          <ManagementNav page={managePage(view)} navigate={(page) => go(manageView(page))} back={() => sendDesktopCommand({ command: "workspace" })} />
        </SidebarContent>
      ) : (<>
      <SidebarContent className="desktop-navigation">
        <nav className="desktop-places" aria-label="工作台">
          {navigationItems.map(place)}
        </nav>
        {showAllProjects ? <AllProjectTree view={view} navigate={go} scopeMenu={scopeMenu}
          openComputerView={(target, id) => { openComputerView(target, id); setOpenMobile(false); }} />
          : state.connection ? <SessionTree key={state.connection.computer.key} connection={state.connection} view={view} navigate={go} scopeMenu={scopeMenu} />
          : <h2 className="tree-heading"><span>项目</span>{scopeMenu}</h2>}
      </SidebarContent>
      {isElectronDesktop && <ManageEntry active={false} open={() => go(manageView())} />}
      </>)}
      <SidebarFooter className="desktop-sidebar-footer">
        <Button variant="ghost" className="desktop-account" onClick={connect} aria-label="连接设置与账号">
          <CircleUserRound size={16} /><span>{state.account ?? "登录"}</span>
        </Button>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="外观与帮助">
                  {appearance === "dark" ? <Moon size={16} /> : appearance === "light" ? <Sun size={16} /> : <SunMoon size={16} />}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>外观与帮助</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="desktop-appearance-menu" side="top" align="end" sideOffset={8}>
            <DropdownMenuLabel>外观</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={appearance} onValueChange={(value) => setAppearance(value as Appearance)}>
              <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">浅色</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">深色</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("locale.label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={localePreference}
              onValueChange={(value) => {
                if (isLocalePreference(value)) setWebLocalePreference(value);
              }}
            >
              <DropdownMenuRadioItem value="system">{t("locale.system")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="zh">{LOCALE_LABELS.zh}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en">{LOCALE_LABELS.en}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="ja">{LOCALE_LABELS.ja}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openPalette}><Keyboard />命令与快捷键</DropdownMenuItem>
            <DropdownMenuItem asChild><a href="https://liutianjie.github.io/LinkShell/docs/" target="_blank" rel="noreferrer"><BookOpen />使用指南</a></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/** This Mac's own service: below the working set, since it is rarely the job. */
function ManageEntry({ active, open }: { active: boolean; open: () => void }) {
  const update = useStore(management, newVersion);
  const problem = useStore(management, (state) => !!state.problem);
  return (
    <nav className="desktop-places desktop-manage-entry" aria-label="本机">
      <button type="button" className="desktop-place" data-active={active || undefined} aria-current={active ? "page" : undefined} onClick={open}>
        <Settings2 size={16} aria-hidden />
        <span>本机管理</span>
        {(update || problem) && <span className="desktop-manage-dot" data-tone={problem ? "warning" : undefined} aria-label={problem ? "本机服务需要处理" : "有新版本"} />}
        <kbd>⌘2</kbd>
      </button>
    </nav>
  );
}

/** The window's foot: which computer this is, how it is reached, and what is moving on it. */
function DesktopStatusBar({ openPalette, navigate }: { openPalette: () => void; navigate: (view: string) => void }) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const connection = state.connection;
  return (
    <footer className="desktop-status-bar">
      {connection ? <ConnectionFacts connection={connection} name={computerName(connection.computer, names)} navigate={navigate} /> : (
        <span className="desktop-status-item"><span className="desktop-presence" />未连接电脑</span>
      )}
      <button type="button" className="desktop-status-item desktop-status-action" onClick={openPalette}>
        <kbd>{shortcutText(desktopShortcuts.palette)}</kbd>搜索与命令
      </button>
    </footer>
  );
}

function ConnectionFacts({ connection, name, navigate }: { connection: Connection; name: string; navigate: (view: string) => void }) {
  const locale = useLocale();
  const status = useStore(connection.store, (state) => state.status);
  const detail = useStore(connection.store, (state) => state.statusDetail);
  const machine = useStore(connection.store, (state) => state.machine);
  const sessions = useStore(connection.store, (state) => state.sessions);
  const live = Object.values(sessions).filter((session) => !session.archived);
  const waiting = live.filter(sessionNeedsAttention).length;
  const running = live.filter((session) => sessionGroup(session) === "running").length;
  let route = "本机 Host";
  if (connection.computer.key !== DESKTOP_LOCAL) {
    try { route = `经 ${new URL(connection.computer.gateway).host}`; } catch { route = "经网关"; }
  }
  return (
    <>
      <span className="desktop-status-item" title={detail}>
        <span className="desktop-presence" data-online={status === "online" || undefined} />
        <strong>{name}</strong>
        <span>{status === "online" ? route : detail ?? connectionLabel(status, locale)}</span>
      </span>
      {machine?.hostVersion && <span className="desktop-status-item desktop-status-meta">Host {machine.hostVersion}</span>}
      {machine && (machine.protocol ?? 0) < HOST_PROTOCOL && (
        <span className="desktop-status-item" data-tone="waiting" title="电脑上的 LinkShell 比这个界面旧，部分新功能暂时用不了：请更新电脑上的 LinkShell">Host 较旧</span>
      )}
      <span className="desktop-status-spacer" />
      {waiting > 0 && (
        <button type="button" className="desktop-status-item desktop-status-action" data-tone="waiting" onClick={() => navigate("home")}>
          {waiting} 项等你处理
        </button>
      )}
      {running > 0 && <span className="desktop-status-item" data-tone="running">{running} 个运行中</span>}
    </>
  );
}

export function DesktopShell({ children, ...props }: ConsoleShellProps) {
  const [appearance, setAppearance] = useDesktopAppearance();
  useApplyDesktopAppearance(appearance);
  useWindowSurface();
  const [palette, setPalette] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => readLocal("desktopSidebarHidden", false));
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = readLocal("desktopSidebarWidth", 264);
    return Number.isFinite(saved) ? Math.max(240, Math.min(420, saved)) : 264;
  });
  const resizeSidebar = (width: number) => {
    setSidebarWidth(width);
    try { saveLocal("desktopSidebarWidth", width); } catch { /* The layout still works without storage. */ }
  };
  // With the sidebar hidden, the pointer at the window's left edge brings it out over the page
  // (Codex's peek); leaving it puts it away again.
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!isElectronDesktop || !sidebarHidden) { setPeek(false); return; }
    let leave: ReturnType<typeof setTimeout> | undefined;
    const move = (event: PointerEvent) => {
      if (keysBelongToContent()) return;
      const inside = (event.target as Element | null)?.closest?.(".desktop-sidebar-slot");
      if (event.clientX <= 6 && event.clientY > 46) { clearTimeout(leave); setPeek(true); }
      else if (inside) clearTimeout(leave);
      else { clearTimeout(leave); leave = setTimeout(() => setPeek(false), 180); }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); clearTimeout(leave); };
  }, [sidebarHidden]);
  const screenKey = screenComputerKey(props.view);
  const toggleSidebar = () => setSidebarHidden((hidden) => {
    try { saveLocal("desktopSidebarHidden", !hidden); } catch { /* A preference, not state. */ }
    return !hidden;
  });
  const managing = isManageView(props.view);
  // Where ⌘1 returns to: the workspace view that was up before management opened.
  const lastWorkspace = useRef(managing ? "home" : props.view);
  if (!managing) lastWorkspace.current = props.view;
  const openManagement = (page?: ManagePage) => props.navigate(manageView(page));
  const openWorkspace = () => { if (managing) props.navigate(lastWorkspace.current); };
  useEffect(() => { if (isElectronDesktop) startManagement(); }, []);
  // The window tracks which of its two views is up (the tray and menu bar say so).
  useEffect(() => { if (isElectronDesktop && !managing) reportDesktopWorkspace(); }, [managing]);
  useDesktopCommand((command) => {
    if (command.command === "palette") setPalette(true);
    else if (command.command === "toggle-sidebar") toggleSidebar();
    else if (command.command === "manage" && isElectronDesktop) openManagement(command.page);
    else if (command.command === "workspace" && isElectronDesktop) openWorkspace();
    else if (command.command === "new-session" && !opensNewSessions()) {
      deferNewSession(command.cwd);
      props.navigate(managing ? lastWorkspace.current : "home");
    }
  });
  useEffect(() => {
    const step = (direction: 1 | -1) => {
      const seen = new Set<string>();
      const rows = [...document.querySelectorAll<HTMLButtonElement>(".desktop-sidebar .tree-session[data-session-id]")].filter((row) => {
        const key = JSON.stringify([row.dataset.computerKey, row.dataset.sessionId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!rows.length) return;
      const at = rows.findIndex((row) => row.dataset.active === "true");
      // The row owns its computer route and unsaved-change guard, as it does on a click.
      rows[at < 0 ? 0 : (at + direction + rows.length) % rows.length]!.click();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keysBelongToContent()) return;
      const act = (action: () => void) => { event.preventDefault(); action(); };
      if (matchesShortcut(event, desktopShortcuts.palette)) act(() => setPalette((open) => !open));
      else if (matchesShortcut(event, desktopShortcuts.newSession)) act(() => sendDesktopCommand({ command: "new-session" }));
      else if (matchesShortcut(event, desktopShortcuts.toggleSidebar)) act(toggleSidebar);
      else if (matchesShortcut(event, desktopShortcuts.previousSession)) act(() => step(-1));
      else if (matchesShortcut(event, desktopShortcuts.nextSession)) act(() => step(1));
      else if (matchesShortcut(event, desktopShortcuts.back)) act(() => history.back());
      else if (matchesShortcut(event, desktopShortcuts.forward)) act(() => history.forward());
      // The Mac's menu holds ⌘1/⌘2 too; these keep them working wherever the menu does not see the
      // key first, and are the only route on Windows, which has no menu. Both end in the same command.
      else if (isElectronDesktop && matchesShortcut(event, desktopModeShortcuts.workspace)) act(() => sendDesktopCommand({ command: "workspace" }));
      else if (isElectronDesktop && matchesShortcut(event, desktopModeShortcuts.manage)) act(() => sendDesktopCommand({ command: "manage" }));
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [props]);
  useEffect(() => {
    let last = false;
    let frame = 0;
    const isolated = new Map<HTMLElement, boolean>();
    const restore = () => {
      for (const [node, inert] of isolated) node.inert = inert;
      isolated.clear();
    };
    const update = () => {
      frame = 0;
      const focusedRoot = document.fullscreenElement || document.querySelector(".screen-page.screen-focused, .port-preview-focused, .remote-screen-fullscreen");
      const desktopRoot = focusedRoot?.closest(".desktop-root");
      const siblings = new Set<HTMLElement>();
      let node = focusedRoot;
      // Isolate only the workspace path; body portals stay available to focused controls.
      while (desktopRoot && node && node !== desktopRoot && node.parentElement) {
        for (const sibling of node.parentElement.children) {
          if (sibling !== node && sibling instanceof HTMLElement) siblings.add(sibling);
        }
        node = node.parentElement;
      }
      for (const [element, inert] of isolated) {
        if (siblings.has(element)) continue;
        element.inert = inert;
        isolated.delete(element);
      }
      for (const element of siblings) {
        if (!isolated.has(element)) isolated.set(element, element.inert);
        element.inert = true;
      }
      const focused = !!focusedRoot;
      if (focused === last) return;
      last = focused;
      setDesktopContentFocus(focused);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    document.addEventListener("fullscreenchange", schedule);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", schedule);
      cancelAnimationFrame(frame);
      restore();
      setDesktopContentFocus(false);
    };
  }, []);
  return (
    <div className="desktop-root" data-sidebar={sidebarHidden ? "hidden" : undefined} data-peek={peek || undefined} data-shell={isElectronDesktop ? "electron" : undefined} data-platform={isWindowsDesktop ? "windows" : undefined}>
      <SidebarProvider keyboardShortcut={false} className="desktop-body" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        {isElectronDesktop ? (
          // Kept mounted, so hiding it is a slide rather than a jump; inert while hidden.
          <div className="desktop-sidebar-slot" inert={(sidebarHidden && !peek) || undefined}>
            <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
          </div>
        ) : !sidebarHidden && (
          <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
        )}
        {!sidebarHidden && (
          <ColumnResizer
            className="desktop-sidebar-resizer"
            label="调整导航侧栏宽度"
            width={sidebarWidth}
            clamp={(width) => Math.round(Math.max(240, Math.min(420, window.innerWidth - 480, width)))}
            side="end"
            target=".desktop-body"
            variable="--sidebar-width"
            resize={resizeSidebar}
            initial={264}
            collapse={{ threshold: 160, onCollapse: () => {
              setSidebarHidden(true);
              try { saveLocal("desktopSidebarHidden", true); } catch { /* The sidebar still closes without storage. */ }
            } }}
          />
        )}
        <main className="main desktop-main" id="workspace-content" tabIndex={-1} data-screen={screenKey ? "detail" : undefined}>
          {children}
        </main>
        {/* After the main view on purpose: Electron applies drag regions in document order, so a
            title row's drag area that comes later would cover this button and swallow its click. */}
        {isElectronDesktop && sidebarHidden && (
          <div className="desktop-floating-titlebar">
            <button type="button" className="desktop-titlebar-button" aria-label="显示侧栏" title="显示侧栏" onClick={toggleSidebar}>
              <PanelLeft size={16} />
            </button>
          </div>
        )}
      </SidebarProvider>
      <DesktopStatusBar openPalette={() => setPalette(true)} navigate={props.navigate} />
      <CommandCenter
        open={palette}
        onOpenChange={setPalette}
        navigate={props.navigate}
        connect={props.connect}
        selectComputer={props.selectComputer as (computer: Computer) => void}
        setAppearance={setAppearance}
      />
    </div>
  );
}
