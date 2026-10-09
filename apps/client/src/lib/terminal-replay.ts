/** A recording contains the geometry before each chunk, including resize-only frames. */
export interface TerminalFrame { frame: number; cols: number; rows: number; data: string }
export interface TerminalReplayPage { frames: TerminalFrame[]; nextFrame: number; done: boolean }
export interface TerminalReplayTarget {
  beginReplay(reset: boolean): Promise<void>;
  replay(data: string, cols: number, rows: number): Promise<void>;
  endReplay(): Promise<void>;
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
      if (!page.data.length || page.nextOffset !== offset + page.data.length || page.nextOffset > state.length || page.done !== (page.nextOffset === state.length)) {
        throw new Error("终端恢复状态不完整");
      }
      await target.replay(page.data, state.cols, state.rows);
      offset = page.nextOffset;
    }
  } finally { await target.endReplay(); }
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
      if (page.nextFrame <= after || page.nextFrame > range.throughFrame || page.frames.length === 0) throw new Error("终端回放数据不完整");
      let batch: { data: string; cols: number; rows: number } | undefined;
      for (const frame of page.frames) {
        if (frame.frame !== after + 1 || frame.cols < 1 || frame.rows < 1) throw new Error("终端回放顺序无效");
        // Keep resize boundaries, but drain the native parser once per batch
        // instead of crossing the JS/native bridge for every tiny PTY write.
        if (batch && (batch.cols !== frame.cols || batch.rows !== frame.rows)) {
          await target.replay(batch.data, batch.cols, batch.rows);
          batch = undefined;
        }
        if (batch) batch.data += frame.data;
        else batch = { data: frame.data, cols: frame.cols, rows: frame.rows };
        after = frame.frame;
      }
      if (after !== page.nextFrame || page.done !== (after === range.throughFrame)) throw new Error("终端回放范围不一致");
      if (batch) await target.replay(batch.data, batch.cols, batch.rows);
    }
  } finally {
    // Native implementations drain their parser before unmuting writebacks.
    await target.endReplay();
  }
}
