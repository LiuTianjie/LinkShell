import type { AgentDriver } from "./types.js";
import { AcpDriver, type AcpAgentSpec } from "./acp/driver.js";
import { ClaudeDriver } from "./claude/driver.js";
import { CodexDriver } from "./codex/driver.js";

/**
 * ACP agents LinkShell drives generically. Launch commands are the ones each
 * CLI documents for its ACP server mode; agents that aren't installed are
 * listed as such. Tier "remote": the phone gets full control, the desktop uses
 * LinkShell's own UI rather than the agent's TUI.
 */
export const ACP_AGENTS: AcpAgentSpec[] = [
  { id: "gemini", label: "Gemini", tier: "remote", command: "gemini", args: ["--acp"] },
  // Lists sessions over ACP (including ones made in its own CLI).
  { id: "copilot", label: "Copilot", tier: "remote", command: "copilot", args: ["--acp"], discover: true },
  { id: "grok", label: "Grok", tier: "remote", command: "grok", args: ["agent", "stdio"], discover: true, cachedAuthMethod: "cached_token" },
  { id: "opencode", label: "OpenCode", tier: "remote", command: "opencode", args: ["acp"] },
  { id: "cursor", label: "Cursor", tier: "remote", command: "cursor-agent", args: ["acp"] },
];

export interface DefaultDriverOptions {
  env?: NodeJS.ProcessEnv;
  hostVersion: string;
  codexSocket: string;
  codexCommand?: string;
  claudeCommand?: string;
  claudeAdapter?: { command: string; args: string[] };
}

export function defaultDrivers(options: DefaultDriverOptions): AgentDriver[] {
  return [
    new CodexDriver({ socketPath: options.codexSocket, command: options.codexCommand, env: options.env, hostVersion: options.hostVersion }),
    new ClaudeDriver({
      env: options.env,
      hostVersion: options.hostVersion,
      claudeCommand: options.claudeCommand,
      adapter: options.claudeAdapter,
    }),
    ...ACP_AGENTS.map((spec) => new AcpDriver(spec, { env: options.env, hostVersion: options.hostVersion })),
  ];
}
