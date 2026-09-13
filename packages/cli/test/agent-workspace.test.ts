import { describe, expect, it } from "vitest";
import {
  AgentWorkspaceProxy,
  CodexRolloutParser,
  makeAgentV2RemoteConversationId,
  timelineItemsFromCodexRolloutText,
} from "../src/runtime/acp/agent-workspace.js";

function makeProxy() {
  const sent: any[] = [];
  const proxy = new AgentWorkspaceProxy({
    sessionId: "session-1",
    cwd: "/tmp",
    availableProviders: ["codex"],
    discoverProcesses: () => [],
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

  it("forks a Codex thread via forkThread and opens the returned id", async () => {
    const { proxy, sent } = makeProxy();
    proxy.initialized = true;
    proxy.clients.set("codex", {
      forkThread: async (input: any) => ({ thread: { id: "thread-forked" } }),
      loadSession: async (input: any) => ({ thread: { id: input.sessionId, turns: [] } }),
    });

    await proxy.handleEnvelope({
      id: "env-fork",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        cwd: "/tmp",
        provider: "codex",
        forkFromConversationId: "conversation-a",
        forkFromTurnId: "turn-cut",
      },
    });

    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation.agentSessionId).toBe("thread-forked");
    expect(opened?.payload.conversation.id).toBe("agent-remote-codex-thread-forked");
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

  it("streams Codex reasoning summary deltas as thinking items and textDelta patches", () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-b").status = "idle";

    proxy.handleNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-a",
      itemId: "reason-1",
      delta: "Considering",
    });

    expect(sent[0].payload.item).toMatchObject({
      id: "reason-1",
      type: "status",
      kind: "thinking",
      role: "system",
      text: "Considering",
    });

    sent.length = 0;
    proxy.handleNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-a",
      itemId: "reason-1",
      delta: " the tests",
    });

    expect(sent[0].payload.patch).toMatchObject({
      itemId: "reason-1",
      textDelta: " the tests",
    });
    expect(proxy.findItem("conversation-a", "reason-1").text).toBe("Considering the tests");
  });

  it("patches subsequent agent message deltas after the first upsert", () => {
    const { proxy, sent } = makeProxy();
    proxy.rememberTurnConversationId("conversation-a", "turn-a");

    proxy.handleAgentMessageDelta({ turnId: "turn-a", itemId: "assistant-1", delta: "hello" });
    expect(sent[0].payload.item.text).toBe("hello");

    sent.length = 0;
    proxy.handleAgentMessageDelta({ turnId: "turn-a", itemId: "assistant-1", delta: " world" });
    expect(sent[0].payload.patch).toMatchObject({
      itemId: "assistant-1",
      textDelta: " world",
    });
    expect(proxy.findItem("conversation-a", "assistant-1").text).toBe("hello world");
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

  it("dedupes concurrent ensureProviderClient calls into one client start", async () => {
    const { proxy } = makeProxy();
    let starts = 0;
    const client = { newSession: async () => ({ sessionId: "thread-x" }) };
    proxy.startProviderClient = async () => {
      starts += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      proxy.clients.set("codex", client);
      return client;
    };

    // Eager initialize() racing conversation.open — both must share one spawn.
    const [first, second] = await Promise.all([
      proxy.ensureProviderClient("codex"),
      proxy.ensureProviderClient("codex"),
    ]);

    expect(starts).toBe(1);
    expect(first).toBe(client);
    expect(second).toBe(client);
    // Settled promise is dropped so a later restart is possible.
    expect(proxy.clientStartPromises.size).toBe(0);
  });

  it("retries a failed client start instead of memoizing the failure", async () => {
    const { proxy } = makeProxy();
    let starts = 0;
    proxy.startProviderClient = async () => {
      starts += 1;
      return undefined; // start failed (e.g. CLI missing)
    };

    expect(await proxy.ensureProviderClient("codex")).toBeUndefined();
    expect(await proxy.ensureProviderClient("codex")).toBeUndefined();
    expect(starts).toBe(2);
    expect(proxy.clientStartPromises.size).toBe(0);
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

  it("maps official Codex availableDecisions onto accept / acceptForSession", async () => {
    const { proxy, sent } = makeProxy();
    const pending = proxy.handlePermission({
      threadId: "thread-a",
      requestId: "perm-session",
      command: "pnpm test",
      cwd: "/tmp",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    }, true, "item/commandExecution/requestApproval");

    const request = sent.find((envelope) => envelope.type === "agent.v2.permission.request");
    expect(request?.payload.options).toEqual([
      { id: "accept", label: "允许一次", kind: "allow" },
      { id: "acceptForSession", label: "本会话允许", kind: "allow" },
      { id: "decline", label: "拒绝", kind: "deny" },
    ]);
    expect(JSON.parse(request?.payload.toolInput)).toEqual({
      command: "pnpm test",
      cwd: "/tmp",
    });

    await proxy.handleEnvelope({
      id: "env-perm-session",
      type: "agent.v2.permission.respond",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        requestId: "perm-session",
        outcome: "allow",
        optionId: "acceptForSession",
      },
    });

    await expect(pending).resolves.toEqual({ decision: "acceptForSession" });
  });

  it("does not invent a session-scoped decision when Codex did not offer one", async () => {
    const { proxy, sent } = makeProxy();
    const pending = proxy.handlePermission({
      threadId: "thread-a",
      requestId: "perm-once",
      command: "ls",
      availableDecisions: ["accept", "decline"],
    }, true, "item/commandExecution/requestApproval");

    const request = sent.find((envelope) => envelope.type === "agent.v2.permission.request");
    expect(request?.payload.options.map((option: { id: string }) => option.id)).toEqual([
      "accept",
      "decline",
    ]);

    await proxy.handleEnvelope({
      id: "env-perm-once",
      type: "agent.v2.permission.respond",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        requestId: "perm-once",
        outcome: "allow",
        optionId: "accept",
      },
    });

    await expect(pending).resolves.toEqual({ decision: "accept" });
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

  it("applies conversation.update settings locally and forwards them to Codex", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.get("conversation-a").archived = false;
    const calls: string[] = [];
    proxy.clients.set("codex", {
      setThreadName: async (input: any) => { calls.push(`name:${input.name}`); },
      archiveThread: async () => { calls.push("archive"); },
      updateThreadSettings: async (input: any) => { calls.push(`settings:${input.model}:${input.reasoningEffort}`); },
    });

    await proxy.handleEnvelope({
      id: "env-update",
      type: "agent.v2.conversation.update",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        title: "Renamed",
        archived: true,
        model: "gpt-5.5",
        reasoningEffort: "high",
        permissionMode: "workspace_write",
        collaborationMode: "plan",
      },
    });

    const conversation = proxy.conversations.get("conversation-a");
    expect(conversation.title).toBe("Renamed");
    expect(conversation.archived).toBe(true);
    expect(conversation.model).toBe("gpt-5.5");
    expect(conversation.reasoningEffort).toBe("high");
    expect(conversation.permissionMode).toBe("workspace_write");
    expect(conversation.collaborationMode).toBe("plan");
    expect(calls).toEqual(["name:Renamed", "archive", "settings:gpt-5.5:high"]);
    const echoed = sent.find((envelope) => envelope.type === "agent.v2.event" && envelope.payload.conversation);
    expect(echoed?.payload.conversation.title).toBe("Renamed");
  });

  it("forgets a conversation from the list without calling Codex thread/delete", async () => {
    const { proxy, sent } = makeProxy();
    const calls: string[] = [];
    proxy.clients.set("codex", {
      deleteThread: async () => { calls.push("delete"); },
    });

    await proxy.handleEnvelope({
      id: "env-delete",
      type: "agent.v2.conversation.delete",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a" },
    });

    expect(calls).toEqual([]);
    expect(proxy.conversations.has("conversation-a")).toBe(false);
    expect(proxy.deletedAgentSessionIds.has("thread-a")).toBe(true);
    expect(sent.some((envelope) =>
      envelope.type === "agent.v2.conversation.deleted" &&
      envelope.payload.conversationId === "conversation-a",
    )).toBe(true);
  });

  it("starts Codex MCP OAuth and returns the authorization url", async () => {
    const { proxy, sent } = makeProxy();
    proxy.clients.set("codex", {
      startMcpOAuth: async () => ({ authorization_url: "https://example.com/oauth" }),
    });

    await proxy.handleEnvelope({
      id: "env-mcp-login",
      type: "agent.v2.mcp.login",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { provider: "codex", serverName: "github" },
    });

    const result = sent.find((envelope) => envelope.type === "agent.v2.mcp.login.result");
    expect(result?.payload).toMatchObject({
      provider: "codex",
      serverName: "github",
      authorizationUrl: "https://example.com/oauth",
    });
  });

  it("tells the client to finish Claude MCP auth on the host", async () => {
    const { proxy, sent } = makeProxy();
    proxy.input.availableProviders = ["claude"];
    proxy.clients.set("claude", {});

    await proxy.handleEnvelope({
      id: "env-mcp-claude",
      type: "agent.v2.mcp.login",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { provider: "claude", serverName: "gh" },
    });

    const result = sent.find((envelope) => envelope.type === "agent.v2.mcp.login.result");
    expect(result?.payload.error).toMatch(/主机/);
  });

  it("merges Codex mcpServerStatus/list into capabilities and maps authStatus", async () => {
    const { proxy } = makeProxy();
    proxy.clients.set("codex", {
      listMcpServers: async () => ({
        data: [{ name: "github", authStatus: "needs_auth" }],
      }),
    });

    await proxy.refreshProviderCapabilities("codex", proxy.clients.get("codex"), "codex-app-server");

    expect(proxy.providerCapabilities.get("codex")?.mcpServers.get("github")).toMatchObject({
      name: "github",
      status: "needs_auth",
    });
  });

  it("marks an MCP server connected after oauthLogin/completed", () => {
    const { proxy, sent } = makeProxy();
    proxy.clients.set("codex", {});
    proxy.handleNotification("mcpServer/oauthLogin/completed", { name: "github", success: true });
    const last = [...sent].reverse().find((envelope) => envelope.type === "agent.v2.capabilities");
    const codex = last?.payload.providers?.find((provider: { id: string }) => provider.id === "codex");
    expect(codex?.mcpServers).toEqual([
      { name: "github", status: "connected" },
    ]);
  });

  it("maps thread/list object status { type: active } to running", async () => {
    const { proxy, sent } = makeProxy();
    proxy.conversations.clear();
    proxy.conversationByAgentSessionId.clear();
    proxy.initialized = true;
    proxy.clients.set("codex", {
      listSessions: async () => ({
        data: [
          {
            id: "thread-active-1",
            cwd: "/repo",
            title: "Live",
            status: { type: "active" },
          },
        ],
      }),
    });

    await proxy.handleEnvelope({
      id: "env-active-status",
      type: "agent.v2.snapshot.request",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {},
    });

    const snapshot = sent.find((envelope) => envelope.type === "agent.v2.snapshot");
    expect(snapshot?.payload.conversations[0].agentSessionId).toBe("thread-active-1");
    expect(snapshot?.payload.conversations[0].status).toBe("running");
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

  it("merges Codex skills/list names into provider commands", async () => {
    const { proxy } = makeProxy();
    proxy.providerCapabilities.clear();
    const stubClient = {
      listModels: async () => ({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] }),
      listSkills: async () => ({
        data: [{
          cwd: "/tmp",
          skills: [
            { name: "skill-creator", description: "Create a skill" },
          ],
        }],
      }),
    };

    await proxy.refreshProviderCapabilities("codex", stubClient, "codex-app-server");

    const names = (proxy.providerCapabilities.get("codex").commands ?? []).map((command: any) => command.name);
    expect(names).toContain("skill-creator");
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

describe("MCP server status on capabilities", () => {
  function makeClaudeProxy() {
    const sent: any[] = [];
    const proxy = new AgentWorkspaceProxy({
      sessionId: "session-1",
      cwd: "/tmp",
      availableProviders: ["claude"],
      discoverProcesses: () => [],
      send: (envelope) => sent.push(envelope),
    }) as any;
    // A registered client is what handleMcpStartupStatus keys off to pick the
    // provider (MCP is Claude-only today).
    proxy.clients.set("claude", { forkSession: () => undefined });
    return { proxy, sent };
  }

  function lastCapabilities(sent: any[]) {
    const envelope = [...sent].reverse().find((e) => e.type === "agent.v2.capabilities");
    return envelope?.payload.providers?.find((p: any) => p.id === "claude");
  }

  it("carries a connected MCP server (with tool count) from a startupStatus notification", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("mcpServer/startupStatus/everything", { status: "connected", tools: 12 });
    const claude = lastCapabilities(sent);
    expect(claude?.mcpServers).toEqual([
      { name: "everything", status: "connected", toolCount: 12 },
    ]);
  });

  it("maps an error status to failed and passes the error through", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("mcpServer/startupStatus/broken", { status: "error", error: "spawn failed" });
    const claude = lastCapabilities(sent);
    expect(claude?.mcpServers).toEqual([
      { name: "broken", status: "failed", error: "spawn failed" },
    ]);
  });

  it("normalizes an unknown status to pending rather than dropping the server", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("mcpServer/startupStatus/weird", { status: "who-knows" });
    const claude = lastCapabilities(sent);
    expect(claude?.mcpServers?.[0]).toMatchObject({ name: "weird", status: "pending" });
  });

  it("accumulates multiple servers and updates status last-writer-wins", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("mcpServer/startupStatus/a", { status: "connecting" });
    proxy.handleNotification("mcpServer/startupStatus/b", { status: "connected" });
    proxy.handleNotification("mcpServer/startupStatus/a", { status: "connected" });
    const claude = lastCapabilities(sent);
    const byName = Object.fromEntries((claude?.mcpServers ?? []).map((s: any) => [s.name, s.status]));
    expect(byName).toEqual({ a: "connected", b: "connected" });
  });

  it("seeds the MCP list from an initialized notification's mcpServers", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("initialized", {
      mcpServers: [
        { name: "fs", status: "connected" },
        { name: "db", status: "failed", error: "no socket" },
      ],
    });
    const claude = lastCapabilities(sent);
    const byName = Object.fromEntries((claude?.mcpServers ?? []).map((s: any) => [s.name, s.status]));
    expect(byName).toEqual({ fs: "connected", db: "failed" });
  });

  it("parses the real SDK McpServerStatus shape (needs-auth, disabled, tools[])", () => {
    // Ground-truth shapes from @anthropic-ai/claude-agent-sdk sdk.d.ts:968 —
    // status is 'connected'|'failed'|'needs-auth'|'pending'|'disabled', tools is
    // an array (its length is our toolCount).
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("initialized", {
      mcpServers: [
        { name: "gh", status: "needs-auth" },
        { name: "old", status: "disabled" },
        { name: "fs", status: "connected", tools: [{ name: "read" }, { name: "write" }] },
      ],
    });
    const claude = lastCapabilities(sent);
    const byName = Object.fromEntries((claude?.mcpServers ?? []).map((s: any) => [s.name, s]));
    expect(byName.gh.status).toBe("needs_auth");
    expect(byName.old.status).toBe("disabled");
    expect(byName.fs).toMatchObject({ status: "connected", toolCount: 2 });
  });

  it("treats authStatus needs_auth as needing authorization even when connected", () => {
    const { proxy, sent } = makeClaudeProxy();
    proxy.handleNotification("initialized", {
      mcpServers: [{ name: "gh", status: "connected", authStatus: "needs_auth" }],
    });
    const claude = lastCapabilities(sent);
    expect(claude?.mcpServers?.[0]).toMatchObject({ name: "gh", status: "needs_auth" });
  });
});

