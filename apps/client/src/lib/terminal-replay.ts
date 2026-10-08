/** A recording contains the geometry before each chunk, including resize-only frames. */
export interface TerminalFrame { frame: number; cols: number; rows: number; data: string }
export interface TerminalReplayPage { frames: TerminalFrame[]; nextFrame: number; done: boolean }
export interface TerminalReplayTarget {
  beginReplay(reset: boolean): Promise<void>;
  replay(data: string, cols: number, rows: number): Promise<void>;
  endReplay(): Promise<void>;
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
      for (const frame of page.frames) {
        if (frame.frame !== after + 1 || frame.cols < 1 || frame.rows < 1) throw new Error("终端回放顺序无效");
        await target.replay(frame.data, frame.cols, frame.rows);
        after = frame.frame;
      }
      if (after !== page.nextFrame || page.done !== (after === range.throughFrame)) throw new Error("终端回放范围不一致");
    }
  } finally {
    // Native implementations drain their parser before unmuting writebacks.
    await target.endReplay();
  }
}
