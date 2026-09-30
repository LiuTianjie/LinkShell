import type { HostLink } from "@linkshell/client-core";
import { Buffer } from "buffer";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

// Sending a file from the phone to the computer: pick it, then write it into
// a directory there (never over an existing file).

/** What `fs.upload` accepts in one call. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export interface Picked {
  uri: string;
  name: string;
  size?: number;
}

export async function pickPhoto(): Promise<Picked | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 1, exif: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const ext = asset.mimeType?.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return { uri: asset.uri, name: asset.fileName ?? `photo-${Date.now()}.${ext}`, size: asset.fileSize };
}

export async function pickFile(): Promise<Picked | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  return asset ? { uri: asset.uri, name: asset.name, size: asset.size } : null;
}

export class UploadTooLarge extends Error {}

/** Writes `file` into `dir` on the computer; resolves to where it landed. */
export async function upload(link: HostLink, file: Picked, dir: string): Promise<string> {
  const bytes = await new File(file.uri).arrayBuffer();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`${file.name} 超过 30 MB`);
  const data = Buffer.from(bytes).toString("base64");
  const result = await link.call("fs.upload", { dir, name: file.name, data }, 180_000);
  return result.path;
}

/** A path typed into a shell as one word. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}
