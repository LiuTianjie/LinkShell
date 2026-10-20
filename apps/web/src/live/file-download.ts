import { downloadAborted, downloadFile, downloadName, type DownloadOptions, type HostLink } from "@linkshell/client-core";

interface DownloadWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
type SavePicker = (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<DownloadWriter> }>;

export async function saveRemoteFile(link: Pick<HostLink, "call">, path: string, options: DownloadOptions): Promise<"saved" | "downloaded"> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  const check = () => { if (options.signal?.aborted) throw downloadAborted(); };
  if (picker) {
    // Open while the click's user activation is still available.
    const destination = await picker.call(window, { suggestedName: downloadName(path) });
    check();
    const writer = await destination.createWritable();
    try {
      await downloadFile(link, path, (bytes) => writer.write(bytes), options);
      check();
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    return "saved";
  }
  const chunks: BlobPart[] = [];
  await downloadFile(link, path, (bytes) => { chunks.push(new Uint8Array(bytes)); }, { ...options, maxBytes: 256 * 1024 * 1024 });
  check();
  const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName(path);
  document.body.appendChild(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    // Give Safari time to take ownership of the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return "downloaded";
}
