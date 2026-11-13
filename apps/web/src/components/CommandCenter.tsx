import { useMemo, useState } from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import { LOCALE_LABELS, groupProjects, type I18nKey } from "@linkshell/client-core";
import {
  Archive,
  Cpu,
  Layers3,
  GitBranch,
  Globe,
  Keyboard,
  Languages,
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
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  SunMoon,
  Terminal,
  File,
  TextCursorInput,
} from "lucide-react";
import { engine, type Computer, type Connection } from "../live/engine";
import { AgentMark, baseName, titleOf } from "../live/common";
import { computerName, computerNames } from "../live/computer-names";
import { isDesktop, isElectronDesktop, isWindowsDesktop, openDesktopManagement } from "../live/desktop";
import {
  desktopModeShortcuts,
  desktopShortcuts,
  sendDesktopCommand,
  shiftTabShortcut,
  shortcutText,
  type DesktopShortcut,
} from "../live/desktop-commands";
import { ProjectOverview, type ProjectSource } from "../live/project-overview";
import type { CrossComputerProject } from "../live/cross-computer-projects";
import { sessionNeedsAttention, waitingLabel } from "../live/session-list";
import { sessionTime } from "../live/session-time";
import { setWebLocalePreference, useT } from "../live/i18n";
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

const places: { id: string; titleKey: I18nKey; icon: typeof MessageSquare }[] = [
  { id: "home", titleKey: "nav.sessions", icon: MessageSquare },
  { id: "projects", titleKey: "nav.projects", icon: Layers3 },
  { id: "screen", titleKey: "nav.screen", icon: Monitor },
  { id: "terminals", titleKey: "nav.terminals", icon: Terminal },
  { id: "files", titleKey: "nav.files", icon: File },
  { id: "ports", titleKey: "nav.ports", icon: Globe },
  { id: "worktrees", titleKey: "nav.worktrees", icon: GitBranch },
  { id: "computers", titleKey: "nav.computers", icon: Laptop },
  { id: "archive", titleKey: "nav.archived", icon: Archive },
];

function stateWord(session: SessionSummary): string {
  if (sessionNeedsAttention(session)) return waitingLabel(session);
  if (session.state === "running") return "运行中";
  if (session.state === "error") return "出错";
  return sessionTime(session.updatedAt);
}

export interface CommandSessionEntry {
  key: string;
  computer: Computer;
  computerLabel: string;
  selected: boolean;
  session: SessionSummary;
  project: string;
  searchValue: string;
}

export function buildCommandSessionEntries(
  sources: readonly ProjectSource[],
  fallback: Connection | undefined,
  names: Record<string, string>,
): CommandSessionEntry[] {
  const collected: CommandSessionEntry[] = [];
  const seen = new Set<string>();
  const addFrom = (computer: Computer, sessions: Record<string, SessionSummary>, selected: boolean) => {
    const computerLabel = computerName(computer, names);
    for (const session of Object.values(sessions)) {
      if (session.archived) continue;
      const entryKey = `${computer.key}:${session.id}`;
      if (seen.has(entryKey)) continue;
      seen.add(entryKey);
      const project = baseName(session.worktree?.source ?? session.cwd);
      const preview = session.preview ? session.preview.replace(/\s+/g, " ").trim() : "";
      const searchValue = [
        titleOf(session),
        project,
        session.cwd,
        preview,
        computerLabel,
        session.agent,
        session.id,
      ]
        .filter(Boolean)
        .join(" ");
      collected.push({
        key: entryKey,
        computer,
        computerLabel,
        selected,
        session,
        project,
        searchValue,
      });
    }
  };
  for (const source of sources) {
    if (!source.state || source.state.status === "locked") continue;
    addFrom(source.computer, source.state.sessions, !!source.selected);
  }
  if (fallback) {
    const fallbackState = fallback.store.getState();
    if (fallbackState.status !== "locked") {
      const canonical = engine.computerForKey(fallback.computer.key) ?? fallback.computer;
      addFrom(canonical, fallbackState.sessions, true);
    }
  }
  return collected
    .sort(
      (a, b) =>
        Number(sessionNeedsAttention(b.session)) - Number(sessionNeedsAttention(a.session)) ||
        b.session.updatedAt - a.session.updatedAt,
    )
    .slice(0, 100);
}

