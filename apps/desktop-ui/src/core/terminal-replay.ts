import { STORAGE_KEYS, readLocal, saveLocal } from "./storage";

/** A recording contains the geometry before each chunk, including resize-only frames. */
export interface TerminalFrame {
  frame: number;
  cols: number;
  rows: number;
  data: string;
}

export interface TerminalReplayPage {
  frames: TerminalFrame[];
  nextFrame: number;
  done: boolean;
}

export interface TerminalReplayTarget {
  beginReplay(reset: boolean): Promise<void>;
  replay(data: string, cols: number, rows: number): Promise<void>;
  endReplay(): Promise<void>;
}

export interface ReplayTerminal {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
}

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MAX_WARM_TERMINALS = 4;

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function readTerminalFontSize(): number {
  return clampTerminalFontSize(readLocal<number>(STORAGE_KEYS.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE));
}

export function saveTerminalFontSize(size: number): number {
  const clamped = clampTerminalFontSize(size);
  saveLocal(STORAGE_KEYS.terminalFontSize, clamped);
  return clamped;
}

/** Updates an ordered warm terminal LRU list (`maxWarm = 4`), returning `{ next, evicted }`. */
export function touchTerminalLru(
  current: readonly string[],
  terminalId: string,
  maxWarm = MAX_WARM_TERMINALS,
): { next: string[]; evicted: string[] } {
  const filtered = current.filter((id) => id !== terminalId);
  filtered.push(terminalId);
  if (filtered.length <= maxWarm) {
    return { next: filtered, evicted: [] };
  }
  const split = filtered.length - maxWarm;
  return {
    next: filtered.slice(split),
    evicted: filtered.slice(0, split),
  };
}

export async function restoreTerminalState(
  target: TerminalReplayTarget,
  state: { length: number; cols: number; rows: number },
  load: (offset: number) => Promise<{ data: string; nextOffset: number; done: boolean }>,
  current: () => boolean = () => true,
): Promise<void> {
  await target.beginReplay(true);
  try {
    let offset = 0;
    while (offset < state.length) {
      if (!current()) throw new Error("终端恢复已取消");
      const page = await load(offset);
      if (!current()) throw new Error("终端恢复已取消");
      if (
        !page.data.length ||
        page.nextOffset !== offset + page.data.length ||
        page.nextOffset > state.length ||
        page.done !== (page.nextOffset === state.length)
      ) {
        throw new Error("终端恢复状态不完整");
      }
      await target.replay(page.data, state.cols, state.rows);
      offset = page.nextOffset;
    }
  } finally {
    await target.endReplay();
  }
}

export async function restoreTerminalRecording(
  target: TerminalReplayTarget,
  range: { afterFrame: number; throughFrame: number },
  load: (afterFrame: number, throughFrame: number) => Promise<TerminalReplayPage>,
  current: () => boolean = () => true,
): Promise<void> {
  await target.beginReplay(range.afterFrame === 0);
  try {
    let after = range.afterFrame;
    while (after < range.throughFrame) {
      if (!current()) throw new Error("终端恢复已取消");
      const page = await load(after, range.throughFrame);
      if (!current()) throw new Error("终端恢复已取消");
      if (
        page.nextFrame <= after ||
        page.nextFrame > range.throughFrame ||
        page.frames.length === 0
      ) {
        throw new Error("终端回放数据不完整");
      }
      let batch: { data: string; cols: number; rows: number } | undefined;
      for (const frame of page.frames) {
        if (frame.frame !== after + 1 || frame.cols < 1 || frame.rows < 1) {
          throw new Error("终端回放顺序无效");
        }
        if (batch && (batch.cols !== frame.cols || batch.rows !== frame.rows)) {
          await target.replay(batch.data, batch.cols, batch.rows);
          batch = undefined;
        }
        if (batch) batch.data += frame.data;
        else batch = { data: frame.data, cols: frame.cols, rows: frame.rows };
        after = frame.frame;
      }
      if (after !== page.nextFrame || page.done !== (after === range.throughFrame)) {
        throw new Error("终端回放范围不一致");
      }
      if (batch) await target.replay(batch.data, batch.cols, batch.rows);
    }
  } finally {
    await target.endReplay();
  }
}

export function writeTerminal(term: ReplayTerminal, data: string): Promise<void> {
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
): Promise<void> {
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
