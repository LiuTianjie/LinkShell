import { useState } from "react";
import { useStore } from "zustand";
import { groupProjects } from "@linkshell/client-core";
import { Layers3, MessageSquare, GitBranch, Plus, Search, ChevronDown, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  AgentMark,
  EmptyState,
  ErrorNotice,
  LoadMore,
  LoadState,
  titleOf,
  useActions,
  useClient,
  useJob,
  Runtime,
} from "./common";
import { sessionNeedsAttention, sessionPreview } from "./session-list";
import { sessionTime } from "./session-time";
import { StatusText } from "./StatusText";
import { PageHeader } from "../components/PageHeader";
import { engine, type Computer, type Connection } from "./engine";
import { computerName, computerNames } from "./computer-names";
import { ProjectScopeChoice, projectScope, useProjectConnection } from "./project-overview";
import "../styles/projects.css";

export function Projects({
  create,
  navigate,
  openComputerView,
}: {
  create: (cwd?: string) => void;
  navigate: (id: string) => void;
  openComputerView: (computer: Computer, view: string) => void;
}) {
  const scope = useStore(projectScope, (state) => state.value);
  return scope === "all" ? <AllProjects openComputerView={openComputerView} /> : <ProjectList create={create} navigate={navigate} scopeChoice />;
}

/** The all-computer index is independent of the currently selected computer's access state. */
export function AllProjects({ openComputerView }: { openComputerView: (computer: Computer, view: string) => void }) {
  const computers = useStore(engine.state, (state) => state.computers);
  return <div className="projects-overview flex min-w-0 flex-col gap-5">
      <PageHeader title="所有电脑的项目" actions={<ProjectScopeChoice />} />
      {computers.map((computer) => <ComputerProjects key={computer.key} computer={computer} openComputerView={openComputerView} />)}
      {!computers.length && <EmptyState icon={<Layers3 />} title="还没有电脑" description="连接电脑后，它的项目和会话会按电脑分组显示在这里。" />}
  </div>;
}

function ComputerProjects({ computer, openComputerView }: { computer: Computer; openComputerView: (computer: Computer, view: string) => void }) {
  const names = useStore(computerNames.store);
  const retained = useProjectConnection(computer);
  const name = computerName(computer, names);
  if (!retained?.connection || !computer.machine.online) return <section className="flex flex-col gap-2">
    <PageHeader title={name} actions={<Button variant="outline" size="sm" onClick={() => openComputerView(computer, "home")}>打开电脑</Button>} />
    <p className="text-sm text-muted-foreground" role="status">{retained?.error ?? (computer.machine.online ? "正在读取项目…" : "电脑离线，重新连接后可读取项目")}</p>
  </section>;
  return <ConnectedComputerProjects connection={retained.connection} name={name} open={() => openComputerView(computer, "home")} navigate={(id) => openComputerView(computer, id)} />;
}

function ConnectedComputerProjects({ connection, name, open, navigate }: { connection: Connection; name: string; open: () => void; navigate: (id: string) => void }) {
  const status = useStore(connection.store, (state) => state.status);
  if (status === "locked") return <section className="flex flex-col gap-2">
    <PageHeader title={name} actions={<Button variant="outline" size="sm" onClick={open}>输入访问密码</Button>} />
    <p className="text-sm text-muted-foreground">这台电脑需要解锁后才能查看项目。</p>
  </section>;
  return <Runtime value={connection}><ProjectList title={name} navigate={navigate} openComputer={open} /></Runtime>;
}

