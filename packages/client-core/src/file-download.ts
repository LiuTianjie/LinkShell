import { fromBase64, RPC_METHOD_NOT_FOUND, RpcError } from "@linkshell/wire";
import type { HostLink } from "./host-link.js";

export interface DownloadProgress { received: number; total: number }
export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** A browser without a streaming file writer may need a memory limit. */
  maxBytes?: number;
}

export function downloadName(path: string): string {
  // eslint-disable-next-line no-control-regex -- Host names must not carry control characters into a local save dialog.
  return (path.split(/[\\/]/).pop() || "download").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+$|[. ]+$/g, "_");
}

export function mediaKind(path: string): "photo" | "video" | undefined {
  if (/\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i.test(path)) return "photo";
  if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(path)) return "video";
  return undefined;
}

export function downloadAborted(): Error {
  return Object.assign(new Error("已取消下载"), { name: "AbortError" });
}

function untilAborted<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(downloadAborted());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // The RPC can finish later; consume its result without retaining the UI or writer.
    void request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Await the writer before requesting more bytes; neither endpoint buffers a whole video. */
export async function downloadFile(
  link: Pick<HostLink, "call">,
  path: string,
  write: (bytes: Uint8Array) => void | Promise<void>,
  options: DownloadOptions = {},
): Promise<void> {
  let offset = 0;
  let revision: string | undefined;
  let size: number | undefined;
  const check = () => { if (options.signal?.aborted) throw downloadAborted(); };
  for (;;) {
    check();
    const part = await untilAborted(link.call("fs.download", { path, offset, maxBytes: 262_144, revision }, 30_000), options.signal).catch((error: unknown) => {
      if (error instanceof RpcError && error.code === RPC_METHOD_NOT_FOUND) throw new Error("这台电脑的 LinkShell 尚不支持下载，请先更新电脑端。");
      throw error;
    });
    check();
    if ((revision !== undefined && revision !== part.revision) || (size !== undefined && size !== part.size)) throw new Error("文件已变化，请重新下载。");
    if (options.maxBytes !== undefined && part.size > options.maxBytes) throw new Error("文件过大，请使用支持选择保存位置的浏览器（如 Chrome 或 Edge）下载。");
    const bytes = fromBase64(part.data);
    if (bytes.length > 262_144 || part.nextOffset !== offset + bytes.length || part.nextOffset > part.size ||
      part.done !== (part.nextOffset === part.size) || (!part.done && bytes.length === 0)) throw new Error("文件下载不完整，请重试。");
    revision = part.revision;
    size = part.size;
    await write(bytes);
    check();
    offset = part.nextOffset;
    options.onProgress?.({ received: offset, total: size });
    if (part.done) return;
  }
}
