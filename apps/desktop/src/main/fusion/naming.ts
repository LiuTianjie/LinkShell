import { createHash } from "node:crypto";

/** Fusion's naming on the desktop, without Electron: unit tests load it under plain Node. */
/** A PNG inside an ICO: what Windows wants for a taskbar icon, without re-encoding. */
export function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // 256 wide
  header.writeUInt8(0, 7); // 256 high
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/** Per remote app: its own taskbar button and Alt-Tab entry, stable across runs. */
export function fusionAppId(slug: string, app: string): string {
  return `LinkShell.Fusion.${slug}.${createHash("sha256").update(app).digest("hex").slice(0, 12)}`;
}

/** The icon cache's file name for an app id; a bundle id comes out as the Mac hub writes it. */
export function fusionIconFile(app: string): string {
  return app.replaceAll("..", "_").replace(/[\\/:*?"<>|]/g, "_");
}
