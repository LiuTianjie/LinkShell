import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskRecords } from "@linkshell/client-core";
import {
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type BackgroundTask,
  type MachineInfo,
  type SessionGoal,
  type SideChat,
  type SubagentInfo,
} from "@linkshell/wire";
import type { Computer, Connection } from "../../core/connections";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  CollapsibleLog,
  EmptyState,
  IconButton,
  Input,
  useDialogs,
} from "../../primitives";
import type { ChangesStatsSummary } from "./ChangesPanel";
import { useInspectorI18n } from "./i18n-inspector";
import type { InspectorSessionActions } from "./use-inspector-connection";

export function countRunningTasksAndSubagents(
  _subagents: readonly SubagentInfo[],
  tasksMap: TaskRecords,
): number {
  let running = 0;
  for (const task of Object.values(tasksMap)) {
    if (task.state === "running") running++;
  }
  return running;
}

interface TaskOutputSnapshot {
  text: string;
  start: number;
  size: number;
  loading: boolean;
}

interface BackgroundTaskItemProps {
  task: BackgroundTask;
  actions?: InspectorSessionActions;
}

function BackgroundTaskItem({ task, actions }: BackgroundTaskItemProps) {
  const { ti } = useInspectorI18n();
  const dialogs = useDialogs();
  const [output, setOutput] = useState<TaskOutputSnapshot | null>(null);
  const [stopping, setStopping] = useState(false);

  const loadChunk = useCallback(
    async (before?: number) => {
      if (!actions) return;
      setOutput((prev) => ({
        text: prev?.text ?? "",
        start: prev?.start ?? 0,
        size: prev?.size ?? 0,
        loading: true,
      }));
      try {
        const res = await actions.loadTaskOutput(task.id, before);
        setOutput((prev) => ({
          text:
            before !== undefined && prev
              ? `${res.text}${prev.text}`
              : res.text,
          start: res.start,
          size: res.size,
          loading: false,
        }));
      } catch {
        setOutput((prev) => (prev ? { ...prev, loading: false } : null));
      }
    },
    [actions, task.id],
  );

  const handleStop = useCallback(async () => {
    if (!actions || stopping) return;
    setStopping(true);
    try {
      await actions.stopTask(task.id);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }, [actions, stopping, task.id, dialogs]);

  const tone =
    task.state === "running"
      ? "running"
      : task.state === "failed"
        ? "danger"
        : task.state === "completed"
          ? "ok"
          : "neutral";

  const logDisplayText = output?.text || task.summary || task.command || "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        minWidth: 0,
      }}
    >
      <CollapsibleLog
        style={{ flex: "1 1 auto", minWidth: 0 }}
        title={task.title || task.command || task.id}
        logText={logDisplayText}
        onOpenChange={(isOpen) => {
          if (isOpen && !output && actions) {
            void loadChunk();
          }
        }}
        meta={
          <Badge
            variant="tag"
            tone={tone}
            dot={
              tone === "running"
                ? "running"
                : tone === "danger"
                  ? "danger"
                  : tone === "ok"
                    ? "ok"
                    : "idle"
            }
            data-tabular=""
          >
            {task.exitCode !== undefined && task.state !== "running"
              ? `${task.state} (${task.exitCode})`
              : task.state}
          </Badge>
        }
      >
        {output && output.start > 0 ? (
          <div style={{ marginBottom: 6 }}>
            <Button
              size="xs"
              variant="ghost"
              loading={output.loading}
              onClick={() => {
                void loadChunk(output.start);
              }}
            >
              {ti("loadEarlierOutput")}
            </Button>
          </div>
        ) : null}
        <pre tabIndex={0} className="ls-collapsible-log__pre">
          {logDisplayText}
        </pre>
      </CollapsibleLog>

      {task.state === "running" && task.canStop !== false && actions ? (
        <IconButton
          icon="stop-square"
          size="icon-sm"
          variant="danger-ghost"
          loading={stopping}
          label={ti("stopTask")}
          onClick={() => {
            void handleStop();
          }}
        />
      ) : null}
    </div>
  );
}

export interface TasksPanelProps {
  computerKey?: string;
  computer?: Computer;
  machine?: MachineInfo;
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  diffStats?: ChangesStatsSummary;
  subagents: readonly SubagentInfo[];
  tasksMap: TaskRecords;
  sides?: readonly SideChat[];
  actions?: InspectorSessionActions;
  onSelectTab?: (tab: "changes" | "files" | "terminal") => void;
  onOpenTerminalAt?: (dir: string) => void;
}

