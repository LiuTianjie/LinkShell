import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionGoalSchema, type ContentBlock, type PlanEntry, type SessionUpdate, type ToolCallContent, type ToolDetail, type ToolKind } from "@linkshell/wire";
import { inlineImage } from "../images.js";
import { nestUnder } from "../nesting.js";
import { ClaudeChildIndex, ownedFile } from "./children.js";

// Claude Code writes each session to ~/.claude/projects/<encoded cwd>/<id>.jsonl,
// one JSON object per line. Assistant lines are one content block each
// (thinking / text / tool_use) and share the API message id (`msg_…`); tool
// results arrive in later user lines keyed by `tool_use_id`. These are the same
// ids the ACP adapter stamps live, so both views produce the same item ids.

type Json = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function findTranscript(configDir: string, sessionId: string, cwd?: string): string | undefined {
  const projects = join(configDir, "projects");
  if (cwd) {
    const direct = join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"]);

function fileName(path: string | undefined): string {
  return path ? basename(path) : "file";
}

/** A readable title and kind for a Claude Code tool call. */
export function describeClaudeTool(name: string, input: Json): { title: string; kind: ToolKind; detail?: ToolDetail } {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { title: `Read ${fileName(path)}`, kind: "read" };
    case "Write":
      return { title: `Write ${fileName(path)}`, kind: "edit" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { title: `Edit ${fileName(path)}`, kind: "edit" };
    case "Bash":
      return { title: str(input.description) ?? str(input.command) ?? "Run command", kind: "execute" };
    case "Grep":
      return { title: `Search “${str(input.pattern) ?? ""}”${path ? ` in ${fileName(path)}` : ""}`, kind: "search" };
    case "Glob":
      return { title: `Find ${str(input.pattern) ?? "files"}`, kind: "search" };
    case "WebFetch":
      return { title: `Fetch ${str(input.url) ?? ""}`.trim(), kind: "fetch" };
    case "WebSearch":
      return { title: `Search web: ${str(input.query) ?? ""}`.trim(), kind: "fetch", detail: { type: "web_search", query: str(input.query) } };
    case "Task":
    case "Agent":
      return {
        title: `Agent: ${str(input.description) ?? str(input.subagent_type) ?? "task"}`,
        kind: "other",
        detail: {
          type: "subagent",
          action: "spawn",
          task: str(input.description) ?? str(input.prompt),
          agentType: str(input.subagent_type),
          name: str(input.name),
          model: str(input.model),
        },
      };
    case "Workflow":
      return {
        title: `Workflow: ${str(input.name) ?? str(input.description) ?? "工作流"}`,
        kind: "other",
        detail: { type: "subagent", action: "spawn", agentType: "工作流", task: str(input.description) ?? str(input.name), workflow: {} },
      };
    case "SendMessage":
      return {
        title: `Message ${str(input.to) ?? "agent"}`,
        kind: "other",
        detail: { type: "subagent", action: "message", task: str(input.summary) ?? str(input.message) },
      };
    case "TaskStop":
    case "KillShell":
      return { title: name === "TaskStop" ? "Stop agent" : "Stop shell", kind: "other", detail: name === "TaskStop" ? { type: "subagent", action: "stop" } : undefined };
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? input.questions.flatMap((entry) => str(obj(entry)?.question) ?? []) : [];
      const [text] = questions;
      // (Its input arrives after the call is announced: until then there is nothing to say about it.)
      if (!text) return { title: "Ask a question", kind: "other" };
      return { title: `Ask: ${text}`, kind: "other", detail: { type: "question", text, more: questions.length > 1 ? questions.length - 1 : undefined } };
    }
    case "Skill": {
      const skill = str(input.skill) ?? str(input.command) ?? "skill";
      return { title: `Skill: ${skill}`, kind: "other", detail: { type: "skill", name: skill.replace(/^\//, "") } };
    }
    default: {
      // MCP tools are named mcp__<server>__<tool>.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return { title: `${mcp[1]} · ${mcp[2]}`, kind: "other", detail: { type: "mcp", server: mcp[1]!, tool: mcp[2]! } };
      return { title: name, kind: FILE_TOOLS.has(name) ? "edit" : "other" };
    }
  }
}

function toolContent(name: string, input: Json): ToolCallContent[] | undefined {
  const path = str(input.file_path);
  if (!path) return undefined;
  if (name === "Write" && typeof input.content === "string") {
    return [{ type: "diff", path, oldText: null, newText: input.content }];
  }
  if (name === "Edit" && typeof input.new_string === "string") {
    return [{ type: "diff", path, oldText: str(input.old_string) ?? null, newText: input.new_string }];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((raw): ToolCallContent[] => {
      const edit = obj(raw);
      return typeof edit?.new_string === "string" ? [{ type: "diff", path, oldText: str(edit.old_string) ?? null, newText: edit.new_string }] : [];
    });
  }
  return undefined;
}

function todoPlan(input: Json): PlanEntry[] | undefined {
  if (!Array.isArray(input.todos)) return undefined;
  return input.todos.flatMap((raw) => {
    const todo = obj(raw);
    const content = str(todo?.content);
    if (!content) return [];
    const status = todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending";
    return [{ content, status, priority: "medium" as const }];
  });
}

/** Images in a tool result (screenshots, image files the agent read). */
function resultImages(content: unknown): ToolCallContent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => {
    const block = obj(raw);
    if (block?.type !== "image") return [];
    const source = obj(block.source);
    const image = inlineImage(str(source?.data), str(source?.media_type));
    return image ? [{ type: "content" as const, content: image }] : [];
  });
}

function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (obj(block)?.type === "text" ? str(obj(block)?.text) ?? "" : ""))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

/**
 * A slash command the user typed (`/review`, a skill, a plugin command): Claude
 * records it as tagged text. Returns it as the user wrote it.
 */
function slashCommand(text: string): string | undefined {
  const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

/**
 * Claude tells itself a background task (a sub-agent, a background shell)
 * finished by injecting `<task-notification>` as a user message. It's the
 * task's status, not something the user said.
 */
/**
 * A background task finished: its call gets its final status. For an agent
 * started in the background (one of `agents`) that is also the end of its
 * turn, and its report is what the call returned.
 */
function taskNotification(text: string, agents?: Set<string>): SessionUpdate[] | undefined {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined;
  const toolCallId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1];
  if (!toolCallId) return undefined;
  const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1];
  const done = status === "completed";
  if (!agents?.delete(toolCallId)) return [{ sessionUpdate: "tool_call_update", toolCallId, status: done ? "completed" : "failed" }];
  const report = /<result>([\s\S]*?)<\/result>/.exec(text)?.[1]?.trim();
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: done ? "completed" : "failed",
      content: report ? [{ type: "content", content: { type: "text", text: report } }] : undefined,
    },
    { sessionUpdate: "ls_turn", state: "ended", parentToolCallId: toolCallId, stopReason: done ? "end_turn" : status === "killed" || status === "stopped" ? "cancelled" : "error" },
  ];
}

