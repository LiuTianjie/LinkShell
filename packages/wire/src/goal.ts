import { z } from "zod";

/** Native agent state, not inferred from prose or a completed turn. */
export const sessionGoalSchema = z.object({
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  tokenBudget: z.number().nonnegative().nullable().optional(),
  tokensUsed: z.number().nonnegative().optional(),
  timeUsedSeconds: z.number().nonnegative().optional(),
  iterations: z.number().int().nonnegative().optional(),
  lastReason: z.string().nullable().optional(),
});
export type SessionGoal = z.infer<typeof sessionGoalSchema>;

export const goalChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({ action: z.literal("set"), objective: z.string().trim().min(1).max(4000), tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("clear") }),
]);
export type GoalChange = z.infer<typeof goalChangeSchema>;
