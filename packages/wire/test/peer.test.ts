import { describe, expect, it } from "vitest";
import { ABANDON, RpcError, RpcPeer } from "../src/peer.js";
import { decodeDirectFrame, DIRECT_MAX_FRAME_BYTES, encodeDirectFrame, parseSessionId, sessionIdFor, sessionUpdateSchema } from "../src/index.js";

function pair(handlers: {
  onRequest?: ConstructorParameters<typeof RpcPeer>[0]["onRequest"];
  onNotification?: ConstructorParameters<typeof RpcPeer>[0]["onNotification"];
} = {}) {
  let right!: RpcPeer;
  const left = new RpcPeer({ send: (text) => queueMicrotask(() => right.receive(text)), requestTimeoutMs: 200 });
  right = new RpcPeer({ send: (text) => queueMicrotask(() => left.receive(text)), ...handlers });
  return { left, right };
}

describe("RpcPeer", () => {
  it("answers a mixed asynchronous JSON-RPC batch once and leaves notifications unanswered", async () => {
    const replies: unknown[] = [], notices: string[] = [];
    const peer = new RpcPeer({ send: (text) => replies.push(JSON.parse(text)), onNotification: (method) => notices.push(method), onRequest: async (method) => { if (method === "slow") await new Promise((resolve) => setTimeout(resolve, 10)); return method; } });
    peer.receive(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "slow" }, { jsonrpc: "2.0", method: "notice" }, { jsonrpc: "2.0", id: "1", method: "fast" }, null]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(notices).toEqual(["notice"]); expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual(expect.arrayContaining([{ jsonrpc: "2.0", id: 1, result: "slow" }, { jsonrpc: "2.0", id: "1", result: "fast" }, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC request" } }]));
    peer.close();
  });
  it("round-trips a request", async () => {
    const { left } = pair({ onRequest: (method, params) => ({ method, echo: params }) });
    await expect(left.request("ping", { a: 1 })).resolves.toEqual({ method: "ping", echo: { a: 1 } });
  });

  it("carries application errors with their code", async () => {
    const { left } = pair({
      onRequest: () => {
        throw RpcError.app("not_found", "no such session");
      },
    });
    const error = await left.request("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).appCode).toBe("not_found");
    expect((error as RpcError).message).toBe("no such session");
  });

  it("delivers notifications", async () => {
    const seen: unknown[] = [];
    const { left } = pair({ onNotification: (method, params) => seen.push([method, params]) });
    left.notify("hello", { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([["hello", { n: 1 }]]);
  });

  it("never answers an abandoned request, so the caller times out", async () => {
    const { left } = pair({ onRequest: () => ABANDON });
    const error = await left.request("approval", {}, 30).catch((e: unknown) => e);
    expect((error as RpcError).appCode).toBe("timeout");
  });

  it("rejects in-flight requests on close", async () => {
    const { left } = pair({ onRequest: () => new Promise(() => {}) });
    const pending = left.request("slow", {}, 0);
    left.close();
    await expect(pending).rejects.toMatchObject({ data: { code: "closed" } });
  });

  it("emits $/cancelRequest on outbound timeout and aborts the remote handler's AbortSignal", async () => {
    const wireFrames: Array<Record<string, unknown>> = [];
    let aborted = false;
    let release!: () => void;
    let right!: RpcPeer;
    const left = new RpcPeer({
      send: (text) => {
        wireFrames.push(JSON.parse(text) as Record<string, unknown>);
        queueMicrotask(() => right.receive(text));
      },
      requestTimeoutMs: 20,
    });
    const rightSent: string[] = [];
    right = new RpcPeer({
      send: (text) => {
        rightSent.push(text);
        queueMicrotask(() => left.receive(text));
      },
      onRequest: (_method, _params, _id, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          release = () => resolve({ ok: true });
        }),
    });

    const err = await left.request("fs.projectFiles", { cwd: "/repo" }, 20).catch((e: unknown) => e);
    expect((err as RpcError).appCode).toBe("timeout");
    await new Promise((r) => setTimeout(r, 5));

    expect(wireFrames).toContainEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 1 },
    });
    expect(aborted).toBe(true);

    // Resolving after cancellation does not emit a stale response frame.
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(rightSent).toEqual([]);
  });

  it("aborts only the matching inbound request on $/cancelRequest and aborts remaining inbound requests on close()", async () => {
    const signals = new Map<string | number, AbortSignal>();
    const peer = new RpcPeer({
      send: () => {},
      onRequest: (_method, _params, id, signal) => {
        signals.set(id, signal);
        return new Promise(() => {});
      },
    });

    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slowA", params: {} }));
    peer.receive(
      `${JSON.stringify({ jsonrpc: "2.0", id: "req-2", method: "slowB", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } })}`,
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(signals.get(1)?.aborted).toBe(true);
    expect(signals.get("req-2")?.aborted).toBe(false);

    peer.close();
    expect(signals.get("req-2")?.aborted).toBe(true);
  });
});

describe("wire model", () => {
  it("builds and parses session ids", () => {
    expect(sessionIdFor("codex", "01a0-f056")).toBe("codex:01a0-f056");
    expect(parseSessionId("claude:abc:def")).toEqual({ agent: "claude", nativeId: "abc:def" });
    expect(parseSessionId("nocolon")).toBeNull();
  });

  it("validates ACP-shaped updates including replace flag on message and thought chunks", () => {
    expect(
      sessionUpdateSchema.safeParse({
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hi" },
        replace: true,
      }).success,
    ).toBe(true);
    expect(
      sessionUpdateSchema.safeParse({
        sessionUpdate: "agent_thought_chunk",
        messageId: "t1",
        content: { type: "text", text: "thinking" },
        replace: true,
      }).success,
    ).toBe(true);
    expect(
      sessionUpdateSchema.safeParse({ sessionUpdate: "ls_permission", requestId: "1", title: "Run", options: [] })
        .success,
    ).toBe(false);
  });

  it("rejects direct frames exceeding 16 MiB while accepting valid frames", () => {
    const ok = encodeDirectFrame({ type: "data", stream: 7, data: new Uint8Array([1, 2, 3]) });
    expect(decodeDirectFrame(ok)).toEqual({ type: "data", stream: 7, data: new Uint8Array([1, 2, 3]) });
    expect(decodeDirectFrame(new Uint8Array(DIRECT_MAX_FRAME_BYTES + 1))).toBeUndefined();
  });
});
