import { describe, expect, it } from "vitest";
import { restoreTerminalState, restoreTerminalRecording, type TerminalReplayTarget } from "../src/lib/terminal-replay";

function target() {
  const actions: unknown[] = [];
  const native: TerminalReplayTarget = {
    async beginReplay(reset) { actions.push(["begin", reset]); },
    async replay(data, cols, rows) { actions.push(["write", data, cols, rows]); },
    async endReplay() { actions.push(["drain-and-unmute"]); },
  };
  return { native, actions };
}

describe("terminal protocol recovery", () => {
  it("restores image payloads and keyboard modes at their original geometry across pages", async () => {
    const { native, actions } = target();
    const image = "\x1b_Ga=T,f=24,s=1,v=1;iVBOR\x1b\\";
    const frames = [
      { frame: 1, cols: 80, rows: 24, data: "\x1b[>31u" },
      { frame: 2, cols: 40, rows: 12, data: "" },
      { frame: 3, cols: 40, rows: 12, data: image },
    ];
    await restoreTerminalRecording(native, { afterFrame: 0, throughFrame: 3 }, async (after) => {
      const page = frames.slice(after, after + 2);
      return { frames: page, nextFrame: page.at(-1)!.frame, done: page.at(-1)!.frame === 3 };
    });
    expect(actions).toEqual([
      ["begin", true], ["write", "\x1b[>31u", 80, 24], ["write", "", 40, 12], ["write", image, 40, 12], ["drain-and-unmute"],
    ]);
  });
  it("preserves the existing screen when resuming a partially received recording", async () => {
    const { native, actions } = target();
    await restoreTerminalRecording(native, { afterFrame: 41, throughFrame: 42 }, async () => ({
      frames: [{ frame: 42, cols: 80, rows: 24, data: "tail" }], nextFrame: 42, done: true,
    }));
    expect(actions[0]).toEqual(["begin", false]);
  });
  it("drains and releases native replay mode when a page request fails", async () => {
    const { native, actions } = target();
    await expect(restoreTerminalRecording(native, { afterFrame: 0, throughFrame: 1 }, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(actions.at(-1)).toEqual(["drain-and-unmute"]);
  });
  it("rejects missing frames instead of displaying a silently corrupted terminal", async () => {
    const { native, actions } = target();
    await expect(restoreTerminalRecording(native, { afterFrame: 0, throughFrame: 2 }, async () => ({
      frames: [{ frame: 2, cols: 80, rows: 24, data: "wrong" }], nextFrame: 2, done: true,
    }))).rejects.toThrow("顺序");
    expect(actions).toEqual([["begin", true], ["drain-and-unmute"]]);
  });
  it("does not feed a late network response into a closed/replaced view", async () => {
    const { native, actions } = target();
    let current = true;
    await expect(restoreTerminalRecording(native, { afterFrame: 0, throughFrame: 1 }, async () => {
      current = false;
      return { frames: [{ frame: 1, cols: 80, rows: 24, data: "stale" }], nextFrame: 1, done: true };
    }, () => current)).rejects.toThrow("取消");
    expect(actions).toEqual([["begin", true], ["drain-and-unmute"]]);
  });
});

describe("terminal state recovery", () => {
  it("feeds one immutable state across chunks and drains before unmuting", async () => {
    const { native, actions } = target();
    await restoreTerminalState(native, { length: 4, cols: 80, rows: 24 }, async (offset) => ({ data: offset === 0 ? "ab" : "cd", nextOffset: offset + 2, done: offset === 2 }));
    expect(actions).toEqual([["begin", true], ["write", "ab", 80, 24], ["write", "cd", 80, 24], ["drain-and-unmute"]]);
  });
  it("rejects a truncated state and still releases replay mode", async () => {
    const { native, actions } = target();
    await expect(restoreTerminalState(native, { length: 4, cols: 80, rows: 24 }, async () => ({ data: "ab", nextOffset: 2, done: true }))).rejects.toThrow("不完整");
    expect(actions).toEqual([["begin", true], ["drain-and-unmute"]]);
  });
  it("discards responses after the view is replaced", async () => {
    const { native, actions } = target(); let current = true;
    await expect(restoreTerminalState(native, { length: 2, cols: 80, rows: 24 }, async () => {
      current = false; return { data: "ab", nextOffset: 2, done: true };
    }, () => current)).rejects.toThrow("取消");
    expect(actions).toEqual([["begin", true], ["drain-and-unmute"]]);
  });
  it("batches tiny journal writes but keeps geometry changes", async () => {
    const { native, actions } = target();
    await restoreTerminalRecording(native, { afterFrame: 0, throughFrame: 3 }, async () => ({
      frames: [{ frame: 1, cols: 80, rows: 24, data: "a" }, { frame: 2, cols: 80, rows: 24, data: "b" }, { frame: 3, cols: 40, rows: 12, data: "c" }], nextFrame: 3, done: true,
    }));
    expect(actions).toEqual([["begin", true], ["write", "ab", 80, 24], ["write", "c", 40, 12], ["drain-and-unmute"]]);
  });
});
