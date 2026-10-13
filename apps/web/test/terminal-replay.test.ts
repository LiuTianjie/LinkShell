import { describe, expect, it } from "vitest";
import {
  replayTerminal,
  type ReplayTerminal,
} from "../src/live/terminal-replay";

function terminal() {
  const log: string[] = [];
  const term: ReplayTerminal = {
    reset: () => {
      log.push("reset");
    },
    resize: (cols, rows) => {
      log.push(`${cols}x${rows}`);
    },
    write: (data, callback) => {
      log.push(data);
      callback();
    },
  };
  return { term, log };
}
const result = {
  reset: true,
  replay: "legacy output",
  terminal: { cols: 80, rows: 24 },
  recording: { afterFrame: 0, throughFrame: 10000 },
  state: { snapshotId: "saved", length: 6, frame: 10000, cols: 100, rows: 30 },
};

describe("terminal snapshot restore", () => {
  it("uses the compact snapshot instead of replaying the complete journal", async () => {
    const { term, log } = terminal();
    const progress: [number, number][] = [];
    const offsets: number[] = [];
    await replayTerminal(
      term,
      result,
      async () => {
        throw new Error("should not read journal");
      },
      () => true,
      {
        loadState: async (snapshotId, offset) => {
          expect(snapshotId).toBe("saved");
          offsets.push(offset);
          return offset === 0
            ? { data: "abc", nextOffset: 3, done: false }
            : { data: "def", nextOffset: 6, done: true };
        },
        onProgress: (completed, total) => progress.push([completed, total]),
      },
    );
    expect(log).toEqual(["reset", "100x30", "abc", "def"]);
    expect(offsets).toEqual([0, 3]);
    expect(progress).toEqual([
      [0, 6],
      [3, 6],
      [6, 6],
    ]);
  });

  it("does not report completion or accept another chunk before the parser drains", async () => {
    const { term } = terminal();
    let drain: (() => void) | undefined;
    term.write = (_data, callback) => {
      drain = callback;
    };
    const progress: number[] = [];
    let finished = false;
    const task = replayTerminal(
      term,
      result,
      async () => {
        throw new Error("journal");
      },
      () => true,
      {
        loadState: async () => ({ data: "abcdef", nextOffset: 6, done: true }),
        onProgress: (completed) => progress.push(completed),
      },
    ).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress).toEqual([0]);
    expect(finished).toBe(false);
    drain!();
    await task;
    expect(progress).toEqual([0, 6]);
    expect(finished).toBe(true);
  });

  it("rejects corrupt state before writing it to the terminal", async () => {
    const { term, log } = terminal();
    await expect(
      replayTerminal(
        term,
        result,
        async () => {
          throw new Error("journal");
        },
        () => true,
        {
          loadState: async () => ({ data: "abc", nextOffset: 6, done: true }),
        },
      ),
    ).rejects.toThrow("终端恢复状态不完整");
    expect(log).toEqual(["reset", "100x30"]);
  });

  it("does not finish a restore after its connection generation is cancelled", async () => {
    const { term } = terminal();
    let current = true;
    term.write = (_data, callback) => {
      current = false;
      callback();
    };
    const progress: number[] = [];
    await expect(
      replayTerminal(
        term,
        result,
        async () => {
          throw new Error("journal");
        },
        () => current,
        {
          loadState: async () => ({
            data: "abcdef",
            nextOffset: 6,
            done: true,
          }),
          onProgress: (completed) => progress.push(completed),
        },
      ),
    ).rejects.toThrow("终端恢复已取消");
    expect(progress).toEqual([0]);
  });

  it("preserves compatibility with legacy text-only hosts", async () => {
    const { term, log } = terminal();
    await replayTerminal(
      term,
      { reset: true, replay: "old host", terminal: { cols: 40, rows: 10 } },
      async () => {
        throw new Error("journal");
      },
      () => true,
    );
    expect(log).toEqual(["reset", "40x10", "old host"]);
  });

  it("refuses to reset an existing screen for an already cancelled restore", async () => {
    const { term, log } = terminal();
    await expect(
      replayTerminal(
        term,
        result,
        async () => {
          throw new Error("journal");
        },
        () => false,
      ),
    ).rejects.toThrow("终端恢复已取消");
    expect(log).toEqual([]);
  });
});
