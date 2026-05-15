import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { AgentWorkspaceProxy } from "../src/runtime/acp/agent-workspace.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-agent-workspace-"));
  process.env.HOME = homeDir;
  return homeDir;
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function makeProxy() {
  const sent: any[] = [];
  const proxy = new AgentWorkspaceProxy({
    hostDeviceId: "host-1",
    cwd: "/tmp",
    availableProviders: [],
    send: (envelope) => sent.push(envelope),
  }) as any;
  proxy.conversations.set("conversation-a", {
    id: "conversation-a",
    agentSessionId: "thread-a",
    provider: "codex",
    cwd: "/tmp",
    title: "A",
    status: "running",
    archived: false,
    createdAt: 1,
    lastActivityAt: 1,
  });
  proxy.conversations.set("conversation-b", {
    id: "conversation-b",
    agentSessionId: "thread-b",
    provider: "codex",
    cwd: "/tmp",
    title: "B",
    status: "running",
    archived: false,
    createdAt: 1,
    lastActivityAt: 1,
  });
  proxy.conversationByAgentSessionId.set("thread-a", "conversation-a");
  proxy.conversationByAgentSessionId.set("thread-b", "conversation-b");
  proxy.activeConversationId = "conversation-b";
  return { proxy, sent };
}

describe("AgentWorkspaceProxy event routing", () => {
  it("does not route id-less streaming events to the active conversation when multiple turns are live", () => {
    const { proxy, sent } = makeProxy();

    proxy.handleAgentMessageDelta({ id: "assistant-1", delta: "hello" });

    expect(sent).toHaveLength(0);
  });

  it("routes streaming events by turn id even when a different conversation is active", () => {
    const { proxy, sent } = makeProxy();
    proxy.rememberTurnConversationId("conversation-a", "turn-a");

    proxy.handleAgentMessageDelta({ turnId: "turn-a", itemId: "assistant-1", delta: "hello" });

    expect(sent).toHaveLength(2);
    expect(sent[0].payload.conversationId).toBe("conversation-a");
    expect(sent[0].payload.item.text).toBe("hello");
    expect(sent[1].payload.conversationId).toBe("conversation-a");
  });

  it("emits a conversation update when Claude reports the real session id", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").agentSessionId = "agent-session-placeholder";
    proxy.conversations.get("conversation-b").status = "idle";

    proxy.handleNotification("thread/started", { sessionId: "claude-real-session" });

    expect(proxy.conversationByAgentSessionId.get("claude-real-session")).toBe("conversation-a");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.conversation.agentSessionId).toBe("claude-real-session");
  });

  it("keeps assistant image content blocks for mobile rendering", () => {
    const { proxy, sent } = makeProxy();

    proxy.handleItemCompleted({
      sessionId: "thread-a",
      item: {
        id: "assistant-image",
        type: "agentMessage",
        content: [
          { type: "text", text: "Here is the image." },
          { type: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png" },
        ],
        status: "completed",
      },
    });

    expect(sent[0].payload.item.content).toEqual([
      { type: "text", text: "Here is the image." },
      { type: "image", data: "data:image/png;base64,AAAA", mimeType: "image/png" },
    ]);
    expect(sent[0].payload.item.text).toBe("Here is the image.\n[image/png attachment]");
  });

  it("only returns archived conversations when the list request asks for them", async () => {
    useTempHome();
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-b").archived = true;

    await proxy.handleEnvelope({
      type: "agent.v2.conversation.list",
      hostDeviceId: "host-1",
      payload: { includeArchived: false },
    });
    await proxy.handleEnvelope({
      type: "agent.v2.conversation.list",
      hostDeviceId: "host-1",
      payload: { includeArchived: true },
    });

    const results = sent.filter((envelope) => envelope.type === "agent.v2.conversation.list.result");
    expect(results[0].payload.conversations.map((conversation: any) => conversation.id)).toEqual(["conversation-a"]);
    expect(results[1].payload.conversations.map((conversation: any) => conversation.id)).toEqual([
      "conversation-a",
      "conversation-b",
    ]);
  });

  it("lists device-side Claude sessions even when no Claude runtime is available", async () => {
    const home = useTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-tifenxia-ClaudeProject");
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "claude-session.jsonl"), [
      {
        type: "user",
        cwd: "/Users/tifenxia/ClaudeProject",
        timestamp: "2026-05-16T02:00:00.000Z",
        message: { role: "user", content: "Inspect Claude history" },
      },
    ]);
    const { proxy, sent } = makeProxy();

    await proxy.handleEnvelope({
      type: "agent.v2.conversation.list",
      hostDeviceId: "host-1",
      payload: { includeArchived: false },
    });

    const result = sent.find((envelope) => envelope.type === "agent.v2.conversation.list.result");
    expect(result.payload.conversations).toContainEqual(expect.objectContaining({
      agentSessionId: "claude-session",
      provider: "claude",
      cwd: "/Users/tifenxia/ClaudeProject",
      title: "Inspect Claude history",
    }));
  });

  it("preserves device-side Codex archived state in conversation lists", async () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    const archivedDir = join(codexRoot, "archived_sessions");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-active",
          cwd: "/Users/tifenxia/ActiveProject",
          timestamp: "2026-05-16T01:00:00.000Z",
        },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Open active history" },
      },
      {
        timestamp: "2026-05-16T01:02:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Active history is open" },
      },
    ]);
    writeJsonl(join(archivedDir, "rollout-2026-05-15T01-00-00-019e-archived.jsonl"), [
      {
        timestamp: "2026-05-15T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-archived",
          cwd: "/Users/tifenxia/ArchivedProject",
          timestamp: "2026-05-15T01:00:00.000Z",
        },
      },
    ]);
    const sent: any[] = [];
    const proxy = new AgentWorkspaceProxy({
      hostDeviceId: "host-1",
      cwd: "/tmp",
      availableProviders: [],
      send: (envelope) => sent.push(envelope),
    });

    await proxy.handleEnvelope({
      type: "agent.v2.conversation.list",
      hostDeviceId: "host-1",
      payload: { includeArchived: false },
    });
    await proxy.handleEnvelope({
      type: "agent.v2.conversation.list",
      hostDeviceId: "host-1",
      payload: { includeArchived: true },
    });

    const results = sent.filter((envelope) => envelope.type === "agent.v2.conversation.list.result");
    expect(results[0].payload.conversations).toContainEqual(expect.objectContaining({
      agentSessionId: "019e-active",
      archived: false,
    }));
    expect(results[0].payload.conversations).not.toContainEqual(expect.objectContaining({
      agentSessionId: "019e-archived",
    }));
    expect(results[1].payload.conversations).toContainEqual(expect.objectContaining({
      agentSessionId: "019e-archived",
      provider: "codex",
      archived: true,
    }));

    await proxy.handleEnvelope({
      type: "agent.v2.conversation.open",
      hostDeviceId: "host-1",
      payload: {
        conversationId: "agent:019e-active",
        agentSessionId: "019e-active",
        provider: "codex",
      },
    });

    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened.payload.snapshot).toEqual([
      expect.objectContaining({ role: "user", text: "Open active history" }),
      expect.objectContaining({ role: "assistant", text: "Active history is open" }),
    ]);
  });

  it("advertises selectable controls for enabled providers", async () => {
    const sent: any[] = [];
    const proxy = new AgentWorkspaceProxy({
      hostDeviceId: "host-1",
      cwd: "/tmp",
      availableProviders: ["codex", "claude"],
      send: (envelope) => sent.push(envelope),
    }) as any;
    proxy.initialized = true;
    proxy.clients.set("codex", {});
    proxy.clients.set("claude", {});
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.agentProtocols.set("claude", "claude-agent-sdk");
    proxy.providerCapabilities.set("claude", {
      models: [{ id: "default", label: "默认模型" }, { id: "sonnet", label: "Sonnet" }],
      defaultModel: "default",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    });

    await proxy.handleEnvelope({
      type: "agent.v2.capabilities.request",
      hostDeviceId: "host-1",
      payload: {},
    });

    const capabilities = sent.find((envelope) => envelope.type === "agent.v2.capabilities")?.payload;
    expect(capabilities.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        models: [{ id: "default", label: "默认模型" }],
        reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        permissionModes: ["read_only", "workspace_write", "full_access"],
      }),
      expect.objectContaining({
        id: "claude",
        models: [{ id: "default", label: "默认模型" }, { id: "sonnet", label: "Sonnet" }],
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        permissionModes: ["read_only", "workspace_write", "full_access"],
      }),
    ]);
  });

  it("clears prompt settings when the mobile app sends null defaults", async () => {
    const sent: any[] = [];
    const prompts: any[] = [];
    const proxy = new AgentWorkspaceProxy({
      hostDeviceId: "host-1",
      cwd: "/tmp",
      availableProviders: [],
      send: (envelope) => sent.push(envelope),
    }) as any;
    proxy.clients.set("codex", {
      prompt: async (input: any) => {
        prompts.push(input);
        return { status: "completed" };
      },
    });
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.conversations.set("conversation-a", {
      id: "conversation-a",
      agentSessionId: "thread-a",
      provider: "codex",
      cwd: "/tmp",
      title: "A",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "full_access",
      collaborationMode: "plan",
      status: "idle",
      archived: false,
      createdAt: 1,
      lastActivityAt: 1,
    });

    await proxy.handleEnvelope({
      type: "agent.v2.prompt",
      hostDeviceId: "host-1",
      payload: {
        conversationId: "conversation-a",
        clientMessageId: "msg-a",
        contentBlocks: [{ type: "text", text: "hello" }],
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        collaborationMode: null,
      },
    });

    expect(proxy.conversations.get("conversation-a")).toEqual(expect.objectContaining({
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: undefined,
      collaborationMode: "default",
    }));
    expect(prompts[0]).toEqual(expect.objectContaining({
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: undefined,
      collaborationMode: "default",
    }));
  });
});
