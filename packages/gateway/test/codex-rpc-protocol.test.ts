import { describe, expect, it } from "vitest";
import { parseTypedPayload } from "@linkshell/protocol";

describe("agent.codex.rpc payload", () => {
  it("accepts JSON-RPC requests, notifications, responses, and errors", () => {
    expect(parseTypedPayload("agent.codex.rpc", {
      jsonrpc: "2.0",
      id: "1",
      method: "thread/list",
      params: { limit: 5 },
    })).toMatchObject({ id: "1", method: "thread/list" });

    expect(parseTypedPayload("agent.codex.rpc", {
      method: "initialized",
    })).toMatchObject({ method: "initialized" });

    expect(parseTypedPayload("agent.codex.rpc", {
      id: "1",
      result: { threads: [] },
    })).toMatchObject({ id: "1", result: { threads: [] } });

    expect(parseTypedPayload("agent.codex.rpc", {
      id: "1",
      error: { code: -32000, message: "boom" },
    })).toMatchObject({ id: "1", error: { message: "boom" } });
  });

  it("rejects malformed JSON-RPC payloads", () => {
    expect(() => parseTypedPayload("agent.codex.rpc", { params: {} })).toThrow();
    expect(() => parseTypedPayload("agent.codex.rpc", { id: "1" })).toThrow();
    expect(() => parseTypedPayload("agent.codex.rpc", { method: "" })).toThrow();
    expect(() => parseTypedPayload("agent.codex.rpc", {
      id: "1",
      result: {},
      error: { code: -32000, message: "boom" },
    })).toThrow();
  });
});
