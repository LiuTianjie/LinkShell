import type { AgentInfo, SessionDriver } from "@linkshell/wire";

/** A handoff at the desktop must interrupt its writer even if remote turns can accept input. */
export function queuedSendAction(agent: Pick<AgentInfo, "tier" | "capabilities"> | undefined, turnActive: boolean, driver?: SessionDriver) {
  if (!turnActive) return { label: "发送", detail: "现在发送这条消息", interrupts: false };
  if (!agent) return { label: "立即发送", detail: "按当前会话支持的方式发送", interrupts: false };
  if (agent?.capabilities.steer && !(agent.tier === "handoff" && driver === "desktop")) {
    return { label: "插话", detail: "将这条消息补充到当前回合", interrupts: false };
  }
  return { label: "中断发送", detail: "先停止当前回合，再发送这条消息", interrupts: true };
}
