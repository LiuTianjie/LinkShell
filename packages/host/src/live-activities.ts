import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  buildLiveActivitySnapshot, liveActivityActions, liveActivityContent, liveActivityDetailLink, liveActivityNoticeSchema,
  liveActivityPushToStartSchema, liveActivitySessionTask, liveActivitySubscriptionSchema, liveActivityTerminalTask,
  needsAttention, RpcError, terminalState, wakeupNoticeSchema,
  type LiveActivityNotice, type LiveActivityPushToStart, type LiveActivitySubscription, type LiveActivityTask,
  type SessionSummary, type TerminalInfo, type WakeupEventType, type WakeupNotice,
} from "@linkshell/wire";
import type { SessionHub, Subscriber } from "./hub.js";
import type { TerminalManager } from "./terminals.js";

const DEFAULT_PUSH_TO_START_COOLDOWN_MS = 15 * 60 * 1000;
const ROUTINE_COALESCE_MS = 15_000;
const DEFAULT_SCHEDULE_MS = 5000;

interface Registration extends LiveActivitySubscription {
  sequence: number; retryAfter?: number; failures?: number;
  notices?: LiveActivityNotice[]; lastNoticeId?: string;
  /** In-memory digest of the last accepted delivery to avoid burning APNs budget on unchanged heartbeats. */
  lastPayloadHash?: string;
}

interface PendingPushToStart {
  sessionId: string;
  phase: LiveActivityTask["phase"];
  wakeup?: WakeupNotice;
  createdAt: number;
}

interface PushToStartRegistration extends LiveActivityPushToStart {
  sequence: number;
  retryAfter?: number;
  failures?: number;
  pendingStart?: PendingPushToStart;
  lastPushToStartAt?: number;
}

function isSupersededRegistration(existing: Registration, incoming: LiveActivitySubscription): boolean {
  if (existing.activityId === incoming.activityId) return false;
  if (existing.computerKey !== incoming.computerKey) return false;
  if (existing.deviceId && incoming.deviceId) {
    return existing.deviceId === incoming.deviceId || existing.grant === incoming.grant;
  }
  if (existing.grant === incoming.grant) return true;
  // Legacy subscriptions without deviceId cannot be distinguished per device; supersede
  // older untagged entries for the same computerKey to stop duplicate APNs fanout.
  return !existing.deviceId || !incoming.deviceId;
}

/** Its subscriptions outlive a phone socket; only a device-scoped delivery grant leaves that socket. */
export class LiveActivityRelay {
  private readonly registrations = new Map<string, Registration>();
  private readonly pushToStart = new Map<string, PushToStartRegistration>();
  private readonly watched = new Map<string, Subscriber>();
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly terminals = new Map<string, TerminalInfo>();
  private readonly stopListeners: Array<() => void> = [];
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private flushing = false;

  constructor(private readonly options: {
    path: string;
    hub: Pick<SessionHub, "listSessions" | "subscribe" | "unsubscribe" | "onSummary" | "onRemoved">;
    terminals: Pick<TerminalManager, "list" | "onChange">;
    computerName: () => string;
    machineId?: () => string;
    onWakeup?: (notice: WakeupNotice) => void;
    serviceUrl?: string;
    pushToStartCooldownMs?: number;
    request?: typeof fetch;
    log: (message: string) => void;
  }) {}

