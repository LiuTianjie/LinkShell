import { type TimelineItem, type WorkflowRecord, type WorkflowRecords } from "@linkshell/client-core";
import type { Workflow, WorkflowAgent, WorkflowAgentState } from "@linkshell/wire";

export const workflowStateText = {
  pending: "等待中", running: "运行中", paused: "已暂停", completed: "已完成",
  failed: "失败", stopped: "已停止", unknown: "结果待确认",
} satisfies Record<WorkflowAgentState, string>;

export interface WorkflowGroup { id: string; title: string; agents: WorkflowAgent[]; }

export function findWorkflowAgent(records: WorkflowRecords | undefined, callId: string): WorkflowAgent | undefined {
  for (const record of Object.values(records ?? {})) {
    const agent = record.workflow.agents?.find((entry) => entry.toolCallId === callId);
    if (agent) return agent;
  }
  return undefined;
}

export function workflowGroups(workflow: Workflow): WorkflowGroup[] {
  const agents = workflow.agents ?? [];
  const phases = [...(workflow.phases ?? [])].sort((a, b) => a.order - b.order);
  const ids = new Set(phases.map((phase) => phase.id));
  const groups = phases.map((phase) => ({ id: phase.id, title: phase.title, agents: agents.filter((agent) => agent.phaseId === phase.id) }));
  const ungrouped = agents.filter((agent) => !agent.phaseId || !ids.has(agent.phaseId));
  if (ungrouped.length) groups.push({ id: "ungrouped", title: phases.length ? "未分组" : "Agent", agents: ungrouped });
  return groups;
}

export function workflowCounts(workflow: Workflow) {
  const agents = workflow.agents ?? [];
  return {
    started: workflow.started ?? agents.filter((agent) => agent.state !== "pending").length,
    completed: workflow.completed ?? agents.filter((agent) => agent.state === "completed").length,
    running: agents.filter((agent) => agent.state === "running").length,
    paused: agents.filter((agent) => agent.state === "paused").length,
    failed: agents.filter((agent) => agent.state === "failed").length,
    pending: agents.filter((agent) => agent.state === "pending").length,
  };
}

export function workflowCurrentPhase(workflow: Workflow): string | undefined {
  return workflowGroups(workflow).find((group) => group.id !== "ungrouped" && group.agents.some((agent) => agent.state === "running" || agent.state === "paused"))?.title;
}

export function workflowElapsed(record: WorkflowRecord, now: number): number {
  const workflow = record.workflow;
  if (workflow.durationMs !== undefined) return workflow.durationMs;
  return Math.max(0, (workflow.endedAt ?? now) - (workflow.startedAt ?? record.startedAt));
}

export function workflowFromTool(item: Extract<TimelineItem, { kind: "tool" }>): WorkflowRecord {
  const detail = item.detail?.type === "subagent" ? item.detail : undefined;
  const workflow = detail?.workflow ?? {};
  return {
    toolCallId: item.id, task: detail?.task ?? item.title, startedAt: item.ts, lastSeq: 0,
    workflow: { ...workflow, name: workflow.name ?? item.title.replace(/^Workflow:\s*/, ""),
      state: workflow.state ?? (item.status === "failed" ? "failed" : undefined), endedAt: workflow.endedAt ?? item.endedTs },
  };
}
