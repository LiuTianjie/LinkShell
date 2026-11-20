import type { AgentInfo, AgentTier } from "@linkshell/wire";

export interface AgentLook {
  name: string;
  short: string;
  /** Command that signs the agent in, shown when auth is missing. */
  login?: string;
  /** Suggested one-line install command shown in the supported-agents catalog. */
  install?: string;
  /** Visual grouping in the supported-agents catalog. */
  group?: "domestic" | "global";
}

const looks: Record<string, AgentLook> = {
  codex: {
    name: "Codex",
    short: "Codex",
    login: "codex login",
    install: "npm i -g @openai/codex",
    group: "global",
  },
  claude: {
    name: "Claude Code",
    short: "Claude",
    login: "claude /login",
    install: "npm i -g @anthropic-ai/claude-code",
    group: "global",
  },
  gemini: {
    name: "Gemini CLI",
    short: "Gemini",
    login: "gemini",
    install: "npm i -g @google/gemini-cli",
    group: "global",
  },
  antigravity: {
    name: "Google Antigravity",
    short: "Antigravity",
    login: "agy-acp",
    group: "global",
  },
  copilot: {
    name: "GitHub Copilot",
    short: "Copilot",
    login: "copilot login",
    install: "npm i -g @github/copilot",
    group: "global",
  },
  grok: {
    name: "Grok",
    short: "Grok",
    install: "npm i -g @xai-official/grok",
    group: "global",
  },
  opencode: {
    name: "OpenCode",
    short: "OpenCode",
    install: "brew install opencode",
    group: "global",
  },
  cursor: {
    name: "Cursor",
    short: "Cursor",
    group: "global",
  },
  cline: {
    name: "Cline",
    short: "Cline",
    login: "cline",
    install: "npm i -g cline",
    group: "global",
  },
  kilo: {
    name: "Kilo Code",
    short: "Kilo",
    login: "kilo",
    install: "npm i -g @kilocode/cli",
    group: "global",
  },
  qwen: {
    name: "Qwen Code",
    short: "Qwen",
    login: "qwen",
    install: "npm i -g @qwen-code/qwen-code",
    group: "domestic",
  },
  kimi: {
    name: "Kimi Code",
    short: "Kimi",
    login: "kimi /login",
    install: "npm i -g @moonshot-ai/kimi-code",
    group: "domestic",
  },
  codebuddy: {
    name: "CodeBuddy",
    short: "CodeBuddy",
    login: "codebuddy",
    install: "npm i -g @tencent-ai/codebuddy-code",
    group: "domestic",
  },
  qoder: {
    name: "Qoder",
    short: "Qoder",
    login: "qodercli login",
    install: "npm i -g @qoder-ai/qodercli",
    group: "domestic",
  },
  minimax: {
    name: "MiniMax Code",
    short: "MiniMax",
    login: "mcode login",
    install: "npm i -g @minimax-ai/code",
    group: "domestic",
  },
  trae: {
    name: "TRAE",
    short: "TRAE",
    login: "traecli",
    install: "traecli acp serve",
    group: "domestic",
  },
  deepseek: {
    name: "DeepSeek",
    short: "DeepSeek",
    login: "dsh",
    install: "npm i -g @deepseek-ai/dsh",
    group: "domestic",
  },
  glm: {
    name: "GLM",
    short: "GLM",
    login: "glm-acp-agent --setup",
    install: "npm i -g glm-acp-agent",
    group: "domestic",
  },
  iflow: {
    name: "iFlow",
    short: "iFlow",
    login: "iflow",
    install: "npm i -g @iflow-ai/iflow-cli",
    group: "domestic",
  },
  comate: {
    name: "Comate",
    short: "Comate",
    login: "comate-acp --login",
    install: "npm i -g comate-acp @comate/comatecli",
    group: "domestic",
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

/** Concise capability tags shown alongside an installed agent's tier. */
export function agentCapabilityTags(agent: Pick<AgentInfo, "capabilities">, locale: "zh" | "en" | "ja" = "zh"): string[] {
  const tags: string[] = [];
  if (agent.capabilities.steer) tags.push(locale === "en" ? "Steer" : locale === "ja" ? "割り込み" : "支持插话");
  if (agent.capabilities.images) tags.push(locale === "en" ? "Images" : locale === "ja" ? "画像" : "图片");
  if (agent.capabilities.fork) tags.push(locale === "en" ? "Fork" : locale === "ja" ? "分岐" : "分叉");
  if (agent.capabilities.acp) tags.push("ACP");
  return tags;
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
