import { ComposerConfig, ComposerPlace, ContextRing, type ComposerPickerRequest } from "./ComposerControls";
import {
  ComposerBox,
  atFileMention,
  buildComposerContentBlocks,
  isImeComposing,
  type ComposerBoxHandle,
} from "./ComposerBox";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { CSSProperties, ReactNode } from "react";
import { AsyncQuestions } from "./AsyncQuestions";
import { composerHeightRef } from "./composer-height";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { useDialogs } from "@/components/Dialogs";
import { ColumnResizer } from "@/components/ColumnResizer";
import { confirmAndDeleteSession } from "./session-actions";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LoaderCircle,
  PanelRight,
  MessageSquare,
  MessagesSquare,
  Square,
  Plus,
  X,
  Target,
  Plug,
  Blocks,
  SquareTerminal,
  Ellipsis,
  GitBranch,
  GitFork,
  PencilLine,
  Archive,
  ArchiveRestore,
  Trash2,
  Search,
  ListTree,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Code2,
  Globe,
  Monitor,
  Sparkles,
} from "lucide-react";
import { reconnectLabel, reconnectOf, shownQueue, userMessageView } from "@linkshell/client-core";
import type { ContentBlock, SessionSummary, ToolDetail } from "@linkshell/wire";
import type { TimelineItem } from "@linkshell/client-core";
import {
  parseCommand,
  sessionCommands,
  type Command,
} from "../../../client/src/lib/commands";
import { Icon } from "../icons";
import {
  AgentMark,
  Badge,
  ErrorNotice,
  Modal,
  SessionReady,
  baseName,
  titleOf,
  useActions,
  useClient,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { Permission } from "./Permission";
import { AgentInteractions } from "./Acp";
import { StreamingText, TimelineNavigation, timelineItemSearchText } from "./Timeline";
import { Conversation } from "./Conversation";
import { LiveActivity } from "./LiveActivity";
import { FileView, Files } from "./Files";
import { MAX_ATTACHMENT_LABEL } from "./attachments";
import { Changes, Commands, Goal, Settings, Tasks } from "./Panels";
import { SessionPortPreview } from "./Ports";
import { Side } from "./Side";
import { Terminal, Terminals } from "./Terminal";
import { readLocal, saveLocal } from "./storage";
import { finishComposerSend } from "./composer-draft";
import { ComputerPreview } from "./Video";
import { McpAppView, appTabId, type AppTab } from "./McpApp";
import { DESKTOP_LOCAL, isDesktop, isElectronDesktop, isWindowsDesktop } from "./desktop";
import { sessionNeedsAttention, waitingLabel } from "./session-list";
import { desktopShortcuts, keysBelongToContent, matchesShortcut, shortcutText, useDesktopCommand } from "./desktop-commands";
import { useT } from "./i18n";

export { atFileMention };

type Panel =
  | "commands"
  | "settings"
  | "changes"
  | "files"
  | "tasks"
  | "goal"
  | "side"
  | "mcp"
  | "apps"
  | "preview"
  | "terminal"
  | AppPanel
  | null;
/** An MCP App's tab (`appTabId`). */
type AppPanel = `app:${string}`;
const isAppPanel = (panel: Panel): panel is AppPanel => !!panel?.startsWith("app:");
type AppCall = Extract<TimelineItem, { kind: "tool" }> & {
  detail: Extract<ToolDetail, { type: "mcp" }> & { app: NonNullable<Extract<ToolDetail, { type: "mcp" }>["app"]> };
};
const isAppCall = (item: TimelineItem): item is AppCall => item.kind === "tool" && item.detail?.type === "mcp" && !!item.detail.app;
const callDone = (call: AppCall) => call.status === "completed" || call.status === "failed";
/** What the page is told came back: Codex's raw result, or the failure as one. */
function appResult(call: AppCall): unknown {
  if (!callDone(call)) return undefined;
  if (call.status === "failed") return { content: [{ type: "text", text: call.output || "调用失败" }], structuredContent: { error: call.output || "调用失败" }, isError: true };
  return call.rawOutput ?? { content: [] };
}
const appInput = (call: AppCall) =>
  call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? (call.rawInput as Record<string, unknown>) : {};

// The desktop inspector's tools beside a conversation, as Codex keeps them: what changed, the
// files, a terminal and the computer's preview. Tasks join while the session has some running
// or done; settings, goal, side, MCP and apps are opened from elsewhere (the composer's chips,
// the ••• menu) and show as a tab only while open.
const inspectorTabs: { id: Exclude<Panel, null | "commands">; title: string }[] = [
  { id: "changes", title: "变更" },
  { id: "files", title: "文件" },
  { id: "terminal", title: "终端" },
  { id: "preview", title: "预览" },
];
const panelTitles: Record<Exclude<Panel, null | "commands" | AppPanel>, string> = {
  settings: "会话设置",
  changes: "变更",
  files: "文件",
  tasks: "任务",
  goal: "目标",
  side: "旁支对话",
  mcp: "MCP 服务",
  apps: "应用",
  preview: "预览",
  terminal: "终端",
};
export function Session({
  session,
  navigate,
  active = true,
}: {
  session: SessionSummary;
  navigate: (id: string) => void;
  active?: boolean;
}) {
  const t = useT();
  const dialogs = useDialogs();
  const connection = useConnection();
  const { store, link } = connection;
  const actions = useActions();
  const job = useJob();
  const sendJob = useJob();
  const openPathJob = useJob();
  const view = useClient((state) => state.views[session.id]);
  const hasTasks = useClient((state) => Object.keys(state.tasks[session.id] ?? {}).length > 0 || Object.keys(state.workflows[session.id] ?? {}).length > 0);
  const ready = useClient((state) => state.ready[session.id]);
  const online = useClient((state) => state.status === "online");
  const canInteract = online && !!ready;
  const loadingEarlier = useClient((state) => state.loadingEarlier[session.id]);
  const agent = useClient((state) =>
    state.machine?.agents.find((agent) => agent.id === session.agent),
  );
  // (Hosts before the flag had pages for Codex only.)
  const hasApps = agent?.capabilities.mcpApps ?? session.agent === "codex";
  const queueing = useClient((state) => state.queueing[session.id]);
  const notices = useClient((state) => state.notices[session.id]);
  const commands = useMemo(
    () =>
      sessionCommands(session.agent, view?.commands ?? [], view?.config ?? [], !!agent?.capabilities.side),
    [session.agent, view?.commands, view?.config, agent?.capabilities.side],
  );
  const draftKey = `draft.${connection.computer?.key ?? "default"}.${session.id}`;
  const composerRef = useRef<ComposerBoxHandle>(null);
  const [pickerRequest, setPickerRequest] = useState<ComposerPickerRequest>();
  const requestPicker = useCallback((category: "model" | "mode" | "effort") => {
    setPickerRequest((prev) => ({ category, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [sendingFile, setSendingFile] = useState<string>();
  const uploaded = useRef(new WeakMap<File, string>());
  const [panel, commitPanel] = useState<Panel>(null);
  const [previewMode, setPreviewMode] = useState<"port" | "computer">("port");
  const [file, setFile] = useState<string>();
  const [fileLine, setFileLine] = useState<number>();
  const fileDirty = useRef(false);
  const onFileDirtyChange = useCallback((dirty: boolean) => {
    fileDirty.current = dirty;
  }, []);
  const setPanel = useCallback(
    async (next: Panel) => {
      if (
        panel === "files" &&
        next !== "files" &&
        fileDirty.current &&
        !(await dialogs.confirm("文件有未保存的修改，放弃修改并离开文件面板？"))
      )
        return false;
      if (panel === "files" && next !== "files") fileDirty.current = false;
      commitPanel(next);
      return true;
    },
    [dialogs, panel],
  );
  const [terminal, setTerminal] = useState<string>();
  const [terminals, commitTerminals] = useState(false);
  // On the desktop the terminal is an inspector tab beside the conversation, not a dialog over it.
  const setTerminals = (open: boolean) => {
    if (isDesktop) { if (open) void setPanel("terminal"); }
    else commitTerminals(open);
  };
  const [inspectorWidth, commitInspectorWidth] = useState(() => readLocal("desktopInspectorWidth", 440));
  const widthSave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setInspectorWidth = useCallback((width: number) => {
    commitInspectorWidth(width);
    // A drag reports every frame; the preference is written once it settles.
    clearTimeout(widthSave.current);
    widthSave.current = setTimeout(() => {
      try { saveLocal("desktopInspectorWidth", width); } catch { /* A preference, not state. */ }
    }, 400);
  }, []);
  const lastPanel = useRef<Exclude<Panel, null | "commands">>("changes");
  useEffect(() => {
    if (panel && panel !== "commands") lastPanel.current = panel;
  }, [panel]);
  const toggleInspector = (next?: Exclude<Panel, null | "commands">) => {
    if (next) void setPanel(panel === next ? null : next);
    else void setPanel(panel && panel !== "commands" ? null : lastPanel.current);
  };

  // Live Git branch & dirty indicator for all git repositories (not only LinkShell worktrees).
  const sessionGit = useLoad(
    () => (online && session.cwd ? actions.gitInfo(session.cwd) : Promise.resolve(undefined)),
    [store, online, session.cwd],
  );
  const prevTurnActive = useRef(view?.turnActive);
  useEffect(() => {
    if (prevTurnActive.current && !view?.turnActive && online && session.cwd) {
      sessionGit.reload();
    }
    prevTurnActive.current = view?.turnActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.turnActive, online, session.cwd]);

  const canOpenLocalPath =
    isElectronDesktop && connection.computer?.key === DESKTOP_LOCAL && Boolean(session.cwd);
  const openLocalPath = (app: "default" | "cursor" | "vscode" | "zed" | "terminal") => {
    if (!online || !session.cwd) return;
    void openPathJob.run(async () => {
      await link.call("desktop.openPath", { path: session.cwd, app });
    });
  };

  // MCP Apps (Codex): a tool's own page in the inspector. The agent's call to such a tool opens it
  // there by itself, as Codex does; the inspector's + menu opens one by hand.
  const [apps, setApps] = useState<AppTab[]>([]);
  const appCalls = useMemo(() => (isDesktop ? (view?.items ?? []).filter(isAppCall) : []), [view?.items]);
  const seenCalls = useRef<Set<string>>(undefined);
  // Calls whose app was closed by hand: they don't open it again.
  const closedCalls = useRef(new Set<string>());
  useEffect(() => {
    if (!appCalls.length && !seenCalls.current) return;
    // What was already done when the session opened is history: it opens nothing.
    seenCalls.current ??= new Set(appCalls.filter(callDone).map((call) => call.id));
    const seen = seenCalls.current;
    let next = apps;
    let open: AppPanel | undefined;
    for (const call of appCalls) {
      const { server, tool, app } = call.detail;
      const id = appTabId(server, app.resourceUri) as AppPanel;
      const fresh = !seen.has(call.id);
      seen.add(call.id);
      const shown = { callId: call.id, input: appInput(call), result: appResult(call) };
      const index = next.findIndex((tab) => tab.id === id);
      if (index >= 0) {
        const tab = next[index];
        // A later call moves the open app to it; the shown call's result updates it when it lands.
        const moves = fresh || tab.callId === call.id;
        const changed = tab.callId !== shown.callId || JSON.stringify(tab.result) !== JSON.stringify(shown.result);
        if (moves && changed) next = next.map((entry, at) => (at === index ? { ...entry, ...shown, launched: false } : entry));
      } else if (fresh && !callDone(call) && app.displayMode !== "inline" && !closedCalls.current.has(call.id)) {
        next = [...next, { id, server, tool, title: server, resourceUri: app.resourceUri, connector: app.connector, ...shown }];
        open = id;
      }
    }
    if (next !== apps) setApps(next);
    if (open) void setPanel(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appCalls]);
  const appCatalog = useLoad(
    () => (isDesktop && hasApps ? connection.link.call("mcp.apps", { sessionId: session.id }).then((result) => result.apps) : Promise.resolve([])),
    [connection.link, session.id, hasApps],
  );
  const appTitle = (tab: AppTab) =>
    appCatalog.value?.find((entry) => entry.server === tab.server && entry.resourceUri === tab.resourceUri)?.title ?? tab.title;
  const launchApp = (entry: { server: string; tool: string; title: string; resourceUri: string; connector?: string }) => {
    const id = appTabId(entry.server, entry.resourceUri) as AppPanel;
    if (!apps.some((tab) => tab.id === id)) setApps((list) => [...list, { id, server: entry.server, tool: entry.tool, title: entry.title, resourceUri: entry.resourceUri, connector: entry.connector, launched: true }]);
    void setPanel(id);
  };
  /** A call's page, from its row in the conversation: open again, or for the first time (inline apps). */
  // Mail from another of the agent's sessions names it by the app's own id (the Claude app's local_…).
  const findSession = (appId: string) => {
    const sender = Object.values(connection.store.getState().sessions).find((candidate) => candidate.appId === appId);
    return sender && { title: titleOf(sender), open: () => navigate(sender.id) };
  };
  const openAppCall = (callId: string) => {
    const call = appCalls.find((entry) => entry.id === callId);
    if (!call) return;
    const { server, tool, app } = call.detail;
    const id = appTabId(server, app.resourceUri) as AppPanel;
    const shown = { callId: call.id, input: appInput(call), result: appResult(call), launched: false };
    closedCalls.current.delete(call.id);
    setApps((list) => list.some((tab) => tab.id === id)
      ? list.map((tab) => (tab.id === id ? { ...tab, ...shown } : tab))
      : [...list, { id, server, tool, title: server, resourceUri: app.resourceUri, connector: app.connector, ...shown }]);
    void setPanel(id);
  };
  const closeApp = (id: string) => {
    const tab = apps.find((entry) => entry.id === id);
    if (tab?.callId) closedCalls.current.add(tab.callId);
    const rest = apps.filter((entry) => entry.id !== id);
    setApps(rest);
    if (panel === id) {
      const fallback = isAppPanel(lastPanel.current) ? undefined : lastPanel.current;
      void setPanel((rest.at(-1)?.id as AppPanel | undefined) ?? fallback ?? null);
    }
  };
  const sayFromApp = async (content: ContentBlock[]) => {
    if (!content.length) return;
    if ((await actions.send(session.id, content)) === "failed") throw new Error("消息发送失败，请重试");
  };
  useDesktopCommand((command) => {
    if (!active) return;
    if (command.command === "inspector") {
      if (command.panel) void setPanel(command.panel);
      else toggleInspector();
    }
  });
  useEffect(() => {
    if (!isDesktop || !active) return;
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keysBelongToContent()) return;
      if (matchesShortcut(event, desktopShortcuts.toggleInspector)) { event.preventDefault(); toggleInspector(); }
      else if (matchesShortcut(event, desktopShortcuts.terminal)) { event.preventDefault(); toggleInspector("terminal"); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });
  const [forkAt, setForkAt] = useState<string | null>();
  const [newWorktree, setNewWorktree] = useState(false);
  const forkGit = useLoad(
    () =>
      forkAt !== undefined
        ? actions.gitInfo(session.cwd)
        : Promise.resolve(undefined),
    [store, session.cwd, forkAt],
  );
  // The conversation renders even with no messages when something in the footer
  // needs the user: a pending permission, an async question, or a live turn.
  const footerActive =
    !!view?.permissions.length ||
    !!session.asyncQuestions?.length ||
    !!view?.turnActive ||
    !!notices?.length;
  const hasContent = !!view && (view.items.length > 0 || footerActive);
  const showComposerCaption = !canInteract && !hasContent;
  const [syncDelayed, setSyncDelayed] = useState(false);
  useEffect(() => {
    if (!online || canInteract || !hasContent) {
      setSyncDelayed(false);
      return;
    }
    const timer = setTimeout(() => setSyncDelayed(true), 450);
    return () => clearTimeout(timer);
  }, [online, canInteract, hasContent]);
  const showRecovery = !canInteract && hasContent && (!online || syncDelayed);
  const composerWrap = useRef<HTMLDivElement>(null);
  const captureComposerWrap = useCallback((wrap: HTMLDivElement | null) => {
    composerWrap.current = wrap;
    return composerHeightRef(wrap);
  }, []);
  // The loading caption disappears with the history snapshot. Update its inset in
  // that same layout, before the resize observer's next delivery can move the text.
  useLayoutEffect(() => {
    const wrap = composerWrap.current;
    if (wrap) wrap.parentElement?.style.setProperty("--composer-height", `${Math.round(wrap.offsetHeight)}px`);
  }, [showComposerCaption]);
  const retrySession = () => {
    if (!online) link.reconnectNow();
    else {
      actions.closeSession(session.id);
      actions.openSession(session.id);
    }
  };

  // In-session search (`⌘F`) & Turn Outline jump
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [outlineFilter, setOutlineFilter] = useState<"all" | "prompts" | "approvals" | "errors">("all");
  const [focusTarget, setFocusTarget] = useState<{ itemId: string; nonce: number }>();
  const jumpToItem = useCallback(
    (itemId: string) => setFocusTarget((prev) => ({ itemId, nonce: (prev?.nonce ?? 0) + 1 })),
    [],
  );

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || !view?.items.length) return [];
    return view.items.filter((item) => timelineItemSearchText(item).toLowerCase().includes(q));
  }, [searchQuery, view?.items]);

  const firstMatchId = searchMatches[0]?.id;
  useEffect(() => {
    setSearchIndex(0);
    if (firstMatchId) jumpToItem(firstMatchId);
  }, [searchQuery, firstMatchId, jumpToItem]);

  useEffect(() => {
    if (!active) return;
    const onFindShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keysBelongToContent()) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    };
    window.addEventListener("keydown", onFindShortcut);
    return () => window.removeEventListener("keydown", onFindShortcut);
  }, [active]);

  const outlineEntries = useMemo(() => {
    const list: { id: string; category: "prompts" | "approvals" | "errors"; label: string }[] = [];
    for (const item of view?.items ?? []) {
      if (item.kind === "user" && !item.agentMessages?.length) {
        const text = userMessageView(item.blocks).text.trim();
        if (text) list.push({ id: item.id, category: "prompts", label: text.replace(/\s+/g, " ").slice(0, 80) });
      } else if (item.kind === "permission-result") {
        list.push({ id: item.id, category: "approvals", label: `${item.title} · ${item.optionName}` });
      } else if (item.kind === "error") {
        list.push({ id: item.id, category: "errors", label: item.message.replace(/\s+/g, " ").slice(0, 80) });
      } else if (item.kind === "tool" && item.status === "failed") {
        list.push({ id: item.id, category: "errors", label: item.title.replace(/\s+/g, " ").slice(0, 80) });
      }
    }
    return outlineFilter === "all" ? list : list.filter((entry) => entry.category === outlineFilter);
  }, [view?.items, outlineFilter]);

  const queue = shownQueue(session.queue, queueing);
  const handleFile = (path: string, line?: number) => {
    void changeFile(path, line);
  };
  async function changeFile(path?: string, line?: number) {
    if (
      file !== path &&
      fileDirty.current &&
      !(await dialogs.confirm("文件有未保存的修改，放弃修改并打开其他文件？"))
    )
      return;
    if (file !== path) fileDirty.current = false;
    setFile(path);
    setFileLine(line);
    commitPanel("files");
  }
  useEffect(
    () =>
      link.on("session.preview.show", (event) => {
        if (event.sessionId === session.id) {
          setPreviewMode("computer");
          void setPanel("preview");
        }
      }),
    [link, session.id, setPanel],
  );
  useEffect(() => {
    if (connection.sessions) return connection.sessions.acquire(session.id);
    store.getState().openSession(session.id);
    return () => store.getState().closeSession(session.id);
  }, [connection.sessions, store, session.id]);
  async function execute(text: string): Promise<boolean> {
    if (!canInteract) return false;
    const parsed = parseCommand(text);
    const command =
      parsed && commands.find((item) => item.name === parsed.name);
    if (!parsed || !command?.action) return false;
    const args = parsed.args;
    switch (command.action) {
      case "commands":
        await setPanel("commands");
        break;
      case "tasks":
        await setPanel("tasks");
        break;
      case "changes":
        await setPanel("changes");
        break;
      case "context":
        await dialogs.alert(
          view?.usage?.contextWindow
            ? `${view.usage.usedTokens ?? 0} / ${view.usage.contextWindow} tokens`
            : "Agent 尚未报告上下文用量",
        );
        break;
      case "goal":
        if (args && args !== "edit") return false;
        await setPanel("goal");
        break;
      case "side":
        // Asked at once; the panel shows the answer coming.
        if (args) await actions.askSide(session.id, args);
        await setPanel("side");
        break;
      case "settings": {
        const option = view?.config.find(
          (option) => option.id === command.optionId,
        );
        if (command.name === "plan" && !args && option)
          await actions.setConfig(
            session.id,
            option.id,
            option.id === "plan" ? "on" : "plan",
          );
        else if (!args || !option) await setPanel("settings");
        else {
          const value = option.values.find(
            (value) =>
              value.value.toLowerCase() === args.toLowerCase() ||
              value.name.toLowerCase() === args.toLowerCase(),
          );
          if (value)
            await actions.setConfig(session.id, option.id, value.value);
          else if (command.name === "plan") {
            await actions.setConfig(
              session.id,
              option.id,
              option.id === "plan" ? "on" : "plan",
            );
            const result = await actions.send(session.id, [
              { type: "text", text: args },
            ]);
            if (result === "failed") throw new Error("任务发送失败，请重试");
          } else
            throw new Error(
              `可选值：${option.values.map((value) => value.value).join("、")}`,
            );
        }
        break;
      }
      case "rename": {
        const title =
          args || (await dialogs.prompt("会话名称", titleOf(session)));
        if (title !== null) await actions.rename(session.id, title);
        break;
      }
      case "new": {
        if (args) throw new Error("请先新建会话，再输入消息");
        const next = await actions.createSession({
          agent: session.agent,
          cwd: session.cwd,
        });
        navigate(next.id);
        break;
      }
      case "fork":
        if (args) throw new Error("/fork 不需要参数");
        setForkAt(null);
        break;
    }
    return true;
  }
  async function chooseFromModal(command: Command) {
    if (command.action && !canInteract) return;
    if (!(await setPanel(null))) return;
    if (command.action) {
      await job.run(() => execute(`/${command.name}`));
    } else {
      composerRef.current?.setDraft(`/${command.name} `);
    }
  }
  async function nativePanel(name: "mcp" | "apps") {
    if (!canInteract) return;
    if (!(await setPanel(name))) return;
    void job.run(async () => {
      const result = await actions.send(
        session.id,
        [{ type: "text", text: `/${name}` }],
        // Codex answers these beside a turn; Claude would take them as a message into it.
        { now: session.agent === "codex" },
      );
      if (result === "failed") throw new Error(`/${name} 执行失败`);
    });
  }

  const branchLabel =
    session.worktree?.branch ??
    sessionGit.value?.branch ??
    (sessionGit.value?.head ? `HEAD ${sessionGit.value.head}` : undefined);
  const isGitDirty = Boolean(sessionGit.value?.dirty);

  const top = (
    <>
        <div className="session-heading">
          <div className={isDesktop ? "session-heading-context" : undefined}>
            <div className={isDesktop ? "session-heading-copy" : undefined}>
              <div className="session-title">
                <h1 title={titleOf(session)}>{titleOf(session)}</h1>
                {/* On the desktop the state shows in the sidebar and the conversation's own working line. */}
                {!isDesktop && (sessionNeedsAttention(session)
                  ? <Badge state="waiting" label={waitingLabel(session)} />
                  : <Badge state={session.state} />)}
              </div>
              <div className="session-subtitle">
                <AgentMark agent={session.agent} size={isDesktop ? "sm" : "md"} />
                <span>{isDesktop ? agent?.label ?? session.agent : session.agent}</span>
                <span className="separator">{isDesktop ? "·" : "/"}</span>
                {isDesktop ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="session-directory" aria-label={`工作目录：${session.cwd}`}>
                        {baseName(session.cwd) || session.cwd}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-all">{session.cwd}</TooltipContent>
                  </Tooltip>
                ) : <span title={session.cwd}>{session.cwd}</span>}
                {branchLabel && (
                  <span className="branch-chip" title={session.worktree ? `Worktree 分支：${branchLabel}` : `Git 分支：${branchLabel}`}>
                    <GitBranch className="size-3 shrink-0" aria-hidden />
                    <span>{branchLabel}</span>
                    {isGitDirty && (
                      <span className="branch-dirty-badge" title="工作区有未提交改动" aria-label="工作区有未提交改动">
                        未提交
                      </span>
                    )}
                  </span>
                )}
                {!branchLabel && isGitDirty && (
                  <span className="branch-dirty-badge" title="工作区有未提交改动" aria-label="工作区有未提交改动">
                    未提交
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="session-actions">
            {canOpenLocalPath && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="session-open-in"
                    disabled={!online || openPathJob.busy}
                    aria-label="打开方式"
                  >
                    <ExternalLink data-icon="inline-start" />
                    <span>打开方式</span>
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>在外部应用中打开</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => openLocalPath("cursor")}>
                      <Code2 />Cursor
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openLocalPath("vscode")}>
                      <Code2 />VS Code
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openLocalPath("zed")}>
                      <Code2 />Zed
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => openLocalPath("terminal")}>
                      <SquareTerminal />终端
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openLocalPath("default")}>
                      <FolderOpen />{isWindowsDesktop ? "资源管理器" : "Finder"}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {isDesktop && agent?.tier === "handoff" && (
              // Who holds the session, in its title row: one pill that takes it over or gives it back.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="session-handoff"
                    disabled={!canInteract || job.busy}
                    onClick={() =>
                      void job.run(() =>
                        session.driver === "remote" ? actions.release(session.id) : actions.takeover(session.id),
                      )
                    }
                  >
                    {session.driver === "remote" ? "交回电脑" : "接管"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  当前由{session.driver === "desktop" ? "电脑端" : session.driver === "remote" ? "这里" : "空闲会话"}控制
                </TooltipContent>
              </Tooltip>
            )}
            {isDesktop ? (
              <>
                {/* Once the inspector is open beside the session, its own tab bar shows 变更/终端. */}
                {(!panel || panel === "commands") && (
                  <div className="session-quick-tools">
                    {([
                      ["changes", "branch", "变更"],
                      ["terminal", "terminal", `终端 · ${shortcutText(desktopShortcuts.terminal)}`],
                    ] as const).map(([id, icon, label]) => (
                      <Tooltip key={id}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={label}
                            onClick={() => toggleInspector(id)}
                          >
                            <Icon name={icon} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{label}</TooltipContent>
                      </Tooltip>
                    ))}
                    <span className="session-actions-divider" aria-hidden />
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="检查器"
                      aria-pressed={!!panel && panel !== "commands"}
                      data-active={(!!panel && panel !== "commands") || undefined}
                      onClick={() => toggleInspector()}
                    >
                      <PanelRight />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {panel && panel !== "commands" ? "收起检查器" : "检查器"} · {shortcutText(desktopShortcuts.toggleInspector)}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  title="查看变更"
                  data-active={panel === "changes" || undefined}
                  onClick={() => setPanel("changes")}
                >
                  <Icon name="branch" />
                  变更
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="浏览文件"
                  data-active={panel === "files" || undefined}
                  onClick={() => void changeFile()}
                >
                  <Icon name="folder" />
                  文件
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="查看任务"
                  data-active={panel === "tasks" || undefined}
                  onClick={() => setPanel("tasks")}
                >
                  <Icon name="server" />
                  任务
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="打开预览"
                  data-active={panel === "preview" || undefined}
                  onClick={() => setPanel("preview")}
                >
                  <Icon name="computer" />
                  预览
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="会话命令"
                      onClick={() => setPanel("commands")}
                    >
                      <Icon name="terminal" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>会话命令</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="会话设置"
                      data-active={panel === "settings" || undefined}
                      onClick={() => setPanel("settings")}
                    >
                      <Icon name="settings" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>模型与权限</TooltipContent>
                </Tooltip>
              </>
            )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.search")}
                      aria-pressed={searchOpen}
                      data-active={searchOpen || undefined}
                      onClick={() => {
                        setSearchOpen((prev) => {
                          const next = !prev;
                          if (next) {
                            requestAnimationFrame(() => searchInputRef.current?.focus());
                          }
                          return next;
                        });
                      }}
                    >
                      <Search />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.search")} · ⌘F</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={t("session.outline")}>
                          <ListTree />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{t("session.outline")}</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="w-72">
                    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
                      {(
                        [
                          ["all", "session.outlineAll"],
                          ["prompts", "session.outlinePrompts"],
                          ["approvals", "session.outlineApprovals"],
                          ["errors", "session.outlineErrors"],
                        ] as const
                      ).map(([filterKey, labelKey]) => (
                        <Button
                          key={filterKey}
                          type="button"
                          size="xs"
                          variant={outlineFilter === filterKey ? "secondary" : "ghost"}
                          onClick={(event) => {
                            event.preventDefault();
                            setOutlineFilter(filterKey);
                          }}
                        >
                          {t(labelKey)}
                        </Button>
                      ))}
                    </div>
                    {outlineEntries.length === 0 ? (
                      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                        {t("session.noMatches")}
                      </div>
                    ) : (
                      <DropdownMenuGroup className="max-h-72 overflow-y-auto">
                        {outlineEntries.map((entry) => (
                          <DropdownMenuItem
                            key={entry.id}
                            onSelect={() => jumpToItem(entry.id)}
                          >
                            <span className="truncate text-xs">{entry.label}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="更多会话操作">
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>更多会话操作</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-56">
                {isDesktop && (
                  <>
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => void setPanel("settings")}>
                        <Icon name="settings" />会话设置
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void setPanel("commands")}>
                        <Icon name="terminal" />会话命令
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void setPanel("tasks")}>
                        <Icon name="server" />后台任务
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuGroup>
                  {agent?.capabilities.side && (
                    <DropdownMenuItem disabled={!canInteract} onSelect={() => void setPanel("side")}>
                      <MessagesSquare />旁支对话
                    </DropdownMenuItem>
                  )}
                  {commands.some((command) => command.name === "goal") && (
                    <DropdownMenuItem onSelect={() => setPanel("goal")}>
                      <Target />持续目标
                    </DropdownMenuItem>
                  )}
                  {commands.some((command) => command.name === "mcp") && (
                    <DropdownMenuItem disabled={!canInteract} onSelect={() => nativePanel("mcp")}>
                      <Plug />MCP 服务
                    </DropdownMenuItem>
                  )}
                  {commands.some((command) => command.name === "apps") && (
                    <DropdownMenuItem disabled={!canInteract} onSelect={() => nativePanel("apps")}>
                      <Blocks />应用与连接器
                    </DropdownMenuItem>
                  )}
                  {/* The desktop's title row already has the terminal, one click away. */}
                  {!isDesktop && (
                    <DropdownMenuItem onSelect={() => setTerminals(true)}>
                      <SquareTerminal />终端
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={!canInteract} onSelect={() => setForkAt(null)}>
                    <GitFork />分叉会话
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canInteract}
                    onSelect={() => void job.run(() => execute("/rename"))}
                  >
                    <PencilLine />重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canInteract}
                    onSelect={() =>
                      void job.run(() =>
                        actions.archive(session.id, !session.archived),
                      )
                    }
                  >
                    {session.archived ? <ArchiveRestore /> : <Archive />}
                    {session.archived ? "取消归档" : "归档"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!canInteract || session.state === "running"}
                    onSelect={() =>
                      void job.run(async () => {
                        if (await confirmAndDeleteSession(session, actions, dialogs)) navigate("home");
                      })
                    }
                  >
                    <Trash2 />删除会话
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {agent?.tier === "handoff" && !isDesktop && (
          <div className="handoff-bar">
            <span>
              当前由
              {session.driver === "desktop"
                ? "电脑端"
                : session.driver === "remote"
                  ? "远程端"
                  : "空闲会话"}
              控制
            </span>
            <Button
              variant="link"
              size="sm"
              disabled={!canInteract || job.busy}
              onClick={() =>
                void job.run(() =>
                  session.driver === "remote"
                    ? actions.release(session.id)
                    : actions.takeover(session.id),
                )
              }
            >
              {session.driver === "remote" ? "交回电脑" : "接管会话"}
            </Button>
          </div>
        )}
    </>
  );
  const column = (
          <div className="session-body">
            {showRecovery && (
              <div className="conversation-recovery" role="status" data-offline={!online || undefined}>
                <span>
                  {isDesktop
                    ? online ? "正在同步最新消息" : "连接已断开，历史和草稿已保留"
                    : online ? "正在同步最新消息，已载入的历史仍可阅读。" : "连接已断开，历史和草稿已保留。"}
                </span>
                <Button variant="link" size="sm" onClick={retrySession}>
                  {online ? "重新加载" : "重新连接"}
                </Button>
              </div>
            )}
            {!ready && !hasContent && (
              <div className="conversation-loading" role="status">
                {online && <LoaderCircle className="conversation-loading-spinner" aria-hidden="true" />}
                <span className="conversation-loading-label">{online ? "正在载入会话…" : "等待电脑连接，草稿可继续编辑"}</span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={retrySession}
                >
                  {online ? "重新加载" : "重新连接"}
                </Button>
              </div>
            )}
            {ready &&
              view &&
              !view.items.length &&
              !view.permissions.length &&
              !session.asyncQuestions?.length && (
                <Empty className="conversation-empty">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquare />
                    </EmptyMedia>
                    <EmptyTitle>从一个具体任务开始</EmptyTitle>
                    <EmptyDescription>
                      描述你要完成的工作，也可以添加文件作为上下文。Agent
                      将在当前项目目录中继续。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            {searchOpen && (
              <div
                className="session-find-bar"
                role="search"
                aria-label={t("common.search")}
              >
                <Search className="session-find-icon" aria-hidden />
                <input
                  ref={searchInputRef}
                  type="search"
                  className="session-find-input"
                  value={searchQuery}
                  placeholder={t("session.searchPlaceholder")}
                  aria-label={t("session.searchPlaceholder")}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (isImeComposing(event)) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSearchOpen(false);
                      composerRef.current?.focus();
                    } else if (event.key === "Enter" && searchMatches.length > 0) {
                      event.preventDefault();
                      const delta = event.shiftKey ? searchMatches.length - 1 : 1;
                      const nextIdx = (searchIndex + delta) % searchMatches.length;
                      setSearchIndex(nextIdx);
                      const target = searchMatches[nextIdx];
                      if (target) jumpToItem(target.id);
                    }
                  }}
                />
                {searchQuery.trim() !== "" && (
                  <span className="session-find-count">
                    {searchMatches.length > 0
                      ? `${searchIndex + 1} / ${searchMatches.length}`
                      : t("session.noMatches")}
                  </span>
                )}
                <div className="session-find-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={searchMatches.length === 0}
                    aria-label="上一个匹配"
                    onClick={() => {
                      if (!searchMatches.length) return;
                      const nextIdx = (searchIndex + searchMatches.length - 1) % searchMatches.length;
                      setSearchIndex(nextIdx);
                      const target = searchMatches[nextIdx];
                      if (target) jumpToItem(target.id);
                    }}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={searchMatches.length === 0}
                    aria-label="下一个匹配"
                    onClick={() => {
                      if (!searchMatches.length) return;
                      const nextIdx = (searchIndex + 1) % searchMatches.length;
                      setSearchIndex(nextIdx);
                      const target = searchMatches[nextIdx];
                      if (target) jumpToItem(target.id);
                    }}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("common.close")}
                    onClick={() => setSearchOpen(false)}
                  >
                    <X />
                  </Button>
                </div>
              </div>
            )}
            {view && hasContent && (
              <Conversation
                view={view}
                sessionId={session.id}
                agent={session.agent}
                showAsyncQuestions={session.asyncQuestions === undefined}
                online={canInteract}
                loadingEarlier={!!loadingEarlier}
                loadEarlier={() => actions.loadEarlier(session.id)}
                onFile={handleFile}
                onFork={setForkAt}
                focusTarget={focusTarget}
                searchOpen={searchOpen}
                searchQuery={searchQuery}
                onTerminal={(id) => {
                  setTerminal(id);
                  setTerminals(true);
                }}
                footer={
                  <>
                    <AsyncQuestions
                      sessionId={session.id}
                      questions={session.asyncQuestions ?? []}
                    />
                    {view.permissions.map((permission) => (
                      <Permission
                        key={permission.requestId}
                        permission={permission}
                        sessionId={session.id}
                      />
                    ))}
                    <AgentInteractions agent={session.agent} />
                    {view.turnActive &&
                      canInteract &&
                      !["idle", "error", "offline"].includes(
                        session.state,
                      ) && (
                        <LiveActivity view={view} asking={!!session.asyncQuestions?.length} />
                      )}
                    {notices?.map((notice) => (
                      <section
                        key={notice.id}
                        className={`notice-card ${notice.severity === "error" ? "error" : ""}`}
                        role="status"
                      >
                        <div className="browser-toolbar">
                          <strong>{reconnectOf(notice.title, notice.description) ? reconnectLabel(reconnectOf(notice.title, notice.description)!, view.turnActive) : notice.title}</strong>
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() =>
                              actions.dismissNotice(session.id, notice.id)
                            }
                          >
                            关闭
                          </Button>
                        </div>
                        {notice.description && <p>{notice.description}</p>}
                      </section>
                    ))}
                  </>
                }
              />
            )}
            {!isDesktop && terminal && !terminals && (
              <div className="inline-terminal">
                <div className="browser-toolbar">
                  <span>终端</span>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setTerminal(undefined)}
                  >
                    收起
                  </Button>
                </div>
                <Terminal key={terminal} id={terminal} />
              </div>
            )}
            <div className="composer-wrap" ref={captureComposerWrap}>
              <ErrorNotice error={job.error ?? openPathJob.error} />
              <ErrorNotice error={sendJob.error} />
              <ErrorNotice error={attachmentError} />
              {sendJob.busy && (
                <p className="composer-progress" role="status">
                  <LoaderCircle aria-hidden="true" />
                  {sendingFile ? `正在处理附件：${sendingFile}` : "正在发送…"}
                </p>
              )}
              {queue.length > 0 && (
                <div className="message-queue">
                  <strong>待发送 · {queue.length}</strong>
                  {queue.map((item, index) => (
                    <div key={item.clientMessageId}>
                      <span title={item.text}>
                        {item.text || `${item.images} 张图片`}
                      </span>
                      <Button
                        variant="ghost"
                        size="plain"
                        disabled={job.busy || !canInteract || item.pending}
                        onClick={() =>
                          void job.run(() =>
                            actions.sendQueuedNow(
                              session.id,
                              item.clientMessageId,
                            ),
                          )
                        }
                      >
                        立即发送
                      </Button>
                      <Button
                        variant="ghost"
                        size="plain"
                        disabled={job.busy || !canInteract || item.pending}
                        onClick={() =>
                          void job.run(async () => {
                            if (
                              composerRef.current?.hasUnsentContent() &&
                              !(await dialogs.confirm(
                                "编辑这条待发送消息会替换当前草稿，继续吗？",
                              ))
                            )
                              return;
                            const content = await actions.takeQueued(
                              session.id,
                              item.clientMessageId,
                            );
                            if (content) {
                              composerRef.current?.replaceWithQueued(content);
                            }
                          })
                        }
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="plain"
                        aria-label="上移队列消息"
                        disabled={
                          !queue
                            .slice(0, index)
                            .some((entry) => !entry.pending) ||
                          job.busy ||
                          !canInteract ||
                          item.pending
                        }
                        onClick={() =>
                          void job.run(() => {
                            const ids = queue
                              .filter((item) => !item.pending)
                              .map((item) => item.clientMessageId);
                            const at = ids.indexOf(item.clientMessageId);
                            if (at < 1) return Promise.resolve();
                            [ids[at - 1], ids[at]] = [ids[at], ids[at - 1]];
                            return actions.reorderQueue(session.id, ids);
                          })
                        }
                      >
                        <Icon name="send" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="plain"
                        disabled={job.busy || !canInteract || item.pending}
                        onClick={() =>
                          void job.run(() =>
                            actions.unqueue(session.id, item.clientMessageId),
                          )
                        }
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <ComposerBox
                ref={composerRef}
                draftKey={draftKey}
                cwd={session.cwd}
                online={online}
                busy={sendJob.busy}
                active={active}
                ariaLabel="消息"
                ariaDescribedBy="composer-hint"
                placeholder={
                  !online
                    ? "连接已断开，可以继续编辑草稿…"
                    : showComposerCaption && isDesktop
                      ? "正在同步会话，完成后可发送…"
                      : t("composer.placeholder")
                }
                layoutKey={panel}
                commands={commands}
                inlineAttachmentError={false}
                onAttachmentErrorChange={setAttachmentError}
                onShortcutPicker={requestPicker}
                onChooseCommand={async (command, helpers) => {
                  if (command.action && !canInteract) return;
                  if (!(await setPanel(null))) return;
                  if (command.action) {
                    const executed = await job.run(() => execute(`/${command.name}`));
                    if (executed) helpers.clearDraft();
                  } else {
                    helpers.setDraftText(`/${command.name} `);
                  }
                }}
                onSubmit={(payload) =>
                  sendJob.run(async () => {
                    setSendingFile(undefined);
                    const { text, files: pickedFiles, pastedTexts, blocks: existingBlocks, now, clear } = payload;
                    if (!canInteract || (!text && !pickedFiles.length && !pastedTexts.length && !existingBlocks.length)) return;
                    if (!pickedFiles.length && !pastedTexts.length && !existingBlocks.length && (await execute(text))) {
                      clear();
                      return;
                    }
                    const content = await buildComposerContentBlocks({
                      text,
                      files: pickedFiles,
                      pastedTexts,
                      blocks: existingBlocks,
                      capabilities: agent?.capabilities,
                      uploadDir: session.cwd,
                      uploadCache: uploaded.current,
                      callUpload: (dir, name, data) => link.call("fs.upload", { dir, name, data }, 180000),
                      onSendingFile: setSendingFile,
                    });
                    if (!content.length) return;
                    const parsed = parseCommand(text);
                    const immediate =
                      now ||
                      (session.agent === "codex" &&
                        !!parsed &&
                        ["mcp", "apps", "status", "ps", "stop", "goal"].includes(parsed.name));
                    const current = store.getState();
                    if (current.status !== "online" || !current.ready[session.id])
                      throw new Error("会话连接正在恢复，输入和附件已保留，请同步完成后重试");
                    await finishComposerSend(actions.send(session.id, content, { now: immediate }), clear);
                  })
                }
                toolbar={({ hasContent: typed, hasText, openFilePicker, setDraftText, submit }) => (
                  <>
                    <div className="composer-controls">
                      <div className="composer-tools">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label="添加附件"
                              onClick={openFilePicker}
                            >
                              <Icon name="attach" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">添加附件 · 单个文件最多 {MAX_ATTACHMENT_LABEL}，图片会自动压缩</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label="打开命令面板"
                              onClick={() => setPanel("commands")}
                            >
                              <Icon name="commands" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">命令与技能 · /</TooltipContent>
                        </Tooltip>
                        <DropdownMenu>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={t("composer.quickPrompts")}
                                >
                                  <Sparkles />
                                </Button>
                              </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="top">{t("composer.quickPrompts")}</TooltipContent>
                          </Tooltip>
                          <DropdownMenuContent align="start" side="top" className="w-56">
                            <DropdownMenuLabel>{t("composer.quickPrompts")}</DropdownMenuLabel>
                            {(
                              [
                                ["composer.quickRunTests", "composer.quickRunTestsPrompt"],
                                ["composer.quickSummarize", "composer.quickSummarizePrompt"],
                                ["composer.quickContinue", "composer.quickContinuePrompt"],
                                ["composer.quickCommitPr", "composer.quickCommitPrPrompt"],
                              ] as const
                            ).map(([labelKey, promptKey]) => (
                              <DropdownMenuItem
                                key={labelKey}
                                onSelect={() => setDraftText(t(promptKey))}
                              >
                                {t(labelKey)}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="composer-options">
                        <ComposerConfig
                          session={session}
                          config={view?.config ?? []}
                          disabled={!online}
                          openSettings={() => setPanel("settings")}
                          pickerRequest={pickerRequest}
                        />
                      </div>
                    </div>
                    <div className="composer-meta">
                      <ComposerPlace session={session} />
                      {view?.usage?.contextWindow ? (
                        <ContextRing
                          used={view.usage.usedTokens ?? 0}
                          window={view.usage.contextWindow}
                        />
                      ) : null}
                    </div>
                    <div className="composer-actions">
                      {(() => {
                        // As Codex: while a turn runs and nothing is typed, the send button is the
                        // stop button; typing turns it back into send (to the queue), with 插话
                        // beside it and stop as a small square.
                        const running = view?.turnActive || session.state === "unknown";
                        const canStop = running && !!agent?.capabilities.interrupt;
                        const stop = (primary: boolean) => (
                          <Button
                            type="button"
                            variant={primary ? "default" : "ghost"}
                            size="icon"
                            className={primary ? "send-button composer-stop" : "composer-stop-small"}
                            aria-label="停止当前回合"
                            title="停止当前回合"
                            disabled={!canInteract || job.busy}
                            onClick={() => void job.run(() => actions.cancel(session.id))}
                          >
                            <Square className="composer-stop-glyph" aria-hidden />
                          </Button>
                        );
                        if (canStop && !typed) return stop(true);
                        return (
                          <>
                            {canStop && stop(false)}
                            {view?.turnActive && agent?.capabilities.steer && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="composer-steer"
                                title="立即发送，不等这一轮结束 · ⌘/Ctrl Enter"
                                disabled={!canInteract || sendJob.busy || !hasText}
                                onClick={() => submit(true)}
                              >
                                插话
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="default"
                              size="icon"
                              className="send-button"
                              aria-label={view?.turnActive ? "加入发送队列" : "发送消息"}
                              title={view?.turnActive ? "加入队列 · Enter（⌘/Ctrl Enter 立即发送）" : "发送 · Enter（Shift Enter 换行）"}
                              disabled={!canInteract || sendJob.busy || !typed}
                              onClick={() => submit(false)}
                            >
                              {sendJob.busy ? <LoaderCircle className="animate-spin" /> : <Icon name="send" />}
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </>
                )}
              />
              {/* The keys are in the send button's tooltip; only a state worth knowing gets a line here. */}
              <span className="sr-only" id="composer-hint">
                {view?.turnActive
                  ? "Enter 加入队列，⌘/Ctrl Enter 立即发送"
                  : "Enter 发送，Shift Enter 换行，/ 打开命令"}
              </span>
              {/* On the desktop the composer floats over the conversation: a line under it would lift it while the session syncs. */}
              {showComposerCaption && !isDesktop && (
                <div className="composer-caption">
                  <span>{online ? "同步完成后可发送" : "连接已断开，草稿已保留"}</span>
                </div>
              )}
            </div>
          </div>
  );
  return (
    <SessionReady.Provider value={!!ready}>
    <TimelineNavigation.Provider value={{ cwd: session.cwd, open: handleFile, openApp: isDesktop ? openAppCall : undefined, findSession }}>
      <div className="session-page live-session">
        {!isDesktop && top}
        <div
          className={`session-layout ${panel && panel !== "commands" ? "with-panel" : ""}`}
          style={isDesktop ? ({ "--inspector-width": `${inspectorWidth}px` } as CSSProperties) : undefined}
        >
          {isDesktop ? (
            <div className="session-main">
              {top}
              {column}
            </div>
          ) : column}
          {panel && panel !== "commands" && (
            <ConversationPanel
              close={() => setPanel(null)}
              title={isAppPanel(panel) ? (apps.find((tab) => tab.id === panel)?.title ?? "应用") : panelTitles[panel]}
              panel={panel}
              choose={(next) => void (next === "files" ? changeFile() : setPanel(next))}
              width={inspectorWidth}
              resize={setInspectorWidth}
              hasTasks={hasTasks}
              apps={apps.map((tab) => ({ id: tab.id as AppPanel, title: appTitle(tab) }))}
              closeApp={closeApp}
              launcher={hasApps ? (
                <DropdownMenu onOpenChange={(open) => { if (open && appCatalog.error) appCatalog.reload(); }}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="inspector-add" aria-label="打开插件" title="打开插件">
                      <Plus />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="inspector-add-menu">
                    <DropdownMenuLabel>插件和 MCP</DropdownMenuLabel>
                    {appCatalog.loading && !appCatalog.value && <DropdownMenuItem disabled>正在读取…</DropdownMenuItem>}
                    {appCatalog.error && <DropdownMenuItem disabled>{appCatalog.error}</DropdownMenuItem>}
                    {appCatalog.value && !appCatalog.value.length && <DropdownMenuItem disabled>没有可以在会话中打开的插件</DropdownMenuItem>}
                    {appCatalog.value?.map((entry) => (
                      <DropdownMenuItem key={`${entry.server}\n${entry.resourceUri}`} disabled={!canInteract} onSelect={() => launchApp(entry)}>
                        {entry.title}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined}
            >
              <div className="side-panel-content" data-panel={panel}>
                {apps.map((tab) => (
                  <ErrorBoundary key={tab.id} resetKey={`${session.id}:${tab.id}`}>
                    <McpAppView sessionId={session.id} tab={{ ...tab, title: appTitle(tab) }} hidden={panel !== tab.id} say={sayFromApp} />
                  </ErrorBoundary>
                ))}
                <ErrorBoundary resetKey={`${session.id}:${panel}`}>
                  {panel === "settings" && (
                    <Settings session={session} view={view} />
                  )}
                  {panel === "changes" && (
                    <Changes
                      view={view}
                      session={session}
                      inspectorWidth={isDesktop ? inspectorWidth : undefined}
                      onCommitted={sessionGit.reload}
                    />
                  )}
                  {panel === "files" &&
                    (file ? (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => void changeFile()}
                        >
                          返回文件列表
                        </Button>
                        <FileView
                          key={file}
                          line={fileLine}
                          path={file}
                          onDirtyChange={onFileDirtyChange}
                        />
                      </>
                    ) : (
                      <Files
                        start={session.cwd}
                        onDirtyChange={onFileDirtyChange}
                      />
                    ))}
                  {panel === "tasks" && (
                    <Tasks
                      session={session}
                      onFile={handleFile}
                      onTerminal={(id) => {
                        setTerminal(id);
                        if (isDesktop) void setPanel("terminal");
                      }}
                    />
                  )}
                  {panel === "goal" && <Goal session={session} view={view} />}
                  {panel === "side" && <Side session={session} label={agent?.label ?? session.agent} />}
                  {panel === "terminal" && (
                    <Terminals
                      cwd={session.cwd}
                      sessionId={session.id}
                      selected={terminal}
                      onSelect={setTerminal}
                    />
                  )}
                  {panel === "preview" && (
                    <div className="session-preview-inspector">
                      <div className="session-preview-switcher">
                        <Tabs
                          value={previewMode}
                          onValueChange={(next) => setPreviewMode(next as "port" | "computer")}
                        >
                          <TabsList aria-label="预览来源">
                            <TabsTrigger value="port">
                              <Globe className="size-3.5" aria-hidden />
                              本地服务
                            </TabsTrigger>
                            <TabsTrigger value="computer">
                              <Monitor className="size-3.5" aria-hidden />
                              电脑操作
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </div>
                      <div className="session-preview-body">
                        {previewMode === "port" ? (
                          <SessionPortPreview sessionId={session.id} cwd={session.cwd} />
                        ) : (
                          <ComputerPreview sessionId={session.id} />
                        )}
                      </div>
                    </div>
                  )}
                  {(panel === "mcp" || panel === "apps") && (
                    <>
                      <p className="muted">
                        由电脑上的 {session.agent}{" "}
                        提供。完整结果、授权请求和错误同时显示在会话中。
                      </p>
                      <Button
                        variant="outline"
                        disabled={!canInteract || job.busy}
                        onClick={() => nativePanel(panel)}
                      >
                        刷新 /{panel}
                      </Button>
                      {(() => {
                        // Codex says it as a notice; Claude answers the command as a reply of its own.
                        const items = view?.items ?? [];
                        let notice = -1;
                        let asked = -1;
                        items.forEach((item, at) => {
                          if (item.kind === "notice" && item.title === `/${panel}`) notice = at;
                          if (item.kind === "user" && item.blocks.length === 1 && item.blocks[0]?.type === "text" && item.blocks[0].text.trim() === `/${panel}`) asked = at;
                        });
                        const shown = items[notice];
                        if (shown?.kind === "notice" && notice > asked)
                          return <pre className="service-status">{shown.detail ?? "当前没有记录"}</pre>;
                        const reply = asked >= 0 ? items.slice(asked + 1).find((item) => item.kind === "agent") : undefined;
                        if (reply?.kind === "agent")
                          return <div className="service-status markdown"><StreamingText text={reply.text} streaming={!!reply.streaming && online} /></div>;
                        if (shown?.kind === "notice") return <pre className="service-status">{shown.detail ?? "当前没有记录"}</pre>;
                        return null;
                      })()}
                    </>
                  )}
                </ErrorBoundary>
              </div>
            </ConversationPanel>
          )}
        </div>
        {panel === "commands" && (
          <Commands
            returnFocus={() => composerRef.current?.focus()}
            commands={commands}
            close={() => setPanel(null)}
            choose={chooseFromModal}
          />
        )}
        {forkAt !== undefined && (
          <Modal title="分叉会话" close={() => setForkAt(undefined)}>
            <p className="muted">
              {forkAt
                ? "从选中的消息开始一段新会话。"
                : "保留当前上下文，创建独立的新会话。"}
            </p>
            <Label className="choice-option">
              <Checkbox
                checked={!!forkGit.value && newWorktree}
                disabled={forkGit.loading || !forkGit.value}
                onCheckedChange={(checked) => setNewWorktree(checked === true)}
              />
              在新的 worktree 中工作
            </Label>
            <ErrorNotice error={job.error} />
            <Button
              variant="default"
              disabled={job.busy || !canInteract}
              onClick={() =>
                void job.run(async () => {
                  const created = await actions.forkSession(session.id, {
                    itemId: forkAt ?? undefined,
                    worktree: !!forkGit.value && newWorktree,
                  });
                  setForkAt(undefined);
                  navigate(created.id);
                })
              }
            >
              创建分叉
            </Button>
          </Modal>
        )}
        {terminals && (
          <Modal wide title="终端" close={() => setTerminals(false)}>
            <Terminals
              cwd={session.cwd}
              selected={terminal}
              onSelect={setTerminal}
            />
          </Modal>
        )}
      </div>
    </TimelineNavigation.Provider>
    </SessionReady.Provider>
  );
}

function ConversationPanel({
  title,
  close,
  children,
  panel,
  choose,
  width,
  resize,
  hasTasks,
  apps = [],
  closeApp,
  launcher,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  panel?: Exclude<Panel, null | "commands">;
  choose?: (panel: Exclude<Panel, null | "commands">) => void;
  width?: number;
  resize?: (width: number) => void;
  /** The session has background tasks or sub-agents: their tab is shown. */
  hasTasks?: boolean;
  /** Open MCP Apps: a tab each, after the tools, closed with their ×. */
  apps?: { id: AppPanel; title: string }[];
  closeApp?: (id: AppPanel) => void;
  /** What the tab row's + offers (Codex's new-tab menu). */
  launcher?: ReactNode;
}) {
  // Desktop CSS turns the same inspector into an overlay. Keep its file/editor state mounted
  // while the window crosses that breakpoint; swapping it for a Sheet discards unsaved work.
  const compact = useIsMobile(991) && !isDesktop;
  const panelElement = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (compact) return;
    const element = panelElement.current;
    const previous = document.activeElement;
    // The desktop inspector takes focus itself; a focus ring on its first tab reads as a selection.
    (isDesktop ? element : element?.querySelector("button") ?? element)?.focus({
      preventScroll: true,
    });
    return () => {
      if (
        element?.contains(document.activeElement) &&
        previous instanceof HTMLElement
      )
        previous.focus({ preventScroll: true });
    };
  }, [compact]);
  const closeButton = (
    <Button variant="ghost" size="icon" aria-label="关闭面板" onClick={close}>
      <Icon name="close" />
    </Button>
  );
  if (compact)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-full! sm:max-w-[420px]! gap-0 overflow-hidden"
        >
          <SheetHeader className="flex-row items-center justify-between border-b">
            <SheetTitle>{title}</SheetTitle>
            {closeButton}
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  return (
    <aside
      ref={panelElement}
      className="live-side-panel"
      tabIndex={-1}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      {isDesktop && panel && choose ? (
        <>
          {resize && width && (
            <ColumnResizer
              className="inspector-resizer"
              label="调整检查器宽度"
              width={width}
              clamp={(value) => {
                const available = panelElement.current?.parentElement?.clientWidth ?? window.innerWidth;
                const maximum = window.innerWidth <= 1100 ? available - 40 : Math.min(window.innerWidth * 0.62, available - 360);
                return Math.round(Math.min(Math.max(value, 320), Math.max(320, maximum)));
              }}
              side="start"
              target=".session-layout"
              column=".live-side-panel"
              variable="--inspector-width"
              resize={resize}
              initial={440}
            />
          )}
          <div className="inspector-tabs" role="tablist" aria-label="检查器">
            {(() => {
              const tabs = [...inspectorTabs, ...(hasTasks ? [{ id: "tasks" as const, title: "任务" }] : [])];
              const open = tabs.some((tab) => tab.id === panel) || apps.some((app) => app.id === panel) ? undefined : { id: panel, title };
              return [...tabs, ...(open ? [open] : [])].map((tab) => (
                <button
                  type="button"
                  role="tab"
                  key={tab.id}
                  aria-selected={tab.id === panel}
                  data-active={tab.id === panel || undefined}
                  data-transient={tab === open || undefined}
                  onClick={() => choose(tab.id)}
                >
                  {tab.title}
                </button>
              ));
            })()}
            {apps.map((app) => (
              <span className="inspector-app-tab" key={app.id} data-active={app.id === panel || undefined}>
                <button type="button" role="tab" aria-selected={app.id === panel} title={app.title} onClick={() => choose(app.id)}>
                  <span>{app.title}</span>
                </button>
                {closeApp && (
                  <button type="button" className="inspector-app-close" aria-label={`关闭 ${app.title}`} title={`关闭 ${app.title}`} onClick={() => closeApp(app.id)}>
                    <X />
                  </button>
                )}
              </span>
            ))}
            {launcher}
            <span className="inspector-tabs-spacer" />
            {closeButton}
          </div>
        </>
      ) : (
        <div className="browser-toolbar">
          <strong>{title}</strong>
          {closeButton}
        </div>
      )}
      {children}
    </aside>
  );
}