/** Slash-command plumbing and interruption markers that aren't real user messages. */
/**
 * After compacting, Claude writes messages it keeps a second time under the
 * ids they already had — the ones just before, and what earlier compactions
 * kept, from anywhere in the transcript. A reader keeps the ids of the lines it
 * has read (`seen`) so those don't count as said or done again.
 */
function repeated(seen: Set<string>, uuid: string | undefined): boolean {
  if (!uuid) return false;
  if (seen.has(uuid)) return true;
  seen.add(uuid);
  return false;
}

/** The context was compacted (`/compact`, or by itself when it ran out): a card saying so, with how much it freed. */
function compaction(line: Json): SessionUpdate[] {
  const uuid = str(line.uuid);
  if (line.subtype !== "compact_boundary" || !uuid || line.isSidechain === true) return [];
  const meta = obj(line.compactMetadata);
  return [
    {
      sessionUpdate: "tool_call",
      toolCallId: `compact:${uuid}`,
      title: "Context compacted",
      kind: "think",
      status: "completed",
      detail: { type: "compaction" },
      rawInput: meta ? { trigger: meta.trigger, preTokens: meta.preTokens, postTokens: meta.postTokens } : undefined,
    },
  ];
}

function isNoise(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<command-") ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("[Request interrupted by user")
  );
}

