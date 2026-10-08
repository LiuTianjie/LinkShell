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
  LoadState,
  Modal,
  useActions,
  useClient,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { Diff, Timeline } from "./Timeline";

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
                <div className="flex min-w-0 flex-col gap-1">
                  <strong>
                    /{command.name}
                    {command.hint && <small> {command.hint}</small>}
                  </strong>
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
  const online = useClient((state) => state.status === "online");
  const job = useJob();
  return (
    <div className="settings-panel">
      <h3>会话设置</h3>
      <p className="muted">
        {session.agent} · {session.cwd}
      </p>
      <FieldGroup>
        {view?.config.map((option) => (
          <Field key={option.id} data-disabled={!online || job.busy}>
            <FieldLabel htmlFor={`config-${option.id}`}>
              {option.name}
            </FieldLabel>
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
                  value.name +
                  (value.description ? ` · ${value.description}` : ""),
              }))}
            />
          </Field>
        ))}
      </FieldGroup>
      {!view?.config.length && (
        <p className="muted">当前 Agent 尚未提供可调整的配置。</p>
      )}
      <ErrorNotice error={job.error} />
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
      <h3>文件变更</h3>
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
  const online = useClient((state) => state.status === "online");
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
              <button
                className="button secondary"
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
              </button>
            )}
            <button
              className="button secondary"
              disabled={disabled}
              onClick={async () => {
                if (await dialogs.confirm("清除当前持续目标？"))
                  void job.run(() => change({ action: "clear" }));
              }}
            >
              清除目标
            </button>
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
            <textarea
              id="goal-objective"
              value={objective}
              onChange={(event) => {
                setEditing(true);
                setObjective(event.target.value);
              }}
              rows={4}
              required
              maxLength={codex ? 4000 : undefined}
              placeholder="你希望 Agent 持续完成什么？"
            />
          </Field>
          {codex && (
            <Field>
              <FieldLabel htmlFor="goal-budget">Token 预算（可选）</FieldLabel>
              <input
                id="goal-budget"
                type="number"
                min="1"
                step="1"
                value={budget}
                onChange={(event) => {
                  setEditing(true);
                  setBudget(event.target.value);
                }}
              />
            </Field>
          )}
          <button
            className="button primary"
            disabled={disabled || !objective.trim()}
          >
            {goal ? "更新目标" : "设置目标"}
          </button>
        </FieldGroup>
      </form>
      {!codex && (
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => void job.run(() => change({ action: "get" }))}
        >
          查询当前目标
        </button>
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
      <ErrorNotice error={job.error} />
      <div className="activity-list">
        {(records
          ? Object.values(records).sort((a, b) => b.startedAt - a.startedAt)
          : (loaded.value?.tasks ?? [])
        ).map((task) => (
          <article key={task.id}>
            <button
              onClick={() => {
                setSelected({ kind: "task", id: task.id });
              }}
            >
              <Badge state={task.state} />
              <strong>{task.title}</strong>
              <small>{task.command}</small>
            </button>
            {task.state === "running" && (
              <button
                className="text-button"
                onClick={() =>
                  void job.run(async () => {
                    await actions.stopTask(session.id, task.id);
                    loaded.reload();
                  })
                }
              >
                停止任务
              </button>
            )}
          </article>
        ))}
        {loaded.value?.subagents.map((agent) => (
          <article key={agent.toolCallId}>
            <button
              onClick={() =>
                setSelected({ kind: "agent", id: agent.toolCallId })
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
            </button>
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
          <p className="muted">尚无后台任务或子 Agent。</p>
        )}
      {selected?.kind === "task" && (
        <TaskOutput
          key={selected.id}
          sessionId={session.id}
          taskId={selected.id}
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
        <button
          className="text-button"
          onClick={() => {
            setSnapshot(undefined);
            output.reload();
          }}
        >
          刷新
        </button>
      </div>
      <LoadState
        loading={!current && output.loading}
        error={output.error ?? job.error}
      />
      {!!current?.start && (
        <button
          className="text-button"
          disabled={job.busy}
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
        </button>
      )}
      <pre>{current?.text || (current ? "没有可读的输出" : "加载中…")}</pre>
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
  const online = useClient((state) => state.status === "online");
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
          <button
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
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
            <button
              className="text-button"
              onClick={() => open(agent.toolCallId!)}
            >
              查看会话
            </button>
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
  const loaded = useLoad(() => actions.listWorktrees(), [store]);
  return (
    <section>
      <h2>工作目录与分支</h2>
      <LoadState {...loaded} />
      <ErrorNotice error={job.error} />
      {loaded.value?.map((entry) => (
        <article className="notice-card" key={entry.path}>
          <strong>{entry.branch}</strong>
          <p>{entry.path}</p>
          <p className="muted">
            {entry.sessions.length} 个会话 ·{" "}
            {entry.dirty ? "有未提交改动" : "工作区干净"} · {entry.ahead}{" "}
            个新提交
          </p>
          <button
            className="button secondary"
            disabled={entry.sessions.length > 0 || job.busy}
            onClick={async () => {
              const force = entry.dirty || entry.ahead > 0;
              if (
                await dialogs.confirm(
                  force
                    ? "此 worktree 有未提交改动或新提交。确定永久删除它及分支？"
                    : "移除此 worktree 及分支？",
                )
              )
                void job.run(async () => {
                  await actions.removeWorktree(entry.path, force);
                  loaded.reload();
                });
            }}
          >
            移除 worktree
          </button>
        </article>
      ))}
      {loaded.value?.length === 0 && (
        <p className="muted">尚无由 LinkShell 创建的 worktree。</p>
      )}
    </section>
  );
}
