// The type an image really is, read from its first bytes. The picker re-encodes what it
// returns as base64 (always JPEG on iOS) but names it after the original file, so a PNG
// screenshot arrives as JPEG bytes labelled image/png, and an agent's model refuses it.

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The first `count` bytes of base64 data, without decoding the rest. */
function head(base64: string, count: number): number[] {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of base64) {
    const index = BASE64.indexOf(char);
    if (index < 0) continue;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
      if (bytes.length === count) break;
    }
  }
  return bytes;
}

/** The MIME type the bytes say, or undefined when they say nothing this knows. */
export function sniffImageType(base64: string): string | undefined {
  const b = head(base64, 12);
  if (b.length < 4) return undefined;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  const ascii = String.fromCharCode(...b);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.slice(4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii.slice(8, 12))) return "image/heic";
  return undefined;
}

/** The label to send with an image: what its bytes say, else what it was called. */
export function imageMimeType(base64: string, claimed: string | null | undefined): string {
  return sniffImageType(base64) ?? claimed ?? "image/jpeg";
}
