import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export interface ClaudeChild {
  agentId: string;
  call: string;
  teammate: boolean;
  teammateId?: string;
  teamName?: string;
  name?: string;
  task?: string;
  agentType?: string;
  model?: string;
  ts?: number;
}

/** Teammates omit meta.toolUseId. The launch result still names both exact ids. */
export class ClaudeChildIndex {
  readonly children = new Map<string, ClaudeChild>();
  private readonly launches = new Map<string, Omit<ClaudeChild, "agentId" | "call" | "teammate">>();

  observe(raw: string): void {
    let line: Json | undefined;
    try { line = object(JSON.parse(raw)); } catch { return; }
    if (!line) return;
    const content = object(line.message)?.content;
    const blocks = Array.isArray(content) ? content.map(object) : [];
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : undefined;
    for (const block of blocks) {
      if (block?.type !== "tool_use" || !["Agent", "Task"].includes(String(block.name)) || !string(block.id)) continue;
      const input = object(block.input);
      this.launches.set(String(block.id), {
        name: string(input?.name), task: string(input?.description) ?? string(input?.prompt),
        agentType: string(input?.subagent_type), model: string(input?.model),
        ts: ts !== undefined && Number.isFinite(ts) ? ts : undefined,
      });
    }
    const result = object(line.toolUseResult ?? line.tool_use_result);
    const agentId = string(result?.agentId) ?? string(result?.agent_id);
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId) || result?.error) return;
    const block = blocks.find((entry) => entry?.type === "tool_result" && !entry.is_error && this.launches.has(String(entry.tool_use_id)));
    const call = string(block?.tool_use_id);
    if (!call) return;
    const previous = this.children.get(agentId);
    // Resuming the same agent must not move its entire transcript to the new call.
    if (previous && previous.call !== call) return;
    this.children.set(agentId, {
      ...this.launches.get(call), agentId, call, teammate: result?.status === "teammate_spawned",
      teammateId: string(result?.teammate_id), teamName: string(result?.team_name),
      model: string(result?.resolvedModel) ?? string(result?.model) ?? this.launches.get(call)?.model,
    });
  }
}

/** null means the whole runtime team directory is gone; undefined is unreadable or unrelated. */
export function readClaudeTeam(configDir: string, sessionId: string, teamName: string): { members: Set<string>; updatedAt: number } | null | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(teamName)) return undefined;
  const root = join(configDir, "teams");
  const dir = join(root, teamName);
  try { lstatSync(dir); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  const path = join(dir, "config.json");
  if (!ownedFile(root, path)) return undefined;
  try {
    const team = object(JSON.parse(readFileSync(path, "utf8")));
    if (team?.name !== teamName || team.leadSessionId !== sessionId || !Array.isArray(team.members)) return undefined;
    const ids = team.members.map((member) => string(object(member)?.agentId));
    if (ids.some((id) => !id)) return undefined;
    return { members: new Set(ids as string[]), updatedAt: statSync(path).mtimeMs };
  } catch { return undefined; }
}

/** Transcript content may name paths; only follow files inside this session. */
export function ownedFile(root: string, path: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && statSync(path).isFile();
  } catch { return false; }
}
