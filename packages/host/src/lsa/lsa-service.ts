import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RpcError,
  type ContentBlock,
  type LsaCandidateProject,
  type LsaFollowup as WireLsaFollowup,
  type LsaMemory as WireLsaMemory,
  type LsaStatus,
  type LsaTask as WireLsaTask,
  type MethodParams,
  type MethodResult,
  type SessionEvent,
  type lsaMethods,
} from "@linkshell/wire";
import type { SessionHub, Subscriber } from "../hub.js";
import { createHubLsaAdapter, normalizeGitRemote } from "./hub-adapter.js";
import { LsaStore } from "./lsa-store.js";
import {
  LSA_DEFAULT_MAX_RETRIES,
  LSA_ENTITLEMENT_METADATA,
  LSA_ROTATION_TOKEN_CAP,
  LSA_ROTATION_WINDOW_RATIO,
  LSA_STEWARD_TOOLS,
  normalizeAcceptanceChecks,
  type LsaAcceptanceCheck,
  type LsaDecideInput,
  type LsaDispatchInput,
  type LsaEntitlementCheckContext,
  type LsaEntitlementDecision,
  type LsaEntitlementGate,
  type LsaFollowup,
  type LsaGeneration,
  type LsaHandoffPayload,
  type LsaHostAdapter,
  type LsaInspectResult,
  type LsaMemory,
  type LsaProjectCandidate,
  type LsaRotationReason,
  type LsaRotationResult,
  type LsaSteerInput,
  type LsaStewardMode,
  type LsaTask,
  type LsaTaskStatus,
  type LsaTurnEndedContext,
  type LsaVerificationOutcome,
} from "./types.js";

const LOCAL_CHANNELS = new Set(["linkshell", "local", "cli", "app", "web", "desktop"]);

