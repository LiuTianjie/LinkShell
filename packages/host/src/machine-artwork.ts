import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

// NSImageNameComputer is AppKit's icon for *this* Mac. No permission prompt, screen
// capture, asset catalog scraping, user files or vendor images shipped in the app.
const render = `ObjC.import('AppKit'); function run() {
  const image = $.NSImage.imageNamed($.NSImageNameComputer), size = 768;
  const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
  $.NSGraphicsContext.saveGraphicsState; $.NSGraphicsContext.setCurrentContext(context);
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return ObjC.unwrap(bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary).base64EncodedStringWithOptions(0));
}`;

async function load() {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", render], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
    const { default: sharp } = await import("sharp");
    const bytes = await sharp(Buffer.from(stdout.trim(), "base64"), { limitInputPixels: 768 * 768 })
      .trim().resize({ width: 720, height: 540, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    if (!bytes.length || bytes.length > 180_000) return undefined;
    return { id: createHash("sha256").update(bytes).digest("hex"), webp: bytes.toString("base64") };
  } catch { return undefined; } // Headless or restricted hosts still report the verified family.
}
let artwork: ReturnType<typeof load> | undefined;
export const readSystemArtwork = () => (artwork ??= load());
