import { describe, expect, it, vi } from "vitest";
import { createEnvelope, type Envelope } from "@linkshell/protocol";
import {
  BridgeSession,
  resolveAgentWorkspaceProviders,
  resolvePairingGateway,
  type BridgeSessionOptions,
} from "../src/runtime/bridge-session.js";

function makeBridge(options: Partial<BridgeSessionOptions> = {}) {
  return new BridgeSession({
    gatewayUrl: "ws://localhost:8787/ws",
    gatewayHttpUrl: "http://localhost:8787",
    sessionId: "session-1",
    cols: 120,
    rows: 36,
    clientName: "test-cli",
    providerConfig: {
      provider: "custom",
      command: "/bin/sh",
      args: [],
      env: {},
    },
    keepAwake: false,
    agentUi: true,
    ...options,
  }) as any;
}

describe("BridgeSession agent v2 routing", () => {
  it("keeps explicit agent commands scoped to a single selected workspace provider", () => {
    expect(resolveAgentWorkspaceProviders({
      agentProvider: "claude",
      agentCommand: "claude --print --output-format stream-json",
    })).toEqual(["claude"]);
    expect(resolveAgentWorkspaceProviders({
      agentCommand: "custom-agent --stdio",
    })).toEqual(["custom"]);
  });

  it("exposes Codex and Claude workspace providers by default", () => {
    const providers = resolveAgentWorkspaceProviders({});
    expect(providers).toContain("codex");
    expect(providers).toContain("claude");
  });

  it("routes shared agent v2 client read/write messages to AgentWorkspace", async () => {
    const bridge = makeBridge();
    const handleEnvelope = vi.fn(async () => {});
    const refreshAgentPermissionHooks = vi.fn();
    bridge.agentWorkspace = { handleEnvelope };
    bridge.refreshAgentPermissionHooks = refreshAgentPermissionHooks;

    const read = createEnvelope({
      type: "agent.v2.snapshot.request",
      sessionId: "session-1",
      payload: {},
    });
    const write = createEnvelope({
      type: "agent.v2.prompt",
      sessionId: "session-1",
      payload: {
        conversationId: "conversation-1",
        clientMessageId: "message-1",
        contentBlocks: [{ type: "text", text: "hello" }],
      },
    });
    const command = createEnvelope({
      type: "agent.v2.command.execute",
      sessionId: "session-1",
      payload: {
        conversationId: "conversation-1",
        commandId: "model",
        rawText: "/model gpt-5",
        clientMessageId: "message-2",
      },
    });

    await bridge.handleMessage(read);
    await bridge.handleMessage(write);
    await bridge.handleMessage(command);

    expect(handleEnvelope).toHaveBeenCalledTimes(3);
    expect(handleEnvelope.mock.calls.map((call) => call[0].type)).toEqual([
      "agent.v2.snapshot.request",
      "agent.v2.prompt",
      "agent.v2.command.execute",
    ]);
    expect(refreshAgentPermissionHooks).toHaveBeenCalledTimes(2);
  });

  it("reports disabled agent v2 capabilities when AgentWorkspace is unavailable", async () => {
    const bridge = makeBridge({ agentUi: false, agentProvider: "claude" });
    const sent: Envelope[] = [];
    bridge.send = (envelope: Envelope) => sent.push(envelope);

    await bridge.handleMessage(
      createEnvelope({
        type: "agent.v2.capabilities.request",
        sessionId: "session-1",
        payload: {},
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("agent.v2.capabilities");
    expect(sent[0]?.payload).toMatchObject({
      enabled: false,
      provider: "claude",
      workspaceProtocolVersion: 2,
      supportsCancel: false,
    });
  });
});

describe("resolvePairingGateway", () => {
  it("normalizes host:port overrides using the gateway protocol", () => {
    expect(resolvePairingGateway("http://localhost:8787", "192.168.1.20:8787")).toBe(
      "http://192.168.1.20:8787",
    );
  });

  it("normalizes bare host overrides", () => {
    expect(resolvePairingGateway("https://gateway.example.com", "lan.example.test")).toBe(
      "https://lan.example.test",
    );
  });

  it("strips path, query, and hash from absolute gateway URLs", () => {
    expect(
      resolvePairingGateway(
        "http://localhost:8787",
        "https://gateway.example.com/api?token=secret#debug",
      ),
    ).toBe("https://gateway.example.com");
  });
});