  private get serviceUrl() { return (this.options.serviceUrl ?? "https://push.itool.tech").replace(/\/$/, ""); }
  private get pushToStartPath() { return `${this.options.path.replace(/\.json$/, "")}-push-to-start.json`; }
  private get pushToStartCooldownMs() { return this.options.pushToStartCooldownMs ?? DEFAULT_PUSH_TO_START_COOLDOWN_MS; }
  private resolveComputerName() {
    const configured = this.options.computerName?.()?.trim();
    return [...(configured || hostname().trim() || "LinkShell")].slice(0, 80).join("") || "LinkShell";
  }
  private pushToStartKey(item: Pick<LiveActivityPushToStart, "deviceId" | "platform" | "computerKey">) {
    return `${item.deviceId}:${item.platform}:${item.computerKey}`;
  }
  private hasForegroundFor(computerKey: string, deviceId?: string, now = Date.now()) {
    for (const row of this.registrations.values()) {
      if (row.computerKey !== computerKey || row.expiresAt <= now) continue;
      if (!row.deviceId || !deviceId || row.deviceId === deviceId) return true;
    }
    return false;
  }
  private isPushToStartCoolingDown(row: PushToStartRegistration, now = Date.now()) {
    const cooldownMs = this.pushToStartCooldownMs;
    return cooldownMs > 0 && typeof row.lastPushToStartAt === "number" && now - row.lastPushToStartAt < cooldownMs;
  }
  private resetPushToStartCooldown(computerKey: string, deviceId?: string, now = Date.now()) {
    let changed = false;
    for (const row of this.pushToStart.values()) {
      if (row.computerKey !== computerKey) continue;
      if (deviceId && row.deviceId !== deviceId) continue;
      if (this.hasForegroundFor(computerKey, row.deviceId, now)) continue;
      if (row.lastPushToStartAt !== undefined) {
        row.lastPushToStartAt = undefined;
        changed = true;
      }
    }
    if (changed) this.savePushToStart();
  }
  private hasPendingPushToStart() {
    for (const row of this.pushToStart.values()) {
      if (row.pendingStart) return true;
    }
    return false;
  }

  start() {
    try {
      if (existsSync(this.options.path)) {
        const saved: unknown = JSON.parse(readFileSync(this.options.path, "utf8"));
        if (Array.isArray(saved)) for (const item of saved.slice(0, 16)) {
          const parsed = liveActivitySubscriptionSchema.safeParse(item);
          if (parsed.success && parsed.data.expiresAt > Date.now() && parsed.data.serviceUrl === this.serviceUrl) {
            const notices = (Array.isArray(item.notices) ? item.notices : []).flatMap((notice: unknown) => {
              const result = liveActivityNoticeSchema.safeParse(notice);
              return result.success && Date.now() - result.data.createdAt < 180_000 ? [result.data] : [];
            }).slice(-8);
            const restored: Registration = {
              ...parsed.data,
              sequence: Number.isSafeInteger(item.sequence) ? item.sequence : 0,
              notices,
              lastNoticeId: typeof item.lastNoticeId === "string" ? item.lastNoticeId.slice(0, 128) : undefined,
            };
            for (const [existingId, existing] of this.registrations) {
              if (isSupersededRegistration(existing, restored)) {
                this.registrations.delete(existingId);
              }
            }
            this.registrations.set(parsed.data.activityId, restored);
          }
        }
      }
    } catch { this.options.log("[live-activity] could not restore registrations"); }
    try {
      if (existsSync(this.pushToStartPath)) {
        const saved: unknown = JSON.parse(readFileSync(this.pushToStartPath, "utf8"));
        if (Array.isArray(saved)) for (const item of saved.slice(0, 16)) {
          const parsed = liveActivityPushToStartSchema.safeParse(item);
          if (parsed.success && parsed.data.expiresAt > Date.now() && parsed.data.serviceUrl === this.serviceUrl) {
            const key = this.pushToStartKey(parsed.data);
            const seq = (item as { sequence?: unknown }).sequence;
            const lastSent = (item as { lastPushToStartAt?: unknown }).lastPushToStartAt;
            this.pushToStart.set(key, {
              ...parsed.data,
              sequence: typeof seq === "number" && Number.isSafeInteger(seq) ? seq : 0,
              lastPushToStartAt: typeof lastSent === "number" && Number.isSafeInteger(lastSent) && lastSent > 0 ? lastSent : undefined,
            });
          }
        }
      }
    } catch { this.options.log("[live-activity] could not restore push-to-start registrations"); }
    for (const session of this.options.hub.listSessions({ limit: 200 }).sessions) this.sessions.set(session.id, session);
    for (const terminal of this.options.terminals.list()) this.terminals.set(terminal.id, terminal);
    this.stopListeners.push(this.options.hub.onSummary((session) => this.sessionChanged(session)),
      this.options.hub.onRemoved((sessionId) => this.sessionRemoved(sessionId)),
      this.options.terminals.onChange((terminal, closed) => this.terminalChanged(terminal, closed)));
    this.heartbeat = setInterval(() => {
      if (this.stopped) return;
      if (this.pushToStart.size && !this.registrations.size && !this.hasPendingPushToStart()) {
        this.reconcileWatches(this.options.hub.listSessions({ limit: 200 }).sessions);
      }
      this.schedule();
    }, 60_000);
    this.heartbeat.unref();
    if (this.pushToStart.size && !this.registrations.size) {
      this.reconcileWatches(this.options.hub.listSessions({ limit: 200 }).sessions);
    }
    this.schedule(0);
  }

