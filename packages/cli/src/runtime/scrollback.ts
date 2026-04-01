import type { Envelope } from "@linkshell/protocol";

export class ScrollbackBuffer {
  private buffer: Envelope[] = [];
  private readonly capacity: number;

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  push(envelope: Envelope): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(envelope);
  }

  replayFrom(seq: number): Envelope[] {
    return this.buffer.filter(
      (e) => e.seq !== undefined && e.seq > seq,
    );
  }

  trimUpTo(seq: number): void {
    const idx = this.buffer.findIndex(
      (e) => e.seq !== undefined && e.seq > seq,
    );
    if (idx > 0) {
      this.buffer.splice(0, idx);
    } else if (idx === -1) {
      this.buffer = [];
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  get lastSeq(): number {
    const last = this.buffer[this.buffer.length - 1];
    return last?.seq ?? -1;
  }
}
