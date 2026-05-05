import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  endLiveActivity,
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  type ActivityState,
  type ExtendedActivityData,
} from "../native/LiveActivity";
import type { AgentConversationRecord, AgentPermission, AgentTimelineItem } from "../storage/agent-workspace";
import type { AgentWorkspaceHandle } from "./useAgentWorkspace";

type Candidate = {
  conversation: AgentConversationRecord;
  status: ActivityState["status"];
  phaseLabel: string;
  summary: string;
  permission?: AgentPermission;
  permissionCount: number;
  currentToolName: string;
  currentToolInput: string;
  updatedAt: number;
};

const IDLE_END_DELAY_MS = 30_000;
const ERROR_VISIBLE_MS = 60_000;

function compactText(value: string | undefined, max = 220): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isOpenPermission(item: AgentTimelineItem): item is AgentTimelineItem & { permission: AgentPermission } {
  return item.type === "permission" &&
    !!item.permission?.requestId &&
    item.metadata?.permissionLive === true &&
    item.metadata?.permissionExpired !== true &&
    item.metadata?.permissionOutcome !== "allow" &&
    item.metadata?.permissionOutcome !== "deny" &&
    item.metadata?.permissionOutcome !== "cancelled" &&
    item.metadata?.permissionPending !== true;
}

function latestTimestamp(item: AgentTimelineItem): number {
  return item.updatedAt ?? item.createdAt;
}

function latestToolItem(items: AgentTimelineItem[]): AgentTimelineItem | undefined {
  return [...items].reverse().find((item) =>
    item.toolCall ||
    item.commandExecution ||
    item.fileChange ||
    item.subagent ||
    item.kind === "thinking" ||
    item.kind === "review" ||
    item.kind === "context_compaction" ||
    item.kind === "tool_activity" ||
    item.kind === "command_execution",
  );
}

function phaseFromTimeline(conversation: AgentConversationRecord, items: AgentTimelineItem[]) {
  const latest = latestToolItem(items);
  if (!latest) {
    if (conversation.status === "error") return "运行出错";
    if (conversation.status === "waiting_permission") return "等待授权";
    if (conversation.status === "running") return "运行中";
    return "空闲";
  }
  if (latest.error) return "运行出错";
  if (latest.commandExecution) return latest.commandExecution.status === "running" ? "正在运行命令" : "命令执行";
  if (latest.fileChange) return "正在编辑文件";
  if (latest.subagent) return "子 Agent 活动";
  if (latest.toolCall) return latest.toolCall.status === "running" ? "正在使用工具" : latest.toolCall.name;
  if (latest.kind === "thinking") return "正在思考";
  if (latest.kind === "review") return "正在审查";
  if (latest.kind === "context_compaction") return "正在压缩上下文";
  return "运行中";
}

function toolFromTimeline(items: AgentTimelineItem[]) {
  const latest = latestToolItem(items);
  if (!latest) return { name: "", input: "" };
  if (latest.commandExecution) {
    return {
      name: "command",
      input: compactText(latest.commandExecution.command || latest.commandExecution.output, 500),
    };
  }
  if (latest.fileChange) {
    return {
      name: "file_change",
      input: compactText(latest.fileChange.summary || latest.fileChange.entries.map((entry) => entry.path).join(", "), 500),
    };
  }
  if (latest.subagent) {
    return {
      name: latest.subagent.tool,
      input: compactText(latest.subagent.prompt, 500),
    };
  }
  if (latest.toolCall) {
    return {
      name: latest.toolCall.name,
      input: compactText(latest.toolCall.input || latest.toolCall.output, 500),
    };
  }
  return { name: "", input: compactText(latest.text, 500) };
}

function buildCandidate(conversation: AgentConversationRecord, items: AgentTimelineItem[]): Candidate {
  const openPermissions = items.filter(isOpenPermission).sort((a, b) => latestTimestamp(b) - latestTimestamp(a));
  const topPermission = openPermissions[0]?.permission;
  const tool = toolFromTimeline(items);
  const updatedAt = Math.max(
    conversation.lastActivityAt,
    ...items.slice(-8).map(latestTimestamp),
  );

  if (topPermission) {
    const title = topPermission.toolName ? `需要授权 · ${topPermission.toolName}` : "需要授权";
    return {
      conversation,
      status: "waiting_permission",
      phaseLabel: "等待授权",
      summary: compactText(topPermission.context || topPermission.toolInput || conversation.lastMessagePreview || title),
      permission: topPermission,
      permissionCount: openPermissions.length,
      currentToolName: topPermission.toolName || tool.name,
      currentToolInput: compactText(topPermission.toolInput || topPermission.context || tool.input, 500),
      updatedAt,
    };
  }

  return {
    conversation,
    status: conversation.status === "error" ? "error" : conversation.status === "idle" ? "idle" : "running",
    phaseLabel: phaseFromTimeline(conversation, items),
    summary: compactText(conversation.lastMessagePreview || tool.input || conversation.title || conversation.cwd),
    permissionCount: 0,
    currentToolName: tool.name,
    currentToolInput: tool.input,
    updatedAt,
  };
}

