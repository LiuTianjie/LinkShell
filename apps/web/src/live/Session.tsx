import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ReactNode } from "react";
import { AsyncQuestions } from "./AsyncQuestions";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command as CommandUI,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { useDialogs } from "@/components/Dialogs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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
  ArrowDown,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { shownQueue } from "@linkshell/client-core";
import type { ContentBlock, SessionSummary } from "@linkshell/wire";
import {
  commandQuery,
  matchCommands,
  normalizeCommandText,
  parseCommand,
  sessionCommands,
  type Command,
} from "../../../client/src/lib/commands";
import { Icon } from "../icons";
import {
  AgentMark,
  Badge,
  ErrorNotice,
  LoadState,
  Modal,
  titleOf,
  useActions,
  useClient,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { Permission } from "./Permission";
import { AgentInteractions } from "./Acp";
import { Timeline, TimelineNavigation } from "./Timeline";
import { FileView, Files, fileBase64 } from "./Files";
import { Changes, Commands, Goal, Settings, Tasks } from "./Panels";
import { Terminal, Terminals } from "./Terminal";
import { readLocal, saveLocal } from "./storage";
import { ComputerPreview } from "./Video";
import "./chat-polish.css";

type Panel =
  | "commands"
  | "settings"
  | "changes"
  | "files"
  | "tasks"
  | "goal"
  | "mcp"
  | "apps"
  | "preview"
  | null;
export function Session({
  session,
  navigate,
}: {
  session: SessionSummary;
  navigate: (id: string) => void;
}) {
  const dialogs = useDialogs();
  const connection = useConnection();
  const { store, link } = connection;
  const actions = useActions();
  const job = useJob();
  const sendJob = useJob();
  const view = useClient((state) => state.views[session.id]);
  const ready = useClient((state) => state.ready[session.id]);
  const online = useClient((state) => state.status === "online");
  const loadingEarlier = useClient((state) => state.loadingEarlier[session.id]);
  const agent = useClient((state) =>
    state.machine?.agents.find((agent) => agent.id === session.agent),
  );
  const queueing = useClient((state) => state.queueing[session.id]);
  const notices = useClient((state) => state.notices[session.id]);
  const commands = useMemo(
    () =>
      sessionCommands(session.agent, view?.commands ?? [], view?.config ?? []),
    [session.agent, view?.commands, view?.config],
  );
  const draftKey = `draft.${connection.computer.key}.${session.id}`;
  const [draft, setDraft] = useState(() => readLocal(draftKey, ""));
  const [files, setFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [sendingFile, setSendingFile] = useState<string>();
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [panel, commitPanel] = useState<Panel>(null);
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
  const [terminals, setTerminals] = useState(false);
  const [choice, setChoice] = useState(0);
  const [forkAt, setForkAt] = useState<string | null>();
  const [newWorktree, setNewWorktree] = useState(false);
  const forkGit = useLoad(
    () =>
      forkAt !== undefined
        ? actions.gitInfo(session.cwd)
        : Promise.resolve(undefined),
    [store, session.cwd, forkAt],
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const historyAnchor = useRef<{
    height: number;
    top: number;
    firstId?: string;
  } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string>();
  const query =
    dismissedSuggestions === draft ? undefined : commandQuery(draft);
  const suggestions =
    query === undefined ? [] : matchCommands(commands, query).slice(0, 10);
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
        if (event.sessionId === session.id) void setPanel("preview");
      }),
    [link, session.id, setPanel],
  );
  useEffect(() => {
    store.getState().openSession(session.id);
    return () => store.getState().closeSession(session.id);
  }, [store, session.id]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const anchor = historyAnchor.current;
    if (anchor && view?.items[0]?.id !== anchor.firstId) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      historyAnchor.current = null;
    } else if (following.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    }
  }, [view?.items, view?.permissions, session.asyncQuestions]);
  useEffect(() => {
    try {
      saveLocal(draftKey, draft);
    } catch {
      /* A full store must never prevent writing or sending. */
    }
  }, [draftKey, draft]);
  useEffect(() => {
    setChoice(0);
  }, [query]);
  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draft, panel]);
  function addFiles(incoming: File[]) {
    const rejected = incoming.filter(
      (file) => file.size > 30_000_000 || file.name.length > 255,
    );
    setAttachmentError(
      rejected.length
        ? `未添加 ${rejected.map((file) => `「${file.name}」`).join("、")}。单个附件不能超过 30 MB，文件名不能超过 255 个字符。`
        : undefined,
    );
    setFiles((previous) => {
      const accepted = incoming.filter((file) => !rejected.includes(file));
      return [
        ...previous,
        ...accepted.filter(
          (file, index) =>
            ![...previous, ...accepted.slice(0, index)].some(
              (entry) =>
                entry.name === file.name &&
                entry.size === file.size &&
                entry.lastModified === file.lastModified,
            ),
        ),
      ];
    });
  }
  async function execute(text: string): Promise<boolean> {
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
  async function choose(command: Command) {
    if (!(await setPanel(null))) return;
    if (command.action) {
      const executed = await job.run(() => execute(`/${command.name}`));
      if (executed) setDraft("");
    } else {
      setDraft(`/${command.name} `);
      composer.current?.focus();
    }
  }
  async function send(now = false) {
    setSendingFile(undefined);
    const text = normalizeCommandText(draftRef.current).trim();
    if (!online || (!text && !files.length && !blocks.length)) return;
    if (!files.length && !blocks.length && (await execute(text))) {
      if (draftRef.current === draft) setDraft("");
      return;
    }
    const content: ContentBlock[] = [...blocks];
    if (text) content.unshift({ type: "text", text });
    for (const file of files) {
      setSendingFile(file.name);
      const data = await fileBase64(file);
      if (
        /^image\/(png|jpe?g|webp|gif)$/.test(file.type) &&
        agent?.capabilities.images
      )
        content.push({ type: "image", mimeType: file.type, data });
      else if (
        /^audio\//.test(file.type) &&
        agent?.capabilities.audio &&
        file.size <= 5 * 1024 * 1024
      )
        content.push({ type: "audio", mimeType: file.type, data });
      else if (
        agent?.capabilities.embeddedContext &&
        file.size <= 5 * 1024 * 1024
      )
        content.push({
          type: "resource",
          resource: {
            uri: `attachment:${encodeURIComponent(file.name)}`,
            mimeType: file.type || "application/octet-stream",
            ...(/^text\//.test(file.type) || file.type === "application/json"
              ? { text: await file.text() }
              : { blob: data }),
          },
        });
      else {
        const result = await link.call(
          "fs.upload",
          { dir: session.cwd, name: file.name, data },
          180000,
        );
        content.push({
          type: "resource_link",
          uri: result.path,
          name: file.name,
        });
      }
    }
    setSendingFile(undefined);
    const parsed = parseCommand(text);
    const immediate =
      now ||
      (session.agent === "codex" &&
        !!parsed &&
        ["mcp", "apps", "status", "ps", "stop", "goal"].includes(parsed.name));
    const result = await actions.send(session.id, content, { now: immediate });
    if (result === "failed")
      throw new Error("发送失败，消息可在会话中重试；输入已保留");
    if (draftRef.current.trim() === draft.trim()) setDraft("");
    setFiles((current) => current.filter((file) => !files.includes(file)));
    setBlocks((current) => current.filter((block) => !blocks.includes(block)));
    setAttachmentError(undefined);
    composer.current?.focus();
    following.current = true;
    setAwayFromBottom(false);
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "instant",
    });
  }
  async function nativePanel(name: "mcp" | "apps") {
    if (!(await setPanel(name))) return;
    void job.run(async () => {
      const result = await actions.send(
        session.id,
        [{ type: "text", text: `/${name}` }],
        { now: true },
      );
      if (result === "failed") throw new Error(`/${name} 执行失败`);
    });
  }
  return (
    <TimelineNavigation.Provider value={{ cwd: session.cwd, open: handleFile }}>
      <div className="session-page live-session">
        <div className="session-heading">
          <div>
            <div className="session-title">
              <h1 title={titleOf(session)}>{titleOf(session)}</h1>
              <Badge state={session.state} />
            </div>
            <div className="session-subtitle">
              <AgentMark agent={session.agent} />
              <span>{session.agent}</span>
              <span className="separator">/</span>
              <span title={session.cwd}>{session.cwd}</span>
              {session.worktree && (
                <span className="branch-chip">{session.worktree.branch}</span>
              )}
            </div>
          </div>
          <div className="session-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label="会话命令"
              onClick={() => setPanel("commands")}
            >
              <Icon name="terminal" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="会话设置"
              onClick={() => setPanel("settings")}
            >
              <Icon name="settings" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="会话操作">
                  •••
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setPanel("changes")}>
                    文件变更
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void changeFile()}>
                    项目文件
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPanel("tasks")}>
                    后台任务与子 Agent
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPanel("preview")}>
                    电脑操作预览
                  </DropdownMenuItem>
                  {commands.some((command) => command.name === "goal") && (
                    <DropdownMenuItem onSelect={() => setPanel("goal")}>
                      持续目标
                    </DropdownMenuItem>
                  )}
                  {commands.some((command) => command.name === "mcp") && (
                    <DropdownMenuItem onSelect={() => nativePanel("mcp")}>
                      MCP 服务
                    </DropdownMenuItem>
                  )}
                  {commands.some((command) => command.name === "apps") && (
                    <DropdownMenuItem onSelect={() => nativePanel("apps")}>
                      应用与连接器
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setTerminals(true)}>
                    终端
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setForkAt(null)}>
                    分叉会话
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => void job.run(() => execute("/rename"))}
                  >
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void job.run(() =>
                        actions.archive(session.id, !session.archived),
                      )
                    }
                  >
                    {session.archived ? "取消归档" : "归档"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={session.state === "running"}
                    onSelect={() =>
                      void job.run(async () => {
                        let worktree: "keep" | "remove" | undefined;
                        if (session.worktree) {
                          const entries = await actions.listWorktrees();
                          const entry = entries.find((entry) =>
                            entry.sessions.includes(session.id),
                          );
                          if (
                            entry &&
                            entry.sessions.length === 1 &&
                            (entry.dirty || entry.ahead > 0)
                          ) {
                            const choice = await dialogs.choose(
                              `删除「${titleOf(session)}」？worktree 还有${entry.ahead ? ` ${entry.ahead} 个新提交` : ""}${entry.dirty ? " 未提交改动" : ""}。Agent 原始会话记录也会删除。`,
                              [
                                { value: "keep", label: "保留 worktree" },
                                {
                                  value: "remove",
                                  label: "一起删除改动与分支",
                                  destructive: true,
                                },
                              ],
                            );
                            if (!choice) return;
                            worktree = choice as "keep" | "remove";
                          } else if (
                            !(await dialogs.confirm(
                              `永久删除「${titleOf(session)}」？Agent 原始会话记录和此会话独占的干净 worktree 会一起删除。`,
                            ))
                          )
                            return;
                        } else if (
                          !(await dialogs.confirm(
                            `永久删除「${titleOf(session)}」？Agent 原始会话记录也可能被删除。`,
                          ))
                        )
                          return;
                        await actions.deleteSession(session.id, worktree);
                        navigate("home");
                      })
                    }
                  >
                    删除会话
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {agent?.tier === "handoff" && (
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
              disabled={!online || job.busy}
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
        <div
          className={`session-layout ${panel && panel !== "commands" ? "with-panel" : ""}`}
        >
          <div className="conversation-column">
            <div
              className="conversation"
              ref={scroll}
              onLoadCapture={() => {
                if (following.current && scroll.current)
                  scroll.current.scrollTo({
                    top: scroll.current.scrollHeight,
                    behavior: "instant",
                  });
              }}
              onScroll={() => {
                const node = scroll.current;
                following.current =
                  !!node &&
                  node.scrollHeight - node.scrollTop - node.clientHeight < 100;
                setAwayFromBottom(!following.current);
              }}
            >
              {!ready && (
                <div className="conversation-loading">
                  <LoadState loading />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!online}
                    onClick={() => {
                      actions.closeSession(session.id);
                      actions.openSession(session.id);
                    }}
                  >
                    重新加载会话
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
              {view && view.startSeq > 0 && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={!online || loadingEarlier}
                  onClick={() =>
                    void job.run(async () => {
                      const element = scroll.current;
                      if (element)
                        historyAnchor.current = {
                          height: element.scrollHeight,
                          top: element.scrollTop,
                          firstId: view.items[0]?.id,
                        };
                      try {
                        if (!(await actions.loadEarlier(session.id)))
                          historyAnchor.current = null;
                      } catch (error) {
                        historyAnchor.current = null;
                        throw error;
                      }
                    })
                  }
                >
                  {loadingEarlier ? "正在加载历史…" : "加载更早的历史"}
                </Button>
              )}
              {view && (
                <Timeline
                  items={view.items}
                  sessionId={session.id}
                  agent={session.agent}
                  showAsyncQuestions={session.asyncQuestions === undefined}
                  onFile={handleFile}
                  onFork={setForkAt}
                  onTerminal={(id) => {
                    setTerminal(id);
                    setTerminals(true);
                  }}
                />
              )}
              <AsyncQuestions
                sessionId={session.id}
                questions={session.asyncQuestions ?? []}
              />
              {view?.permissions.map((permission) => (
                <Permission
                  key={permission.requestId}
                  permission={permission}
                  sessionId={session.id}
                />
              ))}
              <AgentInteractions agent={session.agent} />
              {view?.turnActive && (
                <div className="conversation-activity" role="status">
                  <LoaderCircle aria-hidden="true" />
                  <span>
                    {view.permissions.length
                      ? "等待你确认后继续"
                      : session.asyncQuestions?.length
                        ? "Agent 有问题需要你回答"
                        : "Agent 正在处理任务"}
                  </span>
                </div>
              )}
              {notices?.map((notice) => (
                <section
                  key={notice.id}
                  className={`notice-card ${notice.severity === "error" ? "error" : ""}`}
                  role="status"
                >
                  <div className="browser-toolbar">
                    <strong>{notice.title}</strong>
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
            </div>
            {terminal && !terminals && (
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
            <div className="composer-wrap">
              {awayFromBottom && (
                <div className="conversation-jump">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      following.current = true;
                      setAwayFromBottom(false);
                      scroll.current?.scrollTo({
                        top: scroll.current.scrollHeight,
                        behavior: "instant",
                      });
                    }}
                  >
                    <ArrowDown data-icon="inline-start" />
                    回到最新消息
                  </Button>
                </div>
              )}
              <ErrorNotice error={job.error} />
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
                        disabled={job.busy || !online || item.pending}
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
                        disabled={job.busy || !online || item.pending}
                        onClick={() =>
                          void job.run(async () => {
                            if (
                              (draft.trim() || files.length || blocks.length) &&
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
                              setDraft(
                                content
                                  .filter((block) => block.type === "text")
                                  .map((block) => block.text)
                                  .join("\n"),
                              );
                              setBlocks(
                                content.filter(
                                  (block) => block.type !== "text",
                                ),
                              );
                              setFiles([]);
                              composer.current?.focus();
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
                          !online ||
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
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="plain"
                        disabled={job.busy || !online || item.pending}
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
              <Popover
                open={query !== undefined}
                onOpenChange={(open) => {
                  if (!open) setDismissedSuggestions(draft);
                }}
              >
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  aria-label="命令建议"
                  className="w-(--radix-popover-trigger-width) max-h-(--radix-popover-content-available-height) overflow-hidden p-0"
                  onOpenAutoFocus={(event) => event.preventDefault()}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  onInteractOutside={(event) => {
                    if (event.target === composer.current)
                      event.preventDefault();
                  }}
                >
                  <CommandUI
                    className="h-auto"
                    shouldFilter={false}
                    value={suggestions[choice]?.name ?? ""}
                    onValueChange={(value) => {
                      const index = suggestions.findIndex(
                        (command) => command.name === value,
                      );
                      if (index >= 0) setChoice(index);
                    }}
                  >
                    <CommandList
                      aria-label="命令建议"
                      className="max-h-[min(18rem,35dvh,var(--radix-popover-content-available-height))]"
                    >
                      <CommandEmpty>
                        没有匹配项，可打开命令面板查看全部。
                      </CommandEmpty>
                      <CommandGroup>
                        {suggestions.map((command) => (
                          <CommandItem
                            key={command.name}
                            value={command.name}
                            onMouseDown={(event) => event.preventDefault()}
                            onSelect={() => choose(command)}
                          >
                            <strong>/{command.name}</strong>
                            <span className="text-muted-foreground">
                              {command.description}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </CommandUI>
                </PopoverContent>
                <PopoverAnchor asChild>
                  <InputGroup
                    className="composer"
                    data-dragging={dragging || undefined}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null,
                        )
                      )
                        setDragging(false);
                    }}
                    onDrop={(event) => {
                      if (!event.dataTransfer.files.length) return;
                      event.preventDefault();
                      setDragging(false);
                      addFiles(Array.from(event.dataTransfer.files));
                    }}
                  >
                    {dragging && (
                      <div className="composer-drop-hint">
                        <Plus aria-hidden="true" />
                        松开以添加附件
                      </div>
                    )}
                    <div className="attachment-list">
                      {files.map((file, index) => (
                        <span key={`${file.name}-${index}`}>
                          <Paperclip aria-hidden="true" />
                          <span className="attachment-name" title={file.name}>
                            {file.name}
                          </span>
                          <small>
                            {file.size < 1_000_000
                              ? `${Math.max(1, Math.round(file.size / 1000))} KB`
                              : `${(file.size / 1_000_000).toFixed(1)} MB`}
                          </small>
                          <Button
                            variant="ghost"
                            size="plain"
                            aria-label={`移除附件 ${file.name}`}
                            disabled={sendJob.busy}
                            onClick={() =>
                              setFiles((previous) =>
                                previous.filter((_, at) => at !== index),
                              )
                            }
                          >
                            <X />
                          </Button>
                        </span>
                      ))}
                      {blocks.length > 0 && (
                        <span>
                          {blocks.length} 个已有附件
                          <Button
                            variant="ghost"
                            size="plain"
                            aria-label="移除已有附件"
                            disabled={sendJob.busy}
                            onClick={() => setBlocks([])}
                          >
                            <X />
                          </Button>
                        </span>
                      )}
                    </div>
                    <InputGroupTextarea
                      ref={composer}
                      aria-label="消息"
                      aria-describedby="composer-hint"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={
                        online
                          ? "发送消息，输入 / 选择命令或技能…"
                          : "连接已断开，可以继续编辑草稿…"
                      }
                      rows={2}
                      onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files);
                        if (files.length) {
                          event.preventDefault();
                          addFiles(files);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.nativeEvent.isComposing ||
                          event.nativeEvent.keyCode === 229
                        )
                          return;
                        if (event.key === "Escape" && query !== undefined) {
                          event.preventDefault();
                          setDismissedSuggestions(draft);
                          return;
                        }
                        if (
                          suggestions.length &&
                          ["ArrowDown", "ArrowUp"].includes(event.key)
                        ) {
                          event.preventDefault();
                          setChoice(
                            (value) =>
                              (value +
                                (event.key === "ArrowDown"
                                  ? 1
                                  : suggestions.length - 1)) %
                              suggestions.length,
                          );
                        } else if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          if (suggestions.length)
                            void choose(suggestions[choice] ?? suggestions[0]);
                          else
                            void sendJob.run(() =>
                              send(event.metaKey || event.ctrlKey),
                            );
                        }
                      }}
                    />
                    <InputGroupAddon
                      align="block-end"
                      className="composer-toolbar justify-between"
                    >
                      <div>
                        <Input
                          ref={upload}
                          type="file"
                          multiple
                          hidden
                          onChange={(event) => {
                            addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="添加附件"
                          title="添加附件 · 单个文件最多 30 MB"
                          onClick={() => upload.current?.click()}
                        >
                          <Icon name="attach" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="打开命令面板"
                          onClick={() => setPanel("commands")}
                        >
                          /
                        </Button>
                        <Button
                          variant="ghost"
                          size="plain"
                          className="composer-agent"
                          title={session.model ?? "模型与权限"}
                          onClick={() => setPanel("settings")}
                        >
                          {session.model ?? "模型与权限"}
                        </Button>
                        {view?.usage?.contextWindow && (
                          <span className="context-meter" title="上下文用量">
                            {Math.round(
                              ((view.usage.usedTokens ?? 0) /
                                view.usage.contextWindow) *
                                100,
                            )}
                            %
                          </span>
                        )}
                      </div>
                      <div>
                        {(view?.turnActive || session.state === "unknown") &&
                          agent?.capabilities.interrupt && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="停止当前回合"
                              disabled={!online || job.busy}
                              onClick={() =>
                                void job.run(() => actions.cancel(session.id))
                              }
                            >
                              <Icon name="stop" />
                            </Button>
                          )}
                        {view?.turnActive && agent?.capabilities.steer && (
                          <Button
                            variant="link"
                            size="sm"
                            disabled={!online || sendJob.busy || !draft.trim()}
                            onClick={() => void sendJob.run(() => send(true))}
                          >
                            插话
                          </Button>
                        )}
                        <Button
                          variant="default"
                          size="icon"
                          className="send-button"
                          aria-label={
                            view?.turnActive ? "加入发送队列" : "发送消息"
                          }
                          disabled={
                            !online ||
                            sendJob.busy ||
                            (!draft.trim() && !files.length && !blocks.length)
                          }
                          onClick={() => void sendJob.run(() => send())}
                        >
                          {sendJob.busy ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <Icon name="send" />
                          )}
                        </Button>
                      </div>
                    </InputGroupAddon>
                  </InputGroup>
                </PopoverAnchor>
              </Popover>
              <div className="composer-caption" id="composer-hint">
                <span>
                  {view?.turnActive
                    ? "Enter 加入队列 · ⌘/Ctrl Enter 立即发送"
                    : "Enter 发送 · Shift Enter 换行 · / 命令"}
                </span>
                <span>{online ? "端到端加密" : "草稿已保留"}</span>
              </div>
            </div>
          </div>
          {panel && panel !== "commands" && (
            <ConversationPanel
              close={() => setPanel(null)}
              title={
                {
                  settings: "会话设置",
                  changes: "变更",
                  files: "文件",
                  tasks: "任务",
                  goal: "目标",
                  mcp: "MCP 服务",
                  apps: "应用",
                  preview: "电脑操作预览",
                }[panel]
              }
            >
              <div className="side-panel-content">
                {panel === "settings" && (
                  <Settings session={session} view={view} />
                )}
                {panel === "changes" && <Changes view={view} />}
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
                    onTerminal={setTerminal}
                  />
                )}
                {panel === "goal" && <Goal session={session} view={view} />}
                {panel === "preview" && (
                  <ComputerPreview sessionId={session.id} />
                )}
                {(panel === "mcp" || panel === "apps") && (
                  <>
                    <p className="muted">
                      由电脑上的 {session.agent}{" "}
                      提供。完整结果、授权请求和错误同时显示在会话中。
                    </p>
                    <Button
                      variant="outline"
                      disabled={!online || job.busy}
                      onClick={() => nativePanel(panel)}
                    >
                      刷新 /{panel}
                    </Button>
                    {view?.items
                      .filter(
                        (item) =>
                          item.kind === "notice" && item.title === `/${panel}`,
                      )
                      .slice(-1)
                      .map(
                        (item) =>
                          item.kind === "notice" && (
                            <pre className="service-status" key={item.id}>
                              {item.detail ?? "当前没有记录"}
                            </pre>
                          ),
                      )}
                  </>
                )}
              </div>
            </ConversationPanel>
          )}
        </div>
        {panel === "commands" && (
          <Commands
            returnFocus={() => composer.current?.focus()}
            commands={commands}
            close={() => setPanel(null)}
            choose={choose}
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
              disabled={job.busy || !online}
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
  );
}

function ConversationPanel({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const compact = useIsMobile(991);
  const panelElement = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (compact) return;
    const element = panelElement.current;
    const previous = document.activeElement;
    (element?.querySelector("button") ?? element)?.focus({
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
      <div className="browser-toolbar">
        <strong>{title}</strong>
        {closeButton}
      </div>
      {children}
    </aside>
  );
}
