import { z } from "zod";
import {
  lsaDecisionSchema,
  lsaTaskStatusSchema,
  type ContentBlock,
  type DirectoryEntry,
  type LsaCandidateProject,
  type LsaDecision,
  type LsaFollowup as WireLsaFollowup,
  type LsaMemory as WireLsaMemory,
  type LsaStatus,
  type LsaTask as WireLsaTask,
  type LsaTaskStatus,
  type ProjectSummary,
  type SessionEvent,
  type SessionSummary,
} from "@linkshell/wire";

export { lsaDecisionSchema, lsaTaskStatusSchema, type LsaDecision, type LsaStatus, type LsaTaskStatus };

// ── Constants & Capability Surface ───────────────────────────────────

export const LSA_ROTATION_TOKEN_CAP = 160_000;
export const LSA_ROTATION_WINDOW_RATIO = 0.7;
export const LSA_DEFAULT_MAX_RETRIES = 2;
export const LSA_DEFAULT_MEMORY_CHAR_LIMIT = 16_000;

export const LSA_STEWARD_TOOLS = [
  "fleet_locate",
  "work_dispatch",
  "work_inspect",
  "work_steer",
  "work_decide",
  "context_rotate",
  "memory_manage",
  "followup_manage",
] as const;

export type LsaStewardToolName = (typeof LSA_STEWARD_TOOLS)[number];

/**
 * Entitlement metadata per Optimization Roadmap §4.3:
 * Single-machine App/CLI sessions stay available on standard plans, while
 * multi-machine fleet orchestration and external IM channels (Feishu/WeChat)
 * require the iTool Yearly membership tier (`yearly`).
 */
export const LSA_ENTITLEMENT_METADATA = {
  product: "linkshell",
  feature: "lsa_steward",
  requiresYearlyTier: true as const,
  requiredTier: "yearly" as const,
  gatedModes: ["multi_machine", "channel"] as const,
} as const;

export type LsaStewardMode = "local" | "multi_machine" | "channel";

export interface LsaEntitlementCheckContext {
  mode: LsaStewardMode;
  targetMachineId?: string;
  channel?: string;
}

export interface LsaEntitlementDecision {
  allowed: boolean;
  tier?: "free" | "monthly" | "yearly" | string;
  isTrial?: boolean;
  reason?: string;
}

export type LsaEntitlementGate = (
  context: LsaEntitlementCheckContext,
) => Promise<LsaEntitlementDecision> | LsaEntitlementDecision;

/**
 * Pure helper evaluating whether an entitlement record satisfies LSA's
 * Yearly-tier requirement for multi-machine or external-channel steward modes.
 */
export function evaluateLsaEntitlement(
  entitlement: { active: boolean; tier?: string | null; isTrial?: boolean } | undefined,
  mode: LsaStewardMode = "multi_machine",
): LsaEntitlementDecision {
  if (mode === "local") {
    return {
      allowed: entitlement ? entitlement.active : true,
      tier: entitlement?.tier ?? undefined,
      isTrial: entitlement?.isTrial,
    };
  }
  if (!entitlement || !entitlement.active) {
    return {
      allowed: false,
      tier: entitlement?.tier ?? "free",
      isTrial: entitlement?.isTrial,
      reason: "LSA 跨设备总管与外部渠道需要有效的 iTool 年度会员（或 7 天免费试用）",
    };
  }
  if (entitlement.tier === "yearly" || entitlement.isTrial === true) {
    return {
      allowed: true,
      tier: entitlement.tier ?? "yearly",
      isTrial: entitlement.isTrial,
    };
  }
  return {
    allowed: false,
    tier: entitlement.tier ?? "monthly",
    isTrial: entitlement.isTrial,
    reason: "LSA 跨设备总管与飞书/微信渠道为 iTool 年度会员专属权益",
  };
}

// ── Acceptance Check Schemas & Normalizer ────────────────────────────

export const lsaAcceptanceCheckKindSchema = z.enum([
  "exit_code",
  "test_command",
  "file_exists",
  "clean_diff",
  "output_matches",
  "assertion",
]);
export type LsaAcceptanceCheckKind = z.infer<typeof lsaAcceptanceCheckKindSchema>;

