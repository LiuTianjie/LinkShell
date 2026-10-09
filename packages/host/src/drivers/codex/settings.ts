import type { SessionConfigOption } from "@linkshell/wire";

// Codex session settings: model, reasoning effort and permission mode, as
// config options. Codex applies overrides on `turn/start`, and they stick for
// the rest of the thread, so a change takes effect from the next message.

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}

type SandboxPolicy = { type: string; [key: string]: unknown };

export interface CodexSettings {
  model?: string;
  effort?: string | null;
  approvalPolicy?: unknown;
  sandbox?: SandboxPolicy;
}

/** What the thread should switch to on its next turn. */
export interface CodexOverrides {
  model?: string;
  effort?: string;
  permissions?: string;
  /** Codex's plan mode: it discusses and plans (and asks questions) instead of making changes. */
  plan?: boolean;
}

/** The Codex TUI's `/approvals` presets. */
export const PERMISSION_PRESETS: {
  id: string;
  name: string;
  description: string;
  approvalPolicy: string;
  sandboxPolicy: SandboxPolicy;
}[] = [
  {
    id: "read-only",
    name: "Read only",
    description: "Can read files; asks before editing or running commands",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  },
  {
    id: "auto",
    name: "Auto",
    description: "Edits and runs commands in the workspace; asks before anything else",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  {
    id: "full-access",
    name: "Full access",
    description: "Edits and runs anything without asking",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  },
];

export function presetOf(settings: CodexSettings): string | undefined {
  switch (settings.sandbox?.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "auto";
    case "dangerFullAccess":
      return settings.approvalPolicy === "never" ? "full-access" : undefined;
    default:
      return undefined;
  }
}

export function settingsFrom(response: Record<string, unknown>): CodexSettings {
  return {
    model: typeof response.model === "string" ? response.model : undefined,
    effort: typeof response.reasoningEffort === "string" ? response.reasoningEffort : null,
    approvalPolicy: response.approvalPolicy,
    sandbox: response.sandbox && typeof response.sandbox === "object" ? (response.sandbox as SandboxPolicy) : undefined,
  };
}

/**
 * The settings of a thread another Codex process holds, from the latest
 * `turn_context` in its rollout file: model, effort, approvals and sandbox, as
 * that process last ran a turn with them. The file spells sandbox types in
 * kebab case (`danger-full-access`).
 */
export function settingsFromTurnContext(context: Record<string, unknown>): CodexSettings {
  const sandbox = context.sandbox_policy && typeof context.sandbox_policy === "object" ? (context.sandbox_policy as SandboxPolicy) : undefined;
  return {
    model: typeof context.model === "string" ? context.model : undefined,
    effort: typeof context.effort === "string" ? context.effort : null,
    approvalPolicy: context.approval_policy,
    sandbox: sandbox ? { ...sandbox, type: sandbox.type.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()) } : undefined,
  };
}

function findModel(models: CodexModel[], id: string | undefined): CodexModel | undefined {
  if (!id) return undefined;
  return models.find((m) => m.model === id || m.id === id);
}

/** The settings the thread will run with, overrides applied. */
export function effective(settings: CodexSettings, overrides: CodexOverrides, models: CodexModel[]) {
  const model = overrides.model ?? settings.model ?? models.find((m) => m.isDefault)?.model;
  const info = findModel(models, model);
  const supported = info?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [];
  let effort = overrides.effort ?? settings.effort ?? info?.defaultReasoningEffort;
  if (effort && supported.length > 0 && !supported.includes(effort)) effort = info?.defaultReasoningEffort;
  const permissions = overrides.permissions ?? presetOf(settings);
  return { model, info, effort, permissions };
}

export function configOptions(settings: CodexSettings, overrides: CodexOverrides, models: CodexModel[]): SessionConfigOption[] {
  const { model, info, effort, permissions } = effective(settings, overrides, models);
  const options: SessionConfigOption[] = [];
  const visible = models.filter((m) => !m.hidden || m.model === model);
  if (model && visible.length > 0) {
    const values = visible.map((m) => ({ value: m.model, name: m.displayName || m.model, description: m.description || undefined }));
    if (!values.some((v) => v.value === model)) values.unshift({ value: model, name: model, description: undefined });
    options.push({ id: "model", name: "Model", category: "model", current: model, values });
  }
  const efforts = info?.supportedReasoningEfforts ?? [];
  if (effort && efforts.length > 1) {
    options.push({
      id: "effort",
      name: "Reasoning effort",
      category: "effort",
      current: effort,
      values: efforts.map((e) => ({ value: e.reasoningEffort, name: e.reasoningEffort, description: e.description || undefined })),
    });
  }
  options.push({
    id: "permissions",
    name: "Permissions",
    category: "mode",
    current: permissions ?? "custom",
    values: [
      ...(permissions ? [] : [{ value: "custom", name: "Custom", description: "Set in Codex's own config" }]),
      ...PERMISSION_PRESETS.map((p) => ({ value: p.id, name: p.name, description: p.description })),
    ],
  });
  // The TUI's Shift+Tab. Only offered when the model is known: a mode is set together with one.
  if (model) {
    options.push({
      id: "plan",
      name: "Plan mode",
      category: "other",
      current: overrides.plan ? "on" : "off",
      values: [
        { value: "off", name: "Off" },
        { value: "on", name: "On", description: "Discuss and plan first; no changes until the plan is agreed" },
      ],
    });
  }
  return options;
}

/** `turn/start` parameters for the pending overrides. `current` is what the thread runs with (a mode names its model). */
export function turnOverrides(overrides: CodexOverrides, current: { model?: string; effort?: string | null } = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (overrides.plan !== undefined && current.model) {
    params.collaborationMode = {
      mode: overrides.plan ? "plan" : "default",
      settings: { model: current.model, reasoning_effort: current.effort ?? null, developer_instructions: null },
    };
  }
  if (overrides.model) params.model = overrides.model;
  if (overrides.effort) params.effort = overrides.effort;
  const preset = PERMISSION_PRESETS.find((p) => p.id === overrides.permissions);
  if (preset) {
    params.approvalPolicy = preset.approvalPolicy;
    params.sandboxPolicy = preset.sandboxPolicy;
  }
  return params;
}