/**
 * A message the user typed while Claude was working. Claude folds it into the
 * running turn and records it as a `queued_command` attachment rather than a
 * user line; it's still something the user said.
 */
function queuedPrompt(line: Json, agents?: Set<string>): TranscriptLineResult {
  const attachment = obj(line.attachment);
  if (attachment?.type !== "queued_command" || line.isSidechain === true) return { updates: [] };
  const stamp = str(line.timestamp) ? Date.parse(str(line.timestamp)!) : Number.NaN;
  const ts = Number.isFinite(stamp) ? stamp : undefined;
  if (attachment.commandMode === "task-notification" && typeof attachment.prompt === "string") {
    // A background task reporting back; Claude answers it in a turn of its own.
    const notification = taskNotification(attachment.prompt, agents);
    return notification ? { updates: [...notification, { sessionUpdate: "ls_turn", state: "started" }], ts } : { updates: [] };
  }
  if (attachment.commandMode !== undefined && attachment.commandMode !== "prompt") return { updates: [] };
  if (obj(attachment.origin)?.kind !== undefined && obj(attachment.origin)?.kind !== "human") return { updates: [] };
  const messageId = str(attachment.source_uuid) ?? str(line.uuid);
  const prompt = attachment.prompt;
  const blocks: ContentBlock[] = [];
  if (typeof prompt === "string") {
    if (prompt.trim()) blocks.push({ type: "text", text: prompt });
  } else if (Array.isArray(prompt)) {
    for (const raw of prompt) {
      const block = obj(raw);
      if (block?.type === "text" && str(block.text)) blocks.push({ type: "text", text: str(block.text)! });
      if (block?.type === "image") {
        const source = obj(block.source);
        const image = inlineImage(str(source?.data), str(source?.media_type));
        if (image) blocks.push(image);
      }
    }
  }
  return { updates: blocks.map((content) => ({ sessionUpdate: "user_message_chunk" as const, messageId, content })), ts };
}

export interface TranscriptLineResult {
  updates: SessionUpdate[];
  /** When the line was written (ms). */
  ts?: number;
  /** A title set by /rename or generated by Claude. */
  title?: string;
}

/**
 * Converts one transcript line to wire updates. Sub-agent files pass
 * `sidechain`; a reader keeps one `hidden` set per transcript, so a tool that
 * only feeds another view (TodoWrite → the plan) doesn't also show as a call,
 * and one `agents` set: the calls that started an agent in the background and
 * haven't heard back from it.
 */
