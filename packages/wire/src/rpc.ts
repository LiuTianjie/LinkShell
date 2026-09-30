import { z } from "zod";
import {
  gatewayStatusSchema,
  machineInfoSchema,
  portInfoSchema,
  projectSummarySchema,
  terminalInfoSchema,
  sessionDriverSchema,
  sessionSummarySchema,
} from "./model.js";
import { contentBlockSchema, sessionEventSchema } from "./updates.js";

// ── JSON-RPC 2.0 framing ─────────────────────────────────────────────

export const rpcIdSchema = z.union([z.string(), z.number()]);
export type RpcId = z.infer<typeof rpcIdSchema>;

export const rpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcErrorObject = z.infer<typeof rpcErrorSchema>;

export const rpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});
export type RpcMessage = z.infer<typeof rpcMessageSchema>;

/** Application error codes carried in `error.data.code`. */
export const appErrorCodeSchema = z.enum([
  "invalid_params",
  "not_found",
  "agent_unavailable",
  "not_supported",
  /** The session exists but can't be joined yet (e.g. a new Codex thread before its first turn). */
  "not_ready",
  "busy",
  /** Client side: the link to the computer is down. */
  "offline",
  "internal",
]);
export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;

export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_APP_ERROR = -32000;

// ── Methods (client → host) ──────────────────────────────────────────

const empty = z.object({}).passthrough();

