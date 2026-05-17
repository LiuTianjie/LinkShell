import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
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

describe("protocol message registry", () => {
  it("includes the new agent.v2.notice key", () => {
    expect(Object.prototype.hasOwnProperty.call(protocolMessageSchemas, "agent.v2.notice")).toBe(true);
  });
});
