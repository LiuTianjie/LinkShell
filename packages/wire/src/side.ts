import { z } from "zod";

/**
 * A side conversation: questions about a session that are answered from what
 * it knows but don't enter it, the agent's own feature (Codex's `/side`,
 * Claude's and Grok's `/btw`). It lives on the computer only while it is
 * open; nothing of it is in the session's history.
 */

export const sideMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** What the agent did on the way to an answer (a file it read, a command it ran), one line each. */
  activity: z.array(z.string()).optional(),
  /** The answer didn't come: why. */
  error: z.string().optional(),
});
export type SideMessage = z.infer<typeof sideMessageSchema>;

export const sideChatSchema = z.object({
  sideId: z.string(),
  createdAt: z.number(),
  /** Answering the last question. */
  running: z.boolean(),
  /** Goes up with every change: a client keeps the copy with the highest. */
  revision: z.number().int().nonnegative(),
  messages: z.array(sideMessageSchema),
});
export type SideChat = z.infer<typeof sideChatSchema>;
