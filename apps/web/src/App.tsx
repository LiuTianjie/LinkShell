import { sessionGroup, sessionNeedsAttention } from "./live/session-list";
import { sessionTime } from "./live/session-time";
import { Badge as StatusBadge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, X, Plus, FolderOpen, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deployment } from "./config";
import { useDialogs } from "@/components/Dialogs";
import { Choice } from "./components/Choice";
import { lazy, Suspense, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import appMark from "../../client/assets/mark.png";
import { Icon } from "./icons";
import { engine } from "./live/engine";
import { Connect } from "./live/Connect";
import {
  AgentMark,
  Badge,
  EmptyState,
  ErrorNotice,
  LoadState,
  Modal,
  Runtime,
  baseName,
  titleOf,
  useActions,
  useClient,
  useConnection,
  useJob,
  useLoad,
} from "./live/common";
import { Session } from "./live/Session";
import { Permission } from "./live/Permission";
import { AcpManager, AgentInteractions } from "./live/Acp";
import { Files } from "./live/Files";
import { Terminals } from "./live/Terminal";
import { Worktrees } from "./live/Panels";
import { Screens } from "./live/Screens";
import { Ports } from "./live/Ports";
import { ConsoleShell } from "./components/ConsoleShell";
import { readLocal, saveLocal } from "./live/storage";
import type { Computer } from "./live/engine";
import { useNavigationGuard } from "./live/use-navigation-guard";
import { SessionLookup } from "./live/SessionLookup";
import { Projects } from "./live/Projects";
import "./live/live.css";
import "./live/workspace-polish.css";

const Prototype = lazy(() =>
  import("./Prototype").then((module) => ({ default: module.Prototype })),
);
export function App() {
  if (new URLSearchParams(location.search).get("demo") === "1")
    return (
      <Suspense fallback={<p>加载原型…</p>}>
        <Prototype />
      </Suspense>
    );
  return <LiveApp />;
}
function LiveApp() {
  const state = useStore(engine.state);
  const guard = useNavigationGuard();
  const [connect, setConnect] = useState(false);
  const [view, setView] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("view") ??
      readLocal("lastView", "home"),
  );
  useEffect(() => {
    void engine.start();
  }, []);
  useEffect(() => {
    const change = () => {
      const next =
        new URLSearchParams(location.hash.slice(1)).get("view") ?? "home";
      if (next === view) return;
      // Keep the editor mounted while the user decides whether to leave.
      history.replaceState(null, "", `#${new URLSearchParams({ view })}`);
      void guard(() => {
        history.replaceState(
          null,
          "",
          `#${new URLSearchParams({ view: next })}`,
        );
        saveLocal("lastView", next);
        setView(next);
      });
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [view, guard]);
  function commitView(id: string) {
    saveLocal("lastView", id);
    history.pushState(null, "", `#${new URLSearchParams({ view: id })}`);
    setView(id);
  }
  function navigate(id: string) {
    if (id !== view) void guard(() => commitView(id));
  }
  function selectComputer(computer: Computer) {
    if (computer.key === state.connection?.computer.key) return;
    void guard(() => {
      engine.select(computer);
      if (view !== "screen") commitView("home");
    });
  }
  const openConnect = () => void guard(() => setConnect(true));
  return (
    <ConsoleShell
      view={view}
      navigate={navigate}
      connect={openConnect}
      selectComputer={selectComputer}
    >
      {state.error && (
        <div className="connection-banner" role="alert">
          <span>{state.error}</span>
          <Button
            variant="ghost"
            size="plain"
            onClick={() => {
              engine.state.setState({ error: undefined });
              engine.reconnect();
            }}
          >
            重试
          </Button>
          <Button
            variant="ghost"
            size="plain"
            onClick={() => engine.state.setState({ error: undefined })}
          >
            关闭
          </Button>
        </div>
      )}
      {state.locked ? (
        <div className="welcome-live">
          <h1>工作台已在另一个标签页打开</h1>
          <p className="muted">
            同一个浏览器设备只保持一条连接，避免标签页相互挤掉。
          </p>
          <Button variant="default" onClick={() => void engine.claim()}>
            在此标签页继续
          </Button>
        </div>
      ) : view === "screen" ? (
        <Screens connect={() => setConnect(true)} />
      ) : state.connection ? (
        <Runtime value={state.connection}>
          <Workspace
            key={state.connection.computer.key}
            view={view}
            navigate={navigate}
            connect={openConnect}
            selectComputer={selectComputer}
          />
        </Runtime>
      ) : (
        <div className="welcome-live">
          <img src={appMark} alt="LinkShell" />
          <h1>连接你的电脑</h1>
          <p className="muted">
            会话在电脑上运行，网页让你继续对话、审批和操作。
          </p>
          <pre>npm i -g linkshell-cli{"\n"}linkshell host --daemon</pre>
          <Button
            variant="default"
            disabled={!state.ready}
            onClick={() => setConnect(true)}
          >
            {state.ready
              ? deployment === "self-hosted"
                ? "配对电脑"
                : "登录或配对电脑"
              : "正在准备设备身份…"}
          </Button>
          <p className="muted">
            {deployment === "self-hosted"
              ? "运行 linkshell pair，输入此网关的配对码即可连接。"
              : "官方服务使用 iTool 账号，自托管使用自己的网关与配对码。"}
          </p>
          {state.computers.map((computer) => (
            <Button
              variant="outline"
              key={computer.key}
              onClick={() => engine.select(computer)}
            >
              {computer.machine.name} ·{" "}
              {computer.machine.online ? "在线" : "离线"}
            </Button>
          ))}
          <a className="text-button" href="?demo=1">
            查看独立 UI 演示
          </a>
        </div>
      )}
      {connect && <Connect close={() => setConnect(false)} />}
    </ConsoleShell>
  );
}
function Workspace({
  view,
  navigate,
  connect,
  selectComputer,
}: {
  view: string;
  navigate: (id: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
}) {
  const state = useClient((state) => state);
  const [create, setCreate] = useState<string | null>();
  const [terminal, setTerminal] = useState<string>();
  const session = state.sessions[view];
  return (
    <>
      {state.status !== "online" && (
        <div className="connection-banner" role="status">
          <span>{state.statusDetail ?? "正在连接电脑…"}</span>
          <Button
            variant="ghost"
            size="plain"
            onClick={() => engine.reconnect()}
          >
            重新连接
          </Button>
        </div>
      )}
      {session ? (
        <Session key={session.id} session={session} navigate={navigate} />
      ) : (
        <div className="overview live-overview">
          {["home", "archive"].includes(view) && (
            <Home
              key={view}
              archived={view === "archive"}
              navigate={navigate}
              create={() => setCreate(null)}
            />
          )}
          {view === "projects" && (
            <Projects
              create={(cwd) => setCreate(cwd ?? null)}
              navigate={navigate}
            />
          )}
          {view === "computers" && (
            <Computers connect={connect} selectComputer={selectComputer} />
          )}
          {view === "files" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>文件</h1>
                  <p className="muted">
                    浏览电脑上的文件，查看内容或继续编辑。
                  </p>
                </div>
              </div>
              <Files />
            </>
          )}
          {view === "terminals" && (
            <Terminals selected={terminal} onSelect={setTerminal} />
          )}
          {view === "worktrees" && <Worktrees />}
          {view === "ports" && <Ports />}
          {![
            "home",
            "archive",
            "projects",
            "computers",
            "files",
            "terminals",
            "worktrees",
            "ports",
            "screen",
          ].includes(view) && (
            <SessionLookup key={view} id={view} navigate={navigate} />
          )}
        </div>
      )}
      {create !== undefined && (
        <NewSession
          initialDirectory={create ?? undefined}
          close={() => setCreate(undefined)}
          created={(session) => {
            setCreate(undefined);
            navigate(session.id);
          }}
        />
      )}
    </>
  );
}
function SessionTable({
  sessions,
  navigate,
}: {
  sessions: SessionSummary[];
  navigate: (id: string) => void;
}) {
  const [permissionId, setPermissionId] = useState<string>();
  const permissionSession = sessions.find(
    (session) => session.id === permissionId && session.permission,
  );
  return (
    <>
      <Table className="session-table session-list-table">
        <TableHeader>
          <TableRow>
            <TableHead>会话</TableHead>
            <TableHead className="session-project-column">项目</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>最近更新</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow
              key={session.id}
              className="session-table-row"
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest("button, a") ||
                  window.getSelection()?.toString()
                )
                  return;
                navigate(session.id);
              }}
            >
              <TableCell>
                <div className="session-table-primary">
                  <span className="session-agent-icon" title={session.agent}>
                    <AgentMark agent={session.agent} />
                  </span>
                  <div className="session-table-name">
                    <Button
                      variant="ghost"
                      size="plain"
                      onClick={() => navigate(session.id)}
                    >
                      <span title={titleOf(session)}>{titleOf(session)}</span>
                    </Button>
                    <small>
                      {session.activity?.title ??
                        session.preview ??
                        "打开会话继续工作"}
                    </small>
                    <span className="session-table-inline-meta">
                      <span>
                        {baseName(session.worktree?.source ?? session.cwd)}
                      </span>
                      <span>·</span>
                      <time
                        dateTime={new Date(session.updatedAt).toISOString()}
                      >
                        {sessionTime(session.updatedAt)}
                      </time>
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell className="session-project-column">
                <span
                  className="session-project"
                  title={session.worktree?.source ?? session.cwd}
                >
                  <Icon name="folder" size={14} />
                  {baseName(session.worktree?.source ?? session.cwd)}
                </span>
              </TableCell>
              <TableCell>
                <div className="session-status-cell">
                  <Badge
                    state={
                      sessionNeedsAttention(session) ? "waiting" : session.state
                    }
                  />
                  {session.permission && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`处理 ${titleOf(session)}`}
                      onClick={() => setPermissionId(session.id)}
                    >
                      处理
                    </Button>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <time
                  dateTime={new Date(session.updatedAt).toISOString()}
                  title={new Date(session.updatedAt).toLocaleString()}
                >
                  {sessionTime(session.updatedAt)}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {permissionSession?.permission && (
        <Modal title="处理请求" close={() => setPermissionId(undefined)}>
          <Permission
            permission={permissionSession.permission}
            sessionId={permissionSession.id}
          />
        </Modal>
      )}
    </>
  );
}