describe("host process discovery", () => {
  it("surfaces a live Gemini process and drops it after two missed polls", () => {
    const { proxy, sent } = makeProxy();
    let live = [
      { provider: "gemini", pid: "22", command: "gemini", cwd: "/tmp/proj" },
    ];
    proxy.input.discoverProcesses = () => live;

    proxy.reconcileDiscoveredProcesses();
    expect(proxy.conversations.get("agent-live-gemini-22")).toMatchObject({
      provider: "gemini",
      status: "running",
      cwd: "/tmp/proj",
    });
    expect(sent.some((envelope) => envelope.type === "agent.v2.conversation.list.result")).toBe(true);

    live = [];
    proxy.reconcileDiscoveredProcesses();
    expect(proxy.conversations.has("agent-live-gemini-22")).toBe(true);
    proxy.reconcileDiscoveredProcesses();
    expect(proxy.conversations.has("agent-live-gemini-22")).toBe(false);
    expect(sent.some((envelope) => envelope.type === "agent.v2.conversation.deleted")).toBe(true);
  });

  it("does not invent a remote protocol for a process-only provider", async () => {
    const { proxy, sent } = makeProxy();
    proxy.input.discoverProcesses = () => [
      { provider: "kimi", pid: "9", command: "kimi", cwd: "/tmp" },
    ];
    proxy.reconcileDiscoveredProcesses();

    await proxy.handleEnvelope({
      id: "env-open-kimi",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "agent-live-kimi-9", provider: "kimi" },
    });
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation.id).toBe("agent-live-kimi-9");

    await proxy.handleEnvelope({
      id: "env-prompt-kimi",
      type: "agent.v2.prompt",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "agent-live-kimi-9",
        clientMessageId: "m1",
        contentBlocks: [{ type: "text", text: "hi" }],
      },
    });
    const error = sent.find((envelope) => envelope.payload?.item?.type === "error");
    expect(error?.payload?.item?.error).toMatch(/终端|旁观/);
  });
});

