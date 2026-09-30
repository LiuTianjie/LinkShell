import type { SessionConfigOption } from "@linkshell/wire";

// Agents report their settings with their own (English) names. Well-known
// ids and values get Chinese labels; anything else shows as the agent says.

const optionNames: Record<string, string> = {
  model: "模型",
  effort: "推理强度",
  reasoning_effort: "推理强度",
  thought_level: "推理强度",
  mode: "模式",
  permissions: "权限",
};

const valueNames: Record<string, string> = {
  // Reasoning effort
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  // Claude Code permission modes
  default: "默认",
  acceptEdits: "自动接受编辑",
  plan: "规划模式",
  bypassPermissions: "跳过所有确认",
  dontAsk: "不询问",
  // Codex permission presets
  "read-only": "只读",
  auto: "自动",
  "full-access": "完全访问",
  custom: "自定义",
};

const valueHints: Record<string, string> = {
  "read-only": "能读文件，改文件或运行命令前先问你",
  auto: "可在项目里改文件、运行命令，其它操作先问你",
  "full-access": "不再询问，直接改文件、运行任何命令",
  default: "需要时向你请求许可",
  acceptEdits: "自动接受文件修改，命令仍会询问",
  plan: "只做规划，不改文件",
  bypassPermissions: "不再询问任何操作",
};

export function optionLabel(option: SessionConfigOption): string {
  return optionNames[option.id] ?? (option.category === "effort" ? "推理强度" : option.category === "mode" ? "模式" : option.name);
}

export function valueLabel(option: SessionConfigOption, value: string): string {
  const reported = option.values.find((v) => v.value === value)?.name ?? value;
  if (option.category === "model") return reported;
  return valueNames[value] ?? reported;
}

export function valueHint(option: SessionConfigOption, value: string): string | undefined {
  if (option.category === "model") return option.values.find((v) => v.value === value)?.description;
  return valueHints[value] ?? option.values.find((v) => v.value === value)?.description;
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
