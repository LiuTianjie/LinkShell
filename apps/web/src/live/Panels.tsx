import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogs } from "@/components/Dialogs";
import { Choice } from "../components/Choice";
import {
  Command as CommandUI,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { useEffect, useState } from "react";
import { subagentKey, type SessionView } from "@linkshell/client-core";
import type {
  GoalChange,
  SessionSummary,
  Workflow as WorkflowData,
} from "@linkshell/wire";
import {
  matchCommands,
  commandDetail,
  type Command,
} from "../../../client/src/lib/commands";
import {
  Badge,
  ErrorNotice,
  EmptyState,
  LoadState,
  Modal,
  useActions,
  useClient,
  useSessionOnline,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { Diff, Timeline } from "./Timeline";
import { AcpSettings } from "./Acp";
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";

export function Commands({
  commands,
  choose,
  close,
  returnFocus,
}: {
  commands: Command[];
  returnFocus: () => void;
  choose: (command: Command) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = matchCommands(commands, query);
  return (
    <Modal title="命令与技能" close={close} returnFocus={returnFocus}>
      <CommandUI shouldFilter={false}>
        <CommandInput
          aria-label="搜索命令"
          placeholder="搜索命令或 Skills"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {commands.length
              ? "没有匹配的命令"
              : "Agent 尚未报告命令，连接或接管后会自动更新。"}
          </CommandEmpty>
          <CommandGroup>
            {shown.map((command) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => choose(command)}
              >
                <div className="command-option flex min-w-0 flex-col gap-0.5">
                  <span className="command-option-name">
                    <strong>/{command.name}</strong>
                    {command.hint && <small>{command.hint}</small>}
                  </span>
                  <span className="text-muted-foreground">
                    {commandDetail(command)}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandUI>
    </Modal>
  );
}
export function Settings({
  session,
  view,
}: {
  session: SessionSummary;
  view?: SessionView;
}) {
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const acp = useClient(
    (state) =>
      state.machine?.agents.find((agent) => agent.id === session.agent)
        ?.capabilities.acp,
  );
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="settings-panel">
      <p className="muted">
        {session.agent} · {session.cwd}
      </p>
      <FieldGroup>
        {view?.config.map((option) => (
          <Field key={option.id} data-disabled={!online || job.busy}>
            <FieldLabel htmlFor={`config-${option.id}`}>
              {option.name}
            </FieldLabel>
            {option.description && (
              <p className="muted">{option.description}</p>
            )}
            {option.type === "boolean" ? (
              <Checkbox
                id={`config-${option.id}`}
                checked={option.current === "on"}
                disabled={!online || job.busy}
                onCheckedChange={(checked) =>
                  void job.run(() =>
                    actions.setConfig(
                      session.id,
                      option.id,
                      checked === true ? "on" : "off",
                    ),
                  )
                }
              />
            ) : (
              <Choice
                id={`config-${option.id}`}
                label={option.name}
                value={option.current}
                disabled={!online || job.busy}
                onValueChange={(value) =>
                  void job.run(() =>
                    actions.setConfig(session.id, option.id, value),
                  )
                }
                options={option.values.map((value) => ({
                  value: value.value,
                  label:
                    (value.group ? `${value.group} · ` : "") +
                    value.name +
                    (value.description ? ` · ${value.description}` : ""),
                }))}
              />
            )}
          </Field>
        ))}
      </FieldGroup>
      {!view?.config.length && (
        <p className="muted">当前 Agent 尚未提供可调整的配置。</p>
      )}
      <ErrorNotice error={job.error} />
      {view?.usage?.tokens && (
        <p className="muted">
          输入 {view.usage.tokens.inputTokens.toLocaleString()} · 输出{" "}
          {view.usage.tokens.outputTokens.toLocaleString()} · 总计{" "}
          {view.usage.tokens.totalTokens.toLocaleString()} tokens
        </p>
      )}
      {view?.usage?.cost && (
        <p className="muted">
          累计费用 {view.usage.cost.currency}{" "}
          {view.usage.cost.amount.toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })}
        </p>
      )}
      {acp && (
        <Button
          variant="outline"
          onClick={() => setAdvanced((value) => !value)}
        >
          会话工具与附加目录
        </Button>
      )}
      {advanced && <AcpSettings agent={session.agent} sessionId={session.id} />}
    </div>
  );
}
export function Changes({ view }: { view?: SessionView }) {
  const changes =
    view?.items.flatMap((item) =>
      item.kind === "tool" && item.status !== "failed"
        ? item.content.filter(
            (content) => content.type === "diff" || content.type === "patch",
          )
        : [],
    ) ?? [];
  return (
    <section>
      <p className="muted">
        来自已加载的会话记录；加载更早历史可查看更多变更。
      </p>
      {changes.map(
        (change, index) =>
          (change.type === "diff" || change.type === "patch") && (
            <Diff key={index} change={change} />
          ),
      )}
      {!changes.length && <p className="muted">当前没有已报告的文件变更。</p>}
    </section>
  );
}
export function Goal({
  session,
  view,
}: {
  session: SessionSummary;
  view?: SessionView;
}) {
  const dialogs = useDialogs();
  const { link } = useConnection();
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const codex = session.agent === "codex";
  const readOnly = codex && session.driver === "desktop";
  const disabled = job.busy || !online || readOnly;
  const load = useLoad(
    async () =>
      codex && online
        ? link.call("sessions.goal", {
            sessionId: session.id,
            change: { action: "get" },
          })
        : { goal: null },
    [link, session.id, codex, online],
  );
  const goal = view?.goal === undefined ? load.value?.goal : view.goal;
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!editing) {
      setObjective(goal?.objective ?? "");
      setBudget(goal?.tokenBudget?.toString() ?? "");
    }
  }, [goal?.objective, goal?.tokenBudget, editing]);
  async function change(change: GoalChange) {
    if (disabled) return;
    if (codex) {
      await link.call("sessions.goal", { sessionId: session.id, change });
      load.reload();
    } else {
      const text =
        change.action === "set"
          ? `/goal ${change.objective}`
          : change.action === "clear"
            ? "/goal clear"
            : "/goal";
      const result = await actions.send(session.id, [{ type: "text", text }], {
        now: true,
      });
      if (result === "failed") throw new Error("目标命令未发送成功，请重试");
      setNotice("已发送目标命令，执行结果会显示在会话中。");
    }
    setEditing(false);
  }
  return (
    <section className="settings-panel">
      <h3>持续目标</h3>
      <LoadState {...load} />
      {load.error && (
        <Button
          variant="outline"
          size="sm"
          disabled={!online || load.loading}
          onClick={load.reload}
        >
          重新加载目标
        </Button>
      )}
      {goal && (
        <div className="notice-card">
          <Badge state={goal.status} />
          <p>{goal.objective}</p>
          <small>
            已用 {goal.tokensUsed ?? "—"} tokens
            {goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""} ·{" "}
            {goal.iterations ?? 0} 轮
          </small>
          {goal.lastReason && <p>{goal.lastReason}</p>}
          <div className="permission-buttons">
            {codex && (
              <Button
                variant="outline"
                disabled={
                  disabled ||
                  ["complete", "budgetLimited"].includes(goal.status)
                }
                onClick={() =>
                  void job.run(() =>
                    change({
                      action: goal.status === "active" ? "pause" : "resume",
                    }),
                  )
                }
              >
                {goal.status === "active" ? "暂停" : "继续"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                if (await dialogs.confirm("清除当前持续目标？"))
                  void job.run(() => change({ action: "clear" }));
              }}
            >
              清除目标
            </Button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void job.run(() =>
            change({
              action: "set",
              objective: objective.trim(),
              ...(budget ? { tokenBudget: Number(budget) } : {}),
            }),
          );
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="goal-objective">目标</FieldLabel>
            <Textarea
              id="goal-objective"
              value={objective}
              onChange={(event) => {
                setEditing(true);
                setObjective(event.target.value);
              }}
              rows={4}
              required
              maxLength={codex ? 4000 : undefined}
              disabled={disabled}
              placeholder="你希望 Agent 持续完成什么？"
            />
          </Field>
          {codex && (
            <Field>
              <FieldLabel htmlFor="goal-budget">Token 预算（可选）</FieldLabel>
              <Input
                id="goal-budget"
                type="number"
                min="1"
                step="1"
                disabled={disabled}
                value={budget}
                onChange={(event) => {
                  setEditing(true);
                  setBudget(event.target.value);
                }}
              />
            </Field>
          )}
          <Button variant="default" disabled={disabled || !objective.trim()}>
            {goal ? "更新目标" : "设置目标"}
          </Button>
        </FieldGroup>
      </form>
      {!codex && (
        <Button
          variant="link"
          size="sm"
          disabled={disabled}
          onClick={() => void job.run(() => change({ action: "get" }))}
        >
          查询当前目标
        </Button>
      )}
      {readOnly && (
        <p className="muted">会话由电脑端控制，请在电脑端修改目标。</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ErrorNotice error={job.error} />
    </section>
  );
}
export function Tasks({
  session,
  onFile,
  onTerminal,
}: {
  session: SessionSummary;
  onFile: (path: string) => void;
  onTerminal: (id: string) => void;
}) {
  const actions = useActions();
  const { store } = useConnection();
  const online = useSessionOnline();
  const records = useClient((state) => state.tasks[session.id]);
  const workflows = useClient((state) => state.workflows[session.id]);
  const job = useJob();
  const loaded = useLoad(
    async () => ({
      tasks: await actions.loadTasks(session.id),
      subagents: await actions.loadSubagents(session.id),
    }),
    [store, session.id],
    5000,
  );
  const [selected, setSelected] = useState<{
    kind: "task" | "agent";
    id: string;
  }>();
  return (
    <section>
      <h3>后台任务、子 Agent 与工作流</h3>
      <LoadState {...loaded} />
      {loaded.error && (
        <Button
          variant="outline"
          size="sm"
          disabled={!online || loaded.loading}
          onClick={loaded.reload}
        >
          重新加载任务
        </Button>
      )}
      <ErrorNotice error={job.error} />
      <div className="activity-list">
        {(records
          ? Object.values(records).sort((a, b) => b.startedAt - a.startedAt)
          : (loaded.value?.tasks ?? [])
        ).map((task) => (
          <article
            key={task.id}
            data-selected={
              (selected?.kind === "task" && selected.id === task.id) ||
              undefined
            }
          >
            <Button
              variant="ghost"
              size="plain"
              aria-expanded={
                selected?.kind === "task" && selected.id === task.id
              }
              onClick={() =>
                setSelected((current) =>
                  current?.kind === "task" && current.id === task.id
                    ? undefined
                    : { kind: "task", id: task.id },
                )
              }
            >
              <Badge state={task.state} />
              <strong>{task.title}</strong>
              <small>{task.command}</small>
            </Button>
            {task.state === "running" && (
              <Button
                variant="link"
                size="sm"
                disabled={!online || job.busy}
                onClick={() =>
                  void job.run(async () => {
                    await actions.stopTask(session.id, task.id);
                    loaded.reload();
                  })
                }
              >
                停止任务
              </Button>
            )}
            {selected?.kind === "task" && selected.id === task.id && (
              <TaskOutput
                key={task.id}
                sessionId={session.id}
                taskId={task.id}
              />
            )}
          </article>
        ))}
        {loaded.value?.subagents.map((agent) => (
          <article
            key={agent.toolCallId}
            data-selected={
              (selected?.kind === "agent" &&
                selected.id === agent.toolCallId) ||
              undefined
            }
          >
            <Button
              variant="ghost"
              size="plain"
              aria-expanded={
                selected?.kind === "agent" && selected.id === agent.toolCallId
              }
              onClick={() =>
                setSelected((current) =>
                  current?.kind === "agent" &&
                  current.id === agent.toolCallId
                    ? undefined
                    : { kind: "agent", id: agent.toolCallId },
                )
              }
            >
              <Badge
                state={
                  agent.state ??
                  (agent.running
                    ? "running"
                    : agent.failed
                      ? "failed"
                      : "completed")
                }
              />
              <strong>{agent.task}</strong>
              <small>
                {agent.agentType ?? (agent.workflow ? "工作流" : "子 Agent")}
              </small>
            </Button>
            {(workflows?.[agent.toolCallId]?.workflow ?? agent.workflow) && (
              <Workflow
                workflow={
                  workflows?.[agent.toolCallId]?.workflow ?? agent.workflow!
                }
                open={(id) => {
                  setSelected({ kind: "agent", id });
                }}
              />
            )}
          </article>
        ))}
        {Object.values(workflows ?? {})
          .filter(
            (record) =>
              !loaded.value?.subagents.some(
                (agent) => agent.toolCallId === record.toolCallId,
              ),
          )
          .map((record) => (
            <article key={record.toolCallId}>
              <strong>{record.task}</strong>
              <Workflow
                workflow={record.workflow}
                open={(id) => setSelected({ kind: "agent", id })}
              />
            </article>
          ))}
      </div>
      {loaded.value &&
        !loaded.value.tasks.length &&
        !loaded.value.subagents.length &&
        !Object.keys(workflows ?? {}).length && (
          <EmptyState
            title="没有后台任务"
            description="Agent 启动后台命令或子 Agent 后，会在这里显示状态与输出。"
          />
        )}
      {selected?.kind === "agent" && (
        <SubagentConversation
          key={selected.id}
          session={session}
          id={selected.id}
          onFile={onFile}
          onTerminal={onTerminal}
        />
      )}
    </section>
  );
}
function TaskOutput({
  sessionId,
  taskId,
}: {
  sessionId: string;
  taskId: string;
}) {
  const actions = useActions();
  const { store } = useConnection();
  const online = useSessionOnline();
  const running = useClient(
    (state) => state.tasks[sessionId]?.[taskId]?.state === "running",
  );
  const [snapshot, setSnapshot] =
    useState<Awaited<ReturnType<typeof actions.loadTaskOutput>>>();
  const output = useLoad(
    () => actions.loadTaskOutput(sessionId, taskId),
    [store, sessionId, taskId],
    running && !snapshot ? 2000 : 0,
  );
  const current = snapshot ?? output.value;
  const job = useJob();
  return (
    <div className="task-output">
      <div className="browser-toolbar">
        <strong>任务输出</strong>
        <Button
          variant="link"
          size="sm"
          disabled={!online || output.loading}
          onClick={() => {
            setSnapshot(undefined);
            output.reload();
          }}
        >
          刷新
        </Button>
      </div>
      <LoadState
        loading={!current && output.loading}
        error={output.error ?? job.error}
      />
      {!!current?.start && (
        <Button
          variant="link"
          size="sm"
          disabled={!online || job.busy}
          onClick={() => {
            setSnapshot(current);
            void job.run(async () => {
              const page = await actions.loadTaskOutput(
                sessionId,
                taskId,
                current.start,
              );
              setSnapshot({
                ...current,
                text: page.text + current.text,
                start: page.start,
              });
            });
          }}
        >
          加载更早输出
        </Button>
      )}
      {current && (
        <pre tabIndex={0} aria-label="任务输出">
          {current.text || "没有可读的输出"}
        </pre>
      )}
    </div>
  );
}
function SubagentConversation({
  session,
  id,
  onFile,
  onTerminal,
}: {
  session: SessionSummary;
  id: string;
  onFile: (path: string) => void;
  onTerminal: (id: string) => void;
}) {
  const { store } = useConnection();
  const online = useSessionOnline();
  const ready = useClient((state) => state.ready[session.id]);
  const sub = useClient(
    (state) => state.subagentViews[subagentKey(session.id, id)],
  );
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online || !ready) return;
    let alive = true;
    setMissing(false);
    void store
      .getState()
      .openSubagent(session.id, id)
      .then((opened) => {
        if (alive) setMissing(!opened);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
      store.getState().closeSubagent(session.id, id);
    };
  }, [store, session.id, id, online, ready, attempt]);
  return (
    <div>
      <h3>子 Agent 会话</h3>
      {sub ? (
        <Timeline
          items={sub.items}
          sessionId={session.id}
          agent={session.agent}
          onFile={onFile}
          onTerminal={onTerminal}
        />
      ) : missing ? (
        <div role="alert">
          <p>未能读取子 Agent 会话，它可能已关闭或暂时不可用。</p>
          <Button
            variant="link"
            size="sm"
            disabled={!online}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        <p className="muted">{online ? "正在加载…" : "等待电脑重新连接…"}</p>
      )}
    </div>
  );
}
function Workflow({
  workflow,
  open,
}: {
  workflow: WorkflowData;
  open: (id: string) => void;
}) {
  return (
    <details className="workflow-panel">
      <summary>
        {workflow.name ?? "工作流"} · {workflow.completed ?? 0} /{" "}
        {workflow.started ?? workflow.agents?.length ?? 0} 已完成
      </summary>
      <div className="browser-toolbar">
        {workflow.state && <Badge state={workflow.state} />}
        <small>
          {workflow.tokens ?? 0} tokens
          {workflow.durationMs !== undefined
            ? ` · ${Math.round(workflow.durationMs / 1000)} 秒`
            : ""}
        </small>
      </div>
      {workflow.phases?.map((phase) => (
        <div className="workflow-phase" key={phase.id}>
          {phase.order + 1}. {phase.title}
        </div>
      ))}
      {workflow.agents?.map((agent) => (
        <div className="workflow-agent" key={agent.id}>
          <Badge state={agent.state} />
          <strong>{agent.title}</strong>
          <small>
            {agent.model ?? ""}
            {agent.tokens !== undefined ? ` · ${agent.tokens} tokens` : ""}
            {agent.toolCalls !== undefined
              ? ` · ${agent.toolCalls} 次工具调用`
              : ""}
          </small>
          {agent.result && <p>{agent.result}</p>}
          {agent.toolCallId && (
            <Button
              variant="link"
              size="sm"
              onClick={() => open(agent.toolCallId!)}
            >
              查看会话
            </Button>
          )}
        </div>
      ))}
    </details>
  );
}
export function Worktrees() {
  const dialogs = useDialogs();
  const actions = useActions();
  const { store } = useConnection();
  const job = useJob();
  const online = useSessionOnline();
  const [removing, setRemoving] = useState<string>();
  const loaded = useLoad(() => actions.listWorktrees(), [store]);
  return (
    <section className="worktrees-page">
      <div className="page-heading">
        <div>
          <h1>工作目录与分支</h1>
          <p className="muted">
            查看会话的独立工作目录，管理分支与未提交改动。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!online || loaded.loading || job.busy}
          onClick={loaded.reload}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
      </div>
      <LoadState {...loaded} />
      <ErrorNotice error={job.error} />
      {!online && (
        <p className="muted" role="status">
          电脑离线，暂时无法更新或移除工作目录。
        </p>
      )}
      <div className="worktree-list">
        {loaded.value?.map((entry) => (
          <article className="worktree-entry" key={entry.path}>
            <div className="worktree-info">
              <h2>
                <GitBranch aria-hidden="true" />
                {entry.branch || "未命名分支"}
              </h2>
              <p className="worktree-path" title={entry.path}>
                {entry.path}
              </p>
              <p className="worktree-meta">
                <span className={entry.dirty ? "is-dirty" : undefined}>
                  {entry.dirty ? "有未提交改动" : "工作区干净"}
                </span>
                <span>{entry.sessions.length} 个会话</span>
                <span>{entry.ahead} 个新提交</span>
              </p>
            </div>
            <div className="worktree-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={!online || entry.sessions.length > 0 || job.busy}
                title={
                  entry.sessions.length
                    ? "工作目录仍被会话使用，请先删除关联会话"
                    : "移除工作目录与分支"
                }
                onClick={async () => {
                  const force = entry.dirty || entry.ahead > 0;
                  if (
                    await dialogs.confirm(
                      force
                        ? `「${entry.branch}」有未提交改动或新提交。确定永久删除此工作目录及分支？\n${entry.path}`
                        : `移除「${entry.branch}」的工作目录及分支？\n${entry.path}`,
                    )
                  )
                    void job.run(async () => {
                      setRemoving(entry.path);
                      try {
                        await actions.removeWorktree(entry.path, force);
                        loaded.reload();
                      } finally {
                        setRemoving(undefined);
                      }
                    });
                }}
              >
                <Trash2 data-icon="inline-start" />
                {removing === entry.path ? "正在移除…" : "移除"}
              </Button>
              {entry.sessions.length > 0 && <small>会话使用中</small>}
            </div>
          </article>
        ))}
      </div>
      {loaded.value?.length === 0 && (
        <EmptyState
          icon={<GitBranch />}
          title="暂无独立工作目录"
          description="新建或分叉会话时选择 worktree，即可在独立分支中工作。"
        />
      )}
    </section>
  );
}
