import { useEffect, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import {
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  CircleUserRound,
  File,
  Folder,
  GitBranch,
  Globe,
  Laptop,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Settings2,
  Sun,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { engine, type Computer, type Connection } from "../live/engine";
import { AgentMark, titleOf } from "../live/common";
import { computerName, computerNames } from "../live/computer-names";
import { DESKTOP_LOCAL, setDesktopAppearance, setDesktopContentFocus } from "../live/desktop";
import { screenComputerKey } from "../live/screen-route";
import { sessionGroup, sessionNeedsAttention } from "../live/session-list";
import { readLocal, saveLocal } from "../live/storage";
import { applyDesktopTheme } from "../theme";
import type { ConsoleShellProps } from "./ConsoleShell";
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
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import "../styles/desktop.css";

type Appearance = "system" | "light" | "dark";
type NavigationItem = { id: string; title: string; icon: LucideIcon };

const workspaceItems: NavigationItem[] = [
  { id: "home", title: "对话", icon: MessageSquare },
  { id: "projects", title: "项目", icon: Folder },
  { id: "screen", title: "远程桌面", icon: Monitor },
  { id: "computers", title: "所有电脑", icon: Laptop },
];
const toolItems: NavigationItem[] = [
  { id: "terminals", title: "终端", icon: Terminal },
  { id: "files", title: "文件", icon: File },
  { id: "ports", title: "端口预览", icon: Globe },
  { id: "worktrees", title: "Worktree", icon: GitBranch },
  { id: "archive", title: "已归档", icon: Archive },
];
const navigationItems = [...workspaceItems, ...toolItems];

function ConnectionStatus({ connection }: { connection: Connection }) {
  const status = useStore(connection.store, (state) => state.status);
  const detail = useStore(connection.store, (state) => state.statusDetail);
  const label = status === "online" ? "已连接" : status === "connecting" ? "连接中" : status === "reconnecting" ? "正在恢复" : "未连接";
  return <span className="desktop-connection-state" title={detail}><span className="desktop-presence" data-online={status === "online" || undefined} />{label}</span>;
}

function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

function useDesktopAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    const native = (window as Window & { __LINKSHELL_DESKTOP_APPEARANCE__?: unknown })
      .__LINKSHELL_DESKTOP_APPEARANCE__;
    if (isAppearance(native)) return native;
    const saved = readLocal<string>("desktopAppearance", "system");
    return isAppearance(saved) ? saved : "system";
  });
  useEffect(() => {
    const receive = (event: Event) => {
      const value = (event as CustomEvent<{ appearance?: unknown }>).detail?.appearance;
      if (isAppearance(value)) setAppearance(value);
    };
    window.addEventListener("linkshell-desktop-appearance", receive);
    return () => window.removeEventListener("linkshell-desktop-appearance", receive);
  }, []);
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      applyDesktopTheme(appearance === "system" ? (system.matches ? "dark" : "light") : appearance);
    };
    update();
    saveLocal("desktopAppearance", appearance);
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [appearance]);
  const chooseAppearance = (value: Appearance) => {
    setAppearance(value);
    // Only an explicit UI choice writes back; native notifications never echo.
    setDesktopAppearance(value);
  };
  return [appearance, chooseAppearance] as const;
}

