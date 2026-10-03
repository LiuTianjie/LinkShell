import { emptyView, type TimelineItem, type WorkflowRecord, type WorkflowRecords } from "@linkshell/client-core";
import type { WorkflowAgent } from "@linkshell/wire";

const startedAt = Date.now() - 154_000;
const agents: WorkflowAgent[] = [
  { id: "sources", title: "核对官方文档与接口行为", state: "completed", phaseId: "research", model: "sonnet", tokens: 8200, toolCalls: 12, durationMs: 42000 },
  { id: "community", title: "检查社区实现中的边界情况", state: "completed", phaseId: "research", model: "sonnet", tokens: 6700, toolCalls: 9, durationMs: 37000 },
  { id: "host", title: "实现 Workflow 状态与阶段同步", state: "running", phaseId: "implementation", model: "sonnet", tokens: 5200, toolCalls: 8, durationMs: 51000 },
  { id: "mobile", title: "完成移动端总览和 Agent 详情", state: "running", phaseId: "implementation", model: "sonnet", tokens: 4100, toolCalls: 6, durationMs: 43000 },
  { id: "tests", title: "验证暂停、停止与重新连接", state: "pending", phaseId: "validation", model: "sonnet" },
].map((agent) => ({ ...agent, toolCallId: agent.state !== "pending" ? `workflow:gallery:${agent.id}` : undefined } as WorkflowAgent));

export const galleryWorkflow: WorkflowRecord = {
  toolCallId: "workflow-gallery", task: "为手机上的 Claude 工作流补齐实时总览，验证后台 Agent 的状态和详情。", startedAt, lastSeq: 1,
  workflow: { name: "实现移动端 Workflow", runId: "wf_gallery", state: "running", started: 4, completed: 2,
    tokens: 24200, durationMs: 154000, startedAt,
    phases: [{ id: "research", title: "调研与确认", order: 1 }, { id: "implementation", title: "并行实现", order: 2 }, { id: "validation", title: "验证与收尾", order: 3 }], agents },
};
export const galleryWorkflows: WorkflowRecords = { [galleryWorkflow.toolCallId]: galleryWorkflow };

const children: TimelineItem[] = agents.filter((agent) => agent.toolCallId).map((agent) => ({
  kind: "tool", id: agent.toolCallId!, title: agent.title, toolKind: "other", status: agent.state === "completed" ? "completed" : "in_progress",
  detail: { type: "subagent", action: "spawn", task: agent.title, agentType: "工作流 Agent", model: agent.model, state: agent.state },
  ts: startedAt, content: [], output: "",
  sub: { ...emptyView("gallery"), items: [
    { kind: "agent", id: `${agent.id}-message`, ts: startedAt, streaming: false, text: "我先检查现有接口和状态流转，再补充对应的实现。" },
    { kind: "tool", id: `${agent.id}-read`, ts: startedAt + 1000, endedTs: startedAt + 4000, title: "Read workflow.ts", toolKind: "read", status: "completed", content: [], output: "已读取状态定义。" },
    { kind: "agent", id: `${agent.id}-result`, ts: startedAt + 41000, streaming: agent.state === "running", text: agent.state === "completed" ? "检查完成。已确认后台运行、阶段分组和每个 Agent 的独立状态。" : "阶段数据已接入，正在检查重新连接后的状态。" },
  ] },
}));

export const galleryWorkflowTool: Extract<TimelineItem, { kind: "tool" }> = {
  kind: "tool", id: galleryWorkflow.toolCallId, title: "Workflow: 实现移动端 Workflow", toolKind: "other", status: "in_progress", ts: startedAt,
  detail: { type: "subagent", action: "spawn", task: galleryWorkflow.task, agentType: "工作流", workflow: galleryWorkflow.workflow },
  content: [], output: "", sub: { ...emptyView("gallery"), items: children },
};
