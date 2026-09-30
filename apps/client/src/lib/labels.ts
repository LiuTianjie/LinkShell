import type { SessionConfigOption } from "@linkshell/wire";

// Agents report their settings with their own (English) names. Well-known
// ids and values get Chinese labels; anything else shows as the agent says.

const optionNames: Record<string, string> = {
  model: "模型",
  effort: "推理强度",
  reasoning_effort: "推理强度",
  thought_level: "推理强度",
  mode: "权限模式",
  permissions: "权限",
  fast: "快速模式",
};

const valueNames: Record<string, string> = {
  // Reasoning effort
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  on: "开",
  off: "关",
  default: "默认",
};

/**
 * Names and hints that depend on which setting they belong to: `auto` is a
 * Codex permission preset and a Claude permission mode, meaning different things.
 */
const scoped: Record<string, Record<string, { name: string; hint?: string }>> = {
  // Claude Code permission modes
  mode: {
    default: { name: "每次询问", hint: "改文件或运行命令前先问你" },
    acceptEdits: { name: "自动接受编辑", hint: "文件修改直接接受，命令仍会询问" },
    plan: { name: "规划模式", hint: "先出计划，不改文件" },
    auto: { name: "自动判断", hint: "Claude 自己判断哪些操作需要问你" },
    bypassPermissions: { name: "跳过所有确认", hint: "不再询问任何操作" },
    dontAsk: { name: "不询问" },
  },
  // Codex permission presets
  permissions: {
    "read-only": { name: "只读", hint: "能读文件，改文件或运行命令前先问你" },
    auto: { name: "自动", hint: "可在项目里改文件、运行命令，其它操作先问你" },
    "full-access": { name: "完全访问", hint: "不再询问，直接改文件、运行任何命令" },
    custom: { name: "自定义" },
  },
  fast: {
    on: { name: "开", hint: "更快的输出，额度消耗更多" },
    off: { name: "关" },
  },
};

export function optionLabel(option: SessionConfigOption): string {
  return optionNames[option.id] ?? (option.category === "effort" ? "推理强度" : option.category === "mode" ? "模式" : option.name);
}

export function valueLabel(option: SessionConfigOption, value: string): string {
  const reported = option.values.find((v) => v.value === value);
  if (option.category === "model") {
    // "Default (recommended)" says nothing; the agent resolves it in the description ("Opus 5.5").
    if (value === "default" && reported?.description && reported.description.length <= 24) return `默认 · ${reported.description}`;
    return reported?.name ?? value;
  }
  return scoped[option.id]?.[value]?.name ?? valueNames[value] ?? reported?.name ?? value;
}

export function valueHint(option: SessionConfigOption, value: string): string | undefined {
  const reported = option.values.find((v) => v.value === value)?.description;
  if (option.category === "model") return value === "default" ? "推荐，跟随 Agent 的默认选择" : reported;
  return scoped[option.id]?.[value]?.hint ?? reported;
}

/** An on/off setting (Claude's fast mode): shown as a toggle, not a menu. */
export function isToggle(option: SessionConfigOption): boolean {
  const values = option.values.map((v) => v.value).sort();
  return values.length === 2 && values[0] === "off" && values[1] === "on";
}

/** Dangerous permission values get a warning tint. */
export function isRisky(value: string): boolean {
  return value === "full-access" || value === "bypassPermissions" || value === "dontAsk";
}

/** Compact chip text: the value, with a prefix where the value alone is ambiguous. */
export function chipLabel(option: SessionConfigOption): string {
  const value = valueLabel(option, option.current);
  return option.category === "effort" ? `推理 ${value}` : value;
}

/** The model as a chip shows it: what "default" resolves to, without the word. */
export function modelChipLabel(option: SessionConfigOption): string {
  const current = option.values.find((v) => v.value === option.current);
  if (option.current === "default" && current?.description && current.description.length <= 24) return current.description;
  return current?.name ?? option.current;
}
