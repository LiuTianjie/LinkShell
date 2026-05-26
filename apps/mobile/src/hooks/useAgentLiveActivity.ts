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
import type { AgentConversationRecord, AgentPermission, AgentStructuredInput, AgentTimelineItem } from "../storage/agent-workspace";
import type { AgentWorkspaceHandle } from "./useAgentWorkspace";
import type { SessionInfo, SessionManagerHandle } from "./useSessionManager";

type Candidate = {
  conversation: AgentConversationRecord;
  status: ActivityState["status"];
  phaseLabel: string;
  summary: string;
  permission?: AgentPermission;
  permissionItem?: AgentTimelineItem & { permission: AgentPermission };
  permissionCount: number;
  input?: AgentStructuredInput;
  inputItem?: AgentTimelineItem & { structuredInput: AgentStructuredInput };
  inputCount: number;
  currentToolName: string;
  currentToolInput: string;
  updatedAt: number;
};

type ResolvedCandidate = Candidate & {
  session: SessionInfo;
};

type CandidateStats = {
  agentCount: number;
  permissionCount: number;
  inputCount: number;
  signature: string;
};

type LiveSelection = {
  candidate: ResolvedCandidate;
  stats: CandidateStats;
};

const IDLE_END_DELAY_MS = 30_000;
const ERROR_VISIBLE_MS = 60_000;

function isActiveSession(session: SessionInfo): boolean {
  return (
    session.status === "connected" ||
    session.status === "connecting" ||
    session.status === "claiming" ||
    session.status === "reconnecting"
  );
}

function activeSessionSignature(manager: SessionManagerHandle): string {
  return [...manager.sessions.values()]
    .filter(isActiveSession)
    .map((session) => `${session.sessionId}:${session.status}`)
    .sort()
    .join("|");
}

function normalizeServerUrl(url: string | undefined): string {
  return (url ?? "").replace(/\/+$/, "");
}

function sessionHasCwd(session: SessionInfo, cwd: string): boolean {
  return session.cwd === cwd ||
    [...session.terminals.values()].some((terminal) => terminal.cwd === cwd);
}

function resolveCandidateSession(candidate: Candidate, manager: SessionManagerHandle): SessionInfo | undefined {
  const conversation = candidate.conversation;
  const metadataSessionId =
    candidate.permissionItem?.metadata?.sessionId ??
    candidate.inputItem?.metadata?.sessionId;
  if (typeof metadataSessionId === "string" && metadataSessionId) {
    const metadataSession = manager.sessions.get(metadataSessionId);
    if (metadataSession) return metadataSession;
  }

  const exact = manager.sessions.get(conversation.sessionId);
  if (exact && (!conversation.machineId || exact.machineId === conversation.machineId)) {
    return exact;
  }

  const serverUrl = normalizeServerUrl(conversation.serverUrl);
  const candidates = [...manager.sessions.values()].filter((session) =>
    normalizeServerUrl(session.gatewayUrl) === serverUrl
  );
  if (conversation.machineId) {
    const machineMatch = candidates.find((session) => session.machineId === conversation.machineId);
    if (machineMatch) return machineMatch;
    return undefined;
  }

  const cwdMatch = candidates.find((session) => sessionHasCwd(session, conversation.cwd));
  return cwdMatch ?? candidates[0];
}

function resolveLiveCandidate(candidate: Candidate, manager: SessionManagerHandle): ResolvedCandidate | null {
  const session = resolveCandidateSession(candidate, manager);
  return session && isActiveSession(session) ? { ...candidate, session } : null;
}

function isSessionIdActive(manager: SessionManagerHandle, sessionId: string): boolean {
  const session = manager.sessions.get(sessionId);
  return !!session && isActiveSession(session);
}

function candidateSignature(candidate: ResolvedCandidate): string {
  return [
    candidate.session.sessionId,
    candidate.conversation.id,
    candidate.conversation.status,
    candidate.status,
    candidate.permission?.requestId ?? "",
    candidate.input?.requestId ?? "",
    candidate.updatedAt,
  ].join(":");
}