export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Looks like a code project (has .git, package.json, …). */
  project: z.boolean().optional(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const methods = {
  "machine.info": {
    params: empty,
    result: machineInfoSchema,
  },
  "projects.list": {
    params: z.object({ limit: z.number().int().positive().max(200).optional() }),
    result: z.object({ projects: z.array(projectSummarySchema) }),
  },
  "sessions.list": {
    params: z.object({
      limit: z.number().int().positive().max(200).optional(),
      /** Only sessions updated strictly before this timestamp (pagination). */
      before: z.number().optional(),
      includeArchived: z.boolean().optional(),
    }),
    result: z.object({
      sessions: z.array(sessionSummarySchema),
      nextBefore: z.number().optional(),
    }),
  },
  "sessions.create": {
    params: z.object({
      agent: z.string().min(1),
      cwd: z.string().min(1),
      prompt: z.array(contentBlockSchema).optional(),
      clientMessageId: z.string().optional(),
      model: z.string().optional(),
    }),
    result: z.object({ session: sessionSummarySchema }),
  },
  "sessions.subscribe": {
    params: z.object({
      sessionId: z.string().min(1),
      /** Last seq the client already has; 0 for a fresh subscription. */
      fromSeq: z.number().int().nonnegative(),
    }),
    result: z.object({ session: sessionSummarySchema }),
  },
  "sessions.unsubscribe": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: empty,
  },
  "sessions.prompt": {
    params: z.object({
      sessionId: z.string().min(1),
      /** Client-generated idempotency key; a retried send is not delivered twice. */
      clientMessageId: z.string().min(1),
      content: z.array(contentBlockSchema).min(1),
    }),
    /** queued: the agent can't take input mid-turn; it is sent when the turn ends. */
    result: z.object({ delivery: z.enum(["started", "steered", "queued", "duplicate"]) }),
  },
  "sessions.cancel": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: empty,
  },
  "sessions.permission": {
    params: z.object({
      sessionId: z.string().min(1),
      requestId: z.string().min(1),
      optionId: z.string().min(1),
    }),
    result: empty,
  },
  "sessions.setConfig": {
    params: z.object({
      sessionId: z.string().min(1),
      optionId: z.string().min(1),
      value: z.string().min(1),
    }),
    result: empty,
  },
  /** Drops a message still waiting in the host's queue (see SessionSummary.queue). */
  "sessions.unqueue": {
    params: z.object({ sessionId: z.string().min(1), clientMessageId: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
  /** Archives (or restores) a session: hidden from lists, kept on disk; natively where the agent supports it. */
  "sessions.archive": {
    params: z.object({ sessionId: z.string().min(1), archived: z.boolean() }),
    result: z.object({ session: sessionSummarySchema }),
  },
  /** Names a session; an empty title goes back to the agent's own. */
  "sessions.rename": {
    params: z.object({ sessionId: z.string().min(1), title: z.string().max(200) }),
    result: z.object({ session: sessionSummarySchema }),
  },
  /**
   * Deletes a session: the agent's own record where it has one (Codex thread,
   * Claude transcript), and LinkShell's copy either way. Not while it runs.
   */
  "sessions.delete": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: empty,
  },
  "sessions.takeover": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ driver: sessionDriverSchema.optional() }),
  },
  "sessions.release": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ driver: sessionDriverSchema.optional() }),
  },
  /**
   * How a desktop terminal should launch the agent's native UI attached to the
   * host (used by `linkshell <agent>`). The shim execs exactly what it gets.
   * For handoff agents the calling connection becomes the session's desktop
   * controller: it receives `desktop.yield` when a device takes over.
   */
  "desktop.launch": {
    params: z.object({
      agent: z.string().min(1),
      sessionId: z.string().optional(),
      args: z.array(z.string()).default([]),
      /** The terminal's working directory and environment. */
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
    }),
    result: z.object({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string()).optional(),
      /** Set for handoff agents: the session this terminal now drives. */
      sessionId: z.string().optional(),
    }),
  },
  /** The shim's native UI exited after a `desktop.yield`; the device may drive now. */
  "desktop.yielded": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: empty,
  },
  /** The user is back at the keyboard: stop remote driving, relaunch the native UI. */
  "desktop.reclaim": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string()).optional(),
    }),
  },
  // ── Gateway: reach this computer from anywhere ──
  "gateway.status": { params: empty, result: gatewayStatusSchema },
  /**
   * Opens a pairing window (local only). `link` is what the QR encodes; the
   * code can be typed instead. `pairing.done` follows when a device pairs.
   */
  "pairing.start": {
    params: empty,
    result: z.object({ link: z.string(), code: z.string(), expiresAt: z.number(), gateway: z.string() }),
  },
  "devices.revoke": { params: z.object({ deviceId: z.string().min(1) }), result: empty },
  // ── Directories: pick where a new session runs ──
  /** Subdirectories of `path` (default: the home directory). */
  "fs.list": {
    params: z.object({ path: z.string().optional(), hidden: z.boolean().default(false) }),
    result: z.object({
      path: z.string(),
      parent: z.string().optional(),
      home: z.string(),
      entries: z.array(directoryEntrySchema),
    }),
  },
  /** A file's contents, for viewing: text as-is, images as base64, anything else refused. */
  "fs.read": {
    params: z.object({ path: z.string().min(1), maxBytes: z.number().int().min(1).max(8_000_000).default(2_000_000) }),
    result: z.object({
      path: z.string(),
      size: z.number().int(),
      modifiedAt: z.number(),
      kind: z.enum(["text", "image", "binary"]),
      text: z.string().optional(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
      truncated: z.boolean(),
    }),
  },
  /**
   * Saves a file from the device into `dir`. A name that's taken gets a
   * numbered suffix ("photo 2.jpg") rather than overwriting.
   */
  "fs.upload": {
    params: z.object({
      dir: z.string().min(1),
      name: z.string().min(1).max(255),
      /** base64; up to ~30 MB of file. */
      data: z.string().max(40_000_000),
    }),
    result: z.object({ path: z.string(), size: z.number().int() }),
  },
  /** Creates a directory `name` inside `parent`. */
  "fs.mkdir": {
    params: z.object({ parent: z.string().min(1), name: z.string().min(1).max(255) }),
    result: z.object({ path: z.string() }),
  },
  /** Directories under the home directory whose name contains `query`, projects first. */
  "fs.search": {
    params: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).default(60) }),
    result: z.object({ entries: z.array(directoryEntrySchema), truncated: z.boolean() }),
  },
  // ── Terminals: plain shells on the host, any command, like SSH ──
  "terminals.list": {
    params: empty,
    result: z.object({ terminals: z.array(terminalInfoSchema) }),
  },
  "terminals.create": {
    params: z.object({
      cwd: z.string().optional(),
      /** Run this in the shell right away (the shell stays open after it). */
      command: z.string().max(4000).optional(),
      cols: z.number().int().min(10).max(1000).default(80),
      rows: z.number().int().min(4).max(500).default(24),
    }),
    result: z.object({ terminal: terminalInfoSchema }),
  },
  /**
   * Start receiving `terminal.output` for a terminal. With `fromSeq` the host
   * sends only newer output when it still has it; otherwise `replay` holds the
   * recent screen history to redraw from scratch.
   */
  "terminals.attach": {
    params: z.object({ terminalId: z.string().min(1), fromSeq: z.number().int().min(0).optional() }),
    result: z.object({
      terminal: terminalInfoSchema,
      /** Output to write before any `terminal.output` that follows. */
      replay: z.string(),
      /** Clear the screen before writing `replay` (the host no longer has what came after `fromSeq`). */
      reset: z.boolean(),
      /** The last output seq `replay` covers; later chunks arrive as `terminal.output`. */
      seq: z.number().int(),
    }),
  },
  "terminals.detach": {
    params: z.object({ terminalId: z.string().min(1) }),
    result: empty,
  },
  "terminals.input": {
    params: z.object({ terminalId: z.string().min(1), data: z.string().max(1_000_000) }),
    result: empty,
  },
  "terminals.resize": {
    params: z.object({
      terminalId: z.string().min(1),
      cols: z.number().int().min(10).max(1000),
      rows: z.number().int().min(4).max(500),
    }),
    result: empty,
  },
  "terminals.close": {
    params: z.object({ terminalId: z.string().min(1) }),
    result: empty,
  },
  // ── Previews: the host's local servers, reached through this channel ──
  /** Servers listening on the host that look like something to preview. */
  "ports.list": {
    params: empty,
    result: z.object({ ports: z.array(portInfoSchema) }),
  },
  /**
   * A TCP stream to `port` on the host's loopback, like `ssh -L`: the device
   * runs a local listener and carries each connection over this channel, so a
   * page, its WebSocket (hot reload) and its cookies all work unchanged. The
   * host's bytes arrive as `proxy.data`; the stream ends with `proxy.closed`.
   */
  "proxy.open": {
    params: z.object({ port: z.number().int().min(1).max(65535) }),
    result: z.object({ streamId: z.string() }),
  },
  /**
   * Starts the host's screen viewer: a page plus H.264 stream on a loopback
   * port, opened like a preview (`proxy.open`) at `/?token=…&display=…`.
   */
  "screen.start": {
    params: empty,
    result: z.object({
      port: z.number().int(),
      token: z.string(),
      displays: z.array(z.object({ index: z.number().int(), name: z.string() })),
    }),
  },
  /** Bytes to the host's end of a stream (base64). */
  "proxy.write": {
    params: z.object({ streamId: z.string().min(1), data: z.string().max(2_000_000) }),
    result: empty,
  },
  "proxy.close": {
    params: z.object({ streamId: z.string().min(1) }),
    result: empty,
  },
} as const;

