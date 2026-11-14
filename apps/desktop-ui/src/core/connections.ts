import { createStore } from "zustand/vanilla";
import type { ClientStore, HostLink, HostStreams } from "@linkshell/client-core";
import {
  MACHINE_METRICS_HISTORY_LIMIT,
  MACHINE_METRICS_INTERVAL_MS,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type MachineEntry,
  type MachineInfo,
  type MachineMetrics,
  type MachineMetricsSnapshot,
} from "@linkshell/wire";
import { DESKTOP_LOCAL, STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";

export interface Computer {
  key: string;
  gateway: string;
  machine: MachineEntry;
  /** Public signing identity used by the local Host on a relay gateway, learned over local socket. */
  relayId?: string;
}

export interface Connection {
  computer: Computer;
  link: HostLink;
  streams: HostStreams;
  store: ClientStore;
  sessions: SessionSubscriptions;
}

export interface SessionSubscriptionsOptions {
  maxWarm?: number;
  ttlMs?: number;
}

/**
 * Reference-counted session subscriptions with a bounded warm LRU cache (default 6 sessions, 5m TTL).
 * Archived or deleted sessions are evicted immediately.
 */
export class SessionSubscriptions {
  private readonly counts = new Map<string, number>();
  private readonly warm = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxWarm: number;
  private readonly ttlMs: number;
  private readonly unsubscribeStore: () => void;
  private closed = false;

  constructor(private readonly store: ClientStore, options: SessionSubscriptionsOptions = {}) {
    this.maxWarm = options.maxWarm ?? 6;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.unsubscribeStore = store.subscribe((state, previous) => {
      if (!state?.sessions || state.sessions === previous?.sessions || this.warm.size === 0) return;
      for (const sessionId of [...this.warm.keys()]) {
        const summary = state.sessions[sessionId];
        if (!summary || summary.archived) this.evict(sessionId);
      }
    });
  }

  acquire(sessionId: string): () => void {
    if (this.closed) return () => {};
    const warmTimer = this.warm.get(sessionId);
    if (warmTimer !== undefined) {
      clearTimeout(warmTimer);
      this.warm.delete(sessionId);
    }
    const current = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, current + 1);
    if (current === 0 && warmTimer === undefined) {
      this.store.getState().openSession?.(sessionId);
    }
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      const next = (this.counts.get(sessionId) ?? 1) - 1;
      if (next > 0) {
        this.counts.set(sessionId, next);
        return;
      }
      this.counts.delete(sessionId);
      const sessions = this.store.getState().sessions;
      const summary = sessions ? sessions[sessionId] : undefined;
      if ((sessions && (!summary || summary.archived)) || this.maxWarm <= 0 || this.ttlMs <= 0) {
        this.store.getState().closeSession?.(sessionId);
        return;
      }
      while (this.warm.size >= this.maxWarm) {
        const oldest = this.warm.keys().next().value;
        if (oldest === undefined) break;
        this.evict(oldest);
      }
      const timer = setTimeout(() => {
        this.warm.delete(sessionId);
        if (!this.closed && !this.counts.has(sessionId)) {
          this.store.getState().closeSession?.(sessionId);
        }
      }, this.ttlMs);
      this.warm.set(sessionId, timer);
    };
  }

  evict(sessionId: string): void {
    const timer = this.warm.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.warm.delete(sessionId);
    }
    if (!this.counts.has(sessionId)) {
      this.store.getState().closeSession?.(sessionId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeStore();
    for (const timer of this.warm.values()) clearTimeout(timer);
    const ids = new Set([...this.counts.keys(), ...this.warm.keys()]);
    this.counts.clear();
    this.warm.clear();
    for (const sessionId of ids) {
      this.store.getState().closeSession?.(sessionId);
    }
  }
}

/**
 * Reference-counted per-computer connections separating RPC consumers (`users`) from bulk WebRTC
 * stream consumers (`streamUsers`) so background fleet/project polling never spins up `HostStreams`.
 */
export class ComputerConnections {
  private readonly entries = new Map<
    string,
    { connection: Connection; close: () => void; users: number; streamUsers: number }
  >();