export const lsaAcceptanceCheckSchema = z.object({
  id: z.string().min(1),
  raw: z.string().min(1),
  kind: lsaAcceptanceCheckKindSchema,
  label: z.string().min(1),
  command: z.string().optional(),
  path: z.string().optional(),
  expectedExitCode: z.number().int().optional(),
  pattern: z.string().optional(),
  allowDirty: z.boolean().optional(),
  passed: z.boolean().optional(),
  evidence: z.string().optional(),
  checkedAt: z.number().optional(),
});
export type LsaAcceptanceCheck = z.infer<typeof lsaAcceptanceCheckSchema>;

export const lsaAcceptanceCheckInputObjectSchema = z.object({
  id: z.string().min(1).optional(),
  raw: z.string().min(1).optional(),
  kind: lsaAcceptanceCheckKindSchema.optional(),
  type: lsaAcceptanceCheckKindSchema.optional(),
  label: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  expectedExitCode: z.number().int().optional(),
  pattern: z.string().min(1).optional(),
  allowDirty: z.boolean().optional(),
  passed: z.boolean().optional(),
  done: z.boolean().optional(),
  evidence: z.string().optional(),
});

export const lsaAcceptanceCheckInputSchema = z.union([
  z.string().min(1),
  lsaAcceptanceCheckInputObjectSchema,
]);
export type LsaAcceptanceCheckInput = z.input<typeof lsaAcceptanceCheckInputSchema>;

function formatCheckRaw(check: {
  kind: LsaAcceptanceCheckKind;
  label: string;
  command?: string;
  path?: string;
  expectedExitCode?: number;
  pattern?: string;
  allowDirty?: boolean;
}): string {
  switch (check.kind) {
    case "test_command":
      return check.command ? `cmd:${check.command}` : check.label;
    case "file_exists":
      return check.path ? `file:${check.path}` : check.label;
    case "exit_code":
      return `exit:${check.expectedExitCode ?? 0}`;
    case "clean_diff":
      return "clean_diff";
    case "output_matches":
      return check.pattern ? `output:${check.pattern}` : check.label;
    case "assertion":
      return check.label;
  }
}

/**
 * Normalizes shorthand string checks (`"cmd:pnpm test"`, `"file:dist/index.js"`,
 * `"exit:0"`, `"clean_diff"`, `"output:PASS"`) or structured check objects into
 * canonical `LsaAcceptanceCheck` records while preserving the wire `string` form.
 */
