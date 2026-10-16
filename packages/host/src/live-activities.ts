import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  buildLiveActivitySnapshot, liveActivityContent, liveActivitySubscriptionSchema, needsAttention, RpcError,
  type LiveActivitySubscription, type SessionSummary,
} from "@linkshell/wire";
import type { SessionHub, Subscriber } from "./hub.js";
import type { TerminalManager } from "./terminals.js";

interface Registration extends LiveActivitySubscription { sequence: number; retryAfter?: number; failures?: number }

/** Its subscriptions outlive a phone socket; only a device-scoped delivery grant leaves that socket. */
export class LiveActivityRelay {
  private readonly registrations = new Map<string, Registration>();
  private readonly watched = new Map<string, Subscriber>();
  private readonly stopListeners: Array<() => void> = [];
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private flushing = false;

  constructor(private readonly options: {
    path: string;
    hub: Pick<SessionHub, "listSessions" | "subscribe" | "unsubscribe" | "onSummary">;
    terminals: Pick<TerminalManager, "list" | "onChange">;
    computerName: () => string;
    serviceUrl?: string;
    request?: typeof fetch;
    log: (message: string) => void;
  }) {}

  private get serviceUrl() { return (this.options.serviceUrl ?? "https://push.itool.tech").replace(/\/$/, ""); }

  start() {
    try {
      if (existsSync(this.options.path)) {
        const saved: unknown = JSON.parse(readFileSync(this.options.path, "utf8"));
        if (Array.isArray(saved)) for (const item of saved.slice(0, 16)) {
          const parsed = liveActivitySubscriptionSchema.safeParse(item);
          if (parsed.success && parsed.data.expiresAt > Date.now() && parsed.data.serviceUrl === this.serviceUrl) {
            this.registrations.set(parsed.data.activityId, { ...parsed.data, sequence: Number.isSafeInteger(item.sequence) ? item.sequence : 0 });
          }
        }
      }
    } catch { this.options.log("[live-activity] could not restore registrations"); }
    this.stopListeners.push(this.options.hub.onSummary(() => this.schedule()), this.options.terminals.onChange(() => this.schedule()));
    this.heartbeat = setInterval(() => this.schedule(), 60_000);
    this.heartbeat.unref();
    this.schedule(0);
  }

  subscribe(subscription: LiveActivitySubscription) {
    const data = liveActivitySubscriptionSchema.parse(subscription);
    if (data.serviceUrl !== this.serviceUrl) throw RpcError.app("invalid_params", "实时活动服务地址与电脑配置不一致");
    if (data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 8 * 60 * 60 * 1000) throw RpcError.app("invalid_params", "实时活动授权已过期");
    if (!this.registrations.has(data.activityId) && this.registrations.size >= 16) throw RpcError.app("busy", "实时活动数量已达上限");
    const previous = this.registrations.get(data.activityId);
    this.registrations.set(data.activityId, { ...data, sequence: previous?.sequence ?? 0 });
    this.save();
    this.schedule(0);
  }

  async unsubscribe(activityId: string) {
    const registration = this.registrations.get(activityId);
    this.registrations.delete(activityId);
    this.save();
    if (!this.registrations.size) this.reconcileWatches([]);
    if (!registration) return;
    try {
      await this.request()(`${this.serviceUrl}/v1/activities/${activityId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${registration.grant}` },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]), redirect: "error",
      });
    } catch { /* The native activity already ended; the server also bounds every grant's lifetime. */ }
  }

  private request() { return this.options.request ?? fetch; }
  private save() {
    const temporary = `${this.options.path}.tmp`;
    const entries = [...this.registrations.values()].map(({ retryAfter: _retry, failures: _failures, ...entry }) => entry);
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.options.path);
  }
  private schedule(delay = 5000) {
    if (this.stopped || !this.registrations.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => this.options.log("[live-activity] update failed"));
    }, delay);
    this.timer.unref();
  }
  private reconcileWatches(sessions: SessionSummary[]) {
    const wanted = new Set(this.registrations.size ? sessions.filter((session) => !session.archived && (session.state === "running" || needsAttention(session))).map((session) => session.id) : []);
    for (const [id, subscriber] of this.watched) if (!wanted.has(id)) {
      this.options.hub.unsubscribe(id, subscriber);
      this.watched.delete(id);
    }
    for (const session of sessions) {
      if (!wanted.has(session.id) || this.watched.has(session.id)) continue;
      const subscriber: Subscriber = { event: () => {} };
      this.watched.set(session.id, subscriber);
      void this.options.hub.subscribe(session.id, session.lastSeq, subscriber).then(() => {
        if (this.stopped || this.watched.get(session.id) !== subscriber) this.options.hub.unsubscribe(session.id, subscriber);
      }).catch(() => { if (this.watched.get(session.id) === subscriber) this.watched.delete(session.id); });
    }
  }

  async flush() {
    if (this.stopped) return;
    if (this.flushing) { this.schedule(); return; }
    this.flushing = true;
    try {
      for (const [id, row] of this.registrations) if (row.expiresAt <= Date.now()) this.registrations.delete(id);
      const sessions = this.options.hub.listSessions({ limit: 200 }).sessions;
      this.reconcileWatches(sessions);
      const terminals = this.options.terminals.list();
      const sends = [...this.registrations.values()].filter((row) => (row.retryAfter ?? 0) <= Date.now()).map(async (row) => {
        const payload = buildLiveActivitySnapshot(this.options.computerName(), sessions, terminals, true, row.computerKey);
        const event = payload.active ? "update" : "end";
        const contentState = liveActivityContent(payload.active ? payload : { ...payload, phase: "completed", title: "任务已结束", subtitle: "打开 App 查看结果" });
        row.sequence = Math.max(Date.now(), row.sequence + 1);
        try {
          const response = await this.request()(`${this.serviceUrl}/v1/activities/${row.activityId}/events`, {
            method: "POST", headers: { Authorization: `Bearer ${row.grant}`, "content-type": "application/json" },
            body: JSON.stringify({ sequence: row.sequence, event, contentState }),
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]), redirect: "error",
          });
          if (this.registrations.get(row.activityId) !== row || this.stopped) return;
          if (response.status === 410 || response.status === 422 || response.status === 400 || (response.ok && event === "end")) {
            this.registrations.delete(row.activityId);
          } else if (response.ok) {
            row.failures = 0; row.retryAfter = 0;
          } else { throw new Error("delivery unavailable"); }
        } catch {
          if (this.registrations.get(row.activityId) !== row || this.stopped) return;
          row.failures = Math.min((row.failures ?? 0) + 1, 5);
          row.retryAfter = Date.now() + Math.min(60_000, 5000 * 2 ** (row.failures - 1));
          this.schedule();
        }
      });
      this.save();
      await Promise.allSettled(sends);
      if (!this.stopped) {
        this.save();
        if (!this.registrations.size) this.reconcileWatches([]);
        if ([...this.registrations.values()].some((row) => row.retryAfter)) this.schedule();
      }
    } finally { this.flushing = false; }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    for (const stop of this.stopListeners) stop();
    for (const [id, subscriber] of this.watched) this.options.hub.unsubscribe(id, subscriber);
    this.watched.clear();
  }
}
