import { JsonRpcStdioTransport } from "./json-rpc.js";
import { listCodexStoredSessions, type CodexStoredSession } from "./codex-sessions.js";
import type { AgentFraming, AgentProtocol } from "./provider-resolver.js";

type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";
type AgentCollaborationMode = "default" | "plan";

function normalizeMcpServers(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([name, config]) => {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return { name, ...config as Record<string, unknown> };
    }
    return { name, config };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function remoteSessionEntries(value: unknown): unknown[] {
  const raw = asRecord(value);
  return Array.isArray(value) ? value :
    Array.isArray(raw?.threads) ? raw.threads :
    Array.isArray(raw?.sessions) ? raw.sessions :
    Array.isArray(raw?.items) ? raw.items :
    [];
}

function normalizeRemoteSession(entry: unknown, fallback?: CodexStoredSession): CodexStoredSession | undefined {
  if (typeof entry === "string" && entry.trim()) {
    return fallback ?? { id: entry, cwd: "", lastModified: Date.now() };
  }
  const session = asRecord(entry);
  if (!session) return fallback;
  const nestedThread = asRecord(session.thread);
  const source = nestedThread ?? session;
  const id = firstString(source, ["id", "threadId", "sessionId", "agentSessionId"]) ?? fallback?.id;
  if (!id) return undefined;
  return {
    id,
    cwd: firstString(source, ["cwd", "workingDirectory", "workspacePath"]) ?? fallback?.cwd ?? "",
    title: firstString(source, ["title", "name", "summary", "thread_name"]) ?? fallback?.title,
    createdAt: parseTimestamp(source.createdAt ?? source.created_at) ?? fallback?.createdAt,
    lastModified: parseTimestamp(source.lastActivityAt ?? source.updatedAt ?? source.modifiedAt ?? source.lastModified ?? source.updated_at) ??
      fallback?.lastModified ??
      Date.now(),
    archived: typeof source.archived === "boolean" ? source.archived : fallback?.archived,
    status: firstString(source, ["status", "state", "phase"]) ?? fallback?.status,
    runningTurnId: firstString(source, ["runningTurnId", "running_turn_id", "turnId", "activeTurnId"]) ?? fallback?.runningTurnId,
  };
}

function mergeCodexSessionLists(remote: unknown, local: { sessions: CodexStoredSession[] }): { sessions: CodexStoredSession[] } {
  const byId = new Map(local.sessions.map((session) => [session.id, session]));
  for (const entry of remoteSessionEntries(remote)) {
    const id = typeof entry === "string"
      ? entry
      : (() => {
          const session = asRecord(entry);
          const source = asRecord(session?.thread) ?? session;
          return source ? firstString(source, ["id", "threadId", "sessionId", "agentSessionId"]) : undefined;
        })();
    const merged = normalizeRemoteSession(entry, id ? byId.get(id) : undefined);
    if (merged?.id) byId.set(merged.id, merged);
  }
  return {
    sessions: [...byId.values()].sort((a, b) => b.lastModified - a.lastModified),
  };
}

function permissionsForMode(
  mode: AgentPermissionMode | undefined,
  cwd: string,
): unknown | undefined {
  if (!mode) return undefined;
  if (mode === "full_access") return { type: "disabled" };

  return {
    type: "managed",
    network: { enabled: false },
    fileSystem: {
      type: "restricted",
      entries: [
        {
          path: { type: "path", path: cwd },
          access: mode === "workspace_write" ? "write" : "read",
        },
      ],
    },
  };
}

export class AcpClient {
  private readonly transport: JsonRpcStdioTransport;
  private readonly protocol: AgentProtocol;
  private readonly cwd: string;

  constructor(input: {
    command: string;
    protocol: AgentProtocol;
    framing: AgentFraming;
    cwd: string;
    onNotification: (method: string, params: unknown) => void;
    onRequest: (method: string, params: unknown) => Promise<unknown> | unknown;
    onExit: (message: string) => void;
  }) {
    this.protocol = input.protocol;
    this.cwd = input.cwd;
    this.transport = new JsonRpcStdioTransport(
      input.command,
      input.framing,
      input.onNotification,
      input.onRequest,
      input.onExit,
    );
    this.transport.start(input.cwd);
  }

  async initialize(): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      const result = await this.transport.request("initialize", {
        clientInfo: { name: "LinkShell", version: "0.1" },
        capabilities: { experimentalApi: true },
      });
      this.transport.notify("initialized", {});
      return result;
    }
    return this.transport.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "LinkShell", version: "0.1" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  newSession(input: { cwd: string; mcpServers?: unknown }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/start", {
        cwd: input.cwd,
        sessionStartSource: "startup",
      });
    }
    return this.transport.request("session/new", {
      cwd: input.cwd,
      mcpServers: normalizeMcpServers(input.mcpServers),
    });
  }

  loadSession(input: { sessionId: string; cwd: string; mcpServers?: unknown }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/resume", {
        threadId: input.sessionId,
        cwd: input.cwd,
        excludeTurns: false,
      });
    }
    return this.transport.request("session/load", {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: normalizeMcpServers(input.mcpServers),
    });
  }

  async listSessions(): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      const localSessions = listCodexStoredSessions(this.cwd);
      try {
        const remoteSessions = await this.transport.request("thread/list", { limit: 200 });
        return mergeCodexSessionLists(remoteSessions, localSessions);
      } catch {
        return localSessions;
      }
    }
    return this.transport.request("session/list", {});
  }

  listModels(): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("model/list", {});
    }
    return Promise.resolve(undefined);
  }

  listTurns(input: { sessionId: string; limit?: number }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/turns/list", {
        threadId: input.sessionId,
        limit: input.limit ?? 200,
      });
    }
    return Promise.resolve(undefined);
  }

  prompt(input: {
    sessionId: string;
    content: unknown[];
    clientMessageId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
    cwd: string;
  }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      const collaborationSettings = {
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        ...(input.serviceTier ? { service_tier: input.serviceTier } : {}),
      };
      const collaborationMode = input.collaborationMode && input.collaborationMode !== "default"
        ? {
            mode: input.collaborationMode,
            settings: collaborationSettings,
          }
        : undefined;
      return this.transport.request("turn/start", {
        threadId: input.sessionId,
        model: input.model,
        effort: input.reasoningEffort,
        service_tier: input.serviceTier,
        permissions: permissionsForMode(input.permissionMode, input.cwd),
        collaborationMode,
        input: input.content.map((block) => {
          const raw = block as { type?: string; text?: string; data?: string };
          if (raw.type === "image" && raw.data) {
            return { type: "image", url: raw.data };
          }
          return { type: "text", text: raw.text ?? "" };
        }),
      }, null);
    }
    return this.transport.request("session/prompt", {
      sessionId: input.sessionId,
      prompt: input.content,
      _meta: {
        linkshellClientMessageId: input.clientMessageId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
      },
    }, 60_000);
  }

  cancel(input: { sessionId?: string; turnId?: string }): void {
    if (this.protocol === "codex-app-server") {
      if (!input.sessionId || !input.turnId) return;
      this.transport.request("turn/interrupt", {
        threadId: input.sessionId,
        turnId: input.turnId,
      }).catch(() => {});
      return;
    }
    this.transport.notify("session/cancel", { sessionId: input.sessionId });
  }

  respondPermission(input: {
    sessionId?: string;
    requestId: string;
    outcome: "allow" | "deny";
    optionId?: string;
  }): void {
    this.transport.notify("session/respond_permission", input);
  }

  compact(input: { sessionId: string }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/compact/start", { threadId: input.sessionId });
    }
    return Promise.reject(new Error("Native compact is not supported by this provider."));
  }

  stop(): void {
    this.transport.stop();
  }
}
