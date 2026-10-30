import { sessionGroup, sessionNeedsAttention, sessionPreview } from "./live/session-list";
import { sessionTime } from "./live/session-time";
import { StatusText } from "./live/StatusText";
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
import {
  Archive,
  ArrowLeft,
  RefreshCw,
  X,
  Plus,
  FolderOpen,
  LoaderCircle,
  Search,
  MessageSquarePlus,
  MonitorSmartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { deployment } from "./config";
import { useDialogs } from "@/components/Dialogs";
import { Choice } from "./components/Choice";
import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { PageHeader } from "./components/PageHeader";
import { NewSessionPage } from "./live/NewSessionPage";
import { configToCreate, creationOptions, modelName, modelToCreate, useAgentModels } from "./live/agent-models";
import { creationOptionLabel } from "./live/NewSessionConfig";
import { valueName } from "./live/ComposerControls";
import { HOST_PROTOCOL, type SessionSummary } from "@linkshell/wire";
import appMark from "../../client/assets/mark.png";
import { Icon } from "./icons";
import { engine } from "./live/engine";
import { ComputerName } from "./live/ComputerName";
import { AccessPasswordSettings, AccessPasswordSummary, AccessUnlock, LockMark } from "./live/Access";
import {
  computerName,
  computerOption,
  computerIdentity,
  computerNames,
} from "./live/computer-names";
import { Connect } from "./live/Connect";
import {
  AgentMark,
  EmptyState,
  ErrorNotice,
  LoadMore,
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
import { Screens, ScreenDetail } from "./live/Screens";
import { screenView, screenComputerKey } from "./live/screen-route";
import { ScreenSessionSlot } from "./live/screen-session-slot";
import { Ports } from "./live/Ports";
import { ConsoleShell } from "./components/ConsoleShell";
import { readLocal, saveLocal } from "./live/storage";
import type { Computer } from "./live/engine";
import { useNavigationGuard } from "./live/use-navigation-guard";
import { SessionLookup } from "./live/SessionLookup";
import { AllProjects, Projects } from "./live/Projects";
import { projectScope } from "./live/project-overview";
import { isDesktop, isElectronDesktop, openDesktopManagement, THIS_COMPUTER_SPACED, THIS_COMPUTER } from "./live/desktop";
import { Management } from "./live/Management";
import { isManageView, managePage, manageView } from "./live/management-model";
import { takeDeferredNewSession, useDesktopCommand, useNewSessionTarget } from "./live/desktop-commands";
import { useDesktopVisibility } from "./live/desktop-visibility";

export function App() {
  return <LiveApp />;
}
/** Local management exists only in the Electron window; elsewhere a saved "manage" view opens the overview. */
function viewable(view: string): string {
  return isManageView(view) && !isElectronDesktop ? "home" : view;
}
function LiveApp() {
  const workspaceVisible = useDesktopVisibility();
  const projectsScope = useStore(projectScope, (state) => state.value);
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const guard = useNavigationGuard();
  const [connect, setConnect] = useState(false);
  const [view, setView] = useState(() =>
    viewable(
      new URLSearchParams(location.hash.slice(1)).get("view") ??
        readLocal("lastView", "home"),
    ),
  );
  useEffect(() => {
    void engine.start();
  }, []);
  useEffect(() => {
    const change = () => {
      const next = viewable(
        new URLSearchParams(location.hash.slice(1)).get("view") ?? "home",
      );
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
      if (screenComputerKey(view)) commitView(screenView(computer.key));
      else if (view !== "screen") commitView("home");
    });
  }
  function openComputerView(computer: Computer, id: string) {
    void guard(() => {
      const selected = engine.state.getState().connection?.computer;
      const target = engine.computerForKey(computer.key) ?? computer;
      if (selected?.key !== target.key) engine.select(target);
      commitView(id);
    });
  }
  const openConnect = () => void guard(() => setConnect(true));
  return (
    <ConsoleShell
      view={isDesktop ? view : screenComputerKey(view) ? "screen" : view}
      navigate={navigate}
      connect={openConnect}
      selectComputer={selectComputer}
      openComputerView={openComputerView}
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
      <ScreenSessionSlot
        key={state.accountUserId ?? "paired"}
        activeKey={screenComputerKey(view)}
        selectedKey={state.connection?.computer.key}
        enabled={!state.locked && workspaceVisible}
      >
        {(computerKey, active) => (
          <ScreenDetail
            computerKey={computerKey}
            active={active}
            back={() => navigate("screen")}
          />
        )}
      </ScreenSessionSlot>
      {isElectronDesktop && isManageView(view) ? (
        <Management page={managePage(view)} navigate={(page) => navigate(manageView(page))} />
      ) : state.locked ? (
        <div className="welcome-live">
          <h1>工作台已在另一个标签页打开</h1>
          <p className="muted">
            同一个浏览器设备只保持一条连接，避免标签页相互挤掉。
          </p>
          <Button variant="default" onClick={() => void engine.claim()}>
            在此标签页继续
          </Button>
        </div>
      ) : view === "projects" && projectsScope === "all" ? (
        <div className="overview live-overview"><AllProjects openComputerView={openComputerView} /></div>
      ) : view === "screen" ? (
        <Screens
          live={workspaceVisible}
          connect={() => setConnect(true)}
          open={(computer) => {
            engine.select(computer);
            navigate(screenView(computer.key));
          }}
        />
      ) : screenComputerKey(view) ? null : state.connection ? (
        <Runtime value={state.connection}>
          <Workspace
            key={state.connection.computer.key}
            view={view}
            navigate={navigate}
            connect={openConnect}
            selectComputer={selectComputer}
            openComputerView={openComputerView}
          />
        </Runtime>
      ) : (
        <div className="welcome-live">
          <img src={appMark} alt="LinkShell" />
          <h1>连接你的电脑</h1>
          <p className="muted">
            {isDesktop
              ? `在${THIS_COMPUTER_SPACED}上，继续每一台电脑的工作。`
              : "会话在电脑上运行，网页让你继续对话、审批和操作。"}
          </p>
          {!isDesktop && <pre>npm i -g linkshell-cli{"\n"}linkshell host --daemon</pre>}
          <Button
            variant="default"
            disabled={!state.ready}
            onClick={() => setConnect(true)}
          >
            {state.ready
              ? deployment === "self-hosted"
                ? "配对电脑"
                : "连接电脑"
              : "正在准备设备身份…"}
          </Button>
          {isDesktop && (
            <Button variant="ghost" onClick={() => openDesktopManagement()}>
              管理{THIS_COMPUTER}
            </Button>
          )}
          <p className="muted">
            {deployment === "self-hosted"
              ? "运行 linkshell pair，输入此网关的配对码即可连接。"
              : isDesktop
                ? "登录已有账号发现其他电脑，或使用配对码添加。"
                : "官方服务使用 iTool 账号，自托管使用自己的网关与配对码。"}
          </p>
          {state.computers.map((computer) => (
            <Button
              variant="outline"
              key={computer.key}
              onClick={() => engine.select(computer)}
            >
              {computerOption(computer, names)}
            </Button>
          ))}
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
  openComputerView,
}: {
  view: string;
  navigate: (id: string) => void;
  connect: () => void;
  selectComputer: (computer: Computer) => void;
  openComputerView: (computer: Computer, view: string) => void;
}) {
  const state = useClient((state) => state);
  useNewSessionTarget();
  // Asked for from 本机管理 or the remote screen, before this workspace was showing to hear it.
  const [create, setCreate] = useState<string | null | undefined>(() => {
    const waiting = isDesktop ? takeDeferredNewSession() : undefined;
    return waiting ? waiting.cwd ?? null : undefined;
  });
  const [terminal, setTerminal] = useState<string>();
  const session = state.sessions[view];
  const engineState = useStore(engine.state);
  const names = useStore(computerNames.store);
  useDesktopCommand((command) => {
    // The desktop's new-session page also opens while offline: the draft waits for the computer.
    if (command.command === "new-session" && (isDesktop || state.status === "online")) setCreate(command.cwd ?? null);
  });
  // Going anywhere else leaves the new-session page.
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    if (isDesktop) setCreate(undefined);
  }
  if (state.status === "locked") {
    const computer = engineState.connection?.computer;
    return <AccessUnlock name={computer ? computerName(computer, names) : "这台电脑"} />;
  }
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
      {isDesktop && create !== undefined ? (
        <NewSessionPage
          key={create ?? ""}
          initialDirectory={create ?? undefined}
          cancel={() => setCreate(undefined)}
          created={(session) => {
            setCreate(undefined);
            navigate(session.id);
          }}
        />
      ) : session ? (
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
              openComputerView={openComputerView}
            />
          )}
          {view === "computers" && (
            <Computers connect={connect} selectComputer={selectComputer} navigate={navigate} />
          )}
          {view === "files" && (
            <>
              {/* On the desktop the browser's own toolbar is the page's: where you are and what to do. */}
              {!isDesktop && <PageHeader title="文件" />}
              <Files page />
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
      {!isDesktop && create !== undefined && (
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
  group,
}: {
  sessions: SessionSummary[];
  navigate: (id: string) => void;
  /** The group the rows are under: a row doesn't repeat what its heading says. */
  group?: string;
}) {
  const [permissionId, setPermissionId] = useState<string>();
  const permissionSession = sessions.find(
    (session) => session.id === permissionId && session.permission,
  );
  return (
    <>
      <div role="list">
        {sessions.map((session) => {
          const project = baseName(session.worktree?.source ?? session.cwd);
          return (
            <div
              role="listitem"
              key={session.id}
              className="list-row"
              data-session-state={session.state}
              data-attention={sessionNeedsAttention(session) || undefined}
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest("button, a") ||
                  window.getSelection()?.toString()
                )
                  return;
                navigate(session.id);
              }}
            >
              <span title={session.agent} className="flex shrink-0">
                <AgentMark agent={session.agent} />
              </span>
              {/* The project follows the title, so every preview has the row's whole width to run in. */}
              <span className="list-row-heading">
                <Button
                  variant="ghost"
                  size="plain"
                  className="list-row-title"
                  title={titleOf(session)}
                  onClick={() => navigate(session.id)}
                >
                  {titleOf(session)}
                </Button>
                <span
                  className="list-row-meta list-row-project"
                  title={session.worktree?.source ?? session.cwd}
                >
                  {project}
                </span>
              </span>
              <span className="list-row-detail">{sessionPreview(session)}</span>
              <span className="list-row-status">
                {/* A finished session is the normal state, not news, and a row under 进行中 or 需要你
                    is already said to be: on the desktop only the others say so. */}
                {(() => {
                  const status = sessionNeedsAttention(session) ? "waiting" : session.state;
                  const said = status === "idle" || (group === "running" && status === "running") || (group === "waiting" && status === "waiting");
                  return !isDesktop || !said ? <StatusText state={status} /> : null;
                })()}
              </span>
              {session.permission && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`处理 ${titleOf(session)}`}
                  onClick={() => setPermissionId(session.id)}
                >
                  处理
                </Button>
              )}
              <time
                className="list-row-meta w-14 text-right"
                dateTime={new Date(session.updatedAt).toISOString()}
                title={new Date(session.updatedAt).toLocaleString()}
              >
                {sessionTime(session.updatedAt)}
              </time>
            </div>
          );
        })}
      </div>
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
  const counts = {
    all: Object.values(state.sessions).filter((session) => !session.archived)
      .length,
    running: Object.values(state.sessions).filter(
      (session) => !session.archived && sessionGroup(session) === "running",
    ).length,
    waiting: Object.values(state.sessions).filter(
      (session) => !session.archived && sessionNeedsAttention(session),
    ).length,
  } as Record<string, number | undefined>;
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };
  const pending = allSessions.filter(sessionNeedsAttention).length;
  const sortChoice = (
    <Choice
      className="w-[130px]"
      label="会话排序"
      value={sort}
      onValueChange={setSort}
      options={[
        { value: "updated", label: "最近更新" },
        { value: "created", label: "创建时间" },
        { value: "title", label: "会话名称" },
      ]}
    />
  );
  const refreshButton = (
    <Button
      variant={isDesktop ? "ghost" : "outline"}
      size="icon"
      className="list-refresh"
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
  );
  const searchField = (
    <InputGroup className="session-search w-full max-w-72">
      <InputGroupAddon><Icon name="search" /></InputGroupAddon>
      <InputGroupInput
        aria-label="搜索会话"
        placeholder="搜索会话、项目或 Agent"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="清除搜索" size="icon-xs" onClick={() => setQuery("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
  return (
    <section className="session-overview flex min-w-0 flex-col gap-4">
      {isDesktop && (
        <OverviewHeading
          archived={archived}
          sessions={Object.values(state.sessions).filter((session) => !session.archived)}
          more={state.sessionsNextBefore !== undefined}
          online={state.status === "online"}
          create={create}
          navigate={navigate}
          search={searchField}
        />
      )}
      {!isDesktop && <div className="session-overview-heading flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {archived ? "已归档会话" : "会话概览"}
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--secondaryLabel)]">
            <StatusText
              state={state.status === "online" ? "idle" : "pending"}
              label={state.machine?.hostname ?? "正在连接"}
            />
            <span aria-hidden>·</span>
            <span>{pending ? `${pending} 项需要你` : "暂无待处理事项"}</span>
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
      </div>}
      {/* An empty archive has nothing to sort: its empty state is the page. */}
      {/* The desktop's archive has one group: its sort and refresh sit in that group's heading. */}
      <div className="session-overview-filters flex flex-wrap items-center justify-between gap-3" hidden={isDesktop && archived}>
        <Tabs value={filter} onValueChange={setFilter} hidden={archived && isDesktop}>
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
                {/* On the desktop the groups below are counted; the filters only filter. */}
                {!isDesktop && !archived && counts[item.id] !== undefined && (
                  <span className="text-[var(--tertiaryLabel)] tabular-nums">
                    {counts[item.id]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="session-overview-tools flex min-w-0 flex-1 items-center justify-end gap-2 max-sm:w-full max-sm:flex-none">
          {!isDesktop && searchField}
          {sortChoice}
          {/* The live list follows the computer by itself; only the archive is read on request. */}
          {!isDesktop && refreshButton}
        </div>
      </div>
      <ErrorNotice error={loadError ?? job.error} />
      {loadError && (
        <Button
          className="self-start"
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
        <div role="status" aria-label="正在加载会话">
          {[0, 1, 2, 3].map((index) => (
            <div className="list-skeleton" key={index}>
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      )}
      {loaded && (query.trim() || filter !== "all") && (
        <div className="flex items-center justify-between text-xs text-[var(--secondaryLabel)]">
          <span>
            找到 {sessions.length} 个会话
            {nextBefore !== undefined ? " · 仅搜索当前记录" : ""}
          </span>
          <Button variant="link" size="sm" onClick={clearFilters}>
            清除筛选
          </Button>
        </div>
      )}
      {(isDesktop && archived ? ["archived"] : ["waiting", "running", "recent"]).map((group) => {
        const shown = group === "archived"
          ? sessions
          : sessions.filter((session) => sessionGroup(session) === group);
        // Older records are recent ones: while the computer has more, that count is a floor.
        const floor = nextBefore !== undefined && (group === "recent" || group === "archived");
        const heading = (
          <h2 className="list-section-title">
            {({ waiting: "需要你", running: "进行中", recent: "最近会话", archived: "已归档" } as Record<string, string>)[group]}
            <span className="font-normal text-[var(--tertiaryLabel)]">
              {shown.length}{floor ? "+" : ""}
            </span>
          </h2>
        );
        return shown.length ? (
          <div className="session-group" data-session-group={group} key={group}>
            {group === "archived" ? (
              <div className="list-section-heading">
                {heading}
                <div className="list-section-actions">
                  {sortChoice}
                  {refreshButton}
                </div>
              </div>
            ) : heading}
            <SessionTable sessions={shown} navigate={navigate} group={group} />
          </div>
        ) : null;
      })}
      {loaded && !loadError && !sessions.length && (
        <EmptyState
          icon={
            query || filter !== "all" ? (
              <Search />
            ) : archived ? (
              <Archive />
            ) : (
              <MessageSquarePlus />
            )
          }
          title={
            query || filter !== "all"
              ? "没有找到会话"
              : archived
                ? "没有已归档的会话"
                : "开始第一个任务"
          }
          description={
            query || filter !== "all"
              ? "换一个关键词，或调整上方筛选条件。"
              : archived
                ? nextBefore !== undefined
                  ? "已载入的记录里没有，可以继续加载更早的会话。"
                  : "归档的会话不在侧栏和列表里显示，记录仍保存在电脑上。"
                : "会话保存在当前电脑，手机、桌面与网页共享同一份记录。"
          }
        >
          {query || filter !== "all" ? (
            <Button variant="outline" onClick={clearFilters}>
              显示全部会话
            </Button>
          ) : !archived ? (
            <Button disabled={state.status !== "online"} onClick={create}>
              <Plus data-icon="inline-start" />
              新建会话
            </Button>
          ) : nextBefore !== undefined ? (
            // Nothing loaded yet but more on the computer: the way on is part of the empty state.
            <Button
              variant="outline"
              disabled={job.busy || archive.loading || state.status !== "online"}
              onClick={() => void job.run(() => actions.loadArchived(nextBefore))}
            >
              {job.busy ? "正在加载…" : "加载更早的会话"}
            </Button>
          ) : !isDesktop ? (
            <Button variant="outline" onClick={() => navigate("home")}>
              返回会话概览
            </Button>
          ) : null}
        </EmptyState>
      )}
      {nextBefore !== undefined && !(loaded && !loadError && !sessions.length && archived && !query && filter === "all") && (
        // On the desktop the way on is a quiet button under the list, not a row that reads as one.
        <LoadMore
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
        </LoadMore>
      )}
    </section>
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
  // Picked per agent: another agent starts from its own default.
  const [picked, setPicked] = useState<{ store: typeof store; agent: string; model: string }>();
  const [configPick, setConfigPick] = useState<{ store: typeof store; key: string; values: Record<string, string> }>();
  const [modelsRevision, setModelsRevision] = useState(0);
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
  // Asked about the directory once typing pauses, like git.
  const pickedModel = picked?.store === store && picked.agent === agent ? picked.model : undefined;
  const models = useAgentModels(agent, gitPath, online && usable, pickedModel, modelsRevision);
  const model = modelToCreate(
    models,
    pickedModel,
  );
  const configKey = JSON.stringify([agent, cwd.trim()]);
  const pickedConfig = configPick?.store === store && configPick.key === configKey ? configPick.values : {};
  const options = creationOptions(models?.config, pickedConfig);
  const unavailableModel = pickedModel && models && !models.error && !models.models.some((entry) => entry.value === pickedModel);
  const ready = !job.busy && online && usable && !!cwd.trim() && gitPath === cwd && !!models && !models.error;

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
            if (!ready) return;
            void job.run(async () =>
              created(
                await actions.createSession({
                  agent,
                  cwd: cwd.trim(),
                  worktree: worktree && !!git.value && gitPath === cwd,
                  // Untouched, the agent picks as it always does: nothing is pinned.
                  model,
                  config: configToCreate(models?.config, pickedConfig),
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
            {!!models?.models.length && (
              <Field data-disabled={job.busy}>
                <FieldLabel htmlFor="new-session-model">模型</FieldLabel>
                <Choice
                  id="new-session-model"
                  label="模型"
                  placeholder="默认模型"
                  value={model ?? models.current ?? ""}
                  disabled={job.busy}
                  onValueChange={(value) => setPicked({ store, agent, model: value })}
                  options={models.models.map((entry) => {
                    const name = modelName(entry);
                    return {
                      value: entry.value,
                      label:
                        entry.value === models.current && !name.startsWith("默认")
                          ? `${name} · 默认`
                          : name,
                    };
                  })}
                />
              </Field>
            )}
            {options.map((option) => (
              <Field key={option.id} data-disabled={job.busy}>
                <FieldLabel htmlFor={`new-session-config-${option.id}`}>{creationOptionLabel(option)}</FieldLabel>
                <Choice
                  id={`new-session-config-${option.id}`}
                  label={creationOptionLabel(option)}
                  value={option.current}
                  disabled={job.busy || gitPath !== cwd}
                  onValueChange={(value) => setConfigPick({ store, key: configKey, values: { ...pickedConfig, [option.id]: value } })}
                  options={option.values.map((entry) => ({ value: entry.value, label: valueName(entry.name) }))}
                />
                {option.values.find((entry) => entry.value === option.current)?.description && <FieldDescription>{option.values.find((entry) => entry.value === option.current)?.description}</FieldDescription>}
              </Field>
            ))}
            {online && usable && (!models || gitPath !== cwd) && <p className="muted" role="status">正在读取模型与设置…</p>}
            {unavailableModel && <p className="muted" role="status">此前选择的模型已不可用，将使用 Agent 的默认模型；也可以重新选择。</p>}
            {models?.error && (
              <Field>
                <ErrorNotice error={`模型与设置加载失败：${models.error}`} />
                <Button type="button" variant="outline" size="sm" className="self-start" disabled={job.busy} onClick={() => setModelsRevision((value) => value + 1)}>重新读取模型与设置</Button>
              </Field>
            )}
            {models && !models.error && !models.models.length && (
              <Field>
                <FieldDescription>Agent 尚未提供可预选的模型，可以使用默认设置开始。</FieldDescription>
                <Button type="button" variant="ghost" size="sm" className="self-start" disabled={job.busy} onClick={() => setModelsRevision((value) => value + 1)}>重新读取模型与设置</Button>
              </Field>
            )}
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
            <Button disabled={!ready}>
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
  navigate,
}: {
  connect: () => void;
  selectComputer: (computer: Computer) => void;
  navigate: (view: string) => void;
}) {
  const dialogs = useDialogs();
  const state = useStore(engine.state);
  const names = useStore(computerNames.store);
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  const { link } = useConnection();
  const job = useJob();
  const gateway = useLoad(() => link.call("gateway.status", {}), [link], 10000);
  // A section's title and its line of why sit above its box, as 本机管理's groups do.
  const section = (title: string, hint: string | undefined, rows: ReactNode) => (
    <section className="computers-group" aria-label={title}>
      <div className="computers-section-heading px-3 pb-2">
        <h2 className="text-xs font-semibold text-[var(--secondaryLabel)]">
          {title}
        </h2>
        {hint && <p className="text-xs text-[var(--tertiaryLabel)]">{hint}</p>}
      </div>
      <div className="computers-section">{rows}</div>
    </section>
  );
  return (
    <section className="computers-page flex min-w-0 flex-col gap-6">
      {isDesktop ? (
        <PageHeader
          title="电脑与 Agent"
          detail={`${state.computers.length} 台电脑`}
          actions={<Button size="sm" onClick={connect}><Icon name="plus" data-icon="inline-start" />连接电脑</Button>}
        />
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">电脑</h1>
            <p className="mt-1 text-[13px] text-[var(--secondaryLabel)]">
              管理已连接的电脑、Agent 和配对设备。
            </p>
          </div>
          <Button onClick={connect}>
            <Icon name="plus" data-icon="inline-start" />
            添加电脑
          </Button>
        </div>
      )}
      <ErrorNotice error={job.error} />
      {section("已连接的电脑", "切换电脑后，文件、终端和会话会随之切换。", <>
        {state.computers.map((computer) => {
          const current = state.connection?.computer.key === computer.key;
          return (
            <div className="list-row list-row-static" key={computer.key}>
              <Icon name="computer" />
              <div className="min-w-0 flex-1">
                <div
                  className="computer-row-name flex min-w-0 items-center gap-1 font-medium"
                  title={computerName(computer, names)}
                >
                  <span className="truncate">{computerName(computer, names)}</span>
                  <LockMark locked={computer.machine.locked} />
                  {/* On the desktop renaming is a pencil beside the name it changes, shown on hover. */}
                  {isDesktop && <ComputerName computer={computer} iconOnly />}
                </div>
                <div
                  className="truncate text-xs text-[var(--tertiaryLabel)]"
                  title={computer.gateway}
                >
                  {/* The machine's own name only when it was renamed here, else it says the same twice. */}
                  {computerName(computer, names) !== computer.machine.name && `${computer.machine.name} · `}
                  {computerIdentity(computer)}
                </div>
              </div>
              <StatusText
                state={computer.machine.online ? "online" : "offline"}
                label={computer.machine.online ? "在线" : "离线"}
              />
              <div className="flex shrink-0 items-center gap-1">
                {!isDesktop && <ComputerName computer={computer} />}
                {current && isDesktop ? (
                  <span className="computer-current">当前</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current}
                    onClick={() => selectComputer(computer)}
                  >
                    {current ? "当前电脑" : "切换"}
                  </Button>
                )}
                {computer.key !== "desktop:local" && <Button
                  variant="ghost"
                  size="sm"
                  disabled={job.busy}
                  onClick={async () => {
                    if (
                      await dialogs.confirm(
                        `移除「${computerName(computer, names)}」的连接关系？需要时可重新登录或配对。`,
                      )
                    )
                      void job.run(() => engine.forget(computer));
                  }}
                >
                  移除
                </Button>}
              </div>
            </div>
          );
        })}
      </>)}
      {state.connection?.computer.key === "desktop:local" && (
        // The app shows this Mac's password beside its devices, as links to 本机管理.
        isElectronDesktop ? null : section("这台电脑的访问密码", "设置后，其他设备打开这台电脑前要先输入密码。可以随时修改或移除。", <AccessPasswordSettings />)
      )}
      {section("当前电脑的 Agent", `${machine?.hostname ?? ""} · ${machine?.platform ?? ""} · Host ${machine?.hostVersion ?? ""}${machine && (machine.protocol ?? 0) < HOST_PROTOCOL ? "（比这个界面旧，部分新功能暂时用不了：请更新电脑上的 LinkShell）" : ""}`, <>
        {!machine && <LoadState loading />}
        {machine?.agents.map((agent) => {
          // What it is and which version at the left; how it stands, as a dot and its word, at the
          // right. One that isn't installed is only its name (there is nothing to do about it here).
          const auth = agent.id === "codex" && agent.auth?.state !== "missing"
            ? "使用电脑认证配置"
            : agent.auth?.state === "ok"
              ? "已登录"
              : agent.auth?.state === "missing"
                ? "需要登录"
                : "登录状态未知";
          return (
            <div className="list-row list-row-static computer-agent-row" data-installed={agent.installed || undefined} key={agent.id}>
              <AgentMark agent={agent.id} />
              <span className="computer-agent-name">
                <span className="computer-agent-label" title={agent.label}>{agent.label}</span>
                {agent.installed && (
                  <span className="computer-agent-version" title={agent.version}>{agent.version ?? "已安装"}</span>
                )}
              </span>
              <span className="computer-agent-auth" title={[agent.problem, agent.auth?.hint].filter(Boolean).join(" · ") || undefined}>
                {agent.installed ? (
                  <StatusText
                    state={agent.problem ? "error" : agent.auth?.state === "ok" && agent.id !== "codex" ? "online" : agent.auth?.state === "missing" ? "waiting" : "unknown"}
                    label={agent.problem ?? auth}
                  />
                ) : "未安装"}
              </span>
            </div>
          );
        })}
      </>)}
      {isElectronDesktop && state.connection?.computer.key === "desktop:local" ? (
        // This Mac's phones and password have their own pages (本机管理 → 设备 / 访问密码): here their
        // state and the way there.
        section(`${THIS_COMPUTER_SPACED}的访问`, undefined, <>
          <AccessPasswordSummary open={() => navigate(manageView("password"))} />
          <div className="list-row list-row-static">
            {/* The same mark as the password row above, so the two labels line up. */}
            <span className="access-settings-mark" aria-hidden><MonitorSmartphone size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">配对设备</div>
              <p className="text-xs text-[var(--tertiaryLabel)]">
                {gateway.value ? `${gateway.value.devices.length} 台设备` : "正在读取…"}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => navigate(manageView("devices"))}>管理</Button>
          </div>
        </>)
      ) : (
        section("配对设备", "撤销后，该设备需要重新配对才能连接。", <>
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
          <EmptyState icon={<MonitorSmartphone />} title="暂无配对设备" />
        )}
        {gateway.value?.devices.map((device) => (
          <div className="list-row list-row-static" key={device.id}>
            <strong className="min-w-0 flex-1 truncate font-medium">
              {device.name}
            </strong>
            <StatusText
              state={device.online ? "online" : "offline"}
              label={device.online ? "在线" : "离线"}
            />
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
      </>)
      )}
      <AcpManager />
    </section>
  );
}

/** The desktop list's title row: the noun, then the one finding computed from the rows. */
function OverviewHeading({
  archived,
  sessions,
  more,
  online,
  create,
  navigate,
  search,
}: {
  archived: boolean;
  sessions: SessionSummary[];
  /** The computer has older sessions than those read so far. */
  more: boolean;
  online: boolean;
  create: () => void;
  navigate: (id: string) => void;
  search: ReactNode;
}) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = sessions.filter((session) => session.updatedAt >= startOfDay.getTime()).length;
  // Only what is so, and said once: what waits on you and what runs head their own groups below;
  // the computer is named in the sidebar; an empty count says nothing; a count of what has been
  // read so far, while the computer has more, is a floor.
  const facts = [
    sessions.length ? `${sessions.length}${more ? "+" : ""} 个会话` : undefined,
    today ? `今天更新 ${today} 个` : undefined,
  ].filter(Boolean);
  return (
    <PageHeader
      title={archived ? "已归档会话" : "会话"}
      detail={archived
        ? "不在侧栏显示，记录仍在电脑上"
        : <>{facts.map((fact, index) => <span key={index}>{fact}</span>)}</>}
      actions={<>
        {search}
        <Button variant="ghost" size="sm" onClick={() => navigate(archived ? "home" : "archive")}>
          {archived ? <ArrowLeft data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
          {archived ? "返回会话" : "已归档"}
        </Button>
        {!archived && (
          <Button variant="default" size="sm" disabled={!online} onClick={create}>
            <Icon name="plus" />
            新建会话
          </Button>
        )}
      </>}
    />
  );
}
