import { z } from "zod";

export const usageQuerySchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  agent: z.string().min(1).max(128).default("all"),
});
export const usageTotalsSchema = z.object({
  records: z.number(), sessions: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  cacheReadTokens: z.number(), cacheWriteTokens: z.number(), totalTokens: z.number(),
});
export const usageReportSchema = z.object({
  generatedAt: z.number(), days: z.number(), agent: z.string(), timezone: z.string(),
  totals: usageTotalsSchema,
  daily: z.array(usageTotalsSchema.extend({ date: z.string() })),
  models: z.array(usageTotalsSchema.extend({ agent: z.string(), model: z.string() })),
  agents: z.array(z.object({
    id: z.string(), label: z.string(), source: z.enum(["native", "acp"]),
    status: z.enum(["available", "no_data"]), records: z.number(), totalTokens: z.number(), note: z.string(),
  })).optional(),
  warnings: z.array(z.string()),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;
