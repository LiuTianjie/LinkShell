import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import { HOST_PROTOCOL, type SessionSummary } from "@linkshell/wire";
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
// The app icon without its white tile: beside the traffic lights a tile would glare in dark mode.
import appGlyph from "../assets/mark-glyph.png";
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
import { sessionGroup, sessionNeedsAttention } from "../live/session-list";
import { compactTime } from "../live/session-time";
import { readLocal, saveLocal } from "../live/storage";
import { useApplyDesktopAppearance, useDesktopAppearance, type Appearance } from "../live/desktop-appearance";
import type { ConsoleShellProps } from "./ConsoleShell";
import { CommandCenter } from "./CommandCenter";
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

type NavigationItem = { id: string; title: string; icon: LucideIcon };

// The sidebar is mostly the working set (what waits on you, projects and their sessions), as in
// Codex. Above it, every place on this computer in one flat list: a fold would only add a click.
// Projects open from the tree's own heading; 电脑 and 已归档 from the computer menu, the session
// list or ⌘K.
const navigationItems: NavigationItem[] = [
  { id: "home", title: "会话", icon: MessageSquare },
  { id: "screen", title: "远程桌面", icon: Monitor },
  { id: "terminals", title: "终端", icon: Terminal },
  { id: "files", title: "文件", icon: File },
  { id: "ports", title: "端口预览", icon: Globe },
  { id: "worktrees", title: "Worktree", icon: GitBranch },
];
const PROJECTS_SHOWN = 8;
const SESSIONS_SHOWN = 5;

function connectionLabel(status: string): string {
  return status === "online" ? "已连接" : status === "locked" ? "需要密码" : status === "connecting" ? "连接中" : status === "reconnecting" ? "正在恢复" : "未连接";
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
    (computer) => computer.key === state.connection?.computer.key,
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
      <span><span className="desktop-presence" data-online={status === "online" || undefined} />{status === "online" ? route : detail ?? connectionLabel(status)}</span>
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
  const status = useStore(connection.store, (state) => state.status);
  return (
    <PickerCopy
      name={name}
      online={status === "online"}
      detail={`${computer.key === DESKTOP_LOCAL ? THIS_COMPUTER : "远程电脑"} · ${connectionLabel(status)}`}
    />
  );
}

function SessionCountBadge({ connection }: { connection: Connection }) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const waiting = Object.values(sessions).filter((session) => !session.archived && sessionNeedsAttention(session)).length;
  if (!waiting) return null;
  return <span className="desktop-nav-badge" title={`${waiting} 项需要你`}>{waiting}</span>;
}

function SessionRow({
  session,
  active,
  navigate,
  project,
  menuOpen,
  openMenu,
  child,
  fold,
}: {
  session: SessionSummary;
  active: boolean;
  navigate: (view: string) => void;
  project?: string;
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
      data-active={active || undefined}
      data-menu-open={menuOpen || undefined}
      data-child={child || undefined}
      aria-current={active ? "page" : undefined}
      aria-expanded={fold ? fold.open : undefined}
      title={`${titleOf(session)}${tone === "waiting" ? " · 需要你" : tone === "running" ? " · 进行中" : tone === "error" ? " · 出错" : ""}`}
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
        {project && <small>{project}</small>}
      </span>
      <time dateTime={new Date(session.updatedAt).toISOString()}>{compactTime(session.updatedAt)}</time>
    </button>
  );
}

interface ProjectGroup { key: string; name: string; sessions: SessionSummary[]; latest: number; running: number }
interface Family { root: SessionSummary; children: SessionSummary[]; latest: number }

/**
 * A project's sessions as the Claude app's sidebar nests them: each with the sessions started from
 * it or forked off it, flattened under the oldest ancestor still in the list (an archived parent
 * lets its children stand alone), the family placed by its newest activity.
 */
function families(sessions: SessionSummary[]): Family[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rootOf = (session: SessionSummary) => {
    const seen = new Set([session.id]);
    let current = session;
    for (;;) {
      const up = current.parentId ?? current.forkedFrom;
      const parent = up ? byId.get(up) : undefined;
      if (!parent || seen.has(parent.id)) return current;
      seen.add(parent.id);
      current = parent;
    }
  };
  const byRoot = new Map<string, Family>();
  for (const session of sessions) {
    const root = rootOf(session);
    const family = byRoot.get(root.id) ?? { root, children: [], latest: 0 };
    if (session !== root) family.children.push(session);
    family.latest = Math.max(family.latest, session.updatedAt);
    byRoot.set(root.id, family);
  }
  for (const family of byRoot.values()) family.children.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...byRoot.values()].sort((a, b) => b.latest - a.latest);
}

