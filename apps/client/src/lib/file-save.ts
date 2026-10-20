import { downloadAborted, downloadFile, downloadName, type DownloadOptions, type HostLink } from "@linkshell/client-core";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

export async function saveRemoteFile(link: Pick<HostLink, "call">, path: string, destination: "photos" | "files", options: DownloadOptions): Promise<"saved" | "shared"> {
  const check = () => { if (options.signal?.aborted) throw downloadAborted(); };
  if (destination === "photos") {
    const permission = await requestPermissionsAsync(true, []);
    if (!permission.granted) throw new Error("未获得保存到相册的权限。请在系统设置中允许，或选择保存到文件。");
  } else if (Platform.OS !== "android" && !(await Sharing.isAvailableAsync())) {
    throw new Error("这台设备暂不支持系统保存菜单。");
  }
  check();
  const selected = destination === "files" && Platform.OS === "android" ? await Directory.pickDirectoryAsync().catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_PICKER_CANCELLED") throw downloadAborted();
    throw error;
  }) : undefined;
  check();
  const directory = new Directory(Paths.cache, `file-download-${randomUUID()}`);
  directory.create();
  try {
    const file = new File(directory, downloadName(path));
    file.create();
    const handle = file.open();
    try {
      await downloadFile(link, path, (bytes) => handle.writeBytes(bytes), options);
    } finally { handle.close(); }
    check();
    if (destination === "photos") {
      await Asset.create(file.uri).catch(() => {
        throw new Error("无法保存到相册，请重试或选择“保存到文件”。此文件格式可能不受相册支持。");
      });
    } else if (selected) {
      // A failed or cancelled download never leaves a partial document in the selected folder.
      // SAF tree URIs must be passed as directories; appending a filename does not create a document URI.
      await file.copy(selected, { overwrite: false }).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ERR_DESTINATION_ALREADY_EXISTS") {
          throw new Error("所选文件夹中已存在同名文件，请选择其他保存位置。");
        }
        throw error;
      });
    } else {
      await Sharing.shareAsync(file.uri, { dialogTitle: "保存到文件" });
      return "shared";
    }
    return "saved";
  } finally {
    // A cache cleanup failure must not turn a completed system save into a retry.
    try { if (directory.exists) directory.delete(); } catch { /* The OS can evict this cache later. */ }
  }
}
