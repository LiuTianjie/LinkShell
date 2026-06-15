import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
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

describe("BridgeSession default workspace", () => {
  it("uses the user's home directory instead of the CLI launch cwd", () => {
    const bridge = makeBridge({ agentUi: false });
    expect(bridge.defaultCwd).toBe(resolve(homedir()));
  });
});

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

describe("BridgeSession reconnect resilience", () => {
  it("never stops scheduling reconnects (no attempt ceiling) until stop()", () => {
    const bridge = makeBridge();
    vi.useFakeTimers();
    try {
      // Simulate a long outage: many consecutive failures should always arm a
      // new reconnect timer — the host must never give up on its own.
      for (let i = 0; i < 100; i++) {
        bridge.reconnecting = false;
        bridge.scheduleReconnect();
        expect(bridge.reconnectTimer).toBeDefined();
        // Fire the timer; connectGateway is stubbed to avoid real sockets.
        bridge.connectGateway = vi.fn(async () => {});
        vi.runOnlyPendingTimers();
      }
      expect(bridge.reconnectAttempts).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reconnecting after stop()", () => {
    const bridge = makeBridge();
    bridge.stop(0);
    bridge.scheduleReconnect();
    expect(bridge.reconnectTimer).toBeUndefined();
  });

  it("keeps the last auth token when refresh fails (does not downgrade to no-auth)", async () => {
    const bridge = makeBridge({ authToken: "old-token" });
    // getValidToken returning null simulates an offline/transient refresh fail.
    const auth = await import("../src/auth.js");
    const spy = vi.spyOn(auth, "getValidToken").mockResolvedValue(null);
    const resolved = await bridge.resolveAuthToken();
    expect(resolved).toBe("old-token");
    expect(bridge.options.authToken).toBe("old-token");
    spy.mockRestore();
  });

  it("returns undefined auth token only when the user never logged in", async () => {
    const bridge = makeBridge({ authToken: undefined });
    expect(await bridge.resolveAuthToken()).toBeUndefined();
  });

  it("force-refreshes the token on auth-class close codes", async () => {
    const bridge = makeBridge({ authToken: "old-token" });
    const auth = await import("../src/auth.js");
    const spy = vi.spyOn(auth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      userId: "u",
    } as any);
    await bridge.maybeRefreshTokenForClose(4001);
    expect(spy).toHaveBeenCalledOnce();
    expect(bridge.options.authToken).toBe("fresh-token");
    spy.mockRestore();
  });

  it("does NOT refresh the token on a clean close", async () => {
    const bridge = makeBridge({ authToken: "old-token" });
    const auth = await import("../src/auth.js");
    const spy = vi.spyOn(auth, "refreshAccessToken").mockResolvedValue(null);
    await bridge.maybeRefreshTokenForClose(1000); // normal closure
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
