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
import appMark from "../../../client/assets/mark.png";
import { engine, type Computer, type Connection } from "../live/engine";
import { baseName, titleOf } from "../live/common";
import { computerName, computerNames } from "../live/computer-names";
import {
  DESKTOP_LOCAL,
  isElectronDesktop,
  isWindowsDesktop,
  openDesktopManagement,
  reportDesktopWorkspace,
  setDesktopContentFocus,
} from "../live/desktop";
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
} from "../live/desktop-commands";
import { screenComputerKey } from "../live/screen-route";
import { sessionGroup, sessionNeedsAttention } from "../live/session-list";
import { compactTime } from "../live/session-time";
import { readLocal, saveLocal } from "../live/storage";
import { useApplyDesktopAppearance, useDesktopAppearance, type Appearance } from "../live/desktop-appearance";
import type { ConsoleShellProps } from "./ConsoleShell";
import { CommandCenter } from "./CommandCenter";
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
import "../styles/management.css";

type NavigationItem = { id: string; title: string; icon: LucideIcon };

// The sidebar is mostly the working set (what waits on you, projects and their sessions), as in
// Codex. Above it, the three places people go to; the computer's other tools fold away under
// 工具. Projects open from the tree's own heading; 电脑 and 已归档 from the computer menu, the
// session list or ⌘K.
const navigationItems: NavigationItem[] = [
  { id: "home", title: "会话", icon: MessageSquare },
  { id: "screen", title: "远程桌面", icon: Monitor },
];
// The computer's own tools; a session reaches its terminal and files from its inspector (⌘J).
const toolItems: NavigationItem[] = [
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
                detail={selected ? `${selected.key === DESKTOP_LOCAL ? "这台 Mac" : "远程电脑"} · ${selected.machine.online ? "在线" : "离线"}` : "登录账号或使用配对码"} />}
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
      detail={`${computer.key === DESKTOP_LOCAL ? "这台 Mac" : "远程电脑"} · ${connectionLabel(status)}`}
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
}: {
  session: SessionSummary;
  active: boolean;
  navigate: (view: string) => void;
  project?: string;
}) {
  const tone = sessionTone(session);
  return (
    <button
      type="button"
      className="tree-session"
      data-session-id={session.id}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      title={`${titleOf(session)}${tone === "waiting" ? " · 需要你" : tone === "running" ? " · 进行中" : tone === "error" ? " · 出错" : ""}`}
      onClick={() => navigate(session.id)}
    >
      <span className="tree-state" data-tone={tone} aria-hidden />
      <span className="tree-title">
        <span>{titleOf(session)}</span>
        {project && <small>{project}</small>}
      </span>
      <time dateTime={new Date(session.updatedAt).toISOString()}>{compactTime(session.updatedAt)}</time>
    </button>
  );
}

