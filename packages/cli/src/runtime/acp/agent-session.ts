import {
  createEnvelope,
  parseTypedPayload,
  type Envelope,
} from "@linkshell/protocol";
import { AcpClient } from "./acp-client.js";
import type { AgentProvider } from "./provider-resolver.js";
import { resolveAgentCommand } from "./provider-resolver.js";

type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";

interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  isStreaming?: boolean;
}

interface AgentToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "completed" | "failed";
}

interface AgentPermission {
  requestId: string;
  toolName?: string;
  toolInput?: string;
  context?: string;
  options: { id: string; label: string; kind: "allow" | "deny" | "other" }[];
}

interface PendingPermissionWaiter {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return undefined;
}

export class AgentSessionProxy {
  private client: AcpClient | undefined;
  private agentSessionId: string | undefined;
  private status: AgentStatus = "unavailable";
  private error: string | undefined;
  private initialized = false;
  private currentTurnId: string | undefined;
  private messages: AgentMessage[] = [];
  private toolCalls = new Map<string, AgentToolCall>();
  private pendingPermissions = new Map<string, AgentPermission>();
  private permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private permissionSources = new Map<string, string>();

  constructor(
    private readonly input: {
      sessionId: string;
      cwd: string;
      provider: AgentProvider;
      command?: string;
      send: (envelope: Envelope) => void;
      verbose?: boolean;
    },
  ) {}

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "agent.initialize":
        await this.initialize();
        this.sendSnapshot();
        break;
      case "agent.session.new": {
        const payload = parseTypedPayload("agent.session.new", envelope.payload);
        await this.ensureSession(payload.cwd ?? this.input.cwd, payload.mcpServers);
        this.sendSnapshot();
        break;
      }
      case "agent.session.load": {
        const payload = parseTypedPayload("agent.session.load", envelope.payload);
        await this.ensureClient();
        if (!this.client) return;
        const result = await this.client.loadSession({
          sessionId: payload.agentSessionId,
          cwd: payload.cwd ?? this.input.cwd,
        });
        this.agentSessionId = this.extractSessionId(result) ?? payload.agentSessionId;
        this.status = "idle";
        this.error = undefined;
        this.sendSnapshot();
        break;
      }
      case "agent.session.list":
        await this.sendSessionList();
        break;
      case "agent.prompt": {
        const payload = parseTypedPayload("agent.prompt", envelope.payload);
        await this.sendPrompt(payload);
        break;
      }
      case "agent.cancel": {
        const payload = parseTypedPayload("agent.cancel", envelope.payload);
        this.cancelPendingPermissions();
        this.client?.cancel({
          sessionId: payload.agentSessionId ?? this.agentSessionId,
          turnId: this.currentTurnId,
        });
        this.currentTurnId = undefined;
        this.status = "idle";
        this.sendUpdate({ kind: "status", status: "idle" });
        break;
      }
      case "agent.permission.response": {
        const payload = parseTypedPayload("agent.permission.response", envelope.payload);
        const permission = this.pendingPermissions.get(payload.requestId);
        this.pendingPermissions.delete(payload.requestId);
        const selectedOptionId =
          payload.optionId ?? selectPermissionOption(permission, payload.outcome);
        const waiter = this.permissionWaiters.get(payload.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.permissionWaiters.delete(payload.requestId);
          waiter.resolve(formatPermissionResponse(
            this.permissionSources.get(payload.requestId),
            payload.outcome,
            selectedOptionId,
          ));
          this.permissionSources.delete(payload.requestId);
        } else {
          this.client?.respondPermission({
            sessionId: payload.agentSessionId ?? this.agentSessionId,
            requestId: payload.requestId,
            outcome: payload.outcome === "cancelled" ? "deny" : payload.outcome,
            optionId: selectedOptionId,
          });
        }
        this.status = "running";
        this.sendSnapshot();
        break;
      }
    }
  }

  stop(): void {
    this.client?.stop();
    this.client = undefined;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      this.sendCapabilities();
      return;
    }
    await this.ensureClient();
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;

    const resolved = resolveAgentCommand({
      provider: this.input.provider,
      command: this.input.command,
    });
    if (!resolved) {
      this.status = "unavailable";
      this.error = `Agent GUI requires --agent-command for ${this.input.provider}`;
      this.sendCapabilities();
      return;
    }

    try {
      this.client = new AcpClient({
        command: resolved.command,
        protocol: resolved.protocol,
        framing: resolved.framing,
        cwd: this.input.cwd,
        onNotification: (method, params) => this.handleNotification(method, params),
        onRequest: (method, params) => this.handleRequest(method, params),
        onExit: (message) => this.handleExit(message),
      });
      await this.client.initialize();
      this.initialized = true;
      this.status = "idle";
      this.error = undefined;
      this.sendCapabilities();
    } catch (error) {
      this.client?.stop();
      this.client = undefined;
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.sendCapabilities();
    }
  }

  private async ensureSession(
    cwd: string,
    mcpServers?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureClient();
    if (!this.client || this.agentSessionId) return;
    try {
      const result = await this.client.newSession({ cwd, mcpServers });
      this.agentSessionId = this.extractSessionId(result) ?? id("agent-session");
      this.status = "idle";
      this.error = undefined;
      this.sendUpdate({ kind: "status", status: "idle" });
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.sendUpdate({ kind: "error", error: this.error, status: "error" });
    }
  }

  private async sendPrompt(payload: {
    agentSessionId?: string;
    clientMessageId: string;
    contentBlocks: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[];
  }): Promise<void> {
    await this.ensureSession(this.input.cwd);
    if (!this.client || !this.agentSessionId) return;

    const content = payload.contentBlocks
      .map((block) => (block.type === "text" ? block.text ?? "" : `[${block.mimeType ?? "image"} attachment]`))
      .filter(Boolean)
      .join("\n");
    const userMessage: AgentMessage = {
      id: payload.clientMessageId,
      role: "user",
      content,
      createdAt: Date.now(),
    };
    this.messages.push(userMessage);
    this.status = "running";
    this.sendUpdate({ kind: "message", message: userMessage, status: "running" });

    try {
      const result = await this.client.prompt({
        sessionId: payload.agentSessionId ?? this.agentSessionId,
        content: payload.contentBlocks,
        clientMessageId: payload.clientMessageId,
      });
      this.currentTurnId = this.extractTurnId(result) ?? this.currentTurnId;
      if (this.status === "running") {
        this.status = "idle";
        this.sendUpdate({ kind: "status", status: "idle" });
      }
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.sendUpdate({ kind: "error", error: this.error, status: "error" });
    }
  }

  private handleRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (
      method === "session/request_permission" ||
      method.endsWith("/requestApproval") ||
      method === "mcpServer/elicitation/request" ||
      method === "item/tool/requestUserInput"
    ) {
      return this.handlePermission(params, true, method);
    }
    if (this.input.verbose) {
      process.stderr.write(`[agent:request] unsupported ${method}\n`);
    }
    return {};
  }

  private async sendSessionList(): Promise<void> {
    await this.ensureClient();
    if (!this.client) return;
    try {
      const result = await this.client.listSessions();
      this.sendUpdate({
        kind: "status",
        status: "idle",
        delta: stringify(result).slice(0, 4000),
      });
    } catch (error) {
      this.sendUpdate({
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.input.verbose) {
      process.stderr.write(`[agent] ${method} ${stringify(params).slice(0, 500)}\n`);
    }
    if (
      method === "initialized" ||
      method.startsWith("account/") ||
      method.startsWith("mcpServer/startupStatus/")
    ) {
      return;
    }
    if (method === "thread/started") {
      this.agentSessionId = this.extractSessionId(params) ?? this.agentSessionId;
      this.status = "idle";
      this.sendSnapshot();
      return;
    }
    if (method === "turn/started") {
      this.currentTurnId = this.extractTurnId(params) ?? this.currentTurnId;
      this.status = "running";
      this.sendUpdate({ kind: "status", status: "running" });
      return;
    }
    if (method === "turn/completed") {
      this.currentTurnId = undefined;
      this.status = "idle";
      this.sendUpdate({ kind: "status", status: "idle" });
      return;
    }
    if (method === "session/request_permission") {
      this.handlePermission(params, false, method);
      return;
    }
    if (method === "session/update" || method.startsWith("item/")) {
      this.handleUpdate(params);
      return;
    }
    this.handleUpdate({ method, params });
  }

  private handlePermission(
    params: unknown,
    waitForResponse: boolean,
    source?: string,
  ): Promise<unknown> | void {
    const raw = typeof params === "object" && params ? params as Record<string, unknown> : {};
    const requestId = firstString(raw, ["requestId", "id", "permissionId"]) ?? id("perm");
    const rawToolCall = typeof raw.toolCall === "object" && raw.toolCall
      ? raw.toolCall as Record<string, unknown>
      : raw;
    const permission: AgentPermission = {
      requestId,
      toolName: firstString(rawToolCall, ["toolName", "tool", "name", "title", "kind"]),
      toolInput: stringify(rawToolCall.input ?? rawToolCall.toolInput ?? rawToolCall),
      context: firstString(raw, ["context", "description", "message", "title"]),
      options: parsePermissionOptions(raw.options),
    };
    this.pendingPermissions.set(requestId, permission);
    if (source) this.permissionSources.set(requestId, source);
    this.status = "waiting_permission";
    this.input.send(createEnvelope({
      type: "agent.permission.request",
      sessionId: this.input.sessionId,
      payload: { agentSessionId: this.agentSessionId, ...permission },
    }));

    if (!waitForResponse) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.permissionWaiters.delete(requestId);
        this.permissionSources.delete(requestId);
        resolve(formatPermissionResponse(source, "cancelled", "cancelled"));
        this.sendSnapshot();
      }, PERMISSION_TIMEOUT_MS);
      this.permissionWaiters.set(requestId, { resolve, timer });
    });
  }

  private handleUpdate(params: unknown): void {
    const raw = typeof params === "object" && params ? params as Record<string, unknown> : {};
    const nested = typeof raw.params === "object" && raw.params ? raw.params as Record<string, unknown> : {};
    const text =
      firstString(raw, ["delta", "text", "content", "message"]) ??
      firstString(nested, ["delta", "text", "content", "message"]) ??
      stringify(raw.update ?? raw.params ?? params);
    const role = raw.role === "user" || raw.role === "system" ? raw.role : "assistant";

    if (firstString(raw, ["toolName", "tool", "name"])) {
      const toolCall: AgentToolCall = {
        id: firstString(raw, ["toolCallId", "callId", "id"]) ?? id("tool"),
        name: firstString(raw, ["toolName", "tool", "name"]) ?? "tool",
        input: stringify(raw.input ?? raw.toolInput ?? ""),
        output: stringify(raw.output ?? raw.result ?? ""),
        status: raw.status === "completed" || raw.status === "failed" || raw.status === "running"
          ? raw.status
          : "running",
      };
      this.toolCalls.set(toolCall.id, toolCall);
      this.sendUpdate({ kind: "tool_call", toolCall, status: "running" });
      return;
    }

    const message: AgentMessage = {
      id: firstString(raw, ["messageId", "id"]) ?? id("msg"),
      role,
      content: text,
      createdAt: Date.now(),
      isStreaming: raw.done === false || raw.isStreaming === true,
    };
    this.messages.push(message);
    if (this.messages.length > 100) this.messages.shift();
    this.status = raw.done === true ? "idle" : "running";
    this.sendUpdate({
      kind: "message",
      message,
      status: this.status === "running" ? "running" : "idle",
    });
  }

  private handleExit(message: string): void {
    this.cancelPendingPermissions();
    this.status = "error";
    this.error = message;
    this.client = undefined;
    this.sendUpdate({ kind: "error", error: message, status: "error" });
  }

  private cancelPendingPermissions(): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(formatPermissionResponse(
        this.permissionSources.get(requestId),
        "cancelled",
        "cancelled",
      ));
      this.pendingPermissions.delete(requestId);
      this.permissionSources.delete(requestId);
    }
    this.permissionWaiters.clear();
  }

  private sendCapabilities(): void {
    const enabled = Boolean(this.client && this.initialized && !this.error);
    this.input.send(createEnvelope({
      type: "agent.capabilities",
      sessionId: this.input.sessionId,
      payload: {
        enabled,
        provider: this.input.provider,
        protocolVersion: 1,
        error: enabled ? undefined : this.error,
        supportsSessionList: enabled,
        supportsSessionLoad: enabled,
        supportsImages: false,
        supportsAudio: false,
        supportsPermission: enabled,
        supportsPlan: false,
        supportsCancel: enabled,
      },
    }));
  }

  private sendSnapshot(): void {
    this.input.send(createEnvelope({
      type: "agent.snapshot",
      sessionId: this.input.sessionId,
      payload: {
        agentSessionId: this.agentSessionId,
        messages: this.messages,
        toolCalls: [...this.toolCalls.values()],
        pendingPermissions: [...this.pendingPermissions.values()],
        status: this.status,
        error: this.error,
      },
    }));
  }

  private sendUpdate(payload: {
    kind: "message" | "message_delta" | "tool_call" | "tool_result" | "plan" | "status" | "error";
    message?: AgentMessage;
    delta?: string;
    toolCall?: AgentToolCall;
    status?: "idle" | "running" | "waiting_permission" | "error";
    error?: string;
  }): void {
    this.input.send(createEnvelope({
      type: "agent.update",
      sessionId: this.input.sessionId,
      payload: { agentSessionId: this.agentSessionId, ...payload },
    }));
  }

  private extractSessionId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.thread && typeof raw.thread === "object") {
      const threadId = firstString(raw.thread as Record<string, unknown>, ["id", "threadId"]);
      if (threadId) return threadId;
    }
    return firstString(raw, ["sessionId", "id", "agentSessionId"]);
  }

  private extractTurnId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.turn && typeof raw.turn === "object") {
      const turnId = firstString(raw.turn as Record<string, unknown>, ["id", "turnId"]);
      if (turnId) return turnId;
    }
    return firstString(raw, ["turnId", "id"]);
  }
}

