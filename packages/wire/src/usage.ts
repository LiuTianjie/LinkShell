import { z } from "zod";

export const usageQuerySchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  agent: z.string().min(1).max(128).default("all"),
});

export const usageTotalsSchema = z.object({
  records: z.number(),
  sessions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalTokens: z.number(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

export const usageRemoteStatsSchema = z.object({
  remoteTurns: z.number().int().nonnegative(),
  remoteApprovals: z.number().int().nonnegative(),
});

export const usageReportSchema = z.object({
  generatedAt: z.number(),
  days: z.number(),
  agent: z.string(),
  timezone: z.string(),
  totals: usageTotalsSchema,
  daily: z.array(usageTotalsSchema.extend({ date: z.string() })),
  models: z.array(usageTotalsSchema.extend({ agent: z.string(), model: z.string() })),
  agents: z.array(z.object({
    id: z.string(),
    label: z.string(),
    source: z.enum(["native", "acp"]),
    status: z.enum(["available", "no_data"]),
    records: z.number(),
    totalTokens: z.number(),
    note: z.string(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  })).optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  remoteStats: usageRemoteStatsSchema.optional(),
  warnings: z.array(z.string()),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageRemoteStats = z.infer<typeof usageRemoteStatsSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;

export interface ModelPricingPerMillion {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenCostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Reference public API pricing (USD per 1M tokens), ordered most-specific first.
 * Subscription users (ChatGPT Plus/Pro, Claude Pro/Max) pay flat fees; this
 * estimates the equivalent API value of work orchestrated through LinkShell.
 */
const MODEL_PRICING_RULES: ReadonlyArray<{ match: RegExp; pricing: ModelPricingPerMillion }> = [
  // Anthropic Claude
  { match: /claude[-_.]?opus[-_.]?(?:4[._][56]|5)/i, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: /opus/i, pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet/i, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /claude[-_.]?haiku[-_.]?4[._]5/i, pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /haiku/i, pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  // OpenAI / Codex
  { match: /(?:gpt-5|o1|o3)[-_]pro/i, pricing: { input: 15, output: 60, cacheRead: 3.75, cacheWrite: 15 } },
  { match: /gpt-5[-_.]?mini/i, pricing: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 } },
  { match: /gpt-5[-_.]?nano/i, pricing: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 } },
  { match: /codex[-_.]?mini/i, pricing: { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite: 1.5 } },
  { match: /gpt-5|codex/i, pricing: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 } },
  { match: /gpt-4\.1[-_.]?mini/i, pricing: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 } },
  { match: /gpt-4\.1[-_.]?nano/i, pricing: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 } },
  { match: /gpt-4\.1/i, pricing: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
  { match: /gpt-4o[-_.]?mini/i, pricing: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 } },
  { match: /gpt-4o/i, pricing: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 } },
  { match: /o[34][-_.]?mini/i, pricing: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 } },
  { match: /\bo3\b|\bo1\b/i, pricing: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
  // Google Gemini
  { match: /gemini.*flash/i, pricing: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 } },
  { match: /gemini/i, pricing: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 } },
  // xAI Grok & DeepSeek
  { match: /grok/i, pricing: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 3 } },
  { match: /deepseek/i, pricing: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 } },
];

const DEFAULT_PRICING_PER_MILLION: ModelPricingPerMillion = {
  input: 2,
  output: 8,
  cacheRead: 0.2,
  cacheWrite: 2,
};

export function modelPricingPerMillionUsd(model: string): ModelPricingPerMillion {
  const normalized = model.trim();
  for (const rule of MODEL_PRICING_RULES) {
    if (rule.match.test(normalized)) return rule.pricing;
  }
  return DEFAULT_PRICING_PER_MILLION;
}

function safeTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pure reference cost estimator (in USD) for a model and non-overlapping token bucket totals.
 */
export function estimateModelCostUsd(model: string, totals: TokenCostInput): number {
  const input = safeTokenCount(totals.inputTokens);
  const output = safeTokenCount(totals.outputTokens);
  const cacheRead = safeTokenCount(totals.cacheReadTokens);
  const cacheWrite = safeTokenCount(totals.cacheWriteTokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return 0;

  const rate = modelPricingPerMillionUsd(model);
  const rawUsd =
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.cacheRead +
      cacheWrite * rate.cacheWrite) /
    1_000_000;
  return Math.round(rawUsd * 1_000_000) / 1_000_000;
}
