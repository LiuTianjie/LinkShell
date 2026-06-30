import { useRef, useState, useEffect, type ReactNode } from "react";
import type {
  AgentConversation,
  AgentProviderCapability,
  AgentReasoningEffort,
  AgentPermissionMode,
} from "../lib/types";
import { IconCheck, IconChevronDown } from "./icons";

// Codex-style compact controls that live INSIDE the composer's bottom bar:
// unlabeled pills (model / reasoning effort / permission) + a plan toggle.
// Everything is capability-driven so it adapts per provider — Claude (no real
// model list, its own effort/permission sets) and Codex both render correctly;
// a control with no options simply doesn't appear.

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

// A rounded pill backed by a popover list — matches Codex's settings menus far
// better than a native <select> (which can't be styled to the same polish) and
// behaves consistently across desktop/mobile.
function PillSelect<T extends string>({
  icon,
  value,
  options,
  render,
  onChange,
  title,
  placeholder,
}: {
  icon?: ReactNode;
  value: T | undefined;
  options: T[];
  render: (v: T) => string;
  onChange: (v: T) => void;
  title?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  if (options.length === 0) return null;
  // When the conversation carries no explicit value (common for sessions we
  // discovered off disk rather than drove ourselves), show a neutral label
  // instead of pretending the first option is selected — the CLI uses the
  // provider default in that case, so options[0] would misreport e.g. "低"/"只读".
  const hasValue = value !== undefined && options.includes(value);
  const label = hasValue ? render(value as T) : placeholder ?? render(options[0]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium text-content-secondary transition-colors hover:bg-surface-overlay hover:text-content-primary"
      >
        {icon}
        <span className="max-w-[7rem] truncate">{label}</span>
        <IconChevronDown size={11} className="text-content-faint" />
      </button>
      {open && (
        <div className="codex-card-raised absolute bottom-full left-0 z-20 mb-1.5 min-w-[8rem] overflow-hidden p-1 animate-fade-in">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                hasValue && o === value ? "text-content-primary" : "text-content-secondary"
              }`}
            >
              <span className="truncate">{render(o)}</span>
              {hasValue && o === value && <IconCheck size={13} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ControlToolbar({
  conversation,
  capability,
  onChange,
}: ControlToolbarProps) {
  const models = capability?.models ?? [];
  // Host sends a placeholder [{id:"default", label:"默认模型"}] for providers
  // that don't expose a real model list (e.g. Claude CLI). Hide the picker then.
  const realModels = models.filter((m) => m.id !== "default");
  const efforts = capability?.reasoningEfforts ?? [];
  const permissions = capability?.permissionModes ?? [];
  const supportsPlan = capability?.supportsPlan ?? false;
  const planOn = conversation.collaborationMode === "plan";

  return (
    <>
      {realModels.length > 0 && (
        <PillSelect
          title="模型"
          value={conversation.model ?? capability?.defaultModel ?? realModels[0]?.id}
          options={realModels.map((m) => m.id)}
          render={(id) => realModels.find((m) => m.id === id)?.label ?? id}
          onChange={(model) => onChange({ model })}
        />
      )}
      <PillSelect
        title="推理强度"
        value={conversation.reasoningEffort}
        options={efforts}
        render={(e) => EFFORT_LABEL[e] ?? e}
        onChange={(reasoningEffort) => onChange({ reasoningEffort })}
        placeholder="默认"
      />
      <PillSelect
        title="权限"
        value={conversation.permissionMode}
        options={permissions}
        render={(p) => PERMISSION_LABEL[p] ?? p}
        onChange={(permissionMode) => onChange({ permissionMode })}
        placeholder="默认"
      />
      {supportsPlan && (
        <button
          type="button"
          onClick={() => onChange({ collaborationMode: planOn ? "default" : "plan" })}
          className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-2xs font-medium transition-colors ${
            planOn
              ? "bg-accent-dim text-white"
              : "text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
          }`}
          title="计划模式"
        >
          {planOn && <IconCheck size={11} />}
          计划
        </button>
      )}
    </>
  );
}