function buildState(candidate: Candidate): ActivityState {
  return {
    conversationId: candidate.conversation.id,
    sessionId: candidate.conversation.sessionId,
    provider: candidate.conversation.provider,
    project: compactText(candidate.conversation.title || candidate.conversation.cwd.split("/").filter(Boolean).pop() || "Agent", 40),
    status: candidate.status,
    phaseLabel: compactText(candidate.phaseLabel, 80),
    summary: compactText(candidate.summary, 220),
    hasPermission: Boolean(candidate.permission),
    permissionCount: candidate.permissionCount,
    updatedAt: candidate.updatedAt,
  };
}

function buildExtended(candidate: Candidate): ExtendedActivityData {
  const permission = candidate.permission;
  return {
    conversationId: candidate.conversation.id,
    permissionRequestId: permission?.requestId ?? "",
    permissionTitle: permission?.toolName ? `需要授权 · ${permission.toolName}` : permission ? "需要授权" : "",
    permissionContext: compactText(permission?.context || permission?.toolInput, 500),
    permissionOptions: permission?.options?.length
      ? permission.options.map((option) => ({ id: option.id, label: option.label, kind: option.kind }))
      : permission
        ? [
            { id: "deny", label: "拒绝", kind: "deny" as const },
            { id: "allow_once", label: "允许一次", kind: "allow" as const },
          ]
        : [],
    currentToolName: candidate.currentToolName,
    currentToolInput: candidate.currentToolInput,
    deepLink: `linkshell://agent/${encodeURIComponent(candidate.conversation.id)}`,
  };
}

function selectCandidate(workspace: AgentWorkspaceHandle): Candidate | null {
  const conversations = workspace.conversations;
  const candidates = conversations.map((conversation) =>
    buildCandidate(conversation, workspace.getTimeline(conversation.id)),
  );
  const pending = candidates
    .filter((candidate) => candidate.permission)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (pending) return pending;

  const active = workspace.activeConversationId
    ? candidates.find((candidate) =>
        candidate.conversation.id === workspace.activeConversationId &&
        (candidate.conversation.status === "running" || candidate.conversation.status === "waiting_permission")
      )
    : undefined;
  if (active) return active;

  const recentRunning = candidates
    .filter((candidate) => candidate.conversation.status === "running" || candidate.conversation.status === "waiting_permission")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recentRunning) return recentRunning;

  const recentError = candidates
    .filter((candidate) => candidate.conversation.status === "error" && Date.now() - candidate.updatedAt < ERROR_VISIBLE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return recentError ?? null;
}

export function useAgentLiveActivity(workspace: AgentWorkspaceHandle) {
  const liveActivityActiveRef = useRef(false);
  const liveActivityStartingRef = useRef(false);
  const alertedRequestIdsRef = useRef<string[]>([]);
  const appStateRef = useRef(AppState.currentState);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEndTimer = useCallback(() => {
    if (!endTimerRef.current) return;
    clearTimeout(endTimerRef.current);
    endTimerRef.current = null;
  }, []);

  const finishActivity = useCallback(() => {
    clearEndTimer();
    liveActivityActiveRef.current = false;
    liveActivityStartingRef.current = false;
    endLiveActivity();
  }, [clearEndTimer]);

  const scheduleEnd = useCallback(() => {
    if (!liveActivityActiveRef.current || endTimerRef.current) return;
    endTimerRef.current = setTimeout(() => {
      finishActivity();
    }, IDLE_END_DELAY_MS);
  }, [finishActivity]);

  const pushUpdate = useCallback(() => {
    const candidate = selectCandidate(workspace);
    if (!candidate) {
      scheduleEnd();
      return;
    }

    clearEndTimer();
    const state = buildState(candidate);
    const extended = buildExtended(candidate);
    const alertRequestId = candidate.permission?.requestId ?? null;
    const needsAlert =
      !!alertRequestId &&
      appStateRef.current !== "active" &&
      !alertedRequestIdsRef.current.includes(alertRequestId);
    if (needsAlert) {
      alertedRequestIdsRef.current = [...alertedRequestIdsRef.current.slice(-49), alertRequestId];
    }

    if (!liveActivityActiveRef.current && !liveActivityStartingRef.current) {
      liveActivityStartingRef.current = true;
      isLiveActivityAvailable()
        .then((ok) => ok ? startLiveActivity(state, extended) : null)
        .then((id) => {
          if (!id) return;
          liveActivityActiveRef.current = true;
          if (needsAlert) updateLiveActivity(state, extended, true).catch(() => {});
        })
        .finally(() => {
          liveActivityStartingRef.current = false;
        });
      return;
    }

    if (liveActivityActiveRef.current) {
      updateLiveActivity(state, extended, needsAlert).then((ok) => {
        if (ok || !liveActivityActiveRef.current) return;
        liveActivityActiveRef.current = false;
        pushUpdate();
      });
    }
  }, [clearEndTimer, scheduleEnd, workspace]);

  useEffect(() => {
    pushUpdate();
  }, [pushUpdate, workspace.conversations, workspace.activeConversationId]);

  useEffect(() => {
    const id = setInterval(pushUpdate, 2500);
    return () => clearInterval(id);
  }, [pushUpdate]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
      if (state === "active") pushUpdate();
    });
    return () => sub.remove();
  }, [pushUpdate]);

  useEffect(() => {
    return () => {
      clearEndTimer();
      if (liveActivityActiveRef.current) endLiveActivity();
      liveActivityActiveRef.current = false;
      liveActivityStartingRef.current = false;
    };
  }, [clearEndTimer]);
}
