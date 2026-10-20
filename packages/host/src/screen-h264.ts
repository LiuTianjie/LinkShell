/** Annex-B access units with a bounded carry buffer, including split start codes. */
export class H264AccessUnits {
  private bytes: Buffer = Buffer.alloc(0);
  private scanned = 0;
  private start = -1;

  push(chunk: Buffer, emit: (unit: Buffer, key: boolean) => void): void {
    if (this.bytes.length + chunk.length > 16 * 1024 * 1024) throw new Error("H.264 access unit is too large");
    this.bytes = this.bytes.length ? Buffer.concat([this.bytes, chunk]) : chunk;
    for (let i = this.scanned; i + 3 < this.bytes.length; i++) {
      if (this.bytes[i] || this.bytes[i + 1] || this.bytes[i + 2] !== 1 || (this.bytes[i + 3]! & 31) !== 9) continue;
      const at = i > 0 && this.bytes[i - 1] === 0 ? i - 1 : i;
      if (this.start >= 0 && at > this.start) {
        const unit = this.bytes.subarray(this.start, at);
        const nals = h264Nals(unit);
        // Some hardware encoders emit an AUD as well as the bitstream filter's AUD.
        // An empty delimiter is not a picture and must not consume a queue slot or timestamp.
        if (nals.some(nal => (nal[0]! & 31) !== 9)) emit(unit, nals.some(nal => (nal[0]! & 31) === 5));
      }
      this.start = at;
    }
    this.scanned = Math.max(0, this.bytes.length - 3);
    if (this.start > 0) {
      this.bytes = this.bytes.subarray(this.start);
      this.scanned -= this.start;
      this.start = 0;
    }
  }
}

export function h264Nals(unit: Buffer): Buffer[] {
  const nals: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 2 < unit.length; i++) {
    if (unit[i] || unit[i + 1] || unit[i + 2] !== 1) continue;
    let end = i;
    while (end > start && unit[end - 1] === 0) end--;
    if (start >= 0 && end > start) nals.push(unit.subarray(start, end));
    start = i + 3;
    i += 2;
  }
  if (start >= 0 && start < unit.length) nals.push(unit.subarray(start));
  return nals;
}

/** RFC 6184 packetization-mode=1. Leave room for RTP extensions, SRTP and UDP. */
export function h264Payloads(unit: Buffer, mtu = 1150): Buffer[] {
  if (mtu < 3) throw new Error("Invalid H.264 MTU");
  const payloads: Buffer[] = [];
  for (const nal of h264Nals(unit)) {
    const type = nal[0]! & 31;
    if (type === 9 || type === 12) continue;
    if (nal.length <= mtu) { payloads.push(nal); continue; }
    for (let offset = 1; offset < nal.length; offset += mtu - 2) {
      const end = Math.min(nal.length, offset + mtu - 2);
      payloads.push(Buffer.concat([
        Buffer.from([(nal[0]! & 0xe0) | 28, type | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0)]),
        nal.subarray(offset, end),
      ]));
    }
  }
  return payloads;
}

/** Reliable presses/releases must survive even if a newer lossy move arrived first. */
export class ScreenInputOrder {
  private newest = -1;
  accept(value: unknown, replaceable: boolean): boolean {
    if (!value || typeof value !== "object") return false;
    const event = value as { i?: unknown; t?: unknown };
    if (typeof event.i === "number" && Number.isSafeInteger(event.i) && event.i >= 0) {
      if (replaceable && event.t === "move" && event.i < this.newest) return false;
      this.newest = Math.max(this.newest, event.i);
    }
    return !replaceable || event.t === "move" || event.t === "scroll";
  }
}
