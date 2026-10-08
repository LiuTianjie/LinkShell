import {
  restoreTerminalRecording,
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
  },
  load: (after: number, through: number) => Promise<TerminalReplayPage>,
  current: () => boolean,
) {
  if (result.recording) {
    await restoreTerminalRecording(
      {
        beginReplay: async (reset) => {
          if (reset) term.reset();
        },
        replay: async (data, cols, rows) => {
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
}
