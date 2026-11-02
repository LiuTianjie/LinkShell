import { afterEach, expect, it, vi } from "vitest";
import { RpcError, type MachineMetrics } from "@linkshell/wire";
import { observeMachineMetrics } from "../src/live/machine-metrics";

afterEach(() => vi.useRealTimers());
const sample = (sampledAt = 1000): MachineMetrics => ({ sampledAt, sampleIntervalMs: 5000, cpu: { usage: 37, cores: 8, model: "test" }, memory: { totalBytes: 1000, usedBytes: 600 } });

it("waits for a slow sample and ignores its result after the card is hidden or removed", async () => {
  vi.useFakeTimers();
  let resolve!: (value: MachineMetrics) => void;
  const read = vi.fn(() => new Promise<MachineMetrics>((done) => { resolve = done; }));
  const changed = vi.fn();
  const stop = observeMachineMetrics(read, changed);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(1);
  stop(); resolve(sample());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(changed).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it("clears stale readings on error, recovers on the next poll and bounds history", async () => {
  vi.useFakeTimers();
  let time = 0;
  const read = vi.fn(async () => sample(time += 5000));
  read.mockRejectedValueOnce(new Error("disconnected"));
  const changed = vi.fn();
  const stop = observeMachineMetrics(read, changed);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith({ history: [], error: "disconnected", unsupported: false });
  await vi.advanceTimersByTimeAsync(150_000);
  const state = changed.mock.lastCall![0];
  expect(state.error).toBeUndefined();
  expect(state.history).toHaveLength(24);
  expect(state.metrics.sampledAt).toBe(time);
  read.mockRejectedValueOnce(new Error("lost"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(changed.mock.lastCall![0].metrics).toBeUndefined();
  stop();
});

it("stops polling hosts that report an unsupported method through HostLink", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => { throw RpcError.app("host_outdated", "update host"); });
  const changed = vi.fn();
  const stop = observeMachineMetrics(read, changed);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(changed.mock.lastCall![0].unsupported).toBe(true);
  stop();
});
