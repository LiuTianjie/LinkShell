import { type TimelineItem, type WorkflowRecord, type WorkflowRecords } from "@linkshell/client-core";
import type { SubagentInfo, Workflow, WorkflowAgent, WorkflowAgentState } from "@linkshell/wire";

/** Keep paginated child placeholders out of the main conversation, without discarding their transcripts. */
export function sessionTimelineItems(items: TimelineItem[], records: WorkflowRecords | undefined, listed: SubagentInfo[] | undefined): TimelineItem[] {
  const workflows = new Map<string, Workflow>();
  const parents = new Map<string, string>();
  const children = new Set<string>();
  const entries = new Map(listed?.map((entry) => [entry.toolCallId, entry]));
  const visit = (items: TimelineItem[], parent?: string) => {
    for (const item of items) {
      if (item.kind !== "tool") continue;
      if (parent) parents.set(item.id, parent);
      if (item.detail?.type === "subagent" && item.detail.workflow) workflows.set(item.id, item.detail.workflow);
      if (item.sub) visit(item.sub.items, item.id);
    }
  };
  visit(items);
  for (const entry of listed ?? []) {
    if (entry.parentToolCallId) parents.set(entry.toolCallId, entry.parentToolCallId);
    if (entry.workflow) workflows.set(entry.toolCallId, entry.workflow);
  }
  // These snapshots survive pagination and follow the latest event sequence.
  for (const record of Object.values(records ?? {})) workflows.set(record.toolCallId, record.workflow);
  for (const [call, workflow] of workflows) {
    for (const agent of workflow.agents ?? []) {
      if (agent.toolCallId) parents.set(agent.toolCallId, call);
    }
  }
  for (const call of parents.keys()) {
    const seen = new Set([call]);
    let parent = parents.get(call);
    while (parent && !seen.has(parent)) {
      if (workflows.has(parent)) { children.add(call); break; }
      seen.add(parent);
      parent = parents.get(parent);
    }
  }
  return items.flatMap<TimelineItem>((item) => {
    if (item.kind !== "tool") return [item];
    if (children.has(item.id)) return [];
    const workflow = workflows.get(item.id);
    const entry = entries.get(item.id);
    if (!workflow && !entry) return [item];
    const detail = item.detail?.type === "subagent" ? item.detail : undefined;
    return [{ ...item, detail: { ...detail, type: "subagent", action: "spawn",
      task: detail?.task ?? records?.[item.id]?.task ?? entry?.task,
      state: detail?.state ?? entry?.state ?? (entry?.running ? "running" : entry?.failed ? "failed" : undefined),
      workflow,
    } }];
  });
}

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