function Home({
  archived,
  navigate,
  create,
}: {
  archived: boolean;
  navigate: (id: string) => void;
  create: () => void;
}) {
  const state = useClient((state) => state);
  const actions = useActions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("updated");
  const [, updateTime] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => updateTime((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const job = useJob();
  const { store } = useConnection();
  const archive = useLoad(async () => {
    if (archived) {
      if (state.status !== "online")
        throw new Error("连接恢复后将重新加载归档");
      await actions.loadArchived();
    }
    return true;
  }, [store, archived, state.status]);
  const loaded = archived
    ? archive.value && !archive.loading
    : state.sessionsLoaded;
  const loadError = archived ? archive.error : state.sessionsError;
  const nextBefore = archived
    ? state.archivedNextBefore
    : state.sessionsNextBefore;
  const allSessions = Object.values(state.sessions).filter(
    (session) => session.archived === archived,
  );
  const sessions = allSessions
    .filter(
      (session) =>
        session.archived === archived &&
        `${titleOf(session)} ${session.cwd} ${session.agent} ${session.preview ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()) &&
        (filter === "all" ||
          (filter === "waiting"
            ? sessionNeedsAttention(session)
            : filter === "running"
              ? sessionGroup(session) === "running"
              : !sessionNeedsAttention(session) && session.state === filter)),
    )
    .sort((a, b) =>
      sort === "title"
        ? titleOf(a).localeCompare(titleOf(b), "zh-CN")
        : sort === "created"
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt,
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{archived ? "已归档会话" : "会话概览"}</h1>
          <p className="host-summary">
            <span
              className={
                state.status === "online" ? "online-dot" : "offline-dot"
              }
            />
            <span className="host-name">
              {state.machine?.hostname ?? "正在连接"}
            </span>
            <span className="host-state">
              {allSessions.some(sessionNeedsAttention)
                ? `${allSessions.filter(sessionNeedsAttention).length} 项需要你`
                : "暂无待处理事项"}
            </span>
          </p>
        </div>
        <Button
          variant="default"
          disabled={state.status !== "online"}
          onClick={create}
        >
          <Icon name="plus" />
          新建会话
        </Button>
      </div>
      {!archived && (
        <div className="console-summary">
          {[
            {
              title: "全部会话",
              value: Object.values(state.sessions).filter(
                (session) => !session.archived,
              ).length,
              detail: "保存在当前电脑",
            },
            {
              title: "进行中",
              value: Object.values(state.sessions).filter(
                (session) =>
                  !session.archived && sessionGroup(session) === "running",
              ).length,
              detail: "Agent 正在执行",
            },
            {
              title: "需要你",
              value: Object.values(state.sessions).filter(
                (session) =>
                  !session.archived && sessionNeedsAttention(session),
              ).length,
              detail: "等待回答或批准",
            },
          ].map((item) => (
            <Card key={item.title} variant="flat" size="sm">
              <CardHeader>
                <CardDescription>{item.title}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="console-summary-value">
                  <strong>{item.value}</strong>
                  <span>{item.detail}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <div className="home-controls">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList variant="line" aria-label="筛选会话">
            {[
              { id: "all", name: "全部会话" },
              { id: "running", name: "进行中" },
              { id: "waiting", name: "需要你" },
              { id: "idle", name: "已完成" },
              { id: "error", name: "出错" },
            ].map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="session-toolbar-actions">
          <InputGroup className="session-search">
            <InputGroupAddon>
              <Icon name="search" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="搜索会话"
              placeholder="搜索会话、项目或 Agent"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label="清除搜索"
                  size="icon-xs"
                  onClick={() => setQuery("")}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Choice
            className="w-[142px]"
            label="会话排序"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "updated", label: "最近更新" },
              { value: "created", label: "创建时间" },
              { value: "title", label: "会话名称" },
            ]}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新会话列表"
            title="刷新会话列表"
            disabled={job.busy || archive.loading || state.status !== "online"}
            onClick={() => {
              job.clear();
              if (archived) archive.reload();
              else void job.run(() => actions.refresh());
            }}
          >
            <RefreshCw
              className={
                job.busy || archive.loading ? "animate-spin" : undefined
              }
            />
          </Button>
        </div>
      </div>
      <ErrorNotice error={loadError ?? job.error} />
      {loadError && (
        <Button
          variant="outline"
          size="sm"
          disabled={state.status !== "online" || job.busy}
          onClick={() =>
            archived ? archive.reload() : void job.run(() => actions.refresh())
          }
        >
          重新加载会话
        </Button>
      )}
      {!loaded && !loadError && (
        <div
          className="session-loading"
          role="status"
          aria-label="正在加载会话"
        >
          {[0, 1, 2, 3].map((index) => (
            <div className="session-loading-row" key={index}>
              <Skeleton className="size-8 rounded-lg" />
              <div>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        </div>
      )}
      {loaded && (query.trim() || filter !== "all") && (
        <div className="session-results-summary">
          <span>
            找到 {sessions.length} 个会话
            {nextBefore !== undefined ? " · 仅搜索当前记录" : ""}
          </span>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            清除筛选
          </Button>
        </div>
      )}
      {["waiting", "running", "recent"].map((group) => {
        const shown = sessions.filter(
          (session) => sessionGroup(session) === group,
        );
        return shown.length ? (
          <Card className="session-group" key={group}>
            <CardHeader>
              <CardTitle>
                {group === "waiting"
                  ? "需要你"
                  : group === "running"
                    ? "进行中"
                    : "最近会话"}{" "}
                <span className="muted">{shown.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <SessionTable sessions={shown} navigate={navigate} />
            </CardContent>
          </Card>
        ) : null;
      })}
      {loaded && !loadError && !sessions.length && (
        <EmptyState
          title={
            query || filter !== "all"
              ? "没有找到会话"
              : archived
                ? nextBefore !== undefined
                  ? "当前记录中暂无归档，可继续加载更早会话"
                  : "暂无已归档会话"
                : "开始第一个任务"
          }
          description={
            query || filter !== "all"
              ? "换一个关键词，或调整上方筛选条件。"
              : "会话保存在当前电脑，手机与网页共享同一份记录。"
          }
        >
          {query || filter !== "all" ? (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              显示全部会话
            </Button>
          ) : !archived ? (
            <Button disabled={state.status !== "online"} onClick={create}>
              <Plus data-icon="inline-start" />
              新建会话
            </Button>
          ) : (
            <Button variant="outline" onClick={() => navigate("home")}>
              返回会话概览
            </Button>
          )}
        </EmptyState>
      )}
      {nextBefore !== undefined && (
        <div className="session-pagination">
          <Button
            variant="outline"
            disabled={job.busy || archive.loading || state.status !== "online"}
            onClick={() =>
              void job.run(() =>
                archived
                  ? actions.loadArchived(nextBefore)
                  : actions.loadMoreSessions(),
              )
            }
          >
            {job.busy ? "正在加载…" : "加载更早的会话"}
          </Button>
        </div>
      )}
    </>
  );
}
function NewSession({
  initialDirectory,
  close,
  created,
}: {
  initialDirectory?: string;
  close: () => void;
  created: (session: SessionSummary) => void;
}) {
  const machine = useClient((state) => state.machine);
  const projects = useClient((state) => state.projects);
  const actions = useActions();
  const { store } = useConnection();
  const online = useClient((state) => state.status === "online");
  const job = useJob();
  const [agent, setAgent] = useState(
    machine?.agents.find(
      (agent) =>
        agent.installed &&
        !agent.problem &&
        agent.auth?.state !== "missing" &&
        agent.tier !== "terminal",
    )?.id ?? "",
  );
  const [cwd, setCwd] = useState(
    initialDirectory ?? projects[0]?.cwd ?? machine?.home ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [gitPath, setGitPath] = useState(cwd);
  useEffect(() => {
    setWorktree(false);
    const timer = setTimeout(() => setGitPath(cwd), 250);
    return () => clearTimeout(timer);
  }, [cwd]);
  const git = useLoad(
    () =>
      gitPath.trim() ? actions.gitInfo(gitPath) : Promise.resolve(undefined),
    [store, gitPath],
  );
  const selectedAgent = machine?.agents.find((item) => item.id === agent);
  const usable =
    !!selectedAgent &&
    selectedAgent.installed &&
    !selectedAgent.problem &&
    selectedAgent.auth?.state !== "missing" &&
    selectedAgent.tier !== "terminal";

  return (
    <Modal
      title="新建会话"
      close={() => {
        if (!job.busy) close();
      }}
      wide={browse}
    >
      <AgentInteractions agent={agent} />
      {browse ? (
        <div className="flex flex-col gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setBrowse(false)}
          >
            返回会话设置
          </Button>
          <Files
            start={cwd}
            directoriesOnly
            onPick={(path) => {
              setCwd(path);
              setBrowse(false);
            }}
          />
        </div>
      ) : (
        <form
          className="new-session-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (job.busy || !online || !usable || !cwd.trim()) return;
            void job.run(async () =>
              created(
                await actions.createSession({
                  agent,
                  cwd: cwd.trim(),
                  worktree: worktree && !!git.value && gitPath === cwd,
                  prompt: prompt.trim()
                    ? [{ type: "text", text: prompt.trim() }]
                    : undefined,
                }),
              ),
            );
          }}
        >
          <FieldGroup>
            <Field data-disabled={job.busy}>
              <FieldLabel htmlFor="new-session-prompt">
                任务描述 <span className="muted">可选</span>
              </FieldLabel>
              <Textarea
                id="new-session-prompt"
                autoFocus
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                disabled={job.busy}
                placeholder="描述想完成的工作，也可以稍后再说…"
              />
            </Field>
            <Field data-disabled={job.busy}>
              <FieldLabel htmlFor="new-session-agent">Agent</FieldLabel>
              <Choice
                id="new-session-agent"
                label="Agent"
                value={agent}
                disabled={job.busy}
                onValueChange={setAgent}
                options={(machine?.agents ?? []).map((entry) => ({
                  value: entry.id,
                  label:
                    entry.label +
                    (!entry.installed
                      ? " · 未安装"
                      : entry.auth?.state === "missing"
                        ? " · 未登录"
                        : entry.tier === "terminal"
                          ? " · 请从终端打开"
                          : entry.problem
                            ? ` · ${entry.problem}`
                            : ""),
                  disabled:
                    !entry.installed ||
                    !!entry.problem ||
                    entry.auth?.state === "missing" ||
                    entry.tier === "terminal",
                }))}
              />
              {!usable && (
                <FieldDescription>
                  请先在「电脑」页面确认 Agent 已安装并完成登录。
                </FieldDescription>
              )}
            </Field>
            <Field data-disabled={job.busy}>
              <FieldLabel htmlFor="new-session-cwd">工作目录</FieldLabel>
              <div className="new-session-directory">
                <Input
                  id="new-session-cwd"
                  value={cwd}
                  disabled={job.busy}
                  onChange={(event) => setCwd(event.target.value)}
                  required
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  disabled={job.busy || !online}
                  aria-label="浏览电脑目录"
                  title="浏览电脑目录"
                  onClick={() => setBrowse(true)}
                >
                  <FolderOpen />
                </Button>
              </div>
              <FieldDescription>
                Agent 会在此目录中读取文件并执行任务。
              </FieldDescription>
            </Field>
            {git.value && gitPath === cwd && (
              <Field orientation="horizontal" data-disabled={job.busy}>
                <Checkbox
                  id="new-session-worktree"
                  checked={worktree}
                  disabled={job.busy}
                  onCheckedChange={(checked) => setWorktree(checked === true)}
                />
                <div>
                  <FieldLabel htmlFor="new-session-worktree">
                    在独立 worktree 中工作
                  </FieldLabel>
                  <FieldDescription>
                    基于当前 Git 仓库创建独立工作目录。
                  </FieldDescription>
                </div>
              </Field>
            )}
          </FieldGroup>
          {!online && (
            <p className="muted" role="status">
              电脑连接恢复后即可创建，已填写的内容会保留。
            </p>
          )}
          <ErrorNotice error={job.error} />
          <div className="new-session-form-footer">
            <Button
              variant="outline"
              type="button"
              disabled={job.busy}
              onClick={close}
            >
              取消
            </Button>
            <Button disabled={job.busy || !online || !usable || !cwd.trim()}>
              {job.busy && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              {job.busy ? "正在创建…" : "创建会话"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function Computers({
  connect,
  selectComputer,
}: {
  connect: () => void;
  selectComputer: (computer: Computer) => void;
}) {
  const dialogs = useDialogs();
  const state = useStore(engine.state);
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  const { link } = useConnection();
  const job = useJob();
  const gateway = useLoad(() => link.call("gateway.status", {}), [link], 10000);
  return (
    <section className="flex flex-col gap-6">
      <div className="page-heading">
        <div>
          <h1>电脑</h1>
          <p className="muted">管理已连接的电脑、Agent 和配对设备。</p>
        </div>
        <Button onClick={connect}>
          <Icon name="plus" data-icon="inline-start" />
          添加电脑
        </Button>
      </div>
      <ErrorNotice error={job.error} />
      <Card>
        <CardHeader>
          <CardTitle>已连接的电脑</CardTitle>
          <CardDescription>
            切换电脑后，文件、终端和会话会随之切换。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table className="session-table computer-table">
            <TableHeader>
              <TableRow>
                <TableHead>电脑</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.computers.map((computer) => (
                <TableRow key={computer.key}>
                  <TableCell>
                    <span className="computer-name">
                      <Icon name="computer" />
                      <span>
                        <strong title={computer.machine.name}>
                          {computer.machine.name}
                        </strong>
                        <small title={computer.gateway}>
                          {computer.gateway.replace(/^wss?:\/\//, "")}
                        </small>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      variant={
                        computer.machine.online ? "success" : "secondary"
                      }
                    >
                      {computer.machine.online ? "在线" : "离线"}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <div className="computer-actions flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          state.connection?.computer.key === computer.key
                        }
                        onClick={() => selectComputer(computer)}
                      >
                        {state.connection?.computer.key === computer.key
                          ? "当前电脑"
                          : "切换"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={job.busy}
                        onClick={async () => {
                          if (
                            await dialogs.confirm(
                              `移除「${computer.machine.name}」的连接关系？需要时可重新登录或配对。`,
                            )
                          )
                            void job.run(() => engine.forget(computer));
                        }}
                      >
                        移除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>当前电脑的 Agent</CardTitle>
          <CardDescription>
            {machine?.hostname} · {machine?.platform} · Host{" "}
            {machine?.hostVersion}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {!machine && <LoadState loading />}
          <Table className="session-table agent-table">
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>认证状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machine?.agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <span className="session-table-title">
                      <AgentMark agent={agent.id} />
                      {agent.label}
                    </span>
                  </TableCell>
                  <TableCell>
                    {agent.installed ? (agent.version ?? "已安装") : "未安装"}
                  </TableCell>
                  <TableCell>
                    {agent.auth?.state === "ok"
                      ? agent.id === "codex"
                        ? "使用电脑认证配置"
                        : "已登录"
                      : agent.auth?.state === "missing"
                        ? "需要登录"
                        : agent.id === "codex"
                          ? "使用电脑认证配置"
                          : "登录状态未知"}
                    {(agent.problem || agent.auth?.hint) && (
                      <p className="muted">
                        {agent.problem ?? agent.auth?.hint}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>配对设备</CardTitle>
          <CardDescription>
            撤销后，该设备需要重新配对才能连接。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoadState {...gateway} />
          {gateway.error && (
            <Button
              variant="outline"
              size="sm"
              disabled={!online || gateway.loading}
              onClick={gateway.reload}
            >
              重新加载设备
            </Button>
          )}
          {gateway.value && !gateway.value.devices.length && (
            <EmptyState title="暂无配对设备" />
          )}
          {gateway.value?.devices.map((device) => (
            <div className="computer-device-row" key={device.id}>
              <strong>{device.name}</strong>
              <StatusBadge variant={device.online ? "success" : "secondary"}>
                {device.online ? "在线" : "离线"}
              </StatusBadge>
              <Button
                variant="outline"
                size="sm"
                disabled={!online || job.busy}
                onClick={async () => {
                  if (
                    await dialogs.confirm(
                      `撤销「${device.name}」的配对？该设备将需要重新配对。`,
                    )
                  )
                    void job.run(async () => {
                      await link.call("devices.revoke", {
                        deviceId: device.id,
                      });
                      gateway.reload();
                    });
                }}
              >
                撤销配对
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <AcpManager />
    </section>
  );
}
