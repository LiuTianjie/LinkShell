import { describe, expect, it } from "vitest";
import { itemToHistory, mapNotification } from "../src/drivers/codex/mapper.js";
import { MAX_INLINE_IMAGE } from "../src/drivers/images.js";

const png = "iVBORw0KGgo=";
const dynamic = {
  id: "computer", type: "dynamicToolCall", tool: "mcp__cua_repl__js", status: "completed", success: true,
  arguments: { title: "检查登录窗口", code: "await app.getState()" },
  contentItems: [{ type: "inputText", text: "Window ready" }, { type: "inputImage", imageUrl: `data:image/png;base64,${png}` }],
};

describe("Codex computer-use output", () => {
  it("keeps dynamic screenshots and text in both history and live completion", () => {
    const history = itemToHistory(dynamic)!;
    expect(history.updates[0]).toMatchObject({ title: "mcp__cua_repl__js", rawInput: dynamic.arguments });
    expect(history.updates[1]).toMatchObject({ status: "completed", content: [
      { type: "content", content: { type: "text", text: "Window ready" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: png } },
    ] });
    const live = mapNotification("item/completed", { threadId: "thread", item: dynamic }, () => ({}));
    expect(live.map((entry) => entry.update)).toEqual(history.updates);
  });

  it("preserves MCP results and their errors", () => {
    const item = { id: "mcp", type: "mcpToolCall", server: "cua_repl", tool: "js", status: "completed", result: { isError: true, content: [{ type: "image", mimeType: "image/png", data: png }] } };
    expect(itemToHistory(item)?.updates[1]).toMatchObject({ status: "failed", content: [{ type: "content", content: { type: "image", data: png } }] });
    expect(itemToHistory({ ...dynamic, success: false })?.updates[1]).toMatchObject({ status: "failed" });
  });

  it("does not fetch URLs or forward malformed and oversized screenshot payloads", () => {
    const contentItems = ["file:///private/image.png", "https://example.com/image.png", "data:text/html;base64,AAAA", "data:image/png;base64,!", `data:image/png;base64,${"A".repeat(MAX_INLINE_IMAGE + 1)}`].map((imageUrl) => ({ type: "inputImage", imageUrl }));
    expect(itemToHistory({ ...dynamic, contentItems })?.updates[1]).not.toHaveProperty("content");
  });

  it("still accepts legacy dynamic MCP-shaped results", () => {
    const item = { ...dynamic, contentItems: undefined, result: { content: [{ type: "image", mimeType: "image/png", data: png }] } };
    expect(itemToHistory(item)?.updates[1]).toMatchObject({ content: [{ type: "content", content: { type: "image", data: png } }] });
  });
});