  constructor(private readonly open: (computer: Computer) => { connection: Connection; close: () => void }) {}

  acquire(computer: Computer, options?: { metadataOnly?: boolean }) {
    let entry = this.entries.get(computer.key);
    if (!entry) {
      entry = { ...this.open(computer), users: 0, streamUsers: 0 };
      this.entries.set(computer.key, entry);
    }
    const retained = entry;
    retained.users++;
    const usesStreams = !options?.metadataOnly;
    if (usesStreams && retained.streamUsers++ === 0) {
      try {
        retained.connection.streams.start();
      } catch (error) {
        retained.streamUsers--;
        if (--retained.users === 0) this.remove(computer.key);
        else retained.connection.streams.stop();
        throw error;
      }
    }
    let released = false;
    return {
      connection: retained.connection,
      release: () => {
        if (released || this.entries.get(computer.key) !== retained) return;
        released = true;
        if (usesStreams) retained.streamUsers--;
        if (--retained.users === 0) this.remove(computer.key);
        else if (usesStreams && retained.streamUsers === 0) retained.connection.streams.stop();
      },
    };
  }

  values(): Connection[] {
    return [...this.entries.values()].map(({ connection }) => connection);
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    entry?.close();
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }
}

/** Resolves a computer by exact key or by matching local Host ↔ relay alias. */
export function computerAtKey(
  computers: Computer[],
  key: string,
  knownLocal?: Computer,
): Computer | undefined {
  const exact = computers.find((computer) => computer.key === key);
  if (exact) return exact;
  const local = knownLocal ?? computers.find((computer) => computer.key === DESKTOP_LOCAL);
  if (!local?.relayId || (key !== local.key && !key.endsWith(`#${local.relayId}`))) return undefined;
  return computers.find((computer) => computer.key === local.key || computer.machine.id === local.relayId);
}

/**
 * Merges `desktop:local` with its gateway relay alias (`${gateway}#${relayId}`).
 * Prefers the zero-latency local socket while online, falling back seamlessly to the relay entry if local stops.
 */
export function deduplicateLocalComputer(computers: Computer[]): Computer[] {
  const local = computers.find((computer) => computer.key === DESKTOP_LOCAL);
  if (!local?.relayId) return computers;
  const preferred = local.machine.online
    ? local
    : (computers.find(
        (computer) => computer !== local && computer.machine.id === local.relayId && computer.machine.online,
      ) ?? local);
  return computers.filter(
    (computer) => computer === preferred || (computer !== local && computer.machine.id !== local.relayId),
  );
}

export type ComputerNames = Record<string, string>;
export const COMPUTER_NAME_LIMIT = 40;
const sharedNameKey = (key: string) => `@shared:${key}`;

export function parseComputerNames(value: unknown): ComputerNames {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, name]) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        name.length <= (key.startsWith("@shared:") ? 120 : COMPUTER_NAME_LIMIT),
    ),
  );
}

export function computerName(computer: Computer, names: ComputerNames): string {
  return (
    (computer.machine.namingConfigured ? computer.machine.name : names[sharedNameKey(computer.key)]) ||
    names[computer.key] ||
    computer.machine.name ||
    "电脑"
  );
}

