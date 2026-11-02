import { cpus, freemem, totalmem, type CpuInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { MachineMetrics } from "@linkshell/wire";

type CpuSample = { at: number; cores: CpuInfo[] };

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

/** Shared across viewers: sampling is on demand, with no permanent background timer. */
export class MachineMetricsSampler {
  private previous?: CpuSample;
  private cached?: MachineMetrics;
  private pending?: Promise<MachineMetrics>;

  snapshot(): Promise<MachineMetrics> {
    if (this.cached && this.previous && performance.now() - this.previous.at < 1000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(): Promise<MachineMetrics> {
    let before = this.previous;
    // First view (or a long gap) needs a fresh window, not an average since host startup.
    if (!before || performance.now() - before.at > 15_000) {
      before = { at: performance.now(), cores: cpus() };
      await delay(250);
    }
    const after = { at: performance.now(), cores: cpus() };
    const totalBytes = Math.max(0, totalmem());
    const usedBytes = Math.max(0, Math.min(totalBytes, totalBytes - freemem()));
    this.previous = after;
    this.cached = {
      sampledAt: Date.now(),
      sampleIntervalMs: Math.round(after.at - before.at),
      cpu: { usage: cpuUsage(before.cores, after.cores), cores: after.cores.length, model: after.cores[0]?.model ?? "" },
      memory: { totalBytes, usedBytes },
    };
    return this.cached;
  }
}
