// The agent's slash commands, as the phone offers them: the common built-ins
// first, the ones that can't work from a phone left out. Claude alone sends
// over a hundred (skills first, built-ins last), so the order matters.

export interface Command {
  name: string;
  description: string;
  hint?: string;
}

/** Built-ins worth finding first, in this order, with what they do when the agent doesn't say it in Chinese. */
const PINNED: [name: string, label: string][] = [
  ["compact", "压缩上下文"],
  ["context", "查看上下文占用"],
  ["usage", "查看用量"],
  ["review", "审查改动"],
  ["init", "生成项目说明（CLAUDE.md / AGENTS.md）"],
  ["security-review", "安全审查"],
];

/**
 * Commands that need the computer's own terminal, or that the app does
 * another way (model, effort and fast are the composer's chips; rename is in
 * the session's menu).
 */
const HIDDEN = new Set([
  "config",
  "model",
  "mcp",
  "agents",
  "output-style",
  "effort",
  "fast",
  "heapdump",
  "rename",
  "import",
  "login",
  "logout",
  "autocompact",
  "extra-usage",
  "usage-credits",
  "reload-skills",
  "design-consent",
  "design-revoke",
  "__remote-workflow",
  "workflow-launch-exec",
]);

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
  const text = query.trim().toLowerCase().replace(/^\//, "");
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
