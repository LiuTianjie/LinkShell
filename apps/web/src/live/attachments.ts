/**
 * How big one attachment may be. A file travels base64'd inside a JSON-RPC frame, and through a
 * gateway that frame is sealed and base64'd again, so 1 MB of file is about 1.8 MB on the wire.
 * The gateway closes a socket over 48 MB and the host one over 32 MB: 20 MB stays under both.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "20 MB";

/** Longest side a picture is sent at: enough to read a screenshot, far smaller than a photo. */
const MAX_IMAGE_SIDE = 2048;
/** Pictures smaller than this go as they are: re-encoding them only loses quality. */
const RECOMPRESS_ABOVE = 1.5 * 1024 * 1024;

/**
 * A picture made smaller to send: scaled to fit 2048 px and re-encoded (JPEG, or PNG/WebP when
 * it has transparency to keep). Anything that can't be decoded, an animated GIF, or a picture
 * already small enough comes back unchanged.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= RECOMPRESS_ABOVE) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    // JPEG has no transparency: a PNG or WebP keeps its format so a cut-out stays cut out.
    const type = file.type === "image/jpeg" || file.type === "image/jpg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}
