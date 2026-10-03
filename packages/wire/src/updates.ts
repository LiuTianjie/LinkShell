import { z } from "zod";
import { permissionOptionSchema, questionAnswerSchema, questionSchema, sessionDriverSchema, sessionStateSchema, toolKindSchema } from "./model.js";
import { workflowAgentStateSchema, workflowSchema } from "./workflow.js";

// Session updates mirror ACP's `SessionUpdate` shapes (discriminated by
// `sessionUpdate`) so one renderer works for every agent. LinkShell-specific
// updates use the `ls_` prefix.

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string().optional(),
    uri: z.string().optional(),
  }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    /** What the link names: a file (default), a skill the user invoked, or another agent. */
    kind: z.enum(["file", "skill", "agent"]).optional(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const toolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

export const toolCallContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: contentBlockSchema }),
  /** ACP diff: full before/after text. */
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullable().optional(),
    newText: z.string(),
  }),
  /** Unified diff, for agents (Codex) that report patches rather than file text. */
  z.object({
    type: z.literal("patch"),
    path: z.string(),
    change: z.enum(["add", "delete", "update"]),
    movePath: z.string().optional(),
    diff: z.string(),
  }),
  z.object({ type: z.literal("terminal"), terminalId: z.string() }),
]);
export type ToolCallContent = z.infer<typeof toolCallContentSchema>;

export const toolCallLocationSchema = z.object({
  path: z.string(),
  line: z.number().int().optional(),
});
export type ToolCallLocation = z.infer<typeof toolCallLocationSchema>;

/**
 * What a tool call is, when the agent tells us more than ACP's coarse `kind`.
 * Host drivers fill it from each agent's own tool names; clients render it the
 * same way for every agent and fall back to `title` + `kind` without it.
 */
export const toolDetailSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcp"), server: z.string(), tool: z.string() }),
  z.object({
    type: z.literal("subagent"),
    /** spawn starts a sub-agent (its work nests under this call); the rest talk to one. */
    action: z.enum(["spawn", "message", "wait", "stop", "resume", "list"]).default("spawn"),
    task: z.string().optional(),
    /** The sub-agent's role or type, e.g. "Explore". */
    agentType: z.string().optional(),
    model: z.string().optional(),
    /** Agent outcome when a tool's coarse completed/failed state is insufficient. */
    state: workflowAgentStateSchema.optional(),
    /** A Claude workflow is a background run containing its own agents. Counts are observed, not a predicted total. */
    workflow: workflowSchema.optional(),
  }),
  z.object({ type: z.literal("skill"), name: z.string(), description: z.string().optional() }),
  z.object({ type: z.literal("web_search"), query: z.string().optional() }),
  z.object({ type: z.literal("image_generation"), prompt: z.string().optional() }),
  z.object({ type: z.literal("compaction") }),
  z.object({ type: z.literal("review"), phase: z.enum(["started", "finished"]) }),
  /** The agent asked the user something (the first question, when there were several). */
  z.object({ type: z.literal("question"), text: z.string(), more: z.number().int().optional() }),
]);
export type ToolDetail = z.infer<typeof toolDetailSchema>;

export const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

