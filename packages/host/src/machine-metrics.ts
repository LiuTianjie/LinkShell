import { cpus, freemem, homedir, totalmem, type CpuInfo } from "node:os";
import { execFile } from "node:child_process";
import type { BigIntStatsFs } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { promisify } from "node:util";
import { MACHINE_METRICS_HISTORY_LIMIT, MACHINE_METRICS_INTERVAL_MS, type MachineMetrics, type MachineMetricsSnapshot } from "@linkshell/wire";

type CpuSample = { at: number; cores: CpuInfo[] };
type DiskMetrics = NonNullable<MachineMetrics["disk"]>;
const DISK_INTERVAL_MS = 30_000;
const run = promisify(execFile);

export function macMemoryUsedBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const pages = new Map([...output.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map((match) => [match[1], Number(match[2])]));
  const anonymous = pages.get("Anonymous pages"), wired = pages.get("Pages wired down");
  const compressed = pages.get("Pages occupied by compressor"), purgeable = pages.get("Pages purgeable");
  if (!pageSize || anonymous === undefined || wired === undefined || compressed === undefined || purgeable === undefined) return null;
  // File-backed pages are cache. Count the compressor's physical footprint, not its uncompressed contents.
  const used = (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
  return Number.isSafeInteger(used) ? used : null;
}

export function linuxMemoryAvailableBytes(output: string): number | null {
  const value = /^MemAvailable:\s+(\d+) kB$/m.exec(output)?.[1];
  const available = value === undefined ? NaN : Number(value) * 1024;
  return Number.isSafeInteger(available) ? available : null;
}

async function memoryUsage(): Promise<MachineMetrics["memory"]> {
  const totalBytes = Math.max(0, totalmem());
  let usedBytes: number | null = null;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run("/usr/bin/vm_stat", [], { timeout: 1000, maxBuffer: 64 * 1024 });
      usedBytes = macMemoryUsedBytes(stdout);
    } else if (process.platform === "linux") {
      const available = linuxMemoryAvailableBytes(await readFile("/proc/meminfo", "utf8"));
      if (available !== null) usedBytes = totalBytes - available;
    } else if (process.platform === "win32") {
      // GlobalMemoryStatusEx reports available memory, including reclaimable standby pages.
      usedBytes = totalBytes - freemem();
    }
  } catch { /* Restricted OS counters fall back to the legacy reading, explicitly marked as including cache. */ }
  return { totalBytes, usedBytes: Math.max(0, Math.min(totalBytes, usedBytes ?? totalBytes - freemem())), includesCache: usedBytes === null };
}

export function diskUsageBytes(stats: Pick<BigIntStatsFs, "bsize" | "blocks" | "bfree" | "bavail">): Pick<DiskMetrics, "totalBytes" | "usedBytes" | "availableBytes"> | undefined {
  if (stats.bsize <= 0n || stats.blocks <= 0n || stats.bfree < 0n || stats.bfree > stats.blocks || stats.bavail > stats.bfree) return undefined;
  const totalBytes = Number(stats.blocks * stats.bsize);
  if (!Number.isSafeInteger(totalBytes)) return undefined;
  return {
    totalBytes,
    usedBytes: Number((stats.blocks - stats.bfree) * stats.bsize),
    // Reserved free space is neither occupied data nor space the current user can write.
    availableBytes: Number((stats.bavail < 0n ? 0n : stats.bavail) * stats.bsize),
  };
}

export function cpuUsage(previous: CpuInfo[], current: CpuInfo[]): number | null {
  if (!current.length || previous.length !== current.length) return null;
  let idle = 0, total = 0;
  for (let index = 0; index < current.length; index++) {
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = current[index]!.times[key] - previous[index]!.times[key];
      // Hotplug, counter reset or unavailable ticks cannot be represented as 0% activity.
      if (delta < 0 || !Number.isFinite(delta)) return null;
      total += delta;
      if (key === "idle") idle += delta;
    }
  }
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

/** One bounded history per host, collected even when no viewer is connected. */
export class MachineMetricsSampler {
  private previous?: CpuSample;
  private cached?: MachineMetrics;
  private pending?: Promise<MachineMetrics>;
  private history: MachineMetrics[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private disk?: DiskMetrics;
  private diskCheckedAt = -Infinity;
  private diskPending?: Promise<DiskMetrics | undefined>;

  start(): void {
    if (this.timer) return;
    const sample = () => { void this.sample().catch(() => {}); };
    sample();
    this.timer = setInterval(sample, MACHINE_METRICS_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async snapshot(): Promise<MachineMetricsSnapshot> {
    const metrics = this.pending ? await this.pending
      : this.cached && this.sampleAge() < 15_000 ? this.cached
      : await this.sample();
    return { ...metrics, history: [...this.history] };
  }

  private sampleAge(): number {
    // Some platforms pause monotonic time during sleep; wall time still expires the old reading.
    return this.previous && this.cached
      ? Math.max(performance.now() - this.previous.at, Date.now() - this.cached.sampledAt)
      : Infinity;
  }

  private sample(): Promise<MachineMetrics> {
    if (this.pending) return this.pending;
    if (this.cached && this.sampleAge() < 1000) return Promise.resolve(this.cached);
    this.pending = this.collect().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async sampleDisk(): Promise<DiskMetrics | undefined> {
    const age = Date.now() - this.diskCheckedAt;
    if (this.diskPending || age >= 0 && age < DISK_INTERVAL_MS) return this.disk;
    this.diskCheckedAt = Date.now();
    this.disk = undefined;
    const path = homedir();
    this.diskPending = statfs(path, { bigint: true }).then((stats) => {
      const usage = diskUsageBytes(stats);
      this.disk = usage && { path, sampledAt: Date.now(), ...usage };
      return this.disk;
    }).catch(() => undefined).finally(() => { this.diskPending = undefined; });
    // A disconnected network home must not hold up CPU/memory, or queue more filesystem requests.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.diskPending,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); timer.unref(); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async collect(): Promise<MachineMetrics> {
    let before = this.previous;
    // Startup or waking from sleep needs a fresh window, not an average across the gap.
    if (!before || this.sampleAge() >= 15_000) {
      before = { at: performance.now(), cores: cpus() };
      await delay(250);
    }
    const after = { at: performance.now(), cores: cpus() };
    const sampledAt = Date.now();
    const [memory, disk] = await Promise.all([memoryUsage(), this.sampleDisk()]);
    this.previous = after;
    this.cached = {
      sampledAt,
      sampleIntervalMs: Math.round(after.at - before.at),
      cpu: { usage: cpuUsage(before.cores, after.cores), cores: after.cores.length, model: after.cores[0]?.model ?? "" },
      memory,
      ...(disk ? { disk } : {}),
    };
    this.history = [...this.history.filter((entry) => entry.sampledAt < sampledAt && entry.sampledAt > sampledAt - MACHINE_METRICS_INTERVAL_MS * MACHINE_METRICS_HISTORY_LIMIT), this.cached].slice(-MACHINE_METRICS_HISTORY_LIMIT);
    return this.cached;
  }
}
