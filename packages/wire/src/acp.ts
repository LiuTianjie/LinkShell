import { z } from "zod";

const env = z.record(z.string());
export const mcpServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).default([]), env: env.default({}) }),
  z.object({ type: z.literal("http"), name: z.string().min(1), url: z.string().url(), headers: env.default({}) }),
  z.object({ type: z.literal("sse"), name: z.string().min(1), url: z.string().url(), headers: env.default({}) }),
  z.object({ type: z.literal("acp"), name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).default([]), env: env.default({}) }),
]);
export type AcpMcpServer = z.infer<typeof mcpServerSchema>;

/** Session tool configuration is persisted on the host, outside the transcript. */
export const acpAgentSettingsSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  experimental: z.boolean().default(true),
  mcpServers: z.array(mcpServerSchema).max(32).default([]),
  additionalDirectories: z.array(z.string().min(1)).max(32).default([]),
});
export type AcpAgentSettings = z.infer<typeof acpAgentSettingsSchema>;

export const acpRemoteAgentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(80),
  transport: z.enum(["stdio", "http", "websocket"]),
  command: z.string().optional(), args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  /** Header name to environment-variable name. The UI does not store secrets. */
  headerEnv: env.default({}),
  settings: acpAgentSettingsSchema.default({}),
});
export type AcpRemoteAgent = z.infer<typeof acpRemoteAgentSchema>;

export const acpAuthMethodSchema = z.object({ id: z.string(), name: z.string(), description: z.string().optional(), type: z.enum(["agent", "terminal"]) });
export const acpFeaturesSchema = z.object({
  protocolVersion: z.number(),
  authMethods: z.array(acpAuthMethodSchema),
  logout: z.boolean(), providers: z.boolean(), nes: z.boolean(),
  additionalDirectories: z.boolean(), mcpHttp: z.boolean(), mcpSse: z.boolean(),
});
export type AcpFeatures = z.infer<typeof acpFeaturesSchema>;

export const acpProviderSchema = z.object({
  providerId: z.string(), supported: z.array(z.string()), required: z.boolean(),
  current: z.object({ apiType: z.string(), baseUrl: z.string() }).nullish(),
});
export type AcpProvider = z.infer<typeof acpProviderSchema>;

/** Editor payloads follow ACP's versioned schema; the host validates before forwarding. */
export const acpEditorOperationSchema = z.enum(["nes/start", "nes/suggest", "nes/close", "nes/accept", "nes/reject", "document/didOpen", "document/didChange", "document/didClose", "document/didSave", "document/didFocus"]);