/** ⌘K: one search over sessions, projects, places and actions, the way an editor's command palette works. */
export function CommandCenter({
  open,
  onOpenChange,
  navigate,
  connect,
  selectComputer,
  openComputerView,
  setAppearance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (view: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
  openComputerView?: (computer: Computer, view: string) => void;
  setAppearance: (appearance: Appearance) => void;
}) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const t = useT();
  const connection = state.connection;
  const [keys, setKeys] = useState(false);
  const run = (action: () => void) => {
    onOpenChange(false);
    // Let the dialog hand focus back before the next surface takes it.
    requestAnimationFrame(action);
  };
  const openOnComputer = (computer: Computer, targetView: string, selected: boolean) => {
    if (selected) navigate(targetView);
    else if (openComputerView) openComputerView(computer, targetView);
    else {
      selectComputer(computer);
      navigate(targetView);
    }
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
          <CommandInput placeholder="搜索会话、目录、摘要、项目、命令或电脑…" />
          <CommandList className="command-center-list">
            <CommandEmpty>没有匹配的会话或命令</CommandEmpty>
            {open && (
              <ProjectOverview>
                {(sources, crossProjects) => (
                  <CrossSessionResults
                    sources={sources}
                    crossProjects={crossProjects}
                    fallback={connection}
                    names={names}
                    multipleComputers={state.computers.length > 1}
                    chooseSession={(entry) =>
                      run(() => openOnComputer(entry.computer, entry.session.id, entry.selected))
                    }
                    newSessionOn={(computer, selected, cwd) =>
                      run(() => {
                        if (!selected) selectComputer(computer);
                        sendDesktopCommand({ command: "new-session", cwd });
                      })
                    }
                    openProjectsOn={(computer, selected) =>
                      run(() => openOnComputer(computer, "projects", selected))
                    }
                  />
                )}
              </ProjectOverview>
            )}
            <CommandGroup heading="操作">
              <CommandItem value="新建会话 new session" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "new-session" }))}>
                <MessageSquarePlus />新建会话<Shortcut shortcut={desktopShortcuts.newSession} />
              </CommandItem>
              <CommandItem value="聚焦输入框 focus composer input" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "composer", target: "focus" }))}>
                <TextCursorInput />聚焦输入框<Shortcut shortcut={desktopShortcuts.focusComposer} />
              </CommandItem>
              <CommandItem value="选择模型 model picker" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "composer", target: "model" }))}>
                <Cpu />选择模型<Shortcut shortcut={desktopShortcuts.modelPicker} />
              </CommandItem>
              <CommandItem value="切换模式与计划 mode plan permission" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "composer", target: "mode" }))}>
                <ShieldCheck />切换模式与计划<Shortcut shortcut={desktopShortcuts.modePicker} />
              </CommandItem>
              <CommandItem value="调整推理强度 effort reasoning" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "composer", target: "effort" }))}>
                <SlidersHorizontal />调整推理强度<Shortcut shortcut={desktopShortcuts.effortPicker} />
              </CommandItem>
              <CommandItem value="打开终端 terminal" disabled={!connection} onSelect={() => run(() => sendDesktopCommand({ command: "inspector", panel: "terminal" }))}>
                <Terminal />在当前会话打开终端<Shortcut shortcut={desktopShortcuts.terminal} />
              </CommandItem>
              <CommandItem value="检查器 inspector 变更 diff" onSelect={() => run(() => sendDesktopCommand({ command: "inspector" }))}>
                <PanelRight />显示或隐藏检查器<Shortcut shortcut={desktopShortcuts.toggleInspector} />
              </CommandItem>
              {isDesktop && (
                <CommandItem value="侧栏 sidebar" onSelect={() => run(() => sendDesktopCommand({ command: "toggle-sidebar" }))}>
                  <PanelLeft />显示或隐藏侧栏<Shortcut shortcut={desktopShortcuts.toggleSidebar} />
                </CommandItem>
              )}
              <CommandItem value="刷新 reload refresh" disabled={!connection} onSelect={() => run(() => { void connection?.store.getState().refresh().catch(engine.report); })}>
                <RefreshCw />刷新会话列表
              </CommandItem>
              <CommandItem value="键盘快捷键 shortcuts keyboard" onSelect={() => { onOpenChange(false); setKeys(true); }}>
                <Keyboard />键盘快捷键
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="前往">
              {places.map((place) => {
                const title = t(place.titleKey);
                return (
                  <CommandItem key={place.id} value={`前往 ${title} ${place.id}`} onSelect={() => run(() => navigate(place.id))}>
                    <place.icon />{title}
                  </CommandItem>
                );
              })}
              {isElectronDesktop && (
                <CommandItem value="设置与本机服务 本机管理 management settings preferences 设置" onSelect={() => run(() => openDesktopManagement())}>
                  <Settings2 />设置与本机服务<CommandShortcut>{shortcutText(desktopShortcuts.settings)}</CommandShortcut>
                </CommandItem>
              )}
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
            <CommandGroup heading={t("locale.label")}>
              <CommandItem value={`language locale system ${t("locale.system")}`} onSelect={() => run(() => setWebLocalePreference("system"))}><Languages />{t("locale.system")}</CommandItem>
              <CommandItem value={`language locale zh chinese ${LOCALE_LABELS.zh}`} onSelect={() => run(() => setWebLocalePreference("zh"))}><Languages />{LOCALE_LABELS.zh}</CommandItem>
              <CommandItem value={`language locale en english ${LOCALE_LABELS.en}`} onSelect={() => run(() => setWebLocalePreference("en"))}><Languages />{LOCALE_LABELS.en}</CommandItem>
              <CommandItem value={`language locale ja japanese ${LOCALE_LABELS.ja}`} onSelect={() => run(() => setWebLocalePreference("ja"))}><Languages />{LOCALE_LABELS.ja}</CommandItem>
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
            <div><dt>{shiftTabShortcut.label}</dt><dd><kbd>{shortcutText(shiftTabShortcut)}</kbd></dd></div>
            {isElectronDesktop && Object.values(desktopModeShortcuts).map((shortcut) => (
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

function CrossSessionResults({
  sources,
  crossProjects,
  fallback,
  names,
  multipleComputers,
  chooseSession,
  newSessionOn,
  openProjectsOn,
}: {
  sources: ProjectSource[];
  crossProjects: CrossComputerProject[];
  fallback: Connection | undefined;
  names: Record<string, string>;
  multipleComputers: boolean;
  chooseSession: (entry: CommandSessionEntry) => void;
  newSessionOn: (computer: Computer, selected: boolean, cwd: string) => void;
  openProjectsOn: (computer: Computer, selected: boolean) => void;
}) {
  const fallbackSessions = useStore(fallback?.store ?? engine.state, (state) =>
    "sessions" in state ? state.sessions : {},
  );
  const fallbackProjects = useStore(fallback?.store ?? engine.state, (state) =>
    "projects" in state ? state.projects : [],
  );
  const entries = useMemo(
    () => buildCommandSessionEntries(sources, fallback, names),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fallbackSessions triggers fresh read when ProjectOverview mounts
    [sources, fallback, names, fallbackSessions],
  );
  const sourceByKey = useMemo(() => new Map(sources.map((source) => [source.computer.key, source])), [sources]);
  const projectRows = useMemo(() => {
    if (crossProjects.length > 0) {
      return crossProjects.flatMap((group) =>
        group.members.flatMap((member) => {
          const source = sourceByKey.get(member.computerKey);
          const computer = source?.computer ?? fallback?.computer;
          return computer
            ? [
                {
                  key: `${computer.key}:${member.project.key}`,
                  computer,
                  computerLabel: computerName(computer, names),
                  selected: !!source?.selected,
                  name: member.project.name,
                  cwd: member.project.cwd,
                  generated: member.project.generated,
                },
              ]
            : [];
        }),
      ).slice(0, 50);
    }
    if (!fallback) return [];
    const canonical = engine.computerForKey(fallback.computer.key) ?? fallback.computer;
    const label = computerName(canonical, names);
    return groupProjects(fallbackProjects, Object.values(fallbackSessions))
      .slice(0, 40)
      .map((project) => ({
        key: `${canonical.key}:${project.key}`,
        computer: canonical,
        computerLabel: label,
        selected: true,
        name: project.name,
        cwd: project.cwd,
        generated: project.generated,
      }));
  }, [crossProjects, sourceByKey, fallback, names, fallbackProjects, fallbackSessions]);

  return (
    <>
      {entries.length > 0 && (
        <CommandGroup heading="会话">
          {entries.map((entry) => {
            const { session } = entry;
            const previewSnippet = session.preview ? session.preview.replace(/\s+/g, " ").trim().slice(0, 48) : "";
            const subtitle = [
              multipleComputers ? entry.computerLabel : "",
              entry.project,
              previewSnippet,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <CommandItem
                key={entry.key}
                value={entry.searchValue}
                onSelect={() => chooseSession(entry)}
              >
                <AgentMark agent={session.agent} />
                <span className="command-session-title">{titleOf(session)}</span>
                <span
                  className="command-session-project"
                  title={session.preview ? `${session.cwd}\n${session.preview}` : session.cwd}
                >
                  {subtitle}
                </span>
                <CommandShortcut data-attention={sessionNeedsAttention(session) || undefined}>
                  {stateWord(session)}
                </CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
      {projectRows.length > 0 && (
        <CommandGroup heading="项目">
          {projectRows.map((project) => (
            <CommandItem
              key={project.key}
              value={`项目 ${project.name} ${project.cwd} ${project.computerLabel}`}
              onSelect={() =>
                project.generated
                  ? openProjectsOn(project.computer, project.selected)
                  : newSessionOn(project.computer, project.selected, project.cwd)
              }
            >
              {project.generated ? <MessageSquare /> : <Layers3 />}
              <span className="command-session-title">{project.name}</span>
              <span className="command-session-project" title={project.cwd}>
                {multipleComputers ? `${project.computerLabel} · ${project.cwd}` : project.cwd}
              </span>
              <CommandShortcut>{project.generated ? "自动创建 · 查看会话" : "新建会话"}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
