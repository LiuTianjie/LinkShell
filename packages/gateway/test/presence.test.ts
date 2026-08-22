import { describe, expect, it, afterEach } from "vitest";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "@linkshell/protocol";
import { SessionManager } from "../src/sessions.js";
import { handleSocketMessage } from "../src/relay.js";
import { PresenceHub } from "../src/presence.js";

function mockSocket() {
  const sent: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => sent.push(data),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return { socket: socket as unknown as import("ws").default, sent };
}

const conversation = {
  id: "conv-1",
  provider: "codex" as const,
  cwd: "/repo",
  title: "fix login",
  status: "running" as const,
  archived: false,
  lastActivityAt: 100,
  createdAt: 1,
};

describe("agent summary cache", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers) manager.destroy();
    managers.length = 0;
  });

  it("updates HTTP summary from conversation.list.result", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const host = mockSocket();
    sessions.setHost("sess-1", {
      socket: host.socket,
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
    });

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.conversation.list.result",
          sessionId: "sess-1",
          payload: { conversations: [conversation] },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    const summary = sessions.getSummary("sess-1");
    expect(summary?.agentStatus).toBe("running");
    expect(summary?.agentTitle).toBe("fix login");
    expect(summary?.agentConversationId).toBe("conv-1");
  });

  it("buffers snapshot for later agent replay", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const host = mockSocket();
    const client = mockSocket();
    sessions.setHost("sess-1", {
      socket: host.socket,
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
    });
    sessions.addClient("sess-1", {
      socket: client.socket,
      role: "client",
      deviceId: "client-1",
      connectedAt: Date.now(),
    });

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.snapshot",
          sessionId: "sess-1",
          payload: {
            conversations: [conversation],
            items: [],
            activeConversationId: "conv-1",
          },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    const replay = sessions.getAgentReplay("sess-1");
    expect(replay).toHaveLength(1);
    expect(replay[0]?.type).toBe("agent.v2.snapshot");
  });

  it("notifies presence watchers when the visible summary changes", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const hub = new PresenceHub();
    sessions.onPresenceChange = (session) => hub.notify(session);
    sessions.getOrCreate("sess-1");

    const watcher = mockSocket();
    hub.add({
      socket: watcher.socket,
      sessionIds: () => new Set(["sess-1"]),
    });

    sessions.cacheAgentSummary("sess-1", {
      status: "running",
      title: "fix login",
      conversationId: "conv-1",
    });

    const frames = watcher.sent.map((raw) => parseEnvelope(raw));
    expect(frames.some((frame) => frame.type === "session.presence")).toBe(true);
    const presence = frames.find((frame) => frame.type === "session.presence");
    expect(presence?.payload).toMatchObject({
      agentStatus: "running",
      agentTitle: "fix login",
    });
  });

  it("caches a permission request as waiting_permission with a usable detail", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const hub = new PresenceHub();
    sessions.onPresenceChange = (session) => hub.notify(session);
    const host = mockSocket();
    sessions.setHost("sess-1", {
      socket: host.socket,
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
    });
    const watcher = mockSocket();
    hub.add({
      socket: watcher.socket,
      sessionIds: () => new Set(["sess-1"]),
    });

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.permission.request",
          sessionId: "sess-1",
          payload: {
            conversationId: "conv-1",
            requestId: "perm-1",
            toolName: "Bash",
            toolInput: JSON.stringify({ command: "pnpm test" }),
          },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    const summary = sessions.getSummary("sess-1");
    expect(summary?.agentStatus).toBe("waiting_permission");
    expect(summary?.agentDetail).toBe("运行命令 · pnpm test");
    const presence = watcher.sent.map((raw) => parseEnvelope(raw)).find((frame) => {
      const payload = frame.payload as { agentDetail?: string | null };
      return frame.type === "session.presence" && payload.agentDetail === "运行命令 · pnpm test";
    });
    expect(presence?.payload).toMatchObject({
      agentStatus: "waiting_permission",
      agentDetail: "运行命令 · pnpm test",
    });

    sessions.cacheAgentSummary("sess-1", { status: "idle" });
    expect(sessions.getSummary("sess-1")?.agentDetail).toBeNull();
  });

  it("does not let a later conversation list clobber a live permission detail", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const host = mockSocket();
    sessions.setHost("sess-1", {
      socket: host.socket,
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
    });

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.permission.request",
          sessionId: "sess-1",
          payload: {
            conversationId: "conv-1",
            requestId: "perm-1",
            toolName: "shell",
            toolInput: JSON.stringify({ command: "git status" }),
          },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.conversation.list.result",
          sessionId: "sess-1",
          payload: {
            conversations: [{
              ...conversation,
              id: "conv-1",
              status: "waiting_permission",
              lastMessagePreview: "thinking about tests",
            }],
          },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    expect(sessions.getSummary("sess-1")?.agentDetail).toBe("运行命令 · git status");
  });

  it("uses a running conversation preview as the list detail", () => {
    const sessions = new SessionManager();
    managers.push(sessions);
    const host = mockSocket();
    sessions.setHost("sess-1", {
      socket: host.socket,
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
    });

    handleSocketMessage(
      host.socket,
      serializeEnvelope(
        createEnvelope({
          type: "agent.v2.conversation.list.result",
          sessionId: "sess-1",
          payload: {
            conversations: [{
              ...conversation,
              lastMessagePreview: "正在改登录页",
            }],
          },
        }),
      ),
      "host",
      "sess-1",
      "host-1",
      sessions,
    );

    expect(sessions.getSummary("sess-1")).toMatchObject({
      agentStatus: "running",
      agentTitle: "fix login",
      agentDetail: "正在改登录页",
    });
  });
});
