import { basename } from "node:path";
import {
  createEnvelope,
  parseTypedPayload,
  type Envelope,
} from "@linkshell/protocol";
import { AcpClient } from "./acp-client.js";
import type { AgentProvider } from "./provider-resolver.js";
import { resolveAgentCommand } from "./provider-resolver.js";

type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";
type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";

interface AgentContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

interface AgentToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  createdAt?: number;
  status: "pending" | "running" | "completed" | "failed";
}

interface AgentPlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

interface AgentPermission {
  requestId: string;
  toolName?: string;
  toolInput?: string;
  context?: string;
  options: { id: string; label: string; kind: "allow" | "deny" | "other" }[];
}

interface AgentConversation {
  id: string;
  agentSessionId?: string;
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: AgentPermissionMode;
  status: AgentStatus;
  archived: boolean;
  lastMessagePreview?: string;
  lastActivityAt: number;
  createdAt: number;
}

interface AgentTimelineItem {
  id: string;
  conversationId: string;
  type: "message" | "tool_call" | "plan" | "permission" | "status" | "error";
  role?: "user" | "assistant" | "system";
  content?: AgentContentBlock[];
  text?: string;
  toolCall?: AgentToolCall;
  plan?: AgentPlanStep[];
  permission?: AgentPermission;
  status?: AgentStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
  isStreaming?: boolean;
}

interface PendingPermissionWaiter {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMELINE_ITEMS = 200;

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value ? value as Record<string, unknown> : undefined;
}

function firstString(value: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return undefined;
}

function extractItem(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  return asRecord(raw.item) ?? raw;
}

function stringifyDefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringify(value);
}

function appendCapped(current: string | undefined, delta: string, maxLength: number): string {
  const next = `${current ?? ""}${delta}`;
  if (next.length <= maxLength) return next;
  return next.slice(next.length - maxLength);
}

function decodeBase64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeToolStatus(value: unknown, completedFallback = false): AgentToolCall["status"] {
  if (value === "completed" || value === "succeeded" || value === "success" || value === "applied") {
    return "completed";
  }
  if (value === "failed" || value === "error" || value === "declined" || value === "cancelled") {
    return "failed";
  }
  if (value === "pending" || value === "queued") return "pending";
  if (value === "running" || value === "inProgress" || value === "executing") return "running";
  return completedFallback ? "completed" : "running";
}

function normalizePlanStatus(value: unknown): AgentPlanStep["status"] {
  if (value === "completed" || value === "done") return "completed";
  if (value === "inProgress" || value === "running" || value === "active") return "in_progress";
  return "pending";
}

function nameFromToolMethod(method: string): string {
  if (method.includes("commandExecution")) return "命令";
  if (method.includes("fileChange")) return "文件修改";
  if (method.includes("mcpToolCall")) return "MCP 工具";
  return "工具";
}

function toolNameFromItem(item: Record<string, unknown>): string | undefined {
  const itemType = firstString(item, ["type"]);
  if (itemType === "commandExecution") return "命令";
  if (itemType === "fileChange") return "文件修改";
  if (itemType === "mcpToolCall") {
    const server = firstString(item, ["server"]);
    const tool = firstString(item, ["tool", "toolName", "name"]);
    return [server, tool].filter(Boolean).join(" · ") || "MCP 工具";
  }
  if (itemType === "dynamicToolCall") {
    const namespace = firstString(item, ["namespace"]);
    const tool = firstString(item, ["tool", "toolName", "name"]);
    return [namespace, tool].filter(Boolean).join(" · ") || "工具";
  }
  return firstString(item, ["toolName", "tool", "name", "title"]) ?? itemType;
}

