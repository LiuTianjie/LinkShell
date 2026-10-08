import { z } from "zod";
import { workflowAgentStateSchema, workflowSchema } from "./workflow.js";

/**
 * How far LinkShell can take a given agent. The UI renders capabilities from
 * this instead of guessing:
 * - multi_client: desktop TUI and remote devices are live clients of one agent
 *   server (Codex app-server, OpenCode server).
 * - handoff: the native TUI owns the session on the desktop; a remote device can
 *   take it over and the session continues headlessly under the same id.
 * - remote: structured control only; the desktop uses LinkShell's own UI.
 * - terminal: PTY only.
 */
export const agentTierSchema = z.enum(["multi_client", "handoff", "remote", "terminal"]);
export type AgentTier = z.infer<typeof agentTierSchema>;

export const agentCapabilitiesSchema = z.object({
  interrupt: z.boolean(),
  /** Inject a message into a running turn instead of queueing it. */
  steer: z.boolean(),
  permissions: z.boolean(),
  images: z.boolean(),
  /**
   * The agent forks sessions itself, keeping everything it knew. Every agent's
   * sessions can be forked: without this (or from a single reply, where the
   * agent only forks whole sessions) LinkShell makes the fork — the new session
   * shows the conversation and its agent is told it as text.
   */
  fork: z.boolean(),
  models: z.boolean(),
  modes: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/**
 * How the agent authenticates on this machine, as the agent itself reports it
 * (e.g. `claude auth status`, `codex login status`). LinkShell never handles
 * the credentials; it runs agents with the user's own environment and config.
 */
export const agentAuthSchema = z.object({
  state: z.enum(["ok", "missing", "unknown"]),
  /** e.g. "claude.ai", "api_key", "oauth_token", "chatgpt", "bedrock". */
  method: z.string().optional(),
  /** What the user should do when state is "missing". */
  hint: z.string().optional(),
});
export type AgentAuth = z.infer<typeof agentAuthSchema>;

export const agentInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tier: agentTierSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  /** Human-readable reason when the agent is installed but unusable. */
  problem: z.string().optional(),
  auth: agentAuthSchema.optional(),
  capabilities: agentCapabilitiesSchema,
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

/**
 * Who is driving a handoff session right now: the desktop's native UI, this
 * host on behalf of a device, or nobody (either side can continue).
 */
export const sessionDriverSchema = z.enum(["desktop", "remote", "none"]);
export type SessionDriver = z.infer<typeof sessionDriverSchema>;

export const sessionStateSchema = z.enum(["idle", "running", "waiting", "error", "offline"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const toolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const permissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

/** What a running session is doing right now, for list rows. Live only. */
export const sessionActivitySchema = z.object({
  kind: z.enum(["thinking", "responding", "tool"]),
  title: z.string().optional(),
  toolKind: toolKindSchema.optional(),
});
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

/** The oldest unanswered permission request, so lists can offer approval inline. Live only. */
/**
 * Something the agent asks the user rather than asks permission for: a choice
 * among options, several of them, or something to type (Claude's
 * AskUserQuestion, Codex's request_user_input, an MCP server's form).
 */
export const questionSchema = z.object({
  id: z.string(),
  /** A short label for the question ("Auth method"). */
  header: z.string().optional(),
  text: z.string(),
  /** `choice`: one of `options`; `choices`: any number of them; `text`: typed. */
  kind: z.enum(["choice", "choices", "text"]),
  options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  /** With options: an answer of the user's own can be typed instead of, or beside, a pick. */
  other: z.boolean().optional(),
  /** What is typed shouldn't be shown (a token). */
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionAnswerSchema = z.object({
  id: z.string(),
  /** The values picked (`choice`: at most one), or what was typed for a `text` question. */
  values: z.array(z.string().max(20_000)).max(50),
  /** The user's own answer beside the options. */
  other: z.string().max(20_000).optional(),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export const pendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(permissionOptionSchema).min(1),
  /** Set when this is a question to answer (`sessions.answer`) rather than a permission to give. */
  questions: z.array(questionSchema).optional(),
});
export type PendingPermissionSummary = z.infer<typeof pendingPermissionSchema>;

export const queuedMessageSchema = z.object({
  clientMessageId: z.string(),
  /** The message's text (images are counted, not sent). */
  text: z.string(),
  images: z.number().int().nonnegative(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** A sub-agent a session started: the tool call it runs under, and how it is doing. */
export const subagentInfoSchema = z.object({
  toolCallId: z.string(),
  parentToolCallId: z.string().optional(),
  /** What it was asked to do. */
  task: z.string(),
  /** Its role or type, e.g. "Explore". */
  agentType: z.string().optional(),
  running: z.boolean(),
  failed: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  state: workflowAgentStateSchema.optional(),
  workflow: workflowSchema.optional(),
  /** Orders list snapshots against events arriving while the request is in flight. */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type SubagentInfo = z.infer<typeof subagentInfoSchema>;

/**
 * A command the agent left running after its call returned (a background
 * shell, a dev server, a watcher). Sub-agents and workflows are not tasks:
 * they have their own records (`SubagentInfo`).
 */
export const backgroundTaskStateSchema = z.enum(["running", "completed", "failed", "stopped", "unknown"]);
export type BackgroundTaskState = z.infer<typeof backgroundTaskStateSchema>;

export const backgroundTaskSchema = z.object({
  /** The agent's own id for it. */
  id: z.string(),
  /** shell: a command; monitor: a command whose output the agent is told about as it comes. */
  kind: z.enum(["shell", "monitor"]),
  /** The tool call that started it. */
  toolCallId: z.string().optional(),
  title: z.string(),
  command: z.string().optional(),
  /** `unknown`: it was running when the host lost track of it (its agent quit without saying how it ended). */
  state: backgroundTaskStateSchema,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** How it ended, or the latest thing it reported, as the agent says it. */
  summary: z.string().optional(),
  exitCode: z.number().int().optional(),
  /** Its output can be read (`sessions.taskOutput`). */
  output: z.boolean().optional(),
  /** It can be stopped from here (`sessions.stopTask`). */
  canStop: z.boolean().optional(),
  /** Orders list snapshots against events arriving while the request is in flight. */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

export const sessionSummarySchema = z.object({
  /** `${agent}:${nativeId}` — stable across daemon restarts and rediscovery. */
  id: z.string().min(1),
  agent: z.string().min(1),
  nativeId: z.string().min(1),
  title: z.string().optional(),
  preview: z.string().optional(),
  cwd: z.string(),
  state: sessionStateSchema,
  driver: sessionDriverSchema.optional(),
  pendingPermissions: z.number().int().nonnegative(),
  model: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastSeq: z.number().int().nonnegative(),
  archived: z.boolean(),
  activity: sessionActivitySchema.optional(),
  permission: pendingPermissionSchema.optional(),
  /**
   * Live only: messages waiting for the current turn to end, when the host
   * holds them (agents that can't take input mid-turn). Oldest first.
   */
  queue: z.array(queuedMessageSchema).optional(),
  /**
   * The session works in a git worktree LinkShell made for it: its own
   * checkout and branch, so it can't disturb the project's working directory.
   * `cwd` is inside the worktree; `source` is the directory it was made from
   * (the project the session belongs to).
   */
  worktree: z.object({ branch: z.string(), source: z.string() }).optional(),
  /** Live only, for sessions that started sub-agents: how many, and how many are working now (`sessions.subagents` lists them). */
  subagents: z.object({ total: z.number().int(), running: z.number().int() }).optional(),
  /** Live only, for sessions that left commands running: how many, and how many still run (`sessions.tasks` lists them). */
  tasks: z.object({ total: z.number().int(), running: z.number().int() }).optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export function sessionIdFor(agent: string, nativeId: string): string {
  return `${agent}:${nativeId}`;
}

export function parseSessionId(id: string): { agent: string; nativeId: string } | null {
  const index = id.indexOf(":");
  if (index <= 0 || index === id.length - 1) return null;
  return { agent: id.slice(0, index), nativeId: id.slice(index + 1) };
}

/** What git says about a directory, to offer starting a session in a worktree of it. */
export const gitInfoSchema = z.object({
  /** The repository's top directory. */
  root: z.string(),
  /** The branch checked out; absent on a detached HEAD. */
  branch: z.string().optional(),
  /** The commit checked out, abbreviated; absent before the first commit. */
  head: z.string().optional(),
  /** Uncommitted changes in the working directory (a new worktree starts from the last commit, without them). */
  dirty: z.boolean(),
});
export type GitInfo = z.infer<typeof gitInfoSchema>;

/** A worktree LinkShell made for sessions. */
export const worktreeEntrySchema = z.object({
  /** The worktree's top directory. */
  path: z.string(),
  branch: z.string(),
  /** The repository it belongs to. */
  source: z.string(),
  createdAt: z.number(),
  /** Sessions working in it. */
  sessions: z.array(z.string()),
  /** Uncommitted changes in it. */
  dirty: z.boolean(),
  /** Commits made in it since it was created. */
  ahead: z.number().int().nonnegative(),
});
export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;

export const projectSummarySchema = z.object({
  cwd: z.string(),
  name: z.string(),
  lastActiveAt: z.number(),
  sessionCount: z.number().int().nonnegative(),
  /** For a git repository: the branch checked out there now (or the abbreviated commit, on a detached HEAD). */
  branch: z.string().optional(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const machineInfoSchema = z.object({
  machineId: z.string().min(1),
  hostname: z.string(),
  platform: z.string(),
  hostVersion: z.string(),
  /** The host user's home directory, so apps can show paths as `~/…`. */
  home: z.string().optional(),
  agents: z.array(agentInfoSchema),
  /**
   * The host can send bulk streams peer to peer (`direct.offer`); `iceServers`
   * are the STUN servers both sides use to find a path.
   */
  direct: z.object({ iceServers: z.array(z.string()) }).optional(),
});
export type MachineInfo = z.infer<typeof machineInfoSchema>;

/** A server listening on the host, which a device can preview through the encrypted channel. */
export const portInfoSchema = z.object({
  port: z.number().int().min(1).max(65535),
  /** The listening process ("node", "python3.12"). */
  process: z.string(),
  pid: z.number().int().optional(),
  /** The process's working directory: which project the server belongs to. */
  cwd: z.string().optional(),
  /** The page title, when the port answers HTTP with an HTML page. */
  title: z.string().optional(),
  /** Answers HTTP at all (a dev server, not a database). */
  http: z.boolean(),
});
export type PortInfo = z.infer<typeof portInfoSchema>;

/** A shell the host keeps open, independent of any device connection. */
export const terminalInfoSchema = z.object({
  id: z.string(),
  /** What's running in the foreground (the shell or its current command). */
  title: z.string(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.number(),
  /** Last output time. */
  activeAt: z.number(),
  /** The command it was started to run, if any (else it's a plain shell). */
  command: z.string().optional(),
  /** Set once the shell ended; the terminal and its output stay until deleted. */
  exitCode: z.number().int().nullable().optional(),
  /** Ended without an exit code: the host stopped while it ran. */
  interrupted: z.boolean().optional(),
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

/** The host's link to a v2 gateway, for `linkshell status` and the app's computer page. */
export const gatewayStatusSchema = z.object({
  url: z.string().optional(),
  status: z.enum(["off", "connecting", "online", "offline"]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  machine: z.object({ id: z.string(), name: z.string() }).optional(),
  account: z.object({ userId: z.string(), email: z.string().optional() }).optional(),
  devices: z.array(z.object({ id: z.string(), name: z.string(), pairedAt: z.number(), online: z.boolean() })),
});
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;