export type MethodName = keyof typeof methods;
export type MethodParams<M extends MethodName> = z.input<(typeof methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof methods)[M]["result"]>;

export function isMethodName(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(methods, name);
}

// ── Notifications (host → client) ────────────────────────────────────

export const notifications = {
  "session.event": sessionEventSchema,
  "session.summary": z.object({ session: sessionSummarySchema }),
  /** A session was deleted (from any device, or natively by the agent). */
  "session.removed": z.object({ sessionId: z.string() }),
  /** To a desktop shim: a device is taking over; exit the native UI, then call desktop.yielded. */
  "desktop.yield": z.object({ sessionId: z.string() }),
  /** To a desktop shim: progress from the remote driver, to show in the terminal. */
  "desktop.remoteActivity": z.object({ sessionId: z.string(), line: z.string() }),
  "pairing.done": z.object({ device: z.object({ id: z.string(), name: z.string() }) }),
  "gateway.changed": gatewayStatusSchema,
  /** Output from an attached terminal, in order; `seq` increases by one per chunk. */
  "terminal.output": z.object({ terminalId: z.string(), seq: z.number().int(), data: z.string() }),
  /** A terminal's list entry changed (title, size, exit), or it was closed (`closed`). */
  "terminal.changed": z.object({ terminal: terminalInfoSchema, closed: z.boolean().optional() }),
  /** Bytes from the host's end of a `proxy.open` stream (base64), in order. */
  "proxy.data": z.object({ streamId: z.string(), data: z.string() }),
  /** The host's end of a stream closed (the server hung up, or refused). */
  "proxy.closed": z.object({ streamId: z.string(), error: z.string().optional() }),
} as const;

export type NotificationName = keyof typeof notifications;
export type NotificationParams<N extends NotificationName> = z.infer<(typeof notifications)[N]>;