function summarizeFileChanges(changes: unknown[]): string | undefined {
  const lines = changes
    .map((change) => {
      const raw = asRecord(change);
      if (!raw) return undefined;
      const path =
        firstString(raw, ["path", "file", "filePath", "absolutePath", "relativePath"]) ??
        firstString(asRecord(raw.update), ["path", "file", "filePath"]);
      const kind = firstString(raw, ["kind", "type", "operation", "action"]);
      return [kind, path].filter(Boolean).join(" ");
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.slice(0, 8).join("\n") : undefined;
}

function toolInputFromItem(item: Record<string, unknown>): string | undefined {
  const itemType = firstString(item, ["type"]);
  if (itemType === "commandExecution") {
    const command = firstString(item, ["command"]);
    const cwd = firstString(item, ["cwd"]);
    if (command && cwd) return `${command}\n\ncwd: ${cwd}`;
    return command ?? cwd;
  }
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return summarizeFileChanges(changes);
  }
  return stringifyDefined(item.arguments ?? item.input ?? item.toolInput);
}

function titleFromCwd(cwd: string): string {
  return basename(cwd) || cwd || "Agent";
}

function textFromBlocks(blocks: AgentContentBlock[]): string {
  return blocks
    .map((block) => block.type === "text" ? block.text ?? "" : `[${block.mimeType ?? "image"} attachment]`)
    .filter(Boolean)
    .join("\n");
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export class AgentWorkspaceProxy {
  private client: AcpClient | undefined;
  private initialized = false;
  private status: AgentStatus = "unavailable";
  private error: string | undefined;
  private activeConversationId: string | undefined;
  private currentTurnId: string | undefined;
  private conversations = new Map<string, AgentConversation>();
  private conversationByAgentSessionId = new Map<string, string>();
  private timelines = new Map<string, AgentTimelineItem[]>();
  private toolOutputBuffers = new Map<string, string>();
  private pendingPermissions = new Map<string, AgentPermission>();
  private permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private permissionSources = new Map<string, string>();
  private toolConversationIds = new Map<string, string>();

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
      case "agent.v2.capabilities.request":
        await this.initialize();
        this.sendCapabilities();
        break;
      case "agent.v2.conversation.open": {
        const payload = parseTypedPayload("agent.v2.conversation.open", envelope.payload);
        await this.openConversation(payload);
        break;
      }
      case "agent.v2.conversation.list": {
        const payload = parseTypedPayload("agent.v2.conversation.list", envelope.payload);
        const conversations = [...this.conversations.values()].filter((conversation) =>
          payload.includeArchived ? true : !conversation.archived,
        );
        this.input.send(createEnvelope({
          type: "agent.v2.conversation.list.result",
          sessionId: this.input.sessionId,
          payload: { conversations },
        }));
        break;
      }
      case "agent.v2.snapshot.request": {
        const payload = parseTypedPayload("agent.v2.snapshot.request", envelope.payload);
        this.sendSnapshot(payload.conversationId);
        break;
      }
      case "agent.v2.prompt": {
        const payload = parseTypedPayload("agent.v2.prompt", envelope.payload);
        await this.sendPrompt(payload);
        break;
      }
      case "agent.v2.cancel": {
        const payload = parseTypedPayload("agent.v2.cancel", envelope.payload);
        const conversation = this.conversations.get(payload.conversationId);
        this.cancelPendingPermissions(payload.conversationId);
        this.client?.cancel({
          sessionId: conversation?.agentSessionId,
          turnId: this.currentTurnId,
        });
        this.currentTurnId = undefined;
        this.updateConversationStatus(payload.conversationId, "idle");
        this.emitStatus(payload.conversationId, "idle", "已停止");
        break;
      }
      case "agent.v2.permission.respond": {
        const payload = parseTypedPayload("agent.v2.permission.respond", envelope.payload);
        this.respondPermission(payload);
        break;
      }
    }
  }

  stop(): void {
    this.client?.stop();
    this.client = undefined;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
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
      this.error = `Agent Workspace requires --agent-command for ${this.input.provider}`;
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
    } catch (error) {
      this.client?.stop();
      this.client = undefined;
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private sendCapabilities(): void {
    const enabled = Boolean(this.client && this.initialized && !this.error);
    this.input.send(createEnvelope({
      type: "agent.v2.capabilities",
      sessionId: this.input.sessionId,
      payload: {
        enabled,
        provider: this.input.provider,
        protocolVersion: 1,
        workspaceProtocolVersion: 2,
        error: enabled ? undefined : this.error,
        supportsSessionList: enabled,
        supportsSessionLoad: enabled,
        supportsImages: false,
        supportsAudio: false,
        supportsPermission: enabled,
        supportsPlan: enabled,
        supportsCancel: enabled,
      },
    }));
  }

  private async openConversation(payload: {
    conversationId?: string;
    agentSessionId?: string;
    cwd?: string;
    provider?: AgentProvider;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    title?: string;
  }): Promise<AgentConversation | undefined> {
    await this.ensureClient();
    this.sendCapabilities();
    if (!this.client) return undefined;

    const cwd = payload.cwd ?? this.input.cwd;
    let agentSessionId = payload.agentSessionId;
    const existingConversation =
      (payload.conversationId ? this.conversations.get(payload.conversationId) : undefined) ??
      (agentSessionId ? this.conversations.get(this.conversationByAgentSessionId.get(agentSessionId) ?? "") : undefined);

    if (existingConversation) {
      this.activeConversationId = existingConversation.id;
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        sessionId: this.input.sessionId,
        payload: {
          conversation: existingConversation,
          snapshot: this.timelines.get(existingConversation.id) ?? [],
        },
      }));
      return existingConversation;
    }

    try {
      const result = agentSessionId
        ? await this.client.loadSession({ sessionId: agentSessionId, cwd })
        : await this.client.newSession({ cwd });
      agentSessionId = this.extractSessionId(result) ?? agentSessionId ?? id("agent-session");
      const now = Date.now();
      const conversationId = payload.conversationId ?? `agent:${agentSessionId}`;
      const conversation: AgentConversation = {
        id: conversationId,
        agentSessionId,
        provider: payload.provider ?? this.input.provider,
        cwd,
        title: payload.title ?? titleFromCwd(cwd),
        model: payload.model,
        reasoningEffort: payload.reasoningEffort,
        permissionMode: payload.permissionMode,
        status: "idle",
        archived: false,
        lastActivityAt: now,
        createdAt: now,
      };
      this.conversations.set(conversation.id, conversation);
      this.conversationByAgentSessionId.set(agentSessionId, conversation.id);
      this.activeConversationId = conversation.id;
      this.timelines.set(conversation.id, this.timelines.get(conversation.id) ?? []);
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        sessionId: this.input.sessionId,
        payload: { conversation, snapshot: this.timelines.get(conversation.id) ?? [] },
      }));
      return conversation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = "error";
      this.error = message;
      const fallbackId = payload.conversationId ?? id("agent-conversation");
      const now = Date.now();
      const conversation: AgentConversation = {
        id: fallbackId,
        provider: payload.provider ?? this.input.provider,
        cwd,
        title: payload.title ?? titleFromCwd(cwd),
        model: payload.model,
        reasoningEffort: payload.reasoningEffort,
        permissionMode: payload.permissionMode,
        status: "error",
        archived: false,
        lastMessagePreview: message,
        lastActivityAt: now,
        createdAt: now,
      };
      this.conversations.set(conversation.id, conversation);
      this.activeConversationId = conversation.id;
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: now,
      });
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        sessionId: this.input.sessionId,
        payload: { conversation, snapshot: this.timelines.get(conversation.id) ?? [] },
      }));
      return conversation;
    }
  }

  private async sendPrompt(payload: {
    conversationId: string;
    clientMessageId: string;
    contentBlocks: AgentContentBlock[];
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
  }): Promise<void> {
    const conversation =
      this.conversations.get(payload.conversationId) ??
      await this.openConversation({ conversationId: payload.conversationId });
    if (!conversation || !this.client || !conversation.agentSessionId) return;

    conversation.model = payload.model ?? conversation.model;
    conversation.reasoningEffort = payload.reasoningEffort ?? conversation.reasoningEffort;
    conversation.permissionMode = payload.permissionMode ?? conversation.permissionMode;
    conversation.status = "running";
    conversation.lastActivityAt = Date.now();
    this.activeConversationId = conversation.id;

    const userText = textFromBlocks(payload.contentBlocks);
    this.addItem(conversation.id, {
      id: payload.clientMessageId,
      conversationId: conversation.id,
      type: "message",
      role: "user",
      content: payload.contentBlocks,
      text: userText,
      createdAt: Date.now(),
    });
    this.emitConversation(conversation);

    try {
      const result = await this.client.prompt({
        sessionId: conversation.agentSessionId,
        content: payload.contentBlocks,
        clientMessageId: payload.clientMessageId,
        model: payload.model,
        reasoningEffort: payload.reasoningEffort,
        permissionMode: payload.permissionMode,
        cwd: conversation.cwd,
      });
      this.currentTurnId = this.extractTurnId(result) ?? this.currentTurnId;
      if (conversation.status === "running") {
        this.updateConversationStatus(conversation.id, "idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateConversationStatus(conversation.id, "error", message);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: Date.now(),
      });
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
      process.stderr.write(`[agent:v2:request] unsupported ${method}\n`);
    }
    return {};
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.input.verbose) {
      process.stderr.write(`[agent:v2] ${method} ${stringify(params).slice(0, 500)}\n`);
    }
    if (
      method === "initialized" ||
      method.startsWith("account/") ||
      method.startsWith("mcpServer/startupStatus/") ||
      method === "thread/status/changed" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/diff/updated" ||
      method === "serverRequest/resolved" ||
      method === "mcpServer/oauthLogin/completed"
    ) {
      return;
    }

    const conversationId = this.conversationIdFromParams(params) ?? this.activeConversationId;
    if (method === "thread/started") {
      const agentSessionId = this.extractSessionId(params);
      if (agentSessionId && conversationId) {
        this.conversationByAgentSessionId.set(agentSessionId, conversationId);
        const conversation = this.conversations.get(conversationId);
        if (conversation) conversation.agentSessionId = agentSessionId;
      }
      return;
    }
    if (method === "turn/started") {
      this.currentTurnId = this.extractTurnId(params) ?? this.currentTurnId;
      if (conversationId) this.updateConversationStatus(conversationId, "running");
      return;
    }
    if (method === "turn/completed") {
      this.currentTurnId = undefined;
      if (conversationId) this.updateConversationStatus(conversationId, "idle");
      return;
    }
    if (method === "session/request_permission") {
      this.handlePermission(params, false, method);
      return;
    }

    switch (method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        return;
      case "turn/plan/updated":
        this.handlePlanUpdated(params);
        return;
      case "item/plan/delta":
        this.handlePlanDelta(params);
        return;
      case "item/started":
        this.handleItemStarted(params);
        return;
      case "item/completed":
        this.handleItemCompleted(params);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
        this.handleToolDelta(method, params);
        return;
      case "item/fileChange/patchUpdated":
        this.handleFilePatchUpdated(params);
        return;
      case "command/exec/outputDelta":
        this.handleCommandExecDelta(params);
        return;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "item/commandExecution/terminalInteraction":
        return;
    }

    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
  }

  private handleAgentMessageDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.activeConversationId;
    if (!conversationId) return;
    const itemId = firstString(raw, ["itemId", "id", "messageId"]) ?? id("msg");
    const delta = firstString(raw, ["delta", "text", "content"]);
    if (!delta) return;
    const existing = this.findItem(conversationId, itemId);
    const text = `${existing?.text ?? ""}${delta}`;
    const item: AgentTimelineItem = {
      id: itemId,
      conversationId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      text,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: true,
    };
    this.upsertItem(conversationId, item);
    this.updateConversationPreview(conversationId, text, "running");
  }

  private handlePlanUpdated(params: unknown): void {
    const raw = asRecord(params);
    const conversationId = this.conversationIdFromParams(raw) ?? this.activeConversationId;
    if (!conversationId) return;
    const plan = Array.isArray(raw?.plan) ? raw.plan : [];
    const steps = plan
      .map((entry, index) => {
        const step = asRecord(entry);
        const text = firstString(step, ["text", "title", "description", "message"]);
        if (!text) return undefined;
        return {
          id: firstString(step, ["id"]) ?? `plan-${index + 1}`,
          text,
          status: normalizePlanStatus(step?.status),
        } satisfies AgentPlanStep;
      })
      .filter((step): step is AgentPlanStep => Boolean(step));
    if (steps.length === 0) return;
    this.upsertItem(conversationId, {
      id: "plan",
      conversationId,
      type: "plan",
      plan: steps,
      createdAt: this.findItem(conversationId, "plan")?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private handlePlanDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.activeConversationId;
    if (!conversationId) return;
    const itemId = firstString(raw, ["itemId", "id"]) ?? "plan";
    const delta = firstString(raw, ["delta", "text"]);
    if (!delta) return;
    const existing = this.findItem(conversationId, itemId);
    const text = `${existing?.text ?? ""}${delta}`;
    const step: AgentPlanStep = { id: itemId, text, status: "in_progress" };
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "plan",
      text,
      plan: [step],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private handleItemStarted(params: unknown): void {
    const item = extractItem(params);
    if (!item) return;
    const itemType = firstString(item, ["type"]);
    if (itemType === "agentMessage" || itemType === "assistantMessage") {
      this.handleCompletedMessageItem(item, true);
      return;
    }
    if (itemType === "plan") {
      this.handlePlanUpdated({ plan: [item] });
      return;
    }
    const conversationId = this.conversationIdFromParams(item) ?? this.activeConversationId;
    const toolCall = this.toolCallFromItem(item, "running");
    if (!conversationId || !toolCall) return;
    this.toolConversationIds.set(toolCall.id, conversationId);
    this.upsertTool(conversationId, toolCall);
  }

  private handleItemCompleted(params: unknown): void {
    const item = extractItem(params);
    if (!item) return;
    const itemType = firstString(item, ["type"]);
    if (itemType === "agentMessage" || itemType === "assistantMessage") {
      this.handleCompletedMessageItem(item, false);
      return;
    }
    const conversationId = this.conversationIdFromParams(item) ?? this.activeConversationId;
    const toolCall = this.toolCallFromItem(item, normalizeToolStatus(item.status, true));
    if (!conversationId || !toolCall) return;
    const bufferedOutput = this.toolOutputBuffers.get(toolCall.id);
    if (bufferedOutput && !toolCall.output) toolCall.output = bufferedOutput;
    this.upsertTool(conversationId, toolCall);
  }

  private handleToolDelta(method: string, params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const itemId = firstString(raw, ["itemId", "id", "toolCallId"]) ?? id("tool");
    const delta = firstString(raw, ["delta", "message", "text"]);
    if (!delta) return;
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(itemId) ??
      this.activeConversationId;
    if (!conversationId) return;
    const output = appendCapped(this.toolOutputBuffers.get(itemId), delta, 6000);
    this.toolOutputBuffers.set(itemId, output);
    const existing = this.findTool(conversationId, itemId);
    this.upsertTool(conversationId, {
      id: itemId,
      name: existing?.name ?? nameFromToolMethod(method),
      input: existing?.input,
      output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "running",
    });
  }

  private handleFilePatchUpdated(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const itemId = firstString(raw, ["itemId", "id"]) ?? id("file");
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(itemId) ??
      this.activeConversationId;
    if (!conversationId) return;
    const output = summarizeFileChanges(Array.isArray(raw.changes) ? raw.changes : []);
    const existing = this.findTool(conversationId, itemId);
    this.upsertTool(conversationId, {
      id: itemId,
      name: existing?.name ?? "文件修改",
      input: existing?.input,
      output: output || existing?.output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: existing?.status ?? "running",
    });
  }

  private handleCommandExecDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const processId = firstString(raw, ["processId", "id"]) ?? id("exec");
    const delta =
      firstString(raw, ["delta", "text"]) ??
      decodeBase64(firstString(raw, ["deltaBase64"]));
    if (!delta) return;
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(processId) ??
      this.activeConversationId;
    if (!conversationId) return;
    const output = appendCapped(this.toolOutputBuffers.get(processId), delta, 6000);
    this.toolOutputBuffers.set(processId, output);
    const existing = this.findTool(conversationId, processId);
    this.upsertTool(conversationId, {
      id: processId,
      name: existing?.name ?? "命令输出",
      input: existing?.input,
      output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "running",
    });
  }

  private handleCompletedMessageItem(item: Record<string, unknown>, streaming: boolean): void {
    const conversationId = this.conversationIdFromParams(item) ?? this.activeConversationId;
    if (!conversationId) return;
    const itemId = firstString(item, ["id"]) ?? id("msg");
    const existing = this.findItem(conversationId, itemId);
    const content = firstString(item, ["text", "content", "message"]) ?? existing?.text;
    if (!content) return;
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      text: content,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: streaming,
    });
    this.updateConversationPreview(conversationId, content, streaming ? "running" : "idle");
  }

  private handleSessionUpdate(params: unknown): void {
    const raw = asRecord(params) ?? {};
    const nested = asRecord(raw.params) ?? {};
    const text =
      firstString(raw, ["delta", "text", "content", "message"]) ??
      firstString(nested, ["delta", "text", "content", "message"]);
    if (!text) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.activeConversationId;
    if (!conversationId) return;
    if (firstString(raw, ["toolName", "tool", "name"])) {
      this.upsertTool(conversationId, {
        id: firstString(raw, ["toolCallId", "callId", "id"]) ?? id("tool"),
        name: firstString(raw, ["toolName", "tool", "name"]) ?? "tool",
        input: stringify(raw.input ?? raw.toolInput ?? ""),
        output: stringify(raw.output ?? raw.result ?? ""),
        createdAt: Date.now(),
        status: raw.status === "completed" || raw.status === "failed" || raw.status === "running"
          ? raw.status
          : "running",
      });
      return;
    }
    const role = raw.role === "user" || raw.role === "system" ? raw.role : "assistant";
    this.upsertItem(conversationId, {
      id: firstString(raw, ["messageId", "id"]) ?? id("msg"),
      conversationId,
      type: "message",
      role,
      content: [{ type: "text", text }],
      text,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isStreaming: raw.done === false || raw.isStreaming === true,
    });
    this.updateConversationPreview(conversationId, text, raw.done === true ? "idle" : "running");
  }

  private toolCallFromItem(
    item: Record<string, unknown>,
    fallbackStatus: AgentToolCall["status"],
  ): AgentToolCall | undefined {
    const itemId = firstString(item, ["id", "itemId", "toolCallId"]);
    if (!itemId) return undefined;
    const itemType = firstString(item, ["type"]);
    const output =
      firstString(item, ["aggregatedOutput", "output", "stdout", "stderr"]) ??
      stringifyDefined(item.result ?? item.error ?? item.contentItems);
    return {
      id: itemId,
      name: toolNameFromItem(item) ?? itemType ?? "tool",
      input: toolInputFromItem(item),
      output: output ?? this.toolOutputBuffers.get(itemId),
      createdAt: Date.now(),
      status: normalizeToolStatus(item.status, fallbackStatus === "completed"),
    };
  }

  private handlePermission(
    params: unknown,
    waitForResponse: boolean,
    source?: string,
  ): Promise<unknown> | void {
    const raw = asRecord(params) ?? {};
    const conversationId = this.conversationIdFromParams(raw) ?? this.activeConversationId;
    if (!conversationId) return waitForResponse ? Promise.resolve({ outcome: { outcome: "cancelled" } }) : undefined;
    const requestId = firstString(raw, ["requestId", "id", "permissionId"]) ?? id("perm");
    const rawToolCall = asRecord(raw.toolCall) ?? raw;
    const permission: AgentPermission = {
      requestId,
      toolName: firstString(rawToolCall, ["toolName", "tool", "name", "title", "kind"]),
      toolInput: stringify(rawToolCall.input ?? rawToolCall.toolInput ?? rawToolCall),
      context: firstString(raw, ["context", "description", "message", "title"]),
      options: parsePermissionOptions(raw.options),
    };
    this.pendingPermissions.set(requestId, permission);
    if (source) this.permissionSources.set(requestId, source);
    this.updateConversationStatus(conversationId, "waiting_permission");
    const item: AgentTimelineItem = {
      id: `permission:${requestId}`,
      conversationId,
      type: "permission",
      permission,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.upsertItem(conversationId, item);
    this.input.send(createEnvelope({
      type: "agent.v2.permission.request",
      sessionId: this.input.sessionId,
      payload: { conversationId, ...permission, item },
    }));

    if (!waitForResponse) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.permissionWaiters.delete(requestId);
        this.permissionSources.delete(requestId);
        resolve(formatPermissionResponse(source, "cancelled", "cancelled"));
        this.updateConversationStatus(conversationId, "idle");
      }, PERMISSION_TIMEOUT_MS);
      this.permissionWaiters.set(requestId, { resolve, timer });
    });
  }

  private respondPermission(payload: {
    conversationId: string;
    requestId: string;
    outcome: "allow" | "deny" | "cancelled";
    optionId?: string;
  }): void {
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
        sessionId: this.conversations.get(payload.conversationId)?.agentSessionId,
        requestId: payload.requestId,
        outcome: payload.outcome === "cancelled" ? "deny" : payload.outcome,
        optionId: selectedOptionId,
      });
    }
    this.updateConversationStatus(payload.conversationId, "running");
  }

  private addItem(conversationId: string, item: AgentTimelineItem): void {
    const timeline = this.timelines.get(conversationId) ?? [];
    timeline.push(item);
    timeline.sort((a, b) => a.createdAt - b.createdAt);
    if (timeline.length > MAX_TIMELINE_ITEMS) {
      timeline.splice(0, timeline.length - MAX_TIMELINE_ITEMS);
    }
    this.timelines.set(conversationId, timeline);
    this.emitItem(conversationId, item);
  }

  private upsertItem(conversationId: string, item: AgentTimelineItem): void {
    const timeline = this.timelines.get(conversationId) ?? [];
    const index = timeline.findIndex((entry) => entry.id === item.id);
    if (index >= 0) timeline[index] = item;
    else timeline.push(item);
    timeline.sort((a, b) => a.createdAt - b.createdAt);
    if (timeline.length > MAX_TIMELINE_ITEMS) {
      timeline.splice(0, timeline.length - MAX_TIMELINE_ITEMS);
    }
    this.timelines.set(conversationId, timeline);
    this.emitItem(conversationId, item);
  }

  private upsertTool(conversationId: string, toolCall: AgentToolCall): void {
    const existing = this.findTool(conversationId, toolCall.id);
    const nextToolCall = {
      ...toolCall,
      createdAt: existing?.createdAt ?? toolCall.createdAt ?? Date.now(),
    };
    this.toolConversationIds.set(nextToolCall.id, conversationId);
    this.upsertItem(conversationId, {
      id: `tool:${nextToolCall.id}`,
      conversationId,
      type: "tool_call",
      toolCall: nextToolCall,
      createdAt: nextToolCall.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private findItem(conversationId: string, itemId: string): AgentTimelineItem | undefined {
    return this.timelines.get(conversationId)?.find((item) => item.id === itemId);
  }

  private findTool(conversationId: string, toolId: string): AgentToolCall | undefined {
    const item = this.timelines.get(conversationId)?.find((entry) =>
      entry.type === "tool_call" && entry.toolCall?.id === toolId,
    );
    return item?.toolCall;
  }

  private emitItem(conversationId: string, item: AgentTimelineItem): void {
    const conversation = this.conversations.get(conversationId);
    this.input.send(createEnvelope({
      type: "agent.v2.event",
      sessionId: this.input.sessionId,
      payload: { conversationId, conversation, item },
    }));
  }

  private emitConversation(conversation: AgentConversation): void {
    this.input.send(createEnvelope({
      type: "agent.v2.event",
      sessionId: this.input.sessionId,
      payload: { conversationId: conversation.id, conversation },
    }));
  }

  private emitStatus(conversationId: string, status: AgentStatus, text?: string): void {
    this.addItem(conversationId, {
      id: id("status"),
      conversationId,
      type: "status",
      status,
      text,
      createdAt: Date.now(),
    });
  }

  private updateConversationPreview(
    conversationId: string,
    text: string,
    status?: AgentStatus,
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.lastMessagePreview = previewText(text);
    conversation.lastActivityAt = Date.now();
    if (status) conversation.status = status;
    this.emitConversation(conversation);
  }

  private updateConversationStatus(
    conversationId: string,
    status: AgentStatus,
    error?: string,
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.status = status;
    if (error) conversation.lastMessagePreview = error;
    conversation.lastActivityAt = Date.now();
    this.emitConversation(conversation);
  }

  private sendSnapshot(conversationId?: string): void {
    const conversations = [...this.conversations.values()];
    const items = conversationId
      ? this.timelines.get(conversationId) ?? []
      : [...this.timelines.values()].flat();
    this.input.send(createEnvelope({
      type: "agent.v2.snapshot",
      sessionId: this.input.sessionId,
      payload: {
        conversations,
        activeConversationId: this.activeConversationId,
        items,
      },
    }));
  }

  private conversationIdFromParams(params: unknown): string | undefined {
    const raw = asRecord(params);
    const agentSessionId = this.extractSessionId(raw);
    if (agentSessionId) return this.conversationByAgentSessionId.get(agentSessionId);
    const threadId = firstString(raw, ["threadId", "sessionId", "agentSessionId"]);
    if (threadId) return this.conversationByAgentSessionId.get(threadId);
    return undefined;
  }

  private handleExit(message: string): void {
    this.cancelPendingPermissions();
    this.status = "error";
    this.error = message;
    this.client = undefined;
    for (const conversation of this.conversations.values()) {
      conversation.status = "error";
      conversation.lastMessagePreview = message;
      conversation.lastActivityAt = Date.now();
      this.emitConversation(conversation);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: Date.now(),
      });
    }
  }

  private cancelPendingPermissions(conversationId?: string): void {
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
    if (conversationId) this.updateConversationStatus(conversationId, "idle");
  }

  private extractSessionId(value: unknown): string | undefined {
    const raw = asRecord(value);
    if (!raw) return undefined;
    const thread = asRecord(raw.thread);
    if (thread) {
      const threadId = firstString(thread, ["id", "threadId"]);
      if (threadId) return threadId;
    }
    return firstString(raw, ["sessionId", "id", "agentSessionId", "threadId"]);
  }

  private extractTurnId(value: unknown): string | undefined {
    const raw = asRecord(value);
    if (!raw) return undefined;
    const turn = asRecord(raw.turn);
    if (turn) {
      const turnId = firstString(turn, ["id", "turnId"]);
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
      const raw = asRecord(entry) ?? {};
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
