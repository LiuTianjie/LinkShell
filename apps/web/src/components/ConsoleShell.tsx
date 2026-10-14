import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { useStore } from "zustand";
import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import appMark from "../../../client/assets/mark.png";
import { engine, type Computer } from "../live/engine";
import {
  computerName,
  computerOption,
  computerNames,
} from "../live/computer-names";
import { readLocal, saveLocal } from "../live/storage";
import { Icon, type IconName } from "../icons";
import { Choice } from "./Choice";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
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
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";

const groups: {
  title: string;
  items: { id: string; title: string; icon: IconName }[];
}[] = [
  {
    title: "工作空间",
    items: [
      { id: "home", title: "会话概览", icon: "grid" },
      { id: "projects", title: "项目", icon: "folder" },
      { id: "computers", title: "电脑", icon: "computer" },
      { id: "archive", title: "已归档", icon: "clock" },
    ],
  },
  {
    title: "远程工具",
    items: [
      { id: "screen", title: "远程桌面", icon: "computer" },
      { id: "terminals", title: "终端", icon: "terminal" },
      { id: "files", title: "文件", icon: "file" },
      { id: "ports", title: "端口预览", icon: "globe" },
      { id: "worktrees", title: "Worktree", icon: "branch" },
    ],
  },
];

function Navigation({
  view,
  navigate,
  connect,
  selectComputer,
}: {
  view: string;
  navigate: (view: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
}) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar className="console-sidebar">
      <SidebarHeader className="console-navigation-header gap-1 px-2 pt-3 pb-1">
        <Button
          variant="ghost"
          className="workspace-picker h-auto w-full justify-start gap-2 p-1.5"
          onClick={connect}
          aria-label="连接设置与账号"
        >
          <img className="workspace-mark" src={appMark} alt="" />
          <span>
            <strong>LinkShell</strong>
            <small>
              {state.account ??
                (state.gateway
                  ? state.gateway.replace(/^wss?:\/\//, "")
                  : state.source === "official"
                    ? "我的工作空间"
                    : "连接你的电脑")}
            </small>
          </span>
          <Icon name="down" />
        </Button>
      </SidebarHeader>
      <SidebarContent className="console-navigation-content gap-4 px-2 pt-2">
        {groups.map((group) => (
          <SidebarGroup className="gap-1 p-0" key={group.title}>
            <SidebarGroupLabel className="h-6 px-2">
              {group.title}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-px">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    size="navigation"
                    isActive={view === item.id}
                    aria-current={view === item.id ? "page" : undefined}
                    onClick={() => {
                      navigate(item.id);
                      setOpenMobile(false);
                    }}
                  >
                    <Icon name={item.icon} />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="console-navigation-footer gap-2 px-2 pt-2 pb-3">
        <div className="console-computer-picker">
          <span>当前电脑</span>
          <Choice
            label="切换电脑"
            value={state.connection?.computer.key ?? ""}
            placeholder="选择电脑"
            options={state.computers.map((computer) => ({
              value: computer.key,
              label: computerOption(computer, names),
            }))}
            onValueChange={(key) => {
              const computer = state.computers.find(
                (entry) => entry.key === key,
              );
              if (computer) {
                selectComputer(computer);
              }
            }}
          />
        </div>
        <Button variant="ghost" className="console-help" asChild>
          <a
            href="https://liutianjie.github.io/LinkShell/docs/"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen data-icon="inline-start" />
            文档与使用指南
            <ChevronRight data-icon="inline-end" />
          </a>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ConsoleShell({
  view,
  navigate,
  connect,
  selectComputer,
  children,
}: {
  view: string;
  navigate: (view: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
  children: ReactNode;
}) {
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const [theme, setTheme] = useState(() =>
    readLocal(
      "theme",
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    ),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveLocal("theme", theme);
  }, [theme]);
  const currentComputer = state.computers.find(
    (computer) => computer.key === state.connection?.computer.key,
  );
  const title =
    groups.flatMap((group) => group.items).find((item) => item.id === view)
      ?.title ?? "会话";
  return (
    <div className="console-root">
      <a
        className="skip-navigation"
        href="#workspace-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("workspace-content")?.focus();
        }}
      >
        跳到内容
      </a>
      <SidebarProvider
        className="console-body min-h-0"
        style={{ "--sidebar-width": "232px" } as CSSProperties}
      >
        <Navigation
          view={view}
          navigate={navigate}
          connect={connect}
          selectComputer={selectComputer}
        />
        <main
          className="main console-main"
          id="workspace-content"
          tabIndex={-1}
        >
          <div className="console-context">
            <div>
              <SidebarTrigger aria-label="切换导航" />
              <strong>{title}</strong>
            </div>
            <div className="console-context-actions">
              <div className="console-current-computer">
                <Monitor size={14} />
                <span>
                  {state.connection
                    ? computerName(state.connection.computer, names)
                    : "未选择电脑"}
                </span>
                {state.connection && (
                  <span
                    className="console-presence"
                    data-online={currentComputer?.machine.online ? "" : undefined}
                    role="img"
                    aria-label={currentComputer?.machine.online ? "在线" : "离线"}
                  />
                )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="切换外观"
                    onClick={() =>
                      setTheme(theme === "light" ? "dark" : "light")
                    }
                  >
                    {theme === "light" ? <Moon /> : <Sun />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>切换明暗外观</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon"
                aria-label="打开使用文档"
                asChild
              >
                <a
                  href="https://liutianjie.github.io/LinkShell/docs/"
                  target="_blank"
                  rel="noreferrer"
                >
                  <CircleHelp />
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={connect}>
                连接设置
              </Button>
            </div>
          </div>
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}
