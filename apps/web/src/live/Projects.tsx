import { useState } from "react";
import { Folder, GitBranch, Plus, Search, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  AgentMark,
  Badge,
  EmptyState,
  ErrorNotice,
  LoadState,
  titleOf,
  useActions,
  useClient,
  useJob,
} from "./common";
import { sessionNeedsAttention } from "./session-list";
import { sessionTime } from "./session-time";

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
  return (
    <section className="projects-page">
      <div className="page-heading">
        <div>
          <h1>项目</h1>
          <p className="muted">按工作目录整理会话，随时接着上次的工作。</p>
        </div>
        <Button disabled={state.status !== "online"} onClick={() => create()}>
          <Plus data-icon="inline-start" />
          新建会话
        </Button>
      </div>
      <div className="resource-list-controls">
        <InputGroup className="max-w-md">
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
              <InputGroupButton
                aria-label="清除项目搜索"
                size="icon-xs"
                onClick={() => setQuery("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <span className="muted">{projects.length} 个项目</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={job.busy || state.status !== "online"}
          onClick={() => void job.run(() => actions.refresh())}
        >
          {job.busy ? "正在刷新…" : "刷新"}
        </Button>
      </div>
      <ErrorNotice error={state.sessionsError ?? job.error} />
      {!state.sessionsLoaded && !state.sessionsError && <LoadState loading />}
      <div className="project-list">
        {projects.map((project) => {
          const shown =
            query.trim() || expanded[project.cwd]
              ? project.sessions
              : project.sessions.slice(0, 3);
          return (
            <Card key={project.cwd} className="project-card">
              <CardHeader>
                <CardTitle className="project-title">
                  <Folder />
                  <span>{project.name}</span>
                </CardTitle>
                <CardDescription
                  className="project-directory"
                  title={project.cwd}
                >
                  {project.cwd}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.status !== "online"}
                    onClick={() => create(project.cwd)}
                  >
                    <Plus data-icon="inline-start" />
                    新建会话
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="project-metadata">
                  {project.branch && (
                    <span title={project.branch}>
                      <GitBranch />
                      {project.branch}
                    </span>
                  )}
                  <span>{project.sessionCount} 个会话</span>
                  <time dateTime={new Date(project.lastActiveAt).toISOString()}>
                    更新于{sessionTime(project.lastActiveAt)}
                  </time>
                </div>
                {shown.length ? (
                  <div className="project-sessions">
                    {shown.map((session) => (
                      <Button
                        key={session.id}
                        variant="ghost"
                        size="plain"
                        className="project-session-row"
                        onClick={() => navigate(session.id)}
                      >
                        <AgentMark agent={session.agent} />
                        <span className="project-session-copy">
                          <strong title={titleOf(session)}>
                            {titleOf(session)}
                          </strong>
                          <small>
                            {session.activity?.title ??
                              session.preview ??
                              "打开会话继续工作"}
                          </small>
                        </span>
                        <Badge
                          state={
                            sessionNeedsAttention(session)
                              ? "waiting"
                              : session.state
                          }
                        />
                        <time
                          dateTime={new Date(session.updatedAt).toISOString()}
                        >
                          {sessionTime(session.updatedAt)}
                        </time>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="project-empty muted">
                    当前已加载的记录中没有会话。可以新建会话，或在会话概览加载更早记录。
                  </p>
                )}
                {project.sessions.length > 3 && !query.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="project-expand"
                    aria-expanded={!!expanded[project.cwd]}
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [project.cwd]: !current[project.cwd],
                      }))
                    }
                  >
                    <ChevronDown data-icon="inline-start" />
                    {expanded[project.cwd]
                      ? "收起会话"
                      : `查看其余 ${project.sessions.length - 3} 个会话`}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {state.sessionsLoaded && !projects.length && (
        <EmptyState
          title={needle ? "没有找到项目" : "还没有项目"}
          description={
            needle
              ? "试试项目名称、目录路径或会话标题。"
              : "在一个工作目录中创建会话后，项目会自动出现在这里。"
          }
        >
          {needle ? (
            <Button variant="outline" onClick={() => setQuery("")}>
              清除搜索
            </Button>
          ) : (
            <Button
              disabled={state.status !== "online"}
              onClick={() => create()}
            >
              新建会话
            </Button>
          )}
        </EmptyState>
      )}
      {state.sessionsNextBefore !== undefined && (
        <Button
          variant="outline"
          disabled={job.busy || state.status !== "online"}
          onClick={() => void job.run(() => actions.loadMoreSessions())}
        >
          {job.busy ? "正在加载…" : "加载更早的会话记录"}
        </Button>
      )}
    </section>
  );
}
