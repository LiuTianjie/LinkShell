import { deployment } from "./config";
import { useDialogs } from "@/components/Dialogs";
import { Choice } from "./components/Choice";
import { lazy, Suspense, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import appMark from "../../client/assets/mark.png";
import { Icon, type IconName } from "./icons";
import { engine } from "./live/engine";
import { Connect } from "./live/Connect";
import {
  AgentMark,
  Badge,
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
import { Files } from "./live/Files";
import { Terminals } from "./live/Terminal";
import { Worktrees } from "./live/Panels";
import { Screen } from "./live/Video";
import { Ports } from "./live/Ports";
import { readLocal, saveLocal } from "./live/storage";
import "./live/live.css";

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
  const [connect, setConnect] = useState(false);
  const [view, setView] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("view") ??
      readLocal("lastView", "home"),
  );
  const [nav, setNav] = useState(false);
  const [theme, setTheme] = useState(() =>
    readLocal(
      "theme",
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    ),
  );
  useEffect(() => {
    void engine.start();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveLocal("theme", theme);
  }, [theme]);
  useEffect(() => {
    const change = () =>
      setView(
        new URLSearchParams(location.hash.slice(1)).get("view") ?? "home",
      );
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  function navigate(id: string) {
    saveLocal("lastView", id);
    location.hash = new URLSearchParams({ view: id }).toString();
    setView(id);
    setNav(false);
  }
  return (
    <div className={`app-shell ${nav ? "nav-open" : ""}`}>
      {nav && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setNav(false)}
        />
      )}
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            navigate("home");
          }}
        >
          <img src={appMark} className="brand-symbol" alt="" />
          LinkShell<span className="brand-web">web</span>
        </a>
        <button className="connection-switch" onClick={() => setConnect(true)}>
          <span className="source-icon">
            <Icon name={state.source === "official" ? "globe" : "server"} />
          </span>
          <span>
            <strong>
              {state.source === "official" ? "官方工作空间" : "配对工作空间"}
            </strong>
            <small>
              {state.source === "official"
                ? (state.account ?? "登录或连接电脑")
                : state.gateway
                  ? state.gateway.replace(/^wss?:\/\//, "")
                  : "设置你的网关"}
            </small>
          </span>
          <Icon name="down" size={14} />
        </button>
        <nav aria-label="主导航">
          {(
            [
              { id: "home", title: "首页", icon: "grid" },
              { id: "projects", title: "项目", icon: "folder" },
              { id: "computers", title: "电脑", icon: "computer" },
              { id: "files", title: "文件", icon: "file" },
              { id: "terminals", title: "终端", icon: "terminal" },
              { id: "ports", title: "端口预览", icon: "globe" },
              { id: "screen", title: "电脑屏幕", icon: "computer" },
              { id: "worktrees", title: "Worktree", icon: "branch" },
              { id: "archive", title: "已归档", icon: "clock" },
            ] satisfies { id: string; title: string; icon: IconName }[]
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} />
              {item.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <label className="computer-select-label">
            当前电脑
            <Choice
              label="切换电脑"
              value={state.connection?.computer.key ?? ""}
              placeholder="选择电脑"
              onValueChange={(value) => {
                const computer = state.computers.find(
                  (computer) => computer.key === value,
                );
                if (computer) {
                  engine.select(computer);
                  navigate("home");
                }
              }}
              options={state.computers.map((computer) => ({
                value: computer.key,
                label: `${computer.machine.name} · ${computer.machine.online ? "在线" : "离线"}`,
              }))}
            />
          </label>
          <button className="profile-button" onClick={() => setConnect(true)}>
            <span className="avatar">
              <Icon name={state.account ? "globe" : "server"} />
            </span>
            <span>
              <strong>{state.account ?? "浏览器设备"}</strong>
              <small>
                {state.source === "official" ? "账号连接" : "配对连接"}
              </small>
            </span>
            <Icon name="settings" />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setNav(true)}
            >
              <Icon name="menu" />
            </button>
            <strong>
              {state.connection?.computer.machine.name ?? "LinkShell"}
            </strong>
            <span className="breadcrumb-slash">/</span>
            <span>网页工作台</span>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button"
              aria-label="切换外观"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <Icon name="moon" />
            </button>
            <button
              className="button secondary"
              onClick={() => setConnect(true)}
            >
              连接设置
            </button>
          </div>
        </header>
        {state.error && (
          <div className="connection-banner" role="alert">
            <span>{state.error}</span>
            <button
              onClick={() => {
                engine.state.setState({ error: undefined });
                engine.reconnect();
              }}
            >
              重试
            </button>
            <button onClick={() => engine.state.setState({ error: undefined })}>
              关闭
            </button>
          </div>
        )}
        {state.locked ? (
          <div className="welcome-live">
            <h1>工作台已在另一个标签页打开</h1>
            <p className="muted">
              同一个浏览器设备只保持一条连接，避免标签页相互挤掉。
            </p>
            <button
              className="button primary"
              onClick={() => void engine.claim()}
            >
              在此标签页继续
            </button>
          </div>
        ) : state.connection ? (
          <Runtime value={state.connection}>
            <Workspace
              key={state.connection.computer.key}
              view={view}
              navigate={navigate}
              connect={() => setConnect(true)}
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
            <button
              className="button primary"
              disabled={!state.ready}
              onClick={() => setConnect(true)}
            >
              {state.ready
                ? deployment === "self-hosted"
                  ? "配对电脑"
                  : "登录或配对电脑"
                : "正在准备设备身份…"}
            </button>
            <p className="muted">
              {deployment === "self-hosted"
                ? "运行 linkshell pair，输入此网关的配对码即可连接。"
                : "官方服务使用 iTool 账号，自托管使用自己的网关与配对码。"}
            </p>
            {state.computers.map((computer) => (
              <button
                className="button secondary"
                key={computer.key}
                onClick={() => engine.select(computer)}
              >
                {computer.machine.name} ·{" "}
                {computer.machine.online ? "在线" : "离线"}
              </button>
            ))}
            <a className="text-button" href="?demo=1">
              查看独立 UI 演示
            </a>
          </div>
        )}
      </main>
      {connect && <Connect close={() => setConnect(false)} />}
    </div>
  );
}
function Workspace({
  view,
  navigate,
  connect,
}: {
  view: string;
  navigate: (id: string) => void;
  connect: () => void;
}) {
  const state = useClient((state) => state);
  const [create, setCreate] = useState<string | null>();
  const [terminal, setTerminal] = useState<string>();
  const { store } = useConnection();
  const session = state.sessions[view];
  useEffect(() => {
    if (view === "archive") void store.getState().loadArchived();
  }, [store, view]);
  return (
    <>
      {state.status !== "online" && (
        <div className="connection-banner" role="status">
          <span>{state.statusDetail ?? "正在连接电脑…"}</span>
          <button onClick={() => engine.reconnect()}>重新连接</button>
        </div>
      )}
      {session ? (
        <Session key={session.id} session={session} navigate={navigate} />
      ) : (
        <div className="overview live-overview">
          {["home", "archive"].includes(view) && (
            <Home
              archived={view === "archive"}
              navigate={navigate}
              create={() => setCreate(null)}
            />
          )}
          {view === "projects" && (
            <section>
              <div className="page-heading">
                <h1>项目</h1>
                <button
                  className="button primary"
                  onClick={() => setCreate(null)}
                >
                  新建会话
                </button>
              </div>
              {state.projects.map((project) => (
                <article className="notice-card" key={project.cwd}>
                  <div className="browser-toolbar">
                    <strong>{project.name}</strong>
                    <span className="muted">{project.branch}</span>
                    <button
                      className="text-button"
                      onClick={() => setCreate(project.cwd)}
                    >
                      在此新建
                    </button>
                  </div>
                  <p className="muted">{project.cwd}</p>
                  <div className="task-list">
                    {Object.values(state.sessions)
                      .filter(
                        (session) =>
                          session.cwd === project.cwd ||
                          session.worktree?.source === project.cwd,
                      )
                      .map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          open={() => navigate(session.id)}
                        />
                      ))}
                  </div>
                </article>
              ))}
            </section>
          )}
          {view === "computers" && <Computers connect={connect} />}
          {view === "files" && (
            <>
              <h1>文件</h1>
              <Files />
            </>
          )}
          {view === "terminals" && (
            <Terminals selected={terminal} onSelect={setTerminal} />
          )}
          {view === "worktrees" && <Worktrees />}
          {view === "ports" && <Ports />}
          {view === "screen" && <Screen />}
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
            <div className="empty-state">
              <h2>会话尚未加载或已被移除</h2>
              <button className="text-button" onClick={() => navigate("home")}>
                返回首页
              </button>
            </div>
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
function SessionRow({
  session,
  open,
}: {
  session: SessionSummary;
  open: () => void;
}) {
  return (
    <button className="task-row" onClick={open}>
      <span className="row-avatar">
        <AgentMark agent={session.agent} />
        <span className={`tiny-status ${session.state}`} />
      </span>
      <span className="task-info">
        <strong>{titleOf(session)}</strong>
        <span>
          <span className="project-label">
            {baseName(session.worktree?.source ?? session.cwd)}
          </span>
          <span className="separator">·</span>
          <span className={session.state === "running" ? "running-copy" : ""}>
            {session.activity?.title ?? session.preview ?? session.agent}
          </span>
        </span>
      </span>
      <span className="task-meta">
        <small>
          {new Date(session.updatedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </small>
        <Badge state={session.state} />
      </span>
      <Icon name="chevron" size={14} />
    </button>
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
  const job = useJob();
  const sessions = Object.values(state.sessions)
    .filter(
      (session) =>
        session.archived === archived &&
        `${titleOf(session)} ${session.cwd} ${session.agent} ${session.preview ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "all" || session.state === filter),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{archived ? "已归档" : "首页"}</h1>
          <p className="host-summary">
            <span
              className={
                state.status === "online" ? "online-dot" : "offline-dot"
              }
            />
            {state.machine?.hostname ?? "正在连接"}
            <span className="waiting-copy">
              {sessions.filter((session) => session.state === "waiting").length}{" "}
              项需要你
            </span>
          </p>
        </div>
        <button
          className="button primary"
          disabled={state.status !== "online"}
          onClick={create}
        >
          <Icon name="plus" />
          新建任务
        </button>
      </div>
      <div className="home-controls">
        <label className="search-box">
          <Icon name="search" />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话、项目或 Agent"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="filters">
          {[
            { id: "all", name: "全部" },
            { id: "running", name: "进行中" },
            { id: "waiting", name: "需要你" },
            { id: "idle", name: "已完成" },
          ].map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "selected" : ""}
              onClick={() => setFilter(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
      <ErrorNotice error={state.sessionsError ?? job.error} />
      {!state.sessionsLoaded && !state.sessionsError && (
        <p className="muted">正在加载会话…</p>
      )}
      {["waiting", "running", "recent"].map((group) => {
        const shown = sessions.filter((session) =>
          group === "recent"
            ? !["waiting", "running"].includes(session.state)
            : session.state === group,
        );
        return shown.length ? (
          <section className="session-group" key={group}>
            <div
              className={`section-heading ${group === "waiting" ? "waiting-heading" : ""}`}
            >
              <h2>
                {group === "waiting"
                  ? "需要你"
                  : group === "running"
                    ? "进行中"
                    : "最近"}
                <span>{shown.length}</span>
              </h2>
            </div>
            <div className="task-list">
              {shown.map((session) => (
                <div key={session.id}>
                  <SessionRow
                    session={session}
                    open={() => navigate(session.id)}
                  />
                  {session.permission && group === "waiting" && (
                    <Permission
                      permission={session.permission}
                      sessionId={session.id}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null;
      })}
      {state.sessionsLoaded && !sessions.length && (
        <div className="empty-state">
          <h3>
            {query
              ? "没有找到会话"
              : archived
                ? "暂无已归档会话"
                : "开始第一个任务"}
          </h3>
          <p>会话保存在当前电脑，手机与网页共享同一份记录。</p>
        </div>
      )}
      <button
        className="text-button"
        disabled={job.busy}
        onClick={() => void job.run(() => actions.refresh())}
      >
        刷新列表
      </button>
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
    <Modal title="新建任务" close={close} wide={browse}>
      {browse ? (
        <Files
          start={cwd}
          directoriesOnly
          onPick={(path) => {
            setCwd(path);
            setBrowse(false);
          }}
        />
      ) : (
        <form
          className="new-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!online || !usable || !cwd.trim()) return;
            void job.run(async () =>
              created(
                await actions.createSession({
                  agent,
                  cwd,
                  worktree: worktree && !!git.value && gitPath === cwd,
                  prompt: prompt.trim()
                    ? [{ type: "text", text: prompt.trim() }]
                    : undefined,
                }),
              ),
            );
          }}
        >
          <label>
            任务描述
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="想让 Agent 完成什么？"
            />
          </label>
          <label>
            Agent
            <Choice
              label="Agent"
              value={agent}
              onValueChange={setAgent}
              options={(machine?.agents ?? []).map((agent) => ({
                value: agent.id,
                label:
                  agent.label +
                  (!agent.installed
                    ? " · 未安装"
                    : agent.auth?.state === "missing"
                      ? " · 未登录"
                      : agent.tier === "terminal"
                        ? " · 请从终端打开"
                        : agent.problem
                          ? ` · ${agent.problem}`
                          : ""),
                disabled:
                  !agent.installed ||
                  !!agent.problem ||
                  agent.auth?.state === "missing" ||
                  agent.tier === "terminal",
              }))}
            />
          </label>
          <label>
            工作目录
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              required
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => setBrowse(true)}
          >
            浏览电脑目录
          </button>
          {git.value && gitPath === cwd && (
            <label className="choice-option">
              <input
                type="checkbox"
                checked={worktree}
                onChange={(event) => setWorktree(event.target.checked)}
              />
              在新 worktree 中工作
            </label>
          )}
          <ErrorNotice error={job.error} />
          <button
            className="button primary full"
            disabled={job.busy || !online || !usable || !cwd.trim()}
          >
            创建任务
          </button>
        </form>
      )}
    </Modal>
  );
}
function Computers({ connect }: { connect: () => void }) {
  const dialogs = useDialogs();
  const state = useStore(engine.state);
  const machine = useClient((state) => state.machine);
  const { link } = useConnection();
  const job = useJob();
  const gateway = useLoad(() => link.call("gateway.status", {}), [link], 10000);
  return (
    <section>
      <div className="page-heading">
        <h1>电脑</h1>
        <button className="button primary" onClick={connect}>
          添加电脑
        </button>
      </div>
      <ErrorNotice error={job.error} />
      {state.computers.map((computer) => (
        <article className="notice-card" key={computer.key}>
          <div className="browser-toolbar">
            <Icon name="computer" />
            <strong>{computer.machine.name}</strong>
            <span className="muted">
              {computer.machine.online ? "在线" : "离线"}
            </span>
            <button
              className="text-button"
              onClick={() => engine.select(computer)}
            >
              切换到此电脑
            </button>
            <button
              className="text-button danger-text"
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
            </button>
          </div>
          <p className="muted">{computer.gateway}</p>
        </article>
      ))}
      <h2>当前电脑</h2>
      <p className="muted">
        {machine?.hostname} · {machine?.platform} · Host {machine?.hostVersion}
      </p>
      <h3>Agent</h3>
      <div className="agent-list">
        {machine?.agents.map((agent) => (
          <article key={agent.id}>
            <AgentMark agent={agent.id} />
            <div>
              <strong>{agent.label}</strong>
              <p>
                {agent.installed ? (agent.version ?? "已安装") : "未安装"} ·{" "}
                {agent.auth?.state === "ok"
                  ? "已登录"
                  : agent.auth?.state === "missing"
                    ? "需要登录"
                    : "登录状态未知"}
              </p>
              {(agent.problem || agent.auth?.hint) && (
                <p className="muted">{agent.problem ?? agent.auth?.hint}</p>
              )}
            </div>
          </article>
        ))}
      </div>
      <h3>配对设备</h3>
      <LoadState {...gateway} />
      {gateway.value?.devices.map((device) => (
        <article className="notice-card" key={device.id}>
          <div className="browser-toolbar">
            <strong>{device.name}</strong>
            <span className="muted">{device.online ? "在线" : "离线"}</span>
            <button
              className="text-button danger-text"
              onClick={async () => {
                if (
                  await dialogs.confirm(
                    `撤销「${device.name}」的配对？该设备将需要重新配对。`,
                  )
                )
                  void job.run(async () => {
                    await link.call("devices.revoke", { deviceId: device.id });
                    gateway.reload();
                  });
              }}
            >
              撤销配对
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
