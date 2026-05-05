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
});
