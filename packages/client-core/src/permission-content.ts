import type { PendingPermissionSummary, ToolCallContent } from "@linkshell/wire";

/** Plans are prose; the remaining approval parameters must still be inspectable. */
export function permissionContent(request: PendingPermissionSummary): {
  markdown?: string;
  detail?: string;
  rawInput?: unknown;
  content: ToolCallContent[];
} {
  const tool = request.tool;
  let rawInput = tool?.rawInput;
  let content = tool?.content ?? [];
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : undefined;
  let markdown = typeof input?.plan === "string" && input.plan.trim() ? input.plan : undefined;
  if (markdown) {
    const { plan: _plan, ...remaining } = input!;
    rawInput = Object.keys(remaining).length ? remaining : undefined;
    content = content.filter((entry) => entry.type !== "content" || entry.content.type !== "text" || entry.content.text.trim() !== markdown!.trim());
  } else if (tool?.kind === "switch_mode") {
    // ACP's Claude adapter sends the proposed plan as Markdown content on the mode switch.
    const parts = content.flatMap((entry) => entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : []);
    const text = parts.join("\n\n");
    if (text.trim()) {
      markdown = text;
      content = content.filter((entry) => entry.type !== "content" || entry.content.type !== "text");
    }
  }
  return {
    markdown,
    detail: markdown && request.detail?.trim() === markdown.trim() ? undefined : request.detail,
    rawInput,
    content,
  };
}
