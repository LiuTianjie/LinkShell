import { useState } from "react";
import { useStore } from "zustand";
import { groupProjects } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
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
} from "./common";
import { sessionNeedsAttention, sessionPreview, waitingLabel } from "./session-list";
import { sessionTime } from "./session-time";
import { StatusText } from "./StatusText";
import { PageHeader } from "../components/PageHeader";
import type { Computer } from "./engine";
import { computerName, computerNames } from "./computer-names";
import { ProjectOverview, ProjectScopeChoice, projectScope, type ProjectSource } from "./project-overview";
import type { CrossComputerProject } from "./cross-computer-projects";
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

/** The all-computer index is independent of the selected computer's access state. */
export function AllProjects({ openComputerView }: { openComputerView: (computer: Computer, view: string) => void }) {
  return <ProjectOverview>{(sources, projects) => <AllProjectList sources={sources} projects={projects} openComputerView={openComputerView} />}</ProjectOverview>;
}

function AllProjectList({ sources, projects, openComputerView }: {
  sources: ProjectSource[]; projects: CrossComputerProject[]; openComputerView: (computer: Computer, view: string) => void;
}) {
  const names = useStore(computerNames.store);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const job = useJob();
  const needle = query.trim().toLocaleLowerCase();
  const byKey = new Map(sources.map((source) => [source.computer.key, source]));
  const shown = projects.filter((project) => !needle || project.members.some((member) =>
    `${project.name} ${member.project.cwd} ${member.project.branch ?? ""} ${computerName(byKey.get(member.computerKey)!.computer, names)}`.toLocaleLowerCase().includes(needle) ||
    member.project.sessions.some((session) => titleOf(session).toLocaleLowerCase().includes(needle))));
  const open = (computer: Computer) => openComputerView(computer, "projects");
  const online = sources.filter((source) => source.state?.status === "online" && source.connection);
  const pending = sources.some((source) => source.computer.machine.online && !source.state?.sessionsLoaded && !source.error && source.state?.status !== "locked" && !source.state?.sessionsError);
  return <div className="projects-overview projects-page flex min-w-0 flex-col gap-4">
    <PageHeader title="所有电脑的项目" detail={`${shown.length} 个项目`} actions={<>
      <ProjectScopeChoice />
      <InputGroup className="page-search">
        <InputGroupAddon><Search /></InputGroupAddon>
        <InputGroupInput aria-label="搜索项目" placeholder="搜索项目、电脑或会话" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <InputGroupAddon align="inline-end"><InputGroupButton aria-label="清除项目搜索" size="icon-xs" onClick={() => setQuery("")}><X /></InputGroupButton></InputGroupAddon>}
      </InputGroup>
      <Button variant="ghost" size="icon" aria-label="刷新项目" disabled={job.busy || !online.length}
        onClick={() => void job.run(() => Promise.all(online.map((source) => source.connection!.store.getState().refresh())))}>
        <RefreshCw className={job.busy ? "animate-spin" : undefined} />
      </Button>
    </>} />
    <ErrorNotice error={job.error} />
    <div className="project-list">
      {shown.map((project) => <section key={project.key} className="project-group" aria-label={project.name}>
        <div className="project-row">
          {project.generated ? <MessageSquare className="project-icon" aria-hidden /> : <Layers3 className="project-icon" aria-hidden />}
          <div className="project-copy"><h2>{project.name} {project.generated && <Badge variant="secondary">自动创建</Badge>}</h2></div>
          <span className="project-meta">{new Set(project.members.map((member) => member.computerKey)).size} 台电脑</span>
        </div>
        {project.members.map((member) => {
          const source = byKey.get(member.computerKey)!;
          const memberKey = `${member.computerKey}:${member.project.key}`;
          const sessions = needle || expanded[memberKey] ? member.project.sessions : member.project.sessions.slice(0, 3);
          return <div key={memberKey} className="project-computer">
            <div className="project-computer-heading">
              <Button variant="ghost" size="sm" onClick={() => open(source.computer)}>{computerName(source.computer, names)}</Button>
              <span className="project-computer-path" title={member.project.cwd}>{member.project.cwd}</span>
              {member.project.branch && <span className="project-branch"><GitBranch aria-hidden />{member.project.branch}</span>}
            </div>
            {sessions.length ? <div className="project-sessions">
              {sessions.map((session) => <ProjectSession key={session.id} session={session} navigate={(id) => openComputerView(source.computer, id)} />)}
              {!needle && member.project.sessions.length > 3 && <button type="button" className="project-more" aria-expanded={!!expanded[memberKey]}
                onClick={() => setExpanded((current) => ({ ...current, [memberKey]: !current[memberKey] }))}>
                <ChevronDown aria-hidden data-open={expanded[memberKey] || undefined} />{expanded[memberKey] ? "收起" : `其余 ${member.project.sessions.length - 3} 个会话`}
              </button>}
            </div> : <p className="project-empty">已加载的记录里没有这个项目的会话。</p>}
          </div>;
        })}
      </section>)}
    </div>
    {sources.map((source) => {
      const issue = source.error ?? (source.state?.status === "locked" ? "需要输入访问密码" : source.state?.sessionsError ?? (!source.computer.machine.online ? "电脑离线" : !source.state?.sessionsLoaded ? "正在读取项目…" : undefined));
      const more = source.state?.sessionsNextBefore !== undefined;
      if (!issue && !more) return null;
      return <div key={source.computer.key} className="project-computer-status">
        <span>{computerName(source.computer, names)}{issue && ` · ${issue}`}</span>
        {issue && <Button variant="outline" size="sm" onClick={() => open(source.computer)}>{source.state?.status === "locked" ? "输入访问密码" : "打开电脑"}</Button>}
        {more && <Button variant="outline" size="sm" disabled={job.busy || source.state?.status !== "online"}
          onClick={() => void job.run(() => source.connection!.store.getState().loadMoreSessions())}>加载更早的会话</Button>}
      </div>;
    })}
    {!shown.length && !pending && <EmptyState icon={needle ? <Search /> : <Layers3 />} title={needle ? "没有找到项目" : sources.length ? "还没有项目" : "还没有电脑"}
      description={needle ? "试试项目名称、电脑名称或会话标题。" : "连接电脑并新建会话后，项目会显示在这里。"}>
      {needle && <Button variant="outline" onClick={() => setQuery("")}>清除搜索</Button>}
    </EmptyState>}
  </div>;
}

function ProjectSession({ session, navigate }: { session: SessionSummary; navigate: (id: string) => void }) {
  return <button type="button" className="project-session" onClick={() => navigate(session.id)}>
    <AgentMark agent={session.agent} />
    <span className="project-session-title" title={titleOf(session)}>{titleOf(session)}</span>
    <span className="project-session-detail">{sessionPreview(session)}</span>
    {sessionNeedsAttention(session) ? <StatusText state="waiting" label={waitingLabel(session)} />
      : session.state !== "idle" ? <StatusText state={session.state} /> : <span />}
    <time dateTime={new Date(session.updatedAt).toISOString()}>{sessionTime(session.updatedAt)}</time>
  </button>;
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
                    <ProjectSession key={session.id} session={session} navigate={navigate} />
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
