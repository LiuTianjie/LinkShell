import { describe, expect, it } from "vitest";
import type { SideChat } from "@linkshell/wire";
import { SideChats } from "../src/side.js";
import type { AgentDriver, SideOutput, SideRequest } from "../src/drivers/types.js";

function fakeDriver(answer: (request: SideRequest, out: SideOutput, signal: AbortSignal) => Promise<void>, side = true): AgentDriver {
  return { id: "fake", label: "Fake", capabilities: { side }, sideAsk: (_id: string, request: SideRequest, out: SideOutput, signal: AbortSignal) => answer(request, out, signal) } as unknown as AgentDriver;
}

async function settled(events: SideChat[], count: number): Promise<SideChat> {
  for (let i = 0; i < 200; i++) {
    const done = events.filter((chat) => !chat.running);
    if (done.length >= count) return done[count - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no answer");
}

describe("side conversations", () => {
  it("streams an answer, passes earlier questions along, and refuses a second question while one is answered", async () => {
    const events: SideChat[] = [];
    const chats = new SideChats((_sessionId, side) => events.push(side), () => {});
    const seen: SideRequest[] = [];
    let release!: () => void;
    const driver = fakeDriver(async (request, out) => {
      seen.push(request);
      out.activity("read a.ts");
      out.text("an ");
      if (request.question === "slow") await new Promise<void>((resolve) => (release = resolve));
      out.text(`answer to ${request.question}`);
    });
    const target = { driver, nativeId: "n", cwd: "/w" };
    const first = chats.ask("s", target, undefined, "one");
    expect((await settled(events, 1)).messages[1]).toMatchObject({ role: "assistant", text: "an answer to one", activity: ["read a.ts"] });

    chats.ask("s", target, first.sideId, "slow");
    expect(() => chats.ask("s", target, first.sideId, "three")).toThrow(/还在回答/);
    release();
    const done = await settled(events, 2);
    expect(done.messages.map((message) => message.text)).toEqual(["one", "an answer to one", "slow", "an answer to slow"]);
    expect(seen[1]!.history).toEqual([{ question: "one", answer: "an answer to one" }]);
  });

  it("stops an answer, reports a failure as the answer's error, and closes", async () => {
    const events: SideChat[] = [];
    let closed = false;
    const chats = new SideChats((_sessionId, side, isClosed) => { events.push(side); closed ||= isClosed === true; }, () => {});
    const driver = fakeDriver((request, _out, signal) => request.question === "fail"
      ? Promise.reject(new Error("先发一条再问"))
      : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())));
    const target = { driver, nativeId: "n", cwd: "/w" };
    const chat = chats.ask("s", target, undefined, "wait");
    chats.cancel("s", chat.sideId);
    const stopped = await settled(events, 1);
    expect(stopped.messages[1]!.error).toBe("已停止");

    chats.ask("s", target, chat.sideId, "fail");
    expect((await settled(events, 2)).messages[3]!.error).toBe("先发一条再问");

    await chats.close("s", chat.sideId, driver, "n");
    expect(closed).toBe(true);
    expect(chats.list("s")).toEqual([]);
  });

  it("only for an agent that has one", () => {
    const chats = new SideChats(() => {}, () => {});
    expect(() => chats.ask("s", { driver: fakeDriver(async () => {}, false), nativeId: "n", cwd: "/w" }, undefined, "q")).toThrow(/没有旁支对话/);
  });
});
