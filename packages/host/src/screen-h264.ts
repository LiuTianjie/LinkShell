/**
 * H.264's name as the SDP carries it. werift's own default is "video/h264"; libwebrtc answers with
 * the offer's spelling and then looks its decoder up by that name, exactly: the Mac app's (and any
 * Objective-C receiver's) factory lists "H264", found nothing for "h264", and decoded no frame —
 * the picture never came, and the viewer fell back to the socket after its timeout.
 */
export const H264_MIME = "video/H264";

const MAX_UNIT_BYTES = 16 * 1024 * 1024;
const AVI_FRAME = Buffer.from("00dc");

/**
 * An encoder's H.264 as access units, from its pipe.
 *
 * Raw Annex-B says where a picture starts (its access unit delimiter) and not where it ends: a
 * picture was only known to be whole when the next one began, so every frame was handed on one
 * frame late, 16.7 ms at 60 a second. Asked to (`LINKSHELL_VIDEO_FRAMED`), the Windows helper has
 * FFmpeg write AVI instead: the same Annex-B bytes, each picture in a chunk that says its length
 * (`00dc`, four bytes little-endian, the bytes, a pad byte to an even length), written as it is
 * encoded. A picture is handed on the moment its last byte is read. Which of the two a stream is
 * shows in its first bytes (`RIFF`), so a helper that does not know the request still works.
 *
 * AVI was the muxer that fits: IVF and multipart refuse H.264, fragmented MP4 holds a frame
 * until the next to know its duration, FLV and Matroska want the parameter sets out of band,
 * which would change what the hardware encoders are asked for. Nothing else of the container is
 * read: the reader goes from chunk to chunk, and anywhere it does not find one (the headers at
 * the start) it looks for the next chunk that begins with a delimiter.
 */
export class H264AccessUnits {
  private bytes: Buffer = Buffer.alloc(0);
  private scanned = 0;
  private start = -1;
  private framed: boolean | undefined;

  push(chunk: Buffer, emit: (unit: Buffer, key: boolean) => void): void {
    if (this.bytes.length + chunk.length > MAX_UNIT_BYTES) throw new Error("H.264 access unit is too large");
    this.bytes = this.bytes.length ? Buffer.concat([this.bytes, chunk]) : chunk;
    if (this.framed === undefined) {
      if (this.bytes.length < 4) return;
      this.framed = this.bytes.subarray(0, 4).toString("latin1") === "RIFF";
    }
    if (this.framed) this.chunks(emit);
    else this.delimited(emit);
  }

  private chunks(emit: (unit: Buffer, key: boolean) => void): void {
    let at = 0;
    for (;;) {
      if (this.bytes.length - at < 8) break;
      if (this.bytes.compare(AVI_FRAME, 0, 4, at, at + 4) !== 0) {
        const next = this.nextChunk(at);
        if (next < 0) {
          // Nothing here is a picture: all of it may go but an end that could be a chunk's start.
          at = Math.max(at, this.bytes.length - 13);
          break;
        }
        at = next;
        continue;
      }
      const size = this.bytes.readUInt32LE(at + 4);
      // A stream whose time stood still has empty chunks for the frames there were none of.
      if (size === 0) { at += 8; continue; }
      if (size > MAX_UNIT_BYTES - 16) { at += 4; continue; }
      const end = at + 8 + size;
      if (this.bytes.length < end) break;
      const unit = this.bytes.subarray(at + 8, end);
      at = end + (size & 1);
      this.hand(unit, emit);
    }
    this.bytes = at >= this.bytes.length ? Buffer.alloc(0) : this.bytes.subarray(at);
  }

  /** The next `00dc` whose bytes begin as a picture does (a start code, then a delimiter). */
  private nextChunk(from: number): number {
    for (let i = this.bytes.indexOf(AVI_FRAME, from); i >= 0 && i + 13 <= this.bytes.length; i = this.bytes.indexOf(AVI_FRAME, i + 1)) {
      const b = this.bytes, d = i + 8;
      const long = b[d] === 0 && b[d + 1] === 0 && b[d + 2] === 0 && b[d + 3] === 1 && (b[d + 4]! & 31) === 9;
      const short = b[d] === 0 && b[d + 1] === 0 && b[d + 2] === 1 && (b[d + 3]! & 31) === 9;
      if (long || short) return i;
    }
    return -1;
  }

  private delimited(emit: (unit: Buffer, key: boolean) => void): void {
    for (let i = this.scanned; i + 3 < this.bytes.length; i++) {
      if (this.bytes[i] || this.bytes[i + 1] || this.bytes[i + 2] !== 1 || (this.bytes[i + 3]! & 31) !== 9) continue;
      const at = i > 0 && this.bytes[i - 1] === 0 ? i - 1 : i;
      if (this.start >= 0 && at > this.start) this.hand(this.bytes.subarray(this.start, at), emit);
      this.start = at;
    }
    this.scanned = Math.max(0, this.bytes.length - 3);
    if (this.start > 0) {
      this.bytes = this.bytes.subarray(this.start);
      this.scanned -= this.start;
      this.start = 0;
    }
  }

  private hand(unit: Buffer, emit: (unit: Buffer, key: boolean) => void): void {
    const nals = h264Nals(unit);
    // Some hardware encoders emit an AUD as well as the bitstream filter's AUD.
    // An empty delimiter is not a picture and must not consume a queue slot or timestamp.
    if (nals.some(nal => (nal[0]! & 31) !== 9)) emit(unit, nals.some(nal => (nal[0]! & 31) === 5));
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
