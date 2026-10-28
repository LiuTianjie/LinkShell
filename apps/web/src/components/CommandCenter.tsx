import { useMemo, useState } from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import {
  Archive,
  Folder,
  GitBranch,
  Globe,
  Keyboard,
  Laptop,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Settings2,
  Sun,
  SunMoon,
  Terminal,
  File,
} from "lucide-react";
import { engine, type Computer } from "../live/engine";
import { AgentMark, baseName, titleOf } from "../live/common";
import { computerName, computerNames } from "../live/computer-names";
import { isWindowsDesktop, openDesktopManagement } from "../live/desktop";
import { desktopModeShortcuts, desktopShortcuts, sendDesktopCommand, shortcutText, type DesktopShortcut } from "../live/desktop-commands";
import { sessionNeedsAttention } from "../live/session-list";
import { sessionTime } from "../live/session-time";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type Appearance = "system" | "light" | "dark";

const places = [
  { id: "home", title: "会话", icon: MessageSquare },
  { id: "projects", title: "项目", icon: Folder },
  { id: "screen", title: "远程桌面", icon: Monitor },
  { id: "terminals", title: "终端", icon: Terminal },
  { id: "files", title: "文件", icon: File },
  { id: "ports", title: "端口预览", icon: Globe },
  { id: "worktrees", title: "Worktree", icon: GitBranch },
  { id: "computers", title: "电脑与 Agent", icon: Laptop },
  { id: "archive", title: "已归档会话", icon: Archive },
];

function stateWord(session: SessionSummary): string {
  if (sessionNeedsAttention(session)) return "需要你";
  if (session.state === "running") return "进行中";
  if (session.state === "error") return "出错";
  return sessionTime(session.updatedAt);
}

