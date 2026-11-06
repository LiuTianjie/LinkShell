import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { statfs } from "node:fs/promises";
import { MachineMetricsSampler } from "../src/machine-metrics.js";

// Keep the daemon's clock deterministic without launching OS commands on every virtual tick.
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: async () => ({ stdout: "(page size of 16384 bytes)\nAnonymous pages: 100.\nPages wired down: 50.\nPages purgeable: 10.\nPages occupied by compressor: 20." }),
  }),
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => "MemAvailable: 1000 kB\n", statfs: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }));
vi.mock("node:timers", () => ({
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}));

const filesystem = { type: 0n, bsize: 4096n, blocks: 1000n, bfree: 300n, bavail: 250n, files: 0n, ffree: 0n };
beforeEach(() => { vi.mocked(statfs).mockReset().mockResolvedValue(filesystem); });
afterEach(() => vi.useRealTimers());

it("collects a bounded two-minute history before any viewer opens, keeps it across viewers, and stops with the host", async () => {
  vi.useFakeTimers();
  const sampler = new MachineMetricsSampler();
  sampler.start();
  try {
    await vi.advanceTimersByTimeAsync(180_000);
    const first = await sampler.snapshot();
    expect(first.history).toHaveLength(24);
    expect(first.disk).toBeDefined();
    expect(vi.mocked(statfs).mock.calls.length).toBeLessThan(first.history!.length);
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

it("keeps CPU and memory history available while a filesystem request hangs, and recovers after it fails", async () => {
  vi.useFakeTimers();
  let failDisk!: (error: Error) => void;
  vi.mocked(statfs).mockImplementationOnce(() => new Promise((_resolve, reject) => { failDisk = reject; }));
  const sampler = new MachineMetricsSampler();
  sampler.start();
  try {
    await vi.advanceTimersByTimeAsync(1250);
    const first = await sampler.snapshot();
    expect(first.history).toHaveLength(1);
    expect(first.disk).toBeUndefined();
    await vi.advanceTimersByTimeAsync(35_000);
    const waiting = await sampler.snapshot();
    expect(waiting.history!.length).toBeGreaterThan(1);
    expect(waiting.disk).toBeUndefined();
    expect(statfs).toHaveBeenCalledTimes(1);
    failDisk(new Error("Network home is unavailable"));
    await vi.advanceTimersByTimeAsync(5000);
    const recovered = await sampler.snapshot();
    expect(recovered.disk).toBeDefined();
    expect(recovered.sampledAt).toBeGreaterThan(waiting.sampledAt);
    expect(statfs).toHaveBeenCalledTimes(2);
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
