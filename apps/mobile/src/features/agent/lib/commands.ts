import type { AgentCommandDescriptor } from "../types";

export function trailingSlashCommandToken(
  text: string,
): { query: string; start: number; end: number } | null {
  const slashIndex = text.lastIndexOf("/");
  if (slashIndex < 0) return null;
  if (slashIndex > 0 && !/\s/.test(text[slashIndex - 1] ?? "")) return null;
  const query = text.slice(slashIndex + 1);
  if (/\s/.test(query)) return null;
  return { query, start: slashIndex, end: text.length };
}

// The trailing "@token" before the cursor (end of text), used to drive the
// @-file-mention palette. Split into a directory part and a filter so
// "@src/co" browses src/ filtering "co" — mirrors the web composer.
export function trailingMentionToken(
  text: string,
): { query: string; dir: string; filter: string; start: number; end: number } | null {
  const match = /(?:^|\s)@(\S*)$/.exec(text);
  if (!match) return null;
  const query = match[1];
  const slash = query.lastIndexOf("/");
  const dir = slash >= 0 ? query.slice(0, slash) : "";
  const filter = slash >= 0 ? query.slice(slash + 1) : query;
  return { query, dir, filter, start: text.length - query.length - 1, end: text.length };
}

export function commandSearchBlob(command: AgentCommandDescriptor): string {
  return [command.name, command.title, command.description, command.category, command.source]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filteredCommands(
  commands: AgentCommandDescriptor[],
  query: string,
): AgentCommandDescriptor[] {
  const normalized = query.trim().toLowerCase();
  return normalized
    ? commands.filter((command) => commandSearchBlob(command).includes(normalized))
    : commands;
}

export function commandCategoryLabel(command: AgentCommandDescriptor): string {
  if (command.category) return command.category;
  if (command.source === "project") return "Project";
  if (command.source === "user") return "User";
  if (command.source === "linkshell") return "LinkShell";
  return "Built-in";
}

export function commandRawText(command: AgentCommandDescriptor, args = ""): string {
  const cleanArgs = args.trim();
  return `/${command.name}${cleanArgs ? ` ${cleanArgs}` : ""}`;
}

export function commandFromMessage(
  text: string,
  commands: AgentCommandDescriptor[],
): { command: AgentCommandDescriptor; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [token, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = commands.find((item) => item.name === token || item.title === `/${token}`);
  return command ? { command, args: rest.join(" ") } : null;
}

export function isElevatedPermissionOption(option: {
  id: string;
  label: string;
  kind: "allow" | "deny" | "other";
}): boolean {
  if (option.kind !== "allow") return false;
  const token = `${option.id} ${option.label}`.toLowerCase();
  return (
    token.includes("always") ||
    token.includes("forever") ||
    token.includes("session") ||
    token.includes("profile") ||
    token.includes("full") ||
    token.includes("workspace") ||
    token.includes("全部") ||
    token.includes("总是") ||
    token.includes("永久") ||
    token.includes("会话")
  );
}