function compactText(value: string | undefined, max = 220): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isOpenPermission(item: AgentTimelineItem): item is AgentTimelineItem & { permission: AgentPermission } {
  return item.type === "permission" &&
    !!item.permission?.requestId &&
    item.metadata?.protocol !== "terminal" &&
    item.metadata?.permissionLive === true &&
    item.metadata?.permissionExpired !== true &&
    item.metadata?.permissionOutcome !== "allow" &&
    item.metadata?.permissionOutcome !== "deny" &&
    item.metadata?.permissionOutcome !== "cancelled" &&
    item.metadata?.permissionPending !== true;
}

function isOpenStructuredInput(item: AgentTimelineItem): item is AgentTimelineItem & { structuredInput: AgentStructuredInput } {
  return item.kind === "user_input_prompt" &&
    !!item.structuredInput?.requestId &&
    item.metadata?.inputPending !== false &&
    item.metadata?.inputSubmitted !== true &&
    item.metadata?.inputSubmitting !== true;
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

function structuredInputSummary(input: AgentStructuredInput): string {
  const questions = input.questions.map((question) => question.question.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (questions.length === 0) return "Agent 需要补充信息";
  if (questions.length === 1) return questions[0];
  return `${questions[0]} · 还有 ${questions.length - 1} 个问题`;
}

function buildCandidate(conversation: AgentConversationRecord, items: AgentTimelineItem[]): Candidate {
  const openPermissions = items.filter(isOpenPermission).sort((a, b) => latestTimestamp(b) - latestTimestamp(a));
  const openInputs = items.filter(isOpenStructuredInput).sort((a, b) => latestTimestamp(b) - latestTimestamp(a));
  const topPermissionItem = openPermissions[0];
  const topPermission = topPermissionItem?.permission;
  const topInputItem = openInputs[0];
  const topInput = topInputItem?.structuredInput;
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
      permissionItem: topPermissionItem,
      permissionCount: openPermissions.length,
      inputCount: openInputs.length,
      currentToolName: topPermission.toolName || tool.name,
      currentToolInput: compactText(topPermission.toolInput || topPermission.context || tool.input, 500),
      updatedAt,
    };
  }

  if (topInput) {
    const summary = structuredInputSummary(topInput);
    return {
      conversation,
      status: "waiting_permission",
      phaseLabel: "等待回答",
      summary: compactText(summary),
      permissionCount: 0,
      input: topInput,
      inputItem: topInputItem,
      inputCount: openInputs.length,
      currentToolName: "用户询问",
      currentToolInput: compactText(summary, 500),
      updatedAt,
    };
  }

  return {
    conversation,
    status: conversation.status === "error" ? "error" : conversation.status === "idle" ? "idle" : "running",
    phaseLabel: phaseFromTimeline(conversation, items),
    summary: compactText(conversation.lastMessagePreview || tool.input || conversation.title || conversation.cwd),
    permissionCount: 0,
    inputCount: 0,
    currentToolName: tool.name,
    currentToolInput: tool.input,
    updatedAt,
  };
}

function candidateTitle(candidate: ResolvedCandidate): string {
  return compactText(candidate.conversation.title || candidate.conversation.cwd.split("/").filter(Boolean).pop() || "Agent", 40);
}

function buildState(selection: LiveSelection): ActivityState {
  const { candidate, stats } = selection;
  const project = stats.agentCount > 1
    ? `${stats.agentCount} 个 Agent 会话`
    : candidateTitle(candidate);
  const summary = stats.agentCount > 1
    ? compactText(`${candidateTitle(candidate)}：${candidate.summary || candidate.phaseLabel} · 另有 ${stats.agentCount - 1} 个会话活跃`, 220)
    : compactText(candidate.summary, 220);
  return {
    conversationId: candidate.conversation.id,
    sessionId: candidate.session.sessionId,
    provider: candidate.conversation.provider,
    project,
    status: candidate.status,
    phaseLabel: compactText(candidate.phaseLabel, 80),
    summary,
    hasPermission: Boolean(candidate.permission),
    permissionCount: stats.permissionCount,
    updatedAt: candidate.updatedAt,
  };
}

