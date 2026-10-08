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
import { useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
  titleOf,
  useActions,
  useClient,
  useConnection,
  useJob,
} from "./common";
import { Permission } from "./Permission";
import { Timeline, TimelineNavigation } from "./Timeline";
import { FileView, Files, fileBase64 } from "./Files";
import { Changes, Commands, Goal, Settings, Tasks } from "./Panels";
import { Terminal, Terminals } from "./Terminal";
import { readLocal, saveLocal } from "./storage";
import { ComputerPreview } from "./Video";

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
  const view = useClient((state) => state.views[session.id]);
  const ready = useClient((state) => state.ready[session.id]);
  const online = useClient((state) => state.status === "online");
  const loadingEarlier = useClient((state) => state.loadingEarlier[session.id]);
  const agent = useClient((state) =>
    state.machine?.agents.find((agent) => agent.id === session.agent),
  );
  const queueing = useClient((state) => state.queueing[session.id]);
  const commands = useMemo(
    () =>
      sessionCommands(session.agent, view?.commands ?? [], view?.config ?? []),
    [session.agent, view?.commands, view?.config],
  );
  const draftKey = `draft.${connection.computer.key}.${session.id}`;
  const [draft, setDraft] = useState(() => readLocal(draftKey, ""));
  const [files, setFiles] = useState<File[]>([]);
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [file, setFile] = useState<string>();
  const [fileLine, setFileLine] = useState<number>();
  const [terminal, setTerminal] = useState<string>();
  const [terminals, setTerminals] = useState(false);
  const [choice, setChoice] = useState(0);
  const [forkAt, setForkAt] = useState<string | null>();
  const [newWorktree, setNewWorktree] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string>();
  const query =
    dismissedSuggestions === draft ? undefined : commandQuery(draft);
  const suggestions =
    query === undefined ? [] : matchCommands(commands, query).slice(0, 10);
  const queue = shownQueue(session.queue, queueing);
  const handleFile = (path: string, line?: number) => {
    setFile(path);
    setFileLine(line);
    setPanel("files");
  };
  useEffect(
    () =>
      link.on("session.preview.show", (event) => {
        if (event.sessionId === session.id) setPanel("preview");
      }),
    [link, session.id],
  );
  useEffect(() => {
    store.getState().openSession(session.id);
    return () => store.getState().closeSession(session.id);
  }, [store, session.id]);
  useEffect(() => {
    const element = scroll.current;
    if (following.current && element)
      element.scrollTo({ top: element.scrollHeight });
  }, [view?.items, view?.permissions]);
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
  async function execute(text: string): Promise<boolean> {
    const parsed = parseCommand(text);
    const command =
      parsed && commands.find((item) => item.name === parsed.name);
    if (!parsed || !command?.action) return false;
    const args = parsed.args;
    switch (command.action) {
      case "commands":
        setPanel("commands");
        break;
      case "tasks":
        setPanel("tasks");
        break;
      case "changes":
        setPanel("changes");
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
        setPanel("goal");
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
        else if (!args || !option) setPanel("settings");
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
  function choose(command: Command) {
    setPanel(null);
    if (command.action) {
      void job.run(() => execute(`/${command.name}`));
      setDraft("");
    } else {
      setDraft(`/${command.name} `);
      composer.current?.focus();
    }
  }
  async function send(now = false) {
    const text = normalizeCommandText(draftRef.current).trim();
    if (!online || (!text && !files.length && !blocks.length)) return;
    if (!files.length && !blocks.length && (await execute(text))) {
      if (draftRef.current === draft) setDraft("");
      return;
    }
    const content: ContentBlock[] = [...blocks];
    if (text) content.unshift({ type: "text", text });
    for (const file of files) {
      const data = await fileBase64(file);
      if (
        /^image\/(png|jpe?g|webp|gif)$/.test(file.type) &&
        agent?.capabilities.images
      )
        content.push({ type: "image", mimeType: file.type, data });
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
    following.current = true;
  }
  function nativePanel(name: "mcp" | "apps") {
    setPanel(name);
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
              <h1>{titleOf(session)}</h1>
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
            <button
              className="icon-button"
              aria-label="会话命令"
              onClick={() => setPanel("commands")}
            >
              <Icon name="terminal" />
            </button>
            <button
              className="icon-button"
              aria-label="会话设置"
              onClick={() => setPanel("settings")}
            >
              <Icon name="settings" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="icon-button" aria-label="会话操作">
                  •••
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setPanel("changes")}>
                    文件变更
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setFile(undefined);
                      setPanel("files");
                    }}
                  >
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
            <button
              className="text-button"
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
            </button>
          </div>
        )}
        <div
          className={`session-layout ${panel && panel !== "commands" ? "with-panel" : ""}`}
        >
          <div className="conversation-column">
            <div
              className="conversation"
              ref={scroll}
              onScroll={() => {
                const node = scroll.current;
                following.current =
                  !!node &&
                  node.scrollHeight - node.scrollTop - node.clientHeight < 100;
              }}
            >
              {!ready && <p className="muted">正在加载会话…</p>}
              {view && view.startSeq > 0 && (
                <button
                  className="text-button"
                  disabled={loadingEarlier}
                  onClick={() =>
                    void job.run(() => actions.loadEarlier(session.id))
                  }
                >
                  加载更早的历史
                </button>
              )}
              {view && (
                <Timeline
                  items={view.items}
                  sessionId={session.id}
                  agent={session.agent}
                  onFile={handleFile}
                  onFork={setForkAt}
                  onTerminal={(id) => {
                    setTerminal(id);
                    setTerminals(true);
                  }}
                />
              )}
              {view?.permissions.map((permission) => (
                <Permission
                  key={permission.requestId}
                  permission={permission}
                  sessionId={session.id}
                />
              ))}
            </div>
            {terminal && !terminals && (
              <div className="inline-terminal">
                <div className="browser-toolbar">
                  <span>终端</span>
                  <button
                    className="text-button"
                    onClick={() => setTerminal(undefined)}
                  >
                    收起
                  </button>
                </div>
                <Terminal key={terminal} id={terminal} />
              </div>
            )}
            <div className="composer-wrap">
              <ErrorNotice error={job.error} />
              {queue.length > 0 && (
                <div className="message-queue">
                  <strong>待发送 · {queue.length}</strong>
                  {queue.map((item, index) => (
                    <div key={item.clientMessageId}>
                      <span>{item.text || `${item.images} 张图片`}</span>
                      <button
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
                      </button>
                      <button
                        disabled={job.busy || !online || item.pending}
                        onClick={() =>
                          void job.run(async () => {
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
                            }
                          })
                        }
                      >
                        编辑
                      </button>
                      <button
                        aria-label="上移队列消息"
                        disabled={!index || job.busy || !online || item.pending}
                        onClick={() =>
                          void job.run(() => {
                            const ids = queue
                              .filter((item) => !item.pending)
                              .map((item) => item.clientMessageId);
                            [ids[index - 1], ids[index]] = [
                              ids[index],
                              ids[index - 1],
                            ];
                            return actions.reorderQueue(session.id, ids);
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        disabled={job.busy || !online || item.pending}
                        onClick={() =>
                          void job.run(() =>
                            actions.unqueue(session.id, item.clientMessageId),
                          )
                        }
                      >
                        移除
                      </button>
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
                  <div
                    className="composer"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      setFiles((previous) => [
                        ...previous,
                        ...Array.from(event.dataTransfer.files),
                      ]);
                    }}
                  >
                    <div className="attachment-list">
                      {files.map((file, index) => (
                        <span key={`${file.name}-${index}`}>
                          {file.name}
                          <button
                            aria-label={`移除附件 ${file.name}`}
                            onClick={() =>
                              setFiles((previous) =>
                                previous.filter((_, at) => at !== index),
                              )
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {blocks.length > 0 && (
                        <span>
                          {blocks.length} 个已有附件
                          <button onClick={() => setBlocks([])}>×</button>
                        </span>
                      )}
                    </div>
                    <textarea
                      ref={composer}
                      aria-label="消息"
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
                          setFiles((previous) => [...previous, ...files]);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
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
                            choose(suggestions[choice] ?? suggestions[0]);
                          else
                            void job.run(() =>
                              send(event.metaKey || event.ctrlKey),
                            );
                        }
                      }}
                    />
                    <div className="composer-toolbar">
                      <div>
                        <input
                          ref={upload}
                          type="file"
                          multiple
                          hidden
                          onChange={(event) => {
                            setFiles((previous) => [
                              ...previous,
                              ...Array.from(event.target.files ?? []),
                            ]);
                            event.target.value = "";
                          }}
                        />
                        <button
                          className="icon-button"
                          aria-label="添加附件"
                          onClick={() => upload.current?.click()}
                        >
                          <Icon name="attach" />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="打开命令面板"
                          onClick={() => setPanel("commands")}
                        >
                          /
                        </button>
                        <button
                          className="composer-agent"
                          onClick={() => setPanel("settings")}
                        >
                          {session.model ?? "模型与权限"}
                        </button>
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
                        {view?.turnActive && agent?.capabilities.interrupt && (
                          <button
                            className="icon-button"
                            aria-label="停止当前回合"
                            disabled={!online || job.busy}
                            onClick={() =>
                              void job.run(() => actions.cancel(session.id))
                            }
                          >
                            <Icon name="stop" />
                          </button>
                        )}
                        {view?.turnActive && agent?.capabilities.steer && (
                          <button
                            className="text-button"
                            disabled={!online || job.busy || !draft.trim()}
                            onClick={() => void job.run(() => send(true))}
                          >
                            插话
                          </button>
                        )}
                        <button
                          className="send-button"
                          aria-label={
                            view?.turnActive ? "加入发送队列" : "发送消息"
                          }
                          disabled={
                            !online ||
                            job.busy ||
                            (!draft.trim() && !files.length && !blocks.length)
                          }
                          onClick={() => void job.run(() => send())}
                        >
                          <Icon name="send" />
                        </button>
                      </div>
                    </div>
                  </div>
                </PopoverAnchor>
              </Popover>
              <div className="composer-caption">
                <span>Enter 发送 · Shift Enter 换行 · / 命令</span>
                <span>{online ? "端到端加密" : "草稿已保留"}</span>
              </div>
            </div>
          </div>
          {panel && panel !== "commands" && (
            <aside className="live-side-panel">
              <div className="browser-toolbar">
                <strong>
                  {
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
                </strong>
                <button
                  className="icon-button"
                  aria-label="关闭面板"
                  onClick={() => setPanel(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="side-panel-content">
                {panel === "settings" && (
                  <Settings session={session} view={view} />
                )}
                {panel === "changes" && <Changes view={view} />}
                {panel === "files" &&
                  (file ? (
                    <>
                      <button
                        className="text-button"
                        onClick={() => setFile(undefined)}
                      >
                        返回文件列表
                      </button>
                      <FileView key={file} line={fileLine} path={file} />
                    </>
                  ) : (
                    <Files start={session.cwd} />
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
                    <button
                      className="button secondary"
                      disabled={!online || job.busy}
                      onClick={() => nativePanel(panel)}
                    >
                      刷新 /{panel}
                    </button>
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
            </aside>
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
            <label className="choice-option">
              <input
                type="checkbox"
                checked={newWorktree}
                onChange={(event) => setNewWorktree(event.target.checked)}
              />
              在新的 worktree 中工作
            </label>
            <ErrorNotice error={job.error} />
            <button
              className="button primary"
              disabled={job.busy || !online}
              onClick={() =>
                void job.run(async () => {
                  const created = await actions.forkSession(session.id, {
                    itemId: forkAt ?? undefined,
                    worktree: newWorktree,
                  });
                  setForkAt(undefined);
                  navigate(created.id);
                })
              }
            >
              创建分叉
            </button>
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
