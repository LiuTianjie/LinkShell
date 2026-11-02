import { afterEach, expect, it, vi } from "vitest";
import { MachineMetricsSampler } from "../src/machine-metrics.js";

// Keep the daemon's clock deterministic without launching OS commands on every virtual tick.
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: async () => ({ stdout: "(page size of 16384 bytes)\nAnonymous pages: 100.\nPages wired down: 50.\nPages purgeable: 10.\nPages occupied by compressor: 20." }),
  }),
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => "MemAvailable: 1000 kB\n" }));
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }));

afterEach(() => vi.useRealTimers());

it("collects a bounded two-minute history before any viewer opens, keeps it across viewers, and stops with the host", async () => {
  vi.useFakeTimers();
  const sampler = new MachineMetricsSampler();
  sampler.start();
  try {
    await vi.advanceTimersByTimeAsync(180_000);
    const first = await sampler.snapshot();
    expect(first.history).toHaveLength(24);
    expect(first.history![0]!.sampledAt).toBe(first.sampledAt - 115_000);
    expect(await sampler.snapshot()).toEqual(first);
    // No calls while the page is closed; reopening gets the samples from that interval too.
    await vi.advanceTimersByTimeAsync(30_000);
    const reopened = await sampler.snapshot();
    expect(reopened.history).toHaveLength(24);
    expect(reopened.sampledAt).toBe(first.sampledAt + 30_000);
    expect(reopened.history!.filter((entry) => entry.sampledAt > first.sampledAt)).toHaveLength(6);
    sampler.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally { sampler.stop(); }
});

it("expires samples across sleep and starts a fresh CPU window when the host resumes", async () => {
  vi.useFakeTimers();
  const sampler = new MachineMetricsSampler();
  sampler.start();
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    sampler.stop();
    vi.setSystemTime(Date.now() + 180_000);
    sampler.start();
    const pending = sampler.snapshot();
    await vi.advanceTimersByTimeAsync(250);
    const resumed = await pending;
    expect(resumed.history).toHaveLength(1);
    expect(resumed.sampleIntervalMs).toBe(250);
  } finally { sampler.stop(); }
});
