import { describe, expect, it } from "vitest";
import { estimateModelCostUsd, modelPricingPerMillionUsd } from "../src/usage.js";

describe("Chinese and international model pricing estimation", () => {
  it("matches mainstream Chinese coding model families with specific tier rules", () => {
    expect(modelPricingPerMillionUsd("qwen3-coder-plus")).toEqual({ input: 0.3, output: 1.5, cacheRead: 0.06, cacheWrite: 0.3 });
    expect(modelPricingPerMillionUsd("qwen3-max")).toEqual({ input: 1.6, output: 6.4, cacheRead: 0.32, cacheWrite: 1.6 });
    expect(modelPricingPerMillionUsd("qwen-turbo-latest")).toEqual({ input: 0.05, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 });
    expect(modelPricingPerMillionUsd("qwen3-plus")).toEqual({ input: 0.4, output: 1.2, cacheRead: 0.08, cacheWrite: 0.4 });

    expect(modelPricingPerMillionUsd("kimi-k2.5")).toEqual({ input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 });
    expect(modelPricingPerMillionUsd("moonshot-v1-128k")).toEqual({ input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 });

    expect(modelPricingPerMillionUsd("glm-5.3-flash")).toEqual({ input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.1 });
    expect(modelPricingPerMillionUsd("glm-5.3")).toEqual({ input: 0.6, output: 2.2, cacheRead: 0.12, cacheWrite: 0.6 });

    expect(modelPricingPerMillionUsd("MiniMax-M2.5")).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 });
    expect(modelPricingPerMillionUsd("deepseek-reasoner")).toEqual({ input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 });
    expect(modelPricingPerMillionUsd("deepseek-chat")).toEqual({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 });

    expect(modelPricingPerMillionUsd("doubao-seed-code")).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.3 });
    expect(modelPricingPerMillionUsd("hunyuan-turbos")).toEqual({ input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
    expect(modelPricingPerMillionUsd("ernie-4.5-turbo")).toEqual({ input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.4 });
  });

  it("computes USD cost accurately for Chinese models", () => {
    const cost = estimateModelCostUsd("qwen3-coder-plus", {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(1.11);
  });
});
