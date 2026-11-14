/**
 * Maximum single attachment size (20 MB) to stay safely below the Host's 32 MB and
 * Gateway's 48 MB encrypted/base64 frame ceilings. Direct `fs.upload` allows up to 30 MB.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_RPC_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "20 MB";

const MAX_IMAGE_SIDE = 2048;
const RECOMPRESS_ABOVE = 1.5 * 1024 * 1024;

export function validateAttachmentSize(file: { size: number; name: string }, maxBytes = MAX_ATTACHMENT_BYTES): void {
  if (file.size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`文件「${file.name}」超过 ${limitMb} MB 大小上限`);
  }
}

/**
 * Shrinks PNG/JPEG/WebP images so the longest side fits within 2048px while preserving
 * PNG/WebP alpha transparency. Leaves small or non-decodable images untouched.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type) || typeof createImageBitmap !== "function") {
    return file;
  }
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
    const type =
      file.type === "image/jpeg" || file.type === "image/jpg"
        ? "image/jpeg"
        : file.type === "image/webp"
          ? "image/webp"
          : "image/png";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