/** ⌘K: one search over sessions, projects, places and actions, the way an editor's command palette works. */
export function CommandCenter({
  open,
  onOpenChange,
  navigate,
  connect,
  selectComputer,
  setAppearance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (view: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
  setAppearance: (appearance: Appearance) => void;
}) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const connection = state.connection;
  const [keys, setKeys] = useState(false);
  const run = (action: () => void) => {
    onOpenChange(false);
    // Let the dialog hand focus back before the next surface takes it.
    requestAnimationFrame(action);
  };
  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="搜索与命令"
        description="搜索会话、项目和命令"
        className="command-center"
      >
        <Command loop>
          <CommandInput placeholder="搜索会话、项目、命令或电脑…" />
          <CommandList className="command-center-list">
            <CommandEmpty>没有匹配的会话或命令</CommandEmpty>
            {connection && <SessionResults key={connection.computer.key} store={connection.store} choose={(id) => run(() => navigate(id))} newSession={(cwd) => run(() => sendDesktopCommand({ command: "new-session", cwd }))} />}
            <CommandGroup heading="操作">
              <CommandItem value="新建会话 new session" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "new-session" }))}>
                <MessageSquarePlus />新建会话<Shortcut shortcut={desktopShortcuts.newSession} />
              </CommandItem>
              <CommandItem value="打开终端 terminal" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "inspector", panel: "terminal" }))}>
                <Terminal />在当前会话打开终端<Shortcut shortcut={desktopShortcuts.terminal} />
              </CommandItem>
              <CommandItem value="检查器 inspector 变更 diff" onSelect={() => run(() => sendDesktopCommand({ command: "inspector" }))}>
                <PanelRight />显示或隐藏检查器<Shortcut shortcut={desktopShortcuts.toggleInspector} />
              </CommandItem>
              <CommandItem value="侧栏 sidebar" onSelect={() => run(() => sendDesktopCommand({ command: "toggle-sidebar" }))}>
                <PanelLeft />显示或隐藏侧栏<Shortcut shortcut={desktopShortcuts.toggleSidebar} />
              </CommandItem>
              <CommandItem value="刷新 reload refresh" disabled={!connection} onSelect={() => run(() => { void connection?.store.getState().refresh().catch(engine.report); })}>
                <RefreshCw />刷新会话列表
              </CommandItem>
              <CommandItem value="键盘快捷键 shortcuts keyboard" onSelect={() => { onOpenChange(false); setKeys(true); }}>
                <Keyboard />键盘快捷键
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="前往">
              {places.map((place) => (
                <CommandItem key={place.id} value={`前往 ${place.title} ${place.id}`} onSelect={() => run(() => navigate(place.id))}>
                  <place.icon />{place.title}
                </CommandItem>
              ))}
              <CommandItem value="本机管理 management settings 设置" onSelect={() => run(openDesktopManagement)}>
                <Settings2 />本机管理<CommandShortcut>{shortcutText(desktopModeShortcuts.manage)}</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="电脑">
              {state.computers.map((computer) => (
                <CommandItem
                  key={computer.key}
                  value={`电脑 ${computerName(computer, names)} ${computer.machine.name}`}
                  onSelect={() => run(() => selectComputer(computer))}
                >
                  <span className="command-presence" data-online={computer.machine.online || undefined} />
                  {computerName(computer, names)}
                  <CommandShortcut>{connection?.computer.key === computer.key ? "当前" : computer.machine.online ? "在线" : "离线"}</CommandShortcut>
                </CommandItem>
              ))}
              <CommandItem value="连接电脑 pair add computer 配对 登录" onSelect={() => run(connect)}>
                <Plus />连接电脑
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="外观">
              <CommandItem value="外观 跟随系统 appearance system" onSelect={() => run(() => setAppearance("system"))}><SunMoon />跟随系统外观</CommandItem>
              <CommandItem value="外观 浅色 light" onSelect={() => run(() => setAppearance("light"))}><Sun />浅色外观</CommandItem>
              <CommandItem value="外观 深色 dark" onSelect={() => run(() => setAppearance("dark"))}><Moon />深色外观</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Dialog open={keys} onOpenChange={setKeys}>
        <DialogContent className="shortcut-sheet">
          <DialogHeader>
            <DialogTitle>键盘快捷键</DialogTitle>
            <DialogDescription>控制远程桌面时，按键会发给那台电脑。</DialogDescription>
          </DialogHeader>
          <dl>
            {Object.values(desktopShortcuts).map((shortcut) => (
              <div key={shortcut.label}><dt>{shortcut.label}</dt><dd><kbd>{shortcutText(shortcut)}</kbd></dd></div>
            ))}
            {Object.values(desktopModeShortcuts).map((shortcut) => (
              <div key={shortcut.label}><dt>{shortcut.label}</dt><dd><kbd>{shortcutText(shortcut)}</kbd></dd></div>
            ))}
            <div><dt>发送消息</dt><dd><kbd>Enter</kbd></dd></div>
            <div><dt>换行</dt><dd><kbd>{isWindowsDesktop ? "Shift+Enter" : "⇧Enter"}</kbd></dd></div>
            <div><dt>Agent 工作时立即发送</dt><dd><kbd>{isWindowsDesktop ? "Ctrl+Enter" : "⌘Enter"}</kbd></dd></div>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Shortcut({ shortcut }: { shortcut: DesktopShortcut }) {
  return <CommandShortcut>{shortcutText(shortcut)}</CommandShortcut>;
}

function SessionResults({
  store,
  choose,
  newSession,
}: {
  store: NonNullable<ReturnType<typeof engine.state.getState>["connection"]>["store"];
  choose: (id: string) => void;
  newSession: (cwd: string) => void;
}) {
  const sessions = useStore(store, (state) => state.sessions);
  const projects = useStore(store, (state) => state.projects);
  const sorted = useMemo(
    () => Object.values(sessions)
      .filter((session) => !session.archived)
      .sort((a, b) => Number(sessionNeedsAttention(b)) - Number(sessionNeedsAttention(a)) || b.updatedAt - a.updatedAt)
      .slice(0, 80),
    [sessions],
  );
  return (
    <>
      <CommandGroup heading="会话">
        {sorted.map((session) => {
          const project = baseName(session.worktree?.source ?? session.cwd);
          return (
            <CommandItem
              key={session.id}
              value={`${titleOf(session)} ${project} ${session.agent} ${session.id}`}
              onSelect={() => choose(session.id)}
            >
              <AgentMark agent={session.agent} />
              <span className="command-session-title">{titleOf(session)}</span>
              <span className="command-session-project">{project}</span>
              <CommandShortcut data-attention={sessionNeedsAttention(session) || undefined}>{stateWord(session)}</CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
      {projects.length > 0 && (
        <CommandGroup heading="项目">
          {projects.slice(0, 40).map((project) => (
            <CommandItem
              key={project.cwd}
              value={`项目 ${project.name} ${project.cwd}`}
              onSelect={() => newSession(project.cwd)}
            >
              <Folder />
              <span className="command-session-title">{project.name}</span>
              <span className="command-session-project">{project.cwd}</span>
              <CommandShortcut>新建会话</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
