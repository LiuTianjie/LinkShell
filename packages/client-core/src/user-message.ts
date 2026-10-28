import { readUserText, type ContentBlock, type UserEvent, type UserTextView } from "@linkshell/wire";

export interface AutomationMessage {
  kind: "heartbeat" | "automation";
  automationId?: string;
  runId?: string;
  title?: string;
  timeIso?: string;
  instructions: string;
}

function xmlTag(source: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(source);
  return match?.[1]?.trim() || undefined;
}

/**
 * Parses Codex Desktop's scheduled task / heartbeat user message envelopes
 * (`<heartbeat>…</heartbeat>` and `<codex_automation_message>…</codex_automation_message>`).
 */
export function automationMessage(blocks: ContentBlock[]): AutomationMessage | undefined {
  const raw = blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!raw) return undefined;

  const heartbeat = /^<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>$/i.exec(raw);
  if (heartbeat) {
    const body = heartbeat[1]!;
    const instructions = xmlTag(body, "instructions") ?? body.replace(/<(?:automation_id|current_time_iso)>[\s\S]*?<\/(?:automation_id|current_time_iso)>/gi, "").trim();
    return {
      kind: "heartbeat",
      automationId: xmlTag(body, "automation_id"),
      timeIso: xmlTag(body, "current_time_iso"),
      instructions,
    };
  }

  const auto = /^<codex_automation_message>\s*([\s\S]*?)\s*<\/codex_automation_message>$/i.exec(raw);
  if (auto) {
    const body = auto[1]!;
    const title = xmlTag(body, "title");
    const instructions = xmlTag(body, "body") ?? title ?? "";
    return {
      kind: "automation",
      automationId: xmlTag(body, "automation_id"),
      runId: xmlTag(body, "run_id"),
      title,
      instructions,
    };
  }

  return undefined;
}

/**
 * Strips Codex Desktop's `<heartbeat><decision>…</decision><message>…</message></heartbeat>`
 * trailer from assistant replies, falling back to `<message>` when no other text was emitted.
 */
export function cleanAgentHeartbeatText(text: string): {
  text: string;
  heartbeat?: { automationId?: string; decision?: string; message?: string };
} {
  if (!/<heartbeat>[\s\S]*?<\/heartbeat>/i.test(text)) return { text };
  let heartbeat: { automationId?: string; decision?: string; message?: string } | undefined;
  const visible = text
    .replace(/(?:```(?:xml)?\s*)?<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>(?:\s*```)?/gi, (full, inner: string) => {
      const decision = xmlTag(inner, "decision");
      const automationId = xmlTag(inner, "automation_id");
      const message = xmlTag(inner, "message");
      if (!decision && !automationId && !message) return full;
      heartbeat = { automationId, decision, message };
      return "";
    })
    .trim();
  if (!heartbeat) return { text };
  return {
    text: visible || heartbeat.message || "定时检查完成",
    heartbeat,
  };
}

/**
 * How to show a user message: the words, what came with them, or the one event or command it is
 * (see `readUserText` in @linkshell/wire). Codex Desktop's scheduled runs read as their
 * instructions. The stored prompt and what was sent to the agent stay intact.
 */
export function userMessageView(blocks: ContentBlock[]): UserTextView {
  const automation = automationMessage(blocks);
  if (automation) return { text: automation.instructions, context: [], hidden: false };
  const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
  const others = blocks.filter((block) => block.type !== "text").length;
  const view = readUserText(text, { images: blocks.filter((block) => block.type === "image").length });
  // Pictures or files sent with nothing else are still a message.
  return view.hidden && others ? { ...view, hidden: false } : view;
}

/** The words of a user message, without the envelopes agents and their clients wrap around them. */
export function userMessageText(blocks: ContentBlock[]): string {
  return userMessageView(blocks).text;
}

/** The line for a message that is an event rather than something said. */
export function userEventLabel(event: UserEvent): string {
  switch (event.kind) {
    case "ci": return event.count > 1 ? `收到 ${event.count} 个 CI 事件` : "收到 CI 事件";
    case "github": return event.count > 1 ? `收到 ${event.count} 个 GitHub 事件` : "收到 GitHub 事件";
    case "scheduled": return `定时任务：${event.name}`;
    case "sessions":
      return event.sessions.length ? `${event.sessions.map((session) => `「${session.title}」`).join("、")}完成了一轮` : "你启动的会话有了新进展";
  }
}