export function transcriptLine(
  raw: string,
  options: { sidechain?: boolean; hidden?: Set<string>; agents?: Set<string>; seen?: Set<string> } = {},
): TranscriptLineResult {
  let line: Json;
  try {
    line = JSON.parse(raw) as Json;
  } catch {
    return { updates: [] };
  }
  if (options.seen && repeated(options.seen, str(line.uuid))) return { updates: [] };
  switch (line.type) {
    case "custom-title":
      return { updates: [], title: str(line.customTitle) };
    case "ai-title":
      return { updates: [], title: str(line.aiTitle) };
    case "user":
    case "assistant":
      break;
    case "attachment": {
      const attachment = obj(line.attachment);
      // Claude persists the same Goal check that the runtime reports live.
      // Sub-agent goals belong to their own session, never to the parent's card.
      if (!line.isSidechain && attachment?.type === "goal_status" && typeof attachment.met === "boolean") {
        if (attachment.met && attachment.sentinel === true) return { updates: [{ sessionUpdate: "ls_goal", goal: null }] };
        const goal = sessionGoalSchema.safeParse({
          objective: attachment.condition,
          status: attachment.met ? "complete" : "active",
          iterations: attachment.iterations,
          lastReason: attachment.reason,
          tokensUsed: attachment.tokens,
          timeUsedSeconds: typeof attachment.durationMs === "number" ? attachment.durationMs / 1000 : undefined,
        });
        if (goal.success) return { updates: [{ sessionUpdate: "ls_goal", goal: goal.data }] };
      }
      return queuedPrompt(line, options.agents);
    }
    case "system":
      return { updates: compaction(line) };
    default:
      return { updates: [] };
  }
  // What Claude writes for itself after compacting (the summary it continues from) isn't something the user said.
  if ((line.isSidechain === true && !options.sidechain) || line.isMeta === true || line.isCompactSummary === true) return { updates: [] };
  const stamp = str(line.timestamp) ? Date.parse(str(line.timestamp)!) : Number.NaN;
  const ts = Number.isFinite(stamp) ? stamp : undefined;
  const message = obj(line.message);
  if (!message) return { updates: [] };
  const updates: SessionUpdate[] = [];

  if (line.type === "user") {
    const uuid = str(line.uuid);
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    let userText = false;
    for (const rawBlock of blocks) {
      const block = obj(rawBlock);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const notification = taskNotification(block.text, options.agents);
        if (notification) {
          updates.push(...notification);
          // Claude answers the notification in a turn of its own.
          userText = true;
          continue;
        }
        const command = slashCommand(block.text);
        if (command) {
          updates.push({ sessionUpdate: "user_message_chunk", messageId: uuid, content: { type: "text", text: command } });
          userText = true;
          continue;
        }
        if (block.text.trimStart().startsWith("[Request interrupted by user")) {
          // Esc at the desk (or a stop from a device): the turn is over.
          updates.push({ sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" });
          continue;
        }
        if (isNoise(block.text)) continue;
        updates.push({ sessionUpdate: "user_message_chunk", messageId: uuid, content: { type: "text", text: block.text } });
        userText = true;
      } else if (block.type === "image") {
        const source = obj(block.source);
        const content: ContentBlock = inlineImage(str(source?.data), str(source?.media_type)) ?? { type: "image", mimeType: str(source?.media_type) ?? "image/*" };
        updates.push({ sessionUpdate: "user_message_chunk", messageId: uuid, content });
        userText = true;
      } else if (block.type === "tool_result" && str(block.tool_use_id)) {
        if (options.hidden?.delete(str(block.tool_use_id)!)) continue;
        const launched = obj(line.toolUseResult ?? line.tool_use_result);
        const workflow = launched?.status === "async_launched" || launched?.status === "remote_launched";
        const teammate = launched?.status === "teammate_spawned" && (str(launched.agentId) ?? str(launched.agent_id));
        if (!block.is_error && !launched?.error && (teammate || (launched?.isAsync === true && str(launched.agentId)) || (workflow && str(launched?.taskId))) && !options.sidechain) {
          // An agent started in the background: the call returns at once (with
          // nothing to show) while the agent works on. Its end is a task notification.
          options.agents?.add(str(block.tool_use_id)!);
          updates.push({ sessionUpdate: "ls_turn", state: "started", parentToolCallId: str(block.tool_use_id)! });
          continue;
        }
        const text = resultText(block.content);
        const content: ToolCallContent[] = [...(text ? [{ type: "content" as const, content: { type: "text" as const, text } }] : []), ...resultImages(block.content)];
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: str(block.tool_use_id)!,
          status: block.is_error === true ? "failed" : "completed",
          content: content.length > 0 ? content : undefined,
        });
      }
    }
    // A real prompt starts a turn; tool results continue one.
    if (userText) updates.push({ sessionUpdate: "ls_turn", state: "started" });
    return { updates, ts };
  }

  const messageId = str(message.id) ?? str(line.uuid) ?? "";
  for (const rawBlock of Array.isArray(message.content) ? message.content : []) {
    const block = obj(rawBlock);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      updates.push({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: block.thinking } });
    } else if (block.type === "text" && typeof block.text === "string" && block.text) {
      updates.push({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: block.text } });
    } else if (block.type === "tool_use" && str(block.id) && str(block.name)) {
      const input = obj(block.input) ?? {};
      if (block.name === "TodoWrite") {
        const entries = todoPlan(input);
        if (entries) updates.push({ sessionUpdate: "plan", entries });
        // The plan card is the view; its result line is skipped by id. Without a
        // reader's set (a single line) the call still shows, and closes cleanly.
        if (entries && options.hidden) {
          options.hidden.add(str(block.id)!);
          continue;
        }
      }
      const { title, kind, detail } = describeClaudeTool(str(block.name)!, input);
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: str(block.id)!,
        title,
        kind,
        detail,
        status: "in_progress",
        rawInput: input,
        content: toolContent(str(block.name)!, input),
      });
    }
  }
  // Anything but a tool call (or a reply still being written) is the turn's last word.
  const stop = message.stop_reason;
  if (stop === "end_turn" || stop === "stop_sequence") updates.push({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
  else if (stop === "max_tokens" || stop === "refusal") updates.push({ sessionUpdate: "ls_turn", state: "ended", stopReason: stop });
  return { updates, ts };
}

/** Parses a whole transcript file. */
/** When each transcript update happened, for history import. */
export const transcriptTimes = new WeakMap<SessionUpdate, number>();

/**
 * Claude Code keeps each sub-agent's transcript next to the session:
 * `<session>/subagents/agent-<id>.jsonl`. The Agent/Task result links its id
 * to the spawning call; ordinary agents also carry that call in .meta.json.
 * Returns the sub-agents' work as
 * updates nested under those calls (their prompt is the call's own input).
 */
export function readSubagents(transcriptPath: string, index?: ClaudeChildIndex): SessionUpdate[] {
  const root = transcriptPath.replace(/\.jsonl$/, "");
  const dir = join(root, "subagents");
  if (!existsSync(dir)) return [];
  if (!index) {
    index = new ClaudeChildIndex();
    eachLine(transcriptPath, (raw) => index!.observe(raw));
  }
  const updates: SessionUpdate[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
    let parent = index.children.get(file.slice(6, -6))?.call;
    try {
      const metaPath = join(dir, file.replace(/\.jsonl$/, ".meta.json"));
      if (ownedFile(root, metaPath)) parent ??= str(obj(JSON.parse(readFileSync(metaPath, "utf8")))?.toolUseId);
    } catch {
      // A launch result can associate the child before its sidecar exists.
    }
    const transcript = join(dir, file);
    if (!parent || !ownedFile(root, transcript)) continue;
    const hidden = new Set<string>();
    const seen = new Set<string>();
    for (const raw of readFileSync(transcript, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      const result = transcriptLine(raw, { sidechain: true, hidden, seen });
      for (const update of result.updates) {
        const nested = nestUnder(update, parent);
        if (!nested) continue;
        if (result.ts !== undefined) transcriptTimes.set(nested, result.ts);
        updates.push(nested);
      }
    }
  }
  // Parallel sub-agents: one timeline, in time order (sort is stable within each).
  return updates.sort((a, b) => (transcriptTimes.get(a) ?? 0) - (transcriptTimes.get(b) ?? 0));
}

/** Interleaves sub-agent updates into the session's by time, keeping each list's order. */
export function mergeByTime(main: SessionUpdate[], nested: SessionUpdate[]): SessionUpdate[] {
  if (nested.length === 0) return main;
  const out: SessionUpdate[] = [];
  let j = 0;
  let lastMain = Number.NEGATIVE_INFINITY;
  for (const update of main) {
    const ts = transcriptTimes.get(update) ?? lastMain;
    while (j < nested.length && (transcriptTimes.get(nested[j]!) ?? Number.POSITIVE_INFINITY) < ts) out.push(nested[j++]!);
    out.push(update);
    lastMain = ts;
  }
  while (j < nested.length) out.push(nested[j++]!);
  return out;
}

/** What a session is set to, as its transcript shows: each reply records the model and effort it ran with, each prompt the permission mode. */
export interface ObservedSettings {
  model?: string;
  effort?: string;
  /** Claude's permission mode id ("default", "acceptEdits", "plan", "bypassPermissions", …). */
  mode?: string;
  fast?: boolean;
}

/** The settings one transcript line shows, if any (matched on the raw line: quotes inside message text are escaped there). */
export function settingsOf(raw: string): ObservedSettings | undefined {
  if (raw.includes('"isSidechain":true')) return undefined;
  if (raw.includes('"type":"assistant"')) {
    const model = /"model":"([^"]+)"/.exec(raw)?.[1];
    if (!model || model === "<synthetic>") return undefined;
    const speed = /"speed":"([a-z]+)"/.exec(raw)?.[1];
    return { model, effort: /"effort":"([a-z]+)"/.exec(raw)?.[1], fast: speed ? speed === "fast" : undefined };
  }
  if (raw.includes('"type":"user"')) {
    const mode = /"permissionMode":"([A-Za-z]+)"/.exec(raw)?.[1];
    return mode ? { mode } : undefined;
  }
  return undefined;
}

