import { useState } from "react";
import { Folder, GitBranch, Plus, Search, ChevronDown, RefreshCw, X } from "lucide-react";
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
import { sessionNeedsAttention, sessionPreview } from "./session-list";
import { sessionTime } from "./session-time";
import { StatusText } from "./StatusText";
import { PageHeader } from "../components/PageHeader";

export function Projects({
  create,
  navigate,
}: {
  create: (cwd?: string) => void;
  navigate: (id: string) => void;
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
  const projects = state.projects
    .map((project) => ({
      ...project,
      sessions: allSessions
        .filter(
          (session) =>
            (session.worktree?.source ?? session.cwd) === project.cwd,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
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
        title="项目"
        detail={state.sessionsLoaded ? `${projects.length} 个项目` : undefined}
        actions={<>
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
          <Button size="sm" disabled={!online} onClick={() => create()}>
            <Plus data-icon="inline-start" />
            新建会话
          </Button>
        </>}
      />
      <ErrorNotice error={state.sessionsError ?? job.error} />
      {!state.sessionsLoaded && !state.sessionsError && <LoadState loading />}
      <div className="project-list">
        {projects.map((project) => {
          const shown = query.trim() || expanded[project.cwd] ? project.sessions : project.sessions.slice(0, 3);
          return (
            <section key={project.cwd} className="project-group" aria-label={project.name}>
              <div className="project-row">
                <Folder className="project-icon" aria-hidden />
                <div className="project-copy">
                  <h2>{project.name}</h2>
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="project-new"
                  disabled={!online}
                  aria-label={`在 ${project.name} 中新建会话`}
                  onClick={() => create(project.cwd)}
                >
                  <Plus data-icon="inline-start" />
                  新建会话
                </Button>
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
                      aria-expanded={!!expanded[project.cwd]}
                      onClick={() => setExpanded((current) => ({ ...current, [project.cwd]: !current[project.cwd] }))}
                    >
                      <ChevronDown aria-hidden data-open={expanded[project.cwd] || undefined} />
                      {expanded[project.cwd] ? "收起" : `其余 ${project.sessions.length - 3} 个会话`}
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
          icon={needle ? <Search /> : <Folder />}
          title={needle ? "没有找到项目" : "还没有项目"}
          description={needle ? "试试项目名称、目录路径或会话标题。" : "在一个工作目录里新建会话，项目会出现在这里。"}
        >
          {needle ? (
            <Button variant="outline" onClick={() => setQuery("")}>清除搜索</Button>
          ) : (
            <Button disabled={!online} onClick={() => create()}>新建会话</Button>
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
