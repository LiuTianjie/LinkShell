import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpMcpBridge } from "../src/drivers/acp/mcp.js";

const bridges: AcpMcpBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); });
function setup() {
  const notifications: unknown[] = [];
  const bridge = new AcpMcpBridge({ env: process.env, notify: (value) => notifications.push(value), request: async () => ({}) }); bridges.push(bridge);
  const serverId = bridge.open({ type: "acp", name: "test", command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-operations.mjs", import.meta.url))], env: {} }, process.cwd());
  bridge.bind([serverId], "session");
  return { bridge, serverId, notifications };
}

describe("request-scoped MCP over ACP", () => {
  it("preserves opaque logical IDs, metadata and results and scopes progress", async () => {
    const f = setup(), signal = new AbortController().signal;
    const results = await Promise.all([f.bridge.request({ serverId: f.serverId, requestId: 7, method: "tools/call", params: { name: "one", _meta: { progressToken: "numeric", extension: true } } }, signal), f.bridge.request({ serverId: f.serverId, requestId: "7", method: "tools/call", params: { name: "two", _meta: { progressToken: "string" } } }, signal)]);
    expect(results).toMatchObject([{ result: { requestId: 7, echo: { _meta: { extension: true } } } }, { result: { requestId: "7" } }]);
    expect(f.notifications).toEqual([{ serverId: f.serverId, requestId: 7, method: "notifications/progress", params: { progressToken: "numeric", progress: 1, total: 1 } }, { serverId: f.serverId, requestId: "7", method: "notifications/progress", params: { progressToken: "string", progress: 1, total: 1 } }]);
  });
  it("keeps inner MCP errors separate from ACP errors and preserves a null result", async () => {
    const f = setup(), signal = new AbortController().signal;
    expect(await f.bridge.request({ serverId: f.serverId, requestId: "null", method: "null" }, signal)).toEqual({ result: null });
    expect(await f.bridge.request({ serverId: f.serverId, requestId: "error", method: "error" }, signal)).toEqual({ error: { code: -32000, message: "MCP error", data: null, extension: "preserved" } });
    await expect(f.bridge.request({ serverId: "unknown", requestId: "x", method: "tools/list" }, signal)).rejects.toThrow("未知");
  });
  it("cancels pending calls and removes only the closed session's server", async () => {
    const f = setup(), controller = new AbortController();
    const waiting = f.bridge.request({ serverId: f.serverId, requestId: "wait", method: "wait" }, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("取消"); controller.abort(); await rejected;
    await f.bridge.close("other-session");
    expect(await f.bridge.request({ serverId: f.serverId, requestId: "null", method: "null" }, new AbortController().signal)).toEqual({ result: null });
    await f.bridge.close("session");
    await expect(f.bridge.request({ serverId: f.serverId, requestId: "after", method: "tools/list" }, new AbortController().signal)).rejects.toThrow("未知");
  });
});
