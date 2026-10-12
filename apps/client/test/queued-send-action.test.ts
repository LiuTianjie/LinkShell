import { describe, expect, it } from "vitest";
import type { AgentInfo } from "@linkshell/wire";
import { queuedSendAction } from "../src/lib/queued-send-action";

const agent = (tier: AgentInfo["tier"], steer: boolean) => ({ tier, capabilities: { interrupt: true, steer, permissions: true, images: false, fork: false, models: false, modes: false } });

describe("queued message actions describe their effect", () => {
  it("distinguishes an interrupted turn from input that can join the turn", () => {
    expect(queuedSendAction(agent("remote", false), true)).toMatchObject({ label: "中断发送", interrupts: true });
    expect(queuedSendAction(agent("multi_client", true), true)).toMatchObject({ label: "插话", interrupts: false });
  });
  it("does not promise steering into the desktop writer of a handoff session", () => {
    expect(queuedSendAction(agent("handoff", true), true, "desktop").interrupts).toBe(true);
    expect(queuedSendAction(agent("handoff", true), true, "remote").interrupts).toBe(false);
    expect(queuedSendAction(agent("multi_client", true), true, "desktop").interrupts).toBe(false);
  });
  it("does not claim to interrupt an idle session or steer an unknown agent", () => {
    expect(queuedSendAction(agent("remote", false), false)).toMatchObject({ label: "发送", interrupts: false });
    expect(queuedSendAction(undefined, true).label).toBe("立即发送");
  });
});
