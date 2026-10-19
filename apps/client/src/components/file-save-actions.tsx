import { mediaKind, type DownloadProgress } from "@linkshell/client-core";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/fixed-text";
import { useConnection } from "@/lib/client";
import { saveRemoteFile } from "@/lib/file-save";
import { fileSize } from "@/lib/format";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function FileSaveActions({ path }: { path: string }) {
  const { link } = useConnection();
  const task = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<"photos" | "files" | null>(null);
  const [progress, setProgress] = useState<DownloadProgress>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const exporting = progress !== undefined && progress.received === progress.total;
  useEffect(() => {
    setBusy(null); setProgress(undefined); setMessage(""); setError("");
    return () => { task.current?.abort(); task.current = null; };
  }, [link, path]);
  async function save(destination: "photos" | "files") {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setBusy(destination); setProgress(undefined); setError(""); setMessage("");
    try {
      const result = await saveRemoteFile(link, path, destination, { signal: controller.signal, onProgress: setProgress });
      if (!controller.signal.aborted) setMessage(result === "shared" ? "可在系统菜单中选择“存储到文件”" : destination === "photos" ? "已保存到相册" : "已保存到所选文件夹");
    } catch (reason) {
      if (task.current !== controller) return;
      if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) setMessage("已取消保存");
      else setError(reason instanceof Error ? reason.message : "保存失败，请重试。");
    } finally {
      if (task.current === controller) { task.current = null; setBusy(null); }
    }
  }
  return <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {mediaKind(path) ? <Button title="保存到相册" icon={{ sf: "photo", md: "photo_library" }} size="small" busy={busy === "photos"} disabled={busy !== null} onPress={() => void save("photos")} /> : null}
      <Button title="保存到文件" icon={{ sf: "square.and.arrow.down", md: "file_download" }} size="small" busy={busy === "files"} disabled={busy !== null} onPress={() => void save("files")} />
      {busy && !exporting ? <Button title="取消" size="small" variant="plain" onPress={() => task.current?.abort()} /> : null}
    </View>
    {busy || message || error ? <Text accessibilityLiveRegion="polite" style={[type.caption, { color: error ? colors.danger : colors.secondaryLabel }]}>
      {error || (busy ? exporting ? "正在保存…" : progress ? `正在下载 ${fileSize(progress.received)} / ${fileSize(progress.total)}` : "正在准备保存…" : message)}
    </Text> : null}
  </View>;
}
