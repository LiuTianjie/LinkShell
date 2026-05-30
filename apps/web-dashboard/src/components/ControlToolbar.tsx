import type {
  AgentConversation,
  AgentProviderCapability,
  AgentReasoningEffort,
  AgentPermissionMode,
} from "../lib/types";
import { IconCheck } from "./icons";

// Compact control bar above the composer: model / reasoning effort / permission
// mode / plan toggle, all driven by the active provider's capabilities. Changes
// update the conversation's local settings and ride the next prompt.

const EFFORT_LABEL: Record<string, string> = {
  none: "无",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

const PERMISSION_LABEL: Record<string, string> = {
  read_only: "只读",
  workspace_write: "工作区写",
  full_access: "完全访问",
};

interface SettingsPatch {
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: "default" | "plan";
}

export interface ControlToolbarProps {
  conversation: AgentConversation;
  capability: AgentProviderCapability | undefined;
  onChange: (patch: SettingsPatch) => void;
}

function Select<T extends string>({
  label,
  value,
  options,
  render,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: T[];
  render: (v: T) => string;
  onChange: (v: T) => void;
}) {
  if (options.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs text-content-muted">
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer rounded-full bg-surface-overlay px-2.5 py-1 text-xs text-content-primary outline-none transition-colors hover:bg-surface-raised focus:ring-2 focus:ring-accent/20"
      >
        {value === undefined && <option value="">默认</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ControlToolbar({
  conversation,
  capability,
  onChange,
}: ControlToolbarProps) {
  const models = capability?.models ?? [];
  // Host sends a placeholder [{id:"default", label:"默认模型"}] for providers
  // that don't expose a real model list (e.g. Claude CLI). A single placeholder
  // isn't selectable, so hide the picker instead of showing a useless dropdown.
  const realModels = models.filter((m) => m.id !== "default");
  const showModelPicker = realModels.length > 0;
  const efforts = capability?.reasoningEfforts ?? [];
  const permissions = capability?.permissionModes ?? [];
  const supportsPlan = capability?.supportsPlan ?? false;
  const planOn = conversation.collaborationMode === "plan";

  return (
    <div className="flex flex-wrap items-center gap-3 px-1 pb-2 pt-1">
      {showModelPicker && (
        <label className="flex items-center gap-1.5 text-xs text-content-muted">
          <span>模型</span>
          <select
            value={conversation.model ?? capability?.defaultModel ?? realModels[0]?.id ?? ""}
            onChange={(e) => onChange({ model: e.target.value })}
            className="cursor-pointer rounded-full bg-surface-overlay px-2.5 py-1 text-xs text-content-primary outline-none transition-colors hover:bg-surface-raised focus:ring-2 focus:ring-accent/20"
          >
            {realModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <Select
        label="强度"
        value={conversation.reasoningEffort}
        options={efforts}
        render={(e) => EFFORT_LABEL[e] ?? e}
        onChange={(reasoningEffort) => onChange({ reasoningEffort })}
      />

      <Select
        label="权限"
        value={conversation.permissionMode}
        options={permissions}
        render={(p) => PERMISSION_LABEL[p] ?? p}
        onChange={(permissionMode) => onChange({ permissionMode })}
      />

      {supportsPlan && (
        <button
          onClick={() => onChange({ collaborationMode: planOn ? "default" : "plan" })}
          className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            planOn
              ? "bg-accent-dim text-white"
              : "bg-surface-overlay text-content-secondary hover:text-content-primary"
          }`}
          title="计划模式"
        >
          {planOn && <IconCheck size={12} />}
          计划模式
        </button>
      )}
    </div>
  );
}
