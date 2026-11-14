import { useEffect, useMemo, useState, type JSX } from "react";
import {
  subagentKey,
  userMessageText,
  type SessionView,
  type TimelineItem,
} from "@linkshell/client-core";
import type { SubagentInfo } from "@linkshell/wire";
import { DesktopIcon, SubagentGlyph } from "../../icons";
import { Badge, Button, CollapsibleLog, useDialogs } from "../../primitives";
import { MarkdownView } from "../session/MarkdownView";
import { useInspectorI18n } from "./i18n-inspector";
import type { InspectorSessionActions } from "./use-inspector-connection";

export interface SubagentTabPanelProps {
  computerKey?: string;
  sessionId?: string;
  cwd?: string;
  toolCallId: string;
  fallbackTitle?: string;
  parentView?: SessionView;
  subagentViews: Record<string, SessionView>;
  subagents: readonly SubagentInfo[];
  actions?: InspectorSessionActions;
}

function renderSubagentTimelineItem(
  item: TimelineItem,
  ctx: { computerKey?: string; sessionId?: string; cwd?: string },
): JSX.Element | null {
  if (item.kind === "user") {
    const text = userMessageText(item.blocks).trim();
    if (!text) return null;
    return (
      <div key={item.id} className="ls-subagent-turn ls-subagent-turn--user">
        <div className="ls-subagent-turn__text">{text}</div>
      </div>
    );
  }

  if (item.kind === "agent") {
    if (!item.text.trim()) return null;
    return (
      <div key={item.id} className="ls-subagent-turn ls-subagent-turn--agent">
        <MarkdownView
          text={item.text}
          computerKey={ctx.computerKey}
          sessionId={ctx.sessionId}
          cwd={ctx.cwd}
        />
      </div>
    );
  }

  if (item.kind === "thought") {
    if (!item.text.trim()) return null;
    return (
      <div key={item.id} className="ls-subagent-thought">
        <DesktopIcon name="sparkles" size="xs" />
        <span>{item.text}</span>
      </div>
    );
  }

  if (item.kind === "tool") {
    const done = item.status === "completed";
    const failed = item.status === "failed";
    const outputText = item.output.trim();
    const statusIcon = failed
      ? "alert-circle"
      : done
        ? "check-circle"
        : "spinner";

    if (outputText) {
      return (
        <CollapsibleLog
          key={item.id}
          title={
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minInlineSize: 0,
              }}
            >
              <DesktopIcon name={statusIcon} size="xs" />
              <span className="ls-truncate">{item.title}</span>
            </span>
          }
          logText={outputText}
        >
          <pre tabIndex={0} className="ls-collapsible-log__pre">
            {outputText}
          </pre>
        </CollapsibleLog>
      );
    }

    return (
      <div
        key={item.id}
        className="ls-subagent-tool"
        data-status={item.status}
      >
        <div className="ls-subagent-tool__head">
          <DesktopIcon name={statusIcon} size="xs" />
          <span className="ls-subagent-tool__title ls-truncate">
            {item.title}
          </span>
        </div>
      </div>
    );
  }

  if (item.kind === "error") {
    return (
      <div key={item.id} className="ls-subagent-error" role="alert">
        <DesktopIcon name="alert-circle" size="xs" />
        <span>{item.message}</span>
      </div>
    );
  }

  return null;
}