  subscribe(subscription: LiveActivitySubscription) {
    const data = liveActivitySubscriptionSchema.parse(subscription);
    if (data.serviceUrl !== this.serviceUrl) throw RpcError.app("invalid_params", "实时活动服务地址与电脑配置不一致");
    if (data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 8 * 60 * 60 * 1000) throw RpcError.app("invalid_params", "实时活动授权已过期");
    const superseded: Registration[] = [];
    for (const row of this.registrations.values()) {
      if (isSupersededRegistration(row, data)) superseded.push(row);
    }
    const nextSize = this.registrations.size - superseded.length + (this.registrations.has(data.activityId) ? 0 : 1);
    if (nextSize > 16) throw RpcError.app("busy", "实时活动数量已达上限");
    for (const old of superseded) {
      this.registrations.delete(old.activityId);
      this.options.log(`[live-activity] retiring superseded ${old.activityId} (replaced by ${data.activityId})`);
      void this.retireSuperseded(old);
    }
    const previous = this.registrations.get(data.activityId);
    // Clear lastPayloadHash on (re)subscribe so foreground resume always pushes one fresh reconciliation snapshot.
    this.registrations.set(data.activityId, { ...previous, ...data, sequence: previous?.sequence ?? 0, lastPayloadHash: undefined });
    if (!previous) this.options.log(`[live-activity] registered ${data.activityId}`);
    for (const row of this.pushToStart.values()) {
      if (row.computerKey === data.computerKey && (!data.deviceId || row.deviceId === data.deviceId)) {
        row.pendingStart = undefined;
      }
    }
    this.save();
    this.schedule(0);
  }

