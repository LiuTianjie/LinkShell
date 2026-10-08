import type { ContentBlock } from "@linkshell/wire";

// Codex's slash commands live in its TUI, not in the app-server. These are the
// ones that make sense from a phone, run through the app-server's own methods;
// model and permissions are settings, and new/fork/diff have their own UI.

export interface CodexSkill {
  name: string;
  path: string;
  description?: string;
  shortDescription?: string;
  enabled?: boolean;
  interface?: { shortDescription?: string };
}

export const COMMANDS = [
  { name: "compact", description: "压缩上下文：把之前的对话总结一下，腾出空间继续" },
  { name: "review", description: "审查还没提交的改动", hint: "也可以写上要审查什么" },
  { name: "init", description: "为这个项目生成 AGENTS.md" },
  { name: "reload-skills", description: "重新加载项目可用的技能" },
  { name: "status", description: "查看当前会话状态与模型" },
  { name: "mcp", description: "查看当前会话的 MCP 服务" },
  { name: "apps", description: "查看可用的应用与连接器" },
  { name: "ps", description: "查看当前会话的后台终端" },
  { name: "stop", description: "停止当前会话的所有后台终端" },
];

export const INIT_PROMPT = [
  "Generate a file named AGENTS.md that serves as a contributor guide for this repository.",
  "Read the project first, then write a concise, specific document (roughly 200-400 words) in Markdown with short sections covering:",
  "project structure and module organization; build, test and development commands; coding style and naming conventions; testing guidelines; commit and pull request guidelines.",
  "Only describe what this repository actually has. If AGENTS.md already exists, improve it instead of replacing what is still accurate.",
].join("\n");

/** A message that is only `/name` or `/name arguments`. */
export function commandOf(content: ContentBlock[]): { name: string; args: string; text: string } | undefined {
  if (content.length === 0 || content.some((block) => block.type !== "text")) return undefined;
  const text = content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const match = /^[／/]([^\s/／]+)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1]!, args: match[2]?.trim() ?? "", text } : undefined;
}