/** The sidebar's working set: what waits on you, then each project with its recent sessions. */
function SessionTree({ connection, view, navigate }: { connection: Connection; view: string; navigate: (view: string) => void }) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const projects = useStore(connection.store, (state) => state.projects);
  const loaded = useStore(connection.store, (state) => state.sessionsLoaded);
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
  const { waiting, groups } = useMemo(() => {
    const live = Object.values(sessions).filter((session) => !session.archived);
    const byProject = new Map<string, ProjectGroup>();
    for (const session of live) {
      const key = session.worktree?.source ?? session.cwd;
      const group = byProject.get(key) ?? {
        key,
        name: projects.find((project) => project.cwd === key)?.name ?? (baseName(key) || key),
        sessions: [],
        latest: 0,
        running: 0,
      };
      group.sessions.push(session);
      group.latest = Math.max(group.latest, session.updatedAt);
      if (sessionGroup(session) === "running") group.running += 1;
      byProject.set(key, group);
    }
    for (const group of byProject.values()) group.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      waiting: live.filter(sessionNeedsAttention).sort((a, b) => b.updatedAt - a.updatedAt),
      groups: [...byProject.values()].sort((a, b) => b.latest - a.latest),
    };
  }, [sessions, projects]);
  const current = sessions[view];
  const currentProject = current && (current.worktree?.source ?? current.cwd);
  const isOpen = (group: ProjectGroup, index: number) =>
    open[group.key] ?? (group.key === currentProject || index === 0);
  const toggle = (group: ProjectGroup, index: number) => {
    const next = { ...open, [group.key]: !isOpen(group, index) };
    setOpen(next);
    try { saveLocal(storageKey, next); } catch { /* The tree still works without storage. */ }
  };
  const shown = allProjects ? groups : groups.slice(0, PROJECTS_SHOWN);
  const dialogs = useDialogs();
  const [menuFor, setMenuFor] = useState<string>();
  const withMenu = (key: string, open: (at: { x: number; y: number }) => Promise<void>) =>
    isElectronDesktop ? (at: { x: number; y: number }) => { setMenuFor(key); void open(at).finally(() => setMenuFor(undefined)); } : undefined;
  const sessionMenu = (session: SessionSummary) => withMenu(session.id, (at) => openSessionMenu(session, { connection, dialogs, navigate, at }));
  return (
    <>
      {waiting.length > 0 && (
        <section className="tree-section" aria-label="需要你">
          <h2 className="tree-heading" data-tone="waiting">需要你<span>{waiting.length}</span></h2>
          {waiting.slice(0, 6).map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={view === session.id}
              navigate={navigate}
              project={baseName(session.worktree?.source ?? session.cwd)}
              menuOpen={menuFor === session.id}
              openMenu={sessionMenu(session)}
            />
          ))}
        </section>
      )}
      <section className="tree-section" aria-label="项目">
        <h2 className="tree-heading">
          <button type="button" className="tree-heading-link" title="打开项目列表" onClick={() => navigate("projects")}>
            项目
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="tree-heading-action" aria-label="新建会话" onClick={() => sendDesktopCommand({ command: "new-session" })}>
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>新建会话 · {shortcutText(desktopShortcuts.newSession)}</TooltipContent>
          </Tooltip>
        </h2>
        {!loaded && <p className="tree-note">正在载入会话…</p>}
        {loaded && !groups.length && <p className="tree-note">还没有会话。按 {shortcutText(desktopShortcuts.newSession)} 开始第一个任务。</p>}
        {shown.map((group, index) => {
          const expanded = isOpen(group, index);
          const all = families(group.sessions);
          const list = more[group.key] ? all.slice(0, 40) : all.slice(0, SESSIONS_SHOWN);
          return (
            <div className="tree-project" key={group.key}>
              <div
                className="tree-project-row"
                data-menu-open={menuFor === `project:${group.key}` || undefined}
                onContextMenu={isElectronDesktop ? (event) => {
                  event.preventDefault();
                  withMenu(`project:${group.key}`, (at) => openProjectMenu(group, { connection, dialogs, navigate, at }))?.({ x: event.clientX, y: event.clientY });
                } : undefined}
              >
                <button
                  type="button"
                  className="tree-project-toggle"
                  aria-expanded={expanded}
                  title={group.key}
                  onClick={() => toggle(group, index)}
                >
                  <ChevronRight size={13} aria-hidden />
                  <span>{group.name}</span>
                  {group.running > 0 && <small className="tree-running" title={`${group.running} 个进行中`}>{group.running}</small>}
                </button>
                <button
                  type="button"
                  className="tree-project-new"
                  aria-label={`在 ${group.name} 中新建会话`}
                  title={`在 ${group.name} 中新建会话`}
                  onClick={() => sendDesktopCommand({ command: "new-session", cwd: group.key })}
                >
                  <SquarePen size={13} />
                </button>
              </div>
              {expanded && (
                <div className="tree-sessions">
                  {list.map(({ root, children }) => {
                    const open = !folded[root.id];
                    return [root, ...(open ? children : [])].map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={view === session.id}
                        navigate={navigate}
                        menuOpen={menuFor === session.id}
                        openMenu={sessionMenu(session)}
                        child={session !== root}
                        fold={session === root && children.length ? { open, toggle: () => toggleFold(root.id) } : undefined}
                      />
                    ));
                  })}
                  {all.length > SESSIONS_SHOWN && (
                    <button
                      type="button"
                      className="tree-more"
                      onClick={() => setMore((state) => ({ ...state, [group.key]: !state[group.key] }))}
                    >
                      {more[group.key] ? "收起" : `显示其余 ${Math.min(all.length, 40) - SESSIONS_SHOWN} 个`}
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
        {groups.length > PROJECTS_SHOWN && (
          <button type="button" className="tree-more tree-more-projects" onClick={() => setAllProjects((value) => !value)}>
            {allProjects ? "只显示最近的项目" : `显示全部 ${groups.length} 个项目`}
          </button>
        )}
      </section>
    </>
  );
}

function DesktopNavigation({
  view,
  navigate,
  connect,
  selectComputer,
  appearance,
  setAppearance,
  openPalette,
}: Omit<ConsoleShellProps, "children"> & {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  openPalette: () => void;
}) {
  const state = useStore(engine.state);
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
      <item.icon size={16} strokeWidth={1.65} aria-hidden />
      <span>{item.title}</span>
      {item.id === "home" && state.connection && <SessionCountBadge connection={state.connection} />}
    </button>
  );
  return (
    <Sidebar className="desktop-sidebar" collapsible="none">
      {isElectronDesktop && (
        // The window's title row: the traffic lights sit at its left, it drags the window.
        <div className="desktop-titlebar desktop-sidebar-titlebar">
          {/* Ours, in the title row beside the traffic lights: the app's mark and name. */}
          <span className="desktop-brand" aria-hidden><img src={appGlyph} alt="" draggable={false} /><span>LinkShell</span></span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="隐藏侧栏" onClick={() => sendDesktopCommand({ command: "toggle-sidebar" })}>
                <PanelLeft size={16} strokeWidth={1.65} />
              </button>
            </TooltipTrigger>
            <TooltipContent>隐藏侧栏 · {shortcutText(desktopShortcuts.toggleSidebar)}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="搜索与命令" onClick={openPalette}>
                <Search size={16} strokeWidth={1.65} />
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
            <SquarePen size={16} strokeWidth={1.65} aria-hidden />
            <span>新建会话</span>
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
        {state.connection && <SessionTree key={state.connection.computer.key} connection={state.connection} view={view} navigate={go} />}
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
        <Settings2 size={16} strokeWidth={1.65} aria-hidden />
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
        <span>{status === "online" ? route : detail ?? connectionLabel(status)}</span>
      </span>
      {machine?.hostVersion && <span className="desktop-status-item desktop-status-meta">Host {machine.hostVersion}</span>}
      {machine && (machine.protocol ?? 0) < HOST_PROTOCOL && (
        <span className="desktop-status-item" data-tone="waiting" title="电脑上的 LinkShell 比这个界面旧，部分新功能暂时用不了：请更新电脑上的 LinkShell">Host 较旧</span>
      )}
      <span className="desktop-status-spacer" />
      {waiting > 0 && (
        <button type="button" className="desktop-status-item desktop-status-action" data-tone="waiting" onClick={() => navigate("home")}>
          {waiting} 项需要你
        </button>
      )}
      {running > 0 && <span className="desktop-status-item" data-tone="running">{running} 个进行中</span>}
    </>
  );
}

export function DesktopShell({ children, ...props }: ConsoleShellProps) {
  const [appearance, setAppearance] = useDesktopAppearance();
  useApplyDesktopAppearance(appearance);
  useWindowSurface();
  const [palette, setPalette] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => readLocal("desktopSidebarHidden", false));
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
      const rows = [...document.querySelectorAll<HTMLElement>(".desktop-sidebar .tree-session[data-session-id]")];
      const ids = [...new Set(rows.map((row) => row.dataset.sessionId!))];
      if (!ids.length) return;
      const at = ids.indexOf(props.view);
      props.navigate(ids[at < 0 ? 0 : (at + direction + ids.length) % ids.length]);
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
      const focusedRoot = document.fullscreenElement || document.querySelector(".screen-page.screen-focused, .port-preview-focused");
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
      <a className="skip-navigation" href="#workspace-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("workspace-content")?.focus();
      }}>跳到内容</a>
      <SidebarProvider keyboardShortcut={false} className="desktop-body" style={{ "--sidebar-width": "264px" } as CSSProperties}>
        {isElectronDesktop ? (
          // Kept mounted, so hiding it is a slide rather than a jump; inert while hidden.
          <div className="desktop-sidebar-slot" inert={(sidebarHidden && !peek) || undefined}>
            <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
          </div>
        ) : !sidebarHidden && (
          <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
        )}
        <main className="main desktop-main" id="workspace-content" tabIndex={-1} data-screen={screenKey ? "detail" : undefined}>
          {children}
        </main>
        {/* After the main view on purpose: Electron applies drag regions in document order, so a
            title row's drag area that comes later would cover this button and swallow its click. */}
        {isElectronDesktop && sidebarHidden && (
          <div className="desktop-floating-titlebar">
            <button type="button" className="desktop-titlebar-button" aria-label="显示侧栏" title="显示侧栏" onClick={toggleSidebar}>
              <PanelLeft size={16} strokeWidth={1.65} />
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
