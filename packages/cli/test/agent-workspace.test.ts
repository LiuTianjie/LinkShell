import { describe, expect, it } from "vitest";
import {
  AgentWorkspaceProxy,
  makeAgentV2RemoteConversationId,
} from "../src/runtime/acp/agent-workspace.js";

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
  it("uses provider-scoped stable conversation ids for remote provider sessions", () => {
    expect(makeAgentV2RemoteConversationId("codex", "thread/a:b")).toBe("agent-remote-codex-thread-a-b");
    expect(makeAgentV2RemoteConversationId("claude", "thread/a:b")).toBe("agent-remote-claude-thread-a-b");
  });

  it("returns a stable provider-scoped id for newly opened provider sessions", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.initialized = true;
    proxy.clients.set("codex", {
      newSession: async () => ({ sessionId: "thread/a:b" }),
    });

    await proxy.handleEnvelope({
      id: "env-new-open",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: new Date().toISOString(),
      payload: { conversationId: "agent-temp-client", cwd: "/tmp", provider: "codex" },
    });

    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation.id).toBe("agent-remote-codex-thread-a-b");
    expect(opened?.payload.requestedConversationId).toBe("agent-temp-client");
    expect(proxy.conversationByAgentSessionId.get("thread/a:b")).toBe("agent-remote-codex-thread-a-b");
  });

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

  it("maps Codex thread/status/changed notifications onto conversation state", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";

    proxy.handleNotification("thread/status/changed", {
      threadId: "thread-a",
      turnId: "turn-status-1",
      status: "active",
    });
    expect(proxy.currentTurnIds.get("conversation-a")).toBe("turn-status-1");
    proxy.handleNotification("thread/status/changed", {
      threadId: "thread-a",
      turnId: "turn-status-1",
      status: { type: "systemError" },
      message: "tool runtime failed",
    });
    expect(proxy.currentTurnIds.get("conversation-a")).toBeUndefined();

    const updates = sent.filter((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversationId === "conversation-a" &&
      envelope.payload?.conversation
    );
    expect(updates.at(-2)?.payload.conversation.status).toBe("running");
    expect(updates.at(-1)?.payload.conversation.status).toBe("error");
    expect(updates.at(-1)?.payload.conversation.lastMessagePreview).toBe("tool runtime failed");
  });

  it("does not poison idle history when a provider transport exits", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "running";
    proxy.conversations.get("conversation-b").status = "idle";

    proxy.handleProviderExit("codex", "ACP agent exited");

    expect(proxy.conversations.get("conversation-a").status).toBe("error");
    expect(proxy.conversations.get("conversation-a").lastMessagePreview).toBe("ACP agent exited");
    expect(proxy.conversations.get("conversation-b").status).toBe("idle");

    const updates = sent.filter((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversation
    );
    const idleUpdate = updates.find((envelope) => envelope.payload.conversationId === "conversation-b");
    expect(idleUpdate?.payload.conversation.status).toBe("idle");
    const idleErrors = sent.filter((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversationId === "conversation-b" &&
      envelope.payload?.item?.type === "error"
    );
    expect(idleErrors).toHaveLength(0);
  });

  it("opens existing history even when the provider cannot restart", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", [
      {
        id: "assistant-existing",
        conversationId: "conversation-a",
        type: "message",
        role: "assistant",
        text: "existing answer",
        createdAt: 1,
      },
    ]);
    proxy.ensureProviderClient = async (provider: "codex") => {
      proxy.providerErrors.set(provider, "wham apps request failed");
      return undefined;
    };

    await proxy.handleEnvelope({
      id: "env-open-provider-down",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation.id).toBe("conversation-a");
    expect(opened?.payload.conversation.status).toBe("idle");
    expect(opened?.payload.snapshot.map((item: any) => item.id)).toEqual(["assistant-existing"]);
    expect(opened?.payload.providerError).toBe("wham apps request failed");
    const historyErrors = sent.filter((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversationId === "conversation-a" &&
      envelope.payload?.item?.type === "error"
    );
    expect(historyErrors).toHaveLength(0);
  });

  it("opens requested local history when provider is down before host syncs it", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.ensureProviderClient = async (provider: "codex") => {
      proxy.providerErrors.set(provider, "token refresh failed");
      return undefined;
    };

    await proxy.handleEnvelope({
      id: "env-open-offline-provider-down",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "local-conversation",
        agentSessionId: "thread-local",
        cwd: "/tmp",
        provider: "codex",
        title: "Local history",
      },
    });

    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation).toMatchObject({
      id: "local-conversation",
      agentSessionId: "thread-local",
      provider: "codex",
      status: "idle",
    });
    expect(opened?.payload.snapshot).toEqual([]);
    expect(proxy.conversations.get("local-conversation").status).toBe("idle");
    const errors = sent.filter((envelope) => envelope.payload?.item?.type === "error");
    expect(errors).toHaveLength(0);
  });

  it("marks live permission request items so mobile snapshots keep them actionable", () => {
    const { proxy, sent } = makeProxy();

    proxy.handlePermission({
      threadId: "thread-a",
      requestId: "perm-1",
      toolName: "Bash",
      toolInput: { command: "pnpm test" },
      context: "Run tests",
      options: [
        { id: "deny", label: "Deny", kind: "deny" },
        { id: "allow_once", label: "Allow", kind: "allow" },
      ],
    }, false, "test");

    const request = sent.find((envelope) => envelope.type === "agent.v2.permission.request");
    expect(request?.payload.item.metadata).toMatchObject({
      protocol: "v2",
      permissionLive: true,
      permissionExpired: false,
      permissionPending: false,
    });
    expect(proxy.timelines.get("conversation-a").find((item: any) => item.id === "permission:perm-1")?.metadata)
      .toMatchObject({ permissionLive: true });
  });

  it("ignores duplicate permission responses after the first delivery", async () => {
    const { proxy } = makeProxy();
    let responseCalls = 0;
    proxy.clients.set("codex", {
      respondPermission: () => {
        responseCalls += 1;
      },
    });
    proxy.handlePermission({
      threadId: "thread-a",
      requestId: "perm-duplicate",
      toolName: "Bash",
      toolInput: { command: "pnpm test" },
    }, false, "test");

    const response = {
      id: "env-perm-response",
      type: "agent.v2.permission.respond",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        requestId: "perm-duplicate",
        outcome: "allow",
        optionId: "allow",
      },
    };
    await proxy.handleEnvelope(response);
    await proxy.handleEnvelope({ ...response, id: "env-perm-response-duplicate" });

    expect(responseCalls).toBe(1);
    const item = proxy.timelines.get("conversation-a").find((entry: any) => entry.id === "permission:perm-duplicate");
    expect(item?.metadata?.permissionOutcome).toBe("allow");
  });

  it("ignores duplicate structured input responses after submission", async () => {
    const { proxy, sent } = makeProxy();
    proxy.handleStructuredInput({
      threadId: "thread-a",
      requestId: "input-duplicate",
      questions: [{ id: "q1", question: "Pick one", options: ["A", "B"] }],
    });
    const beforeResponses = sent.length;
    const response = {
      id: "env-input-response",
      type: "agent.v2.structured_input.respond",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        requestId: "input-duplicate",
        answers: { q1: ["A"] },
      },
    };

    await proxy.handleEnvelope(response);
    const afterFirst = sent.length;
    await proxy.handleEnvelope({ ...response, id: "env-input-response-duplicate" });

    expect(afterFirst).toBeGreaterThan(beforeResponses);
    expect(sent.length).toBe(afterFirst);
    const item = proxy.timelines.get("conversation-a").find((entry: any) => entry.id === "input:input-duplicate");
    expect(item?.metadata?.inputSubmitted).toBe(true);
    expect(item?.metadata?.answers).toEqual({ q1: ["A"] });
  });

  it("emits an agent.v2.notice when the user switches Codex models", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").model = "gpt-5.5";
    proxy.conversations.get("conversation-a").status = "idle";
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

  it("uses the Codex default model when mobile sends the default picker value", async () => {
    const { proxy } = makeProxy();
    proxy.conversations.get("conversation-a").model = undefined;
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.providerCapabilities.set("codex", {
      defaultModel: "gpt-5.5",
      models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
    });
    let promptInput: any;
    proxy.clients.set("codex", {
      prompt: async (input: any) => {
        promptInput = input;
        return {};
      },
    });

    await proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-default-model",
      contentBlocks: [{ type: "text", text: "make a plan" }],
      collaborationMode: "plan",
    });

    expect(promptInput.model).toBe("gpt-5.5");
    expect(proxy.conversations.get("conversation-a").model).toBe("gpt-5.5");
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

  it("restarts Codex app-server once when thread/list hits a wedged transport", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.initialized = true;
    let stopCalls = 0;
    let restartCalls = 0;
    proxy.clients.set("codex", {
      stop: () => { stopCalls += 1; },
      listSessions: async () => {
        throw new Error("Transport channel closed, when Auth(TokenRefreshFailed(\"Failed to parse server response\"))");
      },
    });
    proxy.ensureProviderClient = async () => {
      restartCalls += 1;
      const recovered = {
        listSessions: async () => ({
          sessions: [{ id: "thread-after-restart", cwd: "/repo", title: "Recovered" }],
        }),
      };
      proxy.clients.set("codex", recovered);
      return recovered;
    };

    await proxy.handleEnvelope({
      id: "env-recover-list",
      type: "agent.v2.snapshot.request",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {},
    });

    expect(stopCalls).toBe(1);
    expect(restartCalls).toBe(1);
    const snapshot = sent.find((envelope) => envelope.type === "agent.v2.snapshot");
    expect(snapshot?.payload.conversations[0].agentSessionId).toBe("thread-after-restart");
  });

  it("parses Codex thread/list data[] results", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.initialized = true;
    proxy.clients.set("codex", {
      listSessions: async () => ({
        data: [
          {
            id: "thread-data-1",
            preview: "Fix mobile agent",
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      }),
    });

    await proxy.handleEnvelope({
      id: "env-list",
      type: "agent.v2.snapshot.request",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {},
    });

    const snapshot = sent.find((envelope) => envelope.type === "agent.v2.snapshot");
    expect(snapshot?.payload.conversations[0].agentSessionId).toBe("thread-data-1");
    expect(snapshot?.payload.conversations[0].lastActivityAt).toBe(200_000);
  });

  it("hydrates a resumed Codex conversation from thread turns", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", []);
    proxy.initialized = true;
    let loadCalls = 0;
    proxy.clients.set("codex", {
      loadSession: async () => {
        loadCalls += 1;
        return {
          thread: {
            id: "thread-a",
            model: "gpt-5.5",
            turns: [
              {
                id: "turn-1",
                status: "running",
                createdAt: 100,
                items: [
                  { id: "user-1", type: "userMessage", content: [{ type: "text", text: "run tests" }] },
                  { id: "assistant-1", type: "agentMessage", content: [{ type: "text", text: "I will run tests." }] },
                  {
                    id: "cmd-1",
                    type: "commandExecution",
                    command: "pnpm test",
                    aggregatedOutput: "ok",
                    status: "completed",
                  },
                ],
              },
            ],
          },
        };
      },
    });

    await proxy.handleEnvelope({
      id: "env-open",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    expect(loadCalls).toBe(1);
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.snapshot.map((item: any) => item.id)).toEqual([
      "user-1",
      "assistant-1",
      "tool:cmd-1",
    ]);
    expect(opened?.payload.snapshot[0].role).toBe("user");
    expect(opened?.payload.snapshot[1].text).toBe("I will run tests.");
    expect(opened?.payload.snapshot[2].commandExecution.command).toBe("pnpm test");
    expect(opened?.payload.conversation.model).toBe("gpt-5.5");
    expect(proxy.currentTurnIds.get("conversation-a")).toBe("turn-1");
  });

  it("restores an active Codex turn from metadata even when there are no timeline items", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", []);
    proxy.initialized = true;
    proxy.clients.set("codex", {
      loadSession: async () => ({
        thread: {
          id: "thread-a",
          model: "gpt-5.6",
          turns: [{ id: "turn-empty-running", status: "running", items: [] }],
        },
      }),
      readSession: async () => ({
        thread: {
          id: "thread-a",
          model: "gpt-5.6",
          turns: [{ id: "turn-empty-running", status: "running", items: [] }],
        },
      }),
    });

    await proxy.handleEnvelope({
      id: "env-open-empty-running",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    expect(proxy.currentTurnIds.get("conversation-a")).toBe("turn-empty-running");
    expect(proxy.conversations.get("conversation-a").model).toBe("gpt-5.6");
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.snapshot).toEqual([]);
  });

  it("reads Codex thread history when resume returns only metadata", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", []);
    proxy.initialized = true;
    let readCalls = 0;
    proxy.clients.set("codex", {
      loadSession: async () => ({ thread: { id: "thread-a", turns: [] } }),
      readSession: async (input: any) => {
        readCalls += 1;
        expect(input).toEqual({ sessionId: "thread-a", includeTurns: true });
        return {
          thread: {
            id: "thread-a",
            turns: [
              {
                id: "turn-read-1",
                items: [
                  { id: "user-read-1", type: "userMessage", content: [{ type: "text", text: "restore history" }] },
                  { id: "assistant-read-1", type: "agentMessage", text: "history restored" },
                ],
              },
            ],
          },
        };
      },
    });

    await proxy.handleEnvelope({
      id: "env-open-read",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    expect(readCalls).toBe(1);
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.snapshot.map((item: any) => item.id)).toEqual([
      "user-read-1",
      "assistant-read-1",
    ]);
    expect(opened?.payload.conversation.lastMessagePreview).toBe("history restored");
  });

  it("restarts Codex app-server once when opening a thread hits a wedged transport", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", []);
    proxy.initialized = true;
    let restartCalls = 0;
    proxy.clients.set("codex", {
      stop: () => {},
      loadSession: async () => {
        throw new Error("ACP request timed out: thread/resume");
      },
    });
    proxy.ensureProviderClient = async () => {
      restartCalls += 1;
      const recovered = {
        loadSession: async () => ({
          thread: {
            id: "thread-a",
            turns: [
              {
                id: "turn-recovered",
                items: [
                  { id: "assistant-recovered", type: "agentMessage", text: "recovered history" },
                ],
              },
            ],
          },
        }),
      };
      proxy.clients.set("codex", recovered);
      return recovered;
    };

    await proxy.handleEnvelope({
      id: "env-open-recover",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    expect(restartCalls).toBe(1);
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.snapshot.map((item: any) => item.id)).toEqual(["assistant-recovered"]);
  });

  it("falls back to Codex thread/turns/list when thread/read cannot hydrate history", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.timelines.set("conversation-a", []);
    proxy.initialized = true;
    let readCalls = 0;
    let turnsCalls = 0;
    proxy.clients.set("codex", {
      loadSession: async () => ({ thread: { id: "thread-a", turns: [] } }),
      readSession: async () => {
        readCalls += 1;
        throw new Error("rollout not available");
      },
      listTurns: async (input: any) => {
        turnsCalls += 1;
        expect(input).toMatchObject({
          sessionId: "thread-a",
          sortDirection: "desc",
          itemsView: "full",
        });
        return {
          data: [
            {
              turn: {
                id: "turn-newest",
                items: [
                  { id: "user-newest", type: "userMessage", content: [{ type: "text", text: "newer question" }] },
                  { id: "assistant-newest", type: "agentMessage", text: "newer answer" },
                ],
              },
            },
            {
              turn: {
                id: "turn-oldest",
                items: [
                  { id: "user-list-1", type: "userMessage", content: [{ type: "text", text: "restore from turns list" }] },
                  { id: "assistant-list-1", type: "agentMessage", text: "history restored from turns/list" },
                ],
              },
            },
          ],
        };
      },
    });

    await proxy.handleEnvelope({
      id: "env-open-turns-list",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", agentSessionId: "thread-a", cwd: "/tmp", provider: "codex" },
    });

    expect(readCalls).toBe(1);
    expect(turnsCalls).toBe(1);
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.snapshot.map((item: any) => item.id)).toEqual([
      "user-list-1",
      "assistant-list-1",
      "user-newest",
      "assistant-newest",
    ]);
    expect(opened?.payload.conversation.lastMessagePreview).toBe("newer answer");
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

  it("steers an active Codex turn instead of starting a second turn", async () => {
    const { proxy, sent } = makeProxy();
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.currentTurnIds.set("conversation-a", "turn-a");
    let steerInput: any;
    let promptCalls = 0;
    proxy.clients.set("codex", {
      steer: async (input: any) => {
        steerInput = input;
        return { turnId: input.turnId };
      },
      prompt: async () => {
        promptCalls += 1;
        return {};
      },
    });

    await proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-steer",
      contentBlocks: [{ type: "text", text: "focus on tests first" }],
      delivery: "steer",
    });

    expect(promptCalls).toBe(0);
    expect(steerInput).toEqual({
      sessionId: "thread-a",
      turnId: "turn-a",
      content: [{ type: "text", text: "focus on tests first" }],
    });
    const userItem = sent.find((envelope) => envelope.payload?.item?.id === "msg-steer");
    expect(userItem?.payload.item.metadata).toEqual({ delivery: "steer", targetTurnId: "turn-a" });
  });

  it("clears running state when Codex steer is requested before an active turn is known", async () => {
    const { proxy, sent } = makeProxy();
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.clients.set("codex", {
      prompt: async () => ({}),
      steer: async () => {
        throw new Error("should not steer without a turn id");
      },
    });

    await proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-steer-missing",
      contentBlocks: [{ type: "text", text: "follow up" }],
      delivery: "steer",
    });

    const conversationEvent = sent.find((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversationId === "conversation-a" &&
      envelope.payload?.conversation?.status === "idle"
    );
    expect(conversationEvent?.payload.conversation.lastMessagePreview).toContain("没有可追加输入");
    const error = sent.find((envelope) => envelope.payload?.item?.type === "error");
    expect(error?.payload.item.error).toContain("没有可追加输入");
  });

  it("falls back to a new Codex turn when steering the active turn is rejected", async () => {
    const { proxy, sent } = makeProxy();
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.currentTurnIds.set("conversation-a", "turn-a");
    let steerCalls = 0;
    let promptInput: any;
    proxy.clients.set("codex", {
      steer: async () => {
        steerCalls += 1;
        throw new Error("turn no longer running");
      },
      prompt: async (input: any) => {
        promptInput = input;
        return { turnId: "turn-b" };
      },
    });

    await proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-steer-fallback",
      contentBlocks: [{ type: "text", text: "continue as a new turn" }],
      delivery: "steer",
    });

    expect(steerCalls).toBe(1);
    expect(promptInput).toMatchObject({
      sessionId: "thread-a",
      clientMessageId: "msg-steer-fallback",
      content: [{ type: "text", text: "continue as a new turn" }],
    });
    expect(proxy.currentTurnIds.get("conversation-a")).toBe("turn-b");
    const userUpdates = sent.filter((envelope) => envelope.payload?.item?.id === "msg-steer-fallback");
    expect(userUpdates.at(-1)?.payload.item.metadata).toMatchObject({
      delivery: "new_turn",
      fallbackFrom: "steer",
      failedTargetTurnId: "turn-a",
    });
    const statusItem = sent.find((envelope) => envelope.payload?.item?.type === "status");
    expect(statusItem?.payload.item.text).toContain("已改为发送新消息");
  });

  it("does not mark Codex stopped when no active turn id is known", async () => {
    const { proxy, sent } = makeProxy();
    proxy.agentProtocols.set("codex", "codex-app-server");
    let cancelCalls = 0;
    proxy.clients.set("codex", {
      cancel: () => {
        cancelCalls += 1;
      },
    });

    await proxy.handleEnvelope({
      id: "env-cancel-missing-turn",
      type: "agent.v2.cancel",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a" },
    });

    expect(cancelCalls).toBe(0);
    expect(proxy.conversations.get("conversation-a").status).toBe("running");
    const error = sent.find((envelope) => envelope.payload?.item?.type === "error");
    expect(error?.payload.item.error).toContain("无法停止 Codex");
  });

  it("interrupts a Codex turn only when the active turn id is known", async () => {
    const { proxy, sent } = makeProxy();
    proxy.agentProtocols.set("codex", "codex-app-server");
    proxy.currentTurnIds.set("conversation-a", "turn-a");
    let cancelInput: any;
    proxy.clients.set("codex", {
      cancel: (input: any) => {
        cancelInput = input;
      },
    });

    await proxy.handleEnvelope({
      id: "env-cancel-known-turn",
      type: "agent.v2.cancel",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a" },
    });

    expect(cancelInput).toEqual({ sessionId: "thread-a", turnId: "turn-a" });
    expect(proxy.currentTurnIds.get("conversation-a")).toBeUndefined();
    expect(proxy.conversations.get("conversation-a").status).toBe("idle");
    const statusItem = sent.find((envelope) =>
      envelope.payload?.item?.type === "status" &&
      envelope.payload?.item?.text === "已停止"
    );
    expect(statusItem).toBeDefined();
  });

  it("marks the conversation errored when the provider is unavailable after a mobile optimistic send", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").status = "idle";
    proxy.providerErrors.set("codex", "Codex provider unavailable");
    proxy.ensureProviderClient = async () => undefined;

    await proxy.sendPrompt({
      conversationId: "conversation-a",
      clientMessageId: "msg-provider-down",
      contentBlocks: [{ type: "text", text: "hello" }],
    });

    const conversationEvent = sent.find((envelope) =>
      envelope.type === "agent.v2.event" &&
      envelope.payload?.conversationId === "conversation-a" &&
      envelope.payload?.conversation?.status === "error"
    );
    expect(conversationEvent?.payload.conversation.lastMessagePreview).toContain("Codex provider unavailable");
    const error = sent.find((envelope) => envelope.payload?.item?.type === "error");
    expect(error?.payload.item.error).toContain("Codex provider unavailable");
  });

  it("does not abort a running non-Codex provider when mobile sends another prompt", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.set("conversation-claude", {
      id: "conversation-claude",
      agentSessionId: "claude-thread",
      provider: "claude",
      cwd: "/tmp",
      title: "Claude",
      status: "running",
      createdAt: 1,
      lastActivityAt: 1,
    });
    proxy.conversationByAgentSessionId.set("claude-thread", "conversation-claude");
    let promptCalls = 0;
    proxy.clients.set("claude", {
      prompt: async () => {
        promptCalls += 1;
        return {};
      },
    });

    await proxy.sendPrompt({
      conversationId: "conversation-claude",
      clientMessageId: "msg-claude-running",
      contentBlocks: [{ type: "text", text: "also do this" }],
    });

    expect(promptCalls).toBe(0);
    const error = sent.find((envelope) => envelope.payload?.item?.type === "error");
    expect(error?.payload.item.error).toContain("不支持运行中追加输入");
  });

  it("formats Claude AskUserQuestion responses for the SDK", async () => {
    const { proxy } = makeProxy();
    const requestPromise = proxy.handleRequest("claude/askUserQuestion", {
      sessionId: "thread-a",
      requestId: "ask-1",
      questions: [
        {
          question: "Which database should I use?",
          header: "Database",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "Local file" },
          ],
          multiSelect: false,
        },
        {
          question: "Which sections should I include?",
          header: "Sections",
          options: [
            { label: "API", description: "Endpoint details" },
            { label: "Tests", description: "Verification" },
          ],
          multiSelect: true,
        },
      ],
    });

    proxy.respondStructuredInput({
      conversationId: "conversation-a",
      requestId: "ask-1",
      answers: {
        "question-1": ["Postgres"],
        "question-2": ["API", "Tests"],
      },
    });

    await expect(requestPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            question: "Which database should I use?",
            header: "Database",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "Local file" },
            ],
            multiSelect: false,
          },
          {
            question: "Which sections should I include?",
            header: "Sections",
            options: [
              { label: "API", description: "Endpoint details" },
              { label: "Tests", description: "Verification" },
            ],
            multiSelect: true,
          },
        ],
        answers: {
          "Which database should I use?": "Postgres",
          "Which sections should I include?": ["API", "Tests"],
        },
      },
    });
  });
});
