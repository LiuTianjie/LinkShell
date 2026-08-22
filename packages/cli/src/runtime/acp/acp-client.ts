import { JsonRpcStdioTransport } from "./json-rpc.js";
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

// Codex prefers a named permission profile (`permissions: ":workspace"`) and
// rejects combining it with the legacy tagged `sandboxPolicy`. Map our three
// LinkShell modes onto official profile ids; keep sandboxPolicy only for
// full_access, which has no stable named profile in the public docs.
function permissionOverridesForMode(
  mode: AgentPermissionMode | undefined,
): { permissions?: string; sandboxPolicy?: { type: string } } {
  if (!mode) return {};
  switch (mode) {
    case "read_only":
      return { permissions: ":read-only" };
    case "workspace_write":
      return { permissions: ":workspace" };
    case "full_access":
      return { sandboxPolicy: { type: "dangerFullAccess" } };
    default:
      return {};
  }
}

function approvalPolicyForMode(
  mode: AgentPermissionMode | undefined,
): string | undefined {
  if (!mode) return undefined;
  switch (mode) {
    case "read_only":
    case "workspace_write":
      // Ask before escaping the sandbox → triggers a permission request the
      // host forwards to the client as agent.v2.permission.request.
      return "on-request";
    case "full_access":
      return "never";
    default:
      return undefined;
  }
}

export class AcpClient {
  private readonly transport: JsonRpcStdioTransport;
  private readonly protocol: AgentProtocol;

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

  readSession(input: { sessionId: string; includeTurns?: boolean }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/read", {
        threadId: input.sessionId,
        includeTurns: input.includeTurns ?? true,
      });
    }
    return Promise.reject(new Error("Provider does not support readSession."));
  }

  listTurns(input: {
    sessionId: string;
    limit?: number;
    cursor?: string;
    sortDirection?: "asc" | "desc";
    itemsView?: "summary" | "full";
  }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/turns/list", {
        threadId: input.sessionId,
        limit: input.limit ?? 50,
        cursor: input.cursor,
        sortDirection: input.sortDirection ?? "desc",
        itemsView: input.itemsView ?? "full",
      });
    }
    return Promise.reject(new Error("Provider does not support listTurns."));
  }

  async listSessions(): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return this.transport.request("session/list", {});
    }
    const allThreads: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.transport.request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const raw = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
      const threads =
        Array.isArray(result) ? result :
        Array.isArray(raw?.data) ? raw.data :
        Array.isArray(raw?.threads) ? raw.threads :
        Array.isArray(raw?.sessions) ? raw.sessions :
        Array.isArray(raw?.items) ? raw.items :
        [];
      allThreads.push(...threads);
      const nextCursor =
        (typeof raw?.nextCursor === "string" && raw.nextCursor) ||
        (typeof raw?.next_cursor === "string" && raw.next_cursor) ||
        undefined;
      if (!nextCursor || threads.length === 0) break;
      cursor = nextCursor;
    }
    return { data: allThreads };
  }

  updateThreadSettings(input: {
    sessionId: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
    cwd?: string;
  }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support updateThreadSettings."));
    }
    const model = input.model?.trim();
    const collaborationMode = input.collaborationMode && input.collaborationMode !== "default"
      ? {
          mode: input.collaborationMode,
          settings: {
            model: model || "default",
            ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
          },
        }
      : undefined;
    const permission = permissionOverridesForMode(input.permissionMode);
    const approvalPolicy = approvalPolicyForMode(input.permissionMode);
    return this.transport.request("thread/settings/update", {
      threadId: input.sessionId,
      ...(model ? { model } : {}),
      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      ...permission,
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
    });
  }

  setThreadName(input: { sessionId: string; name: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support setThreadName."));
    }
    return this.transport.request("thread/name/set", {
      threadId: input.sessionId,
      name: input.name,
    });
  }

  archiveThread(input: { sessionId: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support archiveThread."));
    }
    return this.transport.request("thread/archive", { threadId: input.sessionId });
  }

  unarchiveThread(input: { sessionId: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support unarchiveThread."));
    }
    return this.transport.request("thread/unarchive", { threadId: input.sessionId });
  }

  deleteThread(input: { sessionId: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support deleteThread."));
    }
    return this.transport.request("thread/delete", { threadId: input.sessionId });
  }

  forkThread(input: { sessionId: string; lastTurnId?: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support forkThread."));
    }
    return this.transport.request("thread/fork", {
      threadId: input.sessionId,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
    });
  }

  startReview(input: { sessionId: string; prompt?: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support startReview."));
    }
    const prompt = input.prompt?.trim();
    return this.transport.request("review/start", {
      threadId: input.sessionId,
      target: prompt
        ? { type: "custom", instructions: prompt }
        : { type: "uncommittedChanges" },
    });
  }

  listSkills(input: { cwd: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support listSkills."));
    }
    return this.transport.request("skills/list", { cwds: [input.cwd] });
  }

  listMcpServers(input?: { threadId?: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support listMcpServers."));
    }
    return this.transport.request("mcpServerStatus/list", {
      detail: "full",
      ...(input?.threadId ? { threadId: input.threadId } : {}),
    });
  }

  startMcpOAuth(input: { serverName: string }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Provider does not support startMcpOAuth."));
    }
    return this.transport.request("mcpServer/oauth/login", { name: input.serverName });
  }

  listModels(): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("model/list", {});
    }
    return Promise.resolve(undefined);
  }

  prompt(input: {
    sessionId: string;
    content: unknown[];
    clientMessageId: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
    cwd: string;
  }): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      const model = input.model?.trim() || "default";
      const collaborationSettings = {
        model,
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      };
      const collaborationMode = input.collaborationMode && input.collaborationMode !== "default"
        ? {
            mode: input.collaborationMode,
            settings: collaborationSettings,
          }
        : undefined;
      const permission = permissionOverridesForMode(input.permissionMode);
      const approvalPolicy = approvalPolicyForMode(input.permissionMode);
      const turnStartParams = {
        threadId: input.sessionId,
        model,
        effort: input.reasoningEffort,
        // Named profile when we have one; sandboxPolicy only for full_access.
        // Omitted entirely when no mode is set so Codex uses config.toml.
        ...permission,
        ...(approvalPolicy ? { approvalPolicy } : {}),
        collaborationMode,
        input: input.content.map((block) => {
          const raw = block as { type?: string; text?: string; data?: string };
          if (raw.type === "image" && raw.data) {
            return { type: "image", url: raw.data };
          }
          return { type: "text", text: raw.text ?? "" };
        }),
      };
      return this.transport.request("turn/start", turnStartParams, null);
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

  steer(input: {
    sessionId: string;
    turnId: string;
    content: unknown[];
  }): Promise<unknown> {
    if (this.protocol !== "codex-app-server") {
      return Promise.reject(new Error("Active-turn steering is only supported by Codex app-server."));
    }
    return this.transport.request("turn/steer", {
      threadId: input.sessionId,
      expectedTurnId: input.turnId,
      input: input.content.map((block) => {
        const raw = block as { type?: string; text?: string; data?: string };
        if (raw.type === "image" && raw.data) {
          return { type: "image", url: raw.data };
        }
        return { type: "text", text: raw.text ?? "" };
      }),
    }, null);
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
