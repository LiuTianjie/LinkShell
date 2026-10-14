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
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
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
    <Sidebar className="console-sidebar top-[56px] bottom-0 h-auto">
      <SidebarHeader className="console-navigation-header px-3 py-3 [@media(max-height:800px)]:py-2">
        <Button
          variant="ghost"
          className="workspace-picker h-auto w-full justify-start gap-3 p-3 [@media(max-height:800px)]:min-h-[56px] [@media(max-height:800px)]:p-2"
          onClick={connect}
        >
          <span className="workspace-letter">L</span>
          <span>
            <strong>
              {state.source === "official" ? "我的工作空间" : "配对工作空间"}
            </strong>
            <small>
              {state.account ??
                (state.gateway
                  ? state.gateway.replace(/^wss?:\/\//, "")
                  : "连接你的电脑")}
            </small>
          </span>
          <Icon name="down" />
        </Button>
      </SidebarHeader>
      <SidebarContent className="console-navigation-content gap-[22px] px-3 [@media(max-height:800px)]:gap-5">
        {groups.map((group) => (
          <SidebarGroup className="gap-2 p-0" key={group.title}>
            <SidebarGroupLabel className="h-[24px] px-3">
              {group.title}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-1">
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
      <SidebarFooter className="console-navigation-footer gap-2 px-4 py-3 [@media(max-height:800px)]:py-2">
        <Separator />
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
      <header className="console-header">
        <a
          className="console-brand"
          href="#view=home"
          onClick={(event) => {
            event.preventDefault();
            navigate("home");
          }}
        >
          <img src={appMark} alt="" />
          <strong>LinkShell</strong>
        </a>
        <div className="console-header-actions">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="切换外观"
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              >
                {theme === "light" ? <Moon /> : <Sun />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>切换明暗外观</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon" aria-label="打开使用文档" asChild>
            <a
              href="https://liutianjie.github.io/LinkShell/docs/"
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp />
            </a>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Button variant="outline" onClick={connect}>
            连接设置
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="账号与配对设置"
            onClick={connect}
          >
            <span className="console-avatar">
              {state.account?.slice(0, 1).toUpperCase() ?? "L"}
            </span>
          </Button>
        </div>
      </header>
      <SidebarProvider
        className="console-body min-h-0"
        style={{ "--sidebar-width": "264px" } as CSSProperties}
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
              <span>工作空间</span>
              <ChevronRight size={13} />
              <strong>{title}</strong>
            </div>
            <div className="console-current-computer">
              <Monitor size={14} />
              <span>
                {state.connection
                  ? computerName(state.connection.computer, names)
                  : "未选择电脑"}
              </span>
              {state.connection && (
                <Badge variant="outline">
                  {currentComputer?.machine.online ? "在线" : "离线"}
                </Badge>
              )}
            </div>
          </div>
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}
