import { z } from "zod";

/**
 * LinkShell Agent (LSA) Phase 1 RPC contracts: deterministic task ledger,
 * automated post-turn acceptance verification, memories, and due followups.
 */

export const lsaTaskStatusSchema = z.enum([
  "queued",
  "running",
  "verifying",
  "waiting_decision",
  "completed",
  "failed",
  "cancelled",
]);
export type LsaTaskStatus = z.infer<typeof lsaTaskStatusSchema>;

export const lsaDecisionSchema = z.enum(["accept", "retry", "cancel"]);
export type LsaDecision = z.infer<typeof lsaDecisionSchema>;

export const lsaTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  goal: z.string().min(1),
  status: lsaTaskStatusSchema,
  cwd: z.string(),
  worktree: z.boolean().optional(),
  agent: z.string().optional(),
  sessionId: z.string().optional(),
  controllerEpoch: z.number().int().nonnegative().optional(),
  acceptanceChecks: z.array(z.string()),
  summary: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type LsaTask = z.infer<typeof lsaTaskSchema>;

export const lsaMemorySchema = z.object({
  id: z.string().optional(),
  scope: z.string().optional(),
  key: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.number(),
});
export type LsaMemory = z.infer<typeof lsaMemorySchema>;

export const lsaFollowupSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().optional(),
  dueAt: z.number(),
  note: z.string(),
  done: z.boolean(),
  triggeredAt: z.number().optional(),
});
export type LsaFollowup = z.infer<typeof lsaFollowupSchema>;

export const lsaCandidateProjectSchema = z.object({
  cwd: z.string(),
  name: z.string(),
  score: z.number(),
  remote: z.string().optional(),
  reason: z.string().optional(),
});
export type LsaCandidateProject = z.infer<typeof lsaCandidateProjectSchema>;

export const lsaStatusSchema = z.object({
  enabled: z.boolean(),
  controllerEpoch: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  activeTasks: z.number().int().nonnegative(),
  waitingDecisionTasks: z.number().int().nonnegative(),
  dueFollowups: z.number().int().nonnegative(),
  requiresYearlyTier: z.boolean(),
  handoffSummary: z.string().optional(),
  candidates: z.array(lsaCandidateProjectSchema).optional(),
});
export type LsaStatus = z.infer<typeof lsaStatusSchema>;

export const lsaMethods = {
  "lsa.status": {
    params: z.object({
      query: z.string().max(200).optional(),
    }),
    result: lsaStatusSchema,
  },
  "lsa.tasks": {
    params: z.object({
      taskId: z.string().optional(),
      status: lsaTaskStatusSchema.optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.object({
      tasks: z.array(lsaTaskSchema),
    }),
  },
  "lsa.dispatch": {
    params: z.object({
      goal: z.string().min(1).max(20_000),
      title: z.string().max(200).optional(),
      cwd: z.string().optional(),
      agent: z.string().optional(),
      worktree: z.boolean().optional(),
      acceptanceChecks: z.array(z.string().max(2000)).max(50).optional(),
    }),
    result: z.object({
      task: lsaTaskSchema,
    }),
  },
  "lsa.steer": {
    params: z.object({
      taskId: z.string().min(1),
      instruction: z.string().min(1).max(20_000),
      controllerEpoch: z.number().int().nonnegative().optional(),
    }),
    result: z.object({
      task: lsaTaskSchema,
    }),
  },
  "lsa.decide": {
    params: z.object({
      taskId: z.string().min(1),
      decision: lsaDecisionSchema,
      feedback: z.string().max(20_000).optional(),
      controllerEpoch: z.number().int().nonnegative().optional(),
    }),
    result: z.object({
      task: lsaTaskSchema,
    }),
  },
  "lsa.memories": {
    params: z.object({
      op: z.enum(["list", "search", "save", "delete"]).optional(),
      query: z.string().max(500).optional(),
      scope: z.string().max(120).optional(),
      key: z.string().max(200).optional(),
      content: z.string().max(20_000).optional(),
      tags: z.array(z.string().max(80)).max(32).optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.object({
      memories: z.array(lsaMemorySchema),
    }),
  },
  "lsa.followups": {
    params: z.object({
      op: z.enum(["list", "schedule", "complete", "delete"]).optional(),
      id: z.string().optional(),
      taskId: z.string().optional(),
      dueAt: z.number().optional(),
      note: z.string().max(2000).optional(),
      includeDone: z.boolean().optional(),
    }),
    result: z.object({
      followups: z.array(lsaFollowupSchema),
    }),
  },
} as const;
