import type { AgentTier } from "@linkshell/wire";

export interface AgentLook {
  name: string;
  short: string;
  /** Command that signs the agent in, shown when auth is missing. */
  login?: string;
}

const looks: Record<string, AgentLook> = {
  codex: {
    name: "Codex",
    short: "Codex",
    login: "codex login",
  },
  claude: {
    name: "Claude Code",
    short: "Claude",
    login: "claude /login",
  },
  gemini: {
    name: "Gemini CLI",
    short: "Gemini",
    login: "gemini",
  },
  copilot: {
    name: "GitHub Copilot",
    short: "Copilot",
    login: "copilot login",
  },
  grok: {
    name: "Grok",
    short: "Grok",
  },
  opencode: {
    name: "OpenCode",
    short: "OpenCode",
  },
  cursor: {
    name: "Cursor",
    short: "Cursor",
  },
};

export function agentLook(id: string, label?: string): AgentLook {
  const known = looks[id];
  if (known) return known;
  const name = label ?? id;
  return {
    name,
    short: name,
  };
}

export const tierCopy: Record<AgentTier, { label: string; line: string; detail: string }> = {
  multi_client: {
    label: "多端同步",
    line: "电脑和手机同时在线",
    detail: "电脑终端和手机是同一个会话的两个客户端，逐字同步。任何一端都能输入、打断和审批，谁先操作谁生效。",
  },
  handoff: {
    label: "接力",
    line: "电脑优先，手机接管",
    detail: "在电脑前用 Agent 自己的终端；手机点「接管」后按同一会话继续，回到电脑按任意键即可收回。",
  },
  remote: {
    label: "远程",
    line: "手机完整控制",
    detail: "手机上可以完整对话、审批和打断；电脑上没有 Agent 原生终端，只能在 LinkShell 里查看。",
  },
  terminal: {
    label: "终端",
    line: "只有终端",
    detail: "没有结构化对话，只能查看终端并输入。适用于任何命令行工具。",
  },
};
