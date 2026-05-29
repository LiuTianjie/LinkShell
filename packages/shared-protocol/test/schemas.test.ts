import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  agentV2ClientReadMessageTypes,
  agentV2ClientWriteMessageTypes,
  agentV2HostToClientMessageTypes,
  agentV2MessageRoute,
  createEnvelope,
  isAgentV2ClientReadMessage,
  isAgentV2ClientWriteMessage,
  isAgentV2HostToClientMessage,
  isProtocolVersionCompatible,
  parseEnvelope,
  parseTypedPayload,
  PROTOCOL_MIN_COMPATIBLE_VERSION,
  PROTOCOL_VERSION,
  protocolMessageSchemas,
  serializeEnvelope,
} from "../src/index.js";

describe("envelope helpers", () => {
  it("round-trips through serialize and parse", () => {
    const envelope = createEnvelope({
      type: "session.heartbeat",
      sessionId: "session-1",
      payload: { ts: 1717171717000 },
    });
    expect(envelope.id).toBeTruthy();
    expect(envelope.timestamp).toMatch(/T/);

    const parsed = parseEnvelope(serializeEnvelope(envelope));
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.type).toBe("session.heartbeat");
    expect(parsed.payload).toEqual({ ts: 1717171717000 });
  });
});

describe("agent.v2.notice schema", () => {
  it("accepts the smallest valid payload", () => {
    const payload = parseTypedPayload("agent.v2.notice", {
      kind: "model_changed",
      title: "Switched to Sonnet",
    });
    expect(payload.kind).toBe("model_changed");
    expect(payload.detail).toBeUndefined();
  });

  it("retains optional fields when present", () => {
    const payload = parseTypedPayload("agent.v2.notice", {
      conversationId: "conv-1",
      kind: "native_unsupported",
      title: "/plan unsupported",
      detail: "Claude has no native plan command",
      durationMs: 2400,
    });
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.detail).toContain("plan");
    expect(payload.durationMs).toBe(2400);
  });

  it("rejects payloads missing required fields", () => {
    expect(() =>
      parseTypedPayload("agent.v2.notice", { kind: "info" }),
    ).toThrow();
    expect(() =>
      parseTypedPayload("agent.v2.notice", { title: "no kind" }),
    ).toThrow();
  });

  it("rejects unknown notice kinds", () => {
    expect(() =>
      parseTypedPayload("agent.v2.notice", {
        kind: "rocket_launched",
        title: "boom",
      }),
    ).toThrow();
  });
});

describe("agent.v2.capabilities defaults", () => {
  it("fills required defaults when only provider info is supplied", () => {
    const payload = parseTypedPayload("agent.v2.capabilities", {
      enabled: true,
      provider: "claude",
    });
    expect(payload.supportsSessionList).toBe(false);
    expect(payload.supportsImages).toBe(false);
    expect(payload.workspaceProtocolVersion).toBe(2);
  });
});

describe("agent.v2.prompt schema", () => {
  it("defaults delivery to auto", () => {
    const payload = parseTypedPayload("agent.v2.prompt", {
      conversationId: "conversation-1",
      clientMessageId: "msg-1",
      contentBlocks: [{ type: "text", text: "hello" }],
    });
    expect(payload.delivery).toBe("auto");
  });

  it("accepts active-turn steering metadata", () => {
    const payload = parseTypedPayload("agent.v2.prompt", {
      conversationId: "conversation-1",
      clientMessageId: "msg-1",
      contentBlocks: [{ type: "text", text: "focus tests first" }],
      delivery: "steer",
      targetTurnId: "turn-1",
    });
    expect(payload.delivery).toBe("steer");
    expect(payload.targetTurnId).toBe("turn-1");
  });
});

