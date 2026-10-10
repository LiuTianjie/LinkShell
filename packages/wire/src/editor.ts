import { z } from "zod";

export const textPositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
export const textRangeSchema = z.object({ start: textPositionSchema, end: textPositionSchema });
export type TextPosition = z.infer<typeof textPositionSchema>;
const suggestion = { id: z.string(), uri: z.string() };
export const editSuggestionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), ...suggestion, edits: z.array(z.object({ range: textRangeSchema, newText: z.string() })), cursorPosition: textPositionSchema.nullish() }),
  z.object({ kind: z.literal("jump"), ...suggestion, position: textPositionSchema }),
  z.object({ kind: z.literal("rename"), ...suggestion, position: textPositionSchema, newName: z.string() }),
  z.object({ kind: z.literal("searchAndReplace"), ...suggestion, search: z.string(), replace: z.string(), isRegex: z.boolean().nullish() }),
]);
export type EditSuggestion = z.infer<typeof editSuggestionSchema>;
export const editorRequestSchema = z.object({
  agent: z.string(), operation: z.enum(["open", "suggest", "preview", "apply", "save", "reject", "close"]),
  editorId: z.string().optional(), cwd: z.string().optional(), path: z.string().optional(),
  text: z.string().max(262144).optional(), position: textPositionSchema.optional(),
  suggestionId: z.string().optional(), previewId: z.string().optional(),
});
export type EditorRequest = z.infer<typeof editorRequestSchema>;
export const editorResultSchema = z.object({
  editorId: z.string().optional(), path: z.string().optional(), text: z.string().optional(), version: z.number().optional(),
  suggestions: z.array(editSuggestionSchema).optional(),
  preview: z.object({ id: z.string(), path: z.string(), before: z.string(), after: z.string(), kind: z.enum(["edit", "jump", "searchAndReplace"]), position: textPositionSchema.optional() }).optional(),
  position: textPositionSchema.optional(),
});
export type EditorResult = z.infer<typeof editorResultSchema>;
