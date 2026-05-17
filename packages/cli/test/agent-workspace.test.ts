import { describe, expect, it } from "vitest";
import { AgentWorkspaceProxy } from "../src/runtime/acp/agent-workspace.js";

function makeProxy() {
  const sent: any[] = [];
  const proxy = new AgentWorkspaceProxy({
    sessionId: "session-1",
    cwd: "/tmp",
    availableProviders: ["codex"],
    send: (envelope) => sent.push(envelope),
  }) as any;
  proxy.conversations.set("conversation-a", {
    id: "conversation-a",
    agentSessionId: "thread-a",
    provider: "codex",
    cwd: "/tmp",
    title: "A",
    status: "running",
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

  it("captures the real Claude model from the initialized notification", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").model = undefined;

    proxy.handleNotification("initialized", {
      sessionId: "thread-a",
      threadId: "thread-a",
      model: "claude-sonnet-4-5",
    });

    expect(proxy.conversations.get("conversation-a").model).toBe("claude-sonnet-4-5");
    const conversationEvents = sent.filter((envelope) => envelope.type === "agent.v2.event" && envelope.payload.conversation);
    expect(conversationEvents.at(-1)?.payload.conversation.model).toBe("claude-sonnet-4-5");
  });

  it("captures the real Codex model from thread/started", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").model = undefined;

    proxy.handleNotification("thread/started", {
      sessionId: "thread-a",
      threadId: "thread-a",
      model: "gpt-5.5-mini",
    });

    expect(proxy.conversations.get("conversation-a").model).toBe("gpt-5.5-mini");
    const conversationEvents = sent.filter((envelope) => envelope.type === "agent.v2.event" && envelope.payload.conversation);
    expect(conversationEvents.at(-1)?.payload.conversation.model).toBe("gpt-5.5-mini");
  });

  it("emits an agent.v2.notice when the user switches Codex models", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").model = "gpt-5.5";
    proxy.providerCapabilities.set("codex", {
      models: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.5-mini", label: "GPT-5.5 mini" },
      ],
    });
    proxy.clients.set("codex", { prompt: async () => ({}) });

    return proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-1",
      contentBlocks: [{ type: "text", text: "hi" }],
      model: "gpt-5.5-mini",
    }).then(() => {
      const notice = sent.find((envelope) => envelope.type === "agent.v2.notice");
      expect(notice).toBeDefined();
      expect(notice?.payload.kind).toBe("model_changed");
      expect(notice?.payload.title).toContain("GPT-5.5 mini");
    });
  });

  it("emits an agent.v2.notice when a Claude session hits an unsupported native command", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.set("conversation-claude", {
      id: "conversation-claude",
      agentSessionId: "claude-thread",
      provider: "claude",
      cwd: "/tmp",
      title: "Claude",
      status: "idle",
      createdAt: 1,
      lastActivityAt: 1,
    });
    proxy.conversationByAgentSessionId.set("claude-thread", "conversation-claude");
    proxy.clients.set("claude", { prompt: async () => ({}) });

    await proxy.executeNativeCommand(
      proxy.conversations.get("conversation-claude"),
      { name: "plan", title: "/plan", executionKind: "native" },
    );

    const notice = sent.find((envelope) => envelope.type === "agent.v2.notice");
    expect(notice?.payload.kind).toBe("native_unsupported");
    expect(notice?.payload.title).toContain("plan");
  });

  it("syncs provider sessions when mobile requests a snapshot so conversations come from the host", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.initialized = true;
    let listCalls = 0;
    proxy.clients.set("codex", {
      listSessions: async () => {
        listCalls += 1;
        return {
          sessions: [
            { id: "thread-remote-1", cwd: "/repo", title: "Remote A", lastActivityAt: 100 },
            { id: "thread-remote-2", cwd: "/repo", title: "Remote B", lastActivityAt: 200 },
          ],
        };
      },
    });

    await proxy.handleEnvelope({
      id: "env-1",
      type: "agent.v2.snapshot.request",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {},
    });

    expect(listCalls).toBe(1);
    expect(proxy.conversationByAgentSessionId.get("thread-remote-1")).toBeDefined();
    const snapshot = sent.find((envelope) => envelope.type === "agent.v2.snapshot");
    expect(snapshot?.payload.conversations.map((c: any) => c.agentSessionId).sort()).toEqual([
      "thread-remote-1",
      "thread-remote-2",
    ]);
  });

  it("falls back to a minimal Codex model list when model/list returns nothing", async () => {
    const { proxy } = makeProxy();
    proxy.providerCapabilities.clear();
    const stubClient = {
      listModels: async () => undefined,
    };

    await proxy.refreshProviderCapabilities("codex", stubClient, "codex-app-server");

    const caps = proxy.providerCapabilities.get("codex");
    expect(caps).toBeDefined();
    expect(caps.models.length).toBeGreaterThanOrEqual(1);
    expect(caps.defaultModel).toBe("default");
    expect(caps.reasoningEfforts).toContain("high");
  });

  it("parses the real Codex model/list response shape (data[] with displayName + supportedReasoningEfforts)", async () => {
    const { proxy } = makeProxy();
    proxy.providerCapabilities.clear();
    const stubClient = {
      listModels: async () => ({
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: true,
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
              { reasoningEffort: "xhigh" },
            ],
          },
          {
            id: "gpt-5.4-mini",
            displayName: "GPT-5.4-Mini",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
          { id: "hidden-model", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [] },
        ],
        nextCursor: null,
      }),
    };

    await proxy.refreshProviderCapabilities("codex", stubClient, "codex-app-server");

    const caps = proxy.providerCapabilities.get("codex");
    expect(caps).toBeDefined();
    const ids = caps.models.map((m: any) => m.id);
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).not.toContain("hidden-model");
    const main = caps.models.find((m: any) => m.id === "gpt-5.5");
    expect(main.label).toBe("GPT-5.5");
    expect(caps.defaultModel).toBe("gpt-5.5");
    expect(caps.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
