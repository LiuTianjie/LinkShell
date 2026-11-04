import { displayModelName, type SessionConfigOption } from "@linkshell/wire";

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
  plan: "计划模式",
  agent: "Agent 角色",
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
  ultra: "极高",
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
    // Gemini's approval modes share the id
    autoEdit: { name: "自动编辑", hint: "自动批准编辑，其他操作仍会询问" },
    yolo: { name: "全部自动批准", hint: "所有操作都不再询问" },
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
  // Codex's plan mode
  plan: {
    on: { name: "开", hint: "先讨论、出计划，谈好了再动手" },
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
    return displayModelName(reported?.name ?? value);
  }
  return scoped[option.id]?.[value]?.name ?? valueNames[value] ?? reported?.name ?? value;
}

/** Fixed descriptions the shipped drivers give values (Codex's efforts, Claude's agents). */
const hints: Record<string, string> = {
  "fast responses with lighter reasoning": "回复快，思考较浅",
  "balances speed and reasoning depth for everyday tasks": "兼顾速度和思考深度，适合日常任务",
  "greater reasoning depth for complex problems": "思考更深，适合复杂问题",
  "extra high reasoning depth for complex problems": "思考很深，适合复杂问题",
  "maximum reasoning depth for the hardest problems": "最深的思考，适合最难的问题",
  "maximum reasoning with automatic task delegation": "最深的思考，并自动分派子任务",
  "standard claude code agent": "标准的 Claude Code Agent",
};

export function valueHint(option: SessionConfigOption, value: string): string | undefined {
  const reported = option.values.find((v) => v.value === value)?.description;
  if (option.category === "model") return value === "default" ? "推荐，跟随 Agent 的默认选择" : reported;
  return scoped[option.id]?.[value]?.hint ?? (reported ? hints[reported.trim().toLowerCase()] ?? reported : undefined);
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

/** The model as a chip shows it: what "default" resolves to, without the word. */
export function modelChipLabel(option: SessionConfigOption): string {
  const current = option.values.find((v) => v.value === option.current);
  if (option.current === "default" && current?.description && current.description.length <= 24) return current.description;
  return displayModelName(current?.name ?? option.current);
}