interface ProjectGroup { key: string; name: string; sessions: SessionSummary[]; latest: number; running: number }

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
          const list = more[group.key] ? group.sessions.slice(0, 40) : group.sessions.slice(0, SESSIONS_SHOWN);
          return (
            <div className="tree-project" key={group.key}>
              <div className="tree-project-row">
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
                  {list.map((session) => (
                    <SessionRow key={session.id} session={session} active={view === session.id} navigate={navigate} />
                  ))}
                  {group.sessions.length > SESSIONS_SHOWN && (
                    <button
                      type="button"
                      className="tree-more"
                      onClick={() => setMore((state) => ({ ...state, [group.key]: !state[group.key] }))}
                    >
                      {more[group.key] ? "收起" : `显示其余 ${Math.min(group.sessions.length, 40) - SESSIONS_SHOWN} 个`}
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
    : [...navigationItems, ...toolItems].some((item) => item.id === view) ? view : "";
  // The tools stay open while one of them is showing, and otherwise as the reader left them.
  const [toolsOpen, setToolsOpen] = useState(() => readLocal("desktopToolsOpen", false));
  const showTools = toolsOpen || toolItems.some((item) => item.id === activeView);
  const toggleTools = () => setToolsOpen((open) => {
    try { saveLocal("desktopToolsOpen", !open); } catch { /* A preference, not state. */ }
    return !open;
  });
  const place = (item: NavigationItem) => (
    <button
      type="button"
      key={item.id}
      className="desktop-place"
      data-active={activeView === item.id || undefined}
      aria-current={activeView === item.id ? "page" : undefined}
      onClick={() => go(item.id)}
    >
      <item.icon size={16} strokeWidth={1.6} aria-hidden />
      <span>{item.title}</span>
      {item.id === "home" && state.connection && <SessionCountBadge connection={state.connection} />}
    </button>
  );
  return (
    <Sidebar className="desktop-sidebar" collapsible="none">
      {isElectronDesktop && (
        // The window's title row: the traffic lights sit at its left, it drags the window.
        <div className="desktop-titlebar desktop-sidebar-titlebar">
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="隐藏侧栏" onClick={() => sendDesktopCommand({ command: "toggle-sidebar" })}>
                <PanelLeft size={16} strokeWidth={1.6} />
              </button>
            </TooltipTrigger>
            <TooltipContent>隐藏侧栏 · {shortcutText(desktopShortcuts.toggleSidebar)}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="desktop-titlebar-button" aria-label="搜索与命令" onClick={openPalette}>
                <Search size={16} strokeWidth={1.6} />
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
            <SquarePen size={16} strokeWidth={1.6} aria-hidden />
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
          {/* A folding group, as the project rows below: the chevron leads, where an icon would be. */}
          <button type="button" className="desktop-place desktop-place-group" aria-expanded={showTools} onClick={toggleTools}>
            <ChevronRight className="desktop-place-chevron" size={13} aria-hidden />
            <span>工具</span>
          </button>
          {showTools && <div className="desktop-places-nested">{toolItems.map(place)}</div>}
        </nav>
        {state.connection && <SessionTree key={state.connection.computer.key} connection={state.connection} view={view} navigate={go} />}
      </SidebarContent>
      {isElectronDesktop && <ManageEntry active={false} open={() => go(manageView())} />}
      </>)}
      <SidebarFooter className="desktop-sidebar-footer">
        <Button variant="ghost" className="desktop-account" onClick={connect} aria-label="连接设置与账号">
          <CircleUserRound size={17} strokeWidth={1.5} /><span>{state.account ?? "登录"}</span>
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
        <Settings2 size={16} strokeWidth={1.6} aria-hidden />
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

/** Windows has no native top bar, so the page draws the same one. */
function WindowsTopBar({ openPalette }: { openPalette: () => void }) {
  return (
    <header className="windows-desktop-header">
      <div className="windows-desktop-brand"><img src={appMark} alt="" /><strong>LinkShell</strong></div>
      <div className="windows-desktop-modes" aria-label="桌面模式">
        <Button variant="secondary" aria-current="page" title="Ctrl+1">工作台</Button>
        <Button variant="ghost" onClick={openDesktopManagement} title="Ctrl+2">本机管理</Button>
      </div>
      <button type="button" className="desktop-top-search" onClick={openPalette}>
        <Search size={14} aria-hidden /><span>搜索会话、项目和命令</span><kbd>{shortcutText(desktopShortcuts.palette)}</kbd>
      </button>
    </header>
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
      else if (isWindowsDesktop && event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "2") act(openDesktopManagement);
      // The Electron menu holds ⌘1/⌘2 too; these keep them working wherever the menu does not
      // see the key first. Both routes end in the same command.
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
    <div className="desktop-root" data-sidebar={sidebarHidden ? "hidden" : undefined} data-peek={peek || undefined} data-shell={isElectronDesktop ? "electron" : undefined}>
      <a className="skip-navigation" href="#workspace-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("workspace-content")?.focus();
      }}>跳到内容</a>
      {isWindowsDesktop && <WindowsTopBar openPalette={() => setPalette(true)} />}
      <SidebarProvider keyboardShortcut={false} className="desktop-body" style={{ "--sidebar-width": "264px" } as CSSProperties}>
        {isElectronDesktop ? (
          // Kept mounted, so hiding it is a slide rather than a jump; inert while hidden.
          <div className="desktop-sidebar-slot" inert={(sidebarHidden && !peek) || undefined}>
            <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
          </div>
        ) : !sidebarHidden && (
          <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} openPalette={() => setPalette(true)} />
        )}
        {isElectronDesktop && sidebarHidden && (
          <div className="desktop-titlebar desktop-floating-titlebar">
            <button type="button" className="desktop-titlebar-button" aria-label="显示侧栏" onClick={toggleSidebar}>
              <PanelLeft size={16} strokeWidth={1.6} />
            </button>
          </div>
        )}
        <main className="main desktop-main" id="workspace-content" tabIndex={-1} data-screen={screenKey ? "detail" : undefined}>
          {children}
        </main>
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