/** `next` laid over `current`, leaving out what `next` doesn't say; undefined when nothing changed. */
export function mergeSettings(current: ObservedSettings, next: ObservedSettings | undefined): ObservedSettings | undefined {
  if (!next) return undefined;
  let merged: ObservedSettings | undefined;
  for (const key of ["model", "effort", "mode", "fast"] as const) {
    if (next[key] !== undefined && next[key] !== current[key]) merged = { ...(merged ?? current), [key]: next[key] };
  }
  return merged;
}

export function readTranscript(path: string, options: { includeSubagents?: boolean; onLine?: (raw: string) => void } = {}): {
  updates: SessionUpdate[];
  title?: string;
  size: number;
  settings: ObservedSettings;
  agents: Set<string>;
  /** The ids of its lines, for whoever reads on from `size`. */
  seen: Set<string>;
} {
  let title: string | undefined;
  let settings: ObservedSettings = {};
  const updates: SessionUpdate[] = [];
  const hidden = new Set<string>();
  const agents = new Set<string>();
  const seen = new Set<string>();
  const children = new ClaudeChildIndex();
  const size = eachLine(path, (raw) => {
    if (!raw.trim()) return;
    options.onLine?.(raw);
    if (options.includeSubagents !== false) children.observe(raw);
    const result = transcriptLine(raw, { hidden, agents, seen });
    // The latest reply and prompt say what the session is using.
    settings = mergeSettings(settings, settingsOf(raw)) ?? settings;
    if (result.ts !== undefined) for (const update of result.updates) transcriptTimes.set(update, result.ts);
    updates.push(...result.updates);
    if (result.title) title = result.title;
  });
  return { updates: mergeByTime(updates, options.includeSubagents === false ? [] : readSubagents(path, children)), title, settings, size, agents, seen };
}

