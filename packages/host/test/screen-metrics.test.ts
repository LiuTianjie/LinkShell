import { describe, expect, it } from "vitest";
import { screenMeasurementLog } from "../src/screen-metrics.js";

describe("screen diagnostic logging", () => {
  it("preserves sender and presentation timings beyond the old 1000-character cutoff", () => {
    const message = {
      t: "measure", mode: "native", sender: {
        encoder: "LinkShellLowLatency", sendDelayMs: 1220.89,
        ...Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`counter${n}`, 1234567890])),
      },
      ...Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`sample${n}`, 1234567890])),
      decodeToRendererP95Ms: 1, rendererToSubmitP95Ms: 8, submitToPresentP95Ms: 16,
    };
    expect(JSON.stringify(message).length).toBeGreaterThan(1000);
    expect(JSON.parse(screenMeasurementLog(message))).toEqual(message);
  });

  it("bounds untrusted diagnostics without writing incomplete JSON or frame traces", () => {
    const logged = screenMeasurementLog({
      t: "measure", mode: "x".repeat(20_000), trace: Array(200).fill({ pixel: "data" }),
      sender: { invalid: NaN, nested: { deeper: "ignored" }, sendDelayMs: 2 },
      latency: { n: 10, p95: 20 },
    });
    expect(JSON.parse(logged)).toEqual({ t: "measure", mode: "x".repeat(128), sender: { sendDelayMs: 2 }, latency: { n: 10, p95: 20 } });
    expect(logged.length).toBeLessThanOrEqual(8192);
  });
});
