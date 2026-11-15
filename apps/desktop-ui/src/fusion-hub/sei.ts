/**
 * Fusion's per-frame metadata rides in an H.264 SEI (user data unregistered) ahead of each
 * picture, as `FusionMetadata.swift` writes it: the UUID "LinkShellFusion1", then JSON.
 * Chromium hands encoded frames to an insertable stream in Annex B, which is where this reads it.
 */
const UUID = Array.from(new TextEncoder().encode("LinkShellFusion1"));

/** A window stream's: [lx,ly,lw,lh, nx,ny,nw,nh, ix,iy,iw,ih, scale, ack, id]. A popup layer's: [[id,layer,x,y,w,h], …]. */
export type FusionLayout = number[] | number[][];

export function fusionLayout(data: Uint8Array): FusionLayout | undefined {
  const bytes = data.length > 16_384 ? data.subarray(0, 16_384) : data;
  const starts: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n]!;
    if (start + 1 >= bytes.length) continue;
    let header: number;
    if (((bytes[start]! >> 1) & 63) === 39) header = 2; // HEVC prefix SEI
    else if ((bytes[start]! & 31) === 6) header = 1; // H.264 SEI
    else continue;
    let end = n + 1 < starts.length ? starts[n + 1]! - 3 : bytes.length;
    // A four-byte start code leaves one more zero before the next NAL.
    while (end > start && bytes[end - 1] === 0) end--;
    const rbsp: number[] = [];
    let zeros = 0;
    for (let i = start + header; i < end; i++) {
      const byte = bytes[i]!;
      if (zeros >= 2 && byte === 3) { zeros = 0; continue; }
      rbsp.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    if (rbsp[0] !== 5) continue;
    let cursor = 1, size = 0;
    while (cursor < rbsp.length && rbsp[cursor] === 255) { size += 255; cursor++; }
    if (cursor >= rbsp.length) continue;
    size += rbsp[cursor]!; cursor++;
    if (size < 16 || cursor + size > rbsp.length) continue;
    if (UUID.some((byte, i) => rbsp[cursor + i] !== byte)) continue;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(rbsp.slice(cursor + 16, cursor + size)))) as unknown;
      if (Array.isArray(parsed)) return parsed as FusionLayout;
    } catch {
      // Not ours after all.
    }
  }
  return undefined;
}

/** The SEI the Mac's encoder writes, for tests and for the Windows remote's frames. */
export function fusionSei(layout: FusionLayout): Uint8Array {
  const json = Array.from(new TextEncoder().encode(JSON.stringify(layout)));
  const payload = [...UUID, ...json];
  const rbsp: number[] = [5];
  let size = payload.length;
  while (size >= 255) { rbsp.push(255); size -= 255; }
  rbsp.push(size, ...payload, 0x80);
  const out: number[] = [0, 0, 0, 1, 6];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) { out.push(3); zeros = 0; }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** Where the decoded picture goes so the window's part of it fills the window (CSS pixels = points). */
export function windowPlacement(layout: number[]): { left: number; top: number; width: number; height: number } | undefined {
  if (layout.length < 12) return undefined;
  const [, , , , nx, ny, nw, nh, ix, iy, iw, ih] = layout as [number, number, number, number, number, number, number, number, number, number, number, number];
  if (!(nw > 0 && nh > 0 && iw > 0 && ih > 0)) return undefined;
  const width = iw / nw, height = ih / nh;
  return { left: ix - nx * width, top: iy - ny * height, width, height };
}

/** A popup cut from its display's layer: the layer drawn so the popup's frame lands at (0, 0). */
export function popupPlacement(frame: { x: number; y: number }, display: { x: number; y: number; w: number; h: number }) {
  return { left: display.x - frame.x, top: display.y - frame.y, width: display.w, height: display.h };
}