function summarizeGoalTitle(goal: string): string {
  const firstLine = goal.split(/\r?\n/)[0]?.trim() ?? goal.trim();
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 71)}…`;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function buildDispatchBriefing(
  goal: string,
  checks: readonly LsaAcceptanceCheck[],
  controllerEpoch: number,
): ContentBlock[] {
  const lines: string[] = [
    `[LSA Steward Task · Epoch ${controllerEpoch}]`,
    goal.trim(),
  ];
  if (checks.length > 0) {
    lines.push("", "Acceptance Checks:");
    for (const [idx, check] of checks.entries()) {
      lines.push(`${idx + 1}. ${check.label} (${check.raw})`);
    }
  }
  lines.push(
    "",
    "When finished, summarize what changed, how each acceptance check was verified, and any remaining risks.",
  );
  return [{ type: "text", text: lines.join("\n") }];
}

function buildAutoRetryPrompt(
  task: LsaTask,
  failedChecks: readonly LsaAcceptanceCheck[],
  attempt: number,
): ContentBlock[] {
  const lines: string[] = [
    `[LSA Automated Acceptance Verification · Retry ${attempt}/${task.maxRetries}]`,
    "One or more acceptance checks did not pass after your turn:",
    ...failedChecks.map(
      (check, i) =>
        `${i + 1}. ${check.label} (${check.raw}) — ${check.evidence ?? "check failed"}`,
    ),
    "",
    "Please fix the failing checks and verify before finishing your next turn.",
  ];
  return [{ type: "text", text: lines.join("\n") }];
}

function toWireTask(task: LsaTask): WireLsaTask {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    cwd: task.cwd,
    worktree: task.worktree,
    agent: task.agent,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    controllerEpoch: task.controllerEpoch,
    acceptanceChecks: task.acceptanceChecks,
    ...(task.verificationSummary !== undefined ? { summary: task.verificationSummary } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toWireMemory(memory: LsaMemory): WireLsaMemory {
  return {
    id: memory.id,
    scope: memory.scope,
    key: memory.key,
    content: memory.content,
    tags: memory.tags,
    updatedAt: memory.updatedAt,
  };
}

function toWireFollowup(followup: LsaFollowup): WireLsaFollowup {
  return {
    id: followup.id,
    ...(followup.taskId ? { taskId: followup.taskId } : {}),
    dueAt: followup.dueAt,
    note: followup.note,
    done: followup.done,
    ...(followup.triggeredAt !== undefined ? { triggeredAt: followup.triggeredAt } : {}),
  };
}

function extractSessionTurnInfo(events: readonly SessionEvent[]): {
  stopReason?: string;
  errorMessage?: string;
  finalMessage?: string;
  exitCode?: number;
  usedTokens?: number;
  contextWindow?: number;
} {
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let exitCode: number | undefined;
  let usedTokens: number | undefined;
  let contextWindow: number | undefined;
  let streamedBuffer = "";
  let lastExplicitAgentMessage: string | undefined;

  for (const event of events) {
    const u = event.update;
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        streamedBuffer = "";
        break;
      case "ls_message":
        if (u.role === "user" && !u.parentToolCallId) {
          streamedBuffer = "";
        } else if (u.role === "agent" && !u.parentToolCallId) {
          const text = (u.content ?? [])
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n")
            .trim();
          if (text) lastExplicitAgentMessage = text;
        }
        break;
      case "agent_message_chunk":
        if (!u.parentToolCallId && u.content.type === "text") {
          streamedBuffer += u.content.text;
        }
        break;
      case "ls_turn":
        if (!u.parentToolCallId && u.state === "ended") {
          stopReason = u.stopReason;
        }
        break;
      case "ls_error":
        errorMessage = u.message;
        break;
      case "tool_call":
      case "tool_call_update": {
        const rawOut = (u as { rawOutput?: unknown }).rawOutput as
          | { exitCode?: unknown }
          | undefined;
        if (typeof rawOut?.exitCode === "number") {
          exitCode = rawOut.exitCode;
        }
        break;
      }
      case "usage_update":
        if (typeof u.usedTokens === "number") {
          usedTokens = u.usedTokens;
        } else if (typeof u.tokens?.totalTokens === "number") {
          usedTokens = u.tokens.totalTokens;
        }
        if (typeof u.contextWindow === "number") {
          contextWindow = u.contextWindow;
        }
        break;
      default:
        break;
    }
  }

  const finalMessage = lastExplicitAgentMessage ?? (streamedBuffer.trim() || undefined);
  return {
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(finalMessage !== undefined ? { finalMessage } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

export type LsaRpcHandlers = {
  [M in keyof typeof lsaMethods]: (
    params: MethodParams<M>,
  ) => Promise<MethodResult<M>> | MethodResult<M>;
};

export interface CreateLsaServiceOptions {
  /** `<linkshellHome>` directory; opens `<linkshellHome>/lsa.db` when `dbPath` and `store` are omitted. */
  home?: string;
  /** Direct SQLite file path or `":memory:"`. */
  dbPath?: string;
  /** Pre-constructed `LsaStore` instance. */
  store?: LsaStore;
  /** Narrow host adapter (ideal for deterministic unit tests without real LLMs). */
  adapter?: LsaHostAdapter;
  /** Production `SessionHub` (used to build default `LsaHostAdapter` and observe dispatched sessions). */
  hub?: SessionHub;
  /** Local machine ID supplier for multi-machine entitlement gating. */
  machineId?: () => string;
  /** Default agent ID when `workDispatch` omits `agent` (default: `"codex"`). */
  defaultAgent?: string;
  /** Initial monotonic `controllerEpoch` (default: 1). */
  initialEpoch?: number;
  /** Optional Yearly-tier entitlement gate callback per Optimization Roadmap §4.3. */
  entitlementGate?: LsaEntitlementGate;
  /** Auto-prompt bounded retry when objective post-turn acceptance checks fail (default: true). */
  autoSteerRetry?: boolean;
  /** Default max auto-steer retries per task (default: 2). */
  defaultMaxRetries?: number;
  /** Background followup poll interval in ms (`0` disables background timer; default: 0). */
  followupPollIntervalMs?: number;
  /** Listener invoked when due followups trigger. */
  onFollowupDue?: (followups: LsaFollowup[]) => void;
  /** Automatically subscribe to `hub` events for LSA-dispatched sessions (default: true when `hub` is passed). */
  autoObserveHubSessions?: boolean;
  /** Deterministic clock override for tests. */
  now?: () => number;
  /** Diagnostic logger. */
  log?: (message: string) => void;
}

/**
 * LinkShell Agent (LSA) Phase 1 Steward Service.
 *
 * Implements the 8-capability surface from `linkshell-agent-architecture.md` backed by
 * `<linkshellHome>/lsa.db` (`LsaStore`), monotonic `controllerEpoch` fencing, automated
 * post-turn acceptance verification, 70% / 160k safe-point generation rotation, FTS5/keyword
 * memories, due followups, and Yearly-tier entitlement gating.
 */
export class LsaService {
  readonly requiresYearlyTier = LSA_ENTITLEMENT_METADATA.requiresYearlyTier;
  readonly capabilityMetadata = {
    ...LSA_ENTITLEMENT_METADATA,
    tools: LSA_STEWARD_TOOLS,
    rotationTokenCap: LSA_ROTATION_TOKEN_CAP,
    rotationWindowRatio: LSA_ROTATION_WINDOW_RATIO,
  } as const;

  readonly store: LsaStore;
  private readonly ownsStore: boolean;
  private readonly adapter: LsaHostAdapter;
  private readonly hub?: SessionHub;
  private readonly defaultAgent: string;
  private readonly entitlementGate?: LsaEntitlementGate;
  private readonly autoSteerRetry: boolean;
  private readonly defaultMaxRetries: number;
  private readonly autoObserveHubSessions: boolean;
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  private readonly followupListeners = new Set<(followups: LsaFollowup[]) => void>();
  private readonly observedSessions = new Map<string, () => void>();
  private readonly verifyingSessions = new Set<string>();
  private stewardBusy = false;
  private followupTimer?: ReturnType<typeof setInterval>;

  constructor(options: CreateLsaServiceOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.ownsStore = !options.store;
    this.store =
      options.store ??
      new LsaStore({
        dbPath: options.dbPath,
        home: options.home,
        initialEpoch: options.initialEpoch ?? 1,
        now: this.clock,
      });
    this.hub = options.hub;
    this.adapter =
      options.adapter ??
      (options.hub
        ? createHubLsaAdapter(options.hub, { machineId: options.machineId })
        : { machineId: options.machineId });
    this.defaultAgent = options.defaultAgent ?? "codex";
    this.entitlementGate = options.entitlementGate;
    this.autoSteerRetry = options.autoSteerRetry ?? true;
    this.defaultMaxRetries = options.defaultMaxRetries ?? LSA_DEFAULT_MAX_RETRIES;
    this.autoObserveHubSessions = options.autoObserveHubSessions ?? Boolean(options.hub);

    if (options.onFollowupDue) {
      this.followupListeners.add(options.onFollowupDue);
    }
    if (options.followupPollIntervalMs && options.followupPollIntervalMs > 0) {
      this.startFollowupTimer(options.followupPollIntervalMs);
    }
    if (this.autoObserveHubSessions && this.hub) {
      for (const task of this.store.listActiveTasks()) {
        if (task.sessionId) {
          this.observeHubSessionIfNeeded(task.sessionId);
        }
      }
    }
  }

  // ── Lifecycle & Epoch Controls ────────────────────────────────────

  getControllerEpoch(): number {
    return this.store.getControllerEpoch();
  }

  /**
   * Monotonically advances the controller epoch (refusing any lower epoch).
   * Used when a new steward controller takes over, immediately fencing stale epochs.
   */
  advanceControllerEpoch(nextEpoch?: number): number {
    return this.store.advanceControllerEpoch(nextEpoch);
  }

  /**
   * Marks a session as externally hijacked (e.g. desktop terminal takeover),
   * preventing stale or automated LSA turns from mutating it.
   */
  markSessionHijacked(sessionId: string, hijacked = true): void {
    this.store.markSessionHijacked(sessionId, hijacked);
  }

  setStewardBusy(busy: boolean): void {
    this.stewardBusy = busy;
  }

  isStewardIdle(): boolean {
    return !this.stewardBusy && this.verifyingSessions.size === 0;
  }

  onFollowupDue(listener: (followups: LsaFollowup[]) => void): () => void {
    this.followupListeners.add(listener);
    return () => {
      this.followupListeners.delete(listener);
    };
  }

  startFollowupTimer(intervalMs = 5_000): void {
    this.stopFollowupTimer();
    this.followupTimer = setInterval(() => {
      try {
        this.pollDueFollowups();
      } catch (error) {
        this.log(
          `[lsa] followup timer error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, Math.max(100, intervalMs));
    this.followupTimer.unref?.();
  }

  stopFollowupTimer(): void {
    if (this.followupTimer) {
      clearInterval(this.followupTimer);
      this.followupTimer = undefined;
    }
  }

  close(): void {
    this.stopFollowupTimer();
    for (const unobserve of this.observedSessions.values()) {
      unobserve();
    }
    this.observedSessions.clear();
    if (this.ownsStore) {
      this.store.close();
    }
  }

  // ── Entitlement Helper & Gate (Roadmap §4.3) ──────────────────────

  entitlementMetadata() {
    return {
      ...LSA_ENTITLEMENT_METADATA,
      requiresYearlyTier: true as const,
    };
  }

  async checkEntitlement(
    context: LsaEntitlementCheckContext,
  ): Promise<LsaEntitlementDecision> {
    if (!this.entitlementGate) {
      return { allowed: true };
    }
    return await this.entitlementGate(context);
  }

  private async enforceEntitlement(input: {
    targetMachineId?: string;
    channel?: string;
  }): Promise<void> {
    const localMachineId = this.adapter.machineId?.();
    let mode: LsaStewardMode = "local";
    if (input.channel && !LOCAL_CHANNELS.has(input.channel.toLowerCase())) {
      mode = "channel";
    } else if (
      input.targetMachineId &&
      localMachineId &&
      input.targetMachineId !== localMachineId
    ) {
      mode = "multi_machine";
    } else if (input.targetMachineId && !localMachineId && input.targetMachineId !== "local") {
      mode = "multi_machine";
    }

    if (mode === "local" && !this.entitlementGate) return;
    const decision = await this.checkEntitlement({
      mode,
      targetMachineId: input.targetMachineId,
      channel: input.channel,
    });
    if (!decision.allowed) {
      throw RpcError.app(
        "membership_required",
        decision.reason ??
          "LSA 跨设备总管与外部渠道需要 iTool 年度会员（requiresYearlyTier）",
        {
          requiresYearlyTier: true,
          requiredTier: "yearly",
          mode,
          ...(decision.tier ? { currentTier: decision.tier } : {}),
        },
      );
    }
  }

  private async isSessionHijacked(task: LsaTask): Promise<boolean> {
    if (!task.sessionId) return false;
    const fence = this.store.getSessionFence(task.sessionId);
    if (fence?.hijacked) return true;
    if (fence && fence.controllerEpoch > task.controllerEpoch) return true;
    if (this.adapter.isSessionHijacked) {
      return Boolean(await this.adapter.isSessionHijacked(task.sessionId));
    }
    return false;
  }

  private async assertTaskControllable(
    task: LsaTask,
    callerEpoch?: number,
  ): Promise<void> {
    const activeEpoch = this.store.getControllerEpoch();
    if (callerEpoch !== undefined) {
      if (callerEpoch < activeEpoch || callerEpoch !== task.controllerEpoch) {
        throw RpcError.app(
          "fenced",
          `陈旧的主控代次（callerEpoch=${callerEpoch}, taskEpoch=${task.controllerEpoch}, activeEpoch=${activeEpoch}）无法修改任务`,
          {
            callerEpoch,
            taskEpoch: task.controllerEpoch,
            activeEpoch,
          },
        );
      }
    }
    if (task.controllerEpoch < activeEpoch) {
      throw RpcError.app(
        "fenced",
        `任务 ${task.id} 属于旧代次（epoch=${task.controllerEpoch} < 当前 ${activeEpoch}），拒绝跨代修改`,
        {
          taskEpoch: task.controllerEpoch,
          activeEpoch,
        },
      );
    }
    if (await this.isSessionHijacked(task)) {
      throw RpcError.app(
        "fenced",
        `会话 ${task.sessionId ?? ""} 已被接管（hijacked），拒绝 LSA 修改`,
        {
          taskId: task.id,
          sessionId: task.sessionId,
        },
      );
    }
  }

  // ── 1. Fleet Locate (`fleetLocate`) ───────────────────────────────

  /**
   * Ranks candidate project directories on the host by repository/directory name,
   * normalized git remote, and recent session activity.
   */
  async fleetLocate(
    query: string,
    options: { limit?: number } = {},
  ): Promise<LsaProjectCandidate[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const queryTokens = lowerQuery
      .split(/[\s/:@._-]+/)
      .map((tok) => tok.trim())
      .filter((tok) => tok.length >= 2);
    const now = this.clock();

    const [projects, sessions, searchedDirs] = await Promise.all([
      Promise.resolve(this.adapter.listProjects?.(100) ?? []),
      Promise.resolve(this.adapter.listSessions?.({ limit: 150 }) ?? []),
      trimmed && this.adapter.searchDirectories
        ? Promise.resolve(this.adapter.searchDirectories(trimmed, 40)).catch(() => [])
        : Promise.resolve([]),
    ]);

    const openTasks = this.store.listTasks({
      status: ["queued", "running", "verifying", "waiting_decision"],
      limit: 200,
    });

    interface RawEntry {
      cwd: string;
      name: string;
      sessionCount: number;
      lastActiveAt: number;
    }

    const byCwd = new Map<string, RawEntry>();
    const upsertCandidate = (
      cwd: string,
      name: string,
      sessionCount: number,
      lastActiveAt: number,
    ) => {
      const normalizedCwd = resolve(cwd);
      const prev = byCwd.get(normalizedCwd);
      if (!prev) {
        byCwd.set(normalizedCwd, {
          cwd: normalizedCwd,
          name: name || basename(normalizedCwd) || normalizedCwd,
          sessionCount,
          lastActiveAt,
        });
      } else {
        prev.sessionCount = Math.max(prev.sessionCount, sessionCount);
        prev.lastActiveAt = Math.max(prev.lastActiveAt, lastActiveAt);
      }
    };

    for (const proj of projects) {
      upsertCandidate(proj.cwd, proj.name, proj.sessionCount, proj.lastActiveAt);
    }

    const sessionStats = new Map<string, { count: number; lastAt: number }>();
    for (const session of sessions) {
      if (session.archived) continue;
      const baseCwd = resolve(session.worktree?.source ?? session.cwd);
      const stat = sessionStats.get(baseCwd) ?? { count: 0, lastAt: 0 };
      stat.count += 1;
      stat.lastAt = Math.max(stat.lastAt, session.updatedAt);
      sessionStats.set(baseCwd, stat);
    }
    for (const [cwd, stat] of sessionStats) {
      upsertCandidate(cwd, basename(cwd) || cwd, stat.count, stat.lastAt);
    }

    for (const entry of searchedDirs) {
      if (entry.file) continue;
      upsertCandidate(entry.path, entry.name, 0, 0);
    }

    const candidates: LsaProjectCandidate[] = [];
    const machineId = this.adapter.machineId?.();

    for (const entry of byCwd.values()) {
      const gitRaw = this.adapter.gitInfo
        ? await Promise.resolve(this.adapter.gitInfo(entry.cwd)).catch(() => undefined)
        : undefined;
      const normalizedRemote = normalizeGitRemote(gitRaw?.remote);
      const lowerName = entry.name.toLowerCase();
      const lowerCwd = entry.cwd.toLowerCase();
      const lowerRemote = normalizedRemote?.toLowerCase() ?? "";
      const remoteSlug = lowerRemote.split("/").pop() ?? "";

      let score = 0;
      const reasons: string[] = [];
      let matchedQuery = trimmed.length === 0;

      if (lowerQuery) {
        if (lowerName === lowerQuery) {
          score += 120;
          matchedQuery = true;
          reasons.push(`exact repo name "${entry.name}"`);
        } else if (lowerName.startsWith(lowerQuery)) {
          score += 85;
          matchedQuery = true;
          reasons.push(`repo name starts with "${trimmed}"`);
        } else if (lowerName.includes(lowerQuery) || lowerQuery.includes(lowerName)) {
          score += 60;
          matchedQuery = true;
          reasons.push(`repo name matches "${entry.name}"`);
        }

        if (lowerRemote) {
          if (lowerRemote === lowerQuery || remoteSlug === lowerQuery) {
            score += 110;
            matchedQuery = true;
            reasons.push(`git remote matches "${normalizedRemote}"`);
          } else if (lowerRemote.includes(lowerQuery) || (remoteSlug && lowerQuery.includes(remoteSlug))) {
            score += 70;
            matchedQuery = true;
            reasons.push(`git remote "${normalizedRemote}"`);
          }
        }

        let tokenHits = 0;
        for (const tok of queryTokens) {
          if (lowerName.includes(tok) || lowerRemote.includes(tok) || lowerCwd.includes(tok)) {
            tokenHits += 1;
          }
        }
        if (tokenHits > 0) {
          score += tokenHits * 20;
          matchedQuery = true;
          if (reasons.length === 0) {
            reasons.push(`matched ${tokenHits} query keyword(s)`);
          }
        }
      }

      if (!matchedQuery) continue;

      if (entry.sessionCount > 0) {
        const sessionBonus = Math.min(entry.sessionCount * 3, 18);
        score += sessionBonus;
        const ageMs = Math.max(0, now - entry.lastActiveAt);
        if (entry.lastActiveAt > 0) {
          if (ageMs <= 3_600_000) score += 35;
          else if (ageMs <= 86_400_000) score += 24;
          else if (ageMs <= 7 * 86_400_000) score += 12;
          else score += 5;
        }
        reasons.push(`${entry.sessionCount} recent session(s)`);
      }

      const activeTaskCount = openTasks.filter(
        (task) =>
          (task.status === "running" || task.status === "verifying") &&
          resolve(task.cwd) === entry.cwd,
      ).length;
      const recommendWorktree = activeTaskCount > 0 || Boolean(gitRaw?.dirty);
      if (recommendWorktree) {
        reasons.push(
          activeTaskCount > 0
            ? `${activeTaskCount} active task(s) — recommend worktree`
            : "dirty working tree — recommend worktree",
        );
      }

      candidates.push({
        cwd: entry.cwd,
        name: entry.name,
        score,
        ...(normalizedRemote ? { remote: normalizedRemote } : {}),
        reason: reasons.join("; "),
        reasons,
        ...(gitRaw
          ? {
              git: {
                root: gitRaw.root,
                ...(gitRaw.branch ? { branch: gitRaw.branch } : {}),
                ...(normalizedRemote ? { remote: normalizedRemote } : {}),
                dirty: gitRaw.dirty,
              },
            }
          : {}),
        sessionCount: entry.sessionCount,
        lastActiveAt: entry.lastActiveAt,
        activeTaskCount,
        recommendWorktree,
        ...(machineId ? { machineId } : {}),
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.lastActiveAt - a.lastActiveAt ||
        a.cwd.localeCompare(b.cwd),
    );
    return candidates.slice(0, limit);
  }

  // ── 2. Work Dispatch (`workDispatch`) ─────────────────────────────

  /**
   * Creates a deterministic ledger task stamped with monotonic `controllerEpoch`
   * and optionally launches a `SessionHub` session via `LsaHostAdapter`.
   */
  async workDispatch(input: LsaDispatchInput): Promise<LsaTask> {
    const goal = input.goal.trim();
    if (!goal) throw RpcError.app("invalid_params", "任务目标（goal）不能为空");

    await this.enforceEntitlement({
      targetMachineId: input.targetMachineId,
      channel: input.channel,
    });

    const controllerEpoch =
      input.controllerEpoch !== undefined
        ? this.store.advanceControllerEpoch(input.controllerEpoch)
        : this.store.getControllerEpoch();

    let cwd = input.cwd?.trim();
    let autoWorktree: boolean | undefined;
    if (!cwd) {
      const located = await this.fleetLocate(goal, { limit: 1 });
      if (located.length === 0) {
        throw RpcError.app(
          "not_found",
          "未能自动匹配到目标项目目录，请显式指定 cwd",
        );
      }
      cwd = located[0]!.cwd;
      autoWorktree = located[0]!.recommendWorktree;
    }

    const agent = input.agent?.trim() || this.defaultAgent;
    const worktree = input.worktree ?? autoWorktree ?? false;
    const checks = normalizeAcceptanceChecks(input.acceptanceChecks);
    const title = input.title?.trim() || summarizeGoalTitle(goal);
    const maxRetries =
      input.maxRetries !== undefined
        ? Math.max(0, Math.trunc(input.maxRetries))
        : this.defaultMaxRetries;

    let task = this.store.insertTask({
      title,
      goal,
      status: "queued",
      cwd,
      worktree,
      agent,
      controllerEpoch,
      acceptanceChecks: checks,
      maxRetries,
    });

    const shouldStart = input.startSession ?? Boolean(this.adapter.createSession);
    if (shouldStart && this.adapter.createSession) {
      try {
        const session = await this.adapter.createSession({
          agent,
          cwd,
          worktree,
          prompt: buildDispatchBriefing(goal, checks, controllerEpoch),
          clientMessageId: `lsa-dispatch-${task.id}`,
        });
        task = this.store.updateTask(task.id, {
          status: "running",
          sessionId: session.id,
          worktreePath: session.worktree ? session.cwd : null,
        });
        this.observeHubSessionIfNeeded(session.id);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.store.updateTask(task.id, {
          status: "failed",
          verificationSummary: `启动会话失败：${msg}`,
        });
        throw error;
      }
    }

    return task;
  }

  // ── 3. Work Inspect / Steer / Decide ──────────────────────────────

  async workInspect(taskId: string): Promise<LsaInspectResult> {
    const task = this.store.getTask(taskId);
    if (!task) throw RpcError.app("not_found", `找不到 LSA 任务：${taskId}`);
    const session =
      task.sessionId && this.adapter.getSession
        ? await Promise.resolve(this.adapter.getSession(task.sessionId))
        : undefined;
    const followups = this.store.listFollowups({ taskId: task.id, includeDone: true });
    const fenced = task.controllerEpoch < this.store.getControllerEpoch();
    const hijacked = await this.isSessionHijacked(task);
    return {
      task,
      ...(session ? { session } : {}),
      followups,
      fenced,
      hijacked,
    };
  }

  async workSteer(input: LsaSteerInput): Promise<LsaTask> {
    const instruction = input.instruction.trim();
    if (!instruction) throw RpcError.app("invalid_params", "追加指令（instruction）不能为空");

    const task = this.store.getTask(input.taskId);
    if (!task) throw RpcError.app("not_found", `找不到 LSA 任务：${input.taskId}`);
    await this.assertTaskControllable(task, input.controllerEpoch);

    if (task.status === "completed" || task.status === "cancelled") {
      throw RpcError.app(
        "conflict",
        `任务 ${task.id} 已处于终态（${task.status}），不能继续追加指令`,
      );
    }

    if (task.sessionId && this.adapter.promptSession) {
      await this.adapter.promptSession({
        sessionId: task.sessionId,
        clientMessageId: `lsa-steer-${task.id}-${randomUUID()}`,
        content: [{ type: "text", text: instruction }],
        whenBusy: input.whenBusy,
      });
      this.observeHubSessionIfNeeded(task.sessionId);
    }

    return this.store.updateTask(task.id, {
      status: task.sessionId ? "running" : task.status,
    });
  }

  async workDecide(input: LsaDecideInput): Promise<LsaTask> {
    const task = this.store.getTask(input.taskId);
    if (!task) throw RpcError.app("not_found", `找不到 LSA 任务：${input.taskId}`);
    await this.assertTaskControllable(task, input.controllerEpoch);

    const feedback = input.feedback?.trim();
    const now = this.clock();

    switch (input.decision) {
      case "accept": {
        const finalizedChecks = task.checks.map((check) =>
          check.passed
            ? check
            : {
                ...check,
                passed: true,
                evidence: check.evidence ?? (feedback ? `Accepted: ${feedback}` : "Accepted by decision"),
                checkedAt: now,
              },
        );
        const summary = feedback
          ? task.verificationSummary
            ? `${task.verificationSummary} | Decision: accepted (${feedback})`
            : `Accepted: ${feedback}`
          : (task.verificationSummary ?? "Accepted");
        this.unobserveHubSession(task.sessionId);
        return this.store.updateTask(task.id, {
          status: "completed",
          acceptanceChecks: finalizedChecks,
          verificationSummary: summary,
          updatedAt: now,
        });
      }

      case "retry": {
        const nextRetry = task.retryCount + 1;
        const failedLabels = task.checks
          .filter((c) => c.passed === false)
          .map((c) => `${c.label}${c.evidence ? ` (${c.evidence})` : ""}`);
        const retryMessage = [
          "[LSA Decision: Retry]",
          ...(feedback ? [feedback] : []),
          ...(failedLabels.length > 0
            ? ["Please address failed checks:", ...failedLabels.map((l) => `- ${l}`)]
            : ["Please retry and complete the task goal."]),
        ].join("\n");

        let sessionId = task.sessionId;
        let worktreePath = task.worktreePath;
        if (sessionId && this.adapter.promptSession) {
          await this.adapter.promptSession({
            sessionId,
            clientMessageId: `lsa-decide-retry-${task.id}-${nextRetry}-${randomUUID()}`,
            content: [{ type: "text", text: retryMessage }],
          });
          this.observeHubSessionIfNeeded(sessionId);
        } else if (!sessionId && this.adapter.createSession) {
          const session = await this.adapter.createSession({
            agent: task.agent,
            cwd: task.cwd,
            worktree: task.worktree,
            prompt: [{ type: "text", text: `${task.goal}\n\n${retryMessage}` }],
            clientMessageId: `lsa-decide-create-${task.id}-${nextRetry}`,
          });
          sessionId = session.id;
          worktreePath = session.worktree ? session.cwd : undefined;
          this.observeHubSessionIfNeeded(sessionId);
        }

        return this.store.updateTask(task.id, {
          status: sessionId ? "running" : "queued",
          ...(sessionId ? { sessionId } : {}),
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          retryCount: nextRetry,
          verificationSummary: feedback ? `Retrying: ${feedback}` : "Retrying task",
          updatedAt: now,
        });
      }

      case "cancel": {
        this.unobserveHubSession(task.sessionId);
        if (task.sessionId && this.adapter.cancelSession) {
          await this.adapter.cancelSession(task.sessionId).catch(() => {});
        }
        this.store.cancelFollowupsForTask(task.id);
        return this.store.updateTask(task.id, {
          status: "cancelled",
          verificationSummary: feedback ? `Cancelled: ${feedback}` : "Cancelled",
          updatedAt: now,
        });
      }
    }
  }

  // ── 4. Post-Turn Automated Acceptance Verifier ────────────────────

  /**
   * Evaluates a task's `acceptanceChecks` when its worker session finishes a turn.
   * Transitions the task to `completed`, triggers a bounded auto-steer retry, or
   * pauses in `waiting_decision` for human/steward judgment.
   */
  async onSessionTurnEnded(
    sessionId: string,
    context: LsaTurnEndedContext = {},
  ): Promise<LsaVerificationOutcome> {
    const task = this.store.findActiveTaskBySession(sessionId);
    if (!task || (task.status !== "running" && task.status !== "queued")) {
      return {
        task,
        passed: false,
        action: "no_task",
        checks: task?.checks ?? [],
        summary: "No active running LSA task for session",
      };
    }

    // Epoch isolation: never mutate or auto-steer a task/session from a stale epoch or hijacked session.
    if (
      task.controllerEpoch < this.store.getControllerEpoch() ||
      (await this.isSessionHijacked(task))
    ) {
      return {
        task,
        passed: false,
        action: "fenced",
        checks: task.checks,
        summary: "Verification skipped: stale controllerEpoch or hijacked session",
      };
    }

    this.verifyingSessions.add(sessionId);
    try {
      this.store.updateTask(task.id, { status: "verifying" });

      const events = this.adapter.readSessionEvents
        ? await Promise.resolve(this.adapter.readSessionEvents(sessionId, 0))
        : [];
      const extracted = extractSessionTurnInfo(events);

      const stopReason = context.stopReason ?? extracted.stopReason;
      const errorMessage = context.errorMessage ?? extracted.errorMessage;
      const finalMessage = context.finalMessage ?? extracted.finalMessage ?? "";
      const exitCode =
        context.exitCode ??
        extracted.exitCode ??
        (stopReason === "error" || Boolean(errorMessage) ? 1 : 0);
      const turnErrored = stopReason === "error" || Boolean(errorMessage);
      const effectiveCwd = task.worktreePath ?? task.cwd;
      const checkedAt = this.clock();

      const evaluatedChecks: LsaAcceptanceCheck[] = [];
      let hasSubjectivePending = false;

      for (const check of task.checks) {
        const result = await this.evaluateCheck(check, {
          cwd: effectiveCwd,
          exitCode,
          turnErrored,
          errorMessage,
          finalMessage,
          checkedAt,
        });
        if (result.subjectivePending) {
          hasSubjectivePending = true;
        }
        evaluatedChecks.push(result.check);
      }

      const failedObjective = evaluatedChecks.filter((c) => c.passed === false);
      const allChecksPassed =
        !turnErrored &&
        !hasSubjectivePending &&
        failedObjective.length === 0 &&
        (evaluatedChecks.length > 0 || exitCode === 0);

      if (allChecksPassed) {
        const summary =
          evaluatedChecks.length > 0
            ? `All ${evaluatedChecks.length} acceptance check(s) passed: ${evaluatedChecks
                .map((c) => `${c.label} [OK]`)
                .join("; ")}`
            : "Turn completed cleanly (exit code 0)";
        const updated = this.store.updateTask(task.id, {
          status: "completed",
          acceptanceChecks: evaluatedChecks,
          verificationSummary: summary,
          updatedAt: checkedAt,
        });
        this.unobserveHubSession(sessionId);

        const rotation =
          context.tokenCount !== undefined && context.contextLimit !== undefined
            ? this.checkRotation(context.tokenCount, context.contextLimit, { idle: true })
            : undefined;

        return {
          task: updated,
          passed: true,
          action: "completed",
          checks: evaluatedChecks,
          summary,
          ...(rotation ? { rotation } : {}),
        };
      }

      // Objective failure or turn error: auto-steer bounded retry when eligible.
      const hasObjectiveFailure = turnErrored || failedObjective.length > 0;
      if (
        hasObjectiveFailure &&
        this.autoSteerRetry &&
        task.retryCount < task.maxRetries &&
        task.sessionId &&
        this.adapter.promptSession
      ) {
        const nextAttempt = task.retryCount + 1;
        const syntheticFailures: LsaAcceptanceCheck[] =
          failedObjective.length > 0
            ? failedObjective
            : [
                {
                  id: "turn-error",
                  raw: "exit:0",
                  kind: "exit_code",
                  label: "Turn exit status",
                  passed: false,
                  evidence: errorMessage ?? `Turn failed (exitCode=${exitCode})`,
                  checkedAt,
                },
              ];
        const summary = `Auto-retry ${nextAttempt}/${task.maxRetries}: ${syntheticFailures
          .map((c) => `${c.label} (${c.evidence ?? "failed"})`)
          .join("; ")}`;

        const updated = this.store.updateTask(task.id, {
          status: "running",
          retryCount: nextAttempt,
          acceptanceChecks: evaluatedChecks,
          verificationSummary: summary,
          updatedAt: checkedAt,
        });

        await this.adapter.promptSession({
          sessionId: task.sessionId,
          clientMessageId: `lsa-autosteer-${task.id}-${nextAttempt}`,
          content: buildAutoRetryPrompt(updated, syntheticFailures, nextAttempt),
        });

        return {
          task: updated,
          passed: false,
          action: "auto_retried",
          checks: evaluatedChecks,
          summary,
        };
      }

      // Retries exhausted or subjective check awaiting human/steward decision.
      const reasons = [
        ...(turnErrored ? [errorMessage ?? "Session turn ended with error"] : []),
        ...failedObjective.map((c) => `${c.label}: ${c.evidence ?? "failed"}`),
        ...(hasSubjectivePending
          ? evaluatedChecks
              .filter((c) => c.passed === undefined)
              .map((c) => `${c.label}: awaiting review`)
          : []),
      ];
      const summary =
        reasons.length > 0
          ? `Waiting decision — ${reasons.join("; ")}`
          : "Waiting decision";

      const updated = this.store.updateTask(task.id, {
        status: "waiting_decision",
        acceptanceChecks: evaluatedChecks,
        verificationSummary: summary,
        updatedAt: checkedAt,
      });
      this.unobserveHubSession(sessionId);

      const rotation =
        context.tokenCount !== undefined && context.contextLimit !== undefined
          ? this.checkRotation(context.tokenCount, context.contextLimit, { idle: true })
          : undefined;

      return {
        task: updated,
        passed: false,
        action: "waiting_decision",
        checks: evaluatedChecks,
        summary,
        ...(rotation ? { rotation } : {}),
      };
    } finally {
      this.verifyingSessions.delete(sessionId);
    }
  }

  private async evaluateCheck(
    check: LsaAcceptanceCheck,
    env: {
      cwd: string;
      exitCode: number;
      turnErrored: boolean;
      errorMessage?: string;
      finalMessage: string;
      checkedAt: number;
    },
  ): Promise<{ check: LsaAcceptanceCheck; subjectivePending?: boolean }> {
    switch (check.kind) {
      case "exit_code": {
        const expected = check.expectedExitCode ?? 0;
        const passed = !env.turnErrored && env.exitCode === expected;
        return {
          check: {
            ...check,
            passed,
            evidence: passed
              ? `exitCode=${env.exitCode} matched expected ${expected}`
              : (env.errorMessage ?? `exitCode=${env.exitCode} (expected ${expected})`),
            checkedAt: env.checkedAt,
          },
        };
      }

      case "test_command": {
        const command = check.command?.trim();
        if (!command) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: "Missing test command",
              checkedAt: env.checkedAt,
            },
          };
        }
        if (!this.adapter.runCommand) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: `No command runner configured to execute "${command}"`,
              checkedAt: env.checkedAt,
            },
          };
        }
        const res = await this.adapter.runCommand(command, env.cwd);
        const expected = check.expectedExitCode ?? 0;
        const passed = res.exitCode === expected;
        const combinedOutput = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
        const snippet = combinedOutput ? `: ${truncateText(combinedOutput, 240)}` : "";
        return {
          check: {
            ...check,
            passed,
            evidence: `exit ${res.exitCode}${snippet}`,
            checkedAt: env.checkedAt,
          },
        };
      }

      case "file_exists": {
        const rawPath = check.path?.trim();
        if (!rawPath) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: "Missing target file path",
              checkedAt: env.checkedAt,
            },
          };
        }
        const root = resolve(env.cwd);
        const fullPath = resolve(root, rawPath);
        const rel = relative(root, fullPath);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: `Blocked path traversal outside project root: ${rawPath}`,
              checkedAt: env.checkedAt,
            },
          };
        }
        const exists = this.adapter.fileExists
          ? await Promise.resolve(this.adapter.fileExists(fullPath))
          : existsSync(fullPath);
        return {
          check: {
            ...check,
            passed: exists,
            evidence: exists ? `Found ${rel || "."}` : `Missing file ${rel || rawPath}`,
            checkedAt: env.checkedAt,
          },
        };
      }

      case "clean_diff": {
        if (!this.adapter.gitInfo) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: "Git status unavailable on adapter",
              checkedAt: env.checkedAt,
            },
          };
        }
        const git = await Promise.resolve(this.adapter.gitInfo(env.cwd));
        if (!git) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: "Directory is not a git repository",
              checkedAt: env.checkedAt,
            },
          };
        }
        const allowDirty = check.allowDirty === true;
        const passed = allowDirty ? true : !git.dirty;
        const changedCount = git.changedFiles?.length;
        const diffNote = git.dirty
          ? `dirty working tree${changedCount !== undefined ? ` (${changedCount} file(s))` : ""}`
          : "clean working tree";
        return {
          check: {
            ...check,
            passed,
            evidence: `${git.branch ? `[${git.branch}] ` : ""}${diffNote}`,
            checkedAt: env.checkedAt,
          },
        };
      }

      case "output_matches": {
        const pattern = check.pattern ?? "";
        const passed =
          !env.turnErrored &&
          pattern.length > 0 &&
          env.finalMessage.toLowerCase().includes(pattern.toLowerCase());
        return {
          check: {
            ...check,
            passed,
            evidence: passed
              ? `Output matched "${pattern}"`
              : `Output did not contain "${pattern}"`,
            checkedAt: env.checkedAt,
          },
        };
      }

      case "assertion": {
        if (env.turnErrored) {
          return {
            check: {
              ...check,
              passed: false,
              evidence: env.errorMessage ?? "Turn ended with error",
              checkedAt: env.checkedAt,
            },
          };
        }
        if (check.passed === true) {
          return {
            check: {
              ...check,
              passed: true,
              evidence: check.evidence ?? "Verified",
              checkedAt: env.checkedAt,
            },
          };
        }
        return {
          check: {
            ...check,
            passed: undefined,
            evidence: "Requires steward/owner review",
            checkedAt: env.checkedAt,
          },
          subjectivePending: true,
        };
      }
    }
  }

  // ── 5. Context Safe-Point Rotation (`checkRotation`) ──────────────

  /**
   * Checks whether the current steward generation has reached either 70% of `contextLimit`
   * or the 160,000-token absolute ceiling. Rotates ONLY at safe idle boundaries,
   * persisting a deterministic `handoff_summary` in `lsa_generations`.
   */
  checkRotation(
    tokenCount: number,
    contextLimit: number,
    options: { idle?: boolean; note?: string; force?: boolean } = {},
  ): LsaRotationResult {
    const safeTokens = Math.max(0, Math.trunc(tokenCount));
    const safeLimit = Math.max(0, Math.trunc(contextLimit));
    const current = this.store.updateCurrentGenerationTokens(safeTokens);

    const hitAbsoluteCap = safeTokens >= LSA_ROTATION_TOKEN_CAP;
    const hitWindowRatio =
      safeLimit > 0 && safeTokens >= Math.ceil(safeLimit * LSA_ROTATION_WINDOW_RATIO);
    const shouldRotate = Boolean(options.force) || hitAbsoluteCap || hitWindowRatio;

    if (!shouldRotate) {
      return {
        rotated: false,
        shouldRotate: false,
        deferred: false,
        reason: "below_threshold",
        currentGeneration: current.generation,
        tokenEstimate: safeTokens,
        contextLimit: safeLimit,
      };
    }

    const atSafeBoundary =
      (options.idle ?? true) && !this.stewardBusy && this.verifyingSessions.size === 0;
    if (!atSafeBoundary) {
      return {
        rotated: false,
        shouldRotate: true,
        deferred: true,
        reason: "busy_unsafe_boundary",
        currentGeneration: current.generation,
        tokenEstimate: safeTokens,
        contextLimit: safeLimit,
      };
    }

    const reason: LsaRotationReason = hitAbsoluteCap
      ? "token_cap_160k"
      : hitWindowRatio
        ? "window_70_percent"
        : "manual";

    const handoffPayload = this.buildHandoffPayload({
      fromGeneration: current.generation,
      toGeneration: current.generation + 1,
      reason,
      tokenCount: safeTokens,
      contextLimit: safeLimit,
      note: options.note,
    });
    const handoffSummary = JSON.stringify(handoffPayload);
    const rotated = this.store.rotateGeneration({
      tokenEstimate: safeTokens,
      handoffSummary,
    });

    return {
      rotated: true,
      shouldRotate: true,
      deferred: false,
      reason,
      previousGeneration: rotated.closed.generation,
      currentGeneration: rotated.current.generation,
      tokenEstimate: rotated.current.tokenEstimate,
      contextLimit: safeLimit,
      handoffSummary,
      handoff: handoffPayload,
    };
  }

  currentGeneration(): LsaGeneration {
    return this.store.currentGeneration();
  }

  listGenerations(limit = 50): LsaGeneration[] {
    return this.store.listGenerations(limit);
  }

  private buildHandoffPayload(input: {
    fromGeneration: number;
    toGeneration: number;
    reason: LsaRotationReason;
    tokenCount: number;
    contextLimit: number;
    note?: string;
  }): LsaHandoffPayload {
    const activeTasks = this.store
      .listTasks({
        status: ["queued", "running", "verifying", "waiting_decision"],
        limit: 25,
      })
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        cwd: t.cwd,
        agent: t.agent,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        ...(t.verificationSummary ? { verificationSummary: t.verificationSummary } : {}),
      }));

    const pendingFollowups = this.store
      .listFollowups({ status: ["pending", "triggered"], limit: 25 })
      .map((f) => ({
        id: f.id,
        note: f.note,
        dueAt: f.dueAt,
        ...(f.taskId ? { taskId: f.taskId } : {}),
      }));

    const recentMemories = this.store.searchMemories({ limit: 15 }).map((m) => ({
      scope: m.scope,
      key: m.key,
      preview: truncateText(m.content, 200),
      tags: m.tags,
    }));

    return {
      fromGeneration: input.fromGeneration,
      toGeneration: input.toGeneration,
      rotatedAt: this.clock(),
      reason: input.reason,
      tokenCount: input.tokenCount,
      contextLimit: input.contextLimit,
      controllerEpoch: this.store.getControllerEpoch(),
      activeTasks,
      pendingFollowups,
      recentMemories,
      ...(input.note ? { note: input.note } : {}),
    };
  }

  // ── 6. Memories (`memorySave` / `memorySearch` / `memoryDelete`) ──

  memorySave(input: {
    scope?: string;
    key: string;
    content: string;
    tags?: readonly string[];
    maxChars?: number;
  }): LsaMemory {
    return this.store.saveMemory(input);
  }

  memorySearch(
    queryOrOptions?:
      | string
      | {
          query?: string;
          scope?: string;
          tags?: readonly string[];
          limit?: number;
        },
  ): LsaMemory[] {
    if (typeof queryOrOptions === "string") {
      return this.store.searchMemories({ query: queryOrOptions });
    }
    return this.store.searchMemories(queryOrOptions ?? {});
  }

  memoryDelete(target: { id?: string; scope?: string; key?: string }): boolean {
    return this.store.deleteMemory(target);
  }

  // ── 7. Followups (`followupSchedule` / `pollDueFollowups`) ────────

  followupSchedule(input: {
    taskId?: string;
    note: string;
    dueAt: number;
  }): LsaFollowup {
    if (input.taskId && !this.store.getTask(input.taskId)) {
      throw RpcError.app("not_found", `关联的 LSA 任务不存在：${input.taskId}`);
    }
    return this.store.scheduleFollowup(input);
  }

  pollDueFollowups(now = this.clock()): LsaFollowup[] {
    const due = this.store.claimDueFollowups(now);
    if (due.length > 0) {
      for (const listener of this.followupListeners) {
        try {
          listener(due);
        } catch (error) {
          this.log(
            `[lsa] followup listener failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return due;
  }

  followupComplete(id: string): LsaFollowup {
    return this.store.updateFollowupStatus(id, "done");
  }

  followupCancel(id: string): LsaFollowup {
    return this.store.updateFollowupStatus(id, "cancelled");
  }

  listFollowups(options?: {
    taskId?: string;
    includeDone?: boolean;
    limit?: number;
  }): LsaFollowup[] {
    return this.store.listFollowups({
      taskId: options?.taskId,
      status: options?.includeDone
        ? ["pending", "triggered", "done"]
        : ["pending", "triggered"],
      limit: options?.limit,
    });
  }

  listTasks(options?: {
    status?: LsaTaskStatus | readonly LsaTaskStatus[];
    cwd?: string;
    limit?: number;
  }): LsaTask[] {
    return this.store.listTasks(options);
  }

  // ── 8. Wire RPC Handlers (`"lsa.*"`) ──────────────────────────────

  async rpcStatus(params: MethodParams<"lsa.status"> = {}): Promise<LsaStatus> {
    this.pollDueFollowups();
    const curGen = this.store.currentGeneration();
    const prevGen =
      curGen.generation > 1 ? this.store.getGeneration(curGen.generation - 1) : undefined;
    const activeTasks = this.store.listTasks({
      status: ["queued", "running", "verifying"],
      limit: 500,
    }).length;
    const waitingDecisionTasks = this.store.listTasks({
      status: "waiting_decision",
      limit: 500,
    }).length;
    const dueFollowups = this.store.listFollowups({
      status: "triggered",
      limit: 500,
    }).length;

    let candidates: LsaCandidateProject[] | undefined;
    if (params.query !== undefined) {
      const located = await this.fleetLocate(params.query, { limit: 10 });
      candidates = located.map((c) => ({
        cwd: c.cwd,
        name: c.name,
        score: c.score,
        ...(c.remote ? { remote: c.remote } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
      }));
    }

    const handoffSummary = curGen.handoffSummary ?? prevGen?.handoffSummary;
    return {
      enabled: true,
      controllerEpoch: this.store.getControllerEpoch(),
      generation: curGen.generation,
      activeTasks,
      waitingDecisionTasks,
      dueFollowups,
      requiresYearlyTier: this.requiresYearlyTier,
      ...(handoffSummary ? { handoffSummary } : {}),
      ...(candidates ? { candidates } : {}),
    };
  }

  rpcTasks(params: MethodParams<"lsa.tasks"> = {}): MethodResult<"lsa.tasks"> {
    if (params.taskId) {
      const single = this.store.getTask(params.taskId);
      return { tasks: single ? [toWireTask(single)] : [] };
    }
    const list = this.store.listTasks({
      status: params.status,
      limit: params.limit,
    });
    return { tasks: list.map(toWireTask) };
  }

  async rpcDispatch(params: MethodParams<"lsa.dispatch">): Promise<MethodResult<"lsa.dispatch">> {
    const task = await this.workDispatch({
      goal: params.goal,
      title: params.title,
      cwd: params.cwd,
      agent: params.agent,
      worktree: params.worktree,
      acceptanceChecks: params.acceptanceChecks,
    });
    return { task: toWireTask(task) };
  }

  async rpcSteer(params: MethodParams<"lsa.steer">): Promise<MethodResult<"lsa.steer">> {
    const task = await this.workSteer({
      taskId: params.taskId,
      instruction: params.instruction,
      controllerEpoch: params.controllerEpoch,
    });
    return { task: toWireTask(task) };
  }

  async rpcDecide(params: MethodParams<"lsa.decide">): Promise<MethodResult<"lsa.decide">> {
    const task = await this.workDecide({
      taskId: params.taskId,
      decision: params.decision,
      feedback: params.feedback,
      controllerEpoch: params.controllerEpoch,
    });
    return { task: toWireTask(task) };
  }

  rpcMemories(params: MethodParams<"lsa.memories"> = {}): MethodResult<"lsa.memories"> {
    const op =
      params.op ??
      (params.key && params.content !== undefined ? "save" : params.query ? "search" : "list");

    switch (op) {
      case "save": {
        if (!params.key || params.content === undefined) {
          throw RpcError.app("invalid_params", "保存记忆需要提供 key 和 content");
        }
        this.memorySave({
          scope: params.scope,
          key: params.key,
          content: params.content,
          tags: params.tags,
        });
        return {
          memories: this.memorySearch({
            scope: params.scope,
            limit: params.limit ?? 50,
          }).map(toWireMemory),
        };
      }
      case "delete": {
        if (!params.key) {
          throw RpcError.app("invalid_params", "删除记忆需要提供 key");
        }
        this.memoryDelete({ scope: params.scope, key: params.key });
        return {
          memories: this.memorySearch({
            scope: params.scope,
            limit: params.limit ?? 50,
          }).map(toWireMemory),
        };
      }
      case "search":
      case "list": {
        return {
          memories: this.memorySearch({
            query: params.query,
            scope: params.scope,
            tags: params.tags,
            limit: params.limit,
          }).map(toWireMemory),
        };
      }
    }
  }

  rpcFollowups(params: MethodParams<"lsa.followups"> = {}): MethodResult<"lsa.followups"> {
    const op = params.op ?? "list";
    switch (op) {
      case "schedule": {
        if (!params.note || params.dueAt === undefined) {
          throw RpcError.app("invalid_params", "创建跟进提醒需要提供 note 和 dueAt");
        }
        this.followupSchedule({
          taskId: params.taskId,
          note: params.note,
          dueAt: params.dueAt,
        });
        break;
      }
      case "complete": {
        if (!params.id) {
          throw RpcError.app("invalid_params", "完成跟进提醒需要提供 id");
        }
        this.followupComplete(params.id);
        break;
      }
      case "delete": {
        if (!params.id) {
          throw RpcError.app("invalid_params", "删除跟进提醒需要提供 id");
        }
        this.followupCancel(params.id);
        break;
      }
      case "list": {
        this.pollDueFollowups();
        break;
      }
    }
    return {
      followups: this.listFollowups({
        taskId: params.taskId,
        includeDone: params.includeDone ?? op === "complete",
      }).map(toWireFollowup),
    };
  }

  /**
   * Ready-to-spread `"lsa.*"` RPC handlers matching `@linkshell/wire`'s `lsaMethods`
   * for `HostRpcServer` (`...lsa.rpcHandlers()`).
   */
  rpcHandlers(): LsaRpcHandlers {
    return {
      "lsa.status": (params) => this.rpcStatus(params),
      "lsa.tasks": (params) => this.rpcTasks(params),
      "lsa.dispatch": (params) => this.rpcDispatch(params),
      "lsa.steer": (params) => this.rpcSteer(params),
      "lsa.decide": (params) => this.rpcDecide(params),
      "lsa.memories": (params) => this.rpcMemories(params),
      "lsa.followups": (params) => this.rpcFollowups(params),
    };
  }

  // ── Internal SessionHub Turn Observer ─────────────────────────────

  private observeHubSessionIfNeeded(sessionId: string): void {
    if (!this.autoObserveHubSessions || !this.hub || this.observedSessions.has(sessionId)) {
      return;
    }
    const hub = this.hub;
    let baselineSeq = 0;
    try {
      baselineSeq = hub.getSession(sessionId).lastSeq;
    } catch {
      baselineSeq = 0;
    }
    const subscriber: Subscriber = {
      event: (event) => {
        if (event.seq <= baselineSeq) return;
        if (event.update.sessionUpdate === "ls_driver") {
          this.markSessionHijacked(sessionId, event.update.driver === "desktop");
          return;
        }
        if (
          event.update.sessionUpdate === "ls_turn" &&
          event.update.state === "ended" &&
          !event.update.parentToolCallId
        ) {
          const stopReason = event.update.stopReason;
          void this.onSessionTurnEnded(sessionId, { stopReason }).catch((error: unknown) => {
            this.log(
              `[lsa] post-turn verification failed for ${sessionId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      },
    };
    const cleanup = () => {
      hub.unsubscribe(sessionId, subscriber);
      this.observedSessions.delete(sessionId);
    };
    this.observedSessions.set(sessionId, cleanup);

    void hub.subscribe(sessionId, baselineSeq, subscriber, { latest: true }).catch(() => {
      cleanup();
    });
  }

  private unobserveHubSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    const cleanup = this.observedSessions.get(sessionId);
    cleanup?.();
  }
}

export type LsaManager = LsaService;

export function createLsaService(options: CreateLsaServiceOptions = {}): LsaService {
  return new LsaService(options);
}

export function lsaHandlers(service: LsaService): LsaRpcHandlers {
  return service.rpcHandlers();
}
