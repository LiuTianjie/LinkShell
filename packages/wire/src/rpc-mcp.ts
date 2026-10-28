import { z } from "zod";
import { mcpAppDisplayModeSchema } from "./updates.js";

// MCP Apps: an MCP tool can declare a page of its own (a `ui://` HTML
// resource) that the client shows in a sandboxed frame, and that page can call
// its server's tools back. Codex sessions only: Codex is the agent that tells
// the host which tools have pages and lets a client read and call them. Other
// agents' sessions are refused with `not_supported`; a Codex that isn't
// running with `agent_unavailable`. Hosts older than these methods answer
// "method not found".

/** A tool Codex offers as an app of the thread (what its "插件和 MCP" menu lists). */
export const mcpAppSchema = z.object({
  server: z.string(),
  tool: z.string(),
  /** The plugin's or connector's name where there is one, else the tool's. */
  title: z.string(),
  description: z.string().optional(),
  /** Always `ui://…`. */
  resourceUri: z.string(),
  /** Where Codex offers it (`openai/ui.entrypoints[].type`): always includes "thread". */
  entrypoints: z.array(z.string()),
  /** Who may call the tool (`ui.visibility`: "model", "app"); absent: both. */
  visibility: z.array(z.string()).optional(),
  displayMode: mcpAppDisplayModeSchema.optional(),
  /** The Codex connector (server `codex_apps`): `mcp.call` needs it there. */
  connector: z.string().optional(),
});
export type McpApp = z.infer<typeof mcpAppSchema>;

export const mcpMethods = {
  /** The apps the session's Codex can open in the thread. */
  "mcp.apps": {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ apps: z.array(mcpAppSchema) }),
  },
  /**
   * A page's HTML (its first content), as the MCP server gives it. Only `ui://`
   * URIs (`invalid_params` otherwise); one over 4 MB is refused (`too_large`).
   * `meta` is the content's `_meta`: CSP domains, display modes, border.
   */
  "mcp.resource": {
    params: z.object({
      sessionId: z.string().min(1),
      server: z.string().min(1),
      uri: z.string().min(1),
      /** The page's connector (`detail.app.connector`, `McpApp.connector`), for server `codex_apps`. */
      connector: z.string().optional(),
    }),
    result: z.object({
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(),
      meta: z.unknown().optional(),
    }),
  },
  /**
   * A page calls one of its server's tools, in the session's thread. Refused
   * (`forbidden`) for a server without a page, a tool the page may not call
   * (`ui.visibility` without "app", `openai/fileParams`), or, on `codex_apps`, a
   * tool of another connector than `connector` (required there:
   * `invalid_params` without it); `not_found` for a tool the server doesn't
   * have. Codex's own failure is `agent_error`; a tool that ran and failed is
   * `isError` in the result.
   */
  "mcp.call": {
    params: z.object({
      sessionId: z.string().min(1),
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.unknown()).optional(),
      connector: z.string().optional(),
    }),
    result: z.object({
      content: z.array(z.unknown()),
      structuredContent: z.unknown().optional(),
      isError: z.boolean().optional(),
      meta: z.unknown().optional(),
    }),
  },
} as const;
