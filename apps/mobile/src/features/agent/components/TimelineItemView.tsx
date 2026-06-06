import { memo } from "react";

import type { Theme } from "../../../theme";
import { isEmptyActivityText } from "../lib/format";
import {
  type AgentRailTone,
  userMessageDeliveryLabel,
} from "../lib/timeline";
import type { AgentTimelineItem } from "../types";

import {
  AgentTimelineBlock,
  AssistantMessage,
  ErrorCard,
  SystemMessageCard,
  UserMessageCard,
} from "./message-cards";
import {
  FileChangeCard,
  SubagentCard,
  SystemActivityCard,
  ToolCard,
} from "./activity-cards";
import {
  PermissionRequestCard,
  PlanCard,
  StructuredInputCard,
} from "./interactive-cards";

export const TimelineItemView = memo(function TimelineItemView({
  item,
  theme,
  onPermission,
  onStructuredInput,
  onEditMessage,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onEditMessage?: (text: string) => void;
}) {
  if (item.kind === "subagent_action" && item.subagent) {
    return (
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SubagentCard action={item.subagent} theme={theme} running={item.isStreaming} />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "user_input_prompt" && item.structuredInput) {
    return (
      <AgentTimelineBlock theme={theme} tone="warning">
        <StructuredInputCard
          input={item.structuredInput}
          theme={theme}
          submitted={item.metadata?.inputSubmitted === true}
          submitting={item.metadata?.inputSubmitting === true}
          error={typeof item.metadata?.inputError === "string" ? item.metadata.inputError : undefined}
          onSubmit={(answers) => onStructuredInput(item.structuredInput!.requestId, answers)}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "thinking") {
    if (isEmptyActivityText(item.text)) return null;
    return (
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon="brain.head.profile"
          title={item.isStreaming ? "正在思考" : "思考"}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "review" || item.kind === "context_compaction" || item.kind === "tool_activity") {
    const title =
      item.kind === "review"
        ? "审查"
        : item.kind === "context_compaction"
          ? "上下文压缩"
          : "工具活动";
    return (
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon={item.kind === "review" ? "doc.text.magnifyingglass" : item.kind === "context_compaction" ? "square.stack.3d.up" : "terminal.fill"}
          title={title}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "status") {
    return item.text ? (
      <AgentTimelineBlock theme={theme} tone={item.status === "error" ? "error" : item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon={item.status === "error" ? "exclamationmark.triangle.fill" : "info.circle"}
          title={item.status === "error" ? "状态异常" : "状态"}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    ) : null;
  }

  if (item.type === "message") {
    const isUser = item.role === "user";
    const text = item.text || (item.content ?? []).map((block) => block.text ?? "").join("\n");
    if (item.role === "system") {
      return text ? (
        <AgentTimelineBlock theme={theme}>
          <SystemMessageCard text={text} theme={theme} />
        </AgentTimelineBlock>
      ) : null;
    }
    if (!isUser) {
      return (
        <AssistantMessage
          item={item}
          text={text}
          theme={theme}
        />
      );
    }
    const deliveryLabel = userMessageDeliveryLabel(item);
    return (
      <UserMessageCard item={item} text={text} theme={theme} deliveryLabel={deliveryLabel} onEdit={onEditMessage} />
    );
  }

  if (item.type === "tool_call" && item.toolCall && !item.commandExecution && !item.fileChange) {
    const tone: AgentRailTone = item.toolCall.status === "running"
      ? "running"
      : item.toolCall.status === "failed"
        ? "error"
        : item.toolCall.status === "completed"
          ? "success"
          : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <ToolCard tool={item.toolCall} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  if (item.commandExecution) {
    const status = item.commandExecution.status ?? (item.isStreaming ? "running" : "completed");
    const tone: AgentRailTone = status === "running" ? "running" : status === "failed" ? "error" : status === "completed" ? "success" : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <ToolCard
          tool={{
            id: item.itemId ?? item.id,
            name: "命令",
            input: [
              item.commandExecution.command,
              item.commandExecution.cwd ? `cwd: ${item.commandExecution.cwd}` : undefined,
            ].filter(Boolean).join("\n\n"),
            output: item.commandExecution.output,
            createdAt: item.createdAt,
            status,
          }}
          theme={theme}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.fileChange) {
    const status = item.fileChange.status ?? (item.isStreaming ? "running" : "completed");
    const tone: AgentRailTone = status === "running" ? "running" : status === "failed" ? "error" : status === "completed" ? "success" : "default";
    const summary = item.fileChange.entries
      .map((entry) => [entry.kind, entry.path].filter(Boolean).join(" ") || entry.path)
      .join("\n");
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <FileChangeCard
          tool={{
            id: item.itemId ?? item.id,
            name: "文件修改",
            input: summary,
            output: item.fileChange.diff ?? item.fileChange.summary,
            createdAt: item.createdAt,
            status,
          }}
          theme={theme}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "plan" && item.plan?.length) {
    const tone: AgentRailTone = item.plan.some((step) => step.status === "in_progress")
      ? "running"
      : item.plan.every((step) => step.status === "completed")
        ? "success"
        : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <PlanCard steps={item.plan} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "permission" && item.permission) {
    const outcome = item.metadata?.permissionOutcome;
    const tone: AgentRailTone = outcome === "allow" ? "success" : outcome === "deny" || outcome === "cancelled" ? "error" : "warning";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <PermissionRequestCard item={item} theme={theme} onPermission={onPermission} />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "error") {
    return (
      <AgentTimelineBlock theme={theme} tone="error">
        <ErrorCard text={item.error || item.text || "Agent 出错了"} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  return null;
});
