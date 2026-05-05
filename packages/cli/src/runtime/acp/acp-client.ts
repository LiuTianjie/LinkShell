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

  listSessions(): Promise<unknown> {
    if (this.protocol === "codex-app-server") {
      return this.transport.request("thread/list", { limit: 20 });
    }
    return this.transport.request("session/list", {});
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
      const collaborationMode = input.collaborationMode
        ? {
            mode: input.collaborationMode,
            settings: {
              model: input.model ?? null,
              reasoning_effort: input.reasoningEffort ?? null,
            },
          }
        : undefined;
      return this.transport.request("turn/start", {
        threadId: input.sessionId,
        model: input.model,
        effort: input.reasoningEffort,
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
