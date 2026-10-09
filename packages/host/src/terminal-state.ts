import { readFileSync } from "node:fs";
import { deflateSync, gunzipSync } from "node:zlib";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";

interface Core {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  create(cols: number, rows: number): number;
  destroy(handle: number): void;
  write(handle: number, pointer: number, length: number): void;
  resize(handle: number, cols: number, rows: number, cellWidth: number, cellHeight: number): number;
  snapshot(handle: number): number;
  plain(handle: number): number;
  output_len(handle: number): number;
  cursor_x(handle: number): number;
  cursor_y(handle: number): number;
  active_screen(handle: number): number;
  keyboard_flags(handle: number): number;
  image_count(handle: number): number;
  placement_count(handle: number): number;
  image_checksum(handle: number, id: number): number;
  image_position(handle: number, id: number, axis: number): number;
}
let compiled: WebAssembly.Module | undefined;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IMAGE_BYTES = 32 * 1024 * 1024;
export const TERMINAL_HISTORY_LINES = 1000;

/** Keep only an unfinished control sequence; completed history lives in Ghostty. */
class Continuation {
  pending = "";
  private mode: "ground" | "escape" | "csi" | "string" | "string-escape" = "ground";
  private osc = false;
  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      if (this.mode === "ground") {
        const next = data.indexOf("\x1b", i);
        if (next < 0) return;
        i = next; this.pending = "\x1b"; this.mode = "escape"; continue;
      }
      const ch = data[i]!;
      if (ch === "\x18" || ch === "\x1a") { this.pending = ""; this.mode = "ground"; continue; }
      if (ch === "\x1b" && this.mode !== "string" && this.mode !== "string-escape") { this.pending = "\x1b"; this.mode = "escape"; continue; }
      this.pending += ch;
      if (this.mode === "string-escape") {
        if (ch === "\\") { this.pending = ""; this.mode = "ground"; continue; }
        this.pending = `\x1b${ch}`; this.mode = "escape";
      }
      if (this.mode === "string") {
        if (ch === "\x1b") this.mode = "string-escape";
        else if (this.osc && ch === "\x07") { this.pending = ""; this.mode = "ground"; }
      } else if (this.mode === "escape") {
        if (ch === "[") this.mode = "csi";
        else if ("]P_^X".includes(ch)) { this.mode = "string"; this.osc = ch === "]"; }
        else if (ch >= "0" && ch <= "~") { this.pending = ""; this.mode = "ground"; }
        else if (ch === "\x1b") this.pending = "\x1b";
      } else if (this.mode === "csi" && ch >= "@" && ch <= "~") { this.pending = ""; this.mode = "ground"; }
    }
    if (this.pending.length > 64 * 1024 * 1024) throw new Error("未完成的终端控制序列过大");
  }
}

// Ghostty parses the same VT stream as the phone. The portable host core only
// mirrors state: it has no PTY, filesystem access, or terminal reply callback.
export class TerminalState {
  private readonly core: Core;
  private readonly handle: number;
  private readonly continuation = new Continuation();
  constructor(public cols: number, public rows: number) {
    compiled ??= new WebAssembly.Module(gunzipSync(readFileSync(new URL("./terminal-state.wasm.gz", import.meta.url))));
    let core: Core;
    const compressedImages = new Map<string, Buffer>();
    let compressedBytes = 0;
    const put = (bytes: Uint8Array) => {
      const pointer = core.allocate(bytes.length);
      if (!pointer) throw new Error("终端状态内存不足");
      new Uint8Array(core.memory.buffer).set(bytes, pointer);
      return pointer;
    };
    core = new WebAssembly.Instance(compiled, { env: {
      decode_png(data: number, length: number, out: number) {
        try {
          if (length > IMAGE_BYTES) return 0;
          const source = Buffer.from(new Uint8Array(core.memory.buffer, data, length));
          if (source.length < 24 || source.readUInt32BE(16) * source.readUInt32BE(20) * 4 > IMAGE_BYTES) return 0;
          const image = PNG.sync.read(source);
          const pointer = put(image.data);
          const view = new DataView(core.memory.buffer);
          view.setUint32(out, image.width, true); view.setUint32(out + 4, image.height, true);
          view.setUint32(out + 8, pointer, true); view.setUint32(out + 12, image.data.length, true);
          return 1;
        } catch { return 0; }
      },
      compress(data: number, length: number, outLength: number) {
        const pixels = new Uint8Array(core.memory.buffer, data, length);
        const key = createHash("sha256").update(pixels).digest("hex");
        let bytes = compressedImages.get(key);
        if (!bytes) {
          bytes = deflateSync(pixels);
          while (compressedBytes + bytes.length > IMAGE_BYTES && compressedImages.size) {
            const oldest = compressedImages.keys().next().value!;
            compressedBytes -= compressedImages.get(oldest)!.length; compressedImages.delete(oldest);
          }
          compressedImages.set(key, bytes); compressedBytes += bytes.length;
        }
        const pointer = put(bytes);
        new DataView(core.memory.buffer).setUint32(outLength, bytes.length, true);
        return pointer;
      },
    } }).exports as unknown as Core;
    this.core = core;
    this.handle = core.create(cols, rows);
    if (!this.handle) throw new Error("无法创建终端状态");
  }
  dispose(): void { this.core.destroy(this.handle); }
  write(data: string): void {
    if (!data) return;
    const bytes = encoder.encode(data), pointer = this.core.allocate(bytes.length);
    if (!pointer) throw new Error("终端状态内存不足");
    try {
      new Uint8Array(this.core.memory.buffer).set(bytes, pointer);
      this.core.write(this.handle, pointer, bytes.length);
      this.continuation.write(data);
    } finally { this.core.release(pointer, bytes.length); }
  }
  resize(cols: number, rows: number, cellWidth = 8, cellHeight = 16): void {
    if (!this.core.resize(this.handle, cols, rows, cellWidth, cellHeight)) throw new Error("无法调整终端状态大小");
    this.cols = cols; this.rows = rows;
  }
  private read(pointer: number): string {
    if (!pointer) throw new Error("无法导出终端状态");
    return decoder.decode(new Uint8Array(this.core.memory.buffer, pointer, this.core.output_len(this.handle)));
  }
  text(): string { return this.read(this.core.plain(this.handle)); }
  snapshot(): string { return this.read(this.core.snapshot(this.handle)) + this.continuation.pending; }
  inspect() {
    const c = this.core, h = this.handle;
    return { x: c.cursor_x(h), y: c.cursor_y(h), screen: c.active_screen(h), keyboard: c.keyboard_flags(h), images: c.image_count(h), placements: c.placement_count(h) };
  }
  imagePosition(id: number): number[] { return [this.core.image_position(this.handle,id,0), this.core.image_position(this.handle,id,1)]; }
  imageChecksum(id: number): number { return this.core.image_checksum(this.handle, id); }
}
