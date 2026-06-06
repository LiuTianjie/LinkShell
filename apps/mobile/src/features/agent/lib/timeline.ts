import type * as ImagePicker from "expo-image-picker";
import type { Theme } from "../../../theme";
import type {
  AgentContentBlock,
  AgentNotice,
  AgentSubagentAction,
  AgentTimelineItem,
} from "../types";
import { normalizedToken } from "./format";

export type TimelineBottomSpacer = {
  id: "__timeline-bottom-spacer";
  type: "bottom_spacer";
  spacerHeight: number;
};

export type TimelineListItem = AgentTimelineItem | TimelineBottomSpacer;

export type AgentRailTone = "default" | "running" | "warning" | "error" | "success";

export function isTimelineBottomSpacer(item: TimelineListItem): item is TimelineBottomSpacer {
  return item.type === "bottom_spacer";
}

export function agentRailColor(tone: AgentRailTone, theme: Theme): string {
  if (tone === "running") return theme.accent;
  if (tone === "warning") return theme.warning;
  if (tone === "error") return theme.error;
  if (tone === "success") return theme.success;
  return theme.textTertiary;
}

export function subagentTitle(action: AgentSubagentAction): string {
  const count = Math.max(1, action.receiverThreadIds.length, action.receiverAgents.length);
  const token = normalizedToken(action.tool);
  if (token.includes("spawn")) return `启动 ${count} 个子 Agent`;
  if (token.includes("wait")) return `等待 ${count} 个子 Agent`;
  if (token.includes("resume")) return `恢复 ${count} 个子 Agent`;
  if (token.includes("close")) return `关闭 ${count} 个子 Agent`;
  if (token.includes("sendinput")) return `更新 ${count} 个子 Agent`;
  return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
}

export function subagentStatusLabel(status: string | undefined): string {
  const token = normalizedToken(status);
  if (token === "completed" || token === "done" || token === "success") return "完成";
  if (token === "failed" || token === "error") return "失败";
  if (token === "stopped" || token === "cancelled") return "已停止";
  if (token === "queued" || token === "pending") return "排队中";
  if (token === "running" || token === "inprogress") return "运行中";
  return status || "未知";
}

export function subagentDisplayName(
  agent: AgentSubagentAction["receiverAgents"][number],
  fallbackThreadId: string,
): string {
  if (agent.nickname && agent.role) return `${agent.nickname} [${agent.role}]`;
  if (agent.nickname) return agent.nickname;
  if (agent.role) return agent.role;
  return fallbackThreadId.length > 14 ? `Agent ${fallbackThreadId.slice(-8)}` : fallbackThreadId || "Agent";
}

export function fileToolDedupeKey(item: AgentTimelineItem): string | null {
  const tool = item.toolCall;
  if (item.type !== "tool_call" || !tool?.name.includes("文件")) return null;
  const output = tool.output?.trim();
  if (output) return `file-output:${output}`;
  const input = tool.input?.trim();
  return input ? `file-input:${input}` : null;
}

export function dedupeTimelineItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  const keepByKey = new Map<string, number>();
  items.forEach((item, index) => {
    const key = fileToolDedupeKey(item);
    if (key) keepByKey.set(key, index);
  });
  return items.filter((item, index) => {
    const key = fileToolDedupeKey(item);
    return !key || keepByKey.get(key) === index;
  });
}

export function userMessageDeliveryLabel(
  item: AgentTimelineItem,
): { text: string; pending: boolean } | null {
  const delivery = item.metadata?.delivery;
  if (delivery !== "steer" && delivery !== "queued" && delivery !== "new_turn") return null;
  if (item.metadata?.fallbackFrom === "steer") {
    return { text: "已作为新消息发送", pending: false };
  }
  if (delivery === "queued") {
    return { text: "排队中", pending: false };
  }
  if (delivery === "steer") {
    return { text: "已引导", pending: false };
  }
  return null;
}

export function isQueuedFollowUpItem(item: AgentTimelineItem, conversationStatus?: string): boolean {
  return item.type === "message" &&
    item.role === "user" &&
    (item.metadata?.delivery === "queued" || item.metadata?.delivery === "steer") &&
    item.metadata?.fallbackFrom !== "steer" &&
    item.metadata?.queuedSent !== true &&
    item.metadata?.queuedDiscarded !== true &&
    (item.metadata?.optimistic === true || conversationStatus === "running");
}

export function isQueuedFollowUpPlaceholder(item: AgentTimelineItem): boolean {
  return item.type === "message" &&
    item.role === "user" &&
    item.metadata?.delivery === "queued";
}

export function queuedFollowUpText(blocks: AgentContentBlock[] | undefined): string {
  const text = (blocks ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : "图片附件")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

export function imageBlockFromAsset(asset: ImagePicker.ImagePickerAsset): AgentContentBlock | null {
  if (!asset.base64) return null;
  const mimeType = asset.mimeType || "image/jpeg";
  return {
    type: "image",
    data: `data:${mimeType};base64,${asset.base64}`,
    mimeType,
    text: asset.fileName || "图片附件",
  };
}

export function noticeAccent(
  kind: AgentNotice["kind"],
  theme: Theme,
): { bg: string; color: string; icon: string } {
  if (kind === "warning" || kind === "native_unsupported") {
    return { bg: theme.errorLight, color: theme.error, icon: "exclamationmark.triangle.fill" };
  }
  if (kind === "model_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "sparkles" };
  }
  if (kind === "effort_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "textformat.size.larger" };
  }
  if (kind === "permission_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "lock.shield.fill" };
  }
  return { bg: theme.bgInput, color: theme.textSecondary, icon: "info.circle.fill" };
}
