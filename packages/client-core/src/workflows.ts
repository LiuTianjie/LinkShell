import type { SessionEvent, SubagentInfo, Workflow } from "@linkshell/wire";

export interface WorkflowRecord {
  toolCallId: string;
  task: string;
  startedAt: number;
  lastSeq: number;
  workflow: Workflow;
}
export type WorkflowRecords = Record<string, WorkflowRecord>;

export function workflowIsLive(workflow: Workflow): boolean {
  return workflow.state === "running" || workflow.state === "paused" ||
    workflow.agents?.some((agent) => agent.state === "running" || agent.state === "paused") === true;
}

function merge(records: WorkflowRecords, record: WorkflowRecord): WorkflowRecords {
  const previous = records[record.toolCallId];
  if (previous && previous.lastSeq >= record.lastSeq) return records;
  return { ...records, [record.toolCallId]: { ...record,
    startedAt: record.workflow.startedAt ?? previous?.startedAt ?? record.startedAt,
    workflow: { ...previous?.workflow, ...record.workflow },
  } };
}

/** Roster state follows the event sequence, independently of timeline pagination. */
export function applyWorkflowEvent(records: WorkflowRecords, event: SessionEvent): WorkflowRecords {
  const update = event.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return records;
  const previous = records[update.toolCallId];
  const detail = update.detail?.type === "subagent" ? update.detail : undefined;
  if (!detail?.workflow) {
    // A launch can fail before Claude creates its background run.
    if (previous && !previous.workflow.state && update.status === "failed") {
      return merge(records, { ...previous, lastSeq: event.seq, workflow: { ...previous.workflow, state: "failed", endedAt: event.ts } });
    }
    return records;
  }
  return merge(records, {
    toolCallId: update.toolCallId,
    task: detail.task ?? previous?.task ?? update.title ?? "工作流",
    startedAt: previous?.startedAt ?? event.ts,
    lastSeq: event.seq,
    workflow: detail.workflow,
  });
}

export function mergeWorkflowList(records: WorkflowRecords, entries: SubagentInfo[]): WorkflowRecords {
  return entries.reduce((current, entry) => entry.workflow ? merge(current, {
    toolCallId: entry.toolCallId, task: entry.task, startedAt: entry.startedAt,
    lastSeq: entry.lastSeq ?? 0, workflow: entry.workflow,
  }) : current, records);
}