export const stopReasonSchema = z.enum(["end_turn", "cancelled", "error", "max_tokens", "refusal"]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const sessionConfigOptionSchema = z.object({
  /** Agent-defined id; "model" and "mode" are the common ones. */
  id: z.string(),
  name: z.string(),
  category: z.enum(["model", "mode", "effort", "other"]).default("other"),
  current: z.string(),
  values: z.array(z.object({ value: z.string(), name: z.string(), description: z.string().optional() })),
});
export type SessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;

export const sessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z.object({
    sessionUpdate: z.literal("user_message_chunk"),
    messageId: z.string().optional(),
    content: contentBlockSchema,
  }),
  z.object({
    sessionUpdate: z.literal("agent_message_chunk"),
    parentToolCallId: z.string().optional(),
    messageId: z.string(),
    content: contentBlockSchema,
  }),
  z.object({
    sessionUpdate: z.literal("agent_thought_chunk"),
    parentToolCallId: z.string().optional(),
    messageId: z.string(),
    content: contentBlockSchema,
  }),
  z.object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    /** Set when a sub-agent made this call: the sub-agent's own (spawn) tool call. */
    parentToolCallId: z.string().optional(),
    title: z.string(),
    kind: toolKindSchema,
    status: toolCallStatusSchema,
    rawInput: z.unknown().optional(),
    content: z.array(toolCallContentSchema).optional(),
    locations: z.array(toolCallLocationSchema).optional(),
    detail: toolDetailSchema.optional(),
  }),
  z.object({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string(),
    parentToolCallId: z.string().optional(),
    status: toolCallStatusSchema.optional(),
    title: z.string().optional(),
    detail: toolDetailSchema.optional(),
    /** Replaces the tool call's content when present. */
    content: z.array(toolCallContentSchema).optional(),
    /** Streamed output appended to the tool call's running output. */
    appendOutput: z.string().optional(),
    rawOutput: z.unknown().optional(),
  }),
  z.object({
    sessionUpdate: z.literal("plan"),
    entries: z.array(planEntrySchema),
  }),
  z.object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(
      z.object({ name: z.string(), description: z.string(), hint: z.string().optional() }),
    ),
  }),
  z.object({
    sessionUpdate: z.literal("current_mode_update"),
    currentModeId: z.string(),
  }),
  z.object({
    sessionUpdate: z.literal("session_info_update"),
    title: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    sessionUpdate: z.literal("usage_update"),
    usedTokens: z.number().optional(),
    contextWindow: z.number().optional(),
  }),
  // ── LinkShell extensions ──
  z.object({
    sessionUpdate: z.literal("ls_message_done"),
    parentToolCallId: z.string().optional(),
    messageId: z.string(),
    role: z.enum(["agent", "thought", "user"]),
  }),
  /** Selectable session settings (model, permission mode, effort…) as the agent reports them. */
  z.object({
    sessionUpdate: z.literal("ls_config"),
    options: z.array(sessionConfigOptionSchema),
  }),
  z.object({
    sessionUpdate: z.literal("ls_notice"),
    level: z.enum(["info", "warning"]),
    title: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    sessionUpdate: z.literal("ls_turn"),
    /** A sub-agent's turn: whether the sub-agent under this call is working. */
    parentToolCallId: z.string().optional(),
    state: z.enum(["started", "ended"]),
    turnId: z.string().optional(),
    stopReason: stopReasonSchema.optional(),
  }),
  z.object({
    sessionUpdate: z.literal("ls_permission"),
    requestId: z.string(),
    toolCallId: z.string().optional(),
    title: z.string(),
    detail: z.string().optional(),
    options: z.array(permissionOptionSchema).min(1),
    /**
     * The agent is asking the user something: answer with `sessions.answer`.
     * `options` then hold what else can be done (skip the questions, stop),
     * which is also all an app that predates questions can offer.
     */
    questions: z.array(questionSchema).optional(),
  }),
  z.object({
    sessionUpdate: z.literal("ls_permission_resolved"),
    requestId: z.string(),
    optionId: z.string().optional(),
    /** How questions were answered, for the record. */
    answers: z.array(questionAnswerSchema).optional(),
  }),
  z.object({
    sessionUpdate: z.literal("ls_driver"),
    driver: sessionDriverSchema,
    deviceId: z.string().optional(),
  }),
  z.object({
    sessionUpdate: z.literal("ls_status"),
    state: sessionStateSchema,
  }),
  z.object({
    sessionUpdate: z.literal("ls_error"),
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  }),
]);
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;
export type SessionUpdateKind = SessionUpdate["sessionUpdate"];

/** One entry in a session's append-only event log. */
export const sessionEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().positive(),
  ts: z.number(),
  update: sessionUpdateSchema,
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;