export function normalizeAcceptanceChecks(
  inputs: readonly LsaAcceptanceCheckInput[] | undefined,
): LsaAcceptanceCheck[] {
  if (!inputs || inputs.length === 0) return [];
  return inputs.map((rawInput, index): LsaAcceptanceCheck => {
    const fallbackId = `check-${index + 1}`;
    if (typeof rawInput === "string") {
      const trimmed = rawInput.trim();
      if (trimmed.startsWith("cmd:") || trimmed.startsWith("test:")) {
        const command = trimmed.replace(/^(?:cmd|test):/, "").trim();
        return {
          id: fallbackId,
          raw: trimmed,
          kind: "test_command",
          label: `Run command: ${command}`,
          command,
        };
      }
      if (trimmed.startsWith("file:")) {
        const filePath = trimmed.slice("file:".length).trim();
        return {
          id: fallbackId,
          raw: trimmed,
          kind: "file_exists",
          label: `File exists: ${filePath}`,
          path: filePath,
        };
      }
      if (trimmed.startsWith("exit:")) {
        const parsedCode = Number.parseInt(trimmed.slice("exit:".length).trim(), 10);
        const expectedExitCode = Number.isFinite(parsedCode) ? parsedCode : 0;
        return {
          id: fallbackId,
          raw: trimmed,
          kind: "exit_code",
          label: `Exit code === ${expectedExitCode}`,
          expectedExitCode,
        };
      }
      if (trimmed === "clean_diff" || trimmed === "git:clean") {
        return {
          id: fallbackId,
          raw: trimmed,
          kind: "clean_diff",
          label: "Clean git working tree",
          allowDirty: false,
        };
      }
      if (trimmed.startsWith("output:")) {
        const pattern = trimmed.slice("output:".length).trim();
        return {
          id: fallbackId,
          raw: trimmed,
          kind: "output_matches",
          label: `Output contains: ${pattern}`,
          pattern,
        };
      }
      return {
        id: fallbackId,
        raw: trimmed,
        kind: "assertion",
        label: trimmed,
      };
    }

    const kind: LsaAcceptanceCheckKind =
      rawInput.kind ??
      rawInput.type ??
      (rawInput.command
        ? "test_command"
        : rawInput.path
          ? "file_exists"
          : rawInput.expectedExitCode !== undefined
            ? "exit_code"
            : rawInput.pattern
              ? "output_matches"
              : "assertion");

    const label =
      rawInput.label ??
      rawInput.text ??
      (rawInput.command
        ? `Run command: ${rawInput.command}`
        : rawInput.path
          ? `File exists: ${rawInput.path}`
          : kind === "clean_diff"
            ? "Clean git working tree"
            : `Exit code === ${rawInput.expectedExitCode ?? 0}`);

    const raw =
      rawInput.raw ??
      formatCheckRaw({
        kind,
        label,
        command: rawInput.command,
        path: rawInput.path,
        expectedExitCode: rawInput.expectedExitCode,
        pattern: rawInput.pattern,
        allowDirty: rawInput.allowDirty,
      });

    return {
      id: rawInput.id ?? fallbackId,
      raw,
      kind,
      label,
      ...(rawInput.command ? { command: rawInput.command } : {}),
      ...(rawInput.path ? { path: rawInput.path } : {}),
      ...(rawInput.expectedExitCode !== undefined
        ? { expectedExitCode: rawInput.expectedExitCode }
        : {}),
      ...(rawInput.pattern ? { pattern: rawInput.pattern } : {}),
      ...(rawInput.allowDirty !== undefined ? { allowDirty: rawInput.allowDirty } : {}),
      ...(rawInput.passed !== undefined
        ? { passed: rawInput.passed }
        : rawInput.done !== undefined
          ? { passed: rawInput.done }
          : {}),
      ...(rawInput.evidence !== undefined ? { evidence: rawInput.evidence } : {}),
    };
  });
}

// ── Ledger Models (Wire-Compatible + Rich Steward Fields) ────────────

export interface LsaLedgerTask extends WireLsaTask {
  title: string;
  worktree: boolean;
  worktreePath?: string;
  agent: string;
  controllerEpoch: number;
  /** Wire-compatible string specifications for every acceptance check. */
  acceptanceChecks: string[];
  /** Full structured acceptance checks with evaluation results and evidence. */
  checks: LsaAcceptanceCheck[];
  verificationSummary?: string;
  summary?: string;
  retryCount: number;
  maxRetries: number;
  generation: number;
}

export type LsaTask = LsaLedgerTask;

export interface LsaLedgerMemory extends WireLsaMemory {
  id: string;
  scope: string;
}

export type LsaMemory = LsaLedgerMemory;

export const lsaFollowupStatusSchema = z.enum(["pending", "triggered", "done", "cancelled"]);
export type LsaFollowupStatus = z.infer<typeof lsaFollowupStatusSchema>;

export interface LsaLedgerFollowup extends WireLsaFollowup {
  status: LsaFollowupStatus;
  createdAt: number;
}

export type LsaFollowup = LsaLedgerFollowup;

export interface LsaGeneration {
  generation: number;
  startedAt: number;
  endedAt?: number;
  tokenEstimate: number;
  handoffSummary?: string;
}

export type LsaRotationReason = "token_cap_160k" | "window_70_percent" | "manual";

export interface LsaHandoffPayload {
  fromGeneration: number;
  toGeneration: number;
  rotatedAt: number;
  reason: LsaRotationReason;
  tokenCount: number;
  contextLimit: number;
  controllerEpoch: number;
  activeTasks: Array<{
    id: string;
    title: string;
    status: LsaTaskStatus;
    cwd: string;
    agent: string;
    sessionId?: string;
    verificationSummary?: string;
  }>;
  pendingFollowups: Array<{
    id: string;
    note: string;
    dueAt: number;
    taskId?: string;
  }>;
  recentMemories: Array<{
    scope: string;
    key: string;
    preview: string;
    tags: string[];
  }>;
  note?: string;
}

