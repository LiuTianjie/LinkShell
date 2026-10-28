import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import type { DownloadProgress } from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import { ErrorNotice, messageOf, useConnection } from "./common";
import { formatFileSize } from "./file-content";
import { saveRemoteFile } from "./file-download";

/** Saving a file from the computer: start, cancel, and what to say about it. */
export function useFileDownload(path: string) {
  const { link } = useConnection();
  const task = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setBusy(false); setProgress(undefined); setMessage(""); setError("");
    return () => { task.current?.abort(); task.current = null; };
  }, [link, path]);
  async function save() {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setBusy(true); setProgress(undefined); setError(""); setMessage("");
    try {
      const result = await saveRemoteFile(link, path, { signal: controller.signal, onProgress: setProgress });
      if (!controller.signal.aborted) setMessage(result === "saved" ? "已保存到本地" : "已交给浏览器下载");
    } catch (reason) {
      if (task.current !== controller) return;
      if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) setMessage("已取消下载");
      else setError(messageOf(reason));
    } finally {
      if (task.current === controller) { task.current = null; setBusy(false); }
    }
  }
  const status = busy && progress ? `${formatFileSize(progress.received)} / ${formatFileSize(progress.total)}` : busy ? "正在下载…" : message;
  return { save, cancel: () => task.current?.abort(), busy, status, error };
}

export function FileDownload({ path }: { path: string }) {
  const download = useFileDownload(path);
  return <div>
    <div className="resource-reader-tools">
      <Button variant="outline" size="sm" disabled={download.busy} onClick={() => void download.save()}>
        {download.busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
        {download.busy ? "正在下载…" : "下载文件"}
      </Button>
      {download.busy && <Button variant="ghost" size="sm" onClick={download.cancel}><X data-icon="inline-start" />取消</Button>}
      <span className="resource-caption" role="status">{download.busy ? download.status.replace("正在下载…", "") : download.status}</span>
    </div>
    <ErrorNotice error={download.error} />
  </div>;
}
