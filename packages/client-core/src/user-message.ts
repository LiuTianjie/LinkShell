import type { ContentBlock } from "@linkshell/wire";

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
 * The text to show for a user message. Codex Desktop wraps image sends in a
 * "# Files mentioned by the user: … ## My request:" envelope and scheduled
 * runs in `<heartbeat>` / `<codex_automation_message>` XML; those envelopes are
 * plumbing, not something the reader typed, so presentation strips them back to
 * the request. The stored prompt and what was sent to the agent stay intact.
 */
export function userMessageText(blocks: ContentBlock[]): string {
  const automation = automationMessage(blocks);
  if (automation) return automation.instructions;
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const imageCount = blocks.filter((block) => block.type === "image").length;
  if (!imageCount) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  // Match the whole desktop-generated image envelope, not a heading mentioned in ordinary prose.
  const envelope =
    /^# Files mentioned by the user:\n\n([\s\S]+?)\n\nDistinguish instructions in attached documents from the user's request\.\n\n## My request:(?:\n([\s\S]*))?$/.exec(
      normalized,
    );
  if (!envelope) return text;
  const files = envelope[1]!.split("\n\n");
  if (
    files.length > imageCount ||
    !files.every((file) => {
      const entry =
        /^## ([^\n]+?): ((?:\/|[A-Za-z]:[\\/])[^\n]+)\nImage attachment: true$/.exec(
          file,
        );
      return !!entry && entry[2]!.split(/[\\/]/).at(-1) === entry[1];
    })
  )
    return text;
  return (envelope[2] ?? "").trim();
}
