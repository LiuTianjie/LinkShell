import { mediaKind, type DownloadProgress } from "@linkshell/client-core";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/fixed-text";
import { useConnection } from "@/lib/client";
import { saveRemoteFile } from "@/lib/file-save";
import { fileSize } from "@/lib/format";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/**
 * Saving a remote file to the phone. The actions live in the file's ⋯ menu,
 * where a viewer keeps them; `strip` is only there while a save is running or
 * has something to say, so the file itself starts at the top of the page.
 */
export function useFileSave(path: string) {
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
  // A finished save says so for a moment, then gets out of the way.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);
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
  const media = !!mediaKind(path);
  const items = [
    ...(media ? [{ title: "保存到相册", icon: { sf: "photo", md: "photo_library" } as const, onPress: () => void save("photos") }] : []),
    { title: "保存到文件", icon: { sf: "square.and.arrow.down", md: "file_download" } as const, onPress: () => void save("files") },
  ];
  const strip = busy || message || error ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }}>
      {busy ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
      <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[type.footnote, { flex: 1, color: error ? colors.danger : colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
        {error || (busy ? exporting ? "正在保存…" : progress ? `正在下载 ${fileSize(progress.received)} / ${fileSize(progress.total)}` : "正在准备保存…" : message)}
      </Text>
      {busy && !exporting ? <Button title="取消" size="small" variant="plain" onPress={() => task.current?.abort()} /> : null}
    </View>
  ) : null;
  return { items, strip, save: () => void save("files"), busy: busy !== null };
}
