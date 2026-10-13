import {
  restoreTerminalRecording,
  restoreTerminalState,
  type TerminalReplayPage,
} from "../../../client/src/lib/terminal-replay";
export interface ReplayTerminal {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
}
export function writeTerminal(
  term: ReplayTerminal,
  data: string,
): Promise<void> {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => term.write(data, resolve));
}
export async function replayTerminal(
  term: ReplayTerminal,
  result: {
    reset: boolean;
    replay: string;
    terminal: { cols: number; rows: number };
    recording?: { afterFrame: number; throughFrame: number };
    state?: {
      snapshotId: string;
      length: number;
      frame: number;
      cols: number;
      rows: number;
    };
  },
  load: (after: number, through: number) => Promise<TerminalReplayPage>,
  current: () => boolean,
  options?: {
    loadState: (
      snapshotId: string,
      offset: number,
    ) => Promise<{ data: string; nextOffset: number; done: boolean }>;
    onProgress?: (completed: number, total: number) => void;
  },
) {
  if (!current()) throw new Error("终端恢复已取消");
  if (result.state) {
    if (!options) throw new Error("终端恢复状态不可用，请重试");
    const state = result.state;
    let completed = 0;
    options.onProgress?.(0, state.length);
    await restoreTerminalState(
      {
        beginReplay: async () => {
          term.reset();
          term.resize(state.cols, state.rows);
        },
        replay: async (data) => {
          if (!current()) throw new Error("终端恢复已取消");
          await writeTerminal(term, data);
          if (!current()) throw new Error("终端恢复已取消");
          completed += data.length;
          options.onProgress?.(completed, state.length);
        },
        endReplay: async () => {},
      },
      state,
      (offset) => options.loadState(state.snapshotId, offset),
      current,
    );
  } else if (result.recording) {
    await restoreTerminalRecording(
      {
        beginReplay: async (reset) => {
          if (reset) term.reset();
        },
        replay: async (data, cols, rows) => {
          if (!current()) throw new Error("终端恢复已取消");
          term.resize(cols, rows);
          await writeTerminal(term, data);
        },
        endReplay: async () => {},
      },
      result.recording,
      load,
      current,
    );
  } else {
    if (result.reset) term.reset();
    term.resize(result.terminal.cols, result.terminal.rows);
    await writeTerminal(term, result.replay);
  }
  if (!current()) throw new Error("终端恢复已取消");
}