describe("agent.v2.conversation.opened schema", () => {
  it("keeps the client-requested conversation id for temporary id reconciliation", () => {
    const payload = parseTypedPayload("agent.v2.conversation.opened", {
      requestedConversationId: "agent-temp-client",
      conversation: {
        id: "agent-remote-codex-thread-1",
        provider: "codex",
        cwd: "/repo",
        title: "repo",
        status: "idle",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
      snapshot: [],
    });
    expect(payload.requestedConversationId).toBe("agent-temp-client");
    expect(payload.conversation.id).toBe("agent-remote-codex-thread-1");
  });
});

describe("protocol message registry", () => {
  it("includes the new agent.v2.notice key", () => {
    expect(Object.prototype.hasOwnProperty.call(protocolMessageSchemas, "agent.v2.notice")).toBe(true);
  });

  it("classifies agent.v2 routes for gateway and clients", () => {
    expect(agentV2MessageRoute("agent.v2.event")).toBe("host_to_client");
    expect(agentV2MessageRoute("agent.v2.prompt")).toBe("client_write");
    expect(agentV2MessageRoute("agent.v2.snapshot.request")).toBe("client_read");
    expect(agentV2MessageRoute("terminal.output")).toBeNull();
  });

  it("classifies every registered agent.v2 message exactly once", () => {
    const registered = Object.keys(protocolMessageSchemas)
      .filter((type) => type.startsWith("agent.v2."))
      .sort();
    const classified = [
      ...agentV2HostToClientMessageTypes,
      ...agentV2ClientWriteMessageTypes,
      ...agentV2ClientReadMessageTypes,
    ].sort();

    expect(classified).toEqual(registered);
    expect(new Set(classified).size).toBe(classified.length);

    for (const type of agentV2HostToClientMessageTypes) {
      expect(agentV2MessageRoute(type)).toBe("host_to_client");
      expect(isAgentV2HostToClientMessage(type)).toBe(true);
      expect(isAgentV2ClientWriteMessage(type)).toBe(false);
      expect(isAgentV2ClientReadMessage(type)).toBe(false);
    }
    for (const type of agentV2ClientWriteMessageTypes) {
      expect(agentV2MessageRoute(type)).toBe("client_write");
      expect(isAgentV2ClientWriteMessage(type)).toBe(true);
      expect(isAgentV2HostToClientMessage(type)).toBe(false);
      expect(isAgentV2ClientReadMessage(type)).toBe(false);
    }
    for (const type of agentV2ClientReadMessageTypes) {
      expect(agentV2MessageRoute(type)).toBe("client_read");
      expect(isAgentV2ClientReadMessage(type)).toBe(true);
      expect(isAgentV2HostToClientMessage(type)).toBe(false);
      expect(isAgentV2ClientWriteMessage(type)).toBe(false);
    }
  });
});

describe("parseEnvelope validation", () => {
  const validBase = {
    id: "msg-1",
    type: "session.heartbeat",
    sessionId: "session-1",
    timestamp: "2026-05-29T00:00:00.000Z",
    payload: { ts: 1 },
  };

  it("accepts a well-formed envelope", () => {
    const parsed = parseEnvelope(JSON.stringify(validBase));
    expect(parsed.sessionId).toBe("session-1");
  });

  const malformed: Array<[string, Record<string, unknown>]> = [
    ["missing sessionId", { ...validBase, sessionId: undefined }],
    ["empty sessionId", { ...validBase, sessionId: "" }],
    ["missing id", { ...validBase, id: undefined }],
    ["empty type", { ...validBase, type: "" }],
    ["non-datetime timestamp", { ...validBase, timestamp: "not-a-date" }],
    ["numeric timestamp", { ...validBase, timestamp: 1717171717000 }],
    ["negative seq", { ...validBase, seq: -1 }],
  ];

  it.each(malformed)("rejects envelope with %s", (_label, input) => {
    expect(() => parseEnvelope(JSON.stringify(input))).toThrow(ZodError);
  });
});

describe("parseTypedPayload unknown type handling", () => {
  it("throws a ZodError (not a raw TypeError) for an unregistered type", () => {
    // Cast through unknown so the test can exercise the runtime guard.
    const call = () =>
      parseTypedPayload("not.a.real.type" as never, { foo: "bar" });
    expect(call).toThrow(ZodError);
    let caught: unknown;
    try {
      call();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect(caught).not.toBeInstanceOf(TypeError);
  });

  it("throws a ZodError for inherited object keys like toString", () => {
    expect(() =>
      parseTypedPayload("toString" as never, {}),
    ).toThrow(ZodError);
  });
});

describe("payload size caps", () => {
  it("rejects oversized terminal.output data", () => {
    const tooBig = "a".repeat(1_048_576 + 1);
    expect(() =>
      parseTypedPayload("terminal.output", { stream: "stdout", data: tooBig }),
    ).toThrow(ZodError);
  });

  it("accepts terminal.output data at the cap boundary", () => {
    const atCap = "a".repeat(1_048_576);
    const payload = parseTypedPayload("terminal.output", {
      stream: "stdout",
      data: atCap,
    });
    expect(payload.data.length).toBe(1_048_576);
  });

  it("rejects oversized file.upload data", () => {
    const tooBig = "a".repeat(8_388_608 + 1);
    expect(() =>
      parseTypedPayload("file.upload", { data: tooBig, filename: "x.txt" }),
    ).toThrow(ZodError);
  });
});

describe("file.upload filename traversal guard", () => {
  it("rejects path traversal segments", () => {
    expect(() =>
      parseTypedPayload("file.upload", { data: "", filename: "../etc/passwd" }),
    ).toThrow(ZodError);
  });

  it("rejects absolute paths", () => {
    expect(() =>
      parseTypedPayload("file.upload", { data: "", filename: "/etc/passwd" }),
    ).toThrow(ZodError);
  });

  it("accepts a plain filename", () => {
    const payload = parseTypedPayload("file.upload", {
      data: "",
      filename: "report.txt",
    });
    expect(payload.filename).toBe("report.txt");
  });
});

describe("pairingCode digit constraint", () => {
  it("accepts a six-digit code", () => {
    const payload = parseTypedPayload("pairing.claim", { pairingCode: "123456" });
    expect(payload.pairingCode).toBe("123456");
  });

  it("rejects a non-digit six-char code", () => {
    expect(() =>
      parseTypedPayload("pairing.claim", { pairingCode: "abcdef" }),
    ).toThrow(ZodError);
  });

  it("rejects a code of the wrong length", () => {
    expect(() =>
      parseTypedPayload("pairing.claim", { pairingCode: "12345" }),
    ).toThrow(ZodError);
  });
});

describe("protocol version negotiation", () => {
  it("treats a missing version as a compatible legacy client", () => {
    expect(isProtocolVersionCompatible(undefined)).toBe(true);
  });

  it("accepts the current and minimum compatible versions", () => {
    expect(isProtocolVersionCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolVersionCompatible(PROTOCOL_MIN_COMPATIBLE_VERSION)).toBe(true);
  });

  it("accepts a newer version (forward compatible)", () => {
    expect(isProtocolVersionCompatible(PROTOCOL_VERSION + 5)).toBe(true);
  });

  it("rejects a version older than the minimum compatible", () => {
    expect(isProtocolVersionCompatible(PROTOCOL_MIN_COMPATIBLE_VERSION - 1)).toBe(false);
  });

  it("rejects a non-finite version", () => {
    expect(isProtocolVersionCompatible(Number.NaN)).toBe(false);
  });
});

