import { describe, expect, it, vi } from "vitest";

vi.mock("../src/live/storage", () => ({ readLocal: () => "", saveLocal: () => {} }));
import { createTextDrafts, finishComposerSend } from "../src/live/composer-draft";

function storage() {
  const values = new Map<string, string>();
  return { read: (key: string) => values.get(key) ?? "", write: (key: string, text: string) => { values.set(key, text); } };
}

describe("submitted composer drafts", () => {
  it("keeps the persisted draft while delivery waits and after the host rejects it", async () => {
    const persisted = storage();
    const firstView = createTextDrafts(persisted).getState();
    firstView.update("computer/session", "send this");
    const submitted = firstView.read("computer/session");
    let finish!: (delivery: string) => void;
    const clear = vi.fn(() => firstView.clearSubmitted("computer/session", submitted));
    const sending = finishComposerSend(new Promise((resolve) => { finish = resolve; }), clear);
    // Reloading before an acknowledgement must still recover the only durable copy.
    expect(createTextDrafts(persisted).getState().read("computer/session")).toBe("send this");
    expect(clear).not.toHaveBeenCalled();
    finish("failed");
    await expect(sending).rejects.toThrow("输入和附件已保留");
    expect(clear).not.toHaveBeenCalled();
    expect(createTextDrafts(persisted).getState().read("computer/session")).toBe("send this");
  });

  it("does not clear text or attachments when delivery throws", async () => {
    const drafts = createTextDrafts(storage()).getState();
    drafts.update("computer/session", "send this");
    let attachments = ["photo.png"];
    const clear = vi.fn(() => {
      drafts.clearSubmitted("computer/session", "send this");
      attachments = [];
    });
    await expect(finishComposerSend(Promise.reject(new Error("disconnected")), clear)).rejects.toThrow("disconnected");
    expect(clear).not.toHaveBeenCalled();
    expect(drafts.read("computer/session")).toBe("send this");
    expect(attachments).toEqual(["photo.png"]);
  });

  it("persists a successful acknowledgement even after the original view closes", async () => {
    const persisted = storage();
    const firstView = createTextDrafts(persisted).getState();
    firstView.update("computer/session", "send this");
    const submitted = firstView.read("computer/session");
    await finishComposerSend(Promise.resolve("started"), () => firstView.clearSubmitted("computer/session", submitted));
    // The clearing callback does not need a mounted component or a React effect.
    expect(createTextDrafts(persisted).getState().read("computer/session")).toBe("");
  });

  it("preserves edits from a reopened composer when an earlier send succeeds", async () => {
    const persisted = storage();
    const drafts = createTextDrafts(persisted);
    const firstView = drafts.getState();
    firstView.update("computer/session", "send this");
    const submitted = firstView.read("computer/session");
    let finish!: (delivery: string) => void;
    const sending = finishComposerSend(new Promise((resolve) => { finish = resolve; }), () => firstView.clearSubmitted("computer/session", submitted));
    drafts.getState().update("computer/session", "next message");
    drafts.getState().update("another-computer/session", "other machine");
    finish("started");
    await sending;
    expect(drafts.getState().read("computer/session")).toBe("next message");
    expect(createTextDrafts(persisted).getState().read("computer/session")).toBe("next message");
    expect(drafts.getState().read("another-computer/session")).toBe("other machine");
  });
});
