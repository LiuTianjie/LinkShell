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
  LoadState,
  titleOf,
  useActions,
  useClient,
  useJob,
} from "./common";
import { sessionNeedsAttention } from "./session-list";
import { sessionTime } from "./session-time";
import { StatusText } from "./StatusText";

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
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">项目</h1>
          <p className="mt-1 text-[13px] text-[var(--secondaryLabel)]">
            按工作目录整理会话，随时接着上次的工作。
          </p>
        </div>
        <Button disabled={state.status !== "online"} onClick={() => create()}>
          <Plus data-icon="inline-start" />
          新建会话
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
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
        <span className="text-xs text-[var(--secondaryLabel)]">
          {projects.length} 个项目
        </span>
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          aria-label="刷新项目"
          title="刷新项目"
          disabled={job.busy || state.status !== "online"}
          onClick={() => void job.run(() => actions.refresh())}
        >
          <RefreshCw className={job.busy ? "animate-spin" : undefined} />
        </Button>
      </div>
      <ErrorNotice error={state.sessionsError ?? job.error} />
      {!state.sessionsLoaded && !state.sessionsError && <LoadState loading />}
      <div>
        {projects.map((project) => {
          const shown =
            query.trim() || expanded[project.cwd]
              ? project.sessions
              : project.sessions.slice(0, 3);
          return (
            <section
              key={project.cwd}
              className="project-card border-t border-[var(--separator)] py-3"
            >
              <div className="flex items-center gap-3 px-3">
                <Folder className="size-4 shrink-0 text-[var(--secondaryLabel)]" />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[13px] font-semibold">
                    {project.name}
                  </h2>
                  <p
                    className="truncate font-mono text-xs text-[var(--tertiaryLabel)]"
                    title={project.cwd}
                  >
                    {project.cwd}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-3 text-xs text-[var(--secondaryLabel)] sm:flex">
                  {project.branch && (
                    <span
                      className="flex max-w-40 items-center gap-1 truncate"
                      title={project.branch}
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      {project.branch}
                    </span>
                  )}
                  <span>{project.sessionCount} 个会话</span>
                  <time dateTime={new Date(project.lastActiveAt).toISOString()}>
                    更新于{sessionTime(project.lastActiveAt)}
                  </time>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.status !== "online"}
                  onClick={() => create(project.cwd)}
                >
                  <Plus data-icon="inline-start" />
                  新建会话
                </Button>
              </div>
              {shown.length ? (
                <div className="mt-2">
                  {shown.map((session) => (
                    <Button
                      key={session.id}
                      variant="ghost"
                      size="plain"
                      className="list-row w-full justify-start rounded-none text-left font-normal"
                      onClick={() => navigate(session.id)}
                    >
                      <AgentMark agent={session.agent} />
                      <strong
                        className="list-row-title"
                        title={titleOf(session)}
                      >
                        {titleOf(session)}
                      </strong>
                      <span className="list-row-detail">
                        {session.activity?.title ??
                          session.preview ??
                          "打开会话继续工作"}
                      </span>
                      <span className="list-row-status">
                        <StatusText
                          state={
                            sessionNeedsAttention(session)
                              ? "waiting"
                              : session.state
                          }
                        />
                      </span>
                      <time
                        className="list-row-meta w-14 text-right"
                        dateTime={new Date(session.updatedAt).toISOString()}
                      >
                        {sessionTime(session.updatedAt)}
                      </time>
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="px-3 pt-2 text-[13px] text-[var(--secondaryLabel)]">
                  当前已加载的记录中没有会话。可以新建会话，或在会话概览加载更早记录。
                </p>
              )}
              {project.sessions.length > 3 && !query.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 ml-1"
                  aria-expanded={!!expanded[project.cwd]}
                  onClick={() =>
                    setExpanded((current) => ({
                      ...current,
                      [project.cwd]: !current[project.cwd],
                    }))
                  }
                >
                  <ChevronDown
                    data-icon="inline-start"
                    className={expanded[project.cwd] ? "rotate-180" : undefined}
                  />
                  {expanded[project.cwd]
                    ? "收起会话"
                    : `查看其余 ${project.sessions.length - 3} 个会话`}
                </Button>
              )}
            </section>
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
