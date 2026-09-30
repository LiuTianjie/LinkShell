import { z } from "zod";

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
export const pendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(permissionOptionSchema).min(1),
});
export type PendingPermissionSummary = z.infer<typeof pendingPermissionSchema>;

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

export const projectSummarySchema = z.object({
  cwd: z.string(),
  name: z.string(),
  lastActiveAt: z.number(),
  sessionCount: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const machineInfoSchema = z.object({
  machineId: z.string().min(1),
  hostname: z.string(),
  platform: z.string(),
  hostVersion: z.string(),
  agents: z.array(agentInfoSchema),
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
