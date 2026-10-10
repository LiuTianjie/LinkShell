import { StringDecoder } from "node:string_decoder";
import { sessionUpdateSchema, type ContentBlock, type SessionUpdate, type ToolCallStatus } from "@linkshell/wire";
import { normalizeAcpUpdate, toContentBlock } from "./mapper.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const blocks = (value: unknown): ContentBlock[] => Array.isArray(value) ? value.flatMap((entry) => { const block = toContentBlock(entry); return block ? [block] : []; }) : [];
const optional = (value: unknown) => typeof value === "string" ? value : undefined;
const LIMIT = 1024 * 1024;

/** Stateful snapshots are scoped to one session, so IDs from other sessions never collide. */
export class AcpUpdates {
  private readonly compactions = new Map<string, { status: ToolCallStatus; title: string; content: ContentBlock[]; error?: string }>();
  private readonly terminals = new Map<string, { output: string; decoder: StringDecoder; calls: Set<string>; command?: string; cwd?: string; exitStatus?: unknown }>();

  map(raw: unknown, version: 1 | 2): SessionUpdate[] {
    const update = object(raw);
    const kind = update.sessionUpdate;
    if (kind === "compaction_update" || kind === "compaction_summary_chunk") {
      const id = optional(update.compactionId); if (!id) return [];
      const state = this.compactions.get(id) ?? { status: "in_progress", title: "整理上下文", content: [] };
      if (kind === "compaction_update") {
        state.status = update.status === "completed" ? "completed" : update.status === "failed" || update.status === "cancelled" ? "failed" : "in_progress";
        state.title = update.status === "cancelled" ? "上下文整理已取消" : "整理上下文";
        if (update.summary !== undefined) state.content = blocks(update.summary);
        if (update.error !== undefined) state.error = optional(update.error);
      } else {
        const content = toContentBlock(update.content); if (content) state.content.push(content);
      }
      this.compactions.set(id, state);
      return [{ sessionUpdate: "tool_call_update", toolCallId: `acp:compaction:${id}`, title: state.title, kind: "think", status: state.status,
        detail: { type: "compaction" }, replaceContent: true, content: state.content.map((content) => ({ type: "content", content })), rawOutput: state.error ?? null }];
    }
    if (kind === "plan_update") {
      const plan = object(update.plan), id = optional(plan.planId); if (!id) return [];
      const mapped = normalizeAcpUpdate({ sessionUpdate: "plan", entries: plan.entries });
      if (!mapped || mapped.sessionUpdate !== "plan") return [];
      return [{ ...mapped, planId: id, markdown: plan.type === "markdown" ? optional(plan.content) : null, path: plan.type === "file" ? optional(plan.uri) : null }];
    }
    if (kind === "plan_removed" && typeof update.planId === "string") return [{ sessionUpdate: "plan", entries: [], planId: update.planId, removed: true }];
    if (kind === "session_message" || kind === "session_message_chunk" || (version === 2 && ["user_message", "agent_message", "agent_thought"].includes(String(kind)))) {
      const id = optional(update.messageId); if (!id) return [];
      const content = kind === "session_message_chunk" ? blocks([update.content]) : update.content === undefined ? undefined : blocks(update.content);
      return [{ sessionUpdate: "ls_message", messageId: id, role: kind === "user_message" ? "user" : kind === "agent_thought" ? "thought" : kind === "agent_message" ? "agent" : "session",
        content, append: kind === "session_message_chunk" || undefined, senderSessionId: optional(update.senderSessionId), recipientSessionId: optional(update.recipientSessionId) }];
    }
    if (version === 2 && (kind === "terminal_update" || kind === "terminal_output_chunk")) {
      const id = optional(update.terminalId); if (!id) return [];
      const terminal = this.terminal(id);
      if (kind === "terminal_output_chunk" && typeof update.data === "string") terminal.output += terminal.decoder.write(Buffer.from(update.data, "base64"));
      if (kind === "terminal_update") {
        if (update.output !== undefined) {
          terminal.decoder = new StringDecoder("utf8");
          terminal.output = terminal.decoder.write(Buffer.from(optional(object(update.output).data) ?? "", "base64"));
        }
        if (update.command !== undefined) terminal.command = optional(update.command);
        if (update.cwd !== undefined) terminal.cwd = optional(update.cwd);
        if (update.exitStatus !== undefined) {
          terminal.exitStatus = update.exitStatus;
          if (update.exitStatus !== null) terminal.output += terminal.decoder.end();
        }
      }
      terminal.output = terminal.output.slice(-LIMIT);
      return [...terminal.calls].map((toolCallId) => this.terminalUpdate(toolCallId, terminal));
    }
    let mapped = normalizeAcpUpdate(raw);
    if (!mapped) return [];
    if (version === 2 && mapped.sessionUpdate === "tool_call_update") {
      mapped = { ...mapped, replaceContent: update.content !== undefined,
        ...(update.title === null ? { title: "工具" } : {}), ...(update.name === null ? { name: "" } : {}),
        ...(update.kind === null ? { kind: "other" } : {}), ...(update.status === null ? { status: "pending" } : {}),
        ...(update.content === null ? { content: [] } : {}), ...(update.locations === null ? { locations: [] } : {}),
      };
    }
    const result = [mapped];
    if (version === 2 && (mapped.sessionUpdate === "tool_call" || mapped.sessionUpdate === "tool_call_update")) {
      for (const item of mapped.content ?? []) {
        if (item.type !== "terminal") continue;
        const terminal = this.terminal(item.terminalId); terminal.calls.add(mapped.toolCallId);
        result.push(this.terminalUpdate(mapped.toolCallId, terminal));
      }
    }
    return result;
  }

  private terminal(id: string) {
    let terminal = this.terminals.get(id);
    if (!terminal) { terminal = { output: "", decoder: new StringDecoder("utf8"), calls: new Set() }; this.terminals.set(id, terminal); }
    return terminal;
  }
  private terminalUpdate(toolCallId: string, terminal: ReturnType<AcpUpdates["terminal"]>): SessionUpdate {
    return { sessionUpdate: "tool_call_update", toolCallId, replaceOutput: terminal.output,
      rawOutput: { command: terminal.command, cwd: terminal.cwd, exitStatus: terminal.exitStatus },
    };
  }
}

export function usageUpdate(value: unknown): SessionUpdate | undefined {
  const parsed = sessionUpdateSchema.safeParse({ sessionUpdate: "usage_update", tokens: value });
  return parsed.success ? parsed.data : undefined;
}