/**
 * Calls `onLine` for every complete line of a file, reading it a piece at a
 * time (a long session's transcript runs to hundreds of MB). Returns how many
 * bytes those lines take: where a tail picks up.
 */
function eachLine(path: string, onLine: (line: string) => void): number {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let consumed = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const text = carry + decoder.write(buffer.subarray(0, read));
      const end = text.lastIndexOf("\n");
      if (end < 0) {
        carry = text;
        continue;
      }
      carry = text.slice(end + 1);
      const lines = text.slice(0, end + 1);
      consumed += Buffer.byteLength(lines);
      for (const line of lines.split("\n")) onLine(line);
    }
  } finally {
    closeSync(fd);
  }
  return consumed;
}

/**
 * Where a fork "through the turn of `itemId`" ends: the uuid of the last
 * message of that turn. The item is a reply's message id or a prompt's uuid;
 * when it isn't in the transcript, `turn` (counted from 1) names the turn.
 */
export function turnEndUuid(path: string, itemId: string, turn: number): string | undefined {
  let current = 0;
  let picked: number | undefined;
  const lastOfTurn: (string | undefined)[] = [];
  eachLine(path, (raw) => {
    if (!raw.trim() || raw.includes('"isSidechain":true')) return;
    if (!/"type":"(user|assistant)"/.test(raw)) return;
    let line: { type?: string; uuid?: string; message?: { id?: string } };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      return;
    }
    if (line.type !== "user" && line.type !== "assistant") return;
    const starts = transcriptLine(raw).updates.some((update) => update.sessionUpdate === "ls_turn" && update.state === "started" && !update.parentToolCallId);
    if (starts) current += 1;
    if (line.uuid) lastOfTurn[current] = line.uuid;
    if (line.uuid === itemId || line.message?.id === itemId) picked = current;
  });
  return lastOfTurn[picked ?? turn];
}