  private async retireSuperseded(old: Registration) {
    if (this.stopped || old.expiresAt <= Date.now()) return;
    const sequence = Math.max(Date.now(), old.sequence + 1);
    const contentState = liveActivityContent({
      active: false,
      computerName: this.resolveComputerName(),
      computerKey: old.computerKey,
      phase: "completed",
      title: "任务已更新",
      subtitle: "已在最新实时活动中继续显示",
      deepLink: `linkshell:///activity?computer=${encodeURIComponent(old.computerKey)}`,
    });
    try {
      const response = await this.request()(`${this.serviceUrl}/v1/activities/${old.activityId}/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${old.grant}`, "content-type": "application/json" },
        body: JSON.stringify({ sequence, event: "end", contentState, notice: null }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok && response.status !== 410 && !this.stopped) {
        await this.request()(`${this.serviceUrl}/v1/activities/${old.activityId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${old.grant}` },
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
          redirect: "error",
        });
      }
    } catch { /* Best-effort cleanup of superseded activity grant. */ }
  }

  registerPushToStart(registration: LiveActivityPushToStart): { ok: true } {
    const data = liveActivityPushToStartSchema.parse(registration);
    if (data.serviceUrl !== this.serviceUrl) throw RpcError.app("invalid_params", "实时活动服务地址与电脑配置不一致");
    if (data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      throw RpcError.app("invalid_params", "实时活动授权已过期");
    }
    const key = this.pushToStartKey(data);
    if (!this.pushToStart.has(key) && this.pushToStart.size >= 16) throw RpcError.app("busy", "实时活动数量已达上限");
    const previous = this.pushToStart.get(key);
    this.pushToStart.set(key, {
      ...previous,
      ...data,
      sequence: previous?.sequence ?? 0,
      failures: 0,
      retryAfter: 0,
    });
    if (!previous) this.options.log(`[live-activity] registered push-to-start ${data.platform}:${data.deviceId}`);
    this.savePushToStart();
    if (!this.stopped) this.reconcileWatches(this.options.hub.listSessions({ limit: 200 }).sessions);
    return { ok: true };
  }

  async unsubscribe(activityId: string) {
    const registration = this.registrations.get(activityId);
    this.registrations.delete(activityId);
    if (registration) {
      this.options.log(`[live-activity] revoked by device ${activityId}`);
      this.resetPushToStartCooldown(registration.computerKey, registration.deviceId);
    }
    this.save();
    if (!this.registrations.size && !this.pushToStart.size) this.reconcileWatches([]);
    if (!registration) return;
    try {
      await this.request()(`${this.serviceUrl}/v1/activities/${activityId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${registration.grant}` },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]), redirect: "error",
      });
    } catch { /* The native activity already ended; the server also bounds every grant's lifetime. */ }
  }

  private request() { return this.options.request ?? fetch; }
  private sessionChanged(session: SessionSummary) {
    const before = this.sessions.get(session.id);
    this.sessions.set(session.id, session);
    const request = (value: SessionSummary) => [value.permission?.requestId, ...(value.asyncQuestions ?? []).map((question) => question.id)].filter(Boolean).join(":");
    let immediate = false;
    let routineRunning = false;
    if (!session.archived) {
      const task = liveActivitySessionTask(session);
      const beforePhase = before ? liveActivitySessionTask(before).phase : undefined;
      const attention = needsAttention(session) || session.state === "error";
      const wasAttention = !!before && (needsAttention(before) || before.state === "error");
      const attentionCleared = wasAttention && !attention;
      const attentionTransition = attention && (!before || beforePhase !== task.phase || request(before) !== request(session));
      const completedTransition = session.state === "idle" && !!before && (before.state === "running" || needsAttention(before));
      routineRunning = !attention && !wasAttention && !completedTransition && before?.state === "running" && session.state === "running";

      if (this.registrations.size) {
        // Discovery can replay existing work after a restart. Alert on a transition
        // we observed, not on a historical question being discovered for the first time.
        if (attention && before && (beforePhase !== task.phase || request(before) !== request(session))) {
          this.enqueue(task, request(session) || String(session.updatedAt));
          immediate = true;
        } else if (completedTransition) {
          this.enqueue(task, String(session.updatedAt));
          immediate = true;
        } else {
          this.removeOutdatedNotices(task);
          // Answering a question or resolving an approval on the computer must clear the lock-screen
          // waiting prompt immediately rather than lingering behind a routine coalesce timer.
          if (attentionCleared) immediate = true;
        }
      }

      let wakeupEventType: WakeupEventType | undefined;
      if (attentionTransition) {
        wakeupEventType = task.phase === "waiting_for_approval"
          ? "approval"
          : task.phase === "waiting_for_input"
            ? "question"
            : "error";
      } else if (completedTransition) {
        wakeupEventType = "completed";
      }

      const now = Date.now();
      const wakeup: WakeupNotice | undefined = wakeupEventType
        ? wakeupNoticeSchema.parse({
            machineId: this.options.machineId?.() || "local",
            sessionId: session.id,
            eventType: wakeupEventType,
            createdAt: now,
          })
        : undefined;
      if (wakeup) {
        try {
          this.options.onWakeup?.(wakeup);
        } catch {
          this.options.log("[live-activity] wakeup listener failed");
        }
      }

      // Push-to-start wakes idle devices ONLY for actionable/urgent transitions (waiting or error),
      // never for routine running/starting turns, and respects per-(device, computerKey) cooldown.
      if (this.pushToStart.size && attentionTransition) {
        let queued = false;
        for (const row of this.pushToStart.values()) {
          if (row.expiresAt <= now) continue;
          if (this.hasForegroundFor(row.computerKey, row.deviceId, now)) continue;
          if (this.isPushToStartCoolingDown(row, now)) continue;
          row.pendingStart = {
            sessionId: session.id,
            phase: task.phase,
            wakeup,
            createdAt: now,
          };
          queued = true;
        }
        if (queued) immediate = true;
      } else if (this.pushToStart.size && attentionCleared) {
        for (const row of this.pushToStart.values()) {
          if (row.pendingStart?.sessionId === session.id) row.pendingStart = undefined;
        }
      }
    } else {
      for (const row of this.registrations.values()) row.notices = row.notices?.filter((notice) => notice.task.kind !== "session" || notice.task.id !== session.id);
      for (const row of this.pushToStart.values()) {
        if (row.pendingStart?.sessionId === session.id) row.pendingStart = undefined;
      }
      if (before && (needsAttention(before) || before.state === "running" || before.state === "error")) immediate = true;
    }
    // Keep desktop sessions subscribed for push-to-start-only hosts so waiting/answer transitions
    // are observed in real time rather than waiting for the 30s catalog refresh.
    if (this.pushToStart.size && !this.registrations.size && !this.hasPendingPushToStart()) {
      const stateChanged = !before || before.state !== session.state || before.archived !== session.archived || needsAttention(before) !== needsAttention(session);
      if (stateChanged) this.reconcileWatches(this.options.hub.listSessions({ limit: 200 }).sessions);
    }
    this.schedule(immediate ? 0 : routineRunning ? ROUTINE_COALESCE_MS : DEFAULT_SCHEDULE_MS);
  }
  private sessionRemoved(sessionId: string) {
    this.sessions.delete(sessionId);
    const subscriber = this.watched.get(sessionId);
    if (subscriber) {
      this.options.hub.unsubscribe(sessionId, subscriber);
      this.watched.delete(sessionId);
    }
    for (const row of this.registrations.values()) row.notices = row.notices?.filter((notice) => notice.task.kind !== "session" || notice.task.id !== sessionId);
    for (const row of this.pushToStart.values()) {
      if (row.pendingStart?.sessionId === sessionId) row.pendingStart = undefined;
    }
    if (this.registrations.size) this.save();
    this.schedule(0);
  }
  private terminalChanged(terminal: TerminalInfo, closed = false) {
    const before = this.terminals.get(terminal.id);
    if (closed) this.terminals.delete(terminal.id); else this.terminals.set(terminal.id, terminal);
    const task = liveActivityTerminalTask(terminal);
    if (!closed && !terminal.interrupted && before && terminalState(before).busy && !terminalState(terminal).busy) {
      this.enqueue(task, String(terminal.activeAt));
    } else if (closed) {
      for (const row of this.registrations.values()) row.notices = row.notices?.filter((notice) => notice.task.kind !== "terminal" || notice.task.id !== terminal.id);
    } else this.removeOutdatedNotices(task);
    this.schedule();
  }
  private removeOutdatedNotices(task: LiveActivityTask) {
    for (const row of this.registrations.values()) row.notices = row.notices?.filter((notice) =>
      notice.task.id !== task.id || notice.task.kind !== task.kind || notice.task.phase === task.phase);
  }
  private enqueue(task: LiveActivityTask, transition: string) {
    const notice: LiveActivityNotice = {
      id: createHash("sha256").update(JSON.stringify([task.kind, task.id, task.phase, transition])).digest("hex"),
      createdAt: Date.now(), task: { ...task, title: task.title.slice(0, 160), subtitle: task.subtitle.slice(0, 360), project: task.project.slice(0, 160) },
    };
    for (const row of this.registrations.values()) {
      if (row.lastNoticeId !== notice.id) row.notices = [...(row.notices ?? []).filter((item) => item.task.id !== task.id || item.task.kind !== task.kind), notice].slice(-8);
    }
    if (this.registrations.size) this.save();
    this.schedule(0);
  }
  private save() {
    const temporary = `${this.options.path}.tmp`;
    const entries = [...this.registrations.values()].map(({ retryAfter: _retry, failures: _failures, lastPayloadHash: _hash, ...entry }) => entry);
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.options.path);
  }
  private savePushToStart() {
    const temporary = `${this.pushToStartPath}.tmp`;
    const entries = [...this.pushToStart.values()].map(({ retryAfter: _retry, failures: _failures, pendingStart: _pending, ...entry }) => entry);
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.pushToStartPath);
  }
  private schedule(delay = 5000) {
    if (this.stopped || (!this.registrations.size && !this.hasPendingPushToStart())) return;
    const at = Date.now() + delay;
    if (this.timer && this.scheduledAt <= at) return;
    clearTimeout(this.timer);
    this.scheduledAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => this.options.log("[live-activity] update failed"));
    }, delay);
    this.timer.unref();
  }
  private reconcileWatches(sessions: SessionSummary[]) {
    const hasWatchers = this.registrations.size > 0 || this.pushToStart.size > 0;
    const wanted = new Set(hasWatchers ? sessions.filter((session) => !session.archived && (session.state === "running" || needsAttention(session))).map((session) => session.id) : []);
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
      const now = Date.now();
      for (const [id, row] of this.registrations) if (row.expiresAt <= now) {
        this.registrations.delete(id);
        this.options.log(`[live-activity] authorization expired ${id}`);
      }
      let pushToStartChanged = false;
      for (const [key, row] of this.pushToStart) if (row.expiresAt <= now) {
        this.pushToStart.delete(key);
        pushToStartChanged = true;
        this.options.log(`[live-activity] push-to-start authorization expired ${key}`);
      }
      const sessions = this.options.hub.listSessions({ limit: 200 }).sessions;
      this.reconcileWatches(sessions);
      const terminals = this.options.terminals.list();
      const computerName = this.resolveComputerName();
      const sends = [...this.registrations.values()].filter((row) => (row.retryAfter ?? 0) <= Date.now()).map(async (row) => {
        const payload = buildLiveActivitySnapshot(computerName, sessions, terminals, true, row.computerKey);
        row.notices = row.notices?.filter((notice) => {
          if (Date.now() - notice.createdAt >= 180_000) return false;
          // Discovery may reconcile removed or stale sessions before this relay starts.
          if (notice.task.kind === "session") {
            const session = sessions.find((session) => session.id === notice.task.id);
            return session && !session.archived && liveActivitySessionTask(session).phase === notice.task.phase;
          }
          const terminal = terminals.find((terminal) => terminal.id === notice.task.id);
          return terminal && liveActivityTerminalTask(terminal).phase === notice.task.phase;
        });
        const notice = row.notices?.[0];
        const selected = notice?.task.kind === "session" ? sessions.find((session) => session.id === notice.task.id) : undefined;
        const buttons = selected ? liveActivityActions(selected, row.computerKey) : { actions: [], hasMoreActions: false };
        const event = payload.active || (row.notices?.length ?? 0) > 1 ? "update" : "end";
        const contentState = liveActivityContent(notice ? {
          ...payload, ...notice.task, ...buttons, noticeId: notice.id,
          deepLink: liveActivityDetailLink(row.computerKey, notice.task.kind, notice.task.id),
          tasks: [notice.task, ...(payload.tasks ?? []).filter((task) => task.id !== notice.task.id || task.kind !== notice.task.kind)],
        } : payload.active ? { ...payload, noticeId: row.lastNoticeId }
          : { ...payload, phase: "completed", title: "任务已结束", subtitle: "打开 App 查看结果", noticeId: row.lastNoticeId });
        const payloadHash = createHash("sha256")
          .update(JSON.stringify({ event, contentState, hasNotice: Boolean(notice), noticeId: notice?.id ?? null }))
          .digest("hex");
        if (event === "update" && !notice && row.lastPayloadHash === payloadHash) {
          return;
        }
        row.sequence = Math.max(Date.now(), row.sequence + 1);
        try {
          const response = await this.request()(`${this.serviceUrl}/v1/activities/${row.activityId}/events`, {
            method: "POST", headers: { Authorization: `Bearer ${row.grant}`, "content-type": "application/json" },
            body: JSON.stringify({ sequence: row.sequence, event, contentState, notice: notice ?? null }),
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]), redirect: "error",
          });
          if (this.registrations.get(row.activityId) !== row || this.stopped) return;
          // A rejected payload or a proxy's 400 is not a revoked ActivityKit
          // token. Keep the grant so the next snapshot can recover unattended.
          if (response.status === 410 || (response.ok && event === "end")) {
            this.registrations.delete(row.activityId);
            this.resetPushToStartCooldown(row.computerKey, row.deviceId);
            this.options.log(`[live-activity] retired ${row.activityId}: ${response.status === 410 ? "registration expired" : "completed"}`);
          } else if (response.ok) {
            row.failures = 0; row.retryAfter = 0;
            row.lastPayloadHash = payloadHash;
            if (notice) {
              row.notices = row.notices?.filter((item) => item.id !== notice.id);
              row.lastNoticeId = notice.id;
            }
          } else if (response.status === 429) {
            const retryAfterSec = Number(response.headers?.get?.("retry-after"));
            const retryDelayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(15_000, Math.ceil(retryAfterSec * 1000) + 150)
              : 1500;
            row.retryAfter = Date.now() + retryDelayMs;
            this.options.log(`[live-activity] coalesced HTTP 429 for ${row.activityId}; retrying in ${retryDelayMs}ms`);
            this.schedule(retryDelayMs);
          } else {
            this.options.log(`[live-activity] delivery HTTP ${response.status} for ${row.activityId}; retaining registration`);
            throw new Error("delivery unavailable");
          }
        } catch {
          if (this.registrations.get(row.activityId) !== row || this.stopped) return;
          row.failures = Math.min((row.failures ?? 0) + 1, 5);
          row.retryAfter = Date.now() + Math.min(60_000, 5000 * 2 ** (row.failures - 1));
          this.schedule();
        }
      });

      const startSends = [...this.pushToStart.entries()]
        .filter(([, row]) => Boolean(row.pendingStart) && (row.retryAfter ?? 0) <= Date.now())
        .map(async ([key, row]) => {
          const pending = row.pendingStart;
          if (!pending) return;
          const sendNow = Date.now();
          if (this.hasForegroundFor(row.computerKey, row.deviceId, sendNow) || this.isPushToStartCoolingDown(row, sendNow)) {
            row.pendingStart = undefined;
            return;
          }
          const wakeup: WakeupNotice = pending.wakeup ?? {
            machineId: this.options.machineId?.() || "local",
            sessionId: pending.sessionId,
            eventType: pending.phase === "waiting_for_approval"
              ? "approval"
              : pending.phase === "waiting_for_input"
                ? "question"
                : pending.phase === "failed"
                  ? "error"
                  : "completed",
            createdAt: pending.createdAt,
          };
          row.sequence = Math.max(Date.now(), row.sequence + 1);
          pushToStartChanged = true;
          try {
            const response = await this.request()(`${this.serviceUrl}/v1/activities/start`, {
              method: "POST",
              headers: { Authorization: `Bearer ${row.grant}`, "content-type": "application/json" },
              body: JSON.stringify({
                sequence: row.sequence,
                deviceId: row.deviceId,
                platform: row.platform,
                pushToStartToken: row.pushToStartToken,
                computerKey: row.computerKey,
                computerName,
                phase: pending.phase,
                wakeup,
              }),
              signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
              redirect: "error",
            });
            if (this.pushToStart.get(key) !== row || this.stopped) return;
            if (response.status === 410) {
              this.pushToStart.delete(key);
              this.options.log(`[live-activity] retired push-to-start ${key}: registration expired`);
            } else if (response.ok) {
              row.failures = 0;
              row.retryAfter = 0;
              row.lastPushToStartAt = Date.now();
              if (row.pendingStart === pending) row.pendingStart = undefined;
            } else {
              this.options.log(`[live-activity] push-to-start HTTP ${response.status} for ${key}; retaining registration`);
              throw new Error("push-to-start delivery unavailable");
            }
          } catch {
            if (this.pushToStart.get(key) !== row || this.stopped) return;
            row.failures = Math.min((row.failures ?? 0) + 1, 5);
            row.retryAfter = Date.now() + Math.min(60_000, 5000 * 2 ** (row.failures - 1));
            this.schedule();
          }
        });

      if (this.registrations.size || existsSync(this.options.path)) this.save();
      if (pushToStartChanged) this.savePushToStart();
      await Promise.allSettled([...sends, ...startSends]);
      if (!this.stopped) {
        if (this.registrations.size || existsSync(this.options.path)) this.save();
        if (pushToStartChanged) this.savePushToStart();
        if (!this.registrations.size && !this.pushToStart.size) this.reconcileWatches([]);
        if ([...this.registrations.values()].some((row) => row.notices?.length)) this.schedule(1000);
        else if (
          [...this.registrations.values()].some((row) => row.retryAfter) ||
          [...this.pushToStart.values()].some((row) => row.retryAfter && row.pendingStart)
        ) {
          this.schedule();
        }
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