describe("Codex rollout attach (same file, not a copy)", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { session_id: "s1", cwd: "/repo" } }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-13T00:00:00Z",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<app-context> skip" }] },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-13T00:00:01Z",
      payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "总结一下上周都做了什么？" }] },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-13T00:00:02Z",
      payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "按上周统计..." }] },
    }),
  ].join("\n") + "\n";

  it("parses the on-disk rollout into the existing conversation timeline", () => {
    const items = timelineItemsFromCodexRolloutText(rollout, "conv-1");
    expect(items.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(items[0]?.text).toContain("总结一下");
    expect(items[1]?.text).toContain("按上周统计");
  });

  it("tails new jsonl lines on the same parser instead of duplicating a session", () => {
    const parser = new CodexRolloutParser();
    const first = parser.consume(rollout, "conv-1");
    const more = parser.consume(
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-13T00:00:03Z",
        payload: { type: "message", id: "a2", role: "assistant", content: [{ type: "output_text", text: "补充一条新回复" }] },
      }) + "\n",
      "conv-1",
    );
    expect(first).toHaveLength(2);
    expect(more).toHaveLength(1);
    expect(more[0]?.id).toBe("a2");
    expect(more[0]?.text).toContain("补充一条新回复");
  });

  it("opens an external Codex conversation without newSession or loadSession", async () => {
    const { proxy, sent } = makeProxy();
    proxy.initialized = true;
    proxy.attachedExternalCodex.add("conversation-a");
    proxy.timelines.set("conversation-a", []);
    let newSessionCalls = 0;
    let loadSessionCalls = 0;
    proxy.clients.set("codex", {
      newSession: async () => {
        newSessionCalls += 1;
        return { sessionId: "thread-copy-should-not-happen" };
      },
      loadSession: async () => {
        loadSessionCalls += 1;
        return { thread: { id: "thread-copy-should-not-happen", turns: [] } };
      },
    });

    await proxy.handleEnvelope({
      id: "env-attach",
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a", provider: "codex", cwd: "/tmp" },
    });

    expect(newSessionCalls).toBe(0);
    expect(loadSessionCalls).toBe(0);
    const opened = sent.find((envelope) => envelope.type === "agent.v2.conversation.opened");
    expect(opened?.payload.conversation.agentSessionId).toBe("thread-a");
    expect(opened?.payload.conversation.id).toBe("conversation-a");
  });

  it("rejects prompt and cancel on an attached Codex session without calling app-server", async () => {
    const { proxy, sent } = makeProxy();
    proxy.initialized = true;
    proxy.attachedExternalCodex.add("conversation-a");
    proxy.conversations.get("conversation-a").control = "attached";
    let promptCalls = 0;
    let cancelCalls = 0;
    proxy.clients.set("codex", {
      prompt: async () => {
        promptCalls += 1;
        return {};
      },
      cancel: () => {
        cancelCalls += 1;
      },
    });

    await proxy.handleEnvelope({
      id: "env-prompt-ro",
      type: "agent.v2.prompt",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: {
        conversationId: "conversation-a",
        clientMessageId: "m-ro",
        contentBlocks: [{ type: "text", text: "插一句" }],
      },
    });
    await proxy.handleEnvelope({
      id: "env-cancel-ro",
      type: "agent.v2.cancel",
      sessionId: "session-1",
      timestamp: Date.now(),
      payload: { conversationId: "conversation-a" },
    });

    expect(promptCalls).toBe(0);
    expect(cancelCalls).toBe(0);
    const errors = sent.filter((envelope) => envelope.payload?.item?.type === "error" || envelope.payload?.item?.error);
    expect(JSON.stringify(sent)).toMatch(/旁观|无法停止/);
  });
});