export interface LsaRotationResult {
  rotated: boolean;
  shouldRotate: boolean;
  deferred: boolean;
  reason?: LsaRotationReason | "busy_unsafe_boundary" | "below_threshold";
  previousGeneration?: number;
  currentGeneration: number;
  tokenEstimate: number;
  contextLimit: number;
  handoffSummary?: string;
  handoff?: LsaHandoffPayload;
}

export interface LsaProjectCandidate extends LsaCandidateProject {
  reasons: string[];
  git?: {
    root: string;
    branch?: string;
    remote?: string;
    dirty?: boolean;
  };
  sessionCount: number;
  lastActiveAt: number;
  activeTaskCount: number;
  recommendWorktree: boolean;
  machineId?: string;
}

// ── Host Adapter Interface (100% Mockable Without Real LLMs) ─────────

export interface LsaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LsaRepoStatus {
  root: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  remote?: string;
  changedFiles?: string[];
}

export interface LsaHostAdapter {
  machineId?: () => string;
  listProjects?: (limit?: number) => Promise<ProjectSummary[]> | ProjectSummary[];
  listSessions?: (options?: {
    limit?: number;
    includeArchived?: boolean;
  }) => Promise<SessionSummary[]> | SessionSummary[];
  getSession?: (sessionId: string) => Promise<SessionSummary | undefined> | SessionSummary | undefined;
  /**
   * Reports whether a session was taken over interactively (e.g. desktop terminal
   * handoff or external override) so stale/automated controllers never mutate it.
   */
  isSessionHijacked?: (sessionId: string) => Promise<boolean> | boolean;
  readSessionEvents?: (sessionId: string, afterSeq?: number) => Promise<SessionEvent[]> | SessionEvent[];
  createSession?: (input: {
    agent: string;
    cwd: string;
    worktree?: boolean;
    prompt?: ContentBlock[];
    clientMessageId?: string;
  }) => Promise<SessionSummary>;
  promptSession?: (input: {
    sessionId: string;
    clientMessageId: string;
    content: ContentBlock[];
    whenBusy?: "queue";
  }) => Promise<"started" | "steered" | "queued" | "duplicate">;
  cancelSession?: (sessionId: string) => Promise<void>;
  searchDirectories?: (query: string, limit?: number) => Promise<DirectoryEntry[]> | DirectoryEntry[];
  gitInfo?: (cwd: string) => Promise<LsaRepoStatus | undefined> | LsaRepoStatus | undefined;
  fileExists?: (filePath: string) => Promise<boolean> | boolean;
  runCommand?: (command: string, cwd: string, timeoutMs?: number) => Promise<LsaCommandResult>;
}

// ── Operation Input / Result Types ───────────────────────────────────

export interface LsaDispatchInput {
  title?: string;
  goal: string;
  /** Target project directory; auto-resolved via `fleetLocate(goal)` when omitted. */
  cwd?: string;
  agent?: string;
  worktree?: boolean;
  acceptanceChecks?: LsaAcceptanceCheckInput[];
  controllerEpoch?: number;
  /** Defaults to true when `adapter.createSession` is available. */
  startSession?: boolean;
  maxRetries?: number;
  targetMachineId?: string;
  channel?: string;
}

export interface LsaSteerInput {
  taskId: string;
  instruction: string;
  controllerEpoch?: number;
  whenBusy?: "queue";
}

export interface LsaDecideInput {
  taskId: string;
  decision: LsaDecision;
  feedback?: string;
  controllerEpoch?: number;
}

export interface LsaInspectResult {
  task: LsaLedgerTask;
  session?: SessionSummary;
  followups: LsaLedgerFollowup[];
  fenced: boolean;
  hijacked: boolean;
}

export interface LsaTurnEndedContext {
  exitCode?: number;
  stopReason?: "end_turn" | "cancelled" | "error" | string;
  errorMessage?: string;
  finalMessage?: string;
  tokenCount?: number;
  contextLimit?: number;
}

export interface LsaVerificationOutcome {
  task?: LsaLedgerTask;
  passed: boolean;
  action: "no_task" | "fenced" | "completed" | "auto_retried" | "waiting_decision";
  checks: LsaAcceptanceCheck[];
  summary: string;
  rotation?: LsaRotationResult;
}