function permissionProtocol(candidate: Candidate): ExtendedActivityData["permissionProtocol"] {
  const protocol = candidate.permissionItem?.metadata?.protocol;
  if (protocol === "legacy") return protocol;
  return "v2";
}

function buildExtended(candidate: ResolvedCandidate, manager: SessionManagerHandle): ExtendedActivityData {
  const permission = candidate.permission;
  const metadata = candidate.permissionItem?.metadata;
  const protocol = permissionProtocol(candidate);
  const terminalId = typeof metadata?.terminalId === "string" ? metadata.terminalId : undefined;
  const agentSessionId = typeof metadata?.agentSessionId === "string"
    ? metadata.agentSessionId
    : candidate.conversation.agentSessionId;
  return {
    conversationId: candidate.conversation.id,
    gatewayUrl: candidate.session.gatewayUrl,
    deviceToken: manager.deviceToken ?? "",
    permissionProtocol: protocol,
    terminalId,
    agentSessionId,
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

function isLiveRelevant(candidate: ResolvedCandidate): boolean {
  if (candidate.permission || candidate.input) return true;
  if (candidate.conversation.status === "running" || candidate.conversation.status === "waiting_permission") return true;
  return candidate.conversation.status === "error" && Date.now() - candidate.updatedAt < ERROR_VISIBLE_MS;
}

function statsFor(candidates: ResolvedCandidate[]): CandidateStats {
  return {
    agentCount: candidates.length,
    permissionCount: candidates.reduce((sum, candidate) => sum + candidate.permissionCount, 0),
    inputCount: candidates.reduce((sum, candidate) => sum + candidate.inputCount, 0),
    signature: candidates
      .map((candidate) => candidateSignature(candidate))
      .sort()
      .join("|"),
  };
}

function selectCandidate(workspace: AgentWorkspaceHandle, manager: SessionManagerHandle): LiveSelection | null {
  const conversations = workspace.conversations;
  const candidates = conversations
    .filter((conversation) => !conversation.archived)
    .map((conversation) =>
      buildCandidate(conversation, workspace.getTimeline(conversation.id)),
    )
    .map((candidate) => resolveLiveCandidate(candidate, manager))
    .filter((candidate): candidate is ResolvedCandidate => Boolean(candidate));
  const liveCandidates = candidates.filter(isLiveRelevant);
  if (liveCandidates.length === 0) return null;
  const stats = statsFor(liveCandidates);
  const pending = candidates
    .filter((candidate) => candidate.permission)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (pending) return { candidate: pending, stats };

  const pendingInput = candidates
    .filter((candidate) => candidate.input)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (pendingInput) return { candidate: pendingInput, stats };

  const active = workspace.activeConversationId
    ? candidates.find((candidate) =>
        candidate.conversation.id === workspace.activeConversationId &&
        (candidate.conversation.status === "running" || candidate.conversation.status === "waiting_permission")
      )
    : undefined;
  if (active) return { candidate: active, stats };

  const recentRunning = candidates
    .filter((candidate) => candidate.conversation.status === "running" || candidate.conversation.status === "waiting_permission")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recentRunning) return { candidate: recentRunning, stats };

  const recentError = candidates
    .filter((candidate) => candidate.conversation.status === "error" && Date.now() - candidate.updatedAt < ERROR_VISIBLE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return recentError ? { candidate: recentError, stats } : null;
}

export function useAgentLiveActivity(workspace: AgentWorkspaceHandle, manager: SessionManagerHandle) {
  const liveActivityActiveRef = useRef(false);
  const liveActivityStartingRef = useRef(false);
  const alertedRequestIdsRef = useRef<string[]>([]);
  const appStateRef = useRef(AppState.currentState);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityGenerationRef = useRef(0);
  const cleanupKeyRef = useRef<string | null>(null);
  const startingSignatureRef = useRef<string | null>(null);
  const pendingUpdateRef = useRef<{
    state: ActivityState;
    extended: ExtendedActivityData;
    needsAlert: boolean;
    signature: string;
    sessionId: string;
  } | null>(null);

  const clearEndTimer = useCallback(() => {
    if (!endTimerRef.current) return;
    clearTimeout(endTimerRef.current);
    endTimerRef.current = null;
  }, []);

  const finishActivity = useCallback((cleanupKey?: string) => {
    if (
      cleanupKey &&
      cleanupKeyRef.current === cleanupKey &&
      !liveActivityActiveRef.current &&
      !liveActivityStartingRef.current
    ) {
      return;
    }
    cleanupKeyRef.current = cleanupKey ?? null;
    activityGenerationRef.current += 1;
    clearEndTimer();
    liveActivityActiveRef.current = false;
    liveActivityStartingRef.current = false;
    startingSignatureRef.current = null;
    pendingUpdateRef.current = null;
    endLiveActivity();
  }, [clearEndTimer]);

  const scheduleEnd = useCallback(() => {
    if (!liveActivityActiveRef.current || endTimerRef.current) return;
    endTimerRef.current = setTimeout(() => {
      finishActivity();
    }, IDLE_END_DELAY_MS);
  }, [finishActivity]);

  const pushUpdate = useCallback(() => {
    const sessionSignature = activeSessionSignature(manager);
    if (!sessionSignature) {
      finishActivity("no-active-sessions");
      return;
    }

    const selection = selectCandidate(workspace, manager);
    if (!selection) {
      if (liveActivityActiveRef.current) {
        scheduleEnd();
      } else {
        finishActivity(`no-candidate:${sessionSignature}`);
      }
      return;
    }

    cleanupKeyRef.current = null;
    clearEndTimer();
    const candidate = selection.candidate;
    const state = buildState(selection);
    const extended = buildExtended(candidate, manager);
    const signature = `${candidateSignature(candidate)}:${selection.stats.signature}`;
    const alertRequestId = candidate.permission?.requestId ?? candidate.input?.requestId ?? null;
    const needsAlert =
      !!alertRequestId &&
      appStateRef.current !== "active" &&
      !alertedRequestIdsRef.current.includes(alertRequestId);
    if (needsAlert) {
      alertedRequestIdsRef.current = [...alertedRequestIdsRef.current.slice(-49), alertRequestId];
    }

    if (!liveActivityActiveRef.current && !liveActivityStartingRef.current) {
      liveActivityStartingRef.current = true;
      startingSignatureRef.current = signature;
      pendingUpdateRef.current = null;
      const generation = activityGenerationRef.current;
      isLiveActivityAvailable()
        .then((ok) => ok ? startLiveActivity(state, extended) : null)
        .then((id) => {
          if (!id) return;
          if (generation !== activityGenerationRef.current || !isSessionIdActive(manager, candidate.session.sessionId)) {
            endLiveActivity();
            return;
          }
          liveActivityActiveRef.current = true;
          const pending = pendingUpdateRef.current;
          pendingUpdateRef.current = null;
          if (
            pending &&
            pending.signature !== startingSignatureRef.current &&
            isSessionIdActive(manager, pending.sessionId)
          ) {
            updateLiveActivity(pending.state, pending.extended, pending.needsAlert).catch(() => {});
          } else if (needsAlert) {
            updateLiveActivity(state, extended, true).catch(() => {});
          }
        })
        .finally(() => {
          if (generation === activityGenerationRef.current) {
            liveActivityStartingRef.current = false;
            startingSignatureRef.current = null;
          }
        });
      return;
    }

    if (liveActivityStartingRef.current) {
      pendingUpdateRef.current = {
        state,
        extended,
        needsAlert,
        signature,
        sessionId: candidate.session.sessionId,
      };
      return;
    }

    if (liveActivityActiveRef.current) {
      updateLiveActivity(state, extended, needsAlert).then((ok) => {
        if (ok || !liveActivityActiveRef.current) return;
        liveActivityActiveRef.current = false;
        pushUpdate();
      });
    }
  }, [clearEndTimer, finishActivity, manager, scheduleEnd, workspace]);

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
