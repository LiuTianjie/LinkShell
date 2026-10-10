import { z } from "zod";

const optionalString = z.string().nullish().transform((value) => value ?? undefined);
const optionalMeta = z.record(z.unknown()).nullish().transform((value) => value ?? undefined);
const contentMetadata = {
  annotations: z.object({ audience: z.array(z.enum(["user", "assistant"])).nullish().transform((value) => value ?? undefined), priority: z.number().nullish().transform((value) => value ?? undefined), lastModified: optionalString }).passthrough().nullish().transform((value) => value ?? undefined),
  _meta: optionalMeta,
};
const contentVariants = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), ...contentMetadata }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: optionalString,
    uri: optionalString,
    ...contentMetadata,
  }),
  z.object({ type: z.literal("audio"), mimeType: z.string(), data: optionalString, uri: optionalString, ...contentMetadata }),
  z.object({
    type: z.literal("resource"),
    resource: z.object({ uri: z.string(), mimeType: optionalString, text: optionalString, blob: optionalString, assetUri: optionalString, _meta: optionalMeta }),
    ...contentMetadata,
  }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    title: optionalString,
    description: optionalString,
    mimeType: optionalString,
    size: z.number().nullish().transform((value) => value ?? undefined),
    ...contentMetadata,
    /** What the link names: a file (default), a skill the user invoked, or another agent. */
    kind: z.enum(["file", "skill", "agent"]).optional(),
  }),
]);
export type ContentBlock = z.infer<typeof contentVariants>;
// Hide the nested validator implementation from every exported RPC declaration.
export const contentBlockSchema: z.ZodType<ContentBlock, z.ZodTypeDef, unknown> = contentVariants;

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
