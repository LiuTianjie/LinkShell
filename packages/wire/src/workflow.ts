import { z } from "zod";

export const workflowStateSchema = z.enum(["running", "paused", "completed", "failed", "stopped"]);
export type WorkflowState = z.infer<typeof workflowStateSchema>;

export const workflowAgentStateSchema = z.enum(["pending", "running", "paused", "completed", "failed", "stopped", "unknown"]);
export type WorkflowAgentState = z.infer<typeof workflowAgentStateSchema>;

export const workflowAgentSchema = z.object({
  id: z.string(),
  /** Present only after the host has imported this agent's transcript. */
  toolCallId: z.string().optional(),
  title: z.string(),
  state: workflowAgentStateSchema,
  phaseId: z.string().optional(),
  model: z.string().optional(),
  tokens: z.number().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  result: z.string().optional(),
});
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;

export const workflowPhaseSchema = z.object({ id: z.string(), title: z.string(), order: z.number() });
export type WorkflowPhase = z.infer<typeof workflowPhaseSchema>;

/** A complete run snapshot, independent of the loaded conversation window. */
export const workflowSchema = z.object({
  runId: z.string().optional(),
  name: z.string().optional(),
  state: workflowStateSchema.optional(),
  /** Observed counts: a dynamic script may start more agents later. */
  started: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative().optional(),
  tokens: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  phases: z.array(workflowPhaseSchema).optional(),
  agents: z.array(workflowAgentSchema).optional(),
});
export type Workflow = z.infer<typeof workflowSchema>;