export function computerIdentity(computer: Computer): string {
  const platform = (
    { darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>
  )[computer.machine.platform ?? ""];
  return `${platform || computer.machine.platform || "电脑"} · ${computer.machine.id.slice(0, 8)}`;
}

export function computerOption(computer: Computer, names: ComputerNames): string {
  return `${computerName(computer, names)} · ${computer.machine.id.slice(0, 8)} · ${
    computer.machine.online ? "在线" : "离线"
  }`;
}

export function createComputerNames() {
  const store = createStore<ComputerNames>(() =>
    parseComputerNames(readLocal<unknown>(STORAGE_KEYS.computerNames, {})),
  );
  const pending = new Map<string, { name: string; saved?: string }>();

  const readNames = () => {
    const saved = parseComputerNames(readLocal<unknown>(STORAGE_KEYS.computerNames, {}));
    const next = { ...saved };
    for (const [key, entry] of pending) {
      const current = saved[sharedNameKey(key)];
      if (current !== entry.saved) {
        pending.delete(key);
        continue;
      }
      next[sharedNameKey(key)] = entry.name;
      delete next[key];
    }
    return { saved, next };
  };

  const remember = (computer: Computer, name: string) => {
    const { saved, next } = readNames();
    if (next[sharedNameKey(computer.key)] === name && !next[computer.key] && pending.size === 0) {
      store.setState(next, true);
      return;
    }
    delete next[computer.key];
    next[sharedNameKey(computer.key)] = name;
    pending.set(computer.key, { name, saved: saved[sharedNameKey(computer.key)] });
    try {
      saveLocal(STORAGE_KEYS.computerNames, next);
      pending.clear();
    } catch {
      // Retain host-confirmed name in memory until storage write succeeds.
    }
    store.setState(next, true);
  };

  return {
    store,
    refresh() {
      store.setState(readNames().next, true);
    },
    remember(computer: Computer) {
      if (computer.machine.namingConfigured) remember(computer, computer.machine.name);
    },
    sync(computer: Computer, machine: MachineInfo) {
      if (machine.naming?.configured) remember(computer, machine.hostname);
    },
    async rename(computer: Computer, value: string, link: Pick<HostLink, "call">) {
      const name = value.trim();
      if (name.length > COMPUTER_NAME_LIMIT) {
        throw new Error(`名称不能超过 ${COMPUTER_NAME_LIMIT} 个字符`);
      }
      const machine = await link.call("machine.rename", { name });
      remember(computer, machine.hostname);
      return machine;
    },
  };
}

export const computerNames = createComputerNames();
subscribeStorageReady(() => computerNames.refresh());

export interface MachineMetricsState {
  metrics?: MachineMetrics;
  history: MachineMetrics[];
  error?: string;
  unsupported?: boolean;
  hostHistory?: boolean;
}

/** Polls `machine.metrics` every 5s (protocol >= 3), backfilling 24-sample (2-min) history on connect. */
export function observeMachineMetrics(
  read: () => Promise<MachineMetricsSnapshot>,
  changed: (state: MachineMetricsState) => void,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let history: MachineMetrics[] = [];

  async function poll() {
    try {
      const { history: hostHistory, ...metrics } = await read();
      if (disposed) return;
      history = [
        ...(hostHistory ?? history).filter(
          (entry) =>
            entry.sampledAt < metrics.sampledAt &&
            entry.sampledAt > metrics.sampledAt - MACHINE_METRICS_INTERVAL_MS * MACHINE_METRICS_HISTORY_LIMIT,
        ),
        metrics,
      ].slice(-MACHINE_METRICS_HISTORY_LIMIT);
      changed({ metrics, history, hostHistory: hostHistory !== undefined });
    } catch (reason) {
      if (disposed) return;
      const unsupported =
        reason instanceof RpcError &&
        (reason.code === RPC_METHOD_NOT_FOUND ||
          reason.appCode === "not_supported" ||
          reason.appCode === "host_outdated");
      changed({
        history,
        unsupported,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      if (unsupported) return;
    }
    if (!disposed) {
      timer = setTimeout(() => void poll(), MACHINE_METRICS_INTERVAL_MS);
    }
  }

  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}

/** Preserves sleep/disconnect gaps along the 24-sample 2-minute telemetry time axis. */
export function historySamples(history: MachineMetrics[]): (MachineMetrics | undefined)[] {
  const samples = Array<MachineMetrics | undefined>(MACHINE_METRICS_HISTORY_LIMIT).fill(undefined);
  const latest = history.at(-1)?.sampledAt;
  if (latest === undefined) return samples;
  for (const entry of history) {
    const index =
      MACHINE_METRICS_HISTORY_LIMIT - 1 - Math.round((latest - entry.sampledAt) / MACHINE_METRICS_INTERVAL_MS);
    if (index >= 0 && index < samples.length) samples[index] = entry;
  }
  return samples;
}

export function memoryPercent(metrics: MachineMetrics): number | null {
  return metrics.memory.totalBytes > 0
    ? Math.min(100, Math.max(0, (metrics.memory.usedBytes / metrics.memory.totalBytes) * 100))
    : null;
}
