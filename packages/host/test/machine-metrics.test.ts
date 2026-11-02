import { expect, it } from "vitest";
import { cpus, totalmem, tmpdir, type CpuInfo } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { machineMetricsSchema, machineMetricsSnapshotSchema } from "@linkshell/wire";
import { cpuUsage, linuxMemoryAvailableBytes, macMemoryUsedBytes } from "../src/machine-metrics.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const core = (user: number, idle: number): CpuInfo => ({ model: "test", speed: 3000, times: { user, idle, nice: 0, sys: 0, irq: 0 } });

it("calculates whole-machine usage from CPU tick deltas instead of lifetime totals or summed percentages", () => {
  expect(cpuUsage([core(900, 100), core(100, 900)], [core(910, 190), core(150, 950)])).toBe(30);
});

it("does not invent idle usage for unavailable counters, CPU hotplug, or counter resets", () => {
  expect(cpuUsage([], [])).toBeNull();
  expect(cpuUsage([core(1, 1)], [core(1, 1)])).toBeNull();
  expect(cpuUsage([core(1, 1)], [core(2, 2), core(2, 2)])).toBeNull();
  expect(cpuUsage([core(10, 10)], [core(1, 20)])).toBeNull();
});

it("excludes macOS file caches and purgeable pages, counting only the physical compressed footprint on both page sizes", () => {
  const counters = `Pages free: 10.
Pages active: 450.
Pages inactive: 300.
Pages speculative: 40.
Pages wired down: 100.
Pages purgeable: 50.
File-backed pages: 400.
Anonymous pages: 390.
Pages stored in compressor: 600.
Pages occupied by compressor: 150.`;
  for (const size of [4096, 16384]) {
    expect(macMemoryUsedBytes(`Mach Virtual Memory Statistics: (page size of ${size} bytes)\n${counters}`)).toBe(590 * size);
  }
  expect(macMemoryUsedBytes(counters)).toBeNull();
  expect(macMemoryUsedBytes(`(page size of 16384 bytes)\n${counters.replace("Pages occupied by compressor", "missing")}`)).toBeNull();
});

it("uses Linux available memory, which includes reclaimable cache, rather than MemFree", () => {
  expect(linuxMemoryAvailableBytes("MemTotal:       1000000 kB\nMemFree:          10000 kB\nMemAvailable:    600000 kB\nCached:          500000 kB\n")).toBe(600000 * 1024);
  expect(linuxMemoryAvailableBytes("MemFree: 10000 kB\n")).toBeNull();
});

it("serves real system measurements over RPC and shares one initial sample between viewers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ls-machine-metrics-"));
  const host = await startHost({ home, version: "test", env: {}, drivers: () => [], discoveryIntervalMs: 0, iceServers: false, log: () => {} });
  const first = await connectHost(host.paths.hostSocket), second = await connectHost(host.paths.hostSocket);
  try {
    expect((await first.call("machine.info", {})).protocol).toBeGreaterThanOrEqual(3);
    const [a, b] = await Promise.all([first.call("machine.metrics", {}), second.call("machine.metrics", {})]);
    expect(machineMetricsSnapshotSchema.parse(a)).toEqual(b);
    expect(a.history).toEqual([machineMetricsSchema.parse(a)]);
    expect(a.cpu.cores).toBe(cpus().length);
    expect(a.memory.totalBytes).toBe(totalmem());
    expect(a.memory.usedBytes).toBeLessThanOrEqual(a.memory.totalBytes);
    if (["darwin", "linux", "win32"].includes(process.platform)) expect(a.memory.includesCache).toBe(false);
    expect(a.sampleIntervalMs).toBeGreaterThanOrEqual(200);
    expect(await first.call("machine.metrics", {})).toEqual(a);
  } finally {
    first.close(); second.close(); await host.stop(); await rm(home, { recursive: true, force: true });
  }
});
