import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import { applyEvents, emptyView } from "../src/timeline.js";
import { userEventLabel, userMessageText, userMessageView } from "../src/user-message.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const event = (seq: number, messageId: string, value: string): SessionEvent => ({ sessionId: "s", seq, ts: seq, update: { sessionUpdate: "user_message_chunk", messageId, content: text(value) } });

describe("user message view", () => {
  it("gives no item to a message only the agent reads, so it can't split a run of steps", () => {
    const view = applyEvents(emptyView("s"), [event(1, "a", "<system-reminder>todo list is empty</system-reminder>"), event(2, "b", "真正的问题")]);
    expect(view.items.map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps a picture sent with only an envelope", () => {
    const blocks = [text("\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\nImage attachment: true\n\n## My request:\n"), { type: "image" as const, mimeType: "image/png", data: "x" }];
    expect(userMessageView(blocks)).toMatchObject({ text: "", hidden: false, context: [] });
    expect(userMessageText(blocks)).toBe("");
  });

  it("names events", () => {
    expect(userEventLabel({ kind: "ci", count: 2 })).toBe("收到 2 个 CI 事件");
    expect(userEventLabel({ kind: "sessions", sessions: [{ title: "打包" }] })).toBe("「打包」完成了一轮");
    expect(userEventLabel({ kind: "scheduled", name: "morning" })).toBe("定时任务：morning");
  });
});
