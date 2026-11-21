import { toBase64 } from "@linkshell/wire";
import type { Connection } from "../../core/connections";

export const SCREEN_UPLOAD_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const SCREEN_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export interface ScreenUploadProgress {
  index: number;
  total: number;
  fileName: string;
}

export interface ScreenUploadBatchResult {
  dir: string;
  uploadedPaths: string[];
  skippedNames: string[];
  failedErrors: string[];
}

export function joinRemoteUploadChild(
  baseDir: string,
  childName: string,
  platform?: string,
): string {
  const isWindows = platform === "win32" || platform === "windows" || /^[A-Za-z]:\\/.test(baseDir);
  const sep = isWindows ? "\\" : "/";
  const trimmed = baseDir.replace(/[\\/]+$/, "");
  if (!trimmed) return childName;
  return `${trimmed}${sep}${childName}`;
}

/**
 * Resolves the target directory for files dropped onto the remote screen:
 * prefers `<home>/Desktop`, falling back cleanly to `<home>/upload` or `<home>`.
 */
export async function resolveScreenUploadDir(
  connection: Pick<Connection, "link">,
  remoteHome?: string,
  remotePlatform?: string,
): Promise<string> {
  let home = remoteHome?.trim();
  if (!home) {
    const listed = await connection.link.call("fs.list", { path: "", files: false });
    home = listed?.path?.trim();
  }
  if (!home) {
    throw new Error("无法定位远端目标目录");
  }

  const desktopDir = joinRemoteUploadChild(home, "Desktop", remotePlatform);
  try {
    const desktopListed = await connection.link.call("fs.list", {
      path: desktopDir,
      files: false,
    });
    if (desktopListed?.path) return desktopListed.path;
    return desktopDir;
  } catch {
    // Desktop may not exist on headless hosts; fall back to `upload` or home.
  }

  const uploadDir = joinRemoteUploadChild(home, "upload", remotePlatform);
  try {
    const uploadListed = await connection.link.call("fs.list", {
      path: uploadDir,
      files: false,
    });
    if (uploadListed?.path) return uploadListed.path;
    return uploadDir;
  } catch {
    try {
      const created = await connection.link.call("fs.mkdir", {
        parent: home,
        name: "upload",
      });
      if (created?.path) return created.path;
    } catch {
      // Fall through to home directory if upload creation fails.
    }
  }
  return home;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
      } else {
        reject(new Error("无法读取文件内容"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取文件内容"));
    reader.readAsArrayBuffer(blob);
  });
}

export async function uploadDroppedFilesToScreen(options: {
  connection: Pick<Connection, "link">;
  files: readonly File[];
  remoteHome?: string;
  remotePlatform?: string;
  chunkBytes?: number;
  maxFileBytes?: number;
  onProgress?: (progress: ScreenUploadProgress) => void;
}): Promise<ScreenUploadBatchResult> {
  const {
    connection,
    files,
    remoteHome,
    remotePlatform,
    chunkBytes = SCREEN_UPLOAD_CHUNK_BYTES,
    maxFileBytes = SCREEN_UPLOAD_MAX_FILE_BYTES,
    onProgress,
  } = options;

  const dir = await resolveScreenUploadDir(connection, remoteHome, remotePlatform);
  const uploadedPaths: string[] = [];
  const skippedNames: string[] = [];
  const failedErrors: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    onProgress?.({ index: i + 1, total: files.length, fileName: file.name });

    if (file.size > maxFileBytes) {
      skippedNames.push(file.name);
      continue;
    }

    try {
      if (file.size === 0) {
        const res = await connection.link.call("fs.upload", {
          dir,
          name: file.name,
          data: "",
        });
        uploadedPaths.push(res.path);
        continue;
      }

      let offset = 0;
      let appendPath: string | undefined;
      while (offset < file.size) {
        const end = Math.min(file.size, offset + chunkBytes);
        const slice = file.slice(offset, end);
        const bytes = await readBlobBytes(slice);
        const data = toBase64(bytes);
        const res = await connection.link.call("fs.upload", {
          dir,
          name: file.name,
          data,
          ...(appendPath ? { appendPath, offset } : {}),
        });
        appendPath ??= res.path;
        offset = end;
      }
      if (appendPath) uploadedPaths.push(appendPath);
    } catch (err) {
      failedErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { dir, uploadedPaths, skippedNames, failedErrors };
}