function parsePermissionOptions(value: unknown): AgentPermission["options"] {
  if (!Array.isArray(value)) {
    return [
      { id: "allow", label: "允许", kind: "allow" },
      { id: "deny", label: "拒绝", kind: "deny" },
    ];
  }

  const options = value
    .map((entry, index) => {
      const raw = typeof entry === "object" && entry ? entry as Record<string, unknown> : {};
      const idValue = raw.optionId ?? raw.id ?? raw.kind ?? `option-${index + 1}`;
      const labelValue = raw.name ?? raw.label ?? raw.kind ?? String(idValue);
      const id = String(idValue);
      const label = String(labelValue);
      const normalized = `${id} ${label}`.toLowerCase();
      const kind: AgentPermission["options"][number]["kind"] = normalized.includes("reject") || normalized.includes("deny")
        ? "deny"
        : normalized.includes("allow")
          ? "allow"
          : "other";
      return { id, label, kind };
    })
    .filter((option) => option.id.length > 0 && option.label.length > 0);

  return options.length > 0
    ? options
    : [
        { id: "allow", label: "允许", kind: "allow" },
        { id: "deny", label: "拒绝", kind: "deny" },
      ];
}

function selectPermissionOption(
  permission: AgentPermission | undefined,
  outcome: "allow" | "deny" | "cancelled",
): string {
  if (outcome === "cancelled") return "cancelled";
  const option = permission?.options.find((item) => item.kind === outcome);
  return option?.id ?? outcome;
}

function formatPermissionResponse(
  source: string | undefined,
  outcome: "allow" | "deny" | "cancelled",
  optionId: string,
): unknown {
  if (source === "item/commandExecution/requestApproval" || source === "item/fileChange/requestApproval") {
    return { decision: outcome === "allow" ? "accept" : outcome === "deny" ? "decline" : "cancel" };
  }
  if (source === "item/permissions/requestApproval") {
    if (outcome === "allow") {
      return {
        permissions: { type: "managed", network: { enabled: true }, fileSystem: { type: "fullAccess" } },
        scope: optionId.includes("session") ? "session" : "turn",
      };
    }
    return { permissions: { type: "managed", network: { enabled: false }, fileSystem: { type: "readOnly" } } };
  }
  return {
    outcome:
      outcome === "cancelled"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId },
  };
}