/** The last `bytes` of a file, as text (the first line may be partial). */
export function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  return readRange(path, Math.max(0, size - bytes), size);
}

function readRange(path: string, start: number, end: number): string {
  if (end <= start) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Follows a transcript from a byte offset by polling (Claude only appends).
 * `locate` is retried until the file exists, for sessions with no messages yet.
 */
export class TranscriptTail {
  private offset: number;
  private carry = "";
  private timer?: ReturnType<typeof setInterval>;
  private paused = false;
  private path?: string;
  /** While catching up after a pause: lines not to emit. */
  private skip?: (line: string) => boolean;
  /** While paused: how far `writtenMeanwhile` has looked. */
  private looked = 0;

  constructor(
    private readonly options: {
      locate: () => string | undefined;
      offset: number;
      onLine: (line: string) => void;
      pollMs?: number;
    },
  ) {
    this.offset = options.offset;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.options.pollMs ?? 400);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stops emitting (the remote driver is writing); see `resumeSkipping` and `resumeAtEnd`. */
  pause(): void {
    this.poll();
    this.paused = true;
    this.looked = this.offset;
  }

  /** While paused: whether a line `match` recognises was written since the pause (or since the last look). */
  writtenMeanwhile(match: (line: string) => boolean): boolean {
    if (!this.paused) return false;
    const path = this.resolve();
    if (!path) return false;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return false;
    }
    if (size <= this.looked) return false;
    const chunk = readRange(path, this.looked, size);
    const end = chunk.lastIndexOf("\n");
    if (end < 0) return false;
    this.looked += Buffer.byteLength(chunk.slice(0, end + 1));
    return chunk.slice(0, end).split("\n").some(match);
  }

  /**
   * Resumes after `pause`: what was written meanwhile is emitted, except the
   * lines `skip` recognises (the remote driver's own, already shown live).
   */
  resumeSkipping(skip: (line: string) => boolean): void {
    if (!this.paused) return;
    this.paused = false;
    this.skip = skip;
    this.poll();
    // A line still being written when we looked gets the same check once it's whole.
    this.skip = this.carry ? skip : undefined;
  }

  resumeAtEnd(): void {
    const path = this.resolve();
    this.offset = path ? statSync(path).size : this.offset;
    this.carry = "";
    this.paused = false;
  }

  /** Reads whatever is new right now. */
  poll(): void {
    if (this.paused) return;
    const path = this.resolve();
    if (!path) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Rewritten (rare): start over.
      this.offset = 0;
      this.carry = "";
    }
    if (size === this.offset) return;
    const chunk = this.carry + readRange(path, this.offset, size);
    this.offset = size;
    const end = chunk.lastIndexOf("\n");
    if (end < 0) {
      this.carry = chunk;
      return;
    }
    this.carry = chunk.slice(end + 1);
    const skip = this.skip;
    this.skip = undefined;
    for (const line of chunk.slice(0, end).split("\n")) {
      if (line.trim() && !skip?.(line)) this.options.onLine(line);
    }
  }

  private resolve(): string | undefined {
    if (!this.path) this.path = this.options.locate();
    return this.path;
  }
}