export function SubagentTabPanel({
  computerKey,
  sessionId,
  cwd,
  toolCallId,
  fallbackTitle,
  parentView,
  subagentViews,
  subagents,
  actions,
}: SubagentTabPanelProps): JSX.Element {
  const { ti } = useInspectorI18n();
  const dialogs = useDialogs();
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!sessionId || !toolCallId || !actions) return undefined;
    // Offline or an older host: the tab still shows what the parent session recorded.
    actions.openSubagent(toolCallId).catch(() => undefined);
    return () => {
      actions.closeSubagent(toolCallId);
    };
  }, [actions, sessionId, toolCallId]);

  const spawnedTool = useMemo(() => {
    if (!parentView) return undefined;
    for (const entry of parentView.items) {
      if (entry.kind === "tool" && entry.id === toolCallId) {
        return entry;
      }
    }
    return undefined;
  }, [parentView, toolCallId]);

  const info = useMemo(
    () => subagents.find((s) => s.toolCallId === toolCallId),
    [subagents, toolCallId],
  );

  const openedView = sessionId
    ? subagentViews[subagentKey(sessionId, toolCallId)]
    : undefined;

  const liveSubView = useMemo(() => {
    if (openedView) {
      const rootTool = openedView.items.find(
        (it) => it.kind === "tool" && it.id === toolCallId,
      );
      if (rootTool && rootTool.kind === "tool" && rootTool.sub) {
        return rootTool.sub;
      }
      return openedView;
    }
    return spawnedTool?.sub;
  }, [openedView, spawnedTool, toolCallId]);

  const detail =
    spawnedTool?.detail?.type === "subagent" ? spawnedTool.detail : undefined;
  const subState = info?.state ?? detail?.workflow?.state ?? detail?.state;
  const isRunning = Boolean(
    info?.running ??
      (subState === "running" ||
        (!subState &&
          (spawnedTool?.status === "in_progress" ||
            spawnedTool?.status === "pending"))),
  );
  const isFailed = Boolean(
    info?.failed ?? (subState === "failed" || spawnedTool?.status === "failed"),
  );

  const title =
    info?.name ||
    detail?.name ||
    info?.agentType ||
    detail?.agentType ||
    fallbackTitle ||
    "Subagent";

  const taskSummary = info?.task || detail?.task;
  const nativeSessionId = info?.nativeSessionId ?? detail?.nativeSessionId;
  const canCancel = Boolean(
    isRunning &&
      (info?.canCancel ?? detail?.canCancel) &&
      nativeSessionId &&
      actions,
  );

  const handleCancel = async () => {
    if (!nativeSessionId || !actions || cancelling) return;
    setCancelling(true);
    try {
      await actions.cancelSubagent(nativeSessionId);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const renderedItems = useMemo(() => {
    const items = liveSubView?.items ?? [];
    return items
      .filter((it) => !(it.kind === "tool" && it.id === toolCallId))
      .map((it) =>
        renderSubagentTimelineItem(it, { computerKey, sessionId, cwd }),
      )
      .filter((node): node is JSX.Element => node !== null);
  }, [liveSubView?.items, toolCallId, computerKey, sessionId, cwd]);

  return (
    <div
      className="ls-subagent-panel inspector-panel-fill"
      data-testid={`subagent-tab-panel-${toolCallId}`}
    >
      <div className="ls-subagent-panel__head inspector-subbar">
        <div className="ls-subagent-panel__title-wrap">
          <SubagentGlyph
            sessionId={sessionId}
            toolCallId={toolCallId}
            size="md"
          />
          <span className="ls-subagent-panel__title ls-truncate">{title}</span>
          <Badge
            variant="tag"
            tone={isFailed ? "danger" : isRunning ? "running" : "ok"}
            dot={isRunning ? "running" : undefined}
          >
            {isFailed
              ? ti("subagentFailedStatus")
              : isRunning
                ? ti("subagentRunningStatus")
                : ti("subagentDoneStatus")}
          </Badge>
        </div>

        {canCancel ? (
          <Button
            size="xs"
            variant="secondary"
            leadingIcon="stop-square"
            loading={cancelling}
            onClick={() => {
              void handleCancel();
            }}
          >
            {ti("subagentStopAction")}
          </Button>
        ) : null}
      </div>

      <div className="ls-subagent-panel__body inspector-panel-scroll">
        {taskSummary ? (
          <div className="ls-subagent-panel__task">{taskSummary}</div>
        ) : null}

        {renderedItems.length > 0 ? (
          <div className="ls-subagent-panel__stream">{renderedItems}</div>
        ) : (
          <div className="ls-subagent-panel__empty">
            {ti("subagentEmptyLogs")}
          </div>
        )}
      </div>
    </div>
  );
}
