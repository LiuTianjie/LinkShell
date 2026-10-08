import type { SessionConfigOption } from "@linkshell/wire";

export interface Command {
  name: string;
  description: string;
  hint?: string;
  action?: "tasks" | "commands" | "settings" | "goal" | "changes" | "new" | "fork" | "rename" | "context";
  optionId?: string;
}

/** Built-ins worth finding first, in this order, with what they do when the agent doesn't say it in Chinese. */
const PINNED: [name: string, label: string][] = [
  ["goal", "管理持续目标"],
  ["plan", "进入计划模式"],
  ["compact", "压缩上下文"],
  ["context", "查看上下文占用"],
  ["usage", "查看用量"],
  ["review", "审查改动"],
  ["init", "生成项目说明（CLAUDE.md / AGENTS.md）"],
  ["security-review", "安全审查"],
];

/** Adapter-internal entry points are not user commands. */
const HIDDEN = new Set([
  // The adapter already removes terminal-only commands. Do not maintain a
  // second stale blacklist: commands such as mcp/config now have remote forms.
  "__remote-workflow",
  "workflow-launch-exec",
]);

/** A command token at the start of a draft, including mobile IME punctuation. */
export function commandQuery(text: string): string | undefined {
  return /^\s*[／/]([^\s/／]*)$/.exec(text)?.[1];
}

export function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = /^[／/]([^\s/／]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: match[2]?.trim() ?? "" } : undefined;
}

export function normalizeCommandText(text: string): string {
  return text.replace(/^(\s*)／/, "$1/");
}

/** Local controls supplement the native list; native prompt commands stay intact. */
export function sessionCommands(agent: string, commands: Command[], config: SessionConfigOption[]): Command[] {
  const local: Command[] = [
    ...(agent === "codex" || agent === "claude" ? [{ name: "tasks", description: "查看后台命令、输出与运行状态", action: "tasks" as const }] : []),
    { name: "help", description: "查看和搜索所有可用命令", action: "commands" },
    { name: "settings", description: "打开会话设置", action: "settings" },
    { name: "diff", description: "查看当前会话的文件改动", action: "changes" },
    { name: "new", description: "在当前项目新建会话", action: "new" },
    { name: "rename", description: "修改会话名称", action: "rename", hint: "名称" },
  ];
  if (agent === "codex") local.push(
    { name: "skills", description: "搜索并选择技能命令", action: "commands" },
    { name: "config", description: "打开会话设置", action: "settings" },
    { name: "fork", description: "从当前会话分叉", action: "fork" },
    { name: "context", description: "查看上下文占用", action: "context" },
    { name: "clear", description: "在当前项目新建空白会话，保留原会话", action: "new" },
  );
  if (commands.some((command) => command.name === "goal")) local.push({ name: "goal", description: "查看目标、进度与操作", action: "goal", hint: agent === "codex" ? "目标 / pause / resume / clear" : "目标 / clear" });
  for (const option of config) {
    const name = option.category === "model" ? "model" : option.category === "effort" ? "effort" : option.category === "mode" ? "permissions" : option.id;
    if (!["model", "effort", "permissions", "plan", "fast"].includes(name)) continue;
    local.push({ name, description: ({ model: "选择模型", effort: "调整推理强度", permissions: "调整权限模式", plan: "切换计划模式", fast: "切换快速模式" } as Record<string, string>)[name]!, action: "settings", optionId: option.id, hint: option.values.map((value) => value.value).join(" / ") });
  }
  const permissions = config.find((option) => option.category === "mode");
  if (!local.some((command) => command.name === "plan") && permissions?.values.some((value) => value.value === "plan")) {
    local.push({ name: "plan", description: "进入计划模式", action: "settings", optionId: permissions.id, hint: "任务描述（可选）" });
  }
  if (permissions && agent === "codex") local.push({ name: "approvals", description: "选择权限模式", action: "settings", optionId: permissions.id });
  const overridden = new Set(local.map((command) => command.name));
  return offeredCommands([...local, ...commands.filter((command) => !overridden.has(command.name))]);
}

/** The commands to offer: pinned built-ins, then the rest as the agent sent them. */
export function offeredCommands(commands: Command[]): Command[] {
  // (An agent can name a command twice, a skill and a built-in: the first stands.)
  const seen = new Set<string>();
  const usable = commands.filter((command) => !HIDDEN.has(command.name) && !seen.has(command.name) && !!seen.add(command.name));
  const pinned = PINNED.flatMap(([name]) => usable.filter((command) => command.name === name).slice(0, 1));
  const names = new Set(pinned.map((command) => command.name));
  return [...pinned, ...usable.filter((command) => !names.has(command.name))];
}

/** One line on what a command does: the agent's own, or ours for a pinned one it describes in English (or not at all). */
export function commandDetail(command: Command): string {
  const label = PINNED.find(([name]) => name === command.name)?.[1];
  const said = command.description.trim();
  if (label && (!said || !/[\u4e00-\u9fff]/.test(said))) return label;
  return said;
}

/**
 * Commands whose name (or what they do) has `query` in it: names that start
 * with it first, then names that contain it, then matches in the detail.
 */
export function matchCommands(commands: Command[], query: string): Command[] {
  const offered = offeredCommands(commands);
  const text = query.trim().toLowerCase().replace(/^[／/]/, "");
  if (!text) return offered;
  const starts: Command[] = [];
  const within: Command[] = [];
  const described: Command[] = [];
  for (const command of offered) {
    const name = command.name.toLowerCase();
    if (name.startsWith(text)) starts.push(command);
    else if (name.includes(text)) within.push(command);
    else if (commandDetail(command).toLowerCase().includes(text)) described.push(command);
  }
  return [...starts, ...within, ...described];
}