export function TasksPanel({
  connection,
  online,
  sessionId,
  tasksMap,
  actions,
}: TasksPanelProps) {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();

  const [refreshingTasks, setRefreshingTasks] = useState(false);
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [goalSupported, setGoalSupported] = useState(true);
  const [goalDraft, setGoalDraft] = useState("");
  const [goalBusy, setGoalBusy] = useState(false);

  const loadGoal = useCallback(async () => {
    if (!connection || !online || !sessionId) return;
    try {
      const res = await connection.link.call("sessions.goal", {
        sessionId,
        change: { action: "get" },
      });
      setGoal(res.goal);
      setGoalSupported(true);
    } catch (err) {
      const errCode =
        err instanceof RpcError &&
        typeof err.data === "object" &&
        err.data !== null
          ? (err.data as { code?: string }).code
          : undefined;
      if (
        err instanceof RpcError &&
        (err.code === RPC_METHOD_NOT_FOUND || errCode === "not_supported")
      ) {
        setGoalSupported(false);
      }
    }
  }, [connection, online, sessionId]);

  const refreshAll = useCallback(async () => {
    if (!online) return;
    setRefreshingTasks(true);
    try {
      await Promise.allSettled([
        actions?.loadTasks(),
        loadGoal(),
      ]);
    } finally {
      setRefreshingTasks(false);
    }
  }, [actions, online, loadGoal]);

  useEffect(() => {
    if (!online || !sessionId) return;
    void refreshAll();
  }, [online, sessionId, refreshAll]);

  const sortedTasks = useMemo(
    () =>
      Object.values(tasksMap).sort((a, b) => b.startedAt - a.startedAt),
    [tasksMap],
  );

  const mutateGoal = useCallback(
    async (
      change:
        | { action: "set"; objective: string }
        | { action: "pause" }
        | { action: "resume" }
        | { action: "clear" },
    ) => {
      if (!connection || !sessionId || goalBusy) return;
      setGoalBusy(true);
      try {
        const res = await connection.link.call("sessions.goal", {
          sessionId,
          change,
        });
        setGoal(res.goal);
        if (change.action === "set") {
          setGoalDraft("");
        }
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setGoalBusy(false);
      }
    },
    [connection, sessionId, goalBusy, dialogs],
  );

  return (
    <div
      className="ls-tasks-panel inspector-panel-fill"
      data-testid="tasks-panel"
    >
      <div className="ls-tasks-bar">
        <div className="inspector-subbar-group" style={{ minInlineSize: 0 }}>
          <DesktopIcon name="activity" size="xs" />
          <span
            className="ls-truncate"
            style={{
              fontSize: "var(--ls-text-xs)",
              fontWeight: 600,
              color: "var(--ls-fg-2)",
            }}
          >
            {ti("activeTasksHeader")}
          </span>
          <Badge variant="count" tone="neutral">
            {sortedTasks.length}
          </Badge>
        </div>

        <IconButton
          icon="refresh"
          size="icon-sm"
          label={ti("refresh")}
          loading={refreshingTasks}
          disabled={!online || (!actions && !connection)}
          onClick={() => {
            void refreshAll();
          }}
        />
      </div>

      <div className="ls-tasks-body inspector-panel-scroll">
        {sortedTasks.length === 0 ? (
          <EmptyState
            compact
            icon="activity"
            title={online ? ti("noTasks") : ti("offlineTitle")}
            description={online ? undefined : ti("offlineDesc")}
          />
        ) : (
          <section className="inspector-section-card">
            <div className="inspector-section-header">
              <h3 className="inspector-section-title">
                <DesktopIcon name="activity" size="sm" />
                <span>{ti("backgroundTasksSection")}</span>
              </h3>
            </div>
            {sortedTasks.map((task) => (
              <BackgroundTaskItem
                key={task.id}
                task={task}
                actions={actions}
              />
            ))}
          </section>
        )}

        {sessionId && goalSupported ? (
          <section className="inspector-section-card">
            <div className="inspector-section-header">
              <h3 className="inspector-section-title">
                <DesktopIcon name="list-checks" size="sm" />
                <span>{ti("goalSection")}</span>
              </h3>
              {goal ? (
                <Badge
                  variant="tag"
                  tone={
                    goal.status === "active"
                      ? "running"
                      : goal.status === "complete"
                        ? "ok"
                        : "waiting"
                  }
                >
                  {goal.status}
                </Badge>
              ) : null}
            </div>

            {goal ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: "var(--ls-text-sm)" }}>
                  {goal.objective}
                </div>
                <div className="inspector-item-row">
                  <div className="inspector-subbar-group">
                    {goal.iterations !== undefined ? (
                      <Badge variant="tag" tone="neutral" data-tabular="">
                        {`#${goal.iterations}`}
                      </Badge>
                    ) : null}
                    {goal.tokensUsed !== undefined ? (
                      <Badge variant="tag" tone="neutral" data-tabular="">
                        {`${goal.tokensUsed.toLocaleString()} tok`}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="inspector-subbar-group">
                    {goal.status === "active" ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        leadingIcon="pause"
                        disabled={goalBusy}
                        onClick={() => {
                          void mutateGoal({ action: "pause" });
                        }}
                      >
                        {ti("pauseGoal")}
                      </Button>
                    ) : goal.status !== "complete" ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        leadingIcon="play"
                        disabled={goalBusy}
                        onClick={() => {
                          void mutateGoal({ action: "resume" });
                        }}
                      >
                        {ti("resumeGoal")}
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={goalBusy}
                      onClick={() => {
                        void mutateGoal({ action: "clear" });
                      }}
                    >
                      {ti("clearGoal")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="inspector-item-row">
              <Input
                size="sm"
                className="inspector-commit-input"
                value={goalDraft}
                placeholder={ti("goalPlaceholder")}
                aria-label={t("desktop.inspector.goal")}
                disabled={!online || goalBusy}
                onChange={(e) => setGoalDraft(e.target.value)}
                onEnterSubmit={() => {
                  if (goalDraft.trim()) {
                    void mutateGoal({
                      action: "set",
                      objective: goalDraft.trim(),
                    });
                  }
                }}
              />
              <Button
                size="xs"
                variant="primary"
                className="inspector-keycap-btn"
                loading={goalBusy}
                disabled={!online || !goalDraft.trim()}
                onClick={() => {
                  void mutateGoal({
                    action: "set",
                    objective: goalDraft.trim(),
                  });
                }}
              >
                {ti("setGoal")}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