function ProjectList({ create, navigate, title = "项目", scopeChoice = false, openComputer }: {
  create?: (cwd?: string) => void;
  navigate: (id: string) => void;
  title?: string;
  scopeChoice?: boolean;
  openComputer?: () => void;
}) {
  const state = useClient((state) => state);
  const actions = useActions();
  const job = useJob();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLocaleLowerCase();
  const allSessions = Object.values(state.sessions).filter(
    (session) => !session.archived,
  );
  const projects = groupProjects(state.projects, allSessions)
    .filter(
      (project) =>
        !needle ||
        `${project.name} ${project.cwd} ${project.branch ?? ""}`
          .toLocaleLowerCase()
          .includes(needle) ||
        project.sessions.some((session) =>
          titleOf(session).toLocaleLowerCase().includes(needle),
        ),
    )
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const online = state.status === "online";
  const search = (
    <InputGroup className="page-search">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="搜索项目"
        placeholder="搜索项目、路径或会话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="清除项目搜索" size="icon-xs" onClick={() => setQuery("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
  return (
    <section className="projects-page flex min-w-0 flex-col gap-4">
      <PageHeader
        title={title}
        detail={state.sessionsLoaded ? `${projects.length} 个项目` : undefined}
        actions={<>
          {scopeChoice && <ProjectScopeChoice />}
          {search}
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新项目"
            title="刷新项目"
            disabled={job.busy || !online}
            onClick={() => void job.run(() => actions.refresh())}
          >
            <RefreshCw className={job.busy ? "animate-spin" : undefined} />
          </Button>
          {create ? <Button size="sm" disabled={!online} onClick={() => create()}>
            <Plus data-icon="inline-start" />
            新建会话
          </Button> : <Button variant="outline" size="sm" onClick={openComputer}>打开电脑</Button>}
        </>}
      />
      <ErrorNotice error={state.sessionsError ?? job.error} />
      {!state.sessionsLoaded && !state.sessionsError && <LoadState loading />}
      <div className="project-list">
        {projects.map((project) => {
          const shown = query.trim() || expanded[project.key] ? project.sessions : project.sessions.slice(0, 3);
          return (
            <section key={project.key} className="project-group" aria-label={project.name}>
              <div className="project-row">
                {project.generated ? <MessageSquare className="project-icon" aria-hidden /> : <Layers3 className="project-icon" aria-hidden />}
                <div className="project-copy">
                  <h2>{project.name} {project.generated && <Badge variant="secondary">自动创建</Badge>}</h2>
                  <p title={project.cwd}>{project.cwd}</p>
                </div>
                <div className="project-meta">
                  {project.branch && (
                    <span className="project-branch" title={project.branch}>
                      <GitBranch aria-hidden />
                      {project.branch}
                    </span>
                  )}
                  {/* The sessions read so far, as under it and in the sidebar (archived ones never
                      count); the computer's own count says when there are more to read. */}
                  <span>
                    {project.sessions.length}
                    {project.sessionCount > project.sessions.length ? "+" : ""} 个会话
                  </span>
                  <time dateTime={new Date(project.lastActiveAt).toISOString()}>{sessionTime(project.lastActiveAt)}</time>
                </div>
                {create && !project.generated && <Button
                  variant="ghost"
                  size="sm"
                  className="project-new"
                  disabled={!online}
                  aria-label={`在 ${project.name} 中新建会话`}
                  onClick={() => create(project.cwd)}
                >
                  <Plus data-icon="inline-start" />
                  新建会话
                </Button>}
              </div>
              {shown.length ? (
                <div className="project-sessions">
                  {shown.map((session) => (
                    <button key={session.id} type="button" className="project-session" onClick={() => navigate(session.id)}>
                      <AgentMark agent={session.agent} />
                      <span className="project-session-title" title={titleOf(session)}>{titleOf(session)}</span>
                      <span className="project-session-detail">
                        {sessionPreview(session)}
                      </span>
                      {sessionNeedsAttention(session) || session.state !== "idle" ? (
                        <StatusText state={sessionNeedsAttention(session) ? "waiting" : session.state} />
                      ) : <span />}
                      <time dateTime={new Date(session.updatedAt).toISOString()}>{sessionTime(session.updatedAt)}</time>
                    </button>
                  ))}
                  {project.sessions.length > 3 && !query.trim() && (
                    <button
                      type="button"
                      className="project-more"
                      aria-expanded={!!expanded[project.key]}
                      onClick={() => setExpanded((current) => ({ ...current, [project.key]: !current[project.key] }))}
                    >
                      <ChevronDown aria-hidden data-open={expanded[project.key] || undefined} />
                      {expanded[project.key] ? "收起" : `其余 ${project.sessions.length - 3} 个会话`}
                    </button>
                  )}
                </div>
              ) : (
                <p className="project-empty">已加载的记录里没有这个项目的会话。</p>
              )}
            </section>
          );
        })}
      </div>
      {state.sessionsLoaded && !projects.length && (
        <EmptyState
          icon={needle ? <Search /> : <Layers3 />}
          title={needle ? "没有找到项目" : "还没有项目"}
          description={needle ? "试试项目名称、目录路径或会话标题。" : "在一个工作目录里新建会话，项目会出现在这里。"}
        >
          {needle ? (
            <Button variant="outline" onClick={() => setQuery("")}>清除搜索</Button>
          ) : (
            create ? <Button disabled={!online} onClick={() => create()}>新建会话</Button> : <Button variant="outline" onClick={openComputer}>打开电脑</Button>
          )}
        </EmptyState>
      )}
      {state.sessionsNextBefore !== undefined && (
        <LoadMore
          disabled={job.busy || !online}
          onClick={() => void job.run(() => actions.loadMoreSessions())}
        >
          {job.busy ? "正在加载…" : "加载更早的会话记录"}
        </LoadMore>
      )}
    </section>
  );
}