function ComputerPicker({
  connect,
  selectComputer,
}: Pick<ConsoleShellProps, "connect" | "selectComputer">) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const selected = state.computers.find(
    (computer) => computer.key === state.connection?.computer.key,
  ) ?? state.connection?.computer;
  const { setOpenMobile } = useSidebar();
  const choose = (computer: Computer) => {
    selectComputer(computer);
    setOpenMobile(false);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="desktop-computer-picker" aria-label="切换当前电脑">
          <span className="desktop-computer-copy">
            <strong>{selected ? computerName(selected, names) : "选择你的电脑"}</strong>
            <span>
              {selected ? (
                <>{selected.key === DESKTOP_LOCAL ? "本机" : "远程电脑"}
                  <span aria-hidden="true"> · </span>
                  {state.connection?.computer.key === selected.key
                    ? <ConnectionStatus connection={state.connection} />
                    : <><span className="desktop-presence" data-online={selected.machine.online || undefined} />{selected.machine.online ? "电脑在线" : "电脑离线"}</>}
                </>
              ) : "登录账号或使用配对码"}
            </span>
          </span>
          <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="desktop-computer-menu" side="bottom" align="start" sideOffset={8}>
        <DropdownMenuLabel>切换电脑</DropdownMenuLabel>
        {state.computers.map((computer) => (
          <DropdownMenuItem key={computer.key} onSelect={() => choose(computer)}>
            <span className="desktop-presence" data-online={computer.machine.online || undefined} />
            <span className="desktop-menu-computer-name">{computerName(computer, names)}</span>
            {computer.key === DESKTOP_LOCAL && <small>本机</small>}
            {selected?.key === computer.key && <Check size={14} />}
          </DropdownMenuItem>
        ))}
        {!state.computers.length && <p className="desktop-menu-empty">连接后，在这里切换工作电脑。</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={connect}><Plus />连接另一台电脑</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionCountBadge({ connection }: { connection: Connection }) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const all = Object.values(sessions).filter((session) => !session.archived);
  const waiting = all.filter(sessionNeedsAttention).length;
  const running = all.filter((session) => sessionGroup(session) === "running").length;
  if (waiting > 0) return <span className="desktop-nav-badge" data-tone="waiting" title={`${waiting} 项需要你`}>{waiting}</span>;
  if (running > 0) return <span className="desktop-nav-badge" data-tone="running" title={`${running} 个进行中`}>{running}</span>;
  return null;
}

function ActiveSessionsGroup({
  connection,
  view,
  navigate,
  onSelect,
}: {
  connection: Connection;
  view: string;
  navigate: (view: string) => void;
  onSelect: () => void;
}) {
  const sessions = useStore(connection.store, (state) => state.sessions);
  const active = Object.values(sessions)
    .filter((session) => !session.archived && (sessionNeedsAttention(session) || sessionGroup(session) === "running"))
    .sort((a, b) => Number(sessionNeedsAttention(b)) - Number(sessionNeedsAttention(a)) || b.updatedAt - a.updatedAt)
    .slice(0, 4);
  if (!active.length) return null;
  return (
    <SidebarGroup className="desktop-navigation-group desktop-active-sessions">
      <SidebarGroupLabel>进行中会话</SidebarGroupLabel>
      <SidebarMenu>
        {active.map((session) => {
          const waiting = sessionNeedsAttention(session);
          const selected = view === session.id;
          return (
            <SidebarMenuItem key={session.id}>
              <SidebarMenuButton
                size="navigation"
                isActive={selected}
                aria-current={selected ? "page" : undefined}
                title={`${titleOf(session)} · ${waiting ? "需要你" : "进行中"}`}
                onClick={() => { navigate(session.id); onSelect(); }}
              >
                <AgentMark agent={session.agent} size="sm" />
                <span className="desktop-nav-session-title">{titleOf(session)}</span>
                <span className="desktop-nav-session-dot" data-state={waiting ? "waiting" : "running"} />
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function DesktopNavigation({
  view,
  navigate,
  connect,
  selectComputer,
  appearance,
  setAppearance,
}: Omit<ConsoleShellProps, "children"> & {
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
}) {
  const state = useStore(engine.state);
  const { setOpenMobile } = useSidebar();
  const activeView = screenComputerKey(view)
    ? "screen"
    : navigationItems.some((item) => item.id === view) ? view : "home";
  return (
    <Sidebar className="desktop-sidebar" collapsible="none">
      <SidebarHeader className="desktop-sidebar-header">
        <ComputerPicker connect={connect} selectComputer={selectComputer} />
      </SidebarHeader>
      <SidebarContent className="desktop-navigation">
        <SidebarGroup className="desktop-navigation-group">
          <SidebarGroupLabel>工作空间</SidebarGroupLabel>
          <SidebarMenu>
            {workspaceItems.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  size="navigation"
                  isActive={activeView === item.id && (item.id !== "home" || view === "home")}
                  aria-current={activeView === item.id && (item.id !== "home" || view === "home") ? "page" : undefined}
                  onClick={() => { navigate(item.id); setOpenMobile(false); }}
                >
                  <item.icon strokeWidth={1.65} />
                  <span>{item.title}</span>
                  {item.id === "home" && state.connection && <SessionCountBadge connection={state.connection} />}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {state.connection && (
          <ActiveSessionsGroup
            connection={state.connection}
            view={view}
            navigate={navigate}
            onSelect={() => setOpenMobile(false)}
          />
        )}
        <SidebarGroup className="desktop-navigation-group">
          <SidebarGroupLabel>开发工具</SidebarGroupLabel>
          <SidebarMenu>
            {toolItems.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  size="navigation"
                  isActive={activeView === item.id}
                  aria-current={activeView === item.id ? "page" : undefined}
                  onClick={() => { navigate(item.id); setOpenMobile(false); }}
                >
                  <item.icon strokeWidth={1.65} /><span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="desktop-sidebar-footer">
        <div className="desktop-account-row">
          <Button variant="ghost" className="desktop-account" onClick={connect} aria-label="连接设置与账号">
            <CircleUserRound size={18} strokeWidth={1.5} /><span>{state.account ?? "连接设置"}</span>
          </Button>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="外观与帮助">
                    {appearance === "dark" ? <Moon size={16} /> : appearance === "light" ? <Sun size={16} /> : <Settings2 size={16} />}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>外观与帮助</TooltipContent>
            </Tooltip>
            <DropdownMenuContent className="desktop-appearance-menu" side="top" align="end" sideOffset={8}>
              <DropdownMenuLabel>外观</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={appearance} onValueChange={(value) => setAppearance(value as Appearance)}>
                <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light"><Sun />浅色</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon />深色</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild><a href="https://liutianjie.github.io/LinkShell/docs/" target="_blank" rel="noreferrer"><BookOpen />使用指南</a></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function DesktopShell({ children, ...props }: ConsoleShellProps) {
  const [appearance, setAppearance] = useDesktopAppearance();
  const screenKey = screenComputerKey(props.view);
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
    <div className="desktop-root">
      <a className="skip-navigation" href="#workspace-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("workspace-content")?.focus();
      }}>跳到内容</a>
      <SidebarProvider keyboardShortcut={false} className="desktop-body" style={{ "--sidebar-width": "232px" } as CSSProperties}>
        <DesktopNavigation {...props} appearance={appearance} setAppearance={setAppearance} />
        <main className="main desktop-main" id="workspace-content" tabIndex={-1} data-screen={screenKey ? "detail" : undefined}>
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}
